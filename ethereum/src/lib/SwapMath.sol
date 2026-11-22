// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";

/// @notice Constants, arithmetic, bounds and hashes of SPEC sections 2 and 3 (Ethereum column).
/// Everything here is checked against the frozen vectors (`amounts.json`, `deadlines.json`,
/// `merkle.json`, `notice.json`, `eip712.json`).
library SwapMath {
    // ---------------------------------------------------------------- protocol constants (SPEC 3.1)
    uint256 internal constant FEE_BPS = 5;
    uint256 internal constant MAX_DEPOSIT_BPS = 500;
    uint256 internal constant HOLD_SECS = 1_800;
    uint256 internal constant SPLIT_SECS = 5_184_000;
    uint256 internal constant EXPIRY_SECS = 2_592_000;
    uint256 internal constant BLOCK_ALLOWANCE_SECS = 180;
    uint256 internal constant CUT_MARGIN_SECS = 900;
    uint256 internal constant MARGIN_SECS = 1_800;
    uint256 internal constant FINALITY_SECS = 1_200;
    uint256 internal constant MIN_NOTICE_SECS = 1_500;
    uint256 internal constant MAX_NOTICE_SECS = 3_600;
    uint256 internal constant MIN_CLAIM_DELAY_SECS = 7_200;
    uint256 internal constant MIN_APPROVAL_SECS = 30;
    uint256 internal constant MAX_APPROVAL_SECS = 3_600;
    uint256 internal constant MAX_FINAL_SECS = 2_592_000;
    uint256 internal constant READY_MIN_SECS_PER_CONF = 60;
    uint256 internal constant LINK_DELAY_SECS = 604_800;
    uint256 internal constant MAX_OPEN_PENDING = 64;
    uint256 internal constant DAY_SECS = 86_400;
    /// Where the treasury's half of a 60-day split goes: false = the treasury, true = 0x...dEaD.
    bool internal constant SPLIT_TO_BURN = false;

    uint256 internal constant PICONERO_PER_XMR = 1e12;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    /// Largest escrowed amount and largest price (the model's `max_amount` for Ethereum).
    uint256 internal constant MAX_AMOUNT = type(uint128).max;
    /// ed25519 prime-subgroup order.
    uint256 internal constant L = 0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED;

    /// Pending kinds of the bounds check. Ethereum always uses APPROVAL (EXPLICIT_APPROVE).
    uint256 internal constant PENDING_NONE = 0;
    uint256 internal constant PENDING_APPROVAL = 1;
    uint256 internal constant PENDING_FUNDING = 2;

    // ---------------------------------------------------------------- amounts

    /// Direction A: `ceil(xmr * price / 10^12)`. `ok` is false when price or result exceed 2^128 - 1.
    function payAmount(uint256 xmr, uint256 price) internal pure returns (bool ok, uint256 amount) {
        if (price > MAX_AMOUNT) return (false, 0);
        uint256 product = xmr * price; // xmr < 2^64 and price < 2^128
        amount = product / PICONERO_PER_XMR;
        if (product % PICONERO_PER_XMR != 0) amount += 1;
        ok = amount <= MAX_AMOUNT;
    }

    /// Direction B: `floor(xmr * price / 10^12)`.
    function receiveAmount(uint256 xmr, uint256 price) internal pure returns (bool ok, uint256 amount) {
        if (price > MAX_AMOUNT) return (false, 0);
        amount = (xmr * price) / PICONERO_PER_XMR;
        ok = amount <= MAX_AMOUNT;
    }

    /// `floor(amount * bps / 10^4)`: the deposit and the fee. `amount <= 2^128 - 1`.
    function bpsOf(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps) / BPS_DENOMINATOR;
    }

    /// `ceil(D / 2)` to the taker, `floor(D / 2)` to the treasury.
    function splitOf(uint256 deposit) internal pure returns (uint256 toTaker, uint256 toTreasury) {
        toTreasury = deposit / 2;
        toTaker = deposit - toTreasury;
    }

    /// Value of the highest used tier whose threshold is `<= xmr`. Well formed: `above[0] == 0`,
    /// tier 0 used, used thresholds strictly increasing, unused tiers (value 0) trailing; the
    /// threshold of an unused tier is ignored.
    function tierValue(uint256 xmr, uint64[3] memory above, uint256[3] memory values)
        internal
        pure
        returns (bool ok, uint256 value)
    {
        if (above[0] != 0 || values[0] == 0) return (false, 0);
        value = values[0];
        if (values[1] == 0) return (values[2] == 0, value);
        if (above[1] == 0) return (false, 0);
        if (xmr >= above[1]) value = values[1];
        if (values[2] == 0) return (true, value);
        if (above[2] <= above[1]) return (false, 0);
        if (xmr >= above[2]) value = values[2];
        return (true, value);
    }

    // ---------------------------------------------------------------- bounds and deadlines

    /// `Δ_cut = F + depth * B + CUT_MARGIN_SECS`.
    function deltaCut(uint256 depth) internal pure returns (uint256) {
        return FINALITY_SECS + depth * BLOCK_ALLOWANCE_SECS + CUT_MARGIN_SECS;
    }

    /// `max(MIN_CLAIM_DELAY_SECS, Δ_cut + 2M)`.
    function minClaimDelay(uint256 depth) internal pure returns (uint256 d) {
        d = deltaCut(depth) + 2 * MARGIN_SECS;
        if (d < MIN_CLAIM_DELAY_SECS) d = MIN_CLAIM_DELAY_SECS;
    }

    /// `F + 2M`.
    function minClaimWindow() internal pure returns (uint256) {
        return FINALITY_SECS + 2 * MARGIN_SECS;
    }

    /// `W_p`: 0, `W_a` or `W_n`.
    function pendingWindow(uint256 wA, uint256 wN, uint256 pending) internal pure returns (uint256) {
        return pending == PENDING_NONE ? 0 : (pending == PENDING_APPROVAL ? wA : wN);
    }

    /// `W_p + W_n + D_c + W_c + 86,400`.
    function minFinalWindow(uint256 wP, uint256 wN, uint256 dC, uint256 wC) internal pure returns (uint256) {
        return wP + wN + dC + wC + DAY_SECS;
    }

    /// Every per-swap bound of SPEC 3.1, in the frozen order of `deadlines.json`.
    function checkBounds(
        uint256 depBps,
        uint256 wA,
        uint256 wN,
        uint256 depth,
        uint256 dC,
        uint256 wC,
        uint256 wF,
        uint256 pending
    ) internal pure {
        if (depBps > MAX_DEPOSIT_BPS) revert IXmrSwap.DepositTooHigh();
        if (pending == PENDING_APPROVAL && (wA < MIN_APPROVAL_SECS || wA > MAX_APPROVAL_SECS)) {
            revert IXmrSwap.ApprovalWindowOutOfRange();
        }
        if (wN < MIN_NOTICE_SECS || wN > MAX_NOTICE_SECS) revert IXmrSwap.NoticeWindowOutOfRange();
        if (depth == 0 || depth > 255) revert IXmrSwap.DepthInvalid();
        if (dC < minClaimDelay(depth)) revert IXmrSwap.ClaimDelayTooShort();
        if (wC < minClaimWindow()) revert IXmrSwap.ClaimWindowTooShort();
        if (wF < minFinalWindow(pendingWindow(wA, wN, pending), wN, dC, wC) || wF > MAX_FINAL_SECS) {
            revert IXmrSwap.FinalWindowOutOfRange();
        }
    }

    // ---------------------------------------------------------------- scalars and hashes

    /// Read 32 little-endian bytes (a Monero scalar) as an integer.
    function leToUint(bytes32 b) internal pure returns (uint256 v) {
        v = uint256(b);
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8)
            | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16)
            | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32)
            | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v = ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64)
            | ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        v = (v >> 128) | (v << 128);
    }

    /// A view share in clear: canonical and nonzero, `0 < v < l`.
    function viewValid(bytes32 viewShare) internal pure returns (bool) {
        uint256 v = leToUint(viewShare);
        return v != 0 && v < L;
    }

    /// `swapId = keccak256(abi.encode(taker, bytes16 swapNonce))`.
    function swapIdOf(address taker, bytes16 swapNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(taker, swapNonce));
    }

    /// Leaf of the Merkle key pool (SPEC 2.7).
    function leafHash(uint32 index, address keyAddr, address keyAddr2, bytes32 spendPub)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(index, keyAddr, keyAddr2, spendPub))));
    }

    /// Commitment of a lock notice (SPEC 5.3).
    function noticeCommitment(bytes32 swapId, bytes32 txid, bytes32 viewShare) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("xmrswap/v1/notice", bytes1(0), swapId, txid, viewShare));
    }

    /// The open hash of SPEC 3.12, from the stored swap.
    function openHash(bytes32 swapId, IXmrSwap.Swap storage s, bytes32 takerView) internal view returns (bytes32) {
        return sha256(
            bytes.concat(
                abi.encodePacked(
                    "xmrswap/v1/open", bytes1(0), swapId, s.tLock, s.direction, s.token, s.xmr, s.amount, s.deposit
                ),
                abi.encodePacked(
                    s.takerSpendPub, s.takerKey, s.takerKey2, takerView, s.takerEncKey, s.makerEncKey, s.keyLeaf
                )
            )
        );
    }
}
