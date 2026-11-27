//! Group `exits`: from every funded state, for each party with funds in it, some call it may
//! make (or anyone may) is enabled at some time before `T_exp`, and the locker's at or after it
//! (invariant 2).

use crate::machine::*;

use super::*;

const REFUND: Call = Call::Refund { secret_ok: true };
const CLAIM: Call = Call::Claim { secret_ok: true };

/// Every funded state has an exit for each party with funds in it, and none of them needs the
/// other party, an admin or a watcher. Stated for all records satisfying [`deadline_order`]
/// (every reachable record, by the induction below) and all instants `now`:
///
/// * PENDING: the taker cancels at any time; anyone expires it from `T_pend`.
/// * ACTIVE: the locker refunds at any time; in A anyone returns the escrow from `T_note`; in B
///   anyone returns the take deposit and parks the maker's escrow from `T_exp`.
/// * NOTICED, READY, FROZEN, ABORTED: the claimer claims throughout `[T_final, T_exp)`, and
///   the locker refunds at every instant from `T_exp` on.
/// * HOLD: anyone returns the deposit from `T_hold`. WITHHELD: anyone splits it from `T_split`.
/// * Parked balances: the party they are owed to can always pull them.
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn every_funded_state_has_an_exit_for_each_party() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(deadline_order(&s, c));
  let now = any_time();
  let (locker, claimer) = if s.is_a() { (Role::Session, Role::Operator) } else { (Role::Operator, Role::Session) };
  let on = |call: Call, role: Role| enabled(&s, &call, role, now, c);
  let t_exp = s.t_exp(c);
  match s.state {
    State::Pending => {
      assert!(on(Call::CancelPending, Role::TakerWallet) && on(Call::CancelPending, Role::Session));
      assert!(on(Call::ExpirePending, Role::Anyone) == (now >= s.t_pending_deadline));
    }
    State::Active => {
      assert!(on(REFUND, locker));
      if s.is_a() {
        assert!(on(REFUND, Role::TakerWallet));
        assert!(on(Call::RefundUnnoticed, Role::Anyone) == (now >= s.t_note_deadline));
      } else {
        assert!(on(Call::ExpireUnnoticed, Role::Anyone) == (now >= t_exp));
      }
    }
    State::Noticed | State::Ready | State::Frozen | State::AbortedFree | State::AbortedHold => {
      // ABORTED_FREE exists only in direction A.
      kani::assume(s.is_a() || !matches!(s.state, State::AbortedFree));
      if now >= s.t_final && now < t_exp {
        assert!(on(CLAIM, claimer));
      }
      if now >= t_exp {
        assert!(on(REFUND, locker));
        assert!(!on(CLAIM, claimer));
      }
    }
    State::Hold => assert!(on(Call::ReleaseDeposit, Role::Anyone) == (now >= s.t_hold(c))),
    State::Withheld => assert!(on(Call::SplitDeposit, Role::Anyone) == (now >= s.t_split(c))),
    State::Done | State::None => {}
  }
  // Parked balances, in any state.
  if s.owed_taker != 0 {
    if s.payout_owed() {
      assert!(on(Call::WithdrawOwed(Party::Payout), Role::Payout));
    } else {
      assert!(on(Call::WithdrawOwed(Party::Taker), Role::TakerWallet));
    }
  }
  if s.owed_maker != 0 {
    assert!(on(Call::WithdrawOwed(Party::Maker), Role::Owner));
  }
  if s.owed_treasury != 0 {
    assert!(on(Call::WithdrawOwed(Party::Treasury), Role::Anyone));
  }
}

/// No call leaves a swap stuck: every successful call ends in a state of the machine, and DONE
/// is final (afterwards only parked balances move and evidence can be published).
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn done_is_final() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(matches!(s.state, State::Done));
  let call = any_call();
  if let Ok(fx) = apply(&s, &call, kani::any(), any_time(), &any_env(), c) {
    assert!(matches!(call, Call::WithdrawOwed(_) | Call::PushOwed(_) | Call::PublishEvidence { .. }));
    assert!(matches!(fx.state.state, State::Done));
    assert!(fx.counter.is_none());
  }
}

/// The deadline order, base case: every swap the chain accepts (`lock`, `take`; any caller and
/// environment; both chains) starts with [`deadline_order`]. **Opened at time 0**: with a
/// symbolic opening time the solver has to cancel it out of six-term sums and does not finish;
/// `open_sets_every_deadline_as_the_opening_time_plus_its_window` proves, for every opening
/// time, that the time enters each deadline only as that one added term, and the invariant
/// compares deadlines of one swap with each other, so it holds at every opening time.
#[kani::proof]
#[kani::stub(crate::amounts::deposit_of, super::any_share)]
fn open_establishes_the_deadline_order_at_time_0() {
  let c = any_consts();
  let args: OpenArgs = kani::any();
  if let Ok(fx) = open(&Swap::NONE, &args, kani::any(), 0, &any_env(), c) {
    assert!(deadline_order(&fx.state, c));
  }
}

/// For every opening time: the record `lock`/`take` write is the record they write at time 0
/// with the opening time added to each deadline that is set, and nothing else depends on it
/// (acceptance included).
#[kani::proof]
#[kani::stub(crate::amounts::deposit_of, super::fixed_share)]
fn open_sets_every_deadline_as_the_opening_time_plus_its_window() {
  let c = any_consts();
  let args: OpenArgs = kani::any();
  let caller: Role = kani::any();
  let env = any_env();
  let now = any_time();
  match (open(&Swap::NONE, &args, caller, now, &env, c), open(&Swap::NONE, &args, caller, 0, &env, c)) {
    (Err(a), Err(b)) => assert!(a == b),
    (Ok(a), Ok(b)) => {
      let (s, z) = (a.state, b.state);
      let p = args.params;
      assert!(s.t_lock == now && z.t_lock == 0);
      assert!(s.t_final == now + p.w_f as i64 && z.t_final == p.w_f as i64);
      if matches!(s.state, State::Pending) {
        assert!(matches!(z.state, State::Pending));
        assert!(s.t_pending_deadline == now + z.t_pending_deadline && s.t_active == 0 && s.t_note_deadline == 0);
        assert!(z.t_pending_deadline == p.w_a as i64 || z.t_pending_deadline == p.w_n as i64);
      } else {
        assert!(matches!(s.state, State::Active) && matches!(z.state, State::Active));
        assert!(s.t_active == now && s.t_note_deadline == now + p.w_n as i64 && s.t_pending_deadline == 0);
        assert!(z.t_active == 0 && z.t_note_deadline == p.w_n as i64);
      }
      // Everything else is the same record.
      let mut shifted = s;
      shifted.t_lock = z.t_lock;
      shifted.t_final = z.t_final;
      shifted.t_pending_deadline = z.t_pending_deadline;
      shifted.t_active = z.t_active;
      shifted.t_note_deadline = z.t_note_deadline;
      assert!(shifted == z);
      assert!(a.escrow_in == b.escrow_in && a.counter == b.counter && a.open_pending == b.open_pending && a.open_value_after == b.open_value_after);
    }
    _ => assert!(false),
  }
}

/// The deadline order, induction step: for **every** record that satisfies [`deadline_order`]
/// and every successful call at any time, the new record satisfies it. With the base case this
/// covers every reachable record after any number of calls, not eight. The harnesses below
/// cover every call between them, one group each (the groups only keep each proof small).
fn step_keeps_the_order(call: Call) {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(deadline_order(&s, c));
  if let Ok(fx) = apply(&s, &call, kani::any(), any_time(), &any_env(), c) {
    let n = fx.state;
    assert!(deadline_order(&n, c));
    // Nothing moves a deadline once it is set.
    assert!(n.t_lock == s.t_lock && n.t_final == s.t_final && n.w_z == s.w_z && n.d_c == s.d_c && n.w_c == s.w_c && n.depth == s.depth);
    if matches!(s.state, State::Noticed | State::Ready | State::Frozen | State::AbortedFree | State::AbortedHold) {
      assert!(n.t_notice == s.t_notice && n.t_cut == s.t_cut && n.t_claim_open == s.t_claim_open);
    }
    if matches!(s.state, State::Frozen) {
      assert!(n.t_freeze == s.t_freeze);
    }
    // No call brings a swap back from the deposit sub-machine or from DONE.
    if matches!(s.state, State::Hold | State::Withheld | State::Done) {
      assert!(matches!(n.state, State::Hold | State::Withheld | State::Done));
    }
  }
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn pending_rows_keep_the_deadline_order() {
  let call = any_call();
  kani::assume(matches!(call, Call::Approve { .. } | Call::Fund { .. } | Call::Reject { .. } | Call::CancelPending | Call::ExpirePending));
  step_keeps_the_order(call);
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn post_notice_keeps_the_deadline_order() {
  step_keeps_the_order(Call::PostNotice);
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn freeze_and_abort_keep_the_deadline_order() {
  let call = any_call();
  kani::assume(matches!(call, Call::Freeze | Call::Abort));
  step_keeps_the_order(call);
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn every_other_call_keeps_the_deadline_order() {
  let call = any_call();
  kani::assume(!matches!(
    call,
    Call::Approve { .. } | Call::Fund { .. } | Call::Reject { .. } | Call::CancelPending | Call::ExpirePending | Call::PostNotice | Call::SetReady | Call::Freeze | Call::Abort
  ));
  step_keeps_the_order(call);
}

/// The margin `set_ready` needs: `T_co + W_z + W_c + 86,400 < T_final`.
fn ready_margin(s: &Swap) -> bool {
  s.t_claim_open + s.w_z as i64 + s.w_c as i64 + crate::bounds::DAY_SECS < s.t_final
}

/// `set_ready` in two steps, because the solver cannot rearrange the five-term sum in one.
/// First: every NOTICED or FROZEN record that satisfies [`deadline_order`] has the margin.
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn the_deadline_order_gives_the_ready_margin() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(deadline_order(&s, c));
  if matches!(s.state, State::Noticed | State::Frozen) {
    assert!(ready_margin(&s));
  }
}

/// Second: for every record that satisfies [`deadline_order`] and has the margin (so, by the
/// harness above, for every one that satisfies the invariant), `set_ready` keeps the invariant:
/// from NOTICED (`now < T_co`) and from FROZEN (`now < T_ff`, at most `W_z` after `T_co`),
/// `T_cd = now + W_c < T_final − 86,400`.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn set_ready_keeps_the_deadline_order() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(deadline_order(&s, c) && ready_margin(&s));
  if let Ok(fx) = apply(&s, &Call::SetReady, kani::any(), any_time(), &any_env(), c) {
    let n = fx.state;
    assert!(deadline_order(&n, c));
    assert!(matches!(n.state, State::Ready) && n.t_claim_deadline < n.t_final - crate::bounds::DAY_SECS);
    assert!(n.t_final == s.t_final && n.t_notice == s.t_notice && n.t_claim_open == s.t_claim_open && n.t_freeze == s.t_freeze);
  }
}

/// What the invariant gives, for every record that satisfies it (so for every reachable one):
/// the order of SPEC 3.2 and 11.6.
///
/// `t_N < T_nl`; `T_cut <= T_co − 2M`; the earliest ready precedes `T_co`;
/// `T_co < T_final − W_c − 86,400`; frozen: `t_Z < T_co <= T_ff < T_co + W_z` and
/// `T_ff < T_final − W_c − 86,400`; ready: `T_cd < T_final − 86,400`; `T_final < T_exp`.
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn the_deadline_order_is_the_order_of_the_spec() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(deadline_order(&s, c));
  let day = crate::bounds::DAY_SECS;
  assert!(s.t_final < s.t_exp(c));
  match s.state {
    State::Noticed | State::Ready | State::Frozen | State::AbortedFree | State::AbortedHold => {
      assert!(s.t_notice < s.t_nl());
      assert!(s.t_notice < s.t_cut && s.t_cut <= s.t_claim_open - 2 * c.margin_secs);
      assert!(s.t_ready_min(c) < s.t_claim_open);
      assert!(s.t_claim_open < s.t_final - s.w_c as i64 - day);
    }
    _ => {}
  }
  if matches!(s.state, State::Frozen) {
    assert!(s.w_z != 0);
    assert!(s.t_ff() >= s.t_claim_open && s.t_ff() < s.t_claim_open + s.w_z as i64);
    assert!(s.t_ff() < s.t_final - s.w_c as i64 - day);
    // Unfreezing is possible at some instant.
    assert!(s.t_ready_min(c) < s.t_ff());
  }
  if matches!(s.state, State::Ready) {
    assert!(s.t_claim_deadline < s.t_final - day);
  }
}

/// Sequences (a bounded cross-check of the induction above, which has no bound): open at time 0
/// with symbolic accepted parameters, then three symbolic calls by symbolic callers at
/// non-decreasing symbolic times; the invariant holds after each. Three calls is as far as the
/// solver carries it in minutes (five did not finish in ten).
#[kani::proof]
#[kani::unwind(4)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
#[kani::stub(crate::amounts::deposit_of, super::any_share)]
fn sequences_of_3_keep_the_deadline_order() {
  let c = any_consts();
  let args: OpenArgs = kani::any();
  kani::assume(args.amount < (1 << 6));
  let mut now = 0i64;
  let mut s = match open(&Swap::NONE, &args, Role::TakerWallet, now, &Env::OK, c) {
    Ok(fx) => fx.state,
    Err(_) => return,
  };
  let mut i = 0;
  while i < 3 {
    i += 1;
    let call = any_call();
    let at = any_time();
    kani::assume(at >= now);
    now = at;
    if let Ok(fx) = apply(&s, &call, kani::any(), at, &Env::OK, c) {
      s = fx.state;
    }
    assert!(deadline_order(&s, c));
  }
}
