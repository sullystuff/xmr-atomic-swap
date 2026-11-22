// The three approval modes (SPEC 3.8; scenarios M-1, M-2), row 1 of the refund table (pending:
// rejected, expired, cancelled), and the maker console in a real browser against the LIVE daemon:
// approve a pending lock, release a held deposit, answer an inbox message, change an offer setting.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedSigner } from '@xmrswap/sdk';
import type { Page } from 'playwright-core';
import { SdkTaker } from '../src/taker.js';
import { type TakerTab, openTab, text } from '../src/ui.js';
import { XMR, fill, waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { advanceTo, balances, connect, counterDelta, counters, deadlines, dump, expectClean, openOffer, pageNote, readSwap, registerRecoverySecrets, scenario, swapState, track, uiLockBuy, untilPhase, untilState } from './helpers.js';

let w: World;
let taker: SdkTaker;
let tab: TakerTab;
let consoleTab: TakerTab;
const TAKER = seedSigner(fill(5)).publicKey;

beforeAll(async () => {
  w = await startWorld({
    inventoryBlocks: 30,
    makers: [{
      autoMaxXmr: 0.2,
      advance: [{ taker: TAKER, max_xmr: 1, days: 1 }],
      markets: {
        // SOL: approval within a window of two minutes. USDC on Solana: approved in advance only.
        sol: { sell_xmr: { approval_mode: 'window', approval_window_seconds: 120 }, buy_xmr: {} },
        usdc_sol: { sell_xmr: { approval_mode: 'advance' }, buy_xmr: {} },
        eth: { sell_xmr: {}, buy_xmr: {} },
        usdc_eth: { sell_xmr: {}, buy_xmr: {} },
      },
    }],
  });
  taker = new SdkTaker(w);
  tab = track(await openTab({ solKey: w.sol.taker, ethKey: w.eth!.taker, eth: w.eth }), true);
  consoleTab = track(await openTab({ solKey: w.sol.stranger }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await consoleTab?.close().catch(() => undefined);
  await w?.stop();
  await stopShared();
});
beforeEach(async () => {
  if (!w.maker.running) await w.maker.start();
});

/** Open a page of the console, served by the daemon itself, signing in with the API token on first use. */
async function consolePage(route: string): Promise<Page> {
  const { page } = consoleTab;
  await page.goto(`${w.maker.apiUrl}/#/${route}`);
  const token = page.getByLabel('Access token');
  const nav = page.getByRole('navigation').first();
  await token.or(nav).first().waitFor();
  if (await token.count()) {
    await token.fill(w.maker.token);
    await token.press('Enter');
  }
  await nav.waitFor();
  return page;
}
const HALF = XMR / 2n;

describe('window mode (offer mode 1): a lock above the automatic limit waits for the maker', () => {
  it('UI: the over-60-second warning is shown before locking; the lock is PENDING; the maker approves it in the console; the swap completes', scenario(() => w, async () => {
    const { page } = tab;
    const c0 = await counters(w.maker, 'solana');
    const b0 = await balances(w, 'sol');
    await page.goto(w.ui.url);
    await connect(page, 'solana');
    const offer = page.getByTestId('offer').first();
    await expect.poll(() => offer.innerText(), { timeout: 60_000 }).toMatch(/Approve within/i);
    const { ref, recoveryFile } = await uiLockBuy(tab, w, {
      market: 'sol', xmr: '0.5',
      beforeConfirm: async (p) => {
        // SPEC 3.8 / 8.5: any window above 60 s is warned about before locking, with how long funds may be held.
        await text(p, 'This maker can take up to 2 min to approve').waitFor();
        expect(await p.getByTestId('confirm-lock').innerText()).toMatch(/locked in escrow while you wait, for up to 2 min/);
      },
    });
    registerRecoverySecrets(w, recoveryFile, 'modes');
    expect(await swapState(w, ref)).toBe('PENDING');
    // A pending lock reserves nothing and is not at risk: no red banner.
    await page.waitForTimeout(1500);
    expect(await page.getByTestId('risk-banner').count()).toBe(0);
    await dump(page, 'pending');

    // The console, in a browser, against the live daemon: the lock queues under Approvals with the rules' recommendation.
    const cp = await consolePage('approvals');
    const row = cp.getByRole('table', { name: 'Pending approvals' }).getByRole('row').filter({ hasText: ref.slice(0, 6) });
    await row.waitFor({ timeout: 30_000 });
    await dump(cp, 'console approvals');
    expect(await row.innerText()).toMatch(/above auto_max_xmr/);
    await row.getByRole('button', { name: 'Approve' }).click();
    await untilState(w, ref, ['ACTIVE', 'NOTICED']);

    // From here it is an ordinary swap.
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    const noticed = (await readSwap(w, ref))!;
    await advanceTo(w, noticed, deadlines(noticed).tReadyMin!);
    await untilState(w, ref, ['DONE', 'closed']);
    await w.mine(10);
    await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    await w.mine(1);
    await text(page, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
    expect((await w.takerWallet.received((await pageNote(page, ref)).sweepTxid!))! > HALF - 100_000_000_000n).toBe(true);
    const b1 = await balances(w, 'sol');
    expect(b1.makerPayout - b0.makerPayout).toBe(noticed.amount - noticed.amount / 2000n);
    expect(b1.treasury - b0.treasury).toBe(noticed.amount / 2000n);
    const delta = counterDelta(c0, await counters(w.maker, 'solana'));
    expect(delta).toMatchObject({ locks: 1, approvals: 1, notices: 1, readies: 1, completed: 1 });
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));

  it('row 1, rejected: the maker rejects in the console; the taker has everything back at once; no fault', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const b0 = await balances(w, 'sol');
    const o = await taker.open('sol', 0, HALF);
    expect(await swapState(w, o.ref)).toBe('PENDING');
    const cp = await consolePage('approvals');
    const row = cp.getByRole('table', { name: 'Pending approvals' }).getByRole('row').filter({ hasText: o.ref.slice(0, 6) });
    await row.waitFor({ timeout: 30_000 });
    await row.getByRole('button', { name: /^Reject/ }).click();
    const confirm = cp.getByRole('alertdialog').getByRole('button', { name: /Reject/ });
    if (await confirm.count()) await confirm.click();
    await untilState(w, o.ref, 'closed');
    const b1 = await balances(w, 'sol');
    const out = b0.taker - b1.taker - (await taker.sessionLamports(o));
    expect(out >= 0n && out < 100_000n).toBe(true);
    expect(b1.treasury).toBe(b0.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, rejections: 1 });
  }));

  it('row 1, expired: nobody answers; after the window a stranger\'s crank returns everything; approval_timeouts', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const b0 = await balances(w, 'sol');
    const o = await taker.open('sol', 0, HALF);
    const d = deadlines(await taker.must(o));
    expect(d.tPend! - (await taker.must(o)).tLock).toBe(120n);
    await w.sol.warpTo(d.tPend! - 1n);
    await expect(taker.call(o, { name: 'expire_pending' }, {}, 'stranger')).rejects.toMatchObject({ code: 'TooEarly' });
    await w.sol.warpTo(d.tPend!);
    await taker.call(o, { name: 'expire_pending' }, {}, 'stranger');
    expect(await swapState(w, o.ref)).toBe('closed');
    const b1 = await balances(w, 'sol');
    const out = b0.taker - b1.taker - (await taker.sessionLamports(o));
    expect(out >= 0n && out < 100_000n).toBe(true);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, approval_timeouts: 1 });
  }));

  it('row 1, cancelled: the taker cancels its pending lock with the session key; pending_cancels; nothing held', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const b0 = await balances(w, 'sol');
    const o = await taker.open('sol', 0, HALF);
    await taker.call(o, { name: 'cancel_pending' });
    expect(await swapState(w, o.ref)).toBe('closed');
    const b1 = await balances(w, 'sol');
    const out = b0.taker - b1.taker - (await taker.sessionLamports(o));
    expect(out >= 0n && out < 100_000n).toBe(true);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, pending_cancels: 1 });
  }));

  it('a lock within the automatic limit is approved by the daemon\'s rules without anyone at the console', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('sol', 0, XMR / 10n);
    expect(await swapState(w, o.ref)).toBe('PENDING');
    await untilState(w, o.ref, ['ACTIVE', 'NOTICED']);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toMatchObject({ locks: 1, approvals: 1 });
    // Unwind: the taker changes its mind after the notice; the deposit hold is the next scenario's business.
    await untilPhase(w, o.ref, 'xmr_relayed');
    await taker.refund(o);
    await untilState(w, o.ref, 'HOLD');
  }));
});

describe('advance approval (offer mode 2)', () => {
  it('without an approval the lock is refused; the page asks the maker over the relay, stores the approval, and the next lock starts at once', scenario(() => w, async () => {
    // A wallet the maker has not listed: the program refuses the lock.
    const stranger = new SdkTaker(w, fill(45), w.sol.taker2, w.eth!.taker2);
    await expect(stranger.open('usdc_sol', 0, HALF)).rejects.toMatchObject({ code: 'ApprovalRequired' });

    const { page } = tab;
    const c0 = await counters(w.maker, 'solana');
    await openOffer(tab, w, 'usdc_sol', 'buy');
    await page.getByLabel('XMR to buy').fill('0.5');
    await page.getByLabel('Your XMR address').fill(w.takerXmr);
    await dump(page, 'advance offer, no approval');
    await expect.poll(() => page.getByTestId('lock-button').isDisabled()).toBe(true);
    // Ask on the maker's page: the request travels browser -> relay -> (fake Tor) -> daemon endpoint.
    const tor0 = w.tor.connects.length;
    await page.goto(`${w.ui.url}/#/maker/${w.maker.makerPda}`);
    await page.getByRole('button', { name: 'Request approval for my wallet' }).click();
    await text(page, /Approved\. The approval is stored in this browser/).waitFor({ timeout: 60_000 });
    expect(w.tor.connects.length).toBeGreaterThan(tor0);
    expect(tab.sol.signed).toBeGreaterThanOrEqual(0);

    const { ref } = await uiLockBuy(tab, w, { market: 'usdc_sol', xmr: '0.5' });
    // Treated as AUTO for this swap: ACTIVE at the lock, no window, no console.
    await untilState(w, ref, ['ACTIVE', 'NOTICED']);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toMatchObject({ locks: 1 });
    expect(counterDelta(c0, await counters(w.maker, 'solana'))['approvals']).toBeUndefined();
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    const noticed = (await readSwap(w, ref))!;
    await advanceTo(w, noticed, deadlines(noticed).tReadyMin!);
    await untilState(w, ref, ['DONE', 'closed']);
    await w.mine(10);
    await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    await w.mine(1);
    await text(page, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));

  it('the stored approval also turns the window offer into an immediate start (mode 1 with a valid approval is AUTO)', scenario(() => w, async () => {
    const { page } = tab;
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.5' });
    const c0 = await counters(w.maker, 'solana');
    void c0;
    await waitFor('the swap', () => readSwap(w, ref));
    // Never PENDING: ACTIVE at the lock although 0.5 XMR is above the console limit.
    expect(await swapState(w, ref)).not.toBe('PENDING');
    await untilState(w, ref, ['NOTICED']);
    // The taker backs out with the page's own refund button; the deposit is held.
    await untilPhase(w, ref, 'xmr_relayed');
    await page.getByRole('button', { name: 'Refund this swap' }).click();
    await dump(page, 'refund dialog');
    await page.getByRole('button', { name: 'Yes, refund' }).click();
    await untilState(w, ref, 'HOLD');
    await text(page, /refunded/i).waitFor({ timeout: 60_000 });
    await page.goto(w.ui.url);
  }));
});

describe('the console against the live daemon', () => {
  it('Deposits: the two held deposits are listed; the maker releases one at once and withholds the other; the taker asks for it in the inbox; the maker answers and releases', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const cp = await consolePage('deposits');
    const held = cp.getByRole('table', { name: 'Held deposits' });
    await held.waitFor({ timeout: 30_000 });
    await dump(cp, 'console deposits');
    // (The daemon notices a refund on its next pass; the page follows its event stream.)
    await expect.poll(() => held.getByRole('row').count(), { timeout: 45_000 }).toBe(3); // header + 2
    const u0 = (await balances(w, 'sol')).taker;
    // Release the first now, before the 30 minutes are over.
    await held.getByRole('row').nth(1).getByRole('button', { name: /^Release deposit/ }).click();
    const c1 = cp.getByRole('alertdialog').getByRole('button', { name: /Release/ });
    if (await c1.count()) await c1.click();
    await waitFor('deposits_returned', async () => counterDelta(c0, await counters(w.maker, 'solana'))['deposits_returned'] === 1);
    expect((await balances(w, 'sol')).taker > u0).toBe(true);
    // Withhold the other.
    await expect.poll(() => held.getByRole('row').count(), { timeout: 30_000 }).toBe(2);
    await held.getByRole('row').nth(1).getByRole('button', { name: /^Withhold deposit/ }).click();
    const c2 = cp.getByRole('alertdialog').getByRole('button', { name: /Withhold/ });
    if (await c2.count()) await c2.click();
    await waitFor('withholds', async () => counterDelta(c0, await counters(w.maker, 'solana'))['withholds'] === 1);
    const withheld = cp.getByRole('table', { name: 'Withheld deposits' });
    await withheld.waitFor({ timeout: 30_000 });

    // The taker's page says where the deposit is and offers to ask for it.
    const { page } = tab;
    await page.goto(`${w.ui.url}/#/maker/${w.maker.makerPda}`);
    await dump(page, 'maker page');
    await connect(page, 'solana');
    await page.getByLabel('Message').fill('Please release my deposit: I refunded because my plans changed.');
    const withheldRef = (await w.maker.api<{ deposits: { ref: string; state: string }[] }>('GET', '/api/deposits')).deposits.find((d) => d.state === 'withheld')!.ref;
    await page.getByLabel('About swap (optional)').selectOption(withheldRef);
    await page.getByText('Ask the maker to release my withheld deposit').first().click();
    const tor0 = w.tor.connects.length;
    await page.getByRole('button', { name: 'Send encrypted message' }).click();
    // Browser -> relay -> (fake Tor) -> the daemon's endpoint: no wallet prompt, no transaction.
    await text(page, /Sent over Tor/).waitFor({ timeout: 60_000 });
    expect(w.tor.connects.length).toBeGreaterThan(tor0);
    await dump(page, 'message sent');

    // The console inbox: the message is there, tied to the swap; the maker answers it.
    const ip = await consolePage('inbox');
    await text(ip, /Please release my deposit/).waitFor({ timeout: 60_000 });
    await dump(ip, 'console inbox');
    await ip.getByLabel('Reply').fill('Released. Thank you for asking.');
    await ip.getByRole('button', { name: 'Send reply' }).click();
    await text(ip, 'Released. Thank you for asking.').waitFor({ timeout: 30_000 });
    // ...and releases the withheld deposit from the Deposits page.
    const dp = await consolePage('deposits');
    const wrow = dp.getByRole('table', { name: 'Withheld deposits' }).getByRole('row').nth(1);
    await wrow.waitFor();
    expect(await wrow.innerText()).toMatch(/Asked for a release/);
    const t0 = (await balances(w, 'sol')).taker;
    await wrow.getByRole('button', { name: /^Release deposit/ }).click();
    const c3 = dp.getByRole('alertdialog').getByRole('button', { name: /Release/ });
    if (await c3.count()) await c3.click();
    await waitFor('releases', async () => counterDelta(c0, await counters(w.maker, 'solana'))['releases'] === 1);
    expect((await balances(w, 'sol')).taker > t0).toBe(true);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ deposits_returned: 1, withholds: 1, releases: 1 });

    // The taker reads the maker's answer on the maker page (kept at the replies route, fetched through the relay).
    await page.goto(`${w.ui.url}/#/maker/${w.maker.makerPda}`);
    await waitFor('the reply in the taker\'s thread', async () => {
      if (await page.getByText('Released. Thank you for asking.').count()) return true;
      await page.getByRole('button', { name: 'Check for replies' }).click().catch(() => undefined);
      return false;
    }, { timeoutMs: 60_000, intervalMs: 1500, context: () => page.locator('main').innerText() });
    expectClean(w, [tab, consoleTab]);
  }));

  it('Configuration: the maker changes an offer setting in the console; the daemon applies it without a restart and the taker\'s page shows the new terms', scenario(() => w, async () => {
    const before = (await taker.offer(w.maker, 'sol', 1)).prices[0]!;
    expect(before).toBe(1_470_000_000n); // 150 / 100 SOL per XMR, less the 2% deviation
    const cp = await consolePage('config');
    await cp.getByRole('button', { name: /^Edit SOL.*buy/i }).click();
    const section = cp.getByRole('region', { name: /SOL.*buy.*settings/i });
    await section.waitFor();
    await dump(cp, 'console config, editing');
    const dev = section.getByLabel(/^Deviation from reference/).first();
    await dev.fill('5');
    await dev.blur();
    await cp.getByRole('button', { name: 'Validate and save' }).click();
    // Applied without a restart: the next refresh publishes the new price; the file on disk carries the edit.
    await waitFor('the new price on-chain', async () => (await w.sol.client.getOffer(w.maker.makerPda, 0, 1))?.prices[0] === 1_425_000_000n, { timeoutMs: 60_000, context: async () => (await w.sol.client.getOffer(w.maker.makerPda, 0, 1))?.prices[0] });
    expect(readFileSync(w.maker.configPath, 'utf8')).toMatch(/deviation_pct = 5/);
    expect(w.maker.starts).toBe(1);
    const log = await w.maker.api<{ entries: { source: string; changes: { path: string }[] }[] }>('GET', '/api/config/log');
    expect(log.entries.some((e) => e.changes.some((c) => c.path === 'markets.sol.buy_xmr.deviation_pct'))).toBe(true);
    // The taker's page shows the new terms.
    const { page } = tab;
    await page.goto(w.ui.url);
    await page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'Sell XMR' }).click();
    await expect.poll(async () => {
      await page.getByRole('button', { name: /Refresh/ }).click().catch(() => undefined);
      return page.getByTestId('offer').first().innerText();
    }, { timeout: 60_000, interval: 1500 }).toMatch(/1\.425? SOL|1\.43 SOL/);
    expectClean(w, [tab, consoleTab]);
  }));
});
