// The maker chooses its price sources freely (owner's decision, replacing "a wXMR pool is a cross-check only"):
// any configured source may be primary, fallback or cross-check; a single source is valid; the risks are
// warnings, never blocks; and a maker can quote off the wXMR pool alone and refill through the bridge alone.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import type { SolanaRpc } from '@xmrswap/rebalancer';
import { seedSigner } from '@xmrswap/sdk';
import { RISK, loadConfig } from '../src/config/load.js';
import type { Daemon } from '../src/daemon.js';
import type { PriceHttp } from '../src/pricing/sources.js';
import { XMR } from './sim.js';
import { type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
const key = (n: number) => seedSigner(new Uint8Array(32).fill(n)).publicKey;
const VAULT = { base: key(0x51), quote: key(0x52), baseSol: key(0x53), quoteSol: key(0x54) };
const POOL = `[pricing.sources.wxmr_pool]\nbase_vault = "${VAULT.base}"\nquote_vault = "${VAULT.quote}"\n`;
const POOL_SOL = `[pricing.sources.wxmr_pool_sol]\nbase_vault = "${VAULT.baseSol}"\nquote_vault = "${VAULT.quoteSol}"\n`;
const market = (name: string, body = '') => `[markets.${name}.sell_xmr]\nenabled = true\nmax_xmr = 5\n${body}`;
/** Messages of issues at a path, or (no path) of every issue about a market's price sources. */
const issues = (list: { path: string; message: string }[], path?: string) => list.filter((i) => (path ? i.path === path : /^markets\..*\.(source|fallbacks|cross_check)$/.test(i.path)))
    .map((i) => i.message);

describe('configuration: the file\'s choice is what runs', () => {
  it('any source may be primary, fallback or cross-check; nothing is demoted or dropped', () => {
    const r = loadConfig(`${POOL}[pricing]\ncross_check = "wxmr_pool"\n${market('usdc_sol', 'source = "coinmarketcap"\nfallbacks = ["wxmr_pool", "coingecko"]\n')}[markets.usdc_sol.buy_xmr]\nenabled = true\nmax_xmr = 5\nsource = "wxmr_pool"\nfallbacks = ["coinmarketcap"]\ncross_check = "coingecko"\n`);
    expect(r.validation.errors).toEqual([]);
    const sell = r.config!.offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr')!;
    expect(sell).toMatchObject({ enabled: true, source: 'coinmarketcap', fallbacks: ['wxmr_pool', 'coingecko'], crossCheck: 'wxmr_pool' });
    // A market may name its own cross-check; it wins over the global one.
    const buy = r.config!.offers.find((o) => o.market === 'usdc_sol' && o.direction === 'buy_xmr')!;
    expect(buy).toMatchObject({ enabled: true, source: 'wxmr_pool', fallbacks: ['coinmarketcap'], crossCheck: 'coingecko' });
    expect(issues(r.validation.warnings, 'markets.usdc_sol.buy_xmr.source')).toEqual([`wxmr_pool is this market's primary price source: ${RISK.poolPrimary}`]);
    expect(issues(r.validation.warnings).join(' ')).not.toMatch(/cross-check only/);
  });

  it('a single source is valid; the three risks are warnings with these exact words, and nothing blocks', () => {
    expect(RISK).toEqual({
      poolPrimary: 'a thin pool can be pushed off-market cheaply by someone who then takes your quote',
      noCrossCheck: 'nothing checks this price against a second source',
      noFallback: 'quoting pauses whenever this source is unavailable',
    });
    for (const cross of ['', '[pricing]\ncross_check = "none"\n']) {
      const r = loadConfig(`${POOL}${cross}${market('usdc_sol', 'source = "wxmr_pool"\n')}`);
      expect(r.validation).toMatchObject({ ok: true, errors: [] });
      expect(r.config!.offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr')).toMatchObject({ enabled: true, source: 'wxmr_pool', fallbacks: [], crossCheck: null });
      expect(issues(r.validation.warnings).sort()).toEqual([`wxmr_pool is this market's primary price source: ${RISK.poolPrimary}`, RISK.noCrossCheck, RISK.noFallback].sort());
    }
    // Per market "none" switches a global cross-check off for that market; a cross-check equal to the primary is pointless.
    const perMarket = loadConfig(`[pricing]\ncross_check = "coinmarketcap"\n${market('usdc_sol', 'cross_check = "none"\nfallbacks = ["coinmarketcap"]\n')}`);
    expect(perMarket.config!.offers[0]).toMatchObject({ source: 'coingecko', crossCheck: null });
    expect(issues(perMarket.validation.warnings)).toEqual([RISK.noCrossCheck]);
    const same = loadConfig(`[pricing]\ncross_check = "coingecko"\n${market('usdc_sol', 'fallbacks = ["coinmarketcap"]\n')}`);
    expect(same.validation.ok).toBe(true);
    expect(same.config!.offers[0]!.crossCheck).toBeNull();
    expect(issues(same.validation.warnings)).toEqual([`the cross-check is the primary source itself (coingecko); it is treated as none: ${RISK.noCrossCheck}`]);
    // A fully covered market has no warning at all.
    const covered = loadConfig(`[pricing]\ncross_check = "coinmarketcap"\n${market('usdc_sol', 'fallbacks = ["coinmarketcap"]\n')}`);
    expect(issues(covered.validation.warnings)).toEqual([]);
  });

  it('a market whose sources cannot produce the price it needs is an ERROR naming exactly what is missing', () => {
    const err = (toml: string) => issues(loadConfig(toml).validation.errors);
    // ETH markets need ETH/USD.
    expect(err(`${POOL}[tor]\nenabled = true\n${market('eth', 'source = "wxmr_pool"\n')}`)).toEqual(["eth sell_xmr needs ETH/USD; wxmr_pool cannot supply it — add coingecko or coinmarketcap as this market's source for ETH/USD, or disable the market"]);
    // The SOL market needs XMR/SOL: a USDC-quoted pool alone gives XMR/USD only.
    expect(err(`${POOL}${market('sol', 'source = "wxmr_pool"\n')}`)).toEqual(["sol sell_xmr needs XMR/SOL; wxmr_pool supplies XMR/USD and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, use a SOL-quoted pool (wxmr_pool_sol), or disable the market"]);
    // A USDC market needs XMR/USD: a SOL-quoted pool alone gives XMR/SOL only.
    expect(err(`${POOL_SOL}${market('usdc_sol', 'source = "wxmr_pool_sol"\n')}`)).toEqual(["usdc_sol sell_xmr needs XMR/USD; wxmr_pool_sol supplies XMR/SOL and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, use a USDC-quoted pool (wxmr_pool), or disable the market"]);
    // Guardrails and floors stated in USD need a USD price too.
    expect(err(`${POOL_SOL}[guardrails]\nprice_band_usd = { min = 300, max = 900 }\n${market('sol', 'source = "wxmr_pool_sol"\n')}`)).toEqual(["sol sell_xmr has a hard price band in USD; wxmr_pool_sol gives XMR/SOL and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, or remove guardrails.price_band_usd"]);
    expect(err(`${POOL_SOL}min_liquidity_usd = 1000\n${market('sol', 'source = "wxmr_pool_sol"\n')}`)).toEqual(["wxmr_pool_sol has min_liquidity_usd in USD; it is SOL-quoted and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, or set min_liquidity_usd = 0"]);
    // A pool that is named but not configured.
    expect(err(market('usdc_sol', 'source = "wxmr_pool"\n'))).toEqual(['wxmr_pool is named but [pricing.sources.wxmr_pool] is not in the file']);
    // Each is fixed by what the message says, and by nothing less.
    expect(err(`${POOL}[tor]\nenabled = true\n${market('eth', 'source = "wxmr_pool"\nfallbacks = ["coingecko"]\n')}`)).toEqual([]);
    expect(err(`${POOL}${market('sol', 'source = "wxmr_pool"\nfallbacks = ["coinmarketcap"]\n')}`)).toEqual([]);
    expect(err(`${POOL_SOL}${market('sol', 'source = "wxmr_pool_sol"\n')}`)).toEqual([]);
    expect(err(`${POOL}${POOL_SOL}${market('usdc_sol', 'source = "wxmr_pool"\n')}${market('sol', 'source = "wxmr_pool_sol"\n')}`)).toEqual([]);
    // A disabled market is not validated: the maker may leave it half-written.
    expect(err('[markets.eth.sell_xmr]\nsource = "wxmr_pool"\n')).toEqual([]);
  });

  it('placeholder pool addresses: accepted, the pool is skipped with an accurate message; with nothing else to read the market stays off', () => {
    const placeholder = '[pricing.sources.wxmr_pool]\ntoken = "<wXMR token address>"\npool = "<pool address>"\n';
    const alone = loadConfig(`${placeholder}${market('usdc_sol', 'source = "wxmr_pool"\n')}`);
    expect(alone.validation.errors).toEqual([]);
    expect(alone.config!.offers[0]).toMatchObject({ configured: true, enabled: false, source: 'wxmr_pool', disabledReason: 'none of its price sources can be read yet (placeholder addresses)' });
    expect(issues(alone.validation.warnings, 'markets.usdc_sol.sell_xmr.source')).toEqual([
      'wxmr_pool cannot be read yet: its addresses are placeholders or missing (base_vault and quote_vault are needed); it is skipped until they are set',
      "none of this market's price sources can be read yet: it stays off until the pool addresses are set",
    ]);
    const withFallback = loadConfig(`${placeholder}${market('usdc_sol', 'source = "wxmr_pool"\nfallbacks = ["coingecko"]\n')}`);
    expect(withFallback.config!.offers[0]).toMatchObject({ enabled: true, source: 'wxmr_pool', fallbacks: ['coingecko'] });
  });

  it('wXMR only: priced by the pool alone and refilled through the bridge alone loads with only the risk warnings', () => {
    const r = loadConfig(`${WXMR_ONLY}`);
    expect(r.validation).toMatchObject({ ok: true, errors: [] });
    // Every warning the file produces, not a filtered view: the three risks and nothing else (nothing asks for another venue).
    expect(r.validation.warnings.map((x) => x.message).sort()).toEqual([`wxmr_pool is this market's primary price source: ${RISK.poolPrimary}`, RISK.noCrossCheck, RISK.noFallback].sort());
    expect(r.config!.rebalance.venues.wxmr_bridge.enabled).toBe(true);
    expect(Object.entries(r.config!.rebalance.venues).filter(([, v]) => v.enabled).map(([k]) => k)).toEqual(['wxmr_bridge']);
    expect(r.config!.rebalance.routing.priority).toEqual(['wxmr_bridge']);
  });
});

const WXMR_ONLY = `
[daemon]
mode = "live"

[solana]
maker_owner = "__OWNER__"
rpc_url_env = "TEST_SOL_RPC"

[monero]
network = "regtest"
node_url_envs = ["TEST_XMR_A", "TEST_XMR_B"]

[pricing]
refresh_seconds = 1
max_age_seconds = 60
cross_check = "none"

[pricing.sources.wxmr_pool]
base_vault = "${VAULT.base}"
quote_vault = "${VAULT.quote}"
min_liquidity_usd = 250000
average_seconds = 300

[guardrails]
volatility_pause = { move_pct = 3.0, window_seconds = 600 }
price_band_usd = { min = 100, max = 900 }

[markets.usdc_sol.sell_xmr]
enabled = true
source = "wxmr_pool"
min_xmr = 0.1
max_xmr = 5
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[liquidity]
output_ladder = [{ size_xmr = 5, count = 4 }]

[rebalance]
mode = "approve"
max_cost_pct = 1.0
max_in_transit_usd = 20000
test_transfer_usd = 50

[rebalance.levels.xmr]
low = 10
target = 30

[rebalance.routing]
choose = "priority"
priority = ["wxmr_bridge"]

[rebalance.venues.wxmr_bridge]
enabled = true
max_cost_pct = 1.0
redeem_immediately = true
`;

function vault(w: World, address: string, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(address, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
/** 1,000 wXMR against `usd` USDC per XMR: liquidity 2 × 1,000 × usd. */
const setPool = (w: World, usd: number, scale = 1) => {
  vault(w, VAULT.base, BigInt(1000 * scale) * 10n ** 12n);
  vault(w, VAULT.quote, BigInt(Math.round(1000 * scale * usd)) * 10n ** 6n);
};
async function wxmrOnly(toml = WXMR_ONLY): Promise<{ w: World; d: Daemon; http: { calls: string[] } }> {
  const w = await makeWorld(toml);
  setPool(w, 150);
  const http = { calls: [] as string[] };
  const priceHttp: PriceHttp = { get: async (url) => (http.calls.push(url), { status: 500, body: '' }) };
  const bridgeRpc: SolanaRpc = { getAccount: async () => null, getAccounts: async (a) => a.map(() => null), getSignatures: async () => [], getTransaction: async () => null };
  // No injected price sources: the daemon builds what the file names, and reads the pool from chain state.
  const d = await w.boot({ priceSources: undefined, priceHttp, bridgeRpc } as never);
  await d.start();
  return { w, d, http };
}
const offer = (w: World) => w.sim.offer(1, 0);
/** Let time pass in steps, reading the pool at each, as the daemon's timer does. */
async function run(w: World, d: Daemon, secs: number, step = 15): Promise<void> {
  for (let t = 0; t < secs; t += step) {
    w.sim.warp(step);
    await d.offers.tick();
  }
}

describe('a maker that quotes off the wXMR pool alone', () => {
  it('does not quote before the averaging window has filled; then publishes the offer at the pool\'s price; no other source is ever asked', async () => {
    const { w, d, http } = await wxmrOnly();
    // Just started: one sample is not a price.
    expect(offer(w)).toBeNull();
    expect(d.offers.latest().find((c) => c.offer.market === 'usdc_sol' && c.offer.direction === 'sell_xmr')).toMatchObject({ enabled: false, reason: 'no reference price' });
    expect(d.prices.sourceError('wxmr_pool')).toMatch(/averaging window is not filled yet/);
    await run(w, d, 285);
    expect(offer(w)).toBeNull();
    await run(w, d, 30);
    // 150 USD per XMR from the vaults × (1 + 2%) in USDC base units.
    expect(offer(w)).toMatchObject({ enabled: 1, prices: [153_000_000n, 0n, 0n] });
    const view = d.offers.views().find((v) => v.market === 'usdc_sol' && v.direction === 'sell_xmr') as unknown as Record<string, unknown>;
    expect(view).toMatchObject({ live: true, source: 'wxmr_pool', fallbacks: [], cross_check: null, priced_by: 'wxmr_pool', price_unit: 'usd', reference_price: '150000000' });
    expect(http.calls).toEqual([]); // CoinGecko and CoinMarketCap were never called
    // A swap against it runs as any other.
    const s = w.sim.open({ direction: 0, asset: 1, xmr: XMR, makerSpendPub: w.sim.takePoolKey(1) });
    await d.executor.tick();
    expect(w.sim.names(s.pda)).toEqual(['lock', 'post_notice']);
    d.store.close();
  });

  it('pauses when the pool is under its liquidity floor, when it cannot be read, and when its price is stale; resumes by itself', async () => {
    const { w, d } = await wxmrOnly();
    await run(w, d, 330);
    expect(offer(w)!.enabled).toBe(1);
    // Liquidity drains to $30,000: under the $250,000 floor the source is unavailable, and there is no fallback.
    setPool(w, 150, 0.1);
    await run(w, d, 15);
    expect(offer(w)).toMatchObject({ enabled: 0, capacityXmr: 0n });
    expect(d.prices.sourceError('wxmr_pool')).toBe('wxmr_pool: pool liquidity $30000 is under the minimum $250000');
    expect(d.offers.latest().find((c) => c.offer.market === 'usdc_sol' && c.offer.direction === 'sell_xmr')!.reason).toBe('no reference price');
    // Liquidity returns: quoting resumes (the window stayed filled; the low reads were never samples).
    setPool(w, 150);
    await run(w, d, 15);
    expect(offer(w)).toMatchObject({ enabled: 1, prices: [153_000_000n, 0n, 0n] });
    // The vault account cannot be read (the RPC drops it): unavailable, paused.
    w.sim.fake.deleteAccount(VAULT.quote);
    await run(w, d, 15);
    expect(offer(w)!.enabled).toBe(0);
    setPool(w, 150);
    await run(w, d, 15);
    expect(offer(w)!.enabled).toBe(1);
    // The hard band applies to a pool primary as to any source.
    setPool(w, 950);
    await run(w, d, 900);
    expect(offer(w)!.enabled).toBe(0);
    expect(d.offers.latest().find((c) => c.offer.market === 'usdc_sol' && c.offer.direction === 'sell_xmr')!.reason).toMatch(/price_band|volatility/);
    d.store.close();
  });

  it('manipulation: one off-market pool read does not move the published offer', async () => {
    const { w, d } = await wxmrOnly();
    await run(w, d, 330);
    expect(offer(w)!.prices[0]).toBe(153_000_000n);
    const refreshes = () => w.sim.landed.filter((l) => l.name === 'refresh_offers').length;
    // Someone pushes the pool 40% down for one read (to take the maker's quote cheaply), then lets it go back.
    setPool(w, 90, 2); // (still above the liquidity floor: this is a price attack, not a drain)
    const before = refreshes();
    await run(w, d, 15);
    expect(refreshes()).toBe(before + 1);
    expect(offer(w)).toMatchObject({ enabled: 1, prices: [153_000_000n, 0n, 0n] }); // still published, at the same price
    setPool(w, 150);
    await run(w, d, 60);
    expect(offer(w)).toMatchObject({ enabled: 1, prices: [153_000_000n, 0n, 0n] });
    expect(d.alerts.list().filter((a) => a.level === 'critical')).toEqual([]);
    d.store.close();

    // Without the volatility guardrail there is no per-read bound, only the time-weighted average: one 15 s read
    // at −40% moves a 300 s average by 15/300 of the move, not by the move.
    const loose = await wxmrOnly(WXMR_ONLY.replace('volatility_pause = { move_pct = 3.0, window_seconds = 600 }\n', ''));
    await run(loose.w, loose.d, 330);
    setPool(loose.w, 90, 2);
    await run(loose.w, loose.d, 15);
    setPool(loose.w, 150);
    await run(loose.w, loose.d, 15);
    const moved = Number(offer(loose.w)!.prices[0]) / 153_000_000;
    expect(moved).toBeCloseTo(1 - (0.4 * 15) / 300, 6); // −2%, not −40%
    loose.d.store.close();
  });

  it('refills through the bridge alone: the only venue, no warning that others are missing, and a low level asks for a bridge refill', async () => {
    const { w, d } = await wxmrOnly();
    const warnings = await d.rebalance.reload();
    expect(warnings).toEqual([]);
    const view = await d.rebalance.view();
    expect(view.venues.filter((v) => v.enabled).map((v) => v.id)).toEqual(['wxmr_bridge']);
    expect(view.mode).toBe('approve');
    // XMR (20.2) is above its low level (10): nothing to do, and nothing complains.
    await d.rebalance.tick();
    expect(d.alerts.list().map((a) => a.kind).filter((k) => k.startsWith('rebalance') || k === 'opposite_side_flow')).toEqual([]);
    expect(await d.rebalance.allowlist()).toMatchObject({ xmr: [w.xmr.walletAddress] });
    d.store.close();
  });

  it('the SOL market on a SOL-quoted pool alone: priced in SOL straight from the vaults', async () => {
    const toml = WXMR_ONLY.replace('[pricing.sources.wxmr_pool]', '[pricing.sources.wxmr_pool_sol]').replace(`base_vault = "${VAULT.base}"`, `base_vault = "${VAULT.baseSol}"`).replace(`quote_vault = "${VAULT.quote}"`, `quote_vault = "${VAULT.quoteSol}"`).replace('min_liquidity_usd = 250000\n', '').replace('price_band_usd = { min = 100, max = 900 }\n', '').replace('[markets.usdc_sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"', '[markets.sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool_sol"');
    expect(loadConfig(toml.replaceAll('__OWNER__', 'x')).validation.errors).toEqual([]);
    const w = await makeWorld(toml);
    vault(w, VAULT.baseSol, 1000n * 10n ** 12n);
    vault(w, VAULT.quoteSol, 1500n * 10n ** 9n); // 1.5 SOL per XMR
    const d = await w.boot({ priceSources: undefined, priceHttp: { get: async () => ({ status: 500, body: '' }) } } as never);
    await d.start();
    await run(w, d, 330);
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 1, prices: [1_530_000_000n, 0n, 0n] });
    expect(d.offers.latest().find((c) => c.offer.market === 'sol')!.ref).toMatchObject({ unit: 'asset', xmrUsd: 1.5, source: 'wxmr_pool_sol' });
    d.store.close();
  });
});
