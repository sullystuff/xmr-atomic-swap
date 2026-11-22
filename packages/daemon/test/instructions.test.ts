// Operator instructions: journaled before they act, never overtaken by an automatic step while the
// contract still accepts the call, and always answered: carried out, refused with the reason, or pending.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { ata } from '@xmrswap/sdk';
import { startApi } from '../src/api/server.js';
import type { Daemon } from '../src/daemon.js';
import { XMR, buildNotice, swapJointAddress, viewOf } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
const WINDOW = BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\napproval_mode = "window"\ndeposit_pct = 2');
async function live(toml = BASE_TOML): Promise<{ w: World; d: Daemon }> {
  const w = await makeWorld(toml);
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, 1_000_000_000_000n, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
  const d = await w.boot();
  await d.start();
  return { w, d };
}
const openA = (w: World) => w.sim.open({ direction: 0, xmr: 2n * XMR, depBps: 200, makerSpendPub: w.sim.takePoolKey(0) });
/** Direction B up to NOTICED with real XMR at depth: the automatic next step would be `set_ready`. */
async function noticedB(w: World, d: Daemon) {
  const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
  await d.executor.tick();
  const view = viewOf(w.sim, s.pda);
  const joint = swapJointAddress(view, s.keys.view, 'regtest');
  const txid = w.xmr.external(joint.address, 3n * XMR);
  const notice = buildNotice(view, s.keys.encSecret, Uint8Array.from(Buffer.from(txid, 'hex')), s.keys.view);
  w.sim.takerCall(s.pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
  w.xmr.mine(2);
  w.sim.setTime(w.sim.swap(s.pda)!.tNotice + 120n);
  return s;
}

describe('direction A: abort', () => {
  it('is carried out before the notice and after it; refused once ready is set, and the claim still lands', async () => {
    const { w, d } = await live();
    const early = openA(w);
    await d.executor.scan();
    const r1 = await d.executor.manual(early.pda, { abort: true });
    expect(r1.instruction).toMatchObject({ action: 'abort', status: 'carried_out', tx: expect.any(String) });
    expect(w.sim.names(early.pda)).toEqual(['lock', 'abort']); // no lock was built, no notice posted: the instruction ran first
    expect(w.xmr.txs.size).toBe(0);

    const late = openA(w);
    await d.executor.tick();
    expect(w.sim.swap(late.pda)!.state).toBe(SWAP_STATE.NOTICED);
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(late.pda, { name: 'set_ready' });
    const r2 = await d.executor.manual(late.pda, { abort: true });
    expect(r2.instruction).toMatchObject({ action: 'abort', status: 'refused', reason: 'ready-already-set' });
    expect(w.sim.names(late.pda)).not.toContain('abort');
    expect(w.sim.swap(late.pda)!.outcome).toBe(COUNTER.completed);
    // One-shot: the refused instruction left no flag behind, and the maker was told.
    expect(d.store.swap(late.pda)!.facts.manual?.abort).toBeUndefined();
    expect(d.alerts.list().find((a) => a.kind === 'instruction_refused')).toMatchObject({ swap_ref: late.pda, message: expect.stringMatching(/ready-already-set/) });
    expect((await d.executor.manual(late.pda, { abort: true })).instruction).toMatchObject({ status: 'refused', reason: 'already-settled' });
    d.store.close();
  });

  it('survives its own transaction dying: the abort is planned again and reported only once it is confirmed', async () => {
    const { w, d } = await live();
    const s = openA(w);
    await d.executor.tick();
    w.sim.dropSends = 1;
    const r = await d.executor.manual(s.pda, { abort: true });
    expect(r.instruction).toMatchObject({ status: 'pending' });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.NOTICED);
    w.sim.blockHeight += 2_000;
    await d.executor.tick();
    expect(w.sim.names(s.pda)).toContain('abort');
    expect(d.store.swap(s.pda)!.facts.instruction).toMatchObject({ action: 'abort', status: 'carried_out' });
    d.store.close();
  });
});

describe('pending locks: approve and reject', () => {
  it('an explicit reject wins over an automatic approval that has not landed, and is honoured after a restart', async () => {
    const { w, d } = await live(WINDOW);
    const s = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    // The rules approve; the approval is broadcast but never lands.
    w.sim.dropSends = 1;
    await d.executor.tick();
    expect(d.store.swap(s.pda)!.facts.approval).toEqual({ approve: true });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.PENDING);
    // The operator rejects while that transaction is still in flight: recorded, pending, nothing sent twice.
    const r = await d.executor.manual(s.pda, { approve: false, rejectReason: 0 });
    expect(r.instruction).toMatchObject({ action: 'reject', status: 'pending' });
    expect(r).toMatchObject({ kind: 'waiting', on: 'transaction approve' });
    // Restart. The approval can no longer land; the journaled rejection, not a fresh automatic approval, is what happens next.
    d.store.close();
    w.sim.blockHeight += 2_000;
    const d2 = await w.boot();
    await d2.start();
    expect(w.sim.names(s.pda)).toEqual(['lock', 'reject']);
    expect(d2.store.swap(s.pda)!.facts.instruction).toMatchObject({ action: 'reject', status: 'carried_out' });
    d2.store.close();
  });

  it('a reject that the chain does not offer is refused with the reason, not dropped (Solana take outside window mode)', async () => {
    const { w, d } = await live();
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
    await d.executor.scan();
    const r = await d.executor.manual(s.pda, { approve: false, rejectReason: 0 });
    expect(r.instruction).toMatchObject({ action: 'reject', status: 'refused', reason: 'reject-not-available' });
    // The take is not funded behind the operator's back either: the rejection stands as the decision until the window lapses.
    await d.executor.tick();
    expect(w.sim.names(s.pda)).toEqual(['take']);
    d.store.close();
  });

  it('an approve after the window closed is refused', async () => {
    const { w, d } = await live(`${WINDOW}\n[approvals]\nauto_max_xmr = 1\n`);
    const s = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    await d.executor.tick();
    w.sim.setTime(w.sim.swap(s.pda)!.tPendingDeadline);
    const r = await d.executor.manual(s.pda, { approve: true });
    expect(r.instruction).toMatchObject({ action: 'approve', status: 'refused', reason: 'not-available-in-state' });
    expect(w.sim.names(s.pda)).toEqual(['lock']);
    d.store.close();
  });
});

describe('direction B: back out', () => {
  it('wins over setting ready while the refund is still safe; refused with the reason once ready is set or the window has closed', async () => {
    const { w, d } = await live();
    // XMR is confirmed at depth: the automatic step would set ready. The operator backs out first.
    const a = await noticedB(w, d);
    await d.executor.scan();
    const r1 = await d.executor.manual(a.pda, { abort: true });
    expect(r1.instruction).toMatchObject({ action: 'abort', status: 'carried_out' });
    expect(w.sim.names(a.pda)).toContain('refund');
    expect(w.sim.names(a.pda)).not.toContain('set_ready');

    // Ready already set: the escrow cannot be pulled back until the claim window closes.
    const b = await noticedB(w, d);
    await d.executor.tick();
    expect(w.sim.swap(b.pda)!.state).toBe(SWAP_STATE.READY);
    const r2 = await d.executor.manual(b.pda, { abort: true });
    expect(r2.instruction).toMatchObject({ status: 'refused', reason: 'ready-already-set' });
    expect(w.sim.names(b.pda)).not.toContain('refund');

    // Past T_co − M a refund could land in the taker's claim window and leak the share: refused, never sent.
    const c = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
    await d.executor.tick();
    const view = viewOf(w.sim, c.pda);
    const notice = buildNotice(view, c.keys.encSecret, Uint8Array.from(Buffer.from('cd'.repeat(32), 'hex')), c.keys.view);
    w.sim.takerCall(c.pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
    const sw = w.sim.swap(c.pda)!;
    w.sim.setTime(sw.tClaimOpen - BigInt(CHAIN_CONSTS.solana.marginSecs) + 1n);
    const secrets = w.sim.secretSends.length;
    const r3 = await d.executor.manual(c.pda, { abort: true });
    expect(r3.instruction).toMatchObject({ status: 'refused', reason: 'refund-window-closed' });
    expect(w.sim.secretSends.length).toBe(secrets);
    d.store.close();
  });
});

describe('deposits: withhold and release', () => {
  it('withhold inside the hold and release afterwards are carried out; outside those states each is refused with its reason', async () => {
    const { w, d } = await live();
    const s = openA(w);
    await d.executor.tick();
    // No deposit is in the hold yet.
    expect((await d.executor.manual(s.pda, { withhold: true })).instruction).toMatchObject({ action: 'withhold', status: 'refused', reason: 'no-deposit-held' });
    expect((await d.executor.manual(s.pda, { release: true, withhold: false })).instruction).toMatchObject({ action: 'release', status: 'refused', reason: 'no-deposit-held' });
    w.xmr.mine(1);
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.HOLD);
    expect((await d.executor.manual(s.pda, { withhold: true })).instruction).toMatchObject({ action: 'withhold', status: 'carried_out' });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.WITHHELD);
    expect((await d.executor.manual(s.pda, { release: true, withhold: false })).instruction).toMatchObject({ action: 'release', status: 'carried_out' });
    expect(w.sim.names(s.pda).filter((n) => n === 'withhold' || n === 'release_deposit')).toEqual(['withhold', 'release_deposit']);
    d.store.close();

    // After the 30-minute hold a withhold is refused by the contract: the operator is told, nothing is sent.
    const late = await live();
    const t = openA(late.w);
    await late.d.executor.tick();
    late.w.xmr.mine(1);
    late.w.sim.takerCall(t.pda, { name: 'refund', secretOk: true }, { revealed: t.keys.spend });
    await late.d.executor.tick();
    late.w.sim.setTime(late.w.sim.swap(t.pda)!.tRefund + 1800n);
    const sent = late.w.sim.fake.sent.length;
    expect((await late.d.executor.manual(t.pda, { withhold: true })).instruction).toMatchObject({ status: 'refused', reason: 'hold-ended' });
    expect(late.w.sim.names(t.pda)).not.toContain('withhold');
    expect(late.w.sim.fake.sent.length).toBe(sent);
    late.d.store.close();
  });

  it('"do not withhold this one" overrides an always-withhold policy before the automatic step runs, and across a restart', async () => {
    const { w, d } = await live(BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\ndeposit_pct = 2\nwithhold_policy = "always"'));
    const s = openA(w);
    await d.executor.tick();
    await d.executor.manual(s.pda, { withhold: false });
    d.store.close();
    w.xmr.mine(1);
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    const d2 = await w.boot();
    await d2.start();
    await d2.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.HOLD);
    expect(w.sim.names(s.pda)).not.toContain('withhold');
    d2.store.close();
  });
});

describe('pause', () => {
  it('stops an automatic approval that was decided but not yet sent, and still holds after a restart', async () => {
    const { w, d } = await live(WINDOW);
    const s = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    await d.executor.scan();
    // The rules had already said yes (the verdict is on record) when the operator pauses.
    d.store.patchFacts(s.pda, { approval: { approve: true } });
    d.risk.setPaused(true, 'incident');
    await d.executor.tick();
    expect(w.sim.names(s.pda)).toEqual(['lock', 'reject']);
    d.store.close();
    // Restart while paused: new locks are still rejected and the offers come back disabled.
    const t = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    const d2 = await w.boot();
    await d2.start();
    expect(d2.risk.paused).toBe(true);
    expect(w.sim.names(t.pda)).toEqual(['lock', 'reject']);
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 0, capacityXmr: 0n });
    // An explicit approval by the operator is its own decision and is honoured even while paused.
    const u = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR, depBps: 200 });
    await d2.executor.scan();
    expect((await d2.executor.manual(u.pda, { approve: true })).instruction).toMatchObject({ action: 'approve', status: 'carried_out' });
    d2.store.close();
  });
});

describe('API: the outcome reaches the caller', () => {
  it('answers carried out, refused (with the reason) or pending; the swap detail keeps the instruction', async () => {
    const { w, d } = await live();
    const api = await startApi(d, { bind: '127.0.0.1:0' });
    const post = async (ref: string, action: string, body: unknown = {}) => {
      const res = await fetch(`${api.url}/api/swaps/${ref}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      const b = await noticedB(w, d);
      await d.executor.tick();
      // Ready is set: the abort button is still offered in NOTICED/ACTIVE only, so drive the refusal through a state the API offers it in.
      const a = openA(w);
      await d.executor.tick();
      w.sim.dropSends = 1;
      const pending = await post(a.pda, 'abort');
      expect(pending).toEqual({ status: 200, body: { ok: true, tx: null, outcome: 'pending', detail: expect.stringMatching(/recorded and will be carried out.*survives a restart/) } });
      w.sim.blockHeight += 2_000;
      await d.executor.tick();
      const detail = (await (await fetch(`${api.url}/api/swaps/${a.pda}`, { headers: { Authorization: `Bearer ${d.token}` } })).json()) as { instruction: unknown };
      expect(detail.instruction).toEqual({ action: 'abort', at: expect.any(Number), status: 'carried_out', reason: null, tx: expect.any(String) });

      // A back-out the chain no longer accepts (the taker set... the maker set ready meanwhile; the page was stale).
      const stale = d.store.swap(b.pda)!;
      d.store.updateSwap(b.pda, { state: SWAP_STATE.NOTICED, snapshot: stale.snapshot!.replace(`"state":${SWAP_STATE.READY}`, `"state":${SWAP_STATE.NOTICED}`) });
      const refused = await post(b.pda, 'abort');
      expect(refused.status).toBe(200);
      expect(refused.body).toEqual({ ok: false, tx: null, outcome: 'refused', refused: 'ready-already-set', detail: expect.stringMatching(/abort was not carried out: ready is set/) });

      const c = openA(w);
      await d.executor.tick();
      const done = await post(c.pda, 'abort');
      expect(done.body).toEqual({ ok: true, tx: { chain: 'solana', id: expect.any(String), status: 'confirmed' }, outcome: 'carried_out', detail: 'abort: carried out' });
    } finally {
      await api.close();
      d.store.close();
    }
  });
});
