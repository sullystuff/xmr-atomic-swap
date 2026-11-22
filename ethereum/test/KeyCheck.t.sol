// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Secp256k1KeyCheck} from "../src/lib/Secp256k1KeyCheck.sol";
import {SwapMath} from "../src/lib/SwapMath.sol";
import {Base} from "./utils/Base.sol";

contract KeyCheckHarness {
    function verify(uint256 s, address c, address c2) external pure returns (bool) {
        return Secp256k1KeyCheck.mulVerify2(s, c, c2);
    }
}

/// The secp256k1 twin-key check of SPEC 2.6: the library against `twin.json` and `dleq.json`,
/// and the same rules through `claim` and `refund`.
contract KeyCheckTest is Base {
    string internal constant VECTORS = "../interfaces/vectors/";
    uint256 internal constant N = Secp256k1KeyCheck.N;
    KeyCheckHarness internal h = new KeyCheckHarness();

    function _addr(string memory json, string memory key) internal pure returns (address) {
        return vm.parseAddress(string.concat("0x", vm.parseJsonString(json, key)));
    }

    function _hexUint(string memory json, string memory key) internal pure returns (uint256) {
        return vm.parseUint(string.concat("0x", vm.parseJsonString(json, key)));
    }

    function test_T2_matchesVector() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "twin.json"));
        assertEq(Secp256k1KeyCheck.T2, _hexUint(json, ".t2"));
        assertEq(Secp256k1KeyCheck.T2, uint256(keccak256(bytes(vm.parseJsonString(json, ".t2_tag")))) % N);
    }

    function test_twinVectors() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "twin.json"));
        uint256 valid;
        uint256 outOfRange;
        uint256 mismatch;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            string memory name = vm.parseJsonString(json, string.concat(c, ".name"));
            uint256 s = _hexUint(json, string.concat(c, ".input.secret_uint256"));
            // The 32 little-endian bytes of the Monero scalar are the same integer.
            assertEq(
                SwapMath.leToUint(bytes32(_hexUint(json, string.concat(c, ".input.s")))),
                s,
                string.concat(name, ": little-endian reading")
            );
            if (vm.parseJsonBool(json, string.concat(c, ".valid"))) {
                address k = _addr(json, string.concat(c, ".output.key_addr"));
                address k2 = _addr(json, string.concat(c, ".output.key_addr2"));
                assertTrue(h.verify(s, k, k2), name);
                (address tk, address tk2) = _twin(s);
                assertEq(tk, k, string.concat(name, ": keyAddr"));
                assertEq(tk2, k2, string.concat(name, ": keyAddr2"));
                valid++;
                continue;
            }
            string memory err = vm.parseJsonString(json, string.concat(c, ".error"));
            if (keccak256(bytes(err)) == keccak256("ScalarOutOfRange")) {
                // Use the commitments the reduced scalar really opens, so only the range rule can
                // refuse it.
                uint256 reduced = s % N;
                (address k, address k2) = _twin(reduced == 0 ? 1 : reduced);
                assertFalse(h.verify(s, k, k2), name);
                outOfRange++;
            } else {
                assertEq(err, "ScalarMismatch", name);
                address k = _addr(json, string.concat(c, ".input.key_addr"));
                address k2 = _addr(json, string.concat(c, ".input.key_addr2"));
                assertFalse(h.verify(s, k, k2), name);
                mismatch++;
            }
        }
        assertEq(valid, 8);
        assertEq(outOfRange, 6);
        assertEq(mismatch, 4);
    }

    /// `dleq.json`: the scalar a valid blob proves opens the two addresses the verifier computes
    /// from it, and the blob names the same commitments.
    function test_dleqVectors_revealedScalarOpensBlobAddresses() public {
        string memory json = vm.readFile(string.concat(VECTORS, "dleq.json"));
        uint256 valid;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!vm.parseJsonBool(json, string.concat(c, ".valid"))) continue;
            uint256 s = _hexUint(json, string.concat(c, ".input.secret_uint256"));
            address k = _addr(json, string.concat(c, ".output.key_addr"));
            address k2 = _addr(json, string.concat(c, ".output.key_addr2"));
            assertTrue(h.verify(s, k, k2));
            assertFalse(h.verify(s + 1, k, k2));

            // DleqBlob = 0x01 || S[32] || P_compressed[33] || proof
            bytes memory blob =
                vm.readFileBinary(string.concat(VECTORS, vm.parseJsonString(json, string.concat(c, ".input.file"))));
            assertEq(blob.length, vm.parseJsonUint(json, string.concat(c, ".input.length")));
            assertEq(uint256(sha256(blob)), _hexUint(json, string.concat(c, ".input.sha256")));
            assertEq(uint8(blob[0]), 1);
            bytes32 spendPub;
            bytes32 px;
            assembly ("memory-safe") {
                spendPub := mload(add(blob, 33))
                px := mload(add(blob, 66))
            }
            assertEq(uint256(spendPub), _hexUint(json, string.concat(c, ".output.spend_pub")));
            // The x coordinate of P in the blob is the x coordinate of s*G.
            assertEq(uint256(px), vm.createWallet(s).publicKeyX);
            valid++;
        }
        assertEq(valid, 2);
    }

    function test_rejects_zero() public view {
        (address k, address k2) = _twin(1);
        assertFalse(h.verify(0, k, k2));
        assertFalse(h.verify(0, address(0), address(0)));
    }

    function test_rejects_atAndAbove_2_252() public view {
        uint256 top = 1 << 252;
        (address k, address k2) = _twin(top - 1);
        assertTrue(h.verify(top - 1, k, k2));
        (k, k2) = _twin(top);
        assertFalse(h.verify(top, k, k2));
        // s + n opens the same point; it is out of range and refused.
        (k, k2) = _twin(5);
        assertTrue(h.verify(5, k, k2));
        assertFalse(h.verify(N + 5, k, k2));
        assertFalse(h.verify(type(uint256).max, k, k2));
    }

    function test_rejects_zeroCommitment() public view {
        (address k, address k2) = _twin(takerSecret);
        assertFalse(h.verify(takerSecret, address(0), k2));
        assertFalse(h.verify(takerSecret, k, address(0)));
        assertFalse(h.verify(takerSecret, address(0), address(0)));
    }

    function test_rejects_wrongScalar() public view {
        (address k, address k2) = _twin(takerSecret);
        assertTrue(h.verify(takerSecret, k, k2));
        assertFalse(h.verify(takerSecret + 1, k, k2));
        assertFalse(h.verify(takerSecret - 1, k, k2));
        // Either commitment alone is not enough.
        (address o, address o2) = _twin(takerSecret + 1);
        assertFalse(h.verify(takerSecret, k, o2));
        assertFalse(h.verify(takerSecret, o, k2));
        assertFalse(h.verify(takerSecret, k2, k));
    }

    function testFuzz_onlyTheScalarOpens(uint256 s, uint256 other) public view {
        s = bound(s, 1, (1 << 252) - 1);
        other = bound(other, 1, (1 << 252) - 1);
        (address k, address k2) = _twin(s);
        assertTrue(h.verify(s, k, k2));
        if (other != s) assertFalse(h.verify(other, k, k2));
    }

    function test_gas_mulVerify2() public {
        (address k, address k2) = _twin(takerSecret);
        uint256 g = gasleft();
        bool ok = h.verify(takerSecret, k, k2);
        g -= gasleft();
        assertTrue(ok);
        emit log_named_uint("mulVerify2 gas (external call included)", g);
        assertLt(g, 15_000);
    }

    // ------------------------------------------------------------------ through the contract

    function _expectBadSecret(bytes32 id, bool isClaim, uint256 secret) internal {
        vm.expectRevert(IXmrSwap.BadSecret.selector);
        if (isClaim) swap.claim(id, secret);
        else swap.refund(id, secret);
    }

    function test_claim_keyCheck_directionA() public {
        bytes32 id = _swapIn(0, ETH, READY);
        uint256 good = _claimerSecret(id);
        _expectBadSecret(id, true, 0);
        _expectBadSecret(id, true, 1 << 252);
        _expectBadSecret(id, true, good + 1);
        _expectBadSecret(id, true, takerSecret); // the other party's share
        swap.claim(id, good);
        assertEq(_get(id).state, DONE);
        assertEq(_get(id).revealed, good);
    }

    function test_claim_keyCheck_directionB() public {
        bytes32 id = _swapIn(1, address(usdc), READY);
        _expectBadSecret(id, true, 0);
        _expectBadSecret(id, true, type(uint256).max);
        _expectBadSecret(id, true, _fundSecret());
        swap.claim(id, takerSecret);
        assertEq(_get(id).revealed, takerSecret);
    }

    function test_refund_keyCheck_bothDirections() public {
        bytes32 a = _swapIn(0, ETH, ACTIVE);
        _expectBadSecret(a, false, 0);
        _expectBadSecret(a, false, 1 << 252);
        _expectBadSecret(a, false, makerSecrets[0]);
        swap.refund(a, takerSecret);
        assertEq(_get(a).revealed, takerSecret);

        // A second swap of the same taker reuses its nonce counter, not its share.
        takerSecret = _share("taker spend share 2");
        bytes32 b = _swapIn(1, ETH, ACTIVE);
        _expectBadSecret(b, false, 0);
        _expectBadSecret(b, false, takerSecret);
        swap.refund(b, _fundSecret());
        assertEq(_get(b).revealed, _fundSecret());
    }

    /// A zero commitment can never be stored, so `ecrecover`'s failure value can never match.
    function test_zeroCommitment_cannotBeStored() public {
        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.tk.key = address(0);
        vm.expectRevert(IXmrSwap.BadKey.selector);
        this.sendOpen(o);
        o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.tk.key2 = address(0);
        vm.expectRevert(IXmrSwap.BadKey.selector);
        this.sendOpen(o);

        bytes32 id = _swapIn(1, ETH, PENDING);
        IXmrSwap.Swap memory s = _get(id);
        (address k, address k2) = _twin(_fundSecret());
        vm.startPrank(operator);
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.fund{value: s.amount}(id, s.openHash, address(0), k2, bytes32(uint256(1)), _view("v"));
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.fund{value: s.amount}(id, s.openHash, k, address(0), bytes32(uint256(1)), _view("v"));
        vm.stopPrank();
    }

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }
}
