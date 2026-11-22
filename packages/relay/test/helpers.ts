/**
 * In-process fakes: a SOCKS5 server standing in for Tor, HTTP backends standing in for maker
 * onion services and Monero nodes, and a small HTTP client. Everything listens on loopback;
 * nothing here touches the system Tor, the Tor network or any real node.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { type RelayConfig, type RelayDeps, type RegistrySource, type RunningRelay, loadConfig, startRelay } from '../src/index.js';

const closers: (() => Promise<void>)[] = [];
/** Close everything the helpers opened (call from `afterEach`). */
export async function closeAll(): Promise<void> {
  while (closers.length) await closers.pop()!();
}

// ------------------------------------------------------------------ SOCKS5

export interface SocksConnect {
  /** 1 = IPv4, 3 = domain name (the proxy resolves it), 4 = IPv6. */
  atyp: number;
  host: string;
  port: number;
}

export interface FakeSocks {
  port: number;
  /** Every CONNECT the server received, in order. */
  connects: SocksConnect[];
  /** TCP connections accepted, including bare probes. */
  accepted: number;
  /** Destination host name -> local port of the fake backend that plays it. */
  map: Map<string, number>;
}

/** A minimal SOCKS5 server (no auth, CONNECT only). Unmapped destinations get "host unreachable". */
export async function startFakeSocks(): Promise<FakeSocks> {
  const state: FakeSocks = { port: 0, connects: [], accepted: 0, map: new Map() };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    state.accepted += 1;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'request' | 'piped' = 'greeting';
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
        if (buf[0] !== 0x05) return void client.destroy();
        buf = buf.subarray(2 + buf[1]!);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3]!;
        let host: string;
        let end: number;
        if (atyp === 0x01) {
          end = 4 + 4;
          if (buf.length < end + 2) return;
          host = [...buf.subarray(4, 8)].join('.');
        } else if (atyp === 0x03) {
          end = 5 + buf[4]!;
          if (buf.length < end + 2) return;
          host = buf.subarray(5, end).toString('latin1');
        } else {
          end = 4 + 16;
          if (buf.length < end + 2) return;
          host = buf.subarray(4, end).toString('hex');
        }
        const port = buf.readUInt16BE(end);
        const rest = buf.subarray(end + 2);
        state.connects.push({ atyp, host, port });
        const target = state.map.get(host);
        if (buf[1] !== 0x01 || target === undefined) {
          client.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        stage = 'piped';
        client.off('data', onData);
        const upstream = net.connect(target, '127.0.0.1', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.on('close', () => {
          sockets.delete(upstream);
          client.destroy();
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
      }
    };
    client.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as AddressInfo).port;
  closers.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return state;
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ------------------------------------------------------------------ HTTP backends

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface Backend {
  port: number;
  seen: Seen[];
}

export type Handler = (req: Seen, res: http.ServerResponse) => void;

/** An HTTP server on loopback that records every request and answers with `handler`. */
export async function startBackend(handler: Handler): Promise<Backend> {
  const backend: Backend = { port: 0, seen: [] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      backend.seen.push(seen);
      handler(seen, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  backend.port = (server.address() as AddressInfo).port;
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );
  return backend;
}

// ------------------------------------------------------------------ registry and relay

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A syntactically valid v3 onion host that exists nowhere. */
export function fakeOnion(): string {
  return `${[...randomBytes(56)].map((b) => B32[b % 32]).join('')}.onion`;
}

export interface FakeRegistry extends RegistrySource {
  onions: string[];
  makers: number | null;
  fetches: number;
  failing: boolean;
}

export function fakeRegistry(onions: string[] = []): FakeRegistry {
  const reg: FakeRegistry = {
    onions,
    makers: null,
    fetches: 0,
    failing: false,
    fetch: async () => {
      reg.fetches += 1;
      if (reg.failing) throw new Error('rpc down');
      return { makers: reg.makers ?? reg.onions.length, onions: [...reg.onions] };
    },
  };
  return reg;
}

export interface TestRelay extends RunningRelay {
  url: string;
  logs: string[];
}

/** Start a relay on an ephemeral loopback port. `settings` are TOML-level keys of `relay.toml`. */
export async function startTestRelay(
  opts: { env?: Record<string, string>; deps?: RelayDeps; config?: Partial<RelayConfig>; captureLogs?: boolean } = {},
): Promise<TestRelay> {
  const config: RelayConfig = { ...loadConfig({ env: { RELAY_BIND: '127.0.0.1:0', ...opts.env } }), ...opts.config };
  const logs: string[] = [];
  const deps: RelayDeps = { statusCacheMs: 0, ...opts.deps };
  if (opts.captureLogs !== false && !deps.logSink) deps.logSink = (line) => logs.push(line);
  const relay = await startRelay(config, deps);
  closers.push(() => relay.close());
  return { ...relay, url: `http://127.0.0.1:${relay.port}`, logs };
}

// ------------------------------------------------------------------ client

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json(): any;
}

export interface CallOptions {
  method?: string;
  body?: Buffer | string;
  headers?: Record<string, string>;
  /** Source address of the client (any 127.x.y.z works on Linux). */
  localAddress?: string;
}

export function call(port: number, path: string, opts: CallOptions = {}): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? (body ? 'POST' : 'GET'),
        agent: false,
        headers: { ...(body ? { 'content-length': String(body.length) } : {}), ...opts.headers },
        ...(opts.localAddress ? { localAddress: opts.localAddress } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json: () => JSON.parse(buf.toString('utf8')) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export interface ForwardArgs {
  onion: unknown;
  method: unknown;
  path: unknown;
  body?: Buffer;
  body_b64?: unknown;
}

/** `POST /relay/v1/forward`. */
export function forward(relay: { port: number }, args: ForwardArgs, opts: CallOptions = {}): Promise<Reply> {
  const payload: Record<string, unknown> = { onion: args.onion, method: args.method, path: args.path };
  if (args.body) payload['body_b64'] = args.body.toString('base64');
  if (args.body_b64 !== undefined) payload['body_b64'] = args.body_b64;
  return call(relay.port, '/relay/v1/forward', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, ...opts });
}

export const hex64 = (fill: string): string => fill.repeat(64).slice(0, 64);
