//! Sweep a 2-of-2 joint Monero address once both spend-key halves are known.
//!
//! No wallet file and no chain sync: the caller already knows which block holds the lock
//! transaction (it verified the lock), so we scan that one block with the joint view key, pick
//! decoys through the daemon, and sign with `s = s_maker + s_taker`.
//!
//! The core is generic over monero-oxide's daemon interface, so the same code runs natively
//! (maker daemon; HTTP via `monero-simple-request-rpc`) and in a browser tab (wasm32; HTTP via
//! `fetch`, see `wasm.rs`).

use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
use monero_wallet::{
  address::{AddressType, MoneroAddress, Network},
  ed25519::{Point, Scalar},
  interface::prelude::*,
  ringct::RctType,
  send::{Change, SignableTransaction},
  OutputWithDecoys, Scanner, ViewPair,
};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

#[cfg(target_arch = "wasm32")]
mod wasm;

/// Monero's consensus rule: an output is spendable once it is 10 blocks deep.
pub const LOCK_WINDOW: usize = 10;
const RING_LEN: u8 = 16;

pub struct SweepParams {
  /// `s_maker + s_taker` (little-endian canonical scalar).
  pub spend_key: [u8; 32],
  /// `v_maker + v_taker`.
  pub view_key: [u8; 32],
  /// Height (block number) of the block containing the lock transaction.
  pub lock_height: usize,
  /// Destination address (standard or subaddress).
  pub destination: String,
  pub network: Network,
  /// Broadcast the transaction. `false` builds and signs only.
  pub publish: bool,
}

#[derive(Debug)]
pub struct SweepOutcome {
  pub joint_address: String,
  pub txid: String,
  pub amount: u64,
  pub fee: u64,
  pub inputs: usize,
  pub published: bool,
  pub tx_hex: String,
}

fn scalar(bytes: &[u8; 32]) -> Result<Scalar, String> {
  Scalar::read(&mut bytes.as_slice()).map_err(|_| "non-canonical scalar".to_string())
}
fn public(s: &Scalar) -> Point {
  Point::from(ED25519_BASEPOINT_TABLE * &(*s).into())
}

pub async fn sweep_joint<D>(daemon: &D, p: SweepParams) -> Result<SweepOutcome, String>
where
  D: ProvidesBlockchainMeta + ProvidesScannableBlocks + ProvidesDecoys + ProvidesFeeRates + PublishTransaction,
{
  let e = |what: &'static str| move |err: &dyn core::fmt::Debug| format!("{what}: {err:?}");
  let spend = Zeroizing::new(scalar(&p.spend_key)?);
  let view = Zeroizing::new(scalar(&p.view_key)?);
  let pair = ViewPair::new(public(&spend), view).map_err(|x| e("view pair")(&x))?;
  let joint_address = pair.legacy_address(p.network).to_string();
  let destination = MoneroAddress::from_str(p.network, &p.destination).map_err(|x| e("destination")(&x))?;

  let tip = daemon.latest_block_number().await.map_err(|x| e("latest block")(&x))?;
  let confirmations = (tip + 1).saturating_sub(p.lock_height);
  if confirmations < LOCK_WINDOW {
    return Err(format!("lock has {confirmations} confirmations; outputs unlock at {LOCK_WINDOW}"));
  }

  // Scan the single block holding the lock transaction.
  let block = daemon.scannable_block_by_number(p.lock_height).await.map_err(|x| e("fetch block")(&x))?;
  let outputs = Scanner::new(pair).scan(block).map_err(|x| e("scan")(&x))?.not_additionally_locked();
  if outputs.is_empty() {
    return Err(format!("no spendable output for {joint_address} in block {}", p.lock_height));
  }
  let total: u64 = outputs.iter().map(|o| o.commitment().amount).sum();

  // Ring members. A dishonest node can bias these (privacy), but cannot steal.
  let mut inputs = Vec::with_capacity(outputs.len());
  for output in outputs {
    inputs.push(OutputWithDecoys::new(&mut OsRng, daemon, RING_LEN, tip, output).await.map_err(|x| e("decoys")(&x))?);
  }
  let fee_rate = daemon.fee_rate(FeePriority::Normal, u64::MAX).await.map_err(|x| e("fee rate")(&x))?;

  // Monero requires two outputs. Like wallet2's sweep we add a zero-amount output to a throwaway
  // address; everything else goes to the destination. Build once to learn the fee, then again
  // with the exact amount so nothing is left over.
  let dummy = MoneroAddress::new(p.network, AddressType::Legacy, public(&Scalar::random(&mut OsRng)), public(&Scalar::random(&mut OsRng)));
  let build = |amount: u64| {
    let mut ovk = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(ovk.as_mut());
    SignableTransaction::new(
      RctType::ClsagBulletproofPlus,
      ovk,
      inputs.clone(),
      vec![(destination, amount), (dummy, 0)],
      Change::fingerprintable(None),
      vec![],
      fee_rate,
    )
  };
  let fee = build(1).map_err(|x| e("build")(&x))?.necessary_fee();
  let amount = total.checked_sub(fee).filter(|a| *a > 0).ok_or(format!("balance {total} does not cover fee {fee}"))?;
  let tx = build(amount).map_err(|x| e("build")(&x))?.sign(&mut OsRng, &spend).map_err(|x| e("sign")(&x))?;

  if p.publish {
    daemon.publish_transaction(&tx).await.map_err(|x| e("publish")(&x))?;
  }
  Ok(SweepOutcome {
    joint_address,
    txid: hex::encode(tx.hash()),
    amount,
    fee,
    inputs: inputs.len(),
    published: p.publish,
    tx_hex: hex::encode(tx.serialize()),
  })
}

pub fn parse_key(hex_str: &str) -> Result<[u8; 32], String> {
  hex::decode(hex_str).ok().and_then(|v| <[u8; 32]>::try_from(v).ok()).ok_or_else(|| "key must be 32 bytes of hex".to_string())
}
pub fn parse_network(s: &str) -> Result<Network, String> {
  match s {
    "mainnet" | "regtest" => Ok(Network::Mainnet), // regtest uses mainnet address prefixes
    "stagenet" => Ok(Network::Stagenet),
    "testnet" => Ok(Network::Testnet),
    _ => Err(format!("unknown network {s}")),
  }
}
impl SweepOutcome {
  pub fn to_json(&self) -> String {
    format!(
      r#"{{"jointAddress":"{}","txid":"{}","amount":"{}","fee":"{}","inputs":{},"published":{},"txHex":"{}"}}"#,
      self.joint_address, self.txid, self.amount, self.fee, self.inputs, self.published, self.tx_hex
    )
  }
}
