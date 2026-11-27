//! The state machine of SPEC 3.3 to 3.9 and 11.1, 11.2, 11.6 as pure functions.
//!
//! One escrow machine serves both directions and both chains. There is no I/O and no
//! cryptography here: a secret is "it opens the commitment or it does not", evidence is "it
//! opens the notice commitment or it does not", the open hash of SPEC 3.12 "matches or does
//! not", an address is "the taker's own, another, or invalid".
//!
//! * [`gate`] decides whether a call on an existing swap is allowed and which row it is. It
//!   reads the swap, the call, the caller and the time, and **nothing else**: no cap, pause or
//!   other admin or maker switch reaches it (invariant 3, SPEC 11.1).
//! * [`plan`] says who is paid how much by a row.
//! * [`execute`] applies a row and cannot fail ([`execute_plan`] is the same with the plan given).
//! * [`open`] is `lock` and `take`: the only calls a switch may refuse.
//! * [`apply`] is the whole transition.
//!
//! Conventions fixed here because the specification leaves them open (SPEC 3.13):
//!
//! * **Check order**: direction, caller, state, open hash, time gate, then secret, evidence or
//!   watcher.
//! * **`TooEarly` or `TooLate`**: when a call is refused only because of the time, it is
//!   `TooLate` if some window of that call in that state has already closed, else `TooEarly`.
//! * **"Closed" rows** (A3, A4, A5, A7a, A8, B2, B3, B4) end in `Done` with
//!   [`Effects::closed`] set when nothing was parked. Solana then closes the account in the same
//!   instruction; Ethereum never deletes a swap.
//! * A payout of zero is not a payout: it is neither paid nor parked and does not appear.

use crate::{
  amounts::{deposit_of, fee_of, split_of},
  bounds::{check_bounds, delta_cut, pending_window, BoundError, Chain, ChainConsts, Pending, SwapParams, DAY_SECS},
  caps::{close_value, open_check, CapError, Caps},
};

/// Swap state (SPEC 3.3, 11.6). Value 0 means "no such swap".
#[cfg_attr(kani, derive(kani::Arbitrary))]
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
  /// A watcher or the locker paused the claimer's claim-without-ready until `T_ff`.
  Frozen = 10,
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
      State::Frozen => "FROZEN",
    }
  }
  /// The states whose swap is counted in the open value (SPEC 11.1).
  pub fn is_open(self) -> bool {
    matches!(
      self,
      State::Pending | State::Active | State::Noticed | State::Ready | State::Frozen | State::AbortedFree | State::AbortedHold
    )
  }
}

/// Direction A: the taker pays the chain asset and receives XMR (locker = taker, claimer =
/// maker). Direction B: the taker pays XMR (locker = maker, claimer = taker).
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Direction {
  A = 0,
  B = 1,
}

/// Who signs a call.
#[cfg_attr(kani, derive(kani::Arbitrary))]
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
  /// The watcher key the swap names (SPEC 11.6). On a swap that names none it is a stranger.
  Watcher,
  /// The payout address of a direction-B swap, when it is not the taker's own (SPEC 11.2).
  Payout,
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
      Role::Watcher => "watcher",
      Role::Payout => "payout",
      Role::Anyone => "anyone",
    }
  }
  pub fn is_taker(self) -> bool {
    matches!(self, Role::TakerWallet | Role::Session)
  }
}

/// A payout destination. The contracts fix the address behind each: the taker stored at lock;
/// the maker's payout address (claim in A) or operator (refund in B); the treasury; the payout
/// address a direction-B taker named at `take` (SPEC 11.2). There is no watcher here: a watcher
/// can never be paid.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Party {
  Taker,
  Maker,
  Treasury,
  Payout,
}
impl Party {
  pub fn name(self) -> &'static str {
    match self {
      Party::Taker => "taker",
      Party::Maker => "maker",
      Party::Treasury => "treasury",
      Party::Payout => "payout",
    }
  }
}

/// Counter ids (SPEC 3.7, 11.6). They are also the `outcome` codes.
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
  pub const FREEZES: u8 = 33;
  pub const REFUNDS_AFTER_FREEZE: u8 = 34;
  pub const BACKOUTS_AFTER_FREEZE: u8 = 35;
  pub const CLAIMS_AFTER_FREEZE: u8 = 36;
  /// Number of assigned counters.
  pub const ASSIGNED: usize = 37;
  /// Number of counter slots; ids 37 to 39 are reserved.
  pub const COUNT: usize = 40;
  /// `outcome` while the swap is open, and the counter byte of a transition that moves none.
  pub const NONE: u8 = 0xff;

  pub const NAMES: [&str; ASSIGNED] = [
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
    "freezes",
    "refunds_after_freeze",
    "backouts_after_freeze",
    "claims_after_freeze",
  ];
}

/// Bits of `Swap.flags`.
pub mod flag {
  pub const NOTICE: u8 = 1 << 0;
  pub const EVIDENCE: u8 = 1 << 1;
  pub const REVEALED: u8 = 1 << 2;
  pub const REVEALER_LOCKER: u8 = 1 << 3;
  pub const LATE_NOTICE: u8 = 1 << 4;
  /// The swap is counted in its asset's open value (SPEC 11.1).
  pub const COUNTED: u8 = 1 << 5;
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

/// What the swap's `payout` field holds, as far as the machine cares (SPEC 11.2).
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum PayoutTo {
  /// Direction A: the field is zeros.
  None = 0,
  /// Direction B: the taker's own address (the default).
  Taker = 1,
  /// Direction B: an address other than the taker's.
  Other = 2,
}
impl PayoutTo {
  pub fn name(self) -> &'static str {
    match self {
      PayoutTo::None => "none",
      PayoutTo::Taker => "taker",
      PayoutTo::Other => "other",
    }
  }
}

/// The `payout` argument of `take`.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PayoutArg {
  /// The taker's own address.
  Taker,
  /// A valid address other than the taker's.
  Other,
  /// Solana: the default key, the program id or a token account. Ethereum: the zero address.
  Invalid,
}
impl PayoutArg {
  pub fn name(self) -> &'static str {
    match self {
      PayoutArg::Taker => "taker",
      PayoutArg::Other => "other",
      PayoutArg::Invalid => "invalid",
    }
  }
}

/// The machine's view of a swap: every field of the on-chain record that a transition reads or
/// writes. Amounts are `u128` (Solana stores `u64`, Ethereum `uint256`).
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Swap {
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
  /// Parked for the taker. On a direction-B swap that ended in a claim whose payout address is
  /// not the taker's, the balance belongs to the payout address ([`Swap::payout_owed`]).
  pub owed_taker: u128,
  pub owed_maker: u128,
  pub owed_treasury: u128,
  /// Where a direction-B claim pays (SPEC 11.2).
  pub payout: PayoutTo,
  /// A watcher key is named (A: at `lock`; B: at `fund`).
  pub watcher: bool,
  /// `W_z`, copied from the offer or quote; 0 = no watcher accepted.
  pub w_z: u32,
  /// `t_Z`: when the swap was frozen; 0 = never.
  pub t_freeze: i64,
}

impl Swap {
  /// "No such swap": the state passed to [`Call::Open`].
  pub const NONE: Swap = Swap {
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
    payout: PayoutTo::None,
    watcher: false,
    w_z: 0,
    t_freeze: 0,
  };

  pub fn is_a(&self) -> bool {
    matches!(self.direction, Direction::A)
  }
  /// `T_nl = t_final − d_c − w_z − w_c − 86,400`.
  pub fn t_nl(&self) -> i64 {
    self.t_final - self.d_c as i64 - self.w_z as i64 - self.w_c as i64 - DAY_SECS
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
  /// `T_ff = max(t_Z + W_z, T_co)`: a frozen swap's claim-without-ready opens, and the locker's
  /// refund and `set_ready` close.
  ///
  /// SPEC 11.6 writes `T_ff = t_Z + W_z`. That is wrong whenever the freeze comes more than
  /// `W_z` before `T_co` (`W_z` may be as small as an hour and `D_c` is at least an hour, on
  /// Ethereum two): the freeze would then *open the claim earlier* than `T_co` and close the
  /// locker's refund earlier, so a watcher could cost the locker its funds, and with a deep
  /// confirmation tier `T_ff` could even precede the earliest `set_ready`, leaving no way to
  /// unfreeze. A freeze must never shorten the locker's window, so the later of the two is used
  /// (`docs/research/a1-deviations.md`, D1). `T_ff < T_co + W_z` still holds.
  pub fn t_ff(&self) -> i64 {
    let by_window = self.t_freeze + self.w_z as i64;
    if by_window > self.t_claim_open {
      by_window
    } else {
      self.t_claim_open
    }
  }
  pub fn has(&self, flag: u8) -> bool {
    self.flags & flag != 0
  }
  /// The claim of a direction-B swap pays this party.
  pub fn claim_party(&self) -> Party {
    match self.payout {
      PayoutTo::Other => Party::Payout,
      _ => Party::Taker,
    }
  }
  /// `owed_taker` belongs to the payout address: a direction-B swap whose claimer revealed (it
  /// ended in a claim) and whose payout address is not the taker's.
  pub fn payout_owed(&self) -> bool {
    !self.is_a()
      && matches!(self.payout, PayoutTo::Other)
      && self.has(flag::REVEALED)
      && !self.has(flag::REVEALER_LOCKER)
  }
}

/// Arguments of `lock` (A1) and `take` (B1) that the machine depends on.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenArgs {
  pub direction: Direction,
  /// Mode of the offer or quote: 0 AUTO, 1 WINDOW, 2 ADVANCE, 3 taker-bound quote.
  pub offer_mode: u8,
  /// A valid advance approval is presented.
  pub approval: bool,
  /// The size of the swap in piconero. Zero is refused (`AmountOutOfRange`).
  pub xmr: u64,
  /// The escrowed amount (A: paid by the taker now; B: funded by the maker later). Zero is
  /// refused (`AmountOutOfRange`): a direction-B take of dust can round down to zero.
  pub amount: u128,
  pub params: SwapParams,
  /// Direction B: the payout address named at `take`. Ignored in direction A.
  pub payout: PayoutArg,
  /// Direction A: the taker names a watcher at `lock`. Ignored in direction B, where the maker
  /// names its watcher at `fund`.
  pub watcher: bool,
}

/// The `reason` byte of `reject` (SPEC 3.7).
#[cfg_attr(kani, derive(kani::Arbitrary))]
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
#[cfg_attr(kani, derive(kani::Arbitrary))]
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
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Call {
  /// `lock` (A1) or `take` (B1).
  Open(OpenArgs),
  /// A2. `open_ok`: `expected_open` equals the swap's open hash (SPEC 3.12).
  Approve { open_ok: bool },
  /// B5. `watcher`: the maker names a watcher (SPEC 11.6).
  Fund { open_ok: bool, watcher: bool },
  /// A3, B3.
  Reject { open_ok: bool, reason: RejectReason },
  /// A4, B2.
  CancelPending,
  /// A5, B4.
  ExpirePending,
  /// A6, B6.
  PostNotice,
  /// A9, B7, Z2.
  SetReady,
  /// Z1.
  Freeze,
  /// A7a-d, B8, Z5.
  Abort,
  /// A8.
  RefundUnnoticed,
  /// B11.
  ExpireUnnoticed,
  /// A10a-g, B9a-h, Z3. `secret_ok`: the scalar opens the locker's commitment.
  Refund { secret_ok: bool },
  /// A11a-c, B10a-c, Z4. `secret_ok`: the scalar opens the claimer's commitment.
  Claim { secret_ok: bool },
  ReleaseDeposit,
  Withhold(Evidence),
  SplitDeposit,
  /// `opens`: `(txid, v_C)` opens the notice commitment.
  PublishEvidence { opens: bool },
  /// Pull a parked payout.
  WithdrawOwed(Party),
  /// Ethereum `pushOwed(token, account)`: anyone has a parked balance paid to the account it is
  /// owed to (SPEC 11.2).
  PushOwed(Party),
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
      Call::Freeze => "freeze",
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
      Call::PushOwed(_) => "push_owed",
    }
  }
  /// A call whose arguments reveal a spend share.
  pub fn is_secret_bearing(&self) -> bool {
    matches!(self, Call::Refund { .. } | Call::Claim { .. })
  }
}

/// What the machine cannot know.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Env {
  /// Whether each destination can receive right now (pay-or-park). On Ethereum the treasury
  /// share only increments `treasuryAccrued`, which cannot fail: pass `true`. On Solana a
  /// `split_deposit` whose `treasury` account is not the one the current `split_mode` names
  /// parks the treasury's half: pass `false` (SPEC 11.1).
  pub taker_can_receive: bool,
  pub maker_can_receive: bool,
  pub treasury_can_receive: bool,
  pub payout_can_receive: bool,
  /// The maker's current `open_pending` count, for `MAX_OPEN_PENDING`.
  pub open_pending: u16,
  /// The caps of the swap's asset and its open value before the call (SPEC 11.1).
  pub caps: Caps,
  /// The maker's pause that applies to this open (Solana: the direction's pause bit; Ethereum:
  /// `paused`). It can refuse `lock` and `take` and nothing else.
  pub maker_paused: bool,
}
impl Env {
  /// Every destination can receive; no pending swaps; caps on and out of reach; not paused.
  pub const OK: Env = Env {
    taker_can_receive: true,
    maker_can_receive: true,
    treasury_can_receive: true,
    payout_can_receive: true,
    open_pending: 0,
    caps: Caps::UNLIMITED,
    maker_paused: false,
  };
  fn can(&self, p: Party) -> bool {
    match p {
      Party::Taker => self.taker_can_receive,
      Party::Maker => self.maker_can_receive,
      Party::Treasury => self.treasury_can_receive,
      Party::Payout => self.payout_can_receive,
    }
  }
}

/// One payout of a transition.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payout {
  pub to: Party,
  pub amount: u128,
  /// False: transferred now. True: left in escrow and added to `owed_*`.
  pub parked: bool,
}

/// No row pays more than two parties.
pub const MAX_PAYOUTS: usize = 2;

/// The payouts of one transition, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payouts {
  items: [Payout; MAX_PAYOUTS],
  len: u8,
}
impl Payouts {
  pub const EMPTY: Payouts = Payouts { items: [Payout { to: Party::Taker, amount: 0, parked: false }; MAX_PAYOUTS], len: 0 };
  pub fn as_slice(&self) -> &[Payout] {
    &self.items[..self.len as usize]
  }
  pub fn len(&self) -> usize {
    self.len as usize
  }
  pub fn is_empty(&self) -> bool {
    self.len == 0
  }
  fn push(&mut self, p: Payout) {
    self.items[self.len as usize] = p;
    self.len += 1;
  }
  /// Total transferred out of escrow now.
  pub fn paid(&self) -> u128 {
    let mut sum = 0u128;
    let mut i = 0;
    while i < self.len as usize {
      if !self.items[i].parked {
        sum += self.items[i].amount;
      }
      i += 1;
    }
    sum
  }
  /// Total paid or parked for `to`.
  pub fn total_for(&self, to: Party) -> u128 {
    let mut sum = 0u128;
    let mut i = 0;
    while i < self.len as usize {
      if self.items[i].to == to {
        sum += self.items[i].amount;
      }
      i += 1;
    }
    sum
  }
}

#[cfg(kani)]
impl kani::Arbitrary for Payouts {
  /// Any list the machine can build: zero, one or two payouts of any content.
  fn any() -> Self {
    let len: u8 = kani::any();
    kani::assume(len as usize <= MAX_PAYOUTS);
    let mut out = Payouts::EMPTY;
    let mut i = 0;
    while i < len {
      out.push(Payout { to: kani::any(), amount: kani::any(), parked: kani::any() });
      i += 1;
    }
    out
  }
}

/// Everything a successful call does.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Effects {
  /// The swap after the call, including every `t_*` field and the `owed_*` balances.
  pub state: Swap,
  pub payouts: Payouts,
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
  /// The asset's open value after the call (SPEC 11.1): `env.caps.open_value` plus the counted
  /// value on an open, minus it on the transition that leaves the open states, else unchanged.
  pub open_value_after: u128,
}

/// Why a call is refused. Names are the Solana error names; Ethereum's differ for `BadSecret`
/// (Solana `ScalarMismatch`) and `PayoutInvalid` (Ethereum `BadValue`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateError {
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
  /// A swap whose `amount` or `xmr` is zero (SPEC 3.1).
  AmountOutOfRange,
  Bound(BoundError),
  /// The maker paused new swaps (`lock` and `take` only).
  Paused,
  SwapCapExceeded,
  OpenCapExceeded,
  PayoutInvalid,
  /// A watcher is named against `W_z == 0`.
  WatcherNotAllowed,
}
impl GateError {
  pub fn name(&self) -> &'static str {
    match self {
      GateError::Unauthorized => "Unauthorized",
      GateError::BadState => "BadState",
      GateError::WrongDirection => "WrongDirection",
      GateError::TooEarly => "TooEarly",
      GateError::TooLate => "TooLate",
      GateError::BadSecret => "BadSecret",
      GateError::EvidenceRequired => "EvidenceRequired",
      GateError::EvidenceMismatch => "EvidenceMismatch",
      GateError::NothingOwed => "NothingOwed",
      GateError::ApprovalRequired => "ApprovalRequired",
      GateError::TooManyPending => "TooManyPending",
      GateError::MathOverflow => "MathOverflow",
      GateError::AmountOutOfRange => "AmountOutOfRange",
      GateError::Bound(b) => b.name(),
      GateError::Paused => "Paused",
      GateError::SwapCapExceeded => "SwapCapExceeded",
      GateError::OpenCapExceeded => "OpenCapExceeded",
      GateError::PayoutInvalid => "PayoutInvalid",
      GateError::WatcherNotAllowed => "WatcherNotAllowed",
    }
  }
  /// The error name on a chain.
  pub fn chain_name(&self, chain: Chain) -> &'static str {
    match (self, chain) {
      (GateError::BadSecret, Chain::Solana) => "ScalarMismatch",
      (GateError::PayoutInvalid, Chain::Ethereum) => "BadValue",
      _ => self.name(),
    }
  }
}

use GateError::*;

/// A row of SPEC 3.4 to 3.6, 11.2 and 11.6: what an allowed call does.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
  /// A2.
  Approve,
  /// B5.
  Fund { watcher: bool },
  /// A3, B3.
  Reject { no_fault: bool },
  /// A4, B2.
  CancelPending,
  /// A5, B4. `fault`: counted as `missed_funds`.
  ExpirePending { fault: bool },
  /// A6, B6. `late`: a direction-B notice at or after `T_note`.
  PostNotice { late: bool },
  /// A9, B7, Z2.
  SetReady,
  /// Z1.
  Freeze,
  /// A7a: the escrow returns at once and the swap closes.
  AbortClose,
  /// A7b-d, B8, Z5: the claimer waives its claim until `T_final`.
  Abort { hold: bool, counter: u8 },
  /// A8.
  RefundUnnoticed,
  /// B11.
  ExpireUnnoticed,
  /// A10a-g, B9a-h, Z3. `held`: the deposit stays in escrow and the swap enters HOLD.
  Refund { held: bool, counter: u8 },
  /// A11a-c, B10a-c, Z4.
  Claim { counter: u8 },
  /// `release_deposit` from HOLD.
  ReleaseHeld,
  /// `release_deposit` from WITHHELD.
  ReleaseWithheld,
  /// `evidence`: the evidence is required, opens the commitment and is stored.
  Withhold { evidence: bool },
  Split,
  PublishEvidence,
  /// A parked balance leaves escrow for the party it is owed to.
  PayOwed(Party),
}

fn gate_before(now: i64, limit: i64) -> Result<(), GateError> {
  if now < limit {
    Ok(())
  } else {
    Err(TooLate)
  }
}
fn gate_from(now: i64, start: i64) -> Result<(), GateError> {
  if now >= start {
    Ok(())
  } else {
    Err(TooEarly)
  }
}
fn auth(ok: bool) -> Result<(), GateError> {
  if ok {
    Ok(())
  } else {
    Err(Unauthorized)
  }
}
fn in_state(ok: bool) -> Result<(), GateError> {
  if ok {
    Ok(())
  } else {
    Err(BadState)
  }
}
fn min(a: i64, b: i64) -> i64 {
  if a < b {
    a
  } else {
    b
  }
}

/// Whether `r` is the locker of `s`: the party that escrows the chain asset and can refund it.
pub fn is_locker(s: &Swap, r: Role) -> bool {
  if s.is_a() {
    r.is_taker()
  } else {
    matches!(r, Role::Operator)
  }
}
/// Whether `r` is the claimer of `s`: the party that locks XMR and can claim.
pub fn is_claimer(s: &Swap, r: Role) -> bool {
  if s.is_a() {
    matches!(r, Role::Operator)
  } else {
    r.is_taker()
  }
}

/// Decide a call on an existing swap: `Ok(row)` when it is allowed, else the one reason it is
/// refused. [`Call::Open`] is not decided here (see [`open`]); it gets `BadState`.
///
/// The inputs are the swap, the call, the caller and the time. No cap, pause, epoch, split mode
/// or other switch is an input, so none can block, delay or alter an exit (invariant 3).
pub fn gate(s: &Swap, call: &Call, caller: Role, now: i64, c: &ChainConsts) -> Result<Row, GateError> {
  in_state(!matches!(s.state, State::None))?;
  let is_a = s.is_a();
  let locker = is_locker(s, caller);
  let claimer = is_claimer(s, caller);
  let operator = matches!(caller, Role::Operator);
  let t_exp = s.t_exp(c);
  let st = s.state;

  match *call {
    Call::Open(_) => Err(BadState),

    Call::Approve { open_ok } => {
      if !is_a {
        return Err(WrongDirection);
      }
      auth(operator)?;
      in_state(matches!(st, State::Pending) && open_ok)?;
      gate_before(now, s.t_pending_deadline)?;
      Ok(Row::Approve)
    }

    Call::Fund { open_ok, watcher } => {
      if is_a {
        return Err(WrongDirection);
      }
      auth(operator)?;
      in_state(matches!(st, State::Pending) && open_ok)?;
      gate_before(now, s.t_pending_deadline)?;
      if watcher && s.w_z == 0 {
        return Err(WatcherNotAllowed);
      }
      Ok(Row::Fund { watcher })
    }

    Call::Reject { open_ok, reason } => {
      auth(operator)?;
      in_state(matches!(st, State::Pending) && open_ok)?;
      // B3: window mode only; always available under EXPLICIT_APPROVE.
      in_state(is_a || s.mode == mode::WINDOW || c.explicit_approve)?;
      Ok(Row::Reject { no_fault: !matches!(reason, RejectReason::MakerChoice) })
    }

    Call::CancelPending => {
      auth(caller.is_taker())?;
      in_state(matches!(st, State::Pending))?;
      Ok(Row::CancelPending)
    }

    Call::ExpirePending => {
      in_state(matches!(st, State::Pending))?;
      gate_from(now, s.t_pending_deadline)?;
      // A lapsed take outside window mode is the maker's fault where the chain has no explicit
      // approval step.
      Ok(Row::ExpirePending { fault: !is_a && s.mode != mode::WINDOW && c.lapse_is_fault })
    }

    Call::PostNotice => {
      auth(claimer)?;
      in_state(matches!(st, State::Active))?;
      if is_a {
        gate_before(now, min(s.t_note_deadline, s.t_final))?;
        Ok(Row::PostNotice { late: false })
      } else {
        // A late notice is still accepted until T_nl.
        gate_before(now, min(s.t_nl(), s.t_final))?;
        Ok(Row::PostNotice { late: now >= s.t_note_deadline })
      }
    }

    Call::SetReady => {
      auth(locker)?;
      match st {
        State::Noticed => {
          gate_from(now, s.t_ready_min(c))?;
          gate_before(now, min(s.t_claim_open, s.t_final))?;
        }
        // Z2: unfreezing.
        State::Frozen => {
          gate_from(now, s.t_ready_min(c))?;
          gate_before(now, min(s.t_ff(), s.t_final))?;
        }
        _ => return Err(BadState),
      }
      Ok(Row::SetReady)
    }

    Call::Freeze => {
      // Z1: the watcher the swap names, or the locker itself.
      auth((matches!(caller, Role::Watcher) && s.watcher) || locker)?;
      in_state(matches!(st, State::Noticed) && s.watcher)?;
      gate_before(now, min(s.t_claim_open, s.t_final))?;
      Ok(Row::Freeze)
    }

    Call::Abort => {
      auth(claimer)?;
      if is_a {
        match st {
          State::Active => {
            gate_before(now, min(s.t_note_deadline, s.t_final))?;
            Ok(Row::AbortClose)
          }
          State::Noticed => {
            gate_before(now, s.t_final)?;
            if now < s.t_claim_open {
              Ok(Row::Abort { hold: false, counter: counter::ABORTS_EARLY })
            } else {
              Ok(Row::Abort { hold: true, counter: counter::ABORTS_LATE })
            }
          }
          State::Ready => {
            gate_before(now, s.t_final)?;
            Ok(Row::Abort { hold: false, counter: counter::MISSED_CLAIMS })
          }
          // Z5: after a freeze the deposit always stays withholdable.
          State::Frozen => {
            gate_before(now, s.t_final)?;
            Ok(Row::Abort { hold: true, counter: counter::ABORTS_LATE })
          }
          _ => Err(BadState),
        }
      } else {
        in_state(matches!(st, State::Noticed | State::Ready | State::Frozen))?;
        gate_before(now, s.t_final)?;
        Ok(Row::Abort { hold: true, counter: counter::TAKER_ABORTS })
      }
    }

    Call::RefundUnnoticed => {
      if !is_a {
        return Err(WrongDirection);
      }
      in_state(matches!(st, State::Active))?;
      gate_from(now, s.t_note_deadline)?;
      Ok(Row::RefundUnnoticed)
    }

    Call::ExpireUnnoticed => {
      if is_a {
        return Err(WrongDirection);
      }
      in_state(matches!(st, State::Active))?;
      gate_from(now, t_exp)?;
      Ok(Row::ExpireUnnoticed)
    }

    Call::Refund { secret_ok } => {
      auth(c.open_secret_calls || locker)?;
      // Which row applies: (the deposit is held, counter).
      const HELD: bool = true;
      const FREE: bool = false;
      let t_final = s.t_final;
      let expiry = |now: i64| -> Result<(bool, u8), GateError> {
        // Between the end of the last pre-expiry window and T_exp a refund is TooLate.
        if now >= t_exp {
          Ok((FREE, counter::EXPIRED_REFUNDS)) // A10f, B9g, Z6
        } else {
          Err(TooLate)
        }
      };
      let (kind, ctr) = if is_a {
        match st {
          // A keyed refund is valid in ACTIVE at every instant.
          State::Active if now < s.t_note_deadline => (HELD, counter::TAKER_CANCELS_APPROVED), // A10a
          State::Active => (FREE, counter::MISSED_NOTICES),                                    // A10g
          State::Noticed if now < min(s.t_claim_open, t_final) => (HELD, counter::TAKER_REFUNDS_NOTICED), // A10b
          State::Frozen if now < min(s.t_ff(), t_final) => (HELD, counter::REFUNDS_AFTER_FREEZE), // Z3
          State::Ready if now < s.t_claim_deadline => return Err(TooEarly),
          State::Ready if now < t_final => (FREE, counter::MISSED_CLAIMS), // A10e
          State::AbortedHold if now < t_final => (HELD, counter::REFUNDS_AFTER_ABORT), // A10c
          State::AbortedFree if now < t_final => (FREE, counter::REFUNDS_AFTER_ABORT), // A10d
          State::Noticed | State::Ready | State::AbortedHold | State::AbortedFree | State::Frozen => expiry(now)?,
          _ => return Err(BadState),
        }
      } else {
        match st {
          State::Active if now < s.t_note_deadline => (FREE, counter::BACKOUTS_PRE_NOTICE), // B9a
          State::Active => (HELD, counter::TAKER_NO_NOTICE),                                // B9b
          // T_cut precedes T_co by the bounds (D_c >= Δ_cut + 2M); the gate does not rely on it:
          // no refund row is open once the claim-without-ready is (invariant 1 for every record).
          State::Noticed if now < min(min(s.t_cut, s.t_claim_open), t_final) => {
            if s.has(flag::LATE_NOTICE) {
              (HELD, counter::TAKER_NO_NOTICE) // B9h
            } else {
              (FREE, counter::BACKOUTS_POST_NOTICE) // B9c
            }
          }
          State::Noticed if now < min(s.t_claim_open, t_final) => (HELD, counter::REFUNDS_UNCONFIRMED), // B9d
          // Z3: there is no maker bond, so a maker refund after a freeze never holds the deposit.
          State::Frozen if now < min(s.t_ff(), t_final) => (FREE, counter::BACKOUTS_AFTER_FREEZE),
          State::Ready if now < s.t_claim_deadline => return Err(TooEarly),
          State::Ready if now < t_final => (HELD, counter::TAKER_MISSED_CLAIMS), // B9e
          State::AbortedHold if now < t_final => (HELD, counter::REFUNDS_AFTER_ABORT), // B9f
          State::Noticed | State::Ready | State::AbortedHold | State::Frozen => expiry(now)?,
          _ => return Err(BadState),
        }
      };
      if !secret_ok {
        return Err(BadSecret);
      }
      Ok(Row::Refund { held: kind == HELD && s.deposit > 0, counter: ctr })
    }

    Call::Claim { secret_ok } => {
      auth(c.open_secret_calls || claimer)?;
      let ctr = match st {
        State::Ready if now < min(s.t_claim_deadline, s.t_final) => counter::COMPLETED, // A11a, B10a
        State::Ready if now < s.t_final => return Err(TooLate),
        State::Noticed if now < s.t_claim_open => return Err(TooEarly),
        State::Noticed if now < s.t_final => {
          if is_a {
            counter::CLAIMS_WITHOUT_READY // A11b
          } else {
            counter::TAKER_CLAIMS_WITHOUT_READY // B10b
          }
        }
        // Z4: a freeze moves the opening of the claim-without-ready from T_co to T_ff.
        State::Frozen if now < min(s.t_ff(), s.t_final) => return Err(TooEarly),
        State::Frozen if now < s.t_final => counter::CLAIMS_AFTER_FREEZE,
        State::AbortedFree | State::AbortedHold if now < s.t_final => return Err(TooEarly),
        State::Noticed | State::Ready | State::AbortedFree | State::AbortedHold | State::Frozen => {
          // [T_final, T_exp): the claimer may claim in any post-notice state.
          gate_before(now, t_exp)?;
          counter::CLAIMS_AFTER_FINAL // A11c, B10c, Z6
        }
        _ => return Err(BadState),
      };
      if !secret_ok {
        return Err(BadSecret);
      }
      Ok(Row::Claim { counter: ctr })
    }

    Call::ReleaseDeposit => match st {
      State::Hold => {
        if !operator {
          gate_from(now, s.t_hold(c))?;
        }
        Ok(Row::ReleaseHeld)
      }
      State::Withheld => {
        auth(operator)?;
        Ok(Row::ReleaseWithheld)
      }
      _ => Err(BadState),
    },

    Call::Withhold(evidence) => {
      auth(operator)?;
      in_state(matches!(st, State::Hold))?;
      // Refused at or after T_hold even if nobody has cranked release_deposit.
      gate_before(now, s.t_hold(c))?;
      if is_a && s.has(flag::NOTICE) {
        match evidence {
          Evidence::Absent => Err(EvidenceRequired),
          Evidence::Mismatch => Err(EvidenceMismatch),
          Evidence::Opens => Ok(Row::Withhold { evidence: true }),
        }
      } else {
        Ok(Row::Withhold { evidence: false })
      }
    }

    Call::SplitDeposit => {
      in_state(matches!(st, State::Withheld))?;
      gate_from(now, s.t_split(c))?;
      Ok(Row::Split)
    }

    Call::PublishEvidence { opens } => {
      auth(claimer)?;
      // "NOTICED or later, any state including DONE": a notice is on record.
      in_state(s.has(flag::NOTICE))?;
      if !opens {
        return Err(EvidenceMismatch);
      }
      Ok(Row::PublishEvidence)
    }

    Call::WithdrawOwed(who) => {
      let (ok, owed) = match who {
        Party::Taker => (matches!(caller, Role::TakerWallet) && !s.payout_owed(), s.owed_taker),
        Party::Maker => (matches!(caller, Role::Owner), s.owed_maker),
        Party::Treasury => (true, s.owed_treasury),
        // SPEC 11.2: the payout address itself, to any destination; or, where the call does not
        // pay the caller (Solana), anyone with the destination pinned to the payout address.
        Party::Payout => (s.payout_owed() && (matches!(caller, Role::Payout) || !c.pull_own_owed), s.owed_taker),
      };
      if !ok {
        // SPEC 3.13: where the call pays the caller's own parked balance (Ethereum), an account
        // that is owed nothing has nothing to pull; elsewhere it is the wrong signer.
        return Err(if c.pull_own_owed { NothingOwed } else { Unauthorized });
      }
      if owed == 0 {
        return Err(NothingOwed);
      }
      Ok(Row::PayOwed(who))
    }

    Call::PushOwed(who) => {
      if !c.push_owed {
        // The chain has no such call.
        return Err(Unauthorized);
      }
      let owed = match who {
        Party::Taker if !s.payout_owed() => s.owed_taker,
        Party::Payout if s.payout_owed() => s.owed_taker,
        Party::Maker => s.owed_maker,
        Party::Treasury => s.owed_treasury,
        _ => 0,
      };
      if owed == 0 {
        return Err(NothingOwed);
      }
      Ok(Row::PayOwed(who))
    }
  }
}

/// One line of a payout plan.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pay {
  pub to: Party,
  pub amount: u128,
  /// The amount is parked without trying to push it (B11: nobody with authority over the
  /// maker's escrow is present).
  pub park: bool,
  /// The amount is already parked and is now leaving escrow (`withdraw_owed`, `pushOwed`).
  pub owed: bool,
}

/// Who a row pays, and how much. Lines with a zero amount are not payouts.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
  pub pays: [Pay; MAX_PAYOUTS],
}

/// The payout plan of a row: who gets how much out of the swap's escrow.
pub fn plan(s: &Swap, row: Row) -> Plan {
  let none = Pay { to: Party::Taker, amount: 0, park: false, owed: false };
  let pay = |to: Party, amount: u128| Pay { to, amount, park: false, owed: false };
  let is_a = s.is_a();
  // What a pending exit returns to the taker.
  let pending_stake = if is_a { s.amount } else { s.deposit };
  let pays = match row {
    Row::Reject { .. } | Row::CancelPending | Row::ExpirePending { .. } => [pay(Party::Taker, pending_stake), none],
    Row::AbortClose | Row::RefundUnnoticed => [pay(Party::Taker, s.amount), none],
    Row::ExpireUnnoticed => [pay(Party::Taker, s.deposit), Pay { to: Party::Maker, amount: s.amount, park: true, owed: false }],
    Row::Refund { held, .. } => {
      if is_a {
        // D is part of amount.
        [pay(Party::Taker, if held { s.amount - s.deposit } else { s.amount }), none]
      } else {
        [pay(Party::Maker, s.amount), pay(Party::Taker, if held { 0 } else { s.deposit })]
      }
    }
    Row::Claim { .. } => {
      let fee = fee_of(s.amount, s.fee_bps);
      if is_a {
        [pay(Party::Maker, s.amount - fee), pay(Party::Treasury, fee)]
      } else {
        [pay(s.claim_party(), s.amount - fee + s.deposit), pay(Party::Treasury, fee)]
      }
    }
    Row::ReleaseHeld | Row::ReleaseWithheld => [pay(Party::Taker, s.deposit), none],
    Row::Split => {
      let (to_taker, to_treasury) = split_of(s.deposit);
      [pay(Party::Taker, to_taker), pay(Party::Treasury, to_treasury)]
    }
    Row::PayOwed(who) => {
      let owed = match who {
        Party::Taker | Party::Payout => s.owed_taker,
        Party::Maker => s.owed_maker,
        Party::Treasury => s.owed_treasury,
      };
      [Pay { to: who, amount: owed, park: false, owed: true }, none]
    }
    Row::Approve
    | Row::Fund { .. }
    | Row::PostNotice { .. }
    | Row::SetReady
    | Row::Freeze
    | Row::Abort { .. }
    | Row::Withhold { .. }
    | Row::PublishEvidence => [none, none],
  };
  Plan { pays }
}

fn fresh(s: Swap, env: &Env) -> Effects {
  Effects {
    state: s,
    payouts: Payouts::EMPTY,
    escrow_in: 0,
    counter: None,
    response_secs: None,
    volume: 0,
    withheld_volume: 0,
    open_pending: 0,
    closed: false,
    open_value_after: env.caps.open_value,
  }
}

/// Apply an allowed row. Cannot fail: no destination, cap, pause or counter can stop an exit.
pub fn execute(s: &Swap, row: Row, now: i64, env: &Env, c: &ChainConsts) -> Effects {
  execute_plan(s, row, &plan(s, row), now, env, c)
}

/// Apply an allowed row with its payout plan given. [`execute`] is this with [`plan`]`(s, row)`.
/// Of the environment it reads only which destinations can receive and the open value: no cap
/// and no pause.
pub fn execute_plan(s: &Swap, row: Row, p: &Plan, now: i64, env: &Env, c: &ChainConsts) -> Effects {
  let mut fx = fresh(*s, env);
  let mut n = *s;
  let mut any_parked = false;

  // Pay or park, in plan order.
  let mut i = 0;
  while i < MAX_PAYOUTS {
    let line = p.pays[i];
    i += 1;
    if line.amount == 0 {
      continue;
    }
    if line.owed {
      match line.to {
        Party::Taker | Party::Payout => n.owed_taker = 0,
        Party::Maker => n.owed_maker = 0,
        Party::Treasury => n.owed_treasury = 0,
      }
      fx.payouts.push(Payout { to: line.to, amount: line.amount, parked: false });
      continue;
    }
    let parked = line.park || !env.can(line.to);
    if parked {
      match line.to {
        Party::Taker | Party::Payout => n.owed_taker += line.amount,
        Party::Maker => n.owed_maker += line.amount,
        Party::Treasury => n.owed_treasury += line.amount,
      }
      any_parked = true;
    }
    fx.payouts.push(Payout { to: line.to, amount: line.amount, parked });
  }

  let mut settle: Option<u8> = None;
  let mut close = false;
  match row {
    Row::Approve | Row::Fund { .. } => {
      n.state = State::Active;
      n.t_active = now;
      n.t_note_deadline = now + s.w_n as i64;
      if let Row::Fund { watcher } = row {
        fx.escrow_in = s.amount;
        n.watcher = watcher;
      }
      fx.counter = Some(counter::APPROVALS);
      fx.response_secs = Some((now - s.t_lock) as u64);
      fx.open_pending = -1;
    }
    Row::Reject { no_fault } => {
      settle = Some(if no_fault { counter::REJECTIONS_NO_FAULT } else { counter::REJECTIONS });
      close = true;
      fx.open_pending = -1;
    }
    Row::CancelPending => {
      settle = Some(counter::PENDING_CANCELS);
      close = true;
      fx.open_pending = -1;
    }
    Row::ExpirePending { fault } => {
      settle = Some(if fault { counter::MISSED_FUNDS } else { counter::APPROVAL_TIMEOUTS });
      close = true;
      fx.open_pending = -1;
    }
    Row::PostNotice { late } => {
      n.state = State::Noticed;
      n.flags |= flag::NOTICE;
      if late {
        n.flags |= flag::LATE_NOTICE;
      }
      n.t_notice = now;
      n.t_cut = now + delta_cut(s.depth, c);
      n.t_claim_open = now + s.d_c as i64;
      fx.counter = Some(counter::NOTICES);
    }
    Row::SetReady => {
      n.state = State::Ready;
      n.t_ready = now;
      n.t_claim_deadline = now + s.w_c as i64;
      fx.counter = Some(counter::READIES);
    }
    Row::Freeze => {
      n.state = State::Frozen;
      n.t_freeze = now;
      fx.counter = Some(counter::FREEZES);
    }
    Row::AbortClose => {
      settle = Some(counter::ABORTS_PRE_NOTICE);
      close = true;
    }
    Row::Abort { hold, counter } => {
      n.state = if hold { State::AbortedHold } else { State::AbortedFree };
      fx.counter = Some(counter);
    }
    Row::RefundUnnoticed => {
      settle = Some(counter::MISSED_NOTICES);
      close = true;
    }
    Row::ExpireUnnoticed => settle = Some(counter::EXPIRED_REFUNDS),
    Row::Refund { held, counter } => {
      n.flags |= flag::REVEALED | flag::REVEALER_LOCKER;
      n.t_refund = now;
      if held {
        n.state = State::Hold;
        n.deposit_state = deposit_state::HELD;
        fx.counter = Some(counter);
      } else {
        settle = Some(counter);
      }
    }
    Row::Claim { counter } => {
      n.flags |= flag::REVEALED;
      fx.volume = s.amount;
      settle = Some(counter);
    }
    Row::ReleaseHeld => {
      n.deposit_state = deposit_state::RETURNED;
      settle = Some(counter::DEPOSITS_RETURNED);
    }
    Row::ReleaseWithheld => {
      n.deposit_state = deposit_state::RELEASED;
      settle = Some(counter::RELEASES);
    }
    Row::Withhold { evidence } => {
      if evidence {
        n.flags |= flag::EVIDENCE;
      }
      n.state = State::Withheld;
      n.deposit_state = deposit_state::WITHHELD;
      fx.counter = Some(counter::WITHHOLDS);
      fx.withheld_volume = s.deposit;
    }
    Row::Split => {
      n.deposit_state = deposit_state::SPLIT;
      settle = Some(counter::SPLITS);
    }
    Row::PublishEvidence => n.flags |= flag::EVIDENCE,
    Row::PayOwed(_) => {}
  }
  if let Some(ctr) = settle {
    n.state = State::Done;
    n.outcome = ctr;
    n.t_settled = now;
    fx.counter = Some(ctr);
    // A row marked "closed".
    fx.closed = close && !any_parked;
  }
  // SPEC 11.1: the one subtraction, at the transition that leaves the open states.
  if n.has(flag::COUNTED) && !n.state.is_open() {
    n.flags &= !flag::COUNTED;
    fx.open_value_after = close_value(env.caps.open_value, s.is_a(), s.amount, s.deposit);
  }
  fx.state = n;
  fx
}

/// `lock` (A1) and `take` (B1): the only calls a cap, a pause or `MAX_OPEN_PENDING` can refuse.
pub fn open(s: &Swap, a: &OpenArgs, caller: Role, now: i64, env: &Env, c: &ChainConsts) -> Result<Effects, GateError> {
  in_state(matches!(s.state, State::None))?;
  auth(matches!(caller, Role::TakerWallet))?;
  if env.maker_paused {
    return Err(Paused);
  }
  if a.offer_mode > mode::QUOTE {
    return Err(BadState);
  }
  if a.offer_mode == mode::ADVANCE && !a.approval {
    return Err(ApprovalRequired);
  }
  let is_a = matches!(a.direction, Direction::A);
  // SPEC 3.8: a valid approval on a WINDOW or ADVANCE offer, and a quote, are treated as AUTO.
  let effective = if a.offer_mode == mode::QUOTE || a.offer_mode == mode::AUTO {
    a.offer_mode
  } else if a.approval {
    mode::ADVANCE
  } else {
    a.offer_mode
  };
  let window = effective == mode::WINDOW;
  let pending = if c.explicit_approve || window {
    Pending::ApprovalWindow
  } else if is_a {
    Pending::None
  } else {
    Pending::FundingWindow
  };
  if let Err(b) = check_bounds(&a.params, pending, c) {
    return Err(Bound(b));
  }
  if a.amount > c.max_amount {
    return Err(MathOverflow);
  }
  // SPEC 3.1: a swap of nothing, or for nothing, is refused on both chains.
  if a.amount == 0 || a.xmr == 0 {
    return Err(AmountOutOfRange);
  }
  let p = a.params;
  if !is_a && matches!(a.payout, PayoutArg::Invalid) {
    return Err(PayoutInvalid);
  }
  if is_a && a.watcher && p.w_z == 0 {
    return Err(WatcherNotAllowed);
  }
  let deposit = deposit_of(a.amount, p.dep_bps);
  // SPEC 11.1: after the bounds, before TooManyPending.
  let open_value_after = match open_check(&env.caps, is_a, a.amount, deposit, c.max_amount) {
    Ok(v) => v,
    Err(CapError::SwapCapExceeded) => return Err(SwapCapExceeded),
    Err(CapError::OpenCapExceeded) => return Err(OpenCapExceeded),
    Err(CapError::MathOverflow) => return Err(MathOverflow),
  };
  if pending != Pending::None && env.open_pending >= c.max_open_pending {
    return Err(TooManyPending);
  }
  let mut fx = fresh(*s, env);
  let mut n = *s;
  n.direction = a.direction;
  n.mode = effective;
  n.outcome = counter::NONE;
  n.depth = p.depth;
  n.flags = flag::COUNTED;
  n.amount = a.amount;
  n.deposit = deposit;
  n.fee_bps = c.fee_bps;
  n.w_n = p.w_n;
  n.d_c = p.d_c;
  n.w_c = p.w_c;
  n.w_z = p.w_z;
  n.t_lock = now;
  n.t_final = now + p.w_f as i64;
  if is_a {
    n.payout = PayoutTo::None;
    n.watcher = a.watcher;
  } else {
    n.payout = if matches!(a.payout, PayoutArg::Other) { PayoutTo::Other } else { PayoutTo::Taker };
    n.watcher = false;
  }
  if pending == Pending::None {
    n.state = State::Active;
    n.t_active = now;
    n.t_note_deadline = now + p.w_n as i64;
  } else {
    n.state = State::Pending;
    n.t_pending_deadline = now + pending_window(&p, pending) as i64;
    fx.open_pending = 1;
  }
  if is_a {
    fx.escrow_in = a.amount;
    fx.counter = Some(counter::LOCKS);
  } else {
    fx.escrow_in = deposit;
    fx.counter = Some(counter::TAKES);
  }
  fx.open_value_after = open_value_after;
  fx.state = n;
  Ok(fx)
}

/// Apply one call. `s` is [`Swap::NONE`] for [`Call::Open`].
pub fn apply(s: &Swap, call: &Call, caller: Role, now: i64, env: &Env, c: &ChainConsts) -> Result<Effects, GateError> {
  if let Call::Open(a) = call {
    return open(s, a, caller, now, env, c);
  }
  let row = gate(s, call, caller, now, c)?;
  Ok(execute(s, row, now, env, c))
}

/// Whether a call on an existing swap would succeed. Used by clients that grey out buttons.
pub fn enabled(s: &Swap, call: &Call, caller: Role, now: i64, c: &ChainConsts) -> bool {
  gate(s, call, caller, now, c).is_ok()
}
