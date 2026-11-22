//! In-process test harness (LiteSVM 0.16.0). No validator, no RPC, no CLI wallet.
//!
//! The program crate is not linked: instructions are encoded by hand (8-byte discriminator +
//! Borsh) against the built `.so`, and accounts are decoded by the offsets of SPEC 4.2. The
//! off-chain halves of the cryptography (proof of knowledge, open hash, notice commitment, terms
//! hash, approval bytes) are written here independently of `swap-core` and checked against its
//! vectors, so the program is tested against two implementations that agree.
#![allow(dead_code)]
use std::collections::HashMap;

use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, scalar::Scalar};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, MintTo};
use rand::RngCore;
use sha2::{Digest, Sha256, Sha512};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const PROGRAM_ID: Pubkey = pubkey!("5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u");
pub const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
pub const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const ED25519: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const IX_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const LOADER_V3: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
pub const NATIVE_LOADER: Pubkey = pubkey!("NativeLoader1111111111111111111111111111111");
pub const INCINERATOR: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");
pub const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../program/target/deploy/xmr_swap.so");
pub const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../interfaces/vectors");
pub const IDL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../interfaces/solana/xmr_swap.idl.json");

pub const SOL: u64 = 1_000_000_000;
pub const FEE: u64 = 5_000;
pub const T0: i64 = 1_800_000_000;
pub const XMR: u64 = 1_000_000_000_000;
pub const ASSET_SOL: u8 = 0;
pub const ASSET_USDC: u8 = 1;
pub const DIR_A: u8 = 0;
pub const DIR_B: u8 = 1;

// Protocol constants (SPEC 3.1, Solana column); `deadlines.rs` checks them against deadlines.json.
pub const HOLD_SECS: i64 = 1_800;
pub const SPLIT_SECS: i64 = 5_184_000;
pub const EXPIRY_SECS: i64 = 2_592_000;
pub const CLOSE_GRACE_SECS: i64 = 2_592_000;
pub const DAY_SECS: i64 = 86_400;

// States.
pub const PENDING: u8 = 1;
pub const ACTIVE: u8 = 2;
pub const NOTICED: u8 = 3;
pub const READY: u8 = 4;
pub const ABORTED_FREE: u8 = 5;
pub const ABORTED_HOLD: u8 = 6;
pub const HOLD: u8 = 7;
pub const WITHHELD: u8 = 8;
pub const DONE: u8 = 9;

/// Indexes into the Settle account list.
pub const S_TAKER: usize = 4;
pub const S_MAKER_WALLET: usize = 5;
pub const S_TREASURY: usize = 6;
pub const S_MINT: usize = 8;
pub const S_VAULT: usize = 9;
pub const S_TAKER_TOKEN: usize = 10;
pub const S_MAKER_TOKEN: usize = 11;
pub const S_TREASURY_VAULT: usize = 12;
pub const S_TOKEN_PROGRAM: usize = 13;

// ------------------------------------------------------------------ vectors and small helpers

pub fn vectors(name: &str) -> serde_json::Value {
    let path = format!("{VECTORS}/{name}.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}
pub fn h(v: &serde_json::Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("hex")
}
pub fn h32(v: &serde_json::Value) -> [u8; 32] {
    h(v).try_into().expect("32 bytes")
}
/// A decimal string or a JSON number.
pub fn num(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::String(s) => s.parse().unwrap(),
        other => other.as_u64().unwrap_or_else(|| panic!("not a u64: {other}")),
    }
}
pub fn inum(v: &serde_json::Value) -> i64 {
    match v {
        serde_json::Value::String(s) => s.parse().unwrap(),
        other => other.as_i64().unwrap_or_else(|| panic!("not an i64: {other}")),
    }
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hh = Sha256::new();
    for p in parts {
        hh.update(p);
    }
    hh.finalize().into()
}
pub fn ds(tag: &str) -> Vec<u8> {
    let mut v = b"xmrswap/v1/".to_vec();
    v.extend_from_slice(tag.as_bytes());
    v.push(0);
    v
}
pub fn rand32() -> [u8; 32] {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b
}
pub fn rand16() -> [u8; 16] {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

pub fn ix_disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}"))[..8].try_into().unwrap()
}
pub fn account_disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}"))[..8].try_into().unwrap()
}
pub fn event_disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("event:{name}"))[..8].try_into().unwrap()
}

/// Events emitted with `emit!` ("Program data: <base64>" log lines), without the discriminator.
pub fn logged_events(meta: &TransactionMetadata, name: &str) -> Vec<Vec<u8>> {
    use base64::Engine;
    let disc = event_disc(name);
    meta.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .filter(|d| d.len() >= 8 && d[..8] == disc)
        .map(|d| d[8..].to_vec())
        .collect()
}

pub fn meta(key: Pubkey, signer: bool, writable: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(key, signer)
    } else {
        AccountMeta::new_readonly(key, signer)
    }
}
/// An optional account: absent is passed as the program id (Anchor's convention).
pub fn opt(key: Option<Pubkey>, writable: bool) -> AccountMeta {
    match key {
        Some(k) => meta(k, false, writable),
        None => meta(PROGRAM_ID, false, false),
    }
}

/// The frozen error names, in code order (`6000 + index`), read from the frozen IDL.
pub fn error_code(name: &str) -> u32 {
    use std::sync::OnceLock;
    static MAP: OnceLock<HashMap<String, u32>> = OnceLock::new();
    let map = MAP.get_or_init(|| {
        let idl: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(IDL).unwrap()).unwrap();
        idl["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["name"].as_str().unwrap().to_string(), e["code"].as_u64().unwrap() as u32))
            .collect()
    });
    *map.get(name).unwrap_or_else(|| panic!("no such error in the frozen IDL: {name}"))
}

pub fn err_string(res: &TxResult) -> String {
    match res {
        Ok(_) => "Ok".to_string(),
        Err(e) => format!("{:?}", e.err),
    }
}
/// The transaction failed with the program error `name`.
pub fn is_err(res: &TxResult, name: &str) -> bool {
    match res {
        Ok(_) => false,
        Err(e) => format!("{:?}", e.err).contains(&format!("Custom({})", error_code(name))),
    }
}
#[track_caller]
pub fn assert_err(res: TxResult, name: &str) {
    assert!(
        is_err(&res, name),
        "expected {name} ({}), got {}\n{}",
        error_code(name),
        err_string(&res),
        match &res {
            Ok(m) => m.pretty_logs(),
            Err(e) => e.meta.pretty_logs(),
        }
    );
}
#[track_caller]
pub fn ok(res: TxResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(e) => panic!("transaction failed: {:?}\n{}", e.err, e.meta.pretty_logs()),
    }
}

// ------------------------------------------------------------------ Borsh by hand

#[derive(Default, Clone)]
pub struct Enc(pub Vec<u8>);
impl Enc {
    pub fn ix(name: &str) -> Self {
        Enc(ix_disc(name).to_vec())
    }
    pub fn u8(mut self, v: u8) -> Self {
        self.0.push(v);
        self
    }
    pub fn bool(self, v: bool) -> Self {
        self.u8(v as u8)
    }
    pub fn u16(mut self, v: u16) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u32(mut self, v: u32) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u64(mut self, v: u64) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn i64(mut self, v: i64) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u128(mut self, v: u128) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn bytes(mut self, v: &[u8]) -> Self {
        self.0.extend_from_slice(v);
        self
    }
    pub fn key(self, v: &Pubkey) -> Self {
        self.bytes(v.as_ref())
    }
    /// A Borsh `Vec<u8>` or `String`.
    pub fn vec(self, v: &[u8]) -> Self {
        self.u32(v.len() as u32).bytes(v)
    }
    pub fn opt_u8(self, v: Option<u8>) -> Self {
        match v {
            Some(x) => self.u8(1).u8(x),
            None => self.u8(0),
        }
    }
}

// ------------------------------------------------------------------ cryptography (off-chain halves)

pub const L_LE: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

pub fn clamp252(mut b: [u8; 32]) -> [u8; 32] {
    b[31] &= 0x0f;
    b
}
pub fn base_mul(s: &[u8; 32]) -> [u8; 32] {
    (Scalar::from_bytes_mod_order(*s) * ED25519_BASEPOINT_POINT).compress().to_bytes()
}
/// A fresh spend share (252 bits, nonzero) and its commitment.
pub fn new_share() -> ([u8; 32], [u8; 32]) {
    loop {
        let s = clamp252(rand32());
        if s != [0; 32] {
            return (s, base_mul(&s));
        }
    }
}
/// A canonical nonzero scalar mod l (a view share).
pub fn new_view() -> [u8; 32] {
    let mut wide = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut wide);
    Scalar::from_bytes_mod_order_wide(&wide).to_bytes()
}
/// `s + l` as 32 little-endian bytes: the same scalar mod l, a non-canonical encoding.
pub fn plus_l(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
        let v = s[i] as u16 + L_LE[i] as u16 + carry;
        out[i] = v as u8;
        carry = v >> 8;
    }
    assert_eq!(carry, 0, "s + l must fit 256 bits");
    out
}

/// SPEC 2.4, deterministic: `pok = R ‖ z`.
pub fn pok_prove(s: &[u8; 32], ctx: &[u8; 32]) -> [u8; 64] {
    let sk = Scalar::from_bytes_mod_order(*s);
    let s_pub = base_mul(s);
    let mut hh = Sha512::new();
    hh.update(ds("pok-nonce"));
    hh.update(s);
    hh.update(s_pub);
    hh.update(ctx);
    let wide: [u8; 64] = hh.finalize().into();
    let k = Scalar::from_bytes_mod_order_wide(&wide);
    let r = (k * ED25519_BASEPOINT_POINT).compress().to_bytes();
    let c = Scalar::from_bytes_mod_order(clamp252(sha256(&[&ds("pok"), &r, &s_pub, ctx])));
    let z = k + c * sk;
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&r);
    out[32..].copy_from_slice(&z.to_bytes());
    out
}

/// SPEC 3.12 (Solana): what `approve`, `fund` and `reject` bind to.
#[allow(clippy::too_many_arguments)]
pub fn open_hash_of(
    swap: &[u8; 32],
    t_lock: i64,
    direction: u8,
    asset: u8,
    xmr: u64,
    amount: u64,
    deposit: u64,
    taker_spend_pub: &[u8; 32],
    locker_view: &[u8; 32],
    taker_enc_key: &[u8; 32],
    maker_enc_key: &[u8; 32],
) -> [u8; 32] {
    sha256(&[
        &ds("open"),
        swap,
        &t_lock.to_le_bytes(),
        &[direction, asset],
        &xmr.to_le_bytes(),
        &amount.to_le_bytes(),
        &deposit.to_le_bytes(),
        taker_spend_pub,
        locker_view,
        taker_enc_key,
        maker_enc_key,
    ])
}

pub fn notice_commitment(swap: &Pubkey, txid: &[u8; 32], view: &[u8; 32]) -> [u8; 32] {
    sha256(&[&ds("notice"), swap.as_ref(), txid, view])
}

/// A point of small order (order 8), compressed.
pub fn torsion_point() -> [u8; 32] {
    curve25519_dalek::constants::EIGHT_TORSION[1].compress().to_bytes()
}
/// `S + T` for a torsion point `T`: on the curve, outside the prime-order subgroup.
pub fn torsioned(s_pub: &[u8; 32]) -> [u8; 32] {
    let p = CompressedEdwardsY(*s_pub).decompress().unwrap();
    (p + curve25519_dalek::constants::EIGHT_TORSION[1]).compress().to_bytes()
}

/// The 190 signed bytes of an advance approval (SPEC 2.9).
#[derive(Clone, Debug)]
pub struct ApprovalFields {
    pub cluster_tag: [u8; 32],
    pub program_id: [u8; 32],
    pub maker: [u8; 32],
    pub taker: [u8; 32],
    pub asset: u8,
    pub direction: u8,
    pub max_xmr: u64,
    pub not_before: i64,
    pub expires_at: i64,
    pub epoch: u32,
    pub approval_id: u64,
}
pub fn encode_approval(a: &ApprovalFields) -> Vec<u8> {
    let mut v = ds("sol-approval");
    v.extend_from_slice(&a.cluster_tag);
    v.extend_from_slice(&a.program_id);
    v.extend_from_slice(&a.maker);
    v.extend_from_slice(&a.taker);
    v.push(a.asset);
    v.push(a.direction);
    v.extend_from_slice(&a.max_xmr.to_le_bytes());
    v.extend_from_slice(&a.not_before.to_le_bytes());
    v.extend_from_slice(&a.expires_at.to_le_bytes());
    v.extend_from_slice(&a.epoch.to_le_bytes());
    v.extend_from_slice(&a.approval_id.to_le_bytes());
    assert_eq!(v.len(), 190);
    v
}
/// Ed25519 precompile instruction data for one signature, everything inside this instruction:
/// header (2) ‖ offsets (14) ‖ public key (32) ‖ signature (64) ‖ message.
pub fn ed25519_data(public: &[u8; 32], signature: &[u8], message: &[u8]) -> Vec<u8> {
    let mut d = vec![1u8, 0];
    for v in [48u16, 0xffff, 16, 0xffff, 112, message.len() as u16, 0xffff] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(public);
    d.extend_from_slice(signature);
    d.extend_from_slice(message);
    d
}
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    let sig = signer.sign_message(message);
    Instruction {
        program_id: ED25519,
        accounts: vec![],
        data: ed25519_data(&signer.pubkey().to_bytes(), sig.as_ref(), message),
    }
}

// ------------------------------------------------------------------ account views

fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn i64_at(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn b32_at(d: &[u8], o: usize) -> [u8; 32] {
    d[o..o + 32].try_into().unwrap()
}
fn key_at(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(b32_at(d, o))
}

/// The `Swap` account by the frozen offsets of SPEC 4.2.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapAcc {
    pub taker: Pubkey,
    pub maker: Pubkey,
    pub state: u8,
    pub direction: u8,
    pub asset: u8,
    pub mode: u8,
    pub outcome: u8,
    pub deposit_state: u8,
    pub depth: u8,
    pub flags: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub swap_nonce: [u8; 16],
    pub session_key: Pubkey,
    pub taker_enc_key: [u8; 32],
    pub maker_enc_version: u32,
    pub maker_enc_key: [u8; 32],
    pub amount: u64,
    pub deposit: u64,
    pub xmr: u64,
    pub price: u64,
    pub dep_bps: u16,
    pub fee_bps: u16,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub taker_spend_pub: [u8; 32],
    pub maker_spend_pub: [u8; 32],
    pub locker_view: [u8; 32],
    pub notice_commitment: [u8; 32],
    pub notice_ct: Vec<u8>,
    pub evidence_txid: [u8; 32],
    pub evidence_view: [u8; 32],
    pub revealed: [u8; 32],
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
    pub owed_taker: u64,
    pub owed_maker: u64,
    pub owed_treasury: u64,
}
impl SwapAcc {
    pub fn decode(d: &[u8]) -> Self {
        assert_eq!(d.len(), 736, "Swap is 736 bytes");
        assert_eq!(d[..8], account_disc("Swap"));
        SwapAcc {
            taker: key_at(d, 8),
            maker: key_at(d, 40),
            state: d[72],
            direction: d[73],
            asset: d[74],
            mode: d[75],
            outcome: d[76],
            deposit_state: d[77],
            depth: d[78],
            flags: d[79],
            bump: d[80],
            vault_bump: d[81],
            swap_nonce: d[82..98].try_into().unwrap(),
            session_key: key_at(d, 98),
            taker_enc_key: b32_at(d, 130),
            maker_enc_version: u32_at(d, 162),
            maker_enc_key: b32_at(d, 166),
            amount: u64_at(d, 198),
            deposit: u64_at(d, 206),
            xmr: u64_at(d, 214),
            price: u64_at(d, 222),
            dep_bps: u16_at(d, 230),
            fee_bps: u16_at(d, 232),
            w_n: u32_at(d, 234),
            d_c: u32_at(d, 238),
            w_c: u32_at(d, 242),
            taker_spend_pub: b32_at(d, 246),
            maker_spend_pub: b32_at(d, 278),
            locker_view: b32_at(d, 310),
            notice_commitment: b32_at(d, 342),
            notice_ct: d[374..478].to_vec(),
            evidence_txid: b32_at(d, 478),
            evidence_view: b32_at(d, 510),
            revealed: b32_at(d, 542),
            t_lock: i64_at(d, 574),
            t_pending_deadline: i64_at(d, 582),
            t_active: i64_at(d, 590),
            t_note_deadline: i64_at(d, 598),
            t_notice: i64_at(d, 606),
            t_cut: i64_at(d, 614),
            t_claim_open: i64_at(d, 622),
            t_ready: i64_at(d, 630),
            t_claim_deadline: i64_at(d, 638),
            t_final: i64_at(d, 646),
            t_refund: i64_at(d, 654),
            t_settled: i64_at(d, 662),
            owed_taker: u64_at(d, 670),
            owed_maker: u64_at(d, 678),
            owed_treasury: u64_at(d, 686),
        }
    }
    /// SPEC 3.12, computed independently of the program.
    pub fn open_hash(&self, swap: &Pubkey) -> [u8; 32] {
        open_hash_of(
            &swap.to_bytes(),
            self.t_lock,
            self.direction,
            self.asset,
            self.xmr,
            self.amount,
            self.deposit,
            &self.taker_spend_pub,
            &self.locker_view,
            &self.taker_enc_key,
            &self.maker_enc_key,
        )
    }
    pub fn t_exp(&self) -> i64 {
        self.t_final + EXPIRY_SECS
    }
    pub fn t_nl(&self) -> i64 {
        self.t_final - self.d_c as i64 - self.w_c as i64 - DAY_SECS
    }
}

/// Fixed offsets inside `Maker`.
pub const MAKER_OPEN_PENDING: usize = 190;
pub const MAKER_COUNTERS: usize = 256;
pub const MAKER_RESPONSE: usize = 416;
pub const MAKER_VOLUME: usize = 424;
pub const MAKER_WITHHELD: usize = 440;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MakerAcc {
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub payout: Pubkey,
    pub enc_key: [u8; 32],
    pub enc_key_version: u32,
    pub prev_enc_key: [u8; 32],
    pub prev_enc_key_expires_at: i64,
    pub approval_epoch: u32,
    pub quote_epoch: u32,
    pub paused: u8,
    pub inbox_policy: u8,
    pub open_pending: u16,
    pub registered_slot: u64,
    pub registered_at: i64,
    pub eth_link: [u8; 20],
    pub eth_link_next: [u8; 20],
    pub eth_link_next_at: i64,
    pub counters: [u32; 40],
    pub response_secs_sum: u64,
    pub volume: [u64; 2],
    pub withheld_volume: [u64; 2],
    pub bump: u8,
    pub onion: String,
    pub contacts: Vec<(u8, String)>,
}
impl MakerAcc {
    pub fn decode(d: &[u8]) -> Self {
        assert_eq!(d.len(), 1280, "Maker is 1,280 bytes");
        assert_eq!(d[..8], account_disc("Maker"));
        let mut counters = [0u32; 40];
        for (i, c) in counters.iter_mut().enumerate() {
            *c = u32_at(d, MAKER_COUNTERS + 4 * i);
        }
        let mut at = 457;
        let read_str = |at: &mut usize| {
            let n = u32_at(d, *at) as usize;
            let s = String::from_utf8(d[*at + 4..*at + 4 + n].to_vec()).unwrap();
            *at += 4 + n;
            s
        };
        let onion = read_str(&mut at);
        let n = u32_at(d, at) as usize;
        at += 4;
        let mut contacts = Vec::new();
        for _ in 0..n {
            let kind = d[at];
            at += 1;
            contacts.push((kind, read_str(&mut at)));
        }
        MakerAcc {
            owner: key_at(d, 8),
            operator: key_at(d, 40),
            payout: key_at(d, 72),
            enc_key: b32_at(d, 104),
            enc_key_version: u32_at(d, 136),
            prev_enc_key: b32_at(d, 140),
            prev_enc_key_expires_at: i64_at(d, 172),
            approval_epoch: u32_at(d, 180),
            quote_epoch: u32_at(d, 184),
            paused: d[188],
            inbox_policy: d[189],
            open_pending: u16_at(d, MAKER_OPEN_PENDING),
            registered_slot: u64_at(d, 192),
            registered_at: i64_at(d, 200),
            eth_link: d[208..228].try_into().unwrap(),
            eth_link_next: d[228..248].try_into().unwrap(),
            eth_link_next_at: i64_at(d, 248),
            counters,
            response_secs_sum: u64_at(d, MAKER_RESPONSE),
            volume: [u64_at(d, MAKER_VOLUME), u64_at(d, MAKER_VOLUME + 8)],
            withheld_volume: [u64_at(d, MAKER_WITHHELD), u64_at(d, MAKER_WITHHELD + 8)],
            bump: d[456],
            onion,
            contacts,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfferAcc {
    pub maker: Pubkey,
    pub asset: u8,
    pub direction: u8,
    pub enabled: u8,
    pub mode: u8,
    pub bump: u8,
    pub seq: u64,
    pub updated_at: i64,
    pub valid_secs: u32,
    pub min_xmr: u64,
    pub max_xmr: u64,
    pub capacity_xmr: u64,
    pub price_above: [u64; 3],
    pub prices: [u64; 3],
    pub depth_above: [u64; 3],
    pub depths: [u8; 3],
    pub dep_bps: u16,
    pub w_a: u32,
    pub w_n: u32,
    pub d_c: u32,
    pub w_c: u32,
    pub w_f: u32,
    pub terms_hash: [u8; 32],
    pub pool_filled: u16,
    pub pool_used: u16,
    pub pool: Vec<[u8; 32]>,
}
impl OfferAcc {
    pub fn decode(d: &[u8]) -> Self {
        assert_eq!(d.len(), 768, "Offer is 768 bytes");
        assert_eq!(d[..8], account_disc("Offer"));
        let three = |o: usize| [u64_at(d, o), u64_at(d, o + 8), u64_at(d, o + 16)];
        OfferAcc {
            maker: key_at(d, 8),
            asset: d[40],
            direction: d[41],
            enabled: d[42],
            mode: d[43],
            bump: d[44],
            seq: u64_at(d, 45),
            updated_at: i64_at(d, 53),
            valid_secs: u32_at(d, 61),
            min_xmr: u64_at(d, 65),
            max_xmr: u64_at(d, 73),
            capacity_xmr: u64_at(d, 81),
            price_above: three(89),
            prices: three(113),
            depth_above: three(137),
            depths: d[161..164].try_into().unwrap(),
            dep_bps: u16_at(d, 164),
            w_a: u32_at(d, 166),
            w_n: u32_at(d, 170),
            d_c: u32_at(d, 174),
            w_c: u32_at(d, 178),
            w_f: u32_at(d, 182),
            terms_hash: b32_at(d, 186),
            pool_filled: u16_at(d, 218),
            pool_used: u16_at(d, 220),
            pool: (0..16).map(|i| b32_at(d, 222 + 32 * i)).collect(),
        }
    }
}

// ------------------------------------------------------------------ fixtures

/// Offer terms (the `OfferTerms` argument of `set_offer`).
#[derive(Clone, Debug)]
pub struct Terms {
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
}
impl Default for Terms {
    /// The parameters the vectors use: depth 10, 1% deposit, 60 s / 10 min / 90 min / 30 min / 7 days.
    fn default() -> Self {
        Terms {
            mode: 0,
            min_xmr: 1,
            max_xmr: 1_000 * XMR,
            valid_secs: 60,
            price_above: [0; 3],
            depth_above: [0; 3],
            depths: [10, 0, 0],
            dep_bps: 100,
            w_a: 60,
            w_n: 600,
            d_c: 5_400,
            w_c: 1_800,
            w_f: 604_800,
        }
    }
}
impl Terms {
    pub fn encode(&self, e: Enc) -> Enc {
        let mut e = e.u8(self.mode).u64(self.min_xmr).u64(self.max_xmr).u32(self.valid_secs);
        for v in self.price_above {
            e = e.u64(v);
        }
        for v in self.depth_above {
            e = e.u64(v);
        }
        e.bytes(&self.depths).u16(self.dep_bps).u32(self.w_a).u32(self.w_n).u32(self.d_c).u32(self.w_c).u32(self.w_f)
    }
    /// SPEC 4.2 `terms_hash`, computed independently of the program.
    pub fn hash(&self, asset: u8, direction: u8) -> [u8; 32] {
        let mut pre = vec![asset, direction, self.mode];
        pre.extend_from_slice(&self.dep_bps.to_le_bytes());
        pre.extend_from_slice(&5u16.to_le_bytes());
        for w in [self.w_a, self.w_n, self.d_c, self.w_c, self.w_f] {
            pre.extend_from_slice(&w.to_le_bytes());
        }
        for i in 0..3 {
            pre.extend_from_slice(&self.depth_above[i].to_le_bytes());
            pre.push(self.depths[i]);
        }
        assert_eq!(pre.len(), 54);
        sha256(&[&ds("terms"), &pre])
    }
}

/// A registered maker and the secrets the test holds for it.
pub struct MakerFx {
    pub owner: Keypair,
    pub operator: Keypair,
    pub payout: Keypair,
    pub pda: Pubkey,
    pub enc_key: [u8; 32],
    /// commitment -> spend share, for every share this maker published.
    pub shares: HashMap<[u8; 32], [u8; 32]>,
}
impl MakerFx {
    pub fn new_share(&mut self) -> ([u8; 32], [u8; 32], [u8; 64]) {
        let (s, s_pub) = new_share();
        self.shares.insert(s_pub, s);
        (s, s_pub, pok_prove(&s, &self.pda.to_bytes()))
    }
    pub fn secret_for(&self, commitment: &[u8; 32]) -> [u8; 32] {
        *self.shares.get(commitment).expect("the test holds the maker's share")
    }
}

/// An open swap and the secrets the test holds for its taker.
pub struct SwapFx {
    pub taker: Keypair,
    pub session: Keypair,
    pub nonce: [u8; 16],
    pub pda: Pubkey,
    pub vault: Pubkey,
    pub asset: u8,
    pub direction: u8,
    pub xmr: u64,
    pub s_t: [u8; 32],
    pub s_pub_t: [u8; 32],
    pub view_t: [u8; 32],
    pub enc_key: [u8; 32],
    /// The opening of the notice this test posted: `(txid, view)`.
    pub notice: Option<([u8; 32], [u8; 32])>,
}

/// Where the terms of a lock or take come from.
#[derive(Clone, Copy)]
pub enum Source {
    Offer(Pubkey),
    /// `(quote, quote_rent_receiver)`.
    Quote(Pubkey, Pubkey),
}

/// Every field of a `lock` / `take` instruction, so a test can change any one of them.
#[derive(Clone)]
pub struct OpenRaw {
    pub direction: u8,
    pub taker: Pubkey,
    pub taker_signs: bool,
    pub maker: Pubkey,
    pub nonce: [u8; 16],
    pub swap: Pubkey,
    pub session: Pubkey,
    pub session_lamports: u64,
    pub asset: u8,
    pub xmr: u64,
    /// A: `max_pay`. B: `min_receive`.
    pub limit: u64,
    pub terms_hash: [u8; 32],
    pub min_seq: u64,
    pub spend_pub: [u8; 32],
    pub pok: [u8; 64],
    pub view: [u8; 32],
    pub enc_key: [u8; 32],
    pub maker_enc_version: u32,
    pub key_hint: u8,
    pub approval_ix: Option<u8>,
    pub source: Source,
    pub sysvar: Option<Pubkey>,
    /// `(mint, taker_token, vault, token_program)`.
    pub token: Option<(Pubkey, Pubkey, Pubkey, Pubkey)>,
}

/// A transition call with its arguments.
#[derive(Clone, Debug)]
pub enum Call {
    Approve { open: [u8; 32], share: [u8; 32], pok: [u8; 64] },
    Fund { open: [u8; 32], share: [u8; 32], pok: [u8; 64], view: [u8; 32] },
    Reject { open: [u8; 32], reason: u8 },
    CancelPending,
    ExpirePending,
    PostNotice { commitment: [u8; 32], ct: [u8; 104] },
    SetReady,
    Abort,
    RefundUnnoticed,
    ExpireUnnoticed,
    Refund([u8; 32]),
    Claim([u8; 32]),
    ReleaseDeposit,
    Withhold(Option<([u8; 32], [u8; 32])>),
    SplitDeposit,
    PublishEvidence([u8; 32], [u8; 32]),
    WithdrawOwed(u8),
    CloseSwap,
}
impl Call {
    pub fn name(&self) -> &'static str {
        match self {
            Call::Approve { .. } => "approve",
            Call::Fund { .. } => "fund",
            Call::Reject { .. } => "reject",
            Call::CancelPending => "cancel_pending",
            Call::ExpirePending => "expire_pending",
            Call::PostNotice { .. } => "post_notice",
            Call::SetReady => "set_ready",
            Call::Abort => "abort",
            Call::RefundUnnoticed => "refund_unnoticed",
            Call::ExpireUnnoticed => "expire_unnoticed",
            Call::Refund(_) => "refund",
            Call::Claim(_) => "claim",
            Call::ReleaseDeposit => "release_deposit",
            Call::Withhold(_) => "withhold",
            Call::SplitDeposit => "split_deposit",
            Call::PublishEvidence(..) => "publish_evidence",
            Call::WithdrawOwed(_) => "withdraw_owed",
            Call::CloseSwap => "close_swap",
        }
    }
}

/// One LiteSVM with the program loaded and initialised, a USDC stand-in and a treasury.
pub struct World {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub treasury_authority: Keypair,
    pub issuer: Keypair,
    pub stranger: Keypair,
    pub mint: Pubkey,
    pub config: Pubkey,
    pub treasury: Pubkey,
    pub treasury_vault: Pubkey,
    pub cluster_tag: [u8; 32],
    /// Accounts temporarily replaced by `set_can_receive_sol`.
    pub stash: HashMap<Pubkey, solana_account::Account>,
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &PROGRAM_ID).0
}
pub fn ata_of(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[wallet.as_ref(), TOKEN.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}
pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[PROGRAM_ID.as_ref()], &LOADER_V3).0
}

/// A LiteSVM with the program loaded, mainnet's rent and a set clock; nothing initialised.
pub fn base_svm() -> LiteSVM {
    // LiteSVM::new(): mainnet-beta's feature set, builtins, sysvars, SPL Token and ATA programs,
    // signature verification on, and (feature `precompiles`) the Ed25519 precompile.
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM_ID, SO).expect("build first: (cd ../program && cargo build-sbf)");
    // Mainnet's Rent sysvar reads 5,080 lamports per byte; the crates default to 6,960.
    svm.set_sysvar(&solana_rent::Rent::with_lamports_per_byte(5_080));
    // A fresh LiteSVM starts at unix_timestamp = 0.
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = 300_000_000;
    clock.unix_timestamp = T0;
    svm.set_sysvar(&clock);
    svm
}

pub fn funded(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), lamports).unwrap(); // in-process only
    kp
}

/// LiteSVM writes ProgramData with no upgrade authority; tests of `initialize` set one.
pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: Option<&Pubkey>) {
    let address = program_data_address();
    let mut acc = svm.get_account(&address).expect("ProgramData account");
    assert_eq!(acc.data[..4], [3, 0, 0, 0], "UpgradeableLoaderState::ProgramData");
    match authority {
        Some(a) => {
            acc.data[12] = 1;
            acc.data[13..45].copy_from_slice(a.as_ref());
        }
        None => {
            acc.data[12] = 0;
            acc.data[13..45].fill(0);
        }
    }
    svm.set_account(address, acc).unwrap();
}

pub fn initialize_ix(authority: &Pubkey, mint: &Pubkey, cluster_tag: &[u8; 32], treasury_authority: &Pubkey, split_mode: u8) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            meta(*authority, true, true),
            meta(pda(&[b"config"]), false, true),
            meta(pda(&[b"treasury"]), false, true),
            meta(*mint, false, false),
            meta(pda(&[b"treasury_vault", mint.as_ref()]), false, true),
            meta(PROGRAM_ID, false, false),
            meta(program_data_address(), false, false),
            meta(TOKEN, false, false),
            meta(SYSTEM, false, false),
        ],
        data: Enc::ix("initialize").bytes(cluster_tag).key(treasury_authority).u8(split_mode).0,
    }
}

impl World {
    pub fn new() -> Self {
        Self::with(sha256(&[b"test cluster"]), 0)
    }

    pub fn with(cluster_tag: [u8; 32], split_mode: u8) -> Self {
        let mut svm = base_svm();
        let admin = funded(&mut svm, 100 * SOL);
        let treasury_authority = funded(&mut svm, 100 * SOL);
        let issuer = funded(&mut svm, 100 * SOL);
        let stranger = funded(&mut svm, 100 * SOL);
        let issuer_key = issuer.pubkey();
        let mint = CreateMint::new(&mut svm, &issuer).decimals(6).freeze_authority(&issuer_key).send().unwrap();
        set_upgrade_authority(&mut svm, Some(&admin.pubkey()));
        let ix = initialize_ix(&admin.pubkey(), &mint, &cluster_tag, &treasury_authority.pubkey(), split_mode);
        let mut w = World {
            svm,
            admin,
            treasury_authority,
            issuer,
            stranger,
            mint,
            config: pda(&[b"config"]),
            treasury: pda(&[b"treasury"]),
            treasury_vault: pda(&[b"treasury_vault", mint.as_ref()]),
            cluster_tag,
            stash: HashMap::new(),
        };
        let admin = w.admin.insecure_clone();
        ok(w.send(&[ix], &[&admin]));
        w
    }

    // ---- time, transactions, balances

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    pub fn set_time(&mut self, t: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = t;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }
    pub fn warp(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    /// The first signer pays the fee. A fresh blockhash per transaction: a byte-identical retry
    /// would otherwise be rejected.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let msg = Message::new(ixs, Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn fund(&mut self, lamports: u64) -> Keypair {
        funded(&mut self.svm, lamports)
    }
    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }
    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).map(|a| a.lamports > 0).unwrap_or(false)
    }
    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }
    pub fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.svm.get_account(key).map(|a| a.data).unwrap_or_default()
    }

    // ---- tokens

    pub fn ata(&self, wallet: &Pubkey) -> Pubkey {
        ata_of(wallet, &self.mint)
    }
    pub fn make_ata(&mut self, wallet: &Pubkey) -> Pubkey {
        let address = self.ata(wallet);
        if !self.exists(&address) {
            let issuer = self.issuer.insecure_clone();
            let mint = self.mint;
            CreateAssociatedTokenAccount::new(&mut self.svm, &issuer, &mint).owner(wallet).send().unwrap();
        }
        address
    }
    pub fn mint_to(&mut self, wallet: &Pubkey, amount: u64) -> Pubkey {
        let address = self.make_ata(wallet);
        let issuer = self.issuer.insecure_clone();
        let mint = self.mint;
        MintTo::new(&mut self.svm, &issuer, &mint, &address, amount).send().unwrap();
        address
    }
    /// Token balance of a token account; 0 if it does not exist.
    pub fn tokens(&self, token_account: &Pubkey) -> u64 {
        match self.svm.get_account(token_account) {
            Some(a) if a.owner == TOKEN && a.data.len() == 165 => u64_at(&a.data, 64),
            _ => 0,
        }
    }
    /// Freeze or thaw a token account by its state byte (what the mint's freeze authority does).
    pub fn set_frozen(&mut self, token_account: &Pubkey, frozen: bool) {
        let mut acc = self.svm.get_account(token_account).expect("token account");
        assert!(acc.owner == TOKEN && acc.data.len() == 165);
        acc.data[108] = if frozen { 2 } else { 1 };
        self.svm.set_account(*token_account, acc).unwrap();
    }
    /// Make an account unable (or able again) to receive lamports under the program's
    /// pay-or-park rule by turning it into an executable account, the way a payout address that
    /// is really a program would look. The original account is put back when `can` is true.
    pub fn set_can_receive_sol(&mut self, key: &Pubkey, can: bool) {
        match (can, self.stash.contains_key(key)) {
            (false, false) => {
                let original = self.svm.get_account(key).expect("account");
                let stand_in = solana_account::Account {
                    lamports: original.lamports,
                    data: vec![],
                    owner: NATIVE_LOADER,
                    executable: true,
                    rent_epoch: 0,
                };
                self.stash.insert(*key, original);
                self.svm.set_account(*key, stand_in).unwrap();
            }
            (true, true) => {
                let original = self.stash.remove(key).unwrap();
                self.svm.set_account(*key, original).unwrap();
            }
            _ => {}
        }
    }

    // ---- account views

    pub fn swap(&self, key: &Pubkey) -> Option<SwapAcc> {
        let acc = self.svm.get_account(key)?;
        if acc.owner != PROGRAM_ID || acc.data.is_empty() {
            return None;
        }
        Some(SwapAcc::decode(&acc.data))
    }
    pub fn maker(&self, key: &Pubkey) -> MakerAcc {
        MakerAcc::decode(&self.data(key))
    }
    pub fn offer(&self, key: &Pubkey) -> OfferAcc {
        OfferAcc::decode(&self.data(key))
    }
    pub fn patch(&mut self, key: &Pubkey, f: impl FnOnce(&mut Vec<u8>)) {
        let mut acc = self.svm.get_account(key).expect("account");
        f(&mut acc.data);
        self.svm.set_account(*key, acc).unwrap();
    }
    pub fn offer_pda(&self, maker: &Pubkey, asset: u8, direction: u8) -> Pubkey {
        pda(&[b"offer", maker.as_ref(), &[asset], &[direction]])
    }

    // ---- registry

    pub fn register_maker(&mut self) -> MakerFx {
        let operator = self.fund(1_000 * SOL);
        self.register_maker_with(operator)
    }
    pub fn register_maker_with(&mut self, operator: Keypair) -> MakerFx {
        let owner = self.fund(100 * SOL);
        let payout = self.fund(SOL);
        let enc_key = rand32();
        let maker = pda(&[b"maker", owner.pubkey().as_ref()]);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![meta(owner.pubkey(), true, true), meta(maker, false, true), meta(SYSTEM, false, false)],
            data: Enc::ix("register_maker").key(&operator.pubkey()).key(&payout.pubkey()).bytes(&enc_key).0,
        };
        ok(self.send(&[ix], &[&owner]));
        // Token destinations exist unless a test removes or freezes them.
        self.mint_to(&operator.pubkey(), 1_000_000_000_000);
        self.make_ata(&payout.pubkey());
        MakerFx { owner, operator, payout, pda: maker, enc_key, shares: HashMap::new() }
    }

    /// An instruction on the two-account lists `(signer, maker)` of the maker setters.
    pub fn maker_ix(&self, signer: &Pubkey, maker: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![meta(*signer, true, false), meta(*maker, false, true)],
            data,
        }
    }
    pub fn bump_epochs(&mut self, m: &MakerFx, approvals: bool, quotes: bool) -> TxResult {
        let ix = self.maker_ix(&m.operator.pubkey(), &m.pda, Enc::ix("bump_epochs").bool(approvals).bool(quotes).0);
        self.send(&[ix], &[&m.operator])
    }

    pub fn set_offer_ix(&self, m: &MakerFx, asset: u8, direction: u8, terms: &Terms) -> Instruction {
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                meta(m.operator.pubkey(), true, true),
                meta(m.pda, false, false),
                meta(self.offer_pda(&m.pda, asset, direction), false, true),
                meta(SYSTEM, false, false),
            ],
            data: terms.encode(Enc::ix("set_offer").u8(asset).u8(direction)).0,
        }
    }
    pub fn set_offer(&mut self, m: &MakerFx, asset: u8, direction: u8, terms: &Terms) -> TxResult {
        let ix = self.set_offer_ix(m, asset, direction, terms);
        self.send(&[ix], &[&m.operator])
    }

    /// `offers`: `(asset, direction, enabled, prices, capacity_xmr)`.
    pub fn refresh_ix(&self, m: &MakerFx, offers: &[(u8, u8, bool, [u64; 3], u64)]) -> Instruction {
        let mut e = Enc::ix("refresh_offers").u32(offers.len() as u32);
        let mut accounts = vec![meta(m.operator.pubkey(), true, false), meta(m.pda, false, false), opt(None, true)];
        for (asset, direction, enabled, prices, capacity) in offers {
            e = e.u8(*asset).u8(*direction).bool(*enabled);
            for p in prices {
                e = e.u64(*p);
            }
            e = e.u64(*capacity);
            accounts.push(meta(self.offer_pda(&m.pda, *asset, *direction), false, true));
        }
        Instruction { program_id: PROGRAM_ID, accounts, data: e.u32(0).0 }
    }
    pub fn refresh(&mut self, m: &MakerFx, offers: &[(u8, u8, bool, [u64; 3], u64)]) -> TxResult {
        let ix = self.refresh_ix(m, offers);
        self.send(&[ix], &[&m.operator])
    }

    /// `slots`: `(index, share, pok)`.
    pub fn refill_ix(&self, m: &MakerFx, asset: u8, slots: &[(u8, [u8; 32], [u8; 64])]) -> Instruction {
        let mut e = Enc::ix("refill_keys").u8(asset).u32(slots.len() as u32);
        for (index, share, pok) in slots {
            e = e.u8(*index).bytes(share).bytes(pok);
        }
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                meta(m.operator.pubkey(), true, false),
                meta(m.pda, false, false),
                meta(self.offer_pda(&m.pda, asset, DIR_A), false, true),
            ],
            data: e.0,
        }
    }
    /// Publish `n` fresh shares into slots `first..first + n`.
    pub fn refill(&mut self, m: &mut MakerFx, asset: u8, first: u8, n: u8) -> TxResult {
        let slots: Vec<_> = (0..n)
            .map(|i| {
                let (_, s_pub, pok) = m.new_share();
                (first + i, s_pub, pok)
            })
            .collect();
        let ix = self.refill_ix(m, asset, &slots);
        self.send(&[ix], &[&m.operator])
    }

    /// A live offer: `set_offer`, `refresh_offers` with one price tier, and (direction A) two
    /// pool keys.
    pub fn live_offer(&mut self, m: &mut MakerFx, asset: u8, direction: u8, terms: &Terms, price: u64) -> Pubkey {
        ok(self.set_offer(m, asset, direction, terms));
        ok(self.refresh(m, &[(asset, direction, true, [price, 0, 0], 1_000_000 * XMR)]));
        if direction == DIR_A {
            ok(self.refill(m, asset, 0, 2));
        }
        self.offer_pda(&m.pda, asset, direction)
    }

    /// Write a live offer account directly (terms that `set_offer` refuses), with two pool keys.
    pub fn craft_offer(&mut self, m: &mut MakerFx, asset: u8, direction: u8, t: &Terms, price: u64) -> Pubkey {
        let w = self;
        let key = w.offer_pda(&m.pda, asset, direction);
        let bump = Pubkey::find_program_address(&[b"offer", m.pda.as_ref(), &[asset], &[direction]], &PROGRAM_ID).1;
        let mut e = Enc(account_disc("Offer").to_vec())
            .key(&m.pda)
            .u8(asset)
            .u8(direction)
            .u8(1) // enabled
            .u8(t.mode)
            .u8(bump)
            .u64(2) // seq
            .i64(w.now()) // updated_at
            .u32(t.valid_secs)
            .u64(t.min_xmr)
            .u64(t.max_xmr)
            .u64(1_000_000 * XMR); // capacity
        for v in t.price_above {
            e = e.u64(v);
        }
        for v in [price, 0, 0] {
            e = e.u64(v);
        }
        for v in t.depth_above {
            e = e.u64(v);
        }
        e = e.bytes(&t.depths).u16(t.dep_bps).u32(t.w_a).u32(t.w_n).u32(t.d_c).u32(t.w_c).u32(t.w_f);
        e = e.bytes(&t.hash(asset, direction)).u16(0b11).u16(0);
        for i in 0..16 {
            if i < 2 {
                let (_, s_pub, _) = m.new_share();
                e = e.bytes(&s_pub);
            } else {
                e = e.bytes(&[0; 32]);
            }
        }
        let mut data = e.0;
        data.resize(768, 0);
        let lamports = w.rent(768);
        w.svm
            .set_account(key, solana_account::Account { lamports, data, owner: PROGRAM_ID, executable: false, rent_epoch: 0 })
            .unwrap();
        key
    }

    /// Run a transaction without committing it: what would happen at this instant.
    pub fn simulate(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let msg = Message::new(ixs, Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm.simulate_transaction(tx).map(|info| info.meta)
    }
    /// Whether `call` by `signer` would succeed right now; nothing is committed.
    pub fn would(&mut self, m: &MakerFx, fx: &SwapFx, call: &Call, signer: &Keypair) -> TxResult {
        let ix = self.call_ix(m, fx, call, &signer.pubkey());
        self.simulate(&[ix], &[signer])
    }

    /// Write a token account's balance directly (amounts no mint authority would issue).
    pub fn set_tokens(&mut self, token_account: &Pubkey, amount: u64) {
        self.patch(token_account, |d| d[64..72].copy_from_slice(&amount.to_le_bytes()));
    }

    /// `post_quote`. Returns the quote PDA.
    #[allow(clippy::too_many_arguments)]
    pub fn post_quote_ix(
        &self,
        m: &MakerFx,
        quote_id: u64,
        taker: &Pubkey,
        asset: u8,
        direction: u8,
        xmr: u64,
        amount: u64,
        terms: &Terms,
        share: &[u8; 32],
        pok: &[u8; 64],
        expires_at: i64,
    ) -> (Instruction, Pubkey) {
        let quote = pda(&[b"quote", m.pda.as_ref(), &quote_id.to_le_bytes()]);
        let data = Enc::ix("post_quote")
            .u64(quote_id)
            .key(taker)
            .u8(asset)
            .u8(direction)
            .u8(terms.depths[0])
            .u64(xmr)
            .u64(amount)
            .u16(terms.dep_bps)
            .u32(terms.w_n)
            .u32(terms.d_c)
            .u32(terms.w_c)
            .u32(terms.w_f)
            .bytes(share)
            .bytes(pok)
            .i64(expires_at)
            .0;
        (
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    meta(m.operator.pubkey(), true, true),
                    meta(m.pda, false, false),
                    meta(quote, false, true),
                    meta(SYSTEM, false, false),
                ],
                data,
            },
            quote,
        )
    }

    // ---- opening a swap

    pub fn open_ix(&self, r: &OpenRaw) -> Instruction {
        let (offer, quote, receiver) = match r.source {
            Source::Offer(o) => (Some(o), None, None),
            Source::Quote(q, rx) => (None, Some(q), Some(rx)),
        };
        let (mint, taker_token, vault, token_program) = match r.token {
            Some((a, b, c, d)) => (Some(a), Some(b), Some(c), Some(d)),
            None => (None, None, None, None),
        };
        let accounts = vec![
            meta(r.taker, r.taker_signs, true),
            meta(r.swap, false, true),
            meta(r.maker, false, true),
            meta(self.config, false, false),
            meta(r.session, false, true),
            meta(SYSTEM, false, false),
            opt(offer, true),
            opt(quote, true),
            opt(receiver, true),
            opt(r.sysvar, false),
            opt(mint, false),
            opt(taker_token, true),
            opt(vault, true),
            opt(token_program, false),
        ];
        let e = if r.direction == DIR_A { Enc::ix("lock") } else { Enc::ix("take") };
        let mut e = e
            .bytes(&r.nonce)
            .u64(r.session_lamports)
            .u8(r.asset)
            .u64(r.xmr)
            .u64(r.limit)
            .bytes(&r.terms_hash)
            .u64(r.min_seq)
            .bytes(&r.spend_pub)
            .bytes(&r.pok);
        if r.direction == DIR_A {
            e = e.bytes(&r.view);
        }
        e = e.bytes(&r.enc_key).u32(r.maker_enc_version);
        if r.direction == DIR_A {
            e = e.u8(r.key_hint);
        }
        Instruction { program_id: PROGRAM_ID, accounts, data: e.opt_u8(r.approval_ix).0 }
    }

    /// A fresh, funded taker and a well-formed lock or take against `source`; nothing is sent.
    pub fn prepare_open(&mut self, m: &MakerFx, asset: u8, direction: u8, xmr: u64, source: Source) -> (SwapFx, OpenRaw) {
        let taker = self.fund(1_000 * SOL);
        if asset == ASSET_USDC {
            self.mint_to(&taker.pubkey(), 1_000_000_000_000);
        }
        self.prepare_open_for(m, taker, asset, direction, xmr, source, rand16())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_open_for(
        &mut self,
        m: &MakerFx,
        taker: Keypair,
        asset: u8,
        direction: u8,
        xmr: u64,
        source: Source,
        nonce: [u8; 16],
    ) -> (SwapFx, OpenRaw) {
        let session = Keypair::new();
        let swap = pda(&[b"swap", taker.pubkey().as_ref(), &nonce]);
        let vault = pda(&[b"vault", swap.as_ref()]);
        let (s_t, s_pub_t) = new_share();
        let view_t = new_view();
        let enc_key = rand32();
        let terms_hash = match source {
            Source::Offer(o) if self.exists(&o) => self.offer(&o).terms_hash,
            _ => [0; 32],
        };
        let raw = OpenRaw {
            direction,
            taker: taker.pubkey(),
            taker_signs: true,
            maker: m.pda,
            nonce,
            swap,
            session: session.pubkey(),
            session_lamports: self.rent(0) + 2_000_000,
            asset,
            xmr,
            limit: if direction == DIR_A { u64::MAX } else { 0 },
            terms_hash,
            min_seq: 0,
            spend_pub: s_pub_t,
            pok: pok_prove(&s_t, &swap.to_bytes()),
            view: view_t,
            enc_key,
            maker_enc_version: self.maker(&m.pda).enc_key_version,
            key_hint: 0,
            approval_ix: None,
            source,
            sysvar: None,
            token: (asset == ASSET_USDC).then(|| (self.mint, self.ata(&taker.pubkey()), vault, TOKEN)),
        };
        let fx = SwapFx {
            taker,
            session,
            nonce,
            pda: swap,
            vault,
            asset,
            direction,
            xmr,
            s_t,
            s_pub_t,
            view_t,
            enc_key,
            notice: None,
        };
        (fx, raw)
    }

    pub fn send_open(&mut self, fx: &SwapFx, raw: &OpenRaw) -> TxResult {
        let ix = self.open_ix(raw);
        self.send(&[ix], &[&fx.taker])
    }

    /// Lock or take against the maker's live offer for `(asset, direction)`.
    pub fn open(&mut self, m: &MakerFx, asset: u8, direction: u8, xmr: u64) -> SwapFx {
        let offer = self.offer_pda(&m.pda, asset, direction);
        let (fx, raw) = self.prepare_open(m, asset, direction, xmr, Source::Offer(offer));
        ok(self.send_open(&fx, &raw));
        fx
    }

    /// An advance approval for `taker`, signed by the maker's operator, valid now.
    pub fn approval_ix(&self, m: &MakerFx, taker: &Pubkey, asset: u8, direction: u8, max_xmr: u64) -> Instruction {
        let fields = ApprovalFields {
            cluster_tag: self.cluster_tag,
            program_id: PROGRAM_ID.to_bytes(),
            maker: m.pda.to_bytes(),
            taker: taker.to_bytes(),
            asset,
            direction,
            max_xmr,
            not_before: self.now() - 10,
            expires_at: self.now() + 3_600,
            epoch: self.maker(&m.pda).approval_epoch,
            approval_id: 1,
        };
        ed25519_ix(&m.operator, &encode_approval(&fields))
    }

    // ---- transitions

    /// The instruction for `call` with the default accounts: the taker stored in the swap, the
    /// maker's payout wallet for a claim and its operator otherwise, the Treasury PDA, and for
    /// USDC the matching associated token accounts.
    pub fn call_ix(&self, m: &MakerFx, fx: &SwapFx, call: &Call, caller: &Pubkey) -> Instruction {
        let short = |data: Vec<u8>| Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                meta(*caller, true, true),
                meta(fx.pda, false, true),
                meta(m.pda, false, true),
                meta(self.config, false, false),
            ],
            data,
        };
        let usdc = fx.asset == ASSET_USDC;
        let settle = |data: Vec<u8>, maker_wallet: Pubkey| Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                meta(*caller, true, true),
                meta(fx.pda, false, true),
                meta(m.pda, false, true),
                meta(self.config, false, false),
                meta(fx.taker.pubkey(), false, true),
                meta(maker_wallet, false, true),
                meta(self.treasury, false, true),
                meta(SYSTEM, false, false),
                opt(usdc.then_some(self.mint), true),
                opt(usdc.then_some(fx.vault), true),
                opt(usdc.then(|| self.ata(&fx.taker.pubkey())), true),
                opt(usdc.then(|| self.ata(&maker_wallet)), true),
                opt(usdc.then_some(self.treasury_vault), true),
                opt(usdc.then_some(TOKEN), false),
            ],
            data,
        };
        let operator = m.operator.pubkey();
        let payout = m.payout.pubkey();
        let name = call.name();
        match call {
            Call::Approve { open, share, pok } => Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    meta(*caller, true, false),
                    meta(fx.pda, false, true),
                    meta(m.pda, false, true),
                    meta(self.config, false, false),
                ],
                data: Enc::ix(name).bytes(open).bytes(share).bytes(pok).0,
            },
            Call::Fund { open, share, pok, view } => Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    meta(*caller, true, true),
                    meta(fx.pda, false, true),
                    meta(m.pda, false, true),
                    meta(self.config, false, false),
                    meta(SYSTEM, false, false),
                    opt(usdc.then_some(self.mint), false),
                    opt(usdc.then(|| self.ata(caller)), true),
                    opt(usdc.then_some(fx.vault), true),
                    opt(usdc.then_some(TOKEN), false),
                ],
                data: Enc::ix(name).bytes(open).bytes(share).bytes(pok).bytes(view).0,
            },
            Call::Reject { open, reason } => settle(Enc::ix(name).bytes(open).u8(*reason).0, operator),
            Call::PostNotice { commitment, ct } => short(Enc::ix(name).bytes(commitment).bytes(ct).0),
            Call::SetReady => short(Enc::ix(name).0),
            Call::Withhold(None) => short(Enc::ix(name).u8(0).0),
            Call::Withhold(Some((txid, view))) => short(Enc::ix(name).u8(1).bytes(txid).bytes(view).0),
            Call::PublishEvidence(txid, view) => short(Enc::ix(name).bytes(txid).bytes(view).0),
            Call::Refund(secret) => settle(Enc::ix(name).bytes(secret).0, operator),
            Call::Claim(secret) => settle(Enc::ix(name).bytes(secret).0, payout),
            // A parked maker payout is pulled to the payout wallet in these tests.
            Call::WithdrawOwed(who) => settle(Enc::ix(name).u8(*who).0, payout),
            _ => settle(Enc::ix(name).0, operator),
        }
    }

    pub fn call(&mut self, m: &MakerFx, fx: &SwapFx, call: &Call, signer: &Keypair) -> TxResult {
        let ix = self.call_ix(m, fx, call, &signer.pubkey());
        self.send(&[ix], &[signer])
    }

    /// `approve` with a fresh share and the swap's current open hash.
    pub fn approve(&mut self, m: &mut MakerFx, fx: &SwapFx) -> TxResult {
        let open = self.swap(&fx.pda).expect("swap").open_hash(&fx.pda);
        let (_, share, pok) = m.new_share();
        let op = m.operator.insecure_clone();
        self.call(m, fx, &Call::Approve { open, share, pok }, &op)
    }
    /// `fund` with a fresh share and view share and the swap's current open hash.
    pub fn fund_swap(&mut self, m: &mut MakerFx, fx: &SwapFx) -> TxResult {
        let open = self.swap(&fx.pda).expect("swap").open_hash(&fx.pda);
        let (_, share, pok) = m.new_share();
        let op = m.operator.insecure_clone();
        self.call(m, fx, &Call::Fund { open, share, pok, view: new_view() }, &op)
    }
    /// `post_notice` by the claimer (A: operator; B: the session key) with a fresh opening.
    pub fn notice(&mut self, m: &MakerFx, fx: &mut SwapFx) -> TxResult {
        let (txid, view) = (rand32(), new_view());
        fx.notice = Some((txid, view));
        let mut ct = [0u8; 104];
        rand::thread_rng().fill_bytes(&mut ct);
        let call = Call::PostNotice { commitment: notice_commitment(&fx.pda, &txid, &view), ct };
        let signer = if fx.direction == DIR_A { m.operator.insecure_clone() } else { fx.session.insecure_clone() };
        self.call(m, fx, &call, &signer)
    }
    /// `set_ready` by the locker (A: the session key; B: operator).
    pub fn ready(&mut self, m: &MakerFx, fx: &SwapFx) -> TxResult {
        let signer = if fx.direction == DIR_A { fx.session.insecure_clone() } else { m.operator.insecure_clone() };
        self.call(m, fx, &Call::SetReady, &signer)
    }
    /// The maker's spend share for this swap (the test published it).
    pub fn maker_secret(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32] {
        m.secret_for(&self.swap(&fx.pda).expect("swap").maker_spend_pub)
    }
    /// The locker's secret: A the taker's share, B the maker's.
    pub fn locker_secret(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32] {
        if fx.direction == DIR_A {
            fx.s_t
        } else {
            self.maker_secret(m, fx)
        }
    }
    /// The claimer's secret: A the maker's share, B the taker's.
    pub fn claimer_secret(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32] {
        if fx.direction == DIR_A {
            self.maker_secret(m, fx)
        } else {
            fx.s_t
        }
    }
}

/// Serialised size of a legacy transaction: signatures (1 + 64 each) + message.
pub fn tx_size(ixs: &[Instruction], payer: &Pubkey, signatures: usize) -> usize {
    let msg = Message::new(ixs, Some(payer));
    assert_eq!(msg.header.num_required_signatures as usize, signatures, "signer count");
    1 + 64 * signatures + msg.serialize().len()
}
/// The two compute-budget instructions the SDK always adds (SPEC 4.10).
pub fn compute_budget_ixs() -> [Instruction; 2] {
    let mut limit = vec![2u8];
    limit.extend_from_slice(&200_000u32.to_le_bytes());
    let mut price = vec![3u8];
    price.extend_from_slice(&1_000u64.to_le_bytes());
    [
        Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: limit },
        Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: price },
    ]
}

/// How far to drive a fresh swap.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Stage {
    /// As opened: PENDING for a window-mode lock and for every take, ACTIVE otherwise.
    Opened,
    Active,
    Noticed,
    Ready,
}

/// The price the vectors use: 1.5 SOL (or 1,500 USDC) per XMR, so 1 XMR is 1,500,000,000 units.
pub const PRICE: u64 = 1_500_000_000;

impl World {
    /// A registered maker with a live offer and a 1 XMR swap driven to `stage`: approved or
    /// funded 12 s after the open, noticed 90 s later, ready `depth × 60` s after the notice.
    pub fn swap_at(&mut self, asset: u8, direction: u8, terms: &Terms, stage: Stage) -> (MakerFx, SwapFx) {
        let mut m = self.register_maker();
        let fx = self.swap_with(&mut m, asset, direction, terms, stage);
        (m, fx)
    }

    pub fn swap_with(&mut self, m: &mut MakerFx, asset: u8, direction: u8, terms: &Terms, stage: Stage) -> SwapFx {
        self.live_offer(m, asset, direction, terms, PRICE);
        let mut fx = self.open(m, asset, direction, XMR);
        if stage == Stage::Opened {
            return fx;
        }
        if self.swap(&fx.pda).unwrap().state == PENDING {
            self.warp(12);
            if direction == DIR_A {
                ok(self.approve(m, &fx));
            } else {
                ok(self.fund_swap(m, &fx));
            }
        }
        if stage == Stage::Active {
            return fx;
        }
        self.warp(90);
        ok(self.notice(m, &mut fx));
        if stage == Stage::Noticed {
            return fx;
        }
        self.warp(terms.depths[0] as i64 * 60);
        ok(self.ready(m, &fx));
        fx
    }
}

// ------------------------------------------------------------------ who received what

/// Asset units received by each party between a snapshot and now, with transaction fees and
/// account rent taken out (SOL), so a test states only what the protocol moved.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Moved {
    pub taker: i128,
    /// The maker's payout wallet (direction-A claims).
    pub payout: i128,
    /// The maker's operator wallet (direction-B refunds, and `fund`).
    pub operator: i128,
    pub treasury: i128,
}
impl Moved {
    pub fn taker(amount: u64) -> Self {
        Moved { taker: amount as i128, ..Moved::default() }
    }
}

pub struct Ledger {
    asset: u8,
    keys: [Pubkey; 6],
    before: [i128; 6],
    swap_rent: i128,
}

impl World {
    fn ledger_read(&self, asset: u8, keys: &[Pubkey; 6]) -> [i128; 6] {
        let mut out = [0i128; 6];
        for (i, k) in keys.iter().enumerate() {
            out[i] = if asset == ASSET_USDC && i != 5 { self.tokens(k) as i128 } else { self.lamports(k) as i128 };
        }
        out
    }
    /// Snapshot the balances a swap can move.
    pub fn ledger(&self, m: &MakerFx, fx: &SwapFx) -> Ledger {
        let usdc = fx.asset == ASSET_USDC;
        let at = |wallet: &Pubkey| if usdc { self.ata(wallet) } else { *wallet };
        let keys = [
            at(&fx.taker.pubkey()),
            at(&m.payout.pubkey()),
            at(&m.operator.pubkey()),
            if usdc { self.treasury_vault } else { self.treasury },
            if usdc { fx.vault } else { fx.pda },
            // The session key's lamports count as the taker's (the sweep returns them).
            fx.session.pubkey(),
        ];
        Ledger { asset: fx.asset, keys, before: self.ledger_read(fx.asset, &keys), swap_rent: self.rent(736) as i128 }
    }
}

impl Ledger {
    /// What moved since the snapshot. `taker_fees` / `operator_fees`: transactions the taker (or
    /// its session key) and the operator paid for; `closed`: the swap account was closed (its
    /// rent returned to the taker). Asserts that exactly what left escrow reached the parties.
    #[track_caller]
    pub fn moved(&self, w: &World, taker_fees: u64, operator_fees: u64, closed: bool) -> Moved {
        let now = w.ledger_read(self.asset, &self.keys);
        let d: Vec<i128> = now.iter().zip(self.before.iter()).map(|(a, b)| a - b).collect();
        let moved = if self.asset == ASSET_USDC {
            Moved { taker: d[0], payout: d[1], operator: d[2], treasury: d[3] }
        } else {
            Moved {
                taker: d[0] + d[5] + (taker_fees * FEE) as i128 - if closed { self.swap_rent } else { 0 },
                payout: d[1],
                operator: d[2] + (operator_fees * FEE) as i128,
                treasury: d[3],
            }
        };
        let left_escrow = if self.asset == ASSET_SOL && closed { -(d[4] + self.swap_rent) } else { -d[4] };
        assert_eq!(
            left_escrow,
            moved.taker + moved.payout + moved.operator + moved.treasury,
            "what left escrow is what the parties received: {moved:?}"
        );
        moved
    }
}
