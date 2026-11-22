/** The real daemon's console contract (packages/daemon/DEVIATIONS.md A1 to A10): outcomes, reasons and the added routes. */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, DaemonClient } from '../src/api/client.js';
import { REFUSAL_REASONS, outcomeOf, type RefusalReason } from '../src/api/extensions.js';
import { revisionOf, sha256Hex } from '../src/lib/config/toml.js';
import { costBasis, estimateCost } from '../src/lib/cost.js';
import { MOCK_TOKEN, MockDaemon, REFUSALS } from '../src/mock/daemon.js';
import { ADDR, REF } from '../src/mock/fixtures.js';
import { mockFetch } from '../src/mock/transport.js';
import { linkTarget } from '../src/pages/setup.js';
import { REFUSAL_TEXT, blockedReason, refusalText } from '../src/ui/domain.js';
import { DESIGN_BOTH_TOML } from './design.js';
import { T0, mount, stat, text } from './harness.js';

afterEach(() => vi.useRealTimers());

function setup(opts: ConstructorParameters<typeof MockDaemon>[0] = {}) {
  let t = T0;
  const daemon = new MockDaemon({ now: () => t, ...opts });
  const client = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon) });
  return { daemon, client, advance: (s: number) => (t += s) };
}
const failure = async (p: Promise<unknown>): Promise<ApiFailure> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiFailure) return e;
    throw e;
  }
  throw new Error('expected the call to fail');
};
const confirm = async (user: ReturnType<typeof mount>['user'], scope: HTMLElement, label: string): Promise<void> => {
  await user.click(within(scope).getByRole('button', { name: label }));
  await user.click(within(within(scope).getByRole('alertdialog')).getByRole('button', { name: label }));
};

describe('daemon contract: operator instructions (A10)', () => {
  it('answers carried_out with the transaction and records the instruction on the swap', async () => {
    const { client } = setup();
    const r = await client.call('swapAbort', { params: { ref: REF.noticed } });
    expect(r).toMatchObject({ ok: true, outcome: 'carried_out', detail: 'abort: carried out' });
    expect(r.refused).toBeUndefined();
    expect(r.tx?.status).toBe('confirmed');
    const s = await client.call('swap', { params: { ref: REF.noticed } });
    expect(s.instruction).toEqual({ action: 'abort', at: T0, status: 'carried_out', reason: null, tx: r.tx?.id });
    expect(s.state).toBe('ABORTED_HOLD');
    // A swap nobody instructed has none.
    expect((await client.call('swap', { params: { ref: REF.ready } })).instruction).toBeNull();
  });

  it.each(REFUSAL_REASONS.filter((r) => r !== 'dry-run'))('answers refused with reason %s, 200 and ok false, and changes nothing', async (reason) => {
    const { client, daemon } = setup();
    daemon.chainSays(REF.noticed, reason);
    const r = await client.call('swapAbort', { params: { ref: REF.noticed } });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('refused');
    expect(r.refused).toBe(reason);
    expect(r.tx).toBeNull();
    expect(r.detail).toBe(`abort was not carried out: ${REFUSALS[reason] ?? reason}`);
    const s = await client.call('swap', { params: { ref: REF.noticed } });
    expect(s.state).toBe('NOTICED');
    expect(s.instruction).toMatchObject({ action: 'abort', status: 'refused', reason, tx: null });
    // One-shot: the next instruction is judged afresh.
    expect((await client.call('swapAbort', { params: { ref: REF.noticed } })).outcome).toBe('carried_out');
  });

  it('answers pending behind a transaction in flight, then carries the instruction out when it lands', async () => {
    const { client, daemon } = setup();
    daemon.holdTransaction(REF.held, 'the refund sweep');
    const r = await client.call('swapWithhold', { params: { ref: REF.held } });
    expect(r).toMatchObject({ ok: true, outcome: 'pending', tx: null, detail: 'withhold is recorded and will be carried out as soon as it can be (waiting on the refund sweep); it survives a restart' });
    let s = await client.call('swap', { params: { ref: REF.held } });
    expect(s.state).toBe('HOLD');
    expect(s.instruction).toMatchObject({ action: 'withhold', status: 'pending', tx: null });
    daemon.landTransaction(REF.held);
    s = await client.call('swap', { params: { ref: REF.held } });
    expect(s.state).toBe('WITHHELD');
    expect(s.instruction?.status).toBe('carried_out');
    expect(s.instruction?.tx).toBeTruthy();
  });

  it('refuses a pending instruction on a later step and raises an alert', async () => {
    const { client, daemon } = setup();
    daemon.holdTransaction(REF.held);
    expect((await client.call('swapWithhold', { params: { ref: REF.held } })).outcome).toBe('pending');
    daemon.chainSays(REF.held, 'hold-ended');
    daemon.landTransaction(REF.held);
    const s = await client.call('swap', { params: { ref: REF.held } });
    expect(s.state).toBe('HOLD');
    expect(s.instruction).toMatchObject({ status: 'refused', reason: 'hold-ended' });
    const alert = (await client.call('status')).alerts[0];
    expect(alert).toMatchObject({ kind: 'instruction_refused', swap_ref: REF.held, acknowledged: false });
    expect(alert?.message).toContain('the 30-minute hold has ended');
  });

  it('refuses before recording anything when the state does not offer the action, and in dry run', async () => {
    const { client } = setup();
    const e = await failure(client.call('swapAbort', { params: { ref: REF.ready } }));
    expect([e.status, e.code]).toEqual([409, 'action_unavailable']);
    expect((await client.call('swap', { params: { ref: REF.ready } })).instruction).toBeNull();
    const dry = setup({ toml: DESIGN_BOTH_TOML });
    const d = await failure(dry.client.call('swapAbort', { params: { ref: REF.noticed } }));
    expect([d.status, d.code]).toEqual([409, 'dry_run']);
  });

  it('computes the offered actions from the stored state, as the daemon does', async () => {
    const { client, advance } = setup();
    const actions = async (ref: string) => (await client.call('swap', { params: { ref } })).actions;
    expect(await actions(REF.pendingSol)).toEqual(['approve', 'reject']);
    expect(await actions(REF.noticed)).toEqual(['abort']);
    expect(await actions(REF.ready)).toEqual([]);
    // After a refund with a notice on record and no evidence yet, evidence is due.
    expect(await actions(REF.held)).toEqual(['withhold', 'release', 'publish-evidence']);
    expect(await actions(REF.withheld)).toEqual(['release']);
    expect(await actions(REF.done1)).toEqual([]);
    advance(60);
    expect(await actions(REF.pendingSol)).toEqual([]);
    advance(18 * 60);
    expect(await actions(REF.held)).toEqual(['release', 'publish-evidence']);
  });

  it('reads an answer from a daemon that predates the outcome field', () => {
    expect(outcomeOf({ ok: true, tx: null })).toBe('carried_out');
    expect(outcomeOf({ ok: false, tx: null })).toBe('refused');
    expect(outcomeOf({ ok: true, tx: null, outcome: 'pending' })).toBe('pending');
  });
});

describe('daemon contract: added routes and fields (A2 to A9)', () => {
  it('publishes contact channels and the onion address with the operator key', async () => {
    const { client } = setup({ blobEndpoint: false });
    const onion = `${'a'.repeat(56)}.onion`;
    const res = await client.publishRegistration({ contacts: [{ kind: 2, value: '#desk:example.org' }], onion });
    expect(res.tx).toMatchObject({ chain: 'solana', status: 'sent' });
    expect(res.registration.solana.contacts).toEqual([{ kind: 2, value: '#desk:example.org' }]);
    expect(res.registration.solana.onion).toBe(onion);
    // An onion address is a blob endpoint.
    expect(res.registration.blob_endpoint).toBe(true);
    expect((await client.call('registration')).solana.onion).toBe(onion);
    // Nothing changed: no transaction.
    expect((await client.publishRegistration({ onion })).tx).toBeNull();
    // `null` follows the Tor hostname file again.
    expect((await client.publishRegistration({ onion: null })).registration.solana.onion).toBeNull();
    expect((await client.call('registration')).blob_endpoint).toBe(false);

    expect((await failure(client.publishRegistration({ onion: 'example.onion' }))).status).toBe(400);
    expect((await failure(client.publishRegistration({ contacts: [{ kind: 1, value: 'x'.repeat(97) }] }))).status).toBe(400);
    expect((await failure(client.publishRegistration({ contacts: Array.from({ length: 7 }, () => ({ kind: 0, value: 'a' })) }))).status).toBe(400);
    const dry = setup({ toml: DESIGN_BOTH_TOML });
    expect((await failure(dry.client.publishRegistration({ contacts: [] }))).code).toBe('dry_run');
  });

  it('serves the identity link’s trace, newest first, as bytes', async () => {
    const { client } = setup();
    const before = (await client.linkHistory()).entries;
    expect(before.map((e) => e.chain)).toEqual(['ethereum', 'solana']);
    expect(before[1]).toMatchObject({ old: `0x${'00'.repeat(20)}`, new: ADDR.ethOwner });
    expect(linkTarget(before[0]?.new ?? '')).toBe(ADDR.solOwner);
    const built = await client.call('registrationTx', { body: { chain: 'solana', action: 'set_eth_link', eth_address: '0x00000000000000000000000000000000000000aa' } });
    await client.call('registrationSubmit', { body: { request_id: built.request_id, signed: 'A'.repeat(200) } });
    const after = (await client.linkHistory()).entries;
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual({ chain: 'solana', old: ADDR.ethOwner, new: '0x00000000000000000000000000000000000000aa', effective_at: T0 + 604_800 });
  });

  it('acknowledges alerts and refills', async () => {
    const { client, daemon } = setup();
    expect((await client.acknowledgeAlert('9')).acknowledged).toBe(true);
    expect((await client.call('status')).alerts.find((a) => a.id === '9')?.acknowledged).toBe(true);
    expect((await failure(client.acknowledgeAlert('nope'))).code).toBe('unknown_alert');

    // A held order: continue, refund, or close as dealt with.
    expect((await client.acknowledgeRefill('refill-29', 'refund')).state).toBe('refunded');
    expect((await failure(client.acknowledgeRefill('refill-28'))).code).toBe('refill_refused');
    expect((await failure(client.acknowledgeRefill('nope'))).code).toBe('unknown_refill');
    const other = setup();
    expect((await other.client.acknowledgeRefill('refill-29', 'continue')).state).toBe('processing');
    const third = setup();
    const closed = await third.client.acknowledgeRefill('refill-29');
    expect(closed.state).toBe('failed');
    expect(closed.detail).toContain('closed by the maker');

    // A failed refill counts against the cap until acknowledged.
    daemon.failRefill('refill-30', 'the venue returned an error');
    expect((await client.call('rebalance')).in_transit_usd).toBeCloseTo(8_000, 2);
    await client.acknowledgeRefill('refill-30');
    expect((await client.call('rebalance')).in_transit_usd).toBe(0);
  });

  it('reports the owner pause per chain, and that the operator cannot pause on Ethereum', async () => {
    const { client } = setup();
    expect((await client.call('status')).paused.chains).toEqual([
      { chain: 'solana', owner: false, operator: false },
      { chain: 'ethereum', owner: false, operator: false },
    ]);
    const built = await client.call('registrationTx', { body: { chain: 'ethereum', action: 'set_paused', paused: true } });
    await client.call('registrationSubmit', { body: { request_id: built.request_id, signed: `0x${'ab'.repeat(40)}` } });
    await client.call('pause', { body: {} });
    const p = (await client.call('status')).paused;
    expect(p.owner).toBe(true);
    expect(p.chains).toEqual([
      { chain: 'solana', owner: false, operator: true },
      { chain: 'ethereum', owner: true, operator: false },
    ]);
  });

  it('sends its SOL price and compute-unit figure with fees, offers and previews', async () => {
    const { client, daemon } = setup();
    expect(await client.call('fees')).toMatchObject({ sol_usd: 187.42, compute_units_per_update: 24_120 });
    expect(await client.call('offers')).toMatchObject({ sol_usd: 187.42, compute_units_per_update: 24_120 });
    expect(await client.call('offersPreview', { body: { toml: '' } })).toMatchObject({ sol_usd: 187.42, compute_units_per_update: 24_120 });
    daemon.solUsd = null;
    const f = await client.call('fees');
    expect(f.sol_usd).toBeNull();
    expect(f.estimate?.daily_usd).toBeNull();
  });

  it('carries every issue of a refused configuration', async () => {
    const { client } = setup();
    const base = await client.call('configGet');
    const bad = '[markets.usdc_sol.sell_xmr]\nenabled = true\ndeposit_pct = 9\nclaim_delay_minutes = 5\n[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 1 }]\n';
    for (const e of [await failure(client.call('configPut', { body: { toml: bad, base_revision: base.revision } })), await failure(client.call('configImport', { body: { toml: bad } })), await failure(client.call('offersPreview', { body: { toml: bad } }))]) {
      expect([e.status, e.code]).toEqual([422, 'invalid_config']);
      expect(e.issues.map((i) => i.path)).toEqual(['markets.usdc_sol.sell_xmr.deposit_pct', 'markets.usdc_sol.sell_xmr.claim_delay_minutes']);
    }
    const syntax = await failure(client.call('configImport', { body: { toml: 'a = = 1' } }));
    expect([syntax.status, syntax.code, syntax.issues]).toEqual([400, 'invalid_toml', []]);
  });

  it('uses the first 16 hex characters of SHA-256 as the revision', async () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('a'.repeat(200))).toBe('c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5');
    expect(revisionOf('abc')).toBe('ba7816bf8f01cfea');
    const { client } = setup();
    const c = await client.call('configGet');
    expect(c.revision).toBe(sha256Hex(c.toml).slice(0, 16));
  });
});

describe('cost estimate with the daemon’s figures', () => {
  it('prefers the daemon’s SOL price and compute units, and falls back when they are absent', () => {
    const est = { daily_lamports: '432000000', daily_usd: 80.96544 };
    expect(costBasis({ sol_usd: 200, compute_units_per_update: 30_000, estimate: est })).toEqual({ solUsd: 200, cuLimit: 30_000, fromDaemon: true });
    // An older daemon: the price implied by its estimate, and the built-in compute-unit figure.
    const old = costBasis({ estimate: est }, undefined);
    expect(old.solUsd).toBeCloseTo(187.42, 6);
    expect([old.cuLimit, old.fromDaemon]).toEqual([24_120, false]);
    expect(costBasis({ sol_usd: null }, { sol_usd: 150 }).solUsd).toBe(150);
    expect(costBasis(undefined).solUsd).toBeNull();
    // 10,000 micro-lamports per unit over 30,000 units = 300 lamports.
    expect(estimateCost({ intervalSecs: 60, priorityMicroLamports: 10_000, cuLimit: 30_000, solUsd: 200 }).perUpdateLamports).toBe(5_300n);
    expect(estimateCost({ intervalSecs: 60, priorityMicroLamports: 10_000, solUsd: 200 }).perUpdateLamports).toBe(5_242n);
  });

  it('prices the estimate with the daemon’s SOL price and says where it came from', async () => {
    mount('#/offers', { prepare: (d) => (d.solUsd = 200) });
    const card = await screen.findByRole('region', { name: 'Update cost' });
    // 0.0288 SOL a day at $200.
    await waitFor(() => expect(text(within(card).getByTestId('daily-usd'))).toBe('about $5.76'));
    expect(text(within(card).getByTestId('cost-basis'))).toBe('Priced at $200.00 per SOL, the daemon’s own price; an update is charged at 24,120 compute units.');
  });

  it('shows no dollar figure when the daemon has no SOL price', async () => {
    mount('#/offers', { prepare: (d) => (d.solUsd = null) });
    const card = await screen.findByRole('region', { name: 'Update cost' });
    expect(text(await within(card).findByTestId('daily-usd'))).toBe('dollar price unavailable');
    expect(text(within(card).getByTestId('daily-sol'))).toBe('0.0288 SOL');
    expect(text(within(card).getByTestId('cost-basis'))).toBe('No SOL price is available, so no dollar figure is shown.');
  });

  it('uses the daemon’s price in the live estimate on the configuration page', async () => {
    const m = mount('#/config', { prepare: (d) => (d.solUsd = 100) });
    const section = await screen.findByRole('region', { name: 'Offer updates and cost' });
    const interval = within(section).getByLabelText('Update interval');
    await m.user.clear(interval);
    await m.user.type(interval, '1');
    expect(text(within(section).getByTestId('daily-sol'))).toBe('0.432 SOL');
    expect(text(within(section).getByTestId('daily-usd'))).toBe('about $43.20');
  });
});

describe('operator actions: the outcome is shown in place', () => {
  const summaryCard = (): HTMLElement => screen.getByRole('region', { name: 'Summary' });

  it('carried out: says so with the transaction, and shows the instruction on the swap', async () => {
    const m = mount(`#/swaps/${REF.noticed}`);
    await confirm(m.user, await screen.findByRole('region', { name: 'Summary' }), 'Abort swap');
    const note = await within(summaryCard()).findByRole('status');
    expect(note.getAttribute('data-outcome')).toBe('carried_out');
    expect(text(note)).toMatch(/^Carried out\. Aborted\. The taker gets everything back when it collects, less any deposit you withhold\. Transaction \S+\.$/);
    const ins = await screen.findByTestId('instruction');
    expect(ins.getAttribute('data-status')).toBe('carried_out');
    expect(text(ins)).toContain('Abort carried out. Your instruction (given 0s ago) was carried out in transaction');
    await waitFor(() => expect(text(summaryCard())).toContain('Aborted, deposit at stake'));
  });

  const cases: [RefusalReason, string, string][] = REFUSAL_REASONS.map((r) => [r, REFUSAL_TEXT[r].why, REFUSAL_TEXT[r].instead]);
  it.each(cases)('refused with %s: says why in plain words and what happens instead', async (reason, why, instead) => {
    const m = mount(`#/swaps/${REF.noticed}`, { prepare: (d) => d.chainSays(REF.noticed, reason) });
    await confirm(m.user, await screen.findByRole('region', { name: 'Summary' }), 'Abort swap');
    const note = await within(summaryCard()).findByRole('alert');
    expect(note.getAttribute('data-outcome')).toBe('refused');
    expect(note.getAttribute('data-reason')).toBe(reason);
    expect(text(note)).toBe(`Not carried out. ${why} What happens instead: ${instead}`);
    // Nothing happened to the swap, and the refusal stays on it.
    expect((await m.client.call('swap', { params: { ref: REF.noticed } })).state).toBe('NOTICED');
    const ins = await screen.findByTestId('instruction');
    expect(ins.getAttribute('data-status')).toBe('refused');
    expect(text(ins)).toContain(`Abort was not carried out. Your instruction (given 0s ago) was refused. ${why} What happens instead: ${instead}`);
    expect(text(summaryCard())).toContain('XMR lock noticed');
  });

  it('has plain words for every reason, none of them the raw code', () => {
    for (const r of REFUSAL_REASONS) {
      expect(REFUSAL_TEXT[r].why.length, r).toBeGreaterThan(20);
      expect(REFUSAL_TEXT[r].instead.length, r).toBeGreaterThan(10);
      expect(REFUSAL_TEXT[r].why).not.toContain(r);
    }
    // A reason from a newer daemon is still reported, with the daemon's own sentence.
    expect(refusalText('some-new-reason', 'abort was not carried out: something new')).toEqual({ why: 'abort was not carried out: something new', instead: 'Nothing was sent.' });
    expect(refusalText('some-new-reason').why).toBe('The daemon refused it (some-new-reason).');
  });

  it('pending: shows the instruction on the swap until it lands, and holds other actions meanwhile', async () => {
    const m = mount(`#/swaps/${REF.held}`, { prepare: (d) => d.holdTransaction(REF.held, 'the refund sweep') });
    const deposit = await screen.findByRole('region', { name: 'Deposit' });
    await waitFor(() => expect(within(deposit).getByRole('button', { name: 'Withhold deposit' })).toBeTruthy());
    await confirm(m.user, deposit, 'Withhold deposit');
    const note = await within(deposit).findByRole('status');
    expect(note.getAttribute('data-outcome')).toBe('pending');
    expect(text(note)).toContain('On record, not carried out yet. Withhold waits behind a transaction that is still in flight');
    expect(text(note)).toContain('waiting on the refund sweep');
    expect(text(note)).toContain('you will get an alert if it is refused');

    const ins = await screen.findByTestId('instruction');
    expect(ins.getAttribute('data-status')).toBe('pending');
    expect(text(ins)).toContain('Withhold on record, not carried out yet.');
    // Nothing has changed yet, and no second instruction can be piled on top.
    expect((await m.client.call('swap', { params: { ref: REF.held } })).state).toBe('HOLD');
    await waitFor(() => expect((within(deposit).getByRole('button', { name: 'Release deposit' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(deposit).getByRole('button', { name: 'Withhold deposit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(text(within(deposit).getByTestId('blocked-reason'))).toBe('Your withhold is still waiting to be carried out.');

    // The transaction lands: the daemon pushes, and the swap shows the instruction carried out.
    act(() => m.daemon.landTransaction(REF.held));
    await waitFor(() => expect(screen.getByTestId('instruction').getAttribute('data-status')).toBe('carried_out'));
    expect(text(screen.getByTestId('instruction'))).toContain('Withhold carried out.');
    await waitFor(() => expect(text(summaryCard())).toContain('Deposit withheld'));
  });

  it('pending, then refused on a later step: the swap says so with the reason, and an alert is raised', async () => {
    const m = mount(`#/swaps/${REF.held}`, { prepare: (d) => d.holdTransaction(REF.held) });
    const deposit = await screen.findByRole('region', { name: 'Deposit' });
    await waitFor(() => expect(within(deposit).getByRole('button', { name: 'Withhold deposit' })).toBeTruthy());
    await confirm(m.user, deposit, 'Withhold deposit');
    await waitFor(() => expect(screen.getByTestId('instruction').getAttribute('data-status')).toBe('pending'));
    act(() => {
      m.daemon.chainSays(REF.held, 'hold-ended');
      m.daemon.landTransaction(REF.held);
    });
    await waitFor(() => expect(screen.getByTestId('instruction').getAttribute('data-status')).toBe('refused'));
    expect(text(screen.getByTestId('instruction'))).toContain('Withhold was not carried out. Your instruction (given 0s ago) was refused. The 30-minute hold has ended, so the deposit can no longer be withheld. What happens instead: It returns to the taker.');
    expect((await m.client.call('status')).alerts[0]?.kind).toBe('instruction_refused');
    // Releasing is possible again.
    await waitFor(() => expect((within(screen.getByRole('region', { name: 'Deposit' })).getByRole('button', { name: 'Release deposit' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a refusal in the approvals queue, beside the lock it concerns', async () => {
    const m = mount('#/approvals', { prepare: (d) => d.chainSays(REF.pendingSol, 'already-settled') });
    const table = await screen.findByRole('table', { name: 'Pending approvals' });
    const row = within(table).getByRole('link', { name: `Swap ${REF.pendingSol}` }).closest('tr') as HTMLElement;
    await m.user.click(within(row).getByRole('button', { name: 'Approve' }));
    const note = await within(row).findByRole('alert');
    expect(text(note)).toBe('Not carried out. The swap is already settled. What happens instead: Nothing further happens.');
    expect((await m.client.call('swap', { params: { ref: REF.pendingSol } })).state).toBe('PENDING');
  });

  it('reports a refusal the daemon gives before recording anything, in the same place', async () => {
    // No push channel, so the page stays as it was loaded.
    const m = mount('#/deposits', { noSocket: true });
    const held = await screen.findByRole('table', { name: 'Held deposits' });
    // Someone else releases the deposit while this page still lists it.
    await m.client.call('swapRelease', { params: { ref: REF.held } });
    await confirm(m.user, within(held).getAllByRole('row')[1] as HTMLElement, 'Withhold deposit');
    // The daemon answers 409 action_unavailable; the console says what that means, and the list catches up.
    expect(await screen.findByText('Withhold was not carried out. The swap has moved on and is no longer in a state that accepts this.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Held deposits' })).toBeNull());
    expect((await m.client.call('swap', { params: { ref: REF.held } })).outcome).toBe('releases');
  });
});

describe('operator actions: not offered when the state already says they would be refused', () => {
  const swap = { chain: 'solana' as const, state: 'PENDING' as const, direction: 'A' as const, next_deadline: { at: 1_000, label: '' } };
  it('knows the cases', () => {
    const base = { dryRun: false, chainNow: 900, swap };
    expect(blockedReason('approve', base)).toBeNull();
    expect(blockedReason('approve', { ...base, chainNow: 1_000 })).toBe('The approval window has closed; the taker is refunded in full.');
    expect(blockedReason('reject', { ...base, chainNow: 1_001 })).toBe('The approval window has closed; the taker is refunded in full.');
    expect(blockedReason('approve', { ...base, dryRun: true })).toBe('Dry run: the daemon sends no transaction.');
    // A Solana take outside window mode cannot be rejected; in window mode, or on Ethereum, it can.
    const take = { ...swap, direction: 'B' as const };
    expect(blockedReason('reject', { ...base, swap: { ...take, mode: 0 } })).toBe('A take on Solana outside window mode cannot be rejected; left alone, it lapses.');
    expect(blockedReason('reject', { ...base, swap: { ...take, mode: 1 } })).toBeNull();
    expect(blockedReason('reject', { ...base, swap: { ...take, chain: 'ethereum', mode: 0 } })).toBeNull();
    expect(blockedReason('approve', { ...base, swap: { ...take, mode: 0 } })).toBeNull();
    const deposit = { hold_until: 950 } as Parameters<typeof blockedReason>[1]['deposit'];
    expect(blockedReason('withhold', { ...base, swap: { ...swap, state: 'HOLD' }, deposit })).toBeNull();
    expect(blockedReason('withhold', { ...base, chainNow: 950, swap: { ...swap, state: 'HOLD' }, deposit })).toBe('The 30-minute hold has ended; the deposit returns to the taker.');
    expect(blockedReason('release', { ...base, chainNow: 950, swap: { ...swap, state: 'HOLD' }, deposit })).toBeNull();
    expect(blockedReason('abort', { ...base, swap: { ...swap, state: 'READY' } })).toBe('Ready is set; the swap can no longer be backed out of.');
    expect(blockedReason('release', { ...base, swap: { ...swap, state: 'DONE' } })).toBe('The swap is already settled.');
    expect(blockedReason('release', { ...base, swap: { ...swap, state: 'HOLD' }, instruction: { action: 'withhold', at: 1, status: 'pending', reason: null, tx: null } })).toBe('Your withhold is still waiting to be carried out.');
    expect(blockedReason('release', { ...base, swap: { ...swap, state: 'HOLD' }, instruction: { action: 'withhold', at: 1, status: 'refused', reason: 'hold-ended', tx: null } })).toBeNull();
  });

  it('disables approve and reject when the window closes while the page is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = mount('#/swaps');
    const table = await within(screen.getByRole('main')).findByRole('table');
    const row = within(table).getByRole('link', { name: `Swap ${REF.pendingSol}` }).closest('tr') as HTMLElement;
    expect((within(row).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      m.advance(45);
      vi.advanceTimersByTime(1_000);
    });
    expect((within(row).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(row).getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true);
    expect(text(within(row).getByTestId('blocked-reason'))).toBe('The approval window has closed; the taker is refunded in full.');
    expect(within(row).getByRole('button', { name: 'Approve' }).getAttribute('aria-describedby')).toBe(within(row).getByTestId('blocked-reason').id);
  });

  it('disables every action in dry run and says why', async () => {
    mount('#/swaps', { toml: DESIGN_BOTH_TOML });
    const table = await within(screen.getByRole('main')).findByRole('table');
    const row = within(table).getByRole('link', { name: `Swap ${REF.noticed}` }).closest('tr') as HTMLElement;
    await waitFor(() => expect((within(row).getByRole('button', { name: 'Abort swap' }) as HTMLButtonElement).disabled).toBe(true));
    expect(text(within(row).getByTestId('blocked-reason'))).toBe('Dry run: the daemon sends no transaction.');
  });
});

describe('registration: contact channels, onion address, link history, per-chain pause', () => {
  it('edits the contact channels and the onion address and publishes them', async () => {
    const m = mount('#/registration', { blobEndpoint: false });
    const card = await screen.findByRole('region', { name: 'Contact channels' });
    const form = within(card).getByRole('form', { name: 'Edit contact channels' });
    const publish = within(form).getByRole('button', { name: 'Publish with the operator key' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect((within(form).getByLabelText('Channel 1 kind') as HTMLSelectElement).value).toBe('2');
    expect((within(form).getByLabelText('Channel 1 value') as HTMLInputElement).value).toBe('#maker-desk:example.org');

    // A bad onion address and an over-long value are caught before anything is sent.
    await m.user.type(within(form).getByLabelText('Onion address'), 'not-an-onion');
    expect(text(form)).toContain('Error: The onion address must be a v3 address: 56 characters, then .onion.');
    expect(publish.disabled).toBe(true);
    await m.user.clear(within(form).getByLabelText('Onion address'));
    await m.user.click(within(form).getByRole('button', { name: 'Add a channel' }));
    expect(text(form)).toContain('Error: Channel 3 is empty.');
    await m.user.selectOptions(within(form).getByLabelText('Channel 3 kind'), '5');
    await m.user.type(within(form).getByLabelText('Channel 3 value'), 'https://blobs.example.org/xs');
    await m.user.click(within(form).getByRole('button', { name: 'Remove channel 2' }));
    const onion = `${'b'.repeat(56)}.onion`;
    await m.user.type(within(form).getByLabelText('Onion address'), onion);
    expect(publish.disabled).toBe(false);
    await m.user.click(publish);

    expect(text(await within(form).findByText('Sent to the registry.'))).toBeTruthy();
    const reg = await m.client.call('registration');
    expect(reg.solana.contacts).toEqual([
      { kind: 2, value: '#maker-desk:example.org' },
      { kind: 5, value: 'https://blobs.example.org/xs' },
    ]);
    expect(reg.solana.onion).toBe(onion);
    expect(reg.blob_endpoint).toBe(true);
    await waitFor(() => expect(text(card)).toContain(`Onion address${onion}`));
    expect(text(card)).toContain('Blob endpointListed');
    await waitFor(() => expect(publish.disabled).toBe(true));
  });

  it('warns before removing the last blob endpoint, and reports a refused publish', async () => {
    const m = mount('#/registration');
    const form = within(await screen.findByRole('region', { name: 'Contact channels' })).getByRole('form', { name: 'Edit contact channels' });
    await m.user.click(within(form).getByRole('button', { name: 'Remove channel 3' }));
    expect(text(form)).toContain('Warning: this leaves no blob endpoint (an onion address or a blob-endpoint channel). Ethereum markets need one and will be kept off.');
    m.daemon.failNext = 'the operator wallet has no SOL';
    await m.user.click(within(form).getByRole('button', { name: 'Publish with the operator key' }));
    expect(text(await within(form).findByRole('alert'))).toBe('Not published. the operator wallet has no SOL');
    expect((await m.client.call('registration')).solana.contacts).toHaveLength(3);
  });

  it('caps the channels at six', async () => {
    const m = mount('#/registration');
    const form = within(await screen.findByRole('region', { name: 'Contact channels' })).getByRole('form', { name: 'Edit contact channels' });
    const add = within(form).getByRole('button', { name: 'Add a channel' }) as HTMLButtonElement;
    for (let i = 0; i < 3; i++) await m.user.click(add);
    expect(add.disabled).toBe(true);
    expect(text(form)).toContain('at most 6, each up to 96 bytes');
  });

  it('shows the link history from both chains, and a new change as pending', async () => {
    const m = mount('#/registration');
    const link = await screen.findByRole('region', { name: 'Identity link' });
    const table = await within(link).findByRole('table', { name: 'Link history' });
    let rows = within(table).getAllByRole('row').slice(1).map(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(new RegExp(`^Ethereumno link${ADDR.solOwner} \\d{4}-`));
    expect(rows[1]).toMatch(new RegExp(`^Solanano link${ADDR.ethOwner} \\d{4}-`));
    expect(text(link)).toContain('This trace is public and cannot be removed.');

    const target = '0x00000000000000000000000000000000000000aa';
    await m.user.type(within(link).getByLabelText('Ethereum address to point at'), target);
    await m.user.click(within(link).getByRole('button', { name: 'Change the Solana pointer' }));
    const panel = await within(link).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    await m.user.type(within(panel).getByLabelText('Signed transaction (base64)'), 'A'.repeat(200));
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    await waitFor(() => expect(within(within(link).getByRole('table', { name: 'Link history' })).getAllByRole('row')).toHaveLength(4));
    rows = within(within(link).getByRole('table', { name: 'Link history' })).getAllByRole('row').slice(1).map(text);
    expect(rows[0]).toMatch(new RegExp(`^Solana${ADDR.ethOwner}${target}Pending \\d{4}-`));
  });

  it('shows link targets as the maker knows them', () => {
    expect(linkTarget(`0x${'00'.repeat(20)}`)).toBeNull();
    expect(linkTarget('0x')).toBeNull();
    expect(linkTarget(`0x${'ab'.repeat(20)}`)).toBe(`0x${'ab'.repeat(20)}`);
    expect(linkTarget(`0x${'01'.repeat(32)}`)).toBe('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');
    expect(linkTarget('0xabcd')).toBe('0xabcd');
  });

  it('shows the owner pause for each chain', async () => {
    const m = mount('#/registration');
    const card = await screen.findByRole('region', { name: 'Owner pause' });
    const chains = await within(card).findByTestId('owner-pause-chains');
    expect(text(chains)).toBe('SolanaOwner key: not paused EthereumOwner key: not paused');
    await confirm(m.user, card, 'Pause on Ethereum');
    const panel = await within(card).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    await m.user.type(within(panel).getByLabelText('Signed transaction (raw, 0x-hex)'), `0x02${'ab'.repeat(110)}`);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    await waitFor(() => expect(text(within(screen.getByRole('region', { name: 'Owner pause' })).getByTestId('owner-pause-chains'))).toBe('SolanaOwner key: not paused EthereumPaused by the owner key'));
  });
});

describe('acknowledging alerts and refills', () => {
  it('acknowledges an alert from the dashboard', async () => {
    const m = mount();
    const table = await screen.findByRole('table', { name: 'Alerts' });
    expect(within(table).getAllByRole('button', { name: /^Acknowledge alert/ })).toHaveLength(3);
    await m.user.click(within(table).getByRole('button', { name: /^Acknowledge alert: XMR is below its low level/ }));
    await waitFor(() => expect(within(table).getAllByRole('button', { name: /^Acknowledge alert/ })).toHaveLength(2));
    expect((await m.client.call('status')).alerts.find((a) => a.id === '8')?.acknowledged).toBe(true);
  });

  it('resolves an order a venue holds: refund', async () => {
    const m = mount('#/rebalancing');
    const table = await screen.findByRole('table', { name: 'Refills in transit' });
    const row = within(table).getByText('refill-29').closest('tr') as HTMLElement;
    await m.user.click(within(row).getByRole('button', { name: 'Refund' }));
    expect(text(within(row).getByRole('alertdialog'))).toContain('Ask FixedFloat to send the deposit back, minus its network fee.');
    await m.user.click(within(within(row).getByRole('alertdialog')).getByRole('button', { name: 'Refund' }));
    await waitFor(async () => expect((await m.client.call('rebalance')).refills.find((r) => r.id === 'refill-29')?.state).toBe('refunded'));
    // 60 SOL no longer sits with the venue.
    await waitFor(() => expect(text(screen.getByTestId('in-transit'))).toBe('$8,000'));
    expect(stat('In transit with third parties')).toContain('of a $50,000 cap');
  });

  it('continues a held order, or closes it as dealt with', async () => {
    const m = mount('#/rebalancing');
    const row = (): HTMLElement => within(screen.getByRole('table', { name: 'Refills in transit' })).getByText('refill-29').closest('tr') as HTMLElement;
    await screen.findByRole('table', { name: 'Refills in transit' });
    expect(within(row()).getByRole('button', { name: 'Close as dealt with' })).toBeTruthy();
    await confirm(m.user, row(), 'Continue');
    await waitFor(async () => expect((await m.client.call('rebalance')).refills.find((r) => r.id === 'refill-29')?.state).toBe('processing'));
    await waitFor(() => expect(within(row()).queryByRole('button', { name: 'Continue' })).toBeNull());
  });

  it('acknowledges a failed refill so it stops counting against the cap', async () => {
    const m = mount('#/rebalancing', { prepare: (d) => d.failRefill('refill-30', 'the venue returned an error') });
    const table = await screen.findByRole('table', { name: 'Refills in transit' });
    const row = within(table).getByText('refill-30').closest('tr') as HTMLElement;
    expect(text(row)).toContain('Failed');
    await waitFor(() => expect(text(screen.getByTestId('in-transit'))).toBe('$19,245'));
    await confirm(m.user, row, 'Acknowledge');
    await waitFor(() => expect(text(screen.getByTestId('in-transit'))).toBe('$11,245'));
  });
});

describe('configuration: errors the daemon finds on save', () => {
  it('places each daemon-side issue on its field and saves nothing', async () => {
    const m = mount('#/config');
    await screen.findByRole('region', { name: 'Markets and offers' });
    const reserve = screen.getByLabelText('XMR reserve');
    await m.user.clear(reserve);
    await m.user.type(reserve, '75');
    const real = m.client.call.bind(m.client);
    vi.spyOn(m.client, 'call').mockImplementation(((name: string, args: unknown) => {
      if (name === 'configPut') return Promise.reject(new ApiFailure(422, 'invalid_config', 'liquidity.xmr_reserve: the reserve exceeds the wallet balance', [{ path: 'liquidity.xmr_reserve', message: 'the reserve exceeds the wallet balance' }], []));
      return (real as (n: string, a: unknown) => Promise<unknown>)(name, args);
    }) as typeof m.client.call);
    const bar = screen.getByRole('region', { name: 'Save configuration' });
    await m.user.click(within(bar).getByRole('button', { name: 'Validate and save' }));
    const alert = await within(bar).findByRole('alert');
    expect(text(alert)).toContain('Not saved: 1 error has to be fixed first.');
    expect(text(alert)).toContain('liquidity.xmr_reserve: the reserve exceeds the wallet balance');
    expect(text(reserve.closest('.field'))).toContain('Error: the reserve exceeds the wallet balance');
    expect(reserve.getAttribute('aria-invalid')).toBe('true');
  });
});
