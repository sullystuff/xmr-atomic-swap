// The large-swap router's planning function (SPEC 8.6).
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { type Offer, SWAP_FLAG, SWAP_STATE, takerDepthFor } from '@xmrswap/protocol';
import { NO_SWAP } from '../src/machine/model.js';
import type { SwapView } from '../src/machine/view.js';
import { priceOffer } from '../src/registry/pricing.js';
import { type RouterOffer, type RouterOrder, legSettled, legState, mayOpenWave, planRoute, routeReport } from '../src/router/plan.js';

beforeAll(async () => {
  await init();
});

const X = 10n ** 12n;
const SOL = 10n ** 9n;

/** A Solana direction-A offer priced through the real pricing function. */
function offer(id: string, o: { price: bigint | [bigint, bigint, bigint]; max?: bigint; cap?: bigint; min?: bigint; depths?: [number, number, number]; depBps?: number; mode?: number; wA?: number; withhold?: number | null; fault?: number | null; asset?: number; maker?: string; approval?: boolean; chain?: 'solana' | 'ethereum' }): RouterOffer {
  const prices = typeof o.price === 'bigint' ? [o.price, 0n, 0n] : o.price;
  const raw = { direction: 0, minXmr: o.min ?? X / 10n, maxXmr: o.max ?? 1000n * X, capacityXmr: o.cap ?? 1000n * X, priceAbove: [0n, X, 50n * X], prices, depthAbove: [0n, X, 50n * X], depths: Uint8Array.from(o.depths ?? [25, 25, 25]), depBps: o.depBps ?? 0 } as unknown as Offer;
  return {
    id,
    makerId: o.maker ?? id,
    chain: o.chain ?? 'solana',
    asset: o.asset ?? 0,
    minXmr: raw.minXmr,
    maxXmr: raw.maxXmr,
    capacityXmr: raw.capacityXmr,
    mode: o.mode ?? 0,
    approvalWindow: o.wA ?? 60,
    depBps: raw.depBps,
    withholdRate: o.withhold === undefined ? 0 : o.withhold,
    faultRate: o.fault === undefined ? 0 : o.fault,
    ...(o.approval ? { hasApproval: true } : {}),
    price: (xmr) => priceOffer(raw, xmr),
  };
}
const order = (over: Partial<RouterOrder> = {}): RouterOrder => ({ totalPay: 300n * SOL, worstPrice: 160n * SOL / 100n, maxInFlight: 1_000_000n * SOL, deadline: 1_800_100_000n, ...over });

describe('planRoute', () => {
  it('fills greedily from the best rate, one leg per maker per wave, respecting max and capacity', () => {
    // 1.50, 1.52 and 1.55 SOL per XMR; the best maker can take only 40 XMR at a time.
    const offers = [offer('b', { price: 152n * SOL / 100n }), offer('a', { price: 150n * SOL / 100n, max: 40n * X, cap: 60n * X }), offer('c', { price: 155n * SOL / 100n })];
    const plan = planRoute(order(), offers);
    const w1 = plan.waves[0]!;
    expect(w1.legs.map((l) => l.offerId)).toEqual(['a', 'b']);
    expect(w1.legs[0]).toMatchObject({ xmr: 40n * X, pay: 60n * SOL, price: 150n * SOL / 100n, depth: 25 });
    // The rest goes to the next best in the same wave: one leg per maker per wave.
    expect(w1.legs[1]!.pay).toBe(240n * SOL);
    expect(w1.legs[1]!.xmr).toBe((240n * SOL * X) / (152n * SOL / 100n));
    expect(plan.unfilledPay).toBe(0n);
    expect(plan.filledPay).toBe(300n * SOL);
    expect(plan.waves.length).toBe(1);
    expect(plan.dropped).toEqual([]);
    // No leg ever exceeds what it was asked to spend.
    expect(plan.waves.flatMap((w) => w.legs).every((l) => l.pay <= 300n * SOL)).toBe(true);
  });

  it('opens further waves within the in-flight cap and tracks capacity across them', () => {
    const offers = [offer('a', { price: 150n * SOL / 100n, max: 40n * X, cap: 60n * X }), offer('b', { price: 152n * SOL / 100n, max: 40n * X })];
    const plan = planRoute(order({ maxInFlight: 90n * SOL }), offers);
    expect(plan.waves.every((w) => w.pay <= 90n * SOL)).toBe(true);
    // Wave 1: a takes 40 XMR (60 SOL), b takes the remaining 30 SOL.
    expect(plan.waves[0]!.legs.map((l) => [l.offerId, l.pay])).toEqual([['a', 60n * SOL], ['b', 30n * SOL]]);
    // a has 20 XMR of capacity left for wave 2, then none.
    const aLegs = plan.waves.flatMap((w) => w.legs).filter((l) => l.offerId === 'a');
    expect(aLegs.map((l) => l.xmr)).toEqual([40n * X, 20n * X]);
    expect(aLegs.reduce((s, l) => s + l.xmr, 0n)).toBe(60n * X);
    expect(plan.waves.every((w) => new Set(w.legs.map((l) => l.makerId)).size === w.legs.length)).toBe(true);
    expect(plan.filledPay + plan.unfilledPay).toBe(300n * SOL);
    expect(plan.unfilledPay).toBe(0n);
    expect(plan.expectedSecs).toBe(plan.waves.reduce((s, w) => s + w.expectedSecs, 0));
  });

  it('stops at the worst acceptable rate and reports the remainder unfilled', () => {
    const offers = [offer('a', { price: 150n * SOL / 100n, max: 40n * X, cap: 40n * X }), offer('dear', { price: 161n * SOL / 100n })];
    const plan = planRoute(order(), offers);
    expect(plan.waves.flatMap((w) => w.legs).map((l) => l.offerId)).toEqual(['a']);
    expect(plan.filledPay).toBe(60n * SOL);
    expect(plan.unfilledPay).toBe(240n * SOL);
    expect(plan.dropped).toEqual([{ offerId: 'dear', reason: 'worse-than-limit' }]);
    // Exactly at the limit is acceptable.
    expect(planRoute(order({ worstPrice: 161n * SOL / 100n }), offers).unfilledPay).toBe(0n);
    // Nothing usable at all: an empty plan, not an error.
    const none = planRoute(order(), []);
    expect(none).toMatchObject({ waves: [], filledPay: 0n, unfilledPay: 300n * SOL, blendedPrice: null, vsReferenceBps: null });
  });

  it('ranks by effective rate: price plus the expected cost of the deposit', () => {
    // b is nominally cheaper, but 5% of every swap can be withheld and this maker always withholds.
    const offers = [offer('a', { price: 150n * SOL / 100n }), offer('b', { price: 149n * SOL / 100n, depBps: 500, withhold: 1 })];
    expect(planRoute(order(), offers).waves[0]!.legs[0]!.offerId).toBe('a');
    // The same deposit with a maker that never withholds costs nothing in expectation.
    const fair = [offer('a', { price: 150n * SOL / 100n }), offer('b', { price: 149n * SOL / 100n, depBps: 500, withhold: 0 })];
    expect(planRoute(order(), fair).waves[0]!.legs[0]!.offerId).toBe('b');
    // No history is treated as the worst case.
    const unknown = [offer('a', { price: 150n * SOL / 100n }), offer('b', { price: 149n * SOL / 100n, depBps: 500, withhold: null })];
    expect(planRoute(order(), unknown).waves[0]!.legs[0]!.offerId).toBe('a');
    // Equal rates: deterministic by id.
    const tie = [offer('z', { price: 150n * SOL / 100n }), offer('y', { price: 150n * SOL / 100n })];
    expect(planRoute(order(), tie).waves[0]!.legs[0]!.offerId).toBe('y');
  });

  it('drops offers that fail the taker\'s filters', () => {
    const offers = [
      offer('ok', { price: 155n * SOL / 100n }),
      offer('slow', { price: 150n * SOL / 100n, mode: 1, wA: 600 }),
      offer('faulty', { price: 150n * SOL / 100n, fault: 0.2 }),
      offer('withholder', { price: 150n * SOL / 100n, withhold: 0.9 }),
      offer('advance', { price: 150n * SOL / 100n, mode: 2 }),
    ];
    const plan = planRoute(order({ filters: { maxApprovalWindow: 60, maxFaultRate: 0.05, maxWithholdRate: 0.5 } }), offers);
    expect(plan.waves.flatMap((w) => w.legs).map((l) => l.offerId)).toEqual(['ok']);
    expect(Object.fromEntries(plan.dropped.map((d) => [d.offerId, d.reason]))).toEqual({ slow: 'approval-window', faulty: 'fault-rate', withholder: 'withhold-rate', advance: 'approval-required' });
    // With an advance approval in hand the window no longer matters and mode 2 is usable; such a leg travels alone.
    const withApproval = planRoute(order({ totalPay: 30n * SOL, filters: { maxApprovalWindow: 60 } }), [offer('advance', { price: 150n * SOL / 100n, mode: 2, approval: true }), offer('slow', { price: 151n * SOL / 100n, mode: 1, wA: 600, approval: true })]);
    expect(withApproval.waves[0]!.legs.map((l) => [l.offerId, l.approval, l.pendingSecs])).toEqual([['advance', true, 0]]);
    // A window-mode leg without an approval waits for approval and says for how long.
    const pending = planRoute(order({ totalPay: 30n * SOL }), [offer('slow', { price: 150n * SOL / 100n, mode: 1, wA: 45 })]);
    expect(pending.waves[0]!.legs[0]).toMatchObject({ pendingSecs: 45, approval: false });
  });

  it('requires the depth of the total in flight, not of each leg', () => {
    // 60 XMR in flight needs depth 25 from every leg (TAKER_DEPTH_TIERS), however small the leg.
    expect([takerDepthFor(X / 2n), takerDepthFor(X), takerDepthFor(50n * X)]).toEqual([2, 10, 25]);
    const shallow = offer('shallow', { price: 150n * SOL / 100n, max: 30n * X, depths: [2, 10, 10] });
    const deep = offer('deep', { price: 152n * SOL / 100n, max: 30n * X, depths: [25, 25, 25] });
    const deep2 = offer('deep2', { price: 153n * SOL / 100n, max: 30n * X, depths: [25, 25, 25] });
    const plan = planRoute(order({ totalPay: 91n * SOL }), [shallow, deep, deep2]);
    const w = plan.waves[0]!;
    expect(w.requiredDepth).toBe(25);
    expect(w.legs.every((l) => l.depth >= 25)).toBe(true);
    expect(w.legs.map((l) => l.offerId)).toEqual(['deep', 'deep2']);
    // Capped to under 50 XMR in flight, depth 10 is enough and the shallow offer is usable again.
    const capped = planRoute(order({ totalPay: 91n * SOL, maxInFlight: 60n * SOL }), [shallow, deep, deep2]);
    expect(capped.waves[0]!.requiredDepth).toBe(10);
    expect(capped.waves[0]!.legs[0]!.offerId).toBe('shallow');
    // The user can raise the requirement, never lower it.
    const raised = planRoute(order({ totalPay: 3n * SOL, filters: { minDepth: 25 } }), [shallow, deep]);
    expect(raised.waves[0]!.legs.map((l) => l.offerId)).toEqual(['deep']);
    expect(raised.dropped).toEqual([{ offerId: 'shallow', reason: 'depth' }]);
  });

  it('follows the size tiers: a leg is priced at the tier of its own size and never costs more than its budget', () => {
    // Cheaper above 50 XMR.
    const tiered = offer('tiered', { price: [152n * SOL / 100n, 151n * SOL / 100n, 150n * SOL / 100n] });
    const big = planRoute(order({ totalPay: 150n * SOL }), [tiered]);
    expect(big.waves[0]!.legs[0]).toMatchObject({ price: 150n * SOL / 100n, xmr: 100n * X, pay: 150n * SOL });
    const small = planRoute(order({ totalPay: SOL }), [tiered]);
    expect(small.waves[0]!.legs[0]!.price).toBe(152n * SOL / 100n);
    expect(small.waves[0]!.legs[0]!.pay <= SOL).toBe(true);
    // A budget that buys less than the offer's minimum places nothing.
    const tiny = planRoute(order({ totalPay: SOL / 100n }), [tiered]);
    expect(tiny.waves).toEqual([]);
    expect(tiny.dropped).toEqual([{ offerId: 'tiered', reason: 'below-minimum' }]);
  });

  it('groups each wave into transactions by the batching rule', () => {
    const sol = ['a', 'b', 'c'].map((id) => offer(id, { price: 150n * SOL / 100n, max: 10n * X, depths: [25, 25, 25] }));
    expect(planRoute(order({ totalPay: 45n * SOL }), sol).waves[0]!.transactions).toEqual([[0, 1], [2]]);
    const usdc = ['a', 'b', 'c'].map((id) => offer(id, { price: 150n * SOL / 100n, max: 10n * X, depths: [25, 25, 25], asset: 1 }));
    expect(planRoute(order({ totalPay: 45n * SOL }), usdc).waves[0]!.transactions).toEqual([[0], [1], [2]]);
    expect(planRoute(order({ totalPay: 45n * SOL, lookupTable: true }), usdc).waves[0]!.transactions).toEqual([[0, 1], [2]]);
    // One transaction per leg on Ethereum, and every Ethereum leg starts pending.
    const eth = ['a', 'b'].map((id) => offer(id, { price: 150n * SOL / 100n, max: 10n * X, depths: [25, 25, 25], chain: 'ethereum', wA: 120 }));
    const p = planRoute(order({ totalPay: 30n * SOL }), eth);
    expect(p.waves[0]!.transactions).toEqual([[0], [1]]);
    expect(p.waves[0]!.legs.every((l) => l.pendingSecs === 120)).toBe(true);
  });

  it('reports the blended rate against a reference', () => {
    const offers = [offer('a', { price: 150n * SOL / 100n, max: 40n * X, cap: 40n * X }), offer('b', { price: 153n * SOL / 100n })];
    const plan = planRoute(order({ totalPay: 120n * SOL, referencePrice: 150n * SOL / 100n }), offers);
    // 60 SOL at 1.50 and 60 SOL at 1.53.
    expect(plan.filledPay).toBe(120n * SOL);
    expect(plan.blendedPrice! > 150n * SOL / 100n && plan.blendedPrice! < 153n * SOL / 100n).toBe(true);
    expect(plan.blendedPrice).toBe((plan.filledPay * X + plan.filledXmr - 1n) / plan.filledXmr);
    expect(plan.vsReferenceBps).toBeGreaterThan(90);
    expect(plan.vsReferenceBps).toBeLessThan(110);
  });

  it('the deadline closes the order to new waves', () => {
    expect(mayOpenWave(order(), 1_800_100_000n)).toBe(true);
    expect(mayOpenWave(order(), 1_800_100_001n)).toBe(false);
  });
});

describe('leg states and the final report', () => {
  const leg = (state: number, flags = 0): SwapView => ({ ...NO_SWAP, state, flags } as unknown as SwapView);
  it('maps on-chain states to the table of SPEC 8.6', () => {
    expect(legState(null)).toBe('planned');
    expect(legState(leg(SWAP_STATE.PENDING))).toBe('pending-approval');
    expect(legState(leg(SWAP_STATE.ACTIVE))).toBe('locked');
    expect(legState(leg(SWAP_STATE.NOTICED))).toBe('xmr-seen');
    expect(legState(leg(SWAP_STATE.READY))).toBe('ready');
    expect(legState(leg(SWAP_STATE.DONE, SWAP_FLAG.REVEALED))).toBe('claimed');
    expect(legState(leg(SWAP_STATE.DONE, SWAP_FLAG.REVEALED), true)).toBe('swept');
    expect(legState(leg(SWAP_STATE.HOLD, SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER))).toBe('refunded');
    expect(legState(leg(SWAP_STATE.WITHHELD))).toBe('refunded');
    expect(legState(leg(SWAP_STATE.DONE, SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER))).toBe('refunded');
    // A keyless refund or a rejected pending lock closes with nothing revealed.
    expect(legState(leg(SWAP_STATE.DONE))).toBe('refunded');
    expect(['claimed', 'swept', 'refunded'].every((s) => legSettled(s as never))).toBe(true);
    expect(['planned', 'pending-approval', 'locked', 'xmr-seen', 'ready'].some((s) => legSettled(s as never))).toBe(false);
  });

  it('the report lists filled and unfilled amounts; a refunded leg goes back into the remainder for re-planning', () => {
    const legs = [{ pay: 60n, xmr: 40n, state: 'swept' as const }, { pay: 50n, xmr: 33n, state: 'claimed' as const }, { pay: 40n, xmr: 26n, state: 'refunded' as const }, { pay: 30n, xmr: 20n, state: 'ready' as const }, { pay: 20n, xmr: 13n, state: 'planned' as const }];
    const r = routeReport({ totalPay: 250n }, legs);
    expect(r).toEqual({ filledPay: 110n, filledXmr: 73n, refundedPay: 40n, inFlightPay: 30n, unfilledPay: 110n });
    // Re-plan the remainder after a maker stalled and its leg was refunded.
    const replanned = planRoute(order({ totalPay: r.unfilledPay * SOL }), [offer('other', { price: 150n * SOL / 100n })]);
    expect(replanned.filledPay).toBe(110n * SOL);
  });
});
