/**
 * Price sources (DESIGN "Price sources"; SPEC 7.1 `pricing/`): CoinGecko and CoinMarketCap as
 * keyed HTTP clients, and the wXMR pool reader. Every client takes an injectable HTTP client
 * (tests use fixtures; nothing here opens a socket by itself) and reads its API key from the
 * environment by variable name at call time. Keys are never stored, logged or put in errors.
 */
import type { SourceName } from '../config/schema.js';

export interface PriceHttp {
  get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
}
export const fetchPriceHttp = (timeoutMs = 15_000): PriceHttp => ({
  async get(url, headers) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  },
});

export type PricedAsset = 'xmr' | 'sol' | 'eth';
/**
 * What one read gives. `xmr`, `sol`, `eth`: USD per unit. `xmr_sol`: SOL per XMR, straight from a
 * SOL-quoted pool (no USD price involved). A source that cannot price something leaves it out.
 */
export type UsdPrices = Partial<Record<PricedAsset | 'xmr_sol', number>>;
export interface PriceSourceClient {
  readonly name: SourceName;
  /** `others`: prices already known this round (the pool needs SOL/USD when it is quoted in SOL). */
  fetch(others?: UsdPrices): Promise<UsdPrices>;
}

export class SourceError extends Error {
  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
  }
}
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
type Env = (name: string) => string | undefined;

export function coingecko(o: { http: PriceHttp; env: Env; apiKeyEnv?: string; baseUrl?: string }): PriceSourceClient {
  const base = (o.baseUrl ?? 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
  return {
    name: 'coingecko',
    async fetch() {
      const key = o.apiKeyEnv ? o.env(o.apiKeyEnv) : undefined;
      const r = await o.http.get(`${base}/simple/price?ids=monero,solana,ethereum&vs_currencies=usd`, key ? { 'x-cg-demo-api-key': key, accept: 'application/json' } : { accept: 'application/json' });
      if (r.status !== 200) throw new SourceError('coingecko', `HTTP ${r.status}`);
      let j: Record<string, { usd?: unknown } | undefined>;
      try {
        j = JSON.parse(r.body) as Record<string, { usd?: unknown }>;
      } catch {
        throw new SourceError('coingecko', 'the response is not JSON');
      }
      const out: UsdPrices = {};
      for (const [id, asset] of [['monero', 'xmr'], ['solana', 'sol'], ['ethereum', 'eth']] as const) if (positive(j[id]?.usd)) out[asset] = j[id]!.usd as number;
      if (out.xmr === undefined) throw new SourceError('coingecko', 'no XMR price in the response');
      return out;
    },
  };
}

export function coinmarketcap(o: { http: PriceHttp; env: Env; apiKeyEnv?: string; baseUrl?: string }): PriceSourceClient {
  const base = (o.baseUrl ?? 'https://pro-api.coinmarketcap.com').replace(/\/$/, '');
  return {
    name: 'coinmarketcap',
    async fetch() {
      const key = o.apiKeyEnv ? o.env(o.apiKeyEnv) : undefined;
      if (!key) throw new SourceError('coinmarketcap', 'no API key in the environment');
      const r = await o.http.get(`${base}/v2/cryptocurrency/quotes/latest?symbol=XMR,SOL,ETH&convert=USD`, { 'X-CMC_PRO_API_KEY': key, accept: 'application/json' });
      if (r.status !== 200) throw new SourceError('coinmarketcap', `HTTP ${r.status}`);
      let data: Record<string, unknown>;
      try {
        data = (JSON.parse(r.body) as { data?: Record<string, unknown> }).data ?? {};
      } catch {
        throw new SourceError('coinmarketcap', 'the response is not JSON');
      }
      const priceOf = (sym: string): unknown => {
        const d = data[sym];
        const first = (Array.isArray(d) ? d[0] : d) as { quote?: { USD?: { price?: unknown } } } | undefined;
        return first?.quote?.USD?.price;
      };
      const out: UsdPrices = {};
      for (const [sym, asset] of [['XMR', 'xmr'], ['SOL', 'sol'], ['ETH', 'eth']] as const) if (positive(priceOf(sym))) out[asset] = priceOf(sym) as number;
      if (out.xmr === undefined) throw new SourceError('coinmarketcap', 'no XMR price in the response');
      return out;
    },
  };
}

/** The balance of an SPL token account in base units (`null` = no such account). */
export type TokenBalanceReader = (tokenAccount: string) => Promise<bigint | null>;

/**
 * A wXMR pool on Solana, read from its two reserve token accounts: price = quote reserve ÷ wXMR
 * reserve. The maker may use it as a primary source, a fallback or a cross-check; its own
 * protections are then what stands between the maker and a pool pushed off-market:
 *
 * - `minLiquidityUsd`: below it the source is unavailable (the market falls back, or pauses).
 * - `averageSeconds`: the price is the TIME-WEIGHTED average over that window, never the last
 *   read, and the source is unavailable until its samples span the whole window (a daemon that
 *   has just started does not quote off one sample). `0` = the last read.
 * - `maxJumpPct` (the volatility guardrail's `move_pct`): a read that moved further than that
 *   from the last accepted one is set aside, and only joins the average once reads have stayed
 *   at the new level for a whole window. One off-market read moves nothing.
 *
 * A USDC-quoted pool gives XMR/USD. A SOL-quoted pool gives XMR/SOL (`xmr_sol`), and XMR/USD
 * too when another source supplies SOL/USD.
 */
export function wxmrPool(o: { name?: 'wxmr_pool' | 'wxmr_pool_sol'; read: TokenBalanceReader; baseVault: string; quoteVault: string; quote: 'usdc' | 'sol'; minLiquidityUsd: number; averageSeconds: number; maxJumpPct?: number | null; now: () => number }): PriceSourceClient {
  const name = o.name ?? 'wxmr_pool';
  /** Accepted reads, in quote units per XMR, oldest first. */
  const samples: { at: number; value: number }[] = [];
  let pending: { value: number; since: number } | null = null;
  const jumped = (a: number, b: number): boolean => o.maxJumpPct != null && o.maxJumpPct > 0 && (Math.abs(a - b) / b) * 100 > o.maxJumpPct;
  return {
    name,
    async fetch(others = {}) {
      const [base, quote] = await Promise.all([o.read(o.baseVault), o.read(o.quoteVault)]);
      if (base === null || quote === null || base === 0n) throw new SourceError(name, 'a pool reserve account is missing or empty');
      const baseXmr = Number(base) / 1e12; // wXMR has 12 decimals
      const quoteUnits = Number(quote) / (o.quote === 'usdc' ? 1e6 : 1e9);
      const quoteUsd = o.quote === 'usdc' ? 1 : positive(others.sol) ? others.sol : null;
      // The liquidity floor is in USD; a SOL-quoted pool with no SOL/USD price at hand cannot be measured against it.
      if (o.minLiquidityUsd > 0) {
        if (quoteUsd === null) throw new SourceError(name, 'min_liquidity_usd needs a SOL/USD price from another source for a SOL-quoted pool');
        const liquidityUsd = 2 * quoteUnits * quoteUsd;
        if (liquidityUsd < o.minLiquidityUsd) throw new SourceError(name, 'pool liquidity $' + Math.round(liquidityUsd) + ' is under the minimum $' + o.minLiquidityUsd);
      }
      const t = o.now();
      const value = quoteUnits / baseXmr;
      const last = samples[samples.length - 1];
      if (last && jumped(value, last.value)) {
        // Set aside. It counts only once the pool has stayed there for a whole window.
        if (!pending || jumped(value, pending.value)) pending = { value, since: t };
        if (t - pending.since >= o.averageSeconds) {
          samples.push({ at: t, value });
          pending = null;
        } else if (last.at < t) samples.push({ at: t, value: last.value }); // the accepted level carries on meanwhile
      } else {
        pending = null;
        samples.push({ at: t, value });
      }
      // Keep the window, plus the one sample before it (it is the price at the window's start).
      const start = t - o.averageSeconds;
      while (samples.length > 1 && samples[1]!.at <= start) samples.shift();
      let price: number;
      if (o.averageSeconds <= 0) price = samples[samples.length - 1]!.value;
      else {
        if (samples[0]!.at > start) throw new SourceError(name, 'the averaging window is not filled yet (' + (t - samples[0]!.at) + ' of ' + o.averageSeconds + ' s)');
        // Time-weighted: each sample holds from its own time (or the window's start) until the next one.
        let area = 0;
        for (let i = 0; i < samples.length; i++) {
          const from = Math.max(samples[i]!.at, start);
          const to = i + 1 < samples.length ? samples[i + 1]!.at : t;
          if (to > from) area += samples[i]!.value * (to - from);
        }
        price = area / o.averageSeconds;
      }
      if (o.quote === 'usdc') return { xmr: price };
      return { xmr_sol: price, ...(quoteUsd !== null ? { xmr: price * quoteUsd } : {}) };
    },
  };
}
