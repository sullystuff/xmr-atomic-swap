import type { BlockInfo, MoneroNode, NodeInfo, TxEntry } from '../monero/rpc.js';

export interface FakeTx {
  txid: string;
  /** Full blob, hex. */
  hex: string;
  /** Pruned blob and the hash of the pruned part: what a pruned node serves. */
  prunedHex?: string;
  prunableHash?: string;
  /** `null` = in the mempool. */
  blockHeight: number | null;
  doubleSpendSeen?: boolean;
}

/**
 * A `MoneroNode` over recorded transactions. Each instance is one node's view of the chain, so
 * a test builds two that agree, disagree, lag or fail.
 */
export class FakeMoneroNode implements MoneroNode {
  readonly txsById = new Map<string, FakeTx>();
  /** Block hash per height; defaults to a hash derived from the height. */
  readonly blockHashes = new Map<number, string>();
  /** Extra miner-transaction output keys per height. */
  readonly minerKeys = new Map<number, string[]>();
  /** Chain height (the number of blocks): a transaction in block `height − 1` has 1 confirmation. */
  height: number;
  /** Serve only pruned blobs. */
  pruned = false;
  /** Make every call fail (an unreachable node). */
  down = false;
  /** Hide the block's transaction list (a lying or broken node). */
  hideTxList = false;
  calls = 0;

  constructor(
    readonly url: string,
    height: number,
    txs: FakeTx[] = [],
  ) {
    this.height = height;
    for (const t of txs) this.txsById.set(t.txid, { ...t });
  }

  add(tx: FakeTx): this {
    this.txsById.set(tx.txid, { ...tx });
    return this;
  }
  private check(): void {
    this.calls++;
    if (this.down) throw new Error('connection refused');
  }
  private hashOf(height: number): string {
    return this.blockHashes.get(height) ?? height.toString(16).padStart(64, '0');
  }
  private entry(t: FakeTx, prune: boolean): TxEntry {
    const e: TxEntry = { tx_hash: t.txid, in_pool: t.blockHeight === null, double_spend_seen: !!t.doubleSpendSeen };
    if (prune || this.pruned) {
      if (!t.prunedHex || !t.prunableHash) throw new Error(`fake tx ${t.txid} has no pruned form`);
      e.pruned_as_hex = t.prunedHex;
      e.prunable_hash = t.prunableHash;
    } else e.as_hex = t.hex;
    if (t.blockHeight !== null) e.block_height = t.blockHeight;
    return e;
  }

  async info(): Promise<NodeInfo> {
    this.check();
    return { height: this.height, top_block_hash: this.hashOf(this.height - 1), nettype: 'fakechain', synchronized: true };
  }
  async tx(txid: string): Promise<TxEntry | null> {
    this.check();
    const t = this.txsById.get(txid);
    return t ? this.entry(t, false) : null;
  }
  async txs(txids: string[]): Promise<TxEntry[]> {
    this.check();
    return txids.flatMap((id) => {
      const t = this.txsById.get(id);
      return t ? [this.entry(t, !!t.prunedHex)] : [];
    });
  }
  async block(height: number): Promise<BlockInfo> {
    this.check();
    const tx_hashes = this.hideTxList ? [] : [...this.txsById.values()].filter((t) => t.blockHeight === height).map((t) => t.txid);
    const vout = (this.minerKeys.get(height) ?? []).map((key) => ({ amount: 0, target: { tagged_key: { key, view_tag: '00' } } }));
    return { block_header: { hash: this.hashOf(height), height }, tx_hashes, miner_tx_hash: `miner${height}`, json: JSON.stringify({ miner_tx: { vout } }) };
  }
  async poolHashes(): Promise<string[]> {
    this.check();
    return [...this.txsById.values()].filter((t) => t.blockHeight === null).map((t) => t.txid);
  }
}
