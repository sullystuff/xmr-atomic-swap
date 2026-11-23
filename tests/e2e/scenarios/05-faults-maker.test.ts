// What the real daemon does when something is wrong on its side or around it (scenarios N-1,
// N-2, D-1, P-1, F-2): a Monero node that is down, a reorg that orphans its lock, a taker that
// plays the duplicate-one-time-key trick or names a payment that does not exist, a crash in the
// middle of a swap in each direction, and a USDC payout destination that is frozen or blacklisted.
// The taker is driven through the SDK so that it can misbehave.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ata, ethereumCall, hex, moneroTx, solanaInstruction, swapJointAddress, verifyLock } from '@xmrswap/sdk';
import { NODE_A, NODE_B, REGTEST_MAX_FEE, isMined, nodeOther, nodeRpc, poolTxids, reorg, txInfo } from '../src/monero.js';
import { type Opened, SdkTaker } from '../src/taker.js';
import { XMR, e2eRoot, stateRoot, waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { balances, counterDelta, counters, deadlines, expectClean, holdings, scenario, stateName, untilPhase, untilState } from './helpers.js';

let w: World;
let taker: SdkTaker;
beforeAll(async () => {
  w = await startWorld({ inventoryBlocks: 30 });
  taker = new SdkTaker(w);
});
afterAll(async () => {
  await w?.stop();
  await stopShared();
});
beforeEach(async () => {
  if (!w.maker.running) await w.maker.start();
  w.makerNodeB.mode = 'honest';
});

const HALF = XMR / 2n;
const QUARTER = XMR / 4n;
async function to(o: Opened, t: bigint): Promise<void> {
  const now = o.chain === 'solana' ? await w.sol.now() : await w.eth!.now();
  if (t > now) await w.advance(t - now);
}
const dl = async (o: Opened) => deadlines(await taker.must(o));
const state = async (o: Opened) => {
  const s = await taker.view(o);
  return s ? stateName(s.state) : 'closed';
};
const intentsOf = async (o: Opened): Promise<string[]> => ((await w.maker.swapDetail(o.ref)).intents as { kind: string; status: string }[]).map((i) => `${i.kind}:${i.status}`);
/** Direction A to the end: the taker confirms at depth, the daemon claims, the taker sweeps. */
async function finishA(o: Opened): Promise<{ sweepTxid: string }> {
  await to(o, (await dl(o)).tReadyMin!);
  await waitFor('the lock at depth on both nodes', async () => (await taker.verify(o)).ok, { timeoutMs: 60_000 });
  await taker.call(o, { name: 'set_ready' });
  await untilState(w, o.ref, ['DONE']);
  const done = await taker.must(o);
  await w.mine(10);
  const swept = await taker.sweep(o, done);
  await w.mine(1);
  expect(await isMined(swept.txid)).toBe(true);
  expect((await w.takerWallet.received(swept.txid))!).toBe(done.xmr - swept.fee);
  return { sweepTxid: swept.txid };
}

describe('N-1: Monero trouble on the maker\'s side', () => {
  it('direction B, one of the daemon\'s nodes is down: it never sets ready on one node\'s word; when the node is back it confirms and the swap completes', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('usdc_sol', 1, QUARTER);
    await untilState(w, o.ref, 'ACTIVE');
    w.makerNodeB.mode = 'down';
    const paid = await w.takerWallet.pay(await taker.payAddress(o), QUARTER);
    await taker.postNotice(o, paid);
    await w.mine(3);
    await to(o, (await dl(o)).tReadyMin! + 60n);
    await new Promise((r) => setTimeout(r, 8000));
    // Three blocks deep on the node that answers, and still not ready: fail closed.
    expect(await state(o)).toBe('NOTICED');
    expect((await w.maker.swapDetail(o.ref)).lock_state).not.toBe('confirmed');
    w.makerNodeB.mode = 'honest';
    await untilState(w, o.ref, 'READY');
    await taker.claim(o);
    await w.mine(10);
    await waitFor('the daemon\'s sweep', async () => (await w.maker.swapDetail(o.ref)).sweep_txid, { timeoutMs: 180_000 });
    await w.mine(1);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ takes: 1, approvals: 1, notices: 1, readies: 1, completed: 1 });
  }));

});

describe('N-2: outputs to the joint address that are not the lock', () => {
  const TOOL = path.join(e2eRoot, 'tools/dupkey/target/debug/e2e-dupkey');
  const tool = (...args: string[]): any => JSON.parse(execFileSync(TOOL, args, { encoding: 'utf8' }));
  beforeAll(() => {
    if (!existsSync(TOOL)) execFileSync('cargo', ['build', '--offline'], { cwd: path.join(e2eRoot, 'tools/dupkey'), stdio: ['ignore', 'inherit', 'inherit'] });
  });

  it('a REAL second output with the lock\'s one-time key, in the lock\'s block: verifyLock calls the lock invalid on both sides, the daemon never sets ready and refunds its escrow at the cutoff', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const b0 = await balances(w, 'usdc_sol');
    // Funds for the second transaction: an output of an address whose keys the "attacker" holds, ten blocks deep.
    const fund = tool('keygen') as { spendKey: string; viewKey: string; address: string };
    w.addSecret('dupkey.spend', fund.spendKey);
    const fundTxid = await w.takerWallet.pay(fund.address, (3n * XMR) / 10n);
    await w.mine(11);
    const fundHeight = (await txInfo(fundTxid))!.height!;

    const o = await taker.open('usdc_sol', 1, QUARTER);
    await untilState(w, o.ref, 'ACTIVE');
    const s = await taker.must(o);
    const joint = swapJointAddress(s, o.keys.view, 'regtest');
    // The lock itself: built by an ordinary wallet, held back so that both transactions land in one block.
    const lock = await w.takerWallet.call<{ tx_hash: string; tx_blob: string }>('transfer', { destinations: [{ address: joint.address, amount: Number(QUARTER) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, do_not_relay: true, get_tx_hex: true });
    const mine = moneroTx.scanTx(moneroTx.parseTx(lock.tx_blob), hex(joint.viewPriv), hex(joint.spendPub));
    expect(mine).toHaveLength(1);
    const key = mine[0]!.key;
    // The second transaction: a different spender, a different transaction key, the SAME one-time output key.
    const dup = tool('build', JSON.stringify({ daemon: NODE_A, spendKey: fund.spendKey, viewKey: fund.viewKey, fundHeight, fundTxid, targetKey: key, publish: false })) as { txid: string; txHex: string; outputKey: string; outputIndex: number };
    expect(dup.outputKey).toBe(key);
    expect(dup.txid).not.toBe(lock.tx_hash);
    for (const blob of [lock.tx_blob, dup.txHex]) expect((await nodeOther<{ status: string; reason?: string }>(NODE_A, 'send_raw_transaction', { tx_as_hex: blob, do_not_relay: false })).status).toBe('OK');
    await taker.postNotice(o, lock.tx_hash);
    await w.mine(1);
    const [h1, h2] = [(await txInfo(lock.tx_hash))!.height, (await txInfo(dup.txid))!.height];
    expect(h1).not.toBeNull();
    expect(h2).toBe(h1);
    await w.mine(3);

    // Both chains of evidence: consensus accepted two outputs with one key, and the verifier refuses the lock.
    const v = await verifyLock({ nodes: [NODE_A, NODE_B], txid: lock.tx_hash, viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: s.xmr, minConf: s.depth });
    expect(v.ok).toBe(false);
    expect(v.codes).toContain('duplicate-output-key');
    expect(v.reasons.join(' ')).toContain(dup.txid);
    // The real daemon reaches the same verdict: no ready, however deep the lock gets.
    await to(o, (await dl(o)).tReadyMin! + 60n);
    await new Promise((r) => setTimeout(r, 8000));
    expect(await state(o)).toBe('NOTICED');
    expect((await w.maker.swapDetail(o.ref)).lock_state).toBe('invalid');
    // At the cutoff it takes its escrow back (B9d) and the take deposit is held.
    await to(o, (await dl(o)).tCut!);
    await untilState(w, o.ref, 'HOLD');
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.makerOperator).toBe(b0.makerOperator);
    expect(b1.taker).toBe(b0.taker - o.deposit);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ takes: 1, approvals: 1, notices: 1, refunds_unconfirmed: 1 });
    await to(o, (await dl(o)).tHold!);
    await taker.call(o, { name: 'release_deposit' }, {}, 'stranger');
    expect((await balances(w, 'usdc_sol')).taker).toBe(b0.taker);
  }));

  it('dust outputs to the joint address in the lock\'s block: the lock still verifies, and the daemon\'s sweep spends exactly the verified output', scenario(() => w, async () => {
    const o = await taker.open('usdc_sol', 1, QUARTER);
    await untilState(w, o.ref, 'ACTIVE');
    const address = await taker.payAddress(o);
    const paid = await w.takerWallet.pay(address, QUARTER);
    const dust1 = await w.takerWallet.pay(address, 1_000_000n);
    const dust2 = await w.takerWallet.pay(address, 2_000_000n);
    await taker.postNotice(o, paid);
    await w.mine(1);
    const h = (await txInfo(paid))!.height;
    expect((await txInfo(dust1))!.height).toBe(h);
    expect((await txInfo(dust2))!.height).toBe(h);
    await w.mine(2);
    await to(o, (await dl(o)).tReadyMin!);
    await untilState(w, o.ref, 'READY');
    await taker.claim(o);
    await w.mine(10);
    const d = await waitFor('the daemon\'s sweep', async () => {
      const x = await w.maker.swapDetail(o.ref);
      return x.sweep_txid ? x : null;
    }, { timeoutMs: 180_000, context: () => w.maker.swapDetail(o.ref) });
    await w.mine(1);
    expect(await isMined(d.sweep_txid)).toBe(true);
    const got = (await w.maker.wallet.received(d.sweep_txid))!;
    // Exactly the lock's output, less the fee: the dust is not in it.
    expect(got > QUARTER - REGTEST_MAX_FEE && got < QUARTER).toBe(true);
  }));
});

describe('F-2: a false notice in direction B', () => {
  it('the taker announces a payment that does not exist: the daemon refunds its escrow inside [T_cut, T_co − M]; refunds_unconfirmed; the take deposit is held', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const b0 = await balances(w, 'usdc_sol');
    const o = await taker.open('usdc_sol', 1, QUARTER);
    await untilState(w, o.ref, 'ACTIVE');
    await taker.postNotice(o, 'ab'.repeat(32));
    const d = await dl(o);
    await to(o, d.tCut! - 5n);
    await new Promise((r) => setTimeout(r, 5000));
    expect(await state(o)).toBe('NOTICED');
    await to(o, d.tCut!);
    await untilState(w, o.ref, 'HOLD');
    expect((await w.sol.now()) <= d.tCo! - d.margin).toBe(true);
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.makerOperator).toBe(b0.makerOperator);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ takes: 1, approvals: 1, notices: 1, refunds_unconfirmed: 1 });
    // The taker's claim-without-ready at T_co finds nothing to claim.
    await to(o, d.tCo!);
    await expect(taker.claim(o)).rejects.toThrow();
    await taker.call(o, { name: 'release_deposit' }, {}, 'stranger');
    expect((await balances(w, 'usdc_sol')).taker).toBe(b0.taker);
  }));
});

describe('D-1: the daemon is killed and restarted in the middle of a swap', () => {
  it('direction A, killed the instant its notice lands (before or while the XMR leaves): after the restart there is one lock transaction, one notice, and the swap completes', scenario(() => w, async () => {
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('usdc_sol', 0, HALF);
    await waitFor('the notice', async () => (await state(o)) === 'NOTICED', { intervalMs: 20, timeoutMs: 60_000 });
    await w.maker.kill();
    const poolAtCrash = await poolTxids();
    await w.maker.start();
    const d = await untilPhase(w, o.ref, 'xmr_relayed');
    const lockTxid = d.lock_txid as string;
    expect((await taker.notice(o)).txid).toBe(lockTxid);
    // Whatever reached the pool before the crash is this same transaction: nothing else left the wallet.
    expect(poolAtCrash.every((t) => t === lockTxid)).toBe(true);
    expect((await poolTxids()).filter((t) => t !== lockTxid)).toEqual([]);
    await w.mine(2);
    const intents = await intentsOf(o);
    expect(intents.filter((i) => i.startsWith('xmr_prepare'))).toEqual(['xmr_prepare:confirmed']);
    expect(intents.filter((i) => i.includes('post_notice') || i.startsWith('sol_tx')).length).toBeGreaterThanOrEqual(1);
    await finishA(o);
    // Exactly one swap's worth of XMR left the inventory.
    const spent = inv0 - (await holdings(w.maker.wallet));
    expect(spent >= HALF && spent < HALF + REGTEST_MAX_FEE).toBe(true);
    expect((await w.maker.status()).needs_review).toBe(0);
  }));

  it('direction A, killed after ready and before its claim: the restarted daemon claims inside its window', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('sol', 0, HALF);
    await untilState(w, o.ref, 'NOTICED');
    await untilPhase(w, o.ref, 'xmr_relayed');
    await w.mine(2);
    await w.maker.kill();
    await to(o, (await dl(o)).tReadyMin!);
    await taker.call(o, { name: 'set_ready' });
    await to(o, (await dl(o)).tReadyMin! + 600n);
    await w.maker.start();
    await untilState(w, o.ref, 'DONE');
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, readies: 1, completed: 1 });
    const done = await taker.must(o);
    await w.mine(10);
    const swept = await taker.sweep(o, done);
    await w.mine(1);
    expect(await isMined(swept.txid)).toBe(true);
  }));

  it('direction B, killed after funding and again after the taker\'s claim: it verifies and sets ready after the first restart and sweeps after the second', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('sol', 1, QUARTER);
    await untilState(w, o.ref, 'ACTIVE');
    await w.maker.kill();
    const paid = await w.takerWallet.pay(await taker.payAddress(o), QUARTER);
    await taker.postNotice(o, paid);
    await w.mine(2);
    await to(o, (await dl(o)).tReadyMin!);
    await w.maker.start();
    await untilState(w, o.ref, 'READY');
    await w.maker.kill();
    await taker.claim(o);
    await w.mine(10);
    await w.maker.start();
    const d = await waitFor('the daemon\'s sweep', async () => {
      const x = await w.maker.swapDetail(o.ref);
      return x.sweep_txid ? x : null;
    }, { timeoutMs: 180_000, context: () => w.maker.swapDetail(o.ref) });
    await w.mine(1);
    expect(await isMined(d.sweep_txid)).toBe(true);
    const gained = (await holdings(w.maker.wallet)) - inv0;
    expect(gained > QUARTER - REGTEST_MAX_FEE && gained < QUARTER).toBe(true);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ takes: 1, approvals: 1, notices: 1, readies: 1, completed: 1 });
    const intents = await intentsOf(o);
    expect(intents.filter((i) => i.startsWith('xmr_sweep'))).toEqual(['xmr_sweep:confirmed']);
    expect((await w.maker.status()).needs_review).toBe(0);
  }));
});

describe('P-1: the payout destination cannot receive USDC', () => {
  it('Solana: the maker\'s payout token account is frozen; the claim still succeeds and reveals the key, the payout is parked, and the owner withdraws it once the account is thawed', scenario(() => w, async () => {
    const payoutAta = ata(w.maker.solPayout.publicKey, w.sol.usdc).toBase58();
    const b0 = await balances(w, 'usdc_sol');
    const o = await taker.open('usdc_sol', 0, HALF);
    await untilState(w, o.ref, 'NOTICED');
    await untilPhase(w, o.ref, 'xmr_relayed');
    await w.mine(2);
    await w.sol.svm.setTokenAccountFrozen(payoutAta, true);
    await to(o, (await dl(o)).tReadyMin!);
    await taker.call(o, { name: 'set_ready' });
    await untilState(w, o.ref, 'DONE');
    const done = await taker.must(o);
    const fee = o.amount / 2000n;
    // The claim went through: the key is public, the fee accrued, and the payout waits in the swap.
    expect(done.owedMaker).toBe(o.amount - fee);
    expect((await balances(w, 'usdc_sol')).makerPayout).toBe(b0.makerPayout);
    expect((await balances(w, 'usdc_sol')).treasury - b0.treasury).toBe(fee);
    await w.mine(10);
    const swept = await taker.sweep(o, done);
    await w.mine(1);
    expect(await isMined(swept.txid)).toBe(true);
    // The daemon does not hold the owner key: it tells the maker.
    await waitFor('the parked-payout alert', async () => (await w.maker.status()).alerts.some((a) => /park|owed|withdraw/i.test(a.message)), { timeoutMs: 60_000, context: async () => (await w.maker.status()).alerts });
    // Frozen: the withdrawal fails too. Thawed: the owner collects.
    const mk = (await w.sol.client.getMaker(w.maker.makerPda))!;
    const withdraw = () => w.sol.send([solanaInstruction(w.sol.client.program, done, { operator: mk.operator, payout: mk.payout }, w.maker.solOwner.publicKey, { name: 'withdraw_owed', who: 'maker' })], [w.maker.solOwner]);
    await expect(withdraw()).rejects.toThrow();
    await w.sol.svm.setTokenAccountFrozen(payoutAta, false);
    await withdraw();
    expect((await balances(w, 'usdc_sol')).makerPayout - b0.makerPayout).toBe(o.amount - fee);
  }));

  it('Ethereum: the maker\'s payout address is blacklisted by the token; the claim never reverts, the payout is parked, and the payout account withdraws it to another address', scenario(() => w, async () => {
    const eth = w.eth!;
    const b0 = await balances(w, 'usdc_eth');
    const o = await taker.open('usdc_eth', 0, HALF);
    await untilState(w, o.ref, 'NOTICED');
    await untilPhase(w, o.ref, 'xmr_relayed');
    await w.mine(2);
    await eth.setBlacklisted(w.maker.ethPayout.address, true);
    await to(o, (await dl(o)).tReadyMin!);
    await taker.call(o, { name: 'set_ready' });
    await untilState(w, o.ref, 'DONE');
    const done = await taker.must(o);
    const fee = o.amount / 2000n;
    expect(stateName(done.state)).toBe('DONE');
    expect(await eth.client.owedOf(eth.usdc, w.maker.ethPayout.address.toLowerCase() as `0x${string}`, 'latest')).toBe(o.amount - fee);
    expect((await balances(w, 'usdc_eth')).makerPayout).toBe(b0.makerPayout);
    expect((await balances(w, 'usdc_eth')).treasury - b0.treasury).toBe(fee);
    await w.mine(10);
    const swept = await taker.sweep(o, done);
    await w.mine(1);
    expect(await isMined(swept.txid)).toBe(true);
    // The owed account itself withdraws, to an address the token will pay.
    const cold = eth.stranger.address.toLowerCase();
    const cold0 = await eth.usdcBalance(cold);
    await eth.fund(w.maker.ethPayout.address, 10n ** 18n);
    await eth.send(ethereumCall(eth.client.contract, done, { name: 'withdraw_owed', who: 'maker' }, { destination: cold })!, w.maker.ethPayout);
    expect((await eth.usdcBalance(cold)) - cold0).toBe(o.amount - fee);
    expect(await eth.client.owedOf(eth.usdc, w.maker.ethPayout.address.toLowerCase() as `0x${string}`, 'latest')).toBe(0n);
    await eth.setBlacklisted(w.maker.ethPayout.address, false);
  }));
});

describe('K-1: the maker rotates its encryption key while a swap is in flight', () => {
  it('the in-flight swap is unaffected (its messages use the key version it was opened with), and the next swap is opened under the new version', scenario(() => w, async () => {
    const v0 = (await w.sol.client.getMaker(w.maker.makerPda))!.encKeyVersion;
    const o = await taker.open('sol', 0, HALF);
    await untilState(w, o.ref, 'NOTICED');
    const r = await w.maker.api<{ version: number }>('POST', '/api/keys/rotate', {});
    expect(r.version).toBe(v0 + 1);
    await waitFor('the new key in the registry', async () => (await w.sol.client.getMaker(w.maker.makerPda))!.encKeyVersion === v0 + 1);
    await untilPhase(w, o.ref, 'xmr_relayed');
    await w.mine(2);
    // The notice still opens with the key the swap recorded.
    expect((await taker.must(o)).makerEncVersion).toBe(v0);
    expect((await taker.verify(o)).ok).toBe(true);
    await finishA(o);
    // A direction-B swap opened now is bound to the new version; the daemon decrypts its notice with the new key.
    const b = await taker.open('usdc_sol', 1, QUARTER);
    expect((await taker.must(b)).makerEncVersion).toBe(v0 + 1);
    await untilState(w, b.ref, 'ACTIVE');
    const paid = await w.takerWallet.pay(await taker.payAddress(b), QUARTER);
    await taker.postNotice(b, paid);
    await w.mine(2);
    await to(b, (await dl(b)).tReadyMin!);
    await untilState(w, b.ref, 'READY');
    await taker.claim(b);
    expect((await w.maker.status()).needs_review).toBe(0);
  }));
});

describe('E-1: Ethereum specifics the daemon enforces', () => {
  it('a lock whose taker never uploaded a valid DLEQ proof is rejected with reason 1; it does not count against the approval rate', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'ethereum');
    const b0 = await balances(w, 'usdc_eth');
    const o = await taker.open('usdc_eth', 0, HALF, { withoutProof: true });
    await waitFor('the rejection', async () => counterDelta(c0, await counters(w.maker, 'ethereum'))['rejections_no_fault'] === 1, { timeoutMs: 90_000, context: () => w.maker.swapDetail(o.ref).catch((e: Error) => e.message) });
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toEqual({ locks: 1, rejections_no_fault: 1 });
    expect((await balances(w, 'usdc_eth')).taker).toBe(b0.taker);
  }));

  it('two takers name the same pool leaf: the first lock is approved, the second is rejected with reason 2 and fully refunded', scenario(() => w, async () => {
    const eth = w.eth!;
    const c0 = await counters(w.maker, 'ethereum');
    const other = new SdkTaker(w, new Uint8Array(32).fill(46), w.sol.taker2, eth.taker2);
    const u0 = await eth.usdcBalance(eth.taker2.address);
    const first = await taker.open('usdc_eth', 0, HALF, { leafRandom: () => 0 });
    const second = await other.open('usdc_eth', 0, HALF, { leafRandom: () => 0 });
    expect((await taker.must(first)).makerSpendPub).toEqual((await other.must(second)).makerSpendPub);
    await untilState(w, first.ref, ['ACTIVE', 'NOTICED']);
    await waitFor('the second lock rejected', async () => counterDelta(c0, await counters(w.maker, 'ethereum'))['rejections_no_fault'] === 1, { timeoutMs: 90_000, context: () => w.maker.swapDetail(second.ref).catch((e: Error) => e.message) });
    expect(await eth.usdcBalance(eth.taker2.address)).toBe(u0);
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toMatchObject({ locks: 2, approvals: 1, rejections_no_fault: 1 });
    // The first swap is a normal swap.
    await untilPhase(w, first.ref, 'xmr_relayed');
    await w.mine(2);
    await finishA(first);
  }));
});

// Last of the swaps in this file: after a reorganisation the inventory wallet has seen one of its own spends disappear and
// come back, and no later scenario should depend on how quickly it settles (BUGS.md O6).
describe('N-1: a reorganisation orphans the daemon\'s lock', () => {
  it('direction A, a reorg orphans the daemon\'s lock: it relays the SAME stored transaction again, and the swap completes with one lock', scenario(() => w, async () => {
    const o = await taker.open('sol', 0, HALF);
    await untilState(w, o.ref, 'NOTICED');
    const first = await untilPhase(w, o.ref, 'xmr_relayed');
    const lockTxid = first.lock_txid as string;
    await w.mine(1);
    expect(await isMined(lockTxid)).toBe(true);
    // Both nodes forget the block and the pool; a longer chain without the lock replaces it.
    // (A popped transaction can travel back from the other node a moment later; if it was mined again the reorg is repeated.)
    for (let attempt = 0; attempt < 4; attempt++) {
      await reorg(1, w.takerXmr);
      if (!(await isMined(lockTxid))) break;
    }
    expect(await isMined(lockTxid)).toBe(false);
    const relays = async (): Promise<number> => (await intentsOf(o)).filter((i) => i.startsWith('xmr_relay')).length;
    // Keep both pools empty until the daemon itself has seen its lock gone from every node and relayed the stored bytes again.
    await waitFor('the daemon to rebroadcast its lock', async () => {
      if ((await relays()) >= 2) return true;
      for (const n of [NODE_A, NODE_B]) await nodeRpc(n, 'flush_txpool', {});
      return false;
    }, { timeoutMs: 120_000, intervalMs: 300, context: () => w.maker.swapDetail(o.ref) });
    await waitFor('the lock back in the pool', async () => (await poolTxids()).includes(lockTxid) || (await isMined(lockTxid)), { timeoutMs: 60_000, context: () => w.maker.swapDetail(o.ref) });
    await w.mine(2);
    expect((await taker.notice(o)).txid).toBe(lockTxid);
    expect((await w.maker.swapDetail(o.ref)).lock_txid).toBe(lockTxid);
    const intents = await intentsOf(o);
    // One prepared transaction, relayed twice; never a second payment.
    expect(intents.filter((i) => i.startsWith('xmr_prepare'))).toEqual(['xmr_prepare:confirmed']);
    expect(intents.filter((i) => i.startsWith('xmr_relay')).length).toBeGreaterThanOrEqual(2);
    await finishA(o);
    expect((await w.maker.status()).needs_review).toBe(0);
  }));
});

describe('after every fault', () => {
  it('no process logged a secret (and the check itself finds a secret that is in a log)', () => {
    expectClean(w);
    // The control: a secret written to a log file is found.
    const canary = path.join(stateRoot, 'logs', 'canary.log');
    w.addSecret('canary', 'c0ffee00'.repeat(8));
    writeFileSync(canary, `started\nkey=${'C0FFEE00'.repeat(8)}\n`);
    try {
      expect(w.leakedSecrets()).toEqual(['canary in logs/canary.log']);
    } finally {
      rmSync(canary, { force: true });
      w.secrets.delete('canary');
    }
    expect(w.secrets.size).toBeGreaterThan(20);
  });
});
