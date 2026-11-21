//! SPEC 2.3: validation of a spend commitment, and the opening check.

use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar, traits::IsIdentity};

use crate::{
  error::{Error, Result},
  primitives::{ed_base_mul, ed_decompress, scalar_canonical},
};

/// `is_valid_key_commitment(P)`: `P` is the canonical encoding of a non-identity point in the
/// prime-order subgroup.
///
/// Equivalent to the on-chain test `-((l-1)·P) == P` compared bytewise: decompression must
/// succeed, re-compression must give the same 32 bytes (rejects `y >= p` and "negative zero"),
/// the point must not be the identity and must have no torsion component.
pub fn validate_point(p: &[u8; 32]) -> bool {
  commitment(p).is_ok()
}

/// As [`validate_point`], returning the decompressed point.
pub fn commitment(p: &[u8; 32]) -> Result<EdwardsPoint> {
  let point = ed_decompress(p).ok_or(Error::InvalidKeyCommitment)?;
  if point.compress().to_bytes() != *p || point.is_identity() || !point.is_torsion_free() {
    return Err(Error::InvalidKeyCommitment);
  }
  Ok(point)
}

/// `scalar_matches(s, S)`: `s` is canonical and `s·G == S` bytewise. Zero never matches a valid
/// commitment because `0·G` is the identity.
pub fn scalar_matches(s: &[u8; 32], commitment: &[u8; 32]) -> bool {
  match scalar_canonical(s) {
    Ok(s) => ed_base_mul(&s) == *commitment,
    Err(_) => false,
  }
}

/// `a + b mod l` for two canonical scalars. Used for the joint spend key and joint view key.
pub fn add_scalars(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
  let s: Scalar = scalar_canonical(a)? + scalar_canonical(b)?;
  Ok(s.to_bytes())
}

/// The eight points of small order, as their canonical compressed encodings.
pub fn small_order_points() -> [[u8; 32]; 8] {
  curve25519_dalek::constants::EIGHT_TORSION.map(|p| p.compress().to_bytes())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::primitives::clamp252;
  use curve25519_dalek::constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION};

  fn share(i: u8) -> Scalar {
    Scalar::from_bytes_mod_order(clamp252(crate::primitives::sha256(&[b"point-test", &[i]])))
  }

  #[test]
  fn honest_points_accepted() {
    for i in 0..50 {
      let s = share(i);
      let p = ed_base_mul(&s);
      assert!(validate_point(&p));
      assert!(scalar_matches(&s.to_bytes(), &p));
    }
  }

  #[test]
  fn identity_and_small_order_rejected() {
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert!(!validate_point(&identity));
    for t in small_order_points() {
      assert!(!validate_point(&t), "{}", hex::encode(t));
    }
  }

  #[test]
  fn torsioned_points_rejected_and_unopenable() {
    let s = share(1);
    let honest = s * ED25519_BASEPOINT_POINT;
    for t in EIGHT_TORSION.iter().skip(1) {
      let bad = (honest + t).compress().to_bytes();
      assert!(!validate_point(&bad));
      // Nothing opens it: the honest scalar gives a different point.
      assert!(!scalar_matches(&s.to_bytes(), &bad));
    }
  }

  #[test]
  fn non_canonical_encodings_rejected() {
    // y = p + 1 encodes the same point as y = 1 (the identity) for a lenient decoder.
    let mut y_ge_p = [0xffu8; 32];
    y_ge_p[0] = 0xee;
    y_ge_p[31] = 0x7f;
    assert!(!validate_point(&y_ge_p));
    // "Negative zero": x = 0 with the sign bit set. (0, 1) with sign bit.
    let mut neg_zero = [0u8; 32];
    neg_zero[0] = 1;
    neg_zero[31] = 0x80;
    assert!(!validate_point(&neg_zero));
    // (0, -1) with the sign bit set: order 2, non-canonical.
    let mut neg_zero2 = [0xffu8; 32];
    neg_zero2[0] = 0xec;
    assert!(!validate_point(&neg_zero2));
    // A prime-order point whose y is given as y + p cannot exist below 2^255 except for tiny y;
    // the generic rule is still enforced by the re-compression comparison above.
  }

  #[test]
  fn off_curve_rejected() {
    // y = 2 is not on the curve.
    let mut p = [0u8; 32];
    p[0] = 2;
    assert!(ed_decompress(&p).is_none());
    assert!(!validate_point(&p));
  }

  #[test]
  fn scalar_matches_rejects_non_canonical_and_wrong() {
    let s = share(7);
    let p = ed_base_mul(&s);
    // s + l is the same point mathematically, but is not the canonical opening.
    let l = crate::primitives::L_LE;
    let mut s_plus_l = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
      let v = s.to_bytes()[i] as u16 + l[i] as u16 + carry;
      s_plus_l[i] = v as u8;
      carry = v >> 8;
    }
    assert_eq!(carry, 0);
    assert!(!scalar_matches(&s_plus_l, &p));
    assert!(!scalar_matches(&l, &p));
    assert!(!scalar_matches(&[0xff; 32], &p));
    assert!(!scalar_matches(&(s + Scalar::ONE).to_bytes(), &p));
    assert!(!scalar_matches(&(-s).to_bytes(), &p));
    assert!(!scalar_matches(&[0u8; 32], &p));
  }

  #[test]
  fn add_scalars_wraps_mod_l() {
    let a = (-Scalar::ONE).to_bytes(); // l - 1
    let two = Scalar::from(2u8).to_bytes();
    assert_eq!(add_scalars(&a, &two).unwrap(), Scalar::ONE.to_bytes());
    assert_eq!(add_scalars(&[0xff; 32], &two), Err(Error::ScalarNotCanonical));
  }
}
