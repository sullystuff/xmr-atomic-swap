//! SPEC 3.1, 3.2 and 11.6: protocol constants per chain, the per-swap bounds and the derivation
//! of every deadline.

/// The safety gap between the claimer's last window and the final deadline.
pub const DAY_SECS: i64 = 86_400;
/// Lower bound of the approval window (`30 <= W_a`).
pub const MIN_APPROVAL_SECS: u32 = 30;
/// Bounds of a nonzero freeze window `W_z` (SPEC 11.6). Zero means "no watcher accepted".
pub const MIN_FREEZE_SECS: u32 = 3_600;
pub const MAX_FREEZE_SECS: u32 = 259_200;

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

/// Every protocol constant of SPEC 3.1, plus the behavioural switches that differ by chain.
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
  /// here at `u128`, which is what the compact quote form and the cap storage carry). The
  /// counted value of a swap and the open value of an asset obey the same limit.
  pub max_amount: u128,
  /// Every swap starts PENDING regardless of mode.
  pub explicit_approve: bool,
  /// Anyone may call `claim` and `refund`: the secret is the authorisation.
  pub open_secret_calls: bool,
  /// A lapsed take outside window mode is the fault `missed_funds` (else `approval_timeouts`).
  pub lapse_is_fault: bool,
  /// Caller rule of SPEC 3.13: the taker of a swap is whoever sends `lock`/`take` (Ethereum:
  /// `msg.sender`, and `swapId = keccak256(taker, nonce)`), so "opened by someone else" cannot
  /// be expressed and no such vector row exists. False: the transaction must carry the taker's
  /// signature (`Unauthorized` otherwise).
  pub taker_is_sender: bool,
  /// Caller rule of SPEC 3.13: `withdraw_owed` pays the caller's own parked balance, so an
  /// account that is owed nothing gets `NothingOwed` (Ethereum). False: `Unauthorized`.
  pub pull_own_owed: bool,
  /// SPEC 11.2: the chain has the permissionless `pushOwed(token, account)`, which pays a parked
  /// balance to the account it is owed to (Ethereum). False (Solana): a stranger delivers parked
  /// claim proceeds with `withdraw_owed` and the destination pinned to the payout address.
  pub push_owed: bool,
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
  taker_is_sender: false,
  pull_own_owed: false,
  push_owed: false,
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
  taker_is_sender: true,
  pull_own_owed: true,
  push_owed: true,
};

/// The per-swap parameters copied from the offer or quote at lock time (SPEC 3.1, 11.6).
#[cfg_attr(kani, derive(kani::Arbitrary))]
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
  /// `W_z`: freeze window. 0 = the offer accepts no watcher.
  pub w_z: u32,
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
  /// SPEC 11.6. Checked before the final window, whose bound it extends.
  FreezeWindowOutOfRange,
}
impl BoundError {
  pub fn name(self) -> &'static str {
    match self {
      BoundError::DepositTooHigh => "DepositTooHigh",
      BoundError::ApprovalWindowOutOfRange => "ApprovalWindowOutOfRange",
      BoundError::NoticeWindowOutOfRange => "NoticeWindowOutOfRange",
      BoundError::DepthInvalid => "DepthInvalid",
      BoundError::ClaimDelayTooShort => "ClaimDelayTooShort",
      BoundError::ClaimWindowTooShort => "ClaimWindowTooShort",
      BoundError::FinalWindowOutOfRange => "FinalWindowOutOfRange",
      BoundError::FreezeWindowOutOfRange => "FreezeWindowOutOfRange",
    }
  }
}

/// `Δ_cut = F + d × B + CUT_MARGIN_SECS`.
pub fn delta_cut(depth: u8, c: &ChainConsts) -> i64 {
  c.finality_secs + depth as i64 * c.block_allowance_secs + c.cut_margin_secs
}

/// Smallest claim delay the chain accepts at `depth`: `max(MIN_CLAIM_DELAY_SECS, Δ_cut + 2M)`.
pub fn min_claim_delay(depth: u8, c: &ChainConsts) -> i64 {
  let a = c.min_claim_delay_secs as i64;
  let b = delta_cut(depth, c) + 2 * c.margin_secs;
  if a > b {
    a
  } else {
    b
  }
}

/// Smallest claim window: `F + 2M`.
pub fn min_claim_window(c: &ChainConsts) -> i64 {
  c.finality_secs + 2 * c.margin_secs
}

/// Smallest final window for a swap that uses pending window `w_p`:
/// `W_p + W_n + D_c + W_z + W_c + 86,400` (`W_z` is zero for an offer without a freeze window).
pub fn min_final_window(p: &SwapParams, w_p: u32) -> i64 {
  w_p as i64 + p.w_n as i64 + p.d_c as i64 + p.w_z as i64 + p.w_c as i64 + DAY_SECS
}

/// How a swap starts, which decides `W_p` (SPEC 3.1 and 3.8).
#[cfg_attr(kani, derive(kani::Arbitrary))]
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

/// `W_z` is zero or inside `[MIN_FREEZE_SECS, MAX_FREEZE_SECS]`.
pub fn freeze_window_ok(w_z: u32) -> bool {
  w_z == 0 || (w_z >= MIN_FREEZE_SECS && w_z <= MAX_FREEZE_SECS)
}

/// Check every per-swap bound of SPEC 3.1 and 11.6 for a swap that starts in `pending`. The
/// first violated one is returned; the order is: deposit, approval window, notice window, depth,
/// claim delay, claim window, freeze window, final window.
pub fn check_bounds(p: &SwapParams, pending: Pending, c: &ChainConsts) -> Result<(), BoundError> {
  if p.dep_bps > c.max_deposit_bps {
    return Err(BoundError::DepositTooHigh);
  }
  if pending == Pending::ApprovalWindow && !(p.w_a >= MIN_APPROVAL_SECS && p.w_a <= c.max_approval_secs) {
    return Err(BoundError::ApprovalWindowOutOfRange);
  }
  if !(p.w_n >= c.min_notice_secs && p.w_n <= c.max_notice_secs) {
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
  if !freeze_window_ok(p.w_z) {
    return Err(BoundError::FreezeWindowOutOfRange);
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
  /// `T_ff = max(t_Z + W_z, T_co)`: a frozen swap's claim-without-ready opens (SPEC 11.6; the
  /// maximum keeps a freeze from ever opening the claim earlier than `T_co`).
  pub t_ff: Option<i64>,
  /// `T_cd = t_R + W_c`.
  pub t_cd: Option<i64>,
  /// `T_final = t_lock + W_f`.
  pub t_final: i64,
  /// `T_nl = T_final − D_c − W_z − W_c − 86,400` (latest notice, direction B).
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
  /// The freeze time `t_Z`.
  pub t_freeze: Option<i64>,
  pub t_ready: Option<i64>,
  pub t_refund: Option<i64>,
}

fn plus(t: Option<i64>, secs: i64) -> Option<i64> {
  match t {
    Some(v) => Some(v + secs),
    None => None,
  }
}

/// `deadlines(params)`: derive every deadline from the event times.
pub fn deadlines(p: &SwapParams, pending: Pending, t: &EventTimes, c: &ChainConsts) -> Deadlines {
  let t_final = t.t_lock + p.w_f as i64;
  Deadlines {
    t_pend: if pending != Pending::None { Some(t.t_lock + pending_window(p, pending) as i64) } else { None },
    t_note: plus(t.t_active, p.w_n as i64),
    t_cut: plus(t.t_notice, delta_cut(p.depth, c)),
    t_co: plus(t.t_notice, p.d_c as i64),
    t_ready_min: plus(t.t_notice, p.depth as i64 * c.ready_min_secs_per_conf),
    t_ff: match (t.t_freeze, t.t_notice) {
      (Some(z), Some(n)) => {
        let by_window = z + p.w_z as i64;
        let t_co = n + p.d_c as i64;
        Some(if by_window > t_co { by_window } else { t_co })
      }
      _ => None,
    },
    t_cd: plus(t.t_ready, p.w_c as i64),
    t_final,
    t_nl: t_final - p.d_c as i64 - p.w_z as i64 - p.w_c as i64 - DAY_SECS,
    t_exp: t_final + c.expiry_secs,
    t_hold: plus(t.t_refund, c.hold_secs),
    t_split: plus(t.t_refund, c.split_secs),
  }
}
