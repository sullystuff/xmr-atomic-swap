/**
 * The relay's HTTP application (SPEC 6.5).
 *
 * It carries ciphertext and self-verifying blobs only. It holds no key, keeps no message log and
 * can only drop or delay what passes through it.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  MONERO_PROXY_JSON_RPC_METHODS,
  MONERO_PROXY_PATHS,
  RELAY_LIMITS,
  RELAY_ROUTES,
  type RelayForwardResponse,
  type RelayStatus,
} from '@xmrswap/protocol';
import { type RelayConfig, isLoopback } from './config.js';
import { DEBUG_WARNING, type LogSink, type Logger, createLogger } from './log.js';
import { decodeBase64, isOnionHost, makerRouteOf, methodAllowed } from './onion.js';
import { RateLimiter } from './ratelimit.js';
import { RegistryCache, type RegistryCacheOptions, type RegistrySource, SolanaRegistrySource, emptyRegistrySource } from './registry.js';
import { UpstreamError, probeSocks, upstreamFetch } from './upstream.js';

export interface RelayDeps {
  /** Where the list of maker onion addresses comes from. Default: the Solana registry named by the configuration. */
  registry?: RegistrySource;
  registryOptions?: RegistryCacheOptions;
  /** Where log lines go. Default: stdout. */
  logSink?: LogSink;
  now?: () => number;
  /** Deadline for one upstream exchange. Default 30 s (SPEC 6.5). */
  upstreamTimeoutMs?: number;
  /** How long a status probe result is reused. Default 5 s. */
  statusCacheMs?: number;
}

export interface Relay {
  app: express.Express;
  registry: RegistryCache;
  limiter: RateLimiter;
  logger: Logger;
}

type ErrorCode =
  | 'bad_request'
  | 'bad_onion'
  | 'bad_path'
  | 'bad_method'
  | 'onion_not_listed'
  | 'too_large'
  | 'rate_limited'
  | 'not_found'
  | 'monero_path_not_allowed'
  | 'monero_method_not_allowed'
  | 'no_such_node'
  | 'internal'
  | UpstreamError['code'];

function fail(res: Response, status: number, error: ErrorCode): void {
  res.status(status).json({ error });
}

function clientIp(req: Request, trustProxy: boolean): string {
  const raw = (trustProxy ? req.ip : req.socket.remoteAddress) ?? 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

const UPSTREAM_STATUS: Record<UpstreamError['code'], number> = {
  upstream_timeout: 504,
  upstream_unreachable: 502,
  upstream_too_large: 502,
  upstream_redirect: 502,
};

const MONERO_PATHS: readonly string[] = MONERO_PROXY_PATHS;
const MONERO_METHODS: readonly string[] = MONERO_PROXY_JSON_RPC_METHODS;

export function createRelay(config: RelayConfig, deps: RelayDeps = {}): Relay {
  const now = deps.now ?? Date.now;
  const logger = createLogger(config.debugLog, deps.logSink);
  const timeoutMs = deps.upstreamTimeoutMs ?? RELAY_LIMITS.upstreamTimeoutMs;
  const statusCacheMs = deps.statusCacheMs ?? 5_000;
  const torSocks = { host: config.torSocksHost, port: config.torSocksPort };

  const source =
    deps.registry ?? (config.solanaRpcUrl && config.programId ? new SolanaRegistrySource(config.solanaRpcUrl, config.programId) : emptyRegistrySource);
  const registry = new RegistryCache(source, {
    now,
    // The reason may embed the RPC URL (and its API key), so it is shown only in debug mode.
    onError: (err) => logger.info(`registry refresh failed${logger.debugEnabled ? `: ${String(err)}` : ''}`),
    ...deps.registryOptions,
  });
  const limiter = new RateLimiter({ requestsPerMinute: config.requestsPerMinute, bytesPerMinute: config.bytesPerMinute, now });

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  const trustProxy = config.trustProxyHops > 0;
  if (trustProxy) app.set('trust proxy', config.trustProxyHops);

  // ---------------------------------------------------------------- cross-origin access
  const anyOrigin = config.allowedOrigins.includes('*');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && (anyOrigin || config.allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', anyOrigin ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ---------------------------------------------------------------- per-IP limits
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req, trustProxy);
    if (!limiter.admit(ip)) {
      res.setHeader('Retry-After', String(limiter.retryAfterSecs(ip)));
      fail(res, 429, 'rate_limited');
      return;
    }
    next();
  });

  /** Charge a request body against the byte budget; false (and a 429) if it does not fit. */
  const chargeBody = (req: Request, res: Response, bytes: number): boolean => {
    const ip = clientIp(req, trustProxy);
    if (!limiter.hasBudget(ip, bytes)) {
      res.setHeader('Retry-After', String(limiter.retryAfterSecs(ip)));
      fail(res, 429, 'rate_limited');
      return false;
    }
    limiter.charge(ip, bytes);
    return true;
  };

  const rawBody = express.raw({ type: () => true, limit: RELAY_LIMITS.requestBody, inflate: false });
  const bodyOf = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

  // ---------------------------------------------------------------- status
  let torProbe: { at: number; value: Promise<boolean> } | null = null;
  let moneroProbe: { at: number; value: Promise<RelayStatus['monero_nodes']> } | null = null;
  const probeTimeout = Math.min(timeoutMs, 5_000);

  const moneroHeight = async (node: string): Promise<{ ok: boolean; height: number }> => {
    try {
      const url = new URL('/get_height', node);
      const up = await upstreamFetch({
        url,
        method: 'POST',
        body: Buffer.alloc(0),
        timeoutMs: probeTimeout,
        maxResponseBytes: 4096,
        ...(url.hostname.endsWith('.onion') ? { socks: torSocks } : {}),
      });
      const parsed = JSON.parse(up.body.toString('utf8')) as { height?: unknown };
      if (up.status === 200 && typeof parsed.height === 'number' && Number.isSafeInteger(parsed.height) && parsed.height >= 0)
        return { ok: true, height: parsed.height };
    } catch {
      /* reported as not ok */
    }
    return { ok: false, height: 0 };
  };

  app.get(RELAY_ROUTES.status, (_req: Request, res: Response, next: NextFunction) => {
    const t = now();
    if (!torProbe || t - torProbe.at >= statusCacheMs) torProbe = { at: t, value: probeSocks(torSocks.host, torSocks.port, probeTimeout) };
    if (!moneroProbe || t - moneroProbe.at >= statusCacheMs) moneroProbe = { at: t, value: Promise.all(config.moneroNodes.map(moneroHeight)) };
    Promise.all([torProbe.value, moneroProbe.value]).then(([tor_ok, monero_nodes]) => {
      const body: RelayStatus = { tor_ok, registry_age_secs: registry.ageSecs(), makers: registry.makers, monero_nodes };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    }, next);
  });

  // ---------------------------------------------------------------- forward
  app.post(RELAY_ROUTES.forward, rawBody, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const raw = bodyOf(req);
      if (!chargeBody(req, res, raw.length)) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(res, 400, 'bad_request');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail(res, 400, 'bad_request');
      const { onion, method, path, body_b64 } = parsed as Record<string, unknown>;

      // Destination: a bare v3 onion host, nothing else. No URL is ever parsed out of client input.
      if (!isOnionHost(onion)) return fail(res, 400, 'bad_onion');
      const route = makerRouteOf(path);
      if (route === null) return fail(res, 400, 'bad_path');
      if (!methodAllowed(route, method)) return fail(res, 405, 'bad_method');

      let body: Buffer | undefined;
      if (method === 'GET') {
        if (body_b64 !== undefined) return fail(res, 400, 'bad_request');
      } else {
        if (typeof body_b64 !== 'string') return fail(res, 400, 'bad_request');
        // Reject on the encoded length first so an oversize body is never decoded.
        const cap = route === 'msg' ? RELAY_LIMITS.msgBody : RELAY_LIMITS.dleqBody;
        if (body_b64.length > Math.ceil(cap / 3) * 4) return fail(res, 413, 'too_large');
        const decoded = decodeBase64(body_b64);
        if (decoded === null) return fail(res, 400, 'bad_request');
        if (decoded.length > cap) return fail(res, 413, 'too_large');
        body = decoded;
      }

      // Not an open proxy: the destination must be listed by a maker account right now.
      if (!(await registry.isListed(onion))) return fail(res, 403, 'onion_not_listed');

      const ip = clientIp(req, trustProxy);
      try {
        const up = await upstreamFetch({
          url: new URL(`http://${onion}${path as string}`),
          method,
          ...(body ? { body, contentType: 'application/octet-stream' } : {}),
          timeoutMs,
          maxResponseBytes: RELAY_LIMITS.upstreamResponse,
          socks: torSocks,
        });
        limiter.charge(ip, up.body.length);
        logger.debug(`forward ip=${ip} onion=${onion} ${method} ${path as string} sent=${body?.length ?? 0} status=${up.status} received=${up.body.length}`);
        const out: RelayForwardResponse = { status: up.status, body_b64: up.body.toString('base64') };
        res.setHeader('Cache-Control', 'no-store');
        res.json(out);
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        logger.debug(`forward ip=${ip} onion=${onion} ${method} ${path as string} failed=${err.code}`);
        fail(res, UPSTREAM_STATUS[err.code], err.code);
      }
    })().catch(next);
  });

  // ---------------------------------------------------------------- Monero node proxy
  app.use('/monero', rawBody, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      // `req.path` is the part after `/monero`, without the query string; a query is never forwarded.
      const m = /^\/(\d{1,4})(\/[^/]+)$/.exec(req.path);
      if (!m) return fail(res, 404, 'not_found');
      const sub = m[2]!;
      if (!MONERO_PATHS.includes(sub)) return fail(res, 403, 'monero_path_not_allowed');
      if (req.method !== 'POST') return fail(res, 405, 'bad_method');
      const node = config.moneroNodes[Number(m[1])];
      if (node === undefined) return fail(res, 404, 'no_such_node');

      let body = bodyOf(req);
      if (!chargeBody(req, res, body.length)) return;

      if (sub === '/json_rpc') {
        let call: unknown;
        try {
          call = JSON.parse(body.toString('utf8'));
        } catch {
          return fail(res, 400, 'bad_request');
        }
        // One call per request (no batches), and only a read-only method.
        if (typeof call !== 'object' || call === null || Array.isArray(call)) return fail(res, 400, 'bad_request');
        const rpcMethod = (call as Record<string, unknown>)['method'];
        if (typeof rpcMethod !== 'string' || !MONERO_METHODS.includes(rpcMethod)) return fail(res, 403, 'monero_method_not_allowed');
        // Forward the re-serialised object, not the client's bytes, so the node cannot read a
        // different `method` than the one checked here (duplicate keys, odd encodings).
        body = Buffer.from(JSON.stringify(call), 'utf8');
      }

      const url = new URL(sub, node);
      const ip = clientIp(req, trustProxy);
      try {
        const up = await upstreamFetch({
          url,
          method: 'POST',
          body,
          contentType: sub.endsWith('.bin') ? 'application/octet-stream' : 'application/json',
          timeoutMs,
          maxResponseBytes: config.moneroMaxResponseBytes,
          ...(url.hostname.endsWith('.onion') ? { socks: torSocks } : {}),
        });
        limiter.charge(ip, up.body.length);
        logger.debug(`monero ip=${ip} node=${m[1]!} ${sub} sent=${body.length} status=${up.status} received=${up.body.length}`);
        res.status(up.status);
        res.setHeader('Content-Type', sub.endsWith('.bin') ? 'application/octet-stream' : 'application/json');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.send(up.body);
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        logger.debug(`monero ip=${ip} node=${m[1]!} ${sub} failed=${err.code}`);
        fail(res, UPSTREAM_STATUS[err.code], err.code);
      }
    })().catch(next);
  });

  app.use((_req: Request, res: Response) => fail(res, 404, 'not_found'));

  // Errors are answered, never printed: express's default handler would write the stack, and
  // with it parts of the request, to stderr.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: unknown } | null)?.type;
    const status = (err as { status?: unknown } | null)?.status;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (type === 'entity.too.large') return fail(res, 413, 'too_large');
    if (typeof status === 'number' && status >= 400 && status < 500) return fail(res, 400, 'bad_request');
    logger.debug(`internal error: ${String(err)}`);
    fail(res, 500, 'internal');
  });

  return { app, registry, limiter, logger };
}

export interface RunningRelay extends Relay {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Create the relay and listen on the configured address (`127.0.0.1:8787` by default). */
export async function startRelay(config: RelayConfig, deps: RelayDeps = {}): Promise<RunningRelay> {
  const relay = createRelay(config, deps);
  const { logger } = relay;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = relay.app.listen(config.bindPort, config.bindHost);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address() as AddressInfo;
  relay.registry.start();

  logger.info(`listening on ${addr.address}:${addr.port}; Tor SOCKS proxy ${config.torSocksHost}:${config.torSocksPort}; ${config.moneroNodes.length} Monero node(s)`);
  if (config.debugLog) logger.info(DEBUG_WARNING);
  if (!isLoopback(config.bindHost))
    logger.info('WARNING: bound to a non-loopback address. Anyone who can reach it can use this relay; put it behind TLS and read the page on exposing the relay publicly.');
  if (!deps.registry && !(config.solanaRpcUrl && config.programId))
    logger.info('WARNING: no Solana RPC URL or program id is set, so the registry is empty and every forward is refused.');

  return {
    ...relay,
    server,
    host: addr.address,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        relay.registry.stop();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
