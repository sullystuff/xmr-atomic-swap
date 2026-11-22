//! Protocol constants of SPEC 3.1 (Solana column). Changing one is a code change plus
//! regenerated vectors; `interfaces/vectors/deadlines.json` carries the same values.

pub const FEE_BPS: u16 = 5;
pub const MAX_DEPOSIT_BPS: u16 = 500;
pub const HOLD_SECS: i64 = 1_800;
pub const SPLIT_SECS: i64 = 5_184_000;
/// `W_x`: after the final deadline.
pub const EXPIRY_SECS: i64 = 2_592_000;
/// `B`: per-confirmation allowance in the refund cutoff.
pub const BLOCK_ALLOWANCE_SECS: i64 = 180;
pub const CUT_MARGIN_SECS: i64 = 900;
/// `M`: broadcast margin (client rule 2).
pub const MARGIN_SECS: i64 = 300;
/// `F`: finality allowance.
pub const FINALITY_SECS: i64 = 15;
pub const MIN_NOTICE_SECS: u32 = 300;
pub const MAX_NOTICE_SECS: u32 = 3_600;
pub const MIN_CLAIM_DELAY_SECS: u32 = 3_600;
pub const MIN_APPROVAL_SECS: u32 = 30;
pub const MAX_APPROVAL_SECS: u32 = 3_600;
pub const MAX_FINAL_SECS: u32 = 2_592_000;
pub const READY_MIN_SECS_PER_CONF: i64 = 60;
pub const CLOSE_GRACE_SECS: i64 = 2_592_000;
pub const LINK_DELAY_SECS: i64 = 604_800;
pub const MAX_OPEN_PENDING: u16 = 64;
pub const EXPLICIT_APPROVE: bool = false;
/// The safety gap between the claimer's last window and the final deadline.
pub const DAY_SECS: i64 = 86_400;
/// A taker-bound quote expires at most this long after it is posted.
pub const MAX_QUOTE_SECS: i64 = 120;

/// Size cap of a `post_message` payload.
pub const MAX_MESSAGE_LEN: usize = 900;
/// Envelope magic "XS".
pub const MESSAGE_MAGIC: [u8; 2] = [0x58, 0x53];
/// Advance-approval message length (SPEC 2.9).
pub const SOL_APPROVAL_LEN: usize = 190;
pub const MAX_KEY_SLOTS_PER_REFILL: usize = 8;
pub const POOL_SLOTS: usize = 16;
pub const ETH_BOARD_SLOTS: usize = 4;
pub const MAX_ONION_LEN: usize = 62;
pub const MAX_CONTACTS: usize = 6;
pub const MAX_CONTACT_LEN: usize = 96;

/// Account sizes (SPEC 4.1), discriminator included.
pub const CONFIG_SIZE: usize = 256;
pub const TREASURY_SIZE: usize = 16;
pub const MAKER_SIZE: usize = 1_280;
pub const OFFER_SIZE: usize = 768;
pub const ETH_BOARD_SIZE: usize = 1_408;
pub const QUOTE_SIZE: usize = 192;
pub const SWAP_SIZE: usize = 736;

/// Assets: `0` = SOL, `1` = USDC (`Config.usdc_mint`).
pub const ASSET_SOL: u8 = 0;
pub const ASSET_USDC: u8 = 1;
/// SOL burned in `split_mode = 1` goes here.
pub const INCINERATOR: &str = "1nc1nerator11111111111111111111111111111111";

/// Swap states (SPEC 3.3). 0 = no such swap.
pub mod state {
    pub const PENDING: u8 = 1;
    pub const ACTIVE: u8 = 2;
    pub const NOTICED: u8 = 3;
    pub const READY: u8 = 4;
    pub const ABORTED_FREE: u8 = 5;
    pub const ABORTED_HOLD: u8 = 6;
    pub const HOLD: u8 = 7;
    pub const WITHHELD: u8 = 8;
    pub const DONE: u8 = 9;
}

/// Bits of `Swap.flags`.
pub mod flag {
    pub const NOTICE: u8 = 1 << 0;
    pub const EVIDENCE: u8 = 1 << 1;
    pub const REVEALED: u8 = 1 << 2;
    pub const REVEALER_LOCKER: u8 = 1 << 3;
    pub const LATE_NOTICE: u8 = 1 << 4;
}

/// Counter ids (SPEC 3.7); also the `outcome` codes.
pub mod counter {
    pub const LOCKS: u8 = 0;
    pub const TAKES: u8 = 1;
    pub const APPROVALS: u8 = 2;
    pub const REJECTIONS: u8 = 3;
    pub const APPROVAL_TIMEOUTS: u8 = 4;
    pub const PENDING_CANCELS: u8 = 5;
    pub const NOTICES: u8 = 6;
    pub const READIES: u8 = 7;
    pub const COMPLETED: u8 = 8;
    pub const CLAIMS_WITHOUT_READY: u8 = 9;
    pub const CLAIMS_AFTER_FINAL: u8 = 10;
    pub const MISSED_NOTICES: u8 = 11;
    pub const MISSED_CLAIMS: u8 = 12;
    pub const MISSED_FUNDS: u8 = 13;
    pub const ABORTS_PRE_NOTICE: u8 = 14;
    pub const ABORTS_EARLY: u8 = 15;
    pub const ABORTS_LATE: u8 = 16;
    pub const BACKOUTS_PRE_NOTICE: u8 = 17;
    pub const BACKOUTS_POST_NOTICE: u8 = 18;
    pub const TAKER_CLAIMS_WITHOUT_READY: u8 = 19;
    pub const TAKER_CANCELS_APPROVED: u8 = 20;
    pub const TAKER_REFUNDS_NOTICED: u8 = 21;
    pub const REFUNDS_AFTER_ABORT: u8 = 22;
    pub const TAKER_NO_NOTICE: u8 = 23;
    pub const REFUNDS_UNCONFIRMED: u8 = 24;
    pub const TAKER_MISSED_CLAIMS: u8 = 25;
    pub const TAKER_ABORTS: u8 = 26;
    pub const EXPIRED_REFUNDS: u8 = 27;
    pub const DEPOSITS_RETURNED: u8 = 28;
    pub const WITHHOLDS: u8 = 29;
    pub const RELEASES: u8 = 30;
    pub const SPLITS: u8 = 31;
    pub const REJECTIONS_NO_FAULT: u8 = 32;
    pub const COUNT: usize = 40;
    /// `outcome` while the swap is open; the counter byte of an event that moves none.
    pub const NONE: u8 = 0xff;
}

/// `DS(tag)` = `"xmrswap/v1/" ‖ tag ‖ 0x00` (SPEC 2.1).
pub const DS_POK: &[u8] = b"xmrswap/v1/pok\0";
pub const DS_TERMS: &[u8] = b"xmrswap/v1/terms\0";
pub const DS_OPEN: &[u8] = b"xmrswap/v1/open\0";
pub const DS_NOTICE: &[u8] = b"xmrswap/v1/notice\0";
pub const DS_SOL_APPROVAL: &[u8; 24] = b"xmrswap/v1/sol-approval\0";

/// Values of `Swap.deposit_state`.
pub mod deposit_state {
    pub const NONE: u8 = 0;
    pub const HELD: u8 = 1;
    pub const WITHHELD: u8 = 2;
    pub const RETURNED: u8 = 3;
    pub const RELEASED: u8 = 4;
    pub const SPLIT: u8 = 5;
}

/// Offer or quote modes, and the effective mode stored in the swap.
pub mod mode {
    pub const AUTO: u8 = 0;
    pub const WINDOW: u8 = 1;
    pub const ADVANCE: u8 = 2;
    pub const QUOTE: u8 = 3;
}

pub const DIR_A: u8 = 0;
pub const DIR_B: u8 = 1;
