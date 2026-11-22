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
    return this.serial(async () => {
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
    });
  }

  private usable(): OutputRow[] {
    return this.store.outputs().filter((o) => o.unlocked === 1 && !o.reserved_for && !o.spent);
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
              this.store.reserveOutput(output.key_image, swapRef);
              await this.o.wallet.thaw(output.key_image);
              try {
                return { output, tx: await this.o.wallet.prepare([{ address, amount }]) };
              } catch (e) {
                this.store.reserveOutput(output.key_image, null);
                if (!(e instanceof WalletError) || e.code !== 'not_enough') throw e;
              } finally {
                await this.o.wallet.freeze(output.key_image);
              }
            }
            return null;
          },
          (r) => {
            if (!r) return { meta: { unavailable: true } };
            const keyImages = r.tx.keyImages.length > 0 ? r.tx.keyImages : [r.output.key_image];
            for (const k of keyImages) this.store.reserveOutput(k, swapRef);
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
    const result = await this.o.journal.act(
      'xmr_relay',
      swapRef,
      { txid: lock.txid, rebroadcast },
      async () => {
        const r = await this.o.broadcaster.sendRaw(lock.tx_hex);
        if (r.ok) return 'relayed' as const;
        if (await known()) return 'relayed' as const;
        if (r.doubleSpend) return 'double-spend' as const;
        throw new Error(`the nodes refused the lock transaction: ${r.reason ?? 'unknown reason'}`);
      },
      (r) => {
        if (r === 'relayed') this.store.markLockRelayed(swapRef, rebroadcast);
        return { tx: lock.txid, meta: { result: r } };
      },
    );
    return result;
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
            for (const k of b.inputs) await this.o.wallet.thaw(k);
            try {
              return await this.o.wallet.prepare(b.amounts.map((amount) => ({ address, amount })));
            } finally {
              for (const k of b.inputs) await this.o.wallet.freeze(k);
            }
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
          for (const k of inputs) await this.o.wallet.thaw(k);
          try {
            return await this.o.wallet.prepare([{ address: to, amount }]);
          } finally {
            for (const k of inputs) await this.o.wallet.freeze(k);
          }
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
