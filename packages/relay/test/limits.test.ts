import { RELAY_LIMITS } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter, loadConfig } from '../src/index.js';
import { setup } from './fixture.js';
import { call, closeAll, forward } from './helpers.js';

afterEach(closeAll);

describe('per-IP rate limits', () => {
  it('defaults to 60 requests and 4 MB per minute', () => {
    const c = loadConfig();
    expect(c.requestsPerMinute).toBe(60);
    expect(c.bytesPerMinute).toBe(4 * 1024 * 1024);
    expect(RELAY_LIMITS.defaultRequestsPerMinute).toBe(60);
  });

  it('refuses the 61st request in a minute, per address, and recovers in the next minute', async () => {
    let now = 5_000_000;
    const f = await setup({ deps: { now: () => now } });
    const get = (ip?: string) => forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' }, ip ? { localAddress: ip } : {});

    for (let i = 0; i < 60; i++) expect((await get()).status).toBe(200);
    const refused = await get();
    expect(refused.status).toBe(429);
    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(f.maker.seen).toHaveLength(60);

    // Every route counts, including status and refused requests.
    expect((await call(f.relay.port, '/relay/v1/status')).status).toBe(429);

    // Another address is unaffected.
    expect((await get('127.0.0.2')).status).toBe(200);

    now += 59_000;
    expect((await get()).status).toBe(429);
    now += 1_001;
    expect((await get()).status).toBe(200);
  });

  it('counts refused requests against the limit too', async () => {
    const f = await setup({ env: { RELAY_RATE_REQUESTS_PER_MINUTE: '5' } });
    for (let i = 0; i < 5; i++) expect((await forward(f.relay, { onion: 'example.com', method: 'GET', path: '/xs/v1/info' })).status).toBe(400);
    expect((await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' })).status).toBe(429);
    expect(f.socks.accepted).toBe(0);
  });

  it('enforces the byte budget on bodies carried in both directions', async () => {
    let now = 9_000_000;
    const f = await setup({ env: { RELAY_RATE_BYTES_PER_MINUTE: '50000' }, deps: { now: () => now } });
    const send = (n: number, ip?: string) =>
      forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/msg', body: Buffer.alloc(n, 3) }, ip ? { localAddress: ip } : {});

    // 9,000 bytes up is about 12 kB of request and 9 kB of reply: two fit in 50 kB, the third does not.
    expect((await send(9_000)).status).toBe(200);
    expect((await send(9_000)).status).toBe(200);
    const third = await send(9_000);
    expect(third.status).toBe(429);
    expect(third.json()).toEqual({ error: 'rate_limited' });
    expect(f.maker.seen).toHaveLength(2);

    // A small request is refused as well once the budget is spent by a large reply.
    expect((await send(9_000, '127.0.0.3')).status).toBe(200);
    expect((await send(15_000, '127.0.0.3')).status).toBe(200);
    expect((await send(1, '127.0.0.3')).status).toBe(429);

    now += 60_001;
    expect((await send(9_000)).status).toBe(200);
  });

  it('ignores X-Forwarded-For unless a trusted proxy is configured', async () => {
    const f = await setup({ env: { RELAY_RATE_REQUESTS_PER_MINUTE: '3' } });
    const get = (xff: string) => call(f.relay.port, '/relay/v1/status', { headers: { 'x-forwarded-for': xff } });
    // A client cannot escape its limit by inventing addresses.
    for (let i = 0; i < 3; i++) expect((await get(`198.51.100.${i}`)).status).toBe(200);
    expect((await get('198.51.100.99')).status).toBe(429);
  });

  it('limits by the address a trusted reverse proxy reports', async () => {
    const f = await setup({ env: { RELAY_RATE_REQUESTS_PER_MINUTE: '3', RELAY_TRUST_PROXY_HOPS: '1' } });
    const get = (xff: string) => call(f.relay.port, '/relay/v1/status', { headers: { 'x-forwarded-for': xff } });
    for (let i = 0; i < 3; i++) expect((await get('198.51.100.1')).status).toBe(200);
    expect((await get('198.51.100.1')).status).toBe(429);
    expect((await get('198.51.100.2')).status).toBe(200);
    // Only the last hop is trusted: a forged left-most entry does not help.
    expect((await get('203.0.113.9, 198.51.100.1')).status).toBe(429);
  });

  it('forgets an address once its window has passed', () => {
    let now = 0;
    const l = new RateLimiter({ requestsPerMinute: 2, bytesPerMinute: 100, now: () => now });
    expect(l.admit('a')).toBe(true);
    expect(l.admit('a')).toBe(true);
    expect(l.admit('a')).toBe(false);
    expect(l.admit('b')).toBe(true);
    l.charge('b', 100);
    expect(l.admit('b')).toBe(false);
    expect(l.tracked).toBe(2);
    now = 60_000;
    expect(l.admit('c')).toBe(true);
    expect(l.tracked).toBe(1);
    expect(l.admit('a')).toBe(true);
    expect(l.hasBudget('b', 100)).toBe(true);
    expect(l.hasBudget('b', 101)).toBe(false);
  });
});
