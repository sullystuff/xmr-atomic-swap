// The remaining tools of DESIGN's "Maker tools" table, each against the SDK's fakes or the simulated program.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transaction } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { dleqProve, dleqVerify, init, x25519Public } from '@xmrswap/core-wasm';
import { COUNTER, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import { MakerHttp, MakerRefused, ata, contactKeys, envelopeHash, makerShareKeys, openFromMaker, parsePool, sealToMaker, seedSigner, solApprovalFromResponse, solApprovalProblem, takerSwapKeys } from '@xmrswap/sdk';
import { fakeMakerEndpoint } from '@xmrswap/sdk/testing';
import { failover } from '../src/chains/types.js';
import type { Daemon } from '../src/daemon.js';
import { depositViews, withholdDecision } from '../src/deposits/index.js';
import { Keystore, apiToken } from '../src/keystore/index.js';
import { feesView, statsView } from '../src/stats/index.js';
import { BindingError, Store } from '../src/store/db.js';
import { makerEndpoint, readOnionHostname, torrcLines } from '../src/tor/index.js';
import { XMR } from './sim.js';
import { BASE_TOML, ENC_SECRET_V1, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
const fill = (n: number) => new Uint8Array(32).fill(n);
function usdc(w: World, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
async function live(toml = BASE_TOML): Promise<{ w: World; d: Daemon }> {
  const w = await makeWorld(toml);
  usdc(w, 1_000_000_000_000n);
  const d = await w.boot();
  await d.start();
  return { w, d };
}
const endpointOf = (d: Daemon, w: World) =>
  new MakerHttp(
    fakeMakerEndpoint(
      makerEndpoint({
        store: d.store, inbox: d.inbox, poolLeaves: (root) => d.offers.poolLeaves(root), isOwnShare: (s) => d.store.shareByPub(s) !== undefined,
        info: async () => ({ maker: w.sim.makerPda, operator: w.keystore.solana.publicKey, enc_key_version: w.sim.maker().encKeyVersion, chain_time: Number(w.sim.now) }),
      }),
    ),
  );

describe('keystore and database', () => {
  it('seals the seed and the operator keys with the passphrase; a wrong passphrase opens nothing; the file is never overwritten', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-ks-'));
    const k = new Keystore({ seed: fill(1), solanaOperator: fill(2), ethereumOperator: fill(3) });
    k.save(dir, 'correct horse');
    const raw = readFileSync(path.join(dir, 'keystore.json'), 'utf8');
    for (const secret of ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)]) expect(raw).not.toContain(secret);
    expect(statSync(path.join(dir, 'keystore.json')).mode & 0o777).toBe(0o600);
    const opened = Keystore.open(dir, 'correct horse');
    expect(opened.solana.publicKey).toBe(seedSigner(fill(2)).publicKey);
    expect(opened.ethereum.address).toBe(k.ethereum.address);
    expect(Buffer.from(opened.shareKeys('solana', '00'.repeat(16)).spendPub).toString('hex')).toBe(Buffer.from(makerShareKeys(fill(1), 'solana', new Uint8Array(16)).spendPub).toString('hex'));
    expect(() => Keystore.open(dir, 'wrong')).toThrow(/wrong passphrase/);
    expect(() => k.save(dir, 'again')).toThrow(/refusing to overwrite/);
    expect(() => new Keystore({ seed: new Uint8Array(31), solanaOperator: fill(2), ethereumOperator: fill(3) })).toThrow(/32 bytes/);
    // Database secrets are sealed with a key derived from the seed; another keystore cannot open them.
    const sealed = k.sealDb(fill(9));
    expect(Buffer.from(sealed).includes(Buffer.from(fill(9)))).toBe(false);
    expect(Buffer.from(opened.openDb(sealed)).equals(Buffer.from(fill(9)))).toBe(true);
    expect(() => new Keystore({ seed: fill(4), solanaOperator: fill(2), ethereumOperator: fill(3) }).openDb(sealed)).toThrow();
    const token = apiToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(apiToken(dir)).toBe(token);
    expect(statSync(path.join(dir, 'api-token')).mode & 0o777).toBe(0o600);
  });
  it('binds to the maker and the wallet at first start and refuses others; shares and lock transactions are unique', () => {
    const s = new Store(':memory:');
    s.bind({ solanaMaker: 'maker-1', wallet: 'wallet-1' });
    s.bind({ solanaMaker: 'maker-1', wallet: 'wallet-1', ethereumMaker: null });
    expect(() => s.bind({ solanaMaker: 'maker-2' })).toThrow(BindingError);
    expect(() => s.bind({ wallet: 'wallet-2' })).toThrow(/bound to wallet wallet-1/);
    s.insertShare({ share_id: 'a', chain: 'solana', spend_pub: 'p', status: 'fresh', purpose: 'x', swap_ref: null });
    expect(() => s.insertShare({ share_id: 'b', chain: 'solana', spend_pub: 'p', status: 'fresh', purpose: 'x', swap_ref: null })).toThrow();
    const id = s.planIntent('sol_tx', 'swap', { call: 'claim', amount: 5n, bytes: Uint8Array.of(1, 2) });
    expect(s.intent(id)).toMatchObject({ status: 'planned', payload: { call: 'claim', amount: 5n, bytes: Uint8Array.of(1, 2) } });
    s.setIntent(id, 'sent', { tx: 'sig', meta: { lastValidBlockHeight: 7 } });
    s.setIntent(id, 'needs_review');
    expect(s.intent(id)).toMatchObject({ status: 'needs_review', tx: 'sig', meta: { lastValidBlockHeight: 7 } });
    expect(s.needsReviewCount()).toBe(1);
  });
  it('fails over to the next endpoint on a transport failure, not on an answer', async () => {
    const calls: string[] = [];
    class Answer extends Error {}
    const a = { get: async (x: number) => (calls.push('a'), Promise.reject<number>(x === 2 ? new Answer('revert') : new Error('ECONNREFUSED'))) };
    const b = { get: async (x: number) => (calls.push('b'), x * 2) };
    const switched: number[] = [];
    const f = failover([a, b], (e) => e instanceof Answer, (i) => switched.push(i));
    expect(await f.get(21)).toBe(42);
    expect(calls).toEqual(['a', 'b']);
    expect(switched).toEqual([1]);
    expect(await f.get(1)).toBe(2); // stays on the endpoint that works
    expect(calls).toEqual(['a', 'b', 'b']);
    const g = failover([a, b], (e) => e instanceof Answer);
    await expect(g.get(2)).rejects.toThrow('revert');
  });
});

describe('risk controls', () => {
  it('in-flight exposure, per-taker limit, daily cap, pause; depth by size raised by the reorg guard', async () => {
    const { w, d } = await live(`${BASE_TOML.replace('[liquidity]', '[liquidity]\nmax_in_flight_xmr = 5\nmax_per_taker_xmr = 3').replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\ndaily_cap_xmr = 6')}\n[guardrails]\nreorg_guard = { enabled = true, raise_depth_to = 25 }\n`);
    const offer = d.config.offers.find((o) => o.market === 'sol' && o.direction === 'sell_xmr')!;
    expect(d.risk.check({ ref: 'x', taker: 't', xmr: 2n * XMR }, offer)).toEqual({ ok: true, reasons: [] });
    expect(d.risk.check({ ref: 'x', taker: 't', xmr: 4n * XMR }, offer).reasons).toEqual(['over the per-taker limit']);
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    expect(d.risk.inFlightXmr()).toBe(2n * XMR);
    expect(d.risk.takerXmr(w.sim.taker)).toBe(2n * XMR);
    expect(d.risk.check({ ref: 'y', taker: w.sim.taker, xmr: 2n * XMR }, offer).reasons).toEqual(['over the per-taker limit']);
    expect(d.risk.check({ ref: 'y', taker: 'someone-else', xmr: 3_500_000_000_000n }, offer).reasons).toEqual(['over the in-flight limit', 'over the per-taker limit']);
    expect(d.risk.remaining(offer)).toBe(3n * XMR);
    // The swap's own row does not count against itself.
    expect(d.risk.check({ ref: s.pda, taker: w.sim.taker, xmr: 2n * XMR }, offer).ok).toBe(true);
    d.risk.setPaused(true, 'holiday');
    expect(d.risk.check({ ref: 'z', taker: 't', xmr: XMR }, offer).reasons).toContain('the maker is paused');
    d.risk.setPaused(false);
    expect(d.risk.depthTiers(offer)).toEqual([{ aboveXmr: 0n, depth: 2 }]);
    d.risk.reorgSeenAt = d.store.now();
    expect(d.risk.reorgGuardActive).toBe(true);
    expect(d.risk.depthTiers(offer)).toEqual([{ aboveXmr: 0n, depth: 25 }]);
    d.store.close();
  });
});

describe('approvals: advance approvals', () => {
  it('signs an approval the program would accept, bound to this cluster, program, maker and taker; answers requests only for listed takers', async () => {
    const { w, d } = await live(`${BASE_TOML}\n[approvals]\nadvance = [{ taker = "${seedSigner(fill(5)).publicKey}", max_xmr = 10, days = 30 }]\n`);
    const issued = await d.approvals.issue({ chain: 'solana', taker: w.sim.taker, market: 'sol', direction: 'A', maxXmr: 5n * XMR, days: 7 });
    expect(issued.record).toMatchObject({ chain: 'solana', taker: w.sim.taker, market: 'sol', direction: 'A', max_xmr: (5n * XMR).toString(), epoch: 1, active: true, expires_at: Number(w.sim.now) + 7 * 86_400 });
    if (!issued.response.ok || issued.response.chain !== 'solana') throw new Error('refused');
    const bind = { clusterTag: fill(7), programId: base58Decode(w.sim.programId), maker: base58Decode(w.sim.makerPda), taker: base58Decode(w.sim.taker), operator: base58Decode(w.keystore.solana.publicKey) };
    const signed = solApprovalFromResponse(issued.response, bind);
    expect(solApprovalProblem(signed, bind, { asset: 0, direction: 0, xmr: 5n * XMR, now: w.sim.now + 10n, approvalEpoch: 1 })).toBeNull();
    expect(solApprovalProblem(signed, bind, { asset: 0, direction: 0, xmr: 5n * XMR + 1n, now: w.sim.now + 10n, approvalEpoch: 1 })).toBe('ApprovalInvalid');
    expect(solApprovalProblem(signed, bind, { asset: 0, direction: 0, xmr: XMR, now: w.sim.now + 10n, approvalEpoch: 2 })).toBe('ApprovalInvalid');
    expect(() => solApprovalFromResponse(issued.response as never, { ...bind, taker: fill(9) })).toThrow(/SignatureInvalid/);
    // A request from the listed taker is capped at the listed limit; anyone else is refused.
    const answer = await d.approvals.answerRequest({ chain: 'solana', taker: w.sim.taker, max_xmr: (50n * XMR).toString() });
    expect(answer).toMatchObject({ ok: true, max_xmr: (10n * XMR).toString(), asset: 255, direction: 255 });
    expect(await d.approvals.answerRequest({ chain: 'solana', taker: seedSigner(fill(6)).publicKey })).toMatchObject({ ok: false });
    expect(d.approvals.records({ solana: 1 }, {}).map((r) => r.active)).toEqual([true, true]);
    expect(d.approvals.records({ solana: 2 }, {}).map((r) => r.active)).toEqual([false, false]); // an epoch bump kills them all
    await expect(d.approvals.issue({ chain: 'solana', taker: w.sim.taker, market: 'eth', maxXmr: XMR, days: 1 })).rejects.toThrow(/not on solana/);
    await expect(d.approvals.issue({ chain: 'ethereum', taker: '0x' + '11'.repeat(20), maxXmr: XMR, days: 1 })).rejects.toThrow(/not configured/);
    d.store.close();
  });
});

describe('deposit handling', () => {
  it('never / always / price moved against the maker; a manual decision overrides; released only by the maker', () => {
    const o = (withholdPolicy: 'never' | 'always' | 'price_moved', directionCode: 0 | 1 = 0) => ({ withholdPolicy, withholdMovePct: 1.0, directionCode });
    expect(withholdDecision(o('never'), {}, 100)).toBe(false);
    expect(withholdDecision(o('always'), {}, null)).toBe(true);
    // Direction A: the maker's XMR was tied up while XMR fell.
    expect(withholdDecision(o('price_moved'), { refPriceUsd: 400 }, 395)).toBe(true);
    expect(withholdDecision(o('price_moved'), { refPriceUsd: 400 }, 397)).toBe(false);
    expect(withholdDecision(o('price_moved'), { refPriceUsd: 400 }, 420)).toBe(false);
    // Direction B: its paying asset was tied up while XMR rose.
    expect(withholdDecision(o('price_moved', 1), { refPriceUsd: 400 }, 405)).toBe(true);
    expect(withholdDecision(o('price_moved', 1), { refPriceUsd: 400 }, 395)).toBe(false);
    expect(withholdDecision(o('price_moved'), {}, 300)).toBe(false); // no price at lock: the rule does not withhold
    expect(withholdDecision(o('always'), { manual: { withhold: false } }, null)).toBe(false);
    expect(withholdDecision(o('never'), { manual: { withhold: true } }, null)).toBe(true);
    expect(withholdDecision(undefined, {}, null)).toBe(false);
  });
  it('lists held and withheld deposits with their countdowns and the release request', async () => {
    const { w, d } = await live(BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\ndeposit_pct = 2\nwithhold_policy = "price_moved"'));
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, depBps: 200, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    await d.executor.tick();
    const view = () => depositViews(d.store, (row) => d.config.offers.find((o) => o.market === row.market && o.directionCode === row.direction), d.prices.usd('xmr'));
    const refundedAt = Number(w.sim.swap(s.pda)!.tRefund);
    expect(view()).toEqual([{ chain: 'solana', ref: s.pda, market: 'sol', taker: w.sim.taker, deposit: '6000000', state: 'held', refunded_at: refundedAt, hold_until: refundedAt + 1800, split_at: refundedAt + 5_184_000, evidence_required: true, policy_decision: 'none', release_requested: false }]);
    // The price falls 2% while the hold runs: the rule now says withhold, and the daemon does, with the evidence.
    w.prices.xmr = 147;
    await d.prices.refresh();
    expect(view()[0]!.policy_decision).toBe('withhold');
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.WITHHELD);
    expect(w.sim.maker().counters[COUNTER.withholds]).toBe(1);
    expect(view()[0]).toMatchObject({ state: 'withheld', policy_decision: 'none' });
    d.store.close();
  });
});

describe('key rotation', () => {
  it('rotates on demand and on schedule; keeps a retired key through its grace and while a swap opened under it is open; then deletes it', async () => {
    const { w, d } = await live(`${BASE_TOML}\n[rotation]\ngrace_hours = 0.5\n`);
    const s = w.sim.open({ direction: 0, xmr: XMR, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    expect(d.store.swap(s.pda)!.enc_version).toBe(1);
    const r = await d.rotation.rotate();
    expect(r.version).toBe(2);
    const m = w.sim.maker();
    expect(m.encKeyVersion).toBe(2);
    expect(Buffer.from(m.prevEncKey).equals(Buffer.from(x25519Public(ENC_SECRET_V1)))).toBe(true);
    expect(m.prevEncKeyExpiresAt).toBe(w.sim.now + 1800n);
    // The new private key was stored (sealed) before the transaction was sent, and opens to the published public key.
    expect(Buffer.from(x25519Public(d.encKeys.secretFor(2)!)).equals(Buffer.from(m.encKey))).toBe(true);
    expect(d.store.encKey(2)!.sealed_secret!.includes(Buffer.from(d.encKeys.secretFor(2)!))).toBe(false);
    await d.rotation.tick();
    expect(d.rotation.view().keys).toMatchObject([{ version: 1, current: false, open_swaps: 1, expires_at: Number(w.sim.now) + 1800, deleted_at: null }, { version: 2, current: true, open_swaps: 0 }]);
    // Grace over, but the swap opened under version 1 is still open: the key stays (its notice must stay decryptable).
    w.sim.warp(1801);
    expect(await d.rotation.prune()).toEqual([]);
    expect(d.encKeys.secretFor(1)).not.toBeNull();
    w.xmr.mine(2);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    await d.executor.tick();
    expect(d.store.swap(s.pda)!.terminal).toBe(1);
    expect(await d.rotation.prune()).toEqual([1]);
    expect(d.encKeys.secretFor(1)).toBeNull();
    expect(d.store.encKey(1)).toMatchObject({ sealed_secret: null, deleted_at: expect.any(Number) });
    expect(d.encKeys.secretFor(2)).not.toBeNull();
    d.store.close();

    const sched = await live(`${BASE_TOML}\n[rotation]\ninterval_hours = 6\ngrace_hours = 1\n`);
    await sched.d.rotation.tick();
    expect(sched.w.sim.maker().encKeyVersion).toBe(2);
    await sched.d.rotation.tick();
    expect(sched.w.sim.maker().encKeyVersion).toBe(2);
    sched.w.sim.warp(6 * 3600);
    await sched.d.rotation.tick();
    expect(sched.w.sim.maker().encKeyVersion).toBe(3);
    expect(sched.d.rotation.view()).toMatchObject({ rotation_interval_hours: 6, grace_hours: 1, next_rotation_at: Number(sched.w.sim.now) + 6 * 3600 });
    sched.d.store.close();
  });
  it('a rotation interrupted before it landed is not published and its key is reused; in dry run nothing is sent', async () => {
    const { w, d } = await live();
    const pub = d.encKeys.ensure(2);
    await d.rotation.reconcile();
    expect(d.encKeys.current()!.version).toBe(1);
    await d.rotation.rotate();
    expect(Buffer.from(w.sim.maker().encKey).equals(Buffer.from(pub))).toBe(true);
    d.store.close();
    const dry = await makeWorld(BASE_TOML.replace('mode = "live"', 'mode = "dry_run"'));
    const dd = await dry.boot();
    await expect(dd.rotation.rotate()).rejects.toThrow(/dry run/);
    dd.store.close();
  });
});

describe('inbox and the maker endpoint', () => {
  const takerSeed = fill(42);
  it('stores a taker\'s message beside its swap, flags a release request, replies signed; replies are read back after a reload', async () => {
    const { w, d } = await live(BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\ndeposit_pct = 2\nwithhold_policy = "always"'));
    const http = endpointOf(d, w);
    expect(await http.info()).toEqual({ maker: w.sim.makerPda, operator: w.keystore.solana.publicKey, enc_key_version: 1, chain_time: Number(w.sim.now) });
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, depBps: 200, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    await d.executor.tick();
    const maker = w.sim.maker();
    const swapRef = base58Decode(s.pda);
    const envelope = sealToMaker({ message: { t: 'inbox', text: 'Please release my deposit.', action: 'release_deposit' }, ownEncSecret: s.keys.encSecret, maker, swapRef, transport: 'tor' });
    const reply = openFromMaker({ envelope: await http.msg(envelope), ownEncSecret: s.keys.encSecret, maker, operatorPub: base58Decode(maker.operator), now: w.sim.now, swapRef });
    expect(reply.message).toEqual({ t: 'ack', in_reply_to: envelopeHash(envelope) });
    const item = d.inbox.items()[0]!;
    expect(item).toMatchObject({ id: envelopeHash(envelope), direction: 'in', transport: 'tor', type: 'inbox', swap_ref: s.pda, peer: w.sim.taker, text: 'Please release my deposit.', action: 'release_deposit', read: false });
    expect(d.store.swap(s.pda)!.facts.releaseRequested).toBe(true);
    expect(d.inbox.items(s.pda)).toHaveLength(1);
    // A replay of the same envelope is acknowledged again and stored once.
    await http.msg(envelope);
    expect(d.inbox.items()).toHaveLength(1);

    // The maker answers later from the console; the reply waits at the replies route, ciphertext only.
    const out = await d.inbox.reply(item.id, 'Released. Sorry for the wait.');
    expect(out).toMatchObject({ direction: 'out', type: 'inbox_reply', in_reply_to: item.id, swap_ref: s.pda });
    expect(d.inbox.items().find((i) => i.id === item.id)!.read).toBe(true);
    const stored = await http.replies(Buffer.from(s.keys.encPub).toString('hex'));
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]!).includes(Buffer.from('Released'))).toBe(false);
    expect(openFromMaker({ envelope: stored[0]!, ownEncSecret: s.keys.encSecret, maker, operatorPub: base58Decode(maker.operator), now: w.sim.now, swapRef }).message).toEqual({ t: 'inbox_reply', text: 'Released. Sorry for the wait.', in_reply_to: item.id });
    expect(await http.replies('00'.repeat(32))).toEqual([]);

    // Somebody else cannot speak for that swap, and a tampered envelope is refused.
    const other = takerSwapKeys(fill(43), 'solana', new Uint8Array(16).fill(3));
    await expect(http.msg(sealToMaker({ message: { t: 'inbox', text: 'me too' }, ownEncSecret: other.encSecret, maker, swapRef, transport: 'tor' }))).rejects.toMatchObject({ code: 'not_allowed' });
    const bad = envelope.slice();
    bad[100] = bad[100]! ^ 1;
    await expect(http.msg(bad)).rejects.toBeInstanceOf(MakerRefused);
    d.store.close();
  });

  it('key rotation: a message to the previous key opens during its grace; an expired version gets stale_key and succeeds on retry', async () => {
    const { w, d } = await live(`${BASE_TOML}\n[rotation]\ngrace_hours = 1\n`);
    const http = endpointOf(d, w);
    const contact = contactKeys(takerSeed, w.sim.makerPda);
    const v1 = w.sim.maker();
    const send = (maker: ReturnType<typeof w.sim.maker>, text: string) => http.msg(sealToMaker({ message: { t: 'inbox', text }, ownEncSecret: contact.encSecret, maker, transport: 'tor' }));
    await d.rotation.rotate();
    await d.rotation.reconcile();
    await send(v1, 'sent around the rotation'); // encrypted to version 1, inside its grace
    expect(d.inbox.items()[0]).toMatchObject({ text: 'sent around the rotation', swap_ref: null });
    w.sim.warp(3601);
    await expect(send(v1, 'too late')).rejects.toMatchObject({ code: 'stale_key' });
    // The client re-reads the registry and sends again.
    await send(w.sim.maker(), 'retry with the current key');
    expect(d.inbox.items()[0]!.text).toBe('retry with the current key');
    expect(d.inbox.items()).toHaveLength(2);
    d.store.close();
  });

  it('inbox policy swap_only refuses strangers; a taker key is rate-limited; oversize is refused', async () => {
    const { w, d } = await live(`${BASE_TOML}\n[inbox]\npolicy = "swap_only"\n`);
    const http = endpointOf(d, w);
    const contact = contactKeys(takerSeed, w.sim.makerPda);
    const maker = w.sim.maker();
    await expect(http.msg(sealToMaker({ message: { t: 'inbox', text: 'hello' }, ownEncSecret: contact.encSecret, maker, transport: 'tor' }))).rejects.toMatchObject({ code: 'not_allowed' });
    // Requests are still answered (an approval request from an unlisted taker is refused in its reply, not at the door).
    const env = sealToMaker({ message: { t: 'approval_request', chain: 'solana', taker: w.sim.taker }, ownEncSecret: contact.encSecret, maker, transport: 'tor' });
    expect(openFromMaker({ envelope: await http.msg(env), ownEncSecret: contact.encSecret, maker, operatorPub: base58Decode(maker.operator), now: w.sim.now }).message).toMatchObject({ t: 'approval_response', ok: false });
    let limited = 0;
    for (let i = 0; i < 25; i++) await http.msg(sealToMaker({ message: { t: 'notice_copy', commitment: 'aa'.repeat(32), ciphertext: 'bb'.repeat(104) }, ownEncSecret: contact.encSecret, maker, transport: 'tor' })).catch((e: MakerRefused) => (limited += e.code === 'rate_limited' ? 1 : 0));
    expect(limited).toBeGreaterThan(0);
    const raw = makerEndpoint({ store: d.store, inbox: d.inbox, poolLeaves: () => null, isOwnShare: () => false, info: async () => ({ maker: '', operator: '', enc_key_version: 1, chain_time: 0 }) });
    expect((await raw('POST', '/xs/v1/msg', new Uint8Array(16_385))).status).toBe(413);
    expect((await raw('GET', '/xs/v1/../secret')).status).toBe(404);
    expect((await raw('PUT', '/xs/v1/info')).status).toBe(405);
    d.store.close();
  });

  it('messages posted on-chain to the maker PDA are read from a stored cursor, once', async () => {
    const { w, d } = await live();
    const contact = contactKeys(takerSeed, w.sim.makerPda);
    const maker = w.sim.maker();
    const envelope = sealToMaker({ message: { t: 'inbox', text: 'on-chain hello' }, ownEncSecret: contact.encSecret, maker, transport: 'solana' });
    const ix = w.sim.program.postMessage(w.sim.taker, w.sim.makerPda, envelope);
    w.sim.fake.addTransaction({ signature: 'msg1', slot: 5, blockTime: Number(w.sim.now), err: null, logs: [], instructions: [{ programId: w.sim.programId, accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: Uint8Array.from(ix.data) }] }, [w.sim.makerPda]);
    expect(await d.inbox.pollSolana()).toBe(1);
    expect(d.inbox.items()[0]).toMatchObject({ transport: 'solana', text: 'on-chain hello', peer: w.sim.taker });
    expect(await d.inbox.pollSolana()).toBe(0);
    expect(d.store.meta('sol_msg_cursor')).toBe('msg1');
    d.store.close();
  });

  it('DLEQ blobs: keeps a taker proof that verifies and whose S is the path; serves its own; never lets one be overwritten', async () => {
    const { w, d } = await live();
    const http = endpointOf(d, w);
    const taker = takerSwapKeys(takerSeed, 'ethereum', new Uint8Array(16).fill(8));
    const blob = dleqProve(taker.spend);
    const s = Buffer.from(taker.spendPub).toString('hex');
    await http.putDleq(s, blob);
    expect(Buffer.from((await http.getDleq(s))!).equals(Buffer.from(blob))).toBe(true);
    await expect(http.putDleq('11'.repeat(32), blob)).rejects.toMatchObject({ code: 'bad_request' }); // S is not the path
    const tampered = blob.slice();
    tampered[200] = tampered[200]! ^ 1;
    await expect(http.putDleq(s, tampered)).rejects.toMatchObject({ code: 'bad_request' });
    expect(await http.getDleq('22'.repeat(32))).toBeNull();
    // The maker's own proof is served and cannot be replaced by a taker.
    const own = d.shares.create('ethereum', 'fund', null, 'published');
    const ownBlob = dleqProve(own.keys.spend);
    d.store.putBlob(own.row.spend_pub, ownBlob, true);
    await expect(http.putDleq(own.row.spend_pub, ownBlob)).rejects.toMatchObject({ code: 'bad_request' });
    expect(dleqVerify((await http.getDleq(own.row.spend_pub))!).spendPub).toEqual(own.keys.spendPub);
    // Taker proofs no swap references are dropped after 15 minutes; pinned ones and own ones stay.
    w.sim.warp(16 * 60);
    expect(await http.getDleq(s)).toBeNull();
    expect(await http.getDleq(own.row.spend_pub)).not.toBeNull();
    expect(await http.getPool('33'.repeat(32))).toBeNull();
    d.store.close();
  });

  it('Tor settings: reads the hostname file, prints the torrc lines', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-tor-'));
    const file = path.join(dir, 'hostname');
    expect(readOnionHostname(file)).toBeNull();
    writeFileSync(file, `${'a'.repeat(56)}.onion\n`);
    expect(readOnionHostname(file)).toBe(`${'a'.repeat(56)}.onion`);
    writeFileSync(file, 'not-an-onion\n');
    expect(readOnionHostname(file)).toBeNull();
    expect(torrcLines('127.0.0.1:7072', file)).toBe(`HiddenServiceDir ${dir}\nHiddenServicePort 80 127.0.0.1:7072\n`);
  });
});

describe('registration manager', () => {
  it('builds owner actions unsigned, relays only what it built, and publishes operator settings itself', async () => {
    const onion = `${'b'.repeat(56)}.onion`;
    const { w, d } = await live(`${BASE_TOML}\n[registration]\ncontacts = [{ kind = 2, value = "#maker:matrix.example" }]\n[inbox]\npolicy = "swap_only"\n`);
    const status = await d.registration.status();
    expect(status.solana).toMatchObject({ registered: true, maker: w.sim.makerPda, owner: w.sim.owner, operator: w.keystore.solana.publicKey, enc_key_version: 1, payout_usdc_account: false, link: { current: null, mutual: false } });
    expect(status.ethereum.registered).toBe(false);
    expect(status.blob_endpoint).toBe(false);
    const built = await d.registration.buildTx({ chain: 'solana', action: 'set_eth_link', eth_address: `0x${'ab'.repeat(20)}` });
    expect(built.unsigned).toMatchObject({ chain: 'solana', fee_payer: w.sim.owner });
    expect(built.summary).toMatch(/7 days/);
    // The daemon holds no owner key: the message carries no signature, and the fee payer is the owner.
    const msg = Buffer.from((built.unsigned as { message_b64: string }).message_b64, 'base64');
    const tx = Transaction.populate((await import('@solana/web3.js')).Message.from(msg));
    expect(tx.feePayer!.toBase58()).toBe(w.sim.owner);
    const owner = seedSigner(fill(2));
    tx.addSignature(tx.feePayer!, Buffer.from(await owner.sign(tx.serializeMessage())));
    const sent = await d.registration.submit(built.request_id, tx.serialize().toString('base64'));
    expect(sent).toMatchObject({ chain: 'solana', status: 'sent' });
    await expect(d.registration.submit(built.request_id, tx.serialize().toString('base64'))).rejects.toThrow(/request_id/);
    // A different transaction under a valid request id is refused: the route is not an open relay.
    const other = await d.registration.buildTx({ chain: 'solana', action: 'set_payout', payout: owner.publicKey });
    await expect(d.registration.submit(other.request_id, tx.serialize().toString('base64'))).rejects.toThrow(/not the one this daemon built/);
    await expect(d.registration.buildTx({ chain: 'ethereum', action: 'set_paused', paused: true })).rejects.toThrow(/Ethereum is not configured/);

    // Operator-signed settings follow the configuration and the console's edits: one transaction, then nothing.
    d.store.setKv('published:onion', JSON.stringify(onion));
    expect(await d.registration.syncPublished()).not.toBeNull();
    expect(w.sim.maker()).toMatchObject({ onion, contacts: [{ kind: 2, value: '#maker:matrix.example' }], inboxPolicy: 1 });
    const again = await d.registration.syncPublished();
    // (Only the payout's USDC account, which the simulated chain cannot create, is still wanted.)
    expect(w.sim.names().filter((n) => n === 'set_onion')).toHaveLength(1);
    expect(again === null || typeof again === 'string').toBe(true);
    expect((await d.registration.status()).blob_endpoint).toBe(true);
    d.store.close();
  });
});

describe('dashboard and fee-wallet runway', () => {
  it('fills, spread earned, rates from the on-chain counters, missed deadlines, and the runway at the current rate', async () => {
    const { w, d } = await live();
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    await d.executor.tick();
    const m = w.sim.maker();
    m.counters[COUNTER.missed_notices] = 1;
    m.counters[COUNTER.approvals] = 3;
    m.counters[COUNTER.rejections] = 1;
    m.counters[COUNTER.aborts_early] = 1;
    m.counters[COUNTER.withholds] = 1;
    m.counters[COUNTER.deposits_returned] = 3;
    m.responseSecsSum = 36n;
    d.store.beat();
    const stats = statsView(d.store, [{ chain: 'solana', counters: m.counters, responseSecsSum: m.responseSecsSum }]);
    expect(stats).toMatchObject({ fills: 1, volume: [{ market: 'sol', xmr: (2n * XMR).toString(), asset: '300000000' }], missed_deadlines: 1, rates: { approval: 0.75, mean_response_secs: 12, abort: 1, withhold: 0.25 } });
    // 2 XMR × 150 USD × 2% deviation.
    expect(stats.spread_earned_usd).toBeCloseTo(6, 6);
    expect(stats.counters[0]!.values).toMatchObject({ locks: 1, completed: 1, missed_notices: 1 });
    const fees = feesView(d.store, { estimate: d.load.validation.update_cost, balances: [{ chain: 'solana', asset: 'sol', balance: '2880000000' }], usd: () => 100, runwayAlertDays: 7 });
    // 86,400 ÷ 15 s × 5,000 lamports = 0.0288 SOL a day: 2.88 SOL lasts 100 days.
    expect(fees.estimate!.daily_lamports).toBe('28800000');
    expect(fees.runway_days).toBeCloseTo(100, 6);
    expect(fees.spent_24h.find((f) => f.asset === 'sol')!.usd).toBeGreaterThan(0);
    // The alert fires when the wallet covers fewer days than the threshold.
    w.sim.fake.setAccount(w.keystore.solana.publicKey, '11111111111111111111111111111111', new Uint8Array(0), 100_000_000n);
    await d.housekeeping();
    expect(d.alerts.list().find((a) => a.kind === 'fee_runway')!.message).toMatch(/covers 3\.5 days/);
    d.store.close();
  });
});
