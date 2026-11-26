// A maker configured with ONLY the wXMR pool as its price source: the real daemon reads the pool's
// two vault accounts from svm-rpc, publishes an offer priced from them on the real program, and
// completes a buy-XMR swap with real XMR on the regtest. No other price source exists in its file,
// and none is ever called. Loopback only.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { COUNTER, DEV_PROGRAM_ID, SWAP_STATE } from '@xmrswap/protocol';
import { ata, hex, makerShareKeys, openNotice, planSolanaOpen, seedSigner, solanaInstruction, swapJointAddress, verifyLock } from '@xmrswap/sdk';
import { type SolWorld, startSolana } from '../../../sdk/test/integration/sol.js';
import { loadConfig } from '../../src/config/load.js';
import { Daemon } from '../../src/daemon.js';
import { Keystore } from '../../src/keystore/index.js';
import { WalletRpc } from '../../src/monero/wallet.js';

const NODE_A = process.env['XMR_DAEMON_URL'] ?? 'http://127.0.0.1:48081';
const NODE_B = process.env['XMR_DAEMON_URL_B'] ?? 'http://127.0.0.1:48085';
const WALLET = process.env['XMR_WALLET_URL'] ?? 'http://127.0.0.1:48083';
for (const u of [NODE_A, NODE_B, WALLET]) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error('integration endpoints are loopback only, not ' + u);
const XMR = 1_000_000_000_000n;
const fill = (n: number) => new Uint8Array(32).fill(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wallet = new WalletRpc(WALLET);

async function node(url: string, method: string, params: unknown = {}): Promise<any> {
  const res = await fetch(url + '/json_rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }) });
  const r = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(method + ': ' + r.error.message);
  return r.result;
}
async function mine(n: number, to: string): Promise<void> {
  for (let left = n; left > 0; left -= 50) await node(NODE_A, 'generateblocks', { amount_of_blocks: Math.min(left, 50), wallet_address: to, starting_nonce: 0 });
  for (let i = 0; i < 600; i++) {
    const [a, b] = await Promise.all([node(NODE_A, 'get_info'), node(NODE_B, 'get_info')]);
    if (a.height === b.height && a.top_block_hash === b.top_block_hash) return;
    await sleep(100);
  }
  throw new Error('the regtest nodes did not converge');
}
const openWallet = async (name: string): Promise<string> => {
  await wallet.call('close_wallet').catch(() => undefined);
  await wallet.openOrCreate(name);
  await wallet.refresh();
  return wallet.address();
};

let sol: SolWorld;
let d: Daemon;
let takerXmr = '';
let clock = Math.floor(Date.now() / 1000);
const priceCalls: string[] = [];
const poolOwner = seedSigner(fill(0x77)).publicKey;
let vaults: { base: string; quote: string };

beforeAll(async () => {
  await init();
  sol = await startSolana();
  // Own wallets; a chain long enough for decoy selection; a few unlocked outputs for the maker.
  takerXmr = await openWallet('daemon-pool-taker');
  const makerXmr = await openWallet('daemon-pool-maker');
  await mine(12, makerXmr);
  const h = (await node(NODE_A, 'get_info')).height as number;
  await mine(Math.max(70, 730 - h), takerXmr);
  await openWallet('daemon-pool-maker');

  // The pool: two token accounts in svm-rpc. 2,000 wXMR (12 decimals) against 300,000 USDC = 150 USD per XMR, $600,000 of liquidity.
  const wxmr = await sol.svm.createMint(12, sol.admin.publicKey);
  await sol.svm.mintTo(wxmr, poolOwner, 2000n * 10n ** 12n);
  await sol.svm.mintTo(sol.usdc, poolOwner, 300_000n * 10n ** 6n);
  vaults = { base: ata(poolOwner, wxmr).toBase58(), quote: ata(poolOwner, sol.usdc).toBase58() };

  const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-daemon-pool-'));
  const configPath = path.join(dir, 'maker.toml');
  const toml = [
    '[daemon]', 'mode = "live"', '',
    '[solana]', 'rpc_url_env = "IT_SOL"', 'program_id = "' + DEV_PROGRAM_ID + '"', 'expected_genesis = "' + sol.genesis + '"', 'maker_owner = "' + sol.owner.publicKey + '"', 'subscriptions = false', '',
    '[monero]', 'network = "regtest"', 'node_url_envs = ["IT_XMR_A", "IT_XMR_B"]', 'wallet_rpc_url_env = "IT_XMR_WALLET"', 'sweep_max_fee = 100000000000', '',
    '[pricing]', 'cross_check = "none"', 'max_age_seconds = 60', '',
    '[pricing.sources.wxmr_pool]', 'token = "' + wxmr + '"', 'base_vault = "' + vaults.base + '"', 'quote_vault = "' + vaults.quote + '"', 'min_liquidity_usd = 250000', 'average_seconds = 60', '',
    '[guardrails]', 'volatility_pause = { move_pct = 3.0, window_seconds = 600 }', '',
    '[markets.usdc_sol.sell_xmr]', 'enabled = true', 'source = "wxmr_pool"', 'max_xmr = 5', 'confirmation_depth = [{ above_xmr = 0, depth = 2 }]', '',
  ].join('\n');
  // The file names one price source and nothing else.
  const checked = loadConfig(toml);
  expect(checked.validation.errors).toEqual([]);
  expect(checked.config!.offers.filter((o) => o.configured).map((o) => [o.source, o.fallbacks, o.crossCheck])).toEqual([['wxmr_pool', [], null]]);
  writeFileSync(configPath, toml);
  const env: Record<string, string> = { IT_SOL: sol.svm.url, IT_XMR_A: NODE_A, IT_XMR_B: NODE_B, IT_XMR_WALLET: WALLET };
  d = await Daemon.create({
    configPath, dataDir: dir, env: (n) => env[n], timers: false, now: () => clock,
    keystore: new Keystore({ seed: fill(77), solanaOperator: fill(3), ethereumOperator: fill(12) }),
    initialEncSecret: makerShareKeys(fill(77), 'solana', new Uint8Array(16).fill(1)).encSecret,
    priceHttp: { get: async (url) => (priceCalls.push(url), { status: 500, body: '' }) },
    sweepMaxFee: 100_000_000_000n,
  });
  await d.start();
});
afterAll(async () => {
  await d?.stop();
  await wallet.call('close_wallet').catch(() => undefined);
  await sol?.stop();
});

describe('a maker priced by the wXMR pool alone', () => {
  it('waits for its averaging window, then publishes an offer priced from the vault accounts; one off-market read does not move it', async () => {
    // Just started: one sample is not a price, so nothing is published yet.
    expect(await sol.client.getOffer(sol.makerPda, 1, 0)).toBeNull();
    expect(d.prices.sourceError('wxmr_pool')).toMatch(/averaging window is not filled yet/);
    for (let i = 0; i < 5; i++) {
      clock += 15;
      await d.offers.tick(true);
    }
    const offer = (await sol.client.getOffer(sol.makerPda, 1, 0))!;
    // 300,000 USDC ÷ 2,000 wXMR = 150 USD per XMR; × (1 + 2%) = 153 USDC.
    expect(offer).toMatchObject({ enabled: 1, prices: [153_000_000n, 0n, 0n] });
    expect(d.offers.latest().find((c) => c.offer.configured)!.ref).toMatchObject({ source: 'wxmr_pool', xmrUsd: 150, unit: 'usd' });

    // Someone pushes the pool 30% down for one read, then lets it go back: the published price does not move.
    await sol.svm.mintTo(await mintOfBase(), poolOwner, 857n * 10n ** 12n);
    clock += 15;
    await d.offers.tick(true);
    expect((await sol.client.getOffer(sol.makerPda, 1, 0))!).toMatchObject({ enabled: 1, prices: [153_000_000n, 0n, 0n] });
    expect(priceCalls).toEqual([]); // no other source was ever asked
  });

  it('completes a buy-XMR swap at that price', async () => {
    // (The pool stays where the attacker left it; the daemon keeps its accepted level while the move has not persisted.)
    clock += 15;
    await d.offers.tick(true);
    const maker = await sol.maker();
    const offer = (await sol.client.getOffer(sol.makerPda, 1, 0))!;
    expect(offer.prices[0]).toBe(153_000_000n);
    const plan = planSolanaOpen({ program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker, seed: fill(45), xmr: XMR, source: { offer }, rentExemptMinimum: sol.rent0 });
    const payoutBefore = await sol.tokenBalance(sol.payout.publicKey);
    await sol.send(plan.instructions, [sol.taker]);
    expect((await sol.swap(plan.swapPda))!.amount).toBe(153_000_000n);
    const session = seedSigner(plan.keys.sessionSecret);
    for (let i = 0; i < 20 && d.store.lockTx(plan.swapPda)?.relayed_at == null; i++) await d.executor.tick();
    let s = (await sol.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.NOTICED);
    const opened = openNotice(s, plan.keys.encSecret)!;
    const joint = swapJointAddress(s, opened.view, 'regtest');
    await mine(2, takerXmr);
    let lock = await verifyLock({ nodes: [NODE_A, NODE_B], txid: hex(opened.txid), viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: s.xmr, minConf: s.depth });
    for (let i = 0; i < 50 && lock.state !== 'confirmed'; i++) {
      await sleep(200);
      lock = await verifyLock({ nodes: [NODE_A, NODE_B], txid: hex(opened.txid), viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: s.xmr, minConf: s.depth });
    }
    expect(lock).toMatchObject({ ok: true, amount: XMR });
    await sol.warpTo(s.tNotice + BigInt(s.depth * 60));
    await sol.send([solanaInstruction(sol.client.program, s, { operator: maker.operator, payout: maker.payout }, session.publicKey, { name: 'set_ready' })], [session]);
    for (let i = 0; i < 20 && (await sol.swap(plan.swapPda))!.state !== SWAP_STATE.DONE; i++) await d.executor.tick();
    s = (await sol.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    // 153 USDC less the 0.05% protocol fee reached the maker's payout account.
    expect((await sol.tokenBalance(sol.payout.publicKey)) - payoutBefore).toBe(153_000_000n - 76_500n);
    expect(d.alerts.list(50).filter((a) => a.level === 'critical')).toEqual([]);
    expect(priceCalls).toEqual([]);
  });
});

/** The wXMR mint of the pool's base vault (bytes 0..32 of the token account). */
async function mintOfBase(): Promise<string> {
  const a = (await sol.transport.getAccount(vaults.base))!;
  const { PublicKey } = await import('@solana/web3.js');
  return new PublicKey(a.data.subarray(0, 32)).toBase58();
}
