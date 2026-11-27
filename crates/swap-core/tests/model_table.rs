//! The table test of SPEC 2.12: every row of sections 3.4 to 3.6, written by hand from the
//! specification text and independent of the model's code. Each from-state is built as a
//! literal (never by running the model), and every expectation is a literal number.
//!
//! Canonical swap used throughout (Solana constants):
//!   amount 1,000,000   deposit D = 10,000 (1%)   fee = 500 (0.05%)   depth 2
//!   W_a 60   W_n 600   D_c 3,600   W_c 1,800   W_f 604,800
//!   Δ_cut = 15 + 2×180 + 900 = 1,275     set_ready not before t_N + 120
//! Event times, relative to t_lock = T0:
//!   T_pend T0+60 · t_A T0+20 · T_note T0+620 · t_N T0+100 · T_cut T0+1,375 · T_co T0+3,700
//!   t_R T0+1,500 · T_cd T0+3,300 · T_final T0+604,800 · T_nl T0+513,000 · T_exp T0+3,196,800
//!   t_refund T0+2,000 · T_hold T0+3,800 · T_split T0+5,186,000

use swap_core::amounts::{Caps, ChainConsts, SwapParams, ETHEREUM, SOLANA};
use swap_core::model::{
  apply, counter as c, deposit_state, flag, mode, Call, Direction, Env, Evidence, ModelError, OpenArgs, Party, PayoutArg,
  PayoutTo, RejectReason, Role, State, SwapState,
};

const T0: i64 = 1_800_000_000;
const AMOUNT: u128 = 1_000_000;
const XMR: u64 = 1_000_000_000_000;
const D: u128 = 10_000;
const FEE: u128 = 500;

const T_PEND: i64 = T0 + 60;
const T_A: i64 = T0 + 20;
const T_NOTE: i64 = T0 + 620;
const T_N: i64 = T0 + 100;
const T_RMIN: i64 = T0 + 220;
const T_CUT: i64 = T0 + 1_375;
const T_CO: i64 = T0 + 3_700;
const T_R: i64 = T0 + 1_500;
const T_CD: i64 = T0 + 3_300;
const T_FINAL: i64 = T0 + 604_800;
const T_NL: i64 = T0 + 513_000; // 604,800 − 3,600 − 1,800 − 86,400
const T_EXP: i64 = T0 + 3_196_800;
const T_REFUND: i64 = T0 + 2_000;
const T_HOLD: i64 = T0 + 3_800;
const T_SPLIT: i64 = T0 + 5_186_000;
/// SPEC 11.6: a one-day freeze window, a freeze 400 s after the lock, and `T_ff = t_Z + W_z`
/// (which is past `T_co` here; `freeze_never_shortens_the_lockers_window` covers the other case).
const W_Z: u32 = 86_400;
const T_Z: i64 = T0 + 400;
const T_FF: i64 = T0 + 86_800;

use Direction::{A, B};
use Party::{Maker, Taker, Treasury};
use Role::{Anyone, Operator, Owner, Session, TakerWallet};

/// A from-state, built by hand.
#[derive(Clone, Copy)]
struct From {
  dir: Direction,
  state: State,
  mode: u8,
  late: bool,
  deposit: u128,
  notice: bool,
  /// SPEC 11.6: the swap has a freeze window of one day; `watcher`: and names a watcher.
  w_z: u32,
  watcher: bool,
  /// SPEC 11.2: the payout address is not the taker's (direction B).
  payout_other: bool,
}
fn from(dir: Direction, state: State) -> From {
  From { dir, state, mode: mode::AUTO, late: false, deposit: D, notice: true, w_z: 0, watcher: false, payout_other: false }
}
impl From {
  fn window(mut self) -> Self {
    self.mode = mode::WINDOW;
    self
  }
  fn late(mut self) -> Self {
    self.late = true;
    self
  }
  fn no_deposit(mut self) -> Self {
    self.deposit = 0;
    self
  }
  /// HOLD reached without a notice (A10a, B9b).
  fn no_notice(mut self) -> Self {
    self.notice = false;
    self
  }
  /// A swap against an offer with a one-day freeze window that names a watcher.
  fn watched(mut self) -> Self {
    self.w_z = W_Z;
    self.watcher = true;
    self
  }
  /// A freeze window, but no watcher named.
  fn unwatched(mut self) -> Self {
    self.w_z = W_Z;
    self
  }
  fn payout_other(mut self) -> Self {
    self.payout_other = true;
    self
  }
  fn build(self) -> SwapState {
    let mut s = SwapState::NONE;
    s.state = self.state;
    s.direction = self.dir;
    s.w_z = self.w_z;
    s.watcher = self.watcher;
    s.payout = match (self.dir, self.payout_other) {
      (A, _) => PayoutTo::None,
      (B, false) => PayoutTo::Taker,
      (B, true) => PayoutTo::Other,
    };
    // An open swap is counted (SPEC 11.1).
    if self.state.is_open() {
      s.flags |= flag::COUNTED;
    }
    s.mode = self.mode;
    s.depth = 2;
    s.amount = AMOUNT;
    s.deposit = self.deposit;
    s.fee_bps = 5;
    s.w_n = 600;
    s.d_c = 3_600;
    s.w_c = 1_800;
    s.t_lock = T0;
    s.t_final = T_FINAL;
    use State::*;
    if self.state == Pending {
      s.t_pending_deadline = T_PEND;
      return s;
    }
    s.t_active = T_A;
    s.t_note_deadline = T_NOTE;
    if self.state == Active {
      return s;
    }
    let post_notice = matches!(self.state, Noticed | Ready | AbortedFree | AbortedHold | Frozen) || self.notice;
    if post_notice {
      s.flags |= flag::NOTICE;
      if self.late {
        s.flags |= flag::LATE_NOTICE;
      }
      s.t_notice = T_N;
      s.t_cut = T_CUT;
      s.t_claim_open = T_CO;
    }
    if self.state == Ready {
      s.t_ready = T_R;
      s.t_claim_deadline = T_CD;
    }
    if self.state == Frozen {
      s.t_freeze = T_Z;
    }
    if matches!(self.state, Hold | Withheld) {
      s.t_refund = T_REFUND;
      s.flags |= flag::REVEALED | flag::REVEALER_LOCKER;
      s.deposit_state = if self.state == Hold { deposit_state::HELD } else { deposit_state::WITHHELD };
    }
    s
  }
}

enum Want {
  /// New state, payouts (all paid), counter.
  Ok(State, Vec<(Party, u128)>, Option<u8>),
  Err(ModelError),
}
use Want::Err as No;

struct Row {
  id: &'static str,
  from: From,
  call: Call,
  caller: Role,
  at: i64,
  want: Want,
}

fn ok(state: State, payouts: &[(Party, u128)], counter: u8) -> Want {
  Want::Ok(state, payouts.to_vec(), Some(counter))
}

const REFUND: Call = Call::Refund { secret_ok: true };
const CLAIM: Call = Call::Claim { secret_ok: true };
const APPROVE: Call = Call::Approve { open_ok: true };
const FUND: Call = Call::Fund { open_ok: true, watcher: false };
const REJECT0: Call = Call::Reject { open_ok: true, reason: RejectReason::MakerChoice };
const REJECT1: Call = Call::Reject { open_ok: true, reason: RejectReason::UnusableInput };
const REJECT2: Call = Call::Reject { open_ok: true, reason: RejectReason::LeafConsumed };

fn row(id: &'static str, from: From, call: Call, caller: Role, at: i64, want: Want) -> Row {
  Row { id, from, call, caller, at, want }
}

#[rustfmt::skip]
fn table() -> Vec<Row> {
  use ModelError::*;
  use State::*;
  let mut t = Vec::new();
  let far = T_EXP + 10_000_000;

  // ---------------------------------------------------------------- section 3.4, direction A
  let pend = from(A, Pending).window();
  // A2 approve: operator, PENDING, now < T_appr -> ACTIVE.
  t.push(row("A2", pend, APPROVE, Operator, T0, ok(Active, &[], c::APPROVALS)));
  t.push(row("A2 last second", pend, APPROVE, Operator, T_PEND - 1, ok(Active, &[], c::APPROVALS)));
  t.push(row("A2 at T_appr", pend, APPROVE, Operator, T_PEND, No(TooLate)));
  t.push(row("A2 wrong caller", pend, APPROVE, TakerWallet, T0, No(Unauthorized)));
  t.push(row("A2 stranger", pend, APPROVE, Anyone, T0, No(Unauthorized)));
  t.push(row("A2 stale open hash (3.12)", pend, Call::Approve { open_ok: false }, Operator, T0, No(BadState)));
  t.push(row("A2 not pending", from(A, Active), APPROVE, Operator, T0 + 30, No(BadState)));
  // A3 reject: operator, PENDING (no time gate), amount to the taker, closed.
  t.push(row("A3 reason 0", pend, REJECT0, Operator, T0 + 5, ok(Done, &[(Taker, 1_000_000)], c::REJECTIONS)));
  t.push(row("A3 reason 1", pend, REJECT1, Operator, T0 + 5, ok(Done, &[(Taker, 1_000_000)], c::REJECTIONS_NO_FAULT)));
  t.push(row("A3 reason 2", pend, REJECT2, Operator, T0 + 5, ok(Done, &[(Taker, 1_000_000)], c::REJECTIONS_NO_FAULT)));
  t.push(row("A3 after T_appr", pend, REJECT0, Operator, T_PEND + 100, ok(Done, &[(Taker, 1_000_000)], c::REJECTIONS)));
  t.push(row("A3 wrong caller", pend, REJECT0, Session, T0 + 5, No(Unauthorized)));
  t.push(row("A3 stale open hash (3.12)", pend, Call::Reject { open_ok: false, reason: RejectReason::MakerChoice }, Operator, T0 + 5, No(BadState)));
  // A4 cancel_pending: taker wallet or session, any time.
  t.push(row("A4 wallet", pend, Call::CancelPending, TakerWallet, T0, ok(Done, &[(Taker, 1_000_000)], c::PENDING_CANCELS)));
  t.push(row("A4 session", pend, Call::CancelPending, Session, T_PEND + 9, ok(Done, &[(Taker, 1_000_000)], c::PENDING_CANCELS)));
  t.push(row("A4 wrong caller", pend, Call::CancelPending, Operator, T0, No(Unauthorized)));
  t.push(row("A4 stranger", pend, Call::CancelPending, Anyone, T0, No(Unauthorized)));
  t.push(row("A4 not pending", from(A, Active), Call::CancelPending, TakerWallet, T0 + 30, No(BadState)));
  // A5 expire_pending: anyone, now >= T_appr.
  t.push(row("A5 one second early", pend, Call::ExpirePending, Anyone, T_PEND - 1, No(TooEarly)));
  t.push(row("A5 at T_appr", pend, Call::ExpirePending, Anyone, T_PEND, ok(Done, &[(Taker, 1_000_000)], c::APPROVAL_TIMEOUTS)));
  t.push(row("A5 by the operator", pend, Call::ExpirePending, Operator, T_PEND + 1, ok(Done, &[(Taker, 1_000_000)], c::APPROVAL_TIMEOUTS)));
  // A6 post_notice: operator, ACTIVE, now < T_note.
  let act = from(A, Active);
  t.push(row("A6", act, Call::PostNotice, Operator, T_A, ok(Noticed, &[], c::NOTICES)));
  t.push(row("A6 last second", act, Call::PostNotice, Operator, T_NOTE - 1, ok(Noticed, &[], c::NOTICES)));
  t.push(row("A6 at T_note", act, Call::PostNotice, Operator, T_NOTE, No(TooLate)));
  t.push(row("A6 wrong caller", act, Call::PostNotice, TakerWallet, T_A, No(Unauthorized)));
  t.push(row("A6 not active", from(A, Noticed), Call::PostNotice, Operator, T_N + 1, No(BadState)));
  // A7a abort: operator, ACTIVE, now < T_note: amount to the taker at once, closed.
  t.push(row("A7a", act, Call::Abort, Operator, T_NOTE - 1, ok(Done, &[(Taker, 1_000_000)], c::ABORTS_PRE_NOTICE)));
  t.push(row("A7a at T_note", act, Call::Abort, Operator, T_NOTE, No(TooLate)));
  t.push(row("A7 wrong caller", act, Call::Abort, Session, T_A, No(Unauthorized)));
  // A7b abort: NOTICED, now < T_co -> ABORTED_FREE.
  let noticed = from(A, Noticed);
  t.push(row("A7b", noticed, Call::Abort, Operator, T_N, ok(AbortedFree, &[], c::ABORTS_EARLY)));
  t.push(row("A7b last second", noticed, Call::Abort, Operator, T_CO - 1, ok(AbortedFree, &[], c::ABORTS_EARLY)));
  // A7c abort: NOTICED, T_co <= now < T_final -> ABORTED_HOLD.
  t.push(row("A7c at T_co", noticed, Call::Abort, Operator, T_CO, ok(AbortedHold, &[], c::ABORTS_LATE)));
  t.push(row("A7c last second", noticed, Call::Abort, Operator, T_FINAL - 1, ok(AbortedHold, &[], c::ABORTS_LATE)));
  t.push(row("A7c at T_final", noticed, Call::Abort, Operator, T_FINAL, No(TooLate)));
  // A7d abort: READY, now < T_final -> ABORTED_FREE, counter missed_claims.
  let ready = from(A, Ready);
  t.push(row("A7d", ready, Call::Abort, Operator, T_R, ok(AbortedFree, &[], c::MISSED_CLAIMS)));
  t.push(row("A7d last second", ready, Call::Abort, Operator, T_FINAL - 1, ok(AbortedFree, &[], c::MISSED_CLAIMS)));
  t.push(row("A7d at T_final", ready, Call::Abort, Operator, T_FINAL, No(TooLate)));
  t.push(row("A7 twice", from(A, AbortedFree), Call::Abort, Operator, T_R, No(BadState)));
  // A8 refund_unnoticed: anyone, ACTIVE, now >= T_note.
  t.push(row("A8 one second early", act, Call::RefundUnnoticed, Anyone, T_NOTE - 1, No(TooEarly)));
  t.push(row("A8 at T_note", act, Call::RefundUnnoticed, Anyone, T_NOTE, ok(Done, &[(Taker, 1_000_000)], c::MISSED_NOTICES)));
  t.push(row("A8 after T_final", act, Call::RefundUnnoticed, Anyone, T_FINAL + 5, ok(Done, &[(Taker, 1_000_000)], c::MISSED_NOTICES)));
  t.push(row("A8 after a notice", noticed, Call::RefundUnnoticed, Anyone, T_NOTE, No(BadState)));
  // A9 set_ready: taker wallet or session, NOTICED, t_N + d×60 <= now < T_co.
  t.push(row("A9 one second early", noticed, Call::SetReady, Session, T_RMIN - 1, No(TooEarly)));
  t.push(row("A9 first second", noticed, Call::SetReady, Session, T_RMIN, ok(Ready, &[], c::READIES)));
  t.push(row("A9 wallet, last second", noticed, Call::SetReady, TakerWallet, T_CO - 1, ok(Ready, &[], c::READIES)));
  t.push(row("A9 at T_co", noticed, Call::SetReady, Session, T_CO, No(TooLate)));
  t.push(row("A9 wrong caller", noticed, Call::SetReady, Operator, T_RMIN, No(Unauthorized)));
  t.push(row("A9 not noticed", act, Call::SetReady, Session, T_A + 200, No(BadState)));
  // A10a refund: ACTIVE, now < T_note: amount − D now, D held -> HOLD.
  t.push(row("A10a", act, REFUND, Session, T_A, ok(Hold, &[(Taker, 990_000)], c::TAKER_CANCELS_APPROVED)));
  t.push(row("A10a wallet, last second", act, REFUND, TakerWallet, T_NOTE - 1, ok(Hold, &[(Taker, 990_000)], c::TAKER_CANCELS_APPROVED)));
  // A10g refund: ACTIVE, now >= T_note: amount, as A8 -> DONE, missed_notices.
  t.push(row("A10g at T_note", act, REFUND, Session, T_NOTE, ok(Done, &[(Taker, 1_000_000)], c::MISSED_NOTICES)));
  t.push(row("A10g after T_final", act, REFUND, TakerWallet, T_FINAL + 1, ok(Done, &[(Taker, 1_000_000)], c::MISSED_NOTICES)));
  t.push(row("A10 wrong caller", act, REFUND, Operator, T_A, No(Unauthorized)));
  t.push(row("A10 stranger", act, REFUND, Anyone, T_A, No(Unauthorized)));
  t.push(row("A10 wrong secret", act, Call::Refund { secret_ok: false }, Session, T_A, No(BadSecret)));
  t.push(row("A10 while pending", pend, REFUND, Session, T0, No(BadState)));
  // A10b refund: NOTICED, now < T_co -> HOLD.
  t.push(row("A10b", noticed, REFUND, Session, T_N, ok(Hold, &[(Taker, 990_000)], c::TAKER_REFUNDS_NOTICED)));
  t.push(row("A10b last second", noticed, REFUND, Session, T_CO - 1, ok(Hold, &[(Taker, 990_000)], c::TAKER_REFUNDS_NOTICED)));
  t.push(row("A10b at T_co (the maker's window)", noticed, REFUND, Session, T_CO, No(TooLate)));
  t.push(row("A10 NOTICED before T_exp", noticed, REFUND, Session, T_EXP - 1, No(TooLate)));
  // A10c refund: ABORTED_HOLD, now < T_final -> HOLD.
  let ah = from(A, AbortedHold);
  t.push(row("A10c", ah, REFUND, Session, T_CO + 10, ok(Hold, &[(Taker, 990_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("A10c last second", ah, REFUND, Session, T_FINAL - 1, ok(Hold, &[(Taker, 990_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("A10c at T_final", ah, REFUND, Session, T_FINAL, No(TooLate)));
  // A10d refund: ABORTED_FREE, now < T_final: amount -> DONE.
  let af = from(A, AbortedFree);
  t.push(row("A10d", af, REFUND, Session, T_N + 10, ok(Done, &[(Taker, 1_000_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("A10d last second", af, REFUND, TakerWallet, T_FINAL - 1, ok(Done, &[(Taker, 1_000_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("A10d at T_final", af, REFUND, Session, T_FINAL, No(TooLate)));
  // A10e refund: READY, T_cd <= now < T_final: amount -> DONE, missed_claims.
  t.push(row("A10e one second early", ready, REFUND, Session, T_CD - 1, No(TooEarly)));
  t.push(row("A10e at T_cd", ready, REFUND, Session, T_CD, ok(Done, &[(Taker, 1_000_000)], c::MISSED_CLAIMS)));
  t.push(row("A10e last second", ready, REFUND, Session, T_FINAL - 1, ok(Done, &[(Taker, 1_000_000)], c::MISSED_CLAIMS)));
  t.push(row("A10e at T_final", ready, REFUND, Session, T_FINAL, No(TooLate)));
  // A10f refund: NOTICED, READY or ABORTED_*, now >= T_exp: amount -> DONE, expired_refunds.
  for (name, f) in [("NOTICED", noticed), ("READY", ready), ("ABORTED_HOLD", ah), ("ABORTED_FREE", af)] {
    let _ = name;
    t.push(row("A10f one second early", f, REFUND, Session, T_EXP - 1, No(TooLate)));
    t.push(row("A10f at T_exp", f, REFUND, Session, T_EXP, ok(Done, &[(Taker, 1_000_000)], c::EXPIRED_REFUNDS)));
    t.push(row("A10f much later", f, REFUND, TakerWallet, far, ok(Done, &[(Taker, 1_000_000)], c::EXPIRED_REFUNDS)));
  }
  // A11a claim: operator, READY, now < T_cd: amount − fee to the maker, fee to the treasury.
  t.push(row("A11a", ready, CLAIM, Operator, T_R, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::COMPLETED)));
  t.push(row("A11a last second", ready, CLAIM, Operator, T_CD - 1, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::COMPLETED)));
  t.push(row("A11a at T_cd (the taker's window)", ready, CLAIM, Operator, T_CD, No(TooLate)));
  t.push(row("A11 READY before T_final", ready, CLAIM, Operator, T_FINAL - 1, No(TooLate)));
  t.push(row("A11 wrong caller", ready, CLAIM, Session, T_R, No(Unauthorized)));
  t.push(row("A11 stranger", ready, CLAIM, Anyone, T_R, No(Unauthorized)));
  t.push(row("A11 wrong secret", ready, Call::Claim { secret_ok: false }, Operator, T_R, No(BadSecret)));
  t.push(row("A11 without a notice", act, CLAIM, Operator, T_FINAL + 1, No(BadState)));
  // A11b claim: NOTICED, T_co <= now < T_final.
  t.push(row("A11b one second early", noticed, CLAIM, Operator, T_CO - 1, No(TooEarly)));
  t.push(row("A11b at T_co", noticed, CLAIM, Operator, T_CO, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::CLAIMS_WITHOUT_READY)));
  t.push(row("A11b last second", noticed, CLAIM, Operator, T_FINAL - 1, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::CLAIMS_WITHOUT_READY)));
  // A11c claim: NOTICED, READY or ABORTED_*, T_final <= now < T_exp.
  for f in [noticed, ready, ah, af] {
    t.push(row("A11c at T_final", f, CLAIM, Operator, T_FINAL, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::CLAIMS_AFTER_FINAL)));
    t.push(row("A11c last second", f, CLAIM, Operator, T_EXP - 1, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::CLAIMS_AFTER_FINAL)));
    t.push(row("A11c at T_exp", f, CLAIM, Operator, T_EXP, No(TooLate)));
  }
  // After an abort the claim returns only at T_final.
  t.push(row("A11 ABORTED_FREE before T_final", af, CLAIM, Operator, T_FINAL - 1, No(TooEarly)));
  t.push(row("A11 ABORTED_HOLD before T_final", ah, CLAIM, Operator, T_FINAL - 1, No(TooEarly)));
  // "When D == 0, a refund that would enter HOLD goes straight to DONE."
  t.push(row("A10a D == 0", act.no_deposit(), REFUND, Session, T_A, ok(Done, &[(Taker, 1_000_000)], c::TAKER_CANCELS_APPROVED)));
  t.push(row("A10b D == 0", noticed.no_deposit(), REFUND, Session, T_N, ok(Done, &[(Taker, 1_000_000)], c::TAKER_REFUNDS_NOTICED)));
  t.push(row("A10c D == 0", ah.no_deposit(), REFUND, Session, T_CO + 1, ok(Done, &[(Taker, 1_000_000)], c::REFUNDS_AFTER_ABORT)));
  // Direction-A-only and direction-B-only calls.
  t.push(row("fund in A", pend, FUND, Operator, T0, No(WrongDirection)));
  t.push(row("expire_unnoticed in A", act, Call::ExpireUnnoticed, Anyone, T_EXP, No(WrongDirection)));

  // ---------------------------------------------------------------- section 3.5, direction B
  // The maker escrows amount; the taker posted the take deposit Dp = 10,000.
  let bpend = from(B, Pending);          // auto mode: T_fund = t + W_n on Solana
  let bpend_w = from(B, Pending).window();
  // B2 cancel_pending: Dp to the taker.
  t.push(row("B2 wallet", bpend, Call::CancelPending, TakerWallet, T0 + 1, ok(Done, &[(Taker, 10_000)], c::PENDING_CANCELS)));
  t.push(row("B2 session", bpend_w, Call::CancelPending, Session, T0 + 1, ok(Done, &[(Taker, 10_000)], c::PENDING_CANCELS)));
  t.push(row("B2 wrong caller", bpend, Call::CancelPending, Operator, T0 + 1, No(Unauthorized)));
  // B3 reject: window mode only.
  t.push(row("B3 window", bpend_w, REJECT0, Operator, T0 + 1, ok(Done, &[(Taker, 10_000)], c::REJECTIONS)));
  t.push(row("B3 window, reason 1", bpend_w, REJECT1, Operator, T0 + 1, ok(Done, &[(Taker, 10_000)], c::REJECTIONS_NO_FAULT)));
  t.push(row("B3 outside window mode", bpend, REJECT0, Operator, T0 + 1, No(BadState)));
  t.push(row("B3 wrong caller", bpend_w, REJECT0, TakerWallet, T0 + 1, No(Unauthorized)));
  // B4 expire_pending: window mode approval_timeouts, otherwise the fault missed_funds.
  t.push(row("B4 one second early", bpend, Call::ExpirePending, Anyone, T_PEND - 1, No(TooEarly)));
  t.push(row("B4 auto", bpend, Call::ExpirePending, Anyone, T_PEND, ok(Done, &[(Taker, 10_000)], c::MISSED_FUNDS)));
  t.push(row("B4 window", bpend_w, Call::ExpirePending, Anyone, T_PEND, ok(Done, &[(Taker, 10_000)], c::APPROVAL_TIMEOUTS)));
  // B5 fund: operator, PENDING, now < T_fund.
  t.push(row("B5", bpend, FUND, Operator, T0 + 1, ok(Active, &[], c::APPROVALS)));
  t.push(row("B5 last second", bpend, FUND, Operator, T_PEND - 1, ok(Active, &[], c::APPROVALS)));
  t.push(row("B5 at T_fund", bpend, FUND, Operator, T_PEND, No(TooLate)));
  t.push(row("B5 wrong caller", bpend, FUND, TakerWallet, T0 + 1, No(Unauthorized)));
  t.push(row("B5 stale open hash (3.12)", bpend, Call::Fund { open_ok: false, watcher: false }, Operator, T0 + 1, No(BadState)));
  t.push(row("approve in B", bpend, APPROVE, Operator, T0 + 1, No(WrongDirection)));
  // B6 post_notice: taker wallet or session, ACTIVE, now < T_nl; late from T_note.
  let bact = from(B, Active);
  t.push(row("B6", bact, Call::PostNotice, Session, T_A, ok(Noticed, &[], c::NOTICES)));
  t.push(row("B6 last on-time second", bact, Call::PostNotice, TakerWallet, T_NOTE - 1, ok(Noticed, &[], c::NOTICES)));
  t.push(row("B6 late, at T_note", bact, Call::PostNotice, Session, T_NOTE, ok(Noticed, &[], c::NOTICES)));
  t.push(row("B6 late, last second", bact, Call::PostNotice, Session, T_NL - 1, ok(Noticed, &[], c::NOTICES)));
  t.push(row("B6 at T_nl", bact, Call::PostNotice, Session, T_NL, No(TooLate)));
  t.push(row("B6 wrong caller", bact, Call::PostNotice, Operator, T_A, No(Unauthorized)));
  // B7 set_ready: operator.
  let bnot = from(B, Noticed);
  t.push(row("B7 one second early", bnot, Call::SetReady, Operator, T_RMIN - 1, No(TooEarly)));
  t.push(row("B7 first second", bnot, Call::SetReady, Operator, T_RMIN, ok(Ready, &[], c::READIES)));
  t.push(row("B7 last second", bnot, Call::SetReady, Operator, T_CO - 1, ok(Ready, &[], c::READIES)));
  t.push(row("B7 at T_co", bnot, Call::SetReady, Operator, T_CO, No(TooLate)));
  t.push(row("B7 wrong caller", bnot, Call::SetReady, Session, T_RMIN, No(Unauthorized)));
  // B8 abort: taker wallet or session, NOTICED or READY, now < T_final -> ABORTED_HOLD.
  let bready = from(B, Ready);
  t.push(row("B8 noticed", bnot, Call::Abort, Session, T_N, ok(AbortedHold, &[], c::TAKER_ABORTS)));
  t.push(row("B8 ready", bready, Call::Abort, TakerWallet, T_FINAL - 1, ok(AbortedHold, &[], c::TAKER_ABORTS)));
  t.push(row("B8 at T_final", bready, Call::Abort, Session, T_FINAL, No(TooLate)));
  t.push(row("B8 wrong caller", bnot, Call::Abort, Operator, T_N, No(Unauthorized)));
  t.push(row("B8 before a notice", bact, Call::Abort, Session, T_A, No(BadState)));
  // B9a refund: operator, ACTIVE, now < T_note: amount to the maker, Dp to the taker at once.
  t.push(row("B9a", bact, REFUND, Operator, T_A, ok(Done, &[(Maker, 1_000_000), (Taker, 10_000)], c::BACKOUTS_PRE_NOTICE)));
  t.push(row("B9a last second", bact, REFUND, Operator, T_NOTE - 1, ok(Done, &[(Maker, 1_000_000), (Taker, 10_000)], c::BACKOUTS_PRE_NOTICE)));
  // B9b refund: ACTIVE, now >= T_note: Dp held.
  t.push(row("B9b at T_note", bact, REFUND, Operator, T_NOTE, ok(Hold, &[(Maker, 1_000_000)], c::TAKER_NO_NOTICE)));
  t.push(row("B9b after T_final", bact, REFUND, Operator, T_FINAL + 7, ok(Hold, &[(Maker, 1_000_000)], c::TAKER_NO_NOTICE)));
  t.push(row("B9 wrong caller", bact, REFUND, Session, T_A, No(Unauthorized)));
  t.push(row("B9 wrong secret", bact, Call::Refund { secret_ok: false }, Operator, T_A, No(BadSecret)));
  // B9c refund: NOTICED, notice on time, now < T_cut: Dp to the taker at once.
  t.push(row("B9c", bnot, REFUND, Operator, T_N, ok(Done, &[(Maker, 1_000_000), (Taker, 10_000)], c::BACKOUTS_POST_NOTICE)));
  t.push(row("B9c last second", bnot, REFUND, Operator, T_CUT - 1, ok(Done, &[(Maker, 1_000_000), (Taker, 10_000)], c::BACKOUTS_POST_NOTICE)));
  // B9h refund: NOTICED, late notice, now < T_cut: Dp held.
  t.push(row("B9h", bnot.late(), REFUND, Operator, T_N, ok(Hold, &[(Maker, 1_000_000)], c::TAKER_NO_NOTICE)));
  t.push(row("B9h last second", bnot.late(), REFUND, Operator, T_CUT - 1, ok(Hold, &[(Maker, 1_000_000)], c::TAKER_NO_NOTICE)));
  // B9d refund: NOTICED, T_cut <= now < T_co: Dp held.
  t.push(row("B9d at T_cut", bnot, REFUND, Operator, T_CUT, ok(Hold, &[(Maker, 1_000_000)], c::REFUNDS_UNCONFIRMED)));
  t.push(row("B9d late notice", bnot.late(), REFUND, Operator, T_CUT, ok(Hold, &[(Maker, 1_000_000)], c::REFUNDS_UNCONFIRMED)));
  t.push(row("B9d last second", bnot, REFUND, Operator, T_CO - 1, ok(Hold, &[(Maker, 1_000_000)], c::REFUNDS_UNCONFIRMED)));
  t.push(row("B9d at T_co (the taker's window)", bnot, REFUND, Operator, T_CO, No(TooLate)));
  // B9e refund: READY, T_cd <= now < T_final: Dp held.
  t.push(row("B9e one second early", bready, REFUND, Operator, T_CD - 1, No(TooEarly)));
  t.push(row("B9e at T_cd", bready, REFUND, Operator, T_CD, ok(Hold, &[(Maker, 1_000_000)], c::TAKER_MISSED_CLAIMS)));
  t.push(row("B9e last second", bready, REFUND, Operator, T_FINAL - 1, ok(Hold, &[(Maker, 1_000_000)], c::TAKER_MISSED_CLAIMS)));
  t.push(row("B9e at T_final", bready, REFUND, Operator, T_FINAL, No(TooLate)));
  // B9f refund: ABORTED_HOLD, now < T_final: Dp held.
  let bah = from(B, AbortedHold);
  t.push(row("B9f", bah, REFUND, Operator, T_N + 5, ok(Hold, &[(Maker, 1_000_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("B9f last second", bah, REFUND, Operator, T_FINAL - 1, ok(Hold, &[(Maker, 1_000_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("B9f at T_final", bah, REFUND, Operator, T_FINAL, No(TooLate)));
  // B9g refund: NOTICED, READY or ABORTED_HOLD, now >= T_exp: Dp to the taker.
  for f in [bnot, bnot.late(), bready, bah] {
    t.push(row("B9g one second early", f, REFUND, Operator, T_EXP - 1, No(TooLate)));
    t.push(row("B9g at T_exp", f, REFUND, Operator, T_EXP, ok(Done, &[(Maker, 1_000_000), (Taker, 10_000)], c::EXPIRED_REFUNDS)));
  }
  // B10a claim: taker wallet or session, READY, now < T_cd: amount − fee + Dp to the taker.
  t.push(row("B10a", bready, CLAIM, Session, T_R, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::COMPLETED)));
  t.push(row("B10a wallet, last second", bready, CLAIM, TakerWallet, T_CD - 1, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::COMPLETED)));
  t.push(row("B10a at T_cd (the maker's window)", bready, CLAIM, Session, T_CD, No(TooLate)));
  t.push(row("B10 wrong caller", bready, CLAIM, Operator, T_R, No(Unauthorized)));
  t.push(row("B10 wrong secret", bready, Call::Claim { secret_ok: false }, Session, T_R, No(BadSecret)));
  t.push(row("B10 without a notice", bact, CLAIM, Session, T_FINAL, No(BadState)));
  // B10b claim: NOTICED, T_co <= now < T_final.
  t.push(row("B10b one second early", bnot, CLAIM, Session, T_CO - 1, No(TooEarly)));
  t.push(row("B10b at T_co", bnot, CLAIM, Session, T_CO, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::TAKER_CLAIMS_WITHOUT_READY)));
  t.push(row("B10b late notice", bnot.late(), CLAIM, Session, T_CO, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::TAKER_CLAIMS_WITHOUT_READY)));
  t.push(row("B10b last second", bnot, CLAIM, Session, T_FINAL - 1, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::TAKER_CLAIMS_WITHOUT_READY)));
  // B10c claim: NOTICED, READY or ABORTED_HOLD, T_final <= now < T_exp.
  for f in [bnot, bready, bah] {
    t.push(row("B10c at T_final", f, CLAIM, Session, T_FINAL, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::CLAIMS_AFTER_FINAL)));
    t.push(row("B10c last second", f, CLAIM, TakerWallet, T_EXP - 1, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::CLAIMS_AFTER_FINAL)));
    t.push(row("B10c at T_exp", f, CLAIM, Session, T_EXP, No(TooLate)));
  }
  t.push(row("B10 ABORTED_HOLD before T_final", bah, CLAIM, Session, T_FINAL - 1, No(TooEarly)));
  // D == 0 on every held-refund row of direction B.
  t.push(row("B9b D == 0", bact.no_deposit(), REFUND, Operator, T_NOTE, ok(Done, &[(Maker, 1_000_000)], c::TAKER_NO_NOTICE)));
  t.push(row("B9h D == 0", bnot.late().no_deposit(), REFUND, Operator, T_N, ok(Done, &[(Maker, 1_000_000)], c::TAKER_NO_NOTICE)));
  t.push(row("B9d D == 0", bnot.no_deposit(), REFUND, Operator, T_CUT, ok(Done, &[(Maker, 1_000_000)], c::REFUNDS_UNCONFIRMED)));
  t.push(row("B9e D == 0", bready.no_deposit(), REFUND, Operator, T_CD, ok(Done, &[(Maker, 1_000_000)], c::TAKER_MISSED_CLAIMS)));
  t.push(row("B9f D == 0", bah.no_deposit(), REFUND, Operator, T_N + 5, ok(Done, &[(Maker, 1_000_000)], c::REFUNDS_AFTER_ABORT)));
  t.push(row("refund_unnoticed in B", bact, Call::RefundUnnoticed, Anyone, T_NOTE, No(WrongDirection)));

  // ---------------------------------------------------------------- section 3.6, deposit
  for dir in [A, B] {
    let hold = from(dir, Hold);
    let withheld = from(dir, Withheld);
    // release_deposit: anyone at T_hold; the operator before it.
    t.push(row("release one second early, stranger", hold, Call::ReleaseDeposit, Anyone, T_HOLD - 1, No(TooEarly)));
    t.push(row("release one second early, taker", hold, Call::ReleaseDeposit, TakerWallet, T_HOLD - 1, No(TooEarly)));
    t.push(row("release at T_hold, stranger", hold, Call::ReleaseDeposit, Anyone, T_HOLD, ok(Done, &[(Taker, 10_000)], c::DEPOSITS_RETURNED)));
    t.push(row("release before T_hold, operator", hold, Call::ReleaseDeposit, Operator, T_REFUND, ok(Done, &[(Taker, 10_000)], c::DEPOSITS_RETURNED)));
    // release_deposit: operator, WITHHELD, any time -> releases.
    t.push(row("release withheld", withheld, Call::ReleaseDeposit, Operator, T_HOLD + 99, ok(Done, &[(Taker, 10_000)], c::RELEASES)));
    t.push(row("release withheld, long after", withheld, Call::ReleaseDeposit, Operator, T_SPLIT + 99, ok(Done, &[(Taker, 10_000)], c::RELEASES)));
    t.push(row("release withheld, stranger", withheld, Call::ReleaseDeposit, Anyone, T_HOLD + 99, No(Unauthorized)));
    t.push(row("release withheld, taker", withheld, Call::ReleaseDeposit, TakerWallet, T_HOLD + 99, No(Unauthorized)));
    // withhold: operator, HOLD, now < T_hold.
    t.push(row("withhold wrong caller", hold, Call::Withhold(Evidence::Opens), Anyone, T_REFUND, No(Unauthorized)));
    t.push(row("withhold at T_hold", hold, Call::Withhold(Evidence::Opens), Operator, T_HOLD, No(TooLate)));
    t.push(row("withhold twice", withheld, Call::Withhold(Evidence::Opens), Operator, T_REFUND, No(BadState)));
    // split_deposit: anyone, WITHHELD, now >= T_split: ceil(D/2) taker, floor(D/2) treasury.
    t.push(row("split one second early", withheld, Call::SplitDeposit, Anyone, T_SPLIT - 1, No(TooEarly)));
    t.push(row("split at T_split", withheld, Call::SplitDeposit, Anyone, T_SPLIT, ok(Done, &[(Taker, 5_000), (Treasury, 5_000)], c::SPLITS)));
    t.push(row("split of a held deposit", hold, Call::SplitDeposit, Anyone, T_SPLIT, No(BadState)));
  }
  // Direction A with a notice on record: evidence MUST open the commitment.
  let ahold = from(A, Hold);
  t.push(row("withhold A, evidence opens", ahold, Call::Withhold(Evidence::Opens), Operator, T_HOLD - 1, ok(Withheld, &[], c::WITHHOLDS)));
  t.push(row("withhold A, no evidence", ahold, Call::Withhold(Evidence::Absent), Operator, T_REFUND, No(EvidenceRequired)));
  t.push(row("withhold A, wrong evidence", ahold, Call::Withhold(Evidence::Mismatch), Operator, T_REFUND, No(EvidenceMismatch)));
  // Otherwise no evidence: A without a notice (after A10a), and direction B.
  t.push(row("withhold A, no notice on record", ahold.no_notice(), Call::Withhold(Evidence::Absent), Operator, T_REFUND, ok(Withheld, &[], c::WITHHOLDS)));
  t.push(row("withhold B", from(B, Hold), Call::Withhold(Evidence::Absent), Operator, T_HOLD - 1, ok(Withheld, &[], c::WITHHOLDS)));
  t.push(row("withhold B, no notice", from(B, Hold).no_notice(), Call::Withhold(Evidence::Absent), Operator, T_REFUND, ok(Withheld, &[], c::WITHHOLDS)));
  // publish_evidence: the claimer, NOTICED or later; must open the commitment; state unchanged.
  for st in [Noticed, Ready, AbortedFree, AbortedHold, Hold, Withheld] {
    t.push(row("publish A", from(A, st), Call::PublishEvidence { opens: true }, Operator, T_CO, Want::Ok(st, vec![], Option::None)));
    t.push(row("publish A wrong caller", from(A, st), Call::PublishEvidence { opens: true }, Session, T_CO, No(Unauthorized)));
    t.push(row("publish A mismatch", from(A, st), Call::PublishEvidence { opens: false }, Operator, T_CO, No(EvidenceMismatch)));
  }
  for st in [Noticed, Ready, AbortedHold, Hold, Withheld] {
    t.push(row("publish B", from(B, st), Call::PublishEvidence { opens: true }, Session, T_CO, Want::Ok(st, vec![], Option::None)));
    t.push(row("publish B wallet", from(B, st), Call::PublishEvidence { opens: true }, TakerWallet, T_CO, Want::Ok(st, vec![], Option::None)));
    t.push(row("publish B wrong caller", from(B, st), Call::PublishEvidence { opens: true }, Operator, T_CO, No(Unauthorized)));
  }
  t.push(row("publish before a notice", from(A, Active), Call::PublishEvidence { opens: true }, Operator, T_A, No(BadState)));
  t.push(row("publish, hold without notice", from(A, Hold).no_notice(), Call::PublishEvidence { opens: true }, Operator, T_REFUND, No(BadState)));
  t
}

fn run(rows: &[Row], consts: &ChainConsts) {
  for r in rows {
    let s = r.from.build();
    let got = apply(s, r.call, r.caller, r.at, &Env::OK, consts);
    let label = format!("{} [{:?} {:?} {} by {:?} at T0{:+}]", r.id, r.from.dir, r.from.state, r.call.name(), r.caller, r.at - T0);
    match (&r.want, got) {
      (Want::Err(e), Err(g)) => assert_eq!(*e, g, "{label}"),
      (Want::Err(e), Ok(fx)) => panic!("{label}: expected {e:?}, got state {:?}", fx.state.state),
      (Want::Ok(..), Err(g)) => panic!("{label}: expected success, got {g:?}"),
      (Want::Ok(state, payouts, counter), Ok(fx)) => {
        assert_eq!(fx.state.state, *state, "{label}: state");
        let paid: Vec<(Party, u128)> = fx.payouts.iter().map(|p| (p.to, p.amount)).collect();
        assert_eq!(&paid, payouts, "{label}: payouts");
        assert!(fx.payouts.iter().all(|p| !p.parked), "{label}: nothing is parked when everyone can receive");
        assert_eq!(fx.counter, *counter, "{label}: counter");
        // Escrow conservation: what leaves escrow never exceeds what is in it.
        let escrow = if r.from.dir == A { AMOUNT } else { AMOUNT + r.from.deposit };
        let out: u128 = fx.payouts.iter().map(|p| p.amount).sum();
        assert!(out <= escrow, "{label}: pays more than the escrow holds");
      }
    }
  }
}

#[test]
fn every_row_of_sections_3_4_to_3_6() {
  let rows = table();
  assert!(rows.len() > 250, "{} rows", rows.len());
  run(&rows, &SOLANA);
}

/// The same table under the Ethereum switches: only the rows the switches touch change.
#[test]
fn ethereum_switches() {
  use ModelError::*;
  use State::*;
  // The canonical swap's D_c and W_c are below Ethereum's floors, but gates read only the stored
  // deadlines, so the literal states still exercise the machine. What changes:
  let secret_rows = |r: &Row| matches!(r.call, Call::Refund { .. } | Call::Claim { .. });
  let mut rows: Vec<Row> = table()
    .into_iter()
    // open_secret_calls: a wrong caller of claim/refund is no longer an error (rewritten below).
    .filter(|r| !(secret_rows(r) && matches!(r.want, Want::Err(Unauthorized))))
    // lapse_is_fault = false and "B3 always available under EXPLICIT_APPROVE" (rewritten below).
    .filter(|r| r.id != "B4 auto" && r.id != "B3 outside window mode")
    .collect();
  let bpend = from(B, Pending);
  rows.push(row("B4 auto on Ethereum", bpend, Call::ExpirePending, Anyone, T_PEND, ok(Done, &[(Taker, 10_000)], c::APPROVAL_TIMEOUTS)));
  rows.push(row("B3 on Ethereum", bpend, REJECT0, Operator, T0 + 1, ok(Done, &[(Taker, 10_000)], c::REJECTIONS)));
  // Anyone may submit a claim or refund; the destination is fixed.
  rows.push(row("claim by a stranger", from(A, Ready), CLAIM, Anyone, T_R, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::COMPLETED)));
  rows.push(row("claim by the taker", from(A, Ready), CLAIM, Session, T_R, ok(Done, &[(Maker, 999_500), (Treasury, 500)], c::COMPLETED)));
  rows.push(row("refund by a stranger", from(A, Active), REFUND, Anyone, T_A, ok(Hold, &[(Taker, 990_000)], c::TAKER_CANCELS_APPROVED)));
  rows.push(row("refund by the operator", from(A, Active), REFUND, Operator, T_A, ok(Hold, &[(Taker, 990_000)], c::TAKER_CANCELS_APPROVED)));
  rows.push(row("B claim by a stranger", from(B, Ready), CLAIM, Anyone, T_R, ok(Done, &[(Taker, 1_009_500), (Treasury, 500)], c::COMPLETED)));
  rows.push(row("B refund by a stranger", from(B, Active), REFUND, Anyone, T_A, ok(Done, &[(Maker, 1_000_000), (Taker, 10_000)], c::BACKOUTS_PRE_NOTICE)));
  // ...but the secret is still required, and the windows still apply.
  rows.push(row("stranger, wrong secret", from(A, Ready), Call::Claim { secret_ok: false }, Anyone, T_R, No(BadSecret)));
  rows.push(row("stranger, wrong window", from(A, Ready), REFUND, Anyone, T_R, No(TooEarly)));
  // Only the session key or wallet may set ready, cancel, and (B) post the notice or abort.
  rows.push(row("set_ready by a stranger", from(A, Noticed), Call::SetReady, Anyone, T_RMIN, No(Unauthorized)));
  // HOLD_SECS, SPLIT_SECS and EXPIRY_SECS are equal on both chains, so every other row is unchanged.
  run(&rows, &ETHEREUM);
}

fn params() -> SwapParams {
  SwapParams { w_a: 60, w_n: 600, d_c: 3_600, w_c: 1_800, w_f: 604_800, depth: 2, dep_bps: 100, w_z: 0 }
}
/// Parameters inside the chain's bounds (Ethereum's floors are higher), with the same 1% deposit.
fn params_on(chain: &ChainConsts) -> SwapParams {
  if chain.explicit_approve {
    SwapParams { w_a: 120, w_n: 1_800, d_c: 10_800, w_c: 5_400, w_f: 604_800, depth: 10, dep_bps: 100, w_z: 0 }
  } else {
    params()
  }
}
fn open(direction: Direction, offer_mode: u8, approval: bool) -> Call {
  Call::Open(OpenArgs { direction, offer_mode, approval, xmr: XMR, amount: AMOUNT, params: params(), payout: PayoutArg::Taker, watcher: false })
}

/// A1, B1 and the approval-mode table of section 3.8, Solana.
#[test]
fn opening_a_swap_solana() {
  use State::*;
  let go = |call| apply(SwapState::NONE, call, TakerWallet, T0, &Env::OK, &SOLANA);
  // AUTO, direction A: ACTIVE at lock.
  let fx = go(open(A, mode::AUTO, false)).unwrap();
  assert_eq!(fx.state.state, Active);
  assert_eq!(fx.counter, Some(c::LOCKS));
  assert_eq!(fx.escrow_in, 1_000_000);
  assert_eq!(fx.state.deposit, 10_000);
  assert_eq!((fx.state.t_lock, fx.state.t_active, fx.state.t_note_deadline, fx.state.t_final), (T0, T0, T0 + 600, T0 + 604_800));
  assert_eq!(fx.state.t_pending_deadline, 0);
  assert_eq!(fx.open_pending, 0);
  assert_eq!(fx.state.outcome, 0xff);
  // WINDOW without an approval: PENDING with T_appr = t + W_a.
  let fx = go(open(A, mode::WINDOW, false)).unwrap();
  assert_eq!(fx.state.state, Pending);
  assert_eq!(fx.state.t_pending_deadline, T0 + 60);
  assert_eq!((fx.state.t_active, fx.state.t_note_deadline), (0, 0));
  assert_eq!(fx.open_pending, 1);
  assert_eq!(fx.state.mode, mode::WINDOW);
  // WINDOW with a valid advance approval: treated as AUTO.
  let fx = go(open(A, mode::WINDOW, true)).unwrap();
  assert_eq!(fx.state.state, Active);
  // ADVANCE without one: refused. With one: treated as AUTO.
  assert_eq!(go(open(A, mode::ADVANCE, false)), Err(ModelError::ApprovalRequired));
  assert_eq!(go(open(A, mode::ADVANCE, true)).unwrap().state.state, Active);
  // Taker-bound quote: treated as AUTO.
  let fx = go(open(A, mode::QUOTE, false)).unwrap();
  assert_eq!((fx.state.state, fx.state.mode), (Active, mode::QUOTE));

  // Direction B is always PENDING; only the deposit moves in.
  let fx = go(open(B, mode::AUTO, false)).unwrap();
  assert_eq!(fx.state.state, Pending);
  assert_eq!(fx.counter, Some(c::TAKES));
  assert_eq!(fx.escrow_in, 10_000);
  // Outside window mode T_fund = t_take + W_n.
  assert_eq!(fx.state.t_pending_deadline, T0 + 600);
  // In window mode T_fund = t_take + W_a.
  assert_eq!(go(open(B, mode::WINDOW, false)).unwrap().state.t_pending_deadline, T0 + 60);
  // WINDOW or ADVANCE with an approval, and a quote: treated as AUTO.
  assert_eq!(go(open(B, mode::WINDOW, true)).unwrap().state.t_pending_deadline, T0 + 600);
  assert_eq!(go(open(B, mode::ADVANCE, true)).unwrap().state.t_pending_deadline, T0 + 600);
  assert_eq!(go(open(B, mode::QUOTE, false)).unwrap().state.t_pending_deadline, T0 + 600);
  assert_eq!(go(open(B, mode::ADVANCE, false)), Err(ModelError::ApprovalRequired));

  // Only the taker's wallet opens a swap, and only where none exists.
  for caller in [Session, Operator, Anyone, Owner] {
    assert_eq!(apply(SwapState::NONE, open(A, mode::AUTO, false), caller, T0, &Env::OK, &SOLANA), Err(ModelError::Unauthorized));
  }
  let existing = from(A, Active).build();
  assert_eq!(apply(existing, open(A, mode::AUTO, false), TakerWallet, T0, &Env::OK, &SOLANA), Err(ModelError::BadState));
  // MAX_OPEN_PENDING: the 65th pending swap is refused; a swap that starts ACTIVE is not counted.
  let full = Env { open_pending: 64, ..Env::OK };
  assert_eq!(apply(SwapState::NONE, open(A, mode::WINDOW, false), TakerWallet, T0, &full, &SOLANA), Err(ModelError::TooManyPending));
  assert_eq!(apply(SwapState::NONE, open(B, mode::AUTO, false), TakerWallet, T0, &full, &SOLANA), Err(ModelError::TooManyPending));
  assert!(apply(SwapState::NONE, open(A, mode::AUTO, false), TakerWallet, T0, &full, &SOLANA).is_ok());
  let almost = Env { open_pending: 63, ..Env::OK };
  assert!(apply(SwapState::NONE, open(A, mode::WINDOW, false), TakerWallet, T0, &almost, &SOLANA).is_ok());
}

/// Section 3.8, last paragraph: under EXPLICIT_APPROVE every accepted swap starts PENDING with
/// W_p = W_a.
#[test]
fn opening_a_swap_ethereum() {
  use State::*;
  let p = SwapParams { w_a: 120, w_n: 1_800, d_c: 10_800, w_c: 5_400, w_f: 604_800, depth: 10, dep_bps: 100, w_z: 0 };
  let go = |direction, offer_mode, approval| {
    apply(SwapState::NONE, Call::Open(OpenArgs { direction, offer_mode, approval, xmr: XMR, amount: AMOUNT, params: p, payout: PayoutArg::Taker, watcher: false }), TakerWallet, T0, &Env::OK, &ETHEREUM)
  };
  for dir in [A, B] {
    for (m, approval) in [(mode::AUTO, false), (mode::WINDOW, false), (mode::WINDOW, true), (mode::ADVANCE, true), (mode::QUOTE, false)] {
      let fx = go(dir, m, approval).unwrap();
      assert_eq!(fx.state.state, Pending, "{dir:?} mode {m}");
      assert_eq!(fx.state.t_pending_deadline, T0 + 120);
      assert_eq!(fx.open_pending, 1);
    }
    assert_eq!(go(dir, mode::ADVANCE, false), Err(ModelError::ApprovalRequired));
  }
  // Δ_cut on Ethereum at depth 10 is 1,200 + 1,800 + 900 = 3,900.
  let mut s = go(A, mode::AUTO, false).unwrap().state;
  s = apply(s, APPROVE, Operator, T0 + 12, &Env::OK, &ETHEREUM).unwrap().state;
  assert_eq!(s.t_note_deadline, T0 + 12 + 1_800);
  s = apply(s, Call::PostNotice, Operator, T0 + 1_500, &Env::OK, &ETHEREUM).unwrap().state;
  assert_eq!((s.t_notice, s.t_cut, s.t_claim_open), (T0 + 1_500, T0 + 5_400, T0 + 12_300));
}

/// What each transition writes besides the state: timestamps, flags, deposit state, outcome.
#[test]
fn recorded_fields() {
  use State::*;
  let go = |f: From, call, caller, at| apply(f.build(), call, caller, at, &Env::OK, &SOLANA).unwrap();
  // A2 sets t_A and T_note; response time is now − t_lock; the pending count drops.
  let fx = go(from(A, Pending).window(), APPROVE, Operator, T0 + 37);
  assert_eq!((fx.state.t_active, fx.state.t_note_deadline), (T0 + 37, T0 + 637));
  assert_eq!(fx.response_secs, Some(37));
  assert_eq!(fx.open_pending, -1);
  // B5 moves the maker's amount in.
  let fx = go(from(B, Pending), FUND, Operator, T0 + 5);
  assert_eq!(fx.escrow_in, 1_000_000);
  assert_eq!(fx.response_secs, Some(5));
  // A6 sets t_N, T_cut = t_N + 1,275, T_co = t_N + 3,600 and flag bit 0.
  let fx = go(from(A, Active), Call::PostNotice, Operator, T0 + 300);
  assert_eq!((fx.state.t_notice, fx.state.t_cut, fx.state.t_claim_open), (T0 + 300, T0 + 1_575, T0 + 3_900));
  // (Amendment 1: an open swap also carries flag bit 5, "counted in the open value".)
  assert_eq!(fx.state.flags, flag::NOTICE | flag::COUNTED);
  // B6 at or after T_note sets the late-notice flag as well.
  assert_eq!(go(from(B, Active), Call::PostNotice, Session, T_NOTE - 1).state.flags, flag::NOTICE | flag::COUNTED);
  assert_eq!(go(from(B, Active), Call::PostNotice, Session, T_NOTE).state.flags, flag::NOTICE | flag::LATE_NOTICE | flag::COUNTED);
  // A9 sets t_R and T_cd = t_R + 1,800.
  let fx = go(from(A, Noticed), Call::SetReady, Session, T0 + 900);
  assert_eq!((fx.state.t_ready, fx.state.t_claim_deadline), (T0 + 900, T0 + 2_700));
  // A refund writes flag bits 2 and 3, t_refund, and (held) deposit state 1.
  let fx = go(from(A, Noticed), REFUND, Session, T0 + 500);
  assert_eq!(fx.state.flags, flag::NOTICE | flag::REVEALED | flag::REVEALER_LOCKER);
  assert_eq!((fx.state.t_refund, fx.state.deposit_state, fx.state.outcome), (T0 + 500, deposit_state::HELD, 0xff));
  // T_split is fixed at the refund.
  assert_eq!(fx.state.t_split(&SOLANA), T0 + 500 + 5_184_000);
  assert_eq!(fx.state.t_hold(&SOLANA), T0 + 500 + 1_800);
  // A claim writes flag bit 2 only, the volume, the outcome and t_settled.
  let fx = go(from(A, Ready), CLAIM, Operator, T_R + 1);
  assert_eq!(fx.state.flags, flag::NOTICE | flag::REVEALED);
  assert_eq!((fx.volume, fx.state.outcome, fx.state.t_settled), (1_000_000, c::COMPLETED, T_R + 1));
  // Withhold stores the evidence flag, the withheld volume and deposit state 2.
  let fx = go(from(A, Hold), Call::Withhold(Evidence::Opens), Operator, T_REFUND + 1);
  assert_eq!(fx.withheld_volume, 10_000);
  assert_eq!(fx.state.deposit_state, deposit_state::WITHHELD);
  assert!(fx.state.has(flag::EVIDENCE));
  // Deposit end states: 3 returned, 4 released by the maker, 5 split.
  assert_eq!(go(from(A, Hold), Call::ReleaseDeposit, Anyone, T_HOLD).state.deposit_state, deposit_state::RETURNED);
  assert_eq!(go(from(A, Withheld), Call::ReleaseDeposit, Operator, T_HOLD).state.deposit_state, deposit_state::RELEASED);
  assert_eq!(go(from(A, Withheld), Call::SplitDeposit, Anyone, T_SPLIT).state.deposit_state, deposit_state::SPLIT);
  // publish_evidence sets flag bit 1 and nothing else.
  let before = from(A, Ready).build();
  let fx = go(from(A, Ready), Call::PublishEvidence { opens: true }, Operator, T_R + 5);
  let mut expect = before;
  expect.flags |= flag::EVIDENCE;
  assert_eq!(fx.state, expect);
  // Rows marked "closed" report it; rows that end in DONE with the account kept do not.
  assert!(go(from(A, Pending).window(), Call::CancelPending, Session, T0).closed);
  assert!(go(from(A, Active), Call::Abort, Operator, T_A).closed);
  assert!(go(from(A, Active), Call::RefundUnnoticed, Anyone, T_NOTE).closed);
  assert!(!go(from(A, Active), REFUND, Session, T_NOTE).closed);
  assert!(!go(from(A, Ready), CLAIM, Operator, T_R).closed);
}

/// B11 and pay-or-park.
#[test]
fn parked_payouts() {
  use State::*;
  // B11: anyone, ACTIVE, now >= T_exp: Dp to the taker; amount parked for the maker.
  let s = from(B, Active).build();
  assert_eq!(apply(s, Call::ExpireUnnoticed, Anyone, T_EXP - 1, &Env::OK, &SOLANA), Err(ModelError::TooEarly));
  let fx = apply(s, Call::ExpireUnnoticed, Anyone, T_EXP, &Env::OK, &SOLANA).unwrap();
  assert_eq!(fx.state.state, Done);
  assert_eq!(fx.counter, Some(c::EXPIRED_REFUNDS));
  assert_eq!(fx.payouts.len(), 2);
  assert_eq!((fx.payouts[0].to, fx.payouts[0].amount, fx.payouts[0].parked), (Taker, 10_000, false));
  assert_eq!((fx.payouts[1].to, fx.payouts[1].amount, fx.payouts[1].parked), (Maker, 1_000_000, true));
  assert_eq!(fx.state.owed_maker, 1_000_000);
  // The maker's owner pulls it; nobody else can; a second pull finds nothing.
  let parked = fx.state;
  assert_eq!(apply(parked, Call::WithdrawOwed(Maker), Operator, T_EXP + 1, &Env::OK, &SOLANA), Err(ModelError::Unauthorized));
  assert_eq!(apply(parked, Call::WithdrawOwed(Taker), TakerWallet, T_EXP + 1, &Env::OK, &SOLANA), Err(ModelError::NothingOwed));
  let fx = apply(parked, Call::WithdrawOwed(Maker), Owner, T_EXP + 1, &Env::OK, &SOLANA).unwrap();
  assert_eq!((fx.payouts[0].to, fx.payouts[0].amount, fx.payouts[0].parked), (Maker, 1_000_000, false));
  assert_eq!(fx.state.owed_maker, 0);
  assert_eq!(fx.counter, Option::None);
  assert_eq!(apply(fx.state, Call::WithdrawOwed(Maker), Owner, T_EXP + 2, &Env::OK, &SOLANA), Err(ModelError::NothingOwed));

  // A claim whose payout cannot be delivered still succeeds: the secret is revealed, the swap
  // is DONE, and the amounts are parked.
  let no_maker = Env { maker_can_receive: false, treasury_can_receive: false, ..Env::OK };
  let fx = apply(from(A, Ready).build(), CLAIM, Operator, T_R, &no_maker, &SOLANA).unwrap();
  assert_eq!(fx.state.state, Done);
  assert!(fx.state.has(flag::REVEALED));
  assert!(fx.payouts.iter().all(|p| p.parked));
  assert_eq!((fx.state.owed_maker, fx.state.owed_treasury), (999_500, 500));
  let fx2 = apply(fx.state, Call::WithdrawOwed(Treasury), Anyone, T_R + 1, &Env::OK, &SOLANA).unwrap();
  assert_eq!((fx2.payouts[0].amount, fx2.state.owed_treasury), (500, 0));
  // A refund to a taker that cannot receive: parked, state still advances.
  let no_taker = Env { taker_can_receive: false, ..Env::OK };
  let fx = apply(from(A, Noticed).build(), REFUND, Session, T_N, &no_taker, &SOLANA).unwrap();
  assert_eq!(fx.state.state, Hold);
  assert_eq!(fx.state.owed_taker, 990_000);
  // Only the taker's wallet (not the session key) withdraws the taker's parked funds.
  assert_eq!(apply(fx.state, Call::WithdrawOwed(Taker), Session, T_N + 1, &Env::OK, &SOLANA), Err(ModelError::Unauthorized));
  assert!(apply(fx.state, Call::WithdrawOwed(Taker), TakerWallet, T_N + 1, &Env::OK, &SOLANA).is_ok());
  // A "closed" row with a parked payout is not closed.
  let fx = apply(from(A, Pending).window().build(), Call::CancelPending, Session, T0, &no_taker, &SOLANA).unwrap();
  assert_eq!(fx.state.state, Done);
  assert!(!fx.closed);
  assert_eq!(fx.state.owed_taker, 1_000_000);
}

/// The invariants of section 3.6, each with its own check.
#[test]
fn deposit_invariants() {
  use State::*;
  let every_call = [
    APPROVE, FUND, REJECT0, Call::CancelPending, Call::ExpirePending, Call::PostNotice, Call::SetReady, Call::Abort,
    Call::RefundUnnoticed, Call::ExpireUnnoticed, REFUND, CLAIM, Call::ReleaseDeposit, Call::Withhold(Evidence::Opens),
    Call::Withhold(Evidence::Absent), Call::SplitDeposit, Call::PublishEvidence { opens: true },
  ];
  let callers = [TakerWallet, Session, Operator, Owner, Anyone];
  let times = [T0, T_REFUND, T_HOLD - 1, T_HOLD, T_SPLIT - 1, T_SPLIT, T_EXP, T_EXP + 9_999_999];
  for consts in [&SOLANA, &ETHEREUM] {
    for dir in [A, B] {
      // 1. No call can pay D to the maker: from HOLD and WITHHELD the only destinations are the
      //    taker and the treasury, whoever calls, whenever.
      for st in [Hold, Withheld] {
        let s = from(dir, st).build();
        for call in every_call {
          for caller in callers {
            for at in times {
              if let Ok(fx) = apply(s, call, caller, at, &Env::OK, consts) {
                assert!(fx.payouts.iter().all(|p| p.to != Maker), "{dir:?} {st:?} {} pays the maker", call.name());
                let out: u128 = fx.payouts.iter().map(|p| p.amount).sum();
                assert!(out <= D);
              }
            }
          }
        }
      }
      // 3. withhold is refused at or after T_hold even if nobody cranked release_deposit.
      let hold = from(dir, Hold).no_notice().build();
      assert!(apply(hold, Call::Withhold(Evidence::Absent), Operator, T_HOLD - 1, &Env::OK, consts).is_ok());
      for at in [T_HOLD, T_HOLD + 1, T_SPLIT] {
        assert_eq!(apply(hold, Call::Withhold(Evidence::Absent), Operator, at, &Env::OK, consts), Err(ModelError::TooLate));
      }
    }
  }
  // 2. Fault refunds and free refunds never enter HOLD (A7a, A8, A10d, A10e, A10f; B9a, B9c, B9g).
  let free: [(From, Call, Role, i64); 11] = [
    (from(A, Active), Call::Abort, Operator, T_A),                 // A7a
    (from(A, Active), Call::RefundUnnoticed, Anyone, T_NOTE),      // A8
    (from(A, Active), REFUND, Session, T_NOTE),                    // A10g
    (from(A, AbortedFree), REFUND, Session, T_N + 1),              // A10d
    (from(A, Ready), REFUND, Session, T_CD),                       // A10e
    (from(A, Noticed), REFUND, Session, T_EXP),                    // A10f
    (from(A, AbortedHold), REFUND, Session, T_EXP),                // A10f
    (from(B, Active), REFUND, Operator, T_A),                      // B9a
    (from(B, Noticed), REFUND, Operator, T_N),                     // B9c
    (from(B, Ready), REFUND, Operator, T_EXP),                     // B9g
    (from(B, AbortedHold), REFUND, Operator, T_EXP),               // B9g
  ];
  for (f, call, caller, at) in free {
    let fx = apply(f.build(), call, caller, at, &Env::OK, &SOLANA).unwrap();
    assert_eq!(fx.state.state, Done, "{:?} {:?} {}", f.dir, f.state, call.name());
    assert_eq!(fx.state.deposit_state, deposit_state::NONE);
    // So the maker has nothing to withhold.
    assert_eq!(apply(fx.state, Call::Withhold(Evidence::Opens), Operator, at, &Env::OK, &SOLANA), Err(ModelError::BadState));
  }
  // 4. T_split is fixed at the refund: withholding later does not move it.
  let hold = from(A, Hold).build();
  let w = apply(hold, Call::Withhold(Evidence::Opens), Operator, T_HOLD - 1, &Env::OK, &SOLANA).unwrap().state;
  assert_eq!(w.t_refund, T_REFUND);
  assert_eq!(w.t_split(&SOLANA), T_SPLIT);
  // An odd deposit splits ceil to the taker, floor to the treasury.
  let mut odd = from(A, Withheld).build();
  odd.deposit = 10_001;
  let fx = apply(odd, Call::SplitDeposit, Anyone, T_SPLIT, &Env::OK, &SOLANA).unwrap();
  assert_eq!(fx.payouts.iter().map(|p| (p.to, p.amount)).collect::<Vec<_>>(), vec![(Taker, 5_001), (Treasury, 5_000)]);
}

/// Section 3.7: the fee is taken on every claim and on nothing else.
#[test]
fn fee_only_on_claims() {
  for consts in [&SOLANA, &ETHEREUM] {
    for dir in [A, B] {
      for st in [State::Pending, State::Active, State::Noticed, State::Ready, State::AbortedFree, State::AbortedHold, State::Hold, State::Withheld] {
        if dir == B && st == State::AbortedFree {
          continue;
        }
        let s = from(dir, st).build();
        for call in [REJECT0, Call::CancelPending, Call::ExpirePending, Call::Abort, Call::RefundUnnoticed, Call::ExpireUnnoticed, REFUND, CLAIM, Call::ReleaseDeposit, Call::SplitDeposit] {
          for caller in [TakerWallet, Operator, Anyone] {
            for at in [T0, T_A, T_N, T_CUT, T_R, T_CD, T_CO, T_HOLD, T_FINAL, T_EXP, T_SPLIT] {
              let Ok(fx) = apply(s, call, caller, at, &Env::OK, consts) else { continue };
              let to_treasury: u128 = fx.payouts.iter().filter(|p| p.to == Treasury).map(|p| p.amount).sum();
              match call {
                Call::Claim { .. } => {
                  assert_eq!(to_treasury, FEE);
                  assert_eq!(fx.volume, AMOUNT);
                }
                Call::SplitDeposit => assert_eq!(to_treasury, D / 2),
                _ => assert_eq!(to_treasury, 0, "{} takes a fee", call.name()),
              }
            }
          }
        }
      }
    }
  }
}

/// SPEC 3.1: a swap whose `amount` or `xmr` is zero is refused on both chains.
#[test]
fn zero_swaps_are_refused() {
  for consts in [&SOLANA, &ETHEREUM] {
    let mut p = params();
    if consts.explicit_approve {
      p = SwapParams { w_a: 120, w_n: 1_800, d_c: 10_800, w_c: 5_400, w_f: 604_800, depth: 10, dep_bps: 100, w_z: 0 };
    }
    for dir in [A, B] {
      let go = |xmr: u64, amount: u128| {
        apply(SwapState::NONE, Call::Open(OpenArgs { direction: dir, offer_mode: mode::AUTO, approval: false, xmr, amount, params: p, payout: PayoutArg::Taker, watcher: false }), TakerWallet, T0, &Env::OK, consts)
      };
      assert_eq!(go(XMR, 0).unwrap_err(), ModelError::AmountOutOfRange);
      assert_eq!(go(0, AMOUNT).unwrap_err(), ModelError::AmountOutOfRange);
      assert_eq!(go(0, 0).unwrap_err(), ModelError::AmountOutOfRange);
      // The smallest swap there is: one piconero for one base unit.
      let fx = go(1, 1).unwrap();
      assert_eq!((fx.state.amount, fx.state.deposit), (1, 0));
      assert!(go(XMR, AMOUNT).is_ok());
    }
  }
  assert_eq!(ModelError::AmountOutOfRange.name(), "AmountOutOfRange");
}

/// SPEC 3.13, caller rules that differ by chain: `withdraw_owed` by an account that is owed
/// nothing is `Unauthorized` on Solana (the wrong signer) and `NothingOwed` on Ethereum (the
/// call pays the caller's own parked balance).
#[test]
fn withdraw_by_an_account_owed_nothing() {
  let mut s = from(A, State::Done).build();
  s.owed_taker = 990_000;
  s.owed_maker = 5;
  for (who, wrong) in [(Taker, vec![Session, Operator, Owner, Anyone]), (Maker, vec![TakerWallet, Session, Operator, Anyone])] {
    for caller in wrong {
      assert_eq!(apply(s, Call::WithdrawOwed(who), caller, T_EXP, &Env::OK, &SOLANA).unwrap_err(), ModelError::Unauthorized, "{who:?} by {caller:?}");
      assert_eq!(apply(s, Call::WithdrawOwed(who), caller, T_EXP, &Env::OK, &ETHEREUM).unwrap_err(), ModelError::NothingOwed, "{who:?} by {caller:?}");
    }
  }
  // The owed account still pulls on both chains, and nobody is paid somebody else's balance.
  for consts in [&SOLANA, &ETHEREUM] {
    let fx = apply(s, Call::WithdrawOwed(Taker), TakerWallet, T_EXP, &Env::OK, consts).unwrap();
    assert_eq!(fx.payouts.iter().map(|p| (p.to, p.amount)).collect::<Vec<_>>(), vec![(Taker, 990_000)]);
    assert_eq!((fx.state.owed_taker, fx.state.owed_maker), (0, 5));
    let fx = apply(s, Call::WithdrawOwed(Maker), Owner, T_EXP, &Env::OK, consts).unwrap();
    assert_eq!(fx.payouts.iter().map(|p| (p.to, p.amount)).collect::<Vec<_>>(), vec![(Maker, 5)]);
  }
  assert!(!SOLANA.taker_is_sender && !SOLANA.pull_own_owed);
  assert!(ETHEREUM.taker_is_sender && ETHEREUM.pull_own_owed);
}

// ------------------------------------------------------------------ Amendment 1 (SPEC 11)

/// SPEC 11.6, rows Z1 to Z6, written by hand from the table. Frozen swap: freeze window 86,400,
/// t_Z = T0 + 400, so T_ff = T0 + 86,800; T_co = T0 + 3,700; T_final = T0 + 604,800.
#[rustfmt::skip]
#[test]
fn freeze_rows_z1_to_z6() {
  use ModelError::*;
  use Role::Watcher;
  use State::*;
  let mut t = Vec::new();
  for dir in [A, B] {
    let (locker, claimer) = if dir == A { (Session, Operator) } else { (Operator, Session) };
    let noticed = from(dir, Noticed).watched();
    let frozen = from(dir, Frozen).watched();
    // Z1: the watcher or the locker, NOTICED, now < T_co, a watcher is named. No funds move.
    t.push(row("Z1 watcher", noticed, Call::Freeze, Watcher, T_N, ok(Frozen, &[], c::FREEZES)));
    t.push(row("Z1 watcher, last second", noticed, Call::Freeze, Watcher, T_CO - 1, ok(Frozen, &[], c::FREEZES)));
    t.push(row("Z1 at T_co", noticed, Call::Freeze, Watcher, T_CO, No(TooLate)));
    t.push(row("Z1 locker", noticed, Call::Freeze, locker, T_CO - 1, ok(Frozen, &[], c::FREEZES)));
    t.push(row("Z1 claimer", noticed, Call::Freeze, claimer, T_N, No(Unauthorized)));
    t.push(row("Z1 stranger", noticed, Call::Freeze, Anyone, T_N, No(Unauthorized)));
    t.push(row("Z1 owner", noticed, Call::Freeze, Owner, T_N, No(Unauthorized)));
    t.push(row("Z1 no watcher named, locker", from(dir, Noticed).unwatched(), Call::Freeze, locker, T_N, No(BadState)));
    t.push(row("Z1 no watcher named, a key calling itself one", from(dir, Noticed).unwatched(), Call::Freeze, Watcher, T_N, No(Unauthorized)));
    t.push(row("Z1 no freeze window", from(dir, Noticed), Call::Freeze, locker, T_N, No(BadState)));
    t.push(row("Z1 twice", frozen, Call::Freeze, Watcher, T_Z + 1, No(BadState)));
    t.push(row("Z1 twice, locker", frozen, Call::Freeze, locker, T_Z + 1, No(BadState)));
    t.push(row("Z1 in READY", from(dir, Ready).watched(), Call::Freeze, Watcher, T_R, No(BadState)));
    t.push(row("Z1 in ACTIVE", from(dir, Active).watched(), Call::Freeze, Watcher, T_A, No(BadState)));
    t.push(row("Z1 after an abort", from(dir, AbortedHold).watched(), Call::Freeze, Watcher, T_N + 50, No(BadState)));
    // Z2: the locker unfreezes; t_N + d × 60 <= now < T_ff.
    t.push(row("Z2 before the minimum", frozen, Call::SetReady, locker, T_RMIN - 1, No(TooEarly)));
    t.push(row("Z2 first second", frozen, Call::SetReady, locker, T_RMIN, ok(Ready, &[], c::READIES)));
    t.push(row("Z2 past T_co", frozen, Call::SetReady, locker, T_CO + 100, ok(Ready, &[], c::READIES)));
    t.push(row("Z2 last second", frozen, Call::SetReady, locker, T_FF - 1, ok(Ready, &[], c::READIES)));
    t.push(row("Z2 at T_ff", frozen, Call::SetReady, locker, T_FF, No(TooLate)));
    t.push(row("Z2 watcher", frozen, Call::SetReady, Watcher, T_RMIN, No(Unauthorized)));
    t.push(row("Z2 claimer", frozen, Call::SetReady, claimer, T_RMIN, No(Unauthorized)));
    // Z3: the locker refunds until T_ff.
    if dir == A {
      // amount − D to the taker, D held; refunds_after_freeze.
      t.push(row("Z3", frozen, REFUND, Session, T_Z, ok(Hold, &[(Taker, AMOUNT - D)], c::REFUNDS_AFTER_FREEZE)));
      t.push(row("Z3 wallet", frozen, REFUND, TakerWallet, T_CO + 5, ok(Hold, &[(Taker, AMOUNT - D)], c::REFUNDS_AFTER_FREEZE)));
      t.push(row("Z3 last second", frozen, REFUND, Session, T_FF - 1, ok(Hold, &[(Taker, AMOUNT - D)], c::REFUNDS_AFTER_FREEZE)));
      t.push(row("Z3 D == 0", frozen.no_deposit(), REFUND, Session, T_Z, ok(Done, &[(Taker, AMOUNT)], c::REFUNDS_AFTER_FREEZE)));
      t.push(row("Z6 expiry", frozen, REFUND, Session, T_EXP, ok(Done, &[(Taker, AMOUNT)], c::EXPIRED_REFUNDS)));
    } else {
      // amount to the maker, Dp to the taker at once; backouts_after_freeze; never held.
      t.push(row("Z3", frozen, REFUND, Operator, T_Z, ok(Done, &[(Maker, AMOUNT), (Taker, D)], c::BACKOUTS_AFTER_FREEZE)));
      t.push(row("Z3 past T_cut and T_co", frozen, REFUND, Operator, T_CO + 5, ok(Done, &[(Maker, AMOUNT), (Taker, D)], c::BACKOUTS_AFTER_FREEZE)));
      t.push(row("Z3 last second", frozen, REFUND, Operator, T_FF - 1, ok(Done, &[(Maker, AMOUNT), (Taker, D)], c::BACKOUTS_AFTER_FREEZE)));
      t.push(row("Z3 late notice", frozen.late(), REFUND, Operator, T_Z, ok(Done, &[(Maker, AMOUNT), (Taker, D)], c::BACKOUTS_AFTER_FREEZE)));
      t.push(row("Z6 expiry", frozen, REFUND, Operator, T_EXP, ok(Done, &[(Maker, AMOUNT), (Taker, D)], c::EXPIRED_REFUNDS)));
    }
    t.push(row("Z3 at T_ff", frozen, REFUND, locker, T_FF, No(TooLate)));
    t.push(row("Z3 before expiry", frozen, REFUND, locker, T_EXP - 1, No(TooLate)));
    t.push(row("Z3 wrong secret", frozen, Call::Refund { secret_ok: false }, locker, T_Z, No(BadSecret)));
    t.push(row("Z3 watcher", frozen, REFUND, Watcher, T_Z, No(Unauthorized)));
    t.push(row("Z3 claimer", frozen, REFUND, claimer, T_Z, No(Unauthorized)));
    // Z4: the claimer claims from T_ff, not from T_co.
    let claim_pays: Vec<(Party, u128)> = if dir == A { vec![(Maker, AMOUNT - FEE), (Treasury, FEE)] } else { vec![(Taker, AMOUNT - FEE + D), (Treasury, FEE)] };
    t.push(row("Z4 at t_Z", frozen, CLAIM, claimer, T_Z, No(TooEarly)));
    t.push(row("Z4 at T_co", frozen, CLAIM, claimer, T_CO, No(TooEarly)));
    t.push(row("Z4 before T_ff", frozen, CLAIM, claimer, T_FF - 1, No(TooEarly)));
    t.push(row("Z4 at T_ff", frozen, CLAIM, claimer, T_FF, ok(Done, &claim_pays, c::CLAIMS_AFTER_FREEZE)));
    t.push(row("Z4 last second", frozen, CLAIM, claimer, T_FINAL - 1, ok(Done, &claim_pays, c::CLAIMS_AFTER_FREEZE)));
    t.push(row("Z6 claim at T_final", frozen, CLAIM, claimer, T_FINAL, ok(Done, &claim_pays, c::CLAIMS_AFTER_FINAL)));
    t.push(row("Z6 claim before T_exp", frozen, CLAIM, claimer, T_EXP - 1, ok(Done, &claim_pays, c::CLAIMS_AFTER_FINAL)));
    t.push(row("Z6 claim at T_exp", frozen, CLAIM, claimer, T_EXP, No(TooLate)));
    t.push(row("Z4 wrong secret", frozen, Call::Claim { secret_ok: false }, claimer, T_FF, No(BadSecret)));
    t.push(row("Z4 watcher", frozen, CLAIM, Watcher, T_FF, No(Unauthorized)));
    t.push(row("Z4 locker", frozen, CLAIM, locker, T_FF, No(Unauthorized)));
    // Z5: the claimer aborts; always into ABORTED_HOLD, so the deposit stays withholdable.
    let abort_counter = if dir == A { c::ABORTS_LATE } else { c::TAKER_ABORTS };
    t.push(row("Z5", frozen, Call::Abort, claimer, T_Z, ok(AbortedHold, &[], abort_counter)));
    t.push(row("Z5 before T_co", frozen, Call::Abort, claimer, T_CO - 1, ok(AbortedHold, &[], abort_counter)));
    t.push(row("Z5 last second", frozen, Call::Abort, claimer, T_FINAL - 1, ok(AbortedHold, &[], abort_counter)));
    t.push(row("Z5 at T_final", frozen, Call::Abort, claimer, T_FINAL, No(TooLate)));
    t.push(row("Z5 watcher", frozen, Call::Abort, Watcher, T_Z, No(Unauthorized)));
    t.push(row("Z5 locker", frozen, Call::Abort, locker, T_Z, No(Unauthorized)));
    // Nothing else is possible in FROZEN.
    t.push(row("FROZEN post_notice", frozen, Call::PostNotice, claimer, T_Z, No(BadState)));
    t.push(row("FROZEN cancel", frozen, Call::CancelPending, Session, T_Z, No(BadState)));
    t.push(row("FROZEN release", frozen, Call::ReleaseDeposit, Operator, T_Z, No(BadState)));
    t.push(row("FROZEN withhold", frozen, Call::Withhold(Evidence::Opens), Operator, T_Z, No(BadState)));
    t.push(row("FROZEN split", frozen, Call::SplitDeposit, Anyone, T_SPLIT, No(BadState)));
    t.push(row("FROZEN expire_pending", frozen, Call::ExpirePending, Anyone, T_EXP, No(BadState)));
  }
  t.push(row("FROZEN refund_unnoticed", from(A, Frozen).watched(), Call::RefundUnnoticed, Anyone, T_NOTE, No(BadState)));
  t.push(row("FROZEN expire_unnoticed", from(B, Frozen).watched(), Call::ExpireUnnoticed, Anyone, T_EXP, No(BadState)));
  assert_eq!(t.len(), 2 * 55 + 2);
  run(&t, &SOLANA);
  // The record after a freeze: only the state and t_freeze change.
  let s = from(A, Noticed).watched().build();
  let fx = apply(s, Call::Freeze, Watcher, T_N + 7, &Env::OK, &SOLANA).unwrap();
  assert_eq!(fx.state, SwapState { state: Frozen, t_freeze: T_N + 7, ..s });
  assert_eq!(fx.state.t_ff(), T_N + 7 + 86_400);
  assert_eq!((fx.escrow_in, fx.volume, fx.open_pending, fx.closed), (0, 0, 0, false));
  // Unfreezing: T_cd = t_R + W_c as from NOTICED.
  let r = apply(fx.state, Call::SetReady, Session, T_CO + 9, &Env::OK, &SOLANA).unwrap().state;
  assert_eq!((r.t_ready, r.t_claim_deadline, r.t_freeze), (T_CO + 9, T_CO + 9 + 1_800, T_N + 7));
  // A refund after a freeze in A leaves the deposit withholdable, with evidence.
  let h = apply(fx.state, REFUND, Session, T_CO + 9, &Env::OK, &SOLANA).unwrap().state;
  assert_eq!((h.state, h.deposit_state), (Hold, deposit_state::HELD));
  assert_eq!(apply(h, Call::Withhold(Evidence::Absent), Operator, T_CO + 10, &Env::OK, &SOLANA), Err(EvidenceRequired));
  assert_eq!(apply(h, Call::Withhold(Evidence::Opens), Operator, T_CO + 10, &Env::OK, &SOLANA).unwrap().state.state, Withheld);
  // Under Ethereum's open calls a stranger with the right secret may submit the claim or the
  // refund, in the party's window only; that is not a watcher power.
  let frozen = from(A, Frozen).watched().build();
  assert_eq!(apply(frozen, CLAIM, Watcher, T_FF - 1, &Env::OK, &ETHEREUM), Err(TooEarly));
  assert_eq!(apply(frozen, CLAIM, Watcher, T_FF, &Env::OK, &ETHEREUM), apply(frozen, CLAIM, Anyone, T_FF, &Env::OK, &ETHEREUM));
  assert_eq!(apply(frozen, Call::SetReady, Watcher, T_RMIN, &Env::OK, &ETHEREUM), Err(Unauthorized));
  assert_eq!(apply(frozen, Call::Abort, Watcher, T_Z, &Env::OK, &ETHEREUM), Err(Unauthorized));
}

/// SPEC 11.6: naming a watcher, and the freeze-window bounds.
#[test]
fn watcher_and_freeze_window_at_open() {
  let go = |c: &ChainConsts, direction, w_z: u32, watcher: bool, w_f: u32| {
    let p = SwapParams { w_a: 120, w_n: 1_800, d_c: 10_800, w_c: 5_400, w_f, depth: 10, dep_bps: 100, w_z };
    apply(SwapState::NONE, Call::Open(OpenArgs { direction, offer_mode: mode::WINDOW, approval: false, xmr: XMR, amount: AMOUNT, params: p, payout: PayoutArg::Taker, watcher }), TakerWallet, T0, &Env::OK, c)
  };
  for chain in [&SOLANA, &ETHEREUM] {
    use swap_core::amounts::BoundError::*;
    use ModelError::*;
    assert_eq!(go(chain, A, 0, true, 604_800), Err(WatcherNotAllowed));
    let fx = go(chain, A, 3_600, true, 604_800).unwrap();
    assert_eq!((fx.state.w_z, fx.state.watcher, fx.state.t_freeze), (3_600, true, 0));
    // No watcher against a freeze window is fine: the option is the locker's.
    assert_eq!(go(chain, A, 3_600, false, 604_800).unwrap().state.watcher, false);
    assert_eq!(go(chain, A, 1, true, 604_800), Err(Bound(FreezeWindowOutOfRange)));
    assert_eq!(go(chain, A, 3_599, true, 604_800), Err(Bound(FreezeWindowOutOfRange)));
    assert_eq!(go(chain, A, 259_201, true, 604_800), Err(Bound(FreezeWindowOutOfRange)));
    assert!(go(chain, A, 259_200, true, 604_800).is_ok());
    // W_p + W_n + D_c + W_z + W_c + 86,400 <= W_f: 120 + 1,800 + 10,800 + 259,200 + 5,400 + 86,400.
    assert!(go(chain, A, 259_200, true, 363_720).is_ok());
    assert_eq!(go(chain, A, 259_200, true, 363_719), Err(Bound(FinalWindowOutOfRange)));
    // The same swap without the freeze window fits a final window 259,200 shorter.
    assert!(go(chain, A, 0, false, 104_520).is_ok());
    assert_eq!(go(chain, A, 0, false, 104_519), Err(Bound(FinalWindowOutOfRange)));
    // T_nl moves earlier by W_z.
    let s = go(chain, B, 259_200, false, 604_800).unwrap().state;
    assert_eq!(s.t_nl(), T0 + 604_800 - 10_800 - 259_200 - 5_400 - 86_400);
    // Direction B: the taker's flag is ignored; the maker names its watcher at fund.
    assert_eq!(go(chain, B, 0, true, 604_800).unwrap().state.watcher, false);
    let pending = go(chain, B, 0, false, 604_800).unwrap().state;
    assert_eq!(apply(pending, Call::Fund { open_ok: true, watcher: true }, Operator, T0 + 5, &Env::OK, chain), Err(WatcherNotAllowed));
    assert_eq!(apply(pending, Call::Fund { open_ok: true, watcher: false }, Operator, T0 + 5, &Env::OK, chain).unwrap().state.watcher, false);
    let pending = go(chain, B, 3_600, false, 604_800).unwrap().state;
    assert_eq!(apply(pending, Call::Fund { open_ok: true, watcher: true }, Operator, T0 + 5, &Env::OK, chain).unwrap().state.watcher, true);
    // Checks that come first still come first: a stale open hash, a late fund.
    assert_eq!(apply(pending, Call::Fund { open_ok: false, watcher: true }, Operator, T0 + 5, &Env::OK, chain), Err(BadState));
  }
}

/// SPEC 11.1: caps gate only `lock` and `take`; the open value is exact.
#[test]
fn caps_and_open_value() {
  use ModelError::*;
  let caps = |on, max_swap, max_open, open_value| Env { caps: Caps { on, max_swap, max_open, open_value }, ..Env::OK };
  let go = |dir, env: &Env, c: &ChainConsts| {
    let args = OpenArgs { direction: dir, offer_mode: mode::WINDOW, approval: false, xmr: XMR, amount: AMOUNT, params: params_on(c), payout: PayoutArg::Taker, watcher: false };
    apply(SwapState::NONE, Call::Open(args), TakerWallet, T0, env, c)
  };
  for chain in [&SOLANA, &ETHEREUM] {
    // Direction A counts amount; direction B counts amount + deposit.
    for (dir, counted) in [(A, AMOUNT), (B, AMOUNT + D)] {
      // Exactly at a cap is allowed; one unit above is not.
      assert_eq!(go(dir, &caps(true, AMOUNT, u128::MAX, 0), chain).unwrap().open_value_after, counted);
      assert_eq!(go(dir, &caps(true, AMOUNT - 1, u128::MAX, 0), chain), Err(SwapCapExceeded));
      assert_eq!(go(dir, &caps(true, AMOUNT, 5_000_000 + counted, 5_000_000), chain).unwrap().open_value_after, 5_000_000 + counted);
      assert_eq!(go(dir, &caps(true, AMOUNT, 5_000_000 + counted - 1, 5_000_000), chain), Err(OpenCapExceeded));
      // The swap cap is checked first.
      assert_eq!(go(dir, &caps(true, AMOUNT - 1, 0, 0), chain), Err(SwapCapExceeded));
      // Fail closed: after initialize the switch is on and every cap is zero.
      assert_eq!(go(dir, &Env { caps: Caps::INITIAL, ..Env::OK }, chain), Err(SwapCapExceeded));
      // Switched off, nothing is checked and the accounting continues.
      let fx = go(dir, &caps(false, 0, 0, 77), chain).unwrap();
      assert_eq!(fx.open_value_after, 77 + counted);
      assert!(fx.state.has(flag::COUNTED));
      // A cap lowered below the current open value refuses new opens only.
      assert_eq!(go(dir, &caps(true, AMOUNT, 10, 5_000_000), chain), Err(OpenCapExceeded));
      // The add is exact: a sum that does not fit the chain's amount type is refused, with the
      // switch on (it is above every cap) and with it off.
      let top = chain.max_amount;
      assert_eq!(go(dir, &caps(false, 0, 0, top - counted), chain).unwrap().open_value_after, top);
      assert_eq!(go(dir, &caps(false, 0, 0, top - counted + 1), chain), Err(MathOverflow));
      assert_eq!(go(dir, &caps(true, top, top, top - counted + 1), chain), Err(OpenCapExceeded));
      assert_eq!(go(dir, &caps(true, top, top, top - counted), chain).unwrap().open_value_after, top);
      // The cap check comes after the bounds and before MAX_OPEN_PENDING.
      let full = Env { open_pending: chain.max_open_pending, ..caps(true, AMOUNT - 1, u128::MAX, 0) };
      assert_eq!(go(dir, &full, chain), Err(SwapCapExceeded));
      // The pause refuses an open, and nothing else.
      assert_eq!(go(dir, &Env { maker_paused: true, ..Env::OK }, chain), Err(Paused));
    }
  }
  // Direction B on Solana: amount + deposit must fit u64 even with the caps off, or the claim
  // (amount − fee + Dp) and the counted value could not be represented.
  let big = |amount: u128| Call::Open(OpenArgs { direction: B, offer_mode: mode::AUTO, approval: false, xmr: XMR, amount, params: SwapParams { dep_bps: 500, ..params() }, payout: PayoutArg::Taker, watcher: false });
  let off = caps(false, 0, 0, 0);
  let max = u64::MAX as u128;
  assert_eq!(apply(SwapState::NONE, big(max), TakerWallet, T0, &off, &SOLANA), Err(MathOverflow));
  let fits = max * 20 / 21; // amount + floor(amount / 20) <= u64::MAX
  assert!(apply(SwapState::NONE, big(fits), TakerWallet, T0, &off, &SOLANA).is_ok());
  assert_eq!(apply(SwapState::NONE, big(fits + 2), TakerWallet, T0, &off, &SOLANA), Err(MathOverflow));

  // Every exit subtracts the counted value once, with every cap at zero and the maker paused.
  let hostile = |open_value| Env { caps: Caps { open_value, ..Caps::INITIAL }, maker_paused: true, ..Env::OK };
  let exits: [(From, Call, Role, i64, State); 10] = [
    (from(A, State::Pending).window(), Call::CancelPending, Session, T0 + 5, State::Done),
    (from(A, State::Pending).window(), REJECT0, Operator, T0 + 5, State::Done),
    (from(A, State::Active), REFUND, Session, T_A, State::Hold),
    (from(A, State::Active), Call::RefundUnnoticed, Anyone, T_NOTE, State::Done),
    (from(A, State::Noticed), CLAIM, Operator, T_CO, State::Done),
    (from(A, State::Ready), CLAIM, Operator, T_R, State::Done),
    (from(B, State::Pending), Call::ExpirePending, Anyone, T_PEND, State::Done),
    (from(B, State::Active), Call::ExpireUnnoticed, Anyone, T_EXP, State::Done),
    (from(B, State::Noticed), REFUND, Operator, T_CUT, State::Hold),
    (from(B, State::Frozen).watched(), CLAIM, Session, T_FF, State::Done),
  ];
  for (f, call, caller, at, end) in exits {
    let s = f.build();
    let counted = if f.dir == A { AMOUNT } else { AMOUNT + D };
    let fx = apply(s, call, caller, at, &hostile(9_000_000), &SOLANA).unwrap_or_else(|e| panic!("{}: {e:?}", call.name()));
    assert_eq!(fx.state.state, end, "{}", call.name());
    assert_eq!(fx.open_value_after, 9_000_000 - counted, "{}", call.name());
    assert!(!fx.state.has(flag::COUNTED));
    // The same answer as with no switch set.
    assert_eq!(apply(s, call, caller, at, &Env { caps: Caps { open_value: 9_000_000, ..Caps::UNLIMITED }, ..Env::OK }, &SOLANA).unwrap(), fx);
    // The subtraction saturates: it can never fail an exit.
    assert_eq!(apply(s, call, caller, at, &hostile(3), &SOLANA).unwrap().open_value_after, 0);
  }
  // Calls that keep the swap open, and calls after it has left, move no open value.
  let quiet: [(From, Call, Role, i64); 8] = [
    (from(B, State::Pending), FUND, Operator, T0 + 5),
    (from(A, State::Pending).window(), APPROVE, Operator, T0 + 5),
    (from(A, State::Active), Call::PostNotice, Operator, T_A),
    (from(A, State::Noticed), Call::SetReady, Session, T_RMIN),
    (from(A, State::Noticed).watched(), Call::Freeze, Role::Watcher, T_N),
    (from(A, State::Noticed), Call::Abort, Operator, T_N),
    (from(A, State::Hold), Call::ReleaseDeposit, Operator, T_REFUND + 1),
    (from(A, State::Withheld), Call::SplitDeposit, Anyone, T_SPLIT),
  ];
  for (f, call, caller, at) in quiet {
    let fx = apply(f.build(), call, caller, at, &hostile(9_000_000), &SOLANA).unwrap_or_else(|e| panic!("{}: {e:?}", call.name()));
    assert_eq!(fx.open_value_after, 9_000_000, "{}", call.name());
    assert_eq!(fx.state.has(flag::COUNTED), fx.state.state.is_open(), "{}", call.name());
  }
}

/// SPEC 11.2: a direction-B claim pays the payout address and nobody else can redirect it.
#[test]
fn payout_address() {
  use ModelError::*;
  use Role::Payout as PayoutKey;
  // take: the default is the taker's own address; another address is stored; an invalid one is refused.
  let take = |payout, c: &ChainConsts| {
    apply(SwapState::NONE, Call::Open(OpenArgs { direction: B, offer_mode: mode::AUTO, approval: false, xmr: XMR, amount: AMOUNT, params: params_on(c), payout, watcher: false }), TakerWallet, T0, &Env::OK, c)
  };
  assert_eq!(take(PayoutArg::Taker, &SOLANA).unwrap().state.payout, PayoutTo::Taker);
  assert_eq!(take(PayoutArg::Other, &SOLANA).unwrap().state.payout, PayoutTo::Other);
  assert_eq!(take(PayoutArg::Invalid, &SOLANA), Err(PayoutInvalid));
  assert_eq!(take(PayoutArg::Invalid, &ETHEREUM).unwrap_err().chain_name(swap_core::amounts::Chain::Ethereum), "BadValue");
  assert_eq!(take(PayoutArg::Invalid, &SOLANA).unwrap_err().chain_name(swap_core::amounts::Chain::Solana), "PayoutInvalid");
  // Direction A has no payout field: whatever is passed, the record holds none.
  let lock = apply(SwapState::NONE, Call::Open(OpenArgs { direction: A, offer_mode: mode::AUTO, approval: false, xmr: XMR, amount: AMOUNT, params: params(), payout: PayoutArg::Invalid, watcher: false }), TakerWallet, T0, &Env::OK, &SOLANA);
  assert_eq!(lock.unwrap().state.payout, PayoutTo::None);

  for chain in [&SOLANA, &ETHEREUM] {
    let ready = from(B, State::Ready).payout_other().build();
    // amount − fee + Dp to the payout address; the taking wallet receives nothing.
    for caller in [Session, TakerWallet] {
      let fx = apply(ready, CLAIM, caller, T_R, &Env::OK, chain).unwrap();
      let paid: Vec<(Party, u128, bool)> = fx.payouts.iter().map(|p| (p.to, p.amount, p.parked)).collect();
      assert_eq!(paid, vec![(Party::Payout, AMOUNT - FEE + D, false), (Treasury, FEE, false)]);
    }
    // Every other claim row too.
    for (f, at) in [(from(B, State::Noticed), T_CO), (from(B, State::AbortedHold), T_FINAL), (from(B, State::Frozen).watched(), T_FF)] {
      let fx = apply(f.payout_other().build(), CLAIM, Session, at, &Env::OK, chain).unwrap();
      assert_eq!((fx.payouts[0].to, fx.payouts[0].amount), (Party::Payout, AMOUNT - FEE + D));
    }
    // Everything that is not a claim returns the deposit to the taker's own wallet.
    let not_claims: [(From, Call, Role, i64); 6] = [
      (from(B, State::Pending), Call::CancelPending, Session, T0 + 5),
      (from(B, State::Pending), Call::ExpirePending, Anyone, T_PEND),
      (from(B, State::Active), REFUND, Operator, T_A),
      (from(B, State::Active), Call::ExpireUnnoticed, Anyone, T_EXP),
      (from(B, State::Hold), Call::ReleaseDeposit, Anyone, T_HOLD),
      (from(B, State::Withheld), Call::SplitDeposit, Anyone, T_SPLIT),
    ];
    for (f, call, caller, at) in not_claims {
      let fx = apply(f.payout_other().build(), call, caller, at, &Env::OK, chain).unwrap_or_else(|e| panic!("{}: {e:?}", call.name()));
      assert!(fx.payouts.iter().any(|p| p.to == Taker), "{}", call.name());
      assert!(fx.payouts.iter().all(|p| p.to != Party::Payout), "{}", call.name());
    }
    // The payout address cannot receive: the claim still succeeds and the proceeds are parked for it.
    let fx = apply(ready, CLAIM, Session, T_R, &Env { payout_can_receive: false, ..Env::OK }, chain).unwrap();
    assert_eq!(fx.payouts[0], swap_core::model::Payout { to: Party::Payout, amount: AMOUNT - FEE + D, parked: true });
    let done = fx.state;
    assert_eq!((done.state, done.owed_taker), (State::Done, AMOUNT - FEE + D));
    assert!(done.payout_owed());
    // The taking wallet and the session key have no power over them.
    let foreign = if chain.pull_own_owed { NothingOwed } else { Unauthorized };
    assert_eq!(apply(done, Call::WithdrawOwed(Taker), TakerWallet, T_R + 5, &Env::OK, chain), Err(foreign));
    assert_eq!(apply(done, Call::WithdrawOwed(Taker), Session, T_R + 5, &Env::OK, chain), Err(foreign));
    // The payout address pulls them...
    let pulled = apply(done, Call::WithdrawOwed(Party::Payout), PayoutKey, T_R + 5, &Env::OK, chain).unwrap();
    assert_eq!(pulled.payouts, vec![swap_core::model::Payout { to: Party::Payout, amount: AMOUNT - FEE + D, parked: false }]);
    assert_eq!(pulled.state.owed_taker, 0);
    assert_eq!(apply(pulled.state, Call::WithdrawOwed(Party::Payout), PayoutKey, T_R + 6, &Env::OK, chain), Err(NothingOwed));
    // ...or a stranger delivers them to the payout address and nowhere else.
    if chain.push_owed {
      // Ethereum: withdrawOwed pays the caller's own balance; pushOwed pays the account named.
      assert_eq!(apply(done, Call::WithdrawOwed(Party::Payout), Anyone, T_R + 5, &Env::OK, chain), Err(NothingOwed));
      assert_eq!(apply(done, Call::PushOwed(Party::Payout), Anyone, T_R + 5, &Env::OK, chain).unwrap().payouts, pulled.payouts);
      assert_eq!(apply(done, Call::PushOwed(Taker), Anyone, T_R + 5, &Env::OK, chain), Err(NothingOwed));
      assert_eq!(apply(done, Call::PushOwed(Maker), Anyone, T_R + 5, &Env::OK, chain), Err(NothingOwed));
    } else {
      // Solana: withdraw_owed(0) by anyone, the destination pinned to the payout address.
      for caller in [Anyone, TakerWallet, Operator] {
        assert_eq!(apply(done, Call::WithdrawOwed(Party::Payout), caller, T_R + 5, &Env::OK, chain).unwrap().payouts, pulled.payouts);
      }
      assert_eq!(apply(done, Call::PushOwed(Party::Payout), Anyone, T_R + 5, &Env::OK, chain), Err(Unauthorized));
    }
    // A swap whose payout is the taker's own address: nothing changes from before the amendment.
    let own = from(B, State::Ready).build();
    let fx = apply(own, CLAIM, Session, T_R, &Env { taker_can_receive: false, ..Env::OK }, chain).unwrap();
    assert_eq!((fx.payouts[0].to, fx.payouts[0].parked), (Taker, true));
    assert!(!fx.state.payout_owed());
    assert!(apply(fx.state, Call::WithdrawOwed(Taker), TakerWallet, T_R + 5, &Env::OK, chain).is_ok());
    assert!(apply(fx.state, Call::WithdrawOwed(Party::Payout), PayoutKey, T_R + 5, &Env::OK, chain).is_err());
    // A deposit parked for the taker of a swap with a payout address stays the taker's.
    let held = from(B, State::Hold).payout_other().build();
    let fx = apply(held, Call::ReleaseDeposit, Anyone, T_HOLD, &Env { taker_can_receive: false, ..Env::OK }, chain).unwrap();
    assert!(!fx.state.payout_owed());
    assert!(apply(fx.state, Call::WithdrawOwed(Taker), TakerWallet, T_HOLD + 5, &Env::OK, chain).is_ok());
    assert!(apply(fx.state, Call::WithdrawOwed(Party::Payout), PayoutKey, T_HOLD + 5, &Env::OK, chain).is_err());
    if chain.push_owed {
      assert_eq!(apply(fx.state, Call::PushOwed(Taker), Anyone, T_HOLD + 5, &Env::OK, chain).unwrap().payouts[0].to, Taker);
      assert_eq!(apply(fx.state, Call::PushOwed(Party::Payout), Anyone, T_HOLD + 5, &Env::OK, chain), Err(NothingOwed));
    }
  }
}

/// SPEC 11.1: `split_deposit` never fails on its treasury slot. On Solana an account that is not
/// the one the current `split_mode` names parks the treasury's half.
#[test]
fn split_with_the_other_treasury_slot() {
  let s = from(A, State::Withheld).build();
  let fx = apply(s, Call::SplitDeposit, Anyone, T_SPLIT, &Env { treasury_can_receive: false, ..Env::OK }, &SOLANA).unwrap();
  let paid: Vec<(Party, u128, bool)> = fx.payouts.iter().map(|p| (p.to, p.amount, p.parked)).collect();
  assert_eq!(paid, vec![(Taker, D - D / 2, false), (Treasury, D / 2, true)]);
  assert_eq!((fx.state.state, fx.state.owed_treasury, fx.counter), (State::Done, D / 2, Some(c::SPLITS)));
  let out = apply(fx.state, Call::WithdrawOwed(Treasury), Anyone, T_SPLIT + 1, &Env::OK, &SOLANA).unwrap();
  assert_eq!((out.payouts[0].amount, out.state.owed_treasury), (D / 2, 0));
}

/// A freeze must never open the claim earlier than `T_co` or close the locker's refund earlier.
/// SPEC 11.6 writes `T_ff = t_Z + W_z`; with the shortest window (3,600) and a claim delay
/// longer than that, a freeze right after the notice would do exactly that, so the model uses
/// `T_ff = max(t_Z + W_z, T_co)`. Written by hand: claim delay 7,200, notice at T0 + 100, so
/// T_co = T0 + 7,300; freeze at T0 + 110 with W_z = 3,600, so t_Z + W_z = T0 + 3,710.
#[test]
fn freeze_never_shortens_the_lockers_window() {
  use ModelError::*;
  for dir in [A, B] {
    let (locker, claimer) = if dir == A { (Session, Operator) } else { (Operator, Session) };
    let mut noticed = from(dir, State::Noticed).watched().build();
    noticed.w_z = 3_600;
    noticed.d_c = 7_200;
    noticed.t_claim_open = T0 + 7_300;
    let frozen = apply(noticed, Call::Freeze, Role::Watcher, T0 + 110, &Env::OK, &SOLANA).unwrap().state;
    assert_eq!((frozen.state, frozen.t_freeze), (State::Frozen, T0 + 110));
    assert_eq!(frozen.t_ff(), T0 + 7_300, "T_ff is T_co, not t_Z + W_z");
    for at in [T0 + 110, T0 + 3_709, T0 + 3_710, T0 + 3_711, T0 + 7_299] {
      // Everything the locker could do before the freeze, it can still do.
      assert!(apply(noticed, REFUND, locker, at, &Env::OK, &SOLANA).is_ok(), "{dir:?}: refund before the freeze at T0+{}", at - T0);
      assert!(apply(frozen, REFUND, locker, at, &Env::OK, &SOLANA).is_ok(), "{dir:?}: refund after the freeze at T0+{}", at - T0);
      // And the claimer cannot claim any earlier than it could have.
      assert_eq!(apply(noticed, CLAIM, claimer, at, &Env::OK, &SOLANA), Err(TooEarly));
      assert_eq!(apply(frozen, CLAIM, claimer, at, &Env::OK, &SOLANA), Err(TooEarly), "{dir:?}: claim at T0+{}", at - T0);
    }
    // set_ready stays possible exactly as long as it was (from t_N + 120).
    for at in [T_RMIN, T0 + 3_710, T0 + 7_299] {
      assert!(apply(frozen, Call::SetReady, locker, at, &Env::OK, &SOLANA).is_ok(), "{dir:?}: set_ready at T0+{}", at - T0);
    }
    assert_eq!(apply(frozen, Call::SetReady, locker, T0 + 7_300, &Env::OK, &SOLANA), Err(TooLate));
    assert_eq!(apply(frozen, REFUND, locker, T0 + 7_300, &Env::OK, &SOLANA), Err(TooLate));
    assert_eq!(apply(frozen, CLAIM, claimer, T0 + 7_300, &Env::OK, &SOLANA).unwrap().counter, Some(c::CLAIMS_AFTER_FREEZE));
    // A late freeze still extends: at T_co − 1 the claim opens at T_co − 1 + W_z.
    let late = apply(noticed, Call::Freeze, Role::Watcher, T0 + 7_299, &Env::OK, &SOLANA).unwrap().state;
    assert_eq!(late.t_ff(), T0 + 7_299 + 3_600);
    assert_eq!(apply(late, CLAIM, claimer, T0 + 10_898, &Env::OK, &SOLANA), Err(TooEarly));
    assert!(apply(late, CLAIM, claimer, T0 + 10_899, &Env::OK, &SOLANA).is_ok());
    assert!(apply(late, REFUND, locker, T0 + 10_898, &Env::OK, &SOLANA).is_ok());
  }
}
