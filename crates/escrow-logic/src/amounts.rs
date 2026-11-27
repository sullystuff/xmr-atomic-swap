//! SPEC 3.1: integer arithmetic. Amounts are `u128` here; a chain narrows them with `max_amount`
//! (`u64::MAX` on Solana).

/// Piconero per XMR.
pub const PICONERO_PER_XMR: u128 = 1_000_000_000_000;
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Why an amount cannot be computed or is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmountError {
  /// The result does not fit the chain's amount type.
  MathOverflow,
  /// A swap whose `xmr` or `amount` is zero (SPEC 3.1).
  AmountOutOfRange,
}

/// `floor(a × b / d)` and whether the division was exact, with a 256-bit intermediate. `None`
/// when `d` is zero or the quotient does not fit 128 bits.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<(u128, bool)> {
  const LOW: u128 = u64::MAX as u128;
  // a × b as (hi, lo) 128-bit halves.
  let (a_hi, a_lo) = (a >> 64, a & LOW);
  let (b_hi, b_lo) = (b >> 64, b & LOW);
  let ll = a_lo * b_lo;
  let lh = a_lo * b_hi;
  let hl = a_hi * b_lo;
  let hh = a_hi * b_hi;
  let mid = (ll >> 64) + (lh & LOW) + (hl & LOW);
  let lo = (ll & LOW) | (mid << 64);
  let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
  if hi >= d {
    return None; // d == 0, or the quotient does not fit 128 bits
  }
  // Long division of (hi, lo) by d, one bit at a time. hi < d, so the quotient fits.
  let mut rem = hi;
  let mut q = 0u128;
  let mut i = 128u32;
  while i > 0 {
    i -= 1;
    let top = rem >> 127;
    rem = (rem << 1) | ((lo >> i) & 1);
    if top == 1 || rem >= d {
      rem = rem.wrapping_sub(d);
      q |= 1 << i;
    }
  }
  Some((q, rem == 0))
}

fn fit(v: u128, max_amount: u128) -> Result<u128, AmountError> {
  if v > max_amount {
    return Err(AmountError::MathOverflow);
  }
  Ok(v)
}

/// Direction A: `amount = ceil(xmr × price / 10^12)`. `price` is asset base units per 1 XMR.
pub fn pay_amount(xmr: u64, price: u128, max_amount: u128) -> Result<u128, AmountError> {
  let (q, exact) = mul_div(xmr as u128, price, PICONERO_PER_XMR).ok_or(AmountError::MathOverflow)?;
  let q = if exact { q } else { q.checked_add(1).ok_or(AmountError::MathOverflow)? };
  fit(q, max_amount)
}

/// Direction B: `amount = floor(xmr × price / 10^12)`.
pub fn receive_amount(xmr: u64, price: u128, max_amount: u128) -> Result<u128, AmountError> {
  let (q, _) = mul_div(xmr as u128, price, PICONERO_PER_XMR).ok_or(AmountError::MathOverflow)?;
  fit(q, max_amount)
}

/// The escrowed amount of a swap of `xmr` at `price`: [`pay_amount`] in direction A,
/// [`receive_amount`] in direction B. **A swap whose `xmr` or `amount` is zero is refused**
/// (`AmountOutOfRange`, SPEC 3.1): direction B rounds down, so a dust take can compute to zero,
/// and such a swap would lock the taker's XMR against nothing.
pub fn swap_amount(direction_a: bool, xmr: u64, price: u128, max_amount: u128) -> Result<u128, AmountError> {
  if xmr == 0 {
    return Err(AmountError::AmountOutOfRange);
  }
  let amount = if direction_a { pay_amount(xmr, price, max_amount)? } else { receive_amount(xmr, price, max_amount)? };
  if amount == 0 {
    return Err(AmountError::AmountOutOfRange);
  }
  Ok(amount)
}

/// `floor(amount × bps / 10^4)`: the deposit `D` and the protocol fee.
///
/// For `bps <= 10^4` (every share the protocol uses: `MAX_DEPOSIT_BPS = 500`, `FEE_BPS = 5`) the
/// result is at most `amount` and nothing can overflow. A `bps` above `10^4` is not a share; the
/// result then saturates at `u128::MAX` instead of wrapping.
pub fn bps_of(amount: u128, bps: u16) -> u128 {
  let b = bps as u128;
  if b <= BPS_DENOMINATOR {
    // amount = q × 10^4 + r, so floor(amount × b / 10^4) = q × b + floor(r × b / 10^4) exactly.
    let q = amount / BPS_DENOMINATOR;
    let r = amount % BPS_DENOMINATOR;
    q * b + r * b / BPS_DENOMINATOR
  } else {
    match mul_div(amount, b, BPS_DENOMINATOR) {
      Some((q, _)) => q,
      None => u128::MAX,
    }
  }
}

/// Anti-spam deposit `D = floor(amount × dep_bps / 10^4)`.
pub fn deposit_of(amount: u128, dep_bps: u16) -> u128 {
  bps_of(amount, dep_bps)
}

/// Protocol fee `floor(amount × fee_bps / 10^4)`, taken only on a claim.
pub fn fee_of(amount: u128, fee_bps: u16) -> u128 {
  bps_of(amount, fee_bps)
}

/// The 60-day split of a withheld deposit: `(ceil(D/2) to the taker, floor(D/2) to the treasury)`.
pub fn split_of(deposit: u128) -> (u128, u128) {
  (deposit - deposit / 2, deposit / 2)
}

/// Value of the highest used tier whose threshold is `<= xmr`. Tier 0 has threshold 0; a tier
/// with value 0 is unused and unused tiers trail. `None` if the tiers are malformed or tier 0 is
/// unused.
pub fn tier_value<T: Copy + PartialEq + Default>(xmr: u64, above: &[u64; 3], values: &[T; 3]) -> Option<T> {
  if !tiers_well_formed(above, values) {
    return None;
  }
  let zero = T::default();
  let mut out = None;
  let mut i = 0;
  while i < 3 {
    if values[i] != zero && xmr >= above[i] {
      out = Some(values[i]);
    }
    i += 1;
  }
  out
}

/// `above[0] == 0`, tier 0 used, used tiers have strictly increasing thresholds, unused tiers
/// trail (their thresholds are ignored).
pub fn tiers_well_formed<T: Copy + PartialEq + Default>(above: &[u64; 3], values: &[T; 3]) -> bool {
  let zero = T::default();
  if above[0] != 0 || values[0] == zero {
    return false;
  }
  let mut seen_unused = false;
  let mut i = 1;
  while i < 3 {
    if values[i] == zero {
      seen_unused = true;
    } else if seen_unused || above[i] <= above[i - 1] {
      return false;
    }
    i += 1;
  }
  true
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The share of an amount is computed without a 256-bit product; it must still be the exact
  /// floor that the long division gives.
  #[test]
  fn bps_of_is_the_floor_of_the_long_division() {
    let amounts = [0u128, 1, 9_999, 10_000, 10_001, 19_999, 123_456_789_012_345_678, u64::MAX as u128, u64::MAX as u128 + 1, u128::MAX - 1, u128::MAX];
    for a in amounts {
      for bps in [0u16, 1, 5, 137, 499, 500, 9_999, 10_000] {
        let (q, _) = mul_div(a, bps as u128, BPS_DENOMINATOR).unwrap();
        assert_eq!(bps_of(a, bps), q, "{a} × {bps}");
        assert!(bps_of(a, bps) <= a);
      }
    }
    // Above 100% is not a share: it saturates instead of wrapping.
    assert_eq!(bps_of(u128::MAX, 20_000), u128::MAX);
    assert_eq!(bps_of(1_000, 20_000), 2_000);
  }

  #[test]
  fn no_std_arithmetic_matches_the_spec_examples() {
    assert_eq!(pay_amount(1, 1, u128::MAX), Ok(1));
    assert_eq!(receive_amount(1, 1, u128::MAX), Ok(0));
    assert_eq!(swap_amount(false, 1, 1, u128::MAX), Err(AmountError::AmountOutOfRange));
    assert_eq!(pay_amount(u64::MAX, 1_000_000_000_001, u64::MAX as u128), Err(AmountError::MathOverflow));
    assert_eq!(split_of(7), (4, 3));
    assert_eq!(tier_value(4, &[0, 5, 0], &[7u64, 9, 0]), Some(7));
    assert_eq!(mul_div(5, 5, 0), None);
  }
}
