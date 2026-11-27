/**
 * The swap executor (DESIGN "Swap daemon"; SPEC 7.5, 7.6): runs every swap through section 3
 * on both chains and both directions.
 *
 * It decides nothing itself. Each step reads the swap at `finalized`, gathers the facts only
 * the daemon can know, asks the SDK's `makerStep` for the one thing to do next, and does it
 * under the intent journal: the row is written BEFORE the external action, the transaction id
 * BEFORE the bytes leave. A step is idempotent, so "resume after a crash" is simply "step
 * again": unresolved intents are looked up (never re-sent blindly), the chain wins for state,
 * the database wins for secrets, raw transactions and intents.
 *
 * Invariants the crash tests hold it to:
 *   - one Monero lock transaction per swap, ever (`lock_txs` primary key; relays repeat the same bytes);
 *   - the lock is relayed only after the notice naming it is final on-chain;
 *   - a spend share is broadcast only by a call the model accepts at that second, simulated first;
 *   - a due claim or refund is never skipped because an earlier attempt's outcome is unknown.
 */
import { createHash } from 'node:crypto';
import { type ChainName, type Market, SWAP_FLAG, SWAP_STATE, SWAP_STATE_NAMES, base58Decode, sweepMaxFee } from '@xmrswap/protocol';
import { type CallMaterial, type Decision, type FlowCall, type LockReport, type MakerFacts, type SwapView, buildNotice, deadlinesOf, enabled, endedInClaim, endedInRefund, hasFlag, hex0x, jointSpendKey, lockReport, makerStep, openNotice, solanaMakerShare, swapJointAddress, verifyTakerShare } from '@xmrswap/sdk';
import { dleqProve, noticeCommitment, twinCommitments } from '@xmrswap/core-wasm';
import type { Alerts } from '../alerts/index.js';
import type { Approvals } from '../approvals/index.js';
import type { EthereumChain } from '../chains/ethereum.js';
import { Refused, type SwapChain } from '../chains/types.js';
import type { Config, ResolvedOffer } from '../config/load.js';
import { releaseDecision, withholdDecision } from '../deposits/index.js';
import { evidenceFor } from '../evidence/index.js';
import type { Inventory } from '../inventory/index.js';
import type { MoneroView } from '../monero/nodes.js';
import type { MoneroBroadcaster } from '../monero/wallet.js';
import type { EncKeys } from '../rotation/index.js';
import type { FrozenBy, Instruction, InstructionAction, IntentRow, Store, SwapFacts, SwapRow } from '../store/db.js';
import { CrashError, type Journal } from '../store/journal.js';
import { type Bytes, Emitter, KeyedMutex, errMsg, hex, toJson, unhex } from '../util.js';
import type { MakerWatcher } from '../watcher/index.js';
import { solanaCallFee } from '../stats/costs.js';
import type { Shares } from './shares.js';

export interface ExecutorOptions {
  store: Store;
  journal: Journal;
  alerts: Alerts;
  chains: Partial<Record<ChainName, SwapChain>>;
  inventory: Inventory;
  monero: MoneroView;
  broadcaster: MoneroBroadcaster;
  shares: Shares;
  encKeys: EncKeys;
  approvals: Approvals;
  /** The maker's own watcher for buy-XMR swaps (SPEC 11.6); absent = none is ever named. */
  watcher?: MakerWatcher;
  config: () => Config;
  /** The operator's pause switch: while it is on, no stored automatic approval is acted on. */
  paused?: () => boolean;
  /** USD per XMR right now, or `null` (the withhold rule and the fill record use it). */
  xmrUsd: () => number | null;
  /** Sweep fee cap override in piconero (regtest fees are far above mainnet's). */
  sweepMaxFee?: () => bigint | undefined;
  /** Milliseconds a sent transaction may stay unresolved before the swap is parked for review (still re-checked every step). */
  stuckAfterMs?: Partial<Record<ChainName, number>>;
  clock?: () => number;
}

/** What became of an operator instruction, for the caller: carried out, refused with the reason, or still pending. */
export interface InstructionResult {
  instruction?: Instruction;
}
interface Refusable {
  /** An explicit request the flow could not honour in this state, and why. */
  refused?: string;
}
export type StepOutcome = Refusable & StepBody;
type StepBody =
  | { kind: 'acted'; what: string }
  | { kind: 'waiting'; on: string; until: bigint | null }
  | { kind: 'done'; outcome: string }
  | { kind: 'parked'; why: string }
  | { kind: 'error'; error: string };

export const marketOf = (chain: ChainName, asset: string): Market => (chain === 'solana' ? (asset === '0' ? 'sol' : 'usdc_sol') : /^0x0{40}$/.test(asset) ? 'eth' : 'usdc_eth');

/** What the maker verified about the taker's side of a swap, as one hash: the swap's commitments must still be these when it acts later (SPEC 3.11 maker rule 8). */
export function commitmentHash(s: SwapView): string {
  const h = createHash('sha256');
  for (const b of [s.swapRef, s.takerSpendPub, s.takerEncKey, s.makerEncKey, s.direction === 0 ? s.lockerView : new Uint8Array(32)]) h.update(b);
  h.update(`${s.makerEncVersion}:${s.xmr}:${s.amount}:${s.deposit}:${s.depth}`);
  if (s.eth) h.update(`${s.eth.takerKey}:${s.eth.takerKey2}`);
  return h.digest('hex');
}

const snapshotOf = (s: SwapView): string => toJson(s);
/** Direction B after the taker's notice (frozen or not): the maker's refund window is running. */
const urgent = (r: Pick<SwapRow, 'direction' | 'state'>): number => Number(r.direction === 1 && (r.state === SWAP_STATE.NOTICED || r.state === SWAP_STATE.FROZEN));
const txidBytes = (txid: string): Bytes => unhex(txid);

export class Executor {
  readonly events = new Emitter<{ swap: string }>();
  private readonly o: ExecutorOptions;
  private readonly mutex = new KeyedMutex();
  /** Latest lock verification per swap, for the console. */
  readonly lockReports = new Map<string, LockReport>();

  constructor(o: ExecutorOptions) {
    this.o = o;
  }
  private get store(): Store {
    return this.o.store;
  }
  private clock(): number {
    return (this.o.clock ?? Date.now)();
  }
  private offerFor(row: Pick<SwapRow, 'market' | 'direction'>): ResolvedOffer | undefined {
    return this.o.config().offers.find((x) => x.market === row.market && x.directionCode === row.direction);
  }

  // ---------------------------------------------------------------- discovery

  /** Find swaps that name this maker and have no row yet (new, or opened while the daemon was down) and adopt them. */
  async scan(): Promise<string[]> {
    const adopted: string[] = [];
    for (const chain of Object.values(this.o.chains)) {
      if (!chain) continue;
      for (const view of await chain.discover()) {
        const ref = chain.refOf(view);
        if (this.store.swap(ref)) continue;
        this.adopt(chain, ref, view);
        adopted.push(ref);
      }
    }
    return adopted;
  }

  private adopt(chain: SwapChain, ref: string, view: SwapView): void {
    const refPriceUsd = this.o.xmrUsd();
    this.store.tx(() => {
      this.store.insertSwap({
        ref, chain: chain.chain, direction: view.direction, market: marketOf(chain.chain, view.asset), state: view.state, phase: 'seen', snapshot: snapshotOf(view), taker: view.taker,
        xmr: view.xmr.toString(), amount: view.amount.toString(), deposit: view.deposit.toString(), depth: view.depth, opened_at: Number(view.tLock), enc_version: view.makerEncVersion,
        facts: refPriceUsd === null ? {} : { refPriceUsd },
      });
      // A share that came from an offer pool or a signed key pool is bound to the swap that took it; the first swap wins.
      const named = view.makerSpendPub.every((b) => b === 0) ? undefined : this.store.shareByPub(hex(view.makerSpendPub));
      if (named && !named.swap_ref && view.state !== SWAP_STATE.PENDING) this.store.setShare(named.share_id, 'bound', ref);
    });
    this.events.emit('swap', ref);
  }

  // ---------------------------------------------------------------- the loop

  /** Step every open swap once: the ones with the hardest deadline first (direction B after the taker's notice). */
  async tick(): Promise<Map<string, StepOutcome>> {
    await this.scan().catch((e) => this.o.alerts.raise('warning', 'scan_failed', errMsg(e)));
    const open = this.store.swaps({ open: true }).sort((a, b) => urgent(b) - urgent(a));
    const out = new Map<string, StepOutcome>();
    for (const row of open) out.set(row.ref, await this.step(row.ref));
    return out;
  }

  /** Advance one swap as far as it goes without waiting. Serialised per swap; safe to call at any time and after any crash. */
  step(ref: string): Promise<StepOutcome> {
    return this.mutex.run(ref, () => this.pass(ref));
  }
  /** One pass over a swap. The caller holds the swap's section. */
  private async pass(ref: string): Promise<StepOutcome> {
    {
      let last: StepOutcome = { kind: 'waiting', on: 'nothing', until: null };
      let refused: string | undefined;
      try {
        for (let i = 0; i < 12; i++) {
          last = await this.once(ref);
          refused ??= last.refused;
          if (last.kind !== 'acted') break;
        }
      } catch (e) {
        if (e instanceof CrashError) throw e;
        const error = errMsg(e);
        this.store.updateSwap(ref, { last_error: error });
        last = { kind: 'error', error };
      }
      if (refused !== undefined) last = { ...last, refused };
      this.settleInstruction(ref, last);
      this.events.emit('swap', ref);
      return last;
    }
  }

  private async once(ref: string): Promise<StepOutcome> {
    const row = this.store.swap(ref);
    if (!row) return { kind: 'error', error: 'unknown swap' };
    if (row.terminal) return { kind: 'done', outcome: row.phase, ...(row.facts.instruction?.status === 'pending' ? { refused: 'already-settled' } : {}) };
    const chain = this.o.chains[row.chain];
    if (!chain) return { kind: 'parked', why: `${row.chain} is not configured` };

    // 1. Settle what an earlier run left open. Nothing new is sent while a transaction of this swap is unresolved.
    const pending = await this.resolveIntents(row, chain);
    if (pending) return pending;

    // 2. The chain wins for state.
    const [view, now] = await Promise.all([chain.getSwap(ref), chain.now()]);
    if (!view) {
      // Solana: the account was closed (a keyless refund, or `close_swap`). Ethereum never deletes a swap.
      if (row.chain === 'ethereum') return { kind: 'waiting', on: 'finality', until: null };
      return this.finish(row, null, 'closed');
    }
    if (view.state !== row.state || !row.snapshot) this.store.updateSwap(ref, { state: view.state, snapshot: snapshotOf(view) });
    const ins = row.facts.instruction;
    if (ins && ins.status === 'pending' && !ins.seen) row.facts = this.store.patchFacts(ref, { instruction: { ...ins, stateAt: view.state, seen: true } });

    this.noteFreeze(row, view);
    await this.watch(row, view);

    // 3. Facts, decision, action.
    const facts: MakerFacts = { swap: view, now, ...(await this.baseFacts(row, view, now)) };
    this.setPhase(row, view, facts);
    for (let i = 0; i < 8; i++) {
      const d = makerStep(facts);
      if (d.do !== 'need') return this.perform(row, chain, view, now, d, facts);
      const got = await this.learn(row, chain, view, now, d.fact, facts);
      if (got) return got;
    }
    return { kind: 'error', error: 'the flow kept asking for facts' };
  }

  // ---------------------------------------------------------------- intents left open

  private async resolveIntents(row: SwapRow, chain: SwapChain): Promise<StepOutcome | null> {
    let waiting: StepOutcome | null = null;
    for (const intent of this.store.intents({ swapRef: row.ref, status: ['planned', 'sent', 'needs_review'] })) {
      const isChainTx = intent.kind === 'sol_tx' || intent.kind === 'eth_tx';
      if (intent.status === 'planned') {
        // The process died (or the action threw) between writing the row and finishing the action.
        // Nothing was signed for a chain transaction; a prepared lock that was never stored was never relayed;
        // a relay or a sweep is repeated with the SAME stored bytes by the state machine. None is re-sent from here.
        this.o.journal.resolve(intent, 'failed', 'interrupted before completion');
        if (intent.kind === 'xmr_prepare' && !this.store.lockTx(row.ref)) this.o.inventory.release(row.ref);
        continue;
      }
      if (!isChainTx || !intent.tx) continue;
      const status = await chain.status(intent.tx, intent.meta);
      const secret = intent.payload['secret'] === true;
      if (status.state === 'confirmed') {
        this.o.journal.resolve(intent, 'confirmed');
        // Solana: the base fee plus the priority fee on the call's measured compute units (the endpoint reports no fee).
        const call = String(intent.payload['call'] ?? 'swap');
        const fee = row.chain === 'solana' ? solanaCallFee(this.o.config().raw, call, row.market === 'usdc_sol') : status.fee;
        if (fee !== undefined) this.store.recordFee(row.chain, call, row.chain === 'solana' ? 'sol' : 'eth', fee, intent.tx);
        if (row.needs_review) this.store.updateSwap(row.ref, { needs_review: this.store.intents({ swapRef: row.ref, status: ['needs_review'] }).length > 0 ? 1 : 0 });
      } else if (status.state === 'failed' || status.state === 'dead') {
        this.o.journal.resolve(intent, 'failed', status.state === 'failed' ? 'the transaction failed on-chain' : 'the transaction can no longer land');
        if (status.state === 'failed' && secret) this.o.alerts.raise('critical', 'secret_tx_failed', `a ${String(intent.payload['call'])} transaction failed on-chain; its arguments are public`, row.ref);
        if (row.needs_review) this.store.updateSwap(row.ref, { needs_review: 0 });
      } else {
        // Still in flight. Never send again while it may land; park it for a human once it has been stuck too long, and keep checking.
        const signedAt = typeof intent.meta?.['signedAtMs'] === 'number' ? (intent.meta['signedAtMs'] as number) : this.clock();
        const limit = this.o.stuckAfterMs?.[row.chain] ?? (row.chain === 'ethereum' ? 3_600_000 : 300_000);
        if (intent.status === 'sent' && this.clock() - signedAt > limit) {
          this.o.journal.resolve(intent, 'needs_review', 'sent, neither confirmed nor dead');
          this.store.updateSwap(row.ref, { needs_review: 1 });
          this.o.alerts.raise('critical', 'tx_stuck', `transaction ${intent.tx} of this swap is neither confirmed nor dead; it is not re-sent`, row.ref);
        }
        waiting = { kind: 'waiting', on: `transaction ${String(intent.payload['call'] ?? '')}`.trim(), until: null };
      }
    }
    return waiting;
  }

  // ---------------------------------------------------------------- facts

  /**
   * A swap seen frozen for the first time (or settled after a freeze) is recorded once, with who froze it as far as the
   * chain tells: the swap stores the time, not the caller. Direction A: the taker's side (the taker, its session key or
   * the watcher it named). Direction B: this daemon if a `freeze` of its own landed, else the maker's watcher.
   */
  private noteFreeze(row: SwapRow, view: SwapView): void {
    if (view.tFreeze === 0n || this.store.freeze(row.ref)) return;
    const own = this.store.intents({ swapRef: row.ref, status: ['confirmed'] }).some((i) => i.payload['call'] === 'freeze');
    const by: FrozenBy = view.direction === 0 ? 'taker_side' : own ? 'maker' : 'maker_watcher';
    const tFf = deadlinesOf(view.chain, view).tFf ?? view.tFreeze;
    this.store.recordFreeze({ swap_ref: row.ref, chain: row.chain, direction: view.direction, taker: view.taker, watcher: view.watcherAddress, frozen_by: by, t_freeze: Number(view.tFreeze), t_ff: Number(tFf) });
    if (view.direction === 0) this.o.alerts.raise('warning', 'swap_frozen', `the taker's side paused this swap: the claim without ready opens at ${tFf} (chain time) instead of ${view.tClaimOpen}; the XMR stays locked until then unless the taker sets ready or refunds. A refund or abort after a pause leaves the deposit withholdable.`, row.ref, 0);
    else this.o.alerts.raise(by === 'maker' ? 'info' : 'warning', 'swap_frozen', by === 'maker' ? `this daemon paused the swap: the taker's XMR lock was not confirmed in time; the escrow is safe until ${tFf} (chain time)` : `the maker's watcher paused this swap while the daemon did not act: the taker's claim without ready waits until ${tFf} (chain time); the daemon now sets ready or refunds`, row.ref, 0);
  }

  /** Direction B: hand a funded swap that names the maker's watcher to it, and keep the signed acknowledgement. Never blocks or fails the step. */
  private async watch(row: SwapRow, view: SwapView): Promise<void> {
    const w = this.o.watcher;
    if (!w || view.direction !== 1 || (view.state !== SWAP_STATE.ACTIVE && view.state !== SWAP_STATE.NOTICED) || !w.names(view)) return;
    if (this.o.config().raw.daemon.mode !== 'live') return;
    let secret: Bytes;
    try {
      secret = this.encSecret(view);
    } catch {
      return;
    }
    const ack = await w.register(row.ref, view, secret);
    // The acknowledgement is the watcher's promise, not a chain fact: once a notice exists, it must reach the swap's own claim-open time.
    if (ack && view.state === SWAP_STATE.NOTICED && BigInt(ack.watching_until) < view.tClaimOpen)
      this.o.alerts.raise('warning', 'watcher_stops_early', `the watcher acknowledged this swap only until ${ack.watching_until}, before its claim-open time ${view.tClaimOpen}: it may not pause it in time`, row.ref, 3_600);
  }

  private async baseFacts(row: SwapRow, view: SwapView, now: bigint): Promise<Partial<MakerFacts>> {
    const f: Partial<MakerFacts> = {};
    const S = SWAP_STATE;
    const offer = this.offerFor(row);
    if (view.state === S.PENDING) {
      const m = row.facts.manual;
      if (row.facts.takerProofOk !== undefined) f.takerProofOk = row.facts.takerProofOk;
      if (m?.approve === true) f.approval = { approve: true };
      else if (m?.approve === false) f.approval = { approve: false, reason: m.rejectReason ?? 0 };
      // A verdict stored before the operator paused is not acted on while the pause is on: the rules decide again (and reject).
      else if (row.facts.approval && !(row.facts.approval.approve && this.o.paused?.())) f.approval = row.facts.approval;
    }
    if (row.facts.verified && view.state !== S.PENDING) f.commitmentsOk = row.facts.verified === commitmentHash(view);
    if (view.direction === 0) {
      const lock = this.store.lockTx(row.ref);
      f.lockTx = !lock ? 'none' : lock.relayed_at === null ? 'prepared' : 'relayed';
      if (row.facts.lockFailed || row.facts.manual?.abort) f.lockFailed = true;
      if (offer?.withoutReady) f.withoutReady = offer.withoutReady;
      // Keep watching the relayed lock until the swap is settled: rebroadcast if it dropped out, abort if it can no longer confirm.
      if (lock && lock.relayed_at !== null && (view.state === S.NOTICED || view.state === S.READY || view.state === S.FROZEN)) {
        const report = await this.ownLockReport(row, view);
        f.lock = report;
        if (report.state === 'not-found' && !f.lockFailed && (await this.o.inventory.inputsSpentElsewhere(row.ref).catch(() => false))) {
          this.store.patchFacts(row.ref, { lockFailed: true });
          f.lockFailed = true;
        }
      }
    } else {
      if (row.facts.manual?.abort) f.backOut = true;
      await this.ownFreeze(row, view, now, f);
    }
    if (view.state === S.HOLD || view.state === S.WITHHELD) {
      f.withhold = view.state === S.HOLD && withholdDecision(offer, row.facts, this.o.xmrUsd());
      f.release = releaseDecision(row.facts);
    }
    // An explicit withhold or release asked for while no deposit is in the hold: pass it on, so the flow says so instead of dropping it.
    const pending = row.facts.instruction?.status === 'pending' ? row.facts.instruction.action : null;
    if (pending === 'withhold' && view.state !== S.HOLD && view.state !== S.WITHHELD) f.withhold = true;
    if (pending === 'release' && view.state !== S.HOLD && view.state !== S.WITHHELD) f.release = true;
    f.swept = row.swept === 1;
    return f;
  }

  /**
   * Direction B, the daemon is the locker and the swap names a watcher: ask the flow for a pause (Z1) when the taker's
   * lock is real but still short of its depth one margin before `T_cut`, the point where the flow would otherwise give
   * the escrow back. The pause buys the freeze window for the confirmations; the flow then sets ready (Z2) or refunds
   * (Z3). A lock that is provably bad (the notice does not open, the transaction is invalid) is NOT paused: it is
   * refunded at once, which is what the flow does with it after a pause anyway. Whether a freeze is possible at all is
   * the flow's decision (`freezeRefusal`), not this function's.
   */
  private async ownFreeze(row: SwapRow, view: SwapView, now: bigint, f: Partial<MakerFacts>): Promise<void> {
    if (view.direction !== 1 || view.state !== SWAP_STATE.NOTICED || !view.watcher || view.wZ === 0 || view.tFreeze !== 0n || f.backOut) return;
    const d = deadlinesOf(view.chain, view);
    if (d.tCut === null || d.tCo === null || now < d.tCut - d.margin || now >= d.tCo) return;
    f.noticeOpens = this.takerNotice(view) !== null;
    if (!f.noticeOpens) return;
    f.lock = await this.takerLockReport(row, view, now);
    if (f.lock.state === 'pending' || f.lock.state === 'confirming') f.freeze = true;
  }

  /** Compute the fact the flow asked for. Returns an outcome only when the step cannot continue. */
  private async learn(row: SwapRow, chain: SwapChain, view: SwapView, now: bigint, fact: string, f: MakerFacts): Promise<StepOutcome | null> {
    switch (fact) {
      case 'dleq-proof': {
        // Ethereum: the taker PUT its proof before locking. Missing or wrong means unusable input (reject with reason 1).
        const blob = this.store.blob(hex(view.takerSpendPub));
        let ok = false;
        if (blob) {
          try {
            verifyTakerShare(blob, view, this.o.shares.ownCommitments());
            ok = this.o.approvals.inputProblem(view) === null;
          } catch {
            ok = false;
          }
        }
        if (ok) this.store.pinBlob(hex(view.takerSpendPub), row.ref);
        this.store.patchFacts(row.ref, { takerProofOk: ok, ...(ok ? { verified: commitmentHash(view) } : {}) });
        f.takerProofOk = ok;
        return null;
      }
      case 'approval-decision': {
        // Exposure limits, paying caps and unlocked outputs are shared by every pending swap: the check and the record
        // of its verdict are one section, so two swaps decided at once cannot both take the last of a limit.
        const d = await this.mutex.run('#approval-decision', async () => {
          const got = await this.o.approvals.decide(view, row, this.offerFor(row));
          // The verdict is bound to the lock it examined: remember what was verified.
          if (got.verdict) this.store.patchFacts(row.ref, { approval: got.verdict, ...(got.verdict.approve ? { verified: commitmentHash(view) } : {}) });
          return got;
        });
        if (!d.verdict) return { kind: 'waiting', on: 'approval-decision', until: deadlinesOf(view.chain, view).tPend };
        f.approval = d.verdict;
        return null;
      }
      case 'commitment-check': {
        // First sight of a swap that started bound (Solana auto mode): check the taker's input and that the share is ours.
        // Later: the stored commitments must be the ones verified then.
        let ok: boolean;
        if (row.facts.verified) ok = row.facts.verified === commitmentHash(view);
        else {
          ok = this.o.approvals.inputProblem(view) === null && this.o.shares.forSwap(row.ref, view.makerSpendPub) !== null;
          if (ok) this.store.patchFacts(row.ref, { verified: commitmentHash(view) });
        }
        f.commitmentsOk = ok;
        return null;
      }
      case 'notice-opening': {
        f.noticeOpens = this.takerNotice(view) !== null;
        return null;
      }
      case 'lock-report': {
        f.lock = view.direction === 0 ? await this.ownLockReport(row, view) : await this.takerLockReport(row, view, now);
        return null;
      }
      default:
        return { kind: 'error', error: `unknown fact ${fact}` };
    }
  }

  private makerShare(row: SwapRow, view: SwapView) {
    const share = this.o.shares.forSwap(row.ref, view.makerSpendPub);
    if (!share) throw new Error('the maker share of this swap is not in the database');
    return share;
  }
  private encSecret(view: SwapView): Bytes {
    const secret = this.o.encKeys.secretFor(view.makerEncVersion);
    if (!secret) throw new Error(`the private key of maker key version ${view.makerEncVersion} is gone`);
    return secret;
  }
  /** Direction B: the taker's notice, decrypted and checked against its commitment; `null` = treated as "no lock". */
  private takerNotice(view: SwapView): { txid: Bytes; view: Bytes } | null {
    try {
      return openNotice(view, this.encSecret(view));
    } catch {
      return null;
    }
  }
  private joint(row: SwapRow, view: SwapView) {
    const claimerView = view.direction === 0 ? this.makerShare(row, view).keys.view : this.takerNotice(view)?.view;
    if (!claimerView) throw new Error('the claimer view share is not known');
    const joint = swapJointAddress(view, claimerView, this.o.monero.network);
    if (row.joint_address !== joint.address) this.store.updateSwap(row.ref, { joint_address: joint.address, joint_view: hex(joint.viewPriv) });
    return joint;
  }
  private async verifyAt(row: SwapRow, view: SwapView, txid: string, minConf: number) {
    const joint = this.joint(row, view);
    const r = await this.o.monero.verify({ txid, viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: view.xmr, minConf });
    this.lockReports.set(row.ref, lockReport(r));
    if (r.blockHeight !== undefined && r.outputIndex !== undefined && (row.lock_height !== r.blockHeight || row.lock_txid !== txid)) this.store.updateSwap(row.ref, { lock_txid: txid, lock_height: r.blockHeight, lock_output_index: r.outputIndex });
    return r;
  }
  /** Direction A: the maker's own lock on every node. A node failure is "unknown", never "gone" (no rebroadcast storm, no abort). */
  private async ownLockReport(row: SwapRow, view: SwapView): Promise<LockReport> {
    const lock = this.store.lockTx(row.ref);
    if (!lock) return { state: 'not-found', ok: false, confirmations: 0 };
    try {
      return lockReport(await this.verifyAt(row, view, lock.txid, view.depth));
    } catch (e) {
      this.o.alerts.raise('warning', 'monero_unreachable', `cannot verify the lock: ${errMsg(e)}`, row.ref);
      return { state: 'pending', ok: false, confirmations: 0 };
    }
  }
  /** Direction B: the taker's lock. Fails closed, and says so loudly: the refund timer depends on it. */
  private async takerLockReport(row: SwapRow, view: SwapView, _now: bigint): Promise<LockReport> {
    const opened = this.takerNotice(view);
    if (!opened) return { state: 'invalid', ok: false, confirmations: 0 };
    try {
      return lockReport(await this.verifyAt(row, view, hex(opened.txid), view.depth));
    } catch (e) {
      this.o.alerts.raise('critical', 'monero_unreachable', `cannot verify the taker's XMR lock while the refund timer runs: ${errMsg(e)}`, row.ref);
      return { state: 'pending', ok: false, confirmations: 0 };
    }
  }

  // ---------------------------------------------------------------- performing a decision

  private async perform(row: SwapRow, chain: SwapChain, view: SwapView, now: bigint, d: Exclude<Decision, { do: 'need' }>, f: MakerFacts): Promise<StepOutcome> {
    const out = await this.performBody(row, chain, view, now, d, f);
    return d.refused !== undefined ? { ...out, refused: d.refused } : out;
  }
  private async performBody(row: SwapRow, chain: SwapChain, view: SwapView, now: bigint, d: Exclude<Decision, { do: 'need' }>, f: MakerFacts): Promise<StepOutcome> {
    this.setPhase(row, view, f);
    switch (d.do) {
      case 'wait':
        if (d.warning === 'maker-fault' || d.warning === 'claim-window-missed' || d.warning === 'refund-window-missed') this.o.alerts.raise('critical', d.warning, `swap ${row.ref}: ${d.warning.replaceAll('-', ' ')} (waiting on ${d.on})`, row.ref, 3_600);
        return { kind: 'waiting', on: d.on, until: d.until };
      case 'done':
        return this.finish(row, view, d.outcome);
      case 'offchain':
        return this.offchain(row, view, now, d.action, f);
      case 'call':
        return this.call(row, chain, view, now, d);
    }
  }

  private setPhase(row: SwapRow, view: SwapView, f: MakerFacts): void {
    const S = SWAP_STATE;
    const phase =
      view.state === S.PENDING ? 'pending_approval'
      : view.state === S.ACTIVE ? (view.direction === 0 ? (f.lockTx === 'prepared' ? 'lock_prepared' : 'locking') : 'funded')
      : view.state === S.NOTICED ? (view.direction === 0 ? (f.lockTx === 'relayed' ? 'xmr_relayed' : 'notice_posted') : 'verifying_xmr')
      : view.state === S.READY ? 'ready'
      : view.state === S.DONE ? (row.swept ? 'swept' : endedInClaim(view) ? 'claimed' : endedInRefund(view) ? 'refunded' : 'settled')
      : SWAP_STATE_NAMES[view.state]!.toLowerCase();
    if (phase !== row.phase) this.store.updateSwap(row.ref, { phase });
  }

  private async offchain(row: SwapRow, view: SwapView, _now: bigint, action: string, _f: MakerFacts): Promise<StepOutcome> {
    // Dry run computes and shows decisions but sends no transaction and moves no XMR.
    if (this.o.config().raw.daemon.mode !== 'live') return { kind: 'parked', why: `dry run: would ${action}` };
    switch (action) {
      case 'prepare-lock-tx': {
        const joint = this.joint(row, view);
        const lock = await this.o.inventory.prepareLock(row.ref, joint.address, view.xmr);
        if (lock === 'unavailable') {
          // No unlocked output can fund it: walk away at once (A7a) rather than miss the notice deadline.
          this.store.patchFacts(row.ref, { lockFailed: true });
          this.o.alerts.raise('warning', 'no_inventory', 'no unlocked XMR output could fund this lock; aborting', row.ref);
          return { kind: 'acted', what: 'lock unavailable' };
        }
        this.store.updateSwap(row.ref, { lock_txid: lock.txid });
        return { kind: 'acted', what: 'prepared lock' };
      }
      case 'relay-xmr':
      case 'rebroadcast-xmr': {
        const lock = this.store.lockTx(row.ref);
        if (!lock) return { kind: 'error', error: 'no stored lock transaction to relay' };
        // The XMR leaves only when the notice that is final on-chain is OUR notice for THIS transaction.
        const share = this.makerShare(row, view);
        const ours = hasFlag(view, SWAP_FLAG.NOTICE) && hex(noticeCommitment(view.swapRef, txidBytes(lock.txid), share.keys.view)) === hex(view.noticeCommitment);
        if (view.state !== SWAP_STATE.NOTICED && view.state !== SWAP_STATE.READY && view.state !== SWAP_STATE.FROZEN) return { kind: 'error', error: 'refusing to relay XMR: the swap is not in NOTICED' };
        if (!ours) return { kind: 'error', error: 'refusing to relay XMR: the notice on record does not commit to the stored lock transaction' };
        const rebroadcast = action === 'rebroadcast-xmr';
        if (rebroadcast && lock.last_rebroadcast !== null && this.store.now() - lock.last_rebroadcast < 60) return { kind: 'waiting', on: 'rebroadcast', until: null };
        const r = await this.o.inventory.relayLock(row.ref, () => this.o.monero.txKnown(lock.txid), rebroadcast);
        if (r === 'double-spend') {
          this.store.patchFacts(row.ref, { lockFailed: true });
          this.o.alerts.raise('critical', 'lock_double_spend', 'an input of the lock transaction was spent elsewhere; aborting', row.ref);
        }
        return rebroadcast ? { kind: 'waiting', on: 'ready', until: null } : { kind: 'acted', what: 'relayed lock' };
      }
      case 'sweep':
        return this.sweep(row, view);
      default:
        return { kind: 'error', error: `unknown off-chain action ${action}` };
    }
  }

  /**
   * Sweep the joint address to the inventory wallet with both spend shares (the other one is
   * in the swap). The sweep is built once, stored, and then published; a repeat publishes the
   * stored bytes. It spends exactly the verified output and pays at most the fee cap.
   */
  private async sweep(row: SwapRow, view: SwapView): Promise<StepOutcome> {
    const share = this.makerShare(row, view);
    const txid = view.direction === 0 ? this.store.lockTx(row.ref)?.txid : this.takerNotice(view) ? hex(this.takerNotice(view)!.txid) : undefined;
    if (!txid) {
      // Nothing was ever locked at the joint address that this daemon knows of: nothing to sweep.
      this.store.updateSwap(row.ref, { swept: 1 });
      return { kind: 'acted', what: 'nothing to sweep' };
    }
    let stored = this.store.swap(row.ref)!.facts.sweep;
    if (!stored) {
      // Consensus refuses to spend an output before it is 10 blocks deep, whatever the swap's depth tier.
      const lock = await this.verifyAt(row, view, txid, 10);
      if (lock.state === 'not-found' || lock.state === 'invalid') {
        this.o.alerts.raise('warning', 'sweep_blocked', `the lock at the joint address is ${lock.state}; nothing can be swept yet`, row.ref, 3_600);
        return { kind: 'waiting', on: 'xmr-lock', until: null };
      }
      if (lock.state !== 'confirmed' || lock.blockHeight === undefined || lock.outputIndex === undefined) return { kind: 'waiting', on: 'sweep-unlock', until: null };
      const joint = this.joint(row, view);
      const spendKey = jointSpendKey(view, share.keys.spend, 'maker');
      const destination = await this.o.inventory.address();
      const maxFee = this.o.sweepMaxFee?.() ?? sweepMaxFee(lock.amount ?? view.xmr);
      const outcome = await this.o.journal.act(
        'xmr_sweep',
        row.ref,
        { lockTxid: txid, destination },
        () => this.o.monero.buildSweep({ spendKey, viewKey: joint.viewPriv, lockHeight: lock.blockHeight!, lockTxid: txidBytes(txid), outputIndex: BigInt(lock.outputIndex!), destination, maxFee }),
        (r) => {
          this.store.patchFacts(row.ref, { sweep: { txid: r.txid, txHex: r.txHex } });
          return { tx: r.txid, meta: { fee: r.fee.toString(), amount: r.amount.toString() } };
        },
      );
      stored = { txid: outcome.txid, txHex: outcome.txHex };
    }
    const sweepTx = stored;
    await this.o.journal.act(
      'xmr_relay',
      row.ref,
      { txid: sweepTx.txid, sweep: true },
      async () => {
        const r = await this.o.broadcaster.sendRaw(sweepTx.txHex);
        if (!r.ok && !(await this.o.monero.txKnown(sweepTx.txid))) throw new Error(`the nodes refused the sweep: ${r.reason ?? 'unknown reason'}`);
        return r;
      },
      () => {
        this.store.updateSwap(row.ref, { swept: 1, sweep_txid: sweepTx.txid });
        return { tx: sweepTx.txid };
      },
    );
    return { kind: 'acted', what: 'swept' };
  }

  private async material(row: SwapRow, chain: SwapChain, view: SwapView, call: FlowCall): Promise<CallMaterial> {
    switch (call.name) {
      case 'approve': {
        if (view.chain !== 'solana') {
          // Ethereum: the lock named a pool leaf; from now on that share belongs to this swap and no other.
          const named = this.store.shareByPub(hex(view.makerSpendPub));
          if (named && !named.swap_ref) this.store.setShare(named.share_id, 'bound', row.ref);
          return {};
        }
        // Window mode on Solana: the share is supplied now. One share per swap, created (row first) once and reused on a retry.
        const share = this.o.shares.forSwap(row.ref) ?? this.o.shares.create('solana', 'approve', row.ref, 'bound');
        const s = solanaMakerShare(share.keys, this.makerCtx(chain));
        return { makerShare: { spendPub: s.share, pok: s.pok } };
      }
      case 'fund': {
        const share = this.o.shares.forSwap(row.ref) ?? this.o.shares.create(view.chain, 'fund', row.ref, 'bound');
        // The maker's watcher is named here, at `fund`, and only on a swap whose terms carry a freeze window.
        const named = this.o.watcher?.nameFor(view) ?? null;
        const watcher = named ? { watcher: named } : {};
        if (view.chain === 'solana') {
          const s = solanaMakerShare(share.keys, this.makerCtx(chain));
          return { makerShare: { spendPub: s.share, pok: s.pok, view: share.keys.view }, ...watcher };
        }
        // Ethereum: the maker's own proof for the share it is about to use MUST already be served (SPEC 6.4).
        if (!this.store.blob(share.row.spend_pub)) this.store.putBlob(share.row.spend_pub, dleqProve(share.keys.spend), true, row.ref);
        const twin = twinCommitments(share.keys.spend);
        return { makerShare: { spendPub: share.keys.spendPub, key: hex0x(twin.keyAddr), key2: hex0x(twin.keyAddr2), view: share.keys.view }, ...watcher };
      }
      case 'post_notice': {
        const lock = this.store.lockTx(row.ref);
        if (!lock) throw new Error('no prepared lock transaction to announce');
        return { notice: buildNotice(view, this.encSecret(view), txidBytes(lock.txid), this.makerShare(row, view).keys.view) };
      }
      case 'claim':
      case 'refund':
        return { secret: this.makerShare(row, view).keys.spend };
      case 'withhold':
      case 'publish_evidence': {
        if (call.name === 'withhold' && call.evidence === 'absent') return {};
        const ev = evidenceFor(this.store, this.o.shares, row.ref, view);
        if (!ev) throw new Error('the opening of this notice is not available');
        return { evidence: ev };
      }
      default:
        return {};
    }
  }
  /** The 32-byte context a Solana maker share's proof of knowledge is bound to: the maker PDA. */
  private makerCtx(chain: SwapChain): Bytes {
    const pda = (chain as unknown as { makerPda?: string }).makerPda;
    if (!pda) throw new Error('the Solana maker PDA is not known');
    return base58Decode(pda);
  }

  private async call(row: SwapRow, chain: SwapChain, view: SwapView, now: bigint, d: Extract<Decision, { do: 'call' }>): Promise<StepOutcome> {
    const name = d.call.name;
    if (d.caller === 'owner') {
      // A parked payout is pulled by the cold owner key, which the daemon never holds.
      this.o.alerts.raise('warning', 'owed_payout', 'a payout of this swap is parked; withdraw it with the owner wallet in the console', row.ref, 86_400);
      return this.finish(row, view, endedInClaim(view) ? 'completed' : 'refunded');
    }
    if (d.notAfter !== null && now > d.notAfter) return { kind: 'waiting', on: `${name} window passed`, until: null };
    const cfg = this.o.config();
    if (cfg.raw.daemon.mode !== 'live') return { kind: 'parked', why: `dry run: would send ${name} (${d.row})` };
    if (d.secret) {
      // Belt and braces on top of the flow: the model must accept this exact call at this second, with margin to spare.
      const callForModel = name === 'claim' ? ({ name: 'claim', secretOk: true } as const) : ({ name: 'refund', secretOk: true } as const);
      if (!enabled(view.chain, view, callForModel, 'operator', now)) return { kind: 'error', error: `refusing to broadcast a spend share: ${name} is not enabled at chain time ${now}` };
      if (name === 'claim' && view.direction === 0 && this.store.lockTx(row.ref)?.relayed_at == null) return { kind: 'error', error: 'refusing to claim: the XMR lock was never relayed' };
    }
    if (name === 'fund') {
      // The operator's balance is what direction B commits; USDC on Ethereum needs the contract's allowance first.
      const eth = chain.chain === 'ethereum' ? (chain as unknown as EthereumChain) : null;
      if (eth && !/^0x0{40}$/.test(view.asset)) {
        const approveTx = await this.o.journal.broadcast('eth_tx', row.ref, { call: 'erc20_approve', token: view.asset }, (onSigned) => eth.ensureAllowance(view.asset as `0x${string}`, view.amount, onSigned));
        if (approveTx.tx) return { kind: 'acted', what: 'approved token allowance' };
      }
    }
    if (name === 'post_notice' && view.direction === 0) {
      // Never announce a lock that can no longer be accepted. The transaction itself is shown to no node before the
      // notice is final (SPEC 7.5), so what is checked is everything a node would refuse it for: its inputs must be
      // unspent in the chain AND the pool on the nodes, and reserved for this swap alone. If the nodes cannot be
      // asked, the notice waits.
      const ok = await this.o.inventory.lockSpendable(row.ref);
      if (!ok.ok) {
        this.o.inventory.discardLock(row.ref);
        this.store.updateSwap(row.ref, { lock_txid: null });
        this.o.alerts.raise('warning', 'lock_rebuilt', `the prepared lock could no longer be accepted (${ok.reason}); it was discarded before any notice and is built again from another output`, row.ref);
        return { kind: 'acted', what: 'discarded an unspendable lock' };
      }
    }
    let material: CallMaterial;
    try {
      material = await this.material(row, chain, view, d.call);
    } catch (e) {
      return { kind: 'error', error: errMsg(e) };
    }
    try {
      await this.o.journal.broadcast(chain.chain === 'solana' ? 'sol_tx' : 'eth_tx', row.ref, { call: name, row: d.row, secret: d.secret, state: view.state, at: now }, (onSigned) => chain.send(view, d.call, material, onSigned));
    } catch (e) {
      if (e instanceof CrashError) throw e;
      if (e instanceof Refused) {
        // The simulation refused it: nothing was broadcast. Usually the state moved under us; the next step re-reads.
        this.store.updateSwap(row.ref, { last_error: `${name} refused: ${e.message}` });
        if (d.secret || d.urgent) this.o.alerts.raise('critical', 'call_refused', `${name} (${d.row}) was refused in simulation: ${e.message}`, row.ref);
        return { kind: 'error', error: `${name} refused: ${e.message}` };
      }
      throw e;
    }
    if (name === 'claim' || name === 'refund') {
      const share = this.o.shares.forSwap(row.ref, view.makerSpendPub);
      if (share) this.store.setShare(share.row.share_id, 'revealed');
    }
    return { kind: 'acted', what: name };
  }

  private finish(row: SwapRow, view: SwapView | null, outcome: string): StepOutcome {
    this.store.tx(() => {
      const lock = this.store.lockTx(row.ref);
      if (!lock || lock.relayed_at === null) this.o.inventory.release(row.ref);
      this.store.updateSwap(row.ref, { terminal: 1, phase: outcome, ...(view ? { state: view.state, outcome: view.outcome, snapshot: snapshotOf(view) } : { state: SWAP_STATE.NONE }) });
      if (view && outcome === 'completed') {
        const offer = this.offerFor(row);
        const ref = row.facts.refPriceUsd ?? this.o.xmrUsd();
        // Spread earned against the reference at lock time: the offer's deviation applied to the swap's XMR.
        const spread = offer && ref ? (Number(view.xmr) / 1e12) * ref * (offer.deviationPct / 100) : null;
        this.store.recordFill({ swap_ref: row.ref, market: row.market, direction: row.direction, xmr: view.xmr, amount: view.amount, spread_usd: spread });
      }
    });
    return { kind: 'done', outcome };
  }

  // ---------------------------------------------------------------- manual actions from the console

  /**
   * An explicit instruction from the operator. It is written to the database BEFORE anything
   * acts on it, so a crash or a restart cannot lose it; it then travels through the same flow
   * as an automatic step, where it wins over every automatic step while the contract still
   * accepts the call. The caller always learns what became of it: carried out (with the
   * transaction), refused (with the reason), or pending behind a transaction still in flight
   * (then it is settled on a later step, and an alert says how).
   */
  async manual(ref: string, patch: NonNullable<SwapFacts['manual']>): Promise<StepOutcome & InstructionResult> {
    if (!this.store.swap(ref)) throw new Error('unknown swap');
    // The instruction is journaled INSIDE the swap's own section: a pass already running over this swap finishes first
    // and never sees it (it decided before the instruction existed, so it has no say on it). The pass that settles it
    // therefore always began after it was journaled, and reads the chain afresh.
    return this.mutex.run(ref, async () => {
      const row = this.store.swap(ref)!;
      const action: InstructionAction = patch.approve === true ? 'approve' : patch.approve === false ? 'reject' : patch.abort ? 'abort' : patch.release ? 'release' : patch.withhold ? 'withhold' : patch.publishEvidence ? 'publish-evidence' : 'withhold';
      // A standing override ("do not withhold this one") is a policy setting, not an action to carry out.
      const standing = patch.withhold === false && !patch.release;
      const mark = (this.store.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM intents').get() as { n: number }).n;
      const instruction: Instruction = { action, at: this.store.now(), mark, stateAt: row.state, status: 'pending' };
      this.store.patchFacts(ref, { manual: { ...(row.facts.manual ?? {}), ...patch }, ...(standing ? {} : { instruction }) });
      this.o.journal.crash('instructed', { id: 0, kind: row.chain === 'solana' ? 'sol_tx' : 'eth_tx', payload: { call: `instruction:${action}` } });
      const out = await this.pass(ref);
      const settled = this.store.swap(ref)?.facts.instruction;
      return { ...out, ...(settled && !standing ? { instruction: settled } : {}) };
    });
  }

  /** Which landed call carries an instruction out. */
  private static carriedBy(action: InstructionAction, direction: 0 | 1): string[] {
    switch (action) {
      case 'approve':
        return ['approve', 'fund'];
      case 'reject':
        return ['reject'];
      case 'abort':
        return direction === 0 ? ['abort'] : ['refund'];
      case 'withhold':
        return ['withhold'];
      case 'release':
        return ['release_deposit'];
      case 'publish-evidence':
        return ['publish_evidence', 'withhold'];
    }
  }

  /** Decide what became of a pending instruction after a step. One-shot: once settled, its flag is cleared so it cannot fire later by surprise. */
  private settleInstruction(ref: string, last: StepOutcome): void {
    const row = this.store.swap(ref);
    const ins = row?.facts.instruction;
    if (!row || !ins || ins.status !== 'pending') return;
    const calls = Executor.carriedBy(ins.action, row.direction);
    const mine = this.store.intents({ swapRef: ref }).filter((i) => i.id > ins.mark && calls.includes(String(i.payload['call'])));
    const confirmed = mine.find((i) => i.status === 'confirmed' && i.meta?.['noop'] !== true);
    const inFlight = mine.some((i) => i.status === 'planned' || i.status === 'sent' || i.status === 'needs_review');
    let next: Instruction | null = null;
    if (confirmed) next = { ...ins, status: 'carried_out', tx: confirmed.tx };
    else if (inFlight) return; // sent, not yet resolved: carried out only once it is confirmed; if it dies, the flag is still set and it is planned again
    else if (last.refused !== undefined) next = { ...ins, status: 'refused', reason: last.refused };
    else if (last.kind === 'waiting' && last.on.startsWith('transaction')) return; // behind another transaction of this swap; honoured when that resolves
    else if (last.kind === 'error') return; // nothing was decided (an RPC failure, a refused simulation): tried again on the next step
    else if (last.kind === 'parked' && last.why.startsWith('dry run')) next = { ...ins, status: 'refused', reason: 'dry-run' };
    // A refusal must mean the contract would refuse it: only a pass that read the chain with this instruction on record
    // (`seen`), or that found the swap already settled, may say so. Anything else leaves it pending for the next pass.
    else if (!ins.seen && !row.terminal) return;
    else next = { ...ins, status: 'refused', reason: Executor.ownRefusal(ins, row) };
    const m = { ...(row.facts.manual ?? {}) };
    if (ins.action === 'approve' || ins.action === 'reject') {
      // A carried-out decision stays on record. A refused APPROVAL is withdrawn. A refused REJECTION is not: where the
      // chain offers no reject (a Solana take outside window mode) the operator's "no" still means the daemon must not
      // fund it; the take is left to lapse.
      if (next.status === 'refused' && ins.action === 'approve') {
        delete m.approve;
        delete m.rejectReason;
      }
    } else if (ins.action === 'abort') delete m.abort;
    else if (ins.action === 'withhold') delete m.withhold;
    else if (ins.action === 'release') delete m.release;
    else delete m.publishEvidence;
    this.store.patchFacts(ref, { manual: m, instruction: next });
    if (next.status === 'refused') this.o.alerts.raise('warning', 'instruction_refused', `"${ins.action}" could not be carried out on this swap: ${next.reason}`, ref, 0);
  }

  /** The daemon's own reason when the flow went another way without naming one (direction A has no explicit back-out fact in the flow). */
  private static ownRefusal(ins: Instruction, row: SwapRow): string {
    const S = SWAP_STATE;
    const state = ins.seen ? ins.stateAt : row.terminal ? S.DONE : ins.stateAt;
    if (state === S.DONE || state === S.NONE) return 'already-settled';
    if (ins.action === 'abort') {
      if (state === S.READY) return 'ready-already-set';
      if (state === S.HOLD || state === S.WITHHELD) return 'already-settled';
      if (state === S.ABORTED_FREE || state === S.ABORTED_HOLD || state === S.NOTICED || state === S.FROZEN) return 'abort-window-closed';
    }
    if ((ins.action === 'withhold' || ins.action === 'release') && state !== S.HOLD && state !== S.WITHHELD) return 'no-deposit-held';
    return 'not-available-in-state';
  }
}
