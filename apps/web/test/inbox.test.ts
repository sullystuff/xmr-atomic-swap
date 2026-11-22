// @vitest-environment node
// The taker's side of the encrypted inbox against an in-memory maker endpoint that opens, answers
// and signs like the daemon. (Node environment: the core checks byte arrays by realm.)
import { describe, expect, it } from 'vitest';
import type { Message } from '@xmrswap/protocol';
import { MakerHttp, MakerRefused, TransportUnavailable, envelopeHash, init, makerShareKeys, openFromTaker, sealToTaker } from '@xmrswap/sdk';
import { fakeMakerEndpoint } from '@xmrswap/sdk/testing';
import { Inbox, explainSendError } from '../src/lib/inbox.js';
import { SealedStore } from '../src/lib/sealed.js';
import { MemoryKV } from '../src/lib/storage.js';
import { T0, TAKER, TAKER_SEED, makerRecord, row } from './fakes.js';

await init();
const MAKER_SEED = new Uint8Array(32).fill(77);

describe('inbox', () => {
  const maker = makerRecord(3, { onion: `${'a'.repeat(56)}.onion` });
  const enc = makerShareKeys(MAKER_SEED, 'solana', new Uint8Array(16).fill(1));
  const operatorSeed = new Uint8Array(32).fill(3);
  const pda = row(3).maker.pda;

  function daemon(reply: (m: Message, requestHash: string) => Message | null) {
    const seen: Message[] = [];
    const endpoint = fakeMakerEndpoint((method, path, body) => {
      if (method !== 'POST' || path !== '/xs/v1/msg' || !body) return { status: 404, body: '{}' };
      const { message, header } = openFromTaker({ envelope: body, maker, secretFor: () => enc.encSecret, now: T0, transport: 'tor' });
      seen.push(message);
      const answer = reply(message, envelopeHash(body));
      if (!answer) return { status: 403, body: JSON.stringify({ code: 'not_allowed' }) };
      return { status: 200, body: sealToTaker({ message: answer, makerEncSecret: enc.encSecret, makerKeyVersion: 1, takerPub: header.takerPub, operatorSeed, transport: 'tor' }) };
    });
    return { http: new MakerHttp(endpoint), seen };
  }
  const inbox = () => new Inbox(new SealedStore(new MemoryKV(), () => TAKER_SEED));

  it('seals a message to the maker, sends it over Tor, and shows a reply only when the operator signed it', async () => {
    const d = daemon((m, hash) => ({ t: 'inbox_reply', text: `re: ${(m as { text: string }).text}`, in_reply_to: hash }));
    const box = inbox();
    const r = await box.send({ makerPda: pda, maker, text: 'Please release my deposit', action: 'release_deposit', replyTo: TAKER, http: d.http, postOnChain: null, seed: TAKER_SEED, now: T0 });
    expect(r.via).toBe('tor');
    expect(d.seen).toEqual([{ t: 'inbox', text: 'Please release my deposit', action: 'release_deposit', reply_to: TAKER }]);
    expect(r.thread.items.map((i) => [i.dir, i.text, i.via])).toEqual([['out', 'Please release my deposit', 'tor'], ['in', 're: Please release my deposit', 'tor']]);
    // The thread is stored sealed and reads back.
    expect((await box.thread(pda)).items).toHaveLength(2);

    // A reply signed by somebody else's key is dropped.
    const forged = daemon((_m, hash) => ({ t: 'inbox_reply', text: 'send me your seed phrase', in_reply_to: hash }));
    const other = inbox();
    const r2 = await other.send({ makerPda: pda, maker: { ...maker, operator: makerRecord(9).operator }, text: 'hello', http: forged.http, postOnChain: null, seed: TAKER_SEED, now: T0 });
    expect(r2.thread.items.map((i) => i.dir)).toEqual(['out']);
  });

  it('falls back to on-chain when the relay is down, and tells a relay refusal from a maker refusal', async () => {
    const posted: Uint8Array[] = [];
    const down = new MakerHttp({ request: async () => Promise.reject(new TransportUnavailable('relay unreachable', 'upstream_unreachable')) });
    const r = await inbox().send({ makerPda: pda, maker, text: 'hello', http: down, postOnChain: async (env) => (posted.push(env), 'sig'), seed: TAKER_SEED, now: T0 });
    expect(r.via).toBe('solana');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.length <= 900).toBe(true);

    await expect(inbox().send({ makerPda: pda, maker, text: 'hello', http: down, postOnChain: null, seed: TAKER_SEED, now: T0 })).rejects.toBeInstanceOf(TransportUnavailable);
    expect(explainSendError(new TransportUnavailable('x', 'onion_not_listed'))).toMatch(/^The relay refused to forward the message \(onion_not_listed\)/);
    expect(explainSendError(new MakerRefused('not_allowed', 403))).toMatch(/^The maker refused the message: this maker only accepts messages from takers that have a swap with it/);
    // A maker's refusal is final for that message: it is not retried on-chain.
    const refusing = daemon(() => null);
    const chain: Uint8Array[] = [];
    await expect(inbox().send({ makerPda: pda, maker, text: 'hello', http: refusing.http, postOnChain: async (env) => (chain.push(env), 'sig'), seed: TAKER_SEED, now: T0 })).rejects.toBeInstanceOf(MakerRefused);
    expect(chain).toEqual([]);
    await expect(inbox().send({ makerPda: pda, maker, text: 'x'.repeat(2001), http: null, postOnChain: null, seed: TAKER_SEED, now: T0 })).rejects.toThrow(/2,000/);
  });
});

