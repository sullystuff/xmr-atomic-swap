// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DaemonClient, type SocketLike } from '../src/api/client.js';
import { MOCK_TOKEN, startMockServer, type MockServer } from '../server/mock-server.js';
import { REF } from '../src/mock/fixtures.js';

/** The mock daemon behind real loopback HTTP and WebSocket: what `pnpm dev` runs. */
describe('mock daemon over loopback', () => {
  let server: MockServer;
  beforeAll(async () => {
    server = await startMockServer({ port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  it('binds 127.0.0.1 only', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves the API to the real client over HTTP', async () => {
    const client = new DaemonClient({ baseUrl: server.url, token: MOCK_TOKEN });
    const status = await client.call('status');
    expect(status.mode).toBe('live');
    const swaps = await client.call('swaps', { body: { state: 'PENDING', limit: 2 } });
    expect(swaps.swaps).toHaveLength(2);
    const v = await client.call('configValidate', { body: { toml: '[offers]\nupdate_interval_seconds = 1\n' } });
    expect(v.update_cost?.daily_lamports).toBe('432000000');
    const released = await client.call('swapRelease', { params: { ref: REF.withheld } });
    expect(released.ok).toBe(true);
  });

  it('refuses a missing token and a body that is not JSON', async () => {
    expect((await fetch(`${server.url}/api/status`)).status).toBe(401);
    const bad = await fetch(`${server.url}/api/config/validate`, { method: 'POST', headers: { Authorization: `Bearer ${MOCK_TOKEN}`, 'Content-Type': 'application/json' }, body: '{' });
    expect(bad.status).toBe(400);
    expect((await fetch(`${server.url}/api/nope`, { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } })).status).toBe(404);
  });

  it('pushes over the WebSocket: snapshot on subscribe, then updates', async () => {
    const client = new DaemonClient({ baseUrl: server.url, token: MOCK_TOKEN, socket: (url) => new WebSocket(url) as unknown as SocketLike });
    const seen: string[] = [];
    let live = false;
    const stop = client.live({ onData: (channel, _d, op) => seen.push(`${op}:${channel}`), onConnection: (s) => (live = s === 'live') }, ['swaps', 'alerts']);
    await expect.poll(() => seen.length).toBe(2);
    expect(live).toBe(true);
    expect(seen).toEqual(['snapshot:swaps', 'snapshot:alerts']);
    await client.call('swapApprove', { params: { ref: REF.pendingSol } });
    await expect.poll(() => seen).toContain('update:swaps');
    stop();
    await expect.poll(() => server.daemon.connections).toBe(0);
  });

  it('refuses a WebSocket without the token', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/ws`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', (e) => resolve(e.message));
    });
    expect(outcome).toContain('401');
  });
});
