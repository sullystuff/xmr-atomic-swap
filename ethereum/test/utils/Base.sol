// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../../src/XmrSwap.sol";
import {Secp256k1KeyCheck} from "../../src/lib/Secp256k1KeyCheck.sol";
import {SwapMath} from "../../src/lib/SwapMath.sol";
import {MockUSDC} from "./Mocks.sol";

/// Shared world for the tests: a proxy, a mock USDC, one registered maker with a key pool, a
/// taker with a session key, and helpers that drive each call as the right party.
abstract contract Base is Test {
    uint256 internal constant T0 = 1_800_000_000;
    address internal constant ETH = address(0);
    uint256 internal constant ONE_XMR = 1e12;
    uint256 internal constant POOL = 8;

    // states
    uint8 internal constant PENDING = 1;
    uint8 internal constant ACTIVE = 2;
    uint8 internal constant NOTICED = 3;
    uint8 internal constant READY = 4;
    uint8 internal constant ABORTED_FREE = 5;
    uint8 internal constant ABORTED_HOLD = 6;
    uint8 internal constant HOLD = 7;
    uint8 internal constant WITHHELD = 8;
    uint8 internal constant DONE = 9;

    XmrSwap internal impl;
    XmrSwap internal swap;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal makerOwner = makeAddr("makerOwner");
    address internal payout = makeAddr("payout");
    uint256 internal operatorKey;
    address internal operator;
    address internal taker = makeAddr("taker");
    address internal session = makeAddr("session");
    address internal anyone = makeAddr("anyone");

    // The taker's spend share and the maker's pool of shares.
    uint256 internal takerSecret = _share("taker spend share");
    uint256[] internal makerSecrets;
    bytes32[] internal poolLeaves;
    bytes32 internal poolRoot;

    bytes32 internal constant TXID = keccak256("monero lock txid");
    uint64 internal nextQuoteId = 1;
    uint128 internal nextNonce = 1;

    /// Everything `lock` and `take` need.
    struct Open {
        IXmrSwap.Quote q;
        bytes sig;
        uint64 xmr;
        uint256 limit;
        bytes16 nonce;
        address sessionKey;
        uint256 budget;
        IXmrSwap.TakerKeys tk;
        uint32 leafIndex;
        IXmrSwap.Approval a;
        bytes approvalSig;
        address sender;
    }

    function setUp() public virtual {
        vm.warp(T0);
        (operator, operatorKey) = makeAddrAndKey("operator");
        usdc = new MockUSDC();
        _deployAt(address(0));
        _buildPool();
        vm.prank(makerOwner);
        swap.registerMaker(operator, payout, keccak256("solana owner"));
        _fundActors();
    }

    /// Deploy implementation and proxy. `at != 0` places the proxy at a fixed address (the EIP-712
    /// vectors name their verifying contract).
    function _deployAt(address at) internal {
        impl = new XmrSwap();
        bytes memory init = abi.encodeCall(XmrSwap.initialize, (owner, treasury, address(usdc)));
        if (at == address(0)) {
            swap = XmrSwap(address(new ERC1967Proxy(address(impl), init)));
        } else {
            deployCodeTo("ERC1967Proxy.sol:ERC1967Proxy", abi.encode(address(impl), init), at);
            swap = XmrSwap(at);
        }
    }

    function _fundActors() internal {
        address[4] memory who = [taker, operator, anyone, session];
        for (uint256 i; i < who.length; ++i) {
            vm.deal(who[i], 1e30);
            usdc.mint(who[i], 1e30);
            vm.prank(who[i]);
            usdc.approve(address(swap), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ key material

    /// A 252-bit spend share.
    function _share(string memory label) internal pure returns (uint256 s) {
        s = uint256(keccak256(bytes(label))) >> 4;
        if (s == 0) s = 1;
    }

    /// The two address-form commitments of a share (SPEC 2.6).
    function _twin(uint256 s) internal pure returns (address key, address key2) {
        key = vm.addr(s);
        key2 = vm.addr(mulmod(s, Secp256k1KeyCheck.T2, Secp256k1KeyCheck.N));
    }

    /// Stand-in for the ed25519 commitment: the contract stores it and never checks it.
    function _spendPub(uint256 s) internal pure returns (bytes32) {
        return keccak256(abi.encode("ed25519 commitment of", s));
    }

    /// A canonical nonzero view share (32 bytes little-endian, below l).
    function _view(string memory label) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(bytes(label))) & ~uint256(0xff) | 0x05);
    }

    function _buildPool() internal {
        delete makerSecrets;
        delete poolLeaves;
        for (uint256 i; i < POOL; ++i) {
            uint256 s = _share(string.concat("maker share ", vm.toString(i)));
            makerSecrets.push(s);
            (address k, address k2) = _twin(s);
            poolLeaves.push(SwapMath.leafHash(uint32(i), k, k2, _spendPub(s)));
        }
        poolRoot = _merkleRoot(poolLeaves);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _merkleRoot(bytes32[] memory level) internal pure returns (bytes32) {
        uint256 n = level.length;
        while (n > 1) {
            for (uint256 i; i < n / 2; ++i) {
                level[i] = _hashPair(level[2 * i], level[2 * i + 1]);
            }
            n /= 2;
        }
        return level[0];
    }

    function _merkleProof(bytes32[] memory level, uint256 index) internal pure returns (bytes32[] memory proof) {
        uint256 n = level.length;
        uint256 depth;
        for (uint256 m = n; m > 1; m /= 2) {
            depth++;
        }
        proof = new bytes32[](depth);
        for (uint256 d; d < depth; ++d) {
            proof[d] = level[index ^ 1];
            for (uint256 i; i < n / 2; ++i) {
                level[i] = _hashPair(level[2 * i], level[2 * i + 1]);
            }
            n /= 2;
            index /= 2;
        }
    }

    function _leaf(uint32 index) internal view returns (IXmrSwap.PoolLeaf memory leaf) {
        uint256 s = makerSecrets[index];
        (leaf.key, leaf.key2) = _twin(s);
        leaf.index = index;
        leaf.spendPub = _spendPub(s);
        bytes32[] memory copy = new bytes32[](poolLeaves.length);
        for (uint256 i; i < copy.length; ++i) {
            copy[i] = poolLeaves[i];
        }
        leaf.proof = _merkleProof(copy, index);
    }

    function _takerKeys(uint8 direction) internal view returns (IXmrSwap.TakerKeys memory tk) {
        (tk.key, tk.key2) = _twin(takerSecret);
        tk.spendPub = _spendPub(takerSecret);
        tk.viewShare = direction == 0 ? _view("taker view share") : bytes32(0);
        tk.encKey = keccak256("taker x25519 key");
        tk.makerEncVersion = 1;
        tk.makerEncKey = keccak256("maker x25519 key");
    }

    // ------------------------------------------------------------------ quotes and approvals

    /// The default terms of the vectors: 1% deposit, W_a 120, W_n 1800, D_c 10800, W_c 5400,
    /// W_f 7 days, depth 10.
    function _quote(uint8 direction, address token, uint256 price) internal returns (IXmrSwap.Quote memory q) {
        q.maker = makerOwner;
        q.token = token;
        q.direction = direction;
        q.minXmr = 1;
        q.maxXmr = type(uint64).max;
        q.tierPrice[0] = price;
        q.depth[0] = 10;
        q.depositBps = 100;
        q.approvalWindow = 120;
        q.noticeWindow = 1800;
        q.claimDelay = 10800;
        q.claimWindow = 5400;
        q.finalWindow = 604800;
        q.validUntil = uint64(vm.getBlockTimestamp() + 150);
        q.epoch = swap.getMaker(makerOwner).quoteEpoch;
        q.keyRoot = direction == 0 ? poolRoot : bytes32(0);
        q.quoteId = nextQuoteId++;
    }

    // Tests read the clock with vm.getBlockTimestamp(): with via-IR the optimizer may reuse an
    // earlier `block.timestamp` after a warp.

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signQuote(IXmrSwap.Quote memory q) internal view returns (bytes memory) {
        return _sign(operatorKey, swap.hashQuote(q));
    }

    function _approval(address forTaker) internal view returns (IXmrSwap.Approval memory a) {
        a.maker = makerOwner;
        a.taker = forTaker;
        a.token = 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF;
        a.direction = 255;
        a.maxXmr = type(uint64).max;
        a.notBefore = uint64(vm.getBlockTimestamp());
        a.validUntil = uint64(vm.getBlockTimestamp() + 1 days);
        a.epoch = swap.getMaker(makerOwner).approvalEpoch;
        a.approvalId = keccak256("approval id");
    }

    function _signApproval(IXmrSwap.Approval memory a) internal view returns (bytes memory) {
        return _sign(operatorKey, swap.hashApproval(a));
    }

    /// A ready-to-send opening with the defaults; tests change fields before `_send`.
    function _open(uint8 direction, address token, uint64 xmr, uint256 price) internal returns (Open memory o) {
        o.q = _quote(direction, token, price);
        o.sig = _signQuote(o.q);
        o.xmr = xmr;
        o.limit = direction == 0 ? type(uint256).max : 0;
        o.nonce = bytes16(nextNonce++);
        o.sessionKey = session;
        o.tk = _takerKeys(direction);
        o.sender = taker;
    }

    function _id(Open memory o) internal pure returns (bytes32) {
        return SwapMath.swapIdOf(o.sender, o.nonce);
    }

    /// What the opening escrows: `amount` in A, the take deposit in B.
    function _stake(Open memory o) internal pure returns (uint256 amount, uint256 stake) {
        bool ok;
        (ok, amount) =
            o.q.direction == 0 ? SwapMath.payAmount(o.xmr, _price(o)) : SwapMath.receiveAmount(o.xmr, _price(o));
        stake = o.q.direction == 0 ? amount : SwapMath.bpsOf(amount, o.q.depositBps);
    }

    function _price(Open memory o) internal pure returns (uint256 price) {
        (, price) = SwapMath.tierValue(o.xmr, o.q.tierXmr, o.q.tierPrice);
    }

    /// Send `lock` or `take` as `o.sender`. Does not expect success: callers may `expectRevert`
    /// right before.
    function _send(Open memory o) internal returns (bytes32 id) {
        (, uint256 stake) = _stake(o);
        uint256 value = o.budget + (o.q.token == ETH ? stake : 0);
        if (o.q.direction == 0) {
            IXmrSwap.PoolLeaf memory leaf = _leaf(o.leafIndex);
            vm.prank(o.sender);
            id = swap.lock{value: value}(
                o.q, o.sig, o.xmr, o.limit, o.nonce, o.sessionKey, o.budget, o.tk, leaf, o.a, o.approvalSig
            );
        } else {
            vm.prank(o.sender);
            id = swap.take{value: value}(
                o.q, o.sig, o.xmr, o.limit, o.nonce, o.sessionKey, o.budget, o.tk, o.a, o.approvalSig
            );
        }
    }

    // ------------------------------------------------------------------ calls, each as its party

    function _get(bytes32 id) internal view returns (IXmrSwap.Swap memory) {
        return swap.getSwap(id);
    }

    function _approve(bytes32 id) internal {
        bytes32 h = _get(id).openHash;
        vm.prank(operator);
        swap.approve(id, h);
    }

    /// The share the maker funds a direction-B swap with (never one of the pool).
    function _fundSecret() internal pure returns (uint256) {
        return _share("maker funding share");
    }

    function _fund(bytes32 id) internal {
        _fundWith(id, _fundSecret(), _get(id).openHash, operator);
    }

    function _fundWith(bytes32 id, uint256 secret, bytes32 expectedOpen, address from) internal {
        IXmrSwap.Swap memory s = _get(id);
        (address k, address k2) = _twin(secret);
        vm.prank(from);
        swap.fund{value: s.token == ETH ? s.amount : 0}(
            id, expectedOpen, k, k2, _spendPub(secret), _view("maker view share")
        );
    }

    /// Approve (A) or fund (B).
    function _activate(bytes32 id) internal {
        if (_get(id).direction == 0) _approve(id);
        else _fund(id);
    }

    /// The claimer's view share: the maker's in A, the taker's in B.
    function _claimerView() internal pure returns (bytes32) {
        return _view("claimer view share");
    }

    function _commitment(bytes32 id) internal pure returns (bytes32) {
        return SwapMath.noticeCommitment(id, TXID, _claimerView());
    }

    function _ciphertext() internal pure returns (bytes memory c) {
        c = new bytes(104);
        for (uint256 i; i < 104; ++i) {
            c[i] = bytes1(uint8(i + 1));
        }
    }

    function _claimer(bytes32 id) internal view returns (address) {
        return _get(id).direction == 0 ? operator : session;
    }

    function _locker(bytes32 id) internal view returns (address) {
        return _get(id).direction == 0 ? session : operator;
    }

    function _notice(bytes32 id) internal {
        address from = _claimer(id);
        bytes32 commitment = _commitment(id); // sha256 is a call: compute it before the prank
        vm.prank(from);
        swap.postNotice(id, commitment, _ciphertext());
    }

    function _ready(bytes32 id) internal {
        vm.prank(_locker(id));
        swap.setReady(id);
    }

    function _abort(bytes32 id) internal {
        vm.prank(_claimer(id));
        swap.abort(id);
    }

    /// The secret that opens the locker's commitment (refund) or the claimer's (claim).
    function _lockerSecret(bytes32 id) internal view returns (uint256) {
        IXmrSwap.Swap memory s = _get(id);
        return s.direction == 0 ? takerSecret : _makerSecretOf(s);
    }

    function _claimerSecret(bytes32 id) internal view returns (uint256) {
        IXmrSwap.Swap memory s = _get(id);
        return s.direction == 0 ? _makerSecretOf(s) : takerSecret;
    }

    function _makerSecretOf(IXmrSwap.Swap memory s) internal view returns (uint256) {
        if (s.makerKey == vm.addr(_fundSecret())) return _fundSecret();
        for (uint256 i; i < makerSecrets.length; ++i) {
            if (vm.addr(makerSecrets[i]) == s.makerKey) return makerSecrets[i];
        }
        revert("unknown maker key");
    }

    function _refund(bytes32 id) internal {
        uint256 secret = _lockerSecret(id);
        vm.prank(anyone);
        swap.refund(id, secret);
    }

    function _claim(bytes32 id) internal {
        uint256 secret = _claimerSecret(id);
        vm.prank(anyone);
        swap.claim(id, secret);
    }

    // ------------------------------------------------------------------ balances

    function _bal(address token, address who) internal view returns (uint256) {
        return token == ETH ? who.balance : usdc.balanceOf(who);
    }

    function _selector(string memory errorName) internal pure returns (bytes4) {
        return bytes4(keccak256(bytes(string.concat(errorName, "()"))));
    }

    /// Open a default swap of 2 XMR and drive it to `state` (PENDING .. READY, or the two aborts).
    function _swapIn(uint8 direction, address token, uint8 state) internal returns (bytes32 id) {
        id = _send(_open(direction, token, uint64(2 * ONE_XMR), _defaultPrice(token)));
        if (state == PENDING) return id;
        skip(12);
        _activate(id);
        if (state == ACTIVE) return id;
        skip(90);
        _notice(id);
        if (state == NOTICED) return id;
        if (state == ABORTED_FREE) {
            _abort(id); // A7b (direction A only)
            return id;
        }
        if (state == ABORTED_HOLD) {
            if (direction == 0) skip(10800); // A7c: at T_co
            _abort(id);
            return id;
        }
        skip(1200);
        _ready(id);
    }

    function _defaultPrice(address token) internal pure returns (uint256) {
        return token == ETH ? 61e15 : 165_250_000;
    }
}
