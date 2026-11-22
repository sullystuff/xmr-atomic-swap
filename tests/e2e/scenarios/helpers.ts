// What the scenario files share: one world per file, the taker's steps in the browser, and the
// taker's steps through the SDK for scenarios that need second-exact control.
import { expect } from 'vitest';
import { COUNTER, type Market, SWAP_STATE } from '@xmrswap/protocol';
import { type SwapView, deadlinesOf } from '@xmrswap/sdk';
import type { Page } from 'playwright-core';
import type { Maker } from '../src/maker.js';
import { type TakerTab, refInUrl, saveRecoveryFile } from '../src/ui.js';
import { big, waitFor } from '../src/util.js';
import type { World } from '../src/world.js';

export const MARKET_LABEL: Record<Market, string> = { sol: 'SOL', usdc_sol: 'USDC · Solana', eth: 'ETH', usdc_eth: 'USDC · Ethereum' };
export const chainOf = (m: Market): 'solana' | 'ethereum' => (m === 'sol' || m === 'usdc_sol' ? 'solana' : 'ethereum');
export const stateName = (s: number): string => Object.entries(SWAP_STATE).find(([, v]) => v === s)?.[0] ?? String(s);
export const counterName = (c: number): string => Object.entries(COUNTER).find(([, v]) => v === c)?.[0] ?? String(c);

/** Read a swap wherever it lives: a base58 PDA on Solana, a 0x id on Ethereum. `null` once a Solana account is closed. */
export async function readSwap(w: World, ref: string): Promise<SwapView | null> {
  if (ref.startsWith('0x')) return w.eth!.swap(Uint8Array.from(Buffer.from(ref.slice(2), 'hex')));
  return w.sol.swap(ref);
}
export async function swapState(w: World, ref: string): Promise<string> {
  const s = await readSwap(w, ref);
  return s ? stateName(s.state) : 'closed';
}
export const untilState = (w: World, ref: string, states: string | string[], timeoutMs = 120_000, between?: () => Promise<unknown>): Promise<string> =>
  waitFor(`swap ${ref} to be ${String(states)}`, async () => {
    const s = await swapState(w, ref);
    return ([] as string[]).concat(states).includes(s) ? s : null;
  }, { timeoutMs, ...(between ? { between } : {}), context: async () => ({ state: await swapState(w, ref), daemon: await w.maker.swapDetail(ref).catch((e: Error) => e.message), alerts: (await w.maker.status().catch(() => null))?.alerts?.map((a) => a.message) }) });

/** Move the swap's chain to an instant (never backwards). */
export async function advanceTo(w: World, s: SwapView, t: bigint): Promise<void> {
  if (s.chain === 'solana') await w.sol.warpTo(t);
  else await w.eth!.advanceTo(t);
}
export const deadlines = (s: SwapView) => deadlinesOf(s.chain, s);

/** The counters of a maker on one chain, as a name -> value map of the non-zero ones. */
export async function counters(m: Maker, chain: 'solana' | 'ethereum'): Promise<Record<string, number>> {
  const c = await m.counters(chain);
  return Object.fromEntries(Object.entries(COUNTER).map(([k, i]) => [k, c[i as number] ?? 0]));
}
export function counterDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(after)) if ((after[k] ?? 0) !== (before[k] ?? 0)) out[k] = (after[k] ?? 0) - (before[k] ?? 0);
  return out;
}

/** Balances that every scenario accounts for, in base units, for one market. */
export interface Balances {
  taker: bigint;
  makerPayout: bigint;
  makerOperator: bigint;
  treasury: bigint;
}
export async function balances(w: World, market: Market, m: Maker = w.maker, takerKey?: string): Promise<Balances> {
  if (market === 'sol') return { taker: await w.sol.balance(takerKey ?? w.sol.taker.publicKey), makerPayout: await w.sol.balance(m.solPayout.publicKey), makerOperator: await w.sol.balance(m.solOperator.publicKey), treasury: (await w.sol.treasury()).sol };
  if (market === 'usdc_sol') return { taker: await w.sol.usdcBalance(takerKey ?? w.sol.taker.publicKey), makerPayout: await w.sol.usdcBalance(m.solPayout.publicKey), makerOperator: await w.sol.usdcBalance(m.solOperator.publicKey), treasury: (await w.sol.treasury()).usdc };
  const eth = w.eth!;
  if (market === 'eth') return { taker: await eth.balance(takerKey ?? eth.taker.address), makerPayout: await eth.balance(m.ethPayout.address), makerOperator: await eth.balance(m.ethOperator.address), treasury: (await eth.treasuryAccrued()).eth };
  return { taker: await eth.usdcBalance(takerKey ?? eth.taker.address), makerPayout: await eth.usdcBalance(m.ethPayout.address), makerOperator: await eth.usdcBalance(m.ethOperator.address), treasury: (await eth.treasuryAccrued()).usdc };
}

/** Connect the injected wallet of a chain unless the page already has it (a wallet reconnects by itself after a reload). */
export async function connect(page: Page, chain: 'solana' | 'ethereum'): Promise<void> {
  const name = chain === 'solana' ? 'Solana' : 'Ethereum';
  const connected = page.getByRole('button', { name: new RegExp(`^${name} `) });
  const button = page.getByRole('button', { name: `Connect ${name}` });
  await connected.or(button).first().waitFor();
  // Give a silent reconnect a moment before deciding to click.
  for (let i = 0; i < 10 && (await connected.count()) === 0; i++) await page.waitForTimeout(100);
  if ((await connected.count()) === 0) await button.click();
  await connected.waitFor();
}

const recoveryFiles = new WeakMap<object, string>();
/**
 * The backup gate, once per browser profile: with no recovery file the lock button is disabled;
 * the file is created, downloaded and confirmed. A profile that already has one is left alone.
 */
export async function ensureBackup(page: Page): Promise<string> {
  const ctx = page.context();
  await page.getByTestId('backup').first().waitFor();
  if ((await page.locator('[data-testid="backup"][data-state="saved"]').count()) > 0) return recoveryFiles.get(ctx) ?? '';
  expect(await page.getByTestId('lock-button').isDisabled()).toBe(true);
  const file = await saveRecoveryFile(page);
  recoveryFiles.set(ctx, file);
  return file;
}

/** Wait until the daemon's offer for a market and direction is on the offers page, and open its review page. */
export async function openOffer(tab: TakerTab, w: World, market: Market, direction: 'buy' | 'sell', makerPda?: string): Promise<void> {
  const { page } = tab;
  await page.goto(w.ui.url);
  await page.getByRole('heading', { name: 'Buy XMR directly from makers' }).waitFor();
  await connect(page, chainOf(market));
  if (direction === 'sell') await page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'Sell XMR' }).click();
  await page.getByRole('button', { name: MARKET_LABEL[market], exact: true }).click();
  // The offer of one maker when several are listed (the row names its maker by the start of its address).
  const row = makerPda ? page.getByTestId('offer').filter({ hasText: `Maker ${makerPda.slice(0, 8)}` }) : page.getByTestId('offer');
  const link = row.first().getByRole('link', { name: direction === 'buy' ? 'Buy XMR' : 'Sell XMR' });
  await waitFor(`a live ${market} ${direction} offer on the page`, async () => {
    if (await link.count()) return true;
    await page.getByRole('button', { name: /Refresh/ }).click().catch(() => undefined);
    return false;
  }, { timeoutMs: 60_000, intervalMs: 1500, context: () => page.locator('main').innerText() });
  await link.click();
  await page.getByTestId('new-swap').waitFor();
}

/** From the offers page to a locked buy-XMR swap: every gate on the way. */
export async function uiLockBuy(tab: TakerTab, w: World, o: { market: Market; xmr: string; destination?: string; makerPda?: string; beforeConfirm?: (page: Page) => Promise<void> }): Promise<{ ref: string; recoveryFile: string }> {
  const { page } = tab;
  await openOffer(tab, w, o.market, 'buy', o.makerPda);
  await page.getByLabel('XMR to buy').fill(o.xmr);
  await page.getByLabel('Your XMR address').fill(o.destination ?? w.takerXmr);
  const lock = page.getByTestId('lock-button');
  const recoveryFile = await ensureBackup(page);
  await expect.poll(() => lock.isDisabled(), { timeout: 30_000 }).toBe(false);
  await lock.click();
  const confirm = page.getByTestId('confirm-lock');
  await confirm.waitFor();
  if (o.beforeConfirm) await o.beforeConfirm(page);
  await confirm.getByRole('checkbox').check();
  await confirm.getByRole('button', { name: /^Lock / }).click();
  await page.getByTestId('swap-page').waitFor({ timeout: 60_000 });
  return { ref: refInUrl(page), recoveryFile };
}

export async function dump(page: Page, label = ''): Promise<void> {
  if (!process.env['E2E_DEBUG']) return;
  console.log(`\n----- page ${label} ${page.url()}\n${await page.locator('body').innerText().catch((e: Error) => e.message)}\n-----`);
}
export { big };

/** Wait for the daemon's own phase of a swap (for example `xmr_relayed`). */
export const untilPhase = (w: World, ref: string, phases: string | string[], timeoutMs = 120_000, m: Maker = w.maker): Promise<any> =>
  waitFor(`the daemon's phase of ${ref} to be ${String(phases)}`, async () => {
    const d = await m.swapDetail(ref).catch(() => null);
    return d && ([] as string[]).concat(phases).includes(d.phase) ? d : null;
  }, { timeoutMs, context: async () => ({ chain: await swapState(w, ref), daemon: await m.swapDetail(ref).catch((e: Error) => e.message) }) });

const openTabs = new Set<TakerTab>();
const keptTabs = new Set<TakerTab>();
/** Register a tab for failure diagnostics; it is closed when the scenario ends unless `keep` is set (a profile shared by a whole file). */
export function track(tab: TakerTab, keep = false): TakerTab {
  (keep ? keptTabs : openTabs).add(tab);
  return tab;
}
/**
 * Run a scenario body; when it fails, print what a person would look at first (each open page's
 * text, the daemon's view of its swaps, its alerts and the end of its log) and rethrow.
 */
export function scenario(w: () => World, body: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (e) {
      try {
        for (const t of [...openTabs, ...keptTabs]) console.log(`\n----- page at failure ${t.page.url()}\n${await t.page.locator('body').innerText().catch((x: Error) => x.message)}\n----- page errors: ${JSON.stringify(t.errors)}`);
        for (const m of w().makers) {
          console.log(`----- maker ${m.o.n} swaps: ${JSON.stringify(await m.swaps().catch((x: Error) => x.message))}`);
          console.log(`----- maker ${m.o.n} alerts: ${JSON.stringify((await m.status().catch(() => null))?.alerts)}`);
          console.log(`----- maker ${m.o.n} log tail:\n${m.proc?.output().slice(-3000) ?? '(not running)'}`);
        }
      } catch {
        // diagnostics must never mask the failure
      }
      throw e;
    } finally {
      for (const t of openTabs) await t.close().catch(() => undefined);
      openTabs.clear();
    }
  };
}

/** From the offers page to a posted take deposit (sell XMR). */
export async function uiTakeSell(tab: TakerTab, w: World, o: { market: Market; xmr: string; refundAddress?: string }): Promise<{ ref: string; recoveryFile: string }> {
  const { page } = tab;
  await openOffer(tab, w, o.market, 'sell');
  await page.getByLabel('XMR to sell').fill(o.xmr);
  await page.getByLabel('Your XMR refund address').fill(o.refundAddress ?? w.takerXmr);
  const recoveryFile = await ensureBackup(page);
  const lock = page.getByTestId('lock-button');
  await expect.poll(() => lock.isDisabled(), { timeout: 30_000 }).toBe(false);
  await lock.click();
  const confirm = page.getByTestId('confirm-lock');
  await confirm.getByRole('checkbox').check();
  await confirm.getByRole('button', { name: /^Post deposit/ }).click();
  await page.getByTestId('swap-page').waitFor({ timeout: 60_000 });
  return { ref: refInUrl(page), recoveryFile };
}

/** What the page remembers about a swap (its local note): the sweep transaction among other things. */
export const pageNote = (page: Page, ref: string): Promise<{ sweepTxid?: string; destination?: string }> =>
  page.evaluate((r) => JSON.parse(localStorage.getItem(`xmrswap.note.${r}`) ?? '{}') as { sweepTxid?: string; destination?: string }, ref);

/** Every per-swap secret of a taker seed for a swap the browser opened is derived from the recovery file: register the seed itself. */
export function registerRecoverySecrets(w: World, recoveryFile: string, label: string): void {
  if (!recoveryFile) return;
  const j = JSON.parse(recoveryFile) as { seed?: string };
  if (j.seed) w.addSecret(`${label}.recoverySeed`, j.seed);
}

/** What a Monero wallet really holds: every unspent output, whether or not the daemon has frozen it (a frozen output is left out of `get_balance`). */
export async function holdings(wallet: { refresh(): Promise<unknown>; call<T>(m: string, p?: unknown): Promise<T> }): Promise<bigint> {
  await wallet.refresh();
  const r = await wallet.call<{ transfers?: { amount: number | string; spent: boolean }[] }>('incoming_transfers', { transfer_type: 'all', account_index: 0 });
  return (r.transfers ?? []).filter((t) => !t.spent).reduce((a, t) => a + BigInt(t.amount), 0n);
}

/** No process logged a secret; no page raised an error. */
export function expectClean(w: World, tabs: TakerTab[] = []): void {
  expect(w.leakedSecrets()).toEqual([]);
  for (const t of tabs) expect(t.errors).toEqual([]);
}
