//! SPEC 3.1 and 3.2: protocol constants per chain, integer arithmetic, per-swap bounds and the
//! derivation of every deadline. Clients reach these through the wasm API so nobody re-derives
//! them.
//!
//! The rules themselves live in the dependency-free `escrow-logic` crate (SPEC 11.4), which the
//! Solana program shares; this module re-exports them and adapts the error type.

use crate::error::{Error, Result};

pub use escrow_logic::amounts::{
  bps_of, deposit_of, fee_of, mul_div, split_of, tier_value, tiers_well_formed, AmountError, BPS_DENOMINATOR, PICONERO_PER_XMR,
};
pub use escrow_logic::bounds::{
  check_bounds, deadlines, delta_cut, freeze_window_ok, min_claim_delay, min_claim_window, min_final_window, pending_window,
  BoundError, Chain, ChainConsts, Deadlines, EventTimes, Pending, SwapParams, DAY_SECS, ETHEREUM, MAX_FREEZE_SECS,
  MIN_APPROVAL_SECS, MIN_FREEZE_SECS, SOLANA,
};
pub use escrow_logic::caps::{close_value, counted_value, open_check, CapError, Caps};

pub(crate) fn lift(r: core::result::Result<u128, AmountError>) -> Result<u128> {
  r.map_err(|e| match e {
    AmountError::MathOverflow => Error::MathOverflow,
    AmountError::AmountOutOfRange => Error::AmountOutOfRange,
  })
}

/// Direction A: `amount = ceil(xmr × price / 10^12)`. `price` is asset base units per 1 XMR.
pub fn pay_amount(xmr: u64, price: u128, c: &ChainConsts) -> Result<u128> {
  lift(escrow_logic::amounts::pay_amount(xmr, price, c.max_amount))
}

/// Direction B: `amount = floor(xmr × price / 10^12)`.
pub fn receive_amount(xmr: u64, price: u128, c: &ChainConsts) -> Result<u128> {
  lift(escrow_logic::amounts::receive_amount(xmr, price, c.max_amount))
}

/// The escrowed amount of a swap of `xmr` at `price`: [`pay_amount`] in direction A,
/// [`receive_amount`] in direction B. **A swap whose `xmr` or `amount` is zero is refused**
/// (`AmountOutOfRange`, SPEC 3.1): direction B rounds down, so a dust take can compute to zero,
/// and such a swap would lock the taker's XMR against nothing.
pub fn swap_amount(direction_a: bool, xmr: u64, price: u128, c: &ChainConsts) -> Result<u128> {
  lift(escrow_logic::amounts::swap_amount(direction_a, xmr, price, c.max_amount))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rounding() {
    let xmr = PICONERO_PER_XMR as u64;
    // Exactly 1 XMR at price p pays exactly p.
    assert_eq!(pay_amount(xmr, 150_000_000, &SOLANA).unwrap(), 150_000_000);
    assert_eq!(receive_amount(xmr, 150_000_000, &SOLANA).unwrap(), 150_000_000);
    // 1 piconero at price 1: 10^-12 of a base unit. A pays 1 (ceil), B receives 0 (floor).
    assert_eq!(pay_amount(1, 1, &SOLANA).unwrap(), 1);
    assert_eq!(receive_amount(1, 1, &SOLANA).unwrap(), 0);
    // 0.333... XMR at 3 units: exact.
    assert_eq!(pay_amount(333_333_333_333, 3_000_000_000_000, &SOLANA).unwrap(), 999_999_999_999);
    assert_eq!(pay_amount(333_333_333_333, 3, &SOLANA).unwrap(), 1);
    assert_eq!(receive_amount(333_333_333_333, 3, &SOLANA).unwrap(), 0);
    assert_eq!(pay_amount(0, 5, &SOLANA).unwrap(), 0);
  }

  #[test]
  fn zero_swaps_are_refused() {
    let xmr1 = PICONERO_PER_XMR as u64;
    for c in [&SOLANA, &ETHEREUM] {
      assert_eq!(swap_amount(true, xmr1, 150_000_000, c).unwrap(), 150_000_000);
      assert_eq!(swap_amount(false, xmr1, 150_000_000, c).unwrap(), 150_000_000);
      // Zero XMR, in either direction.
      assert_eq!(swap_amount(true, 0, 150_000_000, c), Err(Error::AmountOutOfRange));
      assert_eq!(swap_amount(false, 0, 150_000_000, c), Err(Error::AmountOutOfRange));
      // A dust take: floor(1 × 1 / 10^12) = 0. The same size in direction A pays 1 (ceil).
      assert_eq!(swap_amount(false, 1, 1, c), Err(Error::AmountOutOfRange));
      assert_eq!(swap_amount(true, 1, 1, c).unwrap(), 1);
      // The largest take that still rounds to zero, and the smallest that does not.
      assert_eq!(swap_amount(false, 999_999, 1_000_000, c), Err(Error::AmountOutOfRange));
      assert_eq!(swap_amount(false, 1_000_000, 1_000_000, c).unwrap(), 1);
      // A zero price.
      assert_eq!(swap_amount(true, xmr1, 0, c), Err(Error::AmountOutOfRange));
      // Overflow is still overflow.
      assert_eq!(swap_amount(true, u64::MAX, u128::MAX, c), Err(Error::MathOverflow));
    }
  }

  #[test]
  fn overflow_per_chain() {
    // u64::MAX piconero at 10^12 per XMR is u64::MAX lamports: the last value that fits Solana.
    assert_eq!(pay_amount(u64::MAX, 1_000_000_000_000, &SOLANA).unwrap(), u64::MAX as u128);
    assert_eq!(pay_amount(u64::MAX, 1_000_000_000_001, &SOLANA), Err(Error::MathOverflow));
    assert_eq!(receive_amount(u64::MAX, 2_000_000_000_000, &SOLANA), Err(Error::MathOverflow));
    // Ethereum holds it.
    assert_eq!(pay_amount(u64::MAX, 2_000_000_000_000, &ETHEREUM).unwrap(), 2 * u64::MAX as u128);
    // The 256-bit intermediate: xmr × price above 2^128, quotient below it.
    let price = u128::MAX / 1_000_000;
    let got = receive_amount(u64::MAX, price, &ETHEREUM);
    assert_eq!(got, Err(Error::MathOverflow));
    // floor((2^64 − 1) × 2^100 / 10^12), from Python integers.
    let price = 1u128 << 100;
    assert_eq!(receive_amount(u64::MAX, price, &ETHEREUM).unwrap(), 23384026197294446689991306723232298912);
    assert_eq!(pay_amount(u64::MAX, price, &ETHEREUM).unwrap(), 23384026197294446689991306723232298913);
  }

  #[test]
  fn mul_div_matches_u128_when_small() {
    let cases = [(0u128, 5u128, 7u128), (10, 10, 3), (u64::MAX as u128, u64::MAX as u128, 1), (123_456_789, 987_654_321, 1_000)];
    for (a, b, d) in cases {
      let (q, exact) = mul_div(a, b, d).unwrap();
      assert_eq!(q, a * b / d);
      assert_eq!(exact, a * b % d == 0);
    }
    assert!(mul_div(u128::MAX, u128::MAX, 1).is_none());
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX).unwrap(), (u128::MAX, true));
  }

  #[test]
  fn deposit_fee_split() {
    assert_eq!(deposit_of(1_000_000, 500), 50_000);
    assert_eq!(deposit_of(19_999, 500), 999); // floor(999.95)
    assert_eq!(deposit_of(u128::MAX, 500), u128::MAX / 20);
    assert_eq!(fee_of(1_000_000, 5), 500);
    assert_eq!(fee_of(1_999, 5), 0); // floor(0.9995)
    assert_eq!(fee_of(2_000, 5), 1);
    assert_eq!(split_of(0), (0, 0));
    assert_eq!(split_of(1), (1, 0));
    assert_eq!(split_of(7), (4, 3));
    assert_eq!(split_of(8), (4, 4));
    let (t, tr) = split_of(u128::MAX);
    assert_eq!(t + tr, u128::MAX);
    assert_eq!(t, tr + 1);
  }

  #[test]
  fn tiers() {
    let above = [0, 1_000_000_000_000, 50_000_000_000_000];
    let depth = [2u8, 10, 25];
    assert_eq!(tier_value(0, &above, &depth), Some(2));
    assert_eq!(tier_value(999_999_999_999, &above, &depth), Some(2));
    assert_eq!(tier_value(1_000_000_000_000, &above, &depth), Some(10));
    assert_eq!(tier_value(49_999_999_999_999, &above, &depth), Some(10));
    assert_eq!(tier_value(50_000_000_000_000, &above, &depth), Some(25));
    // Unused tiers trail.
    assert_eq!(tier_value(u64::MAX, &[0, 5, 0], &[7u64, 9, 0]), Some(9));
    assert_eq!(tier_value(4, &[0, 0, 0], &[7u64, 0, 0]), Some(7));
    // The threshold of an unused tier is ignored.
    assert_eq!(tier_value(9, &[0, 5, 9], &[1u64, 2, 0]), Some(2));
    // Malformed: first threshold nonzero, tier 0 unused, a gap, non-increasing thresholds.
    assert_eq!(tier_value(9, &[1, 5, 9], &[1u64, 2, 3]), None);
    assert_eq!(tier_value(9, &[0, 5, 9], &[0u64, 2, 3]), None);
    assert_eq!(tier_value(9, &[0, 0, 9], &[1u64, 0, 3]), None);
    assert_eq!(tier_value(9, &[0, 5, 5], &[1u64, 2, 3]), None);
    assert_eq!(tier_value(9, &[0, 5, 4], &[1u64, 2, 3]), None);
  }

  fn base(c: &ChainConsts) -> SwapParams {
    let depth = 10;
    let w_n = c.min_notice_secs;
    let d_c = min_claim_delay(depth, c) as u32;
    let w_c = min_claim_window(c) as u32;
    SwapParams { w_a: 60, w_n, d_c, w_c, w_f: 604_800, depth, dep_bps: 100, w_z: 0 }
  }

  #[test]
  fn spec_table_values() {
    // SPEC 3.1, the Δ_cut row.
    assert_eq!([2, 10, 25].map(|d| delta_cut(d, &SOLANA)), [1_275, 2_715, 5_415]);
    assert_eq!([2, 10, 25].map(|d| delta_cut(d, &ETHEREUM)), [2_460, 3_900, 6_600]);
    // The D_c row.
    assert_eq!([2, 10, 25].map(|d| min_claim_delay(d, &SOLANA)), [3_600, 3_600, 6_015]);
    assert_eq!([2, 10, 25].map(|d| min_claim_delay(d, &ETHEREUM)), [7_200, 7_500, 10_200]);
    assert_eq!(min_claim_window(&SOLANA), 615);
    assert_eq!(min_claim_window(&ETHEREUM), 4_800);
    // MIN_NOTICE_SECS on Ethereum is 300 + F.
    assert_eq!(ETHEREUM.min_notice_secs as i64, 300 + ETHEREUM.finality_secs);
  }

  #[test]
  fn each_bound_at_its_edge() {
    for c in [&SOLANA, &ETHEREUM] {
      let ok = base(c);
      assert_eq!(check_bounds(&ok, Pending::ApprovalWindow, c), Ok(()));
      let check = |f: &dyn Fn(&mut SwapParams), pending| {
        let mut p = ok;
        f(&mut p);
        check_bounds(&p, pending, c)
      };
      use BoundError::*;
      use Pending::*;
      assert_eq!(check(&|p| p.dep_bps = 500, None), Ok(()));
      assert_eq!(check(&|p| p.dep_bps = 501, None), Err(DepositTooHigh));
      assert_eq!(check(&|p| p.w_a = 30, ApprovalWindow), Ok(()));
      assert_eq!(check(&|p| p.w_a = 29, ApprovalWindow), Err(ApprovalWindowOutOfRange));
      assert_eq!(check(&|p| p.w_a = 3_600, ApprovalWindow), Ok(()));
      assert_eq!(check(&|p| p.w_a = 3_601, ApprovalWindow), Err(ApprovalWindowOutOfRange));
      // W_a is not checked when the swap cannot wait for approval.
      assert_eq!(check(&|p| p.w_a = 0, None), Ok(()));
      assert_eq!(check(&|p| p.w_a = 0, FundingWindow), Ok(()));
      assert_eq!(check(&|p| p.w_n = c.min_notice_secs - 1, None), Err(NoticeWindowOutOfRange));
      assert_eq!(check(&|p| p.w_n = 3_600, None), Ok(()));
      assert_eq!(check(&|p| p.w_n = 3_601, None), Err(NoticeWindowOutOfRange));
      assert_eq!(check(&|p| p.depth = 0, None), Err(DepthInvalid));
      assert_eq!(check(&|p| p.d_c -= 1, None), Err(ClaimDelayTooShort));
      assert_eq!(check(&|p| p.w_c -= 1, None), Err(ClaimWindowTooShort));
      // W_f: exactly W_p + W_n + D_c + W_c + 86,400 is accepted, one less is not; W_p differs by start.
      for pending in [None, ApprovalWindow, FundingWindow] {
        let min = min_final_window(&ok, pending_window(&ok, pending)) as u32;
        assert_eq!(check(&|p| p.w_f = min, pending), Ok(()));
        assert_eq!(check(&|p| p.w_f = min - 1, pending), Err(FinalWindowOutOfRange));
      }
      assert_eq!(check(&|p| p.w_f = 2_592_000, None), Ok(()));
      assert_eq!(check(&|p| p.w_f = 2_592_001, None), Err(FinalWindowOutOfRange));
      // Depth 255 needs a claim delay that still fits a 30-day final window.
      let mut deep = ok;
      deep.depth = 255;
      assert_eq!(check_bounds(&deep, None, c), Err(ClaimDelayTooShort));
      deep.d_c = min_claim_delay(255, c) as u32;
      assert_eq!(check_bounds(&deep, None, c), Ok(()));
    }
  }

  #[test]
  fn deadline_order_holds_at_the_extremes() {
    // SPEC 3.2: t_lock <= t_A < t_N < T_cut < T_co, t_R < T_co, T_cd < T_final − 86,400.
    // Direction B funded at the last second with W_n at its cap, notice at the last second
    // (T_nl − 1), ready at the last second (T_co − 1), W_f at its minimum.
    for c in [&SOLANA, &ETHEREUM] {
      for depth in [1u8, 2, 10, 25, 255] {
        let mut p = SwapParams {
          w_a: 60,
          w_n: c.max_notice_secs,
          d_c: min_claim_delay(depth, c) as u32,
          w_c: min_claim_window(c) as u32,
          w_f: 0,
          depth,
          dep_bps: 0,
          w_z: 0,
        };
        for pending in [Pending::FundingWindow, Pending::ApprovalWindow] {
          p.w_f = min_final_window(&p, pending_window(&p, pending)) as u32;
          assert_eq!(check_bounds(&p, pending, c), Ok(()));
          let t_lock = 1_000_000;
          let d0 = deadlines(&p, pending, &EventTimes { t_lock, ..Default::default() }, c);
          let t_active = d0.t_pend.unwrap() - 1;
          let d1 = deadlines(&p, pending, &EventTimes { t_lock, t_active: Some(t_active), ..Default::default() }, c);
          assert!(d1.t_note.unwrap() <= d1.t_nl);
          let t_notice = d1.t_nl - 1;
          let d2 = deadlines(
            &p,
            pending,
            &EventTimes { t_lock, t_active: Some(t_active), t_notice: Some(t_notice), ..Default::default() },
            c,
          );
          assert!(t_notice < d2.t_cut.unwrap());
          assert!(d2.t_cut.unwrap() <= d2.t_co.unwrap() - 2 * c.margin_secs);
          assert!(d2.t_ready_min.unwrap() < d2.t_co.unwrap());
          let t_ready = d2.t_co.unwrap() - 1;
          let d3 = deadlines(
            &p,
            pending,
            &EventTimes { t_lock, t_active: Some(t_active), t_notice: Some(t_notice), t_ready: Some(t_ready), ..Default::default() },
            c,
          );
          assert!(d3.t_cd.unwrap() < d3.t_final - DAY_SECS);
          assert!(d3.t_final < d3.t_exp);
        }
      }
    }
  }
}
