//! Signatures.
//!
//! * Ed25519 (RFC 8032) through `ed25519-dalek`: the maker's Solana operator key signs envelopes
//!   (SPEC 2.8) and advance approvals (SPEC 2.9); a taker's Solana session key is an Ed25519 key.
//!   Verification is `verify_strict`, the rule the Solana Ed25519 precompile applies.
//! * secp256k1 ECDSA with RFC 6979 nonces: **test vectors only** (`eip712.json`). Product code
//!   signs EIP-712 objects with viem; nothing in the wasm API signs with secp256k1.

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sigma_fun::secp256k1::fun::{g, marker::*, s, Point, Scalar, G};

use crate::{
  error::{Error, Result},
  primitives::keccak256,
};

/// Ed25519 public key of a 32-byte seed.
pub fn ed25519_public(seed: &[u8; 32]) -> [u8; 32] {
  SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// Ed25519 signature (deterministic, RFC 8032).
pub fn ed25519_sign(seed: &[u8; 32], msg: &[u8]) -> [u8; 64] {
  SigningKey::from_bytes(seed).sign(msg).to_bytes()
}

/// Strict Ed25519 verification: canonical `s`, no small-order `R` or public key.
pub fn ed25519_verify(public: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
  let Ok(key) = VerifyingKey::from_bytes(public) else { return false };
  key.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(sig)).is_ok()
}

type HmacSha256 = Hmac<Sha256>;
fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
  let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac accepts any key length");
  for p in parts {
    m.update(p);
  }
  m.finalize().into_bytes().into()
}

/// RFC 6979 section 3.2 nonce for secp256k1 with SHA-256 (`qlen == hlen == 256`).
fn rfc6979_nonce(secret_be: &[u8; 32], digest: &[u8; 32]) -> Scalar<Secret, NonZero> {
  // bits2octets(h1) = h1 mod n.
  let h1 = Scalar::<Public, Zero>::from_bytes_mod_order(*digest).to_bytes();
  let mut v = [1u8; 32];
  let mut k = [0u8; 32];
  k = hmac(&k, &[&v, &[0], secret_be, &h1]);
  v = hmac(&k, &[&v]);
  k = hmac(&k, &[&v, &[1], secret_be, &h1]);
  v = hmac(&k, &[&v]);
  loop {
    v = hmac(&k, &[&v]);
    if let Some(nonce) = Scalar::<Secret, NonZero>::from_bytes(v) {
      return nonce;
    }
    k = hmac(&k, &[&v, &[0]]);
    v = hmac(&k, &[&v]);
  }
}

/// Ethereum-style ECDSA signature `r ‖ s ‖ v` (65 bytes, low-s, `v` in {27, 28}) over a 32-byte
/// digest. Test vectors only.
pub fn ecdsa_sign_digest(secret_be: &[u8; 32], digest: &[u8; 32]) -> Result<[u8; 65]> {
  let d = Scalar::<Secret, NonZero>::from_bytes(*secret_be).ok_or(Error::ScalarOutOfRange)?;
  let z = Scalar::<Public, Zero>::from_bytes_mod_order(*digest);
  let k = rfc6979_nonce(secret_be, digest);
  let r_point = g!(k * G).normalize();
  let (rx, _) = r_point.coordinates();
  // r = x mod n. x >= n has probability about 2^-128; a vector generator may simply refuse.
  let r = Scalar::<Public, NonZero>::from_bytes(rx).ok_or(Error::SignatureInvalid)?;
  let k_inv = k.invert();
  let mut sig_s = s!(k_inv * (z + r * d)).non_zero().ok_or(Error::SignatureInvalid)?.public();
  let mut y_odd = !r_point.is_y_even();
  if sig_s.is_high() {
    sig_s = -sig_s;
    y_odd = !y_odd;
  }
  let mut out = [0u8; 65];
  out[..32].copy_from_slice(&r.to_bytes());
  out[32..64].copy_from_slice(&sig_s.to_bytes());
  out[64] = 27 + y_odd as u8;
  Ok(out)
}

/// Recover the signer address of a 65-byte `r ‖ s ‖ v` signature, applying OpenZeppelin
/// `ECDSA.recover`'s rules (low-s, `v` in {27, 28}). Test vectors only.
pub fn ecdsa_recover_address(digest: &[u8; 32], sig: &[u8; 65]) -> Result<[u8; 20]> {
  let r = Scalar::<Public, NonZero>::from_bytes(sig[..32].try_into().unwrap()).ok_or(Error::SignatureInvalid)?;
  let sig_s = Scalar::<Public, NonZero>::from_bytes(sig[32..64].try_into().unwrap()).ok_or(Error::SignatureInvalid)?;
  if sig_s.is_high() || !(sig[64] == 27 || sig[64] == 28) {
    return Err(Error::SignatureInvalid);
  }
  let mut compressed = [0u8; 33];
  compressed[0] = 2 + (sig[64] - 27);
  compressed[1..].copy_from_slice(&sig[..32]);
  let r_point = Point::<Normal, Public, NonZero>::from_bytes(compressed).ok_or(Error::SignatureInvalid)?;
  let z = Scalar::<Public, Zero>::from_bytes_mod_order(*digest);
  let r_inv = r.invert();
  // Q = r^-1 (s·R − z·G)
  let q = g!(r_inv * (sig_s * r_point - z * G)).normalize().non_zero().ok_or(Error::SignatureInvalid)?;
  Ok(crate::twin::eth_address(&q))
}

/// Ethereum address of a secp256k1 private key (32 bytes big-endian).
pub fn eth_address_of_secret(secret_be: &[u8; 32]) -> Result<[u8; 20]> {
  let d = Scalar::<Secret, NonZero>::from_bytes(*secret_be).ok_or(Error::ScalarOutOfRange)?;
  Ok(crate::twin::eth_address(&g!(d * G).normalize()))
}

/// `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`.
pub fn eip712_digest(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
  keccak256(&[&[0x19, 0x01], domain_separator, struct_hash])
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::primitives::sha256;

  fn h<const N: usize>(s: &str) -> [u8; N] {
    hex::decode(s).unwrap().try_into().unwrap()
  }

  #[test]
  fn ed25519_rfc8032_vectors() {
    // RFC 8032 section 7.1, TEST 1 (empty message) and TEST 2 (one byte).
    let seed: [u8; 32] = h("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    let public: [u8; 32] = h("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    let sig: [u8; 64] = h("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    assert_eq!(ed25519_public(&seed), public);
    assert_eq!(ed25519_sign(&seed, b""), sig);
    assert!(ed25519_verify(&public, b"", &sig));

    let seed: [u8; 32] = h("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
    let public: [u8; 32] = h("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
    let sig: [u8; 64] = h("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00");
    assert_eq!(ed25519_public(&seed), public);
    assert_eq!(ed25519_sign(&seed, &[0x72]), sig);
    assert!(ed25519_verify(&public, &[0x72], &sig));
    // Wrong message, flipped bit, wrong key.
    assert!(!ed25519_verify(&public, &[0x73], &sig));
    let mut bad = sig;
    bad[10] ^= 1;
    assert!(!ed25519_verify(&public, &[0x72], &bad));
    assert!(!ed25519_verify(&h("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), &[0x72], &sig));
  }

  #[test]
  fn ed25519_strict_rejects_malleable_and_small_order() {
    let seed = [7u8; 32];
    let public = ed25519_public(&seed);
    let sig = ed25519_sign(&seed, b"msg");
    // s + l: same equation, non-canonical scalar.
    let mut mall = sig;
    let mut carry = 0u16;
    for i in 0..32 {
      let v = sig[32 + i] as u16 + crate::primitives::L_LE[i] as u16 + carry;
      mall[32 + i] = v as u8;
      carry = v >> 8;
    }
    assert!(!ed25519_verify(&public, b"msg", &mall));
    // Small-order public key with the all-zero signature over R = identity.
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let mut zero_sig = [0u8; 64];
    zero_sig[0] = 1;
    assert!(!ed25519_verify(&identity, b"msg", &zero_sig));
  }

  #[test]
  fn rfc6979_known_answer() {
    // The widely used secp256k1 RFC 6979 vector: key = 1, message "Satoshi Nakamoto".
    let mut key = [0u8; 32];
    key[31] = 1;
    let digest = sha256(&[b"Satoshi Nakamoto"]);
    assert_eq!(
      hex::encode(rfc6979_nonce(&key, &digest).to_bytes()),
      "8f8a276c19f4149656b280621e358cce24f5f52542772691ee69063b74f15d15"
    );
    let sig = ecdsa_sign_digest(&key, &digest).unwrap();
    assert_eq!(
      hex::encode(&sig[..64]),
      "934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d82442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5"
    );
    assert_eq!(hex::encode(ecdsa_recover_address(&digest, &sig).unwrap()), "7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  }

  #[test]
  fn ecdsa_round_trip_and_rejections() {
    for i in 1u8..20 {
      let key = sha256(&[b"ecdsa-key", &[i]]);
      let digest = sha256(&[b"ecdsa-msg", &[i]]);
      let sig = ecdsa_sign_digest(&key, &digest).unwrap();
      let addr = eth_address_of_secret(&key).unwrap();
      assert_eq!(ecdsa_recover_address(&digest, &sig).unwrap(), addr);
      // Another digest recovers some other address (or fails), never the signer.
      let other = sha256(&[b"other", &[i]]);
      assert_ne!(ecdsa_recover_address(&other, &sig).ok(), Some(addr));
      // High-s twin is refused (OpenZeppelin's rule).
      let s_low = Scalar::<Public, NonZero>::from_bytes(sig[32..64].try_into().unwrap()).unwrap();
      let mut high = sig;
      high[32..64].copy_from_slice(&(-s_low).to_bytes());
      high[64] = if sig[64] == 27 { 28 } else { 27 };
      assert_eq!(ecdsa_recover_address(&digest, &high), Err(Error::SignatureInvalid));
      let mut bad_v = sig;
      bad_v[64] = 0;
      assert_eq!(ecdsa_recover_address(&digest, &bad_v), Err(Error::SignatureInvalid));
    }
  }
}
