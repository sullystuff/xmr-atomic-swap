// Amendment 1 with the REAL daemon: the built Solana program inside tools/svm-rpc, the contract
// on a local anvil, and real XMR on the Monero regtest. Loopback only; no validator, no cluster,
// no live network. The taker, the admin and the watcher service are played with the SDK.
//
// Scenarios: an offer sized to the cap headroom and a lock refused above the cap; open value
// freed by a settlement lets the next swap open; an offer with a freeze window of 0 refusing a
// lock that names a watcher; a taker-side freeze (the daemon waits, the taker refunds, the
// daemon recovers its XMR and applies the withhold policy); a frozen swap whose taker never
// returns (the daemon claims at T_ff); a sell-XMR swap handed to the maker's watcher, which
// pauses it while the daemon is down, and the daemon's refund afterwards.
//
// Run with `pnpm --filter @xmrswap/daemon test:integration` (the script takes the shared lock).
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, payAmount } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, COUNTER, DEV_PROGRAM_ID, ETH_NATIVE, SWAP_STATE } from '@xmrswap/protocol';
import {
  type HttpFetch, type SwapView, WATCH_ROUTES, buildNotice, deadlinesOf, decodeSignedQuote, hex, makerShareKeys, noticeKey, openNotice, openWatchRequest, planSolanaOpen, seedSigner, signWatchAck, solanaInstruction,
  swapJointAddress, verifyLock, verifyWatchAck, watchDeployment, watcherFacts, watcherStep,
} from '@xmrswap/sdk';
import { DEFAULT_ETH_CAPS, type EthWorld, startEthereum } from '../../../sdk/test/integration/eth.js';
import { DEFAULT_CAPS, type SolWorld, startSolana } from '../../../sdk/test/integration/sol.js';
import { Daemon } from '../../src/daemon.js';
import { Keystore } from '../../src/keystore/index.js';
import { WalletRpc } from '../../src/monero/wallet.js';
import type { PriceSourceClient } from '../../src/pricing/sources.js';

const NODE_A = process.env['XMR_DAEMON_URL'] ?? 'http://127.0.0.1:48081';
const NODE_B = process.env['XMR_DAEMON_URL_B'] ?? 'http://127.0.0.1:48085';
const WALLET = process.env['XMR_WALLET_URL'] ?? 'http://127.0.0.1:48083';
for (const u of [NODE_A, NODE_B, WALLET]) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error(`integration endpoints are loopback only, not ${u}`);
const XMR = 1_000_000_000_000n;
const REGTEST_MAX_FEE = 100_000_000_000n;
const WINDOW = 86_400;
const M = BigInt(CHAIN_CONSTS.solana.marginSecs);
const fill = (n: number) => new Uint8Array(32).fill(n);
/** The watcher key of the Solana test world (`seed(9)`). */
const WATCHER_SEED = fill(9);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let seedCounter = 0x50;
const freshSeed = () => fill(++seedCounter);

// ---------------------------------------------------------------- Monero regtest helpers (own wallets)
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
const isMined = async (txid: string): Promise<boolean> => {
  const r = (await (await fetch(`${NODE_B}/get_transactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txs_hashes: [txid] }) })).json()) as { txs?: { in_pool: boolean }[] };
  return !!r.txs?.[0] && !r.txs[0].in_pool;
};

// ---------------------------------------------------------------- the world
let sol: SolWorld;
let eth: EthWorld;
let d: Daemon;
let configPath = '';
const prices = { xmr: 150, sol: 100, eth: 3000 };

/** The watcher service, in process: the routes of SPEC 11.6 with the SDK's sealing and signatures, and one pass of `watcherStep`. */
const watcher = {
  keys: new Map<string, Uint8Array>(),
  posts: 0,
  fetch: (async (url, init) => {
    const reply = (status: number, j: unknown) => ({ status, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer });
    if (url.endsWith(WATCH_ROUTES.info)) return reply(200, { solana: sol.watcher.publicKey, ethereum: eth.watcher.address.toLowerCase(), max_swaps: 10, monero_nodes: 2 });
    if (url.endsWith(WATCH_ROUTES.swaps) && init.method === 'POST') {
      watcher.posts++;
      const body = JSON.parse(init.body as string) as { swap_ref: string };
      const pda = new PublicKey(Buffer.from(body.swap_ref, 'hex')).toBase58();
      // Accepted only if the swap exists at `finalized`, names this watcher, is not settled, and the request verifies
      // against the locker's encryption key recorded in that swap (wire format 2).
      const s = await sol.client.getSwap(pda, 'finalized');
      if (!s || s.watcherAddress !== sol.watcher.publicKey || s.state === SWAP_STATE.DONE) return reply(404, { error: 'no such swap names this watcher' });
      const req = openWatchRequest(body, { watcherSeed: WATCHER_SEED, swap: s, deployment: watchDeployment({ programId: DEV_PROGRAM_ID }), now: await sol.now() });
      watcher.keys.set(pda, req.noticeKey);
      const until = (s.tNoteDeadline === 0n ? s.tFinal : s.tNoteDeadline) + BigInt(s.dC);
      return reply(200, signWatchAck({ chain: req.chain, swapRef: req.swapRef, watchingUntil: until, watcherSeed: WATCHER_SEED }));
    }
    return reply(404, {});
  }) as HttpFetch,
  /** One pass over one swap with view data only; sends the freeze when the SDK's `watcherStep` says so. */
  async pass(pda: string): Promise<string> {
    const key = watcher.keys.get(pda);
    if (!key) throw new Error('the watcher was never given this swap');
    const swap = (await sol.client.getSwap(pda, 'finalized'))!;
    const base = { swap, now: await sol.now(), watcher: sol.watcher.publicKey };
    let step = watcherStep(base);
    if (step.do === 'need') step = watcherStep({ ...base, ...(await watcherFacts({ swap, noticeKey: key, nodes: [NODE_A, NODE_B], network: 'regtest' })) });
    if (step.do === 'call') {
      const maker = await sol.maker();
      await sol.send([solanaInstruction(sol.client.program, swap, { operator: maker.operator, payout: maker.payout }, sol.watcher.publicKey, step.call)], [sol.watcher]);
      return step.call.name;
    }
    return step.do;
  },
};

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
const errorCode = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    // The harness and this file may load the SDK as two module instances: go by the error's own code, not by its class.
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : `other: ${(e as Error).message}`;
  }
  return 'accepted';
};
const toml = (sellWindowHours: number): string => `
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
max_age_seconds = 864000

[markets.sol.sell_xmr]
enabled = true
max_xmr = 5
deposit_pct = 2
withhold_policy = "always"
freeze_window_hours = ${sellWindowHours}
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[markets.usdc_sol.buy_xmr]
enabled = true
max_xmr = 5
deposit_pct = 1
freeze_window_hours = 24
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[markets.eth.sell_xmr]
enabled = true
max_xmr = 5
freeze_window_hours = 24
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[watcher]
url = "http://watcher.test"
solana_key = "${sol.watcher.publicKey}"
retry_seconds = 0.01
`;

beforeAll(async () => {
  await init();
  sol = await startSolana();
  eth = await startEthereum();
  // The daemon reads Ethereum at `finalized`; on a fresh anvil that tag is still before the deployment.
  await eth.finalize();
  makerXmrAddress = await openWallet('daemon-a1-maker');
  takerXmrAddress = await openWallet('daemon-a1-taker');
  // Coinbase outputs for the maker's inventory, then a chain of at least 720 blocks: decoy selection for the sweeps needs it.
  await mine(14, makerXmrAddress);
  const h = (await height(NODE_A)).height;
  await mine(Math.max(100, 730 - h), takerXmrAddress);
  await openWallet('daemon-a1-maker');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-daemon-a1-'));
  configPath = path.join(dir, 'maker.toml');
  writeFileSync(configPath, toml(24));
  const env: Record<string, string> = { IT_SOL: sol.svm.url, IT_ETH: eth.url, IT_XMR_A: NODE_A, IT_XMR_B: NODE_B, IT_XMR_WALLET: WALLET };
  const source = (name: 'coingecko' | 'coinmarketcap'): PriceSourceClient => ({ name, fetch: async () => ({ ...prices }) });
  d = await Daemon.create({
    configPath, dataDir: dir, env: (n) => env[n], timers: false,
    keystore: new Keystore({ seed: fill(77), solanaOperator: fill(3), ethereumOperator: fill(12) }),
    initialEncSecret: makerShareKeys(fill(77), 'solana', new Uint8Array(16).fill(1)).encSecret,
    priceSources: { coingecko: source('coingecko'), coinmarketcap: source('coinmarketcap') },
    sweepMaxFee: REGTEST_MAX_FEE,
    watcherFetch: watcher.fetch,
  });
  await d.start();
  await d.offers.poolsReady();
  await d.offers.tick(true);
});
afterAll(async () => {
  await d?.stop();
  await wallet.call('close_wallet').catch(() => undefined);
  await sol?.stop();
  await eth?.stop();
});

const wallets = async () => {
  const m = await sol.maker();
  return { operator: m.operator, payout: m.payout };
};
/** The live sell-XMR offer for SOL, refreshed by the daemon. */
async function sellOffer() {
  await d.offers.tick(true);
  return (await sol.client.getOffer(sol.makerPda, 0, 0))!;
}
/** The taker locks SOL against the sell-XMR offer, reading the caps first as a client does. */
async function lockA(xmr: bigint, extra: { watcher?: string } = {}) {
  const offer = await sellOffer();
  const plan = planSolanaOpen({ program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker: await sol.maker(), seed: freshSeed(), xmr, source: { offer }, rentExemptMinimum: sol.rent0, caps: await sol.client.getCaps(0), ...extra });
  await sol.send(plan.instructions, [sol.taker]);
  return { plan, session: seedSigner(plan.keys.sessionSecret) };
}
type Opened = Awaited<ReturnType<typeof lockA>>;
/** The daemon builds the lock, posts the notice and relays the XMR; the lock is then mined to its depth. */
async function toNoticed(o: Opened): Promise<SwapView> {
  await drive(async () => (await sol.swap(o.plan.swapPda))!.state === SWAP_STATE.NOTICED && d.store.lockTx(o.plan.swapPda)?.relayed_at != null);
  await mine(2);
  return (await sol.swap(o.plan.swapPda))!;
}
/** The taker verifies the lock on both nodes and sets ready; the daemon claims. */
async function complete(o: Opened): Promise<void> {
  let s = await toNoticed(o);
  const opened = openNotice(s, o.plan.keys.encSecret)!;
  const joint = swapJointAddress(s, opened.view, 'regtest');
  let lock = await verifyLock({ nodes: [NODE_A, NODE_B], txid: hex(opened.txid), viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: s.xmr, minConf: s.depth });
  for (let i = 0; i < 50 && lock.state !== 'confirmed'; i++) {
    await sleep(200);
    lock = await verifyLock({ nodes: [NODE_A, NODE_B], txid: hex(opened.txid), viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: s.xmr, minConf: s.depth });
  }
  expect(lock).toMatchObject({ ok: true, state: 'confirmed' });
  const ready = s.tNotice + BigInt(s.depth * 60);
  if ((await sol.now()) < ready) await sol.warpTo(ready);
  s = (await sol.swap(o.plan.swapPda))!;
  await sol.send([solanaInstruction(sol.client.program, s, await wallets(), o.session.publicKey, { name: 'set_ready' })], [o.session]);
  await drive(async () => d.store.swap(o.plan.swapPda)!.terminal === 1);
  expect(d.store.swap(o.plan.swapPda)).toMatchObject({ phase: 'completed', needs_review: 0 });
}
const intentsOf = (ref: string): string[] => d.store.intents({ swapRef: ref }).map((i) => `${i.kind}${i.payload['call'] ? `:${String(i.payload['call'])}` : ''}:${i.status}`);

describe('the daemon under Amendment 1', () => {
  it('starts on a capped deployment, shows caps and headroom per market, and publishes the freeze window with its terms on both chains', async () => {
    const status = await d.status();
    expect(status.chains.map((c) => [c.chain, c.connected])).toEqual([['solana', true], ['ethereum', true]]);
    expect(status.caps).toEqual([
      { market: 'sol', caps: { on: true, max_swap: DEFAULT_CAPS.maxSwap[0].toString(), max_open: DEFAULT_CAPS.maxOpen[0].toString(), open_value: '0', headroom: DEFAULT_CAPS.maxOpen[0].toString(), frozen: false } },
      { market: 'usdc_sol', caps: { on: true, max_swap: DEFAULT_CAPS.maxSwap[1].toString(), max_open: DEFAULT_CAPS.maxOpen[1].toString(), open_value: '0', headroom: DEFAULT_CAPS.maxOpen[1].toString(), frozen: false } },
      { market: 'eth', caps: { on: true, max_swap: DEFAULT_ETH_CAPS.maxSwap.toString(), max_open: DEFAULT_ETH_CAPS.maxOpen.toString(), open_value: '0', headroom: DEFAULT_ETH_CAPS.maxOpen.toString(), frozen: false } },
      { market: 'usdc_eth', caps: { on: true, max_swap: DEFAULT_ETH_CAPS.maxSwap.toString(), max_open: DEFAULT_ETH_CAPS.maxOpen.toString(), open_value: '0', headroom: DEFAULT_ETH_CAPS.maxOpen.toString(), frozen: false } },
    ]);
    expect(status.program_build).toMatchObject({ program_id: DEV_PROGRAM_ID, on_chain_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await d.watcher.probe();
    expect((await d.status()).watcher).toMatchObject({ url: 'http://watcher.test', reachable: true, solana: sol.watcher.publicKey, watching: 0 });
    // Solana: W_z is a term of the offer (and of its hash). Ethereum: `freezeWindow` is signed into the quote.
    expect((await sol.client.getOffer(sol.makerPda, 0, 0))!).toMatchObject({ enabled: 1, wZ: WINDOW });
    expect((await sol.client.getOffer(sol.makerPda, 1, 1))!).toMatchObject({ enabled: 1, wZ: WINDOW });
    const slot = (await sol.client.getEthBoard(sol.makerPda))!.slots[0]!;
    expect(slot.used).toBe(1);
    const { quote } = decodeSignedQuote(Uint8Array.from([...slot.quote, ...slot.sig]));
    expect(quote).toMatchObject({ freezeWindow: WINDOW, maxXmr: 5n * XMR });
    // Ethereum caps: the quote's largest size follows `max_swap` at the quoted price.
    const two = payAmount(2n * XMR, quote.tierPrice[0], 'ethereum');
    await eth.setCaps(ETH_NATIVE, two, DEFAULT_ETH_CAPS.maxOpen);
    await d.offers.tick(true);
    const capped = (await sol.client.getEthBoard(sol.makerPda))!.slots[0]!;
    expect(decodeSignedQuote(Uint8Array.from([...capped.quote, ...capped.sig])).quote.maxXmr).toBe(2n * XMR);
    expect(d.offers.views().find((v) => v.market === 'eth' && v.direction === 'sell_xmr')).toMatchObject({ capacity_limit: 'max_swap', capacity_xmr: (2n * XMR).toString() });
    expect((await d.status()).caps.find((c) => c.market === 'eth')!.caps).toMatchObject({ max_swap: two.toString() });
    await eth.setCaps(ETH_NATIVE, DEFAULT_ETH_CAPS.maxSwap, DEFAULT_ETH_CAPS.maxOpen);
    expect(d.alerts.list().filter((a) => a.level === 'critical')).toEqual([]);
  });

  it('an offer with a freeze window of 0 refuses a lock that names a watcher; the window is a published term and follows the configuration', async () => {
    d.applyConfig(toml(0), 'api');
    const plain = await sellOffer();
    expect(plain.wZ).toBe(0);
    const maker = await sol.maker();
    const base = { program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker, seed: freshSeed(), xmr: XMR, rentExemptMinimum: sol.rent0 };
    // The client refuses before anything is signed, and the program refuses a lock that skips the check.
    expect(await errorCode(() => planSolanaOpen({ ...base, source: { offer: plain }, watcher: sol.watcher.publicKey }))).toMatch(/WatcherNotAllowed/);
    const forced = planSolanaOpen({ ...base, source: { offer: { ...plain, wZ: WINDOW } }, watcher: sol.watcher.publicKey });
    expect(await errorCode(sol.send(forced.instructions, [sol.taker]))).toBe('WatcherNotAllowed');
    expect(await sol.swap(forced.swapPda)).toBeNull();
    expect(await d.executor.scan()).toEqual([]);
    // Back to 24 hours: the terms are published again.
    d.applyConfig(toml(24), 'api');
    expect((await sellOffer()).wZ).toBe(WINDOW);
  });

  it('caps: the offer is sized to the headroom, a lock above the cap is refused by the chain, and open value freed by a settlement lets the next swap open', async () => {
    const price = (await sellOffer()).prices[0]!;
    const amount = (xmr: bigint) => payAmount(xmr, price, 'solana');
    // The offer stands at 5 XMR when the admin sets the beta's caps for SOL: one swap of at most 2 XMR's worth, 3 XMR's worth open at once.
    let offer = await sellOffer();
    expect(offer).toMatchObject({ enabled: 1, capacityXmr: 5n * XMR });
    await sol.setCaps({ maxSwap: [amount(2n * XMR), DEFAULT_CAPS.maxSwap[1]], maxOpen: [amount(3n * XMR), DEFAULT_CAPS.maxOpen[1]] });
    // Before the daemon's next refresh the board still shows 5 XMR. A 3 XMR lock is above the per-swap cap: the client
    // says "cap reached" with the caps it reads, and the program refuses a lock that skips the check. No swap exists.
    const maker = await sol.maker();
    const above = { program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker, seed: freshSeed(), xmr: 3n * XMR, source: { offer }, rentExemptMinimum: sol.rent0 };
    expect(await errorCode(async () => planSolanaOpen({ ...above, caps: await sol.client.getCaps(0) }))).toBe('SwapCapExceeded');
    expect(await errorCode(sol.send(planSolanaOpen(above).instructions, [sol.taker]))).toBe('SwapCapExceeded');
    expect((await sol.client.getCaps(0)).openValue).toBe(0n);
    expect(await d.executor.scan()).toEqual([]);
    // The daemon's refresh sizes the offer to the cap: 2 XMR, bounded by `max_swap`.
    offer = await sellOffer();
    expect(offer).toMatchObject({ enabled: 1, capacityXmr: 2n * XMR, maxXmr: 5n * XMR });
    expect(d.offers.views().find((v) => v.market === 'sol' && v.direction === 'sell_xmr')).toMatchObject({ capacity_limit: 'max_swap', cap_reached: null });

    const first = await lockA(2n * XMR);
    expect((await sol.client.getCaps(0)).openValue).toBe(amount(2n * XMR));

    // The next refresh sizes the offer to what is left: 1 XMR, bounded by the open value.
    offer = await sellOffer();
    expect(offer).toMatchObject({ enabled: 1, capacityXmr: XMR });
    expect(d.offers.views().find((v) => v.market === 'sol' && v.direction === 'sell_xmr')).toMatchObject({ capacity_limit: 'max_open', cap_reached: null });
    const second = await lockA(XMR);
    expect((await sol.client.getCaps(0)).openValue).toBe(amount(3n * XMR));
    // Nothing is left: the offer is withdrawn and the reason is the deployment's cap, not a limit of the maker's.
    offer = await sellOffer();
    expect(offer).toMatchObject({ enabled: 0, capacityXmr: 0n });
    const stopped = d.offers.latest().find((c) => c.offer.market === 'sol' && c.offer.direction === 'sell_xmr')!;
    expect(stopped).toMatchObject({ enabled: false, capReached: 'OpenCapExceeded' });
    expect(stopped.reason).toMatch(/^cap reached: 0 of \d+ base units of open value are left during the beta/);
    expect((await d.status()).caps.find((c) => c.market === 'sol')!.caps).toMatchObject({ open_value: amount(3n * XMR).toString(), headroom: '0' });
    expect(d.alerts.list(30).some((a) => a.kind === 'cap_reached' && a.level === 'warning')).toBe(true);

    // The first swap settles: its value leaves the open value, the offer returns, and the next swap opens.
    await complete(first);
    expect((await sol.client.getCaps(0)).openValue).toBe(amount(XMR));
    offer = await sellOffer();
    expect(offer).toMatchObject({ enabled: 1, capacityXmr: 2n * XMR });
    const third = await lockA(2n * XMR);
    expect((await sol.swap(third.plan.swapPda))!.state).toBe(SWAP_STATE.ACTIVE);
    expect((await sol.client.getCaps(0)).openValue).toBe(amount(3n * XMR));
    // Both run to their end; caps never touched a swap that was open (invariant 3).
    await sol.setCaps({ maxSwap: [0n, 0n], maxOpen: [0n, 0n] });
    await complete(second);
    await complete(third);
    expect((await sol.client.getCaps(0)).openValue).toBe(0n);
    expect(d.store.fills()).toHaveLength(3);
    await sol.setCaps({ maxSwap: [...DEFAULT_CAPS.maxSwap], maxOpen: [...DEFAULT_CAPS.maxOpen] });
    expect((await sellOffer()).enabled).toBe(1);
    expect(d.alerts.list(50).filter((a) => a.level === 'critical')).toEqual([]);
  });

  it('a taker-side freeze: the daemon waits past the old claim-open time, the taker refunds, the daemon recovers its XMR and applies the withhold policy', async () => {
    const o = await lockA(2n * XMR, { watcher: sol.watcher.publicKey });
    let s = await toNoticed(o);
    expect(s).toMatchObject({ watcherAddress: sol.watcher.publicKey, wZ: WINDOW });
    // The watcher the taker named pauses the swap. It reveals nothing and moves nothing.
    await sol.send([solanaInstruction(sol.client.program, s, await wallets(), sol.watcher.publicKey, { name: 'freeze' })], [sol.watcher]);
    s = (await sol.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const tFf = deadlinesOf('solana', s).tFf!;
    expect(tFf).toBe(s.tFreeze + BigInt(WINDOW) > s.tClaimOpen ? s.tFreeze + BigInt(WINDOW) : s.tClaimOpen);
    await d.tickOnce();
    expect(d.store.freeze(o.plan.swapPda)).toMatchObject({ direction: 0, frozen_by: 'taker_side', watcher: sol.watcher.publicKey, t_freeze: Number(s.tFreeze), t_ff: Number(tFf) });
    // Past the time the claim would have opened without the pause: the daemon claims nothing.
    await sol.warpTo(s.tClaimOpen + 120n);
    await d.tickOnce();
    await d.tickOnce();
    expect((await sol.swap(o.plan.swapPda))!.state).toBe(SWAP_STATE.FROZEN);
    expect(intentsOf(o.plan.swapPda)).toEqual(['xmr_prepare:confirmed', 'sol_tx:post_notice:confirmed', 'xmr_relay:confirmed']);
    // The taker comes back and refunds with its share (Z3): the deposit is held.
    await sol.send([solanaInstruction(sol.client.program, s, await wallets(), o.session.publicKey, { name: 'refund' }, { secret: o.plan.keys.spend })], [o.session]);
    expect((await sol.swap(o.plan.swapPda))!.state).toBe(SWAP_STATE.HOLD);
    // The daemon: withholds by policy with the opening of its notice, and sweeps its XMR back with both shares.
    await mine(10);
    await drive(async () => d.store.swap(o.plan.swapPda)!.swept === 1 && (await sol.swap(o.plan.swapPda))!.state === SWAP_STATE.WITHHELD, () => sleep(300));
    const row = d.store.swap(o.plan.swapPda)!;
    await mine(1);
    expect(await isMined(row.sweep_txid!)).toBe(true);
    await wallet.refresh();
    const got = await wallet.call<{ transfer?: { amount: number } }>('get_transfer_by_txid', { txid: row.sweep_txid });
    expect(BigInt(got.transfer!.amount) > s.xmr - REGTEST_MAX_FEE).toBe(true);
    expect(intentsOf(o.plan.swapPda)).toEqual(expect.arrayContaining(['sol_tx:withhold:confirmed', 'xmr_sweep:confirmed']));
    expect(intentsOf(o.plan.swapPda).filter((i) => i.startsWith('sol_tx:claim'))).toEqual([]);
    expect((await sol.maker()).counters[COUNTER.refunds_after_freeze]).toBe(1);
    expect((await sol.maker()).counters[COUNTER.withholds]).toBe(1);
  });

  it('a frozen swap whose taker never returns: the daemon claims at T_ff, not before', async () => {
    const payoutBefore = await sol.balance(sol.payout.publicKey);
    const o = await lockA(2n * XMR, { watcher: sol.watcher.publicKey });
    let s = await toNoticed(o);
    // The locker itself may freeze: here the taker's session key does.
    await sol.send([solanaInstruction(sol.client.program, s, await wallets(), o.session.publicKey, { name: 'freeze' })], [o.session]);
    s = (await sol.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const tFf = deadlinesOf('solana', s).tFf!;
    await sol.warpTo(tFf - 30n);
    await d.tickOnce();
    await d.tickOnce();
    expect((await sol.swap(o.plan.swapPda))!.state).toBe(SWAP_STATE.FROZEN);
    expect(intentsOf(o.plan.swapPda).filter((i) => i.startsWith('sol_tx:claim'))).toEqual([]);
    await sol.warpTo(tFf);
    await drive(async () => ((await sol.swap(o.plan.swapPda))?.state ?? SWAP_STATE.DONE) === SWAP_STATE.DONE);
    const claim = d.store.intents({ swapRef: o.plan.swapPda }).find((i) => i.payload['call'] === 'claim')!;
    expect(claim).toMatchObject({ status: 'confirmed', payload: expect.objectContaining({ row: 'Z4', state: SWAP_STATE.FROZEN }) });
    expect((await sol.maker()).counters[COUNTER.claims_after_freeze]).toBe(1);
    expect((await sol.balance(sol.payout.publicKey)) > payoutBefore).toBe(true);
    await drive(async () => d.store.swap(o.plan.swapPda)!.terminal === 1);
    expect(d.store.swap(o.plan.swapPda)).toMatchObject({ phase: 'completed' });
    expect(d.store.freezes().map((f) => f.frozen_by)).toEqual(['taker_side', 'taker_side']);
  });

  it('sell XMR with the maker watcher: named at fund and acknowledged; it pauses a false notice while the daemon is down, and the daemon refunds afterwards', async () => {
    await d.offers.tick(true);
    const maker = await sol.maker();
    const offer = (await sol.client.getOffer(sol.makerPda, 1, 1))!;
    expect(offer).toMatchObject({ enabled: 1, wZ: WINDOW });
    const takerUsdc = await sol.tokenBalance(sol.taker.publicKey);
    const operatorUsdc = await sol.tokenBalance(sol.operator.publicKey);
    const plan = planSolanaOpen({ program: sol.client.program, taker: sol.taker.publicKey, makerPda: sol.makerPda, maker, seed: freshSeed(), xmr: 3n * XMR, source: { offer }, rentExemptMinimum: sol.rent0, slippageBps: 10, caps: await sol.client.getCaps(1) });
    await sol.send(plan.instructions, [sol.taker]);
    const session = seedSigner(plan.keys.sessionSecret);
    const pda = plan.swapPda;

    // The daemon funds and names its watcher; once the fund is final it hands the swap over and keeps the signed acknowledgement.
    await drive(async () => d.store.watchAck(pda) !== undefined);
    let s = (await sol.swap(pda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcherAddress: sol.watcher.publicKey, wZ: WINDOW });
    expect(await sol.tokenBalance(sol.operator.publicKey)).toBe(operatorUsdc - s.amount);
    expect(await sol.tokenBalance(sol.taker.publicKey)).toBe(takerUsdc - s.deposit);
    const ack = d.store.watchAck(pda)!;
    expect(verifyWatchAck({ swap_ref: hex(s.swapRef), watching_until: ack.watching_until, sig: ack.sig }, { chain: 'solana', swapRef: s.swapRef, watcherSolanaKey: sol.watcher.publicKey })).toBe(true);
    expect(BigInt(ack.watching_until)).toBe(s.tNoteDeadline + BigInt(s.dC));
    // The watcher holds this swap's notice key, sealed to it by the daemon, and nothing else.
    expect(hex(watcher.keys.get(pda)!)).toBe(hex(noticeKey(s, makerShareKeys(fill(77), 'solana', new Uint8Array(16).fill(1)).encSecret)));
    expect(intentsOf(pda)).toEqual(['sol_tx:fund:confirmed', 'watch_register:watch_register:confirmed']);
    expect((await d.status()).watcher).toMatchObject({ watching: 1 });

    // The taker posts a notice for XMR that was never sent. The daemon is DOWN from here on: nothing ticks it.
    const ghost = fill(0xab);
    await sol.send([solanaInstruction(sol.client.program, s, await wallets(), session.publicKey, { name: 'post_notice' }, { notice: buildNotice(s, plan.keys.encSecret, ghost, plan.keys.view) })], [session]);
    s = (await sol.swap(pda))!;
    expect(s.state).toBe(SWAP_STATE.NOTICED);
    // Before the cutoff the watcher waits (the notice opens; the lock may still arrive); at the cutoff it pauses the swap.
    expect(await watcher.pass(pda)).toBe('wait');
    await sol.warpTo(s.tCut);
    expect(await watcher.pass(pda)).toBe('freeze');
    s = (await sol.swap(pda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const tFf = deadlinesOf('solana', s).tFf!;
    // The claim-open time passes with the daemon still down. Without the pause the escrow would be the taker's now.
    await sol.warpTo(s.tClaimOpen + 600n);
    expect(await errorCode(sol.send([solanaInstruction(sol.client.program, s, await wallets(), session.publicKey, { name: 'claim' }, { secret: plan.keys.spend })], [session]))).toBe('TooEarly');

    // The daemon comes back: it sees the frozen swap and a notice whose lock does not exist, and refunds at once (Z3).
    await drive(async () => ((await sol.swap(pda))?.state ?? SWAP_STATE.DONE) === SWAP_STATE.DONE);
    const refund = d.store.intents({ swapRef: pda }).find((i) => i.payload['call'] === 'refund')!;
    expect(refund).toMatchObject({ status: 'confirmed', payload: expect.objectContaining({ row: 'Z3', state: SWAP_STATE.FROZEN }) });
    expect(BigInt(refund.payload['at'] as bigint) <= tFf - M).toBe(true);
    // The escrow is back with the operator; the take deposit went back to the TAKER at once: a maker-side freeze never holds it.
    expect(await sol.tokenBalance(sol.operator.publicKey)).toBe(operatorUsdc);
    expect(await sol.tokenBalance(sol.taker.publicKey)).toBe(takerUsdc);
    expect((await sol.maker()).counters[COUNTER.backouts_after_freeze]).toBe(1);
    expect(intentsOf(pda).filter((i) => i.includes('withhold'))).toEqual([]);
    expect(d.store.freeze(pda)).toMatchObject({ direction: 1, frozen_by: 'maker_watcher', watcher: sol.watcher.publicKey, t_ff: Number(tFf) });
    expect(d.alerts.list(50).some((a) => a.kind === 'swap_frozen' && a.swap_ref === pda)).toBe(true);
    await drive(async () => d.store.swap(pda)!.terminal === 1);
    expect((await sol.client.getCaps(1)).openValue).toBe(0n);
  });
});
