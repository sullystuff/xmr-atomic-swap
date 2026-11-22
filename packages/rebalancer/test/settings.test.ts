import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SettingsError, VENUE_IDS, createAdapters, evaluateLevels, parseRebalanceSettings, parseRebalanceToml, venueOrder } from '../src/index.js';
import { ALLOW, FixtureHttp, prices } from './helpers.js';

const design = readFileSync(fileURLToPath(new URL('../../../docs/DESIGN.md', import.meta.url)), 'utf8');
const tomlBlocks = [...design.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1]!);
const rebalanceBlock = tomlBlocks.find((b) => b.includes('[rebalance]'));

describe("DESIGN's example [rebalance] settings", () => {
  it('is present in docs/DESIGN.md', () => {
    expect(rebalanceBlock).toBeDefined();
    expect(tomlBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it('parses unchanged, with every value as written', () => {
    const { settings: s } = parseRebalanceToml(rebalanceBlock!);
    expect(s.mode).toBe('approve');
    expect(s.max_cost_pct).toBe(1.5);
    expect(s.max_in_transit_usd).toBe(50_000);
    expect(s.test_transfer_usd).toBe(50);
    expect(s.levels.xmr).toEqual({ low: 150, target: 400, high: 700 });
    expect(s.levels.usdc_sol).toEqual({ high: 120_000 });
    expect(s.routing).toMatchObject({
      choose: 'best_quote', priority: ['wxmr_bridge', 'exchange', 'changenow', 'fixedfloat', 'stealthex', 'houdiniswap'],
      max_per_tx_usd: 20_000, max_per_day_usd: 150_000, cooldown_minutes: 30, venue_timeout_minutes: 120,
    });
    expect(s.venues.wxmr_bridge).toEqual({
      enabled: true, max_cost_pct: 1.0, max_piece_pct_of_pool: 2.0, max_wxmr_held: 5, redeem_immediately: true, require_heartbeat: true,
      reserve_proof_check_above_xmr: 50, stalled_redeem_minutes: 60,
    });
    expect(s.venues.changenow).toMatchObject({ enabled: true, rate: 'fixed', api_key_env: 'CHANGENOW_KEY' });
    expect(s.venues.fixedfloat).toMatchObject({ enabled: true, rate: 'float', api_key_env: 'FF_KEY' });
    expect(s.venues.exchange).toMatchObject({ name: '<exchange>', api_key_env: 'EXCHANGE_KEY', withdraw_address_allowlist: true });
    expect(s.venues.stealthex.enabled).toBe(false);
    expect(s.venues.houdiniswap.enabled).toBe(false);
  });

  it('keeps the placeholder exchange off and says why', () => {
    const { settings, warnings } = parseRebalanceToml(rebalanceBlock!);
    expect(settings.venues.exchange.enabled).toBe(false);
    expect(warnings).toContain('rebalance.venues.exchange.name is a placeholder (<exchange>); the venue stays off');
    expect(warnings.some((w) => w.includes('fixedfloat has no api_secret_env'))).toBe(true);
  });

  it('parses when both example files are concatenated; other sections are not this package\'s to judge', () => {
    const { settings } = parseRebalanceToml(tomlBlocks.join('\n'));
    expect(settings.mode).toBe('approve');
  });
});

describe('defaults and validation', () => {
  it('everything is off by default: no venue enabled, mode alert, no cross-chain moves', () => {
    const { settings: s, warnings } = parseRebalanceSettings(undefined);
    expect(s.mode).toBe('alert');
    for (const id of VENUE_IDS) expect(s.venues[id].enabled).toBe(false);
    expect(s.cross_chain.enabled).toBe(false);
    expect(s.allowlist).toEqual({ xmr: [], sol: [], eth: [] });
    expect(s.routing.priority).toEqual([...VENUE_IDS]);
    expect(warnings.some((w) => w.includes('max_in_transit_usd is not set'))).toBe(true);
  });

  it('StealthEX and HoudiniSwap stay off unless enabled explicitly, and enabling them warns that XMR support is unconfirmed', () => {
    const { settings, warnings } = parseRebalanceSettings({ venues: { stealthex: { enabled: true, api_key_env: 'SX' }, houdiniswap: { enabled: true, api_key_env: 'HK', api_secret_env: 'HS' }, changenow: { api_key_env: 'CN' } } });
    expect(settings.venues.changenow.enabled).toBe(false);
    expect(settings.venues.stealthex.enabled).toBe(true);
    expect(warnings.filter((w) => w.includes('XMR support is unconfirmed'))).toHaveLength(2);
  });

  it('a venue enabled without the name of its key variable stays off', () => {
    const { settings, warnings } = parseRebalanceSettings({ venues: { changenow: { enabled: true } } });
    expect(settings.venues.changenow.enabled).toBe(false);
    expect(warnings).toContain('rebalance.venues.changenow has no api_key_env; the venue stays off');
  });

  it('rejects unknown keys, bad enums and inverted levels, naming the path', () => {
    expect(() => parseRebalanceSettings({ max_cost_pc: 1 })).toThrow(SettingsError);
    expect(() => parseRebalanceSettings({ routing: { max_per_tx: 5 } })).toThrow(/rebalance\.routing/);
    expect(() => parseRebalanceSettings({ mode: 'yolo' })).toThrow(/rebalance\.mode/);
    expect(() => parseRebalanceSettings({ routing: { priority: ['binance'] } })).toThrow(/rebalance\.routing\.priority/);
    expect(() => parseRebalanceSettings({ levels: { xmr: { low: 500, target: 400 } } })).toThrow(/low <= target <= high/);
    expect(() => parseRebalanceSettings({ venues: { wxmr_bridge: { max_cost_pct: -1 } } })).toThrow(/wxmr_bridge\.max_cost_pct/);
    expect(() => parseRebalanceSettings({ routing: { priority: ['changenow', 'changenow'] } })).toThrow(/listed twice/);
    expect(() => parseRebalanceToml('[rebalance\nmode = 1')).toThrow(/not valid TOML/);
  });

  it('a secret never belongs in the file: only *_env names are accepted', () => {
    expect(() => parseRebalanceSettings({ venues: { changenow: { enabled: true, api_key: 'abc' } } })).toThrow(/changenow/);
  });

  it('cross-chain moves need an enabled venue that can do them', () => {
    expect(() => parseRebalanceSettings({ cross_chain: { enabled: true, venue: 'wxmr_bridge' }, venues: { wxmr_bridge: { enabled: true } } })).toThrow(/cannot move USDC/);
    const off = parseRebalanceSettings({ cross_chain: { enabled: true, venue: 'changenow' } });
    expect(off.settings.cross_chain.enabled).toBe(false);
    const on = parseRebalanceSettings({ cross_chain: { enabled: true, venue: 'changenow' }, venues: { changenow: { enabled: true, api_key_env: 'K' } } });
    expect(on.settings.cross_chain.enabled).toBe(true);
  });

  it('per-venue mode and caps are accepted on every venue', () => {
    const { settings } = parseRebalanceSettings({ venues: { fixedfloat: { enabled: true, api_key_env: 'K', api_secret_env: 'S', mode: 'auto', max_per_tx_usd: 500, max_per_day_usd: 2000, max_share_pct: 25, max_cost_pct: 2 } } });
    expect(settings.venues.fixedfloat).toMatchObject({ mode: 'auto', max_per_tx_usd: 500, max_per_day_usd: 2000, max_share_pct: 25, max_cost_pct: 2 });
  });

  it('appends enabled venues missing from the priority list', () => {
    const { settings } = parseRebalanceSettings({ routing: { priority: ['fixedfloat'] } });
    expect(venueOrder(settings)).toEqual(['fixedfloat', 'wxmr_bridge', 'exchange', 'changenow', 'stealthex', 'houdiniswap']);
  });
});

describe('level triggers', () => {
  it('refills below low up to target, drains above high down to target', () => {
    const { settings } = parseRebalanceToml(rebalanceBlock!);
    expect(evaluateLevels(settings, { xmr: 120, usdc_sol: 130_000 })).toEqual([{ asset: 'xmr', kind: 'refill', amount: 280 }, { asset: 'usdc_sol', kind: 'drain', amount: 10_000 }]);
    expect(evaluateLevels(settings, { xmr: 150, usdc_sol: 120_000 })).toEqual([]);
    expect(evaluateLevels(settings, { xmr: 800 })).toEqual([{ asset: 'xmr', kind: 'drain', amount: 400 }]);
  });
});

describe('createAdapters', () => {
  it('builds only enabled venues; the bridge needs an RPC and a wallet; an unknown exchange name builds nothing', () => {
    const { settings } = parseRebalanceToml(rebalanceBlock!);
    const built = createAdapters({ settings, allowlist: ALLOW, http: new FixtureHttp([]), prices: prices(), env: () => undefined });
    expect(Object.keys(built.adapters).sort()).toEqual(['changenow', 'fixedfloat']);
    expect(built.warnings).toEqual(['the wXMR bridge is enabled but no Solana RPC or wallet was supplied; the bridge venue is off']);

    const withExchange = parseRebalanceSettings({ venues: { exchange: { enabled: true, name: 'someexchange', api_key_env: 'K', api_secret_env: 'S' } } }).settings;
    expect(createAdapters({ settings: withExchange, http: new FixtureHttp([]), prices: prices() }).warnings[0]).toMatch(/"someexchange" has no driver/);
    const kraken = parseRebalanceSettings({ venues: { exchange: { enabled: true, name: 'kraken', api_key_env: 'K', api_secret_env: 'S' } } }).settings;
    expect(Object.keys(createAdapters({ settings: kraken, http: new FixtureHttp([]), prices: prices() }).adapters)).toEqual(['exchange']);
  });
});
