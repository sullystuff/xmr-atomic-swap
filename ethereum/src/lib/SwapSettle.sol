// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Secp256k1KeyCheck} from "./Secp256k1KeyCheck.sol";
import {SwapMath} from "./SwapMath.sol";
import {SwapStore} from "./SwapStore.sol";

/// @notice Every transition of SPEC sections 3.4 to 3.6 after the opening. A linked library:
/// `XmrSwap` enters it by DELEGATECALL, so `msg.sender`, the value and the storage are the
/// proxy's.
/// @dev Check order in every transition (frozen by `transitions.json`): direction, caller, state
/// and open hash, time gate, then secret or evidence. A call refused only because of the time is
/// `TooLate` if one of its windows in that state has already closed, else `TooEarly`.
library SwapSettle {
    function approve(bytes32 swapId, bytes32 expectedOpen) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (s.direction != 0) revert IXmrSwap.WrongDirection();
        IXmrSwap.Maker storage m = SwapStore._operatorOnly($, s);
        _pendingBefore(s, expectedOpen);
        // The share is consumed now, not at lock: a pending lock reserves no key.
        address maker = s.maker;
        _useKey($, maker, s.makerKey);
        _activate(s, m);
        SwapStore._count($, maker, SwapStore.C_APPROVALS);
        emit IXmrSwap.Approved(swapId, maker, SwapStore.C_APPROVALS);
    }

    function fund(
        bytes32 swapId,
        bytes32 expectedOpen,
        address key,
        address key2,
        bytes32 spendPub,
        bytes32 viewShare,
        address watcher
    ) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (s.direction == 0) revert IXmrSwap.WrongDirection();
        IXmrSwap.Maker storage m = SwapStore._operatorOnly($, s);
        _pendingBefore(s, expectedOpen);
        // The maker's watcher (SPEC 11.6), only where the quote had a freeze window. No cap is
        // read here: the whole amount was reserved at `take`.
        if (watcher != address(0)) {
            if (s.freezeSecs == 0) revert IXmrSwap.WatcherNotAllowed();
            s.watcher = watcher;
        }
        if (key == address(0) || key2 == address(0) || spendPub == 0) revert IXmrSwap.BadKey();
        if (!SwapMath.viewValid(viewShare)) revert IXmrSwap.ViewInvalid();
        address maker = s.maker;
        _useKey($, maker, key);
        s.makerKey = key;
        s.makerKey2 = key2;
        s.makerSpendPub = spendPub;
        s.lockerView = viewShare;
        _activate(s, m);
        SwapStore._count($, maker, SwapStore.C_APPROVALS);
        emit IXmrSwap.Funded(swapId, maker, SwapStore.C_APPROVALS, key, key2, spendPub, viewShare, watcher);
        SwapStore._pull(s.token, s.amount, 0);
    }

    function reject(bytes32 swapId, bytes32 expectedOpen, uint8 reason) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        SwapStore._operatorOnly($, s);
        if (s.state != SwapStore.PENDING || s.openHash != expectedOpen || reason > 2) revert IXmrSwap.BadState();
        uint8 counter = reason == 0 ? SwapStore.C_REJECTIONS : SwapStore.C_REJECTIONS_NO_FAULT;
        _closePending($, s, counter);
        emit IXmrSwap.Rejected(swapId, s.maker, counter, reason);
        SwapStore._payout($, s.token, s.taker, _pendingStake(s));
    }

    function cancelPending(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (!SwapStore._isTaker(s)) revert IXmrSwap.Unauthorized();
        if (s.state != SwapStore.PENDING) revert IXmrSwap.BadState();
        _closePending($, s, SwapStore.C_PENDING_CANCELS);
        emit IXmrSwap.PendingCancelled(swapId, s.maker, SwapStore.C_PENDING_CANCELS);
        SwapStore._payout($, s.token, s.taker, _pendingStake(s));
    }

    function expirePending(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (s.state != SwapStore.PENDING) revert IXmrSwap.BadState();
        if (block.timestamp < s.tPendingDeadline) revert IXmrSwap.TooEarly();
        // EXPLICIT_APPROVE: every lapse is an approval timeout, never the fault `missed_funds`.
        _closePending($, s, SwapStore.C_APPROVAL_TIMEOUTS);
        emit IXmrSwap.PendingExpired(swapId, s.maker, SwapStore.C_APPROVAL_TIMEOUTS);
        SwapStore._payout($, s.token, s.taker, _pendingStake(s));
    }

    /// SwapStore.PENDING, the open hash of SPEC 3.12, and the approval or funding deadline.
    function _pendingBefore(SwapStore.Record storage s, bytes32 expectedOpen) private view {
        if (s.state != SwapStore.PENDING || s.openHash != expectedOpen) revert IXmrSwap.BadState();
        if (block.timestamp >= s.tPendingDeadline) revert IXmrSwap.TooLate();
    }

    function _useKey(SwapStore.Layout storage $, address maker, address key) private {
        if ($.keyUsed[maker][key]) revert IXmrSwap.KeyAlreadyUsed();
        $.keyUsed[maker][key] = true;
    }

    /// SwapStore.PENDING -> SwapStore.ACTIVE (A2, B5).
    function _activate(SwapStore.Record storage s, IXmrSwap.Maker storage m) private {
        s.state = SwapStore.ACTIVE;
        s.tActive = uint64(block.timestamp);
        s.tNoteDeadline = uint64(block.timestamp + s.noticeWindow);
        unchecked {
            uint256 sum = uint256(m.responseSecsSum) + (block.timestamp - s.tLock);
            m.responseSecsSum = sum > type(uint64).max ? type(uint64).max : uint64(sum);
            m.openPending -= 1;
        }
    }

    /// Every other exit from SwapStore.PENDING.
    function _closePending(SwapStore.Layout storage $, SwapStore.Record storage s, uint8 counter) private {
        unchecked {
            $.makers[s.maker].openPending -= 1;
        }
        SwapStore._settle($, s, counter);
    }

    /// What a pending exit returns to the taker.
    function _pendingStake(SwapStore.Record storage s) private view returns (uint256) {
        return s.direction == 0 ? s.amount : s.deposit;
    }

    // ------------------------------------------------------------------ progress

    function postNotice(bytes32 swapId, bytes32 commitment, bytes calldata ciphertext) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (!SwapStore._isClaimer($, s)) revert IXmrSwap.Unauthorized();
        if (s.state != SwapStore.ACTIVE) revert IXmrSwap.BadState();
        uint256 tFinal = s.tFinal;
        bool late;
        if (s.direction == 0) {
            if (block.timestamp >= SwapStore._min(s.tNoteDeadline, tFinal)) revert IXmrSwap.TooLate();
        } else {
            // A late notice is still accepted until T_nl; it costs the taker only its protection
            // against a withheld deposit.
            // T_nl = T_final - D_c - W_z - W_c - 86,400.
            if (block.timestamp >= tFinal - s.claimDelay - s.freezeSecs - s.claimWindow - SwapMath.DAY_SECS) {
                revert IXmrSwap.TooLate();
            }
            late = block.timestamp >= s.tNoteDeadline;
        }
        if (ciphertext.length != 104) revert IXmrSwap.BadValue();
        s.state = SwapStore.NOTICED;
        s.flags |= late ? SwapStore.FLAG_NOTICE | SwapStore.FLAG_LATE_NOTICE : SwapStore.FLAG_NOTICE;
        s.noticeCommitment = commitment;
        s.noticeCiphertext = ciphertext;
        s.tNotice = uint64(block.timestamp);
        s.tCut = uint64(block.timestamp + SwapMath.deltaCut(s.depth));
        s.tClaimOpen = uint64(block.timestamp + s.claimDelay);
        address maker = s.maker;
        SwapStore._count($, maker, SwapStore.C_NOTICES);
        emit IXmrSwap.NoticePosted(swapId, maker, SwapStore.C_NOTICES, commitment, ciphertext, late);
    }

    function setReady(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (!SwapStore._isLocker($, s)) revert IXmrSwap.Unauthorized();
        uint8 state = s.state;
        // Z2: a frozen swap is unfrozen by setting ready, until T_ff.
        if (state != SwapStore.NOTICED && state != SwapStore.FROZEN) revert IXmrSwap.BadState();
        if (block.timestamp < s.tNotice + s.depth * SwapMath.READY_MIN_SECS_PER_CONF) revert IXmrSwap.TooEarly();
        uint256 closes = state == SwapStore.NOTICED ? s.tClaimOpen : SwapStore._tFrozenFinal(s);
        if (block.timestamp >= SwapStore._min(closes, s.tFinal)) revert IXmrSwap.TooLate();
        s.state = SwapStore.READY;
        s.tReady = uint64(block.timestamp);
        s.tClaimDeadline = uint64(block.timestamp + s.claimWindow);
        address maker = s.maker;
        SwapStore._count($, maker, SwapStore.C_READIES);
        emit IXmrSwap.ReadySet(swapId, maker, SwapStore.C_READIES);
    }

    /// Z1 (SPEC 11.6): the watcher the swap names, or the locker itself, pushes the opening of
    /// the claim-without-ready from T_co to T_ff. It reveals nothing and moves nothing.
    function freeze(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        address watcher = s.watcher;
        // msg.sender is never zero, so a swap that names no watcher has none.
        if (msg.sender != watcher && !SwapStore._isLocker($, s)) revert IXmrSwap.Unauthorized();
        if (s.state != SwapStore.NOTICED || watcher == address(0)) revert IXmrSwap.BadState();
        if (block.timestamp >= SwapStore._min(s.tClaimOpen, s.tFinal)) revert IXmrSwap.TooLate();
        s.state = SwapStore.FROZEN;
        s.tFreeze = uint64(block.timestamp);
        address maker = s.maker;
        SwapStore._count($, maker, SwapStore.C_FREEZES);
        emit IXmrSwap.Frozen(swapId, maker, SwapStore.C_FREEZES, s.taker, watcher, uint64(SwapStore._tFrozenFinal(s)));
    }

    function abort(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (!SwapStore._isClaimer($, s)) revert IXmrSwap.Unauthorized();
        uint8 state = s.state;
        uint256 tFinal = s.tFinal;
        address maker = s.maker;
        uint8 counter;
        uint8 newState = SwapStore.ABORTED_HOLD;
        if (s.direction == 0) {
            if (state == SwapStore.ACTIVE) {
                // A7a: no notice was ever accepted, so the XMR was never locked.
                if (block.timestamp >= SwapStore._min(s.tNoteDeadline, tFinal)) revert IXmrSwap.TooLate();
                SwapStore._settle($, s, SwapStore.C_ABORTS_PRE_NOTICE);
                emit IXmrSwap.Aborted(swapId, maker, SwapStore.C_ABORTS_PRE_NOTICE, SwapStore.DONE);
                SwapStore._payout($, s.token, s.taker, s.amount);
                return;
            } else if (state == SwapStore.NOTICED) {
                if (block.timestamp < s.tClaimOpen) {
                    (counter, newState) = (SwapStore.C_ABORTS_EARLY, SwapStore.ABORTED_FREE);
                } else {
                    counter = SwapStore.C_ABORTS_LATE;
                }
            } else if (state == SwapStore.READY) {
                (counter, newState) = (SwapStore.C_MISSED_CLAIMS, SwapStore.ABORTED_FREE);
            } else if (state == SwapStore.FROZEN) {
                // Z5: after a freeze the deposit always stays withholdable.
                counter = SwapStore.C_ABORTS_LATE;
            } else {
                revert IXmrSwap.BadState();
            }
        } else {
            if (state != SwapStore.NOTICED && state != SwapStore.READY && state != SwapStore.FROZEN) {
                revert IXmrSwap.BadState();
            }
            counter = SwapStore.C_TAKER_ABORTS;
        }
        if (block.timestamp >= tFinal) revert IXmrSwap.TooLate();
        s.state = newState;
        SwapStore._count($, maker, counter);
        emit IXmrSwap.Aborted(swapId, maker, counter, newState);
    }

    function refundUnnoticed(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (s.direction != 0) revert IXmrSwap.WrongDirection();
        if (s.state != SwapStore.ACTIVE) revert IXmrSwap.BadState();
        if (block.timestamp < s.tNoteDeadline) revert IXmrSwap.TooEarly();
        SwapStore._settle($, s, SwapStore.C_MISSED_NOTICES);
        emit IXmrSwap.RefundedKeyless(swapId, s.maker, SwapStore.C_MISSED_NOTICES);
        SwapStore._payout($, s.token, s.taker, s.amount);
    }

    function expireUnnoticed(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (s.direction == 0) revert IXmrSwap.WrongDirection();
        if (s.state != SwapStore.ACTIVE) revert IXmrSwap.BadState();
        if (block.timestamp < s.tFinal + SwapMath.EXPIRY_SECS) revert IXmrSwap.TooEarly();
        SwapStore._settle($, s, SwapStore.C_EXPIRED_REFUNDS);
        address maker = s.maker;
        address token = s.token;
        emit IXmrSwap.ExpiredUnnoticed(swapId, maker, SwapStore.C_EXPIRED_REFUNDS);
        // The maker's escrow is parked, never pushed: nobody with authority over it is present.
        // It is parked for the maker's owner address, which pulls it with `withdrawOwed`.
        uint256 amount = s.amount;
        $.owed[token][maker] += amount;
        emit IXmrSwap.PayoutDeferred(token, maker, amount);
        SwapStore._payout($, token, s.taker, s.deposit);
    }

    // ------------------------------------------------------------------ settlement

    function refund(bytes32 swapId, uint256 secret) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        uint8 state = s.state;
        bool isA = s.direction == 0;
        uint256 tFinal = s.tFinal;
        // Which row applies: does the refund hold the deposit, and which counter moves.
        bool held;
        uint8 counter;
        if (state == SwapStore.ACTIVE) {
            // A keyed refund is valid in SwapStore.ACTIVE at every instant.
            bool early = block.timestamp < s.tNoteDeadline;
            if (isA) {
                (held, counter) =
                    early ? (true, SwapStore.C_TAKER_CANCELS_APPROVED) : (false, SwapStore.C_MISSED_NOTICES);
            } else {
                (held, counter) = early ? (false, SwapStore.C_BACKOUTS_PRE_NOTICE) : (true, SwapStore.C_TAKER_NO_NOTICE);
            }
        } else if (state == SwapStore.NOTICED && block.timestamp < SwapStore._min(s.tClaimOpen, tFinal)) {
            if (isA) {
                (held, counter) = (true, SwapStore.C_TAKER_REFUNDS_NOTICED);
            } else if (block.timestamp >= s.tCut) {
                (held, counter) = (true, SwapStore.C_REFUNDS_UNCONFIRMED);
            } else if (s.flags & SwapStore.FLAG_LATE_NOTICE != 0) {
                (held, counter) = (true, SwapStore.C_TAKER_NO_NOTICE);
            } else {
                counter = SwapStore.C_BACKOUTS_POST_NOTICE;
            }
        } else if (state == SwapStore.FROZEN && block.timestamp < SwapStore._min(SwapStore._tFrozenFinal(s), tFinal)) {
            // Z3. A: the deposit is held. B: there is no maker bond, so a maker refund after a
            // freeze returns the take deposit at once and can never hold it.
            (held, counter) =
                isA ? (true, SwapStore.C_REFUNDS_AFTER_FREEZE) : (false, SwapStore.C_BACKOUTS_AFTER_FREEZE);
        } else if (state == SwapStore.READY && block.timestamp < tFinal) {
            if (block.timestamp < s.tClaimDeadline) revert IXmrSwap.TooEarly();
            (held, counter) = isA ? (false, SwapStore.C_MISSED_CLAIMS) : (true, SwapStore.C_TAKER_MISSED_CLAIMS);
        } else if ((state == SwapStore.ABORTED_HOLD || state == SwapStore.ABORTED_FREE) && block.timestamp < tFinal) {
            (held, counter) = (state == SwapStore.ABORTED_HOLD, SwapStore.C_REFUNDS_AFTER_ABORT);
        } else if (SwapStore._afterNotice(state)) {
            // Between the end of the last pre-expiry window and T_exp a refund is too late.
            if (block.timestamp < tFinal + SwapMath.EXPIRY_SECS) revert IXmrSwap.TooLate();
            counter = SwapStore.C_EXPIRED_REFUNDS;
        } else {
            revert IXmrSwap.BadState();
        }

        // The secret is the authorisation; the destination is fixed.
        if (!Secp256k1KeyCheck.mulVerify2(secret, isA ? s.takerKey : s.makerKey, isA ? s.takerKey2 : s.makerKey2)) {
            revert IXmrSwap.BadSecret();
        }

        uint256 amount = s.amount;
        uint256 deposit = s.deposit;
        held = held && deposit != 0;
        s.flags |= SwapStore.FLAG_REVEALED | SwapStore.FLAG_REVEALER_LOCKER;
        s.revealed = secret;
        s.tRefund = uint64(block.timestamp);
        address maker = s.maker;
        if (held) {
            s.state = SwapStore.HOLD;
            s.depositState = SwapStore.DEP_HELD;
            // The swap leaves the open states here; the held deposit is a settled obligation.
            SwapStore._uncount($, s);
            SwapStore._count($, maker, counter);
        } else {
            SwapStore._settle($, s, counter);
        }
        emit IXmrSwap.Refunded(swapId, maker, counter, secret, held);

        address token = s.token;
        if (isA) {
            // D is part of amount.
            SwapStore._payout($, token, s.taker, held ? amount - deposit : amount);
        } else {
            // The maker's escrow returns to its current operator, the hot wallet that funded it.
            SwapStore._payout($, token, $.makers[maker].operator, amount);
            if (!held) SwapStore._payout($, token, s.taker, deposit);
        }
    }

    function claim(bytes32 swapId, uint256 secret) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        uint8 state = s.state;
        bool isA = s.direction == 0;
        uint256 tFinal = s.tFinal;
        uint8 counter;
        if (state == SwapStore.READY && block.timestamp < tFinal) {
            if (block.timestamp >= s.tClaimDeadline) revert IXmrSwap.TooLate();
            counter = SwapStore.C_COMPLETED;
        } else if (state == SwapStore.NOTICED && block.timestamp < tFinal) {
            if (block.timestamp < s.tClaimOpen) revert IXmrSwap.TooEarly();
            counter = isA ? SwapStore.C_CLAIMS_WITHOUT_READY : SwapStore.C_TAKER_CLAIMS_WITHOUT_READY;
        } else if (state == SwapStore.FROZEN && block.timestamp < tFinal) {
            // Z4: a freeze moves the opening of the claim-without-ready from T_co to T_ff.
            if (block.timestamp < SwapStore._tFrozenFinal(s)) revert IXmrSwap.TooEarly();
            counter = SwapStore.C_CLAIMS_AFTER_FREEZE;
        } else if (SwapStore._afterNotice(state)) {
            // After an abort the claim returns at T_final: an abort is a waiver, not forever.
            if (block.timestamp < tFinal) revert IXmrSwap.TooEarly();
            if (block.timestamp >= tFinal + SwapMath.EXPIRY_SECS) revert IXmrSwap.TooLate();
            counter = SwapStore.C_CLAIMS_AFTER_FINAL;
        } else {
            revert IXmrSwap.BadState();
        }

        if (!Secp256k1KeyCheck.mulVerify2(secret, isA ? s.makerKey : s.takerKey, isA ? s.makerKey2 : s.takerKey2)) {
            revert IXmrSwap.BadSecret();
        }

        uint256 amount = s.amount;
        uint256 fee = SwapMath.bpsOf(amount, SwapMath.FEE_BPS);
        // The fee is deducted from the claimer's payout; in B the take deposit returns with it.
        uint256 paid = isA ? amount - fee : amount - fee + s.deposit;
        address maker = s.maker;
        address token = s.token;
        s.flags |= SwapStore.FLAG_REVEALED;
        s.revealed = secret;
        SwapStore._settle($, s, counter);
        unchecked {
            uint256 volume = uint256($.volume[maker][token]) + amount;
            $.volume[maker][token] = volume > type(uint128).max ? type(uint128).max : uint128(volume);
        }
        $.treasuryAccrued[token] += fee;
        emit IXmrSwap.Claimed(swapId, maker, counter, secret, paid, fee);

        // A: the payout address set by the maker's cold key, never the operator. B: the payout
        // address the taker named at `take` (its own by default), whoever submits the claim.
        SwapStore._payout($, token, isA ? $.makers[maker].payout : SwapStore._claimTo(s), paid);
    }

    // ------------------------------------------------------------------ deposit sub-machine

    function releaseDeposit(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        uint8 state = s.state;
        bool isOperator = msg.sender == $.makers[s.maker].operator;
        uint8 counter;
        if (state == SwapStore.HOLD) {
            if (!isOperator && block.timestamp < s.tRefund + SwapMath.HOLD_SECS) revert IXmrSwap.TooEarly();
            s.depositState = SwapStore.DEP_RETURNED;
            counter = SwapStore.C_DEPOSITS_RETURNED;
        } else if (state == SwapStore.WITHHELD) {
            if (!isOperator) revert IXmrSwap.Unauthorized();
            s.depositState = SwapStore.DEP_RELEASED;
            counter = SwapStore.C_RELEASES;
        } else {
            revert IXmrSwap.BadState();
        }
        SwapStore._settle($, s, counter);
        uint256 deposit = s.deposit;
        emit IXmrSwap.DepositReleased(swapId, s.maker, counter, deposit);
        SwapStore._payout($, s.token, s.taker, deposit);
    }

    function withhold(bytes32 swapId, bytes32 txid, bytes32 viewShare) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        SwapStore._operatorOnly($, s);
        if (s.state != SwapStore.HOLD) revert IXmrSwap.BadState();
        // Refused at or after T_hold even if nobody has cranked releaseDeposit.
        if (block.timestamp >= s.tRefund + SwapMath.HOLD_SECS) revert IXmrSwap.TooLate();
        if (s.direction == 0 && s.flags & SwapStore.FLAG_NOTICE != 0) {
            // Direction A with a notice on record: the evidence must open the commitment.
            if (txid == 0 && viewShare == 0) revert IXmrSwap.EvidenceRequired();
            _recordEvidence(swapId, s, txid, viewShare);
        }
        s.state = SwapStore.WITHHELD;
        s.depositState = SwapStore.DEP_WITHHELD;
        address maker = s.maker;
        address token = s.token;
        uint256 deposit = s.deposit;
        unchecked {
            uint256 total = uint256($.withheldVolume[maker][token]) + deposit;
            $.withheldVolume[maker][token] = total > type(uint128).max ? type(uint128).max : uint128(total);
        }
        SwapStore._count($, maker, SwapStore.C_WITHHOLDS);
        emit IXmrSwap.DepositWithheld(swapId, maker, SwapStore.C_WITHHOLDS, deposit, txid, viewShare);
    }

    function splitDeposit(bytes32 swapId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (s.state != SwapStore.WITHHELD) revert IXmrSwap.BadState();
        if (block.timestamp < s.tRefund + SwapMath.SPLIT_SECS) revert IXmrSwap.TooEarly();
        (uint256 toTaker, uint256 toTreasury) = SwapMath.splitOf(s.deposit);
        s.depositState = SwapStore.DEP_SPLIT;
        SwapStore._settle($, s, SwapStore.C_SPLITS);
        address token = s.token;
        emit IXmrSwap.DepositSplit(swapId, s.maker, SwapStore.C_SPLITS, toTaker, toTreasury);
        if (SwapMath.SPLIT_TO_BURN) SwapStore._payout($, token, SwapStore.BURN, toTreasury);
        else $.treasuryAccrued[token] += toTreasury;
        SwapStore._payout($, token, s.taker, toTaker);
    }

    function publishEvidence(bytes32 swapId, bytes32 txid, bytes32 viewShare) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        SwapStore.Record storage s = SwapStore._swap($, swapId);
        if (!SwapStore._isClaimer($, s)) revert IXmrSwap.Unauthorized();
        // SwapStore.NOTICED or later, any state including SwapStore.DONE: a notice is on record.
        if (s.flags & SwapStore.FLAG_NOTICE == 0) revert IXmrSwap.BadState();
        _recordEvidence(swapId, s, txid, viewShare);
        emit IXmrSwap.EvidencePublished(swapId, s.maker, SwapStore.C_NONE, txid, viewShare);
    }

    function _recordEvidence(bytes32 swapId, SwapStore.Record storage s, bytes32 txid, bytes32 viewShare) private {
        if (SwapMath.noticeCommitment(swapId, txid, viewShare) != s.noticeCommitment) {
            revert IXmrSwap.EvidenceMismatch();
        }
        s.flags |= SwapStore.FLAG_EVIDENCE;
        s.evidenceTxid = txid;
        s.evidenceView = viewShare;
    }
}
