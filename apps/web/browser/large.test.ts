// The large-swap tool in the browser (scenario L-1): three makers, two waves, one maker stalls.
// And selling XMR (H-B): the taker pays from an ordinary wallet and the page finds the payment.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf } from '@xmrswap/sdk';
import type { Browser } from 'playwright-core';
import { connectWallet, injectWallet, launch, saveRecoveryFile, shots, watchErrors } from './driver.js';
import { SOL, type Stack, XMR, startStack } from './stack.js';
import * as xmr from './xmr.js';

let w: Stack;
let browser: Browser;

beforeAll(async () => {
  w = await startStack([
    // Maker 1: best rate, room for exactly one leg. Maker 2: will stall. Maker 3: little capacity.
    { price: (150n * SOL) / 100n, maxXmr: (3n * XMR) / 10n, capacityXmr: (3n * XMR) / 10n, buys: true },
    { price: (151n * SOL) / 100n, maxXmr: (3n * XMR) / 10n },
    { price: (152n * SOL) / 100n, maxXmr: (3n * XMR) / 10n, capacityXmr: (2n * XMR) / 10n },
  ]);
  await xmr.funded();
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await w?.stop();
});

describe('large swap (L-1)', () => {
  it('plans across makers, locks a wave in one transaction, re-plans around a stalled maker, and reports filled and unfilled', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const [m1, m2, m3] = w.makers as [Stack['makers'][0], Stack['makers'][0], Stack['makers'][0]];
    m2.stall = true;

    await page.goto(`${w.url}/#/large`);
    await connectWallet(page);
    await page.getByLabel('Total to spend (SOL)').fill('1.2');
    await page.getByLabel('Worst acceptable rate (SOL per XMR)').fill('1.6');
    await page.getByLabel('Most locked at one time (SOL)').fill('0.9');
    await page.getByLabel('Your XMR address').fill(await xmr.walletAddress());

    // ---- the router's plan: two legs now (within the in-flight limit), the rest in a second wave
    await page.getByRole('table', { name: 'Wave 1' }).waitFor();
    expect(await page.getByRole('table', { name: 'Wave 1' }).getByTestId('plan-leg').count()).toBe(2);
    expect(await page.getByRole('table', { name: 'Wave 2' }).getByTestId('plan-leg').count()).toBe(1);
    const lock = page.getByTestId('lock-button');
    expect(await lock.isDisabled()).toBe(true);
    await saveRecoveryFile(page);
    await expect.poll(() => lock.isDisabled()).toBe(false);
    expect(await lock.innerText()).toMatch(/^Lock wave 1: 0\.90 SOL in 2 legs$/);
    await lock.click();
    const confirm = page.getByTestId('confirm-lock');
    expect(await confirm.innerText()).toContain('Keep this tab open until it says Safe to close.');
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: /^Lock / }).click();

    // ---- one transaction opened both legs
    const board = page.getByTestId('large-board');
    await board.waitFor();
    expect(wallet.signed).toBe(1);
    expect(await w.client.listSwapsByTaker(w.taker.publicKey)).toHaveLength(2);
    await expect.poll(() => board.locator('[data-testid="leg"][data-leg-state="locked"]').count()).toBe(2);
    await page.getByTestId('risk-banner').waitFor();

    // ---- maker 1 locks XMR; maker 2 stalls
    expect(await w.stepMakers()).toEqual(['1: prepared the XMR lock', '1: posted the notice', '1: relayed the XMR lock']);
    await xmr.settle(1);
    await expect.poll(() => board.locator('[data-leg-state="xmr-seen"]').count(), { timeout: 60_000 }).toBe(1);
    await shots(page, 'large-swap-board');
    const leg1 = (await w.client.listSwapsByMaker(m1.pda))[0]!;
    await w.warpTo(deadlinesOf('solana', leg1).tReadyMin!);
    await expect.poll(async () => (await w.client.getSwap(w.refOf(leg1)))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.READY);
    expect(await w.stepMakers()).toEqual(['1: claimed']);

    // ---- a leg settled: the remainder is re-planned and the second wave opens within the limit
    await expect.poll(() => wallet.signed, { timeout: 60_000 }).toBe(2);
    await expect.poll(() => board.getByTestId('leg').count(), { timeout: 60_000 }).toBe(3);
    expect((await w.client.listSwapsByMaker(m3.pda))).toHaveLength(1);
    expect(await w.stepMakers()).toEqual(['3: prepared the XMR lock', '3: posted the notice', '3: relayed the XMR lock']);
    await xmr.settle(1);

    // ---- maker 2 never announces a lock: at its deadline the tab refunds that leg in full
    const leg2 = (await w.client.listSwapsByMaker(m2.pda))[0]!;
    await w.warpTo(deadlinesOf('solana', leg2).tNote!);
    await expect.poll(async () => await w.client.getSwap(w.refOf(leg2)), { timeout: 60_000 }).toBe(null);
    expect((await m2.record()).counters[COUNTER.missed_notices]).toBe(1);
    await expect.poll(() => board.locator('[data-leg-state="refunded"]').count(), { timeout: 60_000 }).toBe(1);

    // ---- maker 3 completes; nothing else can take the remainder, so the order ends partly filled
    await expect.poll(async () => (await w.client.listSwapsByMaker(m3.pda))[0]!.state, { timeout: 60_000 }).toBe(SWAP_STATE.READY);
    expect(await w.stepMakers()).toEqual(['3: claimed']);
    const report = page.getByTestId('report');
    await report.waitFor({ timeout: 60_000 });
    expect(await board.getAttribute('data-finished')).toBe('true');
    expect(await report.innerText()).toMatch(/Partly filled/);
    expect(await report.innerText()).toMatch(/Filled 0\.75 SOL for 0\.49\d+ XMR\. Unfilled 0\.45 SOL, of which 0\.45 SOL was locked and refunded\./);
    expect(await board.locator('[data-leg-state="claimed"], [data-leg-state="swept"]').count()).toBe(2);
    expect(wallet.signed).toBe(2);
    await shots(page, 'large-swap-report');

    // ---- the XMR of both filled legs is swept
    await xmr.settle(10);
    await expect.poll(() => board.getByText(/Sweep sent/).count(), { timeout: 180_000, interval: 1000 }).toBe(2);
    await xmr.settle(1);
    await expect.poll(async () => ((await board.locator('[data-leg-state="swept"]').count()) === 2 ? 'swept' : await board.innerText()), { timeout: 120_000, interval: 2000 }).toBe('swept');
    expect(wallet.signed).toBe(2);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe('sell XMR for USDC in the browser (H-B)', () => {
  it('deposit, maker funds, the address appears, the page finds and verifies the payment, posts the notice and claims', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const maker = w.makers[0]!;
    await maker.refresh(1, 1, 150_000_000n);
    const usdcOf = async (owner: string) => BigInt((await w.svm.call<{ value: { amount: string } }>('getTokenAccountBalance', [await w.svm.mintTo(w.usdc, owner, 0n)])).value.amount);
    const before = await usdcOf(w.taker.publicKey);

    await page.goto(w.url);
    await connectWallet(page);
    await page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'Sell XMR' }).click();
    await page.getByRole('button', { name: 'USDC · Solana' }).click();
    await page.getByTestId('offer').getByRole('link', { name: 'Sell XMR' }).click();
    await page.getByLabel('XMR to sell').fill('0.25');
    await page.getByLabel('Your XMR refund address').fill(await xmr.walletAddress());
    await expect.poll(() => page.getByTestId('you-receive').innerText()).toBe('37.48 USDC');
    await page.getByText(/You pay XMR from your own wallet/).first().waitFor();
    await page.getByText(/USDC can be frozen by its issuer/).first().waitFor();
    await saveRecoveryFile(page);
    await page.getByTestId('lock-button').click();
    const confirm = page.getByTestId('confirm-lock');
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: /^Post deposit/ }).click();
    await page.getByTestId('swap-page').waitFor();
    expect(wallet.signed).toBe(1);
    // A pending take is not at risk and shows no address yet.
    expect(await page.getByTestId('risk-banner').count()).toBe(0);
    expect(await page.getByTestId('pay-xmr').count()).toBe(0);

    // ---- the maker funds; only now is the address shown, computed in the page
    expect(await w.stepMakers()).toEqual(['1: funded']);
    const pay = page.getByTestId('pay-xmr');
    await pay.waitFor({ timeout: 60_000 });
    const address = (await pay.locator('code').first().getAttribute('title'))!;
    expect(address).toMatch(/^4[1-9A-HJ-NP-Za-km-z]{94}$/);
    await page.getByText(/Keep this tab open while you sell XMR/).first().waitFor();
    await shots(page, 'sell-pay-address');

    // ---- the taker pays from its own wallet; the page finds it and posts the notice with the session key
    await xmr.pay(address, XMR / 4n);
    const ref = decodeURIComponent(new URL(page.url()).hash.split('/').pop()!);
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.NOTICED);
    expect(wallet.signed).toBe(1);

    // ---- the maker verifies on both nodes at depth and sets ready; the page claims
    await xmr.settle(2);
    await w.warpTo(deadlinesOf('solana', (await w.client.getSwap(ref))!).tReadyMin!);
    expect(await w.stepMakers()).toEqual(['1: set_ready']);
    await page.getByText('Complete', { exact: true }).first().waitFor({ timeout: 60_000 });
    const done = (await w.client.getSwap(ref))!;
    expect(done).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    // amount − 0.05% fee; the deposit came back with it.
    expect((await usdcOf(w.taker.publicKey)) - before).toBe(37_500_000n - 18_750n);
    expect(wallet.signed).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  });
});
