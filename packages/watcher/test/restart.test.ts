// Crash and restart at every journal point: the decision, the journaled transaction, the
// broadcast, the terminal record. A new process over the same database finishes the job with
// exactly one freeze and exactly one transaction paid for.
import { describe, expect, it } from 'vitest';
import { SWAP_STATE } from '@xmrswap/protocol';
import type { FaultPoint } from '../src/service.js';
import { Store } from '../src/store.js';
import { WatcherKeys } from '../src/keys.js';
import { Crash, LOCK_TX, crashAt, hex, makeWorld, node, passes } from './world.js';
import path from 'node:path';

const POINTS: FaultPoint[] = ['after-decision', 'after-attempt-journal', 'after-broadcast', 'before-terminal'];

describe.each(['solana', 'ethereum'] as const)('crash and restart on %s', (chain) => {
  it.each(POINTS)('killed %s: the next process freezes the swap, once', async (point) => {
    const w = await makeWorld(chain);
    const store1 = w.store();
    const first = w.service({ store: store1, fault: crashAt(point) });
    const s = await w.addSwap();
    expect((await first.register(s.request())).status).toBe(200);
    await w.postNotice(s.ref, 'no-such-tx');
    w.setTime(w.times.tCut);
    let crashed: unknown = null;
    for (let i = 0; i < 6 && !crashed; i++) {
      await first.tick().catch((e) => (crashed = e));
      w.clock.ms += 1_000;
    }
    expect(crashed).toBeInstanceOf(Crash);
    // What the dead process left behind.
    const left = store1.getWatch(chain, hex(s.ref))!;
    const attempts = store1.attempts(chain, hex(s.ref));
    expect(left.decided_why).toBe('lock-not-confirmed');
    expect(left.terminal_at).toBe(null);
    if (point === 'after-decision') expect(attempts).toEqual([]);
    if (point === 'after-attempt-journal') {
      // Journaled, never handed to the endpoint.
      expect(attempts.map((a) => a.status)).toEqual(['journaled']);
      expect(w.broadcasts).toEqual([]);
      expect(await w.chainState(s.ref)).toBe(SWAP_STATE.NOTICED);
    }
    if (point === 'after-broadcast') expect(attempts.map((a) => a.status)).toEqual(['journaled']);
    store1.close();

    const store2 = w.store();
    const second = w.service({ store: store2 });
    await passes(second, 5, w, 1_000);
    expect(await w.chainState(s.ref)).toBe(SWAP_STATE.FROZEN);
    expect(second.status(hex(s.ref))).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    // One transaction was ever signed and paid for; a rebroadcast is the same bytes.
    const after = store2.attempts(chain, hex(s.ref));
    expect(after.length).toBe(1);
    expect(after[0]!.status).toBe('landed');
    expect(new Set(w.broadcasts.map((b) => b.id))).toEqual(new Set([after[0]!.tx_id]));
    if (point === 'after-attempt-journal') expect(after[0]!.tx_id).toBe(attempts[0]!.tx_id);
    expect(store2.committed(chain, {})).toBe(BigInt(after[0]!.max_fee));
    expect(store2.keyCount(chain, hex(s.ref))).toBe(0);
    // And it stays that way.
    await passes(second, 4, w);
    expect(new Set(w.broadcasts.map((b) => b.id)).size).toBe(1);
    store2.close();
  });

  it('a decision journaled before a crash is not carried out if, after the restart, the step no longer asks for it', async () => {
    const w = await makeWorld(chain);
    // Node b has not seen the lock yet: not confirmed at T_cut.
    const lagging = node('b', 12, []);
    const store1 = w.store();
    const first = w.service({ store: store1, fault: crashAt('after-decision'), nodes: [node('a', 12), lagging] });
    const s = await w.addSwap({ notice: 'good' });
    await first.register(s.request());
    w.setTime(w.times.tCut);
    await expect(first.tick()).rejects.toBeInstanceOf(Crash);
    expect(store1.getWatch(chain, hex(s.ref))).toMatchObject({ status: 'freezing' });
    store1.close();
    // While the process was down the second node caught up: the lock is confirmed on both.
    lagging.add(LOCK_TX);
    const store2 = w.store();
    const second = w.service({ store: store2, nodes: [node('a', 12), lagging] });
    await passes(second, 3, w);
    expect(w.broadcasts).toEqual([]);
    expect(store2.getWatch(chain, hex(s.ref))).toMatchObject({ status: 'watching', phase: 'recheck', decided_why: null });
    store2.close();
  });

  it('a restart with nothing pending changes nothing, and open watches survive it with their keys', async () => {
    const w = await makeWorld(chain);
    const store1 = w.store();
    const first = w.service({ store: store1 });
    const s = await w.addSwap();
    await first.register(s.request());
    await passes(first, 2, w);
    store1.close();
    const store2 = w.store();
    const second = w.service({ store: store2 });
    await w.postNotice(s.ref, 'garbage');
    w.setTime(w.times.tNotice + 1n);
    await passes(second, 3, w);
    expect(second.status(hex(s.ref))).toMatchObject({ status: 'frozen' });
    store2.close();
  });
});

describe('the database', () => {
  it('belongs to one pair of watcher keys and refuses to open for another', async () => {
    const w = await makeWorld('solana');
    w.store().close();
    const other = new WatcherKeys(new Uint8Array(32).fill(7), new Uint8Array(32).fill(8));
    expect(() => new Store(path.join(w.dir, 'watcher.sqlite'), { solana: other.solana, ethereum: other.ethereum })).toThrow(/another watcher key/);
  });

  it('seals the notice key at rest: the file holds neither the key nor anything the swap did not already publish', async () => {
    const w = await makeWorld('ethereum');
    const store = w.store();
    const svc = w.service({ store });
    const s = await w.addSwap({ notice: 'good' });
    await svc.register(s.request());
    await passes(svc, 2, w);
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    const { readFileSync } = await import('node:fs');
    const file = readFileSync(path.join(w.dir, 'watcher.sqlite'));
    expect(file.includes(Buffer.from(s.noticeKey))).toBe(false);
    expect(file.toString('latin1')).not.toContain(hex(s.noticeKey));
    // The row opens only with the keystore, and only for this chain and swap.
    const sealed = store.key('ethereum', hex(s.ref))!.sealed;
    expect(hex(w.keys.openFromStore('ethereum', s.ref, sealed))).toBe(hex(s.noticeKey));
    expect(() => w.keys.openFromStore('solana', s.ref, sealed)).toThrow();
    expect(() => new WatcherKeys(new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)).openFromStore('ethereum', s.ref, sealed)).toThrow();
    // The minimum: no amount, no party, no Monero transaction, no address in any column.
    const cols = ['watches', 'watch_keys', 'attempts'].flatMap((t) => (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    for (const banned of ['amount', 'xmr', 'taker', 'maker', 'txid', 'address', 'view', 'spend']) expect(cols.some((c) => c.includes(banned)), banned).toBe(false);
    expect(file.toString('latin1')).not.toContain(LOCK_TX.txid);
    store.close();
  });
});
