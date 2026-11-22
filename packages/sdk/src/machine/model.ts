/**
 * The state machine of SPEC section 3 as a pure function, a line-for-line port of the reference
 * model `swap_core::model::apply`. It has no I/O and no cryptography: a secret is "it opens the
 * commitment or it does not", evidence and the open hash likewise.
 *
 * The flows (`../flows`) decide with this model and nothing else, so what the SDK proposes is
 * what the contracts accept. `interfaces/vectors/transitions.json` is replayed against it row by
 * row in the unit tests; the conventions it encodes (check order, `TooEarly` versus `TooLate`,
 * "closed" rows) are those of `docs/research/wp1-deviations.md` M1 to M12.
 *
 * All per-swap arithmetic (bounds, `Δ_cut`, deposit, fee, split) comes from `@xmrswap/core-wasm`;
 * nothing of SPEC section 2 or the rounding rules is re-derived here.
 */
import { deadlines, depositOf, feeOf, splitOf } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type ChainConsts, type ChainName, COUNTER, COUNTER_NONE, COUNTER_SLOTS, DAY_SECS, DEPOSIT_STATE, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';

export type Role = 'taker' | 'session' | 'operator' | 'owner' | 'anyone';
export type Party = 'taker' | 'maker' | 'treasury';
export type DirectionCode = 0 | 1;

/** Largest `amount` each chain's type holds (Ethereum is capped at `u128`, as the compact quote form is). */
export const MAX_AMOUNT: Readonly<Record<ChainName, bigint>> = { solana: (1n << 64n) - 1n, ethereum: (1n << 128n) - 1n };

/** Every field of the on-chain swap record that a transition reads or writes. Times are chain seconds. */
export interface ModelSwap {
  state: number;
  direction: DirectionCode;
  /** Effective mode: 0 auto, 1 window, 2 advance, 3 quote. */
  mode: number;
  /** Counter id of the transition that settled the swap; `0xff` while open. */
  outcome: number;
  depositState: number;
  depth: number;
  flags: number;
  amount: bigint;
  /** `D` (A: part of `amount`) or the take deposit `Dp` (B: posted separately). */
  deposit: bigint;
  feeBps: number;
  wN: number;
  dC: number;
  wC: number;
  tLock: bigint;
  tPendingDeadline: bigint;
  tActive: bigint;
  tNoteDeadline: bigint;
  tNotice: bigint;
  tCut: bigint;
  tClaimOpen: bigint;
  tReady: bigint;
  tClaimDeadline: bigint;
  tFinal: bigint;
  tRefund: bigint;
  tSettled: bigint;
  owedTaker: bigint;
  owedMaker: bigint;
  owedTreasury: bigint;
}

/** "No such swap": the state `lock` and `take` start from. */
export const NO_SWAP: ModelSwap = Object.freeze({
  state: SWAP_STATE.NONE,
  direction: 0,
  mode: 0,
  outcome: COUNTER_NONE,
  depositState: 0,
  depth: 0,
  flags: 0,
  amount: 0n,
  deposit: 0n,
  feeBps: 0,
  wN: 0,
  dC: 0,
  wC: 0,
  tLock: 0n,
  tPendingDeadline: 0n,
  tActive: 0n,
  tNoteDeadline: 0n,
  tNotice: 0n,
  tCut: 0n,
  tClaimOpen: 0n,
  tReady: 0n,
  tClaimDeadline: 0n,
  tFinal: 0n,
  tRefund: 0n,
  tSettled: 0n,
  owedTaker: 0n,
  owedMaker: 0n,
  owedTreasury: 0n,
});

/** The per-swap parameters copied from the offer or quote at lock time. */
export interface SwapParams {
  wA: number;
  wN: number;
  dC: number;
  wC: number;
  wF: number;
  depth: number;
  depBps: number;
}

export interface OpenArgs extends SwapParams {
  /** Mode of the offer or quote: 0 AUTO, 1 WINDOW, 2 ADVANCE, 3 taker-bound quote. */
  offerMode: number;
  /** A valid advance approval is presented. */
  approval: boolean;
  /** The escrowed amount (A: paid by the taker now; B: funded by the maker later). */
  amount: bigint;
}

export type EvidenceArg = 'absent' | 'opens' | 'mismatch';

/** A call into the machine. Names are the instruction names of SPEC 4 (snake_case). */
export type Call =
  | { name: 'lock'; args: OpenArgs }
  | { name: 'take'; args: OpenArgs }
  | { name: 'approve'; openOk?: boolean }
  | { name: 'fund'; openOk?: boolean }
  | { name: 'reject'; openOk?: boolean; reason: 0 | 1 | 2 }
  | { name: 'cancel_pending' }
  | { name: 'expire_pending' }
  | { name: 'post_notice' }
  | { name: 'set_ready' }
  | { name: 'abort' }
  | { name: 'refund_unnoticed' }
  | { name: 'expire_unnoticed' }
  | { name: 'refund'; secretOk?: boolean }
  | { name: 'claim'; secretOk?: boolean }
  | { name: 'release_deposit' }
  | { name: 'withhold'; evidence?: EvidenceArg }
  | { name: 'split_deposit' }
  | { name: 'publish_evidence'; opens?: boolean }
  | { name: 'withdraw_owed'; who: Party };
export type CallName = Call['name'];

/** A call whose arguments reveal a spend share. */
export const isSecretBearing = (name: CallName): boolean => name === 'refund' || name === 'claim';

/** What the model cannot know: which destinations can receive, and the maker's `open_pending`. */
export interface Env {
  takerCanReceive: boolean;
  makerCanReceive: boolean;
  treasuryCanReceive: boolean;
  openPending: number;
}
export const ENV_OK: Env = Object.freeze({ takerCanReceive: true, makerCanReceive: true, treasuryCanReceive: true, openPending: 0 });

export interface Payout {
  to: Party;
  amount: bigint;
  /** False: transferred now. True: left in escrow and added to `owed_*`. */
  parked: boolean;
}

export interface Effects {
  /** The swap after the call. */
  swap: ModelSwap;
  payouts: Payout[];
  /** Funds this call moved into escrow. */
  escrowIn: bigint;
  /** The one counter this transition increments, or `null`. */
  counter: number | null;
  /** `now − t_lock`, added to `response_secs_sum` (approve, fund). */
  responseSecs: bigint | null;
  volume: bigint;
  withheldVolume: bigint;
  /** Change of the maker's `open_pending`: +1, 0 or −1. */
  openPending: -1 | 0 | 1;
  /** A "closed" row with nothing parked: Solana closes the account in the same instruction. */
  closed: boolean;
}

export type ModelErrorName =
  | 'Unauthorized'
  | 'BadState'
  | 'WrongDirection'
  | 'TooEarly'
  | 'TooLate'
  | 'BadSecret'
  | 'EvidenceRequired'
  | 'EvidenceMismatch'
  | 'NothingOwed'
  | 'ApprovalRequired'
  | 'TooManyPending'
  | 'MathOverflow'
  | 'DepositTooHigh'
  | 'ApprovalWindowOutOfRange'
  | 'NoticeWindowOutOfRange'
  | 'DepthInvalid'
  | 'ClaimDelayTooShort'
  | 'ClaimWindowTooShort'
  | 'FinalWindowOutOfRange';

export class ModelError extends Error {
  readonly code: ModelErrorName;
  constructor(code: ModelErrorName) {
    super(code);
    this.name = 'ModelError';
    this.code = code;
  }
  /** The error name on a chain: Solana calls `BadSecret` `ScalarMismatch`. */
  chainName(chain: ChainName): string {
    return this.code === 'BadSecret' && chain === 'solana' ? 'ScalarMismatch' : this.code;
  }
}

const fail = (code: ModelErrorName): never => {
  throw new ModelError(code);
};
const auth = (ok: boolean): void => void (ok || fail('Unauthorized'));
const inState = (ok: boolean): void => void (ok || fail('BadState'));
const gateBefore = (now: bigint, limit: bigint): void => void (now < limit || fail('TooLate'));
const gateFrom = (now: bigint, start: bigint): void => void (now >= start || fail('TooEarly'));
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const has = (s: ModelSwap, flag: number): boolean => (s.flags & flag) !== 0;
const isTaker = (r: Role): boolean => r === 'taker' || r === 'session';

/** `T_nl = t_final − d_c − w_c − 86,400`: the latest notice in direction B. */
export const tNl = (s: ModelSwap): bigint => s.tFinal - BigInt(s.dC) - BigInt(s.wC) - BigInt(DAY_SECS);
/** `T_exp = t_final + EXPIRY_SECS`. */
export const tExp = (s: ModelSwap, c: ChainConsts): bigint => s.tFinal + BigInt(c.expirySecs);
/** `T_hold = t_refund + HOLD_SECS`. */
export const tHold = (s: ModelSwap, c: ChainConsts): bigint => s.tRefund + BigInt(c.holdSecs);
/** `T_split = t_refund + SPLIT_SECS`. */
export const tSplit = (s: ModelSwap, c: ChainConsts): bigint => s.tRefund + BigInt(c.splitSecs);
/** Earliest `set_ready`: `t_N + depth × READY_MIN_SECS_PER_CONF`. */
export const tReadyMin = (s: ModelSwap, c: ChainConsts): bigint => s.tNotice + BigInt(s.depth) * BigInt(c.readyMinSecsPerConf);
/** `Δ_cut = F + d × B + CUT_MARGIN_SECS`. */
export const deltaCut = (depth: number, c: ChainConsts): bigint => BigInt(c.finalitySecs + depth * c.blockAllowanceSecs + c.cutMarginSecs);

/** How a swap opened with these arguments starts: ACTIVE (`none`), or PENDING for approval or for funding. */
export function pendingKind(chain: ChainName, direction: DirectionCode, offerMode: number, approval: boolean): { pending: 'none' | 'approval' | 'funding'; effectiveMode: number } {
  const c = CHAIN_CONSTS[chain];
  // SPEC 3.8: a valid approval on a WINDOW or ADVANCE offer, and a quote, are treated as AUTO.
  const effectiveMode = offerMode === 3 ? 3 : offerMode === 0 ? 0 : approval ? 2 : offerMode;
  const window = effectiveMode === 1;
  const pending = c.explicitApprove || window ? 'approval' : direction === 0 ? 'none' : 'funding';
  return { pending, effectiveMode };
}

/**
 * Apply one call. `swap` is `NO_SWAP` for `lock` and `take`. Returns the effects or throws a
 * `ModelError`. Check order: direction, caller, state and open hash, time gate, then secret or
 * evidence.
 */
export function apply(chain: ChainName, swap: ModelSwap, call: Call, caller: Role, now: bigint, env: Env = ENV_OK): Effects {
  const c = CHAIN_CONSTS[chain];
  const s = swap;
  const n: ModelSwap = { ...s };
  const payouts: Payout[] = [];
  const fx: Effects = { swap: n, payouts, escrowIn: 0n, counter: null, responseSecs: null, volume: 0n, withheldVolume: 0n, openPending: 0, closed: false };
  const isA = s.direction === 0;
  // The locker escrows the chain asset and can refund it; the claimer locks XMR and can claim.
  const locker = (r: Role) => (isA ? isTaker(r) : r === 'operator');
  const claimer = (r: Role) => (isA ? r === 'operator' : isTaker(r));
  const can = (p: Party) => (p === 'taker' ? env.takerCanReceive : p === 'maker' ? env.makerCanReceive : env.treasuryCanReceive);
  const park = (to: Party, amount: bigint) => {
    if (amount === 0n) return;
    if (to === 'taker') n.owedTaker += amount;
    else if (to === 'maker') n.owedMaker += amount;
    else n.owedTreasury += amount;
    payouts.push({ to, amount, parked: true });
  };
  const pay = (to: Party, amount: bigint) => {
    if (amount === 0n) return;
    if (!can(to)) park(to, amount);
    else payouts.push({ to, amount, parked: false });
  };
  const settle = (counter: number) => {
    n.state = SWAP_STATE.DONE;
    n.outcome = counter;
    n.tSettled = now;
    fx.counter = counter;
  };
  const close = (counter: number) => {
    settle(counter);
    fx.closed = !payouts.some((p) => p.parked);
  };

  if (call.name === 'lock' || call.name === 'take') {
    const a = call.args;
    const direction: DirectionCode = call.name === 'lock' ? 0 : 1;
    inState(s.state === SWAP_STATE.NONE);
    auth(caller === 'taker');
    if (a.offerMode > 3 || a.offerMode < 0) fail('BadState');
    if (a.offerMode === 2 && !a.approval) fail('ApprovalRequired');
    const { pending, effectiveMode } = pendingKind(chain, direction, a.offerMode, a.approval);
    const d = deadlines({ chain, pending, wA: a.wA, wN: a.wN, dC: a.dC, wC: a.wC, wF: a.wF, depth: a.depth, depBps: a.depBps, tLock: now });
    if (d.boundError) fail(d.boundError as ModelErrorName);
    if (a.amount > MAX_AMOUNT[chain]) fail('MathOverflow');
    if (pending !== 'none' && env.openPending >= c.maxOpenPending) fail('TooManyPending');
    n.direction = direction;
    n.mode = effectiveMode;
    n.outcome = COUNTER_NONE;
    n.depth = a.depth;
    n.amount = a.amount;
    n.deposit = depositOf(a.amount, a.depBps);
    n.feeBps = c.feeBps;
    n.wN = a.wN;
    n.dC = a.dC;
    n.wC = a.wC;
    n.tLock = now;
    n.tFinal = now + BigInt(a.wF);
    if (pending === 'none') {
      n.state = SWAP_STATE.ACTIVE;
      n.tActive = now;
      n.tNoteDeadline = now + BigInt(a.wN);
    } else {
      n.state = SWAP_STATE.PENDING;
      n.tPendingDeadline = now + BigInt(d.wP);
      fx.openPending = 1;
    }
    if (direction === 0) {
      fx.escrowIn = a.amount;
      fx.counter = COUNTER.locks;
    } else {
      fx.escrowIn = n.deposit;
      fx.counter = COUNTER.takes;
    }
    return fx;
  }

  inState(s.state !== SWAP_STATE.NONE);
  const texp = tExp(s, c);
  // What a pending exit returns to the taker.
  const pendingStake = isA ? s.amount : s.deposit;
  const S = SWAP_STATE;

  switch (call.name) {
    case 'approve':
    case 'fund': {
      if (call.name === 'approve' ? !isA : isA) fail('WrongDirection');
      auth(caller === 'operator');
      inState(s.state === S.PENDING && call.openOk !== false);
      gateBefore(now, s.tPendingDeadline);
      n.state = S.ACTIVE;
      n.tActive = now;
      n.tNoteDeadline = now + BigInt(s.wN);
      if (call.name === 'fund') fx.escrowIn = s.amount;
      fx.counter = COUNTER.approvals;
      fx.responseSecs = now - s.tLock;
      fx.openPending = -1;
      break;
    }
    case 'reject': {
      auth(caller === 'operator');
      inState(s.state === S.PENDING && call.openOk !== false);
      // B3: window mode only; always available under EXPLICIT_APPROVE.
      inState(isA || s.mode === 1 || c.explicitApprove);
      pay('taker', pendingStake);
      close(call.reason === 0 ? COUNTER.rejections : COUNTER.rejections_no_fault);
      fx.openPending = -1;
      break;
    }
    case 'cancel_pending': {
      auth(isTaker(caller));
      inState(s.state === S.PENDING);
      pay('taker', pendingStake);
      close(COUNTER.pending_cancels);
      fx.openPending = -1;
      break;
    }
    case 'expire_pending': {
      inState(s.state === S.PENDING);
      gateFrom(now, s.tPendingDeadline);
      pay('taker', pendingStake);
      // A lapsed take outside window mode is the maker's fault where there is no explicit approval step.
      const fault = !isA && s.mode !== 1 && c.lapseIsFault;
      close(fault ? COUNTER.missed_funds : COUNTER.approval_timeouts);
      fx.openPending = -1;
      break;
    }
    case 'post_notice': {
      auth(claimer(caller));
      inState(s.state === S.ACTIVE);
      if (isA) gateBefore(now, min(s.tNoteDeadline, s.tFinal));
      else {
        // A late notice is still accepted until T_nl.
        gateBefore(now, min(tNl(s), s.tFinal));
        if (now >= s.tNoteDeadline) n.flags |= SWAP_FLAG.LATE_NOTICE;
      }
      n.state = S.NOTICED;
      n.flags |= SWAP_FLAG.NOTICE;
      n.tNotice = now;
      n.tCut = now + deltaCut(s.depth, c);
      n.tClaimOpen = now + BigInt(s.dC);
      fx.counter = COUNTER.notices;
      break;
    }
    case 'set_ready': {
      auth(locker(caller));
      inState(s.state === S.NOTICED);
      gateFrom(now, tReadyMin(s, c));
      gateBefore(now, min(s.tClaimOpen, s.tFinal));
      n.state = S.READY;
      n.tReady = now;
      n.tClaimDeadline = now + BigInt(s.wC);
      fx.counter = COUNTER.readies;
      break;
    }
    case 'abort': {
      auth(claimer(caller));
      if (isA) {
        if (s.state === S.ACTIVE) {
          gateBefore(now, min(s.tNoteDeadline, s.tFinal));
          pay('taker', s.amount);
          close(COUNTER.aborts_pre_notice);
        } else if (s.state === S.NOTICED) {
          gateBefore(now, s.tFinal);
          if (now < s.tClaimOpen) {
            n.state = S.ABORTED_FREE;
            fx.counter = COUNTER.aborts_early;
          } else {
            n.state = S.ABORTED_HOLD;
            fx.counter = COUNTER.aborts_late;
          }
        } else if (s.state === S.READY) {
          gateBefore(now, s.tFinal);
          n.state = S.ABORTED_FREE;
          fx.counter = COUNTER.missed_claims;
        } else fail('BadState');
      } else {
        inState(s.state === S.NOTICED || s.state === S.READY);
        gateBefore(now, s.tFinal);
        n.state = S.ABORTED_HOLD;
        fx.counter = COUNTER.taker_aborts;
      }
      break;
    }
    case 'refund_unnoticed': {
      if (!isA) fail('WrongDirection');
      inState(s.state === S.ACTIVE);
      gateFrom(now, s.tNoteDeadline);
      pay('taker', s.amount);
      close(COUNTER.missed_notices);
      break;
    }
    case 'expire_unnoticed': {
      if (isA) fail('WrongDirection');
      inState(s.state === S.ACTIVE);
      gateFrom(now, texp);
      pay('taker', s.deposit);
      // The maker's escrow is parked, never pushed: nobody with authority over it is present.
      park('maker', s.amount);
      settle(COUNTER.expired_refunds);
      break;
    }
    case 'refund': {
      auth(c.openSecretCalls || locker(caller));
      const row = refundRow(s, now, texp);
      if (call.secretOk === false) fail('BadSecret');
      n.flags |= SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER;
      n.tRefund = now;
      const held = row.held && s.deposit > 0n;
      if (isA) pay('taker', held ? s.amount - s.deposit : s.amount); // D is part of amount
      else {
        pay('maker', s.amount);
        if (!held) pay('taker', s.deposit);
      }
      if (held) {
        n.state = S.HOLD;
        n.depositState = DEPOSIT_STATE.HELD;
        fx.counter = row.counter;
      } else settle(row.counter);
      break;
    }
    case 'claim': {
      auth(c.openSecretCalls || claimer(caller));
      const counter = claimRow(s, now, texp);
      if (call.secretOk === false) fail('BadSecret');
      const fee = feeOf(s.amount, s.feeBps);
      n.flags |= SWAP_FLAG.REVEALED;
      if (isA) pay('maker', s.amount - fee);
      else pay('taker', s.amount - fee + s.deposit);
      pay('treasury', fee);
      fx.volume = s.amount;
      settle(counter);
      break;
    }
    case 'release_deposit': {
      if (s.state === S.HOLD) {
        if (caller !== 'operator') gateFrom(now, tHold(s, c));
        pay('taker', s.deposit);
        n.depositState = DEPOSIT_STATE.RETURNED;
        settle(COUNTER.deposits_returned);
      } else if (s.state === S.WITHHELD) {
        auth(caller === 'operator');
        pay('taker', s.deposit);
        n.depositState = DEPOSIT_STATE.RELEASED;
        settle(COUNTER.releases);
      } else fail('BadState');
      break;
    }
    case 'withhold': {
      auth(caller === 'operator');
      inState(s.state === S.HOLD);
      // Refused at or after T_hold even if nobody has cranked release_deposit.
      gateBefore(now, tHold(s, c));
      if (isA && has(s, SWAP_FLAG.NOTICE)) {
        const ev = call.evidence ?? 'opens';
        if (ev === 'absent') fail('EvidenceRequired');
        if (ev === 'mismatch') fail('EvidenceMismatch');
        n.flags |= SWAP_FLAG.EVIDENCE;
      }
      n.state = S.WITHHELD;
      n.depositState = DEPOSIT_STATE.WITHHELD;
      fx.counter = COUNTER.withholds;
      fx.withheldVolume = s.deposit;
      break;
    }
    case 'split_deposit': {
      inState(s.state === S.WITHHELD);
      gateFrom(now, tSplit(s, c));
      const { toTaker, toTreasury } = splitOf(s.deposit);
      pay('taker', toTaker);
      pay('treasury', toTreasury);
      n.depositState = DEPOSIT_STATE.SPLIT;
      settle(COUNTER.splits);
      break;
    }
    case 'publish_evidence': {
      auth(claimer(caller));
      // "NOTICED or later, any state including DONE": a notice is on record.
      inState(has(s, SWAP_FLAG.NOTICE));
      if (call.opens === false) fail('EvidenceMismatch');
      n.flags |= SWAP_FLAG.EVIDENCE;
      break;
    }
    case 'withdraw_owed': {
      const who = call.who;
      const ok = who === 'taker' ? caller === 'taker' : who === 'maker' ? caller === 'owner' : true;
      const owed = who === 'taker' ? s.owedTaker : who === 'maker' ? s.owedMaker : s.owedTreasury;
      auth(ok);
      if (owed === 0n) fail('NothingOwed');
      if (who === 'taker') n.owedTaker = 0n;
      else if (who === 'maker') n.owedMaker = 0n;
      else n.owedTreasury = 0n;
      payouts.push({ to: who, amount: owed, parked: false });
      break;
    }
  }
  return fx;
}

/** Which refund row applies (A10a-g, B9a-h): whether the deposit is held and which counter moves. Throws when no row is open. */
function refundRow(s: ModelSwap, now: bigint, texp: bigint): { held: boolean; counter: number } {
  const S = SWAP_STATE;
  const C = COUNTER;
  const expiry = (): { held: boolean; counter: number } => {
    // Between the end of the last pre-expiry window and T_exp a refund is TooLate.
    if (now < texp) fail('TooLate');
    return { held: false, counter: C.expired_refunds }; // A10f, B9g
  };
  if (s.direction === 0) {
    switch (s.state) {
      case S.ACTIVE: // a keyed refund is valid in ACTIVE at every instant
        return now < s.tNoteDeadline ? { held: true, counter: C.taker_cancels_approved } : { held: false, counter: C.missed_notices }; // A10a, A10g
      case S.NOTICED:
        return now < min(s.tClaimOpen, s.tFinal) ? { held: true, counter: C.taker_refunds_noticed } : expiry(); // A10b
      case S.READY:
        if (now < s.tClaimDeadline) fail('TooEarly');
        return now < s.tFinal ? { held: false, counter: C.missed_claims } : expiry(); // A10e
      case S.ABORTED_HOLD:
        return now < s.tFinal ? { held: true, counter: C.refunds_after_abort } : expiry(); // A10c
      case S.ABORTED_FREE:
        return now < s.tFinal ? { held: false, counter: C.refunds_after_abort } : expiry(); // A10d
      default:
        return fail('BadState');
    }
  }
  switch (s.state) {
    case S.ACTIVE:
      return now < s.tNoteDeadline ? { held: false, counter: C.backouts_pre_notice } : { held: true, counter: C.taker_no_notice }; // B9a, B9b
    case S.NOTICED:
      if (now < min(s.tCut, s.tFinal)) return has(s, SWAP_FLAG.LATE_NOTICE) ? { held: true, counter: C.taker_no_notice } : { held: false, counter: C.backouts_post_notice }; // B9h, B9c
      return now < min(s.tClaimOpen, s.tFinal) ? { held: true, counter: C.refunds_unconfirmed } : expiry(); // B9d
    case S.READY:
      if (now < s.tClaimDeadline) fail('TooEarly');
      return now < s.tFinal ? { held: true, counter: C.taker_missed_claims } : expiry(); // B9e
    case S.ABORTED_HOLD:
      return now < s.tFinal ? { held: true, counter: C.refunds_after_abort } : expiry(); // B9f
    default:
      return fail('BadState');
  }
}

/** Which claim row applies (A11a-c, B10a-c): the counter. Throws when no row is open. */
function claimRow(s: ModelSwap, now: bigint, texp: bigint): number {
  const S = SWAP_STATE;
  const C = COUNTER;
  const afterFinal = (): number => {
    // [T_final, T_exp): the claimer may claim in any post-notice state.
    gateBefore(now, texp);
    return C.claims_after_final; // A11c, B10c
  };
  switch (s.state) {
    case S.READY:
      if (now < min(s.tClaimDeadline, s.tFinal)) return C.completed; // A11a, B10a
      if (now < s.tFinal) fail('TooLate');
      return afterFinal();
    case S.NOTICED:
      if (now < s.tClaimOpen) fail('TooEarly');
      if (now < s.tFinal) return s.direction === 0 ? C.claims_without_ready : C.taker_claims_without_ready; // A11b, B10b
      return afterFinal();
    case S.ABORTED_FREE:
    case S.ABORTED_HOLD:
      if (now < s.tFinal) fail('TooEarly');
      return afterFinal();
    default:
      return fail('BadState');
  }
}

/** Whether a call would succeed with every destination able to receive. */
export function enabled(chain: ChainName, swap: ModelSwap, call: Call, caller: Role, now: bigint): boolean {
  return errorOf(chain, swap, call, caller, now) === null;
}
/** The model's refusal for a call, or `null` when it is accepted. */
export function errorOf(chain: ChainName, swap: ModelSwap, call: Call, caller: Role, now: bigint, env: Env = ENV_OK): ModelErrorName | null {
  try {
    apply(chain, swap, call, caller, now, env);
    return null;
  } catch (e) {
    if (e instanceof ModelError) return e.code;
    throw e;
  }
}

/** A maker's counters and totals (SPEC 3.7). Every update saturates and can never fail. */
export interface MakerRecord {
  counters: number[];
  responseSecsSum: bigint;
  volume: bigint;
  withheldVolume: bigint;
  openPending: number;
}
export const newMakerRecord = (): MakerRecord => ({ counters: new Array<number>(COUNTER_SLOTS).fill(0), responseSecsSum: 0n, volume: 0n, withheldVolume: 0n, openPending: 0 });

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
/** Record a transition in a maker record, saturating as the contracts do. */
export function recordEffects(chain: ChainName, m: MakerRecord, fx: Effects): MakerRecord {
  const counters = m.counters.slice();
  if (fx.counter !== null) counters[fx.counter] = Math.min(U32_MAX, (counters[fx.counter] ?? 0) + 1);
  const cap = MAX_AMOUNT[chain];
  return {
    counters,
    responseSecsSum: fx.responseSecs === null ? m.responseSecsSum : min(U64_MAX, m.responseSecsSum + fx.responseSecs),
    volume: min(cap, m.volume + fx.volume),
    withheldVolume: min(cap, m.withheldVolume + fx.withheldVolume),
    openPending: Math.max(0, Math.min(0xffff, m.openPending + fx.openPending)),
  };
}
