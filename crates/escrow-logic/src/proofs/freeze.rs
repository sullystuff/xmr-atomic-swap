//! Group `freeze` (SPEC 11.6): a watcher's only enabled call is `freeze`; after it the locker's
//! `refund` and `set_ready` are enabled until `T_ff`; no payout names the watcher.

use crate::machine::*;

use super::*;

const REFUND: Call = Call::Refund { secret_ok: true };
const CLAIM: Call = Call::Claim { secret_ok: true };

/// The watcher key confers one power. For every record, every call other than `freeze` and
/// every time: the decision for the watcher is exactly the decision for a stranger, the same
/// row or the same refusal. Carrying a row out does not depend on the caller at all
/// ([`execute`] takes none), so the watcher gets what a stranger gets and nothing else. (A
/// stranger can crank the keyless rows and, where the secret is the authorisation, submit a
/// secret it does not have; a watcher holds no spend share.)
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn a_watcher_can_only_freeze() {
  let c = any_consts();
  let s = any_swap(c);
  let call = any_call();
  kani::assume(!matches!(call, Call::Freeze));
  let now = any_time();
  assert!(gate(&s, &call, Role::Watcher, now, c) == gate(&s, &call, Role::Anyone, now, c));
  // And a swap that does not name it gives it nothing even for `freeze`.
  if !s.watcher {
    assert!(gate(&s, &Call::Freeze, Role::Watcher, now, c).is_err());
  }
}

/// `freeze` reveals nothing and moves nothing: it succeeds only for the watcher the swap names
/// or the locker, only in NOTICED before `T_co`, only once; it pays and parks nothing, takes
/// nothing in, and changes the state and `t_freeze` and no other field, so `T_final` and
/// `T_exp` stand. There is no payout destination for a watcher at all ([`Party`]).
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn freeze_moves_nothing() {
  let c = any_consts();
  let s = any_swap(c);
  let caller: Role = kani::any();
  let now = any_time();
  let env = any_env();
  if let Ok(fx) = apply(&s, &Call::Freeze, caller, now, &env, c) {
    assert!(matches!(s.state, State::Noticed) && s.watcher);
    assert!(matches!(caller, Role::Watcher) || is_locker(&s, caller));
    assert!(now < s.t_claim_open);
    assert!(fx.payouts.is_empty() && fx.escrow_in == 0 && fx.volume == 0 && fx.withheld_volume == 0);
    assert!(fx.open_pending == 0 && !fx.closed && fx.open_value_after == env.caps.open_value);
    assert!(fx.counter == Some(counter::FREEZES));
    let mut want = s;
    want.state = State::Frozen;
    want.t_freeze = now;
    assert!(fx.state == want);
    // Only once.
    assert!(apply(&fx.state, &Call::Freeze, kani::any(), any_time(), &env, c).is_err());
  }
  // A swap that names no watcher cannot be frozen by anybody.
  if !s.watcher {
    assert!(apply(&s, &Call::Freeze, caller, now, &env, c).is_err());
  }
}

/// A freeze takes nothing from the locker and gives the claimer nothing early. For every
/// NOTICED record with a positive freeze window and every freeze time, at every later instant
/// `t` before `T_final`:
///
/// * `T_ff >= T_co`: the claim-without-ready never opens earlier than it would have;
/// * the locker's `refund` is enabled throughout `[t_Z, T_ff)`, and wherever it was enabled
///   before the freeze it still is;
/// * the locker's `set_ready` is enabled on `[t_N + d × 60, T_ff)`, and wherever it was enabled
///   before the freeze it still is;
/// * the claimer's `claim` is not enabled before `T_ff`, and is from `T_ff`.
///
/// This is the property SPEC 11.6's formula `T_ff = t_Z + W_z` fails (see KANI.md).
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn a_freeze_never_shortens_the_lockers_window() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(matches!(s.state, State::Noticed));
  let t_z = any_time();
  let who: Role = kani::any();
  if let Ok(fx) = apply(&s, &Call::Freeze, who, t_z, &Env::OK, c) {
    let f = fx.state;
    let t_ff = f.t_ff();
    assert!(t_ff >= s.t_claim_open);
    assert!(t_ff >= t_z + s.w_z as i64);
    assert!(t_ff == s.t_claim_open || t_ff == t_z + s.w_z as i64);
    let t = any_time();
    kani::assume(t >= t_z && t < s.t_final);
    let (locker, claimer) = if s.is_a() { (Role::Session, Role::Operator) } else { (Role::Operator, Role::Session) };
    let refund_before = enabled(&s, &REFUND, locker, t, c);
    let refund_after = enabled(&f, &REFUND, locker, t, c);
    let ready_before = enabled(&s, &Call::SetReady, locker, t, c);
    let ready_after = enabled(&f, &Call::SetReady, locker, t, c);
    let claim_after = enabled(&f, &CLAIM, claimer, t, c);
    assert!(refund_after == (t < t_ff));
    assert!(!refund_before || refund_after);
    assert!(ready_after == (t >= s.t_ready_min(c) && t < t_ff));
    assert!(!ready_before || ready_after);
    assert!(claim_after == (t >= t_ff));
    // The claimer waits at most W_z longer than without the freeze.
    assert!(t_ff < s.t_claim_open + s.w_z as i64 || s.w_z == 0);
  }
}

/// Unfreezing works: for every FROZEN record whose earliest ready precedes `T_co` (as the
/// bounds guarantee, `exits::sequences_of_8_keep_the_deadline_order`), there is an instant at
/// which the locker can set ready, and doing so gives an ordinary READY swap with
/// `T_cd = t_R + W_c`.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn a_frozen_swap_can_always_be_unfrozen() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(matches!(s.state, State::Frozen));
  kani::assume(s.t_ready_min(c) < s.t_claim_open && s.t_claim_open < s.t_final && s.t_freeze < s.t_claim_open);
  let locker = if s.is_a() { Role::Session } else { Role::Operator };
  // The witness: the later of the freeze and the earliest ready.
  let t = if s.t_freeze > s.t_ready_min(c) { s.t_freeze } else { s.t_ready_min(c) };
  match apply(&s, &Call::SetReady, locker, t, &Env::OK, c) {
    Ok(fx) => {
      assert!(matches!(fx.state.state, State::Ready));
      assert!(fx.state.t_ready == t && fx.state.t_claim_deadline == t + s.w_c as i64);
      assert!(fx.payouts.is_empty());
    }
    Err(_) => assert!(false),
  }
}
