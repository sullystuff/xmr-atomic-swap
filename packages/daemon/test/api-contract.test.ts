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
