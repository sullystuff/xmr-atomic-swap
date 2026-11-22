//! The facade's JSON-RPC methods, driven in-process through `Facade::call`.

mod common;

use {
    base64::{engine::general_purpose::STANDARD as B64, Engine},
    common::*,
    serde_json::{json, Value},
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::{AddressLookupTableAccount, Message},
    solana_pubkey::Pubkey,
    solana_signer::Signer,
    solana_transaction::Transaction,
    svm_rpc::{facade, Facade},
};

#[test]
fn identity_methods() {
    let mut f = Facade::new();
    assert_eq!(rpc(&mut f, "getGenesisHash", json!([])), json!(svm_rpc::genesis_hash()));
    assert_eq!(rpc(&mut f, "getVersion", json!([]))["solana-core"], "4.2.2");
    assert_eq!(rpc(&mut f, "getHealth", Value::Null), "ok");
    assert_eq!(slot(&mut f), facade::INITIAL_SLOT);
    assert_eq!(rpc(&mut f, "getBlockHeight", json!([])), json!(facade::INITIAL_SLOT - facade::HEIGHT_LAG));
    assert_eq!(rpc(&mut f, "getBlockTime", json!([facade::INITIAL_SLOT])), json!(facade::INITIAL_UNIX_TIMESTAMP));
    let epoch = rpc(&mut f, "getEpochInfo", json!([]));
    assert_eq!(epoch["absoluteSlot"], facade::INITIAL_SLOT);
    assert_eq!(epoch["epoch"], facade::INITIAL_SLOT / 432_000);
    assert_eq!(rpc(&mut f, "getRecentPrioritizationFees", json!([]))[0]["prioritizationFee"], 0);

    let (code, message, _) = rpc_err(&mut f, "getBlock", json!([1]));
    assert_eq!(code, -32601);
    assert!(message.contains("getBlock"));
    assert_eq!(rpc_err(&mut f, "getBalance", json!(["not a key"])).0, -32602);
    assert_eq!(rpc_err(&mut f, "getBalance", json!({ "a": 1 })).0, -32602);
}

#[test]
fn rent_is_mainnets() {
    let mut f = Facade::new();
    for len in [0u64, 82, 165, 1000] {
        assert_eq!(rpc(&mut f, "getMinimumBalanceForRentExemption", json!([len])), json!((128 + len) * 5_080));
    }
}

#[test]
fn request_envelope_single_batch_and_malformed() {
    let mut f = Facade::new();
    let one: Value = serde_json::from_str(&f.handle_body(br#"{"jsonrpc":"2.0","id":7,"method":"getSlot"}"#)).unwrap();
    assert_eq!(one, json!({ "jsonrpc": "2.0", "result": facade::INITIAL_SLOT, "id": 7 }));
    let batch: Value = serde_json::from_str(
        &f.handle_body(br#"[{"jsonrpc":"2.0","id":"a","method":"getHealth"},{"jsonrpc":"2.0","id":"b","method":"nope"}]"#),
    )
    .unwrap();
    assert_eq!(batch[0]["result"], "ok");
    assert_eq!(batch[0]["id"], "a");
    assert_eq!(batch[1]["error"]["code"], -32601);
    let bad: Value = serde_json::from_str(&f.handle_body(b"{not json")).unwrap();
    assert_eq!(bad["error"]["code"], -32700);
    let no_method: Value = serde_json::from_str(&f.handle_body(br#"{"id":1}"#)).unwrap();
    assert_eq!(no_method["error"]["code"], -32600);
}

#[test]
fn sol_transfer_status_transaction_and_history() {
    let mut f = Facade::new();
    let payer = funded(&mut f, 10 * SOL);
    let to = Pubkey::new_unique();
    let start = slot(&mut f);

    let sig = send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, SOL)], &[&payer]);
    assert_eq!(balance(&mut f, &to), SOL);
    assert_eq!(balance(&mut f, &payer.pubkey()), 9 * SOL - 5_000);
    assert_eq!(slot(&mut f), start + 1, "a landed transaction takes one slot");

    let st = status(&mut f, &sig);
    assert_eq!(st["slot"], start);
    assert_eq!(st["err"], Value::Null);
    assert_eq!(st["status"], json!({ "Ok": null }));
    assert_eq!(st["confirmationStatus"], "finalized");
    let unknown = solana_signature::Signature::from([9u8; 64]).to_string();
    assert_eq!(status(&mut f, &unknown), Value::Null);

    let tx = rpc(&mut f, "getTransaction", json!([sig, { "encoding": "json" }]));
    assert_eq!(tx["slot"], start);
    assert_eq!(tx["blockTime"], facade::INITIAL_UNIX_TIMESTAMP);
    assert_eq!(tx["version"], "legacy");
    assert_eq!(tx["transaction"]["signatures"][0], sig.as_str());
    let keys = tx["transaction"]["message"]["accountKeys"].as_array().unwrap();
    assert_eq!(keys[0], payer.pubkey().to_string().as_str());
    assert_eq!(keys[1], to.to_string().as_str());
    let meta = &tx["meta"];
    assert_eq!(meta["err"], Value::Null);
    assert_eq!(meta["fee"], 5_000);
    assert_eq!(meta["preBalances"][0], 10 * SOL);
    assert_eq!(meta["postBalances"][0], 9 * SOL - 5_000);
    assert_eq!(meta["preBalances"][1], 0);
    assert_eq!(meta["postBalances"][1], SOL);
    let logs: Vec<&str> = meta["logMessages"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    assert_eq!(logs, ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"]);
    assert!(meta["computeUnitsConsumed"].as_u64().unwrap() > 0);

    // The stored bytes are the bytes that were sent.
    let raw = rpc(&mut f, "getTransaction", json!([sig, { "encoding": "base64" }]));
    let decoded: Transaction = bincode::deserialize(&B64.decode(raw["transaction"][0].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(decoded.signatures[0].to_string(), sig);
    assert_eq!(rpc(&mut f, "getTransaction", json!([unknown])), Value::Null);
    assert_eq!(rpc_err(&mut f, "getTransaction", json!([sig, { "encoding": "jsonParsed" }])).0, -32602);

    // Signature index per account, newest first, with `limit`, `before` and `until`.
    let sig2 = send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, 1)], &[&payer]);
    let sig3 = send_ixs(&mut f, &[transfer(&payer.pubkey(), &Pubkey::new_unique(), SOL)], &[&payer]);
    let list = |f: &mut Facade, who: &Pubkey, cfg: Value| -> Vec<String> {
        rpc(f, "getSignaturesForAddress", json!([who.to_string(), cfg]))
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["signature"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(list(&mut f, &payer.pubkey(), json!({})), [sig3.clone(), sig2.clone(), sig.clone()]);
    assert_eq!(list(&mut f, &to, json!({})), [sig2.clone(), sig.clone()]);
    assert_eq!(list(&mut f, &payer.pubkey(), json!({ "limit": 1 })), [sig3.clone()]);
    assert_eq!(list(&mut f, &payer.pubkey(), json!({ "before": sig3 })), [sig2.clone(), sig.clone()]);
    assert_eq!(list(&mut f, &payer.pubkey(), json!({ "until": sig })), [sig3.clone(), sig2.clone()]);
    assert!(list(&mut f, &Pubkey::new_unique(), json!({})).is_empty());
    let entry = &rpc(&mut f, "getSignaturesForAddress", json!([to.to_string()]))[0];
    assert_eq!(entry["slot"], start + 1);
    assert_eq!(entry["blockTime"], facade::INITIAL_UNIX_TIMESTAMP);
    assert_eq!(entry["err"], Value::Null);
    assert_eq!(rpc(&mut f, "getEpochInfo", json!([]))["transactionCount"], 3);
}

#[test]
fn base58_is_the_default_transaction_encoding() {
    let mut f = Facade::new();
    let payer = funded(&mut f, SOL);
    let to = Pubkey::new_unique();
    let hash = blockhash(&mut f);
    let raw = B64.decode(legacy_tx(&[transfer(&payer.pubkey(), &to, 2_000_000)], &[&payer], hash)).unwrap();
    rpc(&mut f, "sendTransaction", json!([bs58::encode(raw).into_string()]));
    assert_eq!(balance(&mut f, &to), 2_000_000);
}

#[test]
fn blockhash_window_duplicates_and_expiry() {
    let mut f = Facade::new();
    let payer = funded(&mut f, 10 * SOL);
    let to = Pubkey::new_unique();
    let old = blockhash(&mut f);
    let latest = rpc(&mut f, "getLatestBlockhash", json!([{ "commitment": "confirmed" }]));
    let height = rpc(&mut f, "getBlockHeight", json!([])).as_u64().unwrap();
    assert_eq!(latest["value"]["lastValidBlockHeight"], height + 150);

    // Two parties may fetch a blockhash and send in any order: an older hash stays good.
    for n in 1..=5u64 {
        send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, 1_000_000 + n)], &[&payer]);
    }
    assert_ne!(blockhash(&mut f), old);
    assert_eq!(rpc(&mut f, "isBlockhashValid", json!([old.to_string()]))["value"], true);
    let tx = legacy_tx(&[transfer(&payer.pubkey(), &to, 1_000_100)], &[&payer], old);
    let sig = send(&mut f, &tx);
    assert_eq!(status(&mut f, &sig)["err"], Value::Null);

    // A byte-identical resend is refused, or silently dropped when preflight is skipped.
    let before = balance(&mut f, &to);
    let (code, message, data) = rpc_err(&mut f, "sendTransaction", json!([tx, { "encoding": "base64" }]));
    assert_eq!(code, -32002);
    assert!(message.contains("already been processed"), "{message}");
    assert_eq!(data["err"], "AlreadyProcessed");
    assert_eq!(rpc(&mut f, "sendTransaction", json!([tx, { "encoding": "base64", "skipPreflight": true }])), json!(sig));
    assert_eq!(balance(&mut f, &to), before);

    // svm_warp expires every blockhash issued before it.
    rpc(&mut f, "svm_warp", json!([1]));
    assert_eq!(rpc(&mut f, "isBlockhashValid", json!([old.to_string()]))["value"], false);
    let stale = legacy_tx(&[transfer(&payer.pubkey(), &to, 7)], &[&payer], old);
    let (code, _, data) = rpc_err(&mut f, "sendTransaction", json!([stale, { "encoding": "base64" }]));
    assert_eq!((code, data["err"].clone()), (-32002, json!("BlockhashNotFound")));
    // With preflight skipped a node hands back the signature and the transaction never lands.
    let dropped = rpc(&mut f, "sendTransaction", json!([stale, { "encoding": "base64", "skipPreflight": true }]));
    assert_eq!(status(&mut f, dropped.as_str().unwrap()), Value::Null);
    assert_eq!(balance(&mut f, &to), before);
    assert_eq!(rpc(&mut f, "isBlockhashValid", json!([solana_hash::Hash::new_from_array([7u8; 32]).to_string()]))["value"], false);

    // 150 landed transactions age a blockhash out, as 150 blocks do on a cluster.
    let aged = blockhash(&mut f);
    for n in 0..151u64 {
        send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, 1_000 + n)], &[&payer]);
    }
    assert_eq!(rpc(&mut f, "isBlockhashValid", json!([aged.to_string()]))["value"], false);
}

#[test]
fn failed_transactions_preflight_and_skip_preflight() {
    let mut f = Facade::new();
    let payer = funded(&mut f, SOL);
    let to = Pubkey::new_unique();
    let too_much = [transfer(&payer.pubkey(), &to, 5 * SOL)];

    // Preflight: the error comes back with logs and nothing lands, so no fee.
    let hash = blockhash(&mut f);
    let (code, message, data) = rpc_err(&mut f, "sendTransaction", json!([legacy_tx(&too_much, &[&payer], hash), { "encoding": "base64" }]));
    assert_eq!(code, -32002);
    assert!(message.starts_with("Transaction simulation failed"), "{message}");
    assert_eq!(data["err"], json!({ "InstructionError": [0, { "Custom": 1 }] }));
    assert!(data["logs"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("insufficient lamports")));
    assert_eq!(balance(&mut f, &payer.pubkey()), SOL);
    assert!(rpc(&mut f, "getSignaturesForAddress", json!([payer.pubkey().to_string()])).as_array().unwrap().is_empty());

    // skipPreflight: it lands as a failure and the fee payer is charged.
    let hash = blockhash(&mut f);
    let sig = rpc(&mut f, "sendTransaction", json!([legacy_tx(&too_much, &[&payer], hash), { "encoding": "base64", "skipPreflight": true }]));
    let sig = sig.as_str().unwrap();
    let expected = json!({ "InstructionError": [0, { "Custom": 1 }] });
    let st = status(&mut f, sig);
    assert_eq!(st["err"], expected);
    assert_eq!(st["status"], json!({ "Err": expected }));
    assert_eq!(balance(&mut f, &payer.pubkey()), SOL - 5_000);
    assert_eq!(balance(&mut f, &to), 0);
    let tx = rpc(&mut f, "getTransaction", json!([sig]));
    assert_eq!(tx["meta"]["err"], expected);
    assert_eq!(tx["meta"]["fee"], 5_000);
    assert_eq!(rpc(&mut f, "getSignaturesForAddress", json!([payer.pubkey().to_string()]))[0]["err"], expected);

    // A bad signature never reaches a block, with or without preflight.
    let hash = blockhash(&mut f);
    let msg = Message::new(&[transfer(&payer.pubkey(), &to, 1)], Some(&payer.pubkey()));
    let mut forged = Transaction::new(&[&payer], msg, hash);
    forged.signatures[0] = solana_signature::Signature::from([3u8; 64]);
    let forged = B64.encode(bincode::serialize(&forged).unwrap());
    for skip in [false, true] {
        let (code, _, data) = rpc_err(&mut f, "sendTransaction", json!([forged, { "encoding": "base64", "skipPreflight": skip }]));
        assert_eq!((code, data["err"].clone()), (-32002, json!("SignatureFailure")));
    }
    assert_eq!(balance(&mut f, &payer.pubkey()), SOL - 5_000);
    assert_eq!(rpc_err(&mut f, "sendTransaction", json!(["AAAA", { "encoding": "base64" }])).0, -32602);
}

#[test]
fn simulate_and_fee_for_message() {
    let mut f = Facade::new();
    let payer = funded(&mut f, 3 * SOL);
    let to = Pubkey::new_unique();
    let hash = blockhash(&mut f);
    let msg = Message::new_with_blockhash(&[transfer(&payer.pubkey(), &to, SOL)], Some(&payer.pubkey()), &hash);

    // Unsigned, as web3.js sends it when no signers are given.
    let unsigned = B64.encode(bincode::serialize(&Transaction::new_unsigned(msg.clone())).unwrap());
    let accounts = json!({ "encoding": "base64", "addresses": [to.to_string(), payer.pubkey().to_string(), Pubkey::new_unique().to_string()] });
    let sim = rpc(&mut f, "simulateTransaction", json!([unsigned, { "encoding": "base64", "accounts": accounts }]));
    let v = &sim["value"];
    assert_eq!(v["err"], Value::Null);
    assert_eq!(v["logs"].as_array().unwrap().len(), 2);
    assert!(v["unitsConsumed"].as_u64().unwrap() > 0);
    assert_eq!(v["accounts"][0]["lamports"], SOL, "post-simulation state of a written account");
    assert_eq!(v["accounts"][1]["lamports"], 2 * SOL - 5_000);
    assert_eq!(v["accounts"][2], Value::Null);
    assert_eq!(balance(&mut f, &to), 0, "simulation changes nothing");
    assert_eq!(slot(&mut f), facade::INITIAL_SLOT);

    // The same unsigned bytes fail signature verification when it is asked for.
    let checked = rpc(&mut f, "simulateTransaction", json!([unsigned, { "encoding": "base64", "sigVerify": true }]));
    assert_eq!(checked["value"]["err"], "SignatureFailure");
    let signed = legacy_tx(&[transfer(&payer.pubkey(), &to, SOL)], &[&payer], hash);
    let checked = rpc(&mut f, "simulateTransaction", json!([signed, { "encoding": "base64", "sigVerify": true }]));
    assert_eq!(checked["value"]["err"], Value::Null);

    // A stale blockhash fails unless the caller asks for it to be replaced.
    rpc(&mut f, "svm_warp", json!([120]));
    let stale = rpc(&mut f, "simulateTransaction", json!([unsigned, { "encoding": "base64" }]));
    assert_eq!(stale["value"]["err"], "BlockhashNotFound");
    let replaced = rpc(&mut f, "simulateTransaction", json!([unsigned, { "encoding": "base64", "replaceRecentBlockhash": true }]));
    assert_eq!(replaced["value"]["err"], Value::Null);
    assert_eq!(rpc_err(&mut f, "simulateTransaction", json!([unsigned, { "encoding": "base64", "replaceRecentBlockhash": true, "sigVerify": true }])).0, -32602);

    // A failing simulation reports the error and its logs in the value, not as an RPC error.
    let hash = blockhash(&mut f);
    let fail = legacy_tx(&[transfer(&payer.pubkey(), &to, 50 * SOL)], &[&payer], hash);
    let sim = rpc(&mut f, "simulateTransaction", json!([fail, { "encoding": "base64", "sigVerify": true }]));
    assert_eq!(sim["value"]["err"], json!({ "InstructionError": [0, { "Custom": 1 }] }));
    assert!(!sim["value"]["logs"].as_array().unwrap().is_empty());

    // getFeeForMessage equals what a send then charges, for one and for two signers.
    let second = funded(&mut f, SOL);
    for signers in [vec![&payer], vec![&payer, &second]] {
        let hash = blockhash(&mut f);
        let mut ixs = vec![transfer(&payer.pubkey(), &to, 1_000_000)];
        if signers.len() == 2 {
            ixs.push(transfer(&second.pubkey(), &to, 1_000_000));
        }
        let msg = Message::new_with_blockhash(&ixs, Some(&payer.pubkey()), &hash);
        let quoted = rpc(&mut f, "getFeeForMessage", json!([B64.encode(msg.serialize())]))["value"].as_u64().unwrap();
        assert_eq!(quoted, 5_000 * signers.len() as u64);
        let before = balance(&mut f, &payer.pubkey());
        let sig = send(&mut f, &legacy_tx(&ixs, &signers, hash));
        assert_eq!(before - balance(&mut f, &payer.pubkey()), quoted + 1_000_000);
        assert_eq!(rpc(&mut f, "getTransaction", json!([sig]))["meta"]["fee"], quoted);
    }
    // An expired blockhash has no fee.
    rpc(&mut f, "svm_warp", json!([1]));
    assert_eq!(rpc(&mut f, "getFeeForMessage", json!([B64.encode(msg.serialize())]))["value"], Value::Null);
}

#[test]
fn priority_fee_is_quoted_and_charged() {
    let mut f = Facade::new();
    let payer = funded(&mut f, SOL);
    let to = Pubkey::new_unique();
    let budget = key("ComputeBudget111111111111111111111111111111");
    // SetComputeUnitLimit(100_000), SetComputeUnitPrice(2_000 micro-lamports): 200 lamports.
    let mut limit = vec![2u8];
    limit.extend_from_slice(&100_000u32.to_le_bytes());
    let mut price = vec![3u8];
    price.extend_from_slice(&2_000u64.to_le_bytes());
    let ixs = [
        Instruction { program_id: budget, accounts: vec![], data: limit },
        Instruction { program_id: budget, accounts: vec![], data: price },
        transfer(&payer.pubkey(), &to, 1_000_000),
    ];
    let hash = blockhash(&mut f);
    let msg = Message::new_with_blockhash(&ixs, Some(&payer.pubkey()), &hash);
    let quoted = rpc(&mut f, "getFeeForMessage", json!([B64.encode(msg.serialize())]))["value"].as_u64().unwrap();
    assert_eq!(quoted, 5_200);
    send(&mut f, &legacy_tx(&ixs, &[&payer], hash));
    assert_eq!(balance(&mut f, &payer.pubkey()), SOL - 1_000_000 - 5_200);
}

#[test]
fn spl_mint_accounts_balances_and_freeze() {
    let mut f = Facade::new();
    let issuer = Pubkey::new_unique();
    let alice = funded(&mut f, SOL);
    let bob = Pubkey::new_unique();

    let mint = key(rpc(&mut f, "svm_createMint", json!([6, issuer.to_string()])).as_str().unwrap());
    let info = rpc(&mut f, "getAccountInfo", json!([mint.to_string(), { "encoding": "jsonParsed" }]));
    assert_eq!(info["value"]["owner"], TOKEN_PROGRAM);
    assert_eq!(info["value"]["lamports"], (128 + 82) * 5_080);
    let parsed = &info["value"]["data"]["parsed"];
    assert_eq!(parsed["type"], "mint");
    assert_eq!(parsed["info"]["decimals"], 6);
    assert_eq!(parsed["info"]["mintAuthority"], issuer.to_string().as_str());
    assert_eq!(parsed["info"]["freezeAuthority"], issuer.to_string().as_str());

    // Amounts are accepted as integers or decimal strings.
    let alice_ata = key(rpc(&mut f, "svm_mintTo", json!([mint.to_string(), alice.pubkey().to_string(), "1500000000"])).as_str().unwrap());
    let again = rpc(&mut f, "svm_mintTo", json!([mint.to_string(), alice.pubkey().to_string(), 500_000_000u64]));
    assert_eq!(again, json!(alice_ata.to_string()));
    let bob_ata = key(rpc(&mut f, "svm_mintTo", json!([mint.to_string(), bob.to_string(), 0])).as_str().unwrap());
    assert_eq!(alice_ata, svm_rpc::token::associated_token_address(&alice.pubkey(), &mint));

    let bal = rpc(&mut f, "getTokenAccountBalance", json!([alice_ata.to_string()]));
    assert_eq!(bal["value"], json!({ "amount": "2000000000", "decimals": 6, "uiAmount": 2000.0, "uiAmountString": "2000" }));
    let supply = rpc(&mut f, "getAccountInfo", json!([mint.to_string(), { "encoding": "jsonParsed" }]));
    assert_eq!(supply["value"]["data"]["parsed"]["info"]["supply"], "2000000000");

    // A real SPL Token transfer, signed by the owner, against the bundled token program.
    let sig = send_ixs(&mut f, &[token_transfer(&alice_ata, &bob_ata, &alice.pubkey(), 250_000)], &[&alice]);
    assert_eq!(rpc(&mut f, "getTokenAccountBalance", json!([bob_ata.to_string()]))["value"]["uiAmountString"], "0.25");
    let meta = rpc(&mut f, "getTransaction", json!([sig]))["meta"].clone();
    let side = |list: &Value, who: &Pubkey| -> String {
        let e = list.as_array().unwrap().iter().find(|e| e["owner"] == who.to_string().as_str()).unwrap().clone();
        assert_eq!(e["mint"], mint.to_string().as_str());
        assert_eq!(e["programId"], TOKEN_PROGRAM);
        e["uiTokenAmount"]["amount"].as_str().unwrap().to_string()
    };
    assert_eq!(side(&meta["preTokenBalances"], &alice.pubkey()), "2000000000");
    assert_eq!(side(&meta["postTokenBalances"], &alice.pubkey()), "1999750000");
    assert_eq!(side(&meta["preTokenBalances"], &bob), "0");
    assert_eq!(side(&meta["postTokenBalances"], &bob), "250000");

    // getTokenAccountsByOwner by mint and by program, raw and parsed.
    let other_mint = rpc(&mut f, "svm_createMint", json!([9, issuer.to_string()]));
    rpc(&mut f, "svm_mintTo", json!([other_mint, alice.pubkey().to_string(), 5]));
    let by_mint = rpc(&mut f, "getTokenAccountsByOwner", json!([alice.pubkey().to_string(), { "mint": mint.to_string() }, { "encoding": "base64" }]));
    let list = by_mint["value"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["pubkey"], alice_ata.to_string().as_str());
    assert_eq!(B64.decode(list[0]["account"]["data"][0].as_str().unwrap()).unwrap().len(), 165);
    let by_program = rpc(&mut f, "getTokenAccountsByOwner", json!([alice.pubkey().to_string(), { "programId": TOKEN_PROGRAM }, { "encoding": "jsonParsed" }]));
    let list = by_program["value"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let usdc = list.iter().find(|e| e["pubkey"] == alice_ata.to_string().as_str()).unwrap();
    let parsed = &usdc["account"]["data"]["parsed"]["info"];
    assert_eq!(parsed["tokenAmount"]["amount"], "1999750000");
    assert_eq!(parsed["state"], "initialized");
    assert_eq!(parsed["owner"], alice.pubkey().to_string().as_str());
    let none = rpc(&mut f, "getTokenAccountsByOwner", json!([Pubkey::new_unique().to_string(), { "mint": mint.to_string() }]));
    assert!(none["value"].as_array().unwrap().is_empty());
    assert_eq!(rpc_err(&mut f, "getTokenAccountsByOwner", json!([bob.to_string(), { "mint": bob.to_string() }])).0, -32602);
    assert_eq!(rpc_err(&mut f, "getTokenAccountBalance", json!([mint.to_string()])).0, -32602);
    assert_eq!(rpc_err(&mut f, "getTokenAccountBalance", json!([alice.pubkey().to_string()])).0, -32602);

    // A frozen account refuses transfers with the token program's AccountFrozen (0x11).
    rpc(&mut f, "svm_setTokenAccountFrozen", json!([bob_ata.to_string(), true]));
    let hash = blockhash(&mut f);
    let frozen_tx = legacy_tx(&[token_transfer(&alice_ata, &bob_ata, &alice.pubkey(), 1)], &[&alice], hash);
    let (_, _, data) = rpc_err(&mut f, "sendTransaction", json!([frozen_tx, { "encoding": "base64" }]));
    assert_eq!(data["err"], json!({ "InstructionError": [0, { "Custom": 17 }] }));
    let parsed = rpc(&mut f, "getAccountInfo", json!([bob_ata.to_string(), { "encoding": "jsonParsed" }]));
    assert_eq!(parsed["value"]["data"]["parsed"]["info"]["state"], "frozen");
    rpc(&mut f, "svm_setTokenAccountFrozen", json!([bob_ata.to_string(), false]));
    send_ixs(&mut f, &[token_transfer(&alice_ata, &bob_ata, &alice.pubkey(), 1)], &[&alice]);
    assert_eq!(rpc(&mut f, "getTokenAccountBalance", json!([bob_ata.to_string()]))["value"]["amount"], "250001");
    assert_eq!(rpc_err(&mut f, "svm_setTokenAccountFrozen", json!([mint.to_string(), true])).0, -32602);
    assert_eq!(rpc_err(&mut f, "svm_mintTo", json!([bob.to_string(), bob.to_string(), 1])).0, -32602);
    assert_eq!(rpc_err(&mut f, "svm_mintTo", json!([mint.to_string(), bob.to_string(), 1.5])).0, -32602);
}

#[test]
fn account_reads_and_program_account_filters() {
    let mut f = Facade::new();
    let owner = Pubkey::new_unique();
    // Six accounts of a made-up program: a one-byte tag, then a 32-byte "maker" key.
    let (maker_a, maker_b) = (Pubkey::new_unique(), Pubkey::new_unique());
    let mut keys = Vec::new();
    for i in 0..6u8 {
        let k = Pubkey::new_unique();
        let mut data = vec![i % 2];
        data.extend_from_slice(if i < 4 { maker_a.as_ref() } else { maker_b.as_ref() });
        data.resize(if i == 5 { 80 } else { 40 }, i);
        rpc(&mut f, "svm_setAccount", json!([k.to_string(), { "lamports": "1000000", "owner": owner.to_string(), "data": B64.encode(&data) }]));
        keys.push((k, data));
    }
    let pubkeys = |v: &Value| -> Vec<String> { v.as_array().unwrap().iter().map(|e| e["pubkey"].as_str().unwrap().to_string()).collect() };
    let expect = |idx: &[usize]| -> Vec<String> {
        let mut v: Vec<String> = idx.iter().map(|i| keys[*i].0.to_string()).collect();
        v.sort();
        v
    };

    let all = rpc(&mut f, "getProgramAccounts", json!([owner.to_string()]));
    assert_eq!(pubkeys(&all), expect(&[0, 1, 2, 3, 4, 5]));
    let first = &all[0]["account"];
    assert_eq!(first["owner"], owner.to_string().as_str());
    assert_eq!(first["lamports"], 1_000_000);
    assert_eq!(first["executable"], false);
    assert_eq!(first["data"][1], "base64");

    let sized = rpc(&mut f, "getProgramAccounts", json!([owner.to_string(), { "filters": [{ "dataSize": 40 }] }]));
    assert_eq!(pubkeys(&sized), expect(&[0, 1, 2, 3, 4]));
    let by_maker = json!({ "memcmp": { "offset": 1, "bytes": maker_a.to_string() } });
    let hits = rpc(&mut f, "getProgramAccounts", json!([owner.to_string(), { "filters": [by_maker] }]));
    assert_eq!(pubkeys(&hits), expect(&[0, 1, 2, 3]));
    // Two filters are ANDed; base64 bytes are accepted with an explicit encoding.
    let tag = json!({ "memcmp": { "offset": 0, "bytes": B64.encode([1u8]), "encoding": "base64" } });
    let hits = rpc(&mut f, "getProgramAccounts", json!([owner.to_string(), { "filters": [by_maker, tag] }]));
    assert_eq!(pubkeys(&hits), expect(&[1, 3]));
    let by_b = json!({ "memcmp": { "offset": 1, "bytes": maker_b.to_string() } });
    let hits = rpc(&mut f, "getProgramAccounts", json!([owner.to_string(), { "filters": [by_b, { "dataSize": 80 }], "withContext": true }]));
    assert_eq!(pubkeys(&hits["value"]), expect(&[5]));
    assert!(hits["context"]["slot"].is_u64());
    // A memcmp that would read past the end matches nothing.
    let past = json!({ "memcmp": { "offset": 39, "bytes": maker_a.to_string() } });
    assert!(rpc(&mut f, "getProgramAccounts", json!([owner.to_string(), { "filters": [past] }])).as_array().unwrap().is_empty());
    assert!(rpc(&mut f, "getProgramAccounts", json!([Pubkey::new_unique().to_string()])).as_array().unwrap().is_empty());
    assert_eq!(rpc_err(&mut f, "getProgramAccounts", json!([owner.to_string(), { "filters": [{ "tokenAccountState": true }] }])).0, -32602);

    // dataSlice on getProgramAccounts, getAccountInfo and getMultipleAccounts.
    let sliced = rpc(&mut f, "getProgramAccounts", json!([owner.to_string(), { "dataSlice": { "offset": 1, "length": 32 }, "filters": [{ "dataSize": 80 }] }]));
    assert_eq!(B64.decode(sliced[0]["account"]["data"][0].as_str().unwrap()).unwrap(), maker_b.as_ref());
    assert_eq!(sliced[0]["account"]["space"], 80);
    let one = rpc(&mut f, "getAccountInfo", json!([keys[0].0.to_string(), { "encoding": "base64", "dataSlice": { "offset": 38, "length": 100 } }]));
    assert_eq!(B64.decode(one["value"]["data"][0].as_str().unwrap()).unwrap(), keys[0].1[38..]);
    assert_eq!(account_data(&mut f, &keys[3].0), keys[3].1);
    let short = rpc(&mut f, "getAccountInfo", json!([keys[0].0.to_string(), { "encoding": "base58" }]));
    assert_eq!(bs58::decode(short["value"]["data"][0].as_str().unwrap()).into_vec().unwrap(), keys[0].1);
    // jsonParsed falls back to base64 for accounts it has no parser for.
    let fallback = rpc(&mut f, "getAccountInfo", json!([keys[0].0.to_string(), { "encoding": "jsonParsed" }]));
    assert_eq!(fallback["value"]["data"][1], "base64");
    assert_eq!(rpc_err(&mut f, "getAccountInfo", json!([keys[0].0.to_string(), { "encoding": "base64+zstd" }])).0, -32602);

    let missing = Pubkey::new_unique();
    assert_eq!(rpc(&mut f, "getAccountInfo", json!([missing.to_string()]))["value"], Value::Null);
    assert_eq!(balance(&mut f, &missing), 0);
    let multi = rpc(&mut f, "getMultipleAccounts", json!([[keys[1].0.to_string(), missing.to_string(), keys[5].0.to_string()], { "encoding": "base64" }]));
    let multi = multi["value"].as_array().unwrap();
    assert_eq!(B64.decode(multi[0]["data"][0].as_str().unwrap()).unwrap(), keys[1].1);
    assert_eq!(multi[1], Value::Null);
    assert_eq!(multi[2]["space"], 80);

    // svm_setAccount with null removes the account.
    rpc(&mut f, "svm_setAccount", json!([keys[5].0.to_string(), null]));
    assert_eq!(rpc(&mut f, "getAccountInfo", json!([keys[5].0.to_string()]))["value"], Value::Null);
    assert_eq!(rpc(&mut f, "getProgramAccounts", json!([owner.to_string()])).as_array().unwrap().len(), 5);
}

#[test]
fn clock_warp_and_set_clock() {
    let mut f = Facade::new();
    let payer = funded(&mut f, SOL);
    let to = Pubkey::new_unique();
    let (s0, t0) = (facade::INITIAL_SLOT, facade::INITIAL_UNIX_TIMESTAMP);

    let first = send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, 1_000_000)], &[&payer]);
    let warped = rpc(&mut f, "svm_warp", json!([3600]));
    // 400 ms slots: 2.5 per second. The landed transaction took one slot before the warp.
    assert_eq!(warped, json!({ "slot": s0 + 1 + 9000, "blockHeight": s0 + 1 + 9000 - facade::HEIGHT_LAG, "unixTimestamp": t0 + 3600 }));
    assert_eq!(slot(&mut f), s0 + 9001);
    assert_eq!(rpc(&mut f, "getBlockHeight", json!([])), json!(s0 + 9001 - facade::HEIGHT_LAG));
    assert_eq!(rpc(&mut f, "getEpochInfo", json!([]))["absoluteSlot"], s0 + 9001);

    // The on-chain Clock sysvar is what moved.
    let clock = account_data(&mut f, &key("SysvarC1ock11111111111111111111111111111111"));
    assert_eq!(u64::from_le_bytes(clock[0..8].try_into().unwrap()), s0 + 9001);
    assert_eq!(i64::from_le_bytes(clock[32..40].try_into().unwrap()), t0 + 3600);

    // Block times follow the clock: before, across and after the warp.
    let second = send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, 1_000_000)], &[&payer]);
    assert_eq!(rpc(&mut f, "getTransaction", json!([first]))["blockTime"], t0);
    assert_eq!(rpc(&mut f, "getTransaction", json!([second]))["blockTime"], t0 + 3600);
    assert_eq!(status(&mut f, &second)["slot"], s0 + 9001);
    assert_eq!(rpc(&mut f, "getBlockTime", json!([s0])), json!(t0));
    assert_eq!(rpc(&mut f, "getBlockTime", json!([s0 + 5000])), json!(t0));
    assert_eq!(rpc(&mut f, "getBlockTime", json!([s0 + 9001])), json!(t0 + 3600));
    assert_eq!(rpc_err(&mut f, "getBlockTime", json!([s0 + 1_000_000])).0, -32011);
    assert_eq!(rpc_err(&mut f, "getBlockTime", json!([5])).0, -32011);

    // svm_setClock sets the timestamp, takes one slot and keeps blockhashes valid.
    let hash = blockhash(&mut f);
    let before = slot(&mut f);
    let set = rpc(&mut f, "svm_setClock", json!([t0 + 10_000]));
    assert_eq!(set["unixTimestamp"], t0 + 10_000);
    assert_eq!(set["slot"], before + 1);
    assert_eq!(rpc(&mut f, "isBlockhashValid", json!([hash.to_string()]))["value"], true);
    assert_eq!(rpc(&mut f, "getBlockTime", json!([before + 1])), json!(t0 + 10_000));

    // A zero-second warp still takes a slot and expires the blockhash; odd seconds round down.
    let z = rpc(&mut f, "svm_warp", json!([0]));
    assert_eq!((z["slot"].clone(), z["unixTimestamp"].clone()), (json!(before + 2), json!(t0 + 10_000)));
    assert_eq!(rpc(&mut f, "isBlockhashValid", json!([hash.to_string()]))["value"], false);
    assert_eq!(rpc(&mut f, "svm_warp", json!(["3"]))["slot"], before + 2 + 7);
    assert_eq!(rpc_err(&mut f, "svm_warp", json!([-5])).0, -32602);
    assert_eq!(rpc_err(&mut f, "svm_warp", json!([u64::MAX])).0, -32602);

    // Sixty days (the longest deadline in the protocol) across many epochs: programs still run.
    rpc(&mut f, "svm_warp", json!([60 * 86_400]));
    let third = send_ixs(&mut f, &[transfer(&payer.pubkey(), &to, 1_000_000)], &[&payer]);
    assert_eq!(rpc(&mut f, "getTransaction", json!([third]))["blockTime"], t0 + 10_000 + 3 + 60 * 86_400);
    assert_eq!(balance(&mut f, &to), 3_000_000);
}

#[test]
fn program_loading_and_upgrade_authority() {
    let mut f = Facade::new();
    let payer = funded(&mut f, SOL);
    let program_id = Pubkey::new_unique();
    let memo = |text: &str| Instruction {
        program_id,
        accounts: vec![AccountMeta::new_readonly(payer.pubkey(), true)],
        data: text.as_bytes().to_vec(),
    };

    // Nothing is there yet.
    let hash = blockhash(&mut f);
    let (_, _, data) = rpc_err(&mut f, "sendTransaction", json!([legacy_tx(&[memo("early")], &[&payer], hash), { "encoding": "base64" }]));
    assert_eq!(data["err"], "InvalidProgramForExecution");

    let loaded = rpc(&mut f, "svm_addProgram", json!([program_id.to_string(), MEMO_FIXTURE]));
    assert_eq!(loaded["programId"], program_id.to_string().as_str());
    let program_data = key(loaded["programData"].as_str().unwrap());
    let info = rpc(&mut f, "getAccountInfo", json!([program_id.to_string()]));
    assert_eq!(info["value"]["executable"], true);
    assert_eq!(info["value"]["owner"], "BPFLoaderUpgradeab1e11111111111111111111111");
    // The Program account points at the ProgramData account, which holds the ELF.
    let program = account_data(&mut f, &program_id);
    assert_eq!(program[..4], 2u32.to_le_bytes());
    assert_eq!(program[4..36], *program_data.as_ref());
    let elf = std::fs::read(MEMO_FIXTURE).unwrap();
    assert_eq!(account_data(&mut f, &program_data)[45..], elf[..]);

    // The loaded program executes at the requested id, straight away and after a warp.
    for text in ["hello from svm-rpc", "still here"] {
        let sig = send_ixs(&mut f, &[memo(text)], &[&payer]);
        let logs = rpc(&mut f, "getTransaction", json!([sig]))["meta"]["logMessages"].clone();
        let logs: Vec<&str> = logs.as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
        assert_eq!(logs.first().copied(), Some(format!("Program {program_id} invoke [1]").as_str()));
        assert!(logs.iter().any(|l| l.contains(text)), "{logs:?}");
        assert_eq!(logs.last().copied(), Some(format!("Program {program_id} success").as_str()));
        rpc(&mut f, "svm_warp", json!([86_400]));
    }

    // Upgrade authority: none after loading, then set, then cleared.
    assert_eq!(account_data(&mut f, &program_data)[12], 0);
    let authority = Pubkey::new_unique();
    rpc(&mut f, "svm_setUpgradeAuthority", json!([program_id.to_string(), authority.to_string()]));
    let data = account_data(&mut f, &program_data);
    assert_eq!(data[..4], 3u32.to_le_bytes());
    assert_eq!(data[12], 1);
    assert_eq!(data[13..45], *authority.as_ref());
    assert_eq!(data[45..], elf[..]);
    send_ixs(&mut f, &[memo("after authority change")], &[&payer]);
    rpc(&mut f, "svm_setUpgradeAuthority", json!([program_id.to_string(), null]));
    assert_eq!(account_data(&mut f, &program_data)[12..45], [0u8; 33]);

    assert_eq!(rpc_err(&mut f, "svm_setUpgradeAuthority", json!([payer.pubkey().to_string(), authority.to_string()])).0, -32602);
    let (code, message, _) = rpc_err(&mut f, "svm_addProgram", json!([Pubkey::new_unique().to_string(), "/nonexistent/program.so"]));
    assert_eq!(code, -32602);
    assert!(message.contains("/nonexistent/program.so"));
    let not_elf = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    assert_eq!(rpc_err(&mut f, "svm_addProgram", json!([Pubkey::new_unique().to_string(), not_elf])).0, -32602);
}

#[test]
fn v0_transaction_with_lookup_table() {
    let mut f = Facade::new();
    let payer = funded(&mut f, 5 * SOL);
    let recipients: Vec<Pubkey> = (0..3).map(|_| Pubkey::new_unique()).collect();
    let listed: Vec<String> = recipients.iter().map(Pubkey::to_string).collect();
    let table = key(rpc(&mut f, "svm_createLookupTable", json!([listed])).as_str().unwrap());
    let info = rpc(&mut f, "getAccountInfo", json!([table.to_string()]));
    assert_eq!(info["value"]["owner"], "AddressLookupTab1e1111111111111111111111111");
    assert_eq!(info["value"]["space"], 56 + 3 * 32);

    let lookup = AddressLookupTableAccount { key: table, addresses: recipients.clone() };
    let ixs: Vec<Instruction> = recipients.iter().enumerate().map(|(i, r)| transfer(&payer.pubkey(), r, SOL + i as u64)).collect();
    let hash = blockhash(&mut f);
    let tx = v0_tx(&ixs, &[&payer], &[lookup], hash);
    let sim = rpc(&mut f, "simulateTransaction", json!([tx, { "encoding": "base64", "sigVerify": true }]));
    assert_eq!(sim["value"]["err"], Value::Null);
    let sig = send(&mut f, &tx);
    for (i, r) in recipients.iter().enumerate() {
        assert_eq!(balance(&mut f, r), SOL + i as u64);
    }

    // As on a node, a v0 transaction is only returned to a client that says it understands one.
    assert_eq!(rpc_err(&mut f, "getTransaction", json!([sig])).0, -32015);
    let got = rpc(&mut f, "getTransaction", json!([sig, { "maxSupportedTransactionVersion": 0 }]));
    assert_eq!(got["version"], 0);
    let message = &got["transaction"]["message"];
    assert_eq!(message["accountKeys"].as_array().unwrap().len(), 2, "payer and the system program are static");
    assert_eq!(message["addressTableLookups"][0]["accountKey"], table.to_string().as_str());
    assert_eq!(message["addressTableLookups"][0]["writableIndexes"], json!([0, 1, 2]));
    assert_eq!(got["meta"]["loadedAddresses"]["writable"], json!(listed));
    assert_eq!(got["meta"]["loadedAddresses"]["readonly"], json!([]));
    // Balances cover static keys, then loaded addresses.
    assert_eq!(got["meta"]["preBalances"].as_array().unwrap().len(), 5);
    assert_eq!(got["meta"]["postBalances"][2], SOL);
    assert_eq!(got["meta"]["postBalances"][4], SOL + 2);
    // Loaded addresses are indexed for getSignaturesForAddress too.
    let history = rpc(&mut f, "getSignaturesForAddress", json!([recipients[1].to_string()]));
    assert_eq!(history[0]["signature"], sig.as_str());
    assert_eq!(rpc_err(&mut f, "svm_createLookupTable", json!([["nope"]])).0, -32602);
}

#[test]
fn ed25519_precompile_is_loaded() {
    // The program verifies advance approvals through the Ed25519 precompile (SPEC 4.6), so a
    // transaction carrying a precompile instruction must run here and pay for its signature.
    let mut f = Facade::new();
    let payer = funded(&mut f, SOL);
    let signer = Keypair::new();
    let message = b"advance approval";
    let signature = signer.sign_message(message);
    // One signature; all three instruction indexes 0xFFFF (this instruction).
    let (pk_off, sig_off, msg_off) = (16u16, 48u16, 112u16);
    let mut data = vec![1u8, 0];
    for v in [sig_off, u16::MAX, pk_off, u16::MAX, msg_off, message.len() as u16, u16::MAX] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(signer.pubkey().as_ref());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    let program_id = key("Ed25519SigVerify111111111111111111111111111");
    let good = Instruction { program_id, accounts: vec![], data: data.clone() };

    let hash = blockhash(&mut f);
    let msg = Message::new_with_blockhash(std::slice::from_ref(&good), Some(&payer.pubkey()), &hash);
    let quoted = rpc(&mut f, "getFeeForMessage", json!([B64.encode(msg.serialize())]))["value"].as_u64().unwrap();
    assert_eq!(quoted, 10_000, "the precompile signature is charged like a transaction signature");
    let sig = send(&mut f, &legacy_tx(&[good], &[&payer], hash));
    assert_eq!(status(&mut f, &sig)["err"], Value::Null);
    assert_eq!(balance(&mut f, &payer.pubkey()), SOL - quoted);

    // A corrupted message fails verification.
    *data.last_mut().unwrap() ^= 1;
    let bad = Instruction { program_id, accounts: vec![], data };
    let hash = blockhash(&mut f);
    let (code, _, _) = rpc_err(&mut f, "sendTransaction", json!([legacy_tx(&[bad], &[&payer], hash), { "encoding": "base64" }]));
    assert_eq!(code, -32002);
}

#[test]
fn control_methods_set_account_and_airdrop() {
    let mut f = Facade::new();
    let k = Pubkey::new_unique();
    assert_eq!(rpc(&mut f, "svm_airdrop", json!([k.to_string(), 7])), "7");
    assert_eq!(rpc(&mut f, "svm_airdrop", json!([k.to_string(), "18446744073709551608"])), "18446744073709551615");
    assert_eq!(balance(&mut f, &k), u64::MAX);
    assert_eq!(rpc_err(&mut f, "svm_airdrop", json!([k.to_string(), 1])).0, -32602);
    assert_eq!(rpc_err(&mut f, "svm_airdrop", json!([k.to_string()])).0, -32602);

    // The [base64, "base64"] form that getAccountInfo returns can be fed straight back.
    let owner = Pubkey::new_unique();
    let src = Pubkey::new_unique();
    rpc(&mut f, "svm_setAccount", json!([src.to_string(), { "lamports": 5_000_000, "owner": owner.to_string(), "data": B64.encode([1u8, 2, 3]) }]));
    let got = rpc(&mut f, "getAccountInfo", json!([src.to_string()]))["value"].clone();
    let copy = Pubkey::new_unique();
    rpc(&mut f, "svm_setAccount", json!([copy.to_string(), got]));
    assert_eq!(rpc(&mut f, "getAccountInfo", json!([copy.to_string()]))["value"], got);
    assert_eq!(rpc_err(&mut f, "svm_setAccount", json!([copy.to_string(), { "owner": owner.to_string() }])).0, -32602);
    assert_eq!(rpc_err(&mut f, "svm_setAccount", json!([copy.to_string(), { "lamports": 1, "data": "***" }])).0, -32602);

    // Addresses the tool invents are the same on every run.
    let a = Pubkey::new_unique().to_string();
    let m1 = rpc(&mut f, "svm_createMint", json!([6, a]));
    let m2 = rpc(&mut Facade::new(), "svm_createMint", json!([6, a]));
    assert_eq!(m1, m2);
    assert_ne!(rpc(&mut f, "svm_createMint", json!([6, a])), m1);
    // A caller may also choose the mint address, once.
    let chosen = Pubkey::new_unique().to_string();
    assert_eq!(rpc(&mut f, "svm_createMint", json!([6, a, chosen])), json!(chosen));
    assert_eq!(rpc_err(&mut f, "svm_createMint", json!([6, a, chosen])).0, -32602);
    assert_eq!(rpc_err(&mut f, "svm_createMint", json!([300, a])).0, -32602);
}
