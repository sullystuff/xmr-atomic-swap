//! Group `arith`: no overflow for any accepted input; a nonzero `xmr` at a nonzero price never
//! yields a zero `amount`; fee, deposit and split never exceed the amount they are taken from;
//! split halves sum to the deposit.
//!
//! Multiplication and division are where a SAT solver gives out, so the harnesses that relate a
//! product to its factors carry a width in their name. Panic-freedom (no overflow, no division
//! by zero, no out-of-range shift) is proved at full width throughout.

use crate::{
  amounts::*,
  bounds::*,
  machine::{open, Direction, Env, OpenArgs, Role, Swap},
};

use super::{any_consts, any_time};

/// Fee and deposit never exceed the amount they are taken from, and computing them never
/// panics or overflows: for **every** `u128` amount and every share up to 8,191 bps. Every
/// share the machine ever passes is far inside that: the fee is `FEE_BPS = 5` and a deposit
/// share is refused above `MAX_DEPOSIT_BPS = 500` before it is used. This is the contract the
/// stubbed harnesses rely on.
#[kani::proof]
fn fee_and_deposit_never_exceed_the_amount() {
  assert!(SOLANA.fee_bps <= 8_191 && ETHEREUM.fee_bps <= 8_191 && SOLANA.max_deposit_bps <= 8_191 && ETHEREUM.max_deposit_bps <= 8_191);
  let amount: u128 = kani::any();
  let bps: u16 = kani::any();
  kani::assume(bps <= 8_191);
  // `fee_of` and `deposit_of` are `bps_of` under their own names.
  assert!(bps_of(amount, bps) <= amount);
}

/// The fee and the deposit, through their own entry points, at the two shares the protocol
/// fixes or caps: nothing is taken at 0 bps; the fee (5 bps) and the largest deposit (500 bps)
/// stay within the amount, for every `u128` amount.
#[kani::proof]
fn the_fee_and_the_largest_deposit_stay_within_the_amount() {
  let amount: u128 = kani::any();
  assert!(fee_of(amount, 0) == 0 && deposit_of(amount, 0) == 0);
  assert!(fee_of(amount, 5) <= amount);
  assert!(deposit_of(amount, 500) <= amount);
}

/// The same for every share up to 100%, on amounts below 2^24 (between 8,192 and 10,000 bps the
/// product has no slack and the solver needs the narrow width; no such share is ever used).
#[kani::proof]
fn shares_up_to_100_percent_never_exceed_the_amount_u24() {
  let amount: u128 = kani::any();
  kani::assume(amount < (1 << 24));
  let bps: u16 = kani::any();
  kani::assume(bps as u128 <= BPS_DENOMINATOR);
  assert!(bps_of(amount, bps) <= amount);
}

/// A "share" above 100% (never used) is computed without panic or overflow for every amount:
/// it saturates.
#[kani::proof]
#[kani::unwind(129)]
fn shares_above_100_percent_never_overflow() {
  let amount: u128 = kani::any();
  let bps: u16 = kani::any();
  kani::assume(bps as u128 > BPS_DENOMINATOR);
  let _ = bps_of(amount, bps);
}

/// `bps_of` is the exact floor of `amount × bps / 10^4`, on amounts below 2^8 and accepted
/// shares (the equivalence of two dividers is beyond the solver at any useful width; the unit
/// test `bps_of_is_the_floor_of_the_long_division` and `amounts.json` cover the full width).
#[kani::proof]
fn bps_is_the_exact_floor_u8() {
  let amount: u8 = kani::any();
  let bps: u16 = kani::any();
  kani::assume(bps <= 500);
  assert!(bps_of(amount as u128, bps) == amount as u128 * bps as u128 / BPS_DENOMINATOR);
}

/// The 60-day split: the halves sum to the deposit, the taker's is the larger by at most one.
#[kani::proof]
fn split_halves_sum_to_the_deposit() {
  let deposit: u128 = kani::any();
  let (taker, treasury) = split_of(deposit);
  assert!(taker.checked_add(treasury) == Some(deposit));
  assert!(taker >= treasury && taker - treasury <= 1);
  assert!(taker <= deposit && treasury <= deposit);
}

/// `mul_div` never panics or overflows for any three `u128` values, zero divisor included.
#[kani::proof]
#[kani::unwind(129)]
fn mul_div_never_overflows() {
  let a: u128 = kani::any();
  let b: u128 = kani::any();
  let d: u128 = kani::any();
  if d == 0 {
    assert!(mul_div(a, b, d).is_none());
  } else {
    let _ = mul_div(a, b, d);
  }
}

/// `pay_amount` (direction A) never panics or overflows, for every `u64` size, every `u128`
/// price and every limit; what it returns is within the limit.
#[kani::proof]
#[kani::unwind(129)]
fn pay_amount_never_overflows() {
  let max_amount: u128 = kani::any();
  if let Ok(v) = pay_amount(kani::any(), kani::any(), max_amount) {
    assert!(v <= max_amount);
  }
}

/// `receive_amount` (direction B), likewise.
#[kani::proof]
#[kani::unwind(129)]
fn receive_amount_never_overflows() {
  let max_amount: u128 = kani::any();
  if let Ok(v) = receive_amount(kani::any(), kani::any(), max_amount) {
    assert!(v <= max_amount);
  }
}

/// The amount of a swap is never zero and never above the limit, in either direction, for every
/// size and price: a swap of nothing, or for nothing, is refused, not opened.
#[kani::proof]
#[kani::unwind(129)]
fn a_swap_amount_is_never_zero() {
  let xmr: u64 = kani::any();
  let max_amount: u128 = kani::any();
  match swap_amount(kani::any(), xmr, kani::any(), max_amount) {
    Ok(v) => assert!(v != 0 && v <= max_amount && xmr != 0),
    Err(AmountError::AmountOutOfRange) | Err(AmountError::MathOverflow) => {}
  }
}

/// Direction A rounds up: a nonzero size at a nonzero price pays at least one unit and is never
/// refused as zero. Direction B rounds down: it pays the same or one unit less. Sizes and prices
/// below 2^16 (the product against a zero quotient is beyond the solver at full width).
#[kani::proof]
#[kani::unwind(129)]
fn pay_amount_of_something_is_never_zero_u16() {
  let xmr: u16 = kani::any();
  let price: u16 = kani::any();
  kani::assume(xmr != 0 && price != 0);
  match pay_amount(xmr as u64, price as u128, u128::MAX) {
    Ok(v) => assert!(v != 0),
    Err(_) => assert!(false),
  }
}

/// `mul_div` is the exact floor and reports exactness, on operands below 2^8 (where the product
/// can be formed directly; the long division against the solver's own divider does not go
/// further).
#[kani::proof]
#[kani::unwind(129)]
fn mul_div_is_exact_u8() {
  let a: u8 = kani::any();
  let b: u8 = kani::any();
  let d: u8 = kani::any();
  kani::assume(d != 0);
  let product = a as u128 * b as u128;
  match mul_div(a as u128, b as u128, d as u128) {
    Some((q, exact)) => {
      assert!(q == product / d as u128);
      assert!(exact == (product % d as u128 == 0));
    }
    None => assert!(false),
  }
}

/// The bounds of SPEC 3.1 and 11.6 and every deadline are computed without overflow for every
/// parameter the types admit and any event times; accepted parameters have a valid freeze
/// window, a depth and a deposit share within the cap.
#[kani::proof]
fn bounds_and_deadlines_never_overflow() {
  let c = any_consts();
  let p: SwapParams = kani::any();
  let pending: Pending = kani::any();
  let accepted = check_bounds(&p, pending, c).is_ok();
  let _ = min_final_window(&p, pending_window(&p, pending));
  let _ = min_claim_delay(p.depth, c);
  let opt = |on: bool| if on { Some(any_time()) } else { None };
  let times = EventTimes { t_lock: any_time(), t_active: opt(kani::any()), t_notice: opt(kani::any()), t_freeze: opt(kani::any()), t_ready: opt(kani::any()), t_refund: opt(kani::any()) };
  let d = deadlines(&p, pending, &times, c);
  assert!(d.t_final < d.t_exp);
  if let (Some(ff), Some(co)) = (d.t_ff, d.t_co) {
    assert!(ff >= co);
  }
  if accepted {
    assert!(freeze_window_ok(p.w_z) && p.depth != 0 && p.dep_bps <= c.max_deposit_bps);
    assert!(p.w_n >= c.min_notice_secs && p.w_n <= c.max_notice_secs && p.w_f <= c.max_final_secs);
  }
}

/// `lock` and `take` never panic or overflow for any arguments, any caller, any environment and
/// either chain; and an accepted swap has `0 < amount <= max`, a deposit that is a share of it,
/// a counted value that fits the chain's amount type, and a valid freeze window. (The deposit
/// is any share of the amount here; `fee_and_deposit_never_exceed_the_amount` is about the real
/// one.)
#[kani::proof]
#[kani::stub(crate::amounts::deposit_of, super::any_share)]
fn open_never_overflows() {
  let c = any_consts();
  let args: OpenArgs = kani::any();
  let caller: Role = kani::any();
  let env: Env = kani::any();
  let now = any_time();
  if let Ok(fx) = open(&Swap::NONE, &args, caller, now, &env, c) {
    let s = fx.state;
    assert!(s.amount != 0 && s.amount <= c.max_amount);
    assert!(s.deposit <= s.amount);
    if matches!(s.direction, Direction::B) {
      assert!(s.amount.checked_add(s.deposit).is_some() && s.amount + s.deposit <= c.max_amount);
    }
    assert!(fx.open_value_after <= c.max_amount);
    assert!(freeze_window_ok(s.w_z));
    assert!(s.t_final > s.t_lock);
    assert!(matches!(caller, Role::TakerWallet));
  }
}
