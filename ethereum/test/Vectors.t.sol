// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {SwapMath} from "../src/lib/SwapMath.sol";
import {SwapStore} from "../src/lib/SwapStore.sol";
import {TestStore} from "./utils/Mocks.sol";
import {Base} from "./utils/Base.sol";

/// External entry points to the internal library the contract uses, so vectors can be run
/// against it and its reverts can be caught.
contract MathHarness {
    SwapStore.Record internal s;

    function pay(uint256 xmr, uint256 price) external pure returns (bool, uint256) {
        return SwapMath.payAmount(xmr, price);
    }

    function receive_(uint256 xmr, uint256 price) external pure returns (bool, uint256) {
        return SwapMath.receiveAmount(xmr, price);
    }

    function tier(uint256 xmr, uint64[3] memory above, uint256[3] memory values) external pure returns (bool, uint256) {
        return SwapMath.tierValue(xmr, above, values);
    }

    function bounds(uint256[7] memory p, uint256 pending) external pure {
        SwapMath.checkBounds(p[0], p[1], p[2], p[3], p[4], p[5], p[6], pending);
    }

    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    function openHash(bytes32 swapId, IXmrSwap.Swap memory m, bytes32 takerView) external returns (bytes32) {
        TestStore.store(s, m);
        return SwapMath.openHash(swapId, s, takerView);
    }
}

/// The contract's arithmetic, bounds and hashes against `amounts.json`, `deadlines.json`,
/// `merkle.json`, `notice.json` and the swap-id and open-hash cases of `eip712.json`.
contract VectorsTest is Base {
    string internal constant VECTORS = "../interfaces/vectors/";
    MathHarness internal h = new MathHarness();

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _b32(string memory json, string memory key) internal pure returns (bytes32) {
        string memory v = vm.parseJsonString(json, key);
        if (bytes(v).length == 64) v = string.concat("0x", v);
        return bytes32(vm.parseUint(v));
    }

    function _addr(string memory json, string memory key) internal pure returns (address) {
        string memory v = vm.parseJsonString(json, key);
        if (bytes(v).length == 40) v = string.concat("0x", v);
        return vm.parseAddress(v);
    }

    // ------------------------------------------------------------------ amounts.json

    function test_amountsVectors() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "amounts.json"));
        uint256[5] memory seen; // pay/receive, overflow, bps, split, tier
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            string memory name = vm.parseJsonString(json, string.concat(c, ".name"));
            string memory op = vm.parseJsonString(json, string.concat(c, ".input.op"));
            bool valid = vm.parseJsonBool(json, string.concat(c, ".valid"));
            if (_eq(op, "pay") || _eq(op, "receive")) {
                if (!_eq(vm.parseJsonString(json, string.concat(c, ".input.chain")), "ethereum")) continue;
                uint256 xmr = vm.parseJsonUint(json, string.concat(c, ".input.xmr"));
                uint256 price = vm.parseJsonUint(json, string.concat(c, ".input.price"));
                (bool ok, uint256 amount) = _eq(op, "pay") ? h.pay(xmr, price) : h.receive_(xmr, price);
                assertEq(ok, valid, name);
                if (valid) {
                    assertEq(amount, vm.parseJsonUint(json, string.concat(c, ".output.amount")), name);
                    seen[0]++;
                } else {
                    // The model's MathOverflow: the amount does not fit 128 bits.
                    assertEq(vm.parseJsonString(json, string.concat(c, ".error")), "MathOverflow", name);
                    seen[1]++;
                }
            } else if (_eq(op, "bps")) {
                assertEq(
                    SwapMath.bpsOf(
                        vm.parseJsonUint(json, string.concat(c, ".input.amount")),
                        vm.parseJsonUint(json, string.concat(c, ".input.bps"))
                    ),
                    vm.parseJsonUint(json, string.concat(c, ".output.result")),
                    name
                );
                seen[2]++;
            } else if (_eq(op, "split")) {
                (uint256 toTaker, uint256 toTreasury) =
                    SwapMath.splitOf(vm.parseJsonUint(json, string.concat(c, ".input.deposit")));
                assertEq(toTaker, vm.parseJsonUint(json, string.concat(c, ".output.to_taker")), name);
                assertEq(toTreasury, vm.parseJsonUint(json, string.concat(c, ".output.to_treasury")), name);
                seen[3]++;
            } else {
                assertEq(op, "tier", name);
                uint256[] memory above = vm.parseJsonUintArray(json, string.concat(c, ".input.above"));
                uint256[] memory values = vm.parseJsonUintArray(json, string.concat(c, ".input.values"));
                (bool ok, uint256 value) = h.tier(
                    vm.parseJsonUint(json, string.concat(c, ".input.xmr")),
                    [uint64(above[0]), uint64(above[1]), uint64(above[2])],
                    [values[0], values[1], values[2]]
                );
                assertEq(ok, valid, name);
                if (valid) assertEq(value, vm.parseJsonUint(json, string.concat(c, ".output.value")), name);
                else assertEq(vm.parseJsonString(json, string.concat(c, ".error")), "TiersInvalid", name);
                seen[4]++;
            }
        }
        assertEq(seen[0], 24, "pay and receive");
        assertEq(seen[1], 2, "overflow");
        assertEq(seen[2], 10, "bps");
        assertEq(seen[3], 8, "split");
        assertEq(seen[4], 14, "tier");
    }

    /// The tier vectors once more through `take`: the price the swap stores is the tier's value.
    function test_tierVectors_throughTheContract() public {
        string memory json = vm.readFile(string.concat(VECTORS, "amounts.json"));
        uint256 ran;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!_eq(vm.parseJsonString(json, string.concat(c, ".input.op")), "tier")) continue;
            uint256 xmr = vm.parseJsonUint(json, string.concat(c, ".input.xmr"));
            if (xmr == 0) continue; // a swap of zero XMR is refused
            uint256[] memory above = vm.parseJsonUintArray(json, string.concat(c, ".input.above"));
            uint256[] memory values = vm.parseJsonUintArray(json, string.concat(c, ".input.values"));
            // Scale the values so that the amount is not zero.
            Open memory o = _open(1, ETH, uint64(xmr), 1);
            for (uint256 k; k < 3; ++k) {
                o.q.tierXmr[k] = uint64(above[k]);
                o.q.tierPrice[k] = values[k] * 1e12;
            }
            o.q.minXmr = 0;
            o.q.depositBps = 0;
            o.sig = _signQuote(o.q);
            if (vm.parseJsonBool(json, string.concat(c, ".valid"))) {
                bytes32 id = _send(o);
                assertEq(_get(id).price, vm.parseJsonUint(json, string.concat(c, ".output.value")) * 1e12);
            } else {
                vm.expectRevert(IXmrSwap.TiersInvalid.selector);
                this.sendOpen(o);
            }
            ran++;
        }
        assertEq(ran, 13);
    }

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }

    // ------------------------------------------------------------------ deadlines.json

    function _params(string memory json, string memory c) internal pure returns (uint256[7] memory p) {
        string memory q = string.concat(c, ".input.params");
        p[0] = vm.parseJsonUint(json, string.concat(q, ".dep_bps"));
        p[1] = vm.parseJsonUint(json, string.concat(q, ".w_a"));
        p[2] = vm.parseJsonUint(json, string.concat(q, ".w_n"));
        p[3] = vm.parseJsonUint(json, string.concat(q, ".depth"));
        p[4] = vm.parseJsonUint(json, string.concat(q, ".d_c"));
        p[5] = vm.parseJsonUint(json, string.concat(q, ".w_c"));
        p[6] = vm.parseJsonUint(json, string.concat(q, ".w_f"));
    }

    function _pending(string memory json, string memory c) internal pure returns (uint256) {
        string memory k = vm.parseJsonString(json, string.concat(c, ".input.pending"));
        return _eq(k, "none")
            ? SwapMath.PENDING_NONE
            : (_eq(k, "approval") ? SwapMath.PENDING_APPROVAL : SwapMath.PENDING_FUNDING);
    }

    function test_deadlinesVectors_constantsAndOrder() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "deadlines.json"));
        string memory k = ".constants.ethereum";
        assertEq(SwapMath.BLOCK_ALLOWANCE_SECS, vm.parseJsonUint(json, string.concat(k, ".BLOCK_ALLOWANCE_SECS")));
        assertEq(SwapMath.CUT_MARGIN_SECS, vm.parseJsonUint(json, string.concat(k, ".CUT_MARGIN_SECS")));
        assertEq(SwapMath.EXPIRY_SECS, vm.parseJsonUint(json, string.concat(k, ".EXPIRY_SECS")));
        assertEq(SwapMath.FEE_BPS, vm.parseJsonUint(json, string.concat(k, ".FEE_BPS")));
        assertEq(SwapMath.FINALITY_SECS, vm.parseJsonUint(json, string.concat(k, ".FINALITY_SECS")));
        assertEq(SwapMath.HOLD_SECS, vm.parseJsonUint(json, string.concat(k, ".HOLD_SECS")));
        assertEq(SwapMath.LINK_DELAY_SECS, vm.parseJsonUint(json, string.concat(k, ".LINK_DELAY_SECS")));
        assertEq(SwapMath.MARGIN_SECS, vm.parseJsonUint(json, string.concat(k, ".MARGIN_SECS")));
        assertEq(SwapMath.MAX_APPROVAL_SECS, vm.parseJsonUint(json, string.concat(k, ".MAX_APPROVAL_SECS")));
        assertEq(SwapMath.MAX_DEPOSIT_BPS, vm.parseJsonUint(json, string.concat(k, ".MAX_DEPOSIT_BPS")));
        assertEq(SwapMath.MAX_FINAL_SECS, vm.parseJsonUint(json, string.concat(k, ".MAX_FINAL_SECS")));
        assertEq(SwapMath.MAX_NOTICE_SECS, vm.parseJsonUint(json, string.concat(k, ".MAX_NOTICE_SECS")));
        assertEq(SwapMath.MAX_OPEN_PENDING, vm.parseJsonUint(json, string.concat(k, ".MAX_OPEN_PENDING")));
        assertEq(SwapMath.MIN_APPROVAL_SECS, vm.parseJsonUint(json, string.concat(k, ".MIN_APPROVAL_SECS")));
        assertEq(SwapMath.MIN_CLAIM_DELAY_SECS, vm.parseJsonUint(json, string.concat(k, ".MIN_CLAIM_DELAY_SECS")));
        assertEq(SwapMath.MIN_NOTICE_SECS, vm.parseJsonUint(json, string.concat(k, ".MIN_NOTICE_SECS")));
        assertEq(SwapMath.READY_MIN_SECS_PER_CONF, vm.parseJsonUint(json, string.concat(k, ".READY_MIN_SECS_PER_CONF")));
        assertEq(SwapMath.SPLIT_SECS, vm.parseJsonUint(json, string.concat(k, ".SPLIT_SECS")));
        assertTrue(vm.parseJsonBool(json, string.concat(k, ".EXPLICIT_APPROVE")));
        assertTrue(vm.parseJsonBool(json, string.concat(k, ".OPEN_SECRET_CALLS")));
        assertFalse(vm.parseJsonBool(json, string.concat(k, ".LAPSE_IS_FAULT")));
    }

    function test_deadlinesVectors_bounds() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "deadlines.json"));
        uint256 accepted;
        uint256 refused;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!_eq(vm.parseJsonString(json, string.concat(c, ".input.chain")), "ethereum")) continue;
            if (!_eq(vm.parseJsonString(json, string.concat(c, ".input.op")), "bounds")) continue;
            string memory name = vm.parseJsonString(json, string.concat(c, ".name"));
            uint256[7] memory p = _params(json, c);
            uint256 pending = _pending(json, c);
            if (vm.parseJsonBool(json, string.concat(c, ".valid"))) {
                h.bounds(p, pending);
                string memory out = string.concat(c, ".output");
                uint256 wP = SwapMath.pendingWindow(p[1], p[2], pending);
                assertEq(SwapMath.deltaCut(p[3]), vm.parseJsonUint(json, string.concat(out, ".delta_cut")), name);
                assertEq(
                    SwapMath.minClaimDelay(p[3]), vm.parseJsonUint(json, string.concat(out, ".min_claim_delay")), name
                );
                assertEq(
                    SwapMath.minClaimWindow(), vm.parseJsonUint(json, string.concat(out, ".min_claim_window")), name
                );
                assertEq(
                    SwapMath.minFinalWindow(wP, p[2], p[4], p[5]),
                    vm.parseJsonUint(json, string.concat(out, ".min_final_window")),
                    name
                );
                assertEq(wP, vm.parseJsonUint(json, string.concat(out, ".w_p")), name);
                accepted++;
            } else {
                try h.bounds(p, pending) {
                    revert(string.concat(name, ": bounds accepted"));
                } catch (bytes memory err) {
                    assertEq(bytes4(err), _selector(vm.parseJsonString(json, string.concat(c, ".error"))), name);
                }
                refused++;
            }
        }
        assertEq(accepted, 20);
        assertEq(refused, 16);
    }

    /// The `derive` cases through a real direction-B swap: take at `t_lock`, fund at `t_active`,
    /// notice at `t_notice`, ready at `t_ready`. The three extreme cases are "funded at the last
    /// second with W_n at its cap, a notice at the last second, ready at the last second".
    /// `t_hold`, `t_split`, `t_nl` and `t_exp` are not stored; the replay gates on them.
    function test_deadlinesVectors_derive_throughTheContract() public {
        string memory json = vm.readFile(string.concat(VECTORS, "deadlines.json"));
        uint256 ran;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!_eq(vm.parseJsonString(json, string.concat(c, ".input.chain")), "ethereum")) continue;
            if (!_eq(vm.parseJsonString(json, string.concat(c, ".input.op")), "derive")) continue;
            uint256 snap = vm.snapshotState();
            _derive(json, c);
            vm.revertToState(snap);
            ran++;
        }
        assertEq(ran, 7);
    }

    function _time(string memory json, string memory key) internal pure returns (uint256) {
        return _eq(vm.parseJsonString(json, key), "null") ? 0 : vm.parseJsonUint(json, key);
    }

    function _derive(string memory json, string memory c) internal {
        string memory name = vm.parseJsonString(json, string.concat(c, ".name"));
        string memory out = string.concat(c, ".output");
        uint256[7] memory p = _params(json, c);
        vm.warp(vm.parseJsonUint(json, string.concat(c, ".input.t_lock")));
        Open memory o = _open(1, ETH, uint64(ONE_XMR), 61e15);
        o.q.depositBps = uint16(p[0]);
        o.q.approvalWindow = uint32(p[1]);
        o.q.noticeWindow = uint32(p[2]);
        o.q.depth[0] = uint8(p[3]);
        o.q.claimDelay = uint32(p[4]);
        o.q.claimWindow = uint32(p[5]);
        o.q.finalWindow = uint32(p[6]);
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.tFinal, _time(json, string.concat(out, ".t_final")), string.concat(name, ": t_final"));
        // Ethereum starts every swap PENDING with W_p = W_a (EXPLICIT_APPROVE); the cases generated
        // for the other two pending kinds describe swaps the contract cannot produce.
        if (_pending(json, c) != SwapMath.PENDING_APPROVAL) return;
        assertEq(s.tPendingDeadline, _time(json, string.concat(out, ".t_pend")), string.concat(name, ": t_pend"));

        uint256 t = _time(json, string.concat(c, ".input.t_active"));
        if (t == 0) return;
        vm.warp(t);
        _fund(id);
        assertEq(_get(id).tNoteDeadline, _time(json, string.concat(out, ".t_note")), string.concat(name, ": t_note"));

        t = _time(json, string.concat(c, ".input.t_notice"));
        if (t == 0) return;
        vm.warp(t);
        _notice(id);
        s = _get(id);
        assertEq(s.tCut, _time(json, string.concat(out, ".t_cut")), string.concat(name, ": t_cut"));
        assertEq(s.tClaimOpen, _time(json, string.concat(out, ".t_co")), string.concat(name, ": t_co"));

        t = _time(json, string.concat(c, ".input.t_ready"));
        if (t == 0) return;
        // One second before the earliest ready the call is refused.
        vm.warp(_time(json, string.concat(out, ".t_ready_min")) - 1);
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.setReady(id);
        vm.warp(t);
        _ready(id);
        assertEq(_get(id).tClaimDeadline, _time(json, string.concat(out, ".t_cd")), string.concat(name, ": t_cd"));
        // The latest reachable T_cd still precedes T_final - 86,400.
        assertLt(_get(id).tClaimDeadline, s.tFinal - 86_400, name);
    }

    // ------------------------------------------------------------------ merkle.json

    function test_merkleVectors() public {
        string memory json = vm.readFile(string.concat(VECTORS, "merkle.json"));
        uint256[3] memory seen;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            string memory name = vm.parseJsonString(json, string.concat(c, ".name"));
            if (vm.parseJsonBool(json, string.concat(c, ".valid"))) {
                _pool(json, c, name);
                seen[0]++;
            } else if (_eq(vm.parseJsonString(json, string.concat(c, ".error")), "MerkleProofInvalid")) {
                bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(c, ".input.proof"));
                assertFalse(
                    h.verifyProof(
                        proof, _b32(json, string.concat(c, ".input.root")), _b32(json, string.concat(c, ".input.leaf"))
                    ),
                    name
                );
                seen[1]++;
            } else {
                // Pool-size rules bind the party that builds a pool, not the contract.
                assertEq(vm.parseJsonString(json, string.concat(c, ".error")), "MerklePoolSize", name);
                seen[2]++;
            }
        }
        assertEq(seen[0], 3);
        assertEq(seen[1], 9);
        assertEq(seen[2], 5);
    }

    /// A vector pool: leaf hashes, root and every proof; then a lock that names a vector leaf under
    /// a quote that commits to the vector root, and one with a proof for another leaf.
    function _pool(string memory json, string memory c, string memory name) internal {
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, string.concat(c, ".output.leaf_hashes"));
        bytes32 root = _b32(json, string.concat(c, ".output.root"));
        IXmrSwap.PoolLeaf memory first;
        for (uint256 i; i < hashes.length; ++i) {
            string memory l = string.concat(c, ".input.leaves[", vm.toString(i), "]");
            IXmrSwap.PoolLeaf memory leaf;
            leaf.index = uint32(vm.parseJsonUint(json, string.concat(l, ".index")));
            leaf.key = _addr(json, string.concat(l, ".key_addr"));
            leaf.key2 = _addr(json, string.concat(l, ".key_addr2"));
            leaf.spendPub = _b32(json, string.concat(l, ".spend_pub"));
            leaf.proof = vm.parseJsonBytes32Array(json, string.concat(c, ".output.proofs[", vm.toString(i), "]"));
            assertEq(SwapMath.leafHash(leaf.index, leaf.key, leaf.key2, leaf.spendPub), hashes[i], name);
            assertTrue(h.verifyProof(leaf.proof, root, hashes[i]), name);
            if (i == 0) first = leaf;
            // The proof of leaf 0 proves no other leaf.
            if (i != 0) assertFalse(h.verifyProof(first.proof, root, hashes[i]), name);
        }
        bytes32[] memory copy = new bytes32[](hashes.length);
        for (uint256 i; i < hashes.length; ++i) {
            copy[i] = hashes[i];
        }
        assertEq(_merkleRoot(copy), root, string.concat(name, ": root"));

        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.q.keyRoot = root;
        o.sig = _signQuote(o.q);
        bytes32 id = _lockWithLeaf(o, first);
        assertEq(_get(id).keyLeaf, hashes[0], name);
        assertEq(_get(id).makerKey, first.key, name);
        assertEq(_get(id).makerSpendPub, first.spendPub, name);

        // The same share claimed at another index is not in the pool.
        o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.q.keyRoot = root;
        o.sig = _signQuote(o.q);
        first.index += 1;
        vm.expectRevert(IXmrSwap.BadKey.selector);
        this.lockWithLeaf(o, first);
    }

    function lockWithLeaf(Open memory o, IXmrSwap.PoolLeaf memory leaf) external returns (bytes32) {
        return _lockWithLeaf(o, leaf);
    }

    function _lockWithLeaf(Open memory o, IXmrSwap.PoolLeaf memory leaf) internal returns (bytes32) {
        (, uint256 stake) = _stake(o);
        vm.prank(o.sender);
        return swap.lock{value: stake}(
            o.q, o.sig, o.xmr, o.limit, o.nonce, o.sessionKey, o.budget, o.tk, leaf, o.a, o.approvalSig
        );
    }

    // ------------------------------------------------------------------ notice.json

    function test_noticeVectors_commitment() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "notice.json"));
        assertEq(vm.parseJsonUint(json, ".ciphertext_len"), 104);
        uint256 ran;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!vm.parseJsonBool(json, string.concat(c, ".valid"))) continue;
            bytes32 ref = _b32(json, string.concat(c, ".input.swap_ref"));
            bytes32 txid = _b32(json, string.concat(c, ".input.txid"));
            bytes32 v = _b32(json, string.concat(c, ".input.view"));
            bytes32 want = _b32(json, string.concat(c, ".output.commitment"));
            assertEq(SwapMath.noticeCommitment(ref, txid, v), want);
            // Any other opening gives another commitment.
            assertTrue(SwapMath.noticeCommitment(ref, v, txid) != want);
            assertTrue(SwapMath.noticeCommitment(bytes32(uint256(ref) ^ 1), txid, v) != want);
            ran++;
        }
        assertEq(ran, 4);
    }

    // ------------------------------------------------------------------ eip712.json: ids and open hashes

    function test_swapIdVector() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "eip712.json"));
        uint256 ran;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!_eq(vm.parseJsonString(json, string.concat(c, ".name")), "swap-id")) continue;
            address who = vm.parseJsonAddress(json, string.concat(c, ".input.taker"));
            bytes16 nonce = bytes16(vm.parseJsonBytes(json, string.concat(c, ".input.swap_nonce")));
            assertEq(SwapMath.swapIdOf(who, nonce), vm.parseJsonBytes32(json, string.concat(c, ".output.swap_id")));
            ran++;
        }
        assertEq(ran, 1);
    }

    function test_openHashVectors() public {
        string memory json = vm.readFile(string.concat(VECTORS, "eip712.json"));
        uint256 ran;
        bytes32 previous;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            string memory in_ = string.concat(c, ".input");
            if (!vm.keyExistsJson(json, string.concat(in_, ".taker_spend_pub"))) continue;
            IXmrSwap.Swap memory s;
            s.tLock = uint64(vm.parseJsonUint(json, string.concat(in_, ".t_lock")));
            s.direction = uint8(vm.parseJsonUint(json, string.concat(in_, ".direction")));
            s.token = vm.parseJsonAddress(json, string.concat(in_, ".token"));
            s.xmr = uint64(vm.parseJsonUint(json, string.concat(in_, ".xmr")));
            s.amount = vm.parseJsonUint(json, string.concat(in_, ".amount"));
            s.deposit = vm.parseJsonUint(json, string.concat(in_, ".deposit"));
            s.takerSpendPub = vm.parseJsonBytes32(json, string.concat(in_, ".taker_spend_pub"));
            s.takerKey = vm.parseJsonAddress(json, string.concat(in_, ".taker_key"));
            s.takerKey2 = vm.parseJsonAddress(json, string.concat(in_, ".taker_key2"));
            s.takerEncKey = vm.parseJsonBytes32(json, string.concat(in_, ".taker_enc_key"));
            s.makerEncKey = vm.parseJsonBytes32(json, string.concat(in_, ".maker_enc_key"));
            s.keyLeaf = vm.parseJsonBytes32(json, string.concat(in_, ".key_leaf"));
            bytes32 got = h.openHash(
                vm.parseJsonBytes32(json, string.concat(in_, ".swap_id")),
                s,
                vm.parseJsonBytes32(json, string.concat(in_, ".taker_view"))
            );
            assertEq(got, vm.parseJsonBytes32(json, string.concat(c, ".output.open_hash")));
            // A replaced lock at the same id has another open hash.
            assertTrue(got != previous);
            previous = got;
            ran++;
        }
        assertEq(ran, 3);
    }
}
