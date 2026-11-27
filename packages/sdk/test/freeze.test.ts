// Amendment 1 (SPEC 11.6, 11.2): what the flows decide in FROZEN, the explicit freeze request,
// the delivery of parked claim proceeds to a payout address, and `watcherStep`, the whole
// behaviour of a watcher. The oracle is the reference model (replayed in machine.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type ChainName, SWAP_STATE } from '@xmrswap/protocol';
import { type MakerFacts, makerStep } from '../src/flows/maker.js';
import { type TakerFacts, freezeRefusal, takerAtRisk, takerRefundDeadline, takerStep } from '../src/flows/taker.js';
import type { LockReport } from '../src/flows/types.js';
import { type Call, type ModelSwap, type Role, apply, errorOf, tFf } from '../src/machine/model.js';
import { type SwapView, deadlinesOf } from '../src/machine/view.js';
import { type WatcherFacts, watcherStep } from '../src/watcher/step.js';
import { swapOf, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const z32 = new Uint8Array(32);
const WATCHER = 'watcher-key';
function view(chain: ChainName, s: ModelSwap, over: Partial<SwapView> = {}): SwapView {
  return {
    ...s,
    chain,
    swapRef: z32,
    taker: 'taker',
    maker: 'maker',
    asset: '0',
    xmr: 2_000_000_000_000n,
    price: 0n,
    depBps: 100,
    swapNonce: new Uint8Array(16),
    sessionKey: 'session',
    takerEncKey: z32,
    makerEncVersion: 1,
    makerEncKey: z32,
    takerSpendPub: z32,
    makerSpendPub: z32,
    lockerView: z32,
    noticeCommitment: z32,
    noticeCt: new Uint8Array(0),
    evidenceTxid: z32,
    evidenceView: z32,
    revealed: z32,
    payoutAddress: s.payout === 'none' ? null : s.payout === 'taker' ? 'taker' : 'payout-address',
    watcherAddress: s.watcher ? WATCHER : null,
    ...over,
  };
}
/** The swap after the first successful `call` step of a named sequence (step numbers differ per chain: Ethereum always approves). */
function after(chain: ChainName, name: string, call: string): ModelSwap {
  const q = vector('transitions').sequences.find((x: any) => x.chain === chain && x.name === name);
  if (!q) throw new Error(`no sequence ${name}`);
  const s = q.steps.find((x: any) => x.call === call && x.expect.ok);
  if (!s) throw new Error(`${name} has no successful ${call}`);
  return swapOf(s.expect.swap);
}

const GOOD: LockReport = { state: 'confirmed', ok: true, confirmations: 30 };
const SHALLOW: LockReport = { state: 'confirming', ok: false, confirmations: 1 };
const BAD: LockReport = { state: 'invalid', ok: false, confirmations: 0 };
const MISSING: LockReport = { state: 'not-found', ok: false, confirmations: 0 };

for (const chain of ['solana', 'ethereum'] as const) {
  const M = BigInt(CHAIN_CONSTS[chain].marginSecs);

  describe(`${chain}: taker, direction A, frozen (the taker's tab was closed; the watcher paused the swap)`, () => {
    const noticed = after(chain, 'exit/A/freeze-then-ready-then-claim', 'post_notice');
    const frozen = after(chain, 'exit/A/freeze-then-ready-then-claim', 'freeze');
    const d = deadlinesOf(chain, frozen);
    const ff = d.tFf!;
    const step = (now: bigint, f: Partial<TakerFacts> = {}, s: ModelSwap = frozen) => takerStep({ swap: view(chain, s), now, ...f });

    it('the frozen-final time is max(t_Z + W_z, T_co) and is what the banner counts down to', () => {
      expect(frozen.state).toBe(SWAP_STATE.FROZEN);
      expect(ff).toBe(tFf(frozen));
      const sum = frozen.tFreeze + BigInt(frozen.wZ);
      expect(ff).toBe(sum > frozen.tClaimOpen ? sum : frozen.tClaimOpen);
      expect(ff >= d.tCo!).toBe(true);
      expect(takerAtRisk(view(chain, frozen))).toBe(true);
      expect(takerRefundDeadline(view(chain, frozen))).toBe(ff - M);
      expect(tFf(noticed)).toBe(null);
    });

    it('on return it verifies the lock itself: needs the opening, then the report', () => {
      expect(step(frozen.tFreeze + 10n)).toEqual({ do: 'need', fact: 'notice-opening' });
      expect(step(frozen.tFreeze + 10n, { noticeOpens: true })).toEqual({ do: 'need', fact: 'lock-report' });
    });

    it('a good lock is un-frozen by setting ready (Z2), never before the ready minimum, until T_ff − 1', () => {
      const facts = { noticeOpens: true, lock: GOOD };
      expect(step(d.tReadyMin! - 1n, facts, { ...frozen, tFreeze: d.tReadyMin! - 5n })).toMatchObject({ do: 'wait', on: 'ready-minimum', warning: 'frozen' });
      const at = d.tReadyMin! > frozen.tFreeze ? d.tReadyMin! : frozen.tFreeze;
      expect(step(at, facts)).toEqual({ do: 'call', call: { name: 'set_ready' }, caller: 'session', secret: false, notAfter: ff - 1n, row: 'Z2' });
      expect(step(ff - 1n, facts)).toMatchObject({ do: 'call', call: { name: 'set_ready' }, row: 'Z2' });
      expect(errorOf(chain, frozen, { name: 'set_ready' }, 'session', ff - 1n)).toBe(null);
      expect(errorOf(chain, frozen, { name: 'set_ready' }, 'session', ff)).toBe('TooLate');
      // Setting ready un-freezes: READY, claim window as usual.
      const fx = apply(chain, frozen, { name: 'set_ready' }, 'session', at);
      expect(fx.swap.state).toBe(SWAP_STATE.READY);
    });

    it('a bad lock is refunded at once (Z3), with the margin, and the deposit stays withholdable', () => {
      for (const facts of [{ noticeOpens: false }, { noticeOpens: true, lock: BAD }] as Partial<TakerFacts>[]) {
        const dec = step(frozen.tFreeze + 10n, facts);
        expect(dec).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'session', secret: true, notAfter: ff - M, row: 'Z3' });
      }
      const fx = apply(chain, frozen, { name: 'refund' }, 'session', frozen.tFreeze + 10n);
      expect(fx.swap.state).toBe(SWAP_STATE.HOLD);
      expect(fx.counter).toBe(34);
    });

    it('a lock that is still confirming gets the freeze window, then is refunded with one margin to spare', () => {
      const facts = { noticeOpens: true, lock: SHALLOW };
      const lastWait = ff - 2n * M > d.tCut! ? ff - 2n * M : d.tCut!;
      if (frozen.tFreeze < lastWait) expect(step(lastWait - 1n, facts)).toEqual({ do: 'wait', on: 'xmr-confirmations', until: lastWait, warning: 'frozen' });
      expect(step(lastWait, facts)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'Z3', notAfter: ff - M });
      expect(step(ff - M, facts)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'Z3' });
      // A lock that is nowhere on chain at T_cut is not coming: refund then.
      expect(step(d.tCut! > frozen.tFreeze ? d.tCut! : frozen.tFreeze, { noticeOpens: true, lock: MISSING })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'Z3' });
    });

    it('never broadcasts a refund inside the last margin: from T_ff the maker may claim', () => {
      const late = step(ff - M + 1n, { noticeOpens: true, lock: BAD });
      expect(late).toEqual({ do: 'wait', on: 'expiry', until: d.tExp, warning: 'refund-window-missed' });
      // Ready can still be set on a good lock up to T_ff − 1: it reveals nothing.
      expect(step(ff - M + 1n, { noticeOpens: true, lock: GOOD })).toMatchObject({ do: 'call', call: { name: 'set_ready' } });
      expect(step(ff, { noticeOpens: true, lock: GOOD })).toMatchObject({ do: 'wait', on: 'expiry' });
      expect(step(d.tExp, {})).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10f' });
    });

    it('an explicit refund wins while the window is open and is refused with a reason after it', () => {
      expect(step(frozen.tFreeze + 1n, { cancel: true, noticeOpens: true, lock: GOOD })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'Z3', notAfter: ff - M });
      expect(step(ff - M, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'Z3' });
      const refused = step(ff - M + 1n, { cancel: true, noticeOpens: true, lock: GOOD });
      expect(refused).toMatchObject({ do: 'call', call: { name: 'set_ready' }, refused: 'refund-window-closed' });
      expect(step(ff + 1n, { cancel: true })).toMatchObject({ do: 'wait', on: 'expiry', refused: 'refund-window-closed' });
    });

    it('the locker itself may freeze, on request, a swap that names a watcher (Z1)', () => {
      const tCo = noticed.tClaimOpen;
      const dec = step(noticed.tNotice + 5n, { freeze: true }, noticed);
      expect(dec).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'session', secret: false, notAfter: tCo - 1n, row: 'Z1' });
      expect(errorOf(chain, noticed, { name: 'freeze' }, 'session', tCo - 1n)).toBe(null);
      expect(errorOf(chain, noticed, { name: 'freeze' }, 'session', tCo)).toBe('TooLate');
      // A refund request wins over a pause.
      expect(step(noticed.tNotice + 5n, { freeze: true, cancel: true }, noticed)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10b' });
      // Where it cannot be done the decision says why instead of dropping the request.
      expect(step(tCo, { freeze: true, noticeOpens: true, lock: GOOD }, noticed).refused).toBe('freeze-window-closed');
      expect(step(frozen.tFreeze + 1n, { freeze: true, noticeOpens: true, lock: GOOD }).refused).toBe('already-frozen');
      const plain = after(chain, 'happy/A/auto', 'post_notice');
      expect(plain.watcher).toBe(false);
      expect(step(plain.tNotice + 5n, { freeze: true, noticeOpens: true, lock: SHALLOW }, plain).refused).toBe('freeze-not-available');
      expect(errorOf(chain, plain, { name: 'freeze' }, 'session', plain.tNotice + 5n)).toBe('BadState');
      const active = after(chain, 'exit/A/freeze-then-ready-then-claim', 'lock');
      expect(step(active.tActive + 1n, { freeze: true }, active).refused).toBe('freeze-window-closed');
      expect(freezeRefusal(view(chain, noticed), noticed.tNotice + 5n, 0)).toBe(null);
      expect(freezeRefusal(view(chain, noticed), noticed.tNotice + 5n, 1)).toBe('freeze-not-available');
    });
  });

  describe(`${chain}: maker, direction A, frozen (the maker is the claimer and waits for T_ff)`, () => {
    const frozen = after(chain, 'exit/A/freeze-then-claim-at-T_ff', 'freeze');
    const d = deadlinesOf(chain, frozen);
    const ff = d.tFf!;
    const relayed: Partial<MakerFacts> = { lockTx: 'relayed', commitmentsOk: true };
    const step = (now: bigint, f: Partial<MakerFacts> = {}) => makerStep({ swap: view(chain, frozen), now, ...relayed, ...f });

    it('cannot claim at the claim delay: the claim without ready opens at T_ff (Z4)', () => {
      expect(ff > d.tCo!).toBe(true);
      expect(step(d.tCo!, { lock: GOOD })).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });
      expect(errorOf(chain, frozen, { name: 'claim' }, 'operator', d.tCo!)).toBe('TooEarly');
      expect(errorOf(chain, frozen, { name: 'claim' }, 'operator', ff - 1n)).toBe('TooEarly');
      expect(step(ff)).toEqual({ do: 'need', fact: 'lock-report' });
      expect(step(ff, { lock: GOOD })).toEqual({ do: 'call', call: { name: 'claim' }, caller: 'operator', secret: true, notAfter: d.tExp - M, row: 'Z4' });
      const fx = apply(chain, frozen, { name: 'claim' }, 'operator', ff);
      expect(fx.swap.state).toBe(SWAP_STATE.DONE);
      expect(fx.counter).toBe(36);
      expect(step(d.tFinal, { lock: GOOD })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11c' });
    });

    it('aborts (Z5) when its own lock failed or is not there to stand behind', () => {
      expect(step(frozen.tFreeze + 1n, { lockFailed: true })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'Z5', notAfter: d.tFinal - 1n });
      expect(step(ff, { lock: SHALLOW })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'Z5' });
      expect(step(ff, { lock: SHALLOW, withoutReady: 'claim' })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'Z4' });
      expect(apply(chain, frozen, { name: 'abort' }, 'operator', ff).swap.state).toBe(SWAP_STATE.ABORTED_HOLD);
      expect(step(frozen.tFreeze + 1n, { lock: MISSING })).toEqual({ do: 'offchain', action: 'rebroadcast-xmr', notAfter: null });
    });
  });

  describe(`${chain}: maker, direction B, frozen (the maker-side watcher paused a sell)`, () => {
    const noticed = after(chain, 'exit/B/freeze-then-ready-then-claim', 'post_notice');
    const frozen = after(chain, 'exit/B/freeze-then-ready-then-claim', 'freeze');
    const d = deadlinesOf(chain, frozen);
    const ff = d.tFf!;
    const step = (now: bigint, f: Partial<MakerFacts> = {}, s: ModelSwap = frozen) => makerStep({ swap: view(chain, s), now, ...f });

    it('the returning daemon sets ready on a good lock (Z2) and refunds a false notice (Z3) at once', () => {
      expect(frozen.state).toBe(SWAP_STATE.FROZEN);
      expect(step(frozen.tFreeze + 1n)).toEqual({ do: 'need', fact: 'notice-opening' });
      const at = d.tReadyMin! > frozen.tFreeze ? d.tReadyMin! : frozen.tFreeze;
      expect(step(at, { noticeOpens: true, lock: GOOD })).toEqual({ do: 'need', fact: 'commitment-check' });
      expect(step(at, { noticeOpens: true, lock: GOOD, commitmentsOk: true })).toEqual({ do: 'call', call: { name: 'set_ready' }, caller: 'operator', secret: false, notAfter: ff - 1n, row: 'Z2' });
      const refund = step(frozen.tFreeze + 1n, { noticeOpens: false });
      expect(refund).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'operator', secret: true, notAfter: ff - M, row: 'Z3', urgent: true });
      // Z3 in B: the escrow returns and the take deposit goes back at once; nothing is ever held.
      const fx = apply(chain, frozen, { name: 'refund' }, 'operator', frozen.tFreeze + 1n);
      expect(fx.swap.state).toBe(SWAP_STATE.DONE);
      expect(fx.counter).toBe(35);
      expect(fx.payouts.map((p) => p.to).sort()).toEqual(['maker', 'taker']);
    });

    it('a decision to give the escrow back wins until T_ff − M and is refused after it', () => {
      expect(step(frozen.tFreeze + 1n, { backOut: true, noticeOpens: true, lock: GOOD, commitmentsOk: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'Z3' });
      expect(step(ff - M + 1n, { backOut: true, noticeOpens: true, lock: GOOD, commitmentsOk: true })).toMatchObject({ do: 'call', call: { name: 'set_ready' }, refused: 'refund-window-closed' });
      expect(step(ff, { backOut: true })).toMatchObject({ do: 'wait', on: 'expiry', refused: 'refund-window-closed' });
    });

    it('the operator may freeze on request only a swap whose fund named a watcher', () => {
      expect(step(noticed.tNotice + 1n, { freeze: true }, noticed)).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'operator', secret: false, notAfter: noticed.tClaimOpen - 1n, row: 'Z1' });
      const plain = after(chain, 'happy/B/auto', 'post_notice');
      expect(step(plain.tNotice + 1n, { freeze: true, noticeOpens: true, lock: SHALLOW }, plain).refused).toBe('freeze-not-available');
      expect(step(frozen.tFreeze + 1n, { freeze: true, noticeOpens: true, lock: SHALLOW }).refused).toBe('already-frozen');
    });
  });

  describe(`${chain}: taker, direction B, frozen (the maker paused the swap; the taker's XMR stays locked meanwhile)`, () => {
    const frozen = after(chain, 'exit/B/freeze-then-claim-at-T_ff', 'freeze');
    const d = deadlinesOf(chain, frozen);
    const ff = d.tFf!;
    const step = (now: bigint, f: Partial<TakerFacts> = {}) => takerStep({ swap: view(chain, frozen), now, paid: true, ...f });

    it('waits for T_ff, then claims (Z4); a cancel is an abort (Z5) before T_final', () => {
      expect(step(d.tCo!)).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });
      expect(step(ff)).toEqual({ do: 'call', call: { name: 'claim' }, caller: 'session', secret: true, notAfter: d.tExp - M, row: 'Z4' });
      expect(step(d.tFinal)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10c' });
      expect(step(frozen.tFreeze + 1n, { cancel: true })).toEqual({ do: 'call', call: { name: 'abort' }, caller: 'session', secret: false, notAfter: d.tFinal - 1n, row: 'Z5' });
      expect(step(d.tFinal, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'claim' }, refused: 'abort-window-closed' });
      // The taker of a sell names no watcher and cannot freeze.
      expect(step(frozen.tFreeze + 1n, { freeze: true }).refused).toBe('freeze-not-available');
    });
  });

  describe(`${chain}: a fresh payout address (SPEC 11.2)`, () => {
    it('parked claim proceeds belong to the payout address: the taker cannot pull them, anyone can deliver them', () => {
      const parked = after(chain, 'payout/B/parked-then-delivered-by-a-stranger', 'claim');
      expect(parked.payout).toBe('other');
      expect(parked.owedTaker > 0n).toBe(true);
      const dec = takerStep({ swap: view(chain, parked), now: parked.tSettled + 1n, paid: true });
      const name = chain === 'ethereum' ? 'push_owed' : 'withdraw_owed';
      expect(dec).toEqual({ do: 'call', call: { name, who: 'payout' }, caller: 'anyone', secret: false, notAfter: null, row: 'deliver_owed' });
      // The model agrees: delivered by a stranger, refused to the taking wallet.
      expect(errorOf(chain, parked, { name, who: 'payout' } as Call, 'anyone', parked.tSettled + 1n)).toBe(null);
      expect(errorOf(chain, parked, { name: 'withdraw_owed', who: 'taker' }, 'taker', parked.tSettled + 1n)).toBe(chain === 'solana' ? 'Unauthorized' : 'NothingOwed');
      expect(errorOf(chain, parked, { name: 'withdraw_owed', who: 'payout' }, 'payout', parked.tSettled + 1n)).toBe(null);
      const fx = apply(chain, parked, { name, who: 'payout' } as Call, 'anyone', parked.tSettled + 1n);
      expect(fx.payouts).toEqual([{ to: 'payout', amount: parked.owedTaker, parked: false }]);
    });

    it('everything that is not a claim returns to the taker\'s own wallet', () => {
      const names = vector('transitions').sequences.filter((q: any) => q.chain === chain && q.name.startsWith('payout/B/not-a-claim/'));
      expect(names.length).toBeGreaterThan(10);
      for (const q of names) for (const s of q.steps) for (const p of s.expect.payouts ?? []) expect(p.to, q.name).not.toBe('payout');
    });
  });

  describe(`${chain}: watcherStep`, () => {
    const facts = (s: ModelSwap, now: bigint, f: Partial<WatcherFacts> = {}): WatcherFacts => ({ swap: view(chain, s, chain === 'ethereum' ? { watcherAddress: s.watcher ? '0xABCDEF0000000000000000000000000000000001'.toLowerCase() : null } : {}), now, watcher: chain === 'ethereum' ? '0xabcdef0000000000000000000000000000000001' : WATCHER, ...f });
    for (const dir of ['A', 'B'] as const) {
      const seq = `exit/${dir}/freeze-then-ready-then-claim`;
      // The state a notice lands in: approved (A) or funded (B).
      const active = after(chain, seq, dir === 'B' ? 'fund' : chain === 'ethereum' ? 'approve' : 'lock');
      const noticed = after(chain, seq, 'post_notice');
      const frozen = after(chain, seq, 'freeze');
      const d = deadlinesOf(chain, noticed);
      const last = d.tCo! - M;

      it(`direction ${dir}: follows the swap, checks the notice, verifies the lock, freezes by the safety margin`, () => {
        expect(watcherStep(facts(active, active.tActive + 1n))).toEqual({ do: 'wait', on: 'notice', until: active.tNoteDeadline });
        expect(watcherStep(facts(noticed, noticed.tNotice + 1n))).toEqual({ do: 'need', fact: 'notice-opening' });
        // A notice that does not open its commitment is no lock: freeze at once.
        const now = noticed.tNotice + 1n;
        expect(watcherStep(facts(noticed, now, { noticeOpens: false }))).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: last, why: 'notice-invalid' });
        expect(watcherStep(facts(noticed, now, { noticeOpens: true }))).toEqual({ do: 'need', fact: 'lock-report' });
        // Before T_cut an unconfirmed lock is only watched.
        for (const lock of [SHALLOW, MISSING, BAD, GOOD]) expect(watcherStep(facts(noticed, d.tCut! - 1n, { noticeOpens: true, lock }))).toEqual({ do: 'wait', on: 'lock-check', until: d.tCut });
        // At T_cut: not confirmed is frozen; confirmed is left alone and re-verified.
        for (const lock of [SHALLOW, MISSING, BAD]) expect(watcherStep(facts(noticed, d.tCut!, { noticeOpens: true, lock }))).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: last, why: 'lock-not-confirmed' });
        expect(watcherStep(facts(noticed, d.tCut!, { noticeOpens: true, lock: GOOD }))).toEqual({ do: 'wait', on: 'recheck', until: last });
        expect(watcherStep(facts(noticed, last, { noticeOpens: true, lock: SHALLOW }))).toMatchObject({ do: 'call', call: { name: 'freeze' } });
        // Never later than T_co − M.
        expect(watcherStep(facts(noticed, last + 1n, { noticeOpens: false }))).toEqual({ do: 'stop', why: 'too-late' });
      });

      it(`direction ${dir}: every freeze it proposes is one the model accepts from the watcher, through the whole margin`, () => {
        let n = 0;
        for (let now = noticed.tNotice; now <= d.tCo! + 2n; now += 7n) {
          for (const f of [{ noticeOpens: false }, { noticeOpens: true, lock: SHALLOW }, { noticeOpens: true, lock: GOOD }, {}] as Partial<WatcherFacts>[]) {
            const dec = watcherStep(facts(noticed, now, f));
            if (dec.do !== 'call') continue;
            n++;
            expect(dec.call).toEqual({ name: 'freeze' });
            for (const t of [now, dec.notAfter, dec.notAfter + M - 1n]) expect(errorOf(chain, noticed, { name: 'freeze' }, 'watcher', t), `at ${t}`).toBe(null);
          }
        }
        expect(n).toBeGreaterThan(20);
        const fx = apply(chain, noticed, { name: 'freeze' }, 'watcher', noticed.tNotice + 1n);
        expect(fx.swap.state).toBe(SWAP_STATE.FROZEN);
        expect(fx.payouts).toEqual([]);
        expect(fx.counter).toBe(33);
      });

      it(`direction ${dir}: stops when the swap is ready, frozen, ended or not its own; it proposes nothing but freeze`, () => {
        expect(watcherStep(facts(frozen, frozen.tFreeze + 1n, { noticeOpens: false }))).toEqual({ do: 'stop', why: 'frozen' });
        const ready = after(chain, seq, 'set_ready');
        expect(watcherStep(facts(ready, ready.tReady + 1n, { noticeOpens: false }))).toEqual({ do: 'stop', why: 'ready' });
        const done = after(chain, seq, 'claim');
        expect(watcherStep(facts(done, done.tSettled + 1n))).toEqual({ do: 'stop', why: done.state === SWAP_STATE.NONE ? 'no-swap' : 'ended' });
        expect(watcherStep({ swap: null, now: 1n, watcher: WATCHER })).toEqual({ do: 'stop', why: 'no-swap' });
        // A swap that names another watcher, or none.
        expect(watcherStep({ ...facts(noticed, noticed.tNotice + 1n, { noticeOpens: false }), watcher: 'someone-else' })).toEqual({ do: 'stop', why: 'not-named' });
        const plain = after(chain, dir === 'A' ? 'happy/A/auto' : 'happy/B/auto', 'post_notice');
        expect(watcherStep(facts(plain, plain.tNotice + 1n, { noticeOpens: false }))).toEqual({ do: 'stop', why: 'not-named' });
        // Across every state of the freeze sequences and every fact, the only call is `freeze`.
        const seen = new Set<string>();
        for (const q of vector('transitions').sequences.filter((x: any) => x.chain === chain && /freeze/.test(x.name))) {
          for (const st of q.steps) {
            if (!st.expect.ok) continue;
            const s = swapOf(st.expect.swap);
            for (const now of [BigInt(st.at), BigInt(st.at) + 600n, s.tCut, s.tClaimOpen - M, s.tClaimOpen, s.tFinal]) {
              for (const f of [{}, { noticeOpens: false }, { noticeOpens: true, lock: SHALLOW }, { noticeOpens: true, lock: GOOD }] as Partial<WatcherFacts>[]) {
                const dec = watcherStep(facts(s, now, f));
                seen.add(dec.do === 'call' ? `call:${dec.call.name}` : dec.do);
              }
            }
          }
        }
        expect([...seen].sort()).toEqual(['call:freeze', 'need', 'stop', 'wait']);
      });
    }

    it('a watcher has no other power: the model gives it what it gives a stranger for every other call', () => {
      const noticed = after(chain, 'exit/A/freeze-then-ready-then-claim', 'post_notice');
      const frozen = after(chain, 'exit/A/freeze-then-ready-then-claim', 'freeze');
      const others: Call[] = [{ name: 'set_ready' }, { name: 'abort' }, { name: 'cancel_pending' }, { name: 'post_notice' }, { name: 'refund' }, { name: 'claim' }, { name: 'withhold', evidence: 'absent' }, { name: 'release_deposit' }, { name: 'withdraw_owed', who: 'taker' }];
      for (const s of [noticed, frozen]) {
        for (const now of [s.tNotice + 1n, s.tClaimOpen, tFf(frozen)!, s.tFinal]) {
          for (const call of others) expect(errorOf(chain, s, call, 'watcher' as Role, now), `${call.name} at ${now}`).toBe(errorOf(chain, s, call, 'anyone', now));
        }
      }
      // And it cannot freeze twice.
      expect(errorOf(chain, frozen, { name: 'freeze' }, 'watcher', frozen.tFreeze + 1n)).toBe('BadState');
    });
  });
}
