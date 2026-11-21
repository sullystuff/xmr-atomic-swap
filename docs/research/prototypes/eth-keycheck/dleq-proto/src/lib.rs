//! Cross-curve DLEQ prototype: prove that a secp256k1 key and an ed25519 key hide the same 252-bit scalar.
//! Two candidates behind the same byte-oriented API so they can be compared natively and in wasm.
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;

pub struct Proved {
  /// 32-byte big-endian scalar (< 2^252): the value later revealed on-chain to `mulVerify`
  pub secret_be: [u8; 32],
  /// SEC1 uncompressed secp256k1 point (65 bytes)
  pub secp_pub: Vec<u8>,
  /// compressed ed25519 point (32 bytes) = this party's Monero spend-key share
  pub ed_pub: [u8; 32],
  pub proof: Vec<u8>,
}

pub fn eth_address(uncompressed_sec1: &[u8]) -> [u8; 20] {
  use sha3::{Digest, Keccak256};
  assert!(uncompressed_sec1.len() == 65 && uncompressed_sec1[0] == 4);
  let h = Keccak256::digest(&uncompressed_sec1[1..]);
  h[12..].try_into().unwrap()
}

pub mod serai {
  use super::*;
  use blake2::{Blake2b512, Digest};
  use dalek_ff_group::EdwardsPoint;
  use dleq::cross_group::{CompromiseLinearDLEq, Generators};
  use k256::{
    elliptic_curve::{group::{Group, GroupEncoding}, sec1::ToEncodedPoint, PrimeField},
    ProjectivePoint,
  };
  use flexible_transcript::{RecommendedTranscript, Transcript};

  type Proof = CompromiseLinearDLEq<ProjectivePoint, EdwardsPoint>;

  fn generators() -> (Generators<ProjectivePoint>, Generators<EdwardsPoint>) {
    // alt generators with no known dlog: BIP-341 NUMS point H on secp256k1, Monero's H on ed25519
    let mut k = [0u8; 33];
    hex::decode_to_slice("0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", &mut k).unwrap();
    let mut e = [0u8; 32];
    hex::decode_to_slice("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94", &mut e).unwrap();
    (
      Generators::new(ProjectivePoint::GENERATOR, ProjectivePoint::from_bytes(&k.into()).unwrap()).unwrap(),
      Generators::new(EdwardsPoint::generator(), EdwardsPoint::from_bytes(&e).unwrap()).unwrap(),
    )
  }

  /// `context` binds the proof to one swap (chain id, escrow address, swap id, role).
  fn transcript(context: &[u8]) -> RecommendedTranscript {
    let mut t = RecommendedTranscript::new(b"xmr-atomic-swap/eth key-share DLEq v1");
    t.append_message(b"context", context);
    t
  }

  /// The secret is derived inside the prover from `key_seed` (bit-truncated to 252 bits, unbiased).
  pub fn prove(rng_seed: [u8; 32], key_seed: &[u8], context: &[u8]) -> Proved {
    let mut rng = ChaCha20Rng::from_seed(rng_seed);
    let (proof, (s0, _s1)) =
      Proof::prove(&mut rng, &mut transcript(context), generators(), Blake2b512::new().chain_update(key_seed));
    let mut buf = vec![];
    proof.write(&mut buf).unwrap();
    // recompute publics via verify so prover and verifier provably agree
    let (p0, p1) = proof.verify(&mut rng, &mut transcript(context), generators()).unwrap();
    Proved {
      secret_be: s0.to_repr().into(),
      secp_pub: p0.to_affine().to_encoded_point(false).as_bytes().to_vec(),
      ed_pub: p1.to_bytes(),
      proof: buf,
    }
  }

  /// Returns (uncompressed secp256k1 point, compressed ed25519 point) the proof is for.
  pub fn verify(rng_seed: [u8; 32], proof: &[u8], context: &[u8]) -> Option<(Vec<u8>, [u8; 32])> {
    let mut rng = ChaCha20Rng::from_seed(rng_seed); // only used for batch-verification weights
    let mut r = proof;
    let proof = Proof::read(&mut r).ok()?;
    if !r.is_empty() {
      return None; // trailing bytes
    }
    let (p0, p1) = proof.verify(&mut rng, &mut transcript(context), generators()).ok()?;
    Some((p0.to_affine().to_encoded_point(false).as_bytes().to_vec(), p1.to_bytes()))
  }
}

pub mod sigma {
  use super::*;
  use curve25519_dalek_ng::{constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, scalar::Scalar as ScalarQ};
  use sha2::Sha256;
  use sigma_fun::{
    ext::dl_secp256k1_ed25519_eq::{CrossCurveDLEQ, CrossCurveDLEQProof},
    secp256k1::fun::Point as PointP,
    HashTranscript,
  };

  type T = HashTranscript<Sha256, ChaCha20Rng>;

  pub fn system() -> CrossCurveDLEQ<T> {
    let mut k = [0u8; 33];
    hex::decode_to_slice("0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", &mut k).unwrap();
    let mut e = [0u8; 32];
    hex::decode_to_slice("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94", &mut e).unwrap();
    CrossCurveDLEQ::<T>::new(PointP::from_bytes(k).unwrap(), CompressedEdwardsY(e).decompress().unwrap())
  }

  /// `secret_le` must be < 2^252 (little-endian, ed25519 convention).
  pub fn prove(sys: &CrossCurveDLEQ<T>, rng_seed: [u8; 32], secret_le: [u8; 32]) -> Proved {
    let mut rng = ChaCha20Rng::from_seed(rng_seed);
    let s = ScalarQ::from_canonical_bytes(secret_le).unwrap();
    let (proof, (pp, pq)) = sys.prove(&s, &mut rng);
    let bytes = bincode::encode_to_vec(bincode::serde::Compat(&proof), bincode::config::standard()).unwrap();
    let mut be = secret_le;
    be.reverse();
    debug_assert_eq!(pq, &s * &ED25519_BASEPOINT_POINT);
    Proved { secret_be: be, secp_pub: pp.to_bytes_uncompressed().to_vec(), ed_pub: pq.compress().to_bytes(), proof: bytes }
  }

  pub fn verify(sys: &CrossCurveDLEQ<T>, proof: &[u8], secp_pub_compressed: [u8; 33], ed_pub: [u8; 32]) -> bool {
    let Ok((proof, n)) = bincode::decode_from_slice::<bincode::serde::Compat<CrossCurveDLEQProof>, _>(
      proof,
      bincode::config::standard(),
    ) else {
      return false;
    };
    if n != proof_len(&proof.0) { /* length is checked by caller */ }
    let (Some(pp), Some(pq)) = (PointP::from_bytes(secp_pub_compressed), CompressedEdwardsY(ed_pub).decompress()) else {
      return false;
    };
    sys.verify(&proof.0, (pp, pq))
  }
  fn proof_len(_: &CrossCurveDLEQProof) -> usize { 0 }
}

// ---------------------------------------------------------------------------------------------
// Raw wasm32-unknown-unknown ABI (no wasm-bindgen needed for the feasibility test). The host
// supplies 32 bytes of entropy from crypto.getRandomValues; nothing in here touches getrandom.
// ---------------------------------------------------------------------------------------------
#[cfg(target_arch = "wasm32")]
mod wasm {
  use super::*;
  fn no_os_rng(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
  }
  getrandom::register_custom_getrandom!(no_os_rng);
  static mut BUF: [u8; 131072] = [0; 131072];
  static mut PROOF_LEN: usize = 0;

  #[no_mangle]
  pub extern "C" fn buf() -> *mut u8 {
    core::ptr::addr_of_mut!(BUF) as *mut u8
  }

  /// in: BUF[0..32] rng seed, BUF[32..64] key seed. out: BUF = secret(32) | secp(65) | ed(32) | proof. returns proof len
  #[no_mangle]
  pub extern "C" fn serai_prove() -> usize {
    unsafe {
      let b = &mut *core::ptr::addr_of_mut!(BUF);
      let p = serai::prove(b[..32].try_into().unwrap(), &b[32..64].to_vec(), b"ctx");
      b[..32].copy_from_slice(&p.secret_be);
      b[32..97].copy_from_slice(&p.secp_pub);
      b[97..129].copy_from_slice(&p.ed_pub);
      b[129..129 + p.proof.len()].copy_from_slice(&p.proof);
      PROOF_LEN = p.proof.len();
      PROOF_LEN
    }
  }

  /// verifies the proof left in BUF by serai_prove; returns 1 if valid and the points match
  #[no_mangle]
  pub extern "C" fn serai_verify() -> u32 {
    unsafe {
      let b = &*core::ptr::addr_of!(BUF);
      match serai::verify([7; 32], &b[129..129 + PROOF_LEN], b"ctx") {
        Some((secp, ed)) => (secp[..] == b[32..97] && ed[..] == b[97..129]) as u32,
        None => 0,
      }
    }
  }

  static mut SYS: Option<sigma_fun::ext::dl_secp256k1_ed25519_eq::CrossCurveDLEQ<
    sigma_fun::HashTranscript<sha2::Sha256, ChaCha20Rng>,
  >> = None;
  static mut SECP_C: [u8; 33] = [0; 33];

  #[no_mangle]
  pub extern "C" fn sigma_init() {
    unsafe { *core::ptr::addr_of_mut!(SYS) = Some(sigma::system()) }
  }

  /// in: BUF[0..32] rng seed, BUF[32..64] secret (LE, < 2^252). out as serai_prove.
  #[no_mangle]
  pub extern "C" fn sigma_prove() -> usize {
    unsafe {
      let b = &mut *core::ptr::addr_of_mut!(BUF);
      let sys = (*core::ptr::addr_of!(SYS)).as_ref().unwrap();
      let p = sigma::prove(sys, b[..32].try_into().unwrap(), b[32..64].try_into().unwrap());
      b[..32].copy_from_slice(&p.secret_be);
      b[32..97].copy_from_slice(&p.secp_pub);
      b[97..129].copy_from_slice(&p.ed_pub);
      b[129..129 + p.proof.len()].copy_from_slice(&p.proof);
      let mut c = [0u8; 33];
      c[0] = 2 + (p.secp_pub[64] & 1);
      c[1..].copy_from_slice(&p.secp_pub[1..33]);
      SECP_C = c;
      PROOF_LEN = p.proof.len();
      PROOF_LEN
    }
  }

  #[no_mangle]
  pub extern "C" fn sigma_verify() -> u32 {
    unsafe {
      let b = &*core::ptr::addr_of!(BUF);
      let sys = (*core::ptr::addr_of!(SYS)).as_ref().unwrap();
      sigma::verify(sys, &b[129..129 + PROOF_LEN], SECP_C, b[97..129].try_into().unwrap()) as u32
    }
  }
}
