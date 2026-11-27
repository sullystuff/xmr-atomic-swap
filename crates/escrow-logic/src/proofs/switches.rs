//! Group `switches`: with caps at zero and every pause set, every call except `lock` and `take`
//! gives the same answer (invariant 3). The open value after any sequence equals the sum of the
//! counted values of the swaps still open; it never underflows.

use crate::{caps::*, machine::*};

use super::*;

/// Invariant 3. A call on an existing swap is decided by [`gate`] and carried out by
/// [`execute_plan`]. `gate` takes the swap, the call, the caller and the time: by its signature
/// no cap, pause, pending count or other switch reaches the decision. This harness proves the
/// rest: for every record, every row, **every payout plan whatsoever** and any two positions of
/// the admin's and the maker's switches (caps on or off and at any value, zero included; paused
/// or not; any number of pending swaps), carrying the row out gives the identical result:
/// state, payouts paid and parked, counters and open value. Only the destinations' ability to
/// receive and the open value itself are held equal.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn no_switch_changes_any_call_but_lock_and_take() {
  let c = any_consts();
  let s = any_swap(c);
  let row = any_row();
  let plan = any_plan();
  let now = any_time();
  let e1 = any_env();
  let mut e2 = any_env();
  e2.taker_can_receive = e1.taker_can_receive;
  e2.maker_can_receive = e1.maker_can_receive;
  e2.treasury_can_receive = e1.treasury_can_receive;
  e2.payout_can_receive = e1.payout_can_receive;
  e2.caps.open_value = e1.caps.open_value;
  assert!(execute_plan(&s, row, &plan, now, &e1, c) == execute_plan(&s, row, &plan, now, &e2, c));
}

/// The same, end to end, with the switches at their worst: every cap zero with the switch on
/// and the maker paused, against no switch set. For every record, call, caller and time the
/// decision is the same, and so are the new state, the counter, the open value and who is paid
/// or parked.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn caps_at_zero_and_every_pause_change_no_answer() {
  let c = any_consts();
  let s = any_swap(c);
  let call = any_call();
  let caller: Role = kani::any();
  let now = any_time();
  let open_value: u128 = kani::any();
  let calm = Env { caps: Caps { open_value, ..Caps::UNLIMITED }, ..Env::OK };
  let hostile = Env { caps: Caps { open_value, ..Caps::INITIAL }, maker_paused: true, open_pending: u16::MAX, ..Env::OK };
  match (apply(&s, &call, caller, now, &calm, c), apply(&s, &call, caller, now, &hostile, c)) {
    (Err(a), Err(b)) => assert!(a == b),
    (Ok(a), Ok(b)) => {
      assert!(a.state.state == b.state.state && a.state.flags == b.state.flags && a.state.outcome == b.state.outcome);
      assert!(a.counter == b.counter && a.closed == b.closed && a.open_pending == b.open_pending);
      assert!(a.open_value_after == b.open_value_after && a.escrow_in == b.escrow_in);
      // A claim's two runs draw two arbitrary fees (one may be zero and so not a payout), so
      // its payout list is compared by the harness above, for any plan, and not here.
      if !matches!(call, Call::Claim { .. }) {
        assert!(a.payouts == b.payouts);
      }
    }
    _ => assert!(false),
  }
}

/// The switches do gate `lock` and `take`: a paused maker and a fresh deployment (switch on,
/// every cap zero) refuse every open; and with the switch on, an accepted open respects both
/// caps exactly.
#[kani::proof]
#[kani::stub(crate::amounts::deposit_of, super::any_share)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn lock_and_take_obey_the_caps() {
  let c = any_consts();
  let args: OpenArgs = kani::any();
  let now = any_time();
  let env = any_env();
  let caller: Role = kani::any();
  let r = open(&Swap::NONE, &args, caller, now, &env, c);
  if env.maker_paused {
    assert!(r.is_err());
  }
  if env.caps.on && env.caps.max_swap == 0 {
    assert!(r.is_err());
  }
  if let Ok(fx) = r {
    let s = fx.state;
    assert!(counted_invariant(&s));
    // The add is exact and fits the chain's amount type.
    assert!(env.caps.open_value.checked_add(counted(&s)) == Some(fx.open_value_after));
    assert!(fx.open_value_after <= c.max_amount);
    if env.caps.on {
      assert!(s.amount <= env.caps.max_swap);
      assert!(fx.open_value_after <= env.caps.max_open);
    }
  }
  // Exactly at a cap is allowed: the caps alone never refuse an open that fits them.
  if let Err(e) = r {
    if matches!(e, GateError::SwapCapExceeded) {
      assert!(env.caps.on && args.amount > env.caps.max_swap);
    }
    if matches!(e, GateError::OpenCapExceeded) {
      assert!(env.caps.on && args.amount <= env.caps.max_swap);
    }
  }
}

/// The accounting invariant, one step: a swap is flagged `counted` exactly while it is open.
/// For every record that satisfies it and every successful call, the new record satisfies it,
/// and the open value changes by exactly the counted value at the one transition that leaves
/// the open states (saturating at zero) and not at all otherwise. Together with
/// `lock_and_take_obey_the_caps` this is an induction over any number of swaps and calls: the
/// open value is the sum of the counted values of the swaps still open.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn counted_flag_is_an_invariant() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(counted_invariant(&s));
  let call = any_call();
  let env = any_env();
  if let Ok(fx) = apply(&s, &call, kani::any(), any_time(), &env, c) {
    let n = fx.state;
    assert!(counted_invariant(&n));
    let leaves = s.state.is_open() && !n.state.is_open();
    if leaves {
      assert!(fx.open_value_after == env.caps.open_value.saturating_sub(counted(&s)));
      assert!(matches!(n.state, State::Hold | State::Done));
    } else {
      assert!(fx.open_value_after == env.caps.open_value);
    }
    // A swap never re-enters the open states, so it can never be subtracted twice.
    assert!(s.state.is_open() || !n.state.is_open());
    // The counted value itself never changes while the swap is open.
    assert!(n.amount == s.amount && n.deposit == s.deposit && n.direction == s.direction);
  }
}

/// Sequences over two swaps of one asset: both open with symbolic accepted arguments while
/// `others` is already open, then up to eight symbolic calls on either, by symbolic callers at
/// non-decreasing symbolic times, with the switches in any position at every step. After every
/// step the open value is `others` plus the counted values of the swaps still open: it never
/// underflows and never drifts. **Bounded to amounts below 2^12** (a sum over three terms the
/// solver cannot carry at full width over eight calls); `counted_flag_is_an_invariant` and
/// `lock_and_take_obey_the_caps` give the same by induction for every amount and any number of
/// swaps and calls.
#[kani::proof]
#[kani::unwind(9)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
#[kani::stub(crate::amounts::deposit_of, super::any_share)]
fn sequences_of_8_open_value_is_the_sum_of_open_swaps_u12() {
  let c = any_consts();
  let others: u128 = kani::any();
  kani::assume(others < (1 << 12));
  let mut caps: Caps = kani::any();
  caps.open_value = others;
  let a0: OpenArgs = kani::any();
  let a1: OpenArgs = kani::any();
  kani::assume(a0.amount < (1 << 12) && a1.amount < (1 << 12));
  let fx0 = match open(&Swap::NONE, &a0, Role::TakerWallet, 0, &Env { caps, ..Env::OK }, c) {
    Ok(fx) => fx,
    Err(_) => return,
  };
  caps.open_value = fx0.open_value_after;
  let fx1 = match open(&Swap::NONE, &a1, Role::TakerWallet, 0, &Env { caps, ..Env::OK }, c) {
    Ok(fx) => fx,
    Err(_) => return,
  };
  let mut swaps = [fx0.state, fx1.state];
  let mut open_value = fx1.open_value_after;
  let mut now = 0i64;
  let sum = |sw: &[Swap; 2]| {
    let part = |s: &Swap| if s.state.is_open() { counted(s) } else { 0 };
    others + part(&sw[0]) + part(&sw[1])
  };
  assert!(open_value == sum(&swaps));
  let mut i = 0;
  while i < 8 {
    i += 1;
    let which: bool = kani::any();
    let k = which as usize;
    let call = any_call();
    let at = any_time();
    kani::assume(at >= now);
    now = at;
    let mut env = any_env();
    env.caps.open_value = open_value;
    if let Ok(fx) = apply(&swaps[k], &call, kani::any(), at, &env, c) {
      swaps[k] = fx.state;
      open_value = fx.open_value_after;
    }
    assert!(open_value == sum(&swaps));
  }
}
