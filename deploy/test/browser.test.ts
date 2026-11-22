/**
 * The page's own Status page, in a real browser, served by the bundle: the built UI reads the
 * bundle's `config.json`, finds the relay on its own origin, reaches the Monero nodes through
 * the proxy and a maker through the (fake) Tor proxy. This is the check DESIGN calls "Checking
 * it works": Tor reachable, RPC connected, Monero nodes in agreement.
 *
 * Chromium comes from $CHROMIUM or the newest build in the Playwright cache (SPEC 10.3).
 * Everything else is a loopback fake; the browser is given no way out of loopback.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROGRAM_ID } from '@xmrswap/protocol';
import { type Browser, type Page, chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startBundle } from '../src/server.js';
import { loadSettings } from '../src/settings.js';
import { closeAll, fakeOnion, onClose, startFakeMaker, startFakeMonero, startFakeSocks, startFakeSolana } from './fakes.js';

function findChromium(): string {
  const fromEnv = process.env['CHROMIUM'];
  if (fromEnv) return fromEnv;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)) : [];
  for (const d of builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) if (existsSync(path.join(cache, d, sub))) return path.join(cache, d, sub);
  }
  throw new Error('No Chromium found: set CHROMIUM to a Chromium binary (SPEC 10.3 prerequisites).');
}

let browser: Browser;
beforeAll(async () => {
  // Loopback only: any other destination is sent to a proxy that does not exist.
  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=127.0.0.1'] });
});
afterAll(async () => {
  await browser?.close();
});
afterEach(closeAll);

async function stack() {
  const socks = await startFakeSocks();
  let makerId = '';
  const maker = await startFakeMaker(() => makerId);
  const onion = fakeOnion();
  socks.map.set(onion, maker.port);
  const solana = await startFakeSolana([onion]);
  makerId = solana.makers[0]!.pubkey;
  const nodes = [await startFakeMonero(), await startFakeMonero()];
  const settings = loadSettings({
    env: { XMRSWAP_UI_LISTEN: '127.0.0.1:0', RELAY_BIND: '127.0.0.1:0', RELAY_TOR_SOCKS: `127.0.0.1:${socks.port}`, SOLANA_RPC_URL: solana.url, RELAY_MONERO_NODES: nodes.map((n) => n.url).join(',') },
  });
  const bundle = await startBundle(settings, { relay: { logSink: () => {}, statusCacheMs: 0 } });
  onClose(() => bundle.close());
  const page = await browser.newPage();
  onClose(() => page.close());
  const offLoopback: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:') && !r.url().startsWith('data:')) offLoopback.push(r.url());
  });
  return { bundle, socks, solana, nodes, maker, onion, page, offLoopback };
}

const check = (page: Page, id: string) => page.locator(`[data-testid="check-${id}"]`);
async function state(page: Page, id: string): Promise<string> {
  return `${await check(page, id).getAttribute('data-state')}: ${(await check(page, id).innerText()).replace(/\s+/g, ' ')}`;
}
async function recheck(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('button', { name: 'Check again' }).waitFor({ state: 'visible' });
  await expect.poll(() => page.getByRole('button', { name: 'Check again' }).isEnabled()).toBe(true);
}

describe("the UI's Status page, served by the bundle", () => {
  it('shows Tor reachable, RPC connected and Monero nodes in agreement, using only this origin and the configured RPC', async () => {
    const s = await stack();
    await s.page.goto(`${s.bundle.url}/#/status`);
    await check(s.page, 'monero').waitFor();

    await expect.poll(() => state(s.page, 'solana')).toMatch(/^ok: .*Solana RPC connected/);
    expect(await state(s.page, 'program')).toContain(`Program ${PROGRAM_ID} is initialised`);
    expect(await state(s.page, 'monero')).toMatch(/^ok: .*Monero nodes in agreement 2 nodes in agreement/);
    // The page reaches the nodes through the bundle's own origin.
    expect(await state(s.page, 'monero')).toContain(`${s.bundle.url}/monero/0 at height 3300000`);
    expect(await state(s.page, 'relay')).toMatch(new RegExp(`^ok: .*Relay reachable ${s.bundle.url}\\. It knows 1 maker`));
    expect(await state(s.page, 'tor-proxy')).toMatch(/^ok: .*Tor proxy reachable/);
    // The real test of the Tor path: a forward to the registered maker's /info through the SOCKS proxy.
    expect(await state(s.page, 'tor-maker')).toMatch(/^ok: .*Maker reachable over Tor/);
    expect(s.socks.connects).toContain(s.onion);
    expect(s.maker.seen.some((r) => r.url === '/xs/v1/info')).toBe(true);
    // While the upgrade status cannot be confirmed the page says to treat the code as upgradable.
    expect(await state(s.page, 'upgrade-solana')).toMatch(/^warn: /);

    // The browser talked to this origin and to the configured RPC, nothing else.
    expect(s.offLoopback).toEqual([]);
    expect(s.nodes[0]!.seen.length).toBeGreaterThan(0);
    expect(s.nodes[0]!.seen.every((r) => r.headers['origin'] === undefined || r.headers['origin'] === null)).toBe(true);
  });

  it('starts in self-hosted mode with the pinned program id, from the bundle defaults', async () => {
    const s = await stack();
    await s.page.goto(`${s.bundle.url}/#/settings`);
    await expect.poll(() => s.page.getByLabel('Solana program id').inputValue()).toBe(PROGRAM_ID);
    expect(await s.page.getByLabel('Solana RPC URL').inputValue()).toBe(s.solana.url);
    expect(await s.page.getByLabel('Relay URL').inputValue()).toBe('/');
    expect(await s.page.getByLabel('Node URLs, one per line').inputValue()).toBe(`${s.bundle.url}/monero/0\n${s.bundle.url}/monero/1`);
    expect(await s.page.getByRole('radio', { name: /Self-hosted relay/ }).isChecked()).toBe(true);
  });

  it('reports Tor unreachable with the on-chain fallback, and a Monero node that falls behind', async () => {
    const s = await stack();
    await s.page.goto(`${s.bundle.url}/#/status`);
    await expect.poll(() => state(s.page, 'tor-maker')).toMatch(/^ok: /);

    // The Tor client goes away.
    await s.socks.close();
    s.nodes[1]!.height = 3_299_000;
    await recheck(s.page);
    await expect.poll(() => state(s.page, 'tor-proxy')).toMatch(/^fail: .*Tor proxy not reachable.*Messages fall back to on-chain/);
    expect(await state(s.page, 'monero')).toMatch(/^fail: .*The nodes are 1000 blocks apart/);
    expect(await state(s.page, 'monero')).toContain('locks will not count as confirmed until they agree');
    // The chain itself is still reachable: refunds do not depend on the relay or Tor.
    expect(await state(s.page, 'solana')).toMatch(/^ok: /);
  });
});
