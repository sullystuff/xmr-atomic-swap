//! The recorded regtest fixture (`monero_tx.json`, SPEC 2.12) against the sweep's selection
//! logic, with no daemon: real blocks and transactions are scanned with the joint view key and
//! the sweep must pick exactly the named output.

use serde_json::Value;
use swap_core::{
  address::{joint_address, Network},
  point::{add_scalars, scalar_matches},
  sweep::{joint_view_pair, scan_block, scannable_block_from_blobs, select_output, SweepError},
};

fn fixture() -> Value {
  serde_json::from_str(swap_core::vectors::MONERO_TX_FIXTURE).unwrap()
}
fn b32(v: &Value) -> [u8; 32] {
  hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
}
fn case<'a>(f: &'a Value, name: &str) -> &'a Value {
  f["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("case {name} missing"))
}

/// Scan the block of a block-shaped case with the fixture's joint view key.
fn scan(f: &Value, input: &Value) -> Vec<monero_wallet::WalletOutput> {
  let block_blob = hex::decode(input["block_hex"].as_str().unwrap()).unwrap();
  let txs: Vec<Vec<u8>> = input["txs"].as_array().unwrap().iter().map(|t| hex::decode(t["pruned_hex"].as_str().unwrap()).unwrap()).collect();
  let mut block = scannable_block_from_blobs(&block_blob, &txs, input["first_ringct_output_index"].as_u64()).unwrap();
  assert_eq!(hex::encode(block.block.hash()), input["block_hash"].as_str().unwrap(), "the recorded blob is the recorded block");
  // A synthetic transaction is not in the recorded block's list: name it there, as a block that
  // really contained it would.
  for t in input["txs"].as_array().unwrap() {
    if t["synthetic"] == true {
      block.block.transactions.push(b32(&t["txid"]));
    }
  }
  assert_eq!(block.block.transactions.len(), txs.len());
  let spend_pub = swap_core::primitives::ed_decompress(&b32(&f["keys"]["joint"]["spend_pub"])).unwrap();
  let pair = joint_view_pair(monero_wallet::ed25519::Point::from(spend_pub), &b32(&f["keys"]["joint"]["view_priv"])).unwrap();
  scan_block(pair, block).unwrap()
}

#[test]
fn fixture_keys_are_consistent() {
  let f = fixture();
  let k = &f["keys"];
  let j = joint_address(&b32(&k["maker"]["spend_pub"]), &b32(&k["taker"]["spend_pub"]), &b32(&k["maker"]["view"]), &b32(&k["taker"]["view"]), Network::Regtest).unwrap();
  assert_eq!(j.address, k["joint"]["address"].as_str().unwrap());
  assert_eq!(hex::encode(j.spend_pub), k["joint"]["spend_pub"].as_str().unwrap());
  assert_eq!(hex::encode(j.view_priv), k["joint"]["view_priv"].as_str().unwrap());
  assert_eq!(hex::encode(j.view_pub), k["joint"]["view_pub"].as_str().unwrap());
  // The joint spend key is the sum of the shares and opens the joint commitment.
  let s = add_scalars(&b32(&k["maker"]["spend"]), &b32(&k["taker"]["spend"])).unwrap();
  assert_eq!(hex::encode(s), k["joint"]["spend_priv"].as_str().unwrap());
  assert!(scalar_matches(&s, &j.spend_pub));
  assert!(scalar_matches(&b32(&k["maker"]["spend"]), &b32(&k["maker"]["spend_pub"])));
}

#[test]
fn sweep_selects_exactly_the_lock_output_and_ignores_dust() {
  let f = fixture();
  let c = case(&f, "dust-in-the-lock-block");
  let outputs = scan(&f, &c["input"]);
  // The scanner (monero-oxide) finds the same three outputs the pure-JS scan recorded.
  let mut found: Vec<(String, u64, u64)> = outputs.iter().map(|o| (hex::encode(o.transaction()), o.index_in_transaction(), o.commitment().amount)).collect();
  let mut expected: Vec<(String, u64, u64)> = c["output"]["outputs_to_joint"]
    .as_array()
    .unwrap()
    .iter()
    .map(|o| (o["txid"].as_str().unwrap().to_string(), o["index"].as_u64().unwrap(), o["amount"].as_str().unwrap().parse().unwrap()))
    .collect();
  found.sort();
  expected.sort();
  assert_eq!(found, expected);
  assert_eq!(found.len(), 3);

  let lock_txid = b32(&c["input"]["lock_txid"]);
  let lock_index = c["input"]["lock_output_index"].as_u64().unwrap();
  let (chosen, ignored) = select_output(outputs, &lock_txid, lock_index).unwrap();
  assert_eq!(hex::encode(chosen.transaction()), c["output"]["selected"]["txid"].as_str().unwrap());
  assert_eq!(chosen.index_in_transaction(), c["output"]["selected"]["index"].as_u64().unwrap());
  assert_eq!(chosen.commitment().amount.to_string(), c["output"]["selected"]["amount"].as_str().unwrap());
  assert_eq!(chosen.commitment().amount, 3_000_000_000_000, "the 3 XMR lock, not 3 XMR plus dust");
  let mut ignored_json: Vec<(String, String)> = c["output"]["ignored"].as_array().unwrap().iter().map(|i| (i["output"].as_str().unwrap().to_string(), i["amount"].as_str().unwrap().to_string())).collect();
  let mut ignored: Vec<(String, String)> = ignored.into_iter().map(|(id, amount)| (id, amount.to_string())).collect();
  ignored.sort();
  ignored_json.sort();
  assert_eq!(ignored, ignored_json);
  assert_eq!(ignored.len(), 2);
}

#[test]
fn naming_another_output() {
  let f = fixture();
  // A dust output named as the lock is selected as asked: the amount check is the verifier's
  // job, and the sweep then moves only that dust.
  let c = case(&f, "dust-output-named-as-the-lock");
  let (chosen, ignored) = select_output(scan(&f, &c["input"]), &b32(&c["input"]["lock_txid"]), c["input"]["lock_output_index"].as_u64().unwrap()).unwrap();
  let min: u64 = c["input"]["min_amount"].as_str().unwrap().parse().unwrap();
  assert!(chosen.commitment().amount < min);
  assert_eq!(ignored.len(), 2);
  assert!(ignored.iter().any(|(_, amount)| *amount == 3_000_000_000_000), "the real lock is among the ignored outputs");

  // An index of the lock transaction that does not pay the joint address.
  let c = case(&f, "no-such-output-in-the-block");
  assert_eq!(
    select_output(scan(&f, &c["input"]), &b32(&c["input"]["lock_txid"]), c["input"]["lock_output_index"].as_u64().unwrap()).unwrap_err(),
    SweepError::OutputNotFound
  );
  // A transaction that is not in the block at all.
  assert_eq!(select_output(scan(&f, &c["input"]), &[0xab; 32], 0).unwrap_err(), SweepError::OutputNotFound);
}

#[test]
fn duplicate_one_time_key_is_refused() {
  let f = fixture();
  let c = case(&f, "duplicate-output-key");
  assert_eq!(c["synthetic"], true);
  let outputs = scan(&f, &c["input"]);
  // The duplicate scans as a fourth output to the joint address, with the lock's one-time key.
  assert_eq!(outputs.len(), 4);
  let lock_txid = b32(&c["input"]["lock_txid"]);
  let lock_index = c["input"]["lock_output_index"].as_u64().unwrap();
  let lock_key = outputs.iter().find(|o| o.transaction() == lock_txid).unwrap().key();
  assert_eq!(outputs.iter().filter(|o| o.key() == lock_key).count(), 2);
  assert_eq!(select_output(outputs, &lock_txid, lock_index).unwrap_err(), SweepError::DuplicateOutputKey);
  // Naming the duplicate instead is refused as well: either spend burns the other.
  let dup_txid = b32(&c["input"]["txs"].as_array().unwrap().last().unwrap()["txid"]);
  assert_eq!(select_output(scan(&f, &c["input"]), &dup_txid, lock_index).unwrap_err(), SweepError::DuplicateOutputKey);
}

#[test]
fn fixture_has_the_cases_the_specification_names() {
  let f = fixture();
  for name in ["lock", "lock-with-additional-tx-keys", "dust-in-the-lock-block", "duplicate-output-key"] {
    case(&f, name);
  }
  // Raw transactions hash to their ids (keccak of the three parts), checked without the scanner.
  let c = case(&f, "lock");
  let blob = hex::decode(c["input"]["tx_hex"].as_str().unwrap()).unwrap();
  let tx = monero_wallet::transaction::Transaction::read(&mut blob.as_slice()).unwrap();
  assert_eq!(hex::encode(tx.hash()), c["input"]["txid"].as_str().unwrap());
  assert_eq!(c["output"]["unlock_time"], 0);
  assert_eq!(c["output"]["rct_type"], 6);
}
