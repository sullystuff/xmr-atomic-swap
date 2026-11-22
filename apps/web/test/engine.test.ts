// The swap engine against a chain that follows the SDK's reference state machine: every step is
// decided by `takerStep`, signed by the session key (no wallet), and fails closed on Monero.
import { beforeEach, describe, expect, it } from 'vitest';
import { COUNTER, SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf } from '@xmrswap/sdk';
import { Engine, knownRefs, loadNote } from '../src/lib/engine.js';
import { WalletNeeded } from '../src/lib/ports.js';
import { safetyOf } from '../src/lib/safety.js';
import { FakeMonero, ModelChain, TAKER, TAKER_SEED, XMR } from './fakes.js';

const TXID = 'ab'.repeat(32);
const DEST = `4${'A'.repeat(94)}`;

function rig(seed: Uint8Array | null = TAKER_SEED) {
  const chain = new ModelChain();
  const monero = new FakeMonero();
  const engine = new Engine({ ports: () => ({ solana: chain }), monero, seed: () => seed, takers: () => ({ solana: [TAKER] }), network: () => 'mainnet' });
  const only = () => engine.getState().swaps[0]!;
  return { chain, monero, engine, only };
}

beforeEach(() => localStorage.clear());

describe('buying XMR (direction A)', () => {
  it('runs the whole swap with the session key: at risk while locked, ready at depth, sweep after the claim, then closes the account', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    engine.annotate(ref, { destination: DEST, market: 'sol' });
    await engine.poll();
    expect(only()).toMatchObject({ ref, leg: 'locked', atRisk: true });
    expect(only().decision).toMatchObject({ do: 'wait', on: 'notice' });
    expect(safetyOf(engine.getState(), true)).toMatchObject({ safeToClose: false });
    expect(safetyOf(engine.getState(), true).atRisk).toHaveLength(1);

    // The maker announces its lock; the XMR is in the mempool only.
    chain.advance(10);
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'pending', confirmations: 0 });
    await engine.poll();
    expect(only()).toMatchObject({ leg: 'xmr-seen', atRisk: true, noticeOpens: true, lockTxid: TXID });
    expect(only().joint?.address).toMatch(/^4/);
    expect(only().decision).toMatchObject({ do: 'wait', on: 'xmr-confirmations' });
    const d = deadlinesOf('solana', chain.swaps.get(ref)!);
    // The banner counts down to the last second the tab can still refund by itself.
    expect(only().refundDeadline).toBe(d.tCo! - d.margin);

    // One confirmation is not the swap's depth.
    monero.locks.set(TXID, { state: 'confirming', confirmations: 1 });
    await engine.poll();
    expect(chain.called('set_ready')).toBe(0);

    // At depth, but the contract's minimum wait has not passed: the flow waits, the tab does not guess.
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    await engine.poll();
    expect(only().decision).toMatchObject({ do: 'wait', on: 'ready-minimum' });
    chain.warpTo(d.tReadyMin!);
    await engine.poll();
    expect(chain.calls).toEqual([[ref, 'set_ready', 'session']]);
    expect(only()).toMatchObject({ leg: 'ready', atRisk: false, refundDeadline: null });
    const safe = safetyOf(engine.getState(), true);
    expect(safe.safeToClose).toBe(true);
    expect(safe.comeBackBefore).toBe(d.tFinal - d.margin);
    // No backup, no green state.
    expect(safetyOf(engine.getState(), false).safeToClose).toBe(false);

    // The maker claims: its share is public, the XMR is ours but not spendable before 10 blocks.
    chain.maker.claim(ref);
    await engine.poll();
    expect(only()).toMatchObject({ leg: 'claimed', sweep: { phase: 'waiting', blocksLeft: 8 } });
    expect(monero.sweeps).toHaveLength(0);
    expect(engine.canExport(only())).toBe(true);
    expect(engine.exportKeys(ref)).toMatchObject({ address: only().joint!.address, lock_txid: TXID });

    monero.locks.set(TXID, { state: 'confirmed', confirmations: 10 });
    await engine.poll();
    expect(monero.sweeps).toEqual([{ destination: DEST, lockTxid: TXID, maxFee: 5_000_000_000n }]);
    expect(only().sweep).toMatchObject({ phase: 'broadcast' });
    // Keep watching until the sweep itself is mined; only then is the account closed.
    await engine.poll();
    expect(chain.called('close_swap')).toBe(0);
    monero.txs.set(only().note.sweepTxid!, 'mined');
    await engine.poll();
    await engine.poll();
    expect(only().sweep).toMatchObject({ phase: 'confirmed' });
    expect(chain.calls.at(-1)).toEqual([ref, 'close_swap', 'session']);
    await engine.poll();
    expect(only()).toMatchObject({ view: null, leg: 'swept', atRisk: false });
    expect(loadNote(ref)).toMatchObject({ closed: true, sweepConfirmed: true, ended: 'claim' });
  });

  it('refunds by itself at the cutoff when the lock has not reached the depth (SPEC 8.5 item 7)', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    chain.advance(5);
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'confirming', confirmations: 1 });
    await engine.poll();
    const d = deadlinesOf('solana', chain.swaps.get(ref)!);
    chain.warpTo(d.tCut! - 1n);
    await engine.poll();
    expect(chain.called('refund')).toBe(0);
    chain.warpTo(d.tCut!);
    await engine.poll();
    expect(chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(chain.swaps.get(ref)!.state).toBe(SWAP_STATE.HOLD);
    expect(only()).toMatchObject({ leg: 'refunded', atRisk: false });
    expect(only().note.autoRefunded).toBe(true);
    // The deposit is held 30 minutes, then the tab collects it (anyone may).
    expect(only().decision).toMatchObject({ do: 'wait', on: 'deposit-hold' });
    chain.advance(1800);
    await engine.poll();
    expect(chain.calls.at(-1)).toEqual([ref, 'release_deposit', 'anyone']);
  });

  it('treats a notice that does not open as no lock, and refunds at the cutoff', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID, false);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 30 });
    await engine.poll();
    expect(only()).toMatchObject({ noticeOpens: false, joint: null });
    expect(only().decision).toMatchObject({ do: 'wait', warning: 'notice-invalid' });
    expect(monero.verifyCalls).toBe(0);
    chain.warpTo(deadlinesOf('solana', chain.swaps.get(ref)!).tCut!);
    await engine.poll();
    expect(chain.called('refund')).toBe(1);
    expect(chain.called('set_ready')).toBe(0);
  });

  it('fails closed: nodes that disagree, or an unreachable node, never count as confirmed', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID);
    const d = deadlinesOf('solana', chain.swaps.get(ref)!);
    chain.warpTo(d.tReadyMin!);
    // Deep on one node, but the nodes disagree about the block.
    monero.locks.set(TXID, { state: 'confirming', confirmations: 12, reasons: ['node-disagreement: nodes report different blocks for the lock'] });
    await engine.poll();
    expect(chain.called('set_ready')).toBe(0);
    expect(only().lock).toMatchObject({ ok: false });
    // A node goes away entirely.
    monero.down = true;
    await engine.poll();
    expect(chain.called('set_ready')).toBe(0);
    expect(engine.getState().health.monero.ok).toBe(false);
    expect(only().lockError).toMatch(/node-failed/);
    // The node policy is not met (one node, not the user's own): same.
    monero.down = false;
    monero.policy = 'Only one Monero node is configured and it is not marked as your own.';
    await engine.poll();
    expect(chain.called('set_ready')).toBe(0);
    chain.warpTo(d.tCut!);
    await engine.poll();
    expect(chain.called('refund')).toBe(1);
  });

  it('a pending lock is not at risk, can be cancelled, and comes back in full', async () => {
    const { chain, engine, only } = rig();
    const { ref } = chain.open({ mode: 1 });
    await engine.poll();
    expect(only()).toMatchObject({ leg: 'pending-approval', atRisk: false });
    expect(safetyOf(engine.getState(), true).safeToClose).toBe(true);
    engine.annotate(ref, { cancel: true });
    await engine.poll();
    expect(chain.calls).toEqual([[ref, 'cancel_pending', 'session']]);
    await engine.poll();
    expect(only()).toMatchObject({ view: null, leg: 'refunded' });
  });

  it('collects the keyless refund when the maker posts no notice by its deadline', async () => {
    const { chain, engine, only } = rig();
    const { ref } = chain.open();
    await engine.poll();
    // In ACTIVE the banner counts down to the notice deadline.
    const tNote = deadlinesOf('solana', chain.swaps.get(ref)!).tNote!;
    expect(only().refundDeadline).toBe(tNote);
    chain.warpTo(tNote);
    await engine.poll();
    expect(chain.calls).toEqual([[ref, 'refund_unnoticed', 'anyone']]);
  });

  it('refunds when the user asks to get out after the notice', async () => {
    const { chain, monero, engine } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'pending', confirmations: 0 });
    await engine.poll();
    engine.annotate(ref, { cancel: true });
    await engine.poll();
    expect(chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(loadNote(ref).autoRefunded).toBeUndefined();
  });

  it('refunds after the claim deadline when the maker never claims (maker fault)', async () => {
    const { chain, monero, engine } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    chain.advance(120);
    await engine.poll();
    expect(chain.swaps.get(ref)!.state).toBe(SWAP_STATE.READY);
    chain.warpTo(deadlinesOf('solana', chain.swaps.get(ref)!).tCd!);
    await engine.poll();
    expect(chain.calls.at(-1)).toEqual([ref, 'refund', 'session']);
    // A fault refund is free: nothing is held.
    expect(chain.swaps.get(ref)!).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.missed_claims });
  });

  it('a failed action is reported and retried on the next pass', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    chain.advance(120);
    chain.failNext = new Error('Transaction simulation failed: blockhash not found');
    await engine.poll();
    expect(only().error).toMatch(/blockhash/);
    expect(chain.swaps.get(ref)!.state).toBe(SWAP_STATE.NOTICED);
    await engine.poll();
    expect(only().error).toBeNull();
    expect(chain.swaps.get(ref)!.state).toBe(SWAP_STATE.READY);
  });

  it('a call that needs the wallet is flagged, not dropped', async () => {
    const { chain, engine, only } = rig();
    chain.open({ mode: 1 });
    chain.advance(61);
    chain.failNext = new WalletNeeded('solana');
    await engine.poll();
    expect(only()).toMatchObject({ needsWallet: true, error: null });
  });
});

describe('the sweep is retryable and the output stays safe', () => {
  it('a failed attempt spends nothing, is retried, and the keys can be exported meanwhile', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    engine.annotate(ref, { destination: DEST });
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 12 });
    chain.advance(120);
    await engine.poll();
    chain.maker.claim(ref);
    monero.sweepFailures = ['SweepDecoySelection: not enough decoys', 'SweepDecoySelection: not enough decoys'];
    await engine.poll();
    expect(only().sweep).toEqual({ phase: 'failed', error: 'SweepDecoySelection: not enough decoys', attempts: 1 });
    expect(monero.sweeps).toHaveLength(0);
    expect(only().leg).toBe('claimed');
    expect(engine.exportKeys(ref).spend_key).toMatch(/^[0-9a-f]{64}$/);
    // The account that holds the maker's revealed share is not closed while the XMR is unswept.
    expect(chain.called('close_swap')).toBe(0);
    await engine.poll();
    expect(only().sweep).toMatchObject({ phase: 'failed', attempts: 2 });
    engine.retrySweep(ref);
    await engine.poll();
    expect(only().sweep).toMatchObject({ phase: 'broadcast' });
    expect(monero.sweeps).toHaveLength(1);
  });

  it('asks for a destination instead of guessing one', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 12 });
    chain.advance(120);
    await engine.poll();
    chain.maker.claim(ref);
    await engine.poll();
    expect(only().sweep).toEqual({ phase: 'need-destination' });
    engine.annotate(ref, { destination: DEST });
    await engine.poll();
    expect(monero.sweeps[0]!.destination).toBe(DEST);
  });

  it('exporting the keys counts as collected: the account may then be closed', async () => {
    const { chain, monero, engine } = rig();
    const { ref } = chain.open();
    chain.maker.notice(ref, TXID);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 3 });
    chain.advance(120);
    await engine.poll();
    chain.maker.claim(ref);
    await engine.poll();
    engine.annotate(ref, { exported: true });
    await engine.poll();
    expect(chain.calls.at(-1)).toEqual([ref, 'close_swap', 'session']);
    expect(monero.sweeps).toHaveLength(0);
  });
});

describe('resume after a reload (SPEC 8.4, 8.5 item 9)', () => {
  it('a fresh engine rebuilds the swap from chain state plus the seed and carries on at once', async () => {
    const a = rig();
    const { ref } = a.chain.open();
    a.chain.maker.notice(ref, TXID);
    a.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    await a.engine.poll();
    expect(a.chain.called('set_ready')).toBe(0);
    // The tab goes away. Nothing but the chain and the seed survive (local notes are wiped too).
    localStorage.clear();
    a.chain.advance(300);
    const engine = new Engine({ ports: () => ({ solana: a.chain }), monero: a.monero, seed: () => TAKER_SEED, takers: () => ({ solana: [TAKER] }), network: () => 'mainnet' });
    await engine.poll();
    expect(a.chain.calls).toEqual([[ref, 'set_ready', 'session']]);
    expect(engine.getState().swaps[0]).toMatchObject({ ref, leg: 'ready', lockTxid: TXID });
    expect(knownRefs()).toEqual([ref]);
  });

  it('comes back after the cutoff with nothing confirmed: refunds what is still refundable', async () => {
    const a = rig();
    const { ref } = a.chain.open();
    a.chain.maker.notice(ref, TXID);
    const d = deadlinesOf('solana', a.chain.swaps.get(ref)!);
    a.chain.warpTo(d.tCo! - d.margin);
    const engine = new Engine({ ports: () => ({ solana: a.chain }), monero: a.monero, seed: () => TAKER_SEED, takers: () => ({ solana: [TAKER] }), network: () => 'mainnet' });
    await engine.poll();
    expect(a.chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(engine.getState().swaps[0]!.lost).toBeNull();
  });

  it('comes back too late to refund safely: sends nothing and says plainly what can be lost', async () => {
    const a = rig();
    const { ref } = a.chain.open();
    a.chain.maker.notice(ref, TXID);
    const d = deadlinesOf('solana', a.chain.swaps.get(ref)!);
    // One second past the last safe refund: a refund now could land after the maker's window opens.
    a.chain.warpTo(d.tCo! - d.margin + 1n);
    const engine = new Engine({ ports: () => ({ solana: a.chain }), monero: a.monero, seed: () => TAKER_SEED, takers: () => ({ solana: [TAKER] }), network: () => 'mainnet' });
    await engine.poll();
    expect(a.chain.calls).toEqual([]);
    const t = engine.getState().swaps[0]!;
    expect(t.decision).toMatchObject({ do: 'wait', warning: 'refund-window-missed' });
    expect(t.lost).toMatch(/refund deadline passed/);
    expect(t.lost).toMatch(/your payment is lost/);
  });

  it('the maker claimed without ready while the tab was away: a false lock is a stated loss, a real lock is swept', async () => {
    const a = rig();
    const { ref } = a.chain.open();
    a.chain.maker.notice(ref, TXID);
    a.chain.warpTo(deadlinesOf('solana', a.chain.swaps.get(ref)!).tCo!);
    a.chain.maker.claim(ref);
    expect(a.chain.swaps.get(ref)!.outcome).toBe(COUNTER.claims_without_ready);
    const mk = () => new Engine({ ports: () => ({ solana: a.chain }), monero: a.monero, seed: () => TAKER_SEED, takers: () => ({ solana: [TAKER] }), network: () => 'mainnet' });
    // The lock named in the notice never existed.
    const e1 = mk();
    e1.annotate(ref, { destination: DEST });
    await e1.poll();
    expect(e1.getState().swaps[0]!.lost).toMatch(/does not check out.*your payment is lost/);
    expect(a.monero.sweeps).toHaveLength(0);
    // Same history, but the XMR really is there: it is collected.
    a.monero.locks.set(TXID, { state: 'confirmed', confirmations: 40 });
    const e2 = mk();
    await e2.poll();
    expect(e2.getState().swaps[0]!.lost).toMatch(/yours to collect/);
    expect(a.monero.sweeps).toHaveLength(1);
  });

  it('a swap opened with another recovery file is shown but cannot be acted on', async () => {
    const a = rig();
    a.chain.open({ seed: new Uint8Array(32).fill(9) });
    await a.engine.poll();
    const t = a.only();
    expect(t.keys).toBeNull();
    expect(t.decision).toBeNull();
    expect(safetyOf(a.engine.getState(), true)).toMatchObject({ safeToClose: false });
    expect(safetyOf(a.engine.getState(), true).blind).toHaveLength(1);
  });

  it('with no seed loaded nothing is signed', async () => {
    const a = rig(null);
    const { ref } = a.chain.open();
    a.chain.warpTo(deadlinesOf('solana', a.chain.swaps.get(ref)!).tNote!);
    await a.engine.poll();
    expect(a.chain.calls).toEqual([]);
    expect(a.only().atRisk).toBe(true);
  });
});

describe('connection health', () => {
  it('records an unreachable RPC and recovers', async () => {
    const { chain, engine } = rig();
    chain.open();
    await engine.poll();
    expect(engine.getState().health.solana.ok).toBe(true);
    chain.down = true;
    await engine.poll();
    expect(engine.getState().health.solana).toMatchObject({ ok: false, error: expect.stringMatching(/connection refused/) });
    // The swap is still known and still at risk while the chain cannot be seen.
    expect(engine.getState().swaps[0]!.atRisk).toBe(true);
    chain.down = false;
    await engine.poll();
    expect(engine.getState().health.solana.ok).toBe(true);
  });

  it('reads time from the chain and reports the difference from the local clock', async () => {
    const chain = new ModelChain();
    const engine = new Engine({ ports: () => ({ solana: chain }), monero: new FakeMonero(), seed: () => TAKER_SEED, takers: () => ({ solana: [TAKER] }), network: () => 'mainnet', nowMs: () => Number(chain.now_ + 45n) * 1000 });
    await engine.poll();
    expect(engine.getState().skewSecs).toBe(45);
  });
});

describe('selling XMR (direction B)', () => {
  it('take, wait for the maker funds, find and verify the payment, post the notice and claim with the session key', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open({ direction: 1, xmr: 3n * XMR });
    engine.annotate(ref, { destination: DEST });
    await engine.poll();
    expect(only()).toMatchObject({ leg: 'pending-approval', atRisk: false });
    expect(only().decision).toMatchObject({ do: 'wait', on: 'funding' });
    expect(only().joint).toBeNull();

    chain.maker.fund(ref);
    await engine.poll();
    // The address exists only now, computed from the four halves in the page.
    expect(only().decision).toMatchObject({ do: 'offchain', action: 'show-address' });
    expect(only().joint?.address).toMatch(/^4/);
    expect(only().note.scanFrom).toBe(998);
    expect(chain.calls).toEqual([]);

    // Too small a payment is not accepted as the lock.
    monero.deposits = [{ txid: 'cd'.repeat(32), inPool: true, blockHeight: null, amount: XMR }];
    await engine.poll();
    expect(chain.calls).toEqual([]);
    // The right one is: the notice goes out at zero confirmations, signed by the session key.
    monero.deposits.push({ txid: TXID, inPool: true, blockHeight: null, amount: 3n * XMR });
    await engine.poll();
    expect(chain.calls).toEqual([[ref, 'post_notice', 'session']]);
    expect(only()).toMatchObject({ leg: 'xmr-seen', lockTxid: TXID, atRisk: false });
    const sell = safetyOf(engine.getState(), true);
    expect(sell.sellOpen).toHaveLength(1);
    expect(sell.safeToClose).toBe(false);

    chain.advance(200);
    chain.maker.ready(ref);
    await engine.poll();
    expect(chain.calls.at(-1)).toEqual([ref, 'claim', 'session']);
    expect(chain.swaps.get(ref)!).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(only().decision).toEqual({ do: 'done', outcome: 'completed' });
  });

  it('recovers the XMR to the refund address when the maker refunds after the payment', async () => {
    const { chain, monero, engine, only } = rig();
    const { ref } = chain.open({ direction: 1 });
    engine.annotate(ref, { destination: DEST });
    chain.maker.fund(ref);
    monero.deposits = [{ txid: TXID, inPool: true, blockHeight: null, amount: XMR }];
    await engine.poll();
    expect(chain.called('post_notice')).toBe(1);
    chain.advance(60);
    chain.maker.refund(ref);
    monero.locks.set(TXID, { state: 'confirmed', confirmations: 11 });
    await engine.poll();
    expect(monero.sweeps).toEqual([{ destination: DEST, lockTxid: TXID, maxFee: 5_000_000_000n }]);
    expect(only().sweep).toMatchObject({ phase: 'broadcast' });
  });
});
