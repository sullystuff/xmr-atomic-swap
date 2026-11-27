/**
 * The swap engine: the loop of SPEC 7.9 for the taker's side.
 *
 *   read the swap → `takerStep(facts)` → do what it says → repeat
 *
 * The engine never decides a state-machine step itself. It gathers the facts the flow asks for
 * (the notice opening, a `verifyLock` run against every configured node, the user's wish to
 * cancel, whether the XMR was paid or swept), carries out the call or off-chain action the flow
 * returns, and records what happened for the interface. It holds no state that matters: after a
 * reload everything is rebuilt from the chain plus the recovery seed (SPEC 8.4); the notes kept
 * in local storage are conveniences (the sweep destination, the txid of a sweep already sent).
 *
 * Fail closed: a Monero verification that throws, disagrees or cannot reach a node counts as
 * "not confirmed", so at the refund cutoff the flow refunds.
 */
import type { DerivedKeys, JointAddress, Network } from '@xmrswap/core-wasm';
import { type ChainName, COUNTER, MONERO_LOCK_WINDOW, type Market, SWAP_STATE, sweepMaxFee } from '@xmrswap/protocol';
import {
  type CallMaterial,
  type Decision,
  type LegState,
  type LockReport,
  type Refusal,
  type SwapView,
  type VerifyLockResult,
  buildNotice,
  deadlinesOf,
  endedInClaim,
  endedInRefund,
  exportJointWallet,
  hex,
  isZero,
  jointSpendKey,
  legState,
  lockReport,
  openNotice,
  resumeSwapKeys,
  swapJointAddress,
  takerAtRisk,
  takerRefundDeadline,
  freezeRefusal,
  takerStep,
  unhex,
} from '@xmrswap/sdk';
import { type ChainPort, type MoneroPort, WalletNeeded, swapRefOf } from './ports.js';
import { type WatcherNote, acknowledged, watcherRefusalText } from './watcher.js';
import { local } from './storage.js';

/** Non-secret notes about one swap, kept in local storage. Losing them never loses funds. */
export interface SwapNote {
  market?: Market;
  /** A: where the XMR is swept. B: where the XMR returns if the maker refunds. */
  destination?: string;
  /** The user asked to get out. */
  cancel?: boolean;
  /** B: the taker's own payment, once found. */
  paidTxid?: string;
  /** B: Monero height when the address was first shown (where the deposit scan starts). */
  scanFrom?: number;
  lockTxid?: string;
  sweepTxid?: string;
  sweepAmount?: string;
  sweepFee?: string;
  sweepConfirmed?: boolean;
  /** The user exported the joint wallet's keys instead of sweeping. */
  exported?: boolean;
  /** The tab refunded by itself at the cutoff. */
  autoRefunded?: boolean;
  /** Large swap this leg belongs to. */
  orderId?: string;
  /** Last figures seen, so a closed account can still be described. */
  xmr?: string;
  amount?: string;
  direction?: number;
  lastState?: number;
  /** The watcher named at lock, and its acknowledgement once verified (SPEC 11.6). */
  watcher?: WatcherNote;
  /** The user asked to pause (freeze) the swap from this tab. */
  freeze?: boolean;
  /** This tab sent the freeze (otherwise the watcher did). */
  frozeMyself?: boolean;
  /** The swap was seen paused (FROZEN): what happened afterwards is explained with that in mind. */
  wasFrozen?: boolean;
  /** Direction B: the payout address named at take, when it is not the taking wallet. */
  payout?: string;
  /** How the swap ended, once known: survives the account being closed. */
  ended?: 'claim' | 'refund';
  /** The account was seen on-chain and is now gone. */
  closed?: boolean;
  openedAt?: number;
}

export type SweepPhase =
  | { phase: 'idle' }
  | { phase: 'need-destination' }
  /** The XMR is the user's; consensus lets it move once the lock is 10 blocks deep. */
  | { phase: 'waiting'; blocksLeft: number }
  | { phase: 'building' }
  | { phase: 'broadcast'; txid: string }
  | { phase: 'confirmed'; txid: string }
  /** Nothing was spent; the attempt is repeated. The keys can be exported at any time. */
  | { phase: 'failed'; error: string; attempts: number };

export type ProofStatus =
  | { phase: 'idle' }
  /** Downloading (about 57 kB) and verifying. */
  | { phase: 'checking'; attempts: number }
  | { phase: 'ok' }
  /** The proof does not verify: the address is never shown. */
  | { phase: 'invalid' }
  /** The last attempt failed for a reason that may pass; the next one is scheduled. */
  | { phase: 'retrying'; error: string; attempts: number; nextAtMs: number };

export interface Tracked {
  ref: string;
  chain: ChainName;
  /** `null` once the account is gone (a full refund closes it; so does closing after a sweep). */
  view: SwapView | null;
  /** `null` when the loaded recovery seed did not open this swap (it was made with another file). */
  keys: DerivedKeys | null;
  decision: Decision | null;
  leg: LegState;
  atRisk: boolean;
  /** Last chain second at which the tab can still refund by itself, when at risk. */
  refundDeadline: bigint | null;
  noticeOpens: boolean | undefined;
  joint: JointAddress | null;
  lockTxid: string | null;
  lock: VerifyLockResult | null;
  /** Why Monero verification could not run (node policy, unreachable node). Counts as "not confirmed". */
  lockError: string | null;
  sweep: SweepPhase;
  /** What the engine is doing right now, for the status line. */
  busy: string | null;
  /** The last action failed; it will be retried on the next pass. */
  error: string | null;
  /** A wallet signature is needed to continue. */
  needsWallet: boolean;
  /** Plain statement of a loss or a missed deadline, when there is one. */
  lost: string | null;
  /**
   * A newer state of this swap is in a block but not final yet (Ethereum). The tab acts on final
   * state only; this is what it is waiting for, and roughly how long finality still needs.
   */
  pending: { view: SwapView; etaSecs: number | null } | null;
  /** Ethereum direction B: the check of the maker's key proof for the share it funded with. */
  proof: ProofStatus;
  /** Registration with the watcher the swap names. `acknowledged` only after its signed acknowledgement verified. */
  watch: { phase: 'none' | 'registering' | 'acknowledged' | 'failed'; error?: string };
  /** A watcher has acknowledged this swap and it is still in a state a pause can protect. */
  watched: boolean;
  /** Why this tab cannot pause the swap right now; `null` = it can. */
  freezeRefusal: Refusal | null;
  /** Why a request to get out (refund, cancel, abort) would be refused right now; `null` = it would be carried out. */
  exitRefusal: Refusal | null;
  note: SwapNote;
}

export interface Health {
  ok: boolean;
  error: string | null;
  /** Local time of the last successful contact. */
  lastOk: number | null;
}

export interface EngineState {
  swaps: Tracked[];
  /** Chain time per chain, with the local time it was read at, for countdowns between polls. */
  clock: Partial<Record<ChainName, { chain: bigint; at: number }>>;
  health: { solana: Health; ethereum: Health; monero: Health };
  /** At least one full pass has completed since the last (re)start. */
  ready: boolean;
  /** Local clock minus chain time, seconds. */
  skewSecs: number | null;
}

export interface EngineDeps {
  ports: () => Partial<Record<ChainName, ChainPort>>;
  monero: MoneroPort;
  /** The recovery seed, or `null` while the vault is locked. */
  seed: () => Uint8Array | null;
  /** Wallet addresses whose swaps to follow, per chain. */
  takers: () => Partial<Record<ChainName, string[]>>;
  network: () => Network;
  /** Ethereum direction B: fetch and verify the maker's proof for the funded share. `undefined` = could not be checked yet. */
  makerProof?: (s: SwapView) => Promise<{ ok: true } | { ok: false } | { retry: string }>;
  /** Longest one proof attempt may take before it counts as failed and is retried. */
  proofTimeoutMs?: number;
  /** Hand a swap that names a watcher to it; resolves with the verified acknowledgement. */
  registerWatcher?: (w: WatcherNote, s: SwapView, keys: DerivedKeys, now: bigint) => Promise<{ watching_until: number; sig: string; swap_ref: string }>;
  /** Override of the sweep fee cap (regtest). */
  sweepMaxFee?: () => bigint | null;
  nowMs?: () => number;
}

const NOTE_PREFIX = 'xmrswap.note.';
const healthy = (): Health => ({ ok: true, error: null, lastOk: null });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const loadNote = (ref: string): SwapNote => local.get<SwapNote>(NOTE_PREFIX + ref, {});
export const saveNote = (ref: string, note: SwapNote): void => local.set(NOTE_PREFIX + ref, note);
export function knownRefs(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(NOTE_PREFIX)) out.push(k.slice(NOTE_PREFIX.length));
    }
  } catch {
    // no storage
  }
  return out;
}

/** A leg is at risk when the taker paid the chain asset and it is locked but not yet Ready or Refunded (SPEC 8.5). */
export const isAtRisk = (t: Pick<Tracked, 'view'>): boolean => t.view !== null && takerAtRisk(t.view);

export class Engine {
  private state: EngineState = { swaps: [], clock: {}, health: { solana: healthy(), ethereum: healthy(), monero: healthy() }, ready: false, skewSecs: null };
  private readonly tracked = new Map<string, Tracked>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private sweepMisses = new Map<string, number>();
  private readonly nowMs: () => number;
  /** Swaps whose next wallet-signed call the user asked for. */
  private readonly walletOk = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  subscribe = (f: () => void): (() => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
  getState = (): EngineState => this.state;
  private emit(): void {
    this.state = { ...this.state, swaps: [...this.tracked.values()].sort((a, b) => (b.note.openedAt ?? 0) - (a.note.openedAt ?? 0)) };
    for (const f of this.listeners) f();
  }

  get(ref: string): Tracked | undefined {
    return this.tracked.get(ref);
  }

  /** Change a swap's notes (destination, cancel request) and run a pass. */
  annotate(ref: string, patch: Partial<SwapNote>): void {
    const note = { ...loadNote(ref), ...patch };
    saveNote(ref, note);
    const t = this.tracked.get(ref);
    if (t) {
      t.note = note;
      this.emit();
    }
    void this.poll();
  }

  start(pollMs: number): void {
    this.stop();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), pollMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One full pass over every chain. Concurrent calls collapse into one more pass after the running one. */
  poll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private setHealth(source: 'solana' | 'ethereum' | 'monero', error: string | null): void {
    const h = this.state.health[source];
    this.state = { ...this.state, health: { ...this.state.health, [source]: error === null ? { ok: true, error: null, lastOk: this.nowMs() } : { ok: false, error, lastOk: h.lastOk } } };
  }

  private async pass(): Promise<void> {
    const ports = this.deps.ports();
    const takers = this.deps.takers();
    for (const chain of ['solana', 'ethereum'] as const) {
      const port = ports[chain];
      if (!port) continue;
      let now: bigint;
      let views: SwapView[];
      try {
        now = await port.now();
        views = (await Promise.all((takers[chain] ?? []).map((a) => port.listSwaps(a)))).flat();
        this.setHealth(chain, null);
      } catch (e) {
        this.setHealth(chain, message(e));
        this.emit();
        continue;
      }
      const at = this.nowMs();
      this.state = { ...this.state, clock: { ...this.state.clock, [chain]: { chain: now, at } }, skewSecs: Math.round(at / 1000 - Number(now)) };
      const seen = new Set<string>();
      for (const v of views) {
        const ref = swapRefOf(v);
        seen.add(ref);
        const t = this.track(ref, chain);
        t.view = v;
      }
      // Swaps this browser knows that are no longer on-chain: the account was closed.
      for (const ref of knownRefs()) {
        const isSol = !ref.startsWith('0x');
        if ((chain === 'solana') !== isSol || seen.has(ref)) continue;
        const t = this.track(ref, chain);
        if (t.note.closed) {
          t.view = null;
          continue;
        }
        // Missing from the list: read the account itself before calling it closed.
        try {
          t.view = await port.getSwap(ref);
          if (t.view === null && t.note.lastState !== undefined) this.patchNote(t, { closed: true });
        } catch (e) {
          this.setHealth(chain, message(e));
        }
      }
      // Where state is acted on only once final, see what the newest block already shows, for display.
      let fin: { latestTime: bigint; finalizedTime: bigint } | null = null;
      if (port.peek && port.finality) {
        try {
          fin = await port.finality();
        } catch {
          fin = null;
        }
      }
      for (const t of this.tracked.values()) {
        if (t.chain !== chain) continue;
        if (port.peek && fin && !t.note.closed && (t.view === null || t.view.state !== SWAP_STATE.DONE)) {
          try {
            const head = await port.peek(t.ref);
            t.pending = head && (t.view === null || head.state !== t.view.state) ? { view: head, etaSecs: finalityEta(head, fin) } : null;
          } catch {
            t.pending = null;
          }
        } else t.pending = null;
        try {
          await this.advance(t, port, now);
        } catch (e) {
          t.error = message(e);
          t.busy = null;
        }
        this.describe(t, now);
        this.emit();
      }
    }
    this.state = { ...this.state, ready: true };
    this.emit();
  }

  private track(ref: string, chain: ChainName): Tracked {
    let t = this.tracked.get(ref);
    if (!t) {
      t = { ref, chain, view: null, keys: null, decision: null, leg: 'planned', atRisk: false, refundDeadline: null, noticeOpens: undefined, joint: null, lockTxid: null, lock: null, lockError: null, sweep: { phase: 'idle' }, busy: null, error: null, needsWallet: false, lost: null, pending: null, proof: { phase: 'idle' }, watch: { phase: 'none' }, watched: false, freezeRefusal: null, exitRefusal: null, note: loadNote(ref) };
      this.tracked.set(ref, t);
    }
    return t;
  }

  /** Follow a swap that was just opened, before the next list call sees it. */
  adopt(view: SwapView, note: SwapNote): void {
    const ref = swapRefOf(view);
    saveNote(ref, { ...loadNote(ref), ...note, openedAt: note.openedAt ?? Math.floor(this.nowMs() / 1000) });
    const t = this.track(ref, view.chain);
    t.view = view;
    t.note = loadNote(ref);
    this.describe(t, this.state.clock[view.chain]?.chain ?? view.tLock);
    this.emit();
    void this.poll();
  }

  private keysFor(t: Tracked): DerivedKeys | null {
    if (t.keys) return t.keys;
    const seed = this.deps.seed();
    if (!seed || !t.view) return null;
    try {
      const k = resumeSwapKeys(seed, t.chain, t.view.swapNonce);
      // The swap must have been opened with this seed: its stored commitment is ours.
      if (hex(k.spendPub) !== hex(t.view.takerSpendPub)) return null;
      t.keys = k;
      return k;
    } catch {
      return null;
    }
  }

  /** The joint address and the lock txid, recomputed from the halves. Never taken from the counterparty. */
  private ensureJoint(t: Tracked, keys: DerivedKeys): void {
    const s = t.view!;
    if (t.joint || isZero(s.makerSpendPub)) return;
    if (s.direction === 1) {
      // The taker is the claimer: its own view share completes the address.
      if (isZero(s.lockerView)) return;
      t.joint = swapJointAddress(s, keys.view, this.deps.network());
      t.lockTxid = t.note.paidTxid ?? null;
      return;
    }
    if (s.noticeCt.length === 0) return;
    const opened = openNotice(s, keys.encSecret);
    t.noticeOpens = opened !== null;
    if (!opened) return;
    t.joint = swapJointAddress(s, opened.view, this.deps.network());
    t.lockTxid = hex(opened.txid);
    if (t.note.lockTxid !== t.lockTxid) this.patchNote(t, { lockTxid: t.lockTxid });
  }

  private patchNote(t: Tracked, patch: Partial<SwapNote>): void {
    t.note = { ...t.note, ...patch };
    saveNote(t.ref, t.note);
  }

  /** `verifyLock` against every configured node at `minConf`. Any failure is "not confirmed". */
  private async verify(t: Tracked, minConf: number): Promise<VerifyLockResult | null> {
    if (!t.joint || !t.lockTxid || !t.view) return null;
    const problem = this.deps.monero.policyProblem();
    if (problem) {
      t.lockError = problem;
      this.setHealth('monero', problem);
      return null;
    }
    try {
      const r = await this.deps.monero.verify({ txid: t.lockTxid, viewPriv: hex(t.joint.viewPriv), spendPub: hex(t.joint.spendPub), minAmount: t.view.xmr, minConf });
      t.lock = r;
      t.lockError = null;
      const failed = r.codes.includes('node-failed') || r.codes.includes('too-few-nodes');
      this.setHealth('monero', failed ? (r.reasons.find((x) => x.startsWith('node-failed') || x.startsWith('too-few-nodes')) ?? 'A Monero node did not answer.') : null);
      return r;
    } catch (e) {
      t.lockError = message(e);
      this.setHealth('monero', t.lockError);
      return null;
    }
  }

  private async advance(t: Tracked, port: ChainPort, now: bigint): Promise<void> {
    t.error = null;
    t.needsWallet = false;
    if (!t.view) {
      t.decision = { do: 'done', outcome: 'closed' };
      return;
    }
    const keys = this.keysFor(t);
    if (!keys) {
      t.decision = null;
      return;
    }
    const ended = endedInClaim(t.view) ? 'claim' : endedInRefund(t.view) ? 'refund' : undefined;
    if (t.note.lastState !== t.view.state || t.note.ended !== ended || !t.note.openedAt)
      this.patchNote(t, { xmr: t.view.xmr.toString(), amount: t.view.amount.toString(), direction: t.view.direction, lastState: t.view.state, ...(ended ? { ended } : {}), ...(t.note.openedAt ? {} : { openedAt: Number(t.view.tLock) }) });
    if (t.view.state === SWAP_STATE.FROZEN && !t.note.wasFrozen) this.patchNote(t, { wasFrozen: true });
    let makerProofOk: boolean | undefined;
    this.registerWatcher(t, keys, now);
    let report: LockReport | undefined;
    let noticeOpens: boolean | undefined;
    for (let step = 0; step < 8; step++) {
      const s: SwapView = t.view;
      this.ensureJoint(t, keys);
      const swept = !!(t.note.sweepConfirmed || t.note.exported);
      const d = takerStep({
        swap: s,
        now,
        ...(t.note.cancel ? { cancel: true } : {}),
        ...(t.note.freeze ? { freeze: true } : {}),
        ...(noticeOpens !== undefined ? { noticeOpens } : {}),
        ...(report ? { lock: report } : {}),
        ...(t.note.paidTxid ? { paid: true } : {}),
        ...(swept ? { swept: true } : {}),
        ...(makerProofOk !== undefined ? { makerProofOk } : {}),
      });
      t.decision = d;
      if (d.do === 'need') {
        if (d.fact === 'notice-opening') {
          noticeOpens = t.noticeOpens ?? false;
          continue;
        }
        if (d.fact === 'lock-report') {
          const r = await this.verify(t, s.depth);
          // No answer is "not found": the flow then waits for the cutoff and refunds.
          report = r ? lockReport(r) : { state: 'not-found', ok: false, confirmations: 0 };
          continue;
        }
        if (d.fact === 'dleq-proof' && this.deps.makerProof) {
          // Verified once per funded share (it is a fact about commitments fixed on-chain), in the
          // background: a slow or dead proof endpoint must never hold up this pass or another swap's refund.
          const known = this.proofs.get(`${t.ref}:${hex(s.makerSpendPub)}`);
          if (known !== undefined) {
            makerProofOk = known;
            t.proof = known ? { phase: 'ok' } : { phase: 'invalid' };
            continue;
          }
          this.checkProof(t, s);
        }
        return;
      }
      if (d.do === 'call') {
        if (d.notAfter !== null && now > d.notAfter) return;
        const m: CallMaterial = {};
        if (d.call.name === 'refund' || d.call.name === 'claim') m.secret = keys.spend;
        if (d.call.name === 'post_notice') {
          if (!t.note.paidTxid) return;
          m.notice = buildNotice(s, keys.encSecret, unhex(t.note.paidTxid), keys.view);
        }
        t.busy = BUSY_TEXT[d.call.name] ?? 'Sending a transaction';
        this.emit();
        try {
          await port.exec(s, d, keys, m, { wallet: this.walletOk.has(t.ref) });
          this.walletOk.delete(t.ref);
        } catch (e) {
          t.busy = null;
          if (e instanceof WalletNeeded) {
            t.needsWallet = true;
            return;
          }
          throw e;
        }
        t.busy = null;
        if (d.call.name === 'refund' && (d.row === 'A10b' || d.row === 'Z3') && !t.note.cancel) this.patchNote(t, { autoRefunded: true });
        if (d.call.name === 'freeze') this.patchNote(t, { frozeMyself: true });
        t.view = await port.getSwap(t.ref);
        if (!t.view) {
          t.decision = { do: 'done', outcome: 'closed' };
          return;
        }
        report = undefined;
        continue;
      }
      if (d.do === 'offchain') {
        if (d.action === 'show-address') {
          if (await this.lookForPayment(t)) continue;
          return;
        }
        if (d.action === 'sweep') await this.sweep(t, keys);
        return;
      }
      // wait or done. While the XMR is not ours yet, keep the picture of the lock fresh for the interface.
      if (t.joint && t.lockTxid && !swept && (s.state === SWAP_STATE.READY || (s.state === SWAP_STATE.NOTICED && report === undefined))) await this.verify(t, s.depth);
      return;
    }
  }

  private readonly watchRuns = new Map<string, number>();
  /**
   * Hand a swap that names a watcher to that watcher, in the background, until its signed
   * acknowledgement verifies. Until then the swap is not watched and nothing about the tab's
   * own duties changes.
   */
  private registerWatcher(t: Tracked, keys: DerivedKeys, now: bigint): void {
    const s = t.view;
    const w = t.note.watcher;
    if (!s || !w || !this.deps.registerWatcher || s.direction !== 0 || s.watcherAddress === null) return;
    if (s.state !== SWAP_STATE.PENDING && s.state !== SWAP_STATE.ACTIVE && s.state !== SWAP_STATE.NOTICED) return;
    if (acknowledged(w, s)) {
      t.watch = { phase: 'acknowledged' };
      return;
    }
    const last = this.watchRuns.get(t.ref);
    if (last !== undefined && (last === -1 || this.nowMs() - last < 5000)) return;
    this.watchRuns.set(t.ref, -1);
    if (t.watch.phase !== 'failed') t.watch = { phase: 'registering' };
    void this.deps.registerWatcher(w, s, keys, now).then(
      (ack) => {
        this.watchRuns.set(t.ref, this.nowMs());
        this.patchNote(t, { watcher: { url: w.url, solana: w.solana, address: w.address, ack } });
        t.watch = acknowledged(t.note.watcher, s) ? { phase: 'acknowledged' } : { phase: 'failed', error: 'The watcher answered, but not with an acknowledgement signed by the key this swap names.' };
        this.emit();
        void this.poll();
      },
      (e: unknown) => {
        this.watchRuns.set(t.ref, this.nowMs());
        t.watch = { phase: 'failed', error: watcherRefusalText(e) };
        this.emit();
      },
    );
  }

  private readonly proofs = new Map<string, boolean>();
  private readonly proofRuns = new Set<string>();

  /** One attempt at the maker's proof, off the pass. Failures are shown and retried with a growing pause (2 s to 15 s). */
  private checkProof(t: Tracked, s: SwapView): void {
    const key = `${t.ref}:${hex(s.makerSpendPub)}`;
    if (this.proofRuns.has(key)) return;
    if (t.proof.phase === 'retrying' && this.nowMs() < t.proof.nextAtMs) return;
    const attempts = (t.proof.phase === 'retrying' || t.proof.phase === 'checking' ? t.proof.attempts : 0) + 1;
    t.proof = { phase: 'checking', attempts };
    this.proofRuns.add(key);
    const limit = this.deps.proofTimeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ retry: string }>((resolve) => {
      timer = setTimeout(() => resolve({ retry: `The proof download did not finish within ${Math.round(limit / 1000)} s` }), limit);
    });
    void Promise.race([this.deps.makerProof!(s).catch((e: unknown) => ({ retry: message(e) })), timeout]).then((r) => {
      if (timer) clearTimeout(timer);
      this.proofRuns.delete(key);
      if ('ok' in r) {
        this.proofs.set(key, r.ok);
        t.proof = r.ok ? { phase: 'ok' } : { phase: 'invalid' };
      } else t.proof = { phase: 'retrying', error: r.retry, attempts, nextAtMs: this.nowMs() + Math.min(15_000, 2000 * 2 ** (attempts - 1)) };
      this.emit();
      void this.poll();
    });
  }

  /** Direction B: scan for the taker's own payment to the joint address. True once found. */
  private async lookForPayment(t: Tracked): Promise<boolean> {
    if (!t.joint || !t.view) return false;
    try {
      if (t.note.scanFrom === undefined) {
        this.patchNote(t, { scanFrom: Math.max(0, (await this.deps.monero.height()) - 2) });
      }
      const r = await this.deps.monero.findDeposits({ viewPriv: hex(t.joint.viewPriv), spendPub: hex(t.joint.spendPub), fromHeight: t.note.scanFrom! });
      this.setHealth('monero', null);
      // One transaction for at least the exact amount. Anything smaller is shown, not accepted.
      const hit = r.found.find((f) => f.amount >= t.view!.xmr);
      if (!hit) return false;
      this.patchNote(t, { paidTxid: hit.txid });
      t.lockTxid = hit.txid;
      return true;
    } catch (e) {
      t.lockError = message(e);
      this.setHealth('monero', t.lockError);
      return false;
    }
  }

  /** Sweep the joint address, or follow a sweep already sent until it is mined. Retryable: a failed attempt spends nothing. */
  private async sweep(t: Tracked, keys: DerivedKeys): Promise<void> {
    const s = t.view!;
    if (!t.joint || !t.lockTxid) {
      t.sweep = { phase: 'failed', error: 'The lock notice of this swap could not be opened, so the joint address is unknown.', attempts: 0 };
      return;
    }
    if (t.note.sweepTxid) {
      try {
        const st = await this.deps.monero.txStatus(t.note.sweepTxid);
        this.setHealth('monero', null);
        if (st === 'mined') {
          this.patchNote(t, { sweepConfirmed: true });
          t.sweep = { phase: 'confirmed', txid: t.note.sweepTxid };
          void this.poll();
        } else if (st === 'pool') {
          this.sweepMisses.delete(t.ref);
          t.sweep = { phase: 'broadcast', txid: t.note.sweepTxid };
        } else {
          // The node does not know the sweep. After a few passes assume it was dropped and build it again.
          const misses = (this.sweepMisses.get(t.ref) ?? 0) + 1;
          this.sweepMisses.set(t.ref, misses);
          t.sweep = { phase: 'broadcast', txid: t.note.sweepTxid };
          if (misses >= 5) {
            this.sweepMisses.delete(t.ref);
            const { sweepTxid: _dropped, ...rest } = t.note;
            t.note = rest;
            saveNote(t.ref, rest);
          }
        }
      } catch (e) {
        this.setHealth('monero', message(e));
      }
      return;
    }
    // Verify first, destination or not: whether the XMR is really there decides what the page tells the user.
    const lock = await this.verify(t, MONERO_LOCK_WINDOW);
    if (!lock || lock.blockHeight === undefined || lock.outputIndex === undefined) {
      const attempts = t.sweep.phase === 'failed' ? t.sweep.attempts : 0;
      t.sweep = lock && (lock.state === 'pending' || lock.state === 'not-found') ? { phase: 'waiting', blocksLeft: MONERO_LOCK_WINDOW } : { phase: 'failed', error: t.lockError ?? lock?.reasons[0] ?? 'The lock could not be verified on every node.', attempts };
      return;
    }
    const destination = t.note.destination;
    if (!destination) {
      t.sweep = { phase: 'need-destination' };
      return;
    }
    if (lock.confirmations < MONERO_LOCK_WINDOW) {
      t.sweep = { phase: 'waiting', blocksLeft: MONERO_LOCK_WINDOW - lock.confirmations };
      return;
    }
    if (!lock.ok) {
      t.sweep = { phase: 'failed', error: lock.reasons[0] ?? 'The nodes do not agree about the lock.', attempts: t.sweep.phase === 'failed' ? t.sweep.attempts : 0 };
      return;
    }
    const attempts = t.sweep.phase === 'failed' ? t.sweep.attempts : 0;
    t.sweep = { phase: 'building' };
    t.busy = 'Sweeping the XMR to your address';
    this.emit();
    try {
      const spendKey = jointSpendKey(s, keys.spend, 'taker');
      const out = await this.deps.monero.sweep({
        spendKey,
        viewKey: t.joint.viewPriv,
        lockHeight: lock.blockHeight,
        lockTxid: unhex(t.lockTxid),
        outputIndex: BigInt(lock.outputIndex),
        destination,
        maxFee: this.deps.sweepMaxFee?.() ?? sweepMaxFee(lock.amount),
      });
      this.patchNote(t, { sweepTxid: out.txid, sweepAmount: out.amount.toString(), sweepFee: out.fee.toString() });
      t.sweep = { phase: 'broadcast', txid: out.txid };
    } catch (e) {
      t.sweep = { phase: 'failed', error: message(e), attempts: attempts + 1 };
    } finally {
      t.busy = null;
    }
  }

  /** The user asked for the pending wallet-signed step of a swap: the next pass may open the wallet prompt once. */
  signWithWallet(ref: string): Promise<void> {
    this.walletOk.add(ref);
    return this.poll();
  }

  /** Retry a failed sweep now (the engine also retries by itself on every pass). */
  retrySweep(ref: string): void {
    const t = this.tracked.get(ref);
    if (t && t.sweep.phase === 'failed') t.sweep = { phase: 'failed', error: t.sweep.error, attempts: t.sweep.attempts };
    void this.poll();
  }

  /**
   * "Export keys" (SPEC 8.4): address, private view key, private spend key, lock txid and height,
   * for any swap whose two spend shares are known. Restores in standard Monero wallet software.
   */
  exportKeys(ref: string): ReturnType<typeof exportJointWallet> & { swap: string; payout?: string } {
    const t = this.tracked.get(ref);
    if (!t?.view || !t.keys || !t.joint || !t.lockTxid) throw new Error('The keys of this swap are not complete yet.');
    const spendKey = jointSpendKey(t.view, t.keys.spend, 'taker');
    // The swap it belongs to and, when selling, the payout address bound at take travel with the keys.
    return { ...exportJointWallet(t.joint, spendKey, unhex(t.lockTxid), t.lock?.blockHeight ?? 0), swap: t.ref, ...(t.view.payoutAddress ? { payout: t.view.payoutAddress } : {}) };
  }

  /** Whether both spend shares of a swap are known (the other one was revealed on-chain). */
  canExport(t: Tracked): boolean {
    if (!t.view || !t.keys || !t.joint || !t.lockTxid) return false;
    return t.view.direction === 0 ? endedInClaim(t.view) : endedInRefund(t.view);
  }

  private describe(t: Tracked, now: bigint): void {
    const s = t.view;
    const swept = !!(t.note.sweepConfirmed || t.note.exported);
    // A swap whose own opening is in a block but not final yet is shown as what the head says, not as closed.
    t.leg = s ? legState(s, swept) : t.pending ? legState(t.pending.view, false) : swept || t.note.ended === 'claim' ? 'swept' : 'refunded';
    t.atRisk = isAtRisk(t);
    t.refundDeadline = s && t.atRisk ? (s.state === SWAP_STATE.ACTIVE ? deadlinesOf(s.chain, s).tNote : takerRefundDeadline(s)) : null;
    t.lost = lossOf(t, now);
    t.watched = !!s && (s.state === SWAP_STATE.PENDING || s.state === SWAP_STATE.ACTIVE || s.state === SWAP_STATE.NOTICED) && acknowledged(t.note.watcher, s);
    if (t.watched) t.watch = { phase: 'acknowledged' };
    t.freezeRefusal = s && t.keys && s.direction === 0 ? freezeRefusal(s, now, 0) : null;
    // What the flow would answer to "get me out" now, so the page never offers an action that will be refused.
    t.exitRefusal = s && t.keys ? (takerStep({ swap: s, now, cancel: true, noticeOpens: t.noticeOpens ?? true, lock: t.lock ? lockReport(t.lock) : { state: 'not-found', ok: false, confirmations: 0 }, ...(t.note.paidTxid ? { paid: true } : {}), ...(swept ? { swept: true } : {}) }).refused ?? null) : null;
  }
}

/**
 * Seconds until the state the newest block shows is final: how far finality trails the head, less
 * how long ago the change happened (that is, how far the finalized tag still has to travel on the
 * chain's clock). While finality is stalled the figure does not shrink, which is the truth.
 */
export function finalityEta(head: SwapView, fin: { latestTime: bigint; finalizedTime: bigint }): number | null {
  const at = [head.tReady, head.tNotice, head.tActive, head.tLock].find((x) => x > 0n);
  if (at === undefined) return null;
  const lag = fin.latestTime - fin.finalizedTime;
  const left = lag - (fin.latestTime - at);
  return Number(left > 0n ? left : 0n);
}

const BUSY_TEXT: Partial<Record<string, string>> = {
  set_ready: 'Confirming the lock (setting ready)',
  freeze: 'Pausing the swap',
  push_owed: 'Delivering the parked proceeds',
  refund: 'Refunding',
  refund_unnoticed: 'Refunding',
  cancel_pending: 'Cancelling',
  expire_pending: 'Collecting the refund',
  claim: 'Claiming your payment',
  post_notice: 'Posting the lock notice',
  release_deposit: 'Collecting the deposit',
  split_deposit: 'Collecting your half of the deposit',
  close_swap: 'Closing the swap account',
  withdraw_owed: 'Withdrawing a parked payout',
  abort: 'Aborting',
};

/** What, if anything, was lost or is now out of the tab's hands. Stated plainly (SPEC 8.5 item 9). */
export function lossOf(t: Pick<Tracked, 'view' | 'decision' | 'lock' | 'noticeOpens' | 'note' | 'lockError'>, _now: bigint): string | null {
  const s = t.view;
  if (!s) return null;
  if (s.direction === 0) {
    const missed = t.decision && t.decision.do === 'wait' && t.decision.warning === 'refund-window-missed';
    if (missed) return 'The refund deadline passed while this tab was not running. The maker can now take your payment. If the maker really locked the XMR you will still receive it; if it did not, your payment is lost.';
    if (s.state === SWAP_STATE.DONE && endedInClaim(s) && (s.outcome === COUNTER.claims_without_ready || s.outcome === COUNTER.claims_after_final)) {
      const lockBad = t.noticeOpens === false || (t.lock !== null && (t.lock.state === 'invalid' || t.lock.state === 'not-found'));
      if (lockBad) return 'A deadline passed while this tab was not running, and the maker took your payment without your confirmation. The XMR lock it announced does not check out, so there is nothing to collect: your payment is lost.';
      return 'A deadline passed while this tab was not running, and the maker took your payment without your confirmation. Its key is now public, so the XMR it locked is yours to collect.';
    }
    return null;
  }
  if (t.decision && t.decision.do === 'wait' && t.decision.warning === 'notice-window-missed') return 'You paid XMR but the lock notice can no longer be posted. The swap unwinds when the maker refunds; your XMR is then recoverable with the recovery file, and your deposit can be withheld.';
  if (t.decision && t.decision.do === 'wait' && t.decision.warning === 'claim-window-missed') return 'The claim deadline passed while this tab was not running. The maker can refund its side; your XMR is then recoverable with the recovery file, and your deposit can be withheld.';
  return null;
}
