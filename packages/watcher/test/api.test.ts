// The HTTP API over loopback, with the SDK's own `WatcherClient` as the caller. Requests are
// believed for what they contain and what the chain says, never for who sends them.
import { afterEach, describe, expect, it } from 'vitest';
import { SWAP_STATE } from '@xmrswap/protocol';
import { WatcherClient, WatcherRefused, sealNoticeKey, toBase64, verifyWatchAck, watchRequest } from '@xmrswap/sdk';
import { type AppSettings, type Listening, createApp, listen } from '../src/app.js';
import { createLogger } from '../src/log.js';
import type { ServiceSettings } from '../src/service.js';
import type { Store } from '../src/store.js';
import { WatcherKeys } from '../src/keys.js';
import { type World, hex, makeWorld, passes, randomRef } from './world.js';

const APP: AppSettings = { bindHost: '127.0.0.1', bindPort: 0, trustProxyHops: 0, requestsPerMinute: 1_000, registrationsPerMinute: 1_000, maxBodyBytes: 1024 };
const open: Listening[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
});

async function serve(chain: 'solana' | 'ethereum', o: { app?: Partial<AppSettings>; settings?: Partial<ServiceSettings>; debug?: boolean } = {}) {
  const w = await makeWorld(chain);
  const lines: string[] = [];
  const store = w.store();
  const svc = w.service({ store, logSink: (l) => lines.push(l), ...(o.settings ? { settings: o.settings } : {}), ...(o.debug ? { debug: true } : {}) });
  const http = await listen(createApp(svc, { ...APP, ...o.app }, createLogger(o.debug ?? false, (l) => lines.push(l)), () => w.clock.ms), { ...APP, ...o.app }, createLogger(false, (l) => lines.push(l)));
  open.push(http);
  const post = (body: unknown, raw = false) => fetch(`${http.url}/watch/v1/swaps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });
  return { w, svc, store, http, client: new WatcherClient(http.url), lines, post };
}
const request = (w: World, s: { ref: Uint8Array; noticeKey: Uint8Array }) => watchRequest({ chain: w.chain, swapRef: s.ref, noticeKey: s.noticeKey, watcherSolanaKey: w.keys.solana });
const stored = (store: Store): number => (store.db.prepare('SELECT COUNT(*) AS n FROM watches').get() as { n: number }).n;

describe.each(['solana', 'ethereum'] as const)('the API on %s', (chain) => {
  it('info names the keys; a watch is acknowledged with a signature the SDK client verifies; status says what was seen and done', async () => {
    const { w, svc, client, http } = await serve(chain);
    const info = await client.info();
    expect(info).toEqual({ solana: w.keys.solana, ethereum: w.keys.ethereum, max_swaps: 50, monero_nodes: 2 });
    const s = await w.addSwap();
    // `register` throws unless the acknowledgement verifies against the key the swap names.
    const ack = await client.register({ chain, swapRef: s.ref, noticeKey: s.noticeKey, watcherSolanaKey: info.solana });
    // Before a notice: the latest T_co the swap can have.
    expect(BigInt(ack.watching_until)).toBe(w.times.tNoteDeadline + BigInt(w.times.dC));
    expect(await client.status(s.ref)).toMatchObject({ swap_ref: hex(s.ref), chain, status: 'watching', waiting_for: 'new', freeze_decided: null, freeze_transactions: [], ended_at: null });
    await w.postNotice(s.ref, 'no-such-tx');
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    const st = (await client.status(s.ref)) as Record<string, unknown>;
    expect(st).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed', waiting_for: null, freeze_decided: { why: 'lock-not-confirmed', not_after: Number(w.times.tCo - w.times.margin) } });
    expect((st['freeze_transactions'] as unknown[]).length).toBe(1);
    // What status never says: amounts, parties, the Monero transaction, addresses, keys.
    expect(Object.keys(st).sort()).toEqual(['accepted_at', 'chain', 'ended_at', 'freeze_decided', 'freeze_transactions', 'last_checked_at', 'reason', 'status', 'swap_ref', 'waiting_for', 'watching_until']);
    // Once a notice is on record the acknowledgement promises the swap's own T_co.
    const s2 = await w.addSwap({ notice: 'good' });
    w.setTime(w.times.tNotice + 1n);
    expect(BigInt((await client.register({ chain, swapRef: s2.ref, noticeKey: s2.noticeKey, watcherSolanaKey: info.solana })).watching_until)).toBe(w.times.tCo);
    expect((await fetch(`${http.url}/watch/v1/info`)).headers.get('cache-control')).toBe('no-store');
  });

  it('the acknowledgement is returned only after the watch is on disk; posting the same request again returns it again and stores nothing new', async () => {
    const { w, store, post } = await serve(chain);
    const s = await w.addSwap();
    const first = await post(request(w, s));
    expect(first.status).toBe(200);
    const ack = await first.json();
    expect(verifyWatchAck(ack, { chain, swapRef: s.ref, watcherSolanaKey: w.keys.solana })).toBe(true);
    expect(store.getWatch(chain, hex(s.ref))).toMatchObject({ status: 'watching' });
    expect(store.keyCount(chain, hex(s.ref))).toBe(1);
    expect((await post(request(w, s))).status).toBe(200);
    expect(store.keyCount(chain, hex(s.ref))).toBe(1);
    // If the write fails there is no acknowledgement.
    const s2 = await w.addSwap();
    store.db.exec('DROP TABLE watch_keys');
    const failed = await post(request(w, s2));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'internal' });
    expect(store.getWatch(chain, hex(s2.ref))).toBe(null);
  });

  it('refuses a swap that does not name this watcher, does not exist, or is not open, and stores and spends nothing for it', async () => {
    const { w, svc, store, client, post } = await serve(chain);
    const other = new WatcherKeys(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const cases: [string, Awaited<ReturnType<World['addSwap']>>, number, string][] = [
      ['names another watcher', await w.addSwap({ watcher: chain === 'solana' ? other.solana : other.ethereum, notice: 'garbage' }), 404, 'not_watchable'],
      ['names nobody', await w.addSwap({ watcher: null, notice: 'garbage' }), 404, 'not_watchable'],
      ['no freeze window', await w.addSwap({ wZ: 0, notice: 'garbage' }), 404, 'not_watchable'],
      ['already ready', await w.addSwap({ notice: 'good', state: SWAP_STATE.READY }), 409, 'swap_ended'],
      ['already frozen', await w.addSwap({ notice: 'good', state: SWAP_STATE.FROZEN }), 409, 'swap_ended'],
      ['settled', await w.addSwap({ notice: 'good', state: SWAP_STATE.DONE }), 409, 'swap_ended'],
      // Direction B before `fund`: no watcher is named yet, whatever the request claims.
      ['pending take', await w.addSwap({ direction: 1, state: SWAP_STATE.PENDING, watcher: null }), 404, 'not_watchable'],
    ];
    for (const [name, s, status, error] of cases) {
      const res = await post(request(w, s));
      expect(res.status, name).toBe(status);
      expect((await res.json()).error, name).toBe(error);
    }
    // A reference that is not on chain at all.
    const ghost = randomRef();
    await expect(client.register({ chain, swapRef: ghost, noticeKey: new Uint8Array(32).fill(3), watcherSolanaKey: w.keys.solana })).rejects.toBeInstanceOf(WatcherRefused);
    expect(stored(store)).toBe(0);
    // Even at T_cut, with false notices everywhere, the watcher signs and sends nothing for swaps it did not accept.
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    expect(w.broadcasts).toEqual([]);
    expect(w.signedOrSimulated()).toEqual([]);
  });

  it('refuses what is not a watch request for this watcher: malformed, unsealed, sealed to another key, replayed for another swap or chain', async () => {
    const { w, store, post } = await serve(chain);
    const s = await w.addSwap();
    const t = await w.addSwap();
    const good = request(w, s);
    const otherKey = new WatcherKeys(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).solana;
    const bad: [string, unknown, string][] = [
      ['empty object', {}, 'bad_request'],
      ['null', null, 'bad_request'],
      ['an array', [1, 2, 3], 'bad_request'],
      ['a string', 'freeze everything', 'bad_request'],
      ['unknown chain', { ...good, chain: 'bitcoin' }, 'bad_request'],
      ['uppercase ref', { ...good, swap_ref: good.swap_ref.toUpperCase() }, 'bad_request'],
      ['short ref', { ...good, swap_ref: 'ab' }, 'bad_request'],
      ['numeric key', { ...good, notice_key: 7 }, 'bad_request'],
      ['raw key, not sealed', { ...good, notice_key: toBase64(s.noticeKey) }, 'bad_notice_key'],
      ['not base64', { ...good, notice_key: '%%%' }, 'bad_notice_key'],
      ['sealed to another watcher', { ...good, notice_key: toBase64(sealNoticeKey({ noticeKey: s.noticeKey, watcherSolanaKey: otherKey, chain, swapRef: s.ref })) }, 'bad_notice_key'],
      ['replayed for another swap', { ...good, swap_ref: hex(t.ref) }, 'bad_notice_key'],
      ['replayed for the other chain', { ...good, chain: chain === 'solana' ? 'ethereum' : 'solana' }, 'bad_notice_key'],
      ['prototype pollution', JSON.parse('{"__proto__":{"chain":"solana"},"constructor":{"prototype":{}}}'), 'bad_request'],
    ];
    for (const [name, body, error] of bad) {
      const res = await post(body);
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toEqual({ error });
    }
    for (const raw of ['{', '{"chain":', 'not json', '\u0000\u0001', '']) {
      const res = await post(raw, true);
      expect(res.status, JSON.stringify(raw)).toBe(400);
    }
    const big = await post({ ...good, padding: 'x'.repeat(2_000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    expect(stored(store)).toBe(0);
    // The service is still up and still accepts the real request.
    expect((await post(good)).status).toBe(200);
  });

  it('no route lists watches, and a status lookup answers alike for an unknown and a malformed reference', async () => {
    const { w, http, client } = await serve(chain);
    const s = await w.addSwap();
    await client.register({ chain, swapRef: s.ref, noticeKey: s.noticeKey, watcherSolanaKey: w.keys.solana });
    for (const p of ['/watch/v1/swaps', '/watch/v1/swaps/', '/watch/v1', '/', '/watch/v1/swaps?all=1', '/watch/v1/watches', '/metrics', '/watch/v1/swaps/%2A']) {
      const res = await fetch(`${http.url}${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.json(), p).toEqual({ error: 'not_found' });
    }
    const unknown = await fetch(`${http.url}/watch/v1/swaps/${hex(randomRef())}`);
    const malformed = await fetch(`${http.url}/watch/v1/swaps/${'Z'.repeat(64)}`);
    expect([unknown.status, malformed.status]).toEqual([404, 404]);
    expect(await unknown.text()).toBe(await malformed.text());
    // Nothing in info, health or another swap's status mentions the watched swap.
    const t = await w.addSwap();
    await client.register({ chain, swapRef: t.ref, noticeKey: t.noticeKey, watcherSolanaKey: w.keys.solana });
    for (const p of ['/watch/v1/info', '/watch/v1/health', `/watch/v1/swaps/${hex(t.ref)}`]) expect(await (await fetch(`${http.url}${p}`)).text(), p).not.toContain(hex(s.ref));
    for (const m of ['DELETE', 'PUT', 'PATCH']) expect((await fetch(`${http.url}/watch/v1/swaps/${hex(s.ref)}`, { method: m })).status, m).toBe(404);
  });

  it('refuses a new watch when the fee balance cannot cover it, when it is full, and when the window is too short, and says which', async () => {
    const { w, store, post, http } = await serve(chain, { settings: { maxSwaps: 3 } });
    const reserve = w.port.freezeReserve();
    const [a, b, c, d] = [await w.addSwap(), await w.addSwap(), await w.addSwap(), await w.addSwap()];
    // Room for exactly one watch.
    w.setBalance(reserve * 2n - 1n);
    expect((await post(request(w, a))).status).toBe(200);
    const poor = await post(request(w, b));
    expect(poor.status).toBe(503);
    expect(await poor.json()).toEqual({ error: 'insufficient_fee_balance', detail: `the watcher's ${chain} fee balance cannot cover another watch; it must be topped up` });
    expect(store.getWatch(chain, hex(b.ref))).toBe(null);
    // An existing watch can still be re-acknowledged.
    expect((await post(request(w, a))).status).toBe(200);
    const health = (await (await fetch(`${http.url}/watch/v1/health`)).json()) as { ok: boolean; chains: Record<string, Record<string, unknown>>; monero: unknown };
    expect(health.chains[chain]).toMatchObject({ reachable: true, address: w.port.address, fee_balance: (reserve * 2n - 1n).toString(), freeze_reserve: reserve.toString(), runway_freezes: 1, accepting: false });
    expect(health.monero).toEqual({ nodes: 2, reachable: 2, agreeing: true });
    expect(health.ok).toBe(false);
    w.setBalance(reserve * 100n);
    expect((await post(request(w, b))).status).toBe(200);
    expect((await post(request(w, c))).status).toBe(200);
    const full = await post(request(w, d));
    expect(full.status).toBe(503);
    expect((await full.json()).error).toBe('full');
    // Too late: less than the lead time before T_co − M, and after it.
    const { w: w2, post: post2 } = await serve(chain);
    const late = await w2.addSwap({ notice: 'no-such-tx' });
    w2.setTime(w2.times.tCo - w2.times.margin - 60n);
    expect(await (await post2(request(w2, late))).json()).toMatchObject({ error: 'too_late' });
    w2.setTime(w2.times.tCo - w2.times.margin + 1n);
    expect(await (await post2(request(w2, late))).json()).toMatchObject({ error: 'too_late' });
    w2.setTime(w2.times.tCo - w2.times.margin - 121n);
    expect((await post2(request(w2, late))).status).toBe(200);
  });

  it('an unreachable chain endpoint is a 503, never an acknowledgement; health reports it', async () => {
    const { w, store, post, http } = await serve(chain);
    const s = await w.addSwap();
    w.net.readsFail = true;
    const res = await post(request(w, s));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('chain_unavailable');
    expect(stored(store)).toBe(0);
    const health = await fetch(`${http.url}/watch/v1/health`);
    expect(health.status).toBe(503);
    expect(((await health.json()) as { chains: Record<string, { reachable: boolean }> }).chains[chain]!.reachable).toBe(false);
  });

  it('a wrong notice key posted by a stranger, before or after the locker\'s, cannot make the watcher freeze a good lock', async () => {
    for (const order of ['stranger-first', 'locker-first'] as const) {
      const { w, svc, store, post } = await serve(chain);
      const s = await w.addSwap();
      const forged = watchRequest({ chain, swapRef: s.ref, noticeKey: new Uint8Array(32).fill(0x66), watcherSolanaKey: w.keys.solana });
      for (const body of order === 'stranger-first' ? [forged, request(w, s)] : [request(w, s), forged]) expect((await post(body)).status).toBe(200);
      expect(store.keyCount(chain, hex(s.ref))).toBe(2);
      await w.postNotice(s.ref, 'good');
      w.setTime(w.times.tCut);
      await passes(svc, 3, w);
      expect(w.broadcasts, order).toEqual([]);
      expect(svc.status(hex(s.ref)), order).toMatchObject({ status: 'watching', waiting_for: 'recheck' });
      // The key that opened the notice is kept; the forged one is gone.
      expect(store.keyCount(chain, hex(s.ref))).toBe(1);
      expect(hex(w.keys.openFromStore(chain, s.ref, store.keys(chain, hex(s.ref))[0]!.sealed))).toBe(hex(s.noticeKey));
    }
    // The number of different keys per swap is capped; past it the caller is told the swap is not watched.
    const { w, post } = await serve(chain, { settings: { maxKeysPerSwap: 2 } });
    const s = await w.addSwap();
    for (const fill of [1, 2]) expect((await post(watchRequest({ chain, swapRef: s.ref, noticeKey: new Uint8Array(32).fill(fill), watcherSolanaKey: w.keys.solana }))).status).toBe(200);
    const third = await post(request(w, s));
    expect(third.status).toBe(409);
    expect((await third.json()).error).toBe('too_many_keys');
  });

  it('per-IP rate limits: requests in general, and registrations more tightly', async () => {
    const { w, post, http } = await serve(chain, { app: { requestsPerMinute: 6, registrationsPerMinute: 2 } });
    const s = await w.addSwap();
    expect((await post(request(w, s))).status).toBe(200);
    expect((await post({})).status).toBe(400);
    const limited = await post(request(w, s));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) expect((await fetch(`${http.url}/watch/v1/info`)).status).toBe(200);
    expect((await fetch(`${http.url}/watch/v1/info`)).status).toBe(429);
    // A minute later the window is new.
    w.clock.ms += 60_001;
    expect((await fetch(`${http.url}/watch/v1/info`)).status).toBe(200);
  });

  it('never logs a request body, a notice key or a sealed key, at any log level; swap references only in debug', async () => {
    for (const debug of [false, true]) {
      const { w, svc, lines, post } = await serve(chain, { debug });
      const s = await w.addSwap();
      const body = request(w, s);
      await post(body);
      await post({ ...body, notice_key: toBase64(s.noticeKey) });
      await post('{"chain":"solana","swap_ref":"zz', true);
      await w.postNotice(s.ref, 'no-such-tx');
      w.setTime(w.times.tCut);
      w.net.broadcastFails = true;
      await passes(svc, 2, w);
      w.net.broadcastFails = false;
      await passes(svc, 3, w);
      const log = lines.join('\n');
      expect(log).toContain('watch accepted');
      expect(log).toContain('freeze sent');
      for (const secret of [hex(s.noticeKey), toBase64(s.noticeKey), body.notice_key, 'ECONNREFUSED']) expect(log, `debug=${debug}`).not.toContain(secret);
      expect(log.includes(hex(s.ref))).toBe(debug);
    }
  });
});
