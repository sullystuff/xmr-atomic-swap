// Monero lock verification in TypeScript against the recorded regtest transactions of
// monero_tx.json, and the multi-node agreement rules over fake nodes built from the same
// recordings: every disagreement, missing answer or duplicate key fails closed.
import { describe, expect, it } from 'vitest';
import { daemonNode, type FetchLike } from '../src/monero/rpc.js';
import { computeTxid, encodeVarint, formatXmr, parseTx, scanTx } from '../src/monero/tx.js';
import { type VerifyLockArgs, checkLockTx, checkNodePolicy, selectLockOutput, verifyLock } from '../src/monero/verify.js';
import { LockWatcher, findDeposits, lockReport } from '../src/monero/watch.js';
import { FakeMoneroNode, type FakeTx } from '../src/testing/monero.js';
import { codeOf } from '../src/util.js';
import { vector } from './helpers.js';

const v = vector('monero_tx');
const byName = (name: string) => v.cases.find((c: any) => c.name === name);
const lock = byName('lock');
const dust = byName('dust-in-the-lock-block');
const dup = byName('duplicate-output-key');
const VIEW = v.keys.joint.view_priv as string;
const SPEND = v.keys.joint.spend_pub as string;

describe('monero_tx.json: local checks', () => {
  it('finds, decrypts and commitment-checks the lock output of each recorded transaction', () => {
    let n = 0;
    for (const c of v.cases.filter((c: any) => c.valid && c.input.tx_hex)) {
      const i = c.input;
      const o = c.output;
      for (const [blob, prunableHash] of [[i.tx_hex, undefined], [i.pruned_hex, i.prunable_hash]] as const) {
        const got = checkLockTx({ txid: i.txid, blob, ...(prunableHash ? { prunableHash } : {}), viewPriv: i.view_priv, spendPub: i.spend_pub, minAmount: BigInt(i.min_amount) });
        expect(got.error, c.name).toBe(null);
        expect(got.computedTxid, c.name).toBe(o.computed_txid);
        expect(got.unlockTime, c.name).toBe(BigInt(o.unlock_time));
        expect(got.rctType, c.name).toBe(o.rct_type);
        expect(got.outputCount, c.name).toBe(o.output_count);
        expect(got.outputIndex, c.name).toBe(o.output_index);
        expect(got.amount, c.name).toBe(BigInt(o.amount));
        expect(got.fee, c.name).toBe(BigInt(o.fee));
        expect(got.outputs.map((x) => ({ index: x.index, amount: x.amount.toString(), key: x.key, commitment_ok: x.commitmentOk })), c.name).toEqual(o.outputs);
      }
      n++;
    }
    expect(n).toBe(2);
  });

  it('reports the recorded failures', () => {
    let n = 0;
    for (const c of v.cases.filter((c: any) => !c.valid && c.input.tx_hex)) {
      const i = c.input;
      const got = checkLockTx({ txid: i.txid, blob: i.tx_hex, viewPriv: i.view_priv, spendPub: i.spend_pub, minAmount: BigInt(i.min_amount) });
      expect(got.error, c.name).toBe(c.error);
      n++;
    }
    expect(n).toBe(4);
    // A single view share is not the view key; one spend half is not the spend key.
    expect(scanTx(parseTx(lock.input.tx_hex), v.keys.maker.view, SPEND)).toEqual([]);
    expect(scanTx(parseTx(lock.input.tx_hex), VIEW, v.keys.taker.spend_pub)).toEqual([]);
  });

  it('selects exactly the named output of a block and ignores dust to the joint address', () => {
    const blocks = v.cases.filter((c: any) => c.input.txs);
    expect(blocks.length).toBe(4);
    for (const c of blocks) {
      const i = c.input;
      const got = selectLockOutput({ txs: i.txs.map((t: any) => ({ txid: t.txid, blob: t.tx_hex })), lockTxid: i.lock_txid, lockOutputIndex: i.lock_output_index, viewPriv: i.view_priv, spendPub: i.spend_pub, minAmount: BigInt(i.min_amount) });
      expect(got.error, c.name).toBe(c.valid ? null : c.error);
      if (got.error !== null) continue;
      const o = c.output;
      expect(got.outputsToJoint.map((x) => ({ ...x, amount: x.amount.toString() }))).toEqual(o.outputs_to_joint);
      expect({ ...got.selected, amount: got.selected.amount.toString(), key: undefined }).toMatchObject(o.selected);
      expect(got.ignored.map((x) => ({ output: x.output, amount: x.amount.toString() }))).toEqual(o.ignored);
      expect(got.duplicates).toEqual(o.duplicates);
    }
    // The pruned blobs scan identically (outputs live in the prefix and RingCT base).
    const i = dust.input;
    const pruned = selectLockOutput({ txs: i.txs.map((t: any) => ({ txid: t.txid, blob: t.pruned_hex })), lockTxid: i.lock_txid, lockOutputIndex: i.lock_output_index, viewPriv: i.view_priv, spendPub: i.spend_pub, minAmount: BigInt(i.min_amount) });
    expect(pruned.error).toBe(null);
  });

  it('recomputes the txid from a full blob, a pruned blob with its hash, and refuses a pruned blob without one', () => {
    const tx = parseTx(lock.input.tx_hex);
    expect(computeTxid(tx)).toBe(lock.input.txid);
    const pruned = parseTx(lock.input.pruned_hex);
    expect(computeTxid(pruned, lock.input.prunable_hash)).toBe(lock.input.txid);
    expect(() => computeTxid(pruned)).toThrow(/prunable/);
    // A wrong prunable hash changes the txid: a pruned node cannot substitute signatures either.
    expect(computeTxid(pruned, '00'.repeat(32))).not.toBe(lock.input.txid);
    expect(tx.inputs.every((x) => x.type === 'key' && x.keyImage!.length === 64)).toBe(true);
    expect(() => parseTx('01' + lock.input.tx_hex.slice(2))).toThrow(/version/);
    expect(() => parseTx(lock.input.tx_hex.slice(0, 200))).toThrow(/truncated/);
    expect(() => scanTx(tx, '00'.repeat(32), SPEND)).toThrow(/view key/);
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02]);
    expect(formatXmr(2_000_000_000_000n)).toBe('2');
    expect(formatXmr(1_500_000_000_001n)).toBe('1.500000000001');
  });
});

// ------------------------------------------------------------------ multi-node agreement

const HEIGHT = 162;
const lockTx: FakeTx = { txid: dust.input.txs[0].txid, hex: dust.input.txs[0].tx_hex, prunedHex: dust.input.txs[0].pruned_hex, prunableHash: dust.input.txs[0].prunable_hash, blockHeight: HEIGHT };
const dustTxs: FakeTx[] = dust.input.txs.slice(1).map((t: any) => ({ txid: t.txid, hex: t.tx_hex, prunedHex: t.pruned_hex, prunableHash: t.prunable_hash, blockHeight: HEIGHT }));
const synthetic = dup.input.txs[3];
const dupTx: FakeTx = { txid: synthetic.txid, hex: synthetic.tx_hex, prunedHex: synthetic.pruned_hex, prunableHash: synthetic.prunable_hash, blockHeight: HEIGHT };

/** A node that has the lock mined at HEIGHT with `conf` confirmations. */
const node = (name: string, conf: number, txs: FakeTx[] = [lockTx]) => new FakeMoneroNode(name, HEIGHT + conf, txs);
const args = (nodes: FakeMoneroNode[], over: Partial<VerifyLockArgs> = {}): VerifyLockArgs => ({ nodes, txid: lockTx.txid, viewPriv: VIEW, spendPub: SPEND, minAmount: 3_000_000_000_000n, minConf: 10, ...over });

describe('verifyLock: node policy', () => {
  it('needs two or more nodes, or exactly one the user declares to be their own', async () => {
    await expect(verifyLock(args([]))).rejects.toMatchObject({ code: 'NodePolicy' });
    await expect(verifyLock(args([node('a', 12)]))).rejects.toMatchObject({ code: 'NodePolicy' });
    const own = await verifyLock(args([node('a', 12)], { ownNode: true }));
    expect(own).toMatchObject({ ok: true, state: 'confirmed', confirmations: 12 });
    // minNodes is the list length: asking for less is refused, not honoured.
    await expect(verifyLock(args([node('a', 12), node('b', 12)], { minNodes: 1 }))).rejects.toMatchObject({ code: 'NodePolicy' });
    expect(codeOf(() => checkNodePolicy(2, false))).toBe(null);
  });
});

describe('verifyLock: agreement between nodes', () => {
  it('confirms when every node agrees, and returns the output the sweep must spend', async () => {
    const r = await verifyLock(args([node('a', 12), node('b', 12)]));
    expect(r).toMatchObject({ ok: true, state: 'confirmed', reasons: [], codes: [], amount: 3_000_000_000_000n, confirmations: 12, outputIndex: dust.input.lock_output_index, blockHeight: HEIGHT });
    expect(r.outputs.length).toBe(1);
    expect(r.nodes.map((n) => [n.url, n.found, n.confirmations, n.blockListsTx])).toEqual([['a', true, 12, true], ['b', true, 12, true]]);
    expect(lockReport(r)).toEqual({ state: 'confirmed', ok: true, confirmations: 12 });
  });

  it('takes depth as the minimum over the nodes', async () => {
    const r = await verifyLock(args([node('a', 25), node('b', 9)]));
    expect(r).toMatchObject({ ok: false, state: 'confirming', confirmations: 9, reasons: [] });
    expect((await verifyLock(args([node('a', 25), node('b', 10)]))).state).toBe('confirmed');
    expect((await verifyLock(args([node('a', 25), node('b', 10)], { minConf: 11 }))).state).toBe('confirming');
  });

  it('accepts a pruned node next to a full one', async () => {
    const b = node('b', 12);
    b.pruned = true;
    const r = await verifyLock(args([node('a', 12), b]));
    expect(r).toMatchObject({ ok: true, state: 'confirmed' });
    expect(r.nodes[1]!.computedTxid).toBe(lockTx.txid);
  });

  it('fails closed when the nodes disagree on the block (a fork or a lying node)', async () => {
    const b = node('b', 30);
    b.blockHashes.set(HEIGHT, 'ff'.repeat(32));
    const r = await verifyLock(args([node('a', 30), b]));
    expect(r.ok).toBe(false);
    expect(r.state).toBe('confirming');
    expect(r.codes).toEqual(['node-disagreement']);
    expect(r.blockHeight).toBeUndefined();
    // The same transaction at different heights is the same disagreement.
    const c = new FakeMoneroNode('c', HEIGHT + 31, [{ ...lockTx, blockHeight: HEIGHT + 1 }]);
    expect((await verifyLock(args([node('a', 30), c]))).codes).toContain('node-disagreement');
  });

  it('fails closed when a node is unreachable, however deep the others say the lock is', async () => {
    const b = node('b', 500);
    b.down = true;
    const r = await verifyLock(args([node('a', 500), b]));
    expect(r.ok).toBe(false);
    expect(r.state).toBe('confirming');
    expect(r.codes).toEqual(['node-failed', 'too-few-nodes', 'not-mined-everywhere']);
    expect(r.reasons[0]).toMatch(/^node-failed: node b failed: connection refused/);
    expect(r.nodes[1]).toEqual({ url: 'b', error: 'connection refused' });
    // Every node down: nothing is known.
    const a = node('a', 500);
    a.down = true;
    expect(await verifyLock(args([a, b]))).toMatchObject({ ok: false, state: 'not-found' });
  });

  it('counts a node without the transaction, or with it only in its mempool, as zero confirmations', async () => {
    const without = new FakeMoneroNode('b', HEIGHT + 40, []);
    const r = await verifyLock(args([node('a', 40), without]));
    expect(r).toMatchObject({ ok: false, state: 'confirming', confirmations: 0 });
    expect(r.codes).toEqual(['not-mined-everywhere']);
    const pool = new FakeMoneroNode('b', HEIGHT + 40, [{ ...lockTx, blockHeight: null }]);
    const r2 = await verifyLock(args([node('a', 40), pool]));
    expect(r2).toMatchObject({ ok: false, state: 'confirming', confirmations: 0 });
    // In every mempool, in no block: pending.
    const r3 = await verifyLock(args([new FakeMoneroNode('a', HEIGHT, [{ ...lockTx, blockHeight: null }]), pool]));
    expect(r3).toMatchObject({ ok: false, state: 'pending', confirmations: 0, amount: 3_000_000_000_000n, outputIndex: 0 });
    // Known to nobody.
    expect(await verifyLock(args([new FakeMoneroNode('a', HEIGHT, []), without]))).toMatchObject({ ok: false, state: 'not-found' });
  });

  it('blocks on a double-spend flag and on a block that does not list the transaction', async () => {
    const flagged = new FakeMoneroNode('b', HEIGHT + 12, [{ ...lockTx, doubleSpendSeen: true }]);
    const r = await verifyLock(args([node('a', 12), flagged]));
    expect(r).toMatchObject({ ok: false, state: 'confirming' });
    expect(r.codes).toEqual(['double-spend']);
    const hiding = node('b', 12);
    hiding.hideTxList = true;
    expect((await verifyLock(args([node('a', 12), hiding]))).codes).toEqual(['block-missing-tx']);
  });

  it('a node serving another blob under the txid is lying: invalid', async () => {
    const liar = new FakeMoneroNode('b', HEIGHT + 12, [{ ...lockTx, hex: dustTxs[0]!.hex }]);
    const r = await verifyLock(args([node('a', 12), liar]));
    expect(r).toMatchObject({ ok: false, state: 'invalid' });
    expect(r.codes).toEqual(['txid-mismatch']);
    // The recorded tampered blob (last byte changed) is caught the same way.
    const t = byName('blob-does-not-hash-to-txid').input;
    const tampered = [new FakeMoneroNode('a', 200, [{ txid: t.txid, hex: t.tx_hex, blockHeight: 160 }]), new FakeMoneroNode('b', 200, [{ txid: t.txid, hex: t.tx_hex, blockHeight: 160 }])];
    expect((await verifyLock({ nodes: tampered, txid: t.txid, viewPriv: t.view_priv, spendPub: t.spend_pub, minAmount: BigInt(t.min_amount), minConf: 2 })).codes).toEqual(['txid-mismatch']);
  });

  it('invalid: too little, the wrong keys, or a dust payment named as the lock', async () => {
    expect(await verifyLock(args([node('a', 12), node('b', 12)], { minAmount: 3_000_000_000_001n }))).toMatchObject({ ok: false, state: 'invalid', codes: ['amount-too-small'], amount: 3_000_000_000_000n });
    expect(await verifyLock(args([node('a', 12), node('b', 12)], { viewPriv: v.keys.maker.view }))).toMatchObject({ ok: false, state: 'invalid', codes: ['no-output'], outputIndex: undefined });
    const all = [lockTx, ...dustTxs];
    const named = await verifyLock(args([node('a', 12, all), node('b', 12, all)], { txid: dustTxs[0]!.txid }));
    expect(named).toMatchObject({ ok: false, state: 'invalid', codes: ['amount-too-small'], amount: 1_000_000_000n });
  });

  it('dust to the joint address in the lock\'s block does not disturb the verification', async () => {
    const all = [lockTx, ...dustTxs];
    const r = await verifyLock(args([node('a', 12, all), node('b', 12, all)]));
    expect(r).toMatchObject({ ok: true, state: 'confirmed', outputIndex: 0, amount: 3_000_000_000_000n });
  });

  it('duplicate output key: a second output with the lock\'s one-time key makes the lock invalid', async () => {
    const all = [lockTx, ...dustTxs, dupTx];
    const r = await verifyLock(args([node('a', 12, all), node('b', 12, all)]));
    expect(r.ok).toBe(false);
    expect(r.state).toBe('invalid');
    expect(r.codes).toEqual(['duplicate-output-key']);
    expect(r.reasons[0]).toContain(`${dupTx.txid}:0`);
    // One node showing the duplicate is enough: the other may simply be hiding it.
    const oneSided = await verifyLock(args([node('a', 12, all), node('b', 12, [lockTx, ...dustTxs])]));
    expect(oneSided).toMatchObject({ ok: false, state: 'invalid', codes: ['duplicate-output-key'] });
    // The same key on a miner-transaction output of the block counts too.
    const lockKey = dust.output.selected ? dust.output.outputs_to_joint[0].key : '';
    const miner = node('b', 12);
    miner.minerKeys.set(HEIGHT, [lockKey]);
    const viaMiner = await verifyLock(args([node('a', 12), miner]));
    expect(viaMiner).toMatchObject({ ok: false, state: 'invalid', codes: ['duplicate-output-key'] });
    expect(viaMiner.reasons[0]).toContain(`miner${HEIGHT}:0`);
  });

  it('confirmations can go down: a reorg is seen on the next poll', async () => {
    const a = node('a', 12);
    const b = node('b', 12);
    const results: string[] = [];
    const w = new LockWatcher(args([a, b]), (r) => results.push(`${r.state}:${r.confirmations}`));
    await w.poll();
    // Both nodes drop the lock back into the mempool (a 2-block reorg replaced its block).
    for (const n of [a, b]) n.txsById.set(lockTx.txid, { ...lockTx, blockHeight: null });
    await w.poll();
    // It is mined again one block later, one confirmation deep.
    for (const n of [a, b]) {
      n.txsById.set(lockTx.txid, { ...lockTx, blockHeight: HEIGHT + 12 });
      n.height = HEIGHT + 13;
    }
    await w.poll();
    expect(results).toEqual(['confirmed:12', 'pending:0', 'confirming:1']);
    expect(lockReport(w.last!)).toEqual({ state: 'confirming', ok: false, confirmations: 1 });
  });
});

describe('finding a deposit without a txid (direction B)', () => {
  it('scans the mempool and recent blocks with the view key', async () => {
    const n = node('a', 3, [lockTx, ...dustTxs]);
    n.add({ ...lockTx, txid: lock.input.txid, hex: lock.input.tx_hex, prunedHex: lock.input.pruned_hex, prunableHash: lock.input.prunable_hash, blockHeight: null });
    const got = await findDeposits({ node: n, viewPriv: VIEW, spendPub: SPEND, fromHeight: HEIGHT - 2 });
    expect(got.tipHeight).toBe(HEIGHT + 3);
    expect(got.scannedTxs).toBe(4);
    const amounts = Object.fromEntries(got.found.map((f) => [f.txid, [f.amount, f.inPool, f.blockHeight]]));
    expect(amounts[lockTx.txid]).toEqual([3_000_000_000_000n, false, HEIGHT]);
    expect(amounts[lock.input.txid]).toEqual([2_000_000_000_000n, true, null]);
    expect(got.found.length).toBe(4);
    // With another key nothing is found.
    expect((await findDeposits({ node: n, viewPriv: v.keys.maker.view, spendPub: SPEND, fromHeight: 0 })).found).toEqual([]);
  });
});

describe('daemonNode over an injected fetch', () => {
  it('speaks the monerod routes the relay proxy allows and surfaces errors', async () => {
    const seen: [string, any][] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push([url, body]);
      if (url.endsWith('/json_rpc') && body.method === 'get_info') return { ok: true, status: 200, json: async () => ({ result: { height: 170, top_block_hash: 'ab' } }) };
      if (url.endsWith('/json_rpc') && body.method === 'get_block') return { ok: true, status: 200, json: async () => ({ error: { code: -2, message: 'height too big' } }) };
      if (url.endsWith('/get_transactions')) return { ok: true, status: 200, json: async () => ({ status: 'OK', txs: body.txs_hashes.map((h: string) => ({ tx_hash: h, as_hex: 'aa' })) }) };
      if (url.endsWith('/get_transaction_pool_hashes')) return { ok: true, status: 200, json: async () => ({ status: 'BUSY' }) };
      return { ok: false, status: 502, json: async () => ({}) };
    };
    const n = daemonNode('http://node.invalid:18081/', { fetchFn });
    expect(n.url).toBe('http://node.invalid:18081');
    expect((await n.info()).height).toBe(170);
    expect((await n.tx('ff'))?.tx_hash).toBe('ff');
    // 250 hashes go out in chunks of 100, pruned.
    expect((await n.txs(Array.from({ length: 250 }, (_, i) => `h${i}`))).length).toBe(250);
    const chunks = seen.filter(([u, b]) => u.endsWith('/get_transactions') && b.prune === true).map(([, b]) => b.txs_hashes.length);
    expect(chunks).toEqual([100, 100, 50]);
    await expect(n.block(999)).rejects.toMatchObject({ name: 'MoneroRpcError', code: -2 });
    await expect(n.poolHashes()).rejects.toThrow(/BUSY/);
    expect(seen.every(([u]) => u.startsWith('http://node.invalid:18081/'))).toBe(true);
  });
});
