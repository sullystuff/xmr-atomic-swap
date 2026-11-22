import { describe, expect, it } from 'vitest';
import { BASE_FEE_LAMPORTS, REFRESH_CU_LIMIT, dailyCostLamports, estimateCost, impliedSolUsd, lamportsToUsd, priorityFeeLamports, runwayDays, updatesPerDay } from '../src/lib/cost.js';
import { fmtSol } from '../src/lib/format.js';

describe('offer-update cost (DESIGN "Offer updates and daily cost")', () => {
  // The rows of DESIGN's table, verbatim.
  const table: [interval: number, updates: number, sol: string][] = [
    [1, 86_400, '0.432 SOL'],
    [5, 17_280, '0.0864 SOL'],
    [10, 8_640, '0.0432 SOL'],
    [30, 2_880, '0.0144 SOL'],
    [60, 1_440, '0.0072 SOL'],
  ];
  it.each(table)('every %i s is %i updates and %s a day at the base fee', (interval, updates, solText) => {
    expect(updatesPerDay(interval)).toBe(updates);
    const daily = dailyCostLamports(interval, BASE_FEE_LAMPORTS);
    expect(daily).toBe(BigInt(updates) * 5_000n);
    expect(fmtSol(daily)).toBe(solText);
    expect(estimateCost({ intervalSecs: interval, priorityMicroLamports: 0, solUsd: null }).dailyLamports).toBe(daily);
  });

  it('adds the priority fee to every update', () => {
    // 10,000 micro-lamports per compute unit over the assumed limit, rounded up to a lamport.
    const p = priorityFeeLamports(10_000);
    expect(p).toBe(BigInt(Math.ceil((10_000 * REFRESH_CU_LIMIT) / 1e6)));
    expect(p).toBe(242n);
    const c = estimateCost({ intervalSecs: 15, priorityMicroLamports: 10_000, solUsd: 200 });
    expect(c.perUpdateLamports).toBe(5_242n);
    expect(c.updatesPerDay).toBe(5_760);
    expect(c.dailyLamports).toBe(5_760n * 5_242n);
    expect(c.dailyUsd).toBeCloseTo(((5_760 * 5_242) / 1e9) * 200, 9);
    expect(priorityFeeLamports(0)).toBe(0n);
    expect(priorityFeeLamports(1)).toBe(1n);
  });

  it('prefers the daemon’s own per-update figure when it has one', () => {
    const c = estimateCost({ intervalSecs: 60, priorityMicroLamports: 10_000, solUsd: null, perUpdateLamports: 6_000n });
    expect(c.dailyLamports).toBe(1_440n * 6_000n);
    expect(c.priorityLamports).toBe(1_000n);
    expect(c.dailyUsd).toBeNull();
  });

  it('rounds a non-dividing interval up to a whole lamport', () => {
    expect(dailyCostLamports(7, 5_000n)).toBe(61_714_286n);
    expect(dailyCostLamports(0, 5_000n)).toBe(0n);
  });

  it('gives the expected and maximum cost of move-triggered updates', () => {
    const c = estimateCost({ intervalSecs: 5, priorityMicroLamports: 0, moveTriggerPct: 0.25, minRefreshSecs: 30, offerValidSecs: 60, expectedTriggeredPerDay: 310, solUsd: 100 });
    expect(c.triggered).not.toBeNull();
    // Never faster than the minimum refresh interval: 2,880 a day at most.
    expect(c.triggered?.maxPerDay).toBe(2_880);
    expect(c.triggered?.maxLamports).toBe(14_400_000n);
    // Never slower than the offer validity: 1,440 keep-alive refreshes even when the price is still.
    expect(c.triggered?.minPerDay).toBe(1_440);
    expect(c.triggered?.expectedPerDay).toBe(1_440);
    expect(c.triggered?.expectedLamports).toBe(7_200_000n);
    expect(c.triggered?.maxUsd).toBeCloseTo(1.44, 9);
    // Without a trigger there is no range.
    expect(estimateCost({ intervalSecs: 5, priorityMicroLamports: 0, solUsd: 100 }).triggered).toBeNull();
    // Without a validity floor the expectation is the daemon's own.
    const d = estimateCost({ intervalSecs: 5, priorityMicroLamports: 0, moveTriggerPct: 0.25, expectedTriggeredPerDay: 310, solUsd: null });
    expect(d.triggered?.expectedPerDay).toBe(310);
    expect(d.triggered?.maxPerDay).toBe(17_280);
    expect(d.triggered?.expectedLamports).toBe(1_550_000n);
  });

  it('derives the runway and the dollar figure', () => {
    expect(runwayDays(2_400_000_000n, 28_800_000n)).toBeCloseTo(83.33, 2);
    expect(runwayDays(1n, 0n)).toBeNull();
    expect(lamportsToUsd(432_000_000n, 187.42)).toBeCloseTo(80.96544, 6);
    expect(lamportsToUsd(1n, null)).toBeNull();
    expect(impliedSolUsd({ daily_lamports: '432000000', daily_usd: 80.96544 })).toBeCloseTo(187.42, 6);
    expect(impliedSolUsd({ daily_lamports: '0', daily_usd: 0 })).toBeNull();
    expect(impliedSolUsd(null)).toBeNull();
  });
});
