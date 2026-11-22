/**
 * The `[rebalance]` settings (DESIGN "Rebalancing settings", SPEC 7.2). `parseRebalanceToml`
 * accepts a whole settings file or a `[rebalance]`-only fragment and ignores other sections,
 * which belong to the daemon's `config check`.
 *
 * Unknown keys inside `[rebalance]` are errors: a misspelt cap must not silently mean "no cap".
 */
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { VenueId } from './types.js';

export const VENUE_IDS = ['wxmr_bridge', 'exchange', 'changenow', 'stealthex', 'houdiniswap', 'fixedfloat'] as const satisfies readonly VenueId[];

const mode = z.enum(['auto', 'approve', 'alert']);
const pct = z.number().min(0).max(100);
const usd = z.number().positive();
const venueId = z.enum(VENUE_IDS);
const envName = z.string().min(1);

/** Keys every venue section accepts ("every item is configurable per asset and per venue"). */
const venueCommon = {
  enabled: z.boolean().default(false),
  mode: mode.optional(),
  max_cost_pct: pct.optional(),
  max_per_tx_usd: usd.optional(),
  max_per_day_usd: usd.optional(),
  max_share_pct: pct.optional(),
};

const level = z.strictObject({ low: z.number().min(0).optional(), target: z.number().min(0).optional(), high: z.number().min(0).optional() })
  .refine((l) => (l.low === undefined || l.target === undefined || l.low <= l.target) && (l.target === undefined || l.high === undefined || l.target <= l.high)
    && (l.low === undefined || l.high === undefined || l.low <= l.high), { message: 'levels must satisfy low <= target <= high' });

const instantVenue = z.strictObject({
  ...venueCommon,
  rate: z.enum(['fixed', 'float']).default('float'),
  api_key_env: envName.optional(),
  api_secret_env: envName.optional(),
});

const bridgeVenue = z.strictObject({
  ...venueCommon,
  max_piece_pct_of_pool: pct.default(2.0),
  max_wxmr_held: z.number().positive().optional(),
  redeem_immediately: z.boolean().default(true),
  require_heartbeat: z.boolean().default(true),
  reserve_proof_check_above_xmr: z.number().min(0).optional(),
  stalled_redeem_minutes: z.number().positive().default(60),
});

const exchangeVenue = z.strictObject({
  ...venueCommon,
  name: z.string().min(1).optional(),
  api_key_env: envName.optional(),
  api_secret_env: envName.optional(),
  withdraw_address_allowlist: z.boolean().default(true),
});

const venues = z.strictObject({
  wxmr_bridge: bridgeVenue.default(() => bridgeVenue.parse({})),
  exchange: exchangeVenue.default(() => exchangeVenue.parse({})),
  changenow: instantVenue.default(() => instantVenue.parse({})),
  // XMR support of the next two is unconfirmed (SPEC "Open risks"); they are off unless switched on explicitly.
  stealthex: instantVenue.default(() => instantVenue.parse({})),
  houdiniswap: instantVenue.default(() => instantVenue.parse({})),
  fixedfloat: instantVenue.default(() => instantVenue.parse({})),
});

const routing = z.strictObject({
  choose: z.enum(['best_quote', 'priority']).default('priority'),
  priority: z.array(venueId).default([...VENUE_IDS]).refine((p) => new Set(p).size === p.length, { message: 'a venue is listed twice' }),
  max_per_tx_usd: usd.optional(),
  max_per_day_usd: usd.optional(),
  max_share_pct: pct.optional(),
  cooldown_minutes: z.number().min(0).default(30),
  venue_timeout_minutes: z.number().positive().default(120),
  schedule: z.string().optional(),
});

const allowlist = z.strictObject({
  xmr: z.array(z.string().min(1)).default([]),
  sol: z.array(z.string().min(1)).default([]),
  eth: z.array(z.string().min(1)).default([]),
});

const crossChain = z.strictObject({
  enabled: z.boolean().default(false),
  venue: venueId.optional(),
  max_per_tx_usd: usd.optional(),
  max_cost_pct: pct.optional(),
});

export const rebalanceSchema = z.strictObject({
  mode: mode.default('alert'),
  max_cost_pct: pct.optional(),
  max_in_transit_usd: usd.optional(),
  test_transfer_usd: z.number().min(0).default(0),
  levels: z.strictObject({ xmr: level.optional(), sol: level.optional(), eth: level.optional(), usdc_sol: level.optional(), usdc_eth: level.optional() }).default({}),
  routing: routing.default(() => routing.parse({})),
  allowlist: allowlist.default(() => allowlist.parse({})),
  cross_chain: crossChain.default(() => crossChain.parse({})),
  venues: venues.default(() => venues.parse({})),
});

export type RebalanceSettings = z.infer<typeof rebalanceSchema>;
export type BridgeVenueSettings = z.infer<typeof bridgeVenue>;
export type ExchangeVenueSettings = z.infer<typeof exchangeVenue>;
export type InstantVenueSettings = z.infer<typeof instantVenue>;
export type RebalanceMode = z.infer<typeof mode>;

export interface ParsedSettings { settings: RebalanceSettings; warnings: string[] }

/** SPEC 7.2: "A string of the form `<…>` is a placeholder: accepted by the schema, reported as a warning, and the feature that needs it stays off." */
export const isPlaceholder = (v: unknown): boolean => typeof v === 'string' && /^<.*>$/.test(v);

export class SettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'SettingsError'; }
}

/** Validates the value of the `[rebalance]` table. */
export function parseRebalanceSettings(input: unknown): ParsedSettings {
  const r = rebalanceSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new SettingsError('invalid [rebalance] settings: ' + r.error.issues.map((i) => `${['rebalance', ...i.path].join('.')}: ${i.message}`).join('; '));
  }
  const settings = r.data;
  const warnings: string[] = [];

  for (const id of VENUE_IDS) {
    const v = settings.venues[id] as Record<string, unknown> & { enabled: boolean };
    for (const [k, val] of Object.entries(v)) {
      if (isPlaceholder(val) && v.enabled) {
        warnings.push(`rebalance.venues.${id}.${k} is a placeholder (${String(val)}); the venue stays off`);
        v.enabled = false;
      }
    }
  }
  const ex = settings.venues.exchange;
  if (ex.enabled && !ex.name) { warnings.push('rebalance.venues.exchange has no name; the venue stays off'); ex.enabled = false; }
  if (ex.enabled && !ex.withdraw_address_allowlist) warnings.push('rebalance.venues.exchange.withdraw_address_allowlist is false: restrict the API key to allow-listed withdrawal addresses where the exchange supports it');
  for (const id of ['changenow', 'fixedfloat', 'stealthex', 'houdiniswap', 'exchange'] as const) {
    const v = settings.venues[id];
    if (v.enabled && !v.api_key_env) { warnings.push(`rebalance.venues.${id} has no api_key_env; the venue stays off`); v.enabled = false; }
  }
  for (const id of ['fixedfloat', 'houdiniswap', 'exchange'] as const) {
    const v = settings.venues[id];
    if (v.enabled && !v.api_secret_env) warnings.push(`rebalance.venues.${id} has no api_secret_env; its adapter reports unhealthy until one is set`);
  }
  for (const id of ['stealthex', 'houdiniswap'] as const) {
    if (settings.venues[id].enabled) warnings.push(`rebalance.venues.${id} is enabled, but its XMR support is unconfirmed; re-read the service's terms and currency list first`);
  }
  if (settings.max_cost_pct === undefined) warnings.push('rebalance.max_cost_pct is not set: refills run at any cost unless a venue sets its own limit');
  if (settings.max_in_transit_usd === undefined) warnings.push('rebalance.max_in_transit_usd is not set: value in transit is unbounded');
  if (settings.test_transfer_usd === 0) warnings.push('rebalance.test_transfer_usd is 0: new venues and addresses get no test transfer');
  const shareSet = settings.routing.max_share_pct !== undefined || VENUE_IDS.some((id) => settings.venues[id].max_share_pct !== undefined);
  if (shareSet && settings.routing.max_per_day_usd === undefined) warnings.push('max_share_pct is a share of routing.max_per_day_usd, which is not set; the share cap has no effect');
  for (const id of VENUE_IDS) if (settings.venues[id].enabled && !settings.routing.priority.includes(id)) warnings.push(`rebalance.venues.${id} is enabled but missing from routing.priority; it is tried last`);
  if (settings.cross_chain.enabled) {
    const v = settings.cross_chain.venue;
    if (!v) { warnings.push('rebalance.cross_chain is enabled without a venue; it stays off'); settings.cross_chain.enabled = false; }
    else if (v === 'wxmr_bridge') throw new SettingsError('rebalance.cross_chain.venue: the wXMR bridge cannot move USDC between chains');
    else if (!settings.venues[v].enabled) { warnings.push(`rebalance.cross_chain.venue ${v} is not an enabled venue; cross-chain moves stay off`); settings.cross_chain.enabled = false; }
  }
  return { settings, warnings };
}

/** Parses TOML text and validates its `[rebalance]` table. Other tables are ignored. */
export function parseRebalanceToml(text: string): ParsedSettings {
  let doc: Record<string, unknown>;
  try { doc = parseToml(text) as Record<string, unknown>; } catch (e) { throw new SettingsError(`settings are not valid TOML: ${(e as Error).message}`); }
  return parseRebalanceSettings(doc['rebalance']);
}

/** Priority order with enabled-but-unlisted venues appended. */
export function venueOrder(settings: RebalanceSettings): VenueId[] {
  const order: VenueId[] = [...settings.routing.priority];
  for (const id of VENUE_IDS) if (!order.includes(id)) order.push(id);
  return order;
}

export interface LevelAction { asset: keyof RebalanceSettings['levels']; kind: 'refill' | 'drain'; /** Whole units to move to reach the target (or the breached bound when no target is set). */ amount: number }

/** Level triggers: which balances are below `low` (refill to `target`) or above `high` (drain to `target`). Balances in whole units. */
export function evaluateLevels(settings: RebalanceSettings, balances: Partial<Record<keyof RebalanceSettings['levels'], number>>): LevelAction[] {
  const out: LevelAction[] = [];
  for (const [asset, l] of Object.entries(settings.levels) as [keyof RebalanceSettings['levels'], z.infer<typeof level> | undefined][]) {
    const bal = balances[asset];
    if (!l || bal === undefined) continue;
    if (l.low !== undefined && bal < l.low) out.push({ asset, kind: 'refill', amount: (l.target ?? l.low) - bal });
    else if (l.high !== undefined && bal > l.high) out.push({ asset, kind: 'drain', amount: bal - (l.target ?? l.high) });
  }
  return out;
}
