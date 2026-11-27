// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Base} from "./utils/Base.sol";

/// Gas of the main calls through the proxy. The bounds only guard against a regression.
///
/// For figures a user would pay, run in isolation mode, where every call is a transaction of its
/// own (cold storage, intrinsic gas and calldata included):
///
///   forge test --isolate --match-contract GasTest -vv
///
/// Under a plain `forge test` the whole test is one transaction, so storage is warm and the
/// figures printed are far below the real ones.
contract GasTest is Base {
    function _measure(string memory label, address from, uint256 value, bytes memory data, uint256 bound_) internal {
        vm.prank(from);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = address(swap).call{value: value}(data);
        g -= gasleft();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit log_named_uint(label, g);
        assertLt(g, bound_, label);
    }

    function _happyPath(uint8 direction, address token, string memory tag) internal {
        // A first swap warms the maker's counters and the token balances, as in steady state.
        _claim(_swapIn(direction, token, READY));
        takerSecret = _share("second taker share");

        Open memory o = _open(direction, token, uint64(2 * ONE_XMR), _defaultPrice(token));
        o.leafIndex = 3;
        o.budget = 0.002 ether;
        (uint256 amount, uint256 stake) = _stake(o);
        uint256 value = o.budget + (token == ETH ? stake : 0);
        bytes32 id = _id(o);
        if (direction == 0) {
            _measure(
                string.concat("lock ", tag),
                taker,
                value,
                abi.encodeCall(
                    IXmrSwap.lock,
                    (
                        o.q,
                        o.sig,
                        o.xmr,
                        o.limit,
                        o.nonce,
                        o.sessionKey,
                        o.budget,
                        o.tk,
                        _leaf(3),
                        o.a,
                        o.approvalSig,
                        address(0)
                    )
                ),
                700_000
            );
        } else {
            _measure(
                string.concat("take ", tag),
                taker,
                value,
                abi.encodeCall(
                    IXmrSwap.take,
                    (o.q, o.sig, o.xmr, o.limit, o.nonce, o.sessionKey, o.budget, o.tk, o.a, o.approvalSig, taker)
                ),
                700_000
            );
        }

        skip(12);
        bytes32 h = _get(id).openHash;
        uint256 makerSecret = makerSecrets[3];
        if (direction == 0) {
            _measure(string.concat("approve ", tag), operator, 0, abi.encodeCall(IXmrSwap.approve, (id, h)), 150_000);
        } else {
            fundCounter++;
            makerSecret = _fundSecret();
            (address k, address k2) = _twin(makerSecret);
            _measure(
                string.concat("fund ", tag),
                operator,
                token == ETH ? amount : 0,
                abi.encodeCall(
                    IXmrSwap.fund, (id, h, k, k2, _spendPub(makerSecret), _view("maker view share"), address(0))
                ),
                300_000
            );
        }
        skip(60);
        _measure(
            string.concat("postNotice ", tag),
            _claimer(id),
            0,
            abi.encodeCall(IXmrSwap.postNotice, (id, _commitment(id), _ciphertext())),
            300_000
        );
        skip(600);
        _measure(string.concat("setReady ", tag), _locker(id), 0, abi.encodeCall(IXmrSwap.setReady, (id)), 150_000);

        uint256 claimSecret = direction == 0 ? makerSecret : takerSecret;
        uint256 refundSecret = direction == 0 ? takerSecret : makerSecret;
        uint256 snap = vm.snapshotState();
        _measure(string.concat("claim ", tag), anyone, 0, abi.encodeCall(IXmrSwap.claim, (id, claimSecret)), 250_000);
        vm.revertToState(snap);

        vm.warp(_get(id).tClaimDeadline);
        _measure(string.concat("refund ", tag), anyone, 0, abi.encodeCall(IXmrSwap.refund, (id, refundSecret)), 250_000);
    }

    function test_gas_directionA_eth() public {
        _happyPath(0, ETH, "(A, ETH)");
    }

    function test_gas_directionA_usdc() public {
        _happyPath(0, address(usdc), "(A, USDC)");
    }

    function test_gas_directionB_eth() public {
        _happyPath(1, ETH, "(B, ETH)");
    }

    function test_gas_directionB_usdc() public {
        _happyPath(1, address(usdc), "(B, USDC)");
    }
}
