//! The pure reference model of the state machine of SPEC section 3.
//!
//! One escrow machine serves both directions and both chains. This module has no I/O and no
//! cryptography: a secret is modelled as "it opens the commitment or it does not", evidence as
//! "it opens the notice commitment or it does not", and the open hash of SPEC 3.12 as "it
//! matches or it does not". The Solana program and the Ethereum contract MUST behave exactly as
//! [`apply`] does; `transitions.json` is generated from it.
//!
//! Conventions fixed here because the specification leaves them open (also recorded in
//! `docs/research/wp1-deviations.md`):
//!
//! * **Check order**: direction, caller, state, open hash, time gate, then secret or evidence.
//! * **`TooEarly` or `TooLate`**: when a call is refused only because of the time, it is
//!   `TooLate` if some window of that call in that state has already closed, else `TooEarly`.
//! * **"Closed" rows** (A3, A4, A5, A7a, A8, B2, B3, B4) end in `Done` with
//!   [`Effects::closed`] set when nothing was parked. Solana then closes the account in the same
//!   instruction; Ethereum never deletes a swap.
//! * A payout of zero is not a payout: it is neither paid nor parked and does not appear.

use crate::amounts::{
  check_bounds, delta_cut, deposit_of, fee_of, pending_window, split_of, BoundError, ChainConsts, Pending, SwapParams,
  DAY_SECS,
};

/// Swap state (SPEC 3.3). Value 0 means "no such swap".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum State {
  None = 0,
  Pending = 1,
  Active = 2,
  Noticed = 3,
  Ready = 4,
  AbortedFree = 5,
  AbortedHold = 6,
  Hold = 7,
  Withheld = 8,
  Done = 9,
}
impl State {
  pub fn name(self) -> &'static str {
    match self {
      State::None => "NONE",
      State::Pending => "PENDING",
      State::Active => "ACTIVE",
      State::Noticed => "NOTICED",
      State::Ready => "READY",
      State::AbortedFree => "ABORTED_FREE",
      State::AbortedHold => "ABORTED_HOLD",
      State::Hold => "HOLD",
      State::Withheld => "WITHHELD",
      State::Done => "DONE",
    }
  }
}

/// Direction A: the taker pays the chain asset and receives XMR (locker = taker, claimer =
/// maker). Direction B: the taker pays XMR (locker = maker, claimer = taker).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Direction {
  A = 0,
  B = 1,
}

/// Who signs a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
  /// The taker's wallet.
  TakerWallet,
  /// The per-swap session key named at lock (SPEC 3.9).
  Session,
  /// The maker's hot key.
  Operator,
  /// The maker's cold key (Solana `withdraw_owed(1)`). On Ethereum: the maker-side account a
  /// payout was parked for.
  Owner,
  /// No authority: a stranger paying the fee.
  Anyone,
}
impl Role {
  pub fn name(self) -> &'static str {
    match self {
      Role::TakerWallet => "taker",
      Role::Session => "session",
      Role::Operator => "operator",
      Role::Owner => "owner",
      Role::Anyone => "anyone",
    }
  }
  fn is_taker(self) -> bool {
    matches!(self, Role::TakerWallet | Role::Session)
  }
}

/// A payout destination. The contracts fix the address behind each: the taker stored at lock;
/// the maker's payout address (claim in A) or operator (refund in B); the treasury.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Party {
  Taker,
  Maker,
  Treasury,
}
impl Party {
  pub fn name(self) -> &'static str {
    match self {
      Party::Taker => "taker",
      Party::Maker => "maker",
      Party::Treasury => "treasury",
    }
  }
}

/// Counter ids (SPEC 3.7). They are also the `outcome` codes.
pub mod counter {
  pub const LOCKS: u8 = 0;
  pub const TAKES: u8 = 1;
  pub const APPROVALS: u8 = 2;
  pub const REJECTIONS: u8 = 3;
  pub const APPROVAL_TIMEOUTS: u8 = 4;
  pub const PENDING_CANCELS: u8 = 5;
  pub const NOTICES: u8 = 6;
  pub const READIES: u8 = 7;
  pub const COMPLETED: u8 = 8;
  pub const CLAIMS_WITHOUT_READY: u8 = 9;
  pub const CLAIMS_AFTER_FINAL: u8 = 10;
  pub const MISSED_NOTICES: u8 = 11;
  pub const MISSED_CLAIMS: u8 = 12;
  pub const MISSED_FUNDS: u8 = 13;
  pub const ABORTS_PRE_NOTICE: u8 = 14;
  pub const ABORTS_EARLY: u8 = 15;
  pub const ABORTS_LATE: u8 = 16;
  pub const BACKOUTS_PRE_NOTICE: u8 = 17;
  pub const BACKOUTS_POST_NOTICE: u8 = 18;
  pub const TAKER_CLAIMS_WITHOUT_READY: u8 = 19;
  pub const TAKER_CANCELS_APPROVED: u8 = 20;
  pub const TAKER_REFUNDS_NOTICED: u8 = 21;
  pub const REFUNDS_AFTER_ABORT: u8 = 22;
  pub const TAKER_NO_NOTICE: u8 = 23;
  pub const REFUNDS_UNCONFIRMED: u8 = 24;
  pub const TAKER_MISSED_CLAIMS: u8 = 25;
  pub const TAKER_ABORTS: u8 = 26;
  pub const EXPIRED_REFUNDS: u8 = 27;
  pub const DEPOSITS_RETURNED: u8 = 28;
  pub const WITHHOLDS: u8 = 29;
  pub const RELEASES: u8 = 30;
  pub const SPLITS: u8 = 31;
  pub const REJECTIONS_NO_FAULT: u8 = 32;
  /// Number of counter slots; ids 33 to 39 are reserved.
  pub const COUNT: usize = 40;
  /// `outcome` while the swap is open, and the counter byte of a transition that moves none.
  pub const NONE: u8 = 0xff;

  pub const NAMES: [&str; 33] = [
    "locks",
    "takes",
    "approvals",
    "rejections",
    "approval_timeouts",
    "pending_cancels",
    "notices",
    "readies",
    "completed",
    "claims_without_ready",
    "claims_after_final",
    "missed_notices",
    "missed_claims",
    "missed_funds",
    "aborts_pre_notice",
    "aborts_early",
    "aborts_late",
    "backouts_pre_notice",
    "backouts_post_notice",
    "taker_claims_without_ready",
    "taker_cancels_approved",
    "taker_refunds_noticed",
    "refunds_after_abort",
    "taker_no_notice",
    "refunds_unconfirmed",
    "taker_missed_claims",
    "taker_aborts",
    "expired_refunds",
    "deposits_returned",
    "withholds",
    "releases",
    "splits",
    "rejections_no_fault",
  ];
}

/// Bits of `Swap.flags`.
pub mod flag {
  pub const NOTICE: u8 = 1 << 0;
  pub const EVIDENCE: u8 = 1 << 1;
  pub const REVEALED: u8 = 1 << 2;
  pub const REVEALER_LOCKER: u8 = 1 << 3;
  pub const LATE_NOTICE: u8 = 1 << 4;
}

/// Values of `Swap.deposit_state`.
pub mod deposit_state {
  pub const NONE: u8 = 0;
  pub const HELD: u8 = 1;
  pub const WITHHELD: u8 = 2;
  pub const RETURNED: u8 = 3;
  pub const RELEASED: u8 = 4;
  pub const SPLIT: u8 = 5;
}

/// Offer or quote modes, and the effective mode stored in the swap.
pub mod mode {
  pub const AUTO: u8 = 0;
  pub const WINDOW: u8 = 1;
  pub const ADVANCE: u8 = 2;
  pub const QUOTE: u8 = 3;
}

/// The model's view of a swap: every field of the on-chain record that a transition reads or
/// writes. Amounts are `u128` (Solana stores `u64`, Ethereum `uint256`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapState {
  pub state: State,
  pub direction: Direction,
  /// Effective mode: 0 auto, 1 window, 2 advance, 3 quote.
  pub mode: u8,
  /// Counter id of the transition that settled the swap; `0xff` while open.
  pub outcome: u8,
  pub deposit_state: u8,
  pub depth: u8,
  pub flags: u8,
  pub amount: u128,
  /// `D` (A: part of `amount`) or the take deposit `Dp` (B: posted separately).
  pub deposit: u128,
  pub fee_bps: u16,
  pub w_n: u32,
  pub d_c: u32,
  pub w_c: u32,
  pub t_lock: i64,
  pub t_pending_deadline: i64,
  pub t_active: i64,
  pub t_note_deadline: i64,
  pub t_notice: i64,
  pub t_cut: i64,
  pub t_claim_open: i64,
  pub t_ready: i64,
  pub t_claim_deadline: i64,
  pub t_final: i64,
  pub t_refund: i64,
  pub t_settled: i64,
  pub owed_taker: u128,
  pub owed_maker: u128,
  pub owed_treasury: u128,
}

impl SwapState {
  /// "No such swap": the state passed to [`Call::Open`].
  pub const NONE: SwapState = SwapState {
    state: State::None,
    direction: Direction::A,
    mode: 0,
    outcome: counter::NONE,
    deposit_state: 0,
    depth: 0,
    flags: 0,
    amount: 0,
    deposit: 0,
    fee_bps: 0,
    w_n: 0,
    d_c: 0,
    w_c: 0,
    t_lock: 0,
    t_pending_deadline: 0,
    t_active: 0,
    t_note_deadline: 0,
    t_notice: 0,
    t_cut: 0,
    t_claim_open: 0,
    t_ready: 0,
    t_claim_deadline: 0,
    t_final: 0,
    t_refund: 0,
    t_settled: 0,
    owed_taker: 0,
    owed_maker: 0,
    owed_treasury: 0,
  };

  /// `T_nl = t_final − d_c − w_c − 86,400`.
  pub fn t_nl(&self) -> i64 {
    self.t_final - self.d_c as i64 - self.w_c as i64 - DAY_SECS
  }
  /// `T_exp = t_final + EXPIRY_SECS`.
  pub fn t_exp(&self, c: &ChainConsts) -> i64 {
    self.t_final + c.expiry_secs
  }
  /// `T_hold = t_refund + HOLD_SECS`.
  pub fn t_hold(&self, c: &ChainConsts) -> i64 {
    self.t_refund + c.hold_secs
  }
  /// `T_split = t_refund + SPLIT_SECS`.
  pub fn t_split(&self, c: &ChainConsts) -> i64 {
    self.t_refund + c.split_secs
  }
  /// Earliest `set_ready`: `t_N + depth × READY_MIN_SECS_PER_CONF`.
  pub fn t_ready_min(&self, c: &ChainConsts) -> i64 {
    self.t_notice + self.depth as i64 * c.ready_min_secs_per_conf
  }
  pub fn has(&self, flag: u8) -> bool {
    self.flags & flag != 0
  }
}

/// Arguments of `lock` (A1) and `take` (B1) that the machine depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenArgs {
  pub direction: Direction,
  /// Mode of the offer or quote: 0 AUTO, 1 WINDOW, 2 ADVANCE, 3 taker-bound quote.
  pub offer_mode: u8,
  /// A valid advance approval is presented.
  pub approval: bool,
  /// The escrowed amount (A: paid by the taker now; B: funded by the maker later).
  pub amount: u128,
  pub params: SwapParams,
}

/// The `reason` byte of `reject` (SPEC 3.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RejectReason {
  /// The maker's choice: counts as `rejections`.
  MakerChoice = 0,
  /// Unusable taker input: `rejections_no_fault`.
  UnusableInput = 1,
  /// The named pool leaf was consumed by another swap: `rejections_no_fault`.
  LeafConsumed = 2,
}

/// The evidence argument of `withhold`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
  /// Solana: `None`. Ethereum: zeros.
  Absent,
  /// `(txid, v)` that opens the notice commitment.
  Opens,
  /// `(txid, v)` that does not open it.
  Mismatch,
}

/// A call into the machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Call {
  /// `lock` (A1) or `take` (B1).
  Open(OpenArgs),
  /// A2. `open_ok`: `expected_open` equals the swap's open hash (SPEC 3.12).
  Approve { open_ok: bool },
  /// B5.
  Fund { open_ok: bool },
  /// A3, B3.
  Reject { open_ok: bool, reason: RejectReason },
  /// A4, B2.
  CancelPending,
  /// A5, B4.
  ExpirePending,
  /// A6, B6.
  PostNotice,
  /// A9, B7.
  SetReady,
  /// A7a-d, B8.
  Abort,
  /// A8.
  RefundUnnoticed,
  /// B11.
  ExpireUnnoticed,
  /// A10a-g, B9a-h. `secret_ok`: the scalar opens the locker's commitment.
  Refund { secret_ok: bool },
  /// A11a-c, B10a-c. `secret_ok`: the scalar opens the claimer's commitment.
  Claim { secret_ok: bool },
  ReleaseDeposit,
  Withhold(Evidence),
  SplitDeposit,
  /// `opens`: `(txid, v_C)` opens the notice commitment.
  PublishEvidence { opens: bool },
  /// Pull a parked payout.
  WithdrawOwed(Party),
}
impl Call {
  pub fn name(&self) -> &'static str {
    match self {
      Call::Open(a) => match a.direction {
        Direction::A => "lock",
        Direction::B => "take",
      },
      Call::Approve { .. } => "approve",
      Call::Fund { .. } => "fund",
      Call::Reject { .. } => "reject",
      Call::CancelPending => "cancel_pending",
      Call::ExpirePending => "expire_pending",
      Call::PostNotice => "post_notice",
      Call::SetReady => "set_ready",
      Call::Abort => "abort",
      Call::RefundUnnoticed => "refund_unnoticed",
      Call::ExpireUnnoticed => "expire_unnoticed",
      Call::Refund { .. } => "refund",
      Call::Claim { .. } => "claim",
      Call::ReleaseDeposit => "release_deposit",
      Call::Withhold(_) => "withhold",
      Call::SplitDeposit => "split_deposit",
      Call::PublishEvidence { .. } => "publish_evidence",
      Call::WithdrawOwed(_) => "withdraw_owed",
    }
  }
  /// A call whose arguments reveal a spend share.
  pub fn is_secret_bearing(&self) -> bool {
    matches!(self, Call::Refund { .. } | Call::Claim { .. })
  }
}

/// What the model cannot know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Env {
  /// Whether each destination can receive right now (pay-or-park). On Ethereum the treasury
  /// share only increments `treasuryAccrued`, which cannot fail: pass `true`.
  pub taker_can_receive: bool,
  pub maker_can_receive: bool,
  pub treasury_can_receive: bool,
  /// The maker's current `open_pending` count, for `MAX_OPEN_PENDING`.
  pub open_pending: u16,
}
impl Env {
  /// Every destination can receive; no pending swaps.
  pub const OK: Env = Env { taker_can_receive: true, maker_can_receive: true, treasury_can_receive: true, open_pending: 0 };
  fn can(&self, p: Party) -> bool {
    match p {
      Party::Taker => self.taker_can_receive,
      Party::Maker => self.maker_can_receive,
      Party::Treasury => self.treasury_can_receive,
    }
  }
}

/// One payout of a transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payout {
  pub to: Party,
  pub amount: u128,
  /// False: transferred now. True: left in escrow and added to `owed_*`.
  pub parked: bool,
}

/// Everything a successful call does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effects {
  /// The swap after the call, including every `t_*` field and the `owed_*` balances.
  pub state: SwapState,
  pub payouts: Vec<Payout>,
  /// Funds this call moved into escrow (`lock`: `amount`; `take`: the deposit; `fund`: `amount`).
  pub escrow_in: u128,
  /// The one counter this transition increments, if any.
  pub counter: Option<u8>,
  /// `now − t_lock`, added to `response_secs_sum` (approve, fund).
  pub response_secs: Option<u64>,
  /// Added to `volume[asset]` (claims).
  pub volume: u128,
  /// Added to `withheld_volume[asset]` (withhold).
  pub withheld_volume: u128,
  /// Change of the maker's `open_pending`: +1, 0 or −1.
  pub open_pending: i8,
  /// The row is marked "closed" in SPEC 3.4/3.5 and nothing was parked: Solana closes the swap
  /// account in the same instruction.
  pub closed: bool,
}

/// Why a call is refused. Names are the Solana error names; Ethereum's differ only for
/// `BadSecret` (Solana `ScalarMismatch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelError {
  Unauthorized,
  BadState,
  WrongDirection,
  TooEarly,
  TooLate,
  BadSecret,
  EvidenceRequired,
  EvidenceMismatch,
  NothingOwed,
  ApprovalRequired,
  TooManyPending,
  MathOverflow,
  Bound(BoundError),
}
impl ModelError {
  pub fn name(&self) -> &'static str {
    match self {
      ModelError::Unauthorized => "Unauthorized",
      ModelError::BadState => "BadState",
      ModelError::WrongDirection => "WrongDirection",
      ModelError::TooEarly => "TooEarly",
      ModelError::TooLate => "TooLate",
      ModelError::BadSecret => "BadSecret",
      ModelError::EvidenceRequired => "EvidenceRequired",
      ModelError::EvidenceMismatch => "EvidenceMismatch",
      ModelError::NothingOwed => "NothingOwed",
      ModelError::ApprovalRequired => "ApprovalRequired",
      ModelError::TooManyPending => "TooManyPending",
      ModelError::MathOverflow => "MathOverflow",
      ModelError::Bound(b) => match b {
        BoundError::DepositTooHigh => "DepositTooHigh",
        BoundError::ApprovalWindowOutOfRange => "ApprovalWindowOutOfRange",
        BoundError::NoticeWindowOutOfRange => "NoticeWindowOutOfRange",
        BoundError::DepthInvalid => "DepthInvalid",
        BoundError::ClaimDelayTooShort => "ClaimDelayTooShort",
        BoundError::ClaimWindowTooShort => "ClaimWindowTooShort",
        BoundError::FinalWindowOutOfRange => "FinalWindowOutOfRange",
      },
    }
  }
  /// The error name on a chain.
  pub fn chain_name(&self, chain: crate::amounts::Chain) -> &'static str {
    match (self, chain) {
      (ModelError::BadSecret, crate::amounts::Chain::Solana) => "ScalarMismatch",
      _ => self.name(),
    }
  }
}

use ModelError::*;

/// Working copy of a transition.
struct Tx<'a> {
  n: SwapState,
  env: &'a Env,
  now: i64,
  payouts: Vec<Payout>,
  fx: Effects,
}

impl<'a> Tx<'a> {
  fn new(s: SwapState, env: &'a Env, now: i64) -> Self {
    Tx {
      n: s,
      env,
      now,
      payouts: Vec::new(),
      fx: Effects {
        state: s,
        payouts: Vec::new(),
        escrow_in: 0,
        counter: None,
        response_secs: None,
        volume: 0,
        withheld_volume: 0,
        open_pending: 0,
        closed: false,
      },
    }
  }
  /// Pay or park.
  fn pay(&mut self, to: Party, amount: u128) {
    if amount == 0 {
      return;
    }
    let parked = !self.env.can(to);
    if parked {
      self.park(to, amount);
    } else {
      self.payouts.push(Payout { to, amount, parked: false });
    }
  }
  fn park(&mut self, to: Party, amount: u128) {
    if amount == 0 {
      return;
    }
    match to {
      Party::Taker => self.n.owed_taker += amount,
      Party::Maker => self.n.owed_maker += amount,
      Party::Treasury => self.n.owed_treasury += amount,
    }
    self.payouts.push(Payout { to, amount, parked: true });
  }
  fn settle(&mut self, c: u8) {
    self.n.state = State::Done;
    self.n.outcome = c;
    self.n.t_settled = self.now;
    self.fx.counter = Some(c);
  }
  /// A row marked "closed".
  fn close(&mut self, c: u8) {
    self.settle(c);
    self.fx.closed = !self.payouts.iter().any(|p| p.parked);
  }
  fn finish(mut self) -> Effects {
    self.fx.state = self.n;
    self.fx.payouts = self.payouts;
    self.fx
  }
}

fn gate_before(now: i64, limit: i64) -> Result<(), ModelError> {
  if now < limit {
    Ok(())
  } else {
    Err(TooLate)
  }
}
fn gate_from(now: i64, start: i64) -> Result<(), ModelError> {
  if now >= start {
    Ok(())
  } else {
    Err(TooEarly)
  }
}
fn auth(ok: bool) -> Result<(), ModelError> {
  if ok {
    Ok(())
  } else {
    Err(Unauthorized)
  }
}
fn in_state(ok: bool) -> Result<(), ModelError> {
  if ok {
    Ok(())
  } else {
    Err(BadState)
  }
}

/// How a refund treats the deposit.
enum RefundKind {
  /// The deposit stays in escrow (HOLD), unless it is zero.
  Held,
  /// Everything is returned at once.
  Free,
}

/// Apply one call. `state` is [`SwapState::NONE`] for [`Call::Open`].
pub fn apply(
  state: SwapState,
  call: Call,
  caller: Role,
  now: i64,
  env: &Env,
  consts: &ChainConsts,
) -> Result<Effects, ModelError> {
  let s = state;
  let c = consts;
  let mut tx = Tx::new(s, env, now);
  let dir = s.direction;
  let is_a = dir == Direction::A;
  // The locker escrows the chain asset and can refund it; the claimer locks XMR and can claim.
  let locker = |r: Role| if is_a { r.is_taker() } else { r == Role::Operator };
  let claimer = |r: Role| if is_a { r == Role::Operator } else { r.is_taker() };
  let t_exp = s.t_exp(c);

  if let Call::Open(a) = call {
    in_state(s.state == State::None)?;
    auth(caller == Role::TakerWallet)?;
    if a.offer_mode > mode::QUOTE {
      return Err(BadState);
    }
    if a.offer_mode == mode::ADVANCE && !a.approval {
      return Err(ApprovalRequired);
    }
    // SPEC 3.8: a valid approval on a WINDOW or ADVANCE offer, and a quote, are treated as AUTO.
    let effective = match a.offer_mode {
      mode::QUOTE => mode::QUOTE,
      mode::AUTO => mode::AUTO,
      _ if a.approval => mode::ADVANCE,
      m => m,
    };
    let window = effective == mode::WINDOW;
    let pending = match a.direction {
      Direction::A if c.explicit_approve || window => Pending::ApprovalWindow,
      Direction::A => Pending::None,
      Direction::B if c.explicit_approve || window => Pending::ApprovalWindow,
      Direction::B => Pending::FundingWindow,
    };
    check_bounds(&a.params, pending, c).map_err(Bound)?;
    if a.amount > c.max_amount {
      return Err(MathOverflow);
    }
    if pending != Pending::None && env.open_pending >= c.max_open_pending {
      return Err(TooManyPending);
    }
    let p = a.params;
    let n = &mut tx.n;
    n.direction = a.direction;
    n.mode = effective;
    n.outcome = counter::NONE;
    n.depth = p.depth;
    n.amount = a.amount;
    n.deposit = deposit_of(a.amount, p.dep_bps);
    n.fee_bps = c.fee_bps;
    n.w_n = p.w_n;
    n.d_c = p.d_c;
    n.w_c = p.w_c;
    n.t_lock = now;
    n.t_final = now + p.w_f as i64;
    if pending == Pending::None {
      n.state = State::Active;
      n.t_active = now;
      n.t_note_deadline = now + p.w_n as i64;
    } else {
      n.state = State::Pending;
      n.t_pending_deadline = now + pending_window(&p, pending) as i64;
      tx.fx.open_pending = 1;
    }
    match a.direction {
      Direction::A => {
        tx.fx.escrow_in = a.amount;
        tx.fx.counter = Some(counter::LOCKS);
      }
      Direction::B => {
        tx.fx.escrow_in = tx.n.deposit;
        tx.fx.counter = Some(counter::TAKES);
      }
    }
    return Ok(tx.finish());
  }

  in_state(s.state != State::None)?;
  // What a pending exit returns to the taker.
  let pending_stake = if is_a { s.amount } else { s.deposit };

  match call {
    Call::Open(_) => unreachable!(),

    Call::Approve { open_ok } => {
      if !is_a {
        return Err(WrongDirection);
      }
      auth(caller == Role::Operator)?;
      in_state(s.state == State::Pending && open_ok)?;
      gate_before(now, s.t_pending_deadline)?;
      tx.n.state = State::Active;
      tx.n.t_active = now;
      tx.n.t_note_deadline = now + s.w_n as i64;
      tx.fx.counter = Some(counter::APPROVALS);
      tx.fx.response_secs = Some((now - s.t_lock) as u64);
      tx.fx.open_pending = -1;
    }

    Call::Fund { open_ok } => {
      if is_a {
        return Err(WrongDirection);
      }
      auth(caller == Role::Operator)?;
      in_state(s.state == State::Pending && open_ok)?;
      gate_before(now, s.t_pending_deadline)?;
      tx.n.state = State::Active;
      tx.n.t_active = now;
      tx.n.t_note_deadline = now + s.w_n as i64;
      tx.fx.escrow_in = s.amount;
      tx.fx.counter = Some(counter::APPROVALS);
      tx.fx.response_secs = Some((now - s.t_lock) as u64);
      tx.fx.open_pending = -1;
    }

    Call::Reject { open_ok, reason } => {
      auth(caller == Role::Operator)?;
      in_state(s.state == State::Pending && open_ok)?;
      // B3: window mode only; always available under EXPLICIT_APPROVE.
      in_state(is_a || s.mode == mode::WINDOW || c.explicit_approve)?;
      tx.pay(Party::Taker, pending_stake);
      tx.close(match reason {
        RejectReason::MakerChoice => counter::REJECTIONS,
        _ => counter::REJECTIONS_NO_FAULT,
      });
      tx.fx.open_pending = -1;
    }

    Call::CancelPending => {
      auth(caller.is_taker())?;
      in_state(s.state == State::Pending)?;
      tx.pay(Party::Taker, pending_stake);
      tx.close(counter::PENDING_CANCELS);
      tx.fx.open_pending = -1;
    }

    Call::ExpirePending => {
      in_state(s.state == State::Pending)?;
      gate_from(now, s.t_pending_deadline)?;
      tx.pay(Party::Taker, pending_stake);
      // A lapsed take outside window mode is the maker's fault where the chain has no explicit
      // approval step.
      let fault = !is_a && s.mode != mode::WINDOW && c.lapse_is_fault;
      tx.close(if fault { counter::MISSED_FUNDS } else { counter::APPROVAL_TIMEOUTS });
      tx.fx.open_pending = -1;
    }

    Call::PostNotice => {
      auth(claimer(caller))?;
      in_state(s.state == State::Active)?;
      if is_a {
        gate_before(now, s.t_note_deadline.min(s.t_final))?;
      } else {
        // A late notice is still accepted until T_nl.
        gate_before(now, s.t_nl().min(s.t_final))?;
        if now >= s.t_note_deadline {
          tx.n.flags |= flag::LATE_NOTICE;
        }
      }
      tx.n.state = State::Noticed;
      tx.n.flags |= flag::NOTICE;
      tx.n.t_notice = now;
      tx.n.t_cut = now + delta_cut(s.depth, c);
      tx.n.t_claim_open = now + s.d_c as i64;
      tx.fx.counter = Some(counter::NOTICES);
    }

    Call::SetReady => {
      auth(locker(caller))?;
      in_state(s.state == State::Noticed)?;
      gate_from(now, s.t_ready_min(c))?;
      gate_before(now, s.t_claim_open.min(s.t_final))?;
      tx.n.state = State::Ready;
      tx.n.t_ready = now;
      tx.n.t_claim_deadline = now + s.w_c as i64;
      tx.fx.counter = Some(counter::READIES);
    }

    Call::Abort => {
      auth(claimer(caller))?;
      if is_a {
        match s.state {
          State::Active => {
            gate_before(now, s.t_note_deadline.min(s.t_final))?;
            tx.pay(Party::Taker, s.amount);
            tx.close(counter::ABORTS_PRE_NOTICE);
          }
          State::Noticed => {
            gate_before(now, s.t_final)?;
            if now < s.t_claim_open {
              tx.n.state = State::AbortedFree;
              tx.fx.counter = Some(counter::ABORTS_EARLY);
            } else {
              tx.n.state = State::AbortedHold;
              tx.fx.counter = Some(counter::ABORTS_LATE);
            }
          }
          State::Ready => {
            gate_before(now, s.t_final)?;
            tx.n.state = State::AbortedFree;
            tx.fx.counter = Some(counter::MISSED_CLAIMS);
          }
          _ => return Err(BadState),
        }
      } else {
        in_state(matches!(s.state, State::Noticed | State::Ready))?;
        gate_before(now, s.t_final)?;
        tx.n.state = State::AbortedHold;
        tx.fx.counter = Some(counter::TAKER_ABORTS);
      }
    }

    Call::RefundUnnoticed => {
      if !is_a {
        return Err(WrongDirection);
      }
      in_state(s.state == State::Active)?;
      gate_from(now, s.t_note_deadline)?;
      tx.pay(Party::Taker, s.amount);
      tx.close(counter::MISSED_NOTICES);
    }

    Call::ExpireUnnoticed => {
      if is_a {
        return Err(WrongDirection);
      }
      in_state(s.state == State::Active)?;
      gate_from(now, t_exp)?;
      tx.pay(Party::Taker, s.deposit);
      // The maker's escrow is parked, never pushed: nobody with authority over it is present.
      tx.park(Party::Maker, s.amount);
      tx.settle(counter::EXPIRED_REFUNDS);
    }

    Call::Refund { secret_ok } => {
      auth(c.open_secret_calls || locker(caller))?;
      use RefundKind::*;
      // Which row applies: (kind, counter).
      let (kind, ctr) = if is_a {
        match s.state {
          // A keyed refund is valid in ACTIVE at every instant.
          State::Active if now < s.t_note_deadline => (Held, counter::TAKER_CANCELS_APPROVED), // A10a
          State::Active => (Free, counter::MISSED_NOTICES),                                    // A10g
          State::Noticed if now < s.t_claim_open.min(s.t_final) => (Held, counter::TAKER_REFUNDS_NOTICED), // A10b
          State::Ready if now < s.t_claim_deadline => return Err(TooEarly),
          State::Ready if now < s.t_final => (Free, counter::MISSED_CLAIMS), // A10e
          State::AbortedHold if now < s.t_final => (Held, counter::REFUNDS_AFTER_ABORT), // A10c
          State::AbortedFree if now < s.t_final => (Free, counter::REFUNDS_AFTER_ABORT), // A10d
          State::Noticed | State::Ready | State::AbortedHold | State::AbortedFree => {
            gate_from_expiry(now, t_exp)?;
            (Free, counter::EXPIRED_REFUNDS) // A10f
          }
          _ => return Err(BadState),
        }
      } else {
        match s.state {
          State::Active if now < s.t_note_deadline => (Free, counter::BACKOUTS_PRE_NOTICE), // B9a
          State::Active => (Held, counter::TAKER_NO_NOTICE),                                // B9b
          State::Noticed if now < s.t_cut.min(s.t_final) => {
            if s.has(flag::LATE_NOTICE) {
              (Held, counter::TAKER_NO_NOTICE) // B9h
            } else {
              (Free, counter::BACKOUTS_POST_NOTICE) // B9c
            }
          }
          State::Noticed if now < s.t_claim_open.min(s.t_final) => (Held, counter::REFUNDS_UNCONFIRMED), // B9d
          State::Ready if now < s.t_claim_deadline => return Err(TooEarly),
          State::Ready if now < s.t_final => (Held, counter::TAKER_MISSED_CLAIMS), // B9e
          State::AbortedHold if now < s.t_final => (Held, counter::REFUNDS_AFTER_ABORT), // B9f
          State::Noticed | State::Ready | State::AbortedHold => {
            gate_from_expiry(now, t_exp)?;
            (Free, counter::EXPIRED_REFUNDS) // B9g
          }
          _ => return Err(BadState),
        }
      };
      if !secret_ok {
        return Err(BadSecret);
      }
      tx.n.flags |= flag::REVEALED | flag::REVEALER_LOCKER;
      tx.n.t_refund = now;
      let held = matches!(kind, Held) && s.deposit > 0;
      if is_a {
        // D is part of amount.
        tx.pay(Party::Taker, if held { s.amount - s.deposit } else { s.amount });
      } else {
        tx.pay(Party::Maker, s.amount);
        if !held {
          tx.pay(Party::Taker, s.deposit);
        }
      }
      if held {
        tx.n.state = State::Hold;
        tx.n.deposit_state = deposit_state::HELD;
        tx.fx.counter = Some(ctr);
      } else {
        tx.settle(ctr);
      }
    }

    Call::Claim { secret_ok } => {
      auth(c.open_secret_calls || claimer(caller))?;
      let ctr = match s.state {
        State::Ready if now < s.t_claim_deadline.min(s.t_final) => counter::COMPLETED, // A11a, B10a
        State::Ready if now < s.t_final => return Err(TooLate),
        State::Noticed if now < s.t_claim_open => return Err(TooEarly),
        State::Noticed if now < s.t_final => {
          if is_a {
            counter::CLAIMS_WITHOUT_READY // A11b
          } else {
            counter::TAKER_CLAIMS_WITHOUT_READY // B10b
          }
        }
        State::AbortedFree | State::AbortedHold if now < s.t_final => return Err(TooEarly),
        State::Noticed | State::Ready | State::AbortedFree | State::AbortedHold => {
          // [T_final, T_exp): the claimer may claim in any post-notice state.
          gate_before(now, t_exp)?;
          counter::CLAIMS_AFTER_FINAL // A11c, B10c
        }
        _ => return Err(BadState),
      };
      if !secret_ok {
        return Err(BadSecret);
      }
      let fee = fee_of(s.amount, s.fee_bps);
      tx.n.flags |= flag::REVEALED;
      if is_a {
        tx.pay(Party::Maker, s.amount - fee);
      } else {
        tx.pay(Party::Taker, s.amount - fee + s.deposit);
      }
      tx.pay(Party::Treasury, fee);
      tx.fx.volume = s.amount;
      tx.settle(ctr);
    }

    Call::ReleaseDeposit => match s.state {
      State::Hold => {
        if caller != Role::Operator {
          gate_from(now, s.t_hold(c))?;
        }
        tx.pay(Party::Taker, s.deposit);
        tx.n.deposit_state = deposit_state::RETURNED;
        tx.settle(counter::DEPOSITS_RETURNED);
      }
      State::Withheld => {
        auth(caller == Role::Operator)?;
        tx.pay(Party::Taker, s.deposit);
        tx.n.deposit_state = deposit_state::RELEASED;
        tx.settle(counter::RELEASES);
      }
      _ => return Err(BadState),
    },

    Call::Withhold(evidence) => {
      auth(caller == Role::Operator)?;
      in_state(s.state == State::Hold)?;
      // Refused at or after T_hold even if nobody has cranked release_deposit.
      gate_before(now, s.t_hold(c))?;
      if is_a && s.has(flag::NOTICE) {
        match evidence {
          Evidence::Absent => return Err(EvidenceRequired),
          Evidence::Mismatch => return Err(EvidenceMismatch),
          Evidence::Opens => tx.n.flags |= flag::EVIDENCE,
        }
      }
      tx.n.state = State::Withheld;
      tx.n.deposit_state = deposit_state::WITHHELD;
      tx.fx.counter = Some(counter::WITHHOLDS);
      tx.fx.withheld_volume = s.deposit;
    }

    Call::SplitDeposit => {
      in_state(s.state == State::Withheld)?;
      gate_from(now, s.t_split(c))?;
      let (to_taker, to_treasury) = split_of(s.deposit);
      tx.pay(Party::Taker, to_taker);
      tx.pay(Party::Treasury, to_treasury);
      tx.n.deposit_state = deposit_state::SPLIT;
      tx.settle(counter::SPLITS);
    }

    Call::PublishEvidence { opens } => {
      auth(claimer(caller))?;
      // "NOTICED or later, any state including DONE": a notice is on record.
      in_state(s.has(flag::NOTICE))?;
      if !opens {
        return Err(EvidenceMismatch);
      }
      tx.n.flags |= flag::EVIDENCE;
    }

    Call::WithdrawOwed(who) => {
      let (ok, owed) = match who {
        Party::Taker => (caller == Role::TakerWallet, s.owed_taker),
        Party::Maker => (caller == Role::Owner, s.owed_maker),
        Party::Treasury => (true, s.owed_treasury),
      };
      auth(ok)?;
      if owed == 0 {
        return Err(NothingOwed);
      }
      match who {
        Party::Taker => tx.n.owed_taker = 0,
        Party::Maker => tx.n.owed_maker = 0,
        Party::Treasury => tx.n.owed_treasury = 0,
      }
      tx.payouts.push(Payout { to: who, amount: owed, parked: false });
    }
  }
  Ok(tx.finish())
}

/// Between the end of the last pre-expiry window and `T_exp` a refund is `TooLate`.
fn gate_from_expiry(now: i64, t_exp: i64) -> Result<(), ModelError> {
  if now >= t_exp {
    Ok(())
  } else {
    Err(TooLate)
  }
}

/// A maker's counters and totals (SPEC 3.7). Every update saturates and can never fail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MakerRecord {
  pub counters: [u32; counter::COUNT],
  pub response_secs_sum: u64,
  pub volume: u128,
  pub withheld_volume: u128,
  pub open_pending: u16,
}
impl Default for MakerRecord {
  fn default() -> Self {
    MakerRecord { counters: [0; counter::COUNT], response_secs_sum: 0, volume: 0, withheld_volume: 0, open_pending: 0 }
  }
}
impl MakerRecord {
  /// Record a transition. `max_total` is the largest value the chain's volume type holds.
  pub fn record(&mut self, fx: &Effects, max_total: u128) {
    if let Some(c) = fx.counter {
      let slot = &mut self.counters[c as usize];
      *slot = slot.saturating_add(1);
    }
    if let Some(secs) = fx.response_secs {
      self.response_secs_sum = self.response_secs_sum.saturating_add(secs);
    }
    self.volume = self.volume.saturating_add(fx.volume).min(max_total);
    self.withheld_volume = self.withheld_volume.saturating_add(fx.withheld_volume).min(max_total);
    self.open_pending = match fx.open_pending {
      1 => self.open_pending.saturating_add(1),
      -1 => self.open_pending.saturating_sub(1),
      _ => self.open_pending,
    };
  }
}

/// Whether a call would succeed. Used by the property tests and by clients that grey out
/// buttons.
pub fn enabled(state: &SwapState, call: Call, caller: Role, now: i64, consts: &ChainConsts) -> bool {
  apply(*state, call, caller, now, &Env::OK, consts).is_ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::amounts::SOLANA;

  #[test]
  fn names_cover_every_assigned_counter() {
    assert_eq!(counter::NAMES.len(), 33);
    assert_eq!(counter::NAMES[counter::REJECTIONS_NO_FAULT as usize], "rejections_no_fault");
    assert_eq!(counter::NAMES[counter::SPLITS as usize], "splits");
    assert_eq!(counter::NAMES[counter::COMPLETED as usize], "completed");
  }

  #[test]
  fn counters_saturate_and_never_fail() {
    let mut m = MakerRecord::default();
    m.counters[counter::COMPLETED as usize] = u32::MAX;
    m.response_secs_sum = u64::MAX - 1;
    m.volume = u64::MAX as u128 - 5;
    let fx = Effects {
      state: SwapState::NONE,
      payouts: vec![],
      escrow_in: 0,
      counter: Some(counter::COMPLETED),
      response_secs: Some(10),
      volume: 100,
      withheld_volume: 0,
      open_pending: -1,
      closed: false,
    };
    m.record(&fx, SOLANA.max_amount);
    assert_eq!(m.counters[counter::COMPLETED as usize], u32::MAX);
    assert_eq!(m.response_secs_sum, u64::MAX);
    assert_eq!(m.volume, u64::MAX as u128);
    assert_eq!(m.open_pending, 0);
  }

  #[test]
  fn nothing_happens_to_a_swap_that_does_not_exist() {
    for call in [Call::CancelPending, Call::Refund { secret_ok: true }, Call::Claim { secret_ok: true }, Call::ReleaseDeposit] {
      assert_eq!(apply(SwapState::NONE, call, Role::TakerWallet, 0, &Env::OK, &SOLANA), Err(BadState));
    }
  }
}
