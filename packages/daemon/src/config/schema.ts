/**
 * The configuration file's schema (SPEC 7.2). Every key has a default; unknown keys are errors
 * (a misspelt cap must not mean "no cap"). Chain-dependent defaults are resolved in `load.ts`.
 * Secrets are never in the file: keys ending in `_env` name an environment variable.
 */
import { z } from 'zod';

export const MARKET_NAMES = ['usdc_sol', 'sol', 'usdc_eth', 'eth'] as const;
export const DIRECTIONS = ['sell_xmr', 'buy_xmr'] as const;
/** `wxmr_pool` is USDC-quoted unless its `quote` says otherwise; `wxmr_pool_sol` is a second pool, SOL-quoted by default (XMR/SOL directly). */
export const SOURCE_NAMES = ['coingecko', 'coinmarketcap', 'wxmr_pool', 'wxmr_pool_sol'] as const;

const pct = z.number().finite();
const posNum = z.number().finite().nonnegative();
const xmrAmount = z.number().finite().nonnegative();
const sourceName = z.enum(SOURCE_NAMES);

const keyedSource = z.strictObject({
  api_key_env: z.string().min(1).optional(),
  min_interval_seconds: z.number().positive().optional(),
  base_url: z.string().optional(),
});
const poolSource = z.strictObject({
  token: z.string().optional(),
  pool: z.string().optional(),
  /** The pool's two reserve token accounts (wXMR side, quote side) and the quote asset. */
  base_vault: z.string().optional(),
  quote_vault: z.string().optional(),
  quote: z.enum(['usdc', 'sol']).default('usdc'),
  min_liquidity_usd: posNum.default(0),
  average_seconds: posNum.default(300),
});

const poolSourceSol = poolSource.extend({ quote: z.enum(['usdc', 'sol']).default('sol') });
const crossCheck = z.union([sourceName, z.literal('none')]);

const pricing = z.strictObject({
  refresh_seconds: z.number().positive().default(15),
  max_age_seconds: z.number().positive().default(60),
  /** A source every market's reference is checked against, or `"none"` (the same as leaving it out). A market may name its own. */
  cross_check: crossCheck.optional(),
  max_disagreement_pct: pct.nonnegative().default(1.0),
  on_failure: z.enum(['pause', 'widen']).default('pause'),
  widen_pct: pct.nonnegative().default(0.5),
  sources: z
    .strictObject({
      coingecko: keyedSource.default(() => keyedSource.parse({})),
      coinmarketcap: keyedSource.default(() => keyedSource.parse({})),
      wxmr_pool: poolSource.optional(),
      wxmr_pool_sol: poolSourceSol.optional(),
    })
    .default(() => ({ coingecko: keyedSource.parse({}), coinmarketcap: keyedSource.parse({}) })),
});

const offer = z.strictObject({
  enabled: z.boolean().default(false),
  source: sourceName.default('coingecko'),
  fallbacks: z.array(sourceName).default([]),
  /** This market's own cross-check: a source, or `"none"`. Absent = the global `[pricing].cross_check`. */
  cross_check: crossCheck.optional(),
  deviation_pct: pct.default(2.0),
  size_tiers: z.array(z.strictObject({ above_xmr: xmrAmount, extra_pct: pct })).max(2).default([]),
  inventory_skew_max_pct: pct.nonnegative().default(0),
  min_xmr: xmrAmount.default(0.1),
  max_xmr: xmrAmount.optional(),
  offer_valid_seconds: z.number().int().positive().optional(),
  confirmation_depth: z
    .array(z.strictObject({ above_xmr: xmrAmount, depth: z.number().int().min(1).max(255) }))
    .min(1)
    .max(3)
    .default([
      { above_xmr: 0, depth: 2 },
      { above_xmr: 1, depth: 10 },
      { above_xmr: 50, depth: 25 },
    ]),
  notice_seconds: z.number().int().positive().optional(),
  final_days: z.number().positive().default(7),
  deposit_pct: pct.min(0).max(5).default(0),
  daily_cap_xmr: xmrAmount.optional(),
  approval_mode: z.enum(['auto', 'window', 'advance']).default('auto'),
  approval_window_seconds: z.number().int().positive().optional(),
  claim_delay_minutes: z.union([z.literal('auto'), z.number().positive()]).default('auto'),
  claim_window_minutes: z.number().positive().optional(),
  /** Absent: `never`, or `price_moved` for an offer with a freeze window (SPEC 11.6, mitigation 3). */
  withhold_policy: z.enum(['never', 'always', 'price_moved']).optional(),
  withhold_move_pct: pct.nonnegative().default(1.0),
  volatility_widen: z.strictObject({ per_pct_move: pct.nonnegative(), max_pct: pct.nonnegative() }).optional(),
  /** Direction A without the taker's ready: claim at T_co when the own lock is confirmed (default), or always abort. */
  without_ready: z.enum(['claim', 'abort']).optional(),
  /**
   * The freeze window `W_z` in hours (SPEC 11.6). 0 = no watcher is accepted on this offer (the default); otherwise 1 to 72.
   * Sell-XMR: the taker, or a watcher it names, may pause the swap once. Buy-XMR: the maker's own watcher may.
   */
  freeze_window_hours: z.number().finite().nonnegative().default(0),
});
const marketPair = z.strictObject({ sell_xmr: offer.default(() => offer.parse({})), buy_xmr: offer.default(() => offer.parse({})) });
const markets = z.strictObject({
  usdc_sol: marketPair.default(() => marketPair.parse({})),
  sol: marketPair.default(() => marketPair.parse({})),
  usdc_eth: marketPair.default(() => marketPair.parse({})),
  eth: marketPair.default(() => marketPair.parse({})),
});

const assetCaps = z.strictObject({ sol: posNum.optional(), eth: posNum.optional(), usdc_sol: posNum.optional(), usdc_eth: posNum.optional() });
const liquidity = z.strictObject({
  xmr_reserve: xmrAmount.default(0),
  output_ladder: z.array(z.strictObject({ size_xmr: z.number().positive(), count: z.number().int().positive() })).default([]),
  max_in_flight_xmr: xmrAmount.optional(),
  max_per_taker_xmr: xmrAmount.optional(),
  allocation: z.union([z.literal('shared'), z.strictObject({ usdc_sol: xmrAmount.optional(), sol: xmrAmount.optional(), usdc_eth: xmrAmount.optional(), eth: xmrAmount.optional() })]).default('shared'),
  paying_caps: assetCaps.default({}),
  targets: z.strictObject({ xmr: posNum.optional(), sol: posNum.optional(), eth: posNum.optional(), usdc_sol: posNum.optional(), usdc_eth: posNum.optional() }).default({}),
  /** How much larger than its offer size a ladder output is cut, so one output covers amount plus fee. */
  ladder_headroom_pct: pct.nonnegative().default(1.0),
});

const guardrails = z.strictObject({
  volatility_pause: z.union([z.literal(false), z.strictObject({ move_pct: pct.positive(), window_seconds: z.number().positive() })]).optional(),
  disagreement_pause: z.boolean().default(true),
  stale_pause: z.boolean().default(true),
  price_band_usd: z.union([z.literal(false), z.strictObject({ min: posNum, max: posNum })]).optional(),
  dry_run: z.boolean().default(false),
  reorg_guard: z.strictObject({ enabled: z.boolean().default(false), raise_depth_to: z.number().int().min(1).max(255).default(25) }).default({ enabled: false, raise_depth_to: 25 }),
});

const daemon = z.strictObject({
  data_dir: z.string().default('./data'),
  api_bind: z.string().default('127.0.0.1:7071'),
  mode: z.enum(['dry_run', 'live']).default('dry_run'),
  keystore_passphrase_env: z.string().default('XMRSWAP_KEYSTORE_PASSPHRASE'),
  /** The built console's static files, served from the API's own origin (same-origin is the default way to run the console). */
  console_dir: z.string().optional(),
  /** Other origins allowed to call the API from a browser (CORS). Empty = same-origin only. */
  cors_origins: z.array(z.string()).default([]),
});
const solana = z.strictObject({
  rpc_url_env: z.string().default('SOLANA_RPC_URL'),
  ws_url_env: z.string().optional(),
  fallback_rpc_url_envs: z.array(z.string()).default([]),
  program_id: z.string().optional(),
  expected_genesis: z.string().optional(),
  priority_fee_microlamports: z.number().int().nonnegative().default(0),
  /** The most the operator ever pays per compute unit (micro-lamports). Default: the SDK's bound, 5,000,000 (5 lamports per unit). Raise it to use a higher priority fee. */
  max_priority_fee_microlamports: z.number().int().positive().optional(),
  /** The maker's cold owner key (public). The maker PDA is derived from it. */
  maker_owner: z.string().optional(),
  subscriptions: z.boolean().default(true),
});
const ethereum = z.strictObject({
  rpc_url_env: z.string().default('ETHEREUM_RPC_URL'),
  fallback_rpc_url_envs: z.array(z.string()).default([]),
  contract: z.string().optional(),
  chain_id: z.number().int().positive().optional(),
  finality: z.enum(['finalized', 'safe']).default('finalized'),
  private_tx_url_env: z.string().optional(),
  max_fee_gwei: z.number().positive().optional(),
  /** The maker's registered (owner) address. */
  maker_owner: z.string().optional(),
  /** First block to read events from (the deployment block). */
  from_block: z.number().int().nonnegative().default(0),
});
const monero = z.strictObject({
  network: z.enum(['mainnet', 'stagenet', 'testnet', 'regtest']).default('mainnet'),
  node_url_envs: z.array(z.string()).default([]),
  own_node: z.boolean().default(false),
  wallet_rpc_url_env: z.string().default('MONERO_WALLET_RPC_URL'),
  wallet_rpc_user_env: z.string().optional(),
  wallet_rpc_password_env: z.string().optional(),
  /** Override of the sweep fee cap in piconero (regtest fees are far above mainnet's). */
  sweep_max_fee: z.number().int().positive().optional(),
});
const offers = z.strictObject({
  update_interval_seconds: z.number().positive().default(15),
  price_move_trigger_pct: pct.positive().optional(),
  min_refresh_interval_seconds: z.number().positive().optional(),
  key_pool_low_water: z.number().int().min(0).max(16).default(4),
  eth_pool_size: z.number().int().min(2).max(256).default(64),
});
const rotation = z.strictObject({ interval_hours: z.number().nonnegative().default(0), grace_hours: z.number().positive().default(24) });
const tor = z.strictObject({
  enabled: z.boolean().default(false),
  listen: z.string().default('127.0.0.1:7072'),
  hostname_file: z.string().optional(),
  publish: z.boolean().default(true),
});
const approvals = z.strictObject({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  auto_max_xmr: xmrAmount.optional(),
  advance: z.array(z.strictObject({ taker: z.string(), max_xmr: xmrAmount, days: z.number().positive() })).default([]),
  /** Watcher keys whose locks are refused (SPEC 11.6): in window mode and on Ethereum, before the fact. */
  deny_watchers: z.array(z.string()).default([]),
  /** Refuse every lock that names a watcher, whatever the key. */
  refuse_watchers: z.boolean().default(false),
  /** Refuse a taker whose swaps with this maker were frozen this many times or more. Absent = no limit. */
  max_taker_freezes: z.number().int().positive().optional(),
});
/**
 * The maker's own watcher for buy-XMR swaps (SPEC 11.6, "Sell direction"): a second machine that pauses a swap when the
 * taker's XMR lock does not check out while this daemon is down. Off unless `url` is set.
 */
const watcher = z.strictObject({
  url: z.string().optional(),
  /** The watcher's Solana key (base58): named at `fund` on Solana; notice keys are sealed to it and its acknowledgements are checked against it. */
  solana_key: z.string().optional(),
  /** The watcher's Ethereum address: named at `fund` on Ethereum. */
  ethereum_key: z.string().optional(),
  /** Seconds between attempts to hand a swap to a watcher that did not answer. */
  retry_seconds: z.number().positive().default(30),
});
const inbox = z.strictObject({ policy: z.enum(['open', 'swap_only']).default('open') });
const alerts = z.strictObject({ webhook_url_env: z.string().optional(), fee_runway_days: z.number().positive().default(7) });
const registration = z.strictObject({
  contacts: z.array(z.strictObject({ kind: z.number().int().min(0).max(255), value: z.string().max(96) })).max(6).default([]),
});

export const configSchema = z.strictObject({
  pricing: pricing.default(() => pricing.parse({})),
  markets: markets.default(() => markets.parse({})),
  liquidity: liquidity.default(() => liquidity.parse({})),
  guardrails: guardrails.default(() => guardrails.parse({})),
  /** Validated by `@xmrswap/rebalancer`'s own schema. */
  rebalance: z.unknown().optional(),
  daemon: daemon.default(() => daemon.parse({})),
  solana: solana.default(() => solana.parse({})),
  ethereum: ethereum.default(() => ethereum.parse({})),
  monero: monero.default(() => monero.parse({})),
  offers: offers.default(() => offers.parse({})),
  rotation: rotation.default(() => rotation.parse({})),
  tor: tor.default(() => tor.parse({})),
  approvals: approvals.default(() => approvals.parse({})),
  inbox: inbox.default(() => inbox.parse({})),
  alerts: alerts.default(() => alerts.parse({})),
  registration: registration.default(() => registration.parse({})),
  watcher: watcher.default(() => watcher.parse({})),
});

export type RawConfig = z.infer<typeof configSchema>;
export type OfferSettings = z.infer<typeof offer>;
export type MarketName = (typeof MARKET_NAMES)[number];
export type DirectionName = (typeof DIRECTIONS)[number];
export type SourceName = (typeof SOURCE_NAMES)[number];
