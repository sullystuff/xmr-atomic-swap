/**
 * The large-swap router's planning function (SPEC 8.6). Pure: offers and the order in, a plan
 * out. It opens nothing and holds no key; each leg it plans is an ordinary direction-A swap
 * with its own nonce, keys and joint address, so a failed leg never affects another.
 *
 *  1. Drop offers that fail the taker's filters: depth below the depth required for the total
 *     in flight, approval window over the user's limit, maker fault or withhold rate over the
 *     user's limit.
 *  2. Fill greedily from the best effective rate (price plus expected deposit cost), respecting
 *     each offer's `max_xmr` and `capacity_xmr`, never more than one leg per maker per wave.
 *  3. Stop at the worst acceptable rate.
 *  4. Group each wave's legs into transactions (SPEC 4.10 batching).
 */
import { type ChainName, PICONERO_PER_XMR, takerDepthFor } from '@xmrswap/protocol';
import { SWAP_STATE } from '@xmrswap/protocol';
import type { SwapView } from '../machine/view.js';
import { endedInClaim, endedInRefund } from '../machine/view.js';
import { type Pricing } from '../registry/pricing.js';
import { packLegs } from '../solana/tx.js';

/** An offer or public quote as the router sees it. `price(xmr)` is the caller's `priceOffer` / `priceEthQuote`; it throws for a size the offer does not accept. */
export interface RouterOffer {
  /** Stable id of the offer (account address, or maker + quote id). */
  id: string;
  /** Identity of the maker: one leg per maker per wave. Use the merged identity's key. */
  makerId: string;
  chain: ChainName;
  /** Solana asset: 0 SOL, 1 USDC. Ignored on Ethereum. */
  asset: number;
  minXmr: bigint;
  maxXmr: bigint;
  /** Remaining capacity; `maxXmr` where the chain has none. */
  capacityXmr: bigint;
  /** Approval mode: 0 auto, 1 window, 2 advance. */
  mode: number;
  /** `W_a` in seconds. */
  approvalWindow: number;
  depBps: number;
  /** The maker's withhold rate, 0..1; `null` = no history (counted as 1: the deposit is assumed lost on a refund). */
  withholdRate: number | null;
  /** Provable faults relative to completed swaps, 0..∞; `null` = no completed swap. */
  faultRate: number | null;
  /** The taker holds a valid advance approval for this maker (needed for mode 2; turns mode 1 into auto). */
  hasApproval?: boolean;
  price(xmr: bigint): Pricing;
}

export interface RouterOrder {
  /** Total to spend, in the paying asset's base units. */
  totalPay: bigint;
  /** Worst acceptable rate: the highest price (base units per 1 XMR) the taker will pay on any leg. */
  worstPrice: bigint;
  /** Maximum in-flight exposure, in the paying asset's base units: the cap on one wave. */
  maxInFlight: bigint;
  /** Chain time after which no new wave is opened. */
  deadline: bigint;
  /** Reference price for the blended-rate comparison (base units per 1 XMR). */
  referencePrice?: bigint;
  filters?: {
    /** Offers with a longer approval window are dropped (pending funds may be held that long). */
    maxApprovalWindow?: number;
    maxFaultRate?: number;
    maxWithholdRate?: number;
    /** The user's own minimum depth; raises the `TAKER_DEPTH_TIERS` requirement, never lowers it. */
    minDepth?: number;
  };
  /** Use the protocol lookup table to put two USDC legs in one transaction. */
  lookupTable?: boolean;
  /** Stop after this many waves (default 16). */
  maxWaves?: number;
}

export interface PlannedLeg {
  offerId: string;
  makerId: string;
  xmr: bigint;
  /** What the taker pays for this leg (`max_pay` of the lock). */
  pay: bigint;
  price: bigint;
  depth: number;
  deposit: bigint;
  /** The leg starts PENDING and may wait this long for approval. */
  pendingSecs: number;
  /** The leg presents an advance approval and therefore travels alone. */
  approval: boolean;
}

export interface PlannedWave {
  legs: PlannedLeg[];
  /** Leg indices grouped into transactions (two SOL legs per legacy transaction, one USDC leg, one per leg on Ethereum). */
  transactions: number[][];
  pay: bigint;
  xmr: bigint;
  /** Depth the taker requires for this wave's total in flight. */
  requiredDepth: number;
  /** Rough expectation, for display only. */
  expectedSecs: number;
}

export type DropReason = 'approval-required' | 'approval-window' | 'fault-rate' | 'withhold-rate' | 'depth' | 'worse-than-limit' | 'below-minimum';

export interface RoutePlan {
  waves: PlannedWave[];
  filledPay: bigint;
  filledXmr: bigint;
  /** What the plan could not place, in the paying asset. */
  unfilledPay: bigint;
  /** Blended price over every leg (base units per 1 XMR, rounded up), or `null` for an empty plan. */
  blendedPrice: bigint | null;
  /** Blended price against the reference, in basis points (positive = dearer), or `null`. */
  vsReferenceBps: number | null;
  expectedSecs: number;
  /** Offers that took no part, and why. */
  dropped: { offerId: string; reason: DropReason }[];
}

/** Average Monero block time, for the duration estimate only. */
const XMR_BLOCK_SECS = 120;
const BPS = 10_000n;

/** Effective rate for ranking: price plus the expected deposit cost (`dep_bps` × the chance it is withheld). Scaled by 10^8. */
function effectiveRate(o: RouterOffer, price: bigint): bigint {
  const w = BigInt(Math.round(Math.min(1, Math.max(0, o.withholdRate ?? 1)) * 10_000));
  return price * (BPS * BPS + BigInt(o.depBps) * w);
}

/** The largest size (piconero) whose cost is at most `budget` at `price`: `payAmount` rounds up, so step down until it fits. */
function affordable(o: RouterOffer, budget: bigint, cap: bigint): { xmr: bigint; pricing: Pricing } | null {
  let xmr = cap;
  for (let i = 0; i < 8 && xmr >= o.minXmr && xmr > 0n; i++) {
    let pricing: Pricing;
    try {
      pricing = o.price(xmr);
    } catch {
      return null;
    }
    if (pricing.amount <= budget) return { xmr, pricing };
    // Size that the budget buys at this tier's price; one piconero less absorbs the ceiling.
    const fit = (budget * PICONERO_PER_XMR) / pricing.price;
    xmr = fit < xmr ? fit : xmr - 1n;
  }
  return null;
}

/**
 * Plan an order against a snapshot of offers. Deterministic: equal rates are broken by offer
 * id. Capacity consumed by an earlier wave is not available to a later one.
 */
export function planRoute(order: RouterOrder, offers: readonly RouterOffer[]): RoutePlan {
  const f = order.filters ?? {};
  const dropped: { offerId: string; reason: DropReason }[] = [];
  const usable: RouterOffer[] = [];
  for (const o of offers) {
    const reason: DropReason | null =
      o.mode === 2 && !o.hasApproval ? 'approval-required'
      : f.maxApprovalWindow !== undefined && o.mode === 1 && !o.hasApproval && o.approvalWindow > f.maxApprovalWindow ? 'approval-window'
      : f.maxFaultRate !== undefined && (o.faultRate ?? 0) > f.maxFaultRate ? 'fault-rate'
      : f.maxWithholdRate !== undefined && (o.withholdRate ?? 0) > f.maxWithholdRate ? 'withhold-rate'
      : null;
    if (reason) dropped.push({ offerId: o.id, reason });
    else usable.push(o);
  }

  // Capacity is consumed across waves; `max_xmr` caps each leg.
  const capacity = new Map(usable.map((o) => [o.id, o.capacityXmr]));
  const waves: PlannedWave[] = [];
  let remaining = order.totalPay;
  const maxWaves = order.maxWaves ?? 16;
  const noted = new Set(dropped.map((d) => d.offerId));
  const note = (offerId: string, reason: DropReason) => {
    if (!noted.has(offerId)) {
      noted.add(offerId);
      dropped.push({ offerId, reason });
    }
  };

  while (remaining > 0n && waves.length < maxWaves) {
    // A wave is re-planned until every leg's depth meets the requirement for the wave's total.
    const excluded = new Set<string>();
    let legs: PlannedLeg[] = [];
    let requiredDepth = 0;
    for (;;) {
      legs = planWave(order, usable, capacity, remaining, excluded, note);
      const totalXmr = legs.reduce((s, l) => s + l.xmr, 0n);
      requiredDepth = Math.max(takerDepthFor(totalXmr), f.minDepth ?? 0);
      const shallow = legs.filter((l) => l.depth < requiredDepth);
      if (shallow.length === 0) break;
      for (const l of shallow) {
        excluded.add(l.offerId);
        note(l.offerId, 'depth');
      }
    }
    if (legs.length === 0) break;
    const byId = new Map(usable.map((o) => [o.id, o]));
    for (const l of legs) capacity.set(l.offerId, capacity.get(l.offerId)! - l.xmr);
    const pay = legs.reduce((s, l) => s + l.pay, 0n);
    remaining -= pay;
    // One transaction per leg on Ethereum; SPEC 4.10 batching on Solana.
    const shapes = legs.map((l) => {
      const o = byId.get(l.offerId)!;
      return o.chain === 'ethereum' ? { asset: 1, approval: true } : { asset: o.asset, approval: l.approval };
    });
    const transactions = packLegs(shapes, order.lookupTable ? { lookupTable: true } : {});
    waves.push({
      legs,
      transactions,
      pay,
      xmr: legs.reduce((s, l) => s + l.xmr, 0n),
      requiredDepth,
      expectedSecs: Math.max(...legs.map((l) => l.pendingSecs + (l.depth + 1) * XMR_BLOCK_SECS)),
    });
  }

  const filledPay = order.totalPay - remaining;
  const filledXmr = waves.reduce((s, w) => s + w.xmr, 0n);
  const blendedPrice = filledXmr > 0n ? (filledPay * PICONERO_PER_XMR + filledXmr - 1n) / filledXmr : null;
  const vsReferenceBps = blendedPrice !== null && order.referencePrice ? Number(((blendedPrice - order.referencePrice) * BPS) / order.referencePrice) : null;
  // "Dropped" means took no part: an offer used in one wave and exhausted in the next is not listed.
  const used = new Set(waves.flatMap((w) => w.legs.map((l) => l.offerId)));
  return { waves, filledPay, filledXmr, unfilledPay: remaining, blendedPrice, vsReferenceBps, expectedSecs: waves.reduce((s, w) => s + w.expectedSecs, 0), dropped: dropped.filter((d) => !used.has(d.offerId)) };
}

function planWave(order: RouterOrder, offers: readonly RouterOffer[], capacity: ReadonlyMap<string, bigint>, remaining: bigint, excluded: ReadonlySet<string>, note: (offerId: string, reason: DropReason) => void): PlannedLeg[] {
  let budget = remaining < order.maxInFlight ? remaining : order.maxInFlight;
  const legs: PlannedLeg[] = [];
  const makers = new Set<string>();
  const left = offers.filter((o) => !excluded.has(o.id));
  while (budget > 0n) {
    // Re-rank on every pick: the size a budget buys, and so the tier price, changes as it shrinks.
    let best: { o: RouterOffer; xmr: bigint; pricing: Pricing; rate: bigint } | null = null;
    for (const o of left) {
      if (makers.has(o.makerId)) continue;
      const left = capacity.get(o.id)!;
      const cap = left < o.maxXmr ? left : o.maxXmr;
      if (cap < o.minXmr || cap <= 0n) continue;
      const fit = affordable(o, budget, cap);
      if (!fit) {
        note(o.id, 'below-minimum');
        continue;
      }
      if (fit.pricing.price > order.worstPrice) {
        note(o.id, 'worse-than-limit');
        continue;
      }
      const rate = effectiveRate(o, fit.pricing.price);
      if (!best || rate < best.rate || (rate === best.rate && o.id < best.o.id)) best = { o, ...fit, rate };
    }
    if (!best) break;
    const { o, xmr, pricing } = best;
    const approval = o.hasApproval === true && o.mode !== 0;
    const pending = o.chain === 'ethereum' || (o.mode === 1 && !approval);
    legs.push({ offerId: o.id, makerId: o.makerId, xmr, pay: pricing.amount, price: pricing.price, depth: pricing.depth, deposit: pricing.deposit, pendingSecs: pending ? o.approvalWindow : 0, approval });
    makers.add(o.makerId);
    budget -= pricing.amount;
  }
  return legs;
}

/** The order's deadline means: no new wave is opened after it. */
export const mayOpenWave = (order: Pick<RouterOrder, 'deadline'>, now: bigint): boolean => now <= order.deadline;

// ------------------------------------------------------------------ leg states (SPEC 8.6 table)

export type LegState = 'planned' | 'pending-approval' | 'locked' | 'xmr-seen' | 'ready' | 'claimed' | 'swept' | 'refunded';

/** The leg state the tool shows for an on-chain swap (`null` = not opened yet). */
export function legState(swap: SwapView | null, swept = false): LegState {
  if (!swap) return 'planned';
  switch (swap.state) {
    case SWAP_STATE.PENDING:
      return 'pending-approval';
    case SWAP_STATE.ACTIVE:
      return 'locked';
    case SWAP_STATE.NOTICED:
    case SWAP_STATE.ABORTED_FREE:
    case SWAP_STATE.ABORTED_HOLD:
      return 'xmr-seen';
    case SWAP_STATE.READY:
      return 'ready';
    case SWAP_STATE.HOLD:
    case SWAP_STATE.WITHHELD:
      return 'refunded';
    default:
      if (endedInClaim(swap)) return swept ? 'swept' : 'claimed';
      return endedInRefund(swap) || swap.state === SWAP_STATE.DONE || swap.state === SWAP_STATE.NONE ? 'refunded' : 'planned';
  }
}

/** A leg no longer counts against the in-flight cap. */
export const legSettled = (s: LegState): boolean => s === 'claimed' || s === 'swept' || s === 'refunded';

/** The final report: what was filled (legs that ended in a claim) and what was not, in the paying asset. */
export function routeReport(order: Pick<RouterOrder, 'totalPay'>, legs: readonly { pay: bigint; xmr: bigint; state: LegState }[]): { filledPay: bigint; filledXmr: bigint; refundedPay: bigint; inFlightPay: bigint; unfilledPay: bigint } {
  let filledPay = 0n;
  let filledXmr = 0n;
  let refundedPay = 0n;
  let inFlightPay = 0n;
  for (const l of legs) {
    if (l.state === 'claimed' || l.state === 'swept') {
      filledPay += l.pay;
      filledXmr += l.xmr;
    } else if (l.state === 'refunded') refundedPay += l.pay;
    else if (l.state !== 'planned') inFlightPay += l.pay;
  }
  return { filledPay, filledXmr, refundedPay, inFlightPay, unfilledPay: order.totalPay - filledPay - inFlightPay };
}
