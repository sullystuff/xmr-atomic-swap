/**
 * The state machine of SPEC section 3, as the flows and the UIs see it. The machine itself is
 * the reference model of `crates/swap-core`, reached through `@xmrswap/core-wasm`
 * (`modelApply`): there is one implementation, and the two contracts replay the same vectors
 * against it. This module only translates between the SDK's shapes (camelCase, `bigint`) and
 * the model's (the field names of `transitions.json`), and derives the deadlines that are plain
 * sums of stored fields.
 */
import { CoreError, type ModelCall as CoreCall, type ModelEffects as CoreEffects, type ModelSwap as CoreSwap, modelApply } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type ChainConsts, type ChainName, COUNTER_NONE, COUNTER_SLOTS, DAY_SECS, PICONERO_PER_XMR, SWAP_STATE, SWAP_STATE_NAMES } from '@xmrswap/protocol';

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
  /** The escrowed amount (A: paid by the taker now; B: funded by the maker later). Zero is refused. */
  amount: bigint;
  /** The swap's size in piconero. Zero is refused (`AmountOutOfRange`). Defaults to 1 XMR when a caller only models the escrow. */
  xmr?: bigint;
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
  | 'AmountOutOfRange'
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

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

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

// ------------------------------------------------------------------ translation to and from the core's model

function toCore(s: ModelSwap): CoreSwap | null {
  if (s.state === SWAP_STATE.NONE) return null;
  return {
    state: SWAP_STATE_NAMES[s.state] as CoreSwap['state'],
    state_code: s.state,
    direction: s.direction === 0 ? 'A' : 'B',
    mode: s.mode,
    outcome: s.outcome,
    deposit_state: s.depositState,
    depth: s.depth,
    flags: s.flags,
    amount: s.amount.toString(),
    deposit: s.deposit.toString(),
    fee_bps: s.feeBps,
    w_n: s.wN,
    d_c: s.dC,
    w_c: s.wC,
    t_lock: Number(s.tLock),
    t_pending_deadline: Number(s.tPendingDeadline),
    t_active: Number(s.tActive),
    t_note_deadline: Number(s.tNoteDeadline),
    t_notice: Number(s.tNotice),
    t_cut: Number(s.tCut),
    t_claim_open: Number(s.tClaimOpen),
    t_ready: Number(s.tReady),
    t_claim_deadline: Number(s.tClaimDeadline),
    t_final: Number(s.tFinal),
    t_refund: Number(s.tRefund),
    t_settled: Number(s.tSettled),
    owed_taker: s.owedTaker.toString(),
    owed_maker: s.owedMaker.toString(),
    owed_treasury: s.owedTreasury.toString(),
  };
}

function fromCore(j: CoreSwap): ModelSwap {
  return {
    state: j.state_code,
    direction: j.direction === 'A' ? 0 : 1,
    mode: j.mode,
    outcome: j.outcome,
    depositState: j.deposit_state,
    depth: j.depth,
    flags: j.flags,
    amount: BigInt(j.amount),
    deposit: BigInt(j.deposit),
    feeBps: j.fee_bps,
    wN: j.w_n,
    dC: j.d_c,
    wC: j.w_c,
    tLock: BigInt(j.t_lock),
    tPendingDeadline: BigInt(j.t_pending_deadline),
    tActive: BigInt(j.t_active),
    tNoteDeadline: BigInt(j.t_note_deadline),
    tNotice: BigInt(j.t_notice),
    tCut: BigInt(j.t_cut),
    tClaimOpen: BigInt(j.t_claim_open),
    tReady: BigInt(j.t_ready),
    tClaimDeadline: BigInt(j.t_claim_deadline),
    tFinal: BigInt(j.t_final),
    tRefund: BigInt(j.t_refund),
    tSettled: BigInt(j.t_settled),
    owedTaker: BigInt(j.owed_taker),
    owedMaker: BigInt(j.owed_maker),
    owedTreasury: BigInt(j.owed_treasury),
  };
}

function callToCore(call: Call): CoreCall {
  switch (call.name) {
    case 'lock':
    case 'take': {
      const a = call.args;
      return {
        call: call.name,
        args: { direction: call.name === 'lock' ? 'A' : 'B', offer_mode: a.offerMode, approval: a.approval, xmr: (a.xmr ?? PICONERO_PER_XMR).toString(), amount: a.amount.toString(), w_a: a.wA, w_n: a.wN, d_c: a.dC, w_c: a.wC, w_f: a.wF, depth: a.depth, dep_bps: a.depBps },
      };
    }
    case 'approve':
    case 'fund':
      return { call: call.name, args: { open_ok: call.openOk !== false } };
    case 'reject':
      return { call: 'reject', args: { open_ok: call.openOk !== false, reason: call.reason } };
    case 'refund':
    case 'claim':
      return { call: call.name, args: { secret_ok: call.secretOk !== false } };
    case 'withhold':
      return { call: 'withhold', args: { evidence: call.evidence ?? 'opens' } };
    case 'publish_evidence':
      return { call: 'publish_evidence', args: { opens: call.opens !== false } };
    case 'withdraw_owed':
      return { call: 'withdraw_owed', args: { who: call.who } };
    default:
      return { call: call.name };
  }
}

/** The model's own error name for a chain's (Solana calls `BadSecret` `ScalarMismatch`). */
const modelName = (code: string): ModelErrorName => (code === 'ScalarMismatch' ? 'BadSecret' : (code as ModelErrorName));

/**
 * Apply one call. `swap` is `NO_SWAP` for `lock` and `take`. Returns the effects or throws a
 * `ModelError`. This is the reference model of the core: check order, error names and every
 * amount are the ones the contracts are tested against.
 */
export function apply(chain: ChainName, swap: ModelSwap, call: Call, caller: Role, now: bigint, env: Env = ENV_OK): Effects {
  let fx: CoreEffects;
  try {
    fx = modelApply(chain, toCore(swap), callToCore(call), caller, now, { taker_can_receive: env.takerCanReceive, maker_can_receive: env.makerCanReceive, treasury_can_receive: env.treasuryCanReceive, open_pending: env.openPending });
  } catch (e) {
    if (e instanceof CoreError) throw new ModelError(modelName(e.code));
    throw e;
  }
  return {
    swap: fromCore(fx.swap),
    payouts: fx.payouts.map((p) => ({ to: p.to, amount: BigInt(p.amount), parked: p.parked })),
    escrowIn: BigInt(fx.escrow_in),
    counter: fx.counter,
    responseSecs: fx.response_secs === null ? null : BigInt(fx.response_secs),
    volume: BigInt(fx.volume),
    withheldVolume: BigInt(fx.withheld_volume),
    openPending: fx.open_pending as -1 | 0 | 1,
    closed: fx.closed,
  };
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
