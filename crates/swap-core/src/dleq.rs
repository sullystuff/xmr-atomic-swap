//! SPEC 2.6: the cross-curve DLEQ proof that a secp256k1 key `P` and an ed25519 key `S` hide the
//! same 252-bit integer.
//!
//! `sigma_fun` 0.9.0 `CrossCurveDLEQ<HashTranscript<Sha256, ChaCha20Rng>>`, second generators the
//! BIP-341 NUMS point (secp256k1) and Monero's `H` (ed25519). The proof is serialised with
//! bincode 2 "standard" configuration over serde.
//!
//! ```text
//! DleqBlob = 0x01 ‖ S[32] ‖ P_compressed[33] ‖ proof          56,679 bytes
//! ```
//!
//! Verifier rules: total length `<= 60,000`; version byte 1; bincode decoding consumes every
//! remaining byte; the proof verifies for `(P, S)`; the verifier then **computes** `keyAddr` and
//! `keyAddr2` from `P` itself.

use std::sync::OnceLock;

use curve25519_dalek_ng::{edwards::CompressedEdwardsY, scalar::Scalar as ScalarNg};
use rand_chacha::ChaCha20Rng;
use rand_core::{OsRng, RngCore, SeedableRng};
use sha2::Sha256;
use sigma_fun::{
  ext::dl_secp256k1_ed25519_eq::{CrossCurveDLEQ, CrossCurveDLEQProof},
  secp256k1::fun::{marker::*, Point},
  HashTranscript,
};

use crate::{
  error::{Error, Result},
  point::validate_point,
  primitives::is_share_range,
  twin::twin_addresses,
};

/// Largest blob a verifier accepts.
pub const DLEQ_MAX_BLOB: usize = 60_000;
pub const DLEQ_VERSION: u8 = 1;
/// Version byte, `S`, compressed `P`.
pub const DLEQ_HEADER: usize = 1 + 32 + 33;
/// Size of an honest blob (measured; pinned by a test).
pub const DLEQ_BLOB_LEN: usize = 56_679;

/// BIP-341 NUMS point: the second secp256k1 generator.
pub const SECP_H: &str = "0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
/// Monero's `H`: the second ed25519 generator.
pub const ED_H: &str = "8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94";

type Transcript = HashTranscript<Sha256, ChaCha20Rng>;

fn system() -> &'static CrossCurveDLEQ<Transcript> {
  static SYS: OnceLock<CrossCurveDLEQ<Transcript>> = OnceLock::new();
  SYS.get_or_init(|| {
    let mut k = [0u8; 33];
    hex::decode_to_slice(SECP_H, &mut k).unwrap();
    let mut e = [0u8; 32];
    hex::decode_to_slice(ED_H, &mut e).unwrap();
    CrossCurveDLEQ::<Transcript>::new(
      Point::from_bytes(k).expect("NUMS point"),
      CompressedEdwardsY(e).decompress().expect("Monero H"),
    )
  })
}

/// What a verified blob proves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DleqStatement {
  /// `S`, the ed25519 spend commitment.
  pub spend_pub: [u8; 32],
  /// `P`, the secp256k1 twin, compressed.
  pub secp_compressed: [u8; 33],
  /// `address(P)`, computed by the verifier.
  pub key_addr: [u8; 20],
  /// `address(T2·P)`, computed by the verifier.
  pub key_addr2: [u8; 20],
}

/// `dleqProve(s)` with operating-system randomness.
pub fn dleq_prove(s_le: &[u8; 32]) -> Result<Vec<u8>> {
  let mut seed = [0u8; 32];
  OsRng.fill_bytes(&mut seed);
  dleq_prove_seeded(s_le, seed)
}

/// As [`dleq_prove`] with the prover's randomness derived from `rng_seed`. Used for the
/// deterministic vectors; production callers use [`dleq_prove`].
pub fn dleq_prove_seeded(s_le: &[u8; 32], rng_seed: [u8; 32]) -> Result<Vec<u8>> {
  // `prove` panics above 2^252, and a zero share is never valid.
  if !is_share_range(s_le) {
    return Err(Error::ScalarOutOfRange);
  }
  let s = ScalarNg::from_canonical_bytes(*s_le).ok_or(Error::ScalarOutOfRange)?;
  let mut rng = ChaCha20Rng::from_seed(rng_seed);
  let (proof, (secp, ed)) = system().prove(&s, &mut rng);
  let proof_bytes = bincode::encode_to_vec(bincode::serde::Compat(&proof), bincode::config::standard())
    .map_err(|_| Error::DleqMalformed)?;
  let mut blob = Vec::with_capacity(DLEQ_HEADER + proof_bytes.len());
  blob.push(DLEQ_VERSION);
  blob.extend_from_slice(&ed.compress().to_bytes());
  blob.extend_from_slice(&secp.to_bytes());
  blob.extend_from_slice(&proof_bytes);
  Ok(blob)
}

/// `dleqVerify(blob)`: apply every verifier rule and return the statement proved.
pub fn dleq_verify(blob: &[u8]) -> Result<DleqStatement> {
  if blob.len() > DLEQ_MAX_BLOB {
    return Err(Error::DleqTooLarge);
  }
  if blob.len() < DLEQ_HEADER || blob[0] != DLEQ_VERSION {
    return Err(Error::DleqBadVersion);
  }
  let spend_pub: [u8; 32] = blob[1..33].try_into().unwrap();
  let secp_compressed: [u8; 33] = blob[33..66].try_into().unwrap();
  let body = &blob[DLEQ_HEADER..];
  let (proof, used) = bincode::decode_from_slice::<bincode::serde::Compat<CrossCurveDLEQProof>, _>(
    body,
    bincode::config::standard(),
  )
  .map_err(|_| Error::DleqMalformed)?;
  if used != body.len() {
    return Err(Error::DleqMalformed);
  }
  // Canonical, non-identity, prime-order S. `verify` also rejects torsion; this additionally
  // pins the encoding, because blobs are stored and fetched by the hex of S.
  if !validate_point(&spend_pub) {
    return Err(Error::DleqInvalid);
  }
  let p = Point::<Normal, Public, NonZero>::from_bytes(secp_compressed).ok_or(Error::DleqInvalid)?;
  let q = CompressedEdwardsY(spend_pub).decompress().ok_or(Error::DleqInvalid)?;
  if !system().verify(&proof.0, (p, q)) {
    return Err(Error::DleqInvalid);
  }
  let (key_addr, key_addr2) = twin_addresses(&p);
  Ok(DleqStatement { spend_pub, secp_compressed, key_addr, key_addr2 })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{primitives::clamp252, twin::twin_commitments};

  fn share(i: u8) -> [u8; 32] {
    clamp252(crate::primitives::sha256(&[b"dleq-test", &[i]]))
  }

  #[test]
  fn prove_verify_and_size() {
    let s = share(1);
    let blob = dleq_prove_seeded(&s, [1u8; 32]).unwrap();
    assert_eq!(blob.len(), DLEQ_BLOB_LEN);
    assert!(blob.len() <= DLEQ_MAX_BLOB);
    let st = dleq_verify(&blob).unwrap();
    let twin = twin_commitments(&s).unwrap();
    assert_eq!(st.key_addr, twin.key_addr);
    assert_eq!(st.key_addr2, twin.key_addr2);
    assert_eq!(st.secp_compressed, twin.secp_compressed);
    assert!(crate::point::scalar_matches(&s, &st.spend_pub));
    // Deterministic for a fixed seed; OS randomness gives another valid proof of the same thing.
    assert_eq!(blob, dleq_prove_seeded(&s, [1u8; 32]).unwrap());
    let other = dleq_prove(&s).unwrap();
    assert_ne!(other, blob);
    assert_eq!(dleq_verify(&other).unwrap(), st);
  }

  #[test]
  fn tampering_is_rejected() {
    let s = share(2);
    let blob = dleq_prove_seeded(&s, [2u8; 32]).unwrap();

    // Flipped bit in the proof body.
    let mut bad = blob.clone();
    bad[DLEQ_HEADER + 1000] ^= 1;
    assert!(matches!(dleq_verify(&bad), Err(Error::DleqInvalid | Error::DleqMalformed)));

    // Proof checked against another key: swap in the header of a different share.
    let other = dleq_prove_seeded(&share(3), [3u8; 32]).unwrap();
    let mut wrong_key = blob.clone();
    wrong_key[1..DLEQ_HEADER].copy_from_slice(&other[1..DLEQ_HEADER]);
    assert_eq!(dleq_verify(&wrong_key), Err(Error::DleqInvalid));
    // Only the ed25519 side replaced (rogue S with an honest P).
    let mut rogue = blob.clone();
    rogue[1..33].copy_from_slice(&other[1..33]);
    assert_eq!(dleq_verify(&rogue), Err(Error::DleqInvalid));
    // Only the secp256k1 side replaced.
    let mut rogue = blob.clone();
    rogue[33..66].copy_from_slice(&other[33..66]);
    assert_eq!(dleq_verify(&rogue), Err(Error::DleqInvalid));

    // Trailing byte.
    let mut trailing = blob.clone();
    trailing.push(0);
    assert_eq!(dleq_verify(&trailing), Err(Error::DleqMalformed));
    // Truncated.
    assert_eq!(dleq_verify(&blob[..blob.len() - 1]), Err(Error::DleqMalformed));
    // Wrong version.
    let mut v2 = blob.clone();
    v2[0] = 2;
    assert_eq!(dleq_verify(&v2), Err(Error::DleqBadVersion));
    assert_eq!(dleq_verify(&[]), Err(Error::DleqBadVersion));
    assert_eq!(dleq_verify(&[1u8; 10]), Err(Error::DleqBadVersion));
    // Oversize: checked before anything is parsed.
    let mut big = blob.clone();
    big.resize(DLEQ_MAX_BLOB + 1, 0);
    assert_eq!(dleq_verify(&big), Err(Error::DleqTooLarge));
  }

  #[test]
  fn torsioned_or_identity_spend_key_rejected() {
    let s = share(4);
    let blob = dleq_prove_seeded(&s, [4u8; 32]).unwrap();
    let honest = crate::primitives::ed_decompress(&blob[1..33].try_into().unwrap()).unwrap();
    let torsioned = (honest + curve25519_dalek::constants::EIGHT_TORSION[1]).compress().to_bytes();
    let mut bad = blob.clone();
    bad[1..33].copy_from_slice(&torsioned);
    assert_eq!(dleq_verify(&bad), Err(Error::DleqInvalid));
    let mut identity = blob.clone();
    identity[1..33].copy_from_slice(&{
      let mut i = [0u8; 32];
      i[0] = 1;
      i
    });
    assert_eq!(dleq_verify(&identity), Err(Error::DleqInvalid));
  }

  #[test]
  fn prover_refuses_out_of_range() {
    assert_eq!(dleq_prove_seeded(&[0u8; 32], [0u8; 32]), Err(Error::ScalarOutOfRange));
    let mut big = [0u8; 32];
    big[31] = 0x10;
    assert_eq!(dleq_prove_seeded(&big, [0u8; 32]), Err(Error::ScalarOutOfRange));
  }
}
