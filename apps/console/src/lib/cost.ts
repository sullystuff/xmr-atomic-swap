/**
 * Offer-update cost (DESIGN "Offer updates and daily cost", SPEC 8.1).
 *
 *   daily cost = 86,400 ÷ interval × (5,000 lamports + priority fee)
 *
 * One `refresh_offers` transaction covers every market, so the cost does not multiply by markets.
 * All money is bigint lamports; only the dollar figure and the day counts are numbers.
 */
import type { UpdateCostEstimate } from '@xmrswap/protocol/daemon-api';

export const BASE_FEE_LAMPORTS = 5_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SECONDS_PER_DAY = 86_400;
/**
 * Compute-unit limit assumed for one `refresh_offers` when turning the configured price
 * (`[solana].priority_fee_microlamports`, micro-lamports per compute unit) into lamports:
 * SPEC 4.9 measures 20,100 CU for four offers plus four Ethereum quotes and the SDK sets the
 * limit to simulation × 1.2. The daemon's own `lamports_per_update` replaces this when present.
 */
export const REFRESH_CU_LIMIT = 24_120;

/** Priority fee of one update in lamports, rounded up as the runtime does. */
export function priorityFeeLamports(microLamportsPerCu: number, cuLimit: number = REFRESH_CU_LIMIT): bigint {
  if (!Number.isFinite(microLamportsPerCu) || microLamportsPerCu <= 0) return 0n;
  const micro = BigInt(Math.round(microLamportsPerCu)) * BigInt(cuLimit);
  return (micro + 999_999n) / 1_000_000n;
}

export const lamportsPerUpdate = (priorityLamports: bigint): bigint => BASE_FEE_LAMPORTS + priorityLamports;

/** 86,400 ÷ interval. */
export function updatesPerDay(intervalSecs: number): number {
  if (!(intervalSecs > 0)) return 0;
  return SECONDS_PER_DAY / intervalSecs;
}

/** Daily cost in lamports, rounded up to a whole lamport. */
export function dailyCostLamports(intervalSecs: number, perUpdate: bigint): bigint {
  if (!(intervalSecs > 0)) return 0n;
  // Work in milliseconds so a fractional interval stays exact.
  const ms = BigInt(Math.round(intervalSecs * 1000));
  const num = BigInt(SECONDS_PER_DAY) * 1000n * perUpdate;
  return (num + ms - 1n) / ms;
}

export function lamportsToUsd(lamports: bigint, solUsd: number | null): number | null {
  if (solUsd === null || !Number.isFinite(solUsd)) return null;
  // Lamports fit a double exactly up to 2^53 (about 9 million SOL), far above any fee total.
  return (Number(lamports) / Number(LAMPORTS_PER_SOL)) * solUsd;
}

/** SOL price implied by a daemon estimate, so a draft can be priced before the daemon answers. */
export function impliedSolUsd(est: Pick<UpdateCostEstimate, 'daily_lamports' | 'daily_usd'> | null | undefined): number | null {
  if (!est || est.daily_usd === null) return null;
  const lamports = Number(est.daily_lamports);
  if (!(lamports > 0)) return null;
  return (est.daily_usd / lamports) * Number(LAMPORTS_PER_SOL);
}

/**
 * The SOL price and compute-unit figure to estimate with: the daemon's own (`sol_usd`,
 * `compute_units_per_update` on the fees and offers answers) when it sends them, otherwise the
 * price implied by its last estimate and the built-in compute-unit figure.
 */
export function costBasis(
  ...sources: ({ sol_usd?: number | null; compute_units_per_update?: number; estimate?: Pick<UpdateCostEstimate, 'daily_lamports' | 'daily_usd'> | null; update_cost?: Pick<UpdateCostEstimate, 'daily_lamports' | 'daily_usd'> | null } | null | undefined)[]
): { solUsd: number | null; cuLimit: number; fromDaemon: boolean } {
  let solUsd: number | null = null;
  let cuLimit: number | null = null;
  let fromDaemon = false;
  for (const s of sources) {
    if (!s) continue;
    if (solUsd === null && typeof s.sol_usd === 'number' && Number.isFinite(s.sol_usd) && s.sol_usd > 0) {
      solUsd = s.sol_usd;
      fromDaemon = true;
    }
    if (cuLimit === null && typeof s.compute_units_per_update === 'number' && s.compute_units_per_update > 0) cuLimit = s.compute_units_per_update;
  }
  if (solUsd === null) for (const s of sources) solUsd ??= impliedSolUsd(s?.estimate ?? s?.update_cost ?? null);
  return { solUsd, cuLimit: cuLimit ?? REFRESH_CU_LIMIT, fromDaemon };
}

/** Whole and fractional days of updates the fee wallet covers at this rate; `null` when nothing is spent. */
export function runwayDays(balanceLamports: bigint, dailyLamports: bigint): number | null {
  if (dailyLamports <= 0n) return null;
  return Number((balanceLamports * 100n) / dailyLamports) / 100;
}

export interface CostInputs {
  intervalSecs: number;
  priorityMicroLamports: number;
  /** `[offers].price_move_trigger_pct`; absent means every interval. */
  moveTriggerPct?: number | undefined;
  /** `[offers].min_refresh_interval_seconds`: the fastest a move-triggered update may repeat. */
  minRefreshSecs?: number | undefined;
  /** `[markets.*].offer_valid_seconds`, smallest among enabled offers: an idle offer must still be refreshed this often. */
  offerValidSecs?: number | undefined;
  /** Expected triggered updates per day, from the daemon's price history. */
  expectedTriggeredPerDay?: number | undefined;
  solUsd: number | null;
  /** Overrides the compute-unit assumption with the daemon's own figure. */
  perUpdateLamports?: bigint | undefined;
  /** Compute units the daemon charges an update at (`compute_units_per_update`); the built-in figure when absent. */
  cuLimit?: number | undefined;
}
export interface CostBreakdown {
  updatesPerDay: number;
  perUpdateLamports: bigint;
  priorityLamports: bigint;
  dailyLamports: bigint;
  dailyUsd: number | null;
  /** Present when a price-move trigger is set. */
  triggered: null | {
    /** Updates per day when the price never moves: only keep-alive refreshes inside the validity. */
    minPerDay: number;
    expectedPerDay: number | null;
    maxPerDay: number;
    minLamports: bigint;
    expectedLamports: bigint | null;
    maxLamports: bigint;
    expectedUsd: number | null;
    maxUsd: number | null;
  };
}

export function estimateCost(i: CostInputs): CostBreakdown {
  const priorityLamports = priorityFeeLamports(i.priorityMicroLamports, i.cuLimit ?? REFRESH_CU_LIMIT);
  const per = i.perUpdateLamports ?? lamportsPerUpdate(priorityLamports);
  const daily = dailyCostLamports(i.intervalSecs, per);
  let triggered: CostBreakdown['triggered'] = null;
  if (i.moveTriggerPct !== undefined && i.moveTriggerPct > 0) {
    // The price is checked every interval; an update can never repeat faster than the larger of
    // the interval and the minimum refresh interval.
    const fastest = Math.max(i.intervalSecs, i.minRefreshSecs ?? 0);
    const maxPerDay = updatesPerDay(fastest);
    const minPerDay = i.offerValidSecs && i.offerValidSecs > 0 ? Math.min(maxPerDay, updatesPerDay(i.offerValidSecs)) : 0;
    const expected = i.expectedTriggeredPerDay === undefined ? null : Math.min(maxPerDay, Math.max(minPerDay, i.expectedTriggeredPerDay));
    const cost = (n: number) => (per * BigInt(Math.ceil(n * 1000)) + 999n) / 1000n;
    const maxLamports = cost(maxPerDay);
    const expectedLamports = expected === null ? null : cost(expected);
    triggered = {
      minPerDay,
      expectedPerDay: expected,
      maxPerDay,
      minLamports: cost(minPerDay),
      expectedLamports,
      maxLamports,
      expectedUsd: expectedLamports === null ? null : lamportsToUsd(expectedLamports, i.solUsd),
      maxUsd: lamportsToUsd(maxLamports, i.solUsd),
    };
  }
  return {
    updatesPerDay: updatesPerDay(i.intervalSecs),
    perUpdateLamports: per,
    priorityLamports: per - BASE_FEE_LAMPORTS,
    dailyLamports: daily,
    dailyUsd: lamportsToUsd(daily, i.solUsd),
    triggered,
  };
}
