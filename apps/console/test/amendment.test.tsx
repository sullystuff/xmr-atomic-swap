/** Amendment 1 (SPEC 11): beta caps, freeze windows, frozen swaps, watchers, payout addresses, the release record. */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketCaps, SwapDetail } from '@xmrswap/protocol/daemon-api';
import { DaemonClient } from '../src/api/client.js';
import { capacityLimitText, capsState, degradedReasons, freezeCounts, freezeExposure, frozenFinal } from '../src/lib/amendment.js';
import { wxmrOnlyPlan } from '../src/lib/config/preset.js';
import { diffConfig, getPath, parseToml } from '../src/lib/config/toml.js';
import { issuesAt, resolveOffer, unknownKeys, validateConfig } from '../src/lib/config/validate.js';
import { MOCK_TOKEN, MockDaemon } from '../src/mock/daemon.js';
import { DEFAULT_TOML, REF, fakeSol, frozenSwap } from '../src/mock/fixtures.js';
import { mockFetch } from '../src/mock/transport.js';
import { T0, mount, stat, text } from './harness.js';

afterEach(() => vi.useRealTimers());

const ctx = { blobEndpoint: true, solUsd: null };
const usdc = (n: number): string => String(Math.round(n * 1e6));
const caps = (market: MarketCaps['market'], c: Partial<NonNullable<MarketCaps['caps']>> | null): MarketCaps => ({
  market,
  caps: c === null ? null : { on: true, max_swap: '0', max_open: '0', open_value: '0', headroom: '0', frozen: false, ...c },
});
const offer = (body: string, market = 'usdc_sol', dir = 'sell_xmr'): string => `[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n[markets.${market}.${dir}]\nenabled = true\n${body}\n`;
const READY = DEFAULT_TOML.replace('token = "<wXMR token address>"\npool = "<pool address>"', 'token = "T"\npool = "P"\nbase_vault = "B"\nquote_vault = "Q"');

describe('worst-case lock-up from a freeze window (SPEC 11.6, "Griefing, quantified")', () => {
  it('matches the specification’s own figures', () => {
    // D_c = 1.5 h, W_z = 24 h: 25.5 h, 17 times longer. At 72 h: 73.5 h, 49 times.
    expect(freezeExposure(5_400, 86_400)).toEqual({ windowSecs: 86_400, withoutSecs: 5_400, worstSecs: 91_800, times: 17 });
    expect(freezeExposure(5_400, 259_200)).toEqual({ windowSecs: 259_200, withoutSecs: 5_400, worstSecs: 264_600, times: 49 });
  });
  it('is the claim delay plus the window, checked by hand', () => {
    // No window: nothing is added.
    expect(freezeExposure(6_060, 0)).toEqual({ windowSecs: 0, withoutSecs: 6_060, worstSecs: 6_060, times: 1 });
    // Solana at depth 25: D_c = 101 min. With the shortest window, 1 h: 161 min, 161 / 101 = 1.59.
    expect(freezeExposure(101 * 60, 3_600)).toEqual({ windowSecs: 3_600, withoutSecs: 6_060, worstSecs: 9_660, times: 1.6 });
    // Ethereum default: D_c = 180 min, W_z = 48 h: 2,880 + 180 = 3,060 min, 17 times.
    expect(freezeExposure(180 * 60, 48 * 3_600)).toEqual({ windowSecs: 172_800, withoutSecs: 10_800, worstSecs: 183_600, times: 17 });
  });
  it('computes the frozen-final time as the later of the window’s end and the ordinary claim opening', () => {
    // Frozen early with a short window: the claim opens when it would have anyway.
    expect(frozenFinal(1_000, 3_600, 10_000)).toBe(10_000);
    // Frozen just before the claim would open: the full window is added.
    expect(frozenFinal(9_999, 3_600, 10_000)).toBe(13_599);
    expect(frozenFinal(9_000, 86_400, 10_000)).toBe(95_400);
  });
});

describe('caps: the four states and what limits an offer', () => {
  it('reads a fresh deployment as "not open yet", not as an error', () => {
    const s = capsState(caps('usdc_sol', {}));
    expect(s.kind).toBe('not_open');
    expect(s.text).toBe('The protocol is not open yet: its beta caps are still at zero, so no swap can start. This is how a fresh deployment begins; the protocol’s admin opens it by setting caps.');
  });
  it('reads partial use with open value, cap, headroom and the largest swap', () => {
    const s = capsState(caps('usdc_sol', { max_swap: usdc(25_000), max_open: usdc(100_000), open_value: usdc(29_294.9), headroom: usdc(70_705.1) }));
    expect([s.kind, s.headroom]).toEqual(['open', 70_705_100_000n]);
    expect(s.text).toBe('29,294.9 USDC of 100,000 USDC open; 70,705.1 USDC of headroom. Largest single swap: 25,000 USDC.');
  });
  it('reads a reached cap, also when the cap was lowered below what is open', () => {
    const at = capsState(caps('sol', { max_swap: '5000000000', max_open: '100000000000', open_value: '100000000000' }));
    expect(at.kind).toBe('reached');
    expect(at.text).toBe('The protocol’s beta cap is reached: 100 SOL of 100 SOL open. No new swap can start until one settles.');
    const over = capsState(caps('sol', { max_swap: '5000000000', max_open: '50000000000', open_value: '100000000000', headroom: '7' }));
    // The headroom is recomputed, never trusted: max(0, max_open − open_value).
    expect([over.kind, over.headroom]).toEqual(['reached', 0n]);
    expect(over.text).toContain('100 SOL of 50 SOL open');
  });
  it('reads the switch off, an unreadable chain, and caps fixed for good', () => {
    const off = capsState(caps('eth', { on: false, max_swap: '1', max_open: '1', open_value: '2000000000000000000' }));
    expect(off.kind).toBe('off');
    expect(off.text).toBe('The protocol’s beta caps are switched off: no limit is checked. 2 ETH is open.');
    expect(capsState(caps('eth', null)).kind).toBe('unknown');
    expect(capsState(caps('eth', null)).text).toContain('could not be read');
    expect(capsState(caps('usdc_eth', { max_swap: usdc(1), max_open: usdc(10), frozen: true })).text).toContain('these caps stay as they are for good');
  });
  it('never calls the protocol’s cap the maker’s own limit', () => {
    const reached = capsState(caps('usdc_sol', { max_swap: usdc(25_000), max_open: usdc(100_000), open_value: usdc(100_000) }));
    const open = capsState(caps('usdc_sol', { max_swap: usdc(25_000), max_open: usdc(100_000), open_value: usdc(40_000) }));
    expect(capacityLimitText('max_open', reached, 'usdc_sol')).toBe('the protocol’s beta cap is reached: 100,000 USDC of 100,000 USDC open');
    expect(capacityLimitText('max_open', open, 'usdc_sol')).toBe('limited by the protocol’s beta cap: 40,000 USDC of 100,000 USDC open, 60,000 USDC left');
    expect(capacityLimitText('max_swap', open, 'usdc_sol')).toBe('limited by the protocol’s beta cap on one swap: 25,000 USDC');
    expect(capacityLimitText('max_open', capsState(caps('usdc_sol', {})), 'usdc_sol')).toBe('the protocol is not open yet: its beta caps are at zero');
    expect(capacityLimitText('config', open, 'usdc_sol')).toBe('limited by your own settings (daily cap, exposure limits or largest swap)');
    expect(capacityLimitText('inventory', open, 'usdc_sol')).toBe('limited by your unlocked outputs');
    expect(capacityLimitText('config', open, 'usdc_sol')).not.toMatch(/protocol/);
  });
});

describe('freeze window in the configuration', () => {
  const check = (toml: string) => validateConfig(parseToml(toml), ctx);
  it('is 0 or 1 to 72 hours, and becomes the offer’s W_z', () => {
    expect(check(offer('freeze_window_hours = 0')).ok).toBe(true);
    expect(check(offer('deposit_pct = 2\nfreeze_window_hours = 24')).effective[0]?.freeze_window_secs).toBe(86_400);
    expect(check(offer('')).effective[0]?.freeze_window_secs).toBe(0);
    expect(check(offer('freeze_window_hours = 1')).ok).toBe(true);
    expect(check(offer('freeze_window_hours = 72')).ok).toBe(true);
    const low = check(offer('freeze_window_hours = 0.5'));
    expect(low.ok).toBe(false);
    expect(issuesAt(low.errors, 'markets.usdc_sol.sell_xmr.freeze_window_hours').map((e) => e.message)).toEqual(['usdc_sol sell_xmr: the freeze window is 0 (no watcher accepted) or between 1 and 72 hours.']);
    expect(check(offer('freeze_window_hours = 73')).ok).toBe(false);
    expect(check(offer('freeze_window_hours = -1')).ok).toBe(false);
    expect(unknownKeys(parseToml(`${offer('freeze_window_hours = 24')}[watcher]\nurl = "https://w.example"\nsolana_key = "K"\nethereum_key = "0x01"\nretry_seconds = 30\n[approvals]\ndeny_watchers = ["W"]\nrefuse_watchers = true\nmax_taker_freezes = 2\n`))).toEqual([]);
  });
  it('makes room for the window in the final deadline', () => {
    // 60 s + 600 s + 101 min + 72 h + 30 min + 1 day = 4.1 days: 4 days is too short, 5 is enough.
    expect(check(offer('max_xmr = 200\napproval_mode = "window"\nfreeze_window_hours = 72\nfinal_days = 4')).ok).toBe(false);
    expect(check(offer('max_xmr = 200\napproval_mode = "window"\nfreeze_window_hours = 72\nfinal_days = 5')).ok).toBe(true);
    expect(check(offer('max_xmr = 200\napproval_mode = "window"\nfinal_days = 2')).ok).toBe(true);
  });
  it('defaults the withhold policy to "price moved" with a window, and says what a window without a deposit or a watcher means', () => {
    const o = (toml: string, dir: 'sell_xmr' | 'buy_xmr' = 'sell_xmr') => resolveOffer(parseToml(toml), 'usdc_sol', dir, ctx);
    expect(o(offer('freeze_window_hours = 24')).values.withhold_policy).toBe('price_moved');
    expect(o(offer('freeze_window_hours = 24\nwithhold_policy = "never"')).values.withhold_policy).toBe('never');
    expect(o(offer('')).values.withhold_policy).toBe('never');
    expect(issuesAt(check(offer('freeze_window_hours = 24')).warnings, 'markets.usdc_sol.sell_xmr.freeze_window_hours').map((w) => w.message)).toEqual([
      'usdc_sol sell_xmr: with no deposit there is nothing to withhold when a taker walks away after a freeze. The deposit is what prices the longer wait.',
    ]);
    expect(issuesAt(check(offer('freeze_window_hours = 24', 'usdc_sol', 'buy_xmr')).warnings, 'markets.usdc_sol.buy_xmr.freeze_window_hours').map((w) => w.message)).toEqual([
      'usdc_sol buy_xmr: no watcher is configured ([watcher] url), so nothing would freeze a swap for you; takers are still told you can pause the swap for up to 24 hours.',
    ]);
    expect(issuesAt(check(`${offer('freeze_window_hours = 24', 'usdc_sol', 'buy_xmr')}[watcher]\nurl = "https://w.example"\n`).warnings, 'markets.usdc_sol.buy_xmr.freeze_window_hours')).toEqual([]);
  });
  it('is left alone by the wXMR-only preset', () => {
    const cfg = parseToml(READY.replace('[markets.usdc_sol.sell_xmr]\nenabled = true', '[markets.usdc_sol.sell_xmr]\nenabled = true\nfreeze_window_hours = 48'));
    const plan = wxmrOnlyPlan(cfg);
    expect(getPath(plan.next, 'markets.usdc_sol.sell_xmr.freeze_window_hours')).toBe(48);
    expect(diffConfig(cfg, plan.next).filter((c) => /freeze|watcher/.test(c.path))).toEqual([]);
  });
});

describe('helpers', () => {
  it('counts frozen swaps per taker', () => {
    const counts = freezeCounts([
      { taker: 'A', state: 'FROZEN', outcome: null },
      { taker: 'A', state: 'DONE', outcome: 'refunds_after_freeze' },
      { taker: 'A', state: 'DONE', outcome: 'completed' },
      { taker: 'B', state: 'DONE', outcome: 'claims_after_freeze' },
      { taker: 'C', state: 'READY', outcome: null },
    ]);
    expect([...counts]).toEqual([
      ['A', { frozen: 2, swaps: 3 }],
      ['B', { frozen: 1, swaps: 1 }],
      ['C', { frozen: 0, swaps: 1 }],
    ]);
  });
  it('says why the daemon counts as degraded', () => {
    const ok = { chains: [{ chain: 'solana' as const, connected: true }], monero: { nodes: [{ ok: true }], agree: true, wallet_rpc_ok: true }, needs_review: 0 } as unknown as Parameters<typeof degradedReasons>[0];
    expect(degradedReasons(ok)).toEqual([]);
    const bad = { chains: [{ chain: 'ethereum' as const, connected: false }], monero: { nodes: [{ ok: false }], agree: false, wallet_rpc_ok: false }, needs_review: 0 } as unknown as Parameters<typeof degradedReasons>[0];
    expect(degradedReasons(bad)).toEqual(['Ethereum is not connected', 'the Monero nodes disagree', 'a Monero node is down', 'the inventory wallet cannot be reached']);
  });
});

describe('mock daemon: Amendment 1 fields', () => {
  const setup = (opts: ConstructorParameters<typeof MockDaemon>[0] = {}) => {
    const daemon = new MockDaemon({ now: () => T0, ...opts });
    return { daemon, client: new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon) }) };
  };
  it('reports caps, the program build and the watcher in status', async () => {
    const { client, daemon } = setup();
    const s = await client.call('status');
    expect(s.caps.map((c) => c.market)).toEqual(['usdc_sol', 'sol', 'usdc_eth', 'eth']);
    expect(s.caps[0]?.caps).toMatchObject({ on: true, max_open: '1000000000000', open_value: '29294900000', headroom: '970705100000', frozen: false });
    expect(s.program_build).toMatchObject({ expected_hash: null, matches: null });
    expect(s.watcher).toEqual({ url: null, reachable: null, solana: null, ethereum: null, watching: 0 });
    daemon.setCaps('sol', null);
    expect((await client.call('status')).caps[1]).toEqual({ market: 'sol', caps: null });
  });
  it('caps an offer’s capacity by the headroom and by the largest swap, and names which', async () => {
    const { client, daemon } = setup();
    const sell = async () => (await client.call('offers')).offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr');
    expect(await sell()).toMatchObject({ capacity_limit: 'inventory' });
    // 2,092.67625 USDC of headroom at 418.53525 USDC per XMR is 5 XMR.
    daemon.setCaps('usdc_sol', { on: true, max_swap: usdc(25_000), max_open: usdc(100_000), open_value: usdc(97_907.32375) });
    expect(await sell()).toMatchObject({ capacity_limit: 'max_open', capacity_xmr: '5000000000000' });
    daemon.setCaps('usdc_sol', { on: true, max_swap: usdc(4_185.3525), max_open: usdc(1_000_000), open_value: '0' });
    expect(await sell()).toMatchObject({ capacity_limit: 'max_swap', capacity_xmr: '10000000000000' });
    daemon.setCaps('usdc_sol', { on: true, max_swap: '0', max_open: '0', open_value: '0' });
    expect(await sell()).toMatchObject({ capacity_limit: 'max_open', capacity_xmr: '0', enabled: true });
    // With the switch off the caps bound nothing.
    daemon.setCaps('usdc_sol', { on: false, max_swap: '0', max_open: '0', open_value: '0' });
    expect(await sell()).toMatchObject({ capacity_limit: 'inventory' });
  });
  it('carries payout, watcher and freeze data on swaps and approvals', async () => {
    const { client, daemon } = setup({ frozen: true });
    const list = (await client.call('swaps')).swaps;
    const frozen = list.find((s) => s.state === 'FROZEN');
    expect(frozen).toMatchObject({ state: 'FROZEN', extras: { watcher: fakeSol('watcher-of-taker'), freeze_window_secs: 86_400, payout: null } });
    expect(list.find((s) => s.ref === REF.buy)?.extras.payout).toBe(fakeSol('payout-buy'));
    const d = await client.call('swap', { params: { ref: frozen?.ref ?? '' } });
    expect(d.deadlines.t_freeze).toBe(T0 - 20 * 60);
    expect(d.deadlines.t_ff).toBe(T0 - 20 * 60 + 86_400);
    expect(d.actions).toEqual(['abort']);
    daemon.nameWatcher(REF.pendingSol, 'WatcherKey');
    expect((await client.call('approvals')).pending.find((p) => p.ref === REF.pendingSol)).toMatchObject({ watcher: 'WatcherKey', watcher_denied: false, payout: null });
    await client.call('configImport', { body: { toml: `${DEFAULT_TOML}\n[approvals]\ndeny_watchers = ["WatcherKey"]\n` } });
    expect((await client.call('approvals')).pending.find((p) => p.ref === REF.pendingSol)?.watcher_denied).toBe(true);
  });
  it('serves /release.json without a token when the bundle has one', async () => {
    const record = { format: 'xmrswap-served/1', ui: { tree_hash: 'ab'.repeat(32), files: 6, bytes: 100 }, recorded: true, release: null };
    const { client, daemon } = setup({ release: record });
    expect(daemon.handle({ method: 'GET', path: '/release.json' })).toEqual({ status: 200, body: record });
    expect(await client.releaseRecord()).toEqual(record);
    expect(await setup().client.releaseRecord()).toBeNull();
    expect(await setup({ release: { hello: 'world' } }).client.releaseRecord()).toBeNull();
  });
});

describe('caps on the Dashboard and Offers pages', () => {
  const row = (panel: HTMLElement, head: string): HTMLElement => within(panel).getAllByRole('row').find((r) => text(r).startsWith(head)) as HTMLElement;

  it('shows per asset the largest swap, what is open, the cap and the headroom, with no control to change them', async () => {
    mount();
    const card = await screen.findByRole('region', { name: 'Protocol beta caps' });
    const table = await within(card).findByRole('table', { name: 'Protocol beta caps' });
    expect(text(row(table, 'USDC-SOL'))).toBe('USDC-SOLSolanaOpen 29,294.9 USDC of 1,000,000 USDC open; 970,705.1 USDC of headroom. Largest single swap: 250,000 USDC.250,000 USDC29,294.9 USDC1,000,000 USDC970,705.1 USDC');
    expect(row(table, 'USDC-SOL').getAttribute('data-caps')).toBe('open');
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(text(card)).toContain('Beta limits set on-chain by the protocol’s admin, not by you; they cannot be changed from here.');
    // Nothing to operate: the maker cannot change caps.
    expect(within(card).queryAllByRole('button')).toEqual([]);
    expect(within(card).queryAllByRole('textbox')).toEqual([]);
    expect(within(card).queryAllByRole('switch')).toEqual([]);
  });

  it('shows a fresh deployment as "not open yet", a clear state and not an error', async () => {
    mount('#/offers', { prepare: (d) => d.setCaps('all', { on: true, max_swap: '0', max_open: '0', open_value: '0' }) });
    const card = await screen.findByRole('region', { name: 'Protocol beta caps' });
    const note = await within(card).findByText('The protocol is not open yet.');
    expect(text(note.parentElement)).toContain('This is how a fresh deployment begins, not a fault of your daemon');
    expect(note.closest('[role]')?.getAttribute('role')).toBe('note');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(card).getAllByText('Not open yet')).toHaveLength(4);
    // Offers stay configured; each says why it has no capacity, in the protocol's name.
    const offers = screen.getByRole('table', { name: 'Offers' });
    await waitFor(() => expect(text(within(row(offers, 'USDC-SOLSell XMR')).getByTestId('capacity-limit'))).toBe('the protocol is not open yet: its beta caps are at zero'));
    expect(text(row(offers, 'USDC-SOLSell XMR'))).toContain('0 XMR');
  });

  it('tells a reached protocol cap from the maker’s own daily cap', async () => {
    const own = DEFAULT_TOML.replace('[markets.usdc_sol.buy_xmr]\nenabled = true', '[markets.usdc_sol.buy_xmr]\nenabled = true\ndaily_cap_xmr = 20');
    const m = mount('#/offers', { toml: own, prepare: (d) => d.setCaps('sol', { on: true, max_swap: '50000000000', max_open: '200000000000', open_value: '200000000000' }) });
    const offers = await screen.findByRole('table', { name: 'Offers' });
    await waitFor(() => expect(text(within(row(offers, 'SOLSell XMR')).getByTestId('capacity-limit'))).toBe('the protocol’s beta cap is reached: 200 SOL of 200 SOL open'));
    expect(within(row(offers, 'SOLSell XMR')).getByTestId('capacity-limit').className).toContain('warning');
    expect(text(within(row(offers, 'USDC-SOLBuy XMR')).getByTestId('capacity-limit'))).toBe('limited by your own settings (daily cap, exposure limits or largest swap)');
    expect(text(row(offers, 'USDC-SOLBuy XMR'))).toContain('20 XMR');
    expect(text(within(row(offers, 'USDC-SOLSell XMR')).getByTestId('capacity-limit'))).toBe('limited by your unlocked outputs');
    const capsRow = row(within(screen.getByRole('region', { name: 'Protocol beta caps' })).getByRole('table'), 'SOL');
    expect(capsRow.getAttribute('data-caps')).toBe('reached');
    expect(text(capsRow)).toContain('Cap reached The protocol’s beta cap is reached: 200 SOL of 200 SOL open. No new swap can start until one settles.');
    // A swap settles on-chain: the daemon pushes and the headroom is back.
    act(() => m.daemon.setCaps('sol', { on: true, max_swap: '50000000000', max_open: '200000000000', open_value: '150000000000' }));
    await waitFor(() => expect(capsRow.getAttribute('data-caps')).toBe('open'));
    expect(text(capsRow)).toContain('150 SOL of 200 SOL open; 50 SOL of headroom.');
  });

  it('shows the switch off, an unreadable chain, and caps fixed for good', async () => {
    mount('', {
      prepare: (d) => {
        d.setCaps('usdc_sol', { on: false, max_swap: '0', max_open: '0', open_value: usdc(500) });
        d.setCaps('sol', null);
        d.setCaps('eth', { on: true, max_swap: '1000000000000000000', max_open: '5000000000000000000', open_value: '0', frozen: true });
      },
    });
    const table = await within(await screen.findByRole('region', { name: 'Protocol beta caps' })).findByRole('table');
    expect(text(row(table, 'USDC-SOL'))).toContain('Caps off The protocol’s beta caps are switched off: no limit is checked. 500 USDC is open.no limit500 USDCno limitno limit');
    expect(text(row(table, 'SOLSolana'))).toContain('Not readable The caps could not be read from the chain.');
    expect(text(row(table, 'ETHEthereum'))).toContain('Open Fixed for good');
    expect(text(row(table, 'ETHEthereum'))).toContain('The protocol’s configuration is frozen, so these caps stay as they are for good.');
  });
});

describe('freeze window on the Configuration and Offers pages', () => {
  it('explains the window beside the setting, computes the worst case from the offer’s deadlines, and saves it', async () => {
    const m = mount('#/config');
    await screen.findByRole('region', { name: 'Markets and offers' });
    await m.user.click(screen.getByRole('button', { name: 'Edit USDC-SOL Sell XMR settings' }));
    const editor = screen.getByRole('region', { name: 'USDC-SOL Sell XMR settings' });
    const field = within(editor).getByLabelText('Freeze window') as HTMLInputElement;
    expect(field.placeholder).toBe('default 0');
    const note = within(editor).getByTestId('freeze-note');
    expect(text(note)).toContain('What a watcher is. A second machine that follows one swap for a party that may be offline, with a key that lets it do one thing: freeze the swap once, which delays the other side’s claim. It can never move funds, and it can be wrong or down.');
    // Default 0: no watcher; the claim delay of this offer is 101 minutes.
    expect(text(within(note).getByTestId('freeze-worst'))).toBe('With the window at 0 no taker can name a watcher on this offer. Your XMR is locked at most 1h 41m after your lock notice before you may claim.');

    await m.user.type(field, '24');
    // 101 min + 24 h = 25 h 41 min = 92,460 s; 92,460 / 6,060 = 15.3.
    expect(text(within(editor).getByTestId('freeze-worst'))).toBe(
      'Worst case with this offer’s deadlines: your XMR stays locked for 1d 1h after your lock notice before you may claim (your claim delay of 1h 41m plus the window of 1d 0h), against 1h 41m without a watcher: 15.3 times longer. The taker’s own funds are locked for the same time, and it can still walk away during it.',
    );
    expect(text(within(editor).getByTestId('freeze-note'))).toContain('A refund or abort after a freeze always leaves the deposit withholdable.');
    // Out of range is caught at once.
    await m.user.clear(field);
    await m.user.type(field, '80');
    expect(text(field.closest('.field'))).toContain('Error: Freeze window must be at most 72.');
    await m.user.clear(field);
    await m.user.type(field, '24');
    await m.user.click(within(screen.getByRole('region', { name: 'Save configuration' })).getByRole('button', { name: 'Validate and save' }));
    await waitFor(async () => expect(getPath(parseToml((await m.client.call('configGet')).toml), 'markets.usdc_sol.sell_xmr.freeze_window_hours')).toBe(24));
    const live = (await m.client.call('offers')).offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr');
    expect(live?.terms.freeze_window_secs).toBe(86_400);
    // It round-trips through export and import.
    const file = (await m.client.call('configExport')).toml;
    expect(file).toContain('freeze_window_hours = 24');
    expect((await m.client.call('configImport', { body: { toml: file } })).validation.ok).toBe(true);
  });

  it('explains the buy-XMR side differently: the watcher is the maker’s and the cost is the taker’s', async () => {
    const m = mount('#/config');
    await screen.findByRole('region', { name: 'Markets and offers' });
    await m.user.click(screen.getByRole('button', { name: 'Edit USDC-SOL Buy XMR settings' }));
    const editor = screen.getByRole('region', { name: 'USDC-SOL Buy XMR settings' });
    await m.user.type(within(editor).getByLabelText('Freeze window'), '48');
    const note = text(within(editor).getByTestId('freeze-note'));
    expect(note).toContain('Buying XMR, you are the one who locks funds, so the watcher is yours');
    expect(note).toContain('its claim without your ready can wait up to 2d 1h after its notice (the claim delay of 1h 41m plus the window of 2d 0h) instead of 1h 41m, with its XMR locked meanwhile. After a freeze your daemon must set ready or refund 5m 00s before the window ends.');
    expect(note).toContain('A refund of yours after a freeze returns the taker’s deposit at once');
    expect(text(within(editor).getByLabelText('Freeze window').closest('.field'))).toContain('Warning: usdc_sol buy_xmr: no watcher is configured ([watcher] url)');
  });

  it('shows the freeze window in the offers table', async () => {
    mount('#/offers', { toml: DEFAULT_TOML.replace('[markets.usdc_sol.sell_xmr]\nenabled = true', '[markets.usdc_sol.sell_xmr]\nenabled = true\nfreeze_window_hours = 24') });
    const offers = await screen.findByRole('table', { name: 'Offers' });
    const rows = within(offers).getAllByRole('row');
    expect(text(rows.find((r) => text(r).startsWith('USDC-SOLSell XMR')) as HTMLElement)).toContain('depth up to 25 · freeze window 1d 0h');
    expect(text(rows.find((r) => text(r).startsWith('USDC-SOLBuy XMR')) as HTMLElement)).toContain('· no watcher accepted');
  });

  it('has the maker’s watcher settings with an honest description, and the risk settings for watchers', async () => {
    const m = mount('#/config');
    const ops = await screen.findByRole('region', { name: 'Daemon and connections' });
    expect(text(within(ops).getByTestId('watcher-setting-note'))).toBe(
      'Off unless a URL is set. For swaps where the taker sells XMR and you lock the funds: the daemon names the watcher’s key when it funds and hands it that one swap’s notice key. It sees which swaps you fund, their amounts and timing, the joint address and the taker’s Monero lock transaction. It can do one thing: freeze a swap, which delays the taker’s claim. It cannot move funds and holds no key share. It can be down, and it can freeze a good swap by mistake. It is the mitigation for your daemon being down during a funded swap, and it applies only to buy-XMR offers with a freeze window.',
    );
    expect((within(ops).getByLabelText('Watcher URL') as HTMLInputElement).value).toBe('');
    await m.user.type(within(ops).getByLabelText('Watcher URL'), 'https://watcher.example.org');
    await m.user.type(within(ops).getByLabelText('Watcher’s Solana key'), 'WatcherSolKey');
    await m.user.type(within(ops).getByLabelText('Watcher’s Ethereum address'), '0x00000000000000000000000000000000000000f0');
    await m.user.click(within(ops).getByRole('switch', { name: 'Refuse every lock that names a watcher' }));
    await m.user.type(within(ops).getByLabelText('Refuse a taker frozen this many times'), '2');
    const deny = within(ops).getByRole('group', { name: 'Refuse these watcher keys' });
    await m.user.type(within(deny).getByLabelText('Add to Refuse these watcher keys'), 'BadWatcherKey{Enter}');
    await m.user.click(within(screen.getByRole('region', { name: 'Save configuration' })).getByRole('button', { name: 'Validate and save' }));
    await waitFor(async () => expect(getPath(parseToml((await m.client.call('configGet')).toml), 'watcher.url')).toBe('https://watcher.example.org'));
    const cfg = parseToml((await m.client.call('configGet')).toml);
    expect(getPath(cfg, 'watcher')).toEqual({ url: 'https://watcher.example.org', solana_key: 'WatcherSolKey', ethereum_key: '0x00000000000000000000000000000000000000f0' });
    expect(getPath(cfg, 'approvals')).toEqual({ refuse_watchers: true, max_taker_freezes: 2, deny_watchers: ['BadWatcherKey'] });
    expect((await m.client.call('status')).watcher.url).toBe('https://watcher.example.org');
  });
});

describe('frozen swaps', () => {
  it('lists a frozen swap with its state and a countdown to the frozen-final time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = mount('#/swaps', { frozen: true });
    const table = await within(screen.getByRole('main')).findByRole('table');
    const ref = fakeSol('swap-frozen');
    const row = within(table).getByRole('link', { name: `Swap ${ref}` }).closest('tr') as HTMLElement;
    expect(text(row)).toContain('Frozen');
    expect(text(row)).toContain('names a watcher');
    // Frozen 20 minutes ago with a 24-hour window; Solana chain time runs 1 s behind.
    await waitFor(() => expect(text(row)).toContain('23h 40mFrozen-final time: the claim opens'));
    act(() => {
      m.advance(3_600);
      vi.advanceTimersByTime(1_000);
    });
    expect(text(row)).toContain('22h 40mFrozen-final time: the claim opens');
  });

  it('shows who froze, when, the frozen-final time, what the daemon will do, and the withhold decision', async () => {
    const m = mount(`#/swaps/${fakeSol('swap-frozen')}`, { frozen: true });
    const panel = await screen.findByTestId('frozen-panel');
    expect(text(panel)).toContain('This swap is frozen. The taker’s side paused it: your claim without the taker’s ready waits until the frozen-final time. Nothing was revealed and nothing moved.');
    expect(text(panel)).toContain('Frozen bythe taker’s watcher, or the taker itself (the daemon did not report which)');
    expect(text(panel)).toContain(`Watcher key${fakeSol('watcher-of-taker')}`);
    expect(text(panel)).toContain('Frozen at2026-11-18 10:46:40Z (20m 00s ago)');
    expect(text(panel)).toContain('Frozen-final time23h 40m 2026-11-19 10:46:40Z');
    expect(text(panel)).toContain('The freeze window of this swap is 1d 0h.');
    expect(text(within(panel).getByTestId('frozen-plan'))).toBe(
      'Nothing until then. If the taker sets ready first, it claims inside the claim window as usual. If the taker refunds first, it recovers your XMR and the deposit is held for your withhold decision. Otherwise, at the frozen-final time (2026-11-19 10:46:40Z) it claims, or aborts if this offer is set to abort without ready.',
    );
    expect(text(panel)).toContain('If the taker refunds or you abort from here, the deposit is always withholdable: your withhold policy decides inside the 30-minute hold, and you can override it on the Deposits page.');
    // In the summary: state, freeze window, the watcher, and this taker's freeze count.
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(text(summary)).toContain('Frozen');
    expect(text(summary)).toContain('Freeze window1d 0h');
    expect(text(summary)).toContain('Taker’s watcher');
    await waitFor(() => expect(text(within(summary).getByTestId('taker-freezes'))).toBe('1 of this taker’s 1 swap with you was frozen.'));
    // The deadlines list the freeze and the frozen-final time.
    const deadlines = text(within(screen.getByRole('region', { name: 'Deadlines' })).getByRole('table'));
    expect(deadlines).toContain('FrozenA watcher or the locker paused the swap2026-11-18 10:46:40Zpassed');
    expect(deadlines).toContain('Frozen-final timeThe claim without ready opens here instead2026-11-19 10:46:40Z23h 40m');
    // The claimer may still abort, with the consequence spelled out.
    expect(within(summary).getByRole('button', { name: 'Abort swap' })).toBeTruthy();
    void m;
  });

  it('names the freezer when the daemon reports it, and the taker’s freeze count from the daemon', async () => {
    const swap = { ...frozenSwap(T0), frozen_by: fakeSol('watcher-of-taker'), taker_freezes: 3 } as SwapDetail;
    mount(`#/swaps/${swap.ref}`, { prepare: (d) => d.putSwap(swap) });
    const panel = await screen.findByTestId('frozen-panel');
    expect(text(panel)).toContain('Frozen bythe taker’s watcher');
    expect(text(panel)).not.toContain('did not report which');
    await waitFor(() => expect(text(screen.getByTestId('taker-freezes'))).toBe('3 of this taker’s 1 swap with you were frozen.'));
  });

  it('describes a frozen buy-XMR swap from the locker’s side: verify, then set ready or refund before the margin', async () => {
    const base = frozenSwap(T0);
    const swap: SwapDetail = { ...base, direction: 'B', ref: fakeSol('swap-frozen-b'), extras: { payout: fakeSol('payout-frozen-b'), watcher: fakeSol('my-watcher'), freeze_window_secs: 86_400, watching_until: T0 + 3_600 } };
    mount(`#/swaps/${swap.ref}`, { prepare: (d) => d.putSwap(swap) });
    const panel = await screen.findByTestId('frozen-panel');
    expect(text(panel)).toContain('Your side paused it: the taker’s claim without your ready waits until the frozen-final time');
    // T_ff − M: 2026-11-19 10:46:40Z less 5 minutes.
    expect(text(within(panel).getByTestId('frozen-plan'))).toBe('It verifies the taker’s XMR lock, then sets ready (lock good) or refunds (lock bad), no later than 2026-11-19 10:41:40Z: 5m 00s before the frozen-final time. After that the taker may claim.');
    expect(text(panel)).toContain('A refund of yours from here returns the taker’s deposit at once; it can never be held.');
  });

  it('shows freeze counts and a named watcher in the approvals queue, and marks a denied watcher', async () => {
    const taker = fakeSol('taker-pending');
    const past = (n: number): SwapDetail => ({ ...frozenSwap(T0), ref: fakeSol(`past-${n}`), taker, state: 'DONE', outcome: 'refunds_after_freeze', actions: [], next_deadline: null });
    const m = mount('#/approvals', {
      prepare: (d) => {
        d.putSwap(past(1));
        d.putSwap(past(2));
        d.nameWatcher(REF.pendingSol, 'WatcherKeyExample');
      },
    });
    const table = await screen.findByRole('table', { name: 'Pending approvals' });
    const row = within(table).getByRole('link', { name: `Swap ${REF.pendingSol}` }).closest('tr') as HTMLElement;
    expect(text(within(row).getByTestId('approval-watcher'))).toContain('names a watcher');
    expect(text(within(row).getByTestId('approval-watcher'))).toContain('May freeze');
    await waitFor(() => expect(text(row)).toContain('2 of this taker’s 3 swaps with you were frozen'));
    await m.client.call('configImport', { body: { toml: `${DEFAULT_TOML}\n[approvals]\ndeny_watchers = ["WatcherKeyExample"]\n` } });
    window.location.hash = '#/keys';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    await screen.findByRole('heading', { level: 1, name: 'Keys' });
    window.location.hash = '#/approvals';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    const again = await screen.findByRole('table', { name: 'Pending approvals' });
    await waitFor(() => expect(text(within(again).getByTestId('approval-watcher'))).toContain('On your deny list'));
  });
});

describe('payout address and the maker’s watcher on a swap where the taker sells XMR', () => {
  it('shows the payout address as distinct from the taker’s wallet, and never one as the other', async () => {
    mount(`#/swaps/${REF.buy}`);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    const wallet = fakeSol('taker-buy');
    const payout = fakeSol('payout-buy');
    expect(wallet).not.toBe(payout);
    expect(text(summary)).toContain(`Taker’s wallet${wallet}`);
    expect(text(within(summary).getByTestId('payout-address'))).toBe(`${payout}Where the taker’s claim pays. It is not the taker’s wallet: refunds and the take deposit go back to the wallet, never here.`);
    expect(text(summary)).not.toContain(`Taker’s wallet${payout}`);
    expect(text(summary)).not.toContain(`Taker’s payout address${wallet}`);
  });
  it('says so when no separate payout address was named', async () => {
    const swap: SwapDetail = { ...frozenSwap(T0), direction: 'B', ref: fakeSol('swap-b-default'), state: 'ACTIVE', extras: { payout: null, watcher: null, freeze_window_secs: 0, watching_until: null } };
    mount(`#/swaps/${swap.ref}`, { prepare: (d) => d.putSwap(swap) });
    expect(text(await screen.findByTestId('payout-address'))).toBe('the taker’s own wallet (no separate payout address was named)');
  });
  it('shows no payout address on a sell-XMR swap, where the taker receives XMR', async () => {
    mount(`#/swaps/${REF.noticed}`);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    await waitFor(() => expect(text(summary)).toContain('Taker’s wallet'));
    expect(screen.queryByTestId('payout-address')).toBeNull();
    expect(text(summary)).not.toContain('payout address');
  });

  it('shows the watcher’s acknowledgement for the swap', async () => {
    const swap: SwapDetail = { ...frozenSwap(T0), direction: 'B', ref: fakeSol('swap-b-watched'), state: 'NOTICED', extras: { payout: null, watcher: fakeSol('my-watcher'), freeze_window_secs: 86_400, watching_until: T0 + 1_800 } };
    mount(`#/swaps/${swap.ref}`, { prepare: (d) => d.putSwap(swap) });
    const w = await screen.findByTestId('swap-watcher');
    expect(text(w)).toContain('Acknowledged watching until 2026-11-18 11:36:40Z (30m 01s)');
    expect(text(w)).toContain('The watcher signed an acknowledgement that it follows this swap until your refund window closes.');
    expect(text(w)).toContain(`Watcher key${fakeSol('my-watcher')}`);
    expect(within(w).queryByRole('alert')).toBeNull();
  });

  it('warns on a funded swap with no acknowledged watcher while the daemon is degraded, and only then', async () => {
    const m = mount(`#/swaps/${REF.buy}`);
    const w = await screen.findByTestId('swap-watcher');
    expect(text(w)).toContain('Not possible this offer has no freeze window, so the swap cannot be frozen');
    // Healthy daemon: no alarm.
    expect(within(w).queryByRole('alert')).toBeNull();
    // The Solana connection drops.
    act(() => {
      m.daemon.disconnected = { solana: 'connection refused' };
      m.daemon.setCaps('eth', null);
    });
    const alert = await within(screen.getByTestId('swap-watcher')).findByRole('alert');
    expect(text(alert)).toBe(
      'Funded, unwatched, and the daemon is degraded. Your funds are in escrow on this swap, no watcher has acknowledged it, and right now Solana is not connected. If the daemon cannot check the taker’s XMR lock and refund inside the refund window, a false notice can cost you the escrow. Restore the daemon’s connections now.',
    );
  });

  it('does not warn when a watcher has acknowledged the swap, even while degraded', async () => {
    const swap: SwapDetail = { ...frozenSwap(T0), direction: 'B', ref: fakeSol('swap-b-safe'), state: 'ACTIVE', extras: { payout: null, watcher: fakeSol('my-watcher'), freeze_window_secs: 86_400, watching_until: T0 + 1_800 } };
    mount(`#/swaps/${swap.ref}`, {
      prepare: (d) => {
        d.putSwap(swap);
        d.disconnected = { solana: 'connection refused' };
      },
    });
    const w = await screen.findByTestId('swap-watcher');
    await waitFor(() => expect(text(w)).toContain('Acknowledged'));
    expect(within(w).queryByRole('alert')).toBeNull();
  });
});

describe('Status: release record, program build, watcher', () => {
  const release = (status: 'development-snapshot' | 'release', source: 'docker' | 'local' = 'docker') => ({
    format: 'xmrswap-served/1',
    ui: { tree_hash: 'ab'.repeat(32), files: 6, bytes: 2_987_889 },
    recorded: true,
    release: { version: status === 'release' ? '1.0.0' : 'dev-snapshot', status, commit: 'c0ffee'.repeat(6) + 'c0ff', commit_time: '2026-11-27T18:01:38Z', program_id: 'ProgramIdExample', program_executable_hash: 'cd'.repeat(32), program_hash_source: source, onchain_deployed: false },
  });

  it('says "no release record" when the server provides none', async () => {
    mount('#/status');
    const card = await screen.findByTestId('release-card');
    expect(card.getAttribute('data-release')).toBe('none');
    expect(text(card)).toContain('No release record. The server this console was loaded from provides no /release.json');
  });

  it('states a development snapshot plainly, with version, commit, tree hash and the expected program', async () => {
    mount('#/status', { release: release('development-snapshot', 'local') });
    const card = await screen.findByTestId('release-card');
    await waitFor(() => expect(card.getAttribute('data-release')).toBe('development-snapshot'));
    const t = text(screen.getByTestId('release-card'));
    expect(t).toContain('Development snapshot. This console was built from a development snapshot, not from a published release.');
    expect(t).toContain('Versiondev-snapshot Development snapshot');
    expect(t).toContain(`Commit${'c0ffee'.repeat(6)}c0ff · 2026-11-27T18:01:38Z`);
    expect(t).toContain(`UI tree hash${'ab'.repeat(32)}of the files as served (6 files)`);
    expect(t).toContain('Expected program idProgramIdExample');
    expect(t).toContain(`Expected executable hash${'cd'.repeat(32)}from a local build: not a reproducible hash`);
    expect(t).toContain('This is the server describing itself.');
  });

  it('shows a published release, and files that match no record', async () => {
    mount('#/status', { release: release('release') });
    await waitFor(() => expect(screen.getByTestId('release-card').getAttribute('data-release')).toBe('release'));
    expect(text(screen.getByTestId('release-card'))).toContain('Release 1.0.0. The files match a recorded release.');
    expect(text(screen.getByTestId('release-card'))).toContain('from the deterministic (Docker) build');
  });
  it('says so when the served files match no recorded release', async () => {
    mount('#/status', { release: { ...release('release'), recorded: false, release: null } });
    await waitFor(() => expect(screen.getByTestId('release-card').getAttribute('data-release')).toBe('unrecorded'));
    expect(text(screen.getByTestId('release-card'))).toContain('These files match no recorded release.');
  });

  it('compares the expected and the deployed program: none published, match, mismatch, unreadable', async () => {
    const m = mount('#/status');
    const card = await screen.findByTestId('program-build');
    expect(card.getAttribute('data-matches')).toBe('null');
    expect(text(card)).toContain('No published build to compare with.');
    const hash = 'ef'.repeat(32);
    act(() => {
      m.daemon.programBuild = { expected_hash: hash, on_chain_hash: hash };
      m.daemon.setCaps('eth', null);
    });
    await waitFor(() => expect(screen.getByTestId('program-build').getAttribute('data-matches')).toBe('true'));
    expect(text(screen.getByTestId('program-build'))).toContain('The deployed program matches the published build.');
    act(() => {
      m.daemon.programBuild = { expected_hash: hash, on_chain_hash: '01'.repeat(32) };
      m.daemon.setCaps('eth', null);
    });
    const alert = await within(screen.getByTestId('program-build')).findByRole('alert');
    expect(text(alert)).toContain('The deployed program does not match the published build. What is on the chain is not what this daemon was built to run against.');
    act(() => {
      m.daemon.programBuild = { expected_hash: hash, on_chain_hash: null };
      m.daemon.setCaps('eth', null);
    });
    await waitFor(() => expect(text(screen.getByTestId('program-build'))).toContain('The deployed program could not be read.'));
  });

  it('shows the maker’s watcher: off by default, then reachable with its keys', async () => {
    const m = mount('#/status');
    const card = await screen.findByTestId('watcher-card');
    expect(text(card)).toContain('Your watcherOff none configured');
    expect(text(card)).toContain('It can do one thing: freeze a swap, which delays the taker’s claim.');
    await m.client.call('configImport', { body: { toml: `${DEFAULT_TOML}\n[watcher]\nurl = "https://watcher.example.org"\n` } });
    act(() => {
      m.daemon.watcherState = { reachable: true, solana: fakeSol('my-watcher'), ethereum: '0x00000000000000000000000000000000000000f0', watching: 2 };
      m.daemon.setCaps('eth', null);
    });
    await waitFor(() => expect(text(screen.getByTestId('watcher-card'))).toContain('Reachable https://watcher.example.org'));
    expect(text(screen.getByTestId('watcher-card'))).toContain(`Its Solana key${fakeSol('my-watcher')}`);
    expect(text(screen.getByTestId('watcher-card'))).toContain('Watching now2 swaps');
    act(() => {
      m.daemon.watcherState = { reachable: false, solana: null, ethereum: null, watching: 0, last_error: 'connection refused' };
      m.daemon.setCaps('eth', null);
    });
    await waitFor(() => expect(text(screen.getByTestId('watcher-card'))).toContain('Not reachable'));
    expect(text(screen.getByTestId('watcher-card'))).toContain('connection refused');
    expect(stat('Mode')).toBe('ModeLivetransactions are sent');
  });
});
