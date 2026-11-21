//! SPEC 2.12: passphrase sealing for the daemon keystore and the encrypted recovery file.
//!
//! scrypt (N = 2^17, r = 8, p = 1, 16-byte salt) + XChaCha20-Poly1305.
//! Layout: `0x01 ‖ salt[16] ‖ nonce[24] ‖ ciphertext` (the ciphertext ends with the 16-byte tag).

use chacha20poly1305::{
  aead::{Aead, KeyInit},
  XChaCha20Poly1305, XNonce,
};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroize;

use crate::error::{Error, Result};

pub const PASSPHRASE_VERSION: u8 = 1;
pub const SCRYPT_LOG_N: u8 = 17;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;
pub const PASSPHRASE_SALT_LEN: usize = 16;
pub const PASSPHRASE_NONCE_LEN: usize = 24;
/// Version, salt, nonce and tag.
pub const PASSPHRASE_OVERHEAD: usize = 1 + PASSPHRASE_SALT_LEN + PASSPHRASE_NONCE_LEN + 16;

fn derive(passphrase: &[u8], salt: &[u8], log_n: u8) -> [u8; 32] {
  let params = scrypt::Params::new(log_n, SCRYPT_R, SCRYPT_P, 32).expect("fixed scrypt parameters are valid");
  let mut key = [0u8; 32];
  scrypt::scrypt(passphrase, salt, &params, &mut key).expect("32 bytes is a valid scrypt output length");
  key
}

/// `passphraseSeal(passphrase, plaintext)` with a random salt and nonce.
pub fn passphrase_seal(passphrase: &[u8], plaintext: &[u8]) -> Vec<u8> {
  let mut salt = [0u8; PASSPHRASE_SALT_LEN];
  let mut nonce = [0u8; PASSPHRASE_NONCE_LEN];
  OsRng.fill_bytes(&mut salt);
  OsRng.fill_bytes(&mut nonce);
  passphrase_seal_with(passphrase, plaintext, &salt, &nonce)
}

/// As [`passphrase_seal`] with the salt and nonce supplied (deterministic vectors).
pub fn passphrase_seal_with(
  passphrase: &[u8],
  plaintext: &[u8],
  salt: &[u8; PASSPHRASE_SALT_LEN],
  nonce: &[u8; PASSPHRASE_NONCE_LEN],
) -> Vec<u8> {
  let mut key = derive(passphrase, salt, SCRYPT_LOG_N);
  let ct = XChaCha20Poly1305::new((&key).into())
    .encrypt(XNonce::from_slice(nonce), plaintext)
    .expect("XChaCha20-Poly1305 encrypts any plaintext that fits memory");
  key.zeroize();
  let mut out = Vec::with_capacity(PASSPHRASE_OVERHEAD + plaintext.len());
  out.push(PASSPHRASE_VERSION);
  out.extend_from_slice(salt);
  out.extend_from_slice(nonce);
  out.extend_from_slice(&ct);
  out
}

/// `passphraseOpen(passphrase, sealed)`.
pub fn passphrase_open(passphrase: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
  if sealed.len() < PASSPHRASE_OVERHEAD || sealed[0] != PASSPHRASE_VERSION {
    return Err(Error::PassphraseMalformed);
  }
  let salt = &sealed[1..1 + PASSPHRASE_SALT_LEN];
  let nonce = &sealed[1 + PASSPHRASE_SALT_LEN..1 + PASSPHRASE_SALT_LEN + PASSPHRASE_NONCE_LEN];
  let ct = &sealed[1 + PASSPHRASE_SALT_LEN + PASSPHRASE_NONCE_LEN..];
  let mut key = derive(passphrase, salt, SCRYPT_LOG_N);
  let pt = XChaCha20Poly1305::new((&key).into()).decrypt(XNonce::from_slice(nonce), ct).map_err(|_| Error::PassphraseDecrypt);
  key.zeroize();
  pt
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn scrypt_rfc7914_vector() {
    // RFC 7914 section 12, third vector: N = 16384, r = 8, p = 1.
    let params = scrypt::Params::new(14, 8, 1, 64).unwrap();
    let mut out = [0u8; 64];
    scrypt::scrypt(b"pleaseletmein", b"SodiumChloride", &params, &mut out).unwrap();
    assert_eq!(
      hex::encode(out),
      "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887"
    );
  }

  #[test]
  fn layout_round_trip_and_failures() {
    let salt = [1u8; 16];
    let nonce = [2u8; 24];
    let sealed = passphrase_seal_with(b"correct horse", b"seed bytes", &salt, &nonce);
    assert_eq!(sealed[0], 1);
    assert_eq!(&sealed[1..17], &salt);
    assert_eq!(&sealed[17..41], &nonce);
    assert_eq!(sealed.len(), PASSPHRASE_OVERHEAD + 10);
    assert_eq!(sealed, passphrase_seal_with(b"correct horse", b"seed bytes", &salt, &nonce));
    assert_eq!(passphrase_open(b"correct horse", &sealed).unwrap(), b"seed bytes");
    assert_eq!(passphrase_open(b"wrong horse", &sealed), Err(Error::PassphraseDecrypt));

    let mut bad = sealed.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(passphrase_open(b"correct horse", &bad), Err(Error::PassphraseDecrypt));
    let mut bad = sealed.clone();
    bad[5] ^= 1; // salt
    assert_eq!(passphrase_open(b"correct horse", &bad), Err(Error::PassphraseDecrypt));
    let mut bad = sealed.clone();
    bad[0] = 2;
    assert_eq!(passphrase_open(b"correct horse", &bad), Err(Error::PassphraseMalformed));
    assert_eq!(passphrase_open(b"correct horse", &sealed[..40]), Err(Error::PassphraseMalformed));
  }

  #[test]
  fn random_seal_differs_each_time() {
    let a = passphrase_seal(b"pw", b"data");
    let b = passphrase_seal(b"pw", b"data");
    assert_ne!(a, b);
    assert_eq!(passphrase_open(b"pw", &a).unwrap(), b"data");
    assert_eq!(passphrase_open(b"pw", &b).unwrap(), b"data");
  }
}
