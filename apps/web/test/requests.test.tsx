// What the user asks for always has a visible result: carried out, or refused with the reason and
// what happens instead (the SDK's `refused` reasons). And the settings precedence: per-key local
// overrides on top of the site's served config.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf } from '@xmrswap/sdk';
import { REFUSALS, refusalText } from '../src/lib/refusal.js';
import { DEFAULT_SETTINGS, loadSettings, overriddenKeys, saveSettings, settingsProblems, siteDefaults } from '../src/lib/settings.js';
import { RefusedNotice } from '../src/pages/SwapPage.js';
import { XMR } from './fakes.js';
import { DEST, makeRig, mount } from './harness.js';

const TXID = 'ab'.repeat(32);
const outcome = () => screen.getByTestId('request-outcome');

describe('every refusal reason has its own plain-language message', () => {
  it.each(REFUSALS)('%s: says why and what happens instead', (reason) => {
    const { container } = render(<RefusedNotice reason={reason} buying={reason !== 'abort-window-closed' && reason !== 'cannot-exit-after-funding'} />);
    const alert = within(container).getByRole('alert');
    const r = refusalText(reason, true);
    expect(alert.textContent!.length).toBeGreaterThan(80);
    expect(r.control.length).toBeGreaterThan(5);
    // No two reasons share a message.
    expect(REFUSALS.filter((x) => refusalText(x, true).text === r.text)).toEqual([reason]);
  });
  it('the wording of the ones a taker meets', () => {
    expect(refusalText('ready-already-set', true).text).toMatch(/^Ready is already set, so this swap can no longer be refunded\. The maker will claim and this tab will collect your XMR\./);
    expect(refusalText('refund-window-closed', true).text).toMatch(/would hand it both keys.*your payment is lost/);
    expect(refusalText('already-settled', true).text).toMatch(/nothing left to refund.*the XMR is yours/);
    expect(refusalText('cannot-exit-after-funding', false).text).toMatch(/you must not pay.*can withhold it for up to 60 days and half of it can be lost/);
    expect(refusalText('abort-window-closed', false).text).toMatch(/only accepted before the final deadline/);
    expect(refusalText('hold-ended', true).text).toMatch(/the deposit returns to you/);
    expect(refusalText('no-deposit-held', true).text).toMatch(/nothing to collect/);
    expect(refusalText('reject-not-available', false).text).toMatch(/lapses by itself/);
  });
});

describe('refund requested after the lock is confirmed (BUG-1)', () => {
  it('the request wins over setting ready: the swap refunds, and the page says so', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    // Confirmed at depth, waiting only for the contract's minimum: the next automatic step would be ready.
    expect(rig.app.engine.get(ref)!.decision).toMatchObject({ do: 'wait', on: 'ready-minimum' });
    await user.click(screen.getByRole('button', { name: 'Refund this swap' }));
    await user.click(screen.getByRole('button', { name: 'Yes, refund' }));
    rig.chain.advance(300);
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.HOLD);
    expect(outcome().getAttribute('data-refused')).toBe('');
    expect(outcome().textContent).toMatch(/Refunded, as you asked/);
    expect(screen.queryByRole('button', { name: 'Refund this swap' })).toBeNull();
  });

  it('while the request is on its way the page says it is being carried out', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    rig.chain.failAlways = new Error('RPC timeout');
    await act(async () => rig.app.engine.annotate(ref, { cancel: true }));
    await rig.pass();
    expect(outcome().textContent).toMatch(/Your request is being carried out: refunding/);
    expect(screen.getByText('The last transaction did not go through')).toBeTruthy();
    rig.chain.failAlways = null;
    await rig.pass();
    expect(outcome().textContent).toMatch(/Refunded, as you asked/);
  });
});

describe('requests that cannot be honoured', () => {
  async function ready() {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.READY);
    return { rig, ref };
  }

  it('ready-already-set: the refund control is disabled and says why; a request made earlier is answered', async () => {
    const { rig, ref } = await ready();
    const control = screen.getByRole('button', { name: 'Refund not possible: ready is set' }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(document.getElementById(control.getAttribute('aria-describedby')!)!.textContent).toMatch(/^Ready is already set/);
    expect(screen.queryByRole('button', { name: 'Refund this swap' })).toBeNull();
    // A request that was confirmed but arrives after ready (another tab set it): refused, visibly.
    await act(async () => rig.app.engine.annotate(ref, { cancel: true }));
    await rig.pass();
    expect(outcome().getAttribute('data-refused')).toBe('ready-already-set');
    expect(within(outcome()).getByRole('alert').textContent).toMatch(/The maker will claim and this tab will collect your XMR/);
    expect(rig.chain.called('refund')).toBe(0);
  });

  it('refund-window-closed: past the last safe second nothing is sent and the control is replaced', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    const d = deadlinesOf('solana', rig.chain.swaps.get(ref)!);
    rig.chain.warpTo(d.tCo! - d.margin + 1n);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect((screen.getByRole('button', { name: 'Refund window closed' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => rig.app.engine.annotate(ref, { cancel: true }));
    await rig.pass();
    expect(outcome().getAttribute('data-refused')).toBe('refund-window-closed');
    expect(rig.chain.calls).toEqual([]);
  });

  it('already-settled: the maker claimed before the request could be carried out', async () => {
    const { rig, ref } = await ready();
    rig.chain.maker.claim(ref);
    await act(async () => rig.app.engine.annotate(ref, { cancel: true, destination: DEST }));
    await rig.pass();
    expect(outcome().getAttribute('data-refused')).toBe('already-settled');
    expect(outcome().textContent).toMatch(/the XMR is yours: the tab sweeps it/);
  });

  it('cannot-exit-after-funding: backing out of a funded sell hides the pay address for good', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    const { ref } = rig.chain.open({ direction: 1, xmr: XMR });
    rig.chain.maker.fund(ref);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect(screen.getByTestId('pay-xmr')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back out: I will not pay' }));
    expect(screen.getByText('Back out without paying?').closest('.notice')!.textContent).toMatch(/you must not pay/);
    await user.click(screen.getByRole('button', { name: 'Yes, back out' }));
    await rig.pass();
    expect(screen.queryByTestId('pay-xmr')).toBeNull();
    expect(outcome().getAttribute('data-refused')).toBe('cannot-exit-after-funding');
    expect(outcome().textContent).toMatch(/The payment address is no longer shown and you must not pay/);
    // A payment that shows up afterwards is not turned into a notice by a tab that was told to back out… the address stays hidden.
    await rig.pass();
    expect(screen.queryByTestId('pay-xmr')).toBeNull();
    expect(rig.chain.calls).toEqual([]);
  });

  it('abort-window-closed: a sell past the final deadline carries on to the claim instead', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open({ direction: 1, xmr: XMR });
    rig.chain.maker.fund(ref);
    rig.monero.deposits = [{ txid: TXID, inPool: true, blockHeight: null, amount: XMR }];
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.NOTICED);
    rig.chain.warpTo(deadlinesOf('solana', rig.chain.swaps.get(ref)!).tFinal);
    // Hold the claim back for a moment so the refused state is on screen.
    rig.chain.failAlways = new Error('RPC timeout');
    await act(async () => rig.app.engine.annotate(ref, { cancel: true }));
    await rig.pass();
    expect(outcome().getAttribute('data-refused')).toBe('abort-window-closed');
    expect(within(outcome()).getByRole('alert').textContent).toMatch(/It is too late to abort.*it claims your payment if that is still possible/);
    // The abort is refused; what happens instead (the claim) is carried out.
    rig.chain.failAlways = null;
    await rig.pass();
    expect(rig.chain.called('abort')).toBe(0);
    expect(rig.chain.called('claim')).toBe(1);
  });

  it('a cancel while pending is simply carried out', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    const { ref } = rig.chain.open({ mode: 1 });
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    await user.click(screen.getByRole('button', { name: 'Cancel and take everything back' }));
    await user.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    await rig.pass();
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'cancel_pending', 'session']]);
    expect(outcome().textContent).toMatch(/Refunded, as you asked.*Everything came back to you/);
  });
});

describe('settings: local overrides on top of the site config', () => {
  const site = { solanaRpc: 'https://rpc.site', moneroNodes: ['/monero/0', '/monero/1'], relayUrl: '/', programId: 'ProgV1' };

  it('stores only what the user changed, so an updated bundle config reaches a returning browser', () => {
    const base = siteDefaults(site);
    saveSettings({ ...base, moneroNodes: ['https://mine.example'], ownNode: true }, base);
    expect(JSON.parse(localStorage.getItem('xmrswap.settings.v1')!)).toEqual({ v: 2, overrides: { moneroNodes: ['https://mine.example'], ownNode: true } });
    // The operator ships a new release: new program id, another RPC.
    const next = loadSettings({ ...site, programId: 'ProgV2', solanaRpc: 'https://rpc2.site' });
    expect(next).toMatchObject({ programId: 'ProgV2', solanaRpc: 'https://rpc2.site', moneroNodes: ['https://mine.example'], ownNode: true, relayUrl: '/' });
    expect(overriddenKeys(next, siteDefaults({ ...site, programId: 'ProgV2', solanaRpc: 'https://rpc2.site' }))).toEqual(['moneroNodes', 'ownNode']);
    // Saving the site's own values stores nothing at all.
    saveSettings(base, base);
    expect(localStorage.getItem('xmrswap.settings.v1')).toBeNull();
  });

  it('migrates a whole-object record written by an older build: keys equal to the site value stop shadowing it', () => {
    const base = siteDefaults(site);
    localStorage.setItem('xmrswap.settings.v1', JSON.stringify({ ...base, theme: 'light' }));
    expect(loadSettings({ ...site, programId: 'ProgV2' })).toMatchObject({ programId: 'ProgV2', theme: 'light', solanaRpc: 'https://rpc.site' });
    // A program id the user chose under the new format is kept: it is a real override.
    saveSettings({ ...base, programId: 'Mine' }, base);
    expect(loadSettings({ ...site, programId: 'ProgV2' }).programId).toBe('Mine');
  });

  it('accepts a path on this site as a Monero node (the relay proxy), and still refuses junk', () => {
    const s = { ...DEFAULT_SETTINGS, solanaRpc: 'https://rpc.site', moneroNodes: ['/monero/0', '/monero/1'] };
    expect(settingsProblems(s, true)).toEqual([]);
    expect(settingsProblems({ ...s, moneroNodes: ['monero/0', '//evil.example/x'] }, true).map((p) => p.field)).toEqual(['moneroNodes', 'moneroNodes']);
  });

  it('the Settings page marks overridden values, shows the site default, and resets to it', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ settings: { solanaRpc: 'http://127.0.0.1:9', relayUrl: '/', mode: 'hosted' } });
    await mount(rig, '#/settings');
    expect((await screen.findByTestId('override-count')).textContent).toBe("Every setting follows this site's defaults.");
    expect((screen.getByRole('button', { name: "Reset to this site's defaults" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('override-solanaRpc')).toBeNull();

    const rpc = screen.getByLabelText('Solana RPC URL');
    await user.clear(rpc);
    await user.type(rpc, 'https://my.rpc');
    const mark = screen.getByTestId('override-solanaRpc');
    expect(mark.textContent).toMatch(/Changed in this browser Site default: http:\/\/127\.0\.0\.1:9\./);
    fireEvent.change(screen.getByLabelText('Check the chains every (seconds)'), { target: { value: '9' } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(rig.app.overridden().sort()).toEqual(['pollMs', 'solanaRpc']);
    expect(JSON.parse(localStorage.getItem('xmrswap.settings.v1')!)).toEqual({ v: 2, overrides: { solanaRpc: 'https://my.rpc', pollMs: 9000 } });
    expect(screen.getByTestId('override-count').textContent).toMatch(/^2 settings changed in this browser/);

    // One key back to the site's value…
    await user.click(within(screen.getByTestId('override-pollMs')).getByRole('button', { name: "Use the site's value" }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(rig.app.overridden()).toEqual(['solanaRpc']);
    // …and everything.
    await user.click(screen.getByRole('button', { name: "Reset to this site's defaults" }));
    await waitFor(() => expect(rig.app.overridden()).toEqual([]));
    expect(localStorage.getItem('xmrswap.settings.v1')).toBeNull();
    expect((screen.getByLabelText('Solana RPC URL') as HTMLInputElement).value).toBe('http://127.0.0.1:9');
  });
});
