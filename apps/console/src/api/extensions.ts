/**
 * What the real daemon's API adds to the frozen `@xmrswap/protocol` types
 * (`packages/daemon/DEVIATIONS.md`, "Console contract" A1 to A10). Every addition is optional
 * here, so the console also works against a daemon that predates it.
 */
import type { ChainName } from '@xmrswap/protocol';
import type { Alert, ApprovalsResponse, PendingApproval, ChainConnection, ConfigIssue, ConfigValidation, FeesResponse, OfferView, OffersResponse, RebalanceResponse, RefillView, RegistrationResponse, StatusResponse, SwapAction, SwapActionResponse, SwapDetail, SwapSummary, SwapsResponse, TxResult } from '@xmrswap/protocol/daemon-api';

/** A10: what became of an operator instruction. */
export type ActionOutcome = 'carried_out' | 'refused' | 'pending';
/** The daemon's documented list (its A16, with the three freeze reasons A26 adds). */
export const REFUSAL_REASONS = [
  'freeze-not-available',
  'freeze-window-closed',
  'already-frozen',
  'ready-already-set',
  'refund-window-closed',
  'abort-window-closed',
  'already-settled',
  'cannot-exit-after-funding',
  'reject-not-available',
  'hold-ended',
  'no-deposit-held',
  'not-available-in-state',
  'dry-run',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface SwapActionResult extends SwapActionResponse {
  outcome?: ActionOutcome;
  /** Present when `outcome` is `refused`. A reason this console does not know is still shown, with the daemon's `detail`. */
  refused?: RefusalReason | (string & {});
}
export interface SwapInstruction {
  action: SwapAction;
  at: number;
  status: ActionOutcome;
  reason: string | null;
  tx: string | null;
}
/** A13: every summary carries the approval mode and the operator's latest instruction. */
export interface SummaryExtras {
  mode?: number;
  /** The operator's latest instruction and what became of it. */
  instruction?: SwapInstruction | null;
}
export type SwapSummaryX = SwapSummary & SummaryExtras & { frozen?: FrozenInfo | null };
export type SwapDetailX = SwapDetail & SummaryExtras & FreezeExtras;
export interface SwapsX extends SwapsResponse {
  swaps: SwapSummaryX[];
}

/** A11: whether the program or contract can still be changed, read from chain state. */
export type UpgradeStatus = 'upgradable' | 'immutable' | 'unknown';
export interface ChainConnectionX extends ChainConnection {
  upgrade_status?: UpgradeStatus;
  /** Why the status is unknown. */
  upgrade_reason?: string | null;
  /** Ethereum: a two-step ownership transfer that is waiting. */
  upgrade_pending_authority?: string | null;
  /** Ethereum: the implementation behind the proxy. Solana: the ProgramData account. */
  upgrade_implementation?: string | null;
  upgrade_checked_at?: number | null;
}
/** A13: which refills still need the maker. */
export interface RefillViewX extends RefillView {
  /** Held, or failed with funds possibly still at the venue. */
  needs_acknowledgement?: boolean;
  /** Failed and closed by the maker. */
  acknowledged?: boolean;
}
export interface RebalanceX extends RebalanceResponse {
  refills: RefillViewX[];
}

/** A6: the owner's pause is per chain. */
export interface ChainPause {
  chain: ChainName;
  owner: boolean;
  operator: boolean;
}
export interface StatusX extends StatusResponse {
  chains: ChainConnectionX[];
  paused: StatusResponse['paused'] & { chains?: ChainPause[] };
  /** A18: offers a cap stops right now, and how many swaps were ever paused. */
  cap_reached?: { market: string; direction: string; code: CapCode; reason: string }[];
  freezes?: number;
  watcher: StatusResponse['watcher'] & { reported?: { solana: string | null; ethereum: string | null } | null };
  /** A12: `registry_onion` is what the registry shows; `reachable` stays `null` (the daemon runs no Tor client). */
  tor: StatusResponse['tor'] & { registry_onion?: string | null };
}
/** A6: the daemon's own SOL price and the compute units it charges an offer update at. */
export interface CostExtras {
  sol_usd?: number | null;
  compute_units_per_update?: number;
}
export type FeesX = FeesResponse & CostExtras & { swap_cost?: SwapCost; daily_swap_lamports?: string | number; eth_runway_swaps?: number | null };
/** A17: the file's choice of sources, and what is pricing the offer right now. */
export interface OfferSourceExtras {
  source?: string;
  fallbacks?: string[];
  /** `null` = none. */
  cross_check?: string | null;
  /** The source pricing it right now: the primary, or a fallback while the primary is unavailable; `null` while there is no price. */
  priced_by?: string | null;
  /** `"asset"` when a SOL-quoted pool prices the SOL market with no USD figure. */
  price_unit?: 'usd' | 'asset';
}
export type OfferViewX = OfferView & OfferSourceExtras & { cap_reached?: CapCode | null; freeze_window_secs?: number };
export type OffersX = Omit<OffersResponse, 'offers'> & CostExtras & { offers: OfferViewX[]; caps?: StatusResponse['caps']; swap_cost?: SwapCost };
export type PendingApprovalX = PendingApproval & { taker_freezes?: number; freeze_window_secs?: number };

/** A5: `PUT /api/registration/published`. */
export interface PublishedRequest {
  contacts?: { kind: number; value: string }[];
  /** A v3 onion host, or `null` to follow the Tor hostname file again. */
  onion?: string | null;
}
export interface PublishedResponse {
  tx: TxResult | null;
  registration: RegistrationResponse;
}
/**
 * A5 and A13: `GET /api/registration/links`, one entry per recorded `LinkChanged`, newest first.
 * `old` / `new` are display addresses (an Ethereum address for the Solana record, a base58 Solana
 * key for the Ethereum record, empty = no link); the raw bytes are beside them.
 */
export interface LinkEntry {
  chain: ChainName;
  old: string;
  new: string;
  old_hex?: string;
  new_hex?: string;
  effective_at: number;
  /** Replaced by a later change before it took effect. */
  superseded?: boolean;
}
export type RefillChoice = 'continue' | 'refund';

/**
 * `GET /release.json` of the bundle that serves the console (deploy/DEVIATIONS.md E11): the
 * server describing which build its files are. `release` is `null` when no record has the served
 * tree's hash.
 */
export interface ReleaseRecord {
  format: string;
  ui: { tree_hash: string; files: number; bytes: number };
  recorded: boolean;
  release: {
    version: string;
    status: 'development-snapshot' | 'release';
    commit: string;
    commit_time?: string;
    program_id: string;
    contract?: string | null;
    chain_id?: number | null;
    program_executable_hash?: string | null;
    program_hash_source?: 'docker' | 'local';
    onchain_deployed?: boolean;
  } | null;
}
/**
 * Who paused a swap, as the daemon INFERS it: the chain stores the time of a freeze, not the
 * caller. `taker_side` = the taker, its session key or the watcher it named.
 */
export type FrozenBy = 'taker_side' | 'maker' | 'maker_watcher';
/** A20: on every swap summary; `null` unless the swap was frozen. */
export interface FrozenInfo {
  t_freeze: number;
  t_ff: number;
  frozen_by: FrozenBy | null;
}
/** A21: additions on the swap detail. */
export interface FreezeExtras {
  frozen?: FrozenInfo | null;
  freeze?: { swap_ref: string; chain: ChainName; direction: 'A' | 'B'; taker: string; watcher: string | null; frozen_by: FrozenBy | null; t_freeze: number; t_ff: number; at: number } | null;
  /** The maker watcher's signed promise to follow this swap: `sig` is base64 Ed25519 by its Solana key. */
  watcher_ack?: { watcher: string; watching_until: number; sig: string; at: number } | null;
}
export type CapCode = 'SwapCapExceeded' | 'OpenCapExceeded';
/** A25: the operator's transactions of one ordinary swap, at the configured priority fee and gas cap. */
export interface SwapCost {
  solana: Record<'sol' | 'usdc_sol', Record<'sell_xmr' | 'sell_xmr_window' | 'buy_xmr', { compute_units: number; lamports: string | number }>>;
  ethereum: { sell_xmr_gas: number; buy_xmr_gas: number; freeze_gas: number; push_owed_gas: number; max_fee_gwei: number | null; sell_xmr_wei: string | null; buy_xmr_wei: string | null };
  taker_open_compute_units: { lock_or_take: number; usdc_with_approval: number };
}
/** A23: `GET /api/freezes`. */
export interface FreezesResponse {
  freezes: { ref: string; chain: ChainName; direction: 'A' | 'B'; taker: string; watcher: string | null; frozen_by: FrozenBy | null; t_freeze: number; t_ff: number; state: string }[];
  /** Direction A only, most first. */
  by_taker: { taker: string; count: number }[];
  counters: { chain: ChainName; freezes: number; refunds_after_freeze: number; backouts_after_freeze: number; claims_after_freeze: number }[];
  settings: { refuse_watchers: boolean; deny_watchers: string[]; max_taker_freezes: number | null };
}
/** A24: `GET /api/watcher`. */
export interface WatcherResponse {
  status: StatusX['watcher'];
  acks: { ref: string; chain: ChainName; watcher: string; watching_until: number; sig: string; at: number; open: boolean }[];
}
/** A24: `GET /api/caps`. */
export interface CapsResponse {
  caps: StatusResponse['caps'];
  offers: { market: string; direction: string; enabled: boolean; capacity_xmr: string; capacity_limit: string; cap_reached: CapCode | null; reason: string | null }[];
  refused_quotes: number;
}

/** A3: a refused configuration carries every issue. */
export interface ErrorExtras {
  issues?: ConfigIssue[];
  warnings?: ConfigIssue[];
}

/** Routes whose responses carry additions. */
export interface ExtendedResponses {
  status: StatusX;
  fees: FeesX;
  offers: OffersX;
  offersPreview: OffersX;
  swap: SwapDetailX;
  swaps: SwapsX;
  approvals: Omit<ApprovalsResponse, 'pending'> & { pending: PendingApprovalX[] };
  rebalance: RebalanceX;
  rebalanceRun: RefillViewX;
  rebalanceApprove: RefillViewX;
  rebalanceCancel: RefillViewX;
  rebalanceManual: RefillViewX;
  configValidate: ConfigValidation & CostExtras;
  swapApprove: SwapActionResult;
  swapReject: SwapActionResult;
  swapAbort: SwapActionResult;
  swapWithhold: SwapActionResult;
  swapRelease: SwapActionResult;
  swapPublishEvidence: SwapActionResult;
}
export type { Alert, RefillView };

/** The outcome of an answer, also for a daemon that does not send `outcome`. */
export const outcomeOf = (r: SwapActionResult): ActionOutcome => r.outcome ?? (r.ok ? 'carried_out' : 'refused');
