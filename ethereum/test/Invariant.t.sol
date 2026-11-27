// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {MockUSDC, Receiver} from "./utils/Mocks.sol";

/// Drives random swaps through random calls at random times, with recipients that randomly stop
/// being able to receive and an admin and a maker that randomly flip every switch they have
/// (caps to zero, the cap switch, the pause, the epochs, an ownership transfer). It owns a whole
/// world (proxy, token, maker, takers).
///
/// Every call on an existing swap is made twice: once in a copy of the world where the switches
/// are neutral (caps off, maker not paused), which is then rolled back, and once for real. The
/// two must agree on success and on the error: no switch blocks, delays or alters an exit.
contract Handler is Base {
    uint256 internal constant MAX_SWAPS = 24;
    uint256 internal constant N_ACCOUNTS = 8;

    bytes32[] public ids;
    mapping(bytes32 => uint256) public takerSecretOf;
    mapping(bytes32 => uint256) public makerSecretOf;
    address[3] public takers;
    address[N_ACCOUNTS] public accounts; // everyone a payout can be owed to, and the watcher
    address public payoutOther = makeAddr("payout other");
    address public nextOwner = makeAddr("next owner");
    uint256 internal shareCounter;

    /// Set when a call that carried a valid secret failed for any reason other than state or
    /// time: a payout problem must never make such a call fail.
    bool public secretCallBlocked;
    bytes4 public blockedWith;
    /// Set when a call on an existing swap behaved differently under the admin's and the maker's
    /// switches than with the switches neutral (invariant 3).
    bool public switchAlteredAnExit;
    bytes4 public alteredSelector;
    uint256 public claims;
    uint256 public refunds;
    uint256 public freezes;
    uint256 public parkedPayouts;
    uint256 public exitsCompared;
    uint256 public exitsUnderHostileSwitches;

    constructor() {
        setUp();
        takers = [makeAddr("taker 1"), makeAddr("taker 2"), makeAddr("taker 3")];
        accounts = [takers[0], takers[1], takers[2], payout, operator, makerOwner, payoutOther, watcherKey];
        for (uint256 i; i < 3; ++i) {
            vm.deal(takers[i], 1e30);
            usdc.mint(takers[i], 1e30);
            vm.prank(takers[i]);
            usdc.approve(address(swap), type(uint256).max);
        }
        vm.deal(watcherKey, 0);
    }

    function swapAddress() external view returns (XmrSwap) {
        return swap;
    }

    function token() external view returns (MockUSDC) {
        return usdc;
    }

    function makerOwnerAddress() external view returns (address) {
        return makerOwner;
    }

    function watcherAddress() external view returns (address) {
        return watcherKey;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function _pick(uint256 seed) internal view returns (bytes32) {
        return ids[seed % ids.length];
    }

    modifier some() {
        if (ids.length == 0) return;
        _;
    }

    // ------------------------------------------------------------------ the switches

    /// The owner sets the caps of one asset (often to zero) and flips the switch.
    function adminCaps(uint256 seed) external {
        uint128[4] memory values = [uint128(0), 0, 1e17, type(uint128).max];
        vm.startPrank(swap.owner());
        swap.setCaps(seed & 1 == 0 ? ETH : address(usdc), values[(seed >> 1) % 4], values[(seed >> 3) % 4]);
        swap.setCapsOn((seed >> 5) % 4 != 0);
        vm.stopPrank();
    }

    /// The maker pauses, unpauses and bumps its epochs.
    function makerSwitches(uint256 seed) external {
        vm.prank(seed & 1 == 0 ? makerOwner : operator);
        swap.setPaused((seed >> 1) & 1 == 0);
        if ((seed >> 2) & 1 == 0) {
            vm.prank(makerOwner);
            swap.bumpEpochs(true, true);
        }
    }

    /// An ownership transfer is started, and sometimes accepted.
    function ownership(uint256 seed) external {
        address current = swap.owner();
        address other = current == owner ? nextOwner : owner;
        vm.prank(current);
        swap.transferOwnership(other);
        if (seed & 1 == 0) {
            vm.prank(other);
            swap.acceptOwnership();
        }
    }

    /// Whether any switch is in a position that refuses new swaps.
    function _hostileNow() internal view returns (bool) {
        (bool on, uint128 maxSwapEth,,) = swap.capsOf(ETH);
        (, uint128 maxSwapUsdc,,) = swap.capsOf(address(usdc));
        return swap.getMaker(makerOwner).paused || (on && (maxSwapEth == 0 || maxSwapUsdc == 0));
    }

    /// A call on an existing swap, compared with the same call in a world whose switches are
    /// neutral. Returns the real result.
    function _exit(address from, uint256 value, bytes memory data) internal returns (bool ok, bytes memory ret) {
        uint256 snap = vm.snapshotState();
        vm.prank(swap.owner());
        swap.setCapsOn(false);
        if (swap.getMaker(makerOwner).paused) {
            vm.prank(makerOwner);
            swap.setPaused(false);
        }
        vm.prank(from);
        (bool neutralOk, bytes memory neutralRet) = address(swap).call{value: value}(data);
        vm.revertToState(snap);

        if (_hostileNow()) exitsUnderHostileSwitches++;
        vm.prank(from);
        (ok, ret) = address(swap).call{value: value}(data);
        exitsCompared++;
        if (ok != neutralOk || (!ok && keccak256(ret) != keccak256(neutralRet))) {
            switchAlteredAnExit = true;
            alteredSelector = bytes4(data);
        }
    }

    // ------------------------------------------------------------------ opening

    function open(uint256 seed, uint64 xmr, uint256 price, uint16 depBps) external {
        if (ids.length >= MAX_SWAPS) return;
        uint8 direction = uint8(seed & 1);
        address tok = seed & 2 == 0 ? ETH : address(usdc);
        xmr = uint64(bound(xmr, 1, 1e15));
        price = bound(price, 1e12, 1e20);
        takerSecret = _share(string.concat("taker share ", vm.toString(shareCounter++)));
        Open memory o = _open(direction, tok, xmr, price);
        o.q.depositBps = uint16(bound(depBps, 0, 500));
        // Half the quotes accept a watcher; in direction A the taker then names one.
        uint32[4] memory windows = [uint32(0), 0, 3_600, 86_400];
        o.q.freezeWindow = windows[(seed >> 12) % 4];
        o.sig = _signQuote(o.q);
        o.sender = takers[(seed >> 2) % 3];
        o.leafIndex = uint32((seed >> 8) % POOL);
        if (direction == 0 && o.q.freezeWindow != 0 && (seed >> 14) & 1 == 0) o.watcher = watcherKey;
        if (direction == 1 && (seed >> 15) & 1 == 0) o.payout = payoutOther;
        bytes32 id = _send(o);
        ids.push(id);
        takerSecretOf[id] = takerSecret;
        if (direction == 0) makerSecretOf[id] = makerSecrets[o.leafIndex];
    }

    // ------------------------------------------------------------------ calls on a swap

    function activate(uint256 seed) public some {
        bytes32 id = _pick(seed);
        IXmrSwap.Swap memory s = _get(id);
        if (s.direction == 0) {
            _exit(operator, 0, abi.encodeCall(IXmrSwap.approve, (id, s.openHash)));
            return;
        }
        uint256 secret = _share(string.concat("handler funding share ", vm.toString(shareCounter++)));
        (address k, address k2) = _twin(secret);
        address watcher = s.freezeSecs != 0 && seed & 4 == 0 ? watcherKey : address(0);
        (bool ok,) = _exit(
            operator,
            s.token == ETH ? s.amount : 0,
            abi.encodeCall(
                IXmrSwap.fund, (id, s.openHash, k, k2, _spendPub(secret), _view("maker view share"), watcher)
            )
        );
        if (ok) makerSecretOf[id] = secret;
    }

    function reject(uint256 seed, uint8 reason) external some {
        bytes32 id = _pick(seed);
        _exit(operator, 0, abi.encodeCall(IXmrSwap.reject, (id, _get(id).openHash, reason % 3)));
    }

    function cancelPending(uint256 seed) external some {
        bytes32 id = _pick(seed);
        _exit(seed & 1 == 0 ? session : _get(id).taker, 0, abi.encodeCall(IXmrSwap.cancelPending, (id)));
    }

    function expirePending(uint256 seed) public some {
        _exit(anyone, 0, abi.encodeCall(IXmrSwap.expirePending, (_pick(seed))));
    }

    function notice(uint256 seed) public some {
        bytes32 id = _pick(seed);
        address from = _get(id).direction == 0 ? operator : (seed & 1 == 0 ? session : _get(id).taker);
        _exit(from, 0, abi.encodeCall(IXmrSwap.postNotice, (id, _commitment(id), _ciphertext())));
    }

    function ready(uint256 seed) public some {
        bytes32 id = _pick(seed);
        _exit(_locker(id), 0, abi.encodeCall(IXmrSwap.setReady, (id)));
    }

    /// By the watcher, the locker, or a stranger.
    function freeze(uint256 seed) public some {
        bytes32 id = _pick(seed);
        address[3] memory who = [watcherKey, _locker(id), anyone];
        (bool ok,) = _exit(who[(seed >> 8) % 3], 0, abi.encodeCall(IXmrSwap.freeze, (id)));
        if (ok) freezes++;
    }

    function abort(uint256 seed) public some {
        bytes32 id = _pick(seed);
        _exit(_claimer(id), 0, abi.encodeCall(IXmrSwap.abort, (id)));
    }

    function refundUnnoticed(uint256 seed) external some {
        _exit(anyone, 0, abi.encodeCall(IXmrSwap.refundUnnoticed, (_pick(seed))));
    }

    function expireUnnoticed(uint256 seed) external some {
        _exit(anyone, 0, abi.encodeCall(IXmrSwap.expireUnnoticed, (_pick(seed))));
    }

    function refund(uint256 seed) public some {
        bytes32 id = _pick(seed);
        uint256 secret = _get(id).direction == 0 ? takerSecretOf[id] : makerSecretOf[id];
        if (_secretCall(abi.encodeCall(IXmrSwap.refund, (id, secret)), secret)) refunds++;
    }

    function claim(uint256 seed) public some {
        bytes32 id = _pick(seed);
        uint256 secret = _get(id).direction == 0 ? makerSecretOf[id] : takerSecretOf[id];
        if (_secretCall(abi.encodeCall(IXmrSwap.claim, (id, secret)), secret)) claims++;
    }

    /// A secret-bearing call with the right secret may fail only because of the state or the time.
    function _secretCall(bytes memory data, uint256 secret) internal returns (bool ok) {
        uint256 parkedBefore = _totalOwed();
        bytes memory ret;
        (ok, ret) = _exit(anyone, 0, data);
        if (ok) {
            if (_totalOwed() > parkedBefore) parkedPayouts++;
            return true;
        }
        bytes4 err = bytes4(ret);
        bool expected = err == IXmrSwap.BadState.selector || err == IXmrSwap.TooEarly.selector
            || err == IXmrSwap.TooLate.selector || (secret == 0 && err == IXmrSwap.BadSecret.selector);
        if (!expected) {
            secretCallBlocked = true;
            blockedWith = err;
        }
    }

    function _totalOwed() internal view returns (uint256 total) {
        for (uint256 i; i < N_ACCOUNTS; ++i) {
            total += swap.owedOf(ETH, accounts[i]) + swap.owedOf(address(usdc), accounts[i]);
        }
    }

    function releaseDeposit(uint256 seed) public some {
        _exit(seed & 1 == 0 ? operator : anyone, 0, abi.encodeCall(IXmrSwap.releaseDeposit, (_pick(seed))));
    }

    function withhold(uint256 seed) public some {
        bytes32 id = _pick(seed);
        IXmrSwap.Swap memory s = _get(id);
        bool evidence = s.direction == 0 && s.flags & 1 != 0;
        _exit(
            operator,
            0,
            abi.encodeCall(
                IXmrSwap.withhold, (id, evidence ? TXID : bytes32(0), evidence ? _claimerView() : bytes32(0))
            )
        );
    }

    function splitDeposit(uint256 seed) public some {
        _exit(anyone, 0, abi.encodeCall(IXmrSwap.splitDeposit, (_pick(seed))));
    }

    function withdrawOwed(uint256 seed) external {
        withdrawFor(seed % N_ACCOUNTS, (seed >> 8) & 1 == 1);
    }

    function withdrawFor(uint256 account, bool usdc_) public {
        address who = accounts[account];
        _exit(who, 0, abi.encodeCall(IXmrSwap.withdrawOwed, (usdc_ ? address(usdc) : ETH, who)));
    }

    /// Anyone delivers an account's parked balance to that account.
    function pushOwed(uint256 seed) external {
        address who = accounts[seed % N_ACCOUNTS];
        _exit(anyone, 0, abi.encodeCall(IXmrSwap.pushOwed, ((seed >> 8) & 1 == 1 ? address(usdc) : ETH, who)));
    }

    function withdrawTreasury(uint256 seed) public {
        address tok = seed & 1 == 0 ? ETH : address(usdc);
        _exit(treasury, 0, abi.encodeCall(IXmrSwap.withdrawTreasury, (tok, treasury)));
    }

    /// A step that fits the swap's state (with the wait it needs), so that runs reach the late
    /// states, the secret-bearing calls and the deposit sub-machine often. The purely random
    /// calls above cover everything else, including calls at the wrong time.
    function advance(uint256 seed) external some {
        bytes32 id = _pick(seed);
        IXmrSwap.Swap memory s = _get(id);
        uint256 choice = (seed >> 16) % 4;
        uint256 t = vm.getBlockTimestamp();
        if (s.state == PENDING) {
            if (t >= s.tPendingDeadline) expirePending(seed);
            else activate(seed);
        } else if (s.state == ACTIVE) {
            if (choice == 0) refund(seed);
            else notice(seed);
        } else if (s.state == NOTICED) {
            if (s.watcher != address(0) && (seed >> 20) & 1 == 0) {
                freeze(seed);
            } else if (choice == 0) {
                refund(seed);
            } else if (choice == 1) {
                if (t < s.tClaimOpen) vm.warp(s.tClaimOpen);
                claim(seed);
            } else if (choice == 2) {
                abort(seed);
            } else {
                uint256 readyAt = s.tNotice + uint256(s.depth) * 60;
                if (t < readyAt) vm.warp(readyAt);
                ready(seed);
            }
        } else if (s.state == FROZEN) {
            if (choice == 0) {
                refund(seed);
            } else if (choice == 1) {
                if (t < _tFf(id)) vm.warp(_tFf(id));
                claim(seed);
            } else if (choice == 2) {
                abort(seed);
            } else {
                uint256 readyAt = s.tNotice + uint256(s.depth) * 60;
                if (t < readyAt) vm.warp(readyAt);
                ready(seed);
            }
        } else if (s.state == READY) {
            if (choice == 0) {
                if (t < s.tClaimDeadline) vm.warp(s.tClaimDeadline);
                refund(seed);
            } else {
                claim(seed);
            }
        } else if (s.state == ABORTED_FREE || s.state == ABORTED_HOLD) {
            if (choice == 0) {
                if (t < s.tFinal) vm.warp(s.tFinal);
                claim(seed);
            } else {
                refund(seed);
            }
        } else if (s.state == HOLD) {
            if (choice == 0) {
                if (t < s.tRefund + 1800) vm.warp(s.tRefund + 1800);
                releaseDeposit(seed | 1);
            } else {
                withhold(seed);
            }
        } else if (s.state == WITHHELD) {
            if (choice == 0) {
                releaseDeposit(seed & ~uint256(1));
            } else {
                if (t < s.tRefund + 5_184_000) vm.warp(s.tRefund + 5_184_000);
                splitDeposit(seed);
            }
        }
    }

    /// Time steps on the scale of each window of the protocol; short ones are more frequent.
    function warp(uint256 seed) external {
        uint32[16] memory steps =
            [uint32(1), 1, 7, 13, 13, 60, 119, 600, 1799, 1800, 3900, 5400, 10800, 86_400, 604_800, 2_592_000];
        skip(steps[seed % steps.length]);
    }

    /// Recipients stop and resume being able to receive: a USDC blacklist entry, a USDC pause, or
    /// an account that rejects ETH.
    function toggleReceive(uint256 seed) external {
        address who = accounts[seed % 7]; // never the watcher: it must simply never be paid
        uint256 kind = (seed >> 8) % 3;
        if (kind == 0) {
            usdc.setBlacklisted(who, !usdc.blacklisted(who));
        } else if (kind == 1) {
            usdc.setPaused(!usdc.paused());
        } else if (who.code.length == 0) {
            vm.etch(who, address(new Receiver()).code);
            Receiver(payable(who)).set(Receiver.Mode.Reject, address(0), "");
        } else {
            vm.etch(who, "");
        }
    }

    // ------------------------------------------------------------------ the end of a run

    /// Everybody can receive again.
    function unblockAll() public {
        usdc.setPaused(false);
        for (uint256 i; i < N_ACCOUNTS; ++i) {
            usdc.setBlacklisted(accounts[i], false);
            if (accounts[i].code.length != 0) vm.etch(accounts[i], "");
        }
    }

    /// Every switch in its most hostile position, for good: every cap zero with the switch on, the
    /// maker paused, the epochs bumped, and ownership renounced so that nothing can be undone.
    function freezeEverythingHostile() external {
        address current = swap.owner();
        vm.startPrank(current);
        swap.setCaps(ETH, 0, 0);
        swap.setCaps(address(usdc), 0, 0);
        swap.setCapsOn(true);
        swap.renounceOwnership();
        vm.stopPrank();
        vm.startPrank(makerOwner);
        swap.setPaused(true);
        swap.bumpEpochs(true, true);
        vm.stopPrank();
    }

    /// Bring one swap to DONE by the exits that need nobody's cooperation but time and, for a
    /// keyed refund, the locker's own secret. Returns the calls it made; a call that fails is an
    /// exit that something blocked.
    function finish(uint256 index) external returns (uint256 calls) {
        bytes32 id = ids[index];
        for (uint256 round; round < 4; ++round) {
            IXmrSwap.Swap memory s = _get(id);
            uint256 t = vm.getBlockTimestamp();
            if (s.state == DONE) return calls;
            calls++;
            if (s.state == PENDING) {
                if (t < s.tPendingDeadline) vm.warp(s.tPendingDeadline);
                swap.expirePending(id);
            } else if (s.state == ACTIVE && s.direction == 0) {
                if (t < s.tNoteDeadline) vm.warp(s.tNoteDeadline);
                swap.refundUnnoticed(id);
            } else if (s.state == ACTIVE) {
                swap.refund(id, makerSecretOf[id]);
            } else if (s.state == HOLD) {
                if (t < s.tRefund + 1800) vm.warp(s.tRefund + 1800);
                swap.releaseDeposit(id);
            } else if (s.state == WITHHELD) {
                if (t < s.tRefund + 5_184_000) vm.warp(s.tRefund + 5_184_000);
                swap.splitDeposit(id);
            } else {
                // NOTICED, READY, FROZEN, ABORTED: the locker's refund at T_exp at the latest.
                uint256 tExp = uint256(s.tFinal) + 2_592_000;
                if (t < tExp) vm.warp(tExp);
                swap.refund(id, s.direction == 0 ? takerSecretOf[id] : makerSecretOf[id]);
            }
        }
        require(_get(id).state == DONE, "a swap did not reach its end");
    }

    /// Pull one parked balance, and the treasury's accrual.
    function drain(uint256 account, bool usdc_) external {
        address tok = usdc_ ? address(usdc) : ETH;
        address who = accounts[account];
        if (swap.owedOf(tok, who) != 0) swap.pushOwed(tok, who);
        if (account == 0 && swap.treasuryAccrued(tok) != 0) {
            vm.prank(treasury);
            swap.withdrawTreasury(tok, treasury);
        }
    }
}

/// Stateful invariants (SPEC 11.4, the Ethereum part).
contract InvariantTest is Test {
    Handler internal handler;
    XmrSwap internal swap;
    MockUSDC internal usdc;

    function setUp() public {
        handler = new Handler();
        swap = handler.swapAddress();
        usdc = handler.token();
        targetContract(address(handler));
        // `open` and `advance` are listed several times: they are what moves a run forward.
        bytes4[45] memory list = [
            Handler.open.selector,
            Handler.open.selector,
            Handler.open.selector,
            Handler.open.selector,
            Handler.open.selector,
            Handler.open.selector,
            Handler.open.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.advance.selector,
            Handler.activate.selector,
            Handler.reject.selector,
            Handler.cancelPending.selector,
            Handler.expirePending.selector,
            Handler.notice.selector,
            Handler.ready.selector,
            Handler.freeze.selector,
            Handler.abort.selector,
            Handler.refundUnnoticed.selector,
            Handler.expireUnnoticed.selector,
            Handler.refund.selector,
            Handler.claim.selector,
            Handler.releaseDeposit.selector,
            Handler.withhold.selector,
            Handler.splitDeposit.selector,
            Handler.withdrawOwed.selector,
            Handler.pushOwed.selector,
            Handler.withdrawTreasury.selector,
            Handler.warp.selector,
            Handler.toggleReceive.selector,
            Handler.adminCaps.selector,
            Handler.adminCaps.selector,
            Handler.makerSwitches.selector,
            Handler.ownership.selector
        ];
        bytes4[] memory selectors = new bytes4[](list.length);
        for (uint256 i; i < list.length; ++i) {
            selectors[i] = list[i];
        }
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _isOpen(uint8 state) internal pure returns (bool) {
        return (state >= 1 && state <= 6) || state == 10;
    }

    /// What the contract still owes on a swap, by state.
    function _obligation(IXmrSwap.Swap memory s) internal pure returns (uint256) {
        if (s.state == 1) return s.direction == 0 ? s.amount : s.deposit; // PENDING
        if (_isOpen(s.state)) return s.direction == 0 ? s.amount : s.amount + s.deposit;
        if (s.state == 7 || s.state == 8) return s.deposit; // HOLD, WITHHELD
        return 0; // DONE
    }

    /// Per asset: what the contract owes in all, the counted values of the open swaps, and the
    /// number of pending swaps.
    function _totals(address tok) internal view returns (uint256 owes, uint256 openValue, uint256 pending) {
        uint256 n = handler.count();
        for (uint256 i; i < n; ++i) {
            IXmrSwap.Swap memory s = swap.getSwap(handler.ids(i));
            assertTrue((s.state >= 1 && s.state <= 10), "a known state");
            if (s.state == 1) pending++;
            if (s.token != tok) continue;
            owes += _obligation(s);
            if (_isOpen(s.state)) openValue += s.direction == 0 ? s.amount : s.amount + s.deposit;
        }
        for (uint256 i; i < 8; ++i) {
            owes += swap.owedOf(tok, handler.accounts(i));
        }
        owes += swap.treasuryAccrued(tok);
    }

    /// The contract's balance of each asset is exactly what it owes: the stake of every open
    /// swap, every held deposit, every parked payout and the treasury's accrual. (At least the
    /// open value plus held deposits plus `owed` plus `treasuryAccrued`, SPEC 11.4; here it is
    /// equal, because a direction-B swap's amount is counted from `take` but escrowed at `fund`.)
    function invariant_escrowCoversObligations_eth() public view {
        (uint256 owes,,) = _totals(address(0));
        assertEq(address(swap).balance, owes, "ETH held == ETH owed");
    }

    function invariant_escrowCoversObligations_usdc() public view {
        (uint256 owes,,) = _totals(address(usdc));
        assertEq(usdc.balanceOf(address(swap)), owes, "USDC held == USDC owed");
    }

    /// `capsOf(token).openValue` is the sum of the counted values of the open swaps: added once at
    /// the open, subtracted once at the transition into HOLD or DONE, whatever the caps were.
    function invariant_openValueIsTheSumOfOpenSwaps() public view {
        (, uint256 wantEth,) = _totals(address(0));
        (, uint256 wantUsdc,) = _totals(address(usdc));
        (,,, uint128 eth) = swap.capsOf(address(0));
        (,,, uint128 usd) = swap.capsOf(address(usdc));
        assertEq(eth, wantEth, "ETH open value");
        assertEq(usd, wantUsdc, "USDC open value");
    }

    function invariant_openPendingCountsPendingSwaps() public view {
        (,, uint256 pending) = _totals(address(0));
        assertEq(swap.getMaker(handler.makerOwnerAddress()).openPending, pending);
    }

    /// A call that carries a valid secret never fails because of a payout.
    function invariant_secretCallsAreNeverBlocked() public view {
        assertFalse(handler.secretCallBlocked(), "a secret-bearing call failed for a reason other than state or time");
    }

    /// Invariant 3: with caps at zero, the maker paused, epochs bumped or an ownership transfer
    /// under way, every call on an existing swap gives the answer it gives with no switch set.
    function invariant_noSwitchAltersAnExit() public view {
        assertFalse(handler.switchAlteredAnExit(), "an admin or maker switch changed a call on an existing swap");
    }

    /// A watcher never receives funds and is never owed any.
    function invariant_theWatcherIsNeverPaid() public view {
        address watcher = handler.watcherAddress();
        assertEq(watcher.balance, 0);
        assertEq(usdc.balanceOf(watcher), 0);
        assertEq(swap.owedOf(address(0), watcher) + swap.owedOf(address(usdc), watcher), 0);
    }

    /// A settled swap holds a revealed secret exactly when a keyed call settled it, a deposit
    /// state that matches its outcome, and is counted exactly while it is open.
    function invariant_recordsAreConsistent() public view {
        uint256 n = handler.count();
        for (uint256 i; i < n; ++i) {
            IXmrSwap.Swap memory s = swap.getSwap(handler.ids(i));
            assertEq(s.revealed != 0, s.flags & 4 != 0);
            assertEq(s.state == 9, s.outcome != 0xff);
            assertEq(s.state == 9, s.tSettled != 0);
            assertEq(s.flags & 32 != 0, _isOpen(s.state), "counted exactly while open");
            if (s.state == 7) assertEq(s.depositState, 1);
            if (s.state == 8) assertEq(s.depositState, 2);
            if (s.depositState != 0) assertGt(s.deposit, 0);
            assertLe(s.deposit, s.amount * 500 / 10_000);
            if (s.state == 10) assertTrue(s.tFreeze != 0 && s.watcher != address(0) && s.freezeSecs != 0);
            if (s.tFreeze != 0) assertGe(s.tFreeze, s.tNotice);
            if (s.direction == 0) assertEq(s.payout, address(0));
            else assertTrue(s.payout != address(0));
        }
    }

    /// At the end of every run, with every switch in its most hostile position for good (every cap
    /// zero and on, the maker paused, epochs bumped, ownership renounced): every swap that was
    /// open still reaches its end, every parked payout and the treasury's accrual can be
    /// delivered, the open value returns to zero and the contract holds nothing.
    function afterInvariant() public {
        handler.unblockAll();
        handler.freezeEverythingHostile();
        uint256 n = handler.count();
        for (uint256 i; i < n; ++i) {
            handler.finish(i);
            assertEq(swap.getSwap(handler.ids(i)).state, 9, "every swap that was open reaches DONE");
        }
        for (uint256 i; i < 8; ++i) {
            handler.drain(i, false);
            handler.drain(i, true);
        }
        (,,, uint128 eth) = swap.capsOf(address(0));
        (,,, uint128 usd) = swap.capsOf(address(usdc));
        assertEq(uint256(eth) + usd, 0, "the open value is back at zero");
        assertEq(address(swap).balance, 0, "no ETH is left behind");
        assertEq(usdc.balanceOf(address(swap)), 0, "no USDC is left behind");
        assertEq(swap.treasuryAccrued(address(0)) + swap.treasuryAccrued(address(usdc)), 0);
        for (uint256 i; i < 8; ++i) {
            assertEq(swap.owedOf(address(0), handler.accounts(i)), 0);
            assertEq(swap.owedOf(address(usdc), handler.accounts(i)), 0);
        }
        invariant_theWatcherIsNeverPaid();
    }
}

/// Stateless fuzz of the same property: one swap, any path to its end, and the escrow is empty
/// again apart from the treasury's accrual.
contract ConservationFuzzTest is Base {
    function testFuzz_everySwapPaysOutInFull(
        bool usdc_,
        bool directionB,
        uint8 stateSeed,
        uint8 endSeed,
        uint64 xmr,
        uint16 depBps
    ) public {
        address token = usdc_ ? address(usdc) : ETH;
        uint8 direction = directionB ? 1 : 0;
        address[4] memory who = [taker, payout, operator, makerOwner];
        uint256 total = address(swap).balance + usdc.balanceOf(address(swap));
        for (uint256 i; i < 4; ++i) {
            total += _bal(token, who[i]);
        }

        // At least 10^-5 XMR, so that the amount is not zero at the USDC price.
        Open memory o = _open(direction, token, uint64(bound(xmr, 1e7, 1e15)), _defaultPrice(token));
        o.q.depositBps = uint16(bound(depBps, 0, 500));
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        uint8 target = uint8(bound(stateSeed, PENDING, ABORTED_HOLD));
        if (target == ABORTED_FREE && directionB) target = ABORTED_HOLD;
        _drive(id, target);
        _finish(id, endSeed);

        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.state, DONE, "every path ends");
        uint256 nowTotal = swap.treasuryAccrued(token);
        for (uint256 i; i < 4; ++i) {
            nowTotal += _bal(token, who[i]);
        }
        assertEq(nowTotal, total, "nothing created, nothing lost");
        assertEq(_bal(token, address(swap)), swap.treasuryAccrued(token), "the escrow holds only the accrual");
    }

    function _drive(bytes32 id, uint8 target) internal {
        if (target == PENDING) return;
        skip(12);
        _activate(id);
        if (target == ACTIVE) return;
        skip(90);
        _notice(id);
        if (target == NOTICED) return;
        if (target == ABORTED_FREE) return _abort(id);
        if (target == ABORTED_HOLD) {
            if (_get(id).direction == 0) skip(10800);
            return _abort(id);
        }
        skip(1200);
        _ready(id);
    }

    /// Finish the swap by one of the exits its state has.
    function _finish(bytes32 id, uint8 seed) internal {
        IXmrSwap.Swap memory s = _get(id);
        if (s.state == PENDING) {
            if (seed % 3 == 0) {
                vm.prank(taker);
                swap.cancelPending(id);
            } else if (seed % 3 == 1) {
                vm.prank(operator);
                swap.reject(id, s.openHash, seed % 2);
            } else {
                skip(120);
                swap.expirePending(id);
            }
            return;
        }
        bool wantClaim = seed & 1 == 1 && s.state != ACTIVE;
        if (wantClaim) {
            if (s.state == NOTICED) vm.warp(s.tClaimOpen);
            if (s.state == ABORTED_FREE || s.state == ABORTED_HOLD) vm.warp(s.tFinal);
            _claim(id);
            return;
        }
        if (s.state == READY) vm.warp(s.tClaimDeadline);
        if (s.state == ACTIVE && seed & 2 != 0) vm.warp(s.tNoteDeadline);
        if (s.state == NOTICED && seed & 4 != 0 && s.direction == 1) vm.warp(s.tCut);
        _refund(id);
        s = _get(id);
        if (s.state != HOLD) return;
        if (seed & 8 == 0) {
            skip(1800);
            swap.releaseDeposit(id);
            return;
        }
        bool evidence = s.direction == 0 && s.flags & 1 != 0;
        vm.prank(operator);
        swap.withhold(id, evidence ? TXID : bytes32(0), evidence ? _claimerView() : bytes32(0));
        if (seed & 16 == 0) {
            vm.prank(operator);
            swap.releaseDeposit(id);
        } else {
            skip(5_184_000);
            swap.splitDeposit(id);
        }
    }
}
