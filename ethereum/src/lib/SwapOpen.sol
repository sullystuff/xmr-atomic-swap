// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {SwapMath} from "./SwapMath.sol";
import {SwapStore} from "./SwapStore.sol";

/// @notice `lock` (A1) and `take` (B1) of SPEC 5.3. A linked library: `XmrSwap` enters it by
/// DELEGATECALL, so `msg.sender`, the value and the storage are the proxy's. The EIP-712 digests
/// are computed by `XmrSwap` (they need its domain) and passed in.
library SwapOpen {
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address taker,address token,uint8 direction,uint8 approvalMode,uint64 minXmr,uint64 maxXmr,uint64[3] tierXmr,uint256[3] tierPrice,uint64[3] depthXmr,uint8[3] depth,uint16 depositBps,uint32 approvalWindow,uint32 noticeWindow,uint32 claimDelay,uint32 claimWindow,uint32 finalWindow,uint64 validUntil,uint32 epoch,bytes32 keyRoot,uint64 quoteId)"
    );
    bytes32 private constant APPROVAL_TYPEHASH = keccak256(
        "Approval(address maker,address taker,address token,uint8 direction,uint64 maxXmr,uint64 notBefore,uint64 validUntil,uint32 epoch,bytes32 approvalId)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("XmrAtomicSwap");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// The domain separator of `EIP712Upgradeable` initialised with ("XmrAtomicSwap", "1"). Entered
    /// by DELEGATECALL, so `address(this)` is the proxy.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _typedDigest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// EIP-712 digest of a quote (SPEC 2.10).
    function quoteDigest(IXmrSwap.Quote calldata q) public view returns (bytes32) {
        // Fixed-size arrays hash as keccak256 of their concatenated 32-byte element encodings.
        return _typedDigest(
            keccak256(
                bytes.concat(
                    abi.encode(
                        QUOTE_TYPEHASH,
                        q.maker,
                        q.taker,
                        q.token,
                        q.direction,
                        q.approvalMode,
                        q.minXmr,
                        q.maxXmr,
                        keccak256(abi.encodePacked(q.tierXmr)),
                        keccak256(abi.encodePacked(q.tierPrice)),
                        keccak256(abi.encodePacked(q.depthXmr)),
                        keccak256(abi.encodePacked(q.depth))
                    ),
                    abi.encode(
                        q.depositBps,
                        q.approvalWindow,
                        q.noticeWindow,
                        q.claimDelay,
                        q.claimWindow,
                        q.finalWindow,
                        q.validUntil,
                        q.epoch,
                        q.keyRoot,
                        q.quoteId
                    )
                )
            )
        );
    }

    /// EIP-712 digest of an advance approval (SPEC 2.10).
    function approvalDigest(IXmrSwap.Approval calldata a) public view returns (bytes32) {
        return _typedDigest(
            keccak256(
                abi.encode(
                    APPROVAL_TYPEHASH,
                    a.maker,
                    a.taker,
                    a.token,
                    a.direction,
                    a.maxXmr,
                    a.notBefore,
                    a.validUntil,
                    a.epoch,
                    a.approvalId
                )
            )
        );
    }

    function lock(
        IXmrSwap.Quote calldata q,
        bytes calldata sig,
        uint64 xmr,
        uint256 maxPay,
        bytes16 swapNonce,
        address sessionKey,
        uint256 sessionBudget,
        IXmrSwap.TakerKeys calldata tk,
        IXmrSwap.PoolLeaf calldata leaf,
        IXmrSwap.Approval calldata a,
        bytes calldata approvalSig
    ) external returns (bytes32 swapId) {
        SwapStore.Layout storage $ = SwapStore.layout();
        IXmrSwap.Swap storage s;
        (swapId, s) = _open($, q, sig, xmr, maxPay, swapNonce, a, approvalSig, 0);
        if (!SwapMath.viewValid(tk.viewShare)) revert IXmrSwap.ViewInvalid();
        // The named leaf of the quote's key pool: written provisionally, consumed at approval.
        if (leaf.key == address(0) || leaf.key2 == address(0) || leaf.spendPub == 0) revert IXmrSwap.BadKey();
        bytes32 leafHash = SwapMath.leafHash(leaf.index, leaf.key, leaf.key2, leaf.spendPub);
        if (!MerkleProof.verifyCalldata(leaf.proof, q.keyRoot, leafHash)) revert IXmrSwap.BadKey();
        if ($.keyUsed[q.maker][leaf.key]) revert IXmrSwap.KeyAlreadyUsed();
        s.makerKey = leaf.key;
        s.makerKey2 = leaf.key2;
        s.makerSpendPub = leaf.spendPub;
        s.lockerView = tk.viewShare;
        s.keyLeaf = leafHash;
        _finishOpen($, swapId, s, sessionKey, sessionBudget, tk, s.amount, SwapStore.C_LOCKS);
    }

    function take(
        IXmrSwap.Quote calldata q,
        bytes calldata sig,
        uint64 xmr,
        uint256 minReceive,
        bytes16 swapNonce,
        address sessionKey,
        uint256 sessionBudget,
        IXmrSwap.TakerKeys calldata tk,
        IXmrSwap.Approval calldata a,
        bytes calldata approvalSig
    ) external returns (bytes32 swapId) {
        SwapStore.Layout storage $ = SwapStore.layout();
        IXmrSwap.Swap storage s;
        (swapId, s) = _open($, q, sig, xmr, minReceive, swapNonce, a, approvalSig, 1);
        // Direction B: the locker's view share is the maker's, supplied by `fund`.
        if (tk.viewShare != 0) revert IXmrSwap.ViewInvalid();
        _finishOpen($, swapId, s, sessionKey, sessionBudget, tk, s.deposit, SwapStore.C_TAKES);
    }

    /// Everything `lock` and `take` share up to the terms: quote, price, approval mode, bounds.
    function _open(
        SwapStore.Layout storage $,
        IXmrSwap.Quote calldata q,
        bytes calldata sig,
        uint64 xmr,
        uint256 limit,
        bytes16 swapNonce,
        IXmrSwap.Approval calldata a,
        bytes calldata approvalSig,
        uint8 direction
    ) private returns (bytes32 swapId, IXmrSwap.Swap storage s) {
        swapId = SwapMath.swapIdOf(msg.sender, swapNonce);
        s = $.swaps[swapId];
        if (s.state != 0) revert IXmrSwap.BadState(); // a swap id can never be reused

        IXmrSwap.Maker storage m = $.makers[q.maker];
        if (m.registeredAt == 0) revert IXmrSwap.NotRegistered();
        if (m.paused) revert IXmrSwap.Paused();
        _checkSigner(quoteDigest(q), sig, m.operator);
        if (block.timestamp > q.validUntil) revert IXmrSwap.Expired();
        if (q.epoch != m.quoteEpoch) revert IXmrSwap.StaleEpoch();
        if ($.quoteCancelled[q.maker][q.quoteId]) revert IXmrSwap.Cancelled();
        if (q.direction != direction) revert IXmrSwap.WrongDirection();
        if (q.taker != address(0)) {
            if (q.taker != msg.sender) revert IXmrSwap.WrongParty();
            $.quoteCancelled[q.maker][q.quoteId] = true; // a taker-bound quote is single-use
        }
        if (q.token != address(0) && q.token != $.usdc) revert IXmrSwap.TokenNotAllowed();

        // Price and depth for this size.
        (bool ok, uint256 price) = SwapMath.tierValue(xmr, q.tierXmr, q.tierPrice);
        if (!ok) revert IXmrSwap.TiersInvalid();
        uint256 depth;
        // An unusable first depth tier is reported by the depth bound (`DepthInvalid`).
        if (q.depth[0] != 0) {
            (ok, depth) = SwapMath.tierValue(xmr, q.depthXmr, [uint256(q.depth[0]), q.depth[1], q.depth[2]]);
            if (!ok) revert IXmrSwap.TiersInvalid();
        }
        if (xmr < q.minXmr || xmr > q.maxXmr) revert IXmrSwap.AmountOutOfRange();
        uint256 amount;
        (ok, amount) = direction == 0 ? SwapMath.payAmount(xmr, price) : SwapMath.receiveAmount(xmr, price);
        if (!ok || amount == 0) revert IXmrSwap.AmountOutOfRange();
        if (direction == 0 ? amount > limit : amount < limit) revert IXmrSwap.PriceMoved();

        // Effective mode (SPEC 3.8). Every accepted swap still starts SwapStore.PENDING.
        uint8 mode = q.approvalMode;
        if (mode > 2) revert IXmrSwap.BadState();
        if (approvalSig.length != 0) {
            _checkApproval($, q, a, approvalSig, xmr, m);
            if (mode == 1) mode = 2;
        } else if (mode == 2 && q.taker == address(0)) {
            revert IXmrSwap.ApprovalRequired();
        }
        if (q.taker != address(0)) mode = 3;

        SwapMath.checkBounds(
            q.depositBps,
            q.approvalWindow,
            q.noticeWindow,
            depth,
            q.claimDelay,
            q.claimWindow,
            q.finalWindow,
            SwapMath.PENDING_APPROVAL
        );
        if (m.openPending >= SwapMath.MAX_OPEN_PENDING) revert IXmrSwap.TooManyPending();
        unchecked {
            m.openPending += 1;
        }

        s.taker = msg.sender;
        s.maker = q.maker;
        s.token = q.token;
        s.swapNonce = swapNonce;
        s.state = SwapStore.PENDING;
        s.direction = direction;
        s.mode = mode;
        s.outcome = SwapStore.C_NONE;
        s.depth = uint8(depth);
        s.depBps = q.depositBps;
        s.xmr = xmr;
        s.amount = amount;
        s.deposit = SwapMath.bpsOf(amount, q.depositBps);
        s.price = price;
        s.noticeWindow = q.noticeWindow;
        s.claimDelay = q.claimDelay;
        s.claimWindow = q.claimWindow;
        s.tLock = uint64(block.timestamp);
        s.tPendingDeadline = uint64(block.timestamp + q.approvalWindow);
        s.tFinal = uint64(block.timestamp + q.finalWindow);
    }

    /// Advance approval (SPEC 2.10): same signer as the quote, bound to the caller.
    function _checkApproval(
        SwapStore.Layout storage $,
        IXmrSwap.Quote calldata q,
        IXmrSwap.Approval calldata a,
        bytes calldata approvalSig,
        uint64 xmr,
        IXmrSwap.Maker storage m
    ) private view {
        _checkSigner(approvalDigest(a), approvalSig, m.operator);
        if (a.maker != q.maker || a.taker != msg.sender) revert IXmrSwap.WrongParty();
        if (a.token != SwapStore.ANY_TOKEN && a.token != q.token) revert IXmrSwap.TokenNotAllowed();
        if (a.direction != SwapStore.ANY_DIRECTION && a.direction != q.direction) revert IXmrSwap.WrongDirection();
        if (xmr > a.maxXmr) revert IXmrSwap.AmountOutOfRange();
        if (block.timestamp < a.notBefore || block.timestamp > a.validUntil) revert IXmrSwap.Expired();
        if (a.epoch != m.approvalEpoch) revert IXmrSwap.StaleEpoch();
        if ($.approvalRevoked[keccak256(abi.encode(a.maker, a.approvalId))]) revert IXmrSwap.Revoked();
    }

    /// Taker keys, open hash, funds in, session budget out.
    function _finishOpen(
        SwapStore.Layout storage $,
        bytes32 swapId,
        IXmrSwap.Swap storage s,
        address sessionKey,
        uint256 sessionBudget,
        IXmrSwap.TakerKeys calldata tk,
        uint256 stake,
        uint8 counter
    ) private {
        if (tk.key == address(0) || tk.key2 == address(0) || tk.spendPub == 0 || tk.encKey == 0) {
            revert IXmrSwap.BadKey();
        }
        s.sessionKey = sessionKey;
        s.makerEncVersion = tk.makerEncVersion;
        s.takerKey = tk.key;
        s.takerKey2 = tk.key2;
        s.takerSpendPub = tk.spendPub;
        s.takerEncKey = tk.encKey;
        s.makerEncKey = tk.makerEncKey;
        s.openHash = SwapMath.openHash(swapId, s, tk.viewShare);
        $.swapsByTaker[msg.sender].push(swapId);
        address maker = s.maker;
        SwapStore._count($, maker, counter);
        emit IXmrSwap.Locked(
            swapId,
            maker,
            msg.sender,
            counter,
            s.token,
            s.direction,
            s.mode,
            s.amount,
            s.deposit,
            s.xmr,
            s.depth,
            s.swapNonce,
            tk,
            s.keyLeaf
        );

        SwapStore._pull(s.token, stake, sessionBudget);
        if (sessionBudget != 0) {
            // The session key is an externally owned account derived in the page.
            if (sessionKey == address(0)) revert IXmrSwap.BadValue();
            (bool sent,) = sessionKey.call{value: sessionBudget, gas: SwapStore.ETH_STIPEND}("");
            if (!sent) revert IXmrSwap.BadValue();
        }
    }

    /// 65-byte `r || s || v`, low-s, EOA only. Every failure is `BadSigner`.
    function _checkSigner(bytes32 digest, bytes calldata sig, address operator) private pure {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != operator) revert IXmrSwap.BadSigner();
    }
}
