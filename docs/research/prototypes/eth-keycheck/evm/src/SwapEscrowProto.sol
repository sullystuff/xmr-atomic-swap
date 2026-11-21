// SPDX-License-Identifier: MIT
pragma solidity ^0.8.31;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Secp256k1KeyCheck} from "./Secp256k1KeyCheck.sol";

/// @notice RESEARCH PROTOTYPE, not the production contract. It exists to prove four things with tests:
///   1. EIP-712 quotes and advance approvals signed by a maker's registered secp256k1 operator key,
///      with replay protection (chainId + verifyingContract in the domain, expiry, epoch, id, fill caps);
///   2. claim by revealing the scalar behind a committed secp256k1 twin key (ecrecover mulVerify);
///   3. ETH and ERC-20 (USDC) escrow in one contract, with payouts that cannot make a claim revert;
///   4. UUPS upgradability that is switched off for good by renouncing ownership.
/// Approval windows, anti-spam deposits, ready flags and the fault counters of DESIGN.md are left out.
contract SwapEscrowProto is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ typed data

    /// A short-lived offer. Reusable by any taker until `validUntil`, within [minAmount, maxAmount] per
    /// lock and `maxTotal` across all locks. `keyRoot` commits to the maker's pool of one-time twin keys.
    struct Quote {
        address maker; //        maker's registered (owner) address on this contract
        address token; //        address(0) = ETH
        uint256 price; //        opaque to the contract (piconero per token base unit, 1e18-scaled); recorded
        uint256 minAmount;
        uint256 maxAmount;
        uint256 maxTotal; //     cumulative cap for this quoteId
        uint64 validUntil; //    unix seconds; compare with block.timestamp
        uint64 epoch; //         must equal the maker's current quoteEpoch (bump = cancel everything)
        uint32 claimDelay;
        uint16 depositBps;
        uint8 approvalMode; //   0 auto-accept, 1 window, 2 advance approval required
        bytes32 keyRoot; //      Merkle root over (index, keyAddr, keyAddr2) leaves
        bytes32 quoteId; //      random; lets the maker cancel one quote and keys the fill counter
    }

    /// An advance approval for one taker address, with a size limit and an expiry.
    struct Approval {
        address maker;
        address taker;
        address token;
        uint256 maxTotal; //     cumulative amount this approval covers
        uint64 validUntil;
        uint64 epoch; //         must equal the maker's current approvalEpoch
        bytes32 approvalId;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address token,uint256 price,uint256 minAmount,uint256 maxAmount,uint256 maxTotal,uint64 validUntil,uint64 epoch,uint32 claimDelay,uint16 depositBps,uint8 approvalMode,bytes32 keyRoot,bytes32 quoteId)"
    );
    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "Approval(address maker,address taker,address token,uint256 maxTotal,uint64 validUntil,uint64 epoch,bytes32 approvalId)"
    );

    // ------------------------------------------------------------------ storage
    // (prototype uses plain slots; the production contract should use one ERC-7201 namespaced struct)

    struct Maker {
        address operator; //   hot secp256k1 key held by the daemon; signs quotes and approvals
        uint64 quoteEpoch;
        uint64 approvalEpoch;
        bytes32 solanaKey; //  identity link (mutual pointer)
    }

    enum State {
        None,
        Locked,
        Claimed,
        Refunded
    }

    struct Swap {
        address taker;
        address maker;
        address token;
        uint256 amount;
        address makerKey; //   address(s_m * G)
        address makerKey2; //  address((T2 * s_m) * G)
        address takerKey; //   address(s_t * G)
        address takerKey2;
        uint64 lockedAt;
        uint64 refundAfter;
        State state;
    }

    uint256 public constant FEE_BPS_X100 = 5; // 0.05% = 5 / 10_000
    address public treasury;
    mapping(address => Maker) public makers;
    mapping(bytes32 quoteId => bool) public quoteCancelled; //      keyed by keccak(maker, quoteId)
    mapping(bytes32 quoteDigest => uint256) public quoteFilled;
    mapping(bytes32 approvalDigest => uint256) public approvalUsed;
    mapping(bytes32 approvalDigest => bool) public approvalRevoked;
    mapping(bytes32 leaf => bool) public keyUsed;
    mapping(bytes32 swapId => Swap) public swaps;
    mapping(address token => mapping(address account => uint256)) public owed; // failed pushes, pull later
    uint256 public swapCount;

    event MakerRegistered(address indexed maker, address operator, bytes32 solanaKey);
    event Locked(bytes32 indexed swapId, address indexed maker, address indexed taker, address token, uint256 amount);
    event Claimed(bytes32 indexed swapId, uint256 secret);
    event Refunded(bytes32 indexed swapId, uint256 secret);
    event PayoutDeferred(address indexed token, address indexed account, uint256 amount);

    error NotRegistered();
    error BadSigner();
    error Expired();
    error StaleEpoch();
    error Cancelled();
    error AmountOutOfRange();
    error CapExceeded();
    error WrongParty();
    error ApprovalRequired();
    error BadKey();
    error KeyAlreadyUsed();
    error BadState();
    error BadSecret();
    error TooEarly();
    error BadValue();
    error ShortTransfer();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address treasury_) external initializer {
        __Ownable_init(owner_);
        __EIP712_init("XmrAtomicSwap", "1");
        treasury = treasury_;
    }

    /// Upgrades are owner-only. After `renounceOwnership()` the owner is address(0), `onlyOwner` can
    /// never pass again, and the implementation is frozen forever.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ------------------------------------------------------------------ registry

    function registerMaker(address operator, bytes32 solanaKey) external {
        Maker storage m = makers[msg.sender];
        m.operator = operator;
        m.solanaKey = solanaKey;
        emit MakerRegistered(msg.sender, operator, solanaKey);
    }

    /// Cancels every outstanding quote (and/or approval) in one cheap transaction.
    function bumpEpochs(bool quotes, bool approvals) external {
        Maker storage m = makers[msg.sender];
        if (quotes) m.quoteEpoch++;
        if (approvals) m.approvalEpoch++;
    }

    function cancelQuote(bytes32 quoteId) external {
        quoteCancelled[keccak256(abi.encode(msg.sender, quoteId))] = true;
    }

    function revokeApproval(Approval calldata a) external {
        if (a.maker != msg.sender) revert WrongParty();
        approvalRevoked[hashApproval(a)] = true;
    }

    // ------------------------------------------------------------------ hashing

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.maker,
                    q.token,
                    q.price,
                    q.minAmount,
                    q.maxAmount,
                    q.maxTotal,
                    q.validUntil,
                    q.epoch,
                    q.claimDelay,
                    q.depositBps,
                    q.approvalMode,
                    q.keyRoot,
                    q.quoteId
                )
            )
        );
    }

    function hashApproval(Approval calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(APPROVAL_TYPEHASH, a.maker, a.taker, a.token, a.maxTotal, a.validUntil, a.epoch, a.approvalId)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ lock

    struct Keys {
        uint256 makerKeyIndex;
        address makerKey;
        address makerKey2;
        bytes32[] makerKeyProof;
        address takerKey;
        address takerKey2;
    }

    function lock(
        Quote calldata q,
        bytes calldata quoteSig,
        uint256 amount,
        Keys calldata k,
        Approval calldata a,
        bytes calldata approvalSig
    ) external payable nonReentrant returns (bytes32 swapId) {
        address operator = makers[q.maker].operator;
        if (operator == address(0)) revert NotRegistered();
        _useQuote(q, quoteSig, amount, operator);
        if (q.approvalMode == 2) _useApproval(q, a, approvalSig, amount, operator);
        _useKey(q, k);
        _pull(q.token, amount);

        swapId = keccak256(abi.encode(block.chainid, address(this), ++swapCount));
        swaps[swapId] = Swap({
            taker: msg.sender,
            maker: q.maker,
            token: q.token,
            amount: amount,
            makerKey: k.makerKey,
            makerKey2: k.makerKey2,
            takerKey: k.takerKey,
            takerKey2: k.takerKey2,
            lockedAt: uint64(block.timestamp),
            refundAfter: uint64(block.timestamp) + q.claimDelay,
            state: State.Locked
        });
        emit Locked(swapId, q.maker, msg.sender, q.token, amount);
    }

    /// quote: signature by the maker's registered operator key, freshness, limits
    function _useQuote(Quote calldata q, bytes calldata sig, uint256 amount, address operator) private {
        bytes32 qd = hashQuote(q);
        if (ECDSA.recoverCalldata(qd, sig) != operator) revert BadSigner();
        if (block.timestamp > q.validUntil) revert Expired();
        if (q.epoch != makers[q.maker].quoteEpoch) revert StaleEpoch();
        if (quoteCancelled[keccak256(abi.encode(q.maker, q.quoteId))]) revert Cancelled();
        if (amount < q.minAmount || amount > q.maxAmount) revert AmountOutOfRange();
        uint256 filled = quoteFilled[qd] + amount;
        if (filled > q.maxTotal) revert CapExceeded();
        quoteFilled[qd] = filled;
    }

    /// advance approval: same signer, bound to msg.sender, cumulative size limit, expiry, revocable
    function _useApproval(Quote calldata q, Approval calldata a, bytes calldata sig, uint256 amount, address operator)
        private
    {
        if (sig.length == 0) revert ApprovalRequired();
        bytes32 ad = hashApproval(a);
        if (ECDSA.recoverCalldata(ad, sig) != operator) revert BadSigner();
        if (a.maker != q.maker || a.taker != msg.sender || a.token != q.token) revert WrongParty();
        if (block.timestamp > a.validUntil) revert Expired();
        if (a.epoch != makers[q.maker].approvalEpoch) revert StaleEpoch();
        if (approvalRevoked[ad]) revert Cancelled();
        uint256 used = approvalUsed[ad] + amount;
        if (used > a.maxTotal) revert CapExceeded();
        approvalUsed[ad] = used;
    }

    /// one-time maker twin key out of the pool committed in the signed quote
    function _useKey(Quote calldata q, Keys calldata k) private {
        if (k.makerKey == address(0) || k.makerKey2 == address(0) || k.takerKey == address(0) || k.takerKey2 == address(0))
        {
            revert BadKey();
        }
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(k.makerKeyIndex, k.makerKey, k.makerKey2))));
        if (!MerkleProof.verifyCalldata(k.makerKeyProof, q.keyRoot, leaf)) revert BadKey();
        bytes32 usedSlot = keccak256(abi.encode(q.maker, leaf));
        if (keyUsed[usedSlot]) revert KeyAlreadyUsed();
        keyUsed[usedSlot] = true;
    }

    function _pull(address token, uint256 amount) private {
        if (token == address(0)) {
            if (msg.value != amount) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            IERC20 t = IERC20(token);
            uint256 before = t.balanceOf(address(this));
            t.safeTransferFrom(msg.sender, address(this), amount);
            // never credit more than actually arrived (fee-on-transfer / upgraded token behaviour)
            if (t.balanceOf(address(this)) - before != amount) revert ShortTransfer();
        }
    }

    // ------------------------------------------------------------------ claim / refund

    /// Anyone may submit: funds always go to the maker's registered address, so a front-runner who
    /// copies `secret` out of the mempool gains nothing.
    function claim(bytes32 swapId, uint256 secret) external nonReentrant {
        Swap storage s = swaps[swapId];
        if (s.state != State.Locked) revert BadState();
        if (!Secp256k1KeyCheck.mulVerify2(secret, s.makerKey, s.makerKey2)) revert BadSecret();
        s.state = State.Claimed;
        emit Claimed(swapId, secret);

        uint256 fee = (s.amount * FEE_BPS_X100) / 10_000;
        _payout(s.token, s.maker, s.amount - fee);
        _payout(s.token, treasury, fee);
    }

    /// Prototype refund: after `refundAfter`, by revealing the taker's key half.
    function refund(bytes32 swapId, uint256 secret) external nonReentrant {
        Swap storage s = swaps[swapId];
        if (s.state != State.Locked) revert BadState();
        if (block.timestamp < s.refundAfter) revert TooEarly();
        if (!Secp256k1KeyCheck.mulVerify2(secret, s.takerKey, s.takerKey2)) revert BadSecret();
        s.state = State.Refunded;
        emit Refunded(swapId, secret);
        _payout(s.token, s.taker, s.amount);
    }

    /// A payout must never revert: a reverted claim has already published the secret in calldata.
    /// If the push fails (USDC blacklist, a contract that rejects ETH, a paused token) the amount is
    /// parked and the recipient pulls it later.
    function _payout(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        bool ok;
        if (token == address(0)) {
            // fixed gas stipend: enough for an EOA / simple wallet, not enough to grief
            (ok,) = to.call{value: amount, gas: 30_000}("");
        } else {
            ok = IERC20(token).trySafeTransfer(to, amount);
        }
        if (!ok) {
            owed[token][to] += amount;
            emit PayoutDeferred(token, to, amount);
        }
    }

    function withdrawOwed(address token) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        owed[token][msg.sender] = 0;
        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok);
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }
}
