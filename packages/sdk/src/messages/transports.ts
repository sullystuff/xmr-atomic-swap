/**
 * Message transports (SPEC 6.2 to 6.5): the maker's HTTP endpoint reached directly or through
 * the relay, `post_message` on Solana (the baseline), `postMessage` on Ethereum (the costly
 * fallback), and the rule that picks between them.
 *
 * Nothing safety-critical depends on a transport: lock, approval, notice, ready, claim, refund,
 * abort and evidence are always transactions on the swap's own chain. A transport carries
 * ciphertext and self-verifying blobs only; whatever comes back is verified by the caller.
 */
import { ENVELOPE_MAX_ONCHAIN, ENVELOPE_MAX_TOR } from '@xmrswap/core-wasm';
import { type ErrorCode, ERROR_CODES, MAKER_PATH_PATTERN, MAKER_ROUTES, type MakerInfo, RELAY_LIMITS, RELAY_ROUTES, type RelayForwardRequest, type RelayForwardResponse, type RelayStatus, type RepliesResponse } from '@xmrswap/protocol';
import { type Bytes, SdkError, fromBase64, toBase64 } from '../util.js';

export type HttpFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: Bytes | string; signal?: AbortSignal }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const defaultFetch: HttpFetch = (url, init) => fetch(url, init as RequestInit);

/** The transport could not be reached at all (relay down, Tor down, RPC down): the caller falls back to the next one. */
export class TransportUnavailable extends SdkError {
  constructor(detail: string) {
    super('unavailable', detail);
    this.name = 'TransportUnavailable';
  }
}
/** The maker's endpoint answered with a 4xx and a `{ code }` body. Falling back to another transport will not help. */
export class MakerRefused extends SdkError {
  readonly status: number;
  constructor(code: ErrorCode, status: number) {
    super(code, `the maker endpoint answered ${status}`);
    this.name = 'MakerRefused';
    this.status = status;
  }
}

type Method = 'GET' | 'POST' | 'PUT';

/** One HTTP exchange with a maker's `/xs/v1` routes, however it is carried. */
export interface MakerEndpoint {
  request(method: Method, path: string, body?: Bytes): Promise<{ status: number; body: Bytes }>;
}

function checkRequest(method: Method, path: string, body?: Bytes): void {
  if (!MAKER_PATH_PATTERN.test(path)) throw new SdkError('bad_request', `not a maker route: ${path}`);
  if (path === MAKER_ROUTES.msg && (body?.length ?? 0) > RELAY_LIMITS.msgBody) throw new SdkError('too_large', `a message body is at most ${RELAY_LIMITS.msgBody} bytes`);
  if (path.startsWith('/xs/v1/dleq/') && method === 'PUT' && (body?.length ?? 0) > RELAY_LIMITS.dleqBody) throw new SdkError('too_large', `a proof is at most ${RELAY_LIMITS.dleqBody} bytes`);
}
function checkResponse(body: Bytes): Bytes {
  if (body.length > RELAY_LIMITS.upstreamResponse) throw new SdkError('too_large', `the maker endpoint answered with ${body.length} bytes; at most ${RELAY_LIMITS.upstreamResponse} are accepted`);
  return body;
}

/**
 * The maker endpoint reached directly: an onion service from Tor Browser, or the HTTPS blob
 * endpoint of contact kind 5 (which serves the `dleq`, `pool` and `info` routes).
 */
export function directEndpoint(baseUrl: string, fetchFn: HttpFetch = defaultFetch, timeoutMs: number = RELAY_LIMITS.upstreamTimeoutMs): MakerEndpoint {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async request(method, path, body) {
      checkRequest(method, path, body);
      let res;
      try {
        res = await fetchFn(`${base}${path}`, { method, ...(body ? { body, headers: { 'content-type': 'application/octet-stream' } } : {}), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new TransportUnavailable(`${base}: ${(e as Error).message}`);
      }
      return { status: res.status, body: checkResponse(new Uint8Array(await res.arrayBuffer())) };
    },
  };
}

/**
 * The maker endpoint reached through a relay's `POST /relay/v1/forward` (SPEC 6.5). The relay
 * sees which maker is contacted, sizes and timing; it cannot read, alter or forge anything the
 * caller will accept.
 */
export function relayEndpoint(relayUrl: string, onion: string, fetchFn: HttpFetch = defaultFetch, timeoutMs: number = RELAY_LIMITS.upstreamTimeoutMs + 5_000): MakerEndpoint {
  const relay = relayUrl.replace(/\/$/, '');
  return {
    async request(method, path, body) {
      checkRequest(method, path, body);
      const req: RelayForwardRequest = { onion, method, path, ...(body ? { body_b64: toBase64(body) } : {}) };
      let res;
      try {
        res = await fetchFn(`${relay}${RELAY_ROUTES.forward}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new TransportUnavailable(`relay ${relay}: ${(e as Error).message}`);
      }
      const raw = new Uint8Array(await res.arrayBuffer());
      // Any relay-level failure (rate limit, unlisted onion, Tor down) is "this route is unavailable".
      if (res.status !== 200) throw new TransportUnavailable(`relay ${relay} answered ${res.status}`);
      let fwd: RelayForwardResponse;
      try {
        fwd = JSON.parse(new TextDecoder().decode(raw)) as RelayForwardResponse;
        if (typeof fwd.status !== 'number' || typeof fwd.body_b64 !== 'string') throw new Error('shape');
      } catch {
        throw new TransportUnavailable(`relay ${relay} returned a malformed forward response`);
      }
      return { status: fwd.status, body: checkResponse(fromBase64(fwd.body_b64)) };
    },
  };
}

/** `GET /relay/v1/status`: what the status page shows about the relay. */
export async function relayStatus(relayUrl: string, fetchFn: HttpFetch = defaultFetch): Promise<RelayStatus> {
  let res;
  try {
    res = await fetchFn(`${relayUrl.replace(/\/$/, '')}${RELAY_ROUTES.status}`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new TransportUnavailable(`relay: ${(e as Error).message}`);
  }
  if (res.status !== 200) throw new TransportUnavailable(`relay answered ${res.status}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))) as RelayStatus;
}

const text = (b: Bytes): string => new TextDecoder().decode(b);
function refusal(status: number, body: Bytes): never {
  let code: ErrorCode = 'unavailable';
  try {
    const c = (JSON.parse(text(body)) as { code?: string }).code;
    if (ERROR_CODES.includes(c as ErrorCode)) code = c as ErrorCode;
  } catch {
    // no body: keep `unavailable`
  }
  if (status >= 500) throw new TransportUnavailable(`the maker endpoint answered ${status}`);
  throw new MakerRefused(code, status);
}

/** The routes of SPEC 6.3 over a `MakerEndpoint`. Returns raw bytes: envelopes and blobs are verified by the caller. */
export class MakerHttp {
  constructor(readonly endpoint: MakerEndpoint) {}

  async info(): Promise<MakerInfo> {
    const r = await this.endpoint.request('GET', MAKER_ROUTES.info);
    if (r.status !== 200) refusal(r.status, r.body);
    return JSON.parse(text(r.body)) as MakerInfo;
  }
  /** `POST /xs/v1/msg`: an envelope in, a signed reply envelope out. */
  async msg(envelope: Bytes): Promise<Bytes> {
    if (envelope.length > ENVELOPE_MAX_TOR) throw new SdkError('too_large', `${envelope.length} bytes is over the ${ENVELOPE_MAX_TOR}-byte cap`);
    const r = await this.endpoint.request('POST', MAKER_ROUTES.msg, envelope);
    if (r.status !== 200) refusal(r.status, r.body);
    return r.body;
  }
  /** `GET /xs/v1/dleq/<S>`: the blob, or `null` on 404. */
  async getDleq(spendPubHex: string): Promise<Bytes | null> {
    const r = await this.endpoint.request('GET', MAKER_ROUTES.dleq(spendPubHex));
    if (r.status === 404) return null;
    if (r.status !== 200) refusal(r.status, r.body);
    return r.body;
  }
  /** `PUT /xs/v1/dleq/<S>`: 204 if the blob verifies and its `S` equals the path. */
  async putDleq(spendPubHex: string, blob: Bytes): Promise<void> {
    const r = await this.endpoint.request('PUT', MAKER_ROUTES.dleq(spendPubHex), blob);
    if (r.status !== 204 && r.status !== 200) refusal(r.status, r.body);
  }
  /** `GET /xs/v1/pool/<keyRoot>`: the raw JSON body, or `null` on 404. */
  async getPool(keyRootHex: string): Promise<Bytes | null> {
    const r = await this.endpoint.request('GET', MAKER_ROUTES.pool(keyRootHex));
    if (r.status === 404) return null;
    if (r.status !== 200) refusal(r.status, r.body);
    return r.body;
  }
  /** `GET /xs/v1/replies/<taker_pub>`: reply envelopes addressed to that key, newest first. Ciphertext only. */
  async replies(takerPubHex: string): Promise<Bytes[]> {
    const r = await this.endpoint.request('GET', MAKER_ROUTES.replies(takerPubHex));
    if (r.status !== 200) refusal(r.status, r.body);
    const parsed = JSON.parse(text(r.body)) as RepliesResponse;
    if (!Array.isArray(parsed.envelopes)) throw new SdkError('bad_request', 'malformed replies response');
    return parsed.envelopes.map(fromBase64);
  }
}

// ------------------------------------------------------------------ message transports

export interface SendResult {
  /** Which transport carried it. */
  via: 'tor' | 'solana' | 'ethereum';
  /** The maker's immediate signed reply envelope (Tor), or `null` when the reply arrives later (on-chain). */
  reply: Bytes | null;
  /** The transaction that carried the message (on-chain transports). */
  txId?: string;
}

/** Carries one envelope to a maker. Throws `TransportUnavailable` when it cannot be reached. */
export interface MessageTransport {
  readonly kind: 'tor' | 'solana' | 'ethereum';
  /** Largest envelope it carries. */
  readonly maxEnvelope: number;
  send(envelope: Bytes): Promise<SendResult>;
}

/** Tor: HTTP to the maker's onion service, through the relay or directly. Cap 16,384 bytes. */
export function torTransport(http: MakerHttp): MessageTransport {
  return { kind: 'tor', maxEnvelope: ENVELOPE_MAX_TOR, send: async (envelope) => ({ via: 'tor', reply: await http.msg(envelope) }) };
}

/**
 * Solana (the baseline): `post_message` with the envelope as instruction data. `post` builds,
 * signs and sends the instruction (the caller owns the wallet); the reply, if any, is read
 * later from the recipient's address. Cap 900 bytes.
 */
export function solanaTransport(post: (envelope: Bytes) => Promise<string>): MessageTransport {
  return onChain('solana', post);
}
/** Ethereum events: `postMessage` on the contract. Fallback only, when the Solana RPC is unreachable. Cap 900 bytes. */
export function ethereumTransport(post: (envelope: Bytes) => Promise<string>): MessageTransport {
  return onChain('ethereum', post);
}
function onChain(kind: 'solana' | 'ethereum', post: (envelope: Bytes) => Promise<string>): MessageTransport {
  return {
    kind,
    maxEnvelope: ENVELOPE_MAX_ONCHAIN,
    async send(envelope) {
      if (envelope.length > ENVELOPE_MAX_ONCHAIN) throw new SdkError('too_large', `${envelope.length} bytes is over the ${ENVELOPE_MAX_ONCHAIN}-byte on-chain cap`);
      let txId: string;
      try {
        txId = await post(envelope);
      } catch (e) {
        if (e instanceof SdkError && e.code !== 'unavailable') throw e;
        throw new TransportUnavailable(`${kind}: ${(e as Error).message}`);
      }
      return { via: kind, reply: null, txId };
    },
  };
}

/**
 * Send over the first transport that is reachable, in the order given (Tor when the maker
 * lists an onion address, then Solana, then Ethereum). Only "unreachable" falls through: a
 * maker's refusal (`stale_key`, `rate_limited`, …) and an oversize envelope are final for that
 * envelope, because another transport would carry the same bytes to the same daemon.
 * `seal(transport)` builds the envelope for the transport's cap, so one message can be tried
 * with the Tor cap first and the on-chain cap afterwards.
 */
export async function sendWithFallback(transports: MessageTransport[], seal: (t: MessageTransport) => Bytes): Promise<SendResult> {
  const failures: string[] = [];
  for (const t of transports) {
    let envelope: Bytes;
    try {
      envelope = seal(t);
    } catch (e) {
      // Too large for this transport's cap: a later one cannot be larger than Tor's, so say so.
      failures.push(`${t.kind}: ${(e as Error).message}`);
      continue;
    }
    try {
      return await t.send(envelope);
    } catch (e) {
      if (!(e instanceof TransportUnavailable)) throw e;
      failures.push(`${t.kind}: ${e.message}`);
    }
  }
  throw new TransportUnavailable(`no transport delivered the message (${failures.join('; ') || 'none configured'})`);
}

/** Whether an Ethereum swap can run at all: it needs a blob route (relay to an onion, or an HTTPS blob endpoint). On-chain messaging alone is not enough (SPEC 6.4). */
export function blobRouteAvailable(maker: { onion: string; contacts: { kind: number; value: string }[] }, relayUrl: string | null): 'relay' | 'https' | null {
  if (maker.onion && relayUrl) return 'relay';
  if (maker.contacts.some((c) => c.kind === 5 && /^https:\/\//.test(c.value))) return 'https';
  return null;
}
