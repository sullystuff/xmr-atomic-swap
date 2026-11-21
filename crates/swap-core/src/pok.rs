//! SPEC 2.4: Schnorr proof of knowledge of a spend share, verified on-chain by the Solana program.
//!
//! ```text
//! k    = wide(SHA512(DS("pok-nonce") ‖ s ‖ S ‖ ctx))
//! R    = k·G
//! c    = clamp252(SHA256(DS("pok") ‖ R ‖ S ‖ ctx))
//! z    = k + c·s mod l
//! pok  = R[32] ‖ z[32]
//! verify: z canonical, and z·G == R + c·S
//! ```
//!
//! `ctx` is the maker PDA for a maker's share and the swap PDA for a taker's share, so a proof
//! cannot be replayed for another maker or another swap. The challenge is clamped, not reduced,
//! so the program needs no big-integer reduction.

use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use zeroize::Zeroize;

use crate::{
  error::{Error, Result},
  point::commitment,
  primitives::{clamp252, ds, ed_base_mul, ed_decompress, scalar_canonical, sha256, sha512, spend_share, wide},
};

fn challenge(r: &[u8; 32], s_pub: &[u8; 32], ctx: &[u8; 32]) -> Scalar {
  // clamp252 output is below 2^252 < l, so this conversion never reduces.
  Scalar::from_bytes_mod_order(clamp252(sha256(&[&ds("pok"), r, s_pub, ctx])))
}

/// Prove knowledge of the spend share `s` (`0 < s < 2^252`) bound to `ctx`. Deterministic.
pub fn pok_prove(s: &[u8; 32], ctx: &[u8; 32]) -> Result<[u8; 64]> {
  let sk = spend_share(s)?;
  let s_pub = ed_base_mul(&sk);
  let mut nonce_hash = sha512(&[&ds("pok-nonce"), s, &s_pub, ctx]);
  let mut k = wide(&nonce_hash);
  nonce_hash.zeroize();
  let r = ed_base_mul(&k);
  let c = challenge(&r, &s_pub, ctx);
  let z = k + c * sk;
  k.zeroize();
  let mut out = [0u8; 64];
  out[..32].copy_from_slice(&r);
  out[32..].copy_from_slice(&z.to_bytes());
  Ok(out)
}

/// Verify a proof for commitment `S` under `ctx`.
///
/// Mirrors the on-chain steps: `S` must be a valid key commitment (the program checks that
/// before the proof), `R` must decompress, `z` must be canonical, and the canonical compression
/// of `z·G` must equal that of `R + c·S`.
pub fn pok_verify(s_pub: &[u8; 32], ctx: &[u8; 32], pok: &[u8; 64]) -> bool {
  pok_check(s_pub, ctx, pok).is_ok()
}

pub fn pok_check(s_pub: &[u8; 32], ctx: &[u8; 32], pok: &[u8; 64]) -> Result<()> {
  let s_point = commitment(s_pub)?;
  let r: [u8; 32] = pok[..32].try_into().unwrap();
  let z: [u8; 32] = pok[32..].try_into().unwrap();
  let r_point = ed_decompress(&r).ok_or(Error::PokInvalid)?;
  let z = scalar_canonical(&z).map_err(|_| Error::PokInvalid)?;
  let c = challenge(&r, s_pub, ctx);
  let lhs = (z * ED25519_BASEPOINT_POINT).compress();
  let rhs = (r_point + c * s_point).compress();
  if lhs == rhs {
    Ok(())
  } else {
    Err(Error::PokInvalid)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use curve25519_dalek::constants::EIGHT_TORSION;

  fn share(i: u8) -> [u8; 32] {
    clamp252(sha256(&[b"pok-test", &[i]]))
  }
  fn pubkey(s: &[u8; 32]) -> [u8; 32] {
    ed_base_mul(&Scalar::from_bytes_mod_order(*s))
  }

  #[test]
  fn round_trip_and_deterministic() {
    for i in 0..20 {
      let s = share(i);
      let ctx = sha256(&[b"ctx", &[i]]);
      let p = pok_prove(&s, &ctx).unwrap();
      assert_eq!(p, pok_prove(&s, &ctx).unwrap());
      assert!(pok_verify(&pubkey(&s), &ctx, &p));
    }
  }

  #[test]
  fn replay_under_another_context_fails() {
    let s = share(1);
    let ctx_maker = sha256(&[b"maker pda"]);
    let ctx_swap = sha256(&[b"swap pda"]);
    let p = pok_prove(&s, &ctx_maker).unwrap();
    assert!(pok_verify(&pubkey(&s), &ctx_maker, &p));
    assert!(!pok_verify(&pubkey(&s), &ctx_swap, &p));
    assert_eq!(pok_check(&pubkey(&s), &ctx_swap, &p), Err(Error::PokInvalid));
  }

  #[test]
  fn wrong_key_and_tampering_fail() {
    let s = share(2);
    let ctx = [9u8; 32];
    let p = pok_prove(&s, &ctx).unwrap();
    assert!(!pok_verify(&pubkey(&share(3)), &ctx, &p));
    for bit in [0usize, 7, 255, 256, 300, 500] {
      let mut bad = p;
      bad[bit / 8] ^= 1 << (bit % 8);
      assert!(!pok_verify(&pubkey(&s), &ctx, &bad), "bit {bit}");
    }
  }

  #[test]
  fn non_canonical_z_rejected() {
    // z + l is the same scalar mod l but must be refused (the syscall refuses it too).
    let s = share(4);
    let ctx = [1u8; 32];
    let p = pok_prove(&s, &ctx).unwrap();
    let mut bad = p;
    let mut carry = 0u16;
    for i in 0..32 {
      let v = p[32 + i] as u16 + crate::primitives::L_LE[i] as u16 + carry;
      bad[32 + i] = v as u8;
      carry = v >> 8;
    }
    if carry == 0 {
      assert!(!pok_verify(&pubkey(&s), &ctx, &bad));
    }
    let mut ff = p;
    ff[32..].copy_from_slice(&[0xff; 32]);
    assert!(!pok_verify(&pubkey(&s), &ctx, &ff));
  }

  #[test]
  fn rogue_key_cannot_be_proved() {
    // The attacker sees S_other and publishes S' = k·G − S_other, hoping to own the joint key
    // k·G alone. It knows k but not the discrete log of S'. Every proof it can build fails.
    let other = share(5);
    let s_other = ed_decompress(&pubkey(&other)).unwrap();
    let k = share(6);
    let rogue = (ed_decompress(&pubkey(&k)).unwrap() - s_other).compress().to_bytes();
    assert!(crate::point::validate_point(&rogue));
    let ctx = [3u8; 32];
    // (a) a proof made with k, relabelled;
    let p = pok_prove(&k, &ctx).unwrap();
    assert!(!pok_verify(&rogue, &ctx, &p));
    // (b) the victim's own proof, relabelled;
    let p = pok_prove(&other, &ctx).unwrap();
    assert!(!pok_verify(&rogue, &ctx, &p));
    // (c) a simulated transcript with a challenge chosen before R (R = z·G − c'·S') fails because
    //     the real challenge binds R.
    let z = Scalar::from_bytes_mod_order(share(7));
    let c_guess = Scalar::from_bytes_mod_order(share(8));
    let r = (z * ED25519_BASEPOINT_POINT - c_guess * ed_decompress(&rogue).unwrap()).compress().to_bytes();
    let mut forged = [0u8; 64];
    forged[..32].copy_from_slice(&r);
    forged[32..].copy_from_slice(&z.to_bytes());
    assert!(!pok_verify(&rogue, &ctx, &forged));
  }

  #[test]
  fn invalid_commitments_rejected_before_the_equation() {
    let ctx = [0u8; 32];
    let p = pok_prove(&share(9), &ctx).unwrap();
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert_eq!(pok_check(&identity, &ctx, &p), Err(Error::InvalidKeyCommitment));
    // z = 0, R = identity "proves" the identity under any challenge; the commitment check stops it.
    let mut trivial = [0u8; 64];
    trivial[0] = 1;
    assert!(!pok_verify(&identity, &ctx, &trivial));
    // A torsioned commitment is refused even with the honest proof for its prime-order part.
    let s = share(10);
    let torsioned =
      (ed_decompress(&pubkey(&s)).unwrap() + EIGHT_TORSION[1]).compress().to_bytes();
    assert_eq!(
      pok_check(&torsioned, &ctx, &pok_prove(&s, &ctx).unwrap()),
      Err(Error::InvalidKeyCommitment)
    );
  }

  #[test]
  fn prover_refuses_out_of_range_shares() {
    assert_eq!(pok_prove(&[0u8; 32], &[0u8; 32]), Err(Error::ScalarOutOfRange));
    let mut big = [0u8; 32];
    big[31] = 0x10;
    assert_eq!(pok_prove(&big, &[0u8; 32]), Err(Error::ScalarOutOfRange));
  }

  #[test]
  fn r_must_decompress() {
    let s = share(11);
    let ctx = [5u8; 32];
    let mut p = pok_prove(&s, &ctx).unwrap();
    p[..32].copy_from_slice(&{
      let mut off = [0u8; 32];
      off[0] = 2;
      off
    });
    assert!(!pok_verify(&pubkey(&s), &ctx, &p));
  }
}
