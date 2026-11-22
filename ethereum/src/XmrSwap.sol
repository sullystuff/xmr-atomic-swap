// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";
import {SwapMath} from "./lib/SwapMath.sol";
import {SwapOpen} from "./lib/SwapOpen.sol";
import {SwapSettle} from "./lib/SwapSettle.sol";
import {SwapStore} from "./lib/SwapStore.sol";

/// @title XmrSwap: escrow for XMR atomic swaps against ETH and USDC (SPEC section 5).
/// @notice One escrow machine for both directions; the state machine is SPEC section 3 with
/// EXPLICIT_APPROVE = true. The owner's only power is upgrading; `renounceOwnership()` freezes the
/// contract for good. Nothing here is audited.
/// @dev This contract holds the set-up, the maker registry, the views and one thin entry point
/// per swap call. The bodies of the swap calls live in two linked libraries, `SwapOpen` (lock,
/// take, EIP-712) and `SwapSettle` (every other transition), which run by DELEGATECALL in this
/// contract's context: together they exceed the 24,576-byte limit of EIP-170. All state is in one
/// ERC-7201 namespaced struct (`SwapStore.Layout`, namespace `xmrswap.storage.v1`).
contract XmrSwap is
    IXmrSwap,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    // ------------------------------------------------------------------ set-up and upgrades

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice The treasury address, the USDC address and every constant are fixed here or in the
    /// implementation; the owner can only upgrade.
    function initialize(address owner_, address treasury_, address usdc_) external initializer {
        if (treasury_ == address(0) || usdc_ == address(0)) revert BadValue();
        __Ownable_init(owner_);
        __EIP712_init("XmrAtomicSwap", "1");
        SwapStore.Layout storage $ = SwapStore.layout();
        $.treasury = treasury_;
        $.usdc = usdc_;
    }

    /// @dev After `renounceOwnership()` the owner is address(0) and no upgrade can ever pass.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ------------------------------------------------------------------ registry

    /// @inheritdoc IXmrSwap
    function registerMaker(address operator, address payout, bytes32 solanaOwner) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        Maker storage m = $.makers[msg.sender];
        if (m.registeredAt != 0) revert AlreadyRegistered();
        if (payout == address(0)) revert BadValue();
        _indexOperator($, msg.sender, operator);
        m.operator = operator;
        m.payout = payout;
        m.registeredAt = uint64(block.timestamp);
        m.solanaOwner = solanaOwner;
        emit MakerRegistered(msg.sender, operator, payout, solanaOwner);
    }

    /// @inheritdoc IXmrSwap
    function setOperator(address operator) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        Maker storage m = _ownMaker($);
        if (operator != m.operator) {
            delete $.makerOfOperator[m.operator];
            _indexOperator($, msg.sender, operator);
            m.operator = operator;
        }
        unchecked {
            m.quoteEpoch += 1;
            m.approvalEpoch += 1;
        }
        emit OperatorChanged(msg.sender, operator, m.quoteEpoch, m.approvalEpoch);
    }

    /// @inheritdoc IXmrSwap
    function setPayout(address payout) external {
        Maker storage m = _ownMaker(SwapStore.layout());
        if (payout == address(0)) revert BadValue();
        m.payout = payout;
        emit PayoutChanged(msg.sender, payout);
    }

    /// @inheritdoc IXmrSwap
    function setSolanaLink(bytes32 solanaOwner) external {
        Maker storage m = _ownMaker(SwapStore.layout());
        // First promote a matured pending link.
        if (m.solanaOwnerNextAt != 0 && block.timestamp >= m.solanaOwnerNextAt) {
            m.solanaOwner = m.solanaOwnerNext;
            m.solanaOwnerNext = 0;
            m.solanaOwnerNextAt = 0;
        }
        bytes32 old = m.solanaOwner;
        uint64 effectiveAt;
        if (old == 0 && m.solanaOwnerNextAt == 0) {
            // No link and none pending: set at once.
            m.solanaOwner = solanaOwner;
            effectiveAt = uint64(block.timestamp);
        } else {
            // A change or a removal (zero) takes effect after the delay.
            effectiveAt = uint64(block.timestamp + SwapMath.LINK_DELAY_SECS);
            m.solanaOwnerNext = solanaOwner;
            m.solanaOwnerNextAt = effectiveAt;
        }
        emit LinkChanged(msg.sender, old, solanaOwner, effectiveAt);
    }

    /// @inheritdoc IXmrSwap
    function setPaused(bool paused) external {
        (address maker, Maker storage m) = _callerMaker(SwapStore.layout());
        m.paused = paused;
        emit PausedChanged(maker, paused);
    }

    /// @inheritdoc IXmrSwap
    function bumpEpochs(bool quotes, bool approvals) external {
        (address maker, Maker storage m) = _callerMaker(SwapStore.layout());
        unchecked {
            if (quotes) m.quoteEpoch += 1;
            if (approvals) m.approvalEpoch += 1;
        }
        emit EpochsBumped(maker, m.quoteEpoch, m.approvalEpoch);
    }

    /// @inheritdoc IXmrSwap
    function cancelQuote(uint64 quoteId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        (address maker,) = _callerMaker($);
        $.quoteCancelled[maker][quoteId] = true;
        emit QuoteCancelled(maker, quoteId);
    }

    /// @inheritdoc IXmrSwap
    function revokeApproval(bytes32 approvalId) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        (address maker,) = _callerMaker($);
        $.approvalRevoked[keccak256(abi.encode(maker, approvalId))] = true;
        emit ApprovalRevoked(maker, approvalId);
    }

    /// The caller's own maker record (owner-only functions).
    function _ownMaker(SwapStore.Layout storage $) private view returns (Maker storage m) {
        m = $.makers[msg.sender];
        if (m.registeredAt == 0) revert NotRegistered();
    }

    /// The record the caller may act for: its own if it is a maker, else the one it operates.
    function _callerMaker(SwapStore.Layout storage $) private view returns (address maker, Maker storage m) {
        maker = msg.sender;
        m = $.makers[maker];
        if (m.registeredAt == 0) {
            maker = $.makerOfOperator[msg.sender];
            if (maker == address(0)) revert NotRegistered();
            m = $.makers[maker];
        }
    }

    /// Operators are unique across makers so that operator-callable registry functions, which take
    /// no maker argument, name exactly one record.
    function _indexOperator(SwapStore.Layout storage $, address maker, address operator) private {
        if (operator == address(0)) revert BadValue();
        if ($.makerOfOperator[operator] != address(0)) revert AlreadyRegistered();
        $.makerOfOperator[operator] = maker;
    }

    // ------------------------------------------------------------------ hashing

    /// @inheritdoc IXmrSwap
    function hashQuote(Quote calldata q) external view returns (bytes32) {
        return SwapOpen.quoteDigest(q);
    }

    /// @inheritdoc IXmrSwap
    function hashApproval(Approval calldata a) external view returns (bytes32) {
        return SwapOpen.approvalDigest(a);
    }

    /// @inheritdoc IXmrSwap
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ swaps
    // The bodies live in the linked libraries `SwapOpen` and `SwapSettle` (EIP-170 size limit);
    // they run by DELEGATECALL in this contract's context. The reentrancy guard stays here.

    /// @inheritdoc IXmrSwap
    function lock(
        Quote calldata q,
        bytes calldata sig,
        uint64 xmr,
        uint256 maxPay,
        bytes16 swapNonce,
        address sessionKey,
        uint256 sessionBudget,
        TakerKeys calldata tk,
        PoolLeaf calldata leaf,
        Approval calldata a,
        bytes calldata approvalSig
    ) external payable nonReentrant returns (bytes32 swapId) {
        return SwapOpen.lock(q, sig, xmr, maxPay, swapNonce, sessionKey, sessionBudget, tk, leaf, a, approvalSig);
    }

    /// @inheritdoc IXmrSwap
    function take(
        Quote calldata q,
        bytes calldata sig,
        uint64 xmr,
        uint256 minReceive,
        bytes16 swapNonce,
        address sessionKey,
        uint256 sessionBudget,
        TakerKeys calldata tk,
        Approval calldata a,
        bytes calldata approvalSig
    ) external payable nonReentrant returns (bytes32 swapId) {
        return SwapOpen.take(q, sig, xmr, minReceive, swapNonce, sessionKey, sessionBudget, tk, a, approvalSig);
    }

    /// @inheritdoc IXmrSwap
    function approve(bytes32 swapId, bytes32 expectedOpen) external nonReentrant {
        SwapSettle.approve(swapId, expectedOpen);
    }

    /// @inheritdoc IXmrSwap
    function fund(bytes32 swapId, bytes32 expectedOpen, address key, address key2, bytes32 spendPub, bytes32 viewShare)
        external
        payable
        nonReentrant
    {
        SwapSettle.fund(swapId, expectedOpen, key, key2, spendPub, viewShare);
    }

    /// @inheritdoc IXmrSwap
    function reject(bytes32 swapId, bytes32 expectedOpen, uint8 reason) external nonReentrant {
        SwapSettle.reject(swapId, expectedOpen, reason);
    }

    /// @inheritdoc IXmrSwap
    function cancelPending(bytes32 swapId) external nonReentrant {
        SwapSettle.cancelPending(swapId);
    }

    /// @inheritdoc IXmrSwap
    function expirePending(bytes32 swapId) external nonReentrant {
        SwapSettle.expirePending(swapId);
    }

    /// @inheritdoc IXmrSwap
    function postNotice(bytes32 swapId, bytes32 commitment, bytes calldata ciphertext) external nonReentrant {
        SwapSettle.postNotice(swapId, commitment, ciphertext);
    }

    /// @inheritdoc IXmrSwap
    function setReady(bytes32 swapId) external nonReentrant {
        SwapSettle.setReady(swapId);
    }

    /// @inheritdoc IXmrSwap
    function abort(bytes32 swapId) external nonReentrant {
        SwapSettle.abort(swapId);
    }

    /// @inheritdoc IXmrSwap
    function refundUnnoticed(bytes32 swapId) external nonReentrant {
        SwapSettle.refundUnnoticed(swapId);
    }

    /// @inheritdoc IXmrSwap
    function expireUnnoticed(bytes32 swapId) external nonReentrant {
        SwapSettle.expireUnnoticed(swapId);
    }

    /// @inheritdoc IXmrSwap
    function refund(bytes32 swapId, uint256 secret) external nonReentrant {
        SwapSettle.refund(swapId, secret);
    }

    /// @inheritdoc IXmrSwap
    function claim(bytes32 swapId, uint256 secret) external nonReentrant {
        SwapSettle.claim(swapId, secret);
    }

    /// @inheritdoc IXmrSwap
    function releaseDeposit(bytes32 swapId) external nonReentrant {
        SwapSettle.releaseDeposit(swapId);
    }

    /// @inheritdoc IXmrSwap
    function withhold(bytes32 swapId, bytes32 txid, bytes32 viewShare) external nonReentrant {
        SwapSettle.withhold(swapId, txid, viewShare);
    }

    /// @inheritdoc IXmrSwap
    function splitDeposit(bytes32 swapId) external nonReentrant {
        SwapSettle.splitDeposit(swapId);
    }

    /// @inheritdoc IXmrSwap
    function publishEvidence(bytes32 swapId, bytes32 txid, bytes32 viewShare) external nonReentrant {
        SwapSettle.publishEvidence(swapId, txid, viewShare);
    }

    // ------------------------------------------------------------------ pulls and messages

    /// @inheritdoc IXmrSwap
    function withdrawOwed(address token, address to) external nonReentrant {
        SwapStore.Layout storage $ = SwapStore.layout();
        uint256 amount = $.owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        $.owed[token][msg.sender] = 0;
        SwapStore._send(token, to, amount);
    }

    /// @inheritdoc IXmrSwap
    function withdrawTreasury(address token, address to) external nonReentrant {
        SwapStore.Layout storage $ = SwapStore.layout();
        if (msg.sender != $.treasury) revert Unauthorized();
        uint256 amount = $.treasuryAccrued[token];
        if (amount == 0) revert NothingOwed();
        $.treasuryAccrued[token] = 0;
        SwapStore._send(token, to, amount);
    }

    /// @inheritdoc IXmrSwap
    function postMessage(address to, bytes32 swapId, bytes calldata payload) external {
        if (payload.length > 900) revert MessageTooLarge();
        emit Message(msg.sender, to, swapId, payload);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IXmrSwap
    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return SwapStore.layout().swaps[swapId];
    }

    /// @inheritdoc IXmrSwap
    function getMaker(address maker) external view returns (Maker memory) {
        return SwapStore.layout().makers[maker];
    }

    /// @inheritdoc IXmrSwap
    function counters(address maker) external view returns (uint32[40] memory) {
        return SwapStore.layout().makers[maker].counters;
    }

    /// @inheritdoc IXmrSwap
    function swapsOf(address taker, uint256 from, uint256 count) external view returns (bytes32[] memory) {
        bytes32[] storage all = SwapStore.layout().swapsByTaker[taker];
        uint256 total = all.length;
        if (from > total) from = total;
        if (count > total - from) count = total - from;
        bytes32[] memory ids = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = all[from + i];
        }
        return ids;
    }

    /// @inheritdoc IXmrSwap
    function isKeyUsed(address maker, address keyAddr) external view returns (bool) {
        return SwapStore.layout().keyUsed[maker][keyAddr];
    }

    /// @inheritdoc IXmrSwap
    function version() external view virtual returns (string memory) {
        // `view`, not `pure`: the frozen ABI says so. Reading the address keeps it a view.
        address(this);
        return "1";
    }

    /// @inheritdoc IXmrSwap
    function owedOf(address token, address account) external view returns (uint256) {
        return SwapStore.layout().owed[token][account];
    }

    /// @inheritdoc IXmrSwap
    function treasuryAccrued(address token) external view returns (uint256) {
        return SwapStore.layout().treasuryAccrued[token];
    }

    /// @inheritdoc IXmrSwap
    function volumeOf(address maker, address token) external view returns (uint256 volume, uint256 withheldVolume) {
        SwapStore.Layout storage $ = SwapStore.layout();
        return ($.volume[maker][token], $.withheldVolume[maker][token]);
    }

    /// @inheritdoc IXmrSwap
    function isQuoteCancelled(address maker, uint64 quoteId) external view returns (bool) {
        return SwapStore.layout().quoteCancelled[maker][quoteId];
    }

    /// @inheritdoc IXmrSwap
    function isApprovalRevoked(address maker, bytes32 approvalId) external view returns (bool) {
        return SwapStore.layout().approvalRevoked[keccak256(abi.encode(maker, approvalId))];
    }

    /// @inheritdoc IXmrSwap
    function treasury() external view returns (address) {
        return SwapStore.layout().treasury;
    }

    /// @inheritdoc IXmrSwap
    function usdc() external view returns (address) {
        return SwapStore.layout().usdc;
    }
}
