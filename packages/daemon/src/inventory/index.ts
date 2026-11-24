/**
 * Inventory splitter (DESIGN "Maker tools"; SPEC 7.1 `inventory/`; `docs/research/monero.md` 4).
 *
 * A spent output's change is locked for 10 blocks, so one output funds one swap at a time. The
 * module keeps a ladder of outputs sized slightly above the offer sizes, tracks which output
 * backs which swap, and reports capacity as UNLOCKED outputs, never balance.
 *
 * Coin control: wallet-rpc chooses inputs itself, so every known output is kept frozen and only
 * the one reserved for a swap (or the sources of a split) is thawed for the duration of the
 * call that builds the transaction. Lock transactions are built WITHOUT relaying; the raw hex
 * is stored and relayed later through a node, so a relay can be repeated but never duplicated.
 */
import { MONERO_LOCK_WINDOW } from '@xmrswap/protocol';
import type { InventoryResponse } from '@xmrswap/protocol/daemon-api';
import type { LockTxRow, OutputRow, Store } from '../store/db.js';
import type { Journal } from '../store/journal.js';
import { KeyedMutex } from '../util.js';
import { type InventoryWallet, type MoneroBroadcaster, type PreparedTx, WalletError } from '../monero/wallet.js';

export interface Rung {
  sizeXmr: bigint;
  count: number;
}
export interface SplitBatch {
  inputs: string[];
  amounts: bigint[];
}
type PlanOutput = Pick<OutputRow, 'key_image' | 'amount' | 'unlocked' | 'reserved_for' | 'spent'>;

/** Ladder output size for an offer size: slightly above it, so one output covers amount plus fee. */
export const rungTarget = (sizeXmr: bigint, headroomPct: number): bigint => sizeXmr + (sizeXmr * BigInt(Math.round(headroomPct * 100))) / 10_000n;

/** Which rung an output fills: at least the rung's target and below both the next rung and twice the target. `-1` = loose. */
export function rungOf(amount: bigint, ladder: Rung[], headroomPct: number): number {
  const targets = ladder.map((r) => rungTarget(r.sizeXmr, headroomPct));
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (amount >= t) return amount < 2n * t && (i === targets.length - 1 || amount < targets[i + 1]!) ? i : -1;
  }
  return -1;
}

/**
 * Plan pre-split transactions: fill each rung's deficit (largest rung first) from loose,
 * unlocked, unreserved outputs. Up to 15 ladder outputs per transaction (16 with change).
 * Pure; `feeReserve` is kept back per transaction.
 */
export function planSplit(outputs: PlanOutput[], ladderIn: Rung[], headroomPct: number, feeReserve: bigint, maxOutputsPerTx = 15): SplitBatch[] {
  const ladder = [...ladderIn].sort((a, b) => (a.sizeXmr < b.sizeXmr ? -1 : 1));
  const live = outputs.filter((o) => !o.spent);
  const have = ladder.map(() => 0);
  const loose: { key: string; amount: bigint }[] = [];
  for (const o of live) {
    const amount = BigInt(o.amount);
    const r = rungOf(amount, ladder, headroomPct);
    if (r >= 0 && have[r]! < ladder[r]!.count) have[r]!++;
    else if (r < 0 && o.unlocked && !o.reserved_for) loose.push({ key: o.key_image, amount });
  }
  loose.sort((a, b) => (a.amount > b.amount ? -1 : 1));
  const wanted: bigint[] = [];
  for (let i = ladder.length - 1; i >= 0; i--) for (let n = have[i]!; n < ladder[i]!.count; n++) wanted.push(rungTarget(ladder[i]!.sizeXmr, headroomPct));

  const batches: SplitBatch[] = [];
  const sources = [...loose];
  let queue = [...wanted];
  while (queue.length > 0 && sources.length > 0) {
    // Each transaction spends one source (its change is locked for 10 blocks, so sources are not shared) and takes what fits.
    const src = sources.shift()!;
    let budget = src.amount - feeReserve;
    const amounts: bigint[] = [];
    const rest: bigint[] = [];
    for (const w of queue) {
      if (amounts.length < maxOutputsPerTx && w <= budget) {
        amounts.push(w);
        budget -= w;
      } else rest.push(w);
    }
    queue = rest;
    if (amounts.length > 0) batches.push({ inputs: [src.key], amounts });
  }
  return batches;
}

/** A node refused a transaction it does not already hold. */
export class RelayRefused extends Error {
  constructor(
    readonly doubleSpend: boolean,
    reason: string,
  ) {
    super(`the nodes refused the transaction: ${reason}`);
    this.name = 'RelayRefused';
  }
}

export interface InventoryOptions {
  store: Store;
  wallet: InventoryWallet;
  broadcaster: MoneroBroadcaster;
  journal: Journal;
  ladder: () => Rung[];
  headroomPct: () => number;
  reserveXmr: () => bigint;
  /** Kept back for the network fee when choosing an output and when splitting (piconero). */
  feeReserve?: () => bigint;
}

export class Inventory {
  private readonly o: InventoryOptions;
  private readonly mutex = new KeyedMutex();
  private walletHeight = 0;
  private walletAddress: string | null = null;

  constructor(o: InventoryOptions) {
    this.o = o;
  }
  private get store(): Store {
    return this.o.store;
  }
  private feeReserve(): bigint {
    return this.o.feeReserve?.() ?? 1_000_000_000n;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run('wallet', fn);
  }

  async address(): Promise<string> {
    return (this.walletAddress ??= await this.o.wallet.address());
  }

  /** Read the wallet's outputs into the table and freeze any the daemon has not frozen yet. */
  sync(): Promise<void> {
    return this.serial(() => this.syncLocked());
  }
  /**
   * The body of `sync`, for callers that already hold the wallet section. Every build of a
   * transaction starts with it, so that at the moment one output is thawed NOTHING else in the
   * wallet is spendable: an output that arrived since the last pass (a swept joint address,
   * change, a payment) cannot be pulled in as a second input.
   */
  private async syncLocked(): Promise<void> {
    await this.o.wallet.refresh();
    this.walletHeight = await this.o.wallet.height();
    const outs = await this.o.wallet.outputs();
    for (const w of outs) {
      if (w.spent) continue;
      // Unlocked needs both the wallet's word and 10 confirmations by our own count.
      const deep = w.blockHeight !== null && this.walletHeight - w.blockHeight >= MONERO_LOCK_WINDOW;
      if (!w.frozen) await this.o.wallet.freeze(w.keyImage);
      this.store.upsertOutput({ key_image: w.keyImage, amount: w.amount.toString(), block_height: w.blockHeight, unlocked: w.unlocked && deep, frozen: true, spent: false });
    }
    this.store.markOutputsSpent(outs.filter((w) => !w.spent).map((w) => w.keyImage));
  }

  /**
   * Build a transaction from EXACTLY the given outputs: they are reserved in the database first,
   * thawed for the build only, and the result is refused unless every input it spends is one of
   * them. If the wallet pulled in anything else (an output that appeared in the instant between
   * the freeze pass and the build), that transaction is thrown away unstored and unrelayed, the
   * stray output is frozen, and the build is tried once more. `null` = the outputs do not cover it.
   */
  private async buildExclusive(inputs: string[], reservedFor: string, destinations: { address: string; amount: bigint }[]): Promise<PreparedTx | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.syncLocked();
      for (const k of inputs) this.store.reserveOutput(k, reservedFor);
      let tx: PreparedTx;
      try {
        for (const k of inputs) await this.o.wallet.thaw(k);
        tx = await this.o.wallet.prepare(destinations);
      } catch (e) {
        if (e instanceof WalletError && e.code === 'not_enough') return null;
        throw e;
      } finally {
        for (const k of inputs) await this.o.wallet.freeze(k);
      }
      const foreign = tx.keyImages.filter((k) => !inputs.includes(k));
      if (foreign.length === 0) return tx;
      // Never stored, never relayed: the wallet's choice is not ours to accept.
      for (const k of foreign) await this.o.wallet.freeze(k).catch(() => undefined);
    }
    throw new WalletError('rpc', 'the wallet keeps adding inputs that were not reserved for this transaction; nothing was built');
  }

  private usable(): OutputRow[] {
    return this.store.outputs().filter((o) => o.unlocked === 1 && !o.reserved_for && !o.spent);
  }

  /** What each unlocked, unreserved output can fund (its amount less the fee reserve), smallest first. */
  usableAmounts(): bigint[] {
    const fee = this.feeReserve();
    return this.usable().map((o) => BigInt(o.amount) - fee).filter((a) => a > 0n).sort((a, b) => (a < b ? -1 : 1));
  }

  /** Capacity counted in unlocked, unreserved outputs: the total (less the reserve) and the largest single swap an output can fund. */
  capacity(): { total: bigint; largest: bigint; outputs: number } {
    const usable = this.usable().map((o) => BigInt(o.amount));
    const sum = usable.reduce((a, b) => a + b, 0n);
    const reserve = this.o.reserveXmr();
    const fee = this.feeReserve();
    const largest = usable.reduce((m, a) => (a > m ? a : m), 0n);
    return { total: sum > reserve ? sum - reserve : 0n, largest: largest > fee ? largest - fee : 0n, outputs: usable.length };
  }

  /**
   * The lock transaction of a direction-A swap: built and signed, NOT relayed, stored with its
   * inputs. Idempotent per swap (one `lock_txs` row, ever). `'unavailable'` when no unlocked
   * output can fund it.
   */
  prepareLock(swapRef: string, address: string, amount: bigint): Promise<LockTxRow | 'unavailable'> {
    return this.serial(async () => {
      const existing = this.store.lockTx(swapRef);
      if (existing) return existing;
      await this.syncLocked();
      const candidates = this.usable().filter((o) => BigInt(o.amount) >= amount + this.feeReserve());
      if (candidates.length === 0) return 'unavailable';
      let chosen: { output: OutputRow; tx: PreparedTx } | null = null;
      try {
        chosen = await this.o.journal.act(
          'xmr_prepare',
          swapRef,
          { address, amount },
          async () => {
            for (const output of candidates) {
              // Reserved in the database BEFORE the wallet is asked; stays reserved until the lock is stored, or is given back here.
              const tx = await this.buildExclusive([output.key_image], swapRef, [{ address, amount }]).catch((e) => {
                this.store.reserveOutput(output.key_image, null);
                throw e;
              });
              if (tx) return { output, tx };
              this.store.reserveOutput(output.key_image, null);
            }
            return null;
          },
          (r) => {
            if (!r) return { meta: { unavailable: true } };
            // Exactly the reserved output (a wallet that does not report its inputs was given nothing else to spend).
            const keyImages = [r.output.key_image];
            this.store.insertLockTx({ swap_ref: swapRef, tx_hex: r.tx.txHex, txid: r.tx.txid, key_images: keyImages, amount: amount.toString() });
            return { tx: r.tx.txid, meta: { fee: r.tx.fee.toString(), output: r.output.key_image } };
          },
        );
      } catch (e) {
        if (e instanceof WalletError && e.code === 'not_enough') return 'unavailable';
        throw e;
      }
      return chosen ? this.store.lockTx(swapRef)! : 'unavailable';
    });
  }

  /**
   * Relay the stored lock transaction of a swap (first relay or rebroadcast). The same raw
   * bytes every time, so repeating it cannot create a second payment. `known` says whether
   * the nodes already have the transaction, which is what a refusal usually means.
   */
  async relayLock(swapRef: string, known: () => Promise<boolean>, rebroadcast = false): Promise<'relayed' | 'double-spend'> {
    const lock = this.store.lockTx(swapRef);
    if (!lock) throw new Error(`no stored lock transaction for ${swapRef}`);
    try {
      await this.o.journal.act(
        'xmr_relay',
        swapRef,
        { txid: lock.txid, rebroadcast },
        async () => {
          const r = await this.o.broadcaster.sendRaw(lock.tx_hex);
          if (r.ok) return r;
          // A refusal is a success only if the nodes already hold this very transaction.
          if (await known()) return r;
          // Anything else is a refusal, and is journaled as one: never `confirmed`.
          throw new RelayRefused(r.doubleSpend === true, r.reason ?? 'unknown reason');
        },
        () => {
          this.store.markLockRelayed(swapRef, rebroadcast);
          return { tx: lock.txid, meta: { result: 'relayed' } };
        },
      );
    } catch (e) {
      if (e instanceof RelayRefused && e.doubleSpend) return 'double-spend';
      throw e;
    }
    return 'relayed';
  }

  /**
   * Whether the stored (not yet relayed) lock of a swap can still be accepted: none of its
   * inputs is spent in the chain or by a pool transaction on any node asked, and no other
   * stored lock spends one of them. Checked BEFORE the notice that names it is posted; the
   * transaction itself is not shown to any node before the notice is final.
   */
  async lockSpendable(swapRef: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lock = this.store.lockTx(swapRef);
    if (!lock) return { ok: false, reason: 'no stored lock transaction' };
    for (const o of this.store.outputs()) if (lock.key_images.includes(o.key_image) && o.reserved_for !== swapRef) return { ok: false, reason: `input ${o.key_image.slice(0, 8)}… is reserved for ${o.reserved_for ?? 'nothing'}` };
    const status = await this.o.broadcaster.keyImageStatus(lock.key_images);
    const bad = status.findIndex((x) => x !== 0);
    return bad < 0 ? { ok: true } : { ok: false, reason: `input ${lock.key_images[bad]!.slice(0, 8)}… is already spent ${status[bad] === 1 ? 'in the chain' : 'by a transaction in the pool'}` };
  }

  /** Drop a prepared lock that can no longer be accepted (before its notice): its inputs are gone, so they are not given back. */
  discardLock(swapRef: string): void {
    this.store.tx(() => {
      const lock = this.store.lockTx(swapRef);
      if (!lock || lock.relayed_at !== null) return;
      this.store.deleteUnrelayedLockTx(swapRef);
      for (const k of lock.key_images) this.store.reserveOutput(k, `unspendable:${lock.txid}`);
    });
  }

  /** Whether an input of the stored lock was spent by another transaction (the lock can then never confirm). */
  async inputsSpentElsewhere(swapRef: string): Promise<boolean> {
    const lock = this.store.lockTx(swapRef);
    if (!lock || lock.key_images.length === 0) return false;
    return (await this.o.broadcaster.keyImagesSpent(lock.key_images)).some(Boolean);
  }

  /** Give a swap's output back: the swap ended before its lock was relayed. A relayed lock keeps its row (the output is spent). */
  release(swapRef: string): void {
    this.store.tx(() => {
      const lock = this.store.lockTx(swapRef);
      if (lock && lock.relayed_at === null) this.store.deleteUnrelayedLockTx(swapRef);
      for (const o of this.store.outputs()) if (o.reserved_for === swapRef && (!lock || lock.relayed_at === null)) this.store.reserveOutput(o.key_image, null);
    });
  }

  /** Pre-split to the configured ladder (or the one given): build, store, relay; one transaction per source output. */
  split(ladder: Rung[] = this.o.ladder()): Promise<{ txids: string[]; created: number }> {
    return this.serial(async () => {
      const address = await this.address();
      const batches = planSplit(this.store.outputs(), ladder, this.o.headroomPct(), this.feeReserve());
      const txids: string[] = [];
      let created = 0;
      for (const b of batches) {
        const tx = await this.o.journal.act(
          'xmr_split',
          null,
          { inputs: b.inputs, amounts: b.amounts },
          async () => {
            const built = await this.buildExclusive(b.inputs, 'split:pending', b.amounts.map((amount) => ({ address, amount })));
            if (!built) {
              for (const k of b.inputs) this.store.reserveOutput(k, null);
              throw new WalletError('not_enough', 'the split sources do not cover the ladder outputs and the fee');
            }
            return built;
          },
          (r) => ({ tx: r.txid, meta: { txHex: r.txHex } }),
        );
        await this.o.journal.act(
          'xmr_relay',
          null,
          { txid: tx.txid, split: true },
          async () => {
            const r = await this.o.broadcaster.sendRaw(tx.txHex);
            if (!r.ok) throw new Error(`the nodes refused the split transaction: ${r.reason ?? 'unknown reason'}`);
            return r;
          },
          () => {
            // The sources are spent from now on; the wallet reports it at the next sync.
            for (const k of b.inputs) this.store.reserveOutput(k, `split:${tx.txid}`);
            return { tx: tx.txid };
          },
        );
        txids.push(tx.txid);
        created += b.amounts.length;
      }
      return { txids, created };
    });
  }

  /**
   * A plain payment from the inventory (the rebalancer's `sendXmr`: a venue's deposit address).
   * Funded from unlocked, unreserved outputs, loose ones first so the ladder is spared. Built
   * once, stored, then relayed: a repeat of the relay sends the same bytes. Returns the txid.
   */
  send(to: string, amount: bigint): Promise<string> {
    return this.serial(async () => {
      const ladder = this.o.ladder();
      const h = this.o.headroomPct();
      const pool = this.usable().sort((a, b) => Number(rungOf(BigInt(a.amount), ladder, h) >= 0) - Number(rungOf(BigInt(b.amount), ladder, h) >= 0) || (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1));
      const inputs: string[] = [];
      let sum = 0n;
      for (const o of pool) {
        if (sum >= amount + this.feeReserve()) break;
        inputs.push(o.key_image);
        sum += BigInt(o.amount);
      }
      if (sum < amount + this.feeReserve()) throw new WalletError('not_enough', 'not enough unlocked XMR outputs for this payment');
      const tx = await this.o.journal.act(
        'xmr_send',
        null,
        { to, amount, inputs },
        async () => {
          const built = await this.buildExclusive(inputs, 'send:pending', [{ address: to, amount }]);
          if (!built) {
            for (const k of inputs) this.store.reserveOutput(k, null);
            throw new WalletError('not_enough', 'not enough unlocked XMR outputs for this payment');
          }
          return built;
        },
        (r) => {
          for (const k of inputs) this.store.reserveOutput(k, `send:${r.txid}`);
          return { tx: r.txid, meta: { txHex: r.txHex, fee: r.fee.toString() } };
        },
      );
      await this.o.journal.act(
        'xmr_relay',
        null,
        { txid: tx.txid, send: true },
        async () => {
          const r = await this.o.broadcaster.sendRaw(tx.txHex);
          if (!r.ok) throw new Error(`the nodes refused the payment: ${r.reason ?? 'unknown reason'}`);
          return r;
        },
        () => ({ tx: tx.txid }),
      );
      return tx.txid;
    });
  }

  /** The inventory part of `GET /api/inventory`. */
  view(inFlight: bigint): Pick<InventoryResponse, 'xmr' | 'ladder' | 'outputs' | 'capacity_xmr'> {
    const outs = this.store.outputs();
    const ladder = [...this.o.ladder()].sort((a, b) => (a.sizeXmr < b.sizeXmr ? -1 : 1));
    const h = this.o.headroomPct();
    const rows = ladder.map((r) => ({ size_xmr: r.sizeXmr.toString(), target_count: r.count, unlocked_count: 0, locked_count: 0 }));
    for (const o of outs) {
      const r = rungOf(BigInt(o.amount), ladder, h);
      if (r < 0) continue;
      if (o.unlocked === 1 && !o.reserved_for) rows[r]!.unlocked_count++;
      else rows[r]!.locked_count++;
    }
    const balance = outs.reduce((a, o) => a + BigInt(o.amount), 0n);
    const unlocked = outs.filter((o) => o.unlocked === 1).reduce((a, o) => a + BigInt(o.amount), 0n);
    return {
      xmr: { balance: balance.toString(), unlocked: unlocked.toString(), reserve: this.o.reserveXmr().toString(), in_flight: inFlight.toString() },
      ladder: rows,
      outputs: outs.map((o) => ({
        key_image: o.key_image, amount: o.amount, unlocked: o.unlocked === 1,
        blocks_to_unlock: o.unlocked === 1 || o.block_height === null ? (o.unlocked === 1 ? 0 : MONERO_LOCK_WINDOW) : Math.max(0, MONERO_LOCK_WINDOW - (this.walletHeight - o.block_height)),
        frozen: o.frozen === 1, reserved_for: o.reserved_for,
      })),
      capacity_xmr: this.capacity().total.toString(),
    };
  }
}
