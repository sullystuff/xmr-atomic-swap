/**
 * Solana-side signed and posted objects (SPEC 2.9): the advance approval (an Ed25519 signature
 * by the maker's operator key over exactly 190 bytes) and the checks a client makes on a
 * taker-bound `Quote` account and on a public offer before it locks against them.
 *
 * The 190 bytes are produced by `@xmrswap/core-wasm` (`encodeSolApproval`); the signature is
 * plain Ed25519, verified with the strict rule the Solana precompile applies.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { type SolApprovalFields, encodeSolApproval, termsHash } from '@xmrswap/core-wasm';
import { type ApprovalResponseSolana, MAX_QUOTE_SECS, type Maker, type Offer, type Quote, SOL_APPROVAL_ANY, SOL_APPROVAL_LEN, base58Decode } from '@xmrswap/protocol';
import { type Bytes, SdkError, bytesEqual, concat, fromBase64, leToBig, toBase64, utf8 } from '../util.js';

/** `DS("sol-approval")`: 24 bytes. */
const APPROVAL_TAG = concat(utf8('xmrswap/v1/sol-approval'), Uint8Array.of(0));
const OFF = { clusterTag: 24, programId: 56, maker: 88, taker: 120, asset: 152, direction: 153, maxXmr: 154, notBefore: 162, expiresAt: 170, epoch: 178, approvalId: 182 } as const;

export interface SignedSolApproval {
  /** Exactly 190 bytes. */
  message: Bytes;
  /** 64 bytes. */
  signature: Bytes;
  /** The operator's public key, 32 bytes. */
  operatorPub: Bytes;
}

/** Sign an advance approval with the operator's 32-byte Ed25519 seed (maker side). */
export function signSolApproval(operatorSeed: Bytes, fields: SolApprovalFields): SignedSolApproval {
  const message = encodeSolApproval(fields);
  return { message, signature: ed25519.sign(message, operatorSeed), operatorPub: ed25519.getPublicKey(operatorSeed) };
}

/** Read the fields back out of the 190 bytes, as the program does. Throws when the bytes are not an approval. */
export function parseSolApproval(message: Bytes): SolApprovalFields {
  if (message.length !== SOL_APPROVAL_LEN) throw new SdkError('ApprovalInvalid', `an advance approval is exactly ${SOL_APPROVAL_LEN} bytes`);
  if (!bytesEqual(message.subarray(0, APPROVAL_TAG.length), APPROVAL_TAG)) throw new SdkError('ApprovalInvalid', 'the message does not begin with DS("sol-approval")');
  const u64 = (o: number) => leToBig(message.subarray(o, o + 8));
  return {
    clusterTag: message.slice(OFF.clusterTag, OFF.clusterTag + 32),
    programId: message.slice(OFF.programId, OFF.programId + 32),
    maker: message.slice(OFF.maker, OFF.maker + 32),
    taker: message.slice(OFF.taker, OFF.taker + 32),
    asset: message[OFF.asset]!,
    direction: message[OFF.direction]!,
    maxXmr: u64(OFF.maxXmr),
    notBefore: BigInt.asIntN(64, u64(OFF.notBefore)),
    expiresAt: BigInt.asIntN(64, u64(OFF.expiresAt)),
    epoch: Number(leToBig(message.subarray(OFF.epoch, OFF.epoch + 4))),
    approvalId: u64(OFF.approvalId),
  };
}

/** Strict Ed25519 verification (no ZIP-215 leniency), as the precompile does. */
export function verifyEd25519(signature: Bytes, message: Bytes, publicKey: Bytes): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** What the approval must be bound to: none of it is taken from the message itself. */
export interface SolApprovalBinding {
  /** `Config.cluster_tag` (the genesis hash), 32 bytes. */
  clusterTag: Bytes;
  programId: Bytes;
  /** Maker PDA. */
  maker: Bytes;
  /** The wallet that will sign the lock. */
  taker: Bytes;
  /** `maker.operator` from the registry. */
  operator: Bytes;
}

/** The lock an approval is about to be used for. */
export interface SolApprovalUse {
  asset: number;
  direction: number;
  xmr: bigint;
  /** Chain time. */
  now: bigint;
  /** `maker.approval_epoch`. */
  approvalEpoch: number;
}

/**
 * Why the program would refuse this approval for this lock, or `null` when it is acceptable.
 * `SignatureInvalid`: the Ed25519 precompile itself fails the transaction. `ApprovalInvalid`:
 * everything else (wrong key, cluster, program, maker or taker; outside its window; over its
 * size; wrong asset or direction; stale epoch). Clients run this before spending a lock on it.
 */
export function solApprovalProblem(a: { message: Bytes; signature: Bytes; operatorPub: Bytes }, bind: SolApprovalBinding, use: SolApprovalUse): 'SignatureInvalid' | 'ApprovalInvalid' | null {
  if (!verifyEd25519(a.signature, a.message, a.operatorPub)) return 'SignatureInvalid';
  if (!bytesEqual(a.operatorPub, bind.operator)) return 'ApprovalInvalid';
  let f: SolApprovalFields;
  try {
    f = parseSolApproval(a.message);
  } catch {
    return 'ApprovalInvalid';
  }
  // Replay protection: another cluster, another program, another maker or another taker.
  if (!bytesEqual(f.clusterTag, bind.clusterTag) || !bytesEqual(f.programId, bind.programId) || !bytesEqual(f.maker, bind.maker) || !bytesEqual(f.taker, bind.taker)) return 'ApprovalInvalid';
  if (f.asset !== SOL_APPROVAL_ANY && f.asset !== use.asset) return 'ApprovalInvalid';
  if (f.direction !== SOL_APPROVAL_ANY && f.direction !== use.direction) return 'ApprovalInvalid';
  if (use.xmr > f.maxXmr) return 'ApprovalInvalid';
  // Validity fields are inclusive on both ends.
  if (use.now < f.notBefore || use.now > f.expiresAt) return 'ApprovalInvalid';
  if (f.epoch !== use.approvalEpoch) return 'ApprovalInvalid';
  return null;
}

/**
 * Rebuild the signed approval from a maker's `approval_response`: the response carries only
 * the variable fields; the client fills in cluster, program, maker and taker itself, so a
 * response signed for anyone else simply fails verification.
 */
export function solApprovalFromResponse(r: ApprovalResponseSolana, bind: SolApprovalBinding): SignedSolApproval {
  const message = encodeSolApproval({
    clusterTag: bind.clusterTag,
    programId: bind.programId,
    maker: bind.maker,
    taker: bind.taker,
    asset: r.asset,
    direction: r.direction,
    maxXmr: BigInt(r.max_xmr),
    notBefore: BigInt(r.not_before),
    expiresAt: BigInt(r.expires_at),
    epoch: r.epoch,
    approvalId: BigInt(r.approval_id),
  });
  const signature = fromBase64(r.sig);
  if (!verifyEd25519(signature, message, bind.operator)) throw new SdkError('SignatureInvalid', 'the approval response is not signed by the maker operator for this taker, maker, program and cluster');
  return { message, signature, operatorPub: bind.operator };
}

/** The `approval_response` a maker sends for a signed approval (maker side). */
export function solApprovalResponse(a: SignedSolApproval): ApprovalResponseSolana {
  const f = parseSolApproval(a.message);
  return {
    t: 'approval_response',
    ok: true,
    chain: 'solana',
    asset: f.asset,
    direction: f.direction,
    max_xmr: f.maxXmr.toString(),
    not_before: f.notBefore.toString(),
    expires_at: f.expiresAt.toString(),
    epoch: f.epoch,
    approval_id: f.approvalId.toString(),
    sig: toBase64(a.signature),
  };
}

// ------------------------------------------------------------------ offers and taker-bound quotes

/** The `terms_hash` of an offer recomputed from its own fields (SPEC 4.2). */
export function offerTermsHash(o: Offer): Bytes {
  return termsHash({
    asset: o.asset,
    direction: o.direction,
    mode: o.mode,
    depBps: o.depBps,
    wA: o.wA,
    wN: o.wN,
    dC: o.dC,
    wC: o.wC,
    wF: o.wF,
    depthAbove: [o.depthAbove[0]!, o.depthAbove[1]!, o.depthAbove[2]!],
    depths: [o.depths[0]!, o.depths[1]!, o.depths[2]!],
  });
}

export type OfferProblem = 'Paused' | 'OfferDisabled' | 'OfferStale' | 'TermsChanged' | 'SeqTooOld';

/**
 * Why a lock against this offer would be refused right now, or `null`. `expectedTermsHash` is
 * the hash of the terms the user was shown; the program refuses the lock if they changed.
 */
export function offerProblem(o: Offer, maker: Maker, now: bigint, expect: { termsHash?: Bytes; minSeq?: bigint } = {}): OfferProblem | null {
  if (maker.paused !== 0) return 'Paused';
  if (o.enabled === 0) return 'OfferDisabled';
  // Validity is inclusive: live while now <= updated_at + valid_secs.
  if (now > o.updatedAt + BigInt(o.validSecs)) return 'OfferStale';
  if (expect.minSeq !== undefined && o.seq < expect.minSeq) return 'SeqTooOld';
  // The stored hash must be the hash of the stored terms, and equal to what the user saw.
  if (!bytesEqual(o.termsHash, offerTermsHash(o))) return 'TermsChanged';
  if (expect.termsHash && !bytesEqual(o.termsHash, expect.termsHash)) return 'TermsChanged';
  return null;
}

export type SolQuoteProblem = 'QuoteMismatch' | 'QuoteExpired' | 'StaleEpoch' | 'Paused';

/**
 * A taker-bound Solana quote is not a signed blob: the operator posts a `Quote` account and the
 * `quote_response` only names it. The client reads the account and checks it is what was asked
 * for before locking: bound to this maker and this taker, right market and size, still valid
 * (inclusive, at most 120 s after posting) and of the maker's current quote epoch.
 */
export function solQuoteProblem(
  q: Quote,
  maker: Maker,
  want: { makerPda: string; taker: string; asset: number; direction: number; xmr: bigint; quoteId: bigint; now: bigint },
): SolQuoteProblem | null {
  if (maker.paused !== 0) return 'Paused';
  if (q.maker !== want.makerPda || q.taker !== want.taker || q.asset !== want.asset || q.direction !== want.direction || q.xmr !== want.xmr || q.quoteId !== want.quoteId) return 'QuoteMismatch';
  if (want.now > q.expiresAt) return 'QuoteExpired';
  // Posted at most MAX_QUOTE_SECS before it expires: anything further out is not a quote this program accepted.
  if (q.expiresAt - want.now > BigInt(MAX_QUOTE_SECS)) return 'QuoteMismatch';
  if (q.epoch !== maker.quoteEpoch) return 'StaleEpoch';
  return null;
}

/** 32 bytes of a base58 public key. */
export const keyBytes = (base58: string): Bytes => {
  const b = base58Decode(base58);
  if (b.length !== 32) throw new SdkError('BadKey', 'a Solana public key is 32 bytes');
  return b;
};
