// Every row of DESIGN's "Refunds and deposits" table (SPEC 3.10) against the REAL daemon, with the
// taker driven through the SDK so that it can go away, come back and act at a chosen second.
// Each scenario asserts where the funds ended on the paying chain, what happened to the XMR, and
// which public counter of the maker moved. Rows 1 (pending) are in 03-modes-console.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REGTEST_MAX_FEE, isMined, poolTxids } from '../src/monero.js';
import { type Opened, SdkTaker } from '../src/taker.js';
import { XMR, waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { balances, counterDelta, counters, deadlines, expectClean, holdings, scenario, stateName, untilPhase, untilState } from './helpers.js';

let w: World;
let taker: SdkTaker;
beforeAll(async () => {
  w = await startWorld({ inventoryBlocks: 40 });
  taker = new SdkTaker(w);
});
afterAll(async () => {
  await w?.stop();
  await stopShared();
});

// A scenario that failed with the daemon down must not take the next one with it.
beforeEach(async () => {
  if (!w.maker.running) await w.maker.start();
});

const HALF = XMR / 2n;
/** Move both chains to an instant of the swap's chain. */
async function to(o: Opened, t: bigint): Promise<void> {
  const now = o.chain === 'solana' ? await w.sol.now() : await w.eth!.now();
  if (t > now) await w.advance(t - now);
}
const dl = async (o: Opened) => deadlines(await taker.must(o));
const state = async (o: Opened) => {
  const s = await taker.view(o);
  return s ? stateName(s.state) : 'closed';
};
/** The daemon builds its lock, posts the notice, sees it final and only then relays the XMR; two blocks confirm it. */
async function makerLocks(o: Opened, confirm = true): Promise<{ lockTxid: string }> {
  await untilState(w, o.ref, 'NOTICED');
  const d = await untilPhase(w, o.ref, 'xmr_relayed');
  if (confirm) await w.mine(2);
  return { lockTxid: d.lock_txid as string };
}
/** The maker's XMR comes home: the daemon sweeps the joint address with the share the taker's refund revealed. */
async function makerRecoversXmr(o: Opened, inventoryBefore: bigint): Promise<void> {
  await w.mine(10);
  const d = await waitFor('the daemon to sweep its XMR back', async () => {
    const x = await w.maker.swapDetail(o.ref);
    return x.sweep_txid ? x : null;
  }, { timeoutMs: 180_000, context: () => w.maker.swapDetail(o.ref) });
  await w.mine(1);
  expect(await isMined(d.sweep_txid)).toBe(true);
  const lost = inventoryBefore - (await holdings(w.maker.wallet));
  // Inventory restored, less the two Monero network fees (the lock and the sweep back).
  expect(lost > 0n && lost < 2n * REGTEST_MAX_FEE).toBe(true);
}
const restartDaemon = async (): Promise<void> => {
  await w.maker.start();
};

describe('row 2: approved, no lock notice by the deadline', () => {
  it('Solana: the daemon is down after the lock; a stranger refunds the taker in full at T_note; the fault is recorded; no XMR was broadcast', scenario(() => w, async () => {
    await taker.offer(w.maker, 'sol', 0);
    await w.maker.kill();
    const b0 = await balances(w, 'sol');
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('sol', 0, HALF);
    expect(await state(o)).toBe('ACTIVE');
    const d = await dl(o);
    // One second early the keyless refund is refused.
    await to(o, d.tNote! - 1n);
    await expect(taker.call(o, { name: 'refund_unnoticed' }, {}, 'stranger')).rejects.toMatchObject({ code: 'TooEarly' });
    await to(o, d.tNote!);
    await taker.call(o, { name: 'refund_unnoticed' }, {}, 'stranger');
    expect(await state(o)).toBe('closed');
    const b1 = await balances(w, 'sol');
    // Everything is back (only transaction fees are gone; the session key still holds its small budget); no deposit was held; no fee was taken.
    const out = b0.taker - b1.taker - (await taker.sessionLamports(o));
    expect(out >= 0n && out < 100_000n).toBe(true);
    expect(b1.treasury).toBe(b0.treasury);
    expect(b1.makerPayout).toBe(b0.makerPayout);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, missed_notices: 1 });
    expect(await holdings(w.maker.wallet)).toBe(inv0);
    expect(await poolTxids()).toEqual([]);
    // The daemon comes back, finds the swap gone and has nothing to do; nothing is parked for review.
    await restartDaemon();
    await untilPhase(w, o.ref, ['closed', 'refunded', 'missed_notice', 'settled']).catch(() => undefined);
    expect((await w.maker.status()).needs_review).toBe(0);
    expect(await holdings(w.maker.wallet)).toBe(inv0);
  }));

  it('Ethereum: the daemon dies right after its approval; anyone refunds at T_note; missed_notices on the Ethereum record', scenario(() => w, async () => {
    const eth = w.eth!;
    const b0 = await balances(w, 'eth');
    const c0 = await counters(w.maker, 'ethereum');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('eth', 0, HALF);
    expect(await state(o)).toBe('PENDING');
    // The approval is mined but not final: the daemon has not built or announced anything yet.
    await waitFor('the approval', async () => (await state(o)) === 'ACTIVE', { intervalMs: 50 });
    await w.maker.kill();
    expect(await state(o)).toBe('ACTIVE');
    const d = await dl(o);
    await to(o, d.tNote!);
    await taker.call(o, { name: 'refund_unnoticed' }, {}, 'stranger');
    const s = await taker.must(o);
    expect(stateName(s.state)).toBe('DONE');
    const b1 = await balances(w, 'eth');
    expect(b0.taker - b1.taker >= 0n && b0.taker - b1.taker < 10n ** 16n).toBe(true);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toEqual({ locks: 1, approvals: 1, missed_notices: 1 });
    expect(await poolTxids()).toEqual([]);
    await restartDaemon();
    await eth.finalize();
    expect(await holdings(w.maker.wallet)).toBe(inv0);
    expect((await w.maker.status()).needs_review).toBe(0);
  }));
});

describe('row 3: the taker cancels after approval, before the notice', () => {
  it('Solana USDC: amount − D at once; D is held 30 minutes and returned by a stranger\'s crank; no fault', scenario(() => w, async () => {
    await taker.offer(w.maker, 'usdc_sol', 0);
    await w.maker.kill();
    const b0 = await balances(w, 'usdc_sol');
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('usdc_sol', 0, HALF);
    expect(o.deposit).toBe(o.amount / 100n);
    expect((await balances(w, 'usdc_sol')).taker).toBe(b0.taker - o.amount);
    await taker.refund(o);
    expect(await state(o)).toBe('HOLD');
    expect((await balances(w, 'usdc_sol')).taker).toBe(b0.taker - o.deposit);
    // The daemon is back inside the hold; its policy for this offer is `never`, so it lets the deposit return.
    await restartDaemon();
    const d = await dl(o);
    await to(o, d.tHold! - 1n);
    await expect(taker.call(o, { name: 'release_deposit' }, {}, 'stranger')).rejects.toMatchObject({ code: 'TooEarly' });
    await to(o, d.tHold!);
    await taker.call(o, { name: 'release_deposit' }, {}, 'stranger');
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.taker).toBe(b0.taker);
    expect(b1.makerPayout).toBe(b0.makerPayout);
    expect(b1.makerOperator).toBe(b0.makerOperator);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, taker_cancels_approved: 1, deposits_returned: 1 });
    expect(await poolTxids()).toEqual([]);
  }));
});

describe('row 4: the taker refunds after a lock notice', () => {
  for (const market of ['usdc_sol', 'usdc_eth'] as const) {
    it(`${market}: amount − D at once; the daemon takes its XMR back with the revealed share; D is held, then returned`, scenario(() => w, async () => {
      const chain = market === 'usdc_sol' ? 'solana' : 'ethereum';
      const b0 = await balances(w, market);
      const c0 = await counters(w.maker, chain);
      const inv0 = await holdings(w.maker.wallet);
      const o = await taker.open(market, 0, HALF);
      const { lockTxid } = await makerLocks(o);
      // The lock is real and at depth on both nodes; the taker refunds anyway (it changed its mind).
      expect((await taker.verify(o)).ok).toBe(true);
      expect((await taker.notice(o)).txid).toBe(lockTxid);
      await taker.refund(o);
      expect(await state(o)).toBe('HOLD');
      expect((await balances(w, market)).taker).toBe(b0.taker - o.deposit);
      await makerRecoversXmr(o, inv0);
      const d = await dl(o);
      await to(o, d.tHold!);
      await taker.call(o, { name: 'release_deposit' }, {}, 'stranger');
      const b1 = await balances(w, market);
      expect(b1.taker).toBe(b0.taker);
      expect(b1.makerPayout).toBe(b0.makerPayout);
      expect(b1.treasury).toBe(b0.treasury);
      expect(counterDelta(c0, await counters(w.maker, chain))).toEqual({ locks: 1, ...(chain === 'ethereum' ? { approvals: 1 } : {}), notices: 1, taker_refunds_noticed: 1, deposits_returned: 1 });
      expect((await w.maker.status()).needs_review).toBe(0);
    }));
  }

});

describe('row 5: the taker never sets ready; the maker aborts after its claim delay', () => {
  it('Solana USDC (offer set to abort): ABORTED_HOLD at T_co; the taker returns and refunds amount − D; the deposit is held and returned; the maker recovers its XMR', scenario(() => w, async () => {
    await w.maker.setMarkets({ usdc_sol: { sell_xmr: { without_ready: 'abort' } } });
    const b0 = await balances(w, 'usdc_sol');
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('usdc_sol', 0, HALF);
    await makerLocks(o);
    const d = await dl(o);
    // Until T_co the maker only waits.
    await to(o, d.tCo! - 5n);
    await new Promise((r) => setTimeout(r, 4000));
    expect(await state(o)).toBe('NOTICED');
    await to(o, d.tCo!);
    await untilState(w, o.ref, 'ABORTED_HOLD');
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, aborts_late: 1 });
    // The taker comes back a day later, well before T_final.
    await to(o, d.tCo! + 86_400n);
    await taker.refund(o, 'wallet');
    expect(await state(o)).toBe('HOLD');
    expect((await balances(w, 'usdc_sol')).taker).toBe(b0.taker - o.deposit);
    await makerRecoversXmr(o, inv0);
    await to(o, (await dl(o)).tHold!);
    await taker.call(o, { name: 'release_deposit' }, {}, 'stranger');
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.taker).toBe(b0.taker);
    expect(b1.makerPayout).toBe(b0.makerPayout);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, aborts_late: 1, refunds_after_abort: 1, deposits_returned: 1 });
    await w.maker.setMarkets({ usdc_sol: { sell_xmr: { without_ready: 'claim' } } });
  }));
});

describe('row 6: the taker never sets ready or refunds; the maker claims after its claim delay', () => {
  it('Solana SOL: the daemon claims at T_co without ready; the payout is amount − fee; the XMR stays collectable with the published key half and the taker sweeps it later', scenario(() => w, async () => {
    const b0 = await balances(w, 'sol');
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('sol', 0, HALF);
    await makerLocks(o);
    const d = await dl(o);
    await to(o, d.tCo! - 5n);
    await new Promise((r) => setTimeout(r, 4000));
    expect(await state(o)).toBe('NOTICED');
    await to(o, d.tCo!);
    await untilState(w, o.ref, 'DONE');
    const done = await taker.must(o);
    const fee = o.amount / 2000n;
    const b1 = await balances(w, 'sol');
    expect(b1.makerPayout - b0.makerPayout).toBe(o.amount - fee);
    expect(b1.treasury - b0.treasury).toBe(fee);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, claims_without_ready: 1 });
    // The taker returns days later with nothing but its seed: the maker's share is in the account.
    await w.mine(10);
    const swept = await taker.sweep(o, done);
    await w.mine(1);
    expect(await isMined(swept.txid)).toBe(true);
    const got = (await w.takerWallet.received(swept.txid))!;
    expect(got).toBe(HALF - swept.fee);
    expect(swept.fee < REGTEST_MAX_FEE).toBe(true);
  }));
});

describe('row 7: ready is set and the maker misses its claim deadline', () => {
  it('Solana SOL: the daemon is down from before ready; at T_cd the taker refunds everything; missed_claims is recorded; the restarted daemon takes its XMR back', scenario(() => w, async () => {
    const b0 = await balances(w, 'sol');
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('sol', 0, HALF);
    await makerLocks(o);
    await w.maker.kill();
    let d = await dl(o);
    await to(o, d.tReadyMin!);
    expect((await taker.verify(o)).ok).toBe(true);
    await taker.call(o, { name: 'set_ready' });
    d = await dl(o);
    // One second before T_cd the claim window is still the maker's: the refund is refused (and reveals nothing: it is simulated first).
    await to(o, d.tCd! - 1n);
    await expect(taker.refund(o)).rejects.toThrow();
    await to(o, d.tCd!);
    await taker.refund(o);
    const b1 = await balances(w, 'sol');
    // Everything, deposit included, at once: a provable maker fault never holds a deposit.
    // (The swap account stays until it is closed, with its rent; the session key holds what is left of its budget.)
    const out = b0.taker - b1.taker - (await taker.sessionLamports(o)) - (await w.sol.balance(o.ref));
    expect(out >= 0n && out < 100_000n).toBe(true);
    expect(b1.makerPayout).toBe(b0.makerPayout);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, readies: 1, missed_claims: 1 });
    await restartDaemon();
    await makerRecoversXmr(o, inv0);
    expect((await w.maker.status()).needs_review).toBe(0);
  }));
});

describe('early maker abort (A7b, then A10d)', () => {
  it('Solana USDC: the maker aborts from the console API before its claim delay; the taker refunds everything at once, no hold', scenario(() => w, async () => {
    const b0 = await balances(w, 'usdc_sol');
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('usdc_sol', 0, HALF);
    await makerLocks(o);
    await w.maker.api('POST', `/api/swaps/${o.ref}/abort`, {});
    await untilState(w, o.ref, 'ABORTED_FREE');
    await taker.refund(o);
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.taker).toBe(b0.taker);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, aborts_early: 1, refunds_after_abort: 1 });
    await makerRecoversXmr(o, inv0);
  }));
});

// ---- From here on the scenarios move the clocks by days and months.

describe('row 8: the taker never returns by the final deadline', () => {
  it('Solana USDC: the maker aborted at T_co, the taker stays away; at T_final the daemon claims amount − fee; the XMR is still collectable from the recovery seed', scenario(() => w, async () => {
    await w.maker.setMarkets({ usdc_sol: { sell_xmr: { without_ready: 'abort' } } });
    const b0 = await balances(w, 'usdc_sol');
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('usdc_sol', 0, HALF);
    await makerLocks(o);
    const d = await dl(o);
    await to(o, d.tCo!);
    await untilState(w, o.ref, 'ABORTED_HOLD');
    await to(o, d.tFinal - 5n);
    await new Promise((r) => setTimeout(r, 4000));
    expect(await state(o)).toBe('ABORTED_HOLD');
    await to(o, d.tFinal);
    await untilState(w, o.ref, 'DONE');
    const done = await taker.must(o);
    const fee = o.amount / 2000n;
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.makerPayout - b0.makerPayout).toBe(o.amount - fee);
    expect(b1.treasury - b0.treasury).toBe(fee);
    expect(b1.taker).toBe(b0.taker - o.amount);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, aborts_late: 1, claims_after_final: 1 });
    await w.mine(10);
    const swept = await taker.sweep(o, done);
    await w.mine(1);
    expect((await w.takerWallet.received(swept.txid))!).toBe(HALF - swept.fee);
  }));
});

describe('the 30-day expiry after the final deadline (A10f)', () => {
  it('Solana USDC: the maker aborted and then vanished; at T_exp the taker refunds everything; the restarted daemon takes its XMR back', scenario(() => w, async () => {
    const b0 = await balances(w, 'usdc_sol');
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const o = await taker.open('usdc_sol', 0, HALF);
    await makerLocks(o);
    const d = await dl(o);
    await to(o, d.tCo!);
    await untilState(w, o.ref, 'ABORTED_HOLD');
    await w.maker.kill();
    // Between T_final and T_exp the claim is the maker's alone: the taker's refund is refused.
    await to(o, d.tFinal + 10n);
    await expect(taker.refund(o, 'wallet')).rejects.toThrow();
    await to(o, d.tExp - 1n);
    await expect(taker.refund(o, 'wallet')).rejects.toThrow();
    await to(o, d.tExp);
    await taker.refund(o, 'wallet');
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.taker).toBe(b0.taker);
    expect(b1.makerPayout).toBe(b0.makerPayout);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, aborts_late: 1, expired_refunds: 1 });
    await restartDaemon();
    await makerRecoversXmr(o, inv0);
    await w.maker.setMarkets({ usdc_sol: { sell_xmr: { without_ready: 'claim' } } });
  }));
});

describe('row 4 with a withheld deposit', () => {
  it('withheld (Solana USDC): the daemon withholds inside the hold with its lock evidence; nobody releases; after 60 days the split pays ceil(D/2) to the taker and floor(D/2) to the treasury, never the maker', scenario(() => w, async () => {
    await w.maker.setMarkets({ usdc_sol: { sell_xmr: { withhold_policy: 'always' } } });
    const b0 = await balances(w, 'usdc_sol');
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    // An odd deposit, so that the two halves differ.
    const o = await taker.open('usdc_sol', 0, 333_300_000_000n);
    expect(o.deposit % 2n).toBe(1n);
    await makerLocks(o);
    await taker.refund(o);
    await untilState(w, o.ref, 'WITHHELD');
    const withheld = await taker.must(o);
    // The withhold carried the opening of the notice commitment: the evidence is on-chain.
    expect(withheld.evidenceTxid && Buffer.from(withheld.evidenceTxid).toString('hex')).toBe((await taker.notice(o)).txid);
    expect((await balances(w, 'usdc_sol')).taker).toBe(b0.taker - o.deposit);
    await makerRecoversXmr(o, inv0);
    await w.maker.setMarkets({ usdc_sol: { sell_xmr: { withhold_policy: 'never' } } });
    // A stranger cannot release a withheld deposit, and cannot split before the 60 days are over.
    const d = await dl(o);
    await to(o, d.tHold! + 10n);
    await expect(taker.call(o, { name: 'release_deposit' }, {}, 'stranger')).rejects.toThrow();
    await to(o, d.tSplit! - 1n);
    await expect(taker.call(o, { name: 'split_deposit' }, {}, 'stranger')).rejects.toMatchObject({ code: 'TooEarly' });
    await to(o, d.tSplit!);
    await taker.call(o, { name: 'split_deposit' }, {}, 'stranger');
    const b1 = await balances(w, 'usdc_sol');
    expect(b1.taker).toBe(b0.taker - o.deposit + (o.deposit + 1n) / 2n);
    expect(b1.treasury - b0.treasury).toBe(o.deposit / 2n);
    expect(b1.makerPayout).toBe(b0.makerPayout);
    expect(b1.makerOperator).toBe(b0.makerOperator);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, taker_refunds_noticed: 1, withholds: 1, splits: 1 });
  }));
});

describe('after every refund row', () => {
  it('no process logged a secret, and the daemon parked nothing for review', () => {
    expectClean(w);
  });
});
