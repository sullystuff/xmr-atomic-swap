// Console contract: the real daemon API (fakes behind it) driven by the console's own client
// (`apps/console/src/api/client.ts`, imported read-only). Every route the client can call is
// exercised with its status code and response shape, plus the routes and codes the console asked for.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { ROUTES, WS_CHANNELS, type WsChannel } from '@xmrswap/protocol/daemon-api';
import { ata, seedSigner } from '@xmrswap/sdk';
import { ApiFailure, DaemonClient } from '../../../apps/console/src/api/client.js';
import { type ApiServer, startApi } from '../src/api/server.js';
import type { Daemon } from '../src/daemon.js';
import { XMR } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

let w: World;
let d: Daemon;
let api: ApiServer;
let client: DaemonClient;
let dry: { d: Daemon; api: ApiServer; client: DaemonClient };
const called = new Set<string>();

const TOML = `${BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\napproval_mode = "window"\ndeposit_pct = 2')}
[approvals]
auto_max_xmr = 1

[rebalance]
mode = "approve"
`;

async function call<N extends Parameters<DaemonClient['call']>[0]>(c: DaemonClient, name: N, args: Parameters<DaemonClient['call']>[1] = {}): Promise<any> {
  called.add(name);
  return c.call(name, args as never);
}
const failure = async (p: Promise<unknown>): Promise<ApiFailure> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiFailure) return e;
    throw e;
  }
  throw new Error('the call succeeded');
};

beforeAll(async () => {
  await init();
  w = await makeWorld(TOML);
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, 10_000_000_000n, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
  // The built console, served from the API's own origin.
  const consoleDir = path.join(w.dir, 'console');
  mkdirSync(consoleDir);
  writeFileSync(path.join(consoleDir, 'index.html'), '<!doctype html><title>maker console</title>');
  writeFileSync(w.configPath, `${TOML.replaceAll('__OWNER__', w.sim.owner).replace('[daemon]', `[daemon]\nconsole_dir = "${consoleDir}"\ncors_origins = ["http://localhost:5173"]`)}`);
  d = await w.boot();
  await d.start();
  api = await startApi(d, { bind: '127.0.0.1:0' });
  client = new DaemonClient({ baseUrl: api.url, token: d.token });
  const dw = await makeWorld(BASE_TOML.replace('mode = "live"', 'mode = "dry_run"'));
  const dd = await dw.boot();
  await dd.start();
  const dapi = await startApi(dd, { bind: '127.0.0.1:0' });
  dry = { d: dd, api: dapi, client: new DaemonClient({ baseUrl: dapi.url, token: dd.token }) };
});
afterAll(async () => {
  await api?.close();
  await dry?.api.close();
  d?.store.close();
  dry?.d.store.close();
});

describe('console contract', () => {
  it('requires the bearer token; binds to loopback', async () => {
    expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const e = await failure(new DaemonClient({ baseUrl: api.url, token: 'wrong' }).call('status'));
    expect(e).toMatchObject({ status: 401, code: 'unauthorized' });
    expect((await fetch(`${api.url}/api/status`)).status).toBe(401);
    expect((await failure(client.call('swap', { params: { ref: 'nope' } }))).status).toBe(404);
    const unknown = await fetch(`${api.url}/api/nope`, { headers: { Authorization: `Bearer ${d.token}` } });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: 'not_found' }]);
  });

  it('status', async () => {
    const s = await call(client, 'status');
    expect(s).toMatchObject({ version: '0.1.0', mode: 'live', maker: { solana: w.sim.makerPda, ethereum: null }, paused: { owner: false, operator: false, guardrails: [], chains: [{ chain: 'solana', owner: false, operator: false }] }, needs_review: 0, tor: { enabled: false } });
    expect(s.chains).toHaveLength(1);
    expect(s.chains[0]).toMatchObject({ chain: 'solana', connected: true, network_ok: true, endpoint: 'TEST_SOL_RPC', chain_time: Number(w.sim.now) });
    expect(typeof s.core_version).toBe('string');
    expect(Array.isArray(s.alerts)).toBe(true);
    await d.refreshMonero();
    expect((await call(client, 'status')).monero).toMatchObject({ agree: true, wallet_rpc_ok: true, nodes: [{ ok: true }, { ok: true }] });
  });

  it('configuration: get, validate, put, log, export, import; the mock\'s error codes with structured issues', async () => {
    const got = await call(client, 'configGet');
    expect(Object.keys(got).sort()).toEqual(['parsed', 'revision', 'toml', 'validation']);
    expect(got.validation).toMatchObject({ ok: true, errors: [] });
    expect(got.validation.effective.map((e: { market: string }) => e.market)).toEqual(['usdc_sol', 'sol']);
    // The daily-cost estimate carries the dollar figure (SOL/USD from the daemon's own reference).
    expect(got.validation.update_cost).toMatchObject({ interval_secs: 15, lamports_per_update: '5000', daily_lamports: '28800000', daily_usd: expect.closeTo(2.88, 6) });
    const edited = got.toml.replace('auto_max_xmr = 1', 'auto_max_xmr = 1.5');
    const v = await call(client, 'configValidate', { body: { toml: edited } });
    expect(v).toMatchObject({ ok: true });
    const bad = await call(client, 'configValidate', { body: { toml: `${edited}\n[markets.usdc_sol.sell_xmr]\nenabled = true\nmax_xmr = 100\nclaim_delay_minutes = 60\n` } });
    expect(bad).toMatchObject({ ok: false, errors: [{ path: 'markets.usdc_sol.sell_xmr' }] });

    const put = await call(client, 'configPut', { body: { toml: edited, base_revision: got.revision } });
    expect(put.revision).not.toBe(got.revision);
    expect(put.parsed.approvals.auto_max_xmr).toBe(1.5);
    // A stale base revision, a refused configuration and a syntax error: the codes the console was built against.
    expect(await failure(client.call('configPut', { body: { toml: edited, base_revision: got.revision } }))).toMatchObject({ status: 409, code: 'revision_conflict' });
    const refused = await fetch(`${api.url}/api/config`, { method: 'PUT', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ toml: `${edited}\n[liquidity2]\nx = 1\n`, base_revision: put.revision }) });
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { error: string; detail: string; issues: { path: string; message: string }[] };
    expect(body.error).toBe('invalid_config');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toEqual({ path: expect.any(String), message: expect.any(String) });
    expect(await failure(client.call('configPut', { body: { toml: 'x = = 1', base_revision: put.revision } }))).toMatchObject({ status: 400, code: 'invalid_toml' });
    expect(await failure(client.call('configPut', { body: { toml: edited } as never }))).toMatchObject({ status: 400, code: 'bad_request' });

    const log = await call(client, 'configLog');
    expect(log.entries[0]).toMatchObject({ revision: put.revision, source: 'api', changes: [{ path: 'approvals.auto_max_xmr', old: '1', new: '1.5' }] });
    const exported = await call(client, 'configExport');
    expect(exported).toEqual({ toml: edited, exported_at: expect.any(Number) });
    const imported = await call(client, 'configImport', { body: { toml: got.toml } });
    expect(imported.revision).toBe(got.revision);
    expect((await call(client, 'configLog')).entries[0].source).toBe('import');
    expect(await failure(client.call('configImport', { body: { toml: '[nope]\n' } }))).toMatchObject({ status: 422, code: 'invalid_config' });
  });

  it('registration: status, unsigned owner transactions, submit; published settings and link history', async () => {
    const reg = await call(client, 'registration');
    expect(reg.solana).toMatchObject({ registered: true, maker: w.sim.makerPda, operator: w.keystore.solana.publicKey, link: { current: null, pending: null, mutual: false } });
    expect(reg.ethereum).toMatchObject({ registered: false });
    const tx = await call(client, 'registrationTx', { body: { chain: 'solana', action: 'set_payout', payout: w.sim.taker } });
    expect(tx).toMatchObject({ request_id: expect.any(String), summary: expect.any(String), unsigned: { chain: 'solana', fee_payer: w.sim.owner, message_b64: expect.any(String), recent_blockhash: expect.any(String) } });
    expect(await failure(client.call('registrationTx', { body: { chain: 'solana', action: 'register_maker', owner: w.sim.owner, operator: w.sim.taker, payout: w.sim.taker } }))).toMatchObject({ status: 409, code: 'already_registered' });
    expect(await failure(client.call('registrationTx', { body: { chain: 'ethereum', action: 'set_paused', paused: true } }))).toMatchObject({ status: 409, code: 'not_registered' });
    expect(await failure(client.call('registrationSubmit', { body: { request_id: 'nope', signed: 'AAAA' } }))).toMatchObject({ status: 404, code: 'unknown_request' });
    expect(await failure(client.call('registrationSubmit', { body: { request_id: tx.request_id, signed: 'AAAA' } }))).toMatchObject({ status: 400, code: 'bad_signature' });
    called.add('registrationSubmit');
    // Not in the frozen API: edit the contact channels and the onion address; read the link's trace.
    const onion = `${'c'.repeat(56)}.onion`;
    const res = await fetch(`${api.url}/api/registration/published`, { method: 'PUT', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ onion, contacts: [{ kind: 4, value: '@maker' }] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tx: { chain: 'solana', status: 'sent' }, registration: { solana: { onion, contacts: [{ kind: 4, value: '@maker' }] }, blob_endpoint: true } });
    const badOnion = await fetch(`${api.url}/api/registration/published`, { method: 'PUT', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ onion: 'example.com' }) });
    expect(badOnion.status).toBe(400);
    const links = await fetch(`${api.url}/api/registration/links`, { headers: { Authorization: `Bearer ${d.token}` } });
    expect([links.status, await links.json()]).toEqual([200, { entries: [] }]);
  });

  it('offers and the dry-run preview', async () => {
    const o = await call(client, 'offers');
    expect(o.offers).toHaveLength(8);
    const sol = o.offers.find((x: { market: string; direction: string }) => x.market === 'sol' && x.direction === 'sell_xmr');
    expect(sol).toMatchObject({ live: true, enabled: true, reference_price: '1500000000', price_tiers: [{ above_xmr: '0', price: '1530000000' }], min_xmr: '100000000000', max_xmr: '20000000000000', key_pool: { size: 16, available: 16 }, terms: { approval_mode: 'window', deposit_bps: 200 } });
    // The price sources as the file names them (no demotion, no "effective" source), and the one pricing it right now.
    expect(sol).toMatchObject({ source: 'coingecko', fallbacks: [], cross_check: null, priced_by: 'coingecko', price_unit: 'usd' });
    expect(sol).not.toHaveProperty('demoted');
    expect(o.offers.find((x: { market: string }) => x.market === 'eth')).toMatchObject({ enabled: false, live: false, disabled_reason: 'switched off' });
    expect(o).toMatchObject({ update_cost: { daily_lamports: '28800000' }, spent_24h_lamports: expect.stringMatching(/^\d+$/), sol_usd: 100, compute_units_per_update: 24_120 });
    expect(o.occasional.map((x: { kind: string }) => x.kind)).toEqual(['key_refill', 'key_rotation', 'quote_on_request', 'eth_registry']);
    const sent = w.sim.fake.sent.length;
    const preview = await call(client, 'offersPreview', { body: { toml: d.load.toml.replace('enabled = true\napproval_mode = "window"', 'enabled = true\ndeviation_pct = 10\napproval_mode = "window"') } });
    expect(preview.offers.find((x: { market: string; direction: string }) => x.market === 'sol' && x.direction === 'sell_xmr')).toMatchObject({ live: false, enabled: true, price_tiers: [{ price: '1650000000' }] });
    expect(w.sim.fake.sent.length).toBe(sent); // a preview posts nothing
    expect(await failure(client.call('offersPreview', { body: { toml: '[nope]\n' } }))).toMatchObject({ status: 422, code: 'invalid_config' });
  });

  it('swaps, approvals and manual actions', async () => {
    const small = w.sim.open({ direction: 0, mode: 1, xmr: XMR, depBps: 200 });
    const large = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    const third = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    await d.executor.tick();
    const list = await call(client, 'swaps', { body: { open: true, chain: 'solana' } });
    expect(list.swaps.map((s: { ref: string }) => s.ref).sort()).toEqual([small.pda, large.pda, third.pda].sort());
    const summary = list.swaps.find((s: { ref: string }) => s.ref === large.pda);
    expect(summary).toMatchObject({ chain: 'solana', market: 'sol', direction: 'A', state: 'PENDING', phase: 'pending_approval', taker: w.sim.taker, xmr: (2n * XMR).toString(), depth: 2, outcome: null, needs_review: false, actions: ['approve', 'reject'], next_deadline: { at: Number(w.sim.swap(large.pda)!.tPendingDeadline), label: expect.any(String) } });
    expect(list.next_before).toBeNull();
    expect((await call(client, 'swaps', { body: { state: 'DONE' } })).swaps).toEqual([]);
    expect((await call(client, 'swaps', { body: { limit: 1 } })).next_before).toEqual(expect.any(Number));

    const approvals = await call(client, 'approvals');
    expect(approvals.pending.map((p: { ref: string }) => p.ref).sort()).toEqual([large.pda, third.pda].sort());
    expect(approvals.pending[0]).toMatchObject({ chain: 'solana', market: 'sol', direction: 'A', recommendation: 'approve', reasons: ['above auto_max_xmr: waiting for the maker'], dleq_ok: null, deadline: expect.any(Number) });
    expect(approvals.epochs).toEqual([{ chain: 'solana', approval_epoch: 1, quote_epoch: 1 }]);

    const approved = await call(client, 'swapApprove', { params: { ref: large.pda } });
    expect(approved).toMatchObject({ ok: true, tx: { chain: 'solana', id: expect.any(String) } });
    const rejected = await call(client, 'swapReject', { params: { ref: third.pda }, body: { reason: 0 } });
    expect(rejected.ok).toBe(true);
    expect(w.sim.names(third.pda)).toEqual(['lock', 'reject']);
    expect(await failure(client.call('swapReject', { params: { ref: third.pda }, body: { reason: 0 } }))).toMatchObject({ status: 409, code: 'action_unavailable' });
    expect(await failure(client.call('swapApprove', { params: { ref: 'unknown' } }))).toMatchObject({ status: 404, code: 'unknown_swap' });

    const detail = await call(client, 'swap', { params: { ref: large.pda } });
    expect(detail).toMatchObject({ ref: large.pda, state: 'NOTICED', phase: 'xmr_relayed', joint_address: expect.stringMatching(/^4/), lock_txid: w.xmr.relaysOf('wallet')[1] ?? w.xmr.relaysOf('wallet')[0], evidence_published: false, last_error: null, messages: [], actions: ['abort'] });
    expect(detail.deadlines).toMatchObject({ t_lock: expect.any(Number), t_notice: expect.any(Number), t_cut: expect.any(Number), t_claim_open: expect.any(Number), t_final: expect.any(Number), t_exp: expect.any(Number), t_ready: null, t_refund: null });
    expect(detail.intents.map((i: { kind: string; status: string }) => `${i.kind}:${i.status}`)).toEqual(['sol_tx:approve:confirmed', 'xmr_prepare:confirmed', 'sol_tx:post_notice:confirmed', 'xmr_relay:confirmed']);

    // The taker refunds the small one: the deposit is held; withhold, then release, from the console.
    w.xmr.mine(1);
    w.sim.takerCall(small.pda, { name: 'refund', secretOk: true }, { revealed: small.keys.spend });
    await d.executor.tick();
    const deposits = await call(client, 'deposits');
    expect(deposits.deposits).toEqual([expect.objectContaining({ ref: small.pda, state: 'held', deposit: '3000000', evidence_required: true, policy_decision: 'none', release_requested: false })]);
    expect((await call(client, 'swapWithhold', { params: { ref: small.pda } })).ok).toBe(true);
    expect((await call(client, 'deposits')).deposits[0].state).toBe('withheld');
    expect((await call(client, 'swap', { params: { ref: small.pda } })).evidence_published).toBe(true);
    expect((await call(client, 'swapRelease', { params: { ref: small.pda } })).ok).toBe(true);
    expect(w.sim.names(small.pda)).toContain('release_deposit');
    // Abort the approved one; the evidence follows by itself, so the manual action has nothing left to do.
    expect((await call(client, 'swapAbort', { params: { ref: large.pda } })).ok).toBe(true);
    expect(w.sim.names(large.pda)).toContain('abort');
    expect(await failure(client.call('swapPublishEvidence', { params: { ref: third.pda } }))).toMatchObject({ status: 409, code: 'action_unavailable' });
    called.add('swapPublishEvidence');
  });

  it('advance approvals: issue, list, revoke', async () => {
    const issued = await call(client, 'approvalsAdvance', { body: { chain: 'solana', taker: w.sim.taker, market: 'sol', direction: 'A', max_xmr: (5n * XMR).toString(), days: 7 } });
    expect(issued).toMatchObject({ sig: expect.any(String), record: { chain: 'solana', taker: w.sim.taker, market: 'sol', direction: 'A', max_xmr: (5n * XMR).toString(), epoch: 1, active: true } });
    expect((await call(client, 'approvals')).advance).toHaveLength(1);
    expect(await failure(client.call('approvalsAdvance', { body: { chain: 'solana', taker: w.sim.taker, max_xmr: '0', days: 7 } }))).toMatchObject({ status: 400, code: 'bad_request' });
    expect(await failure(client.call('approvalsRevoke', { body: { chain: 'solana', id: 'x' } as never }))).toMatchObject({ status: 400 });
    const revoked = await call(client, 'approvalsRevoke', { body: { chain: 'solana', all: true } });
    expect(revoked.txs).toEqual([{ chain: 'solana', id: expect.any(String), status: 'sent' }]);
    expect(w.sim.maker().approvalEpoch).toBe(2);
    expect((await call(client, 'approvals')).advance[0].active).toBe(false);
  });

  it('inventory', async () => {
    const inv = await call(client, 'inventory');
    expect(inv).toMatchObject({ xmr: { balance: expect.stringMatching(/^\d+$/), unlocked: expect.stringMatching(/^\d+$/), reserve: '0', in_flight: expect.stringMatching(/^\d+$/) }, capacity_xmr: expect.stringMatching(/^\d+$/) });
    expect(inv.ladder).toEqual([{ size_xmr: '5000000000000', target_count: 4, unlocked_count: expect.any(Number), locked_count: expect.any(Number) }]);
    expect(inv.outputs[0]).toEqual({ key_image: expect.any(String), amount: expect.any(String), unlocked: expect.any(Boolean), blocks_to_unlock: expect.any(Number), frozen: true, reserved_for: inv.outputs[0].reserved_for });
    expect(inv.outputs.some((o: { reserved_for: string | null }) => o.reserved_for === null)).toBe(true);
    expect(inv.paying.find((p: { asset: string }) => p.asset === 'usdc_sol')).toEqual({ asset: 'usdc_sol', balance: '10000000000', cap: null, escrowed: '0' });
    const split = await call(client, 'inventorySplit', { body: {} });
    expect(split).toEqual({ txids: expect.any(Array), created: expect.any(Number) });
    expect(await failure(client.call('inventorySplit', { body: { ladder: [{ size_xmr: 'five', count: 1 }] } }))).toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('inbox', async () => {
    const { contactKeys, sealToMaker } = await import('@xmrswap/sdk');
    const contact = contactKeys(new Uint8Array(32).fill(42), w.sim.makerPda);
    await d.inbox.handle(sealToMaker({ message: { t: 'inbox', text: 'hello maker' }, ownEncSecret: contact.encSecret, maker: w.sim.maker(), transport: 'tor' }), 'tor');
    const inbox = await call(client, 'inbox');
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0]).toEqual({ id: expect.stringMatching(/^[0-9a-f]{64}$/), at: expect.any(Number), direction: 'in', transport: 'tor', type: 'inbox', swap_ref: null, peer: expect.any(String), text: 'hello maker', action: null, read: false, in_reply_to: null });
    const id = inbox.items[0].id;
    expect(await call(client, 'inboxRead', { params: { id } })).toMatchObject({ id, read: true });
    expect(await call(client, 'inboxReply', { params: { id }, body: { text: 'hello taker' } })).toMatchObject({ direction: 'out', type: 'inbox_reply', in_reply_to: id, text: 'hello taker' });
    expect(await failure(client.call('inboxReply', { params: { id }, body: { text: '' } }))).toMatchObject({ status: 400, code: 'bad_request' });
    expect(await failure(client.call('inboxReply', { params: { id }, body: { text: 'x'.repeat(2001) } }))).toMatchObject({ status: 400, code: 'too_long' });
    expect(await failure(client.call('inboxRead', { params: { id: 'nope' } }))).toMatchObject({ status: 404, code: 'unknown_message' });
  });

  it('rebalancing', async () => {
    const r = await call(client, 'rebalance');
    expect(r).toMatchObject({ mode: 'approve', in_transit_usd: 0, max_in_transit_usd: null, refills: [] });
    expect(r.levels.map((l: { asset: string }) => l.asset)).toEqual(['xmr', 'sol', 'eth', 'usdc_sol', 'usdc_eth']);
    expect(r.venues).toHaveLength(6);
    expect(r.venues[0]).toEqual({ id: 'wxmr_bridge', enabled: false, mode: 'approve', healthy: false, reason: 'not enabled', cooldown_until: null });
    const manual = await call(client, 'rebalanceManual', { body: { from: 'usdc_sol', to: 'xmr', amount_in: '1500000000', amount_out: (10n * XMR).toString(), note: 'desk' } });
    expect(manual).toMatchObject({ venue: 'manual', state: 'done', from: 'usdc_sol', to: 'xmr', detail: 'desk' });
    // No venue is enabled: a run is recorded as not started, with the reason.
    const run = await call(client, 'rebalanceRun', { body: { from: 'usdc_sol', to: 'xmr', amount_in: '1000000000' } });
    expect(run).toMatchObject({ from: 'usdc_sol', to: 'xmr', txids: [] });
    expect(['cancelled', 'awaiting_approval']).toContain(run.state);
    expect(await failure(client.call('rebalanceRun', { body: { from: 'xmr', to: 'xmr', amount_in: '1' } }))).toMatchObject({ status: 400, code: 'bad_request' });
    expect(await failure(client.call('rebalanceRun', { body: { from: 'sol', to: 'xmr' } }))).toMatchObject({ status: 400 });
    expect(await failure(client.call('rebalanceApprove', { params: { id: 'nope' } }))).toMatchObject({ status: 404, code: 'unknown_refill' });
    expect(await failure(client.call('rebalanceCancel', { params: { id: 'nope' } }))).toMatchObject({ status: 404, code: 'unknown_refill' });
    called.add('rebalanceApprove').add('rebalanceCancel');
    const ack = await fetch(`${api.url}/api/rebalance/ack/nope`, { method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(ack.status).toBe(404);
  });

  it('keys, stats, fees, pause and resume, alert acknowledgement', async () => {
    const keys = await call(client, 'keys');
    expect(keys).toMatchObject({ rotation_interval_hours: 0, grace_hours: 24, next_rotation_at: null, keys: [{ version: 1, current: true, public_key: expect.stringMatching(/^[0-9a-f]{64}$/), deleted_at: null }] });
    const rotated = await call(client, 'keysRotate');
    expect(rotated).toEqual({ version: 2, tx: { chain: 'solana', id: expect.any(String), status: 'sent' } });
    const stats = await call(client, 'stats');
    expect(stats).toMatchObject({ since: 0, fills: 0, volume: [], counters: [{ chain: 'solana', values: expect.any(Object) }], rates: { approval: expect.any(Number) }, missed_deadlines: 0 });
    const fees = await call(client, 'fees');
    expect(fees).toMatchObject({ estimate: { daily_lamports: '28800000', daily_usd: expect.any(Number) }, runway_alert_days: 7, runway_days: expect.any(Number), sol_usd: 100, compute_units_per_update: 24_120 });
    expect(fees.operator_balances.find((b: { asset: string }) => b.asset === 'sol')).toEqual({ chain: 'solana', asset: 'sol', balance: '50000000000' });
    expect(fees.spent_24h[0]).toEqual({ asset: 'sol', amount: expect.stringMatching(/^\d+$/), usd: expect.any(Number) });

    const paused = await call(client, 'pause', { body: { bump_epochs: true, reason: 'contract test' } });
    expect(paused).toEqual({ paused: true, txs: [{ chain: 'solana', id: expect.any(String), status: 'sent' }] });
    expect(w.sim.maker().paused & 2).toBe(2);
    expect((await call(client, 'status')).paused).toMatchObject({ operator: true, chains: [{ chain: 'solana', owner: false, operator: true }] });
    expect((await call(client, 'offers')).offers.find((o: { market: string; direction: string }) => o.market === 'sol' && o.direction === 'sell_xmr')).toMatchObject({ enabled: false, disabled_reason: 'paused: contract test' });
    expect(await call(client, 'resume')).toMatchObject({ paused: false });
    expect(w.sim.maker().paused).toBe(0);

    const alert = d.alerts.raise('warning', 'contract', 'acknowledge me')!;
    const ack = await fetch(`${api.url}/api/alerts/${alert.id}/ack`, { method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect([ack.status, ((await ack.json()) as { acknowledged: boolean }).acknowledged]).toEqual([200, true]);
    expect((await fetch(`${api.url}/api/alerts/999999/ack`, { method: 'POST', headers: { Authorization: `Bearer ${d.token}` } })).status).toBe(404);
  });

  it('refuses chain-sending actions in dry run with 409 dry_run', async () => {
    for (const p of [dry.client.call('keysRotate'), dry.client.call('inventorySplit', { body: {} }), dry.client.call('approvalsRevoke', { body: { chain: 'solana', all: true } })]) expect(await failure(p)).toMatchObject({ status: 409, code: 'dry_run' });
    expect((await dry.client.call('status')).mode).toBe('dry_run');
    // The pause switch still works locally; nothing is sent.
    expect(await dry.client.call('pause', { body: {} })).toEqual({ paused: true, txs: [] });
  });

  it('WebSocket: the token rides in the query; a snapshot per channel on subscribe, then updates', async () => {
    const got = new Map<string, string[]>();
    const states: string[] = [];
    const stop = client.live({ onData: (channel, _data, op) => got.set(channel, [...(got.get(channel) ?? []), op]), onConnection: (s) => states.push(s) });
    called.add('ws');
    for (let i = 0; i < 100 && WS_CHANNELS.some((c) => !got.has(c)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(states).toContain('live');
    for (const c of WS_CHANNELS as readonly WsChannel[]) expect(got.get(c)?.[0], c).toBe('snapshot');
    d.alerts.raise('info', 'ws', 'pushed');
    for (let i = 0; i < 100 && !(got.get('alerts') ?? []).includes('update'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(got.get('alerts')).toContain('update');
    stop();
    // No token, or a wrong one: the upgrade is refused.
    const refused = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${api.url.replace('http', 'ws')}/api/ws?token=wrong`);
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('refused');
    });
    expect(refused).toBe('refused');
  });

  it('serves the built console from the same origin; other origins only when listed', async () => {
    const page = await fetch(`${api.url}/`);
    expect([page.status, await page.text()]).toEqual([200, '<!doctype html><title>maker console</title>']);
    expect((await fetch(`${api.url}/swaps/some/deep/link`)).status).toBe(200); // the console routes client-side
    const allowed = await fetch(`${api.url}/api/status`, { headers: { Authorization: `Bearer ${d.token}`, Origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const other = await fetch(`${api.url}/api/status`, { headers: { Authorization: `Bearer ${d.token}`, Origin: 'http://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${api.url}/api/config`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT' } });
    expect(preflight.status).toBe(204);
  });

  it('every route of the frozen API was exercised through the console\'s client', () => {
    expect([...called].sort()).toEqual(Object.keys(ROUTES).sort());
  });
});

describe('console requests (apps/console DEVIATIONS "Requests to the daemon")', () => {
  const get = async (p: string) => (await fetch(`${api.url}${p}`, { headers: { Authorization: `Bearer ${d.token}` } })).json() as Promise<any>;
  const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const programData = seedSigner(new Uint8Array(32).fill(0x70)).publicKey;
  const authority = seedSigner(new Uint8Array(32).fill(1)).publicKey;
  function setProgram(auth: string | null): void {
    const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');
    const program = new Uint8Array(36);
    new DataView(program.buffer).setUint32(0, 2, true);
    program.set(new PublicKey(programData).toBytes(), 4);
    w.sim.fake.setAccount(w.sim.programId, LOADER, program);
    const pd = new Uint8Array(45 + 16);
    new DataView(pd.buffer).setUint32(0, 3, true);
    if (auth) {
      pd[12] = 1;
      pd.set(new PublicKey(auth).toBytes(), 13);
    }
    w.sim.fake.setAccount(programData, LOADER, pd);
  }

  it('1. upgrade status is read from the ProgramData account: unknown with a reason, upgradable with its authority, immutable', async () => {
    await d.refreshUpgrade();
    let c = (await get('/api/status')).chains[0];
    expect(c).toMatchObject({ upgradeable: null, upgrade_authority: null, upgrade_status: 'unknown', upgrade_reason: 'the program account was not found at this endpoint' });
    setProgram(authority);
    await d.refreshUpgrade();
    c = (await get('/api/status')).chains[0];
    expect(c).toMatchObject({ upgradeable: true, upgrade_authority: authority, upgrade_status: 'upgradable', upgrade_reason: null, upgrade_implementation: programData, upgrade_checked_at: expect.any(Number) });
    // The authority is revoked: immutable, and nobody is named.
    setProgram(null);
    await d.housekeeping(); // the periodic refresh
    c = (await get('/api/status')).chains[0];
    expect(c).toMatchObject({ upgradeable: false, upgrade_authority: null, upgrade_status: 'immutable' });
    // A program under a non-upgradeable loader is immutable; an unrecognised owner is unknown, with the reason.
    w.sim.fake.setAccount(w.sim.programId, 'BPFLoader2111111111111111111111111111111111', new Uint8Array(8));
    await d.refreshUpgrade();
    expect((await get('/api/status')).chains[0].upgrade_status).toBe('immutable');
    w.sim.fake.setAccount(w.sim.programId, '11111111111111111111111111111111', new Uint8Array(8));
    await d.refreshUpgrade();
    expect((await get('/api/status')).chains[0]).toMatchObject({ upgradeable: null, upgrade_status: 'unknown', upgrade_reason: expect.stringMatching(/unrecognised loader/) });
    w.sim.fake.deleteAccount(w.sim.programId);
  });

  it('2. a published-settings edit in dry run is refused BEFORE it is stored', async () => {
    const onion = `${'d'.repeat(56)}.onion`;
    const res = await fetch(`${dry.api.url}/api/registration/published`, { method: 'PUT', headers: { Authorization: `Bearer ${dry.d.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ onion, contacts: [{ kind: 4, value: '@later' }] }) });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([409, 'dry_run']);
    expect(dry.d.store.kv('published:onion')).toBeUndefined();
    expect(dry.d.store.kv('published:contacts')).toBeUndefined();
    expect(dry.d.desiredPublished()).toMatchObject({ onion: null, contacts: [] });
  });

  it('3. tor.published says whether the registry lists the wanted onion address', async () => {
    const s = await get('/api/status');
    // The contract test above published this address through the API.
    expect(s.tor).toMatchObject({ onion: `${'c'.repeat(56)}.onion`, published: true, registry_onion: `${'c'.repeat(56)}.onion`, reachable: null });
    d.store.setKv('published:onion', JSON.stringify(`${'e'.repeat(56)}.onion`));
    expect((await get('/api/status')).tor).toMatchObject({ onion: `${'e'.repeat(56)}.onion`, published: false, registry_onion: `${'c'.repeat(56)}.onion` });
    d.store.setKv('published:onion', JSON.stringify(`${'c'.repeat(56)}.onion`));
  });

  it('4. refills say whether they still need an acknowledgement', async () => {
    const { refillView } = await import('../src/rebalance/index.js');
    const rec = (state: string, unresolved: boolean) => refillView({ id: 'r', venue: 'changenow', request: { from: 'usdc_sol', to: 'xmr' }, state, quote: { amountIn: 1n, amountOut: 2n, costPct: 0, feesUsd: 0 }, handle: null, startedAt: 1, finishedAt: null, received: null, txids: [], detail: null, unresolved } as never) as unknown as Record<string, unknown>;
    expect(rec('failed', true)).toMatchObject({ needs_acknowledgement: true, acknowledged: false });
    expect(rec('held', true)).toMatchObject({ needs_acknowledgement: true, acknowledged: false });
    expect(rec('failed', false)).toMatchObject({ needs_acknowledgement: false, acknowledged: true });
    expect(rec('done', false)).toMatchObject({ needs_acknowledgement: false, acknowledged: false });
  });

  it('5. swap summaries carry the mode and the latest instruction (list and WebSocket payload)', async () => {
    const list = await get('/api/swaps');
    expect(list.swaps.length).toBeGreaterThan(0);
    for (const s of list.swaps) expect(s).toMatchObject({ mode: expect.any(Number) });
    const withInstruction = list.swaps.find((s: { instruction: unknown }) => s.instruction !== null);
    expect(withInstruction.instruction).toEqual({ action: expect.any(String), at: expect.any(Number), status: expect.stringMatching(/carried_out|refused|pending/), reason: null, tx: expect.any(String) });
    expect(list.swaps.find((s: { mode: number }) => s.mode === 1)).toBeDefined(); // window-mode locks
  });

  it('6, 8, 9. one documented list of refusal reasons; validate carries the SOL price; a parked payout has an unsigned-transaction action', async () => {
    const { REFUSALS } = await import('../src/api/server.js');
    expect(Object.keys(REFUSALS).sort()).toEqual(['abort-window-closed', 'already-frozen', 'already-settled', 'cannot-exit-after-funding', 'dry-run', 'freeze-not-available', 'freeze-window-closed', 'hold-ended', 'no-deposit-held', 'not-available-in-state', 'ready-already-set', 'refund-window-closed', 'reject-not-available']);
    const v = await client.call('configValidate', { body: { toml: d.load.toml } });
    expect(v).toMatchObject({ ok: true, sol_usd: 100, compute_units_per_update: 24_120 });
    // Nothing is parked on any swap here: the action exists and says so.
    const ref = d.store.swaps({ open: true })[0]?.ref ?? d.store.swaps()[0]!.ref;
    const res = await fetch(`${api.url}/api/swaps/${ref}/withdraw-owed-tx`, { method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect([409]).toContain(res.status);
    expect(['nothing_owed', 'action_unavailable']).toContain(((await res.json()) as { error: string }).error);
    // A claim whose payout was parked (the payout account could not receive): the owner pulls it with a transaction the daemon builds unsigned.
    const parked = w.sim.open({ direction: 0, mode: 1, xmr: XMR, depBps: 200 });
    await d.executor.scan();
    w.sim.putSwap(parked.pda, { ...w.sim.swap(parked.pda)!, state: 9, owedMaker: 123_456n });
    const built = await fetch(`${api.url}/api/swaps/${parked.pda}/withdraw-owed-tx`, { method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(built.status).toBe(200);
    const tx = (await built.json()) as { request_id: string; summary: string; unsigned: { chain: string; fee_payer: string; message_b64: string } };
    expect(tx).toMatchObject({ request_id: expect.any(String), summary: expect.stringMatching(/123456 base units.*owner key/), unsigned: { chain: 'solana', fee_payer: w.sim.owner } });
    const { Message } = await import('@solana/web3.js');
    const { decodeInstructionData } = await import('@xmrswap/protocol');
    const msg = Message.from(Buffer.from(tx.unsigned.message_b64, 'base64'));
    expect(msg.header.numRequiredSignatures).toBe(1);
    const { default: bs58 } = { default: { decode: (x: string) => (require('@xmrswap/protocol') as typeof import('@xmrswap/protocol')).base58Decode(x) } };
    expect(decodeInstructionData(bs58.decode(msg.instructions[0]!.data))).toMatchObject({ name: 'withdrawOwed' });
    w.sim.fake.deleteAccount(parked.pda);
  });
});

// ------------------------------------------------------------------------------------------------ Amendment 1 (DEVIATIONS "Console contract" A18 to A26)

describe('Amendment 1: caps, freeze, the maker watcher and the payout address in the API', () => {
  let aw: World;
  let ad: Daemon;
  let aapi: ApiServer;
  let ac: DaemonClient;
  let wt: import('./sim.js').FakeWatcher;
  let frozenRef: string;
  let pendingRef: string;
  let buyRef: string;
  const takerWatcher = seedSigner(new Uint8Array(32).fill(0x55)).publicKey;
  const payout = seedSigner(new Uint8Array(32).fill(0x61)).publicKey;
  const get = async (p: string) => (await fetch(`${aapi.url}${p}`, { headers: { Authorization: `Bearer ${ad.token}` } })).json() as Promise<any>;

  beforeAll(async () => {
    const { FakeWatcher } = await import('./sim.js');
    aw = await makeWorld();
    wt = new FakeWatcher(aw.sim);
    const toml = `${BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\napproval_mode = "window"\ndeposit_pct = 2\nfreeze_window_hours = 24').replace('[markets.usdc_sol.buy_xmr]\nenabled = true', '[markets.usdc_sol.buy_xmr]\nenabled = true\ndeposit_pct = 1\nfreeze_window_hours = 24')}
[approvals]
auto_max_xmr = 2
deny_watchers = ["${seedSigner(new Uint8Array(32).fill(0x56)).publicKey}"]

[watcher]
url = "http://watcher.test"
solana_key = "${wt.solana}"
`;
    writeFileSync(aw.configPath, toml.replaceAll('__OWNER__', aw.sim.owner));
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, 10_000_000_000n, true);
    aw.sim.fake.setAccount(ata(aw.keystore.solana.publicKey, aw.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
    // Caps on: SOL far away, USDC with 1,000 USDC of open value in all and 900 per swap.
    aw.sim.setCaps(true, [1n << 60n, 900_000_000n], [1n << 60n, 1_000_000_000n]);
    ad = await aw.boot({ watcherFetch: wt.fetch });
    await ad.start();
    aapi = await startApi(ad, { bind: '127.0.0.1:0' });
    ac = new DaemonClient({ baseUrl: aapi.url, token: ad.token });
    // A sell-XMR swap the rules approve, then paused by the watcher its taker named.
    const a = aw.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200, wZ: 86_400, watcher: takerWatcher });
    await ad.executor.tick();
    aw.xmr.mine(2);
    aw.sim.warp(120);
    aw.sim.watcherFreeze(a.pda);
    frozenRef = a.pda;
    // A buy-XMR swap paid to a fresh payout address: funded with the maker's watcher named, then acknowledged.
    const b = aw.sim.open({ direction: 1, asset: 1, xmr: 2n * XMR, wZ: 86_400, payout });
    await ad.executor.tick();
    await ad.executor.tick();
    buyRef = b.pda;
    // A lock above the automatic size limit that names a watcher: left to the maker.
    const p = aw.sim.open({ direction: 0, mode: 1, xmr: 3n * XMR, depBps: 200, wZ: 86_400, watcher: takerWatcher });
    await ad.executor.tick();
    pendingRef = p.pda;
    await ad.offers.tick(true);
  });
  afterAll(async () => {
    await aapi?.close();
    ad?.store.close();
  });

  it('A18. status: caps and headroom per market, the program build, the watcher', async () => {
    const s = await call(ac, 'status');
    const usdcOpen = BigInt(aw.sim.caps(1).openValue);
    expect(s.caps).toEqual([
      { market: 'sol', caps: { on: true, max_swap: String(1n << 60n), max_open: String(1n << 60n), open_value: aw.sim.caps(0).openValue.toString(), headroom: ((1n << 60n) - aw.sim.caps(0).openValue).toString(), frozen: false } },
      { market: 'usdc_sol', caps: { on: true, max_swap: '900000000', max_open: '1000000000', open_value: usdcOpen.toString(), headroom: (1_000_000_000n - usdcOpen).toString(), frozen: false } },
    ]);
    // Direction B counts amount + deposit: 2 XMR at 150 USDC with a 1% take deposit.
    expect(usdcOpen).toBe(300_000_000n + 3_000_000n);
    expect(s.program_build).toEqual({ program_id: aw.sim.programId, expected_hash: null, on_chain_hash: null, matches: null });
    expect(s.watcher).toMatchObject({ url: 'http://watcher.test', solana: wt.solana, ethereum: null, watching: 1 });
    expect(typeof s.watcher.reachable === 'boolean' || s.watcher.reachable === null).toBe(true);
    expect(s).toMatchObject({ cap_reached: [], freezes: 1 });
  });

  it('A19. offers: capacity_limit, cap_reached, the freeze window in the terms, swap_cost and the caps', async () => {
    const o = await call(ac, 'offers');
    const buy = o.offers.find((x: { market: string; direction: string }) => x.market === 'usdc_sol' && x.direction === 'buy_xmr')!;
    const sell = o.offers.find((x: { market: string; direction: string }) => x.market === 'sol' && x.direction === 'sell_xmr')!;
    expect(sell).toMatchObject({ capacity_limit: expect.stringMatching(/^(inventory|config)$/), cap_reached: null, freeze_window_secs: 86_400, terms: { freeze_window_secs: 86_400 } });
    // 697 USDC of open value are left and one swap may be 900: the open value binds.
    expect(buy).toMatchObject({ enabled: true, capacity_limit: 'max_open', cap_reached: null, terms: { freeze_window_secs: 86_400 } });
    expect(BigInt(buy.capacity_xmr) < 20n * XMR).toBe(true);
    expect(o.swap_cost).toMatchObject({ taker_open_compute_units: { lock_or_take: 80_000, usdc_with_approval: 100_000 }, solana: { sol: { sell_xmr: { compute_units: 61_000 } }, usdc_sol: { buy_xmr: { compute_units: 70_000 } } }, ethereum: { freeze_gas: '78600' } });
    expect(o.caps).toHaveLength(2);
    // The open value is used up: the offer stops with the chain's own reason, distinct from the maker's limits.
    aw.sim.setCaps(true, [1n << 60n, 900_000_000n], [1n << 60n, aw.sim.caps(1).openValue + 1_000n]);
    await ad.caps.refresh(true);
    await ad.offers.tick(true);
    const stopped = (await call(ac, 'offers')).offers.find((x: { market: string; direction: string }) => x.market === 'usdc_sol' && x.direction === 'buy_xmr')!;
    expect(stopped).toMatchObject({ enabled: false, capacity_xmr: '0', capacity_limit: 'max_open', cap_reached: 'OpenCapExceeded', disabled_reason: expect.stringMatching(/^cap reached: 1000 of \d+ base units of open value are left/) });
    const caps = await get('/api/caps');
    expect(caps).toMatchObject({ refused_quotes: 0, offers: expect.arrayContaining([{ market: 'usdc_sol', direction: 'buy_xmr', enabled: false, capacity_xmr: '0', capacity_limit: 'max_open', cap_reached: 'OpenCapExceeded', reason: stopped.disabled_reason }]) });
    expect(caps.caps.map((c: { market: string }) => c.market)).toEqual(['sol', 'usdc_sol']);
    expect((await call(ac, 'status')).cap_reached).toEqual([{ market: 'usdc_sol', direction: 'buy_xmr', code: 'OpenCapExceeded', reason: stopped.disabled_reason }]);
    expect((await call(ac, 'status')).alerts.some((a: { kind: string }) => a.kind === 'cap_reached')).toBe(true);
  });

  it('A20, A21. swaps: extras (payout, watcher, freeze window, watching_until), FROZEN with t_freeze / t_ff and who froze, the acknowledgement', async () => {
    const list = (await call(ac, 'swaps')).swaps as any[];
    const frozen = list.find((x) => x.ref === frozenRef);
    const tFreeze = Number(aw.sim.swap(frozenRef)!.tFreeze);
    expect(frozen).toMatchObject({ state: 'FROZEN', phase: 'frozen', direction: 'A', extras: { payout: null, watcher: takerWatcher, freeze_window_secs: 86_400, watching_until: null }, frozen: { t_freeze: tFreeze, t_ff: tFreeze + 86_400, frozen_by: 'taker_side' }, next_deadline: { at: tFreeze + 86_400 } });
    expect(frozen.actions).toContain('abort');
    const ack = ad.store.watchAck(buyRef)!;
    const bought = list.find((x) => x.ref === buyRef);
    // The taker stays the taker; the payout address is beside it, never instead of it.
    expect(bought).toMatchObject({ direction: 'B', taker: aw.sim.taker, extras: { payout, watcher: wt.solana, freeze_window_secs: 86_400, watching_until: ack.watching_until }, frozen: null });
    const detail = await call(ac, 'swap', { params: { ref: frozenRef } });
    expect(detail.deadlines).toMatchObject({ t_freeze: tFreeze, t_ff: tFreeze + 86_400 });
    expect(detail).toMatchObject({ freeze: { swap_ref: frozenRef, frozen_by: 'taker_side', taker: aw.sim.taker, watcher: takerWatcher, t_freeze: tFreeze, t_ff: tFreeze + 86_400 }, watcher_ack: null });
    const bd = await call(ac, 'swap', { params: { ref: buyRef } });
    expect(bd.deadlines).toMatchObject({ t_freeze: null, t_ff: null });
    expect(bd).toMatchObject({ freeze: null, watcher_ack: { watcher: wt.solana, watching_until: ack.watching_until, sig: ack.sig } });
    expect(bd.intents.map((i: { kind: string }) => i.kind)).toEqual(['sol_tx:fund', 'watch_register:watch_register']);
  });

  it('A22. approvals: a pending lock shows the payout, the watcher it names, whether that watcher is denied, and the taker\'s freeze count', async () => {
    const a = await call(ac, 'approvals');
    const p = a.pending.find((x: { ref: string }) => x.ref === pendingRef);
    expect(p).toMatchObject({ direction: 'A', payout: null, watcher: takerWatcher, watcher_denied: false, freeze_window_secs: 86_400, taker_freezes: 1, recommendation: 'approve' });
  });

  it('A23, A24. freezes and counters; the watcher with its acknowledgements', async () => {
    const f = await get('/api/freezes');
    const tFreeze = Number(aw.sim.swap(frozenRef)!.tFreeze);
    expect(f).toEqual({
      freezes: [{ ref: frozenRef, chain: 'solana', direction: 'A', taker: aw.sim.taker, watcher: takerWatcher, frozen_by: 'taker_side', t_freeze: tFreeze, t_ff: tFreeze + 86_400, state: 'FROZEN' }],
      by_taker: [{ taker: aw.sim.taker, count: 1 }],
      counters: [{ chain: 'solana', freezes: 1, refunds_after_freeze: 0, backouts_after_freeze: 0, claims_after_freeze: 0 }],
      settings: { refuse_watchers: false, deny_watchers: [seedSigner(new Uint8Array(32).fill(0x56)).publicKey], max_taker_freezes: null },
    });
    expect(await call(ac, 'stats')).toMatchObject({ cap_reached: { offers_stopped: 1, refused_quotes: 0 }, freezes: { total: 1, by_taker_side: 1, by_maker: 0, by_maker_watcher: 0 }, counters: [{ chain: 'solana', values: expect.objectContaining({ freezes: 1 }) }] });
    const wv = await get('/api/watcher');
    const ack = ad.store.watchAck(buyRef)!;
    expect(wv).toEqual({
      status: { url: 'http://watcher.test', reachable: true, solana: wt.solana, ethereum: null, watching: 1, reported: { solana: wt.solana, ethereum: wt.ethereum } },
      acks: [{ ref: buyRef, chain: 'solana', watcher: wt.solana, watching_until: ack.watching_until, sig: ack.sig, at: ack.at, open: true }],
    });
  });

  it('A25, A26. fee figures and parked-payout delivery', async () => {
    const fees = await call(ac, 'fees');
    expect(fees).toMatchObject({ swap_cost: { taker_open_compute_units: { lock_or_take: 80_000 } }, daily_swap_lamports: '0', eth_runway_swaps: null });
    const v = await call(ac, 'configValidate', { body: { toml: ad.load.toml } });
    expect(v.swap_cost.solana.sol.sell_xmr_window.compute_units).toBe(85_000);
    expect(v.warnings.some((x: { path: string; message: string }) => x.path === 'markets.sol.sell_xmr.freeze_window_hours' && /25\.5 h/.test(x.message))).toBe(true);
    expect(v.effective.every((e: { freeze_window_secs: number }) => e.freeze_window_secs === 86_400)).toBe(true);
    // Nothing is parked on this swap: the delivery route exists and says so.
    const res = await fetch(`${aapi.url}/api/swaps/${buyRef}/deliver-owed`, { method: 'POST', headers: { Authorization: `Bearer ${ad.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect([res.status, (await res.json()).error]).toEqual([409, 'nothing_owed']);
    expect((await fetch(`${aapi.url}/api/swaps/nope/deliver-owed`, { method: 'POST', headers: { Authorization: `Bearer ${ad.token}` } })).status).toBe(404);
  });
});
