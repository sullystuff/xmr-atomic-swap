/**
 * DESIGN's formula, in one place:
 *
 *   offer price = reference price × (1 + deviation + size tier + inventory skew)
 *
 * added when the maker sells XMR, subtracted when it buys. Extra deviation from the guardrails
 * (`on_failure = "widen"`, `volatility_widen`) joins the same sum. Pure functions only.
 */
import { PICONERO_PER_XMR } from '@xmrswap/protocol';
import type { ResolvedOffer } from '../config/load.js';
import type { Reference } from '../pricing/engine.js';

/**
 * Inventory skew, percent, signed for the formula's own sign convention. Inventory below
 * target makes XMR scarce: selling gets dearer (positive extra) and buying pays more (the
 * subtracted deviation shrinks). Above target the opposite. Bounded by `maxPct`.
 */
export function inventorySkewPct(direction: 'sell_xmr' | 'buy_xmr', maxPct: number, inventory: number, target: number | null): number {
  if (!target || target <= 0 || maxPct === 0) return 0;
  const shortfall = Math.max(-1, Math.min(1, (target - inventory) / target));
  return direction === 'sell_xmr' ? maxPct * shortfall : -maxPct * shortfall;
}

/** `reference × (1 ± (deviation + tier + skew + widen) / 100)`, USD per XMR. */
export function offerPriceUsd(referenceUsd: number, direction: 'sell_xmr' | 'buy_xmr', parts: { deviationPct: number; tierPct?: number; skewPct?: number; widenPct?: number }): number {
  const sum = (parts.deviationPct + (parts.tierPct ?? 0) + (parts.skewPct ?? 0) + (parts.widenPct ?? 0)) / 100;
  return referenceUsd * (direction === 'sell_xmr' ? 1 + sum : 1 - sum);
}

/** USD per XMR to the on-chain price: asset base units per 1 XMR. Rounded in the maker's favour (up when selling, down when buying). */
export function toAssetUnits(priceUsd: number, assetUsd: number, decimals: number, direction: 'sell_xmr' | 'buy_xmr'): bigint {
  const exact = (priceUsd / assetUsd) * 10 ** decimals;
  if (!Number.isFinite(exact) || exact <= 0) return 0n;
  return BigInt(direction === 'sell_xmr' ? Math.ceil(exact) : Math.floor(exact));
}

export interface PricedOffer {
  /** Why the offer is off right now, or `null` when it can be published. */
  blocked: string | null;
  referenceUsd: number | null;
  /** Total deviation of tier 0, percent. */
  deviationPct: number;
  /** Up to three tiers: thresholds in piconero (tier 0 at 0) and prices in asset base units per XMR. */
  tierAbove: [bigint, bigint, bigint];
  tierPrice: [bigint, bigint, bigint];
  /** Tier prices in USD per XMR, for display and the price band. */
  tierUsd: number[];
}

/** Price one offer from its reference: every tier, the volatility widening and the hard price band. */
export function priceOffer(o: ResolvedOffer, ref: Reference, ctx: { inventoryXmr: number; targetXmr: number | null; band: { min: number; max: number } | null }): PricedOffer {
  const none: PricedOffer = { blocked: null, referenceUsd: ref.xmrUsd, deviationPct: o.deviationPct, tierAbove: [0n, 0n, 0n], tierPrice: [0n, 0n, 0n], tierUsd: [] };
  if (ref.xmrUsd === null || ref.assetUsd === null) return { ...none, blocked: 'no reference price' };
  if (ref.pausedBy.length > 0) return { ...none, blocked: `guardrail: ${ref.pausedBy.join(', ')}` };
  const skewPct = inventorySkewPct(o.direction, o.skewMaxPct, ctx.inventoryXmr, ctx.targetXmr);
  const volPct = o.volatilityWiden ? Math.min(o.volatilityWiden.maxPct, o.volatilityWiden.perPctMove * ref.movePct) : 0;
  const widenPct = ref.widenPct + volPct;
  const tiers = [{ aboveXmr: 0n, extraPct: 0 }, ...o.sizeTiers];
  const tierAbove: [bigint, bigint, bigint] = [0n, 0n, 0n];
  const tierPrice: [bigint, bigint, bigint] = [0n, 0n, 0n];
  const tierUsd: number[] = [];
  for (let i = 0; i < tiers.length; i++) {
    // A size tier is extra deviation above a swap size; it worsens the taker's price in both directions.
    const usd = offerPriceUsd(ref.xmrUsd, o.direction, { deviationPct: o.deviationPct, tierPct: tiers[i]!.extraPct, skewPct, widenPct });
    if (ctx.band && (usd < ctx.band.min || usd > ctx.band.max)) return { ...none, blocked: `guardrail: price_band (${usd.toFixed(2)} USD per XMR is outside ${ctx.band.min}..${ctx.band.max})` };
    const units = toAssetUnits(usd, ref.assetUsd, o.decimals, o.direction);
    if (units <= 0n) return { ...none, blocked: 'the computed price is not positive' };
    tierAbove[i] = tiers[i]!.aboveXmr;
    tierPrice[i] = units;
    tierUsd.push(usd);
  }
  return { blocked: null, referenceUsd: ref.xmrUsd, deviationPct: o.deviationPct + skewPct + widenPct, tierAbove, tierPrice, tierUsd };
}

/** XMR (piconero) that `units` of the paying asset buy at `price` (asset base units per XMR): the buy side's capacity from its paying cap. */
export const xmrForUnits = (units: bigint, price: bigint): bigint => (price === 0n ? 0n : (units * PICONERO_PER_XMR) / price);
