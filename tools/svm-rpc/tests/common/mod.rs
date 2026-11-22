#![allow(dead_code)]

use {
    base64::{engine::general_purpose::STANDARD as B64, Engine},
    serde_json::{json, Value},
    solana_hash::Hash,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage},
    solana_pubkey::Pubkey,
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, Transaction},
    std::str::FromStr,
    svm_rpc::Facade,
};

pub const SOL: u64 = 1_000_000_000;
pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const MEMO_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/memo.so");

pub fn key(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

/// A successful call; panics with the RPC error otherwise.
pub fn rpc(f: &mut Facade, method: &str, params: Value) -> Value {
    f.call(method, &params).unwrap_or_else(|e| panic!("{method} failed: {} {:?}", e.message, e.data))
}

/// A failing call; returns `(code, message, data)`.
pub fn rpc_err(f: &mut Facade, method: &str, params: Value) -> (i64, String, Value) {
    let e = f.call(method, &params).expect_err("call should have failed");
    (e.code, e.message, e.data.unwrap_or(Value::Null))
}

pub fn funded(f: &mut Facade, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    rpc(f, "svm_airdrop", json!([kp.pubkey().to_string(), lamports]));
    kp
}

pub fn blockhash(f: &mut Facade) -> Hash {
    Hash::from_str(rpc(f, "getLatestBlockhash", json!([]))["value"]["blockhash"].as_str().unwrap()).unwrap()
}

pub fn balance(f: &mut Facade, k: &Pubkey) -> u64 {
    rpc(f, "getBalance", json!([k.to_string()]))["value"].as_u64().unwrap()
}

pub fn slot(f: &mut Facade) -> u64 {
    rpc(f, "getSlot", json!([])).as_u64().unwrap()
}

/// A legacy transaction; the first signer pays.
pub fn legacy_tx(ixs: &[Instruction], signers: &[&Keypair], hash: Hash) -> String {
    let msg = Message::new(ixs, Some(&signers[0].pubkey()));
    B64.encode(bincode::serialize(&Transaction::new(signers, msg, hash)).unwrap())
}

pub fn v0_tx(ixs: &[Instruction], signers: &[&Keypair], tables: &[AddressLookupTableAccount], hash: Hash) -> String {
    let msg = v0::Message::try_compile(&signers[0].pubkey(), ixs, tables, hash).unwrap();
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), signers).unwrap();
    B64.encode(bincode::serialize(&tx).unwrap())
}

pub fn send(f: &mut Facade, tx: &str) -> String {
    rpc(f, "sendTransaction", json!([tx, { "encoding": "base64" }])).as_str().unwrap().to_string()
}

pub fn send_ixs(f: &mut Facade, ixs: &[Instruction], signers: &[&Keypair]) -> String {
    let hash = blockhash(f);
    send(f, &legacy_tx(ixs, signers, hash))
}

pub fn transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    solana_system_interface::instruction::transfer(from, to, lamports)
}

/// SPL Token `Transfer` (instruction 3).
pub fn token_transfer(source: &Pubkey, destination: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: key(TOKEN_PROGRAM),
        accounts: vec![AccountMeta::new(*source, false), AccountMeta::new(*destination, false), AccountMeta::new_readonly(*owner, true)],
        data,
    }
}

pub fn status(f: &mut Facade, sig: &str) -> Value {
    rpc(f, "getSignatureStatuses", json!([[sig]]))["value"][0].clone()
}

pub fn account_data(f: &mut Facade, k: &Pubkey) -> Vec<u8> {
    let v = rpc(f, "getAccountInfo", json!([k.to_string(), { "encoding": "base64" }]));
    B64.decode(v["value"]["data"][0].as_str().expect("account exists")).unwrap()
}
