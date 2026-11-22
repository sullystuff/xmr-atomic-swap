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
import type { IntentRow, Store, SwapFacts, SwapRow } from '../store/db.js';
import { CrashError, type Journal } from '../store/journal.js';
import { type Bytes, Emitter, KeyedMutex, errMsg, hex, toJson, unhex } from '../util.js';
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
  config: () => Config;
  /** USD per XMR right now, or `null` (the withhold rule and the fill record use it). */
  xmrUsd: () => number | null;
  /** Sweep fee cap override in piconero (regtest fees are far above mainnet's). */
  sweepMaxFee?: () => bigint | undefined;
  /** Milliseconds a sent transaction may stay unresolved before the swap is parked for review (still re-checked every step). */
  stuckAfterMs?: Partial<Record<ChainName, number>>;
  clock?: () => number;
}

export type StepOutcome =
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
    const open = this.store.swaps({ open: true }).sort((a, b) => Number(b.direction === 1 && b.state === SWAP_STATE.NOTICED) - Number(a.direction === 1 && a.state === SWAP_STATE.NOTICED));
    const out = new Map<string, StepOutcome>();
    for (const row of open) out.set(row.ref, await this.step(row.ref));
    return out;
  }

  /** Advance one swap as far as it goes without waiting. Serialised per swap; safe to call at any time and after any crash. */
  step(ref: string): Promise<StepOutcome> {
    return this.mutex.run(ref, async () => {
      let last: StepOutcome = { kind: 'waiting', on: 'nothing', until: null };
      try {
        for (let i = 0; i < 12; i++) {
          last = await this.once(ref);
          if (last.kind !== 'acted') break;
        }
      } catch (e) {
        if (e instanceof CrashError) throw e;
        const error = errMsg(e);
        this.store.updateSwap(ref, { last_error: error });
        last = { kind: 'error', error };
      }
      this.events.emit('swap', ref);
      return last;
    });
  }

  private async once(ref: string): Promise<StepOutcome> {
    const row = this.store.swap(ref);
    if (!row) return { kind: 'error', error: 'unknown swap' };
    if (row.terminal) return { kind: 'done', outcome: row.phase };
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

    // 3. Facts, decision, action.
    const facts: MakerFacts = { swap: view, now, ...(await this.baseFacts(row, view)) };
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
        if (status.fee !== undefined) this.store.recordFee(row.chain, String(intent.payload['call'] ?? 'swap'), row.chain === 'solana' ? 'sol' : 'eth', status.fee, intent.tx);
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

  private async baseFacts(row: SwapRow, view: SwapView): Promise<Partial<MakerFacts>> {
    const f: Partial<MakerFacts> = {};
    const S = SWAP_STATE;
    const offer = this.offerFor(row);
    if (view.state === S.PENDING) {
      const m = row.facts.manual;
      if (row.facts.takerProofOk !== undefined) f.takerProofOk = row.facts.takerProofOk;
      if (m?.approve === true) f.approval = { approve: true };
      else if (m?.approve === false) f.approval = { approve: false, reason: m.rejectReason ?? 0 };
      else if (row.facts.approval) f.approval = row.facts.approval;
    }
    if (row.facts.verified && view.state !== S.PENDING) f.commitmentsOk = row.facts.verified === commitmentHash(view);
    if (view.direction === 0) {
      const lock = this.store.lockTx(row.ref);
      f.lockTx = !lock ? 'none' : lock.relayed_at === null ? 'prepared' : 'relayed';
      if (row.facts.lockFailed || row.facts.manual?.abort) f.lockFailed = true;
      if (offer?.withoutReady) f.withoutReady = offer.withoutReady;
      // Keep watching the relayed lock until the swap is settled: rebroadcast if it dropped out, abort if it can no longer confirm.
      if (lock && lock.relayed_at !== null && (view.state === S.NOTICED || view.state === S.READY)) {
        const report = await this.ownLockReport(row, view);
        f.lock = report;
        if (report.state === 'not-found' && !f.lockFailed && (await this.o.inventory.inputsSpentElsewhere(row.ref).catch(() => false))) {
          this.store.patchFacts(row.ref, { lockFailed: true });
          f.lockFailed = true;
        }
      }
    } else if (row.facts.manual?.abort) f.backOut = true;
    if (view.state === S.HOLD || view.state === S.WITHHELD) {
      f.withhold = view.state === S.HOLD && withholdDecision(offer, row.facts, this.o.xmrUsd());
      f.release = releaseDecision(row.facts);
    }
    f.swept = row.swept === 1;
    return f;
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
        const d = await this.o.approvals.decide(view, row, this.offerFor(row));
        if (!d.verdict) return { kind: 'waiting', on: 'approval-decision', until: deadlinesOf(view.chain, view).tPend };
        // The verdict is bound to the lock it examined: remember what was verified.
        this.store.patchFacts(row.ref, { approval: d.verdict, ...(d.verdict.approve ? { verified: commitmentHash(view) } : {}) });
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
        if (view.state !== SWAP_STATE.NOTICED && view.state !== SWAP_STATE.READY) return { kind: 'error', error: 'refusing to relay XMR: the swap is not in NOTICED' };
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
        if (view.chain === 'solana') {
          const s = solanaMakerShare(share.keys, this.makerCtx(chain));
          return { makerShare: { spendPub: s.share, pok: s.pok, view: share.keys.view } };
        }
        // Ethereum: the maker's own proof for the share it is about to use MUST already be served (SPEC 6.4).
        if (!this.store.blob(share.row.spend_pub)) this.store.putBlob(share.row.spend_pub, dleqProve(share.keys.spend), true, row.ref);
        const twin = twinCommitments(share.keys.spend);
        return { makerShare: { spendPub: share.keys.spendPub, key: hex0x(twin.keyAddr), key2: hex0x(twin.keyAddr2), view: share.keys.view } };
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
      if (eth) {
        const approveTx = await this.o.journal.broadcast('eth_tx', row.ref, { call: 'erc20_approve', token: view.asset }, (onSigned) => eth.ensureAllowance(view.asset as `0x${string}`, view.amount, onSigned));
        if (approveTx.tx) return { kind: 'acted', what: 'approved token allowance' };
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

  /** Record a manual decision and step the swap. The decision travels through the same flow as an automatic one. */
  async manual(ref: string, patch: NonNullable<SwapFacts['manual']>): Promise<StepOutcome> {
    const row = this.store.swap(ref);
    if (!row) throw new Error('unknown swap');
    this.store.patchFacts(ref, { manual: { ...(row.facts.manual ?? {}), ...patch } });
    return this.step(ref);
  }
}
