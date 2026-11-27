//! Small helpers shared by the handlers.
use anchor_lang::{prelude::*, system_program};


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

// ------------------------------------------------------------------ tiers (SPEC 3.1)

/// Index of the highest used tier with `xmr >= above[i]`. (`set_offer` and `refresh_offers`
/// have already required the tiers to be well formed, with `escrow_logic`'s rule.)
pub fn tier_index(xmr: u64, above: &[u64; 3], used: [bool; 3]) -> Option<usize> {
    let mut out = None;
    for i in 0..3 {
        if used[i] && xmr >= above[i] {
            out = Some(i);
        }
    }
    out
}
