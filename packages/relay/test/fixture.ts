import type http from 'node:http';
import type { RelayConfig, RelayDeps } from '../src/index.js';
import {
  type Backend,
  type FakeRegistry,
  type FakeSocks,
  type Handler,
  type Seen,
  type TestRelay,
  fakeOnion,
  fakeRegistry,
  startBackend,
  startFakeSocks,
  startTestRelay,
} from './helpers.js';

export interface Fixture {
  socks: FakeSocks;
  maker: Backend;
  onion: string;
  registry: FakeRegistry;
  relay: TestRelay;
  /** DLEQ blobs the fake maker holds, by spend key. */
  blobs: Map<string, Buffer>;
}

/** A fake maker endpoint with the routes of SPEC 6.3. */
export function makerHandler(blobs: Map<string, Buffer>): Handler {
  return (req: Seen, res: http.ServerResponse) => {
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(value));
    };
    const dleq = /^\/xs\/v1\/dleq\/([0-9a-f]{64})$/.exec(req.url);
    if (req.method === 'GET' && req.url === '/xs/v1/info') return json(200, { maker: 'M', operator: 'O', enc_key_version: 1, chain_time: 1 });
    if (req.method === 'POST' && req.url === '/xs/v1/msg') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return void res.end(Buffer.concat([Buffer.from('reply:'), req.body]));
    }
    if (dleq && req.method === 'PUT') {
      blobs.set(dleq[1]!, req.body);
      res.writeHead(204);
      return void res.end();
    }
    if (dleq && req.method === 'GET') {
      const blob = blobs.get(dleq[1]!);
      if (!blob) return json(404, { code: 'bad_request' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return void res.end(blob);
    }
    if (req.method === 'GET' && /^\/xs\/v1\/pool\/[0-9a-f]{64}$/.test(req.url)) return json(200, { leaves: [{ index: 0, key: 'k', key2: 'k2', spend_pub: 's' }] });
    if (req.method === 'GET' && /^\/xs\/v1\/replies\/[0-9a-f]{64}$/.test(req.url)) return json(200, { envelopes: ['AAEC'] });
    json(404, { code: 'bad_request' });
  };
}

export async function setup(
  opts: { handler?: Handler; env?: Record<string, string>; deps?: RelayDeps; config?: Partial<RelayConfig>; captureLogs?: boolean } = {},
): Promise<Fixture> {
  const blobs = new Map<string, Buffer>();
  const socks = await startFakeSocks();
  const maker = await startBackend(opts.handler ?? makerHandler(blobs));
  const onion = fakeOnion();
  socks.map.set(onion, maker.port);
  const registry = fakeRegistry([onion]);
  const relay = await startTestRelay({
    env: { RELAY_TOR_SOCKS: `127.0.0.1:${socks.port}`, ...opts.env },
    deps: { registry, ...opts.deps },
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.captureLogs !== undefined ? { captureLogs: opts.captureLogs } : {}),
  });
  return { socks, maker, onion, registry, relay, blobs };
}
