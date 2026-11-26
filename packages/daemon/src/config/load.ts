/**
 * Loading and validating the configuration (SPEC 7.2): TOML → zod → resolved offers with every
 * chain-dependent default applied and every bound of SPEC 3.1 evaluated. Both example files of
 * `docs/DESIGN.md` pass unchanged, alone or concatenated.
 *
 * Pure: no file access, no environment access (only names of variables are kept).
 */
import { createHash } from 'node:crypto';
import { type RebalanceSettings, isPlaceholder, parseRebalanceSettings } from '@xmrswap/rebalancer';
import { CHAIN_CONSTS, CONTACT_KIND, type ChainName, MARKET_CHAIN, MARKET_DECIMALS } from '@xmrswap/protocol';
import type { ConfigIssue, ConfigValidation, EffectiveOfferTerms, UpdateCostEstimate } from '@xmrswap/protocol/daemon-api';
import { parse as parseToml } from 'smol-toml';
import { xmrToPico } from '../util.js';
import { DIRECTIONS, type DirectionName, MARKET_NAMES, type MarketName, type OfferSettings, type RawConfig, type SourceName, configSchema } from './schema.js';

export interface ResolvedOffer {
  market: MarketName;
  direction: DirectionName;
  chain: ChainName;
  /** 0 = A (the maker sells XMR), 1 = B. */
  directionCode: 0 | 1;
  decimals: number;
  /** Switched on in the file. */
  configured: boolean;
  /** Switched on and usable. */
  enabled: boolean;
  disabledReason: string | null;
  source: SourceName;
  fallbacks: SourceName[];
  crossCheck: SourceName | null;
  deviationPct: number;
  sizeTiers: { aboveXmr: bigint; extraPct: number }[];
  skewMaxPct: number;
  minXmr: bigint;
  maxXmr: bigint;
  validSecs: number;
  depthTiers: { aboveXmr: bigint; depth: number }[];
  noticeSecs: number;
  finalSecs: number;
  depositBps: number;
  dailyCapXmr: bigint | null;
  mode: 'auto' | 'window' | 'advance';
  approvalWindowSecs: number;
  claimDelaySecs: number;
  claimWindowSecs: number;
  minClaimDelaySecs: number;
  withholdPolicy: 'never' | 'always' | 'price_moved';
  withholdMovePct: number;
  volatilityWiden: { perPctMove: number; maxPct: number } | null;
  withoutReady: 'claim' | 'abort' | null;
}

export interface Config {
  raw: RawConfig;
  offers: ResolvedOffer[];
  rebalance: RebalanceSettings;
  ladder: { sizeXmr: bigint; count: number }[];
  reserveXmr: bigint;
  maxInFlightXmr: bigint | null;
  maxPerTakerXmr: bigint | null;
  blobEndpoint: boolean;
}

export interface LoadResult {
  /** `null` when the file has errors. */
  config: Config | null;
  validation: ConfigValidation;
  /** The file parsed, defaults applied. */
  parsed: Record<string, unknown>;
  toml: string;
  revision: string;
}

export const revisionOf = (toml: string): string => createHash('sha256').update(toml).digest('hex').slice(0, 16);

const DEFAULTS: Record<ChainName, { validSecs: number; noticeSecs: number; approvalWindowSecs: number; claimWindowMin: number; autoClaimDelayMin: number }> = {
  solana: { validSecs: 60, noticeSecs: 600, approvalWindowSecs: 60, claimWindowMin: 30, autoClaimDelayMin: 90 },
  ethereum: { validSecs: 150, noticeSecs: 1800, approvalWindowSecs: 120, claimWindowMin: 90, autoClaimDelayMin: 180 },
};
const MODE_CODE = { auto: 0, window: 1, advance: 2 } as const;
export const modeCode = (m: 'auto' | 'window' | 'advance'): number => MODE_CODE[m];

/** `Δ_cut = F + d × B + CUT_MARGIN_SECS` (SPEC 3.1). */
export const deltaCut = (chain: ChainName, depth: number): number => CHAIN_CONSTS[chain].finalitySecs + depth * CHAIN_CONSTS[chain].blockAllowanceSecs + CHAIN_CONSTS[chain].cutMarginSecs;
/** Smallest claim delay the chain accepts at a depth: `max(MIN_CLAIM_DELAY_SECS, Δ_cut + 2M)`. */
export const minClaimDelay = (chain: ChainName, depth: number): number => Math.max(CHAIN_CONSTS[chain].minClaimDelaySecs, deltaCut(chain, depth) + 2 * CHAIN_CONSTS[chain].marginSecs);

/** The pending window a swap of this offer uses (SPEC 3.1 `W_p`); `approval` = an advance approval is presented. */
export function pendingWindow(chain: ChainName, direction: 0 | 1, mode: number, approval: boolean, wA: number, wN: number): number {
  const effective = mode === 0 ? 0 : approval ? 2 : mode;
  if (CHAIN_CONSTS[chain].explicitApprove || effective === 1) return wA;
  return direction === 0 ? 0 : wN;
}

/** The first violated bound of SPEC 3.1 for one depth, or `null`. Same names as the core's `deadlines().boundError` family. */
export function boundProblem(p: { chain: ChainName; direction: 0 | 1; mode: number; wA: number; wN: number; dC: number; wC: number; wF: number; depth: number; depBps: number }): string | null {
  const c = CHAIN_CONSTS[p.chain];
  if (p.depth < 1 || p.depth > 255) return `depth ${p.depth} is outside 1..255`;
  if (p.depBps > c.maxDepositBps) return `deposit ${p.depBps} bps is over the cap of ${c.maxDepositBps}`;
  const canPend = c.explicitApprove || p.mode !== 0 || p.direction === 1;
  if (canPend && (c.explicitApprove || p.mode !== 0) && (p.wA < 30 || p.wA > c.maxApprovalSecs)) return `approval window ${p.wA} s is outside 30..${c.maxApprovalSecs}`;
  if (p.wN < c.minNoticeSecs || p.wN > c.maxNoticeSecs) return `notice window ${p.wN} s is outside ${c.minNoticeSecs}..${c.maxNoticeSecs}`;
  const minDc = minClaimDelay(p.chain, p.depth);
  if (p.dC < minDc) return `claim delay ${p.dC} s is under the bound ${minDc} s for depth ${p.depth}`;
  const minWc = c.finalitySecs + 2 * c.marginSecs;
  if (p.wC < minWc) return `claim window ${p.wC} s is under ${minWc} s`;
  // The longest pending window any swap of this offer can use.
  const wP = Math.max(pendingWindow(p.chain, p.direction, p.mode, false, p.wA, p.wN), pendingWindow(p.chain, p.direction, p.mode, true, p.wA, p.wN));
  const minWf = wP + p.wN + p.dC + p.wC + 86_400;
  if (p.wF < minWf) return `final window ${p.wF} s is under ${minWf} s`;
  if (p.wF > c.maxFinalSecs) return `final window ${p.wF} s is over ${c.maxFinalSecs} s`;
  return null;
}

function findPlaceholders(v: unknown, path: string[], out: ConfigIssue[]): void {
  if (isPlaceholder(v)) out.push({ path: path.join('.'), message: `${String(v)} is a placeholder; the feature that needs it stays off` });
  else if (Array.isArray(v)) v.forEach((x, i) => findPlaceholders(x, [...path, String(i)], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) findPlaceholders(x, [...path, k], out);
}

const usable = (v: string | undefined): v is string => typeof v === 'string' && v !== '' && !isPlaceholder(v);

export type PoolName = 'wxmr_pool' | 'wxmr_pool_sol';
export const isPool = (s: SourceName): s is PoolName => s === 'wxmr_pool' || s === 'wxmr_pool_sol';
/** A pool can be read once its two reserve accounts are named and no address is a placeholder. */
export function poolSourceUsable(raw: RawConfig, name: PoolName = 'wxmr_pool'): boolean {
  const p = raw.pricing.sources[name];
  return !!p && usable(p.base_vault) && usable(p.quote_vault) && !isPlaceholder(p.token) && !isPlaceholder(p.pool);
}
/** Whether a source can be read at all with this file: the keyed APIs always, a pool when its section is complete. */
export const sourceUsable = (raw: RawConfig, s: SourceName): boolean => !isPool(s) || poolSourceUsable(raw, s);

type Gives = 'XMR/USD' | 'SOL/USD' | 'ETH/USD' | 'XMR/SOL';
/** What a source can supply on its own. A SOL-quoted pool gives XMR/SOL; XMR/USD only together with SOL/USD from elsewhere. */
export function sourceGives(raw: RawConfig, s: SourceName): Gives[] {
  if (!isPool(s)) return ['XMR/USD', 'SOL/USD', 'ETH/USD'];
  return (raw.pricing.sources[s]?.quote ?? (s === 'wxmr_pool' ? 'usdc' : 'sol')) === 'usdc' ? ['XMR/USD'] : ['XMR/SOL'];
}
/**
 * Why `primary` cannot price a market with the help of the market's other sources, or `null`
 * when it can. USDC markets need XMR/USD; the SOL market needs XMR/SOL, directly or as XMR/USD
 * with SOL/USD; the ETH markets need XMR/USD with ETH/USD.
 */
export function missingPrice(raw: RawConfig, market: MarketName, primary: SourceName, all: SourceName[]): { needs: Gives; has: Gives; lacks: Gives } | { needs: Gives; has: null; lacks: Gives } | null {
  const own = sourceGives(raw, primary);
  const any = (g: Gives) => all.some((s) => sourceGives(raw, s).includes(g));
  const xmrUsd = own.includes('XMR/USD') || (own.includes('XMR/SOL') && any('SOL/USD'));
  if (market === 'sol') {
    if (own.includes('XMR/SOL') || (own.includes('XMR/USD') && any('SOL/USD'))) return null;
    return { needs: 'XMR/SOL', has: 'XMR/USD', lacks: 'SOL/USD' };
  }
  if (!xmrUsd) return { needs: 'XMR/USD', has: 'XMR/SOL', lacks: 'SOL/USD' };
  if (market === 'eth' && !any('ETH/USD')) return { needs: 'ETH/USD', has: null, lacks: 'ETH/USD' };
  return null;
}

/** The three warnings that replace the old "cross-check only" rule: the risk is stated, the choice is the maker's. */
export const RISK = {
  poolPrimary: 'a thin pool can be pushed off-market cheaply by someone who then takes your quote',
  noCrossCheck: 'nothing checks this price against a second source',
  noFallback: 'quoting pauses whenever this source is unavailable',
} as const;

function resolveOffer(raw: RawConfig, market: MarketName, direction: DirectionName, o: OfferSettings, largestLadder: bigint, blobEndpoint: boolean, errors: ConfigIssue[], warnings: ConfigIssue[]): ResolvedOffer {
  const chain = MARKET_CHAIN[market];
  const d = DEFAULTS[chain];
  const path = `markets.${market}.${direction}`;
  const err = (key: string, message: string) => errors.push({ path: key ? `${path}.${key}` : path, message });
  const warn = (key: string, message: string) => warnings.push({ path: key ? `${path}.${key}` : path, message });
  let disabledReason: string | null = o.enabled ? null : 'switched off';

  // The maker chooses its price sources freely: any configured source may be the primary, a fallback or the
  // cross-check, and a single source with no cross-check is valid. What the file says is what runs; the risks are
  // stated as warnings, never enforced.
  const source = o.source;
  const fallbacks = o.fallbacks.filter((f, i) => f !== source && o.fallbacks.indexOf(f) === i);
  const wanted = o.cross_check ?? raw.pricing.cross_check ?? 'none';
  let crossCheck: SourceName | null = wanted === 'none' ? null : wanted;
  if (o.enabled) {
    const named = [source, ...fallbacks, ...(crossCheck ? [crossCheck] : [])];
    for (const s of new Set(named)) {
      if (!isPool(s)) continue;
      if (!raw.pricing.sources[s]) err(s === source ? 'source' : fallbacks.includes(s) ? 'fallbacks' : 'cross_check', `${s} is named but [pricing.sources.${s}] is not in the file`);
      else if (!poolSourceUsable(raw, s)) warn(s === source ? 'source' : fallbacks.includes(s) ? 'fallbacks' : 'cross_check', `${s} cannot be read yet: its addresses are placeholders or missing (base_vault and quote_vault are needed); it is skipped until they are set`);
    }
    if (crossCheck === source) {
      warn('cross_check', `the cross-check is the primary source itself (${source}); it is treated as none: ${RISK.noCrossCheck}`);
      crossCheck = null;
    } else if (crossCheck && !sourceUsable(raw, crossCheck)) crossCheck = null;
    else if (!crossCheck) warn('cross_check', RISK.noCrossCheck);
    // What can actually be read decides what prices the market. Unreadable sources (placeholder addresses) are skipped.
    const readable = [source, ...fallbacks].filter((s) => sourceUsable(raw, s));
    const where = market + ' ' + direction;
    if (readable.length === 0) {
      if ([source, ...fallbacks].every((s) => !isPool(s) || raw.pricing.sources[s] !== undefined)) {
        disabledReason = 'none of its price sources can be read yet (placeholder addresses)';
        warn('source', 'none of this market\'s price sources can be read yet: it stays off until the pool addresses are set');
      }
    } else {
      const primary = readable[0]!;
      const miss = missingPrice(raw, market, primary, readable);
      if (miss) {
        if (miss.has === null) err('source', `${where} needs ${miss.needs}; ${primary} cannot supply it — add coingecko or coinmarketcap as this market's source for ${miss.lacks}, or disable the market`);
        else err('source', `${where} needs ${miss.needs}; ${primary} supplies ${miss.has} and nothing here supplies ${miss.lacks} — add coingecko or coinmarketcap as this market's source for ${miss.lacks}, use a ${miss.needs === 'XMR/SOL' ? 'SOL-quoted pool (wxmr_pool_sol)' : 'USDC-quoted pool (wxmr_pool)'}, or disable the market`);
      } else {
        for (const f of readable.slice(1)) if (missingPrice(raw, market, f, readable)) warn('fallbacks', `${f} cannot price this market by itself and is skipped as a fallback`);
        // A market priced in SOL straight from a SOL-quoted pool has no USD figure: guardrails stated in USD cannot be applied.
        const usdKnown = readable.some((s) => sourceGives(raw, s).includes('XMR/USD')) || readable.some((s) => sourceGives(raw, s).includes('SOL/USD'));
        if (!usdKnown && raw.guardrails.price_band_usd) err('source', `${where} has a hard price band in USD; ${primary} gives XMR/SOL and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, or remove guardrails.price_band_usd`);
        const pool = isPool(primary) ? raw.pricing.sources[primary] : undefined;
        if (pool && !usdKnown && pool.min_liquidity_usd > 0) err('source', `${primary} has min_liquidity_usd in USD; it is SOL-quoted and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, or set min_liquidity_usd = 0`);
      }
      if (isPool(primary)) warn('source', `${primary} is this market's primary price source: ${RISK.poolPrimary}`);
      if (readable.length === 1) warn('fallbacks', RISK.noFallback);
    }
  }

  const maxXmr = o.max_xmr !== undefined ? xmrToPico(o.max_xmr) : largestLadder;
  const minXmr = xmrToPico(o.min_xmr);
  if (o.enabled && maxXmr === 0n) err('max_xmr', 'max_xmr is not set and there is no output ladder to take a default from');
  if (o.enabled && maxXmr !== 0n && minXmr > maxXmr) err('min_xmr', `min_xmr ${o.min_xmr} is above max_xmr`);
  if (o.enabled && direction === 'sell_xmr' && largestLadder > 0n && maxXmr > largestLadder) warn('max_xmr', 'max_xmr is above the largest ladder output; one output funds one lock, so the published size is capped by the largest unlocked output');

  const sizeTiers = o.size_tiers.map((t) => ({ aboveXmr: xmrToPico(t.above_xmr), extraPct: t.extra_pct })).sort((a, b) => (a.aboveXmr < b.aboveXmr ? -1 : 1));
  if (sizeTiers.some((t, i) => t.aboveXmr === 0n || (i > 0 && t.aboveXmr === sizeTiers[i - 1]!.aboveXmr))) err('size_tiers', 'size tier thresholds must be above zero and distinct');

  const depthTiers = o.confirmation_depth.map((t) => ({ aboveXmr: xmrToPico(t.above_xmr), depth: t.depth }));
  if (depthTiers[0]!.aboveXmr !== 0n) err('confirmation_depth', 'the first depth tier must start at 0 XMR');
  if (depthTiers.some((t, i) => i > 0 && t.aboveXmr <= depthTiers[i - 1]!.aboveXmr)) err('confirmation_depth', 'depth tier thresholds must strictly increase');
  const inUse = depthTiers.filter((t) => maxXmr === 0n || t.aboveXmr <= maxXmr);
  const deepest = inUse.reduce((m, t) => Math.max(m, t.depth), 1);

  const validSecs = o.offer_valid_seconds ?? d.validSecs;
  const noticeSecs = o.notice_seconds ?? d.noticeSecs;
  const approvalWindowSecs = o.approval_window_seconds ?? d.approvalWindowSecs;
  const claimWindowSecs = Math.round((o.claim_window_minutes ?? d.claimWindowMin) * 60);
  const finalSecs = Math.round(o.final_days * 86_400);
  const minDc = minClaimDelay(chain, deepest);
  const claimDelaySecs = o.claim_delay_minutes === 'auto' ? Math.ceil(Math.max(d.autoClaimDelayMin * 60, minDc) / 60) * 60 : Math.round(o.claim_delay_minutes * 60);
  const depositBps = Math.round(o.deposit_pct * 100);
  const directionCode = direction === 'sell_xmr' ? 0 : 1;

  if (o.enabled) {
    for (const t of inUse) {
      const problem = boundProblem({ chain, direction: directionCode, mode: MODE_CODE[o.approval_mode], wA: approvalWindowSecs, wN: noticeSecs, dC: claimDelaySecs, wC: claimWindowSecs, wF: finalSecs, depth: t.depth, depBps: depositBps });
      if (problem) {
        err('', `${problem} (SPEC 3.1, ${chain})`);
        break;
      }
    }
    const pending = CHAIN_CONSTS[chain].explicitApprove || o.approval_mode !== 'auto';
    if (pending && approvalWindowSecs > 60) warn('approval_window_seconds', `an approval window of ${approvalWindowSecs} s holds taker funds; takers see a warning above 60 s`);
    if (chain === 'ethereum' && !blobEndpoint && disabledReason === null) {
      disabledReason = 'no blob endpoint is listed (an onion address or a contact of kind 5); Ethereum swaps need one for DLEQ proofs';
      warn('enabled', 'an Ethereum market needs a blob endpoint ([tor] enabled, or a [registration] contact of kind 5); this market stays off');
    }
    if (chain === 'solana' && direction === 'sell_xmr' && o.approval_mode === 'auto' && raw.liquidity.max_per_taker_xmr !== undefined)
      warn('approval_mode', 'max_per_taker_xmr cannot be enforced before the fact on a Solana auto-accept offer; the only remedy is abort');
    if (o.withhold_policy !== 'never' && depositBps === 0) warn('withhold_policy', 'a withhold policy without a deposit has no effect');
  }

  return {
    market, direction, chain, directionCode, decimals: MARKET_DECIMALS[market], configured: o.enabled, enabled: o.enabled && disabledReason === null, disabledReason,
    source, fallbacks, crossCheck, deviationPct: o.deviation_pct, sizeTiers, skewMaxPct: o.inventory_skew_max_pct, minXmr, maxXmr, validSecs, depthTiers, noticeSecs, finalSecs, depositBps,
    dailyCapXmr: o.daily_cap_xmr !== undefined ? xmrToPico(o.daily_cap_xmr) : null, mode: o.approval_mode, approvalWindowSecs, claimDelaySecs, claimWindowSecs, minClaimDelaySecs: minDc,
    withholdPolicy: o.withhold_policy, withholdMovePct: o.withhold_move_pct, volatilityWiden: o.volatility_widen ? { perPctMove: o.volatility_widen.per_pct_move, maxPct: o.volatility_widen.max_pct } : null, withoutReady: o.without_ready ?? null,
  };
}

export const effectiveTerms = (o: ResolvedOffer): EffectiveOfferTerms => ({
  market: o.market, direction: o.direction, enabled: o.enabled, approval_mode: o.mode, approval_window_secs: o.approvalWindowSecs, notice_secs: o.noticeSecs, claim_delay_secs: o.claimDelaySecs,
  claim_window_secs: o.claimWindowSecs, final_secs: o.finalSecs, deposit_bps: o.depositBps, depth_tiers: o.depthTiers.map((t) => ({ above_xmr: t.aboveXmr.toString(), depth: t.depth })), min_claim_delay_secs: o.minClaimDelaySecs,
});

/** Compute-unit limit of one `refresh_offers` (20,100 measured × 1.2, SPEC 4.9), for pricing the priority fee. */
export const REFRESH_CU = 24_120;
export function updateCost(raw: RawConfig, offers: ResolvedOffer[], solUsd: number | null = null): UpdateCostEstimate {
  const interval = raw.offers.update_interval_seconds;
  const perUpdate = 5_000n + BigInt(Math.ceil((raw.solana.priority_fee_microlamports * REFRESH_CU) / 1_000_000));
  const live = offers.filter((o) => o.enabled);
  const minValid = live.reduce((m, o) => Math.min(m, o.validSecs), Number.POSITIVE_INFINITY);
  const triggered = raw.offers.price_move_trigger_pct !== undefined;
  // Move-triggered: at least one keep-alive per validity (refreshed at 80% of it), at most one per minimum interval.
  const keepAlive = Number.isFinite(minValid) ? 86_400 / (0.8 * minValid) : 0;
  const perDay = triggered ? keepAlive : 86_400 / interval;
  const daily = BigInt(Math.ceil(perDay)) * perUpdate;
  return {
    interval_secs: interval, lamports_per_update: perUpdate.toString(), daily_lamports: daily.toString(), daily_usd: solUsd === null ? null : (Number(daily) / 1e9) * solUsd,
    triggered_per_day: triggered ? { expected: Math.ceil(keepAlive), max: Math.ceil(86_400 / (raw.offers.min_refresh_interval_seconds ?? interval)) } : { expected: 0, max: 0 },
  };
}

/** Parse and validate a configuration file. Never throws: every problem is an issue in the result. */
export function loadConfig(toml: string): LoadResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const revision = revisionOf(toml);
  const fail = (parsed: Record<string, unknown> = {}): LoadResult => ({ config: null, validation: { ok: false, errors, warnings, effective: [], update_cost: null }, parsed, toml, revision });

  let table: Record<string, unknown>;
  try {
    table = parseToml(toml) as Record<string, unknown>;
  } catch (e) {
    errors.push({ path: '', message: `not valid TOML: ${(e as Error).message.split('\n')[0]}` });
    return fail();
  }
  findPlaceholders(table, [], warnings);
  const parsed = configSchema.safeParse(table);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push({ path: i.path.join('.'), message: i.message });
    return fail(table);
  }
  const raw = parsed.data;

  let rebalance: RebalanceSettings;
  try {
    const r = parseRebalanceSettings(raw.rebalance);
    rebalance = r.settings;
    for (const w of r.warnings) warnings.push({ path: 'rebalance', message: w });
  } catch (e) {
    errors.push({ path: 'rebalance', message: (e as Error).message });
    return fail(raw as unknown as Record<string, unknown>);
  }

  const ladder = raw.liquidity.output_ladder.map((l) => ({ sizeXmr: xmrToPico(l.size_xmr), count: l.count })).sort((a, b) => (a.sizeXmr < b.sizeXmr ? -1 : 1));
  const largest = ladder.reduce((m, l) => (l.sizeXmr > m ? l.sizeXmr : m), 0n);
  const blobEndpoint = raw.tor.enabled || raw.registration.contacts.some((c) => c.kind === CONTACT_KIND.BLOB_ENDPOINT && usable(c.value));

  const offers: ResolvedOffer[] = [];
  for (const market of MARKET_NAMES) for (const direction of DIRECTIONS) offers.push(resolveOffer(raw, market, direction, raw.markets[market][direction], largest, blobEndpoint, errors, warnings));

  const live = offers.filter((o) => o.enabled);
  if (raw.pricing.cross_check === 'wxmr_pool' && !poolSourceUsable(raw)) warnings.push({ path: 'pricing.cross_check', message: 'the wXMR pool cross-check needs token, pool, base_vault and quote_vault; the cross-check stays off' });
  const band = raw.guardrails.price_band_usd;
  if (band && band.min > band.max) errors.push({ path: 'guardrails.price_band_usd', message: 'min is above max' });
  if (live.some((o) => o.direction === 'sell_xmr') && ladder.length === 0) warnings.push({ path: 'liquidity.output_ladder', message: 'no output ladder: sell-XMR capacity is zero until outputs are split' });
  const nodes = raw.monero.node_url_envs.length;
  if (live.length > 0 && !(nodes >= 2 || (nodes === 1 && raw.monero.own_node))) {
    const issue = { path: 'monero.node_url_envs', message: 'Monero verification needs two or more nodes, or one with own_node = true' };
    if (raw.daemon.mode === 'live') errors.push(issue);
    else warnings.push(issue);
  }
  if (raw.daemon.mode === 'live') {
    if (live.some((o) => o.chain === 'solana') && !raw.solana.maker_owner) errors.push({ path: 'solana.maker_owner', message: 'live mode with a Solana market needs the maker owner key (public)' });
    if (live.some((o) => o.chain === 'ethereum') && (!raw.ethereum.maker_owner || !raw.ethereum.contract || !raw.ethereum.chain_id)) errors.push({ path: 'ethereum', message: 'live mode with an Ethereum market needs contract, chain_id and maker_owner' });
  }
  if (raw.offers.min_refresh_interval_seconds !== undefined && raw.offers.price_move_trigger_pct === undefined) warnings.push({ path: 'offers.min_refresh_interval_seconds', message: 'has no effect without price_move_trigger_pct' });
  for (const o of live) if (raw.offers.update_interval_seconds > o.validSecs) warnings.push({ path: `markets.${o.market}.${o.direction}.offer_valid_seconds`, message: 'the update interval is longer than the offer validity: the offer lapses between refreshes' });
  if (raw.rotation.interval_hours > 0 && raw.rotation.interval_hours < raw.rotation.grace_hours) warnings.push({ path: 'rotation.interval_hours', message: 'rotating more often than the grace period keeps only one previous key valid on-chain; older messages get stale_key' });

  const validation: ConfigValidation = { ok: errors.length === 0, errors, warnings, effective: live.map(effectiveTerms), update_cost: live.some((o) => o.chain === 'solana' || o.chain === 'ethereum') ? updateCost(raw, offers) : null };
  const config: Config = {
    raw, offers, rebalance, ladder, reserveXmr: xmrToPico(raw.liquidity.xmr_reserve),
    maxInFlightXmr: raw.liquidity.max_in_flight_xmr !== undefined ? xmrToPico(raw.liquidity.max_in_flight_xmr) : null,
    maxPerTakerXmr: raw.liquidity.max_per_taker_xmr !== undefined ? xmrToPico(raw.liquidity.max_per_taker_xmr) : null,
    blobEndpoint,
  };
  return { config: errors.length === 0 ? config : null, validation, parsed: { ...raw, rebalance } as unknown as Record<string, unknown>, toml, revision };
}

/** Flatten a parsed file to dotted paths with values rendered as text (the change log's unit). */
export function flatten(v: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else if (v !== undefined) out[prefix] = JSON.stringify(v);
  return out;
}
export function diffConfigs(before: Record<string, unknown>, after: Record<string, unknown>): { path: string; old: string | null; new: string | null }[] {
  const a = flatten(before);
  const b = flatten(after);
  const out: { path: string; old: string | null; new: string | null }[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push({ path: k, old: a[k] ?? null, new: b[k] ?? null });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export const offerOf = (c: Config, market: string, direction: string): ResolvedOffer | undefined => c.offers.find((o) => o.market === market && o.direction === direction);
