/**
 * Off-chain messages (SPEC 6.1), the maker endpoint (6.3) and the relay (6.5).
 *
 * The plaintext inside an envelope is a UTF-8 JSON object with a `t` field. Hex strings are
 * lowercase without `0x` (EVM addresses and bytes32 keep `0x`); amounts and other 64-bit
 * integers are decimal strings; signatures and binary blobs are base64.
 */
import type { ChainName, Market } from './constants.js';
import { INBOX_TEXT_MAX_CHARS } from './constants.js';

export type DirectionLetter = 'A' | 'B';

export interface QuoteRequest {
  t: 'quote_request';
  chain: ChainName;
  market: Market;
  direction: DirectionLetter;
  /** Piconero, decimal. */
  xmr: string;
  /** The taker's address on `chain`. */
  taker: string;
  /** The taker's Solana address, for replies that are not the immediate response. */
  reply_to?: string;
  note?: string;
}

/** Solana: the maker has already posted the `Quote` account; the client reads and checks it. */
export interface QuoteResponseSolana {
  t: 'quote_response';
  ok: true;
  chain: 'solana';
  /** u64, decimal. */
  quote_id: string;
  /** Chain time, decimal. */
  expires_at: string;
}
/**
 * Ethereum: the taker-bound EIP-712 quote with its signature, in the compact form of SPEC 2.10
 * (`encodeEthQuoteCompact(quote, sig)`, 316 bytes, base64). The compact form carries every
 * `Quote` field including `taker` and `keyRoot`; it is used here because the same fields as
 * JSON do not fit the 900-byte on-chain cap.
 */
export interface QuoteResponseEthereum {
  t: 'quote_response';
  ok: true;
  chain: 'ethereum';
  quote: string;
}
export interface Refusal {
  ok: false;
  /** Why not, for the user. */
  detail?: string;
}
export type QuoteResponse = QuoteResponseSolana | QuoteResponseEthereum | ({ t: 'quote_response' } & Refusal);

export interface ApprovalRequest {
  t: 'approval_request';
  chain: ChainName;
  taker: string;
  market?: Market;
  direction?: DirectionLetter;
  /** Piconero, decimal. */
  max_xmr?: string;
  reply_to?: string;
  note?: string;
}

/** Solana: the variable fields only; the client fills in `cluster_tag`, `program_id`, `maker`, `taker`. */
export interface ApprovalResponseSolana {
  t: 'approval_response';
  ok: true;
  chain: 'solana';
  /** `0`, `1`, or `255` = any. */
  asset: number;
  /** `0` = A, `1` = B, `255` = any. */
  direction: number;
  max_xmr: string;
  not_before: string;
  expires_at: string;
  epoch: number;
  /** u64, decimal. */
  approval_id: string;
  /** Ed25519 signature by the operator over the 190 bytes of SPEC 2.9, base64. */
  sig: string;
}
/** Ethereum: the EIP-712 `Approval` fields and the 65-byte signature. */
export interface ApprovalResponseEthereum {
  t: 'approval_response';
  ok: true;
  chain: 'ethereum';
  maker: string;
  taker: string;
  token: string;
  direction: number;
  max_xmr: string;
  not_before: string;
  valid_until: string;
  epoch: number;
  /** bytes32 with `0x`. */
  approval_id: string;
  /** base64 of `r ‖ s ‖ v`. */
  sig: string;
}
export type ApprovalResponse = ApprovalResponseSolana | ApprovalResponseEthereum | ({ t: 'approval_response' } & Refusal);

export interface InboxMessage {
  t: 'inbox';
  /** At most 2,000 characters. */
  text: string;
  action?: 'release_deposit';
  reply_to?: string;
}
export interface InboxReply {
  t: 'inbox_reply';
  text: string;
  /** SHA-256 of the request envelope, lowercase hex. */
  in_reply_to: string;
}
/** A faster duplicate of an on-chain notice; never a substitute. */
export interface NoticeCopy {
  t: 'notice_copy';
  /** 32 bytes, lowercase hex. */
  commitment: string;
  /** 104 bytes, lowercase hex. */
  ciphertext: string;
}
export interface Ack {
  t: 'ack';
  in_reply_to: string;
}
export const ERROR_CODES = ['stale_key', 'rate_limited', 'not_allowed', 'too_large', 'bad_request', 'unavailable'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface ErrorMessage {
  t: 'error';
  code: ErrorCode;
  detail?: string;
}

export type Message =
  | QuoteRequest
  | QuoteResponse
  | ApprovalRequest
  | ApprovalResponse
  | InboxMessage
  | InboxReply
  | NoticeCopy
  | Ack
  | ErrorMessage;
export type MessageType = Message['t'];
export const MESSAGE_TYPES: readonly MessageType[] = [
  'quote_request',
  'quote_response',
  'approval_request',
  'approval_response',
  'inbox',
  'inbox_reply',
  'notice_copy',
  'ack',
  'error',
];
/** Types a maker sends (flag bit 0 set, operator-signed). */
export const MAKER_MESSAGE_TYPES: readonly MessageType[] = ['quote_response', 'approval_response', 'inbox_reply', 'ack', 'error'];

/** The envelope plaintext of a message. JSON is never hashed, so key order does not matter. */
export function encodeMessage(message: Message): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageError';
  }
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX = /^[0-9a-f]*$/;

/**
 * Parse an envelope plaintext. Checks that it is a JSON object with a known `t` and that the
 * required fields of that type are present with the right primitive types; unknown extra
 * fields are kept. Throws `MessageError` otherwise.
 */
export function parseMessage(plaintext: Uint8Array | string): Message {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof plaintext === 'string' ? plaintext : new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new MessageError('not UTF-8 JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new MessageError('not a JSON object');
  const m = obj as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof m[k] !== 'string') throw new MessageError(`${String(m.t)}.${k} must be a string`);
    return m[k] as string;
  };
  const optStr = (k: string) => {
    if (m[k] !== undefined) str(k);
  };
  const dec = (k: string) => {
    if (!DECIMAL.test(str(k))) throw new MessageError(`${String(m.t)}.${k} must be a decimal string`);
  };
  const optDec = (k: string) => {
    if (m[k] !== undefined) dec(k);
  };
  const hex = (k: string, bytes?: number) => {
    const v = str(k);
    if (!HEX.test(v) || (bytes !== undefined && v.length !== 2 * bytes)) throw new MessageError(`${String(m.t)}.${k} must be ${bytes ?? 'even-length'} bytes of lowercase hex`);
  };
  const int = (k: string) => {
    if (!Number.isInteger(m[k]) || (m[k] as number) < 0) throw new MessageError(`${String(m.t)}.${k} must be a non-negative integer`);
  };
  const oneOf = (k: string, allowed: readonly string[]) => {
    if (!allowed.includes(str(k))) throw new MessageError(`${String(m.t)}.${k} must be one of ${allowed.join(', ')}`);
  };
  const chain = () => oneOf('chain', ['solana', 'ethereum']);
  const ok = (): boolean => {
    if (typeof m.ok !== 'boolean') throw new MessageError(`${String(m.t)}.ok must be a boolean`);
    return m.ok;
  };
  switch (m.t) {
    case 'quote_request':
      chain();
      oneOf('market', ['sol', 'usdc_sol', 'eth', 'usdc_eth']);
      oneOf('direction', ['A', 'B']);
      dec('xmr');
      str('taker');
      optStr('reply_to');
      optStr('note');
      break;
    case 'quote_response':
      if (ok()) {
        chain();
        if (m.chain === 'solana') {
          dec('quote_id');
          dec('expires_at');
        } else str('quote');
      } else optStr('detail');
      break;
    case 'approval_request':
      chain();
      str('taker');
      if (m.market !== undefined) oneOf('market', ['sol', 'usdc_sol', 'eth', 'usdc_eth']);
      if (m.direction !== undefined) oneOf('direction', ['A', 'B']);
      optDec('max_xmr');
      optStr('reply_to');
      optStr('note');
      break;
    case 'approval_response':
      if (ok()) {
        chain();
        int('direction');
        dec('max_xmr');
        dec('not_before');
        int('epoch');
        str('sig');
        if (m.chain === 'solana') {
          int('asset');
          dec('expires_at');
          dec('approval_id');
        } else {
          str('maker');
          str('taker');
          str('token');
          dec('valid_until');
          str('approval_id');
        }
      } else optStr('detail');
      break;
    case 'inbox':
      if ([...str('text')].length > INBOX_TEXT_MAX_CHARS) throw new MessageError(`inbox.text is longer than ${INBOX_TEXT_MAX_CHARS} characters`);
      if (m.action !== undefined) oneOf('action', ['release_deposit']);
      optStr('reply_to');
      break;
    case 'inbox_reply':
      str('text');
      hex('in_reply_to', 32);
      break;
    case 'notice_copy':
      hex('commitment', 32);
      hex('ciphertext', 104);
      break;
    case 'ack':
      hex('in_reply_to', 32);
      break;
    case 'error':
      oneOf('code', ERROR_CODES);
      optStr('detail');
      break;
    default:
      throw new MessageError(`unknown message type ${JSON.stringify(m.t)}`);
  }
  return m as unknown as Message;
}

// ------------------------------------------------------------------ maker endpoint (SPEC 6.3)

/** Routes the daemon serves on its onion service (and, for the blob routes, on an HTTPS contact of kind 5). */
export const MAKER_ROUTES = {
  info: '/xs/v1/info',
  msg: '/xs/v1/msg',
  dleq: (spendPubHex: string) => `/xs/v1/dleq/${spendPubHex}`,
  pool: (keyRootHex: string) => `/xs/v1/pool/${keyRootHex}`,
  replies: (takerPubHex: string) => `/xs/v1/replies/${takerPubHex}`,
} as const;

/** The only paths the relay forwards (SPEC 6.5). */
export const MAKER_PATH_PATTERN = /^\/xs\/v1\/(info|msg|dleq\/[0-9a-f]{64}|pool\/[0-9a-f]{64}|replies\/[0-9a-f]{64})$/;
/** Methods each route defines. */
export const MAKER_ROUTE_METHODS: Readonly<Record<'info' | 'msg' | 'dleq' | 'pool' | 'replies', readonly ('GET' | 'POST' | 'PUT')[]>> = {
  info: ['GET'],
  msg: ['POST'],
  dleq: ['GET', 'PUT'],
  pool: ['GET'],
  replies: ['GET'],
};

/** `GET /xs/v1/info` */
export interface MakerInfo {
  /** Maker PDA, base58. */
  maker: string;
  /** Operator key, base58. */
  operator: string;
  enc_key_version: number;
  /** Solana chain time as the daemon last read it. */
  chain_time: number;
}
/** `GET /xs/v1/pool/<keyRoot>`: at most 256 leaves. The client recomputes the root. */
export interface PoolResponse {
  leaves: { index: number; key: string; key2: string; spend_pub: string }[];
}
/** `GET /xs/v1/replies/<taker_pub>`: reply envelopes, newest first, base64. Ciphertext only. */
export interface RepliesResponse {
  envelopes: string[];
}
/** A 4xx body of the maker endpoint. */
export interface MakerEndpointError {
  code: ErrorCode;
}

// ------------------------------------------------------------------ relay (SPEC 6.5)

export const RELAY_ROUTES = {
  status: '/relay/v1/status',
  forward: '/relay/v1/forward',
  monero: (node: number, path: string) => `/monero/${node}/${path.replace(/^\//, '')}`,
} as const;

/** `GET /relay/v1/status` */
export interface RelayStatus {
  tor_ok: boolean;
  registry_age_secs: number;
  makers: number;
  monero_nodes: { ok: boolean; height: number }[];
}
/** `POST /relay/v1/forward` */
export interface RelayForwardRequest {
  /** Must be the `onion` field of a maker account currently in the registry. */
  onion: string;
  method: 'GET' | 'POST' | 'PUT';
  /** Must match `MAKER_PATH_PATTERN`. */
  path: string;
  body_b64?: string;
}
export interface RelayForwardResponse {
  status: number;
  body_b64: string;
}
/**
 * Error codes of the relay itself, with the HTTP status each is sent with. A relay error means
 * the relay refused or could not reach the maker; a maker's own refusal arrives inside a
 * successful forward (`RelayForwardResponse.status` 4xx with a `MakerEndpointError` body).
 */
export const RELAY_ERROR_STATUS = {
  /** Malformed request body or parameters. */
  bad_request: 400,
  /** `onion` is not 56 base32 characters + `.onion`. */
  bad_onion: 400,
  /** `path` does not match `MAKER_PATH_PATTERN`. */
  bad_path: 400,
  /** `onion` is not the address of a maker currently in the registry. */
  onion_not_listed: 403,
  monero_path_not_allowed: 403,
  monero_method_not_allowed: 403,
  not_found: 404,
  /** No Monero node is configured at that index. */
  no_such_node: 404,
  /** `method` is not one the route defines. */
  bad_method: 405,
  too_large: 413,
  /** Per-IP limit reached; the response carries `Retry-After` (seconds). */
  rate_limited: 429,
  internal: 500,
  upstream_unreachable: 502,
  upstream_too_large: 502,
  /** The upstream answered with a redirect; the relay never follows or relays one. */
  upstream_redirect: 502,
  upstream_timeout: 504,
} as const;
export type RelayErrorCode = keyof typeof RELAY_ERROR_STATUS;
export const RELAY_ERROR_CODES = Object.keys(RELAY_ERROR_STATUS) as RelayErrorCode[];
/** Body of every non-2xx response of the relay. */
export interface RelayError {
  error: RelayErrorCode;
}
/** True for a parsed relay error body (use it to tell "the relay refused" from a maker's reply). */
export function isRelayError(body: unknown): body is RelayError {
  return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' && (body as { error: string }).error in RELAY_ERROR_STATUS;
}

/** Caps the relay enforces on decoded bodies. */
export const RELAY_LIMITS = {
  msgBody: 16_384,
  dleqBody: 60_000,
  upstreamResponse: 60_000,
  requestBody: 96 * 1024,
  upstreamTimeoutMs: 30_000,
  defaultRequestsPerMinute: 60,
  defaultBytesPerMinute: 4 * 1024 * 1024,
  registryRefreshSecs: 60,
} as const;
/** The Monero proxy forwards only these paths, and only these `/json_rpc` methods. */
export const MONERO_PROXY_PATHS = [
  '/json_rpc',
  '/get_height',
  '/get_transactions',
  '/get_transaction_pool_hashes',
  '/get_o_indexes.bin',
  '/get_output_distribution.bin',
  '/get_outs.bin',
  '/send_raw_transaction',
] as const;
export const MONERO_PROXY_JSON_RPC_METHODS = ['get_info', 'get_block', 'get_block_count', 'get_fee_estimate'] as const;
