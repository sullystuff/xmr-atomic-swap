// Ethereum integration (M2): the SDK against the real contract (WP3) on a local anvil, deployed
// by the anvil-only forge script, with real XMR on the Monero regtest. Loopback only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DerivedKeys, type EthQuote, type JointAddress, init } from '@xmrswap/core-wasm';
import { type Address, COUNTER, DEPOSIT_STATE, type Hex, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import type { PrivateKeyAccount } from 'viem/accounts';
import { privateKeyToAccount } from 'viem/accounts';
import { ContractError, type DecodedEthEvent, ethSessionBudget } from '../../src/ethereum/client.js';
import { ethereumCall } from '../../src/flows/execute.js';
import { buildNotice, checkCounterpartyShare, expectedOpen, jointSpendKey, newSwapNonce, openNotice, secretOpens, swapJointAddress, takerSwapKeys } from '../../src/flows/keys.js';
import { makerStep } from '../../src/flows/maker.js';
import { type EthereumOpenPlan, planEthereumOpen } from '../../src/flows/open.js';
import { takerStep } from '../../src/flows/taker.js';
import { type SwapView, deadlinesOf } from '../../src/machine/view.js';
import { fetchPool, fetchProof, leafArgument, pickLeaf, uploadOwnProof, verifyFundedShare, verifyTakerShare } from '../../src/messages/blobs.js';
import { findDeposits } from '../../src/monero/watch.js';
import { createRecoveryFile, readRecoveryFile, recoverySeed, resumeSwapKeys, writeRecoveryFile } from '../../src/recovery/file.js';
import { priceEthQuote } from '../../src/registry/pricing.js';
import { effectiveSolanaLink } from '../../src/registry/reputation.js';
import { ethApprovalProblem, ethQuoteDigest, ethApprovalDigest, ethQuoteProblem, quoteMessage, approvalMessage, signEthApproval, signEthQuote } from '../../src/signing/eip712.js';
import { hex, hex0x, unhex } from '../../src/util.js';
import { ETH_NATIVE, type EthWorld, startEthereum } from './eth.js';
import * as xmr from './xmr.js';

let w: EthWorld;
const X = xmr.XMR;
const takerSeed = new Uint8Array(32).fill(43);
const zero20 = new Uint8Array(20);
const BUDGET = ethSessionBudget(5_000_000_000n);
let quoteCounter = 100n;
const events: DecodedEthEvent[] = [];

beforeAll(async () => {
  await init();
  w = await startEthereum();
  await xmr.funded();
});
afterAll(async () => {
  await w?.stop();
});

const takerAddr = () => w.taker.address.toLowerCase() as Address;
const makerAddr = () => w.owner.address.toLowerCase() as Address;
const jointKeys = (j: JointAddress) => ({ viewPriv: hex(j.viewPriv), spendPub: hex(j.spendPub) });

/** The maker signs a quote: 170 s of validity, depth 2, 1% deposit, the Ethereum bounds of SPEC 3.1. */
async function signQuote(over: Partial<EthQuote> & { direction: 0 | 1 }): Promise<{ q: EthQuote; sig: Uint8Array }> {
  const m = await w.maker();
  const token = over.token ?? unhex(ETH_NATIVE);
  const usdc = hex0x(token) === w.usdc;
  const q: EthQuote = {
    maker: unhex(makerAddr()), taker: zero20, token, approvalMode: 0, minXmr: X / 100n, maxXmr: 1000n * X,
    tierXmr: [0n, 0n, 0n], tierPrice: [usdc ? 150_000_000n : 60_000_000_000_000_000n, 0n, 0n], depthXmr: [0n, 0n, 0n], depth: [2, 0, 0],
    depositBps: 100, approvalWindow: 600, noticeWindow: 1800, claimDelay: 7200, claimWindow: 5400, finalWindow: 604_800,
    validUntil: (await w.now()) + 170n, epoch: m.quoteEpoch, keyRoot: over.direction === 0 ? w.newPool(2) : new Uint8Array(32), quoteId: ++quoteCounter, ...over,
  };
  return { q, sig: await signEthQuote(w.operatorKey, w.deployment, q) };
}

/** Everything a taker does before and at `lock`: check the quote, the pool, the leaf's proof; upload its own; lock. */
async function lockA(q: EthQuote, sig: Uint8Array, xmrAmount: bigint, extra: { approval?: { approval: import('@xmrswap/core-wasm').EthApproval; sig: Uint8Array } } = {}) {
  const m = await w.maker();
  expect(await ethQuoteProblem(w.deployment, q, sig, m, { now: await w.now(), direction: 0, sender: takerAddr(), cancelled: await w.client.isQuoteCancelled(makerAddr(), q.quoteId, 'latest') })).toBe(null);
  const pool = await fetchPool(w.http, q.keyRoot);
  const leaf = await pickLeaf(pool, { isKeyUsed: (k) => w.client.isKeyUsed(makerAddr(), k, 'latest') });
  const swapNonce = newSwapNonce();
  const keys = takerSwapKeys(takerSeed, 'ethereum', swapNonce);
  // The UI refuses to lock without a verified proof for the maker's share; then it uploads its own.
  await fetchProof(w.http, { spendPub: leaf.spendPub, keyAddr: leaf.key, keyAddr2: leaf.key2 }, [keys.spendPub]);
  await uploadOwnProof(w.http, keys.spend);
  const plan = planEthereumOpen({ contract: w.client.contract, taker: takerAddr(), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, swapNonce, xmr: xmrAmount, leaf: leafArgument(pool, leaf), sessionBudget: BUDGET, ...extra });
  if (hex0x(q.token) === w.usdc) await w.usdcApprove(w.taker, plan.amount);
  const tx = await w.send(plan.call, w.taker);
  return { plan, tx, session: privateKeyToAccount(hex0x(plan.keys.sessionSecret)), s: (await w.swap(plan.swapId))! };
}

/** The maker's side of a pending swap: verify the taker's proof against storage, then approve the lock it examined. */
async function makerApproves(s: SwapView): Promise<{ s: SwapView; share: DerivedKeys }> {
  expect(makerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'dleq-proof' });
  verifyTakerShare(w.blobs.get(hex(s.takerSpendPub))!, s, [...w.shares.values()].map((k) => k.spendPub));
  expect(hex(s.makerEncKey)).toBe(hex(w.makerEnc.encPub));
  const d = makerStep({ swap: s, now: await w.now(), takerProofOk: true, approval: { approve: true } });
  expect(d).toMatchObject({ do: 'call', call: { name: 'approve' }, row: 'A2' });
  await w.exec(s, d, {});
  const active = (await w.swap(s.swapRef))!;
  expect(active.state).toBe(SWAP_STATE.ACTIVE);
  return { s: active, share: w.shares.get(hex(active.makerSpendPub))! };
}

/** Direction A, maker side: build the XMR lock, post the notice, and only then relay. */
async function makerNotices(s: SwapView, share: DerivedKeys): Promise<{ s: SwapView; txid: string; joint: JointAddress }> {
  checkCounterpartyShare(s.takerSpendPub, share.spendPub);
  const joint = swapJointAddress(s, share.view, 'regtest');
  const lockTx = await xmr.prepareTransfer(joint.address, s.xmr);
  const d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
  expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' } });
  await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, xmr.txidBytes(lockTx.txid), share.view) });
  const noticed = (await w.swap(s.swapRef))!;
  expect(noticed.state).toBe(SWAP_STATE.NOTICED);
  await xmr.relay(lockTx.txHex);
  return { s: noticed, txid: lockTx.txid, joint };
}

describe('deployment', () => {
  it('is anvil on loopback; the contract hashes quotes and approvals exactly as the SDK does', async () => {
    await w.client.verifyChainId(31337);
    await expect(w.client.verifyChainId(1)).rejects.toMatchObject({ code: 'WrongChain' });
    expect(await w.client.usdc('latest')).toBe(w.usdc);
    expect(await w.client.read<string>('version', [], 'latest')).toBe('1');
    const { q } = await signQuote({ direction: 0 });
    expect(await w.client.read<Hex>('hashQuote', [quoteMessage(q)], 'latest')).toBe(ethQuoteDigest(w.deployment, q));
    const a = { maker: unhex(makerAddr()), taker: unhex(takerAddr()), token: unhex(w.usdc), direction: 255, maxXmr: 5n * X, notBefore: 1n, validUntil: 2n, epoch: 0, approvalId: new Uint8Array(32).fill(9) };
    expect(await w.client.read<Hex>('hashApproval', [approvalMessage(a)], 'latest')).toBe(ethApprovalDigest(w.deployment, a));
    // The registry: the maker record, its operator, and its pointer at a Solana owner key.
    const m = await w.maker();
    expect(m).toMatchObject({ operator: w.operator.address.toLowerCase(), payout: w.payout.address.toLowerCase(), paused: false, openPending: 0 });
    expect(hex(effectiveSolanaLink({ address: makerAddr(), ...m }, await w.now())!)).toBe('07'.repeat(32));
    expect(await w.client.getMaker(w.stranger.address.toLowerCase() as Address, 'latest')).toBe(null);
  });
});

describe('buy XMR with ETH (direction A)', () => {
  it('pool leaf with a verified proof, lock, approve, finality, real XMR lock, notice, verification, ready, claim, sweep', async () => {
    const watcher = w.client.watchEvents((e) => events.push(e), { fromBlock: 0n });
    const { q, sig } = await signQuote({ direction: 0 });
    const xmrAmount = 2n * X;
    const pricing = priceEthQuote(q, xmrAmount);
    const takerBefore = await w.balance(w.taker.address);

    // ---- taker: lock. Every Ethereum swap starts PENDING.
    const { plan, tx: lockHash, session, s: pending } = await lockA(q, sig, xmrAmount);
    expect(pending).toMatchObject({ state: SWAP_STATE.PENDING, direction: 0, amount: pricing.amount, deposit: pricing.deposit, xmr: xmrAmount, depth: 2, taker: takerAddr(), maker: makerAddr(), asset: ETH_NATIVE });
    expect(session.address.toLowerCase()).toBe(pending.sessionKey);
    expect(await w.balance(session.address)).toBe(BUDGET);
    expect(takerBefore - (await w.balance(w.taker.address)) > pricing.amount + BUDGET).toBe(true);
    // The open hash in storage is the hash of the lock as the SDK computes it.
    expect(hex(expectedOpen(pending))).toBe(hex(pending.eth!.openHash));
    expect((await w.client.swapsOf(takerAddr(), 'latest')).at(-1)).toBe(hex0x(plan.swapId));
    // Not final yet: nothing at the `finalized` tag, and the watcher (which follows `finalized`) is silent.
    expect(await w.client.isFinal(lockHash)).toBe(false);
    expect(await w.client.getSwap(plan.swapId)).toBe(null);
    await watcher.poll();
    expect(events.filter((e) => e.name === 'Locked').length).toBe(0);

    // ---- maker: verify the taker's proof, approve; then wait for finality and re-read
    const { s: active, share } = await makerApproves(pending);
    expect(await w.client.isKeyUsed(makerAddr(), active.eth!.makerKey as Address, 'latest')).toBe(true);
    await w.finalize();
    expect(await w.client.isFinal(lockHash)).toBe(true);
    const final = (await w.client.getSwap(plan.swapId))!;
    expect(final.state).toBe(SWAP_STATE.ACTIVE);
    expect(hex(final.takerSpendPub)).toBe(hex(pending.takerSpendPub));
    await watcher.poll();
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(['Locked', 'Approved']));
    expect(events.find((e) => e.name === 'Locked')!.args).toMatchObject({ swapId: hex0x(plan.swapId), amount: pricing.amount, xmr: xmrAmount });

    // ---- maker: notice first, then the XMR
    const { s: noticed, txid, joint } = await makerNotices(active, share);

    // ---- taker: decrypt, recompute the address, verify on both nodes at depth
    let s = noticed;
    const opened = openNotice(s, plan.keys.encSecret)!;
    expect(hex(opened.txid)).toBe(txid);
    const takerJoint = swapJointAddress(s, opened.view, 'regtest');
    expect(takerJoint.address).toBe(joint.address);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(txid, jointKeys(takerJoint), s.xmr, s.depth, 'confirmed');
    const dl = deadlinesOf('ethereum', s);
    expect(takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) })).toEqual({ do: 'wait', on: 'ready-minimum', until: dl.tReadyMin });
    // Too early: the revert's custom error is decoded by name, from the simulation, before anything is sent.
    await expect(w.send(w.client.contract.setReady(plan.swapId), session)).rejects.toMatchObject({ code: 'TooEarly' });
    await w.advanceTo(dl.tReadyMin!);
    let d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'set_ready' }, caller: 'session' });
    await w.exec(s, d, { session });
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.READY);

    // ---- maker: claim; the payout address is paid, the fee accrues to the treasury
    const payoutBefore = await w.balance(w.payout.address);
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed' });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11a', secret: true });
    expect(secretOpens(s, share.spend, 'claim')).toBe(true);
    await w.exec(s, d, {}, { secret: share.spend });
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(s.flags & SWAP_FLAG.REVEALED).toBeTruthy();
    expect(s.flags & SWAP_FLAG.REVEALER_LOCKER).toBe(0);
    expect(await w.balance(w.payout.address)).toBe(payoutBefore + pricing.amount - pricing.fee);
    expect(await w.client.read<bigint>('treasuryAccrued', [ETH_NATIVE], 'latest')).toBe(pricing.fee);

    // ---- taker: `revealed` (a uint256 in storage) is the maker's share in Monero's byte order
    expect(hex(s.revealed)).toBe(hex(share.spend));
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, plan.keys.spend, 'taker'), viewKey: takerJoint.viewPriv, lock, txid });
    expect(swept).toMatchObject({ published: true, jointAddress: joint.address });
    expect(await xmr.isMined(swept.txid)).toBe(true);
    // Swaps are never deleted on Ethereum: nothing to close.
    expect(takerStep({ swap: s, now: await w.now(), swept: true })).toEqual({ do: 'done', outcome: 'completed' });
    const m = await w.maker();
    expect([m.counters[COUNTER.locks], m.counters[COUNTER.approvals], m.counters[COUNTER.notices], m.counters[COUNTER.readies], m.counters[COUNTER.completed]]).toEqual([1, 1, 1, 1, 1]);
    expect(await w.client.volumeOf(makerAddr(), ETH_NATIVE, 'latest')).toEqual({ volume: pricing.amount, withheldVolume: 0n });
    // The watcher catches up once the rest is final, in order, and never reports a block twice.
    await w.finalize();
    await watcher.poll();
    await watcher.poll();
    expect(events.filter((e) => e.args.swapId === hex0x(plan.swapId)).map((e) => e.name)).toEqual(['Locked', 'Approved', 'NoticePosted', 'ReadySet', 'Claimed']);
    expect(events.find((e) => e.name === 'Claimed')!.args).toMatchObject({ counter: COUNTER.completed, paid: pricing.amount - pricing.fee, fee: pricing.fee });
  });
});

describe('sell XMR for USDC (direction B)', () => {
  it('take, fund with a verified proof for the funded share, XMR payment, notice, ready, claim, the maker sweeps', async () => {
    const { q, sig } = await signQuote({ direction: 1, token: unhex(w.usdc) });
    const xmrAmount = 3n * X;
    const pricing = priceEthQuote(q, xmrAmount);
    const takerUsdc = await w.usdcBalance(w.taker.address);
    const operatorUsdc = await w.usdcBalance(w.operator.address);

    // ---- taker: upload its proof, then take; only the deposit moves
    const swapNonce = newSwapNonce();
    const keys = takerSwapKeys(takerSeed, 'ethereum', swapNonce);
    await uploadOwnProof(w.http, keys.spend);
    const plan = planEthereumOpen({ contract: w.client.contract, taker: takerAddr(), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, swapNonce, xmr: xmrAmount, sessionBudget: BUDGET, slippageBps: 10 });
    await w.usdcApprove(w.taker, plan.deposit);
    await w.send(plan.call, w.taker);
    const session = privateKeyToAccount(hex0x(plan.keys.sessionSecret));
    let s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.PENDING, direction: 1, amount: pricing.amount, deposit: pricing.deposit, asset: w.usdc });
    expect(await w.usdcBalance(w.taker.address)).toBe(takerUsdc - pricing.deposit);

    // ---- maker: verify the taker's proof, fund with a fresh share whose own proof is already served
    verifyTakerShare(w.blobs.get(hex(s.takerSpendPub))!, s, [...w.shares.values()].map((k) => k.spendPub));
    const share = w.newShare();
    let d = makerStep({ swap: s, now: await w.now(), takerProofOk: true, approval: { approve: true } });
    expect(d).toMatchObject({ do: 'call', call: { name: 'fund' }, row: 'B5' });
    await w.usdcApprove(w.operator, s.amount);
    await w.exec(s, d, {}, { makerShare: { spendPub: share.keys.spendPub, key: share.key, key2: share.key2, view: share.keys.view } });
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.ACTIVE);
    expect(await w.usdcBalance(w.operator.address)).toBe(operatorUsdc - pricing.amount);

    // ---- taker: before showing the address, the proof for the funded share must match contract storage
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'dleq-proof' });
    const blob = await fetchProof(w.http, { spendPub: s.makerSpendPub, keyAddr: s.eth!.makerKey as Address, keyAddr2: s.eth!.makerKey2 as Address }, [keys.spendPub]);
    verifyFundedShare(blob, s);
    // Had the maker funded with twins that do not belong to the share, the page would never show the address.
    expect(() => verifyFundedShare(blob, { ...s, eth: { ...s.eth!, makerKey2: s.eth!.takerKey2 } })).toThrow(/DleqWrongKey/);
    expect(takerStep({ swap: s, now: await w.now(), makerProofOk: false })).toMatchObject({ do: 'wait', warning: 'maker-proof-invalid' });
    d = takerStep({ swap: s, now: await w.now(), makerProofOk: true });
    expect(d).toMatchObject({ do: 'offchain', action: 'show-address' });
    const joint = swapJointAddress(s, keys.view, 'regtest');
    const fromHeight = await xmr.chainHeight();
    const paidTxid = await xmr.pay(joint.address, s.xmr);
    const found = await findDeposits({ node: xmr.NODE_A, viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), fromHeight });
    expect(found.found.map((f) => [f.txid, f.amount])).toEqual([[paidTxid, s.xmr]]);
    d = takerStep({ swap: s, now: await w.now(), makerProofOk: true, paid: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' }, caller: 'session' });
    await w.exec(s, d, { session }, { notice: buildNotice(s, keys.encSecret, xmr.txidBytes(paidTxid), keys.view) });
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.NOTICED);

    // ---- maker: decrypt (the ciphertext is in storage), verify, set ready
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    expect(hex(opened.txid)).toBe(paidTxid);
    const makerJoint = swapJointAddress(s, opened.view, 'regtest');
    expect(makerJoint.address).toBe(joint.address);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(paidTxid, jointKeys(makerJoint), s.xmr, s.depth, 'confirmed');
    await w.advanceTo(deadlinesOf('ethereum', s).tReadyMin!);
    d = makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock), commitmentsOk: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'set_ready' }, row: 'B7' });
    await w.exec(s, d, {});
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.READY);

    // ---- taker: claim from the session key; amount − fee and the deposit arrive at the taker's address
    d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10a', caller: 'session' });
    await w.exec(s, d, { session }, { secret: keys.spend });
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(await w.usdcBalance(w.taker.address)).toBe(takerUsdc + pricing.amount - pricing.fee);
    expect(await w.usdcBalance(session.address)).toBe(0n);

    // ---- maker: sweep with the taker's revealed share
    expect(makerStep({ swap: s, now: await w.now() })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    expect(hex(s.revealed)).toBe(hex(keys.spend));
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, share.keys.spend, 'maker'), viewKey: makerJoint.viewPriv, lock, txid: paidTxid });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);
    expect(makerStep({ swap: s, now: await w.now(), swept: true })).toEqual({ do: 'done', outcome: 'completed' });
  });
});

describe('refund paths (direction A)', () => {
  it('keyless refund: approved, no notice by the deadline, a stranger sends it', async () => {
    const { q, sig } = await signQuote({ direction: 0 });
    const before = await w.balance(w.taker.address);
    const { plan, s: pending } = await lockA(q, sig, X);
    const { s } = await makerApproves(pending);
    const dl = deadlinesOf('ethereum', s);
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'wait', on: 'notice', until: dl.tNote });
    await w.advanceTo(dl.tNote! - 2n);
    await expect(w.send(w.client.contract.refundUnnoticed(plan.swapId), w.stranger)).rejects.toMatchObject({ code: 'TooEarly' });
    await w.advanceTo(dl.tNote!);
    const d = takerStep({ swap: s, now: await w.now() });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund_unnoticed' }, caller: 'anyone' });
    await w.exec(s, d, {});
    const done = (await w.swap(plan.swapId))!;
    // "Closed" rows end in DONE on Ethereum; the id can never be reused.
    expect(done).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.missed_notices });
    expect(done.flags & SWAP_FLAG.REVEALED).toBe(0);
    expect(takerStep({ swap: done, now: await w.now() })).toEqual({ do: 'done', outcome: 'closed' });
    // Everything but gas and the session budget is back.
    const out = before - (await w.balance(w.taker.address));
    expect(out > BUDGET && out < BUDGET + 10n ** 16n).toBe(true);
    expect((await w.maker()).counters[COUNTER.missed_notices]).toBe(1);
    await expect(w.send(plan.call, w.taker)).rejects.toBeInstanceOf(ContractError);
  });

  it('keyed refund after a notice, resumed from the recovery file; withhold with evidence, the maker recovers its XMR, release', async () => {
    const fileText = writeRecoveryFile(createRecoveryFile({ seed: takerSeed, wallets: { ethereum: [takerAddr()] }, programId: 'unused', contract: w.contract }));
    const { q, sig } = await signQuote({ direction: 0, token: unhex(w.usdc) });
    const usdcBefore = await w.usdcBalance(w.taker.address);
    const { plan, s: pending } = await lockA(q, sig, 2n * X);
    const pricing = priceEthQuote(q, 2n * X);
    expect(await w.usdcBalance(w.taker.address)).toBe(usdcBefore - pricing.amount);
    const { s: active, share } = await makerApproves(pending);
    const { txid, joint } = await makerNotices(active, share);
    await xmr.settle(1);

    // ---- a new browser profile: the recovery file, the wallet address, and contract storage (no logs)
    const file = readRecoveryFile(fileText);
    const seed = recoverySeed(file);
    const ids = await w.client.swapsOf(file.wallets.ethereum[0] as Address, 'latest');
    const mine = (await Promise.all(ids.map((id) => w.swap(unhex(id))))).filter((x): x is SwapView => x !== null && x.state !== SWAP_STATE.DONE);
    expect(mine.length).toBe(1);
    let s = mine[0]!;
    expect(hex(s.swapRef)).toBe(hex(plan.swapId));
    const keys = resumeSwapKeys(seed, 'ethereum', s.swapNonce);
    expect(hex(keys.spendPub)).toBe(hex(s.takerSpendPub));
    const session = privateKeyToAccount(hex0x(keys.sessionSecret));
    expect(session.address.toLowerCase()).toBe(s.sessionKey);
    const opened = openNotice(s, keys.encSecret)!;
    expect(hex(opened.txid)).toBe(txid);
    const takerJoint = swapJointAddress(s, opened.view, 'regtest');
    const shallow = await xmr.verifyUntil(txid, jointKeys(takerJoint), s.xmr, s.depth, 'confirming');
    const dl = deadlinesOf('ethereum', s);
    expect(takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(shallow) })).toMatchObject({ do: 'wait', on: 'xmr-confirmations', until: dl.tCut });
    await w.advanceTo(dl.tCut!);
    let d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(shallow) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund' }, caller: 'session', row: 'A10b', notAfter: dl.tCo! - 1800n });
    // A wrong secret is refused by the SDK; sent anyway, the contract answers BadSecret (decoded from revert data).
    expect(() => ethereumCall(w.client.contract, s, { name: 'refund' }, { secret: share.spend })).toThrow(/ScalarMismatch/);
    await expect(w.send(w.client.contract.refund(plan.swapId, share.spend), session)).rejects.toMatchObject({ code: 'BadSecret' });
    await w.exec(s, d, { session }, { secret: keys.spend });
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    expect(s.flags & (SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER)).toBe(SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER);
    expect(hex(s.revealed)).toBe(hex(keys.spend));
    expect(await w.usdcBalance(w.taker.address)).toBe(usdcBefore - pricing.deposit);

    // ---- maker: withhold inside the hold with the notice opening as evidence
    const evidence = { txid: xmr.txidBytes(txid), view: share.view };
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withhold: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'withhold', evidence: 'opens' } });
    await expect(w.send(w.client.contract.withhold(plan.swapId, { txid: evidence.txid, view: share.spend }), w.operator)).rejects.toMatchObject({ code: 'EvidenceMismatch' });
    await expect(w.send(w.client.contract.withhold(plan.swapId, null), w.operator)).rejects.toMatchObject({ code: 'EvidenceRequired' });
    await expect(w.send(w.client.contract.withhold(plan.swapId, evidence), w.stranger)).rejects.toMatchObject({ code: 'Unauthorized' });
    await w.exec(s, d, {}, { evidence });
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.WITHHELD, depositState: DEPOSIT_STATE.WITHHELD });
    expect([hex(s.evidenceTxid), hex(s.evidenceView)]).toEqual([txid, hex(share.view)]);
    expect(s.flags & SWAP_FLAG.EVIDENCE).toBeTruthy();

    // ---- maker: the XMR comes back with the taker's revealed share
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed' })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    const lock = await xmr.verifyUntil(txid, jointKeys(joint), s.xmr, 1, 'confirmed');
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, share.spend, 'maker'), viewKey: joint.viewPriv, lock, txid });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);

    // ---- maker: release; the deposit goes to the taker
    d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', swept: true, release: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'release_deposit' }, caller: 'operator' });
    await w.exec(s, d, {});
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RELEASED, outcome: COUNTER.releases });
    expect(await w.usdcBalance(w.taker.address)).toBe(usdcBefore);
    const m = await w.maker();
    expect([m.counters[COUNTER.taker_refunds_noticed], m.counters[COUNTER.withholds], m.counters[COUNTER.releases]]).toEqual([1, 1, 1]);
    expect((await w.client.volumeOf(makerAddr(), w.usdc, 'latest')).withheldVolume).toBe(pricing.deposit);
  });

  it('cancel after approval: the deposit is held, and anyone returns it at T_hold', async () => {
    const { q, sig } = await signQuote({ direction: 0 });
    const { plan, s: pending, session } = await lockA(q, sig, X);
    const { s: active } = await makerApproves(pending);
    await w.exec(active, takerStep({ swap: active, now: await w.now(), cancel: true }), { session }, { secret: plan.keys.spend });
    let s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.HOLD);
    const dl = deadlinesOf('ethereum', s);
    await expect(w.send(w.client.contract.releaseDeposit(plan.swapId), w.stranger)).rejects.toMatchObject({ code: 'TooEarly' });
    await w.advanceTo(dl.tHold!);
    await expect(w.send(w.client.contract.withhold(plan.swapId, null), w.operator)).rejects.toMatchObject({ code: 'TooLate' });
    const takerBefore = await w.balance(w.taker.address);
    await w.exec(s, takerStep({ swap: s, now: await w.now() }), {});
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RETURNED });
    expect(await w.balance(w.taker.address)).toBe(takerBefore + s.deposit);
  });
});

describe('claim without ready', () => {
  it('the taker never returns: after the claim delay the maker claims; the XMR is still the taker\'s to sweep', async () => {
    const { q, sig } = await signQuote({ direction: 0 });
    const { plan, s: pending } = await lockA(q, sig, X);
    const { s: active, share } = await makerApproves(pending);
    const { s, txid, joint } = await makerNotices(active, share);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    const dl = deadlinesOf('ethereum', s);
    await w.advanceTo(dl.tCo! - 2n);
    await expect(w.send(w.client.contract.claim(plan.swapId, share.spend), w.operator, { secret: true })).rejects.toMatchObject({ code: 'TooEarly' });
    expect((await w.swap(plan.swapId))!.flags & SWAP_FLAG.REVEALED).toBe(0);
    await w.advanceTo(dl.tCo!);
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11b' });
    await w.exec(s, d, {}, { secret: share.spend });
    const done = (await w.swap(plan.swapId))!;
    expect(done).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.claims_without_ready });
    // The taker returns with its seed and contract storage only.
    const keys = resumeSwapKeys(takerSeed, 'ethereum', done.swapNonce);
    const opened = openNotice(done, keys.encSecret)!;
    const takerJoint = swapJointAddress(done, opened.view, 'regtest');
    const swept = await xmr.sweep({ spendKey: jointSpendKey(done, keys.spend, 'taker'), viewKey: takerJoint.viewPriv, lock, txid: hex(opened.txid) });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);
  });
});

describe('taker-bound quote and advance approval', () => {
  it('a quote bound to one taker is single use and useless to anyone else', async () => {
    const { q, sig } = await signQuote({ direction: 0, taker: unhex(takerAddr()), maxXmr: 5000n * X });
    const m = await w.maker();
    const use = { now: await w.now(), direction: 0, sender: takerAddr() };
    expect(await ethQuoteProblem(w.deployment, q, sig, m, use)).toBe(null);
    expect(await ethQuoteProblem(w.deployment, q, sig, m, { ...use, sender: w.stranger.address.toLowerCase() as Address })).toBe('WrongParty');
    const { plan, s } = await lockA(q, sig, 2000n * X);
    expect(s).toMatchObject({ state: SWAP_STATE.PENDING, mode: 3, xmr: 2000n * X });
    // Marked cancelled by its first use.
    expect(await w.client.isQuoteCancelled(makerAddr(), q.quoteId, 'latest')).toBe(true);
    expect(await ethQuoteProblem(w.deployment, q, sig, m, { ...use, cancelled: true })).toBe('Cancelled');
    const pool = await fetchPool(w.http, q.keyRoot);
    const again = planEthereumOpen({ contract: w.client.contract, taker: takerAddr(), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, xmr: 2000n * X, leaf: leafArgument(pool, pool.leaves[1]!), sessionBudget: BUDGET });
    await expect(w.send(again.call, w.taker)).rejects.toMatchObject({ code: 'Cancelled' });
    // A stranger presenting the same signed quote.
    const strangers = planEthereumOpen({ contract: w.client.contract, taker: w.stranger.address.toLowerCase() as Address, quote: { ...q, quoteId: q.quoteId }, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, xmr: X, leaf: leafArgument(pool, pool.leaves[1]!), sessionBudget: BUDGET });
    await expect(w.send(strangers.call, w.stranger)).rejects.toBeInstanceOf(ContractError);
    // A tampered price does not verify, on the client or on the contract.
    const tampered = { ...q, quoteId: q.quoteId + 1000n, tierPrice: [q.tierPrice[0] / 2n, 0n, 0n] as [bigint, bigint, bigint] };
    expect(await ethQuoteProblem(w.deployment, tampered, sig, m, use)).toBe('BadSigner');
    const cheap = planEthereumOpen({ contract: w.client.contract, taker: takerAddr(), quote: tampered, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, xmr: X, leaf: leafArgument(pool, pool.leaves[1]!), sessionBudget: BUDGET });
    await expect(w.send(cheap.call, w.taker)).rejects.toMatchObject({ code: 'BadSigner' });
    // The taker cancels its pending lock: a full refund at any time.
    const session = privateKeyToAccount(hex0x(plan.keys.sessionSecret));
    const d = takerStep({ swap: s, now: await w.now(), cancel: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'cancel_pending' }, caller: 'session' });
    await w.exec(s, d, { session });
    expect((await w.swap(plan.swapId))!).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.pending_cancels });
  });

  it('a quote that requires an advance approval: refused without, accepted with, dead once revoked', async () => {
    const { q, sig } = await signQuote({ direction: 0, approvalMode: 2 });
    const pool = await fetchPool(w.http, q.keyRoot);
    const open = (extra: object = {}, xmrAmount = X) => planEthereumOpen({ contract: w.client.contract, taker: takerAddr(), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, xmr: xmrAmount, leaf: leafArgument(pool, pool.leaves[0]!), sessionBudget: BUDGET, ...extra });
    await expect(w.send(open().call, w.taker)).rejects.toMatchObject({ code: 'ApprovalRequired' });

    // ---- maker: an EIP-712 approval for this taker, any token, up to 5 XMR, for a day
    const m = await w.maker();
    const now = await w.now();
    const approval = { maker: unhex(makerAddr()), taker: unhex(takerAddr()), token: unhex('0xffffffffffffffffffffffffffffffffffffffff'), direction: 255, maxXmr: 5n * X, notBefore: now, validUntil: now + 86_400n, epoch: m.approvalEpoch, approvalId: new Uint8Array(32).fill(0xa1) };
    const approvalSig = await signEthApproval(w.operatorKey, w.deployment, approval);
    const use = { now: await w.now(), sender: takerAddr(), token: ETH_NATIVE, direction: 0, xmr: X };
    expect(await ethApprovalProblem(w.deployment, approval, approvalSig, m, use)).toBe(null);
    expect(await ethApprovalProblem(w.deployment, approval, approvalSig, m, { ...use, xmr: 6n * X })).toBe('AmountOutOfRange');
    expect(await ethApprovalProblem({ ...w.deployment, chainId: 1n }, approval, approvalSig, m, use)).toBe('BadSigner');
    // The contract agrees on each refusal.
    await expect(w.send(open({ approval: { approval, sig: approvalSig } }, 6n * X).call, w.taker)).rejects.toMatchObject({ code: 'AmountOutOfRange' });
    const forged = approvalSig.slice();
    forged[5]! ^= 1;
    await expect(w.send(open({ approval: { approval, sig: forged } }).call, w.taker)).rejects.toMatchObject({ code: 'BadSigner' });
    const strangerOpen = planEthereumOpen({ contract: w.client.contract, taker: w.stranger.address.toLowerCase() as Address, quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, xmr: X, leaf: leafArgument(pool, pool.leaves[0]!), sessionBudget: BUDGET, approval: { approval, sig: approvalSig } });
    await expect(w.send(strangerOpen.call, w.stranger)).rejects.toMatchObject({ code: 'WrongParty' });

    // ---- the real lock
    const { plan, s } = await lockA(q, sig, X, { approval: { approval, sig: approvalSig } });
    expect(s).toMatchObject({ state: SWAP_STATE.PENDING, mode: 2 });
    // ---- revoked: the same approval is dead, and the client can know it from storage
    await w.send(w.client.contract.revokeApproval(approval.approvalId), w.operator);
    expect(await w.client.isApprovalRevoked(makerAddr(), approval.approvalId, 'latest')).toBe(true);
    expect(await ethApprovalProblem(w.deployment, approval, approvalSig, m, { ...use, revoked: true })).toBe('Revoked');
    await expect(w.send(open({ approval: { approval, sig: approvalSig } }).call, w.taker)).rejects.toMatchObject({ code: 'Revoked' });
    // The maker rejects the pending lock by its own choice: a full refund, counted as a rejection.
    const d = makerStep({ swap: s, now: await w.now(), takerProofOk: true, approval: { approve: false, reason: 0 } });
    expect(d).toMatchObject({ do: 'call', call: { name: 'reject', reason: 0 } });
    await w.exec(s, d, {});
    expect((await w.swap(plan.swapId))!).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.rejections });
    expect(plan satisfies EthereumOpenPlan).toBeTruthy();
  });

  it('approve, fund and reject are bound to the lock the maker examined', async () => {
    const { q, sig } = await signQuote({ direction: 0 });
    const { plan, s } = await lockA(q, sig, X);
    // An open hash of anything but the stored lock is refused with BadState.
    await expect(w.send(w.client.contract.approve(plan.swapId, new Uint8Array(32).fill(1)), w.operator)).rejects.toMatchObject({ code: 'BadState' });
    await expect(w.send(w.client.contract.reject(plan.swapId, new Uint8Array(32).fill(1), 0), w.operator)).rejects.toMatchObject({ code: 'BadState' });
    // Without a valid taker proof the daemon rejects with reason 1, which does not count against its approval rate.
    const d = makerStep({ swap: s, now: await w.now(), takerProofOk: false });
    expect(d).toMatchObject({ do: 'call', call: { name: 'reject', reason: 1 } });
    await w.exec(s, d, {});
    expect((await w.swap(plan.swapId))!).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.rejections_no_fault });
    const _unused: PrivateKeyAccount = w.taker;
    void _unused;
  });
});

describe('pay or park', () => {
  it('a blacklisted payout address parks the claim instead of reverting it; that address pulls it later', async () => {
    const { encodeFunctionData, parseAbi } = await import('viem');
    const blacklist = (who: Address, on: boolean) => w.send({ to: w.usdc, data: encodeFunctionData({ abi: parseAbi(['function setBlacklisted(address who, bool on)']), functionName: 'setBlacklisted', args: [who, on] }), value: 0n }, w.stranger);
    const { q, sig } = await signQuote({ direction: 0, token: unhex(w.usdc) });
    const pricing = priceEthQuote(q, X);
    const { plan, s: pending } = await lockA(q, sig, X);
    const { s: active, share } = await makerApproves(pending);
    // No XMR is needed to exercise the escrow: the contract only sees the notice.
    await w.exec(active, makerStep({ swap: active, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' }), {}, { notice: buildNotice(active, w.makerEnc.encSecret, new Uint8Array(32).fill(0xee), share.view) });
    let s = (await w.swap(plan.swapId))!;
    await w.advanceTo(deadlinesOf('ethereum', s).tCo!);
    const payout = w.payout.address.toLowerCase() as Address;
    const before = await w.usdcBalance(payout);
    await blacklist(payout, true);
    await w.exec(s, makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withoutReady: 'claim' }), {}, { secret: share.spend });
    s = (await w.client.getSwap(plan.swapId, 'latest', true))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.claims_without_ready });
    expect(hex(s.revealed)).toBe(hex(share.spend));
    expect(await w.usdcBalance(payout)).toBe(before);
    // Parked payouts are keyed by the account the push would have gone to: here the payout address.
    const owed = await w.client.owedFor(w.usdc, takerAddr(), makerAddr(), 'latest');
    expect(owed).toMatchObject({ taker: 0n, payout: pricing.amount - pricing.fee, operator: 0n, owner: 0n });
    expect(s.owedMaker).toBe(pricing.amount - pricing.fee);
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed' })).toMatchObject({ do: 'call', call: { name: 'withdraw_owed', who: 'maker' } });
    // Nobody else can pull it; the payout address itself does, once it can receive, to wherever it names.
    await expect(w.send(w.client.contract.withdrawOwed(w.usdc, payout), w.operator)).rejects.toMatchObject({ code: 'NothingOwed' });
    await blacklist(payout, false);
    await (await import('./eth.js')).fundForGas(w, payout);
    await w.send(ethereumCall(w.client.contract, s, { name: 'withdraw_owed', who: 'maker' }, { destination: payout })!, w.payout);
    expect(await w.usdcBalance(payout)).toBe(before + pricing.amount - pricing.fee);
    expect((await w.client.owedFor(w.usdc, takerAddr(), makerAddr(), 'latest')).payout).toBe(0n);
  });
});
