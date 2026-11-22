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
