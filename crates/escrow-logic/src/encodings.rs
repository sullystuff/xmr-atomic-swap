//! Byte-level validators that need no curve arithmetic (SPEC 2.1, 2.8).

/// The group order `ℓ = 2^252 + 27742317777372353535851937790883648493`, little-endian.
pub const L: [u8; 32] = [
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0x10,
];

/// True iff the 32 little-endian bytes are a canonical scalar: a value below `ℓ` (zero included).
pub fn is_canonical_scalar(s: &[u8; 32]) -> bool {
  // Compare from the most significant byte.
  let mut i = 32;
  while i > 0 {
    i -= 1;
    if s[i] < L[i] {
      return true;
    }
    if s[i] > L[i] {
      return false;
    }
  }
  false // s == ℓ
}

/// True iff the bytes are a canonical scalar other than zero: `0 < s < ℓ`.
pub fn is_canonical_nonzero_scalar(s: &[u8; 32]) -> bool {
  let mut any = 0u8;
  let mut i = 0;
  while i < 32 {
    any |= s[i];
    i += 1;
  }
  any != 0 && is_canonical_scalar(s)
}

/// `p + 1` for `p = 2^255 − 19`, little-endian: the non-canonical second spelling of `y = 1`.
const Y_ONE_NONCANONICAL: [u8; 32] = [
  0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
];

/// True for every 32-byte string a permissive decoder reads as the ed25519 identity `(0, 1)`:
/// the canonical `01 00 … 00`, the same with the sign bit set ("negative zero"), and the two
/// spellings with `y = p + 1`. A key commitment MUST NOT be any of them.
pub fn is_identity_encoding(p: &[u8; 32]) -> bool {
  let mut y = *p;
  y[31] &= 0x7f;
  let mut canonical = y[0] == 1;
  let mut wrapped = true;
  let mut i = 0;
  while i < 32 {
    if i > 0 && y[i] != 0 {
      canonical = false;
    }
    if y[i] != Y_ONE_NONCANONICAL[i] {
      wrapped = false;
    }
    i += 1;
  }
  canonical || wrapped
}

/// The seven u-coordinates below 2^255 whose X25519 result is zero for every secret (SPEC 2.8).
pub const LOW_ORDER_X25519: [[u8; 32]; 7] = [
  [0; 32],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [
    0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d,
    0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00,
  ],
  [
    0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b, 0x04, 0x44, 0x5c,
    0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0x57,
  ],
  [
    0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ],
  [
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ],
  [
    0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ],
];

/// True for the fourteen encodings of a low-order X25519 public key: clear bit 255 (X25519
/// ignores it), compare with the seven.
pub fn is_low_order_x25519(key: &[u8; 32]) -> bool {
  let mut masked = *key;
  masked[31] &= 0x7f;
  let mut k = 0;
  while k < 7 {
    let mut same = true;
    let mut i = 0;
    while i < 32 {
      if LOW_ORDER_X25519[k][i] != masked[i] {
        same = false;
      }
      i += 1;
    }
    if same {
      return true;
    }
    k += 1;
  }
  false
}

#[cfg(test)]
mod tests {
  use super::*;

  fn le(mut v: u128, hi: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    for b in out.iter_mut().take(16) {
      *b = v as u8;
      v >>= 8;
    }
    let mut h = hi;
    for b in out.iter_mut().skip(16) {
      *b = h as u8;
      h >>= 8;
    }
    out
  }

  #[test]
  fn canonical_scalars() {
    const L_LO: u128 = 27742317777372353535851937790883648493;
    const L_HI: u128 = 1 << 124;
    assert_eq!(le(L_LO, L_HI), L);
    assert!(is_canonical_scalar(&[0u8; 32]));
    assert!(!is_canonical_nonzero_scalar(&[0u8; 32]));
    assert!(is_canonical_scalar(&le(L_LO - 1, L_HI)));
    assert!(is_canonical_nonzero_scalar(&le(L_LO - 1, L_HI)));
    assert!(!is_canonical_scalar(&L));
    assert!(!is_canonical_scalar(&le(L_LO + 1, L_HI)));
    assert!(is_canonical_scalar(&le(u128::MAX, L_HI - 1)));
    assert!(!is_canonical_scalar(&le(0, L_HI + 1)));
    assert!(!is_canonical_scalar(&[0xff; 32]));
  }

  #[test]
  fn identity_and_low_order() {
    let mut id = [0u8; 32];
    id[0] = 1;
    assert!(is_identity_encoding(&id));
    id[31] = 0x80; // "negative zero"
    assert!(is_identity_encoding(&id));
    let mut wrapped = [0xffu8; 32];
    wrapped[0] = 0xee;
    assert!(is_identity_encoding(&wrapped)); // y = p + 1, sign bit set
    wrapped[31] = 0x7f;
    assert!(is_identity_encoding(&wrapped));
    wrapped[0] = 0xed; // y = p ≡ 0: not the identity
    assert!(!is_identity_encoding(&wrapped));
    // The basepoint is not the identity.
    let mut base = [0x66u8; 32];
    base[0] = 0x58;
    assert!(!is_identity_encoding(&base));
    assert!(!is_identity_encoding(&[0u8; 32]));
    for p in LOW_ORDER_X25519 {
      let mut k = p;
      assert!(is_low_order_x25519(&k));
      k[31] |= 0x80;
      assert!(is_low_order_x25519(&k));
    }
    let mut nine = [0u8; 32];
    nine[0] = 9; // the X25519 basepoint
    assert!(!is_low_order_x25519(&nine));
  }
}
