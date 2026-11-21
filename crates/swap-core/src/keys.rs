//! SPEC 2.2: key shares and everything else derived from a 32-byte seed.
//!
//! ```text
//! okm(label) = HKDF-SHA256(ikm = seed, salt = DS("kdf"), info = label ‖ 0x00 ‖ chain_tag ‖ share_id[16], L = 64)
//!
//! spend   s = clamp252(okm("spend")[0..32])     reject (the share_id is burned) if s == 0
//! view    v = wide(okm("view"))                 reject if v == 0
//! session   = okm("session")[0..32]             Solana: Ed25519 seed
//!                                               Ethereum: 1 + (big-endian(okm("session")[0..48]) mod (n − 1))
//! enc     e = okm("enc")[0..32]                 X25519 static secret
//! ```

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{
  error::{Error, Result},
  primitives::{clamp252, ds, ed_base_mul, sha256, wide, ChainTag},
  sign::{ed25519_public, eth_address_of_secret},
};

/// Everything a party derives for one share id.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct DerivedKeys {
  /// Spend share `s`, 32 bytes little-endian, `0 < s < 2^252`.
  pub spend: [u8; 32],
  /// `S = s·G`.
  #[zeroize(skip)]
  pub spend_pub: [u8; 32],
  /// View share `v`, canonical and nonzero.
  pub view: [u8; 32],
  /// Solana: the 32-byte Ed25519 seed. Ethereum: the secp256k1 private key, 32 bytes big-endian.
  pub session_secret: [u8; 32],
  /// Solana: the 32-byte Ed25519 public key. Ethereum: the 20-byte address.
  #[zeroize(skip)]
  pub session_pub: Vec<u8>,
  /// X25519 static secret (unclamped bytes; X25519 clamps on use).
  pub enc_secret: [u8; 32],
  #[zeroize(skip)]
  pub enc_pub: [u8; 32],
}

/// `okm(label)`.
pub fn okm(seed: &[u8; 32], label: &str, chain: ChainTag, share_id: &[u8; 16]) -> [u8; 64] {
  let mut info = Vec::with_capacity(label.len() + 18);
  info.extend_from_slice(label.as_bytes());
  info.push(0);
  info.push(chain as u8);
  info.extend_from_slice(share_id);
  let mut out = [0u8; 64];
  Hkdf::<Sha256>::new(Some(&ds("kdf")), seed).expand(&info, &mut out).expect("64 bytes is a valid HKDF length");
  out
}

/// `n − 1` for secp256k1, as five little-endian 64-bit limbs.
const N_MINUS_1: [u64; 5] =
  [0xBFD2_5E8C_D036_4140, 0xBAAE_DCE6_AF48_A03B, 0xFFFF_FFFF_FFFF_FFFE, 0xFFFF_FFFF_FFFF_FFFF, 0];

fn geq(a: &[u64; 5], b: &[u64; 5]) -> bool {
  for i in (0..5).rev() {
    if a[i] != b[i] {
      return a[i] > b[i];
    }
  }
  true
}
fn sub(a: &mut [u64; 5], b: &[u64; 5]) {
  let mut borrow = 0u64;
  for i in 0..5 {
    let (d, b1) = a[i].overflowing_sub(b[i]);
    let (d, b2) = d.overflowing_sub(borrow);
    a[i] = d;
    borrow = (b1 | b2) as u64;
  }
}
fn shl(a: &[u64; 5], bits: u32) -> [u64; 5] {
  let mut out = [0u64; 5];
  for i in 0..5 {
    out[i] = a[i] << bits;
    if bits > 0 && i > 0 {
      out[i] |= a[i - 1] >> (64 - bits);
    }
  }
  out
}

/// `1 + (big-endian(bytes) mod (n − 1))` as 32 big-endian bytes: a uniformly distributed valid
/// secp256k1 private key (the 384-bit input makes the bias negligible).
pub fn secp_secret_from_wide(bytes: &[u8; 48]) -> [u8; 32] {
  let mut r = [0u64; 5];
  for &byte in bytes {
    // r = r·256 + byte, then reduce. r < n − 1 < 2^256, so r·256 + byte < 2^264 fits five limbs.
    r = shl(&r, 8);
    r[0] |= byte as u64;
    for shift in (0..8).rev() {
      let m = shl(&N_MINUS_1, shift);
      if geq(&r, &m) {
        sub(&mut r, &m);
      }
    }
  }
  // + 1
  let mut i = 0;
  loop {
    let (v, c) = r[i].overflowing_add(1);
    r[i] = v;
    if !c {
      break;
    }
    i += 1;
  }
  let mut out = [0u8; 32];
  for i in 0..4 {
    out[32 - 8 * (i + 1)..32 - 8 * i].copy_from_slice(&r[i].to_be_bytes());
  }
  out
}

/// `deriveKeys(seed, chainTag, shareId)`.
pub fn derive_keys(seed: &[u8; 32], chain: ChainTag, share_id: &[u8; 16]) -> Result<DerivedKeys> {
  let mut o = okm(seed, "spend", chain, share_id);
  let spend = clamp252(o[..32].try_into().unwrap());
  o.zeroize();
  if spend == [0u8; 32] {
    return Err(Error::ScalarZero);
  }
  let spend_scalar = curve25519_dalek::scalar::Scalar::from_bytes_mod_order(spend);

  let mut o = okm(seed, "view", chain, share_id);
  let view = wide(&o);
  o.zeroize();
  if view == curve25519_dalek::scalar::Scalar::ZERO {
    return Err(Error::ScalarZero);
  }

  let mut o = okm(seed, "session", chain, share_id);
  let (session_secret, session_pub) = match chain {
    ChainTag::Solana => {
      let seed: [u8; 32] = o[..32].try_into().unwrap();
      (seed, ed25519_public(&seed).to_vec())
    }
    ChainTag::Ethereum => {
      let secret = secp_secret_from_wide(o[..48].try_into().unwrap());
      let addr = eth_address_of_secret(&secret).expect("1 + (x mod (n - 1)) is a valid key");
      (secret, addr.to_vec())
    }
  };
  o.zeroize();

  let mut o = okm(seed, "enc", chain, share_id);
  let enc_secret: [u8; 32] = o[..32].try_into().unwrap();
  o.zeroize();
  let enc_pub = crate::envelope::x25519_public(&enc_secret);

  Ok(DerivedKeys {
    spend,
    spend_pub: ed_base_mul(&spend_scalar),
    view: view.to_bytes(),
    session_secret,
    session_pub,
    enc_secret,
    enc_pub,
  })
}

/// Share id of the per-maker contact key: `SHA256(DS("contact") ‖ maker PDA)[0..16]`. The key
/// itself is `derive_keys(seed, ChainTag::Solana, id).enc_*`.
pub fn contact_share_id(maker_pda: &[u8; 32]) -> [u8; 16] {
  sha256(&[&ds("contact"), maker_pda])[..16].try_into().unwrap()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::primitives::is_share_range;

  #[test]
  fn hkdf_rfc5869_case_1() {
    // RFC 5869 A.1, to pin the primitive under `okm`.
    let ikm = [0x0bu8; 22];
    let salt: Vec<u8> = (0u8..=0x0c).collect();
    let info: Vec<u8> = (0xf0u8..=0xf9).collect();
    let mut out = [0u8; 42];
    Hkdf::<Sha256>::new(Some(&salt), &ikm).expand(&info, &mut out).unwrap();
    assert_eq!(
      hex::encode(out),
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
  }

  #[test]
  fn derivation_is_deterministic_and_domain_separated() {
    let seed = [1u8; 32];
    let id = [2u8; 16];
    let a = derive_keys(&seed, ChainTag::Solana, &id).unwrap();
    let b = derive_keys(&seed, ChainTag::Solana, &id).unwrap();
    assert_eq!(a.spend, b.spend);
    assert!(is_share_range(&a.spend));
    assert!(crate::point::scalar_matches(&a.spend, &a.spend_pub));
    assert!(crate::point::validate_point(&a.spend_pub));
    assert_eq!(a.session_pub.len(), 32);
    // Every output differs from every other (labels separate them).
    let all = [a.spend, a.view, a.session_secret, a.enc_secret];
    for i in 0..4 {
      for j in 0..i {
        assert_ne!(all[i], all[j]);
      }
    }
    // The chain tag keeps Solana and Ethereum shares disjoint.
    let e = derive_keys(&seed, ChainTag::Ethereum, &id).unwrap();
    assert_ne!(a.spend, e.spend);
    assert_ne!(a.view, e.view);
    assert_ne!(a.enc_secret, e.enc_secret);
    assert_eq!(e.session_pub.len(), 20);
    // A different share id or seed gives different shares.
    let other = derive_keys(&seed, ChainTag::Solana, &[3u8; 16]).unwrap();
    assert_ne!(a.spend, other.spend);
    let other = derive_keys(&[9u8; 32], ChainTag::Solana, &id).unwrap();
    assert_ne!(a.spend, other.spend);
  }

  #[test]
  fn okm_info_layout() {
    // info = label ‖ 0x00 ‖ chain_tag ‖ share_id; checked against a direct HKDF call.
    let seed = [5u8; 32];
    let id: [u8; 16] = core::array::from_fn(|i| i as u8);
    let mut info = b"spend".to_vec();
    info.extend_from_slice(&[0, 2]);
    info.extend_from_slice(&id);
    let mut direct = [0u8; 64];
    Hkdf::<Sha256>::new(Some(b"xmrswap/v1/kdf\0"), &seed).expand(&info, &mut direct).unwrap();
    assert_eq!(okm(&seed, "spend", ChainTag::Ethereum, &id), direct);
  }

  #[test]
  fn secp_secret_reduction() {
    // 0 -> 1.
    let mut one = [0u8; 32];
    one[31] = 1;
    assert_eq!(secp_secret_from_wide(&[0u8; 48]), one);
    // n − 1 (padded) -> 1; n − 2 -> n − 1; n -> 2.
    let nm1 = hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140").unwrap();
    let pad = |v: &[u8]| {
      let mut b = [0u8; 48];
      b[16..].copy_from_slice(v);
      b
    };
    assert_eq!(secp_secret_from_wide(&pad(&nm1)), one);
    let mut nm2 = nm1.clone();
    nm2[31] -= 1;
    assert_eq!(secp_secret_from_wide(&pad(&nm2)).to_vec(), nm1);
    let mut n = nm1.clone();
    n[31] += 1;
    let mut two = [0u8; 32];
    two[31] = 2;
    assert_eq!(secp_secret_from_wide(&pad(&n)), two);
    // 2^383 mod (n − 1) + 1, computed independently with Python integers:
    //   hex(1 + (2**383 % (N - 1)))
    let mut top = [0u8; 48];
    top[0] = 0x80;
    assert_eq!(
      hex::encode(secp_secret_from_wide(&top)),
      "a2a8918ca85bafe22016d0b997e4df6000000000000000000000000000000001"
    );
    // all ones: hex(1 + ((2**384 - 1) % (N - 1)))
    assert_eq!(hex::encode(secp_secret_from_wide(&[0xff; 48])), "4551231950b75fc4402da1732fc9bec14551231950b75fc4402da1732fc9bec0");
  }

  #[test]
  fn contact_id_is_first_16_bytes_of_tagged_hash() {
    let pda = [7u8; 32];
    let full = sha256(&[b"xmrswap/v1/contact\0", &pda]);
    assert_eq!(contact_share_id(&pda), full[..16]);
  }
}
