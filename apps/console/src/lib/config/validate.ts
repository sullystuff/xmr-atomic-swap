/**
 * Validation of a configuration (SPEC 7.2 `config check`): types and ranges from the schema
 * table, every bound of SPEC 3.1 for each enabled offer on its chain, and the cross-key rules.
 * Runs in the console before anything is sent, and inside the mock daemon.
 */
import { CHAIN_CONSTS, MARKET_CHAIN, MIN_APPROVAL_SECS, type ChainName, type Market } from '@xmrswap/protocol';
import type { ConfigIssue, ConfigValidation, EffectiveOfferTerms, MarketDirection, UpdateCostEstimate } from '@xmrswap/protocol/daemon-api';
import { BASE_FEE_LAMPORTS, dailyCostLamports, lamportsToUsd, priorityFeeLamports, updatesPerDay } from '../cost.js';
import {
  ASSETS,
  DEFAULT_DEPTH_TIERS,
  DIRECTIONS,
  MARKETS,
  PRICE_SOURCES,
  RECOMMENDED_APPROVAL_SECS,
  APPROVAL_WINDOW_REASON,
  TOP_LEVEL_TABLES,
  VENUES,
  VENUE_LABEL,
  allSections,
  chainLabel,
  offerDefaults,
  offerFields,
  type FieldDef,
  type SectionDef,
} from './schema.js';
import { getPath, isPlaceholder, isTable, type Toml } from './toml.js';

export interface ValidateContext {
  /** Whether the registry lists a blob endpoint (required for Ethereum markets); `null` = unknown. */
  blobEndpoint: boolean | null;
  solUsd: number | null;
  /** Expected move-triggered updates per day, from the daemon's price history. */
  expectedTriggeredPerDay?: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Issues {
  readonly errors: ConfigIssue[] = [];
  readonly warnings: ConfigIssue[] = [];
  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }
}

// ------------------------------------------------------------------ claim-delay arithmetic (SPEC 3.1)

/** `Δ_cut = F + d × B + CUT_MARGIN`. */
export const refundCutoffSecs = (chain: ChainName, depth: number): number => {
  const c = CHAIN_CONSTS[chain];
  return c.finalitySecs + depth * c.blockAllowanceSecs + c.cutMarginSecs;
};
/** Smallest claim delay the chain accepts at this depth: `max(MIN_CLAIM_DELAY, Δ_cut + 2M)`. */
export const minClaimDelaySecs = (chain: ChainName, depth: number): number => {
  const c = CHAIN_CONSTS[chain];
  return Math.max(c.minClaimDelaySecs, refundCutoffSecs(chain, depth) + 2 * c.marginSecs);
};
export const minClaimDelayMinutes = (chain: ChainName, depth: number): number => Math.ceil(minClaimDelaySecs(chain, depth) / 60);
/** What `"auto"` resolves to: the larger of 90 min (Solana) or 180 min (Ethereum) and the bound, rounded up to a minute. */
export const autoClaimDelayMinutes = (chain: ChainName, depth: number): number =>
  Math.max(chain === 'solana' ? 90 : 180, minClaimDelayMinutes(chain, depth));
/** Smallest claim window: `F + 2M`. */
export const minClaimWindowSecs = (chain: ChainName): number => CHAIN_CONSTS[chain].finalitySecs + 2 * CHAIN_CONSTS[chain].marginSecs;

// ------------------------------------------------------------------ offers

export interface DepthTier {
  above_xmr: number;
  depth: number;
}
export interface ResolvedOffer {
  market: Market;
  direction: MarketDirection;
  chain: ChainName;
  /** As written in the file. */
  wanted: boolean;
  /** Reasons the daemon keeps a wanted offer off. Empty when it runs. */
  keptOff: string[];
  /** The primary source after the wXMR pool is demoted. */
  source: string;
  crossCheck: string | null;
  values: Record<string, unknown>;
  maxXmr: number | null;
  depthTiers: DepthTier[];
  deepestDepth: number;
  claimDelayMinutes: number;
  minClaimDelayMinutes: number;
  terms: EffectiveOfferTerms;
}

const xmrToPiconero = (x: number): string => {
  if (!Number.isFinite(x) || x < 0) return '0';
  const [whole = '0', frac = ''] = x.toFixed(12).split('.');
  return (BigInt(whole) * 1_000_000_000_000n + BigInt(frac.padEnd(12, '0'))).toString();
};

export function largestLadderSize(cfg: Toml): number | null {
  const ladder = getPath(cfg, 'liquidity.output_ladder');
  if (!Array.isArray(ladder)) return null;
  let best: number | null = null;
  for (const row of ladder) {
    const size = isTable(row) ? row.size_xmr : undefined;
    if (typeof size === 'number' && (best === null || size > best)) best = size;
  }
  return best;
}

const asTiers = (v: unknown): DepthTier[] => {
  if (!Array.isArray(v)) return [...DEFAULT_DEPTH_TIERS];
  const out: DepthTier[] = [];
  for (const row of v) {
    if (isTable(row) && typeof row.above_xmr === 'number' && typeof row.depth === 'number') out.push({ above_xmr: row.above_xmr, depth: row.depth });
  }
  return out;
};

/** The values an offer runs with: file values over defaults, `"auto"` resolved, the pool demoted. */
export function resolveOffer(cfg: Toml, market: Market, direction: MarketDirection, ctx: Pick<ValidateContext, 'blobEndpoint'>): ResolvedOffer {
  const chain = MARKET_CHAIN[market];
  const c = CHAIN_CONSTS[chain];
  const raw = getPath(cfg, `markets.${market}.${direction}`);
  const file = isTable(raw) ? raw : {};
  const values: Record<string, unknown> = { ...offerDefaults(market), ...file };
  const wanted = values.enabled === true;
  const keptOff: string[] = [];

  const fallbacks = Array.isArray(values.fallbacks) ? values.fallbacks.filter((x): x is string => typeof x === 'string') : [];
  let source = typeof values.source === 'string' ? values.source : 'coingecko';
  const globalCross = getPath(cfg, 'pricing.cross_check');
  let crossCheck = typeof globalCross === 'string' && globalCross !== '' ? globalCross : null;
  if (source === 'wxmr_pool') {
    const promoted = fallbacks.find((f) => f !== 'wxmr_pool');
    if (promoted) {
      source = promoted;
      crossCheck = 'wxmr_pool';
    } else keptOff.push('its only price source is the wXMR pool, which may only be a cross-check');
  }
  if (chain === 'ethereum' && ctx.blobEndpoint === false) keptOff.push('no blob endpoint is listed in the registry');

  const ladderMax = largestLadderSize(cfg);
  const maxXmr = typeof values.max_xmr === 'number' ? values.max_xmr : ladderMax;
  const depthTiers = asTiers(values.confirmation_depth);
  // A tier is in use when a swap of the largest accepted size can reach it.
  const used = depthTiers.filter((t) => maxXmr === null || t.above_xmr <= maxXmr);
  const deepestDepth = used.reduce((d, t) => Math.max(d, t.depth), depthTiers[0]?.depth ?? 2);
  const minDelay = minClaimDelayMinutes(chain, deepestDepth);
  const claimDelayMinutes = typeof values.claim_delay_minutes === 'number' ? values.claim_delay_minutes : autoClaimDelayMinutes(chain, deepestDepth);
  const mode = values.approval_mode === 'window' || values.approval_mode === 'advance' ? values.approval_mode : 'auto';
  const n = (k: string, d: number): number => (typeof values[k] === 'number' ? (values[k] as number) : d);

  const terms: EffectiveOfferTerms = {
    market,
    direction,
    enabled: wanted && keptOff.length === 0,
    approval_mode: mode,
    approval_window_secs: n('approval_window_seconds', chain === 'ethereum' ? 120 : 60),
    notice_secs: n('notice_seconds', c.minNoticeSecs),
    claim_delay_secs: Math.round(claimDelayMinutes * 60),
    claim_window_secs: Math.round(n('claim_window_minutes', 30) * 60),
    final_secs: Math.round(n('final_days', 7) * 86_400),
    deposit_bps: Math.round(n('deposit_pct', 0) * 100),
    depth_tiers: depthTiers.map((t) => ({ above_xmr: xmrToPiconero(t.above_xmr), depth: t.depth })),
    min_claim_delay_secs: minClaimDelaySecs(chain, deepestDepth),
  };
  return { market, direction, chain, wanted, keptOff, source, crossCheck, values, maxXmr, depthTiers, deepestDepth, claimDelayMinutes, minClaimDelayMinutes: minDelay, terms };
}

export function resolveOffers(cfg: Toml, ctx: Pick<ValidateContext, 'blobEndpoint'>): ResolvedOffer[] {
  return MARKETS.flatMap((m) => DIRECTIONS.map((d) => resolveOffer(cfg, m, d, ctx)));
}

/** Whether a swap on this offer can wait in PENDING for the maker's approval. */
export const canBePending = (chain: ChainName, mode: string): boolean => mode === 'window' || CHAIN_CONSTS[chain].explicitApprove;

// ------------------------------------------------------------------ generic field checks

function checkNumber(issues: Issues, path: string, v: unknown, o: { int?: boolean; min?: number; max?: number; exclusiveMin?: boolean }, label: string): boolean {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    issues.error(path, `${label} must be a number.`);
    return false;
  }
  if (o.int && !Number.isInteger(v)) {
    issues.error(path, `${label} must be a whole number.`);
    return false;
  }
  if (o.min !== undefined && (o.exclusiveMin ? v <= o.min : v < o.min)) {
    issues.error(path, `${label} must be ${o.exclusiveMin ? 'more than' : 'at least'} ${o.min}.`);
    return false;
  }
  if (o.max !== undefined && v > o.max) {
    issues.error(path, `${label} must be at most ${o.max}.`);
    return false;
  }
  return true;
}

function checkField(issues: Issues, path: string, f: FieldDef, v: unknown): void {
  const t = f.type;
  switch (t.t) {
    case 'bool':
      if (typeof v !== 'boolean') issues.error(path, `${f.label} must be true or false.`);
      return;
    case 'number':
      checkNumber(issues, path, v, t, f.label);
      return;
    case 'text':
      if (typeof v !== 'string') issues.error(path, `${f.label} must be text.`);
      else if (isPlaceholder(v)) issues.warn(path, `${v} is a placeholder; whatever needs it stays off until it is filled in.`);
      return;
    case 'env':
      checkEnv(issues, path, f.label, v);
      return;
    case 'select':
      if (typeof v !== 'string' || !t.options.some((o) => o.value === v && o.value !== '')) {
        if (isPlaceholder(v)) issues.warn(path, `${String(v)} is a placeholder; whatever needs it stays off until it is filled in.`);
        else issues.error(path, `${f.label} must be one of: ${t.options.filter((o) => o.value !== '').map((o) => `"${o.value}"`).join(', ')}.`);
      }
      return;
    case 'list': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        issues.error(path, `${f.label} must be a list of text values.`);
        return;
      }
      const seen = new Set<string>();
      (v as string[]).forEach((x, i) => {
        if (t.options && !t.options.some((o) => o.value === x)) issues.error(`${path}.${i}`, `"${x}" is not a known name for ${f.label.toLowerCase()}.`);
        if (t.env) checkEnv(issues, `${path}.${i}`, f.label, x);
        if (seen.has(x)) issues.error(`${path}.${i}`, `"${x}" is listed twice.`);
        seen.add(x);
        if (isPlaceholder(x)) issues.warn(`${path}.${i}`, `${x} is a placeholder.`);
      });
      return;
    }
    case 'rows': {
      if (!Array.isArray(v)) {
        issues.error(path, `${f.label} must be a list of rows.`);
        return;
      }
      if (t.maxRows !== undefined && v.length > t.maxRows) issues.error(path, `${f.label}: at most ${t.maxRows} rows.`);
      v.forEach((row, i) => {
        if (!isTable(row)) {
          issues.error(`${path}.${i}`, `Row ${i + 1} must be a table.`);
          return;
        }
        for (const col of t.columns) {
          const cell = row[col.key];
          const p = `${path}.${i}.${col.key}`;
          if (cell === undefined) issues.error(p, `Row ${i + 1} needs ${col.key}.`);
          else if (col.type === 'text') {
            if (typeof cell !== 'string' || cell === '') issues.error(p, `${col.label} must be text.`);
          } else checkNumber(issues, p, cell, { int: col.type === 'int', ...(col.min !== undefined ? { min: col.min } : {}), ...(col.max !== undefined ? { max: col.max } : {}) }, col.label);
        }
        for (const k of Object.keys(row)) if (!t.columns.some((c) => c.key === k)) issues.error(`${path}.${i}.${k}`, `Unknown key "${k}".`);
      });
      return;
    }
    case 'record': {
      if (v === false && t.required) return; // written as `false`: switched off
      if (!isTable(v)) {
        issues.error(path, `${f.label} must be a table.`);
        return;
      }
      for (const col of t.keys) {
        const cell = v[col.key];
        if (cell === undefined) {
          if (t.required) issues.error(`${path}.${col.key}`, `${f.label} needs ${col.key}.`);
          continue;
        }
        checkNumber(issues, `${path}.${col.key}`, cell, { int: col.type === 'int', ...(col.min !== undefined ? { min: col.min } : {}), ...(col.max !== undefined ? { max: col.max } : {}) }, `${f.label}: ${col.label.toLowerCase()}`);
      }
      for (const k of Object.keys(v)) if (!t.keys.some((c) => c.key === k)) issues.error(`${path}.${k}`, `Unknown key "${k}".`);
      return;
    }
    case 'auto-number':
      if (v === 'auto') return;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) issues.error(path, `${f.label} must be "auto" or a number of minutes.`);
      return;
    case 'map':
      if (!isTable(v) || Object.values(v).some((x) => typeof x !== 'string')) issues.error(path, `${f.label} must be a table of text values.`);
      return;
    case 'custom':
      return;
  }
}

function checkEnv(issues: Issues, path: string, label: string, v: unknown): void {
  if (typeof v !== 'string') {
    issues.error(path, `${label} must name an environment variable.`);
    return;
  }
  if (isPlaceholder(v)) {
    issues.warn(path, `${v} is a placeholder; whatever needs it stays off until it is filled in.`);
    return;
  }
  if (!ENV_NAME.test(v)) issues.error(path, `${label} must be the name of an environment variable, not the value itself. Secrets never go in this file.`);
}

function checkSection(issues: Issues, cfg: Toml, section: SectionDef): void {
  const table = getPath(cfg, section.path);
  if (table === undefined) return;
  if (!isTable(table)) {
    issues.error(section.path, `[${section.path}] must be a table.`);
    return;
  }
  for (const [key, value] of Object.entries(table)) {
    const f = section.fields.find((x) => x.key === key);
    const path = `${section.path}.${key}`;
    if (f) checkField(issues, path, f, value);
    else if (!section.children?.includes(key)) issues.error(path, `Unknown key "${key}" in [${section.path}]. The daemon refuses keys it does not know.`);
  }
}

// ------------------------------------------------------------------ the whole file

export function validateConfig(cfg: Toml, ctx: ValidateContext): ConfigValidation {
  const issues = new Issues();

  for (const key of Object.keys(cfg)) {
    if (!(TOP_LEVEL_TABLES as readonly string[]).includes(key)) issues.error(key, `Unknown section [${key}]. The daemon refuses sections it does not know.`);
    else if (!isTable(cfg[key])) issues.error(key, `[${key}] must be a table.`);
  }
  for (const section of allSections()) checkSection(issues, cfg, section);
  checkPricing(issues, cfg);
  checkLiquidity(issues, cfg);
  checkGuardrails(issues, cfg);
  checkRebalance(issues, cfg);
  checkOperation(issues, cfg);
  const offers = checkMarkets(issues, cfg, ctx);
  const update_cost = checkOfferUpdates(issues, cfg, offers, ctx);

  return {
    ok: issues.errors.length === 0,
    errors: issues.errors,
    warnings: issues.warnings,
    effective: offers.filter((o) => o.terms.enabled).map((o) => o.terms),
    update_cost,
  };
}

function checkPricing(issues: Issues, cfg: Toml): void {
  const sources = getPath(cfg, 'pricing.sources');
  if (isTable(sources)) {
    for (const k of Object.keys(sources)) if (!(PRICE_SOURCES as readonly string[]).includes(k)) issues.error(`pricing.sources.${k}`, `Unknown price source "${k}".`);
  }
  const maxAge = getPath(cfg, 'pricing.max_age_seconds') ?? 60;
  const refresh = getPath(cfg, 'pricing.refresh_seconds') ?? 15;
  if (typeof maxAge === 'number' && typeof refresh === 'number' && maxAge < refresh)
    issues.error('pricing.max_age_seconds', `Maximum price age (${maxAge} s) is shorter than the refresh interval (${refresh} s), so every price would be stale.`);
  const cross = getPath(cfg, 'pricing.cross_check');
  if (typeof cross === 'string' && cross !== '' && (PRICE_SOURCES as readonly string[]).includes(cross)) {
    if (cross !== 'wxmr_pool' && !isTable(getPath(cfg, `pricing.sources.${cross}`)))
      issues.warn('pricing.cross_check', `The cross-check source "${cross}" has no [pricing.sources.${cross}] section, so it has no API key.`);
    if (cross === 'wxmr_pool') checkPoolReady(issues, cfg, 'pricing.cross_check');
  }
}

function checkPoolReady(issues: Issues, cfg: Toml, path: string): void {
  const pool = getPath(cfg, 'pricing.sources.wxmr_pool');
  if (!isTable(pool) || typeof pool.token !== 'string' || typeof pool.pool !== 'string')
    issues.warn(path, 'The wXMR pool needs its token and pool addresses under [pricing.sources.wxmr_pool]; until then this cross-check is off.');
  else if (isPlaceholder(pool.token) || isPlaceholder(pool.pool))
    issues.warn(path, 'The wXMR pool addresses are still placeholders; until they are filled in this cross-check is off.');
}

function checkLiquidity(issues: Issues, cfg: Toml): void {
  const alloc = getPath(cfg, 'liquidity.allocation');
  if (alloc !== undefined && alloc !== 'shared') {
    if (!isTable(alloc)) issues.error('liquidity.allocation', 'Allocation must be "shared" or a table with an XMR amount per market.');
    else {
      for (const [k, v] of Object.entries(alloc)) {
        if (!(MARKETS as readonly string[]).includes(k)) issues.error(`liquidity.allocation.${k}`, `"${k}" is not a market.`);
        else checkNumber(issues, `liquidity.allocation.${k}`, v, { min: 0 }, `Allocation for ${k}`);
      }
    }
  }
  const ladder = getPath(cfg, 'liquidity.output_ladder');
  if (Array.isArray(ladder)) {
    const sizes = new Set<number>();
    ladder.forEach((row, i) => {
      if (!isTable(row) || typeof row.size_xmr !== 'number') return;
      if (row.size_xmr <= 0) issues.error(`liquidity.output_ladder.${i}.size_xmr`, 'A ladder size must be more than 0 XMR.');
      if (sizes.has(row.size_xmr)) issues.error(`liquidity.output_ladder.${i}.size_xmr`, `The size ${row.size_xmr} XMR is listed twice.`);
      sizes.add(row.size_xmr);
    });
  }
}

function checkGuardrails(issues: Issues, cfg: Toml): void {
  const band = getPath(cfg, 'guardrails.price_band_usd');
  if (isTable(band) && typeof band.min === 'number' && typeof band.max === 'number' && band.min >= band.max)
    issues.error('guardrails.price_band_usd', `The price band's minimum (${band.min}) must be below its maximum (${band.max}).`);
  const vol = getPath(cfg, 'guardrails.volatility_pause');
  if (isTable(vol) && typeof vol.move_pct === 'number' && vol.move_pct <= 0) issues.error('guardrails.volatility_pause.move_pct', 'The volatility pause needs a move above 0%.');
  const reorg = getPath(cfg, 'guardrails.reorg_guard');
  if (reorg !== undefined) {
    if (!isTable(reorg)) issues.error('guardrails.reorg_guard', 'Reorg guard must be a table: { enabled, raise_depth_to }.');
    else {
      if (reorg.enabled !== undefined && typeof reorg.enabled !== 'boolean') issues.error('guardrails.reorg_guard.enabled', 'Reorg guard: enabled must be true or false.');
      if (reorg.raise_depth_to !== undefined) checkNumber(issues, 'guardrails.reorg_guard.raise_depth_to', reorg.raise_depth_to, { int: true, min: 1, max: 255 }, 'Reorg guard depth');
      else if (reorg.enabled === true) issues.error('guardrails.reorg_guard.raise_depth_to', 'Reorg guard needs the depth to raise to.');
    }
  }
  if (getPath(cfg, 'guardrails.disagreement_pause') !== false) {
    const cross = getPath(cfg, 'pricing.cross_check');
    if (cross === undefined || cross === '') issues.warn('guardrails.disagreement_pause', 'The disagreement pause has nothing to compare: no cross-check source is set.');
  }
}

function checkRebalance(issues: Issues, cfg: Toml): void {
  const levels = getPath(cfg, 'rebalance.levels');
  if (isTable(levels)) {
    for (const [asset, lv] of Object.entries(levels)) {
      if (!(ASSETS as readonly string[]).includes(asset)) {
        issues.error(`rebalance.levels.${asset}`, `"${asset}" is not an asset. Use xmr, sol, eth, usdc_sol or usdc_eth.`);
        continue;
      }
      if (!isTable(lv)) continue;
      const { low, target, high } = lv as { low?: unknown; target?: unknown; high?: unknown };
      const order: [string, unknown][] = [
        ['low', low],
        ['target', target],
        ['high', high],
      ];
      const nums = order.filter((x): x is [string, number] => typeof x[1] === 'number');
      for (let i = 1; i < nums.length; i++) {
        const [pk, pv] = nums[i - 1] as [string, number];
        const [k, v] = nums[i] as [string, number];
        if (pv > v) issues.error(`rebalance.levels.${asset}.${k}`, `For ${asset}, ${pk} (${pv}) must not be above ${k} (${v}).`);
      }
    }
  }
  const venues = getPath(cfg, 'rebalance.venues');
  const enabled = new Set<string>();
  if (isTable(venues)) {
    for (const [id, v] of Object.entries(venues)) {
      if (!(VENUES as readonly string[]).includes(id)) {
        issues.error(`rebalance.venues.${id}`, `"${id}" is not a venue. Known venues: ${VENUES.join(', ')}.`);
        continue;
      }
      if (!isTable(v) || v.enabled !== true) continue;
      enabled.add(id);
      const base = `rebalance.venues.${id}`;
      if (id === 'stealthex' || id === 'houdiniswap') issues.warn(`${base}.enabled`, `${VENUE_LABEL[id]}: XMR support is unconfirmed. Read its terms before relying on it.`);
      if (id === 'exchange') {
        if (isPlaceholder(v.name) || v.name === undefined) issues.warn(`${base}.name`, 'The exchange is not named; this venue stays off until it is.');
        else if (v.name !== 'kraken') issues.error(`${base}.name`, `Unknown exchange "${String(v.name)}". The only driver in this version is "kraken".`);
        if (v.api_key_env === undefined) issues.warn(`${base}.api_key_env`, 'The exchange has no API key variable; this venue stays off until it has one.');
      } else if (id !== 'wxmr_bridge' && v.api_key_env === undefined) {
        issues.warn(`${base}.api_key_env`, `${VENUE_LABEL[id as keyof typeof VENUE_LABEL]} has no API key variable; this venue stays off until it has one.`);
      }
    }
  }
  const cross = getPath(cfg, 'rebalance.cross_chain');
  if (isTable(cross) && cross.enabled === true) {
    if (typeof cross.venue !== 'string' || cross.venue === '') issues.error('rebalance.cross_chain.venue', 'Cross-chain moves need a venue.');
    else if (!enabled.has(cross.venue)) issues.error('rebalance.cross_chain.venue', `Cross-chain moves name "${cross.venue}", which is not an enabled venue.`);
  }
  const mode = getPath(cfg, 'rebalance.mode');
  if (mode === 'auto') {
    if (getPath(cfg, 'rebalance.max_in_transit_usd') === undefined) issues.warn('rebalance.max_in_transit_usd', 'Automatic refills run without an in-transit cap. Set one to bound the loss if a venue fails or holds a transfer.');
    if (getPath(cfg, 'rebalance.max_cost_pct') === undefined) issues.warn('rebalance.max_cost_pct', 'Automatic refills run without a cost limit.');
  }
}

function checkOperation(issues: Issues, cfg: Toml): void {
  const monero = getPath(cfg, 'monero');
  if (isTable(monero)) {
    const nodes = Array.isArray(monero.node_url_envs) ? monero.node_url_envs.length : 0;
    if (nodes === 0) issues.error('monero.node_url_envs', 'Name at least one Monero node.');
    else if (nodes === 1 && monero.own_node !== true) issues.error('monero.node_url_envs', 'Name two or more Monero nodes, or one node with own_node = true. A single node you do not run can fake a lock.');
  }
  const bind = getPath(cfg, 'daemon.api_bind');
  if (typeof bind === 'string' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\]):\d+$/.test(bind))
    issues.error('daemon.api_bind', 'The local API must listen on loopback (127.0.0.1, localhost or [::1]).');
  const tor = getPath(cfg, 'tor');
  if (isTable(tor) && tor.enabled === true && tor.hostname_file === undefined) issues.warn('tor.hostname_file', 'Tor is on without a hostname file, so the onion address cannot be read or published.');
  const allow = getPath(cfg, 'approvals.allow');
  const deny = getPath(cfg, 'approvals.deny');
  if (Array.isArray(allow) && Array.isArray(deny)) {
    for (const a of allow) if (deny.includes(a)) issues.error('approvals.deny', `${String(a)} is on both the allow list and the deny list.`);
  }
}

function checkMarkets(issues: Issues, cfg: Toml, ctx: ValidateContext): ResolvedOffer[] {
  const markets = getPath(cfg, 'markets');
  if (isTable(markets)) {
    for (const [m, dirs] of Object.entries(markets)) {
      if (!(MARKETS as readonly string[]).includes(m)) {
        issues.error(`markets.${m}`, `"${m}" is not a market. Use usdc_sol, sol, usdc_eth or eth.`);
        continue;
      }
      if (!isTable(dirs)) continue;
      for (const d of Object.keys(dirs)) if (!(DIRECTIONS as readonly string[]).includes(d)) issues.error(`markets.${m}.${d}`, `"${d}" is not a direction. Use sell_xmr or buy_xmr.`);
    }
  }
  const perTaker = getPath(cfg, 'liquidity.max_per_taker_xmr');
  const offers: ResolvedOffer[] = [];
  for (const market of MARKETS) {
    const fields = offerFields(market);
    for (const direction of DIRECTIONS) {
      const base = `markets.${market}.${direction}`;
      const table = getPath(cfg, base);
      if (isTable(table)) {
        for (const [key, value] of Object.entries(table)) {
          const f = fields.find((x) => x.key === key);
          if (f) checkField(issues, `${base}.${key}`, f, value);
          else issues.error(`${base}.${key}`, `Unknown key "${key}" in [${base}]. The daemon refuses keys it does not know.`);
        }
      }
      const o = resolveOffer(cfg, market, direction, ctx);
      offers.push(o);
      if (!o.wanted) continue;
      checkOffer(issues, cfg, base, o, typeof perTaker === 'number');
    }
  }
  return offers;
}

function checkOffer(issues: Issues, cfg: Toml, base: string, o: ResolvedOffer, perTakerSet: boolean): void {
  const { chain, values } = o;
  const c = CHAIN_CONSTS[chain];
  const where = `${o.market} ${o.direction}`;
  const file = getPath(cfg, base);
  const written = isTable(file) ? file : {};

  // Price sources. The Decisions table makes the wXMR pool a cross-check only.
  const fallbacks = Array.isArray(values.fallbacks) ? (values.fallbacks as unknown[]) : [];
  if (values.source === 'wxmr_pool') {
    if (o.keptOff.some((r) => r.includes('wXMR pool')))
      issues.warn(`${base}.source`, `${where}: the wXMR pool may only be a cross-check and there is no fallback to promote, so this market stays off.`);
    else {
      issues.warn(`${base}.source`, `${where}: the wXMR pool may only be a cross-check. "${o.source}" is promoted to primary and the pool is used as this market's cross-check.`);
      checkPoolReady(issues, cfg, `${base}.source`);
    }
  } else if (fallbacks.includes(values.source)) issues.error(`${base}.fallbacks`, `${where}: "${String(values.source)}" is both the primary source and a fallback.`);
  if (fallbacks.includes('wxmr_pool') && values.source !== 'wxmr_pool')
    issues.warn(`${base}.fallbacks`, `${where}: the wXMR pool may only be a cross-check; it is skipped as a fallback.`);
  if (chain === 'ethereum' && o.keptOff.some((r) => r.includes('blob endpoint')))
    issues.warn(`${base}.enabled`, `${where}: Ethereum markets need a blob endpoint in the registry (the onion address or a contact of kind 5). None is listed, so this market stays off.`);

  // Sizes.
  const min = values.min_xmr;
  if (typeof min === 'number' && o.maxXmr !== null && min > o.maxXmr) issues.error(`${base}.min_xmr`, `${where}: the smallest swap (${min} XMR) is above the largest (${o.maxXmr} XMR).`);
  if (o.maxXmr === null) issues.warn(`${base}.max_xmr`, `${where}: no largest swap is set and there is no output ladder to take it from.`);
  const tiers = Array.isArray(values.size_tiers) ? values.size_tiers : [];
  let prev = 0;
  tiers.forEach((t, i) => {
    if (!isTable(t) || typeof t.above_xmr !== 'number') return;
    if (t.above_xmr <= prev) issues.error(`${base}.size_tiers.${i}.above_xmr`, `${where}: size-tier thresholds must rise, starting above 0.`);
    prev = t.above_xmr;
  });

  // Depth tiers (SPEC 3.1: the first starts at 0 and thresholds strictly increase).
  const depth = o.depthTiers;
  if (depth.length === 0) issues.error(`${base}.confirmation_depth`, `${where}: at least one confirmation-depth tier is needed.`);
  else {
    if (depth[0]?.above_xmr !== 0) issues.error(`${base}.confirmation_depth.0.above_xmr`, `${where}: the first confirmation-depth tier must start at 0 XMR.`);
    for (let i = 1; i < depth.length; i++) {
      if ((depth[i] as DepthTier).above_xmr <= (depth[i - 1] as DepthTier).above_xmr)
        issues.error(`${base}.confirmation_depth.${i}.above_xmr`, `${where}: confirmation-depth thresholds must rise.`);
    }
  }

  // Deposit: the contract caps it at 5%.
  const dep = values.deposit_pct;
  if (typeof dep === 'number' && dep > c.maxDepositBps / 100 && !issues.errors.some((e) => e.path === `${base}.deposit_pct`))
    issues.error(`${base}.deposit_pct`, `${where}: the deposit is capped at ${c.maxDepositBps / 100}%.`);

  // Approval window.
  const wa = o.terms.approval_window_secs;
  const pending = canBePending(chain, o.terms.approval_mode);
  if (pending) {
    if (wa < MIN_APPROVAL_SECS || wa > c.maxApprovalSecs) {
      if (!issues.errors.some((e) => e.path === `${base}.approval_window_seconds`))
        issues.error(`${base}.approval_window_seconds`, `${where}: the approval window must be between ${MIN_APPROVAL_SECS} and ${c.maxApprovalSecs} seconds.`);
    } else if (wa > RECOMMENDED_APPROVAL_SECS) {
      const byDefault = written.approval_window_seconds === undefined ? ` (the ${chainLabel(chain)} default)` : '';
      issues.warn(
        `${base}.approval_window_seconds`,
        `${where}: an approval window of ${wa} seconds${byDefault} is longer than the recommended 60 seconds. ${APPROVAL_WINDOW_REASON} Takers see a warning on this offer.`,
      );
    }
  }

  // Notice window.
  const wn = o.terms.notice_secs;
  if ((wn < c.minNoticeSecs || wn > c.maxNoticeSecs) && !issues.errors.some((e) => e.path === `${base}.notice_seconds`))
    issues.error(`${base}.notice_seconds`, `${where}: the lock-notice deadline must be between ${c.minNoticeSecs} and ${c.maxNoticeSecs} seconds on ${chainLabel(chain)}.`);

  // Claim delay: the contract's floor, raised by the deepest depth in use.
  if (typeof values.claim_delay_minutes === 'number' && values.claim_delay_minutes * 60 < o.terms.min_claim_delay_secs) {
    const floor = c.minClaimDelaySecs / 60;
    issues.error(
      `${base}.claim_delay_minutes`,
      o.minClaimDelayMinutes > floor
        ? `${where}: a claim delay of ${values.claim_delay_minutes} minutes is too short. At depth ${o.deepestDepth} on ${chainLabel(chain)} the minimum is ${o.minClaimDelayMinutes} minutes.`
        : `${where}: a claim delay of ${values.claim_delay_minutes} minutes is below the contract's floor of ${floor} minutes on ${chainLabel(chain)}.`,
    );
  }

  // Claim window.
  if (o.terms.claim_window_secs < minClaimWindowSecs(chain))
    issues.error(`${base}.claim_window_minutes`, `${where}: the claim window must be at least ${Math.ceil(minClaimWindowSecs(chain) / 60)} minutes on ${chainLabel(chain)}.`);

  // Final window: `W_p + W_n + D_c + W_c + 86,400 <= W_f <= MAX_FINAL`.
  const wp = pending ? wa : o.direction === 'buy_xmr' ? wn : 0;
  const need = wp + wn + o.terms.claim_delay_secs + o.terms.claim_window_secs + 86_400;
  if (o.terms.final_secs < need)
    issues.error(`${base}.final_days`, `${where}: the final deadline must be at least ${(Math.ceil((need / 86_400) * 100) / 100).toFixed(2)} days to leave room for the other deadlines plus one day.`);
  else if (o.terms.final_secs > c.maxFinalSecs && !issues.errors.some((e) => e.path === `${base}.final_days`))
    issues.error(`${base}.final_days`, `${where}: the final deadline is capped at ${c.maxFinalSecs / 86_400} days.`);

  // Withhold policy needs a deposit to act on.
  if (values.withhold_policy !== 'never' && o.terms.deposit_bps === 0) issues.warn(`${base}.withhold_policy`, `${where}: the withhold policy has no effect without a deposit.`);

  // A per-taker limit cannot be applied before the fact on a Solana auto-accept offer.
  if (perTakerSet && chain === 'solana' && o.terms.approval_mode === 'auto')
    issues.warn(`${base}.approval_mode`, `${where}: the per-taker limit cannot be enforced before the fact on a Solana auto-accept offer. The only remedy is an abort, which is counted against you.`);
}

function checkOfferUpdates(issues: Issues, cfg: Toml, offers: ResolvedOffer[], ctx: ValidateContext): UpdateCostEstimate | null {
  const interval = getPath(cfg, 'offers.update_interval_seconds') ?? 15;
  const trigger = getPath(cfg, 'offers.price_move_trigger_pct');
  const minRefresh = getPath(cfg, 'offers.min_refresh_interval_seconds');
  const micro = getPath(cfg, 'solana.priority_fee_microlamports') ?? 0;
  if (typeof interval !== 'number' || !(interval > 0)) return null;
  if (minRefresh !== undefined && trigger === undefined) issues.warn('offers.min_refresh_interval_seconds', 'The minimum refresh interval only applies with a price-move trigger.');

  const live = offers.filter((o) => o.terms.enabled);
  for (const o of live) {
    const valid = o.values.offer_valid_seconds;
    if (typeof valid === 'number' && valid < interval)
      issues.warn(`markets.${o.market}.${o.direction}.offer_valid_seconds`, `${o.market} ${o.direction}: the offer lapses after ${valid} s but is refreshed only every ${interval} s, so it is off between updates.`);
  }
  const per = BASE_FEE_LAMPORTS + priorityFeeLamports(typeof micro === 'number' ? micro : 0);
  const daily = dailyCostLamports(interval, per);
  const maxPerDay = updatesPerDay(Math.max(interval, typeof minRefresh === 'number' ? minRefresh : 0));
  const hasTrigger = typeof trigger === 'number' && trigger > 0;
  return {
    interval_secs: interval,
    lamports_per_update: per.toString(),
    daily_lamports: daily.toString(),
    daily_usd: lamportsToUsd(daily, ctx.solUsd),
    triggered_per_day: hasTrigger
      ? { expected: Math.min(maxPerDay, ctx.expectedTriggeredPerDay ?? Math.round(maxPerDay * 0.1)), max: maxPerDay }
      : { expected: updatesPerDay(interval), max: updatesPerDay(interval) },
  };
}

/** Every issue whose path is `prefix` or lies under it. */
export function issuesAt(list: readonly ConfigIssue[], prefix: string): ConfigIssue[] {
  return list.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
}

/** The file with defaults applied (the shape `GET /api/config` returns as `parsed`). */
export function withDefaults(cfg: Toml): Toml {
  const out: Toml = structuredClone(cfg);
  const ensure = (path: string): Toml => {
    let cur = out;
    for (const k of path.split('.')) {
      if (!isTable(cur[k])) cur[k] = {};
      cur = cur[k] as Toml;
    }
    return cur;
  };
  for (const s of allSections()) {
    // Optional tables that are absent stay absent, except the ones every daemon runs with.
    const always = ['pricing', 'offers', 'liquidity', 'guardrails', 'rebalance', 'rebalance.routing', 'daemon', 'rotation', 'tor', 'inbox', 'alerts', 'solana'].includes(s.path);
    if (!always && getPath(out, s.path) === undefined) continue;
    const t = ensure(s.path);
    for (const f of s.fields) if (t[f.key] === undefined && f.def !== undefined) t[f.key] = structuredClone(f.def);
  }
  for (const m of MARKETS) {
    for (const d of DIRECTIONS) {
      const t = ensure(`markets.${m}.${d}`);
      for (const [k, v] of Object.entries(offerDefaults(m))) if (t[k] === undefined) t[k] = structuredClone(v);
      if (t.max_xmr === undefined) {
        const largest = largestLadderSize(cfg);
        if (largest !== null) t.max_xmr = largest;
      }
    }
  }
  return out;
}
