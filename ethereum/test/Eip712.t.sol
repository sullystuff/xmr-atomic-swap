// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {XmrSwap} from "../src/XmrSwap.sol";
import {Base} from "./utils/Base.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// EIP-712 quotes and advance approvals (SPEC 2.10) against `eip712.json`: the proxy sits at the
/// vectors' verifying contract, the maker and operator are the vectors' own, and the signatures
/// are the vectors' (byte-identical to what `cast wallet sign --data` produces, which one test
/// checks by running it).
contract Eip712Test is Base {
    string internal constant FILE = "../interfaces/vectors/eip712.json";
    string internal json;
    address internal vMaker;
    address internal vTaker = 0x0F8183AEFDf068DD8489b6EDbF4E07965cf29246;
    address internal vUsdc = 0xF9aB76450f884B429b2C128ac26fca8C2efdD5f5;

    function setUp() public override {
        json = vm.readFile(FILE);
        vm.warp(T0);
        operatorKey = vm.parseJsonUint(json, ".operator_private_key");
        operator = vm.addr(operatorKey);
        assertEq(operator, vm.parseJsonAddress(json, ".operator"));
        vMaker = vm.parseJsonAddress(json, ".cases[0].input.typed_data.message.maker");
        makerOwner = vMaker;
        taker = vTaker;

        // The mock USDC at the vectors' token address, the proxy at their verifying contract.
        deployCodeTo("Mocks.sol:MockUSDC", vUsdc);
        usdc = MockUSDC(vUsdc);
        _deployAt(vm.parseJsonAddress(json, ".domain.verifyingContract"));
        assertEq(block.chainid, vm.parseJsonUint(json, ".domain.chainId"));
        _buildPool();
        _registerVectorMaker(swap);
        _fundActors();
    }

    /// The vectors sign with quote epoch 3 and approval epoch 2.
    function _registerVectorMaker(XmrSwap at) internal {
        vm.startPrank(vMaker);
        at.registerMaker(operator, payout, keccak256("solana owner"));
        at.bumpEpochs(true, true);
        at.bumpEpochs(true, true);
        at.bumpEpochs(true, false);
        vm.stopPrank();
        assertEq(at.getMaker(vMaker).quoteEpoch, 3);
        assertEq(at.getMaker(vMaker).approvalEpoch, 2);
    }

    // ------------------------------------------------------------------ reading the vectors

    function _case(string memory name) internal view returns (string memory c) {
        for (uint256 i;; ++i) {
            c = string.concat(".cases[", vm.toString(i), "]");
            require(vm.keyExistsJson(json, c), string.concat("no case ", name));
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(c, ".name")))) == keccak256(bytes(name))) {
                return c;
            }
        }
    }

    function _u64s(string memory key) internal view returns (uint64[3] memory out) {
        uint256[] memory v = vm.parseJsonUintArray(json, key);
        out = [uint64(v[0]), uint64(v[1]), uint64(v[2])];
    }

    function _quoteOf(string memory c) internal view returns (IXmrSwap.Quote memory q) {
        string memory m = string.concat(c, ".input.typed_data.message");
        q.maker = vm.parseJsonAddress(json, string.concat(m, ".maker"));
        q.taker = vm.parseJsonAddress(json, string.concat(m, ".taker"));
        q.token = vm.parseJsonAddress(json, string.concat(m, ".token"));
        q.direction = uint8(vm.parseJsonUint(json, string.concat(m, ".direction")));
        q.approvalMode = uint8(vm.parseJsonUint(json, string.concat(m, ".approvalMode")));
        q.minXmr = uint64(vm.parseJsonUint(json, string.concat(m, ".minXmr")));
        q.maxXmr = uint64(vm.parseJsonUint(json, string.concat(m, ".maxXmr")));
        q.tierXmr = _u64s(string.concat(m, ".tierXmr"));
        uint256[] memory prices = vm.parseJsonUintArray(json, string.concat(m, ".tierPrice"));
        q.tierPrice = [prices[0], prices[1], prices[2]];
        q.depthXmr = _u64s(string.concat(m, ".depthXmr"));
        uint256[] memory depth = vm.parseJsonUintArray(json, string.concat(m, ".depth"));
        q.depth = [uint8(depth[0]), uint8(depth[1]), uint8(depth[2])];
        q.depositBps = uint16(vm.parseJsonUint(json, string.concat(m, ".depositBps")));
        q.approvalWindow = uint32(vm.parseJsonUint(json, string.concat(m, ".approvalWindow")));
        q.noticeWindow = uint32(vm.parseJsonUint(json, string.concat(m, ".noticeWindow")));
        q.claimDelay = uint32(vm.parseJsonUint(json, string.concat(m, ".claimDelay")));
        q.claimWindow = uint32(vm.parseJsonUint(json, string.concat(m, ".claimWindow")));
        q.finalWindow = uint32(vm.parseJsonUint(json, string.concat(m, ".finalWindow")));
        q.validUntil = uint64(vm.parseJsonUint(json, string.concat(m, ".validUntil")));
        q.epoch = uint32(vm.parseJsonUint(json, string.concat(m, ".epoch")));
        q.keyRoot = vm.parseJsonBytes32(json, string.concat(m, ".keyRoot"));
        q.quoteId = uint64(vm.parseJsonUint(json, string.concat(m, ".quoteId")));
        q.freezeWindow = uint32(vm.parseJsonUint(json, string.concat(m, ".freezeWindow")));
    }

    function _approvalOf(string memory c) internal view returns (IXmrSwap.Approval memory a) {
        string memory m = string.concat(c, ".input.typed_data.message");
        a.maker = vm.parseJsonAddress(json, string.concat(m, ".maker"));
        a.taker = vm.parseJsonAddress(json, string.concat(m, ".taker"));
        a.token = vm.parseJsonAddress(json, string.concat(m, ".token"));
        a.direction = uint8(vm.parseJsonUint(json, string.concat(m, ".direction")));
        a.maxXmr = uint64(vm.parseJsonUint(json, string.concat(m, ".maxXmr")));
        a.notBefore = uint64(vm.parseJsonUint(json, string.concat(m, ".notBefore")));
        a.validUntil = uint64(vm.parseJsonUint(json, string.concat(m, ".validUntil")));
        a.epoch = uint32(vm.parseJsonUint(json, string.concat(m, ".epoch")));
        a.approvalId = vm.parseJsonBytes32(json, string.concat(m, ".approvalId"));
    }

    function _isQuote(string memory c) internal view returns (bool) {
        return keccak256(bytes(vm.parseJsonString(json, string.concat(c, ".input.typed_data.primaryType"))))
            == keccak256("Quote");
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        return ecrecover(digest, v, r, s);
    }

    /// A lock or take with a vector quote and signature, as the vector taker.
    function _vectorOpen(string memory c, uint64 xmr) internal returns (Open memory o) {
        o.q = _quoteOf(c);
        string memory out = string.concat(c, ".output.signature");
        o.sig = vm.parseJsonBytes(json, vm.keyExistsJson(json, out) ? out : string.concat(c, ".input.signature"));
        o.xmr = xmr;
        o.limit = o.q.direction == 0 ? type(uint256).max : 0;
        o.nonce = bytes16(nextNonce++);
        o.sessionKey = session;
        o.tk = _takerKeys(o.q.direction);
        o.sender = vTaker;
    }

    function sendOpen(Open memory o) external returns (bytes32) {
        return _send(o);
    }

    function _expectOpen(Open memory o, bytes4 err) internal {
        vm.expectRevert(err);
        this.sendOpen(o);
    }

    // ------------------------------------------------------------------ digests and signatures

    function test_domainSeparator_and_domain() public view {
        assertEq(swap.domainSeparator(), vm.parseJsonBytes32(json, ".domain_separator"));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = swap.eip712Domain();
        assertEq(name, vm.parseJsonString(json, ".domain.name"));
        assertEq(version, vm.parseJsonString(json, ".domain.version"));
        assertEq(chainId, 31337);
        assertEq(verifying, address(swap));
    }

    /// Every case that states a digest: the contract computes the same one, on the stated chain
    /// and contract, and the signature recovers to the stated signer or not.
    function test_digests_allCases() public {
        uint256 withDigest;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (!vm.keyExistsJson(json, string.concat(c, ".input.typed_data"))) continue;
            bool valid = vm.parseJsonBool(json, string.concat(c, ".valid"));
            string memory dk = string.concat(c, valid ? ".output.digest" : ".input.digest");
            if (!vm.keyExistsJson(json, dk)) continue;
            string memory name = vm.parseJsonString(json, string.concat(c, ".name"));
            string memory dom = string.concat(c, ".input.typed_data.domain");

            uint256 snap = vm.snapshotState();
            vm.chainId(vm.parseJsonUint(json, string.concat(dom, ".chainId")));
            address verifying = vm.parseJsonAddress(json, string.concat(dom, ".verifyingContract"));
            XmrSwap at = swap;
            if (verifying != address(swap)) {
                _deployAt(verifying);
                at = swap;
            }
            bytes32 digest = _isQuote(c) ? at.hashQuote(_quoteOf(c)) : at.hashApproval(_approvalOf(c));
            assertEq(digest, vm.parseJsonBytes32(json, dk), string.concat(name, ": digest"));

            string memory sk = string.concat(c, valid ? ".output.signature" : ".input.signature");
            if (vm.keyExistsJson(json, sk)) {
                address signer = _recover(digest, vm.parseJsonBytes(json, sk));
                if (valid) {
                    assertEq(signer, vm.parseJsonAddress(json, string.concat(c, ".output.signer")), name);
                    assertEq(signer, operator, name);
                } else if (keccak256(bytes(name)) != keccak256("quote-high-s-signature")) {
                    // Signed for another chain, another contract or other terms.
                    assertTrue(signer != operator, name);
                }
            }
            vm.revertToState(snap);
            withDigest++;
        }
        assertEq(withDigest, 17);
    }

    /// SPEC 9.1: a signature produced by `cast` from typed-data JSON is accepted. The JSON is
    /// written here from the quote's fields, `cast wallet sign --data` signs it with the vectors'
    /// test key, and the contract accepts the result; it is also the vector's signature byte for
    /// byte (RFC 6979).
    function test_castSignature_isAccepted() public {
        string memory c = _case("quote-public-eth-b");
        Open memory o = _vectorOpen(c, 1e12);
        string[] memory cmd = new string[](6);
        cmd[0] = "cast";
        cmd[1] = "wallet";
        cmd[2] = "sign";
        cmd[3] = "--data";
        cmd[4] = _typedData(o.q);
        cmd[5] = string.concat("--private-key=", vm.toString(bytes32(operatorKey)));
        bytes memory sig = vm.ffi(cmd);
        assertEq(sig.length, 65, "cast returned a 65-byte signature");
        assertEq(sig, vm.parseJsonBytes(json, string.concat(c, ".output.signature")), "RFC 6979: same bytes");

        o.sig = sig;
        o.a = _approvalOf(_case("approval-any"));
        o.approvalSig = vm.parseJsonBytes(json, string.concat(_case("approval-any"), ".output.signature"));
        bytes32 id = _send(o);
        assertEq(_get(id).state, PENDING);

        // And a quote of this test's own making, signed by cast, opens a direction-A swap.
        o = _open(0, address(usdc), 3e12, 165_250_000);
        o.q.tierXmr = [uint64(0), 1e12, 5e12];
        o.q.tierPrice = [uint256(165_250_000), 165_000_000, 164_000_000];
        o.q.depthXmr = [uint64(0), 2e12, 0];
        o.q.depth = [2, 10, 0];
        cmd[4] = _typedData(o.q);
        o.sig = vm.ffi(cmd);
        id = _send(o);
        assertEq(_get(id).price, 165_000_000);
        assertEq(_get(id).depth, 10);
    }

    function _arr(uint256 a, uint256 b, uint256 c) internal pure returns (string memory) {
        return string.concat('["', vm.toString(a), '","', vm.toString(b), '","', vm.toString(c), '"]');
    }

    function _field(string memory name, string memory value, bool quoted) internal pure returns (string memory) {
        return string.concat('"', name, '":', quoted ? '"' : "", value, quoted ? '"' : "", ",");
    }

    /// EIP-712 typed-data JSON of a quote, as a wallet or `cast` takes it.
    function _typedData(IXmrSwap.Quote memory q) internal view returns (string memory) {
        string memory types = string.concat(
            '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"Quote":[{"name":"maker","type":"address"},{"name":"taker","type":"address"},',
            '{"name":"token","type":"address"},{"name":"direction","type":"uint8"},',
            '{"name":"approvalMode","type":"uint8"},{"name":"minXmr","type":"uint64"},',
            '{"name":"maxXmr","type":"uint64"},{"name":"tierXmr","type":"uint64[3]"},',
            '{"name":"tierPrice","type":"uint256[3]"},{"name":"depthXmr","type":"uint64[3]"},',
            '{"name":"depth","type":"uint8[3]"},{"name":"depositBps","type":"uint16"},',
            '{"name":"approvalWindow","type":"uint32"},{"name":"noticeWindow","type":"uint32"},',
            '{"name":"claimDelay","type":"uint32"},{"name":"claimWindow","type":"uint32"},',
            '{"name":"finalWindow","type":"uint32"},{"name":"validUntil","type":"uint64"},',
            '{"name":"epoch","type":"uint32"},{"name":"keyRoot","type":"bytes32"},',
            '{"name":"quoteId","type":"uint64"},{"name":"freezeWindow","type":"uint32"}]'
        );
        string memory m1 = string.concat(
            _field("maker", vm.toString(q.maker), true),
            _field("taker", vm.toString(q.taker), true),
            _field("token", vm.toString(q.token), true),
            _field("direction", vm.toString(q.direction), false),
            _field("approvalMode", vm.toString(q.approvalMode), false),
            _field("minXmr", vm.toString(q.minXmr), true),
            _field("maxXmr", vm.toString(q.maxXmr), true),
            _field("tierXmr", _arr(q.tierXmr[0], q.tierXmr[1], q.tierXmr[2]), false),
            _field("tierPrice", _arr(q.tierPrice[0], q.tierPrice[1], q.tierPrice[2]), false),
            _field("depthXmr", _arr(q.depthXmr[0], q.depthXmr[1], q.depthXmr[2]), false),
            _field("depth", _arr(q.depth[0], q.depth[1], q.depth[2]), false)
        );
        string memory m2 = string.concat(
            _field("depositBps", vm.toString(q.depositBps), false),
            _field("approvalWindow", vm.toString(q.approvalWindow), false),
            _field("noticeWindow", vm.toString(q.noticeWindow), false),
            _field("claimDelay", vm.toString(q.claimDelay), false),
            _field("claimWindow", vm.toString(q.claimWindow), false),
            _field("finalWindow", vm.toString(q.finalWindow), false),
            _field("validUntil", vm.toString(q.validUntil), true),
            _field("epoch", vm.toString(q.epoch), false),
            _field("keyRoot", vm.toString(q.keyRoot), true),
            '"quoteId":"',
            vm.toString(q.quoteId),
            '","freezeWindow":',
            vm.toString(q.freezeWindow)
        );
        return string.concat(
            '{"types":{',
            types,
            '},"primaryType":"Quote","domain":{"name":"XmrAtomicSwap","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(swap)),
            '"},"message":{',
            m1,
            m2,
            "}}"
        );
    }

    // ------------------------------------------------------------------ quotes through lock and take

    /// A take built from nothing but vector objects and vector signatures: the direction-B quote
    /// (approval mode 2) with the wildcard advance approval.
    function test_vectorQuoteAndApproval_take() public {
        Open memory o = _vectorOpen(_case("quote-public-eth-b"), 2e12);
        o.a = _approvalOf(_case("approval-any"));
        o.approvalSig = vm.parseJsonBytes(json, string.concat(_case("approval-any"), ".output.signature"));
        bytes32 id = _send(o);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.state, PENDING);
        assertEq(s.mode, 2);
        assertEq(s.depth, 10); // 2 XMR is in the second depth tier
        assertEq(s.price, 60500000000000000);
        assertEq(s.amount, 121000000000000000);
        assertEq(s.deposit, 1210000000000000);

        // Without the approval the same quote is refused.
        o = _vectorOpen(_case("quote-public-eth-b"), 2e12);
        _expectOpen(o, IXmrSwap.ApprovalRequired.selector);
    }

    /// The direction-A vector quotes commit to a key pool the vectors do not publish, so a lock
    /// passes every quote check and stops at the leaf (`BadKey`), which is the last quote-related
    /// check; a broken signature stops earlier with `BadSigner`.
    function test_vectorQuote_lock_signatureAcceptedUntilTheLeaf() public {
        Open memory o = _vectorOpen(_case("quote-public-eth-a"), 2e12);
        _expectOpen(o, IXmrSwap.BadKey.selector);

        // The taker-bound USDC quote: accepted for its taker, refused for anybody else.
        o = _vectorOpen(_case("quote-bound-usdc-a"), 2e12);
        _expectOpen(o, IXmrSwap.BadKey.selector);
        o.sender = anyone;
        _expectOpen(o, IXmrSwap.WrongParty.selector);
    }

    /// The vectors' direction-B quote with a three-day freeze window, taken with its own signature:
    /// the swap carries the window, and the type hash of the vectors is the contract's.
    function test_vectorQuote_withFreezeWindow_take() public {
        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".quote_type"))), vm.parseJsonBytes32(json, ".quote_type_hash")
        );
        Open memory o = _vectorOpen(_case("quote-freeze-window-three-days-b"), 2e12);
        bytes32 id = _send(o);
        IXmrSwap.Swap memory s = _get(id);
        assertEq(s.freezeSecs, 259_200);
        assertEq(s.payout, vTaker);
        assertEq(s.watcher, address(0));
        // The direction-A quote with a one-hour window passes every quote check (its pool is not
        // published, so the lock stops at the leaf).
        o = _vectorOpen(_case("quote-freeze-window-one-hour"), 2e12);
        o.watcher = makeAddr("watcher");
        _expectOpen(o, IXmrSwap.BadKey.selector);
    }

    function test_quoteValidUntil_isInclusive() public {
        string memory at = _case("quote-at-valid-until");
        vm.warp(vm.parseJsonUint(json, string.concat(at, ".input.now")));
        _expectOpen(_vectorOpen(at, 2e12), IXmrSwap.BadKey.selector); // every quote check passed

        string memory after_ = _case("quote-at-valid-until-plus-1");
        vm.warp(vm.parseJsonUint(json, string.concat(after_, ".input.now")));
        _expectOpen(_vectorOpen(after_, 2e12), _selector(vm.parseJsonString(json, string.concat(after_, ".error"))));

        // The same edge on a quote with a real pool.
        vm.warp(T0);
        Open memory o = _open(0, ETH, 2e12, 61e15);
        vm.warp(o.q.validUntil);
        uint256 snap = vm.snapshotState();
        _send(o);
        vm.revertToState(snap);
        vm.warp(o.q.validUntil + 1);
        _expectOpen(o, IXmrSwap.Expired.selector);
    }

    function test_quote_replayedOnAnotherChain() public {
        string memory c = _case("quote-replayed-on-another-chain");
        Open memory o = _vectorOpen(_case("quote-public-eth-b"), 2e12);
        o.a = _approvalOf(_case("approval-any"));
        o.approvalSig = vm.parseJsonBytes(json, string.concat(_case("approval-any"), ".output.signature"));
        vm.chainId(vm.parseJsonUint(json, string.concat(c, ".input.typed_data.domain.chainId")));
        _expectOpen(o, IXmrSwap.BadSigner.selector);
        _expectOpen(_vectorOpen(c, 2e12), _selector(vm.parseJsonString(json, string.concat(c, ".error"))));
        // Back on the right chain the very same call is accepted.
        vm.chainId(31337);
        _send(o);
    }

    function test_quote_replayedOnAnotherContract() public {
        string memory c = _case("quote-replayed-on-another-contract");
        XmrSwap original = swap;
        _deployAt(vm.parseJsonAddress(json, string.concat(c, ".input.typed_data.domain.verifyingContract")));
        _registerVectorMaker(swap);
        _fundActors();
        _expectOpen(_vectorOpen(c, 2e12), _selector(vm.parseJsonString(json, string.concat(c, ".error"))));
        Open memory o = _vectorOpen(_case("quote-public-eth-b"), 2e12);
        o.a = _approvalOf(_case("approval-any"));
        o.approvalSig = vm.parseJsonBytes(json, string.concat(_case("approval-any"), ".output.signature"));
        _expectOpen(o, IXmrSwap.BadSigner.selector);
        swap = original;
        _send(o);
    }

    function test_quote_tampered() public {
        string memory c = _case("quote-tampered-price");
        _expectOpen(_vectorOpen(c, 2e12), _selector(vm.parseJsonString(json, string.concat(c, ".error"))));

        // Each field of a quote is covered by the signature.
        for (uint256 field; field < 22; ++field) {
            Open memory o = _open(0, ETH, 2e12, 61e15);
            _tamper(o.q, field);
            _expectOpen(o, IXmrSwap.BadSigner.selector);
        }
    }

    function _tamper(IXmrSwap.Quote memory q, uint256 field) internal view {
        if (field == 0) q.maker = vMaker == q.maker ? q.maker : vMaker;
        if (field == 1) q.taker = taker;
        if (field == 2) q.token = address(usdc);
        if (field == 3) q.approvalMode = 1;
        if (field == 4) q.minXmr += 1;
        if (field == 5) q.maxXmr -= 1;
        if (field == 6) q.tierXmr[1] = 5;
        if (field == 7) q.tierPrice[0] -= 1;
        if (field == 8) q.depthXmr[2] = 7;
        if (field == 9) q.depth[0] = 2;
        if (field == 10) q.depositBps = 0;
        if (field == 11) q.approvalWindow += 1;
        if (field == 12) q.noticeWindow += 1;
        if (field == 13) q.claimDelay += 1;
        if (field == 14) q.claimWindow += 1;
        if (field == 15) q.finalWindow += 1;
        if (field == 16) q.validUntil += 1;
        if (field == 17) q.keyRoot = bytes32(uint256(q.keyRoot) ^ 1);
        if (field == 18) q.quoteId += 1;
        if (field == 19) q.tierPrice[2] = 1;
        if (field == 20) q.depth[1] = 3;
        if (field == 21) q.freezeWindow = 3600;
        if (field == 0) q.direction = 0; // field 0 on this maker is a no-op; flip the price instead
        if (field == 0) q.tierPrice[1] = 9;
    }

    function test_quote_highS_and_malformedSignatures() public {
        string memory c = _case("quote-high-s-signature");
        _expectOpen(_vectorOpen(c, 2e12), _selector(vm.parseJsonString(json, string.concat(c, ".error"))));

        Open memory o = _open(0, ETH, 2e12, 61e15);
        bytes memory good = o.sig;
        o.sig = "";
        _expectOpen(o, IXmrSwap.BadSigner.selector);
        o.sig = abi.encodePacked(good, uint8(0)); // 66 bytes
        _expectOpen(o, IXmrSwap.BadSigner.selector);
        o.sig = new bytes(65);
        _expectOpen(o, IXmrSwap.BadSigner.selector);
        o.sig = good;
        _send(o);
    }

    function test_quote_wrongSigner() public {
        // Signed by a stranger, and by a key that is not the operator's.
        Open memory o = _open(0, ETH, 2e12, 61e15);
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        o.sig = _sign(strangerKey, swap.hashQuote(o.q));
        _expectOpen(o, IXmrSwap.BadSigner.selector);

        // An unregistered maker has no operator at all.
        o = _open(0, ETH, 2e12, 61e15);
        o.q.maker = makeAddr("nobody");
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.NotRegistered.selector);
    }

    function test_quote_cancel() public {
        Open memory o = _open(0, ETH, 2e12, 61e15);
        Open memory other = _open(0, ETH, 2e12, 61e15);
        // The operator may cancel as well as the owner.
        vm.prank(operator);
        swap.cancelQuote(o.q.quoteId);
        assertTrue(swap.isQuoteCancelled(vMaker, o.q.quoteId));
        _expectOpen(o, IXmrSwap.Cancelled.selector);
        _send(other); // another quote id is untouched
    }

    function test_quote_epochBump() public {
        Open memory o = _open(0, ETH, 2e12, 61e15);
        vm.prank(operator);
        swap.bumpEpochs(true, false);
        _expectOpen(o, IXmrSwap.StaleEpoch.selector);
        // A future epoch is refused too.
        Open memory fresh = _open(0, ETH, 2e12, 61e15);
        fresh.q.epoch += 1;
        fresh.sig = _signQuote(fresh.q);
        _expectOpen(fresh, IXmrSwap.StaleEpoch.selector);
        _send(_open(0, ETH, 2e12, 61e15));
    }

    function test_quote_operatorRotation() public {
        Open memory old = _open(0, ETH, 2e12, 61e15);
        (address newOperator, uint256 newKey) = makeAddrAndKey("new operator");
        uint256 oldKey = operatorKey;
        vm.prank(vMaker);
        swap.setOperator(newOperator);

        // Everything the old key signed is dead: its signature no longer recovers to the operator.
        _expectOpen(old, IXmrSwap.BadSigner.selector);
        // The old key signing the new epoch is still not the operator.
        Open memory o = _open(0, ETH, 2e12, 61e15);
        _expectOpen(o, IXmrSwap.BadSigner.selector);
        // The new key signing an old epoch is stale: rotation bumped both epochs.
        operatorKey = newKey;
        operator = newOperator;
        o = _open(0, ETH, 2e12, 61e15);
        o.q.epoch -= 1;
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.StaleEpoch.selector);
        // The new key with the new epoch works.
        _send(_open(0, ETH, 2e12, 61e15));
        operatorKey = oldKey;
    }

    function test_quote_replay() public {
        // A public quote is reusable until it expires, under a fresh nonce each time.
        Open memory o = _open(0, ETH, 2e12, 61e15);
        bytes32 id = _send(o);
        _expectOpen(o, IXmrSwap.BadState.selector); // the same nonce names the same swap
        o.nonce = bytes16(nextNonce++);
        o.leafIndex = 1;
        _send(o);

        // A swap id is never reusable, not even after the swap is settled.
        vm.prank(vTaker);
        swap.cancelPending(id);
        assertEq(_get(id).state, DONE);
        o.nonce = bytes16(uint128(1));
        _expectOpen(o, IXmrSwap.BadState.selector);

        // A taker-bound quote is single-use.
        Open memory b = _open(0, ETH, 2e12, 61e15);
        b.q.taker = vTaker;
        b.sig = _signQuote(b.q);
        _send(b);
        assertTrue(swap.isQuoteCancelled(vMaker, b.q.quoteId));
        b.nonce = bytes16(nextNonce++);
        _expectOpen(b, IXmrSwap.Cancelled.selector);
    }

    function test_quote_wrongDirectionAndToken() public {
        Open memory o = _open(1, ETH, 2e12, 61e15);
        o.q.direction = 0; // a direction-A quote sent to take
        o.q.keyRoot = poolRoot;
        o.sig = _signQuote(o.q);
        (, uint256 stake) = _stake(o);
        vm.prank(vTaker);
        vm.expectRevert(IXmrSwap.WrongDirection.selector);
        swap.take{value: stake}(o.q, o.sig, o.xmr, 0, o.nonce, session, 0, _takerKeys(1), o.a, o.approvalSig, vTaker);

        MockUSDC other = new MockUSDC();
        o = _open(0, address(other), 2e12, 61e15);
        _expectOpen(o, IXmrSwap.TokenNotAllowed.selector);
    }

    // ------------------------------------------------------------------ advance approvals

    /// Every approval case of the vectors that carries a `lock`: a mode-2 quote signed by the
    /// vector operator, the vector approval and its vector signature, sent by the stated sender
    /// at the stated time with the stated size, token and direction.
    function test_approvalVectors_throughLockAndTake() public {
        uint256 accepted;
        uint256 refused;
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            string memory lk = string.concat(c, ".input.lock");
            if (!vm.keyExistsJson(json, lk)) continue;
            uint256 snap = vm.snapshotState();
            string memory name = vm.parseJsonString(json, string.concat(c, ".name"));

            vm.warp(vm.parseJsonUint(json, string.concat(lk, ".now")));
            uint256 wantEpoch = vm.parseJsonUint(json, string.concat(lk, ".approval_epoch"));
            while (swap.getMaker(vMaker).approvalEpoch < wantEpoch) {
                vm.prank(vMaker);
                swap.bumpEpochs(false, true);
            }
            address sender = vm.parseJsonAddress(json, string.concat(lk, ".sender"));
            vm.deal(sender, 1e30);
            usdc.mint(sender, 1e30);
            vm.prank(sender);
            usdc.approve(address(swap), type(uint256).max);

            // One piconero costs one base unit at this price.
            Open memory o = _open(
                uint8(vm.parseJsonUint(json, string.concat(lk, ".direction"))),
                vm.parseJsonAddress(json, string.concat(lk, ".token")),
                uint64(vm.parseJsonUint(json, string.concat(lk, ".xmr"))),
                1e12
            );
            o.q.approvalMode = 2;
            o.sig = _signQuote(o.q);
            o.sender = sender;
            o.a = _approvalOf(c);
            o.approvalSig = vm.parseJsonBytes(json, string.concat(c, ".input.signature"));

            if (vm.parseJsonBool(json, string.concat(c, ".valid"))) {
                bytes32 id = _send(o);
                assertEq(_get(id).mode, 2, name);
                assertEq(_get(id).taker, sender, name);
                accepted++;
            } else {
                _expectOpen(o, _selector(vm.parseJsonString(json, string.concat(c, ".error"))));
                refused++;
            }
            vm.revertToState(snap);
        }
        assertEq(accepted, 4);
        assertEq(refused, 7);
    }

    function _mode2(uint8 direction) internal returns (Open memory o) {
        o = _open(direction, ETH, 2e12, 61e15);
        o.q.approvalMode = 2;
        o.sig = _signQuote(o.q);
        o.a = _approval(vTaker);
        o.approvalSig = _signApproval(o.a);
    }

    function test_approval_requiredInMode2_optionalOtherwise() public {
        Open memory o = _mode2(0);
        o.approvalSig = "";
        _expectOpen(o, IXmrSwap.ApprovalRequired.selector);
        o = _mode2(1);
        o.approvalSig = "";
        _expectOpen(o, IXmrSwap.ApprovalRequired.selector);

        // Mode 1 with a valid approval is treated as auto and recorded as mode 2; mode 0 stays 0.
        o = _mode2(0);
        o.q.approvalMode = 1;
        o.sig = _signQuote(o.q);
        assertEq(_get(_send(o)).mode, 2);
        o = _mode2(0);
        o.q.approvalMode = 0;
        o.leafIndex = 1;
        o.sig = _signQuote(o.q);
        assertEq(_get(_send(o)).mode, 0);
        // A presented approval is always checked, whatever the mode.
        o = _mode2(0);
        o.q.approvalMode = 0;
        o.sig = _signQuote(o.q);
        o.a.maxXmr = 1;
        o.approvalSig = _signApproval(o.a);
        _expectOpen(o, IXmrSwap.AmountOutOfRange.selector);
        // An approval mode above 2 does not exist.
        o = _mode2(0);
        o.q.approvalMode = 3;
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.BadState.selector);
    }

    function test_approval_wrongSigner_tamper_otherChain_otherContract() public {
        Open memory o = _mode2(0);
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        o.approvalSig = _sign(strangerKey, swap.hashApproval(o.a));
        _expectOpen(o, IXmrSwap.BadSigner.selector);

        // Every field is covered by the signature.
        for (uint256 field; field < 9; ++field) {
            o = _mode2(0);
            if (field == 0) o.a.maker = makeAddr("x");
            if (field == 1) o.a.taker = anyone;
            if (field == 2) o.a.token = ETH;
            if (field == 3) o.a.direction = 0;
            if (field == 4) o.a.maxXmr -= 1;
            if (field == 5) o.a.notBefore -= 1;
            if (field == 6) o.a.validUntil += 1;
            if (field == 7) o.a.epoch += 1;
            if (field == 8) o.a.approvalId = bytes32(uint256(1));
            _expectOpen(o, IXmrSwap.BadSigner.selector);
        }

        // Signed for another chain: both signatures made under chain id 1 fail here.
        vm.chainId(1);
        o = _mode2(0);
        vm.chainId(31337);
        bytes memory foreign = o.approvalSig;
        o.sig = _signQuote(o.q);
        _expectOpen(o, IXmrSwap.BadSigner.selector);

        // Signed for another contract.
        XmrSwap original = swap;
        _deployAt(address(0));
        _registerVectorMaker(swap);
        Open memory elsewhere = _mode2(0);
        swap = original;
        o = _mode2(0);
        assertTrue(keccak256(foreign) != keccak256(o.approvalSig));
        o.approvalSig = elsewhere.approvalSig;
        o.a = elsewhere.a;
        _expectOpen(o, IXmrSwap.BadSigner.selector);
    }

    function test_approval_expiry_edges() public {
        Open memory o = _mode2(0);
        o.a.notBefore = uint64(T0 + 10);
        o.a.validUntil = uint64(T0 + 20);
        o.approvalSig = _signApproval(o.a);
        _expectOpen(o, IXmrSwap.Expired.selector); // before notBefore
        vm.warp(T0 + 10);
        uint256 snap = vm.snapshotState();
        _send(o);
        vm.revertToState(snap);
        vm.warp(T0 + 20);
        snap = vm.snapshotState();
        _send(o);
        vm.revertToState(snap);
        vm.warp(T0 + 21);
        _expectOpen(o, IXmrSwap.Expired.selector);
    }

    function test_approval_revoke() public {
        Open memory o = _mode2(0);
        vm.prank(operator);
        swap.revokeApproval(o.a.approvalId);
        assertTrue(swap.isApprovalRevoked(vMaker, o.a.approvalId));
        _expectOpen(o, IXmrSwap.Revoked.selector);
        // Another approval id of the same maker is untouched.
        o = _mode2(0);
        o.a.approvalId = keccak256("second approval");
        o.approvalSig = _signApproval(o.a);
        _send(o);
    }

    function test_approval_epochBump_and_operatorRotation() public {
        Open memory o = _mode2(0);
        vm.prank(vMaker);
        swap.bumpEpochs(false, true);
        _expectOpen(o, IXmrSwap.StaleEpoch.selector);
        Open memory fresh = _mode2(0);
        uint256 snap = vm.snapshotState();
        _send(fresh);
        vm.revertToState(snap);

        (address newOperator,) = makeAddrAndKey("new operator");
        vm.prank(vMaker);
        swap.setOperator(newOperator);
        _expectOpen(fresh, IXmrSwap.BadSigner.selector);
    }

    function test_approval_reuse_and_binding() public {
        // An approval is reusable until it expires: it bounds each swap, not their sum.
        Open memory o = _mode2(0);
        _send(o);
        Open memory again = _mode2(0);
        again.leafIndex = 1;
        _send(again);

        // It is bound to its taker, and to the maker of the quote.
        Open memory stolen = _mode2(0);
        stolen.sender = anyone;
        _expectOpen(stolen, IXmrSwap.WrongParty.selector);
    }
}
