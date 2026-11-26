import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getPath, parseToml } from '../src/lib/config/toml.js';
import { DEFAULT_TOML } from '../src/mock/fixtures.js';
import { DESIGN_BOTH_TOML, DESIGN_CONFIG_TOML, DESIGN_REBALANCE_TOML } from './design.js';
import { mount, text, type Mounted } from './harness.js';

async function openConfig(opts: Parameters<typeof mount>[1] = {}): Promise<Mounted> {
  const m = mount('#/config', opts);
  await screen.findByRole('region', { name: 'Markets and offers' });
  return m;
}
const saved = async (m: Mounted): Promise<Record<string, unknown>> => parseToml((await m.client.call('configGet')).toml);
const saveBar = (): HTMLElement => screen.getByRole('region', { name: 'Save configuration' });
const setValue = async (user: UserEvent, input: HTMLElement, value: string): Promise<void> => {
  await user.clear(input);
  if (value !== '') await user.type(input, value);
};
async function editOffer(user: UserEvent, name: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `Edit ${name} settings` }));
  return screen.getByRole('region', { name: `${name} settings` });
}
const save = async (user: UserEvent): Promise<void> => {
  await user.click(within(saveBar()).getByRole('button', { name: 'Validate and save' }));
};

describe('configuration: one page for liquidity, offers and pricing', () => {
  it('has a section for every part of the file', async () => {
    await openConfig();
    for (const name of ['Markets and offers', 'Price sources', 'Offer updates and cost', 'Liquidity', 'Guardrails', 'Rebalancing', 'Daemon and connections', 'Import and export', 'Change log']) {
      expect(screen.getByRole('region', { name }), name).toBeTruthy();
    }
  });

  it('switches each of the four markets on or off per direction', async () => {
    const m = await openConfig();
    const names = ['USDC-SOL', 'SOL', 'USDC-ETH', 'ETH'].flatMap((mk) => [`${mk} Sell XMR enabled`, `${mk} Buy XMR enabled`]);
    const states = names.map((n) => (screen.getByRole('switch', { name: n }) as HTMLInputElement).checked);
    // The mock's file: USDC-SOL both ways, SOL sell, USDC-ETH sell.
    expect(states).toEqual([true, true, true, false, true, false, false, false]);

    await m.user.click(screen.getByRole('switch', { name: 'USDC-SOL Buy XMR enabled' }));
    await m.user.click(screen.getByRole('switch', { name: 'SOL Buy XMR enabled' }));
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('2 unsaved changes');
    // Nothing reaches the daemon until it is saved.
    expect(getPath(await saved(m), 'markets.usdc_sol.buy_xmr.enabled')).toBe(true);

    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'markets.usdc_sol.buy_xmr.enabled')).toBe(false));
    const cfg = await saved(m);
    expect(getPath(cfg, 'markets.sol.buy_xmr.enabled')).toBe(true);
    expect(getPath(cfg, 'markets.sol.sell_xmr.enabled')).toBe(true);
    const offers = (await m.client.call('offers')).offers;
    expect(offers.find((o) => o.market === 'usdc_sol' && o.direction === 'buy_xmr')?.enabled).toBe(false);
    expect(offers.find((o) => o.market === 'sol' && o.direction === 'buy_xmr')?.enabled).toBe(true);
  });

  it('offers every setting of DESIGN’s offer table, per market and direction', async () => {
    const m = await openConfig();
    const editor = await editOffer(m.user, 'USDC-SOL Sell XMR');
    const labels = [
      'Deviation from reference',
      'Size tiers',
      'Inventory skew',
      'Smallest swap',
      'Largest swap',
      'Offer validity',
      'Confirmation depth',
      'Lock-notice deadline',
      'Final deadline',
      'Anti-spam deposit',
      'Daily volume cap',
      'Approval mode',
      'Approval window',
      'Claim delay',
      'Withhold policy',
      'Primary price source',
      'Fallback order',
      'Claim window',
    ];
    for (const l of labels) expect(within(editor).getAllByText(l, { selector: 'label, .label' }).length, l).toBeGreaterThan(0);
    // Values come from the file; absent keys show their default.
    expect((within(editor).getByLabelText('Deviation from reference') as HTMLInputElement).value).toBe('1.5');
    expect((within(editor).getByLabelText('Largest swap') as HTMLInputElement).value).toBe('200');
    expect((within(editor).getByLabelText('Offer validity') as HTMLInputElement).value).toBe('60');
    expect((within(editor).getByLabelText('Lock-notice deadline') as HTMLInputElement).placeholder).toBe('default 600');
    expect((within(editor).getByLabelText('Approval mode') as HTMLSelectElement).value).toBe('auto');
    expect((within(editor).getByLabelText('Withhold policy') as HTMLSelectElement).value).toBe('price_moved');
    expect((within(editor).getByLabelText('Size tiers: above, row 1') as HTMLInputElement).value).toBe('50');
    expect((within(editor).getByLabelText('Confirmation depth: confirmations, row 3') as HTMLInputElement).value).toBe('25');
    // The other direction and the other chain have their own editor and defaults.
    const eth = await editOffer(m.user, 'ETH Buy XMR');
    expect((within(eth).getByLabelText('Lock-notice deadline') as HTMLInputElement).placeholder).toBe('default 1800');
    expect((within(eth).getByLabelText('Approval window') as HTMLInputElement).placeholder).toBe('default 120');
  });

  it('saves an edit, applies it without a restart and shows it in the change log', async () => {
    const m = await openConfig();
    const started = (await m.client.call('status')).started_at;
    const editor = await editOffer(m.user, 'USDC-SOL Sell XMR');
    await setValue(m.user, within(editor).getByLabelText('Deviation from reference'), '1.75');
    await m.user.selectOptions(within(editor).getByLabelText('Approval mode'), 'window');
    m.advance(90);
    await save(m.user);
    expect(await screen.findByText('Saved. The daemon applied the change without a restart and recorded it in the change log.')).toBeTruthy();
    expect(getPath(await saved(m), 'markets.usdc_sol.sell_xmr.deviation_pct')).toBe(1.75);
    expect((await m.client.call('status')).started_at).toBe(started);
    const live = (await m.client.call('offers')).offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr');
    expect(live?.deviation_pct).toBe(1.75);
    expect(live?.terms.approval_mode).toBe('window');

    const log = screen.getByRole('table', { name: 'Configuration change log' });
    await waitFor(() => expect(within(log).getAllByRole('row')).toHaveLength(3));
    const newest = within(log).getAllByRole('row')[1] as HTMLElement;
    expect(text(newest)).toContain('This console');
    expect(text(newest)).toContain('markets.usdc_sol.sell_xmr.deviation_pct: 1.5 → 1.75');
    expect(text(newest)).toContain('markets.usdc_sol.sell_xmr.approval_mode: unset → "window"');
    expect(text(within(log).getAllByRole('row')[2] as HTMLElement)).toContain('File edited on disk');
    await waitFor(() => expect(text(within(saveBar()).getByTestId('change-count'))).toBe('No unsaved changes'));
  });

  it('reviews and discards unsaved changes', async () => {
    const m = await openConfig();
    await setValue(m.user, screen.getByLabelText('XMR reserve'), '75');
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Review' }));
    const changes = within(saveBar()).getByRole('table', { name: 'Unsaved changes' });
    expect(text(within(changes).getAllByRole('row')[1] as HTMLElement)).toBe('liquidity.xmr_reserve5075');
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Discard changes' }));
    expect((screen.getByLabelText('XMR reserve') as HTMLInputElement).value).toBe('50');
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('No unsaved changes');
    expect((within(saveBar()).getByRole('button', { name: 'Validate and save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('configuration: validation before save', () => {
  it('refuses a deposit above 5% and saves nothing', async () => {
    const m = await openConfig();
    const editor = await editOffer(m.user, 'USDC-SOL Sell XMR');
    const deposit = within(editor).getByLabelText('Anti-spam deposit') as HTMLInputElement;
    expect(deposit.value).toBe('2');
    expect(text(deposit.closest('.field'))).toContain('5% at most');
    await setValue(m.user, deposit, '6');
    expect(deposit.getAttribute('aria-invalid')).toBe('true');
    expect(text(deposit.closest('.field'))).toContain('Error: Anti-spam deposit must be at most 5.');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('1 error');

    await save(m.user);
    const alert = await within(saveBar()).findByRole('alert');
    expect(text(alert)).toContain('Not saved: 1 error has to be fixed first.');
    expect(text(alert)).toContain('markets.usdc_sol.sell_xmr.deposit_pct');
    expect(getPath(await saved(m), 'markets.usdc_sol.sell_xmr.deposit_pct')).toBe(2);
    expect((await m.client.call('configLog')).entries).toHaveLength(1);

    // Exactly 5% is allowed.
    await setValue(m.user, deposit, '5');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'markets.usdc_sol.sell_xmr.deposit_pct')).toBe(5));
  });

  it('shows the claim-delay minimum implied by the depth and enforces it', async () => {
    const m = await openConfig();
    const editor = await editOffer(m.user, 'USDC-SOL Sell XMR');
    // Up to 200 XMR, so depth 25 is in use: 101 minutes on Solana.
    const note = within(editor).getByTestId('claim-delay-minimum');
    expect(text(note)).toBe("Minimum implied by the depth in use: 101 minutes at depth 25 on Solana (the contract's floor is 60). Automatic resolves to 101 minutes.");
    await m.user.click(within(editor).getByRole('switch', { name: 'Automatic' }));
    const delay = within(editor).getByLabelText('Claim delay') as HTMLInputElement;
    expect(delay.value).toBe('60');
    expect(text(delay.closest('.field'))).toContain('Error: usdc_sol sell_xmr: a claim delay of 60 minutes is too short. At depth 25 on Solana the minimum is 101 minutes.');
    await setValue(m.user, delay, '45');
    expect(text(delay.closest('.field'))).toContain('At depth 25 on Solana the minimum is 101 minutes.');
    await save(m.user);
    expect(text(await within(saveBar()).findByRole('alert'))).toContain('Not saved');
    expect(getPath(await saved(m), 'markets.usdc_sol.sell_xmr.claim_delay_minutes')).toBeUndefined();

    await setValue(m.user, delay, '101');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');

    // Lower the largest swap below the 50 XMR tier: the minimum falls back to the contract's floor.
    await setValue(m.user, within(editor).getByLabelText('Largest swap'), '20');
    expect(text(within(editor).getByTestId('claim-delay-minimum'))).toContain('60 minutes at depth 10 on Solana');

    // Ethereum: 170 minutes at depth 25, and "auto" resolves to the 180-minute default.
    const eth = await editOffer(m.user, 'USDC-ETH Sell XMR');
    expect(text(within(eth).getByTestId('claim-delay-minimum'))).toBe("Minimum implied by the depth in use: 170 minutes at depth 25 on Ethereum (the contract's floor is 120). Automatic resolves to 180 minutes.");
  });

  it('strongly recommends an approval window of 60 seconds or less and says why', async () => {
    const m = await openConfig();
    const editor = await editOffer(m.user, 'SOL Sell XMR');
    const advice = within(editor).getByTestId('approval-window-advice');
    expect(text(advice)).toBe('Strongly recommended: 60 seconds or less. Longer windows hold taker funds and deter takers.');
    const win = within(editor).getByLabelText('Approval window') as HTMLInputElement;
    expect(win.value).toBe('60');
    expect(text(win.closest('.field'))).not.toContain('Warning:');

    await setValue(m.user, win, '300');
    expect(text(within(editor).getByTestId('approval-window-advice'))).toBe(
      'Strongly recommended: 60 seconds or less. Longer windows hold taker funds and deter takers. At 300 seconds takers see a warning before they lock, stating how long their funds may be held.',
    );
    expect(text(win.closest('.field'))).toContain('Warning: sol sell_xmr: an approval window of 300 seconds is longer than the recommended 60 seconds. Longer windows hold taker funds and deter takers. Takers see a warning on this offer.');
    // A warning does not block saving; the hard cap does.
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await setValue(m.user, win, '4000');
    expect(text(win.closest('.field'))).toContain('Error: Approval window must be at most 3600.');
    await setValue(m.user, win, '10');
    expect(text(win.closest('.field'))).toContain('Error: Approval window must be at least 30.');
  });

  it('refuses to switch on an Ethereum market without a blob endpoint', async () => {
    const m = await openConfig({ blobEndpoint: false });
    const sw = screen.getByRole('switch', { name: 'ETH Sell XMR enabled' }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await m.user.click(sw);
    expect(sw.checked).toBe(false);
    const alert = screen.getByRole('alert');
    expect(text(alert)).toContain('Refused. ETH Sell XMR was not switched on: Ethereum markets need a blob endpoint in the registry');
    expect(within(alert).getByRole('link', { name: 'Open Registration' }).getAttribute('href')).toBe('#/registration');
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('No unsaved changes');
    // A market that the file already enables is shown as kept off, with the reason.
    const cell = (screen.getByRole('switch', { name: 'USDC-ETH Sell XMR enabled' }) as HTMLElement).closest('td');
    expect(text(cell)).toContain('Kept off');
    expect(text(cell)).toContain('no blob endpoint is listed in the registry');
    // Solana markets are not affected.
    await m.user.click(screen.getByRole('switch', { name: 'SOL Buy XMR enabled' }));
    expect((screen.getByRole('switch', { name: 'SOL Buy XMR enabled' }) as HTMLInputElement).checked).toBe(true);
  });

  it('allows an Ethereum market when a blob endpoint is listed', async () => {
    const m = await openConfig();
    await m.user.click(screen.getByRole('switch', { name: 'ETH Sell XMR enabled' }));
    expect((screen.getByRole('switch', { name: 'ETH Sell XMR enabled' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('Refused.')).toBeNull();
  });

  it('shows the wXMR pool as the primary source it was chosen as, with the risk beside the field and no demotion', async () => {
    const m = await openConfig();
    const pricing = screen.getByRole('region', { name: 'Price sources' });
    expect(text(pricing)).toContain('You choose the sources. Any configured source may be a market’s primary, sit anywhere in its fallback order, or be the cross-check');
    expect(text(screen.getByRole('main'))).not.toMatch(/cross-check only|may only be a cross-check|promoted to primary/i);
    // The SOL market of the example names the pool as primary, and that is what is shown.
    const sol = await editOffer(m.user, 'SOL Sell XMR');
    const source = within(sol).getByLabelText('Primary price source') as HTMLSelectElement;
    expect(source.value).toBe('wxmr_pool');
    expect([...source.options].map((o) => o.textContent)).toEqual(['CoinGecko', 'CoinMarketCap', 'wXMR pool', 'wXMR pool (second, SOL-quoted)']);
    expect(text(sol)).toContain('Price source: wxmr_pool, then coingecko, cross-checked against coinmarketcap.');
    const field = text(source.closest('.field'));
    expect(field).toContain('Warning: sol sell_xmr: this market is priced from the wXMR pool. A thin pool can be pushed off-market cheaply by someone who then takes your quote. On 21 November 2026 wXMR showed about $392,500 of liquidity across 719 pools, and one of its USDC pools held about $35,700.');
    // The pool's own protections are right there, as the controls that matter most.
    const protections = within(sol).getByRole('group', { name: 'Pool protections' });
    expect(text(protections)).toContain('The controls that matter most when the pool sets your price.');
    const liquidity = within(protections).getByLabelText('Minimum pool liquidity') as HTMLInputElement;
    expect(liquidity.value).toBe('250000');
    expect((within(protections).getByLabelText('Averaging window') as HTMLInputElement).value).toBe('300');
    await setValue(m.user, liquidity, '500000');
    expect(text(source.closest('.field'))).toContain('minimum liquidity (now $500,000)');
    // A warning, not an error: nothing about the choice blocks a save.
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'pricing.sources.wxmr_pool.min_liquidity_usd')).toBe(500000));
    expect(getPath(await saved(m), 'markets.sol.sell_xmr.source')).toBe('wxmr_pool');
  });

  it('accepts a single source with no fallback and no cross-check, warning beside each field', async () => {
    const m = await openConfig();
    const editor = await editOffer(m.user, 'USDC-SOL Sell XMR');
    await m.user.selectOptions(within(editor).getByLabelText('Primary price source'), 'wxmr_pool');
    await m.user.click(within(within(editor).getByRole('group', { name: 'Fallback order' })).getByRole('button', { name: 'Remove CoinMarketCap from Fallback order' }));
    const cross = within(editor).getByLabelText('Cross-check for this market') as HTMLSelectElement;
    expect([...cross.options].map((o) => o.textContent)).toEqual(['Same as the setting for all markets', 'CoinGecko', 'CoinMarketCap', 'wXMR pool', 'wXMR pool (second, SOL-quoted)', 'None for this market']);
    await m.user.selectOptions(cross, 'none');

    expect(text(within(editor).getByRole('group', { name: 'Fallback order' }).closest('.field'))).toContain('Warning: usdc_sol sell_xmr: no fallback, so quoting pauses whenever the wXMR pool is unavailable.');
    expect(text(cross.closest('.field'))).toContain('Warning: usdc_sol sell_xmr: no cross-check, so nothing checks this price against a second source.');
    expect(text(within(editor).getByLabelText('Primary price source').closest('.field'))).toContain('A thin pool can be pushed off-market cheaply');
    expect(text(editor)).toContain('Price source: wxmr_pool, no fallback, no cross-check.');
    expect(text(within(editor).getByTestId('disagreement-scope'))).toBe('Disagreement pause: not applicable to this market, since nothing is compared.');
    // Still on, still saveable.
    expect(text((screen.getByRole('switch', { name: 'USDC-SOL Sell XMR enabled' }) as HTMLElement).closest('td'))).not.toContain('Kept off');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'markets.usdc_sol.sell_xmr.source')).toBe('wxmr_pool'));
    const cfg = await saved(m);
    expect(getPath(cfg, 'markets.usdc_sol.sell_xmr.fallbacks')).toBeUndefined();
    expect(getPath(cfg, 'markets.usdc_sol.sell_xmr.cross_check')).toBe('none');
    const live = (await m.client.call('offers')).offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr');
    expect(live?.enabled).toBe(true);
    // Another market keeps its cross-check.
    const other = await editOffer(m.user, 'USDC-SOL Buy XMR');
    expect(text(within(other).getByTestId('disagreement-scope'))).toBe('The disagreement pause covers this market.');
  });

  it('lets the cross-check for all markets be None, and shows the disagreement guardrail as not applicable', async () => {
    const m = await openConfig();
    const pricing = screen.getByRole('region', { name: 'Price sources' });
    const cross = within(pricing).getByLabelText('Cross-check source') as HTMLSelectElement;
    expect([...cross.options].map((o) => o.textContent)).toEqual(['None', 'CoinGecko', 'CoinMarketCap', 'wXMR pool', 'wXMR pool (second, SOL-quoted)']);
    expect(text(screen.getByTestId('disagreement-threshold'))).toBe('threshold: 1% (largest disagreement allowed, under Price sources)');
    await m.user.selectOptions(cross, '');
    expect(text(screen.getByTestId('disagreement-threshold'))).toBe('not applicable: no cross-check source is set, so there is nothing to compare');
    expect(text(screen.getByRole('region', { name: 'Guardrails' }))).toContain('Warning: Not applicable: no cross-check source is set, so the disagreement pause has nothing to compare.');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'pricing.cross_check')).toBeUndefined());
    // The pool may be the cross-check too.
    await m.user.selectOptions(within(screen.getByRole('region', { name: 'Price sources' })).getByLabelText('Cross-check source'), 'wxmr_pool');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
  });

  it('shows the daemon’s missing-price error on that market’s source field, and saves once it is fixed', async () => {
    const m = await openConfig();
    // SOL from the USDC-quoted pool alone: XMR/USD but no SOL/USD.
    const sol = await editOffer(m.user, 'SOL Sell XMR');
    await m.user.click(within(within(sol).getByRole('group', { name: 'Fallback order' })).getByRole('button', { name: 'Remove CoinGecko from Fallback order' }));
    const field = (): string => text(within(sol).getByLabelText('Primary price source').closest('.field'));
    // At once, locally: a warning.
    expect(field()).toContain("Warning: sol sell_xmr needs XMR/SOL; wxmr_pool supplies XMR/USD and nothing here supplies SOL/USD");
    // Then the daemon's answer for this draft: an error on the same field.
    await waitFor(() => expect(field()).toContain("Error: sol sell_xmr needs XMR/SOL; wxmr_pool supplies XMR/USD and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, use a SOL-quoted pool (wxmr_pool_sol), or disable the market"));
    expect((within(sol).getByLabelText('Primary price source') as HTMLElement).getAttribute('aria-invalid')).toBe('true');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('1 error');
    await save(m.user);
    expect(text(await within(saveBar()).findByRole('alert'))).toContain('markets.sol.sell_xmr.source: sol sell_xmr needs XMR/SOL');
    expect(getPath(await saved(m), 'markets.sol.sell_xmr.fallbacks')).toEqual(['coingecko']);

    // A SOL-quoted pool gives XMR/SOL directly: the error goes and the save goes through.
    await m.user.selectOptions(within(screen.getByRole('region', { name: 'Price sources' })).getAllByLabelText('Quote asset')[0] as HTMLElement, 'sol');
    await waitFor(() => expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors'));
    expect(field()).not.toContain('needs XMR/SOL');
  });

  it('checks every keystroke with the daemon as well as locally', async () => {
    const m = await openConfig();
    const spy = vi.spyOn(m.client, 'call');
    await setValue(m.user, screen.getByLabelText('XMR reserve'), '80');
    expect(text(saveBar())).toContain('checking with the daemon');
    await waitFor(() => expect(spy.mock.calls.some((c) => c[0] === 'configValidate')).toBe(true));
    await waitFor(() => expect(text(saveBar())).not.toContain('checking with the daemon'));
    expect(spy.mock.calls.some((c) => c[0] === 'configPut')).toBe(false);
  });

  it('does not overwrite a configuration that changed underneath', async () => {
    const m = await openConfig();
    await setValue(m.user, screen.getByLabelText('XMR reserve'), '60');
    // Meanwhile the file changes elsewhere.
    await m.client.call('configImport', { body: { toml: DEFAULT_TOML.replace('max_in_flight_xmr = 400', 'max_in_flight_xmr = 300') } });
    await save(m.user);
    const alert = await within(saveBar()).findByRole('alert');
    expect(text(alert)).toContain('Not saved: the configuration changed underneath you.');
    expect(getPath(await saved(m), 'liquidity.xmr_reserve')).toBe(50);
    await m.user.click(within(alert).getByRole('button', { name: 'Reload the configuration' }));
    await waitFor(() => expect((screen.getByLabelText('Largest total in flight') as HTMLInputElement).value).toBe('300'));
    expect((screen.getByLabelText('XMR reserve') as HTMLInputElement).value).toBe('50');
  });

  it('reports text typed into a number box instead of dropping it', async () => {
    const m = await openConfig();
    const reserve = screen.getByLabelText('XMR reserve');
    await setValue(m.user, reserve, 'lots');
    expect(text(reserve.closest('.field'))).toContain('Error: XMR reserve must be a number.');
    // Emptying a box removes the key, so the default applies again.
    await setValue(m.user, reserve, '');
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Review' }));
    expect(text(within(saveBar()).getByRole('table', { name: 'Unsaved changes' }))).toContain('liquidity.xmr_reserve50unset');
  });
});

describe('configuration: offer updates and daily cost', () => {
  const section = (): HTMLElement => screen.getByRole('region', { name: 'Offer updates and cost' });
  // DESIGN's table, verbatim, plus the dollar figure at the mock's SOL price of $187.42.
  const rows: [interval: string, updates: string, sol: string, usd: string][] = [
    ['1', '86,400', '0.432 SOL', 'about $80.97'],
    ['5', '17,280', '0.0864 SOL', 'about $16.19'],
    ['10', '8,640', '0.0432 SOL', 'about $8.10'],
    ['30', '2,880', '0.0144 SOL', 'about $2.70'],
    ['60', '1,440', '0.0072 SOL', 'about $1.35'],
  ];
  it.each(rows)('an interval of %s s shows %s updates and %s a day, before saving', async (interval, updates, sol, usd) => {
    const m = await openConfig();
    expect(text(within(section()).getByTestId('daily-sol'))).toBe('0.0288 SOL');
    await setValue(m.user, within(section()).getByLabelText('Update interval'), interval);
    expect(text(within(section()).getByTestId('daily-sol'))).toBe(sol);
    expect(text(within(section()).getByTestId('daily-usd'))).toBe(usd);
    expect(text(within(section()).getByTestId('daily-sol').closest('.stat'))).toContain(`${updates} updates × 5,000 lamports`);
    // The saved configuration is untouched: this is the estimate for the draft.
    expect(getPath(await saved(m), 'offers.update_interval_seconds')).toBe(15);
  });

  it('lists DESIGN’s comparison table', async () => {
    await openConfig();
    const table = within(section()).getByRole('table', { name: 'Daily cost by update interval' });
    const body = within(table).getAllByRole('row').slice(1).map(text);
    expect(body).toEqual([
      '1 second86,4000.432 SOL · $80.97',
      '5 seconds17,2800.0864 SOL · $16.19',
      '10 seconds8,6400.0432 SOL · $8.10',
      '15 seconds (yours)5,7600.0288 SOL · $5.40',
      '30 seconds2,8800.0144 SOL · $2.70',
      '60 seconds1,4400.0072 SOL · $1.35',
    ]);
  });

  it('recalculates as the priority fee changes', async () => {
    const m = await openConfig();
    await setValue(m.user, within(section()).getByLabelText('Update interval'), '60');
    await setValue(m.user, within(section()).getByLabelText('Priority fee'), '10000');
    // 10,000 micro-lamports per compute unit over 24,120 units = 242 lamports on top of 5,000.
    expect(text(within(section()).getByTestId('daily-sol'))).toBe('0.00754848 SOL');
    expect(text(within(section()).getByTestId('daily-sol').closest('.stat'))).toContain('1,440 updates × 5,242 lamports');
    expect(text(section())).toContain('The priority fee adds 242 lamports to each update.');
    await setValue(m.user, within(section()).getByLabelText('Priority fee'), '0');
    expect(text(within(section()).getByTestId('daily-sol'))).toBe('0.0072 SOL');
  });

  it('shows the actual 24-hour spend and the runway with its alert threshold', async () => {
    const m = await openConfig();
    // 97% of the 0.0288 SOL estimate was actually spent; the wallet holds 2.4 SOL.
    expect(text(within(section()).getByTestId('spent-sol'))).toBe('0.027936 SOL');
    expect(text(within(section()).getByTestId('spent-sol').closest('.stat'))).toContain('about $5.24 on offer updates');
    const runway = within(section()).getByTestId('runway');
    expect(text(runway)).toBe('83.3 days');
    expect(text(runway.closest('.stat'))).toContain('fee wallet holds 2.4 SOL · alert below 7 days');
    // A faster interval shortens the runway at once; below the threshold it alerts.
    await setValue(m.user, within(section()).getByLabelText('Update interval'), '1');
    expect(text(within(section()).getByTestId('runway'))).toBe('5.5 days');
    expect(text(within(section()).getByRole('alert'))).toContain('The fee wallet is running low. At this rate it covers 5.5 days of updates, below your alert threshold of 7 days.');
    await setValue(m.user, within(section()).getByLabelText('Update interval'), '5');
    expect(text(within(section()).getByTestId('runway'))).toBe('27.8 days');
    expect(within(section()).queryByRole('alert')).toBeNull();
  });

  it('shows the expected and maximum cost of move-triggered updates', async () => {
    const m = await openConfig();
    expect(within(section()).queryByTestId('triggered')).toBeNull();
    await setValue(m.user, within(section()).getByLabelText('Update interval'), '5');
    await setValue(m.user, within(section()).getByLabelText('Update only when the price moves by'), '0.25');
    await setValue(m.user, within(section()).getByLabelText('Minimum refresh interval'), '30');
    // The maximum is known at once: at most one update per 30 s, 2,880 a day.
    expect(text(within(section()).getByTestId('triggered'))).toContain('0.0144 SOL at most');
    // The expectation comes from the daemon's price history (310 a day here), but never fewer than
    // one refresh per 60 s offer validity: 1,440 a day.
    await waitFor(() => expect(text(within(section()).getByTestId('triggered'))).toBe('0.0072 SOL expected, 0.0144 SOL at most'));
    expect(text(within(section()).getByTestId('triggered').closest('.stat'))).toContain('about 1,440 updates a day, at most 2,880 ($1.35 to $2.70)');
  });

  it('lists occasional costs separately, the Ethereum registry in ETH', async () => {
    await openConfig();
    const table = within(section()).getByRole('table', { name: 'Occasional costs' });
    const body = within(table).getAllByRole('row').slice(1).map(text);
    expect(body).toEqual([
      'Key-pool refillsOne transaction per eight fills on an auto-accept offer30.000015 SOL',
      'Key rotationsOne transaction per rotation10.000005 SOL',
      'Quotes posted on requestA small on-chain account per quote, paid by you20.0032 SOL',
      'Ethereum registry changesPaid in ETH10.000412 ETH',
    ]);
    expect(text(section())).toContain('These are not part of the daily estimate.');
    expect(text(section())).toContain('the cost does not multiply by the number of markets');
  });
});

describe('configuration: price sources, guardrails, liquidity, rebalancing', () => {
  it('edits the fallback order, the cross-check and the failure action', async () => {
    const m = await openConfig();
    const pricing = screen.getByRole('region', { name: 'Price sources' });
    expect((within(pricing).getByLabelText('Cross-check source') as HTMLSelectElement).value).toBe('coinmarketcap');
    await m.user.selectOptions(within(pricing).getByLabelText('When a check fails'), 'widen');
    await setValue(m.user, within(pricing).getByLabelText('Widen by'), '0.75');
    await setValue(m.user, within(pricing).getByLabelText('Largest disagreement allowed'), '1.5');
    await setValue(m.user, within(pricing).getByLabelText('Maximum price age'), '90');

    const editor = await editOffer(m.user, 'USDC-SOL Sell XMR');
    const fallbacks = within(editor).getByRole('group', { name: 'Fallback order' });
    expect(within(fallbacks).getAllByRole('listitem').map(text)).toEqual(['1CoinMarketCapUpDownRemove']);
    // The pool may sit anywhere in the order, first included; nothing skips it.
    await m.user.selectOptions(within(fallbacks).getByRole('combobox', { name: 'Add to Fallback order' }), 'wxmr_pool');
    await m.user.click(within(fallbacks).getByRole('button', { name: 'Move wXMR pool up in Fallback order' }));
    expect(within(fallbacks).getAllByRole('listitem').map((li) => text(li).replace(/UpDownRemove$/, ''))).toEqual(['1wXMR pool', '2CoinMarketCap']);
    expect(text(fallbacks.closest('.field'))).not.toMatch(/skipped as a fallback|cross-check only/);

    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'pricing.on_failure')).toBe('widen'));
    const cfg = await saved(m);
    expect(getPath(cfg, 'pricing.widen_pct')).toBe(0.75);
    expect(getPath(cfg, 'pricing.max_disagreement_pct')).toBe(1.5);
    expect(getPath(cfg, 'pricing.max_age_seconds')).toBe(90);
    expect(getPath(cfg, 'markets.usdc_sol.sell_xmr.fallbacks')).toEqual(['wxmr_pool', 'coinmarketcap']);
  });

  it('gives every guardrail its own switch and thresholds', async () => {
    const m = await openConfig();
    const g = screen.getByRole('region', { name: 'Guardrails' });
    const sw = (name: string): HTMLInputElement => within(g).getByRole('switch', { name }) as HTMLInputElement;
    expect(within(g).getAllByRole('switch').map((s) => s.getAttribute('aria-label') ?? text(s.parentElement))).toEqual([
      'Volatility pause: on',
      'Disagreement pause',
      'Stale price pause',
      'Hard price band: on',
      'Reorg guard',
      'Dry run',
    ]);
    expect([sw('Volatility pause: on').checked, sw('Disagreement pause').checked, sw('Stale price pause').checked, sw('Hard price band: on').checked, sw('Reorg guard').checked, sw('Dry run').checked]).toEqual([true, true, true, true, false, false]);
    // Thresholds from the file.
    expect((within(g).getByLabelText('Volatility pause: move') as HTMLInputElement).value).toBe('3');
    expect((within(g).getByLabelText('Volatility pause: within') as HTMLInputElement).value).toBe('600');
    expect((within(g).getByLabelText('Hard price band: minimum') as HTMLInputElement).value).toBe('300');
    expect((within(g).getByLabelText('Hard price band: maximum') as HTMLInputElement).value).toBe('900');
    expect(text(g)).toContain('threshold: 1% (largest disagreement allowed, under Price sources)');
    expect(text(g)).toContain('threshold: 60 s (maximum price age, under Price sources)');

    // Each switches off by itself.
    await m.user.click(sw('Volatility pause: on'));
    await m.user.click(sw('Stale price pause'));
    await m.user.click(sw('Reorg guard'));
    await setValue(m.user, within(g).getByLabelText('Reorg guard: raise depth to'), '40');
    await setValue(m.user, within(g).getByLabelText('Hard price band: maximum'), '250');
    expect(text(g)).toContain("Error: The price band's minimum (300) must be below its maximum (250).");
    await setValue(m.user, within(g).getByLabelText('Hard price band: maximum'), '950');
    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'guardrails.stale_pause')).toBe(false));
    const cfg = await saved(m);
    expect(getPath(cfg, 'guardrails.volatility_pause')).toBeUndefined();
    expect(getPath(cfg, 'guardrails.reorg_guard')).toEqual({ enabled: true, raise_depth_to: 40 });
    expect(getPath(cfg, 'guardrails.price_band_usd')).toEqual({ min: 300, max: 950 });
    expect(getPath(cfg, 'guardrails.disagreement_pause')).toBeUndefined();
  });

  it('switches dry run on and the offers stop being live', async () => {
    const m = await openConfig();
    const g = screen.getByRole('region', { name: 'Guardrails' });
    expect(text(g)).toContain('Dry run is off. The daemon is live: offers are published and swaps are executed.');
    expect((await m.client.call('offers')).offers.some((o) => o.live)).toBe(true);
    await m.user.click(within(g).getByRole('switch', { name: 'Dry run' }));
    expect(text(g)).toContain('Dry run is on. The engine computes and shows the offers it would post, but sends no transaction and moves no XMR.');
    await save(m.user);
    await waitFor(async () => expect((await m.client.call('offers')).offers.some((o) => o.live)).toBe(false));
    const offers = (await m.client.call('offers')).offers;
    expect(offers.filter((o) => o.enabled)).toHaveLength(4);
    expect(offers.find((o) => o.enabled)?.disabled_reason).toBe('Dry run: computed but not published');
  });

  it('edits liquidity: ladder, reserve, allocation, caps and exposure limits', async () => {
    const m = await openConfig();
    const liq = screen.getByRole('region', { name: 'Liquidity' });
    const ladder = within(liq).getByRole('group', { name: 'Output ladder' });
    expect((within(ladder).getByLabelText('Output ladder: size, row 2') as HTMLInputElement).value).toBe('50');
    await m.user.click(within(ladder).getByRole('button', { name: 'Add a row to Output ladder' }));
    await setValue(m.user, within(ladder).getByLabelText('Output ladder: size, row 3'), '100');
    await setValue(m.user, within(ladder).getByLabelText('Output ladder: count, row 3'), '2');
    await m.user.selectOptions(within(liq).getByLabelText('XMR allocation'), 'per_market');
    await setValue(m.user, within(liq).getByLabelText('Allocation for USDC-SOL'), '250');
    await setValue(m.user, within(liq).getByLabelText('Paying-balance caps: usdc_sol'), '60000');
    await setValue(m.user, within(liq).getByLabelText('Target inventory: xmr'), '400');
    await setValue(m.user, within(liq).getByLabelText('Largest amount per taker'), '100');
    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'liquidity.max_per_taker_xmr')).toBe(100));
    const cfg = await saved(m);
    expect(getPath(cfg, 'liquidity.output_ladder')).toEqual([
      { size_xmr: 5, count: 20 },
      { size_xmr: 50, count: 6 },
      { size_xmr: 100, count: 2 },
    ]);
    expect(getPath(cfg, 'liquidity.allocation')).toEqual({ usdc_sol: 250, sol: 0, usdc_eth: 0, eth: 0 });
    expect(getPath(cfg, 'liquidity.paying_caps')).toEqual({ usdc_sol: 60000 });
    expect(getPath(cfg, 'liquidity.targets')).toEqual({ xmr: 400 });
  });

  it('edits rebalancing: mode, levels, venues, in-transit cap and the allow-list', async () => {
    const m = await openConfig();
    const r = screen.getByRole('region', { name: 'Rebalancing' });
    const mode = within(r).getAllByLabelText('Mode')[0] as HTMLSelectElement;
    expect(mode.value).toBe('approve');
    expect([...mode.options].map((o) => o.textContent)).toEqual(['Automatic', 'Approve each refill', 'Alert only']);
    await m.user.selectOptions(mode, 'alert');
    await setValue(m.user, within(r).getByLabelText('In-transit cap'), '25000');
    await setValue(m.user, within(r).getByLabelText('sol high level'), '500');
    expect((within(r).getByLabelText('xmr low level') as HTMLInputElement).value).toBe('150');

    const xmrList = within(r).getByRole('group', { name: 'XMR addresses' });
    await m.user.type(within(xmrList).getByLabelText('Add to XMR addresses'), '4ExampleOwnInventoryAddress{Enter}');

    // Each venue has its own switch, mode and limits.
    const stealthex = [...r.querySelectorAll('details')].find((d) => text(d.querySelector('summary')).startsWith('StealthEX')) as HTMLElement;
    fireEvent.click(stealthex.querySelector('summary') as HTMLElement);
    await m.user.click(within(stealthex).getByRole('switch', { name: 'Enabled' }));
    await m.user.type(within(stealthex).getByLabelText('API key variable'), 'STEALTHEX_KEY');
    await m.user.selectOptions(within(stealthex).getByLabelText('Mode'), 'alert');
    expect(text(stealthex)).toContain('XMR support is unconfirmed');

    await save(m.user);
    await waitFor(async () => expect(getPath(await saved(m), 'rebalance.mode')).toBe('alert'));
    const cfg = await saved(m);
    expect(getPath(cfg, 'rebalance.max_in_transit_usd')).toBe(25000);
    expect(getPath(cfg, 'rebalance.levels.sol.high')).toBe(500);
    expect(getPath(cfg, 'rebalance.allowlist.xmr')).toEqual(['4ExampleOwnInventoryAddress']);
    expect(getPath(cfg, 'rebalance.venues.stealthex')).toEqual({ enabled: true, api_key_env: 'STEALTHEX_KEY', mode: 'alert' });
    const state = await m.client.call('rebalance');
    expect(state.mode).toBe('alert');
    expect(state.venues.find((v) => v.id === 'stealthex')).toMatchObject({ enabled: true, mode: 'alert' });
  });

  it('keeps secrets out of the file', async () => {
    const m = await openConfig();
    const d = screen.getByRole('region', { name: 'Daemon and connections' });
    expect(text(d)).toContain('Secrets never go in this file');
    const rpc = within(d).getAllByLabelText('RPC URL variable')[0] as HTMLInputElement;
    await m.user.type(rpc, 'https://rpc.example/key');
    expect(text(rpc.closest('.field'))).toContain('must be the name of an environment variable, not the value itself');
    await setValue(m.user, rpc, 'SOLANA_RPC_URL');
    expect(text(rpc.closest('.field'))).not.toContain('Error:');
  });
});

describe('configuration: import and export', () => {
  const file = (): HTMLElement => screen.getByRole('region', { name: 'Import and export' });

  it.each([
    ['the configuration example', DESIGN_CONFIG_TOML, '3 offers would run.'],
    ['the rebalancing example', DESIGN_REBALANCE_TOML, '0 offers would run.'],
    ['both examples as one file', DESIGN_BOTH_TOML, '3 offers would run.'],
  ])('imports %s of DESIGN unchanged', async (_, toml, summary) => {
    const m = await openConfig();
    const box = within(file()).getByLabelText('Configuration file to import');
    fireEvent.change(box, { target: { value: toml } });
    const check = within(file()).getByTestId('import-check');
    expect(text(check)).toContain('This file passes the check.');
    expect(text(check)).toContain(summary);
    await m.user.click(within(file()).getByRole('button', { name: 'Import and apply' }));
    expect(text(within(file()).getByRole('alertdialog'))).toContain('Replace the whole configuration with this file and apply it now, without a restart.');
    await m.user.click(within(within(file()).getByRole('alertdialog')).getByRole('button', { name: 'Import and apply' }));
    await waitFor(async () => expect((await m.client.call('configGet')).toml).toBe(toml));
    expect((await m.client.call('configLog')).entries[0]?.source).toBe('import');
    // The form now shows the imported file.
    await waitFor(() => expect(text(screen.getByRole('table', { name: 'Configuration change log' }))).toContain('Import'));
    if (toml !== DESIGN_REBALANCE_TOML) {
      await waitFor(() => expect((screen.getByRole('switch', { name: 'USDC-SOL Buy XMR enabled' }) as HTMLInputElement).checked).toBe(false));
      expect((screen.getByRole('switch', { name: 'SOL Sell XMR enabled' }) as HTMLInputElement).checked).toBe(true);
    }
  });

  it('imports DESIGN’s example with the pool as the SOL market’s primary source and no demotion message', async () => {
    const m = await openConfig();
    fireEvent.change(within(file()).getByLabelText('Configuration file to import'), { target: { value: DESIGN_CONFIG_TOML } });
    const check = text(within(file()).getByTestId('import-check'));
    expect(check).toContain('This file passes the check. 3 offers would run.');
    expect(check).not.toMatch(/cross-check only|may only be a cross-check|promoted|demot/i);
    expect(check).toContain('markets.sol.sell_xmr.source: sol sell_xmr: this market is priced from the wXMR pool.');
    await m.user.click(within(file()).getByRole('button', { name: 'Import and apply' }));
    await m.user.click(within(within(file()).getByRole('alertdialog')).getByRole('button', { name: 'Import and apply' }));
    await waitFor(async () => expect((await m.client.call('configGet')).toml).toBe(DESIGN_CONFIG_TOML));
    const v = (await m.client.call('configGet')).validation;
    expect(v.effective.map((e) => `${e.market}.${e.direction}`)).toEqual(['usdc_sol.sell_xmr', 'sol.sell_xmr', 'usdc_eth.sell_xmr']);
    // In the form: the pool, first, exactly as the file says.
    const sol = await editOffer(m.user, 'SOL Sell XMR');
    await waitFor(() => expect((within(sol).getByLabelText('Primary price source') as HTMLSelectElement).value).toBe('wxmr_pool'));
    expect(text(sol)).toContain('Price source: wxmr_pool, then coingecko, cross-checked against coinmarketcap.');
    expect(text(screen.getByRole('main'))).not.toMatch(/cross-check only|may only be a cross-check|promoted to primary/i);
  });

  it('refuses a file that is not TOML or does not validate', async () => {
    const m = await openConfig();
    const box = within(file()).getByLabelText('Configuration file to import');
    fireEvent.change(box, { target: { value: '[pricing]\nrefresh_seconds = = 15' } });
    expect(text(within(file()).getByRole('alert'))).toContain('This is not valid TOML. Line 2');
    expect((within(file()).getByRole('button', { name: 'Import and apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '[markets.usdc_sol.sell_xmr]\nenabled = true\ndeposit_pct = 8\n' } });
    expect(text(within(file()).getByTestId('import-check'))).toContain('This file has 1 error and cannot be imported.');
    expect((within(file()).getByRole('button', { name: 'Import and apply' }) as HTMLButtonElement).disabled).toBe(true);
    expect((await m.client.call('configGet')).toml).toBe(DEFAULT_TOML);
  });

  it('reads a chosen file', async () => {
    const m = await openConfig();
    const input = file().querySelector('input[type="file"]') as HTMLInputElement;
    await m.user.upload(input, new File([DESIGN_REBALANCE_TOML], 'rebalance.toml', { type: 'text/plain' }));
    await waitFor(() => expect((within(file()).getByLabelText('Configuration file to import') as HTMLTextAreaElement).value).toBe(DESIGN_REBALANCE_TOML));
    expect(text(file())).toContain('rebalance.toml');
  });

  it('can load a file into the form for review without saving it', async () => {
    const m = await openConfig();
    fireEvent.change(within(file()).getByLabelText('Configuration file to import'), { target: { value: DESIGN_BOTH_TOML } });
    await m.user.click(within(file()).getByRole('button', { name: 'Load into the form without saving' }));
    expect((screen.getByRole('switch', { name: 'USDC-SOL Buy XMR enabled' }) as HTMLInputElement).checked).toBe(false);
    expect(text(within(saveBar()).getByTestId('change-count'))).toMatch(/^\d+ unsaved changes$/);
    expect((await m.client.call('configGet')).toml).toBe(DEFAULT_TOML);
  });

  it('exports the whole configuration as one file', async () => {
    const m = await openConfig();
    const created: Blob[] = [];
    const urlApi = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    urlApi.createObjectURL = (b: Blob) => (created.push(b), 'blob:mock');
    urlApi.revokeObjectURL = () => undefined;
    try {
      await m.user.click(within(file()).getByRole('button', { name: 'Export the configuration' }));
      const out = (await within(file()).findByLabelText('Exported file')) as HTMLTextAreaElement;
      expect(out.value).toBe(DEFAULT_TOML);
      expect(created).toHaveLength(1);
      expect(await (created[0] as Blob).text()).toBe(DEFAULT_TOML);
      // What comes out goes back in unchanged.
      const res = await m.client.call('configImport', { body: { toml: out.value } });
      expect(res.toml).toBe(DEFAULT_TOML);
    } finally {
      delete urlApi.createObjectURL;
      delete urlApi.revokeObjectURL;
    }
  });
});
