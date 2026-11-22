// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Base} from "./utils/Base.sol";
import {Receiver} from "./utils/Mocks.sol";

/// SPEC 5.4: payouts never revert. A call that carries a secret in its calldata must succeed
/// whatever the recipient or the token does; what cannot be delivered is parked and pulled later.
/// Also: reentrancy through an ETH recipient and through the token.
contract PayoutsTest is Base {
    uint256 internal constant EXPIRY_SECS = 2_592_000;

    /// Give `who` the code of a `Receiver`, so its behaviour on receiving ETH can be switched.
    /// The address keeps acting as an account (pranks), as a smart-contract wallet would.
    function _makeReceiver(address who, Receiver.Mode mode) internal returns (Receiver r) {
        vm.etch(who, address(new Receiver()).code);
        r = Receiver(payable(who));
        r.set(mode, address(0), "");
    }

    /// How `who` is prevented from receiving: 0 = blacklisted in USDC, 1 = USDC paused,
    /// 2 = rejects ETH, 3 = burns all the gas it is given.
    function _block(address who, uint8 kind) internal returns (address token) {
        if (kind == 0) {
            usdc.setBlacklisted(who, true);
            return address(usdc);
        }
        if (kind == 1) {
            usdc.setPaused(true);
            return address(usdc);
        }
        _makeReceiver(who, kind == 2 ? Receiver.Mode.Reject : Receiver.Mode.BurnGas);
        return ETH;
    }

    function _unblock(address who, uint8 kind) internal {
        if (kind == 0) usdc.setBlacklisted(who, false);
        else if (kind == 1) usdc.setPaused(false);
        else Receiver(payable(who)).set(Receiver.Mode.Accept, address(0), "");
    }

    function _token(uint8 kind) internal view returns (address) {
        return kind < 2 ? address(usdc) : ETH;
    }

    /// The owed account pulls its parked amount once it can receive again.
    function _pull(address who, address token, uint256 amount) internal {
        assertEq(swap.owedOf(token, who), amount, "parked amount");
        uint256 before = _bal(token, who);
        vm.prank(who);
        swap.withdrawOwed(token, who);
        assertEq(_bal(token, who) - before, amount, "pulled in full");
        assertEq(swap.owedOf(token, who), 0);
        vm.prank(who);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawOwed(token, who);
    }

    // ------------------------------------------------------------------ claims

    /// Direction A: the maker's payout address cannot receive. The claim still succeeds, reveals
    /// the share, and parks `amount - fee`.
    function test_claimA_neverReverts(uint8 kind, uint8 row) public {
        kind = uint8(bound(kind, 0, 3));
        row = uint8(bound(row, 0, 2));
        address token = _token(kind);
        bytes32 id = _swapIn(0, token, row == 0 ? READY : NOTICED);
        IXmrSwap.Swap memory s = _get(id);
        if (row == 1) vm.warp(s.tClaimOpen); // A11b
        if (row == 2) vm.warp(s.tFinal); // A11c
        _block(payout, kind);
        uint256 escrow = _bal(token, address(swap));
        uint256 fee = s.amount * 5 / 10_000;

        uint256 secret = makerSecrets[0];
        vm.expectEmit(address(swap));
        emit IXmrSwap.PayoutDeferred(token, payout, s.amount - fee);
        vm.prank(operator);
        uint256 gasBefore = gasleft();
        swap.claim(id, secret);
        assertLt(gasBefore - gasleft(), 400_000, "a griefing recipient cannot make the claim expensive");

        s = _get(id);
        assertEq(s.state, DONE);
        assertEq(s.revealed, secret, "the share is on-chain");
        assertEq(_bal(token, address(swap)), escrow, "nothing left the escrow");
        assertEq(swap.treasuryAccrued(token), fee, "the fee cannot block a claim either");
        _unblock(payout, kind);
        _pull(payout, token, s.amount - fee);
        assertEq(_bal(token, address(swap)), fee);
    }

    /// Direction B: the taker cannot receive. The claim still succeeds and parks
    /// `amount - fee + Dp`.
    function test_claimB_neverReverts(uint8 kind, uint8 row) public {
        kind = uint8(bound(kind, 0, 3));
        row = uint8(bound(row, 0, 2));
        address token = _token(kind);
        bytes32 id = _swapIn(1, token, row == 0 ? READY : NOTICED);
        IXmrSwap.Swap memory s = _get(id);
        if (row == 1) vm.warp(s.tClaimOpen); // B10b
        if (row == 2) vm.warp(s.tFinal); // B10c
        _block(taker, kind);
        uint256 fee = s.amount * 5 / 10_000;
        uint256 owed = s.amount - fee + s.deposit;

        vm.prank(session);
        swap.claim(id, takerSecret);
        assertEq(_get(id).state, DONE);
        assertEq(_get(id).revealed, takerSecret);
        _unblock(taker, kind);
        _pull(taker, token, owed);
        assertEq(_bal(token, address(swap)), fee);
    }

    // ------------------------------------------------------------------ refunds

    /// Direction A: the taker cannot receive its refund, on every refund row.
    function test_refundA_neverReverts(uint8 kind, uint8 row) public {
        kind = uint8(bound(kind, 0, 3));
        row = uint8(bound(row, 0, 6));
        address token = _token(kind);
        uint8[7] memory states = [ACTIVE, NOTICED, ABORTED_HOLD, ABORTED_FREE, READY, NOTICED, ACTIVE];
        bytes32 id = _swapIn(0, token, states[row]);
        IXmrSwap.Swap memory s = _get(id);
        if (row == 4) vm.warp(s.tClaimDeadline); // A10e
        if (row == 5) vm.warp(s.tFinal + EXPIRY_SECS); // A10f
        if (row == 6) vm.warp(s.tNoteDeadline); // A10g
        bool held = row <= 2;
        _block(taker, kind);

        vm.prank(session);
        swap.refund(id, takerSecret);
        s = _get(id);
        assertEq(s.state, held ? HOLD : DONE);
        assertEq(s.revealed, takerSecret);
        uint256 owed = held ? s.amount - s.deposit : s.amount;
        assertEq(swap.owedOf(token, taker), owed);

        // The held deposit parks too when it is released to a taker that still cannot receive.
        if (held) {
            skip(1800);
            swap.releaseDeposit(id);
            assertEq(_get(id).state, DONE);
            owed += s.deposit;
        }
        _unblock(taker, kind);
        _pull(taker, token, owed);
        assertEq(_bal(token, address(swap)), 0);
    }

    /// Direction B: the operator cannot receive its own escrow back, or the taker its deposit.
    function test_refundB_neverReverts(uint8 kind, bool blockTaker) public {
        kind = uint8(bound(kind, 0, 3));
        address token = _token(kind);
        bytes32 id = _swapIn(1, token, ACTIVE); // B9a: escrow to the operator, deposit to the taker
        IXmrSwap.Swap memory s = _get(id);
        address blocked = blockTaker ? taker : operator;
        _block(blocked, kind);
        uint256 secret = _fundSecret();
        vm.prank(operator);
        swap.refund(id, secret);
        assertEq(_get(id).state, DONE);
        assertEq(_get(id).revealed, secret);
        _unblock(blocked, kind);
        if (kind == 1) {
            // A paused token parks both payouts.
            _pull(operator, token, s.amount);
            _pull(taker, token, s.deposit);
        } else {
            _pull(blocked, token, blockTaker ? s.deposit : s.amount);
        }
        assertEq(_bal(token, address(swap)), 0);
    }

    /// The keyless exits and the deposit calls park as well; none of them can be blocked.
    function test_keylessExits_park(uint8 kind, uint8 exit) public {
        kind = uint8(bound(kind, 0, 3));
        exit = uint8(bound(exit, 0, 6));
        address token = _token(kind);
        bytes32 id;
        uint256 owed;
        if (exit <= 2) {
            id = _swapIn(0, token, PENDING);
            owed = _get(id).amount;
            _block(taker, kind);
            if (exit == 0) {
                vm.prank(session);
                swap.cancelPending(id);
            } else if (exit == 1) {
                bytes32 h = _get(id).openHash;
                vm.prank(operator);
                swap.reject(id, h, 1);
            } else {
                skip(120);
                swap.expirePending(id);
            }
        } else if (exit <= 4) {
            id = _swapIn(0, token, ACTIVE);
            owed = _get(id).amount;
            _block(taker, kind);
            if (exit == 3) {
                _abort(id); // A7a
            } else {
                skip(1800);
                swap.refundUnnoticed(id); // A8
            }
        } else if (exit == 5) {
            id = _swapIn(1, token, ACTIVE);
            owed = _get(id).deposit;
            vm.warp(_get(id).tFinal + EXPIRY_SECS);
            _block(taker, kind);
            swap.expireUnnoticed(id); // B11
            assertEq(swap.owedOf(token, makerOwner), _get(id).amount);
        } else {
            id = _swapIn(0, token, NOTICED);
            _refund(id);
            vm.prank(operator);
            swap.withhold(id, TXID, _claimerView());
            skip(5_184_000);
            (owed,) = (_get(id).deposit - _get(id).deposit / 2, 0);
            _block(taker, kind);
            swap.splitDeposit(id);
        }
        assertEq(_get(id).state, DONE);
        _unblock(taker, kind);
        _pull(taker, token, owed);
    }

    /// The treasury's fee only accrues: a blacklisted or ETH-rejecting treasury blocks nothing.
    function test_treasury_cannotBlockAClaim(bool usdc_) public {
        address token = usdc_ ? address(usdc) : ETH;
        if (usdc_) usdc.setBlacklisted(treasury, true);
        else _makeReceiver(treasury, Receiver.Mode.Reject);
        bytes32 id = _swapIn(0, token, READY);
        _claim(id);
        uint256 fee = _get(id).amount * 5 / 10_000;
        assertEq(swap.treasuryAccrued(token), fee);
        // The treasury may pull to another address.
        address vault = makeAddr("treasury vault");
        vm.prank(treasury);
        swap.withdrawTreasury(token, vault);
        assertEq(_bal(token, vault), fee);
    }

    /// The escrow contract itself blacklisted: USDC swaps are stuck until the issuer acts, but
    /// state stays consistent and the secret-bearing calls still succeed.
    function test_escrowBlacklisted_stateStaysConsistent() public {
        address u = address(usdc);
        bytes32 id = _swapIn(0, u, READY);
        usdc.setBlacklisted(address(swap), true);
        _claim(id);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.state, DONE);
        uint256 owed = s.amount - s.amount * 5 / 10_000;
        assertEq(swap.owedOf(u, payout), owed);
        vm.prank(payout);
        vm.expectRevert();
        swap.withdrawOwed(u, payout);
        assertEq(swap.owedOf(u, payout), owed, "a failed pull keeps the balance");
        usdc.setBlacklisted(address(swap), false);
        _pull(payout, u, owed);
    }

    function test_withdrawOwed_rules(bool usdc_) public {
        address token = usdc_ ? address(usdc) : ETH;
        bytes32 id = _swapIn(0, token, READY);
        _block(payout, usdc_ ? 0 : 2);
        _claim(id);
        uint256 owed = swap.owedOf(token, payout);
        assertGt(owed, 0);
        // Nobody else can pull it, to anywhere.
        address[4] memory others = [operator, makerOwner, taker, anyone];
        for (uint256 i; i < 4; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IXmrSwap.NothingOwed.selector);
            swap.withdrawOwed(token, others[i]);
        }
        vm.prank(payout);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.withdrawOwed(token, address(0));
        // Parked amounts are per token.
        vm.prank(payout);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawOwed(usdc_ ? ETH : address(usdc), payout);
        // The owed account may name another destination (it cannot receive itself).
        address elsewhere = makeAddr("elsewhere");
        vm.prank(payout);
        swap.withdrawOwed(token, elsewhere);
        assertEq(_bal(token, elsewhere), owed);
        assertEq(swap.owedOf(token, payout), 0);
    }

    /// A pull to a destination that rejects ETH reverts and keeps the parked balance.
    function test_withdrawOwed_failedPullKeepsBalance() public {
        bytes32 id = _swapIn(0, ETH, READY);
        Receiver r = _makeReceiver(payout, Receiver.Mode.Reject);
        _claim(id);
        uint256 owed = swap.owedOf(ETH, payout);
        vm.prank(payout);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.withdrawOwed(ETH, payout);
        assertEq(swap.owedOf(ETH, payout), owed);
        r.set(Receiver.Mode.Accept, address(0), "");
        _pull(payout, ETH, owed);
    }

    // ------------------------------------------------------------------ reentrancy

    /// An ETH recipient that calls back into the contract during its payout. The callback gets
    /// 30,000 gas and meets the reentrancy guard; either way the outer call succeeds, the payout
    /// is parked, and nothing is paid twice.
    function test_reentrancy_ethPayout_duringClaim(uint8 target) public {
        target = uint8(bound(target, 0, 3));
        bytes32 id = _swapIn(0, ETH, READY);
        bytes32 other = _swapIn(0, ETH, READY);
        Receiver r = _makeReceiver(payout, Receiver.Mode.Reenter);
        bytes memory data;
        if (target == 0) data = abi.encodeCall(IXmrSwap.claim, (id, makerSecrets[0]));
        if (target == 1) data = abi.encodeCall(IXmrSwap.claim, (other, makerSecrets[1]));
        if (target == 2) data = abi.encodeCall(IXmrSwap.withdrawOwed, (ETH, payout));
        if (target == 3) data = abi.encodeCall(IXmrSwap.withdrawTreasury, (ETH, payout));
        r.set(Receiver.Mode.Reenter, address(swap), data);

        uint256 escrow = address(swap).balance;
        IXmrSwap.Swap memory s = _get(id);
        uint256 paid = s.amount - s.amount * 5 / 10_000;
        vm.prank(operator);
        swap.claim(id, makerSecrets[0]);

        assertEq(_get(id).state, DONE);
        assertEq(_get(other).state, READY, "the other swap is untouched");
        // The callback failed: either the guard or the 30,000 gas stipend stopped it. Whether the
        // recipient then kept the ETH or the payout was parked, it was paid exactly once.
        assertFalse(r.reenterResult(), "the reentrant call did not succeed");
        assertEq(payout.balance + swap.owedOf(ETH, payout), paid, "paid exactly once");
        assertEq(address(swap).balance, escrow - payout.balance);
    }

    /// The same through `withdrawOwed`, which forwards all gas: the guard is what stops it.
    function test_reentrancy_withdrawOwed() public {
        bytes32 id = _swapIn(0, ETH, READY);
        bytes32 other = _swapIn(0, ETH, READY);
        Receiver r = _makeReceiver(payout, Receiver.Mode.Reject);
        _claim(id);
        uint256 owed = swap.owedOf(ETH, payout);
        assertGt(owed, 0);

        bytes[3] memory attempts = [
            abi.encodeCall(IXmrSwap.withdrawOwed, (ETH, payout)),
            abi.encodeCall(IXmrSwap.claim, (other, makerSecrets[1])),
            abi.encodeCall(IXmrSwap.refund, (other, takerSecret))
        ];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            r.set(Receiver.Mode.Reenter, address(swap), attempts[i]);
            vm.prank(payout);
            swap.withdrawOwed(ETH, payout);
            assertTrue(r.reentered(), "the recipient did call back");
            assertFalse(r.reenterResult(), "and was refused");
            assertEq(
                bytes4(r.reenterReturn()),
                ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector,
                "by the reentrancy guard"
            );
            assertEq(payout.balance, owed, "paid exactly once");
            assertEq(swap.owedOf(ETH, payout), 0);
            assertEq(_get(other).state, READY);
            vm.revertToState(snap);
        }
    }

    /// The session-budget transfer at lock, and the taker's refund path.
    function test_reentrancy_sessionKey_and_taker() public {
        // A session key that is a contract calling back during the budget transfer: the callback
        // cannot run inside the stipend, the transfer fails and the whole lock reverts (it carries
        // no secret). The session key is meant to be an externally owned account.
        bytes32 pending = _swapIn(0, ETH, PENDING);
        uint256 snap = vm.snapshotState();
        Receiver r = _makeReceiver(session, Receiver.Mode.Reenter);
        r.set(Receiver.Mode.Reenter, address(swap), abi.encodeCall(IXmrSwap.cancelPending, (pending)));
        Open memory o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.leafIndex = 5;
        o.budget = 1 ether;
        vm.expectRevert(IXmrSwap.BadValue.selector);
        this.sendOpen(o);
        assertEq(_get(pending).state, PENDING, "the callback could not cancel");
        assertEq(_get(_id(o)).state, 0);
        vm.revertToState(snap);

        // A taker that calls back when it is refunded.
        o = _open(0, ETH, uint64(ONE_XMR), 61e15);
        o.leafIndex = 5;
        bytes32 id = _send(o);
        _approve(id);
        Receiver t = _makeReceiver(taker, Receiver.Mode.Reenter);
        t.set(Receiver.Mode.Reenter, address(swap), abi.encodeCall(IXmrSwap.refund, (id, takerSecret)));
        IXmrSwap.Swap memory s = _get(id);
        uint256 before = taker.balance;
        vm.prank(anyone);
        swap.refund(id, takerSecret);
        assertFalse(t.reenterResult());
        assertEq(taker.balance - before + swap.owedOf(ETH, taker), s.amount - s.deposit, "refunded exactly once");
        assertEq(_get(id).state, HOLD);
    }

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }

    /// A token that calls back into the contract while it is being transferred (in and out).
    function test_reentrancy_throughTheToken() public {
        address u = address(usdc);
        bytes32 pending = _swapIn(0, u, PENDING);
        bytes32 ready = _swapIn(0, u, READY);

        // During the pull of a lock.
        usdc.setHook(address(swap), abi.encodeCall(IXmrSwap.expirePending, (pending)));
        skip(200);
        bytes32 id = _send(_open(0, u, uint64(ONE_XMR), 165_250_000));
        assertTrue(usdc.hookCalled());
        assertFalse(usdc.hookResult(), "the guard refused the callback");
        assertEq(_get(pending).state, PENDING);
        assertEq(_get(id).state, PENDING);

        // During the payout of a claim.
        usdc.setHook(address(swap), abi.encodeCall(IXmrSwap.claim, (ready, makerSecrets[1])));
        uint256 before = usdc.balanceOf(payout);
        _claim(ready);
        assertTrue(usdc.hookCalled());
        assertFalse(usdc.hookResult());
        IXmrSwap.Swap memory s = _get(ready);
        assertEq(usdc.balanceOf(payout) - before, s.amount - s.amount * 5 / 10_000, "paid exactly once");
        assertEq(swap.owedOf(u, payout), 0);
    }

    /// Fuzz: whatever combination of recipients cannot receive, both secret-bearing calls succeed
    /// in every state where the model allows them, and every unit is paid or parked.
    function testFuzz_secretCallsNeverRevert(bool directionB, bool claim_, uint8 kind, uint8 blockedMask) public {
        kind = uint8(bound(kind, 0, 3));
        address token = _token(kind);
        bytes32 id = _swapIn(directionB ? 1 : 0, token, claim_ ? READY : NOTICED);
        address[4] memory who = [taker, payout, operator, makerOwner];
        for (uint256 i; i < 4; ++i) {
            if (blockedMask & (1 << i) != 0) _block(who[i], kind);
        }
        IXmrSwap.Swap memory s = _get(id);
        uint256 before = _bal(token, taker) + _bal(token, payout) + _bal(token, operator);
        uint256 escrow = _bal(token, address(swap));
        if (claim_) _claim(id);
        else _refund(id);
        uint256 received = _bal(token, taker) + _bal(token, payout) + _bal(token, operator) - before;
        uint256 parked = swap.owedOf(token, taker) + swap.owedOf(token, payout) + swap.owedOf(token, operator);
        uint256 stays = swap.treasuryAccrued(token) + (_get(id).state == HOLD ? s.deposit : 0);
        assertEq(received + parked + stays, escrow, "every unit is paid, parked, held or accrued");
        assertEq(_bal(token, address(swap)), parked + stays);
        assertTrue(_get(id).revealed != 0);
    }
}
