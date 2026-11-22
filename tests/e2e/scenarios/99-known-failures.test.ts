// KNOWN FAILURES: each test reproduces a bug in another package that this suite found and that
// tests/e2e/BUGS.md records. The body states the correct behaviour at full strength. While the bug
// exists the body throws and the test is reported as an expected failure, apart from the ordinary
// scenarios; when it stops throwing the test fails, so the fix is noticed (scenarios/known.ts).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { SdkTaker } from '../src/taker.js';
import { type TakerTab, openTab } from '../src/ui.js';
import { waitFor } from '../src/util.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { track } from './helpers.js';
import { knownFailure } from './known.js';

let w: World;
let tab: TakerTab;
beforeAll(async () => {
  w = await startWorld({ ethereum: false, inventoryBlocks: 4 });
  tab = track(await openTab({ solKey: w.sol.stranger }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await w?.stop();
  await stopShared();
});

describe('KNOWN FAILURES (bugs in other packages; see tests/e2e/BUGS.md)', () => {
  knownFailure('BUG-2', 'apps/console: "Validate and save" must accept a configuration the daemon itself accepts and runs on; a file with `[pricing.sources.coingecko].base_url` (a daemon key) is refused as an unknown key, so no edit can be saved', async () => {
    const { page } = tab;
    expect((await new SdkTaker(w).offer(w.maker, 'sol', 1)).prices[0]).toBe(1_470_000_000n);
    // The daemon validated this very file at start and reports it valid.
    const cfg = await w.maker.api<{ toml: string; validation: { ok: boolean; errors: unknown[] } }>('GET', '/api/config');
    expect(cfg.toml).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+"/);
    expect(cfg.validation).toMatchObject({ ok: true, errors: [] });
    await page.goto(`${w.maker.apiUrl}/#/config`);
    const token = page.getByLabel('Access token');
    await token.waitFor();
    await token.fill(w.maker.token);
    await token.press('Enter');
    await page.getByRole('button', { name: /^Edit SOL.*buy/i }).click();
    const dev = page.getByRole('region', { name: /SOL.*buy.*settings/i }).getByLabel(/^Deviation from reference/).first();
    await dev.fill('5');
    await dev.blur();
    await page.getByRole('button', { name: 'Validate and save' }).click();
    // Applied without a restart: the next refresh publishes the new price; the file on disk carries the edit.
    await waitFor('the new price on-chain', async () => (await w.sol.client.getOffer(w.maker.makerPda, 0, 1))?.prices[0] === 1_425_000_000n, { timeoutMs: 30_000, context: () => page.getByRole('region', { name: 'Save configuration' }).innerText() });
    expect(readFileSync(w.maker.configPath, 'utf8')).toMatch(/deviation_pct = 5/);
  });
});
