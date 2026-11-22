/**
 * Dashboard (DESIGN "Maker tools"; SPEC 7.1 `stats/`): fills, spread earned, abort and
 * withhold rates, missed deadlines, uptime, fee spend and the fee-wallet runway, from the
 * database and the on-chain counters.
 */
import { COUNTER, COUNTER_NAMES, type ChainName, type CounterName, FAULT_COUNTERS, type Market } from '@xmrswap/protocol';
import type { FeesResponse, StatsResponse, UpdateCostEstimate } from '@xmrswap/protocol/daemon-api';
import type { Store } from '../store/db.js';

export interface ChainCounters {
  chain: ChainName;
  counters: number[];
  responseSecsSum: bigint;
}

const get = (c: number[], name: CounterName): number => c[COUNTER[name]] ?? 0;
const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function statsView(store: Store, chains: ChainCounters[], since = 0): StatsResponse {
  const fills = store.fills(since);
  const byMarket = new Map<string, { xmr: bigint; asset: bigint }>();
  let spread = 0;
  let anySpread = false;
  for (const f of fills) {
    const m = byMarket.get(f.market) ?? { xmr: 0n, asset: 0n };
    m.xmr += BigInt(f.xmr);
    m.asset += BigInt(f.amount);
    byMarket.set(f.market, m);
    if (f.spread_usd !== null) {
      spread += f.spread_usd;
      anySpread = true;
    }
  }
  // Clients merge both chains into one history; so does the dashboard.
  const sum = (name: CounterName): number => chains.reduce((a, c) => a + get(c.counters, name), 0);
  const has = (name: string): name is CounterName => (COUNTER_NAMES as readonly string[]).includes(name);
  const s = (name: string): number => (has(name) ? sum(name) : 0);
  const approvals = s('approvals');
  const decided = approvals + s('rejections') + s('approval_timeouts');
  const started = s('locks') + s('takes');
  const aborts = s('aborts_pre_notice') + s('aborts_early') + s('aborts_late');
  const withheld = s('withholds');
  const responseSum = chains.reduce((a, c) => a + c.responseSecsSum, 0n);
  // One beat per minute while the daemon runs.
  const day = Math.floor(store.now() / 86_400);
  const beats = store.beats(day - 6);
  return {
    since, fills: fills.length,
    volume: [...byMarket].map(([market, v]) => ({ market: market as Market, xmr: v.xmr.toString(), asset: v.asset.toString() })),
    spread_earned_usd: anySpread ? spread : null,
    counters: chains.map((c) => ({ chain: c.chain, values: Object.fromEntries(COUNTER_NAMES.map((n, i) => [n, c.counters[i] ?? 0]).filter(([, v]) => v !== 0)) as Partial<Record<CounterName, number>> })),
    rates: {
      approval: ratio(approvals, decided), mean_response_secs: approvals > 0 ? Number(responseSum) / approvals : null, abort: ratio(aborts, started),
      withhold: ratio(withheld, withheld + s('deposits_returned')), unreleased: ratio(s('splits'), withheld),
    },
    missed_deadlines: FAULT_COUNTERS.reduce((a, n) => a + sum(n), 0),
    uptime_pct: beats === 0 ? null : Math.min(100, (beats / Math.min(7 * 1440, Math.max(1, Math.floor((store.now() - (Number(store.meta('first_start') ?? store.now()))) / 60)))) * 100),
  };
}

/**
 * Fee estimate, 24-hour actual and runway: how many days of offer updates the fee wallet
 * covers at the current rate (DESIGN "Offer updates and daily cost").
 */
export function feesView(store: Store, o: { estimate: UpdateCostEstimate | null; balances: FeesResponse['operator_balances']; usd: (asset: 'sol' | 'eth') => number | null; runwayAlertDays: number }): FeesResponse {
  const spent = new Map<string, bigint>();
  for (const f of store.feesSince(store.now() - 86_400)) spent.set(f.asset, (spent.get(f.asset) ?? 0n) + BigInt(f.amount));
  const decimals = { sol: 9, eth: 18 } as const;
  const sol = o.balances.find((b) => b.chain === 'solana' && b.asset === 'sol');
  // The runway uses the larger of the estimate and what was actually spent: a maker that refreshes more than planned runs dry sooner.
  const daily = [o.estimate ? BigInt(o.estimate.daily_lamports) : 0n, spent.get('sol') ?? 0n].reduce((a, b) => (a > b ? a : b));
  return {
    estimate: o.estimate,
    spent_24h: [...spent].map(([asset, amount]) => {
      const price = asset === 'sol' || asset === 'eth' ? o.usd(asset) : null;
      return { asset: asset as 'sol' | 'eth', amount: amount.toString(), usd: price === null ? null : (Number(amount) / 10 ** decimals[asset as 'sol' | 'eth']) * price };
    }),
    operator_balances: o.balances,
    runway_days: sol && daily > 0n ? Number(BigInt(sol.balance)) / Number(daily) : null,
    runway_alert_days: o.runwayAlertDays,
  };
}
