// Inventory splitter: the ladder, coin control by freezing, capacity in unlocked outputs, and locks that are built before they are relayed.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { Inventory, planSplit, rungOf, rungTarget } from '../src/inventory/index.js';
import { Store } from '../src/store/db.js';
import { Journal } from '../src/store/journal.js';
import { FakeMonero, XMR } from './sim.js';

beforeAll(async () => {
  await init();
});
const LADDER = [{ sizeXmr: 5n * XMR, count: 3 }, { sizeXmr: 50n * XMR, count: 1 }];
const setup = (ladder = LADDER) => {
  const store = new Store(':memory:');
  const xmr = new FakeMonero();
  const inv = new Inventory({ store, wallet: xmr, broadcaster: xmr, journal: new Journal(store), ladder: () => ladder, headroomPct: () => 1, reserveXmr: () => 0n });
  return { store, xmr, inv };
};
const out = (key: string, xmrAmount: number, o: { unlocked?: boolean; reserved?: string } = {}) => ({ key_image: key, amount: BigInt(Math.round(xmrAmount * 1e6)) * 1_000_000n, unlocked: o.unlocked === false ? 0 : 1, reserved_for: o.reserved ?? null, spent: 0 }) as never;

describe('ladder planning', () => {
  it('sizes a ladder output slightly above its offer size and recognises what fills a rung', () => {
    expect(rungTarget(5n * XMR, 1)).toBe(5_050_000_000_000n);
    expect(rungOf(5_050_000_000_000n, LADDER, 1)).toBe(0);
    expect(rungOf(5n * XMR, LADDER, 1)).toBe(-1); // exactly the offer size cannot pay the fee
    expect(rungOf(11n * XMR, LADDER, 1)).toBe(-1); // more than twice the target: loose, worth splitting
    expect(rungOf(50_500_000_000_000n, LADDER, 1)).toBe(1);
    expect(rungOf(3n * XMR, LADDER, 1)).toBe(-1); // change
  });
  it('fills each rung\'s deficit from loose unlocked outputs, largest rung first, at most 15 outputs per transaction', () => {
    const plan = planSplit([out('big', 120), out('have', 5.05), out('change', 3, { unlocked: false }), out('held', 30, { reserved: 'swap' })], LADDER, 1, XMR / 1000n);
    expect(plan).toEqual([{ inputs: ['big'], amounts: [50_500_000_000_000n, 5_050_000_000_000n, 5_050_000_000_000n] }]);
    // Nothing to do when the ladder is full; locked change and reserved outputs are never sources.
    expect(planSplit([out('a', 5.05), out('b', 5.05), out('c', 5.05), out('d', 50.5), out('x', 40)], LADDER, 1, 0n)).toEqual([]);
    expect(planSplit([out('change', 30, { unlocked: false })], LADDER, 1, 0n)).toEqual([]);
    const many = planSplit([out('big', 200)], [{ sizeXmr: XMR, count: 40 }], 1, XMR / 1000n);
    expect(many).toHaveLength(1);
    expect(many[0]!.amounts).toHaveLength(15);
    // Two sources, two transactions: change is locked for 10 blocks, so a source is never shared.
    const two = planSplit([out('s1', 12), out('s2', 11)], [{ sizeXmr: 5n * XMR, count: 3 }], 1, XMR / 1000n);
    expect(two.map((b) => b.inputs)).toEqual([['s1'], ['s2']]);
  });
});

describe('inventory', () => {
  it('freezes every output, reports capacity in unlocked outputs (never balance), and keeps the reserve back', async () => {
    const { xmr, inv, store } = setup();
    xmr.addOutput(5_050_000_000_000n);
    xmr.addOutput(5_050_000_000_000n);
    xmr.addOutput(50n * XMR, { unlocked: false });
    await inv.sync();
    expect(xmr.outs.every((o) => o.frozen)).toBe(true);
    expect(inv.capacity()).toEqual({ total: 10_100_000_000_000n, largest: 5_049_000_000_000n, outputs: 2 });
    expect(inv.view(0n)).toMatchObject({ xmr: { balance: '60100000000000', unlocked: '10100000000000' }, capacity_xmr: '10100000000000', ladder: [{ size_xmr: '5000000000000', target_count: 3, unlocked_count: 2, locked_count: 0 }, { size_xmr: '50000000000000', target_count: 1, unlocked_count: 0, locked_count: 0 }] });
    const reserved = new Inventory({ store, wallet: xmr, broadcaster: xmr, journal: new Journal(store), ladder: () => LADDER, headroomPct: () => 1, reserveXmr: () => 8n * XMR });
    expect(reserved.capacity().total).toBe(2_100_000_000_000n);
  });

  it('builds a lock from exactly one output, stores it unrelayed, and reserves that output', async () => {
    const { xmr, inv, store } = setup();
    const small = xmr.addOutput(5_050_000_000_000n);
    const big = xmr.addOutput(50_500_000_000_000n);
    await inv.sync();
    const lock = await inv.prepareLock('swap-1', 'joint-address', 2n * XMR);
    expect(lock).not.toBe('unavailable');
    if (lock === 'unavailable') return;
    // The smallest output that covers it; everything is frozen again afterwards; nothing was relayed.
    expect(lock.key_images).toEqual([small]);
    expect(xmr.outs.every((o) => o.frozen)).toBe(true);
    expect(xmr.relays).toEqual([]);
    expect(store.output(small)!.reserved_for).toBe('swap-1');
    expect(store.output(big)!.reserved_for).toBeNull();
    expect(inv.capacity().outputs).toBe(1);
    // Idempotent per swap: the same stored transaction, never a second one.
    expect(await inv.prepareLock('swap-1', 'joint-address', 2n * XMR)).toMatchObject({ txid: lock.txid });
    expect(xmr.txs.size).toBe(1);
    expect(() => store.insertLockTx({ swap_ref: 'swap-1', tx_hex: 'x', txid: 'y', key_images: [], amount: '1' })).toThrow();
    // A second swap gets the other output; a third finds nothing.
    expect(await inv.prepareLock('swap-2', 'joint-2', 2n * XMR)).toMatchObject({ key_images: [big] });
    expect(await inv.prepareLock('swap-3', 'joint-3', 2n * XMR)).toBe('unavailable');

    // Relay: the stored bytes. A repeat finds the transaction known and does not create another.
    expect(await inv.relayLock('swap-1', () => xmr.txKnown(lock.txid))).toBe('relayed');
    expect(await inv.relayLock('swap-1', () => xmr.txKnown(lock.txid), true)).toBe('relayed');
    expect(xmr.relays).toEqual([lock.txid]);
    expect(store.lockTx('swap-1')).toMatchObject({ relayed_at: expect.any(Number), last_rebroadcast: expect.any(Number) });
    // A swap that ends before its lock is relayed gives the output back; a relayed one does not.
    inv.release('swap-2');
    expect(store.lockTx('swap-2')).toBeUndefined();
    expect(store.output(big)!.reserved_for).toBeNull();
    inv.release('swap-1');
    expect(store.lockTx('swap-1')).toBeDefined();
  });

  it('reports a double spend of the lock\'s input instead of relaying', async () => {
    const { xmr, inv } = setup();
    const k = xmr.addOutput(5_050_000_000_000n);
    await inv.sync();
    const lock = await inv.prepareLock('swap-1', 'joint', XMR);
    if (lock === 'unavailable') throw new Error('unavailable');
    // Something else spends the same output first.
    await xmr.thaw(k);
    const other = await xmr.prepare([{ address: 'elsewhere', amount: XMR }]);
    await xmr.sendRaw(other.txHex);
    expect(await inv.relayLock('swap-1', () => xmr.txKnown(lock.txid))).toBe('double-spend');
    expect(await inv.inputsSpentElsewhere('swap-1')).toBe(true);
    expect(xmr.relays).toEqual([other.txid]);
  });

  it('pre-splits to the ladder and re-splits change and recovered outputs', async () => {
    const { xmr, inv, store } = setup();
    xmr.addOutput(120n * XMR);
    await inv.sync();
    const first = await inv.split();
    expect(first).toMatchObject({ created: 4 });
    expect(xmr.relaysOf('wallet')).toHaveLength(1);
    xmr.mine(10);
    await inv.sync();
    expect(inv.view(0n).ladder).toEqual([{ size_xmr: '5000000000000', target_count: 3, unlocked_count: 3, locked_count: 0 }, { size_xmr: '50000000000000', target_count: 1, unlocked_count: 1, locked_count: 0 }]);
    expect(store.intents({ kind: 'xmr_split' })).toHaveLength(1);
    // A swap spends one 5 XMR output; later a recovered sweep (not ladder-sized) arrives: it is split back.
    const lock = await inv.prepareLock('swap-1', 'joint', 2n * XMR);
    if (lock === 'unavailable') throw new Error('unavailable');
    await inv.relayLock('swap-1', () => xmr.txKnown(lock.txid));
    xmr.addOutput(11n * XMR);
    await inv.sync();
    const again = await inv.split();
    expect(again).toMatchObject({ created: 1 });
    xmr.mine(10);
    await inv.sync();
    expect(inv.view(0n).ladder[0]).toMatchObject({ unlocked_count: 3 });
    expect((await inv.split()).created).toBe(0);
  });

  it('a plain payment (the rebalancer\'s sendXmr) spends loose outputs first and is journalled', async () => {
    const { xmr, inv, store } = setup();
    xmr.addOutput(5_050_000_000_000n);
    const loose = xmr.addOutput(3n * XMR);
    await inv.sync();
    const txid = await inv.send('venue-deposit-address', 2n * XMR);
    expect(xmr.txs.get(txid)).toMatchObject({ inputs: [loose], relayed: 1 });
    expect(store.intents({ kind: 'xmr_send' })[0]).toMatchObject({ status: 'confirmed', tx: txid });
    await expect(inv.send('venue-deposit-address', 100n * XMR)).rejects.toThrow(/not enough/);
  });
});
