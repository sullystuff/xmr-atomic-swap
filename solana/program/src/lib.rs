//! `xmr_swap`: the Solana program of SPEC section 4.
//!
//! **This is the signatures-only skeleton written by work package 1.** Every instruction,
//! account list, argument struct, account layout, event and error is declared exactly as it is
//! frozen in `interfaces/solana/xmr_swap.idl.json` (generated from this crate with
//! `anchor idl build`). Every handler refuses to run. Work package 2 fills the handlers in;
//! `node interfaces/tools/check-idl.mjs` then proves the interface did not move.
//!
//! Nothing in this repository deploys this program or sends a transaction to any cluster.
use anchor_lang::prelude::*;

pub mod args;
pub mod constants;
pub mod contexts;
pub mod curve;
pub mod errors;
pub mod events;
pub mod state;

pub use args::*;
pub use contexts::*;
pub use errors::SwapError;
pub use events::*;
pub use state::*;

declare_id!("5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u");

/// Skeleton handlers fail closed: a build of this crate before WP2 can do nothing.
fn not_implemented() -> Result<()> {
    Err(ProgramError::InvalidInstructionData.into())
}

#[program]
#[allow(unused_variables)] // skeleton: the arguments are declared for the IDL, not yet used
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
        not_implemented()
    }

    pub fn set_treasury_authority(ctx: Context<AdminConfig>, treasury_authority: Pubkey) -> Result<()> {
        not_implemented()
    }

    pub fn set_split_mode(ctx: Context<AdminConfig>, split_mode: u8) -> Result<()> {
        not_implemented()
    }

    pub fn transfer_admin(ctx: Context<AdminConfig>, admin: Pubkey) -> Result<()> {
        not_implemented()
    }

    /// Sets `admin` to the default key; afterwards the four admin setters fail forever.
    pub fn freeze_config(ctx: Context<AdminConfig>) -> Result<()> {
        not_implemented()
    }

    /// Moves fees to a destination the treasury authority names. SOL: never below the Treasury
    /// account's rent minimum.
    pub fn sweep_treasury(ctx: Context<SweepTreasury>, asset: u8, amount: u64) -> Result<()> {
        not_implemented()
    }

    // -------------------------------------------------------------- registry (SPEC 4.3)

    pub fn register_maker(
        ctx: Context<RegisterMaker>,
        operator: Pubkey,
        payout: Pubkey,
        enc_key: [u8; 32],
    ) -> Result<()> {
        not_implemented()
    }

    /// Also increments both epochs.
    pub fn set_operator(ctx: Context<MakerByOwner>, operator: Pubkey) -> Result<()> {
        not_implemented()
    }

    pub fn set_payout(ctx: Context<MakerByOwner>, payout: Pubkey) -> Result<()> {
        not_implemented()
    }

    pub fn set_eth_link(ctx: Context<MakerByOwner>, eth_address: [u8; 20]) -> Result<()> {
        not_implemented()
    }

    /// Sets or clears the caller's pause bit.
    pub fn set_paused(ctx: Context<MakerByOwnerOrOperator>, paused: bool) -> Result<()> {
        not_implemented()
    }

    pub fn bump_epochs(ctx: Context<MakerByOwnerOrOperator>, approvals: bool, quotes: bool) -> Result<()> {
        not_implemented()
    }

    pub fn rotate_enc_key(ctx: Context<MakerByOperator>, new_key: [u8; 32], prev_expires_at: i64) -> Result<()> {
        not_implemented()
    }

    /// Empty clears. Otherwise 56 base32 characters + `.onion`.
    pub fn set_onion(ctx: Context<MakerByOperator>, onion: String) -> Result<()> {
        not_implemented()
    }

    /// Replaces the list.
    pub fn set_contacts(ctx: Context<MakerByOperator>, contacts: Vec<Contact>) -> Result<()> {
        not_implemented()
    }

    pub fn set_inbox_policy(ctx: Context<MakerByOperator>, policy: u8) -> Result<()> {
        not_implemented()
    }

    pub fn set_offer(ctx: Context<SetOffer>, asset: u8, direction: u8, terms: OfferTerms) -> Result<()> {
        not_implemented()
    }

    /// One transaction refreshes every market. Offer accounts are remaining accounts in the
    /// order of `offers`.
    pub fn refresh_offers(
        ctx: Context<RefreshOffers>,
        offers: Vec<OfferRefresh>,
        eth: Vec<EthQuoteRefresh>,
    ) -> Result<()> {
        not_implemented()
    }

    /// Direction-A offer only; at most 8 slots.
    pub fn refill_keys(ctx: Context<RefillKeys>, asset: u8, slots: Vec<KeySlot>) -> Result<()> {
        not_implemented()
    }

    /// Full write of one board slot. Opaque to the program.
    pub fn set_eth_quote(ctx: Context<SetEthQuote>, slot: u8, quote: [u8; 251], sig: [u8; 65]) -> Result<()> {
        not_implemented()
    }

    pub fn post_quote(ctx: Context<PostQuote>, terms: QuoteTerms) -> Result<()> {
        not_implemented()
    }

    pub fn cancel_quote(ctx: Context<CancelQuote>) -> Result<()> {
        not_implemented()
    }

    /// Checks only the length (at most 900 bytes) and the magic. Writes nothing and emits
    /// nothing: the message is the instruction data.
    pub fn post_message(ctx: Context<PostMessage>, payload: Vec<u8>) -> Result<()> {
        not_implemented()
    }

    // -------------------------------------------------------------- opening (SPEC 4.4)

    /// A1: direction A.
    pub fn lock(ctx: Context<OpenSwap>, args: LockArgs) -> Result<()> {
        not_implemented()
    }

    /// B1: direction B.
    pub fn take(ctx: Context<OpenSwap>, args: TakeArgs) -> Result<()> {
        not_implemented()
    }

    /// A2.
    pub fn approve(
        ctx: Context<Approve>,
        expected_open: [u8; 32],
        maker_spend_pub: [u8; 32],
        maker_pok: [u8; 64],
    ) -> Result<()> {
        not_implemented()
    }

    /// B5.
    pub fn fund(
        ctx: Context<Fund>,
        expected_open: [u8; 32],
        maker_spend_pub: [u8; 32],
        maker_pok: [u8; 64],
        maker_view: [u8; 32],
    ) -> Result<()> {
        not_implemented()
    }

    // -------------------------------------------------------------- progress and settlement (SPEC 4.5)

    /// A3, B3. Reason 0, 1 or 2.
    pub fn reject(ctx: Context<Settle>, expected_open: [u8; 32], reason: u8) -> Result<()> {
        not_implemented()
    }

    /// A4, B2.
    pub fn cancel_pending(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    /// A5, B4.
    pub fn expire_pending(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    /// A6, B6.
    pub fn post_notice(ctx: Context<Short>, commitment: [u8; 32], ciphertext: [u8; 104]) -> Result<()> {
        not_implemented()
    }

    /// A9, B7.
    pub fn set_ready(ctx: Context<Short>) -> Result<()> {
        not_implemented()
    }

    /// A7a-d, B8.
    pub fn abort(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    /// A8.
    pub fn refund_unnoticed(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    /// B11.
    pub fn expire_unnoticed(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    /// A10a-g, B9a-h.
    pub fn refund(ctx: Context<Settle>, secret: [u8; 32]) -> Result<()> {
        not_implemented()
    }

    /// A11a-c, B10a-c.
    pub fn claim(ctx: Context<Settle>, secret: [u8; 32]) -> Result<()> {
        not_implemented()
    }

    pub fn release_deposit(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    pub fn withhold(ctx: Context<Short>, evidence: Option<Evidence>) -> Result<()> {
        not_implemented()
    }

    pub fn split_deposit(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }

    pub fn publish_evidence(ctx: Context<Short>, txid: [u8; 32], view: [u8; 32]) -> Result<()> {
        not_implemented()
    }

    /// `who`: 0 taker, 1 maker (signer: the maker's owner), 2 treasury.
    pub fn withdraw_owed(ctx: Context<Settle>, who: u8) -> Result<()> {
        not_implemented()
    }

    pub fn close_swap(ctx: Context<Settle>) -> Result<()> {
        not_implemented()
    }
}
