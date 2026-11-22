// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {MockUSDC} from "../test/utils/Mocks.sol";

/// @notice Deploys XmrSwap behind an ERC-1967 proxy, with a mock USDC, on a local anvil node
/// and nowhere else: it refuses every chain id but anvil's 31337. No work package deploys to a
/// live network (SPEC, hard rule); a real deployment is the project owner's separate step.
///
/// Usage, against `anvil` on 127.0.0.1:8545 with its unlocked development accounts:
///
///   forge script script/DeployAnvil.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///
/// Environment (all optional):
///   XMRSWAP_OWNER      upgrade owner (default: the sender)
///   XMRSWAP_TREASURY   treasury address (default: the sender)
///   XMRSWAP_USDC       an existing token to use instead of deploying the mock
///   XMRSWAP_DEPLOY_OUT file to write the addresses to, inside ethereum/deployments/
///                      (default: deployments/anvil.json; set to "-" to write nothing)
///
/// forge deploys the two linked logic libraries (SwapOpen, SwapSettle) first and links them.
contract DeployAnvil is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    error NotAnvil(uint256 chainId);

    struct Deployment {
        address proxy;
        address implementation;
        address usdc;
        address owner;
        address treasury;
    }

    function run() external returns (Deployment memory d) {
        _requireAnvil();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        d = _deploy(
            vm.envOr("XMRSWAP_OWNER", sender),
            vm.envOr("XMRSWAP_TREASURY", sender),
            vm.envOr("XMRSWAP_USDC", address(0))
        );
        vm.stopBroadcast();

        console.log("XmrSwap proxy:   ", d.proxy);
        console.log("implementation:  ", d.implementation);
        console.log("USDC:            ", d.usdc);
        console.log("owner:           ", d.owner);
        console.log("treasury:        ", d.treasury);
        string memory out = vm.envOr("XMRSWAP_DEPLOY_OUT", string("deployments/anvil.json"));
        if (keccak256(bytes(out)) != keccak256("-")) _write(d, out);
    }

    /// The deployment itself, callable from tests. Refuses any chain but anvil's.
    function deploy(address owner, address treasury, address usdc) external returns (Deployment memory) {
        _requireAnvil();
        return _deploy(owner, treasury, usdc);
    }

    function _requireAnvil() internal view {
        if (block.chainid != ANVIL_CHAIN_ID) revert NotAnvil(block.chainid);
    }

    function _deploy(address owner, address treasury, address usdc) internal returns (Deployment memory d) {
        _requireAnvil();
        d.owner = owner;
        d.treasury = treasury;
        d.usdc = usdc == address(0) ? address(new MockUSDC()) : usdc;
        d.implementation = address(new XmrSwap());
        d.proxy =
            address(new ERC1967Proxy(d.implementation, abi.encodeCall(XmrSwap.initialize, (owner, treasury, d.usdc))));
    }

    function _write(Deployment memory d, string memory path) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "proxy", d.proxy);
        vm.serializeAddress(k, "implementation", d.implementation);
        vm.serializeAddress(k, "usdc", d.usdc);
        vm.serializeAddress(k, "owner", d.owner);
        string memory json = vm.serializeAddress(k, "treasury", d.treasury);
        vm.writeJson(json, path);
        console.log("written to       ", path);
    }
}
