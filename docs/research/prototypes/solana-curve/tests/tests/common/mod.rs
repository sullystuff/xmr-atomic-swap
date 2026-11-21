//! In-process test harness (LiteSVM). No validator, no RPC.
//!
//! The test crate does NOT link the on-chain crate: Anchor 0.32 is on the
//! solana 2.x split crates while LiteSVM is on 3.x/4.x, so instructions are
//! encoded by hand (8-byte discriminator + borsh) against the built `.so`.
#![allow(dead_code)]

use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use sha2::{Digest, Sha256};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const PROGRAM_ID: Pubkey = pubkey!("HNZrgojMR8XBDsap8MPTgdznw5P1WzFi9k2yZND3JeCo");
pub const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
pub const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SOL: u64 = 1_000_000_000;
pub const FEE: u64 = 5_000; // lamports per signature
pub const MAINNET_LAMPORTS_PER_BYTE: u64 = 5_080;
const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../program/target/deploy/curve_check.so");

/// Anchor error codes: 6000 + index in `SwapError`.
pub const E_BAD_COMMITMENT: u32 = 6000;
pub const E_SCALAR_MISMATCH: u32 = 6001;
pub const E_UNAUTHORIZED: u32 = 6002;
pub const E_TOO_EARLY: u32 = 6003;
pub const E_NOT_READY: u32 = 6004;

pub fn setup() -> LiteSVM {
    // LiteSVM::new() = features active on mainnet-beta (litesvm's pinned list)
    // + builtins + sysvars + SPL Token / Token-2022 / ATA / Memo, sigverify on.
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM_ID, SO)
        .expect("build first: (cd ../program && cargo build-sbf)");
    // Mainnet-beta's Rent sysvar today (read 2026-11-21): 5,080 lamports/byte,
    // threshold 1.0. The crate default is still the old 6,960.
    svm.set_sysvar(&solana_rent::Rent::with_lamports_per_byte(MAINNET_LAMPORTS_PER_BYTE));
    // Start from a realistic clock; a fresh LiteSVM has unix_timestamp = 0.
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = 300_000_000;
    clock.unix_timestamp = 1_795_000_000;
    svm.set_sysvar(&clock);
    svm
}

pub fn funded(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), lamports).unwrap();
    kp
}

/// Advance wall-clock and slot together (400 ms slots).
pub fn warp_secs(svm: &mut LiteSVM, secs: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += secs;
    clock.slot += (secs as u64) * 5 / 2;
    svm.set_sysvar(&clock);
    svm.expire_blockhash(); // lets an identical tx be re-sent after the warp
}

pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// First signer pays the fee.
pub fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let msg = Message::new(ixs, Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    let res = svm.send_transaction(tx);
    // New blockhash per tx: otherwise re-sending a byte-identical tx (e.g. a
    // retry after a failed attempt) is rejected as AlreadyProcessed.
    svm.expire_blockhash();
    res
}

pub fn assert_custom_err(res: Result<TransactionMetadata, FailedTransactionMetadata>, code: u32) {
    let err = res.expect_err("transaction should have failed");
    let dbg = format!("{:?}", err.err);
    assert!(
        dbg.contains(&format!("Custom({code})")),
        "expected Custom({code}), got {dbg}\n{}",
        err.meta.pretty_logs()
    );
}

pub fn balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_balance(key).unwrap_or(0)
}

pub fn token_balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let acc = svm.get_account(token_account).expect("token account missing");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

pub fn exists(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key).map(|a| a.lamports > 0).unwrap_or(false)
}

// ---- anchor encoding -------------------------------------------------------

fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{namespace}:{name}"))[..8].try_into().unwrap()
}
pub fn ix_disc(name: &str) -> [u8; 8] {
    sighash("global", name)
}
pub fn account_disc(name: &str) -> [u8; 8] {
    sighash("account", name)
}
pub fn event_disc(name: &str) -> [u8; 8] {
    sighash("event", name)
}
/// sha256("anchor:event")[..8], little-endian: prefix of emit_cpi! instruction data.
pub const EVENT_IX_TAG_LE: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

pub fn ix(name: &str, args: &[&[u8]], accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = ix_disc(name).to_vec();
    for a in args {
        data.extend_from_slice(a);
    }
    Instruction { program_id: PROGRAM_ID, accounts, data }
}
pub fn borsh_vec(bytes: &[u8]) -> Vec<u8> {
    let mut v = (bytes.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(bytes);
    v
}
pub fn w(key: Pubkey, signer: bool) -> AccountMeta {
    AccountMeta::new(key, signer)
}
pub fn r(key: Pubkey, signer: bool) -> AccountMeta {
    AccountMeta::new_readonly(key, signer)
}

/// Events emitted with `emit!` ("Program data: <base64>" log lines).
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

/// "Program consumption: N units remaining" values, in order.
pub fn cu_marks(meta: &TransactionMetadata) -> Vec<u64> {
    meta.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program consumption: "))
        .filter_map(|l| l.split(' ').next()?.parse().ok())
        .collect()
}

// ---- keys ------------------------------------------------------------------

/// A Monero-style key share: canonical scalar s (LE, < l) and S = s·G.
pub fn key_share() -> ([u8; 32], [u8; 32]) {
    let s = Scalar::from_bytes_mod_order(rand::random::<[u8; 32]>());
    (s.to_bytes(), (s * ED25519_BASEPOINT_POINT).compress().to_bytes())
}

// ---- PDAs ------------------------------------------------------------------

pub fn commitment_pda(payer: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"commit", payer.as_ref()], &PROGRAM_ID).0
}
pub fn maker_pda(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"maker", owner.as_ref()], &PROGRAM_ID).0
}
pub fn swap_pda(taker: &Pubkey, swap_id: &[u8; 8]) -> Pubkey {
    Pubkey::find_program_address(&[b"swap", taker.as_ref(), swap_id], &PROGRAM_ID).0
}
pub fn vault_pda(swap: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", swap.as_ref()], &PROGRAM_ID).0
}
pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &PROGRAM_ID).0
}

// ---- instruction builders --------------------------------------------------

pub fn commit_ix(name: &str, payer: &Pubkey, point: &[u8; 32]) -> Instruction {
    ix(name, &[point], vec![w(*payer, true), w(commitment_pda(payer), false), r(SYSTEM, false)])
}
pub fn reveal_ix(payer: &Pubkey, scalar: &[u8; 32]) -> Instruction {
    ix("reveal", &[scalar], vec![w(*payer, true), w(commitment_pda(payer), false)])
}

pub struct Lock {
    pub swap_id: [u8; 8],
    pub maker: Pubkey,
    pub session_key: Pubkey,
    pub amount: u64,
    pub maker_point: [u8; 32],
    pub taker_point: [u8; 32],
    pub refund_after: i64,
    pub session_lamports: u64,
}
impl Lock {
    fn encode(&self) -> Vec<u8> {
        let mut d = self.swap_id.to_vec();
        d.extend_from_slice(self.maker.as_ref());
        d.extend_from_slice(self.session_key.as_ref());
        d.extend_from_slice(&self.amount.to_le_bytes());
        d.extend_from_slice(&self.maker_point);
        d.extend_from_slice(&self.taker_point);
        d.extend_from_slice(&self.refund_after.to_le_bytes());
        d.extend_from_slice(&self.session_lamports.to_le_bytes());
        d
    }
}

pub fn lock_sol_ix(taker: &Pubkey, l: &Lock) -> Instruction {
    ix(
        "lock_sol",
        &[&l.encode()],
        vec![
            w(*taker, true),
            w(swap_pda(taker, &l.swap_id), false),
            w(l.session_key, false),
            r(SYSTEM, false),
        ],
    )
}
pub fn lock_token_ix(taker: &Pubkey, mint: &Pubkey, taker_token: &Pubkey, l: &Lock) -> Instruction {
    let swap = swap_pda(taker, &l.swap_id);
    ix(
        "lock_token",
        &[&l.encode()],
        vec![
            w(*taker, true),
            w(swap, false),
            r(*mint, false),
            w(*taker_token, false),
            w(vault_pda(&swap), false),
            w(l.session_key, false),
            r(TOKEN, false),
            r(SYSTEM, false),
        ],
    )
}
pub fn set_ready_ix(authority: &Pubkey, swap: &Pubkey) -> Instruction {
    ix("set_ready", &[], vec![r(*authority, true), w(*swap, false)])
}
pub fn claim_sol_ix(maker: &Pubkey, taker: &Pubkey, swap: &Pubkey, scalar: &[u8; 32]) -> Instruction {
    ix("claim_sol", &[scalar], vec![w(*maker, true), w(*taker, false), w(*swap, false)])
}
pub fn refund_sol_ix(authority: &Pubkey, taker: &Pubkey, swap: &Pubkey, scalar: &[u8; 32]) -> Instruction {
    ix(
        "refund_sol",
        &[scalar],
        vec![w(*authority, true), w(*taker, false), w(*swap, false), r(SYSTEM, false)],
    )
}
pub fn claim_token_ix(
    maker: &Pubkey,
    taker: &Pubkey,
    swap: &Pubkey,
    mint: &Pubkey,
    maker_token: &Pubkey,
    scalar: &[u8; 32],
) -> Instruction {
    ix(
        "claim_token",
        &[scalar],
        vec![
            w(*maker, true),
            w(*taker, false),
            w(*swap, false),
            r(*mint, false),
            w(vault_pda(swap), false),
            w(*maker_token, false),
            r(TOKEN, false),
        ],
    )
}
pub fn refund_token_ix(
    authority: &Pubkey,
    taker: &Pubkey,
    swap: &Pubkey,
    mint: &Pubkey,
    taker_token: &Pubkey,
    scalar: &[u8; 32],
) -> Instruction {
    ix(
        "refund_token",
        &[scalar],
        vec![
            w(*authority, true),
            w(*taker, false),
            w(*swap, false),
            r(*mint, false),
            w(vault_pda(swap), false),
            w(*taker_token, false),
            r(TOKEN, false),
            r(SYSTEM, false),
        ],
    )
}
