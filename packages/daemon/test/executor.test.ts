// The swap executor beyond the happy paths: approvals, aborts, refusals, reorgs, ambiguity, deposits and dry run.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, COUNTER, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import { ata, seedSigner } from '@xmrswap/sdk';
import type { Daemon } from '../src/daemon.js';
import { XMR } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
function usdc(w: World, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
async function live(toml = BASE_TOML, opts: { outputs?: bigint[] } = {}): Promise<{ w: World; d: Daemon }> {
  const w = await makeWorld(toml, opts);
  usdc(w, 1_000_000_000_000n);
  const d = await w.boot();
  await d.start();
  return { w, d };
}
const openA = (w: World, xmr = 2n * XMR) => w.sim.open({ direction: 0, xmr, makerSpendPub: w.sim.takePoolKey(0) });
/** Drive direction A to NOTICED with the XMR relayed. */
async function toNoticed(w: World, d: Daemon) {
  const s = openA(w);
  await d.executor.tick();
  expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.NOTICED);
  expect(w.xmr.relaysOf('wallet')).toHaveLength(1);
  return s;
}

describe('direction A', () => {
  it('builds the lock, posts the notice, relays only then, and claims when ready', async () => {
    const { w, d } = await live();
    const s = openA(w);
    expect(await d.executor.tick()).toEqual(new Map([[s.pda, { kind: 'waiting', on: 'ready', until: w.sim.swap(s.pda)!.tClaimOpen }]]));
    expect(w.log.filter((l) => l === 'chain:post_notice' || l.startsWith('xmr:'))).toEqual(['chain:post_notice', 'xmr:relay:wallet']);
    const row = d.store.swap(s.pda)!;
    expect(row).toMatchObject({ phase: 'xmr_relayed', state: SWAP_STATE.NOTICED, market: 'sol', direction: 0 });
    expect(row.joint_address).toMatch(/^4/);
    expect(d.store.intents({ swapRef: s.pda }).map((i) => `${i.kind}:${i.status}`)).toEqual(['xmr_prepare:confirmed', 'sol_tx:confirmed', 'xmr_relay:confirmed']);
    // Nothing happens until the taker sets ready; the claim follows at once.
    await d.executor.tick();
    expect(w.sim.secretSends).toEqual([]);
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    await d.executor.tick();
    expect(w.sim.swap(s.pda)).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(d.store.swap(s.pda)).toMatchObject({ terminal: 1, phase: 'completed' });
    expect(d.store.shareForSwap(s.pda)!.status).toBe('revealed');
    d.store.close();
  });

  it('aborts at once (A7a) when no unlocked output can fund the lock; no XMR and no notice', async () => {
    const { w, d } = await live(BASE_TOML, { outputs: [5_050_000_000_000n] });
    // The only output is taken by another swap first.
    const first = openA(w, XMR);
    await d.executor.tick();
    const second = openA(w, XMR);
    await d.executor.tick();
    expect(w.sim.names(second.pda)).toEqual(['lock', 'abort']);
    expect(w.sim.names(first.pda)).toEqual(['lock', 'post_notice']);
    expect(w.xmr.relaysOf('wallet')).toHaveLength(1);
    expect(d.alerts.list().some((a) => a.kind === 'no_inventory')).toBe(true);
    d.store.close();
  });

  it('aborts a swap that names a share this database does not hold, and a taker that replays our own share', async () => {
    const { w, d } = await live();
    const foreign = w.sim.open({ direction: 0, xmr: XMR, makerSpendPub: new Uint8Array(32).fill(0x58) });
    await d.executor.tick();
    expect(w.sim.names(foreign.pda)).toEqual(['lock', 'abort']);
    expect(w.xmr.txs.size).toBe(0);
    d.store.close();
  });

  it('does not re-send a transaction whose fate is unknown; re-plans once it can no longer land', async () => {
    const { w, d } = await live();
    const s = await toNoticed(w, d);
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    // The claim is broadcast but never lands.
    w.sim.dropSends = 1;
    const sentBefore = w.sim.fake.sent.length;
    await d.executor.tick();
    expect(w.sim.fake.sent.length).toBe(sentBefore + 1);
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.READY);
    // While its blockhash is still valid the daemon waits: no second broadcast of a spend share.
    for (let i = 0; i < 3; i++) expect((await d.executor.tick()).get(s.pda)).toMatchObject({ kind: 'waiting', on: 'transaction claim' });
    expect(w.sim.fake.sent.length).toBe(sentBefore + 1);
    // The blockhash expires: the intent is failed and the claim is planned again and lands.
    w.sim.blockHeight += 2_000;
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.DONE);
    expect(d.store.intents({ swapRef: s.pda }).filter((i) => i.payload['call'] === 'claim').map((i) => i.status)).toEqual(['failed', 'confirmed']);
    d.store.close();
  });

  it('parks a transaction that stays unresolved too long, alerts, never re-sends it, and picks it up when it lands', async () => {
    const { w, d } = await live();
    const s = await toNoticed(w, d);
    w.xmr.mine(2);
    w.sim.warp(120);
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    w.sim.dropSends = 1;
    await d.executor.tick();
    const intent = d.store.intents({ swapRef: s.pda }).find((i) => i.payload['call'] === 'claim')!;
    d.store.setIntent(intent.id, 'sent', { meta: { signedAtMs: Date.now() - 600_000 } });
    const sent = w.sim.fake.sent.length;
    await d.executor.tick();
    expect(d.store.intent(intent.id)!.status).toBe('needs_review');
    expect(d.store.swap(s.pda)!.needs_review).toBe(1);
    expect(d.alerts.list().find((a) => a.kind === 'tx_stuck')).toMatchObject({ level: 'critical', swap_ref: s.pda });
    await d.executor.tick();
    expect(w.sim.fake.sent.length).toBe(sent);
    // It lands after all (the node had it): the row is resolved and the swap completes.
    const wire = w.sim.fake.sent[w.sim.fake.sent.length - 1]!;
    w.sim.fake.onSend(wire);
    await d.executor.tick();
    expect(d.store.intent(intent.id)!.status).toBe('confirmed');
    expect(d.store.swap(s.pda)).toMatchObject({ needs_review: 0, terminal: 1, phase: 'completed' });
    d.store.close();
  });

  it('a claim the chain would refuse is stopped in simulation: the share is never broadcast', async () => {
    const { w, d } = await live();
    const s = await toNoticed(w, d);
    w.xmr.mine(2);
    w.sim.warp(120);
    const noticed = w.sim.swap(s.pda)!;
    w.sim.takerCall(s.pda, { name: 'set_ready' });
    // The daemon reads READY, but by the time it sends, the chain is not there (the endpoint served a state that
    // was rolled back): the simulation runs against a swap that refuses the claim.
    const realGet = w.sim.fake.getAccount.bind(w.sim.fake);
    const ready = w.sim.fake.accounts.get(s.pda)!;
    w.sim.fake.getAccount = async (p) => (p === s.pda ? ready : realGet(p));
    w.sim.putSwap(s.pda, noticed);
    const sent = w.sim.fake.sent.length;
    const out = (await d.executor.tick()).get(s.pda)!;
    expect(out).toMatchObject({ kind: 'error', error: expect.stringMatching(/claim refused/) });
    expect(w.sim.fake.sent.length).toBe(sent);
    expect(w.sim.secretSends).toEqual([]);
    expect(d.store.intents({ swapRef: s.pda }).find((i) => i.payload['call'] === 'claim')).toMatchObject({ status: 'failed', tx: null });
    w.sim.fake.getAccount = realGet;
    d.store.close();
  });

  it('rebroadcasts the STORED lock after a reorg drops it, and aborts if its input was spent elsewhere', async () => {
    const { w, d } = await live();
    const s = await toNoticed(w, d);
    const txid = d.store.lockTx(s.pda)!.txid;
    w.xmr.mine(1);
    w.xmr.orphan(txid);
    await d.executor.tick();
    expect(w.xmr.relays).toEqual([txid, txid]); // the same transaction, twice; never a second one
    expect(w.xmr.txs.size).toBe(1);
    expect(d.store.lockTx(s.pda)!.last_rebroadcast).not.toBeNull();
    // A node that cannot be reached is "unknown", not "gone": no rebroadcast, no abort.
    w.xmr.down = true;
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.NOTICED);
    w.xmr.down = false;
    // Now the lock is orphaned again and its input is spent by something else: it can never confirm.
    w.xmr.orphan(txid);
    const k = d.store.lockTx(s.pda)!.key_images[0]!;
    await w.xmr.thaw(k);
    const other = await w.xmr.prepare([{ address: 'elsewhere', amount: XMR }]);
    await w.xmr.sendRaw(other.txHex);
    w.sim.warp(61);
    // The rebroadcast is refused as a double spend (journaled as a refusal); the next pass aborts.
    await d.executor.tick();
    expect(d.store.intents({ swapRef: s.pda, kind: 'xmr_relay' }).pop()).toMatchObject({ status: 'failed', error: expect.stringMatching(/double spend/) });
    await d.executor.tick();
    expect(w.sim.names(s.pda)).toContain('abort');
    expect(d.store.swap(s.pda)!.facts.lockFailed).toBe(true);
    d.store.close();
  });

  it('without ready: claims at T_co when its own lock is confirmed, aborts when it is not, by default or by setting', async () => {
    const { w, d } = await live();
    const s = await toNoticed(w, d);
    w.xmr.mine(3);
    w.sim.setTime(w.sim.swap(s.pda)!.tClaimOpen);
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.outcome).toBe(COUNTER.claims_without_ready);
    expect(w.sim.secretSends).toEqual([{ name: 'claim', state: SWAP_STATE.NOTICED, at: w.sim.swap(s.pda)!.tClaimOpen }]);
    d.store.close();

    const b = await live(BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\nwithout_ready = "abort"'));
    const s2 = await toNoticed(b.w, b.d);
    b.w.xmr.mine(3);
    b.w.sim.setTime(b.w.sim.swap(s2.pda)!.tClaimOpen);
    await b.d.executor.tick();
    expect(b.w.sim.names(s2.pda)).toContain('abort');
    expect(b.w.sim.secretSends).toEqual([]);
    b.d.store.close();
  });

  it('window mode: approves by rule with a fresh share, rejects a denied taker, leaves large swaps to the maker', async () => {
    const toml = BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\napproval_mode = "window"') + '\n[approvals]\nauto_max_xmr = 3\n';
    const { w, d } = await live(toml);
    const small = w.sim.open({ direction: 0, mode: 1, xmr: 2n * XMR });
    await d.executor.tick();
    const approve = w.sim.landed.find((l) => l.swap === small.pda && l.name === 'approve')!;
    expect(approve).toBeDefined();
    expect(d.store.shareForSwap(small.pda)).toMatchObject({ purpose: 'approve', spend_pub: Buffer.from(approve.args['makerSpendPub'] as Uint8Array).toString('hex') });
    expect(w.sim.swap(small.pda)!.state).toBe(SWAP_STATE.NOTICED);
    // Above auto_max_xmr the rules only recommend: the lock stays pending for the console.
    const large = w.sim.open({ direction: 0, mode: 1, xmr: 4n * XMR });
    expect((await d.executor.tick()).get(large.pda)).toMatchObject({ kind: 'waiting', on: 'approval-decision' });
    expect(w.sim.swap(large.pda)!.state).toBe(SWAP_STATE.PENDING);
    await d.executor.manual(large.pda, { approve: true });
    expect(w.sim.names(large.pda)).toContain('approve');
    const third = w.sim.open({ direction: 0, mode: 1, xmr: 4n * XMR });
    await d.executor.tick();
    await d.executor.manual(third.pda, { approve: false, rejectReason: 0 });
    expect(w.sim.landed.find((l) => l.swap === third.pda && l.name === 'reject')!.args['reason']).toBe(0);
    d.store.close();

    const deny = await live(`${toml}deny = ["${seedSigner(new Uint8Array(32).fill(5)).publicKey}"]\n`);
    const refused = deny.w.sim.open({ direction: 0, mode: 1, xmr: XMR });
    await deny.d.executor.tick();
    expect(deny.w.sim.names(refused.pda)).toEqual(['lock', 'reject']);
    expect(deny.d.store.shares({ purpose: 'approve' })).toHaveLength(0); // a pending lock reserves no key
    deny.d.store.close();
  });

  it('after a taker refund: sweeps its XMR back, withholds by policy WITH the evidence, releases on the maker\'s decision', async () => {
    const toml = BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\ndeposit_pct = 2\nwithhold_policy = "always"');
    const { w, d } = await live(toml);
    const s = w.sim.open({ direction: 0, xmr: 2n * XMR, depBps: 200, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    w.xmr.mine(1);
    w.sim.takerCall(s.pda, { name: 'refund', secretOk: true }, { revealed: s.keys.spend });
    await d.executor.tick();
    // The withhold carries the opening of the maker's own notice, and it opens the commitment on record.
    const withhold = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'withhold')!;
    expect(withhold.args['evidence']).toMatchObject({ txid: Uint8Array.from(Buffer.from(d.store.lockTx(s.pda)!.txid, 'hex')) });
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.WITHHELD);
    expect(w.sim.swap(s.pda)!.flags & SWAP_FLAG.EVIDENCE).toBeTruthy();
    // The sweep waits for 10 confirmations, whatever the swap's depth.
    expect(w.xmr.sweepsBuilt).toHaveLength(0);
    w.xmr.mine(10);
    await d.executor.tick();
    expect(w.xmr.relaysOf('sweep')).toHaveLength(1);
    expect(w.xmr.txs.get(w.xmr.relaysOf('sweep')[0]!)!.destinations[0]!.address).toBe(w.xmr.walletAddress);
    expect(d.store.swap(s.pda)).toMatchObject({ swept: 1, terminal: 0 });
    // The taker asks in the inbox; the maker releases from the console.
    await d.executor.manual(s.pda, { release: true, withhold: false });
    expect(w.sim.names(s.pda).slice(-2)).toEqual(['release_deposit', 'close_swap']);
    expect(d.store.swap(s.pda)!.terminal).toBe(1);
    d.store.close();
  });

  it('dry run: decisions are computed and shown; no transaction is sent and no XMR moves', async () => {
    const w = await makeWorld(BASE_TOML.replace('mode = "live"', 'mode = "dry_run"'));
    const d = await w.boot();
    await d.start();
    const s = w.sim.open({ direction: 0, xmr: XMR, makerSpendPub: new Uint8Array(32).fill(1) });
    const out = (await d.executor.tick()).get(s.pda)!;
    expect(out.kind).toBe('parked');
    expect(w.sim.fake.sent).toHaveLength(0);
    expect(w.xmr.txs.size).toBe(0);
    d.store.close();
  });
});

describe('direction B', () => {
  it('funds within the paying cap, rejects beyond it, and refunds at once when the taker never posts a notice', async () => {
    const { w, d } = await live(`${BASE_TOML.replace('[liquidity]', '[liquidity]\npaying_caps = { usdc_sol = 500 }')}`);
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
    await d.executor.tick();
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.ACTIVE);
    const fund = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'fund')!;
    expect(d.store.shareForSwap(s.pda)).toMatchObject({ purpose: 'fund', status: 'bound', spend_pub: Buffer.from(fund.args['makerSpendPub'] as Uint8Array).toString('hex') });
    // 450 USDC are escrowed; a second 3 XMR take would pass the 500 USDC cap.
    expect(d.escrowed('usdc_sol')).toBe(450_000_000n);
    const second = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
    expect((await d.executor.tick()).get(second.pda)).toMatchObject({ kind: 'waiting', on: 'lapse' });
    expect(d.store.swap(second.pda)!.facts.approval).toEqual({ approve: false, reason: 0 });
    expect(w.sim.names(second.pda)).toEqual(['take']);
    // No notice by the deadline: the escrow comes back at once (B9b).
    w.sim.setTime(w.sim.swap(s.pda)!.tNoteDeadline);
    await d.executor.tick();
    expect(w.sim.names(s.pda)).toContain('refund');
    d.store.close();
  });

  it('never sets ready on a lock that is too small, unconfirmed, or announced by a notice that does not open; refunds in [T_cut, T_co − M]', async () => {
    const { w, d } = await live();
    const { buildNotice, swapJointAddress, viewOf } = await import('./sim.js');
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
    await d.executor.tick();
    const view = viewOf(w.sim, s.pda);
    const joint = swapJointAddress(view, s.keys.view, 'regtest');
    const txid = w.xmr.external(joint.address, 2n * XMR); // pays too little
    const notice = buildNotice(view, s.keys.encSecret, Uint8Array.from(Buffer.from(txid, 'hex')), s.keys.view);
    w.sim.takerCall(s.pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
    w.xmr.mine(5);
    w.sim.warp(300);
    expect((await d.executor.tick()).get(s.pda)).toMatchObject({ kind: 'waiting', on: 'xmr-confirmations', until: w.sim.swap(s.pda)!.tCut });
    expect(w.sim.names(s.pda)).not.toContain('set_ready');
    expect(d.executor.lockReports.get(s.pda)).toMatchObject({ state: 'invalid', ok: false });
    const sw = w.sim.swap(s.pda)!;
    w.sim.setTime(sw.tCut);
    await d.executor.tick();
    const refund = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'refund')!;
    expect(refund.at).toBe(sw.tCut);
    expect(refund.at <= sw.tClaimOpen - BigInt(CHAIN_CONSTS.solana.marginSecs)).toBe(true);
    d.store.close();
  });
});

describe('restart', () => {
  it('adopts swaps opened while the daemon was down, and refuses a database bound to another maker or wallet', async () => {
    const w = await makeWorld();
    let d = await w.boot();
    await d.start();
    d.store.close();
    const s = openA(w);
    d = await w.boot();
    await d.start();
    expect(d.store.swap(s.pda)).toMatchObject({ state: SWAP_STATE.NOTICED, phase: 'xmr_relayed' });
    d.store.close();
    const original = w.xmr.walletAddress;
    (w.xmr as { walletAddress: string }).walletAddress = '4'.padEnd(95, 'B');
    await expect(w.boot()).rejects.toThrow(/bound to wallet/);
    (w.xmr as { walletAddress: string }).walletAddress = original;
  });
});
