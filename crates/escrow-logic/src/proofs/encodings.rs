//! Group `encodings`: `is_canonical_scalar` accepts exactly the values below `ℓ`; the identity
//! encoding and all 14 low-order X25519 encodings are rejected.

use crate::encodings::*;

/// The 256-bit value of 32 little-endian bytes as (high, low) 128-bit halves.
fn halves(b: &[u8; 32]) -> (u128, u128) {
  let mut lo = [0u8; 16];
  let mut hi = [0u8; 16];
  let mut i = 0;
  while i < 16 {
    lo[i] = b[i];
    hi[i] = b[i + 16];
    i += 1;
  }
  (u128::from_le_bytes(hi), u128::from_le_bytes(lo))
}

/// ℓ = 2^252 + 27742317777372353535851937790883648493, as halves.
const L_HI: u128 = 1 << 124;
const L_LO: u128 = 27742317777372353535851937790883648493;

#[kani::proof]
#[kani::unwind(33)]
fn canonical_scalar_is_exactly_below_l() {
  // The constant in the code is ℓ.
  assert!(halves(&L) == (L_HI, L_LO));
  let s: [u8; 32] = kani::any();
  let (hi, lo) = halves(&s);
  let below = hi < L_HI || (hi == L_HI && lo < L_LO);
  assert!(is_canonical_scalar(&s) == below);
  assert!(is_canonical_nonzero_scalar(&s) == (below && !(hi == 0 && lo == 0)));
}

#[kani::proof]
#[kani::unwind(33)]
fn low_order_x25519_keys_are_rejected() {
  // All fourteen encodings: the seven points, with bit 255 clear and set.
  let mut k = 0;
  while k < 7 {
    let mut key = LOW_ORDER_X25519[k];
    assert!(is_low_order_x25519(&key));
    key[31] |= 0x80;
    assert!(is_low_order_x25519(&key));
    k += 1;
  }
  // Bit 255 never matters, and nothing else is flagged: a flagged key is one of the seven.
  let key: [u8; 32] = kani::any();
  let mut flipped = key;
  flipped[31] ^= 0x80;
  assert!(is_low_order_x25519(&key) == is_low_order_x25519(&flipped));
  if is_low_order_x25519(&key) {
    let mut masked = key;
    masked[31] &= 0x7f;
    let mut found = false;
    let mut k = 0;
    while k < 7 {
      if LOW_ORDER_X25519[k] == masked {
        found = true;
      }
      k += 1;
    }
    assert!(found);
  }
}

#[kani::proof]
#[kani::unwind(33)]
fn identity_encodings_are_rejected() {
  // y = 1 and y = p + 1, each with either sign bit: every spelling of the identity.
  let p: [u8; 32] = kani::any();
  let (hi, lo) = halves(&p);
  let y_hi = hi & !(1 << 127);
  let y_is_one = y_hi == 0 && lo == 1;
  // p + 1 = 2^255 − 18.
  let y_is_p_plus_one = y_hi == (1 << 127) - 1 && lo == u128::MAX - 17;
  assert!(is_identity_encoding(&p) == (y_is_one || y_is_p_plus_one));
  // The canonical encoding itself.
  let mut canonical = [0u8; 32];
  canonical[0] = 1;
  assert!(is_identity_encoding(&canonical));
}
