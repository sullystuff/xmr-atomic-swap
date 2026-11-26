/**
 * What the real daemon's API adds to the frozen `@xmrswap/protocol` types
 * (`packages/daemon/DEVIATIONS.md`, "Console contract" A1 to A10). Every addition is optional
 * here, so the console also works against a daemon that predates it.
 */
import type { ChainName } from '@xmrswap/protocol';
import type { Alert, ChainConnection, ConfigIssue, ConfigValidation, FeesResponse, OfferView, OffersResponse, RebalanceResponse, RefillView, RegistrationResponse, StatusResponse, SwapAction, SwapActionResponse, SwapDetail, SwapSummary, SwapsResponse, TxResult } from '@xmrswap/protocol/daemon-api';

/** A10: what became of an operator instruction. */
export type ActionOutcome = 'carried_out' | 'refused' | 'pending';
/** The daemon's one documented list (its A16): the SDK's eight reasons plus its own two. */
export const REFUSAL_REASONS = [
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
export type SwapSummaryX = SwapSummary & SummaryExtras;
export type SwapDetailX = SwapDetail & SummaryExtras;
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
  /** A12: `registry_onion` is what the registry shows; `reachable` stays `null` (the daemon runs no Tor client). */
  tor: StatusResponse['tor'] & { registry_onion?: string | null };
}
/** A6: the daemon's own SOL price and the compute units it charges an offer update at. */
export interface CostExtras {
  sol_usd?: number | null;
  compute_units_per_update?: number;
}
export type FeesX = FeesResponse & CostExtras;
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
export type OfferViewX = OfferView & OfferSourceExtras;
export type OffersX = Omit<OffersResponse, 'offers'> & CostExtras & { offers: OfferViewX[] };

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
