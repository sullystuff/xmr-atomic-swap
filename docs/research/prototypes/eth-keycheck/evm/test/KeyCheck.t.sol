// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console, Vm} from "forge-std/Test.sol";
import {Secp256k1KeyCheck as K} from "../src/Secp256k1KeyCheck.sol";

contract KeyCheckHarness {
    function mulVerify(uint256 s, address c) external pure returns (bool) { return K.mulVerify(s, c); }
    function mulVerify2(uint256 s, address c, address c2) external pure returns (bool) { return K.mulVerify2(s, c, c2); }
    function mulAddress(uint256 s, uint256 x, uint8 p) external pure returns (address) { return K.mulAddress(s, x, p); }
    /// unguarded variant: what happens WITHOUT the range check
    function rawMul(uint256 s) external pure returns (address) {
        return ecrecover(bytes32(0), 27, bytes32(K.GX), bytes32(mulmod(s, K.GX, K.N)));
    }
}

contract KeyCheckTest is Test {
    KeyCheckHarness h;
    function setUp() public { h = new KeyCheckHarness(); }

    function test_knownVector_s1_isGenerator() public view {
        // address of privkey 1
        assertEq(h.rawMul(1), 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf);
        assertTrue(h.mulVerify(1, 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf));
    }

    function testFuzz_matchesVmAddr(uint256 s) public view {
        s = bound(s, 1, K.MAX_SECRET_EXCLUSIVE - 1);
        address q = vm.addr(s); // foundry's own secp256k1 implementation
        assertTrue(h.mulVerify(s, q));
        assertFalse(h.mulVerify(s, address(uint160(q) ^ 1)));
        if (s + 1 < K.MAX_SECRET_EXCLUSIVE) assertFalse(h.mulVerify(s + 1, q));
    }

    function test_fullPubkeyCommitment() public {
        uint256 s = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
        Vm.Wallet memory w = vm.createWallet(s);
        assertEq(K.commitmentOf(w.publicKeyX, w.publicKeyY), w.addr);
        assertTrue(h.mulVerify(s, K.commitmentOf(w.publicKeyX, w.publicKeyY)));
    }

    function test_zero_rejected() public view {
        // precompile itself returns address(0) for sig_s = 0 ...
        assertEq(h.rawMul(0), address(0));
        // ... so an unguarded check against a zero commitment would pass; the guarded one must not
        assertFalse(h.mulVerify(0, address(0)));
        assertFalse(h.mulVerify(1, address(0)));
        assertFalse(h.mulVerify(0, vm.addr(1)));
    }

    function test_sGreaterEqualN_aliases_without_guard() public view {
        uint256 s = 12345;
        // raw trick is malleable: s and s+n give the same point, s = n behaves like 0
        assertEq(h.rawMul(s + K.N), vm.addr(s));
        assertEq(h.rawMul(K.N), address(0));
        // guarded check rejects all of them
        assertFalse(h.mulVerify(s + K.N, vm.addr(s)));
        assertFalse(h.mulVerify(K.N, address(0)));
        assertFalse(h.mulVerify(type(uint256).max, vm.addr(type(uint256).max - K.N)));
    }

    function test_highS_precompile_has_no_lowS_rule() public view {
        // ecrecover (unlike OZ ECDSA.recover) accepts sig_s > n/2, so the trick works for every s in [1, n-1]
        uint256 s = K.N - 2; // sig_s = s*Gx mod n is "high" for about half of all s anyway
        assertEq(h.rawMul(s), vm.addr(s));
        uint256 found;
        for (uint256 i = 1; i < 40; i++) {
            if (mulmod(i, K.GX, K.N) > K.N / 2) { found++; assertEq(h.rawMul(i), vm.addr(i)); }
        }
        assertGt(found, 5);
        // but values in [2^252, n) are outside the cross-curve range and are rejected by the guard
        assertFalse(h.mulVerify(s, vm.addr(s)));
        assertFalse(h.mulVerify(K.L, vm.addr(K.L)));              // l itself == 0 on ed25519
        assertFalse(h.mulVerify(1 << 252, vm.addr(1 << 252)));
        assertTrue(h.mulVerify((1 << 252) - 1, vm.addr((1 << 252) - 1)));
    }

    function test_boundsOrdering() public pure {
        assertLt(K.MAX_SECRET_EXCLUSIVE, K.L);
        assertLt(K.L, K.N);
        assertEq(K.L, (1 << 252) + 27742317777372353535851937790883648493);
    }

    function test_secondBase_mulAddress() public {
        // T = 7*G ; s*T must equal (7*s)*G
        Vm.Wallet memory t = vm.createWallet(7);
        uint256 s = 0xdeadbeefcafebabe;
        assertEq(h.mulAddress(s, t.publicKeyX, uint8(t.publicKeyY & 1)), vm.addr(mulmod(7, s, K.N)));
        // wrong parity gives s*(-T) = -(s*T): a different address
        assertTrue(h.mulAddress(s, t.publicKeyX, uint8(1 - (t.publicKeyY & 1))) != vm.addr(mulmod(7, s, K.N)));
    }

    /// Vector produced by the Rust prototype (serai `dleq` 0.4.1, CompromiseLinear): the scalar the DLEQ
    /// proof is about, and the Ethereum address of the secp256k1 point the proof verifies to.
    function test_rustDleqVector() public view {
        uint256 s = 0x0f06aa0dc349a8c557f6d69df2c703aa6070a254b10261736a19182d006ac6b3;
        address c = 0x9b4e9b18304F9EE25Fbf235E31df1af1F74279bC;
        assertTrue(h.mulVerify(s, c));
        assertEq(
            K.commitmentOf(
                0xacf6f5e506a07c86fe69d2af43ee9f13131db01927ebfd9439ace816c4a2e556,
                0x61845ade4baebfb4c857d4ea30befdbc2871e089667253c62d57784744858b59
            ),
            c
        );
    }

    function testFuzz_mulVerify2(uint256 s, uint256 other) public view {
        s = bound(s, 1, K.MAX_SECRET_EXCLUSIVE - 1);
        other = bound(other, 1, K.MAX_SECRET_EXCLUSIVE - 1);
        vm.assume(other != s);
        address c = vm.addr(s);
        address c2 = vm.addr(mulmod(s, K.T2, K.N)); // off-chain: address(T2 * P), computable from the public point
        assertTrue(h.mulVerify2(s, c, c2));
        assertFalse(h.mulVerify2(other, c, c2));
        assertFalse(h.mulVerify2(s, c, c));
        assertFalse(h.mulVerify2(s, c, address(0)));
    }

    function test_gas() public {
        {
            uint256 s2 = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
            address q1 = vm.addr(s2);
            address q2 = vm.addr(mulmod(s2, K.T2, K.N));
            uint256 g2 = gasleft();
            bool ok2 = K.mulVerify2(s2, q1, q2);
            g2 = g2 - gasleft();
            assertTrue(ok2);
            console.log("mulVerify2 inline gas:", g2);
        }
        uint256 s = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
        address q = vm.addr(s);
        uint256 g = gasleft();
        bool ok = K.mulVerify(s, q);
        g = g - gasleft();
        assertTrue(ok);
        console.log("mulVerify inline gas (warm precompile):", g);
        g = gasleft();
        ok = h.mulVerify(s, q);
        g = g - gasleft();
        console.log("mulVerify via external call gas:", g);
    }
}
