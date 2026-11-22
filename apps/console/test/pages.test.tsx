import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath, parseToml } from '../src/lib/config/toml.js';
import { REF, fakeSol } from '../src/mock/fixtures.js';
import { groupThreads } from '../src/pages/monitor.js';
import { keyState } from '../src/pages/setup.js';
import { DESIGN_BOTH_TOML } from './design.js';
import { T0, mount, stat, text } from './harness.js';

const rowsOf = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').slice(1);
const confirm = async (user: ReturnType<typeof mount>['user'], scope: HTMLElement, label: string): Promise<void> => {
  await user.click(within(scope).getByRole('button', { name: label }));
  await user.click(within(within(scope).getByRole('alertdialog')).getByRole('button', { name: label }));
};
/** Let the once-a-second clock tick without waiting a real second. */
const tick = (m: ReturnType<typeof mount>, secs: number): void => {
  act(() => {
    m.advance(secs);
    vi.advanceTimersByTime(1_000);
  });
};
afterEach(() => vi.useRealTimers());

describe('dashboard', () => {
  it('shows fills, spread earned, abort and withhold rates, missed deadlines and uptime', async () => {
    mount();
    const history = await screen.findByRole('region', { name: 'History' });
    await within(history).findByText('Fills');
    const stat = (label: string): string => text(within(history).getByText(label).closest('.stat'));
    expect(stat('Fills')).toContain('Fills214');
    expect(stat('Spread earned')).toBe('Spread earned$16,482.37');
    expect(stat('Approval rate')).toBe('Approval rate93.4%typical response 11.4 s');
    expect(stat('Abort rate')).toBe('Abort rate1.2%');
    expect(stat('Withhold rate')).toBe('Withhold rate1.4%of refunds with a deposit');
    expect(stat('Unreleased rate')).toBe('Unreleased rate0.5%withheld and never released');
    expect(stat('Missed deadlines')).toBe('Missed deadlines1recorded publicly against you');
    expect(stat('Uptime')).toBe('Uptime99.82%running 6 days');
  });

  it('lists what needs the maker and the alerts, unacknowledged first', async () => {
    mount();
    const needs = await screen.findByRole('list', { name: 'Items that need you' });
    await waitFor(() => expect(within(needs).getAllByRole('listitem')).toHaveLength(5));
    expect(within(needs).getAllByRole('listitem').map(text)).toEqual([
      '1 swap is parked for you to review',
      '3 locks are waiting for approval',
      '1 deposit is in its 30-minute hold',
      '2 unread messages',
      '1 refill is waiting for approval',
    ]);
    expect(within(needs).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['#/swaps', '#/approvals', '#/deposits', '#/inbox', '#/rebalancing']);
    const alerts = rowsOf(screen.getByRole('table', { name: 'Alerts' }));
    expect(alerts).toHaveLength(4);
    expect(text(alerts[0] as HTMLElement)).toContain('Warning');
    expect(text(alerts[alerts.length - 1] as HTMLElement)).toContain('(acknowledged)');
    expect(alerts.map(text).join(' ')).toContain('Critical');
  });

  it('merges the two chains’ counters', async () => {
    mount();
    const card = await screen.findByRole('region', { name: 'On-chain counters' });
    const completed = (await within(card).findByText('completed')).closest('tr') as HTMLElement;
    expect(text(completed)).toBe('completed19618214');
  });

  it('warns when the fee runway is below the threshold', async () => {
    mount('', { prepare: (d) => d.setOperatorLamports(100_000_000n) });
    const card = await screen.findByRole('region', { name: 'Needs you' });
    await waitFor(() => expect(text(card)).toContain('Fee wallet low. 3.5 days of offer updates left, below your threshold of 7 days.'));
  });

  it('has an empty state for a daemon that has done nothing yet', async () => {
    mount('', { empty: true });
    expect(await screen.findByText('Nothing is waiting')).toBeTruthy();
    expect(await screen.findByText('No alerts')).toBeTruthy();
  });
});

describe('offers', () => {
  it('shows each market and direction with price, capacity, key pool and terms', async () => {
    mount('#/offers');
    const table = await screen.findByRole('table', { name: 'Offers' });
    const rows = rowsOf(table);
    expect(rows.map((r) => text(within(r).getAllByRole('rowheader')[0] as HTMLElement))).toEqual([
      'USDC-SOLSell XMR · Solana',
      'USDC-SOLBuy XMR · Solana',
      'SOLSell XMR · Solana',
      'SOLBuy XMR · Solana',
      'USDC-ETHSell XMR · Ethereum',
      'USDC-ETHBuy XMR · Ethereum',
      'ETHSell XMR · Ethereum',
      'ETHBuy XMR · Ethereum',
    ]);
    const usdc = text(rows[0] as HTMLElement);
    // 412.35 × 1.015, and the 50 XMR tier at +0.5%.
    expect(usdc).toContain('Live');
    expect(usdc).toContain('418.5352 USDC');
    expect(usdc).toContain('420.597 USDC above 50 XMR');
    expect(usdc).toContain('reference 412.35 USDC + 1.50%');
    expect(usdc).toContain('0.1 to 200');
    expect(usdc).toContain('11 of 16');
    expect(usdc).toContain('Auto-accept');
    expect(usdc).toContain('claim delay 101 min · deposit 2.00% · depth up to 25');
    // Buying subtracts the deviation.
    expect(text(rows[1] as HTMLElement)).toContain('408.2265 USDC');
    expect(text(rows[1] as HTMLElement)).toContain('reference 412.35 USDC − 1.00%');
    // A low key pool is flagged; a window offer states its window.
    expect(text(rows[2] as HTMLElement)).toContain('3 of 16 Low');
    expect(text(rows[2] as HTMLElement)).toContain('Approval window · window 60 s');
    expect(text(rows[4] as HTMLElement)).toContain('window 120 s');
    expect(text(rows[6] as HTMLElement)).toContain('OffSwitched off in the configuration');
  });

  it('shows the update-cost panel: estimate, actual spend, runway, occasional costs', async () => {
    mount('#/offers');
    const card = await screen.findByRole('region', { name: 'Update cost' });
    expect(text(await within(card).findByTestId('daily-sol'))).toBe('0.0288 SOL');
    expect(text(within(card).getByTestId('daily-usd'))).toBe('about $5.40');
    expect(text(within(card).getByTestId('spent-sol'))).toBe('0.027936 SOL');
    await waitFor(() => expect(text(within(card).getByTestId('runway').closest('.stat'))).toBe('Runway83.3 daysfee wallet holds 2.4 SOL · alert below 7 days'));
    expect(text(within(card).getByRole('table', { name: 'Occasional costs' }))).toContain('Ethereum registry changesPaid in ETH10.000412 ETH');
    expect(text(card)).toContain('Refreshing every 15 s at the base fee.');
  });

  it('shows dry-run offers as computed but not published', async () => {
    mount('#/offers', { toml: DESIGN_BOTH_TOML });
    const rows = rowsOf(await screen.findByRole('table', { name: 'Offers' }));
    expect(text(rows[0] as HTMLElement)).toContain('Dry runDry run: computed but not published');
    expect(text(rows[0] as HTMLElement)).toContain('418.5352 USDC');
    expect(text(rows[0] as HTMLElement)).toContain('not published');
  });
});

describe('approvals', () => {
  it('queues pending locks soonest first with a countdown to the window', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = mount('#/approvals');
    const table = await screen.findByRole('table', { name: 'Pending approvals' });
    let rows = rowsOf(table);
    // Solana chain time runs 1 s behind this machine, Ethereum 7 s: the countdowns use chain time.
    await waitFor(() => expect(text(within(rowsOf(table)[0] as HTMLElement).getAllByRole('cell')[0] as HTMLElement)).toBe('39sSolana'));
    rows = rowsOf(table);
    expect(rows.map((r) => text(within(r).getAllByRole('cell')[0] as HTMLElement))).toEqual(['39sSolana', '52sSolana', '1m 26sEthereum']);
    expect(text(rows[0] as HTMLElement)).toContain('SOLSell XMR');
    expect(text(rows[0] as HTMLElement)).toContain('4 XMR8.975 SOL');
    expect(text(rows[0] as HTMLElement)).toContain('ApproveWithin the automatic size limitExposure after this swap: 71 of 400 XMR');
    expect(text(rows[1] as HTMLElement)).toContain('RejectAbove the automatic size limit of 25 XMR');
    expect(text(rows[2] as HTMLElement)).toContain('Proof valid');

    tick(m, 1);
    expect(text(within(rowsOf(table)[0] as HTMLElement).getAllByRole('cell')[0] as HTMLElement)).toBe('38sSolana');
    tick(m, 25);
    const first = within(rowsOf(table)[0] as HTMLElement).getByText('13s');
    expect(first.className).toContain('urgent');
    // A window that has closed leaves the queue: the taker is refunded in full.
    tick(m, 14);
    expect(rowsOf(table).map((r) => text(within(r).getAllByRole('cell')[0] as HTMLElement))).toEqual(['12sSolana', '46sEthereum']);
  });

  it('approves and rejects from the queue', async () => {
    const m = mount('#/approvals');
    const table = await screen.findByRole('table', { name: 'Pending approvals' });
    const row = (ref: string): HTMLElement => within(table).getByRole('link', { name: `Swap ${ref}` }).closest('tr') as HTMLElement;
    await m.user.click(within(row(REF.pendingSol)).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(table).queryByRole('link', { name: `Swap ${REF.pendingSol}` })).toBeNull());
    expect((await m.client.call('swap', { params: { ref: REF.pendingSol } })).state).toBe('ACTIVE');

    // Rejecting takes a reason; "no fault" reasons are counted apart from the approval rate.
    const deny = row(REF.pendingDeny);
    const reason = within(deny).getByLabelText('Reason for rejecting') as HTMLSelectElement;
    expect([...reason.options].map((o) => o.textContent)).toEqual(['My choice (counts in the approval rate)', 'Unusable taker input (no fault)', 'The pool leaf was already consumed (no fault)']);
    await m.user.selectOptions(reason, '1');
    await m.user.click(within(deny).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(rowsOf(table)).toHaveLength(1));
    expect((await m.client.call('swap', { params: { ref: REF.pendingDeny } })).outcome).toBe('rejections_no_fault');
    expect(await screen.findByText('The taker is refunded in full, with no fee.')).toBeTruthy();
  });

  it('has an empty queue state', async () => {
    mount('#/approvals', { empty: true });
    expect(await screen.findByText('No locks are waiting')).toBeTruthy();
    expect(await screen.findByText('No advance approvals issued')).toBeTruthy();
  });

  it('issues an advance approval with a size limit and an expiry, and revokes', async () => {
    const m = mount('#/approvals');
    const card = await screen.findByRole('region', { name: 'Advance approvals' });
    const table = await within(card).findByRole('table', { name: 'Advance approvals' });
    expect(rowsOf(table).map((r) => text(within(r).getAllByRole('cell')[5] as HTMLElement))).toEqual(['Active', 'Expired']);

    await m.user.click(within(card).getByRole('button', { name: 'Sign approval' }));
    expect(text(within(card).getByRole('alert'))).toContain('Enter the size limit as an XMR amount');
    await m.user.selectOptions(within(card).getByLabelText('Chain'), 'ethereum');
    await m.user.type(within(card).getByLabelText('Taker address'), '0x00000000000000000000000000000000000000bb');
    await m.user.type(within(card).getByLabelText('Limit per swap (XMR)'), '12.5');
    await m.user.clear(within(card).getByLabelText('Valid for (days)'));
    await m.user.type(within(card).getByLabelText('Valid for (days)'), '14');
    await m.user.click(within(card).getByRole('button', { name: 'Sign approval' }));
    const sig = (await within(card).findByLabelText('Advance approval signature')) as HTMLTextAreaElement;
    expect(sig.value.length).toBeGreaterThan(40);
    const made = (await m.client.call('approvals')).advance[0];
    expect(made).toMatchObject({ chain: 'ethereum', taker: '0x00000000000000000000000000000000000000bb', max_xmr: '12500000000000', expires_at: T0 + 14 * 86_400, active: true });
    await waitFor(() => expect(rowsOf(table)).toHaveLength(3));
    expect(text(rowsOf(table)[0] as HTMLElement)).toContain('12.5 XMR');

    // One approval can be revoked on Ethereum; on Solana only all at once.
    await confirm(m.user, rowsOf(table)[0] as HTMLElement, 'Revoke');
    await waitFor(async () => expect((await m.client.call('approvals')).advance[0]?.active).toBe(false));
    await m.user.click(within(card).getByRole('button', { name: 'Revoke all on Solana' }));
    expect(text(within(card).getByRole('alertdialog'))).toContain('Bump the approval epoch on Solana (now 2). This kills every outstanding advance approval there at once. On Solana this is the only way to revoke.');
    await m.user.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Revoke all on Solana' }));
    await waitFor(async () => expect((await m.client.call('approvals')).advance.every((a) => !a.active)).toBe(true));
    await waitFor(() => expect(rowsOf(table).map((r) => text(within(r).getAllByRole('cell')[5] as HTMLElement))).toEqual(['Revoked', 'Revoked', 'Expired']));
  });
});

describe('deposits', () => {
  it('lists held deposits with the 30-minute countdown and withheld ones with the days to the split', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = mount('#/deposits');
    const held = await screen.findByRole('table', { name: 'Held deposits' });
    const row = rowsOf(held)[0] as HTMLElement;
    await waitFor(() => expect(text(within(rowsOf(held)[0] as HTMLElement).getAllByRole('cell')[2] as HTMLElement)).toBe('18m 01sthen it returns to the taker'));
    expect(text(row)).toContain('41.8 USDC');
    expect(text(row)).toContain('Let it return');
    expect(text(row)).toContain('a withhold publishes the lock evidence');
    expect(text(row)).toContain('Asked for a release');
    expect(within(row).getByRole('button', { name: 'Withhold deposit' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Release deposit' })).toBeTruthy();
    tick(m, 60);
    expect(text(within(rowsOf(held)[0] as HTMLElement).getAllByRole('cell')[2] as HTMLElement)).toBe('17m 01sthen it returns to the taker');

    const withheld = rowsOf(screen.getByRole('table', { name: 'Withheld deposits' }))[0] as HTMLElement;
    expect(text(within(withheld).getAllByRole('cell')[2] as HTMLElement)).toBe('47d 23hthen half to the taker, half to the treasury');
    expect(text(withheld)).toContain('0.898 SOL');
    // A withheld deposit can only be released.
    expect(within(withheld).queryByRole('button', { name: 'Withhold deposit' })).toBeNull();
    expect(within(withheld).getByRole('button', { name: 'Release deposit' })).toBeTruthy();
    expect(text(screen.getByRole('main'))).toContain('A withheld deposit can never go to you');
  });

  it('withholds only after spelling out the consequence, then moves the deposit to Withheld', async () => {
    const m = mount('#/deposits');
    const held = await screen.findByRole('table', { name: 'Held deposits' });
    await m.user.click(within(held).getByRole('button', { name: 'Withhold deposit' }));
    expect(text(within(held).getByRole('alertdialog'))).toBe(
      'Withhold deposit?Withhold 41.8 USDC. A withheld deposit never goes to you: you can only release it to the taker later, and after 60 days it is split between the taker and the treasury. Your withhold rate is public. A lock notice is on record, so the lock evidence is published with it.Withhold depositCancel',
    );
    await m.user.click(within(within(held).getByRole('alertdialog')).getByRole('button', { name: 'Withhold deposit' }));
    await waitFor(() => expect(rowsOf(screen.getByRole('table', { name: 'Withheld deposits' }))).toHaveLength(2));
    expect(screen.queryByRole('table', { name: 'Held deposits' })).toBeNull();
    expect(screen.getByText('No deposits are in their hold')).toBeTruthy();
    const s = await m.client.call('swap', { params: { ref: REF.held } });
    expect(s.state).toBe('WITHHELD');
    expect(s.evidence_published).toBe(true);
  });

  it('releases a held deposit, and a withheld one later', async () => {
    const m = mount('#/deposits');
    await confirm(m.user, await screen.findByRole('table', { name: 'Held deposits' }), 'Release deposit');
    await waitFor(async () => expect((await m.client.call('deposits')).deposits.map((d) => d.ref)).toEqual([REF.withheld]));
    await confirm(m.user, screen.getByRole('table', { name: 'Withheld deposits' }), 'Release deposit');
    await waitFor(async () => expect((await m.client.call('deposits')).deposits).toEqual([]));
    expect(await screen.findByText('No withheld deposits')).toBeTruthy();
    expect((await m.client.call('swap', { params: { ref: REF.withheld } })).outcome).toBe('releases');
  });

  it('reports a withhold the daemon refuses because the hold has ended', async () => {
    const m = mount('#/deposits');
    const held = await screen.findByRole('table', { name: 'Held deposits' });
    m.advance(19 * 60);
    await confirm(m.user, held, 'Withhold deposit');
    expect(await screen.findByText('The 30-minute hold has ended; a deposit can no longer be withheld.')).toBeTruthy();
    expect((await m.client.call('swap', { params: { ref: REF.held } })).state).toBe('HOLD');
  });
});

describe('inbox', () => {
  it('groups messages by swap', () => {
    const base = { direction: 'in' as const, transport: 'solana' as const, type: 'inbox', text: 'x', action: null, read: false, in_reply_to: null };
    const threads = groupThreads([
      { ...base, id: 'a', at: 10, swap_ref: 'S1', peer: 'P1' },
      { ...base, id: 'b', at: 30, swap_ref: null, peer: 'P2', read: true },
      { ...base, id: 'c', at: 20, swap_ref: 'S1', peer: 'P1' },
      { ...base, id: 'd', at: 5, swap_ref: null, peer: 'P3' },
    ]);
    expect(threads.map((t) => [t.key, t.items.length, t.unread])).toEqual([
      ['peer:P2', 1, 0],
      ['S1', 2, 2],
      ['peer:P3', 1, 1],
    ]);
  });

  it('shows a message beside the swap it refers to, with the matching action to hand', async () => {
    const m = mount(`#/inbox/${REF.withheld}`);
    const beside = await screen.findByRole('region', { name: 'The swap this is about' });
    await waitFor(() => expect(text(beside)).toContain('Deposit withheld'));
    expect(text(beside)).toContain('SOL · Sell XMR · Solana');
    expect(text(beside)).toContain('20 XMR for 44.9 SOL');
    expect(text(beside)).toContain('0.898 SOL Withheld');
    expect(text(beside)).toContain('60-day split in');
    expect(within(beside).getByRole('link', { name: 'Open the swap' }).getAttribute('href')).toBe(`#/swaps/${REF.withheld}`);

    const messages = screen.getByRole('region', { name: 'Messages' });
    expect(text(messages)).toContain('My tab crashed during the swap and I refunded late. Could you release the deposit? Thank you.');
    expect(text(messages)).toContain('The taker asks you to release the deposit.');
    await confirm(m.user, messages, 'Release deposit');
    await waitFor(async () => expect((await m.client.call('swap', { params: { ref: REF.withheld } })).state).toBe('DONE'));
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Messages' }))).toContain('Nothing is left to release on this swap.'));
    expect(within(screen.getByRole('region', { name: 'Messages' })).queryByRole('button', { name: 'Release deposit' })).toBeNull();
  });

  it('replies encrypted to the taker and marks the thread read', async () => {
    const m = mount('#/inbox');
    const list = await screen.findByRole('region', { name: 'Conversations' });
    expect(text(list)).toContain('2 unread');
    // The newest conversation is open first: the held deposit's.
    const messages = screen.getByRole('region', { name: 'Messages' });
    expect(text(messages)).toContain('Refunded by mistake, sorry.');
    const send = within(messages).getByRole('button', { name: 'Send reply' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await m.user.type(within(messages).getByLabelText('Reply'), 'It will go back when the hold ends.');
    expect(text(messages)).toContain('35 of 2000 characters');
    await m.user.click(send);
    await waitFor(async () => expect((await m.client.call('inbox')).items.filter((i) => i.direction === 'out')).toHaveLength(2));
    const reply = (await m.client.call('inbox')).items.find((i) => i.text === 'It will go back when the hold ends.');
    expect(reply).toMatchObject({ direction: 'out', swap_ref: REF.held, in_reply_to: 'msg-2', transport: 'tor' });
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Conversations' }))).toContain('1 unread'));
    expect(text(screen.getByRole('region', { name: 'Messages' }))).toContain('You · ');

    // Another conversation, about no swap.
    await m.user.click(within(screen.getByRole('region', { name: 'Conversations' })).getByRole('button', { name: /No swap/ }));
    expect(text(screen.getByRole('region', { name: 'Not about a swap' }))).toContain('The message names no swap.');
    expect(text(screen.getByRole('region', { name: 'Messages' }))).toContain('Do you quote above 200 XMR on request?');
  });

  it('shows new messages as they arrive and lets them be marked read', async () => {
    const m = mount('#/inbox');
    await screen.findByRole('region', { name: 'Conversations' });
    act(() => {
      m.daemon.receiveMessage({ transport: 'solana', type: 'inbox', swap_ref: REF.noticed, peer: fakeSol('taker-noticed'), text: 'Is my lock confirmed yet?', action: null });
    });
    const list = screen.getByRole('region', { name: 'Conversations' });
    await waitFor(() => expect(text(list)).toContain('Is my lock confirmed yet?'));
    expect(text(list)).toContain('3 unread');
    await m.user.click(within(list).getByRole('button', { name: /Is my lock confirmed yet/ }));
    await m.user.click(within(screen.getByRole('region', { name: 'Messages' })).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Conversations' }))).toContain('2 unread'));
  });

  it('has an empty state', async () => {
    mount('#/inbox', { empty: true });
    expect(await screen.findByText('No messages')).toBeTruthy();
  });
});

describe('swaps', () => {
  it('lists open swaps with state, next deadline and actions, and filters', async () => {
    const m = mount('#/swaps');
    const main = screen.getByRole('main');
    const table = await within(main).findByRole('table');
    expect(rowsOf(table)).toHaveLength(9);
    const noticed = within(table).getByRole('link', { name: `Swap ${REF.noticed}` }).closest('tr') as HTMLElement;
    expect(text(noticed)).toContain('XMR lock noticed');
    expect(text(noticed)).toContain('USDC-SOLSell XMR');
    expect(text(noticed)).toContain('2,092.68 USDCdeposit 41.85 USDC');
    expect(text(noticed)).toContain('Automatic refund cutoff for the taker');
    expect(within(noticed).getByRole('button', { name: 'Abort swap' })).toBeTruthy();
    const review = within(table).getByRole('link', { name: `Swap ${REF.review}` }).closest('tr') as HTMLElement;
    expect(text(review)).toContain('Needs review');

    await m.user.selectOptions(screen.getByLabelText('Chain'), 'ethereum');
    await waitFor(() => expect(rowsOf(within(main).getByRole('table'))).toHaveLength(2));
    await m.user.selectOptions(screen.getByLabelText('Show'), 'settled');
    await waitFor(() => expect(rowsOf(within(main).getByRole('table'))).toHaveLength(1));
    expect(text(rowsOf(within(main).getByRole('table'))[0] as HTMLElement)).toContain('taker refunds noticed');
    await m.user.selectOptions(screen.getByLabelText('State'), 'READY');
    expect(await within(main).findByText('No swaps match')).toBeTruthy();
  });

  it('has an empty state', async () => {
    mount('#/swaps', { empty: true });
    expect(await screen.findByText('No open swaps')).toBeTruthy();
  });

  it('shows one swap with its deadlines, deposit handling and messages beside it', async () => {
    const m = mount(`#/swaps/${REF.held}`);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(text(summary)).toContain('Deposit held');
    expect(text(summary)).toContain('USDC-SOL · Sell XMR · Solana');
    const deposit = screen.getByRole('region', { name: 'Deposit' });
    await waitFor(() => expect(text(deposit)).toContain('41.8 USDC Held'));
    expect(text(deposit)).toContain('Hold ends in18m 01s then it returns to the taker unless withheld');
    expect(text(deposit)).toContain('Your policy saysLet it return');
    expect(text(deposit)).toContain('Asked for a release');
    expect(within(deposit).getByRole('button', { name: 'Withhold deposit' })).toBeTruthy();

    const deadlines = within(screen.getByRole('region', { name: 'Deadlines' })).getByRole('table');
    const events = rowsOf(deadlines).map((r) => text(within(r).getAllByRole('cell')[0] as HTMLElement));
    expect(events).toEqual(['LockedThe taker’s lock (or take) landed', 'Approved / active', 'Lock notice posted', 'Refunded', 'Deposit hold ends30 minutes after the refund', 'Final deadline', 'Expiry30 days after the final deadline']);
    expect(text(within(rowsOf(deadlines)[3] as HTMLElement).getAllByRole('cell')[2] as HTMLElement)).toBe('passed');
    expect(text(within(rowsOf(deadlines)[4] as HTMLElement).getAllByRole('cell')[2] as HTMLElement)).toBe('18m 01s');

    const messages = screen.getByRole('region', { name: 'Messages' });
    expect(text(messages)).toContain('Refunded by mistake, sorry. Please let the deposit go back.');
    expect(text(messages)).toContain('The taker asks you to release the deposit.');
    await confirm(m.user, deposit, 'Release deposit');
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Summary' }))).toContain('Done'));
    expect((await m.client.call('deposits')).deposits.map((d) => d.ref)).toEqual([REF.withheld]);
  });

  it('flags a swap parked for review and offers the evidence publisher', async () => {
    const m = mount(`#/swaps/${REF.review}`);
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('Parked for you to review. post_notice: the transaction was sent but its receipt is ambiguous; it will not be re-sent');
    const summary = screen.getByRole('region', { name: 'Summary' });
    await m.user.click(within(summary).getByRole('button', { name: 'Publish evidence' }));
    expect(text(within(summary).getByRole('alertdialog'))).toContain('Publish the joint view key and the lock transaction id, so anyone can verify your XMR lock and attribute the abort correctly.');
    await m.user.click(within(within(summary).getByRole('alertdialog')).getByRole('button', { name: 'Publish evidence' }));
    await waitFor(async () => expect((await m.client.call('swap', { params: { ref: REF.review } })).evidence_published).toBe(true));
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Monero lock' }))).toContain('Published: anyone can verify the lock'));
    expect(text(screen.getByRole('region', { name: 'Daemon steps' }))).toContain('post noticeneeds review');
  });

  it('says so when the swap is unknown', async () => {
    mount('#/swaps/does-not-exist');
    expect(text(await screen.findByRole('alert'))).toContain('Could not load this swap. No swap does-not-exist.');
  });
});

describe('inventory', () => {
  it('shows the ladder, capacity in unlocked outputs, paying balances and the split', async () => {
    const m = mount('#/inventory');
    await screen.findByText('Capacity (unlocked outputs)');
    expect(stat('Capacity (unlocked outputs)')).toBe('Capacity (unlocked outputs)215.86 XMRwhat offers can fill right now');
    expect(text(screen.getByRole('main'))).toContain('Capacity counts unlocked outputs, never the balance.');
    expect(rowsOf(screen.getByRole('table', { name: 'Output ladder' })).map(text)).toEqual(['5 XMR201550', '50 XMR6411']);
    expect(rowsOf(screen.getByRole('table', { name: 'Paying balances' })).map(text)).toEqual([
      'SOL412.6 SOL300 SOL0 SOL',
      'ETH3.2 ETHno cap0 ETH',
      'USDC (Solana)96,420.55 USDC60,000 USDC4,082.27 USDC',
      'USDC (Ethereum)18,300 USDCno cap0 USDC',
    ]);
    expect(rowsOf(screen.getByRole('table', { name: 'Outputs' }))).toHaveLength(25);
    const ladder = screen.getByRole('region', { name: 'Output ladder' });
    await m.user.click(within(ladder).getByRole('button', { name: 'Split to the ladder' }));
    expect(text(within(ladder).getByRole('alertdialog'))).toContain('Split unlocked XMR into the one output the ladder is missing');
    await m.user.click(within(within(ladder).getByRole('alertdialog')).getByRole('button', { name: 'Split to the ladder' }));
    expect(await screen.findByText('Created 1 output in 1 transaction, spendable after 10 blocks.')).toBeTruthy();
  });
});

describe('rebalancing', () => {
  it('shows mode, in-transit total against the cap, levels and venues with their modes', async () => {
    mount('#/rebalancing');
    await screen.findByTestId('in-transit');
    expect(stat('Mode')).toBe('ModeApprove each refillvenues may override it');
    // 8,000 USDC processing at ChangeNOW + 60 SOL held at FixedFloat.
    expect(text(screen.getByTestId('in-transit').closest('.stat'))).toContain('$19,245of a $50,000 cap');
    expect(screen.getByRole('meter', { name: 'In-transit value against the cap' }).getAttribute('aria-valuemax')).toBe('50000');
    expect(rowsOf(screen.getByRole('table', { name: 'Levels' })).map(text)).toEqual([
      'XMR351.4150400700Within levels',
      'SOL412.6unsetunsetunsetNo levels set',
      'ETH3.2unsetunsetunsetNo levels set',
      'USDC (Solana)96,420.55unsetunset120,000Within levels',
      'USDC (Ethereum)18,300unsetunsetunsetNo levels set',
    ]);
    const venues = rowsOf(screen.getByRole('table', { name: 'Venues' })).map(text);
    expect(venues.slice(0, 6)).toEqual([
      'wXMR bridgeEnabledApprove each refillHealthy',
      'ExchangeEnabledApprove each refillUnavailableThe exchange is not named yet',
      'ChangeNOWEnabledApprove each refillHealthy',
      expect.stringMatching(/^FixedFloatEnabledApprove each refillUnavailableAn order is held in its emergency statecooling down for 14m 00s$/),
      'StealthEXOffn/an/a',
      'HoudiniSwapOffn/an/a',
    ]);
    expect(venues[6]).toContain('Opposite-side flow');
    const transit = rowsOf(screen.getByRole('table', { name: 'Refills in transit' }));
    expect(transit.map((r) => text(within(r).getAllByRole('cell')[7] as HTMLElement))).toEqual([
      'ProcessingDeposit received by the service; payout pending.',
      expect.stringContaining('Held by the venue'),
    ]);
  });

  it('approves a pending refill only after stating where the funds go', async () => {
    const m = mount('#/rebalancing');
    const waiting = await screen.findByRole('table', { name: 'Refills awaiting approval' });
    expect(text(rowsOf(waiting)[0] as HTMLElement)).toContain('wXMR bridgeUSDC → XMR12,400 USDCpending0.82%$101.70Awaiting approval');
    await m.user.click(within(waiting).getByRole('button', { name: 'Approve refill' }));
    expect(text(within(waiting).getByRole('alertdialog'))).toContain('Send 12,400 USDC through wXMR bridge for XMR. While it is on its way the venue holds the funds and it counts against the in-transit cap. The payout goes only to an allow-listed address of yours.');
    await m.user.click(within(within(waiting).getByRole('alertdialog')).getByRole('button', { name: 'Approve refill' }));
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Refills awaiting approval' })).toBeNull());
    expect(screen.getByText('No refills are waiting')).toBeTruthy();
    expect((await m.client.call('rebalance')).refills.find((r) => r.id === 'refill-31')?.state).toBe('pending');
    await waitFor(() => expect(text(screen.getByTestId('in-transit'))).toBe('$31,645'));
  });

  it('declines a refill, and reports one the in-transit cap refuses', async () => {
    const m = mount('#/rebalancing');
    const waiting = await screen.findByRole('table', { name: 'Refills awaiting approval' });
    await m.user.click(within(waiting).getByRole('button', { name: 'Decline' }));
    await waitFor(async () => expect((await m.client.call('rebalance')).refills.find((r) => r.id === 'refill-31')?.state).toBe('cancelled'));

    // A manual run of 40,000 USDC would exceed the 50,000 cap once approved.
    const form = screen.getByRole('region', { name: 'Manual run or record' });
    await m.user.type(within(form).getByLabelText('Amount in (USDC)'), '40000');
    await m.user.selectOptions(within(form).getByLabelText('Venue'), 'wxmr_bridge');
    await m.user.click(within(form).getByRole('button', { name: 'Run refill' }));
    const again = await screen.findByRole('table', { name: 'Refills awaiting approval' });
    await m.user.click(within(again).getByRole('button', { name: 'Approve refill' }));
    await m.user.click(within(within(again).getByRole('alertdialog')).getByRole('button', { name: 'Approve refill' }));
    expect(await screen.findByText('This refill would put $59,245 in transit, above the cap of $50,000.')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Refills awaiting approval' })).getAllByRole('row')).toHaveLength(2);
  });

  it('keeps a cost log and records a manual refill', async () => {
    const m = mount('#/rebalancing');
    const log = await screen.findByRole('table', { name: 'Refill history' });
    expect(rowsOf(log)).toHaveLength(2);
    expect(text(rowsOf(log)[0] as HTMLElement)).toContain('wXMR bridgeUSDC → XMR20,000 USDC48.11 XMR0.79%$158.20Donetook 1h 00m');
    expect(text(screen.getByRole('region', { name: 'Cost log' }))).toContain('Completed refills averaged 0.60% against the reference and paid $175.00 in fees');

    const form = screen.getByRole('region', { name: 'Manual run or record' });
    await m.user.click(within(form).getByLabelText('Record a refill done elsewhere'));
    await m.user.click(within(form).getByRole('button', { name: 'Record refill' }));
    expect(text(within(form).getByRole('alert'))).toContain('Enter amounts as plain decimals');
    await m.user.type(within(form).getByLabelText('Amount in (USDC)'), '4100');
    await m.user.type(within(form).getByLabelText('Amount received (XMR)'), '9.9');
    await m.user.type(within(form).getByLabelText('Note'), 'OTC desk');
    await m.user.click(within(form).getByRole('button', { name: 'Record refill' }));
    await waitFor(() => expect(rowsOf(screen.getByRole('table', { name: 'Refill history' }))).toHaveLength(3));
    const newest = (await m.client.call('rebalance')).refills[0];
    expect(newest).toMatchObject({ venue: 'manual', from: 'usdc_sol', to: 'xmr', amount_in: '4100000000', amount_out: '9900000000000', detail: 'OTC desk', state: 'done' });
  });

  it('shows the allow-list: the daemon defaults, or the addresses in the configuration', async () => {
    const m = mount('#/rebalancing');
    const card = await screen.findByRole('region', { name: 'Address allow-list' });
    expect(text(card)).toContain('the daemon allows only its defaults: the inventory wallet and your operator and payout addresses. A payout to any other address is refused.');
    const toml = `${(await m.client.call('configGet')).toml}\n[rebalance.allowlist]\nxmr = ["4OwnInventoryAddressExample"]\n`;
    await m.client.call('configImport', { body: { toml } });
    window.location.hash = '#/status';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    window.location.hash = '#/rebalancing';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    const again = await screen.findByRole('region', { name: 'Address allow-list' });
    await waitFor(() => expect(text(again)).toContain('XMR4OwnInventoryAddressExample'));
    expect(text(again)).toContain('SOLdaemon default');
  });

  it('warns when no in-transit cap is set and explains alert-only mode', async () => {
    mount('#/rebalancing', { toml: '[rebalance]\nmode = "alert"\n', empty: true });
    await screen.findByText('No in-transit cap.');
    expect(screen.getAllByRole('note').map(text).join(' ')).toContain('No in-transit cap. Nothing bounds the value sitting with third parties at once.');
    expect(screen.getByText('In alert-only mode the rebalancer raises alerts and moves nothing by itself.')).toBeTruthy();
    expect(screen.getByText('Nothing is in transit')).toBeTruthy();
    expect(screen.getByText('No refills yet')).toBeTruthy();
  });
});

describe('keys', () => {
  it('names the state of every key version, including retired keys in their grace period', async () => {
    mount('#/keys');
    const table = await screen.findByRole('table', { name: 'Encryption key versions' });
    const state = rowsOf(table).map((r) => text(within(r).getAllByRole('cell')[1] as HTMLElement));
    expect(state).toEqual([
      'CurrentNew messages are encrypted to this key.',
      'Retired, in graceKept for another 5h 00m so messages sent around the rotation still open; 1 open swap still needs it.',
      'Retired, kept for open swapsIts grace period has passed, but 1 swap opened under it is still open. It is deleted when the last one closes.',
      expect.stringMatching(/^DeletedPrivate key deleted \d{4}-/),
    ]);
  });
  it('derives the grace state from expiry and open swaps', () => {
    const k = { version: 1, public_key: 'aa', current: false, expires_at: 100, open_swaps: 0, deleted_at: null };
    expect(keyState({ ...k, current: true, expires_at: null }, 50).label).toBe('Current');
    expect(keyState(k, 50).label).toBe('Retired, in grace');
    expect(keyState({ ...k, open_swaps: 2 }, 150).label).toBe('Retired, kept for open swaps');
    expect(keyState(k, 150).label).toBe('Retired, due for deletion');
    expect(keyState({ ...k, deleted_at: 160 }, 200).label).toBe('Deleted');
  });

  it('shows the schedule with the time to the next rotation and saves a new one', async () => {
    const m = mount('#/keys');
    await screen.findByText('Schedule');
    expect(stat('Schedule')).toBe('ScheduleEvery 168 hours');
    expect(stat('Next rotation')).toContain('5d 18h');
    expect(stat('Grace period')).toContain('24 hours');

    const card = screen.getByRole('region', { name: 'Rotation schedule' });
    const save = within(card).getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await m.user.clear(within(card).getByLabelText('Rotate every (hours)'));
    await m.user.type(within(card).getByLabelText('Rotate every (hours)'), '24');
    await m.user.clear(within(card).getByLabelText('Keep a retired key for (hours)'));
    await m.user.type(within(card).getByLabelText('Keep a retired key for (hours)'), '48');
    await m.user.click(save);
    await waitFor(() => expect(stat('Schedule')).toBe('ScheduleEvery 24 hours'));
    const cfg = parseToml((await m.client.call('configGet')).toml);
    expect(getPath(cfg, 'rotation')).toEqual({ interval_hours: 24, grace_hours: 48 });
    expect((await m.client.call('configLog')).entries[0]?.changes.map((c) => c.path)).toEqual(['rotation.grace_hours', 'rotation.interval_hours']);
    // 0 switches the schedule off: rotation only on demand.
    await m.user.clear(within(card).getByLabelText('Rotate every (hours)'));
    await m.user.type(within(card).getByLabelText('Rotate every (hours)'), '0');
    await m.user.click(within(card).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(stat('Schedule')).toBe('ScheduleOn demand only'));
    expect(stat('Next rotation')).toContain('not scheduled');
  });

  it('rotates on demand and keeps the previous key in grace', async () => {
    const m = mount('#/keys');
    const card = await screen.findByRole('region', { name: 'Rotate on demand' });
    await m.user.click(within(card).getByRole('button', { name: 'Rotate now' }));
    expect(text(within(card).getByRole('alertdialog'))).toContain('nothing in flight is interrupted');
    await m.user.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Rotate now' }));
    expect(await screen.findByText('Rotated to version 8. The previous key stays usable through its grace period.')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Encryption key versions' });
    await waitFor(() => expect(rowsOf(table)).toHaveLength(5));
    expect(text(rowsOf(table)[0] as HTMLElement)).toContain('8');
    expect(text(within(rowsOf(table)[0] as HTMLElement).getAllByRole('cell')[1] as HTMLElement)).toContain('Current');
    expect(text(within(rowsOf(table)[1] as HTMLElement).getAllByRole('cell')[1] as HTMLElement)).toContain('Retired, in graceKept for another 1d 0h so messages sent around the rotation still open');
    expect((await m.client.call('keys')).keys[0]?.version).toBe(8);
  });

  it('reports a rotation refused in dry run', async () => {
    const m = mount('#/keys', { toml: DESIGN_BOTH_TOML });
    const card = await screen.findByRole('region', { name: 'Rotate on demand' });
    await confirm(m.user, card, 'Rotate now');
    expect(await screen.findByText('Dry run: the key rotation was not sent. Switch the daemon to live mode to send transactions.')).toBeTruthy();
    expect((await m.client.call('keys')).keys[0]?.version).toBe(7);
  });
});

describe('status', () => {
  it('shows chain connections, Monero node agreement, Tor and the daemon version', async () => {
    mount('#/status');
    const chains = await screen.findByRole('table', { name: 'Chain connections' });
    const rows = rowsOf(chains).map(text);
    expect(rows[0]).toContain('SolanaConnectedprimary (SOLANA_RPC_URL)');
    expect(rows[0]).toContain('matches the configuration');
    expect(rows[0]).toContain('local clock ahead by 1 s');
    expect(rows[1]).toContain('EthereumConnectedprimary (ETH_RPC_URL)');
    expect(rows[1]).toContain('finalized blocks');
    expect(text(screen.getByRole('region', { name: 'Monero' }))).toContain('Nodes agree');
    expect(rowsOf(screen.getByRole('table', { name: 'Monero nodes' }))).toHaveLength(2);
    expect(text(screen.getByRole('region', { name: 'Tor and identity' }))).toContain('off: on-chain messaging only');
    expect(stat('Daemon')).toBe('Daemon0.1.0-mockcore 0.1.0');
    expect(stat('Mode')).toBe('ModeLivetransactions are sent');
    expect(stat('Quoting')).toBe('QuotingRunningno pause in effect');
  });
});
