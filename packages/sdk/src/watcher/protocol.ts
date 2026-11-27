/**
 * The watcher protocol, client side and wire formats (Amendment 1, SPEC 11.6).
 *
 * A watcher is given one thing: the swap's notice key `K("notice")` (SPEC 2.8), a 32-byte key
 * that decrypts that one swap's notice and nothing else. The locker's client computes it at
 * lock or fund time, before any notice exists, and posts it to the watcher it chose:
 *
 *   GET  /watch/v1/info               → { solana, ethereum, max_swaps, monero_nodes }
 *   POST /watch/v1/swaps              ← { chain, swap_ref, notice_key }  → { swap_ref, watching_until, sig }
 *   GET  /watch/v1/swaps/<swap_ref>   → what it has seen and done
 *
 * `notice_key` never travels in clear: it is sealed to the watcher's own key (the Solana key of
 * `/watch/v1/info`, an Ed25519 key, in its X25519 form), bound to the chain and the swap, so a
 * TLS-terminating proxy, a log line or a replay to another swap learns nothing. The format is
 * `sealNoticeKey` below; the watcher service opens it with `openSealedNoticeKey`.
 *
 * The acknowledgement is signed with the same Ed25519 key over `watchAckBytes`; the UI may say
 * "safe to close" only after `verifyWatchAck` (SPEC 11.6, warning item 8).
 *
 * The core exports no function that takes `K("notice")` itself (it derives the key inside
 * `noticeSeal` / `noticeOpen`), so the key derivation and the keyed open are written here with
 * the same primitives (X25519, HKDF-SHA256, XChaCha20-Poly1305) and tested against
 * `notice.json` and against the core's own seal (DEVIATIONS.md, W1).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CHAIN_TAG, isLowOrderX25519, noticeCommitment, x25519Public } from '@xmrswap/core-wasm';
import { type ChainName, NOTICE_CIPHERTEXT_LEN, SWAP_FLAG, base58Decode } from '@xmrswap/protocol';
import { type SwapView, hasFlag } from '../machine/view.js';
import type { HttpFetch } from '../messages/transports.js';
import { type Bytes, SdkError, bigToLe, bytesEqual, concat, fromBase64, hex, toBase64, unhex } from '../util.js';

const te = new TextEncoder();
/** `DS(tag)`: `xmrswap/v1/` ‖ tag ‖ 0x00 (SPEC 2.1). */
const ds = (tag: string): Bytes => te.encode(`xmrswap/v1/${tag}\0`);

export const WATCH_ROUTES = { info: '/watch/v1/info', swaps: '/watch/v1/swaps', swap: (swapRefHex: string): string => `/watch/v1/swaps/${swapRefHex}` } as const;
/** `eph_pub[32] ‖ nonce[24] ‖ XChaCha20-Poly1305(key[32])[48]`. */
export const SEALED_NOTICE_KEY_LEN = 104;

// ------------------------------------------------------------------ K("notice")

/**
 * `K("notice") = HKDF-SHA256(ikm = X25519(own, peer), salt = DS("ecdh"), info = "notice" ‖ 0x00 ‖ taker_pub ‖ maker_pub, 32)`.
 * `side` is the caller's. Computable before the notice exists: both public keys are fixed at
 * lock (direction A) or known to the maker at fund (direction B).
 */
export function noticeKeyFor(a: { side: 'taker' | 'maker'; ownEncSecret: Bytes; peerEncPub: Bytes }): Bytes {
  if (a.ownEncSecret.length !== 32 || a.peerEncPub.length !== 32) throw new SdkError('BadKey', 'an X25519 key is 32 bytes');
  if (isLowOrderX25519(a.peerEncPub)) throw new SdkError('LowOrderEncryptionKey', 'the counterparty encryption key is a low-order point');
  const own = x25519Public(a.ownEncSecret);
  const dh = x25519.getSharedSecret(a.ownEncSecret, a.peerEncPub);
  const [takerPub, makerPub] = a.side === 'taker' ? [own, a.peerEncPub] : [a.peerEncPub, own];
  const key = hkdf(sha256, dh, ds('ecdh'), concat(te.encode('notice\0'), takerPub, makerPub), 32);
  dh.fill(0);
  return key;
}

/** The notice key of a swap for its **locker** (A: the taker, with the swap's one-time `enc` secret; B: the maker, with the secret of the key version recorded in the swap). */
export function noticeKey(s: Pick<SwapView, 'direction' | 'takerEncKey' | 'makerEncKey'>, lockerEncSecret: Bytes): Bytes {
  const side = s.direction === 0 ? 'taker' : 'maker';
  return noticeKeyFor({ side, ownEncSecret: lockerEncSecret, peerEncPub: side === 'taker' ? s.makerEncKey : s.takerEncKey });
}

/**
 * The watcher's reading of the notice on record with nothing but the notice key: `(txid, v_C)`,
 * or `null` when there is no notice, the ciphertext does not decrypt under this key, or the
 * opening does not match the on-chain commitment. `null` on a swap that has a notice is "no
 * lock" (SPEC 2.8): the watcher freezes. A wrong key gives the same `null`, which is why the
 * service accepts a key only for a swap that names it, and why a freeze costs the claimer at
 * most `W_z`.
 */
export function openNoticeWithKey(s: Pick<SwapView, 'swapRef' | 'flags' | 'noticeCt' | 'noticeCommitment'>, key: Bytes): { txid: Bytes; view: Bytes } | null {
  if (key.length !== 32) throw new SdkError('BadKey', 'a notice key is 32 bytes');
  if (!hasFlag(s as SwapView, SWAP_FLAG.NOTICE) || s.noticeCt.length !== NOTICE_CIPHERTEXT_LEN) return null;
  let pt: Bytes;
  try {
    pt = xchacha20poly1305(key, s.noticeCt.subarray(0, 24), s.swapRef).decrypt(s.noticeCt.subarray(24));
  } catch {
    return null;
  }
  if (pt.length !== 64) return null;
  const txid = pt.slice(0, 32);
  const view = pt.slice(32);
  return bytesEqual(noticeCommitment(s.swapRef, txid, view), s.noticeCommitment) ? { txid, view } : null;
}

// ------------------------------------------------------------------ sealing the key to the watcher

const chainByte = (chain: ChainName): Bytes => Uint8Array.of(CHAIN_TAG[chain]);
function watcherX25519(watcherSolanaKey: string | Bytes): Bytes {
  const ed = typeof watcherSolanaKey === 'string' ? base58Decode(watcherSolanaKey) : watcherSolanaKey;
  if (ed.length !== 32) throw new SdkError('BadKey', 'the watcher key is a 32-byte Ed25519 key');
  let mont: Bytes;
  try {
    mont = ed25519.utils.toMontgomery(ed);
  } catch {
    throw new SdkError('BadKey', 'the watcher key is not a valid Ed25519 point');
  }
  if (isLowOrderX25519(mont)) throw new SdkError('LowOrderEncryptionKey', 'the watcher key is a low-order point');
  return mont;
}
const sealKey = (dh: Bytes, ephPub: Bytes, watcherPub: Bytes): Bytes => hkdf(sha256, dh, ds('watch'), concat(ephPub, watcherPub), 32);

/**
 * Seal a notice key to a watcher: `eph_pub ‖ nonce ‖ XChaCha20-Poly1305(k, nonce, aad, notice_key)`
 * with `k = HKDF-SHA256(X25519(eph, W), DS("watch"), eph_pub ‖ W, 32)`, `W` the watcher's
 * Solana key in X25519 form, and `aad = chain_tag ‖ swap_ref`. 104 bytes.
 */
export function sealNoticeKey(a: { noticeKey: Bytes; watcherSolanaKey: string | Bytes; chain: ChainName; swapRef: Bytes; ephemeralSecret?: Bytes; nonce?: Bytes }): Bytes {
  if (a.noticeKey.length !== 32) throw new SdkError('BadKey', 'a notice key is 32 bytes');
  if (a.swapRef.length !== 32) throw new SdkError('BadLength', 'a swap_ref is 32 bytes');
  const w = watcherX25519(a.watcherSolanaKey);
  const eph = a.ephemeralSecret ?? crypto.getRandomValues(new Uint8Array(32));
  const nonce = a.nonce ?? crypto.getRandomValues(new Uint8Array(24));
  const ephPub = x25519.getPublicKey(eph);
  const key = sealKey(x25519.getSharedSecret(eph, w), ephPub, w);
  const ct = xchacha20poly1305(key, nonce, concat(chainByte(a.chain), a.swapRef)).encrypt(a.noticeKey);
  key.fill(0);
  return concat(ephPub, nonce, ct);
}

/**
 * The watcher's side: open a sealed notice key with the 32-byte seed of its Solana key. Throws
 * `WatchKeyInvalid` for anything not sealed to this key for this chain and swap.
 */
export function openSealedNoticeKey(a: { sealed: Bytes; watcherSeed: Bytes; chain: ChainName; swapRef: Bytes }): Bytes {
  if (a.sealed.length !== SEALED_NOTICE_KEY_LEN) throw new SdkError('WatchKeyInvalid', `a sealed notice key is ${SEALED_NOTICE_KEY_LEN} bytes`);
  if (a.watcherSeed.length !== 32 || a.swapRef.length !== 32) throw new SdkError('BadLength', 'the seed and the swap_ref are 32 bytes');
  const ephPub = a.sealed.subarray(0, 32);
  if (isLowOrderX25519(ephPub)) throw new SdkError('WatchKeyInvalid', 'the ephemeral key is a low-order point');
  const secret = ed25519.utils.toMontgomerySecret(a.watcherSeed);
  const w = x25519.getPublicKey(secret);
  const key = sealKey(x25519.getSharedSecret(secret, ephPub), ephPub, w);
  try {
    return xchacha20poly1305(key, a.sealed.subarray(32, 56), concat(chainByte(a.chain), a.swapRef)).decrypt(a.sealed.subarray(56));
  } catch {
    throw new SdkError('WatchKeyInvalid', 'the notice key is not sealed to this watcher for this swap');
  } finally {
    key.fill(0);
    secret.fill(0);
  }
}

// ------------------------------------------------------------------ wire types

/** `GET /watch/v1/info`. */
export interface WatchInfo {
  /** The watcher's Solana key, base58: name it in `lock` / `fund`; notice keys are sealed to it and acknowledgements are signed with it. */
  solana: string;
  /** The watcher's Ethereum address: name it in `lock` / `fund` there. */
  ethereum: string;
  max_swaps: number;
  /** How many Monero nodes it verifies against. */
  monero_nodes: number;
}
/** `POST /watch/v1/swaps`. */
export interface WatchRequest {
  chain: ChainName;
  /** 64 hex characters. */
  swap_ref: string;
  /** `sealNoticeKey`, base64 (104 bytes). */
  notice_key: string;
}
/** The signed acknowledgement. */
export interface WatchAck {
  swap_ref: string;
  /** Unix seconds: the latest `T_co` the swap can have; the watcher follows it until then. */
  watching_until: number;
  /** Ed25519 by the watcher's Solana key over `watchAckBytes`, base64. */
  sig: string;
}

export function parseWatchInfo(j: unknown): WatchInfo {
  const o = j as Partial<WatchInfo> | null;
  if (!o || typeof o.solana !== 'string' || typeof o.ethereum !== 'string' || !Number.isInteger(o.max_swaps) || !Number.isInteger(o.monero_nodes)) throw new SdkError('WatcherMalformed', 'not a /watch/v1/info answer');
  let sol: Bytes;
  try {
    sol = base58Decode(o.solana);
  } catch {
    sol = new Uint8Array(0);
  }
  if (sol.length !== 32 || !/^0x[0-9a-fA-F]{40}$/.test(o.ethereum)) throw new SdkError('WatcherMalformed', 'the watcher keys are malformed');
  return { solana: o.solana, ethereum: o.ethereum.toLowerCase(), max_swaps: o.max_swaps!, monero_nodes: o.monero_nodes! };
}

/** The request the locker posts. `watcherSolanaKey` comes from `/watch/v1/info` (always the Solana key, whichever chain the swap is on). */
export function watchRequest(a: { chain: ChainName; swapRef: Bytes; noticeKey: Bytes; watcherSolanaKey: string }): WatchRequest {
  return { chain: a.chain, swap_ref: hex(a.swapRef), notice_key: toBase64(sealNoticeKey(a)) };
}

/** The watcher's side: validate a request body and recover the notice key. */
export function openWatchRequest(body: unknown, watcherSeed: Bytes): { chain: ChainName; swapRef: Bytes; noticeKey: Bytes } {
  const o = body as Partial<WatchRequest> | null;
  if (!o || (o.chain !== 'solana' && o.chain !== 'ethereum') || typeof o.swap_ref !== 'string' || !/^[0-9a-f]{64}$/.test(o.swap_ref) || typeof o.notice_key !== 'string') throw new SdkError('bad_request', 'not a watch request');
  let sealed: Bytes;
  try {
    sealed = fromBase64(o.notice_key);
  } catch {
    throw new SdkError('WatchKeyInvalid', 'notice_key is not base64');
  }
  const swapRef = unhex(o.swap_ref);
  return { chain: o.chain, swapRef, noticeKey: openSealedNoticeKey({ sealed, watcherSeed, chain: o.chain, swapRef }) };
}

/** What the acknowledgement signs: `DS("watch-ack") ‖ chain_tag ‖ swap_ref ‖ watching_until (u64 LE)`. */
export function watchAckBytes(chain: ChainName, swapRef: Bytes, watchingUntil: bigint | number): Bytes {
  if (swapRef.length !== 32) throw new SdkError('BadLength', 'a swap_ref is 32 bytes');
  return concat(ds('watch-ack'), chainByte(chain), swapRef, bigToLe(BigInt(watchingUntil), 8));
}
/** The watcher's side: sign an acknowledgement. */
export function signWatchAck(a: { chain: ChainName; swapRef: Bytes; watchingUntil: bigint | number; watcherSeed: Bytes }): WatchAck {
  return { swap_ref: hex(a.swapRef), watching_until: Number(a.watchingUntil), sig: toBase64(ed25519.sign(watchAckBytes(a.chain, a.swapRef, a.watchingUntil), a.watcherSeed)) };
}
/**
 * Whether an acknowledgement is the named watcher's for this swap. Only then may the UI treat
 * the swap as watched. `watching_until` is the watcher's promise, not a chain fact: compare it
 * with the swap's own `T_co` once a notice exists.
 */
export function verifyWatchAck(ack: unknown, want: { chain: ChainName; swapRef: Bytes; watcherSolanaKey: string }): ack is WatchAck {
  const a = ack as Partial<WatchAck> | null;
  if (!a || a.swap_ref !== hex(want.swapRef) || typeof a.sig !== 'string' || !Number.isSafeInteger(a.watching_until) || a.watching_until! < 0) return false;
  try {
    return ed25519.verify(fromBase64(a.sig), watchAckBytes(want.chain, want.swapRef, a.watching_until!), base58Decode(want.watcherSolanaKey));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ HTTP client

const defaultFetch: HttpFetch = (url, init) => fetch(url, init as RequestInit);

/** The watcher answered with an error status. */
export class WatcherRefused extends SdkError {
  readonly status: number;
  constructor(status: number, detail: string) {
    super('WatcherRefused', `the watcher answered ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'WatcherRefused';
    this.status = status;
  }
}

/**
 * The locker's client for one watcher. `fetchFn` is any HTTP fetch: HTTPS to a hosted or
 * self-hosted watcher, or a fetch that goes through Tor for an onion address. Nothing here is
 * trusted: the info answer is shape-checked, the key is sealed, and the acknowledgement is
 * verified against the key the swap names.
 */
export class WatcherClient {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly fetchFn: HttpFetch = defaultFetch,
    private readonly timeoutMs = 15_000,
  ) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async json(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res;
    try {
      res = await this.fetchFn(`${this.base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new SdkError('unavailable', `the watcher is unreachable: ${(e as Error).message}`);
    }
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    if (res.status < 200 || res.status >= 300) throw new WatcherRefused(res.status, text.slice(0, 200));
    try {
      return JSON.parse(text);
    } catch {
      throw new SdkError('WatcherMalformed', 'the watcher did not answer with JSON');
    }
  }

  /** `GET /watch/v1/info`: the keys to name as watcher. */
  async info(): Promise<WatchInfo> {
    return parseWatchInfo(await this.json('GET', WATCH_ROUTES.info));
  }

  /**
   * `POST /watch/v1/swaps`: hand the swap to the watcher. Call it once the swap that names the
   * watcher is final on its chain (the service accepts only a swap it finds at `finalized`).
   * Returns the verified acknowledgement; a missing or wrongly signed one throws
   * `WatchAckInvalid` and the swap must be treated as not watched.
   */
  async register(a: { chain: ChainName; swapRef: Bytes; noticeKey: Bytes; watcherSolanaKey: string }): Promise<WatchAck> {
    const ack = await this.json('POST', WATCH_ROUTES.swaps, watchRequest(a));
    if (!verifyWatchAck(ack, a)) throw new SdkError('WatchAckInvalid', 'the acknowledgement is not signed by the watcher this swap names');
    return ack;
  }

  /** `GET /watch/v1/swaps/<swap_ref>`: what the watcher has seen and done. The shape is the service's; nothing here relies on it. */
  status(swapRef: Bytes): Promise<unknown> {
    return this.json('GET', WATCH_ROUTES.swap(hex(swapRef)));
  }
}
