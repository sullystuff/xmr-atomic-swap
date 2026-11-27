/**
 * The bundle in one process: the built web UI and the relay behind one loopback origin
 * (SPEC 8.8). Tor, the Solana RPC, the Monero nodes and the maker are loopback fakes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROGRAM_ID } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleError, type RunningBundle, startBundle } from '../src/server.js';
import { loadSettings } from '../src/settings.js';
import { type Backend, type FakeMonero, type FakeSocks, type FakeSolana, call, closeAll, fakeOnion, onClose, startFakeMaker, startFakeMonero, startFakeSocks, startFakeSolana } from './fakes.js';
import { tmp } from './tmp.js';

afterEach(closeAll);

interface Stack {
  bundle: RunningBundle;
  socks: FakeSocks;
  solana: FakeSolana;
  nodes: FakeMonero[];
  maker: Backend;
  onion: string;
  host: string;
  logs: string[];
}

async function stack(env: Record<string, string> = {}, toml?: string): Promise<Stack> {
  const socks = await startFakeSocks();
  const maker = await startFakeMaker();
  const onion = fakeOnion();
  socks.map.set(onion, maker.port);
  const solana = await startFakeSolana([onion]);
  const nodes = [await startFakeMonero(), await startFakeMonero()];
  const settings = loadSettings({
    env: {
      XMRSWAP_UI_LISTEN: '127.0.0.1:0',
      RELAY_BIND: '127.0.0.1:0',
      RELAY_TOR_SOCKS: `127.0.0.1:${socks.port}`,
      SOLANA_RPC_URL: solana.url,
      RELAY_MONERO_NODES: nodes.map((n) => n.url).join(','),
      ...env,
    },
    ...(toml !== undefined ? { toml } : {}),
  });
  const logs: string[] = [];
  const bundle = await startBundle(settings, { relay: { logSink: (line) => logs.push(line), statusCacheMs: 0 } });
  onClose(() => bundle.close());
  return { bundle, socks, solana, nodes, maker, onion, host: `127.0.0.1:${bundle.port}`, logs };
}

const forwardBody = (onion: string, method: string, p: string, body?: Buffer): string => JSON.stringify({ onion, method, path: p, ...(body ? { body_b64: body.toString('base64') } : {}) });

describe('the static web UI', () => {
  it('serves the built page, its assets and the wasm from loopback', async () => {
    const s = await stack();
    expect(s.bundle.host).toBe('127.0.0.1');
    expect(s.bundle.relay.host).toBe('127.0.0.1');
    const index = await call(s.bundle.port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect(index.text).toContain('<div id="root">');
    // The page keeps its own strict Content-Security-Policy.
    expect(index.text).toContain("default-src 'none'");

    // Every asset the page refers to is served with the right type.
    const refs = [...index.text.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      const res = await call(s.bundle.port, `/${ref}`);
      expect(res.status, ref).toBe(200);
      expect(res.headers['content-type'], ref).toBe(ref.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      expect(res.headers['cache-control']).toContain('immutable');
    }
    const wasm = readdirSync(path.join(loadSettings().ui.dist, 'assets')).find((f) => f.endsWith('.wasm'))!;
    const res = await call(s.bundle.port, `/assets/${wasm}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/wasm');
    expect(res.body.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  });

  it('ships the status page that names the three required checks', async () => {
    const s = await stack();
    const index = await call(s.bundle.port, '/');
    const scripts = [...index.text.matchAll(/src="\.\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
    const js = (await Promise.all(scripts.map((f) => call(s.bundle.port, `/${f}`)))).map((r) => r.text).join('\n');
    for (const label of ['Tor proxy reachable', 'Solana RPC connected', 'Monero nodes in agreement', 'Maker reachable over Tor']) expect(js, label).toContain(label);
  });

  it('gives the page its defaults: self-hosted mode, the relay on the same origin, the pinned program', async () => {
    const s = await stack({ ETHEREUM_RPC_URL: 'http://127.0.0.1:1/eth' });
    const res = await call(s.bundle.port, '/config.json', { headers: { host: s.host } });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      mode: 'self-hosted',
      relayUrl: '/',
      solanaRpc: s.solana.url,
      ethereumRpc: 'http://127.0.0.1:1/eth',
      ethereumChainId: 1,
      moneroNodes: [`http://${s.host}/monero/0`, `http://${s.host}/monero/1`],
      ownNode: false,
      moneroNetwork: 'mainnet',
      programId: PROGRAM_ID,
      contract: '',
      pollMs: 4000,
    });
    // The Monero addresses follow the name the browser used, so they stay same-origin.
    const viaLocalhost = await call(s.bundle.port, '/config.json', { headers: { host: `localhost:${s.bundle.port}` } });
    expect(viaLocalhost.json().moneroNodes).toEqual([`http://localhost:${s.bundle.port}/monero/0`, `http://localhost:${s.bundle.port}/monero/1`]);
  });

  it('leaves the RPC settings out of config.json when no URL is set', async () => {
    const s = await stack({ SOLANA_RPC_URL: '' });
    const cfg = (await call(s.bundle.port, '/config.json')).json();
    expect(cfg).not.toHaveProperty('solanaRpc');
    expect(cfg).not.toHaveProperty('ethereumRpc');
  });

  it('keeps the RPC URLs out of config.json when told to, while the relay still uses them', async () => {
    const s = await stack({ XMRSWAP_UI_GIVE_PAGE_RPC_URLS: 'false', ETHEREUM_RPC_URL: 'http://127.0.0.1:1/eth' });
    const res = await call(s.bundle.port, '/config.json');
    expect(res.text).not.toContain(s.solana.url);
    expect(res.text).not.toContain('/eth');
    expect(res.json()).not.toHaveProperty('solanaRpc');
    await expect.poll(async () => (await call(s.bundle.port, '/relay/v1/status')).json().makers).toBe(1);
  });

  it('answers only for its own host names (no DNS rebinding)', async () => {
    const s = await stack();
    for (const p of ['/', '/config.json', '/relay/v1/status', '/monero/0/get_height']) {
      const res = await call(s.bundle.port, p, { headers: { host: `evil.example:${s.bundle.port}` }, ...(p.startsWith('/monero') ? { method: 'POST', body: '' } : {}) });
      expect(res.status, p).toBe(421);
      expect(res.json()).toEqual({ error: 'bad_host' });
    }
    expect((await call(s.bundle.port, '/', { headers: { host: `localhost:${s.bundle.port}` } })).status).toBe(200);
  });

  it('accepts the configured public origin as a host name and builds addresses from it', async () => {
    const s = await stack({ XMRSWAP_UI_PUBLIC_ORIGIN: 'https://swap.example.org' });
    const res = await call(s.bundle.port, '/config.json', { headers: { host: 'swap.example.org' } });
    expect(res.status).toBe(200);
    expect(res.json().moneroNodes).toEqual(['https://swap.example.org/monero/0', 'https://swap.example.org/monero/1']);
  });

  it('serves nothing outside the UI directory and no dot files', async () => {
    const s = await stack();
    for (const p of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/assets/../../package.json', '/..%2f..%2fpackage.json', '/.env', '/assets/.hidden', '/%00', '/nope.js', '/assets']) {
      const res = await call(s.bundle.port, p);
      expect([400, 404], p).toContain(res.status);
      expect(res.text, p).not.toContain('@xmrswap');
    }
    expect((await call(s.bundle.port, '/', { method: 'POST', body: 'x' })).status).toBe(405);
    expect((await call(s.bundle.port, '/index.html', { method: 'DELETE' })).status).toBe(405);
  });

  it('refuses to start without a built UI and says how to get one', async () => {
    const empty = tmp();
    const settings = loadSettings({ env: { XMRSWAP_UI_LISTEN: '127.0.0.1:0', RELAY_BIND: '127.0.0.1:0', XMRSWAP_UI_DIST: empty } });
    await expect(startBundle(settings)).rejects.toThrow(BundleError);
    await expect(startBundle(settings)).rejects.toThrow(/pnpm --filter @xmrswap\/web build/);
  });

  it('serves an unpacked release from another directory', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const s = await stack({ XMRSWAP_UI_DIST: dir });
    expect((await call(s.bundle.port, '/')).text).toBe('<!doctype html><div id="root"></div>');
  });
});

describe('the relay behind the same origin', () => {
  it('answers the status route with Tor, the registry and both Monero nodes', async () => {
    const s = await stack();
    // The relay reads the registry from the (fake) Solana RPC with getProgramAccounts.
    await expect.poll(async () => (await call(s.bundle.port, '/relay/v1/status')).json().makers).toBe(1);
    const res = await call(s.bundle.port, '/relay/v1/status');
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.tor_ok).toBe(true);
    expect(body.registry_age_secs).toBeGreaterThanOrEqual(0);
    expect(body.monero_nodes).toEqual([
      { ok: true, height: 3_300_000 },
      { ok: true, height: 3_300_000 },
    ]);
    expect(s.solana.methods).toContain('getProgramAccounts');
    // Same origin: the relay sends no CORS header, and none is needed.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports the Tor proxy as down when nothing listens on the SOCKS port', async () => {
    const s = await stack({ RELAY_TOR_SOCKS: '127.0.0.1:1' });
    expect((await call(s.bundle.port, '/relay/v1/status')).json().tor_ok).toBe(false);
  });

  it('forwards a message to a registered maker through the SOCKS proxy, by onion name', async () => {
    const s = await stack();
    const info = await call(s.bundle.port, '/relay/v1/forward', { body: forwardBody(s.onion, 'GET', '/xs/v1/info'), headers: { 'content-type': 'application/json' } });
    expect(info.status).toBe(200);
    expect(JSON.parse(Buffer.from(info.json().body_b64, 'base64').toString())).toMatchObject({ maker: 'M' });
    const msg = await call(s.bundle.port, '/relay/v1/forward', { body: forwardBody(s.onion, 'POST', '/xs/v1/msg', Buffer.from('ciphertext')), headers: { 'content-type': 'application/json' } });
    expect(Buffer.from(msg.json().body_b64, 'base64').toString()).toBe('reply:ciphertext');
    expect(s.socks.connects).toEqual([s.onion, s.onion]);
    expect(s.maker.seen.map((r) => r.url)).toEqual(['/xs/v1/info', '/xs/v1/msg']);
    // Nothing about the caller reaches the maker.
    expect(s.maker.seen[1]!.headers['x-forwarded-for']).toBeUndefined();
  });

  it('is not an open proxy: an onion address that is not in the registry is refused', async () => {
    const s = await stack();
    const other = fakeOnion();
    s.socks.map.set(other, s.maker.port);
    const res = await call(s.bundle.port, '/relay/v1/forward', { body: forwardBody(other, 'GET', '/xs/v1/info'), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: 'onion_not_listed' });
    expect(s.socks.connects).toEqual([]);
    const badPath = await call(s.bundle.port, '/relay/v1/forward', { body: forwardBody(s.onion, 'GET', '/admin'), headers: { 'content-type': 'application/json' } });
    expect(badPath.json()).toEqual({ error: 'bad_path' });
  });

  it('enforces the message size cap through the proxy', async () => {
    const s = await stack();
    const res = await call(s.bundle.port, '/relay/v1/forward', { body: forwardBody(s.onion, 'POST', '/xs/v1/msg', Buffer.alloc(16_385)), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large' });
    expect(s.maker.seen).toHaveLength(0);
  });

  it('proxies the allow-listed Monero calls and refuses the rest', async () => {
    const s = await stack();
    s.nodes[1]!.height = 3_300_001;
    const info = await call(s.bundle.port, '/monero/1/json_rpc', { body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }), headers: { 'content-type': 'application/json' } });
    expect(info.status).toBe(200);
    expect(info.json().result.height).toBe(3_300_001);
    const refused = await call(s.bundle.port, '/monero/0/json_rpc', { body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'flush_txpool' }) });
    expect(refused.status).toBe(403);
    expect(refused.json()).toEqual({ error: 'monero_method_not_allowed' });
    expect((await call(s.bundle.port, '/monero/0/stop_daemon', { method: 'POST', body: '' })).json()).toEqual({ error: 'monero_path_not_allowed' });
    expect((await call(s.bundle.port, '/monero/7/get_height', { method: 'POST', body: '' })).json()).toEqual({ error: 'no_such_node' });
  });

  it('keeps no message log by default', async () => {
    const s = await stack();
    await call(s.bundle.port, '/relay/v1/forward', { body: forwardBody(s.onion, 'POST', '/xs/v1/msg', Buffer.from('secret-body')), headers: { 'content-type': 'application/json' } });
    const all = s.logs.join('\n');
    expect(all).toContain('listening on 127.0.0.1');
    expect(all).not.toContain(s.onion);
    expect(all).not.toContain('secret-body');
    expect(all).not.toContain('forward ip=');
  });
});

describe('per-client limits behind the UI server', () => {
  const status = (s: Stack, xff?: string) => call(s.bundle.port, '/relay/v1/status', xff ? { headers: { 'x-forwarded-for': xff } } : {});

  it('limits by the address that connected, and a forged X-Forwarded-For does not buy a new budget', async () => {
    const s = await stack({ RELAY_RATE_REQUESTS_PER_MINUTE: '3' });
    expect((await status(s)).status).toBe(200);
    expect((await status(s, '203.0.113.9')).status).toBe(200);
    expect((await status(s, '203.0.113.10')).status).toBe(200);
    const refused = await status(s, '203.0.113.11');
    expect(refused.status).toBe(429);
    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('with one reverse proxy declared, limits by the address that proxy reports', async () => {
    const s = await stack({ RELAY_RATE_REQUESTS_PER_MINUTE: '2', RELAY_TRUST_PROXY_HOPS: '1' });
    // A reverse proxy in front appends the real client to whatever the client claimed.
    expect((await status(s, 'forged, 198.51.100.1')).status).toBe(200);
    expect((await status(s, 'other-forgery, 198.51.100.1')).status).toBe(200);
    expect((await status(s, '198.51.100.1')).status).toBe(429);
    // Another client still has its own budget.
    expect((await status(s, '198.51.100.2')).status).toBe(200);
  });
});

describe('settings the bundle hands on', () => {
  it('the example file loads to exactly the defaults', () => {
    const toml = readFileSync(new URL('../xmrswap.example.toml', import.meta.url), 'utf8');
    expect(loadSettings({ toml })).toEqual(loadSettings());
  });
});
