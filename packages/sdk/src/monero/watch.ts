/**
 * Watching Monero (SPEC 2.11, 3.5): find payments to the joint address when no txid was
 * announced (direction B: the taker pays from its own wallet and the page finds the payment by
 * view-key scan), and keep re-verifying a known lock until the sweep is confirmed.
 * Lifted from `tests/monero-regtest/lib/watch.mjs`.
 */
import type { LockReport } from '../flows/types.js';
import { type MoneroNode, asNode } from './rpc.js';
import { type ParsedTx, parseTx, scanTx } from './tx.js';
import { type VerifyLockArgs, type VerifyLockResult, verifyLock } from './verify.js';

export interface FoundDeposit {
  txid: string;
  inPool: boolean;
  blockHeight: number | null;
  /** Sum of the outputs to the joint address whose amount opens its commitment. */
  amount: bigint;
}

/**
 * Scan the mempool and the blocks from `fromHeight` with the view key. The result is a list of
 * candidates from one node: run `verifyLock` on each before believing anything.
 */
export async function findDeposits(a: { node: string | MoneroNode; viewPriv: string; spendPub: string; fromHeight: number }): Promise<{ scannedTxs: number; tipHeight: number; found: FoundDeposit[] }> {
  const node = asNode(a.node);
  const info = await node.info();
  const hashes = new Set(await node.poolHashes());
  for (let h = Math.max(0, a.fromHeight); h < info.height; h++) for (const t of (await node.block(h)).tx_hashes ?? []) hashes.add(t);
  const found: FoundDeposit[] = [];
  for (const e of hashes.size ? await node.txs([...hashes]) : []) {
    let tx: ParsedTx;
    try {
      tx = parseTx((e.as_hex || e.pruned_as_hex)!);
    } catch {
      continue; // e.g. v1 transactions
    }
    const outs = scanTx(tx, a.viewPriv, a.spendPub).filter((o) => o.commitmentOk);
    if (outs.length) found.push({ txid: e.tx_hash, inPool: !!e.in_pool, blockHeight: e.in_pool ? null : (e.block_height ?? null), amount: outs.reduce((sum, o) => sum + o.amount, 0n) });
  }
  return { scannedTxs: hashes.size, tipHeight: info.height, found };
}

/** The part of a verification the flows consume. */
export const lockReport = (r: VerifyLockResult): LockReport => ({ state: r.state, ok: r.ok, confirmations: r.confirmations });

/**
 * Re-verify a lock on a timer. Every pass is a full `verifyLock` against every node: depth is
 * never cached, because confirmations can go down. A pass that throws (the node policy, a
 * malformed blob) is reported through `onError` and counts as "not confirmed".
 */
export class LockWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  last: VerifyLockResult | null = null;

  constructor(
    private readonly args: VerifyLockArgs,
    private readonly onResult: (r: VerifyLockResult) => void,
    private readonly verify: (a: VerifyLockArgs) => Promise<VerifyLockResult> = verifyLock,
  ) {}

  async poll(): Promise<VerifyLockResult | null> {
    if (this.busy) return this.last;
    this.busy = true;
    try {
      this.last = await this.verify(this.args);
      this.onResult(this.last);
      return this.last;
    } finally {
      this.busy = false;
    }
  }

  start(pollMs = 20_000, onError: (e: unknown) => void = () => {}): void {
    if (this.timer) return;
    const run = () => void this.poll().catch(onError);
    this.timer = setInterval(run, pollMs);
    run();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
