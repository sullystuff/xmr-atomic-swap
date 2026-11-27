// The watcher protocol (SPEC 11.6): the notice key a locker hands over, sealed to the watcher's
// key; the keyed open of a notice; the signed acknowledgement; the HTTP client; and the facts a
// watcher gathers with view data only. Vectors: notice.json, monero_tx.json.
import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { init } from '@xmrswap/core-wasm';
import { SWAP_FLAG, SWAP_STATE, base58Encode } from '@xmrswap/protocol';
import { buildNotice, openNotice } from '../src/flows/keys.js';
import { NO_SWAP } from '../src/machine/model.js';
import type { SwapView } from '../src/machine/view.js';
import type { HttpFetch } from '../src/messages/transports.js';
import { FakeMoneroNode, type FakeTx } from '../src/testing/monero.js';
import { codeOf, fromBase64, hex, toBase64, unhex } from '../src/util.js';
import {
  SEALED_NOTICE_KEY_LEN,
  WATCH_ROUTES,
  WatcherClient,
  WatcherRefused,
  noticeKey,
  noticeKeyFor,
  openNoticeWithKey,
  openSealedNoticeKey,
  openWatchRequest,
  parseWatchInfo,
  sealNoticeKey,
  signWatchAck,
  verifyWatchAck,
  watchAckBytes,
  watchRequest,
} from '../src/watcher/protocol.js';
import { watcherFacts, watcherStep } from '../src/watcher/step.js';
import { rng, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const r = rng(77);
const v = vector('notice');
const k = v.keys;
const z32 = new Uint8Array(32);
function baseView(over: Partial<SwapView>): SwapView {
  return {
    ...NO_SWAP,
    chain: 'solana',
    swapRef: z32,
    taker: '',
    maker: '',
    asset: '0',
    xmr: 0n,
    price: 0n,
    depBps: 0,
    swapNonce: new Uint8Array(16),
    sessionKey: '',
    takerEncKey: unhex(k.taker_pub),
    makerEncVersion: 1,
    makerEncKey: unhex(k.maker_pub),
    takerSpendPub: z32,
    makerSpendPub: z32,
    lockerView: z32,
    noticeCommitment: z32,
    noticeCt: new Uint8Array(0),
    evidenceTxid: z32,
    evidenceView: z32,
    revealed: z32,
    payoutAddress: null,
    watcherAddress: null,
    ...over,
  };
}

// The watcher's keys: one Ed25519 seed; its public key is the Solana key of /watch/v1/info.
const watcherSeed = r.bytes(32);
const watcherKey = base58Encode(ed25519.getPublicKey(watcherSeed));
const otherSeed = r.bytes(32);
const otherKey = base58Encode(ed25519.getPublicKey(otherSeed));

describe('the notice key K("notice")', () => {
  it('is the same key from either side of the swap, and differs per pair', () => {
    const fromTaker = noticeKeyFor({ side: 'taker', ownEncSecret: unhex(k.taker_secret), peerEncPub: unhex(k.maker_pub) });
    const fromMaker = noticeKeyFor({ side: 'maker', ownEncSecret: unhex(k.maker_secret), peerEncPub: unhex(k.taker_pub) });
    expect(hex(fromTaker)).toBe(hex(fromMaker));
    expect(fromTaker.length).toBe(32);
    // The roles are part of the derivation: the same pair with the roles swapped is another key.
    expect(hex(noticeKeyFor({ side: 'maker', ownEncSecret: unhex(k.taker_secret), peerEncPub: unhex(k.maker_pub) }))).not.toBe(hex(fromTaker));
    expect(hex(noticeKeyFor({ side: 'taker', ownEncSecret: r.bytes(32), peerEncPub: unhex(k.maker_pub) }))).not.toBe(hex(fromTaker));
    // The locker's helper: the taker in A, the maker in B.
    expect(hex(noticeKey(baseView({ direction: 0 }), unhex(k.taker_secret)))).toBe(hex(fromTaker));
    expect(hex(noticeKey(baseView({ direction: 1 }), unhex(k.maker_secret)))).toBe(hex(fromTaker));
    const low = unhex(vector('points').low_order_x25519[4].key);
    expect(codeOf(() => noticeKeyFor({ side: 'taker', ownEncSecret: unhex(k.taker_secret), peerEncPub: low }))).toBe('LowOrderEncryptionKey');
    expect(codeOf(() => noticeKeyFor({ side: 'taker', ownEncSecret: new Uint8Array(31), peerEncPub: unhex(k.maker_pub) }))).toBe('BadKey');
  });

  it('opens every valid notice of notice.json with the key alone, exactly as the locker does with its secret', () => {
    const key = noticeKeyFor({ side: 'taker', ownEncSecret: unhex(k.taker_secret), peerEncPub: unhex(k.maker_pub) });
    let n = 0;
    for (const c of v.cases.filter((c: any) => c.valid && c.input.sealed_by)) {
      const byMaker = c.input.sealed_by === 'maker';
      const s = baseView({ direction: byMaker ? 0 : 1, swapRef: unhex(c.input.swap_ref), flags: SWAP_FLAG.NOTICE, noticeCommitment: unhex(c.output.commitment), noticeCt: unhex(c.output.ciphertext) });
      const viaKey = openNoticeWithKey(s, key);
      const viaSecret = openNotice(s, unhex(byMaker ? k.taker_secret : k.maker_secret));
      expect(viaKey && hex(viaKey.txid), c.name).toBe(c.input.txid);
      expect(viaKey && hex(viaKey.view), c.name).toBe(c.input.view);
      expect(viaKey).toEqual(viaSecret);
      // A notice the core seals now (fresh nonce) opens too.
      const built = buildNotice(s, unhex(byMaker ? k.maker_secret : k.taker_secret), unhex(c.input.txid), unhex(c.input.view));
      expect(openNoticeWithKey({ ...s, noticeCommitment: built.commitment, noticeCt: built.ciphertext }, key)).toEqual(viaSecret);
      n++;
    }
    expect(n).toBe(3);
  });

  it('treats every tampered or mismatching notice, and a wrong key, as "no lock"', () => {
    const key = noticeKeyFor({ side: 'taker', ownEncSecret: unhex(k.taker_secret), peerEncPub: unhex(k.maker_pub) });
    const bad = v.cases.filter((c: any) => !c.valid);
    expect(bad.length).toBe(7);
    for (const c of bad) {
      const s = baseView({ direction: c.input.opened_by === 'taker' ? 0 : 1, swapRef: unhex(c.input.swap_ref), flags: SWAP_FLAG.NOTICE, noticeCommitment: unhex(c.input.commitment), noticeCt: unhex(c.input.ciphertext) });
      expect(openNoticeWithKey(s, key), c.name).toBe(null);
    }
    const c = v.cases[1];
    const good = baseView({ direction: 0, swapRef: unhex(c.input.swap_ref), flags: SWAP_FLAG.NOTICE, noticeCommitment: unhex(c.output.commitment), noticeCt: unhex(c.output.ciphertext) });
    expect(openNoticeWithKey(good, key)).not.toBe(null);
    expect(openNoticeWithKey(good, r.bytes(32))).toBe(null);
    // No notice on record.
    expect(openNoticeWithKey({ ...good, flags: 0 }, key)).toBe(null);
    expect(codeOf(() => openNoticeWithKey(good, new Uint8Array(16)))).toBe('BadKey');
  });
});

describe('what the locker sends a watcher', () => {
  const key = r.bytes(32);
  const swapRef = r.bytes(32);

  it('seals the notice key to the watcher, bound to the chain and the swap', () => {
    for (const chain of ['solana', 'ethereum'] as const) {
      const sealed = sealNoticeKey({ noticeKey: key, watcherSolanaKey: watcherKey, chain, swapRef });
      expect(sealed.length).toBe(SEALED_NOTICE_KEY_LEN);
      expect(hex(sealed)).not.toContain(hex(key));
      expect(hex(openSealedNoticeKey({ sealed, watcherSeed, chain, swapRef }))).toBe(hex(key));
      // Fresh randomness every time.
      expect(hex(sealNoticeKey({ noticeKey: key, watcherSolanaKey: watcherKey, chain, swapRef }))).not.toBe(hex(sealed));
      // Another watcher, another swap, the other chain, a flipped bit, a short body: all refused.
      expect(codeOf(() => openSealedNoticeKey({ sealed, watcherSeed: otherSeed, chain, swapRef }))).toBe('WatchKeyInvalid');
      expect(codeOf(() => openSealedNoticeKey({ sealed, watcherSeed, chain, swapRef: r.bytes(32) }))).toBe('WatchKeyInvalid');
      expect(codeOf(() => openSealedNoticeKey({ sealed, watcherSeed, chain: chain === 'solana' ? 'ethereum' : 'solana', swapRef }))).toBe('WatchKeyInvalid');
      for (const at of [0, 40, 70, 103]) {
        const t = sealed.slice();
        t[at]! ^= 1;
        expect(codeOf(() => openSealedNoticeKey({ sealed: t, watcherSeed, chain, swapRef })), `bit at ${at}`).toBe('WatchKeyInvalid');
      }
      expect(codeOf(() => openSealedNoticeKey({ sealed: sealed.subarray(1), watcherSeed, chain, swapRef }))).toBe('WatchKeyInvalid');
    }
    // Deterministic when the randomness is given (for a vector of the service's own tests).
    const fixed = { noticeKey: key, watcherSolanaKey: watcherKey, chain: 'solana' as const, swapRef, ephemeralSecret: r.bytes(32), nonce: r.bytes(24) };
    expect(hex(sealNoticeKey(fixed))).toBe(hex(sealNoticeKey(fixed)));
    expect(codeOf(() => sealNoticeKey({ noticeKey: key, watcherSolanaKey: 'short', chain: 'solana', swapRef }))).toBe('BadKey');
    expect(codeOf(() => sealNoticeKey({ noticeKey: new Uint8Array(31), watcherSolanaKey: watcherKey, chain: 'solana', swapRef }))).toBe('BadKey');
  });

  it('the request body carries the sealed key only; the service recovers it, and refuses a body for another watcher', () => {
    const req = watchRequest({ chain: 'ethereum', swapRef, noticeKey: key, watcherSolanaKey: watcherKey });
    expect(Object.keys(req).sort()).toEqual(['chain', 'notice_key', 'swap_ref']);
    expect(req.swap_ref).toBe(hex(swapRef));
    expect(fromBase64(req.notice_key).length).toBe(104);
    const text = JSON.stringify(req);
    expect(text).not.toContain(hex(key));
    expect(text).not.toContain(toBase64(key));
    const opened = openWatchRequest(JSON.parse(text), watcherSeed);
    expect(opened.chain).toBe('ethereum');
    expect(hex(opened.swapRef)).toBe(hex(swapRef));
    expect(hex(opened.noticeKey)).toBe(hex(key));
    expect(codeOf(() => openWatchRequest(JSON.parse(text), otherSeed))).toBe('WatchKeyInvalid');
    // A request replayed for another swap, or relabelled to the other chain, does not open.
    expect(codeOf(() => openWatchRequest({ ...req, swap_ref: hex(r.bytes(32)) }, watcherSeed))).toBe('WatchKeyInvalid');
    expect(codeOf(() => openWatchRequest({ ...req, chain: 'solana' }, watcherSeed))).toBe('WatchKeyInvalid');
    for (const bad of [null, {}, { ...req, chain: 'bitcoin' }, { ...req, swap_ref: 'zz' }, { ...req, notice_key: 5 }]) expect(codeOf(() => openWatchRequest(bad, watcherSeed))).toBe('bad_request');
    expect(codeOf(() => openWatchRequest({ ...req, notice_key: toBase64(r.bytes(50)) }, watcherSeed))).toBe('WatchKeyInvalid');
  });

  it('accepts an acknowledgement only from the watcher the swap names, for this swap and chain', () => {
    const want = { chain: 'solana' as const, swapRef, watcherSolanaKey: watcherKey };
    const ack = signWatchAck({ chain: 'solana', swapRef, watchingUntil: 1_800_010_000n, watcherSeed });
    expect(ack).toMatchObject({ swap_ref: hex(swapRef), watching_until: 1_800_010_000 });
    expect(verifyWatchAck(ack, want)).toBe(true);
    expect(watchAckBytes('solana', swapRef, 5n).length).toBe('xmrswap/v1/watch-ack'.length + 1 + 1 + 32 + 8);
    // A malicious or wrong watcher: signed by another key, for another swap, for the other chain, or altered afterwards.
    expect(verifyWatchAck(signWatchAck({ chain: 'solana', swapRef, watchingUntil: 1_800_010_000n, watcherSeed: otherSeed }), want)).toBe(false);
    expect(verifyWatchAck(signWatchAck({ chain: 'solana', swapRef: r.bytes(32), watchingUntil: 1_800_010_000n, watcherSeed }), want)).toBe(false);
    expect(verifyWatchAck(signWatchAck({ chain: 'ethereum', swapRef, watchingUntil: 1_800_010_000n, watcherSeed }), want)).toBe(false);
    expect(verifyWatchAck({ ...ack, watching_until: ack.watching_until + 86_400 }, want)).toBe(false);
    expect(verifyWatchAck({ ...ack, sig: toBase64(r.bytes(64)) }, want)).toBe(false);
    expect(verifyWatchAck(ack, { ...want, watcherSolanaKey: otherKey })).toBe(false);
    for (const bad of [null, {}, 'ok', { swap_ref: hex(swapRef) }, { ...ack, sig: '***' }, { ...ack, watching_until: -1 }, { ...ack, watching_until: '1800010000' }]) expect(verifyWatchAck(bad, want)).toBe(false);
  });
});

describe('WatcherClient', () => {
  const swapRef = r.bytes(32);
  const key = r.bytes(32);
  const info = { solana: watcherKey, ethereum: '0x00000000000000000000000000000000000000Aa', max_swaps: 100, monero_nodes: 2 };
  /** A watcher service in a function: answers the three routes; `ackSeed` signs the acknowledgement. */
  function service(o: { ackSeed?: Uint8Array; status?: number; info?: unknown; ack?: (body: any) => unknown } = {}) {
    const seen: { url: string; method: string; body?: string }[] = [];
    const fetchFn: HttpFetch = async (url, init) => {
      seen.push({ url, method: init.method, ...(typeof init.body === 'string' ? { body: init.body } : {}) });
      const reply = (status: number, j: unknown) => ({ status, arrayBuffer: async () => new TextEncoder().encode(typeof j === 'string' ? j : JSON.stringify(j)).buffer as ArrayBuffer });
      if (o.status) return reply(o.status, { error: 'full' });
      if (url.endsWith(WATCH_ROUTES.info)) return reply(200, o.info ?? info);
      if (url.endsWith(WATCH_ROUTES.swaps) && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (o.ack) return reply(200, o.ack(body));
        // The real service: open the sealed key with its own seed, then acknowledge.
        const req = openWatchRequest(body, watcherSeed);
        return reply(200, signWatchAck({ chain: req.chain, swapRef: req.swapRef, watchingUntil: 1_800_020_000n, watcherSeed: o.ackSeed ?? watcherSeed }));
      }
      return reply(200, { state: 'watching' });
    };
    return { fetchFn, seen };
  }

  it('reads the keys to name, hands a swap over with the key sealed, and returns the verified acknowledgement', async () => {
    const svc = service();
    const client = new WatcherClient('https://watcher.example/', svc.fetchFn);
    const got = await client.info();
    expect(got).toEqual({ ...info, ethereum: info.ethereum.toLowerCase() });
    for (const chain of ['solana', 'ethereum'] as const) {
      const ack = await client.register({ chain, swapRef, noticeKey: key, watcherSolanaKey: got.solana });
      expect(ack).toMatchObject({ swap_ref: hex(swapRef), watching_until: 1_800_020_000 });
    }
    expect(svc.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET https://watcher.example/watch/v1/info', 'POST https://watcher.example/watch/v1/swaps', 'POST https://watcher.example/watch/v1/swaps']);
    // The key never leaves in clear.
    for (const s of svc.seen) {
      expect(s.body ?? '').not.toContain(hex(key));
      expect(s.body ?? '').not.toContain(toBase64(key));
    }
    expect(await client.status(swapRef)).toEqual({ state: 'watching' });
    expect(svc.seen.at(-1)!.url).toBe(`https://watcher.example/watch/v1/swaps/${hex(swapRef)}`);
  });

  it('treats a swap as not watched when the acknowledgement is missing, forged or for another swap', async () => {
    const reg = (svc: ReturnType<typeof service>) => new WatcherClient('https://w.example', svc.fetchFn).register({ chain: 'solana', swapRef, noticeKey: key, watcherSolanaKey: watcherKey });
    // Signed by a key that is not the one the swap names.
    await expect(reg(service({ ackSeed: otherSeed }))).rejects.toMatchObject({ code: 'WatchAckInvalid' });
    // A well-signed acknowledgement of a different swap.
    await expect(reg(service({ ack: () => signWatchAck({ chain: 'solana', swapRef: r.bytes(32), watchingUntil: 5n, watcherSeed }) }))).rejects.toMatchObject({ code: 'WatchAckInvalid' });
    await expect(reg(service({ ack: () => ({ ok: true }) }))).rejects.toMatchObject({ code: 'WatchAckInvalid' });
    await expect(reg(service({ ack: () => 'not json' }))).rejects.toMatchObject({ code: 'WatcherMalformed' });
    // A refusal (full, rate-limited, swap not found at finalized) and an unreachable service.
    await expect(reg(service({ status: 429 }))).rejects.toBeInstanceOf(WatcherRefused);
    await expect(reg(service({ status: 404 }))).rejects.toMatchObject({ status: 404, code: 'WatcherRefused' });
    const down = new WatcherClient('https://w.example', async () => {
      throw new Error('connection refused');
    });
    await expect(down.info()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refuses a malformed info answer rather than naming a bad key as watcher', async () => {
    for (const bad of [{}, { ...info, solana: 'abc' }, { ...info, ethereum: '0x12' }, { ...info, max_swaps: 'many' }, { solana: watcherKey }]) {
      await expect(new WatcherClient('https://w.example', service({ info: bad }).fetchFn).info()).rejects.toMatchObject({ code: 'WatcherMalformed' });
      expect(codeOf(() => parseWatchInfo(bad))).toBe('WatcherMalformed');
    }
  });
});

describe('watcherFacts: view-only verification under the node policy', () => {
  const m = vector('monero_tx');
  const dust = m.cases.find((c: any) => c.name === 'dust-in-the-lock-block');
  const HEIGHT = 162;
  const lockTx: FakeTx = { txid: dust.input.txs[0].txid, hex: dust.input.txs[0].tx_hex, prunedHex: dust.input.txs[0].pruned_hex, prunableHash: dust.input.txs[0].prunable_hash, blockHeight: HEIGHT };
  const node = (name: string, conf: number, txs: FakeTx[] = [lockTx]) => new FakeMoneroNode(name, HEIGHT + conf, txs);
  // A direction-A swap whose four halves are the recorded lock's: the taker's view share is in
  // clear on-chain, the maker's travels in the notice. The watcher gets no spend share at all.
  const swapRef = r.bytes(32);
  const encTaker = unhex(k.taker_secret);
  const encMaker = unhex(k.maker_secret);
  function noticed(txid: string, view: string): SwapView {
    const s = baseView({
      direction: 0,
      state: SWAP_STATE.NOTICED,
      swapRef,
      xmr: BigInt(dust.input.min_amount),
      depth: 10,
      takerSpendPub: unhex(m.keys.taker.spend_pub),
      makerSpendPub: unhex(m.keys.maker.spend_pub),
      lockerView: unhex(m.keys.taker.view),
      flags: SWAP_FLAG.NOTICE,
      watcher: true,
      watcherAddress: watcherKey,
      wZ: 86_400,
      tLock: 1_800_000_000n,
      tActive: 1_800_000_000n,
      tNoteDeadline: 1_800_000_600n,
      tNotice: 1_800_000_090n,
      tCut: 1_800_002_805n,
      tClaimOpen: 1_800_005_490n,
      tFinal: 1_800_604_800n,
      dC: 5400,
      wC: 1800,
    });
    const n = buildNotice(s, encMaker, unhex(txid), unhex(view));
    return { ...s, noticeCommitment: n.commitment, noticeCt: n.ciphertext };
  }
  const good = () => noticed(lockTx.txid, m.keys.maker.view);
  const key = () => noticeKey(good(), encTaker);

  it('a confirmed lock on two agreeing nodes is left alone', async () => {
    const s = good();
    const f = await watcherFacts({ swap: s, noticeKey: key(), nodes: [node('a', 12), node('b', 11)], network: 'regtest' });
    expect(f.noticeOpens).toBe(true);
    expect(f.lock).toEqual({ state: 'confirmed', ok: true, confirmations: 11 });
    expect(f.result!.amount).toBe(3_000_000_000_000n);
    expect(hex(f.txid!)).toBe(lockTx.txid);
    expect(watcherStep({ swap: s, now: s.tCut, watcher: watcherKey, ...f })).toEqual({ do: 'wait', on: 'recheck', until: s.tClaimOpen - 300n });
  });

  it('the two-node rule: one node is refused unless it is the operator\'s own', async () => {
    const s = good();
    await expect(watcherFacts({ swap: s, noticeKey: key(), nodes: [node('a', 12)], network: 'regtest' })).rejects.toMatchObject({ code: 'NodePolicy' });
    await expect(watcherFacts({ swap: s, noticeKey: key(), nodes: [], network: 'regtest' })).rejects.toMatchObject({ code: 'NodePolicy' });
    const own = await watcherFacts({ swap: s, noticeKey: key(), nodes: [node('a', 12)], ownNode: true, network: 'regtest' });
    expect(own.lock).toMatchObject({ state: 'confirmed', ok: true });
  });

  it('freezes at T_cut when the lock is shallow, missing on one node, or the nodes disagree', async () => {
    const s = good();
    const freeze = { do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: s.tClaimOpen - 300n, why: 'lock-not-confirmed' };
    const lagging = node('b', 12);
    lagging.blockHashes.set(HEIGHT, 'ff'.repeat(32));
    const down = node('b', 12);
    down.down = true;
    for (const nodes of [[node('a', 12), node('b', 3)], [node('a', 12), node('b', 12, [])], [node('a', 12), lagging], [node('a', 12), down]]) {
      const f = await watcherFacts({ swap: s, noticeKey: key(), nodes, network: 'regtest' });
      expect(f.noticeOpens).toBe(true);
      expect(f.lock!.ok).toBe(false);
      expect(watcherStep({ swap: s, now: s.tCut - 1n, watcher: watcherKey, ...f })).toEqual({ do: 'wait', on: 'lock-check', until: s.tCut });
      expect(watcherStep({ swap: s, now: s.tCut, watcher: watcherKey, ...f })).toEqual(freeze);
    }
  });

  it('a false notice is frozen at once: a txid that pays someone else, a view share that is not the maker\'s, or no valid opening', async () => {
    const nodes = () => [node('a', 12), node('b', 12)];
    // The notice names a real transaction that does not pay this swap's joint address.
    const wrongView = noticed(lockTx.txid, m.keys.taker.view);
    const f1 = await watcherFacts({ swap: wrongView, noticeKey: noticeKey(wrongView, encTaker), nodes: nodes(), network: 'regtest' });
    expect(f1.noticeOpens).toBe(true);
    expect(f1.lock!.ok).toBe(false);
    expect(watcherStep({ swap: wrongView, now: wrongView.tCut, watcher: watcherKey, ...f1 })).toMatchObject({ do: 'call', call: { name: 'freeze' }, why: 'lock-not-confirmed' });
    // A txid no node knows.
    const noTx = noticed('ab'.repeat(32), m.keys.maker.view);
    const f2 = await watcherFacts({ swap: noTx, noticeKey: noticeKey(noTx, encTaker), nodes: nodes(), network: 'regtest' });
    expect(f2.lock).toMatchObject({ state: 'not-found', ok: false });
    // A commitment the ciphertext does not open: no lock at all, frozen without waiting for T_cut.
    const s = good();
    const tampered = { ...s, noticeCommitment: r.bytes(32) };
    const f3 = await watcherFacts({ swap: tampered, noticeKey: key(), nodes: nodes(), network: 'regtest' });
    expect(f3).toEqual({ noticeOpens: false });
    expect(watcherStep({ swap: tampered, now: tampered.tNotice + 1n, watcher: watcherKey, ...f3 })).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: s.tClaimOpen - 300n, why: 'notice-invalid' });
  });

  it('a wrong key handed to the watcher reads as "no lock": it can only cause a freeze, which the locker undoes by setting ready', async () => {
    const s = good();
    const f = await watcherFacts({ swap: s, noticeKey: r.bytes(32), nodes: [node('a', 12), node('b', 12)], network: 'regtest' });
    expect(f).toEqual({ noticeOpens: false });
    const dec = watcherStep({ swap: s, now: s.tNotice + 1n, watcher: watcherKey, ...f });
    expect(dec).toMatchObject({ do: 'call', call: { name: 'freeze' } });
    // The same swap seen by a watcher it does not name: nothing to do, whatever it was told.
    expect(watcherStep({ swap: s, now: s.tNotice + 1n, watcher: otherKey, ...f })).toEqual({ do: 'stop', why: 'not-named' });
  });
});
