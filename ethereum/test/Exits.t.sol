// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {XmrSwapV2} from "./utils/Mocks.sol";

/// Invariant 3 (SPEC 11.1): admin switches gate only new exposure. No cap, pause, epoch bump,
/// ownership state or upgrade-in-progress may block, delay or alter any exit; the only calls a
/// switch may refuse are `lock` and `take`.
///
/// The test walks every exit of SPEC 3.4 to 3.6, 11.2 and 11.6 to its end, in both directions
/// and with both assets, once with no switch set and once under each hostile setting applied
/// right after the swap was opened. Every call of every walk must succeed, and the walk must end
/// in exactly the same swap record, balances, parked amounts, counters and open value as with
/// no switch set: nothing blocked, nothing delayed, nothing altered.
contract ExitsTest is Base {
    uint256 internal constant EXPIRY_SECS = 2_592_000;
    uint256 internal constant PATHS = 30;
    uint256 internal constant REGIMES = 8;
    address internal payoutTo = makeAddr("fresh payout address");
    address internal nextOwner = makeAddr("next owner");

    bytes32 internal id;
    address internal token;
    uint256 internal counted;
    uint256 internal walked;
    uint256 internal callsMade;

    // ------------------------------------------------------------------ the hostile settings

    /// 0: nothing set. Every other regime sets every cap to zero for both assets.
    /// 1: switch on. 2: switch off. 3: switch on, maker paused, both epochs bumped.
    /// 4: as 3, with an ownership transfer started and not accepted.
    /// 5: as 3, with ownership transferred to another owner, who upgrades the implementation.
    /// 6: as 3, then ownership renounced: the caps stay zero and on for good.
    /// 7: as 3, and the maker starts unlinking its Solana key.
    function _hostile(uint256 regime) internal {
        if (regime == 0) return;
        vm.startPrank(owner);
        swap.setCaps(ETH, 0, 0);
        swap.setCaps(address(usdc), 0, 0);
        swap.setCapsOn(regime != 2);
        vm.stopPrank();
        if (regime < 3) return;
        vm.prank(operator);
        swap.setPaused(true);
        vm.prank(makerOwner);
        swap.bumpEpochs(true, true);
        if (regime == 4) {
            vm.prank(owner);
            swap.transferOwnership(nextOwner);
        } else if (regime == 5) {
            vm.prank(owner);
            swap.transferOwnership(nextOwner);
            XmrSwapV2 v2 = new XmrSwapV2();
            vm.startPrank(nextOwner);
            swap.acceptOwnership();
            swap.upgradeToAndCall(address(v2), "");
            vm.stopPrank();
        } else if (regime == 6) {
            vm.prank(owner);
            swap.renounceOwnership();
        } else if (regime == 7) {
            vm.prank(makerOwner);
            swap.setSolanaLink(bytes32(0));
        }
    }

    /// Under a hostile regime new swaps are refused (that is all a switch may do); with the
    /// switch off and no pause they open.
    function _checkOpens(uint256 regime) internal {
        if (regime == 0) return;
        for (uint8 direction; direction < 2; ++direction) {
            Open memory o = _open(direction, token, uint64(ONE_XMR), _defaultPrice(token));
            o.leafIndex = 7;
            o.nonce = bytes16(uint128(0xF000 + direction));
            (, uint256 stake) = _stake(o);
            bytes memory data = direction == 0
                ? abi.encodeCall(
                    IXmrSwap.lock,
                    (o.q, o.sig, o.xmr, o.limit, o.nonce, session, 0, o.tk, _leaf(7), o.a, "", address(0))
                )
                : abi.encodeCall(IXmrSwap.take, (o.q, o.sig, o.xmr, 0, o.nonce, session, 0, o.tk, o.a, "", taker));
            uint256 snap = vm.snapshotState();
            vm.prank(taker);
            (bool ok, bytes memory ret) = address(swap).call{value: token == ETH ? stake : 0}(data);
            if (regime == 2) {
                assertTrue(ok, "switch off, no pause: a new swap opens");
            } else {
                assertFalse(ok, "a hostile switch refuses new swaps");
                bytes4 err = bytes4(ret);
                assertTrue(
                    err == IXmrSwap.SwapCapExceeded.selector || err == IXmrSwap.Paused.selector, "by a cap or the pause"
                );
            }
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ the walks

    /// After every call of a walk: the swap is counted in the open value exactly while it is in an
    /// open state, and the escrow covers it.
    function _after() internal {
        callsMade++;
        IXmrSwap.Swap memory s = _get(id);
        bool open = (s.state >= PENDING && s.state <= ABORTED_HOLD) || s.state == FROZEN;
        assertEq(s.flags & 32 != 0, open, "counted exactly while open");
        assertEq(_openValue(token), open ? counted : 0, "the open value is this swap's counted value, or nothing");
    }

    function _fingerprint() internal view returns (bytes32) {
        address[7] memory who = [taker, payout, operator, makerOwner, payoutTo, watcherKey, treasury];
        uint256[7] memory bal;
        uint256[7] memory owed;
        for (uint256 i; i < 7; ++i) {
            bal[i] = _bal(token, who[i]);
            owed[i] = swap.owedOf(token, who[i]);
        }
        IXmrSwap.Maker memory m = swap.getMaker(makerOwner);
        (uint256 volume, uint256 withheld) = swap.volumeOf(makerOwner, token);
        return keccak256(
            abi.encode(
                _get(id),
                bal,
                owed,
                swap.treasuryAccrued(token),
                _bal(token, address(swap)),
                _openValue(token),
                m.counters,
                m.openPending,
                m.responseSecsSum,
                volume,
                withheld
            )
        );
    }

    function _block(address who, bool on) internal {
        if (token == ETH) vm.etch(who, on ? bytes(hex"fe") : bytes(""));
        else usdc.setBlacklisted(who, on);
    }

    function _evidenceOf() internal view returns (bytes32, bytes32) {
        IXmrSwap.Swap memory s = _get(id);
        bool needed = s.direction == 0 && s.flags & 1 != 0;
        return needed ? (TXID, _claimerView()) : (bytes32(0), bytes32(0));
    }

    // One call each, as the right party, then the accounting check.

    function _doActivate() internal {
        skip(12);
        address before = fundWatcher;
        if (_get(id).freezeSecs != 0) fundWatcher = watcherKey;
        _activate(id);
        fundWatcher = before;
        _after();
    }

    function _doNotice() internal {
        skip(90);
        _notice(id);
        _after();
    }

    function _doReady() internal {
        IXmrSwap.Swap memory s = _get(id);
        uint256 readyMin = s.tNotice + uint256(s.depth) * 60;
        if (vm.getBlockTimestamp() < readyMin) vm.warp(readyMin);
        _ready(id);
        _after();
    }

    function _doFreeze(address by) internal {
        skip(300);
        vm.prank(by);
        swap.freeze(id);
        _after();
    }

    function _doAbort() internal {
        _abort(id);
        _after();
    }

    function _doRefund() internal {
        _refund(id);
        _after();
    }

    function _doClaim() internal {
        _claim(id);
        _after();
    }

    function _doEvidence() internal {
        vm.prank(_claimer(id));
        swap.publishEvidence(id, TXID, _claimerView());
        _after();
    }

    function _doWithhold() internal {
        (bytes32 txid, bytes32 v) = _evidenceOf();
        vm.prank(operator);
        swap.withhold(id, txid, v);
        _after();
    }

    function _doRelease(address by) internal {
        vm.prank(by);
        swap.releaseDeposit(id);
        _after();
    }

    function _doSplit() internal {
        vm.warp(_get(id).tRefund + 5_184_000);
        vm.prank(anyone);
        swap.splitDeposit(id);
        _after();
    }

    /// One walk: open a swap, apply the regime, run the path to its end. Returns false when the
    /// path does not exist in this direction.
    function _walk(uint256 path, uint8 direction, uint256 regime) internal returns (bool) {
        bool a = direction == 0;
        // Paths that need a freeze window and a watcher; one that needs another payout address.
        bool watched = path >= 18 && path <= 23;
        if (path == 4 || path == 5 || path == 7) if (!a) return false; // A7a, A8, A10g
        if (path == 22 || path == 24 || path == 25) if (a) return false; // B11, B9b, payout parked

        Open memory o = _open(direction, token, uint64(2 * ONE_XMR), _defaultPrice(token));
        if (watched) {
            o.q.freezeWindow = uint32(FREEZE_WINDOW);
            o.sig = _signQuote(o.q);
            if (a) o.watcher = watcherKey;
        }
        if (path == 25 || path == 28) if (!a) o.payout = payoutTo;
        id = _send(o);
        counted = _counted(id);
        callsMade++;
        assertEq(_openValue(token), counted);

        _hostile(regime);
        _checkOpens(regime);
        IXmrSwap.Swap memory s;

        if (path == 0) {
            bytes32 h = _get(id).openHash;
            vm.prank(operator);
            swap.reject(id, h, 1);
            _after();
        } else if (path == 1) {
            vm.prank(session);
            swap.cancelPending(id);
            _after();
        } else if (path == 2) {
            vm.warp(_get(id).tPendingDeadline);
            vm.prank(anyone);
            swap.expirePending(id);
            _after();
        } else if (path == 3) {
            // A keyed refund right after approval or funding (A10a held; B9a free).
            _doActivate();
            _doRefund();
            if (a) {
                vm.warp(_get(id).tRefund + 1800);
                _doRelease(anyone);
            }
        } else if (path == 4) {
            _doActivate();
            _doAbort(); // A7a
        } else if (path == 5) {
            _doActivate();
            vm.warp(_get(id).tNoteDeadline);
            vm.prank(anyone);
            swap.refundUnnoticed(id); // A8
            _after();
        } else if (path == 6) {
            // The same refund, the deposit withheld without evidence and released by the operator.
            _doActivate();
            if (!a) vm.warp(_get(id).tNoteDeadline); // B9b holds
            _doRefund();
            _doWithhold();
            _doRelease(operator);
        } else if (path == 7) {
            _doActivate();
            vm.warp(_get(id).tNoteDeadline);
            _doRefund(); // A10g
        } else if (path == 8) {
            // A refund after the notice, evidence, withhold, release.
            _doActivate();
            _doNotice();
            if (!a) vm.warp(_get(id).tCut); // B9d holds
            _doRefund();
            _doWithhold();
            _doEvidence();
            _doRelease(operator);
        } else if (path == 9) {
            // ... withhold, then the 60-day split.
            _doActivate();
            _doNotice();
            if (!a) vm.warp(_get(id).tCut);
            _doRefund();
            _doWithhold();
            _doSplit();
        } else if (path == 10) {
            // An abort, then the refund (A7b then A10d; B8 then B9f and the release).
            _doActivate();
            _doNotice();
            _doAbort();
            _doRefund();
            if (!a) _doRelease(operator);
        } else if (path == 11) {
            // A late abort (A7c), a held refund, released by the operator inside the hold.
            _doActivate();
            _doNotice();
            if (a) vm.warp(_get(id).tClaimOpen);
            _doAbort();
            _doRefund();
            _doRelease(operator);
        } else if (path == 12) {
            _doActivate();
            _doNotice();
            _doReady();
            _doClaim(); // A11a, B10a
        } else if (path == 13) {
            // The claimer misses its window (A10e free; B9e held).
            _doActivate();
            _doNotice();
            _doReady();
            vm.warp(_get(id).tClaimDeadline);
            _doRefund();
            if (!a) {
                vm.warp(_get(id).tRefund + 1800);
                _doRelease(taker);
            }
        } else if (path == 14) {
            // Ready, then an abort (A7d; B8), then the refund.
            _doActivate();
            _doNotice();
            _doReady();
            _doAbort();
            _doRefund();
            if (!a) _doRelease(operator);
        } else if (path == 15) {
            _doActivate();
            _doNotice();
            vm.warp(_get(id).tClaimOpen);
            _doClaim(); // A11b, B10b
        } else if (path == 16) {
            _doActivate();
            _doNotice();
            _doReady();
            vm.warp(_get(id).tFinal);
            _doClaim(); // A11c, B10c
        } else if (path == 17) {
            _doActivate();
            _doNotice();
            _doEvidence();
            vm.warp(uint256(_get(id).tFinal) + EXPIRY_SECS);
            _doRefund(); // A10f, B9g
        } else if (path == 18) {
            // Z1 by the watcher, Z2, then a normal claim.
            _doActivate();
            _doNotice();
            _doFreeze(watcherKey);
            _doReady();
            _doClaim();
        } else if (path == 19) {
            // Z1 by the locker, Z3 (A: held, withheld, split. B: free).
            _doActivate();
            _doNotice();
            _doFreeze(_locker(id));
            _doRefund();
            if (a) {
                _doWithhold();
                _doSplit();
            }
        } else if (path == 20) {
            // Z4: the claim at T_ff.
            _doActivate();
            _doNotice();
            _doFreeze(watcherKey);
            vm.warp(_tFf(id));
            _doClaim();
        } else if (path == 21) {
            // Z5, then the refund and the release at T_hold.
            _doActivate();
            _doNotice();
            _doFreeze(watcherKey);
            _doAbort();
            _doRefund();
            vm.warp(_get(id).tRefund + 1800);
            _doRelease(anyone);
        } else if (path == 22) {
            // B11, then the maker's owner address pulls the parked escrow.
            _doActivate();
            vm.warp(uint256(_get(id).tFinal) + EXPIRY_SECS);
            vm.prank(anyone);
            swap.expireUnnoticed(id);
            _after();
            vm.prank(makerOwner);
            swap.withdrawOwed(token, makerOwner);
            _after();
        } else if (path == 23) {
            // Z6: a frozen swap at the final deadline and at expiry.
            _doActivate();
            _doNotice();
            _doFreeze(watcherKey);
            vm.warp(uint256(_get(id).tFinal) + EXPIRY_SECS);
            _doRefund();
        } else if (path == 24) {
            // B9b: no notice by the deadline, the deposit held and returned at T_hold.
            _doActivate();
            vm.warp(_get(id).tNoteDeadline);
            _doRefund();
            vm.warp(_get(id).tRefund + 1800);
            _doRelease(anyone);
        } else if (path == 25) {
            // A claim whose payout address cannot receive, then `pushOwed` by a stranger.
            _doActivate();
            _doNotice();
            _doReady();
            _block(payoutTo, true);
            _doClaim();
            _block(payoutTo, false);
            vm.prank(anyone);
            swap.pushOwed(token, payoutTo);
            _after();
        } else if (path == 26) {
            // A refund the taker (A) or the operator (B) cannot receive, then `withdrawOwed`.
            _doActivate();
            _doNotice();
            address locker = a ? taker : operator;
            _block(locker, true);
            _doRefund();
            _block(locker, false);
            vm.prank(locker);
            swap.withdrawOwed(token, locker);
            _after();
            if (_get(id).state == HOLD) {
                vm.warp(_get(id).tRefund + 1800);
                _doRelease(anyone);
            }
        } else if (path == 27) {
            // A claim whose recipient cannot receive, pushed to it later.
            _doActivate();
            _doNotice();
            _doReady();
            address to = a ? payout : taker;
            _block(to, true);
            _doClaim();
            _block(to, false);
            vm.prank(anyone);
            swap.pushOwed(token, to);
            _after();
        } else if (path == 28) {
            // A claim to another payout address (B); in A the same claim by a stranger.
            _doActivate();
            _doNotice();
            vm.warp(_get(id).tClaimOpen);
            _doClaim();
        } else if (path == 29) {
            // The treasury pulls what a claim accrued.
            _doActivate();
            _doNotice();
            _doReady();
            _doClaim();
            vm.prank(treasury);
            swap.withdrawTreasury(token, treasury);
            _after();
        } else {
            revert("unknown path");
        }

        s = _get(id);
        // The end of every walk: DONE, or WITHHELD-then-released; nothing left open.
        assertEq(s.state, DONE, "every exit reaches its end");
        assertEq(_openValue(token), 0);
        assertEq(s.flags & 32, 0);
        assertEq(_bal(token, watcherKey), 0, "a watcher is never paid");
        assertEq(swap.owedOf(token, watcherKey), 0);
        return true;
    }

    function _run(address token_) internal {
        token = token_;
        vm.deal(watcherKey, 0);
        for (uint8 direction; direction < 2; ++direction) {
            for (uint256 path; path < PATHS; ++path) {
                bytes32 baseline;
                for (uint256 regime; regime < REGIMES; ++regime) {
                    uint256 snap = vm.snapshotState();
                    bool exists = _walk(path, direction, regime);
                    bytes32 print = exists ? _fingerprint() : bytes32(0);
                    vm.revertToState(snap);
                    if (!exists) break;
                    walked++;
                    if (regime == 0) {
                        baseline = print;
                    } else {
                        assertEq(
                            print,
                            baseline,
                            string.concat(
                                "path ",
                                vm.toString(path),
                                direction == 0 ? " A" : " B",
                                " under regime ",
                                vm.toString(regime),
                                ": an admin switch altered an exit"
                            )
                        );
                    }
                }
            }
        }
        // 30 paths, 3 of them direction A only and 3 direction B only, under 8 settings.
        assertEq(walked, (27 + 27) * REGIMES);
    }

    function test_everyExit_underEveryAdminSwitch_eth() public {
        _run(ETH);
    }

    function test_everyExit_underEveryAdminSwitch_usdc() public {
        _run(address(usdc));
    }

    /// The owner has no call that reaches a swap: its powers are upgrading and the caps.
    function test_ownerHasNoPowerOverASwap(bool usdc_, bool directionB) public {
        token = usdc_ ? address(usdc) : ETH;
        id = _swapIn(directionB ? 1 : 0, token, READY);
        uint256 secret = _claimerSecret(id);
        bytes32 before = keccak256(abi.encode(_get(id)));
        vm.startPrank(owner);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.abort(id);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.withhold(id, 0, 0);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.withdrawTreasury(token, owner);
        vm.expectRevert(IXmrSwap.NothingOwed.selector);
        swap.withdrawOwed(token, owner);
        vm.expectRevert(IXmrSwap.Unauthorized.selector);
        swap.freeze(id);
        swap.setCaps(token, 0, 0);
        swap.setCapsOn(true);
        vm.stopPrank();
        assertEq(keccak256(abi.encode(_get(id))), before);
        // A claim submitted by the owner pays the bound destination like anybody's.
        uint256 ownerBefore = _bal(token, owner);
        vm.prank(owner);
        swap.claim(id, secret);
        assertEq(_bal(token, owner), ownerBefore);
        assertEq(_get(id).state, DONE);
        // Nobody else can touch the caps, before or after.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, operator));
        swap.setCapsOn(false);
    }
}
