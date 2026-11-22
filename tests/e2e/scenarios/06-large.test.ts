// L-1: the large-swap tool in the browser against THREE real maker daemons, each with its own
// inventory wallet: the router's plan, waves under the in-flight limit, one maker that stalls
// (its daemon is killed), the remainder re-planned to the makers that delivered, and the final
// report. Solana only (the tool batches Solana legs).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { type TakerTab, openTab } from '../src/ui.js';
import { waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { connect, deadlines, dump, ensureBackup, expectClean, registerRecoverySecrets, scenario, track } from './helpers.js';

let w: World;
let tab: TakerTab;
beforeAll(async () => {
  // Offers valid for an hour: this scenario jumps the chain clock by minutes at a time, and a re-plan must not find the
  // surviving makers' offers lapsed just because their next refresh is a second away.
  const sell = (deviation_pct: number) => ({ sol: { sell_xmr: { max_xmr: 0.3, deviation_pct, offer_valid_seconds: 3600 } } });
  // Prices 1.53, 1.545 and 1.56 SOL per XMR; each maker takes at most 0.3 XMR per swap.
  w = await startWorld({ ethereum: false, inventoryBlocks: 8, makers: [{ markets: sell(2) }, { markets: sell(3) }, { markets: sell(4) }] });
  tab = track(await openTab({ solKey: w.sol.taker }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await w?.stop();
  await stopShared();
});

describe('L-1: a large swap across three real makers', () => {
  it('plans two waves under the in-flight limit, locks a wave in one transaction, refunds the stalled maker\'s leg at its deadline, re-plans the remainder and reports what was filled', scenario(() => w, async () => {
    const { page } = tab;
    const [m1, m2, m3] = w.makers as [World['maker'], World['maker'], World['maker']];
    const taker = w.sol.taker.publicKey;
    const swaps = () => w.sol.client.listSwapsByTaker(taker);
    const ofMaker = async (m: World['maker']) => (await w.sol.client.listSwapsByMaker(m.makerPda));
    const treasury0 = (await w.sol.treasury()).sol;
    const payout0 = await Promise.all(w.makers.map((m) => w.sol.balance(m.solPayout.publicKey)));

    /**
     * The page opens the next wave by itself when a leg settles. If the offers it planned on lapsed in that instant
     * (this test jumps the chain clock by minutes; a live offer is valid for 60 s) it leaves an "Open next wave"
     * button instead, as it does when the wallet refuses. Either way the wallet signs exactly once per wave.
     */
    const live = async (m: World['maker']): Promise<boolean> => {
      const o = await w.sol.client.getOffer(m.makerPda, 0, 0);
      return !!o && o.enabled === 1 && (await w.sol.now()) < o.updatedAt + BigInt(o.validSecs) - 20n;
    };
    const openNextWave = (signatures: number): Promise<unknown> =>
      waitFor(`wave ${signatures} to be opened`, async () => {
        if (tab.sol.signed >= signatures) return true;
        const button = page.getByRole('button', { name: /^Open next wave/ });
        if ((await button.count()) && (await live(m1)) && (await live(m3))) await button.click().catch(() => undefined);
        return false;
      }, { timeoutMs: 120_000, intervalMs: 2000, context: () => page.locator('main').innerText() });

    await page.goto(`${w.ui.url}/#/large`);
    await connect(page, 'solana');
    await page.getByLabel('Total to spend (SOL)').fill('1.2');
    await page.getByLabel('Worst acceptable rate (SOL per XMR)').fill('1.6');
    await page.getByLabel('Most locked at one time (SOL)').fill('0.95');
    await page.getByLabel('Your XMR address').fill(w.takerXmr);

    // ---- the plan: two legs now (0.459 + 0.4635 SOL fit under 0.95), the rest in a second wave
    await waitFor('the three makers in the plan', async () => (await page.getByTestId('plan-leg').count()) === 3, { timeoutMs: 90_000, intervalMs: 1000, between: async () => void (await page.getByRole('button', { name: /Refresh/ }).click().catch(() => undefined)), context: () => page.locator('main').innerText() });
    expect(await page.getByRole('table', { name: 'Wave 1' }).getByTestId('plan-leg').count()).toBe(2);
    expect(await page.getByRole('table', { name: 'Wave 2' }).getByTestId('plan-leg').count()).toBe(1);
    await dump(page, 'plan');
    const recoveryFile = await ensureBackup(page);
    registerRecoverySecrets(w, recoveryFile, 'large');
    const lock = page.getByTestId('lock-button');
    await expect.poll(() => lock.isDisabled()).toBe(false);
    expect(await lock.innerText()).toMatch(/^Lock wave 1: 0\.9225 SOL in 2 legs$/);

    // ---- the second maker goes away before it can act: its offer is still live on-chain, its daemon is dead
    await m2.kill();
    await lock.click();
    const confirm = page.getByTestId('confirm-lock');
    expect(await confirm.innerText()).toContain('Keep this tab open until it says Safe to close.');
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: /^Lock / }).click();
    const board = page.getByTestId('large-board');
    await board.waitFor({ timeout: 60_000 });
    // One wallet signature opened both legs; the third leg waits for room under the limit.
    expect(tab.sol.signed).toBe(1);
    expect(await swaps()).toHaveLength(2);
    expect(await ofMaker(m1)).toHaveLength(1);
    expect(await ofMaker(m2)).toHaveLength(1);
    expect(await ofMaker(m3)).toHaveLength(0);
    await page.getByTestId('risk-banner').waitFor();

    // ---- maker 1 delivers; when its leg settles the page opens the next wave within the limit
    await waitFor('maker 1 to lock its XMR', async () => (await m1.swaps()).some((s) => s.phase === 'xmr_relayed'), { timeoutMs: 120_000, context: () => m1.swaps() });
    await w.mine(2);
    await w.sol.warpTo(deadlines((await ofMaker(m1))[0]!).tReadyMin!);
    await waitFor('maker 1 to claim', async () => (await m1.counters('solana'))[COUNTER.completed] === 1, { timeoutMs: 120_000, context: () => m1.swaps() });
    await openNextWave(2);
    await waitFor('the second wave on-chain', async () => (await ofMaker(m3)).length === 1, { timeoutMs: 60_000 });

    // ---- maker 2 never announces a lock: at its deadline the tab refunds that leg in full, and the fault is on its record
    const stalled = (await ofMaker(m2))[0]!;
    expect(stalled.state).toBe(SWAP_STATE.ACTIVE);
    await waitFor('maker 3 to lock its XMR', async () => (await m3.swaps()).some((s) => s.phase === 'xmr_relayed'), { timeoutMs: 120_000, context: () => m3.swaps() });
    await w.mine(2);
    await w.sol.warpTo(deadlines(stalled).tNote!);
    await waitFor('the stalled leg refunded', async () => (await ofMaker(m2)).length === 0, { timeoutMs: 90_000 });
    expect((await m2.counters('solana'))[COUNTER.missed_notices]).toBe(1);
    await expect.poll(() => board.locator('[data-leg-state="refunded"]').count(), { timeout: 60_000 }).toBe(1);

    // ---- everything else runs to the end: maker 3 completes, the remainder is re-planned to a maker that delivered
    await waitFor('the final report', async () => {
      if (await page.getByTestId('report').count()) return true;
      const button = page.getByRole('button', { name: /^Open next wave/ });
      if ((await button.count()) && (await live(m1)) && (await live(m3))) await button.click().catch(() => undefined);
      for (const s of await swaps()) {
        const d = deadlines(s);
        if (s.state === SWAP_STATE.NOTICED && (await w.sol.now()) < d.tReadyMin!) {
          await w.mine(2);
          await w.sol.warpTo(d.tReadyMin!);
        }
      }
      await w.mine(1);
      return false;
    }, { timeoutMs: 600_000, intervalMs: 3000, context: async () => ({ board: await board.innerText(), signed: tab.sol.signed }) });
    const report = page.getByTestId('report');
    await dump(page, 'report');
    const reportText = await report.innerText();
    console.log(`[L-1] report: ${reportText.replace(/\s+/g, ' ')}`);
    expect(await board.getAttribute('data-finished')).toBe('true');
    // The stalled maker got nothing more; the remainder went to the makers that delivered.
    const done = await Promise.all(w.makers.map(async (m) => (await m.counters('solana'))[COUNTER.completed]!));
    expect(done[1]).toBe(0);
    // Maker 1 (the best rate) took the re-planned remainder as a second leg once its first had settled.
    expect(done).toEqual([2, 0, 1]);
    expect(reportText).toMatch(/Filled 1\.19\d* SOL for 0\.7[67]\d* XMR/);
    expect(reportText).toMatch(/Unfilled 0\.0\d+ SOL/);
    expect(await board.locator('[data-leg-state="refunded"]').count()).toBe(1);
    const filledLegs = done[0]! + done[2]!;
    expect(await board.locator('[data-leg-state="claimed"], [data-leg-state="swept"]').count()).toBe(filledLegs);
    // One wallet signature per wave, nothing else.
    expect(tab.sol.signed).toBe(3);

    // ---- balances: every filled leg paid its maker amount − fee and the treasury the fee; the XMR of every filled leg is swept
    const payout1 = await Promise.all(w.makers.map((m) => w.sol.balance(m.solPayout.publicKey)));
    const paid = payout1.map((b, i) => b - payout0[i]!);
    expect(paid[1]).toBe(0n);
    const gross = ((paid[0]! + paid[2]!) * 2000n) / 1999n;
    const fee = (await w.sol.treasury()).sol - treasury0;
    expect(fee > 0n && gross - (paid[0]! + paid[2]!) - fee >= -3n && gross - (paid[0]! + paid[2]!) - fee <= 3n).toBe(true);
    const xmr0 = (await w.takerWallet.balance()).balance;
    await waitFor('every filled leg swept', async () => {
      await w.mine(2);
      return (await board.locator('[data-leg-state="swept"]').count()) === filledLegs;
    }, { timeoutMs: 420_000, intervalMs: 3000, context: () => board.innerText() });
    expect((await w.takerWallet.balance()).balance > xmr0).toBe(true);
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));
});
