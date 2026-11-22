/**
 * What the real daemon's API adds to the frozen `@xmrswap/protocol` types
 * (`packages/daemon/DEVIATIONS.md`, "Console contract" A1 to A10). Every addition is optional
 * here, so the console also works against a daemon that predates it.
 */
import type { ChainName } from '@xmrswap/protocol';
import type { Alert, ConfigIssue, FeesResponse, OffersResponse, RefillView, RegistrationResponse, StatusResponse, SwapAction, SwapActionResponse, SwapDetail, TxResult } from '@xmrswap/protocol/daemon-api';

/** A10: what became of an operator instruction. */
export type ActionOutcome = 'carried_out' | 'refused' | 'pending';
/** The SDK's refusal reasons plus the daemon's own two. */
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
export interface SwapDetailX extends SwapDetail {
  /** The operator's latest instruction and what became of it. */
  instruction?: SwapInstruction | null;
}

/** A6: the owner's pause is per chain. */
export interface ChainPause {
  chain: ChainName;
  owner: boolean;
  operator: boolean;
}
export interface StatusX extends StatusResponse {
  paused: StatusResponse['paused'] & { chains?: ChainPause[] };
}
/** A6: the daemon's own SOL price and the compute units it charges an offer update at. */
export interface CostExtras {
  sol_usd?: number | null;
  compute_units_per_update?: number;
}
export type FeesX = FeesResponse & CostExtras;
export type OffersX = OffersResponse & CostExtras;

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
/** A5: `GET /api/registration/links`, one entry per recorded `LinkChanged`, newest first. Values are 0x-hex bytes. */
export interface LinkEntry {
  chain: ChainName;
  old: string;
  new: string;
  effective_at: number;
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
