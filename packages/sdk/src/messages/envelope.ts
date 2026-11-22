/**
 * Typed messages inside envelopes (SPEC 2.8, 6.1). Sealing, opening and the maker's signature
 * are the core's; this module chooses keys and key versions, applies the size caps, parses the
 * JSON, and refuses what the protocol refuses (a stale key version, a maker message without the
 * operator's signature, a message type the sender may not send).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ENVELOPE_MAX_ONCHAIN, ENVELOPE_MAX_TOR, type EnvelopeHeader, envelopeHeader, envelopeOpen, envelopeSeal, envelopeSign, isLowOrderX25519, x25519Public } from '@xmrswap/core-wasm';
import { MAKER_MESSAGE_TYPES, type Maker, type Message, encodeMessage, parseMessage } from '@xmrswap/protocol';
import { type Bytes, SdkError, hex } from '../util.js';

export type TransportKind = 'solana' | 'tor' | 'ethereum';
/** Size cap of a finished envelope per transport: 900 bytes on-chain, 16,384 over Tor. */
export const ENVELOPE_CAP: Readonly<Record<TransportKind, number>> = { solana: ENVELOPE_MAX_ONCHAIN, ethereum: ENVELOPE_MAX_ONCHAIN, tor: ENVELOPE_MAX_TOR };

/** The part of the Solana maker record that message encryption depends on. */
export type MakerEncState = Pick<Maker, 'encKey' | 'encKeyVersion' | 'prevEncKey' | 'prevEncKeyExpiresAt' | 'operator'>;

/**
 * The maker's X25519 key of a version: the current one, or the previous one while
 * `now < prev_enc_key_expires_at`. Anything else is stale (`null`); the sender re-reads the
 * registry and sends again.
 */
export function makerEncKeyFor(maker: Pick<MakerEncState, 'encKey' | 'encKeyVersion' | 'prevEncKey' | 'prevEncKeyExpiresAt'>, version: number, now: bigint): Bytes | null {
  if (version === maker.encKeyVersion) return maker.encKey;
  if (version === maker.encKeyVersion - 1 && version >= 1 && now < maker.prevEncKeyExpiresAt) return maker.prevEncKey;
  return null;
}

/** `in_reply_to`: SHA-256 of the request envelope, lowercase hex. */
export const envelopeHash = (envelope: Bytes): string => hex(sha256(envelope));

// ------------------------------------------------------------------ taker side

/**
 * Seal a message to a maker with the maker's current key. `ownEncSecret` is the swap's one-time
 * key for a swap-bound message (pass `swapRef`), otherwise the per-maker contact key.
 */
export function sealToMaker(a: { message: Message; ownEncSecret: Bytes; maker: Pick<MakerEncState, 'encKey' | 'encKeyVersion'>; swapRef?: Bytes; transport: TransportKind; nonce?: Bytes }): Bytes {
  if (MAKER_MESSAGE_TYPES.includes(a.message.t)) throw new SdkError('bad_request', `${a.message.t} is a message only a maker sends`);
  if (isLowOrderX25519(a.maker.encKey)) throw new SdkError('LowOrderEncryptionKey', 'the maker encryption key is a low-order point');
  parseMessage(encodeMessage(a.message)); // the same shape check the recipient applies
  return envelopeSeal({
    fromMaker: false,
    makerKeyVersion: a.maker.encKeyVersion,
    ownSecret: a.ownEncSecret,
    peerPub: a.maker.encKey,
    plaintext: encodeMessage(a.message),
    maxLen: ENVELOPE_CAP[a.transport],
    ...(a.swapRef ? { swapRef: a.swapRef } : {}),
    ...(a.nonce ? { nonce: a.nonce } : {}),
  });
}

/**
 * Open a maker's reply. The envelope must carry the operator's signature (verified against
 * `maker.operator` from the registry), be addressed to our key, and name a key version the
 * registry still knows. `operatorPub` is the 32 bytes of `maker.operator`.
 */
export function openFromMaker(a: { envelope: Bytes; ownEncSecret: Bytes; maker: Pick<MakerEncState, 'encKey' | 'encKeyVersion' | 'prevEncKey' | 'prevEncKeyExpiresAt'>; operatorPub: Bytes; now: bigint; swapRef?: Bytes }): { message: Message; header: EnvelopeHeader } {
  const header = envelopeHeader(a.envelope);
  if (!header.fromMaker) throw new SdkError('EnvelopeBadSignature', 'a reply from a maker must have flag bit 0 set and be signed');
  const makerPub = makerEncKeyFor(a.maker, header.makerKeyVersion, a.now);
  if (!makerPub) throw new SdkError('stale_key', `the reply names maker key version ${header.makerKeyVersion}, which the registry no longer lists`);
  const own = x25519Public(a.ownEncSecret);
  if (hex(own) !== hex(header.takerPub)) throw new SdkError('EnvelopeMalformed', 'the envelope is addressed to another key');
  if (a.swapRef && hex(a.swapRef) !== hex(header.swapRef)) throw new SdkError('EnvelopeMalformed', 'the reply is bound to another swap');
  const { plaintext } = envelopeOpen({ envelope: a.envelope, ownSecret: a.ownEncSecret, makerPub, operatorPub: a.operatorPub });
  const message = parseMessage(plaintext);
  if (!MAKER_MESSAGE_TYPES.includes(message.t)) throw new SdkError('bad_request', `a maker may not send ${message.t}`);
  return { message, header };
}

// ------------------------------------------------------------------ maker side

/**
 * Open an envelope from a taker (daemon). `secretFor(version)` returns the private key of a key
 * version the daemon still holds, or `null`. A version that is neither current nor the
 * unexpired previous one is refused with `stale_key`, as is one whose private key is gone.
 */
export function openFromTaker(a: { envelope: Bytes; maker: Pick<MakerEncState, 'encKey' | 'encKeyVersion' | 'prevEncKey' | 'prevEncKeyExpiresAt'>; secretFor: (version: number) => Bytes | null; now: bigint; transport: TransportKind }): { message: Message; header: EnvelopeHeader } {
  if (a.envelope.length > ENVELOPE_CAP[a.transport]) throw new SdkError('too_large', `${a.envelope.length} bytes is over the ${ENVELOPE_CAP[a.transport]}-byte cap of this transport`);
  const header = envelopeHeader(a.envelope);
  if (header.fromMaker) throw new SdkError('bad_request', 'a maker-flagged envelope cannot be a request');
  const secret = makerEncKeyFor(a.maker, header.makerKeyVersion, a.now) ? a.secretFor(header.makerKeyVersion) : null;
  if (!secret) throw new SdkError('stale_key', `key version ${header.makerKeyVersion} is not current`);
  const { plaintext } = envelopeOpen({ envelope: a.envelope, ownSecret: secret });
  let message: Message;
  try {
    message = parseMessage(plaintext);
  } catch (e) {
    throw new SdkError('bad_request', (e as Error).message);
  }
  if (MAKER_MESSAGE_TYPES.includes(message.t)) throw new SdkError('bad_request', `${message.t} is a message only a maker sends`);
  return { message, header };
}

/**
 * Seal and sign a reply to a taker (daemon): encrypted to `takerPub` (the "key for the reply"
 * in the request's header) with the same key version the request used, flag bit 0 set, and the
 * operator's Ed25519 signature appended.
 */
export function sealToTaker(a: { message: Message; makerEncSecret: Bytes; makerKeyVersion: number; takerPub: Bytes; swapRef?: Bytes; operatorSeed: Bytes; transport: TransportKind; nonce?: Bytes }): Bytes {
  if (!MAKER_MESSAGE_TYPES.includes(a.message.t)) throw new SdkError('bad_request', `a maker may not send ${a.message.t}`);
  if (isLowOrderX25519(a.takerPub)) throw new SdkError('LowOrderEncryptionKey', 'the taker key is a low-order point');
  const sealed = envelopeSeal({
    fromMaker: true,
    makerKeyVersion: a.makerKeyVersion,
    ownSecret: a.makerEncSecret,
    peerPub: a.takerPub,
    plaintext: encodeMessage(a.message),
    maxLen: ENVELOPE_CAP[a.transport],
    ...(a.swapRef ? { swapRef: a.swapRef } : {}),
    ...(a.nonce ? { nonce: a.nonce } : {}),
  });
  return envelopeSign(sealed, a.operatorSeed);
}
