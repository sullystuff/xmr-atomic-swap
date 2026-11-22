/**
 * Inbox (DESIGN "Contacting a maker"; SPEC 6.1, 6.2, 7.1 `inbox/`): reads envelopes from
 * Solana, Tor and Ethereum events, decrypts each with the key version it names, stores it
 * beside its swap, answers requests, and sends replies. Applies the inbox policy.
 *
 * Messages carry requests and conversation only. Nothing safety-critical depends on them.
 */
import { envelopeHeader } from '@xmrswap/core-wasm';
import { INBOX_TEXT_MAX_CHARS, type ErrorCode, type Message, REPLY_RETENTION_DAYS, base58Encode } from '@xmrswap/protocol';
import type { InboxItem } from '@xmrswap/protocol/daemon-api';
import { type MakerEncState, SdkError, type SwapView, envelopeHash, hex0x, openFromTaker, sealToTaker } from '@xmrswap/sdk';
import type { Approvals } from '../approvals/index.js';
import type { SolanaChain } from '../chains/solana.js';
import type { Keystore } from '../keystore/index.js';
import type { OfferEngine } from '../offers/engine.js';
import type { EncKeys } from '../rotation/index.js';
import type { MessageRow, Store } from '../store/db.js';
import type { Journal } from '../store/journal.js';
import { type Bytes, Emitter, errMsg, fromJson, hex } from '../util.js';

export type Transport = 'solana' | 'tor' | 'ethereum';

/** A refusal the transport reports as an error code (`stale_key`, `rate_limited`, …). */
export class InboxRefusal extends Error {
  constructor(
    readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'InboxRefusal';
  }
}

export interface InboxOptions {
  store: Store;
  keystore: Keystore;
  encKeys: EncKeys;
  journal: Journal;
  approvals: Pick<Approvals, 'answerRequest'>;
  offers: Pick<OfferEngine, 'quoteOnRequest'>;
  policy: () => 'open' | 'swap_only';
  /** The registry's view of the maker's keys and the chain time the versions are judged at. */
  makerState: () => Promise<{ maker: Pick<MakerEncState, 'encKey' | 'encKeyVersion' | 'prevEncKey' | 'prevEncKeyExpiresAt'>; now: bigint }>;
  solana: () => SolanaChain | null;
  /** Whether on-chain replies may be sent (live mode). */
  live: () => boolean;
  /** Messages a taker key may send per minute. */
  perKeyPerMinute?: number;
}

export const inboxItem = (m: MessageRow): InboxItem => ({ id: m.id, at: m.at, direction: m.direction, transport: m.transport, type: m.type, swap_ref: m.swap_ref, peer: m.peer, text: m.text, action: m.action === 'release_deposit' ? 'release_deposit' : null, read: m.read === 1, in_reply_to: m.in_reply_to });

const zero32 = (b: Bytes): boolean => b.every((x) => x === 0);

export class Inbox {
  readonly events = new Emitter<{ message: InboxItem }>();
  private rate = new Map<string, { window: number; count: number }>();

  constructor(private readonly o: InboxOptions) {}

  /** The swap a 32-byte `swap_ref` names in this database: base58 (Solana) or 0x-hex (Ethereum). */
  private swapOf(swapRef: Bytes): { ref: string; view: SwapView | null } | null {
    if (zero32(swapRef)) return null;
    for (const ref of [base58Encode(swapRef), hex0x(swapRef)]) {
      const row = this.o.store.swap(ref);
      if (row) return { ref, view: row.snapshot ? fromJson<SwapView>(row.snapshot) : null };
    }
    return null;
  }

  private limit(takerPub: string): void {
    const window = Math.floor(this.o.store.now() / 60);
    const cur = this.rate.get(takerPub);
    const count = cur && cur.window === window ? cur.count + 1 : 1;
    this.rate.set(takerPub, { window, count });
    if (this.rate.size > 10_000) for (const [k, v] of this.rate) if (v.window !== window) this.rate.delete(k);
    if (count > (this.o.perKeyPerMinute ?? 20)) throw new InboxRefusal('rate_limited');
  }

  /**
   * Handle one envelope from a taker. Returns the signed reply envelope (the immediate HTTP
   * response over Tor; posted on-chain by `deliver` for the on-chain transports), or throws an
   * `InboxRefusal` whose code the transport reports.
   */
  async handle(envelope: Bytes, transport: Transport, meta: { sender?: string } = {}): Promise<Bytes> {
    let header;
    try {
      header = envelopeHeader(envelope);
    } catch {
      throw new InboxRefusal('bad_request', 'not an envelope');
    }
    this.limit(hex(header.takerPub));
    const state = await this.o.makerState();
    let message: Message;
    try {
      ({ message } = openFromTaker({ envelope, maker: state.maker, secretFor: this.o.encKeys.secretFor, now: state.now, transport }));
    } catch (e) {
      const code = e instanceof SdkError && ['stale_key', 'too_large', 'bad_request'].includes(e.code) ? (e.code as ErrorCode) : 'bad_request';
      throw new InboxRefusal(code, code === 'bad_request' ? undefined : errMsg(e));
    }
    const swap = this.swapOf(header.swapRef);
    // A swap-bound message must come from that swap's one-time key; anyone else is talking about a swap that is not theirs.
    if (swap?.view && hex(swap.view.takerEncKey) !== hex(header.takerPub)) throw new InboxRefusal('not_allowed', 'not the key of that swap');
    if (!zero32(header.swapRef) && !swap) throw new InboxRefusal('not_allowed', 'unknown swap');
    if (this.o.policy() === 'swap_only' && !swap && message.t === 'inbox') throw new InboxRefusal('not_allowed', 'this maker reads messages only from takers with a swap');

    const id = envelopeHash(envelope);
    const replyTo = 'reply_to' in message && typeof message.reply_to === 'string' ? message.reply_to : null;
    const peer = meta.sender ?? (swap?.view ? swap.view.taker : hex(header.takerPub));
    const fresh = this.o.store.insertMessage({
      id, at: this.o.store.now(), direction: 'in', transport, type: message.t, swap_ref: swap?.ref ?? null, peer,
      text: message.t === 'inbox' ? message.text.slice(0, INBOX_TEXT_MAX_CHARS) : 'note' in message && typeof message.note === 'string' ? message.note.slice(0, INBOX_TEXT_MAX_CHARS) : null,
      action: message.t === 'inbox' && message.action ? message.action : null, in_reply_to: null, taker_pub: hex(header.takerPub), key_version: header.makerKeyVersion, reply_to: replyTo,
    });
    if (fresh) this.events.emit('message', inboxItem(this.o.store.message(id)!));

    let reply: Message;
    switch (message.t) {
      case 'quote_request':
        reply = await this.o.offers.quoteOnRequest(message);
        break;
      case 'approval_request':
        reply = await this.o.approvals.answerRequest(message);
        break;
      case 'inbox':
        // The request the contract cannot settle: releasing a withheld deposit. It is shown beside the swap; the maker decides.
        if (fresh && message.action === 'release_deposit' && swap) this.o.store.patchFacts(swap.ref, { releaseRequested: true });
        reply = { t: 'ack', in_reply_to: id };
        break;
      default:
        reply = { t: 'ack', in_reply_to: id };
    }
    return this.seal(reply, header.makerKeyVersion, header.takerPub, zero32(header.swapRef) ? undefined : header.swapRef, transport);
  }

  private seal(message: Message, version: number, takerPub: Bytes, swapRef: Bytes | undefined, transport: Transport): Bytes {
    const secret = this.o.encKeys.secretFor(version);
    if (!secret) throw new InboxRefusal('stale_key');
    return sealToTaker({ message, makerEncSecret: secret, makerKeyVersion: version, takerPub, ...(swapRef ? { swapRef } : {}), operatorSeed: this.o.keystore.solanaOperatorSeed, transport });
  }

  /** Post an envelope to a taker's Solana address with `post_message` (the on-chain reply path). */
  private async post(recipient: string, envelope: Bytes, swap: string | null): Promise<string | null> {
    const sol = this.o.solana();
    if (!sol || !this.o.live()) return null;
    const { tx } = await this.o.journal.broadcast('sol_tx', null, { call: 'post_message', recipient }, (onSigned) => sol.sendInstructions([sol.client.program.postMessage(sol.operator, recipient, envelope, swap)], onSigned));
    return tx;
  }

  /**
   * An envelope that arrived on-chain: handle it and deliver the answer on-chain when it is
   * more than an acknowledgement (a transaction fee per message; acks are not worth one).
   */
  async deliver(envelope: Bytes, transport: 'solana' | 'ethereum', sender: string): Promise<void> {
    if (this.o.store.message(envelopeHash(envelope))) return; // already processed (a re-read after a restart)
    let reply: Bytes;
    try {
      reply = await this.handle(envelope, transport, { sender });
    } catch (e) {
      if (e instanceof InboxRefusal) return; // on-chain there is nobody to tell; the client re-reads the registry and retries
      throw e;
    }
    const row = this.o.store.message(envelopeHash(envelope));
    if (!row || row.type === 'inbox' || row.type === 'ack' || row.type === 'notice_copy') return;
    const header = envelopeHeader(envelope);
    this.o.store.addReply(hex(header.takerPub), reply);
    const to = row.reply_to ?? (transport === 'solana' ? sender : null);
    if (to) await this.post(to, reply, null).catch(() => null);
  }

  /** The maker's reply to a stored message: kept 30 days at the replies route, and posted on-chain when the taker gave a `reply_to`. */
  async reply(id: string, text: string): Promise<InboxItem> {
    const m = this.o.store.message(id);
    if (!m || m.direction !== 'in' || !m.taker_pub || m.key_version === null) throw new Error('no such message to reply to');
    if (text.length === 0 || text.length > INBOX_TEXT_MAX_CHARS) throw new Error(`a reply is 1 to ${INBOX_TEXT_MAX_CHARS} characters`);
    const swapRef = m.swap_ref ? this.swapBytes(m.swap_ref) : undefined;
    const takerPub = Uint8Array.from(Buffer.from(m.taker_pub, 'hex'));
    const message: Message = { t: 'inbox_reply', text, in_reply_to: id };
    // Sealed under the on-chain cap when it fits, so one envelope serves both paths.
    let envelope: Bytes;
    let onChain = true;
    try {
      envelope = this.seal(message, m.key_version, takerPub, swapRef, 'solana');
    } catch (e) {
      if (e instanceof InboxRefusal) throw new Error('the key this message was sent to is gone; the taker must write again');
      envelope = this.seal(message, m.key_version, takerPub, swapRef, 'tor');
      onChain = false;
    }
    this.o.store.addReply(m.taker_pub, envelope);
    const outId = envelopeHash(envelope);
    this.o.store.insertMessage({ id: outId, at: this.o.store.now(), direction: 'out', transport: m.transport, type: 'inbox_reply', swap_ref: m.swap_ref, peer: m.peer, text, action: null, in_reply_to: id, taker_pub: m.taker_pub, key_version: m.key_version, reply_to: m.reply_to, read: 1 });
    this.o.store.markRead(id);
    if (onChain && m.reply_to) await this.post(m.reply_to, envelope, null).catch(() => null);
    const item = inboxItem(this.o.store.message(outId)!);
    this.events.emit('message', item);
    return item;
  }
  private swapBytes(ref: string): Bytes | undefined {
    const row = this.o.store.swap(ref);
    return row?.snapshot ? fromJson<SwapView>(row.snapshot).swapRef : undefined;
  }

  /** Reply envelopes addressed to a taker key, newest first (`GET /xs/v1/replies/<taker_pub>`). Ciphertext only. */
  replies(takerPubHex: string): Bytes[] {
    return this.o.store.replies(takerPubHex, REPLY_RETENTION_DAYS * 86_400);
  }
  items(swapRef?: string): InboxItem[] {
    return this.o.store.messages(swapRef).map(inboxItem);
  }
  markRead(id: string): InboxItem {
    this.o.store.markRead(id);
    const m = this.o.store.message(id);
    if (!m) throw new Error('no such message');
    return inboxItem(m);
  }

  /** One catch-up pass over the Solana messages posted to the maker PDA, from the stored cursor. */
  async pollSolana(): Promise<number> {
    const sol = this.o.solana();
    if (!sol) return 0;
    const cursor = this.o.store.meta('sol_msg_cursor');
    const got = await sol.client.listMessages(sol.makerPda, cursor ? { until: cursor } : {});
    for (const m of got) {
      await this.deliver(m.payload, 'solana', m.sender);
      this.o.store.setMeta('sol_msg_cursor', m.signature);
    }
    return got.length;
  }
}
