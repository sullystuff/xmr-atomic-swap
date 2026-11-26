// Configuration (SPEC 7.2): both example files of docs/DESIGN.md pass `config check` unchanged,
// alone or concatenated; every bound of SPEC 3.1 is evaluated; edits are validated, applied
// without a restart, logged, and the whole file exports and imports.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { deadlines, init } from '@xmrswap/core-wasm';
import { checkReport } from '../src/cli.js';
import { boundProblem, loadConfig, minClaimDelay, pendingWindow, updateCost } from '../src/config/load.js';
import { ConfigRejected } from '../src/daemon.js';
import { BASE_TOML, makeWorld } from './world.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const design = readFileSync(path.resolve(here, '../../../docs/DESIGN.md'), 'utf8');
/** The TOML blocks of DESIGN.md, extracted verbatim. */
const blocks = [...design.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1]!);

beforeAll(async () => {
  await init();
});

describe('DESIGN.md example files', () => {
  it('has the two example files', () => {
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('[markets.usdc_sol.sell_xmr]');
    expect(blocks[1]).toContain('[rebalance.venues.wxmr_bridge]');
  });

  it.each([['the maker configuration alone', 0], ['the rebalance settings alone', 1]] as const)('%s passes config check unchanged', (_n, i) => {
    const r = loadConfig(blocks[i]!);
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.ok).toBe(true);
    expect(r.config).not.toBeNull();
  });

  it('both concatenated pass, with the effective values and the warnings SPEC 7.2 names', () => {
    const r = loadConfig(`${blocks[0]}\n${blocks[1]}`);
    expect(r.validation.errors).toEqual([]);
    const c = r.config!;
    const usdcSol = c.offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr')!;
    // max 200 XMR puts the depth-25 tier in use, so "auto" resolves to the bound: 101 minutes on Solana.
    expect(usdcSol).toMatchObject({ enabled: true, source: 'coingecko', fallbacks: ['coinmarketcap'], deviationPct: 1.5, validSecs: 60, claimDelaySecs: 101 * 60, minClaimDelaySecs: 6015, noticeSecs: 600, claimWindowSecs: 1800, mode: 'auto' });
    expect(usdcSol.sizeTiers).toEqual([{ aboveXmr: 50_000_000_000_000n, extraPct: 0.5 }]);
    expect(usdcSol.minXmr).toBe(100_000_000_000n);
    // `source = "wxmr_pool"` means what it says: the pool is this market's primary and CoinGecko its fallback. The
    // example's pool addresses are placeholders, so the pool cannot be read yet and the market runs on the fallback.
    const sol = c.offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr')!;
    expect(sol).toMatchObject({ enabled: true, source: 'wxmr_pool', fallbacks: ['coingecko'], crossCheck: 'coinmarketcap', maxXmr: 50_000_000_000_000n });
    // An Ethereum market without a blob endpoint is a warning that keeps it off.
    const usdcEth = c.offers.find((o) => o.market === 'usdc_eth' && o.direction === 'sell_xmr')!;
    expect(usdcEth).toMatchObject({ configured: true, enabled: false, validSecs: 150, noticeSecs: 1800, approvalWindowSecs: 120 });
    expect(usdcEth.disabledReason).toMatch(/blob endpoint/);
    const warned = (path: string) => r.validation.warnings.filter((w) => w.path === path).map((w) => w.message).join(' ');
    expect(warned('markets.sol.sell_xmr.source')).toBe('wxmr_pool cannot be read yet: its addresses are placeholders or missing (base_vault and quote_vault are needed); it is skipped until they are set');
    // The old rule is gone: nothing demotes, nothing says "cross-check only".
    expect(JSON.stringify(r.validation)).not.toMatch(/cross-check only|promot/i);
    expect(warned('markets.usdc_eth.sell_xmr.enabled')).toMatch(/blob endpoint/);
    expect(warned('pricing.sources.wxmr_pool.token')).toMatch(/placeholder/);
    expect(warned('rebalance.venues.exchange.name')).toMatch(/placeholder/);
    expect(c.rebalance).toMatchObject({ mode: 'approve', max_cost_pct: 1.5, max_in_transit_usd: 50000 });
    expect(c.rebalance.venues.wxmr_bridge).toMatchObject({ enabled: true, max_wxmr_held: 5 });
    expect(c.ladder).toEqual([{ sizeXmr: 5_000_000_000_000n, count: 20 }, { sizeXmr: 50_000_000_000_000n, count: 6 }]);
    expect(c.maxInFlightXmr).toBe(400_000_000_000_000n);
    expect(c.raw.daemon.mode).toBe('dry_run');
    expect(r.validation.effective.map((e) => `${e.market}:${e.direction}`)).toEqual(['usdc_sol:sell_xmr', 'sol:sell_xmr']);
    const report = checkReport(r);
    expect(report).toMatch(/claim delay 101 min/);
    expect(report).toMatch(/^ok /m);
  });

  it('the CLI `config check` exits 0 on the concatenated file and 1 on a broken one', async () => {
    const w = await makeWorld();
    const good = path.join(w.dir, 'design.toml');
    writeFileSync(good, `${blocks[0]}\n${blocks[1]}`);
    const tsx = path.resolve(here, '../node_modules/.bin/tsx');
    const out = execFileSync(tsx, [path.resolve(here, '../src/cli.ts'), 'config', 'check', good], { encoding: 'utf8' });
    expect(out).toMatch(/offer +usdc_sol sell_xmr/);
    const bad = path.join(w.dir, 'bad.toml');
    writeFileSync(bad, '[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 100\nclaim_delay_minutes = 60\n');
    let code = 0;
    try {
      execFileSync(tsx, [path.resolve(here, '../src/cli.ts'), 'config', 'check', bad], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
      expect(String((e as { stdout: string }).stdout)).toMatch(/claim delay 3600 s is under the bound 6015 s for depth 25/);
    }
    expect(code).toBe(1);
  });
});

describe('validation', () => {
  it('evaluates every bound of SPEC 3.1 and agrees with the core', () => {
    const base = { chain: 'solana' as 'solana' | 'ethereum', direction: 0 as const, mode: 0, wA: 60, wN: 600, dC: 6060, wC: 1800, wF: 604_800, depth: 25, depBps: 100 };
    const cases: [Partial<typeof base>, RegExp | null][] = [
      [{}, null],
      [{ dC: 6014 }, /claim delay/],
      [{ dC: 6015 }, null],
      [{ wN: 299 }, /notice window/],
      [{ wN: 3601 }, /notice window/],
      [{ wC: 614 }, /claim window/],
      [{ wF: 600 + 6060 + 1800 + 86_400 - 1 }, /final window/],
      [{ wF: 2_592_001 }, /final window/],
      [{ depBps: 501 }, /deposit/],
      [{ mode: 1, wA: 29 }, /approval window/],
      [{ mode: 1, wA: 3601 }, /approval window/],
      [{ chain: 'ethereum', dC: 10_199, wN: 1800, wC: 5400, wA: 120 }, /claim delay/],
      [{ chain: 'ethereum', dC: 10_200, wN: 1800, wC: 5400, wA: 120 }, null],
      [{ chain: 'ethereum', dC: 10_200, wN: 1499, wC: 5400, wA: 120 }, /notice window/],
      [{ chain: 'ethereum', dC: 10_200, wN: 1800, wC: 4799, wA: 120 }, /claim window/],
    ];
    for (const [patch, want] of cases) {
      const p = { ...base, ...patch };
      const got = boundProblem(p);
      if (want) expect(got, JSON.stringify(patch)).toMatch(want);
      else expect(got, JSON.stringify(patch)).toBeNull();
      // The core's own check of the same parameters must give the same verdict.
      const pending = p.chain === 'ethereum' || p.mode === 1 ? 'approval' : p.direction === 0 ? 'none' : 'funding';
      const core = deadlines({ chain: p.chain, pending, wA: p.wA, wN: p.wN, dC: p.dC, wC: p.wC, wF: p.wF, depth: p.depth, depBps: p.depBps, tLock: 1_800_000_000n });
      expect(core.boundError === null, `${JSON.stringify(patch)} core says ${core.boundError}`).toBe(want === null);
      expect(Number(core.minClaimDelay)).toBe(minClaimDelay(p.chain, p.depth));
      expect(core.wP).toBe(pendingWindow(p.chain, p.direction, p.mode, false, p.wA, p.wN));
    }
    expect([2, 10, 25].map((d) => minClaimDelay('solana', d))).toEqual([3600, 3600, 6015]);
    expect([2, 10, 25].map((d) => minClaimDelay('ethereum', d))).toEqual([7200, 7500, 10_200]);
  });

  it('a violated bound, an unknown key, a bad tier and a bad band are errors; nothing is applied', () => {
    const err = (toml: string) => loadConfig(toml).validation.errors.map((e) => `${e.path}: ${e.message}`).join(' | ');
    expect(err('[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 100\nclaim_delay_minutes = 60\n')).toMatch(/markets\.usdc_sol\.sell_xmr.*claim delay 3600 s is under the bound 6015/);
    expect(err('[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 10\ndeposit_pct = 6\n')).toMatch(/deposit_pct/);
    expect(err('[liquidity]\nmax_in_fligth_xmr = 3\n')).toMatch(/liquidity/);
    expect(err('[markets.sol.sell_xmr]\nenabled = true\nmax_xmr = 5\nconfirmation_depth = [{ above_xmr = 1, depth = 2 }]\n')).toMatch(/first depth tier must start at 0/);
    expect(err('[guardrails]\nprice_band_usd = { min = 900, max = 300 }\n')).toMatch(/min is above max/);
    expect(err('[rebalance]\nmode = "yolo"\n')).toMatch(/rebalance/);
    expect(err('this is not toml = = =')).toMatch(/not valid TOML/);
    expect(loadConfig('[markets.usdc_sol.sell_xmr]\nenabled = true\n').validation.errors[0]!.message).toMatch(/max_xmr is not set/);
    expect(loadConfig('').validation.ok).toBe(true);
  });

  it('defaults follow the chain; warnings name what stays off', () => {
    const r = loadConfig('[tor]\nenabled = true\n[liquidity]\nmax_per_taker_xmr = 5\noutput_ladder = [{ size_xmr = 5, count = 2 }]\n[markets.eth.sell_xmr]\nenabled = true\n[markets.sol.sell_xmr]\nenabled = true\n[markets.usdc_sol.sell_xmr]\nenabled = true\napproval_mode = "window"\napproval_window_seconds = 90\n');
    expect(r.validation.errors).toEqual([]);
    const eth = r.config!.offers.find((o) => o.market === 'eth' && o.direction === 'sell_xmr')!;
    // With a blob endpoint the Ethereum market is on; depth 10 is the deepest tier in use at 5 XMR, so auto is 180 minutes.
    expect(eth).toMatchObject({ enabled: true, claimDelaySecs: 180 * 60, claimWindowSecs: 90 * 60, approvalWindowSecs: 120, validSecs: 150, deviationPct: 2.0, source: 'coingecko' });
    const messages = r.validation.warnings.map((w) => `${w.path}: ${w.message}`).join(' | ');
    expect(messages).toMatch(/markets\.eth\.sell_xmr\.approval_window_seconds: an approval window of 120 s/);
    expect(messages).toMatch(/markets\.usdc_sol\.sell_xmr\.approval_window_seconds: an approval window of 90 s/);
    expect(messages).toMatch(/max_per_taker_xmr cannot be enforced before the fact/);
  });

  it('the update cost is DESIGN\'s table: 86,400 ÷ interval × 5,000 lamports', () => {
    for (const [interval, sol] of [[1, 0.432], [5, 0.0864], [10, 0.0432], [30, 0.0144], [60, 0.0072]] as const) {
      const r = loadConfig(`[offers]\nupdate_interval_seconds = ${interval}\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 1\n`);
      const cost = updateCost(r.config!.raw, r.config!.offers, 100);
      expect(Number(cost.daily_lamports) / 1e9).toBeCloseTo(sol, 6);
      expect(cost.daily_usd).toBeCloseTo(sol * 100, 4);
    }
    const t = loadConfig('[offers]\nupdate_interval_seconds = 10\nprice_move_trigger_pct = 0.5\nmin_refresh_interval_seconds = 5\n[solana]\npriority_fee_microlamports = 1000000\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 1\n');
    const cost = updateCost(t.config!.raw, t.config!.offers);
    // Move-triggered: at least the keep-alive (86,400 ÷ 48 s), at most one per minimum interval; the priority fee is priced per compute unit.
    expect(cost.triggered_per_day).toEqual({ expected: 1800, max: 17_280 });
    expect(cost.lamports_per_update).toBe(String(5000 + 24_120));
  });
});

describe('hot apply, change log, import and export', () => {
  it('applies an edit without a restart, records what changed, refuses a bad or stale edit, and writes the file', async () => {
    const w = await makeWorld();
    const d = await w.boot();
    const before = d.load.revision;
    const startedAt = d.startedAt;
    const edited = readFileSync(w.configPath, 'utf8').replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\ndeviation_pct = 3.5');
    const r = d.applyConfig(edited, 'api', before);
    expect(r.revision).not.toBe(before);
    // The running modules read the new value at once; nothing restarted.
    expect(d.config.offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr')!.deviationPct).toBe(3.5);
    expect(d.startedAt).toBe(startedAt);
    expect(readFileSync(w.configPath, 'utf8')).toBe(edited);
    expect(d.store.configLog()[0]).toMatchObject({ revision: r.revision, source: 'api', changes: [{ path: 'markets.sol.sell_xmr.deviation_pct', old: '2', new: '3.5' }] });

    // A stale base revision, a syntax error and a violated bound are refused; the configuration in force does not change.
    expect(() => d.applyConfig(edited, 'api', before)).toThrowError(ConfigRejected);
    const refused = (toml: string): ConfigRejected => {
      try {
        d.applyConfig(toml, 'api');
      } catch (e) {
        return e as ConfigRejected;
      }
      throw new Error('accepted');
    };
    expect(refused('nope = = =').code).toBe('invalid_toml');
    const bound = refused(`${edited}\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 100\nclaim_delay_minutes = 60\n`);
    expect(bound.code).toBe('invalid_config');
    expect(bound.result!.validation.errors[0]!.path).toBe('markets.usdc_sol.sell_xmr');
    expect(d.load.revision).toBe(r.revision);
    expect(readFileSync(w.configPath, 'utf8')).toBe(edited);

    // Export is the file byte for byte; importing it elsewhere gives the same configuration and is logged as an import.
    const exported = d.load.toml;
    const again = d.applyConfig(BASE_TOML.replaceAll('__OWNER__', w.sim.owner), 'import');
    expect(d.store.configLog()[0]).toMatchObject({ source: 'import', revision: again.revision });
    d.applyConfig(exported, 'import');
    expect(d.load.revision).toBe(r.revision);
    expect(d.store.configLog()).toHaveLength(3);
    d.store.close();
  });
});
