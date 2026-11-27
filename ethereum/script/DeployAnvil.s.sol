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
///   XMRSWAP_CAPS_OFF   "true" switches the beta caps off instead of setting them
///
/// Beta caps (SPEC 11.1). A fresh XmrSwap is fail-closed: the cap switch is on and every cap is
/// zero, so nothing can open. This script makes the test deployment usable and says how: it sets
/// the caps below for ETH and for the USDC it deployed, leaving the switch on so that tests go
/// through the checks, or switches the caps off when XMRSWAP_CAPS_OFF is set. Only the owner
/// can do either; when XMRSWAP_OWNER is not the sender the deployment stays closed and the
/// output says so.
///
/// forge deploys the two linked logic libraries (SwapOpen, SwapSettle) first and links them.
contract DeployAnvil is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31337;
    // The caps of the anvil deployment: largest swap and largest open value per asset.
    uint128 internal constant ETH_MAX_SWAP = 100 ether;
    uint128 internal constant ETH_MAX_OPEN = 1_000 ether;
    uint128 internal constant USDC_MAX_SWAP = 250_000e6;
    uint128 internal constant USDC_MAX_OPEN = 2_500_000e6;

    error NotAnvil(uint256 chainId);

    struct Deployment {
        address proxy;
        address implementation;
        address usdc;
        address owner;
        address treasury;
        bool capsOn;
        bool capsSet; // false: still fail-closed (every cap zero), the owner must set caps
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
        // Only the owner can open the deployment; the broadcaster is the owner by default.
        if (d.owner == sender) d = _openCaps(d, vm.envOr("XMRSWAP_CAPS_OFF", false));
        vm.stopBroadcast();

        console.log("XmrSwap proxy:   ", d.proxy);
        console.log("implementation:  ", d.implementation);
        console.log("USDC:            ", d.usdc);
        console.log("owner:           ", d.owner);
        console.log("treasury:        ", d.treasury);
        if (!d.capsSet) {
            console.log("beta caps:        NOT SET. The deployment is fail-closed (switch on, every cap zero):");
            console.log("                  nothing can open until the owner calls setCaps or setCapsOn(false).");
        } else if (!d.capsOn) {
            console.log("beta caps:        switched OFF by this script (setCapsOn(false)); every cap is zero.");
        } else {
            console.log("beta caps:        set by this script, switch ON.");
            console.log("  ETH  max swap / max open (wei):       ", ETH_MAX_SWAP, ETH_MAX_OPEN);
            console.log("  USDC max swap / max open (10^-6 USDC):", USDC_MAX_SWAP, USDC_MAX_OPEN);
        }
        string memory out = vm.envOr("XMRSWAP_DEPLOY_OUT", string("deployments/anvil.json"));
        if (keccak256(bytes(out)) != keccak256("-")) _write(d, out);
    }

    /// The deployment itself, callable from tests. Refuses any chain but anvil's. It is left
    /// fail-closed, as `initialize` leaves it.
    function deploy(address owner, address treasury, address usdc) external returns (Deployment memory) {
        _requireAnvil();
        return _deploy(owner, treasury, usdc);
    }

    /// Deploy with this contract as the owner and open the caps as `run` does (tests).
    function deployOpen(address treasury, bool capsOff) external returns (Deployment memory d) {
        _requireAnvil();
        d = _openCaps(_deploy(address(this), treasury, address(0)), capsOff);
    }

    /// Make the deployment usable: set the caps of ETH and of its USDC, or switch the caps off.
    /// The caller must be the owner.
    function _openCaps(Deployment memory d, bool capsOff) internal returns (Deployment memory) {
        XmrSwap swap = XmrSwap(d.proxy);
        if (capsOff) {
            swap.setCapsOn(false);
        } else {
            swap.setCaps(address(0), ETH_MAX_SWAP, ETH_MAX_OPEN);
            swap.setCaps(d.usdc, USDC_MAX_SWAP, USDC_MAX_OPEN);
        }
        d.capsOn = !capsOff;
        d.capsSet = true;
        return d;
    }

    function _requireAnvil() internal view {
        if (block.chainid != ANVIL_CHAIN_ID) revert NotAnvil(block.chainid);
    }

    function _deploy(address owner, address treasury, address usdc) internal returns (Deployment memory d) {
        _requireAnvil();
        d.owner = owner;
        d.treasury = treasury;
        d.capsOn = true;
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
        vm.serializeBool(k, "capsOn", d.capsOn);
        vm.serializeBool(k, "capsSet", d.capsSet);
        vm.serializeString(k, "ethMaxSwap", vm.toString(uint256(d.capsSet && d.capsOn ? ETH_MAX_SWAP : 0)));
        vm.serializeString(k, "ethMaxOpen", vm.toString(uint256(d.capsSet && d.capsOn ? ETH_MAX_OPEN : 0)));
        vm.serializeString(k, "usdcMaxSwap", vm.toString(uint256(d.capsSet && d.capsOn ? USDC_MAX_SWAP : 0)));
        vm.serializeString(k, "usdcMaxOpen", vm.toString(uint256(d.capsSet && d.capsOn ? USDC_MAX_OPEN : 0)));
        string memory json = vm.serializeAddress(k, "treasury", d.treasury);
        vm.writeJson(json, path);
        console.log("written to       ", path);
    }
}
