/**
 * Maker flows, both directions (SPEC 3.4 to 3.6, 3.11 maker obligations, 7.5).
 *
 * `makerStep` is pure; the daemon supplies the swap read at `finalized`, the chain's time and
 * the facts below, and performs what comes back. See `./types.ts`.
 */
import { CHAIN_CONSTS, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import { type SwapView, deadlinesOf, endedInClaim, endedInRefund, hasFlag } from '../machine/view.js';
import { type Decision, type LockReport, call, done, need, offchain, wait } from './types.js';

export interface MakerFacts {
  /** The swap read at `finalized`. */
  swap: SwapView;
  /** Chain time of that read. */
  now: bigint;
  /** The approval rules' verdict on a pending swap. `undefined` = not decided yet. */
  approval?: { approve: true } | { approve: false; reason: 0 | 1 | 2 };
  /** Ethereum: the taker's DLEQ proof verified against the commitments in storage. `undefined` = not checked. */
  takerProofOk?: boolean;
  /** The swap's stored commitments are the ones this maker verified (SPEC 3.11 maker rule 8). `undefined` = not checked. */
  commitmentsOk?: boolean;
  /** Direction A: the maker's own lock transaction. */
  lockTx?: 'none' | 'unavailable' | 'prepared' | 'relayed';
  /** Direction A: an input of the prepared lock was spent elsewhere, or the lock can no longer confirm. */
  lockFailed?: boolean;
  /** Direction B: the notice decrypts and opens its commitment. `undefined` = not checked. */
  noticeOpens?: boolean;
  /** `verifyLock` against every node at the swap's depth. A: the maker's own lock. B: the taker's. */
  lock?: LockReport;
  /** Direction A, taker never set ready: what to do from `T_co`. Default: claim when the lock is confirmed, otherwise abort. */
  withoutReady?: 'claim' | 'abort';
  /** The withhold policy's verdict for a held deposit. */
  withhold?: boolean;
  /** The taker asked for the deposit back and the maker agrees. */
  release?: boolean;
  /** Give the escrow back before the taker's notice (direction B, ACTIVE). */
  backOut?: boolean;
  /** The sweep of the joint address is confirmed (or there is nothing to sweep). */
  swept?: boolean;
}

export function makerStep(f: MakerFacts): Decision {
  return f.swap.direction === 0 ? makerA(f) : makerB(f);
}

function makerPending(f: MakerFacts, row: { open: 'approve' | 'fund'; openRow: string; rejectRow: string }): Decision {
  const { swap: s, now } = f;
  const d = deadlinesOf(s.chain, s);
  const canReject = s.direction === 0 || s.mode === 1 || CHAIN_CONSTS[s.chain].explicitApprove;
  const reject = (reason: 0 | 1 | 2): Decision => (canReject ? call({ name: 'reject', reason }, 'operator', row.rejectRow) : wait('lapse', d.tPend));
  if (s.chain === 'ethereum') {
    if (f.takerProofOk === undefined) return need('dleq-proof');
    // Unusable taker input is rejected at once with reason 1, which frees the pending slot.
    if (!f.takerProofOk) return reject(1);
  }
  if (f.approval === undefined) return need('approval-decision');
  if (!f.approval.approve) return reject(f.approval.reason);
  if (now >= d.tPend!) return wait('lapse', null);
  return call({ name: row.open }, 'operator', row.openRow, d.tPend! - 1n);
}

/** The deposit sub-machine from the maker's side. `evidence` says whether an opening must accompany a withhold. */
function makerDeposit(f: MakerFacts): Decision | null {
  const { swap: s, now } = f;
  const d = deadlinesOf(s.chain, s);
  if (s.state === SWAP_STATE.HOLD) {
    if (f.release) return call({ name: 'release_deposit' }, 'operator', 'release_deposit');
    // Refused at or after T_hold, whoever has or has not cranked the release.
    if (f.withhold && now < d.tHold!) return call({ name: 'withhold', evidence: s.direction === 0 && hasFlag(s, SWAP_FLAG.NOTICE) ? 'opens' : 'absent' }, 'operator', 'withhold', d.tHold! - 1n);
    return null;
  }
  if (s.state === SWAP_STATE.WITHHELD && f.release) return call({ name: 'release_deposit' }, 'operator', 'release_deposit');
  return null;
}

/** After an abort or refund where a notice exists, the claimer publishes the opening (SPEC 7.1 evidence). */
function evidenceDue(s: SwapView): boolean {
  return hasFlag(s, SWAP_FLAG.NOTICE) && !hasFlag(s, SWAP_FLAG.EVIDENCE);
}

// ------------------------------------------------------------------ direction A: the maker is the claimer

function makerA(f: MakerFacts): Decision {
  const { swap: s, now } = f;
  const d = deadlinesOf(s.chain, s);
  const M = d.margin;
  const S = SWAP_STATE;
  const relayed = f.lockTx === 'relayed';
  /** The claim after `T_final` (A11c), or nothing more the maker can send. */
  const afterFinal = (warning?: 'claim-window-missed'): Decision => {
    if (now < d.tFinal) return wait('final', d.tFinal, warning);
    if (now <= d.tExp - M) return call({ name: 'claim' }, 'operator', 'A11c', d.tExp - M);
    return wait('taker-refund', null, 'claim-window-missed');
  };

  switch (s.state) {
    case S.NONE:
      return done('closed');
    case S.PENDING:
      return makerPending(f, { open: 'approve', openRow: 'A2', rejectRow: 'A3' });
    case S.ACTIVE:
      // Past the deadline nothing was broadcast (the notice comes first): the taker's refund is keyless.
      if (now >= d.tNote!) return wait('taker-refund', null, 'maker-fault');
      if (f.commitmentsOk === undefined) return need('commitment-check');
      // A share whose proof this maker never verified, or a lock it cannot fund: walk away at once.
      if (!f.commitmentsOk || f.lockTx === 'unavailable' || f.lockFailed) return call({ name: 'abort' }, 'operator', 'A7a', d.tNote! - 1n);
      if (f.lockTx === undefined || f.lockTx === 'none') return offchain('prepare-lock-tx', d.tNote! - 1n);
      return call({ name: 'post_notice' }, 'operator', 'A6', d.tNote! - 1n);
    case S.NOTICED: {
      const tCo = d.tCo!;
      if (!relayed) {
        // The notice is final (the swap was read at finalized): only now may the XMR be broadcast.
        // After T_cut the taker's tab refunds by itself, so a late relay only burns fees.
        if (f.lockTx === 'prepared' && !f.lockFailed && now < d.tCut!) return offchain('relay-xmr', d.tCut! - 1n);
        if (now < d.tFinal) return call({ name: 'abort' }, 'operator', now < tCo ? 'A7b' : 'A7c', d.tFinal - 1n);
        return wait('taker-refund', null);
      }
      if (f.lockFailed && now < d.tFinal) return call({ name: 'abort' }, 'operator', now < tCo ? 'A7b' : 'A7c', d.tFinal - 1n);
      if (f.lock?.state === 'not-found' && now < tCo) return offchain('rebroadcast-xmr');
      if (now < tCo) return wait('ready', tCo);
      // From T_co the claim is open without ready, through T_final, until T_exp.
      if (now > d.tExp - M) return wait('taker-refund', null, 'claim-window-missed');
      if (f.lock === undefined && f.withoutReady === undefined) return need('lock-report');
      const policy = f.withoutReady ?? (f.lock?.ok ? 'claim' : 'abort');
      if (policy === 'claim' || now >= d.tFinal) return call({ name: 'claim' }, 'operator', now < d.tFinal ? 'A11b' : 'A11c', d.tExp - M);
      return call({ name: 'abort' }, 'operator', 'A7c', d.tFinal - 1n);
    }
    case S.READY:
      // `ready` is final. Claim no later than T_cd − M.
      if (now <= d.tCd! - M) return call({ name: 'claim' }, 'operator', 'A11a', d.tCd! - M);
      return afterFinal('claim-window-missed');
    case S.ABORTED_FREE:
    case S.ABORTED_HOLD:
      // An abort waives the claim until T_final, not forever.
      return afterFinal();
    case S.HOLD:
    case S.WITHHELD: {
      const dep = makerDeposit(f);
      if (dep) return dep;
      // The taker's refund revealed its share: the maker's XMR comes back with it.
      if (relayed && !f.swept) return offchain('sweep');
      if (evidenceDue(s)) return call({ name: 'publish_evidence', opens: true }, 'operator', 'publish_evidence');
      return s.state === S.HOLD ? wait('deposit-hold', d.tHold) : wait('deposit-split', d.tSplit);
    }
    default: {
      // DONE.
      if (endedInRefund(s)) {
        if (relayed && !f.swept) return offchain('sweep');
        if (evidenceDue(s)) return call({ name: 'publish_evidence', opens: true }, 'operator', 'publish_evidence');
        // After a refund the operator is the party that did not reveal and may close (Solana).
        if (s.chain === 'solana' && s.owedTaker === 0n && s.owedMaker === 0n && s.owedTreasury === 0n) return call({ name: 'close_swap' }, 'operator', 'close_swap');
        return done('refunded');
      }
      if (s.owedMaker > 0n) return call({ name: 'withdraw_owed', who: 'maker' }, 'owner', 'withdraw_owed');
      return done(endedInClaim(s) ? 'completed' : 'closed');
    }
  }
}

// ------------------------------------------------------------------ direction B: the maker is the locker

function makerB(f: MakerFacts): Decision {
  const { swap: s, now } = f;
  const d = deadlinesOf(s.chain, s);
  const M = d.margin;
  const S = SWAP_STATE;
  /** A keyed refund after the last pre-expiry window: wait for `T_exp`, then B9g. */
  const expiry = (): Decision => (now >= d.tExp ? call({ name: 'refund' }, 'operator', 'B9g') : wait('expiry', d.tExp, 'refund-window-missed'));

  switch (s.state) {
    case S.NONE:
      return done('closed');
    case S.PENDING:
      return makerPending(f, { open: 'fund', openRow: 'B5', rejectRow: 'B3' });
    case S.ACTIVE:
      // The maker's refund is valid in ACTIVE at every instant, and in NOTICED if a late notice lands first.
      if (now >= d.tNote!) return call({ name: 'refund' }, 'operator', 'B9b');
      if (f.backOut) return call({ name: 'refund' }, 'operator', 'B9a');
      return wait('notice', d.tNote);
    case S.NOTICED: {
      const tCo = d.tCo!;
      const refundable = now <= tCo - M;
      if (now < tCo) {
        if (f.noticeOpens === undefined) return need('notice-opening');
        if (f.noticeOpens && f.lock === undefined) return need('lock-report');
        const lockGood = f.noticeOpens && f.lock?.ok === true && f.lock.state === 'confirmed';
        if (lockGood) {
          if (f.commitmentsOk === undefined) return need('commitment-check');
          if (f.commitmentsOk) return now >= d.tReadyMin! ? call({ name: 'set_ready' }, 'operator', 'B7', tCo - 1n) : wait('ready-minimum', d.tReadyMin);
          // The commitments changed under the maker: give the escrow back while it still can.
          if (refundable) return call({ name: 'refund' }, 'operator', now < d.tCut! ? (hasFlag(s, SWAP_FLAG.LATE_NOTICE) ? 'B9h' : 'B9c') : 'B9d', tCo - M, { urgent: true });
        }
      }
      // Not confirmed at T_cut: refund at once, and never later than T_co − M. A missed window
      // lets a taker with a false notice claim the escrow at T_co.
      if (refundable && now >= d.tCut!) return call({ name: 'refund' }, 'operator', 'B9d', tCo - M, { urgent: true });
      if (refundable) return wait('xmr-confirmations', d.tCut, f.noticeOpens === false ? 'notice-invalid' : f.lock?.state === 'invalid' ? 'lock-invalid' : undefined);
      return expiry();
    }
    case S.READY:
      if (now < d.tCd!) return wait('claim', d.tCd);
      if (now <= d.tFinal - M) return call({ name: 'refund' }, 'operator', 'B9e', d.tFinal - M);
      return expiry();
    case S.ABORTED_FREE:
    case S.ABORTED_HOLD:
      if (now <= d.tFinal - M) return call({ name: 'refund' }, 'operator', 'B9f', d.tFinal - M);
      return expiry();
    case S.HOLD:
    case S.WITHHELD: {
      const dep = makerDeposit(f);
      if (dep) return dep;
      return s.state === S.HOLD ? wait('deposit-hold', d.tHold) : wait('deposit-split', d.tSplit);
    }
    default: {
      // DONE. After the taker's claim its share is in the swap: the XMR is the maker's to sweep.
      if (endedInClaim(s)) {
        if (!f.swept) return offchain('sweep');
        if (s.chain === 'solana' && s.owedTaker === 0n && s.owedMaker === 0n && s.owedTreasury === 0n) return call({ name: 'close_swap' }, 'operator', 'close_swap');
        return done('completed');
      }
      if (s.owedMaker > 0n) return call({ name: 'withdraw_owed', who: 'maker' }, 'owner', 'withdraw_owed');
      return done(endedInRefund(s) ? 'refunded' : 'closed');
    }
  }
}
