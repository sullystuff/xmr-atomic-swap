// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IXmrSwap: the frozen interface of the XMR atomic-swap escrow (SPEC section 5).
/// @notice One escrow machine for both directions. Direction A: the taker pays ETH or USDC and
/// receives XMR (locker = taker, claimer = maker). Direction B: the taker pays XMR and receives
/// ETH or USDC (locker = maker, claimer = taker). The state machine is SPEC section 3 with
/// EXPLICIT_APPROVE = true: every swap starts PENDING.
/// @dev Frozen by work package 1. `interfaces/ethereum/IXmrSwap.abi.json` is generated from this
/// file; `interfaces/tools/check-abi.mjs` compares an implementation's ABI with it. The
/// implementation imports this file through a remapping and does not copy it.
interface IXmrSwap {
    // ------------------------------------------------------------------ signed objects (SPEC 2.10)

    /// @notice EIP-712 quote signed by the maker's operator key.
    struct Quote {
        address maker; // the maker's registered (owner) address
        address taker; // address(0) = public quote; otherwise bound to this taker
        address token; // address(0) = ETH
        uint8 direction; // 0 = A, 1 = B
        uint8 approvalMode; // 0 auto, 1 window, 2 advance approval required
        uint64 minXmr;
        uint64 maxXmr;
        uint64[3] tierXmr; // price tiers: tier i applies when xmr >= tierXmr[i]; tierXmr[0] == 0
        uint256[3] tierPrice; // token base units per 1 XMR; 0 = tier unused (unused tiers trail)
        uint64[3] depthXmr; // depth tiers, same rule; depthXmr[0] == 0
        uint8[3] depth; // Monero confirmations; 0 = tier unused
        uint16 depositBps;
        uint32 approvalWindow; // W_a
        uint32 noticeWindow; // W_n
        uint32 claimDelay; // D_c
        uint32 claimWindow; // W_c
        uint32 finalWindow; // W_f
        uint64 validUntil; // valid while block.timestamp <= validUntil
        uint32 epoch; // must equal the maker's quoteEpoch
        bytes32 keyRoot; // Merkle root of the key pool (direction A); zero for direction B
        uint64 quoteId; // cancel handle
    }

    /// @notice EIP-712 advance approval signed by the maker's operator key.
    struct Approval {
        address maker;
        address taker; // must equal the lock's msg.sender
        address token; // or 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF = any token
        uint8 direction; // 0, 1, or 255 = any
        uint64 maxXmr; // largest single swap
        uint64 notBefore;
        uint64 validUntil;
        uint32 epoch; // must equal the maker's approvalEpoch
        bytes32 approvalId; // revocation handle
    }

    // ------------------------------------------------------------------ call arguments (SPEC 5.3)

    /// @notice The taker's commitments and keys, supplied at lock or take.
    struct TakerKeys {
        bytes32 spendPub; // S_T, the ed25519 spend commitment
        address key; // keyAddr of the taker's secp256k1 twin
        address key2; // keyAddr2
        bytes32 viewShare; // v_T in clear (direction A); zero in direction B
        bytes32 encKey; // the taker's one-time X25519 key
        uint32 makerEncVersion; // the maker key version the swap's messages use
        bytes32 makerEncKey; // the maker's X25519 key of that version, as read by the taker
    }

    /// @notice One leaf of the quote's key pool, with its Merkle proof (direction A).
    struct PoolLeaf {
        uint32 index;
        address key;
        address key2;
        bytes32 spendPub;
        bytes32[] proof;
    }

    // ------------------------------------------------------------------ storage records (SPEC 5.2)

    struct Maker {
        address operator; // hot key: signs quotes and approvals, sends maker transactions
        address payout; // receives direction-A claims
        uint32 quoteEpoch;
        uint32 approvalEpoch;
        bool paused;
        uint64 registeredAt;
        bytes32 solanaOwner; // linked Solana owner key; zero = none
        bytes32 solanaOwnerNext; // pending change
        uint64 solanaOwnerNextAt; // 0 = none
        uint16 openPending;
        uint64 responseSecsSum;
        uint32[40] counters; // SPEC 3.7; updates saturate
    }

    struct Swap {
        address taker;
        address maker;
        address token;
        address sessionKey;
        bytes16 swapNonce;
        uint8 state; // SPEC 3.3; 0 = no such swap
        uint8 direction;
        uint8 mode;
        uint8 outcome; // counter id; 0xff while open
        uint8 depositState;
        uint8 depth;
        uint8 flags;
        uint16 depBps;
        uint32 makerEncVersion;
        uint64 xmr;
        uint256 amount;
        uint256 deposit;
        uint256 price;
        uint32 noticeWindow;
        uint32 claimDelay;
        uint32 claimWindow;
        address takerKey;
        address takerKey2;
        bytes32 takerSpendPub;
        address makerKey;
        address makerKey2;
        bytes32 makerSpendPub;
        bytes32 lockerView;
        bytes32 takerEncKey;
        bytes32 makerEncKey;
        bytes32 noticeCommitment;
        bytes noticeCiphertext; // 104 bytes, in storage: logs are prunable
        bytes32 evidenceTxid;
        bytes32 evidenceView;
        bytes32 keyLeaf; // direction A: hash of the pool leaf named at lock
        bytes32 openHash; // SPEC 3.12
        uint256 revealed; // the revealed spend share; kept in storage
        uint64 tLock;
        uint64 tPendingDeadline;
        uint64 tActive;
        uint64 tNoteDeadline;
        uint64 tNotice;
        uint64 tCut;
        uint64 tClaimOpen;
        uint64 tReady;
        uint64 tClaimDeadline;
        uint64 tFinal;
        uint64 tRefund;
        uint64 tSettled;
    }

    // ------------------------------------------------------------------ swap events (SPEC 5.5)
    // Every swap event indexes `swapId` and `maker` and carries the counter id the transition
    // moved (0xff = none).

    event Locked(
        bytes32 indexed swapId,
        address indexed maker,
        address indexed taker,
        uint8 counter,
        address token,
        uint8 direction,
        uint8 mode,
        uint256 amount,
        uint256 deposit,
        uint64 xmr,
        uint8 depth,
        bytes16 swapNonce,
        TakerKeys keys,
        bytes32 leaf
    );
    event Approved(bytes32 indexed swapId, address indexed maker, uint8 counter);
    event Funded(
        bytes32 indexed swapId, address indexed maker, uint8 counter, address key, address key2, bytes32 spendPub, bytes32 viewShare
    );
    event Rejected(bytes32 indexed swapId, address indexed maker, uint8 counter, uint8 reason);
    event PendingCancelled(bytes32 indexed swapId, address indexed maker, uint8 counter);
    event PendingExpired(bytes32 indexed swapId, address indexed maker, uint8 counter);
    event NoticePosted(
        bytes32 indexed swapId, address indexed maker, uint8 counter, bytes32 commitment, bytes ciphertext, bool late
    );
    event ReadySet(bytes32 indexed swapId, address indexed maker, uint8 counter);
    event Aborted(bytes32 indexed swapId, address indexed maker, uint8 counter, uint8 newState);
    event RefundedKeyless(bytes32 indexed swapId, address indexed maker, uint8 counter);
    event ExpiredUnnoticed(bytes32 indexed swapId, address indexed maker, uint8 counter);
    event Refunded(bytes32 indexed swapId, address indexed maker, uint8 counter, uint256 secret, bool depositHeld);
    event Claimed(bytes32 indexed swapId, address indexed maker, uint8 counter, uint256 secret, uint256 paid, uint256 fee);
    event DepositReleased(bytes32 indexed swapId, address indexed maker, uint8 counter, uint256 amount);
    event DepositWithheld(
        bytes32 indexed swapId, address indexed maker, uint8 counter, uint256 amount, bytes32 txid, bytes32 viewShare
    );
    event DepositSplit(
        bytes32 indexed swapId, address indexed maker, uint8 counter, uint256 toTaker, uint256 toTreasury
    );
    event EvidencePublished(bytes32 indexed swapId, address indexed maker, uint8 counter, bytes32 txid, bytes32 viewShare);
    /// @notice A payout could not be delivered and was parked in `owed[token][account]`.
    event PayoutDeferred(address indexed token, address indexed account, uint256 amount);

    // ------------------------------------------------------------------ registry events

    event MakerRegistered(address indexed maker, address operator, address payout, bytes32 solanaOwner);
    event OperatorChanged(address indexed maker, address operator, uint32 quoteEpoch, uint32 approvalEpoch);
    event PayoutChanged(address indexed maker, address payout);
    /// @notice `effectiveAt` is when readers start treating `newOwner` as the link.
    event LinkChanged(address indexed maker, bytes32 oldOwner, bytes32 newOwner, uint64 effectiveAt);
    event PausedChanged(address indexed maker, bool paused);
    event EpochsBumped(address indexed maker, uint32 quoteEpoch, uint32 approvalEpoch);
    event QuoteCancelled(address indexed maker, uint64 quoteId);
    event ApprovalRevoked(address indexed maker, bytes32 approvalId);
    /// @notice Messaging fallback (SPEC 6.2). The payload is an envelope of at most 900 bytes.
    event Message(address indexed from, address indexed to, bytes32 indexed swapId, bytes payload);

    // ------------------------------------------------------------------ errors (SPEC 5.5)

    error NotRegistered();
    error AlreadyRegistered();
    error Unauthorized();
    error Paused();
    error BadSigner();
    error Expired();
    error StaleEpoch();
    error Cancelled();
    error Revoked();
    error WrongParty();
    error WrongDirection();
    error TokenNotAllowed();
    error TiersInvalid();
    error AmountOutOfRange();
    error PriceMoved();
    error ApprovalRequired();
    error BadKey();
    error KeyAlreadyUsed();
    error BadState();
    error TooEarly();
    error TooLate();
    error BadSecret();
    error BadValue();
    error ShortTransfer();
    error DepositTooHigh();
    error ApprovalWindowOutOfRange();
    error NoticeWindowOutOfRange();
    error ClaimDelayTooShort();
    error ClaimWindowTooShort();
    error FinalWindowOutOfRange();
    error DepthInvalid();
    error ViewInvalid();
    error TooManyPending();
    error EvidenceMismatch();
    error EvidenceRequired();
    error NothingOwed();
    error MessageTooLarge();

    // ------------------------------------------------------------------ registry (SPEC 5.3)

    /// @notice Create the caller's maker record. The Solana link is set immediately.
    function registerMaker(address operator, address payout, bytes32 solanaOwner) external;

    /// @notice Maker owner. Also bumps both epochs.
    function setOperator(address operator) external;

    /// @notice Maker owner.
    function setPayout(address payout) external;

    /// @notice Maker owner. A change or removal takes effect after LINK_DELAY_SECS.
    function setSolanaLink(bytes32 solanaOwner) external;

    /// @notice Maker owner or operator.
    function setPaused(bool paused) external;

    /// @notice Maker owner or operator.
    function bumpEpochs(bool quotes, bool approvals) external;

    /// @notice Maker owner or operator.
    function cancelQuote(uint64 quoteId) external;

    /// @notice Maker owner or operator.
    function revokeApproval(bytes32 approvalId) external;

    // ------------------------------------------------------------------ opening (SPEC 5.3)

    /// @notice A1: the taker escrows `amount` and names a leaf of the quote's key pool.
    /// ETH: msg.value == amount + sessionBudget. USDC: msg.value == sessionBudget.
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
    ) external payable returns (bytes32 swapId);

    /// @notice B1: the taker posts the take deposit.
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
    ) external payable returns (bytes32 swapId);

    /// @notice A2. Operator. Consumes the named pool leaf.
    function approve(bytes32 swapId, bytes32 expectedOpen) external;

    /// @notice B5. Operator. Escrows `amount` and supplies the maker's share commitments.
    function fund(bytes32 swapId, bytes32 expectedOpen, address key, address key2, bytes32 spendPub, bytes32 viewShare)
        external
        payable;

    /// @notice A3, B3. Operator. Reason 0, 1 or 2 (SPEC 3.7).
    function reject(bytes32 swapId, bytes32 expectedOpen, uint8 reason) external;

    /// @notice A4, B2. Taker wallet or session key.
    function cancelPending(bytes32 swapId) external;

    /// @notice A5, B4. Anyone.
    function expirePending(bytes32 swapId) external;

    // ------------------------------------------------------------------ progress and settlement

    /// @notice A6, B6. The claimer. `ciphertext` is exactly 104 bytes.
    function postNotice(bytes32 swapId, bytes32 commitment, bytes calldata ciphertext) external;

    /// @notice A9, B7. The locker.
    function setReady(bytes32 swapId) external;

    /// @notice A7a-d, B8. The claimer.
    function abort(bytes32 swapId) external;

    /// @notice A8. Anyone.
    function refundUnnoticed(bytes32 swapId) external;

    /// @notice B11. Anyone.
    function expireUnnoticed(bytes32 swapId) external;

    /// @notice A10, B9. Anyone: the secret is the authorisation and the destination is fixed.
    function refund(bytes32 swapId, uint256 secret) external;

    /// @notice A11, B10. Anyone: the secret is the authorisation and the destination is fixed.
    function claim(bytes32 swapId, uint256 secret) external;

    /// @notice Anyone at T_hold; the operator before it, and for a withheld deposit.
    function releaseDeposit(bytes32 swapId) external;

    /// @notice Operator, inside the hold. Without evidence pass zeros.
    function withhold(bytes32 swapId, bytes32 txid, bytes32 viewShare) external;

    /// @notice Anyone at T_split.
    function splitDeposit(bytes32 swapId) external;

    /// @notice The claimer. `(txid, viewShare)` must open the notice commitment.
    function publishEvidence(bytes32 swapId, bytes32 txid, bytes32 viewShare) external;

    /// @notice Pull the caller's parked payouts of `token` to `to`.
    function withdrawOwed(address token, address to) external;

    /// @notice The treasury address only.
    function withdrawTreasury(address token, address to) external;

    /// @notice Emits `Message` only. `payload` is at most 900 bytes.
    function postMessage(address to, bytes32 swapId, bytes calldata payload) external;

    // ------------------------------------------------------------------ views

    function getSwap(bytes32 swapId) external view returns (Swap memory);

    function getMaker(address maker) external view returns (Maker memory);

    function counters(address maker) external view returns (uint32[40] memory);

    /// @notice The taker's swap ids, oldest first: `count` entries starting at `from`.
    function swapsOf(address taker, uint256 from, uint256 count) external view returns (bytes32[] memory);

    function hashQuote(Quote calldata q) external view returns (bytes32);

    function hashApproval(Approval calldata a) external view returns (bytes32);

    function domainSeparator() external view returns (bytes32);

    function isKeyUsed(address maker, address keyAddr) external view returns (bool);

    function version() external view returns (string memory);

    // Readers for the remaining storage of SPEC 5.2 (not listed in SPEC 5.3; without them parked
    // payouts, volumes and cancellations cannot be read from state).

    /// @notice Parked payout of `token` waiting for `account`.
    function owedOf(address token, address account) external view returns (uint256);

    /// @notice Fees and split halves accrued for the treasury.
    function treasuryAccrued(address token) external view returns (uint256);

    /// @notice A maker's completed volume and withheld volume in `token`.
    function volumeOf(address maker, address token) external view returns (uint256 volume, uint256 withheldVolume);

    function isQuoteCancelled(address maker, uint64 quoteId) external view returns (bool);

    function isApprovalRevoked(address maker, bytes32 approvalId) external view returns (bool);

    function treasury() external view returns (address);

    function usdc() external view returns (address);
}
