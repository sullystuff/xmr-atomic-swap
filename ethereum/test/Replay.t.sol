// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {XmrSwapSeeder} from "./utils/Mocks.sol";

/// Replays every row and every sequence of `interfaces/vectors/transitions.json` whose chain is
/// `ethereum` against the real contract, once with ETH and once with USDC as the asset. Every row
/// and every step is compared exactly as written; nothing is special-cased.
///
/// The file holds one array element per line, so it is read line by line.
contract ReplayTest is Base {
    string internal constant FILE = "../interfaces/vectors/transitions.json";

    address internal filler = makeAddr("filler");
    address internal token;
    bytes32 internal id;
    Open internal o;

    /// The file's own count of Ethereum rows and sequences, read from its `summary` line.
    string internal summary;
    uint256 internal rowsOk;
    uint256 internal rowsRejected;
    uint256 internal sequences;
    uint256 internal sequenceSteps;

    /// What a step may change, read before and after it.
    struct Snap {
        uint256[4] bal; // taker, payout, operator, makerOwner
        uint256[4] owed;
        uint256 accrued;
        uint256 escrow;
        uint256 volume;
        uint256 withheld;
        IXmrSwap.Maker maker;
    }

    struct Call {
        address from;
        uint256 value;
        bytes data;
        string name;
        string caller;
    }

    function setUp() public override {
        super.setUp();
        vm.deal(filler, 1e30);
        usdc.mint(filler, 1e30);
        vm.prank(filler);
        usdc.approve(address(swap), type(uint256).max);
    }

    // ------------------------------------------------------------------ the four replays

    function test_replay_rows_eth() public {
        token = ETH;
        _replayRows();
    }

    function test_replay_rows_usdc() public {
        token = address(usdc);
        _replayRows();
    }

    function test_replay_sequences_eth() public {
        token = ETH;
        _replaySequences();
    }

    function test_replay_sequences_usdc() public {
        token = address(usdc);
        _replaySequences();
    }

    function _replayRows() internal {
        while (true) {
            string memory l = vm.readLine(FILE);
            if (bytes(l).length == 0) break;
            if (_startsWith(l, '"summary":')) summary = string.concat("{", _stripComma(l), "}");
            if (!_startsWith(l, '{"case":')) continue;
            l = _stripComma(l);
            if (!_eq(vm.parseJsonString(l, ".chain"), "ethereum")) continue;
            uint256 snap = vm.snapshotState();
            _row(l);
            vm.revertToState(snap);
            // Counters live outside the snapshot.
            if (vm.parseJsonBool(l, ".ok")) rowsOk++;
            else rowsRejected++;
        }
        vm.closeFile(FILE);
        // The summary block of the file.
        assertEq(rowsOk + rowsRejected, vm.parseJsonUint(summary, ".summary.ethereum.rows"), "ethereum rows replayed");
        assertEq(rowsRejected, vm.parseJsonUint(summary, ".summary.ethereum.rows_rejected"), "ethereum rows rejected");
        assertEq(rowsOk + rowsRejected, 399);
        assertEq(rowsRejected, 191);
    }

    function _replaySequences() internal {
        while (true) {
            string memory l = vm.readLine(FILE);
            if (bytes(l).length == 0) break;
            if (_startsWith(l, '"summary":')) summary = string.concat("{", _stripComma(l), "}");
            if (!_startsWith(l, '{"about":')) continue;
            l = _stripComma(l);
            if (!_eq(vm.parseJsonString(l, ".chain"), "ethereum")) continue;
            uint256 snap = vm.snapshotState();
            uint256 steps = _sequence(l);
            vm.revertToState(snap);
            sequences++;
            sequenceSteps += steps;
        }
        vm.closeFile(FILE);
        assertEq(sequences, vm.parseJsonUint(summary, ".summary.ethereum.sequences"), "ethereum sequences replayed");
        assertEq(sequences, 182);
        assertGt(sequenceSteps, 800);
    }

    // ------------------------------------------------------------------ one row, one sequence

    /// "Start from no swap. Run `open` by the taker wallet at `open.at`, then each `setup` step at
    /// its `at`, check the swap equals `from`, then run `step` at `step.at` and compare with
    /// `step.expect`."
    function _row(string memory l) internal {
        if (vm.keyExistsJson(l, ".open")) {
            _must(l, ".open");
            for (uint256 i;; ++i) {
                string memory p = string.concat(".setup[", vm.toString(i), "]");
                if (!vm.keyExistsJson(l, p)) break;
                _must(l, p);
            }
            _checkSwap(l, ".from", "from");
        }
        _step(l, ".step", false);
    }

    /// "Start the maker record at `initial_maker`. Run every step at its `at`. A step with
    /// `expect.ok == false` must fail with `expect.error` and change nothing."
    function _sequence(string memory l) internal returns (uint256 steps) {
        _seedMaker(l);
        for (;; ++steps) {
            string memory p = string.concat(".steps[", vm.toString(steps), "]");
            if (!vm.keyExistsJson(l, p)) break;
            _step(l, p, true);
        }
        _checkSwap(l, ".final.swap", "final");
        _checkMaker(l, ".final.maker", "final");
    }

    /// The saturation sequence starts with counters at their maxima. The proxy is upgraded to a
    /// seeding implementation, seeded, and upgraded back to the implementation under test.
    function _seedMaker(string memory l) internal {
        uint256[] memory c = vm.parseJsonUintArray(l, ".initial_maker.counters");
        uint256 sum = vm.parseJsonUint(l, ".initial_maker.response_secs_sum");
        uint256 volume = vm.parseJsonUint(l, ".initial_maker.volume");
        uint256 withheld = vm.parseJsonUint(l, ".initial_maker.withheld_volume");
        assertEq(vm.parseJsonUint(l, ".initial_maker.open_pending"), 0, "initial open_pending");
        bool zero = sum == 0 && volume == 0 && withheld == 0;
        uint32[40] memory counters;
        for (uint256 i; i < 40; ++i) {
            counters[i] = uint32(c[i]);
            if (c[i] != 0) zero = false;
        }
        if (zero) return;
        XmrSwapSeeder seeder = new XmrSwapSeeder();
        vm.startPrank(owner);
        swap.upgradeToAndCall(address(seeder), "");
        XmrSwapSeeder(address(swap))
            .seedMaker(makerOwner, token, counters, uint64(sum), uint128(volume), uint128(withheld));
        swap.upgradeToAndCall(address(impl), "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ steps

    /// A step that must succeed (the opening and the set-up of a row).
    function _must(string memory l, string memory p) internal {
        _prepare(l, p);
        Call memory c = _encode(l, p);
        vm.prank(c.from);
        (bool ok, bytes memory ret) = address(swap).call{value: c.value}(c.data);
        if (!ok) {
            emit log_named_string("set-up step failed", string.concat(_label(l), " ", p));
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        if (_isOpen(c.name)) id = _id(o);
    }

    /// A step with an expectation.
    function _step(string memory l, string memory p, bool inSequence) internal {
        _prepare(l, p);
        Call memory c = _encode(l, p);
        string memory e = string.concat(p, ".expect");
        bool expectOk = vm.parseJsonBool(l, string.concat(e, ".ok"));
        string memory what = string.concat(_label(l), " ", p, " ", c.name);

        Snap memory pre = _snap();
        bytes32 before = _fingerprint();
        vm.prank(c.from);
        (bool ok, bytes memory ret) = address(swap).call{value: c.value}(c.data);

        if (!expectOk) {
            string memory err = vm.parseJsonString(l, string.concat(e, ".error"));
            assertFalse(ok, string.concat(what, ": must fail with ", err));
            assertEq(ret.length, 4, string.concat(what, ": custom error expected"));
            assertEq(bytes4(ret), _selector(err), string.concat(what, ": error is not ", err));
            assertEq(_fingerprint(), before, string.concat(what, ": a rejected call changed state"));
            return;
        }
        if (!ok) {
            emit log_named_string("step failed", what);
            emit log_named_bytes("revert data", ret);
            fail();
            return;
        }
        if (_isOpen(c.name)) id = _id(o);
        _checkEffects(l, e, c, pre, what, inSequence);
    }

    /// Clock, pay-or-park environment and the maker's open-pending count for a step.
    function _prepare(string memory l, string memory p) internal {
        vm.warp(vm.parseJsonUint(l, string.concat(p, ".at")));
        string memory env = string.concat(p, ".env");
        _setReceive(taker, vm.parseJsonBool(l, string.concat(env, ".taker_can_receive")));
        bool makerCan = vm.parseJsonBool(l, string.concat(env, ".maker_can_receive"));
        _setReceive(payout, makerCan);
        _setReceive(operator, makerCan);
        assertTrue(vm.parseJsonBool(l, string.concat(env, ".treasury_can_receive")), "treasury accrual cannot fail");
        string memory call = vm.parseJsonString(l, string.concat(p, ".call"));
        if (_isOpen(call)) {
            uint256 want = vm.parseJsonUint(l, string.concat(env, ".open_pending"));
            uint8 direction = _eq(call, "lock") ? 0 : 1;
            for (uint256 have = swap.getMaker(makerOwner).openPending; have < want; ++have) {
                // One piconero at a price of 10^12: the smallest swap there is.
                Open memory f = _open(direction, token, 1, 1e12);
                f.sender = filler;
                _send(f);
            }
        }
    }

    /// Make `who` able or unable to receive the asset. ETH: code that reverts on any call.
    /// USDC: the blacklist.
    function _setReceive(address who, bool can) internal {
        if (token == ETH) {
            if (can && who.code.length != 0) vm.etch(who, "");
            if (!can) vm.etch(who, hex"fe");
        } else if (usdc.blacklisted(who) == can) {
            usdc.setBlacklisted(who, !can);
        }
    }

    function _who(string memory role) internal view returns (address) {
        if (_eq(role, "taker")) return taker;
        if (_eq(role, "session")) return session;
        if (_eq(role, "operator")) return operator;
        if (_eq(role, "anyone")) return anyone;
        if (_eq(role, "owner")) {
            // "Ethereum: the account the parked payout is owed to".
            if (swap.owedOf(token, payout) != 0) return payout;
            if (swap.owedOf(token, operator) != 0) return operator;
            return makerOwner;
        }
        revert(string.concat("unknown caller ", role));
    }

    /// Translate a vector step into a contract call.
    function _encode(string memory l, string memory p) internal returns (Call memory c) {
        c.name = vm.parseJsonString(l, string.concat(p, ".call"));
        c.caller = vm.parseJsonString(l, string.concat(p, ".caller"));
        c.from = _who(c.caller);
        string memory a = string.concat(p, ".args");
        bytes32 h = keccak256(bytes(c.name));

        if (_isOpen(c.name)) {
            c = _encodeOpen(l, a, c);
        } else if (h == keccak256("approve")) {
            c.data = abi.encodeCall(IXmrSwap.approve, (id, _expectedOpen(l, a)));
        } else if (h == keccak256("fund")) {
            IXmrSwap.Swap memory s = _get(id);
            (address k, address k2) = _twin(_fundSecret());
            c.value = token == ETH ? s.amount : 0;
            c.data = abi.encodeCall(
                IXmrSwap.fund, (id, _expectedOpen(l, a), k, k2, _spendPub(_fundSecret()), _view("maker view share"))
            );
        } else if (h == keccak256("reject")) {
            uint8 reason = uint8(vm.parseJsonUint(l, string.concat(a, ".reason")));
            c.data = abi.encodeCall(IXmrSwap.reject, (id, _expectedOpen(l, a), reason));
        } else if (h == keccak256("cancel_pending")) {
            c.data = abi.encodeCall(IXmrSwap.cancelPending, (id));
        } else if (h == keccak256("expire_pending")) {
            c.data = abi.encodeCall(IXmrSwap.expirePending, (id));
        } else if (h == keccak256("post_notice")) {
            c.data = abi.encodeCall(IXmrSwap.postNotice, (id, _commitment(id), _ciphertext()));
        } else if (h == keccak256("set_ready")) {
            c.data = abi.encodeCall(IXmrSwap.setReady, (id));
        } else if (h == keccak256("abort")) {
            c.data = abi.encodeCall(IXmrSwap.abort, (id));
        } else if (h == keccak256("refund_unnoticed")) {
            c.data = abi.encodeCall(IXmrSwap.refundUnnoticed, (id));
        } else if (h == keccak256("expire_unnoticed")) {
            c.data = abi.encodeCall(IXmrSwap.expireUnnoticed, (id));
        } else if (h == keccak256("refund")) {
            // "secret_ok false: any other scalar in range".
            uint256 secret = vm.parseJsonBool(l, string.concat(a, ".secret_ok"))
                ? (_get(id).direction == 0 ? takerSecret : _fundSecret())
                : _share("some other scalar");
            c.data = abi.encodeCall(IXmrSwap.refund, (id, secret));
        } else if (h == keccak256("claim")) {
            uint256 secret = vm.parseJsonBool(l, string.concat(a, ".secret_ok"))
                ? (_get(id).direction == 0 ? makerSecrets[0] : takerSecret)
                : _share("some other scalar");
            c.data = abi.encodeCall(IXmrSwap.claim, (id, secret));
        } else if (h == keccak256("release_deposit")) {
            c.data = abi.encodeCall(IXmrSwap.releaseDeposit, (id));
        } else if (h == keccak256("withhold")) {
            (bytes32 txid, bytes32 v) = _evidence(vm.parseJsonString(l, string.concat(a, ".evidence")));
            c.data = abi.encodeCall(IXmrSwap.withhold, (id, txid, v));
        } else if (h == keccak256("split_deposit")) {
            c.data = abi.encodeCall(IXmrSwap.splitDeposit, (id));
        } else if (h == keccak256("publish_evidence")) {
            (bytes32 txid, bytes32 v) =
                _evidence(vm.parseJsonBool(l, string.concat(a, ".opens")) ? "opens" : "mismatch");
            c.data = abi.encodeCall(IXmrSwap.publishEvidence, (id, txid, v));
        } else if (h == keccak256("withdraw_owed")) {
            c.data = abi.encodeCall(IXmrSwap.withdrawOwed, (token, c.from));
        } else {
            revert(string.concat("unknown call ", c.name));
        }
    }

    /// "absent: none (Ethereum zeros). opens: the notice opening. mismatch: any other pair".
    function _evidence(string memory kind) internal pure returns (bytes32 txid, bytes32 v) {
        if (_eq(kind, "opens")) return (TXID, _claimerView());
        if (_eq(kind, "mismatch")) return (keccak256("another txid"), _claimerView());
        require(_eq(kind, "absent"), "unknown evidence");
    }

    /// "open_ok true: expected_open is the swap's open hash. false: any other 32 bytes".
    function _expectedOpen(string memory l, string memory a) internal view returns (bytes32) {
        bytes32 h = _get(id).openHash;
        return vm.parseJsonBool(l, string.concat(a, ".open_ok")) ? h : keccak256(abi.encode(h));
    }

    /// The opening: the row's `xmr` at the price that gives exactly the row's `amount`.
    function _encodeOpen(string memory l, string memory a, Call memory c) internal returns (Call memory) {
        uint8 direction = _eq(c.name, "lock") ? 0 : 1;
        assertEq(vm.parseJsonString(l, string.concat(a, ".direction")), direction == 0 ? "A" : "B");
        uint256 amount = vm.parseJsonUint(l, string.concat(a, ".amount"));
        uint256 xmr = vm.parseJsonUint(l, string.concat(a, ".xmr"));
        // amount = xmr * price / 10^12, exactly. With no XMR there is no price to derive; any will do.
        uint256 price = amount;
        if (xmr != 0) {
            assertEq(amount * 1e12 % xmr, 0, "the row's amount is not a whole price");
            price = amount * 1e12 / xmr;
        }
        Open memory n = _open(direction, token, uint64(xmr), price);
        // The quote sets no size floor: a refusal of a zero size is the contract's own rule.
        n.q.minXmr = 0;
        uint256 offerMode = vm.parseJsonUint(l, string.concat(a, ".offer_mode"));
        // Offer mode 3 is a taker-bound quote; 0 to 2 are the quote's approval mode.
        if (offerMode == 3) n.q.taker = taker;
        else n.q.approvalMode = uint8(offerMode);
        n.q.depositBps = uint16(vm.parseJsonUint(l, string.concat(a, ".dep_bps")));
        n.q.depth[0] = uint8(vm.parseJsonUint(l, string.concat(a, ".depth")));
        n.q.approvalWindow = uint32(vm.parseJsonUint(l, string.concat(a, ".w_a")));
        n.q.noticeWindow = uint32(vm.parseJsonUint(l, string.concat(a, ".w_n")));
        n.q.claimDelay = uint32(vm.parseJsonUint(l, string.concat(a, ".d_c")));
        n.q.claimWindow = uint32(vm.parseJsonUint(l, string.concat(a, ".w_c")));
        n.q.finalWindow = uint32(vm.parseJsonUint(l, string.concat(a, ".w_f")));
        n.sig = _signQuote(n.q);
        n.sender = c.from;
        if (vm.parseJsonBool(l, string.concat(a, ".approval"))) {
            n.a = _approval(c.from);
            n.approvalSig = _signApproval(n.a);
        }
        o = n;
        (, uint256 stake) = _stake(n);
        c.value = token == ETH ? stake : 0;
        if (direction == 0) {
            c.data = abi.encodeCall(
                IXmrSwap.lock,
                (n.q, n.sig, n.xmr, n.limit, n.nonce, n.sessionKey, n.budget, n.tk, _leaf(0), n.a, n.approvalSig)
            );
        } else {
            c.data = abi.encodeCall(
                IXmrSwap.take, (n.q, n.sig, n.xmr, n.limit, n.nonce, n.sessionKey, n.budget, n.tk, n.a, n.approvalSig)
            );
        }
        return c;
    }

    // ------------------------------------------------------------------ expectations

    function _snap() internal view returns (Snap memory s) {
        address[4] memory who = [taker, payout, operator, makerOwner];
        for (uint256 i; i < 4; ++i) {
            s.bal[i] = _bal(token, who[i]);
            s.owed[i] = swap.owedOf(token, who[i]);
        }
        s.accrued = swap.treasuryAccrued(token);
        s.escrow = _bal(token, address(swap));
        (s.volume, s.withheld) = swap.volumeOf(makerOwner, token);
        s.maker = swap.getMaker(makerOwner);
    }

    /// Everything a rejected call must leave untouched.
    function _fingerprint() internal view returns (bytes32) {
        return keccak256(abi.encode(_snap(), _get(id), _get(_id(o)), _bal(token, session), _bal(token, anyone)));
    }

    function _checkEffects(
        string memory l,
        string memory e,
        Call memory c,
        Snap memory pre,
        string memory what,
        bool inSequence
    ) internal view {
        Snap memory post = _snap();
        _checkSwap(l, string.concat(e, ".swap"), what);
        assertEq(
            _stateName(_get(id).state),
            vm.parseJsonString(l, string.concat(e, ".state")),
            string.concat(what, ": state")
        );

        // Payouts: expected change of every balance and of every parked amount.
        int256[4] memory dBal;
        int256[4] memory dOwed;
        uint256 accrued;
        uint256 left; // what left the escrow
        uint256 escrowIn = vm.parseJsonUint(l, string.concat(e, ".escrow_in"));
        if (escrowIn != 0) {
            // lock, take: the taker pays. fund: the operator pays.
            dBal[_eq(c.name, "fund") ? 2 : 0] -= int256(escrowIn);
        }
        for (uint256 i;; ++i) {
            string memory pp = string.concat(e, ".payouts[", vm.toString(i), "]");
            if (!vm.keyExistsJson(l, pp)) break;
            uint256 amount = vm.parseJsonUint(l, string.concat(pp, ".amount"));
            assertGt(amount, 0, string.concat(what, ": a payout of zero is absent"));
            bool parked = vm.parseJsonBool(l, string.concat(pp, ".parked"));
            string memory to = vm.parseJsonString(l, string.concat(pp, ".to"));
            if (_eq(to, "treasury")) {
                // "On Ethereum the treasury share only increments treasuryAccrued."
                assertFalse(parked, what);
                accrued += amount;
                continue;
            }
            uint256 idx = _eq(to, "taker") ? 0 : _makerAccount(c);
            if (_eq(c.name, "withdraw_owed")) {
                dOwed[idx] -= int256(amount);
                dBal[idx] += int256(amount);
                left += amount;
            } else if (parked) {
                dOwed[idx] += int256(amount);
            } else {
                dBal[idx] += int256(amount);
                left += amount;
            }
        }
        string[4] memory names = ["taker", "payout", "operator", "makerOwner"];
        for (uint256 i; i < 4; ++i) {
            assertEq(int256(post.bal[i]) - int256(pre.bal[i]), dBal[i], string.concat(what, ": balance of ", names[i]));
            assertEq(
                int256(post.owed[i]) - int256(pre.owed[i]), dOwed[i], string.concat(what, ": parked for ", names[i])
            );
        }
        assertEq(post.accrued - pre.accrued, accrued, string.concat(what, ": treasury accrual"));
        assertEq(post.escrow + left, pre.escrow + escrowIn, string.concat(what, ": escrow balance"));

        // Exactly one counter moves (or none), saturating.
        string memory counterName = vm.parseJsonString(l, string.concat(e, ".counter_name"));
        uint256 counter = _eq(counterName, "null") ? 255 : vm.parseJsonUint(l, string.concat(e, ".counter"));
        for (uint256 i; i < 40; ++i) {
            uint256 was = pre.maker.counters[i];
            uint256 want = i == counter && was != type(uint32).max ? was + 1 : was;
            assertEq(post.maker.counters[i], want, string.concat(what, ": counter ", vm.toString(i)));
        }
        assertEq(
            int256(uint256(post.maker.openPending)) - int256(uint256(pre.maker.openPending)),
            vm.parseJsonInt(l, string.concat(e, ".open_pending")),
            string.concat(what, ": open_pending")
        );
        uint256 volume = vm.parseJsonUint(l, string.concat(e, ".volume"));
        uint256 withheld = vm.parseJsonUint(l, string.concat(e, ".withheld_volume"));
        string memory rs = string.concat(e, ".response_secs");
        uint256 responseSecs = _eq(vm.parseJsonString(l, rs), "null") ? 0 : vm.parseJsonUint(l, rs);
        if (inSequence) {
            // Absolute values, which also cover saturation.
            _checkMaker(l, string.concat(e, ".maker"), what);
        } else {
            assertEq(post.volume - pre.volume, volume, string.concat(what, ": volume"));
            assertEq(post.withheld - pre.withheld, withheld, string.concat(what, ": withheld volume"));
            assertEq(
                post.maker.responseSecsSum - pre.maker.responseSecsSum,
                responseSecs,
                string.concat(what, ": response seconds")
            );
        }
    }

    /// Which account stands for the model's "maker" destination in this call.
    function _makerAccount(Call memory c) internal view returns (uint256) {
        bytes32 h = keccak256(bytes(c.name));
        if (h == keccak256("claim")) return 1; // the payout address
        if (h == keccak256("refund")) return 2; // the current operator
        if (h == keccak256("expire_unnoticed")) return 3; // parked for the maker's owner address
        if (h == keccak256("withdraw_owed")) {
            return c.from == payout ? 1 : (c.from == operator ? 2 : 3);
        }
        revert(string.concat("no maker payout expected in ", c.name));
    }

    function _checkSwap(string memory l, string memory p, string memory what) internal view {
        IXmrSwap.Swap memory s = _get(id);
        what = string.concat(what, " swap.");
        assertEq(s.amount, _u(l, p, ".amount"), string.concat(what, "amount"));
        assertEq(s.deposit, _u(l, p, ".deposit"), string.concat(what, "deposit"));
        assertEq(s.claimDelay, _u(l, p, ".d_c"), string.concat(what, "d_c"));
        assertEq(s.claimWindow, _u(l, p, ".w_c"), string.concat(what, "w_c"));
        assertEq(s.noticeWindow, _u(l, p, ".w_n"), string.concat(what, "w_n"));
        assertEq(s.depositState, _u(l, p, ".deposit_state"), string.concat(what, "deposit_state"));
        assertEq(s.depth, _u(l, p, ".depth"), string.concat(what, "depth"));
        assertEq(s.direction, _eq(vm.parseJsonString(l, string.concat(p, ".direction")), "A") ? 0 : 1, what);
        assertEq(_u(l, p, ".fee_bps"), 5, string.concat(what, "fee_bps"));
        assertEq(s.flags, _u(l, p, ".flags"), string.concat(what, "flags"));
        assertEq(s.mode, _u(l, p, ".mode"), string.concat(what, "mode"));
        assertEq(s.outcome, _u(l, p, ".outcome"), string.concat(what, "outcome"));
        assertEq(s.state, _u(l, p, ".state_code"), string.concat(what, "state_code"));
        assertEq(s.tLock, _u(l, p, ".t_lock"), string.concat(what, "t_lock"));
        assertEq(s.tPendingDeadline, _u(l, p, ".t_pending_deadline"), string.concat(what, "t_pending_deadline"));
        assertEq(s.tActive, _u(l, p, ".t_active"), string.concat(what, "t_active"));
        assertEq(s.tNoteDeadline, _u(l, p, ".t_note_deadline"), string.concat(what, "t_note_deadline"));
        assertEq(s.tNotice, _u(l, p, ".t_notice"), string.concat(what, "t_notice"));
        assertEq(s.tCut, _u(l, p, ".t_cut"), string.concat(what, "t_cut"));
        assertEq(s.tClaimOpen, _u(l, p, ".t_claim_open"), string.concat(what, "t_claim_open"));
        assertEq(s.tReady, _u(l, p, ".t_ready"), string.concat(what, "t_ready"));
        assertEq(s.tClaimDeadline, _u(l, p, ".t_claim_deadline"), string.concat(what, "t_claim_deadline"));
        assertEq(s.tFinal, _u(l, p, ".t_final"), string.concat(what, "t_final"));
        assertEq(s.tRefund, _u(l, p, ".t_refund"), string.concat(what, "t_refund"));
        assertEq(s.tSettled, _u(l, p, ".t_settled"), string.concat(what, "t_settled"));
        assertEq(swap.owedOf(token, taker), _u(l, p, ".owed_taker"), string.concat(what, "owed_taker"));
        assertEq(
            swap.owedOf(token, payout) + swap.owedOf(token, operator) + swap.owedOf(token, makerOwner),
            _u(l, p, ".owed_maker"),
            string.concat(what, "owed_maker")
        );
        assertEq(_u(l, p, ".owed_treasury"), 0, string.concat(what, "owed_treasury"));
        // Bit 2 of flags: a secret is on record, and it is kept in storage.
        assertEq(s.revealed != 0, s.flags & 4 != 0, string.concat(what, "revealed"));
    }

    function _checkMaker(string memory l, string memory p, string memory what) internal view {
        IXmrSwap.Maker memory m = swap.getMaker(makerOwner);
        uint256[] memory c = vm.parseJsonUintArray(l, string.concat(p, ".counters"));
        assertEq(c.length, 40, what);
        uint32[40] memory viaView = swap.counters(makerOwner);
        for (uint256 i; i < 40; ++i) {
            assertEq(m.counters[i], c[i], string.concat(what, ": maker counter ", vm.toString(i)));
            assertEq(viaView[i], c[i], what);
        }
        assertEq(m.openPending, _u(l, p, ".open_pending"), string.concat(what, ": maker open_pending"));
        assertEq(m.responseSecsSum, _u(l, p, ".response_secs_sum"), string.concat(what, ": maker response_secs_sum"));
        (uint256 volume, uint256 withheld) = swap.volumeOf(makerOwner, token);
        assertEq(volume, _u(l, p, ".volume"), string.concat(what, ": maker volume"));
        assertEq(withheld, _u(l, p, ".withheld_volume"), string.concat(what, ": maker withheld_volume"));
    }

    // ------------------------------------------------------------------ small helpers

    function _u(string memory l, string memory p, string memory k) internal pure returns (uint256) {
        return vm.parseJsonUint(l, string.concat(p, k));
    }

    function _label(string memory l) internal view returns (string memory) {
        if (vm.keyExistsJson(l, ".name")) return vm.parseJsonString(l, ".name");
        return string.concat(
            vm.parseJsonString(l, ".id"),
            " ",
            vm.parseJsonString(l, ".direction"),
            " [",
            vm.parseJsonString(l, ".case"),
            "]"
        );
    }

    function _isOpen(string memory call) internal pure returns (bool) {
        return _eq(call, "lock") || _eq(call, "take");
    }

    function _stateName(uint8 state) internal pure returns (string memory) {
        string[10] memory n = [
            "NONE", "PENDING", "ACTIVE", "NOTICED", "READY", "ABORTED_FREE", "ABORTED_HOLD", "HOLD", "WITHHELD", "DONE"
        ];
        return n[state];
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(prefix);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function _stripComma(string memory s) internal pure returns (string memory) {
        bytes memory a = bytes(s);
        if (a.length != 0 && a[a.length - 1] == ",") {
            assembly ("memory-safe") {
                mstore(a, sub(mload(a), 1))
            }
        }
        return s;
    }
}
