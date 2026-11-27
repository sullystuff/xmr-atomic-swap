/**
 * Shared vocabulary of the taker and maker flows.
 *
 * A flow is a pure function: (the swap as read from the chain at `finalized`, chain time, a few
 * facts only the caller can know) → the one thing to do next. It performs no I/O, keeps no
 * state and reads no clock, so the same function drives the browser tab, the daemon, a resumed
 * session and the tests. Callers loop: read state, ask the flow, do what it says, repeat.
 *
 * Every chain call a flow proposes is one the reference model accepts at `now`, and a call that
 * reveals a spend share is proposed only while it stays acceptable for the whole broadcast
 * margin `M` (SPEC 3.2 rule 2): a failed transaction still publishes its arguments.
 */
import type { Call, Role } from '../machine/model.js';

/** What a `verifyLock` run concluded, reduced to what the flows need. */
export interface LockReport {
  state: 'not-found' | 'invalid' | 'pending' | 'confirming' | 'confirmed';
  /** True only for `confirmed` with no blocking reason: every node agreed at the swap's depth. */
  ok: boolean;
  confirmations: number;
}

/** A chain call the flows can propose: the model's calls plus Solana's `close_swap`. */
export type FlowCall = Call | { name: 'close_swap' };

export type OffchainAction =
  /** Direction B taker: show the joint address and ask for the XMR payment. */
  | 'show-address'
  /** Sweep the joint address with both spend shares (the revealed one is in the swap). */
  | 'sweep'
  /** Direction A maker: build the lock transaction without relaying it. */
  | 'prepare-lock-tx'
  /** Direction A maker: relay the prepared lock transaction (the notice is final). */
  | 'relay-xmr'
  /** Direction A maker: the lock dropped out of the chain; relay the stored transaction again. */
  | 'rebroadcast-xmr';

export type Need =
  /** Decrypt the notice and check that it opens the commitment. */
  | 'notice-opening'
  /** Run `verifyLock` against every configured node. */
  | 'lock-report'
  /** Ethereum: fetch and verify the counterparty's DLEQ proof. */
  | 'dleq-proof'
  /** Maker: apply the approval rules to this pending swap. */
  | 'approval-decision'
  /** Maker: re-read the swap at `finalized` and compare the commitments with the verified ones. */
  | 'commitment-check';

export type Warning =
  /** The window for the caller's own secret-bearing call closed; the counterparty can now act first. */
  | 'refund-window-missed'
  | 'claim-window-missed'
  /** The maker missed a provable deadline. */
  | 'maker-fault'
  /** Direction B: too little time is left before `T_note` to show the address and pay safely. */
  | 'too-late-to-pay'
  /** Direction B: XMR was paid but the notice can no longer be posted. */
  | 'notice-window-missed'
  /** Ethereum direction B: the maker's proof for the funded share does not verify; never show the address. */
  | 'maker-proof-invalid'
  /** The lock notice does not decrypt or does not open its commitment: treated as "no lock". */
  | 'notice-invalid'
  /** The Monero lock is invalid (wrong amount, time-locked, duplicate output key, node disagreement). */
  | 'lock-invalid'
  /** The swap is frozen (SPEC 11.6): the claimer's claim-without-ready is paused until `T_ff`; the locker must return before `T_ff − M`. */
  | 'frozen';

/**
 * Why an explicit request (the taker's "refund this swap" / cancel, the maker's reject, back
 * out, withhold or release) cannot be carried out in the swap's present state. The decision
 * that carries it says what happens instead; the UI shows the reason rather than continuing
 * silently.
 */
export type Refusal =
  /** Ready is set: the locker has no refund until the claim window closes (`T_cd`). */
  | 'ready-already-set'
  /** The requester's refund window is over; a refund sent now could land in the counterparty's window and leak the share. */
  | 'refund-window-closed'
  /** An abort is accepted only before `T_final`. */
  | 'abort-window-closed'
  /** The swap ended in a claim: there is nothing left to refund. */
  | 'already-settled'
  /** Direction B after funding: the taker has no call that ends the swap; it does not pay and waits for the maker's refund. */
  | 'cannot-exit-after-funding'
  /** Direction B outside window mode (Solana): a pending take cannot be rejected, only left to lapse. */
  | 'reject-not-available'
  /** A deposit can be withheld only inside the 30-minute hold. */
  | 'hold-ended'
  /** No deposit is in the hold or withheld: nothing to withhold or release. */
  | 'no-deposit-held'
  /** A freeze was asked for on a swap that names no watcher (or whose offer has no freeze window): only such a swap can be frozen. */
  | 'freeze-not-available'
  /** A freeze is accepted only in NOTICED and before `T_co`: there is no notice yet, ready is set, or the claim delay has run out. */
  | 'freeze-window-closed'
  /** The swap is, or was, frozen: a swap can be frozen once. */
  | 'already-frozen';

/** What every decision may carry: an explicit request that could not be honoured. */
interface Refusable {
  refused?: Refusal;
}

export type Decision = Refusable & DecisionBody;
type DecisionBody =
  | {
      do: 'call';
      call: FlowCall;
      /** Who should sign. `anyone` = any fee payer. */
      caller: Role;
      /** The call reveals the caller's spend share: simulate first, never skip preflight. */
      secret: boolean;
      /** Last chain second at which this may still be broadcast; `null` = no limit. */
      notAfter: bigint | null;
      /** The row of SPEC 3.4 to 3.6 this is, for logs and tests. */
      row: string;
      /** The process's hardest deadline (maker, direction B refund before `T_co − M`). */
      urgent?: boolean;
    }
  | { do: 'offchain'; action: OffchainAction; notAfter: bigint | null }
  | { do: 'need'; fact: Need }
  | {
      do: 'wait';
      /** What the caller is waiting for. */
      on: string;
      /** Chain second at which the decision changes without any event; `null` = only an event changes it. */
      until: bigint | null;
      warning?: Warning;
    }
  | { do: 'done'; outcome: 'completed' | 'refunded' | 'closed'; warning?: Warning };

export const call = (c: FlowCall, caller: Role, row: string, notAfter: bigint | null = null, extra: { urgent?: boolean } = {}): Decision => ({
  do: 'call',
  call: c,
  caller,
  secret: c.name === 'refund' || c.name === 'claim',
  notAfter,
  row,
  ...extra,
});
export const wait = (on: string, until: bigint | null, warning?: Warning): Decision => (warning ? { do: 'wait', on, until, warning } : { do: 'wait', on, until });
export const need = (fact: Need): Decision => ({ do: 'need', fact });
export const offchain = (action: OffchainAction, notAfter: bigint | null = null): Decision => ({ do: 'offchain', action, notAfter });
export const done = (outcome: 'completed' | 'refunded' | 'closed', warning?: Warning): Decision => (warning ? { do: 'done', outcome, warning } : { do: 'done', outcome });
/** The same decision, marked: the explicit request that led here could not be honoured, for this reason. */
export const refuse = (d: Decision, reason: Refusal): Decision => ({ ...d, refused: reason });
