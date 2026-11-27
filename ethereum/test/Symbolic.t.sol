// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {SwapMath} from "../src/lib/SwapMath.sol";
import {SwapStore} from "../src/lib/SwapStore.sol";

/// Symbolic checks of the contract's own internal functions (SPEC 11.4, the Ethereum part), for
/// Halmos:
///
///   python3 -m venv .venv && .venv/bin/pip install halmos==0.3.3
///   .venv/bin/halmos --contract SymbolicChecks --loop 4
///
/// `forge test` does not run them (they are `check_` functions, not tests); the forge invariants
/// of test/Invariant.t.sol and test/Exits.t.sol are the evidence that runs in the acceptance
/// command. Each check takes fully symbolic arguments and calls the very library function the
/// contract uses.
///
/// Result on the build machine (Halmos 0.3.3 with the Z3 it installs, 2026-11-27): 11 of the 13
/// checks are proved. Two end in a solver **timeout** (no counterexample, no proof) at 120 s and
/// again at 360 s per assertion: `check_bounds_giveTheDeadlineOrder` (163 paths through
/// `checkBounds`) and `check_bps_neverExceedsTheAmount` (a 128-bit multiply-divide). Those two
/// properties are therefore not established symbolically here; the first is covered by the
/// `derive` vectors and the boundary sequences of the replay and proved for the model by Kani
/// (`exits::the_deadline_order_is_the_order_of_the_spec`), the second by `amounts.json`, the
/// fee fuzz test and Kani (`arith::bps_never_exceeds_the_amount`).
///
/// What is checked is the arithmetic, the cap accounting, the frozen-final time and the deadline
/// algebra. The transition gates themselves (`SwapSettle`, `SwapOpen`) are not checked
/// symbolically; see DEVIATIONS.md, row A10.
contract SymbolicChecks {
    uint256 internal constant MAX128 = type(uint128).max;

    SwapStore.Record internal r;

    // ------------------------------------------------------------------ SPEC 11.6: T_ff

    /// T_ff = max(t_Z + W_z, T_co): a freeze never opens the claim earlier than T_co, never later
    /// than W_z after the freeze unless T_co is later still.
    function check_frozenFinal_isTheLaterOfTheTwo(uint64 tFreeze, uint32 freezeSecs, uint64 tClaimOpen) public {
        r.tFreeze = tFreeze;
        r.freezeSecs = freezeSecs;
        r.tClaimOpen = tClaimOpen;
        uint256 t = SwapStore._tFrozenFinal(r);
        uint256 byWindow = uint256(tFreeze) + freezeSecs;
        assert(t >= tClaimOpen);
        assert(t >= byWindow);
        assert(t == tClaimOpen || t == byWindow);
    }

    /// The deadline algebra of SPEC 3.2 and 11.6 for every parameter set `checkBounds` accepts and
    /// every reachable timing: approval before T_pend, notice before T_note, freeze before T_co,
    /// ready before T_ff. Then T_cut <= T_co - 2M, T_co <= T_ff < T_co + W_z (or T_ff = T_co),
    /// T_ff < T_final - W_c - 86,400 and T_cd < T_final - 86,400: a freeze never extends a swap
    /// past its final deadline.
    function check_bounds_giveTheDeadlineOrder(
        uint16 depBps,
        uint32 wA,
        uint32 wN,
        uint8 depth,
        uint32 dC,
        uint32 wC,
        uint32 wF,
        uint32 wZ,
        uint64 tLock,
        uint64 tActive,
        uint64 tNotice,
        uint64 tFreeze,
        uint64 tReady
    ) public pure {
        SwapMath.checkBounds([uint256(depBps), wA, wN, depth, dC, wC, wF, wZ], SwapMath.PENDING_APPROVAL);
        // Times as the transitions gate them (tLock far below 2^63, so nothing wraps).
        if (tLock >= 1 << 62) return;
        if (!(tActive >= tLock && tActive < uint256(tLock) + wA)) return;
        if (!(tNotice >= tActive && tNotice < uint256(tActive) + wN)) return;
        uint256 tFinal = uint256(tLock) + wF;
        uint256 tCut = uint256(tNotice) + SwapMath.deltaCut(depth);
        uint256 tCo = uint256(tNotice) + dC;
        assert(tCut + 2 * SwapMath.MARGIN_SECS <= tCo);
        assert(tCo + wC + SwapMath.DAY_SECS < tFinal);
        if (wZ == 0) return;
        if (!(tFreeze >= tNotice && tFreeze < tCo)) return;
        uint256 tFf = uint256(tFreeze) + wZ > tCo ? uint256(tFreeze) + wZ : tCo;
        assert(tFf >= tCo);
        assert(tFf < tCo + wZ);
        assert(tFf + wC + SwapMath.DAY_SECS < tFinal);
        if (!(tReady >= tFreeze && tReady < tFf)) return;
        assert(uint256(tReady) + wC + SwapMath.DAY_SECS < tFinal);
    }

    function check_freezeWindow_isZeroOrInRange(uint32 wZ) public pure {
        bool ok = SwapMath.freezeWindowOk(wZ);
        assert(ok == (wZ == 0 || (wZ >= 3_600 && wZ <= 259_200)));
    }

    // ------------------------------------------------------------------ SPEC 11.1: caps and open value

    function _seedCaps(address token, bool on, uint128 maxSwap, uint128 maxOpen, uint128 openValue) internal {
        SwapStore.Layout storage $ = SwapStore.layout();
        $.capsOn = on;
        SwapStore.Cap storage cap = $.caps[token];
        cap.maxSwap = maxSwap;
        cap.maxOpen = maxOpen;
        cap.openValue = openValue;
    }

    /// An accepted open adds exactly the counted value, the result fits 128 bits, and with the
    /// switch on both caps hold. (A refused open reverts and leaves nothing.)
    function check_openValue_addIsExactAndWithinTheCaps(
        address token,
        bool on,
        uint128 maxSwap,
        uint128 maxOpen,
        uint128 openValue,
        uint128 amount,
        uint128 deposit,
        bool directionB
    ) public {
        _seedCaps(token, on, maxSwap, maxOpen, openValue);
        uint256 counted = directionB ? uint256(amount) + deposit : amount;
        SwapStore._addOpenValue(SwapStore.layout(), token, amount, counted);
        uint256 after_ = SwapStore.layout().caps[token].openValue;
        assert(after_ == uint256(openValue) + counted);
        assert(after_ <= MAX128);
        if (on) {
            assert(amount <= maxSwap);
            assert(after_ <= maxOpen);
        }
    }

    /// With the switch on, an open above either cap is refused; exactly at a cap it is accepted.
    function check_openValue_capsRefuseExactlyAboveTheCap(
        address token,
        uint128 maxSwap,
        uint128 maxOpen,
        uint128 openValue,
        uint128 amount
    ) public {
        _seedCaps(token, true, maxSwap, maxOpen, openValue);
        bool mustRefuse = amount > maxSwap || uint256(openValue) + amount > maxOpen;
        try this.addOpenValue(token, amount, amount) {
            assert(!mustRefuse);
        } catch {
            assert(mustRefuse);
        }
    }

    function addOpenValue(address token, uint256 amount, uint256 counted) external {
        SwapStore._addOpenValue(SwapStore.layout(), token, amount, counted);
    }

    /// The one subtraction: it cannot revert for any stored values, it subtracts the counted value
    /// (saturating at zero), it clears the flag, and a second call changes nothing.
    function check_openValue_subtractOnceAndNeverFails(
        address token,
        uint128 openValue,
        uint128 amount,
        uint128 deposit,
        uint8 direction,
        uint8 flags
    ) public {
        _seedCaps(token, true, 0, 0, openValue);
        r.token = token;
        r.amount = amount;
        r.deposit = deposit;
        r.direction = direction;
        r.flags = flags;
        SwapStore._uncount(SwapStore.layout(), r);
        uint256 counted = direction == 0 ? amount : uint256(amount) + deposit;
        uint256 want = flags & 32 == 0 ? openValue : (openValue > counted ? openValue - counted : 0);
        uint256 after_ = SwapStore.layout().caps[token].openValue;
        assert(after_ == want);
        assert(r.flags == flags & ~uint8(32));
        // No cap and no switch is read: zero caps with the switch on (seeded above) stop nothing.
        SwapStore._uncount(SwapStore.layout(), r);
        assert(SwapStore.layout().caps[token].openValue == after_);
    }

    /// Open then leave: the open value returns to exactly what it was.
    function check_openValue_addThenSubtractIsIdentity(
        address token,
        uint128 openValue,
        uint128 amount,
        uint128 deposit,
        bool directionB
    ) public {
        _seedCaps(token, false, 0, 0, openValue);
        uint256 counted = directionB ? uint256(amount) + deposit : amount;
        SwapStore._addOpenValue(SwapStore.layout(), token, amount, counted);
        r.token = token;
        r.amount = amount;
        r.deposit = deposit;
        r.direction = directionB ? 1 : 0;
        r.flags = 32;
        SwapStore._uncount(SwapStore.layout(), r);
        assert(SwapStore.layout().caps[token].openValue == openValue);
    }

    // ------------------------------------------------------------------ SPEC 3.1: arithmetic

    function check_split_halvesSumToTheDeposit(uint128 deposit) public pure {
        (uint256 toTaker, uint256 toTreasury) = SwapMath.splitOf(deposit);
        assert(toTaker + toTreasury == deposit);
        assert(toTaker >= toTreasury);
        assert(toTaker - toTreasury <= 1);
    }

    /// A swap of nothing, or for nothing, is never accepted, and an accepted amount fits 128 bits.
    function check_swapAmount_neverZeroNeverTooWide(bool directionB, uint64 xmr, uint256 price) public pure {
        (bool ok, uint256 amount) = SwapMath.swapAmount(directionB ? 1 : 0, xmr, price);
        if (ok) {
            assert(xmr != 0);
            assert(amount != 0);
            assert(amount <= MAX128);
            assert(price <= MAX128);
        }
    }

    /// The deposit and the fee never exceed the amount they are taken from (shares up to 100%).
    function check_bps_neverExceedsTheAmount(uint128 amount, uint16 bps) public pure {
        if (bps > 10_000) return;
        assert(SwapMath.bpsOf(amount, bps) <= amount);
    }

    /// Direction A rounds up and direction B down: they differ by at most one unit.
    function check_pay_isReceiveRoundedUp(uint64 xmr, uint128 price) public pure {
        (bool okPay, uint256 pay) = SwapMath.payAmount(xmr, price);
        (bool okReceive, uint256 receive_) = SwapMath.receiveAmount(xmr, price);
        if (okPay) assert(okReceive);
        assert(pay >= receive_);
        assert(pay - receive_ <= 1);
    }

    /// Reading 32 little-endian bytes twice gives the bytes back, and byte 0 is the lowest.
    function check_leToUint_isAnInvolution(bytes32 b) public pure {
        uint256 v = SwapMath.leToUint(b);
        assert(SwapMath.leToUint(bytes32(v)) == uint256(b));
        assert(v & 0xff == uint8(b[0]));
        assert(v >> 248 == uint8(b[31]));
    }

    /// A tier lookup answers with one of the three values, and never with an unused (zero) one.
    function check_tierValue_isOneOfTheValues(uint64 xmr, uint64[3] memory above, uint256[3] memory values)
        public
        pure
    {
        (bool ok, uint256 v) = SwapMath.tierValue(xmr, above, values);
        if (!ok) return;
        assert(v != 0);
        assert(v == values[0] || v == values[1] || v == values[2]);
        assert(above[0] == 0);
        if (values[2] != 0 && xmr >= above[2]) assert(v == values[2]);
    }
}
