/**
 * The large-swap tool's order (SPEC 8.6). The order itself is not on-chain: it is a private
 * record (sealed, on this device) of what the user asked for and which legs were opened for it.
 * Every leg is an ordinary swap the engine tracks; this module only decides, from the legs'
 * states and the live offers, whether to open another wave, and writes the final report.
 *
 * Planning is `planRoute` of the SDK, never re-implemented here: edits by the user (a smaller
 * leg, a removed maker) and a stalled maker are expressed as changes to the router's input.
 */
import type { AssetCaps, Market } from '@xmrswap/protocol';
import { type LegState, type PlannedWave, type RoutePlan, type RouterOrder, legSettled, mayOpenWave, planRoute, routeReport } from '@xmrswap/sdk';
import { type OfferRow, routerOffer } from './market.js';
import type { WatcherNote } from './watcher.js';

export interface OrderLeg {
  offerId: string;
  makerPda: string;
  /** Piconero, decimal string. */
  xmr: string;
  /** Paying-asset base units the leg locks (its `max_pay`). */
  pay: string;
  price: string;
  depth: number;
  wave: number;
  /** The swap reference once the leg is open. */
  ref: string | null;
  /** Why the leg did not open (the wallet refused, the offer changed). */
  error?: string;
}

export interface Order {
  id: string;
  market: Market;
  totalPay: string;
  worstPrice: string;
  maxInFlight: string;
  /** Chain time after which no new wave is opened. */
  deadline: string;
  destination: string;
  referencePrice: string | null;
  minDepth: number;
  createdAt: number;
  legs: OrderLeg[];
  /** Makers left out of further planning: removed by the user, or a leg with them ended in a refund. */
  excluded: string[];
  /** Per-offer caps set by the user while editing the plan (piconero). */
  caps: Record<string, string>;
  /** The user stopped the order: legs in flight finish, nothing new opens. */
  stopped: boolean;
  /** The watcher the user chose for this order: named on every leg whose offer allows a pause that adds time. */
  watcher?: WatcherNote;
}

export const orderInput = (o: Order): RouterOrder => ({
  totalPay: BigInt(o.totalPay),
  worstPrice: BigInt(o.worstPrice),
  maxInFlight: BigInt(o.maxInFlight),
  deadline: BigInt(o.deadline),
  ...(o.referencePrice ? { referencePrice: BigInt(o.referencePrice) } : {}),
  filters: { ...(o.minDepth > 0 ? { minDepth: o.minDepth } : {}) },
});

/** Plan (or re-plan) `pay` of an order against the live offers, honouring the user's edits and exclusions. */
export function planOrder(o: Pick<Order, 'market' | 'worstPrice' | 'deadline' | 'referencePrice' | 'minDepth' | 'excluded' | 'caps'>, rows: readonly OfferRow[], pay: bigint, maxInFlight: bigint, busyMakers: ReadonlySet<string> = new Set(), protocolCaps?: AssetCaps): RoutePlan {
  const offers = rows
    .filter((r) => r.market === o.market && r.direction === 0 && r.problem === null && !o.excluded.includes(r.maker.pda) && !busyMakers.has(r.maker.pda))
    .map((r) => {
      // The protocol's beta caps bound every leg and the wave as a whole; the router reports what they keep out as `cap-reached`.
      const ro = routerOffer(r, protocolCaps);
      const cap = o.caps[r.id];
      return cap !== undefined && BigInt(cap) < ro.maxXmr ? { ...ro, maxXmr: BigInt(cap) } : ro;
    });
  return planRoute({ ...orderInput({ ...(o as Order), totalPay: pay.toString(), maxInFlight: maxInFlight.toString() }) }, offers);
}

export interface LegView extends OrderLeg {
  state: LegState;
}

/** The legs with their states: `planned` until opened, `refunded` for a leg that never opened. */
export function legViews(o: Order, stateOf: (ref: string) => LegState | undefined): LegView[] {
  return o.legs.map((l) => ({ ...l, state: l.ref ? (stateOf(l.ref) ?? 'locked') : l.error ? 'refunded' : 'planned' }));
}

export interface OrderProgress {
  legs: LegView[];
  report: ReturnType<typeof routeReport>;
  /** Paying-asset units still to be placed. */
  remainder: bigint;
  /** Units the in-flight cap still allows. */
  room: bigint;
  /** Nothing is in flight and nothing more can or should open. */
  finished: boolean;
  /** Why no further wave opens while a remainder exists. */
  stoppedBecause: 'deadline' | 'stopped' | 'no-offers' | 'protocol-cap' | null;
}

export function orderProgress(o: Order, stateOf: (ref: string) => LegState | undefined, now: bigint, nextWave: PlannedWave | null, capLimited = false): OrderProgress {
  const legs = legViews(o, stateOf);
  const live = legs.filter((l) => l.ref !== null);
  const report = routeReport({ totalPay: BigInt(o.totalPay) }, live.map((l) => ({ pay: BigInt(l.pay), xmr: BigInt(l.xmr), state: l.state })));
  const remainder = BigInt(o.totalPay) - report.filledPay - report.inFlightPay;
  const room = BigInt(o.maxInFlight) - report.inFlightPay;
  const inFlight = live.some((l) => !legSettled(l.state));
  const stoppedBecause = remainder <= 0n ? null : o.stopped ? 'stopped' : !mayOpenWave(orderInput(o), now) ? 'deadline' : nextWave === null ? (capLimited ? 'protocol-cap' : 'no-offers') : null;
  return { legs, report, remainder: remainder > 0n ? remainder : 0n, room: room > 0n ? room : 0n, finished: !inFlight && (remainder <= 0n || stoppedBecause !== null), stoppedBecause };
}

/**
 * The next wave to open, or `null`: the first wave of a fresh plan of the remainder within what
 * the in-flight cap still allows, leaving out makers that stalled, were removed, or already
 * have a leg in flight (never more than one leg per maker at a time).
 */
export function nextWave(o: Order, rows: readonly OfferRow[], stateOf: (ref: string) => LegState | undefined, now: bigint, protocolCaps?: AssetCaps): PlannedWave | null {
  if (o.stopped || !mayOpenWave(orderInput(o), now)) return null;
  const p = orderProgress(o, stateOf, now, null);
  if (p.remainder <= 0n || p.room <= 0n) return null;
  const busy = new Set(p.legs.filter((l) => l.ref !== null && !legSettled(l.state)).map((l) => l.makerPda));
  const pay = p.remainder < p.room ? p.remainder : p.room;
  const plan = planOrder(o, rows, pay, p.room, busy, protocolCaps);
  return plan.waves[0] ?? null;
}

/** Makers whose leg ended in a refund: they stalled (or were refunded from), and the remainder is re-planned without them. */
export function stalledMakers(o: Order, stateOf: (ref: string) => LegState | undefined): string[] {
  return [...new Set(legViews(o, stateOf).filter((l) => l.ref !== null && l.state === 'refunded').map((l) => l.makerPda))];
}

export const LEG_LABEL: Readonly<Record<LegState, string>> = {
  planned: 'Planned',
  'pending-approval': 'Pending approval',
  locked: 'Locked',
  'xmr-seen': 'XMR seen',
  ready: 'Ready',
  claimed: 'Claimed',
  swept: 'Swept',
  refunded: 'Refunded',
};
export const LEG_ORDER: readonly LegState[] = ['planned', 'pending-approval', 'locked', 'xmr-seen', 'ready', 'claimed', 'swept', 'refunded'];
