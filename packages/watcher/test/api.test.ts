// The HTTP API over loopback, with the SDK's own `WatcherClient` as the caller. Requests are
// believed for what they contain and what the chain says, never for who sends them.
import { afterEach, describe, expect, it } from 'vitest';
import { SWAP_STATE } from '@xmrswap/protocol';
import { WatcherClient, WatcherRefused, toBase64, verifyWatchAck, watchDeployment } from '@xmrswap/sdk';
import { type AppSettings, type Listening, createApp, listen } from '../src/app.js';
import { createLogger } from '../src/log.js';
import type { ServiceSettings } from '../src/service.js';
import type { Store } from '../src/store.js';
import { WatcherKeys } from '../src/keys.js';
import { CONTRACT, ENC, type World, type WorldSwap, hex, makeWorld, passes, randomRef, unhex } from './world.js';

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
const request = (_w: World, s: WorldSwap) => s.request();
const stored = (store: Store): number => (store.db.prepare('SELECT COUNT(*) AS n FROM watches').get() as { n: number }).n;

describe.each(['solana', 'ethereum'] as const)('the API on %s', (chain) => {
  it('info names the keys; a watch is acknowledged with a signature the SDK client verifies; status says what was seen and done', async () => {
    const { w, svc, client, http } = await serve(chain);
    const info = await client.info();
    expect(info).toEqual({ solana: w.keys.solana, ethereum: w.keys.ethereum, max_swaps: 50, monero_nodes: 2 });
    const s = await w.addSwap();
    // `register` throws unless the acknowledgement verifies against the key the swap names.
    const ack = await client.register(s.args());
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
    expect(BigInt((await client.register(s2.args())).watching_until)).toBe(w.times.tCo);
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
    await expect(client.register({ chain, swapRef: ghost, noticeKey: new Uint8Array(32).fill(3), watcherSolanaKey: w.keys.solana, lockerEncSecret: new Uint8Array(32).fill(5), deployment: w.port.deployment, issuedAt: w.now() })).rejects.toMatchObject({ status: 404 });
    await expect(client.register({ chain, swapRef: ghost, noticeKey: new Uint8Array(32).fill(3), watcherSolanaKey: w.keys.solana, lockerEncSecret: new Uint8Array(32).fill(5), deployment: w.port.deployment, issuedAt: w.now() })).rejects.toBeInstanceOf(WatcherRefused);
    expect(stored(store)).toBe(0);
    // Even at T_cut, with false notices everywhere, the watcher signs and sends nothing for swaps it did not accept.
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    expect(w.broadcasts).toEqual([]);
    expect(w.signedOrSimulated()).toEqual([]);
  });

  it('refuses what is not a watch request for this watcher: malformed, format 1, unsealed, another deployment, sealed to another watcher, replayed for another swap or chain', async () => {
    const { w, store, post } = await serve(chain);
    const s = await w.addSwap();
    const t = await w.addSwap();
    const good = request(w, s);
    expect(good).toMatchObject({ v: 2, chain, swap_ref: hex(s.ref), deployment: w.port.deployment, issued_at: Number(w.now()) });
    const otherKey = new WatcherKeys(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).solana;
    const { v: _v, deployment: _d, issued_at: _i, ...format1 } = good;
    const otherDeployment = chain === 'solana' ? watchDeployment({ programId: otherKey }) : watchDeployment({ chainId: 1, contract: CONTRACT });
    const bad: [string, unknown, number, string][] = [
      ['empty object', {}, 400, 'unsupported_format'],
      ['null', null, 400, 'bad_request'],
      ['an array', [1, 2, 3], 400, 'unsupported_format'],
      ['a string', 'freeze everything', 400, 'bad_request'],
      // The unauthenticated format of the first release: refused outright, whatever it holds.
      ['format 1', format1, 400, 'unsupported_format'],
      ['a format from the future', { ...good, v: 3 }, 400, 'unsupported_format'],
      ['unknown chain', { ...good, chain: 'bitcoin' }, 400, 'bad_request'],
      ['uppercase ref', { ...good, swap_ref: good.swap_ref.toUpperCase() }, 400, 'bad_request'],
      ['short ref', { ...good, swap_ref: 'ab' }, 400, 'bad_request'],
      ['numeric key', { ...good, notice_key: 7 }, 400, 'bad_request'],
      ['issued_at as text', { ...good, issued_at: String(good.issued_at) }, 400, 'bad_request'],
      ['negative issued_at', { ...good, issued_at: -1 }, 400, 'bad_request'],
      ['not base64', { ...good, notice_key: '%%%' }, 400, 'bad_notice_key'],
      // Bound to another program or contract: refused before the chain is even read.
      ['another deployment, relabelled', { ...good, deployment: otherDeployment }, 400, 'wrong_deployment'],
      ['another deployment, sealed for it', s.request({ deployment: otherDeployment }), 400, 'wrong_deployment'],
      // From here on the swap is read and the seal is checked against the locker key it records.
      ['raw key, not sealed', { ...good, notice_key: toBase64(s.noticeKey) }, 403, 'not_the_locker'],
      ['sealed to another watcher', s.request({ watcherSolanaKey: otherKey }), 403, 'not_the_locker'],
      ['replayed for another swap', { ...good, swap_ref: hex(t.ref) }, 403, 'not_the_locker'],
      ['issued_at altered', { ...good, issued_at: good.issued_at + 1 }, 403, 'not_the_locker'],
      ['one bit of the seal flipped', { ...good, notice_key: toBase64(Uint8Array.from(Buffer.from(good.notice_key, 'base64'), (x, i) => (i === 80 ? x ^ 1 : x))) }, 403, 'not_the_locker'],
      ['prototype pollution', JSON.parse('{"__proto__":{"chain":"solana"},"constructor":{"prototype":{}}}'), 400, 'unsupported_format'],
    ];
    for (const [name, body, status, error] of bad) {
      const res = await post(body);
      expect(res.status, name).toBe(status);
      expect((await res.json()).error, name).toBe(error);
    }
    // The other chain: this instance does not serve it.
    const otherChain = await post({ ...good, chain: chain === 'solana' ? 'ethereum' : 'solana' });
    expect([otherChain.status, (await otherChain.json()).error]).toEqual([400, 'chain_not_served']);
    for (const raw of ['{', '{"chain":', 'not json', '\u0000\u0001', '']) {
      const res = await post(raw, true);
      expect(res.status, JSON.stringify(raw)).toBe(400);
    }
    const big = await post({ ...good, padding: 'x'.repeat(2_000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    expect(stored(store)).toBe(0);
    expect(w.signedOrSimulated()).toEqual([]);
    // The service is still up and still accepts the real request.
    expect((await post(good)).status).toBe(200);
  });

  it('no route lists watches, and a status lookup answers alike for an unknown and a malformed reference', async () => {
    const { w, http, client } = await serve(chain);
    const s = await w.addSwap();
    await client.register(s.args());
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
    await client.register(t.args());
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

  it('only the swap\'s locker can register it: a stranger, a stranger flooding first, and the counterparty are all rejected, with nothing stored and nothing spent', async () => {
    const { w, svc, store, post } = await serve(chain);
    const s = await w.addSwap();
    const balance = await w.port.balance();
    const strangerSecret = new Uint8Array(32).fill(0x33);
    const attempts: [string, unknown][] = [
      // A stranger posts a wrong key, sealed correctly to this watcher for this swap, with its own secret.
      ['stranger, wrong key', s.request({ noticeKey: new Uint8Array(32).fill(0x66), lockerEncSecret: strangerSecret })],
      // A stranger who somehow has the right notice key still is not the locker.
      ['stranger, right key', s.request({ lockerEncSecret: strangerSecret })],
      // The counterparty knows K("notice") (it seals the notice with it) and holds the other encryption secret of the swap.
      ['counterparty, right key', s.request({ lockerEncSecret: s.claimerEncSecret })],
      ['counterparty, wrong key', s.request({ noticeKey: new Uint8Array(32).fill(0x67), lockerEncSecret: s.claimerEncSecret })],
    ];
    for (const [name, body] of attempts) {
      const res = await post(body);
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toEqual({ error: 'not_the_locker', detail: "the request was not made by this swap's locker for this watcher and swap" });
    }
    // A stranger flooding the swap with keys before the locker arrives: there are no slots to fill.
    for (let i = 1; i <= 12; i++) expect((await post(s.request({ noticeKey: new Uint8Array(32).fill(i), lockerEncSecret: new Uint8Array(32).fill(0x80 + i) }))).status).toBe(403);
    expect(stored(store)).toBe(0);
    expect(store.keyCount(chain, hex(s.ref))).toBe(0);
    // The locker's own request is accepted afterwards as if nothing had happened.
    expect((await post(request(w, s))).status).toBe(200);
    expect(store.keyCount(chain, hex(s.ref))).toBe(1);
    // And after it, the same attempts change nothing: one key, the locker's.
    for (const [name, body] of attempts) expect((await post(body)).status, name).toBe(403);
    expect(store.keyCount(chain, hex(s.ref))).toBe(1);
    expect(hex(w.keys.openFromStore(chain, s.ref, store.key(chain, hex(s.ref))!.sealed))).toBe(hex(s.noticeKey));
    // The lock is good: nobody's request made the watcher freeze it, or spend anything.
    await w.postNotice(s.ref, 'good');
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    expect(w.broadcasts).toEqual([]);
    expect(w.signedOrSimulated()).toEqual([]);
    expect(svc.status(hex(s.ref))).toMatchObject({ status: 'watching', waiting_for: 'recheck' });
    expect(await w.port.balance()).toBe(balance);

    // A swap whose locker never registered is not watched at all, whatever strangers post: no freeze, even of a false notice.
    const { w: w2, svc: svc2, store: store2, post: post2 } = await serve(chain);
    const u = await w2.addSwap({ notice: 'good' });
    expect((await post2(u.request({ noticeKey: new Uint8Array(32).fill(0x66), lockerEncSecret: strangerSecret }))).status).toBe(403);
    w2.setTime(w2.times.tCut);
    await passes(svc2, 3, w2);
    expect(stored(store2)).toBe(0);
    expect(w2.signedOrSimulated()).toEqual([]);
    // Direction B: the locker is the maker; the taker (the counterparty there) is rejected.
    const b = await w2.addSwap({ direction: 1 });
    expect(hex(b.lockerEncSecret)).toBe(ENC.maker_secret);
    expect((await post2(b.request({ lockerEncSecret: unhex(ENC.taker_secret) }))).status).toBe(403);
    expect((await post2(b.request())).status).toBe(200);
  });

  it('freshness and replay: the same request twice is one watch; an older one after a newer one is refused; stale, future-dated and pre-lock requests are refused', async () => {
    const { w, store, post } = await serve(chain);
    const s = await w.addSwap();
    w.setTime(w.now() + 300n);
    const first = s.request();
    const a1 = await post(first);
    const a2 = await post(first);
    expect([a1.status, a2.status]).toEqual([200, 200]);
    // Idempotent: the same acknowledgement, one row, one key.
    expect(await a2.json()).toEqual(await a1.json());
    expect(stored(store)).toBe(1);
    expect(store.key(chain, hex(s.ref))!.issued_at).toBe(Number(w.now()));
    // A newer request from the locker replaces the one on file.
    w.setTime(w.now() + 60n);
    const newer = s.request();
    expect((await post(newer)).status).toBe(200);
    expect(store.key(chain, hex(s.ref))!.issued_at).toBe(Number(w.now()));
    // The older one, replayed now (it is authentic and still fresh), is refused; the newer one stands.
    const replayed = await post(first);
    expect(replayed.status).toBe(409);
    expect((await replayed.json()).error).toBe('superseded');
    expect(store.key(chain, hex(s.ref))!.issued_at).toBe(Number(w.now()));
    expect((await post(newer)).status).toBe(200);
    expect(stored(store)).toBe(1);

    // Freshness, against the chain clock the service reads and the swap's own lock time.
    const t = await w.addSwap();
    const now = w.now();
    const stale = async (issuedAt: bigint): Promise<[number, string]> => {
      const res = await post(t.request({ issuedAt }));
      return [res.status, (await res.json()).error];
    };
    // Dated before the swap was locked (beyond the skew): made for some earlier incarnation of the reference.
    expect(await stale(1_800_000_000n - 1_801n)).toEqual([400, 'stale_request']);
    // Dated ahead of the chain clock beyond the skew.
    expect(await stale(now + 1_801n)).toEqual([400, 'stale_request']);
    expect(stored(store)).toBe(1);
    // An hour and a second old: too old. Exactly an hour: accepted.
    const old = t.request();
    w.setTime(now + 3_601n);
    expect((await post(old)).status).toBe(400);
    w.setTime(now + 3_600n);
    expect((await post(old)).status).toBe(200);
    // Within the skew ahead: accepted (the finalized clock the service reads runs behind the client's).
    const v = await w.addSwap();
    expect((await post(v.request({ issuedAt: w.now() + 1_800n }))).status).toBe(200);
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
