/**
 * Per-swap secrets and what is computed from them (SPEC 2.2, 2.5, 2.8, 8.4). Everything
 * cryptographic is a call into `@xmrswap/core-wasm`; this file only says which bytes go where.
 */
import { CHAIN_TAG, type DerivedKeys, type JointAddress, type Network, addScalars, contactShareId, deriveKeys, isLowOrderX25519, jointAddress, noticeCommitment, noticeOpen, noticeSeal, openHashEthereum, openHashSolana, scalarMatches, validatePoint } from '@xmrswap/core-wasm';
import { type ChainName, type ExportedJointWallet, NOTICE_CIPHERTEXT_LEN, SWAP_FLAG, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import { type SwapView, hasFlag } from '../machine/view.js';
import { type Bytes, SdkError, bytesEqual, hex, isZero, unhex } from '../util.js';

/** The taker's keys for one swap: derived from the recovery seed and the swap's on-chain nonce, so nothing needs storing. */
export function takerSwapKeys(seed: Bytes, chain: ChainName, swapNonce: Bytes): DerivedKeys {
  if (seed.length !== 32) throw new SdkError('BadSeed', 'the recovery seed is 32 bytes');
  if (swapNonce.length !== 16) throw new SdkError('BadNonce', 'a swap nonce is 16 bytes');
  return deriveKeys(seed, CHAIN_TAG[chain], swapNonce);
}

/** A maker's keys for one share: derived from the keystore seed and the random share id written to the database first. */
export function makerShareKeys(seed: Bytes, chain: ChainName, shareId: Bytes): DerivedKeys {
  if (shareId.length !== 16) throw new SdkError('BadShareId', 'a share id is 16 bytes');
  return deriveKeys(seed, CHAIN_TAG[chain], shareId);
}

/** A fresh random swap nonce. One per swap, never reused: every swap publishes one of the two shares. */
export function newSwapNonce(): Bytes {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** The taker's per-maker contact key for messages that concern no swap (SPEC 2.2). `makerPda` is base58 or 32 bytes. */
export function contactKeys(seed: Bytes, makerPda: string | Bytes): { encSecret: Bytes; encPub: Bytes } {
  const pda = typeof makerPda === 'string' ? base58Decode(makerPda) : makerPda;
  const k = deriveKeys(seed, CHAIN_TAG.solana, contactShareId(pda));
  return { encSecret: k.encSecret, encPub: k.encPub };
}

/**
 * Checks each client makes on the counterparty's commitment before deriving a joint address
 * (SPEC 2.3, 2.6): a valid prime-order point, and not the client's own share ("a blob proves a
 * statement, not who made it").
 */
export function checkCounterpartyShare(theirs: Bytes, own: Bytes): void {
  if (!validatePoint(theirs)) throw new SdkError('InvalidKeyCommitment', 'the counterparty spend commitment is not a prime-order point');
  if (bytesEqual(theirs, own)) throw new SdkError('OwnShareReplayed', 'the counterparty commitment equals our own');
}

/**
 * The joint Monero address of a swap from the four halves. Never trust an address sent by the
 * other side. `claimerView` is the claimer's private view share: the caller's own when it is
 * the claimer, otherwise the one decrypted from the notice.
 */
export function swapJointAddress(s: SwapView, claimerView: Bytes, network: Network): JointAddress {
  if (isZero(s.makerSpendPub)) throw new SdkError('NoMakerShare', 'the maker spend commitment is not known yet');
  if (isZero(s.lockerView)) throw new SdkError('NoLockerView', 'the locker view share is not on record yet');
  checkCounterpartyShare(s.makerSpendPub, s.takerSpendPub);
  // jointAddress validates both commitments and both view shares and refuses a zero sum.
  return jointAddress(s.makerSpendPub, s.takerSpendPub, s.lockerView, claimerView, network);
}

export type Side = 'taker' | 'maker';
const claimerSide = (s: SwapView): Side => (s.direction === 0 ? 'maker' : 'taker');

/** The X25519 public key of the other side as stored in the swap. Low-order keys are refused. */
function peerEncKey(s: SwapView, side: Side): Bytes {
  const peer = side === 'taker' ? s.makerEncKey : s.takerEncKey;
  if (isLowOrderX25519(peer)) throw new SdkError('LowOrderEncryptionKey', 'the counterparty encryption key is a low-order point');
  return peer;
}

export interface NoticeToPost {
  commitment: Bytes;
  /** 104 bytes. */
  ciphertext: Bytes;
}

/** Build the lock notice the claimer posts: the commitment and the ciphertext for the locker. */
export function buildNotice(s: SwapView, ownEncSecret: Bytes, txid: Bytes, ownView: Bytes): NoticeToPost {
  if (txid.length !== 32) throw new SdkError('BadTxid', 'a Monero transaction id is 32 bytes');
  const side = claimerSide(s);
  const ciphertext = noticeSeal({ ownSecret: ownEncSecret, peerPub: peerEncKey(s, side), side, swapRef: s.swapRef, txid, view: ownView });
  return { commitment: noticeCommitment(s.swapRef, txid, ownView), ciphertext };
}

/**
 * The locker's reading of the notice on record: `(txid, v_C)`, or `null` when the ciphertext
 * does not decrypt or does not open the commitment, which is treated as "no lock" (SPEC 2.8).
 */
export function openNotice(s: SwapView, ownEncSecret: Bytes): { txid: Bytes; view: Bytes } | null {
  if (!hasFlag(s, SWAP_FLAG.NOTICE) || s.noticeCt.length !== NOTICE_CIPHERTEXT_LEN) return null;
  const side: Side = claimerSide(s) === 'maker' ? 'taker' : 'maker';
  try {
    return noticeOpen({ ownSecret: ownEncSecret, peerPub: peerEncKey(s, side), side, swapRef: s.swapRef, ciphertext: s.noticeCt, commitment: s.noticeCommitment });
  } catch {
    return null;
  }
}

/** Evidence `(txid, v_C)` opens the swap's notice commitment. What `withhold` and `publish_evidence` check on-chain. */
export function evidenceOpens(s: SwapView, txid: Bytes, view: Bytes): boolean {
  return hasFlag(s, SWAP_FLAG.NOTICE) && bytesEqual(noticeCommitment(s.swapRef, txid, view), s.noticeCommitment);
}

/**
 * The joint private spend key once the other share is public: the caller's own share plus the
 * scalar revealed in the swap. The revealed scalar is checked against the commitment the swap
 * stored for the party that revealed it; a mismatch means the state read is not what it claims.
 */
export function jointSpendKey(s: SwapView, ownSpend: Bytes, own: Side): Bytes {
  if (!hasFlag(s, SWAP_FLAG.REVEALED)) throw new SdkError('NothingRevealed', 'no spend share was revealed in this swap');
  const revealerIsLocker = hasFlag(s, SWAP_FLAG.REVEALER_LOCKER);
  const lockerIsTaker = s.direction === 0;
  const revealer: Side = revealerIsLocker === lockerIsTaker ? 'taker' : 'maker';
  if (revealer === own) throw new SdkError('OwnShareRevealed', 'the revealed share is our own; the other side holds the joint key');
  const theirPub = revealer === 'taker' ? s.takerSpendPub : s.makerSpendPub;
  const ownPub = own === 'taker' ? s.takerSpendPub : s.makerSpendPub;
  if (!scalarMatches(s.revealed, theirPub)) throw new SdkError('ScalarMismatch', 'the revealed scalar does not open the counterparty commitment');
  if (!scalarMatches(ownSpend, ownPub)) throw new SdkError('ScalarMismatch', 'our share does not open our own commitment in this swap');
  return addScalars(ownSpend, s.revealed);
}

/** "Export keys": what restores the joint wallet in standard Monero wallet software (SPEC 8.4). */
export function exportJointWallet(joint: JointAddress, spendKey: Bytes, lockTxid: Bytes, lockHeight: number): ExportedJointWallet {
  return { address: joint.address, view_key: hex(joint.viewPriv), spend_key: hex(spendKey), lock_txid: hex(lockTxid), lock_height: lockHeight };
}

/**
 * The open hash of a pending swap (SPEC 3.12): what `approve`, `fund` and `reject` pass as
 * `expected_open`, so the maker's transaction applies only to the lock its rules and proof
 * checks examined. Computed from the swap the caller read, never taken from the chain: on
 * Ethereum the stored `openHash` must equal it, and a mismatch means the state read is not the
 * lock that will be approved.
 */
export function expectedOpen(s: SwapView): Bytes {
  if (s.state !== SWAP_STATE.PENDING) throw new SdkError('BadState', 'only a pending swap has an open hash to approve');
  // The locker's view share as stored at lock: the taker's in A, zeros in B (the maker's arrives with fund).
  const lockerView = s.direction === 0 ? s.lockerView : new Uint8Array(32);
  if (s.chain === 'solana') {
    return openHashSolana({ swap: s.swapRef, tLock: s.tLock, direction: s.direction, asset: Number(s.asset), xmr: s.xmr, amount: s.amount, deposit: s.deposit, takerSpendPub: s.takerSpendPub, lockerView, takerEncKey: s.takerEncKey, makerEncKey: s.makerEncKey });
  }
  if (!s.eth) throw new SdkError('BadState', 'an Ethereum swap view carries its twin commitments');
  const computed = openHashEthereum({
    swapId: s.swapRef,
    tLock: s.tLock,
    direction: s.direction,
    token: unhex(s.asset),
    xmr: s.xmr,
    amount: s.amount,
    deposit: s.deposit,
    takerSpendPub: s.takerSpendPub,
    takerKey: unhex(s.eth.takerKey),
    takerKey2: unhex(s.eth.takerKey2),
    takerView: lockerView,
    takerEncKey: s.takerEncKey,
    makerEncKey: s.makerEncKey,
    keyLeaf: s.eth.keyLeaf,
  });
  if (!bytesEqual(computed, s.eth.openHash)) throw new SdkError('OpenHashMismatch', 'the stored open hash is not the hash of the stored lock');
  return computed;
}
