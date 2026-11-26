// Price sources, the reference engine and DESIGN's formula with its guardrails.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { type ResolvedOffer, loadConfig } from '../src/config/load.js';
import { inventorySkewPct, offerPriceUsd, priceOffer, toAssetUnits, xmrForUnits } from '../src/offers/price.js';
import { PriceEngine } from '../src/pricing/engine.js';
import { type PriceHttp, type PriceSourceClient, coingecko, coinmarketcap, wxmrPool } from '../src/pricing/sources.js';
import { Store } from '../src/store/db.js';

beforeAll(async () => {
  await init();
});

// Hand-written fixtures in the shape of each API's documented response. No venue is ever contacted.
const CG = JSON.stringify({ monero: { usd: 392.5 }, solana: { usd: 150.25 }, ethereum: { usd: 3100 } });
const CMC = JSON.stringify({ data: { XMR: [{ quote: { USD: { price: 393.1 } } }], SOL: [{ quote: { USD: { price: 150.5 } } }], ETH: [{ quote: { USD: { price: 3099 } } }] } });
const http = (body: string, status = 200): PriceHttp & { seen: { url: string; headers: Record<string, string> }[] } => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  return { seen, get: async (url, headers) => (seen.push({ url, headers }), { status, body }) };
};

describe('price sources', () => {
  it('CoinGecko: reads XMR, SOL and ETH in USD; the key comes from the environment by name', async () => {
    const h = http(CG);
    const c = coingecko({ http: h, env: (n) => (n === 'COINGECKO_KEY' ? 'cg-secret' : undefined), apiKeyEnv: 'COINGECKO_KEY' });
    expect(await c.fetch()).toEqual({ xmr: 392.5, sol: 150.25, eth: 3100 });
    expect(h.seen[0]!.url).toBe('https://api.coingecko.com/api/v3/simple/price?ids=monero,solana,ethereum&vs_currencies=usd');
    expect(h.seen[0]!.headers['x-cg-demo-api-key']).toBe('cg-secret');
    expect(h.seen[0]!.url).not.toContain('cg-secret');
  });
  it('CoinMarketCap: needs its key; an error never carries it', async () => {
    const h = http(CMC);
    const c = coinmarketcap({ http: h, env: (n) => (n === 'CMC_KEY' ? 'cmc-secret' : undefined), apiKeyEnv: 'CMC_KEY' });
    expect(await c.fetch()).toEqual({ xmr: 393.1, sol: 150.5, eth: 3099 });
    expect(h.seen[0]!.headers['X-CMC_PRO_API_KEY']).toBe('cmc-secret');
    await expect(coinmarketcap({ http: h, env: () => undefined, apiKeyEnv: 'CMC_KEY' }).fetch()).rejects.toThrow(/no API key/);
    const failing = coinmarketcap({ http: http('{"status":{"error_message":"bad key"}}', 401), env: () => 'cmc-secret', apiKeyEnv: 'CMC_KEY' });
    const e = await failing.fetch().catch((x: Error) => x);
    expect((e as Error).message).toBe('coinmarketcap: HTTP 401');
    expect((e as Error).message).not.toContain('cmc-secret');
  });
  it('rejects a malformed or incomplete answer', async () => {
    await expect(coingecko({ http: http('<html>'), env: () => undefined }).fetch()).rejects.toThrow(/not JSON/);
    await expect(coingecko({ http: http('{"solana":{"usd":150}}'), env: () => undefined }).fetch()).rejects.toThrow(/no XMR price/);
    await expect(coingecko({ http: http('{"monero":{"usd":-1}}'), env: () => undefined }).fetch()).rejects.toThrow(/no XMR price/);
  });
  it('wXMR pool: price from the two reserves, refused under the minimum liquidity, averaged over the window', async () => {
    let now = 1000;
    const reserves = { base: 100n * 10n ** 12n, quote: 39_000n * 10n ** 6n };
    const pool = (minLiquidityUsd: number, averageSeconds = 300, maxJumpPct: number | null = null) => wxmrPool({ read: async (a) => (a === 'B' ? reserves.base : a === 'Q' ? reserves.quote : null), baseVault: 'B', quoteVault: 'Q', quote: 'usdc', minLiquidityUsd, averageSeconds, maxJumpPct, now: () => now });
    await expect(pool(250_000).fetch()).rejects.toThrow(/liquidity \$78000 is under the minimum \$250000/);
    const p = pool(50_000);
    // A daemon that has just started does not quote off one sample: the source is unavailable until the window is filled.
    await expect(p.fetch()).rejects.toThrow(/averaging window is not filled yet \(0 of 300 s\)/);
    now += 150;
    await expect(p.fetch()).rejects.toThrow(/150 of 300 s/);
    now += 150;
    expect((await p.fetch()).xmr).toBeCloseTo(390, 9);
    // The pool moves 10% and stays there. The price is the TIME-weighted average over the window, not the mean of the
    // reads and not the last read: 60 s after the move it has moved by 60/300 of it.
    now += 240;
    expect((await p.fetch()).xmr).toBeCloseTo(390, 9);
    reserves.quote = 42_900n * 10n ** 6n;
    expect((await p.fetch()).xmr).toBeCloseTo(390, 9); // the new level has held for 0 s so far
    now += 60;
    expect((await p.fetch()).xmr).toBeCloseTo(390 + (39 * 60) / 300, 9);
    now += 30;
    await p.fetch();
    now += 30;
    await p.fetch(); // many reads in a short time do not weigh more than their time
    expect((await p.fetch()).xmr).toBeCloseTo(390 + (39 * 120) / 300, 9);
    now += 400;
    expect((await p.fetch()).xmr).toBeCloseTo(429, 9);
    // average_seconds = 0 is the maker's explicit choice of the last read.
    expect((await pool(0, 0).fetch()).xmr).toBeCloseTo(429, 9);

    // The per-read sanity bound: a read that jumped more than move_pct is set aside until it has persisted for a whole window.
    reserves.quote = 39_000n * 10n ** 6n;
    const guarded = pool(0, 300, 3);
    await guarded.fetch().catch(() => undefined);
    now += 300;
    expect((await guarded.fetch()).xmr).toBeCloseTo(390, 9);
    reserves.quote = 58_500n * 10n ** 6n; // +50%: one off-market read
    now += 15;
    expect((await guarded.fetch()).xmr).toBeCloseTo(390, 9);
    reserves.quote = 39_000n * 10n ** 6n; // and back
    now += 15;
    expect((await guarded.fetch()).xmr).toBeCloseTo(390, 9);
    // A level that persists for the whole window is the market, not an attack: it is accepted then, and averaged in over time.
    reserves.quote = 42_900n * 10n ** 6n;
    for (let i = 0; i < 20; i++) {
      now += 15;
      expect((await guarded.fetch()).xmr).toBeCloseTo(390, 9);
    }
    now += 15;
    await guarded.fetch();
    now += 150;
    expect((await guarded.fetch()).xmr).toBeCloseTo(390 + 39 / 2, 9);

    // A SOL-quoted pool gives XMR/SOL by itself, and XMR/USD as well once something supplies SOL/USD.
    const solQuoted = wxmrPool({ name: 'wxmr_pool_sol', read: async (a) => (a === 'B' ? 10n ** 12n : 3n * 10n ** 9n), baseVault: 'B', quoteVault: 'Q', quote: 'sol', minLiquidityUsd: 0, averageSeconds: 0, now: () => now });
    expect(solQuoted.name).toBe('wxmr_pool_sol');
    expect(await solQuoted.fetch()).toEqual({ xmr_sol: 3 });
    expect(await solQuoted.fetch({ sol: 130 })).toEqual({ xmr_sol: 3, xmr: 390 });
    const floor = wxmrPool({ read: async (a) => (a === 'B' ? 10n ** 12n : 3n * 10n ** 9n), baseVault: 'B', quoteVault: 'Q', quote: 'sol', minLiquidityUsd: 1000, averageSeconds: 0, now: () => now });
    await expect(floor.fetch()).rejects.toThrow(/min_liquidity_usd needs a SOL\/USD price/);
    await expect(floor.fetch({ sol: 130 })).rejects.toThrow(/liquidity \$780 is under the minimum \$1000/);
  });
});

describe('DESIGN formula: offer price = reference × (1 + deviation + size tier + inventory skew)', () => {
  it('adds when selling XMR and subtracts when buying; deviation may be negative', () => {
    expect(offerPriceUsd(400, 'sell_xmr', { deviationPct: 1.5 })).toBeCloseTo(406, 9);
    expect(offerPriceUsd(400, 'sell_xmr', { deviationPct: 1.5, tierPct: 0.5, skewPct: 1 })).toBeCloseTo(400 * 1.03, 9);
    expect(offerPriceUsd(400, 'buy_xmr', { deviationPct: 1.5, tierPct: 0.5, skewPct: 1 })).toBeCloseTo(400 * 0.97, 9);
    expect(offerPriceUsd(400, 'sell_xmr', { deviationPct: -0.25 })).toBeCloseTo(399, 9);
    expect(offerPriceUsd(400, 'sell_xmr', { deviationPct: 2, widenPct: 0.5 })).toBeCloseTo(410, 9);
  });
  it('inventory skew grows as inventory moves away from its target, up to the maximum, and helps refill', () => {
    expect(inventorySkewPct('sell_xmr', 1, 400, 400)).toBe(0);
    expect(inventorySkewPct('sell_xmr', 1, 200, 400)).toBeCloseTo(0.5, 9); // scarce: sell dearer
    expect(inventorySkewPct('sell_xmr', 1, 0, 400)).toBe(1);
    expect(inventorySkewPct('sell_xmr', 1, 2000, 400)).toBe(-1); // glut: capped
    expect(inventorySkewPct('buy_xmr', 1, 200, 400)).toBeCloseTo(-0.5, 9); // scarce: pay more for XMR
    expect(inventorySkewPct('sell_xmr', 1, 100, null)).toBe(0);
    expect(inventorySkewPct('sell_xmr', 0, 100, 400)).toBe(0);
  });
  it('converts to asset base units per XMR, rounded in the maker\'s favour', () => {
    expect(toAssetUnits(406, 1, 6, 'sell_xmr')).toBe(406_000_000n);
    expect(toAssetUnits(400, 150, 9, 'sell_xmr')).toBe(2_666_666_667n);
    expect(toAssetUnits(400, 150, 9, 'buy_xmr')).toBe(2_666_666_666n);
    expect(toAssetUnits(400, 0, 9, 'buy_xmr')).toBe(0n);
    expect(xmrForUnits(812_000_000n, 406_000_000n)).toBe(2_000_000_000_000n);
  });

  const offer = (toml: string, market = 'usdc_sol', direction = 'sell_xmr'): ResolvedOffer => loadConfig(toml).config!.offers.find((o) => o.market === market && o.direction === direction)!;
  const ref = (over: Partial<ReturnType<PriceEngine['reference']>> = {}) => ({ xmrUsd: 400, assetUsd: 1, unit: 'usd' as const, source: 'coingecko' as const, ageSecs: 1, pausedBy: [], widenPct: 0, movePct: 0, disagreementPct: null, ...over });
  const DESIGN_OFFER = '[markets.usdc_sol.sell_xmr]\nenabled = true\ndeviation_pct = 1.5\nsize_tiers = [{ above_xmr = 50, extra_pct = 0.5 }]\nmin_xmr = 0.1\nmax_xmr = 200\ninventory_skew_max_pct = 1\n';

  it('prices every size tier of DESIGN\'s example offer', () => {
    const p = priceOffer(offer(DESIGN_OFFER), ref(), { inventoryXmr: 400, targetXmr: 400, band: null });
    expect(p.blocked).toBeNull();
    expect(p.tierAbove).toEqual([0n, 50_000_000_000_000n, 0n]);
    expect(p.tierPrice).toEqual([406_000_000n, 408_000_000n, 0n]); // 400 × 1.015 and 400 × 1.020
    // Inventory at half its target adds half of the 1% skew.
    const skewed = priceOffer(offer(DESIGN_OFFER), ref(), { inventoryXmr: 200, targetXmr: 400, band: null });
    expect(skewed.tierPrice[0]).toBe(408_000_000n);
    expect(skewed.deviationPct).toBeCloseTo(2.0, 9);
  });
  it('buying subtracts; SOL markets divide by SOL/USD', () => {
    const buy = priceOffer(offer('[markets.sol.buy_xmr]\nenabled = true\ndeviation_pct = 2\nmax_xmr = 5\n', 'sol', 'buy_xmr'), ref({ assetUsd: 160 }), { inventoryXmr: 0, targetXmr: null, band: null });
    expect(buy.tierPrice[0]).toBe(2_450_000_000n); // 400 × 0.98 ÷ 160 SOL
  });
  it('guardrails: a pause blocks, on_failure = widen adds deviation, volatility widening is capped, the hard band is never crossed', () => {
    const o = offer(DESIGN_OFFER);
    expect(priceOffer(o, ref({ pausedBy: ['volatility'] }), { inventoryXmr: 0, targetXmr: null, band: null }).blocked).toBe('guardrail: volatility');
    expect(priceOffer(o, ref({ xmrUsd: null }), { inventoryXmr: 0, targetXmr: null, band: null }).blocked).toBe('no reference price');
    expect(priceOffer(o, ref({ widenPct: 0.5 }), { inventoryXmr: 0, targetXmr: null, band: null }).tierPrice[0]).toBe(408_000_000n);
    const vol = offer(`${DESIGN_OFFER}volatility_widen = { per_pct_move = 0.5, max_pct = 1 }\n`);
    expect(priceOffer(vol, ref({ movePct: 1 }), { inventoryXmr: 0, targetXmr: null, band: null }).tierPrice[0]).toBe(408_000_000n);
    expect(priceOffer(vol, ref({ movePct: 10 }), { inventoryXmr: 0, targetXmr: null, band: null }).tierPrice[0]).toBe(410_000_000n);
    const band = { min: 300, max: 900 };
    expect(priceOffer(o, ref({ xmrUsd: 890 }), { inventoryXmr: 0, targetXmr: null, band }).blocked).toMatch(/price_band \(903\.35 USD per XMR is outside 300\.\.900\)/);
    expect(priceOffer(o, ref({ xmrUsd: 290 }), { inventoryXmr: 0, targetXmr: null, band }).blocked).toMatch(/price_band/);
    expect(priceOffer(o, ref({ xmrUsd: 880 }), { inventoryXmr: 0, targetXmr: null, band }).blocked).toBeNull();
  });
});

describe('reference engine: primary, ordered fallbacks, cross-check, guardrails', () => {
  const setup = (toml: string) => {
    const cfg = loadConfig(toml).config!;
    const store = new Store(':memory:');
    let now = 10_000;
    store.now = () => now;
    const values: Record<string, { xmr?: number; sol?: number; eth?: number } | Error> = { coingecko: { xmr: 400, sol: 150, eth: 3000 }, coinmarketcap: { xmr: 401, sol: 151, eth: 3001 }, wxmr_pool: { xmr: 399 } };
    const calls: string[] = [];
    const src = (name: 'coingecko' | 'coinmarketcap' | 'wxmr_pool' | 'wxmr_pool_sol'): PriceSourceClient => ({
      name,
      fetch: async () => {
        calls.push(name);
        const v = values[name] ?? new Error('not configured');
        if (v instanceof Error) throw v;
        return { ...v };
      },
    });
    const engine = new PriceEngine({ coingecko: src('coingecko'), coinmarketcap: src('coinmarketcap'), wxmr_pool: src('wxmr_pool'), wxmr_pool_sol: src('wxmr_pool_sol') }, store, () => cfg.raw, () => now);
    const o = cfg.offers.find((x) => x.market === 'usdc_sol' && x.direction === 'sell_xmr')!;
    return { engine, values, o, cfg, calls, store, tick: (s: number) => (now += s) };
  };
  const BASE = '[pricing]\ncross_check = "coinmarketcap"\nmax_disagreement_pct = 1.0\nmax_age_seconds = 60\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 5\nsource = "coingecko"\nfallbacks = ["coinmarketcap"]\n';

  it('uses the primary; falls back in order when it fails or goes stale; records history', async () => {
    const t = setup(BASE);
    await t.engine.refresh();
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 400, assetUsd: 1, source: 'coingecko', pausedBy: [], disagreementPct: expect.closeTo(0.249, 2) });
    expect(t.store.pricesSince('xmr', 0).map((p) => p.source).sort()).toEqual(['coingecko', 'coinmarketcap', 'wxmr_pool']);
    // The primary goes down: after its last price is older than max_age the first fallback is the reference.
    t.values['coingecko'] = new Error('HTTP 503');
    t.tick(61);
    await t.engine.refresh();
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 401, source: 'coinmarketcap', pausedBy: [] });
    expect(t.engine.sourceError('coingecko')).toBe('HTTP 503');
    // Everything stale: the stale-price pause stops quoting.
    t.values['coinmarketcap'] = new Error('HTTP 500');
    t.tick(61);
    await t.engine.refresh();
    expect(t.engine.reference(t.o).pausedBy).toEqual(['stale_price']);
  });
  it('stale pause switched off: the newest price is still used', async () => {
    // (No cross-check here: a stale cross-check is a failed check of its own, asserted below.)
    const t = setup(`${BASE.replace('cross_check = "coinmarketcap"\n', '')}[guardrails]\nstale_pause = false\n`);
    await t.engine.refresh();
    t.tick(500);
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 400, ageSecs: 500, pausedBy: [] });
    const checked = setup(`${BASE}[guardrails]\nstale_pause = false\n`);
    await checked.engine.refresh();
    checked.tick(500);
    expect(checked.engine.reference(checked.o).pausedBy).toEqual(['disagreement']);
  });
  it('disagreement above the limit pauses, or widens when on_failure = "widen"; the guardrail can be switched off', async () => {
    const t = setup(BASE);
    t.values['coinmarketcap'] = { xmr: 410 };
    await t.engine.refresh();
    const r = t.engine.reference(t.o);
    expect(r.pausedBy).toEqual(['disagreement']);
    expect(r.disagreementPct).toBeCloseTo((10 / 410) * 100, 6);
    const w = setup(BASE.replace('max_age_seconds = 60', 'max_age_seconds = 60\non_failure = "widen"\nwiden_pct = 0.75'));
    w.values['coinmarketcap'] = { xmr: 410 };
    await w.engine.refresh();
    expect(w.engine.reference(w.o)).toMatchObject({ pausedBy: [], widenPct: 0.75 });
    const off = setup(`${BASE}[guardrails]\ndisagreement_pause = false\n`);
    off.values['coinmarketcap'] = { xmr: 410 };
    await off.engine.refresh();
    expect(off.engine.reference(off.o).pausedBy).toEqual([]);
    // A cross-check that cannot be read is a failed check too.
    const dead = setup(BASE);
    dead.values['coinmarketcap'] = new Error('down');
    await dead.engine.refresh();
    expect(dead.engine.reference(dead.o).pausedBy).toEqual(['disagreement']);
  });
  it('a wXMR pool named as the primary IS the primary: the file\'s choice is what runs; it falls over to its fallback and back', async () => {
    const t = setup('[pricing.sources.wxmr_pool]\ntoken = "T"\npool = "P"\nbase_vault = "B"\nquote_vault = "Q"\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 5\nsource = "wxmr_pool"\nfallbacks = ["coingecko"]\n');
    expect(t.o).toMatchObject({ source: 'wxmr_pool', fallbacks: ['coingecko'], crossCheck: null, enabled: true });
    await t.engine.refresh();
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 399, source: 'wxmr_pool', unit: 'usd', pausedBy: [], disagreementPct: null });
    // The pool refuses to price (liquidity under the floor): unavailable at once, not after max_age; the fallback prices the market.
    t.values['wxmr_pool'] = new Error('wxmr_pool: pool liquidity $100 is under the minimum $250000');
    t.tick(15);
    await t.engine.refresh();
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 400, source: 'coingecko', pausedBy: [] });
    expect(t.engine.sourceError('wxmr_pool')).toMatch(/under the minimum/);
    // The pool is back: so is the maker's primary.
    t.values['wxmr_pool'] = { xmr: 398 };
    t.tick(15);
    await t.engine.refresh();
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 398, source: 'wxmr_pool' });
  });
  it('a pool alone: no fallback, no cross-check; it pauses when the pool is unavailable or stale, and the other guardrails apply to it as to any source', async () => {
    const t = setup('[pricing.sources.wxmr_pool]\nbase_vault = "B"\nquote_vault = "Q"\n[pricing]\ncross_check = "none"\nmax_age_seconds = 60\n[guardrails]\nvolatility_pause = { move_pct = 3.0, window_seconds = 600 }\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 5\nsource = "wxmr_pool"\n');
    expect(t.o).toMatchObject({ source: 'wxmr_pool', fallbacks: [], crossCheck: null, enabled: true });
    await t.engine.refresh(['wxmr_pool']);
    // No cross-check: the disagreement guardrail is simply off for this market.
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: 399, source: 'wxmr_pool', pausedBy: [], disagreementPct: null });
    // Unavailable (low liquidity, or its window not filled): nothing else to fall back to, so quoting pauses.
    t.values['wxmr_pool'] = new Error('wxmr_pool: the averaging window is not filled yet (0 of 300 s)');
    t.tick(15);
    await t.engine.refresh(['wxmr_pool']);
    expect(t.engine.reference(t.o)).toMatchObject({ xmrUsd: null, pausedBy: ['stale_price'] });
    t.values['wxmr_pool'] = { xmr: 399 };
    await t.engine.refresh(['wxmr_pool']);
    expect(t.engine.reference(t.o).pausedBy).toEqual([]);
    // Stale: no read for longer than max_age_seconds.
    t.tick(61);
    expect(t.engine.reference(t.o).pausedBy).toEqual(['stale_price']);
    // Volatility pause on the pool's own series.
    await t.engine.refresh(['wxmr_pool']);
    t.tick(30);
    t.values['wxmr_pool'] = { xmr: 415 };
    await t.engine.refresh(['wxmr_pool']);
    expect(t.engine.reference(t.o).pausedBy).toEqual(['volatility']);
  });
  it('units: a SOL-quoted pool prices the SOL market by itself; XMR and the asset may come from different sources; a cross-check in SOL', async () => {
    const t = setup('[pricing.sources.wxmr_pool]\nbase_vault = "B"\nquote_vault = "Q"\n[pricing.sources.wxmr_pool_sol]\nbase_vault = "B2"\nquote_vault = "Q2"\n[tor]\nenabled = true\n[markets.sol.sell_xmr]\nenabled = true\nmax_xmr = 5\nsource = "wxmr_pool_sol"\n[markets.eth.sell_xmr]\nenabled = true\nmax_xmr = 5\nsource = "wxmr_pool"\nfallbacks = ["coingecko"]\n');
    (t.values as Record<string, unknown>)['wxmr_pool_sol'] = { xmr_sol: 2.66 };
    await t.engine.refresh();
    const sol = t.cfg.offers.find((x) => x.market === 'sol' && x.direction === 'sell_xmr')!;
    // SOL per XMR, straight from the pool: no USD price was involved.
    expect(t.engine.reference(sol)).toMatchObject({ xmrUsd: 2.66, assetUsd: 1, unit: 'asset', source: 'wxmr_pool_sol', pausedBy: [] });
    // ETH market: XMR/USD from the pool (the primary), ETH/USD from the fallback.
    const eth = t.cfg.offers.find((x) => x.market === 'eth' && x.direction === 'sell_xmr')!;
    expect(t.engine.reference(eth)).toMatchObject({ xmrUsd: 399, assetUsd: 3000, unit: 'usd', source: 'wxmr_pool' });
    // A cross-check for the SOL-priced market is compared in SOL: 400 USD ÷ 150 USD per SOL = 2.667.
    const checked = t.engine.reference({ ...sol, crossCheck: 'coingecko' });
    expect(checked.disagreementPct).toBeCloseTo((Math.abs(2.66 - 400 / 150) / (400 / 150)) * 100, 6);
    expect(checked.pausedBy).toEqual([]);
  });
  it('volatility pause: a move beyond the limit inside the window stops quoting until the window has passed', async () => {
    const t = setup(`${BASE}[guardrails]\nvolatility_pause = { move_pct = 3.0, window_seconds = 600 }\n`);
    await t.engine.refresh();
    t.tick(30);
    t.values['coingecko'] = { xmr: 409 };
    t.values['coinmarketcap'] = { xmr: 409 };
    await t.engine.refresh();
    expect(t.engine.reference(t.o)).toMatchObject({ pausedBy: [], movePct: expect.closeTo(2.25, 2) });
    t.tick(30);
    t.values['coingecko'] = { xmr: 414 };
    t.values['coinmarketcap'] = { xmr: 414 };
    await t.engine.refresh();
    expect(t.engine.reference(t.o).pausedBy).toEqual(['volatility']);
    t.tick(601);
    await t.engine.refresh();
    expect(t.engine.reference(t.o).pausedBy).toEqual([]);
  });
  it('respects a source\'s minimum interval (the plan\'s rate limit) and prices SOL and ETH markets with their own asset', async () => {
    const t = setup(`${BASE}[pricing.sources.coingecko]\nmin_interval_seconds = 30\n[markets.eth.buy_xmr]\nenabled = false\n`);
    await t.engine.refresh();
    t.tick(10);
    await t.engine.refresh();
    expect(t.calls.filter((c) => c === 'coingecko')).toHaveLength(1);
    t.tick(25);
    await t.engine.refresh();
    expect(t.calls.filter((c) => c === 'coingecko')).toHaveLength(2);
    expect(t.engine.reference({ market: 'eth', source: 'coingecko', fallbacks: [], crossCheck: null })).toMatchObject({ xmrUsd: 400, assetUsd: 3000 });
    expect(t.engine.usd('sol')).toBe(150);
    expect(t.engine.usd('usdc_sol')).toBe(1);
  });
});
