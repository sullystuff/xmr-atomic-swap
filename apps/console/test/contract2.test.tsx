/** The daemon's answers to the console's requests (packages/daemon/DEVIATIONS.md A11 to A16). */
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiFailure, DaemonClient } from '../src/api/client.js';
import { REFUSAL_REASONS } from '../src/api/extensions.js';
import { MOCK_TOKEN, MockDaemon, REFUSALS } from '../src/mock/daemon.js';
import { ADDR, REF } from '../src/mock/fixtures.js';
import { mockFetch } from '../src/mock/transport.js';
import { REFUSAL_TEXT, upgradeLine, upgradeStateOf, upgradeSummary } from '../src/ui/domain.js';
import { DESIGN_BOTH_TOML } from './design.js';
import { T0, mount, text } from './harness.js';

function setup(opts: ConstructorParameters<typeof MockDaemon>[0] = {}) {
  const daemon = new MockDaemon({ now: () => T0, ...opts });
  return { daemon, client: new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon) }) };
}
const SIGNED_ETH = `0x02${'ab'.repeat(110)}`;

describe('refusal reasons (A16)', () => {
  it('is exactly the daemon’s documented list (A16’s ten and the three freeze reasons of A26), each with plain words', () => {
    const documented = ['ready-already-set', 'refund-window-closed', 'abort-window-closed', 'already-settled', 'cannot-exit-after-funding', 'reject-not-available', 'hold-ended', 'no-deposit-held', 'not-available-in-state', 'dry-run', 'freeze-not-available', 'freeze-window-closed', 'already-frozen'];
    expect([...REFUSAL_REASONS].sort()).toEqual([...documented].sort());
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual([...documented].sort());
    // Every reason the daemon has its own sentence for is in the list.
    for (const r of Object.keys(REFUSALS)) expect(documented).toContain(r);
  });
});

describe('upgrade status (A11)', () => {
  it('reads each chain’s state, authority, reason and check time from the daemon', async () => {
    const { client } = setup({ upgradeable: { solana: true, ethereum: null } });
    const [sol, eth] = (await client.call('status')).chains;
    expect(sol).toMatchObject({ upgrade_status: 'upgradable', upgrade_authority: ADDR.upgradeAuthoritySol, upgrade_reason: null, upgrade_checked_at: T0 - 20 });
    expect(eth).toMatchObject({ upgrade_status: 'unknown', upgrade_authority: null, upgrade_implementation: null });
    expect(eth?.upgrade_reason).toBe('the RPC endpoint did not answer the upgrade-authority read');
  });

  it('puts each chain in words', () => {
    const base = { chain: 'solana' as const, connected: true, endpoint: 'x', network: 'n', network_ok: true, chain_time: 1, clock_skew_secs: 0, contract: 'Prog', upgradeable: true, upgrade_authority: 'AuthKey' };
    expect(upgradeLine({ ...base, upgrade_status: 'upgradable', upgrade_checked_at: 0 })).toBe('Solana: the program is upgradable by AuthKey.');
    expect(upgradeLine({ ...base, chain: 'ethereum', upgrade_status: 'upgradable', upgrade_pending_authority: '0xNext' })).toBe('Ethereum: the contract is upgradable by AuthKey. A transfer of that authority to 0xNext is waiting to be accepted.');
    expect(upgradeLine({ ...base, upgradeable: false, upgrade_authority: null, upgrade_status: 'immutable', upgrade_checked_at: 1_795_000_000 })).toBe('Solana: the program is immutable; no upgrade authority exists. Last checked 2026-11-18 11:06:40Z.');
    expect(upgradeLine({ ...base, upgradeable: null, upgrade_authority: null, upgrade_status: 'unknown', upgrade_reason: 'the node timed out' })).toBe('Solana: unknown, because the node timed out. Treat it as upgradable until this shows otherwise.');
    // The daemon's status wins over the older boolean; without it the boolean is used.
    expect(upgradeStateOf({ ...base, upgradeable: null, upgrade_status: 'immutable' })).toBe('immutable');
    expect(upgradeStateOf({ ...base, upgradeable: false })).toBe('immutable');
    expect(upgradeStateOf({ ...base, upgradeable: null })).toBe('unknown');
    expect(upgradeSummary([]).short).toBe('Upgrade status unknown');
  });

  it('cannot be missed while upgradable: top bar per chain, a strip on every page, and Status', async () => {
    const m = mount('#/inventory');
    const chains = await screen.findByTestId('upgrade-chains');
    expect(text(chains)).toBe('Solana: upgradableEthereum: upgradable');
    const strip = screen.getByTestId('upgrade-strip');
    expect(strip.getAttribute('role')).toBe('note');
    expect(text(strip)).toContain('Contracts are still upgradable.');
    expect(text(strip)).toContain(`Solana: the program is upgradable by ${ADDR.upgradeAuthoritySol}.`);
    expect(text(strip)).toContain(`Ethereum: the contract is upgradable by ${ADDR.upgradeAuthorityEth}.`);
    expect(within(strip).getByRole('link', { name: 'Details on Status' }).getAttribute('href')).toBe('#/status');
    // It is on the other pages too.
    for (const page of ['#/config', '#/approvals', '#/status']) {
      window.location.hash = page;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await waitFor(() => expect(screen.getByTestId('upgrade-strip')).toBeTruthy());
    }
    const table = await screen.findByRole('table', { name: 'Upgrade status by chain' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-upgrade'))).toEqual(['upgradable', 'upgradable']);
    expect(text(rows[0] as HTMLElement)).toContain(`Yes, still upgradable${ADDR.upgradeAuthoritySol}`);
    expect(text(rows[0] as HTMLElement)).toContain('ProgramData account20s ago');
    expect(text(rows[1] as HTMLElement)).toContain('behind the proxy');
    void m;
  });

  it('shows a waiting transfer of the Ethereum upgrade authority', async () => {
    mount('#/status', { prepare: (d) => (d.pendingUpgradeAuthority = '0x00000000000000000000000000000000000000dd') });
    const table = await screen.findByRole('table', { name: 'Upgrade status by chain' });
    expect(text(within(table).getAllByRole('row')[2] as HTMLElement)).toContain('Transfer waiting: to 0x00000000000000000000000000000000000000dd');
    expect(text(screen.getByTestId('upgrade-strip'))).toContain('A transfer of that authority to 0x00000000000000000000000000000000000000dd is waiting to be accepted.');
  });

  it('says immutable per chain, and keeps warning about the one that is not', async () => {
    mount('#/status', { upgradeable: { solana: false, ethereum: true } });
    expect(text(await screen.findByTestId('upgrade-chains'))).toBe('Solana: immutableEthereum: upgradable');
    const strip = screen.getByTestId('upgrade-strip');
    expect(text(strip)).toContain('Solana: the program is immutable; no upgrade authority exists.');
    expect(text(strip)).toContain('Ethereum: the contract is upgradable by');
    const rows = within(screen.getByRole('table', { name: 'Upgrade status by chain' })).getAllByRole('row').slice(1);
    expect(text(rows[0] as HTMLElement)).toContain('No, immutablenone: revoked');
  });

  it('says unknown with the reason and when it was last checked, never "immutable"', async () => {
    mount('#/status', { upgradeable: { solana: null, ethereum: false } });
    expect(text(await screen.findByTestId('upgrade-chains'))).toBe('Solana: unknownEthereum: immutable');
    const strip = screen.getByTestId('upgrade-strip');
    expect(strip.className).toContain('info');
    expect(text(strip)).toContain('Solana: unknown, because the RPC endpoint did not answer the upgrade-authority read. Treat it as upgradable until this shows otherwise. Last checked 2026-11-18 11:06:20Z.');
    const row = within(screen.getByRole('table', { name: 'Upgrade status by chain' })).getAllByRole('row')[1] as HTMLElement;
    expect(row.getAttribute('data-upgrade')).toBe('unknown');
    expect(text(row)).toContain('Unknownthe RPC endpoint did not answer the upgrade-authority read; treat it as upgradable');
    expect(text(row)).toContain('20s ago');
  });
});

describe('Tor (A12)', () => {
  const onion = `${'c'.repeat(56)}.onion`;
  it('reports what the registry shows, and never claims reachability', async () => {
    const { client } = setup();
    expect((await client.call('status')).tor).toEqual({ enabled: false, onion: null, published: false, reachable: null, registry_onion: null });
    await client.publishRegistration({ onion });
    expect((await client.call('status')).tor).toMatchObject({ onion, published: true, reachable: null, registry_onion: onion });
  });
  it('shows "not checked by the daemon", not "off" or "not reachable"', async () => {
    const m = mount('#/status');
    expect(text(await screen.findByTestId('tor-onion'))).toBe('none wanted');
    // Published from elsewhere: the daemon pushes the new status.
    await m.client.publishRegistration({ onion });
    await waitFor(() => expect(text(screen.getByTestId('tor-onion'))).toBe(`${onion} Published in the registry`));
    expect(text(screen.getByTestId('tor-reachable'))).toBe('Not checked by the daemon: it runs no Tor client of its own. Test the address from another machine.');
    expect(screen.queryByText('Not reachable')).toBeNull();
  });
});

describe('refills (A13, A15)', () => {
  it('flags the refills that need the maker and the ones already acknowledged', async () => {
    const { client, daemon } = setup();
    const flags = async () => Object.fromEntries((await client.call('rebalance')).refills.map((r) => [r.id, [r.needs_acknowledgement, r.acknowledged]]));
    expect(await flags()).toMatchObject({ 'refill-29': [true, false], 'refill-30': [false, false], 'refill-28': [false, false] });
    daemon.failRefill('refill-30', 'the venue returned an error');
    expect((await flags())['refill-30']).toEqual([true, false]);
    expect(await client.acknowledgeRefill('refill-30')).toMatchObject({ needs_acknowledgement: false, acknowledged: true });
    expect((await flags())['refill-30']).toEqual([false, true]);
  });

  it('offers Acknowledge only while the daemon says it is needed, then files the refill under history', async () => {
    const m = mount('#/rebalancing', { prepare: (d) => d.failRefill('refill-30', 'the venue returned an error') });
    const transit = await screen.findByRole('table', { name: 'Refills in transit' });
    const row = within(transit).getByText('refill-30').closest('tr') as HTMLElement;
    expect(text(row)).toContain('FailedNeeds you');
    await m.user.click(within(row).getByRole('button', { name: 'Acknowledge' }));
    await m.user.click(within(within(row).getByRole('alertdialog')).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Refills in transit' })).queryByText('refill-30')).toBeNull());
    const done = within(screen.getByRole('table', { name: 'Refill history' })).getByText('refill-30').closest('tr') as HTMLElement;
    expect(text(done)).toContain('FailedAcknowledged');
    expect(within(done).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('says held wXMR needs manual action, since the daemon has no route to redeem it', async () => {
    mount('#/rebalancing', {
      prepare: (d) => d.failRefill('refill-31', 'the redemption stalled and was cancelled; 12.4 wXMR was returned to the wallet'),
    });
    const transit = await screen.findByRole('table', { name: 'Refills in transit' });
    const row = within(transit).getByText('refill-31').closest('tr') as HTMLElement;
    expect(text(within(row).getByTestId('wxmr-manual'))).toBe('Manual action: a stopped redemption returns wXMR, not USDC. Any wXMR left in the operator wallet has to be redeemed or sold by hand; the daemon offers no action for it.');
    // Only bridge refills carry the note.
    expect(within(within(transit).getByText('refill-29').closest('tr') as HTMLElement).queryByTestId('wxmr-manual')).toBeNull();
  });
});

describe('swap summaries (A13)', () => {
  it('carry the approval mode and the latest instruction, in the list and in the push', async () => {
    const { client, daemon } = setup();
    daemon.holdTransaction(REF.noticed);
    await client.call('swapAbort', { params: { ref: REF.noticed } });
    const list = (await client.call('swaps')).swaps;
    expect(list.find((s) => s.ref === REF.noticed)).toMatchObject({ mode: 0, instruction: { action: 'abort', status: 'pending', reason: null, tx: null } });
    expect(list.find((s) => s.ref === REF.pendingSol)).toMatchObject({ mode: 1, instruction: null });
    const seen: unknown[] = [];
    daemon.connect((msg) => seen.push(msg)).receive({ op: 'subscribe', channels: ['swaps'] });
    const pushed = (seen[0] as { data: { ref: string; mode: number; instruction: unknown }[] }).data.find((s) => s.ref === REF.noticed);
    expect(pushed).toMatchObject({ mode: 0, instruction: { status: 'pending' } });
  });

  it('shows mode and instruction in the swaps list, and holds further actions while one is pending', async () => {
    const m = mount('#/swaps', { prepare: (d) => d.holdTransaction(REF.noticed, 'the lock notice') });
    const table = await within(screen.getByRole('main')).findByRole('table');
    const row = (ref: string): HTMLElement => within(table).getByRole('link', { name: `Swap ${ref}` }).closest('tr') as HTMLElement;
    expect(text(row(REF.pendingSol))).toContain('Sell XMR · approval window');
    expect(text(row(REF.noticed))).toContain('Sell XMR · auto-accept');
    expect(within(row(REF.noticed)).queryByTestId('list-instruction')).toBeNull();

    await m.user.click(within(row(REF.noticed)).getByRole('button', { name: 'Abort swap' }));
    await m.user.click(within(within(row(REF.noticed)).getByRole('alertdialog')).getByRole('button', { name: 'Abort swap' }));
    await waitFor(() => expect(text(within(row(REF.noticed)).getByTestId('list-instruction'))).toBe('Abort pending'));
    await waitFor(() => expect((within(row(REF.noticed)).getByRole('button', { name: 'Abort swap' }) as HTMLButtonElement).disabled).toBe(true));
    expect(text(within(row(REF.noticed)).getByTestId('blocked-reason'))).toBe('Your abort is still waiting to be carried out.');

    m.daemon.chainSays(REF.noticed, 'ready-already-set');
    m.daemon.landTransaction(REF.noticed);
    await waitFor(() => expect(text(within(row(REF.noticed)).getByTestId('list-instruction'))).toBe('Abort refused'));
    expect(within(within(row(REF.noticed)).getByTestId('list-instruction')).getByText('Abort refused').getAttribute('title')).toBe(REFUSAL_TEXT['ready-already-set'].why);
  });
});

describe('validate carries the cost basis (A13)', () => {
  it('returns the SOL price and compute units with the validation', async () => {
    const { client, daemon } = setup();
    daemon.solUsd = 150;
    expect(await client.call('configValidate', { body: { toml: '' } })).toMatchObject({ ok: true, sol_usd: 150, compute_units_per_update: 24_120 });
  });
  it('re-prices the draft with the price that came with its validation', async () => {
    const m = mount('#/config');
    const section = await screen.findByRole('region', { name: 'Offer updates and cost' });
    expect(text(within(section).getByTestId('daily-usd'))).toBe('about $5.40');
    // The price moves at the daemon; the next validation of the draft brings it.
    m.daemon.solUsd = 250;
    const interval = within(section).getByLabelText('Update interval');
    await m.user.clear(interval);
    await m.user.type(interval, '60');
    await waitFor(() => expect(text(within(section).getByTestId('daily-usd'))).toBe('about $1.80'));
    expect(text(within(section).getByTestId('daily-sol'))).toBe('0.0072 SOL');
  });
});

describe('parked payouts (A14)', () => {
  it('builds the unsigned withdrawal, or answers 409 nothing_owed', async () => {
    const { client, daemon } = setup();
    const none = await client.withdrawOwedTx(REF.done3).then(
      () => null,
      (e: unknown) => e as ApiFailure,
    );
    expect([none?.status, none?.code]).toEqual([409, 'nothing_owed']);
    daemon.parkPayout(REF.done3, ADDR.ethPayout);
    const built = await client.withdrawOwedTx(REF.done3);
    expect(built.unsigned).toMatchObject({ chain: 'ethereum', to: ADDR.contract });
    expect(built.summary).toContain(ADDR.ethPayout);
    // Relayed through the registration submit route; then nothing is owed any more.
    expect((await client.call('registrationSubmit', { body: { request_id: built.request_id, signed: SIGNED_ETH } })).status).toBe('confirmed');
    expect((await client.withdrawOwedTx(REF.done3).catch((e: unknown) => (e as ApiFailure).code))).toBe('nothing_owed');
  });

  it('withdraws a parked payout through the owner wallet path and shows the outcome', async () => {
    const m = mount(`#/swaps/${REF.done3}`, { prepare: (d) => d.parkPayout(REF.done3, ADDR.ethPayout) });
    const card = await screen.findByRole('region', { name: 'Parked payout' });
    await m.user.click(within(card).getByRole('button', { name: 'Withdraw parked payout' }));
    const panel = await within(card).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    expect(text(panel)).toContain(`Withdraw the payout parked for this swap to ${ADDR.ethPayout}.`);
    const unsigned = JSON.parse((within(panel).getByLabelText('Unsigned transaction for the owner key on Ethereum') as HTMLTextAreaElement).value) as { chain: string; to: string };
    expect(unsigned).toMatchObject({ chain: 'ethereum', to: ADDR.contract });
    // A malformed signature is refused and reported in the panel.
    await m.user.type(within(panel).getByLabelText('Signed transaction (raw, 0x-hex)'), 'nonsense');
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    expect(text(await within(panel).findByRole('alert'))).toContain('Expected a signed raw Ethereum transaction as 0x-hex.');
    await m.user.clear(within(panel).getByLabelText('Signed transaction (raw, 0x-hex)'));
    await m.user.type(within(panel).getByLabelText('Signed transaction (raw, 0x-hex)'), SIGNED_ETH);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    const result = await within(card).findByTestId('parked-result');
    expect(text(result)).toContain('Withdrawn.');
    expect(text(result)).toContain('Relayed and confirmed.');
    expect(within(card).queryByRole('region', { name: 'Owner transaction' })).toBeNull();

    // Asking again: nothing is parked any more, said in place.
    await m.user.click(within(card).getByRole('button', { name: 'Withdraw parked payout' }));
    await waitFor(() => expect(text(within(card).getByTestId('parked-result'))).toBe('Nothing is parked for this swap. Every payout of this swap was delivered, or it has already been withdrawn.'));
  });

  it('signs a Solana withdrawal with the owner’s wallet when one is present', async () => {
    let signedWith: string | null = null;
    const wallet = {
      name: 'Test Wallet',
      accounts: [{ address: ADDR.solOwner }],
      features: {
        'solana:signTransaction': {
          signTransaction: async (input: { account: { address: string }; transaction: Uint8Array }) => {
            signedWith = input.account.address;
            return [{ signedTransaction: new Uint8Array(input.transaction).fill(9, 1, 65) }];
          },
        },
      },
    };
    const announce = (e: Event): void => (e as CustomEvent<{ register: (w: unknown) => void }>).detail.register(wallet);
    window.addEventListener('wallet-standard:app-ready', announce);
    try {
      const m = mount(`#/swaps/${REF.done1}`, { prepare: (d) => d.parkPayout(REF.done1, ADDR.solPayout) });
      const card = await screen.findByRole('region', { name: 'Parked payout' });
      await m.user.click(within(card).getByRole('button', { name: 'Withdraw parked payout' }));
      await m.user.click(await within(card).findByRole('button', { name: 'Sign with Test Wallet' }));
      expect(text(await within(card).findByTestId('parked-result'))).toContain('Withdrawn.');
      expect(signedWith).toBe(ADDR.solOwner);
      expect((await m.client.withdrawOwedTx(REF.done1).catch((e: unknown) => (e as ApiFailure).code))).toBe('nothing_owed');
    } finally {
      window.removeEventListener('wallet-standard:app-ready', announce);
    }
  });
});

describe('published settings in dry run (A13)', () => {
  it('reports the refusal and leaves nothing behind', async () => {
    const m = mount('#/registration', { toml: DESIGN_BOTH_TOML });
    const form = within(await screen.findByRole('region', { name: 'Contact channels' })).getByRole('form', { name: 'Edit contact channels' });
    await m.user.click(within(form).getByRole('button', { name: 'Remove channel 1' }));
    await m.user.click(within(form).getByRole('button', { name: 'Publish with the operator key' }));
    expect(text(await within(form).findByRole('alert'))).toBe('Not published. Dry run: the registry update was not sent. Switch the daemon to live mode to send transactions.');
    expect((await m.client.call('registration')).solana.contacts).toHaveLength(3);
  });
});

describe('link history (A13)', () => {
  it('marks a change that was replaced before it took effect', async () => {
    const m = mount('#/registration');
    const link = await screen.findByRole('region', { name: 'Identity link' });
    const change = async (to: string): Promise<void> => {
      const built = await m.client.call('registrationTx', { body: { chain: 'solana', action: 'set_eth_link', eth_address: to } });
      await m.client.call('registrationSubmit', { body: { request_id: built.request_id, signed: 'A'.repeat(200) } });
    };
    await change('0x00000000000000000000000000000000000000aa');
    await change('0x00000000000000000000000000000000000000bb');
    void link;
    window.location.hash = '#/keys';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    await screen.findByRole('heading', { level: 1, name: 'Keys' });
    window.location.hash = '#/registration';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    const table = await screen.findByRole('table', { name: 'Link history' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(5));
    const rows = within(table).getAllByRole('row').slice(1).map(text);
    expect(rows.find((r) => r.includes('00aa'))).toContain('Superseded');
    expect(rows.find((r) => r.includes('00bb') && !r.includes('00aaS'))).toContain('Pending');
    expect(rows.filter((r) => r.includes('no link'))).toHaveLength(2);
  });
});
