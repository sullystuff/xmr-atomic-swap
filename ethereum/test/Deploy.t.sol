// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {DeployAnvil} from "../script/DeployAnvil.s.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// The deploy script deploys a working proxy on anvil's chain id and refuses every other one.
contract DeployTest is Test {
    DeployAnvil internal script = new DeployAnvil();
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function test_deploysOnAnvilChainId() public {
        assertEq(block.chainid, 31337);
        DeployAnvil.Deployment memory d = script.deploy(owner, treasury, address(0));
        XmrSwap swap = XmrSwap(d.proxy);
        assertEq(swap.owner(), owner);
        assertEq(swap.treasury(), treasury);
        assertEq(swap.usdc(), d.usdc);
        assertEq(swap.version(), "1");
        assertEq(MockUSDC(d.usdc).decimals(), 6);
        assertTrue(d.implementation != d.proxy);
        // The proxy is live: a maker can register.
        swap.registerMaker(makeAddr("operator"), address(this), bytes32(0));
        assertEq(swap.getMaker(address(this)).registeredAt, block.timestamp);
        // An existing token is used when one is named.
        MockUSDC other = new MockUSDC();
        d = script.deploy(owner, treasury, address(other));
        assertEq(XmrSwap(d.proxy).usdc(), address(other));
    }

    /// A plain deployment is fail-closed; the script's own run sets usable caps explicitly (or
    /// switches them off) and records which.
    function test_caps_failClosedUntilTheScriptOpensThem() public {
        DeployAnvil.Deployment memory d = script.deploy(owner, treasury, address(0));
        assertTrue(d.capsOn);
        assertFalse(d.capsSet);
        (bool on, uint128 maxSwap, uint128 maxOpen, uint128 openValue) = XmrSwap(d.proxy).capsOf(address(0));
        assertTrue(on);
        assertEq(uint256(maxSwap) + maxOpen + openValue, 0, "nothing can open");

        d = script.deployOpen(treasury, false);
        assertTrue(d.capsOn && d.capsSet);
        (on, maxSwap, maxOpen,) = XmrSwap(d.proxy).capsOf(address(0));
        assertTrue(on);
        assertEq(maxSwap, 100 ether);
        assertEq(maxOpen, 1_000 ether);
        (, maxSwap, maxOpen,) = XmrSwap(d.proxy).capsOf(d.usdc);
        assertEq(maxSwap, 250_000e6);
        assertEq(maxOpen, 2_500_000e6);

        d = script.deployOpen(treasury, true);
        assertTrue(d.capsSet && !d.capsOn);
        (on, maxSwap,,) = XmrSwap(d.proxy).capsOf(address(0));
        assertFalse(on);
        assertEq(maxSwap, 0);
    }

    function test_refusesEveryOtherChain() public {
        uint256[7] memory chains = [uint256(1), 10, 137, 8453, 42161, 11155111, 31338];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployAnvil.NotAnvil.selector, chains[i]));
            script.deploy(owner, treasury, address(0));
            vm.expectRevert(abi.encodeWithSelector(DeployAnvil.NotAnvil.selector, chains[i]));
            script.run();
        }
    }

    function testFuzz_refusesEveryOtherChain(uint64 chainId) public {
        vm.assume(chainId != 31337 && chainId != 0);
        vm.chainId(chainId);
        vm.expectRevert(abi.encodeWithSelector(DeployAnvil.NotAnvil.selector, uint256(chainId)));
        script.deploy(owner, treasury, address(0));
    }
}
