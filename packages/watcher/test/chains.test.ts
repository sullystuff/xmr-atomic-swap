// The acceptance integration test of SPEC 11.9 (A5): the real service against the real program
// inside tools/svm-rpc and the real contract on a local anvil. A false notice is frozen before
// `T_co − M` on both chains; a good lock is not.
//
// No Monero chain runs here (that is `test:integration`, with real XMR on the regtest): the
// Monero nodes are in memory. The false notice names a transaction neither node has, and
// `verifyLock` runs for real against them. For the good lock, `verifyLock` is replaced by a
// function that reports that one transaction confirmed: the chain side is what this file proves.
// Everything is on loopback, on free ports chosen at start.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { init } from '@xmrswap/core-wasm';
import { type Address, COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { type VerifyLockResult, WatcherClient, verifyLock } from '@xmrswap/sdk';
import { FakeMoneroNode } from '@xmrswap/sdk/testing';
import { ethereumCall, solanaInstruction } from '../../sdk/src/flows/execute.js';
import { deadlinesOf } from '../../sdk/src/machine/view.js';
import { hex } from '../../sdk/src/util.js';
import { type EthWorld, startEthereum } from '../../sdk/test/integration/eth.js';
import { type SolWorld, startSolana } from '../../sdk/test/integration/sol.js';
import { FREEZE_WINDOW, PRICE, X, errorCode, ethLock, ethNotice, ethRegistration, solRegistration, solNotice, solOpen, startService } from './integration/flows.js';

const FALSE_TXID = new Uint8Array(32).fill(0xfa);
const GOOD_TXID = new Uint8Array(32).fill(0x0c);
const nodes = () => [new FakeMoneroNode('a', 800), new FakeMoneroNode('b', 800)];
/** `verifyLock`, except that the one transaction this file calls "the good lock" is reported confirmed. */
const verify: typeof verifyLock = async (a) => (a.txid === hex(GOOD_TXID) ? ({ ok: true, state: 'confirmed', reasons: [], codes: [], amount: a.minAmount, confirmations: a.minConf, nodes: [] } as unknown as VerifyLockResult) : verifyLock(a));

beforeAll(async () => {
  await init();
});

describe('Solana: the real program in svm-rpc', () => {
  let w: SolWorld;
  let svc: Awaited<ReturnType<typeof startService>>;
  beforeAll(async () => {
    w = await startSolana();
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE, terms: { wZ: FREEZE_WINDOW.solana } });
    svc = await startService({ sol: w, nodes: nodes(), verifyLock: verify });
  });
  afterAll(async () => {
    await svc?.stop();
    await w?.stop();
  });
  const freezes = async (): Promise<number> => (await w.maker()).counters[COUNTER.freezes]!;

  it('a false notice is frozen before T_co − M, and the maker cannot claim at the claim delay', async () => {
    const client = new WatcherClient(svc.url);
    const info = await client.info();
    expect(info.solana).toBe(svc.keys.solana);
    const o = await solOpen(w, 0, X, info.solana);
    expect(o.s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcherAddress: info.solana });
    // Only the swap's locker can register it: the maker (the counterparty) and a stranger are rejected, and nothing is stored.
    for (const secret of [w.makerEnc.encSecret, new Uint8Array(32).fill(0x33)]) await expect(client.register(await solRegistration(w, o.s, secret, info.solana))).rejects.toMatchObject({ status: 403 });
    expect(svc.store.getWatch('solana', hex(o.s.swapRef))).toBe(null);
    const ack = await client.register(await solRegistration(w, o.s, o.plan.keys.encSecret, info.solana));
    expect(BigInt(ack.watching_until)).toBe(o.s.tNoteDeadline + BigInt(o.s.dC));
    const before = await freezes();
    const balance = await w.balance(svc.keys.solana);
    await svc.pass();
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'notice' });

    let s = await solNotice(w, o.s, o.share!, FALSE_TXID);
    const dl = deadlinesOf('solana', s);
    await w.warpTo(dl.tCut! - 1n);
    await svc.pass(2);
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'lock-check' });
    expect((await w.swap(o.plan.swapPda))!.state).toBe(SWAP_STATE.NOTICED);
    await w.warpTo(dl.tCut!);
    await svc.pass();
    s = (await w.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    expect(s.tFreeze >= dl.tCut! && s.tFreeze <= dl.tCo! - dl.margin).toBe(true);
    expect(await freezes()).toBe(before + 1);
    await svc.pass(3);
    const st = (await client.status(o.s.swapRef)) as { status: string; reason: string; freeze_transactions: { id: string; status: string }[] };
    expect(st).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    expect(st.freeze_transactions).toHaveLength(1);
    expect(st.freeze_transactions[0]!.status).toBe('landed');
    // One freeze, one fee: the watcher's key paid for one small transaction and nothing else moved.
    const paid = balance - (await w.balance(svc.keys.solana));
    expect(paid > 0n && paid <= 5_020n).toBe(true);
    expect(await freezes()).toBe(before + 1);
    // At T_co the maker would have taken the payment; now it cannot until T_ff.
    await w.warpTo(dl.tCo!);
    const claim = solanaInstruction(w.client.program, s, await w.maker(), w.operator.publicKey, { name: 'claim' }, { secret: o.share!.spend });
    expect(await errorCode(w.send([claim], [w.operator]))).toBe('TooEarly');
  });

  it('a good lock is not frozen: the watch ends "not needed" and the swap is still NOTICED', async () => {
    const client = new WatcherClient(svc.url);
    const o = await solOpen(w, 0, X, svc.keys.solana);
    await client.register(await solRegistration(w, o.s, o.plan.keys.encSecret, svc.keys.solana));
    const before = await freezes();
    const s = await solNotice(w, o.s, o.share!, GOOD_TXID);
    const dl = deadlinesOf('solana', s);
    for (const t of [dl.tCut! - 1n, dl.tCut!, dl.tCut! + 60n, dl.tCo! - dl.margin]) {
      await w.warpTo(t);
      await svc.pass(2);
      expect((await w.swap(o.plan.swapPda))!.state).toBe(SWAP_STATE.NOTICED);
    }
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'recheck', freeze_transactions: [] });
    await w.warpTo(dl.tCo! - dl.margin + 1n);
    await svc.pass(3);
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'not_needed', reason: 'the lock stayed confirmed through the freeze window', freeze_transactions: [] });
    expect(await freezes()).toBe(before);
    expect((await w.swap(o.plan.swapPda))!.tFreeze).toBe(0n);
  });

  it('a swap that names another watcher is refused, and the service spends nothing on it', async () => {
    const client = new WatcherClient(svc.url);
    const o = await solOpen(w, 0, X, w.watcher.publicKey);
    const balance = await w.balance(svc.keys.solana);
    await expect(client.register(await solRegistration(w, o.s, o.plan.keys.encSecret, svc.keys.solana))).rejects.toMatchObject({ status: 404 });
    const s = await solNotice(w, o.s, o.share!, FALSE_TXID);
    await w.warpTo(deadlinesOf('solana', s).tCut!);
    await svc.pass(3);
    expect((await w.swap(new PublicKey(s.swapRef).toBase58()))!.state).toBe(SWAP_STATE.NOTICED);
    expect(await w.balance(svc.keys.solana)).toBe(balance);
  });
});

describe('Ethereum: the real contract on anvil', () => {
  let w: EthWorld;
  let svc: Awaited<ReturnType<typeof startService>>;
  beforeAll(async () => {
    w = await startEthereum();
    svc = await startService({ eth: w, nodes: nodes(), verifyLock: verify });
  });
  afterAll(async () => {
    await svc?.stop();
    await w?.stop();
  });
  const freezes = async (): Promise<number> => (await w.maker()).counters[COUNTER.freezes]!;

  it('a false notice is frozen before T_co − M, and the maker cannot claim at the claim delay', async () => {
    const client = new WatcherClient(svc.url);
    const info = await client.info();
    expect(info.ethereum).toBe(svc.keys.ethereum);
    const o = await ethLock(w, X, info.ethereum as Address);
    expect(o.s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcherAddress: info.ethereum, wZ: FREEZE_WINDOW.ethereum });
    // Accepted only once the swap is found at `finalized`.
    await expect(client.register(await ethRegistration(w, o.s, o.plan.keys.encSecret, info.solana))).rejects.toMatchObject({ status: 404 });
    await w.finalize();
    for (const secret of [w.makerEnc.encSecret, new Uint8Array(32).fill(0x33)]) await expect(client.register(await ethRegistration(w, o.s, secret, info.solana))).rejects.toMatchObject({ status: 403 });
    expect(svc.store.getWatch('ethereum', hex(o.s.swapRef))).toBe(null);
    await client.register(await ethRegistration(w, o.s, o.plan.keys.encSecret, info.solana));
    const before = await freezes();
    const balance = await w.balance(svc.keys.ethereum);

    let s = await ethNotice(w, o.s, o.share, FALSE_TXID);
    const dl = deadlinesOf('ethereum', s);
    await svc.pass(2);
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'lock-check' });
    await w.advanceTo(dl.tCut!);
    await svc.pass();
    s = (await w.swap(o.plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    expect(s.tFreeze >= dl.tCut! && s.tFreeze <= dl.tCo! - dl.margin).toBe(true);
    await svc.pass(3);
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    expect(await freezes()).toBe(before + 1);
    // One freeze was paid for, within the bound the service reserves per watch.
    const paid = balance - (await w.balance(svc.keys.ethereum));
    expect(paid > 0n && paid <= 98_250n * 100_000_000_000n).toBe(true);
    const sent = w.gas.filter((g) => g.from === svc.keys.ethereum);
    expect(sent).toEqual([]); // the world's own sender never used the watcher key: the service sent it itself
    await w.advanceTo(dl.tCo!);
    expect(await errorCode(w.send(ethereumCall(w.client.contract, s, { name: 'claim' }, { secret: o.share.spend })!, w.operator))).toBe('TooEarly');
  });

  it('a good lock is not frozen: the watch ends "not needed" and the swap is still NOTICED', async () => {
    const client = new WatcherClient(svc.url);
    const o = await ethLock(w, X, svc.keys.ethereum);
    await w.finalize();
    await client.register(await ethRegistration(w, o.s, o.plan.keys.encSecret, svc.keys.solana));
    const before = await freezes();
    const s = await ethNotice(w, o.s, o.share, GOOD_TXID);
    const dl = deadlinesOf('ethereum', s);
    for (const t of [dl.tCut!, dl.tCut! + 600n]) {
      await w.advanceTo(t);
      await svc.pass(2);
      expect((await w.swap(o.plan.swapId))!.state).toBe(SWAP_STATE.NOTICED);
    }
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'recheck', freeze_transactions: [] });
    await w.advanceTo(dl.tCo! - dl.margin + 1n);
    await svc.pass(3);
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'not_needed', reason: 'the lock stayed confirmed through the freeze window' });
    expect(await freezes()).toBe(before);
    expect((await w.swap(o.plan.swapId))!.tFreeze).toBe(0n);
  });
});
