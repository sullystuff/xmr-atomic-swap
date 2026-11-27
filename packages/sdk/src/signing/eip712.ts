/**
 * EIP-712 objects signed by the maker's Ethereum operator key (SPEC 2.10): `Quote` and
 * `Approval`, their compact board form, and every check a client makes before using one.
 *
 * Signing and recovery are viem's (`signTypedData`, `recoverTypedDataAddress`) with exactly the
 * frozen types of `@xmrswap/protocol`; the digest is cross-checked against the Rust core
 * (`quoteDigest`, `approvalDigest`) so the two can never silently disagree.
 */
import { type EthApproval, type EthQuote, approvalDigest, decodeEthQuoteCompact, encodeEthQuoteCompact, quoteDigest } from '@xmrswap/core-wasm';
import { type Address, COMPACT_QUOTE_LEN, EIP712_TYPES, ETH_ANY_DIRECTION, ETH_ANY_TOKEN, ETH_QUOTE_MIN_LEFT_SECS, type EthApprovalMessage, type EthQuoteMessage, type Hex, eip712Domain } from '@xmrswap/protocol';
import { hashTypedData, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type Bytes, SdkError, beToBig, bytesEqual, hex0x, unhex } from '../util.js';

export interface EthDeployment {
  chainId: bigint | number;
  /** The proxy address. */
  contract: Address;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const addr = (b: Bytes): Address => hex0x(b) as Address;
const lower = (a: string): string => a.toLowerCase();
const triple = <T>(a: readonly T[]): [T, T, T] => [a[0]!, a[1]!, a[2]!];

/** The EIP-712 message viem takes, from the byte form the core uses. */
export function quoteMessage(q: EthQuote): EthQuoteMessage {
  return {
    maker: addr(q.maker),
    taker: addr(q.taker),
    token: addr(q.token),
    direction: q.direction,
    approvalMode: q.approvalMode,
    minXmr: q.minXmr,
    maxXmr: q.maxXmr,
    tierXmr: q.tierXmr,
    tierPrice: q.tierPrice,
    depthXmr: q.depthXmr,
    depth: q.depth,
    depositBps: q.depositBps,
    approvalWindow: q.approvalWindow,
    noticeWindow: q.noticeWindow,
    claimDelay: q.claimDelay,
    claimWindow: q.claimWindow,
    finalWindow: q.finalWindow,
    validUntil: q.validUntil,
    epoch: q.epoch,
    keyRoot: hex0x(q.keyRoot),
    quoteId: q.quoteId,
    freezeWindow: q.freezeWindow,
  };
}
/** The byte form the core uses, from a viem message (or the typed-data JSON of a vector). */
export function quoteFromMessage(m: EthQuoteMessage): EthQuote {
  return {
    maker: unhex(m.maker),
    taker: unhex(m.taker),
    token: unhex(m.token),
    direction: Number(m.direction),
    approvalMode: Number(m.approvalMode),
    minXmr: BigInt(m.minXmr),
    maxXmr: BigInt(m.maxXmr),
    tierXmr: triple(m.tierXmr.map(BigInt)),
    tierPrice: triple(m.tierPrice.map(BigInt)),
    depthXmr: triple(m.depthXmr.map(BigInt)),
    depth: triple(m.depth.map(Number)),
    depositBps: Number(m.depositBps),
    approvalWindow: Number(m.approvalWindow),
    noticeWindow: Number(m.noticeWindow),
    claimDelay: Number(m.claimDelay),
    claimWindow: Number(m.claimWindow),
    finalWindow: Number(m.finalWindow),
    validUntil: BigInt(m.validUntil),
    epoch: Number(m.epoch),
    keyRoot: unhex(m.keyRoot),
    quoteId: BigInt(m.quoteId),
    freezeWindow: Number(m.freezeWindow),
  };
}
export function approvalMessage(a: EthApproval): EthApprovalMessage {
  return { maker: addr(a.maker), taker: addr(a.taker), token: addr(a.token), direction: a.direction, maxXmr: a.maxXmr, notBefore: a.notBefore, validUntil: a.validUntil, epoch: a.epoch, approvalId: hex0x(a.approvalId) };
}
export function approvalFromMessage(m: EthApprovalMessage): EthApproval {
  return {
    maker: unhex(m.maker),
    taker: unhex(m.taker),
    token: unhex(m.token),
    direction: Number(m.direction),
    maxXmr: BigInt(m.maxXmr),
    notBefore: BigInt(m.notBefore),
    validUntil: BigInt(m.validUntil),
    epoch: Number(m.epoch),
    approvalId: unhex(m.approvalId),
  };
}

const coreDomain = (d: EthDeployment) => ({ chainId: BigInt(d.chainId), verifyingContract: unhex(d.contract) });

/** The digest the operator signs for a quote: viem's, required to equal the core's and therefore the contract's `hashQuote`. */
export function ethQuoteDigest(d: EthDeployment, q: EthQuote): Hex {
  const viaViem = hashTypedData({ domain: eip712Domain(d.chainId, d.contract), types: EIP712_TYPES, primaryType: 'Quote', message: quoteMessage(q) });
  if (viaViem !== hex0x(quoteDigest(coreDomain(d), q))) throw new SdkError('DigestMismatch', 'viem and the core disagree on the quote digest');
  return viaViem;
}
export function ethApprovalDigest(d: EthDeployment, a: EthApproval): Hex {
  const viaViem = hashTypedData({ domain: eip712Domain(d.chainId, d.contract), types: EIP712_TYPES, primaryType: 'Approval', message: approvalMessage(a) });
  if (viaViem !== hex0x(approvalDigest(coreDomain(d), a))) throw new SdkError('DigestMismatch', 'viem and the core disagree on the approval digest');
  return viaViem;
}

/** Sign a quote with the operator's private key (maker side). Returns 65 bytes `r ‖ s ‖ v`. */
export async function signEthQuote(operatorKey: Hex, d: EthDeployment, q: EthQuote): Promise<Bytes> {
  ethQuoteDigest(d, q);
  return unhex(await privateKeyToAccount(operatorKey).signTypedData({ domain: eip712Domain(d.chainId, d.contract), types: EIP712_TYPES, primaryType: 'Quote', message: quoteMessage(q) }));
}
export async function signEthApproval(operatorKey: Hex, d: EthDeployment, a: EthApproval): Promise<Bytes> {
  ethApprovalDigest(d, a);
  return unhex(await privateKeyToAccount(operatorKey).signTypedData({ domain: eip712Domain(d.chainId, d.contract), types: EIP712_TYPES, primaryType: 'Approval', message: approvalMessage(a) }));
}

/**
 * The address that signed `digest`, under the contract's rules (`ECDSA.recoverCalldata`): 65
 * bytes, `v` in {27, 28}, low `s`. Anything else is `null`, exactly where the contract reverts.
 */
export async function recoverSigner(digest: Hex, sig: Bytes): Promise<Address | null> {
  if (sig.length !== 65) return null;
  const v = sig[64]!;
  if (v !== 27 && v !== 28) return null;
  const r = beToBig(sig.subarray(0, 32));
  const s = beToBig(sig.subarray(32, 64));
  if (r === 0n || s === 0n || s > SECP256K1_N / 2n) return null;
  try {
    return lower(await recoverAddress({ hash: digest, signature: hex0x(sig) })) as Address;
  } catch {
    return null;
  }
}

/** The quote's signature recovers to `operator` for this chain id and this contract. A quote replayed across chains or contracts fails here. */
export async function verifyEthQuote(d: EthDeployment, q: EthQuote, sig: Bytes, operator: Address): Promise<boolean> {
  const signer = await recoverSigner(ethQuoteDigest(d, q), sig);
  return signer !== null && signer === lower(operator);
}
export async function verifyEthApproval(d: EthDeployment, a: EthApproval, sig: Bytes, operator: Address): Promise<boolean> {
  const signer = await recoverSigner(ethApprovalDigest(d, a), sig);
  return signer !== null && signer === lower(operator);
}

/** What the contract's registry says about the maker a quote or approval names. */
export interface EthMakerState {
  /** `makers[q.maker].operator`; the zero address when not registered. */
  operator: Address;
  quoteEpoch: number;
  approvalEpoch: number;
  paused: boolean;
}

export type EthQuoteProblem = 'NotRegistered' | 'Paused' | 'BadSigner' | 'Expired' | 'StaleEpoch' | 'Cancelled' | 'WrongDirection' | 'WrongParty' | 'TooLittleTimeLeft';

/**
 * Why `lock` or `take` would refuse this quote, or `null`. The order is the contract's.
 * `TooLittleTimeLeft` is the client rule of SPEC 2.10: the UI refuses to submit with under 36 s
 * of validity left.
 */
export async function ethQuoteProblem(
  d: EthDeployment,
  q: EthQuote,
  sig: Bytes,
  maker: EthMakerState,
  use: { now: bigint; direction: number; sender: Address; cancelled?: boolean; minLeftSecs?: number },
): Promise<EthQuoteProblem | null> {
  if (beToBig(unhex(maker.operator)) === 0n) return 'NotRegistered';
  if (maker.paused) return 'Paused';
  if (!(await verifyEthQuote(d, q, sig, maker.operator))) return 'BadSigner';
  // Validity is inclusive: valid while now <= validUntil.
  if (use.now > q.validUntil) return 'Expired';
  if (q.epoch !== maker.quoteEpoch) return 'StaleEpoch';
  if (use.cancelled) return 'Cancelled';
  if (q.direction !== use.direction) return 'WrongDirection';
  if (beToBig(q.taker) !== 0n && hex0x(q.taker) !== lower(use.sender)) return 'WrongParty';
  if (q.validUntil - use.now < BigInt(use.minLeftSecs ?? ETH_QUOTE_MIN_LEFT_SECS)) return 'TooLittleTimeLeft';
  return null;
}

export type EthApprovalProblem = 'BadSigner' | 'WrongParty' | 'TokenNotAllowed' | 'WrongDirection' | 'AmountOutOfRange' | 'Expired' | 'StaleEpoch' | 'Revoked';

/** Why the contract would refuse this approval for this lock, or `null`. Wildcards: `ETH_ANY_TOKEN`, direction 255. */
export async function ethApprovalProblem(
  d: EthDeployment,
  a: EthApproval,
  sig: Bytes,
  maker: Pick<EthMakerState, 'operator' | 'approvalEpoch'>,
  use: { now: bigint; sender: Address; token: Address; direction: number; xmr: bigint; revoked?: boolean },
): Promise<EthApprovalProblem | null> {
  if (!(await verifyEthApproval(d, a, sig, maker.operator))) return 'BadSigner';
  if (hex0x(a.taker) !== lower(use.sender)) return 'WrongParty';
  if (hex0x(a.token) !== lower(ETH_ANY_TOKEN) && hex0x(a.token) !== lower(use.token)) return 'TokenNotAllowed';
  if (a.direction !== ETH_ANY_DIRECTION && a.direction !== use.direction) return 'WrongDirection';
  if (use.xmr > a.maxXmr) return 'AmountOutOfRange';
  if (use.now < a.notBefore || use.now > a.validUntil) return 'Expired';
  if (a.epoch !== maker.approvalEpoch) return 'StaleEpoch';
  if (use.revoked) return 'Revoked';
  return null;
}

/** The approval the contract takes when none is presented (with an empty signature). */
export const EMPTY_ETH_APPROVAL: EthApproval = Object.freeze({
  maker: new Uint8Array(20),
  taker: new Uint8Array(20),
  token: new Uint8Array(20),
  direction: 0,
  maxXmr: 0n,
  notBefore: 0n,
  validUntil: 0n,
  epoch: 0,
  approvalId: new Uint8Array(32),
});

// ------------------------------------------------------------------ compact form (the Solana board, quote responses)

/** `encodeEthQuoteCompact(quote, sig)`: 320 bytes (255 of quote, 65 of signature), the form of a board slot and of an Ethereum `quote_response`. */
export function encodeSignedQuote(q: EthQuote, sig: Bytes): Bytes {
  if (sig.length !== 65) throw new SdkError('BadSignature', 'an Ethereum signature is 65 bytes');
  return encodeEthQuoteCompact(q, sig);
}
export function decodeSignedQuote(bytes: Bytes): { quote: EthQuote; sig: Bytes } {
  const { quote, sig } = decodeEthQuoteCompact(bytes);
  if (!sig) throw new SdkError('BadSignature', 'the compact quote carries no signature');
  return { quote, sig };
}

/**
 * A quote from a maker's `EthBoard` on Solana, expanded and verified, or the reason it must be
 * discarded. The Solana program treats the board as opaque, so the client checks everything:
 * the quote's `maker` is the Ethereum address mutually linked to the board's owner (otherwise
 * one maker could post another's quotes), and the signature recovers to the operator
 * registered in the Ethereum contract for this chain and contract.
 */
export async function verifyBoardQuote(
  d: EthDeployment,
  slot: { quote: Bytes; sig: Bytes },
  ctx: { linkedEthMaker: Address | null; maker: EthMakerState; now: bigint },
): Promise<{ ok: true; quote: EthQuote; sig: Bytes } | { ok: false; reason: 'NotLinked' | 'Malformed' | EthQuoteProblem }> {
  if (slot.quote.length !== COMPACT_QUOTE_LEN || slot.sig.length !== 65) return { ok: false, reason: 'Malformed' };
  let quote: EthQuote;
  try {
    quote = decodeEthQuoteCompact(slot.quote).quote;
  } catch {
    return { ok: false, reason: 'Malformed' };
  }
  if (ctx.linkedEthMaker === null || !bytesEqual(quote.maker, unhex(ctx.linkedEthMaker))) return { ok: false, reason: 'NotLinked' };
  // A board quote is public: there is no sender or direction to match yet, only authenticity and freshness.
  const problem = await ethQuoteProblem(d, quote, slot.sig, ctx.maker, { now: ctx.now, direction: quote.direction, sender: hex0x(quote.taker) as Address, minLeftSecs: 0 });
  return problem ? { ok: false, reason: problem } : { ok: true, quote, sig: slot.sig };
}

