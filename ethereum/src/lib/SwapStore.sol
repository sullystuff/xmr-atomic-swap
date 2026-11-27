// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";

/// @notice Storage layout (one ERC-7201 namespaced struct), state and counter codes, and the
/// internal helpers shared by `XmrSwap` and its two linked logic libraries. The libraries run by
/// DELEGATECALL in the proxy's context, so they reach the same storage through `layout()`.
library SwapStore {
    using SafeERC20 for IERC20;

    // Swap states (SPEC 3.3).
    uint8 internal constant PENDING = 1;
    uint8 internal constant ACTIVE = 2;
    uint8 internal constant NOTICED = 3;
    uint8 internal constant READY = 4;
    uint8 internal constant ABORTED_FREE = 5;
    uint8 internal constant ABORTED_HOLD = 6;
    uint8 internal constant HOLD = 7;
    uint8 internal constant WITHHELD = 8;
    uint8 internal constant DONE = 9;
    uint8 internal constant FROZEN = 10; // Amendment 1 (SPEC 11.6)

    // Bits of `Swap.flags` (the reference model's values).
    uint8 internal constant FLAG_NOTICE = 1;
    uint8 internal constant FLAG_EVIDENCE = 2;
    uint8 internal constant FLAG_REVEALED = 4;
    uint8 internal constant FLAG_REVEALER_LOCKER = 8;
    uint8 internal constant FLAG_LATE_NOTICE = 16;
    /// Counted in the asset's open value (SPEC 11.1): set by the open, cleared by the one
    /// subtraction, so a second subtraction is impossible.
    uint8 internal constant FLAG_COUNTED = 32;

    // `Swap.depositState`.
    uint8 internal constant DEP_HELD = 1;
    uint8 internal constant DEP_WITHHELD = 2;
    uint8 internal constant DEP_RETURNED = 3;
    uint8 internal constant DEP_RELEASED = 4;
    uint8 internal constant DEP_SPLIT = 5;

    // Counter ids (SPEC 3.7); also the `outcome` codes.
    uint8 internal constant C_LOCKS = 0;
    uint8 internal constant C_TAKES = 1;
    uint8 internal constant C_APPROVALS = 2;
    uint8 internal constant C_REJECTIONS = 3;
    uint8 internal constant C_APPROVAL_TIMEOUTS = 4;
    uint8 internal constant C_PENDING_CANCELS = 5;
    uint8 internal constant C_NOTICES = 6;
    uint8 internal constant C_READIES = 7;
    uint8 internal constant C_COMPLETED = 8;
    uint8 internal constant C_CLAIMS_WITHOUT_READY = 9;
    uint8 internal constant C_CLAIMS_AFTER_FINAL = 10;
    uint8 internal constant C_MISSED_NOTICES = 11;
    uint8 internal constant C_MISSED_CLAIMS = 12;
    uint8 internal constant C_ABORTS_PRE_NOTICE = 14;
    uint8 internal constant C_ABORTS_EARLY = 15;
    uint8 internal constant C_ABORTS_LATE = 16;
    uint8 internal constant C_BACKOUTS_PRE_NOTICE = 17;
    uint8 internal constant C_BACKOUTS_POST_NOTICE = 18;
    uint8 internal constant C_TAKER_CLAIMS_WITHOUT_READY = 19;
    uint8 internal constant C_TAKER_CANCELS_APPROVED = 20;
    uint8 internal constant C_TAKER_REFUNDS_NOTICED = 21;
    uint8 internal constant C_REFUNDS_AFTER_ABORT = 22;
    uint8 internal constant C_TAKER_NO_NOTICE = 23;
    uint8 internal constant C_REFUNDS_UNCONFIRMED = 24;
    uint8 internal constant C_TAKER_MISSED_CLAIMS = 25;
    uint8 internal constant C_TAKER_ABORTS = 26;
    uint8 internal constant C_EXPIRED_REFUNDS = 27;
    uint8 internal constant C_DEPOSITS_RETURNED = 28;
    uint8 internal constant C_WITHHOLDS = 29;
    uint8 internal constant C_RELEASES = 30;
    uint8 internal constant C_SPLITS = 31;
    uint8 internal constant C_REJECTIONS_NO_FAULT = 32;
    uint8 internal constant C_FREEZES = 33;
    uint8 internal constant C_REFUNDS_AFTER_FREEZE = 34;
    uint8 internal constant C_BACKOUTS_AFTER_FREEZE = 35;
    uint8 internal constant C_CLAIMS_AFTER_FREEZE = 36;
    uint8 internal constant C_NONE = 0xff;

    address internal constant ANY_TOKEN = 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF;
    uint8 internal constant ANY_DIRECTION = 255;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// Gas forwarded with an ETH payout: enough for an EOA or a simple wallet, not enough to grief.
    uint256 internal constant ETH_STIPEND = 30_000;

    /// @notice A swap as it is stored: the fields of `IXmrSwap.Swap`, packed. `getSwap` returns the
    /// frozen interface struct through `_load`. Amounts and the price are at most 2^128 - 1
    /// (enforced at `lock`/`take`, see `_u128`).
    ///
    /// Slots 0 to 16 are written by `lock` (17 fresh slots; `take` leaves 6, 7, 11, 12 and 15 for
    /// `fund`). Slot 2 is the status slot: every transition writes it, and the one that settles the
    /// swap writes `tSettled` beside the state. ethereum/STORAGE.md records the layout; it must
    /// not change once a proxy is deployed.
    struct Record {
        // slot 0
        address taker;
        uint64 tLock;
        uint32 noticeWindow;
        // slot 1
        address maker;
        uint64 xmr;
        uint32 claimDelay;
        // slot 2: status
        address token;
        uint64 tSettled;
        uint8 state; // SPEC 3.3; 0 = no such swap
        uint8 outcome; // counter id; 0xff while open
        uint8 depositState;
        uint8 flags;
        // slot 3
        address sessionKey;
        uint64 tFinal;
        uint32 claimWindow;
        // slot 4
        address takerKey;
        uint64 tPendingDeadline;
        uint32 makerEncVersion;
        // slot 5
        address takerKey2;
        uint64 tActive;
        uint8 direction;
        uint8 mode;
        uint8 depth;
        // slot 6
        address makerKey;
        uint64 tNoteDeadline;
        uint16 depBps;
        // slot 7
        address makerKey2;
        uint64 tClaimDeadline;
        // slot 8
        uint128 amount;
        uint128 deposit;
        // slot 9
        uint128 price;
        bytes16 swapNonce;
        // slots 10 to 16
        bytes32 takerSpendPub;
        bytes32 makerSpendPub;
        bytes32 lockerView;
        bytes32 takerEncKey;
        bytes32 makerEncKey;
        bytes32 keyLeaf; // direction A: hash of the pool leaf named at lock
        bytes32 openHash; // SPEC 3.12
        // slot 17: first written by the notice
        uint64 tNotice;
        uint64 tCut;
        uint64 tClaimOpen;
        uint64 tReady;
        // slot 18: first written by a keyed refund
        uint64 tRefund;
        // slots 19 to 23
        bytes32 noticeCommitment;
        bytes noticeCiphertext; // 104 bytes, in storage: logs are prunable
        bytes32 evidenceTxid;
        bytes32 evidenceView;
        uint256 revealed; // the revealed spend share; kept in storage
        // Amendment 1 (SPEC 11.8), appended. A swap with the default payout, no freeze window and
        // no watcher writes neither slot.
        // slot 24
        address payout; // direction B, only when it differs from the taker; zero = the taker
        uint64 tFreeze;
        uint32 freezeSecs; // W_z copied from the quote
        // slot 25
        address watcher; // the key that may freeze; zero = none
    }

    /// @notice The beta caps of one escrowed asset and its open value (SPEC 11.1): the sum of
    /// `amount` (direction A) or `amount + deposit` (direction B) over the swaps in an open state.
    struct Cap {
        uint128 maxSwap;
        uint128 maxOpen;
        uint128 openValue;
    }

    /// @custom:storage-location erc7201:xmrswap.storage.v1
    struct Layout {
        mapping(address => IXmrSwap.Maker) makers; // key: the maker's registering (owner) address
        mapping(bytes32 => Record) swaps;
        mapping(address => mapping(address => bool)) keyUsed; // maker => keyAddr of a consumed share
        mapping(address => bytes32[]) swapsByTaker;
        mapping(address => mapping(uint64 => bool)) quoteCancelled;
        mapping(bytes32 => bool) approvalRevoked; // keccak256(abi.encode(maker, approvalId))
        mapping(address => mapping(address => uint256)) owed; // token => account => parked payout
        mapping(address => uint256) treasuryAccrued; // token => fees and split halves
        mapping(address => mapping(address => uint128)) volume; // maker => token; saturates
        mapping(address => mapping(address => uint128)) withheldVolume;
        address treasury;
        address usdc;
        mapping(address => address) makerOfOperator; // operator => maker; operators are unique
        // Amendment 1 (SPEC 11.1), appended: slots 13 and 14.
        mapping(address => Cap) caps; // token => caps and open value
        bool capsOn; // on after `initialize`, with every cap zero: fail closed
    }

    // keccak256(abi.encode(uint256(keccak256("xmrswap.storage.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_LOCATION = 0x72d7395cd54647fc1d07503abee35a2743d3fbf166f40f42b88abee6111c6600;

    function layout() internal pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    // ------------------------------------------------------------------ helpers

    /// Narrow an amount or a price for storage. Values above 2^128 - 1 are refused, never
    /// truncated.
    function _u128(uint256 v) internal pure returns (uint128) {
        if (v > type(uint128).max) revert IXmrSwap.AmountOutOfRange();
        return uint128(v);
    }

    /// The stored swap as the frozen interface struct.
    function _load(Record storage r) internal view returns (IXmrSwap.Swap memory s) {
        s.taker = r.taker;
        s.maker = r.maker;
        s.token = r.token;
        s.sessionKey = r.sessionKey;
        s.swapNonce = r.swapNonce;
        s.state = r.state;
        s.direction = r.direction;
        s.mode = r.mode;
        s.outcome = r.outcome;
        s.depositState = r.depositState;
        s.depth = r.depth;
        s.flags = r.flags;
        s.depBps = r.depBps;
        s.makerEncVersion = r.makerEncVersion;
        s.xmr = r.xmr;
        s.amount = r.amount;
        s.deposit = r.deposit;
        s.price = r.price;
        s.noticeWindow = r.noticeWindow;
        s.claimDelay = r.claimDelay;
        s.claimWindow = r.claimWindow;
        s.takerKey = r.takerKey;
        s.takerKey2 = r.takerKey2;
        s.takerSpendPub = r.takerSpendPub;
        s.makerKey = r.makerKey;
        s.makerKey2 = r.makerKey2;
        s.makerSpendPub = r.makerSpendPub;
        s.lockerView = r.lockerView;
        s.takerEncKey = r.takerEncKey;
        s.makerEncKey = r.makerEncKey;
        s.noticeCommitment = r.noticeCommitment;
        s.noticeCiphertext = r.noticeCiphertext;
        s.evidenceTxid = r.evidenceTxid;
        s.evidenceView = r.evidenceView;
        s.keyLeaf = r.keyLeaf;
        s.openHash = r.openHash;
        s.revealed = r.revealed;
        s.tLock = r.tLock;
        s.tPendingDeadline = r.tPendingDeadline;
        s.tActive = r.tActive;
        s.tNoteDeadline = r.tNoteDeadline;
        s.tNotice = r.tNotice;
        s.tCut = r.tCut;
        s.tClaimOpen = r.tClaimOpen;
        s.tReady = r.tReady;
        s.tClaimDeadline = r.tClaimDeadline;
        s.tFinal = r.tFinal;
        s.tRefund = r.tRefund;
        s.tSettled = r.tSettled;
        // Direction B: the taker is the payout unless another address was named at `take`.
        address payout = r.payout;
        s.payout = payout != address(0) ? payout : (s.direction == 0 ? address(0) : s.taker);
        s.watcher = r.watcher;
        s.freezeSecs = r.freezeSecs;
        s.tFreeze = r.tFreeze;
    }

    /// Where a direction-B claim pays: the payout address named at `take`, by default the taker.
    function _claimTo(Record storage r) internal view returns (address) {
        address payout = r.payout;
        return payout != address(0) ? payout : r.taker;
    }

    /// `T_ff = max(t_Z + W_z, T_co)`: when a frozen swap's claim-without-ready opens and the
    /// locker's refund and `setReady` close. A freeze never opens the claim earlier than `T_co`
    /// (SPEC 11.6 as corrected by docs/research/a1-deviations.md, D1).
    function _tFrozenFinal(Record storage r) internal view returns (uint256 t) {
        t = uint256(r.tFreeze) + r.freezeSecs;
        uint256 tClaimOpen = r.tClaimOpen;
        if (t < tClaimOpen) t = tClaimOpen;
    }

    /// The states in which a notice is on record and the swap is still open: NOTICED, READY, the
    /// two ABORTED states and FROZEN.
    function _afterNotice(uint8 state) internal pure returns (bool) {
        return (state >= NOTICED && state <= ABORTED_HOLD) || state == FROZEN;
    }

    /// The one subtraction from the open value, at the transition that takes the swap out of the
    /// open states (into HOLD or DONE). It saturates and cannot fail: no cap can stop an exit.
    function _uncount(Layout storage $, Record storage s) internal {
        uint8 flags = s.flags;
        if (flags & FLAG_COUNTED == 0) return;
        s.flags = flags & ~FLAG_COUNTED;
        Cap storage cap = $.caps[s.token];
        uint256 counted = s.direction == 0 ? s.amount : uint256(s.amount) + s.deposit;
        uint256 open = cap.openValue;
        cap.openValue = open > counted ? uint128(open - counted) : 0;
    }

    function _swap(Layout storage $, bytes32 swapId) internal view returns (Record storage s) {
        s = $.swaps[swapId];
        if (s.state == 0) revert IXmrSwap.BadState();
    }

    function _operatorOnly(Layout storage $, Record storage s) internal view returns (IXmrSwap.Maker storage m) {
        m = $.makers[s.maker];
        if (msg.sender != m.operator) revert IXmrSwap.Unauthorized();
    }

    /// The taker's wallet or the swap's session key.
    function _isTaker(Record storage s) internal view returns (bool) {
        return msg.sender == s.taker || msg.sender == s.sessionKey;
    }

    /// The claimer locks XMR and can claim: the operator in A, the taker in B.
    function _isClaimer(Layout storage $, Record storage s) internal view returns (bool) {
        return s.direction == 0 ? msg.sender == $.makers[s.maker].operator : _isTaker(s);
    }

    /// The locker escrows the asset and can refund it: the taker in A, the operator in B.
    function _isLocker(Layout storage $, Record storage s) internal view returns (bool) {
        return s.direction == 0 ? _isTaker(s) : msg.sender == $.makers[s.maker].operator;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// Counters saturate: a counter can never make a secret-bearing call fail.
    function _count(Layout storage $, address maker, uint8 counter) internal {
        uint32[40] storage c = $.makers[maker].counters;
        uint32 value = c[counter];
        if (value != type(uint32).max) {
            unchecked {
                c[counter] = value + 1;
            }
        }
    }

    function _settle(Layout storage $, Record storage s, uint8 counter) internal {
        s.state = DONE;
        s.outcome = counter;
        s.tSettled = uint64(block.timestamp);
        _uncount($, s);
        _count($, s.maker, counter);
    }

    /// `msg.value` of the proxy call (the libraries are entered by DELEGATECALL, which keeps it).
    function _value() internal view returns (uint256 v) {
        assembly ("memory-safe") {
            v := callvalue()
        }
    }

    /// Funds in. ETH: `msg.value == amount + extra`. USDC: `msg.value == extra`, and the balance
    /// must grow by exactly `amount`.
    function _pull(address token, uint256 amount, uint256 extra) internal {
        if (token == address(0)) {
            if (_value() != amount + extra) revert IXmrSwap.BadValue();
        } else {
            if (_value() != extra) revert IXmrSwap.BadValue();
            if (amount != 0) {
                IERC20 t = IERC20(token);
                uint256 before = t.balanceOf(address(this));
                t.safeTransferFrom(msg.sender, address(this), amount);
                if (t.balanceOf(address(this)) - before != amount) revert IXmrSwap.ShortTransfer();
            }
        }
    }

    /// Pay or park (SPEC 5.4). A payout must never revert: the call that triggers it may have
    /// published a secret in its calldata. A failed push (a blacklisted or paused token, a
    /// recipient that rejects ETH) is parked and pulled later with `withdrawOwed`.
    function _payout(Layout storage $, address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (token == address(0)) {
            (ok,) = to.call{value: amount, gas: ETH_STIPEND}("");
        } else {
            ok = IERC20(token).trySafeTransfer(to, amount);
        }
        if (!ok) {
            $.owed[token][to] += amount;
            emit IXmrSwap.PayoutDeferred(token, to, amount);
        }
    }

    /// A pull may revert; it carries no secret.
    function _send(address token, address to, uint256 amount) internal {
        if (to == address(0)) revert IXmrSwap.BadValue();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert IXmrSwap.BadValue();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
