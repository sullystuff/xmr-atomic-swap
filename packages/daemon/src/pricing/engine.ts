/**
 * The reference price per market: primary source, ordered fallbacks, a cross-check with a
 * largest allowed disagreement, and the guardrails that stop quoting (volatility,
 * disagreement, stale price). SPEC 7.1 `pricing/`, DESIGN "Price sources" and "Guardrails".
 */
import type { ResolvedOffer } from '../config/load.js';
import type { RawConfig, SourceName } from '../config/schema.js';
import type { Store } from '../store/db.js';
import type { PriceSourceClient, PricedAsset, UsdPrices } from './sources.js';

export interface Sample {
  at: number;
  prices: UsdPrices;
}
export interface Reference {
  /** USD per XMR from the chosen source; `null` when no source has a price. */
  xmrUsd: number | null;
  /** USD per unit of the market's asset (1 for USDC). */
  assetUsd: number | null;
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

  /** Read every configured source that is due (its own minimum interval is the plan's rate limit). Failures are recorded, never thrown. */
  async refresh(wanted?: SourceName[]): Promise<void> {
    const t = this.now();
    const cfg = this.cfg();
    const order: SourceName[] = ['coingecko', 'coinmarketcap', 'wxmr_pool'];
    const others: UsdPrices = {};
    for (const name of order) {
      const client = this.sources[name];
      if (!client || (wanted && !wanted.includes(name))) continue;
      const minInterval = name === 'wxmr_pool' ? 0 : (cfg.pricing.sources[name].min_interval_seconds ?? 0);
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
        for (const [asset, usd] of Object.entries(prices)) this.store.recordPrice(name, asset, usd as number, t);
        if (name !== 'wxmr_pool') for (const [k, v] of Object.entries(prices)) (others as Record<string, number>)[k] ??= v as number;
      } catch (e) {
        this.errors.set(name, (e as Error).message);
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

  /** Largest relative move between any sample in the window and the current price, percent. */
  movePct(source: SourceName, current: number, windowSecs: number): number {
    const rows = this.store.pricesSince('xmr', this.now() - windowSecs).filter((r) => r.source === source);
    return rows.reduce((m, r) => Math.max(m, (Math.abs(current - r.usd) / r.usd) * 100), 0);
  }

  /** The reference for one offer, with the guardrails applied. */
  reference(o: Pick<ResolvedOffer, 'market' | 'source' | 'fallbacks' | 'crossCheck'>): Reference {
    const cfg = this.cfg();
    const g = cfg.guardrails;
    const asset = assetOf(o.market);
    const has = (s: Sample | undefined): s is Sample => !!s && s.prices.xmr !== undefined && (asset === null || s.prices[asset] !== undefined);
    const order = [o.source, ...o.fallbacks];
    const pausedBy: string[] = [];

    let source = order.find((n) => has(this.fresh(n))) ?? null;
    let sample = source ? this.fresh(source)! : undefined;
    if (!sample) {
      // No fresh price. With the stale pause off the newest price is still used; with it on, quoting stops.
      source = order.filter((n) => has(this.latest.get(n))).sort((a, b) => this.latest.get(b)!.at - this.latest.get(a)!.at)[0] ?? null;
      sample = source ? this.latest.get(source) : undefined;
      if (!sample || g.stale_pause) pausedBy.push('stale_price');
    }
    if (!sample || !source) return { xmrUsd: null, assetUsd: null, source: null, ageSecs: null, pausedBy: pausedBy.length ? pausedBy : ['stale_price'], widenPct: 0, movePct: 0, disagreementPct: null };

    const xmrUsd = sample.prices.xmr!;
    let widenPct = 0;
    let disagreementPct: number | null = null;
    if (o.crossCheck && o.crossCheck !== source) {
      const check = this.fresh(o.crossCheck)?.prices.xmr;
      disagreementPct = check === undefined ? null : (Math.abs(xmrUsd - check) / check) * 100;
      const failed = disagreementPct === null || disagreementPct > cfg.pricing.max_disagreement_pct;
      if (failed) {
        if (cfg.pricing.on_failure === 'widen') widenPct += cfg.pricing.widen_pct;
        else if (g.disagreement_pause) pausedBy.push('disagreement');
      }
    }
    const vol = g.volatility_pause || null;
    const movePct = this.movePct(source, xmrUsd, vol ? vol.window_seconds : 600);
    if (vol && movePct > vol.move_pct) pausedBy.push('volatility');

    return { xmrUsd, assetUsd: asset === null ? 1 : sample.prices[asset]!, source, ageSecs: this.now() - sample.at, pausedBy, widenPct, movePct, disagreementPct };
  }

  /** Best USD price of an asset from any source, newest first (stats, the rebalancer, cost estimates). */
  usd(asset: 'xmr' | 'sol' | 'eth' | 'usdc_sol' | 'usdc_eth'): number | null {
    if (asset === 'usdc_sol' || asset === 'usdc_eth') return 1;
    const samples = (['coingecko', 'coinmarketcap', 'wxmr_pool'] as SourceName[]).map((n) => this.latest.get(n)).filter((s): s is Sample => !!s && s.prices[asset] !== undefined);
    samples.sort((a, b) => b.at - a.at);
    return samples[0]?.prices[asset] ?? null;
  }
}
