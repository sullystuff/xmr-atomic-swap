import { ACCOUNTS, ACCOUNT_SIZE, type Maker, RELAY_LIMITS, base58Decode, base58Encode, encodeAccount } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { RegistryCache, SolanaRegistrySource, emptyRegistrySource } from '../src/index.js';
import { setup } from './fixture.js';
import { closeAll, fakeOnion, fakeRegistry, forward, startBackend, startTestRelay } from './helpers.js';

afterEach(closeAll);

const PROGRAM_ID = '5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u';
const key = (n: number): string => base58Encode(new Uint8Array(32).fill(n));

function makerAccount(n: number, onion: string): Uint8Array {
  const maker: Maker = {
    owner: key(n),
    operator: key(n + 1),
    payout: key(n + 2),
    encKey: new Uint8Array(32).fill(9),
    encKeyVersion: 1,
    prevEncKey: new Uint8Array(32),
    prevEncKeyExpiresAt: 0n,
    approvalEpoch: 0,
    quoteEpoch: 0,
    paused: 0,
    inboxPolicy: 0,
    openPending: 0,
    registeredSlot: 1n,
    registeredAt: 1n,
    ethLink: new Uint8Array(20),
    ethLinkNext: new Uint8Array(20),
    ethLinkNextAt: 0n,
    counters: new Array<number>(40).fill(0),
    responseSecsSum: 0n,
    volume: [0n, 0n],
    withheldVolume: [0n, 0n],
    bump: 255,
    onion,
    contacts: [{ kind: 0, value: 'https://maker.example' }],
  };
  return encodeAccount('Maker', maker, ACCOUNT_SIZE.Maker);
}

/** A fake Solana JSON-RPC endpoint that answers `getProgramAccounts` and records what it was asked. */
async function fakeRpc(accounts: Uint8Array[]) {
  const calls: { method: string; params: any[] }[] = [];
  const rpc = await startBackend((req, res) => {
    const body = JSON.parse(req.body.toString());
    calls.push({ method: body.method, params: body.params });
    res.setHeader('content-type', 'application/json');
    if (body.method !== 'getProgramAccounts') return void res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } }));
    const result = accounts.map((data, i) => ({
      pubkey: key(100 + i),
      account: { data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0, space: data.length },
    }));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  return { url: `http://127.0.0.1:${rpc.port}`, calls };
}

describe('Solana registry source', () => {
  it('reads maker accounts with getProgramAccounts and takes their onion fields', async () => {
    const a = fakeOnion();
    const b = fakeOnion();
    const garbage = new Uint8Array(ACCOUNT_SIZE.Maker).fill(0xff);
    garbage.set(ACCOUNTS.Maker.discriminator);
    const rpc = await fakeRpc([makerAccount(1, a), makerAccount(2, ''), makerAccount(3, b), garbage, new Uint8Array(4)]);

    const snap = await new SolanaRegistrySource(rpc.url, PROGRAM_ID).fetch();
    expect(snap).toEqual({ makers: 3, onions: [a, b] });

    expect(rpc.calls).toHaveLength(1);
    const [program, options] = rpc.calls[0]!.params;
    expect(program).toBe(PROGRAM_ID);
    // Filtered to maker accounts by their discriminator.
    expect(options.filters).toHaveLength(1);
    expect(options.filters[0].memcmp.offset).toBe(0);
    expect(base58Decode(options.filters[0].memcmp.bytes)).toEqual(ACCOUNTS.Maker.discriminator);
  });

  it('drives the relay end to end: listed onion forwarded, unlisted refused', async () => {
    const f = await setup();
    const rpc = await fakeRpc([makerAccount(1, f.onion)]);
    const relay = await startTestRelay({ env: { RELAY_TOR_SOCKS: `127.0.0.1:${f.socks.port}`, SOLANA_RPC_URL: rpc.url, RELAY_PROGRAM_ID: PROGRAM_ID } });
    expect((await forward(relay, { onion: f.onion, method: 'GET', path: '/xs/v1/info' })).json().status).toBe(200);
    expect((await forward(relay, { onion: fakeOnion(), method: 'GET', path: '/xs/v1/info' })).status).toBe(403);
    expect(rpc.calls.every((c) => c.method === 'getProgramAccounts')).toBe(true);
    expect(relay.logs.some((l) => l.includes('registry is empty'))).toBe(false);
  });

  it('with no RPC configured the registry is empty, every forward is refused and the start log says so', async () => {
    const relay = await startTestRelay();
    expect((await forward(relay, { onion: fakeOnion(), method: 'GET', path: '/xs/v1/info' })).status).toBe(403);
    expect(relay.logs.some((l) => l.includes('registry is empty and every forward is refused'))).toBe(true);
    expect(await emptyRegistrySource.fetch()).toEqual({ makers: 0, onions: [] });
  });
});

describe('registry cache', () => {
  it('reads every 60 s and on a miss, but not on every miss', async () => {
    let now = 0;
    const a = fakeOnion();
    const source = fakeRegistry([a]);
    const cache = new RegistryCache(source, { now: () => now });

    expect(await cache.isListed(a)).toBe(true);
    expect(source.fetches).toBe(1);

    // Hits inside the period cost nothing.
    now = 59_000;
    for (let i = 0; i < 20; i++) expect(await cache.isListed(a)).toBe(true);
    expect(source.fetches).toBe(1);

    // A miss re-reads the registry, so an address published a moment ago works at once.
    const b = fakeOnion();
    source.onions.push(b);
    expect(await cache.isListed(b)).toBe(true);
    expect(source.fetches).toBe(2);

    // A burst of misses does not become a burst of RPC calls.
    for (let i = 0; i < 50; i++) expect(await cache.isListed(fakeOnion())).toBe(false);
    expect(source.fetches).toBe(2);
    now += 5_000;
    expect(await cache.isListed(fakeOnion())).toBe(false);
    expect(source.fetches).toBe(3);

    // After the period the next lookup reads again, and a removed address is gone.
    source.onions = [b];
    now += 60_000;
    expect(await cache.isListed(a)).toBe(false);
    expect(await cache.isListed(b)).toBe(true);
    expect(source.fetches).toBe(4);
  });

  it('refreshes on a 60 s timer once started', async () => {
    const source = fakeRegistry([]);
    const cache = new RegistryCache(source, { refreshMs: 40 });
    cache.start();
    await new Promise((r) => setTimeout(r, 200));
    cache.stop();
    const n = source.fetches;
    expect(n).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(source.fetches).toBe(n);
    // The default period is the protocol's 60 s.
    expect(RELAY_LIMITS.registryRefreshSecs).toBe(60);
  });

  it('shares one read between concurrent lookups', async () => {
    const a = fakeOnion();
    const source = fakeRegistry([a]);
    const cache = new RegistryCache(source, { now: () => 0 });
    const results = await Promise.all(Array.from({ length: 25 }, () => cache.isListed(a)));
    expect(results.every(Boolean)).toBe(true);
    expect(source.fetches).toBe(1);
  });

  it('keeps the last list through a short RPC outage and drops it after ten minutes', async () => {
    let now = 0;
    const a = fakeOnion();
    const source = fakeRegistry([a]);
    const errors: unknown[] = [];
    const cache = new RegistryCache(source, { now: () => now, onError: (e) => errors.push(e) });
    expect(await cache.isListed(a)).toBe(true);
    expect(cache.makers).toBe(1);

    source.failing = true;
    now = 61_000;
    expect(await cache.isListed(a)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(cache.ageSecs()).toBe(61);

    now = 10 * 60_000 + 1;
    expect(await cache.isListed(a)).toBe(false);
    expect(cache.makers).toBe(0);

    source.failing = false;
    now += 5_000;
    expect(await cache.isListed(a)).toBe(true);
    expect(cache.ageSecs()).toBe(0);
  });

  it('lists nothing before the first successful read', async () => {
    const source = fakeRegistry([fakeOnion()]);
    source.failing = true;
    const cache = new RegistryCache(source, { now: () => 0 });
    expect(await cache.isListed(source.onions[0]!)).toBe(false);
    expect(cache.ageSecs()).toBe(-1);
  });
});
