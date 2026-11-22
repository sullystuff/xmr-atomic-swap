import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RELAY_LIMITS } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './fixture.js';
import { call, closeAll, closedPort, fakeOnion, fakeRegistry, forward, hex64, startBackend, startTestRelay } from './helpers.js';

afterEach(closeAll);

const vectors = new URL('../../../interfaces/vectors/', import.meta.url);

describe('forwarding to a listed onion service', () => {
  it('forwards a message through the SOCKS5 proxy with remote DNS and returns the reply', async () => {
    const f = await setup();
    const envelope = Buffer.from('ciphertext-envelope-\u0000\u0001ÿ', 'latin1');
    const res = await forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/msg', body: envelope });

    expect(res.status).toBe(200);
    const out = res.json();
    expect(out.status).toBe(200);
    expect(Buffer.from(out.body_b64, 'base64')).toEqual(Buffer.concat([Buffer.from('reply:'), envelope]));

    // The proxy was asked for the onion NAME (address type 3) on port 80: the relay resolved nothing.
    expect(f.socks.connects).toEqual([{ atyp: 3, host: f.onion, port: 80 }]);

    // The maker saw exactly the envelope, addressed to the onion host, with nothing about the client.
    expect(f.maker.seen).toHaveLength(1);
    const seen = f.maker.seen[0]!;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/xs/v1/msg');
    expect(seen.body).toEqual(envelope);
    expect(seen.headers.host).toBe(f.onion);
    expect(seen.headers['content-type']).toBe('application/octet-stream');
    for (const h of ['x-forwarded-for', 'forwarded', 'via', 'origin', 'referer', 'cookie', 'user-agent', 'x-real-ip']) expect(seen.headers[h]).toBeUndefined();
  });

  it('does not pass client headers on to the maker', async () => {
    const f = await setup();
    await forward(
      f.relay,
      { onion: f.onion, method: 'GET', path: '/xs/v1/info' },
      { headers: { 'content-type': 'application/json', cookie: 'session=abc', 'x-forwarded-for': '198.51.100.7', origin: 'https://ui.example', 'user-agent': 'Browser/1' } },
    );
    expect(Object.keys(f.maker.seen[0]!.headers).sort()).toEqual(['connection', 'host']);
  });

  it('serves every route of the maker endpoint with the method that route defines', async () => {
    const f = await setup();
    const k = hex64('ab');
    const info = await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' });
    expect(JSON.parse(Buffer.from(info.json().body_b64, 'base64').toString())).toMatchObject({ maker: 'M', enc_key_version: 1 });
    const pool = await forward(f.relay, { onion: f.onion, method: 'GET', path: `/xs/v1/pool/${k}` });
    expect(JSON.parse(Buffer.from(pool.json().body_b64, 'base64').toString()).leaves).toHaveLength(1);
    const replies = await forward(f.relay, { onion: f.onion, method: 'GET', path: `/xs/v1/replies/${k}` });
    expect(JSON.parse(Buffer.from(replies.json().body_b64, 'base64').toString())).toEqual({ envelopes: ['AAEC'] });
    expect(f.maker.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /xs/v1/info', `GET /xs/v1/pool/${k}`, `GET /xs/v1/replies/${k}`]);
  });

  it('passes an upstream 4xx back inside the envelope instead of failing', async () => {
    const f = await setup();
    const res = await forward(f.relay, { onion: f.onion, method: 'GET', path: `/xs/v1/dleq/${hex64('0')}` });
    expect(res.status).toBe(200);
    expect(res.json().status).toBe(404);
    expect(JSON.parse(Buffer.from(res.json().body_b64, 'base64').toString())).toEqual({ code: 'bad_request' });
  });

  it('forwards a real DLEQ blob from dleq.json unchanged, up and down', async () => {
    const dleq = JSON.parse(readFileSync(new URL('dleq.json', vectors), 'utf8'));
    const c = dleq.cases.find((x: { name: string }) => x.name === 'valid-1');
    const blob = readFileSync(new URL(c.input.file, vectors));
    expect(blob.length).toBe(56_679);
    expect(createHash('sha256').update(blob).digest('hex')).toBe(c.input.sha256);

    const f = await setup();
    const path = `/xs/v1/dleq/${c.output.spend_pub}`;
    const put = await forward(f.relay, { onion: f.onion, method: 'PUT', path, body: blob });
    expect(put.status).toBe(200);
    expect(put.json()).toEqual({ status: 204, body_b64: '' });
    expect(createHash('sha256').update(f.blobs.get(c.output.spend_pub)!).digest('hex')).toBe(c.input.sha256);

    const get = await forward(f.relay, { onion: f.onion, method: 'GET', path });
    expect(get.json().status).toBe(200);
    expect(Buffer.from(get.json().body_b64, 'base64').equals(blob)).toBe(true);
  });
});

describe('not an open proxy', () => {
  it('refuses an onion address that no maker account lists, without touching Tor', async () => {
    const f = await setup();
    const res = await forward(f.relay, { onion: fakeOnion(), method: 'GET', path: '/xs/v1/info' });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: 'onion_not_listed' });
    expect(f.socks.accepted).toBe(0);
    expect(f.maker.seen).toHaveLength(0);
  });

  it('refuses clearnet hosts, IP literals and every disguise of them', async () => {
    const f = await setup();
    const clearnet = await startBackend((_req, res) => res.end('clearnet'));
    // Even if the proxy would happily connect to these, the relay must never ask it to.
    for (const h of ['example.com', '127.0.0.1', 'localhost']) f.socks.map.set(h, clearnet.port);

    const o = f.onion;
    const bad: unknown[] = [
      'example.com',
      'localhost',
      '127.0.0.1',
      `127.0.0.1:${clearnet.port}`,
      '10.0.0.1',
      '169.254.169.254',
      '2130706433',
      '0x7f.0.0.1',
      '::1',
      '[::1]',
      '[::ffff:127.0.0.1]',
      `${o}:80`,
      `${o}:8080`,
      `${o}.`,
      `${o}.example.com`,
      `example.com/${o}`,
      `example.com#${o}`,
      `example.com?${o}`,
      `user@${o}`,
      `${o}@example.com`,
      `http://${o}`,
      `${o}/`,
      `${o}/../x`,
      ` ${o}`,
      `${o}\n`,
      `${o}\r\nHost: example.com`,
      o.toUpperCase(),
      `www.${o}`,
      o.slice(1),
      `${'a'.repeat(16)}.onion`,
      '.onion',
      '',
      null,
      42,
      [o],
      { host: o },
    ];
    for (const onion of bad) {
      const res = await call(f.relay.port, '/relay/v1/forward', {
        method: 'POST',
        body: JSON.stringify({ onion, method: 'GET', path: '/xs/v1/info' }),
        localAddress: `127.0.1.${1 + (bad.indexOf(onion) % 200)}`,
      });
      expect([onion, res.status, res.json()]).toEqual([onion, 400, { error: 'bad_onion' }]);
    }
    expect(f.socks.accepted).toBe(0);
    expect(clearnet.seen).toHaveLength(0);
    expect(f.maker.seen).toHaveLength(0);
  });

  it('never forwards to a non-onion host even if the registry source returns one', async () => {
    const f = await setup();
    const clearnet = await startBackend((_req, res) => res.end('clearnet'));
    f.socks.map.set('example.com', clearnet.port);
    f.registry.onions = ['example.com', '127.0.0.1', `${f.onion}:22`, f.onion];
    await f.relay.registry.refresh();

    for (const onion of ['example.com', '127.0.0.1', `${f.onion}:22`]) {
      const res = await forward(f.relay, { onion, method: 'GET', path: '/xs/v1/info' });
      expect(res.status).toBe(400);
    }
    expect(f.socks.accepted).toBe(0);
    expect((await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' })).json().status).toBe(200);
  });

  it('stops forwarding to an onion once it leaves the registry', async () => {
    let now = 1_000_000;
    const f = await setup({ deps: { now: () => now } });
    expect((await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' })).status).toBe(200);
    f.registry.onions = [];
    now += 61_000;
    const res = await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' });
    expect(res.status).toBe(403);
    expect(f.maker.seen).toHaveLength(1);
  });

  it('refuses a redirect from the onion service and never follows it', async () => {
    const clearnet = await startBackend((_req, res) => res.end('secret from clearnet'));
    for (const code of [301, 302, 303, 307, 308]) {
      const f = await setup({
        handler: (_req, res) => {
          res.writeHead(code, { location: `http://127.0.0.1:${clearnet.port}/steal` });
          res.end('moved');
        },
      });
      f.socks.map.set('127.0.0.1', clearnet.port);
      const res = await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' });
      expect(res.status).toBe(502);
      expect(res.json()).toEqual({ error: 'upstream_redirect' });
      expect(f.socks.connects).toEqual([{ atyp: 3, host: f.onion, port: 80 }]);
    }
    expect(clearnet.seen).toHaveLength(0);
  });

  it('only forwards the paths of the maker endpoint', async () => {
    const f = await setup({ env: { RELAY_RATE_REQUESTS_PER_MINUTE: '1000' } });
    const k = hex64('a');
    const bad: unknown[] = [
      '/',
      '',
      '/xs/v1',
      '/xs/v1/',
      '/xs/v1/info/',
      '/xs/v1/info?x=1',
      '/xs/v1/info#x',
      '/xs/v1/info/../../admin',
      '/xs/v1/../v1/info',
      '//xs/v1/info',
      'xs/v1/info',
      '/xs/v2/info',
      '/xs/v1/INFO',
      '/xs/v1/msg\n',
      '/xs/v1/msg HTTP/1.1\r\nX: y',
      '/xs/v1/admin',
      '/xs/v1/dleq',
      '/xs/v1/dleq/',
      `/xs/v1/dleq/${k.slice(1)}`,
      `/xs/v1/dleq/${k}0`,
      `/xs/v1/dleq/${k.toUpperCase()}`,
      `/xs/v1/dleq/${'g'.repeat(64)}`,
      `/xs/v1/dleq/${k}/x`,
      `/xs/v1/pool/${k}?all=1`,
      `/xs/v1/replies/${k}/..`,
      `http://example.com/xs/v1/info`,
      `/xs/v1/info%2f..`,
      null,
      7,
      ['/xs/v1/info'],
    ];
    for (const path of bad) {
      const res = await forward(f.relay, { onion: f.onion, method: 'GET', path });
      expect([path, res.status, res.json()]).toEqual([path, 400, { error: 'bad_path' }]);
    }
    expect(f.socks.accepted).toBe(0);
  });

  it('only allows the method each route defines', async () => {
    const f = await setup({ env: { RELAY_RATE_REQUESTS_PER_MINUTE: '1000' } });
    const k = hex64('a');
    const body = Buffer.from('x');
    const bad: [unknown, string][] = [
      ['POST', '/xs/v1/info'],
      ['PUT', '/xs/v1/info'],
      ['GET', '/xs/v1/msg'],
      ['PUT', '/xs/v1/msg'],
      ['POST', `/xs/v1/dleq/${k}`],
      ['POST', `/xs/v1/pool/${k}`],
      ['PUT', `/xs/v1/pool/${k}`],
      ['POST', `/xs/v1/replies/${k}`],
      ['PUT', `/xs/v1/replies/${k}`],
      ['DELETE', `/xs/v1/dleq/${k}`],
      ['HEAD', '/xs/v1/info'],
      ['OPTIONS', '/xs/v1/info'],
      ['CONNECT', '/xs/v1/info'],
      ['get', '/xs/v1/info'],
      ['GET ', '/xs/v1/info'],
      [undefined, '/xs/v1/info'],
      [null, '/xs/v1/info'],
      [['GET'], '/xs/v1/info'],
    ];
    for (const [method, path] of bad) {
      const res = await forward(f.relay, { onion: f.onion, method, path, body });
      expect([method, path, res.status, res.json()]).toEqual([method, path, 405, { error: 'bad_method' }]);
    }
    expect(f.socks.accepted).toBe(0);
  });

  it('rejects malformed forward requests', async () => {
    const f = await setup();
    const post = (body: string) => call(f.relay.port, '/relay/v1/forward', { method: 'POST', body });
    for (const body of ['', 'not json', '[]', 'null', '"x"', '{']) expect((await post(body)).status).toBe(400);
    const base = { onion: f.onion, path: '/xs/v1/msg', method: 'POST' };
    // A body is required on POST and PUT, must be strict base64, and is not allowed on GET.
    expect((await forward(f.relay, base)).json()).toEqual({ error: 'bad_request' });
    for (const body_b64 of ['@@@@', 'YQ', 'YQ=', 'Y Q==', 'YQ==\n', 7, { a: 1 }]) expect((await forward(f.relay, { ...base, body_b64 })).json()).toEqual({ error: 'bad_request' });
    expect((await forward(f.relay, { onion: f.onion, path: '/xs/v1/info', method: 'GET', body_b64: 'YQ==' })).json()).toEqual({ error: 'bad_request' });
    expect(f.socks.accepted).toBe(0);
  });

  it('has no other way in: unknown routes and methods are refused', async () => {
    const f = await setup();
    expect((await call(f.relay.port, '/')).status).toBe(404);
    expect((await call(f.relay.port, '/relay/v1/forward')).status).toBe(404);
    expect((await call(f.relay.port, `/relay/v1/forward?url=http://${f.onion}/xs/v1/info`)).status).toBe(404);
    expect((await call(f.relay.port, `http://${f.onion}/xs/v1/info`)).status).toBe(404);
    expect((await call(f.relay.port, '/relay/v1/status', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await call(f.relay.port, `${f.onion}:80`, { method: 'CONNECT' }).catch(() => ({ status: 0 }))).status).not.toBe(200);
    expect(f.socks.connects).toHaveLength(0);
  });
});

describe('size caps', () => {
  it('accepts a 16,384-byte message and refuses 16,385 bytes', async () => {
    const f = await setup();
    expect(RELAY_LIMITS.msgBody).toBe(16_384);
    const ok = await forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/msg', body: Buffer.alloc(16_384, 7) });
    expect(ok.json().status).toBe(200);
    expect(f.maker.seen[0]!.body.length).toBe(16_384);

    for (const n of [16_385, 16_386, 16_387, 20_000, 60_000]) {
      const res = await forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/msg', body: Buffer.alloc(n, 7) });
      expect([n, res.status, res.json()]).toEqual([n, 413, { error: 'too_large' }]);
    }
    expect(f.maker.seen).toHaveLength(1);
    expect(f.socks.accepted).toBe(1);
  });

  it('accepts a 60,000-byte proof and refuses 60,001 bytes (oversize.bin)', async () => {
    const f = await setup();
    expect(RELAY_LIMITS.dleqBody).toBe(60_000);
    const path = `/xs/v1/dleq/${hex64('c')}`;
    const ok = await forward(f.relay, { onion: f.onion, method: 'PUT', path, body: Buffer.alloc(60_000, 1) });
    expect(ok.json().status).toBe(204);
    expect(f.maker.seen[0]!.body.length).toBe(60_000);

    const oversize = readFileSync(new URL('dleq/oversize.bin', vectors));
    expect(oversize.length).toBe(60_001);
    const res = await forward(f.relay, { onion: f.onion, method: 'PUT', path, body: oversize });
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large' });
    expect(f.maker.seen).toHaveLength(1);
  });

  it('refuses a request body over 96 kB before reading it as JSON', async () => {
    const f = await setup();
    expect(RELAY_LIMITS.requestBody).toBe(98_304);
    const huge = JSON.stringify({ onion: f.onion, method: 'POST', path: '/xs/v1/msg', body_b64: 'A'.repeat(98_304) });
    const res = await call(f.relay.port, '/relay/v1/forward', { method: 'POST', body: huge });
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large' });
    expect(f.socks.accepted).toBe(0);
  });

  it('accepts an upstream response of 60,000 bytes and refuses a larger one', async () => {
    for (const [size, declared] of [
      [60_000, true],
      [60_001, true],
      [60_001, false],
      [5_000_000, false],
    ] as const) {
      const f = await setup({
        handler: (_req, res) => {
          if (declared) res.setHeader('content-length', String(size));
          res.writeHead(200);
          res.end(Buffer.alloc(size, 9));
        },
      });
      const res = await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' });
      if (size <= RELAY_LIMITS.upstreamResponse) {
        expect(res.status).toBe(200);
        expect(Buffer.from(res.json().body_b64, 'base64').length).toBe(size);
      } else {
        expect([size, declared, res.status, res.json()]).toEqual([size, declared, 502, { error: 'upstream_too_large' }]);
      }
      await closeAll();
    }
  });
});

describe('upstream failures', () => {
  it('times out an onion service that never answers', async () => {
    const f = await setup({ handler: () => {}, deps: { upstreamTimeoutMs: 150 } });
    const t0 = Date.now();
    const res = await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' });
    expect(res.status).toBe(504);
    expect(res.json()).toEqual({ error: 'upstream_timeout' });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('uses a 30 s upstream timeout by default', () => {
    expect(RELAY_LIMITS.upstreamTimeoutMs).toBe(30_000);
  });

  it('times out a response that stalls part way', async () => {
    const f = await setup({
      handler: (_req, res) => {
        res.writeHead(200, { 'content-length': '1000' });
        res.write('partial');
      },
      deps: { upstreamTimeoutMs: 150 },
    });
    const res = await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' });
    expect(res.json()).toEqual({ error: 'upstream_timeout' });
  });

  it('reports a listed onion that Tor cannot reach', async () => {
    const f = await setup();
    const other = fakeOnion();
    f.registry.onions.push(other);
    await f.relay.registry.refresh();
    const res = await forward(f.relay, { onion: other, method: 'GET', path: '/xs/v1/info' });
    expect(res.status).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_unreachable' });
    expect(f.socks.connects).toEqual([{ atyp: 3, host: other, port: 80 }]);
  });

  it('reports the Tor proxy being down', async () => {
    const onion = fakeOnion();
    const relay = await startTestRelay({ env: { RELAY_TOR_SOCKS: `127.0.0.1:${await closedPort()}` }, deps: { registry: fakeRegistry([onion]) } });
    const res = await forward(relay, { onion, method: 'GET', path: '/xs/v1/info' });
    expect(res.status).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_unreachable' });
  });
});
