// H-A and H-B through the REAL system: the built taker UI in Chromium, the real relay behind the
// fake Tor, the real maker daemon, the real program in svm-rpc, the real contract on anvil, and
// real XMR on the Monero regtest. Loopback only. Every market, both directions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Market } from '@xmrswap/protocol';
import { REGTEST_MAX_FEE, isMined } from '../src/monero.js';
import { type TakerTab, openTab, text } from '../src/ui.js';
import { waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { advanceTo, balances, chainOf, counterDelta, counters, deadlines, expectClean, holdings, pageNote, readSwap, registerRecoverySecrets, scenario, track, uiLockBuy, uiTakeSell, untilPhase, untilState } from './helpers.js';

let w: World;
// One browser profile for the whole file: one user, one recovery file, eight swaps.
let tab: TakerTab;
beforeAll(async () => {
  w = await startWorld();
  tab = track(await openTab({ solKey: w.sol.taker, ethKey: w.eth!.taker, eth: w.eth }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await w?.stop();
  await stopShared();
});

const MARKETS: Market[] = ['sol', 'usdc_sol', 'eth', 'usdc_eth'];
/** Network fees, rent and the session-key budget a native-asset taker may be out of pocket for, at most. */
const NATIVE_SLACK: Record<string, bigint> = { sol: 20_000_000n, eth: 10n ** 16n };

describe('H-A: buy XMR in the browser from the real daemon', () => {
  for (const market of MARKETS) {
    it(`${market}: lock in the UI, the daemon locks XMR after its notice, the tab sets ready, the daemon claims, the tab sweeps`, scenario(() => w, async () => {
      const chain = chainOf(market);
      const { page } = tab;
      const before = await balances(w, market);
      const c0 = await counters(w.maker, chain);
      const torBefore = w.tor.connects.length;
      const inventoryBefore = await holdings(w.maker.wallet);
      const prompts0 = chain === 'solana' ? tab.sol.signed : tab.eth!.signed;
      const prompts = () => (chain === 'solana' ? tab.sol.signed : tab.eth!.signed) - prompts0;
      const { ref, recoveryFile } = await uiLockBuy(tab, w, { market, xmr: '0.5' });
      registerRecoverySecrets(w, recoveryFile, `H-A.${market}`);
      // One wallet prompt; USDC on Ethereum also needs its allowance.
      expect(prompts()).toBe(market === 'usdc_eth' ? 2 : 1);
      await page.getByTestId('risk-banner').waitFor();
      const s0 = (await waitFor('the swap on-chain', () => readSwap(w, ref)))!;
      expect(s0.xmr).toBe(500_000_000_000n);
      expect(s0.deposit).toBe(s0.amount / 100n);

      // The daemon: its notice is on-chain (and final) before any XMR leaves.
      await untilState(w, ref, 'NOTICED');
      const relayed = await untilPhase(w, ref, 'xmr_relayed');
      expect(relayed.intents.map((i: { kind: string; status: string }) => `${i.kind}:${i.status}`).filter((x: string) => x.startsWith('xmr'))).toEqual(['xmr_prepare:confirmed', 'xmr_relay:confirmed']);
      await text(page, /Seen in the mempool/).waitFor({ timeout: 90_000 });
      await w.mine(2);
      const noticed = (await readSwap(w, ref))!;
      await advanceTo(w, noticed, deadlines(noticed).tReadyMin!);
      // The tab sets ready with its session key (no wallet prompt); the daemon claims as soon as ready is final.
      await untilState(w, ref, ['READY', 'DONE', 'closed']);
      await untilState(w, ref, ['DONE', 'closed']);

      // The tab takes the XMR after the 10-block lock.
      await text(page, /The XMR is yours, spendable in \d+ blocks?/).waitFor({ timeout: 90_000 });
      await w.mine(9);
      await text(page, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
      const sweepTxid = (await pageNote(page, ref)).sweepTxid!;
      expect(sweepTxid).toMatch(/^[0-9a-f]{64}$/);
      await w.mine(1);
      await text(page, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
      expect(prompts()).toBe(market === 'usdc_eth' ? 2 : 1);

      // ---- final balances on every chain
      // Monero: the taker's destination wallet holds the swap's XMR less the sweep's network fee; the maker's inventory is down by it.
      expect(await isMined(sweepTxid)).toBe(true);
      const got = (await w.takerWallet.received(sweepTxid))!;
      expect(got > s0.xmr - REGTEST_MAX_FEE && got < s0.xmr).toBe(true);
      const inventoryAfter = await holdings(w.maker.wallet);
      expect(inventoryBefore - inventoryAfter >= s0.xmr && inventoryBefore - inventoryAfter < s0.xmr + REGTEST_MAX_FEE).toBe(true);
      // The paying chain: the maker's payout address has amount − fee, the treasury the 0.05% fee, the taker paid amount.
      const after = await balances(w, market);
      const fee = s0.amount / 2000n;
      expect(fee > 0n).toBe(true);
      expect(after.makerPayout - before.makerPayout).toBe(s0.amount - fee);
      expect(after.treasury - before.treasury).toBe(fee);
      const paid = before.taker - after.taker;
      if (NATIVE_SLACK[market] !== undefined) expect(paid >= s0.amount && paid < s0.amount + NATIVE_SLACK[market]!).toBe(true);
      else expect(paid).toBe(s0.amount);
      // ---- the maker's public counters
      expect(counterDelta(c0, await counters(w.maker, chain))).toEqual({ locks: 1, ...(chain === 'ethereum' ? { approvals: 1 } : {}), notices: 1, readies: 1, completed: 1 });
      // ---- the daemon agrees, and messages really travelled browser -> relay -> (fake Tor) -> daemon on Ethereum (key pool and proofs)
      await untilPhase(w, ref, 'completed');
      if (chain === 'ethereum') expect(w.tor.connects.slice(torBefore).some((c) => c.host === w.maker.o.onion && c.port === 80)).toBe(true);
      await page.goto(w.ui.url);
      expectClean(w, [tab]);
    }));
  }
});

describe('H-B: sell XMR in the browser to the real daemon', () => {
  for (const market of MARKETS) {
    it(`${market}: deposit in the UI, the daemon funds, the taker pays XMR, the daemon sets ready at depth, the tab claims, the daemon sweeps`, scenario(() => w, async () => {
      const chain = chainOf(market);
      const { page } = tab;
      const before = await balances(w, market);
      const c0 = await counters(w.maker, chain);
      const inventoryBefore = await holdings(w.maker.wallet);
      const { ref, recoveryFile } = await uiTakeSell(tab, w, { market, xmr: '0.25' });
      registerRecoverySecrets(w, recoveryFile, `H-B.${market}`);
      // A pending take is not at risk and shows no address yet.
      expect(await page.getByTestId('pay-xmr').count()).toBe(0);

      // The daemon funds the escrow from its operator balance; only then is the address shown, computed in the page.
      await untilState(w, ref, 'ACTIVE');
      const fundedAt = Date.now();
      const pay = page.getByTestId('pay-xmr');
      await pay.waitFor({ timeout: 240_000 });
      console.log(`[timing] ${market}: the address appeared ${Math.round((Date.now() - fundedAt) / 1000)} s after the maker's funding was mined`);
      const address = (await pay.locator('code').first().getAttribute('title'))!;
      expect(address).toMatch(/^4[1-9A-HJ-NP-Za-km-z]{94}$/);
      const funded = (await readSwap(w, ref))!;
      expect(funded.xmr).toBe(250_000_000_000n);

      // The taker pays from its own wallet; the page finds the payment and posts the notice with the session key.
      const takerXmrBefore = (await w.takerWallet.balance()).balance;
      const payTxid = await w.takerWallet.pay(address, funded.xmr);
      await untilState(w, ref, 'NOTICED');
      await w.mine(2);
      const noticed = (await readSwap(w, ref))!;
      await advanceTo(w, noticed, deadlines(noticed).tReadyMin!);
      // The daemon verifies on both nodes at depth and sets ready; the page claims with the session key.
      await untilState(w, ref, ['READY', 'DONE', 'closed']);
      await untilState(w, ref, ['DONE', 'closed']);
      await text(page, 'Complete').waitFor({ timeout: 90_000 });

      // The daemon sweeps the joint address into its inventory wallet after the 10-block lock.
      await w.mine(10);
      const swept = await waitFor('the daemon to sweep the XMR', async () => {
        const d = await w.maker.swapDetail(ref);
        return d.sweep_txid ? d : null;
      }, { timeoutMs: 180_000, context: () => w.maker.swapDetail(ref) });
      await w.mine(1);
      expect(await isMined(swept.sweep_txid)).toBe(true);
      const got = (await w.maker.wallet.received(swept.sweep_txid))!;
      expect(got > funded.xmr - REGTEST_MAX_FEE && got < funded.xmr).toBe(true);
      expect(await holdings(w.maker.wallet) - inventoryBefore).toBe(got);
      expect(await isMined(payTxid)).toBe(true);
      const takerXmrAfter = (await w.takerWallet.balance()).balance;
      // (The taker's wallet also collects this regtest's block rewards, so only "it paid at least the amount" can be said of its XMR.)
      expect(takerXmrAfter !== takerXmrBefore).toBe(true);

      // The paying chain: the taker has amount − fee (its deposit came back with it), the treasury the fee, the operator paid amount.
      const after = await balances(w, market);
      const fee = funded.amount / 2000n;
      expect(after.treasury - before.treasury).toBe(fee);
      const gained = after.taker - before.taker;
      if (NATIVE_SLACK[market] !== undefined) expect(gained <= funded.amount - fee && gained > funded.amount - fee - NATIVE_SLACK[market]!).toBe(true);
      else expect(gained).toBe(funded.amount - fee);
      const spent = before.makerOperator - after.makerOperator;
      if (NATIVE_SLACK[market] !== undefined) expect(spent >= funded.amount && spent < funded.amount + NATIVE_SLACK[market]! * 5n).toBe(true);
      else expect(spent).toBe(funded.amount);
      expect(after.makerPayout).toBe(before.makerPayout);
      expect(counterDelta(c0, await counters(w.maker, chain))).toEqual({ takes: 1, approvals: 1, notices: 1, readies: 1, completed: 1 });
      await untilPhase(w, ref, ['swept', 'completed', 'closed']);
      expectClean(w, [tab]);
    }));
  }
});

describe('R-4 through the UI on Ethereum: the page\'s own refund with the session key', () => {
  it('eth: the taker clicks Refund after the maker\'s notice; the session key refunds on Ethereum; the daemon takes its XMR back; the wallet collects the deposit after the hold', scenario(() => w, async () => {
    const { page } = tab;
    const before = await balances(w, 'eth');
    const c0 = await counters(w.maker, 'ethereum');
    const inv0 = await holdings(w.maker.wallet);
    const { ref } = await uiLockBuy(tab, w, { market: 'eth', xmr: '0.5' });
    const prompts = tab.eth!.signed;
    await untilState(w, ref, 'NOTICED');
    await untilPhase(w, ref, 'xmr_relayed');
    const s0 = (await readSwap(w, ref))!;
    // (Asked while the lock is still unconfirmed: once it is confirmed the page ignores the request, see BUGS.md BUG-1.)
    await page.getByRole('button', { name: 'Refund this swap' }).click();
    await page.getByRole('button', { name: 'Yes, refund' }).click();
    await untilState(w, ref, 'HOLD');
    await w.mine(2);
    // The session key paid for it from its budget: no wallet prompt.
    expect(tab.eth!.signed).toBe(prompts);
    const mid = await balances(w, 'eth');
    expect(before.taker - mid.taker >= s0.deposit && before.taker - mid.taker < s0.deposit + NATIVE_SLACK['eth']!).toBe(true);
    // The daemon recovers its XMR with the share the refund revealed.
    await w.mine(10);
    await waitFor('the daemon to sweep its XMR back', async () => (await w.maker.swapDetail(ref)).sweep_txid, { timeoutMs: 180_000, context: () => w.maker.swapDetail(ref) });
    await w.mine(1);
    const lost = inv0 - (await holdings(w.maker.wallet));
    expect(lost > 0n && lost < 2n * REGTEST_MAX_FEE).toBe(true);
    // After the hold the page offers the deposit; the user's wallet sends the release.
    await advanceTo(w, s0, deadlines((await readSwap(w, ref))!).tHold!);
    await text(page, 'Your deposit can be collected now').waitFor({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Sign with my wallet' }).click();
    await waitFor('deposits_returned', async () => counterDelta(c0, await counters(w.maker, 'ethereum'))['deposits_returned'] === 1, { timeoutMs: 60_000 });
    expect(tab.eth!.signed).toBe(prompts + 1);
    const after = await balances(w, 'eth');
    expect(before.taker - after.taker >= 0n && before.taker - after.taker < NATIVE_SLACK['eth']!).toBe(true);
    expect(after.makerPayout).toBe(before.makerPayout);
    expect(after.treasury).toBe(before.treasury);
    expect(counterDelta(c0, await counters(w.maker, 'ethereum'))).toEqual({ locks: 1, approvals: 1, notices: 1, taker_refunds_noticed: 1, deposits_returned: 1 });
    await page.goto(w.ui.url);
    expectClean(w, [tab]);
  }));
});

describe('V-1 on Ethereum: a lost tab, restored from the recovery file in a new browser profile', () => {
  it('eth: the first profile locks and is thrown away; a new one loads the file, re-derives the keys from the seed and the on-chain nonce, sets ready, and sweeps after the daemon\'s claim', scenario(() => w, async () => {
    const eth = w.eth!;
    const first = track(await openTab({ solKey: w.sol.taker2, ethKey: eth.taker2, eth }));
    const { ref, recoveryFile } = await uiLockBuy(first, w, { market: 'eth', xmr: '0.5' });
    registerRecoverySecrets(w, recoveryFile, 'V-1.eth');
    await untilState(w, ref, 'NOTICED');
    await untilPhase(w, ref, 'xmr_relayed');
    await first.close();
    await w.mine(2);
    const noticed = (await readSwap(w, ref))!;
    await advanceTo(w, noticed, deadlines(noticed).tReadyMin! + 30n);
    expect(await untilState(w, ref, 'NOTICED')).toBe('NOTICED');

    const second = track(await openTab({ solKey: w.sol.taker2, ethKey: eth.taker2, eth }));
    const p2 = second.page;
    await p2.goto(`${w.ui.url}/#/activity`);
    await p2.getByRole('heading', { name: 'Load your recovery file to resume' }).waitFor();
    await p2.getByRole('button', { name: 'I already have one' }).click();
    await p2.locator('input[type=file]').setInputFiles({ name: 'xmrswap-recovery.json', mimeType: 'application/json', buffer: Buffer.from(recoveryFile) });
    const item = p2.getByTestId('activity-swap');
    await item.waitFor({ timeout: 90_000 });
    await untilState(w, ref, ['READY', 'DONE']);
    await untilState(w, ref, 'DONE');
    // Ready was set by the re-derived session key: the wallet was never asked.
    expect(second.eth!.signed).toBe(0);
    await item.getByRole('link', { name: 'Open' }).click();
    await w.mine(10);
    await p2.getByLabel('Your XMR address').fill(w.takerXmr);
    await p2.getByRole('button', { name: 'Sweep to this address' }).click();
    await text(p2, /Sweep sent, waiting for a block/).waitFor({ timeout: 180_000 });
    const sweepTxid = (await pageNote(p2, ref)).sweepTxid!;
    await w.mine(1);
    await text(p2, 'The XMR is in your wallet').waitFor({ timeout: 90_000 });
    expect(await isMined(sweepTxid)).toBe(true);
    const got = (await w.takerWallet.received(sweepTxid))!;
    expect(got > noticed.xmr - REGTEST_MAX_FEE && got < noticed.xmr).toBe(true);
    expectClean(w, [second]);
  }));
});

describe('the system as a whole after every swap of this file', () => {
  it('the daemon raised no critical alert, nothing needs review, and the relay carried the Ethereum messages', async () => {
    const status = await w.maker.status();
    expect(status.needs_review).toBe(0);
    expect(status.alerts.filter((a) => a.level === 'critical')).toEqual([]);
    expect((await w.relay.status()).tor_ok).toBe(true);
    expect(w.leakedSecrets()).toEqual([]);
  });
});
