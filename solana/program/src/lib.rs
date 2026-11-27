//! `xmr_swap`: the Solana program of SPEC section 4.
//!
//! Every instruction, account list, argument struct, account layout, event and error is
//! declared exactly as it is frozen in `interfaces/solana/xmr_swap.idl.json`;
//! `node interfaces/tools/check-idl.mjs` proves the interface did not move. The handlers live
//! in `admin`, `registry`, `open` and `settle`; `approval` reads advance approvals, `curve` holds
//! the key-share checks.
//!
//! Nothing in this repository deploys this program or sends a transaction to any cluster.
use anchor_lang::prelude::*;

pub mod admin;
pub mod approval;
pub mod args;
pub mod constants;
pub mod contexts;
pub mod curve;
pub mod errors;
pub mod events;
pub mod logic;
pub mod open;
pub mod registry;
pub mod settle;
pub mod state;
pub mod util;

pub use args::*;
pub use contexts::*;
pub use errors::SwapError;
pub use events::*;
pub use state::*;

declare_id!("5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u");

#[program]
pub mod xmr_swap {
    use super::*;

    // -------------------------------------------------------------- admin (SPEC 4.3)

    /// Signer MUST be the program's upgrade authority. Creates `Config` (admin = signer),
    /// `Treasury` and the USDC treasury vault.
    pub fn initialize(
        ctx: Context<Initialize>,
        cluster_tag: [u8; 32],
        treasury_authority: Pubkey,
        split_mode: u8,
    ) -> Result<()> {
        admin::initialize(ctx, cluster_tag, treasury_authority, split_mode)
    }

    pub fn set_treasury_authority(ctx: Context<AdminConfig>, treasury_authority: Pubkey) -> Result<()> {
        admin::set_treasury_authority(ctx, treasury_authority)
    }

    pub fn set_split_mode(ctx: Context<AdminConfig>, split_mode: u8) -> Result<()> {
        admin::set_split_mode(ctx, split_mode)
    }

    pub fn transfer_admin(ctx: Context<AdminConfig>, admin: Pubkey) -> Result<()> {
        admin::transfer_admin(ctx, admin)
    }

    /// Sets `admin` to the default key; afterwards the four admin setters fail forever.
    pub fn freeze_config(ctx: Context<AdminConfig>) -> Result<()> {
        admin::freeze_config(ctx)
    }

    /// Amendment 1 (SPEC 11.1). Admin: the global switch and the per-asset caps. `ConfigFrozen`
    /// after `freeze_config`.
    pub fn set_caps(ctx: Context<AdminConfig>, caps_on: bool, max_swap: [u64; 2], max_open: [u64; 2]) -> Result<()> {
        admin::set_caps(ctx, caps_on, max_swap, max_open)
    }

    /// Moves fees to a destination the treasury authority names. SOL: never below the Treasury
    /// account's rent minimum.
    pub fn sweep_treasury(ctx: Context<SweepTreasury>, asset: u8, amount: u64) -> Result<()> {
        admin::sweep_treasury(ctx, asset, amount)
    }

    // -------------------------------------------------------------- registry (SPEC 4.3)

    pub fn register_maker(
        ctx: Context<RegisterMaker>,
        operator: Pubkey,
        payout: Pubkey,
        enc_key: [u8; 32],
    ) -> Result<()> {
        registry::register_maker(ctx, operator, payout, enc_key)
    }

    /// Also increments both epochs.
    pub fn set_operator(ctx: Context<MakerByOwner>, operator: Pubkey) -> Result<()> {
        registry::set_operator(ctx, operator)
    }

    pub fn set_payout(ctx: Context<MakerByOwner>, payout: Pubkey) -> Result<()> {
        registry::set_payout(ctx, payout)
    }

    pub fn set_eth_link(ctx: Context<MakerByOwner>, eth_address: [u8; 20]) -> Result<()> {
        registry::set_eth_link(ctx, eth_address)
    }

    /// Sets or clears the caller's pause bit.
    pub fn set_paused(ctx: Context<MakerByOwnerOrOperator>, paused: bool) -> Result<()> {
        registry::set_paused(ctx, paused)
    }

    pub fn bump_epochs(ctx: Context<MakerByOwnerOrOperator>, approvals: bool, quotes: bool) -> Result<()> {
        registry::bump_epochs(ctx, approvals, quotes)
    }

    pub fn rotate_enc_key(ctx: Context<MakerByOperator>, new_key: [u8; 32], prev_expires_at: i64) -> Result<()> {
        registry::rotate_enc_key(ctx, new_key, prev_expires_at)
    }

    /// Empty clears. Otherwise 56 base32 characters + `.onion`.
    pub fn set_onion(ctx: Context<MakerByOperator>, onion: String) -> Result<()> {
        registry::set_onion(ctx, onion)
    }

    /// Replaces the list.
    pub fn set_contacts(ctx: Context<MakerByOperator>, contacts: Vec<Contact>) -> Result<()> {
        registry::set_contacts(ctx, contacts)
    }

    pub fn set_inbox_policy(ctx: Context<MakerByOperator>, policy: u8) -> Result<()> {
        registry::set_inbox_policy(ctx, policy)
    }

    pub fn set_offer(ctx: Context<SetOffer>, asset: u8, direction: u8, terms: OfferTerms) -> Result<()> {
        registry::set_offer(ctx, asset, direction, terms)
    }

    /// One transaction refreshes every market. Offer accounts are remaining accounts in the
    /// order of `offers`.
    pub fn refresh_offers(
        ctx: Context<RefreshOffers>,
        offers: Vec<OfferRefresh>,
        eth: Vec<EthQuoteRefresh>,
    ) -> Result<()> {
        registry::refresh_offers(ctx, offers, eth)
    }

    /// Direction-A offer only; at most 8 slots.
    pub fn refill_keys(ctx: Context<RefillKeys>, asset: u8, slots: Vec<KeySlot>) -> Result<()> {
        registry::refill_keys(ctx, asset, slots)
    }

    /// Full write of one board slot. Opaque to the program.
    pub fn set_eth_quote(ctx: Context<SetEthQuote>, slot: u8, quote: [u8; 255], sig: [u8; 65]) -> Result<()> {
        registry::set_eth_quote(ctx, slot, quote, sig)
    }

    pub fn post_quote(ctx: Context<PostQuote>, terms: QuoteTerms) -> Result<()> {
        registry::post_quote(ctx, terms)
    }

    pub fn cancel_quote(ctx: Context<CancelQuote>) -> Result<()> {
        registry::cancel_quote(ctx)
    }

    /// Checks only the length (at most 900 bytes) and the magic. Writes nothing and emits
    /// nothing: the message is the instruction data.
    pub fn post_message(ctx: Context<PostMessage>, payload: Vec<u8>) -> Result<()> {
        registry::post_message(ctx, payload)
    }

    // -------------------------------------------------------------- opening (SPEC 4.4)

    /// A1: direction A.
    pub fn lock(ctx: Context<OpenSwap>, args: LockArgs) -> Result<()> {
        open::open(ctx, open::OpenArgs::from_lock(args))
    }

    /// B1: direction B.
    pub fn take(ctx: Context<OpenSwap>, args: TakeArgs) -> Result<()> {
        open::open(ctx, open::OpenArgs::from_take(args))
    }

    /// A2.
    pub fn approve(
        ctx: Context<Approve>,
        expected_open: [u8; 32],
        maker_spend_pub: [u8; 32],
        maker_pok: [u8; 64],
    ) -> Result<()> {
        open::approve(ctx, expected_open, maker_spend_pub, maker_pok)
    }

    /// B5.
    pub fn fund(
        ctx: Context<Fund>,
        expected_open: [u8; 32],
        maker_spend_pub: [u8; 32],
        maker_pok: [u8; 64],
        maker_view: [u8; 32],
        watcher: Option<Pubkey>,
    ) -> Result<()> {
        open::fund(ctx, expected_open, maker_spend_pub, maker_pok, maker_view, watcher)
    }

    // -------------------------------------------------------------- progress and settlement (SPEC 4.5)

    /// A3, B3. Reason 0, 1 or 2.
    pub fn reject(ctx: Context<Settle>, expected_open: [u8; 32], reason: u8) -> Result<()> {
        settle::reject(ctx, expected_open, reason)
    }

    /// A4, B2.
    pub fn cancel_pending(ctx: Context<Settle>) -> Result<()> {
        settle::cancel_pending(ctx)
    }

    /// A5, B4.
    pub fn expire_pending(ctx: Context<Settle>) -> Result<()> {
        settle::expire_pending(ctx)
    }

    /// A6, B6.
    pub fn post_notice(ctx: Context<Short>, commitment: [u8; 32], ciphertext: [u8; 104]) -> Result<()> {
        settle::post_notice(ctx, commitment, ciphertext)
    }

    /// A9, B7.
    pub fn set_ready(ctx: Context<Short>) -> Result<()> {
        settle::set_ready(ctx)
    }

    /// Z1 (SPEC 11.6). The watcher the swap names, or the locker: NOTICED, before `T_co`, once.
    pub fn freeze(ctx: Context<Short>) -> Result<()> {
        settle::freeze(ctx)
    }

    /// A7a-d, B8.
    pub fn abort(ctx: Context<Settle>) -> Result<()> {
        settle::abort(ctx)
    }

    /// A8.
    pub fn refund_unnoticed(ctx: Context<Settle>) -> Result<()> {
        settle::refund_unnoticed(ctx)
    }

    /// B11.
    pub fn expire_unnoticed(ctx: Context<Settle>) -> Result<()> {
        settle::expire_unnoticed(ctx)
    }

    /// A10a-g, B9a-h.
    pub fn refund(ctx: Context<Settle>, secret: [u8; 32]) -> Result<()> {
        settle::refund(ctx, secret)
    }

    /// A11a-c, B10a-c.
    pub fn claim(ctx: Context<SettlePayout>, secret: [u8; 32]) -> Result<()> {
        settle::claim(ctx, secret)
    }

    pub fn release_deposit(ctx: Context<Settle>) -> Result<()> {
        settle::release_deposit(ctx)
    }

    pub fn withhold(ctx: Context<Short>, evidence: Option<Evidence>) -> Result<()> {
        settle::withhold(ctx, evidence)
    }

    pub fn split_deposit(ctx: Context<Settle>) -> Result<()> {
        settle::split_deposit(ctx)
    }

    pub fn publish_evidence(ctx: Context<Short>, txid: [u8; 32], view: [u8; 32]) -> Result<()> {
        settle::publish_evidence(ctx, txid, view)
    }

    /// `who`: 0 taker, 1 maker (signer: the maker's owner), 2 treasury.
    pub fn withdraw_owed(ctx: Context<SettlePayout>, who: u8) -> Result<()> {
        settle::withdraw_owed(ctx, who)
    }

    pub fn close_swap(ctx: Context<Settle>) -> Result<()> {
        settle::close_swap(ctx)
    }
}
