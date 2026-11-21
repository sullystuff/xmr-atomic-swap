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
