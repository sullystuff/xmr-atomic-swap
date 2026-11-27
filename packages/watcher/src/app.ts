/**
 * The watcher's HTTP API (SPEC 11.6). Four routes; everything else is 404.
 *
 *   GET  /watch/v1/info               the keys to name as watcher
 *   POST /watch/v1/swaps              hand over a swap; answers the signed acknowledgement
 *   GET  /watch/v1/swaps/<swap_ref>   what the watcher has seen and done for that swap
 *   GET  /watch/v1/health             endpoints, Monero nodes, fee balances and their runway
 *
 * There are no accounts and no tokens: a request is believed for what it contains (a notice key
 * sealed to this watcher for one chain and swap) and for what the chain says about that swap.
 * No route lists watches. Bodies are size-capped and never logged; limits are per client IP.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { DEBUG_WARNING, type Logger, errorClass } from './log.js';
import { RateLimiter } from './ratelimit.js';
import type { Watcher } from './service.js';

export const ROUTES = { info: '/watch/v1/info', swaps: '/watch/v1/swaps', swap: '/watch/v1/swaps/:ref', health: '/watch/v1/health' } as const;

export interface AppSettings {
  bindHost: string;
  bindPort: number;
  trustProxyHops: number;
  requestsPerMinute: number;
  registrationsPerMinute: number;
  maxBodyBytes: number;
}

function clientIp(req: Request, trustProxy: boolean): string {
  const raw = (trustProxy ? req.ip : req.socket.remoteAddress) ?? 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function createApp(watcher: Watcher, settings: AppSettings, logger: Logger, now: () => number = Date.now): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  const trustProxy = settings.trustProxyHops > 0;
  if (trustProxy) app.set('trust proxy', settings.trustProxyHops);
  const all = new RateLimiter(settings.requestsPerMinute, now);
  const registrations = new RateLimiter(settings.registrationsPerMinute, now);
  const limited = (limiter: RateLimiter) => (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req, trustProxy);
    if (limiter.admit(ip)) return next();
    logger.debug(`rate limited: ${ip}`);
    res.setHeader('Retry-After', String(limiter.retryAfterSecs(ip)));
    res.status(429).json({ error: 'rate_limited' });
  };

  app.use(limited(all));
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get(ROUTES.info, (_req, res) => {
    res.json(watcher.info());
  });

  app.post(ROUTES.swaps, limited(registrations), express.json({ limit: settings.maxBodyBytes, strict: true, type: () => true }), (req: Request, res: Response, next: NextFunction) => {
    watcher
      .register(req.body)
      .then((r) => res.status(r.status).json(r.body))
      .catch(next);
  });

  app.get(ROUTES.swap, (req: Request, res: Response) => {
    const found = watcher.status(String(req.params['ref'] ?? ''));
    // One answer for "never heard of it" and "malformed": the route says nothing about other swaps.
    if (!found) res.status(404).json({ error: 'not_found' });
    else res.json(found);
  });

  app.get(ROUTES.health, (_req: Request, res: Response, next: NextFunction) => {
    watcher
      .health()
      .then((h) => res.status(h['ok'] ? 200 : 503).json(h))
      .catch(next);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  // Malformed JSON, an oversized body, or a bug: an error code, never the body, never a stack.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') return void res.status(413).json({ error: 'too_large' });
    if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || type === 'charset.unsupported' || type === 'request.aborted' || type === 'request.size.invalid') return void res.status(400).json({ error: 'bad_request' });
    logger.info(`request failed (${errorClass(err)})`);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

export interface Listening {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function listen(app: express.Express, settings: AppSettings, logger: Logger): Promise<Listening> {
  if (logger.debugEnabled) logger.info(DEBUG_WARNING);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(settings.bindPort, settings.bindHost, () => resolve(s));
    s.once('error', reject);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  const port = (server.address() as AddressInfo).port;
  const host = settings.bindHost.includes(':') ? `[${settings.bindHost}]` : settings.bindHost;
  logger.info(`listening on ${host}:${port}`);
  return {
    server,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
