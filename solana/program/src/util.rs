//! Small helpers shared by the handlers.
use anchor_lang::{prelude::*, system_program};

use crate::{constants::*, errors::SwapError};

/// SHA-256 over the concatenation of `parts` (one syscall on-chain).
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    solana_sha256_hasher::hashv(parts).to_bytes()
}

/// Chain time (SPEC 0): every deadline uses it.
pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Create a program-owned PDA account, paid by `payer`. Works even if someone pre-funded the
/// address (a plain `create_account` would then fail and block the instruction).
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    new_account: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    owner: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let signer = &[seeds];
    let have = new_account.lamports();
    if have == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system.clone(),
                system_program::CreateAccount { from: payer.clone(), to: new_account.clone() },
                signer,
            ),
            rent,
            space as u64,
            owner,
        )
    } else {
        if have < rent {
            system_program::transfer(
                CpiContext::new(system.clone(), system_program::Transfer { from: payer.clone(), to: new_account.clone() }),
                rent - have,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system.clone(),
                system_program::Allocate { account_to_allocate: new_account.clone() },
                signer,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system.clone(),
                system_program::Assign { account_to_assign: new_account.clone() },
                signer,
            ),
            owner,
        )
    }
}

/// True iff the account has never been created (or was closed): system-owned and empty.
pub fn is_uninitialized(ai: &AccountInfo) -> bool {
    *ai.owner == system_program::ID && ai.data_is_empty()
}

// ------------------------------------------------------------------ bounds and tiers (SPEC 3.1)

/// How a swap waits before it is ACTIVE.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    /// Starts ACTIVE: `W_p = 0`.
    None,
    /// Waits for `approve` / `fund` in window mode: `W_p = W_a`.
    ApprovalWindow,
    /// Direction B outside window mode: waits for `fund`, `W_p = W_n`.
    FundingWindow,
}

pub struct Params {
    pub w_a: u32,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub w_f: u32,
    pub depth: u8,
    pub dep_bps: u16,
}

pub fn pending_window(p: &Params, pending: Pending) -> u32 {
    match pending {
        Pending::None => 0,
        Pending::ApprovalWindow => p.w_a,
        Pending::FundingWindow => p.w_n,
    }
}

/// `Δ_cut = F + depth × B + CUT_MARGIN_SECS`.
pub fn delta_cut(depth: u8) -> i64 {
    FINALITY_SECS + depth as i64 * BLOCK_ALLOWANCE_SECS + CUT_MARGIN_SECS
}

/// Every per-swap bound of SPEC 3.1, in the order the vectors fix
/// (`deadlines.json: bound_check_order`).
pub fn check_bounds(p: &Params, pending: Pending) -> Result<()> {
    require!(p.dep_bps <= MAX_DEPOSIT_BPS, SwapError::DepositTooHigh);
    if pending == Pending::ApprovalWindow {
        require!(
            (MIN_APPROVAL_SECS..=MAX_APPROVAL_SECS).contains(&p.w_a),
            SwapError::ApprovalWindowOutOfRange
        );
    }
    require!((MIN_NOTICE_SECS..=MAX_NOTICE_SECS).contains(&p.w_n), SwapError::NoticeWindowOutOfRange);
    require!(p.depth != 0, SwapError::DepthInvalid);
    let min_claim_delay = (MIN_CLAIM_DELAY_SECS as i64).max(delta_cut(p.depth) + 2 * MARGIN_SECS);
    require!(p.d_c as i64 >= min_claim_delay, SwapError::ClaimDelayTooShort);
    require!(p.w_c as i64 >= FINALITY_SECS + 2 * MARGIN_SECS, SwapError::ClaimWindowTooShort);
    let w_p = pending_window(p, pending) as i64;
    let min_final = w_p + p.w_n as i64 + p.d_c as i64 + p.w_c as i64 + DAY_SECS;
    require!(
        p.w_f as i64 >= min_final && p.w_f <= MAX_FINAL_SECS,
        SwapError::FinalWindowOutOfRange
    );
    Ok(())
}

/// `above[0] == 0`, tier 0 used, used tiers have strictly increasing thresholds, unused tiers
/// trail (their thresholds are ignored).
pub fn tiers_well_formed(above: &[u64; 3], used: [bool; 3]) -> bool {
    if above[0] != 0 || !used[0] {
        return false;
    }
    let mut seen_unused = false;
    for i in 1..3 {
        if !used[i] {
            seen_unused = true;
        } else if seen_unused || above[i] <= above[i - 1] {
            return false;
        }
    }
    true
}

/// Index of the highest used tier with `xmr >= above[i]`.
pub fn tier_index(xmr: u64, above: &[u64; 3], used: [bool; 3]) -> Option<usize> {
    let mut out = None;
    for i in 0..3 {
        if used[i] && xmr >= above[i] {
            out = Some(i);
        }
    }
    out
}

/// A: `ceil(xmr × price / 10^12)`. B: `floor(xmr × price / 10^12)`. `MathOverflow` above u64.
pub fn asset_amount(xmr: u64, price: u64, round_up: bool) -> Result<u64> {
    const PICO: u128 = 1_000_000_000_000;
    let product = xmr as u128 * price as u128;
    let mut q = product / PICO;
    if round_up && product % PICO != 0 {
        q += 1;
    }
    u64::try_from(q).map_err(|_| error!(SwapError::MathOverflow))
}

/// `floor(amount × bps / 10^4)`: the deposit and the fee. Never overflows (`bps <= 65,535`).
pub fn bps_of(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / 10_000) as u64
}
