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

pub use escrow_logic::encodings::{is_canonical_nonzero_scalar, is_low_order_x25519};

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
