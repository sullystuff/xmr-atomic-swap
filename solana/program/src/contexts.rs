//! Account lists of every instruction (SPEC 4.3 to 4.5). **The order of the accounts and their
//! signer, writable and optional flags are frozen in `interfaces/solana/xmr_swap.idl.json`.**
//! WP2 adds constraints (seeds, bumps, address checks, `init`) without changing them.
//!
//! An absent optional account is passed as the program id (Anchor's convention).
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{args::*, constants::*, errors::SwapError, state::*};

// ------------------------------------------------------------------ admin

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// MUST equal the upgrade authority in the program's ProgramData account. Pays the rent.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = CONFIG_SIZE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = TREASURY_SIZE, seeds = [b"treasury"], bump)]
    pub treasury: Account<'info, Treasury>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"treasury_vault", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = treasury,
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: this program; WP2 checks its address and that `program_data` is its ProgramData.
    pub program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData account, read by hand for the upgrade authority.
    pub program_data: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `set_treasury_authority`, `set_split_mode`, `transfer_admin`, `freeze_config`.
#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SweepTreasury<'info> {
    pub treasury_authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: SOL: the wallet the signer names. USDC: a token account of `config.usdc_mint`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub mint: Option<Box<Account<'info, Mint>>>,
    #[account(mut)]
    pub treasury_vault: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}

// ------------------------------------------------------------------ registry

#[derive(Accounts)]
pub struct RegisterMaker<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = MAKER_SIZE, seeds = [b"maker", owner.key().as_ref()], bump)]
    pub maker: Account<'info, Maker>,
    pub system_program: Program<'info, System>,
}

/// `set_operator`, `set_payout`, `set_eth_link`.
#[derive(Accounts)]
pub struct MakerByOwner<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
}

/// `set_paused`, `bump_epochs`: the owner or the operator.
#[derive(Accounts)]
pub struct MakerByOwnerOrOperator<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
}

/// `rotate_enc_key`, `set_onion`, `set_contacts`, `set_inbox_policy`.
#[derive(Accounts)]
pub struct MakerByOperator<'info> {
    pub operator: Signer<'info>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
}

#[derive(Accounts)]
pub struct SetOffer<'info> {
    /// Pays the rent when the offer is created.
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
    /// CHECK: PDA `["offer", maker, [asset], [direction]]`; created here if missing.
    #[account(mut)]
    pub offer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Offer accounts are passed as remaining accounts (writable) in the order of `offers`.
#[derive(Accounts)]
pub struct RefreshOffers<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
    #[account(mut)]
    pub eth_board: Option<Box<Account<'info, EthBoard>>>,
}

#[derive(Accounts)]
pub struct RefillKeys<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
    #[account(mut)]
    pub offer: Account<'info, Offer>,
}

#[derive(Accounts)]
pub struct SetEthQuote<'info> {
    /// Pays the rent on the first call.
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
    /// CHECK: PDA `["eth_board", maker]`; created here on the first call.
    #[account(mut)]
    pub eth_board: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(terms: QuoteTerms)]
pub struct PostQuote<'info> {
    /// Pays the rent; it returns when the quote is consumed or cancelled.
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
    #[account(
        init,
        payer = operator,
        space = QUOTE_SIZE,
        seeds = [b"quote", maker.key().as_ref(), &terms.quote_id.to_le_bytes()],
        bump,
    )]
    pub quote: Account<'info, Quote>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelQuote<'info> {
    /// The operator, or anyone once `now > expires_at`.
    pub caller: Signer<'info>,
    #[account(seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Account<'info, Maker>,
    #[account(mut)]
    pub quote: Account<'info, Quote>,
    /// CHECK: receives the rent; MUST equal `maker.operator`.
    #[account(mut)]
    pub quote_rent_receiver: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PostMessage<'info> {
    pub sender: Signer<'info>,
    /// CHECK: a maker PDA or a taker wallet; only named so readers can list the transaction.
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: the swap the message concerns, if any; only named for readers.
    pub swap: Option<UncheckedAccount<'info>>,
}

// ------------------------------------------------------------------ opening a swap

/// `lock` and `take` (SPEC 4.4), 14 accounts. Exactly one of `offer` and `quote` is present;
/// `quote_rent_receiver` accompanies `quote`; `instructions_sysvar` is present iff
/// `approval_ix` is; the last four are present for USDC and absent for SOL.
#[derive(Accounts)]
pub struct OpenSwap<'info> {
    /// CHECK: the taker's wallet. It must sign; a missing signature is `Unauthorized` (the
    /// vectors' "wrong caller" rows), so this is not a `Signer` (which fails with Anchor's own code).
    #[account(mut, signer @ SwapError::Unauthorized)]
    pub taker: UncheckedAccount<'info>,
    /// CHECK: PDA `["swap", taker, swap_nonce]`, created here; the taker pays its rent.
    #[account(mut)]
    pub swap: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Box<Account<'info, Maker>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: any address; stored in the swap and funded with `session_lamports`.
    #[account(mut)]
    pub session_key: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub offer: Option<Box<Account<'info, Offer>>>,
    #[account(mut)]
    pub quote: Option<Box<Account<'info, Quote>>>,
    /// CHECK: receives the consumed quote's rent; MUST equal `maker.operator`.
    #[account(mut)]
    pub quote_rent_receiver: Option<UncheckedAccount<'info>>,
    /// CHECK: the instructions sysvar; its address is checked by hand (SPEC 4.6).
    pub instructions_sysvar: Option<UncheckedAccount<'info>>,
    pub mint: Option<Box<Account<'info, Mint>>>,
    #[account(mut)]
    pub taker_token: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: PDA `["vault", swap]`, a token account created here with the swap PDA as authority.
    #[account(mut)]
    pub vault: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub operator: Signer<'info>,
    #[account(mut, has_one = maker @ SwapError::Unauthorized)]
    pub swap: Box<Account<'info, Swap>>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Box<Account<'info, Maker>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(mut, has_one = maker @ SwapError::Unauthorized)]
    pub swap: Box<Account<'info, Swap>>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Box<Account<'info, Maker>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub system_program: Program<'info, System>,
    pub mint: Option<Box<Account<'info, Mint>>>,
    #[account(mut)]
    pub operator_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut)]
    pub vault: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}

// ------------------------------------------------------------------ progress and settlement

/// The Short list (SPEC 4.5): `post_notice`, `set_ready`, `withhold`, `publish_evidence`.
#[derive(Accounts)]
pub struct Short<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, has_one = maker @ SwapError::Unauthorized)]
    pub swap: Box<Account<'info, Swap>>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Box<Account<'info, Maker>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// The Settle list (SPEC 4.5): `reject`, `cancel_pending`, `expire_pending`, `abort`,
/// `refund_unnoticed`, `expire_unnoticed`, `refund`, `claim`, `release_deposit`,
/// `split_deposit`, `close_swap`, and `withdraw_owed` (where `maker_wallet`/`maker_token` or
/// `taker`/`taker_token` is the destination the signer names).
///
/// `taker`, `maker_wallet` and every destination token account are unchecked and validated by
/// hand: a typed account would make a missing destination revert the instruction, and a claim
/// or refund must never revert on a payout (pay or park).
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, has_one = maker @ SwapError::Unauthorized)]
    pub swap: Box<Account<'info, Swap>>,
    #[account(mut, seeds = [b"maker", maker.owner.as_ref()], bump = maker.bump)]
    pub maker: Box<Account<'info, Maker>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: MUST equal `swap.taker`.
    #[account(mut)]
    pub taker: UncheckedAccount<'info>,
    /// CHECK: `maker.payout` for `claim` in A, `maker.operator` for `refund` in B, otherwise either.
    #[account(mut)]
    pub maker_wallet: UncheckedAccount<'info>,
    /// CHECK: the Treasury PDA, or the incinerator in burn mode.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: `config.usdc_mint` (writable for the burn in `split_deposit`).
    #[account(mut)]
    pub mint: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA `["vault", swap]`.
    #[account(mut)]
    pub vault: Option<UncheckedAccount<'info>>,
    /// CHECK: the associated token account of `swap.taker`.
    #[account(mut)]
    pub taker_token: Option<UncheckedAccount<'info>>,
    /// CHECK: the associated token account of `maker.payout` or `maker.operator`.
    #[account(mut)]
    pub maker_token: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA `["treasury_vault", mint]`.
    #[account(mut)]
    pub treasury_vault: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Program<'info, Token>>,
}
