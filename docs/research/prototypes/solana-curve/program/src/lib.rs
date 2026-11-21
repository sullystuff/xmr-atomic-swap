//! Prototype for docs/research/solana-curve.md.
//!  - commit / reveal / bench: the bare curve check and its CU cost
//!  - register_maker, lock_*, set_ready, claim_*, refund_*: a miniature escrow
//!    exercising SOL + SPL vaults, a session key, deadlines and account closing
//!  - post_message*: three ways to put an encrypted payload on-chain
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use solana_curve25519::{
    edwards::{
        multiply_edwards, multiscalar_multiply_edwards, subtract_edwards, validate_edwards,
        PodEdwardsPoint,
    },
    scalar::PodScalar,
};

pub mod curve;
use curve::*;

declare_id!("HNZrgojMR8XBDsap8MPTgdznw5P1WzFi9k2yZND3JeCo");

#[program]
pub mod curve_check {
    use super::*;

    // ---------------------------------------------------------------- curve

    pub fn commit(ctx: Context<Commit>, point: [u8; 32]) -> Result<()> {
        log_cu();
        let ok = is_valid_key_commitment(&PodEdwardsPoint(point));
        log_cu();
        require!(ok, SwapError::BadCommitment);
        ctx.accounts.commitment.set_inner(Commitment {
            owner: ctx.accounts.payer.key(),
            point,
        });
        Ok(())
    }

    /// Deliberately unsafe: stores any 32 bytes. Lets the tests show what a
    /// missing commit-time check allows.
    pub fn commit_unchecked(ctx: Context<Commit>, point: [u8; 32]) -> Result<()> {
        ctx.accounts.commitment.set_inner(Commitment {
            owner: ctx.accounts.payer.key(),
            point,
        });
        Ok(())
    }

    /// Deliberately insufficient: only `sol_curve_validate_point`.
    pub fn validate_only(_ctx: Context<Bench>, point: [u8; 32]) -> Result<()> {
        require!(validate_edwards(&PodEdwardsPoint(point)), SwapError::BadCommitment);
        Ok(())
    }

    pub fn reveal(ctx: Context<Reveal>, scalar: [u8; 32]) -> Result<()> {
        log_cu();
        let ok = scalar_matches(&scalar, &ctx.accounts.commitment.point);
        log_cu();
        require!(ok, SwapError::ScalarMismatch);
        emit!(Revealed {
            commitment: ctx.accounts.commitment.key(),
            scalar,
        });
        Ok(())
    }

    /// Logs remaining CU around each curve syscall so the test can diff them.
    pub fn bench(_ctx: Context<Bench>, scalar: [u8; 32], point: [u8; 32]) -> Result<()> {
        let s = PodScalar(scalar);
        let p = PodEdwardsPoint(point);
        msg!("validate");
        log_cu();
        let v = validate_edwards(&p);
        log_cu();
        msg!("mul");
        log_cu();
        let m = multiply_edwards(&s, &ED25519_BASEPOINT);
        log_cu();
        msg!("sub");
        log_cu();
        let d = subtract_edwards(&IDENTITY, &p);
        log_cu();
        msg!("msm1");
        log_cu();
        let m1 = multiscalar_multiply_edwards(&[s], &[ED25519_BASEPOINT]);
        log_cu();
        msg!("msm2");
        log_cu();
        let m2 = multiscalar_multiply_edwards(&[s, s], &[ED25519_BASEPOINT, p]);
        log_cu();
        msg!("subgroup");
        log_cu();
        let sg = is_valid_key_commitment(&p);
        log_cu();
        msg!("empty");
        log_cu();
        log_cu();
        require!(
            v && m.is_some() && d.is_some() && m1 == m && m2.is_some() && sg,
            SwapError::BadCommitment
        );
        Ok(())
    }

    // ------------------------------------------------------------- registry

    pub fn register_maker(ctx: Context<RegisterMaker>, encryption_key: [u8; 32]) -> Result<()> {
        ctx.accounts.maker.set_inner(Maker {
            owner: ctx.accounts.owner.key(),
            encryption_key,
            key_version: 1,
            registered_slot: Clock::get()?.slot,
            bump: ctx.bumps.maker,
        });
        Ok(())
    }

    // --------------------------------------------------------------- escrow

    pub fn lock_sol(ctx: Context<LockSol>, args: LockArgs) -> Result<()> {
        init_swap(
            &mut ctx.accounts.swap,
            &args,
            ctx.accounts.taker.key(),
            Pubkey::default(),
            ctx.bumps.swap,
        )?;
        // Escrowed SOL lives in the swap PDA itself, on top of its rent.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.taker.to_account_info(),
                    to: ctx.accounts.swap.to_account_info(),
                },
            ),
            args.amount,
        )?;
        fund_session(
            &ctx.accounts.system_program,
            &ctx.accounts.taker,
            &ctx.accounts.session_key,
            args.session_lamports,
        )
    }

    pub fn lock_token(ctx: Context<LockToken>, args: LockArgs) -> Result<()> {
        init_swap(
            &mut ctx.accounts.swap,
            &args,
            ctx.accounts.taker.key(),
            ctx.accounts.mint.key(),
            ctx.bumps.swap,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.taker_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            args.amount,
            ctx.accounts.mint.decimals,
        )?;
        fund_session(
            &ctx.accounts.system_program,
            &ctx.accounts.taker,
            &ctx.accounts.session_key,
            args.session_lamports,
        )
    }

    /// Signed by the taker's wallet or by the session key registered at lock.
    pub fn set_ready(ctx: Context<SetReady>) -> Result<()> {
        ctx.accounts.swap.ready = true;
        Ok(())
    }

    /// Maker reveals its key half. Pays the maker, returns rent to the taker.
    pub fn claim_sol(ctx: Context<ClaimSol>, scalar: [u8; 32]) -> Result<()> {
        let swap = &ctx.accounts.swap;
        require!(swap.ready, SwapError::NotReady);
        require!(scalar_matches(&scalar, &swap.maker_point), SwapError::ScalarMismatch);
        let amount = swap.amount;
        ctx.accounts.swap.sub_lamports(amount)?;
        ctx.accounts.maker.add_lamports(amount)?;
        emit!(Claimed { swap: ctx.accounts.swap.key(), scalar });
        Ok(()) // `close = taker` sends the remaining rent to the taker
    }

    /// Taker (or its session key) reveals the taker's key half after the
    /// deadline. Always pays the taker's address.
    pub fn refund_sol(ctx: Context<RefundSol>, scalar: [u8; 32]) -> Result<()> {
        let swap = &ctx.accounts.swap;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= swap.refund_after, SwapError::TooEarly);
        require!(scalar_matches(&scalar, &swap.taker_point), SwapError::ScalarMismatch);
        emit!(Refunded { swap: swap.key(), scalar });
        sweep_session(
            &ctx.accounts.system_program,
            &ctx.accounts.authority,
            &ctx.accounts.taker,
        )
        // `close = taker` returns escrow + rent in one go
    }

    pub fn claim_token(ctx: Context<ClaimToken>, scalar: [u8; 32]) -> Result<()> {
        let swap = &ctx.accounts.swap;
        require!(swap.ready, SwapError::NotReady);
        require!(scalar_matches(&scalar, &swap.maker_point), SwapError::ScalarMismatch);
        emit!(Claimed { swap: swap.key(), scalar });
        pay_out_and_close_vault(
            swap,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.maker_token,
            &ctx.accounts.taker,
            &ctx.accounts.token_program,
        )
    }

    pub fn refund_token(ctx: Context<RefundToken>, scalar: [u8; 32]) -> Result<()> {
        let swap = &ctx.accounts.swap;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= swap.refund_after, SwapError::TooEarly);
        require!(scalar_matches(&scalar, &swap.taker_point), SwapError::ScalarMismatch);
        emit!(Refunded { swap: swap.key(), scalar });
        pay_out_and_close_vault(
            swap,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.taker_token,
            &ctx.accounts.taker,
            &ctx.accounts.token_program,
        )?;
        sweep_session(
            &ctx.accounts.system_program,
            &ctx.accounts.authority,
            &ctx.accounts.taker,
        )
    }

    // ------------------------------------------------------------ messaging

    /// (a) payload only in instruction data; clients read the transaction.
    pub fn post_message_noop(_ctx: Context<PostMessage>, _to: Pubkey, _payload: Vec<u8>) -> Result<()> {
        Ok(())
    }

    /// (b) `emit!` -> sol_log_data ("Program data: <base64>" log line).
    pub fn post_message_log(ctx: Context<PostMessage>, to: Pubkey, payload: Vec<u8>) -> Result<()> {
        emit!(Message { from: ctx.accounts.sender.key(), to, payload });
        Ok(())
    }

    /// (c) `emit_cpi!` -> self-CPI whose instruction data carries the event.
    pub fn post_message_cpi(ctx: Context<PostMessageCpi>, to: Pubkey, payload: Vec<u8>) -> Result<()> {
        emit_cpi!(Message { from: ctx.accounts.sender.key(), to, payload });
        Ok(())
    }
}

// ------------------------------------------------------------------ helpers

fn init_swap(
    swap: &mut Account<Swap>,
    args: &LockArgs,
    taker: Pubkey,
    mint: Pubkey,
    bump: u8,
) -> Result<()> {
    require!(args.amount > 0, SwapError::BadAmount);
    require!(
        is_valid_key_commitment(&PodEdwardsPoint(args.maker_point))
            && is_valid_key_commitment(&PodEdwardsPoint(args.taker_point)),
        SwapError::BadCommitment
    );
    swap.set_inner(Swap {
        taker,
        maker: args.maker,
        session_key: args.session_key,
        mint,
        amount: args.amount,
        maker_point: args.maker_point,
        taker_point: args.taker_point,
        refund_after: args.refund_after,
        swap_id: args.swap_id,
        ready: false,
        bump,
    });
    Ok(())
}

fn fund_session<'info>(
    system: &Program<'info, System>,
    taker: &Signer<'info>,
    session_key: &UncheckedAccount<'info>,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system.to_account_info(),
            system_program::Transfer {
                from: taker.to_account_info(),
                to: session_key.to_account_info(),
            },
        ),
        lamports,
    )
}

/// If the signer is the session key (not the taker's wallet), return every
/// lamport it still holds to the taker so the throwaway key ends at zero.
fn sweep_session<'info>(
    system: &Program<'info, System>,
    authority: &Signer<'info>,
    taker: &UncheckedAccount<'info>,
) -> Result<()> {
    let left = authority.lamports();
    if authority.key() == taker.key() || left == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system.to_account_info(),
            system_program::Transfer {
                from: authority.to_account_info(),
                to: taker.to_account_info(),
            },
        ),
        left,
    )
}

fn pay_out_and_close_vault<'info>(
    swap: &Account<'info, Swap>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    rent_to: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"swap", swap.taker.as_ref(), &swap.swap_id, &[swap.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: swap.to_account_info(),
            },
            &[seeds],
        ),
        vault.amount, // whole balance, so the vault can be closed
        mint.decimals,
    )?;
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to.to_account_info(),
            authority: swap.to_account_info(),
        },
        &[seeds],
    ))
}

// ------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub owner: Pubkey,
    pub point: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Maker {
    pub owner: Pubkey,
    pub encryption_key: [u8; 32],
    pub key_version: u32,
    pub registered_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Swap {
    pub taker: Pubkey,
    pub maker: Pubkey,
    pub session_key: Pubkey,
    /// Pubkey::default() for native SOL.
    pub mint: Pubkey,
    pub amount: u64,
    pub maker_point: [u8; 32],
    pub taker_point: [u8; 32],
    /// Unix seconds.
    pub refund_after: i64,
    pub swap_id: [u8; 8],
    pub ready: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LockArgs {
    pub swap_id: [u8; 8],
    pub maker: Pubkey,
    pub session_key: Pubkey,
    pub amount: u64,
    pub maker_point: [u8; 32],
    pub taker_point: [u8; 32],
    pub refund_after: i64,
    /// Lamports forwarded to the session key so it can pay its own fees.
    pub session_lamports: u64,
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Commitment::INIT_SPACE,
        seeds = [b"commit", payer.key().as_ref()], bump)]
    pub commitment: Account<'info, Commitment>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, close = payer, seeds = [b"commit", payer.key().as_ref()], bump,
        constraint = commitment.owner == payer.key())]
    pub commitment: Account<'info, Commitment>,
}

#[derive(Accounts)]
pub struct Bench<'info> {
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterMaker<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Maker::INIT_SPACE,
        seeds = [b"maker", owner.key().as_ref()], bump)]
    pub maker: Account<'info, Maker>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: LockArgs)]
pub struct LockSol<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(init, payer = taker, space = 8 + Swap::INIT_SPACE,
        seeds = [b"swap", taker.key().as_ref(), &args.swap_id], bump)]
    pub swap: Account<'info, Swap>,
    /// CHECK: only receives lamports; must equal args.session_key
    #[account(mut, address = args.session_key)]
    pub session_key: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: LockArgs)]
pub struct LockToken<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(init, payer = taker, space = 8 + Swap::INIT_SPACE,
        seeds = [b"swap", taker.key().as_ref(), &args.swap_id], bump)]
    pub swap: Account<'info, Swap>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = taker, token::token_program = token_program)]
    pub taker_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = taker, seeds = [b"vault", swap.key().as_ref()], bump,
        token::mint = mint, token::authority = swap, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: only receives lamports; must equal args.session_key
    #[account(mut, address = args.session_key)]
    pub session_key: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetReady<'info> {
    #[account(constraint = authority.key() == swap.session_key || authority.key() == swap.taker
        @ SwapError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"swap", swap.taker.as_ref(), &swap.swap_id], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
}

#[derive(Accounts)]
pub struct ClaimSol<'info> {
    #[account(mut, address = swap.maker @ SwapError::Unauthorized)]
    pub maker: Signer<'info>,
    /// CHECK: rent destination, pinned to swap.taker
    #[account(mut, address = swap.taker)]
    pub taker: UncheckedAccount<'info>,
    #[account(mut, close = taker, seeds = [b"swap", swap.taker.as_ref(), &swap.swap_id], bump = swap.bump,
        constraint = swap.mint == Pubkey::default() @ SwapError::WrongAsset)]
    pub swap: Account<'info, Swap>,
}

#[derive(Accounts)]
pub struct RefundSol<'info> {
    #[account(mut, constraint = authority.key() == swap.session_key || authority.key() == swap.taker
        @ SwapError::Unauthorized)]
    pub authority: Signer<'info>,
    /// CHECK: refund destination, pinned to swap.taker
    #[account(mut, address = swap.taker)]
    pub taker: UncheckedAccount<'info>,
    #[account(mut, close = taker, seeds = [b"swap", swap.taker.as_ref(), &swap.swap_id], bump = swap.bump,
        constraint = swap.mint == Pubkey::default() @ SwapError::WrongAsset)]
    pub swap: Account<'info, Swap>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimToken<'info> {
    #[account(mut, address = swap.maker @ SwapError::Unauthorized)]
    pub maker: Signer<'info>,
    /// CHECK: rent destination, pinned to swap.taker
    #[account(mut, address = swap.taker)]
    pub taker: UncheckedAccount<'info>,
    #[account(mut, close = taker, seeds = [b"swap", swap.taker.as_ref(), &swap.swap_id], bump = swap.bump,
        has_one = mint @ SwapError::WrongAsset)]
    pub swap: Account<'info, Swap>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [b"vault", swap.key().as_ref()], bump,
        token::mint = mint, token::authority = swap, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = maker, token::token_program = token_program)]
    pub maker_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundToken<'info> {
    #[account(mut, constraint = authority.key() == swap.session_key || authority.key() == swap.taker
        @ SwapError::Unauthorized)]
    pub authority: Signer<'info>,
    /// CHECK: rent destination, pinned to swap.taker
    #[account(mut, address = swap.taker)]
    pub taker: UncheckedAccount<'info>,
    #[account(mut, close = taker, seeds = [b"swap", swap.taker.as_ref(), &swap.swap_id], bump = swap.bump,
        has_one = mint @ SwapError::WrongAsset)]
    pub swap: Account<'info, Swap>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [b"vault", swap.key().as_ref()], bump,
        token::mint = mint, token::authority = swap, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Must be owned by the taker's wallet, whoever signs.
    #[account(mut, token::mint = mint, token::authority = taker, token::token_program = token_program)]
    pub taker_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostMessage<'info> {
    pub sender: Signer<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct PostMessageCpi<'info> {
    pub sender: Signer<'info>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct Revealed {
    pub commitment: Pubkey,
    pub scalar: [u8; 32],
}

#[event]
pub struct Claimed {
    pub swap: Pubkey,
    pub scalar: [u8; 32],
}

#[event]
pub struct Refunded {
    pub swap: Pubkey,
    pub scalar: [u8; 32],
}

#[event]
pub struct Message {
    pub from: Pubkey,
    pub to: Pubkey,
    pub payload: Vec<u8>,
}

#[error_code]
pub enum SwapError {
    #[msg("commitment is not a canonical prime-order ed25519 point")]
    BadCommitment,
    #[msg("revealed scalar does not match the committed point")]
    ScalarMismatch,
    #[msg("signer is neither the taker nor the registered session key")]
    Unauthorized,
    #[msg("deadline not reached")]
    TooEarly,
    #[msg("taker has not set ready")]
    NotReady,
    #[msg("wrong asset for this instruction")]
    WrongAsset,
    #[msg("amount must be positive")]
    BadAmount,
}
