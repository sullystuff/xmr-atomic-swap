// The three approval modes (SPEC 3.8; scenarios M-1, M-2), row 1 of the refund table (pending:
// rejected, expired, cancelled), and the maker console in a real browser against the LIVE daemon:
// approve a pending lock, release a held deposit, answer an inbox message, change an offer setting.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ETH_ANY_DIRECTION, ETH_ANY_TOKEN, SOL_APPROVAL_ANY, base58Decode } from '@xmrswap/protocol';
import type { AdvanceApprovalRecord } from '@xmrswap/protocol/daemon-api';
import { ata, seedSigner, signSolApproval } from '@xmrswap/sdk';
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
/** A browser that holds the maker's cold owner wallet (for owner-signed console actions). */
let ownerTab: TakerTab;
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
        // USDC on Ethereum: approved in advance only.
        usdc_eth: { sell_xmr: { approval_mode: 'advance' }, buy_xmr: {} },
      },
    }],
  });
  taker = new SdkTaker(w);
  tab = track(await openTab({ solKey: w.sol.taker, ethKey: w.eth!.taker, eth: w.eth }), true);
  consoleTab = track(await openTab({ solKey: w.sol.stranger }), true);
  ownerTab = track(await openTab({ solKey: w.maker.solOwner }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await consoleTab?.close().catch(() => undefined);
  await ownerTab?.close().catch(() => undefined);
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

/** Press a deposit action in the console (and its confirmation) once, and wait for its effect on-chain. */
async function pressUntil(page: Page, row: ReturnType<Page['locator']>, name: RegExp, done: () => Promise<boolean>): Promise<void> {
  await row.getByRole('button', { name }).first().click();
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: new RegExp(name.source.replace('^', '').split(' ')[0]!) });
  if (await confirm.count()) await confirm.click();
  await waitFor(`the console's "${name.source}" to take effect`, done, { timeoutMs: 60_000, context: () => page.locator('main').innerText() });
  // The daemon answered "carried out"; a refusal here would be shown in place.
  expect(await page.locator('[data-outcome="refused"]').count()).toBe(0);
}

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
    // The daemon answers every operator instruction: this one was carried out.
    expect((await w.maker.swapDetail(o.ref)).instruction).toMatchObject({ action: 'reject', status: 'carried_out' });
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
    const prompts = tab.sol.signed;
    await page.goto(`${w.ui.url}/#/maker/${w.maker.makerPda}`);
    await page.getByRole('button', { name: 'Request approval for my wallet' }).click();
    await text(page, /Approved\. The approval is stored in this browser/).waitFor({ timeout: 60_000 });
    expect(w.tor.connects.length).toBeGreaterThan(tor0);
    // Asked and answered off-chain: the wallet was not involved.
    expect(tab.sol.signed).toBe(prompts);

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
    await pressUntil(cp, held.getByRole('row').nth(1), /^Release deposit/, async () => counterDelta(c0, await counters(w.maker, 'solana'))['deposits_returned'] === 1);
    expect((await balances(w, 'sol')).taker > u0).toBe(true);
    // Withhold the other.
    await expect.poll(() => held.getByRole('row').count(), { timeout: 30_000 }).toBe(2);
    await pressUntil(cp, held.getByRole('row').nth(1), /^Withhold deposit/, async () => counterDelta(c0, await counters(w.maker, 'solana'))['withholds'] === 1);
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
    await pressUntil(dp, wrow, /^Release deposit/, async () => counterDelta(c0, await counters(w.maker, 'solana'))['releases'] === 1);
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

  it('Configuration: the maker changes an offer setting in the console and saves; the daemon applies it without a restart; the rest of the file is kept; the taker\'s page shows the new terms (formerly BUG-2)', scenario(() => w, async () => {
    const before = (await taker.offer(w.maker, 'sol', 1)).prices[0]!;
    expect(before).toBe(1_470_000_000n); // 150 / 100 SOL per XMR, less the 2% deviation
    const cp = await consolePage('config');
    await cp.getByRole('button', { name: /^Edit SOL.*buy/i }).click();
    const section = cp.getByRole('region', { name: /SOL.*buy.*settings/i });
    const dev = section.getByLabel(/^Deviation from reference/).first();
    await dev.fill('5');
    await dev.blur();
    await cp.getByRole('button', { name: 'Validate and save' }).click();
    // Applied without a restart: the next refresh publishes the new price; the file on disk carries the edit.
    await waitFor('the new price on-chain', async () => (await w.sol.client.getOffer(w.maker.makerPda, 0, 1))?.prices[0] === 1_425_000_000n, { timeoutMs: 60_000, context: async () => (await w.sol.client.getOffer(w.maker.makerPda, 0, 1))?.prices[0] });
    expect(readFileSync(w.maker.configPath, 'utf8')).toMatch(/deviation_pct = 5/);
    // The file still carries the loopback price source this harness runs on (the key the console once refused): the save patched one line.
    expect(readFileSync(w.maker.configPath, 'utf8')).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+"/);
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

describe('operator instructions from the console are always answered', () => {
  it('abort after the taker set ready is refused, with the reason shown in place; the swap completes', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'solana');
    const o = await taker.open('sol', 0, XMR / 10n);
    await untilState(w, o.ref, 'NOTICED');
    await untilPhase(w, o.ref, 'xmr_relayed');
    await w.mine(2);
    await w.sol.warpTo(deadlines(await taker.must(o)).tReadyMin!);
    await waitFor('the lock at depth', async () => (await taker.verify(o)).ok);
    const cp = await consolePage(`swaps/${o.ref}`);
    await cp.getByRole('button', { name: 'Abort swap' }).click();
    const confirm = cp.getByRole('alertdialog').getByRole('button', { name: /Abort/ });
    await confirm.waitFor();
    await dump(cp, 'console swap page, abort question');
    // Ready lands on-chain while the operator's finger is on the button.
    await taker.call(o, { name: 'set_ready' });
    await confirm.click();
    const refused = cp.locator('[data-outcome="refused"]').first();
    await refused.waitFor({ timeout: 30_000 });
    await dump(cp, 'console swap page, abort refused');
    // Usually `ready-already-set`; if the daemon's own pass got in first, the swap is already claimed or past the state.
    expect(['ready-already-set', 'already-settled', 'not-available-in-state']).toContain(await refused.getAttribute('data-reason'));
    expect((await refused.innerText()).length).toBeGreaterThan(20);
    await untilState(w, o.ref, 'DONE');
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, approvals: 1, notices: 1, readies: 1, completed: 1 });
  }));

  it('the pause switch stops an automatic approval: a lock that arrives while paused is rejected and refunded; after Resume the offers return', scenario(() => w, async () => {
    const eth = w.eth!;
    const c0 = await counters(w.maker, 'ethereum');
    const b0 = await balances(w, 'eth');
    const cp = await consolePage('approvals');
    // The quote is read and the proofs are exchanged first; the pause lands before the lock does.
    const o = await taker.open('eth', 0, XMR / 10n, {
      beforeSend: async () => {
        await cp.getByRole('button', { name: 'Pause', exact: true }).click();
        await cp.getByRole('alertdialog').getByRole('button', { name: /^Pause/ }).click();
        await waitFor('the pause', async () => (await w.maker.status()).paused.operator === true);
      },
    });
    await waitFor('the rejection', async () => counterDelta(c0, await counters(w.maker, 'ethereum'))['rejections'] === 1, { timeoutMs: 90_000, context: () => w.maker.swapDetail(o.ref).catch((e: Error) => e.message) });
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toEqual({ locks: 1, rejections: 1 });
    const b1 = await balances(w, 'eth');
    expect(b0.taker - b1.taker < 10n ** 16n).toBe(true);
    await cp.getByRole('button', { name: 'Resume' }).click();
    await waitFor('quoting again', async () => (await w.maker.status()).paused.operator === false);
    await taker.boardQuote(w.maker, 'eth', 0);
    await taker.offer(w.maker, 'sol', 0);
    void eth;
  }));

  it('an instruction that is on record when the daemon is killed is honoured after the restart', scenario(() => w, async () => {
    const c0 = await counters(w.maker, 'ethereum');
    const o = await taker.open('eth', 0, XMR / 2n);
    const cp = await consolePage('approvals');
    const row = cp.getByRole('table', { name: 'Pending approvals' }).getByRole('row').filter({ hasText: o.ref.slice(0, 6) });
    await row.waitFor({ timeout: 60_000 });
    await row.getByRole('button', { name: 'Approve' }).click();
    // Killed the moment the instruction is on the swap's record (it is written before anything acts on it).
    await waitFor('the instruction on record', async () => (await w.maker.swapDetail(o.ref)).instruction?.action === 'approve', { intervalMs: 15, timeoutMs: 30_000 });
    await w.maker.kill();
    await w.maker.start();
    await untilState(w, o.ref, ['ACTIVE', 'NOTICED']);
    await waitFor('the instruction answered', async () => (await w.maker.swapDetail(o.ref)).instruction?.status === 'carried_out', { context: () => w.maker.swapDetail(o.ref) });
    expect((await w.maker.swapDetail(o.ref)).instruction).toMatchObject({ action: 'approve', status: 'carried_out' });
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toMatchObject({ locks: 1, approvals: 1 });
    await untilPhase(w, o.ref, 'xmr_relayed');
    await taker.refund(o);
  }));
});

describe('M-2: advance approvals that must not work, and one on Ethereum', () => {
  it('Solana: over the limit, another taker\'s, and expired approvals are refused by the program; the valid one starts the swap at once; its payout is parked and withdrawn through the console', scenario(() => w, async () => {
    const sol = w.sol;
    const t2 = new SdkTaker(w, fill(45), sol.taker2, w.eth!.taker2);
    const thief = new SdkTaker(w, fill(46), sol.stranger, w.eth!.stranger);
    await sol.fund(sol.stranger.publicKey, 0n, 1_000_000_000n);
    const issued = await w.maker.api<{ record: AdvanceApprovalRecord; sig: string }>('POST', '/api/approvals/advance', { chain: 'solana', taker: sol.taker2.publicKey, max_xmr: (3n * XMR / 10n).toString(), days: 0.01 });
    const cfg = (await sol.client.getConfig())!;
    const r = issued.record;
    const approval = signSolApproval(fill(112), { clusterTag: cfg.clusterTag, programId: base58Decode(sol.client.programId), maker: base58Decode(w.maker.makerPda), taker: base58Decode(sol.taker2.publicKey), asset: SOL_APPROVAL_ANY, direction: SOL_APPROVAL_ANY, maxXmr: BigInt(r.max_xmr), notBefore: BigInt(r.not_before), expiresAt: BigInt(r.expires_at), epoch: r.epoch, approvalId: BigInt(r.id) });
    // The approval rebuilt from the daemon's record is byte for byte the one the daemon signed.
    expect(Buffer.from(approval.signature).toString('base64')).toBe(issued.sig);
    await expect(t2.open('usdc_sol', 0, XMR / 2n, { approval })).rejects.toThrow();
    await expect(thief.open('usdc_sol', 0, (3n * XMR) / 10n, { approval })).rejects.toThrow();

    // The valid use. The maker's payout token account is frozen meanwhile, so the claim parks the payout.
    const payoutAta = ata(w.maker.solPayout.publicKey, sol.usdc).toBase58();
    const b0 = await balances(w, 'usdc_sol', w.maker, sol.taker2.publicKey);
    const o = await t2.open('usdc_sol', 0, (3n * XMR) / 10n, { approval });
    expect(await swapState(w, o.ref)).toBe('ACTIVE');
    await untilPhase(w, o.ref, 'xmr_relayed');
    await w.mine(2);
    await sol.svm.setTokenAccountFrozen(payoutAta, true);
    await sol.warpTo(deadlines(await t2.must(o)).tReadyMin!);
    await t2.call(o, { name: 'set_ready' });
    await untilState(w, o.ref, 'DONE');
    const fee = o.amount / 2000n;
    expect((await t2.must(o)).owedMaker).toBe(o.amount - fee);
    await sol.svm.setTokenAccountFrozen(payoutAta, false);
    // Past its expiry the same approval is refused.
    await sol.warpTo(BigInt(r.expires_at) + 1n);
    await taker.offer(w.maker, 'usdc_sol', 0);
    await expect(t2.open('usdc_sol', 0, (3n * XMR) / 10n, { approval })).rejects.toThrow();

    // The console's "Withdraw parked payout": the daemon builds the transaction, the owner's wallet (in this browser) signs it.
    const page = ownerTab.page;
    await page.goto(`${w.maker.apiUrl}/#/swaps/${o.ref}`);
    const token = page.getByLabel('Access token');
    await token.waitFor();
    await token.fill(w.maker.token);
    await token.press('Enter');
    await page.getByRole('button', { name: 'Withdraw parked payout' }).click();
    const panel = page.getByRole('region', { name: 'Owner transaction' });
    await panel.waitFor({ timeout: 30_000 });
    await dump(page, 'console withdraw parked payout');
    await panel.getByRole('button', { name: /Sign with/ }).first().click();
    await waitFor('the parked payout in the payout account', async () => (await balances(w, 'usdc_sol')).makerPayout - b0.makerPayout === o.amount - fee, { timeoutMs: 60_000, context: () => page.locator('main').innerText() });
    expect(ownerTab.sol.signed).toBe(1);
    expect((await t2.view(o))?.owedMaker ?? 0n).toBe(0n);
  }));

  it('Ethereum: an advance-only quote refuses a lock without an approval and one above its limit; with the daemon\'s approval the lock is accepted and approved', scenario(() => w, async () => {
    const eth = w.eth!;
    const c0 = await counters(w.maker, 'ethereum');
    const size = (15n * XMR) / 100n;
    await expect(taker.open('usdc_eth', 0, size)).rejects.toThrow();
    const issue = async (maxXmr: bigint) => {
      const i = await w.maker.api<{ record: AdvanceApprovalRecord; sig: string }>('POST', '/api/approvals/advance', { chain: 'ethereum', taker: eth.taker.address.toLowerCase(), max_xmr: maxXmr.toString(), days: 1 });
      const r = i.record;
      const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
      return { approval: { maker: hexBytes(w.maker.ethMaker), taker: hexBytes(eth.taker.address), token: hexBytes(ETH_ANY_TOKEN), direction: ETH_ANY_DIRECTION, maxXmr: BigInt(r.max_xmr), notBefore: BigInt(r.not_before), validUntil: BigInt(r.expires_at), epoch: r.epoch, approvalId: hexBytes(r.id) }, sig: Uint8Array.from(Buffer.from(i.sig, 'base64')) };
    };
    await expect(taker.open('usdc_eth', 0, size, { ethApproval: await issue(XMR / 10n) })).rejects.toThrow();
    const o = await taker.open('usdc_eth', 0, size, { ethApproval: await issue(XMR) });
    await untilState(w, o.ref, ['ACTIVE', 'NOTICED']);
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toMatchObject({ locks: 1, approvals: 1 });
    await untilPhase(w, o.ref, 'xmr_relayed');
    await taker.refund(o);
    await untilState(w, o.ref, 'HOLD');
  }));
});

describe('the rest of the console, in the browser', () => {
  it('Registration, Keys and Inventory show the live daemon\'s state without an error', scenario(() => w, async () => {
    // (An earlier scenario killed the daemon under this tab; its lost event stream is not this scenario's business.)
    consoleTab.errors.length = 0;
    const reg = await consolePage('registration');
    await reg.getByRole('heading', { name: 'Registration', exact: true }).waitFor();
    await text(reg, w.maker.makerPda.slice(0, 6)).waitFor({ timeout: 30_000 });
    await text(reg, new RegExp(w.maker.o.onion.slice(0, 20))).waitFor({ timeout: 30_000 });
    await dump(reg, 'console registration');
    const keys = await consolePage('keys');
    await keys.getByRole('heading', { name: 'Keys', exact: true }).waitFor();
    await dump(keys, 'console keys');
    expect(await keys.locator('main').innerText()).toMatch(/version/i);
    const inv = await consolePage('inventory');
    await inv.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
    await dump(inv, 'console inventory');
    expect(await inv.locator('main').innerText()).toMatch(/XMR/);
    expect(consoleTab.errors).toEqual([]);
  }));

  it('the upgrade-status strip says "upgradable" and flips once the Solana upgrade authority is revoked and the Ethereum ownership renounced', scenario(() => w, async () => {
    const eth = w.eth!;
    const cp = await consolePage('status');
    const strip = cp.getByRole('note', { name: 'Contract upgrade status' });
    await strip.waitFor({ timeout: 30_000 });
    expect(await strip.innerText()).toMatch(/still upgradable/);
    const chains = async () => (await w.maker.status()).chains.map((c) => [c.chain, (c as unknown as { upgrade_status: string }).upgrade_status]);
    expect(await chains()).toEqual([['solana', 'upgradable'], ['ethereum', 'upgradable']]);
    // What the project owner does to freeze the code: revoke the program's upgrade authority, renounce the proxy's ownership.
    await w.sol.svm.setUpgradeAuthority(w.sol.client.programId, null);
    const hash = await eth.rpc<`0x${string}`>('eth_sendTransaction', [{ from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', to: eth.contract, data: '0x715018a6' }]);
    await eth.client.waitMined(hash, { intervalMs: 200 });
    await waitFor('the daemon to read both as immutable', async () => JSON.stringify(await chains()) === JSON.stringify([['solana', 'immutable'], ['ethereum', 'immutable']]), { timeoutMs: 180_000, intervalMs: 3000, context: () => w.maker.status().then((x) => x.chains) });
    // With nothing left that can be upgraded the warning strip goes away, and Status says so chain by chain.
    await waitFor('the strip to go', async () => {
      await cp.reload();
      await cp.getByRole('table', { name: 'Upgrade status by chain' }).waitFor({ timeout: 30_000 });
      return (await strip.count()) === 0;
    }, { timeoutMs: 90_000, intervalMs: 2000, context: () => cp.locator('main').innerText() });
    const table = cp.getByRole('table', { name: 'Upgrade status by chain' });
    expect(await table.getByText('No, immutable').count()).toBe(2);
    expect(await table.getByText('Yes, still upgradable').count()).toBe(0);
    await dump(cp, 'console status, immutable');
  }));
});
