// Amendment 1 in the browser, against svm-rpc with the real program and real XMR on regtest:
// a sell paid to a fresh payout address; a buy with a watcher where the tab is closed, a false
// notice is paused and the reopened tab refunds inside the pause; a pause from the user's own tab
// that is lifted when the lock turns out good; a swap resumed in a fresh browser profile from the
// wallet-derived key alone; and a lock refused at the protocol's cap.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { ata, deadlinesOf, seedSigner } from '@xmrswap/sdk';
import type { Browser, Page } from 'playwright-core';
import { connectWallet, injectWallet, launch, saveRecoveryFile, shots, watchErrors } from './driver.js';
import { SOL, type Stack, XMR, startStack } from './stack.js';
import * as xmr from './xmr.js';

let w: Stack;
let browser: Browser;
const DAY = 86_400;

beforeAll(async () => {
  // One maker whose offers allow a 24-hour pause, selling XMR for SOL and buying it for USDC.
  w = await startStack([{ price: (150n * SOL) / 100n, buys: true, terms: { wZ: DAY } }]);
  await xmr.funded();
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await w?.stop();
});
beforeEach(async () => {
  for (const m of w.makers) {
    await m.refresh();
    await m.refresh(1, 1, 150_000_000n);
  }
});

const refOf = (page: Page) => decodeURIComponent(new URL(page.url()).hash.split('/').pop()!);
const confirmAndLock = async (page: Page, name: RegExp) => {
  await page.getByTestId('lock-button').click();
  const confirm = page.getByTestId('confirm-lock');
  await confirm.getByRole('checkbox').check();
  await confirm.getByRole('button', { name }).click();
};
const usdcOf = async (owner: string) => {
  const r = await w.svm.call<{ value: { amount: string } } | null>('getTokenAccountBalance', [ata(owner, w.usdc).toBase58()]).catch(() => null);
  return r ? BigInt(r.value.amount) : null;
};

describe('selling XMR to a fresh payout address (11.2)', () => {
  it('the USDC is paid to an address that held nothing, its token account created by the session key at the claim', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const fresh = seedSigner(new Uint8Array(32).fill(123)).publicKey;
    expect(await w.balance(fresh)).toBe(0n);
    expect(await usdcOf(fresh)).toBeNull();
    const takerBefore = (await usdcOf(w.taker.publicKey))!;

    await page.goto(w.url);
    await connectWallet(page);
    await page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'Sell XMR' }).click();
    await page.getByRole('button', { name: 'USDC · Solana' }).click();
    await page.getByTestId('offer').getByRole('link', { name: 'Sell XMR' }).click();
    await page.getByLabel('XMR to sell').fill('0.25');
    await page.getByLabel('Your XMR refund address').fill(await xmr.walletAddress());
    await page.getByLabel('Pay the USDC to another address (optional)').fill(fresh);
    // The address is read from the chain before the take: it has no USDC account, and the page says who pays for one.
    await page.getByText('This address has no USDC account yet').first().waitFor();
    expect(await page.getByTestId('payout').innerText()).toMatch(/whoever sends the claim pays for it: 0\.\d+ SOL of account rent/);
    expect(await page.getByTestId('paid-to').innerText()).toContain(fresh.slice(0, 8));
    // The maker can pause this offer: said before the take.
    await page.getByText('This maker can pause the swap for up to 1 d').first().waitFor();
    await saveRecoveryFile(page);
    await shots(page, 'payout-field');
    await confirmAndLock(page, /^Post deposit/);
    await page.getByTestId('swap-page').waitFor();
    const ref = refOf(page);
    expect((await w.client.getSwap(ref))!.payoutAddress).toBe(fresh);
    expect(await page.getByTestId('bound-payout').innerText()).toMatch(/USDC is paid to[\s\S]*this was fixed when the offer was taken and cannot change\./);

    expect(await w.stepMakers()).toEqual(['1: funded']);
    const pay = page.getByTestId('pay-xmr');
    await pay.waitFor({ timeout: 60_000 });
    await xmr.pay((await pay.locator('code').first().getAttribute('title'))!, XMR / 4n);
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.NOTICED);
    await xmr.settle(2);
    await w.warpTo(deadlinesOf('solana', (await w.client.getSwap(ref))!).tReadyMin!);
    expect(await w.stepMakers()).toEqual(['1: set_ready']);
    await expect.poll(async () => (await w.client.getSwap(ref))?.state ?? SWAP_STATE.DONE, { timeout: 60_000 }).toBe(SWAP_STATE.DONE);

    // The proceeds (amount − 0.05% fee, with the deposit) are in the fresh address's new account; the taking wallet only got its deposit debited.
    await expect.poll(() => usdcOf(fresh), { timeout: 30_000 }).toBe(37_500_000n - 18_750n + 375_000n);
    expect((await usdcOf(w.taker.publicKey))!).toBe(takerBefore - 375_000n);
    expect(await w.balance(fresh)).toBe(0n);
    // One wallet signature in all: the take. The claim and the account creation were the session key's.
    expect(wallet.signed).toBe(1);
    expect((await w.makers[0]!.record()).counters[COUNTER.completed]).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe('buying XMR with a watcher (11.6)', () => {
  it('the watcher acknowledges, the tab is closed, a false notice is paused, and the reopened tab refunds inside the pause', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const maker = w.makers[0]!;

    await page.goto(w.url);
    await connectWallet(page);
    await page.getByTestId('offer').getByRole('link', { name: 'Buy XMR' }).click();
    await page.getByLabel('XMR to buy').fill('0.4');
    await page.getByLabel('Your XMR address').fill(await xmr.walletAddress());
    // The offer's pause window is shown before locking, with what a pause really adds on it.
    const option = page.getByTestId('watcher-option');
    expect(await option.innerText()).toMatch(/Without a watcher this tab must be back within 55 min of the maker's notice\. A pause adds between 23 h and 23 h 21 min/);
    await option.getByText("This site's watcher").click();
    await page.getByText('The watcher sees which swap you are in, its amount, its timing and the Monero transaction that pays you. It cannot move funds. It can fail.').waitFor();
    await option.getByTitle(w.watcher.key.publicKey).waitFor();
    const recoveryFile = await saveRecoveryFile(page);
    await shots(page, 'watcher-option');
    await confirmAndLock(page, /^Lock /);
    await page.getByTestId('swap-page').waitFor();
    const ref = refOf(page);
    expect((await w.client.getSwap(ref))!.watcherAddress).toBe(w.watcher.key.publicKey);

    // "Watcher acknowledged" appears only after the signed acknowledgement verified; then the red banner gives way to the qualified state.
    await page.getByText('Watcher acknowledged').first().waitFor({ timeout: 30_000 });
    expect([...w.watcher.watched.keys()]).toEqual([ref]);
    const watched = page.getByTestId('watched-banner');
    await watched.waitFor();
    expect(await watched.innerText()).toMatch(/Safe to close, with a watcher/);
    expect(await page.getByTestId('watched-text').innerText()).toMatch(/A watcher will pause this swap if the lock does not check out\. If it does, come back before .+ to refund; coming back late, or a watcher that fails, can still cost you your payment\. A refund after a pause can cost the deposit of 0\.006 SOL\./);
    expect(await page.getByTestId('risk-banner').count()).toBe(0);
    expect(await page.getByTestId('safe-banner').count()).toBe(0);
    await shots(page, 'watched-safe-to-close');
    expect(errors).toEqual([]);

    // ---- the tab is closed for good
    await context.close();

    // ---- the maker announces a lock that pays too little; at the cutoff the watcher pauses the swap
    maker.shortBy = XMR / 10n;
    await w.stepMakers();
    maker.shortBy = 0n;
    await xmr.settle(2);
    const noticed = (await w.client.getSwap(ref))!;
    const d = deadlinesOf('solana', noticed);
    await w.warpTo(d.tCut! - 1n);
    expect(await w.watcher.step()).toEqual([]);
    await w.warpTo(d.tCut!);
    expect(await w.watcher.step()).toEqual([`watcher: froze ${ref.slice(0, 6)} (lock-not-confirmed)`]);
    const frozen = (await w.client.getSwap(ref))!;
    expect(frozen.state).toBe(SWAP_STATE.FROZEN);
    expect((await maker.record()).counters[COUNTER.freezes]).toBeGreaterThanOrEqual(1);

    // ---- hours later, long past the moment the maker could otherwise have taken the payment
    await w.warpTo(d.tCo! + 4n * 3600n);
    expect((await w.client.getSwap(ref))!.state).toBe(SWAP_STATE.FROZEN);

    // ---- a new tab, from the recovery file: it checks the lock itself and refunds inside the pause
    const context2 = await browser.newContext({ acceptDownloads: true });
    const wallet2 = await injectWallet(context2, w.taker);
    const page2 = await context2.newPage();
    const errors2 = watchErrors(page2);
    await page2.goto(`${w.url}/#/activity`);
    await page2.getByRole('button', { name: 'I already have one' }).click();
    await page2.locator('input[type=file]').setInputFiles({ name: 'xmrswap-recovery.json', mimeType: 'application/json', buffer: Buffer.from(recoveryFile) });
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.HOLD);
    await page2.locator(`a[href="#/swap/${ref}"]`).first().click();
    await page2.getByText('This tab refunded by itself').first().waitFor();
    expect(await page2.getByTestId('swap-page').innerText()).toMatch(/The swap was paused, and when this tab checked the lock itself it did not check out, so the tab refunded inside the pause/);
    expect((await maker.record()).counters[COUNTER.refunds_after_freeze]).toBeGreaterThanOrEqual(1);
    expect(wallet.signed).toBe(1);
    expect(wallet2.signed).toBe(0);
    expect(errors2).toEqual([]);
    await context2.close();
  });

  it('the user pauses from their own tab; the paused state is shown; a lock that turns out good lifts the pause', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(w.url);
    await connectWallet(page);
    await page.getByTestId('offer').getByRole('link', { name: 'Buy XMR' }).click();
    await page.getByLabel('XMR to buy').fill('0.4');
    await page.getByLabel('Your XMR address').fill(await xmr.walletAddress());
    await page.getByTestId('watcher-option').getByText("This site's watcher").click();
    await page.getByTestId('watcher-option').getByTitle(w.watcher.key.publicKey).waitFor();
    await saveRecoveryFile(page);
    await confirmAndLock(page, /^Lock /);
    await page.getByTestId('swap-page').waitFor();
    const ref = refOf(page);

    // An honest lock, one block deep (the swap needs two): valid, but not confirmed yet.
    await w.stepMakers();
    await page.getByText(/of 2 confirmations on every node/).first().waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Pause this swap' }).click();
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.FROZEN);
    const panel = page.getByTestId('frozen');
    await panel.waitFor();
    expect(await panel.innerText()).toMatch(/This swap is paused/);
    expect(await panel.innerText()).toMatch(/Paused by this tab, at your request/);
    expect(await panel.innerText()).toMatch(/Two ways forward/);
    await panel.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120));
    await shots(page, 'frozen');
    // Paused by the session key: the wallet was not asked.
    expect(wallet.signed).toBe(1);

    // The second block arrives: the tab checks the lock itself and sets ready, which lifts the pause.
    await xmr.settle(1);
    await w.warpTo(deadlinesOf('solana', (await w.client.getSwap(ref))!).tReadyMin!);
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.READY);
    await page.getByText('The pause was lifted: the lock is good').first().waitFor();
    await page.getByTestId('safe-banner').waitFor();
    expect(await w.stepMakers()).toEqual(['1: claimed']);
    expect(wallet.signed).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe('the wallet-derived key (11.3)', () => {
  it('a swap opened with the wallet key is resumed in a fresh browser profile from the wallet alone', async () => {
    // A wallet of its own: the key is proved against every swap a wallet has on-chain, and the shared
    // test wallet has swaps that were opened with recovery files (for which the mode is, rightly, refused).
    const alice = seedSigner(new Uint8Array(32).fill(99));
    await w.svm.airdrop(alice.publicKey, 10n * SOL);
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, alice);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(w.url);
    await connectWallet(page);
    await page.getByTestId('offer').getByRole('link', { name: 'Buy XMR' }).click();
    await page.getByLabel('XMR to buy').fill('0.3');
    await page.getByLabel('Your XMR address').fill(await xmr.walletAddress());
    expect(await page.getByTestId('lock-button').isDisabled()).toBe(true);

    // The separate, opt-in choice, with its three warnings and a box to tick before anything is signed.
    await page.getByText('Another way: use my wallet key (advanced, off by default)').click();
    const choice = page.getByTestId('wallet-key');
    const warnings = await choice.getByTestId('wallet-key-warnings').getByRole('listitem').allInnerTexts();
    expect(warnings).toEqual([
      'Anyone who obtains this signature, for example a phishing site that asks you to sign the same message, can take XMR you have not yet collected and act on your open swaps.',
      'If you lose this wallet you lose access to those swaps unless you also export a recovery file.',
      'Only sign this message on xmrswap.test.',
    ]);
    await shots(page, 'wallet-key-choice');
    expect(wallet.messages).toBe(0);
    await choice.getByRole('checkbox').check();
    await choice.getByRole('button', { name: 'Sign with my wallet to unlock' }).click();
    await page.locator('[data-testid="backup"][data-state="saved"]').waitFor();
    // A wallet that is new here signs twice, and the two signatures must be identical.
    expect(wallet.messages).toBe(2);
    await expect.poll(() => page.getByTestId('lock-button').isDisabled()).toBe(false);
    await confirmAndLock(page, /^Lock /);
    await page.getByTestId('swap-page').waitFor();
    const ref = refOf(page);
    expect(errors).toEqual([]);
    await context.close();

    // The maker locks real XMR while no tab is open.
    await w.stepMakers();
    await xmr.settle(1);
    await w.warpTo(deadlinesOf('solana', (await w.client.getSwap(ref))!).tReadyMin! + 30n);
    expect((await w.client.getSwap(ref))!.state).toBe(SWAP_STATE.NOTICED);

    // The shared test wallet has swaps opened with recovery files: for it the mode is refused, in plain words.
    const context3 = await browser.newContext({ acceptDownloads: true });
    const wallet3 = await injectWallet(context3, w.taker);
    const page3 = await context3.newPage();
    await page3.goto(`${w.url}/#/activity`);
    await connectWallet(page3);
    await page3.getByText('Another way: use my wallet key (advanced, off by default)').click();
    await page3.getByTestId('wallet-key').getByRole('checkbox').check();
    await page3.getByTestId('wallet-key').getByRole('button', { name: 'Sign with my wallet to unlock' }).click();
    await page3.getByText('The wallet key was not set up').first().waitFor();
    expect(await page3.getByTestId('wallet-key').getByRole('alert').innerText()).toMatch(/does not produce the keys of the swaps this wallet already has on-chain[\s\S]*load the recovery file to resume them/);
    expect(wallet3.messages).toBe(1);
    await context3.close();

    // A fresh profile: no file, no storage. The wallet signs once and the key is proved against the swaps found on-chain.
    const context2 = await browser.newContext({ acceptDownloads: true });
    const wallet2 = await injectWallet(context2, alice);
    const page2 = await context2.newPage();
    const errors2 = watchErrors(page2);
    await page2.goto(`${w.url}/#/activity`);
    await connectWallet(page2);
    await page2.getByText('Another way: use my wallet key (advanced, off by default)').click();
    const choice2 = page2.getByTestId('wallet-key');
    await choice2.getByRole('checkbox').check();
    await choice2.getByRole('button', { name: 'Sign with my wallet to unlock' }).click();
    await expect.poll(async () => (await w.client.getSwap(ref))!.state, { timeout: 60_000 }).toBe(SWAP_STATE.READY);
    expect(wallet2.messages).toBe(1);
    expect(wallet2.signed).toBe(0);
    await page2.getByTestId('safe-banner').waitFor();
    expect(await w.stepMakers()).toEqual(['1: claimed']);
    expect(errors2).toEqual([]);
    await context2.close();
  });
});

describe('the protocol cap (11.1) and the release record (11.5)', () => {
  it('shows the limits where the amount is chosen, and a lock refused at the cap says so and locks nothing', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const wallet = await injectWallet(context, w.taker);
    const page = await context.newPage();
    const errors = watchErrors(page);
    const open = (await w.client.getCaps(0)).openValue;
    await w.setCaps([SOL, 100_000_000_000n], [open + 2n * SOL, 10_000_000_000_000n]);
    try {
      await page.goto(w.url);
      await connectWallet(page);
      expect(await page.getByTestId('caps-line').innerText()).toMatch(/Beta limits: at most 1\.00 SOL per swap\..*leaving room for 2\.00 SOL\. These are limits of the protocol during its beta, not of any maker\./);
      await page.getByTestId('offer').getByRole('link', { name: 'Buy XMR' }).click();
      // Over the per-swap cap: refused at the field, with the largest size that fits.
      await page.getByLabel('XMR to buy').fill('2');
      await page.getByRole('alert').filter({ hasText: "above the protocol's beta limit of 1.00 SOL per swap" }).waitFor();
      expect(await page.getByRole('alert').filter({ hasText: 'beta limit' }).innerText()).toMatch(/The largest this offer can take under the limit right now is 0\.6666 XMR/);
      await page.getByLabel('XMR to buy').fill('0.5');
      await page.getByLabel('Your XMR address').fill(await xmr.walletAddress());
      await saveRecoveryFile(page);
      await expect.poll(() => page.getByTestId('lock-button').isDisabled()).toBe(false);
      await page.getByTestId('lock-button').click();
      const confirm = page.getByTestId('confirm-lock');
      await confirm.getByRole('checkbox').check();
      // Between the review and the lock the admin lowers the cap: the lock is refused, as the cap, before the wallet is asked.
      await w.setCaps([SOL / 2n, 100_000_000_000n], [open + 2n * SOL, 10_000_000_000_000n]);
      await confirm.getByRole('button', { name: /^Lock / }).click();
      const alert = confirm.getByRole('alert');
      await alert.waitFor();
      expect(await alert.innerText()).toMatch(/Nothing was locked/);
      expect(await alert.innerText()).toMatch(/above the protocol's beta limit of 0\.50 SOL per swap\. It is a limit of the protocol, not of this maker/);
      await shots(page, 'caps-reached');
      expect(wallet.signed).toBe(0);
      expect((await w.client.getCaps(0)).openValue).toBe(open);

      // Caps at zero: "not open yet", as information.
      await w.setCaps([0n, 0n], [0n, 0n]);
      await page.goto(`${w.url}/#/`);
      await page.reload();
      await page.getByText('The protocol is not open yet').first().waitFor();
      expect(await page.locator('#caps-closed').getAttribute('data-kind')).toBe('info');
    } finally {
      await w.setCaps([100n * SOL, 100_000_000_000n], [10_000n * SOL, 10_000_000_000_000n]);
    }

    // The Status page: which build the server says this is, stated as a development snapshot, next to what the page computed itself.
    await page.goto(`${w.url}/#/status`);
    const release = page.getByTestId('release');
    await release.getByText('Development snapshot').first().waitFor();
    const text = await release.innerText();
    expect(text).toMatch(/dev-snapshot/);
    expect(text).toMatch(/0123456789abcdef0123456789abcdef01234567/);
    expect(text).toMatch(/Its program hash comes from a local build/);
    await expect.poll(() => page.getByTestId('program-build').getAttribute('data-status'), { timeout: 30_000 }).toBe('unpublished');
    expect(await page.getByTestId('program-build').innerText()).toMatch(/^[0-9a-f]{64}\s+Computed by this page from the chain\. There is no published build to compare with/);
    await release.scrollIntoViewIfNeeded();
    await shots(page, 'release-panel');
    expect(errors).toEqual([]);
    await context.close();
  });
});
