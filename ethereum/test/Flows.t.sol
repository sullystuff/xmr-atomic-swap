// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {SwapMath} from "../src/lib/SwapMath.sol";
import {Base} from "./utils/Base.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// Dedicated tests of the state machine: binding to the open hash, every row of the refund
/// table, the deposit sub-machine, the fee, and the window edges. Each test that takes `usdc_`
/// runs for ETH and for USDC.
contract FlowsTest is Base {
    uint256 internal constant HOLD_SECS = 1800;
    uint256 internal constant SPLIT_SECS = 5_184_000;
    uint256 internal constant EXPIRY_SECS = 2_592_000;

    struct Bal {
        uint256 taker;
        uint256 payout;
        uint256 operator;
        uint256 makerOwner;
        uint256 treasury;
        uint256 accrued;
        uint256 escrow;
    }

    function _bals(address token) internal view returns (Bal memory b) {
        b.taker = _bal(token, taker);
        b.payout = _bal(token, payout);
        b.operator = _bal(token, operator);
        b.makerOwner = _bal(token, makerOwner);
        b.treasury = _bal(token, treasury);
        b.accrued = swap.treasuryAccrued(token);
        b.escrow = _bal(token, address(swap));
    }

    function _token(bool usdc_) internal view returns (address) {
        return usdc_ ? address(usdc) : ETH;
    }

    function _counter(uint256 i) internal view returns (uint256) {
        return swap.counters(makerOwner)[i];
    }

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }

    function _expectOpen(Open memory o, bytes4 err) internal {
        vm.expectRevert(err);
        this.sendOpen(o);
    }

    // ------------------------------------------------------------------ SPEC 3.12: open hash

    /// The stored open hash is the formula of SPEC 3.12 over the stored swap.
    function test_openHash_formula(bool usdc_, bool directionB) public {
        uint8 direction = directionB ? 1 : 0;
        bytes32 id = _swapIn(direction, _token(usdc_), PENDING);
        IXmrSwap.Swap memory s = _get(id);
        bytes32 want = sha256(
            abi.encodePacked(
                "xmrswap/v1/open",
                bytes1(0),
                id,
                s.tLock,
                s.direction,
                s.token,
                s.xmr,
                s.amount,
                s.deposit,
                s.takerSpendPub,
                s.takerKey,
                s.takerKey2,
                direction == 0 ? s.lockerView : bytes32(0),
                s.takerEncKey,
                s.makerEncKey,
                s.keyLeaf,
                // Amendment 1: the payout argument of take (the taker's own here; zero in A) and
                // the watcher argument of lock (none here).
                direction == 0 ? address(0) : taker,
                address(0)
            )
        );
        assertEq(s.openHash, want);
        if (direction == 0) assertEq(s.keyLeaf, poolLeaves[0]);
        else assertEq(s.keyLeaf, bytes32(0));
    }

    /// The direction-B open-hash vector of `eip712.json`, end to end: the vector taker takes
    /// 2 XMR of USDC at 165.25 with a 1% deposit at t_lock, with the vector keys and nonce.
    function test_openHash_vector_endToEnd() public {
        string memory json = vm.readFile("../interfaces/vectors/eip712.json");
        string memory c;
        string memory idCase;
        for (uint256 i;; ++i) {
            string memory k = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            bytes32 n = keccak256(bytes(vm.parseJsonString(json, string.concat(k, ".name"))));
            if (n == keccak256("open-hash-direction-b")) c = k;
            if (n == keccak256("swap-id")) idCase = k;
        }
        string memory in_ = string.concat(c, ".input");
        // The vector names its own USDC address; the open hash covers the token, so the mock is
        // placed there and the proxy redeployed around it.
        address vUsdc = vm.parseJsonAddress(json, string.concat(in_, ".token"));
        deployCodeTo("Mocks.sol:MockUSDC", vUsdc);
        usdc = MockUSDC(vUsdc);
        _deployAt(address(0));
        vm.prank(makerOwner);
        swap.registerMaker(operator, payout, bytes32(0));
        taker = vm.parseJsonAddress(json, string.concat(idCase, ".input.taker"));
        _fundActors();

        vm.warp(vm.parseJsonUint(json, string.concat(in_, ".t_lock")));
        Open memory o = _open(1, vUsdc, uint64(vm.parseJsonUint(json, string.concat(in_, ".xmr"))), 165_250_000);
        o.nonce = bytes16(vm.parseJsonBytes(json, string.concat(idCase, ".input.swap_nonce")));
        o.tk.spendPub = vm.parseJsonBytes32(json, string.concat(in_, ".taker_spend_pub"));
        o.tk.key = vm.parseJsonAddress(json, string.concat(in_, ".taker_key"));
        o.tk.key2 = vm.parseJsonAddress(json, string.concat(in_, ".taker_key2"));
        o.tk.encKey = vm.parseJsonBytes32(json, string.concat(in_, ".taker_enc_key"));
        o.tk.makerEncKey = vm.parseJsonBytes32(json, string.concat(in_, ".maker_enc_key"));
        bytes32 id = _send(o);
        assertEq(id, vm.parseJsonBytes32(json, string.concat(in_, ".swap_id")));
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.amount, vm.parseJsonUint(json, string.concat(in_, ".amount")));
        assertEq(s.deposit, vm.parseJsonUint(json, string.concat(in_, ".deposit")));
        assertEq(s.openHash, vm.parseJsonBytes32(json, string.concat(c, ".output.open_hash")));
    }

    /// A lock replaced at the same id (a short reorg: the daemon approves before finality) has
    /// another open hash, and `approve`, `fund` and `reject` made for the first one fail.
    function test_openHash_bindsApproveFundReject(bool usdc_, bool directionB, uint8 variant) public {
        uint8 direction = directionB ? 1 : 0;
        variant = uint8(bound(variant, 0, 6));
        address token = _token(usdc_);
        uint256 snap = vm.snapshotState();
        Open memory first = _open(direction, token, uint64(2 * ONE_XMR), _defaultPrice(token));
        bytes32 id = _send(first);
        bytes32 seen = _get(id).openHash; // what the maker's daemon verified
        vm.revertToState(snap);

        // The reorged chain holds another lock under the same id.
        Open memory second = _open(direction, token, uint64(2 * ONE_XMR), _defaultPrice(token));
        second.nonce = first.nonce;
        if (variant == 0) second.xmr += 1; // another size
        if (variant == 1) takerSecret = _share("another taker share"); // other key commitments
        if (variant == 2) second.tk.encKey = keccak256("another taker enc key");
        if (variant == 3) second.tk.makerEncKey = keccak256("another maker enc key");
        if (variant == 4) second.q.depositBps = 250; // another deposit
        if (variant == 5) skip(1); // another lock time
        if (variant == 6) {
            if (direction == 0) second.leafIndex = 3; // another pool leaf
            else second.xmr -= 1;
        }
        if (variant == 1) second.tk = _takerKeys(direction);
        second.q.validUntil = uint64(vm.getBlockTimestamp() + 150);
        second.sig = _signQuote(second.q);
        assertEq(_send(second), id);
        bytes32 actual = _get(id).openHash;
        assertTrue(actual != seen, "a different lock has a different open hash");

        vm.startPrank(operator);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.reject(id, seen, 0);
        if (direction == 0) {
            vm.expectRevert(IXmrSwap.BadState.selector);
            swap.approve(id, seen);
            swap.approve(id, actual);
        } else {
            (address k, address k2) = _twin(_fundSecret());
            uint256 value = token == ETH ? _get(id).amount : 0;
            vm.expectRevert(IXmrSwap.BadState.selector);
            swap.fund{value: value}(id, seen, k, k2, _spendPub(_fundSecret()), _view("maker view share"), address(0));
            swap.fund{value: value}(id, actual, k, k2, _spendPub(_fundSecret()), _view("maker view share"), address(0));
        }
        vm.stopPrank();
        assertEq(_get(id).state, ACTIVE);
    }

    function test_reject_bindsOpenHash_and_reasons(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        for (uint8 reason; reason < 4; ++reason) {
            bytes32 id = _swapIn(directionB ? 1 : 0, token, PENDING);
            bytes32 h = _get(id).openHash;
            uint256 stake = directionB ? _get(id).deposit : _get(id).amount;
            uint256 before = _bal(token, taker);
            vm.startPrank(operator);
            vm.expectRevert(IXmrSwap.BadState.selector);
            swap.reject(id, bytes32(uint256(h) ^ 1), reason);
            if (reason == 3) {
                vm.expectRevert(IXmrSwap.BadState.selector); // reasons are 0, 1 and 2
                swap.reject(id, h, reason);
                vm.stopPrank();
                continue;
            }
            swap.reject(id, h, reason);
            vm.stopPrank();
            assertEq(_bal(token, taker) - before, stake, "a rejection returns everything");
            assertEq(_get(id).outcome, reason == 0 ? 3 : 32);
        }
        assertEq(_counter(3), 1, "rejections");
        assertEq(_counter(32), 2, "rejections_no_fault");
        assertEq(swap.getMaker(makerOwner).openPending, 1);
    }

    // ------------------------------------------------------------------ SPEC 3.10: the refund table

    /// Row 1. Pending: rejected, expired or cancelled. The taker receives everything; the deposit
    /// is never held; the maker has no fault.
    function test_refundTable_row1_pendingExits(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        for (uint256 exit; exit < 3; ++exit) {
            uint256 before = _bal(token, taker);
            bytes32 id = _swapIn(direction, token, PENDING);
            if (exit == 0) {
                bytes32 h = _get(id).openHash;
                vm.prank(operator);
                swap.reject(id, h, 0);
            } else if (exit == 1) {
                vm.warp(_get(id).tPendingDeadline);
                vm.prank(anyone);
                swap.expirePending(id);
            } else {
                vm.prank(session);
                swap.cancelPending(id);
            }
            assertEq(_bal(token, taker), before, "everything returned");
            IXmrSwap.Swap memory s = _get(id);
            assertEq(s.state, DONE);
            assertEq(s.depositState, 0, "never held");
            assertEq(s.revealed, 0, "no secret needed");
        }
        assertEq(_counter(3), 1);
        assertEq(_counter(4), 1);
        assertEq(_counter(5), 1);
        assertEq(_counter(11) + _counter(12) + _counter(13), 0, "no fault");
        assertEq(_bal(token, address(swap)), 0);
    }

    /// Row 2. Approved, no notice by the deadline (A8, or A7a). Everything, keyless, anyone can
    /// send it; never held; fault `missed_notices` (or `aborts_pre_notice`).
    function test_refundTable_row2_noNotice(bool usdc_) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _swapIn(0, token, ACTIVE);
        vm.warp(_get(id).tNoteDeadline - 1);
        vm.prank(anyone);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.refundUnnoticed(id);
        vm.warp(_get(id).tNoteDeadline);
        // The notice is refused from this second on, so the two can never both land.
        bytes32 commitment = _commitment(id);
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.postNotice(id, commitment, _ciphertext());
        vm.prank(anyone);
        swap.refundUnnoticed(id);
        assertEq(_bal(token, taker), before);
        assertEq(_get(id).depositState, 0);
        assertEq(_get(id).outcome, 11);
        assertEq(_counter(11), 1, "fault missed_notices");
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.withhold(id, 0, 0);

        // A7a: the maker aborts before any notice.
        id = _swapIn(0, token, ACTIVE);
        _abort(id);
        assertEq(_bal(token, taker), before);
        assertEq(_get(id).state, DONE);
        assertEq(_counter(14), 1, "aborts_pre_notice");
    }

    /// Row 3. Taker cancels after approval, before the notice deadline (A10a). `amount - D` now;
    /// the deposit is held 30 minutes and is withholdable.
    function test_refundTable_row3_cancelAfterApproval(bool usdc_) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _swapIn(0, token, ACTIVE);
        IXmrSwap.Swap memory s = _get(id);
        vm.warp(s.tNoteDeadline - 1);
        _refund(id);
        assertEq(before - _bal(token, taker), s.deposit, "amount - D returned now");
        s = _get(id);
        assertEq(s.state, HOLD);
        assertEq(s.depositState, 1);
        assertEq(s.revealed, takerSecret);
        assertEq(_counter(20), 1, "taker_cancels_approved");
        assertEq(_counter(11), 0, "no fault");
        // No notice is on record, so the maker withholds without evidence.
        vm.prank(operator);
        swap.withhold(id, 0, 0);
        assertEq(_get(id).state, WITHHELD);
    }

    /// Row 4. Taker refunds after a lock notice (A10b). `amount - D` now; the deposit is held and
    /// withholdable only with evidence; the maker recovers its XMR with `s_T`.
    function test_refundTable_row4_refundAfterNotice(bool usdc_) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _swapIn(0, token, NOTICED);
        IXmrSwap.Swap memory s = _get(id);
        vm.warp(s.tClaimOpen - 1);
        _refund(id);
        assertEq(before - _bal(token, taker), s.deposit);
        assertEq(_get(id).state, HOLD);
        assertEq(_get(id).revealed, takerSecret, "s_T is on-chain");
        assertEq(_counter(21), 1, "taker_refunds_noticed");
        vm.startPrank(operator);
        vm.expectRevert(IXmrSwap.EvidenceRequired.selector);
        swap.withhold(id, 0, 0);
        vm.expectRevert(IXmrSwap.EvidenceMismatch.selector);
        swap.withhold(id, TXID, keccak256("not the view share"));
        swap.withhold(id, TXID, _claimerView());
        vm.stopPrank();
        s = _get(id);
        assertEq(s.state, WITHHELD);
        assertEq(s.evidenceTxid, TXID);
        assertEq(s.evidenceView, _claimerView());
    }

    /// Row 5. Taker never sets ready; maker aborts after its claim delay (A7c then A10c).
    /// `amount - D` when the taker returns before T_final; held; else A11c.
    function test_refundTable_row5_abortLate_thenRefund(bool usdc_) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _swapIn(0, token, ABORTED_HOLD);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(_counter(16), 1, "aborts_late");
        // The abort waived the claim until T_final.
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.claim(id, makerSecrets[0]);
        vm.warp(s.tFinal - 1);
        uint256 snap = vm.snapshotState();
        _refund(id);
        assertEq(before - _bal(token, taker), s.deposit);
        assertEq(_get(id).state, HOLD);
        assertEq(_counter(22), 1, "refunds_after_abort");

        // Else: the taker never returns and the maker claims from T_final (A11c).
        vm.revertToState(snap);
        vm.warp(s.tFinal);
        uint256 payoutBefore = _bal(token, payout);
        _claim(id);
        assertEq(_bal(token, payout) - payoutBefore, s.amount - s.amount * 5 / 10_000);
        assertEq(_counter(10), 1, "claims_after_final");
    }

    /// Row 6. Taker never sets ready or refunds; maker claims after its claim delay (A11b).
    function test_refundTable_row6_claimWithoutReady(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _swapIn(0, token, NOTICED);
        IXmrSwap.Swap memory s = _get(id);
        uint256 takerBefore = _bal(token, taker);
        uint256 payoutBefore = _bal(token, payout);
        vm.warp(s.tClaimOpen - 1);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.claim(id, makerSecrets[0]);
        vm.warp(s.tClaimOpen);
        _claim(id);
        uint256 fee = s.amount * 5 / 10_000;
        assertEq(_bal(token, payout) - payoutBefore, s.amount - fee, "amount - fee");
        assertEq(_bal(token, taker), takerBefore, "nothing from escrow");
        assertEq(swap.treasuryAccrued(token), fee);
        assertEq(_get(id).revealed, makerSecrets[0], "s_M is public: the taker can take the XMR");
        assertEq(_counter(9), 1, "claims_without_ready");
    }

    /// Row 7. Ready set, maker misses its claim deadline (A10e). Everything; never held; fault
    /// `missed_claims`.
    function test_refundTable_row7_missedClaim(bool usdc_) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _swapIn(0, token, READY);
        IXmrSwap.Swap memory s = _get(id);
        vm.warp(s.tClaimDeadline - 1);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.refund(id, takerSecret);
        vm.warp(s.tClaimDeadline);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.claim(id, makerSecrets[0]);
        _refund(id);
        assertEq(_bal(token, taker), before, "everything");
        assertEq(_get(id).state, DONE);
        assertEq(_get(id).depositState, 0, "never held");
        assertEq(_counter(12), 1, "fault missed_claims");
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.withhold(id, TXID, _claimerView());
    }

    /// Row 8. Taker never returns by the final deadline (A11c). Nothing from escrow.
    function test_refundTable_row8_claimAfterFinal(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _swapIn(0, token, READY);
        IXmrSwap.Swap memory s = _get(id);
        uint256 takerBefore = _bal(token, taker);
        uint256 payoutBefore = _bal(token, payout);
        vm.warp(s.tFinal);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.refund(id, takerSecret);
        _claim(id);
        assertEq(_bal(token, payout) - payoutBefore, s.amount - s.amount * 5 / 10_000);
        assertEq(_bal(token, taker), takerBefore);
        assertEq(_counter(10), 1, "claims_after_final");
    }

    /// Rows the table does not list: an early abort (A7b, A7d) gives a full refund with no hold,
    /// and the expiry refund (A10f).
    function test_refundTable_unlisted_directionA(bool usdc_) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _swapIn(0, token, ABORTED_FREE); // A7b
        _refund(id); // A10d
        assertEq(_bal(token, taker), before);
        assertEq(_get(id).state, DONE);
        assertEq(_counter(15), 1);

        id = _swapIn(0, token, READY);
        _abort(id); // A7d
        assertEq(_get(id).state, ABORTED_FREE);
        assertEq(_counter(12), 1, "missed_claims");
        _refund(id);
        assertEq(_bal(token, taker), before);

        id = _swapIn(0, token, NOTICED);
        uint256 tExp = _get(id).tFinal + EXPIRY_SECS;
        vm.warp(tExp - 1);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.refund(id, takerSecret);
        vm.warp(tExp);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.claim(id, makerSecrets[2]);
        _refund(id); // A10f
        assertEq(_bal(token, taker), before);
        assertEq(_get(id).depositState, 0);
        assertEq(_counter(27), 1, "expired_refunds");
    }

    /// Direction B, every refund row: where the maker's escrow and the take deposit go.
    function test_refundTable_directionB(bool usdc_) public {
        address token = _token(usdc_);
        // row id, state to reach, when (0 = now), deposit held?, counter
        _rowB(token, ACTIVE, 0, false, false, 17); // B9a
        _rowB(token, ACTIVE, 1, false, true, 23); // B9b: at T_note
        _rowB(token, NOTICED, 0, false, false, 18); // B9c
        _rowB(token, NOTICED, 0, true, true, 23); // B9h: after a late notice
        _rowB(token, NOTICED, 2, false, true, 24); // B9d: at T_cut
        _rowB(token, READY, 3, false, true, 25); // B9e: at T_cd
        _rowB(token, ABORTED_HOLD, 0, false, true, 22); // B9f
        _rowB(token, NOTICED, 4, false, false, 27); // B9g: at T_exp
    }

    function _rowB(address token, uint8 state, uint256 when, bool lateNotice, bool held, uint8 counter) internal {
        uint256 snap = vm.snapshotState();
        Bal memory pre = _bals(token);
        bytes32 id;
        if (lateNotice) {
            id = _swapIn(1, token, ACTIVE);
            vm.warp(_get(id).tNoteDeadline);
            _notice(id);
            assertEq(_get(id).flags & 16, 16, "late-notice flag");
        } else {
            id = _swapIn(1, token, state);
        }
        IXmrSwap.Swap memory s = _get(id);
        if (when == 1) vm.warp(s.tNoteDeadline);
        if (when == 2) vm.warp(s.tCut);
        if (when == 3) vm.warp(s.tClaimDeadline);
        if (when == 4) vm.warp(s.tFinal + EXPIRY_SECS);
        _refund(id);
        Bal memory post = _bals(token);
        assertEq(post.operator, pre.operator, "the maker's escrow returns to its operator");
        assertEq(post.payout, pre.payout);
        assertEq(pre.taker - post.taker, held ? s.deposit : 0, "the take deposit");
        assertEq(post.escrow, held ? s.deposit : 0);
        assertEq(post.accrued, 0, "refunds carry no fee");
        s = _get(id);
        assertEq(s.state, held ? HOLD : DONE);
        assertEq(s.revealed, _fundSecret(), "every maker refund reveals s_M");
        assertEq(s.flags & 12, 12, "revealed by the locker");
        assertEq(_counter(counter), 1);
        vm.revertToState(snap);
    }

    /// B11: nobody acted after funding. The take deposit returns; the maker's escrow is parked
    /// for the maker's owner address.
    function test_expireUnnoticed(bool usdc_) public {
        address token = _token(usdc_);
        Bal memory pre = _bals(token);
        bytes32 id = _swapIn(1, token, ACTIVE);
        IXmrSwap.Swap memory s = _get(id);
        vm.warp(s.tFinal + EXPIRY_SECS - 1);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.expireUnnoticed(id);
        vm.warp(s.tFinal + EXPIRY_SECS);
        vm.prank(anyone);
        swap.expireUnnoticed(id);
        assertEq(_bal(token, taker), pre.taker, "take deposit returned");
        assertEq(swap.owedOf(token, makerOwner), s.amount, "escrow parked for the maker");
        assertEq(swap.owedOf(token, operator), 0);
        assertEq(_get(id).revealed, 0, "keyless");
        vm.prank(makerOwner);
        swap.withdrawOwed(token, makerOwner);
        assertEq(_bal(token, makerOwner) - pre.makerOwner, s.amount);
        assertEq(_bal(token, address(swap)), 0);
    }

    // ------------------------------------------------------------------ SPEC 3.6: the deposit

    function _held(uint8 direction, address token) internal returns (bytes32 id) {
        if (direction == 0) {
            id = _swapIn(0, token, NOTICED); // A10b
        } else {
            id = _swapIn(1, token, NOTICED);
            vm.warp(_get(id).tCut); // B9d
        }
        _refund(id);
        assertEq(_get(id).state, HOLD);
    }

    function _withhold(bytes32 id) internal {
        bool a = _get(id).direction == 0;
        vm.prank(operator);
        swap.withhold(id, a ? TXID : bytes32(0), a ? _claimerView() : bytes32(0));
    }

    function test_deposit_hold_then_release(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _held(directionB ? 1 : 0, token);
        IXmrSwap.Swap memory s = _get(id);
        assertGt(s.deposit, 0);
        assertEq(before - _bal(token, taker), s.deposit);
        assertEq(_bal(token, address(swap)), s.deposit, "exactly the deposit stays in escrow");

        // Before T_hold only the operator may release.
        vm.warp(s.tRefund + HOLD_SECS - 1);
        address[3] memory others = [taker, session, anyone];
        for (uint256 i; i < 3; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IXmrSwap.TooEarly.selector);
            swap.releaseDeposit(id);
        }
        uint256 snap = vm.snapshotState();
        vm.prank(operator);
        swap.releaseDeposit(id);
        assertEq(_bal(token, taker), before);
        assertEq(_get(id).depositState, 3);
        vm.revertToState(snap);

        // At T_hold anyone may, and the maker can no longer withhold.
        vm.warp(s.tRefund + HOLD_SECS);
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.withhold(id, TXID, _claimerView());
        vm.prank(anyone);
        swap.releaseDeposit(id);
        assertEq(_bal(token, taker), before, "D to the taker");
        s = _get(id);
        assertEq(s.state, DONE);
        assertEq(s.depositState, 3);
        assertEq(s.outcome, 28);
        assertEq(_counter(28), 1, "deposits_returned");
        assertEq(_bal(token, address(swap)), 0);
    }

    function test_deposit_withhold_then_release(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _held(directionB ? 1 : 0, token);
        IXmrSwap.Swap memory s = _get(id);
        // Only the operator withholds.
        address[4] memory others = [taker, session, anyone, makerOwner];
        for (uint256 i; i < 4; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IXmrSwap.Unauthorized.selector);
            swap.withhold(id, TXID, _claimerView());
        }
        vm.warp(s.tRefund + HOLD_SECS - 1);
        _withhold(id);
        assertEq(_get(id).state, WITHHELD);
        assertEq(_get(id).depositState, 2);
        assertEq(_counter(29), 1, "withholds");
        (, uint256 withheld) = swap.volumeOf(makerOwner, token);
        assertEq(withheld, s.deposit, "withheld_volume += D");

        // Withheld: only the operator releases, at any time.
        vm.warp(s.tRefund + HOLD_SECS + 1 days);
        for (uint256 i; i < 4; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IXmrSwap.Unauthorized.selector);
            swap.releaseDeposit(id);
        }
        vm.prank(operator);
        swap.releaseDeposit(id);
        assertEq(_bal(token, taker), before);
        assertEq(_get(id).depositState, 4);
        assertEq(_counter(30), 1, "releases");
        assertEq(_counter(28), 0);
    }

    /// The 60-day split: ceil(D/2) to the taker, floor(D/2) to the treasury, T_split fixed at
    /// the refund.
    function test_deposit_split_after60Days(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint256 before = _bal(token, taker);
        bytes32 id = _held(directionB ? 1 : 0, token);
        IXmrSwap.Swap memory s = _get(id);
        // A split needs a withheld deposit.
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.splitDeposit(id);
        // Withholding at the last second of the hold does not move T_split.
        vm.warp(s.tRefund + HOLD_SECS - 1);
        _withhold(id);
        assertEq(_get(id).tRefund, s.tRefund, "T_split is fixed at the refund");
        vm.warp(s.tRefund + SPLIT_SECS - 1);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.splitDeposit(id);
        vm.warp(s.tRefund + SPLIT_SECS);
        assertEq(SPLIT_SECS, 60 days);
        vm.prank(anyone);
        swap.splitDeposit(id);
        uint256 toTreasury = s.deposit / 2;
        assertEq(before - _bal(token, taker), toTreasury, "the taker gets ceil(D/2) back");
        assertEq(swap.treasuryAccrued(token), toTreasury, "the treasury gets floor(D/2)");
        assertEq(_get(id).depositState, 5);
        assertEq(_counter(31), 1, "splits");
        assertEq(_bal(token, address(swap)), toTreasury);

        // The treasury pulls its half; nobody else can.
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.withdrawTreasury(token, operator);
        vm.prank(treasury);
        swap.withdrawTreasury(token, treasury);
        assertEq(_bal(token, treasury), toTreasury);
        assertEq(_bal(token, address(swap)), 0);
        vm.prank(treasury);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawTreasury(token, treasury);
    }

    function test_deposit_split_roundsToTheTaker() public {
        // D = 3 base units: 2 to the taker, 1 to the treasury.
        Open memory o = _open(0, address(usdc), uint64(ONE_XMR), 300);
        bytes32 id = _send(o);
        assertEq(_get(id).deposit, 3);
        _approve(id);
        uint256 before = usdc.balanceOf(taker);
        _refund(id);
        _withhold(id);
        skip(SPLIT_SECS);
        swap.splitDeposit(id);
        assertEq(usdc.balanceOf(taker) - before, 300 - 3 + 2);
        assertEq(swap.treasuryAccrued(address(usdc)), 1);
    }

    /// Invariant: no call can pay D to the maker, its payout address or its operator.
    function test_deposit_neverReachesTheMaker(bool usdc_, bool directionB, uint8 path) public {
        address token = _token(usdc_);
        path = uint8(bound(path, 0, 3));
        Bal memory pre = _bals(token);
        bytes32 id = _held(directionB ? 1 : 0, token);
        IXmrSwap.Swap memory s = _get(id);
        if (path == 0) {
            vm.prank(operator);
            swap.releaseDeposit(id);
        } else if (path == 1) {
            skip(HOLD_SECS);
            swap.releaseDeposit(id);
        } else if (path == 2) {
            _withhold(id);
            vm.prank(operator);
            swap.releaseDeposit(id);
        } else {
            _withhold(id);
            skip(SPLIT_SECS);
            swap.splitDeposit(id);
        }
        Bal memory post = _bals(token);
        assertEq(post.payout, pre.payout, "payout address");
        assertEq(post.makerOwner, pre.makerOwner, "maker owner");
        // In B the operator got exactly its own escrow back, never the deposit.
        assertEq(post.operator, pre.operator, "operator");
        assertEq(swap.owedOf(token, operator) + swap.owedOf(token, payout) + swap.owedOf(token, makerOwner), 0);
        uint256 toTreasury = path == 3 ? s.deposit / 2 : 0;
        assertEq(pre.taker - post.taker, toTreasury, "the taker gets D, or ceil(D/2)");
        assertEq(post.accrued, toTreasury);
        assertEq(post.escrow, toTreasury);
    }

    /// Invariant: fault refunds and free refunds never enter HOLD, so a maker that was provably
    /// late cannot withhold.
    function test_deposit_faultAndFreeRefundsAreNeverHeld(bool usdc_) public {
        address token = _token(usdc_);
        bytes32[8] memory ids;
        // A7a
        ids[0] = _swapIn(0, token, ACTIVE);
        _abort(ids[0]);
        // A8
        ids[1] = _swapIn(0, token, ACTIVE);
        vm.warp(_get(ids[1]).tNoteDeadline);
        swap.refundUnnoticed(ids[1]);
        // A10d
        ids[2] = _swapIn(0, token, ABORTED_FREE);
        _refund(ids[2]);
        // A10e
        ids[3] = _swapIn(0, token, READY);
        vm.warp(_get(ids[3]).tClaimDeadline);
        _refund(ids[3]);
        // A10g: a keyed refund in ACTIVE after T_note
        ids[4] = _swapIn(0, token, ACTIVE);
        vm.warp(_get(ids[4]).tNoteDeadline);
        _refund(ids[4]);
        // B9a
        ids[5] = _swapIn(1, token, ACTIVE);
        _refund(ids[5]);
        // B9c
        ids[6] = _swapIn(1, token, NOTICED);
        _refund(ids[6]);
        // A10f
        ids[7] = _swapIn(0, token, NOTICED);
        vm.warp(_get(ids[7]).tFinal + EXPIRY_SECS);
        _refund(ids[7]);

        for (uint256 i; i < 8; ++i) {
            IXmrSwap.Swap memory s = _get(ids[i]);
            assertEq(s.state, DONE, "settled at once");
            assertEq(s.depositState, 0, "never held");
            vm.prank(operator);
            vm.expectRevert(IXmrSwap.BadState.selector);
            swap.withhold(ids[i], TXID, _claimerView());
            vm.expectRevert(IXmrSwap.BadState.selector);
            swap.releaseDeposit(ids[i]);
        }
        assertEq(_counter(29), 0);
        assertEq(_bal(token, address(swap)), 0);
    }

    /// D == 0: a refund that would enter HOLD goes straight to DONE and no deposit counter moves.
    function test_deposit_zero_skipsHold(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        Open memory o = _open(directionB ? 1 : 0, token, uint64(2 * ONE_XMR), _defaultPrice(token));
        o.q.depositBps = 0;
        o.sig = _signQuote(o.q);
        uint256 before = _bal(token, taker);
        bytes32 id = _send(o);
        _activate(id);
        if (directionB) vm.warp(_get(id).tNoteDeadline); // B9b would hold
        _refund(id);
        assertEq(_get(id).state, DONE);
        assertEq(_get(id).depositState, 0);
        assertEq(_bal(token, taker), before);
        assertEq(_counter(28) + _counter(29) + _counter(30) + _counter(31), 0);
    }

    function test_publishEvidence(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 id = _swapIn(direction, token, ACTIVE);
        address claimer = _claimer(id);
        address other = directionB ? operator : session;
        // Before a notice there is nothing to open.
        vm.prank(claimer);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.publishEvidence(id, TXID, _claimerView());
        _notice(id);
        vm.prank(other);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.publishEvidence(id, TXID, _claimerView());
        vm.prank(claimer);
        vm.expectRevert(IXmrSwap.EvidenceMismatch.selector);
        swap.publishEvidence(id, TXID, bytes32(uint256(1)));
        // The commitment is bound to the swap id.
        assertTrue(_commitment(id) != _commitment(bytes32(uint256(id) ^ 1)));

        uint32[40] memory before = swap.counters(makerOwner);
        vm.prank(claimer);
        vm.expectEmit(address(swap));
        emit IXmrSwap.EvidencePublished(id, makerOwner, 0xff, TXID, _claimerView());
        swap.publishEvidence(id, TXID, _claimerView());
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.state, NOTICED, "state unchanged");
        assertEq(s.flags & 2, 2);
        assertEq(s.evidenceTxid, TXID);
        assertEq(s.evidenceView, _claimerView());
        assertEq(keccak256(abi.encode(swap.counters(makerOwner))), keccak256(abi.encode(before)), "no counter");

        // Still possible once the swap is DONE.
        vm.warp(s.tClaimOpen);
        _claim(id);
        vm.prank(claimer);
        swap.publishEvidence(id, TXID, _claimerView());
    }

    // ------------------------------------------------------------------ SPEC 3.7: the fee

    function _feeCase(address token, uint8 direction, uint64 xmr, uint256 price, uint256 wantAmount, uint256 wantFee)
        internal
    {
        uint256 snap = vm.snapshotState();
        Bal memory pre = _bals(token);
        Open memory o = _open(direction, token, xmr, price);
        bytes32 id = _send(o);
        _activate(id);
        _notice(id);
        skip(600);
        _ready(id);
        _claim(id);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.amount, wantAmount, "amount");
        Bal memory post = _bals(token);
        assertEq(post.accrued, wantFee, "fee = floor(amount * 5 / 10^4)");
        assertEq(post.escrow, wantFee, "only the fee stays");
        if (direction == 0) {
            assertEq(post.payout - pre.payout, wantAmount - wantFee, "the maker pays the fee in A");
            assertEq(pre.taker - post.taker, wantAmount);
        } else {
            assertEq(post.taker - pre.taker, wantAmount - wantFee, "the taker pays the fee in B");
            assertEq(pre.operator - post.operator, wantAmount);
        }
        (uint256 volume,) = swap.volumeOf(makerOwner, token);
        assertEq(volume, wantAmount, "volume += amount");
        vm.prank(treasury);
        if (wantFee == 0) vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawTreasury(token, treasury);
        assertEq(_bal(token, treasury), wantFee);
        assertEq(_bal(token, address(swap)), 0);
        vm.revertToState(snap);
    }

    /// 0.05% of ETH amounts (18 decimals) and of USDC amounts (6 decimals), with the rounding of
    /// the amount (A up, B down) and of the fee (down).
    function test_fee_eth_and_usdc() public {
        address u = address(usdc);
        // 2.5 XMR at 0.061234567890123456 ETH: 153086419725308640 wei, fee 76543209862654 wei.
        _feeCase(ETH, 0, 2_500_000_000_000, 61234567890123456, 153086419725308640, 76543209862654);
        _feeCase(ETH, 1, 2_500_000_000_000, 61234567890123456, 153086419725308640, 76543209862654);
        // 2.5 XMR at 165.25 USDC: 413.125 USDC, fee 0.206562 USDC (0.2065625 rounded down).
        _feeCase(u, 0, 2_500_000_000_000, 165_250_000, 413_125_000, 206_562);
        _feeCase(u, 1, 2_500_000_000_000, 165_250_000, 413_125_000, 206_562);
        // The amount rounds up in A and down in B: 1/3 XMR at 100 USDC.
        _feeCase(u, 0, 333_333_333_333, 100_000_000, 33_333_334, 16_666);
        _feeCase(u, 1, 333_333_333_333, 100_000_000, 33_333_333, 16_666);
        _feeCase(ETH, 0, 333_333_333_333, 1e18 + 1, 333333333333000001, 166666666666500);
        _feeCase(ETH, 1, 333_333_333_333, 1e18 + 1, 333333333333000000, 166666666666500);
        // Below 2,000 base units the fee is zero; at 2,000 it is one.
        _feeCase(u, 0, uint64(ONE_XMR), 1_999, 1_999, 0);
        _feeCase(u, 0, uint64(ONE_XMR), 2_000, 2_000, 1);
        _feeCase(ETH, 1, uint64(ONE_XMR), 3_999, 3_999, 1);
        _feeCase(ETH, 1, uint64(ONE_XMR), 4_000, 4_000, 2);
        // One USDC cent, and one wei.
        _feeCase(u, 0, uint64(ONE_XMR), 10_000, 10_000, 5);
        _feeCase(ETH, 0, 1, 1e12, 1, 0);
    }

    function testFuzz_fee_and_rounding(bool usdc_, bool directionB, uint64 xmr, uint256 price, uint16 depBps) public {
        address token = _token(usdc_);
        xmr = uint64(bound(xmr, 1, 1e16));
        price = bound(price, 1e12, usdc_ ? 1e12 : 1e22);
        depBps = uint16(bound(depBps, 0, 500));
        Bal memory pre = _bals(token);
        Open memory o = _open(directionB ? 1 : 0, token, xmr, price);
        o.q.depositBps = depBps;
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        IXmrSwap.Swap memory s = _get(id);
        uint256 exact = uint256(xmr) * price;
        assertEq(s.amount, directionB ? exact / 1e12 : (exact + 1e12 - 1) / 1e12, "amount rounding");
        assertEq(s.deposit, s.amount * depBps / 10_000, "deposit rounding");
        _activate(id);
        _notice(id);
        skip(600);
        _ready(id);
        _claim(id);
        uint256 fee = s.amount * 5 / 10_000;
        Bal memory post = _bals(token);
        assertEq(post.accrued - pre.accrued, fee);
        assertEq(post.escrow - pre.escrow, fee, "the escrow keeps exactly the fee");
        if (directionB) {
            assertEq(post.taker - pre.taker, s.amount - fee, "amount - fee + Dp, having posted Dp");
        } else {
            assertEq(post.payout - pre.payout, s.amount - fee);
        }
    }

    /// Refunds, held deposits and pending exits carry no fee.
    function test_fee_onlyOnClaims(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 id = _swapIn(direction, token, PENDING);
        vm.prank(taker);
        swap.cancelPending(id);
        id = _held(direction, token);
        skip(HOLD_SECS);
        swap.releaseDeposit(id);
        assertEq(swap.treasuryAccrued(token), 0);
        assertEq(_bal(token, address(swap)), 0);
        (uint256 volume,) = swap.volumeOf(makerOwner, token);
        assertEq(volume, 0);
    }

    // ------------------------------------------------------------------ SPEC 3.2: exclusive windows

    function _can(bytes memory data) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        vm.prank(anyone);
        (ok,) = address(swap).call(data);
        vm.revertToState(snap);
    }

    /// Invariant 1 at one instant: at most one of the two secret-bearing calls is enabled.
    function _probe(bytes32 id, uint256 at) internal returns (bool refundOk, bool claimOk) {
        vm.warp(at);
        refundOk = _can(abi.encodeCall(IXmrSwap.refund, (id, _lockerSecret(id))));
        claimOk = _can(abi.encodeCall(IXmrSwap.claim, (id, _claimerSecret(id))));
        assertFalse(refundOk && claimOk, "both parties could reveal a secret at the same instant");
    }

    /// Every interval is half-open: a deadline T means "allowed while now < T", and what opens at
    /// T is allowed from now >= T. The boundary second belongs to the later window.
    function _edge(bytes32 id, uint256 t, bool refundBefore, bool claimBefore, bool refundAt, bool claimAt) internal {
        (bool r, bool c) = _probe(id, t - 1);
        assertEq(r, refundBefore, "refund one second before the boundary");
        assertEq(c, claimBefore, "claim one second before the boundary");
        (r, c) = _probe(id, t);
        assertEq(r, refundAt, "refund at the boundary");
        assertEq(c, claimAt, "claim at the boundary");
        (r, c) = _probe(id, t + 1);
        assertEq(r, refundAt, "refund one second after the boundary");
        assertEq(c, claimAt, "claim one second after the boundary");
    }

    function test_windows_noticed(bool usdc_, bool directionB) public {
        bytes32 id = _swapIn(directionB ? 1 : 0, _token(usdc_), NOTICED);
        IXmrSwap.Swap memory s = _get(id);
        (bool r, bool c) = _probe(id, s.tNotice);
        assertTrue(r && !c, "NOTICED [t_N, T_co): locker refund only");
        _edge(id, s.tClaimOpen, true, false, false, true); // T_co: refund closes, claim opens
        _edge(id, s.tFinal, false, true, false, true); // T_final: the claim stays with the claimer
        _edge(id, s.tFinal + EXPIRY_SECS, false, true, true, false); // T_exp: claim closes for good
    }

    function test_windows_ready(bool usdc_, bool directionB) public {
        bytes32 id = _swapIn(directionB ? 1 : 0, _token(usdc_), READY);
        IXmrSwap.Swap memory s = _get(id);
        (bool r, bool c) = _probe(id, s.tReady);
        assertTrue(!r && c, "READY [t_R, T_cd): claimer claim only");
        _edge(id, s.tClaimDeadline, false, true, true, false); // T_cd
        _edge(id, s.tFinal, true, false, false, true); // T_final
        _edge(id, s.tFinal + EXPIRY_SECS, false, true, true, false); // T_exp
    }

    function test_windows_aborted(bool usdc_, bool directionB, bool free) public {
        // Direction B has no ABORTED_FREE.
        uint8 state = free && !directionB ? ABORTED_FREE : ABORTED_HOLD;
        bytes32 id = _swapIn(directionB ? 1 : 0, _token(usdc_), state);
        IXmrSwap.Swap memory s = _get(id);
        (bool r, bool c) = _probe(id, vm.getBlockTimestamp());
        assertTrue(r && !c, "ABORTED [.., T_final): locker refund only");
        _edge(id, s.tFinal, true, false, false, true);
        _edge(id, s.tFinal + EXPIRY_SECS, false, true, true, false);
    }

    function test_windows_active(bool usdc_, bool directionB) public {
        bytes32 id = _swapIn(directionB ? 1 : 0, _token(usdc_), ACTIVE);
        IXmrSwap.Swap memory s = _get(id);
        // ACTIVE: locker refund only, at every instant; the claimer can never claim without a notice.
        uint256[5] memory times =
            [uint256(s.tActive), s.tNoteDeadline - 1, s.tNoteDeadline, s.tFinal, s.tFinal + EXPIRY_SECS + 1];
        for (uint256 i; i < 5; ++i) {
            (bool r, bool c) = _probe(id, times[i]);
            assertTrue(r && !c);
        }
    }

    /// Pending: no secret-bearing call at all; approval and expiry never overlap.
    function test_windows_pending(bool usdc_, bool directionB) public {
        bytes32 id = _swapIn(directionB ? 1 : 0, _token(usdc_), PENDING);
        IXmrSwap.Swap memory s = _get(id);
        (bool r, bool c) = _probe(id, s.tLock);
        assertTrue(!r && !c);
        bytes memory expire = abi.encodeCall(IXmrSwap.expirePending, (id));
        vm.warp(s.tPendingDeadline - 1);
        assertFalse(_can(expire));
        uint256 snap = vm.snapshotState();
        _activate(id); // the last second of the approval window
        vm.revertToState(snap);
        vm.warp(s.tPendingDeadline);
        assertTrue(_can(expire));
        if (directionB) {
            vm.expectRevert(IXmrSwap.TooLate.selector);
            this.fundExternal(id);
        } else {
            bytes32 h = s.openHash;
            vm.prank(operator);
            vm.expectRevert(IXmrSwap.TooLate.selector);
            swap.approve(id, h);
        }
    }

    function fundExternal(bytes32 id) external {
        _fund(id);
    }

    /// The notice and ready windows, both directions.
    function test_windows_notice_and_ready(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        bytes32 id = _swapIn(directionB ? 1 : 0, token, ACTIVE);
        IXmrSwap.Swap memory s = _get(id);
        bytes memory notice = abi.encodeCall(IXmrSwap.postNotice, (id, _commitment(id), _ciphertext()));
        address claimer = _claimer(id);
        uint256 last = directionB ? uint256(s.tFinal) - s.claimDelay - s.claimWindow - 86_400 : s.tNoteDeadline;
        vm.warp(last);
        vm.prank(claimer);
        (bool ok, bytes memory ret) = address(swap).call(notice);
        assertFalse(ok);
        assertEq(bytes4(ret), IXmrSwap.TooLate.selector);
        vm.warp(last - 1);
        vm.prank(claimer);
        (ok,) = address(swap).call(notice);
        assertTrue(ok, "the last second of the notice window");
        s = _get(id);
        assertEq(s.flags & 16 != 0, directionB, "in B a notice after T_note is late");

        // Ready: [t_N + depth * 60, T_co).
        address locker = _locker(id);
        vm.warp(s.tNotice + uint256(s.depth) * 60 - 1);
        vm.prank(locker);
        vm.expectRevert(IXmrSwap.TooEarly.selector);
        swap.setReady(id);
        vm.warp(s.tClaimOpen);
        vm.prank(locker);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.setReady(id);
        vm.warp(s.tClaimOpen - 1);
        vm.prank(locker);
        swap.setReady(id);
        assertEq(_get(id).tClaimDeadline, s.tClaimOpen - 1 + s.claimWindow);
    }

    // ------------------------------------------------------------------ opening: the remaining checks

    function test_open_funds_eth() public {
        Open memory o = _open(0, ETH, uint64(2 * ONE_XMR), 61e15);
        (, uint256 stake) = _stake(o);
        IXmrSwap.PoolLeaf memory leaf = _leaf(0);
        vm.startPrank(taker);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.lock{value: stake - 1}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.lock{value: stake + 1}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        vm.stopPrank();

        // The session budget is forwarded to the session key.
        o.budget = 0.01 ether;
        uint256 sessionBefore = session.balance;
        uint256 takerBefore = taker.balance;
        bytes32 id = _send(o);
        assertEq(session.balance - sessionBefore, 0.01 ether);
        assertEq(takerBefore - taker.balance, stake + 0.01 ether);
        assertEq(address(swap).balance, stake);
        assertEq(_get(id).sessionKey, session);
    }

    function test_open_funds_usdc() public {
        address u = address(usdc);
        Open memory o = _open(0, u, uint64(2 * ONE_XMR), 165_250_000);
        IXmrSwap.PoolLeaf memory leaf = _leaf(0);
        // ETH sent with a USDC lock must be exactly the session budget.
        vm.prank(taker);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.lock{value: 1}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));

        o.budget = 0.01 ether;
        uint256 sessionBefore = session.balance;
        uint256 before = usdc.balanceOf(taker);
        _send(o);
        assertEq(session.balance - sessionBefore, 0.01 ether);
        assertEq(before - usdc.balanceOf(taker), 330_500_000);
        assertEq(usdc.balanceOf(address(swap)), 330_500_000);
        assertEq(address(swap).balance, 0);

        // A token that delivers less than asked is refused.
        usdc.setFeeOnTransfer(1);
        _expectOpen(_open(0, u, uint64(2 * ONE_XMR), 165_250_000), IXmrSwap.ShortTransfer.selector);
        usdc.setFeeOnTransfer(0);

        // A budget without a session key would be burned.
        o = _open(0, u, uint64(2 * ONE_XMR), 165_250_000);
        o.leafIndex = 1;
        o.budget = 1;
        o.sessionKey = address(0);
        _expectOpen(o, IXmrSwap.BadValue.selector);
    }

    function test_fund_funds(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _swapIn(1, token, PENDING);
        IXmrSwap.Swap memory s = _get(id);
        (address k, address k2) = _twin(_fundSecret());
        bytes32 pub = _spendPub(_fundSecret());
        bytes32 v = _view("maker view share");
        uint256 right = token == ETH ? s.amount : 0;
        vm.startPrank(operator);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.fund{value: right + 1}(id, s.openHash, k, k2, pub, v, address(0));
        if (token == ETH) {
            vm.expectRevert(IXmrSwap.BadValue.selector);
            swap.fund{value: right - 1}(id, s.openHash, k, k2, pub, v, address(0));
        }
        // The maker's view share must be canonical and nonzero.
        vm.expectRevert(IXmrSwap.ViewInvalid.selector);
        swap.fund{value: right}(id, s.openHash, k, k2, pub, bytes32(0), address(0));
        vm.expectRevert(IXmrSwap.ViewInvalid.selector);
        swap.fund{value: right}(id, s.openHash, k, k2, pub, bytes32(type(uint256).max), address(0));
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.fund{value: right}(id, s.openHash, k, k2, bytes32(0), v, address(0));
        uint256 before = _bal(token, operator);
        vm.expectEmit(address(swap));
        emit IXmrSwap.Funded(id, makerOwner, 2, k, k2, pub, v, address(0));
        swap.fund{value: right}(id, s.openHash, k, k2, pub, v, address(0));
        vm.stopPrank();
        assertEq(before - _bal(token, operator), s.amount, "amount from the operator");
        assertEq(_bal(token, address(swap)), s.amount + s.deposit);
        s = _get(id);
        assertEq(s.makerKey, k);
        assertEq(s.makerKey2, k2);
        assertEq(s.makerSpendPub, pub);
        assertEq(s.lockerView, v);
        assertTrue(swap.isKeyUsed(makerOwner, k));
    }

    function test_open_priceLimits() public {
        // A: the amount must not exceed maxPay. B: it must reach minReceive.
        Open memory o = _open(0, ETH, uint64(2 * ONE_XMR), 61e15);
        o.limit = 122e15 - 1;
        _expectOpen(o, IXmrSwap.PriceMoved.selector);
        o.limit = 122e15;
        _send(o);
        o = _open(1, ETH, uint64(2 * ONE_XMR), 61e15);
        o.limit = 122e15 + 1;
        _expectOpen(o, IXmrSwap.PriceMoved.selector);
        o.limit = 122e15;
        _send(o);
    }

    function test_open_sizeLimits_and_tiers() public {
        Open memory o = _open(0, ETH, 5, 61e15);
        o.q.minXmr = 10;
        o.q.maxXmr = 20;
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.AmountOutOfRange.selector);
        o.xmr = 21;
        _expectOpen(o, IXmrSwap.AmountOutOfRange.selector);
        o.xmr = 20;
        _send(o);
        // An amount of zero is refused (B rounds down).
        o = _open(1, ETH, 1, 1e11);
        _expectOpen(o, IXmrSwap.AmountOutOfRange.selector);
        // A price above 2^128 - 1 is refused.
        o = _open(0, ETH, 1, uint256(type(uint128).max) + 1);
        _expectOpen(o, IXmrSwap.AmountOutOfRange.selector);

        // Price and depth tiers: the highest used tier whose threshold is reached.
        o = _open(0, ETH, 1, 0);
        o.q.tierXmr = [uint64(0), 1e12, 50e12];
        o.q.tierPrice = [uint256(61e15), 605e14, 60e15];
        o.q.depthXmr = [uint64(0), 1e12, 50e12];
        o.q.depth = [2, 10, 25];
        o.q.claimDelay = 10200; // the floor at depth 25
        uint64[5] memory sizes = [uint64(1e12 - 1), 1e12, 50e12 - 1, 50e12, 90e12];
        uint256[5] memory prices = [uint256(61e15), 605e14, 605e14, 60e15, 60e15];
        uint8[5] memory depths = [2, 10, 10, 25, 25];
        for (uint256 i; i < 5; ++i) {
            o.xmr = sizes[i];
            o.nonce = bytes16(nextNonce++);
            o.leafIndex = uint32(i);
            o.sig = _signQuote(o.q);
            IXmrSwap.Swap memory s = _get(_send(o));
            assertEq(s.price, prices[i]);
            assertEq(s.depth, depths[i]);
            assertEq(s.amount, (uint256(sizes[i]) * prices[i] + 1e12 - 1) / 1e12);
        }
        // The claim-delay floor follows the depth of this size: 10199 is enough at depth 10 only.
        o.q.claimDelay = 10199;
        o.xmr = 1e12;
        o.nonce = bytes16(nextNonce++);
        o.leafIndex = 5;
        o.sig = _signQuote(o.q);
        _send(o);
        o.xmr = 50e12;
        o.nonce = bytes16(nextNonce++);
        o.leafIndex = 6;
        _expectOpen(o, IXmrSwap.ClaimDelayTooShort.selector);

        // Malformed tiers.
        o = _open(0, ETH, 1e12, 61e15);
        o.q.tierXmr[0] = 1;
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.TiersInvalid.selector);
        o = _open(0, ETH, 1e12, 61e15);
        o.q.depthXmr = [uint64(0), 5, 5];
        o.q.depth = [2, 3, 4];
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.TiersInvalid.selector);
        // No usable depth at all is the depth bound's error.
        o = _open(0, ETH, 1e12, 61e15);
        o.q.depth[0] = 0;
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.DepthInvalid.selector);
    }

    function test_open_takerKeys_and_view() public {
        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.tk.spendPub = 0;
        _expectOpen(o, IXmrSwap.BadKey.selector);
        o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.tk.encKey = 0;
        _expectOpen(o, IXmrSwap.BadKey.selector);
        // Direction A: 0 < view < l, read as 32 little-endian bytes.
        o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.tk.viewShare = 0;
        _expectOpen(o, IXmrSwap.ViewInvalid.selector);
        // l itself, little-endian.
        o.tk.viewShare = 0xedd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010;
        _expectOpen(o, IXmrSwap.ViewInvalid.selector);
        // l - 1 is the largest canonical scalar.
        o.tk.viewShare = 0xecd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010;
        _send(o);
        // Direction B: the taker supplies no view share.
        o = _open(1, ETH, uint64(ONE_XMR), 61e15);
        o.tk.viewShare = _view("x");
        _expectOpen(o, IXmrSwap.ViewInvalid.selector);
    }

    function test_open_paused_and_pendingCap() public {
        vm.prank(operator);
        swap.setPaused(true);
        _expectOpen(_open(0, ETH, uint64(ONE_XMR), 61e15), IXmrSwap.Paused.selector);
        vm.prank(makerOwner);
        swap.setPaused(false);

        // 64 pending swaps per maker, both directions together; every exit frees a place.
        bytes32 first;
        for (uint256 i; i < 64; ++i) {
            Open memory o = _open(i % 2 == 0 ? 0 : 1, ETH, 1, 1e12);
            bytes32 id = _send(o);
            if (i == 0) first = id;
        }
        assertEq(swap.getMaker(makerOwner).openPending, 64);
        _expectOpen(_open(0, ETH, 1, 1e12), IXmrSwap.TooManyPending.selector);
        _expectOpen(_open(1, ETH, 1, 1e12), IXmrSwap.TooManyPending.selector);
        _approve(first);
        assertEq(swap.getMaker(makerOwner).openPending, 63);
        _send(_open(1, ETH, 1, 1e12));
        assertEq(swap.swapsOf(taker, 0, 100).length, 65);
    }

    /// A share is consumed at approval, not at lock, and by key address rather than by leaf.
    function test_keyPool_consumedAtApproval() public {
        Open memory one = _open(0, ETH, uint64(ONE_XMR), 61e15);
        Open memory two = _open(0, ETH, uint64(ONE_XMR), 61e15);
        bytes32 a = _send(one);
        bytes32 b = _send(two); // two pending locks may name the same leaf
        address key = _get(a).makerKey;
        assertFalse(swap.isKeyUsed(makerOwner, key), "a pending lock reserves no key");
        _approve(a);
        assertTrue(swap.isKeyUsed(makerOwner, key));
        bytes32 h = _get(b).openHash;
        vm.startPrank(operator);
        vm.expectRevert(IXmrSwap.KeyAlreadyUsed.selector);
        swap.approve(b, h);
        swap.reject(b, h, 2); // the daemon then rejects with reason 2
        vm.stopPrank();
        assertEq(_counter(32), 1);
        // The consumed share cannot be named again, even at another index of a new pool.
        _expectOpen(_open(0, ETH, uint64(ONE_XMR), 61e15), IXmrSwap.KeyAlreadyUsed.selector);
        uint256 shared = makerSecrets[0];
        makerSecrets[3] = shared;
        (address k, address k2) = _twin(shared);
        poolLeaves[3] = SwapMath.leafHash(3, k, k2, _spendPub(shared));
        bytes32[] memory copy = new bytes32[](POOL);
        for (uint256 i; i < POOL; ++i) {
            copy[i] = poolLeaves[i];
        }
        poolRoot = _merkleRoot(copy);
        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.leafIndex = 3;
        _expectOpen(o, IXmrSwap.KeyAlreadyUsed.selector);
        // `fund` shares the mapping.
        bytes32 c = _swapIn(1, ETH, PENDING);
        bytes32 hc = _get(c).openHash;
        vm.expectRevert(IXmrSwap.KeyAlreadyUsed.selector);
        this.fundWith(c, shared, hc);
        _fund(c);
        bytes32 d = _send(_open(1, ETH, uint64(ONE_XMR), 61e15));
        bytes32 hd = _get(d).openHash;
        vm.expectRevert(IXmrSwap.KeyAlreadyUsed.selector);
        this.fundWith(d, _fundSecret(), hd);
    }

    function fundWith(bytes32 id, uint256 secret, bytes32 expectedOpen) external {
        _fundWith(id, secret, expectedOpen, operator);
    }

    function test_leaf_mustBeInThePool() public {
        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        IXmrSwap.PoolLeaf memory leaf = _leaf(2);
        (, uint256 stake) = _stake(o);
        vm.startPrank(taker);
        leaf.index = 1; // the right share under the wrong index
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.lock{value: stake}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        leaf = _leaf(2);
        leaf.spendPub = bytes32(uint256(leaf.spendPub) ^ 1);
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.lock{value: stake}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        leaf = _leaf(2);
        (leaf.key, leaf.key2) = _twin(takerSecret); // a key the taker can open
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.lock{value: stake}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        leaf = _leaf(2);
        leaf.proof[0] = bytes32(uint256(leaf.proof[0]) ^ 1);
        vm.expectRevert(IXmrSwap.BadKey.selector);
        swap.lock{value: stake}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        leaf = _leaf(2);
        swap.lock{value: stake}(o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, leaf, o.a, "", address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ events, session key, views

    function test_lock_event_and_record() public {
        Open memory o = _open(0, ETH, uint64(2 * ONE_XMR), 61e15);
        bytes32 id = _id(o);
        vm.expectEmit(address(swap));
        emit IXmrSwap.Locked(
            id,
            makerOwner,
            taker,
            0,
            ETH,
            0,
            0,
            122e15,
            122e13,
            uint64(2 * ONE_XMR),
            10,
            o.nonce,
            o.tk,
            poolLeaves[0],
            address(0),
            address(0)
        );
        assertEq(_send(o), id);
        IXmrSwap.Swap memory s = _get(id);
        IXmrSwap.PoolLeaf memory leaf = _leaf(0);
        assertEq(s.taker, taker);
        assertEq(s.maker, makerOwner);
        assertEq(s.sessionKey, session);
        assertEq(s.swapNonce, o.nonce);
        assertEq(s.depBps, 100);
        assertEq(s.makerEncVersion, 1);
        assertEq(s.takerSpendPub, o.tk.spendPub);
        assertEq(s.takerKey, o.tk.key);
        assertEq(s.takerKey2, o.tk.key2);
        assertEq(s.lockerView, o.tk.viewShare);
        assertEq(s.takerEncKey, o.tk.encKey);
        assertEq(s.makerEncKey, o.tk.makerEncKey);
        // The leaf's commitments are written provisionally at lock.
        assertEq(s.makerKey, leaf.key);
        assertEq(s.makerKey2, leaf.key2);
        assertEq(s.makerSpendPub, leaf.spendPub);
        assertEq(s.outcome, 0xff);
    }

    function test_notice_storedAndEmitted(bool directionB) public {
        bytes32 id = _swapIn(directionB ? 1 : 0, ETH, ACTIVE);
        address claimer = _claimer(id);
        bytes32 commitment = _commitment(id);
        vm.startPrank(claimer);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.postNotice(id, commitment, new bytes(103));
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.postNotice(id, commitment, new bytes(105));
        vm.expectEmit(address(swap));
        emit IXmrSwap.NoticePosted(id, makerOwner, 6, commitment, _ciphertext(), false);
        swap.postNotice(id, commitment, _ciphertext());
        vm.stopPrank();
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.noticeCommitment, commitment);
        assertEq(s.noticeCiphertext, _ciphertext(), "the ciphertext is in storage: logs are prunable");
    }

    function test_sessionKey_and_takerWallet_rights() public {
        // Direction A: cancel_pending, set_ready.
        bytes32 id = _swapIn(0, ETH, PENDING);
        vm.prank(session);
        swap.cancelPending(id);
        id = _swapIn(0, ETH, NOTICED);
        skip(600);
        vm.prank(taker);
        swap.setReady(id);
        // Direction B: post_notice, abort, publish_evidence by the taker's wallet as well.
        takerSecret = _share("taker b");
        id = _swapIn(1, ETH, ACTIVE);
        bytes32 commitment = _commitment(id);
        vm.prank(taker);
        swap.postNotice(id, commitment, _ciphertext());
        vm.prank(taker);
        swap.publishEvidence(id, TXID, _claimerView());
        vm.prank(taker);
        swap.abort(id);
        assertEq(_get(id).state, ABORTED_HOLD);
        // A session key is valid for its one swap.
        address otherSession = makeAddr("other session");
        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.sessionKey = otherSession;
        o.leafIndex = 2;
        bytes32 other = _send(o);
        vm.prank(session);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.cancelPending(other);
        vm.prank(otherSession);
        swap.cancelPending(other);
    }

    function test_unknownSwap_isBadState() public {
        bytes32 id = keccak256("no such swap");
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.refund(id, 1);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.claim(id, 1);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.expirePending(id);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.releaseDeposit(id);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.approve(id, 0);
        assertEq(_get(id).state, 0);
    }

    function test_swapsOf_paging() public {
        bytes32[] memory ids = new bytes32[](5);
        for (uint256 i; i < 5; ++i) {
            ids[i] = _send(_open(1, ETH, uint64(ONE_XMR), 61e15));
        }
        bytes32[] memory page = swap.swapsOf(taker, 0, 2);
        assertEq(page.length, 2);
        assertEq(page[0], ids[0]);
        page = swap.swapsOf(taker, 3, 10);
        assertEq(page.length, 2);
        assertEq(page[1], ids[4]);
        assertEq(swap.swapsOf(taker, 5, 1).length, 0);
        assertEq(swap.swapsOf(taker, 99, type(uint256).max).length, 0);
        assertEq(swap.swapsOf(anyone, 0, 10).length, 0);
    }

    function test_postMessage() public {
        bytes memory payload = new bytes(900);
        vm.prank(anyone);
        vm.expectEmit(address(swap));
        emit IXmrSwap.Message(anyone, operator, bytes32(uint256(7)), payload);
        swap.postMessage(operator, bytes32(uint256(7)), payload);
        vm.expectRevert(IXmrSwap.MessageTooLarge.selector);
        swap.postMessage(operator, 0, new bytes(901));
    }

    function test_version_and_fixedAddresses() public view {
        assertEq(swap.version(), "1");
        assertEq(swap.treasury(), treasury);
        assertEq(swap.usdc(), address(usdc));
    }
}
