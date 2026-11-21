//! SPEC 2.1: domain separation, the two scalar reductions, and small byte helpers.

use curve25519_dalek::{
  constants::ED25519_BASEPOINT_POINT,
  edwards::{CompressedEdwardsY, EdwardsPoint},
  scalar::Scalar,
};
use sha2::{Digest, Sha256, Sha512};
use sha3::Keccak256;

use crate::error::{Error, Result};

/// Every domain-separation tag starts with this.
pub const DS_PREFIX: &[u8] = b"xmrswap/v1/";

/// `DS(tag)`: the ASCII bytes of `xmrswap/v1/`, then `tag`, then one `0x00` byte.
pub fn ds(tag: &str) -> Vec<u8> {
  let mut v = Vec::with_capacity(DS_PREFIX.len() + tag.len() + 1);
  v.extend_from_slice(DS_PREFIX);
  v.extend_from_slice(tag.as_bytes());
  v.push(0);
  v
}

/// `l = 2^252 + 27742317777372353535851937790883648493`, 32 bytes little-endian.
pub const L_LE: [u8; 32] = [
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

/// Chain tag inside key derivation: `0x01` Solana, `0x02` Ethereum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainTag {
  Solana = 1,
  Ethereum = 2,
}
impl ChainTag {
  pub fn from_u8(b: u8) -> Result<Self> {
    match b {
      1 => Ok(ChainTag::Solana),
      2 => Ok(ChainTag::Ethereum),
      _ => Err(Error::UnknownChainTag),
    }
  }
}

/// `clamp252(b)`: `b[31] &= 0x0f`, read little-endian. Always `< 2^252 < l < n`.
pub fn clamp252(mut b: [u8; 32]) -> [u8; 32] {
  b[31] &= 0x0f;
  b
}

/// True iff the 32 little-endian bytes are an integer in `0 < s < 2^252`.
pub fn is_share_range(s: &[u8; 32]) -> bool {
  s[31] & 0xf0 == 0 && s.iter().any(|b| *b != 0)
}

/// `wide(b)`: 64 bytes read little-endian, reduced mod `l`.
pub fn wide(b: &[u8; 64]) -> Scalar {
  Scalar::from_bytes_mod_order_wide(b)
}

/// Parse a canonical scalar (`< l`). Zero is allowed here; callers that need nonzero check it.
pub fn scalar_canonical(b: &[u8; 32]) -> Result<Scalar> {
  Option::<Scalar>::from(Scalar::from_canonical_bytes(*b)).ok_or(Error::ScalarNotCanonical)
}

/// Parse a canonical nonzero scalar.
pub fn scalar_nonzero(b: &[u8; 32]) -> Result<Scalar> {
  let s = scalar_canonical(b)?;
  if s == Scalar::ZERO {
    return Err(Error::ScalarZero);
  }
  Ok(s)
}

/// Parse a spend share: `0 < s < 2^252`.
pub fn spend_share(b: &[u8; 32]) -> Result<Scalar> {
  if !is_share_range(b) {
    return Err(Error::ScalarOutOfRange);
  }
  scalar_canonical(b)
}

/// `s·G` on ed25519, compressed.
pub fn ed_base_mul(s: &Scalar) -> [u8; 32] {
  (s * ED25519_BASEPOINT_POINT).compress().to_bytes()
}

/// Decompress the way the Solana syscalls do (`CompressedEdwardsY::decompress`). This accepts
/// some non-canonical encodings; use [`crate::point::validate_point`] for commitments.
pub fn ed_decompress(p: &[u8; 32]) -> Option<EdwardsPoint> {
  CompressedEdwardsY(*p).decompress()
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
  let mut h = Sha256::new();
  for p in parts {
    h.update(p);
  }
  h.finalize().into()
}

pub fn sha512(parts: &[&[u8]]) -> [u8; 64] {
  let mut h = Sha512::new();
  for p in parts {
    h.update(p);
  }
  h.finalize().into()
}

pub fn keccak256(parts: &[&[u8]]) -> [u8; 32] {
  let mut h = Keccak256::new();
  for p in parts {
    h.update(p);
  }
  h.finalize().into()
}

/// Copy a slice into a fixed array, or `BadLength`.
pub fn arr<const N: usize>(b: &[u8]) -> Result<[u8; N]> {
  <[u8; N]>::try_from(b).map_err(|_| Error::BadLength)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ds_layout() {
    assert_eq!(ds("pok"), b"xmrswap/v1/pok\0");
    // SPEC 2.9: DS("sol-approval") is exactly 24 bytes.
    assert_eq!(ds("sol-approval").len(), 24);
  }

  #[test]
  fn clamp_and_range() {
    let c = clamp252([0xff; 32]);
    assert_eq!(c[31], 0x0f);
    assert!(is_share_range(&c));
    assert!(!is_share_range(&[0u8; 32]));
    let mut top = [0u8; 32];
    top[31] = 0x10; // exactly 2^252
    assert!(!is_share_range(&top));
    assert_eq!(spend_share(&top), Err(Error::ScalarOutOfRange));
    // 2^252 - 1 is the largest share and is below l.
    assert!(spend_share(&c).is_ok());
  }

  #[test]
  fn canonical_scalars() {
    // l itself, l + 1 and 2^256 - 1 are not canonical; l - 1 is.
    let l: [u8; 32] = [
      0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
    ];
    assert_eq!(scalar_canonical(&l), Err(Error::ScalarNotCanonical));
    let mut l1 = l;
    l1[0] += 1;
    assert_eq!(scalar_canonical(&l1), Err(Error::ScalarNotCanonical));
    assert_eq!(scalar_canonical(&[0xff; 32]), Err(Error::ScalarNotCanonical));
    let mut lm1 = l;
    lm1[0] -= 1;
    assert!(scalar_canonical(&lm1).is_ok());
    assert_eq!(scalar_nonzero(&[0u8; 32]), Err(Error::ScalarZero));
  }

  #[test]
  fn wide_reduces() {
    // 2^256 mod l, from the definition: wide(1 << 256) == Scalar(2^128)^2.
    let mut b = [0u8; 64];
    b[32] = 1;
    let two128 = Scalar::from(u128::MAX) + Scalar::ONE;
    assert_eq!(wide(&b), two128 * two128);
  }

  #[test]
  fn basepoint_is_monero_g() {
    let mut g = [0x66u8; 32];
    g[0] = 0x58;
    assert_eq!(ed_base_mul(&Scalar::ONE), g);
  }

  #[test]
  fn hashes_known_answers() {
    assert_eq!(
      hex::encode(sha256(&[b"abc"])),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
      hex::encode(keccak256(&[b""])),
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
    assert_eq!(
      hex::encode(&sha512(&[b"abc"])[..8]),
      "ddaf35a193617aba"
    );
  }
}
