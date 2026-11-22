/**
 * The taker's side of the built-in encrypted inbox (DESIGN "Contacting a maker", SPEC 6.1, 6.2).
 *
 * A message is sealed in the page to the maker's current registry key and sent over Tor (through
 * the relay, or directly from Tor Browser) when the maker lists an onion address, otherwise
 * on-chain through the program. Replies are sealed to the taker's key and signed by the maker's
 * operator key; a reply is shown only after that signature verifies against the registry.
 * Threads are kept on this device, sealed under a key derived from the recovery seed.
 */
import { envelopeHeader } from '@xmrswap/core-wasm';
import type { Maker, Message } from '@xmrswap/protocol';
import { type MakerHttp, type MessageTransport, type SendResult, type SolanaClient, contactKeys, envelopeHash, hex, keyBytes, openFromMaker, sealToMaker, sendWithFallback, solanaMessageTransport, torMessageTransport } from '@xmrswap/sdk';
import type { SealedStore } from './sealed.js';

export interface ThreadItem {
  dir: 'out' | 'in';
  text: string;
  /** Local time, ms. */
  at: number;
  via: 'tor' | 'solana' | 'ethereum';
  /** Hash of the request envelope (out) or the one it answers (in). */
  hash: string;
  /** The swap the message concerns, when there is one. */
  swap?: string;
  action?: 'release_deposit';
}
export interface Thread {
  maker: string;
  items: ThreadItem[];
  /** Newest on-chain signature already read. */
  cursor?: string;
}

export interface ReplyKey {
  encSecret: Uint8Array;
  encPub: Uint8Array;
  swapRef?: Uint8Array;
  swap?: string;
}

export interface SendInput {
  makerPda: string;
  maker: Maker;
  text: string;
  /** The taker's Solana address: where a later on-chain reply is posted. */
  replyTo?: string;
  action?: 'release_deposit';
  /** A swap-bound message uses the swap's own one-time key. */
  swap?: { ref: string; swapRef: Uint8Array; encSecret: Uint8Array };
  /** Tor route to the maker in the current connection mode, or `null`. */
  http: MakerHttp | null;
  /** Posts an envelope on-chain with the user's wallet; `null` when no wallet is connected. */
  postOnChain: ((envelope: Uint8Array) => Promise<string>) | null;
  seed: Uint8Array;
  now: bigint;
}

const threadName = (maker: string): string => `inbox.${maker}`;

export class Inbox {
  constructor(private readonly store: SealedStore) {}

  async thread(maker: string): Promise<Thread> {
    return (await this.store.get<Thread>(threadName(maker))) ?? { maker, items: [] };
  }
  private async save(t: Thread): Promise<void> {
    await this.store.put(threadName(t.maker), t);
  }

  /** Seal and send one message. Returns how it travelled and the maker's immediate reply, if any. */
  async send(i: SendInput): Promise<{ via: SendResult['via']; thread: Thread }> {
    if (i.text.trim().length === 0) throw new Error('Write a message first.');
    if (i.text.length > 2000) throw new Error('A message can be at most 2,000 characters.');
    const own = i.swap ? i.swap.encSecret : contactKeys(i.seed, i.makerPda).encSecret;
    const message: Message = { t: 'inbox', text: i.text, ...(i.action ? { action: i.action } : {}), ...(i.replyTo && !i.swap ? { reply_to: i.replyTo } : {}) };
    const transports: MessageTransport[] = [];
    if (i.http) transports.push(torMessageTransport(i.http));
    if (i.postOnChain) transports.push(solanaMessageTransport(i.postOnChain));
    if (transports.length === 0) throw new Error('There is no way to reach this maker right now: the relay is not available and no Solana wallet is connected for an on-chain message.');
    let sent: Uint8Array | null = null;
    const result = await sendWithFallback(transports, (t) => {
      sent = sealToMaker({ message, ownEncSecret: own, maker: i.maker, transport: t.kind, ...(i.swap ? { swapRef: i.swap.swapRef } : {}) });
      return sent;
    });
    const thread = await this.thread(i.makerPda);
    const hash = envelopeHash(sent!);
    thread.items.push({ dir: 'out', text: i.text, at: Date.now(), via: result.via, hash, ...(i.swap ? { swap: i.swap.ref } : {}), ...(i.action ? { action: i.action } : {}) });
    if (result.reply) this.accept(thread, result.reply, i.maker, { encSecret: own, encPub: new Uint8Array(0), ...(i.swap ? { swapRef: i.swap.swapRef, swap: i.swap.ref } : {}) }, i.now, 'tor');
    await this.save(thread);
    return { via: result.via, thread };
  }

  /** Verify and file one reply envelope. Anything that does not open or is not signed by the operator is dropped. */
  private accept(thread: Thread, envelope: Uint8Array, maker: Maker, key: ReplyKey, now: bigint, via: ThreadItem['via']): boolean {
    let m: Message;
    try {
      m = openFromMaker({ envelope, ownEncSecret: key.encSecret, maker, operatorPub: keyBytes(maker.operator), now, ...(key.swapRef ? { swapRef: key.swapRef } : {}) }).message;
    } catch {
      return false;
    }
    const text = m.t === 'inbox_reply' ? m.text : m.t === 'error' ? `The maker's inbox refused the message (${m.code}).` : m.t === 'ack' ? null : null;
    if (text === null) return false;
    const hash = m.t === 'inbox_reply' ? m.in_reply_to : envelopeHash(envelope);
    if (thread.items.some((x) => x.dir === 'in' && x.hash === hash && x.text === text)) return false;
    thread.items.push({ dir: 'in', text, at: Date.now(), via, hash, ...(key.swap ? { swap: key.swap } : {}) });
    return true;
  }

  /**
   * Collect later replies: from the maker's replies route over Tor, and from messages posted
   * on-chain to the taker's address. `keys` are the keys replies may be sealed to: the contact
   * key for this maker and the one-time keys of the swaps with it.
   */
  async refresh(a: { makerPda: string; maker: Maker; keys: ReplyKey[]; http: MakerHttp | null; solana: SolanaClient | null; taker: string | null; now: bigint }): Promise<Thread> {
    const thread = await this.thread(a.makerPda);
    let changed = false;
    if (a.http) {
      for (const k of a.keys) {
        try {
          for (const env of await a.http.replies(hex(k.encPub))) changed = this.accept(thread, env, a.maker, k, a.now, 'tor') || changed;
        } catch {
          // The relay or the onion service is unreachable: the on-chain copy below still arrives.
        }
      }
    }
    if (a.solana && a.taker) {
      try {
        const msgs = await a.solana.listMessages(a.taker, thread.cursor ? { until: thread.cursor } : {});
        for (const msg of msgs) {
          let pub: string;
          try {
            pub = hex(envelopeHeader(msg.payload).takerPub);
          } catch {
            continue;
          }
          const k = a.keys.find((x) => hex(x.encPub) === pub);
          if (k) changed = this.accept(thread, msg.payload, a.maker, k, a.now, 'solana') || changed;
          thread.cursor = msg.signature;
          changed = true;
        }
      } catch {
        // RPC hiccup: try again on the next refresh.
      }
    }
    if (changed) await this.save(thread);
    return thread;
  }
}
