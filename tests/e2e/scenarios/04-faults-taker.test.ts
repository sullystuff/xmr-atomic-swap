// What protects the taker when something is wrong (scenarios F-1, N-1, U-1, V-1, T-1): a maker
// that announces a false XMR lock, Monero nodes that disagree, a tab that is reloaded or lost,
// and a relay that is down. The taker is the built web UI in Chromium. The honest maker is the
// real daemon; the dishonest one is an SDK-driven maker registered beside it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COUNTER, DEPOSIT_STATE } from '@xmrswap/protocol';
import { isMined } from '../src/monero.js';
import { type Lie, RogueMaker } from '../src/rogue.js';
import { type TakerTab, openTab, text } from '../src/ui.js';
import { SOL, XMR, waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { advanceTo, balances, connect, counterDelta, counters, deadlines, dump, expectClean, holdings, pageNote, readSwap, registerRecoverySecrets, scenario, swapState, track, uiLockBuy, untilPhase, untilState } from './helpers.js';

let w: World;
let rogue: RogueMaker;
let tab: TakerTab;
const ROGUE_PRICE = (140n * SOL) / 100n;

beforeAll(async () => {
  w = await startWorld({ ethereum: false, inventoryBlocks: 20 });
  rogue = new RogueMaker(w, 1, w.takerWallet);
  await rogue.publish(ROGUE_PRICE);
  tab = track(await openTab({ solKey: w.sol.taker }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await w?.stop();
  await stopShared();
});
beforeEach(async () => {
  if (!w.maker.running) await w.maker.start();
  if (!w.relay.proc) await w.relay.start();
  w.uiNodeB.mode = 'honest';
  await rogue.refresh(ROGUE_PRICE);
});

describe('F-1: a maker announces a false XMR lock', () => {
  const cases: { lie: Lie; says: RegExp }[] = [
    { lie: 'wrong-amount', says: /The lock is not valid: it pays 0\.30 XMR, but this swap needs 0\.40 XMR/ },
    { lie: 'wrong-address', says: /The lock is not valid/ },
    { lie: 'never-broadcast', says: /Your nodes have not seen the lock transaction yet/ },
  ];
  for (const { lie, says } of cases) {
    it(`${lie}: the tab never sets ready, refunds by itself at the cutoff with the session key, and the maker's claim then fails`, scenario(() => w, async () => {
      const { page } = tab;
      const before = (await balances(w, 'sol')).taker;
      const prompts = tab.sol.signed;
      const { ref, recoveryFile } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: rogue.pda });
      registerRecoverySecrets(w, recoveryFile, 'faults-taker');
      const s0 = (await waitFor('the swap', () => readSwap(w, ref)))!;
      expect(s0.amount).toBe((ROGUE_PRICE * 4n) / 10n);
      const announced = await rogue.announce(s0, lie);
      if (announced.relayed) await w.mine(3);
      await text(page, says).waitFor({ timeout: 90_000 });
      await dump(page, lie);
      const noticed = (await readSwap(w, ref))!;
      const d = deadlines(noticed);
      // Past the contract's minimum wait for ready, and one second before the cutoff: nothing was sent; the banner is up.
      await w.sol.warpTo(d.tCut! - 1n);
      await page.waitForTimeout(2500);
      expect(await swapState(w, ref)).toBe('NOTICED');
      expect(await page.getByTestId('risk-banner').count()).toBe(1);
      // At the cutoff the tab refunds; the wallet is never asked.
      await w.sol.warpTo(d.tCut!);
      await untilState(w, ref, 'HOLD');
      expect(tab.sol.signed).toBe(prompts + 1);
      await text(page, 'This tab refunded by itself').waitFor({ timeout: 60_000 });
      await expect.poll(() => page.getByTestId('risk-banner').count(), { timeout: 30_000 }).toBe(0);
      const afterRefund = (await balances(w, 'sol')).taker;
      // amount − D is back; D (1%) is in the hold.
      expect(before - afterRefund >= s0.deposit && before - afterRefund < s0.deposit + 10_000_000n).toBe(true);
      expect((await w.sol.client.getMaker(rogue.pda))!.counters[COUNTER.taker_refunds_noticed]).toBeGreaterThanOrEqual(1);
      // The claim-without-ready window opens at T_co, but there is nothing left to claim.
      await w.sol.warpTo(d.tCo!);
      await expect(rogue.claim({ ...(await readSwap(w, ref))!, state: noticed.state })).rejects.toMatchObject({ code: 'BadState' });
      // The hold is over: the page offers the deposit, the user clicks, the wallet signs once.
      await text(page, 'Your deposit can be collected now').waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Sign with my wallet' }).click();
      await waitFor('the deposit back', async () => ((await readSwap(w, ref))?.depositState ?? DEPOSIT_STATE.RETURNED) === DEPOSIT_STATE.RETURNED);
      expect(tab.sol.signed).toBe(prompts + 2);
      const end = (await balances(w, 'sol')).taker;
      expect(before - end >= 0n && before - end < 10_000_000n).toBe(true);
      await page.goto(w.ui.url);
      expectClean(w, [tab]);
    }));
  }
});

describe('N-1: the taker\'s Monero nodes do not agree', () => {
  it('one node does not know the lock: the tab never counts it as confirmed, never sets ready, and refunds at the cutoff; the daemon takes its XMR back', scenario(() => w, async () => {
    const { page } = tab;
    const c0 = await counters(w.maker, 'solana');
    const inv0 = await holdings(w.maker.wallet);
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    // From now on the page's second node answers as if it had never seen the transaction.
    w.uiNodeB.mode = 'hide-tx';
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(3);
    const noticed = (await readSwap(w, ref))!;
    const d = deadlines(noticed);
    await w.sol.warpTo(d.tReadyMin! + 30n);
    await text(page, /Not counted as confirmed|could not be checked|have not seen the lock/).waitFor({ timeout: 60_000 });
    await dump(page, 'disagreement');
    await page.waitForTimeout(3000);
    // The real lock is three blocks deep on the honest node, and still the tab does not say ready.
    expect(await swapState(w, ref)).toBe('NOTICED');
    expect(await page.getByTestId('safe-banner').count()).toBe(0);
    await w.sol.warpTo(d.tCut!);
    await untilState(w, ref, 'HOLD');
    await text(page, 'This tab refunded by itself').waitFor({ timeout: 60_000 });
    w.uiNodeB.mode = 'honest';
    await w.mine(10);
    await waitFor('the daemon to sweep its XMR back', async () => (await w.maker.swapDetail(ref)).sweep_txid, { timeoutMs: 180_000 });
    await w.mine(1);
    expect(inv0 - (await holdings(w.maker.wallet)) < 200_000_000_000n).toBe(true);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toMatchObject({ locks: 1, notices: 1, taker_refunds_noticed: 1 });
    await w.sol.warpTo(deadlines((await readSwap(w, ref))!).tHold!);
    await text(page, 'Your deposit can be collected now').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Sign with my wallet' }).click();
    await waitFor('the deposit back', async () => ((await readSwap(w, ref))?.depositState ?? DEPOSIT_STATE.RETURNED) === DEPOSIT_STATE.RETURNED);
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));

  it('one node is down and comes back: the tab waits, then confirms and the swap completes', scenario(() => w, async () => {
    const { page } = tab;
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    w.uiNodeB.mode = 'down';
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    const noticed = (await readSwap(w, ref))!;
    await w.sol.warpTo(deadlines(noticed).tReadyMin! + 30n);
    await text(page, /Not counted as confirmed: node-failed/).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    expect(await swapState(w, ref)).toBe('NOTICED');
    w.uiNodeB.mode = 'honest';
    await untilState(w, ref, ['READY', 'DONE', 'closed']);
    await untilState(w, ref, ['DONE', 'closed']);
    await w.mine(10);
    await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    await w.mine(1);
    await text(page, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));
});

describe('U-1, V-1: the tab is reloaded, then lost', () => {
  it('the browser asks before leaving; a reload resumes at once; a brand-new profile restores from the recovery file alone, sets ready, and sweeps after the real daemon\'s claim', scenario(() => w, async () => {
    // Its own profile: this scenario throws the profile away.
    const first = track(await openTab({ solKey: w.sol.taker2 }));
    const b0 = await balances(w, 'sol', w.maker, w.sol.taker2.publicKey);
    const { ref, recoveryFile } = await uiLockBuy(first, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    registerRecoverySecrets(w, recoveryFile, 'faults-taker.restore');
    expect(JSON.parse(recoveryFile)).toMatchObject({ format: 'xmrswap-recovery/1' });
    await first.page.getByTestId('risk-banner').waitFor();
    expect(first.sol.signed).toBe(1);
    // The leave-page prompt, then the reload: the swap is back with no wallet and no prompt.
    first.dialogs.length = 0;
    await first.page.reload();
    expect(first.dialogs).toEqual(['beforeunload']);
    await first.page.getByTestId('swap-page').waitFor();
    await first.page.getByTestId('risk-banner').waitFor();
    await expect.poll(() => first.page.title()).toMatch(/^Do not close this tab/);
    expect(first.sol.signed).toBe(1);
    await untilPhase(w, ref, 'xmr_relayed');
    await text(first.page, /Seen in the mempool/).waitFor({ timeout: 90_000 });
    expect(first.errors).toEqual([]);
    // The tab is gone for good.
    await first.close();
    await w.mine(2);
    const noticed = (await readSwap(w, ref))!;
    await w.sol.warpTo(deadlines(noticed).tReadyMin! + 30n);
    await new Promise((r) => setTimeout(r, 3000));
    expect(await swapState(w, ref)).toBe('NOTICED');

    // A new browser profile: nothing but the recovery file and the chain.
    const second = track(await openTab({ solKey: w.sol.taker2 }));
    const p2 = second.page;
    await p2.goto(`${w.ui.url}/#/activity`);
    await p2.getByRole('heading', { name: 'Load your recovery file to resume' }).waitFor();
    await p2.getByRole('button', { name: 'I already have one' }).click();
    await p2.locator('input[type=file]').setInputFiles({ name: 'xmrswap-recovery.json', mimeType: 'application/json', buffer: Buffer.from(recoveryFile) });
    const item = p2.getByTestId('activity-swap');
    await item.waitFor({ timeout: 60_000 });
    // Keys re-derived from the seed and the on-chain nonce; ready is set by the re-derived session key; the daemon claims.
    await untilState(w, ref, ['READY', 'DONE', 'closed']);
    await untilState(w, ref, ['DONE', 'closed']);
    expect(second.sol.signed).toBe(0);
    await item.getByRole('link', { name: 'Open' }).click();
    await w.mine(10);
    // The new profile has no note of the destination: it asks instead of guessing.
    await p2.getByLabel('Your XMR address').fill(w.takerXmr);
    await p2.getByRole('button', { name: 'Sweep to this address' }).click();
    await text(p2, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    const sweepTxid = (await pageNote(p2, ref)).sweepTxid!;
    await w.mine(1);
    await text(p2, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
    expect(await isMined(sweepTxid)).toBe(true);
    expect((await w.takerWallet.received(sweepTxid))! > (4n * XMR) / 10n - 100_000_000_000n).toBe(true);
    expect(second.sol.signed).toBe(0);
    const b1 = await balances(w, 'sol', w.maker, w.sol.taker2.publicKey);
    expect(b1.makerPayout - b0.makerPayout).toBe(noticed.amount - noticed.amount / 2000n);
    expect(b1.treasury - b0.treasury).toBe(noticed.amount / 2000n);
    expectClean(w, [second]);
  }));
});

describe('the taker asks to get out (formerly BUG-1): an explicit request wins while the contract still accepts it, and is refused with a reason when it does not', () => {
  it('refund asked AFTER the XMR lock is confirmed: carried out at once (A10b); the tab never sets ready; the daemon recovers its XMR; the deposit is held, then collected', scenario(() => w, async () => {
    const { page } = tab;
    const c0 = await counters(w.maker, 'solana');
    const before = (await balances(w, 'sol')).taker;
    const inv0 = await holdings(w.maker.wallet);
    const prompts = tab.sol.signed;
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    // The lock is at depth on both nodes; the contract's minimum wait for ready is still running.
    await text(page, /2 of 2 confirmations on every node/).waitFor({ timeout: 90_000 });
    expect(await swapState(w, ref)).toBe('NOTICED');
    const s0 = (await readSwap(w, ref))!;
    await page.getByRole('button', { name: 'Refund this swap' }).click();
    await text(page, /You get .+ SOL back now\. The deposit of .+ SOL is held for 30 minutes/).waitFor();
    await page.getByRole('button', { name: 'Yes, refund' }).click();
    await untilState(w, ref, 'HOLD', 30_000);
    // The request has a visible outcome, and it is not a refusal.
    const outcome = page.getByTestId('request-outcome');
    await outcome.waitFor({ timeout: 30_000 });
    expect(await outcome.getAttribute('data-refused')).toBe('');
    expect(tab.sol.signed).toBe(prompts + 1);
    const out = before - (await balances(w, 'sol')).taker;
    expect(out >= s0.deposit && out < s0.deposit + 10_000_000n).toBe(true);
    // Well past the minimum wait for ready: the tab did not set ready behind the user's back.
    await w.sol.warpTo(deadlines(s0).tReadyMin! + 120n);
    await page.waitForTimeout(3000);
    expect(await swapState(w, ref)).toBe('HOLD');
    await w.mine(10);
    await waitFor('the daemon to sweep its XMR back', async () => (await w.maker.swapDetail(ref)).sweep_txid, { timeoutMs: 180_000, context: () => w.maker.swapDetail(ref) });
    await w.mine(1);
    expect(inv0 - (await holdings(w.maker.wallet)) < 200_000_000_000n).toBe(true);
    await w.sol.warpTo(deadlines((await readSwap(w, ref))!).tHold!);
    await text(page, 'Your deposit can be collected now').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Sign with my wallet' }).click();
    await waitFor('the deposit back', async () => ((await readSwap(w, ref))?.depositState ?? DEPOSIT_STATE.RETURNED) === DEPOSIT_STATE.RETURNED);
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, taker_refunds_noticed: 1, deposits_returned: 1 });
    const end = before - (await balances(w, 'sol')).taker;
    expect(end >= 0n && end < 10_000_000n).toBe(true);
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));

  it('refund asked TOO LATE (ready is already set): the page says why and what happens instead, the control is disabled with the reason, and the swap completes normally', scenario(() => w, async () => {
    const { page } = tab;
    const c0 = await counters(w.maker, 'solana');
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    await text(page, /2 of 2 confirmations on every node/).waitFor({ timeout: 90_000 });
    // The maker is away for a moment, so that "ready" can be looked at.
    await w.maker.kill();
    // While the user hesitates the minimum wait ends and the tab sets ready.
    await page.getByRole('button', { name: 'Refund this swap' }).waitFor();
    await w.sol.warpTo(deadlines((await readSwap(w, ref))!).tReadyMin!);
    await untilState(w, ref, 'READY');
    // The refund button is gone; in its place the page says that a refund is not possible, why, and what happens instead.
    const blocked = page.getByRole('button', { name: 'Refund not possible: ready is set' });
    await blocked.waitFor({ timeout: 30_000 });
    expect(await blocked.isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Refund this swap' }).count()).toBe(0);
    await text(page, /Ready is already set, so this swap can no longer be refunded\. The maker will claim and this tab will collect your XMR/).waitFor();
    await page.waitForTimeout(2500);
    expect(await swapState(w, ref)).toBe('READY');
    // The maker is back: it claims, and the tab collects the XMR as the message said.
    await w.maker.start();
    await untilState(w, ref, ['DONE', 'closed']);
    await w.mine(10);
    await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    await w.mine(1);
    await text(page, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, readies: 1, completed: 1 });
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));
});

describe('R-7 in the browser: ready is set and the maker never claims', () => {
  it('"Safe to close" only while ready; at the end of the maker\'s claim window the open tab refunds everything by itself; missed_claims', scenario(() => w, async () => {
    const { page } = tab;
    const c0 = await counters(w.maker, 'solana');
    const before = (await balances(w, 'sol')).taker;
    const inv0 = await holdings(w.maker.wallet);
    const prompts = tab.sol.signed;
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    // Not safe yet: the lock is confirmed but ready is not set.
    expect(await page.getByTestId('safe-banner').count()).toBe(0);
    await page.getByTestId('risk-banner').waitFor();
    await w.maker.kill();
    await w.sol.warpTo(deadlines((await readSwap(w, ref))!).tReadyMin!);
    await untilState(w, ref, 'READY');
    const safe = page.getByTestId('safe-banner');
    await safe.waitFor({ timeout: 60_000 });
    expect(await safe.innerText()).toContain('Safe to close');
    expect(await safe.innerText()).toMatch(/If the maker does not complete, come back before .+ to refund\./);
    expect(await page.getByTestId('risk-banner').count()).toBe(0);
    await expect.poll(() => page.title()).toBe('Safe to close · XMR atomic swaps');
    const d = deadlines((await readSwap(w, ref))!);
    await w.sol.warpTo(d.tCd! - 1n);
    await page.waitForTimeout(2500);
    expect(await swapState(w, ref)).toBe('READY');
    await w.sol.warpTo(d.tCd!);
    await waitFor('the tab\'s fault refund', async () => counterDelta(c0, await counters(w.maker, 'solana'))['missed_claims'] === 1, { timeoutMs: 90_000 });
    expect(counterDelta(c0, await counters(w.maker, 'solana'))).toEqual({ locks: 1, notices: 1, readies: 1, missed_claims: 1 });
    // Everything is back at once, deposit included, and the wallet was never asked.
    await waitFor('the refund in the taker\'s wallet', async () => before - (await balances(w, 'sol')).taker < 10_000_000n, { timeoutMs: 60_000 });
    expect(tab.sol.signed).toBe(prompts + 1);
    await w.maker.start();
    await w.mine(10);
    await waitFor('the daemon to sweep its XMR back', async () => (await w.maker.swapDetail(ref)).sweep_txid, { timeoutMs: 180_000, context: () => w.maker.swapDetail(ref) });
    await w.mine(1);
    expect(inv0 - (await holdings(w.maker.wallet)) < 200_000_000_000n).toBe(true);
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));
});

describe('T-1: the relay is down', () => {
  it('offers still list and a swap still completes (the registry and the swap are on-chain); a message to the maker falls back to an on-chain post, and the maker\'s answer comes back on-chain', scenario(() => w, async () => {
    const { page } = tab;
    // While it is up: it forwards to a maker listed in the registry and to nobody else.
    const forward = (onion: string) => fetch(`${w.relay.url}/relay/v1/forward`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onion, method: 'GET', path: '/xs/v1/info' }) });
    const listed = await forward(w.maker.o.onion);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { status: number }).status).toBe(200);
    const unlisted = await forward(`${'b'.repeat(56)}.onion`);
    expect(unlisted.status).toBe(403);
    expect(((await unlisted.json()) as { error: string }).error).toBe('onion_not_listed');
    await w.relay.stop();
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4', makerPda: w.maker.makerPda });
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    const noticed = (await readSwap(w, ref))!;
    await advanceTo(w, noticed, deadlines(noticed).tReadyMin!);
    await untilState(w, ref, ['DONE', 'closed']);
    await w.mine(10);
    await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    await w.mine(1);
    await text(page, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });

    // Messaging: with no relay the page posts the sealed message through the program; the wallet signs it.
    const prompts = tab.sol.signed;
    const tor0 = w.tor.connects.length;
    await page.goto(`${w.ui.url}/#/maker/${w.maker.makerPda}`);
    await connect(page, 'solana');
    await dump(page, 'maker page, relay down');
    await page.getByLabel('Message').fill('Is the relay down? This message should reach you on-chain.');
    await page.getByRole('button', { name: 'Send encrypted message' }).click();
    await text(page, /Sent on-chain/).waitFor({ timeout: 60_000 });
    expect(tab.sol.signed).toBe(prompts + 1);
    await dump(page, 'sent on-chain');
    expect(w.tor.connects.length).toBe(tor0);
    // The daemon reads it from the chain and shows it in its inbox; the maker answers through the daemon's API (as the console does).
    const item = await waitFor('the message in the daemon\'s inbox', async () => {
      const r = await w.maker.api<{ items: { id: string; text?: string; body?: string; transport?: string }[] }>('GET', '/api/inbox');
      return r.items.find((i) => JSON.stringify(i).includes('reach you on-chain')) ?? null;
    }, { timeoutMs: 60_000, context: () => w.maker.api('GET', '/api/inbox') });
    expect(JSON.stringify(item)).toMatch(/solana/);
    await w.maker.api('POST', `/api/inbox/${encodeURIComponent(item.id)}/reply`, { text: 'It is. This answer travels on-chain too.' });
    await waitFor('the answer in the taker\'s thread', async () => {
      if (await page.getByText('This answer travels on-chain too.').count()) return true;
      await page.getByRole('button', { name: 'Check for replies' }).click().catch(() => undefined);
      return false;
    }, { timeoutMs: 90_000, intervalMs: 2000, context: () => page.locator('main').innerText() });
    await w.relay.start();
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));
});
