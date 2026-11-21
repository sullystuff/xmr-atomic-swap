//! SPEC 2.6: the secp256k1 twin of a spend share and its two address-form commitments.
//!
//! ```text
//! keyAddr  = address(s·G_secp)             = last 20 bytes of keccak256(X ‖ Y)
//! keyAddr2 = address((T2·s)·G_secp)        T2 = uint256(keccak256("xmr-atomic-swap/twin-key/2")) mod n
//! ```
//!
//! The contract checks a revealed `s` against both with `ecrecover` (`mulVerify2`). The second
//! address lifts the collision bound from 2^80 to 2^160.

use sigma_fun::secp256k1::fun::{g, marker::*, Point, Scalar, G};

use crate::{
  error::{Error, Result},
  primitives::{is_share_range, keccak256},
};

/// The ASCII string hashed to obtain `T2`.
pub const T2_TAG: &[u8] = b"xmr-atomic-swap/twin-key/2";

/// `T2 = uint256(keccak256("xmr-atomic-swap/twin-key/2")) mod n`.
pub fn t2() -> Scalar<Public, NonZero> {
  Scalar::<Public, Zero>::from_bytes_mod_order(keccak256(&[T2_TAG])).non_zero().expect("T2 is not zero")
}

/// The result of [`twin_commitments`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Twin {
  pub key_addr: [u8; 20],
  pub key_addr2: [u8; 20],
  pub secp_compressed: [u8; 33],
}

/// Ethereum address of a secp256k1 point: the last 20 bytes of `keccak256(X ‖ Y)`.
pub fn eth_address(p: &Point<Normal, Public, NonZero>) -> [u8; 20] {
  let (x, y) = p.coordinates();
  keccak256(&[&x, &y])[12..].try_into().unwrap()
}

/// A spend share (32 bytes little-endian, `0 < s < 2^252`) as a secp256k1 scalar. The same
/// integer is what the contract receives as `uint256 secret`.
pub fn secp_scalar(s_le: &[u8; 32]) -> Result<Scalar<Secret, NonZero>> {
  if !is_share_range(s_le) {
    return Err(Error::ScalarOutOfRange);
  }
  let mut be = *s_le;
  be.reverse();
  Scalar::<Secret, NonZero>::from_bytes(be).ok_or(Error::ScalarOutOfRange)
}

/// Both address commitments for a twin public key `P`. A verifier computes these itself from the
/// `P` a DLEQ proof verified for, and compares them with the on-chain values.
pub fn twin_addresses(p: &Point<Normal, Public, NonZero>) -> ([u8; 20], [u8; 20]) {
  let t2 = t2();
  let p2 = g!(t2 * p).normalize();
  (eth_address(p), eth_address(&p2))
}

/// `twinCommitments(s)`: the twin public key and both address commitments.
pub fn twin_commitments(s_le: &[u8; 32]) -> Result<Twin> {
  let s = secp_scalar(s_le)?;
  let p = g!(s * G).normalize();
  let (key_addr, key_addr2) = twin_addresses(&p);
  Ok(Twin { key_addr, key_addr2, secp_compressed: p.to_bytes() })
}

/// The integer of a share as the 32 big-endian bytes of a Solidity `uint256`.
pub fn share_as_uint256(s_le: &[u8; 32]) -> [u8; 32] {
  let mut be = *s_le;
  be.reverse();
  be
}

#[cfg(test)]
mod tests {
  use super::*;

  fn le(n: u128) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[..16].copy_from_slice(&n.to_le_bytes());
    b
  }

  #[test]
  fn known_addresses() {
    // Private key 1 and 2: the well-known Ethereum addresses.
    let t = twin_commitments(&le(1)).unwrap();
    assert_eq!(hex::encode(t.key_addr), "7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    assert_eq!(
      hex::encode(t.secp_compressed),
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    );
    let t = twin_commitments(&le(2)).unwrap();
    assert_eq!(hex::encode(t.key_addr), "2b5ad5c4795c026514f8317c7a215e218dccd6cf");
  }

  #[test]
  fn t2_definition() {
    // keccak256 of the tag, reduced mod n (the hash is below n, so no reduction happens here).
    let h = keccak256(&[T2_TAG]);
    assert_eq!(t2().to_bytes(), h);
    // Independent value: `cast keccak "xmr-atomic-swap/twin-key/2"`.
    assert_eq!(hex::encode(h), "ce9b14ee8f684ed20a8d03e126f8d1881fa813bd8b39e1328d6a80ace9c131ce");
  }

  #[test]
  fn second_commitment_is_address_of_t2_times_s() {
    // keyAddr2 for s equals keyAddr for (T2·s mod n).
    let s = le(0x1234_5678_9abc_def0);
    let t = twin_commitments(&s).unwrap();
    let s_secp = secp_scalar(&s).unwrap();
    let t2 = t2();
    let prod = sigma_fun::secp256k1::fun::s!(t2 * s_secp);
    let p = g!(prod * G).normalize();
    assert_eq!(eth_address(&p), t.key_addr2);
    assert_ne!(t.key_addr, t.key_addr2);
  }

  #[test]
  fn out_of_range_scalars_refused() {
    assert_eq!(twin_commitments(&[0u8; 32]), Err(Error::ScalarOutOfRange));
    let mut two252 = [0u8; 32];
    two252[31] = 0x10;
    assert_eq!(twin_commitments(&two252), Err(Error::ScalarOutOfRange));
    assert_eq!(twin_commitments(&crate::primitives::L_LE), Err(Error::ScalarOutOfRange));
    assert_eq!(twin_commitments(&[0xff; 32]), Err(Error::ScalarOutOfRange));
    let mut max = [0xffu8; 32];
    max[31] = 0x0f;
    assert!(twin_commitments(&max).is_ok());
  }

  #[test]
  fn uint256_form_is_big_endian() {
    assert_eq!(share_as_uint256(&le(1))[31], 1);
  }
}
