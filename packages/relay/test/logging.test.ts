import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_WARNING } from '../src/index.js';
import { setup } from './fixture.js';
import { call, closeAll, closedPort, fakeOnion, forward, hex64, startBackend } from './helpers.js';

// Vitest sets NODE_ENV=test, under which express prints nothing for an unhandled error. Run as
// a real deployment would, so a stack trace written by express would be caught here.
const savedEnv = process.env['NODE_ENV'];
beforeEach(() => {
  process.env['NODE_ENV'] = 'development';
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = savedEnv;
  await closeAll();
});

const CLIENT_IP = '127.0.0.77';
const SECRET = 'PLAINTEXT-MARKER-7f3a9c';
const TX = 'TXHEX-MARKER-55aa55aa';

/** Record everything the process writes to stdout, stderr or the console. */
function captureOutput(): { text: () => string } {
  const out: string[] = [];
  const grab = (...args: unknown[]): boolean => {
    out.push(args.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : typeof a === 'string' ? a : a instanceof Error ? `${a.stack}` : JSON.stringify(a))).join(' '));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, m).mockImplementation(grab as never);
  return { text: () => out.join('\n') };
}

/** Exercise every kind of request: successes, refusals, upstream failures, parser errors. */
async function traffic(f: Awaited<ReturnType<typeof setup>>): Promise<{ unlisted: string }> {
  const from = { localAddress: CLIENT_IP };
  const body = Buffer.from(`${SECRET} ${'x'.repeat(200)}`);
  const unlisted = fakeOnion();
  expect((await forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/msg', body }, from)).json().status).toBe(200);
  expect((await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' }, from)).status).toBe(200);
  expect((await forward(f.relay, { onion: f.onion, method: 'PUT', path: `/xs/v1/dleq/${hex64('e')}`, body }, from)).status).toBe(200);
  expect((await forward(f.relay, { onion: unlisted, method: 'POST', path: '/xs/v1/msg', body }, from)).status).toBe(403);
  expect((await forward(f.relay, { onion: 'example.com', method: 'POST', path: '/xs/v1/msg', body }, from)).status).toBe(400);
  expect((await forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/admin', body }, from)).status).toBe(400);
  expect((await forward(f.relay, { onion: f.onion, method: 'POST', path: '/xs/v1/msg', body: Buffer.alloc(20_000, 0x41) }, from)).status).toBe(413);
  // Upstream failure: listed, but nothing answers for it.
  const dead = fakeOnion();
  f.registry.onions.push(dead);
  await f.relay.registry.refresh();
  expect((await forward(f.relay, { onion: dead, method: 'POST', path: '/xs/v1/msg', body }, from)).status).toBe(502);
  // Parser errors and an over-limit body.
  expect((await call(f.relay.port, '/relay/v1/forward', { method: 'POST', body: `{"onion":"${f.onion}","x":"${SECRET}`, ...from })).status).toBe(400);
  expect((await call(f.relay.port, '/relay/v1/forward', { method: 'POST', body: Buffer.alloc(120_000, 0x41), ...from })).status).toBe(413);
  expect((await call(f.relay.port, `/nowhere/${SECRET}`, from)).status).toBe(404);
  // Monero proxy: a relayed transaction, a refused method, a node that fails.
  expect((await call(f.relay.port, '/monero/0/send_raw_transaction', { method: 'POST', body: JSON.stringify({ tx_as_hex: TX }), ...from })).status).toBe(200);
  expect((await call(f.relay.port, '/monero/0/json_rpc', { method: 'POST', body: JSON.stringify({ method: 'stop_daemon', note: SECRET }), ...from })).status).toBe(403);
  expect((await call(f.relay.port, '/monero/1/get_height', { method: 'POST', body: '', ...from })).status).toBe(502);
  expect((await call(f.relay.port, '/relay/v1/status', from)).status).toBe(200);
  return { unlisted };
}

async function start(debug: boolean) {
  const node = await startBackend((_req, res) => res.end('{"status":"OK"}'));
  const f = await setup({
    env: { RELAY_MONERO_NODES: `http://127.0.0.1:${node.port},http://127.0.0.1:${await closedPort()}`, RELAY_DEBUG_LOG: debug ? 'true' : 'false' },
    captureLogs: false, // the default sink (stdout), exactly as in production
  });
  return { f };
}

describe('no message logs by default', () => {
  it('writes no body, no onion address and no client IP at the default log level', async () => {
    const cap = captureOutput();
    const { f } = await start(false);
    const { unlisted } = await traffic(f);

    // Push one address over its limit as well.
    for (let i = 0; i < 70; i++) await call(f.relay.port, '/relay/v1/status', { localAddress: CLIENT_IP });
    expect((await call(f.relay.port, '/relay/v1/status', { localAddress: CLIENT_IP })).status).toBe(429);
    // A failing registry read is reported without its reason.
    f.registry.failing = true;
    await f.relay.registry.refresh();
    await f.relay.close();

    const text = cap.text();
    // The capture works: the start line is there.
    expect(text).toContain(`[relay] listening on 127.0.0.1:${f.relay.port}`);
    expect(text).toContain('registry refresh failed');
    expect(text).not.toContain('rpc down');

    const b64 = (s: string): string[] => [0, 1, 2].map((pad) => Buffer.from(' '.repeat(pad) + s).toString('base64').slice(4, -4));
    for (const forbidden of [
      SECRET,
      ...b64(SECRET),
      Buffer.from(SECRET).toString('hex'),
      TX,
      'reply:',
      f.onion,
      unlisted,
      ...f.registry.onions,
      '.onion',
      'example.com',
      CLIENT_IP,
      '/xs/v1',
      'send_raw_transaction',
      'stop_daemon',
    ])
      expect(text.includes(forbidden), `output contains ${forbidden}`).toBe(false);

    // Nothing is logged per request at all: the only lines are the start-up line and the registry failure.
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    expect(text).not.toContain('WARNING');
  });

  it('the debug flag logs destination and client address, never bodies, and warns at start', async () => {
    const cap = captureOutput();
    const { f } = await start(true);
    await traffic(f);
    await f.relay.close();
    const text = cap.text();

    expect(text).toContain(DEBUG_WARNING);
    expect(DEBUG_WARNING).toMatch(/^WARNING: debug logging is ON/);
    // The warning is printed at start, before any request line.
    expect(text.indexOf(DEBUG_WARNING)).toBeLessThan(text.indexOf('[relay:debug]'));
    expect(text).toContain(`forward ip=${CLIENT_IP} onion=${f.onion} POST /xs/v1/msg`);
    expect(text).toContain(`monero ip=${CLIENT_IP} node=0 /send_raw_transaction`);
    for (const forbidden of [SECRET, Buffer.from(SECRET).toString('base64').slice(0, 20), TX, 'reply:']) expect(text.includes(forbidden), forbidden).toBe(false);
  });

  it('keeps no request data in memory beyond the rate-limit window', async () => {
    let now = 0;
    const f = await setup({ deps: { now: () => now } });
    await forward(f.relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' }, { localAddress: CLIENT_IP });
    expect(f.relay.limiter.tracked).toBe(1);
    now = 60_000;
    await call(f.relay.port, '/relay/v1/status');
    // The first address is gone; only the caller of the last request is tracked.
    expect(f.relay.limiter.tracked).toBe(1);
  });
});
