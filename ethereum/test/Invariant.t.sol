// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {MockUSDC, Receiver} from "./utils/Mocks.sol";

/// Drives random swaps through random calls at random times, with recipients that randomly stop
/// being able to receive. It owns a whole world (proxy, token, maker, takers).
contract Handler is Base {
    uint256 internal constant MAX_SWAPS = 24;

    bytes32[] public ids;
    mapping(bytes32 => uint256) public takerSecretOf;
    mapping(bytes32 => uint256) public makerSecretOf;
    address[3] public takers;
    address[6] public accounts; // everyone a payout can be owed to
    uint256 internal shareCounter;

    /// Set when a call that carried a valid secret failed for any reason other than state or
    /// time: a payout problem must never make such a call fail.
    bool public secretCallBlocked;
    bytes4 public blockedWith;
    uint256 public claims;
    uint256 public refunds;
    uint256 public parkedPayouts;

    constructor() {
        setUp();
        takers = [makeAddr("taker 1"), makeAddr("taker 2"), makeAddr("taker 3")];
        accounts = [takers[0], takers[1], takers[2], payout, operator, makerOwner];
        for (uint256 i; i < 3; ++i) {
            vm.deal(takers[i], 1e30);
            usdc.mint(takers[i], 1e30);
            vm.prank(takers[i]);
            usdc.approve(address(swap), type(uint256).max);
        }
    }

    function swapAddress() external view returns (XmrSwap) {
        return swap;
    }

    function token() external view returns (MockUSDC) {
        return usdc;
    }

    function makerOwnerAddress() external view returns (address) {
        return makerOwner;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function _pick(uint256 seed) internal view returns (bytes32) {
        return ids[seed % ids.length];
    }

    modifier some() {
        if (ids.length == 0) return;
        _;
    }

    // ------------------------------------------------------------------ actions

    function open(uint256 seed, uint64 xmr, uint256 price, uint16 depBps) external {
        if (ids.length >= MAX_SWAPS) return;
        uint8 direction = uint8(seed & 1);
        address tok = seed & 2 == 0 ? ETH : address(usdc);
        xmr = uint64(bound(xmr, 1, 1e15));
        price = bound(price, 1e12, 1e20);
        takerSecret = _share(string.concat("taker share ", vm.toString(shareCounter++)));
        Open memory o = _open(direction, tok, xmr, price);
        o.q.depositBps = uint16(bound(depBps, 0, 500));
        o.sig = _signQuote(o.q);
        o.sender = takers[(seed >> 2) % 3];
        o.leafIndex = uint32((seed >> 8) % POOL);
        bytes32 id = _send(o);
        ids.push(id);
        takerSecretOf[id] = takerSecret;
        if (direction == 0) makerSecretOf[id] = makerSecrets[o.leafIndex];
    }

    function activate(uint256 seed) external some {
        bytes32 id = _pick(seed);
        if (_get(id).direction == 0) {
            _approve(id);
        } else {
            _fund(id);
            makerSecretOf[id] = _fundSecret();
        }
    }

    function reject(uint256 seed, uint8 reason) external some {
        bytes32 id = _pick(seed);
        bytes32 h = _get(id).openHash;
        vm.prank(operator);
        swap.reject(id, h, reason % 3);
    }

    function cancelPending(uint256 seed) external some {
        bytes32 id = _pick(seed);
        vm.prank(seed & 1 == 0 ? session : _get(id).taker);
        swap.cancelPending(id);
    }

    function expirePending(uint256 seed) external some {
        swap.expirePending(_pick(seed));
    }

    function notice(uint256 seed) external some {
        bytes32 id = _pick(seed);
        if (_get(id).direction == 0) _notice(id);
        else _noticeAs(id, seed & 1 == 0 ? session : _get(id).taker);
    }

    function _noticeAs(bytes32 id, address from) internal {
        bytes32 commitment = _commitment(id);
        vm.prank(from);
        swap.postNotice(id, commitment, _ciphertext());
    }

    function ready(uint256 seed) external some {
        _ready(_pick(seed));
    }

    function abort(uint256 seed) external some {
        _abort(_pick(seed));
    }

    function refundUnnoticed(uint256 seed) external some {
        swap.refundUnnoticed(_pick(seed));
    }

    function expireUnnoticed(uint256 seed) external some {
        swap.expireUnnoticed(_pick(seed));
    }

    function refund(uint256 seed) external some {
        bytes32 id = _pick(seed);
        uint256 secret = _get(id).direction == 0 ? takerSecretOf[id] : makerSecretOf[id];
        if (_secretCall(abi.encodeCall(IXmrSwap.refund, (id, secret)), secret)) refunds++;
    }

    function claim(uint256 seed) external some {
        bytes32 id = _pick(seed);
        uint256 secret = _get(id).direction == 0 ? makerSecretOf[id] : takerSecretOf[id];
        if (_secretCall(abi.encodeCall(IXmrSwap.claim, (id, secret)), secret)) claims++;
    }

    /// A secret-bearing call with the right secret may fail only because of the state or the time.
    function _secretCall(bytes memory data, uint256 secret) internal returns (bool ok) {
        uint256 parkedBefore = _totalOwed();
        vm.prank(anyone);
        bytes memory ret;
        (ok, ret) = address(swap).call(data);
        if (ok) {
            if (_totalOwed() > parkedBefore) parkedPayouts++;
            return true;
        }
        bytes4 err = bytes4(ret);
        bool expected = err == IXmrSwap.BadState.selector || err == IXmrSwap.TooEarly.selector
            || err == IXmrSwap.TooLate.selector || (secret == 0 && err == IXmrSwap.BadSecret.selector);
        if (!expected) {
            secretCallBlocked = true;
            blockedWith = err;
        }
    }

    function _totalOwed() internal view returns (uint256 total) {
        for (uint256 i; i < accounts.length; ++i) {
            total += swap.owedOf(ETH, accounts[i]) + swap.owedOf(address(usdc), accounts[i]);
        }
    }

    function releaseDeposit(uint256 seed) external some {
        if (seed & 1 == 0) vm.prank(operator);
        swap.releaseDeposit(_pick(seed));
    }

    function withhold(uint256 seed) external some {
        bytes32 id = _pick(seed);
        IXmrSwap.Swap memory s = _get(id);
        bool evidence = s.direction == 0 && s.flags & 1 != 0;
        vm.prank(operator);
        swap.withhold(id, evidence ? TXID : bytes32(0), evidence ? _claimerView() : bytes32(0));
    }

    function splitDeposit(uint256 seed) external some {
        swap.splitDeposit(_pick(seed));
    }

    function withdrawOwed(uint256 seed) external {
        withdrawFor(seed % accounts.length, (seed >> 8) & 1 == 1);
    }

    function withdrawFor(uint256 account, bool usdc_) public {
        address who = accounts[account];
        vm.prank(who);
        swap.withdrawOwed(usdc_ ? address(usdc) : ETH, who);
    }

    function withdrawTreasury(uint256 seed) external {
        vm.prank(treasury);
        swap.withdrawTreasury(seed & 1 == 0 ? ETH : address(usdc), treasury);
    }

    /// A step that fits the swap's state (with the wait it needs), so that runs reach the late
    /// states, the secret-bearing calls and the deposit sub-machine often. The purely random
    /// calls above cover everything else, including calls at the wrong time.
    function advance(uint256 seed) external some {
        bytes32 id = _pick(seed);
        IXmrSwap.Swap memory s = _get(id);
        uint256 choice = (seed >> 16) % 4;
        uint256 t = vm.getBlockTimestamp();
        if (s.state == PENDING) {
            if (t >= s.tPendingDeadline) swap.expirePending(id);
            else this.activate(seed);
        } else if (s.state == ACTIVE) {
            if (choice == 0) this.refund(seed);
            else this.notice(seed);
        } else if (s.state == NOTICED) {
            if (choice == 0) {
                this.refund(seed);
            } else if (choice == 1) {
                if (t < s.tClaimOpen) vm.warp(s.tClaimOpen);
                this.claim(seed);
            } else if (choice == 2) {
                _abort(id);
            } else {
                uint256 readyAt = s.tNotice + uint256(s.depth) * 60;
                if (t < readyAt) vm.warp(readyAt);
                _ready(id);
            }
        } else if (s.state == READY) {
            if (choice == 0) {
                if (t < s.tClaimDeadline) vm.warp(s.tClaimDeadline);
                this.refund(seed);
            } else {
                this.claim(seed);
            }
        } else if (s.state == ABORTED_FREE || s.state == ABORTED_HOLD) {
            if (choice == 0) {
                if (t < s.tFinal) vm.warp(s.tFinal);
                this.claim(seed);
            } else {
                this.refund(seed);
            }
        } else if (s.state == HOLD) {
            if (choice == 0) {
                if (t < s.tRefund + 1800) vm.warp(s.tRefund + 1800);
                swap.releaseDeposit(id);
            } else {
                this.withhold(seed);
            }
        } else if (s.state == WITHHELD) {
            if (choice == 0) {
                vm.prank(operator);
                swap.releaseDeposit(id);
            } else {
                if (t < s.tRefund + 5_184_000) vm.warp(s.tRefund + 5_184_000);
                swap.splitDeposit(id);
            }
        }
    }

    /// Time steps on the scale of each window of the protocol; short ones are more frequent.
    function warp(uint256 seed) external {
        uint32[16] memory steps =
            [uint32(1), 1, 7, 13, 13, 60, 119, 600, 1799, 1800, 3900, 5400, 10800, 86_400, 604_800, 2_592_000];
        skip(steps[seed % steps.length]);
    }

    /// Recipients stop and resume being able to receive: a USDC blacklist entry, a USDC pause, or
    /// an account that rejects ETH.
    function toggleReceive(uint256 seed) external {
        address who = accounts[seed % accounts.length];
        uint256 kind = (seed >> 8) % 3;
        if (kind == 0) {
            usdc.setBlacklisted(who, !usdc.blacklisted(who));
        } else if (kind == 1) {
            usdc.setPaused(!usdc.paused());
        } else if (who.code.length == 0) {
            vm.etch(who, address(new Receiver()).code);
            Receiver(payable(who)).set(Receiver.Mode.Reject, address(0), "");
        } else {
            vm.etch(who, "");
        }
    }

    /// Everybody can receive again (used at the end of a run).
    function unblockAll() external {
        usdc.setPaused(false);
        for (uint256 i; i < accounts.length; ++i) {
            usdc.setBlacklisted(accounts[i], false);
            if (accounts[i].code.length != 0) vm.etch(accounts[i], "");
        }
    }
}

/// Invariant: the escrowed balance of each asset always covers, exactly, what the contract owes:
/// the stake of every open swap, every parked payout and the treasury's accrual.
contract InvariantTest is Test {
    Handler internal handler;
    XmrSwap internal swap;
    MockUSDC internal usdc;

    function setUp() public {
        handler = new Handler();
        swap = handler.swapAddress();
        usdc = handler.token();
        targetContract(address(handler));
        // `open` and `advance` are listed several times: they are what moves a run forward.
        bytes4[] memory selectors = new bytes4[](38);
        selectors[0] = Handler.open.selector;
        selectors[1] = Handler.activate.selector;
        selectors[2] = Handler.reject.selector;
        selectors[3] = Handler.cancelPending.selector;
        selectors[4] = Handler.expirePending.selector;
        selectors[5] = Handler.notice.selector;
        selectors[6] = Handler.ready.selector;
        selectors[7] = Handler.abort.selector;
        selectors[8] = Handler.refundUnnoticed.selector;
        selectors[9] = Handler.expireUnnoticed.selector;
        selectors[10] = Handler.refund.selector;
        selectors[11] = Handler.claim.selector;
        selectors[12] = Handler.releaseDeposit.selector;
        selectors[13] = Handler.withhold.selector;
        selectors[14] = Handler.splitDeposit.selector;
        selectors[15] = Handler.withdrawOwed.selector;
        selectors[16] = Handler.withdrawTreasury.selector;
        selectors[17] = Handler.warp.selector;
        selectors[18] = Handler.toggleReceive.selector;
        selectors[19] = Handler.open.selector;
        selectors[20] = Handler.open.selector;
        selectors[21] = Handler.open.selector;
        selectors[22] = Handler.open.selector;
        selectors[23] = Handler.open.selector;
        selectors[24] = Handler.advance.selector;
        selectors[25] = Handler.advance.selector;
        selectors[26] = Handler.advance.selector;
        selectors[27] = Handler.advance.selector;
        selectors[28] = Handler.advance.selector;
        selectors[29] = Handler.advance.selector;
        selectors[30] = Handler.advance.selector;
        selectors[31] = Handler.advance.selector;
        selectors[32] = Handler.advance.selector;
        selectors[33] = Handler.advance.selector;
        selectors[34] = Handler.advance.selector;
        selectors[35] = Handler.advance.selector;
        selectors[36] = Handler.advance.selector;
        selectors[37] = Handler.advance.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// What the contract still owes on a swap, by state.
    function _obligation(IXmrSwap.Swap memory s) internal pure returns (uint256) {
        if (s.state == 1) return s.direction == 0 ? s.amount : s.deposit; // PENDING
        if (s.state >= 2 && s.state <= 6) return s.direction == 0 ? s.amount : s.amount + s.deposit;
        if (s.state == 7 || s.state == 8) return s.deposit; // HOLD, WITHHELD
        return 0; // DONE
    }

    function _obligations(address tok) internal view returns (uint256 total, uint256 pending) {
        uint256 n = handler.count();
        for (uint256 i; i < n; ++i) {
            IXmrSwap.Swap memory s = swap.getSwap(handler.ids(i));
            assertTrue(s.state >= 1 && s.state <= 9);
            if (s.state == 1) pending++;
            if (s.token == tok) total += _obligation(s);
        }
        for (uint256 i; i < 6; ++i) {
            total += swap.owedOf(tok, handler.accounts(i));
        }
        total += swap.treasuryAccrued(tok);
    }

    function invariant_escrowCoversObligations_eth() public view {
        (uint256 owes,) = _obligations(address(0));
        assertEq(address(swap).balance, owes, "ETH held == ETH owed");
    }

    function invariant_escrowCoversObligations_usdc() public view {
        (uint256 owes,) = _obligations(address(usdc));
        assertEq(usdc.balanceOf(address(swap)), owes, "USDC held == USDC owed");
    }

    function invariant_openPendingCountsPendingSwaps() public view {
        (, uint256 pending) = _obligations(address(0));
        assertEq(swap.getMaker(handler.makerOwnerAddress()).openPending, pending);
    }

    /// A call that carries a valid secret never fails because of a payout.
    function invariant_secretCallsAreNeverBlocked() public view {
        assertFalse(handler.secretCallBlocked(), "a secret-bearing call failed for a reason other than state or time");
    }

    /// A settled swap holds a revealed secret exactly when a keyed call settled it, and a deposit
    /// state that matches its outcome.
    function invariant_recordsAreConsistent() public view {
        uint256 n = handler.count();
        for (uint256 i; i < n; ++i) {
            IXmrSwap.Swap memory s = swap.getSwap(handler.ids(i));
            assertEq(s.revealed != 0, s.flags & 4 != 0);
            assertEq(s.state == 9, s.outcome != 0xff);
            assertEq(s.state == 9, s.tSettled != 0);
            if (s.state == 7) assertEq(s.depositState, 1);
            if (s.state == 8) assertEq(s.depositState, 2);
            if (s.depositState != 0) assertGt(s.deposit, 0);
            assertLe(s.deposit, s.amount * 500 / 10_000);
        }
    }

    /// At the end of every run: once everybody can receive again, every parked payout and the
    /// treasury's accrual can be pulled, and what remains is exactly the stake of the open swaps.
    function afterInvariant() public {
        handler.unblockAll();
        for (uint256 i; i < 6; ++i) {
            try handler.withdrawFor(i, false) {} catch {}
            try handler.withdrawFor(i, true) {} catch {}
        }
        try handler.withdrawTreasury(0) {} catch {}
        try handler.withdrawTreasury(1) {} catch {}
        (uint256 owesEth,) = _obligations(address(0));
        (uint256 owesUsdc,) = _obligations(address(usdc));
        assertEq(address(swap).balance, owesEth);
        assertEq(usdc.balanceOf(address(swap)), owesUsdc);
        assertEq(swap.treasuryAccrued(address(0)) + swap.treasuryAccrued(address(usdc)), 0);
        for (uint256 i; i < 6; ++i) {
            assertEq(swap.owedOf(address(0), handler.accounts(i)), 0);
            assertEq(swap.owedOf(address(usdc), handler.accounts(i)), 0);
        }
    }
}

/// Stateless fuzz of the same property: one swap, any path to its end, and the escrow is empty
/// again apart from the treasury's accrual.
contract ConservationFuzzTest is Base {
    function testFuzz_everySwapPaysOutInFull(
        bool usdc_,
        bool directionB,
        uint8 stateSeed,
        uint8 endSeed,
        uint64 xmr,
        uint16 depBps
    ) public {
        address token = usdc_ ? address(usdc) : ETH;
        uint8 direction = directionB ? 1 : 0;
        address[4] memory who = [taker, payout, operator, makerOwner];
        uint256 total = address(swap).balance + usdc.balanceOf(address(swap));
        for (uint256 i; i < 4; ++i) {
            total += _bal(token, who[i]);
        }

        // At least 10^-5 XMR, so that the amount is not zero at the USDC price.
        Open memory o = _open(direction, token, uint64(bound(xmr, 1e7, 1e15)), _defaultPrice(token));
        o.q.depositBps = uint16(bound(depBps, 0, 500));
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        uint8 target = uint8(bound(stateSeed, PENDING, ABORTED_HOLD));
        if (target == ABORTED_FREE && directionB) target = ABORTED_HOLD;
        _drive(id, target);
        _finish(id, endSeed);

        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.state, DONE, "every path ends");
        uint256 nowTotal = swap.treasuryAccrued(token);
        for (uint256 i; i < 4; ++i) {
            nowTotal += _bal(token, who[i]);
        }
        assertEq(nowTotal, total, "nothing created, nothing lost");
        assertEq(_bal(token, address(swap)), swap.treasuryAccrued(token), "the escrow holds only the accrual");
    }

    function _drive(bytes32 id, uint8 target) internal {
        if (target == PENDING) return;
        skip(12);
        _activate(id);
        if (target == ACTIVE) return;
        skip(90);
        _notice(id);
        if (target == NOTICED) return;
        if (target == ABORTED_FREE) return _abort(id);
        if (target == ABORTED_HOLD) {
            if (_get(id).direction == 0) skip(10800);
            return _abort(id);
        }
        skip(1200);
        _ready(id);
    }

    /// Finish the swap by one of the exits its state has.
    function _finish(bytes32 id, uint8 seed) internal {
        IXmrSwap.Swap memory s = _get(id);
        if (s.state == PENDING) {
            if (seed % 3 == 0) {
                vm.prank(taker);
                swap.cancelPending(id);
            } else if (seed % 3 == 1) {
                vm.prank(operator);
                swap.reject(id, s.openHash, seed % 2);
            } else {
                skip(120);
                swap.expirePending(id);
            }
            return;
        }
        bool wantClaim = seed & 1 == 1 && s.state != ACTIVE;
        if (wantClaim) {
            if (s.state == NOTICED) vm.warp(s.tClaimOpen);
            if (s.state == ABORTED_FREE || s.state == ABORTED_HOLD) vm.warp(s.tFinal);
            _claim(id);
            return;
        }
        if (s.state == READY) vm.warp(s.tClaimDeadline);
        if (s.state == ACTIVE && seed & 2 != 0) vm.warp(s.tNoteDeadline);
        if (s.state == NOTICED && seed & 4 != 0 && s.direction == 1) vm.warp(s.tCut);
        _refund(id);
        s = _get(id);
        if (s.state != HOLD) return;
        if (seed & 8 == 0) {
            skip(1800);
            swap.releaseDeposit(id);
            return;
        }
        bool evidence = s.direction == 0 && s.flags & 1 != 0;
        vm.prank(operator);
        swap.withhold(id, evidence ? TXID : bytes32(0), evidence ? _claimerView() : bytes32(0));
        if (seed & 16 == 0) {
            vm.prank(operator);
            swap.releaseDeposit(id);
        } else {
            skip(5_184_000);
            swap.splitDeposit(id);
        }
    }
}
