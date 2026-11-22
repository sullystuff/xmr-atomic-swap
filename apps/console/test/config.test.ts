import { describe, expect, it } from 'vitest';
import type { ConfigValidation } from '@xmrswap/protocol/daemon-api';
import { APPROVAL_WINDOW_REASON } from '../src/lib/config/schema.js';
import { ConfigSyntaxError, diffConfig, getPath, parseToml, revisionOf, setPath, stringifyToml, type Toml } from '../src/lib/config/toml.js';
import type { ValidateContext } from '../src/lib/config/validate.js';
import { autoClaimDelayMinutes, issuesAt, minClaimDelayMinutes, minClaimDelaySecs, resolveOffer, validateConfig, withDefaults } from '../src/lib/config/validate.js';
import { DESIGN_BOTH_TOML, DESIGN_CONFIG_TOML, DESIGN_REBALANCE_TOML } from './design.js';

const ctx = { blobEndpoint: true, solUsd: 187.42 };
const check = (toml: string, c: ValidateContext = ctx): ConfigValidation => validateConfig(parseToml(toml), c);
const offer = (body: string, market = 'usdc_sol', dir = 'sell_xmr'): string => `[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n[markets.${market}.${dir}]\nenabled = true\n${body}\n`;
const messages = (list: { path: string; message: string }[], path: string): string => issuesAt(list, path).map((i) => i.message).join(' | ');

describe('DESIGN example files', () => {
  it('the configuration example passes unchanged', () => {
    const v = check(DESIGN_CONFIG_TOML);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    // Three markets are on; eth sell is off in the file.
    expect(v.effective.map((e) => `${e.market}.${e.direction}`)).toEqual(['usdc_sol.sell_xmr', 'sol.sell_xmr', 'usdc_eth.sell_xmr']);
  });
  it('the rebalancing example passes unchanged', () => {
    const v = check(DESIGN_REBALANCE_TOML);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    // "<exchange>" is a placeholder: accepted, warned about.
    expect(messages(v.warnings, 'rebalance.venues.exchange.name')).toMatch(/placeholder/);
  });
  it('both pass concatenated', () => {
    const v = check(DESIGN_BOTH_TOML);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });
  it('survives a round trip through the form’s serialiser', () => {
    const parsed = parseToml(DESIGN_BOTH_TOML);
    const again = parseToml(stringifyToml(parsed));
    expect(again).toEqual(parsed);
    expect(diffConfig(parsed, again)).toEqual([]);
  });

  it('demotes the wXMR pool to a cross-check and says so', () => {
    const cfg = parseToml(DESIGN_CONFIG_TOML);
    const v = validateConfig(cfg, ctx);
    expect(messages(v.warnings, 'markets.sol.sell_xmr.source')).toMatch(/wXMR pool may only be a cross-check\. "coingecko" is promoted to primary/);
    const o = resolveOffer(cfg, 'sol', 'sell_xmr', ctx);
    expect(o.source).toBe('coingecko');
    expect(o.crossCheck).toBe('wxmr_pool');
    expect(o.terms.enabled).toBe(true);
    // Its addresses are placeholders in the example, so that cross-check is off until they are filled in.
    expect(messages(v.warnings, 'markets.sol.sell_xmr.source')).toMatch(/placeholders/);
    expect(messages(v.warnings, 'pricing.sources.wxmr_pool.token')).toMatch(/placeholder/);
  });
  it('keeps a market off when the pool is its only source', () => {
    const v = check(offer('source = "wxmr_pool"'));
    expect(v.ok).toBe(true);
    expect(messages(v.warnings, 'markets.usdc_sol.sell_xmr.source')).toMatch(/no fallback to promote, so this market stays off/);
    expect(v.effective).toEqual([]);
  });

  it('an Ethereum market without a blob endpoint is a warning that keeps it off', () => {
    const v = check(DESIGN_CONFIG_TOML, { blobEndpoint: false, solUsd: null });
    expect(v.ok).toBe(true);
    expect(messages(v.warnings, 'markets.usdc_eth.sell_xmr.enabled')).toMatch(/need a blob endpoint/);
    expect(v.effective.map((e) => e.market)).toEqual(['usdc_sol', 'sol']);
  });

  it('resolves "auto" claim delays from the deepest depth in use', () => {
    const v = check(DESIGN_CONFIG_TOML);
    const by = Object.fromEntries(v.effective.map((e) => [e.market, e]));
    // usdc_sol accepts up to 200 XMR, so the 25-confirmation tier is in use: 101 minutes on Solana.
    expect(by.usdc_sol?.claim_delay_secs).toBe(101 * 60);
    expect(by.usdc_sol?.min_claim_delay_secs).toBe(6_015);
    // sol takes its largest swap from the ladder (50 XMR), which also reaches depth 25.
    expect(by.sol?.claim_delay_secs).toBe(101 * 60);
    // Ethereum: the default is 180 minutes; the bound at depth 25 is 170.
    expect(by.usdc_eth?.claim_delay_secs).toBe(180 * 60);
    expect(by.usdc_eth?.min_claim_delay_secs).toBe(10_200);
    expect(by.usdc_eth?.approval_window_secs).toBe(120);
    expect(by.usdc_eth?.notice_secs).toBe(1_800);
    expect(by.usdc_eth?.claim_window_secs).toBe(90 * 60);
    expect(by.usdc_sol?.depth_tiers).toEqual([
      { above_xmr: '0', depth: 2 },
      { above_xmr: '1000000000000', depth: 10 },
      { above_xmr: '50000000000000', depth: 25 },
    ]);
  });
});

describe('claim-delay bounds (SPEC 3.1)', () => {
  it('matches the specification’s figures', () => {
    expect([2, 10, 25].map((d) => minClaimDelaySecs('solana', d))).toEqual([3_600, 3_600, 6_015]);
    expect([2, 10, 25].map((d) => minClaimDelaySecs('ethereum', d))).toEqual([7_200, 7_500, 10_200]);
    expect(minClaimDelayMinutes('solana', 25)).toBe(101);
    expect(minClaimDelayMinutes('ethereum', 25)).toBe(170);
    expect(autoClaimDelayMinutes('solana', 10)).toBe(90);
    expect(autoClaimDelayMinutes('solana', 25)).toBe(101);
    expect(autoClaimDelayMinutes('ethereum', 25)).toBe(180);
  });
  it('refuses a claim delay below the contract floor', () => {
    const v = check(offer('max_xmr = 0.5\nclaim_delay_minutes = 45'));
    expect(v.ok).toBe(false);
    expect(messages(v.errors, 'markets.usdc_sol.sell_xmr.claim_delay_minutes')).toMatch(/below the contract's floor of 60 minutes on Solana/);
  });
  it('refuses a claim delay below the minimum implied by the depth', () => {
    const v = check(offer('max_xmr = 200\nclaim_delay_minutes = 90'));
    expect(messages(v.errors, 'markets.usdc_sol.sell_xmr.claim_delay_minutes')).toMatch(/At depth 25 on Solana the minimum is 101 minutes/);
    expect(check(offer('max_xmr = 200\nclaim_delay_minutes = 101')).ok).toBe(true);
    const e = check(offer('max_xmr = 200\nclaim_delay_minutes = 150', 'usdc_eth'));
    expect(messages(e.errors, 'markets.usdc_eth.sell_xmr.claim_delay_minutes')).toMatch(/At depth 25 on Ethereum the minimum is 170 minutes/);
    expect(check(offer('max_xmr = 200\nclaim_delay_minutes = 170', 'usdc_eth')).ok).toBe(true);
  });
  it('a shallower ladder lowers the minimum', () => {
    // Largest swap 5 XMR: the deepest tier in use is 10 confirmations.
    const v = check(offer('claim_delay_minutes = 60'));
    expect(v.ok).toBe(true);
    expect(v.effective[0]?.min_claim_delay_secs).toBe(3_600);
  });
});

describe('offer settings', () => {
  it('caps the deposit at 5%', () => {
    expect(check(offer('deposit_pct = 5')).ok).toBe(true);
    const v = check(offer('deposit_pct = 5.01'));
    expect(v.ok).toBe(false);
    expect(messages(v.errors, 'markets.usdc_sol.sell_xmr.deposit_pct')).toMatch(/at most 5/);
    expect(check(offer('deposit_pct = -1')).ok).toBe(false);
    expect(check(offer('deposit_pct = 2')).effective[0]?.deposit_bps).toBe(200);
  });

  it('warns above a 60-second approval window and says why', () => {
    const at60 = check(offer('approval_mode = "window"\napproval_window_seconds = 60'));
    expect(issuesAt(at60.warnings, 'markets.usdc_sol.sell_xmr.approval_window_seconds')).toEqual([]);
    const v = check(offer('approval_mode = "window"\napproval_window_seconds = 300'));
    expect(v.ok).toBe(true);
    const text = messages(v.warnings, 'markets.usdc_sol.sell_xmr.approval_window_seconds');
    expect(text).toMatch(/300 seconds is longer than the recommended 60 seconds/);
    expect(text).toContain(APPROVAL_WINDOW_REASON);
    expect(text).toMatch(/Takers see a warning/);
  });
  it('bounds the approval window to 30..3,600 seconds', () => {
    expect(check(offer('approval_mode = "window"\napproval_window_seconds = 29')).ok).toBe(false);
    expect(check(offer('approval_mode = "window"\napproval_window_seconds = 3601')).ok).toBe(false);
    expect(check(offer('approval_mode = "window"\napproval_window_seconds = 3600')).ok).toBe(true);
  });
  it('does not warn about the window on a Solana auto-accept offer, which never waits', () => {
    const v = check(offer('approval_window_seconds = 300'));
    expect(issuesAt(v.warnings, 'markets.usdc_sol.sell_xmr.approval_window_seconds')).toEqual([]);
  });
  it('warns on Ethereum by default, where every swap is approved explicitly and the default is 120 s', () => {
    const v = check(offer('', 'usdc_eth'));
    expect(messages(v.warnings, 'markets.usdc_eth.sell_xmr.approval_window_seconds')).toMatch(/120 seconds \(the Ethereum default\)/);
  });

  it('checks the notice window per chain', () => {
    expect(check(offer('notice_seconds = 299')).ok).toBe(false);
    expect(check(offer('notice_seconds = 300')).ok).toBe(true);
    expect(check(offer('notice_seconds = 1499', 'eth')).ok).toBe(false);
    expect(check(offer('notice_seconds = 3601')).ok).toBe(false);
  });
  it('checks the claim window and the final deadline', () => {
    expect(messages(check(offer('claim_window_minutes = 10')).errors, 'markets.usdc_sol.sell_xmr.claim_window_minutes')).toMatch(/at least 11 minutes on Solana/);
    expect(messages(check(offer('claim_window_minutes = 60', 'eth')).errors, 'markets.eth.sell_xmr.claim_window_minutes')).toMatch(/at least 80 minutes on Ethereum/);
    expect(messages(check(offer('final_days = 1')).errors, 'markets.usdc_sol.sell_xmr.final_days')).toMatch(/at least 1\.\d\d days/);
    expect(check(offer('final_days = 31')).ok).toBe(false);
    expect(check(offer('final_days = 30')).ok).toBe(true);
  });
  it('checks sizes and tiers', () => {
    expect(messages(check(offer('min_xmr = 10\nmax_xmr = 5')).errors, 'markets.usdc_sol.sell_xmr.min_xmr')).toMatch(/above the largest/);
    expect(check(offer('size_tiers = [{ above_xmr = 1, extra_pct = 0.1 }, { above_xmr = 2, extra_pct = 0.2 }, { above_xmr = 3, extra_pct = 0.3 }]')).ok).toBe(false);
    expect(check(offer('size_tiers = [{ above_xmr = 5, extra_pct = 0.1 }, { above_xmr = 2, extra_pct = 0.2 }]')).ok).toBe(false);
    expect(check(offer('confirmation_depth = [{ above_xmr = 1, depth = 10 }]')).ok).toBe(false);
    expect(check(offer('confirmation_depth = [{ above_xmr = 0, depth = 0 }]')).ok).toBe(false);
    expect(check(offer('confirmation_depth = [{ above_xmr = 0, depth = 10 }]')).ok).toBe(true);
    expect(check(offer('deviation_pct = -0.5')).ok).toBe(true);
    expect(check(offer('approval_mode = "sometimes"')).ok).toBe(false);
    expect(check(offer('withhold_policy = "by_rule"')).ok).toBe(false);
  });
  it('rejects a primary source repeated as a fallback and unknown sources', () => {
    expect(check(offer('source = "coingecko"\nfallbacks = ["coingecko"]')).ok).toBe(false);
    expect(check(offer('source = "binance"')).ok).toBe(false);
    expect(check(offer('fallbacks = ["kraken"]')).ok).toBe(false);
  });
  it('warns that a per-taker limit cannot bind a Solana auto-accept offer', () => {
    const v = check(`${offer('')}\n[liquidity]\nmax_per_taker_xmr = 20\noutput_ladder = [{ size_xmr = 5, count = 4 }]`.replace('[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n', ''));
    expect(messages(v.warnings, 'markets.usdc_sol.sell_xmr.approval_mode')).toMatch(/per-taker limit cannot be enforced before the fact/);
  });
  it('rejects unknown markets and directions', () => {
    expect(check('[markets.btc.sell_xmr]\nenabled = true').ok).toBe(false);
    expect(check('[markets.sol.swap_xmr]\nenabled = true').ok).toBe(false);
  });
});

describe('the rest of the file', () => {
  it('guardrails', () => {
    expect(check('[guardrails]\nprice_band_usd = { min = 900, max = 300 }').ok).toBe(false);
    expect(check('[guardrails]\nvolatility_pause = { move_pct = 3.0 }').ok).toBe(false);
    expect(check('[guardrails]\nreorg_guard = { enabled = true }').ok).toBe(false);
    expect(check('[guardrails]\nreorg_guard = { enabled = true, raise_depth_to = 30 }\ndry_run = true\nstale_pause = false').ok).toBe(true);
    expect(check('[guardrails]\ndry_run = "yes"').ok).toBe(false);
  });
  it('pricing', () => {
    expect(check('[pricing]\ncross_check = "binance"').ok).toBe(false);
    expect(check('[pricing]\non_failure = "panic"').ok).toBe(false);
    expect(check('[pricing]\nrefresh_seconds = 60\nmax_age_seconds = 30').ok).toBe(false);
    expect(check('[pricing]\non_failure = "widen"\nwiden_pct = 0.75').ok).toBe(true);
  });
  it('secrets never go in the file', () => {
    const v = check('[pricing.sources.coingecko]\napi_key_env = "CG-abc123/secret"');
    expect(v.ok).toBe(false);
    expect(messages(v.errors, 'pricing.sources.coingecko.api_key_env')).toMatch(/name of an environment variable, not the value itself/);
  });
  it('rebalancing', () => {
    expect(messages(check('[rebalance]\nmode = "approve"\nturbo = true').errors, 'rebalance.turbo')).toMatch(/Unknown key/);
    expect(check('[rebalance]\nmode = "manual"').ok).toBe(false);
    expect(check('[rebalance.levels.xmr]\nlow = 500\ntarget = 400').ok).toBe(false);
    expect(check('[rebalance.levels.btc]\nlow = 1').ok).toBe(false);
    expect(check('[rebalance.venues.binance]\nenabled = true').ok).toBe(false);
    expect(check('[rebalance.routing]\npriority = ["wxmr_bridge", "binance"]').ok).toBe(false);
    expect(check('[rebalance.venues.exchange]\nenabled = true\nname = "binance"\napi_key_env = "K"').ok).toBe(false);
    expect(check('[rebalance.venues.exchange]\nenabled = true\nname = "kraken"\napi_key_env = "K"').ok).toBe(true);
    expect(check('[rebalance.cross_chain]\nenabled = true\nvenue = "changenow"').ok).toBe(false);
    expect(check('[rebalance.cross_chain]\nenabled = true\nvenue = "changenow"\n[rebalance.venues.changenow]\nenabled = true\napi_key_env = "K"').ok).toBe(true);
    const w = check('[rebalance.venues.houdiniswap]\nenabled = true\napi_key_env = "K"\napi_secret_env = "S"');
    expect(messages(w.warnings, 'rebalance.venues.houdiniswap.enabled')).toMatch(/XMR support is unconfirmed/);
    expect(messages(check('[rebalance]\nmode = "auto"').warnings, 'rebalance.max_in_transit_usd')).toMatch(/without an in-transit cap/);
  });
  it('operation sections', () => {
    expect(check('[monero]\nnode_url_envs = ["NODE_A"]').ok).toBe(false);
    expect(check('[monero]\nnode_url_envs = ["NODE_A"]\nown_node = true').ok).toBe(true);
    expect(check('[monero]\nnode_url_envs = ["NODE_A", "NODE_B"]').ok).toBe(true);
    expect(check('[daemon]\napi_bind = "0.0.0.0:7071"').ok).toBe(false);
    expect(check('[daemon]\napi_bind = "127.0.0.1:7071"\nmode = "live"').ok).toBe(true);
    expect(check('[daemon]\nmode = "turbo"').ok).toBe(false);
    expect(check('[approvals]\nallow = ["A"]\ndeny = ["A"]').ok).toBe(false);
    expect(check('[rotation]\ninterval_hours = -1').ok).toBe(false);
    expect(check('[inbox]\npolicy = "swap_only"').ok).toBe(true);
    // The daemon's schema is strict: a key or section it does not know is an error.
    expect(messages(check('[mystery]\nx = 1').errors, 'mystery')).toMatch(/Unknown section/);
    expect(messages(check('[offers]\nturbo = true').errors, 'offers.turbo')).toMatch(/Unknown key/);
    expect(check('[daemon]\nconsole_dir = "./console"\ncors_origins = ["http://127.0.0.1:5183"]\n[ethereum]\nfrom_block = 100\n[registration]\ncontacts = [{ kind = 5, value = "https://blobs.example.org" }]').ok).toBe(true);
    expect(check('[guardrails]\nvolatility_pause = false\nprice_band_usd = false').ok).toBe(true);
  });
  it('estimates the update cost with the file', () => {
    const v = check('[offers]\nupdate_interval_seconds = 1');
    expect(v.update_cost).toMatchObject({ interval_secs: 1, lamports_per_update: '5000', daily_lamports: '432000000' });
    expect(v.update_cost?.daily_usd).toBeCloseTo(0.432 * 187.42, 6);
    expect(check('').update_cost?.daily_lamports).toBe('28800000');
    const p = check('[offers]\nupdate_interval_seconds = 60\n[solana]\npriority_fee_microlamports = 10000');
    expect(p.update_cost?.lamports_per_update).toBe('5242');
    const t = check('[offers]\nupdate_interval_seconds = 5\nprice_move_trigger_pct = 0.2\nmin_refresh_interval_seconds = 30');
    expect(t.update_cost?.triggered_per_day.max).toBe(2_880);
    expect(check('[offers]\nupdate_interval_seconds = 0').ok).toBe(false);
  });
  it('warns when offers lapse between updates', () => {
    const v = check(`${offer('offer_valid_seconds = 20')}\n[offers]\nupdate_interval_seconds = 30`);
    expect(messages(v.warnings, 'markets.usdc_sol.sell_xmr.offer_valid_seconds')).toMatch(/off between updates/);
  });
});

describe('TOML helpers', () => {
  it('reports the line of a syntax error', () => {
    expect(() => parseToml('[pricing]\nrefresh_seconds = = 3')).toThrow(ConfigSyntaxError);
    try {
      parseToml('[pricing]\nrefresh_seconds = = 3');
    } catch (e) {
      expect((e as ConfigSyntaxError).line).toBe(2);
    }
  });
  it('sets and removes paths without mutating', () => {
    const a: Toml = { markets: { sol: { sell_xmr: { enabled: true } } } };
    const b = setPath(a, 'markets.sol.sell_xmr.deposit_pct', 2);
    expect(getPath(a, 'markets.sol.sell_xmr.deposit_pct')).toBeUndefined();
    expect(getPath(b, 'markets.sol.sell_xmr.deposit_pct')).toBe(2);
    const c = setPath(setPath(b, 'markets.sol.sell_xmr.deposit_pct', undefined), 'markets.sol.sell_xmr.enabled', undefined);
    expect(c).toEqual({});
  });
  it('diffs two configurations as dotted paths', () => {
    const a = parseToml('[offers]\nupdate_interval_seconds = 15\n[guardrails]\ndry_run = true');
    const b = parseToml('[offers]\nupdate_interval_seconds = 5\n[inbox]\npolicy = "open"');
    expect(diffConfig(a, b)).toEqual([
      { path: 'guardrails.dry_run', old: 'true', new: null },
      { path: 'inbox.policy', old: null, new: '"open"' },
      { path: 'offers.update_interval_seconds', old: '15', new: '5' },
    ]);
  });
  it('revisions change with the text', () => {
    expect(revisionOf('a')).not.toBe(revisionOf('b'));
    expect(revisionOf('a')).toBe(revisionOf('a'));
    expect(revisionOf('a')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('applies defaults for the parsed view', () => {
    const d = withDefaults(parseToml(DESIGN_CONFIG_TOML));
    expect(getPath(d, 'markets.eth.buy_xmr.enabled')).toBe(false);
    expect(getPath(d, 'markets.usdc_eth.sell_xmr.approval_window_seconds')).toBe(120);
    expect(getPath(d, 'markets.sol.sell_xmr.max_xmr')).toBe(50);
    expect(getPath(d, 'offers.update_interval_seconds')).toBe(15);
    expect(getPath(d, 'daemon.mode')).toBe('dry_run');
    expect(getPath(d, 'guardrails.stale_pause')).toBe(true);
    expect(getPath(d, 'rebalance.mode')).toBe('alert');
  });
});
