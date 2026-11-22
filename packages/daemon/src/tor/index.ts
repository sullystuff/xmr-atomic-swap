/**
 * The maker endpoint of SPEC 6.3, served on a loopback port; the maker's own Tor maps an onion
 * service's port 80 to it (`daemon tor print-torrc` prints the two lines). The daemon does not
 * manage the Tor process. The same routes serve a contact of kind 5 (an HTTPS blob endpoint).
 *
 * `makerEndpoint` is transport-agnostic (method, path, body → status, body), so the SDK's
 * `MakerHttp` client and its in-memory fakes drive it directly in tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { dleqVerify } from '@xmrswap/core-wasm';
import { DLEQ_MAX_BLOB, DLEQ_RETENTION_MINUTES, ENVELOPE_MAX_TOR, type ErrorCode, MAKER_PATH_PATTERN, type MakerInfo, type PoolResponse, type RepliesResponse } from '@xmrswap/protocol';
import express from 'express';
import { type Inbox, InboxRefusal } from '../inbox/index.js';
import type { Store } from '../store/db.js';
import { type Bytes, hex } from '../util.js';

export interface EndpointDeps {
  store: Store;
  inbox: Pick<Inbox, 'handle' | 'replies'>;
  info: () => Promise<MakerInfo>;
  poolLeaves: (rootHex: string) => PoolResponse['leaves'] | null;
  /** Whether a spend commitment is one of this maker's own shares (a taker may not overwrite or replay it). */
  isOwnShare: (spendPubHex: string) => boolean;
  /** Requests per minute across the endpoint (all circuits arrive from the local Tor). */
  requestsPerMinute?: number;
}
export interface EndpointResponse {
  status: number;
  body?: Bytes | string;
  contentType?: string;
}

const STATUS: Record<ErrorCode, number> = { stale_key: 409, rate_limited: 429, not_allowed: 403, too_large: 413, bad_request: 400, unavailable: 503 };
const refuse = (code: ErrorCode): EndpointResponse => ({ status: STATUS[code], body: JSON.stringify({ code }), contentType: 'application/json' });
const json = (v: unknown): EndpointResponse => ({ status: 200, body: JSON.stringify(v), contentType: 'application/json' });

export function makerEndpoint(d: EndpointDeps): (method: 'GET' | 'POST' | 'PUT', path: string, body?: Bytes) => Promise<EndpointResponse> {
  let window = 0;
  let count = 0;
  return async (method, p, body) => {
    const minute = Math.floor(d.store.now() / 60);
    if (minute !== window) {
      window = minute;
      count = 0;
    }
    if (++count > (d.requestsPerMinute ?? 600)) return refuse('rate_limited');
    if (!MAKER_PATH_PATTERN.test(p)) return { status: 404, body: JSON.stringify({ code: 'bad_request' }), contentType: 'application/json' };
    const [, , , route, arg] = p.split('/');
    try {
      if (route === 'info' && method === 'GET') return json(await d.info());
      if (route === 'msg' && method === 'POST') {
        if (!body || body.length === 0) return refuse('bad_request');
        if (body.length > ENVELOPE_MAX_TOR) return refuse('too_large');
        return { status: 200, body: await d.inbox.handle(body, 'tor'), contentType: 'application/octet-stream' };
      }
      if (route === 'dleq' && method === 'GET') {
        d.store.pruneBlobs(DLEQ_RETENTION_MINUTES * 60);
        const blob = d.store.blob(arg!);
        return blob ? { status: 200, body: blob, contentType: 'application/octet-stream' } : { status: 404 };
      }
      if (route === 'dleq' && method === 'PUT') {
        if (!body || body.length === 0) return refuse('bad_request');
        if (body.length > DLEQ_MAX_BLOB) return refuse('too_large');
        // Kept only if the blob verifies and its S equals the path; never over one of our own proofs.
        let s: string;
        try {
          s = hex(dleqVerify(body).spendPub);
        } catch {
          return refuse('bad_request');
        }
        if (s !== arg || d.isOwnShare(s)) return refuse('bad_request');
        d.store.putBlob(s, body, false);
        return { status: 204 };
      }
      if (route === 'pool' && method === 'GET') {
        const leaves = d.poolLeaves(arg!);
        return leaves ? json({ leaves } satisfies PoolResponse) : { status: 404 };
      }
      if (route === 'replies' && method === 'GET') return json({ envelopes: d.inbox.replies(arg!).map((e) => Buffer.from(e).toString('base64')) } satisfies RepliesResponse);
      return { status: 405, body: JSON.stringify({ code: 'bad_request' }), contentType: 'application/json' };
    } catch (e) {
      if (e instanceof InboxRefusal) return refuse(e.code);
      return refuse('unavailable');
    }
  };
}

/** Serve the endpoint over plain HTTP on a loopback address. Responses carry `Access-Control-Allow-Origin: *` (SPEC 6.3). */
export function serveEndpoint(handler: ReturnType<typeof makerEndpoint>, listen: string): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const [host, port] = splitBind(listen);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    next();
  });
  app.options('*', (_req, res) => void res.status(204).end());
  // The caps of SPEC 6.3 are enforced per route by the handler; this is only the outer bound.
  app.use(express.raw({ type: () => true, limit: DLEQ_MAX_BLOB + 1 }));
  app.all('/xs/v1/*', async (req, res) => {
    const method = req.method as 'GET' | 'POST' | 'PUT';
    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? new Uint8Array(req.body) : undefined;
    const r = await handler(method, req.path, body);
    if (r.contentType) res.setHeader('content-type', r.contentType);
    res.status(r.status).end(r.body === undefined ? undefined : typeof r.body === 'string' ? r.body : Buffer.from(r.body));
  });
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status === 413 ? 413 : 400).json({ code: err.status === 413 ? 'too_large' : 'bad_request' });
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actual = (server.address() as { port: number }).port;
      resolve({ server, port: actual, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
    server.once('error', reject);
  });
}

export function splitBind(bind: string): [string, number] {
  const i = bind.lastIndexOf(':');
  const host = i < 0 ? '127.0.0.1' : bind.slice(0, i);
  const port = Number(i < 0 ? bind : bind.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`bad bind address ${bind}`);
  return [host || '127.0.0.1', port];
}

/** The onion hostname from the hidden-service directory's `hostname` file, or `null` when Tor has not written it yet. */
export function readOnionHostname(hostnameFile: string | undefined): string | null {
  if (!hostnameFile || !existsSync(hostnameFile)) return null;
  const host = readFileSync(hostnameFile, 'utf8').trim();
  return /^[a-z2-7]{56}\.onion$/.test(host) ? host : null;
}

/** The two lines to add to the maker's own torrc (`daemon tor print-torrc`). */
export function torrcLines(listen: string, hostnameFile?: string): string {
  const [host, port] = splitBind(listen);
  const dir = hostnameFile ? path.dirname(hostnameFile) : '/var/lib/tor/xmrswap-maker';
  return `HiddenServiceDir ${dir}\nHiddenServicePort 80 ${host}:${port}\n`;
}

/** The endpoint of a running daemon (what `start` serves and the integration test drives). */
export function daemonEndpoint(d: {
  store: Store;
  inbox: Pick<Inbox, 'handle' | 'replies'>;
  offers: { poolLeaves(rootHex: string): PoolResponse['leaves'] | null };
  sol: { makerPda: string; now(): Promise<bigint> } | null;
  keystore: { solana: { publicKey: string } };
  encKeys: { current(): { version: number } | null };
}): ReturnType<typeof makerEndpoint> {
  return makerEndpoint({
    store: d.store, inbox: d.inbox, poolLeaves: (root) => d.offers.poolLeaves(root), isOwnShare: (s) => d.store.shareByPub(s) !== undefined,
    info: async () => ({ maker: d.sol?.makerPda ?? '', operator: d.keystore.solana.publicKey, enc_key_version: d.encKeys.current()?.version ?? 0, chain_time: d.sol ? Number(await d.sol.now()) : 0 }),
  });
}
