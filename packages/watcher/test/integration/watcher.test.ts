// The watcher service against the real program in tools/svm-rpc, the real contract on a local
// anvil, and real XMR on the Monero regtest (two daemons: the two-node rule for real).
//
//   1. the taker's tab is closed, the maker posts a false notice: the service freezes, the maker
//      cannot claim at the claim delay, the taker returns inside the freeze window and refunds;
//   2. an honest lock: no freeze, the swap completes and the taker sweeps its XMR;
//   3. the service is killed after journaling the freeze and before sending it: the next process
//      sends it, once;
//   4. the maker-side watch in the sell-XMR direction;
//   5. the false-notice case on Ethereum.
//
// Run through `pnpm --filter @xmrswap/watcher test:integration`, which holds
// /tmp/xmrswap-integration.lock. Loopback only; the regtest is started and stopped by the SDK's
// global setup and has its own data directories.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type JointAddress, init } from '@xmrswap/core-wasm';
import { type Address, COUNTER, DEPOSIT_STATE, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import { WatcherClient } from '@xmrswap/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { ethereumCall, solanaInstruction } from '../../../sdk/src/flows/execute.js';
import { buildNotice, jointSpendKey, openNotice, swapJointAddress } from '../../../sdk/src/flows/keys.js';
import { makerStep } from '../../../sdk/src/flows/maker.js';
import { takerStep } from '../../../sdk/src/flows/taker.js';
import { deadlinesOf } from '../../../sdk/src/machine/view.js';
import { resumeSwapKeys } from '../../../sdk/src/recovery/file.js';
import { seedSigner } from '../../../sdk/src/solana/client.js';
import { hex, hex0x } from '../../../sdk/src/util.js';
import { type EthWorld, startEthereum } from '../../../sdk/test/integration/eth.js';
import { type SolWorld, startSolana } from '../../../sdk/test/integration/sol.js';
import * as xmr from '../../../sdk/test/integration/xmr.js';
import { Crash, crashAt } from '../world.js';
import { ETH_TAKER_SEED, FREEZE_WINDOW, PRICE, TAKER_SEED, X, errorCode, ethLock, ethNotice, ethRegistration, solRegistration, solFund, solNotice, solOpen, startService } from './flows.js';

type Service = Awaited<ReturnType<typeof startService>>;
const jointKeys = (j: JointAddress) => ({ viewPriv: hex(j.viewPriv), spendPub: hex(j.spendPub) });
const FALSE_TXID = new Uint8Array(32).fill(0xfa);
type Status = { status: string; reason: string | null; waiting_for: string | null; freeze_transactions: { id: string; status: string }[] };

beforeAll(async () => {
  await init();
  // Spendable coinbase and a chain of at least 720 blocks before anything is swept.
  await xmr.funded();
  expect(await xmr.chainHeight()).toBeGreaterThanOrEqual(xmr.MIN_CHAIN_HEIGHT);
});

describe('Solana', () => {
  let w: SolWorld;
  let svc: Service;
  let client: WatcherClient;
  beforeAll(async () => {
    w = await startSolana();
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE, terms: { wZ: FREEZE_WINDOW.solana } });
    await w.publishOffer({ asset: 0, direction: 1, mode: 0, price: PRICE, terms: { wZ: FREEZE_WINDOW.solana } });
    svc = await startService({ sol: w, nodeUrls: xmr.NODES });
    client = new WatcherClient(svc.url);
  });
  afterAll(async () => {
    await svc?.stop();
    await w?.stop();
  });
  const counter = async (name: keyof typeof COUNTER): Promise<number> => (await w.maker()).counters[COUNTER[name]]!;
  const status = async (ref: Uint8Array): Promise<Status> => (await client.status(ref)) as Status;

  /** Lock naming the service's key and hand the swap over, as the tab does before it closes. */
  async function watchedLock() {
    const info = await client.info();
    const o = await solOpen(w, 0, X, info.solana);
    expect(o.s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: true, watcherAddress: svc.keys.solana, wZ: FREEZE_WINDOW.solana });
    // Only the locker can hand the swap over: the maker (who knows the notice key too) and a stranger are rejected.
    for (const secret of [w.makerEnc.encSecret, new Uint8Array(32).fill(0x33)]) await expect(client.register(await solRegistration(w, o.s, secret, info.solana))).rejects.toMatchObject({ status: 403 });
    const ack = await client.register(await solRegistration(w, o.s, o.plan.keys.encSecret, info.solana));
    expect(BigInt(ack.watching_until)).toBe(o.s.tNoteDeadline + BigInt(o.s.dC));
    return { ...o, share: o.share! };
  }

  it('the service is healthy: both chains of facts answer, the two Monero nodes agree, the fee balance has runway', async () => {
    const health = (await (await fetch(`${svc.url}/watch/v1/health`)).json()) as { ok: boolean; accepting: boolean; chains: { solana: Record<string, unknown> }; monero: unknown };
    expect(health.monero).toEqual({ nodes: 2, reachable: 2, agreeing: true });
    expect(health.chains.solana).toMatchObject({ reachable: true, address: svc.keys.solana, fee_balance: '50000000', accepting: true });
    expect(health.chains.solana['runway_freezes'] as number).toBeGreaterThan(1_000);
    expect(health).toMatchObject({ ok: true, accepting: true });
  });

  it('1. tab closed, false notice: the service freezes; the maker cannot claim at the claim delay; the taker returns inside the freeze window and refunds', async () => {
    const takerBefore = await w.balance(w.taker.publicKey);
    const { plan, s: active, share } = await watchedLock();
    const freezes = await counter('freezes');
    await svc.pass();
    expect(await status(active.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'notice' });

    // The maker posts a notice for a transaction that does not exist and locks no XMR. The tab is closed.
    let s = await solNotice(w, active, share, FALSE_TXID);
    const dl = deadlinesOf('solana', s);
    await svc.pass();
    // The service opened the notice with the key it was given and looked on both nodes: nothing. It waits for T_cut.
    expect(await status(active.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'lock-check' });
    await w.warpTo(dl.tCut! - 1n);
    await svc.pass();
    expect((await w.swap(plan.swapPda))!.state).toBe(SWAP_STATE.NOTICED);
    await w.warpTo(dl.tCut!);
    await svc.pass();
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.FROZEN, tFreeze: dl.tCut });
    expect(s.tFreeze <= dl.tCo! - dl.margin).toBe(true);
    const ff = deadlinesOf('solana', s).tFf!;
    expect(ff).toBe(s.tFreeze + BigInt(FREEZE_WINDOW.solana));
    expect(await counter('freezes')).toBe(freezes + 1);
    await svc.pass(3);
    const st = await status(active.swapRef);
    expect(st).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed', waiting_for: null });
    expect(st.freeze_transactions.map((t) => t.status)).toEqual(['landed']);
    // The watch is over: its notice key is gone from the database.
    expect(svc.store.keyCount('solana', hex(active.swapRef))).toBe(0);

    // The claim delay runs out. Without the freeze the maker would take the payment now.
    await w.warpTo(dl.tCo!);
    const early = solanaInstruction(w.client.program, s, await w.maker(), w.operator.publicKey, { name: 'claim' }, { secret: share.spend });
    expect(await errorCode(w.send([early], [w.operator]))).toBe('TooEarly');
    expect((await w.swap(plan.swapPda))!.flags & SWAP_FLAG.REVEALED).toBe(0);

    // The taker comes back inside the freeze window with nothing but chain state and its seed.
    await w.warpTo(dl.tCo! + 60n);
    const keys = resumeSwapKeys(TAKER_SEED, 'solana', s.swapNonce);
    const opened = openNotice(s, keys.encSecret)!;
    const lock = await xmr.verify(hex(opened.txid), jointKeys(swapJointAddress(s, opened.view, 'regtest')), s.xmr, s.depth);
    expect(lock.state).toBe('not-found');
    const d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'session', secret: true, notAfter: ff - 300n, row: 'Z3' });
    await w.exec(s, d, { session: seedSigner(keys.sessionSecret) }, { secret: keys.spend });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    await w.warpTo(deadlinesOf('solana', s).tHold!);
    await w.exec(s, takerStep({ swap: s, now: await w.now() }), {});
    expect(await w.swap(plan.swapPda)).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RETURNED });
    // The taker lost fees and rent only; without the watcher it would have lost the payment.
    const lost = takerBefore - (await w.balance(w.taker.publicKey));
    expect(lost > 0n && lost < 10_000_000n).toBe(true);
  });

  it('2. an honest lock is not frozen: the swap completes and the XMR is the taker\'s', async () => {
    const { plan, s: active, share, session, pricing } = await watchedLock();
    const freezes = await counter('freezes');
    const feeBalance = await w.balance(svc.keys.solana);
    // A real lock: the maker pays the joint address, posts the notice, relays, and blocks come.
    const joint = swapJointAddress(active, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, active.xmr);
    let s = await solNotice(w, active, share, xmr.txidBytes(lockTx.txid));
    await xmr.relay(lockTx.txHex);
    const dl = deadlinesOf('solana', s);
    // In the pool on both nodes: valid, unconfirmed. Before T_cut that is no reason to freeze.
    await svc.pass();
    expect(await status(active.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'lock-check', freeze_transactions: [] });
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(lockTx.txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    // At T_cut, and after it, the lock is confirmed on both nodes: the service leaves the swap alone.
    for (const t of [dl.tCut!, dl.tCut! + 120n]) {
      await w.warpTo(t);
      await svc.pass(2);
      expect((await w.swap(plan.swapPda))!.state).toBe(SWAP_STATE.NOTICED);
      expect(await status(active.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'recheck', freeze_transactions: [] });
    }
    // The taker returns, verifies the lock itself and sets ready.
    const ready = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(ready).toMatchObject({ do: 'call', call: { name: 'set_ready' }, caller: 'session', row: 'A9' });
    await w.exec(s, ready, { session });
    await svc.pass(3);
    expect(await status(active.swapRef)).toMatchObject({ status: 'not_needed', reason: 'the locker set ready', freeze_transactions: [] });
    expect(await counter('freezes')).toBe(freezes);
    // The service paid nothing for this swap.
    expect(await w.balance(svc.keys.solana)).toBe(feeBalance);
    // The maker claims in the ordinary window, and the taker sweeps its XMR.
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.READY, tFreeze: 0n });
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11a' });
    const payoutBefore = await w.balance(w.payout.publicKey);
    await w.exec(s, d, {}, { secret: share.spend });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(await w.balance(w.payout.publicKey)).toBe(payoutBefore + pricing.amount - pricing.fee);
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, plan.keys.spend, 'taker'), viewKey: joint.viewPriv, lock, txid: lockTx.txid });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);
  });

  it('3. killed after journaling the freeze and before sending it: the next process sends it, once', async () => {
    const dying = await startService({ sol: w, nodeUrls: xmr.NODES, fault: crashAt('after-attempt-journal') });
    const info = await new WatcherClient(dying.url).info();
    // Another data directory: another watcher, with its own keys.
    expect(info.solana).not.toBe(svc.keys.solana);
    const o = await solOpen(w, 0, X, info.solana);
    await new WatcherClient(dying.url).register(await solRegistration(w, o.s, o.plan.keys.encSecret, info.solana));
    const freezes = await counter('freezes');
    const s = await solNotice(w, o.s, o.share!, FALSE_TXID);
    const dl = deadlinesOf('solana', s);
    await w.warpTo(dl.tCut!);
    await expect(dying.pass()).rejects.toBeInstanceOf(Crash);
    // The process is gone. The decision and the signed transaction are in the journal; nothing was broadcast.
    const journaled = dying.store.attempts('solana', hex(s.swapRef));
    expect(journaled.map((a) => a.status)).toEqual(['journaled']);
    expect(dying.store.getWatch('solana', hex(s.swapRef))).toMatchObject({ status: 'freezing', decided_why: 'lock-not-confirmed' });
    await dying.stop();
    expect((await w.swap(o.plan.swapPda))!.state).toBe(SWAP_STATE.NOTICED);
    expect(await counter('freezes')).toBe(freezes);
    const feeBalance = await w.balance(info.solana);

    // A new process over the same data directory (the same keystore and database).
    const next = await startService({ sol: w, nodeUrls: xmr.NODES, dataDir: dying.dataDir });
    try {
      expect(next.keys.solana).toBe(info.solana);
      await next.pass();
      const frozen = (await w.swap(o.plan.swapPda))!;
      expect(frozen.state).toBe(SWAP_STATE.FROZEN);
      expect(frozen.tFreeze <= dl.tCo! - dl.margin).toBe(true);
      await next.pass(4);
      expect(await counter('freezes')).toBe(freezes + 1);
      // The very transaction that was journaled, and only it: one signature, one fee.
      const after = next.store.attempts('solana', hex(s.swapRef));
      expect(after.map((a) => [a.tx_id, a.status])).toEqual([[journaled[0]!.tx_id, 'landed']]);
      expect(feeBalance - (await w.balance(info.solana))).toBe(BigInt(after[0]!.max_fee));
      expect((await new WatcherClient(next.url).status(s.swapRef)) as Status).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    } finally {
      await next.stop();
    }
  });

  it('4. the maker-side watch (sell XMR): the daemon is down, the taker posts a false notice, the service freezes, the maker returns and refunds', async () => {
    const backouts = await counter('backouts_after_freeze');
    const o = await solOpen(w, 1, X);
    const info = await client.info();
    // Before `fund` the swap names no watcher: the service refuses it.
    await expect(client.register(await solRegistration(w, o.s, w.makerEnc.encSecret, info.solana))).rejects.toMatchObject({ status: 404 });
    // The maker names its watcher at fund and hands it the notice key.
    const f = await solFund(w, o.s, info.solana);
    let s = f.s;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, direction: 1, watcher: true, watcherAddress: svc.keys.solana });
    // The taker is the counterparty here: it knows the notice key too, and is not the locker. Rejected, like any stranger.
    for (const secret of [o.plan.keys.encSecret, new Uint8Array(32).fill(0x33)]) await expect(client.register(await solRegistration(w, s, secret, info.solana))).rejects.toMatchObject({ status: 403 });
    expect(svc.store.getWatch('solana', hex(s.swapRef))).toBe(null);
    await client.register(await solRegistration(w, s, w.makerEnc.encSecret, info.solana));

    // The taker never pays XMR and posts a notice for a transaction that does not exist. The daemon is down.
    await w.exec(s, takerStep({ swap: s, now: await w.now(), paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, new Uint8Array(32).fill(0xfb), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapPda))!;
    const dl = deadlinesOf('solana', s);
    await svc.pass();
    expect(await status(s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'lock-check' });
    await w.warpTo(dl.tCut!);
    await svc.pass();
    s = (await w.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    await svc.pass(3);
    expect(await status(s.swapRef)).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    const ff = deadlinesOf('solana', s).tFf!;

    // Without the freeze the taker would claim the maker's escrow at T_co.
    await w.warpTo(dl.tCo!);
    const steal = solanaInstruction(w.client.program, s, await w.maker(), o.session.publicKey, { name: 'claim' }, { secret: o.plan.keys.spend });
    expect(await errorCode(w.send([steal], [o.session]))).toBe('TooEarly');

    // The daemon comes back inside the freeze window, verifies for itself and refunds.
    await w.warpTo(dl.tCo! + 120n);
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    const lock = await xmr.verify(hex(opened.txid), jointKeys(swapJointAddress(s, opened.view, 'regtest')), s.xmr, s.depth);
    const d = makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'operator', secret: true, notAfter: ff - 300n, row: 'Z3', urgent: true });
    await w.exec(s, d, {}, { secret: f.share.spend });
    s = (await w.swap(o.plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.backouts_after_freeze, depositState: DEPOSIT_STATE.NONE });
    expect(await counter('backouts_after_freeze')).toBe(backouts + 1);
  });
});

describe('Ethereum', () => {
  let w: EthWorld;
  let svc: Service;
  beforeAll(async () => {
    w = await startEthereum();
    svc = await startService({ eth: w, nodeUrls: xmr.NODES });
  });
  afterAll(async () => {
    await svc?.stop();
    await w?.stop();
  });
  const counter = async (name: keyof typeof COUNTER): Promise<number> => (await w.maker()).counters[COUNTER[name]]!;

  it('5. tab closed, false notice: the service freezes; the maker cannot claim at the claim delay; the taker returns inside the freeze window and refunds', async () => {
    const client = new WatcherClient(svc.url);
    const info = await client.info();
    expect(info.ethereum).toBe(svc.keys.ethereum);
    const o = await ethLock(w, X, info.ethereum as Address);
    expect(o.s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: true, watcherAddress: info.ethereum, wZ: FREEZE_WINDOW.ethereum });
    // The notice key is sealed to the watcher's Solana key whichever chain the swap is on. Accepted only once the swap is final.
    await expect(client.register(await ethRegistration(w, o.s, o.plan.keys.encSecret, info.solana))).rejects.toMatchObject({ status: 404 });
    await w.finalize();
    // The maker (the counterparty) and a stranger cannot register the taker's swap.
    for (const secret of [w.makerEnc.encSecret, new Uint8Array(32).fill(0x33)]) await expect(client.register(await ethRegistration(w, o.s, secret, info.solana))).rejects.toMatchObject({ status: 403 });
    expect(svc.store.getWatch('ethereum', hex(o.s.swapRef))).toBe(null);
    const ack = await client.register(await ethRegistration(w, o.s, o.plan.keys.encSecret, info.solana));
    expect(BigInt(ack.watching_until)).toBe(o.s.tNoteDeadline + BigInt(o.s.dC));
    const freezes = await counter('freezes');
    const refunds = await counter('refunds_after_freeze');
    const health = (await (await fetch(`${svc.url}/watch/v1/health`)).json()) as { ok: boolean; chains: { ethereum: Record<string, unknown> } };
    expect(health.chains.ethereum).toMatchObject({ reachable: true, address: svc.keys.ethereum, accepting: true });

    let s = await ethNotice(w, o.s, o.share, FALSE_TXID);
    const dl = deadlinesOf('ethereum', s);
    await svc.pass();
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'watching', waiting_for: 'lock-check' });
    await w.advanceTo(dl.tCut!);
    await svc.pass();
    s = (await w.swap(o.plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    expect(s.tFreeze >= dl.tCut! && s.tFreeze <= dl.tCo! - dl.margin).toBe(true);
    const ff = deadlinesOf('ethereum', s).tFf!;
    expect(ff).toBe(s.tFreeze + BigInt(FREEZE_WINDOW.ethereum));
    await svc.pass(3);
    expect(await client.status(o.s.swapRef)).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: lock-not-confirmed' });
    expect(await counter('freezes')).toBe(freezes + 1);

    // The claim delay runs out. Without the freeze the maker would take the payment now.
    await w.advanceTo(dl.tCo!);
    expect(await errorCode(w.send(ethereumCall(w.client.contract, s, { name: 'claim' }, { secret: o.share.spend })!, w.operator))).toBe('TooEarly');

    // The taker comes back inside the freeze window with chain state and its seed.
    await w.advanceTo(dl.tCo! + 3600n);
    const keys = resumeSwapKeys(ETH_TAKER_SEED, 'ethereum', s.swapNonce);
    const opened = openNotice(s, keys.encSecret)!;
    const lock = await xmr.verify(hex(opened.txid), jointKeys(swapJointAddress(s, opened.view, 'regtest')), s.xmr, s.depth);
    expect(lock.state).toBe('not-found');
    const d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'session', secret: true, notAfter: ff - 1800n, row: 'Z3' });
    const takerBefore = await w.balance(w.taker.address);
    await w.exec(s, d, { session: privateKeyToAccount(hex0x(keys.sessionSecret)) }, { secret: keys.spend });
    s = (await w.swap(o.plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    expect((await w.balance(w.taker.address)) - takerBefore >= o.pricing.amount - o.pricing.deposit).toBe(true);
    expect(await counter('refunds_after_freeze')).toBe(refunds + 1);
  });
});
