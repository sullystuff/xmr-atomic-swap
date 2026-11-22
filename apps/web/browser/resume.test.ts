// The tab-close and reload paths (SPEC 8.4, 8.5 items 4 and 9; scenarios U-1, V-1, F-1):
// a reload resumes at once from the tab's seed; a brand-new browser profile resumes from the
// recovery file alone; and a false lock notice is refunded by the tab itself at the cutoff.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COUNTER, DEPOSIT_STATE, SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf, solanaInstruction } from '@xmrswap/sdk';
import type { Browser } from 'playwright-core';
import { connectWallet, injectWallet, launch, lockSwap, shots, watchErrors } from './driver.js';
import { SOL, type Stack, XMR, startStack } from './stack.js';
import * as xmr from './xmr.js';

let w: Stack;
let browser: Browser;

beforeAll(async () => {
  w = await startStack([{ price: (150n * SOL) / 100n }]);
  await xmr.funded();
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await w?.stop();
});
beforeEach(async () => {
  // A running daemon refreshes its offer every few seconds; the tests warp hours ahead.
  for (const m of w.makers) await m.refresh();
});

describe('closing and reopening the tab', () => {
  it('asks before leaving while at risk; a reload resumes at once; a new profile resumes from the recovery file and finishes the swap', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const destination = await xmr.walletAddress();
    const { ref, recoveryFile } = await lockSwap(page, w.url, { xmr: '0.4', destination });
    await page.getByTestId('risk-banner').waitFor();
    expect(wallet.signed).toBe(1);

    // ---- the leave-page prompt: the browser asks before this tab may go away
    const dialogs: string[] = [];
    page.once('dialog', (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await page.reload();
    expect(dialogs).toEqual(['beforeunload']);

    // ---- after the reload the swap is back at once, with no wallet and no prompt
    await page.getByTestId('swap-page').waitFor();
    await page.getByTestId('risk-banner').waitFor();
    expect(await page.getByTestId('swap-page').getAttribute('data-at-risk')).toBe('true');
    await expect.poll(() => page.title()).toMatch(/^Do not close this tab/);
    expect(wallet.signed).toBe(1);

    // ---- the maker locks; the tab sees it; then the tab is closed for good
    await w.stepMakers();
    await page.getByText(/of 2 confirmations on every node/).first().waitFor({ timeout: 60_000 });
    expect(errors).toEqual([]);
    await context.close();
    await xmr.settle(1);
    const noticed = (await w.client.getSwap(ref))!;
    expect(noticed.state).toBe(SWAP_STATE.NOTICED);
    await w.warpTo(deadlinesOf('solana', noticed).tReadyMin! + 30n);

    // ---- a new browser profile: nothing but the recovery file and the chain
    const context2 = await browser.newContext({ acceptDownloads: true });
    const wallet2 = await injectWallet(context2, w.taker);
    const page2 = await context2.newPage();
    const errors2 = watchErrors(page2);
    await page2.goto(`${w.url}/#/activity`);
    await page2.getByRole('heading', { name: 'Load your recovery file to resume' }).waitFor();
    await page2.getByRole('button', { name: 'I already have one' }).click();
    await page2.locator('input[type=file]').setInputFiles({ name: 'xmrswap-recovery.json', mimeType: 'application/json', buffer: Buffer.from(recoveryFile) });
    // The file lists the wallet, so the swap is found and continued before any wallet is connected:
    // the lock is at depth, so the tab sets ready with the re-derived session key.
    const item = page2.getByTestId('activity-swap');
    await item.waitFor({ timeout: 60_000 });
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.READY);
    await page2.getByTestId('safe-banner').waitFor();
    expect(wallet2.signed).toBe(0);

    // ---- the maker completes; the new profile has no note of the destination, so it asks instead of guessing
    expect(await w.stepMakers()).toEqual(['1: claimed']);
    await item.getByRole('link', { name: 'Open' }).click();
    await xmr.settle(9);
    await page2.getByLabel('Your XMR address').fill(destination);
    await page2.getByRole('button', { name: 'Sweep to this address' }).click();
    await page2.getByText(/Sweep sent, waiting for a block/).first().waitFor({ timeout: 120_000 });
    await xmr.settle(1);
    await page2.getByText('The XMR is in your wallet').first().waitFor({ timeout: 60_000 });
    await expect.poll(async () => await w.client.getSwap(ref), { timeout: 60_000 }).toBe(null);
    expect(wallet2.signed).toBe(0);
    expect(errors2).toEqual([]);
    await context2.close();
  });
});

describe('a false lock notice (F-1)', () => {
  it('the tab refunds by itself at the cutoff with the session key, and the maker cannot claim afterwards', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const maker = w.makers[0]!;
    const before = await w.balance(w.taker.publicKey);
    const { ref } = await lockSwap(page, w.url, { xmr: '0.4', destination: await xmr.walletAddress(), shot: 'confirm-lock' });
    const amount = (60n * SOL) / 100n;
    const deposit = amount / 100n;

    // The maker announces a lock that pays a tenth of an XMR too little, and mines it deep.
    maker.shortBy = XMR / 10n;
    await w.stepMakers();
    maker.shortBy = 0n;
    await xmr.settle(3);
    await page.getByText(/The lock is not valid: it pays 0\.30 XMR, but this swap needs 0\.40 XMR/).first().waitFor({ timeout: 60_000 });
    await shots(page, 'at-risk-banner');
    const noticed = (await w.client.getSwap(ref))!;
    const d = deadlinesOf('solana', noticed);

    // One second before the cutoff nothing has been sent; the banner is still up.
    await w.warpTo(d.tCut! - 1n);
    await page.waitForTimeout(2500);
    expect((await w.client.getSwap(ref))!.state).toBe(SWAP_STATE.NOTICED);
    expect(await page.getByTestId('risk-banner').count()).toBe(1);

    // At the cutoff the tab refunds, signed by the session key: the wallet is never asked.
    await w.warpTo(d.tCut!);
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.HOLD);
    expect(wallet.signed).toBe(1);
    await page.getByText('This tab refunded by itself').first().waitFor();
    await expect.poll(() => page.getByTestId('risk-banner').count()).toBe(0);
    expect((await maker.record()).counters[COUNTER.taker_refunds_noticed]).toBe(1);
    // Everything but the deposit (and the session budget still on the session key, and one fee) is back.
    const afterRefund = await w.balance(w.taker.publicKey);
    expect(before - afterRefund < deposit + 10_000_000n).toBe(true);
    expect(before - afterRefund >= deposit).toBe(true);

    // The maker's claim-without-ready window opens at T_co, but the swap is no longer claimable.
    await w.warpTo(d.tCo!);
    const held = (await w.client.getSwap(ref))!;
    const mk = await maker.record();
    const share = [...maker.shares.values()].find((k) => Buffer.from(k.spendPub).equals(Buffer.from(held.makerSpendPub)))!;
    const claim = solanaInstruction(w.client.program, { ...held, state: SWAP_STATE.NOTICED }, { operator: mk.operator, payout: mk.payout }, maker.operator.publicKey, { name: 'claim' }, { secret: share.spend });
    await expect(w.send([claim], [maker.operator])).rejects.toMatchObject({ code: 'BadState' });

    // The 30-minute hold has passed with the warp. The session key was swept back by the refund, so
    // the tab does not open a wallet prompt on its own: it offers the step, and the user clicks.
    await page.getByText('Your deposit can be collected now').first().waitFor({ timeout: 60_000 });
    expect(wallet.signed).toBe(1);
    await page.getByRole('button', { name: 'Sign with my wallet' }).click();
    await expect.poll(async () => (await w.client.getSwap(ref))?.depositState ?? DEPOSIT_STATE.RETURNED, { timeout: 60_000 }).toBe(DEPOSIT_STATE.RETURNED);
    expect(wallet.signed).toBe(2);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe('refund requested after the lock is confirmed (BUG-1)', () => {
  it('the swap refunds as asked; the tab does not set ready', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const maker = w.makers[0]!;
    const readiesBefore = (await maker.record()).counters[COUNTER.readies]!;
    const { ref } = await lockSwap(page, w.url, { xmr: '0.4', destination: await xmr.walletAddress() });

    // The maker's lock is real and reaches the swap's depth on both nodes.
    await w.stepMakers();
    await xmr.settle(1);
    // Confirmed: the only thing between the tab and "ready" is the contract's minimum wait.
    await page.getByText(/The lock is confirmed\. The contract accepts the confirmation in/).first().waitFor({ timeout: 60_000 });
    expect((await w.client.getSwap(ref))!.state).toBe(SWAP_STATE.NOTICED);

    // The user asks for a refund and confirms it.
    await page.getByRole('button', { name: 'Refund this swap' }).click();
    await page.getByRole('button', { name: 'Yes, refund' }).click();
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.HOLD);
    await page.getByTestId('request-outcome').getByText('Refunded, as you asked').waitFor();
    expect(await page.getByTestId('request-outcome').getAttribute('data-refused')).toBe('');
    expect(wallet.signed).toBe(1);

    // Past the minimum wait, where the old behaviour set ready: nothing of the kind happens.
    await w.warpTo(deadlinesOf('solana', (await w.client.getSwap(ref))!).tReadyMin! + 60n);
    await page.waitForTimeout(3000);
    expect((await w.client.getSwap(ref))!.state).toBe(SWAP_STATE.HOLD);
    const m = await maker.record();
    expect(m.counters[COUNTER.readies]).toBe(readiesBefore);
    expect(await page.getByTestId('safe-banner').count() + (await page.getByTestId('risk-banner').count())).toBeLessThanOrEqual(1);
    expect(await page.getByRole('button', { name: 'Refund this swap' }).count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});
