// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC1967} from "@openzeppelin/contracts/interfaces/IERC1967.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {XmrSwapV2} from "./utils/Mocks.sol";

contract NotUups {
    function version() external pure returns (string memory) {
        return "x";
    }
}

/// SPEC 5.1: UUPS behind an ERC-1967 proxy, the owner's only power is upgrading, and
/// `renounceOwnership()` freezes the contract for good.
contract UpgradeTest is Base {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _implementation() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(swap), IMPLEMENTATION_SLOT))));
    }

    function test_initialState() public view {
        assertEq(swap.owner(), owner);
        assertEq(swap.pendingOwner(), address(0));
        assertEq(swap.treasury(), treasury);
        assertEq(swap.usdc(), address(usdc));
        assertEq(swap.version(), "1");
        assertEq(_implementation(), address(impl));
        assertEq(impl.proxiableUUID(), IMPLEMENTATION_SLOT);
    }

    function test_initialize_onlyOnce_and_implementationLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        swap.initialize(anyone, anyone, address(usdc));
        // The implementation itself can never be initialised.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(anyone, anyone, address(usdc));
        assertEq(impl.owner(), address(0));
    }

    function test_initialize_rejectsZeroAddresses() public {
        XmrSwap fresh = new XmrSwap();
        vm.expectRevert(IXmrSwap.BadValue.selector);
        new ERC1967Proxy(address(fresh), abi.encodeCall(XmrSwap.initialize, (owner, address(0), address(usdc))));
        vm.expectRevert(IXmrSwap.BadValue.selector);
        new ERC1967Proxy(address(fresh), abi.encodeCall(XmrSwap.initialize, (owner, treasury, address(0))));
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(address(fresh), abi.encodeCall(XmrSwap.initialize, (address(0), treasury, address(usdc))));
    }

    /// An upgrade keeps every open swap, the registry and the balances.
    function test_upgrade_keepsState() public {
        bytes32 a = _swapIn(0, ETH, READY);
        bytes32 b = _swapIn(1, address(usdc), NOTICED);
        bytes32 before =
            keccak256(abi.encode(_get(a), _get(b), swap.getMaker(makerOwner), swap.domainSeparator(), swap.owner()));
        uint256 ethBefore = address(swap).balance;

        XmrSwapV2 v2 = new XmrSwapV2();
        vm.prank(owner);
        vm.expectEmit(address(swap));
        emit IERC1967.Upgraded(address(v2));
        swap.upgradeToAndCall(address(v2), "");
        assertEq(_implementation(), address(v2));
        assertEq(swap.version(), "2");
        bytes32 after_ =
            keccak256(abi.encode(_get(a), _get(b), swap.getMaker(makerOwner), swap.domainSeparator(), swap.owner()));
        assertEq(after_, before, "state survived the upgrade");
        assertEq(address(swap).balance, ethBefore);

        // The swaps settle on the new implementation, and old signatures stay valid.
        _claim(a);
        vm.warp(_get(b).tClaimOpen);
        _claim(b);
        assertEq(_get(a).state, DONE);
        assertEq(_get(b).state, DONE);
        _send(_open(1, ETH, uint64(ONE_XMR), 61e15));
        // The initializer cannot be run again through an upgrade.
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        swap.upgradeToAndCall(address(impl), abi.encodeCall(XmrSwap.initialize, (anyone, anyone, address(usdc))));
    }

    function test_upgrade_onlyOwner() public {
        XmrSwapV2 v2 = new XmrSwapV2();
        address[5] memory others = [anyone, treasury, makerOwner, operator, taker];
        for (uint256 i; i < 5; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, others[i]));
            swap.upgradeToAndCall(address(v2), "");
        }
        assertEq(_implementation(), address(impl));
    }

    function test_upgrade_rejectsNonUupsTargets_and_directCalls() public {
        NotUups bad = new NotUups();
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(bad)));
        swap.upgradeToAndCall(address(bad), "");
        vm.expectRevert();
        swap.upgradeToAndCall(anyone, "");
        vm.stopPrank();
        // upgradeToAndCall must go through the proxy.
        XmrSwapV2 v2 = new XmrSwapV2();
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        impl.upgradeToAndCall(address(v2), "");
    }

    /// Ownable2Step: a transfer needs the new owner to accept.
    function test_ownership_twoStep() public {
        address next = makeAddr("next owner");
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, anyone));
        swap.transferOwnership(next);
        vm.prank(owner);
        swap.transferOwnership(next);
        assertEq(swap.owner(), owner, "not transferred until accepted");
        assertEq(swap.pendingOwner(), next);
        XmrSwapV2 v2 = new XmrSwapV2();
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, next));
        swap.upgradeToAndCall(address(v2), "");
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, anyone));
        swap.acceptOwnership();
        vm.prank(next);
        swap.acceptOwnership();
        assertEq(swap.owner(), next);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        swap.upgradeToAndCall(address(v2), "");
        vm.prank(next);
        swap.upgradeToAndCall(address(v2), "");
        assertEq(swap.version(), "2");
    }

    /// Upgrade once, then renounce: no upgrade can ever pass again and swaps keep working.
    function test_upgrade_thenRenounce_freezesUpgrades() public {
        bytes32 open = _swapIn(0, ETH, READY);
        XmrSwapV2 v2 = new XmrSwapV2();
        vm.prank(owner);
        swap.upgradeToAndCall(address(v2), "");
        assertEq(swap.version(), "2");

        // A pending ownership transfer does not survive the renounce.
        address next = makeAddr("next owner");
        vm.prank(owner);
        swap.transferOwnership(next);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, anyone));
        swap.renounceOwnership();
        vm.prank(owner);
        swap.renounceOwnership();
        assertEq(swap.owner(), address(0));
        assertEq(swap.pendingOwner(), address(0));
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, next));
        swap.acceptOwnership();

        XmrSwap v3 = new XmrSwap();
        address[4] memory callers = [owner, next, anyone, treasury];
        for (uint256 i; i < 4; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, callers[i]));
            swap.upgradeToAndCall(address(v3), "");
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, callers[i]));
            swap.transferOwnership(callers[i]);
        }
        assertEq(_implementation(), address(v2), "frozen");
        assertEq(swap.version(), "2");
        // Renouncing froze the treasury and USDC addresses with it: nothing can set them.
        assertEq(swap.treasury(), treasury);
        assertEq(swap.usdc(), address(usdc));

        // The frozen contract still serves swaps.
        _claim(open);
        bytes32 id = _swapIn(1, address(usdc), READY);
        _claim(id);
        assertEq(_get(id).state, DONE);
    }

    /// The implementation's own storage is empty and locked: calling it directly reaches nothing.
    function test_implementation_holdsNoState() public {
        bytes32 id = _swapIn(0, ETH, READY);
        // The implementation's own storage is empty: a direct call sees no swap.
        vm.expectRevert(IXmrSwap.BadState.selector);
        impl.claim(id, makerSecrets[0]);
        assertEq(impl.treasury(), address(0));
    }
}
