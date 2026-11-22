// The REAL daemon through full swaps: the built Solana program inside tools/svm-rpc, the
// contract on a local anvil, and real XMR on the Monero regtest. Loopback only; no validator,
// no cluster, no live network. The taker side is played with the SDK, as a browser tab would.
//
// Run with `pnpm --filter @xmrswap/daemon test:integration` (it takes the shared lock
// /tmp/xmrswap-integration.lock: other packages use the same regtest ports).
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, sweepJoint } from '@xmrswap/core-wasm';
import { type Address, COUNTER, DEV_PROGRAM_ID, SWAP_STATE } from '@xmrswap/protocol';
import { privateKeyToAccount } from 'viem/accounts';
import {
  MakerHttp, buildNotice, decodeSignedQuote, directEndpoint, ethSessionBudget, ethereumCall, fetchPool, fetchProof, hex, hex0x, jointSpendKey, leafArgument, makerShareKeys, openNotice, pickLeaf, planEthereumOpen, planSolanaOpen,
  seedSigner, solanaInstruction, swapJointAddress, uploadOwnProof, verifyFundedShare, verifyLock, type SwapView,
} from '@xmrswap/sdk';
import { type EthWorld, startEthereum } from '../../../sdk/test/integration/eth.js';
import { type SolWorld, startSolana } from '../../../sdk/test/integration/sol.js';
import { Daemon } from '../../src/daemon.js';
import { Keystore } from '../../src/keystore/index.js';
import { WalletRpc } from '../../src/monero/wallet.js';
import type { PriceSourceClient } from '../../src/pricing/sources.js';
import { daemonEndpoint, serveEndpoint } from '../../src/tor/index.js';

const NODE_A = process.env['XMR_DAEMON_URL'] ?? 'http://127.0.0.1:48081';
const NODE_B = process.env['XMR_DAEMON_URL_B'] ?? 'http://127.0.0.1:48085';
const WALLET = process.env['XMR_WALLET_URL'] ?? 'http://127.0.0.1:48083';
for (const u of [NODE_A, NODE_B, WALLET]) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error(`integration endpoints are loopback only, not ${u}`);
const XMR = 1_000_000_000_000n;
/** Regtest fees are far above mainnet's; the production cap does not fit them. */
const REGTEST_MAX_FEE = 100_000_000_000n;
const fill = (n: number) => new Uint8Array(32).fill(n);
const takerSeed = fill(44);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Monero regtest helpers (own wallets; never the SDK suite's)
const wallet = new WalletRpc(WALLET);
async function nodeRpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(`${NODE_A}/json_rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }) });
  const r = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
const height = async (url: string): Promise<{ height: number; hash: string }> => {
  const r = (await (await fetch(`${url}/json_rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }) })).json()) as { result: { height: number; top_block_hash: string } };
  return { height: r.result.height, hash: r.result.top_block_hash };
};
let takerXmrAddress = '';
let makerXmrAddress = '';
/** Mine `n` blocks to an address and wait until node B follows. */
async function mine(n: number, to = takerXmrAddress): Promise<void> {
  for (let left = n; left > 0; left -= 50) await nodeRpc('generateblocks', { amount_of_blocks: Math.min(left, 50), wallet_address: to, starting_nonce: 0 });
  for (let i = 0; i < 600; i++) {
    const [a, b] = await Promise.all([height(NODE_A), height(NODE_B)]);
    if (a.height === b.height && a.hash === b.hash) return;
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
/** The taker pays from its OWN wallet: wallet-rpc holds one wallet at a time, and the daemon is not ticking meanwhile. */
async function takerPays(address: string, amount: bigint): Promise<string> {
  await openWallet('daemon-it-taker');
  try {
    const r = await wallet.call<{ tx_hash: string }>('transfer', { destinations: [{ address, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0 });
    return r.tx_hash;
  } finally {
    await openWallet('daemon-it-maker');
  }
}
const lockAt = (txid: string, joint: { viewPriv: Uint8Array; spendPub: Uint8Array }, xmr: bigint, depth: number) => verifyLock({ nodes: [NODE_A, NODE_B], txid, viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: xmr, minConf: depth });
const isMined = async (txid: string): Promise<boolean> => {
  const r = (await (await fetch(`${NODE_B}/get_transactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txs_hashes: [txid] }) })).json()) as { txs?: { in_pool: boolean }[] };
  return !!r.txs?.[0] && !r.txs[0].in_pool;
};

// ---------------------------------------------------------------- the world
let sol: SolWorld;
let eth: EthWorld;
let d: Daemon;
let endpoint: Awaited<ReturnType<typeof serveEndpoint>>;
let http: MakerHttp;
const prices = { xmr: 150, sol: 100, eth: 3000 };

/** Tick the daemon until a condition holds; `between` is what the rest of the world does meanwhile. */
async function drive(until: () => Promise<boolean>, between: () => Promise<void> = async () => {}, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (await until()) return;
    await d.tickOnce();
    if (await until()) return;
    await between();
  }
  throw new Error(`the daemon did not get there: ${JSON.stringify(d.store.swaps({ open: true }).map((s) => ({ ref: s.ref, phase: s.phase, err: s.last_error })))} alerts ${JSON.stringify(d.alerts.list(5).map((a) => a.message))}`);
}

beforeAll(async () => {
  await init();
  sol = await startSolana();
  eth = await startEthereum();
  // The daemon reads Ethereum at `finalized`; on a fresh anvil that tag is still before the deployment.
  await eth.finalize();
  makerXmrAddress = await openWallet('daemon-it-maker');
  takerXmrAddress = await openWallet('daemon-it-taker');
  // A few coinbase outputs for the maker's inventory, then a long chain to the taker: decoy selection needs about 720 blocks.
  await mine(12, makerXmrAddress);
  const h = (await height(NODE_A)).height;
  await mine(Math.max(100, 730 - h), takerXmrAddress);
  await openWallet('daemon-it-maker');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-daemon-it-'));
  const configPath = path.join(dir, 'maker.toml');
  writeFileSync(
    configPath,
    `
[daemon]
mode = "live"

[solana]
rpc_url_env = "IT_SOL"
program_id = "${DEV_PROGRAM_ID}"
expected_genesis = "${sol.genesis}"
maker_owner = "${sol.owner.publicKey}"
subscriptions = false

[ethereum]
rpc_url_env = "IT_ETH"
contract = "${eth.contract}"
chain_id = 31337
maker_owner = "${eth.owner.address.toLowerCase()}"

[monero]
network = "regtest"
node_url_envs = ["IT_XMR_A", "IT_XMR_B"]
wallet_rpc_url_env = "IT_XMR_WALLET"
sweep_max_fee = ${REGTEST_MAX_FEE}

[tor]
enabled = true
listen = "127.0.0.1:0"

[offers]
eth_pool_size = 4

[pricing]
max_age_seconds = 86400

[markets.sol.sell_xmr]
enabled = true
max_xmr = 5
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[markets.usdc_sol.buy_xmr]
enabled = true
max_xmr = 5
deposit_pct = 1
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[markets.eth.sell_xmr]
enabled = true
max_xmr = 5
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[markets.eth.buy_xmr]
enabled = true
max_xmr = 5
confirmation_depth = [{ above_xmr = 0, depth = 2 }]
`,
  );
  const env: Record<string, string> = { IT_SOL: sol.svm.url, IT_ETH: eth.url, IT_XMR_A: NODE_A, IT_XMR_B: NODE_B, IT_XMR_WALLET: WALLET };
  const source = (name: 'coingecko' | 'coinmarketcap'): PriceSourceClient => ({ name, fetch: async () => ({ ...prices }) });
  d = await Daemon.create({
    configPath, dataDir: dir, env: (n) => env[n], timers: false,
    // The operator keys the two test worlds registered; the first encryption key is the one in the Solana registry.
    keystore: new Keystore({ seed: fill(77), solanaOperator: fill(3), ethereumOperator: fill(12) }),
    initialEncSecret: makerShareKeys(fill(77), 'solana', new Uint8Array(16).fill(1)).encSecret,
    priceSources: { coingecko: source('coingecko'), coinmarketcap: source('coinmarketcap') },
    sweepMaxFee: REGTEST_MAX_FEE,
  });
  endpoint = await serveEndpoint(daemonEndpoint(d), '127.0.0.1:0');
  http = new MakerHttp(directEndpoint(`http://127.0.0.1:${endpoint.port}`));
  await d.start();
});
afterAll(async () => {
  await endpoint?.close();
  await d?.stop();
  await wallet.call('close_wallet').catch(() => undefined);
  await sol?.stop();
  await eth?.stop();
});

const pdaOf = (s: SwapView): string => d.sol!.refOf(s);

describe('the daemon at start', () => {
  it('checked its endpoints, bound its database, synced its inventory and published every market in one refresh', async () => {
    const status = await d.status();
    expect(status.mode).toBe('live');
    expect(status.maker).toEqual({ solana: sol.makerPda, ethereum: eth.owner.address.toLowerCase() });
    expect(status.chains.map((c) => [c.chain, c.connected, c.network_ok])).toEqual([['solana', true, true], ['ethereum', true, true]]);
    expect(status.monero.wallet_rpc_ok).toBe(true);
    expect(d.store.meta('bound_wallet')).toBe(makerXmrAddress);
    expect(d.inventory.capacity().outputs).toBeGreaterThanOrEqual(10);
    expect(d.alerts.list().filter((a) => a.level === 'critical')).toEqual([]);
    const sell = (await sol.client.getOffer(sol.makerPda, 0, 0))!;
    expect(sell).toMatchObject({ enabled: 1, prices: [1_530_000_000n, 0n, 0n], poolFilled: 0xffff });
    expect((await sol.client.getOffer(sol.makerPda, 1, 1))!.prices[0]).toBe(147_000_000n);
    // (The test chain's clock is fixed in 2027, so the clock-skew warning is expected here and nowhere else.)
    expect(d.alerts.list(20).filter((a) => a.level !== 'info' && a.kind !== 'clock_skew').map((a) => a.message)).toEqual([]);
    const board = (await sol.client.getEthBoard(sol.makerPda))!;
    expect(board.slots.map((s) => s.used)).toEqual([1, 1, 0, 0]);
    expect((await http.info()).maker).toBe(sol.makerPda);
  });
});

describe('Solana', () => {
  it('buy XMR with SOL (direction A): the daemon locks real XMR after its notice, claims on ready; the taker sweeps', async () => {
    await d.offers.tick(true);
    const maker = await sol.maker();
    const offer = (await sol.client.getOffer(sol.makerPda, 0, 0))!;
    const plan = planSolanaOpen({ program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker, seed: takerSeed, xmr: 2n * XMR, source: { offer }, rentExemptMinimum: sol.rent0 });
    await sol.send(plan.instructions, [sol.taker]);
    const session = seedSigner(plan.keys.sessionSecret);
    const payoutBefore = await sol.balance(sol.payout.publicKey);

    // The daemon: commitment check, lock built but not relayed, notice, and only then the XMR.
    await drive(async () => (await sol.swap(plan.swapPda))!.state === SWAP_STATE.NOTICED && d.store.lockTx(plan.swapPda)?.relayed_at != null);
    let s = (await sol.swap(plan.swapPda))!;
    const intents = d.store.intents({ swapRef: plan.swapPda }).map((i) => `${i.kind}${i.payload['call'] ? `:${String(i.payload['call'])}` : ''}:${i.status}`);
    expect(intents).toEqual(['xmr_prepare:confirmed', 'sol_tx:post_notice:confirmed', 'xmr_relay:confirmed']);

    // The taker decrypts the notice, recomputes the joint address and verifies the lock on both nodes.
    const opened = openNotice(s, plan.keys.encSecret)!;
    expect(hex(opened.txid)).toBe(d.store.lockTx(plan.swapPda)!.txid);
    const joint = swapJointAddress(s, opened.view, 'regtest');
    expect(joint.address).toBe(d.store.swap(plan.swapPda)!.joint_address);
    await mine(2);
    let lock = await lockAt(hex(opened.txid), joint, s.xmr, s.depth);
    for (let i = 0; i < 50 && lock.state !== 'confirmed'; i++) {
      await sleep(200);
      lock = await lockAt(hex(opened.txid), joint, s.xmr, s.depth);
    }
    expect(lock).toMatchObject({ ok: true, state: 'confirmed', amount: s.xmr });
    await sol.warpTo(s.tNotice + BigInt(s.depth * 60));
    await sol.send([solanaInstruction(sol.client.program, s, { operator: maker.operator, payout: maker.payout }, session.publicKey, { name: 'set_ready' })], [session]);

    // The daemon claims: its share is now in the account; the payout went to the payout address.
    await drive(async () => (await sol.swap(plan.swapPda))!.state === SWAP_STATE.DONE);
    s = (await sol.swap(plan.swapPda))!;
    expect(s.outcome).toBe(COUNTER.completed);
    expect((await sol.balance(sol.payout.publicKey)) > payoutBefore).toBe(true);
    await drive(async () => d.store.swap(plan.swapPda)!.terminal === 1);
    expect(d.store.swap(plan.swapPda)).toMatchObject({ phase: 'completed', needs_review: 0 });
    expect(d.store.fills()).toHaveLength(1);

    // The taker combines both shares and takes the XMR.
    await mine(10);
    lock = await lockAt(hex(opened.txid), joint, s.xmr, 10);
    const swept = await sweepJoint({ daemonUrl: NODE_A, network: 'regtest', spendKey: jointSpendKey(s, plan.keys.spend, 'taker'), viewKey: joint.viewPriv, lockHeight: lock.blockHeight!, lockTxid: opened.txid, outputIndex: BigInt(lock.outputIndex!), destination: takerXmrAddress, maxFee: REGTEST_MAX_FEE, publish: true });
    expect(swept).toMatchObject({ published: true, amount: s.xmr - swept.fee });
    await mine(1);
    expect(await isMined(swept.txid)).toBe(true);
  });

  it('sell XMR for USDC (direction B): the daemon funds, verifies the taker\'s XMR on both nodes, sets ready, and sweeps after the claim', async () => {
    await d.offers.tick(true);
    const maker = await sol.maker();
    const offer = (await sol.client.getOffer(sol.makerPda, 1, 1))!;
    const operatorUsdc = await sol.tokenBalance(sol.operator.publicKey);
    const plan = planSolanaOpen({ program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker, seed: takerSeed, xmr: 3n * XMR, source: { offer }, rentExemptMinimum: sol.rent0, slippageBps: 10 });
    await sol.send(plan.instructions, [sol.taker]);
    const session = seedSigner(plan.keys.sessionSecret);
    const wallets = { operator: maker.operator, payout: maker.payout };

    // The daemon funds from the operator balance with a fresh share.
    await drive(async () => (await sol.swap(plan.swapPda))!.state === SWAP_STATE.ACTIVE);
    let s = (await sol.swap(plan.swapPda))!;
    expect(await sol.tokenBalance(sol.operator.publicKey)).toBe(operatorUsdc - s.amount);
    expect(d.store.shareForSwap(plan.swapPda)).toMatchObject({ purpose: 'fund', spend_pub: hex(s.makerSpendPub) });

    // The taker pays real XMR from its own wallet and posts the notice with the session key.
    const joint = swapJointAddress(s, plan.keys.view, 'regtest');
    const paid = await takerPays(joint.address, s.xmr);
    await sol.send([solanaInstruction(sol.client.program, s, wallets, session.publicKey, { name: 'post_notice' }, { notice: buildNotice(s, plan.keys.encSecret, Uint8Array.from(Buffer.from(paid, 'hex')), plan.keys.view) })], [session]);
    // Unconfirmed: the daemon waits. It never sets ready on a lock that is not at depth on every node.
    await d.tickOnce();
    expect((await sol.swap(plan.swapPda))!.state).toBe(SWAP_STATE.NOTICED);
    expect(d.executor.lockReports.get(plan.swapPda)).toMatchObject({ ok: false });
    await mine(2);
    s = (await sol.swap(plan.swapPda))!;
    await sol.warpTo(s.tNotice + BigInt(s.depth * 60));
    await drive(async () => (await sol.swap(plan.swapPda))!.state === SWAP_STATE.READY, () => sleep(300));
    expect(d.executor.lockReports.get(plan.swapPda)).toMatchObject({ ok: true, state: 'confirmed' });

    // The taker claims with its share; the daemon sweeps the joint address into its inventory wallet.
    s = (await sol.swap(plan.swapPda))!;
    const takerUsdc = await sol.tokenBalance(sol.taker.publicKey);
    await sol.send([solanaInstruction(sol.client.program, s, wallets, session.publicKey, { name: 'claim' }, { secret: plan.keys.spend })], [session]);
    expect((await sol.tokenBalance(sol.taker.publicKey)) > takerUsdc).toBe(true);
    await mine(10);
    await drive(async () => d.store.swap(plan.swapPda)!.swept === 1, () => sleep(300));
    const row = d.store.swap(plan.swapPda)!;
    await mine(1);
    expect(await isMined(row.sweep_txid!)).toBe(true);
    await wallet.refresh();
    const got = await wallet.call<{ transfer?: { amount: number; address: string } }>('get_transfer_by_txid', { txid: row.sweep_txid });
    expect(BigInt(got.transfer!.amount) > s.xmr - REGTEST_MAX_FEE).toBe(true);
    // Nothing is owed and the XMR is home: the operator closes the account.
    await drive(async () => d.store.swap(plan.swapPda)!.terminal === 1);
    expect(await sol.swap(plan.swapPda)).toBeNull();
    expect(d.store.intents({ swapRef: plan.swapPda }).map((i) => `${i.kind}${i.payload['call'] ? `:${String(i.payload['call'])}` : ''}:${i.status}`)).toEqual(['sol_tx:fund:confirmed', 'sol_tx:set_ready:confirmed', 'xmr_sweep:confirmed', 'xmr_relay:confirmed', 'sol_tx:close_swap:confirmed']);
  });
});

describe('Ethereum', () => {
  const taker = () => eth.taker.address.toLowerCase() as Address;
  const BUDGET = ethSessionBudget(5_000_000_000n);
  /** The signed quote of a board slot, as any client reads it from the Solana board. */
  async function boardQuote(slot: number) {
    await d.offers.tick(true);
    const board = (await sol.client.getEthBoard(sol.makerPda))!;
    const s = board.slots[slot]!;
    expect(s.used).toBe(1);
    return decodeSignedQuote(Uint8Array.from([...s.quote, ...s.sig]));
  }
  const makerEnc = async () => {
    const m = await sol.maker();
    return { encKeyVersion: m.encKeyVersion, encKey: m.encKey };
  };
  const ethSwap = (id: Uint8Array) => eth.client.getSwap(id, 'latest');
  const sendAs = async (s: SwapView, signer: ReturnType<typeof privateKeyToAccount>, call: Parameters<typeof ethereumCall>[2], m: Parameters<typeof ethereumCall>[3] = {}) => eth.send(ethereumCall(eth.client.contract, s, call, m)!, signer, { secret: call.name === 'claim' });

  it('buy XMR with ETH (direction A): proof check, approve, and finality before the XMR and before the claim', async () => {
    const { quote, sig } = await boardQuote(0);
    // The taker: the pool hashes to the signed root, the leaf's proof verifies, its own proof is uploaded, then the lock.
    const pool = await fetchPool(http, quote.keyRoot);
    const leaf = await pickLeaf(pool, { isKeyUsed: (k) => eth.client.isKeyUsed(eth.owner.address.toLowerCase() as Address, k, 'latest') });
    const keysOf = (await import('@xmrswap/sdk')).takerSwapKeys;
    const swapNonce = (await import('@xmrswap/sdk')).newSwapNonce();
    const keys = keysOf(takerSeed, 'ethereum', swapNonce);
    await fetchProof(http, { spendPub: leaf.spendPub, keyAddr: leaf.key, keyAddr2: leaf.key2 }, [keys.spendPub]);
    await uploadOwnProof(http, keys.spend);
    const plan = planEthereumOpen({ contract: eth.client.contract, taker: taker(), quote, sig, maker: await makerEnc(), seed: takerSeed, swapNonce, xmr: 2n * XMR, leaf: leafArgument(pool, leaf), sessionBudget: BUDGET });
    await eth.send(plan.call, eth.taker);
    const id = hex0x(plan.swapId);
    const session = privateKeyToAccount(hex0x(plan.keys.sessionSecret));
    expect((await ethSwap(plan.swapId))!.state).toBe(SWAP_STATE.PENDING);

    // Mined is not final: the daemon does not see the lock yet.
    await d.tickOnce();
    expect(d.store.swap(id)).toBeUndefined();
    await eth.finalize();
    await drive(async () => (await ethSwap(plan.swapId))!.state === SWAP_STATE.ACTIVE);
    expect(d.store.swap(id)!.facts).toMatchObject({ takerProofOk: true, approval: { approve: true } });
    // The approval is mined, not final: no XMR lock exists yet.
    await d.tickOnce();
    expect(d.store.lockTx(id)).toBeUndefined();
    await eth.finalize();
    await drive(async () => (await ethSwap(plan.swapId))!.state === SWAP_STATE.NOTICED);
    expect(d.store.lockTx(id)).toMatchObject({ relayed_at: null });
    await d.tickOnce();
    expect(d.store.lockTx(id)!.relayed_at).toBeNull(); // the notice is not final: the XMR has not left
    await eth.finalize();
    await drive(async () => d.store.lockTx(id)?.relayed_at != null);

    // The taker verifies and sets ready with its session key.
    let s = (await ethSwap(plan.swapId))!;
    const opened = openNotice(s, plan.keys.encSecret)!;
    const joint = swapJointAddress(s, opened.view, 'regtest');
    await mine(2);
    let lock = await lockAt(hex(opened.txid), joint, s.xmr, s.depth);
    for (let i = 0; i < 50 && lock.state !== 'confirmed'; i++) {
      await sleep(200);
      lock = await lockAt(hex(opened.txid), joint, s.xmr, s.depth);
    }
    expect(lock.ok).toBe(true);
    await eth.advanceTo(s.tNotice + BigInt(s.depth * 60));
    await sendAs(s, session, { name: 'set_ready' });
    // Ready is mined, not final: no claim. After finality the daemon claims, and the payout address is paid.
    await d.tickOnce();
    expect((await ethSwap(plan.swapId))!.state).toBe(SWAP_STATE.READY);
    const payoutBefore = await eth.balance(eth.payout.address);
    await eth.finalize();
    await drive(async () => (await ethSwap(plan.swapId))!.state === SWAP_STATE.DONE);
    s = (await ethSwap(plan.swapId))!;
    expect(s.outcome).toBe(COUNTER.completed);
    expect((await eth.balance(eth.payout.address)) > payoutBefore).toBe(true);
    // The taker has both shares now.
    expect(jointSpendKey(s, plan.keys.spend, 'taker')).toHaveLength(32);
    await eth.finalize();
    await drive(async () => d.store.swap(id)!.terminal === 1);
    expect(d.store.swap(id)).toMatchObject({ phase: 'completed', needs_review: 0 });
    expect(d.store.intents({ swapRef: id }).filter((i) => i.kind === 'eth_tx').map((i) => `${String(i.payload['call'])}:${i.status}`)).toEqual(['approve:confirmed', 'post_notice:confirmed', 'claim:confirmed']);
  });

  it('sell XMR for ETH (direction B): the daemon serves its proof before it funds, sets ready at depth, and sweeps after the taker\'s claim', async () => {
    const { quote, sig } = await boardQuote(1);
    expect(quote.direction).toBe(1);
    const { takerSwapKeys, newSwapNonce } = await import('@xmrswap/sdk');
    const swapNonce = newSwapNonce();
    const keys = takerSwapKeys(takerSeed, 'ethereum', swapNonce);
    await uploadOwnProof(http, keys.spend);
    const plan = planEthereumOpen({ contract: eth.client.contract, taker: taker(), quote, sig, maker: await makerEnc(), seed: takerSeed, swapNonce, xmr: 2n * XMR, sessionBudget: BUDGET, slippageBps: 10 });
    await eth.send(plan.call, eth.taker);
    const id = hex0x(plan.swapId);
    const session = privateKeyToAccount(hex0x(plan.keys.sessionSecret));
    await eth.finalize();
    await drive(async () => (await ethSwap(plan.swapId))!.state === SWAP_STATE.ACTIVE);
    await eth.finalize();
    let s = (await eth.client.getSwap(plan.swapId, 'finalized'))!;
    // The maker's proof for the funded share is served and matches contract storage: only then is the address shown.
    const blob = await fetchProof(http, { spendPub: s.makerSpendPub, keyAddr: s.eth!.makerKey as Address, keyAddr2: s.eth!.makerKey2 as Address }, [keys.spendPub]);
    verifyFundedShare(blob, s);
    const joint = swapJointAddress(s, keys.view, 'regtest');
    const paid = await takerPays(joint.address, s.xmr);
    await sendAs(s, session, { name: 'post_notice' }, { notice: buildNotice(s, keys.encSecret, Uint8Array.from(Buffer.from(paid, 'hex')), keys.view) });
    await mine(2);
    await eth.finalize();
    s = (await ethSwap(plan.swapId))!;
    await eth.advanceTo(s.tNotice + BigInt(s.depth * 60));
    await eth.finalize();
    await drive(async () => (await ethSwap(plan.swapId))!.state === SWAP_STATE.READY, () => sleep(300));
    await eth.finalize();
    s = (await ethSwap(plan.swapId))!;
    const before = await eth.balance(eth.taker.address);
    await sendAs(s, session, { name: 'claim' }, { secret: keys.spend });
    expect((await eth.balance(eth.taker.address)) > before).toBe(true);
    await eth.finalize();
    await mine(10);
    await drive(async () => d.store.swap(id)!.swept === 1, () => sleep(300));
    await mine(1);
    expect(await isMined(d.store.swap(id)!.sweep_txid!)).toBe(true);
    await drive(async () => d.store.swap(id)!.terminal === 1);
    expect(d.store.intents({ swapRef: id }).filter((i) => i.kind === 'eth_tx').map((i) => `${String(i.payload['call'])}:${i.status}`)).toEqual(['fund:confirmed', 'set_ready:confirmed']);
    expect(d.alerts.list(100).filter((a) => a.level === 'critical')).toEqual([]);
  });
});
