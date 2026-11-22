/**
 * Verify an XMR lock with the joint private view key without trusting any single node
 * (SPEC 2.11), lifted from `tests/monero-regtest/lib/verify.mjs`.
 *
 * Checked locally, where a node cannot lie:
 *   1. the blob the node returned hashes to the txid of the notice (pruned form accepted);
 *   2. exactly one output pays the joint address;
 *   3. the decrypted amount opens the output's Pedersen commitment and is `>= minAmount`;
 *   4. `unlock_time == 0` and the RingCT type is 6;
 *   5. no other output in the lock transaction or in its block carries the same one-time key
 *      (`duplicate-output-key`): two outputs with one key share a key image, only one can ever
 *      be spent.
 * Taken from nodes, so compared across them:
 *   6. every node reports the transaction in the same block (height and hash) and that block
 *      lists it. Confirmations are the minimum over all nodes that answered; a node without
 *      the transaction, or with it only in its mempool, counts as 0. `double_spend_seen` blocks.
 *
 * Fail closed: any disagreement or unreachable node means "not confirmed". Keep polling until
 * the sweep itself is confirmed; confirmations can go down.
 */
import { SdkError } from '../util.js';
import { type BlockInfo, type MoneroNode, asNode } from './rpc.js';
import { type ParsedTx, type ScannedOutput, computeTxid, parseTx, scanTx } from './tx.js';

export type LockState = 'not-found' | 'invalid' | 'pending' | 'confirming' | 'confirmed';

/** Stable codes for `reasons`; each reason string starts with its code and a colon. */
export type LockReasonCode =
  | 'node-failed'
  | 'too-few-nodes'
  | 'txid-mismatch'
  | 'unlock-time'
  | 'rct-type'
  | 'commitment-mismatch'
  | 'no-output'
  | 'amount-too-small'
  | 'multiple-outputs'
  | 'duplicate-output-key'
  | 'double-spend'
  | 'block-missing-tx'
  | 'node-disagreement'
  | 'not-mined-everywhere';

export interface NodeReport {
  url: string;
  error?: string;
  height?: number;
  topHash?: string;
  found?: boolean;
  inPool?: boolean;
  doubleSpendSeen?: boolean;
  computedTxid?: string;
  blockHeight?: number;
  blockHash?: string;
  blockListsTx?: boolean;
  confirmations?: number;
}

export interface VerifyLockArgs {
  /** Daemon URLs or `MoneroNode`s: two or more independently operated nodes, or exactly one the user declares to be their own. */
  nodes: (string | MoneroNode)[];
  /** The user declared the single node to be their own. */
  ownNode?: boolean;
  /** Lock transaction id from the notice, hex. */
  txid: string;
  /** Joint private view key `v_maker + v_taker`, hex. */
  viewPriv: string;
  /** Joint public spend key `S_maker + S_taker`, hex. */
  spendPub: string;
  /** Piconero the swap requires. */
  minAmount: bigint;
  /** Required confirmations (the swap's depth). */
  minConf: number;
  /** How many nodes must answer; defaults to (and may not be less than) the list length. */
  minNodes?: number;
}

export interface VerifyLockResult {
  /** True only for `confirmed` with no reason at all. */
  ok: boolean;
  state: LockState;
  reasons: string[];
  /** The codes of `reasons`, in order. */
  codes: LockReasonCode[];
  /** Decrypted amount paid to the joint address, piconero. */
  amount: bigint;
  /** Minimum over every node that answered. */
  confirmations: number;
  /** Index of the verified output inside the lock transaction: what the sweep spends. */
  outputIndex: number | undefined;
  /** Height of the block that holds the lock (when the nodes agree on it). */
  blockHeight: number | undefined;
  outputs: ScannedOutput[];
  nodes: NodeReport[];
}

interface NodeAnswer extends NodeReport {
  tx?: ParsedTx;
  blockOutputKeys?: BlockOutputKey[];
}
export interface BlockOutputKey {
  txid: string;
  index: number;
  key: string;
}

/** One-time output keys of every transaction in `blk` except `txid`, miner transaction included. */
export async function blockOutputKeys(node: MoneroNode, blk: BlockInfo, txid: string): Promise<BlockOutputKey[]> {
  const keys: BlockOutputKey[] = [];
  const others = (blk.tx_hashes ?? []).filter((h) => h !== txid);
  for (const e of others.length ? await node.txs(others) : []) {
    let t: ParsedTx;
    try {
      t = parseTx((e.as_hex || e.pruned_as_hex)!);
    } catch {
      continue; // e.g. v1 transactions
    }
    t.outputs.forEach((o, index) => keys.push({ txid: e.tx_hash, index, key: o.key }));
  }
  try {
    const vout = JSON.parse(blk.json ?? '').miner_tx.vout as { target?: { key?: string; tagged_key?: { key?: string } } }[];
    vout.forEach((o, index) => {
      const key = o.target?.tagged_key?.key ?? o.target?.key;
      if (key) keys.push({ txid: blk.miner_tx_hash ?? 'miner', index, key });
    });
  } catch {
    // A node that withholds the json only weakens its own answer.
  }
  return keys;
}

/** Outputs carrying `key` other than output `own` of `tx`: in the lock transaction and in its block. */
export function duplicateOutputs(tx: ParsedTx, own: number, key: string, blockKeys: BlockOutputKey[] = []): string[] {
  return [
    ...tx.outputs.map((o, index) => ({ index, key: o.key })).filter((o) => o.index !== own && o.key === key).map((o) => `same transaction, output ${o.index}`),
    ...blockKeys.filter((o) => o.key === key).map((o) => `${o.txid}:${o.index}`),
  ];
}

async function queryNode(node: MoneroNode, txid: string): Promise<NodeAnswer> {
  const [info, e] = await Promise.all([node.info(), node.tx(txid)]);
  const out: NodeAnswer = { url: node.url, height: info.height, topHash: info.top_block_hash, found: !!e };
  if (!e) return out;
  const blob = e.as_hex || e.pruned_as_hex;
  if (!blob) throw new Error('the node returned a transaction entry without a blob');
  const tx = parseTx(blob);
  out.tx = tx;
  out.computedTxid = computeTxid(tx, e.as_hex ? undefined : e.prunable_hash);
  out.inPool = !!e.in_pool;
  out.doubleSpendSeen = !!e.double_spend_seen;
  if (!out.inPool) {
    if (typeof e.block_height !== 'number') throw new Error('the node reports a mined transaction without a block height');
    out.blockHeight = e.block_height;
    const blk = await node.block(e.block_height);
    out.blockHash = blk.block_header.hash;
    out.blockListsTx = (blk.tx_hashes ?? []).includes(txid);
    out.confirmations = info.height - e.block_height; // a transaction in the top block has 1 confirmation
    out.blockOutputKeys = await blockOutputKeys(node, blk, txid);
  } else out.confirmations = 0;
  return out;
}

/** The node policy of SPEC 2.11: two or more nodes, or exactly one the user declares to be their own. */
export function checkNodePolicy(count: number, ownNode: boolean | undefined): void {
  if (count === 0) throw new SdkError('NodePolicy', 'no Monero node is configured');
  if (count === 1 && !ownNode) throw new SdkError('NodePolicy', 'a single node is accepted only when the user declares it to be their own');
}

export async function verifyLock(a: VerifyLockArgs): Promise<VerifyLockResult> {
  checkNodePolicy(a.nodes.length, a.ownNode);
  const minNodes = a.minNodes ?? a.nodes.length;
  if (minNodes < a.nodes.length) throw new SdkError('NodePolicy', 'minNodes is the list length: every configured node must answer');
  const txid = a.txid.toLowerCase();
  const nodes = a.nodes.map(asNode);
  const settled = await Promise.allSettled(nodes.map((n) => queryNode(n, txid)));
  const results: NodeAnswer[] = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { url: nodes[i]!.url, error: String((s.reason as Error)?.message ?? s.reason) }));
  const reasons: string[] = [];
  const codes: LockReasonCode[] = [];
  const add = (code: LockReasonCode, text: string) => {
    codes.push(code);
    reasons.push(`${code}: ${text}`);
  };
  const answered = results.filter((r) => !r.error);
  const withTx = answered.filter((r) => r.found);
  const base = { amount: 0n, confirmations: 0, outputIndex: undefined as number | undefined, blockHeight: undefined as number | undefined, outputs: [] as ScannedOutput[] };
  const done = (state: LockState, extra: Partial<typeof base> = {}): VerifyLockResult => ({
    ok: state === 'confirmed' && reasons.length === 0,
    state,
    reasons,
    codes,
    ...base,
    ...extra,
    nodes: results.map(({ tx: _tx, blockOutputKeys: _keys, ...r }) => r),
  });

  for (const r of results) if (r.error) add('node-failed', `node ${r.url} failed: ${r.error}`);
  if (answered.length < minNodes) add('too-few-nodes', `only ${answered.length}/${minNodes} nodes answered`);
  if (withTx.length === 0) return done('not-found');

  // 1. Every returned blob must hash to the txid. A node serving anything else is lying.
  for (const r of withTx) {
    if (r.computedTxid !== txid) {
      add('txid-mismatch', `node ${r.url} returned a blob hashing to ${r.computedTxid}`);
      return done('invalid');
    }
  }
  // All blobs now have the same prefix and RingCT base, so decode once.
  const tx = withTx[0]!.tx!;

  // 4. Static policy on the transaction itself.
  if (tx.unlockTime !== 0n) add('unlock-time', `unlock_time is ${tx.unlockTime}, must be 0 (the funds would be time-locked)`);
  if (tx.rctType !== 6) add('rct-type', `unexpected RingCT type ${tx.rctType} (want 6, Bulletproofs+)`);

  // 2, 3. View-key scan: which outputs pay the joint address, and how much.
  const outputs = scanTx(tx, a.viewPriv, a.spendPub);
  const good = outputs.filter((o) => o.commitmentOk);
  if (outputs.length !== good.length) add('commitment-mismatch', 'an output to the joint address has an amount that does not open its commitment');
  const amount = good.reduce((sum, o) => sum + o.amount, 0n);
  if (good.length === 0) add('no-output', 'no output of this transaction pays the joint address');
  else if (amount < a.minAmount) add('amount-too-small', `pays ${amount} piconero, need ${a.minAmount}`);
  if (good.length > 1) add('multiple-outputs', `${good.length} outputs to the joint address; exactly 1 is expected`);
  // 5. The lock's one-time key must be unique in its transaction and in its block.
  if (good.length === 1) {
    const dups = [...new Set(withTx.flatMap((r) => duplicateOutputs(tx, good[0]!.index, good[0]!.key, r.blockOutputKeys)))];
    if (dups.length) add('duplicate-output-key', `the lock's one-time key also appears in ${dups.join(', ')}`);
  }
  const extra = { amount, outputs: good, outputIndex: good.length === 1 ? good[0]!.index : undefined };
  const nodeOnly: LockReasonCode[] = ['node-failed', 'too-few-nodes'];
  if (codes.some((c) => !nodeOnly.includes(c))) return done('invalid', extra);

  // 6. Inclusion and depth: agreement between nodes.
  if (withTx.some((r) => r.doubleSpendSeen)) add('double-spend', 'a node flags a double spend of this transaction');
  const mined = withTx.filter((r) => !r.inPool);
  if (mined.some((r) => !r.blockListsTx)) add('block-missing-tx', 'a node reports a block that does not list the transaction');
  const blocks = new Set(mined.map((r) => `${r.blockHeight}:${r.blockHash}`));
  if (blocks.size > 1) add('node-disagreement', 'nodes disagree on the block containing the transaction (fork or lying node)');
  if (mined.length && mined.length < Math.max(minNodes, answered.length)) add('not-mined-everywhere', `the transaction is mined on only ${mined.length}/${answered.length} answering nodes`);
  if (mined.length === 0) return done('pending', { ...extra, confirmations: 0 });
  // Depth is the worst case over every node that answered: absent or mempool counts as 0.
  const confirmations = Math.min(...answered.map((r) => (r.found ? (r.confirmations ?? 0) : 0)));
  const blockHeight = blocks.size === 1 ? mined[0]!.blockHeight : undefined;
  const blocking = reasons.length > 0;
  return done(!blocking && confirmations >= a.minConf ? 'confirmed' : 'confirming', { ...extra, confirmations, blockHeight });
}

// ------------------------------------------------------------------ local checks on recorded blobs

export type LocalLockError = 'txid-mismatch' | 'no-output' | 'amount-too-small' | 'output-not-found' | 'duplicate-output-key' | 'unlock-time' | 'rct-type' | 'commitment-mismatch' | 'multiple-outputs';

export interface LocalLockCheck {
  error: LocalLockError | null;
  computedTxid: string;
  unlockTime: bigint;
  rctType: number;
  outputCount: number;
  /** Outputs to the joint address whose amount opens its commitment. */
  outputs: ScannedOutput[];
  outputIndex: number | undefined;
  amount: bigint;
  fee: bigint;
}

/**
 * Checks 1 to 4 on one blob, with no node involved: what `verifyLock` establishes before it
 * compares nodes. `prunableHash` goes with a pruned blob.
 */
export function checkLockTx(a: { txid: string; blob: string; prunableHash?: string; viewPriv: string; spendPub: string; minAmount: bigint }): LocalLockCheck {
  const tx = parseTx(a.blob);
  const computedTxid = computeTxid(tx, a.prunableHash);
  const scanned = scanTx(tx, a.viewPriv, a.spendPub);
  const outputs = scanned.filter((o) => o.commitmentOk);
  const amount = outputs.reduce((sum, o) => sum + o.amount, 0n);
  let error: LocalLockError | null = null;
  if (computedTxid !== a.txid.toLowerCase()) error = 'txid-mismatch';
  else if (tx.unlockTime !== 0n) error = 'unlock-time';
  else if (tx.rctType !== 6) error = 'rct-type';
  else if (scanned.length !== outputs.length) error = 'commitment-mismatch';
  else if (outputs.length === 0) error = 'no-output';
  else if (outputs.length > 1) error = 'multiple-outputs';
  else if (amount < a.minAmount) error = 'amount-too-small';
  return { error, computedTxid, unlockTime: tx.unlockTime, rctType: tx.rctType, outputCount: tx.outputs.length, outputs, outputIndex: outputs.length === 1 ? outputs[0]!.index : undefined, amount, fee: tx.fee };
}

export interface JointOutput {
  txid: string;
  index: number;
  amount: bigint;
  key: string;
}

/**
 * Which output of a block the sweep may spend: exactly the one named by `lockTxid` and
 * `lockOutputIndex`, provided it pays the joint address at least `minAmount` and no other
 * output in the block carries its one-time key. Every other output to the joint address (dust
 * anyone can send) is reported in `ignored` and never spent automatically.
 */
export function selectLockOutput(a: { txs: { txid: string; blob: string }[]; lockTxid: string; lockOutputIndex: number; viewPriv: string; spendPub: string; minAmount: bigint }):
  | { error: null; outputsToJoint: JointOutput[]; selected: JointOutput; ignored: { output: string; amount: bigint }[]; duplicates: string[] }
  | { error: 'output-not-found' | 'amount-too-small' | 'duplicate-output-key'; outputsToJoint: JointOutput[]; duplicates: string[] } {
  const parsed = a.txs.map((t) => ({ txid: t.txid, tx: parseTx(t.blob) }));
  const outputsToJoint: JointOutput[] = parsed.flatMap(({ txid, tx }) => scanTx(tx, a.viewPriv, a.spendPub).filter((o) => o.commitmentOk).map((o) => ({ txid, index: o.index, amount: o.amount, key: o.key })));
  const selected = outputsToJoint.find((o) => o.txid === a.lockTxid && o.index === a.lockOutputIndex);
  if (!selected) return { error: 'output-not-found', outputsToJoint, duplicates: [] };
  const lock = parsed.find((p) => p.txid === a.lockTxid)!;
  const blockKeys: BlockOutputKey[] = parsed.filter((p) => p.txid !== a.lockTxid).flatMap(({ txid, tx }) => tx.outputs.map((o, index) => ({ txid, index, key: o.key })));
  const duplicates = duplicateOutputs(lock.tx, selected.index, selected.key, blockKeys);
  if (duplicates.length) return { error: 'duplicate-output-key', outputsToJoint, duplicates };
  if (selected.amount < a.minAmount) return { error: 'amount-too-small', outputsToJoint, duplicates };
  const ignored = outputsToJoint.filter((o) => o !== selected).map((o) => ({ output: `${o.txid}:${o.index}`, amount: o.amount }));
  return { error: null, outputsToJoint, selected, ignored, duplicates };
}
