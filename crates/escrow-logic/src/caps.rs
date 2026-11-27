//! SPEC 11.1: the beta caps and the open-value accounting of one escrowed asset.
//!
//! A swap's *counted value* is `amount` in direction A and `amount + deposit` in direction B. It
//! is added to the asset's open value when the swap opens and subtracted exactly once, when the
//! swap leaves the open states (on entering HOLD or DONE). The swap's `counted` flag is set by
//! the add and cleared by the subtract. The add is exact: an open that would overflow the
//! chain's amount type is refused, so the open value always equals the sum of the counted values
//! of the swaps still open. The subtract saturates and cannot fail.

/// The caps of one asset and the global switch, as read at the call.
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
  /// `caps_on`: with the switch off nothing is checked; the accounting continues.
  pub on: bool,
  /// Largest `amount` of one swap.
  pub max_swap: u128,
  /// Largest open value at once.
  pub max_open: u128,
  /// The asset's open value before the call.
  pub open_value: u128,
}
impl Caps {
  /// The switch on with caps no swap of a `u64` amount can reach.
  pub const UNLIMITED: Caps = Caps { on: true, max_swap: u64::MAX as u128, max_open: u64::MAX as u128, open_value: 0 };
  /// The state after `initialize`: the switch on and every cap zero (fail closed).
  pub const INITIAL: Caps = Caps { on: true, max_swap: 0, max_open: 0, open_value: 0 };
  /// `max(0, max_open − open_value)`.
  pub fn headroom(&self) -> u128 {
    self.max_open.saturating_sub(self.open_value)
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapError {
  SwapCapExceeded,
  OpenCapExceeded,
  /// Caps off, and the counted value or the new open value does not fit the chain's amount type.
  MathOverflow,
}

/// The counted value of a swap; `None` when it does not fit `u128`.
pub fn counted_value(direction_a: bool, amount: u128, deposit: u128) -> Option<u128> {
  if direction_a {
    Some(amount)
  } else {
    amount.checked_add(deposit)
  }
}

/// The check of `lock` and `take`. Returns the asset's open value after the open.
///
/// With the switch on: `amount > max_swap` is `SwapCapExceeded`, then
/// `open_value + counted > max_open` is `OpenCapExceeded`; exactly at a cap is allowed. With the
/// switch off only the width of the chain's amount type (`max_total`) limits the sum.
pub fn open_check(caps: &Caps, direction_a: bool, amount: u128, deposit: u128, max_total: u128) -> Result<u128, CapError> {
  if caps.on && amount > caps.max_swap {
    return Err(CapError::SwapCapExceeded);
  }
  let sum = match counted_value(direction_a, amount, deposit) {
    Some(counted) => caps.open_value.checked_add(counted),
    None => None,
  };
  let limit = if caps.on && caps.max_open < max_total { caps.max_open } else { max_total };
  match sum {
    Some(v) if v <= limit => Ok(v),
    _ if caps.on => Err(CapError::OpenCapExceeded),
    _ => Err(CapError::MathOverflow),
  }
}

/// The open value after a counted swap leaves the open states. Saturates at zero: it MUST NOT be
/// able to fail an exit.
pub fn close_value(open_value: u128, direction_a: bool, amount: u128, deposit: u128) -> u128 {
  let counted = match counted_value(direction_a, amount, deposit) {
    Some(v) => v,
    None => u128::MAX,
  };
  open_value.saturating_sub(counted)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn exactly_at_a_cap_is_allowed() {
    let caps = Caps { on: true, max_swap: 100, max_open: 1_000, open_value: 890 };
    let max = u64::MAX as u128;
    // Direction A counts the amount; direction B the amount and the deposit.
    assert_eq!(open_check(&caps, true, 100, 5, max), Ok(990));
    assert_eq!(open_check(&caps, true, 101, 5, max), Err(CapError::SwapCapExceeded));
    assert_eq!(open_check(&caps, false, 100, 10, max), Ok(1_000));
    assert_eq!(open_check(&caps, false, 100, 11, max), Err(CapError::OpenCapExceeded));
    assert_eq!(caps.headroom(), 110);
    assert_eq!(Caps { open_value: 5_000, ..caps }.headroom(), 0);
    // Fail closed.
    assert_eq!(open_check(&Caps::INITIAL, true, 1, 0, max), Err(CapError::SwapCapExceeded));
    // Switched off: only the amount type limits the sum, and the add stays exact.
    let off = Caps { on: false, max_swap: 0, max_open: 0, open_value: max - 10 };
    assert_eq!(open_check(&off, true, 10, 0, max), Ok(max));
    assert_eq!(open_check(&off, true, 11, 0, max), Err(CapError::MathOverflow));
    assert_eq!(open_check(&off, false, u128::MAX, 1, u128::MAX), Err(CapError::MathOverflow));
    // The subtract saturates.
    assert_eq!(close_value(1_000, true, 100, 5), 900);
    assert_eq!(close_value(1_000, false, 100, 5), 895);
    assert_eq!(close_value(50, false, 100, 5), 0);
    assert_eq!(close_value(50, false, u128::MAX, 5), 0);
  }
}
