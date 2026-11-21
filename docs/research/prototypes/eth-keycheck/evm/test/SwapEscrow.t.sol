// SPDX-License-Identifier: MIT
pragma solidity ^0.8.31;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {SwapEscrowProto as E} from "../src/SwapEscrowProto.sol";
import {Secp256k1KeyCheck as K} from "../src/Secp256k1KeyCheck.sol";

/// Behaves like Circle's FiatToken for our purposes: 6 decimals, transfers revert when the sender,
/// the recipient or (for transferFrom) the caller is blacklisted.
contract MockUSDC is ERC20("USD Coin", "USDC") {
    mapping(address => bool) public blacklisted;

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function setBlacklisted(address a, bool b) external { blacklisted[a] = b; }

    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[from] && !blacklisted[to] && !blacklisted[msg.sender], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}

contract EscrowV2 is E {
    function version() external pure override returns (uint256) { return 2; }
}

contract RejectsEth {
    function register(E e, address op) external { e.registerMaker(op, bytes32(0)); }
}

contract SwapEscrowTest is Test {
    E esc;
    MockUSDC usdc;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address maker = makeAddr("makerOwner");
    address taker = makeAddr("taker");
    uint256 constant OP_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil key #0 (public test key)
    address op;

    // one-time key shares (< 2^252)
    uint256 constant S_MAKER = 0x0f06aa0dc349a8c557f6d69df2c703aa6070a254b10261736a19182d006ac6b3; // from the Rust DLEQ prototype
    uint256 constant S_TAKER = 0x0404040404040404040404040404040404040404040404040404040404040404;

    function setUp() public {
        vm.warp(1_800_000_000);
        op = vm.addr(OP_PK);
        E impl = new E();
        esc = E(address(new ERC1967Proxy(address(impl), abi.encodeCall(E.initialize, (owner, treasury)))));
        usdc = new MockUSDC();
        vm.prank(maker);
        esc.registerMaker(op, bytes32(uint256(0x5011)));
        vm.deal(taker, 100 ether);
        usdc.mint(taker, 1_000_000e6);
        vm.prank(taker);
        usdc.approve(address(esc), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _key(uint256 s) internal pure returns (address a, address a2) {
        a = vm.addr(s);
        a2 = vm.addr(mulmod(s, K.T2, K.N));
    }

    function _leaf(uint256 i, uint256 s) internal pure returns (bytes32) {
        (address a, address a2) = _key(s);
        return keccak256(bytes.concat(keccak256(abi.encode(i, a, a2))));
    }

    function _quote(address token, uint8 mode) internal view returns (E.Quote memory q) {
        q = E.Quote({
            maker: maker,
            token: token,
            price: 123e18,
            minAmount: token == address(0) ? 0.01 ether : 10e6,
            maxAmount: token == address(0) ? 10 ether : 50_000e6,
            maxTotal: token == address(0) ? 15 ether : 80_000e6,
            validUntil: uint64(block.timestamp + 180),
            epoch: 0,
            claimDelay: 3600,
            depositBps: 200,
            approvalMode: mode,
            keyRoot: _leaf(0, S_MAKER), // single-leaf tree: root == leaf, empty proof
            quoteId: keccak256("q1")
        });
    }

    function _keys() internal pure returns (E.Keys memory k) {
        (k.makerKey, k.makerKey2) = _key(S_MAKER);
        (k.takerKey, k.takerKey2) = _key(S_TAKER);
        k.makerKeyIndex = 0;
        k.makerKeyProof = new bytes32[](0);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _noApproval() internal pure returns (E.Approval memory a) {}

    function _lock(E.Quote memory q, bytes memory sig, uint256 amount) internal returns (bytes32) {
        vm.prank(taker);
        return esc.lock{value: q.token == address(0) ? amount : 0}(q, sig, amount, _keys(), _noApproval(), "");
    }

    // ------------------------------------------------------------ happy paths

    function test_eth_lock_claim() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        uint256 g = gasleft();
        bytes32 id = _lock(q, sig, 2 ether);
        console.log("lock (ETH) gas:", g - gasleft());
        assertEq(address(esc).balance, 2 ether);

        // anyone can submit the claim; the funds still go to the maker
        vm.expectEmit(true, false, false, true);
        emit E.Claimed(id, S_MAKER);
        g = gasleft();
        vm.prank(makeAddr("frontrunner"));
        esc.claim(id, S_MAKER);
        console.log("claim (ETH) gas:", g - gasleft());
        assertEq(maker.balance, 2 ether - 0.001 ether); // 0.05% fee
        assertEq(treasury.balance, 0.001 ether);
        assertEq(makeAddr("frontrunner").balance, 0);

        vm.expectRevert(E.BadState.selector);
        esc.claim(id, S_MAKER);
    }

    function test_usdc_lock_claim() public {
        E.Quote memory q = _quote(address(usdc), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        uint256 g = gasleft();
        bytes32 id = _lock(q, sig, 20_000e6);
        console.log("lock (USDC) gas:", g - gasleft());
        g = gasleft();
        esc.claim(id, S_MAKER);
        console.log("claim (USDC) gas:", g - gasleft());
        assertEq(usdc.balanceOf(maker), 20_000e6 - 10e6);
        assertEq(usdc.balanceOf(treasury), 10e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function test_refund_reveals_taker_secret() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes32 id = _lock(q, _sign(OP_PK, esc.hashQuote(q)), 1 ether);
        vm.expectRevert(E.TooEarly.selector);
        esc.refund(id, S_TAKER);
        vm.warp(block.timestamp + 3600);
        vm.expectRevert(E.BadSecret.selector);
        esc.refund(id, S_MAKER);
        esc.refund(id, S_TAKER);
        assertEq(taker.balance, 100 ether);
    }

    function test_claim_rejects_wrong_or_aliased_secret() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes32 id = _lock(q, _sign(OP_PK, esc.hashQuote(q)), 1 ether);
        vm.expectRevert(E.BadSecret.selector);
        esc.claim(id, S_TAKER);
        // (s + n aliasing cannot even be expressed here: s + n overflows uint256 for any s > 2^128.4;
        //  the small-s case is covered in KeyCheck.t.sol)
        vm.expectRevert(E.BadSecret.selector);
        esc.claim(id, S_MAKER + 1);
        vm.expectRevert(E.BadSecret.selector);
        esc.claim(id, 0);
    }

    // ------------------------------------------------------------ quote replay protection

    function test_quote_wrongSigner() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(0xBEEF, esc.hashQuote(q));
        vm.expectRevert(E.BadSigner.selector);
        _lock(q, sig, 1 ether);
    }

    function test_quote_tampered() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        q.price = 1; // taker tries to improve the price
        vm.expectRevert(E.BadSigner.selector);
        _lock(q, sig, 1 ether);
    }

    function test_quote_expired() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        vm.warp(q.validUntil); // still valid at the boundary
        bytes32 id = _lock(q, sig, 1 ether);
        assertTrue(id != bytes32(0));
        vm.warp(q.validUntil + 1);
        vm.expectRevert(E.Expired.selector);
        _lock(q, sig, 1 ether);
    }

    function test_quote_otherChain() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q)); // signed for chainId 31337
        vm.chainId(1);
        vm.expectRevert(E.BadSigner.selector);
        _lock(q, sig, 1 ether);
    }

    function test_quote_otherContract() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        E other = E(address(new ERC1967Proxy(address(new E()), abi.encodeCall(E.initialize, (owner, treasury)))));
        vm.prank(maker);
        other.registerMaker(op, bytes32(0));
        assertTrue(other.domainSeparator() != esc.domainSeparator());
        vm.prank(taker);
        vm.expectRevert(E.BadSigner.selector);
        other.lock{value: 1 ether}(q, sig, 1 ether, _keys(), _noApproval(), "");
    }

    function test_quote_cancelled_and_epochBump_and_operatorRotation() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        uint256 snap = vm.snapshotState();

        vm.prank(maker);
        esc.cancelQuote(q.quoteId);
        vm.expectRevert(E.Cancelled.selector);
        _lock(q, sig, 1 ether);

        vm.revertToState(snap);
        vm.prank(maker);
        esc.bumpEpochs(true, false);
        vm.expectRevert(E.StaleEpoch.selector);
        _lock(q, sig, 1 ether);

        vm.revertToState(snap);
        vm.prank(maker);
        esc.registerMaker(makeAddr("newOperator"), bytes32(0)); // rotating the hot key kills old quotes
        vm.expectRevert(E.BadSigner.selector);
        _lock(q, sig, 1 ether);
    }

    function test_quote_limits_and_oneTimeKey() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));
        vm.expectRevert(E.AmountOutOfRange.selector);
        _lock(q, sig, 11 ether);
        vm.expectRevert(E.AmountOutOfRange.selector);
        _lock(q, sig, 0.001 ether);
        _lock(q, sig, 1 ether);
        // the same quote may be taken again, but never with the same one-time key
        vm.expectRevert(E.KeyAlreadyUsed.selector);
        _lock(q, sig, 1 ether);
    }

    function test_quote_cumulativeCap_twoLeafPool() public {
        // pool of two one-time keys: leaves sorted-pair hashed (OpenZeppelin MerkleProof convention)
        uint256 sB = 0x0777;
        bytes32 l0 = _leaf(0, S_MAKER);
        bytes32 l1 = _leaf(1, sB);
        E.Quote memory q = _quote(address(0), 0);
        q.keyRoot = l0 < l1 ? keccak256(abi.encode(l0, l1)) : keccak256(abi.encode(l1, l0));
        bytes memory sig = _sign(OP_PK, esc.hashQuote(q));

        E.Keys memory k = _keys();
        k.makerKeyProof = new bytes32[](1);
        k.makerKeyProof[0] = l1;
        vm.prank(taker);
        esc.lock{value: 10 ether}(q, sig, 10 ether, k, _noApproval(), "");

        (k.makerKey, k.makerKey2) = _key(sB);
        k.makerKeyIndex = 1;
        k.makerKeyProof[0] = l0;
        vm.prank(taker);
        vm.expectRevert(E.CapExceeded.selector); // 10 + 10 > maxTotal 15
        esc.lock{value: 10 ether}(q, sig, 10 ether, k, _noApproval(), "");
        vm.prank(taker);
        esc.lock{value: 4 ether}(q, sig, 4 ether, k, _noApproval(), "");

        // a key that is not in the pool is rejected
        (k.makerKey, k.makerKey2) = _key(0x999);
        vm.prank(taker);
        vm.expectRevert(E.BadKey.selector);
        esc.lock{value: 0.01 ether}(q, sig, 0.01 ether, k, _noApproval(), "");
    }

    // ------------------------------------------------------------ advance approval

    function _approval(address who) internal view returns (E.Approval memory a) {
        a = E.Approval({
            maker: maker,
            taker: who,
            token: address(usdc),
            maxTotal: 30_000e6,
            validUntil: uint64(block.timestamp + 7 days),
            epoch: 0,
            approvalId: keccak256("a1")
        });
    }

    function test_advanceApproval() public {
        E.Quote memory q = _quote(address(usdc), 2);
        bytes memory qs = _sign(OP_PK, esc.hashQuote(q));
        E.Approval memory a = _approval(taker);
        bytes memory as_ = _sign(OP_PK, esc.hashApproval(a));

        // no approval presented
        vm.prank(taker);
        vm.expectRevert(E.ApprovalRequired.selector);
        esc.lock(q, qs, 20_000e6, _keys(), _noApproval(), "");

        // someone else's approval
        address mallory = makeAddr("mallory");
        usdc.mint(mallory, 50_000e6);
        vm.startPrank(mallory);
        usdc.approve(address(esc), type(uint256).max);
        vm.expectRevert(E.WrongParty.selector);
        esc.lock(q, qs, 20_000e6, _keys(), a, as_);
        vm.stopPrank();

        // approval signed by a key that is not the maker's operator
        bytes memory forged = _sign(0xBEEF, esc.hashApproval(a));
        vm.prank(taker);
        vm.expectRevert(E.BadSigner.selector);
        esc.lock(q, qs, 20_000e6, _keys(), a, forged);

        // valid
        vm.prank(taker);
        esc.lock(q, qs, 20_000e6, _keys(), a, as_);

        // cumulative size limit: 20k + 20k > 30k (checked before the key, so the same keys are fine here)
        vm.prank(taker);
        vm.expectRevert(E.CapExceeded.selector);
        esc.lock(q, qs, 20_000e6, _keys(), a, as_);
    }

    function test_advanceApproval_expiry_revoke_epoch() public {
        E.Quote memory q = _quote(address(usdc), 2);
        q.validUntil = uint64(block.timestamp + 30 days);
        bytes memory qs = _sign(OP_PK, esc.hashQuote(q));
        E.Approval memory a = _approval(taker);
        bytes memory as_ = _sign(OP_PK, esc.hashApproval(a));
        uint256 snap = vm.snapshotState();

        vm.warp(a.validUntil + 1);
        vm.prank(taker);
        vm.expectRevert(E.Expired.selector);
        esc.lock(q, qs, 1_000e6, _keys(), a, as_);

        vm.revertToState(snap);
        vm.prank(maker);
        esc.revokeApproval(a);
        vm.prank(taker);
        vm.expectRevert(E.Cancelled.selector);
        esc.lock(q, qs, 1_000e6, _keys(), a, as_);

        vm.revertToState(snap);
        vm.prank(maker);
        esc.bumpEpochs(false, true);
        vm.prank(taker);
        vm.expectRevert(E.StaleEpoch.selector);
        esc.lock(q, qs, 1_000e6, _keys(), a, as_);
    }

    // ------------------------------------------------------------ USDC blacklist / hostile recipients

    function test_usdc_blacklistedMaker_claimStillSucceeds() public {
        E.Quote memory q = _quote(address(usdc), 0);
        bytes32 id = _lock(q, _sign(OP_PK, esc.hashQuote(q)), 20_000e6);
        usdc.setBlacklisted(maker, true);

        esc.claim(id, S_MAKER); // must not revert: the secret is public the moment this tx is broadcast
        assertEq(usdc.balanceOf(maker), 0);
        assertEq(esc.owed(address(usdc), maker), 20_000e6 - 10e6);
        assertEq(usdc.balanceOf(treasury), 10e6);

        vm.prank(maker);
        vm.expectRevert(); // still blacklisted: the pull fails, the debt stays
        esc.withdrawOwed(address(usdc));
        usdc.setBlacklisted(maker, false);
        vm.prank(maker);
        esc.withdrawOwed(address(usdc));
        assertEq(usdc.balanceOf(maker), 20_000e6 - 10e6);
    }

    function test_usdc_blacklistedEscrow_freezesEverything() public {
        E.Quote memory q = _quote(address(usdc), 0);
        bytes32 id = _lock(q, _sign(OP_PK, esc.hashQuote(q)), 20_000e6);
        usdc.setBlacklisted(address(esc), true);
        // claim does not revert (secret revealed, XMR leg completes) but nothing can leave the contract
        esc.claim(id, S_MAKER);
        assertEq(usdc.balanceOf(address(esc)), 20_000e6);
        assertEq(esc.owed(address(usdc), maker) + esc.owed(address(usdc), treasury), 20_000e6);
    }

    function test_eth_recipientRejectsEth_claimStillSucceeds() public {
        RejectsEth bad = new RejectsEth();
        bad.register(esc, op);
        E.Quote memory q = _quote(address(0), 0);
        q.maker = address(bad);
        bytes32 id = _lock(q, _sign(OP_PK, esc.hashQuote(q)), 1 ether);
        esc.claim(id, S_MAKER);
        assertEq(esc.owed(address(0), address(bad)), 1 ether - 0.0005 ether);
    }

    // ------------------------------------------------------------ upgrades, then immutability

    function test_upgrade_then_renounce() public {
        E.Quote memory q = _quote(address(0), 0);
        bytes32 id = _lock(q, _sign(OP_PK, esc.hashQuote(q)), 1 ether);
        bytes32 domainBefore = esc.domainSeparator();

        EscrowV2 v2 = new EscrowV2();
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, taker));
        esc.upgradeToAndCall(address(v2), "");

        vm.prank(owner);
        esc.upgradeToAndCall(address(v2), "");
        assertEq(esc.version(), 2);
        assertEq(esc.domainSeparator(), domainBefore); // signed quotes survive an upgrade
        esc.claim(id, S_MAKER); // in-flight swap state survived
        assertEq(maker.balance, 1 ether - 0.0005 ether);

        vm.prank(owner);
        esc.renounceOwnership();
        assertEq(esc.owner(), address(0));
        E v3 = new E();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        esc.upgradeToAndCall(address(v3), "");
        // Quirk worth knowing: owner() == address(0) now, so a *simulated* call with from = 0x0 (eth_call,
        // or this prank) passes onlyOwner. Nobody holds a key for address(0), so no real transaction can.
        uint256 snap = vm.snapshotState();
        vm.prank(address(0));
        esc.upgradeToAndCall(address(v3), "");
        vm.revertToState(snap);
    }

    function test_implementation_cannot_be_initialized() public {
        E impl = new E();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), treasury);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        esc.initialize(address(this), treasury);
    }

    /// Signature produced OUTSIDE Solidity/forge by `cast wallet sign --data --from-file quote.json`
    /// (alloy's EIP-712 implementation) over the JSON typed data the taker UI would build with viem.
    function test_quote_signedByCast_typedDataJson() public {
        assertEq(address(esc), 0x2e234DAe75C793f67A35089C9d99245E1C58470b); // verifyingContract in quote.json
        assertEq(block.chainid, 31337);
        E.Quote memory q = _quote(address(0), 0);
        bytes memory sig = vm.parseBytes(vm.readFile("test/quote.sig"));
        assertEq(sig.length, 65);
        bytes32 id = _lock(q, sig, 1 ether);
        assertTrue(id != bytes32(0));
    }

    function test_print_fixture() public view {
        console.log("escrow proxy:", address(esc));
        console.log("operator:", op);
        console.logBytes32(esc.domainSeparator());
        E.Quote memory q = _quote(address(0), 0);
        console.log("validUntil", q.validUntil);
        console.logBytes32(q.keyRoot);
        console.logBytes32(q.quoteId);
        console.logBytes32(esc.hashQuote(q));
    }
}
