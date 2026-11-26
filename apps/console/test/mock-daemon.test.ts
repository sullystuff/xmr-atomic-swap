import { describe, expect, it } from 'vitest';
import { ROUTES, WS_CHANNELS, routePath, type RouteName, type WsServerMessage } from '@xmrswap/protocol/daemon-api';
import { ApiFailure, DaemonClient } from '../src/api/client.js';
import { parseToml, setPath, stringifyToml } from '../src/lib/config/toml.js';
import { MOCK_TOKEN, MockDaemon } from '../src/mock/daemon.js';
import { DEFAULT_TOML, REF } from '../src/mock/fixtures.js';
import { mockFetch, mockSockets } from '../src/mock/transport.js';
import { DESIGN_BOTH_TOML, DESIGN_CONFIG_TOML, DESIGN_REBALANCE_TOML } from './design.js';

function setup(opts: ConstructorParameters<typeof MockDaemon>[0] = {}) {
  let t = 1_795_000_000;
  const daemon = new MockDaemon({ now: () => t, ...opts });
  const client = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon) });
  return { daemon, client, advance: (s: number) => (t += s), now: () => t };
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

describe('mock daemon: transport rules', () => {
  it('answers every route of the frozen API', () => {
    const { daemon } = setup();
    const params = { ref: REF.noticed, id: 'msg-1' };
    for (const name of Object.keys(ROUTES) as RouteName[]) {
      if (name === 'ws') continue;
      const res = daemon.handle({ method: ROUTES[name].method, path: routePath(name, params), body: {}, authorization: `Bearer ${MOCK_TOKEN}` });
      // Whatever the body, a known route is never "method not allowed" and never the generic "not found".
      const error = (res.body as { error?: string }).error;
      expect(res.status, `${name} → ${res.status} ${error}`).not.toBe(405);
      expect(error, name).not.toBe('not_found');
      expect(error, name).not.toBe('internal');
    }
  });
  it('requires the bearer token', async () => {
    const { daemon } = setup();
    expect(daemon.handle({ method: 'GET', path: '/api/status' }).status).toBe(401);
    expect(daemon.handle({ method: 'GET', path: '/api/status', authorization: 'Bearer wrong' }).status).toBe(401);
    const bad = new DaemonClient({ token: 'wrong', fetch: mockFetch(daemon) });
    const e = await failure(bad.call('status'));
    expect(e.unauthorized).toBe(true);
  });
  it('distinguishes unknown paths from wrong methods', () => {
    const { daemon } = setup();
    const auth = `Bearer ${MOCK_TOKEN}`;
    expect(daemon.handle({ method: 'GET', path: '/api/nope', authorization: auth }).status).toBe(404);
    expect(daemon.handle({ method: 'DELETE', path: '/api/config', authorization: auth }).status).toBe(405);
    expect(daemon.handle({ method: 'GET', path: '/elsewhere', authorization: auth }).status).toBe(404);
  });
  it('reports an unreachable daemon as status 0', async () => {
    const { daemon } = setup();
    const client = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon, { offline: () => true }) });
    const e = await failure(client.call('status'));
    expect(e.unreachable).toBe(true);
  });
});

describe('mock daemon: configuration', () => {
  it('serves the file, the parsed view with defaults, the validation and a revision', async () => {
    const { client } = setup();
    const c = await client.call('configGet');
    expect(c.toml).toBe(DEFAULT_TOML);
    expect(c.validation.ok).toBe(true);
    expect(c.revision).toMatch(/^[0-9a-f]{16}$/);
    expect((c.parsed.markets as Record<string, Record<string, Record<string, unknown>>>).eth?.buy_xmr?.enabled).toBe(false);
  });
  it('validates without saving', async () => {
    const { client } = setup();
    const before = await client.call('configGet');
    const v = await client.call('configValidate', { body: { toml: '[markets.usdc_sol.sell_xmr]\nenabled = true\ndeposit_pct = 9\n' } });
    expect(v.ok).toBe(false);
    expect(v.errors[0]?.path).toBe('markets.usdc_sol.sell_xmr.deposit_pct');
    expect((await client.call('configGet')).revision).toBe(before.revision);
    const e = await failure(client.call('configValidate', { body: { toml: 'not = = toml' } }));
    expect(e.status).toBe(400);
    expect(e.code).toBe('invalid_toml');
  });
  it('applies a valid edit without a restart and records it in the change log', async () => {
    const { client, advance } = setup();
    const before = await client.call('configGet');
    const started = (await client.call('status')).started_at;
    advance(60);
    const edited = stringifyToml(setPath(parseToml(before.toml), 'offers.update_interval_seconds', 5));
    const after = await client.call('configPut', { body: { toml: edited, base_revision: before.revision } });
    expect(after.revision).not.toBe(before.revision);
    expect(after.validation.update_cost?.interval_secs).toBe(5);
    // Applied in place: the same process, and the offers already use the new interval.
    const status = await client.call('status');
    expect(status.started_at).toBe(started);
    expect((await client.call('offers')).update_cost?.daily_lamports).toBe('86400000');
    const log = (await client.call('configLog')).entries;
    expect(log[0]).toMatchObject({ source: 'api', revision: after.revision });
    expect(log[0]?.changes).toEqual([{ path: 'offers.update_interval_seconds', old: '15', new: '5' }]);
    expect(log[log.length - 1]?.source).toBe('file');
  });
  it('refuses an invalid file and a stale revision, changing nothing', async () => {
    const { client } = setup();
    const before = await client.call('configGet');
    const bad = stringifyToml(setPath(parseToml(before.toml), 'markets.usdc_sol.sell_xmr.deposit_pct', 7));
    const e = await failure(client.call('configPut', { body: { toml: bad, base_revision: before.revision } }));
    expect(e.status).toBe(422);
    expect(e.detail).toMatch(/deposit_pct/);
    const stale = await failure(client.call('configPut', { body: { toml: before.toml, base_revision: '0000000000000000' } }));
    expect(stale.status).toBe(409);
    expect(stale.code).toBe('revision_conflict');
    expect((await client.call('configGet')).revision).toBe(before.revision);
    expect((await client.call('configLog')).entries).toHaveLength(1);
  });
  it.each([
    ['the configuration example', DESIGN_CONFIG_TOML],
    ['the rebalancing example', DESIGN_REBALANCE_TOML],
    ['both examples together', DESIGN_BOTH_TOML],
  ])('imports %s from DESIGN unchanged and exports it back byte for byte', async (_, toml) => {
    const { client } = setup();
    const res = await client.call('configImport', { body: { toml } });
    expect(res.validation.ok).toBe(true);
    expect(res.toml).toBe(toml);
    expect((await client.call('configExport')).toml).toBe(toml);
    expect((await client.call('configLog')).entries[0]?.source).toBe('import');
    // DESIGN's file does not set a mode, so the daemon is in dry run: nothing is live.
    expect((await client.call('status')).mode).toBe('dry_run');
    expect((await client.call('offers')).offers.every((o) => !o.live)).toBe(true);
  });
  it('previews offers for an unsaved file', async () => {
    const { client } = setup();
    const saved = await client.call('offers');
    expect(saved.offers.find((o) => o.market === 'eth' && o.direction === 'sell_xmr')?.enabled).toBe(false);
    const draft = stringifyToml(setPath(parseToml(DEFAULT_TOML), 'markets.eth.sell_xmr.enabled', true));
    const preview = await client.call('offersPreview', { body: { toml: draft } });
    const eth = preview.offers.find((o) => o.market === 'eth' && o.direction === 'sell_xmr');
    expect(eth?.enabled).toBe(true);
    expect(eth?.live).toBe(false);
    expect((await client.call('offers')).offers.find((o) => o.market === 'eth' && o.direction === 'sell_xmr')?.enabled).toBe(false);
  });
  it('keeps Ethereum markets off without a blob endpoint', async () => {
    const { client } = setup({ blobEndpoint: false });
    const offers = (await client.call('offers')).offers;
    const eth = offers.find((o) => o.market === 'usdc_eth' && o.direction === 'sell_xmr');
    expect(eth?.enabled).toBe(false);
    expect(eth?.disabled_reason).toMatch(/blob endpoint/);
    expect((await client.call('registration')).blob_endpoint).toBe(false);
  });
});

describe('mock daemon: offers and fees', () => {
  it('accepts a pool-only configuration and refuses only a market its sources cannot price', async () => {
    const { client } = setup();
    const pool = '[pricing.sources.wxmr_pool]\ntoken = "T"\npool = "P"\nbase_vault = "B"\nquote_vault = "Q"\n';
    const one = `${pool}[liquidity]\noutput_ladder = [{ size_xmr = 5, count = 4 }]\n[markets.usdc_sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\n`;
    const ok = await client.call('configImport', { body: { toml: one } });
    expect(ok.validation.ok).toBe(true);
    expect(ok.validation.effective.map((e) => e.market)).toEqual(['usdc_sol']);
    expect((await client.call('offers')).offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr')?.enabled).toBe(true);
    // The SOL market from a USDC-quoted pool alone has no SOL/USD: refused, on that market's source, and nothing changes.
    const bad = await failure(client.call('configImport', { body: { toml: `${one}[markets.sol.sell_xmr]\nenabled = true\nsource = "wxmr_pool"\n` } }));
    expect([bad.status, bad.code]).toEqual([422, 'invalid_config']);
    expect(bad.issues.map((i) => i.path)).toEqual(['markets.sol.sell_xmr.source']);
    expect(bad.issues[0]?.message).toContain('needs XMR/SOL; wxmr_pool supplies XMR/USD and nothing here supplies SOL/USD');
    expect((await client.call('configGet')).toml).toBe(one);
  });
  it('lists eight offers and runs the market whose primary source is the wXMR pool, as chosen', async () => {
    const { client } = setup();
    const r = await client.call('offers');
    expect(r.offers).toHaveLength(8);
    const sol = r.offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr');
    expect(sol?.enabled).toBe(true);
    expect(sol?.live).toBe(true);
    expect(sol?.disabled_reason).toBeUndefined();
    expect(sol?.terms.approval_mode).toBe('window');
    // Nothing in the daemon's verdict demotes the pool or mentions the old rule.
    const v = (await client.call('configGet')).validation;
    expect(v.ok).toBe(true);
    expect(v.effective.map((e) => `${e.market}.${e.direction}`)).toContain('sol.sell_xmr');
    expect([...v.warnings, ...v.errors].map((i) => i.message).join(' ')).not.toMatch(/cross-check only|may only be a cross-check|promoted/i);
    // In the mock's file the pool's addresses are placeholders: it is the chosen primary, and CoinGecko prices the market until it can be read.
    expect(v.warnings.filter((w) => w.path === 'markets.sol.sell_xmr.source').map((w) => w.message)).toEqual(['wxmr_pool cannot be read yet: its addresses are placeholders or missing (base_vault and quote_vault are needed); it is skipped until they are set']);
    expect(sol).toMatchObject({ source: 'wxmr_pool', fallbacks: ['coingecko'], cross_check: 'coinmarketcap', priced_by: 'coingecko', price_unit: 'usd' });
    expect(r.offers.find((o) => o.market === 'usdc_sol' && o.direction === 'sell_xmr')).toMatchObject({ source: 'coingecko', priced_by: 'coingecko' });
    expect(r.update_cost?.daily_lamports).toBe('28800000');
    expect(r.occasional.map((o) => o.kind)).toEqual(['key_refill', 'key_rotation', 'quote_on_request', 'eth_registry']);
    expect(r.occasional.find((o) => o.kind === 'eth_registry')?.asset).toBe('eth');
  });
  it('reports actual spend, balances, runway and the alert threshold', async () => {
    const { client, daemon } = setup();
    const f = await client.call('fees');
    expect(f.runway_alert_days).toBe(7);
    expect(f.runway_days).toBeCloseTo(83.33, 2);
    expect(f.spent_24h.map((s) => s.asset)).toEqual(['sol', 'eth']);
    daemon.setOperatorLamports(100_000_000n);
    expect((await client.call('fees')).runway_days).toBeCloseTo(3.47, 2);
  });
});

describe('mock daemon: swaps, approvals, deposits', () => {
  it('filters and pages the swap list', async () => {
    const { client } = setup();
    const all = await client.call('swaps');
    expect(all.swaps).toHaveLength(12);
    expect(all.next_before).toBeNull();
    expect((await client.call('swaps', { body: { state: 'PENDING' } })).swaps).toHaveLength(3);
    expect((await client.call('swaps', { body: { chain: 'ethereum' } })).swaps).toHaveLength(3);
    expect((await client.call('swaps', { body: { open: false } })).swaps.every((s) => s.state === 'DONE')).toBe(true);
    const page = await client.call('swaps', { body: { limit: 5 } });
    expect(page.swaps).toHaveLength(5);
    const rest = await client.call('swaps', { body: { limit: 50, before: page.next_before as number } });
    expect(rest.swaps).toHaveLength(7);
  });
  it('approves inside the window and refuses after it', async () => {
    const { client, advance } = setup();
    const r = await client.call('swapApprove', { params: { ref: REF.pendingSol } });
    expect(r.ok).toBe(true);
    expect(r.tx?.status).toBe('confirmed');
    expect((await client.call('swap', { params: { ref: REF.pendingSol } })).state).toBe('ACTIVE');
    expect((await client.call('approvals')).pending.map((p) => p.ref)).not.toContain(REF.pendingSol);
    advance(120);
    const late = await failure(client.call('swapApprove', { params: { ref: REF.pendingEth } }));
    // The stored state no longer offers it: the daemon answers 409 action_unavailable (its A2).
    expect(late.status).toBe(409);
    expect(late.code).toBe('action_unavailable');
    // An expired window drops out of the queue.
    expect((await client.call('approvals')).pending).toEqual([]);
  });
  it('rejects with a reason and counts no-fault rejections apart', async () => {
    const { client } = setup();
    await client.call('swapReject', { params: { ref: REF.pendingDeny }, body: { reason: 1 } });
    const s = await client.call('swap', { params: { ref: REF.pendingDeny } });
    expect(s.state).toBe('DONE');
    expect(s.outcome).toBe('rejections_no_fault');
    const e = await failure(client.call('swapReject', { params: { ref: REF.pendingSol }, body: { reason: 7 as 0 } }));
    expect(e.status).toBe(400);
  });
  it('refuses an action the swap does not offer', async () => {
    const { client } = setup();
    const e = await failure(client.call('swapWithhold', { params: { ref: REF.ready } }));
    expect(e.status).toBe(409);
    expect(e.code).toBe('action_unavailable');
    expect((await failure(client.call('swap', { params: { ref: 'nope' } }))).status).toBe(404);
  });
  it('withholds only inside the 30-minute hold, publishing the evidence with it', async () => {
    const { client, advance } = setup();
    const w = await client.call('swapWithhold', { params: { ref: REF.held } });
    expect(w).toMatchObject({ ok: true, outcome: 'carried_out', detail: 'withhold: carried out' });
    const s = await client.call('swap', { params: { ref: REF.held } });
    expect(s.state).toBe('WITHHELD');
    expect(s.evidence_published).toBe(true);
    expect(s.actions).toEqual(['release']);
    expect((await client.call('deposits')).deposits.find((d) => d.ref === REF.held)?.state).toBe('withheld');

    const other = setup();
    other.advance(19 * 60);
    const late = await failure(other.client.call('swapWithhold', { params: { ref: REF.held } }));
    expect(late.code).toBe('action_unavailable');
    advance(1);
  });
  it('releases a withheld deposit and settles the swap', async () => {
    const { client } = setup();
    const r = await client.call('swapRelease', { params: { ref: REF.withheld } });
    expect(r.ok).toBe(true);
    expect((await client.call('deposits')).deposits.map((d) => d.ref)).toEqual([REF.held]);
    expect((await client.call('swap', { params: { ref: REF.withheld } })).outcome).toBe('releases');
  });
  it('issues and revokes advance approvals', async () => {
    const { client, now } = setup();
    const made = await client.call('approvalsAdvance', { body: { chain: 'ethereum', taker: '0xabc', max_xmr: '5000000000000', days: 30 } });
    expect(made.record).toMatchObject({ chain: 'ethereum', active: true, expires_at: now() + 30 * 86_400 });
    expect(made.sig.length).toBeGreaterThan(20);
    await client.call('approvalsRevoke', { body: { chain: 'ethereum', id: made.record.id } });
    expect((await client.call('approvals')).advance.find((a) => a.id === made.record.id)?.active).toBe(false);
    // Solana has no single revocation: bumping the epoch kills every outstanding approval.
    const single = await failure(client.call('approvalsRevoke', { body: { chain: 'solana', id: '18' } as never }));
    expect(single.status).toBe(400);
    await client.call('approvalsRevoke', { body: { chain: 'solana', all: true } });
    const after = await client.call('approvals');
    expect(after.advance.filter((a) => a.chain === 'solana').every((a) => !a.active)).toBe(true);
    expect(after.epochs.find((e) => e.chain === 'solana')?.approval_epoch).toBe(3);
  });
  it('sends nothing in dry run', async () => {
    const { client } = setup({ toml: DESIGN_BOTH_TOML });
    const e = await failure(client.call('swapApprove', { params: { ref: REF.pendingSol } }));
    expect(e.code).toBe('dry_run');
    expect((await failure(client.call('keysRotate'))).code).toBe('dry_run');
    const p = await client.call('pause', { body: {} });
    expect(p).toEqual({ paused: true, txs: [] });
  });
});

describe('mock daemon: inbox, keys, rebalancing, registration, pause', () => {
  it('threads replies beside the swap and marks messages read', async () => {
    const { client } = setup();
    const inbox = await client.call('inbox');
    expect(inbox.unread).toBe(2);
    const reply = await client.call('inboxReply', { params: { id: 'msg-1' }, body: { text: 'Released.' } });
    expect(reply).toMatchObject({ direction: 'out', swap_ref: REF.withheld, in_reply_to: 'msg-1' });
    expect((await client.call('inbox')).unread).toBe(1);
    expect((await client.call('swap', { params: { ref: REF.withheld } })).messages.map((m) => m.text)).toContain('Released.');
    await client.call('inboxRead', { params: { id: 'msg-2' } });
    expect((await client.call('inbox')).unread).toBe(0);
    expect((await failure(client.call('inboxReply', { params: { id: 'msg-1' }, body: { text: '  ' } }))).status).toBe(400);
  });
  it('rotates the key and keeps the retired one through its grace period', async () => {
    const { client, now } = setup();
    const before = await client.call('keys');
    expect(before.rotation_interval_hours).toBe(168);
    expect(before.next_rotation_at).toBe(now() - 30 * 3_600 + 168 * 3_600);
    const r = await client.call('keysRotate');
    expect(r.version).toBe(8);
    const after = await client.call('keys');
    expect(after.keys[0]).toMatchObject({ version: 8, current: true });
    expect(after.keys[1]).toMatchObject({ version: 7, current: false, expires_at: now() + 24 * 3_600, deleted_at: null });
    expect(after.next_rotation_at).toBe(now() + 168 * 3_600);
    expect((await client.call('registration')).solana.enc_key_version).toBe(8);
  });
  it('holds a refill for approval, enforces the in-transit cap and records manual refills', async () => {
    const { client } = setup();
    const state = await client.call('rebalance');
    expect(state.mode).toBe('approve');
    expect(state.max_in_transit_usd).toBe(50_000);
    // 8,000 USDC processing + 60 SOL held.
    expect(state.in_transit_usd).toBeCloseTo(8_000 + 60 * 187.42, 2);
    expect(state.venues.find((v) => v.id === 'stealthex')?.enabled).toBe(false);
    const run = await client.call('rebalanceRun', { body: { from: 'usdc_sol', to: 'xmr', amount_in: '40000000000', venue: 'wxmr_bridge' } });
    expect(run.state).toBe('awaiting_approval');
    const capped = await failure(client.call('rebalanceApprove', { params: { id: run.id } }));
    expect(capped.code).toBe('refill_refused');
    expect(capped.detail).toMatch(/above the cap of \$50,000/);
    const ok = await client.call('rebalanceApprove', { params: { id: 'refill-31' } });
    expect(ok.state).toBe('pending');
    expect((await client.call('rebalanceCancel', { params: { id: run.id } })).state).toBe('cancelled');
    expect((await failure(client.call('rebalanceCancel', { params: { id: 'refill-28' } }))).code).toBe('refill_refused');
    const manual = await client.call('rebalanceManual', { body: { from: 'usdc_sol', to: 'xmr', amount_in: '4100000000', amount_out: '9900000000000', note: 'OTC' } });
    expect(manual).toMatchObject({ venue: 'manual', state: 'done', detail: 'OTC' });
    expect((await failure(client.call('rebalanceRun', { body: { from: 'xmr', to: 'xmr', amount_in: '1' } }))).status).toBe(400);
  });
  it('builds unsigned owner transactions and applies a link change only after its delay', async () => {
    const { client, advance, now } = setup();
    const reg = await client.call('registration');
    expect(reg.solana.link.mutual).toBe(true);
    const built = await client.call('registrationTx', { body: { chain: 'solana', action: 'set_eth_link', eth_address: '0x00000000000000000000000000000000000000aa' } });
    expect(built.unsigned.chain).toBe('solana');
    expect(built.summary).toMatch(/takes effect after 7 days and stays on record/);
    expect((await failure(client.call('registrationSubmit', { body: { request_id: built.request_id, signed: 'garbage' } }))).code).toBe('bad_signature');
    const signed = 'A'.repeat(200);
    const tx = await client.call('registrationSubmit', { body: { request_id: built.request_id, signed } });
    expect(tx.chain).toBe('solana');
    let after = await client.call('registration');
    expect(after.solana.link).toMatchObject({ current: reg.solana.link.current, pending: '0x00000000000000000000000000000000000000aa', pending_effective_at: now() + 604_800, mutual: true });
    // The request id is single use.
    expect((await failure(client.call('registrationSubmit', { body: { request_id: built.request_id, signed } }))).status).toBe(404);
    advance(604_800);
    after = await client.call('registration');
    expect(after.solana.link).toMatchObject({ current: '0x00000000000000000000000000000000000000aa', pending: null, mutual: false });
    expect(after.ethereum.link.mutual).toBe(false);
  });
  it('requires the Solana registration before the Ethereum one', async () => {
    const { client, daemon } = setup();
    daemon.setRegistration((r) => {
      r.solana.registered = false;
      r.ethereum.registered = false;
    });
    const e = await failure(client.call('registrationTx', { body: { chain: 'ethereum', action: 'register_maker', owner: '0x1', operator: '0x2', payout: '0x3', solana_owner: 'S' } }));
    expect(e.code).toBe('solana_first');
  });
  it('pauses, optionally bumping the epochs, and resumes', async () => {
    const { client } = setup();
    const p = await client.call('pause', { body: { bump_epochs: true, reason: 'test' } });
    expect(p.paused).toBe(true);
    expect(p.txs).toHaveLength(4);
    expect((await client.call('status')).paused.operator).toBe(true);
    expect((await client.call('offers')).offers.every((o) => !o.live)).toBe(true);
    expect((await client.call('approvals')).epochs.map((e) => e.approval_epoch)).toEqual([3, 3]);
    expect((await client.call('resume')).paused).toBe(false);
    expect((await client.call('status')).paused.operator).toBe(false);
  });
  it('starts empty when asked', async () => {
    const { client } = setup({ empty: true });
    expect((await client.call('swaps')).swaps).toEqual([]);
    expect((await client.call('inbox')).items).toEqual([]);
    expect((await client.call('deposits')).deposits).toEqual([]);
    expect((await client.call('rebalance')).refills).toEqual([]);
    expect((await client.call('status')).alerts).toEqual([]);
  });
});

describe('mock daemon: WebSocket channels', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  it('sends a snapshot on subscribe, pushes on change and answers pings', async () => {
    const { daemon, client } = setup();
    const sockets = mockSockets(daemon);
    const live = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon), socket: sockets.factory });
    const seen: string[] = [];
    const states: string[] = [];
    const stop = live.live({ onData: (channel, _data, op) => seen.push(`${op}:${channel}`), onConnection: (s) => states.push(s) });
    await settle();
    expect(states).toEqual(['connecting', 'live']);
    expect(seen).toEqual(WS_CHANNELS.map((c) => `snapshot:${c}`));
    seen.length = 0;
    await client.call('swapRelease', { params: { ref: REF.withheld } });
    await settle();
    expect(seen).toEqual(['update:swaps', 'update:status']);
    daemon.ping();
    await settle();
    expect(daemon.connections).toBe(1);
    stop();
    await settle();
    expect(daemon.connections).toBe(0);
  });
  it('rejects unknown channels with an error message', () => {
    const { daemon } = setup();
    const out: WsServerMessage[] = [];
    const conn = daemon.connect((m) => out.push(m));
    conn.receive({ op: 'subscribe', channels: ['prices' as never] });
    expect(out).toEqual([{ op: 'error', error: 'unknown channel prices' }]);
  });
  it('reconnects after the daemon drops the socket', async () => {
    const { daemon } = setup();
    const sockets = mockSockets(daemon);
    const live = new DaemonClient({ token: MOCK_TOKEN, fetch: mockFetch(daemon), socket: sockets.factory, backoffMs: [5] });
    const states: string[] = [];
    const stop = live.live({ onData: () => undefined, onConnection: (s) => states.push(s) });
    await settle();
    sockets.dropAll();
    await new Promise((r) => setTimeout(r, 40));
    expect(states).toEqual(['connecting', 'live', 'offline', 'offline', 'live']);
    expect(sockets.opened).toBe(2);
    stop();
  });
  it('refuses a socket with the wrong token', async () => {
    const { daemon } = setup();
    const sockets = mockSockets(daemon);
    const live = new DaemonClient({ token: 'wrong', fetch: mockFetch(daemon), socket: sockets.factory, backoffMs: [10_000] });
    const states: string[] = [];
    const stop = live.live({ onData: () => undefined, onConnection: (s) => states.push(s) });
    await settle();
    expect(states).toEqual(['connecting', 'offline']);
    expect(sockets.opened).toBe(0);
    stop();
  });
});
