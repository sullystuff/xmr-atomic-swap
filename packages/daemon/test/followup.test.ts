// Follow-ups to Amendment 1: authenticated watch requests across key rotation, the SDK's signing bounds,
// `status.degraded`, the per-swap `parked` field, and unreadable markets in `caps[]`.
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { ETH_NATIVE, SWAP_STATE } from '@xmrswap/protocol';
import { ETH_GAS_CAP, ETH_GAS_CAP_DEFAULT, SOLANA_MAX_PRIORITY_FEE as SDK_MAX_PRIORITY_FEE, ata, seedSigner } from '@xmrswap/sdk';
import { OPERATOR_GAS_CAP, gasCapFor } from '../src/chains/ethereum.js';
import { SOLANA_MAX_PRIORITY_FEE, loadConfig } from '../src/config/load.js';
import { Daemon } from '../src/daemon.js';
import { parkedOf, swapSummary } from '../src/swaps/views.js';
import { FakeWatcher, type OpenedSwap, XMR, buildNotice, swapJointAddress, viewOf } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
const OWNER = seedSigner(new Uint8Array(32).fill(2)).publicKey;
function usdc(w: World, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
type Degraded = { state: boolean; reasons: { code: string; message: string; chain?: string; swap_ref?: string }[] };
const degradedOf = async (d: Daemon): Promise<Degraded> => ((await d.status()) as unknown as { degraded: Degraded }).degraded;
const buyToml = (wt: FakeWatcher, extra = ''): string => `${BASE_TOML.replace('[markets.usdc_sol.buy_xmr]\nenabled = true', '[markets.usdc_sol.buy_xmr]\nenabled = true\nfreeze_window_hours = 24\ndeposit_pct = 1')}\n[watcher]\nurl = "http://watcher.test"\nsolana_key = "${wt.solana}"\nretry_seconds = 0.001\n${extra}`;
async function watched(tweak: (wt: FakeWatcher) => void = () => {}, extra = ''): Promise<{ w: World; d: Daemon; wt: FakeWatcher }> {
  const w = await makeWorld();
  const wt = new FakeWatcher(w.sim);
  tweak(wt);
  writeFileSync(w.configPath, buyToml(wt, extra).replaceAll('__OWNER__', w.sim.owner));
  usdc(w, 1_000_000_000_000n);
  const d = await w.boot({ watcherFetch: wt.fetch });
  await d.start();
  return { w, d, wt };
}
function postNotice(w: World, s: OpenedSwap): void {
  const view = viewOf(w.sim, s.pda);
  const joint = swapJointAddress(view, s.keys.view, 'regtest');
  const txid = w.xmr.external(joint.address, view.xmr);
  const notice = buildNotice(view, s.keys.encSecret, Uint8Array.from(Buffer.from(txid, 'hex')), s.keys.view);
  w.sim.takerCall(s.pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
}

describe('authenticated watch requests (SDK X1) and key rotation', () => {
  it('the request verifies against the maker key recorded in the swap, for this deployment, stamped with chain time', async () => {
    const { w, d, wt } = await watched();
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ: 86_400 });
    await d.executor.tick();
    await d.executor.tick();
    expect(wt.refused).toEqual([]);
    expect(d.store.watchAck(s.pda)).toMatchObject({ watcher: wt.solana });
    d.store.close();
  });

  it('a swap funded under key version 1 still registers after the key was rotated twice and the grace of version 1 has run out', async () => {
    const { w, d, wt } = await watched((x) => (x.down = true), '[rotation]\ngrace_hours = 0.03\n');
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ: 86_400 });
    await d.executor.tick();
    await d.executor.tick();
    expect(w.sim.swap(s.pda)).toMatchObject({ state: SWAP_STATE.ACTIVE, makerEncVersion: 1, watcher: wt.solana });
    expect(d.store.watchAck(s.pda)).toBeUndefined();
    // Two rotations while the watcher is unreachable; the grace of both retired keys passes and the pruning runs.
    // (The grace is 108 s here so that both fit inside the swap's 10-minute notice window.)
    await d.rotation.rotate();
    w.sim.warp(150);
    await d.rotation.rotate();
    w.sim.warp(150);
    await d.rotation.tick();
    expect(w.sim.maker().encKeyVersion).toBe(3);
    // Version 1 is retired and past its grace, but a swap opened under it is still open: its secret is kept. Version 2 has no swap and is gone.
    expect(d.encKeys.secretFor(1)).not.toBeNull();
    expect(d.encKeys.secretFor(2)).toBeNull();
    expect(d.rotation.view().keys.find((k) => k.version === 1)).toMatchObject({ open_swaps: 1 });
    // The watcher comes back: the swap registers with version 1's secret (the key the swap records), not the current one.
    wt.down = false;
    await new Promise((r) => setTimeout(r, 5));
    await d.executor.tick();
    expect(wt.refused).toEqual([]);
    expect(d.store.watchAck(s.pda)).toMatchObject({ watcher: wt.solana });
    // And again later (a watcher that lost its state): the stored acknowledgement is dropped and the swap re-registers the same way.
    d.store.db.prepare('DELETE FROM watch_acks WHERE swap_ref = ?').run(s.pda);
    wt.keys.clear();
    postNotice(w, s);
    await d.executor.tick();
    expect(wt.refused).toEqual([]);
    expect(wt.keys.has(s.pda)).toBe(true);
    expect(d.store.watchAck(s.pda)).toBeDefined();
    // The swap ends; only then may version 1's secret be deleted.
    w.xmr.mine(2);
    w.sim.warp(120);
    await d.executor.tick();
    w.sim.takerCall(s.pda, { name: 'claim', secretOk: true }, { revealed: s.keys.spend });
    w.xmr.mine(10);
    for (let i = 0; i < 4 && !d.store.swap(s.pda)!.terminal; i++) await d.executor.tick();
    expect(d.store.swap(s.pda)!.terminal).toBe(1);
    await d.rotation.tick();
    expect(d.encKeys.secretFor(1)).toBeNull();
    d.store.close();
  });

  it('a request made with another key than the one in the swap is refused by the watcher (what the daemon must never send)', async () => {
    const { w, d, wt } = await watched((x) => (x.down = true));
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ: 86_400 });
    await d.executor.tick();
    wt.down = false;
    await new Promise((r) => setTimeout(r, 5));
    const wrong = await d.watcher.register(s.pda, viewOf(w.sim, s.pda), new Uint8Array(32).fill(0x44), w.sim.now);
    expect(wrong).toBeNull();
    expect(wt.refused).toHaveLength(1);
    expect(d.store.watchAck(s.pda)).toBeUndefined();
    d.store.close();
  });
});

describe('signing bounds (SDK X3, X4)', () => {
  it('a priority fee over the bound is a configuration error; the bound can be raised explicitly, with a warning that states the worst case', () => {
    expect(BigInt(SOLANA_MAX_PRIORITY_FEE)).toBe(SDK_MAX_PRIORITY_FEE);
    const base = BASE_TOML.replaceAll('__OWNER__', OWNER);
    const over = loadConfig(base.replace('rpc_url_env = "TEST_SOL_RPC"', 'rpc_url_env = "TEST_SOL_RPC"\npriority_fee_microlamports = 6000000'));
    expect(over.config).toBeNull();
    expect(over.validation.errors).toEqual([{ path: 'solana.priority_fee_microlamports', message: expect.stringMatching(/6000000 micro-lamports per compute unit is over the bound of 5000000 \(the default; set solana.max_priority_fee_microlamports to raise it\)/) }]);
    const raised = loadConfig(base.replace('rpc_url_env = "TEST_SOL_RPC"', 'rpc_url_env = "TEST_SOL_RPC"\npriority_fee_microlamports = 6000000\nmax_priority_fee_microlamports = 8000000'));
    expect(raised.validation.errors).toEqual([]);
    expect(raised.validation.warnings.find((x) => x.path === 'solana.max_priority_fee_microlamports')!.message).toMatch(/up to 3205000 lamports/);
    expect(loadConfig(base.replace('rpc_url_env = "TEST_SOL_RPC"', 'rpc_url_env = "TEST_SOL_RPC"\npriority_fee_microlamports = 5000000')).validation.errors).toEqual([]);
  });

  it('a raised bound reaches the client: the daemon signs at the configured fee, and without it the SDK would refuse', async () => {
    const w = await makeWorld(BASE_TOML.replace('rpc_url_env = "TEST_SOL_RPC"', 'rpc_url_env = "TEST_SOL_RPC"\npriority_fee_microlamports = 6000000\nmax_priority_fee_microlamports = 8000000'));
    const d = await w.boot();
    await d.start();
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 1 });
    expect(d.alerts.list().filter((a) => a.kind === 'offer_refresh_failed')).toEqual([]);
    d.store.close();
  });

  it('every Ethereum call the operator sends has a gas cap that fits it; the SDK caps are never lowered', async () => {
    const contract = `0x${'c0'.repeat(20)}` as const;
    const { XmrSwapContract } = await import('@xmrswap/sdk');
    const c = new XmrSwapContract(contract);
    const id = new Uint8Array(32).fill(1);
    expect(gasCapFor(c.setReady(id), contract)).toBe(150_000n);
    expect(gasCapFor(c.freeze(id), contract)).toBe(150_000n);
    expect(gasCapFor(c.pushOwed(ETH_NATIVE as `0x${string}`, contract), contract)).toBe(150_000n);
    expect(gasCapFor(c.bumpEpochs(true, true), contract)).toBe(150_000n);
    // `approve` is the maker's dearest unmeasured call: its own bound, above the 150,000 default.
    expect(OPERATOR_GAS_CAP['approve']).toBe(300_000n);
    expect(ETH_GAS_CAP['fund']).toBe(300_000n);
    for (const [name, cap] of Object.entries(OPERATOR_GAS_CAP)) expect(cap >= (ETH_GAS_CAP[name] ?? ETH_GAS_CAP_DEFAULT), name).toBe(true);
    // A call to another contract (the USDC allowance) keeps the SDK's default.
    expect(gasCapFor({ to: `0x${'aa'.repeat(20)}`, data: '0x095ea7b3', value: 0n }, contract)).toBe(ETH_GAS_CAP_DEFAULT);
  });

  it('a stuck Solana transaction is judged by block height (the SDK\'s blockhashExpired), not by a timer', async () => {
    const w = await makeWorld();
    const d = await w.boot({ solanaBlockHeight: undefined as never });
    const sig = seedSigner(new Uint8Array(32).fill(9)).publicKey;
    const lastValid = w.sim.fake.blockHeight + 150;
    // Signed long ago by the wall clock, but its blockhash is still valid: pending, not dead.
    expect(await d.sol!.status(sig, { lastValidBlockHeight: lastValid, signedAtMs: 0 })).toEqual({ state: 'pending' });
    w.sim.fake.blockHeight = lastValid + 1;
    expect(await d.sol!.status(sig, { lastValidBlockHeight: lastValid, signedAtMs: Date.now() })).toEqual({ state: 'dead' });
    d.store.close();
  });
});

describe('status.degraded', () => {
  it('is clear when everything works, and names each thing that does not', async () => {
    const { w, d, wt } = await watched();
    await d.refreshMonero();
    expect(await degradedOf(d)).toEqual({ state: false, reasons: [] });

    // Monero: a node down; the wallet RPC down.
    w.xmr.down = true;
    await d.refreshMonero();
    expect((await degradedOf(d)).reasons).toEqual([{ code: 'monero_node_down', message: 'Monero nodes not answering: fake-a, fake-b' }]);
    w.xmr.down = false;
    await d.refreshMonero();
    (d as unknown as { walletOk: boolean }).walletOk = false;
    expect((await degradedOf(d)).reasons.map((r) => r.code)).toEqual(['wallet_rpc_down']);
    (d as unknown as { walletOk: boolean }).walletOk = true;
    (d as unknown as { moneroStatus: unknown }).moneroStatus = { nodes: [{ label: 'a', ok: true, height: 5, top_hash: 'aa' }, { label: 'b', ok: true, height: 5, top_hash: 'bb' }], agree: false };
    expect((await degradedOf(d)).reasons.map((r) => r.code)).toEqual(['monero_nodes_disagree']);
    await d.refreshMonero();

    // The fee wallet under its runway threshold.
    const operator = w.keystore.solana.publicKey;
    const rich = w.sim.fake.accounts.get(operator)!;
    w.sim.fake.setAccount(operator, rich.owner, rich.data, 1_000_000n);
    expect((await degradedOf(d)).reasons).toEqual([{ code: 'fee_runway', chain: 'solana', message: expect.stringMatching(/covers 0\.0 days, under the 7-day threshold/) }]);
    w.sim.fake.setAccount(operator, rich.owner, rich.data, rich.lamports);

    // A pass over the open swaps that took too long.
    d.executor.lastPass = { at: Date.now(), ms: Daemon.PASS_SLOW_MS + 1_500 };
    expect((await degradedOf(d)).reasons).toEqual([{ code: 'executor_slow', message: expect.stringMatching(/took 31\.5 s \(the bound is 30 s\)/) }]);
    await d.executor.tick();
    expect(d.executor.lastPass!.ms).toBeLessThan(Daemon.PASS_SLOW_MS);

    // The watcher unreachable while a funded sell-XMR swap has no acknowledgement; clear again once it acknowledges.
    wt.down = true;
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ: 86_400 });
    await d.executor.tick();
    await d.executor.tick();
    await d.watcher.probe();
    const g = await degradedOf(d);
    expect(g).toEqual({ state: true, reasons: [{ code: 'watcher_not_watching', swap_ref: s.pda, message: expect.stringMatching(/has not acknowledged this funded swap \(it is unreachable/) }] });
    wt.down = false;
    await new Promise((r) => setTimeout(r, 5));
    await d.executor.tick();
    expect(await degradedOf(d)).toEqual({ state: false, reasons: [] });

    // A chain endpoint that serves old state.
    const realNow = Date.now;
    Date.now = () => (Number(w.sim.now) + 500) * 1000;
    try {
      expect((await degradedOf(d)).reasons).toEqual([{ code: 'chain_behind', chain: 'solana', message: 'the solana endpoint is 500 s behind the local clock: it serves old state' }]);
    } finally {
      Date.now = realNow;
    }
    d.store.close();
  });

  it('a configured chain that is not connected is unreachable, and its markets are listed in caps[] as unreadable with the reason', async () => {
    const w = await makeWorld(`${BASE_TOML}\n[ethereum]\ncontract = "0x${'c0'.repeat(20)}"\nchain_id = 31337\nmaker_owner = "0x${'0b'.repeat(20)}"\n`);
    const d = await w.boot();
    await d.start();
    await d.refreshMonero();
    const status = await d.status();
    const reason = 'not connected: ETHEREUM_RPC_URL is not set';
    expect(status.caps).toEqual([
      { market: 'sol', caps: expect.objectContaining({ on: false }) },
      { market: 'usdc_sol', caps: expect.objectContaining({ on: false }) },
      { market: 'eth', caps: null, reason },
      { market: 'usdc_eth', caps: null, reason },
    ]);
    expect((status as unknown as { degraded: Degraded }).degraded).toEqual({ state: true, reasons: [{ code: 'chain_unreachable', chain: 'ethereum', message: 'the ethereum endpoint cannot be reached' }] });
    d.store.close();
  });
});

describe('parked payouts on a swap', () => {
  it('says for whom, how much and which action applies; nothing parked is an empty list', async () => {
    const w = await makeWorld();
    usdc(w, 1_000_000_000_000n);
    const d = await w.boot();
    await d.start();
    const fresh = seedSigner(new Uint8Array(32).fill(0x61)).publicKey;
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, payout: fresh });
    await d.executor.tick();
    const now = () => Number(w.sim.now);
    expect((swapSummary(d.store.swap(s.pda)!, now(), d.store) as unknown as { parked: unknown[] }).parked).toEqual([]);
    postNotice(w, s);
    w.xmr.mine(2);
    w.sim.warp(120);
    await d.executor.tick();
    w.sim.takerCall(s.pda, { name: 'claim', secretOk: true }, { revealed: s.keys.spend }, 'session', { payoutCanReceive: false });
    const owed = w.sim.swap(s.pda)!.owedTaker;
    w.xmr.mine(10);
    await d.executor.tick();
    // Claim proceeds parked for the payout address: delivered by the operator, not withdrawn by the owner.
    expect((swapSummary(d.store.swap(s.pda)!, now(), d.store) as unknown as { parked: unknown[] }).parked).toEqual([{ for: 'payout', amount: owed.toString(), account: fresh, action: 'deliver' }]);
    await d.deliverOwed(viewOf(w.sim, s.pda), s.pda);
    expect(parkedOf(w.sim.swap(s.pda) ? viewOf(w.sim, s.pda) : null)).toEqual([]);
    // The other cases, from the view alone.
    const v = viewOf(w.sim, w.sim.open({ direction: 0, xmr: XMR, makerSpendPub: new Uint8Array(32) }).pda);
    expect(parkedOf({ ...v, owedMaker: 7n, owedTaker: 3n, owedTreasury: 1n })).toEqual([
      { for: 'maker', amount: '7', account: null, action: 'withdraw' },
      { for: 'taker', amount: '3', account: v.taker, action: 'none' },
      { for: 'treasury', amount: '1', account: null, action: 'none' },
    ]);
    expect(parkedOf({ ...v, chain: 'ethereum', owedMaker: 7n, owedTaker: 3n }).map((p) => [p.for, p.action])).toEqual([['maker', 'deliver'], ['taker', 'deliver']]);
    d.store.close();
  });
});
