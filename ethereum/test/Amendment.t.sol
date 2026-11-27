// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {Receiver, XmrSwapSeeder} from "./utils/Mocks.sol";

/// Amendment 1 (SPEC section 11): the beta caps and the open-value accounting (11.1), the payout
/// address of a direction-B swap (11.2) and the keyless freeze by a watcher (11.6).
contract AmendmentTest is Base {
    uint256 internal constant MAX128 = type(uint128).max;
    uint256 internal constant EXPIRY_SECS = 2_592_000;
    address internal payoutTo = makeAddr("fresh payout address");

    function _token(bool usdc_) internal view returns (address) {
        return usdc_ ? address(usdc) : ETH;
    }

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }

    function _expectOpen(Open memory o, bytes4 err) internal {
        vm.expectRevert(err);
        this.sendOpen(o);
    }

    function _setCaps(address token, uint256 maxSwap, uint256 maxOpen) internal {
        vm.prank(owner);
        swap.setCaps(token, uint128(maxSwap), uint128(maxOpen));
    }

    function _counter(uint256 i) internal view returns (uint256) {
        return swap.counters(makerOwner)[i];
    }

    /// A default opening of 2 XMR: 0.122 ETH or 330.5 USDC.
    function _std(uint8 direction, address token) internal returns (Open memory o) {
        o = _open(direction, token, uint64(2 * ONE_XMR), _defaultPrice(token));
        if (direction == 0) o.leafIndex = nextLeaf++ % uint32(POOL);
    }

    // ================================================================== 11.1 caps

    /// A fresh deployment is fail-closed: the switch is on and every cap is zero.
    function test_caps_freshDeployment_isFailClosed(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        XmrSwap fresh = XmrSwap(
            address(
                new ERC1967Proxy(address(impl), abi.encodeCall(XmrSwap.initialize, (owner, treasury, address(usdc))))
            )
        );
        (bool on, uint128 maxSwap, uint128 maxOpen, uint128 openValue) = fresh.capsOf(token);
        assertTrue(on);
        assertEq(uint256(maxSwap) + maxOpen + openValue, 0);

        swap = fresh;
        vm.prank(makerOwner);
        swap.registerMaker(operator, payout, bytes32(0));
        _fundActors();
        _expectOpen(_std(directionB ? 1 : 0, token), IXmrSwap.SwapCapExceeded.selector);
        // One unit of cap is not enough either; the owner must set real caps.
        _setCaps(token, 1, 1);
        _expectOpen(_std(directionB ? 1 : 0, token), IXmrSwap.SwapCapExceeded.selector);
        _setCaps(token, MAX128, MAX128);
        _send(_std(directionB ? 1 : 0, token));
        // The other asset is still closed.
        _expectOpen(_std(directionB ? 1 : 0, usdc_ ? ETH : address(usdc)), IXmrSwap.SwapCapExceeded.selector);
    }

    function test_caps_onlyTheOwnerSetsThem() public {
        address[5] memory others = [anyone, treasury, makerOwner, operator, taker];
        for (uint256 i; i < 5; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, others[i]));
            swap.setCaps(ETH, 1, 1);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, others[i]));
            swap.setCapsOn(false);
            vm.stopPrank();
        }
        vm.startPrank(owner);
        vm.expectEmit(address(swap));
        emit IXmrSwap.CapsChanged(address(usdc), 5, 9);
        swap.setCaps(address(usdc), 5, 9);
        vm.expectEmit(address(swap));
        emit IXmrSwap.CapsSwitched(false);
        swap.setCapsOn(false);
        vm.stopPrank();
        (bool on, uint128 maxSwap, uint128 maxOpen, uint128 openValue) = swap.capsOf(address(usdc));
        assertFalse(on);
        assertEq(maxSwap, 5);
        assertEq(maxOpen, 9);
        assertEq(openValue, 0);
        (, maxSwap,,) = swap.capsOf(ETH);
        assertEq(maxSwap, MAX128, "caps are per asset");

        // Renouncing ownership freezes the caps as they are, for good.
        vm.prank(owner);
        swap.renounceOwnership();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        swap.setCaps(ETH, 0, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        swap.setCapsOn(true);
    }

    /// `amount` exactly `maxSwap` is accepted, one unit above is `SwapCapExceeded`.
    function test_caps_maxSwap_boundary(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        Open memory o = _std(direction, token);
        (uint256 amount,) = _stake(o);
        _setCaps(token, amount - 1, MAX128);
        _expectOpen(o, IXmrSwap.SwapCapExceeded.selector);
        assertEq(_openValue(token), 0);
        _setCaps(token, amount, MAX128);
        bytes32 id = _send(o);
        assertEq(_openValue(token), _counted(id));
        // The cap is on `amount`, not on the counted value: in B the deposit is beside it.
        if (directionB) assertGt(_counted(id), amount);
    }

    /// `openValue + counted` exactly `maxOpen` is accepted, one unit above is `OpenCapExceeded`.
    /// The counted value is `amount` in A and `amount + deposit` in B.
    function test_caps_maxOpen_boundary(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 first = _send(_std(direction, token));
        uint256 counted = _counted(first);
        IXmrSwap.Swap memory s = _get(first);
        assertEq(counted, directionB ? s.amount + s.deposit : s.amount);
        assertEq(_openValue(token), counted);

        _setCaps(token, MAX128, 2 * counted - 1);
        _expectOpen(_std(direction, token), IXmrSwap.OpenCapExceeded.selector);
        assertEq(_openValue(token), counted, "a refused open counts nothing");
        _setCaps(token, MAX128, 2 * counted);
        _send(_std(direction, token));
        assertEq(_openValue(token), 2 * counted);
        // Full: not one more unit.
        Open memory dust = _open(direction, token, uint64(ONE_XMR), 1e12);
        dust.leafIndex = 6;
        dust.q.depositBps = 0;
        dust.sig = _signQuote(dust.q);
        _expectOpen(dust, IXmrSwap.OpenCapExceeded.selector);
        // Both directions and every taker draw on the same open value of the asset.
        Open memory other = _std(1 - direction, token);
        _expectOpen(other, IXmrSwap.OpenCapExceeded.selector);
    }

    /// Lowering `maxOpen` below the current open value leaves open swaps alone and refuses new
    /// ones until exits bring the value back under.
    function test_caps_loweredBelowTheOpenValue(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 a = _swapIn(direction, token, READY);
        bytes32 b = _swapIn(direction, token, NOTICED);
        uint256 counted = _counted(a);
        assertEq(_openValue(token), 2 * counted);

        _setCaps(token, MAX128, counted);
        bytes32 before = keccak256(abi.encode(_get(a), _get(b)));
        _expectOpen(_std(direction, token), IXmrSwap.OpenCapExceeded.selector);
        assertEq(keccak256(abi.encode(_get(a), _get(b))), before, "open swaps are untouched");

        // The first swap completes; the value is exactly at the cap, so still nothing new fits.
        _claim(a);
        assertEq(_openValue(token), counted);
        _expectOpen(_std(direction, token), IXmrSwap.OpenCapExceeded.selector);
        // The second is refunded; now one swap fits again, exactly at the cap.
        _refund(b);
        assertEq(_openValue(token), 0);
        bytes32 c = _send(_std(direction, token));
        assertEq(_openValue(token), _counted(c));
        _expectOpen(_std(direction, token), IXmrSwap.OpenCapExceeded.selector);
    }

    /// `take` reserves the whole amount, so `fund` is never refused by a cap, a pause or the switch.
    function test_caps_fundIsNeverCapRefused(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _send(_std(1, token));
        uint256 counted = _counted(id);
        assertEq(_openValue(token), counted, "the amount is counted at take, before it is escrowed");
        assertEq(_bal(token, address(swap)), _get(id).deposit);
        _setCaps(token, 0, 0);
        vm.prank(operator);
        swap.setPaused(true);
        _fund(id);
        assertEq(_get(id).state, ACTIVE);
        assertEq(_openValue(token), counted, "fund adds nothing");
        _expectOpen(_std(1, token), IXmrSwap.Paused.selector);
    }

    /// With the switch off nothing is checked and the accounting continues.
    function test_caps_switchedOff(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        _setCaps(token, 0, 0);
        vm.prank(owner);
        swap.setCapsOn(false);
        bytes32 a = _send(_std(direction, token));
        bytes32 b = _send(_std(direction, token));
        assertEq(_openValue(token), _counted(a) + _counted(b));
        vm.prank(taker);
        swap.cancelPending(a);
        assertEq(_openValue(token), _counted(b));
        // Switched back on with zero caps: nothing opens, the open swap is untouched.
        vm.prank(owner);
        swap.setCapsOn(true);
        _expectOpen(_std(direction, token), IXmrSwap.SwapCapExceeded.selector);
        _activate(b);
    }

    /// The open value of one asset is not the other's.
    function test_caps_perAsset() public {
        bytes32 e = _send(_std(0, ETH));
        bytes32 u = _send(_std(1, address(usdc)));
        assertEq(_openValue(ETH), _counted(e));
        assertEq(_openValue(address(usdc)), _counted(u));
        _setCaps(ETH, 0, 0);
        _send(_std(0, address(usdc)));
        _expectOpen(_std(1, ETH), IXmrSwap.SwapCapExceeded.selector);
    }

    function _seedOpenValue(address token, uint256 v) internal {
        XmrSwapSeeder seeder = new XmrSwapSeeder();
        vm.startPrank(owner);
        swap.upgradeToAndCall(address(seeder), "");
        XmrSwapSeeder(address(swap)).seedOpen(token, uint128(v), makerOwner, swap.getMaker(makerOwner).openPending);
        swap.upgradeToAndCall(address(impl), "");
        vm.stopPrank();
    }

    /// The add is exact: an open value that would not fit 128 bits is refused, with the switch on
    /// (`OpenCapExceeded`) and off (`AmountOutOfRange`); it never wraps or saturates.
    function test_caps_openValueAdd_isExact(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        Open memory o = _std(direction, token);
        (uint256 amount, uint256 stake) = _stake(o);
        uint256 counted = directionB ? amount + stake : amount;
        _seedOpenValue(token, MAX128 - counted + 1);
        _expectOpen(o, IXmrSwap.OpenCapExceeded.selector);
        vm.prank(owner);
        swap.setCapsOn(false);
        _expectOpen(o, IXmrSwap.AmountOutOfRange.selector);
        assertEq(_openValue(token), MAX128 - counted + 1);
        // One unit of room less missing: it fits exactly, to the last unit of the type.
        _seedOpenValue(token, MAX128 - counted);
        _send(o);
        assertEq(_openValue(token), MAX128);
    }

    /// The subtraction saturates at zero and can never fail an exit.
    function test_caps_openValueSubtract_neverUnderflows(bool usdc_, bool directionB, uint8 exit) public {
        address token = _token(usdc_);
        exit = uint8(bound(exit, 0, 2));
        bytes32 id = _swapIn(directionB ? 1 : 0, token, exit == 0 ? PENDING : READY);
        // Storage that no sequence of calls produces: less open value than this swap counted.
        _seedOpenValue(token, _counted(id) / 3);
        if (exit == 0) {
            vm.prank(taker);
            swap.cancelPending(id);
        } else if (exit == 1) {
            _claim(id);
        } else {
            vm.warp(_get(id).tClaimDeadline);
            _refund(id);
        }
        assertEq(_openValue(token), 0);
        assertEq(_get(id).flags & 32, 0, "counted once");
    }

    /// Counted exactly while open: the flag and the open value move together, once, at the
    /// transition into HOLD or DONE, and never at release, withhold, split or a withdrawal.
    function test_caps_subtractedOnce_atTheTransitionOutOfTheOpenStates(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 other = _swapIn(direction, token, ACTIVE); // stays open throughout
        uint256 base = _counted(other);
        takerSecret = _share("second taker share");

        bytes32 id = _send(_std(direction, token));
        uint256 counted = _counted(id);
        assertEq(_get(id).flags & 32, 32);
        assertEq(_openValue(token), base + counted);
        skip(12);
        _activate(id);
        skip(90);
        _notice(id);
        assertEq(_openValue(token), base + counted, "progress changes nothing");
        if (directionB) vm.warp(_get(id).tCut); // B9d holds the deposit
        _blockTaker(token, true);
        _refund(id);
        assertEq(_get(id).state, HOLD);
        assertEq(_get(id).flags & 32, 0);
        assertEq(_openValue(token), base, "subtracted on entering HOLD");
        vm.prank(operator);
        swap.withhold(id, directionB ? bytes32(0) : TXID, directionB ? bytes32(0) : _claimerView());
        assertEq(_openValue(token), base);
        skip(5_184_000);
        swap.splitDeposit(id);
        assertEq(_openValue(token), base, "not again at the split");
        _blockTaker(token, false);
        vm.prank(taker);
        swap.withdrawOwed(token, taker);
        assertEq(_openValue(token), base, "nor at a withdrawal");
        assertEq(_get(other).flags & 32, 32);
    }

    function _blockTaker(address token, bool on) internal {
        if (token == ETH) vm.etch(taker, on ? bytes(hex"fe") : bytes(""));
        else usdc.setBlacklisted(taker, on);
    }

    // ================================================================== 11.2 payout address

    function _takeWithPayout(address token, address to) internal returns (bytes32 id) {
        Open memory o = _std(1, token);
        o.payout = to;
        id = _send(o);
    }

    function _toReady(bytes32 id) internal {
        skip(12);
        _fund(id);
        skip(90);
        _notice(id);
        skip(1200);
        _ready(id);
    }

    function test_payout_zeroAndTheContractItself_areRefused(bool usdc_) public {
        address token = _token(usdc_);
        Open memory o = _std(1, token);
        (, uint256 stake) = _stake(o);
        IXmrSwap.TakerKeys memory tk = _takerKeys(1);
        vm.startPrank(taker);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.take{value: token == ETH ? stake : 0}(o.q, o.sig, o.xmr, 0, o.nonce, session, 0, tk, o.a, "", address(0));
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.take{value: token == ETH ? stake : 0}(
            o.q, o.sig, o.xmr, 0, o.nonce, session, 0, tk, o.a, "", address(swap)
        );
        swap.take{value: token == ETH ? stake : 0}(o.q, o.sig, o.xmr, 0, o.nonce, session, 0, tk, o.a, "", payoutTo);
        vm.stopPrank();
        assertEq(_get(_id(o)).payout, payoutTo);
    }

    /// The payout address is stored, emitted and covered by the open hash: the maker funds knowing it.
    function test_payout_isBound_inTheRecord_theEvent_andTheOpenHash() public {
        uint256 snap = vm.snapshotState();
        Open memory own = _std(1, ETH);
        bytes32 id = _send(own);
        bytes32 hashOwn = _get(id).openHash;
        assertEq(_get(id).payout, taker, "the default is the taker's own address");
        vm.revertToState(snap);

        Open memory o = _std(1, ETH);
        o.payout = payoutTo;
        vm.expectEmit(address(swap));
        emit IXmrSwap.Locked(
            id,
            makerOwner,
            taker,
            1,
            ETH,
            1,
            0,
            122e15,
            122e13,
            uint64(2 * ONE_XMR),
            10,
            o.nonce,
            o.tk,
            0,
            payoutTo,
            address(0)
        );
        assertEq(_send(o), id);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.payout, payoutTo);
        assertTrue(s.openHash != hashOwn, "another payout is another open hash");
        // A maker that verified the lock with the taker's own payout cannot fund this one.
        vm.expectRevert(IXmrSwap.BadState.selector);
        this.fundWith(id, hashOwn);
        _fund(id);
        // Direction A has no payout address.
        assertEq(_get(_send(_std(0, ETH))).payout, address(0));
    }

    function fundWith(bytes32 id, bytes32 expectedOpen) external {
        fundCounter++;
        _fundWith(id, _fundSecret(), expectedOpen, operator);
    }

    /// `claim` pays `amount - fee + Dp` to the bound payout address and to no other, whoever
    /// submits the transaction, on each claim row.
    function test_payout_claimPaysOnlyThePayoutAddress(bool usdc_, uint8 row, uint8 submitter) public {
        address token = _token(usdc_);
        row = uint8(bound(row, 0, 2));
        address[5] memory senders = [session, taker, anyone, operator, payoutTo];
        address from = senders[bound(submitter, 0, 4)];
        vm.deal(payoutTo, 0);
        bytes32 id = _takeWithPayout(token, payoutTo);
        skip(12);
        _fund(id);
        skip(90);
        _notice(id);
        if (row == 0) {
            skip(1200);
            _ready(id); // B10a
        } else if (row == 1) {
            vm.warp(_get(id).tClaimOpen); // B10b
        } else {
            vm.warp(_get(id).tFinal); // B10c
        }
        IXmrSwap.Swap memory s = _get(id);
        uint256 takerBefore = _bal(token, taker);
        uint256 senderBefore = _bal(token, from);
        uint256 fee = s.amount * 5 / 10_000;
        vm.prank(from);
        swap.claim(id, takerSecret);
        assertEq(_bal(token, payoutTo), s.amount - fee + s.deposit, "the payout address receives everything");
        assertEq(_bal(token, taker), takerBefore, "the taking wallet receives nothing");
        if (from != payoutTo) assertEq(_bal(token, from), senderBefore, "nor does whoever submitted");
        assertEq(swap.owedOf(token, taker) + swap.owedOf(token, payoutTo), 0);
        assertEq(_bal(token, address(swap)), fee);
    }

    /// Everything that is not a claim returns to the taker's own wallet, never to the payout address.
    function test_payout_everyOtherExitReturnsToTheTaker(bool usdc_, uint8 exit) public {
        address token = _token(usdc_);
        exit = uint8(bound(exit, 0, 8));
        uint256 before = _bal(token, taker);
        bytes32 id = _takeWithPayout(token, payoutTo);
        if (exit == 0) {
            vm.prank(session);
            swap.cancelPending(id);
        } else if (exit == 1) {
            bytes32 h = _get(id).openHash;
            vm.prank(operator);
            swap.reject(id, h, 0);
        } else if (exit == 2) {
            skip(120);
            swap.expirePending(id);
        } else {
            skip(12);
            _fund(id);
            if (exit == 3) {
                _refund(id); // B9a: the deposit at once
            } else if (exit == 4) {
                vm.warp(_get(id).tFinal + EXPIRY_SECS);
                swap.expireUnnoticed(id); // B11
            } else {
                // A held deposit, then released, withheld and released, or split.
                skip(90);
                _notice(id);
                vm.warp(_get(id).tCut);
                _refund(id);
                assertEq(_get(id).state, HOLD);
                if (exit == 5) {
                    skip(1800);
                    swap.releaseDeposit(id);
                } else {
                    vm.prank(operator);
                    swap.withhold(id, 0, 0);
                    if (exit == 6) {
                        vm.prank(operator);
                        swap.releaseDeposit(id);
                    } else if (exit == 7) {
                        skip(5_184_000);
                        swap.splitDeposit(id);
                    } else {
                        // Still withheld: nothing has gone anywhere but the escrow.
                        assertEq(_bal(token, address(swap)), _get(id).deposit);
                    }
                }
            }
        }
        IXmrSwap.Swap memory s = _get(id);
        assertEq(_bal(token, payoutTo), 0, "the payout address is paid by a claim only");
        assertEq(swap.owedOf(token, payoutTo), 0);
        uint256 kept = exit == 7 ? s.deposit / 2 : (exit == 8 ? s.deposit : 0);
        assertEq(before - _bal(token, taker), kept, "the deposit returns to the wallet that posted it");
    }

    /// A payout address that reverts or is blacklisted: the claim still succeeds and the proceeds
    /// are parked for the payout address. Anyone can then deliver them, to it and nowhere else.
    function test_payout_parked_thenPushedByAnyone(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _takeWithPayout(token, payoutTo);
        _toReady(id);
        if (usdc_) usdc.setBlacklisted(payoutTo, true);
        else vm.etch(payoutTo, hex"fe");
        IXmrSwap.Swap memory s = _get(id);
        uint256 proceeds = s.amount - s.amount * 5 / 10_000 + s.deposit;

        vm.expectEmit(address(swap));
        emit IXmrSwap.PayoutDeferred(token, payoutTo, proceeds);
        _claim(id);
        assertEq(_get(id).state, DONE);
        assertEq(_get(id).revealed, takerSecret);
        assertEq(swap.owedOf(token, payoutTo), proceeds, "parked under the payout address");
        assertEq(swap.owedOf(token, taker), 0);

        // The taking wallet has no power over them.
        vm.prank(taker);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawOwed(token, taker);
        vm.prank(anyone);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.pushOwed(token, taker);
        // While the address still cannot receive, a push fails and the balance stays parked.
        vm.prank(anyone);
        vm.expectRevert();
        swap.pushOwed(token, payoutTo);
        assertEq(swap.owedOf(token, payoutTo), proceeds);

        if (usdc_) usdc.setBlacklisted(payoutTo, false);
        else vm.etch(payoutTo, "");
        uint256 strangerBefore = _bal(token, anyone);
        vm.prank(anyone);
        swap.pushOwed(token, payoutTo);
        assertEq(_bal(token, payoutTo), proceeds, "delivered to the payout address");
        assertEq(_bal(token, anyone), strangerBefore, "the stranger gains nothing");
        assertEq(swap.owedOf(token, payoutTo), 0);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.pushOwed(token, payoutTo);
        vm.prank(payoutTo);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawOwed(token, payoutTo);
    }

    /// The payout address itself may pull its parked proceeds to any destination.
    function test_payout_parked_thenWithdrawnByThePayoutAddress(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _takeWithPayout(token, payoutTo);
        _toReady(id);
        if (usdc_) usdc.setBlacklisted(payoutTo, true);
        else vm.etch(payoutTo, hex"fe");
        _claim(id);
        uint256 proceeds = swap.owedOf(token, payoutTo);
        assertGt(proceeds, 0);
        address elsewhere = makeAddr("elsewhere");
        vm.prank(payoutTo);
        swap.withdrawOwed(token, elsewhere);
        assertEq(_bal(token, elsewhere), proceeds);
        assertEq(swap.owedOf(token, payoutTo), 0);
    }

    /// `pushOwed` works for every kind of parked balance (a taker's refund, a maker's claim) and
    /// always pays the owed account itself.
    function test_pushOwed_deliversAnyParkedBalance_toItsOwnerOnly(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 id = _swapIn(0, token, READY);
        if (usdc_) usdc.setBlacklisted(payout, true);
        else vm.etch(payout, hex"fe");
        _claim(id);
        uint256 owed = swap.owedOf(token, payout);
        if (usdc_) usdc.setBlacklisted(payout, false);
        else vm.etch(payout, "");
        uint256 before = _bal(token, payout);
        vm.prank(taker);
        swap.pushOwed(token, payout);
        assertEq(_bal(token, payout) - before, owed);
        assertEq(swap.owedOf(token, payout), 0);
    }

    /// Reentrancy on `pushOwed`: the account being paid calls back with full gas and meets the guard.
    function test_pushOwed_reentrancy() public {
        bytes32 id = _takeWithPayout(ETH, payoutTo);
        _toReady(id);
        bytes32 other = _swapIn(0, ETH, READY);
        vm.etch(payoutTo, address(new Receiver()).code);
        Receiver r = Receiver(payable(payoutTo));
        r.set(Receiver.Mode.Reject, address(0), "");
        _claim(id);
        uint256 proceeds = swap.owedOf(ETH, payoutTo);
        assertGt(proceeds, 0);

        bytes[4] memory attempts = [
            abi.encodeCall(IXmrSwap.pushOwed, (ETH, payoutTo)),
            abi.encodeCall(IXmrSwap.withdrawOwed, (ETH, payoutTo)),
            abi.encodeCall(IXmrSwap.claim, (other, makerSecrets[0])),
            abi.encodeCall(IXmrSwap.refund, (other, takerSecret))
        ];
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            r.set(Receiver.Mode.Reenter, address(swap), attempts[i]);
            vm.prank(anyone);
            swap.pushOwed(ETH, payoutTo);
            assertTrue(r.reentered(), "the account did call back");
            assertFalse(r.reenterResult(), "and was refused");
            assertEq(bytes4(r.reenterReturn()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            assertEq(payoutTo.balance, proceeds, "paid exactly once");
            assertEq(swap.owedOf(ETH, payoutTo), 0);
            assertEq(_get(other).state, READY);
            vm.revertToState(snap);
        }
    }

    /// The payout of a claim goes to an arbitrary address chosen by the taker: a contract there
    /// that calls back, burns gas or reverts cannot block the claim, take anything twice or
    /// reach another swap.
    function test_payout_toAnArbitraryContract_cannotBlockOrReenter(uint8 mode) public {
        mode = uint8(bound(mode, 1, 3));
        bytes32 id = _takeWithPayout(ETH, payoutTo);
        _toReady(id);
        bytes32 other = _swapIn(0, ETH, READY);
        vm.etch(payoutTo, address(new Receiver()).code);
        Receiver r = Receiver(payable(payoutTo));
        r.set(Receiver.Mode(mode), address(swap), abi.encodeCall(IXmrSwap.claim, (other, makerSecrets[0])));
        IXmrSwap.Swap memory s = _get(id);
        uint256 proceeds = s.amount - s.amount * 5 / 10_000 + s.deposit;
        uint256 gasBefore = gasleft();
        _claim(id);
        assertLt(gasBefore - gasleft(), 400_000);
        assertEq(_get(id).state, DONE);
        assertFalse(r.reenterResult());
        assertEq(payoutTo.balance + swap.owedOf(ETH, payoutTo), proceeds, "paid or parked exactly once");
        assertEq(_get(other).state, READY);
    }

    // ================================================================== 11.6 freeze

    function test_freeze_window_bounds(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        uint32[6] memory windows = [uint32(1), 3_599, 3_600, 86_400, 259_200, 259_201];
        bool[6] memory ok = [false, false, true, true, true, false];
        for (uint256 i; i < 6; ++i) {
            Open memory o = _std(direction, token);
            o.q.freezeWindow = windows[i];
            o.sig = _signQuote(o.q);
            if (ok[i]) assertEq(_get(_send(o)).freezeSecs, windows[i]);
            else _expectOpen(o, IXmrSwap.FreezeWindowOutOfRange.selector);
        }
        // The final window must also cover W_z: W_p + W_n + D_c + W_z + W_c + 86,400.
        Open memory f = _std(direction, token);
        f.q.freezeWindow = 259_200;
        f.q.finalWindow = 120 + 1800 + 10_800 + 259_200 + 5400 + 86_400 - 1;
        f.sig = _signQuote(f.q);
        _expectOpen(f, IXmrSwap.FinalWindowOutOfRange.selector);
        f.q.finalWindow += 1;
        f.sig = _signQuote(f.q);
        _send(f);
    }

    /// A watcher may be named only against a quote with a freeze window: by the taker at `lock`
    /// (A) and by the maker at `fund` (B).
    function test_freeze_watcherNotAllowed_withoutAWindow(bool usdc_) public {
        address token = _token(usdc_);
        Open memory o = _std(0, token);
        o.watcher = watcherKey;
        _expectOpen(o, IXmrSwap.WatcherNotAllowed.selector);
        o.q.freezeWindow = 3_600;
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        assertEq(_get(id).watcher, watcherKey);

        bytes32 b = _send(_std(1, token));
        fundWatcher = watcherKey;
        vm.expectRevert(IXmrSwap.WatcherNotAllowed.selector);
        this.fundPlain(b);
        fundWatcher = address(0);
        _fund(b);
        assertEq(_get(b).watcher, address(0));
    }

    function fundPlain(bytes32 id) external {
        _fund(id);
    }

    /// The watcher is covered by the open hash in direction A, so the maker approves knowing it.
    function test_freeze_watcher_inTheOpenHash_andTheEvents() public {
        uint256 snap = vm.snapshotState();
        Open memory plain = _std(0, ETH);
        plain.q.freezeWindow = 3_600;
        plain.sig = _signQuote(plain.q);
        bytes32 id = _send(plain);
        bytes32 hashPlain = _get(id).openHash;
        vm.revertToState(snap);

        Open memory o = _std(0, ETH);
        o.q.freezeWindow = 3_600;
        o.sig = _signQuote(o.q);
        o.watcher = watcherKey;
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
            poolLeaves[o.leafIndex],
            address(0),
            watcherKey
        );
        assertEq(_send(o), id);
        assertTrue(_get(id).openHash != hashPlain);
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.approve(id, hashPlain);
        _approve(id);

        // Direction B: the maker's watcher is named at fund and emitted there.
        bytes32 b = _send(_withWindow(_std(1, ETH)));
        IXmrSwap.Swap memory s = _get(b);
        fundCounter++;
        (address k, address k2) = _twin(_fundSecret());
        vm.prank(operator);
        vm.expectEmit(address(swap));
        emit IXmrSwap.Funded(b, makerOwner, 2, k, k2, _spendPub(_fundSecret()), _view("maker view share"), watcherKey);
        swap.fund{value: s.amount}(
            b, s.openHash, k, k2, _spendPub(_fundSecret()), _view("maker view share"), watcherKey
        );
        assertEq(_get(b).watcher, watcherKey);
    }

    function _withWindow(Open memory o) internal view returns (Open memory) {
        o.q.freezeWindow = uint32(FREEZE_WINDOW);
        o.sig = _signQuote(o.q);
        return o;
    }

    /// Z1: only the watcher the swap names, or the locker; only NOTICED; only before T_co; once.
    function test_freeze_whoWhenAndOnce(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 id = _watched(direction, token);
        IXmrSwap.Swap memory s = _get(id);
        address claimer = _claimer(id);
        address[4] memory strangers = [anyone, makerOwner, payout, claimer];
        for (uint256 i; i < 4; ++i) {
            vm.prank(strangers[i]);
            vm.expectRevert(IXmrSwap.Unauthorized.selector);
            swap.freeze(id);
        }
        // At T_co the claim is open: too late to freeze. One second before, it is not.
        vm.warp(s.tClaimOpen);
        vm.prank(watcherKey);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.freeze(id);
        vm.warp(s.tClaimOpen - 1);

        // The watcher, or the locker itself (A: taker wallet or session key; B: operator).
        address[3] memory allowed = [watcherKey, directionB ? operator : taker, directionB ? operator : session];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            vm.prank(allowed[i]);
            vm.expectEmit(address(swap));
            emit IXmrSwap.Frozen(id, makerOwner, 33, taker, watcherKey, uint64(s.tClaimOpen - 1 + FREEZE_WINDOW));
            swap.freeze(id);
            assertEq(_get(id).state, FROZEN);
            assertEq(_get(id).tFreeze, s.tClaimOpen - 1);
            vm.revertToState(snap);
        }
        vm.prank(watcherKey);
        swap.freeze(id);
        assertEq(_counter(33), 1, "freezes");
        // Once.
        vm.prank(watcherKey);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.freeze(id);
        vm.prank(_locker(id));
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.freeze(id);
    }

    function test_freeze_onlyInNoticed_andOnlyWithAWatcherNamed(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        // No watcher named: the locker gets BadState, a key calling itself a watcher Unauthorized.
        bytes32 none = _swapIn(direction, token, NOTICED);
        vm.prank(_locker(none));
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.freeze(none);
        vm.prank(watcherKey);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.freeze(none);

        // A watched swap outside NOTICED.
        takerSecret = _share("second taker share");
        Open memory o = _withWindow(_std(direction, token));
        if (direction == 0) o.watcher = watcherKey;
        bytes32 id = _send(o);
        address locker = direction == 0 ? session : operator;
        vm.prank(locker);
        vm.expectRevert(IXmrSwap.BadState.selector); // PENDING
        swap.freeze(id);
        skip(12);
        fundWatcher = watcherKey;
        _activate(id);
        vm.prank(watcherKey);
        vm.expectRevert(IXmrSwap.BadState.selector); // ACTIVE: the keyless refund already protects
        swap.freeze(id);
        skip(90);
        _notice(id);
        skip(1200);
        _ready(id);
        vm.prank(watcherKey);
        vm.expectRevert(IXmrSwap.BadState.selector); // READY
        swap.freeze(id);
        _claim(id);
        vm.prank(watcherKey);
        vm.expectRevert(IXmrSwap.BadState.selector); // DONE
        swap.freeze(id);
    }

    /// A freeze reveals nothing and moves nothing; a watcher can do nothing else and is never paid.
    function test_freeze_movesNothing_andAWatcherCanOnlyFreeze(bool usdc_, bool directionB) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        bytes32 id = _watched(direction, token);
        IXmrSwap.Swap memory pre = _get(id);
        uint256 escrow = _bal(token, address(swap));
        uint256 open = _openValue(token);
        uint256[4] memory bal =
            [_bal(token, taker), _bal(token, operator), _bal(token, payout), _bal(token, watcherKey)];
        skip(600);
        vm.prank(watcherKey);
        swap.freeze(id);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.revealed, 0);
        assertEq(s.flags, pre.flags, "no flag moves");
        assertEq(_bal(token, address(swap)), escrow);
        assertEq(_openValue(token), open, "a frozen swap is still open");
        assertEq(_bal(token, taker), bal[0]);
        assertEq(_bal(token, operator), bal[1]);
        assertEq(_bal(token, payout), bal[2]);
        assertEq(_bal(token, watcherKey), bal[3]);
        // Only the state and the freeze time changed.
        pre.state = FROZEN;
        pre.tFreeze = uint64(vm.getBlockTimestamp());
        assertEq(keccak256(abi.encode(s)), keccak256(abi.encode(pre)));

        // The watcher's key opens nothing else.
        vm.startPrank(watcherKey);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.setReady(id);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.abort(id);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.withhold(id, 0, 0);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.publishEvidence(id, TXID, _claimerView());
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.cancelPending(id);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawOwed(token, watcherKey);
        vm.stopPrank();
        // Run the swap to its end by every remaining call: the watcher never receives anything.
        _refund(id);
        if (_get(id).state == HOLD) {
            skip(1800);
            swap.releaseDeposit(id);
        }
        assertEq(_bal(token, watcherKey), bal[3]);
        assertEq(swap.owedOf(token, watcherKey), 0);
        assertEq(_bal(token, address(swap)), 0);
    }

    /// A freeze never blocks or delays the locker: refund and ready stay open from the freeze
    /// until T_ff, wherever they were open before.
    function test_freeze_cannotBlockTheLockersRefundOrReady(bool usdc_, bool directionB, uint32 freezeAt, uint32 actAt)
        public
    {
        address token = _token(usdc_);
        bytes32 id = _watched(directionB ? 1 : 0, token);
        IXmrSwap.Swap memory s = _get(id);
        // Freeze at any second of [t_N, T_co), by the watcher.
        uint256 tZ = bound(freezeAt, s.tNotice, s.tClaimOpen - 1);
        vm.warp(tZ);
        vm.prank(watcherKey);
        swap.freeze(id);
        uint256 tFf = _tFf(id);
        assertGe(tFf, s.tClaimOpen, "a freeze never shortens the locker's window");
        assertEq(tFf, tZ + FREEZE_WINDOW > s.tClaimOpen ? tZ + FREEZE_WINDOW : s.tClaimOpen);
        assertLt(tFf, uint256(s.tFinal) - s.claimWindow - 86_400);

        // Refund at any second of [t_Z, T_ff).
        uint256 t = bound(actAt, tZ, tFf - 1);
        vm.warp(t);
        uint256 snap = vm.snapshotState();
        _refund(id);
        assertEq(_get(id).revealed, _lockerSecret(id));
        vm.revertToState(snap);
        // Ready at any second of [max(t_Z, t_N + depth * 60), T_ff).
        uint256 readyMin = s.tNotice + uint256(s.depth) * 60;
        if (t < readyMin) {
            vm.prank(_locker(id));
            vm.expectRevert(IXmrSwap.TooEarly.selector);
            swap.setReady(id);
            vm.warp(readyMin);
        }
        _ready(id);
        s = _get(id);
        assertEq(s.state, READY, "unfrozen");
        assertEq(s.tClaimDeadline, s.tReady + s.claimWindow);
        assertLt(s.tClaimDeadline, s.tFinal - 86_400);
        _claim(id);
        assertEq(_get(id).outcome, 8, "completed normally after a wrong freeze");
    }

    /// The counterparty's claim-without-ready opens at T_ff = max(t_Z + W_z, T_co), not before and
    /// not later, and never past T_final.
    function test_freeze_delaysTheClaim_toTheFrozenFinalTime(bool usdc_, bool directionB, bool shortWindow) public {
        address token = _token(usdc_);
        uint8 direction = directionB ? 1 : 0;
        Open memory o = _std(direction, token);
        // With a one-hour window a freeze right after the notice gives t_Z + W_z < T_co.
        o.q.freezeWindow = shortWindow ? 3_600 : 86_400;
        o.sig = _signQuote(o.q);
        if (direction == 0) o.watcher = watcherKey;
        bytes32 id = _send(o);
        skip(12);
        fundWatcher = watcherKey;
        _activate(id);
        skip(90);
        _notice(id);
        skip(10);
        vm.prank(watcherKey);
        swap.freeze(id);
        IXmrSwap.Swap memory s = _get(id);
        uint256 tFf = _tFf(id);
        if (shortWindow) assertEq(tFf, s.tClaimOpen, "never earlier than T_co");
        else assertEq(tFf, uint256(s.tFreeze) + 86_400);

        uint256 claimSecret = _claimerSecret(id);
        uint256 lockerSecret = _lockerSecret(id);
        // Before T_ff: the claim is closed, also at the old T_co; the refund is open.
        uint256[2] memory early = [uint256(s.tClaimOpen), tFf - 1];
        for (uint256 i; i < 2; ++i) {
            if (early[i] >= tFf) continue;
            vm.warp(early[i]);
            vm.expectRevert(IXmrSwap.TooEarly.selector);
            swap.claim(id, claimSecret);
        }
        vm.warp(tFf - 1);
        uint256 snap = vm.snapshotState();
        swap.refund(id, lockerSecret);
        vm.revertToState(snap);
        // At T_ff the windows swap: refund and ready close, the claim opens.
        vm.warp(tFf);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.refund(id, lockerSecret);
        vm.prank(_locker(id));
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.setReady(id);
        snap = vm.snapshotState();
        swap.claim(id, claimSecret);
        assertEq(_get(id).outcome, 36, "claims_after_freeze");
        assertEq(_counter(36), 1);
        vm.revertToState(snap);
        // The freeze never extends the swap past T_final: the claim is open there as for any swap,
        // and the locker's refund returns at T_exp.
        assertLt(tFf, s.tFinal);
        vm.warp(s.tFinal);
        snap = vm.snapshotState();
        swap.claim(id, claimSecret);
        assertEq(_get(id).outcome, 10, "claims_after_final");
        vm.revertToState(snap);
        vm.warp(uint256(s.tFinal) + EXPIRY_SECS);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.claim(id, claimSecret);
        swap.refund(id, lockerSecret);
        assertEq(_get(id).outcome, 27);
    }

    /// Buy direction: a refund or an abort after a freeze always leaves the deposit withholdable.
    function test_freeze_directionA_depositAlwaysWithholdable(bool usdc_, bool viaAbort) public {
        address token = _token(usdc_);
        bytes32 id = _frozen(0, token);
        IXmrSwap.Swap memory s = _get(id);
        uint256 before = _bal(token, taker);
        if (viaAbort) {
            // Z5: also before T_co the abort is "late" (ABORTED_HOLD), unlike A7b.
            assertLt(vm.getBlockTimestamp(), s.tClaimOpen);
            _abort(id);
            assertEq(_get(id).state, ABORTED_HOLD);
            assertEq(_counter(16), 1, "aborts_late");
            _refund(id);
            assertEq(_counter(22), 1, "refunds_after_abort");
        } else {
            _refund(id); // Z3
            assertEq(_counter(34), 1, "refunds_after_freeze");
        }
        assertEq(_get(id).state, HOLD);
        assertEq(_bal(token, taker) - before, s.amount - s.deposit);
        vm.prank(operator);
        swap.withhold(id, TXID, _claimerView());
        assertEq(_get(id).state, WITHHELD);
        assertEq(_bal(token, address(swap)), s.deposit);
    }

    /// Sell direction: there is no maker bond, so a maker refund after a freeze returns the take
    /// deposit at once and can never hold it, also where an unfrozen refund would have.
    function test_freeze_directionB_neverHoldsTheTakeDeposit(bool usdc_, uint8 when) public {
        address token = _token(usdc_);
        when = uint8(bound(when, 0, 2));
        uint256 takerBefore = _bal(token, taker);
        uint256 operatorBefore = _bal(token, operator);
        Open memory o = _withWindow(_std(1, token));
        bytes32 id = _send(o);
        skip(12);
        fundWatcher = watcherKey;
        _fund(id);
        if (when == 2) {
            // A late notice: unfrozen, any maker refund would hold the deposit (B9h).
            vm.warp(_get(id).tNoteDeadline);
        } else {
            skip(90);
        }
        _notice(id);
        skip(5);
        vm.prank(watcherKey);
        swap.freeze(id);
        IXmrSwap.Swap memory s = _get(id);
        // After T_cut an unfrozen refund would hold the deposit (B9d).
        if (when == 1) vm.warp(_tFf(id) - 1);
        assertEq(when == 1, vm.getBlockTimestamp() >= s.tCut);
        _refund(id);
        s = _get(id);
        assertEq(s.state, DONE);
        assertEq(s.depositState, 0, "never held");
        assertEq(s.outcome, 35);
        assertEq(_counter(35), 1, "backouts_after_freeze");
        assertEq(_bal(token, taker), takerBefore, "the take deposit is back at once");
        assertEq(_bal(token, operator), operatorBefore, "the maker has its escrow back");
        assertEq(_bal(token, address(swap)), 0);
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.BadState.selector);
        swap.withhold(id, 0, 0);
        // The taker's abort after a freeze still leaves the deposit withholdable (Z5).
        takerSecret = _share("second taker share");
        id = _frozen(1, token);
        _abort(id);
        assertEq(_get(id).state, ABORTED_HOLD);
        assertEq(_counter(26), 1, "taker_aborts");
        _refund(id);
        assertEq(_get(id).state, HOLD);
    }

    /// In direction B the latest notice moves earlier by W_z: T_nl = T_final - D_c - W_z - W_c - 86,400.
    function test_freeze_latestNotice_coversTheWindow(bool usdc_) public {
        address token = _token(usdc_);
        Open memory o = _withWindow(_std(1, token));
        o.q.finalWindow = 120 + 1800 + 10_800 + 86_400 + 5400 + 86_400; // the floor
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        skip(12);
        _fund(id);
        IXmrSwap.Swap memory s = _get(id);
        uint256 tNl = uint256(s.tFinal) - 10_800 - 86_400 - 5400 - 86_400;
        assertEq(tNl, uint256(s.tLock) + 120 + 1800);
        bytes32 commitment = _commitment(id);
        vm.warp(tNl);
        vm.prank(session);
        vm.expectRevert(IXmrSwap.TooLate.selector);
        swap.postNotice(id, commitment, _ciphertext());
        vm.warp(tNl - 1);
        vm.prank(session);
        swap.postNotice(id, commitment, _ciphertext());
        assertEq(_get(id).state, NOTICED);
    }

    /// The four freeze counters.
    function test_freeze_counters(bool usdc_) public {
        address token = _token(usdc_);
        bytes32 a = _frozen(0, token);
        _refund(a); // 34
        takerSecret = _share("taker 2");
        bytes32 b = _frozen(1, token);
        _refund(b); // 35
        takerSecret = _share("taker 3");
        bytes32 c = _frozen(0, token);
        vm.warp(_tFf(c));
        _claim(c); // 36
        assertEq(_counter(33), 3, "freezes");
        assertEq(_counter(34), 1, "refunds_after_freeze");
        assertEq(_counter(35), 1, "backouts_after_freeze");
        assertEq(_counter(36), 1, "claims_after_freeze");
        assertEq(_get(a).outcome, 0xff, "held");
        assertEq(_get(b).outcome, 35);
        assertEq(_get(c).outcome, 36);
    }
}
