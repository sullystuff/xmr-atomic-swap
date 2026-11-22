import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, probeSocks, startRelay } from '../src/index.js';
import { setup } from './fixture.js';
import { call, closeAll, closedPort, fakeOnion, fakeRegistry, startBackend, startFakeSocks, startTestRelay } from './helpers.js';

afterEach(closeAll);

describe('GET /relay/v1/status', () => {
  it('reports Tor reachable, the registry and each Monero node', async () => {
    let now = 2_000_000;
    const good = await startBackend((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/get_height' ? JSON.stringify({ height: 3_210_987, status: 'OK' }) : '{}');
    });
    const broken = await startBackend((_req, res) => {
      res.writeHead(500);
      res.end('oops');
    });
    const dead = await closedPort();
    const f = await setup({
      env: { RELAY_MONERO_NODES: `http://127.0.0.1:${good.port},http://127.0.0.1:${broken.port},http://127.0.0.1:${dead}` },
      deps: { now: () => now },
    });
    f.registry.makers = 5;
    await f.relay.registry.refresh();
    now += 42_500;

    const res = await call(f.relay.port, '/relay/v1/status');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      tor_ok: true,
      registry_age_secs: 42,
      makers: 5,
      monero_nodes: [
        { ok: true, height: 3_210_987 },
        { ok: false, height: 0 },
        { ok: false, height: 0 },
      ],
    });
    expect(good.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /get_height']);
    // The Tor check negotiates with the proxy only: it opens no connection through it.
    expect(f.socks.accepted).toBe(1);
    expect(f.socks.connects).toHaveLength(0);
  });

  it('reports Tor unreachable when nothing listens on the SOCKS port', async () => {
    const relay = await startTestRelay({ env: { RELAY_TOR_SOCKS: `127.0.0.1:${await closedPort()}` }, deps: { registry: fakeRegistry([]) } });
    const body = (await call(relay.port, '/relay/v1/status')).json();
    expect(body.tor_ok).toBe(false);
    expect(body.monero_nodes).toEqual([]);
  });

  it('reports Tor unreachable when the port is not a SOCKS5 proxy', async () => {
    const http = await startBackend((_req, res) => res.end('not socks'));
    expect(await probeSocks('127.0.0.1', http.port, 1_000)).toBe(false);
    const socks = await startFakeSocks();
    expect(await probeSocks('127.0.0.1', socks.port, 1_000)).toBe(true);
  });

  it('reports a registry that has never been read, and one that cannot be read', async () => {
    const registry = fakeRegistry([fakeOnion()]);
    registry.failing = true;
    const relay = await startTestRelay({ env: { RELAY_TOR_SOCKS: `127.0.0.1:${await closedPort()}` }, deps: { registry } });
    await relay.registry.refresh();
    const body = (await call(relay.port, '/relay/v1/status')).json();
    expect(body.registry_age_secs).toBe(-1);
    expect(body.makers).toBe(0);
  });

  it('reuses a probe result for a few seconds so status cannot be used to hammer the nodes', async () => {
    const node = await startBackend((_req, res) => res.end(JSON.stringify({ height: 1 })));
    const f = await setup({ env: { RELAY_MONERO_NODES: `http://127.0.0.1:${node.port}` }, deps: { statusCacheMs: 5_000 } });
    for (let i = 0; i < 5; i++) expect((await call(f.relay.port, '/relay/v1/status')).json().monero_nodes).toEqual([{ ok: true, height: 1 }]);
    expect(node.seen).toHaveLength(1);
    expect(f.socks.accepted).toBe(1);
  });
});

describe('bind address', () => {
  it('defaults to 127.0.0.1:8787 and Tor at 127.0.0.1:9050', () => {
    const c = loadConfig();
    expect([c.bindHost, c.bindPort]).toEqual(['127.0.0.1', 8787]);
    expect([c.torSocksHost, c.torSocksPort]).toEqual(['127.0.0.1', 9050]);
  });

  it('listens on loopback only unless configured otherwise', async () => {
    // The default host with an ephemeral port (8787 may be in use on the build machine).
    const relay = await startRelay({ ...loadConfig(), bindPort: 0 }, { registry: fakeRegistry([]), logSink: () => {} });
    try {
      expect(relay.host).toBe('127.0.0.1');
      expect((await call(relay.port, '/relay/v1/status')).status).toBe(200);
      const external = Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => i!.address);
      for (const address of external) {
        const reached = await fetch(`http://${address}:${relay.port}/relay/v1/status`, { signal: AbortSignal.timeout(2_000) }).then(
          () => true,
          () => false,
        );
        expect([address, reached]).toEqual([address, false]);
      }
    } finally {
      await relay.close();
    }
  });

  it('warns at start when bound to a non-loopback address', async () => {
    const relay = await startTestRelay({ env: { RELAY_BIND: '0.0.0.0:0' }, deps: { registry: fakeRegistry([]) } });
    expect(relay.host).toBe('0.0.0.0');
    expect(relay.logs.some((l) => l.includes('WARNING: bound to a non-loopback address'))).toBe(true);
    const local = await startTestRelay({ deps: { registry: fakeRegistry([]) } });
    expect(local.logs.some((l) => l.includes('non-loopback'))).toBe(false);
  });
});

describe('cross-origin access', () => {
  it('sends no CORS headers by default', async () => {
    const f = await setup();
    const res = await call(f.relay.port, '/relay/v1/status', { headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only the configured origins', async () => {
    const f = await setup({ env: { RELAY_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' } });
    const ok = await call(f.relay.port, '/relay/v1/status', { headers: { origin: 'http://127.0.0.1:8080' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8080');
    const no = await call(f.relay.port, '/relay/v1/status', { headers: { origin: 'https://evil.example' } });
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await call(f.relay.port, '/relay/v1/forward', {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    expect(pre.headers['access-control-allow-headers']).toBe('Content-Type');
  });
});
