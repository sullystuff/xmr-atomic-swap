//! SPEC 2.11: sweep the joint Monero address once both spend halves are known.
//!
//! No wallet file and no chain sync: the caller verified the lock, so it knows the block, the
//! transaction and the output. The sweep scans that one block with the joint view key, spends
//! **exactly the output named by `lock_txid` and `output_index`**, picks decoys through the
//! daemon, and signs with `s = s_maker + s_taker`.
//!
//! Differences from the research prototype (`tests/monero-regtest/rust-sweep`):
//!
//! * Exact-output selection. The prototype spent every output to the joint address in the lock's
//!   block; whoever knows the address could add dust outputs, or a second output with the same
//!   one-time key, and make the automated sweep fail or burn the real output. Other outputs are
//!   reported in [`SweepOutcome::ignored`] and never spent automatically.
//! * `max_fee` is mandatory: the sweep fails rather than pay more.
//!
//! The core is generic over monero-oxide's daemon interface, so the same code runs natively
//! (HTTP via `monero-simple-request-rpc`) and in wasm32 (HTTP via the global `fetch`).

use core::fmt;

use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
use monero_wallet::{
  address::{AddressType, MoneroAddress, Network as OxideNetwork},
  ed25519::{Point, Scalar},
  interface::prelude::*,
  ringct::RctType,
  send::{Change, SendError, SignableTransaction},
  OutputWithDecoys, Scanner, ViewPair, WalletOutput,
};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::address::Network;

/// Monero's consensus rule: an output is spendable once it is 10 blocks deep.
pub const LOCK_WINDOW: usize = 10;
const RING_LEN: u8 = 16;
/// Callers pass `max(SWEEP_FEE_FLOOR, amount × SWEEP_FEE_CAP_BPS / 10,000)` as `max_fee`.
pub const SWEEP_FEE_FLOOR: u64 = 2_000_000_000;
pub const SWEEP_FEE_CAP_BPS: u64 = 50;

/// The default fee cap for a lock of `amount` piconero.
pub fn default_max_fee(amount: u64) -> u64 {
  SWEEP_FEE_FLOOR.max((amount as u128 * SWEEP_FEE_CAP_BPS as u128 / 10_000) as u64)
}

/// Everything a daemon must provide for a sweep. Implemented by `MoneroDaemon<T>` for any HTTP
/// transport.
pub trait MoneroDaemonRpc:
  ProvidesBlockchainMeta + ProvidesScannableBlocks + ProvidesDecoys + ProvidesFeeRates + PublishTransaction
{
}
impl<D> MoneroDaemonRpc for D where
  D: ProvidesBlockchainMeta + ProvidesScannableBlocks + ProvidesDecoys + ProvidesFeeRates + PublishTransaction
{
}

pub struct SweepParams {
  /// `s_maker + s_taker mod l`.
  pub spend_key: [u8; 32],
  /// `v_maker + v_taker mod l`.
  pub view_key: [u8; 32],
  /// Height (block number) of the block containing the lock transaction.
  pub lock_height: usize,
  /// The verified lock transaction.
  pub lock_txid: [u8; 32],
  /// Index of the verified output inside that transaction.
  pub output_index: u64,
  /// Standard address or subaddress.
  pub destination: String,
  pub network: Network,
  /// Piconero; the sweep fails rather than pay more.
  pub max_fee: u64,
  /// Broadcast the transaction. `false` builds and signs only.
  pub publish: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepOutcome {
  pub joint_address: String,
  pub txid: String,
  pub amount: u64,
  pub fee: u64,
  pub tx_hex: String,
  pub published: bool,
  /// Other outputs to the joint address in the lock's block, as (`"<txid>:<index>"`, amount).
  /// They were not spent.
  pub ignored: Vec<(String, u64)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SweepError {
  /// A key is not a canonical scalar, or the pair is not a usable view pair.
  InvalidKey(String),
  InvalidDestination(String),
  /// The daemon failed or returned something unusable.
  Daemon(String),
  /// The lock is not yet 10 blocks deep.
  Locked { confirmations: usize },
  /// The block holds no spendable output at `lock_txid`:`output_index` for the joint address.
  OutputNotFound,
  /// Another output to the joint address in the lock's block carries the same one-time key.
  /// Both share one key image; spending either burns the other.
  DuplicateOutputKey,
  /// The fee the node's rate implies is above `max_fee`.
  FeeAboveCap { fee: u64, max_fee: u64 },
  /// The output does not cover the fee.
  AmountBelowFee { amount: u64, fee: u64 },
  Build(String),
  Sign(String),
  Publish(String),
}

impl fmt::Display for SweepError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      SweepError::InvalidKey(e) => write!(f, "invalid key: {e}"),
      SweepError::InvalidDestination(e) => write!(f, "invalid destination: {e}"),
      SweepError::Daemon(e) => write!(f, "daemon: {e}"),
      SweepError::Locked { confirmations } => {
        write!(f, "lock has {confirmations} confirmations; outputs unlock at {LOCK_WINDOW}")
      }
      SweepError::OutputNotFound => write!(f, "the named lock output was not found for the joint address"),
      SweepError::DuplicateOutputKey => {
        write!(f, "another output in the lock's block has the same one-time key; refusing to spend")
      }
      SweepError::FeeAboveCap { fee, max_fee } => write!(f, "fee {fee} is above the cap {max_fee}"),
      SweepError::AmountBelowFee { amount, fee } => write!(f, "amount {amount} does not cover fee {fee}"),
      SweepError::Build(e) => write!(f, "build: {e}"),
      SweepError::Sign(e) => write!(f, "sign: {e}"),
      SweepError::Publish(e) => write!(f, "publish: {e}"),
    }
  }
}
impl std::error::Error for SweepError {}

fn scalar(bytes: &[u8; 32]) -> Result<Scalar, SweepError> {
  Scalar::read(&mut bytes.as_slice()).map_err(|_| SweepError::InvalidKey("non-canonical scalar".into()))
}
fn public(s: &Scalar) -> Point {
  Point::from(ED25519_BASEPOINT_TABLE * &(*s).into())
}
fn oxide_network(n: Network) -> OxideNetwork {
  match n {
    Network::Mainnet | Network::Regtest => OxideNetwork::Mainnet, // regtest uses mainnet prefixes
    Network::Stagenet => OxideNetwork::Stagenet,
    Network::Testnet => OxideNetwork::Testnet,
  }
}

/// The view pair of the joint wallet: public spend key and private view key.
pub fn joint_view_pair(spend_pub: Point, view_key: &[u8; 32]) -> Result<ViewPair, SweepError> {
  ViewPair::new(spend_pub, Zeroizing::new(scalar(view_key)?)).map_err(|e| SweepError::InvalidKey(format!("{e:?}")))
}

/// Scan one block for outputs to the joint address. Outputs with an additional timelock are
/// dropped (a lock with nonzero `unlock_time` is not a lock).
pub fn scan_block(pair: ViewPair, block: ScannableBlock) -> Result<Vec<WalletOutput>, SweepError> {
  Ok(Scanner::new(pair).scan(block).map_err(|e| SweepError::Daemon(format!("scan: {e:?}")))?.not_additionally_locked())
}

/// Exact-output selection: pick the output at `lock_txid`:`output_index` and report every other
/// output to the joint address as ignored. Refuses when another output shares its one-time key.
pub fn select_output(
  outputs: Vec<WalletOutput>,
  lock_txid: &[u8; 32],
  output_index: u64,
) -> Result<(WalletOutput, Vec<(String, u64)>), SweepError> {
  let position = outputs
    .iter()
    .position(|o| o.transaction() == *lock_txid && o.index_in_transaction() == output_index)
    .ok_or(SweepError::OutputNotFound)?;
  let key = outputs[position].key();
  let mut chosen = None;
  let mut ignored = Vec::new();
  for (i, o) in outputs.into_iter().enumerate() {
    if i == position {
      chosen = Some(o);
      continue;
    }
    if o.key() == key {
      return Err(SweepError::DuplicateOutputKey);
    }
    ignored.push((format!("{}:{}", hex::encode(o.transaction()), o.index_in_transaction()), o.commitment().amount));
  }
  Ok((chosen.expect("position is in range"), ignored))
}

/// `sweepJoint(params)`.
pub async fn sweep_joint<D: MoneroDaemonRpc>(daemon: &D, p: SweepParams) -> Result<SweepOutcome, SweepError> {
  let daemon_err = |what: &'static str| move |e: &dyn fmt::Debug| SweepError::Daemon(format!("{what}: {e:?}"));
  let spend = Zeroizing::new(scalar(&p.spend_key)?);
  let pair = joint_view_pair(public(&spend), &p.view_key)?;
  let network = oxide_network(p.network);
  let joint_address = pair.legacy_address(network).to_string();
  let destination =
    MoneroAddress::from_str(network, &p.destination).map_err(|e| SweepError::InvalidDestination(format!("{e:?}")))?;

  let tip = daemon.latest_block_number().await.map_err(|e| daemon_err("latest block")(&e))?;
  let confirmations = (tip + 1).saturating_sub(p.lock_height);
  if confirmations < LOCK_WINDOW {
    return Err(SweepError::Locked { confirmations });
  }

  // Scan the single block holding the lock transaction, then take exactly the named output.
  let block = daemon.scannable_block_by_number(p.lock_height).await.map_err(|e| daemon_err("fetch block")(&e))?;
  let (output, ignored) = select_output(scan_block(pair, block)?, &p.lock_txid, p.output_index)?;
  let total = output.commitment().amount;

  // Ring members. A dishonest node can bias these (privacy), but cannot steal.
  let input =
    OutputWithDecoys::new(&mut OsRng, daemon, RING_LEN, tip, output).await.map_err(|e| daemon_err("decoys")(&e))?;
  let fee_rate = daemon.fee_rate(FeePriority::Normal, u64::MAX).await.map_err(|e| daemon_err("fee rate")(&e))?;

  // Monero requires two outputs. Like wallet2's sweep we add a zero-amount output to a throwaway
  // address; everything else goes to the destination. Build once to learn the fee, then again
  // with the exact amount so nothing is left over.
  let dummy = MoneroAddress::new(
    network,
    AddressType::Legacy,
    public(&Scalar::random(&mut OsRng)),
    public(&Scalar::random(&mut OsRng)),
  );
  let build = |amount: u64| {
    let mut ovk = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(ovk.as_mut());
    SignableTransaction::new(
      RctType::ClsagBulletproofPlus,
      ovk,
      vec![input.clone()],
      vec![(destination, amount), (dummy, 0)],
      Change::fingerprintable(None),
      vec![],
      fee_rate,
    )
  };
  let fee = match build(1) {
    Ok(tx) => tx.necessary_fee(),
    // The output is smaller than the fee plus one piconero: the builder already knows the fee.
    Err(SendError::NotEnoughFunds { necessary_fee: Some(fee), .. }) => fee,
    Err(e) => return Err(SweepError::Build(format!("{e:?}"))),
  };
  // The fee comes from a rate the node chose: cap it before anything is signed.
  if fee > p.max_fee {
    return Err(SweepError::FeeAboveCap { fee, max_fee: p.max_fee });
  }
  let amount = total.checked_sub(fee).filter(|a| *a > 0).ok_or(SweepError::AmountBelowFee { amount: total, fee })?;
  let tx = build(amount)
    .map_err(|e| SweepError::Build(format!("{e:?}")))?
    .sign(&mut OsRng, &spend)
    .map_err(|e| SweepError::Sign(format!("{e:?}")))?;

  if p.publish {
    daemon.publish_transaction(&tx).await.map_err(|e| SweepError::Publish(format!("{e:?}")))?;
  }
  Ok(SweepOutcome {
    joint_address,
    txid: hex::encode(tx.hash()),
    amount,
    fee,
    tx_hex: hex::encode(tx.serialize()),
    published: p.publish,
    ignored,
  })
}

impl SweepOutcome {
  /// JSON with camelCase keys; amounts are decimal strings.
  pub fn to_json(&self) -> String {
    serde_json::json!({
      "jointAddress": self.joint_address,
      "txid": self.txid,
      "amount": self.amount.to_string(),
      "fee": self.fee.to_string(),
      "txHex": self.tx_hex,
      "published": self.published,
      "ignored": self.ignored.iter().map(|(id, amount)| serde_json::json!({ "output": id, "amount": amount.to_string() })).collect::<Vec<_>>(),
    })
    .to_string()
  }
}

/// Parse 32 bytes of hex.
pub fn parse_key(hex_str: &str) -> Result<[u8; 32], SweepError> {
  hex::decode(hex_str)
    .ok()
    .and_then(|v| <[u8; 32]>::try_from(v).ok())
    .ok_or_else(|| SweepError::InvalidKey("expected 32 bytes of hex".into()))
}

/// Build the block the scanner consumes from raw blobs: the block, its non-miner transactions
/// (full or pruned, in block order), and the global index of the block's first RingCT output.
/// Used to replay recorded regtest blocks (`monero_tx.json`) without a daemon.
pub fn scannable_block_from_blobs(
  block_blob: &[u8],
  tx_blobs: &[Vec<u8>],
  output_index_for_first_ringct_output: Option<u64>,
) -> Result<ScannableBlock, SweepError> {
  use monero_wallet::{
    block::Block,
    transaction::{Pruned, Transaction},
  };
  let bad = |what: &'static str| move |e: std::io::Error| SweepError::Daemon(format!("{what}: {e}"));
  let block = Block::read(&mut &block_blob[..]).map_err(bad("block"))?;
  let mut transactions = Vec::with_capacity(tx_blobs.len());
  for blob in tx_blobs {
    transactions.push(Transaction::<Pruned>::read(&mut blob.as_slice()).map_err(bad("transaction"))?);
  }
  Ok(ScannableBlock { block, transactions, output_index_for_first_ringct_output })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fee_cap_defaults() {
    // Below 400 XMR the floor applies; above, 0.5% of the amount.
    assert_eq!(default_max_fee(0), 2_000_000_000);
    assert_eq!(default_max_fee(1_000_000_000_000), 5_000_000_000);
    assert_eq!(default_max_fee(399_999_999_999), 2_000_000_000);
    assert_eq!(default_max_fee(400_000_000_000), 2_000_000_000);
    assert_eq!(default_max_fee(400_000_000_200), 2_000_000_001);
    assert_eq!(default_max_fee(u64::MAX), (u64::MAX as u128 * 50 / 10_000) as u64);
  }

  #[test]
  fn keys_and_networks() {
    assert!(parse_key("00").is_err());
    assert!(parse_key(&"zz".repeat(32)).is_err());
    assert_eq!(parse_key(&"01".repeat(32)).unwrap(), [1u8; 32]);
    assert!(scalar(&[0xff; 32]).is_err());
    assert!(matches!(oxide_network(Network::Regtest), OxideNetwork::Mainnet));
  }

  #[test]
  fn joint_address_matches_the_address_module() {
    // The sweep's address (monero-oxide) and SPEC 2.5's address (this crate) agree.
    let s_m = crate::primitives::clamp252(crate::primitives::sha256(&[b"sm"]));
    let s_t = crate::primitives::clamp252(crate::primitives::sha256(&[b"st"]));
    let v_m = crate::primitives::clamp252(crate::primitives::sha256(&[b"vm"]));
    let v_t = crate::primitives::clamp252(crate::primitives::sha256(&[b"vt"]));
    let pubkey = |s: &[u8; 32]| crate::primitives::ed_base_mul(&curve25519_dalek::scalar::Scalar::from_bytes_mod_order(*s));
    for network in [Network::Mainnet, Network::Stagenet, Network::Testnet, Network::Regtest] {
      let ours = crate::address::joint_address(&pubkey(&s_m), &pubkey(&s_t), &v_m, &v_t, network).unwrap();
      let spend = crate::point::add_scalars(&s_m, &s_t).unwrap();
      let pair = joint_view_pair(public(&scalar(&spend).unwrap()), &ours.view_priv).unwrap();
      assert_eq!(pair.legacy_address(oxide_network(network)).to_string(), ours.address);
    }
  }
}
