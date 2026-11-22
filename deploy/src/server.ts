/**
 * The bundle's one origin (SPEC 8.8): a static file server for the built web UI that also passes
 * `/relay/` and `/monero/` on to the relay, so the page and the relay share an origin and the
 * relay needs no CORS headers.
 *
 * The server holds no key and keeps no request log. It serves files from one directory, the
 * generated `config.json`, and nothing else.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type RelayDeps, type RunningRelay, isLoopback, startRelay } from '@xmrswap/relay';
import type { BundleSettings } from './settings.js';

export class BundleError extends Error {}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Headers every response carries. The page sets its own Content-Security-Policy in a meta tag. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** The defaults the page reads from `config.json` (keys of the page's `Settings`). */
export function pageConfig(s: BundleSettings, origin: string): Record<string, unknown> {
  return {
    mode: 'self-hosted',
    relayUrl: '/',
    ...(s.ui.givePageRpcUrls && s.relay.solanaRpcUrl ? { solanaRpc: s.relay.solanaRpcUrl } : {}),
    ...(s.ui.givePageRpcUrls && s.ui.ethereumRpcUrl ? { ethereumRpc: s.ui.ethereumRpcUrl } : {}),
    ethereumChainId: s.ui.ethereumChainId,
    // Absolute addresses: the page accepts only http(s) URLs for Monero nodes.
    moneroNodes: s.relay.moneroNodes.map((_, i) => `${origin}/monero/${i}`),
    ownNode: s.ui.ownNode,
    moneroNetwork: s.ui.moneroNetwork,
    programId: s.relay.programId,
    contract: s.ui.contractAddress,
    pollMs: s.ui.pollMs,
  };
}

export interface BundleDeps {
  /** Passed to the relay (tests inject a registry and a log sink). */
  relay?: RelayDeps;
}

export interface RunningBundle {
  /** `http://host:port` of the UI server, as a client on this machine reaches it. */
  url: string;
  host: string;
  port: number;
  relay: RunningRelay;
  server: Server;
  close(): Promise<void>;
}

const hostForUrl = (host: string): string => (host.includes(':') ? `[${host}]` : host);
/** The address a local client uses for a listen address (a wildcard is reached through loopback). */
export const connectHost = (host: string): string => (host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host);

function send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const fail = (res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void => send(res, status, JSON.stringify({ error }), undefined, extra);

// Hop-by-hop headers are not passed in either direction.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

/** Start the relay, then the UI server in front of it. Throws `BundleError` when the built UI is missing. */
export async function startBundle(s: BundleSettings, deps: BundleDeps = {}): Promise<RunningBundle> {
  const root = s.ui.dist;
  if (!existsSync(path.join(root, 'index.html')))
    throw new BundleError(`no built web UI in ${root} (index.html is missing). Build it with "pnpm --filter @xmrswap/web build", or set [ui] dist to an unpacked release.`);

  const relay = await startRelay(s.relay, deps.relay);
  const relayHost = connectHost(relay.host);

  // Requests are answered only for the names this server is known by. A page on another site
  // that points its own host name at 127.0.0.1 (DNS rebinding) is refused here.
  const allowedHosts = new Set<string>();
  const publicHost = s.ui.publicOrigin ? new URL(s.ui.publicOrigin).host : null;
  if (publicHost) allowedHosts.add(publicHost);
  const addListenNames = (port: number): void => {
    const names = isLoopback(s.ui.listenHost) || s.ui.listenHost === '0.0.0.0' || s.ui.listenHost === '::' ? ['127.0.0.1', 'localhost', '[::1]'] : [];
    names.push(hostForUrl(s.ui.listenHost));
    for (const n of names) {
      allowedHosts.add(`${n}:${port}`);
      if (port === 80) allowedHosts.add(n);
    }
  };

  const proxy = (req: IncomingMessage, res: ServerResponse): void => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k) && k !== 'x-forwarded-for') headers[k] = v;
    // The relay counts requests per client address: hand it the caller's, after whatever a
    // reverse proxy in front of this server already recorded.
    const peer = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const prior = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = prior ? `${Array.isArray(prior) ? prior.join(', ') : prior}, ${peer}` : peer;
    headers['host'] = `${hostForUrl(relayHost)}:${relay.port}`;
    const up = http.request({ host: relayHost, port: relay.port, method: req.method, path: req.url, headers, agent: false }, (r) => {
      const out: Record<string, string | string[]> = { ...SECURITY_HEADERS };
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    up.setTimeout(90_000, () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (res.headersSent) res.destroy();
      else fail(res, 502, 'relay_unreachable');
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  };

  const serveFile = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return fail(res, 400, 'bad_request');
    }
    if (rel.includes('\0') || rel.includes('\\')) return fail(res, 400, 'bad_request');
    if (rel.endsWith('/')) rel += 'index.html';
    // No dot files, and nothing outside the UI directory.
    if (rel.split('/').some((part) => part.startsWith('.'))) return fail(res, 404, 'not_found');
    const file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return fail(res, 404, 'not_found');
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) return fail(res, 404, 'not_found');
      size = st.size;
    } catch {
      return fail(res, 404, 'not_found');
    }
    const ext = path.extname(file).toLowerCase();
    // File names under assets/ carry a content hash; everything else is re-read on each visit.
    const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host.toLowerCase())) return fail(res, 421, 'bad_host');
    const url = req.url ?? '/';
    const pathname = url.split('?')[0]!;
    if (pathname.startsWith('/relay/') || pathname === '/monero' || pathname.startsWith('/monero/')) return proxy(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_method', { Allow: 'GET, HEAD' });
    if (pathname === '/config.json') {
      // Behind a TLS reverse proxy the public origin is configured; otherwise it is the name the browser used.
      const origin = s.ui.publicOrigin || `http://${host}`;
      const body = JSON.stringify(pageConfig(s, origin), null, 2);
      return req.method === 'HEAD' ? void res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json']!, 'Cache-Control': 'no-store' }).end() : send(res, 200, body);
    }
    serveFile(req, res, pathname);
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(s.ui.listenPort, s.ui.listenHost, () => resolve());
    });
  } catch (e) {
    await relay.close();
    throw e;
  }
  const addr = server.address() as AddressInfo;
  addListenNames(addr.port);

  return {
    url: `http://${hostForUrl(connectHost(addr.address))}:${addr.port}`,
    host: addr.address,
    port: addr.port,
    relay,
    server,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await relay.close();
    },
  };
}
