//! Group `windows`: for every state and every `now`, secret-bearing calls are enabled for at
//! most one party (invariant 1), including FROZEN.

use crate::machine::*;

use super::*;

const REFUND: Call = Call::Refund { secret_ok: true };
const CLAIM: Call = Call::Claim { secret_ok: true };

/// For **every** record (no deadline order is assumed), every instant and every pair of callers:
/// the refund, which reveals the locker's share, and the claim, which reveals the claimer's, are
/// never both enabled. Whoever submits them, at most one party's secret can be on its way.
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn secret_calls_are_enabled_for_at_most_one_party() {
  let c = any_consts();
  let s = any_swap(c);
  let now = any_time();
  let r1: Role = kani::any();
  let r2: Role = kani::any();
  let refund = enabled(&s, &REFUND, r1, now, c);
  let claim = enabled(&s, &CLAIM, r2, now, c);
  assert!(!(refund && claim));
  // A claim is never possible without a notice on record, in any state.
  if matches!(s.state, State::Pending | State::Active | State::Hold | State::Withheld | State::Done) {
    assert!(!claim);
  }
}

/// Where the secret is not the authorisation (Solana), the caller is the party: the locker's
/// keys can never claim, the claimer's can never refund, and nobody else can do either.
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn only_the_party_can_submit_its_secret_call_solana() {
  let c = &crate::bounds::SOLANA;
  let s = any_swap(c);
  let now = any_time();
  let r: Role = kani::any();
  if enabled(&s, &REFUND, r, now, c) {
    assert!(is_locker(&s, r));
  }
  if enabled(&s, &CLAIM, r, now, c) {
    assert!(is_claimer(&s, r));
  }
  assert!(!(is_locker(&s, r) && is_claimer(&s, r)));
}

/// The table of SPEC 3.2 and 11.6, state by state, for every record: when exactly each of the
/// two secret-bearing calls is enabled for its party.
#[kani::proof]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn secret_call_windows_are_the_table() {
  let c = any_consts();
  let s = any_swap(c);
  let now = any_time();
  let (locker, claimer) = if s.is_a() { (Role::Session, Role::Operator) } else { (Role::Operator, Role::Session) };
  let refund = enabled(&s, &REFUND, locker, now, c);
  let claim = enabled(&s, &CLAIM, claimer, now, c);
  let t_final = s.t_final;
  let t_exp = s.t_exp(c);
  let before = |limit: i64| now < limit && now < t_final;
  match s.state {
    State::Active => assert!(refund && !claim),
    State::Noticed => {
      assert!(refund == (before(s.t_claim_open) || now >= t_exp));
      assert!(claim == (now >= s.t_claim_open && now < t_exp));
    }
    State::Ready => {
      assert!(claim == (before(s.t_claim_deadline) || (now >= t_final && now < t_exp)));
      assert!(refund == ((now >= s.t_claim_deadline && now < t_final) || (now >= s.t_claim_deadline && now >= t_exp)));
    }
    State::Frozen => {
      assert!(refund == (before(s.t_ff()) || now >= t_exp));
      assert!(claim == ((now >= s.t_ff() || now >= t_final) && now < t_exp));
    }
    State::AbortedFree | State::AbortedHold => {
      // ABORTED_FREE exists only in direction A.
      let exists = s.is_a() || matches!(s.state, State::AbortedHold);
      assert!(refund == (exists && (now < t_final || now >= t_exp)));
      assert!(claim == (now >= t_final && now < t_exp));
    }
    State::Pending | State::Hold | State::Withheld | State::Done => assert!(!refund && !claim),
    State::None => unreachable!(),
  }
}
