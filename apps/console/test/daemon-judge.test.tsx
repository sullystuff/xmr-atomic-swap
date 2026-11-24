/**
 * BUG-2 and its class: the console's copy of the configuration schema lags the daemon's. The
 * daemon is the judge of what the file may contain; a key the console does not know is kept
 * untouched, listed as not editable here, and never blocks a save.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { editToml, inlineToml } from '../src/lib/config/edit.js';
import { getPath, parseToml, setPath } from '../src/lib/config/toml.js';
import { unknownKeys, validateConfig } from '../src/lib/config/validate.js';
import { FULL_DAEMON_TOML, keyLines } from './full-config.js';
import { mount, text } from './harness.js';

const FUTURE = '[offers]\nupdate_interval_seconds = 15\nfuture_knob = "on"';
const withFuture = FULL_DAEMON_TOML.replace('[offers]\nupdate_interval_seconds = 15', FUTURE);
const withMadeUp = withFuture.replace('base_url = "http://127.0.0.1:9000"', 'base_url = "http://127.0.0.1:9000"\nmade_up = "x"');
const saveBar = (): HTMLElement => screen.getByRole('region', { name: 'Save configuration' });
const notEditable = (): HTMLElement => screen.getByRole('region', { name: 'Settings not editable here' });

describe('the console’s schema against the daemon’s', () => {
  it('the reference file names every key in the daemon’s schema sources', () => {
    // Read from the daemon's and the rebalancer's schema files themselves, so a key added there
    // shows up here as a control this console still lacks (it would not block a save either way).
    const sources = ['../../../packages/daemon/src/config/schema.ts', '../../../packages/rebalancer/src/settings.ts'].map((f) => readFileSync(resolve(__dirname, f), 'utf8').split(/^export type /m)[0] as string).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
    const names = new Set([...sources.matchAll(/(?<![A-Za-z0-9_.'"])([a-z][a-z0-9_]*):\s*(?:z\.|[A-Za-z]+\.(?:default|optional|nonnegative|positive|min|max)\(|[A-Za-z]+\s*[,}])/g)].map((m) => m[1] as string));
    for (const notAKey of ['message']) names.delete(notAKey);
    expect(names.size).toBeGreaterThan(120);
    const missing = [...names].filter((n) => !new RegExp(`(^|[\\s{,.\\[])${n}(\\s*=|[.\\]])`, 'm').test(FULL_DAEMON_TOML));
    expect(missing).toEqual([]);
  });

  it('has a control for every key the daemon defines', () => {
    const cfg = parseToml(FULL_DAEMON_TOML);
    expect(unknownKeys(cfg)).toEqual([]);
    // And its own checks find nothing wrong with a file the daemon accepts.
    expect(validateConfig(cfg, { blobEndpoint: true, solUsd: null }).errors).toEqual([]);
    // BUG-2's key, and the others the bug entry names.
    for (const key of ['pricing.sources.coingecko.base_url', 'pricing.sources.wxmr_pool.base_vault', 'pricing.sources.wxmr_pool.quote_vault', 'pricing.sources.wxmr_pool.quote', 'markets.sol.buy_xmr.without_ready'])
      expect(getPath(cfg, key), key).toBeDefined();
  });

});

describe('saving changes only the lines that were edited', () => {
  const edit = (text: string, path: string, value: unknown): { toml: string; kept: boolean } => editToml(text, setPath(parseToml(text), path, value));
  const file = '# my maker\n[pricing]\nrefresh_seconds = 15   # every quarter minute\ncustom_key = "kept"\n\n[guardrails]\nvolatility_pause = { move_pct = 3.0, window_seconds = 600 }\n\n[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 20 }]\n';

  it('returns the file untouched when nothing changed', () => {
    expect(editToml(FULL_DAEMON_TOML, parseToml(FULL_DAEMON_TOML))).toEqual({ toml: FULL_DAEMON_TOML, kept: true });
  });
  it('changes one line and keeps comments, spacing and unknown keys', () => {
    const out = edit(file, 'pricing.max_age_seconds', 90);
    expect(out.kept).toBe(true);
    expect(out.toml).toBe(file.replace('custom_key = "kept"\n', 'custom_key = "kept"\nmax_age_seconds = 90\n'));
    expect(edit(file, 'guardrails.dry_run', true).toml).toBe(file.replace('window_seconds = 600 }\n', 'window_seconds = 600 }\ndry_run = true\n'));
    // An edited line is rewritten (its trailing comment goes with it); every other line is as it was.
    const changed = edit(file, 'pricing.refresh_seconds', 30).toml;
    expect(changed).toBe(file.replace('refresh_seconds = 15   # every quarter minute', 'refresh_seconds = 30'));
  });
  it('edits inside an inline table or a list by rewriting just that line', () => {
    expect(edit(file, 'guardrails.volatility_pause.move_pct', 4).toml).toBe(file.replace('{ move_pct = 3.0, window_seconds = 600 }', '{ move_pct = 4, window_seconds = 600 }'));
    expect(edit(file, 'liquidity.output_ladder', [{ size_xmr: 5, count: 20 }, { size_xmr: 50, count: 6 }]).toml).toBe(file.replace('[{ size_xmr = 5, count = 20 }]', '[ { size_xmr = 5, count = 20 }, { size_xmr = 50, count = 6 } ]'));
  });
  it('removes a key by removing its line, and adds a new table at the end', () => {
    expect(edit(file, 'guardrails.volatility_pause', undefined).toml).toBe(file.replace('volatility_pause = { move_pct = 3.0, window_seconds = 600 }\n', ''));
    const added = edit(file, 'markets.sol.buy_xmr.enabled', true);
    expect(added.toml).toBe(`${file}\n[markets.sol.buy_xmr]\nenabled = true\n`);
    expect(edit('', 'offers.update_interval_seconds', 5).toml).toBe('\n[offers]\nupdate_interval_seconds = 5\n');
  });
  it('falls back to writing the file afresh when it cannot patch safely, and says so', () => {
    const multi = '[liquidity]\noutput_ladder = [\n  { size_xmr = 5, count = 20 },\n]\nxmr_reserve = 50\n';
    const out = edit(multi, 'liquidity.xmr_reserve', 60);
    expect(out.kept).toBe(false);
    expect(parseToml(out.toml)).toEqual(setPath(parseToml(multi), 'liquidity.xmr_reserve', 60));
    const aot = '[[approvals.advance]]\ntaker = "T"\nmax_xmr = 1\ndays = 2\n';
    expect(edit(aot, 'approvals.auto_max_xmr', 5).kept).toBe(false);
  });
  it('always yields exactly the wanted configuration', () => {
    const wanted = setPath(setPath(setPath(parseToml(FULL_DAEMON_TOML), 'markets.eth.sell_xmr.size_tiers', []), 'tor.hostname_file', undefined), 'rebalance.venues.exchange.name', 'kraken2');
    const out = editToml(FULL_DAEMON_TOML, wanted);
    expect(out.kept).toBe(true);
    expect(parseToml(out.toml)).toEqual(wanted);
    expect(inlineToml({ a: [1, 'x', true], 'odd key': {} })).toBe('{ a = [ 1, "x", true ], "odd key" = {} }');
  });
});

describe('BUG-2: a file with [pricing.sources.coingecko].base_url', () => {
  it('saves an edit, and base_url is editable', async () => {
    const m = mount('#/config', { toml: FULL_DAEMON_TOML });
    await screen.findByRole('region', { name: 'Markets and offers' });
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    expect(text(notEditable())).toContain('Every key in the file has a control on this page.');
    const pricing = screen.getByRole('region', { name: 'Price sources' });
    expect((within(pricing).getAllByLabelText('API base URL')[0] as HTMLInputElement).value).toBe('http://127.0.0.1:9000');

    // The e2e scenario: SOL buy-XMR deviation to 5, validate and save.
    await m.user.click(screen.getByRole('button', { name: 'Edit SOL Buy XMR settings' }));
    const editor = screen.getByRole('region', { name: 'SOL Buy XMR settings' });
    const dev = within(editor).getByLabelText('Deviation from reference');
    await m.user.clear(dev);
    await m.user.type(dev, '5');
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Validate and save' }));
    await waitFor(async () => expect(getPath(parseToml((await m.client.call('configGet')).toml), 'markets.sol.buy_xmr.deviation_pct')).toBe(5));
    const saved = (await m.client.call('configGet')).toml;
    expect(saved).toContain('base_url = "http://127.0.0.1:9000"');
    expect(saved).toMatch(/deviation_pct = 5\n/);
  });
});

describe('a key the daemon knows and this console does not', () => {
  it('is listed as not editable here, never blocks, and survives a save byte for byte', async () => {
    const m = mount('#/config', { toml: withFuture, daemonKnows: ['offers.future_knob'] });
    await screen.findByRole('region', { name: 'Markets and offers' });
    const row = within(within(notEditable()).getByRole('table', { name: 'Settings not editable here' })).getAllByRole('row')[1] as HTMLElement;
    expect(text(row)).toContain('offers.future_knob"on"accepted, or not checked yet');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');

    const reserve = screen.getByLabelText('XMR reserve');
    await m.user.clear(reserve);
    await m.user.type(reserve, '75');
    // The daemon checks the draft; nothing about the unknown key turns up.
    await waitFor(() => expect(text(saveBar())).not.toContain('checking with the daemon'));
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Validate and save' }));
    await waitFor(async () => expect(getPath(parseToml((await m.client.call('configGet')).toml), 'liquidity.xmr_reserve')).toBe(75));

    // On export every key the file had is still there, line for line; only the edited line differs.
    const exported = (await m.client.call('configExport')).toml;
    const before = keyLines(withFuture);
    const after = keyLines(exported);
    expect(after.has('[offers]|future_knob = "on"')).toBe(true);
    expect(after.has('[pricing.sources.coingecko]|base_url = "http://127.0.0.1:9000"')).toBe(true);
    expect([...before].filter((l) => !after.has(l))).toEqual(['[liquidity]|xmr_reserve = 50']);
    expect([...after].filter((l) => !before.has(l))).toEqual(['[liquidity]|xmr_reserve = 75']);
  });
});

describe('a made-up key', () => {
  it('is reported by the daemon’s answer, on the key, and the daemon’s keys beside it are not blamed', async () => {
    // The daemon starts on a good file; the made-up key arrives in a draft loaded into the form.
    const m = mount('#/config', { toml: withFuture, daemonKnows: ['offers.future_knob'] });
    await screen.findByRole('region', { name: 'Markets and offers' });
    const file = screen.getByRole('region', { name: 'Import and export' });
    const box = within(file).getByLabelText('Configuration file to import');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(box, { target: { value: withMadeUp } });
    // The console's own check does not condemn it; it says the daemon will decide.
    expect(text(within(file).getByTestId('import-check'))).toContain('This console does not know 2 keys in it (offers.future_knob, pricing.sources.coingecko.made_up); the daemon decides on import whether they are valid.');
    await m.user.click(within(file).getByRole('button', { name: 'Load into the form without saving' }));

    const table = within(notEditable()).getByRole('table', { name: 'Settings not editable here' });
    const rowOf = (key: string): HTMLElement => within(table).getByRole('rowheader', { name: key }).closest('tr') as HTMLElement;
    // The daemon's validation of the draft names the made-up key, and only that one.
    await waitFor(() => expect(text(rowOf('pricing.sources.coingecko.made_up'))).toContain('Error: Unrecognized key: "made_up"'));
    expect(text(rowOf('offers.future_knob'))).toContain('accepted, or not checked yet');
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('1 error');
    const base = (within(screen.getByRole('region', { name: 'Price sources' })).getAllByLabelText('API base URL')[0] as HTMLElement).closest('.field');
    expect(text(base)).not.toContain('Error:');

    // Saving is the daemon's call: it refuses, and says which key.
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Validate and save' }));
    const alert = await within(saveBar()).findByRole('alert');
    expect(text(alert)).toContain('Not saved: 1 error has to be fixed first.');
    expect(text(alert)).toContain('pricing.sources.coingecko: Unrecognized key: "made_up"');
    expect((await m.client.call('configGet')).toml).toBe(withFuture);

    // Removing the made-up key from the list clears it; the daemon then accepts and the save goes through.
    await m.user.click(within(rowOf('pricing.sources.coingecko.made_up')).getByRole('button', { name: 'Remove' }));
    await m.user.click(within(within(rowOf('pricing.sources.coingecko.made_up')).getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(table).queryByRole('rowheader', { name: 'pricing.sources.coingecko.made_up' })).toBeNull());
    await waitFor(() => expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors'));
  });

  it('is refused on import with the daemon’s words, and nothing changes', async () => {
    const m = mount('#/config', { toml: withFuture, daemonKnows: ['offers.future_knob'] });
    await screen.findByRole('region', { name: 'Markets and offers' });
    const e = await m.client.call('configImport', { body: { toml: withMadeUp } }).then(
      () => null,
      (err: unknown) => err as { status: number; issues: { path: string; message: string }[] },
    );
    expect(e?.status).toBe(422);
    expect(e?.issues).toEqual([{ path: 'pricing.sources.coingecko', message: 'Unrecognized key: "made_up"' }]);
    expect((await m.client.call('configGet')).toml).toBe(withFuture);
  });
});

describe('a local check the daemon does not share', () => {
  it('is shown as a warning and does not stop the save', async () => {
    const m = mount('#/config');
    await screen.findByRole('region', { name: 'Markets and offers' });
    const reserve = screen.getByLabelText('XMR reserve');
    await m.user.clear(reserve);
    await m.user.type(reserve, '80');
    await waitFor(() => expect(text(saveBar())).not.toContain('checking with the daemon'));
    // A daemon that is more lenient than the console about one value: it validates the draft as fine,
    // although the console's own rule would object.
    const real = m.client.call.bind(m.client);
    let puts = 0;
    m.client.call = ((name: string, args: { body?: { toml?: string } }) => {
      if (name === 'configValidate') return (real as (n: string, a: unknown) => Promise<{ ok: boolean; errors: unknown[] }>)(name, args).then((v) => ({ ...v, ok: true, errors: [] }));
      if (name === 'configPut') {
        puts += 1;
        return (real as (n: string, a: unknown) => Promise<unknown>)('configGet', {});
      }
      return (real as (n: string, a: unknown) => Promise<unknown>)(name, args);
    }) as typeof m.client.call;
    await m.user.click(screen.getByRole('button', { name: 'Edit USDC-SOL Sell XMR settings' }));
    const dep = within(screen.getByRole('region', { name: 'USDC-SOL Sell XMR settings' })).getByLabelText('Anti-spam deposit');
    await m.user.clear(dep);
    await m.user.type(dep, '6');
    await waitFor(() => expect(text(dep.closest('.field'))).toContain('Warning: Anti-spam deposit must be at most 5. (This console’s own check; the daemon accepts the value.)'));
    expect(text(within(saveBar()).getByTestId('error-count'))).toBe('0 errors');
    await m.user.click(within(saveBar()).getByRole('button', { name: 'Validate and save' }));
    await waitFor(() => expect(puts).toBe(1));
  });
});
