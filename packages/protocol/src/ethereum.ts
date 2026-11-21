/**
 * Ethereum-side types: the frozen ABI, the EIP-712 typed-data definitions of SPEC 2.10 and
 * JSON-friendly shapes of the contract's records. Encoding and decoding go through viem with
 * `IXmrSwapAbi`; digests come from `@xmrswap/core-wasm` or viem's `hashTypedData` with exactly
 * these types.
 */
import { EIP712_NAME, EIP712_VERSION } from './constants.js';

export { IXmrSwapAbi } from './generated/abi.js';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** EIP-712 `types` for viem `signTypedData` / `verifyTypedData` / `hashTypedData`. */
export const EIP712_TYPES = {
  Quote: [
    { name: 'maker', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'direction', type: 'uint8' },
    { name: 'approvalMode', type: 'uint8' },
    { name: 'minXmr', type: 'uint64' },
    { name: 'maxXmr', type: 'uint64' },
    { name: 'tierXmr', type: 'uint64[3]' },
    { name: 'tierPrice', type: 'uint256[3]' },
    { name: 'depthXmr', type: 'uint64[3]' },
    { name: 'depth', type: 'uint8[3]' },
    { name: 'depositBps', type: 'uint16' },
    { name: 'approvalWindow', type: 'uint32' },
    { name: 'noticeWindow', type: 'uint32' },
    { name: 'claimDelay', type: 'uint32' },
    { name: 'claimWindow', type: 'uint32' },
    { name: 'finalWindow', type: 'uint32' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'epoch', type: 'uint32' },
    { name: 'keyRoot', type: 'bytes32' },
    { name: 'quoteId', type: 'uint64' },
  ],
  Approval: [
    { name: 'maker', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'direction', type: 'uint8' },
    { name: 'maxXmr', type: 'uint64' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'epoch', type: 'uint32' },
    { name: 'approvalId', type: 'bytes32' },
  ],
} as const;

/** The type strings whose keccak256 are the type hashes. */
export const EIP712_TYPE_STRINGS = {
  Quote:
    'Quote(address maker,address taker,address token,uint8 direction,uint8 approvalMode,uint64 minXmr,uint64 maxXmr,uint64[3] tierXmr,uint256[3] tierPrice,uint64[3] depthXmr,uint8[3] depth,uint16 depositBps,uint32 approvalWindow,uint32 noticeWindow,uint32 claimDelay,uint32 claimWindow,uint32 finalWindow,uint64 validUntil,uint32 epoch,bytes32 keyRoot,uint64 quoteId)',
  Approval:
    'Approval(address maker,address taker,address token,uint8 direction,uint64 maxXmr,uint64 notBefore,uint64 validUntil,uint32 epoch,bytes32 approvalId)',
} as const;

/** The EIP-712 domain for a deployment: `verifyingContract` is the proxy address. */
export function eip712Domain(chainId: bigint | number, verifyingContract: Address) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: BigInt(chainId), verifyingContract } as const;
}

type Triple<T> = readonly [T, T, T];

/** The EIP-712 `Quote` message as viem takes it. */
export interface EthQuoteMessage {
  maker: Address;
  /** Zero address = public quote; otherwise bound to this taker and single-use. */
  taker: Address;
  /** Zero address = ETH. */
  token: Address;
  /** 0 = A, 1 = B. */
  direction: number;
  /** 0 auto, 1 window, 2 advance approval required. */
  approvalMode: number;
  minXmr: bigint;
  maxXmr: bigint;
  tierXmr: Triple<bigint>;
  /** Token base units per 1 XMR; 0 = tier unused. */
  tierPrice: Triple<bigint>;
  depthXmr: Triple<bigint>;
  depth: Triple<number>;
  depositBps: number;
  approvalWindow: number;
  noticeWindow: number;
  claimDelay: number;
  claimWindow: number;
  finalWindow: number;
  /** Valid while `block.timestamp <= validUntil`. */
  validUntil: bigint;
  epoch: number;
  /** Merkle root of the key pool (direction A); zero for direction B. */
  keyRoot: Hex;
  quoteId: bigint;
}

/** The EIP-712 `Approval` message as viem takes it. */
export interface EthApprovalMessage {
  maker: Address;
  taker: Address;
  /** A token, or `ETH_ANY_TOKEN`. */
  token: Address;
  /** 0, 1, or 255 = any. */
  direction: number;
  maxXmr: bigint;
  notBefore: bigint;
  validUntil: bigint;
  epoch: number;
  approvalId: Hex;
}

/** One leaf of an Ethereum key pool, as the maker's pool route serves it. */
export interface PoolLeafJson {
  index: number;
  /** `keyAddr`, 0x-prefixed. */
  key: Address;
  key2: Address;
  /** `S`, lowercase hex without `0x`. */
  spend_pub: string;
}

/** Custom error names of the contract (SPEC 5.5). */
export const ETH_ERROR_NAMES = [
  'NotRegistered',
  'AlreadyRegistered',
  'Unauthorized',
  'Paused',
  'BadSigner',
  'Expired',
  'StaleEpoch',
  'Cancelled',
  'Revoked',
  'WrongParty',
  'WrongDirection',
  'TokenNotAllowed',
  'TiersInvalid',
  'AmountOutOfRange',
  'PriceMoved',
  'ApprovalRequired',
  'BadKey',
  'KeyAlreadyUsed',
  'BadState',
  'TooEarly',
  'TooLate',
  'BadSecret',
  'BadValue',
  'ShortTransfer',
  'DepositTooHigh',
  'ApprovalWindowOutOfRange',
  'NoticeWindowOutOfRange',
  'ClaimDelayTooShort',
  'ClaimWindowTooShort',
  'FinalWindowOutOfRange',
  'DepthInvalid',
  'ViewInvalid',
  'TooManyPending',
  'EvidenceMismatch',
  'EvidenceRequired',
  'NothingOwed',
  'MessageTooLarge',
] as const;
export type EthErrorName = (typeof ETH_ERROR_NAMES)[number];

/** Swap events of the contract; each indexes `swapId` and `maker` and carries `counter`. */
export const ETH_SWAP_EVENT_NAMES = [
  'Locked',
  'Approved',
  'Funded',
  'Rejected',
  'PendingCancelled',
  'PendingExpired',
  'NoticePosted',
  'ReadySet',
  'Aborted',
  'RefundedKeyless',
  'ExpiredUnnoticed',
  'Refunded',
  'Claimed',
  'DepositReleased',
  'DepositWithheld',
  'DepositSplit',
  'EvidencePublished',
] as const;
export type EthSwapEventName = (typeof ETH_SWAP_EVENT_NAMES)[number];
