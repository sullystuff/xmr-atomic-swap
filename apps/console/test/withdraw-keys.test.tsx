/** `[rebalance.venues.exchange.withdraw_keys]`: a withdrawal needs both an allow-list entry and a key. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getPath, parseToml } from '../src/lib/config/toml.js';
import { issuesAt, unknownKeys, validateConfig, withdrawKeyProblems } from '../src/lib/config/validate.js';
import { DEFAULT_TOML } from '../src/mock/fixtures.js';
import { mount, text } from './harness.js';

const ALLOW = '\n[rebalance.allowlist]\nxmr = [ "4OwnXmrAddress" ]\nsol = [ "OwnSolAddress" ]\n';
const KEYS = '\n[rebalance.venues.exchange.withdraw_keys]\n4OwnXmrAddress = "xmr-main"\nStrayAddress = "stray"\n';
const ctx = { blobEndpoint: true, solUsd: null };

describe('withdrawal keys: checks', () => {
  it('is a key the console knows, and flags both mismatches as warnings', () => {
    const cfg = parseToml(DEFAULT_TOML + ALLOW + KEYS);
    expect(unknownKeys(cfg)).toEqual([]);
    expect(withdrawKeyProblems(cfg)).toEqual([
      { address: 'StrayAddress', key: 'stray', problem: 'not_allowlisted' },
      { address: 'OwnSolAddress', key: null, problem: 'no_key' },
    ]);
    const v = validateConfig(cfg, ctx);
    expect(v.ok).toBe(true);
    expect(issuesAt(v.warnings, 'rebalance.venues.exchange.withdraw_keys').map((w) => w.message)).toEqual([
      'StrayAddress has a withdrawal key ("stray") but is not on the address allow-list; the rebalancer refuses withdrawals to it.',
      'OwnSolAddress is on the address allow-list but has no withdrawal key; the exchange cannot withdraw to it.',
    ]);
  });
  it('does not flag a missing key while the exchange is off, nor anything when the daemon’s default allow-list applies', () => {
    const off = parseToml((DEFAULT_TOML + ALLOW + KEYS).replace('[rebalance.venues.exchange]\nenabled = true', '[rebalance.venues.exchange]\nenabled = false'));
    expect(withdrawKeyProblems(off)).toEqual([{ address: 'StrayAddress', key: 'stray', problem: 'not_allowlisted' }]);
    expect(withdrawKeyProblems(parseToml(DEFAULT_TOML + KEYS))).toEqual([]);
    expect(validateConfig(parseToml('[rebalance.venues.exchange]\nwithdraw_keys = "x"'), ctx).ok).toBe(false);
  });
});

describe('withdrawal keys: the Rebalancing page', () => {
  const card = (): HTMLElement => screen.getByRole('region', { name: 'Exchange withdrawal keys' });

  it('edits the table beside the allow-list and warns on both mismatches', async () => {
    const m = mount('#/rebalancing', { toml: DEFAULT_TOML + ALLOW });
    await screen.findByRole('region', { name: 'Address allow-list' });
    await screen.findByRole('region', { name: 'Exchange withdrawal keys' });
    // Allow-listed for the enabled exchange, no key yet: both addresses are flagged.
    const table = within(card()).getByRole('table', { name: 'Exchange withdrawal keys' });
    expect(within(table).getAllByRole('row').slice(1).map(text)).toEqual([
      '4OwnXmrAddressWarning: allow-listed, but it has no withdrawal key. The exchange cannot withdraw to it.no keyAdd a key',
      'OwnSolAddressWarning: allow-listed, but it has no withdrawal key. The exchange cannot withdraw to it.no keyAdd a key',
    ]);

    // Give one its key, and add a key for an address that is not allow-listed.
    await m.user.click(within(card()).getByRole('button', { name: 'Add a key for 4OwnXmrAddress' }));
    expect((within(card()).getByLabelText('Withdrawal address') as HTMLInputElement).value).toBe('4OwnXmrAddress');
    await m.user.type(within(card()).getByLabelText('Key name'), 'xmr-main');
    await m.user.click(within(card()).getByRole('button', { name: 'Add key' }));
    await m.user.type(within(card()).getByLabelText('Withdrawal address'), 'StrayAddress');
    await m.user.type(within(card()).getByLabelText('Key name'), 'stray');
    await m.user.click(within(card()).getByRole('button', { name: 'Add key' }));
    const rows = within(within(card()).getByRole('table', { name: 'Exchange withdrawal keys' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(text(rows[0] as HTMLElement)).toBe('4OwnXmrAddressRemove');
    expect((within(rows[0] as HTMLElement).getByLabelText('Key name for 4OwnXmrAddress') as HTMLInputElement).value).toBe('xmr-main');
    expect(text(rows[1] as HTMLElement)).toBe('StrayAddressWarning: not on the address allow-list. The rebalancer refuses withdrawals to it until it is listed.Remove');
    expect(text(rows[2] as HTMLElement)).toContain('OwnSolAddressWarning: allow-listed, but it has no withdrawal key.');

    // Saved through the daemon: validated, applied, and written as its own table in the file.
    await m.user.click(within(card()).getByRole('button', { name: 'Save withdrawal keys' }));
    await waitFor(async () => expect(getPath(parseToml((await m.client.call('configGet')).toml), 'rebalance.venues.exchange.withdraw_keys')).toEqual({ '4OwnXmrAddress': 'xmr-main', StrayAddress: 'stray' }));
    const file = (await m.client.call('configExport')).toml;
    expect(file).toContain('[rebalance.venues.exchange.withdraw_keys]\n4OwnXmrAddress = "xmr-main"\nStrayAddress = "stray"\n');
    // Everything else in the file is as it was.
    expect(file.startsWith(DEFAULT_TOML + ALLOW)).toBe(true);
    // The daemon's validation carries the same warnings.
    expect(issuesAt((await m.client.call('configGet')).validation.warnings, 'rebalance.venues.exchange.withdraw_keys')).toHaveLength(2);

    // Removing a key and saving takes its line out.
    await waitFor(() => expect((within(card()).getByRole('button', { name: 'Save withdrawal keys' }) as HTMLButtonElement).disabled).toBe(true));
    await m.user.click(within(card()).getByRole('button', { name: 'Remove the key for StrayAddress' }));
    await m.user.click(within(card()).getByRole('button', { name: 'Save withdrawal keys' }));
    await waitFor(async () => expect((await m.client.call('configExport')).toml).not.toContain('StrayAddress'));
  });

  it('says the default allow-list cannot be checked here, and has an empty state', async () => {
    const m = mount('#/rebalancing');
    await screen.findByRole('region', { name: 'Exchange withdrawal keys' });
    expect(text(card())).toContain('No keys. The exchange cannot withdraw to any address until one is added.');
    await m.user.type(within(card()).getByLabelText('Withdrawal address'), '4SomeAddress');
    await m.user.type(within(card()).getByLabelText('Key name'), 'main');
    await m.user.click(within(card()).getByRole('button', { name: 'Add key' }));
    expect(text(card())).toContain('No allow-list is set in the configuration, so the daemon’s default list applies');
    expect(within(card()).queryByText(/not on the address allow-list/)).toBeNull();
  });

  it('is also editable on the Configuration page, with the same warnings', async () => {
    mount('#/config', { toml: DEFAULT_TOML + ALLOW + KEYS });
    const r = await screen.findByRole('region', { name: 'Rebalancing' });
    const exchange = [...r.querySelectorAll('details')].find((d) => text(d.querySelector('summary')).startsWith('Exchange')) as HTMLElement;
    const group = within(exchange).getByRole('group', { name: 'Withdrawal keys' });
    expect(text(group)).toContain('4OwnXmrAddress = xmr-main');
    expect(text(group.closest('.field'))).toContain('Warning: StrayAddress has a withdrawal key ("stray") but is not on the address allow-list');
    expect(text(screen.getByRole('region', { name: 'Settings not editable here' }))).toContain('Every key in the file has a control on this page.');
  });
});
