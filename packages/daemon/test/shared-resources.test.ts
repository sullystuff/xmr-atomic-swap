// BUG-4 and BUG-3 (tests/e2e/BUGS.md) and the audit that followed: nothing two swaps can take at once,
// no result journaled as a success the node or chain did not give, and no operator instruction settled
// by a pass that began before it was given.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { SWAP_STATE } from '@xmrswap/protocol';
import { ata, seedSigner } from '@xmrswap/sdk';
import { Refused } from '../src/chains/types.js';
import type { Daemon } from '../src/daemon.js';
import { Inventory } from '../src/inventory/index.js';
import { Store } from '../src/store/db.js';
import { Journal } from '../src/store/journal.js';
import { FakeMonero, XMR } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
const OUT = 5_050_000_000_000n;
const WINDOW = BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\napproval_mode = "window"\ndeposit_pct = 2');
async function live(toml = BASE_TOML, opts: { outputs?: bigint[] } = {}): Promise<{ w: World; d: Daemon }> {
  const w = await makeWorld(toml, opts);
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, 1_000_000_000_000n, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
  const d = await w.boot();
  await d.start();
  return { w, d };
}
const openA = (w: World, xmr = XMR) => w.sim.open({ direction: 0, xmr, depBps: 200, makerSpendPub: w.sim.takePoolKey(0) });
const inventory = () => {
  const store = new Store(':memory:');
  const xmr = new FakeMonero();
  // The wallet spends whatever is unfrozen, as the real one did in BUG-4.
  xmr.greedy = true;
  const inv = new Inventory({ store, wallet: xmr, broadcaster: xmr, journal: new Journal(store), ladder: () => [], headroomPct: () => 1, reserveXmr: () => 0n });
  return { store, xmr, inv };
};

describe('BUG-4: a lock spends exactly the output reserved for it', () => {
  it('an output the daemon has not frozen yet is frozen before the build, so two consecutive locks never share an input', async () => {
    const { xmr, inv, store } = inventory();
    const a = xmr.addOutput(OUT);
    const b = xmr.addOutput(OUT);
    await inv.sync();
    // A swept joint address lands in the wallet and unlocks AFTER the last inventory pass: unfrozen, unknown to the table.
    const stray = xmr.addOutput(3n * XMR);
    const first = await inv.prepareLock('swap-1', 'joint-1', XMR);
    if (first === 'unavailable') throw new Error('unavailable');
    expect(first.key_images).toHaveLength(1);
    expect(xmr.txs.get(first.txid)!.inputs).toEqual(first.key_images);
    expect(xmr.outs.every((o) => o.frozen)).toBe(true); // the stray one too
    expect(store.output(stray)).toBeDefined();
    await inv.relayLock('swap-1', () => xmr.txKnown(first.txid));
    xmr.mine(1);
    const second = await inv.prepareLock('swap-2', 'joint-2', XMR);
    if (second === 'unavailable') throw new Error('unavailable');
    expect(xmr.txs.get(second.txid)!.inputs).toEqual(second.key_images);
    expect(second.key_images.filter((k) => first.key_images.includes(k))).toEqual([]);
    // The node accepts both: no double spend.
    expect(await inv.relayLock('swap-2', () => xmr.txKnown(second.txid))).toBe('relayed');
    expect(new Set([...first.key_images, ...second.key_images]).size).toBe(2);
    expect([a, b, stray]).toEqual(expect.arrayContaining([...first.key_images, ...second.key_images]));
  });

  it('a transaction the wallet built with an input that was not reserved is thrown away, unstored and unrelayed, and built again', async () => {
    const { xmr, inv, store } = inventory();
    xmr.addOutput(OUT);
    await inv.sync();
    // The stray output appears in the instant between the freeze pass and the build.
    let stray = '';
    xmr.beforePrepare = () => (stray = xmr.addOutput(3n * XMR));
    const lock = await inv.prepareLock('swap-1', 'joint-1', XMR);
    if (lock === 'unavailable') throw new Error('unavailable');
    expect(xmr.txs.size).toBe(2); // the first build, with two inputs, was discarded
    const discarded = [...xmr.txs.values()].find((t) => t.txid !== lock.txid)!;
    expect(discarded.inputs).toContain(stray);
    expect(discarded.relayed).toBe(0);
    expect(xmr.txs.get(lock.txid)!.inputs).toEqual(lock.key_images);
    expect(lock.key_images).not.toContain(stray);
    expect(store.lockTx('swap-1')!.txid).toBe(lock.txid);
    // The stray output is frozen now and is nobody's: the next swap can have it.
    expect(xmr.outs.find((o) => o.keyImage === stray)!.frozen).toBe(true);
    expect(store.output(stray)!.reserved_for).toBeNull();
    // A wallet that keeps adding inputs gets nothing built at all.
    const always = inventory();
    always.xmr.addOutput(OUT);
    await always.inv.sync();
    const again = (): void => {
      always.xmr.beforePrepare = () => {
        always.xmr.addOutput(3n * XMR);
        again();
      };
    };
    again();
    await expect(always.inv.prepareLock('swap-1', 'joint-1', XMR)).rejects.toThrow(/keeps adding inputs/);
    expect(always.store.lockTx('swap-1')).toBeUndefined();
    expect(always.store.outputs().filter((o) => o.reserved_for)).toEqual([]);
    expect(always.store.intents({ kind: 'xmr_prepare' }).map((i) => i.status)).toEqual(['failed']);
  });

  it('locks racing for outputs each get their own, or none', async () => {
    const { xmr, inv, store } = inventory();
    xmr.addOutput(OUT);
    xmr.addOutput(OUT);
    await inv.sync();
    const got = await Promise.all(['s1', 's2', 's3', 's1'].map((ref) => inv.prepareLock(ref, `joint-${ref}`, XMR)));
    const locks = got.filter((g): g is Exclude<typeof g, 'unavailable'> => g !== 'unavailable');
    expect(got.filter((g) => g === 'unavailable')).toHaveLength(1);
    // s1 asked twice gets the same stored transaction; the two swaps that got a lock have disjoint inputs.
    expect(new Set(locks.map((l) => l.txid)).size).toBe(2);
    const inputs = [...new Map(locks.map((l) => [l.swap_ref, l.key_images])).values()].flat();
    expect(new Set(inputs).size).toBe(inputs.length);
    for (const l of locks) for (const k of l.key_images) expect(store.output(k)!.reserved_for).toBe(l.swap_ref);
    // Reservations survive a restart of the module on the same database.
    const again = new Inventory({ store, wallet: xmr, broadcaster: xmr, journal: new Journal(store), ladder: () => [], headroomPct: () => 1, reserveXmr: () => 0n });
    expect(await again.prepareLock('s4', 'joint-s4', XMR)).toBe('unavailable');
    expect(again.capacity().outputs).toBe(0);
  });

  it('a relay the node refuses is journaled as refused, never as confirmed; the swap relays later, once', async () => {
    const { w, d } = await live();
    w.xmr.refuseRelay = 'fee too low';
    const s = openA(w);
    const out = (await d.executor.tick()).get(s.pda)!;
    expect(out).toMatchObject({ kind: 'error', error: expect.stringMatching(/refused the transaction: fee too low/) });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.NOTICED);
    expect(d.store.lockTx(s.pda)!.relayed_at).toBeNull();
    expect(d.store.swap(s.pda)!.phase).toBe('notice_posted');
    expect(d.store.intents({ swapRef: s.pda, kind: 'xmr_relay' }).map((i) => i.status)).toEqual(['failed']);
    expect(d.alerts.list().filter((a) => a.kind === 'lock_double_spend')).toEqual([]);
    w.xmr.refuseRelay = null;
    await d.executor.tick();
    expect(d.store.intents({ swapRef: s.pda, kind: 'xmr_relay' }).map((i) => i.status)).toEqual(['failed', 'confirmed']);
    expect(w.xmr.relaysOf('wallet')).toEqual([d.store.lockTx(s.pda)!.txid]);
    expect(w.sim.names(s.pda)).toEqual(['lock', 'post_notice']);
    d.store.close();
  });

  it('never posts a notice for a lock whose input is already spent: it is discarded and built again from another output', async () => {
    const { w, d } = await live();
    w.xmr.greedy = false;
    // Something else spends the output between the build and the notice (a wallet shared with another tool, a restored backup).
    const realPrepare = w.xmr.prepare.bind(w.xmr);
    let stolen = '';
    let first = '';
    w.xmr.prepare = async (dest) => {
      const tx = await realPrepare(dest);
      if (!stolen) {
        first = tx.txid;
        stolen = tx.keyImages[0]!;
        const o = w.xmr.outs.find((x) => x.keyImage === stolen)!;
        o.frozen = false;
        const other = await realPrepare([{ address: 'elsewhere', amount: XMR / 2n }]);
        o.frozen = true;
        await w.xmr.sendRaw(other.txHex);
      }
      return tx;
    };
    const s = openA(w);
    await d.executor.tick();
    const lock = d.store.lockTx(s.pda)!;
    expect(lock.txid).not.toBe(first);
    expect(lock.key_images).not.toContain(stolen);
    // One notice, for the transaction that was relayed; the swap goes on, nothing was aborted.
    expect(w.sim.names(s.pda)).toEqual(['lock', 'post_notice']);
    expect(w.xmr.relaysOf('wallet')).toContain(lock.txid);
    expect(w.xmr.txs.get(first)!.relayed).toBe(0);
    expect(d.alerts.list().map((a) => a.kind)).toContain('lock_rebuilt');
    expect(d.alerts.list().filter((a) => a.kind === 'lock_double_spend')).toEqual([]);
    expect(d.store.output(stolen)!.reserved_for).toMatch(/^unspendable:/);
    d.store.close();

    // The nodes cannot be asked: the notice waits; it is not posted on hope.
    const b = await live();
    const t = openA(b.w);
    const status = b.w.xmr.keyImageStatus.bind(b.w.xmr);
    b.w.xmr.keyImageStatus = async () => {
      throw new Error('connection refused');
    };
    await b.d.executor.tick();
    expect(b.w.sim.names(t.pda)).toEqual(['lock']);
    expect(b.d.store.lockTx(t.pda)).toBeDefined();
    b.w.xmr.keyImageStatus = status;
    await b.d.executor.tick();
    expect(b.w.sim.names(t.pda)).toEqual(['lock', 'post_notice']);
    b.d.store.close();
  });

  it('two swaps through the daemon with a stray output and a greedy wallet: both locks are relayed', async () => {
    const { w, d } = await live();
    w.xmr.greedy = true;
    w.xmr.addOutput(3n * XMR);
    const first = openA(w, XMR / 4n);
    await d.executor.tick();
    w.xmr.mine(1);
    w.xmr.addOutput(3n * XMR);
    const second = openA(w, XMR / 4n);
    await d.executor.tick();
    for (const s of [first, second]) expect(d.store.swap(s.pda)).toMatchObject({ phase: 'xmr_relayed', state: SWAP_STATE.NOTICED });
    const [a, b] = [d.store.lockTx(first.pda)!, d.store.lockTx(second.pda)!];
    expect(a.key_images.filter((k) => b.key_images.includes(k))).toEqual([]);
    expect(w.xmr.relaysOf('wallet').sort()).toEqual([a.txid, b.txid].sort());
    expect(d.alerts.list().filter((x) => x.kind === 'lock_double_spend')).toEqual([]);
    d.store.close();
  });
});

describe('BUG-3: an instruction is settled only by a pass that began after it was journaled', () => {
  /** A swap in HOLD whose lock is being looked for (to sweep): each pass calls `verify`, which the gate holds open. */
  async function held(): Promise<{ w: World; d: Daemon; pda: string; release: () => void }> {
    const { w, d } = await live();
    const s = openA(w);
    await d.executor.tick();
    w.xmr.mine(1);
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    let release = () => {};
    w.xmr.verifyGate = new Promise<void>((r) => (release = r));
    return { w, d, pda: s.pda, release: () => (release(), (w.xmr.verifyGate = null)) };
  }
  const inFlight = async (w: World) => {
    for (let i = 0; i < 200 && w.xmr.verifying === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(w.xmr.verifying).toBeGreaterThan(0);
  };

  it('arriving DURING the daemon\'s own pass: carried out, not refused by that pass', async () => {
    const { w, d, pda, release } = await held();
    const pass = d.executor.tick();
    await inFlight(w);
    // The pass is provably in flight (it waits on a slow node). The operator withholds now.
    const answer = d.executor.manual(pda, { withhold: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(d.store.swap(pda)!.facts.instruction).toBeUndefined(); // not even journaled into the running pass's view
    release();
    await pass;
    const r = await answer;
    expect(r.refused).toBeUndefined();
    expect(r.instruction).toMatchObject({ action: 'withhold', status: 'carried_out' });
    expect(w.sim.swap(pda)!.state).toBe(SWAP_STATE.WITHHELD);
    expect(w.sim.names(pda).filter((n) => n === 'withhold')).toHaveLength(1);
    d.store.close();
  });

  it('arriving before a pass and after one: the same answer', async () => {
    const before = await held();
    before.release();
    expect((await before.d.executor.manual(before.pda, { withhold: true })).instruction).toMatchObject({ status: 'carried_out' });
    before.d.store.close();
    const after = await held();
    after.release();
    await after.d.executor.tick();
    expect((await after.d.executor.manual(after.pda, { withhold: true })).instruction).toMatchObject({ status: 'carried_out' });
    after.d.store.close();
  });

  it('arriving while the pass is itself sending a transaction: neither is lost, neither is sent twice', async () => {
    const { w, d } = await live(WINDOW);
    const s = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    // The pass's own `approve` is held inside the send.
    const realSend = w.sim.fake.send.bind(w.sim.fake);
    let letGo = () => {};
    let sending = false;
    w.sim.fake.send = async (wire) => {
      sending = true;
      await new Promise<void>((r) => (letGo = r));
      return realSend(wire);
    };
    const pass = d.executor.tick();
    for (let i = 0; i < 200 && !sending; i++) await new Promise((r) => setTimeout(r, 5));
    expect(sending).toBe(true);
    const answer = d.executor.manual(s.pda, { abort: true });
    w.sim.fake.send = realSend;
    letGo();
    await pass;
    const r = await answer;
    // The approval landed, the lock was built and announced by the pass in flight; the abort then ran against that fresh state.
    expect(r.instruction).toMatchObject({ action: 'abort', status: 'carried_out' });
    expect(w.sim.names(s.pda).filter((n) => n === 'approve')).toHaveLength(1);
    expect(w.sim.names(s.pda).filter((n) => n === 'abort')).toHaveLength(1);
    d.store.close();
  });

  it('a pass that could not read the chain leaves the instruction pending; only a pass that read it may refuse', async () => {
    const { w, d, pda, release } = await held();
    release();
    const realGet = w.sim.fake.getAccount.bind(w.sim.fake);
    w.sim.fake.getAccount = async () => {
      throw new Error('RPC unreachable');
    };
    const r = await d.executor.manual(pda, { withhold: true });
    expect(r).toMatchObject({ kind: 'error' });
    expect(r.instruction).toMatchObject({ status: 'pending' });
    // Restart with the instruction pending: honoured by the first pass that reads the chain.
    d.store.close();
    w.sim.fake.getAccount = realGet;
    const d2 = await w.boot();
    await d2.start();
    expect(d2.store.swap(pda)!.facts.instruction).toMatchObject({ action: 'withhold', status: 'carried_out' });
    expect(w.sim.names(pda).filter((n) => n === 'withhold')).toHaveLength(1);
    d2.store.close();
  });
});

describe('audit: other shared resources and other success records', () => {
  it('exposure limits count a swap from the moment it is approved, so two pending swaps cannot both take the last of a limit', async () => {
    const { w, d } = await live(WINDOW.replace('[liquidity]', '[liquidity]\nmax_in_flight_xmr = 3'));
    const a = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    const b = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    await d.executor.scan();
    // The first approval is sent and stays unconfirmed (the row still reads PENDING) while the second is decided.
    w.sim.dropSends = 1;
    await Promise.all([d.executor.step(a.pda), d.executor.step(b.pda)]);
    const verdicts = [a, b].map((s) => d.store.swap(s.pda)!.facts.approval!.approve);
    expect(verdicts.sort()).toEqual([false, true]);
    d.store.close();
  });

  it('an approval needs an output of its own: outputs promised to approved swaps without a lock yet are set aside', async () => {
    const { w, d } = await live(WINDOW, { outputs: [OUT] });
    const a = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    const b = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    await d.executor.scan();
    w.sim.dropSends = 1;
    await d.executor.step(a.pda);
    await d.executor.step(b.pda);
    expect(d.store.swap(a.pda)!.facts.approval).toEqual({ approve: true });
    expect(d.store.swap(b.pda)!.facts.approval).toEqual({ approve: false, reason: 0 });
    d.store.close();
  });

  it('a byte-identical Solana transaction on the same blockhash is refused before it is recorded, not mistaken for the earlier one', async () => {
    const { w, d } = await live();
    const to = seedSigner(new Uint8Array(32).fill(0x66)).publicKey;
    const { SystemProgram, PublicKey } = await import('@solana/web3.js');
    const ix = () => SystemProgram.transfer({ fromPubkey: new PublicKey(d.sol!.operator), toPubkey: new PublicKey(to), lamports: 1_000n });
    const seen: string[] = [];
    const first = await d.sol!.sendInstructions([ix()], (sig) => seen.push(sig));
    // The same instruction again while the blockhash has not moved: the same signature.
    const hash = w.sim.fake.blockhash;
    const realHash = w.sim.fake.getLatestBlockhash.bind(w.sim.fake);
    w.sim.fake.getLatestBlockhash = async () => ({ blockhash: hash, lastValidBlockHeight: 1000 });
    w.sim.fake.blockhash = '11111111111111111111111111111111';
    const sent = w.sim.fake.sent.length;
    void first;
    w.sim.fake.getLatestBlockhash = realHash;
    // Force the earlier blockhash back for both the prepare and the send.
    const before = w.sim.fake.transactions.size;
    w.sim.fake.blockhash = (await import('@solana/web3.js')).Transaction.from(w.sim.fake.sent[sent - 1]!).recentBlockhash!;
    await expect(d.sol!.sendInstructions([ix()], (sig) => seen.push(sig))).rejects.toBeInstanceOf(Refused);
    expect(seen).toHaveLength(1); // never recorded as signed
    expect(w.sim.fake.sent.length).toBe(sent);
    expect(w.sim.fake.transactions.size).toBe(before);
    w.sim.newBlockhash();
    expect(await d.sol!.sendInstructions([ix()], (sig) => seen.push(sig))).not.toBe(first);
    d.store.close();
  });

  it('offer passes do not overlap: a forced pass during the timer\'s pass publishes terms and keys once', async () => {
    const w = await makeWorld();
    const d = await w.boot();
    await d.recover();
    await Promise.all([d.offers.tick(true), d.offers.tick(true), d.offers.tick(true)]);
    expect(w.sim.names().filter((n) => n === 'set_offer')).toHaveLength(1);
    expect(w.sim.names().filter((n) => n === 'refill_keys')).toHaveLength(2);
    expect(d.store.shares({ purpose: 'pool:sol' })).toHaveLength(16);
    d.store.close();
  });

  it('transactions that belong to no swap are looked up and resolved while the daemon runs, not left as "sent"', async () => {
    const { w, d } = await live();
    const r = await d.rotation.rotate();
    const statusOf = (tx: string | null) => d.store.intents().find((i) => i.tx === tx)!.status;
    expect(statusOf(r.tx)).toBe('sent');
    await d.resolveLooseIntents(false);
    expect(statusOf(r.tx)).toBe('confirmed');
    // One that never lands is failed once its blockhash is dead, with an alert; never assumed.
    w.sim.dropSends = 1;
    d.store.setKv('published:contacts', JSON.stringify([{ kind: 4, value: '@x' }]));
    const lost = await d.registration.syncPublished();
    await d.resolveLooseIntents(false);
    expect(statusOf(lost)).toBe('sent'); // may still land: not judged yet
    w.sim.blockHeight += 2_000;
    await d.resolveLooseIntents(false);
    expect(statusOf(lost)).toBe('failed');
    expect(d.alerts.list().find((a) => a.kind === 'tx_failed')!.message).toMatch(/did not land/);
    expect(w.sim.maker().contacts).toEqual([]);
    d.store.close();
  });
});
