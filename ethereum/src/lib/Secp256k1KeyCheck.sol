// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain check that a revealed scalar `s` is the discrete log behind a committed
/// secp256k1 twin key (SPEC 2.6), using the ecrecover precompile as a scalar-multiplication oracle.
///
/// ecrecover(m, v, r, sig_s) returns address(r^-1 * (sig_s * R - m * G)), R = the point with x = r.
/// With m = 0, R = G (r = Gx, v = 27 because Gy is even) and sig_s = s * Gx mod n:
///     r^-1 * (s * Gx) * G = s * G
/// so the precompile hands back address(s*G) = the last 20 bytes of keccak256(X || Y).
///
/// The precompile is called directly. OpenZeppelin's ECDSA wrapper must not be used here: its
/// low-s rule rejects half of all scalars.
library Secp256k1KeyCheck {
    /// secp256k1 group order n.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// Generator x coordinate (Gy is even, so v = 27).
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    /// A spend share is a 252-bit integer: 0 < s < 2^252 < l < n. Rejecting larger values removes the
    /// s / s + n malleability and keeps the revealed value usable verbatim as a Monero scalar.
    uint256 internal constant MAX_SECRET_EXCLUSIVE = 1 << 252;
    /// Public tweak of the second commitment: keyAddr2 = address((T2 * s) * G).
    uint256 internal constant T2 = uint256(keccak256("xmr-atomic-swap/twin-key/2")) % N;

    /// @return true iff 0 < s < 2^252, both commitments are nonzero, address(s*G) == commitment and
    /// address((T2*s)*G) == commitment2. The second address lifts the collision bound from 2^80 to 2^160.
    function mulVerify2(uint256 s, address commitment, address commitment2) internal pure returns (bool) {
        if (s == 0 || s >= MAX_SECRET_EXCLUSIVE) return false;
        // ecrecover's failure value is address(0); it must never match.
        if (commitment == address(0) || commitment2 == address(0)) return false;
        if (ecrecover(bytes32(0), 27, bytes32(GX), bytes32(mulmod(s, GX, N))) != commitment) return false;
        // mulmod(s, T2, N) != 0 because N is prime, 0 < s < N and 0 < T2 < N.
        return ecrecover(bytes32(0), 27, bytes32(GX), bytes32(mulmod(mulmod(s, T2, N), GX, N))) == commitment2;
    }
}
