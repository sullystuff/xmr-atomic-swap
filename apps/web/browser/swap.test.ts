// A complete buy-XMR swap driven in a real browser: the built UI in Chromium, the real Solana
// program inside tools/svm-rpc, real XMR on the Monero regtest, and an in-test maker built from
// the SDK's maker flows. Loopback only; no validator, no cluster, no live network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf } from '@xmrswap/sdk';
import type { Browser, Page } from 'playwright-core';
import { connectWallet, injectWallet, launch, saveRecoveryFile, watchErrors } from './driver.js';
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

const swapsOfTaker = () => w.client.listSwapsByTaker(w.taker.publicKey);
const text = (page: Page, t: string | RegExp) => page.getByText(t).first();

describe('buy XMR with SOL in the browser (H-A, U-1)', () => {
  it('offers → review → backup gate → full-screen confirmation → lock → at-risk banner → ready → Safe to close → sweep', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const destination = await xmr.walletAddress();
    const maker = w.makers[0]!;
    const payoutBefore = await w.balance(maker.payout.publicKey);

    // ---- offers, ranked, with the maker's history
    await page.goto(w.url);
    await page.getByRole('heading', { name: 'Buy XMR directly from makers' }).waitFor();
    const offer = page.getByTestId('offer');
    await offer.waitFor();
    await expect.poll(() => offer.innerText()).toContain('1.50 SOL');
    expect(await offer.innerText()).toMatch(/Auto-accept/);
    expect(await offer.innerText()).toMatch(/Claim delay\s+1 h/);
    await connectWallet(page);
    await offer.getByRole('link', { name: 'Buy XMR' }).click();

    // ---- review
    await page.getByTestId('new-swap').waitFor();
    await page.getByLabel('XMR to buy').fill('0.5');
    await page.getByLabel('Your XMR address').fill(destination);
    await expect.poll(() => page.getByTestId('you-pay').innerText()).toBe('0.75 SOL');
    // Offer-specific warnings are on the page before any lock: claim delay, deposit, upgrade status.
    await text(page, /After 1 h the maker can take your payment even if you have not confirmed/).waitFor();
    await text(page, /up to 0\.0075 SOL can be withheld for up to 60 days and half of it lost/).waitFor();
    await text(page, /The Solana program can still be upgraded/).waitFor();

    // ---- gate 1: no backup, no lock
    const lock = page.getByTestId('lock-button');
    expect(await lock.isDisabled()).toBe(true);
    await text(page, /Save your recovery file first/).waitFor();
    const recoveryFile = await saveRecoveryFile(page);
    expect(JSON.parse(recoveryFile)).toMatchObject({ format: 'xmrswap-recovery/1', program_id: w.client.programId });
    await expect.poll(() => lock.isDisabled()).toBe(false);

    // ---- gate 2: the full-screen confirmation; nothing reaches the wallet before the box is ticked
    await lock.click();
    const confirm = page.getByTestId('confirm-lock');
    await confirm.waitFor();
    expect(await confirm.innerText()).toContain('Keep this tab open until it says Safe to close. If you close it, let the computer sleep or lose your connection before then, you can lose your funds.');
    expect(await confirm.innerText()).toMatch(/Expected duration\s+6 min/);
    const go = confirm.getByRole('button', { name: 'Lock 0.75 SOL' });
    expect(await go.isDisabled()).toBe(true);
    expect(wallet.signed).toBe(0);
    expect(await swapsOfTaker()).toHaveLength(0);
    await confirm.getByRole('checkbox').check();
    await go.click();

    // ---- locked: the red banner, the title and the leave prompt
    await page.getByTestId('swap-page').waitFor();
    expect(wallet.signed).toBe(1);
    const [swap0] = await swapsOfTaker();
    expect(swap0).toMatchObject({ state: SWAP_STATE.ACTIVE, xmr: XMR / 2n, amount: (75n * SOL) / 100n });
    const banner = page.getByTestId('risk-banner');
    await banner.waitFor();
    expect(await banner.innerText()).toContain('Do not close this tab');
    expect(await banner.innerText()).toMatch(/you can lose your funds/);
    await expect.poll(() => page.title()).toMatch(/^Do not close this tab: \d\d:\d\d left$/);
    expect(await page.getByTestId('safe-banner').count()).toBe(0);

    // ---- the maker: notice on-chain first, then the XMR
    expect(await w.stepMakers()).toEqual(['1: prepared the XMR lock', '1: posted the notice', '1: relayed the XMR lock']);
    await text(page, /of 2 confirmations on every node/).waitFor({ timeout: 60_000 });
    await xmr.settle(1);
    // At depth on both nodes; the contract's minimum wait is still running, so the tab waits.
    const noticed = (await swapsOfTaker())[0]!;
    await w.warpTo(deadlinesOf('solana', noticed).tReadyMin!);

    // ---- ready is set by the session key: no wallet prompt, and the page turns green
    const safe = page.getByTestId('safe-banner');
    await safe.waitFor({ timeout: 60_000 });
    expect(wallet.signed).toBe(1);
    expect((await swapsOfTaker())[0]!.state).toBe(SWAP_STATE.READY);
    expect(await safe.innerText()).toContain('Safe to close');
    expect(await safe.innerText()).toMatch(/If the maker does not complete, come back before .+ to refund\./);
    expect(await banner.count()).toBe(0);
    await expect.poll(() => page.title()).toBe('Safe to close · XMR atomic swaps');

    // ---- the maker claims; the XMR is ours but not spendable before 10 blocks
    expect(await w.stepMakers()).toEqual(['1: claimed']);
    await text(page, /The XMR is yours, spendable in \d+ blocks?/).waitFor({ timeout: 60_000 });
    expect(await w.balance(maker.payout.publicKey)).toBe(payoutBefore + (75n * SOL) / 100n - (75n * SOL) / 100n / 2000n);
    await xmr.settle(9);
    await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 120_000 });
    await xmr.settle(1);
    await text(page, 'The XMR is in your wallet').waitFor({ timeout: 60_000 });

    // ---- the destination wallet really received it, and the swap account is closed by the session key
    const sweepTxid = await page.evaluate((ref) => (JSON.parse(localStorage.getItem(`xmrswap.note.${ref}`) ?? '{}') as { sweepTxid?: string }).sweepTxid, w.refOf(swap0!));
    expect(sweepTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(await xmr.isMined(sweepTxid!)).toBe(true);
    const got = await xmr.received(sweepTxid!);
    expect(got).not.toBeNull();
    expect(got! > (XMR / 2n) - xmr.REGTEST_MAX_FEE && got! < XMR / 2n).toBe(true);
    await expect.poll(async () => (await swapsOfTaker()).length, { timeout: 60_000 }).toBe(0);
    expect(wallet.signed).toBe(1);
    const m = await maker.record();
    expect([m.counters[COUNTER.locks], m.counters[COUNTER.readies], m.counters[COUNTER.completed]]).toEqual([1, 1, 1]);
    await page.getByRole('link', { name: /^Activity/ }).click();
    await expect.poll(() => page.getByTestId('activity-swap').getAttribute('data-leg')).toBe('swept');
    expect(errors).toEqual([]);
    await context.close();
  });
});
