/**
 * The beta caps (Amendment 1, SPEC 11.1) as a client sees them: read per asset, checked before
 * an open is built, and turned into the largest size a quote or a route may still use.
 *
 * Two different limits exist and the UI must not confuse them. A **maker limit** is the offer's
 * own `max_xmr` / `capacity_xmr` (`CapacityExceeded`, `AmountOutOfRange`): another maker may
 * still take the size. A **cap** is the deployment's (`SwapCapExceeded`, `OpenCapExceeded`): no
 * maker can take it until open value is freed or the admin raises the cap. `CapReached` is the
 * error for the second kind only.
 *
 * Only `lock` and `take` read a cap (invariant 3): nothing here ever applies to a call on an
 * existing swap.
 */
import { type AssetCaps, type Config, capsHeadroom, capsRefusal, countedValue } from '@xmrswap/protocol';
import { SdkError } from '../util.js';
import type { Pricing } from './pricing.js';

export type CapKind = 'SwapCapExceeded' | 'OpenCapExceeded';

/** An open that the deployment's caps refuse. `code` is the chain's own error name. */
export class CapReached extends SdkError {
  readonly kind: CapKind;
  /** What can still be opened in the asset: `max(0, max_open − open_value)`. */
  readonly headroom: bigint;
  /** The largest `amount` of one swap. */
  readonly maxSwap: bigint;
  constructor(kind: CapKind, caps: AssetCaps) {
    const headroom = capsHeadroom(caps) ?? 0n;
    super(kind, kind === 'SwapCapExceeded' ? `cap reached: one swap may be at most ${caps.maxSwap} base units during the beta` : `cap reached: ${headroom} base units of open value are left during the beta`);
    this.name = 'CapReached';
    this.kind = kind;
    this.headroom = headroom;
    this.maxSwap = caps.maxSwap;
  }
}
export const isCapReached = (e: unknown): e is CapReached => e instanceof CapReached;

/** Caps that refuse nothing: the switch is off. */
export const CAPS_OFF: AssetCaps = Object.freeze({ on: false, maxSwap: 0n, maxOpen: 0n, openValue: 0n });

/** The caps of one Solana asset (0 SOL, 1 USDC) from the `Config` account. */
export function solanaCaps(config: Pick<Config, 'capsOn' | 'maxSwap' | 'maxOpen' | 'openValue'>, asset: number): AssetCaps {
  if (asset !== 0 && asset !== 1) throw new SdkError('WrongAsset', 'a Solana asset is 0 (SOL) or 1 (USDC)');
  return { on: config.capsOn !== 0, maxSwap: config.maxSwap[asset]!, maxOpen: config.maxOpen[asset]!, openValue: config.openValue[asset]! };
}

/** Throw `CapReached` if `lock`/`take` of this amount would be refused by the caps. Exactly at a cap is allowed. */
export function assertUnderCaps(caps: AssetCaps, direction: number, amount: bigint, deposit: bigint): void {
  const refusal = capsRefusal(caps, direction === 0 ? 0 : 1, amount, deposit);
  if (refusal) throw new CapReached(refusal, caps);
}

/** What the caps leave for one more swap. `null` = the switch is off: no limit. */
export interface CapRoom {
  /** `max_swap`: bounds `amount`. */
  maxSwap: bigint;
  /** `max(0, max_open − open_value)`: bounds the counted value (`amount` in A, `amount + deposit` in B). */
  headroom: bigint;
}
export function capRoom(caps: AssetCaps): CapRoom | null {
  const headroom = capsHeadroom(caps);
  return headroom === null ? null : { maxSwap: caps.maxSwap, headroom };
}

/** The caps after a swap of this amount was opened (planning several legs against one snapshot). */
export function capsAfterOpen(caps: AssetCaps, direction: number, amount: bigint, deposit: bigint): AssetCaps {
  return { ...caps, openValue: caps.openValue + countedValue(direction === 0 ? 0 : 1, amount, deposit) };
}

/**
 * The largest size in `lo..hi` (piconero) whose swap the caps accept, with its pricing, or
 * `null` when not even `lo` fits. `price` is `priceOffer` / `priceEthQuote` bound to the offer;
 * it may throw for sizes the offer itself refuses. The search assumes the amount does not fall
 * as the size grows (true inside a price tier; across tiers the result is still a size that
 * fits, checked with the real pricing, though possibly not the very largest).
 */
export function largestUnderCaps(caps: AssetCaps, direction: number, price: (xmr: bigint) => Pricing, lo: bigint, hi: bigint): { xmr: bigint; pricing: Pricing } | null {
  const fits = (xmr: bigint): Pricing | null => {
    let p: Pricing;
    try {
      p = price(xmr);
    } catch {
      return null;
    }
    return capsRefusal(caps, direction === 0 ? 0 : 1, p.amount, p.deposit) === null ? p : null;
  };
  if (hi < lo) return null;
  const top = fits(hi);
  if (top) return { xmr: hi, pricing: top };
  let best = fits(lo);
  if (!best) return null;
  let a = lo;
  let b = hi;
  // Invariant: `a` fits, `b` does not.
  while (b - a > 1n) {
    const mid = (a + b) / 2n;
    const p = fits(mid);
    if (p) {
      a = mid;
      best = p;
    } else b = mid;
  }
  return { xmr: a, pricing: best };
}
