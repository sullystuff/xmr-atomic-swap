//! SPEC 2.5: the joint Monero address.
//!
//! ```text
//! S = S_maker + S_taker            v = v_maker + v_taker mod l            V = v·G
//! address = monero_base58( varint(prefix) ‖ S ‖ V ‖ keccak256(varint(prefix) ‖ S ‖ V)[0..4] )
//! ```
//!
//! Always a standard address. Each client recomputes it from the four halves and never trusts an
//! address sent by the other side.

use curve25519_dalek::{scalar::Scalar, traits::IsIdentity};

use crate::{
  error::{Error, Result},
  point::commitment,
  primitives::{ed_base_mul, keccak256, scalar_nonzero},
};

/// Monero network. Regtest ("fakechain") uses the mainnet prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
  Mainnet,
  Stagenet,
  Testnet,
  Regtest,
}

impl Network {
  pub fn parse(s: &str) -> Result<Self> {
    match s {
      "mainnet" => Ok(Network::Mainnet),
      "stagenet" => Ok(Network::Stagenet),
      "testnet" => Ok(Network::Testnet),
      "regtest" => Ok(Network::Regtest),
      _ => Err(Error::UnknownNetwork),
    }
  }
  pub fn name(self) -> &'static str {
    match self {
      Network::Mainnet => "mainnet",
      Network::Stagenet => "stagenet",
      Network::Testnet => "testnet",
      Network::Regtest => "regtest",
    }
  }
  /// Prefix byte of a standard address.
  pub fn standard_prefix(self) -> u8 {
    match self {
      Network::Mainnet | Network::Regtest => 18,
      Network::Stagenet => 24,
      Network::Testnet => 53,
    }
  }
}

const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/// Characters needed for a block of 0..=8 input bytes.
const ENC_BLOCK: [usize; 9] = [0, 2, 3, 5, 6, 7, 9, 10, 11];

/// Monero base58: 8-byte blocks to 11 characters, big-endian; a final 5-byte block to 7.
pub fn monero_base58(data: &[u8]) -> String {
  let mut out = String::new();
  for block in data.chunks(8) {
    let mut n = 0u128;
    for b in block {
      n = (n << 8) | *b as u128;
    }
    let len = ENC_BLOCK[block.len()];
    let mut chars = vec![b'1'; len];
    for i in (0..len).rev() {
      chars[i] = B58[(n % 58) as usize];
      n /= 58;
    }
    out.push_str(core::str::from_utf8(&chars).unwrap());
  }
  out
}

/// Inverse of [`monero_base58`]. `None` on a bad character, length or overflowing block.
pub fn monero_base58_decode(s: &str) -> Option<Vec<u8>> {
  let mut out = Vec::new();
  for block in s.as_bytes().chunks(11) {
    let size = ENC_BLOCK.iter().position(|l| *l == block.len()).filter(|s| *s > 0)?;
    let mut n = 0u128;
    for c in block {
      n = n.checked_mul(58)?.checked_add(B58.iter().position(|b| b == c)? as u128)?;
    }
    if size < 16 && n >> (8 * size) != 0 {
      return None;
    }
    for k in (0..size).rev() {
      out.push((n >> (8 * k)) as u8);
    }
  }
  Some(out)
}

/// Standard address for a public spend key and public view key.
pub fn encode_address(spend_pub: &[u8; 32], view_pub: &[u8; 32], network: Network) -> String {
  // Every prefix used here is below 0x80, so varint(prefix) is the single byte.
  let mut body = Vec::with_capacity(69);
  body.push(network.standard_prefix());
  body.extend_from_slice(spend_pub);
  body.extend_from_slice(view_pub);
  let check = keccak256(&[&body]);
  body.extend_from_slice(&check[..4]);
  monero_base58(&body)
}

/// The result of [`joint_address`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JointAddress {
  pub address: String,
  /// `S = S_a + S_b`.
  pub spend_pub: [u8; 32],
  /// `v = v_a + v_b mod l`. With it anyone can scan for the lock; it cannot spend.
  pub view_priv: [u8; 32],
  /// `V = v·G`.
  pub view_pub: [u8; 32],
}

/// `jointAddress(spendPubA, spendPubB, viewA, viewB, network)`.
///
/// Rejects a spend half that is not a valid key commitment, a view half that is zero or not
/// canonical, a zero view sum and an identity spend sum.
pub fn joint_address(
  spend_pub_a: &[u8; 32],
  spend_pub_b: &[u8; 32],
  view_a: &[u8; 32],
  view_b: &[u8; 32],
  network: Network,
) -> Result<JointAddress> {
  let s = commitment(spend_pub_a)? + commitment(spend_pub_b)?;
  if s.is_identity() {
    return Err(Error::JointKeyDegenerate);
  }
  let v: Scalar = scalar_nonzero(view_a)? + scalar_nonzero(view_b)?;
  if v == Scalar::ZERO {
    return Err(Error::JointKeyDegenerate);
  }
  let spend_pub = s.compress().to_bytes();
  let view_pub = ed_base_mul(&v);
  Ok(JointAddress { address: encode_address(&spend_pub, &view_pub, network), spend_pub, view_priv: v.to_bytes(), view_pub })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn h(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
  }

  // The vector of docs/research/monero.md section 1, produced by the regtest harness and
  // cross-checked there against monero-wallet-rpc.
  const S_MAKER: &str = "6f863e268cff9390a698f23843f802584c7bd2e3bc74593e60dd4138da1de31c";
  const S_TAKER: &str = "07c805e21c0057430b82a791f66fdc0d185d398e4f8fb73a955b6bada1ac88d9";
  const V_MAKER: &str = "c6367a52bf1ab84df6e44d2f4b5a12fa490bf9351654a5b610f568122e5b7002";
  const V_TAKER: &str = "2f246ff530c01376f39b9e2e95e9dcd953e6020a2b984bad02203c4e596c5906";

  #[test]
  fn research_vector() {
    let j = joint_address(&h(S_MAKER), &h(S_TAKER), &h(V_MAKER), &h(V_TAKER), Network::Mainnet).unwrap();
    assert_eq!(hex::encode(j.spend_pub), "2db092644300d969e9c5f82caffedc48767ad40d341cc4ee7187731aa072b5b4");
    assert_eq!(hex::encode(j.view_priv), "f55ae947f0dacbc3e980ec5de043efd39df1fb3f41ecf0631315a56087c7c908");
    assert_eq!(hex::encode(j.view_pub), "fb9cea73d65c85a70877f532feebb8fe021f43f2fc2e9a79710f1e793765e8b5");
    assert_eq!(
      j.address,
      "43MXoVqwCynJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXkmBPX"
    );
    let stage = joint_address(&h(S_MAKER), &h(S_TAKER), &h(V_MAKER), &h(V_TAKER), Network::Stagenet).unwrap();
    assert_eq!(
      stage.address,
      "53ZZtLktratJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXm9Npw"
    );
    let test = joint_address(&h(S_MAKER), &h(S_TAKER), &h(V_MAKER), &h(V_TAKER), Network::Testnet).unwrap();
    assert_eq!(
      test.address,
      "9tu5HkWCVLtJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMV285eg"
    );
    // Regtest reuses the mainnet prefix.
    let reg = joint_address(&h(S_MAKER), &h(S_TAKER), &h(V_MAKER), &h(V_TAKER), Network::Regtest).unwrap();
    assert_eq!(reg.address, j.address);
    // Order of the halves does not matter.
    let swapped = joint_address(&h(S_TAKER), &h(S_MAKER), &h(V_TAKER), &h(V_MAKER), Network::Mainnet).unwrap();
    assert_eq!(swapped, j);
  }

  #[test]
  fn base58_round_trip_and_shape() {
    let j = joint_address(&h(S_MAKER), &h(S_TAKER), &h(V_MAKER), &h(V_TAKER), Network::Mainnet).unwrap();
    assert_eq!(j.address.len(), 95);
    let raw = monero_base58_decode(&j.address).unwrap();
    assert_eq!(raw.len(), 69);
    assert_eq!(raw[0], 18);
    assert_eq!(&raw[1..33], &j.spend_pub);
    assert_eq!(&raw[33..65], &j.view_pub);
    assert_eq!(&raw[65..], &keccak256(&[&raw[..65]])[..4]);
    assert_eq!(monero_base58(&raw), j.address);
    assert!(monero_base58_decode("0OIl").is_none());
    assert!(monero_base58_decode("1").is_none());
    // An 11-character block that overflows 8 bytes.
    assert!(monero_base58_decode("zzzzzzzzzzz").is_none());
  }

  #[test]
  fn degenerate_inputs_rejected() {
    let (sm, st, vm, vt) = (h(S_MAKER), h(S_TAKER), h(V_MAKER), h(V_TAKER));
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert_eq!(joint_address(&identity, &st, &vm, &vt, Network::Mainnet), Err(Error::InvalidKeyCommitment));
    for t in crate::point::small_order_points() {
      assert_eq!(joint_address(&sm, &t, &vm, &vt, Network::Mainnet), Err(Error::InvalidKeyCommitment));
    }
    // S_b = −S_a: the sum is the identity.
    let neg = (-crate::primitives::ed_decompress(&sm).unwrap()).compress().to_bytes();
    assert_eq!(joint_address(&sm, &neg, &vm, &vt, Network::Mainnet), Err(Error::JointKeyDegenerate));
    // Zero and non-canonical view halves.
    assert_eq!(joint_address(&sm, &st, &[0u8; 32], &vt, Network::Mainnet), Err(Error::ScalarZero));
    assert_eq!(joint_address(&sm, &st, &vm, &[0xff; 32], Network::Mainnet), Err(Error::ScalarNotCanonical));
    assert_eq!(
      joint_address(&sm, &st, &vm, &crate::primitives::L_LE, Network::Mainnet),
      Err(Error::ScalarNotCanonical)
    );
    // v_b = −v_a: the joint view key would be zero.
    let neg_v = (-Scalar::from_bytes_mod_order(vm)).to_bytes();
    assert_eq!(joint_address(&sm, &st, &vm, &neg_v, Network::Mainnet), Err(Error::JointKeyDegenerate));
  }

  #[test]
  fn network_names() {
    for n in [Network::Mainnet, Network::Stagenet, Network::Testnet, Network::Regtest] {
      assert_eq!(Network::parse(n.name()).unwrap(), n);
    }
    assert_eq!(Network::parse("devnet"), Err(Error::UnknownNetwork));
  }
}
