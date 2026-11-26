/**
 * The reference price per market: the maker's primary source, its ordered fallbacks, an
 * optional cross-check with a largest allowed disagreement, and the guardrails that stop
 * quoting (volatility, disagreement, stale price). SPEC 7.1 `pricing/`, DESIGN "Price sources"
 * and "Guardrails".
 *
 * Any source may play any role. A USDC market needs XMR/USD; the SOL market needs XMR/SOL,
 * either straight from a SOL-quoted pool or as XMR/USD with SOL/USD; the ETH markets need
 * XMR/USD with ETH/USD. The asset's own USD price may come from another of the market's
 * sources than the one that prices XMR.
 */
import type { ResolvedOffer } from '../config/load.js';
import type { RawConfig, SourceName } from '../config/schema.js';
import { SOURCE_NAMES } from '../config/schema.js';
import type { Store } from '../store/db.js';
import type { PriceSourceClient, PricedAsset, UsdPrices } from './sources.js';

export interface Sample {
  at: number;
  prices: UsdPrices;
}
export interface Reference {
  /** XMR price from the chosen source: USD per XMR, or (`unit = "asset"`) SOL per XMR straight from a SOL-quoted pool. `null` = no source has a price. */
  xmrUsd: number | null;
  /** USD per unit of the market's asset (1 for USDC, and 1 when `unit = "asset"`). */
  assetUsd: number | null;
  /** `"asset"`: `xmrUsd` is already in the market's asset and no USD figure exists (guardrails stated in USD do not apply). */
  unit: 'usd' | 'asset';
  source: SourceName | null;
  ageSecs: number | null;
  /** Guardrails that stop quoting right now: `stale_price`, `disagreement`, `volatility`. Empty = quote. */
  pausedBy: string[];
  /** Extra deviation from `on_failure = "widen"`, percent. */
  widenPct: number;
  /** Largest move of the reference inside the volatility window, percent. */
  movePct: number;
  disagreementPct: number | null;
}

const assetOf = (market: string): PricedAsset | null => (market === 'sol' ? 'sol' : market === 'eth' ? 'eth' : null);
/** Keyed sources first: a SOL-quoted pool may want their SOL/USD in the same round. */
const ORDER: SourceName[] = [...SOURCE_NAMES].sort((a, b) => Number(a.startsWith('wxmr')) - Number(b.startsWith('wxmr')));
interface Priced {
  xmr: number;
  asset: number;
  unit: 'usd' | 'asset';
  /** Which series of this source the price follows (for the volatility window). */
  series: 'xmr' | 'xmr_sol';
}

export class PriceEngine {
  private latest = new Map<SourceName, Sample>();
  private lastAttempt = new Map<SourceName, number>();
  private errors = new Map<SourceName, string>();

  constructor(
    private readonly sources: Partial<Record<SourceName, PriceSourceClient>>,
    private readonly store: Store,
    private readonly cfg: () => RawConfig,
    private readonly now: () => number = () => store.now(),
  ) {}

  /** Read every source that is in use and due (a keyed source's minimum interval is its plan's rate limit). Failures are recorded, never thrown. */
  async refresh(wanted?: SourceName[]): Promise<void> {
    const t = this.now();
    const cfg = this.cfg();
    const others: UsdPrices = {};
    for (const name of ORDER) {
      const client = this.sources[name];
      if (!client || (wanted && !wanted.includes(name))) continue;
      const keyed = name === 'coingecko' || name === 'coinmarketcap';
      const minInterval = keyed ? (cfg.pricing.sources[name].min_interval_seconds ?? 0) : 0;
      const last = this.lastAttempt.get(name);
      if (last !== undefined && t - last < minInterval) {
        Object.assign(others, this.latest.get(name)?.prices ?? {});
        continue;
      }
      this.lastAttempt.set(name, t);
      try {
        const prices = await client.fetch(others);
        this.latest.set(name, { at: t, prices });
        this.errors.delete(name);
        for (const [key, value] of Object.entries(prices)) this.store.recordPrice(name, key, value as number, t);
        if (keyed) for (const [k, v] of Object.entries(prices)) (others as Record<string, number>)[k] ??= v as number;
      } catch (e) {
        this.errors.set(name, (e as Error).message);
        // A keyed API that fails to answer keeps its last price until it is too old. A pool that refuses to price
        // (too little liquidity, window not filled) has judged its own price: it is unavailable at once.
        if (!keyed) this.latest.delete(name);
      }
    }
    this.store.prunePrices(t - 7 * 86_400);
  }

  sample(name: SourceName): Sample | undefined {
    return this.latest.get(name);
  }
  sourceError(name: SourceName): string | undefined {
    return this.errors.get(name);
  }
  private fresh(name: SourceName): Sample | undefined {
    const s = this.latest.get(name);
    return s && this.now() - s.at <= this.cfg().pricing.max_age_seconds ? s : undefined;
  }

  /** Largest relative move between any sample of a source's series in the window and the current price, percent. */
  movePct(source: SourceName, current: number, windowSecs: number, series: 'xmr' | 'xmr_sol' = 'xmr'): number {
    const rows = this.store.pricesSince(series, this.now() - windowSecs).filter((r) => r.source === source);
    return rows.reduce((m, r) => Math.max(m, (Math.abs(current - r.usd) / r.usd) * 100), 0);
  }

  /** How one sample prices a market, given where the asset's own USD price may come from. */
  private price(market: string, s: Sample | undefined, helper: (asset: PricedAsset) => number | undefined): Priced | null {
    if (!s) return null;
    const asset = assetOf(market);
    const p = s.prices;
    if (asset === 'sol' && p.xmr_sol !== undefined && p.xmr === undefined) return { xmr: p.xmr_sol, asset: 1, unit: 'asset', series: 'xmr_sol' };
    if (p.xmr === undefined) return null;
    if (asset === null) return { xmr: p.xmr, asset: 1, unit: 'usd', series: 'xmr' };
    const assetUsd = p[asset] ?? helper(asset);
    return assetUsd === undefined ? null : { xmr: p.xmr, asset: assetUsd, unit: 'usd', series: 'xmr' };
  }

  /** The reference for one offer, with the guardrails applied. */
  reference(o: Pick<ResolvedOffer, 'market' | 'source' | 'fallbacks' | 'crossCheck'>): Reference {
    const cfg = this.cfg();
    const g = cfg.guardrails;
    const order = [o.source, ...o.fallbacks];
    const pausedBy: string[] = [];
    // The asset's own USD price: from the pricing source itself, else from the first of the market's sources that has a fresh one.
    const helperFrom = (get: (n: SourceName) => Sample | undefined) => (asset: PricedAsset) => order.map((n) => get(n)?.prices[asset]).find((v) => v !== undefined);
    const freshHelper = helperFrom((n) => this.fresh(n));

    let source = order.find((n) => this.price(o.market, this.fresh(n), freshHelper) !== null) ?? null;
    let sample = source ? this.fresh(source) : undefined;
    let priced = source ? this.price(o.market, sample, freshHelper) : null;
    if (!priced) {
      // No fresh price. With the stale pause off the newest price is still used; with it on, quoting stops.
      const anyHelper = helperFrom((n) => this.latest.get(n));
      source = order.filter((n) => this.price(o.market, this.latest.get(n), anyHelper) !== null).sort((a, b) => this.latest.get(b)!.at - this.latest.get(a)!.at)[0] ?? null;
      sample = source ? this.latest.get(source) : undefined;
      priced = source ? this.price(o.market, sample, anyHelper) : null;
      if (!priced || g.stale_pause) pausedBy.push('stale_price');
    }
    if (!priced || !sample || !source) return { xmrUsd: null, assetUsd: null, unit: 'usd', source: null, ageSecs: null, pausedBy: pausedBy.length ? pausedBy : ['stale_price'], widenPct: 0, movePct: 0, disagreementPct: null };

    let widenPct = 0;
    let disagreementPct: number | null = null;
    if (o.crossCheck && o.crossCheck !== source) {
      // Compared in the unit the reference is in. No cross-check configured = no disagreement guardrail for this market.
      const c = this.fresh(o.crossCheck)?.prices;
      const check = priced.unit === 'usd' ? c?.xmr : (c?.xmr_sol ?? (c?.xmr !== undefined && c.sol !== undefined ? c.xmr / c.sol : undefined));
      disagreementPct = check === undefined ? null : (Math.abs(priced.xmr - check) / check) * 100;
      const failed = disagreementPct === null || disagreementPct > cfg.pricing.max_disagreement_pct;
      if (failed) {
        if (cfg.pricing.on_failure === 'widen') widenPct += cfg.pricing.widen_pct;
        else if (g.disagreement_pause) pausedBy.push('disagreement');
      }
    }
    const vol = g.volatility_pause || null;
    const movePct = this.movePct(source, priced.xmr, vol ? vol.window_seconds : 600, priced.series);
    if (vol && movePct > vol.move_pct) pausedBy.push('volatility');

    return { xmrUsd: priced.xmr, assetUsd: priced.asset, unit: priced.unit, source, ageSecs: this.now() - sample.at, pausedBy, widenPct, movePct, disagreementPct };
  }

  /** Best USD price of an asset from any source in use, newest first (stats, the rebalancer, cost estimates). */
  usd(asset: 'xmr' | 'sol' | 'eth' | 'usdc_sol' | 'usdc_eth'): number | null {
    if (asset === 'usdc_sol' || asset === 'usdc_eth') return 1;
    const samples = ORDER.map((n) => this.latest.get(n)).filter((s): s is Sample => !!s && s.prices[asset] !== undefined);
    samples.sort((a, b) => b.at - a.at);
    return samples[0]?.prices[asset] ?? null;
  }
}
