// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Cheapest sound on-chain check that a revealed scalar `s` is the discrete log of a
///         committed secp256k1 public key: abuse the ecrecover precompile as a scalar-mul oracle.
///
/// ecrecover(m, v, r, sig_s) returns address( r^-1 * (sig_s * R - m * G) ), R = point with x = r.
/// With m = 0, R = G (r = Gx, v = 27 because Gy is even) and sig_s = s * Gx mod n:
///     r^-1 * (s * Gx) * G = s * G
/// so the precompile hands back address(s*G) = last 20 bytes of keccak256(X || Y).
library Secp256k1KeyCheck {
    /// secp256k1 group order n
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// ed25519 prime-subgroup order l = 2^252 + 27742317777372353535851937790883648493
    uint256 internal constant L = 0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED;
    /// generator x coordinate (Gy is even => v = 27)
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;

    /// @dev The cross-curve DLEQ proof binds a 252-bit scalar, so every honest secret is < 2^252 < L < N.
    ///      Rejecting s >= 2^252 removes the s / s+n malleability (mulmod would reduce it) and keeps the
    ///      revealed value usable verbatim as an ed25519 scalar.
    uint256 internal constant MAX_SECRET_EXCLUSIVE = 1 << 252;

    /// @dev Public tweak for the second commitment: keccak256("xmr-atomic-swap/twin-key/2") mod n would do;
    ///      any fixed non-trivial public constant works. commitment2 = address((T2 * s) * G) = address(T2 * P).
    uint256 internal constant T2 = uint256(keccak256("xmr-atomic-swap/twin-key/2")) % N;

    /// @param s          revealed secret scalar
    /// @param commitment address form of the secp256k1 twin key: address(uint160(uint256(keccak256(X || Y))))
    function mulVerify(uint256 s, address commitment) internal pure returns (bool) {
        if (s == 0 || s >= MAX_SECRET_EXCLUSIVE) return false;
        if (commitment == address(0)) return false; // ecrecover's failure value must never match
        address q = ecrecover(bytes32(0), 27, bytes32(GX), bytes32(mulmod(s, GX, N)));
        return q == commitment;
    }

    /// @notice 320-bit variant: also checks address((T2*s)*G) against a second commitment. A party that
    ///         grinds two scalars with the same 160-bit address (2^80 work) no longer wins; it would need
    ///         a simultaneous collision on both addresses (2^160 work).
    function mulVerify2(uint256 s, address commitment, address commitment2) internal pure returns (bool) {
        if (!mulVerify(s, commitment)) return false;
        if (commitment2 == address(0)) return false;
        // mulmod(s, T2, N) != 0 because N is prime, 0 < s < N and 0 < T2 < N
        address q2 = ecrecover(bytes32(0), 27, bytes32(GX), bytes32(mulmod(mulmod(s, T2, N), GX, N)));
        return q2 == commitment2;
    }

    /// @notice Same trick with an arbitrary base point T (x = tx, y parity = tyParity): returns address(s*T).
    function mulAddress(uint256 s, uint256 tx_, uint8 tyParity) internal pure returns (address) {
        return ecrecover(bytes32(0), 27 + tyParity, bytes32(tx_), bytes32(mulmod(s, tx_, N)));
    }

    function commitmentOf(uint256 x, uint256 y) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(x, y)))));
    }
}
