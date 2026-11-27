//! Instruction argument structs (SPEC 4.3, 4.4).
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OfferTerms {
    /// 0 AUTO, 1 WINDOW, 2 ADVANCE.
    pub mode: u8,
    pub min_xmr: u64,
    pub max_xmr: u64,
    pub valid_secs: u32,
    pub price_above: [u64; 3],
    pub depth_above: [u64; 3],
    pub depths: [u8; 3],
    pub dep_bps: u16,
    pub w_a: u32,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub w_f: u32,
    /// Freeze window (SPEC 11.6). 0 = this offer accepts no watcher.
    pub w_z: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OfferRefresh {
    pub asset: u8,
    pub direction: u8,
    pub enabled: bool,
    pub prices: [u64; 3],
    pub capacity_xmr: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EthQuoteRefresh {
    pub slot: u8,
    pub tier_price: [u128; 3],
    pub valid_until: u64,
    pub quote_id: u64,
    pub sig: [u8; 65],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct KeySlot {
    pub index: u8,
    pub share: [u8; 32],
    /// Proof of knowledge, `ctx` = maker PDA.
    pub pok: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct QuoteTerms {
    pub quote_id: u64,
    pub taker: Pubkey,
    pub asset: u8,
    pub direction: u8,
    pub depth: u8,
    pub xmr: u64,
    pub amount: u64,
    pub dep_bps: u16,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub w_f: u32,
    /// Direction A; zeros in B.
    pub maker_spend_pub: [u8; 32],
    /// Direction A: proof of knowledge, `ctx` = maker PDA.
    pub maker_pok: [u8; 64],
    /// At most 120 s after posting; valid while `now <= expires_at`.
    pub expires_at: i64,
    /// Freeze window (SPEC 11.6). 0 = no watcher accepted.
    pub w_z: u32,
}

/// 248 bytes; 249 with an approval; 33 more with a watcher.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LockArgs {
    pub swap_nonce: [u8; 16],
    /// Forwarded to the session key.
    pub session_lamports: u64,
    pub asset: u8,
    pub xmr: u64,
    pub max_pay: u64,
    /// Ignored with a quote.
    pub expected_terms_hash: [u8; 32],
    /// 0 = no check; ignored with a quote.
    pub min_seq: u64,
    pub taker_spend_pub: [u8; 32],
    /// `ctx` = swap PDA.
    pub taker_pok: [u8; 64],
    /// `v_T`, in clear.
    pub taker_view: [u8; 32],
    pub taker_enc_key: [u8; 32],
    pub maker_enc_version: u32,
    /// Preferred pool slot; only a hint.
    pub key_hint: u8,
    /// Index of the Ed25519 instruction carrying an advance approval.
    pub approval_ix: Option<u8>,
    /// The key that may freeze this swap (SPEC 11.6). Refused when the offer's `w_z` is 0.
    pub watcher: Option<Pubkey>,
}

/// 246 bytes, 247 with an approval.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TakeArgs {
    pub swap_nonce: [u8; 16],
    pub session_lamports: u64,
    pub asset: u8,
    pub xmr: u64,
    pub min_receive: u64,
    pub expected_terms_hash: [u8; 32],
    pub min_seq: u64,
    pub taker_spend_pub: [u8; 32],
    pub taker_pok: [u8; 64],
    pub taker_enc_key: [u8; 32],
    pub maker_enc_version: u32,
    pub approval_ix: Option<u8>,
    /// Where a claim pays (SPEC 11.2). The taker's own address by default.
    pub payout: Pubkey,
}

/// The opening of a notice commitment, posted in clear.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Evidence {
    pub txid: [u8; 32],
    pub view: [u8; 32],
}
