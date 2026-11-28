// The loop: for each watched swap, read the chain, run the SDK's `watcherStep`, and send
// `freeze` when and only when it says so. Both chains, on the SDK fakes; `verifyLock` runs for
// real against in-memory Monero nodes that serve a recorded lock.
import { afterEach, describe, expect, it } from 'vitest';
import { SWAP_STATE } from '@xmrswap/protocol';
import type { Watcher } from '../src/service.js';
import { LOCK_HEIGHT, type World, hex, makeWorld, node, passes } from './world.js';

const CHAINS = ['solana', 'ethereum'] as const;
const worlds: World[] = [];
afterEach(() => {
  // Whatever a test did, nothing but a freeze was ever simulated, signed or broadcast.
  for (const w of worlds.splice(0)) for (const t of w.signedOrSimulated()) expect(t.calls.filter((c) => c !== 'compute-budget')).toEqual(['freeze']);
});
async function world(chain: (typeof CHAINS)[number]): Promise<World> {
  const w = await makeWorld(chain);
  worlds.push(w);
  return w;
}
async function watch(w: World, svc: Watcher, spec: Parameters<World['addSwap']>[0] = {}) {
  const s = await w.addSwap(spec);
  const r = await svc.register(s.request());
  expect(r.status).toBe(200);
  return s;
}
const row = (w: World, svc: Watcher, ref: Uint8Array) => svc.status(hex(ref)) as { status: string; reason: string | null; waiting_for: string | null; freeze_decided: { why: string } | null; freeze_transactions: { id: string; status: string }[] };

describe.each(CHAINS)('the loop on %s', (chain) => {
  it('waits for a notice, then for T_cut; a lock that is missing at T_cut is frozen then and not a second earlier', async () => {
    const w = await world(chain);
    const svc = w.service();
    const s = await watch(w, svc);
    await passes(svc, 2, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'watching', waiting_for: 'notice' });
    await w.postNotice(s.ref, 'no-such-tx');
    w.setTime(w.times.tCut - 1n);
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'watching', waiting_for: 'lock-check', freeze_decided: null });
    expect(w.broadcasts).toEqual([]);
    w.setTime(w.times.tCut);
    await svc.tick();
    expect(w.broadcasts.map((b) => b.calls.filter((c) => c !== 'compute-budget'))).toEqual([['freeze']]);
    expect(await w.chainState(s.ref)).toBe(SWAP_STATE.FROZEN);
    // The freeze landed before T_co − M.
    expect((await s.view()).tFreeze <= w.times.tCo - w.times.margin).toBe(true);
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed', waiting_for: null });
    expect(row(w, svc, s.ref).freeze_transactions).toEqual([{ id: w.broadcasts[0]!.id, status: 'landed' }]);
    // Exactly one freeze, however long the loop keeps running.
    await passes(svc, 5, w);
    expect(w.broadcasts.length).toBe(1);
  });

  it('a notice that does not open its commitment is "no lock": frozen at once, before T_cut', async () => {
    const w = await world(chain);
    const svc = w.service();
    const s = await watch(w, svc);
    await w.postNotice(s.ref, 'garbage');
    w.setTime(w.times.tNotice + 5n);
    await svc.tick();
    expect(w.broadcasts.length).toBe(1);
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: notice-invalid' });
  });

  it('an honest lock, confirmed on both nodes, is never frozen: the watch ends "not needed" when the window closes', async () => {
    const w = await world(chain);
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'good' });
    for (const t of [w.times.tNotice + 1n, w.times.tCut - 1n, w.times.tCut, w.times.tCut + 100n, w.times.tCo - w.times.margin]) {
      w.setTime(t);
      await passes(svc, 2, w);
      expect(w.broadcasts).toEqual([]);
    }
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'watching', waiting_for: 'recheck', freeze_decided: null });
    w.setTime(w.times.tCo - w.times.margin + 1n);
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'not_needed', reason: 'the lock stayed confirmed through the freeze window' });
    expect(await w.chainState(s.ref)).toBe(SWAP_STATE.NOTICED);
    expect(w.broadcasts).toEqual([]);
  });

  it('the locker returns and sets ready, or the swap ends: the watch ends "not needed" and nothing is sent', async () => {
    const w = await world(chain);
    const svc = w.service();
    const a = await watch(w, svc, { notice: 'good' });
    const b = await watch(w, svc, { notice: 'no-such-tx' });
    const c = await watch(w, svc);
    w.setState(a.ref, SWAP_STATE.READY);
    w.setState(b.ref, SWAP_STATE.DONE);
    w.setState(c.ref, SWAP_STATE.FROZEN);
    w.setTime(w.times.tCut + 1n);
    await passes(svc, 3, w);
    expect(row(w, svc, a.ref)).toMatchObject({ status: 'not_needed', reason: 'the locker set ready' });
    expect(row(w, svc, b.ref)).toMatchObject({ status: 'not_needed', reason: 'the swap ended' });
    expect(row(w, svc, c.ref)).toMatchObject({ status: 'not_needed', reason: 'frozen by the locker' });
    expect(w.broadcasts).toEqual([]);
  });

  it('two Monero nodes that disagree, or one that is down, count as "not confirmed": nothing before T_cut, a freeze at T_cut', async () => {
    for (const breakIt of ['hash', 'missing', 'down', 'shallow'] as const) {
      const w = await world(chain);
      const b = breakIt === 'missing' ? node('b', 12, []) : breakIt === 'shallow' ? node('b', 3) : node('b', 12);
      if (breakIt === 'hash') b.blockHashes.set(LOCK_HEIGHT, 'ff'.repeat(32));
      if (breakIt === 'down') b.down = true;
      const svc = w.service({ nodes: [node('a', 12), b] });
      const s = await watch(w, svc, { notice: 'good' });
      w.setTime(w.times.tCut - 1n);
      await passes(svc, 2, w);
      expect(w.broadcasts, breakIt).toEqual([]);
      expect(row(w, svc, s.ref)).toMatchObject({ status: 'watching', waiting_for: 'lock-check' });
      w.setTime(w.times.tCut);
      await passes(svc, 3, w);
      expect(w.broadcasts.length, breakIt).toBe(1);
      expect(row(w, svc, s.ref), breakIt).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    }
  });

  it('a lock that loses its confirmations after T_cut (the nodes come to disagree) is frozen while the window is open', async () => {
    const w = await world(chain);
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'good' });
    w.setTime(w.times.tCut + 10n);
    await passes(svc, 2, w);
    expect(row(w, svc, s.ref)).toMatchObject({ waiting_for: 'recheck' });
    w.nodes[1]!.blockHashes.set(LOCK_HEIGHT, 'ee'.repeat(32));
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'frozen' });
    expect(w.broadcasts.length).toBe(1);
  });

  it('one own node satisfies the node policy only when declared; a single foreign node is refused before anything is read', async () => {
    const w = await world(chain);
    const own = w.service({ nodes: [node('a', 12)], ownNode: true });
    const s = await watch(w, own, { notice: 'good' });
    w.setTime(w.times.tCut);
    await passes(own, 2, w);
    expect(row(w, own, s.ref)).toMatchObject({ status: 'watching', waiting_for: 'recheck' });
    const w2 = await world(chain);
    const single = w2.service({ nodes: [node('a', 12)] });
    const s2 = await watch(w2, single, { notice: 'good' });
    w2.setTime(w2.times.tCut);
    await passes(single, 2, w2);
    // The policy error is an error, not a verdict: nothing is frozen on a misconfiguration alone.
    expect(w2.broadcasts).toEqual([]);
    expect((w2.store().getWatch(chain, hex(s2.ref)))!.last_error).toBe('NodePolicy');
  });

  it('a broadcast that fails is retried with growing backoff while the window is open, and lands once', async () => {
    const w = await world(chain);
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    w.net.broadcastFails = true;
    await svc.tick();
    const store = w.store();
    const first = store.getWatch(chain, hex(s.ref))!;
    expect(first).toMatchObject({ status: 'freezing', errors: 1, decided_why: 'lock-not-confirmed' });
    expect(first.next_at).toBe(w.clock.ms + 2_000);
    // Within the backoff nothing is tried.
    await svc.tick();
    expect(store.getWatch(chain, hex(s.ref))!.errors).toBe(1);
    w.clock.ms += 2_001;
    await svc.tick();
    const second = store.getWatch(chain, hex(s.ref))!;
    expect(second.errors).toBe(2);
    expect(second.next_at).toBe(w.clock.ms + 4_000);
    expect(row(w, svc, s.ref).freeze_transactions).toEqual([]);
    w.net.broadcastFails = false;
    w.clock.ms += 4_001;
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'frozen' });
    // The journaled transaction was rebroadcast byte for byte: one transaction, one freeze.
    expect(new Set(w.broadcasts.map((b) => b.id)).size).toBe(1);
    expect(store.attempts(chain, hex(s.ref)).filter((a) => a.status === 'landed').length).toBe(1);
    store.close();
  });

  it('the window is missed, with the reason on record, when the endpoint is unreachable until T_co − M has passed', async () => {
    const w = await world(chain);
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    w.net.broadcastFails = true;
    await passes(svc, 3, w);
    w.setTime(w.times.tCo + w.times.margin + 1n);
    w.net.broadcastFails = false;
    await passes(svc, 4, w);
    const r = row(w, svc, s.ref);
    expect(r.status).toBe('window_missed');
    expect(r.reason).toMatch(/^a freeze was due \(lock-not-confirmed\) and did not land before T_co − M: /);
    expect(await w.chainState(s.ref)).toBe(SWAP_STATE.NOTICED);
    // A swap the watcher was never able to judge is recorded as missed too, never as "not needed".
    const w2 = await world(chain);
    const svc2 = w2.service();
    const s2 = await watch(w2, svc2, { notice: 'no-such-tx' });
    w2.net.readsFail = true;
    await passes(svc2, 3, w2);
    w2.net.readsFail = false;
    w2.setTime(w2.times.tCo - w2.times.margin + 1n);
    await passes(svc2, 3, w2);
    expect(row(w2, svc2, s2.ref)).toMatchObject({ status: 'window_missed' });
    expect(row(w2, svc2, s2.ref).reason).toMatch(/^the swap could not be judged before T_co − M/);
    expect(w2.broadcasts).toEqual([]);
  });

  it('spend limits: a freeze dearer than the per-swap limit, or past the per-day limit, is not sent', async () => {
    const w = await world(chain);
    const reserve = w.port.freezeReserve();
    // On Ethereum, a base fee at which a freeze is priced at the operator's maximum.
    w.net.baseFee = 49_500_000_000n;
    // Per day: room for one freeze, not two.
    const store = w.store();
    const svc = w.service({ store, settings: { limits: { [chain]: { perSwap: reserve, perDay: reserve + 1n } } } });
    const a = await watch(w, svc, { notice: 'garbage' });
    const b = await watch(w, svc, { notice: 'garbage' });
    w.setTime(w.times.tNotice + 5n);
    await passes(svc, 3, w);
    expect(w.broadcasts.length).toBe(1);
    expect(row(w, svc, a.ref)).toMatchObject({ status: 'frozen' });
    expect(store.getWatch(chain, hex(b.ref))).toMatchObject({ status: 'freezing', last_error: 'per-day-limit' });
    // The next day the budget is new, and the window is still open.
    w.clock.ms += 86_400_000;
    await passes(svc, 3, w);
    expect(row(w, svc, b.ref)).toMatchObject({ status: 'frozen' });
    expect(w.broadcasts.length).toBe(2);
    store.close();

    const w2 = await world(chain);
    const store2 = w2.store();
    // Registration itself refuses a watch the per-swap limit cannot pay for.
    const tight = w2.service({ store: store2, settings: { limits: { [chain]: { perSwap: 1n, perDay: 10n ** 30n } } } });
    const s = await w2.addSwap({ notice: 'garbage' });
    const refused = await tight.register(s.request());
    expect(refused).toMatchObject({ status: 503, body: { error: 'insufficient_fee_balance' } });
    // A limit lowered after the watch was accepted stops the send, and says so.
    const loose = w2.service({ store: store2 });
    expect((await loose.register(s.request())).status).toBe(200);
    w2.setTime(w2.times.tNotice + 5n);
    await passes(tight, 3, w2);
    expect(w2.broadcasts).toEqual([]);
    expect(store2.getWatch(chain, hex(s.ref))).toMatchObject({ status: 'freezing', last_error: 'per-swap-limit' });
    store2.close();
  });

  it('a watch\'s notice key is deleted when the swap is terminal; the record stays for the retention period and is then purged', async () => {
    const w = await world(chain);
    const store = w.store();
    const svc = w.service({ store, settings: { retentionDays: 2 } });
    const s = await watch(w, svc, { notice: 'garbage' });
    expect(store.keyCount(chain, hex(s.ref))).toBe(1);
    w.setTime(w.times.tNotice + 5n);
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'frozen' });
    expect(store.keyCount(chain, hex(s.ref))).toBe(0);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM watch_keys').get() as { n: number }).n).toBe(0);
    w.clock.ms += 86_400_000;
    await svc.tick();
    expect(svc.status(hex(s.ref))).not.toBe(null);
    w.clock.ms += 86_400_000 + 1;
    await svc.tick();
    expect(svc.status(hex(s.ref))).toBe(null);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(0);
    store.close();
  });

  it('the maker-side watch (direction B): the taker\'s false notice is frozen for the maker; an honest payment is not', async () => {
    const w = await world(chain);
    const svc = w.service();
    const bad = await watch(w, svc, { direction: 1 });
    const good = await watch(w, svc, { direction: 1, notice: 'good' });
    await w.postNotice(bad.ref, 'no-such-tx');
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    expect(row(w, svc, bad.ref)).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    expect(row(w, svc, good.ref)).toMatchObject({ status: 'watching', waiting_for: 'recheck' });
    expect(w.broadcasts.map((b) => b.swapRef)).toHaveLength(1);
  });
});

describe('Ethereum fees', () => {
  it('a network fee above the operator\'s maximum is never signed; the watch records why it missed', async () => {
    const w = await world('ethereum');
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.net.baseFee = 200_000_000_000n; // above the 100 gwei maximum
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    expect(w.broadcasts).toEqual([]);
    expect(w.store().getWatch('ethereum', hex(s.ref))).toMatchObject({ status: 'freezing', last_error: 'FeeAboveLimit' });
    w.setTime(w.times.tCo - w.times.margin + 1n);
    await passes(svc, 3, w);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'window_missed', reason: 'a freeze was due (lock-not-confirmed) and did not land before T_co − M: FeeAboveLimit' });
  });

  it('a pending freeze is replaced at the same nonce with a higher fee, so at most one is ever mined', async () => {
    const w = await world('ethereum');
    const store = w.store();
    const svc = w.service({ store });
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    w.net.lands = false;
    await svc.tick();
    expect(w.broadcasts.length).toBe(1);
    // Inside the attempt timeout nothing new is built.
    w.clock.ms += 60_000;
    await svc.tick();
    expect(w.broadcasts.length).toBe(1);
    w.clock.ms += 100_000;
    await svc.tick();
    const attempts = store.attempts('ethereum', hex(s.ref));
    expect(attempts.length).toBe(2);
    expect(attempts[1]!.nonce).toBe(attempts[0]!.nonce);
    expect(BigInt(attempts[1]!.fee_per_gas!) * 1000n >= BigInt(attempts[0]!.fee_per_gas!) * 1125n).toBe(true);
    // Both count once against the limits: only one can be mined.
    expect(store.committed('ethereum', { swapRef: hex(s.ref) })).toBe(BigInt(attempts[1]!.max_fee));
    w.net.lands = true;
    w.clock.ms += 200_000;
    await passes(svc, 4, w, 200_000);
    expect(row(w, svc, s.ref)).toMatchObject({ status: 'frozen' });
    expect(store.attempts('ethereum', hex(s.ref)).filter((a) => a.status === 'landed').length).toBe(1);
    store.close();
  });

  it('two swaps frozen in one pass take consecutive nonces', async () => {
    const w = await world('ethereum');
    const store = w.store();
    const svc = w.service({ store });
    const a = await watch(w, svc, { notice: 'garbage' });
    const b = await watch(w, svc, { notice: 'garbage' });
    w.net.lands = false;
    w.setTime(w.times.tNotice + 5n);
    await svc.tick();
    const nonces = [a, b].map((s) => store.attempts('ethereum', hex(s.ref))[0]!.nonce);
    expect(nonces).toEqual([0, 1]);
    store.close();
  });
});

describe('Solana expiry', () => {
  it('a transaction not seen is rebroadcast byte for byte while its blockhash lives; only once the chain is past its last valid block height is a fresh one built, and its fee is not counted twice', async () => {
    const w = await world('solana');
    const store = w.store();
    const svc = w.service({ store });
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    w.net.lands = false;
    await svc.tick();
    // Past the attempt timeout, the blockhash still valid: the same bytes again, never a second transaction beside a live one.
    w.clock.ms += 151_000;
    await svc.tick();
    w.advanceBlocks(150);
    w.clock.ms += 151_000;
    await svc.tick();
    expect(store.attempts('solana', hex(s.ref)).map((a) => a.status)).toEqual(['sent']);
    expect(w.broadcasts.length).toBe(3);
    expect(new Set(w.broadcasts.map((b) => b.id)).size).toBe(1);
    // One block later the blockhash is dead (by block height, whatever the wall clock says): a fresh transaction.
    w.advanceBlocks(1);
    await svc.tick();
    const attempts = store.attempts('solana', hex(s.ref));
    expect(attempts.map((a) => a.status)).toEqual(['dropped', 'sent']);
    expect(attempts[1]!.valid_until).toBe(attempts[0]!.valid_until! + 151);
    expect(store.committed('solana', { swapRef: hex(s.ref) })).toBe(BigInt(attempts[1]!.max_fee));
    w.net.lands = true;
    w.clock.ms += 151_000;
    await passes(svc, 4, w, 151_000);
    expect(svc.status(hex(s.ref))).toMatchObject({ status: 'frozen' });
    store.close();
  });

  it('a transaction journaled before a crash whose blockhash has since expired is not rebroadcast: a fresh one is built', async () => {
    const w = await world('solana');
    const store = w.store();
    const { Crash, crashAt } = await import('./world.js');
    const first = w.service({ store, fault: crashAt('after-attempt-journal') });
    const s = await watch(w, first, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    await expect(first.tick()).rejects.toBeInstanceOf(Crash);
    w.advanceBlocks(200);
    const second = w.service({ store });
    await passes(second, 4, w);
    expect(store.attempts('solana', hex(s.ref)).map((a) => a.status)).toEqual(['dropped', 'landed']);
    expect(w.broadcasts.length).toBe(1);
    expect(second.status(hex(s.ref))).toMatchObject({ status: 'frozen' });
    store.close();
  });
});
