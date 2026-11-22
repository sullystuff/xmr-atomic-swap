// Monero integration (M2): the node policy against the two real regtest daemons. The complete
// lock, verify and sweep paths run inside the Solana and Ethereum scenario files.
import { beforeAll, describe, expect, it } from 'vitest';
import { init, jointAddress } from '@xmrswap/core-wasm';
import { makerShareKeys } from '../../src/flows/keys.js';
import { daemonNode } from '../../src/monero/rpc.js';
import { verifyLock } from '../../src/monero/verify.js';
import { LockWatcher, findDeposits } from '../../src/monero/watch.js';
import { hex } from '../../src/util.js';
import * as xmr from './xmr.js';

beforeAll(async () => {
  await init();
  await xmr.funded();
});

describe('two real nodes', () => {
  it('both answer, agree on the tip, and are a private regtest', async () => {
    await xmr.synced();
    const [a, b] = await Promise.all(xmr.NODES.map((u) => daemonNode(u).info()));
    expect(a!.nettype).toBe('fakechain');
    expect(a!.height).toBe(b!.height);
    expect(a!.top_block_hash).toBe(b!.top_block_hash);
  });

  it('a lock is pending, then confirming, then confirmed on both; one unreachable node means "not confirmed"', async () => {
    const m = makerShareKeys(new Uint8Array(32).fill(1), 'solana', new Uint8Array(16).fill(1));
    const t = makerShareKeys(new Uint8Array(32).fill(2), 'solana', new Uint8Array(16).fill(2));
    const joint = jointAddress(m.spendPub, t.spendPub, m.view, t.view, 'regtest');
    const keys = { viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub) };
    const amount = 5n * xmr.XMR / 10n;
    const fromHeight = await xmr.chainHeight();
    const txid = await xmr.pay(joint.address, amount);

    const seen: string[] = [];
    const watcher = new LockWatcher({ nodes: xmr.NODES, txid, ...keys, minAmount: amount, minConf: 3 }, (r) => seen.push(`${r.state}:${r.confirmations}`));
    await xmr.verifyUntil(txid, keys, amount, 3, 'pending');
    await watcher.poll();
    for (let i = 1; i <= 3; i++) {
      await xmr.settle(1);
      await xmr.verifyUntil(txid, keys, amount, 3, i < 3 ? 'confirming' : 'confirmed');
      await watcher.poll();
    }
    expect(seen).toEqual(['pending:0', 'confirming:1', 'confirming:2', 'confirmed:3']);
    expect(watcher.last).toMatchObject({ ok: true, amount, outputIndex: expect.any(Number) });

    // The view-key scan finds the same payment without being told the txid.
    const found = await findDeposits({ node: xmr.NODE_B, ...keys, fromHeight });
    expect(found.found).toEqual([{ txid, inPool: false, blockHeight: watcher.last!.blockHeight, amount }]);

    // A node that does not answer (nothing listens on that loopback port): fail closed, however deep the lock is.
    const dead = 'http://127.0.0.1:9';
    const withDead = await verifyLock({ nodes: [xmr.NODE_A, dead], txid, ...keys, minAmount: amount, minConf: 1 });
    expect(withDead.ok).toBe(false);
    expect(withDead.state).toBe('confirming');
    expect(withDead.codes).toEqual(expect.arrayContaining(['node-failed', 'too-few-nodes']));
    // One node alone is accepted only when the user declares it their own.
    await expect(verifyLock({ nodes: [xmr.NODE_A], txid, ...keys, minAmount: amount, minConf: 1 })).rejects.toMatchObject({ code: 'NodePolicy' });
    expect(await verifyLock({ nodes: [xmr.NODE_A], ownNode: true, txid, ...keys, minAmount: amount, minConf: 1 })).toMatchObject({ ok: true, state: 'confirmed' });
    // The restricted RPC of node B (what a public node offers) is enough for verification.
    const restricted = process.env.XMR_DAEMON_URL_B_RESTRICTED ?? 'http://127.0.0.1:48086';
    expect(await verifyLock({ nodes: [xmr.NODE_A, restricted], txid, ...keys, minAmount: amount, minConf: 3 })).toMatchObject({ ok: true, state: 'confirmed' });
    // Asking for more than was paid, or scanning with one view share, is invalid on real nodes too.
    expect(await verifyLock({ nodes: xmr.NODES, txid, ...keys, minAmount: amount + 1n, minConf: 1 })).toMatchObject({ ok: false, state: 'invalid', codes: ['amount-too-small'] });
    expect(await verifyLock({ nodes: xmr.NODES, txid, viewPriv: hex(m.view), spendPub: keys.spendPub, minAmount: amount, minConf: 1 })).toMatchObject({ ok: false, state: 'invalid', codes: ['no-output'] });
    // An unknown transaction.
    expect(await verifyLock({ nodes: xmr.NODES, txid: 'ab'.repeat(32), ...keys, minAmount: amount, minConf: 1 })).toMatchObject({ ok: false, state: 'not-found' });
  });
});
