/**
 * The daemon's Monero node set (SPEC 2.11 node policy): two or more independently operated
 * nodes, or exactly one the maker declares its own. Verification fails closed on disagreement
 * or an unreachable node. The first node is the most trusted one: sweeps are built against it.
 */
import { type Network, type SweepOutcome, sweepJoint } from '@xmrswap/core-wasm';
import type { MoneroNodeStatus } from '@xmrswap/protocol/daemon-api';
import { type MoneroNode, type VerifyLockResult, asNode, verifyLock } from '@xmrswap/sdk';
import type { Bytes } from '../util.js';

export interface SweepRequest {
  spendKey: Bytes;
  viewKey: Bytes;
  lockHeight: number;
  lockTxid: Bytes;
  outputIndex: bigint;
  destination: string;
  maxFee: bigint;
}

/** What the executor asks of Monero. */
export interface MoneroView {
  readonly network: Network;
  /** `verifyLock` against every configured node. */
  verify(a: { txid: string; viewPriv: string; spendPub: string; minAmount: bigint; minConf: number }): Promise<VerifyLockResult>;
  /** Build and sign the sweep of a joint address WITHOUT publishing it. */
  buildSweep(p: SweepRequest): Promise<SweepOutcome>;
  /** Whether any node knows the transaction (pool or chain). */
  txKnown(txid: string): Promise<boolean>;
  status(): Promise<{ nodes: MoneroNodeStatus[]; agree: boolean }>;
}

export class MoneroNodes implements MoneroView {
  private readonly nodes: MoneroNode[];
  private lastTop = new Map<string, { height: number; hash: string }>();
  /** Called when a node's tip moved backwards or changed hash at the same height. */
  onReorg: () => void = () => {};

  constructor(
    nodes: (string | MoneroNode)[],
    readonly network: Network,
    private readonly opts: { ownNode?: boolean; sweepUrl?: string; labels?: string[] } = {},
  ) {
    this.nodes = nodes.map(asNode);
  }

  verify(a: { txid: string; viewPriv: string; spendPub: string; minAmount: bigint; minConf: number }): Promise<VerifyLockResult> {
    return verifyLock({ nodes: this.nodes, ...a, ...(this.opts.ownNode ? { ownNode: true } : {}) });
  }
  buildSweep(p: SweepRequest): Promise<SweepOutcome> {
    const daemonUrl = this.opts.sweepUrl ?? this.nodes[0]?.url;
    if (!daemonUrl) throw new Error('no Monero node configured');
    return sweepJoint({ daemonUrl, network: this.network, ...p, publish: false });
  }
  async txKnown(txid: string): Promise<boolean> {
    for (const n of this.nodes) {
      try {
        if ((await n.tx(txid)) !== null) return true;
      } catch {
        // an unreachable node knows nothing
      }
    }
    return false;
  }
  async status(): Promise<{ nodes: MoneroNodeStatus[]; agree: boolean }> {
    const out: MoneroNodeStatus[] = [];
    for (const [i, n] of this.nodes.entries()) {
      const label = this.opts.labels?.[i] ?? `node ${i}`;
      try {
        const info = await n.info();
        const prev = this.lastTop.get(n.url);
        if (prev && (info.height < prev.height || (info.height === prev.height && info.top_block_hash !== prev.hash))) this.onReorg();
        this.lastTop.set(n.url, { height: info.height, hash: info.top_block_hash });
        out.push({ label, ok: true, height: info.height, top_hash: info.top_block_hash });
      } catch {
        out.push({ label, ok: false, height: null, top_hash: null });
      }
    }
    const up = out.filter((s) => s.ok);
    // Nodes one block apart are still in agreement; a different hash at the same height is not.
    const agree = up.length === out.length && up.length > 0 && up.every((s) => Math.abs(s.height! - up[0]!.height!) <= 1 && (s.height !== up[0]!.height || s.top_hash === up[0]!.top_hash));
    return { nodes: out, agree };
  }
}
