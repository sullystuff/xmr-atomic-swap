/**
 * The configuration schema of SPEC 7.2 as data: every key with its type, default, bounds and the
 * words the console shows beside it. The same table drives the form, the local validation and
 * the mock daemon's `config check`, so they cannot drift apart.
 */
import { CHAIN_CONSTS, MARKET_CHAIN, type ChainName, type Market } from '@xmrswap/protocol';
import type { AssetId, MarketDirection, VenueId } from '@xmrswap/protocol/daemon-api';

export const MARKETS: readonly Market[] = ['usdc_sol', 'sol', 'usdc_eth', 'eth'];
export const DIRECTIONS: readonly MarketDirection[] = ['sell_xmr', 'buy_xmr'];
export const DIRECTION_LABEL: Readonly<Record<MarketDirection, string>> = { sell_xmr: 'Sell XMR', buy_xmr: 'Buy XMR' };
export const ASSETS: readonly AssetId[] = ['xmr', 'sol', 'eth', 'usdc_sol', 'usdc_eth'];
export const PAYING_ASSETS: readonly Exclude<AssetId, 'xmr'>[] = ['sol', 'eth', 'usdc_sol', 'usdc_eth'];
export const VENUES: readonly VenueId[] = ['wxmr_bridge', 'exchange', 'changenow', 'fixedfloat', 'stealthex', 'houdiniswap'];
export const VENUE_LABEL: Readonly<Record<VenueId | 'opposite_flow' | 'manual', string>> = {
  wxmr_bridge: 'wXMR bridge',
  exchange: 'Exchange',
  changenow: 'ChangeNOW',
  fixedfloat: 'FixedFloat',
  stealthex: 'StealthEX',
  houdiniswap: 'HoudiniSwap',
  opposite_flow: 'Opposite-side flow',
  manual: 'Manual',
};
/** `wxmr_pool` is USDC-quoted unless its `quote` says otherwise; `wxmr_pool_sol` is a second pool, SOL-quoted by default. */
export const PRICE_SOURCES = ['coingecko', 'coinmarketcap', 'wxmr_pool', 'wxmr_pool_sol'] as const;
export const POOL_SOURCES = ['wxmr_pool', 'wxmr_pool_sol'] as const;
export type PoolSource = (typeof POOL_SOURCES)[number];
export const isPool = (s: string): s is PoolSource => s === 'wxmr_pool' || s === 'wxmr_pool_sol';
export type PriceSource = (typeof PRICE_SOURCES)[number];
export const SOURCE_LABEL: Readonly<Record<PriceSource, string>> = {
  coingecko: 'CoinGecko',
  coinmarketcap: 'CoinMarketCap',
  wxmr_pool: 'wXMR pool',
  wxmr_pool_sol: 'wXMR pool (second, SOL-quoted)',
};
export const MODE_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'approve', label: 'Approve each refill' },
  { value: 'alert', label: 'Alert only' },
] as const;

export interface Option {
  value: string;
  label: string;
}
export interface Column {
  key: string;
  label: string;
  type: 'number' | 'int' | 'text';
  min?: number;
  max?: number;
  unit?: string;
}
export type FieldType =
  | { t: 'bool' }
  | { t: 'number'; int?: boolean; min?: number; max?: number; exclusiveMin?: boolean }
  | { t: 'text' }
  /** Names an environment variable; the value itself never goes in the file. */
  | { t: 'env' }
  | { t: 'select'; options: readonly Option[] }
  | { t: 'list'; options?: readonly Option[]; env?: boolean }
  /** An array of small tables, edited as rows. */
  | { t: 'rows'; columns: readonly Column[]; maxRows?: number }
  /** A table with a fixed set of numeric keys. */
  | { t: 'record'; keys: readonly Column[]; required?: boolean }
  /** `"auto"` or a number. */
  | { t: 'auto-number'; min?: number; int?: boolean }
  /** A free table from string to string. */
  | { t: 'map' }
  /** Validated by a dedicated rule. */
  | { t: 'custom' };

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Shown as the effective value when the key is absent. */
  def?: unknown;
  /** Words for a default that is not a literal ("unlimited", "largest ladder size"). */
  defText?: string;
  unit?: string;
  help?: string;
}
export interface SectionDef {
  /** Dotted path of the table. */
  path: string;
  title: string;
  fields: readonly FieldDef[];
  /** Names of child tables that are valid here (so they are not reported as unknown keys). */
  children?: readonly string[];
}

const num = (o: Partial<Extract<FieldType, { t: 'number' }>> = {}): FieldType => ({ t: 'number', ...o });
const int = (o: Partial<Extract<FieldType, { t: 'number' }>> = {}): FieldType => ({ t: 'number', int: true, ...o });
const sel = (...values: (string | Option)[]): FieldType => ({
  t: 'select',
  options: values.map((v) => (typeof v === 'string' ? { value: v, label: v } : v)),
});
const sourceOptions: readonly Option[] = PRICE_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }));
const venueOptions: readonly Option[] = VENUES.map((v) => ({ value: v, label: VENUE_LABEL[v] }));

// ------------------------------------------------------------------ offers

/** Chain-dependent defaults of an offer (SPEC 7.2 and 3.1). */
export function offerDefaults(market: Market): Record<string, unknown> {
  const eth = MARKET_CHAIN[market] === 'ethereum';
  return {
    enabled: false,
    source: 'coingecko',
    fallbacks: [],
    deviation_pct: 2.0,
    size_tiers: [],
    inventory_skew_max_pct: 0,
    min_xmr: 0.1,
    offer_valid_seconds: eth ? 150 : 60,
    confirmation_depth: DEFAULT_DEPTH_TIERS,
    notice_seconds: eth ? 1800 : 600,
    final_days: 7,
    deposit_pct: 0,
    approval_mode: 'auto',
    approval_window_seconds: eth ? 120 : 60,
    claim_delay_minutes: 'auto',
    claim_window_minutes: eth ? 90 : 30,
    withhold_policy: 'never',
    withhold_move_pct: 1.0,
  };
}
export const DEFAULT_DEPTH_TIERS: readonly { above_xmr: number; depth: number }[] = [
  { above_xmr: 0, depth: 2 },
  { above_xmr: 1, depth: 10 },
  { above_xmr: 50, depth: 25 },
];
export const MAX_DEPOSIT_PCT = CHAIN_CONSTS.solana.maxDepositBps / 100;
/** The console's recommendation for the approval window (DESIGN "Approval modes"). */
export const RECOMMENDED_APPROVAL_SECS = 60;
export const APPROVAL_WINDOW_REASON = 'Longer windows hold taker funds and deter takers.';
export const APPROVAL_WINDOW_HELP = `60 seconds or less is strongly recommended. ${APPROVAL_WINDOW_REASON} Anything longer shows takers a warning before they lock.`;

export function offerFields(market: Market): FieldDef[] {
  const chain = MARKET_CHAIN[market];
  const c = CHAIN_CONSTS[chain];
  const d = offerDefaults(market);
  return [
    { key: 'enabled', label: 'Enabled', type: { t: 'bool' }, def: false, help: 'Whether the offer is live.' },
    { key: 'source', label: 'Primary price source', type: { t: 'select', options: sourceOptions }, def: 'coingecko' },
    { key: 'fallbacks', label: 'Fallback order', type: { t: 'list', options: sourceOptions }, def: [], help: 'Tried in this order when the primary fails. None is a valid choice.' },
    {
      key: 'cross_check',
      label: 'Cross-check for this market',
      type: { t: 'select', options: [{ value: '', label: 'Same as the setting for all markets' }, ...sourceOptions, { value: 'none', label: 'None for this market' }] },
      defText: 'the setting for all markets',
      help: 'A second source this market’s price is compared with.',
    },
    {
      key: 'deviation_pct',
      label: 'Deviation from reference',
      type: num({ min: -50, max: 100 }),
      def: 2.0,
      unit: '%',
      help: 'Added to the reference price when selling XMR, subtracted when buying. May be negative.',
    },
    {
      key: 'size_tiers',
      label: 'Size tiers',
      type: {
        t: 'rows',
        maxRows: 2,
        columns: [
          { key: 'above_xmr', label: 'Above', type: 'number', min: 0, unit: 'XMR' },
          { key: 'extra_pct', label: 'Extra deviation', type: 'number', unit: '%' },
        ],
      },
      def: [],
      help: 'Extra deviation above a swap size. At most two tiers.',
    },
    { key: 'inventory_skew_max_pct', label: 'Inventory skew', type: num({ min: 0, max: 100 }), def: 0, unit: '% max', help: 'Extra deviation as inventory moves away from its target.' },
    { key: 'min_xmr', label: 'Smallest swap', type: num({ min: 0, exclusiveMin: true }), def: 0.1, unit: 'XMR' },
    { key: 'max_xmr', label: 'Largest swap', type: num({ min: 0, exclusiveMin: true }), defText: 'largest ladder size', unit: 'XMR' },
    {
      key: 'offer_valid_seconds',
      label: 'Offer validity',
      type: int({ min: 1 }),
      def: d.offer_valid_seconds,
      unit: 's',
      help: 'How long an offer stays live without a refresh, so a stopped daemon’s offers lapse.',
    },
    {
      key: 'confirmation_depth',
      label: 'Confirmation depth',
      type: {
        t: 'rows',
        maxRows: 3,
        columns: [
          { key: 'above_xmr', label: 'From', type: 'number', min: 0, unit: 'XMR' },
          { key: 'depth', label: 'Confirmations', type: 'int', min: 1, max: 255 },
        ],
      },
      def: DEFAULT_DEPTH_TIERS,
      help: 'Monero confirmations required, by swap size. The first tier starts at 0.',
    },
    {
      key: 'notice_seconds',
      label: 'Lock-notice deadline',
      type: int({ min: c.minNoticeSecs, max: c.maxNoticeSecs }),
      def: d.notice_seconds,
      unit: 's',
      help: `Between ${c.minNoticeSecs} and ${c.maxNoticeSecs} seconds on ${chainLabel(chain)}.`,
    },
    { key: 'final_days', label: 'Final deadline', type: num({ min: 0, exclusiveMin: true, max: c.maxFinalSecs / 86_400 }), def: 7, unit: 'days' },
    {
      key: 'deposit_pct',
      label: 'Anti-spam deposit',
      type: num({ min: 0, max: MAX_DEPOSIT_PCT }),
      def: 0,
      unit: '%',
      help: `Percent of the locked amount held on a refund. The contract caps it at ${MAX_DEPOSIT_PCT}%.`,
    },
    { key: 'daily_cap_xmr', label: 'Daily volume cap', type: num({ min: 0 }), defText: 'unlimited', unit: 'XMR', help: 'Total the offer will fill in a day.' },
    {
      key: 'approval_mode',
      label: 'Approval mode',
      type: sel({ value: 'auto', label: 'Auto-accept' }, { value: 'window', label: 'Approve within a window' }, { value: 'advance', label: 'Approved in advance' }),
      def: 'auto',
      ...(chain === 'ethereum' ? { help: 'On Ethereum every swap is approved explicitly; auto-accept is the daemon approving once the taker’s proof verifies.' } : {}),
    },
    {
      key: 'approval_window_seconds',
      label: 'Approval window',
      type: int({ min: 30, max: c.maxApprovalSecs }),
      def: d.approval_window_seconds,
      unit: 's',
      help: APPROVAL_WINDOW_HELP,
    },
    {
      key: 'claim_delay_minutes',
      label: 'Claim delay',
      type: { t: 'auto-number', min: c.minClaimDelaySecs / 60 },
      def: 'auto',
      unit: 'min',
      help: `How long before you can claim without the taker’s ready. The contract’s floor on ${chainLabel(chain)} is ${c.minClaimDelaySecs / 60} minutes; the depth in use can raise it.`,
    },
    { key: 'claim_window_minutes', label: 'Claim window', type: num({ min: 0, exclusiveMin: true }), def: d.claim_window_minutes, unit: 'min', help: 'How long you have to claim after the taker sets ready.' },
    {
      key: 'withhold_policy',
      label: 'Withhold policy',
      type: sel({ value: 'never', label: 'Never withhold' }, { value: 'always', label: 'Always withhold' }, { value: 'price_moved', label: 'When the price moved against me' }),
      def: 'never',
      help: 'When to withhold a refunding taker’s deposit. A withheld deposit never goes to you, and your withhold rate is public.',
    },
    { key: 'withhold_move_pct', label: 'Withhold when price moved', type: num({ min: 0 }), def: 1.0, unit: '%', help: 'Used by the "price moved" policy.' },
    {
      key: 'volatility_widen',
      label: 'Widen with volatility',
      type: {
        t: 'record',
        keys: [
          { key: 'per_pct_move', label: 'Extra per 1% move', type: 'number', min: 0, unit: '%' },
          { key: 'max_pct', label: 'At most', type: 'number', min: 0, unit: '%' },
        ],
        required: true,
      },
      defText: 'off',
      help: 'Extra deviation as the reference price moves. Off unless set.',
    },
    {
      key: 'without_ready',
      label: 'When the taker never sets ready',
      type: { t: 'select', options: [{ value: '', label: 'Default: claim' }, { value: 'claim', label: 'Claim once my own lock is confirmed' }, { value: 'abort', label: 'Always abort' }] },
      defText: 'claim',
      help: 'Selling XMR only. Claiming publishes your key half and takes the funds; aborting returns them when the taker collects.',
    },
  ];
}

export const chainLabel = (c: ChainName): string => (c === 'solana' ? 'Solana' : 'Ethereum');

// ------------------------------------------------------------------ fixed sections

const assetColumns = (unitFor: (a: AssetId) => string, assets: readonly AssetId[] = ASSETS): Column[] =>
  assets.map((a) => ({ key: a, label: a, type: 'number', min: 0, unit: unitFor(a) }));
const assetUnit = (a: AssetId): string => (a.startsWith('usdc') ? 'USDC' : a.toUpperCase());

export const PRICING: SectionDef = {
  path: 'pricing',
  title: 'Price sources',
  children: ['sources'],
  fields: [
    { key: 'refresh_seconds', label: 'Refresh interval', type: int({ min: 1 }), def: 15, unit: 's' },
    { key: 'max_age_seconds', label: 'Maximum price age', type: int({ min: 1 }), def: 60, unit: 's', help: 'A price older than this is stale.' },
    { key: 'cross_check', label: 'Cross-check source', type: { t: 'select', options: [{ value: '', label: 'None' }, ...sourceOptions] }, defText: 'none', help: 'For every market that does not name its own. None is a valid choice.' },
    { key: 'max_disagreement_pct', label: 'Largest disagreement allowed', type: num({ min: 0, exclusiveMin: true }), def: 1.0, unit: '%' },
    {
      key: 'on_failure',
      label: 'When a check fails',
      type: sel({ value: 'pause', label: 'Pause quoting' }, { value: 'widen', label: 'Widen the deviation' }),
      def: 'pause',
    },
    { key: 'widen_pct', label: 'Widen by', type: num({ min: 0 }), def: 0.5, unit: '%', help: 'Used when a failed check widens instead of pausing.' },
  ],
};
const keyedSource = (name: 'coingecko' | 'coinmarketcap'): SectionDef => ({
  path: `pricing.sources.${name}`,
  title: SOURCE_LABEL[name],
  fields: [
    { key: 'api_key_env', label: 'API key variable', type: { t: 'env' }, help: 'Name of the environment variable that holds the key. The key itself never goes in the file.' },
    { key: 'min_interval_seconds', label: 'Minimum request interval', type: num({ min: 0, exclusiveMin: true }), unit: 's', defText: 'the plan’s rate limit' },
    { key: 'base_url', label: 'API base URL', type: { t: 'text' }, defText: 'the service’s public API', help: 'Only for a self-hosted mirror or a test endpoint.' },
  ],
});
function poolSection(name: PoolSource): SectionDef {
  const sol = name === 'wxmr_pool_sol';
  return {
    path: `pricing.sources.${name}`,
    title: sol ? 'Second wXMR pool on Solana (SOL-quoted by default)' : 'wXMR pool on Solana',
    fields: [
      { key: 'token', label: 'Token address', type: { t: 'text' }, help: 'Pinned.' },
      { key: 'pool', label: 'Pool address', type: { t: 'text' }, help: 'Pinned.' },
      { key: 'base_vault', label: 'wXMR reserve account', type: { t: 'text' }, help: 'The pool’s token account on the wXMR side.' },
      { key: 'quote_vault', label: 'Quote reserve account', type: { t: 'text' }, help: 'The pool’s token account on the quote side.' },
      { key: 'quote', label: 'Quote asset', type: sel({ value: 'usdc', label: 'USDC: gives XMR/USD' }, { value: 'sol', label: 'SOL: gives XMR/SOL' }), def: sol ? 'sol' : 'usdc' },
      { key: 'min_liquidity_usd', label: 'Minimum pool liquidity', type: num({ min: 0 }), def: 0, unit: 'USD', help: 'Below this the pool’s price is not used. The main protection against a pool pushed off-market.' },
      { key: 'average_seconds', label: 'Averaging window', type: num({ min: 0 }), def: 300, unit: 's', help: 'The price is averaged over this long, so a brief push moves it less.' },
    ],
  };
}
export const SOURCE_SECTIONS: readonly SectionDef[] = [
  keyedSource('coingecko'),
  keyedSource('coinmarketcap'),
  poolSection('wxmr_pool'),
  poolSection('wxmr_pool_sol'),
];

export const OFFERS: SectionDef = {
  path: 'offers',
  title: 'Offer updates',
  fields: [
    { key: 'update_interval_seconds', label: 'Update interval', type: int({ min: 1 }), def: 15, unit: 's', help: 'One transaction refreshes every market, including the signed Ethereum quotes.' },
    { key: 'price_move_trigger_pct', label: 'Update only when the price moves by', type: num({ min: 0, exclusiveMin: true }), unit: '%', defText: 'off: update every interval' },
    { key: 'min_refresh_interval_seconds', label: 'Minimum refresh interval', type: int({ min: 1 }), unit: 's', defText: 'the update interval', help: 'The fastest a move-triggered update may repeat.' },
    { key: 'key_pool_low_water', label: 'Refill key pool below', type: int({ min: 0, max: 16 }), def: 4, unit: 'slots' },
    { key: 'eth_pool_size', label: 'Ethereum key-pool size', type: int({ min: 2, max: 256 }), def: 64, unit: 'leaves' },
  ],
};

export const LIQUIDITY: SectionDef = {
  path: 'liquidity',
  title: 'Liquidity',
  fields: [
    { key: 'xmr_reserve', label: 'XMR reserve', type: num({ min: 0 }), def: 0, unit: 'XMR', help: 'Never offered.' },
    {
      key: 'output_ladder',
      label: 'Output ladder',
      type: {
        t: 'rows',
        columns: [
          { key: 'size_xmr', label: 'Size', type: 'number', min: 0, unit: 'XMR' },
          { key: 'count', label: 'Count', type: 'int', min: 0 },
        ],
      },
      def: [],
      help: 'Which sizes to pre-split and how many of each. One output funds one swap at a time.',
    },
    { key: 'max_in_flight_xmr', label: 'Largest total in flight', type: num({ min: 0 }), unit: 'XMR', defText: 'unlimited' },
    { key: 'max_per_taker_xmr', label: 'Largest amount per taker', type: num({ min: 0 }), unit: 'XMR', defText: 'unlimited' },
    { key: 'allocation', label: 'XMR allocation', type: { t: 'custom' }, def: 'shared', help: 'One shared pool, or a fixed allocation per market.' },
    { key: 'ladder_headroom_pct', label: 'Ladder headroom', type: num({ min: 0 }), def: 1.0, unit: '%', help: 'How much larger than its offer size a ladder output is cut, so one output covers the amount plus the fee.' },
    { key: 'paying_caps', label: 'Paying-balance caps', type: { t: 'record', keys: assetColumns(assetUnit, PAYING_ASSETS) }, defText: 'unlimited', help: 'Most of each balance committed to buy-XMR offers.' },
    { key: 'targets', label: 'Target inventory', type: { t: 'record', keys: assetColumns(assetUnit) }, defText: 'none', help: 'Target per asset; inventory skew is measured against it.' },
  ],
};

export const GUARDRAILS: SectionDef = {
  path: 'guardrails',
  title: 'Guardrails',
  fields: [
    {
      key: 'volatility_pause',
      label: 'Volatility pause',
      type: {
        t: 'record',
        required: true,
        keys: [
          { key: 'move_pct', label: 'Move', type: 'number', min: 0, unit: '%' },
          { key: 'window_seconds', label: 'Within', type: 'int', min: 1, unit: 's' },
        ],
      },
      defText: 'off',
      help: 'Stop quoting if the reference moves more than a set percent within a set time.',
    },
    { key: 'disagreement_pause', label: 'Disagreement pause', type: { t: 'bool' }, def: true, help: 'Stop quoting if the primary and cross-check sources differ by more than the allowed percent. It applies only to markets that have a cross-check other than their primary source.' },
    { key: 'stale_pause', label: 'Stale price pause', type: { t: 'bool' }, def: true, help: 'Stop quoting if no fresh price has arrived within the maximum age.' },
    {
      key: 'price_band_usd',
      label: 'Hard price band',
      type: {
        t: 'record',
        required: true,
        keys: [
          { key: 'min', label: 'Minimum', type: 'number', min: 0, unit: 'USD' },
          { key: 'max', label: 'Maximum', type: 'number', min: 0, unit: 'USD' },
        ],
      },
      defText: 'off',
      help: 'Never quote outside a manual minimum and maximum price per XMR.',
    },
    { key: 'dry_run', label: 'Dry run', type: { t: 'bool' }, def: false, help: 'Show the offers the engine would post, without posting them.' },
    { key: 'reorg_guard', label: 'Reorg guard', type: { t: 'custom' }, defText: 'off', help: 'Raise the confirmation depth while the Monero nodes report reorgs.' },
  ],
};

export const REBALANCE: SectionDef = {
  path: 'rebalance',
  title: 'Rebalancing',
  children: ['levels', 'routing', 'allowlist', 'cross_chain', 'venues'],
  fields: [
    { key: 'mode', label: 'Mode', type: { t: 'select', options: MODE_OPTIONS }, def: 'alert' },
    { key: 'max_cost_pct', label: 'Largest total cost', type: num({ min: 0 }), unit: '%', defText: 'none', help: 'Against the reference price. A refill is skipped if every venue exceeds it.' },
    { key: 'max_in_transit_usd', label: 'In-transit cap', type: num({ min: 0 }), unit: 'USD', defText: 'none', help: 'Limit on the total value sitting with third parties at once.' },
    { key: 'test_transfer_usd', label: 'Test transfer', type: num({ min: 0 }), def: 0, unit: 'USD', help: 'A small first transfer for any new venue or address.' },
  ],
};
export const levelSection = (asset: AssetId): SectionDef => ({
  path: `rebalance.levels.${asset}`,
  title: asset,
  fields: (['low', 'target', 'high'] as const).map((k) => ({ key: k, label: k, type: num({ min: 0 }), unit: assetUnit(asset) })),
});
export const ROUTING: SectionDef = {
  path: 'rebalance.routing',
  title: 'Venue choice',
  fields: [
    { key: 'choose', label: 'Choose by', type: sel({ value: 'priority', label: 'Fixed priority order' }, { value: 'best_quote', label: 'Best net quote' }), def: 'priority' },
    { key: 'priority', label: 'Priority order', type: { t: 'list', options: venueOptions }, def: [] },
    { key: 'max_per_tx_usd', label: 'Cap per transaction', type: num({ min: 0 }), unit: 'USD', defText: 'none' },
    { key: 'max_per_day_usd', label: 'Cap per day', type: num({ min: 0 }), unit: 'USD', defText: 'none' },
    { key: 'max_share_pct', label: 'Cap on each venue’s share', type: num({ min: 0, max: 100 }), unit: '% of the daily cap', defText: 'none' },
    { key: 'cooldown_minutes', label: 'Cooldown after a failure', type: num({ min: 0 }), def: 30, unit: 'min' },
    { key: 'venue_timeout_minutes', label: 'Venue timeout', type: num({ min: 0, exclusiveMin: true }), def: 120, unit: 'min' },
    { key: 'schedule', label: 'Schedule', type: { t: 'text' }, defText: 'none', help: 'Run on a schedule as well as by level.' },
  ],
};
export const ALLOWLIST: SectionDef = {
  path: 'rebalance.allowlist',
  title: 'Address allow-list',
  fields: (['xmr', 'sol', 'eth'] as const).map((k) => ({
    key: k,
    label: `${k.toUpperCase()} addresses`,
    type: { t: 'list' } as FieldType,
    defText: 'the inventory wallet and the operator and payout addresses',
  })),
};
export const CROSS_CHAIN: SectionDef = {
  path: 'rebalance.cross_chain',
  title: 'Cross-chain USDC moves',
  fields: [
    { key: 'enabled', label: 'Enabled', type: { t: 'bool' }, def: false, help: 'Shift USDC between the Solana and Ethereum sides when their levels call for it.' },
    { key: 'venue', label: 'Venue', type: { t: 'select', options: [{ value: '', label: 'None' }, ...venueOptions.filter((v) => v.value !== 'wxmr_bridge')] } },
    { key: 'max_per_tx_usd', label: 'Cap per transaction', type: num({ min: 0 }), unit: 'USD', defText: 'the global cap' },
    { key: 'max_cost_pct', label: 'Largest cost', type: num({ min: 0 }), unit: '%', defText: 'the global limit' },
  ],
};
const VENUE_COMMON: readonly FieldDef[] = [
  { key: 'enabled', label: 'Enabled', type: { t: 'bool' }, def: false },
  { key: 'mode', label: 'Mode', type: { t: 'select', options: [{ value: '', label: 'Same as global' }, ...MODE_OPTIONS] }, defText: 'the global mode' },
  { key: 'max_cost_pct', label: 'Largest total cost', type: num({ min: 0 }), unit: '%', defText: 'the global limit' },
  { key: 'max_per_tx_usd', label: 'Cap per transaction', type: num({ min: 0 }), unit: 'USD', defText: 'the global cap' },
  { key: 'max_per_day_usd', label: 'Cap per day', type: num({ min: 0 }), unit: 'USD', defText: 'the global cap' },
  { key: 'max_share_pct', label: 'Share of the daily cap', type: num({ min: 0, max: 100 }), unit: '%', defText: 'the global cap' },
];
const rateField: FieldDef = { key: 'rate', label: 'Rate type', type: sel({ value: 'float', label: 'Floating' }, { value: 'fixed', label: 'Fixed' }), def: 'float' };
const apiKey: FieldDef = { key: 'api_key_env', label: 'API key variable', type: { t: 'env' } };
const apiSecret: FieldDef = { key: 'api_secret_env', label: 'API secret variable', type: { t: 'env' } };
export function venueSection(venue: VenueId): SectionDef {
  const path = `rebalance.venues.${venue}`;
  const title = VENUE_LABEL[venue];
  if (venue === 'wxmr_bridge') {
    return {
      path,
      title,
          fields: [
        ...VENUE_COMMON,
        { key: 'max_piece_pct_of_pool', label: 'Piece size', type: num({ min: 0, max: 100 }), def: 2.0, unit: '% of pool depth' },
        { key: 'max_wxmr_held', label: 'Most wXMR held at once', type: num({ min: 0 }), unit: 'wXMR' },
        { key: 'redeem_immediately', label: 'Redeem at once', type: { t: 'bool' }, def: true },
        { key: 'require_heartbeat', label: 'Check the heartbeat before each refill', type: { t: 'bool' }, def: true },
        { key: 'reserve_proof_check_above_xmr', label: 'Check the reserve proof above', type: num({ min: 0 }), unit: 'XMR', defText: 'never' },
        { key: 'stalled_redeem_minutes', label: 'Cancel a stalled redemption after', type: num({ min: 0, exclusiveMin: true }), def: 60, unit: 'min' },
      ],
    };
  }
  if (venue === 'exchange') {
    return {
      path,
      title,
      fields: [
        ...VENUE_COMMON,
        { key: 'name', label: 'Exchange', type: { t: 'text' }, help: 'The only driver in this version is "kraken".' },
        apiKey,
        apiSecret,
        { key: 'withdraw_address_allowlist', label: 'Keys restricted to allow-listed withdrawal addresses', type: { t: 'bool' }, def: true },
        {
          key: 'withdraw_keys',
          label: 'Withdrawal keys',
          type: { t: 'map' },
          help: 'Your own withdrawal address = the key name registered for it at the exchange. A withdrawal needs both an allow-list entry and a key.',
        },
      ],
    };
  }
  return { path, title, fields: [...VENUE_COMMON, rateField, apiKey, apiSecret] };
}

export const DAEMON: SectionDef = {
  path: 'daemon',
  title: 'Daemon',
  fields: [
    {
      key: 'mode',
      label: 'Mode',
      type: sel({ value: 'dry_run', label: 'Dry run: compute and show, send nothing' }, { value: 'live', label: 'Live' }),
      def: 'dry_run',
      help: 'Dry run sends no transaction and moves no XMR. It is the default.',
    },
    { key: 'data_dir', label: 'Data directory', type: { t: 'text' }, def: './data' },
    { key: 'api_bind', label: 'Local API address', type: { t: 'text' }, def: '127.0.0.1:7071', help: 'Loopback only. Changing it disconnects this console until you reconnect.' },
    { key: 'keystore_passphrase_env', label: 'Keystore passphrase variable', type: { t: 'env' }, def: 'XMRSWAP_KEYSTORE_PASSPHRASE' },
    { key: 'console_dir', label: 'Console directory', type: { t: 'text' }, defText: 'not served', help: 'The built console’s files, served by the daemon from the API’s own origin.' },
    { key: 'cors_origins', label: 'Other origins allowed to call the API', type: { t: 'list' }, def: [], help: 'Empty = same origin only.' },
  ],
};
export const SOLANA: SectionDef = {
  path: 'solana',
  title: 'Solana',
  fields: [
    { key: 'rpc_url_env', label: 'RPC URL variable', type: { t: 'env' }, def: 'SOLANA_RPC_URL' },
    { key: 'ws_url_env', label: 'WebSocket URL variable', type: { t: 'env' } },
    { key: 'maker_owner', label: 'Maker owner key (public)', type: { t: 'text' }, help: 'Your cold owner key. The maker account is derived from it.' },
    { key: 'subscriptions', label: 'Use WebSocket subscriptions', type: { t: 'bool' }, def: true },
    { key: 'fallback_rpc_url_envs', label: 'Fallback RPC variables', type: { t: 'list', env: true }, def: [] },
    { key: 'program_id', label: 'Program id', type: { t: 'text' }, defText: 'the pinned program' },
    { key: 'expected_genesis', label: 'Expected genesis hash', type: { t: 'text' } },
    { key: 'priority_fee_microlamports', label: 'Priority fee', type: int({ min: 0 }), def: 0, unit: 'micro-lamports per compute unit' },
  ],
};
export const ETHEREUM: SectionDef = {
  path: 'ethereum',
  title: 'Ethereum',
  fields: [
    { key: 'rpc_url_env', label: 'RPC URL variable', type: { t: 'env' }, def: 'ETHEREUM_RPC_URL' },
    { key: 'fallback_rpc_url_envs', label: 'Fallback RPC variables', type: { t: 'list', env: true }, def: [] },
    { key: 'contract', label: 'Contract address', type: { t: 'text' } },
    { key: 'maker_owner', label: 'Maker owner address', type: { t: 'text' }, help: 'Your registered (owner) address.' },
    { key: 'from_block', label: 'First block to read events from', type: int({ min: 0 }), def: 0, help: 'The deployment block.' },
    { key: 'chain_id', label: 'Chain id', type: int({ min: 1 }) },
    { key: 'finality', label: 'Act on blocks that are', type: sel({ value: 'finalized', label: 'Finalized' }, { value: 'safe', label: 'Safe' }), def: 'finalized' },
    { key: 'private_tx_url_env', label: 'Private transaction URL variable', type: { t: 'env' } },
    { key: 'max_fee_gwei', label: 'Highest fee', type: num({ min: 0 }), unit: 'gwei' },
  ],
};
export const MONERO: SectionDef = {
  path: 'monero',
  title: 'Monero',
  fields: [
    { key: 'network', label: 'Network', type: sel('mainnet', 'stagenet', 'testnet', 'regtest'), def: 'mainnet' },
    { key: 'node_url_envs', label: 'Node URL variables', type: { t: 'list', env: true }, help: 'Two or more nodes, or one that is your own.' },
    { key: 'own_node', label: 'The single node is my own', type: { t: 'bool' }, def: false },
    { key: 'wallet_rpc_url_env', label: 'Wallet RPC URL variable', type: { t: 'env' }, def: 'MONERO_WALLET_RPC_URL' },
    { key: 'sweep_max_fee', label: 'Sweep fee cap override', type: int({ min: 1 }), unit: 'piconero', defText: 'the protocol cap' },
    { key: 'wallet_rpc_user_env', label: 'Wallet RPC user variable', type: { t: 'env' } },
    { key: 'wallet_rpc_password_env', label: 'Wallet RPC password variable', type: { t: 'env' } },
  ],
};
export const ROTATION: SectionDef = {
  path: 'rotation',
  title: 'Key rotation',
  fields: [
    { key: 'interval_hours', label: 'Rotate every', type: num({ min: 0 }), def: 0, unit: 'hours', help: '0 = only on demand.' },
    { key: 'grace_hours', label: 'Keep a retired key for', type: num({ min: 0, exclusiveMin: true }), def: 24, unit: 'hours', help: 'A retired key is kept until this has passed and every swap opened under it has closed.' },
  ],
};
export const TOR: SectionDef = {
  path: 'tor',
  title: 'Tor service',
  fields: [
    { key: 'enabled', label: 'Enabled', type: { t: 'bool' }, def: false },
    { key: 'listen', label: 'Listen on', type: { t: 'text' }, def: '127.0.0.1:7072' },
    { key: 'hostname_file', label: 'Hidden-service hostname file', type: { t: 'text' } },
    { key: 'publish', label: 'Publish the onion address in the registry', type: { t: 'bool' }, def: true },
  ],
};
export const APPROVALS: SectionDef = {
  path: 'approvals',
  title: 'Approval rules',
  fields: [
    { key: 'allow', label: 'Always approve', type: { t: 'list' }, def: [] },
    { key: 'deny', label: 'Always reject', type: { t: 'list' }, def: [] },
    { key: 'auto_max_xmr', label: 'Approve automatically up to', type: num({ min: 0 }), unit: 'XMR', defText: 'no limit' },
    {
      key: 'advance',
      label: 'Advance approvals',
      type: {
        t: 'rows',
        columns: [
          { key: 'taker', label: 'Taker address', type: 'text' },
          { key: 'max_xmr', label: 'Limit per swap', type: 'number', min: 0, unit: 'XMR' },
          { key: 'days', label: 'Valid for', type: 'number', min: 0, unit: 'days' },
        ],
      },
      def: [],
    },
  ],
};
export const INBOX: SectionDef = {
  path: 'inbox',
  title: 'Inbox',
  fields: [
    {
      key: 'policy',
      label: 'Who may write',
      type: sel({ value: 'open', label: 'Anyone' }, { value: 'swap_only', label: 'Only takers who have a swap with me' }),
      def: 'open',
    },
  ],
};
export const ALERTS: SectionDef = {
  path: 'alerts',
  title: 'Alerts',
  fields: [
    { key: 'webhook_url_env', label: 'Webhook URL variable', type: { t: 'env' } },
    { key: 'fee_runway_days', label: 'Alert when the fee runway falls below', type: num({ min: 0 }), def: 7, unit: 'days' },
  ],
};

/** Contact channels as written in the file; the Registration page edits what is published. */
export const REGISTRATION: SectionDef = {
  path: 'registration',
  title: 'Published contact channels',
  fields: [
    {
      key: 'contacts',
      label: 'Contact channels',
      type: {
        t: 'rows',
        maxRows: 6,
        columns: [
          { key: 'kind', label: 'Kind', type: 'int', min: 0, max: 255 },
          { key: 'value', label: 'Value', type: 'text' },
        ],
      },
      def: [],
      help: 'Kinds: 0 website, 1 email, 2 Matrix, 3 Discord, 4 Telegram, 5 blob endpoint, 255 other. Each value at most 96 bytes.',
    },
  ],
};

export const OPERATION_SECTIONS: readonly SectionDef[] = [DAEMON, SOLANA, ETHEREUM, MONERO, ROTATION, TOR, APPROVALS, INBOX, ALERTS, REGISTRATION];

/** Every fixed table of the file. Markets, levels and venues are expanded from their id lists. */
export function allSections(): SectionDef[] {
  return [
    PRICING,
    ...SOURCE_SECTIONS,
    OFFERS,
    LIQUIDITY,
    GUARDRAILS,
    REBALANCE,
    ...ASSETS.map(levelSection),
    ROUTING,
    ALLOWLIST,
    CROSS_CHAIN,
    ...VENUES.map(venueSection),
    ...OPERATION_SECTIONS,
  ];
}
export const TOP_LEVEL_TABLES = ['pricing', 'markets', 'liquidity', 'guardrails', 'rebalance', 'daemon', 'solana', 'ethereum', 'monero', 'offers', 'rotation', 'tor', 'approvals', 'inbox', 'alerts', 'registration'] as const;

export const fieldOf = (section: SectionDef, key: string): FieldDef => {
  const f = section.fields.find((x) => x.key === key);
  if (!f) throw new Error(`no field ${section.path}.${key}`);
  return f;
};
