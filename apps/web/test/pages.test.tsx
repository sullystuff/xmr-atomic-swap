// Pages over the test doubles: maker contact channels, the large-swap tool from
// order entry to the final report, settings, and the wallet-needed step.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONTACT_KIND, COUNTER } from '@xmrswap/protocol';
import { deadlinesOf, init } from '@xmrswap/sdk';
import { CONTACT_WARNING } from '../src/pages/MakerPage.js';
import { SOL, XMR, row } from './fakes.js';
import { DEST, makeRig, mount } from './harness.js';

// The fixtures below derive real keys at collection time.
await init();

const TXID = 'ab'.repeat(32);

describe('maker page', () => {
  it('shows merged history as counts and per 100 completed, and labels contact channels as unverified', async () => {
    const r = row(1, {}, { counters: { [COUNTER.completed]: 50, [COUNTER.missed_notices]: 2, [COUNTER.withholds]: 1, [COUNTER.deposits_returned]: 4 }, contacts: [{ kind: CONTACT_KIND.MATRIX, value: '#maker:example.org' }] });
    const rig = makeRig({ rows: [r] });
    await mount(rig, `#/maker/${r.maker.pda}`);
    const warning = (await screen.findByText(CONTACT_WARNING)).closest('[data-kind="warn"]')!;
    expect(CONTACT_WARNING).toBe('Provided by the maker, not verified; nobody legitimate asks for a seed phrase or key share.');
    expect(warning.textContent).toMatch(/trying to take your funds/);
    expect(screen.getByText('#maker:example.org').parentElement!.textContent).toContain('maker-provided');
    const faults = screen.getByText('Missed lock-notice deadlines (fault)').closest('tr')!;
    expect(within(faults).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Missed lock-notice deadlines (fault)', '2', '4.0']);
    expect(screen.getByText('Withhold rate').parentElement!.textContent).toContain('20%');
    // The inbox needs the seed: replies are encrypted to keys derived from it.
    expect(screen.getByText('Load your recovery file to use the inbox')).toBeTruthy();
  });
});

describe('large-swap tool', () => {
  const rows = () => [row(1, { price: (150n * SOL) / 100n, maxXmr: (3n * XMR) / 10n }), row(2, { price: (151n * SOL) / 100n, maxXmr: (3n * XMR) / 10n }), row(3, { price: (152n * SOL) / 100n, maxXmr: (3n * XMR) / 10n })];

  it('order entry → plan → edit → backup gate → confirmation → board → stalled maker refunded and re-planned → final report', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: rows() });
    await mount(rig, '#/large');
    await user.type(await screen.findByLabelText('Total to spend (SOL)'), '1.2');
    await user.type(screen.getByLabelText('Worst acceptable rate (SOL per XMR)'), '1.6');
    await user.type(screen.getByLabelText('Most locked at one time (SOL)'), '0.9');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);

    // The router's plan: two legs in the first wave, the rest later; blended rate and unfilled shown.
    const wave1 = await screen.findByRole('table', { name: 'Wave 1' });
    expect(within(wave1).getAllByTestId('plan-leg')).toHaveLength(2);
    expect(screen.getByRole('table', { name: 'Wave 2' })).toBeTruthy();
    expect(screen.getByText('Blended rate').parentElement!.textContent).toMatch(/1\.50\d*/);
    // Editing: leave maker 1 out; the router re-plans with makers 2 and 3.
    await user.click(within(wave1).getAllByRole('button', { name: /^Leave out maker/ })[0]!);
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Wave 1' })).getAllByRole('link').map((a) => a.textContent)).toEqual([`${rig.rows[1]!.maker.pda.slice(0, 8)}…`, `${rig.rows[2]!.maker.pda.slice(0, 8)}…`]));
    await user.click(screen.getByRole('button', { name: 'Undo my edits to the plan' }));

    // The tool refuses to lock until the backup exists.
    const lock = screen.getByTestId('lock-button') as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
    rig.backup();
    await waitFor(() => expect(lock.disabled).toBe(false));
    await user.click(lock);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('heading', { level: 1 }).textContent).toMatch(/^Keep this tab open until it says Safe to close\./);
    expect(screen.getByRole('dialog').textContent).toMatch(/For a swap this size use a desktop computer/);
    expect(rig.opened).toEqual([]);
    await user.click(dialog.getByRole('checkbox'));
    await user.click(dialog.getByRole('button', { name: /^Lock 0\.90 SOL$/ }));

    // The board: both legs locked, the banner up.
    const board = await screen.findByTestId('large-board');
    expect(rig.opened.map((o) => o.offer)).toEqual([rig.rows[0]!.id, rig.rows[1]!.id]);
    await rig.pass();
    expect(within(board).getAllByTestId('leg').map((l) => l.getAttribute('data-leg-state'))).toEqual(['locked', 'locked']);
    expect(screen.getByTestId('risk-banner').textContent).toMatch(/0\.90 SOL is locked in 2 swaps/);

    // Maker 1 performs; maker 2 stalls.
    const [ref1, ref2] = [...rig.chain.swaps.keys()] as [string, string];
    rig.chain.maker.notice(ref1, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    await rig.pass();
    rig.chain.maker.claim(ref1);
    await rig.pass();
    // A leg settled: the next wave opens by itself within the in-flight limit, with the free maker.
    await waitFor(() => expect(rig.opened).toHaveLength(3));
    expect(rig.opened[2]!.offer).toBe(rig.rows[0]!.id);
    await rig.pass();

    // The user stops the order: legs in flight still finish or refund, nothing new opens.
    await act(async () => {
      await rig.app.stopOrder(rig.app.orders.get()[0]!.id);
    });

    // Maker 2 never posts a notice: its leg is refunded in full and it is left out from then on.
    rig.chain.warpTo(deadlinesOf('solana', rig.chain.swaps.get(ref2)!).tNote!);
    await rig.pass();
    await rig.pass();
    expect(rig.chain.calls).toContainEqual([ref2, 'refund_unnoticed', 'anyone']);
    await waitFor(() => expect(rig.app.order(rig.app.orders.get()[0]!.id)!.excluded).toEqual([rig.rows[1]!.maker.pda]));
    expect(within(board).getAllByTestId('leg').map((l) => l.getAttribute('data-leg-state'))).toContain('refunded');

    expect(rig.opened).toHaveLength(3);
    const ref3 = [...rig.chain.swaps.keys()].find((r) => r !== ref1 && r !== ref2)!;
    rig.chain.maker.notice(ref3, 'cd'.repeat(32));
    rig.monero.locks.set('cd'.repeat(32), { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    await rig.pass();
    rig.chain.maker.claim(ref3);
    await rig.pass();
    const report = await screen.findByTestId('report');
    expect(report.textContent).toMatch(/Partly filled/);
    expect(report.textContent).toMatch(/Filled 0\.75 SOL for 0\.50 XMR\. Unfilled 0\.45 SOL, of which 0\.45\d* SOL was locked and refunded\. You stopped the order\./);
  });

  it('with no usable offer it says so and locks nothing', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: rows() });
    await mount(rig, '#/large');
    rig.backup();
    await user.type(await screen.findByLabelText('Total to spend (SOL)'), '1');
    await user.type(screen.getByLabelText('Worst acceptable rate (SOL per XMR)'), '1.2');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    expect((await screen.findByText('No offer fits this order')).parentElement!.textContent).toMatch(/worse than your worst acceptable rate.*Nothing will be locked/);
    expect((screen.getByTestId('lock-button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('steps that need the wallet', () => {
  it('the tab never opens a wallet prompt on its own: it offers the step and waits for a click', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    await act(async () => rig.app.engine.annotate(ref, { cancel: true }));
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'refund', 'session']]);
    // The refund swept the session key back to the taker; after the hold the deposit needs a fee payer.
    rig.chain.sessionEmpty = true;
    rig.chain.advance(1800);
    await rig.pass();
    expect(rig.chain.called('release_deposit')).toBe(0);
    const offer = (await screen.findByText('Your deposit can be collected now')).closest('.notice')!;
    expect(offer.textContent).toMatch(/Anyone may send it, and it always pays your address; there is no deadline\./);
    await user.click(within(offer as HTMLElement).getByRole('button', { name: 'Sign with my wallet' }));
    await waitFor(() => expect(rig.chain.called('release_deposit')).toBe(1));
  });
});

describe('settings and empty states', () => {
  it('with no Solana RPC the offers page explains why there is nothing and points to Settings', async () => {
    const rig = makeRig({ settings: { solanaRpc: '', moneroNodes: [] } });
    await mount(rig, '#/');
    expect((await screen.findByRole('heading', { name: 'Choose a Solana RPC to see offers' })).parentElement!.textContent).toMatch(/This site has no default RPC: whoever runs it sees your queries/);
  });

  it('the settings page shows what each connection mode reveals, documents the relay CORS setting, and shows the pinned program id', async () => {
    const rig = makeRig({ settings: { mode: 'self-hosted' } });
    await mount(rig, '#/settings');
    const modes = within(await screen.findByRole('radiogroup'));
    expect(modes.getAllByRole('radio')).toHaveLength(4);
    expect(modes.getByText('Hosted relay').closest('label')!.textContent).toMatch(/The site operator sees your IP address, which maker you contact, message sizes and timing/);
    expect(modes.getByText('On-chain only').closest('label')!.textContent).toMatch(/Solana swaps only/);
    expect(screen.getByLabelText('Relay URL').parentElement!.textContent).toMatch(/RELAY_ALLOWED_ORIGINS/);
    expect((screen.getByLabelText('Solana program id') as HTMLInputElement).value).toBe(rig.app.settings.get().programId);
    expect(screen.getByLabelText('Node URLs, one per line').parentElement!.textContent).toMatch(/put the one you trust most first/);
  });
});
