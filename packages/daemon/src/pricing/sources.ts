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
/** USD prices of one read. A source that cannot price an asset leaves it out. */
export type UsdPrices = Partial<Record<PricedAsset, number>>;
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
 * The wXMR pool on Solana, read from its two reserve token accounts: price = quote reserve ÷
 * wXMR reserve. A cross-check only (DESIGN Decisions). Refuses to price below the minimum
 * liquidity and averages over the configured window, because a thin pool can be pushed
 * off-market cheaply by someone who then takes the maker's quote.
 */
export function wxmrPool(o: { read: TokenBalanceReader; baseVault: string; quoteVault: string; quote: 'usdc' | 'sol'; minLiquidityUsd: number; averageSeconds: number; now: () => number }): PriceSourceClient {
  const samples: { at: number; usd: number }[] = [];
  return {
    name: 'wxmr_pool',
    async fetch(others = {}) {
      const [base, quote] = await Promise.all([o.read(o.baseVault), o.read(o.quoteVault)]);
      if (base === null || quote === null || base === 0n) throw new SourceError('wxmr_pool', 'a pool reserve account is missing or empty');
      const quoteUsd = o.quote === 'usdc' ? 1 : others.sol;
      if (!positive(quoteUsd)) throw new SourceError('wxmr_pool', 'a SOL-quoted pool needs a SOL/USD price from another source');
      const baseXmr = Number(base) / 1e12; // wXMR has 12 decimals
      const quoteUnits = Number(quote) / (o.quote === 'usdc' ? 1e6 : 1e9);
      const liquidityUsd = 2 * quoteUnits * quoteUsd;
      if (liquidityUsd < o.minLiquidityUsd) throw new SourceError('wxmr_pool', `pool liquidity $${Math.round(liquidityUsd)} is under the minimum $${o.minLiquidityUsd}`);
      const t = o.now();
      samples.push({ at: t, usd: (quoteUnits / baseXmr) * quoteUsd });
      while (samples.length > 0 && samples[0]!.at < t - o.averageSeconds) samples.shift();
      return { xmr: samples.reduce((a, s) => a + s.usd, 0) / samples.length };
    },
  };
}
