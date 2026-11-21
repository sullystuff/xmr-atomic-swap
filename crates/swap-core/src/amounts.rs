//! SPEC 3.1 and 3.2: protocol constants per chain, integer arithmetic, per-swap bounds and the
//! derivation of every deadline. Clients reach these through the wasm API so nobody re-derives
//! them.

use crate::error::{Error, Result};

/// Piconero per XMR.
pub const PICONERO_PER_XMR: u128 = 1_000_000_000_000;
pub const BPS_DENOMINATOR: u128 = 10_000;
/// The safety gap between the claimer's last window and the final deadline.
pub const DAY_SECS: i64 = 86_400;
/// Lower bound of the approval window (`30 <= W_a`).
pub const MIN_APPROVAL_SECS: u32 = 30;

/// Which chain enforces the swap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chain {
  Solana,
  Ethereum,
}
impl Chain {
  pub fn name(self) -> &'static str {
    match self {
      Chain::Solana => "solana",
      Chain::Ethereum => "ethereum",
    }
  }
  pub fn consts(self) -> &'static ChainConsts {
    match self {
      Chain::Solana => &SOLANA,
      Chain::Ethereum => &ETHEREUM,
    }
  }
}

/// Every protocol constant of SPEC 3.1, plus the three behavioural switches that differ by chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainConsts {
  pub fee_bps: u16,
  pub max_deposit_bps: u16,
  pub hold_secs: i64,
  pub split_secs: i64,
  /// `W_x`: after the final deadline.
  pub expiry_secs: i64,
  /// `B`: per-confirmation allowance in the refund cutoff.
  pub block_allowance_secs: i64,
  pub cut_margin_secs: i64,
  /// `M`: broadcast margin (client rule 2).
  pub margin_secs: i64,
  /// `F`: finality allowance.
  pub finality_secs: i64,
  pub min_notice_secs: u32,
  pub max_notice_secs: u32,
  pub min_claim_delay_secs: u32,
  pub max_approval_secs: u32,
  pub max_final_secs: u32,
  pub ready_min_secs_per_conf: i64,
  /// Solana only: anyone may close a settled swap account after this. 0 = not applicable.
  pub close_grace_secs: i64,
  pub link_delay_secs: i64,
  pub max_open_pending: u16,
  /// Largest `amount` the chain's type holds (`u64` on Solana; `uint256` on Ethereum, capped
  /// here at `u128`, which is what the compact quote form carries).
  pub max_amount: u128,
  /// Every swap starts PENDING regardless of mode.
  pub explicit_approve: bool,
  /// Anyone may call `claim` and `refund`: the secret is the authorisation.
  pub open_secret_calls: bool,
  /// A lapsed take outside window mode is the fault `missed_funds` (else `approval_timeouts`).
  pub lapse_is_fault: bool,
}

pub const SOLANA: ChainConsts = ChainConsts {
  fee_bps: 5,
  max_deposit_bps: 500,
  hold_secs: 1_800,
  split_secs: 5_184_000,
  expiry_secs: 2_592_000,
  block_allowance_secs: 180,
  cut_margin_secs: 900,
  margin_secs: 300,
  finality_secs: 15,
  min_notice_secs: 300,
  max_notice_secs: 3_600,
  min_claim_delay_secs: 3_600,
  max_approval_secs: 3_600,
  max_final_secs: 2_592_000,
  ready_min_secs_per_conf: 60,
  close_grace_secs: 2_592_000,
  link_delay_secs: 604_800,
  max_open_pending: 64,
  max_amount: u64::MAX as u128,
  explicit_approve: false,
  open_secret_calls: false,
  lapse_is_fault: true,
};

pub const ETHEREUM: ChainConsts = ChainConsts {
  fee_bps: 5,
  max_deposit_bps: 500,
  hold_secs: 1_800,
  split_secs: 5_184_000,
  expiry_secs: 2_592_000,
  block_allowance_secs: 180,
  cut_margin_secs: 900,
  margin_secs: 1_800,
  finality_secs: 1_200,
  min_notice_secs: 1_500,
  max_notice_secs: 3_600,
  min_claim_delay_secs: 7_200,
  max_approval_secs: 3_600,
  max_final_secs: 2_592_000,
  ready_min_secs_per_conf: 60,
  close_grace_secs: 0,
  link_delay_secs: 604_800,
  max_open_pending: 64,
  max_amount: u128::MAX,
  explicit_approve: true,
  open_secret_calls: true,
  lapse_is_fault: false,
};

/// `floor(a × b / d)` and whether the division was exact, with a 256-bit intermediate.
fn mul_div(a: u128, b: u128, d: u128) -> Option<(u128, bool)> {
  // a × b as (hi, lo) 128-bit halves.
  let (a_hi, a_lo) = (a >> 64, a & u64::MAX as u128);
  let (b_hi, b_lo) = (b >> 64, b & u64::MAX as u128);
  let ll = a_lo * b_lo;
  let lh = a_lo * b_hi;
  let hl = a_hi * b_lo;
  let hh = a_hi * b_hi;
  let mid = (ll >> 64) + (lh & u64::MAX as u128) + (hl & u64::MAX as u128);
  let lo = (ll & u64::MAX as u128) | (mid << 64);
  let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
  if hi >= d {
    return None; // the quotient does not fit 128 bits
  }
  // Long division of (hi, lo) by d, one bit at a time. hi < d, so the quotient fits.
  let mut rem = hi;
  let mut q = 0u128;
  for i in (0..128).rev() {
    let top = rem >> 127;
    rem = (rem << 1) | ((lo >> i) & 1);
    if top == 1 || rem >= d {
      rem = rem.wrapping_sub(d);
      q |= 1 << i;
    }
  }
  Some((q, rem == 0))
}

fn fit(v: u128, c: &ChainConsts) -> Result<u128> {
  if v > c.max_amount {
    return Err(Error::MathOverflow);
  }
  Ok(v)
}

/// Direction A: `amount = ceil(xmr × price / 10^12)`. `price` is asset base units per 1 XMR.
pub fn pay_amount(xmr: u64, price: u128, c: &ChainConsts) -> Result<u128> {
  let (q, exact) = mul_div(xmr as u128, price, PICONERO_PER_XMR).ok_or(Error::MathOverflow)?;
  let q = if exact { q } else { q.checked_add(1).ok_or(Error::MathOverflow)? };
  fit(q, c)
}

/// Direction B: `amount = floor(xmr × price / 10^12)`.
pub fn receive_amount(xmr: u64, price: u128, c: &ChainConsts) -> Result<u128> {
  let (q, _) = mul_div(xmr as u128, price, PICONERO_PER_XMR).ok_or(Error::MathOverflow)?;
  fit(q, c)
}

/// `floor(amount × bps / 10^4)`: the deposit `D` and the protocol fee.
pub fn bps_of(amount: u128, bps: u16) -> u128 {
  // amount × bps < 2^144; split so nothing overflows.
  let (q, _) = mul_div(amount, bps as u128, BPS_DENOMINATOR).expect("bps < 10^4 keeps the quotient below amount");
  q
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
  for i in 0..3 {
    if values[i] != zero && xmr >= above[i] {
      out = Some(values[i]);
    }
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
  for i in 1..3 {
    if values[i] == zero {
      seen_unused = true;
    } else if seen_unused || above[i] <= above[i - 1] {
      return false;
    }
  }
  true
}

/// The per-swap parameters copied from the offer or quote at lock time (SPEC 3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapParams {
  /// `W_a`: approval window.
  pub w_a: u32,
  /// `W_n`: notice window.
  pub w_n: u32,
  /// `D_c`: claim delay, from the notice.
  pub d_c: u32,
  /// `W_c`: claim window, from ready.
  pub w_c: u32,
  /// `W_f`: final window, from lock.
  pub w_f: u32,
  /// Monero confirmations for this swap's size tier.
  pub depth: u8,
  pub dep_bps: u16,
}

/// A violated bound of SPEC 3.1. Names are the Solana and Ethereum error names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundError {
  DepositTooHigh,
  ApprovalWindowOutOfRange,
  NoticeWindowOutOfRange,
  DepthInvalid,
  ClaimDelayTooShort,
  ClaimWindowTooShort,
  FinalWindowOutOfRange,
}

/// `Δ_cut = F + d × B + CUT_MARGIN_SECS`.
pub fn delta_cut(depth: u8, c: &ChainConsts) -> i64 {
  c.finality_secs + depth as i64 * c.block_allowance_secs + c.cut_margin_secs
}

/// Smallest claim delay the chain accepts at `depth`: `max(MIN_CLAIM_DELAY_SECS, Δ_cut + 2M)`.
pub fn min_claim_delay(depth: u8, c: &ChainConsts) -> i64 {
  (c.min_claim_delay_secs as i64).max(delta_cut(depth, c) + 2 * c.margin_secs)
}

/// Smallest claim window: `F + 2M`.
pub fn min_claim_window(c: &ChainConsts) -> i64 {
  c.finality_secs + 2 * c.margin_secs
}

/// Smallest final window for a swap that uses pending window `w_p`.
pub fn min_final_window(p: &SwapParams, w_p: u32) -> i64 {
  w_p as i64 + p.w_n as i64 + p.d_c as i64 + p.w_c as i64 + DAY_SECS
}

/// How a swap starts, which decides `W_p` (SPEC 3.1 and 3.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pending {
  /// Starts ACTIVE: `W_p = 0`.
  None,
  /// Waits for approval in window mode, or under `EXPLICIT_APPROVE`: `W_p = W_a`.
  ApprovalWindow,
  /// Direction B outside window mode: `W_p = W_n` (the maker's funding deadline).
  FundingWindow,
}

/// `W_p` for a start mode.
pub fn pending_window(p: &SwapParams, pending: Pending) -> u32 {
  match pending {
    Pending::None => 0,
    Pending::ApprovalWindow => p.w_a,
    Pending::FundingWindow => p.w_n,
  }
}

/// Check every per-swap bound of SPEC 3.1 for a swap that starts in `pending`. The checks run
/// in the order of [`BoundError`]'s variants and the first violated one is returned.
pub fn check_bounds(p: &SwapParams, pending: Pending, c: &ChainConsts) -> core::result::Result<(), BoundError> {
  if p.dep_bps > c.max_deposit_bps {
    return Err(BoundError::DepositTooHigh);
  }
  if pending == Pending::ApprovalWindow && !(MIN_APPROVAL_SECS..=c.max_approval_secs).contains(&p.w_a) {
    return Err(BoundError::ApprovalWindowOutOfRange);
  }
  if !(c.min_notice_secs..=c.max_notice_secs).contains(&p.w_n) {
    return Err(BoundError::NoticeWindowOutOfRange);
  }
  if p.depth == 0 {
    return Err(BoundError::DepthInvalid);
  }
  if (p.d_c as i64) < min_claim_delay(p.depth, c) {
    return Err(BoundError::ClaimDelayTooShort);
  }
  if (p.w_c as i64) < min_claim_window(c) {
    return Err(BoundError::ClaimWindowTooShort);
  }
  let w_p = pending_window(p, pending);
  if (p.w_f as i64) < min_final_window(p, w_p) || p.w_f > c.max_final_secs {
    return Err(BoundError::FinalWindowOutOfRange);
  }
  Ok(())
}

/// Every deadline of SPEC 3.2 that is known given the event times so far. `None` = the event it
/// derives from has not happened.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Deadlines {
  /// `T_pend = t_lock + W_p` (PENDING only; "T_appr" in A, "T_fund" in B).
  pub t_pend: Option<i64>,
  /// `T_note = t_A + W_n`.
  pub t_note: Option<i64>,
  /// `T_cut = t_N + Δ_cut`.
  pub t_cut: Option<i64>,
  /// `T_co = t_N + D_c`.
  pub t_co: Option<i64>,
  /// Earliest `set_ready`: `t_N + depth × READY_MIN_SECS_PER_CONF`.
  pub t_ready_min: Option<i64>,
  /// `T_cd = t_R + W_c`.
  pub t_cd: Option<i64>,
  /// `T_final = t_lock + W_f`.
  pub t_final: i64,
  /// `T_nl = T_final − D_c − W_c − 86,400` (latest notice, direction B).
  pub t_nl: i64,
  /// `T_exp = T_final + EXPIRY_SECS`.
  pub t_exp: i64,
  /// `T_hold = t_refund + HOLD_SECS`.
  pub t_hold: Option<i64>,
  /// `T_split = t_refund + SPLIT_SECS`.
  pub t_split: Option<i64>,
}

/// Event times a swap has recorded so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EventTimes {
  pub t_lock: i64,
  /// Approval (A), funding (B), or `t_lock` when the swap started ACTIVE.
  pub t_active: Option<i64>,
  pub t_notice: Option<i64>,
  pub t_ready: Option<i64>,
  pub t_refund: Option<i64>,
}

/// `deadlines(params)`: derive every deadline from the event times.
pub fn deadlines(p: &SwapParams, pending: Pending, t: &EventTimes, c: &ChainConsts) -> Deadlines {
  let t_final = t.t_lock + p.w_f as i64;
  Deadlines {
    t_pend: (pending != Pending::None).then(|| t.t_lock + pending_window(p, pending) as i64),
    t_note: t.t_active.map(|a| a + p.w_n as i64),
    t_cut: t.t_notice.map(|n| n + delta_cut(p.depth, c)),
    t_co: t.t_notice.map(|n| n + p.d_c as i64),
    t_ready_min: t.t_notice.map(|n| n + p.depth as i64 * c.ready_min_secs_per_conf),
    t_cd: t.t_ready.map(|r| r + p.w_c as i64),
    t_final,
    t_nl: t_final - p.d_c as i64 - p.w_c as i64 - DAY_SECS,
    t_exp: t_final + c.expiry_secs,
    t_hold: t.t_refund.map(|r| r + c.hold_secs),
    t_split: t.t_refund.map(|r| r + c.split_secs),
  }
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
    SwapParams { w_a: 60, w_n, d_c, w_c, w_f: 604_800, depth, dep_bps: 100 }
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
