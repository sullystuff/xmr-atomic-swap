/**
 * Taker flows, both directions, every refund path (SPEC 3.4, 3.5, 3.11 taker obligations, 8.5).
 *
 * `takerStep` is pure. Feed it the swap read at `finalized` and the chain's own time; it never
 * looks at a local clock. See `./types.ts` for the contract of a flow.
 */
import { B_ADDRESS_MIN_LEFT_SECS, SWAP_STATE } from '@xmrswap/protocol';
import { type SwapView, deadlinesOf, endedInClaim, endedInRefund } from '../machine/view.js';
import { type Decision, type LockReport, call, done, need, offchain, wait } from './types.js';

export interface TakerFacts {
  /** The swap read at `finalized`. A closed Solana account reads as state 0. */
  swap: SwapView;
  /** Chain time of that read, in seconds. */
  now: bigint;
  /** The user asked to get out (cancel while pending, refund or abort afterwards). */
  cancel?: boolean;
  /**
   * Whether the notice decrypts and opens its commitment (direction A). `undefined` = not
   * checked yet. `false` is "no lock" (SPEC 2.8).
   */
  noticeOpens?: boolean;
  /** `verifyLock` against every node, at the swap's depth. Direction A: the maker's lock. */
  lock?: LockReport;
  /** Direction B: the taker's own XMR payment is broadcast and its txid is known. */
  paid?: boolean;
  /** Ethereum direction B: the maker's DLEQ proof for the funded share verified against storage. `undefined` = not checked. */
  makerProofOk?: boolean;
  /** The sweep of the joint address is confirmed (or there is nothing to sweep). */
  swept?: boolean;
}

export function takerStep(f: TakerFacts): Decision {
  return f.swap.direction === 0 ? takerA(f) : takerB(f);
}

/** Settled-state housekeeping shared by both directions. */
function takerDone(f: TakerFacts, recoverXmr: boolean): Decision {
  const s = f.swap;
  if (s.owedTaker > 0n) return call({ name: 'withdraw_owed', who: 'taker' }, 'taker', 'withdraw_owed');
  if (recoverXmr && !f.swept) return offchain('sweep');
  if (s.state === SWAP_STATE.NONE) return done('closed');
  if (endedInClaim(s)) {
    // After a claim in A the taker is the party that did not reveal and may close at once (Solana).
    if (s.chain === 'solana' && s.direction === 0 && s.owedMaker === 0n && s.owedTreasury === 0n) return call({ name: 'close_swap' }, 'session', 'close_swap');
    return done('completed');
  }
  return done(endedInRefund(s) ? 'refunded' : 'closed');
}

/** The deposit sub-machine from the taker's side: crank what anyone may crank. */
function takerDeposit(f: TakerFacts): Decision | null {
  const s = f.swap;
  const d = deadlinesOf(s.chain, s);
  if (s.state === SWAP_STATE.HOLD) return f.now >= d.tHold! ? call({ name: 'release_deposit' }, 'anyone', 'release_deposit') : wait('deposit-hold', d.tHold);
  if (s.state === SWAP_STATE.WITHHELD) return f.now >= d.tSplit! ? call({ name: 'split_deposit' }, 'anyone', 'split_deposit') : wait('deposit-release', d.tSplit);
  return null;
}

// ------------------------------------------------------------------ direction A: the taker is the locker

function takerA(f: TakerFacts): Decision {
  const { swap: s, now } = f;
  const d = deadlinesOf(s.chain, s);
  const M = d.margin;
  const S = SWAP_STATE;
  /** A keyed refund after the last pre-expiry window: wait for `T_exp`, then A10f. */
  const expiry = (): Decision => (now >= d.tExp ? call({ name: 'refund' }, 'session', 'A10f') : wait('expiry', d.tExp, 'refund-window-missed'));

  switch (s.state) {
    case S.NONE:
      return done('closed');
    case S.PENDING:
      if (f.cancel) return call({ name: 'cancel_pending' }, 'session', 'A4');
      if (now >= d.tPend!) return call({ name: 'expire_pending' }, 'anyone', 'A5');
      return wait('approval', d.tPend);
    case S.ACTIVE:
      // No notice by the deadline: the keyless refund needs no secret and anyone can send it.
      if (now >= d.tNote!) return call({ name: 'refund_unnoticed' }, 'anyone', 'A8');
      // A keyed refund is valid in ACTIVE at every instant (A10a, or A10b/A10g if it lands later).
      if (f.cancel) return call({ name: 'refund' }, 'session', 'A10a');
      return wait('notice', d.tNote);
    case S.NOTICED: {
      const tCo = d.tCo!;
      const lockGood = f.noticeOpens === true && f.lock?.ok === true && f.lock.state === 'confirmed';
      if (now < tCo) {
        if (f.noticeOpens === undefined) return need('notice-opening');
        if (f.noticeOpens && f.lock === undefined) return need('lock-report');
        if (lockGood) return now >= d.tReadyMin! ? call({ name: 'set_ready' }, 'session', 'A9', tCo - 1n) : wait('ready-minimum', d.tReadyMin);
      }
      const refundable = now <= tCo - M;
      if (refundable && (f.cancel || now >= d.tCut!)) return call({ name: 'refund' }, 'session', 'A10b', tCo - M);
      if (refundable) return wait('xmr-confirmations', d.tCut, f.noticeOpens === false ? 'notice-invalid' : f.lock?.state === 'invalid' ? 'lock-invalid' : undefined);
      // Too late to refund safely: from T_co the maker may claim, which reveals its share.
      return expiry();
    }
    case S.READY:
      if (now < d.tCd!) return wait('claim', d.tCd);
      if (now <= d.tFinal - M) return call({ name: 'refund' }, 'session', 'A10e', d.tFinal - M);
      return expiry();
    case S.ABORTED_FREE:
    case S.ABORTED_HOLD:
      if (now <= d.tFinal - M) return call({ name: 'refund' }, 'session', s.state === S.ABORTED_FREE ? 'A10d' : 'A10c', d.tFinal - M);
      return expiry();
    case S.HOLD:
    case S.WITHHELD:
      return takerDeposit(f)!;
    default:
      // DONE. After the maker's claim its share is in the swap: the XMR is the taker's to sweep.
      return takerDone(f, endedInClaim(s));
  }
}

// ------------------------------------------------------------------ direction B: the taker is the claimer

function takerB(f: TakerFacts): Decision {
  const { swap: s, now } = f;
  const d = deadlinesOf(s.chain, s);
  const M = d.margin;
  const S = SWAP_STATE;
  /** The claim after `T_final` (B10c), or nothing more the taker can send. */
  const afterFinal = (): Decision => {
    if (now < d.tFinal) return wait('final', d.tFinal, 'claim-window-missed');
    if (now <= d.tExp - M) return call({ name: 'claim' }, 'session', 'B10c', d.tExp - M);
    return wait('maker-refund', null, 'claim-window-missed');
  };
  /** After any maker refund the maker's share is public: the taker's XMR is recoverable. */
  const recover = endedInRefund(s) && f.paid === true;

  switch (s.state) {
    case S.NONE:
      return done('closed');
    case S.PENDING:
      if (f.cancel) return call({ name: 'cancel_pending' }, 'session', 'B2');
      if (now >= d.tPend!) return call({ name: 'expire_pending' }, 'anyone', 'B4');
      return wait('funding', d.tPend);
    case S.ACTIVE: {
      const stranded = (warning: 'too-late-to-pay' | 'notice-window-missed' | 'maker-proof-invalid'): Decision =>
        now >= d.tExp ? call({ name: 'expire_unnoticed' }, 'anyone', 'B11') : wait('maker-refund', d.tExp, warning);
      if (f.paid) {
        // A late notice is still accepted until T_nl; it costs only the deposit protection.
        const last = (d.tNl < d.tFinal ? d.tNl : d.tFinal) - 1n;
        return now <= last ? call({ name: 'post_notice' }, 'session', 'B6', last) : stranded('notice-window-missed');
      }
      if (s.chain === 'ethereum' && f.makerProofOk === undefined) return need('dleq-proof');
      if (s.chain === 'ethereum' && f.makerProofOk === false) return stranded('maker-proof-invalid');
      // The page refuses to show the address with too little time left before T_note.
      const lastShow = d.tNote! - BigInt(B_ADDRESS_MIN_LEFT_SECS[s.chain]);
      return now <= lastShow ? offchain('show-address', lastShow) : stranded('too-late-to-pay');
    }
    case S.NOTICED:
      if (now < d.tCo!) return f.cancel ? call({ name: 'abort' }, 'session', 'B8') : wait('ready', d.tCo);
      // [T_co, T_final) and [T_final, T_exp) are both the claimer's: one continuous window.
      if (now <= d.tExp - M) return call({ name: 'claim' }, 'session', now < d.tFinal ? 'B10b' : 'B10c', d.tExp - M);
      return wait('maker-refund', null, 'claim-window-missed');
    case S.READY:
      if (f.cancel && now < d.tFinal) return call({ name: 'abort' }, 'session', 'B8');
      if (now <= d.tCd! - M) return call({ name: 'claim' }, 'session', 'B10a', d.tCd! - M);
      return afterFinal();
    case S.ABORTED_FREE:
    case S.ABORTED_HOLD:
      if (now < d.tFinal) return wait('maker-refund', d.tFinal);
      return afterFinal();
    case S.HOLD:
    case S.WITHHELD: {
      const dep = takerDeposit(f)!;
      if (dep.do === 'call') return dep;
      return recover && !f.swept ? offchain('sweep') : dep;
    }
    default:
      return takerDone(f, recover);
  }
}

/**
 * "At risk" in the sense of SPEC 8.5: paying SOL, ETH or USDC with the leg locked and not yet
 * Ready or Refunded. A pending lock is safe to close.
 */
export function takerAtRisk(s: SwapView): boolean {
  if (s.direction !== 0) return false;
  return s.state === SWAP_STATE.ACTIVE || s.state === SWAP_STATE.NOTICED || s.state === SWAP_STATE.ABORTED_FREE || s.state === SWAP_STATE.ABORTED_HOLD;
}

/** The refund deadline the standing banner counts down to (direction A): the last second the tab can still refund by itself. */
export function takerRefundDeadline(s: SwapView): bigint | null {
  const d = deadlinesOf(s.chain, s);
  switch (s.state) {
    case SWAP_STATE.NOTICED:
      return d.tCo! - d.margin;
    case SWAP_STATE.READY:
    case SWAP_STATE.ABORTED_FREE:
    case SWAP_STATE.ABORTED_HOLD:
      return d.tFinal - d.margin;
    default:
      return null;
  }
}
