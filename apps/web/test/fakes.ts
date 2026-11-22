/**
 * Test doubles for the UI's seams.
 *
 * `ModelChain` is a `ChainPort` whose swaps evolve by the SDK's reference state machine
 * (`apply`), with real derived keys, real notices and real secrets: a call the contracts would
 * refuse is refused here with the same error name, and a wrong secret never opens. The maker is
 * played by the test through `maker.*`. `FakeMonero` is a scripted `MoneroPort`.
 */
import { PublicKey } from '@solana/web3.js';
import type { DerivedKeys, SweepOutcome } from '@xmrswap/core-wasm';
import { type ChainName, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import {
  type CallMaterial,
  type FoundDeposit,
  type MakerProfile,
  NO_SWAP,
  type SwapView,
  type VerifyLockResult,
  apply,
  buildNotice,
  hex,
  makerShareKeys,
  mergedReputation,
  secretOpens,
  seedSigner,
  takerSwapKeys,
} from '@xmrswap/sdk';
import type { Maker, Offer } from '@xmrswap/protocol';
import type { GuardEnv } from '../src/lib/guard.js';
import { type OfferRow, solanaRow } from '../src/lib/market.js';
import type { CallDecision, ChainPort, MoneroPort, TxStatus } from '../src/lib/ports.js';
import { WalletNeeded, swapRefOf } from '../src/lib/ports.js';

export const XMR = 1_000_000_000_000n;
export const SOL = 1_000_000_000n;
export const T0 = 1_800_000_000n;
export const TAKER = seedSigner(new Uint8Array(32).fill(5)).publicKey;
export const TAKER_SEED = new Uint8Array(32).fill(42);
const MAKER_SEED = new Uint8Array(32).fill(77);
const zero32 = () => new Uint8Array(32);
const pda = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();

export interface LockOpts {
  xmr?: bigint;
  price?: bigint;
  mode?: number;
  direction?: 0 | 1;
  depth?: number;
  depBps?: number;
  wA?: number;
  dC?: number;
  seed?: Uint8Array;
  nonce?: Uint8Array;
  makerPda?: string;
  chain?: ChainName;
}

export class ModelChain implements ChainPort {
  readonly swaps = new Map<string, SwapView>();
  readonly makerShares = new Map<string, DerivedKeys>();
  readonly makerEnc = makerShareKeys(MAKER_SEED, 'solana', new Uint8Array(16).fill(1));
  /** Every call the taker's side executed: `[ref, call name, caller]`. */
  readonly calls: [string, string, string][] = [];
  now_ = T0;
  /** Make every request fail, like an unreachable RPC. */
  down = false;
  /** Make `exec` fail with this error once. */
  failNext: Error | null = null;
  /** Make every `exec` fail until cleared. */
  failAlways: Error | null = null;
  private counter = 0;

  constructor(readonly chain: ChainName = 'solana') {}

  private check(): void {
    if (this.down) throw new Error('fetch failed: connection refused');
  }
  async now(): Promise<bigint> {
    this.check();
    return this.now_;
  }
  async listSwaps(taker: string): Promise<SwapView[]> {
    this.check();
    return [...this.swaps.values()].filter((s) => s.taker === taker).map((s) => ({ ...s }));
  }
  async getSwap(ref: string): Promise<SwapView | null> {
    this.check();
    const s = this.swaps.get(ref);
    return s ? { ...s } : null;
  }
  advance(secs: number | bigint): void {
    this.now_ += BigInt(secs);
  }
  warpTo(t: bigint): void {
    if (t > this.now_) this.now_ = t;
  }

  /** The taker's `lock` (or `take`): what the wallet-signed open transaction does. */
  open(o: LockOpts = {}): { ref: string; keys: DerivedKeys; view: SwapView } {
    const direction = o.direction ?? 0;
    const xmr = o.xmr ?? XMR;
    const price = o.price ?? 150n * SOL / 100n;
    // A: the taker pays, rounded up. B: the maker escrows, rounded down (SPEC 3.1).
    const amount = direction === 0 ? (xmr * price + XMR - 1n) / XMR : (xmr * price) / XMR;
    const nonce = o.nonce ?? new Uint8Array(16).fill(++this.counter);
    const keys = takerSwapKeys(o.seed ?? TAKER_SEED, this.chain, nonce);
    const args = { xmr, offerMode: o.mode ?? 0, approval: false, amount, wA: o.wA ?? 60, wN: 600, dC: o.dC ?? 3600, wC: 1800, wF: 604_800, depth: o.depth ?? 2, depBps: o.depBps ?? 100 };
    const fx = apply(this.chain, NO_SWAP, { name: direction === 0 ? 'lock' : 'take', args }, 'taker', this.now_);
    const swapRef = new Uint8Array(32).fill(200 + this.counter);
    const share = fx.swap.state === SWAP_STATE.ACTIVE ? this.newShare() : null;
    const view: SwapView = {
      ...fx.swap,
      chain: this.chain,
      swapRef,
      taker: TAKER,
      maker: o.makerPda ?? pda(9),
      asset: '0',
      xmr,
      price,
      depBps: args.depBps,
      swapNonce: nonce,
      sessionKey: seedSigner(keys.sessionSecret).publicKey,
      takerEncKey: keys.encPub,
      makerEncVersion: 1,
      makerEncKey: this.makerEnc.encPub,
      takerSpendPub: keys.spendPub,
      makerSpendPub: share ? share.spendPub : zero32(),
      lockerView: direction === 0 ? keys.view : zero32(),
      noticeCommitment: zero32(),
      noticeCt: new Uint8Array(0),
      evidenceTxid: zero32(),
      evidenceView: zero32(),
      revealed: zero32(),
    };
    const ref = swapRefOf(view);
    this.swaps.set(ref, view);
    return { ref, keys, view };
  }

  private newShare(): DerivedKeys {
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(0, 1000 + ++this.counter);
    const k = makerShareKeys(MAKER_SEED, this.chain, id);
    this.makerShares.set(hex(k.spendPub), k);
    return k;
  }
  shareOf(ref: string): DerivedKeys {
    return this.makerShares.get(hex(this.swaps.get(ref)!.makerSpendPub))!;
  }

  private transition(ref: string, call: Parameters<typeof apply>[2], caller: Parameters<typeof apply>[3], patch: Partial<SwapView> = {}): void {
    const s = this.swaps.get(ref);
    if (!s) throw new Error('BadState: no such swap');
    const fx = apply(this.chain, s, call, caller, this.now_);
    if (fx.closed && this.chain === 'solana') this.swaps.delete(ref);
    else this.swaps.set(ref, { ...s, ...fx.swap, ...patch });
  }

  /** The maker's side, played by the test. */
  readonly maker = {
    approve: (ref: string) => {
      const share = this.newShare();
      this.transition(ref, { name: 'approve' }, 'operator', { makerSpendPub: share.spendPub });
    },
    fund: (ref: string) => {
      const share = this.newShare();
      this.transition(ref, { name: 'fund' }, 'operator', { makerSpendPub: share.spendPub, lockerView: share.view });
    },
    reject: (ref: string) => this.transition(ref, { name: 'reject', reason: 0 }, 'operator'),
    /** Post a lock notice naming `txid`. `honest: false` posts a ciphertext that does not open. */
    notice: (ref: string, txid: string, honest = true) => {
      const s = this.swaps.get(ref)!;
      const share = this.shareOf(ref);
      const n = buildNotice(s, this.makerEnc.encSecret, Uint8Array.from(Buffer.from(txid, 'hex')), share.view);
      const ct = honest ? n.ciphertext : n.ciphertext.map((b, i) => (i === 50 ? b ^ 1 : b));
      this.transition(ref, { name: 'post_notice' }, 'operator', { noticeCommitment: n.commitment, noticeCt: ct });
    },
    ready: (ref: string) => this.transition(ref, { name: 'set_ready' }, 'operator'),
    claim: (ref: string) => this.transition(ref, { name: 'claim' }, 'operator', { revealed: this.shareOf(ref).spend }),
    refund: (ref: string) => this.transition(ref, { name: 'refund' }, 'operator', { revealed: this.shareOf(ref).spend }),
    abort: (ref: string) => this.transition(ref, { name: 'abort' }, 'operator'),
    withhold: (ref: string) => this.transition(ref, { name: 'withhold', evidence: 'opens' }, 'operator'),
  };

  /** The session key's budget is gone (swept back by a refund or claim): `anyone` calls then need the wallet. */
  sessionEmpty = false;
  async exec(s: SwapView, d: CallDecision, keys: DerivedKeys, m: CallMaterial, opts: { wallet?: boolean } = {}): Promise<string> {
    this.check();
    if ((d.caller === 'taker' || (d.caller === 'anyone' && this.sessionEmpty)) && !opts.wallet) throw new WalletNeeded(this.chain);
    if (this.failAlways) throw this.failAlways;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const ref = swapRefOf(s);
    const c = d.call;
    if (c.name === 'close_swap') {
      this.swaps.delete(ref);
    } else if (c.name === 'refund' || c.name === 'claim') {
      if (!m.secret || !secretOpens(s, m.secret, c.name)) throw new Error('ScalarMismatch');
      this.transition(ref, { name: c.name }, d.caller, { revealed: m.secret });
    } else if (c.name === 'post_notice') {
      if (!m.notice) throw new Error('post_notice needs the notice');
      this.transition(ref, c, d.caller, { noticeCommitment: m.notice.commitment, noticeCt: m.notice.ciphertext });
    } else {
      this.transition(ref, c as Parameters<typeof apply>[2], d.caller);
    }
    void keys;
    this.calls.push([ref, c.name, d.caller]);
    return `sig-${this.calls.length}`;
  }

  called(name: string): number {
    return this.calls.filter((c) => c[1] === name).length;
  }
}

export const hasFlag = (s: SwapView, f: keyof typeof SWAP_FLAG): boolean => (s.flags & SWAP_FLAG[f]) !== 0;

// ------------------------------------------------------------------ Monero

export interface FakeLock {
  state: VerifyLockResult['state'];
  confirmations: number;
  amount?: bigint;
  /** Extra reasons, for example a node that failed or disagreed. */
  reasons?: string[];
}

export class FakeMonero implements MoneroPort {
  readonly locks = new Map<string, FakeLock>();
  readonly sweeps: { destination: string; lockTxid: string; maxFee: bigint }[] = [];
  readonly txs = new Map<string, TxStatus>();
  deposits: FoundDeposit[] = [];
  policy: string | null = null;
  /** Make `verify` throw, like an unreachable node. */
  down = false;
  /** Errors thrown by the next sweep attempts, in order. */
  sweepFailures: string[] = [];
  tip = 1000;
  verifyCalls = 0;

  policyProblem(): string | null {
    return this.policy;
  }
  async verify(a: { txid: string; minAmount: bigint; minConf: number }): Promise<VerifyLockResult> {
    this.verifyCalls++;
    if (this.down) throw new Error('node-failed: connection refused');
    const l = this.locks.get(a.txid) ?? { state: 'not-found' as const, confirmations: 0 };
    const reasons = [...(l.reasons ?? [])];
    let state = l.state;
    // The seam reports depth; the verdict against `minConf` is made here as `verifyLock` makes it.
    if ((state === 'confirmed' || state === 'confirming') && reasons.length === 0) state = l.confirmations >= a.minConf ? 'confirmed' : 'confirming';
    const amount = l.amount ?? a.minAmount;
    const ok = state === 'confirmed' && reasons.length === 0;
    const mined = state === 'confirmed' || state === 'confirming';
    return { ok, state, reasons, codes: reasons.map((r) => r.split(':')[0]) as VerifyLockResult['codes'], amount, confirmations: l.confirmations, outputIndex: mined ? 0 : undefined, blockHeight: mined ? this.tip - l.confirmations : undefined, outputs: [], nodes: [] };
  }
  async findDeposits(): Promise<{ tipHeight: number; found: FoundDeposit[] }> {
    if (this.down) throw new Error('connection refused');
    return { tipHeight: this.tip, found: this.deposits };
  }
  async height(): Promise<number> {
    return this.tip;
  }
  async txStatus(txid: string): Promise<TxStatus> {
    return this.txs.get(txid) ?? 'unknown';
  }
  async sweep(p: { destination: string; lockTxid: Uint8Array; maxFee: bigint }): Promise<SweepOutcome> {
    const fail = this.sweepFailures.shift();
    if (fail) throw new Error(fail);
    const txid = `5${String(this.sweeps.length).padStart(63, 'e')}`;
    this.sweeps.push({ destination: p.destination, lockTxid: hex(p.lockTxid), maxFee: p.maxFee });
    this.txs.set(txid, 'pool');
    return { jointAddress: '4joint', txid, amount: XMR - 1000n, fee: 1000n, txHex: '00', published: true, ignored: [] };
  }
}

// ------------------------------------------------------------------ registry rows

const counters = (set: Record<number, number> = {}): number[] => Array.from({ length: 40 }, (_x, i) => set[i] ?? 0);

export function makerRecord(n: number, o: { counters?: Record<number, number>; volume?: bigint; onion?: string; contacts?: Maker['contacts']; responseSecsSum?: bigint } = {}): Maker {
  return {
    owner: pda(n + 100),
    operator: seedSigner(new Uint8Array(32).fill(n)).publicKey,
    payout: pda(n + 150),
    encKey: makerShareKeys(MAKER_SEED, 'solana', new Uint8Array(16).fill(1)).encPub,
    encKeyVersion: 1,
    prevEncKey: zero32(),
    prevEncKeyExpiresAt: 0n,
    approvalEpoch: 0,
    quoteEpoch: 0,
    paused: 0,
    inboxPolicy: 0,
    openPending: 0,
    registeredSlot: 1n,
    registeredAt: T0 - 1000n,
    ethLink: new Uint8Array(20),
    ethLinkNext: new Uint8Array(20),
    ethLinkNextAt: 0n,
    counters: counters(o.counters),
    responseSecsSum: o.responseSecsSum ?? 0n,
    volume: [o.volume ?? 0n, 0n],
    withheldVolume: [0n, 0n],
    bump: 255,
    onion: o.onion ?? '',
    contacts: o.contacts ?? [],
  };
}

export function profile(n: number, o: Parameters<typeof makerRecord>[1] = {}): MakerProfile {
  const solana = makerRecord(n, o);
  return { pda: pda(n), solana, ethereum: null, identity: mergedReputation(solana, null, { solana: T0, ethereum: T0 }), onion: solana.onion || null, blobEndpoint: null };
}

export function offer(maker: string, o: Partial<Offer> & { price?: bigint } = {}): Offer {
  const { price, ...rest } = o;
  return {
    maker,
    asset: 0,
    direction: 0,
    enabled: 1,
    mode: 0,
    bump: 255,
    seq: 1n,
    updatedAt: T0,
    validSecs: 3600,
    minXmr: XMR / 100n,
    maxXmr: 1000n * XMR,
    capacityXmr: 1000n * XMR,
    priceAbove: [0n, 0n, 0n],
    prices: [price ?? (150n * SOL) / 100n, 0n, 0n],
    depthAbove: [0n, 0n, 0n],
    depths: Uint8Array.of(2, 0, 0),
    depBps: 100,
    wA: 60,
    wN: 600,
    dC: 3600,
    wC: 1800,
    wF: 604_800,
    termsHash: zero32(),
    poolFilled: 0xff,
    poolUsed: 0,
    pool: Array.from({ length: 16 }, () => zero32()),
    reserved: new Uint8Array(0),
    ...rest,
  };
}

export function row(n: number, o: Partial<Offer> & { price?: bigint } = {}, m: Parameters<typeof makerRecord>[1] = {}): OfferRow {
  const p = profile(n, m);
  return solanaRow(pda(n + 50), offer(p.pda, o), p, null);
}

// ------------------------------------------------------------------ browser environment for the guard

export function fakeGuardEnv(opts: { wakeLock?: boolean } = {}): GuardEnv & { beeps: number; notes: [string, string][]; wakeRequests: number; released: number; unloadHandlers: Set<(e: BeforeUnloadEvent) => unknown>; doc: { title: string; visibilityState: DocumentVisibilityState } } {
  const unloadHandlers = new Set<(e: BeforeUnloadEvent) => unknown>();
  const doc = { title: '', visibilityState: 'visible' as DocumentVisibilityState, addEventListener() {}, removeEventListener() {} };
  const env = {
    beeps: 0,
    notes: [] as [string, string][],
    wakeRequests: 0,
    released: 0,
    unloadHandlers,
    doc,
    window: {
      addEventListener: (type: string, h: unknown) => void (type === 'beforeunload' && unloadHandlers.add(h as (e: BeforeUnloadEvent) => unknown)),
      removeEventListener: (type: string, h: unknown) => void (type === 'beforeunload' && unloadHandlers.delete(h as (e: BeforeUnloadEvent) => unknown)),
    } as unknown as GuardEnv['window'],
    document: doc as unknown as GuardEnv['document'],
    wakeLock:
      opts.wakeLock === false
        ? undefined
        : {
            request: async () => {
              env.wakeRequests++;
              const s = { released: false, release: async () => void ((s.released = true), env.released++) };
              return s;
            },
          },
    beep: () => void env.beeps++,
    notify: (t: string, b: string) => (env.notes.push([t, b]), true),
  };
  return env;
}
