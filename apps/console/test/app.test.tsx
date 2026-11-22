import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Root, parseRoute } from '../src/App.js';
import { MOCK_TOKEN, MockDaemon } from '../src/mock/daemon.js';
import { fakeSol } from '../src/mock/fixtures.js';
import { mockFetch, mockSockets } from '../src/mock/transport.js';
import { DESIGN_BOTH_TOML } from './design.js';
import { mount, text } from './harness.js';

const PAGES = ['Dashboard', 'Swaps', 'Approvals', 'Deposits', 'Inbox', 'Offers', 'Inventory', 'Rebalancing', 'Configuration', 'Registration', 'Keys', 'Status'];

describe('shell', () => {
  it('lists the twelve pages of SPEC 8.1 and marks the current one', async () => {
    const { user } = mount();
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent?.replace(/\d.*$/, ''))).toEqual(PAGES);
    expect(within(nav).getByRole('link', { name: /^Dashboard/ }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy();
    await user.click(within(nav).getByRole('link', { name: /^Keys/ }));
    await act(async () => {
      window.location.hash = '#/keys';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Keys' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /^Keys/ }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: /^Dashboard/ }).getAttribute('aria-current')).toBeNull();
  });

  it('routes by hash, falling back to the dashboard', () => {
    expect(parseRoute('#/offers')).toEqual({ page: 'offers', arg: undefined });
    expect(parseRoute('#/swaps/0xabc')).toEqual({ page: 'swaps', arg: '0xabc' });
    expect(parseRoute('#/nonsense')).toEqual({ page: 'dashboard', arg: undefined });
    expect(parseRoute('')).toEqual({ page: 'dashboard', arg: undefined });
  });

  it('shows what is waiting beside the page names', async () => {
    mount();
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    await waitFor(() => expect(text(within(nav).getByRole('link', { name: /^Approvals/ }))).toBe('Approvals3 (3 waiting for approval)'));
    expect(text(within(nav).getByRole('link', { name: /^Deposits/ }))).toBe('Deposits1 (1 in the 30-minute hold)');
    expect(text(within(nav).getByRole('link', { name: /^Inbox/ }))).toBe('Inbox2 (2 unread)');
    expect(text(within(nav).getByRole('link', { name: /^Swaps/ }))).toBe('Swaps1 (1 parked for review)');
  });

  it('updates live when the daemon pushes, without a reload', async () => {
    const { daemon } = mount();
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    await waitFor(() => expect(text(within(nav).getByRole('link', { name: /^Inbox/ }))).toContain('2 unread'));
    expect(text(screen.getByRole('status', { name: 'Connection to the daemon' }))).toBe('Daemon: live');
    act(() => {
      daemon.receiveMessage({ transport: 'tor', type: 'inbox', swap_ref: null, peer: fakeSol('someone'), text: 'Hello', action: null });
    });
    await waitFor(() => expect(text(within(nav).getByRole('link', { name: /^Inbox/ }))).toContain('3 unread'));
  });

  it('says so when the push channel is down and keeps working over HTTP', async () => {
    mount('#/status', { noSocket: true });
    await waitFor(() => expect(text(screen.getByRole('status', { name: 'Connection to the daemon' }))).toBe('Daemon: no live link'));
    expect(await screen.findByText('push channel down; re-reading every 15 s')).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Chain connections' })).toBeTruthy();
  });

  it('shows a loading state, then the data', async () => {
    mount('', { delayMs: 30 });
    expect(screen.getByRole('status', { name: 'Loading the statistics' })).toBeTruthy();
    expect(await screen.findByText('Spread earned')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading the statistics' })).toBeNull();
  });

  it('shows an error with a way to retry, and recovers', async () => {
    const { daemon, user } = mount('#/inventory', { empty: true });
    await screen.findByRole('heading', { level: 1, name: 'Inventory' });
    await screen.findByText('Capacity (unlocked outputs)');
    daemon.failNext = 'wallet-rpc is not answering';
    window.location.hash = '#/keys';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('Could not load the keys.');
    expect(text(alert)).toContain('wallet-rpc is not answering');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Encryption key versions' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says plainly when the daemon cannot be reached', async () => {
    mount('', { offline: () => true, noSocket: true });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map(text).join(' ')).toContain('No answer from the daemon. The daemon cannot be reached.');
  });

  it('pauses and resumes from the top bar, with the consequence spelled out first', async () => {
    const { daemon, user, client } = mount();
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    const dialog = screen.getByRole('alertdialog');
    expect(text(dialog)).toContain('Stop quoting on both chains now. Swaps that are already open keep running to their end.');
    // The confirmation takes focus; Escape backs out without pausing.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Pause' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await client.call('status')).paused.operator).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect((await client.call('status')).paused.operator).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByRole('button', { name: 'Pause' });
    expect(daemon.handle({ method: 'GET', path: '/api/status', authorization: `Bearer ${MOCK_TOKEN}` }).body).toMatchObject({ paused: { operator: false } });
  });

  it('can pause and revoke everything by bumping the epochs', async () => {
    const { user, client } = mount();
    await user.click(await screen.findByRole('button', { name: 'Pause and revoke' }));
    expect(text(screen.getByRole('alertdialog'))).toContain('kills every outstanding advance approval and signed quote');
    await user.click(screen.getByRole('button', { name: 'Pause and revoke all' }));
    await screen.findByRole('button', { name: 'Resume' });
    expect((await client.call('approvals')).epochs.map((e) => e.approval_epoch)).toEqual([3, 3]);
  });

  it('marks dry run on every page', async () => {
    mount('#/offers', { toml: DESIGN_BOTH_TOML });
    const note = await screen.findByText('Dry run.');
    expect(text(note.parentElement)).toContain('sends no transaction and moves no XMR');
    expect(text(screen.getByRole('banner'))).toContain('Dry run');
  });

  it('switches between light, dark and the system setting', async () => {
    const { user } = mount();
    const select = screen.getByLabelText('Theme');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await user.selectOptions(select, 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.selectOptions(select, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('maker-console.theme')).toBe('dark');
    await user.selectOptions(select, 'system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('is reachable by keyboard: skip link first, then the controls in order', async () => {
    const { user } = mount();
    await screen.findByRole('button', { name: 'Pause' });
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Skip to the page');
    expect(document.activeElement?.getAttribute('href')).toBe('#main');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

describe('contract upgrade status', () => {
  it('states in the top bar and on the Status page that the contracts are still upgradable', async () => {
    mount('#/status');
    const badge = await screen.findByTestId('upgrade-badge');
    expect(text(badge)).toBe('Contracts are still upgradable');
    expect(badge.getAttribute('href')).toBe('#/status');
    const statement = await screen.findByTestId('upgrade-statement');
    expect(text(statement)).toBe('The contracts are still upgradable. Whoever holds the upgrade key can change the rules, so you and your takers are trusting them not to.');
    const table = within(screen.getByRole('region', { name: 'Contract upgrade status' })).getByRole('table');
    expect(within(table).getAllByText('Yes, still upgradable')).toHaveLength(2);
  });
  it('says frozen only when both are frozen', async () => {
    mount('#/status', { upgradeable: { solana: false, ethereum: false } });
    expect(text(await screen.findByTestId('upgrade-badge'))).toBe('Contracts are frozen');
    expect(text(await screen.findByTestId('upgrade-statement'))).toContain('nobody can change the rules');
    expect(screen.getAllByText('No, immutable')).toHaveLength(2);
    // Nothing to warn about: no strip.
    expect(screen.queryByTestId('upgrade-strip')).toBeNull();
  });
  it('names the chain when only one is still upgradable', async () => {
    mount('#/status', { upgradeable: { solana: false, ethereum: true } });
    expect(text(await screen.findByTestId('upgrade-badge'))).toBe('Ethereum contract is still upgradable');
    expect(text(await screen.findByTestId('upgrade-statement'))).toContain('The Ethereum contract is still upgradable.');
  });
  it('does not claim frozen when the status is unknown', async () => {
    mount('#/status', { upgradeable: { solana: null, ethereum: false } });
    expect(text(await screen.findByTestId('upgrade-badge'))).toBe('Upgrade status unknown');
    expect(text(await screen.findByTestId('upgrade-statement'))).toContain('Treat it as upgradable until this shows otherwise.');
  });
});

describe('connecting', () => {
  it('asks for the access token, refuses a wrong one and connects with the right one', async () => {
    const daemon = new MockDaemon();
    const sockets = mockSockets(daemon);
    const user = userEvent.setup();
    render(<Root fetch={mockFetch(daemon)} socket={sockets.factory} />);
    expect(screen.getByRole('heading', { name: 'Connect to your daemon' })).toBeTruthy();
    expect(screen.getByText(/It holds no key and cannot move funds by itself/)).toBeTruthy();
    const input = screen.getByLabelText('Access token');
    expect(input.getAttribute('type')).toBe('password');
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(input, 'not-the-token');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(text(await screen.findByRole('alert'))).toContain('The daemon refused that token.');
    expect(window.sessionStorage.getItem('maker-console.token')).toBeNull();

    await user.type(screen.getByLabelText('Access token'), MOCK_TOKEN);
    fireEvent.submit(screen.getByLabelText('Access token').closest('form') as HTMLFormElement);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy();
    expect(window.sessionStorage.getItem('maker-console.token')).toBe(MOCK_TOKEN);
    // Never kept beyond the tab.
    expect(window.localStorage.getItem('maker-console.token')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('heading', { name: 'Connect to your daemon' })).toBeTruthy();
    expect(window.sessionStorage.getItem('maker-console.token')).toBeNull();
  });
});
