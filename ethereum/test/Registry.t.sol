// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Base} from "./utils/Base.sol";

/// The maker registry (SPEC 5.3) and the identity link with its delay (SPEC 5.6).
contract RegistryTest is Base {
    uint256 internal constant LINK_DELAY = 604_800;
    address internal bob = makeAddr("bob");
    address internal bobOperator = makeAddr("bob operator");
    bytes32 internal constant SOL_A = keccak256("solana owner");
    bytes32 internal constant SOL_B = keccak256("solana owner b");
    bytes32 internal constant SOL_C = keccak256("solana owner c");

    function test_register() public {
        vm.warp(T0 + 77);
        vm.prank(bob);
        vm.expectEmit(address(swap));
        emit IXmrSwap.MakerRegistered(bob, bobOperator, bob, SOL_B);
        swap.registerMaker(bobOperator, bob, SOL_B);
        IXmrSwap.Maker memory m = swap.getMaker(bob);
        assertEq(m.operator, bobOperator);
        assertEq(m.payout, bob);
        assertEq(m.registeredAt, T0 + 77);
        assertEq(m.solanaOwner, SOL_B, "the link is set immediately");
        assertEq(m.solanaOwnerNextAt, 0);
        assertEq(m.quoteEpoch, 0);
        assertEq(m.approvalEpoch, 0);
        assertFalse(m.paused);

        vm.prank(bob);
        vm.expectRevert(IXmrSwap.AlreadyRegistered.selector);
        swap.registerMaker(makeAddr("x"), bob, 0);
        assertEq(swap.getMaker(makeAddr("nobody")).registeredAt, 0);
    }

    function test_register_rejectsZeroAddresses() public {
        vm.startPrank(bob);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.registerMaker(address(0), bob, 0);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.registerMaker(bobOperator, address(0), 0);
        vm.stopPrank();
    }

    /// Operator-callable registry functions take no maker argument, so an operator names exactly
    /// one maker: operators are unique.
    function test_operator_isUniqueAcrossMakers() public {
        vm.prank(bob);
        vm.expectRevert(IXmrSwap.AlreadyRegistered.selector);
        swap.registerMaker(operator, bob, 0);
        vm.prank(bob);
        swap.registerMaker(bobOperator, bob, 0);
        vm.prank(bob);
        vm.expectRevert(IXmrSwap.AlreadyRegistered.selector);
        swap.setOperator(operator);

        // A rotation frees the old operator address.
        address fresh = makeAddr("fresh operator");
        vm.prank(makerOwner);
        swap.setOperator(fresh);
        vm.prank(bob);
        swap.setOperator(operator);
        assertEq(swap.getMaker(bob).operator, operator);
        // The old operator of the first maker now acts for bob only.
        vm.prank(operator);
        swap.setPaused(true);
        assertTrue(swap.getMaker(bob).paused);
        assertFalse(swap.getMaker(makerOwner).paused);
    }

    function test_setOperator_bumpsBothEpochs() public {
        address fresh = makeAddr("fresh operator");
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.NotRegistered.selector); // owner only
        swap.setOperator(fresh);
        vm.prank(makerOwner);
        vm.expectEmit(address(swap));
        emit IXmrSwap.OperatorChanged(makerOwner, fresh, 1, 1);
        swap.setOperator(fresh);
        IXmrSwap.Maker memory m = swap.getMaker(makerOwner);
        assertEq(m.operator, fresh);
        assertEq(m.quoteEpoch, 1);
        assertEq(m.approvalEpoch, 1);
        // Setting the same operator again still bumps: it is the "cancel everything" switch.
        vm.prank(makerOwner);
        swap.setOperator(fresh);
        assertEq(swap.getMaker(makerOwner).quoteEpoch, 2);
        // An owner may be its own operator.
        vm.prank(makerOwner);
        swap.setOperator(makerOwner);
        vm.prank(makerOwner);
        swap.cancelQuote(5);
        assertTrue(swap.isQuoteCancelled(makerOwner, 5));
    }

    /// The operator of an open swap is the maker's current one: a rotation carries over.
    function test_operatorRotation_carriesOverOpenSwaps() public {
        bytes32 id = _swapIn(0, ETH, PENDING);
        (address fresh,) = makeAddrAndKey("fresh operator");
        vm.prank(makerOwner);
        swap.setOperator(fresh);
        bytes32 h = _get(id).openHash;
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.approve(id, h);
        vm.prank(fresh);
        swap.approve(id, h);
        assertEq(_get(id).state, ACTIVE);
    }

    function test_setPayout() public {
        address fresh = makeAddr("fresh payout");
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.NotRegistered.selector); // the cold owner key only
        swap.setPayout(fresh);
        vm.prank(makerOwner);
        vm.expectRevert(IXmrSwap.BadValue.selector);
        swap.setPayout(address(0));
        vm.prank(makerOwner);
        vm.expectEmit(address(swap));
        emit IXmrSwap.PayoutChanged(makerOwner, fresh);
        swap.setPayout(fresh);

        // A claim pays the payout address in the maker's record, never the operator.
        bytes32 id = _swapIn(0, ETH, READY);
        uint256 operatorBefore = operator.balance;
        _claim(id);
        assertGt(fresh.balance, 0);
        assertEq(payout.balance, 0);
        assertEq(operator.balance, operatorBefore);
    }

    function test_ownerOrOperator_functions() public {
        address[2] memory callers = [makerOwner, operator];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(callers[i]);
            vm.expectEmit(address(swap));
            emit IXmrSwap.PausedChanged(makerOwner, true);
            swap.setPaused(true);
            swap.setPaused(false);
            uint32 q = swap.getMaker(makerOwner).quoteEpoch;
            uint32 a = swap.getMaker(makerOwner).approvalEpoch;
            vm.expectEmit(address(swap));
            emit IXmrSwap.EpochsBumped(makerOwner, q + 1, a);
            swap.bumpEpochs(true, false);
            swap.bumpEpochs(false, true);
            swap.bumpEpochs(false, false);
            assertEq(swap.getMaker(makerOwner).quoteEpoch, q + 1);
            assertEq(swap.getMaker(makerOwner).approvalEpoch, a + 1);
            vm.expectEmit(address(swap));
            emit IXmrSwap.QuoteCancelled(makerOwner, uint64(100 + i));
            swap.cancelQuote(uint64(100 + i));
            vm.expectEmit(address(swap));
            emit IXmrSwap.ApprovalRevoked(makerOwner, bytes32(i));
            swap.revokeApproval(bytes32(i));
            vm.stopPrank();
            assertTrue(swap.isQuoteCancelled(makerOwner, uint64(100 + i)));
            assertTrue(swap.isApprovalRevoked(makerOwner, bytes32(i)));
        }
        // A stranger names no maker.
        vm.startPrank(anyone);
        vm.expectRevert(IXmrSwap.NotRegistered.selector);
        swap.setPaused(true);
        vm.expectRevert(IXmrSwap.NotRegistered.selector);
        swap.bumpEpochs(true, true);
        vm.expectRevert(IXmrSwap.NotRegistered.selector);
        swap.cancelQuote(1);
        vm.expectRevert(IXmrSwap.NotRegistered.selector);
        swap.revokeApproval(0);
        vm.stopPrank();
        // One maker's cancellation is not another's.
        assertFalse(swap.isQuoteCancelled(bob, 100));
        assertFalse(swap.isApprovalRevoked(bob, 0));
    }

    /// A registered maker that somebody else names as operator still acts on its own record.
    function test_ownRecordTakesPrecedence() public {
        vm.prank(bob);
        swap.registerMaker(bobOperator, bob, 0);
        address carol = makeAddr("carol");
        vm.prank(carol);
        swap.registerMaker(bob, carol, 0); // carol names bob as her operator
        vm.prank(bob);
        swap.setPaused(true);
        assertTrue(swap.getMaker(bob).paused);
        assertFalse(swap.getMaker(carol).paused);
    }

    // ------------------------------------------------------------------ the identity link

    function test_link_setImmediatelyWhenNoneExists() public {
        vm.prank(bob);
        swap.registerMaker(bobOperator, bob, 0);
        assertEq(swap.getMaker(bob).solanaOwner, 0);
        vm.prank(bob);
        vm.expectEmit(address(swap));
        emit IXmrSwap.LinkChanged(bob, 0, SOL_B, uint64(T0));
        swap.setSolanaLink(SOL_B);
        IXmrSwap.Maker memory m = swap.getMaker(bob);
        assertEq(m.solanaOwner, SOL_B);
        assertEq(m.solanaOwnerNextAt, 0);
    }

    function test_link_changeTakesEffectAfterTheDelay() public {
        vm.prank(operator);
        vm.expectRevert(IXmrSwap.NotRegistered.selector); // owner only
        swap.setSolanaLink(SOL_B);

        vm.prank(makerOwner);
        vm.expectEmit(address(swap));
        emit IXmrSwap.LinkChanged(makerOwner, SOL_A, SOL_B, uint64(T0 + LINK_DELAY));
        swap.setSolanaLink(SOL_B);
        IXmrSwap.Maker memory m = swap.getMaker(makerOwner);
        assertEq(m.solanaOwner, SOL_A, "the old link stays in effect during the delay");
        assertEq(m.solanaOwnerNext, SOL_B);
        assertEq(m.solanaOwnerNextAt, T0 + LINK_DELAY);
        assertEq(LINK_DELAY, 7 days);

        // One second before the delay ends a new call replaces the pending change and restarts
        // the delay; the old link is still the one in effect.
        vm.warp(T0 + LINK_DELAY - 1);
        vm.prank(makerOwner);
        swap.setSolanaLink(SOL_C);
        m = swap.getMaker(makerOwner);
        assertEq(m.solanaOwner, SOL_A);
        assertEq(m.solanaOwnerNext, SOL_C);
        assertEq(m.solanaOwnerNextAt, T0 + 2 * LINK_DELAY - 1);

        // Once matured, the next call first promotes the pending link, then records its own.
        vm.warp(T0 + 2 * LINK_DELAY - 1);
        vm.prank(makerOwner);
        vm.expectEmit(address(swap));
        emit IXmrSwap.LinkChanged(makerOwner, SOL_C, SOL_B, uint64(T0 + 3 * LINK_DELAY - 1));
        swap.setSolanaLink(SOL_B);
        m = swap.getMaker(makerOwner);
        assertEq(m.solanaOwner, SOL_C, "promoted");
        assertEq(m.solanaOwnerNext, SOL_B);
    }

    function test_link_removalIsDelayedToo() public {
        vm.prank(makerOwner);
        swap.setSolanaLink(0);
        IXmrSwap.Maker memory m = swap.getMaker(makerOwner);
        assertEq(m.solanaOwner, SOL_A, "a bad record cannot be shed at once");
        assertEq(m.solanaOwnerNext, 0);
        assertEq(m.solanaOwnerNextAt, T0 + LINK_DELAY);

        // After the delay the removal is in effect for readers (pending value, matured), and the
        // next call promotes it; a new link is then set at once.
        vm.warp(T0 + LINK_DELAY);
        vm.prank(makerOwner);
        vm.expectEmit(address(swap));
        emit IXmrSwap.LinkChanged(makerOwner, 0, SOL_B, uint64(T0 + LINK_DELAY));
        swap.setSolanaLink(SOL_B);
        m = swap.getMaker(makerOwner);
        assertEq(m.solanaOwner, SOL_B);
        assertEq(m.solanaOwnerNextAt, 0);
    }

    function testFuzz_link_neverChangesBeforeTheDelay(uint32 wait, bytes32 next) public {
        vm.assume(next != SOL_A);
        wait = uint32(bound(wait, 0, LINK_DELAY - 1));
        vm.prank(makerOwner);
        swap.setSolanaLink(next);
        vm.warp(T0 + wait);
        IXmrSwap.Maker memory m = swap.getMaker(makerOwner);
        assertEq(m.solanaOwner, SOL_A);
        assertGt(m.solanaOwnerNextAt, vm.getBlockTimestamp(), "the pending link is not yet in effect");
    }
}
