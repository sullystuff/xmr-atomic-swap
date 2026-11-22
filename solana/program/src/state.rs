//! Account layouts (SPEC 4.2). Borsh, fields in this order. Sizes in `constants.rs` include the
//! 8-byte discriminator. The names `Maker` and `Swap` are frozen: clients filter on their
//! discriminators.
use anchor_lang::prelude::*;

/// PDA `["config"]`, 256 bytes.
#[account]
pub struct Config {
    /// `Pubkey::default()` = frozen.
    pub admin: Pubkey,
    /// May sweep the treasury.
    pub treasury_authority: Pubkey,
    /// Genesis hash of the cluster; binds signed objects.
    pub cluster_tag: [u8; 32],
    /// Asset 1.
    pub usdc_mint: Pubkey,
    /// 0 = the treasury half of a split goes to the treasury; 1 = burned.
    pub split_mode: u8,
    pub bump: u8,
    pub treasury_bump: u8,
    pub reserved: [u8; 117],
}

/// PDA `["treasury"]`, 16 bytes. Holds SOL fees as lamports above rent; authority of the
/// treasury token vault.
#[account]
pub struct Treasury {
    pub bump: u8,
    pub reserved: [u8; 7],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Contact {
    /// 0 website, 1 email, 2 Matrix, 3 Discord, 4 Telegram, 5 blob endpoint URL (HTTPS), 255 other.
    pub kind: u8,
    /// At most 96 bytes.
    pub value: String,
}

/// PDA `["maker", owner]`, 1,280 bytes. Fixed fields first; variable data last.
#[account]
pub struct Maker {
    /// Offset 8. Cold key: registration, link, payout, operator.
    pub owner: Pubkey,
    /// Offset 40. Hot key: offers, approvals, notices, claims, messages.
    pub operator: Pubkey,
    /// Offset 72. Wallet that receives direction-A claims (tokens: its associated token account).
    pub payout: Pubkey,
    /// Current X25519 key.
    pub enc_key: [u8; 32],
    /// Starts at 1.
    pub enc_key_version: u32,
    pub prev_enc_key: [u8; 32],
    /// Chain time; 0 = none.
    pub prev_enc_key_expires_at: i64,
    pub approval_epoch: u32,
    pub quote_epoch: u32,
    /// bit 0 set by the owner, bit 1 by the operator; nonzero = no new swaps.
    pub paused: u8,
    /// 0 = open; 1 = only takers with a swap (enforced by the daemon).
    pub inbox_policy: u8,
    pub open_pending: u16,
    pub registered_slot: u64,
    pub registered_at: i64,
    /// Linked Ethereum maker address; zeros = none.
    pub eth_link: [u8; 20],
    /// Pending change and when it takes effect; 0 = none.
    pub eth_link_next: [u8; 20],
    pub eth_link_next_at: i64,
    /// SPEC 3.7. Updates saturate.
    pub counters: [u32; 40],
    pub response_secs_sum: u64,
    /// Indexed by asset.
    pub volume: [u64; 2],
    pub withheld_volume: [u64; 2],
    pub bump: u8,
    /// v3 onion host (at most 62 bytes), or empty.
    pub onion: String,
    /// At most 6.
    pub contacts: Vec<Contact>,
}

/// PDA `["offer", maker PDA, [asset], [direction]]`, 768 bytes.
#[account]
pub struct Offer {
    /// Offset 8. Maker PDA.
    pub maker: Pubkey,
    /// Offset 40.
    pub asset: u8,
    pub direction: u8,
    pub enabled: u8,
    pub mode: u8,
    pub bump: u8,
    /// +1 on every change.
    pub seq: u64,
    pub updated_at: i64,
    /// The offer is live while `now <= updated_at + valid_secs`.
    pub valid_secs: u32,
    pub min_xmr: u64,
    pub max_xmr: u64,
    pub capacity_xmr: u64,
    /// Price tiers; `price_above[0] == 0`; price 0 = unused.
    pub price_above: [u64; 3],
    pub prices: [u64; 3],
    /// Depth tiers; `depth_above[0] == 0`; depth 0 = unused.
    pub depth_above: [u64; 3],
    pub depths: [u8; 3],
    pub dep_bps: u16,
    pub w_a: u32,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub w_f: u32,
    pub terms_hash: [u8; 32],
    /// Bitmaps over the 16 slots.
    pub pool_filled: u16,
    pub pool_used: u16,
    /// Maker spend commitments (direction A only).
    pub pool: [[u8; 32]; 16],
    pub reserved: [u8; 34],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct EthQuoteSlot {
    pub used: u8,
    pub updated_at: i64,
    /// The compact form of SPEC 2.10. Dynamic fields: `tierPrice` at 102..150, `validUntil` at
    /// 199..207, `quoteId` at 243..251.
    pub quote: [u8; 251],
    pub sig: [u8; 65],
}

/// PDA `["eth_board", maker PDA]`, 1,408 bytes. Ethereum quotes published for discovery; opaque
/// to the program.
#[account]
pub struct EthBoard {
    pub maker: Pubkey,
    pub bump: u8,
    pub slots: [EthQuoteSlot; 4],
}

/// PDA `["quote", maker PDA, quote_id (u64 LE)]`, 192 bytes. A taker-bound quote, consumed and
/// closed by the taker's `lock` or `take`.
#[account]
pub struct Quote {
    /// Offset 8. Maker PDA.
    pub maker: Pubkey,
    /// Offset 40.
    pub taker: Pubkey,
    pub asset: u8,
    pub direction: u8,
    pub depth: u8,
    pub bump: u8,
    pub xmr: u64,
    /// Exact: in A the taker pays `amount`, in B the maker escrows it.
    pub amount: u64,
    pub dep_bps: u16,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub w_f: u32,
    /// Direction A; zeros in B.
    pub maker_spend_pub: [u8; 32],
    pub expires_at: i64,
    pub epoch: u32,
    pub quote_id: u64,
    pub reserved: [u8; 30],
}

/// PDA `["swap", taker, swap_nonce[16]]`, 736 bytes. Offsets in comments are frozen.
#[account]
pub struct Swap {
    /// 8
    pub taker: Pubkey,
    /// 40. Maker PDA.
    pub maker: Pubkey,
    /// 72. SPEC 3.3.
    pub state: u8,
    /// 73. 0 = A, 1 = B.
    pub direction: u8,
    /// 74
    pub asset: u8,
    /// 75. Effective mode: 0 auto, 1 window, 2 advance, 3 quote.
    pub mode: u8,
    /// 76. Counter id; `0xff` while open.
    pub outcome: u8,
    /// 77. 0 none, 1 held, 2 withheld, 3 returned, 4 released by the maker, 5 split.
    pub deposit_state: u8,
    /// 78
    pub depth: u8,
    /// 79. bit 0 notice on record; bit 1 evidence published; bit 2 secret revealed; bit 3 the
    /// revealer was the locker; bit 4 late notice (direction B).
    pub flags: u8,
    /// 80
    pub bump: u8,
    /// 81
    pub vault_bump: u8,
    /// 82
    pub swap_nonce: [u8; 16],
    /// 98
    pub session_key: Pubkey,
    /// 130. Taker's one-time X25519 key.
    pub taker_enc_key: [u8; 32],
    /// 162. Maker key version the swap's messages use.
    pub maker_enc_version: u32,
    /// 166. The maker's X25519 key of that version, copied from the Maker account.
    pub maker_enc_key: [u8; 32],
    /// 198
    pub amount: u64,
    pub deposit: u64,
    pub xmr: u64,
    pub price: u64,
    /// 230
    pub dep_bps: u16,
    pub fee_bps: u16,
    /// 234
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    /// 246
    pub taker_spend_pub: [u8; 32],
    /// 278. Zeros until known.
    pub maker_spend_pub: [u8; 32],
    /// 310. The locker's private view share, in clear.
    pub locker_view: [u8; 32],
    /// 342
    pub notice_commitment: [u8; 32],
    /// 374
    pub notice_ct: [u8; 104],
    /// 478
    pub evidence_txid: [u8; 32],
    pub evidence_view: [u8; 32],
    /// 542. The revealed spend share.
    pub revealed: [u8; 32],
    /// 574. 0 = not set.
    pub t_lock: i64,
    pub t_pending_deadline: i64,
    pub t_active: i64,
    pub t_note_deadline: i64,
    pub t_notice: i64,
    pub t_cut: i64,
    pub t_claim_open: i64,
    pub t_ready: i64,
    pub t_claim_deadline: i64,
    pub t_final: i64,
    pub t_refund: i64,
    pub t_settled: i64,
    /// 670. Parked payouts still in escrow.
    pub owed_taker: u64,
    pub owed_maker: u64,
    pub owed_treasury: u64,
    /// 694
    pub reserved: [u8; 42],
}

// ------------------------------------------------------------------ derived values

use crate::constants::*;

impl Maker {
    /// Counter updates saturate; they can never fail an instruction (SPEC 3.7).
    pub fn bump(&mut self, id: u8) {
        if let Some(slot) = self.counters.get_mut(id as usize) {
            *slot = slot.saturating_add(1);
        }
    }
    pub fn pending_opened(&mut self) {
        self.open_pending = self.open_pending.saturating_add(1);
    }
    pub fn pending_closed(&mut self) {
        self.open_pending = self.open_pending.saturating_sub(1);
    }
}

impl Swap {
    /// `T_nl = t_final − d_c − w_c − 86,400`: the latest notice (direction B).
    pub fn t_nl(&self) -> i64 {
        self.t_final - self.d_c as i64 - self.w_c as i64 - DAY_SECS
    }
    pub fn t_exp(&self) -> i64 {
        self.t_final.saturating_add(EXPIRY_SECS)
    }
    pub fn t_hold(&self) -> i64 {
        self.t_refund.saturating_add(HOLD_SECS)
    }
    pub fn t_split(&self) -> i64 {
        self.t_refund.saturating_add(SPLIT_SECS)
    }
    /// Earliest `set_ready`.
    pub fn t_ready_min(&self) -> i64 {
        self.t_notice + self.depth as i64 * READY_MIN_SECS_PER_CONF
    }
    pub fn has(&self, f: u8) -> bool {
        self.flags & f != 0
    }
    pub fn is_a(&self) -> bool {
        self.direction == DIR_A
    }
    /// SPEC 3.12: what `approve`, `fund` and `reject` bind to. Recomputed from the account.
    pub fn open_hash(&self, swap_key: &Pubkey) -> [u8; 32] {
        crate::util::sha256(&[
            DS_OPEN,
            swap_key.as_ref(),
            &self.t_lock.to_le_bytes(),
            &[self.direction, self.asset],
            &self.xmr.to_le_bytes(),
            &self.amount.to_le_bytes(),
            &self.deposit.to_le_bytes(),
            &self.taker_spend_pub,
            &self.locker_view,
            &self.taker_enc_key,
            &self.maker_enc_key,
        ])
    }
    /// `SHA256(DS("notice") ‖ swap PDA ‖ txid ‖ view)` (SPEC 2.8).
    pub fn notice_opening(swap_key: &Pubkey, txid: &[u8; 32], view: &[u8; 32]) -> [u8; 32] {
        crate::util::sha256(&[DS_NOTICE, swap_key.as_ref(), txid, view])
    }
    /// An all-zero swap on the heap (the struct is 728 bytes: keep it off the caller's frame).
    #[inline(never)]
    pub fn new_boxed() -> Box<Swap> {
        Box::new(Swap {
            taker: Pubkey::default(),
            maker: Pubkey::default(),
            state: 0,
            direction: 0,
            asset: 0,
            mode: 0,
            outcome: counter::NONE,
            deposit_state: 0,
            depth: 0,
            flags: 0,
            bump: 0,
            vault_bump: 0,
            swap_nonce: [0; 16],
            session_key: Pubkey::default(),
            taker_enc_key: [0; 32],
            maker_enc_version: 0,
            maker_enc_key: [0; 32],
            amount: 0,
            deposit: 0,
            xmr: 0,
            price: 0,
            dep_bps: 0,
            fee_bps: 0,
            w_n: 0,
            d_c: 0,
            w_c: 0,
            taker_spend_pub: [0; 32],
            maker_spend_pub: [0; 32],
            locker_view: [0; 32],
            notice_commitment: [0; 32],
            notice_ct: [0; 104],
            evidence_txid: [0; 32],
            evidence_view: [0; 32],
            revealed: [0; 32],
            t_lock: 0,
            t_pending_deadline: 0,
            t_active: 0,
            t_note_deadline: 0,
            t_notice: 0,
            t_cut: 0,
            t_claim_open: 0,
            t_ready: 0,
            t_claim_deadline: 0,
            t_final: 0,
            t_refund: 0,
            t_settled: 0,
            owed_taker: 0,
            owed_maker: 0,
            owed_treasury: 0,
            reserved: [0; 42],
        })
    }
}

impl Offer {
    /// SPEC 4.2 `terms_hash`.
    pub fn compute_terms_hash(&self) -> [u8; 32] {
        let mut pre = [0u8; 54];
        pre[0] = self.asset;
        pre[1] = self.direction;
        pre[2] = self.mode;
        pre[3..5].copy_from_slice(&self.dep_bps.to_le_bytes());
        pre[5..7].copy_from_slice(&FEE_BPS.to_le_bytes());
        let mut at = 7;
        for w in [self.w_a, self.w_n, self.d_c, self.w_c, self.w_f] {
            pre[at..at + 4].copy_from_slice(&w.to_le_bytes());
            at += 4;
        }
        for i in 0..3 {
            pre[at..at + 8].copy_from_slice(&self.depth_above[i].to_le_bytes());
            pre[at + 8] = self.depths[i];
            at += 9;
        }
        crate::util::sha256(&[DS_TERMS, &pre])
    }
    pub fn prices_used(&self) -> [bool; 3] {
        [self.prices[0] != 0, self.prices[1] != 0, self.prices[2] != 0]
    }
    pub fn depths_used(&self) -> [bool; 3] {
        [self.depths[0] != 0, self.depths[1] != 0, self.depths[2] != 0]
    }
}
