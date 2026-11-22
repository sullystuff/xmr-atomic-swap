// Solana integration (M2): the SDK against the real program (the built xmr_swap.so) inside
// tools/svm-rpc, with real XMR on the Monero regtest. Loopback only; no validator, no cluster.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { init } from '@xmrswap/core-wasm';
import { type DerivedKeys, type JointAddress } from '@xmrswap/core-wasm';
import { type ApprovalResponse, COUNTER, DEPOSIT_STATE, DEV_PROGRAM_ID, SWAP_FLAG, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import { solanaInstruction } from '../../src/flows/execute.js';
import { buildNotice, checkCounterpartyShare, contactKeys, jointSpendKey, openNotice, solanaMakerShare, swapJointAddress, takerSwapKeys } from '../../src/flows/keys.js';
import { makerStep } from '../../src/flows/maker.js';
import { planSolanaOpen } from '../../src/flows/open.js';
import { takerStep } from '../../src/flows/taker.js';
import { type SwapView, deadlinesOf } from '../../src/machine/view.js';
import { openFromMaker, openFromTaker, sealToMaker, sealToTaker } from '../../src/messages/envelope.js';
import { findDeposits } from '../../src/monero/watch.js';
import { createRecoveryFile, encryptRecoveryFile, readRecoveryFile, recoverySeed, resumeSwapKeys, writeRecoveryFile } from '../../src/recovery/file.js';
import { priceOffer } from '../../src/registry/pricing.js';
import { offerProblem, signSolApproval, solApprovalFromResponse, solApprovalProblem, solApprovalResponse, solQuoteProblem } from '../../src/signing/solana.js';
import { ProgramError, seedSigner } from '../../src/solana/client.js';
import { hex } from '../../src/util.js';
import { OPERATOR_SEED, type SolWorld, T0, XMR as X, startSolana } from './sol.js';
import * as xmr from './xmr.js';

let w: SolWorld;
const takerSeed = new Uint8Array(32).fill(42);

beforeAll(async () => {
  await init();
  w = await startSolana();
  await xmr.funded();
});
afterAll(async () => {
  await w?.stop();
});

/** Lock against the live direction-A offer of `asset`. Returns the swap (ACTIVE in auto mode), the taker's keys and the maker's share. */
async function lockA(asset: number, xmrAmount: bigint, seed = takerSeed) {
  const maker = await w.maker();
  let offer = (await w.client.getOffer(w.makerPda, asset, 0))!;
  if (offerProblem(offer, maker, await w.now()) === 'OfferStale') {
    // A running daemon refreshes every few seconds; the tests warp hours ahead between swaps.
    await w.send([w.client.program.refreshOffers(w.operator.publicKey, w.makerPda, [{ asset, direction: 0, enabled: true, prices: [offer.prices[0]!, 0n, 0n], capacityXmr: 1000n * X }])], [w.operator]);
    offer = (await w.client.getOffer(w.makerPda, asset, 0))!;
  }
  expect(offerProblem(offer, maker, await w.now(), { termsHash: offer.termsHash })).toBe(null);
  const plan = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed, xmr: xmrAmount, source: { offer }, rentExemptMinimum: w.rent0 });
  await w.send(plan.instructions, [w.taker]);
  const s = (await w.swap(plan.swapPda))!;
  return { plan, s, session: seedSigner(plan.keys.sessionSecret), share: w.shares.get(hex(s.makerSpendPub))!, pricing: priceOffer(offer, xmrAmount) };
}

/** Direction A, maker side: build the XMR lock, post the notice, and only then relay. Returns the swap in NOTICED. */
async function makerNotices(s: SwapView, share: DerivedKeys): Promise<{ s: SwapView; txid: string; joint: JointAddress }> {
  const joint = swapJointAddress(s, share.view, 'regtest');
  const lockTx = await xmr.prepareTransfer(joint.address, s.xmr);
  const d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
  await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, xmr.txidBytes(lockTx.txid), share.view) });
  const noticed = (await w.swap(hexPda(s)))!;
  expect(noticed.state).toBe(SWAP_STATE.NOTICED);
  await xmr.relay(lockTx.txHex);
  return { s: noticed, txid: lockTx.txid, joint };
}
const hexPda = (s: SwapView): string => new PublicKey(s.swapRef).toBase58();
const jointKeys = (j: JointAddress) => ({ viewPriv: hex(j.viewPriv), spendPub: hex(j.spendPub) });

describe('endpoint and registry', () => {
  it('svm-rpc is not a live cluster, tells the chain time the program sees, and holds the initialised program', async () => {
    await expect(w.client.verifyGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).rejects.toMatchObject({ code: 'WrongCluster' });
    await w.client.verifyGenesis(w.genesis);
    const t = await w.now();
    expect(t >= BigInt(T0)).toBe(true);
    await w.svm.warp(90);
    expect(await w.now()).toBe(t + 90n);
    expect(await w.client.getConfig()).toMatchObject({ admin: w.admin.publicKey, usdcMint: w.usdc, splitMode: 0 });
    const makers = await w.client.listMakers();
    expect(makers.map((m) => m.pubkey)).toEqual([w.makerPda]);
    expect(makers[0]!.account).toMatchObject({ owner: w.owner.publicKey, operator: w.operator.publicKey, payout: w.payout.publicKey, encKeyVersion: 1 });
  });
});

describe('buy XMR with SOL (direction A, auto mode)', () => {
  it('lock, real XMR lock, notice, two-node verification, ready, claim, sweep with the combined key, close', async () => {
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: 150_000_000n });
    const maker = await w.maker();
    const offer = (await w.client.getOffer(w.makerPda, 0, 0))!;
    expect(offerProblem(offer, maker, await w.now(), { termsHash: offer.termsHash })).toBe(null);
    const xmrAmount = 2n * X;
    const pricing = priceOffer(offer, xmrAmount);

    // ---- taker: lock
    const plan = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: xmrAmount, source: { offer }, rentExemptMinimum: w.rent0 });
    const before = await w.balance(w.taker.publicKey);
    await w.send(plan.instructions, [w.taker]);
    let s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, direction: 0, amount: pricing.amount, deposit: pricing.deposit, xmr: xmrAmount, depth: 2, taker: w.taker.publicKey, maker: w.makerPda });
    expect(before - (await w.balance(w.taker.publicKey)) > pricing.amount + plan.sessionLamports).toBe(true);
    const session = seedSigner(plan.keys.sessionSecret);
    expect(s.sessionKey).toBe(session.publicKey);
    expect(await w.balance(session.publicKey)).toBe(plan.sessionLamports);

    // ---- maker: its share came from the offer pool; build the XMR lock without relaying it
    const share = w.shares.get(hex(s.makerSpendPub))!;
    expect(share).toBeDefined();
    expect(makerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'commitment-check' });
    checkCounterpartyShare(s.takerSpendPub, share.spendPub);
    expect(makerStep({ swap: s, now: await w.now(), commitmentsOk: true })).toMatchObject({ do: 'offchain', action: 'prepare-lock-tx' });
    const joint = swapJointAddress(s, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, s.xmr);
    // The notice goes on-chain first; only then is the XMR broadcast.
    let d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
    expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' } });
    await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, xmr.txidBytes(lockTx.txid), share.view) });
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.NOTICED);
    expect(s.flags & SWAP_FLAG.NOTICE).toBeTruthy();
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'prepared' })).toMatchObject({ do: 'offchain', action: 'relay-xmr' });
    await xmr.relay(lockTx.txHex);

    // ---- taker: decrypt the notice, recompute the joint address, verify on both nodes
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'notice-opening' });
    const opened = openNotice(s, plan.keys.encSecret)!;
    expect(hex(opened.txid)).toBe(lockTx.txid);
    const takerJoint = swapJointAddress(s, opened.view, 'regtest');
    expect(takerJoint.address).toBe(joint.address);
    const keys = { viewPriv: hex(takerJoint.viewPriv), spendPub: hex(takerJoint.spendPub) };
    const pending = await xmr.verifyUntil(lockTx.txid, keys, s.xmr, s.depth, 'pending');
    expect(pending).toMatchObject({ ok: false, confirmations: 0, amount: s.xmr });
    expect(takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(pending) })).toMatchObject({ do: 'wait', on: 'xmr-confirmations' });
    await xmr.settle(1);
    const shallow = await xmr.verifyUntil(lockTx.txid, keys, s.xmr, s.depth, 'confirming');
    expect(shallow.confirmations).toBe(1);
    await xmr.settle(1);
    const lock = await xmr.verifyUntil(lockTx.txid, keys, s.xmr, s.depth, 'confirmed');
    expect(lock).toMatchObject({ ok: true, confirmations: 2, reasons: [] });
    expect(lock.nodes.length).toBe(2);

    // ---- taker: ready, but not before the minimum; the program agrees with the flow on the second
    d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    const dl = deadlinesOf('solana', s);
    expect(d).toEqual({ do: 'wait', on: 'ready-minimum', until: dl.tReadyMin });
    const early = await w.send([w.client.program.setReady({ caller: session.publicKey, swap: plan.swapPda, maker: w.makerPda })], [session]).catch((e) => e);
    expect(early).toBeInstanceOf(ProgramError);
    expect(early.code).toBe('TooEarly');
    await w.warpTo(dl.tReadyMin!);
    d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'set_ready' }, caller: 'session' });
    await w.exec(s, d, { session });
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.READY);
    expect(takerStep({ swap: s, now: await w.now() })).toMatchObject({ do: 'wait', on: 'claim' });

    // ---- maker: claim; the payout goes to the payout address, the fee to the treasury
    const payoutBefore = await w.balance(w.payout.publicKey);
    const treasuryBefore = await w.balance(w.client.program.treasury.toBase58());
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed' });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, secret: true, row: 'A11a' });
    const claimSig = await w.exec(s, d, {}, { secret: share.spend });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(await w.balance(w.payout.publicKey)).toBe(payoutBefore + pricing.amount - pricing.fee);
    expect(await w.balance(w.client.program.treasury.toBase58())).toBe(treasuryBefore + pricing.fee);
    const events = await w.client.eventsOf(claimSig);
    expect(events.map((e) => e.name)).toEqual(['Claimed']);
    expect(events[0]).toMatchObject({ data: { swap: plan.swapPda, counter: COUNTER.completed, paid: pricing.amount - pricing.fee, fee: pricing.fee } });
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed' })).toEqual({ do: 'done', outcome: 'completed' });

    // ---- taker: the maker's share is in the account; sweep the XMR with the combined key
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    expect(hex(s.revealed)).toBe(hex(share.spend));
    const spendKey = jointSpendKey(s, plan.keys.spend, 'taker');
    const swept = await xmr.sweep({ spendKey, viewKey: takerJoint.viewPriv, lock, txid: lockTx.txid });
    expect(swept).toMatchObject({ published: true, jointAddress: joint.address, amount: s.xmr - swept.fee });
    expect(await xmr.isMined(swept.txid)).toBe(true);

    // ---- taker: close the account with the session key; all rent returns to the taker
    d = takerStep({ swap: s, now: await w.now(), swept: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'close_swap' }, caller: 'session' });
    await w.exec(s, d, { session });
    expect(await w.swap(plan.swapPda)).toBe(null);
    expect(await w.balance(session.publicKey)).toBe(0n);
    const m = await w.maker();
    expect([m.counters[COUNTER.locks], m.counters[COUNTER.notices], m.counters[COUNTER.readies], m.counters[COUNTER.completed]]).toEqual([1, 1, 1, 1]);
    expect(m.volume[0]).toBe(pricing.amount);
    expect(hex(takerSwapKeys(takerSeed, 'solana', plan.swapNonce).spend)).toBe(hex(plan.keys.spend));
    expect(DEV_PROGRAM_ID).toBe(w.client.programId);
  });
});

describe('sell XMR for USDC (direction B)', () => {
  it('take, fund, the taker pays XMR from its own wallet, notice, verification, ready, claim, the maker sweeps', async () => {
    await w.publishOffer({ asset: 1, direction: 1, mode: 0, price: 150_000_000n });
    const maker = await w.maker();
    const offer = (await w.client.getOffer(w.makerPda, 1, 1))!;
    const xmrAmount = 3n * X;
    const pricing = priceOffer(offer, xmrAmount);
    const takerUsdc = await w.tokenBalance(w.taker.publicKey);
    const operatorUsdc = await w.tokenBalance(w.operator.publicKey);

    // ---- taker: take. Only the deposit moves in; the swap waits for the maker's funds.
    const plan = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: xmrAmount, source: { offer }, rentExemptMinimum: w.rent0, slippageBps: 10 });
    expect(plan.direction).toBe(1);
    await w.send(plan.instructions, [w.taker]);
    const session = seedSigner(plan.keys.sessionSecret);
    let s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.PENDING, direction: 1, amount: pricing.amount, deposit: pricing.deposit, asset: '1' });
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(takerUsdc - pricing.deposit);
    expect(takerStep({ swap: s, now: await w.now() })).toMatchObject({ do: 'wait', on: 'funding' });
    expect((await w.maker()).openPending).toBe(1);

    // ---- maker: fund with a fresh share, bound to the take it examined
    expect(makerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'approval-decision' });
    const share = w.newShare();
    let d = makerStep({ swap: s, now: await w.now(), approval: { approve: true } });
    expect(d).toMatchObject({ do: 'call', call: { name: 'fund' }, row: 'B5' });
    await w.exec(s, d, {}, { makerShare: { ...solanaMakerShare(share, base58Decode(w.makerPda)), spendPub: share.spendPub, view: share.view } });
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.ACTIVE);
    expect(hex(s.lockerView)).toBe(hex(share.view));
    expect(await w.tokenBalance(w.operator.publicKey)).toBe(operatorUsdc - pricing.amount);
    expect((await w.maker()).openPending).toBe(0);

    // ---- taker: the address is shown only now; pay from an ordinary wallet; find the payment by view key
    d = takerStep({ swap: s, now: await w.now() });
    expect(d).toMatchObject({ do: 'offchain', action: 'show-address' });
    const joint = swapJointAddress(s, plan.keys.view, 'regtest');
    const fromHeight = await xmr.chainHeight();
    const paidTxid = await xmr.pay(joint.address, s.xmr);
    const found = await findDeposits({ node: xmr.NODE_A, viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), fromHeight });
    expect(found.found).toEqual([{ txid: paidTxid, inPool: true, blockHeight: null, amount: s.xmr }]);
    // The notice is posted at zero confirmations, by the session key (no wallet prompt).
    d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' }, caller: 'session' });
    await w.exec(s, d, { session }, { notice: buildNotice(s, plan.keys.encSecret, xmr.txidBytes(paidTxid), plan.keys.view) });
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.NOTICED);
    expect(s.flags & SWAP_FLAG.LATE_NOTICE).toBe(0);

    // ---- maker: decrypt, verify on both nodes at the swap's depth, re-check the commitments, set ready
    expect(makerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'notice-opening' });
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    expect(hex(opened.txid)).toBe(paidTxid);
    const makerJoint = swapJointAddress(s, opened.view, 'regtest');
    expect(makerJoint.address).toBe(joint.address);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(paidTxid, jointKeys(makerJoint), s.xmr, s.depth, 'confirmed');
    expect(makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) })).toEqual({ do: 'need', fact: 'commitment-check' });
    const dl = deadlinesOf('solana', s);
    await w.warpTo(dl.tReadyMin!);
    d = makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock), commitmentsOk: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'set_ready' }, row: 'B7' });
    await w.exec(s, d, {});
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.READY);

    // ---- taker: claim with the session key; it receives amount − fee and its deposit back
    d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, caller: 'session', row: 'B10a', secret: true });
    await w.exec(s, d, { session }, { secret: plan.keys.spend });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(takerUsdc + pricing.amount - pricing.fee);
    // The session key was swept to the taker by the claim.
    expect(await w.balance(session.publicKey)).toBe(0n);
    expect(takerStep({ swap: s, now: await w.now(), paid: true })).toEqual({ do: 'done', outcome: 'completed' });

    // ---- maker: the taker's share is in the account; sweep the XMR, then close the account
    expect(makerStep({ swap: s, now: await w.now() })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    const spendKey = jointSpendKey(s, share.spend, 'maker');
    const swept = await xmr.sweep({ spendKey, viewKey: makerJoint.viewPriv, lock, txid: paidTxid });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);
    d = makerStep({ swap: s, now: await w.now(), swept: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'close_swap' }, caller: 'operator' });
    await w.exec(s, d, {});
    expect(await w.swap(plan.swapPda)).toBe(null);
    const m = await w.maker();
    expect(m.counters[COUNTER.takes]).toBe(1);
    expect(m.volume[1]).toBe(pricing.amount);
  });
});

describe('refund paths (direction A)', () => {
  it('keyless refund: no notice by the deadline, a stranger sends it, the account closes; the polling watcher sees every step', async () => {
    const changes: [number | null, number | null][] = [];
    const watcher = w.client.watchSwaps({ taker: w.taker.publicKey }, (c) => changes.push([c.previous?.state ?? null, c.swap?.state ?? null]));
    await watcher.poll();
    const baseline = changes.length;
    const before = await w.balance(w.taker.publicKey);
    const { plan, s, session, pricing } = await lockA(0, X);
    await watcher.poll();
    expect(changes.slice(baseline)).toEqual([[null, SWAP_STATE.ACTIVE]]);
    const dl = deadlinesOf('solana', s);
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'wait', on: 'notice', until: dl.tNote });
    // One second early the program refuses the keyless refund.
    await w.warpTo(dl.tNote! - 1n);
    const ix = solanaInstruction(w.client.program, s, await w.maker(), w.stranger.publicKey, { name: 'refund_unnoticed' });
    await expect(w.send([ix], [w.stranger])).rejects.toMatchObject({ code: 'TooEarly' });
    await w.warpTo(dl.tNote!);
    const d = takerStep({ swap: s, now: await w.now() });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund_unnoticed' }, caller: 'anyone', secret: false });
    const strangerBefore = await w.balance(w.stranger.publicKey);
    const sig = await w.exec(s, d, {});
    // A "closed" row closes the account in the same instruction: everything is back with the taker.
    expect(await w.swap(plan.swapPda)).toBe(null);
    expect((await w.client.eventsOf(sig)).map((e) => e.name)).toContain('RefundedKeyless');
    expect((await w.maker()).counters[COUNTER.missed_notices]).toBe(1);
    // The taker is out only its fees and the session budget still on the session key; the stranger paid one fee.
    const sessionLeft = await w.balance(session.publicKey);
    expect(sessionLeft).toBe(plan.sessionLamports);
    const out = before - (await w.balance(w.taker.publicKey));
    expect(out).toBe(plan.sessionLamports + 5_000n);
    expect(pricing.amount > out).toBe(true);
    expect(strangerBefore - (await w.balance(w.stranger.publicKey))).toBe(5_000n);
    await watcher.poll();
    await watcher.poll();
    expect(changes.slice(baseline)).toEqual([[null, SWAP_STATE.ACTIVE], [SWAP_STATE.ACTIVE, null]]);
    expect(takerStep({ swap: { ...s, state: 0 }, now: await w.now() })).toEqual({ do: 'done', outcome: 'closed' });
  });

  it('cancel after approval: the deposit is held 30 minutes, then anyone returns it', async () => {
    const takerBefore = await w.balance(w.taker.publicKey);
    const { plan, s: s0, session, pricing } = await lockA(0, X);
    let d = takerStep({ swap: s0, now: await w.now(), cancel: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10a', caller: 'session' });
    // A wrong secret never leaves the SDK…
    expect(() => solanaInstruction(w.client.program, s0, { operator: w.operator.publicKey, payout: w.payout.publicKey }, session.publicKey, { name: 'refund' }, { secret: new Uint8Array(32).fill(1) })).toThrow(/ScalarMismatch/);
    await w.exec(s0, d, { session }, { secret: plan.keys.spend });
    let s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    expect(s.flags & (SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER)).toBe(SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER);
    expect(hex(s.revealed)).toBe(hex(plan.keys.spend));
    const dl = deadlinesOf('solana', s);
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'wait', on: 'deposit-hold', until: dl.tHold });
    // The maker does not withhold. At T_hold a stranger cranks the release.
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'prepared' })).toEqual({ do: 'wait', on: 'deposit-hold', until: dl.tHold });
    await w.warpTo(dl.tHold!);
    d = takerStep({ swap: s, now: await w.now() });
    expect(d).toMatchObject({ do: 'call', call: { name: 'release_deposit' }, caller: 'anyone' });
    // …and after T_hold the program refuses a withhold even though nobody has released yet.
    const late = solanaInstruction(w.client.program, s, await w.maker(), w.operator.publicKey, { name: 'withhold', evidence: 'absent' });
    await expect(w.send([late], [w.operator])).rejects.toMatchObject({ code: 'TooLate' });
    await w.exec(s, d, {});
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RETURNED, outcome: COUNTER.deposits_returned });
    const m = await w.maker();
    expect([m.counters[COUNTER.taker_cancels_approved], m.counters[COUNTER.deposits_returned]]).toEqual([1, 1]);
    // The whole amount came back, and the refund swept the session key: the taker is out two fees (its lock,
    // and the refund the session key paid from its budget) and the swap account's rent (returned at close).
    expect(pricing.deposit > 0n).toBe(true);
    expect(await w.balance(session.publicKey)).toBe(0n);
    expect(takerBefore - (await w.balance(w.taker.publicKey))).toBe(10_000n + (await w.transport.getMinimumBalanceForRentExemption(736)));
    // After a refund the operator may close; the rent goes to the taker.
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'prepared' });
    expect(d).toMatchObject({ do: 'call', call: { name: 'close_swap' }, caller: 'operator' });
    await w.exec(s, d, {});
    expect(await w.swap(plan.swapPda)).toBe(null);
    expect(takerBefore - (await w.balance(w.taker.publicKey))).toBe(10_000n);
  });

  it('keyed refund after a notice, resumed from the recovery file; the maker withholds with evidence, recovers its XMR, then releases', async () => {
    await w.publishOffer({ asset: 1, direction: 0, mode: 0, price: 150_000_000n });
    // The recovery file is saved before the lock; here it is the passphrase-encrypted form.
    const fileText = writeRecoveryFile(encryptRecoveryFile(createRecoveryFile({ seed: takerSeed, wallets: { solana: [w.taker.publicKey] }, programId: DEV_PROGRAM_ID, contract: '0x0000000000000000000000000000000000000000' }), 'hunter2'));
    const usdcBefore = await w.tokenBalance(w.taker.publicKey);
    const { plan, s: active, share, pricing } = await lockA(1, 2n * X);
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(usdcBefore - pricing.amount);
    const { s: noticed, txid, joint } = await makerNotices(active, share);
    await xmr.settle(1);

    // ---- a new browser profile: nothing but the recovery file and the wallet address
    const file = readRecoveryFile(fileText);
    const seed = recoverySeed(file, 'hunter2');
    const mine = await w.client.listSwapsByTaker(file.wallets.solana[0]!);
    const open = mine.filter((x) => x.state !== SWAP_STATE.DONE);
    expect(open.length).toBe(1);
    let s = open[0]!;
    expect(hex(s.swapRef)).toBe(hex(noticed.swapRef));
    const keys = resumeSwapKeys(seed, 'solana', s.swapNonce);
    expect(hex(keys.spendPub)).toBe(hex(s.takerSpendPub));
    const session = seedSigner(keys.sessionSecret);
    expect(session.publicKey).toBe(s.sessionKey);
    // The notice decrypts with the maker key stored in the swap; the lock is real but only one block deep.
    const opened = openNotice(s, keys.encSecret)!;
    expect(hex(opened.txid)).toBe(txid);
    const takerJoint = swapJointAddress(s, opened.view, 'regtest');
    const shallow = await xmr.verifyUntil(txid, jointKeys(takerJoint), s.xmr, s.depth, 'confirming');
    const dl = deadlinesOf('solana', s);
    expect(takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(shallow) })).toMatchObject({ do: 'wait', on: 'xmr-confirmations', until: dl.tCut });
    // At T_cut the tab refunds by itself with the session key.
    await w.warpTo(dl.tCut!);
    let d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(shallow) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund' }, caller: 'session', row: 'A10b', notAfter: dl.tCo! - 300n });
    await w.exec(s, d, { session }, { secret: keys.spend });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(usdcBefore - pricing.deposit);
    expect(await w.balance(session.publicKey)).toBe(0n);

    // ---- maker: withhold inside the hold, with the opening of its notice as evidence
    const evidence = { txid: xmr.txidBytes(txid), view: share.view };
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withhold: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'withhold', evidence: 'opens' } });
    // Evidence that does not open the commitment: refused by the SDK, and by the program if sent anyway.
    expect(() => solanaInstruction(w.client.program, s, { operator: w.operator.publicKey, payout: w.payout.publicKey }, w.operator.publicKey, { name: 'withhold', evidence: 'opens' }, { evidence: { txid: evidence.txid, view: share.spend } })).toThrow(/EvidenceMismatch/);
    await expect(w.send([w.client.program.withhold({ caller: w.operator.publicKey, swap: plan.swapPda, maker: w.makerPda, evidence: { txid: evidence.txid, view: share.spend } })], [w.operator])).rejects.toMatchObject({ code: 'EvidenceMismatch' });
    await expect(w.send([w.client.program.withhold({ caller: w.operator.publicKey, swap: plan.swapPda, maker: w.makerPda, evidence: null })], [w.operator])).rejects.toMatchObject({ code: 'EvidenceRequired' });
    await w.exec(s, d, {}, { evidence });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.WITHHELD, depositState: DEPOSIT_STATE.WITHHELD });
    expect(s.flags & SWAP_FLAG.EVIDENCE).toBeTruthy();
    expect([hex(s.evidenceTxid), hex(s.evidenceView)]).toEqual([txid, hex(share.view)]);

    // ---- maker: the taker's refund revealed its share; the XMR comes back with the combined key
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed' })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    const lock = await xmr.verifyUntil(txid, jointKeys(joint), s.xmr, 1, 'confirmed');
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, share.spend, 'maker'), viewKey: joint.viewPriv, lock, txid });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);

    // ---- maker: release on request; the deposit returns to the taker, never to the maker
    const operatorUsdc = await w.tokenBalance(w.operator.publicKey);
    const payoutUsdc = await w.tokenBalance(w.payout.publicKey);
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', swept: true, release: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'release_deposit' }, caller: 'operator' });
    await w.exec(s, d, {});
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RELEASED, outcome: COUNTER.releases });
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(usdcBefore);
    expect([await w.tokenBalance(w.operator.publicKey), await w.tokenBalance(w.payout.publicKey)]).toEqual([operatorUsdc, payoutUsdc]);
    const m = await w.maker();
    expect([m.counters[COUNTER.taker_refunds_noticed], m.counters[COUNTER.withholds], m.counters[COUNTER.releases]]).toEqual([1, 1, 1]);
    expect(m.withheldVolume[1]).toBe(pricing.deposit);
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'done', outcome: 'refunded' });
  });
});

describe('claim without ready', () => {
  it('the taker never returns: after the claim delay the maker claims, and the XMR is still the taker\'s to sweep', async () => {
    const { plan, s: active, share, pricing } = await lockA(0, X);
    const { s, txid, joint } = await makerNotices(active, share);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    const dl = deadlinesOf('solana', s);
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) })).toEqual({ do: 'wait', on: 'ready', until: dl.tCo });
    // One second before T_co the claim is refused; the SDK learns it from the simulation and sends nothing.
    await w.warpTo(dl.tCo! - 1n);
    const early = solanaInstruction(w.client.program, s, await w.maker(), w.operator.publicKey, { name: 'claim' }, { secret: share.spend });
    await expect(w.send([early], [w.operator])).rejects.toMatchObject({ code: 'TooEarly' });
    expect((await w.swap(plan.swapPda))!.flags & SWAP_FLAG.REVEALED).toBe(0);
    await w.warpTo(dl.tCo!);
    // The taker's own refund window is over by now.
    expect(takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) })).toMatchObject({ do: 'wait', warning: 'refund-window-missed' });
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11b' });
    const payoutBefore = await w.balance(w.payout.publicKey);
    await w.exec(s, d, {}, { secret: share.spend });
    const done = (await w.swap(plan.swapPda))!;
    expect(done).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.claims_without_ready });
    expect(await w.balance(w.payout.publicKey)).toBe(payoutBefore + pricing.amount - pricing.fee);
    // The taker comes back later with nothing but chain state and its seed.
    expect(takerStep({ swap: done, now: await w.now() })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    const keys = resumeSwapKeys(takerSeed, 'solana', done.swapNonce);
    const opened = openNotice(done, keys.encSecret)!;
    const takerJoint = swapJointAddress(done, opened.view, 'regtest');
    const swept = await xmr.sweep({ spendKey: jointSpendKey(done, keys.spend, 'taker'), viewKey: takerJoint.viewPriv, lock, txid: hex(opened.txid) });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);
  });
});

describe('taker-bound quote and advance approval', () => {
  it('an oversized swap against a posted quote: read and checked by the client, single use', async () => {
    const maker = await w.maker();
    const share = w.newShare();
    const now = await w.now();
    const xmrAmount = 2000n * X; // above the offer's max_xmr
    const quoteId = 9001n;
    const terms = { quoteId, taker: w.taker.publicKey, asset: 0, direction: 0, depth: 25, xmr: xmrAmount, amount: 280_000_000_000n, depBps: 50, wN: 600, dC: 6060, wC: 1800, wF: 604_800, makerSpendPub: share.spendPub, makerPok: solanaMakerShare(share, base58Decode(w.makerPda)).pok, expiresAt: now + 100n };
    await w.svm.airdrop(w.taker.publicKey, 400_000_000_000n);
    await w.send([w.client.program.postQuote(w.operator.publicKey, w.makerPda, terms)], [w.operator]);
    // The quote_response only names the account; the client reads it and checks it is what it asked for.
    const quote = (await w.client.getQuote(w.makerPda, quoteId))!;
    const want = { makerPda: w.makerPda, taker: w.taker.publicKey, asset: 0, direction: 0, xmr: xmrAmount, quoteId, now };
    expect(solQuoteProblem(quote, maker, want)).toBe(null);
    expect(solQuoteProblem(quote, maker, { ...want, taker: w.stranger.publicKey })).toBe('QuoteMismatch');
    const plan = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: xmrAmount, source: { quote }, rentExemptMinimum: w.rent0 });
    await w.send(plan.instructions, [w.taker]);
    const s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, mode: 3, amount: 280_000_000_000n, deposit: 1_400_000_000n, depth: 25, xmr: xmrAmount });
    expect(hex(s.makerSpendPub)).toBe(hex(share.spendPub));
    // Consumed and closed: it cannot be used twice.
    expect(await w.client.getQuote(w.makerPda, quoteId)).toBe(null);
    const again = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: xmrAmount, source: { quote }, rentExemptMinimum: w.rent0 });
    await expect(w.send(again.instructions, [w.taker])).rejects.toBeInstanceOf(ProgramError);
    expect(await w.swap(again.swapPda)).toBe(null);
    // An expired quote is refused by the program, and by the client before that.
    const stale = { ...terms, quoteId: 9002n, makerSpendPub: w.newShare().spendPub, expiresAt: (await w.now()) + 50n };
    stale.makerPok = solanaMakerShare(w.shares.get(hex(stale.makerSpendPub))!, base58Decode(w.makerPda)).pok;
    await w.send([w.client.program.postQuote(w.operator.publicKey, w.makerPda, stale)], [w.operator]);
    const q2 = (await w.client.getQuote(w.makerPda, 9002n))!;
    await w.svm.warp(51);
    expect(solQuoteProblem(q2, maker, { ...want, quoteId: 9002n, now: await w.now() })).toBe('QuoteExpired');
    const late = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: xmrAmount, source: { quote: q2 }, rentExemptMinimum: w.rent0 });
    await expect(w.send(late.instructions, [w.taker])).rejects.toMatchObject({ code: 'QuoteExpired' });
    // The taker walks away from the big swap: cancel after approval (the maker never noticed).
    const session = seedSigner(plan.keys.sessionSecret);
    await w.exec(s, takerStep({ swap: s, now: await w.now(), cancel: true }), { session }, { secret: plan.keys.spend });
    expect((await w.swap(plan.swapPda))!.state).toBe(SWAP_STATE.HOLD);
  });

  it('an advance approval requested and delivered over on-chain messages, then presented with the lock', async () => {
    // The offer now requires an advance approval.
    await w.publishOffer({ asset: 0, direction: 0, mode: 2, price: 150_000_000n });
    const maker = await w.maker();
    const offer = (await w.client.getOffer(w.makerPda, 0, 0))!;
    const base = { program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: X, source: { offer }, rentExemptMinimum: w.rent0 };
    const refused = planSolanaOpen(base);
    await expect(w.send(refused.instructions, [w.taker])).rejects.toMatchObject({ code: 'ApprovalRequired' });

    // ---- taker: approval_request to the maker PDA with post_message, under its per-maker contact key
    const contact = contactKeys(takerSeed, w.makerPda);
    const request = sealToMaker({ message: { t: 'approval_request', chain: 'solana', taker: w.taker.publicKey, market: 'sol', direction: 'A', max_xmr: (5n * X).toString(), reply_to: w.taker.publicKey }, ownEncSecret: contact.encSecret, maker, transport: 'solana' });
    await w.send([w.client.program.postMessage(w.taker.publicKey, w.makerPda, request)], [w.taker]);

    // ---- maker: its inbox watcher polls the PDA, decrypts, signs an approval and replies to the taker's address
    const inbox: { sender: string; payload: Uint8Array }[] = [];
    const makerInbox = w.client.watchMessages(w.makerPda, (m) => inbox.push(m));
    await makerInbox.poll();
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.sender).toBe(w.taker.publicKey);
    const got = openFromTaker({ envelope: inbox[0]!.payload, maker, secretFor: (v) => (v === maker.encKeyVersion ? w.makerEnc.encSecret : null), now: await w.now(), transport: 'solana' });
    expect(got.message).toMatchObject({ t: 'approval_request', taker: w.taker.publicKey });
    const config = (await w.client.getConfig())!;
    const now = await w.now();
    const signed = signSolApproval(OPERATOR_SEED, { clusterTag: config.clusterTag, programId: base58Decode(DEV_PROGRAM_ID), maker: base58Decode(w.makerPda), taker: base58Decode(w.taker.publicKey), asset: 255, direction: 0, maxXmr: 5n * X, notBefore: now, expiresAt: now + 86_400n, epoch: maker.approvalEpoch, approvalId: 7n });
    const reply = sealToTaker({ message: solApprovalResponse(signed), makerEncSecret: w.makerEnc.encSecret, makerKeyVersion: got.header.makerKeyVersion, takerPub: got.header.takerPub, operatorSeed: OPERATOR_SEED, transport: 'solana' });
    await w.send([w.client.program.postMessage(w.operator.publicKey, w.taker.publicKey, reply)], [w.operator]);

    // ---- taker: read the reply from its own address, verify the operator's signature, rebuild and check the approval
    const replies: Uint8Array[] = [];
    const takerInbox = w.client.watchMessages(w.taker.publicKey, (m) => replies.push(m.payload));
    await takerInbox.poll();
    expect(replies.length).toBe(1);
    const response = openFromMaker({ envelope: replies[0]!, ownEncSecret: contact.encSecret, maker, operatorPub: base58Decode(maker.operator), now: await w.now() }).message as ApprovalResponse;
    expect(response).toMatchObject({ t: 'approval_response', ok: true, chain: 'solana' });
    if (!response.ok || response.chain !== 'solana') throw new Error('unexpected response');
    const bind = { clusterTag: config.clusterTag, programId: base58Decode(DEV_PROGRAM_ID), maker: base58Decode(w.makerPda), taker: base58Decode(w.taker.publicKey), operator: base58Decode(maker.operator) };
    const approval = solApprovalFromResponse(response, bind);
    const use = { asset: 0, direction: 0, xmr: X, now: await w.now(), approvalEpoch: maker.approvalEpoch };
    expect(solApprovalProblem(approval, bind, use)).toBe(null);
    expect(solApprovalProblem(approval, bind, { ...use, xmr: 6n * X })).toBe('ApprovalInvalid');

    // Over its size limit the program refuses it too (and the SDK knew).
    const tooBig = planSolanaOpen({ ...base, xmr: 6n * X, approval });
    await expect(w.send(tooBig.instructions, [w.taker])).rejects.toMatchObject({ code: 'ApprovalInvalid' });
    // Presented by another wallet: the approval names the taker.
    const other = planSolanaOpen({ ...base, taker: w.stranger.publicKey, approval });
    await expect(w.send(other.instructions, [w.stranger])).rejects.toMatchObject({ code: 'ApprovalInvalid' });
    // A tampered signature fails in the Ed25519 precompile, before the program runs.
    const forged = { ...approval, signature: approval.signature.map((b, i) => (i === 3 ? b ^ 1 : b)) };
    expect(solApprovalProblem(forged, bind, use)).toBe('SignatureInvalid');
    await expect(w.send(planSolanaOpen({ ...base, approval: forged }).instructions, [w.taker])).rejects.toBeInstanceOf(ProgramError);

    // ---- the real lock: two signatures are paid for (the precompile's counts), the swap starts ACTIVE
    const plan = planSolanaOpen({ ...base, approval });
    const before = await w.balance(w.taker.publicKey);
    await w.send(plan.instructions, [w.taker]);
    const s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, mode: 2 });
    const rentSwap = await w.transport.getMinimumBalanceForRentExemption(736);
    expect(before - (await w.balance(w.taker.publicKey))).toBe(s.amount + plan.sessionLamports + rentSwap + 10_000n);
    // The approval is reusable until it expires…
    const second = planSolanaOpen({ ...base, approval });
    await w.send(second.instructions, [w.taker]);
    expect((await w.swap(second.swapPda))!.state).toBe(SWAP_STATE.ACTIVE);
    // …or until the maker bumps its approval epoch.
    await w.send([w.client.program.bumpEpochs(w.operator.publicKey, w.makerPda, true, false)], [w.operator]);
    const dead = planSolanaOpen({ ...base, approval });
    await expect(w.send(dead.instructions, [w.taker])).rejects.toMatchObject({ code: 'ApprovalInvalid' });
    expect(solApprovalProblem(approval, bind, { ...use, approvalEpoch: (await w.maker()).approvalEpoch })).toBe('ApprovalInvalid');
    // Later polls deliver nothing twice.
    await makerInbox.poll();
    await takerInbox.poll();
    expect([inbox.length, replies.length]).toEqual([1, 1]);
    // Both open swaps are abandoned by the maker (no notice): the keyless refund returns them.
    for (const p of [plan, second]) {
      const open = (await w.swap(p.swapPda))!;
      await w.warpTo(deadlinesOf('solana', open).tNote!);
      await w.exec(open, takerStep({ swap: open, now: await w.now() }), {});
      expect(await w.swap(p.swapPda)).toBe(null);
    }
  });
});
