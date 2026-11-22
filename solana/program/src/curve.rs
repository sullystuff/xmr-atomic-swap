//! ed25519 key-share checks via the curve25519 syscalls.
use solana_curve25519::{
    edwards::{multiply_edwards, subtract_edwards, PodEdwardsPoint},
    scalar::PodScalar,
};

/// Compressed ed25519 basepoint G (y = 4/5, x positive). Same G as Monero.
pub const ED25519_BASEPOINT: PodEdwardsPoint = PodEdwardsPoint([
    0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
]);

/// Canonical compressed identity (x = 0, y = 1).
pub const IDENTITY: PodEdwardsPoint = PodEdwardsPoint([
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/// l - 1, little-endian, where l = 2^252 + 27742317777372353535851937790883648493.
pub const L_MINUS_1: PodScalar = PodScalar([
    236, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 16,
]);

/// True iff `p` is the canonical encoding of a non-identity point of the
/// prime-order subgroup. One MUL + one SUB syscall.
///
/// -((l-1)·P) == P  <=>  l·P == 0. The syscall output is always the canonical
/// compression, so byte equality with the input also rejects non-canonical
/// encodings (y >= p, "negative zero" x). Off-curve inputs make MUL fail.
pub fn is_valid_key_commitment(p: &PodEdwardsPoint) -> bool {
    if *p == IDENTITY {
        return false;
    }
    let Some(t) = multiply_edwards(&L_MINUS_1, p) else {
        return false;
    };
    let Some(neg_t) = subtract_edwards(&IDENTITY, &t) else {
        return false;
    };
    neg_t == *p
}

/// True iff `s` is a canonical scalar (< l) and s·G == `commitment`.
/// The syscall itself rejects non-canonical scalars (returns None).
pub fn scalar_matches(s: &[u8; 32], commitment: &[u8; 32]) -> bool {
    match multiply_edwards(&PodScalar(*s), &ED25519_BASEPOINT) {
        Some(p) => p.0 == *commitment,
        None => false,
    }
}

/// Logs "Program consumption: N units remaining".
#[inline(always)]
pub fn log_cu() {
    #[cfg(target_os = "solana")]
    unsafe {
        solana_msg::syscalls::sol_log_compute_units_()
    };
}

// ------------------------------------------------------------------ scalars, proofs, X25519 keys

use solana_curve25519::edwards::add_edwards;

/// l, little-endian.
pub const L: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

/// True iff `s` is a canonical scalar: `0 < s < l`, 32 bytes little-endian. No syscall.
pub fn is_canonical_nonzero_scalar(s: &[u8; 32]) -> bool {
    if *s == [0u8; 32] {
        return false;
    }
    // Compare from the most significant byte.
    for i in (0..32).rev() {
        if s[i] < L[i] {
            return true;
        }
        if s[i] > L[i] {
            return false;
        }
    }
    false // s == l
}

/// `clamp252(b)`: `b[31] &= 0x0f`. Always below `2^252 < l`.
pub fn clamp252(mut b: [u8; 32]) -> [u8; 32] {
    b[31] &= 0x0f;
    b
}

/// SPEC 2.4: verify the Schnorr proof of knowledge `pok = R ‖ z` of the spend share behind
/// `s_pub`, bound to `ctx` (the maker PDA for a maker's share, the swap PDA for a taker's).
///
/// `c = clamp252(SHA256(DS("pok") ‖ R ‖ S ‖ ctx))`; accept iff `z` is canonical and
/// `z·G == R + c·S`. Two MUL syscalls and one ADD. The caller has already checked `s_pub` with
/// [`is_valid_key_commitment`].
pub fn pok_verify(s_pub: &[u8; 32], ctx: &[u8; 32], pok: &[u8; 64]) -> bool {
    let r: [u8; 32] = pok[..32].try_into().unwrap();
    let z: [u8; 32] = pok[32..].try_into().unwrap();
    let c = clamp252(crate::util::sha256(&[crate::constants::DS_POK, &r, s_pub, ctx]));
    // Refuses a non-canonical z.
    let Some(lhs) = multiply_edwards(&PodScalar(z), &ED25519_BASEPOINT) else {
        return false;
    };
    let Some(c_s) = multiply_edwards(&PodScalar(c), &PodEdwardsPoint(*s_pub)) else {
        return false;
    };
    // Refuses an R that does not decompress.
    let Some(rhs) = add_edwards(&PodEdwardsPoint(r), &c_s) else {
        return false;
    };
    lhs == rhs
}

/// The seven u-coordinates below 2^255 whose X25519 result is zero for every secret (SPEC 2.8).
const LOW_ORDER_X25519: [[u8; 32]; 7] = [
    [0; 32],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09,
        0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00,
    ],
    [
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b, 0x04, 0x44,
        0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0x57,
    ],
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ],
    [
        0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ],
    [
        0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ],
];

/// True for the fourteen encodings of a low-order X25519 public key: clear bit 255 (X25519
/// ignores it), compare with the seven.
pub fn is_low_order_x25519(key: &[u8; 32]) -> bool {
    let mut masked = *key;
    masked[31] &= 0x7f;
    LOW_ORDER_X25519.iter().any(|p| *p == masked)
}
