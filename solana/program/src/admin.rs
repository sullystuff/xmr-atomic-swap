//! Admin instructions (SPEC 4.3): `initialize`, the four admin setters, `sweep_treasury`.
use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable};
use anchor_spl::token;

use crate::{constants::*, contexts::*, errors::SwapError, events::*};

/// A malformed argument that has no named error.
pub fn invalid_arg() -> Error {
    ProgramError::InvalidArgument.into()
}
pub fn ensure_arg(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(invalid_arg())
    }
}

pub fn initialize(
    ctx: Context<Initialize>,
    cluster_tag: [u8; 32],
    treasury_authority: Pubkey,
    split_mode: u8,
) -> Result<()> {
    let a = ctx.accounts;
    // The signer MUST be the upgrade authority recorded in this program's ProgramData account.
    require_keys_eq!(a.program.key(), crate::ID, SwapError::Unauthorized);
    let (program_data, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(a.program_data.key(), program_data, SwapError::Unauthorized);
    require_keys_eq!(*a.program_data.owner, bpf_loader_upgradeable::ID, SwapError::Unauthorized);
    {
        // bincode UpgradeableLoaderState::ProgramData: tag u32 = 3, slot u64, Option<Pubkey>.
        let data = a.program_data.try_borrow_data()?;
        require!(data.len() >= 45, SwapError::Unauthorized);
        require!(data[..4] == [3, 0, 0, 0] && data[12] == 1, SwapError::Unauthorized);
        require!(data[13..45] == a.authority.key().to_bytes(), SwapError::Unauthorized);
    }
    ensure_arg(split_mode <= 1)?;

    let config = &mut a.config;
    config.admin = a.authority.key();
    config.treasury_authority = treasury_authority;
    config.cluster_tag = cluster_tag;
    config.usdc_mint = a.usdc_mint.key();
    config.split_mode = split_mode;
    config.bump = ctx.bumps.config;
    config.treasury_bump = ctx.bumps.treasury;
    // SPEC 11.1: fail closed. The switch is on and every cap is zero: nothing can open until
    // the admin sets caps.
    config.caps_on = 1;
    config.max_swap = [0; 2];
    config.max_open = [0; 2];
    config.open_value = [0; 2];
    config.reserved = [0; 68];
    a.treasury.bump = ctx.bumps.treasury;
    a.treasury.reserved = [0; 7];
    emit!(ConfigInitialized {
        admin: config.admin,
        treasury_authority,
        cluster_tag,
        usdc_mint: config.usdc_mint,
        split_mode,
    });
    Ok(())
}

fn admin_only(a: &AdminConfig) -> Result<()> {
    require_keys_neq!(a.config.admin, Pubkey::default(), SwapError::ConfigFrozen);
    require_keys_eq!(a.admin.key(), a.config.admin, SwapError::Unauthorized);
    Ok(())
}

fn changed(config: &crate::state::Config) {
    emit!(ConfigChanged {
        admin: config.admin,
        treasury_authority: config.treasury_authority,
        split_mode: config.split_mode,
    });
}

pub fn set_treasury_authority(ctx: Context<AdminConfig>, treasury_authority: Pubkey) -> Result<()> {
    admin_only(ctx.accounts)?;
    ctx.accounts.config.treasury_authority = treasury_authority;
    changed(&ctx.accounts.config);
    Ok(())
}

pub fn set_split_mode(ctx: Context<AdminConfig>, split_mode: u8) -> Result<()> {
    admin_only(ctx.accounts)?;
    ensure_arg(split_mode <= 1)?;
    ctx.accounts.config.split_mode = split_mode;
    changed(&ctx.accounts.config);
    Ok(())
}

pub fn transfer_admin(ctx: Context<AdminConfig>, admin: Pubkey) -> Result<()> {
    admin_only(ctx.accounts)?;
    // The default key means "frozen": that is `freeze_config`'s job, not a transfer's.
    ensure_arg(admin != Pubkey::default())?;
    ctx.accounts.config.admin = admin;
    changed(&ctx.accounts.config);
    Ok(())
}

pub fn freeze_config(ctx: Context<AdminConfig>) -> Result<()> {
    admin_only(ctx.accounts)?;
    ctx.accounts.config.admin = Pubkey::default();
    changed(&ctx.accounts.config);
    Ok(())
}

/// SPEC 11.1: the caps gate only `lock` and `take`. Changing them never touches an open swap;
/// `open_value` is the program's own accounting and is not an argument.
pub fn set_caps(ctx: Context<AdminConfig>, caps_on: bool, max_swap: [u64; 2], max_open: [u64; 2]) -> Result<()> {
    admin_only(ctx.accounts)?;
    let config = &mut ctx.accounts.config;
    config.caps_on = caps_on as u8;
    config.max_swap = max_swap;
    config.max_open = max_open;
    emit!(CapsChanged { caps_on, max_swap, max_open });
    Ok(())
}

pub fn sweep_treasury(ctx: Context<SweepTreasury>, asset: u8, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.treasury_authority.key(), a.config.treasury_authority, SwapError::Unauthorized);
    match asset {
        ASSET_SOL => {
            // Never below the Treasury account's rent minimum.
            let floor = Rent::get()?.minimum_balance(a.treasury.to_account_info().data_len());
            let available = a.treasury.get_lamports().saturating_sub(floor);
            require!(amount <= available, SwapError::AmountOutOfRange);
            a.treasury.sub_lamports(amount)?;
            a.destination.add_lamports(amount)?;
        }
        ASSET_USDC => {
            let (Some(mint), Some(vault), Some(token_program)) = (&a.mint, &a.treasury_vault, &a.token_program)
            else {
                return err!(SwapError::WrongAsset);
            };
            require_keys_eq!(mint.key(), a.config.usdc_mint, SwapError::MintNotAllowed);
            let (expected, _) =
                Pubkey::find_program_address(&[b"treasury_vault", mint.key().as_ref()], &crate::ID);
            require_keys_eq!(vault.key(), expected, SwapError::Unauthorized);
            let seeds: &[&[u8]] = &[b"treasury", &[a.treasury.bump]];
            token::transfer_checked(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    token::TransferChecked {
                        from: vault.to_account_info(),
                        mint: mint.to_account_info(),
                        to: a.destination.to_account_info(),
                        authority: a.treasury.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                mint.decimals,
            )?;
        }
        _ => return err!(SwapError::WrongAsset),
    }
    emit!(TreasurySwept { asset, amount, destination: a.destination.key() });
    Ok(())
}
