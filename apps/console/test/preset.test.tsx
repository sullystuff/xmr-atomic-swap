/** The guided "wXMR only" choice: quote from the wXMR pool and refill through the wXMR bridge only. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WXMR_ONLY_LABEL, wxmrOnlyPlan } from '../src/lib/config/preset.js';
import { diffConfig, getPath, parseToml } from '../src/lib/config/toml.js';
import { DEFAULT_TOML } from '../src/mock/fixtures.js';
import { mount, text } from './harness.js';

// The mock's file with the pool's addresses filled in, so the pool can be read.
const READY = DEFAULT_TOML.replace('token = "<wXMR token address>"\npool = "<pool address>"', 'token = "WXMRexampleToken"\npool = "PoolExample"\nbase_vault = "BaseVaultExample"\nquote_vault = "QuoteVaultExample"');
const preset = (): HTMLElement => screen.getByRole('region', { name: 'Presets' });
const saveBar = (): HTMLElement => screen.getByRole('region', { name: 'Save configuration' });

describe('wXMR-only preset: the plan', () => {
  it('prices what the pool can price, leaves the rest, and enables only the bridge', () => {
    const cfg = parseToml(READY);
    const plan = wxmrOnlyPlan(cfg);
    // A USDC-quoted pool gives XMR/USD: both enabled USDC-SOL offers and the USDC-ETH one. SOL needs SOL/USD.
    expect(plan.priced.map((p) => `${p.market}.${p.direction}:${p.pool}`)).toEqual(['usdc_sol.sell_xmr:wxmr_pool', 'usdc_sol.buy_xmr:wxmr_pool', 'usdc_eth.sell_xmr:wxmr_pool']);
    expect(plan.untouched.map((u) => [`${u.market}.${u.direction}`, u.missing.lacks])).toEqual([['sol.sell_xmr', 'SOL/USD']]);
    expect(plan.venuesSwitchedOff).toEqual(['exchange', 'changenow', 'fixedfloat']);
    expect(diffConfig(cfg, plan.next)).toEqual([
      { path: 'markets.usdc_eth.sell_xmr.cross_check', old: null, new: '"none"' },
      { path: 'markets.usdc_eth.sell_xmr.source', old: '"coingecko"', new: '"wxmr_pool"' },
      { path: 'markets.usdc_sol.buy_xmr.cross_check', old: null, new: '"none"' },
      { path: 'markets.usdc_sol.buy_xmr.fallbacks', old: '["coinmarketcap"]', new: null },
      { path: 'markets.usdc_sol.buy_xmr.source', old: '"coingecko"', new: '"wxmr_pool"' },
      { path: 'markets.usdc_sol.sell_xmr.cross_check', old: null, new: '"none"' },
      { path: 'markets.usdc_sol.sell_xmr.fallbacks', old: '["coinmarketcap"]', new: null },
      { path: 'markets.usdc_sol.sell_xmr.source', old: '"coingecko"', new: '"wxmr_pool"' },
      { path: 'rebalance.routing.priority', old: '["wxmr_bridge", "exchange", "changenow", "fixedfloat", "stealthex", "houdiniswap"]', new: '["wxmr_bridge"]' },
      { path: 'rebalance.venues.changenow.enabled', old: 'true', new: 'false' },
      { path: 'rebalance.venues.exchange.enabled', old: 'true', new: 'false' },
      { path: 'rebalance.venues.fixedfloat.enabled', old: 'true', new: 'false' },
    ]);
    // The cross-check for all markets, and the SOL market, are untouched.
    expect(getPath(plan.next, 'pricing.cross_check')).toBe('coinmarketcap');
    expect(getPath(plan.next, 'markets.sol.sell_xmr')).toEqual(getPath(cfg, 'markets.sol.sell_xmr'));
    // Applying it twice changes nothing more.
    expect(diffConfig(plan.next, wxmrOnlyPlan(plan.next).next)).toEqual([]);
  });

  it('prices the SOL market from a SOL-quoted pool, and nothing on Ethereum’s ETH market', () => {
    const cfg = parseToml(`${READY}\n[pricing.sources.wxmr_pool_sol]\ntoken = "T"\npool = "P2"\nbase_vault = "B2"\nquote_vault = "Q2"\n\n[markets.eth.sell_xmr]\nenabled = true\n`.replace('[markets.eth.sell_xmr]\nenabled = false\n\n', ''));
    const plan = wxmrOnlyPlan(cfg);
    expect(plan.priced.map((p) => `${p.market}:${p.pool}:${p.quote}`)).toContain('sol:wxmr_pool_sol:sol');
    expect(plan.untouched.map((u) => [u.market, u.missing.lacks])).toEqual([['eth', 'ETH/USD']]);
    expect(getPath(plan.next, 'markets.eth.sell_xmr.source')).toBeUndefined();
  });

  it('writes no cross-check key when none is set anyway, and switches cross-chain moves off', () => {
    const cfg = parseToml(`${READY.replace('cross_check = "coinmarketcap"\n', '')}\n[rebalance.cross_chain]\nenabled = true\nvenue = "changenow"\n`);
    const plan = wxmrOnlyPlan(cfg);
    expect(getPath(plan.next, 'markets.usdc_sol.sell_xmr.cross_check')).toBeUndefined();
    expect(plan.crossChainSwitchedOff).toBe(true);
    expect(getPath(plan.next, 'rebalance.cross_chain.enabled')).toBe(false);
  });
});

describe('wXMR-only preset: on the Configuration page', () => {
  it('shows the diff and the risks first, changes only the form, and saves only when the maker saves', async () => {
    const m = mount('#/config', { toml: READY });
    await screen.findByRole('region', { name: 'Markets and offers' });
    await m.user.click(within(preset()).getByRole('button', { name: WXMR_ONLY_LABEL }));
    const review = within(preset()).getByRole('region', { name: 'Preset review' });

    expect(text(within(review).getByTestId('preset-summary'))).toContain(
      'Prices USDC-SOL Sell XMR (XMR/USD from wxmr_pool), USDC-SOL Buy XMR (XMR/USD from wxmr_pool), USDC-ETH Sell XMR (XMR/USD from wxmr_pool) from the pool alone: no fallback, and no cross-check for these markets.',
    );
    expect(text(within(review).getByTestId('preset-summary'))).toContain('Leaves SOL Sell XMR (needs SOL/USD from another source) on the sources they have.');
    expect(text(within(review).getByTestId('preset-summary'))).toContain('Refills through the wXMR bridge only: switches off Exchange, ChangeNOW, FixedFloat, and makes the bridge the whole routing priority.');

    // The risk warnings, before anything changes.
    const warnings = within(review).getByRole('list', { name: 'Preset warnings' });
    const all = text(warnings);
    expect(all).toContain('usdc_sol sell_xmr: this market is priced from the wXMR pool. A thin pool can be pushed off-market cheaply by someone who then takes your quote.');
    expect(all).toContain('usdc_sol sell_xmr: no cross-check, so nothing checks this price against a second source.');
    expect(all).toContain('usdc_sol sell_xmr: no fallback, so quoting pauses whenever the wXMR pool is unavailable.');
    expect(within(warnings).getAllByRole('listitem')).toHaveLength(9);

    // The diff.
    const rows = within(within(review).getByRole('table', { name: 'Preset changes' })).getAllByRole('row').slice(1).map(text);
    expect(rows).toHaveLength(12);
    expect(rows).toContain('markets.usdc_sol.sell_xmr.source"coingecko""wxmr_pool"');
    expect(rows).toContain('markets.usdc_sol.sell_xmr.fallbacks["coinmarketcap"]unset');
    expect(rows).toContain('markets.usdc_sol.sell_xmr.cross_checkunset"none"');
    expect(rows).toContain('rebalance.routing.priority["wxmr_bridge", "exchange", "changenow", "fixedfloat", "stealthex", "houdiniswap"]["wxmr_bridge"]');
    expect(rows).toContain('rebalance.venues.exchange.enabledtruefalse');

    // Looking changes nothing: not the form, not the daemon.
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('No unsaved changes');
    await m.user.click(within(review).getByRole('button', { name: 'Cancel' }));
    expect(within(preset()).queryByRole('region', { name: 'Preset review' })).toBeNull();
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('No unsaved changes');

    // Putting it in the form still saves nothing.
    await m.user.click(within(preset()).getByRole('button', { name: WXMR_ONLY_LABEL }));
    await m.user.click(within(within(preset()).getByRole('region', { name: 'Preset review' })).getByRole('button', { name: 'Put these changes in the form' }));
    expect(text(preset())).toContain('In the form now, not saved.');
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('12 unsaved changes');
    expect((await m.client.call('configGet')).toml).toBe(READY);
    expect((await m.client.call('configLog')).entries).toHaveLength(1);
    // The form shows it, with the warnings beside the fields and no error.
    await m.user.click(screen.getByRole('button', { name: 'Edit USDC-SOL Sell XMR settings' }));
    const editor = screen.getByRole('region', { name: 'USDC-SOL Sell XMR settings' });
    expect((within(editor).getByLabelText('Primary price source') as HTMLSelectElement).value).toBe('wxmr_pool');
    expect(text(editor)).toContain('Price source: wxmr_pool, no fallback, no cross-check.');
    await waitFor(() => expect(text(saveBar())).not.toContain('checking with the daemon'));
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');

    // Only the save bar saves.
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Validate and save' }));
    await waitFor(async () => expect((await m.client.call('configLog')).entries).toHaveLength(2));
    const file = (await m.client.call('configGet')).toml;
    expect(file).toContain('[markets.usdc_sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\ndeviation_pct = 1.5\n');
    expect(file).toContain('withhold_policy = "price_moved"\ncross_check = "none"\n');
    expect(file).toContain('[markets.sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\nfallbacks = ["coingecko"]\n');
    expect(file).toContain('priority = [ "wxmr_bridge" ]\n');
    expect(file).toContain('[rebalance.venues.wxmr_bridge]\nenabled = true\n');
    expect(file).toContain('[rebalance.venues.exchange]\nenabled = false\n');
    expect(file).toContain('[rebalance.venues.changenow]\nenabled = false\n');
    expect(file).toContain('[rebalance.venues.fixedfloat]\nenabled = false\n');
    // Everything else is as it was: the cross-check for the other markets, liquidity, guardrails.
    expect(file).toContain('cross_check = "coinmarketcap"\nmax_disagreement_pct = 1.0\n');
    expect(file).toContain('[liquidity]\nxmr_reserve = 50\n');
    const cfg = parseToml(file);
    expect(diffConfig(wxmrOnlyPlan(parseToml(READY)).next, cfg)).toEqual([]);
    // The daemon runs it: the pool-priced offers are on, and only the bridge is a venue.
    const offers = (await m.client.call('offers')).offers;
    expect(offers.filter((o) => o.enabled).map((o) => `${o.market}.${o.direction}`).sort()).toEqual(['sol.sell_xmr', 'usdc_eth.sell_xmr', 'usdc_sol.buy_xmr', 'usdc_sol.sell_xmr']);
    expect((await m.client.call('rebalance')).venues.filter((v) => v.enabled).map((v) => v.id)).toEqual(['wxmr_bridge']);
  });

  it('can be taken back with Discard changes', async () => {
    const m = mount('#/config', { toml: READY });
    await screen.findByRole('region', { name: 'Markets and offers' });
    await m.user.click(within(preset()).getByRole('button', { name: WXMR_ONLY_LABEL }));
    await m.user.click(within(preset()).getByRole('button', { name: 'Put these changes in the form' }));
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Discard changes' }));
    expect(text(within(saveBar()).getByTestId('change-count'))).toBe('No unsaved changes');
    expect((await m.client.call('configGet')).toml).toBe(READY);
  });

  it('says so when the pool is not readable yet, and when there is nothing left to change', async () => {
    const m = mount('#/config');
    await screen.findByRole('region', { name: 'Markets and offers' });
    await m.user.click(within(preset()).getByRole('button', { name: WXMR_ONLY_LABEL }));
    expect(text(within(preset()).getByRole('list', { name: 'Preset warnings' }))).toContain('the wXMR pool cannot be read yet: its addresses are placeholders or missing');
    await m.user.click(within(preset()).getByRole('button', { name: 'Put these changes in the form' }));
    await m.user.click(within(preset()).getByRole('button', { name: WXMR_ONLY_LABEL }));
    const review = within(preset()).getByRole('region', { name: 'Preset review' });
    expect(text(review)).toContain('Your configuration already matches this setup.');
    expect((within(review).getByRole('button', { name: 'Put these changes in the form' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a bridge-only setup on the Rebalancing page', () => {
  it('is presented as complete, not as missing venues', async () => {
    const plan = wxmrOnlyPlan(parseToml(READY));
    const { stringifyToml } = await import('../src/lib/config/toml.js');
    mount('#/rebalancing', { toml: stringifyToml(plan.next), empty: true });
    const venues = await screen.findByRole('region', { name: 'Venues' });
    expect(text(venues)).toContain('Only the wXMR bridge is enabled. That is a complete setup: every refill goes through the bridge, and waits when the bridge is offline or too costly.');
    const rows = within(within(venues).getByRole('table', { name: 'Venues' })).getAllByRole('row').slice(1).map(text);
    expect(rows[0]).toBe('wXMR bridgeEnabledApprove each refillHealthy');
    expect(rows.slice(1, 6).every((r) => r.endsWith('Offn/an/a'))).toBe(true);
    expect(text(screen.getByRole('main'))).not.toMatch(/enable (another|more) venue|other venues are required|needs? (another|a second) venue/i);
  });
  it('says one venue is enough in the ordinary case too', async () => {
    mount('#/rebalancing');
    expect(text(await screen.findByRole('region', { name: 'Venues' }))).toContain('One venue is enough; several let a refill fall through to the next.');
  });
});
