/**
 * Cost tracking (DESIGN "Safety controls"): every refill is logged with venue, rate, fees and
 * time, and the measured cost can feed the offer engine so the deviation covers it.
 */
import { appendFile } from 'node:fs/promises';
import type { AssetId, VenueId } from './types.js';

export interface CostLogEntry {
  id: string;
  venue: VenueId;
  from: AssetId;
  to: AssetId;
  /** Atomic units, decimal strings. */
  amountIn: string;
  amountOut: string | null;
  rateType: 'fixed' | 'float';
  /** Whole units of `to` received per whole unit of `from` paid; null when nothing arrived. */
  rate: number | null;
  /** Reference prices (USD per whole unit) when the refill started. */
  referenceUsd: { from: number; to: number };
  valueInUsd: number;
  quotedCostPct: number;
  quotedFeesUsd: number;
  /** Cost against the reference price measured from what actually arrived; null when nothing arrived. */
  measuredCostPct: number | null;
  measuredFeesUsd: number | null;
  /** Unix seconds. */
  startedAt: number;
  finishedAt: number;
  outcome: 'done' | 'failed' | 'refunded' | 'cancelled';
  testTransfer: boolean;
  txids: string[];
  detail: string | null;
}

export interface CostLog {
  append(entry: CostLogEntry): Promise<void>;
}

export class MemoryCostLog implements CostLog {
  readonly entries: CostLogEntry[] = [];
  async append(entry: CostLogEntry): Promise<void> { this.entries.push(entry); }
}

/** One JSON object per line. The daemon may instead write the entries to its database. */
export class JsonlCostLog implements CostLog {
  constructor(private readonly path: string) {}
  async append(entry: CostLogEntry): Promise<void> { await appendFile(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 }); }
}

/** Value-weighted measured cost of completed refills, in percent, for the offer engine. Null when there is nothing to measure. */
export function measuredCostPct(entries: readonly CostLogEntry[], opts: { since?: number; to?: AssetId; venue?: VenueId } = {}): number | null {
  let value = 0, cost = 0;
  for (const e of entries) {
    if (e.outcome !== 'done' || e.measuredCostPct === null) continue;
    if (opts.since !== undefined && e.finishedAt < opts.since) continue;
    if (opts.to !== undefined && e.to !== opts.to) continue;
    if (opts.venue !== undefined && e.venue !== opts.venue) continue;
    value += e.valueInUsd;
    cost += (e.valueInUsd * e.measuredCostPct) / 100;
  }
  return value > 0 ? (cost / value) * 100 : null;
}
