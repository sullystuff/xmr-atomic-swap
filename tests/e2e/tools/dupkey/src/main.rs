//! `e2e-dupkey`: build a real Monero transaction with an output whose one-time key equals a key
//! the caller names (regtest test tool, scenario N-2 of docs/SPEC.md 9.4).
//!
//! How: monero-oxide derives a transaction's private key deterministically from an "outgoing view
//! key" and the inputs it spends, not from its destinations. So the same inputs with the same
//! outgoing view key always give the same transaction public key `R`. The tool builds a trial
//! transaction to learn `R` and the position `o` of the payment, then pays an address `(A', B')`
//! with `A' = a'G` (a throwaway view key) and
//!
//!     B' = P - Hs(8 a' R || o) G
//!
//! so that the standard output-key rule `Hs(8 r A' || o) G + B'` yields exactly `P`. Nobody holds
//! the spend key of `B'`; the output only exists to occupy the one-time key `P` a second time,
//! which is what a locker playing the duplicate-key trick puts on the chain.
//!
//!   e2e-dupkey keygen
//!   e2e-dupkey build '<json>'
//!     { "daemon": "http://127.0.0.1:48081", "spendKey": hex, "viewKey": hex,   (the funding address's keys)
//!       "fundHeight": n, "fundTxid": hex,                                      (the output that funds the transaction)
//!       "targetKey": hex,                                                      (the one-time key to duplicate)
//!       "publish": bool }
use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, edwards::CompressedEdwardsY, EdwardsPoint, Scalar as DScalar};
use monero_daemon_rpc::MoneroDaemon;
use monero_simple_request_rpc::SimpleRequestTransport;
use monero_wallet::{
  address::{AddressType, MoneroAddress, Network},
  ed25519::{Point, Scalar},
  extra::Extra,
  interface::prelude::*,
  ringct::RctType,
  send::{Change, SignableTransaction},
  transaction::Transaction,
  OutputWithDecoys,
};
use rand_core::{OsRng, RngCore};
use swap_core::sweep::{joint_view_pair, scan_block};
use zeroize::Zeroizing;

fn die(msg: impl AsRef<str>) -> ! {
  eprintln!("e2e-dupkey: {}", msg.as_ref());
  std::process::exit(1)
}
fn hex32(v: &serde_json::Value, key: &str) -> [u8; 32] {
  let s = v[key].as_str().unwrap_or_else(|| die(format!("missing {key}")));
  let b = hex::decode(s).unwrap_or_else(|_| die(format!("{key} is not hex")));
  b.try_into().unwrap_or_else(|_| die(format!("{key} is not 32 bytes")))
}
fn random_scalar() -> DScalar {
  let mut wide = [0u8; 64];
  OsRng.fill_bytes(&mut wide);
  DScalar::from_bytes_mod_order_wide(&wide)
}
fn base(s: &DScalar) -> EdwardsPoint {
  ED25519_BASEPOINT_TABLE * s
}
fn varint(mut n: usize, out: &mut Vec<u8>) {
  while n >= 0x80 {
    out.push((n as u8 & 0x7f) | 0x80);
    n >>= 7;
  }
  out.push(n as u8);
}
/// `Hs(8 a R || o)`: the shared scalar of output `o` for the holder of view key `a`.
fn shared(a: &DScalar, r_pub: &EdwardsPoint, o: usize) -> DScalar {
  let mut d = (r_pub * a).mul_by_cofactor().compress().to_bytes().to_vec();
  varint(o, &mut d);
  Scalar::hash(&d).into()
}
fn tx_pub(tx: &Transaction) -> EdwardsPoint {
  let extra = Extra::read(&mut tx.prefix().extra.as_slice()).unwrap_or_else(|_| die("the built transaction has no readable extra"));
  let (keys, _) = extra.keys().unwrap_or_else(|| die("the built transaction has no public key"));
  keys[0].into()
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  match args.get(1).map(String::as_str) {
    Some("keygen") => {
      let spend = random_scalar();
      let view = random_scalar();
      let pair = joint_view_pair(Point::from(base(&spend)), &view.to_bytes()).unwrap_or_else(|e| die(format!("{e:?}")));
      println!("{}", serde_json::json!({ "spendKey": hex::encode(spend.to_bytes()), "viewKey": hex::encode(view.to_bytes()), "address": pair.legacy_address(Network::Mainnet).to_string() }));
    }
    Some("build") => {
      let p: serde_json::Value = serde_json::from_str(args.get(2).unwrap_or_else(|| die("build needs a JSON argument"))).unwrap_or_else(|e| die(format!("bad JSON: {e}")));
      let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
      rt.block_on(build(p));
    }
    _ => die("usage: e2e-dupkey keygen | e2e-dupkey build '<json>'"),
  }
}

async fn build(p: serde_json::Value) {
  let url = p["daemon"].as_str().unwrap_or_else(|| die("missing daemon"));
  if !url.starts_with("http://127.0.0.1:") {
    die("loopback regtest nodes only");
  }
  let daemon: MoneroDaemon<_> = SimpleRequestTransport::new(url.to_string()).await.unwrap_or_else(|e| die(format!("daemon: {e:?}")));
  let spend = Zeroizing::new(Scalar::from(DScalar::from_canonical_bytes(hex32(&p, "spendKey")).into_option().unwrap_or_else(|| die("spendKey is not a scalar"))));
  let view = hex32(&p, "viewKey");
  let fund_txid = hex32(&p, "fundTxid");
  let fund_height = p["fundHeight"].as_u64().unwrap_or_else(|| die("missing fundHeight")) as usize;
  let target = CompressedEdwardsY(hex32(&p, "targetKey")).decompress().unwrap_or_else(|| die("targetKey is not a point"));

  let spend_d: DScalar = (*spend).into();
  let pair = joint_view_pair(Point::from(base(&spend_d)), &view).unwrap_or_else(|e| die(format!("{e:?}")));
  let tip = daemon.latest_block_number().await.unwrap_or_else(|e| die(format!("tip: {e:?}")));
  let block = daemon.scannable_block_by_number(fund_height).await.unwrap_or_else(|e| die(format!("block: {e:?}")));
  let output = scan_block(pair, block)
    .unwrap_or_else(|e| die(format!("scan: {e:?}")))
    .into_iter()
    .find(|o| o.transaction() == fund_txid)
    .unwrap_or_else(|| die("the funding output is not in that block"));
  let total = output.commitment().amount;
  let input = OutputWithDecoys::new(&mut OsRng, &daemon, 16, tip, output).await.unwrap_or_else(|e| die(format!("decoys: {e:?}")));
  let fee_rate = daemon.fee_rate(FeePriority::Normal, u64::MAX).await.unwrap_or_else(|e| die(format!("fee rate: {e:?}")));

  // One outgoing view key for every build: the transaction key depends on it and on the input only.
  let mut ovk = Zeroizing::new([0u8; 32]);
  OsRng.fill_bytes(ovk.as_mut());
  let a = random_scalar();
  let a_pub = base(&a);
  let dummy = MoneroAddress::new(Network::Mainnet, AddressType::Legacy, Point::from(base(&random_scalar())), Point::from(base(&random_scalar())));
  let make = |spend_pub: EdwardsPoint, amount: u64| {
    let dest = MoneroAddress::new(Network::Mainnet, AddressType::Legacy, Point::from(spend_pub), Point::from(a_pub));
    SignableTransaction::new(RctType::ClsagBulletproofPlus, ovk.clone(), vec![input.clone()], vec![(dest, amount), (dummy, 0)], Change::fingerprintable(None), vec![], fee_rate)
  };
  let trial_spend = base(&random_scalar());
  let fee = make(trial_spend, 1).unwrap_or_else(|e| die(format!("build: {e:?}"))).necessary_fee();
  let amount = total.checked_sub(fee).filter(|a| *a > 0).unwrap_or_else(|| die("the funding output does not cover the fee"));
  let trial = make(trial_spend, amount).unwrap_or_else(|e| die(format!("build: {e:?}"))).sign(&mut OsRng, &spend).unwrap_or_else(|e| die(format!("sign: {e:?}")));
  let r_pub = tx_pub(&trial);
  // Which output of the trial is the payment: the one whose key is Hs(8aR || o) G + trial_spend.
  let o = (0..trial.prefix().outputs.len())
    .find(|o| trial.prefix().outputs[*o].key.to_bytes() == (base(&shared(&a, &r_pub, *o)) + trial_spend).compress().to_bytes())
    .unwrap_or_else(|| die("the payment output was not found in the trial transaction"));

  let crafted_spend = target - base(&shared(&a, &r_pub, o));
  let tx = make(crafted_spend, amount).unwrap_or_else(|e| die(format!("build: {e:?}"))).sign(&mut OsRng, &spend).unwrap_or_else(|e| die(format!("sign: {e:?}")));
  if tx_pub(&tx) != r_pub {
    die("the transaction key changed between builds");
  }
  if tx.prefix().outputs[o].key.to_bytes() != target.compress().to_bytes() {
    die("the crafted output does not carry the target key");
  }
  let publish = p["publish"].as_bool().unwrap_or(false);
  if publish {
    daemon.publish_transaction(&tx).await.unwrap_or_else(|e| die(format!("publish: {e:?}")));
  }
  println!(
    "{}",
    serde_json::json!({ "txid": hex::encode(tx.hash()), "txHex": hex::encode(tx.serialize()), "outputIndex": o, "outputKey": hex::encode(tx.prefix().outputs[o].key.to_bytes()), "amount": amount.to_string(), "fee": fee.to_string(), "published": publish })
  );
}
