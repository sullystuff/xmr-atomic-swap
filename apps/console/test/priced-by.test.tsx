/** Which source is pricing each offer right now (the daemon's A17), and the wait for a pool's averaging window. */
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/api/client.js';
import { getPath, parseToml } from '../src/lib/config/toml.js';
import { MOCK_TOKEN, MockDaemon } from '../src/mock/daemon.js';
import { DEFAULT_TOML } from '../src/mock/fixtures.js';
import { mockFetch } from '../src/mock/transport.js';
import { noPriceText } from '../src/pages/market.js';
import { mount, text } from './harness.js';

const READY = DEFAULT_TOML.replace('token = "<wXMR token address>"\npool = "<pool address>"', 'token = "WXMRexampleToken"\npool = "PoolExample"\nbase_vault = "BaseVaultExample"\nquote_vault = "QuoteVaultExample"');
const rowOf = (table: HTMLElement, head: string): HTMLElement => within(table).getAllByRole('row').find((r) => text(r).startsWith(head)) as HTMLElement;

describe('offer views: source fields', () => {
  it('carry the file’s choice and the source in use, including a fallback and no price', async () => {
    const daemon = new MockDaemon({ toml: READY });
    const client = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon) });
    const sol = async () => (await client.call('offers')).offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr');
    expect(await sol()).toMatchObject({ source: 'wxmr_pool', fallbacks: ['coingecko'], cross_check: 'coinmarketcap', priced_by: 'wxmr_pool', price_unit: 'usd', enabled: true });
    // The pool's time-weighted price is not there until its window has filled: the fallback prices meanwhile.
    daemon.poolWindow('wxmr_pool', { have: 120, of: 300 });
    expect(await sol()).toMatchObject({ source: 'wxmr_pool', priced_by: 'coingecko', enabled: true });
    daemon.poolWindow('wxmr_pool', null);
    expect((await sol())?.priced_by).toBe('wxmr_pool');
  });
  it('report no price, with the reason, when the only source is a pool whose window is still filling', async () => {
    const only = '[pricing.sources.wxmr_pool]\ntoken = "T"\npool = "P"\nbase_vault = "B"\nquote_vault = "Q"\n[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n[daemon]\nmode = "live"\n[markets.usdc_sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\n';
    const daemon = new MockDaemon({ toml: only });
    const client = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon) });
    daemon.poolWindow('wxmr_pool', { have: 40, of: 300 });
    const o = (await client.call('offers')).offers.find((x) => x.market === 'usdc_sol' && x.direction === 'sell_xmr');
    expect(o).toMatchObject({ enabled: false, live: false, priced_by: null, source: 'wxmr_pool', fallbacks: [], cross_check: null, price_tiers: [], disabled_reason: 'wxmr_pool: the averaging window is not filled yet (40 of 300 s)' });
  });
  it('puts the wait in plain words', () => {
    expect(noPriceText('wxmr_pool: the averaging window is not filled yet (40 of 300 s)')).toBe('No price yet: the pool’s averaging window is still filling (40 of 300 s). Quoting starts when it is full.');
    expect(noPriceText('no price source can be read')).toBe('No price right now: no price source can be read.');
    expect(noPriceText(undefined)).toBe('No price right now.');
  });
});

describe('Offers page: priced by, now', () => {
  it('shows the source pricing each offer, and flags a fallback in use', async () => {
    // In the mock's own file the pool's addresses are placeholders, so the SOL market runs on its fallback.
    mount('#/offers');
    const table = await screen.findByRole('table', { name: 'Offers' });
    expect(text(rowOf(table, 'SOLSell XMR'))).toContain('CoinGecko Fallback in useprimary wXMR pool is unavailable · checked against CoinMarketCap');
    expect(text(rowOf(table, 'USDC-SOLSell XMR'))).toContain('CoinGecko then CoinMarketCap · checked against CoinMarketCap');
    expect(text(rowOf(table, 'USDC-ETHSell XMR'))).toContain('CoinGecko no fallback · checked against CoinMarketCap');
    expect(text(rowOf(table, 'ETHSell XMR'))).toContain('not offered');
  });

  it('shows the pool as the pricing source when it is the primary and readable', async () => {
    mount('#/offers', { toml: READY });
    const table = await screen.findByRole('table', { name: 'Offers' });
    const row = text(rowOf(table, 'SOLSell XMR'));
    expect(row).toContain('wXMR pool then CoinGecko · checked against CoinMarketCap');
    expect(row).not.toContain('Fallback in use');
  });

  it('makes "no price yet" a visible state while the pool’s averaging window fills, then shows the price', async () => {
    const only = '[pricing.sources.wxmr_pool]\ntoken = "T"\npool = "P"\nbase_vault = "B"\nquote_vault = "Q"\n[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n[daemon]\nmode = "live"\n[markets.usdc_sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\n';
    const m = mount('#/offers', { toml: only, prepare: (d) => d.poolWindow('wxmr_pool', { have: 40, of: 300 }) });
    const table = await screen.findByRole('table', { name: 'Offers' });
    const row = (): HTMLElement => rowOf(table, 'USDC-SOLSell XMR');
    expect(text(within(row()).getByTestId('no-price'))).toBe('No priceNo price yet: the pool’s averaging window is still filling (40 of 300 s). Quoting starts when it is full.');
    expect(text(row())).toContain('Waiting for a price');
    // The window fills: the daemon pushes, and the offer shows its source and price.
    act(() => m.daemon.poolWindow('wxmr_pool', null));
    await waitFor(() => expect(within(row()).queryByTestId('no-price')).toBeNull());
    expect(text(row())).toContain('Live');
    expect(text(row())).toContain('wXMR pool no fallback · no cross-check');
    expect(text(row())).toContain('420.597 USDC');
  });
});

describe('Dashboard: pricing now', () => {
  it('lists the enabled offers with the source in use, marking a fallback and a missing price', async () => {
    const m = mount('', { toml: READY });
    const card = await screen.findByRole('region', { name: 'Pricing now' });
    const table = await within(card).findByRole('table', { name: 'Pricing now' });
    expect(within(table).getAllByRole('row').slice(1).map((r) => text(within(r).getByRole('rowheader')))).toEqual(['USDC-SOL · Sell XMR', 'USDC-SOL · Buy XMR', 'SOL · Sell XMR', 'USDC-ETH · Sell XMR']);
    expect(text(rowOf(table, 'SOL · Sell XMR'))).toContain('wXMR pool');
    act(() => m.daemon.poolWindow('wxmr_pool', { have: 10, of: 300 }));
    await waitFor(() => expect(text(rowOf(table, 'SOL · Sell XMR'))).toContain('CoinGecko Fallback in useprimary wXMR pool is unavailable'));
    expect(within(card).getByRole('link', { name: 'All offers' }).getAttribute('href')).toBe('#/offers');
  });
  it('shows an offer that is waiting for a price rather than dropping it', async () => {
    const only = '[pricing.sources.wxmr_pool]\ntoken = "T"\npool = "P"\nbase_vault = "B"\nquote_vault = "Q"\n[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n[daemon]\nmode = "live"\n[markets.usdc_sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\n';
    mount('', { toml: only, empty: true, prepare: (d) => d.poolWindow('wxmr_pool', { have: 40, of: 300 }) });
    const table = await within(await screen.findByRole('region', { name: 'Pricing now' })).findByRole('table', { name: 'Pricing now' });
    expect(text(within(table).getByTestId('no-price'))).toContain('the pool’s averaging window is still filling (40 of 300 s)');
  });
});

describe('both pools are editable', () => {
  it('has token, pool and reserve addresses, quote, minimum liquidity and averaging window for each', async () => {
    const m = mount('#/config', { toml: READY });
    const pricing = await screen.findByRole('region', { name: 'Price sources' });
    for (const label of ['Token address', 'Pool address', 'wXMR reserve account', 'Quote reserve account', 'Quote asset', 'Minimum pool liquidity', 'Averaging window']) expect(within(pricing).getAllByLabelText(label), label).toHaveLength(2);
    expect(text(pricing)).toContain('Second wXMR pool on Solana (SOL-quoted by default)');
    // The first pool is USDC-quoted by default, the second SOL-quoted.
    expect((within(pricing).getAllByLabelText('Quote asset') as HTMLSelectElement[]).map((s) => s.value)).toEqual(['usdc', 'sol']);
    expect(text(pricing)).toContain('there is no price until the window has filled. 0 = the last read, with no averaging: one pushed read then sets your price.');
    // Fill in the second pool and save: its section appears in the file.
    const second = { token: 'T2', pool: 'P2', base: 'B2', quote: 'Q2' };
    await m.user.type(within(pricing).getAllByLabelText('Token address')[1] as HTMLElement, second.token);
    await m.user.type(within(pricing).getAllByLabelText('Pool address')[1] as HTMLElement, second.pool);
    await m.user.type(within(pricing).getAllByLabelText('wXMR reserve account')[1] as HTMLElement, second.base);
    await m.user.type(within(pricing).getAllByLabelText('Quote reserve account')[1] as HTMLElement, second.quote);
    await m.user.click(within(screen.getByRole('region', { name: 'Save configuration' })).getByRole('button', { name: 'Validate and save' }));
    await waitFor(async () => expect(getPath(parseToml((await m.client.call('configGet')).toml), 'pricing.sources.wxmr_pool_sol')).toEqual({ token: 'T2', pool: 'P2', base_vault: 'B2', quote_vault: 'Q2' }));
    // With it configured, the preset prices the SOL market from it and the USDC markets from the first pool.
    await m.user.click(await screen.findByRole('button', { name: 'Quote from the wXMR pool and refill through the wXMR bridge only' }));
    const summary = text(screen.getByTestId('preset-summary'));
    expect(summary).toContain('USDC-SOL Sell XMR (XMR/USD from wxmr_pool)');
    expect(summary).toContain('SOL Sell XMR (XMR/SOL from wxmr_pool_sol)');
    expect(summary).not.toContain('Leaves');
  });
});
