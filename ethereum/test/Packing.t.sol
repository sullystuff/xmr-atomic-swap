// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {XmrSwapSeeder} from "./utils/Mocks.sol";

/// The stored swap is a packed record (ethereum/STORAGE.md); `getSwap` returns the frozen
/// interface struct. Every field must survive the packed form at its extremes, no field may
/// overlap another, amounts above 2^128 - 1 must be refused rather than truncated, and the
/// layout itself is pinned slot by slot.
contract PackingTest is Base {
    // keccak256(abi.encode(uint256(keccak256("xmrswap.storage.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant NAMESPACE = 0x72d7395cd54647fc1d07503abee35a2743d3fbf166f40f42b88abee6111c6600;
    uint256 internal constant FIELDS = 49;
    uint256 internal constant MAX128 = type(uint128).max;

    XmrSwapSeeder internal seeder;

    function setUp() public override {
        super.setUp();
        // The seeding implementation shares the real one's storage code; only `seedSwap` is added.
        XmrSwapSeeder s = new XmrSwapSeeder();
        vm.prank(owner);
        swap.upgradeToAndCall(address(s), "");
        seeder = XmrSwapSeeder(address(swap));
    }

    function _roundTrip(IXmrSwap.Swap memory v, string memory what) internal {
        bytes32 id = keccak256(abi.encode(what, v.taker, v.revealed));
        seeder.seedSwap(id, v);
        assertEq(keccak256(abi.encode(swap.getSwap(id))), keccak256(abi.encode(v)), what);
    }

    /// The largest value field `i` can hold, in a record that is otherwise all zeros (`one`), or
    /// in a record where every field is at its largest (`all`).
    function _set(IXmrSwap.Swap memory v, uint256 i) internal pure {
        address a = address(type(uint160).max);
        bytes32 b = bytes32(type(uint256).max);
        if (i == 0) v.taker = a;
        if (i == 1) v.maker = a;
        if (i == 2) v.token = a;
        if (i == 3) v.sessionKey = a;
        if (i == 4) v.swapNonce = bytes16(type(uint128).max);
        if (i == 5) v.state = 255;
        if (i == 6) v.direction = 255;
        if (i == 7) v.mode = 255;
        if (i == 8) v.outcome = 255;
        if (i == 9) v.depositState = 255;
        if (i == 10) v.depth = 255;
        if (i == 11) v.flags = 255; // all flag bits
        if (i == 12) v.depBps = type(uint16).max;
        if (i == 13) v.makerEncVersion = type(uint32).max;
        if (i == 14) v.xmr = type(uint64).max;
        if (i == 15) v.amount = MAX128;
        if (i == 16) v.deposit = MAX128;
        if (i == 17) v.price = MAX128;
        if (i == 18) v.noticeWindow = type(uint32).max;
        if (i == 19) v.claimDelay = type(uint32).max;
        if (i == 20) v.claimWindow = type(uint32).max;
        if (i == 21) v.takerKey = a;
        if (i == 22) v.takerKey2 = a;
        if (i == 23) v.takerSpendPub = b;
        if (i == 24) v.makerKey = a;
        if (i == 25) v.makerKey2 = a;
        if (i == 26) v.makerSpendPub = b;
        if (i == 27) v.lockerView = b;
        if (i == 28) v.takerEncKey = b;
        if (i == 29) v.makerEncKey = b;
        if (i == 30) v.noticeCommitment = b;
        if (i == 31) {
            v.noticeCiphertext = new bytes(104);
            for (uint256 k; k < 104; ++k) {
                v.noticeCiphertext[k] = 0xff;
            }
        }
        if (i == 32) v.evidenceTxid = b;
        if (i == 33) v.evidenceView = b;
        if (i == 34) v.keyLeaf = b;
        if (i == 35) v.openHash = b;
        if (i == 36) v.revealed = type(uint256).max;
        if (i == 37) v.tLock = type(uint64).max;
        if (i == 38) v.tPendingDeadline = type(uint64).max;
        if (i == 39) v.tActive = type(uint64).max;
        if (i == 40) v.tNoteDeadline = type(uint64).max;
        if (i == 41) v.tNotice = type(uint64).max;
        if (i == 42) v.tCut = type(uint64).max;
        if (i == 43) v.tClaimOpen = type(uint64).max;
        if (i == 44) v.tReady = type(uint64).max;
        if (i == 45) v.tClaimDeadline = type(uint64).max;
        if (i == 46) v.tFinal = type(uint64).max;
        if (i == 47) v.tRefund = type(uint64).max;
        if (i == 48) v.tSettled = type(uint64).max;
    }

    /// Each field alone at its maximum, every other field zero: the field comes back whole and
    /// spills into no neighbour.
    function test_roundTrip_eachFieldAloneAtItsMaximum() public {
        for (uint256 i; i < FIELDS; ++i) {
            IXmrSwap.Swap memory v;
            _set(v, i);
            if (i != 36) v.revealed = i + 1; // tells the records apart
            _roundTrip(v, string.concat("field ", vm.toString(i), " alone"));
        }
    }

    /// Every field at its maximum except one at zero: a full neighbour does not leak into it.
    function test_roundTrip_eachFieldAloneAtZero() public {
        for (uint256 skip_; skip_ < FIELDS; ++skip_) {
            IXmrSwap.Swap memory v;
            for (uint256 i; i < FIELDS; ++i) {
                if (i != skip_) _set(v, i);
            }
            v.taker = skip_ == 0 ? address(0) : address(uint160(type(uint160).max - skip_));
            _roundTrip(v, string.concat("field ", vm.toString(skip_), " zero"));
        }
    }

    function test_roundTrip_everythingAtItsMaximum() public {
        IXmrSwap.Swap memory v;
        for (uint256 i; i < FIELDS; ++i) {
            _set(v, i);
        }
        _roundTrip(v, "all maxima");
        assertEq(v.amount, MAX128);
        assertEq(v.tSettled, type(uint64).max);
        assertEq(v.flags, 0xff);
    }

    function testFuzz_roundTrip(uint256 seed) public {
        IXmrSwap.Swap memory v;
        v.taker = address(uint160(_r(seed, 0)));
        v.maker = address(uint160(_r(seed, 1)));
        v.token = address(uint160(_r(seed, 2)));
        v.sessionKey = address(uint160(_r(seed, 3)));
        v.swapNonce = bytes16(bytes32(_r(seed, 4)));
        v.state = uint8(_r(seed, 5));
        v.direction = uint8(_r(seed, 6));
        v.mode = uint8(_r(seed, 7));
        v.outcome = uint8(_r(seed, 8));
        v.depositState = uint8(_r(seed, 9));
        v.depth = uint8(_r(seed, 10));
        v.flags = uint8(_r(seed, 11));
        v.depBps = uint16(_r(seed, 12));
        v.makerEncVersion = uint32(_r(seed, 13));
        v.xmr = uint64(_r(seed, 14));
        v.amount = uint128(_r(seed, 15));
        v.deposit = uint128(_r(seed, 16));
        v.price = uint128(_r(seed, 17));
        v.noticeWindow = uint32(_r(seed, 18));
        v.claimDelay = uint32(_r(seed, 19));
        v.claimWindow = uint32(_r(seed, 20));
        v.takerKey = address(uint160(_r(seed, 21)));
        v.takerKey2 = address(uint160(_r(seed, 22)));
        v.takerSpendPub = bytes32(_r(seed, 23));
        v.makerKey = address(uint160(_r(seed, 24)));
        v.makerKey2 = address(uint160(_r(seed, 25)));
        v.makerSpendPub = bytes32(_r(seed, 26));
        v.lockerView = bytes32(_r(seed, 27));
        v.takerEncKey = bytes32(_r(seed, 28));
        v.makerEncKey = bytes32(_r(seed, 29));
        v.noticeCommitment = bytes32(_r(seed, 30));
        v.noticeCiphertext = abi.encodePacked(_r(seed, 31), _r(seed, 49), _r(seed, 50), uint64(_r(seed, 51)));
        v.evidenceTxid = bytes32(_r(seed, 32));
        v.evidenceView = bytes32(_r(seed, 33));
        v.keyLeaf = bytes32(_r(seed, 34));
        v.openHash = bytes32(_r(seed, 35));
        v.revealed = _r(seed, 36);
        v.tLock = uint64(_r(seed, 37));
        v.tPendingDeadline = uint64(_r(seed, 38));
        v.tActive = uint64(_r(seed, 39));
        v.tNoteDeadline = uint64(_r(seed, 40));
        v.tNotice = uint64(_r(seed, 41));
        v.tCut = uint64(_r(seed, 42));
        v.tClaimOpen = uint64(_r(seed, 43));
        v.tReady = uint64(_r(seed, 44));
        v.tClaimDeadline = uint64(_r(seed, 45));
        v.tFinal = uint64(_r(seed, 46));
        v.tRefund = uint64(_r(seed, 47));
        v.tSettled = uint64(_r(seed, 48));
        assertEq(v.noticeCiphertext.length, 104);
        _roundTrip(v, "fuzz");
    }

    function _r(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    /// The record cannot hold an amount, a deposit or a price above 2^128 - 1, and says so.
    function test_store_refusesAbove128Bits() public {
        for (uint256 field; field < 3; ++field) {
            IXmrSwap.Swap memory v;
            if (field == 0) v.amount = MAX128 + 1;
            if (field == 1) v.deposit = MAX128 + 1;
            if (field == 2) v.price = type(uint256).max;
            vm.expectRevert(IXmrSwap.AmountOutOfRange.selector);
            seeder.seedSwap(bytes32(field + 1), v);
        }
    }

    // ------------------------------------------------------------------ the boundary at lock and take

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }

    /// `lock` and `take` accept an amount of exactly 2^128 - 1 and store it whole; one unit more
    /// is refused, never truncated.
    function test_open_amountBoundaryAt128Bits(bool usdc_, bool directionB) public {
        address token = usdc_ ? address(usdc) : ETH;
        uint8 direction = directionB ? 1 : 0;
        vm.deal(taker, 1 << 200);
        vm.deal(operator, 1 << 200);
        usdc.mint(taker, MAX128);
        usdc.mint(operator, MAX128);

        // One XMR at a price of 2^128 - 1: the amount is the price.
        Open memory o = _open(direction, token, uint64(ONE_XMR), MAX128);
        o.q.depositBps = 500;
        o.sig = _signQuote(o.q);
        bytes32 id = _send(o);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.amount, MAX128, "stored whole");
        assertEq(s.price, MAX128);
        assertEq(s.deposit, MAX128 * 500 / 10_000);
        assertEq(_bal(token, address(swap)), directionB ? s.deposit : s.amount);

        // The full flow moves the full amount.
        _activate(id);
        assertEq(_bal(token, address(swap)), directionB ? MAX128 + s.deposit : MAX128);
        _notice(id);
        skip(600);
        _ready(id);
        address to = directionB ? taker : payout;
        uint256 before = _bal(token, to);
        _claim(id);
        uint256 fee = MAX128 * 5 / 10_000;
        assertEq(_bal(token, to) - before, MAX128 - fee + (directionB ? s.deposit : 0));
        assertEq(swap.treasuryAccrued(token), fee);
        (uint256 volume,) = swap.volumeOf(makerOwner, token);
        assertEq(volume, MAX128);

        // One piconero more than one XMR at that price: above 2^128 - 1 in both rounding modes.
        o = _open(direction, token, uint64(ONE_XMR + 1), MAX128);
        o.leafIndex = 1;
        vm.expectRevert(IXmrSwap.AmountOutOfRange.selector);
        this.sendOpen(o);
        // A price of 2^128.
        o = _open(direction, token, 1, MAX128 + 1);
        o.leafIndex = 1;
        vm.expectRevert(IXmrSwap.AmountOutOfRange.selector);
        this.sendOpen(o);
        // A product whose low 128 bits alone would look like a small, valid amount.
        o = _open(direction, token, uint64(2 * ONE_XMR), (uint256(1) << 127) + 61e15);
        o.leafIndex = 1;
        vm.expectRevert(IXmrSwap.AmountOutOfRange.selector);
        this.sendOpen(o);
        assertEq(swap.swapsOf(taker, 0, 10).length, 1);
    }

    /// A swap whose every timestamp is near the top of uint64 keeps exact deadlines.
    function test_timestampsNearTheTopOfUint64(bool directionB) public {
        // Leave room for W_f, the expiry and the 60-day split.
        uint256 start = uint256(type(uint64).max) - 400 days;
        vm.warp(start);
        bytes32 id = _swapIn(directionB ? 1 : 0, ETH, NOTICED);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.tLock, start);
        assertEq(s.tPendingDeadline, start + 120);
        assertEq(s.tFinal, start + 604_800);
        assertEq(s.tActive, start + 12);
        assertEq(s.tNoteDeadline, start + 12 + 1800);
        assertEq(s.tNotice, start + 102);
        assertEq(s.tCut, start + 102 + 3900);
        assertEq(s.tClaimOpen, start + 102 + 10_800);
        vm.warp(s.tFinal + 2_592_000); // T_exp
        _refund(id);
        s = _get(id);
        assertEq(s.tRefund, start + 604_800 + 2_592_000);
        assertEq(s.tSettled, s.tRefund);
        assertEq(s.state, DONE);
    }

    /// Every flag bit the machine sets survives beside the other status bytes.
    function test_flags_allBitsThroughTheRealPaths() public {
        // Direction B, late notice, evidence, refund by the locker: bits 1, 2, 4, 8, 16.
        bytes32 id = _swapIn(1, ETH, ACTIVE);
        vm.warp(_get(id).tNoteDeadline);
        _notice(id);
        vm.prank(session);
        swap.publishEvidence(id, TXID, _claimerView());
        _refund(id);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.flags, 1 | 2 | 4 | 8 | 16);
        assertEq(s.state, HOLD);
        assertEq(s.depositState, 1);
        assertEq(s.outcome, 0xff);
        assertEq(s.direction, 1);
        assertEq(s.depth, 10);
        assertEq(s.depBps, 100);
    }

    // ------------------------------------------------------------------ the layout, pinned

    function _slot(bytes32 id, uint256 n) internal view returns (uint256) {
        // swaps is the second member of the namespaced struct: mapping slot NAMESPACE + 1.
        bytes32 base = keccak256(abi.encode(id, uint256(NAMESPACE) + 1));
        return uint256(vm.load(address(swap), bytes32(uint256(base) + n)));
    }

    /// The layout recorded in ethereum/STORAGE.md, read from raw storage after a real flow.
    function test_layout_isTheRecordedOne() public {
        bytes32 id = _swapIn(0, ETH, READY);
        _claim(id);
        IXmrSwap.Swap memory s = _get(id);
        uint256 a = type(uint160).max;
        uint256 u64 = type(uint64).max;
        uint256 u32 = type(uint32).max;

        uint256 w = _slot(id, 0);
        assertEq(address(uint160(w & a)), s.taker);
        assertEq((w >> 160) & u64, s.tLock);
        assertEq((w >> 224) & u32, s.noticeWindow);
        w = _slot(id, 1);
        assertEq(address(uint160(w & a)), s.maker);
        assertEq((w >> 160) & u64, s.xmr);
        assertEq((w >> 224) & u32, s.claimDelay);
        w = _slot(id, 2);
        assertEq(address(uint160(w & a)), s.token);
        assertEq((w >> 160) & u64, s.tSettled);
        assertEq((w >> 224) & 0xff, s.state);
        assertEq((w >> 232) & 0xff, s.outcome);
        assertEq((w >> 240) & 0xff, s.depositState);
        assertEq((w >> 248) & 0xff, s.flags);
        w = _slot(id, 3);
        assertEq(address(uint160(w & a)), s.sessionKey);
        assertEq((w >> 160) & u64, s.tFinal);
        assertEq((w >> 224) & u32, s.claimWindow);
        w = _slot(id, 4);
        assertEq(address(uint160(w & a)), s.takerKey);
        assertEq((w >> 160) & u64, s.tPendingDeadline);
        assertEq((w >> 224) & u32, s.makerEncVersion);
        w = _slot(id, 5);
        assertEq(address(uint160(w & a)), s.takerKey2);
        assertEq((w >> 160) & u64, s.tActive);
        assertEq((w >> 224) & 0xff, s.direction);
        assertEq((w >> 232) & 0xff, s.mode);
        assertEq((w >> 240) & 0xff, s.depth);
        w = _slot(id, 6);
        assertEq(address(uint160(w & a)), s.makerKey);
        assertEq((w >> 160) & u64, s.tNoteDeadline);
        assertEq((w >> 224) & 0xffff, s.depBps);
        w = _slot(id, 7);
        assertEq(address(uint160(w & a)), s.makerKey2);
        assertEq((w >> 160) & u64, s.tClaimDeadline);
        w = _slot(id, 8);
        assertEq(w & MAX128, s.amount);
        assertEq(w >> 128, s.deposit);
        w = _slot(id, 9);
        assertEq(w & MAX128, s.price);
        assertEq(bytes16(uint128(w >> 128)), s.swapNonce);
        assertEq(bytes32(_slot(id, 10)), s.takerSpendPub);
        assertEq(bytes32(_slot(id, 11)), s.makerSpendPub);
        assertEq(bytes32(_slot(id, 12)), s.lockerView);
        assertEq(bytes32(_slot(id, 13)), s.takerEncKey);
        assertEq(bytes32(_slot(id, 14)), s.makerEncKey);
        assertEq(bytes32(_slot(id, 15)), s.keyLeaf);
        assertEq(bytes32(_slot(id, 16)), s.openHash);
        w = _slot(id, 17);
        assertEq(w & u64, s.tNotice);
        assertEq((w >> 64) & u64, s.tCut);
        assertEq((w >> 128) & u64, s.tClaimOpen);
        assertEq(w >> 192, s.tReady);
        assertEq(_slot(id, 18), s.tRefund);
        assertEq(bytes32(_slot(id, 19)), s.noticeCommitment);
        assertEq(_slot(id, 20), 104 * 2 + 1, "a long bytes value: length * 2 + 1");
        assertEq(bytes32(_slot(id, 21)), s.evidenceTxid);
        assertEq(bytes32(_slot(id, 22)), s.evidenceView);
        assertEq(_slot(id, 23), s.revealed);
        assertEq(_slot(id, 24), 0, "the record ends at slot 23");
    }

    /// `lock` writes exactly slots 0 to 16 of the record; `take` leaves the maker's five for `fund`.
    function test_layout_slotsWrittenAtOpen() public {
        bytes32 a = _swapIn(0, ETH, PENDING);
        bytes32 b = _swapIn(1, ETH, PENDING);
        for (uint256 n; n < 24; ++n) {
            assertEq(_slot(a, n) != 0, n <= 16, string.concat("lock, slot ", vm.toString(n)));
            bool makerSlot = n == 6 || n == 7 || n == 11 || n == 12 || n == 15;
            // Slot 6 also holds depBps, which `take` writes.
            assertEq(_slot(b, n) != 0, n <= 16 && (!makerSlot || n == 6), string.concat("take, slot ", vm.toString(n)));
        }
    }
}
