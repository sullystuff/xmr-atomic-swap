// Off-chain messages and their transports (SPEC 2.8, 6): typed envelopes against envelope.json,
// stale key versions, size caps, the relay and direct routes, the on-chain fallback, and the
// blob fetch for DLEQ proofs (dleq.json) and key-pool leaves (merkle.json).
import { beforeAll, describe, expect, it } from 'vitest';
import { dleqVerify, envelopeHeader, envelopeVerifySig, init, merkleProof, x25519Public } from '@xmrswap/core-wasm';
import { type Address, type InboxMessage, MAKER_ROUTES, type Message, type PoolResponse, parseMessage } from '@xmrswap/protocol';
import { fetchPool, fetchProof, leafArgument, parsePool, pickLeaf, uploadOwnProof, verifyFundedShare, verifyProof, verifyTakerShare } from '../src/messages/blobs.js';
import { ENVELOPE_CAP, envelopeHash, makerEncKeyFor, openFromMaker, openFromTaker, sealToMaker, sealToTaker } from '../src/messages/envelope.js';
import { MakerHttp, MakerRefused, type MessageTransport, TransportUnavailable, blobRouteAvailable, directEndpoint, ethereumMessageTransport, relayEndpoint, relayStatus, sendWithFallback, solanaMessageTransport, torMessageTransport } from '../src/messages/transports.js';
import type { SwapView } from '../src/machine/view.js';
import { NO_SWAP } from '../src/machine/model.js';
import { fakeMakerEndpoint, fakeRelayFetch } from '../src/testing/maker.js';
import { codeOf, hex, toBase64, unhex } from '../src/util.js';
import { rng, vector, vectorFile } from './helpers.js';

beforeAll(async () => {
  await init();
});

const v = vector('envelope');
const K = v.keys;
const byName = (n: string) => v.cases.find((c: any) => c.name === n);
const NOW = 1_800_000_000n;
/** The maker's registry record as the vectors assume it: key version 3 current, version 2 still valid. */
const makerState = (over: Record<string, unknown> = {}) => ({ encKey: unhex(K.maker_pub), encKeyVersion: 3, prevEncKey: unhex(K.maker_pub), prevEncKeyExpiresAt: NOW + 3600n, ...over });
const secretFor = () => unhex(K.maker_secret);

describe('envelope.json: typed messages', () => {
  it('seals a taker message to the vector bytes and the maker opens it', () => {
    for (const name of ['taker-to-maker', 'taker-to-maker-no-swap']) {
      const c = byName(name);
      const message = JSON.parse(c.input.plaintext_utf8) as Message;
      const env = sealToMaker({ message, ownEncSecret: unhex(K.taker_secret), maker: makerState(), swapRef: unhex(c.input.swap_ref), transport: 'solana', nonce: unhex(c.input.nonce) });
      expect(hex(env), name).toBe(c.output.envelope);
      expect(env.length).toBe(c.output.length);
      const opened = openFromTaker({ envelope: env, maker: makerState(), secretFor, now: NOW, transport: 'solana' });
      expect(opened.message).toEqual(message);
      expect(opened.header).toMatchObject({ fromMaker: false, makerKeyVersion: 3 });
      expect(hex(opened.header.takerPub)).toBe(K.taker_pub);
      expect(hex(opened.header.swapRef)).toBe(c.input.swap_ref);
    }
  });

  it('seals and signs a maker reply to the vector bytes and the taker opens it', () => {
    const c = byName('maker-to-taker');
    const message = JSON.parse(c.input.plaintext_utf8) as Message;
    const env = sealToTaker({ message, makerEncSecret: unhex(K.maker_secret), makerKeyVersion: 3, takerPub: unhex(K.taker_pub), swapRef: unhex(c.input.swap_ref), operatorSeed: unhex(K.operator_seed), transport: 'tor', nonce: unhex(c.input.nonce) });
    expect(hex(env)).toBe(c.output.envelope);
    expect(hex(env.subarray(env.length - 64))).toBe(c.output.signature);
    expect(envelopeVerifySig(env, unhex(K.operator_pub))).toBe(true);
    const opened = openFromMaker({ envelope: env, ownEncSecret: unhex(K.taker_secret), maker: makerState(), operatorPub: unhex(K.operator_pub), now: NOW, swapRef: unhex(c.input.swap_ref) });
    expect(opened.message).toEqual(message);
    expect(opened.header.fromMaker).toBe(true);
    // Bound to another swap than the one the caller is asking about.
    expect(codeOf(() => openFromMaker({ envelope: env, ownEncSecret: unhex(K.taker_secret), maker: makerState(), operatorPub: unhex(K.operator_pub), now: NOW, swapRef: new Uint8Array(32) }))).toBe('EnvelopeMalformed');
  });

  it('the largest responses fit the 900-byte on-chain cap', () => {
    for (const c of v.cases.filter((c: any) => c.name.startsWith('largest-'))) {
      const message = parseMessage(c.input.plaintext_utf8);
      const env = sealToTaker({ message, makerEncSecret: unhex(K.maker_secret), makerKeyVersion: 3, takerPub: unhex(K.taker_pub), swapRef: unhex(c.input.swap_ref), operatorSeed: unhex(K.operator_seed), transport: 'solana', nonce: unhex(c.input.nonce) });
      expect(hex(env), c.name).toBe(c.output.envelope);
      expect(env.length, c.name).toBe(c.output.length);
      expect(env.length <= ENVELOPE_CAP.solana, c.name).toBe(true);
      expect(openFromMaker({ envelope: env, ownEncSecret: unhex(K.taker_secret), maker: makerState(), operatorPub: unhex(K.operator_pub), now: NOW }).message, c.name).toEqual(message);
    }
    expect(v.overhead).toEqual({ maker: 176, taker: 112 });
  });

  it('refuses every tampered envelope a maker could receive', () => {
    const cases = v.cases.filter((c: any) => !c.valid && c.input.opened_by === 'maker');
    expect(cases.length).toBe(12);
    for (const c of cases) {
      const envelope = unhex(c.input.envelope);
      const code = codeOf(() => openFromTaker({ envelope, maker: makerState(), secretFor, now: NOW, transport: 'tor' }));
      // The wrapper's own refusals for what it checks before the core: the size cap, and a key
      // version the registry does not list.
      let expected = c.error === 'EnvelopeTooLarge' ? 'too_large' : c.error;
      if (c.error === 'EnvelopeDecrypt' && makerEncKeyFor(makerState(), envelopeHeader(envelope).makerKeyVersion, NOW) === null) expected = 'stale_key';
      expect(code, c.name).toBe(expected);
    }
  });

  it('refuses every bad maker envelope a taker could receive', () => {
    const cases = v.cases.filter((c: any) => !c.valid && c.input.opened_by === 'taker');
    expect(cases.length).toBe(6);
    for (const c of cases) {
      const operatorPub = c.input.operator_pub ? unhex(c.input.operator_pub) : new Uint8Array(32);
      const code = codeOf(() => openFromMaker({ envelope: unhex(c.input.envelope), ownEncSecret: unhex(K.taker_secret), maker: makerState(), operatorPub, now: NOW }));
      expect(code, c.name).toBe(c.error);
    }
    // A reply with the maker flag cleared is not a maker reply, whatever it contains.
    const fromTaker = unhex(byName('taker-to-maker').output.envelope);
    expect(codeOf(() => openFromMaker({ envelope: fromTaker, ownEncSecret: unhex(K.taker_secret), maker: makerState(), operatorPub: unhex(K.operator_pub), now: NOW }))).toBe('EnvelopeBadSignature');
    // And a maker-flagged envelope is never accepted as a request.
    expect(codeOf(() => openFromTaker({ envelope: unhex(byName('maker-to-taker').output.envelope), maker: makerState(), secretFor, now: NOW, transport: 'tor' }))).toBe('bad_request');
  });

  it('stale key versions: only the current key, or the previous one before its expiry', () => {
    const m = makerState({ encKeyVersion: 4, encKey: new Uint8Array(32).fill(9), prevEncKey: unhex(K.maker_pub), prevEncKeyExpiresAt: NOW + 10n });
    expect(hex(makerEncKeyFor(m, 4, NOW)!)).toBe('09'.repeat(32));
    expect(hex(makerEncKeyFor(m, 3, NOW + 9n)!)).toBe(K.maker_pub);
    // The expiry second itself is already too late.
    expect(makerEncKeyFor(m, 3, NOW + 10n)).toBe(null);
    expect(makerEncKeyFor(m, 2, NOW)).toBe(null);
    expect(makerEncKeyFor(m, 5, NOW)).toBe(null);
    expect(makerEncKeyFor({ ...m, encKeyVersion: 1, prevEncKeyExpiresAt: NOW + 10n }, 0, NOW)).toBe(null);

    // The vector envelope was sealed to version 3. After one rotation it is still readable…
    const env = unhex(byName('taker-to-maker').output.envelope);
    expect(openFromTaker({ envelope: env, maker: m, secretFor, now: NOW, transport: 'solana' }).message.t).toBe('inbox');
    // …until the previous key expires, or after a second rotation: stale_key, and the client re-reads the registry.
    expect(codeOf(() => openFromTaker({ envelope: env, maker: m, secretFor, now: NOW + 10n, transport: 'solana' }))).toBe('stale_key');
    expect(codeOf(() => openFromTaker({ envelope: env, maker: { ...m, encKeyVersion: 5 }, secretFor, now: NOW, transport: 'solana' }))).toBe('stale_key');
    // The daemon already deleted that version's private key.
    expect(codeOf(() => openFromTaker({ envelope: env, maker: m, secretFor: () => null, now: NOW, transport: 'solana' }))).toBe('stale_key');
    // A reply naming a version the registry no longer lists is refused by the taker too.
    const reply = unhex(byName('maker-to-taker').output.envelope);
    expect(codeOf(() => openFromMaker({ envelope: reply, ownEncSecret: unhex(K.taker_secret), maker: { ...m, encKeyVersion: 5 }, operatorPub: unhex(K.operator_pub), now: NOW }))).toBe('stale_key');
    // A new message is always sealed to the current version.
    const fresh = sealToMaker({ message: { t: 'inbox', text: 'hi' }, ownEncSecret: unhex(K.taker_secret), maker: { ...m, encKey: unhex(K.maker_pub) }, transport: 'tor' });
    expect(envelopeHeader(fresh).makerKeyVersion).toBe(4);
  });

  it('oversize messages: 900 bytes on-chain, 16,384 over Tor, 2,000 characters of inbox text', () => {
    const c = byName('seal-over-onchain-cap');
    // An inbox message whose plaintext is exactly the vector's length.
    const frame = JSON.stringify({ t: 'inbox', text: '' }).length;
    const message: InboxMessage = { t: 'inbox', text: 'x'.repeat(c.input.plaintext_len - frame) };
    const seal = (transport: 'solana' | 'tor' | 'ethereum') => sealToMaker({ message, ownEncSecret: unhex(K.taker_secret), maker: makerState(), transport });
    expect(codeOf(() => seal('solana'))).toBe(c.error);
    expect(codeOf(() => seal('ethereum'))).toBe(c.error);
    expect(seal('tor').length).toBe(c.input.plaintext_len + v.overhead.taker);
    // One byte less fits on-chain exactly at the cap.
    const fits = sealToMaker({ message: { t: 'inbox', text: 'x'.repeat(c.input.plaintext_len - frame - 1) }, ownEncSecret: unhex(K.taker_secret), maker: makerState(), transport: 'solana' });
    expect(fits.length).toBe(900);
    // The maker's side of the same rule.
    const m = byName('seal-maker-over-onchain-cap');
    const replyFrame = JSON.stringify({ t: 'inbox_reply', text: '', in_reply_to: '0'.repeat(64) }).length;
    const reply = (transport: 'solana' | 'tor') => sealToTaker({ message: { t: 'inbox_reply', text: 'y'.repeat(m.input.plaintext_len - replyFrame), in_reply_to: '0'.repeat(64) }, makerEncSecret: unhex(K.maker_secret), makerKeyVersion: 3, takerPub: unhex(K.taker_pub), operatorSeed: unhex(K.operator_seed), transport });
    expect(codeOf(() => reply('solana'))).toBe(m.error);
    expect(reply('tor').length).toBe(m.input.plaintext_len + v.overhead.maker);
    // Too long for any transport, and too long as a message.
    expect(codeOf(() => sealToMaker({ message: { t: 'inbox', text: 'é'.repeat(2000) + 'z'.repeat(13_000) }, ownEncSecret: unhex(K.taker_secret), maker: makerState(), transport: 'tor' }))).not.toBe(null);
    expect(() => sealToMaker({ message: { t: 'inbox', text: 'z'.repeat(2001) }, ownEncSecret: unhex(K.taker_secret), maker: makerState(), transport: 'tor' })).toThrow(/2000/);
    // An envelope over the transport's cap is refused before any decryption.
    const big = seal('tor');
    expect(codeOf(() => openFromTaker({ envelope: big, maker: makerState(), secretFor, now: NOW, transport: 'solana' }))).toBe('too_large');
    expect(openFromTaker({ envelope: big, maker: makerState(), secretFor, now: NOW, transport: 'tor' }).message.t).toBe('inbox');
  });

  it('each side may send only its own message types, and never to a low-order key', () => {
    const maker = makerState();
    expect(codeOf(() => sealToMaker({ message: { t: 'ack', in_reply_to: '0'.repeat(64) }, ownEncSecret: unhex(K.taker_secret), maker, transport: 'tor' }))).toBe('bad_request');
    expect(codeOf(() => sealToTaker({ message: { t: 'inbox', text: 'x' }, makerEncSecret: unhex(K.maker_secret), makerKeyVersion: 3, takerPub: unhex(K.taker_pub), operatorSeed: unhex(K.operator_seed), transport: 'tor' }))).toBe('bad_request');
    const low = unhex(vector('points').low_order_x25519[6].key);
    expect(codeOf(() => sealToMaker({ message: { t: 'inbox', text: 'x' }, ownEncSecret: unhex(K.taker_secret), maker: { ...maker, encKey: low }, transport: 'tor' }))).toBe('LowOrderEncryptionKey');
    expect(codeOf(() => sealToTaker({ message: { t: 'ack', in_reply_to: '0'.repeat(64) }, makerEncSecret: unhex(K.maker_secret), makerKeyVersion: 3, takerPub: low, operatorSeed: unhex(K.operator_seed), transport: 'tor' }))).toBe('LowOrderEncryptionKey');
    // in_reply_to is the SHA-256 of the request envelope.
    expect(envelopeHash(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(x25519Public(unhex(K.taker_secret)))).toBe(K.taker_pub);
  });
});

// ------------------------------------------------------------------ transports

const ONION = `${'m'.repeat(56)}.onion`;
/** A maker endpoint that answers `/msg` with a signed ack and serves blobs from maps. */
function makerRoutes(state: { dleq?: Map<string, Uint8Array>; pools?: Map<string, string>; replies?: Uint8Array[]; refuse?: string; seen?: Uint8Array[] } = {}) {
  return (method: 'GET' | 'POST' | 'PUT', path: string, body?: Uint8Array) => {
    if (path === MAKER_ROUTES.info) return { status: 200, body: JSON.stringify({ maker: 'M', operator: 'O', enc_key_version: 3, chain_time: 1_800_000_000 }) };
    if (path === MAKER_ROUTES.msg) {
      if (state.refuse) return { status: 400, body: JSON.stringify({ code: state.refuse }) };
      state.seen?.push(body!);
      const header = envelopeHeader(body!);
      return { status: 200, body: sealToTaker({ message: { t: 'ack', in_reply_to: envelopeHash(body!) }, makerEncSecret: unhex(K.maker_secret), makerKeyVersion: header.makerKeyVersion, takerPub: header.takerPub, swapRef: header.swapRef, operatorSeed: unhex(K.operator_seed), transport: 'tor' }) };
    }
    const dleq = /^\/xs\/v1\/dleq\/([0-9a-f]{64})$/.exec(path);
    if (dleq && method === 'GET') {
      const blob = state.dleq?.get(dleq[1]!);
      return blob ? { status: 200, body: blob } : { status: 404, body: '' };
    }
    if (dleq && method === 'PUT') {
      try {
        if (hex(dleqVerify(body!).spendPub) !== dleq[1]) return { status: 400, body: JSON.stringify({ code: 'bad_request' }) };
      } catch {
        return { status: 400, body: JSON.stringify({ code: 'bad_request' }) };
      }
      state.dleq?.set(dleq[1]!, body!);
      return { status: 204, body: '' };
    }
    const pool = /^\/xs\/v1\/pool\/([0-9a-f]{64})$/.exec(path);
    if (pool) {
      const p = state.pools?.get(pool[1]!);
      return p ? { status: 200, body: p } : { status: 404, body: '' };
    }
    if (path.startsWith('/xs/v1/replies/')) return { status: 200, body: JSON.stringify({ envelopes: (state.replies ?? []).map(toBase64) }) };
    return { status: 404, body: '' };
  };
}
const inbox = (transport: 'tor' | 'solana' | 'ethereum', text = 'Please release my deposit.') => sealToMaker({ message: { t: 'inbox', text }, ownEncSecret: unhex(K.taker_secret), maker: makerState(), transport });
const openReply = (reply: Uint8Array) => openFromMaker({ envelope: reply, ownEncSecret: unhex(K.taker_secret), maker: makerState(), operatorPub: unhex(K.operator_pub), now: NOW }).message;

describe('maker endpoint through the relay and directly', () => {
  it('forwards an envelope to a listed onion and returns the signed reply', async () => {
    const seen: Uint8Array[] = [];
    const fetchFn = fakeRelayFetch({ [ONION]: makerRoutes({ seen }) });
    const http = new MakerHttp(relayEndpoint('http://127.0.0.1:8787/', ONION, fetchFn));
    const env = inbox('tor');
    const reply = await http.msg(env);
    expect(openReply(reply)).toEqual({ t: 'ack', in_reply_to: envelopeHash(env) });
    expect(hex(seen[0]!)).toBe(hex(env));
    expect(fetchFn.forwarded[0]).toMatchObject({ onion: ONION, method: 'POST', path: '/xs/v1/msg' });
    expect((await http.info()).enc_key_version).toBe(3);
  });

  it('an unlisted onion, a relay that is down and a malformed forward response are all "unavailable"', async () => {
    const fetchFn = fakeRelayFetch({ [ONION]: makerRoutes() });
    const unlisted = new MakerHttp(relayEndpoint('http://127.0.0.1:8787', `${'x'.repeat(56)}.onion`, fetchFn));
    // The relay's own refusal (a RelayError body) is told apart from a maker's by its code.
    await expect(unlisted.info()).rejects.toMatchObject({ name: 'TransportUnavailable', code: 'unavailable', relayError: 'onion_not_listed' });
    fetchFn.down = true;
    const http = new MakerHttp(relayEndpoint('http://127.0.0.1:8787', ONION, fetchFn));
    await expect(http.msg(inbox('tor'))).rejects.toMatchObject({ name: 'TransportUnavailable', relayError: null });
    await expect(relayStatus('http://127.0.0.1:8787', fetchFn)).rejects.toBeInstanceOf(TransportUnavailable);
    const garbage = new MakerHttp(relayEndpoint('http://127.0.0.1:8787', ONION, async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('<html>').buffer as ArrayBuffer })));
    await expect(garbage.info()).rejects.toBeInstanceOf(TransportUnavailable);
  });

  it('never asks a relay or a maker for a path outside the maker routes, nor sends an oversize body', async () => {
    const fetchFn = fakeRelayFetch({ [ONION]: makerRoutes() });
    const endpoint = relayEndpoint('http://127.0.0.1:8787', ONION, fetchFn);
    await expect(endpoint.request('GET', '/xs/v1/../../admin')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(endpoint.request('GET', '/xs/v1/dleq/XYZ')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(endpoint.request('POST', '/xs/v1/msg', new Uint8Array(16_385))).rejects.toMatchObject({ code: 'too_large' });
    await expect(endpoint.request('PUT', `/xs/v1/dleq/${'a'.repeat(64)}`, new Uint8Array(60_001))).rejects.toMatchObject({ code: 'too_large' });
    await expect(new MakerHttp(endpoint).msg(new Uint8Array(16_385))).rejects.toMatchObject({ code: 'too_large' });
    expect(fetchFn.forwarded.length).toBe(0);
    // A maker (or relay) answering with more than 60,000 bytes is cut off.
    const fat = fakeMakerEndpoint(() => ({ status: 200, body: new Uint8Array(60_001) }));
    const viaDirect = directEndpoint('https://blobs.invalid', async () => ({ status: 200, arrayBuffer: async () => new Uint8Array(60_001).buffer as ArrayBuffer }));
    await expect(viaDirect.request('GET', '/xs/v1/info')).rejects.toMatchObject({ code: 'too_large' });
    expect((await fat.request('GET', '/xs/v1/info')).body.length).toBe(60_001);
  });

  it('a maker refusal carries its code; a 5xx is "unavailable"', async () => {
    const http = new MakerHttp(fakeMakerEndpoint(makerRoutes({ refuse: 'stale_key' })));
    const err = await http.msg(inbox('tor')).catch((e) => e);
    expect(err).toBeInstanceOf(MakerRefused);
    expect(err).toMatchObject({ code: 'stale_key', status: 400 });
    const rate = new MakerHttp(fakeMakerEndpoint(() => ({ status: 429, body: JSON.stringify({ code: 'rate_limited' }) })));
    await expect(rate.msg(inbox('tor'))).rejects.toMatchObject({ code: 'rate_limited' });
    const broken = new MakerHttp(fakeMakerEndpoint(() => ({ status: 502, body: '' })));
    await expect(broken.msg(inbox('tor'))).rejects.toBeInstanceOf(TransportUnavailable);
  });

  it('reads later replies from the replies route after a reload', async () => {
    const c = byName('maker-to-taker');
    const stored = unhex(c.output.envelope);
    const http = new MakerHttp(directEndpoint('http://onion.invalid', async (url) => {
      expect(url).toBe(`http://onion.invalid/xs/v1/replies/${K.taker_pub}`);
      return { status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ envelopes: [toBase64(stored)] })).buffer as ArrayBuffer };
    }));
    const replies = await http.replies(K.taker_pub);
    expect(replies.length).toBe(1);
    expect(openReply(replies[0]!)).toMatchObject({ t: 'inbox_reply', text: 'Released.' });
  });
});

describe('transport fallback', () => {
  const tor = (fetchFn: ReturnType<typeof fakeRelayFetch>) => torMessageTransport(new MakerHttp(relayEndpoint('http://127.0.0.1:8787', ONION, fetchFn)));

  it('prefers Tor and gets the reply at once', async () => {
    const posted: Uint8Array[] = [];
    const r = await sendWithFallback([tor(fakeRelayFetch({ [ONION]: makerRoutes() })), solanaMessageTransport(async (e) => (posted.push(e), 'sig1'))], (t) => inbox(t.kind));
    expect(r.via).toBe('tor');
    expect(openReply(r.reply!).t).toBe('ack');
    expect(posted.length).toBe(0);
  });

  it('falls back to on-chain messaging when the relay is down', async () => {
    const down = fakeRelayFetch({ [ONION]: makerRoutes() });
    down.down = true;
    const posted: Uint8Array[] = [];
    const r = await sendWithFallback([tor(down), solanaMessageTransport(async (e) => (posted.push(e), 'sig1')), ethereumMessageTransport(async () => '0xhash')], (t) => inbox(t.kind));
    expect(r).toEqual({ via: 'solana', reply: null, txId: 'sig1' });
    expect(posted[0]!.length <= 900).toBe(true);
    // Solana's RPC unreachable too: the Ethereum event fallback.
    const r2 = await sendWithFallback([tor(down), solanaMessageTransport(async () => Promise.reject(new Error('fetch failed'))), ethereumMessageTransport(async () => '0xhash')], (t) => inbox(t.kind));
    expect(r2).toEqual({ via: 'ethereum', reply: null, txId: '0xhash' });
    await expect(sendWithFallback([tor(down)], (t) => inbox(t.kind))).rejects.toBeInstanceOf(TransportUnavailable);
    await expect(sendWithFallback([], () => inbox('tor'))).rejects.toBeInstanceOf(TransportUnavailable);
  });

  it('a maker\'s refusal is final: the same bytes are not retried on-chain', async () => {
    const posted: Uint8Array[] = [];
    const refusing = fakeRelayFetch({ [ONION]: makerRoutes({ refuse: 'stale_key' }) });
    await expect(sendWithFallback([tor(refusing), solanaMessageTransport(async (e) => (posted.push(e), 'sig'))], (t) => inbox(t.kind))).rejects.toMatchObject({ code: 'stale_key' });
    expect(posted.length).toBe(0);
  });

  it('a message too large for the on-chain cap goes over Tor or not at all', async () => {
    const text = 'x'.repeat(1500);
    const viaTor = await sendWithFallback([tor(fakeRelayFetch({ [ONION]: makerRoutes() })), solanaMessageTransport(async () => 'sig')], (t) => inbox(t.kind, text));
    expect(viaTor.via).toBe('tor');
    const down = fakeRelayFetch({});
    down.down = true;
    const posted: Uint8Array[] = [];
    await expect(sendWithFallback([tor(down), solanaMessageTransport(async (e) => (posted.push(e), 'sig'))], (t) => inbox(t.kind, text))).rejects.toBeInstanceOf(TransportUnavailable);
    expect(posted.length).toBe(0);
    // An on-chain transport refuses an oversize envelope by itself too.
    const sol: MessageTransport = solanaMessageTransport(async () => 'sig');
    await expect(sol.send(new Uint8Array(901))).rejects.toMatchObject({ code: 'too_large' });
    expect(sol.maxEnvelope).toBe(900);
  });

  it('Ethereum swaps need a blob route: a relay to the onion, or an HTTPS blob endpoint', () => {
    expect(blobRouteAvailable({ onion: ONION, contacts: [] }, 'http://127.0.0.1:8787')).toBe('relay');
    expect(blobRouteAvailable({ onion: ONION, contacts: [] }, null)).toBe(null);
    expect(blobRouteAvailable({ onion: '', contacts: [{ kind: 5, value: 'https://blobs.example' }] }, null)).toBe('https');
    expect(blobRouteAvailable({ onion: '', contacts: [{ kind: 5, value: 'http://blobs.example' }, { kind: 0, value: 'https://site.example' }] }, 'http://relay')).toBe(null);
  });
});

// ------------------------------------------------------------------ blobs

describe('key pools (merkle.json)', () => {
  const m = vector('merkle');
  const pools = m.cases.filter((c: any) => c.valid);
  const bodyOf = (c: any, edit: (leaves: PoolResponse['leaves']) => void = () => {}) => {
    const leaves = c.input.leaves.map((l: any) => ({ index: l.index, key: `0x${l.key_addr}`, key2: `0x${l.key_addr2}`, spend_pub: l.spend_pub }));
    edit(leaves);
    return JSON.stringify({ leaves });
  };

  it('accepts a pool only if its leaves hash to the quote keyRoot, and builds its own proofs', async () => {
    expect(pools.map((c: any) => c.input.leaves.length)).toEqual([2, 16, 64]);
    for (const c of pools) {
      const root = unhex(c.output.root);
      const http = new MakerHttp(fakeMakerEndpoint(makerRoutes({ pools: new Map([[c.output.root, bodyOf(c)]]) })));
      const pool = await fetchPool(http, root);
      expect(pool.leaves.map((l) => hex(l.hash)), c.name).toEqual(c.output.leaf_hashes);
      for (const i of [0, pool.leaves.length - 1]) {
        expect(pool.proofFor(i).map(hex), c.name).toEqual(c.output.proofs[i]);
        const arg = leafArgument(pool, pool.leaves[i]!);
        expect(arg).toMatchObject({ index: i, key: `0x${c.input.leaves[i].key_addr}`, key2: `0x${c.input.leaves[i].key_addr2}` });
        expect(arg.proof.map(hex)).toEqual(merkleProof(pool.leaves.map((l) => l.hash), i).map(hex));
      }
      await expect(fetchPool(http, new Uint8Array(32).fill(1))).rejects.toMatchObject({ code: 'PoolNotFound' });
    }
  });

  it('refuses a pool with a swapped share, a re-indexed share, a missing leaf or a bad size', () => {
    const c = pools[1];
    const root = unhex(c.output.root);
    // Another maker's share slipped in: the root no longer matches.
    expect(codeOf(() => parsePool(bodyOf(c, (l) => void (l[3]!.spend_pub = pools[2].input.leaves[40].spend_pub)), root))).toBe('PoolRootMismatch');
    // The same share placed at another index is another leaf.
    expect(codeOf(() => parsePool(bodyOf(c, (l) => void ([l[0]!.key, l[1]!.key] = [l[1]!.key, l[0]!.key])), root))).toBe('PoolRootMismatch');
    expect(codeOf(() => parsePool(bodyOf(c, (l) => void ([l[0], l[1]] = [l[1]!, l[0]!])), root))).toBe('PoolMalformed');
    expect(codeOf(() => parsePool(bodyOf(c, (l) => void l.pop()), root))).toBe('MerklePoolSize');
    expect(codeOf(() => parsePool(bodyOf(c, (l) => void (l[2]!.key = '0x1234' as Address)), root))).toBe('PoolMalformed');
    expect(codeOf(() => parsePool(bodyOf(c, (l) => void (l[2]!.spend_pub = 'zz')), root))).toBe('PoolMalformed');
    expect(codeOf(() => parsePool('not json', root))).toBe('PoolMalformed');
    expect(codeOf(() => parsePool('{}', root))).toBe('PoolMalformed');
    expect(codeOf(() => parsePool(new Uint8Array(60_001), root))).toBe('too_large');
    for (const bad of m.cases.filter((x: any) => x.error === 'MerklePoolSize')) {
      const leaves = Array.from({ length: bad.input.leaf_count }, (_, index) => ({ index, key: `0x${'11'.repeat(20)}`, key2: `0x${'22'.repeat(20)}`, spend_pub: '33'.repeat(32) }));
      expect(codeOf(() => parsePool(JSON.stringify({ leaves }), root)), bad.name).toBe('MerklePoolSize');
    }
    // A pool served for another root than the one the quote signs.
    expect(codeOf(() => parsePool(bodyOf(pools[0]), root))).toBe('PoolRootMismatch');
  });

  it('picks at random a leaf that is neither consumed nor named by a pending lock', async () => {
    const c = pools[1];
    const pool = parsePool(bodyOf(c), unhex(c.output.root));
    const used = new Set(pool.leaves.slice(0, 10).map((l) => l.key));
    const pending = new Set(pool.leaves.slice(10, 14).map((l) => l.key));
    const r = rng(5);
    const picks = new Set<number>();
    for (let i = 0; i < 40; i++) picks.add((await pickLeaf(pool, { isKeyUsed: async (k) => used.has(k), pending, random: () => r.next() / 2 ** 32 })).index);
    expect([...picks].sort((a, b) => a - b)).toEqual([14, 15]);
    await expect(pickLeaf(pool, { isKeyUsed: async () => true })).rejects.toMatchObject({ code: 'NoKeyAvailable' });
    expect((await pickLeaf(pool, { isKeyUsed: async () => false })).index).toBeLessThan(16);
  });
});

describe('DLEQ proofs (dleq.json)', () => {
  const d = vector('dleq');
  const blob = (c: any) => vectorFile(c.input.file);
  const statement = (c: any) => ({ spendPub: unhex(c.output.spend_pub), keyAddr: `0x${c.output.key_addr}` as Address, keyAddr2: `0x${c.output.key_addr2}` as Address });
  const [v1, v2] = d.cases.filter((c: any) => c.valid);
  const ethView = (over: Partial<SwapView>): SwapView => ({
    ...NO_SWAP, chain: 'ethereum', swapRef: new Uint8Array(32), taker: '', maker: '', asset: '0x', xmr: 0n, price: 0n, depBps: 0, swapNonce: new Uint8Array(16), sessionKey: '', takerEncKey: new Uint8Array(32), makerEncVersion: 1,
    makerEncKey: new Uint8Array(32), takerSpendPub: unhex(v1.output.spend_pub), makerSpendPub: unhex(v2.output.spend_pub), lockerView: new Uint8Array(32), noticeCommitment: new Uint8Array(32), noticeCt: new Uint8Array(0),
    evidenceTxid: new Uint8Array(32), evidenceView: new Uint8Array(32), revealed: new Uint8Array(32),
    eth: { takerKey: `0x${v1.output.key_addr}`, takerKey2: `0x${v1.output.key_addr2}`, makerKey: `0x${v2.output.key_addr}`, makerKey2: `0x${v2.output.key_addr2}`, keyLeaf: new Uint8Array(32), openHash: new Uint8Array(32) },
    ...over,
  });

  it('accepts a valid proof for exactly the commitments on record', () => {
    for (const c of [v1, v2]) {
      expect(blob(c).length).toBe(c.input.length);
      const st = verifyProof(blob(c), statement(c));
      expect(hex(st.spendPub)).toBe(c.output.spend_pub);
      expect(hex(st.secpCompressed)).toBe(c.output.secp_compressed);
    }
  });

  it('refuses every tampered blob', () => {
    const bad = d.cases.filter((c: any) => !c.valid);
    expect(bad.length).toBe(6);
    for (const c of bad) expect(codeOf(() => verifyProof(blob(c), statement(v1))), c.name).toBe(c.error);
  });

  it('refuses a valid proof of the wrong statement, and a replay of our own share', () => {
    // A valid proof, but for another share than the leaf (or the contract) names.
    expect(codeOf(() => verifyProof(blob(v1), statement(v2)))).toBe('DleqWrongKey');
    expect(codeOf(() => verifyProof(blob(v1), { ...statement(v1), keyAddr2: statement(v2).keyAddr2 }))).toBe('DleqWrongKey');
    expect(codeOf(() => verifyProof(blob(v1), { ...statement(v1), keyAddr: statement(v2).keyAddr }))).toBe('DleqWrongKey');
    expect(codeOf(() => verifyProof(blob(v1), statement(v1), [unhex(v1.output.spend_pub)]))).toBe('OwnShareReplayed');
  });

  it('direction B: a funded share with a rogue key or mismatched twins never shows the address', () => {
    expect(hex(verifyFundedShare(blob(v2), ethView({})).spendPub)).toBe(v2.output.spend_pub);
    // The maker funded with spendPub = x·G − S_T: no proof can exist for it; the proof it serves is for something else.
    expect(codeOf(() => verifyFundedShare(blob(v2), ethView({ makerSpendPub: new Uint8Array(32).fill(5) })))).toBe('DleqWrongKey');
    // Right spend commitment, unrelated twins in contract storage.
    expect(codeOf(() => verifyFundedShare(blob(v2), ethView({ eth: { ...ethView({}).eth!, makerKey2: `0x${v1.output.key_addr2}` } })))).toBe('DleqWrongKey');
    // The maker "funds" with the taker's own share.
    expect(codeOf(() => verifyFundedShare(blob(v1), ethView({ makerSpendPub: unhex(v1.output.spend_pub), eth: { ...ethView({}).eth!, makerKey: `0x${v1.output.key_addr}`, makerKey2: `0x${v1.output.key_addr2}` } })))).toBe('OwnShareReplayed');
    expect(codeOf(() => verifyFundedShare(blob(v2), { ...ethView({}), chain: 'solana' }))).toBe('WrongChain');
  });

  it('maker side: the taker proof must match contract storage and must not be one of the maker\'s own shares', () => {
    expect(hex(verifyTakerShare(blob(v1), ethView({}), [unhex(v2.output.spend_pub)]).spendPub)).toBe(v1.output.spend_pub);
    expect(codeOf(() => verifyTakerShare(blob(v1), ethView({}), [unhex(v1.output.spend_pub)]))).toBe('OwnShareReplayed');
    expect(codeOf(() => verifyTakerShare(blob(v2), ethView({}), []))).toBe('DleqWrongKey');
  });

  it('fetches a maker proof by S, and uploads our own; a missing or mismatching one blocks the lock', async () => {
    const store = new Map<string, Uint8Array>([[v2.output.spend_pub, blob(v2)], [v1.output.spend_pub, blob(v2)]]);
    const endpoint = fakeMakerEndpoint(makerRoutes({ dleq: store }));
    const http = new MakerHttp(endpoint);
    expect((await fetchProof(http, statement(v2))).length).toBe(56_679);
    // Served under S1 but proving S2.
    await expect(fetchProof(http, statement(v1))).rejects.toMatchObject({ code: 'DleqWrongKey' });
    await expect(fetchProof(http, { ...statement(v1), spendPub: new Uint8Array(32).fill(8) })).rejects.toMatchObject({ code: 'DleqMissing' });
    // A full-size upload passes the 60,000-byte cap and lands under its own S.
    const { blob: own, statement: st } = await uploadOwnProof(http, unhex(v1.input.s));
    expect(own.length).toBe(56_679);
    expect(hex(st.spendPub)).toBe(v1.output.spend_pub);
    expect(endpoint.requests.at(-1)).toMatchObject({ method: 'PUT', path: `/xs/v1/dleq/${v1.output.spend_pub}` });
    expect(hex(dleqVerify(store.get(v1.output.spend_pub)!).keyAddr)).toBe(v1.output.key_addr);
    // The maker's endpoint refuses a blob stored under the wrong name.
    await expect(http.putDleq(v2.output.spend_pub, own)).rejects.toMatchObject({ code: 'bad_request' });
  });
});
