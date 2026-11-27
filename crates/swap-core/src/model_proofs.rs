//! Kani proof harnesses for the reference model (SPEC 11.4): `cargo kani -p swap-core`.
//!
//! The rules live in `escrow-logic`, where the groups `conservation`, `windows`, `exits`,
//! `switches`, `freeze`, `arith` and `encodings` are proved (`crates/escrow-logic/KANI.md`).
//! This crate's model is `escrow_logic::machine::apply(..).map(Effects::from)` and nothing else,
//! so what is proved here is what that line adds:
//!
//! * the conversion [`Effects::from`] loses and invents nothing: every field and every payout,
//!   in order;
//! * [`crate::model::MakerRecord::record`] can never fail, saturates, and moves exactly the one
//!   counter a transition names (SPEC 3.7: "every update saturates and can never fail");
//! * the amount wrappers of [`crate::amounts`] translate the two refusals of the shared
//!   arithmetic faithfully and pass every amount through unchanged.

use crate::{
  amounts::{lift, AmountError},
  error::Error,
  model::{counter, Effects, MakerRecord, SwapState},
};

/// For **every** value the shared machine can return (any record, zero to two payouts of any
/// content, any counter and totals): the model's `Effects` carries exactly that.
#[kani::proof]
#[kani::unwind(4)]
fn model_effects_are_the_shared_machines() {
  let theirs: escrow_logic::machine::Effects = kani::any();
  let ours = Effects::from(theirs);
  assert!(ours.state == theirs.state);
  assert!(ours.payouts.len() == theirs.payouts.len() && ours.payouts.len() <= escrow_logic::machine::MAX_PAYOUTS);
  let mut i = 0;
  while i < ours.payouts.len() {
    assert!(ours.payouts[i] == theirs.payouts.as_slice()[i]);
    i += 1;
  }
  assert!(ours.escrow_in == theirs.escrow_in && ours.counter == theirs.counter && ours.response_secs == theirs.response_secs);
  assert!(ours.volume == theirs.volume && ours.withheld_volume == theirs.withheld_volume);
  assert!(ours.open_pending == theirs.open_pending && ours.closed == theirs.closed);
  assert!(ours.open_value_after == theirs.open_value_after);
}

/// `MakerRecord::record` for any record and any effects: it cannot panic or overflow; exactly
/// the named counter moves, by one, saturating at `u32::MAX`; the sums saturate and respect the
/// chain's limit; `open_pending` moves by the step given and never wraps.
#[kani::proof]
#[kani::unwind(41)]
fn maker_record_saturates_and_never_fails() {
  let mut m = MakerRecord::default();
  let slot: usize = kani::any();
  kani::assume(slot < counter::COUNT);
  m.counters[slot] = kani::any();
  m.response_secs_sum = kani::any();
  m.volume = kani::any();
  m.withheld_volume = kani::any();
  m.open_pending = kani::any();
  let before = m.clone();
  let which: Option<u8> = kani::any();
  if let Some(id) = which {
    kani::assume((id as usize) < counter::COUNT);
  }
  let fx = Effects {
    state: SwapState::NONE,
    payouts: Vec::new(),
    escrow_in: kani::any(),
    counter: which,
    response_secs: kani::any(),
    volume: kani::any(),
    withheld_volume: kani::any(),
    open_pending: kani::any(),
    closed: kani::any(),
    open_value_after: kani::any(),
  };
  let max_total: u128 = kani::any();
  m.record(&fx, max_total);
  let mut i = 0;
  while i < counter::COUNT {
    let moved = which == Some(i as u8);
    let want = if moved { before.counters[i].saturating_add(1) } else { before.counters[i] };
    assert!(m.counters[i] == want);
    assert!(m.counters[i] >= before.counters[i]);
    i += 1;
  }
  assert!(m.response_secs_sum >= before.response_secs_sum);
  assert!(m.volume <= max_total && m.withheld_volume <= max_total);
  if before.volume <= max_total {
    assert!(m.volume >= before.volume);
  }
  match fx.open_pending {
    1 => assert!(m.open_pending == before.open_pending.saturating_add(1)),
    -1 => assert!(m.open_pending == before.open_pending.saturating_sub(1)),
    _ => assert!(m.open_pending == before.open_pending),
  }
}

/// The amount wrappers (`pay_amount`, `receive_amount`, `swap_amount`) are the shared arithmetic
/// followed by this translation: an amount passes unchanged, `MathOverflow` stays
/// `MathOverflow`, `AmountOutOfRange` stays `AmountOutOfRange`.
#[kani::proof]
fn amount_wrappers_translate_faithfully() {
  let amount: u128 = kani::any();
  assert!(lift(Ok(amount)) == Ok(amount));
  assert!(lift(Err(AmountError::MathOverflow)) == Err(Error::MathOverflow));
  assert!(lift(Err(AmountError::AmountOutOfRange)) == Err(Error::AmountOutOfRange));
}
