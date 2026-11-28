// Amendment 1 (SPEC 11) in the daemon: the on-chain caps, the freeze window in both directions,
// the maker's watcher, the payout address, and the fee figures that changed with them.
import { beforeAll, describe, expect, it } from 'vitest';
import { depositOf, init, payAmount, receiveAmount } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, COUNTER, REJECT_REASON, SWAP_STATE, capsRefusal } from '@xmrswap/protocol';
import { ata, deadlinesOf, noticeKey, seedSigner, verifyWatchAck } from '@xmrswap/sdk';
import { PublicKey } from '@solana/web3.js';
import { freezeWarning, loadConfig } from '../src/config/load.js';
import type { Daemon } from '../src/daemon.js';
import { SOLANA_CU, solanaCallFee, swapCosts } from '../src/stats/costs.js';
import { swapSummary } from '../src/swaps/views.js';
import { FakeWatcher, type OpenedSwap, XMR, buildNotice, swapJointAddress, viewOf } from './sim.js';
import { BASE_TOML, ENC_SECRET_V1, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});

const M = BigInt(CHAIN_CONSTS.solana.marginSecs);
function usdc(w: World, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
async function live(toml = BASE_TOML, opts: { outputs?: bigint[]; before?: (w: World) => void; boot?: (w: World) => Parameters<World['boot']>[0] } = {}): Promise<{ w: World; d: Daemon }> {
  const w = await makeWorld(toml, opts);
  usdc(w, 1_000_000_000_000n);
  opts.before?.(w);
  const d = await w.boot(opts.boot?.(w));
  await d.start();
  return { w, d };
}
const sell = (extra: string, toml = BASE_TOML): string => toml.replace('[markets.sol.sell_xmr]\nenabled = true', `[markets.sol.sell_xmr]\nenabled = true\n${extra}`);
const buy = (extra: string, toml = BASE_TOML): string => toml.replace('[markets.usdc_sol.buy_xmr]\nenabled = true', `[markets.usdc_sol.buy_xmr]\nenabled = true\n${extra}`);
const BIG = 1n << 60n;
const names = (w: World, pda: string) => w.sim.names(pda);
const offerOf = (d: Daemon, market: string, direction: string) => d.offers.latest().find((c) => c.offer.market === market && c.offer.direction === direction)!;

// ------------------------------------------------------------------------------------------------ configuration

describe('configuration (SPEC 11.6, 11.9 A6)', () => {
  const load = (toml: string) => loadConfig(toml.replaceAll('__OWNER__', seedSigner(new Uint8Array(32).fill(2)).publicKey));

  it('freeze_window_hours defaults to 0 (no watcher accepted) and is carried into the effective terms', () => {
    const r = load(BASE_TOML);
    expect(r.validation.errors).toEqual([]);
    expect(r.config!.offers.filter((o) => o.enabled).map((o) => o.freezeWindowSecs)).toEqual([0, 0]);
    expect(r.validation.effective.every((e) => e.freeze_window_secs === 0)).toBe(true);
    expect(r.validation.warnings.some((w) => w.path.endsWith('freeze_window_hours'))).toBe(false);
  });

  it('a non-zero window is published as W_z, raises a plain warning that states the worst-case lock-up, and prices it with price_moved by default', () => {
    const r = load(sell('freeze_window_hours = 24\ndeposit_pct = 2'));
    expect(r.validation.errors).toEqual([]);
    const o = r.config!.offers.find((x) => x.market === 'sol' && x.direction === 'sell_xmr')!;
    expect(o.freezeWindowSecs).toBe(86_400);
    expect(o.withholdPolicy).toBe('price_moved');
    expect(r.validation.effective.find((e) => e.market === 'sol')!.freeze_window_secs).toBe(86_400);
    const w = r.validation.warnings.find((x) => x.path === 'markets.sol.sell_xmr.freeze_window_hours')!;
    // The Solana default claim delay is 90 minutes: 1.5 h becomes 25.5 h, 17 times longer (the figure of SPEC 11.6).
    expect(w.message).toBe(freezeWarning('sell_xmr', 5_400, 86_400, 200));
    expect(w.message).toMatch(/for up to 25\.5 h after your notice instead of 1\.5 h \(17 times longer\)/);
    expect(w.message).toMatch(/always leaves the deposit withholdable/);
    // The maker's explicit policy is kept; without a deposit the warning says nothing prices the option.
    expect(load(sell('freeze_window_hours = 24\nwithhold_policy = "never"\ndeposit_pct = 2')).config!.offers.find((x) => x.market === 'sol' && x.direction === 'sell_xmr')!.withholdPolicy).toBe('never');
    expect(load(sell('freeze_window_hours = 72')).validation.warnings.find((x) => x.path.endsWith('freeze_window_hours'))!.message).toMatch(/49 times longer.*takes no deposit, so nothing prices that option/);
  });

  it('refuses a window outside 1..72 hours and one the final window cannot hold; unknown keys stay errors', () => {
    expect(load(sell('freeze_window_hours = 0.5')).validation.errors[0]).toMatchObject({ path: 'markets.sol.sell_xmr', message: expect.stringMatching(/freeze window 1800 s is neither 0 nor inside 3600\.\.259200/) });
    expect(load(sell('freeze_window_hours = 80')).validation.errors[0]!.message).toMatch(/freeze window 288000 s/);
    // W_p + W_n + D_c + W_z + W_c + 86,400 <= W_f: two days of final window hold no 24-hour pause.
    expect(load(sell('freeze_window_hours = 24\nfinal_days = 2')).validation.errors[0]!.message).toMatch(/final window 172800 s is under \d+ s \(the freeze window counts\)/);
    expect(load(sell('final_days = 2')).validation.errors).toEqual([]);
    expect(load(`${BASE_TOML}\n[watcher]\nurl = "https://w.example"\nkey = "x"\n`).validation.errors[0]!.path).toBe('watcher');
    expect(load(`${BASE_TOML}\n[approvals]\ndeny_watcher = ["x"]\n`).validation.errors[0]!.path).toBe('approvals');
  });

  it('[watcher] needs its Solana key; a buy-XMR window without a watcher and a watcher without a window are said so', () => {
    const key = seedSigner(new Uint8Array(32).fill(0x77)).publicKey;
    expect(load(`${BASE_TOML}\n[watcher]\nurl = "https://w.example"\n`).validation.errors).toEqual([{ path: 'watcher.solana_key', message: expect.stringMatching(/needs its Solana key/) }]);
    const idle = load(`${BASE_TOML}\n[watcher]\nurl = "https://w.example"\nsolana_key = "${key}"\n`);
    expect(idle.validation.errors).toEqual([]);
    expect(idle.validation.warnings.find((w) => w.path === 'watcher.url')!.message).toMatch(/no buy-XMR offer has a freeze window/);
    const noWatcher = load(buy('freeze_window_hours = 24'));
    expect(noWatcher.validation.warnings.filter((w) => w.path === 'markets.usdc_sol.buy_xmr.freeze_window_hours').map((w) => w.message)).toEqual([
      expect.stringMatching(/lets your watcher \(or this daemon\) pause.*up to 24 h longer.*can never be held/),
      expect.stringMatching(/no maker watcher is set for solana/),
    ]);
    const ok = load(`${buy('freeze_window_hours = 24')}\n[watcher]\nurl = "https://w.example"\nsolana_key = "${key}"\n`);
    expect(ok.validation.errors).toEqual([]);
    expect(ok.validation.warnings.filter((w) => w.path.startsWith('watcher') || /no maker watcher/.test(w.message))).toEqual([]);
  });

  it('watcher rules that cannot be enforced before the fact on a Solana auto-accept offer are said so', () => {
    const r = load(`${sell('freeze_window_hours = 24')}\n[approvals]\nrefuse_watchers = true\n`);
    expect(r.validation.warnings.find((w) => w.path === 'markets.sol.sell_xmr.approval_mode')!.message).toMatch(/cannot be enforced before the fact on a Solana auto-accept offer/);
  });
});

// ------------------------------------------------------------------------------------------------ caps

describe('caps (SPEC 11.1)', () => {
  it('a fresh deployment (caps on, all zero): the daemon starts cleanly, publishes nothing, and says why', async () => {
    const { w, d } = await live(BASE_TOML, { before: (w) => w.sim.setCaps(true, [0n, 0n], [0n, 0n]) });
    // Nothing was sent: no terms, no keys, no refresh.
    expect(w.sim.landed).toEqual([]);
    expect(w.sim.offer(0, 0)).toBeNull();
    for (const c of d.offers.latest().filter((x) => x.offer.configured)) {
      expect(c).toMatchObject({ enabled: false, capacityXmr: 0n, capReached: 'SwapCapExceeded' });
      expect(c.reason).toMatch(/^cap reached: this deployment's caps are switched on and zero, so nothing can open until its admin sets them \(a fresh deployment starts this way\)$/);
    }
    const status = await d.status();
    expect(status.caps).toEqual([
      { market: 'sol', caps: { on: true, max_swap: '0', max_open: '0', open_value: '0', headroom: '0', frozen: false } },
      { market: 'usdc_sol', caps: { on: true, max_swap: '0', max_open: '0', open_value: '0', headroom: '0', frozen: false } },
    ]);
    expect((status as unknown as { cap_reached: unknown[] }).cap_reached).toHaveLength(2);
    expect(d.alerts.list().filter((a) => a.kind === 'cap_reached').map((a) => a.level)).toEqual(['warning', 'warning']);
    // No error anywhere: a cap is an expected outcome.
    expect(d.alerts.list().filter((a) => a.level === 'critical' || a.kind === 'offer_refresh_failed')).toEqual([]);
    // The admin sets caps: the next pass publishes.
    w.sim.setCaps(true, [BIG, BIG], [BIG, BIG]);
    await d.offers.tick(true);
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 1 });
    expect(offerOf(d, 'sol', 'sell_xmr')).toMatchObject({ enabled: true, capReached: null });
    // Frozen with the caps on: said so.
    w.sim.freezeConfig();
    await d.caps.refresh(true);
    expect(d.caps.view()[0]!.caps!.frozen).toBe(true);
    d.store.close();
  });

  it('sizes each offer to what the caps leave: max_swap bounds the amount, max_open the open value, and direction B counts amount + deposit', async () => {
    const { w, d } = await live(buy('deposit_pct = 1'), { before: (w) => w.sim.setCaps(true, [2_000_000_000n, BIG], [BIG, 300_000_000n]) });
    // Sell XMR for SOL: one swap may escrow at most 2 SOL.
    const a = offerOf(d, 'sol', 'sell_xmr');
    const onChainA = w.sim.offer(0, 0)!;
    expect(a).toMatchObject({ enabled: true, limit: 'max_swap', capReached: null });
    expect(onChainA.capacityXmr).toBe(a.capacityXmr);
    const priceA = onChainA.prices[0]!;
    expect(payAmount(a.capacityXmr, priceA, 'solana') <= 2_000_000_000n).toBe(true);
    expect(payAmount(a.capacityXmr + 1n, priceA, 'solana') > 2_000_000_000n).toBe(true);
    expect(a.capacityXmr < 5n * XMR).toBe(true); // the inventory alone would allow a 5 XMR output
    // Buy XMR with USDC: 300 USDC of open value are left, and the take deposit (1%) is counted with the amount.
    const b = offerOf(d, 'usdc_sol', 'buy_xmr');
    const priceB = w.sim.offer(1, 1)!.prices[0]!;
    expect(b).toMatchObject({ enabled: true, limit: 'max_open' });
    const counted = (xmr: bigint) => receiveAmount(xmr, priceB, 'solana') + depositOf(receiveAmount(xmr, priceB, 'solana'), 100);
    expect(counted(b.capacityXmr) <= 300_000_000n).toBe(true);
    expect(counted(b.capacityXmr + 1n) > 300_000_000n).toBe(true);
    expect(capsRefusal(w.sim.caps(1), 1, receiveAmount(b.capacityXmr + 1n, priceB, 'solana'), depositOf(receiveAmount(b.capacityXmr + 1n, priceB, 'solana'), 100))).toBe('OpenCapExceeded');
    // The amount alone would still fit at that size: it is the deposit that is counted.
    expect(receiveAmount(b.capacityXmr + 1_000_000n, priceB, 'solana') <= 300_000_000n).toBe(true);
    // The views say which limit binds, and the chain's own figures are beside them.
    const views = d.offers.views();
    expect(views.find((v) => v.market === 'sol' && v.direction === 'sell_xmr')).toMatchObject({ capacity_limit: 'max_swap', capacity_xmr: a.capacityXmr.toString(), cap_reached: null });
    expect(views.find((v) => v.market === 'usdc_sol' && v.direction === 'buy_xmr')).toMatchObject({ capacity_limit: 'max_open', cap_reached: null });
    // A limit of the maker's own is still reported as its own.
    w.sim.setCaps(false, [0n, 0n], [0n, 0n]);
    await d.caps.refresh(true);
    await d.offers.tick(true);
    expect(offerOf(d, 'sol', 'sell_xmr')).toMatchObject({ limit: 'inventory', capReached: null, capacityXmr: d.inventory.capacity().largest });
    d.store.close();
  });

  it('an open above the cap is refused by the chain, the offer says "cap reached" (not a maker limit), and the open value freed by settlement lets the next swap open', async () => {
    const { w, d } = await live();
    const price = w.sim.offer(0, 0)!.prices[0]!;
    // Room for one 2 XMR swap and a little more, but not for the offer's smallest (0.1 XMR) on top.
    const one = payAmount(2n * XMR, price, 'solana');
    w.sim.setCaps(true, [one, BIG], [one + 1_000n, BIG]);
    await d.caps.refresh(true);
    await d.offers.tick(true);
    expect(offerOf(d, 'sol', 'sell_xmr')).toMatchObject({ enabled: true, capacityXmr: 2n * XMR, limit: 'max_swap' });
    // One unit above the per-swap cap: the chain refuses the lock; the daemon never sees a swap.
    expect(() => w.sim.open({ direction: 0, xmr: 2n * XMR + 1_000_000n, price, makerSpendPub: new Uint8Array(32) })).toThrow('SwapCapExceeded');
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, price, makerSpendPub: w.sim.takePoolKey(0) });
    expect(w.sim.caps(0).openValue).toBe(one);
    await d.tickOnce();
    await d.caps.refresh(true);
    await d.offers.tick(true);
    const stopped = offerOf(d, 'sol', 'sell_xmr');
    expect(stopped).toMatchObject({ enabled: false, capReached: 'OpenCapExceeded', limit: 'max_open' });
    expect(stopped.reason).toMatch(/^cap reached: 1000 of \d+ base units of open value are left during the beta/);
    expect(stopped.reason).not.toMatch(/no capacity/);
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 0, capacityXmr: 0n });
    expect(() => w.sim.open({ direction: 0, xmr: XMR, price, makerSpendPub: new Uint8Array(32) })).toThrow('OpenCapExceeded');
    // The quote route says the same thing with the chain's own code, and counts it.
    const q = await d.offers.quoteOnRequest({ chain: 'solana', market: 'sol', direction: 'A', xmr: (2n * XMR).toString(), taker: w.sim.taker });
    expect(q).toMatchObject({ ok: false, code: 'OpenCapExceeded', detail: expect.stringMatching(/^cap reached: 1000 base units of open value are left/) });
    const tooBig = await d.offers.quoteOnRequest({ chain: 'solana', market: 'sol', direction: 'A', xmr: (3n * XMR).toString(), taker: w.sim.taker });
    expect(tooBig).toMatchObject({ ok: false, code: 'SwapCapExceeded' });
    expect(d.caps.refusedQuotes).toBe(2);
    // The swap settles: its value leaves the open value exactly once, and the offer is back.
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    await d.executor.tick();
    expect(w.sim.swap(s.pda)?.state ?? SWAP_STATE.DONE).toBe(SWAP_STATE.DONE);
    expect(w.sim.caps(0).openValue).toBe(0n);
    await d.caps.refresh(true);
    await d.offers.tick(true);
    expect(offerOf(d, 'sol', 'sell_xmr')).toMatchObject({ enabled: true, capReached: null, capacityXmr: 2n * XMR });
    const next = w.sim.open({ direction: 0, xmr: 2n * XMR, price, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    expect(w.sim.swap(next.pda)!.state).toBe(SWAP_STATE.NOTICED);
    // Never an error or a critical alert for a cap.
    expect(d.alerts.list(100).filter((a) => a.level === 'critical')).toEqual([]);
    d.store.close();
  });

  it('caps the chain cannot be read for fail closed: nothing is published until they can', async () => {
    const { w, d } = await live();
    const config = w.sim.program.config.toBase58();
    const saved = w.sim.fake.accounts.get(config)!;
    w.sim.fake.accounts.delete(config);
    await d.caps.refresh(true);
    await d.offers.tick(true);
    expect(offerOf(d, 'sol', 'sell_xmr')).toMatchObject({ enabled: false, capReached: null });
    expect(offerOf(d, 'sol', 'sell_xmr').reason).toMatch(/the on-chain caps could not be read/);
    expect((await d.status()).caps).toEqual([{ market: 'sol', caps: null, reason: 'the program has no Config account' }, { market: 'usdc_sol', caps: null, reason: 'the program has no Config account' }]);
    expect(((await d.status()) as unknown as { degraded: { reasons: { code: string }[] } }).degraded.reasons.map((r) => r.code)).toContain('caps_unreadable');
    w.sim.fake.accounts.set(config, saved);
    await d.caps.refresh(true);
    await d.offers.tick(true);
    expect(offerOf(d, 'sol', 'sell_xmr').enabled).toBe(true);
    d.store.close();
  });
});

// ------------------------------------------------------------------------------------------------ freeze, as the counterparty

const FREEZE_A = sell('freeze_window_hours = 24\ndeposit_pct = 2\nwithhold_policy = "always"');
/** Direction A to NOTICED with the XMR relayed and confirmed, on an offer with a 24-hour freeze window. */
async function noticedA(w: World, d: Daemon, extra: { watcher?: string } = {}): Promise<OpenedSwap> {
  const s = w.sim.open({ direction: 0, xmr: 2n * XMR, depBps: 200, wZ: 86_400, makerSpendPub: w.sim.takePoolKey(0), ...extra });
  await d.executor.tick();
  expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.NOTICED);
  w.xmr.mine(2);
  return s;
}

describe('freeze as the counterparty: sell-XMR offers (SPEC 11.6, Z1 to Z5)', () => {
  it('publishes W_z with the terms: 0 by default, the configured window otherwise', async () => {
    const plain = await live();
    expect(plain.w.sim.offer(0, 0)!.wZ).toBe(0);
    plain.d.store.close();
    const { w, d } = await live(FREEZE_A);
    expect(w.sim.offer(0, 0)!.wZ).toBe(86_400);
    expect(d.offers.views().find((v) => v.market === 'sol')!.terms.freeze_window_secs).toBe(86_400);
    // The window changes: the terms are published again.
    d.applyConfig(d.load.toml.replace('freeze_window_hours = 24', 'freeze_window_hours = 48'), 'api');
    await d.offers.tick(true);
    expect(w.sim.offer(0, 0)!.wZ).toBe(172_800);
    d.store.close();
  });

  it('a lock that names a watcher against a window of 0 is refused by the chain; with a window it opens', async () => {
    const { w, d } = await live();
    const watcher = seedSigner(new Uint8Array(32).fill(0x55)).publicKey;
    expect(() => w.sim.open({ direction: 0, xmr: XMR, wZ: w.sim.offer(0, 0)!.wZ, watcher, makerSpendPub: new Uint8Array(32) })).toThrow('WatcherNotAllowed');
    d.store.close();
    const f = await live(FREEZE_A);
    const s = f.w.sim.open({ direction: 0, xmr: XMR, wZ: f.w.sim.offer(0, 0)!.wZ, watcher, makerSpendPub: f.w.sim.takePoolKey(0) });
    await f.d.executor.tick();
    expect(f.w.sim.swap(s.pda)).toMatchObject({ state: SWAP_STATE.NOTICED, watcher });
    expect(swapSummary(f.d.store.swap(s.pda)!, Number(f.w.sim.now), f.d.store).extras).toEqual({ payout: null, watcher, freeze_window_secs: 86_400, watching_until: null });
    f.d.store.close();
  });

  it('frozen by the taker side: no claim before T_ff; the taker refunds, the maker recovers its XMR and applies the withhold policy', async () => {
    const { w, d } = await live(FREEZE_A);
    const watcher = seedSigner(new Uint8Array(32).fill(0x55)).publicKey;
    const s = await noticedA(w, d, { watcher });
    w.sim.warp(600);
    w.sim.watcherFreeze(s.pda);
    const frozen = w.sim.swap(s.pda)!;
    const tFf = deadlinesOf('solana', viewOf(w.sim, s.pda)).tFf!;
    expect(frozen.state).toBe(SWAP_STATE.FROZEN);
    expect(tFf).toBe(frozen.tFreeze + 86_400n);
    expect((await d.executor.tick()).get(s.pda)).toEqual({ kind: 'waiting', on: 'ready', until: tFf });
    // Recorded once, with who froze it as far as the chain tells, and shown.
    expect(d.store.freeze(s.pda)).toMatchObject({ direction: 0, taker: w.sim.taker, watcher, frozen_by: 'taker_side', t_freeze: Number(frozen.tFreeze), t_ff: Number(tFf) });
    expect(d.store.takerFreezes(w.sim.taker)).toBe(1);
    expect(d.alerts.list().find((a) => a.kind === 'swap_frozen')).toMatchObject({ level: 'warning', swap_ref: s.pda });
    const summary = swapSummary(d.store.swap(s.pda)!, Number(w.sim.now), d.store) as unknown as { state: string; phase: string; frozen: unknown; next_deadline: { at: number }; actions: string[] };
    expect(summary).toMatchObject({ state: 'FROZEN', phase: 'frozen', frozen: { t_freeze: Number(frozen.tFreeze), t_ff: Number(tFf), frozen_by: 'taker_side' }, next_deadline: { at: Number(tFf) } });
    expect(summary.actions).toContain('abort');
    // The old claim-open time passes: nothing is claimed, no share leaves.
    w.sim.setTime(frozen.tClaimOpen + 600n);
    expect((await d.executor.tick()).get(s.pda)).toEqual({ kind: 'waiting', on: 'ready', until: tFf });
    expect(w.sim.secretSends).toEqual([]);
    // The taker comes back and refunds (Z3): the deposit is held, the taker's share is public.
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.HOLD);
    expect(w.sim.maker().counters[COUNTER.refunds_after_freeze]).toBe(1);
    w.xmr.mine(10);
    await d.executor.tick();
    // The withhold policy ("always") is applied, with the opening of the notice; the XMR is swept back.
    expect(names(w, s.pda)).toContain('withhold');
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.WITHHELD);
    expect(w.xmr.relaysOf('sweep')).toHaveLength(1);
    expect(d.store.swap(s.pda)).toMatchObject({ swept: 1 });
    expect(w.sim.secretSends).toEqual([]);
    d.store.close();
  });

  it('frozen and the taker never returns: the maker claims at T_ff, not one second earlier', async () => {
    const { w, d } = await live(FREEZE_A);
    const s = await noticedA(w, d, { watcher: seedSigner(new Uint8Array(32).fill(0x55)).publicKey });
    w.sim.warp(300);
    // The locker itself may freeze too (the taker's session key).
    w.sim.takerCall(s.pda, { name: 'freeze' });
    const tFf = deadlinesOf('solana', viewOf(w.sim, s.pda)).tFf!;
    w.sim.setTime(tFf - 1n);
    expect((await d.executor.tick()).get(s.pda)).toEqual({ kind: 'waiting', on: 'ready', until: tFf });
    expect(w.sim.secretSends).toEqual([]);
    w.sim.setTime(tFf);
    await d.executor.tick();
    expect(w.sim.secretSends).toEqual([{ name: 'claim', state: SWAP_STATE.FROZEN, at: tFf }]);
    const claim = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'claim')!;
    expect(claim).toMatchObject({ at: tFf, stateBefore: SWAP_STATE.FROZEN });
    expect(w.sim.maker().counters[COUNTER.claims_after_freeze]).toBe(1);
    expect(d.store.swap(s.pda)).toMatchObject({ terminal: 1, phase: 'completed' });
    expect(d.store.intents({ swapRef: s.pda }).find((i) => i.payload['call'] === 'claim')!.payload['row']).toBe('Z4');
    d.store.close();
  });

  it('a wrong freeze is undone: the taker sets ready in FROZEN and the swap completes as usual', async () => {
    const { w, d } = await live(FREEZE_A);
    const s = await noticedA(w, d, { watcher: seedSigner(new Uint8Array(32).fill(0x55)).publicKey });
    w.sim.warp(300);
    w.sim.watcherFreeze(s.pda);
    await d.executor.tick();
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    await d.executor.tick();
    expect(w.sim.swap(s.pda)).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(w.sim.secretSends).toEqual([{ name: 'claim', state: SWAP_STATE.READY, at: w.sim.now }]);
    expect(d.store.freeze(s.pda)).toMatchObject({ frozen_by: 'taker_side' });
    d.store.close();
  });

  it('a frozen swap whose own lock dropped out is aborted (Z5), never claimed', async () => {
    const { w, d } = await live(FREEZE_A);
    const s = await noticedA(w, d, { watcher: seedSigner(new Uint8Array(32).fill(0x55)).publicKey });
    w.sim.warp(300);
    w.sim.watcherFreeze(s.pda);
    await d.executor.tick();
    // The operator backs out of the frozen swap: the flow aborts (Z5).
    const out = await d.executor.manual(s.pda, { abort: true });
    expect(out.instruction).toMatchObject({ action: 'abort', status: 'carried_out' });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.ABORTED_HOLD);
    expect(w.sim.secretSends).toEqual([]);
    d.store.close();
  });

  it('risk controls: a denied watcher, any watcher, or a taker frozen too often is refused before the fact (window mode)', async () => {
    const bad = seedSigner(new Uint8Array(32).fill(0x56)).publicKey;
    const good = seedSigner(new Uint8Array(32).fill(0x57)).publicKey;
    const WINDOW = sell('freeze_window_hours = 24\napproval_mode = "window"');
    const open = (w: World, watcher?: string) => w.sim.open({ direction: 0, mode: 1, xmr: XMR, wZ: 86_400, ...(watcher ? { watcher } : {}) });
    {
      const { w, d } = await live(`${WINDOW}\n[approvals]\ndeny_watchers = ["${bad}"]\n`);
      const denied = open(w, bad);
      const fine = open(w, good);
      await d.executor.scan();
      const decision = await d.approvals.decide(viewOf(w.sim, denied.pda), d.store.swap(denied.pda)!, d.config.offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr'));
      expect(decision).toMatchObject({ recommendation: 'reject', reasons: ['the watcher the lock names is on the deny list'] });
      await d.executor.tick();
      expect(names(w, denied.pda)).toEqual(['lock', 'reject']);
      expect(w.sim.landed.find((l) => l.swap === denied.pda && l.name === 'reject')!.args['reason']).toBe(REJECT_REASON.MAKER_CHOICE);
      expect(names(w, fine.pda)).toContain('approve');
      d.store.close();
    }
    {
      const { w, d } = await live(`${WINDOW}\n[approvals]\nrefuse_watchers = true\n`);
      const named = open(w, good);
      const plain = open(w);
      await d.executor.tick();
      expect(names(w, named.pda)).toEqual(['lock', 'reject']);
      expect(names(w, plain.pda)).toContain('approve');
      d.store.close();
    }
    {
      const { w, d } = await live(`${WINDOW}\n[approvals]\nmax_taker_freezes = 1\n`);
      const first = open(w, good);
      await d.executor.tick();
      w.xmr.mine(2);
      w.sim.warp(120);
      w.sim.watcherFreeze(first.pda);
      await d.executor.tick();
      expect(d.store.takerFreezes(w.sim.taker)).toBe(1);
      const second = open(w, good);
      await d.executor.scan();
      expect((await d.approvals.decide(viewOf(w.sim, second.pda), d.store.swap(second.pda)!, d.config.offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr'))).reasons).toEqual(["this taker's swaps were paused 1 time (the limit is 1)"]);
      await d.executor.tick();
      expect(names(w, second.pda)).toEqual(['lock', 'reject']);
      d.store.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ freeze, as the locker

const watcherToml = (wt: FakeWatcher, window = 24): string => `${buy(`freeze_window_hours = ${window}\ndeposit_pct = 1`)}\n[watcher]\nurl = "http://watcher.test"\nsolana_key = "${wt.solana}"\nretry_seconds = 1\n`;
/** A world with a maker watcher: the fake service is reached through the injected fetch. */
async function withWatcher(window = 24, tweak: (wt: FakeWatcher) => void = () => {}): Promise<{ w: World; d: Daemon; wt: FakeWatcher }> {
  const w = await makeWorld(BASE_TOML);
  const wt = new FakeWatcher(w.sim);
  tweak(wt);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(w.configPath, watcherToml(wt, window).replaceAll('__OWNER__', w.sim.owner));
  usdc(w, 1_000_000_000_000n);
  const d = await w.boot({ watcherFetch: wt.fetch });
  await d.start();
  return { w, d, wt };
}
const takeB = (w: World, wZ = 86_400, extra: { payout?: string } = {}) => w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ, ...extra });
/** The taker's notice for a lock at the joint address; `relay` false = it names a transaction nobody ever sees. */
function postNotice(w: World, s: OpenedSwap, opts: { amount?: bigint; ghost?: boolean } = {}): string {
  const view = viewOf(w.sim, s.pda);
  const joint = swapJointAddress(view, s.keys.view, 'regtest');
  const txid = opts.ghost ? 'ab'.repeat(32) : w.xmr.external(joint.address, opts.amount ?? view.xmr);
  const notice = buildNotice(view, s.keys.encSecret, Uint8Array.from(Buffer.from(txid, 'hex')), s.keys.view);
  w.sim.takerCall(s.pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
  return txid;
}

describe('freeze as the locker: buy-XMR offers and the maker watcher (SPEC 11.6 "Sell direction")', () => {
  it('names the watcher at fund, hands the swap over with the sealed notice key, and records the signed acknowledgement', async () => {
    const { w, d, wt } = await withWatcher();
    expect(w.sim.offer(1, 1)!.wZ).toBe(86_400);
    const s = takeB(w);
    await d.executor.tick();
    const fund = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'fund')!;
    expect(fund.args['watcher']).toBe(wt.solana);
    expect(w.sim.swap(s.pda)).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: wt.solana });
    // The fund must be final before the service would accept the swap: the registration follows on the next pass.
    await d.executor.tick();
    const ack = d.store.watchAck(s.pda)!;
    expect(ack).toMatchObject({ chain: 'solana', watcher: wt.solana });
    expect(verifyWatchAck({ swap_ref: Buffer.from(new PublicKey(s.pda).toBytes()).toString('hex'), watching_until: ack.watching_until, sig: ack.sig }, { chain: 'solana', swapRef: new PublicKey(s.pda).toBytes(), watcherSolanaKey: wt.solana })).toBe(true);
    // What the watcher received opens, with ITS key, to this swap's notice key and nothing else.
    expect(Buffer.from(wt.keys.get(s.pda)!).toString('hex')).toBe(Buffer.from(noticeKey(viewOf(w.sim, s.pda), ENC_SECRET_V1)).toString('hex'));
    expect(wt.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(d.store.intents({ swapRef: s.pda }).map((i) => `${i.kind}:${String(i.payload['call'])}:${i.status}`)).toEqual(['sol_tx:fund:confirmed', 'watch_register:watch_register:confirmed']);
    // Once is enough: later passes do not ask again.
    await d.executor.tick();
    expect(wt.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    // Shown: the status, the swap's extras, and the acknowledgement itself.
    await d.watcher.probe();
    expect((await d.status()).watcher).toMatchObject({ url: 'http://watcher.test', reachable: true, solana: wt.solana, ethereum: null, watching: 1 });
    expect(swapSummary(d.store.swap(s.pda)!, Number(w.sim.now), d.store).extras).toEqual({ payout: null, watcher: wt.solana, freeze_window_secs: 86_400, watching_until: ack.watching_until });
    d.store.close();
  });

  it('names no watcher on a swap without a freeze window, and none when no watcher is configured', async () => {
    const { w, d, wt } = await withWatcher(0);
    const s = takeB(w, 0);
    await d.executor.tick();
    await d.executor.tick();
    expect(w.sim.landed.find((l) => l.swap === s.pda && l.name === 'fund')!.args['watcher']).toBeNull();
    expect(w.sim.swap(s.pda)!.watcher).toBe('11111111111111111111111111111111');
    expect(wt.requests).toEqual([]);
    d.store.close();
    const plain = await live(buy('freeze_window_hours = 24'));
    const t = takeB(plain.w);
    await plain.d.executor.tick();
    expect(plain.w.sim.landed.find((l) => l.swap === t.pda && l.name === 'fund')!.args['watcher']).toBeNull();
    plain.d.store.close();
  });

  it('a watcher that is down or impersonated never blocks the swap: funded anyway, said plainly, tried again, and only a correctly signed acknowledgement counts', async () => {
    const { w, d, wt } = await withWatcher(24, (x) => (x.down = true));
    const s = takeB(w);
    await d.executor.tick();
    await d.executor.tick();
    expect(w.sim.swap(s.pda)).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: wt.solana });
    expect(d.store.watchAck(s.pda)).toBeUndefined();
    expect(d.alerts.list().find((a) => a.kind === 'watcher_not_watching')).toMatchObject({ level: 'warning', swap_ref: s.pda, message: expect.stringMatching(/is NOT watched/) });
    await d.watcher.probe();
    expect((await d.status()).watcher).toMatchObject({ reachable: false, watching: 0, last_error: expect.stringMatching(/unreachable/) });
    // It answers, but with a signature of another key: the swap is still not watched.
    wt.down = false;
    wt.wrongKey = true;
    await new Promise((r) => setTimeout(r, 1_100));
    await d.executor.tick();
    expect(d.store.watchAck(s.pda)).toBeUndefined();
    expect(d.store.intents({ swapRef: s.pda, kind: 'watch_register' }).every((i) => i.status === 'failed')).toBe(true);
    wt.wrongKey = false;
    await new Promise((r) => setTimeout(r, 1_100));
    await d.executor.tick();
    expect(d.store.watchAck(s.pda)).toMatchObject({ watcher: wt.solana });
    d.store.close();
  });

  it('the daemon itself freezes when the taker\'s lock is real but short of its depth near the cutoff; then sets ready (Z2) when it confirms', async () => {
    const { w, d } = await withWatcher();
    const s = takeB(w);
    await d.executor.tick();
    await d.executor.tick();
    postNotice(w, s); // in the pool, never mined yet
    const sw = w.sim.swap(s.pda)!;
    w.sim.setTime(sw.tCut - M - 1n);
    expect((await d.executor.tick()).get(s.pda)).toMatchObject({ kind: 'waiting', on: 'xmr-confirmations' });
    expect(names(w, s.pda)).not.toContain('freeze');
    // One margin before the cutoff the flow would soon give the escrow back: the daemon pauses instead (Z1, the SDK flow's call).
    w.sim.setTime(sw.tCut - M);
    await d.executor.tick();
    expect(names(w, s.pda)).toEqual(['take', 'fund', 'post_notice', 'freeze']);
    expect(d.store.intents({ swapRef: s.pda }).find((i) => i.payload['call'] === 'freeze')).toMatchObject({ status: 'confirmed', payload: expect.objectContaining({ row: 'Z1' }) });
    await d.executor.tick();
    expect(d.store.freeze(s.pda)).toMatchObject({ direction: 1, frozen_by: 'maker' });
    expect(d.store.takerFreezes(w.sim.taker)).toBe(0); // a maker-side pause is not the taker's
    // Past the old claim-open time the taker cannot claim without ready; the lock confirms and the daemon sets ready.
    w.sim.setTime(sw.tClaimOpen + 60n);
    expect(() => w.sim.takerCall(s.pda, { name: 'claim', secretOk: true }, { revealed: s.keys.spend })).toThrow('TooEarly');
    w.xmr.mine(3);
    await d.executor.tick();
    expect(names(w, s.pda)).toEqual(['take', 'fund', 'post_notice', 'freeze', 'set_ready']);
    expect(w.sim.secretSends).toEqual([]);
    d.store.close();
  });

  it('a provably bad lock is refunded, not paused; and a refund after a pause returns the take deposit at once: it is never held', async () => {
    // A notice that names a transaction paying too little: invalid. The flow refunds at the cutoff (B9d); no freeze is sent.
    const a = await withWatcher();
    const s1 = takeB(a.w);
    await a.d.executor.tick();
    await a.d.executor.tick();
    postNotice(a.w, s1, { amount: XMR });
    a.w.xmr.mine(3);
    a.w.sim.setTime(a.w.sim.swap(s1.pda)!.tCut - M);
    await a.d.executor.tick();
    expect(names(a.w, s1.pda)).not.toContain('freeze');
    a.w.sim.setTime(a.w.sim.swap(s1.pda)!.tCut);
    await a.d.executor.tick();
    expect(names(a.w, s1.pda)).toEqual(['take', 'fund', 'post_notice', 'refund']);
    a.d.store.close();

    // Paused by the daemon, and the lock never confirms: refunded with margin to spare before T_ff (Z3).
    const { w, d } = await withWatcher();
    const s = takeB(w);
    await d.executor.tick();
    await d.executor.tick();
    postNotice(w, s);
    const sw = w.sim.swap(s.pda)!;
    w.sim.setTime(sw.tCut - M);
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.FROZEN);
    const tFf = deadlinesOf('solana', viewOf(w.sim, s.pda)).tFf!;
    w.sim.setTime(tFf - 2n * M - 1n);
    expect((await d.executor.tick()).get(s.pda)).toMatchObject({ kind: 'waiting', on: 'xmr-confirmations', until: tFf - 2n * M });
    w.sim.setTime(tFf - 2n * M);
    await d.executor.tick();
    const refund = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'refund')!;
    expect(refund).toMatchObject({ stateBefore: SWAP_STATE.FROZEN, at: tFf - 2n * M });
    expect(d.store.intents({ swapRef: s.pda }).find((i) => i.payload['call'] === 'refund')!.payload['row']).toBe('Z3');
    // Straight to DONE: the deposit went back with the refund, there is no hold and nothing to withhold.
    await d.executor.tick();
    expect(w.sim.swap(s.pda)?.state ?? SWAP_STATE.DONE).toBe(SWAP_STATE.DONE);
    expect(w.sim.maker().counters[COUNTER.backouts_after_freeze]).toBe(1);
    expect(names(w, s.pda)).not.toContain('withhold');
    expect(w.sim.secretSends.every((x) => x.name === 'refund' && x.state === SWAP_STATE.FROZEN)).toBe(true);
    expect(d.store.swap(s.pda)).toMatchObject({ terminal: 1 });
    d.store.close();
  });

  it('an acknowledgement that ends before the swap\'s claim-open time is flagged', async () => {
    const { w, d, wt } = await withWatcher(24, (x) => (x.watchingUntil = (now) => now + 60n));
    const s = takeB(w);
    await d.executor.tick();
    await d.executor.tick();
    expect(d.store.watchAck(s.pda)).toBeDefined();
    postNotice(w, s);
    await d.executor.tick();
    expect(d.alerts.list().find((a) => a.kind === 'watcher_stops_early')).toMatchObject({ level: 'warning', swap_ref: s.pda });
    void wt;
    d.store.close();
  });
});

// ------------------------------------------------------------------------------------------------ payout

describe('payout address (SPEC 11.2)', () => {
  const fresh = seedSigner(new Uint8Array(32).fill(0x61)).publicKey;
  const fresh2 = seedSigner(new Uint8Array(32).fill(0x62)).publicKey;

  it('shows the payout address when it is not the taker\'s own, and keys limits on the taker, never on the payout', async () => {
    const { w, d } = await live(`${BASE_TOML.replace('[liquidity]', '[liquidity]\nmax_per_taker_xmr = 4')}`);
    const own = w.sim.open({ direction: 1, asset: 1, xmr: XMR });
    const other = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, payout: fresh });
    await d.executor.tick();
    expect(w.sim.swap(other.pda)).toMatchObject({ state: SWAP_STATE.ACTIVE, payout: fresh, taker: w.sim.taker });
    const now = Number(w.sim.now);
    expect(swapSummary(d.store.swap(own.pda)!, now, d.store).extras.payout).toBeNull();
    expect(swapSummary(d.store.swap(other.pda)!, now, d.store)).toMatchObject({ taker: w.sim.taker, extras: { payout: fresh, watcher: null, freeze_window_secs: 0 } });
    expect(d.store.swap(other.pda)!.taker).toBe(w.sim.taker);
    // The same wallet, another fresh payout address: the per-taker limit still counts it as the same taker.
    const third = w.sim.open({ direction: 1, asset: 1, xmr: XMR, payout: fresh2 });
    await d.executor.tick();
    expect(names(w, third.pda)).toEqual(['take']);
    expect(d.store.swap(third.pda)!.facts.approval).toEqual({ approve: false, reason: 0 });
    expect(d.risk.takerXmr(w.sim.taker)).toBe(4n * XMR);
    expect(d.risk.takerXmr(fresh)).toBe(0n);
    d.store.close();
  });

  it('claim proceeds parked for a payout address are delivered there by the operator, and nowhere else', async () => {
    const { w, d } = await live();
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, payout: fresh });
    await d.executor.tick();
    postNotice(w, s);
    w.xmr.mine(2);
    w.sim.warp(120);
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.READY);
    // The taker claims, but the payout address cannot receive: the proceeds are parked for it.
    w.sim.takerCall(s.pda, { name: 'claim', secretOk: true }, { revealed: s.keys.spend }, 'session', { payoutCanReceive: false });
    const parked = w.sim.swap(s.pda)!;
    expect(parked.owedTaker > 0n).toBe(true);
    w.xmr.mine(10);
    await d.executor.tick();
    // The daemon's own business is done (the XMR is swept); the account stays open because something is owed.
    expect(d.store.swap(s.pda)).toMatchObject({ swept: 1 });
    expect(w.sim.swap(s.pda)).not.toBeNull();
    const txs = await d.deliverOwed(viewOf(w.sim, s.pda), s.pda);
    expect(txs).toEqual([{ chain: 'solana', id: expect.any(String), status: 'sent' }]);
    const delivered = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'withdraw_owed')!;
    expect(delivered.args['who']).toBe(0);
    expect(w.sim.swap(s.pda)?.owedTaker ?? 0n).toBe(0n);
    // The instruction names the swap's payout address in the 17-account form: Settle list + payout, payout_token, associated-token program.
    const wire = w.sim.fake.sent[w.sim.fake.sent.length - 1]!;
    const { Transaction } = await import('@solana/web3.js');
    const ix = Transaction.from(wire).instructions.find((i) => i.programId.toBase58() === w.sim.programId)!;
    expect(ix.keys).toHaveLength(17);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toContain(fresh);
    // Nothing more to deliver.
    expect(await d.deliverOwed({ ...viewOf(w.sim, s.pda), owedTaker: 0n }, s.pda)).toEqual([]);
    d.store.close();
  });
});

// ------------------------------------------------------------------------------------------------ fee figures

describe('fee figures after Amendment 1', () => {
  it('per-swap cost: the measured compute units of the operator\'s calls, what a taker\'s open needs, and Ethereum gas', async () => {
    const r = loadConfig(BASE_TOML.replace('[solana]', '[solana]\npriority_fee_microlamports = 1000').replace('__OWNER__', seedSigner(new Uint8Array(32).fill(2)).publicKey));
    const c = swapCosts(r.config!.raw);
    expect(c.taker_open_compute_units).toEqual({ lock_or_take: 80_000, usdc_with_approval: 100_000 });
    // SOL, sell XMR: post_notice 16,000 + claim 27,000 + close_swap 18,000; three transactions.
    expect(c.solana.sol.sell_xmr.compute_units).toBe(61_000);
    expect(c.solana.sol.sell_xmr.lamports).toBe(String(3 * 5_000 + Math.ceil(16_000 * 1.2 * 0.001) + Math.ceil(27_000 * 1.2 * 0.001) + Math.ceil(18_000 * 1.2 * 0.001)));
    // USDC, buy XMR: fund 31,000 + set_ready 16,000 + close_swap 23,000.
    expect(c.solana.usdc_sol.buy_xmr.compute_units).toBe(70_000);
    expect(SOLANA_CU['fund']).toEqual({ sol: 27_000, usdc: 31_000 });
    expect(solanaCallFee(r.config!.raw, 'fund', true)).toBe(5_000n + BigInt(Math.ceil(31_000 * 1.2 * 0.001)));
    expect(c.ethereum).toMatchObject({ buy_xmr_gas: String(198_400 + 65_600), freeze_gas: '78600', push_owed_gas: '74300', max_fee_gwei: null, sell_xmr_wei: null });
    const capped = swapCosts(loadConfig(`${BASE_TOML.replace('__OWNER__', seedSigner(new Uint8Array(32).fill(2)).publicKey)}\n[ethereum]\nmax_fee_gwei = 20\n`).config!.raw);
    expect(capped.ethereum.buy_xmr_wei).toBe(String(264_000n * 20_000_000_000n));
  });

  it('a swap\'s Solana fees are recorded with the priority fee on the call\'s compute units, and the runway counts swaps as well as offer updates', async () => {
    const { w, d } = await live(BASE_TOML.replace('rpc_url_env = "TEST_SOL_RPC"', 'rpc_url_env = "TEST_SOL_RPC"\npriority_fee_microlamports = 1000000'));
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    await d.executor.tick();
    await d.executor.tick();
    const fees = d.store.feesSince(0).filter((f) => ['post_notice', 'claim'].includes(f.kind));
    expect(fees.map((f) => [f.kind, f.amount])).toEqual([['post_notice', String(5_000 + 16_000 * 1.2)], ['claim', String(5_000 + 27_000 * 1.2)]]);
    // One fill in the last day: the daily swap cost is one window-mode sell (the dearest ordinary variant).
    expect(d.dailySwapLamports()).toBe(BigInt(swapCosts(d.config.raw).solana.sol.sell_xmr_window.lamports));
    d.store.close();
  });
});
