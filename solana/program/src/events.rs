//! Events (SPEC 4.7), emitted with `emit!`. Nothing a party needs for safety lives only in an
//! event: secrets, the notice and the evidence are account state.
//!
//! Every swap event carries `swap`, `maker`, `counter` (the counter id the transition moved, or
//! `0xff`) and `at` (chain time).
use anchor_lang::prelude::*;

// ------------------------------------------------------------------ swap events

#[event]
pub struct SwapOpened {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub taker: Pubkey,
    pub direction: u8,
    pub asset: u8,
    pub mode: u8,
    pub state: u8,
    pub amount: u64,
    pub deposit: u64,
    pub xmr: u64,
    pub depth: u8,
    /// Direction B: where a claim pays. Zeros in direction A.
    pub payout: Pubkey,
    /// Direction A: the watcher named at lock. Zeros when none.
    pub watcher: Pubkey,
}

#[event]
pub struct SwapApproved {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct SwapRejected {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct PendingCancelled {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct PendingExpired {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct NoticePosted {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub commitment: [u8; 32],
}

#[event]
pub struct ReadySet {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct Aborted {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub new_state: u8,
}

#[event]
pub struct RefundedKeyless {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct ExpiredUnnoticed {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

#[event]
pub struct Refunded {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub secret: [u8; 32],
    pub deposit_held: bool,
}

#[event]
pub struct Claimed {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub secret: [u8; 32],
    pub paid: u64,
    pub fee: u64,
}

#[event]
pub struct DepositReleased {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub amount: u64,
}

#[event]
pub struct DepositWithheld {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub amount: u64,
    /// Zeros when no evidence was required.
    pub txid: [u8; 32],
    pub view: [u8; 32],
}

#[event]
pub struct DepositSplit {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub to_taker: u64,
    pub to_treasury: u64,
}

#[event]
pub struct EvidencePublished {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub txid: [u8; 32],
    pub view: [u8; 32],
}

#[event]
pub struct PayoutParked {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    /// 0 taker, 1 maker, 2 treasury.
    pub who: u8,
    pub amount: u64,
}

#[event]
pub struct OwedWithdrawn {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub who: u8,
    pub amount: u64,
}

#[event]
pub struct SwapClosed {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
}

// ------------------------------------------------------------------ registry events

#[event]
pub struct MakerRegistered {
    pub maker: Pubkey,
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub payout: Pubkey,
    pub enc_key: [u8; 32],
    pub at: i64,
}

#[event]
pub struct OperatorChanged {
    pub maker: Pubkey,
    pub operator: Pubkey,
    pub approval_epoch: u32,
    pub quote_epoch: u32,
    pub at: i64,
}

#[event]
pub struct PayoutChanged {
    pub maker: Pubkey,
    pub payout: Pubkey,
    pub at: i64,
}

#[event]
pub struct LinkChanged {
    pub maker: Pubkey,
    pub old: [u8; 20],
    pub new: [u8; 20],
    pub effective_at: i64,
}

#[event]
pub struct PausedChanged {
    pub maker: Pubkey,
    /// The `paused` bitfield after the change.
    pub paused: u8,
    pub at: i64,
}

#[event]
pub struct EpochsBumped {
    pub maker: Pubkey,
    pub approval_epoch: u32,
    pub quote_epoch: u32,
    pub at: i64,
}

#[event]
pub struct EncKeyRotated {
    pub maker: Pubkey,
    pub version: u32,
    pub key: [u8; 32],
    pub prev_expires_at: i64,
}

#[event]
pub struct QuotePosted {
    pub maker: Pubkey,
    pub quote_id: u64,
    pub taker: Pubkey,
}

#[event]
pub struct QuoteCancelled {
    pub maker: Pubkey,
    pub quote_id: u64,
}

#[event]
pub struct OnionChanged {
    pub maker: Pubkey,
    pub onion: String,
}

#[event]
pub struct ContactsChanged {
    pub maker: Pubkey,
    pub count: u8,
}

#[event]
pub struct InboxPolicyChanged {
    pub maker: Pubkey,
    pub policy: u8,
}

#[event]
pub struct OfferSet {
    pub maker: Pubkey,
    pub asset: u8,
    pub direction: u8,
    pub seq: u64,
    pub terms_hash: [u8; 32],
}

#[event]
pub struct OffersRefreshed {
    pub maker: Pubkey,
    pub count: u8,
}

#[event]
pub struct KeysRefilled {
    pub maker: Pubkey,
    pub asset: u8,
    pub count: u8,
}

#[event]
pub struct EthQuoteSet {
    pub maker: Pubkey,
    pub slot: u8,
}

// ------------------------------------------------------------------ admin events

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub treasury_authority: Pubkey,
    pub cluster_tag: [u8; 32],
    pub usdc_mint: Pubkey,
    pub split_mode: u8,
}

/// Emitted by `set_treasury_authority`, `set_split_mode`, `transfer_admin` and `freeze_config`
/// with the values after the change (`admin` is the default key once frozen).
#[event]
pub struct ConfigChanged {
    pub admin: Pubkey,
    pub treasury_authority: Pubkey,
    pub split_mode: u8,
}

#[event]
pub struct TreasurySwept {
    pub asset: u8,
    pub amount: u64,
    pub destination: Pubkey,
}

// ------------------------------------------------------------------ Amendment 1

/// Amendment 1 (SPEC 11.1): `set_caps`.
#[event]
pub struct CapsChanged {
    pub caps_on: bool,
    pub max_swap: [u64; 2],
    pub max_open: [u64; 2],
}

/// Amendment 1 (SPEC 11.6): `freeze` (Z1).
#[event]
pub struct Frozen {
    pub swap: Pubkey,
    pub maker: Pubkey,
    pub counter: u8,
    pub at: i64,
    pub taker: Pubkey,
    pub watcher: Pubkey,
    /// `T_ff = max(t_freeze + w_z, t_claim_open)`.
    pub frozen_until: i64,
}
