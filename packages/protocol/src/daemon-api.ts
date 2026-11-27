/**
 * The maker daemon's local API for the console (SPEC 7.8). Frozen by work package 1 so the
 * console can be built against a mock.
 *
 * Transport: express on `api_bind` (loopback), `Authorization: Bearer <token>` with the token
 * from the keystore directory, JSON bodies. Amounts and other 64-bit integers are decimal
 * strings in atomic units (never `number`); times are Unix seconds; binary values are lowercase
 * hex without `0x`, except EVM addresses and bytes32, which keep `0x`.
 *
 * `ROUTES` lists every route with its method; `ApiRoutes` types each request and response.
 */
import type { ChainName, CounterName, Market, SwapStateName } from './constants.js';

/** Decimal string of an integer in atomic units. */
export type Amount = string;
/** Unix seconds. */
export type Timestamp = number;
export type MarketDirection = 'sell_xmr' | 'buy_xmr';
export type DaemonMode = 'dry_run' | 'live';
export type AssetId = 'xmr' | 'sol' | 'eth' | 'usdc_sol' | 'usdc_eth';
export type VenueId = 'wxmr_bridge' | 'exchange' | 'changenow' | 'stealthex' | 'houdiniswap' | 'fixedfloat';

/** Error body of any non-2xx response. */
export interface ApiError {
  error: string;
  detail?: string;
}

// ------------------------------------------------------------------ status

export interface ChainConnection {
  chain: ChainName;
  connected: boolean;
  /** Endpoint label (never the URL with its key). */
  endpoint: string;
  /** Genesis hash (Solana) or chain id (Ethereum) the endpoint reported. */
  network: string;
  /** Whether it matches the configured one. */
  network_ok: boolean;
  chain_time: Timestamp | null;
  /** Local clock minus chain time. */
  clock_skew_secs: number | null;
  /** Ethereum: the block tag acted on. */
  finality?: 'finalized' | 'safe';
  /** The program or contract, and whether it can still be upgraded. */
  contract: string;
  upgradeable: boolean | null;
  upgrade_authority: string | null;
  last_error?: string;
}
export interface MoneroNodeStatus {
  /** Endpoint label. */
  label: string;
  ok: boolean;
  height: number | null;
  top_hash: string | null;
}
export interface StatusResponse {
  version: string;
  core_version: string;
  mode: DaemonMode;
  started_at: Timestamp;
  uptime_secs: number;
  /** The Solana maker PDA and the Ethereum maker address this database is bound to. */
  maker: { solana: string | null; ethereum: string | null };
  chains: ChainConnection[];
  monero: { nodes: MoneroNodeStatus[]; agree: boolean; wallet_rpc_ok: boolean; reorg_guard_active: boolean };
  tor: { enabled: boolean; onion: string | null; published: boolean; reachable: boolean | null };
  paused: { owner: boolean; operator: boolean; guardrails: string[] };
  /** Items parked for a human (SPEC 7.4). */
  needs_review: number;
  alerts: Alert[];
  /** Amendment 1 (SPEC 11.1): the on-chain beta caps and open value of every market. */
  caps: MarketCaps[];
  /** Amendment 1 (SPEC 11.5): the Solana program build this daemon expects and the one deployed. */
  program_build: ProgramBuildStatus;
  /** Amendment 1 (SPEC 11.6): the watcher the daemon hands its direction-B swaps to (`[watcher] url`). */
  watcher: WatcherStatus;
}
/** The caps of one market's escrowed asset as read from the chain (SPEC 11.1). */
export interface MarketCaps {
  market: Market;
  /** `null` when the chain could not be read. */
  caps: {
    /** The global switch. Off: nothing is checked. */
    on: boolean;
    /** Largest `amount` of one swap, base units. */
    max_swap: Amount;
    /** Largest open value at once, base units. */
    max_open: Amount;
    /** Sum of the counted values of the open swaps ("X of Y open"). */
    open_value: Amount;
    /** `max(0, max_open − open_value)`. */
    headroom: Amount;
    /** The configuration is frozen with the caps on: they stay as they are for good. */
    frozen: boolean;
  } | null;
}
export interface ProgramBuildStatus {
  program_id: string;
  /** `DEPLOYMENT.programHash`; `null` = no published build to compare with. */
  expected_hash: string | null;
  /** SHA-256 of the deployed ProgramData without its 45-byte header and trailing zeros; `null` if unreadable. */
  on_chain_hash: string | null;
  /** `null` when either hash is missing. */
  matches: boolean | null;
}
export interface WatcherStatus {
  /** `[watcher] url`, or `null` when none is configured. */
  url: string | null;
  /** The last `GET /watch/v1/info` succeeded. */
  reachable: boolean | null;
  /** The keys it asked to be named as watcher. */
  solana: string | null;
  ethereum: string | null;
  /** Swaps it has acknowledged and still watches. */
  watching: number;
  last_error?: string;
}
export interface Alert {
  id: string;
  at: Timestamp;
  level: 'info' | 'warning' | 'critical';
  kind: string;
  message: string;
  swap_ref?: string;
  acknowledged: boolean;
}

// ------------------------------------------------------------------ configuration

export interface ConfigIssue {
  /** Dotted path of the key, for example `markets.usdc_sol.sell_xmr.claim_delay_minutes`. */
  path: string;
  message: string;
}
export interface EffectiveOfferTerms {
  market: Market;
  direction: MarketDirection;
  enabled: boolean;
  approval_mode: 'auto' | 'window' | 'advance';
  approval_window_secs: number;
  notice_secs: number;
  /** The value `"auto"` resolved to. */
  claim_delay_secs: number;
  claim_window_secs: number;
  final_secs: number;
  deposit_bps: number;
  depth_tiers: { above_xmr: Amount; depth: number }[];
  /** Smallest claim delay the chain accepts for the deepest tier in use. */
  min_claim_delay_secs: number;
  /**
   * Amendment 1 (SPEC 11.6): the freeze window `W_z` (`freeze_window_hours` × 3,600). 0 = this
   * offer accepts no watcher; otherwise 3,600 to 259,200, and the counterparty of a frozen swap
   * waits up to this much longer.
   */
  freeze_window_secs: number;
}
export interface UpdateCostEstimate {
  interval_secs: number;
  lamports_per_update: Amount;
  /** `86,400 ÷ interval × (5,000 lamports + priority fee)`. */
  daily_lamports: Amount;
  daily_usd: number | null;
  /** Expected and maximum number of move-triggered updates per day. */
  triggered_per_day: { expected: number; max: number };
}
export interface ConfigValidation {
  ok: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  /** The values the daemon would run with, per enabled offer. */
  effective: EffectiveOfferTerms[];
  update_cost: UpdateCostEstimate | null;
}
export interface ConfigResponse {
  /** The TOML file as text. */
  toml: string;
  /** The file parsed, with defaults applied. Shape: SPEC 7.2. */
  parsed: Record<string, unknown>;
  validation: ConfigValidation;
  /** Hash of `toml`; send it back with a PUT to detect a concurrent edit. */
  revision: string;
}
export interface ConfigPutRequest {
  toml: string;
  /** The `revision` the edit was based on. */
  base_revision: string;
}
export interface ConfigValidateRequest {
  toml: string;
}
export interface ConfigLogEntry {
  at: Timestamp;
  revision: string;
  /** Keys that changed, as dotted paths with old and new values rendered as text. */
  changes: { path: string; old: string | null; new: string | null }[];
  source: 'file' | 'api' | 'import';
}
export interface ConfigExport {
  toml: string;
  exported_at: Timestamp;
}
export interface ConfigImportRequest {
  toml: string;
}

// ------------------------------------------------------------------ registration

export interface LinkStatus {
  /** What this chain's record points at on the other chain. */
  current: string | null;
  pending: string | null;
  pending_effective_at: Timestamp | null;
  /** Both pointers are in effect and point at each other. */
  mutual: boolean;
}
export interface SolanaRegistration {
  registered: boolean;
  maker: string | null;
  owner: string | null;
  operator: string | null;
  payout: string | null;
  /** Whether the payout's USDC token account exists. */
  payout_usdc_account: boolean | null;
  enc_key_version: number | null;
  onion: string | null;
  contacts: { kind: number; value: string }[];
  inbox_policy: 'open' | 'swap_only' | null;
  link: LinkStatus;
}
export interface EthereumRegistration {
  registered: boolean;
  maker: string | null;
  operator: string | null;
  payout: string | null;
  quote_epoch: number | null;
  approval_epoch: number | null;
  link: LinkStatus;
}
export interface RegistrationResponse {
  solana: SolanaRegistration;
  ethereum: EthereumRegistration;
  /** A blob endpoint (onion address or contact of kind 5) is listed: required for Ethereum markets. */
  blob_endpoint: boolean;
}
/** Owner-key actions the daemon builds as unsigned transactions for the console to sign. */
export type RegistrationAction =
  | { chain: 'solana'; action: 'register_maker'; owner: string; operator: string; payout: string }
  | { chain: 'solana'; action: 'set_operator'; operator: string }
  | { chain: 'solana'; action: 'set_payout'; payout: string }
  | { chain: 'solana'; action: 'set_eth_link'; eth_address: string }
  | { chain: 'solana'; action: 'set_paused'; paused: boolean }
  | { chain: 'ethereum'; action: 'register_maker'; owner: string; operator: string; payout: string; solana_owner: string }
  | { chain: 'ethereum'; action: 'set_operator'; operator: string }
  | { chain: 'ethereum'; action: 'set_payout'; payout: string }
  | { chain: 'ethereum'; action: 'set_solana_link'; solana_owner: string }
  | { chain: 'ethereum'; action: 'set_paused'; paused: boolean };
export type UnsignedTransaction =
  /** A serialised Solana message for the owner wallet to sign (base64), with the blockhash it uses. */
  | { chain: 'solana'; message_b64: string; recent_blockhash: string; fee_payer: string }
  /** An Ethereum transaction request for the owner wallet. */
  | { chain: 'ethereum'; chain_id: number; to: string; data: string; value: Amount };
export interface RegistrationTxResponse {
  /** Echoed back with the signed transaction. */
  request_id: string;
  unsigned: UnsignedTransaction;
  /** Plain-words description of what signing does. */
  summary: string;
}
export interface RegistrationSubmitRequest {
  request_id: string;
  /** Solana: the signed transaction, base64. Ethereum: the signed raw transaction, 0x-hex. */
  signed: string;
}
export interface TxResult {
  chain: ChainName;
  /** Signature (Solana) or hash (Ethereum). */
  id: string;
  status: 'sent' | 'confirmed' | 'failed';
  error?: string;
}

// ------------------------------------------------------------------ offers

export interface OfferView {
  market: Market;
  direction: MarketDirection;
  /** Live on-chain, or what dry-run would publish. */
  live: boolean;
  enabled: boolean;
  /** Why the offer is off, if it is. */
  disabled_reason?: string;
  reference_price: Amount | null;
  /** Asset base units per 1 XMR for each size tier; `above_xmr` in piconero. */
  price_tiers: { above_xmr: Amount; price: Amount }[];
  deviation_pct: number;
  min_xmr: Amount;
  max_xmr: Amount;
  /** Also capped by the on-chain headroom and by `max_swap` at the current price (SPEC 11.1). */
  capacity_xmr: Amount;
  /** What bounds `capacity_xmr` right now. */
  capacity_limit: 'inventory' | 'max_swap' | 'max_open' | 'config';
  terms: EffectiveOfferTerms;
  /** Solana direction-A offers: filled and unused slots of 16. Ethereum: unconsumed leaves of the current pool. */
  key_pool: { size: number; available: number } | null;
  /** Solana: `seq` and `updated_at`. Ethereum: `quoteId` and `validUntil`. */
  seq_or_quote_id: string | null;
  updated_at: Timestamp | null;
  valid_until: Timestamp | null;
}
export interface OffersResponse {
  offers: OfferView[];
  update_cost: UpdateCostEstimate | null;
  /** Fees spent on offer updates in the last 24 hours. */
  spent_24h_lamports: Amount;
  runway_days: number | null;
  /** Occasional costs listed separately. */
  occasional: { kind: 'key_refill' | 'key_rotation' | 'quote_on_request' | 'eth_registry'; count_24h: number; cost: Amount; asset: AssetId }[];
}
export interface OffersPreviewRequest {
  /** A configuration to preview without saving. */
  toml: string;
}

// ------------------------------------------------------------------ swaps

export interface SwapDeadlines {
  t_lock: Timestamp;
  t_pending_deadline: Timestamp | null;
  t_active: Timestamp | null;
  t_note_deadline: Timestamp | null;
  t_notice: Timestamp | null;
  t_cut: Timestamp | null;
  t_claim_open: Timestamp | null;
  /** Amendment 1 (SPEC 11.6): the freeze time and `T_ff = max(t_freeze + W_z, T_co)`. */
  t_freeze: Timestamp | null;
  t_ff: Timestamp | null;
  t_ready: Timestamp | null;
  t_claim_deadline: Timestamp | null;
  t_final: Timestamp;
  t_exp: Timestamp;
  t_refund: Timestamp | null;
  t_hold: Timestamp | null;
  t_split: Timestamp | null;
  t_settled: Timestamp | null;
}
export type SwapAction = 'approve' | 'reject' | 'abort' | 'withhold' | 'release' | 'publish-evidence';
/** Amendment 1 (SPEC 11.2, 11.6): the addresses a swap names besides its two parties. */
export interface SwapExtras {
  /** Direction B: where a claim pays, when it is not the taker's own address; else `null`. */
  payout: string | null;
  /** The key that may freeze the swap, or `null`. */
  watcher: string | null;
  /** `W_z` of the swap; 0 = it cannot be frozen. */
  freeze_window_secs: number;
  /** Direction B: the daemon's watcher acknowledged this swap and watches it until then. */
  watching_until: Timestamp | null;
}
export interface SwapSummary {
  chain: ChainName;
  /** Swap PDA (base58) or `swapId` (0x-hex). */
  ref: string;
  market: Market;
  direction: 'A' | 'B';
  state: SwapStateName;
  /** The daemon's own phase within the state, for example `xmr_relayed`. */
  phase: string;
  taker: string;
  xmr: Amount;
  amount: Amount;
  deposit: Amount;
  depth: number;
  opened_at: Timestamp;
  /** The next deadline that matters and what happens at it. */
  next_deadline: { at: Timestamp; label: string } | null;
  /** Counter name of the settling transition, once settled. */
  outcome: CounterName | null;
  needs_review: boolean;
  /** Manual actions available right now. */
  actions: SwapAction[];
  extras: SwapExtras;
}
export interface SwapDetail extends SwapSummary {
  mode: number;
  flags: number;
  deposit_state: number;
  deadlines: SwapDeadlines;
  joint_address: string | null;
  lock_txid: string | null;
  lock_confirmations: number | null;
  /** Agreement of the Monero nodes on the lock. */
  lock_state: 'not-found' | 'invalid' | 'pending' | 'confirming' | 'confirmed' | null;
  sweep_txid: string | null;
  evidence_published: boolean;
  intents: { id: string; kind: string; status: 'planned' | 'sent' | 'confirmed' | 'failed' | 'needs_review'; tx: string | null; at: Timestamp }[];
  messages: InboxItem[];
  last_error: string | null;
}
export interface SwapsQuery {
  state?: SwapStateName;
  chain?: ChainName;
  open?: boolean;
  limit?: number;
  before?: Timestamp;
}
export interface SwapsResponse {
  swaps: SwapSummary[];
  /** Pass as `before` for the next page; `null` at the end. */
  next_before: Timestamp | null;
}
export interface SwapRejectRequest {
  /** 0 = the maker's choice, 1 = unusable taker input, 2 = the named pool leaf was consumed. */
  reason: 0 | 1 | 2;
}
export interface SwapActionResponse {
  ok: boolean;
  tx: TxResult | null;
  detail?: string;
}

// ------------------------------------------------------------------ inventory

export interface LadderOutput {
  key_image: string;
  amount: Amount;
  unlocked: boolean;
  blocks_to_unlock: number;
  frozen: boolean;
  /** The swap this output is reserved for, if any. */
  reserved_for: string | null;
}
export interface InventoryResponse {
  xmr: { balance: Amount; unlocked: Amount; reserve: Amount; in_flight: Amount };
  ladder: { size_xmr: Amount; target_count: number; unlocked_count: number; locked_count: number }[];
  outputs: LadderOutput[];
  /** Capacity counted in unlocked outputs, never balance. */
  capacity_xmr: Amount;
  paying: { asset: Exclude<AssetId, 'xmr'>; balance: Amount; cap: Amount | null; escrowed: Amount }[];
}
export interface InventorySplitRequest {
  /** Omit to split to the configured ladder. */
  ladder?: { size_xmr: Amount; count: number }[];
}
export interface InventorySplitResponse {
  txids: string[];
  created: number;
}

// ------------------------------------------------------------------ approvals

export interface PendingApproval {
  chain: ChainName;
  ref: string;
  market: Market;
  direction: 'A' | 'B';
  taker: string;
  xmr: Amount;
  amount: Amount;
  /** The window closes at. */
  deadline: Timestamp;
  /** What the rules say, and why. */
  recommendation: 'approve' | 'reject';
  reasons: string[];
  /** Ethereum: whether the taker's DLEQ proof is present and valid. */
  dleq_ok: boolean | null;
  /** Amendment 1: the payout address (direction B) and the watcher the taker named (direction A), or `null`. */
  payout: string | null;
  watcher: string | null;
  /** The watcher is on `[approvals].deny_watchers`. */
  watcher_denied: boolean;
}
export interface AdvanceApprovalRecord {
  chain: ChainName;
  /** `approval_id`: decimal (Solana) or 0x-bytes32 (Ethereum). */
  id: string;
  taker: string;
  market: Market | null;
  direction: 'A' | 'B' | null;
  max_xmr: Amount;
  not_before: Timestamp;
  expires_at: Timestamp;
  epoch: number;
  /** Still usable: not expired, epoch current, not revoked. */
  active: boolean;
}
export interface ApprovalsResponse {
  pending: PendingApproval[];
  advance: AdvanceApprovalRecord[];
  epochs: { chain: ChainName; approval_epoch: number; quote_epoch: number }[];
}
export interface AdvanceApprovalRequest {
  chain: ChainName;
  taker: string;
  market?: Market;
  direction?: 'A' | 'B';
  max_xmr: Amount;
  /** Validity in days from now. */
  days: number;
}
export interface AdvanceApprovalResponse {
  record: AdvanceApprovalRecord;
  /** The signed object, to hand to the taker: base64 signature. */
  sig: string;
}
export type ApprovalRevokeRequest =
  /** Ethereum: revoke one approval. */
  | { chain: 'ethereum'; id: string }
  /** Either chain: bump the approval epoch, which kills every outstanding approval. */
  | { chain: ChainName; all: true };

// ------------------------------------------------------------------ deposits

export interface DepositView {
  chain: ChainName;
  ref: string;
  market: Market;
  taker: string;
  deposit: Amount;
  state: 'held' | 'withheld';
  refunded_at: Timestamp;
  /** Held: the hold ends and anyone may release. */
  hold_until: Timestamp;
  /** Withheld: anyone may split. */
  split_at: Timestamp;
  /** A lock notice is on record, so a withhold needs the evidence. */
  evidence_required: boolean;
  /** What the configured policy would do. */
  policy_decision: 'withhold' | 'release' | 'none';
  /** The taker asked for a release in the inbox. */
  release_requested: boolean;
}
export interface DepositsResponse {
  deposits: DepositView[];
}

// ------------------------------------------------------------------ inbox

export interface InboxItem {
  id: string;
  at: Timestamp;
  direction: 'in' | 'out';
  transport: 'solana' | 'tor' | 'ethereum';
  /** `t` of the message. */
  type: string;
  swap_ref: string | null;
  /** The non-maker party's address or key. */
  peer: string;
  /** For `inbox` and `inbox_reply`. */
  text: string | null;
  action: 'release_deposit' | null;
  read: boolean;
  in_reply_to: string | null;
}
export interface InboxResponse {
  items: InboxItem[];
  unread: number;
}
export interface InboxReplyRequest {
  text: string;
}

// ------------------------------------------------------------------ rebalancing

export interface RefillView {
  id: string;
  venue: VenueId | 'opposite_flow' | 'manual';
  from: AssetId;
  to: AssetId;
  amount_in: Amount;
  amount_out: Amount | null;
  /** Measured cost against the reference price, percent. */
  cost_pct: number | null;
  fees_usd: number | null;
  state: 'awaiting_approval' | 'pending' | 'depositing' | 'processing' | 'paying_out' | 'done' | 'held' | 'failed' | 'refunded' | 'cancelled';
  started_at: Timestamp;
  finished_at: Timestamp | null;
  venue_order_id: string | null;
  txids: string[];
  detail: string | null;
}
export interface RebalanceResponse {
  mode: 'auto' | 'approve' | 'alert';
  levels: { asset: AssetId; balance: Amount; low: Amount | null; target: Amount | null; high: Amount | null }[];
  venues: { id: VenueId; enabled: boolean; mode: 'auto' | 'approve' | 'alert'; healthy: boolean; reason: string | null; cooldown_until: Timestamp | null }[];
  in_transit_usd: number;
  max_in_transit_usd: number | null;
  refills: RefillView[];
}
export interface RebalanceRunRequest {
  from: AssetId;
  to: AssetId;
  amount_in?: Amount;
  amount_out?: Amount;
  venue?: VenueId;
}
export interface RebalanceManualRequest {
  /** A refill the maker did by hand, recorded so inventory and cost tracking stay right. */
  from: AssetId;
  to: AssetId;
  amount_in: Amount;
  amount_out: Amount;
  note?: string;
}

// ------------------------------------------------------------------ keys

export interface EncKeyView {
  version: number;
  /** X25519 public key, lowercase hex. */
  public_key: string;
  current: boolean;
  expires_at: Timestamp | null;
  /** Open swaps that still need this version's private key. */
  open_swaps: number;
  deleted_at: Timestamp | null;
}
export interface KeysResponse {
  keys: EncKeyView[];
  /** 0 = manual. */
  rotation_interval_hours: number;
  grace_hours: number;
  next_rotation_at: Timestamp | null;
}
export interface KeysRotateResponse {
  version: number;
  tx: TxResult;
}

// ------------------------------------------------------------------ stats and fees

export interface StatsResponse {
  since: Timestamp;
  fills: number;
  volume: { market: Market; xmr: Amount; asset: Amount }[];
  spread_earned_usd: number | null;
  /** On-chain counters per chain, by counter name. */
  counters: { chain: ChainName; values: Partial<Record<CounterName, number>> }[];
  rates: {
    approval: number | null;
    mean_response_secs: number | null;
    abort: number | null;
    withhold: number | null;
    unreleased: number | null;
  };
  missed_deadlines: number;
  uptime_pct: number | null;
}
export interface FeesResponse {
  estimate: UpdateCostEstimate | null;
  spent_24h: { asset: AssetId; amount: Amount; usd: number | null }[];
  operator_balances: { chain: ChainName; asset: AssetId; balance: Amount }[];
  runway_days: number | null;
  /** Alert threshold from `[alerts].fee_runway_days`. */
  runway_alert_days: number;
}

// ------------------------------------------------------------------ pause

export interface PauseRequest {
  /** Also bump the epochs, which kills outstanding approvals and quotes. */
  bump_epochs?: boolean;
  reason?: string;
}
export interface PauseResponse {
  paused: boolean;
  txs: TxResult[];
}

// ------------------------------------------------------------------ routes

export const ROUTES = {
  status: { method: 'GET', path: '/api/status' },
  configGet: { method: 'GET', path: '/api/config' },
  configPut: { method: 'PUT', path: '/api/config' },
  configValidate: { method: 'POST', path: '/api/config/validate' },
  configLog: { method: 'GET', path: '/api/config/log' },
  configExport: { method: 'GET', path: '/api/config/export' },
  configImport: { method: 'POST', path: '/api/config/import' },
  registration: { method: 'GET', path: '/api/registration' },
  registrationTx: { method: 'POST', path: '/api/registration/tx' },
  registrationSubmit: { method: 'POST', path: '/api/registration/submit' },
  offers: { method: 'GET', path: '/api/offers' },
  offersPreview: { method: 'POST', path: '/api/offers/preview' },
  swaps: { method: 'GET', path: '/api/swaps' },
  swap: { method: 'GET', path: '/api/swaps/:ref' },
  swapApprove: { method: 'POST', path: '/api/swaps/:ref/approve' },
  swapReject: { method: 'POST', path: '/api/swaps/:ref/reject' },
  swapAbort: { method: 'POST', path: '/api/swaps/:ref/abort' },
  swapWithhold: { method: 'POST', path: '/api/swaps/:ref/withhold' },
  swapRelease: { method: 'POST', path: '/api/swaps/:ref/release' },
  swapPublishEvidence: { method: 'POST', path: '/api/swaps/:ref/publish-evidence' },
  inventory: { method: 'GET', path: '/api/inventory' },
  inventorySplit: { method: 'POST', path: '/api/inventory/split' },
  approvals: { method: 'GET', path: '/api/approvals' },
  approvalsAdvance: { method: 'POST', path: '/api/approvals/advance' },
  approvalsRevoke: { method: 'POST', path: '/api/approvals/revoke' },
  deposits: { method: 'GET', path: '/api/deposits' },
  inbox: { method: 'GET', path: '/api/inbox' },
  inboxReply: { method: 'POST', path: '/api/inbox/:id/reply' },
  inboxRead: { method: 'POST', path: '/api/inbox/:id/read' },
  rebalance: { method: 'GET', path: '/api/rebalance' },
  rebalanceRun: { method: 'POST', path: '/api/rebalance/run' },
  rebalanceApprove: { method: 'POST', path: '/api/rebalance/approve/:id' },
  rebalanceCancel: { method: 'POST', path: '/api/rebalance/cancel/:id' },
  rebalanceManual: { method: 'POST', path: '/api/rebalance/manual' },
  keys: { method: 'GET', path: '/api/keys' },
  keysRotate: { method: 'POST', path: '/api/keys/rotate' },
  stats: { method: 'GET', path: '/api/stats' },
  fees: { method: 'GET', path: '/api/fees' },
  pause: { method: 'POST', path: '/api/pause' },
  resume: { method: 'POST', path: '/api/resume' },
  ws: { method: 'WS', path: '/api/ws' },
} as const;
export type RouteName = keyof typeof ROUTES;

/** Request body (or query for GET) and response body of every HTTP route. */
export interface ApiRoutes {
  status: { request: void; response: StatusResponse };
  configGet: { request: void; response: ConfigResponse };
  configPut: { request: ConfigPutRequest; response: ConfigResponse };
  configValidate: { request: ConfigValidateRequest; response: ConfigValidation };
  configLog: { request: void; response: { entries: ConfigLogEntry[] } };
  configExport: { request: void; response: ConfigExport };
  configImport: { request: ConfigImportRequest; response: ConfigResponse };
  registration: { request: void; response: RegistrationResponse };
  registrationTx: { request: RegistrationAction; response: RegistrationTxResponse };
  registrationSubmit: { request: RegistrationSubmitRequest; response: TxResult };
  offers: { request: void; response: OffersResponse };
  offersPreview: { request: OffersPreviewRequest; response: OffersResponse };
  swaps: { request: SwapsQuery; response: SwapsResponse };
  swap: { request: void; response: SwapDetail };
  swapApprove: { request: void; response: SwapActionResponse };
  swapReject: { request: SwapRejectRequest; response: SwapActionResponse };
  swapAbort: { request: void; response: SwapActionResponse };
  swapWithhold: { request: void; response: SwapActionResponse };
  swapRelease: { request: void; response: SwapActionResponse };
  swapPublishEvidence: { request: void; response: SwapActionResponse };
  inventory: { request: void; response: InventoryResponse };
  inventorySplit: { request: InventorySplitRequest; response: InventorySplitResponse };
  approvals: { request: void; response: ApprovalsResponse };
  approvalsAdvance: { request: AdvanceApprovalRequest; response: AdvanceApprovalResponse };
  approvalsRevoke: { request: ApprovalRevokeRequest; response: { txs: TxResult[] } };
  deposits: { request: void; response: DepositsResponse };
  inbox: { request: void; response: InboxResponse };
  inboxReply: { request: InboxReplyRequest; response: InboxItem };
  inboxRead: { request: void; response: InboxItem };
  rebalance: { request: void; response: RebalanceResponse };
  rebalanceRun: { request: RebalanceRunRequest; response: RefillView };
  rebalanceApprove: { request: void; response: RefillView };
  rebalanceCancel: { request: void; response: RefillView };
  rebalanceManual: { request: RebalanceManualRequest; response: RefillView };
  keys: { request: void; response: KeysResponse };
  keysRotate: { request: void; response: KeysRotateResponse };
  stats: { request: void; response: StatsResponse };
  fees: { request: void; response: FeesResponse };
  pause: { request: PauseRequest; response: PauseResponse };
  resume: { request: void; response: PauseResponse };
}

// ------------------------------------------------------------------ WebSocket (`WS /api/ws`)

export const WS_CHANNELS = ['status', 'swaps', 'offers', 'inbox', 'rebalance', 'alerts'] as const;
export type WsChannel = (typeof WS_CHANNELS)[number];
/** Seconds between pings. */
export const WS_PING_SECS = 30;

/** What each channel carries: a snapshot on subscribe, then pushes of the same shape. */
export interface WsPayloads {
  status: StatusResponse;
  swaps: SwapSummary[];
  offers: OfferView[];
  inbox: InboxItem[];
  rebalance: RefillView[];
  alerts: Alert[];
}
export type WsClientMessage =
  | { op: 'subscribe'; channels: WsChannel[] }
  | { op: 'unsubscribe'; channels: WsChannel[] }
  | { op: 'pong' };
export type WsServerMessage =
  | { [C in WsChannel]: { op: 'snapshot'; channel: C; data: WsPayloads[C] } }[WsChannel]
  /** A push carries the items that changed (for `status`, the whole status). */
  | { [C in WsChannel]: { op: 'update'; channel: C; data: WsPayloads[C] } }[WsChannel]
  | { op: 'ping' }
  | { op: 'error'; error: string };

/** Fill the `:param` segments of a route path. */
export function routePath(name: RouteName, params: Record<string, string> = {}): string {
  return ROUTES[name].path.replace(/:([a-z_]+)/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`route ${name} needs :${key}`);
    return encodeURIComponent(v);
  });
}
