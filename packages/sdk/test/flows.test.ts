// Flow decisions against the reference model (SPEC 3.2 invariants and rule 2, 3.11). The corpus
// is every swap state that occurs in transitions.json; the oracle is the model those vectors
// were generated from (replayed in machine.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type ChainName, SWAP_FLAG, SWAP_STATE, SWAP_STATE_NAMES } from '@xmrswap/protocol';
import { type MakerFacts, makerStep } from '../src/flows/maker.js';
import { type TakerFacts, takerAtRisk, takerRefundDeadline, takerStep } from '../src/flows/taker.js';
import type { Decision, LockReport } from '../src/flows/types.js';
import { type Call, type ModelSwap, NO_SWAP, type Role, apply, enabled, errorOf } from '../src/machine/model.js';
import { type SwapView, deadlinesOf } from '../src/machine/view.js';
import { corpus, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const zero32 = new Uint8Array(32);
/** A SwapView around a model state: the flows read nothing else. */
function view(chain: ChainName, s: ModelSwap): SwapView {
  return {
    ...s,
    chain,
    swapRef: zero32,
    taker: 'taker',
    maker: 'maker',
    asset: '0',
    xmr: 2_000_000_000_000n,
    price: 0n,
    depBps: 100,
    swapNonce: new Uint8Array(16),
    sessionKey: 'session',
    takerEncKey: zero32,
    makerEncVersion: 1,
    makerEncKey: zero32,
    takerSpendPub: zero32,
    makerSpendPub: zero32,
    lockerView: zero32,
    noticeCommitment: zero32,
    noticeCt: new Uint8Array(0),
    evidenceTxid: zero32,
    evidenceView: zero32,
    revealed: zero32,
  };
}

const GOOD: LockReport = { state: 'confirmed', ok: true, confirmations: 30 };
const SHALLOW: LockReport = { state: 'confirming', ok: false, confirmations: 1 };
const BAD: LockReport = { state: 'invalid', ok: false, confirmations: 0 };
const MISSING: LockReport = { state: 'not-found', ok: false, confirmations: 0 };

/** Every chain second worth probing for a state: each stored deadline, the derived ones, and the margin on either side. */
function probeTimes(chain: ChainName, s: ModelSwap): bigint[] {
  const c = CHAIN_CONSTS[chain];
  const d = deadlinesOf(chain, s);
  const M = d.margin;
  const marks = [s.tLock, d.tPend, d.tNote, s.tNotice || null, d.tReadyMin, d.tCut, d.tCo, s.tReady || null, d.tCd, d.tNl, d.tFinal, d.tExp, d.tHold, d.tSplit, d.tNote === null ? null : d.tNote - BigInt(c.finalitySecs)];
  const out = new Set<bigint>();
  for (const m of marks) {
    if (m === null) continue;
    for (const off of [-M - 1n, -M, -M + 1n, -1n, 0n, 1n, M - 1n, M, M + 1n]) out.add(m + off);
  }
  return [...out].filter((t) => t >= s.tLock).sort((a, b) => (a < b ? -1 : 1));
}

const takerFactSets: Partial<TakerFacts>[] = [
  {},
  { cancel: true },
  { noticeOpens: true, lock: GOOD, paid: true, makerProofOk: true },
  { noticeOpens: true, lock: SHALLOW, paid: true, makerProofOk: true },
  { noticeOpens: true, lock: BAD, makerProofOk: true },
  { noticeOpens: false, makerProofOk: false },
  { noticeOpens: true, lock: GOOD, paid: true, makerProofOk: true, swept: true, cancel: true },
];
const makerFactSets: Partial<MakerFacts>[] = [
  {},
  { approval: { approve: true }, takerProofOk: true, commitmentsOk: true, lockTx: 'prepared', noticeOpens: true, lock: GOOD },
  { approval: { approve: true }, takerProofOk: true, commitmentsOk: true, lockTx: 'relayed', noticeOpens: true, lock: GOOD, withhold: true },
  { approval: { approve: true }, takerProofOk: true, commitmentsOk: true, lockTx: 'relayed', noticeOpens: true, lock: SHALLOW, withoutReady: 'abort' },
  { approval: { approve: true }, takerProofOk: true, commitmentsOk: true, lockTx: 'relayed', noticeOpens: true, lock: MISSING, release: true },
  { approval: { approve: false, reason: 0 }, takerProofOk: true, commitmentsOk: false, lockTx: 'none', noticeOpens: false },
  { approval: { approve: true }, takerProofOk: false, commitmentsOk: true, lockTx: 'unavailable', lockFailed: true, lock: BAD, noticeOpens: true },
  { approval: { approve: true }, takerProofOk: true, commitmentsOk: true, lockTx: 'relayed', lock: GOOD, noticeOpens: true, backOut: true, swept: true },
];

/** The model call behind a decision, with the secret and evidence the flow would attach. */
function modelCall(d: Extract<Decision, { do: 'call' }>): Call | null {
  return d.call.name === 'close_swap' ? null : d.call;
}

describe('flows propose only what the reference model accepts', () => {
  for (const chain of ['solana', 'ethereum'] as const) {
    const states = corpus(chain);
    const M = BigInt(CHAIN_CONSTS[chain].marginSecs);

    it(`${chain}: corpus covers every state in both directions`, () => {
      for (const dir of [0, 1]) {
        const seen = new Set(states.filter((s) => s.direction === dir).map((s) => SWAP_STATE_NAMES[s.state]));
        for (const name of ['PENDING', 'ACTIVE', 'NOTICED', 'READY', 'ABORTED_HOLD', 'HOLD', 'WITHHELD', 'DONE']) expect(seen.has(name as never), `${chain} dir ${dir} ${name}`).toBe(true);
      }
      expect(states.length).toBeGreaterThan(150);
    });

    for (const side of ['taker', 'maker'] as const) {
      it(`${chain} ${side}: every proposed call is enabled, and a secret stays valid for the whole margin`, () => {
        let calls = 0;
        let secrets = 0;
        for (const s of states) {
          const v = view(chain, s);
          for (const now of probeTimes(chain, s)) {
            for (const facts of side === 'taker' ? takerFactSets : makerFactSets) {
              const d = side === 'taker' ? takerStep({ swap: v, now, ...facts }) : makerStep({ swap: v, now, ...facts });
              if (d.do !== 'call') continue;
              const label = `${chain} ${side} ${SWAP_STATE_NAMES[s.state]} dir ${s.direction} at ${now} (${d.row}) facts ${JSON.stringify(facts, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`;
              const call = modelCall(d);
              if (!call) continue;
              calls++;
              // The model accepts it now, from the proposed signer.
              expect(errorOf(chain, s, call, d.caller, now), label).toBe(null);
              if (d.notAfter !== null) {
                expect(now <= d.notAfter, label).toBe(true);
                expect(errorOf(chain, s, call, d.caller, d.notAfter), `${label} at notAfter`).toBe(null);
              }
              if (!d.secret) continue;
              secrets++;
              // Rule 2: a secret broadcast now, or at its last allowed second, still lands in the
              // caller's own window up to M − 1 seconds later, and the counterparty's
              // secret-bearing call is not enabled anywhere in between.
              const other: { call: Call; caller: Role } = call.name === 'refund' ? { call: { name: 'claim' }, caller: s.direction === 0 ? 'operator' : 'taker' } : { call: { name: 'refund' }, caller: s.direction === 0 ? 'taker' : 'operator' };
              for (const start of d.notAfter === null ? [now] : [now, d.notAfter]) {
                for (const t of [start, start + 1n, start + M / 2n, start + M - 1n]) {
                  expect(errorOf(chain, s, call, d.caller, t), `${label} landing at ${t}`).toBe(null);
                  expect(enabled(chain, s, other.call, other.caller, t), `${label}: counterparty enabled at ${t}`).toBe(false);
                }
              }
            }
          }
        }
        expect(calls).toBeGreaterThan(2000);
        expect(secrets).toBeGreaterThan(300);
      });
    }

    it(`${chain}: invariant 2, a taker with funds at stake always reaches an exit`, () => {
      // From every funded state of direction A, following the taker's own decisions (and letting
      // time pass when it says wait) ends in DONE or a closed account without any maker action.
      let walked = 0;
      for (const s0 of states) {
        if (s0.direction !== 0 || s0.state === SWAP_STATE.DONE || s0.state === SWAP_STATE.WITHHELD) continue;
        let s = s0;
        let now = s0.tLock + 1n;
        for (const t of [s0.tActive, s0.tNotice, s0.tReady, s0.tRefund]) if (t > now) now = t;
        let steps = 0;
        for (; steps < 12; steps++) {
          if (s.state === SWAP_STATE.DONE || s.state === SWAP_STATE.NONE) break;
          const d = takerStep({ swap: view(chain, s), now, noticeOpens: true, lock: SHALLOW });
          if (d.do === 'wait') {
            expect(d.until, `${SWAP_STATE_NAMES[s.state]} at ${now}: a wait with no time bound and no maker`).not.toBe(null);
            now = d.until! > now ? d.until! : now + 1n;
            continue;
          }
          if (d.do !== 'call') throw new Error(`unexpected ${d.do} from ${SWAP_STATE_NAMES[s.state]}`);
          const fx = apply(chain, s, d.call as Call, d.caller, now);
          s = fx.closed ? NO_SWAP : fx.swap;
        }
        expect(s.state === SWAP_STATE.DONE || s.state === SWAP_STATE.NONE, `${SWAP_STATE_NAMES[s0.state]} did not settle in ${steps} steps`).toBe(true);
        walked++;
      }
      expect(walked).toBeGreaterThan(40);
    });
  }
});

// ------------------------------------------------------------------ the rows, one by one

/** The swap after a named sequence of transitions.json, for scenario tests. */
function after(chain: ChainName, name: string, steps: number): ModelSwap {
  const q = vector('transitions').sequences.find((x: any) => x.chain === chain && x.name === name);
  if (!q) throw new Error(`no sequence ${name}`);
  const s = q.steps[steps - 1];
  if (!s.expect.ok) throw new Error(`step ${steps} of ${name} is a rejected step`);
  return corpusSwap(s.expect.swap);
}
import { swapOf } from './helpers.js';
const corpusSwap = (j: any): ModelSwap => swapOf(j);

describe('taker, direction A (the taker is the locker)', () => {
  const chain = 'solana' as const;
  const M = 300n;
  const active = after(chain, 'happy/A/auto', 1);
  const noticed = after(chain, 'happy/A/auto', 2);
  const ready = after(chain, 'happy/A/auto', 3);
  const done = after(chain, 'happy/A/auto', 4);
  const pending = after(chain, 'happy/A/window', 1);
  const step = (s: ModelSwap, now: bigint, f: Partial<TakerFacts> = {}) => takerStep({ swap: view(chain, s), now, ...f });

  it('pending: waits, cancels on request, cranks the expiry at T_appr', () => {
    expect(step(pending, pending.tLock + 5n)).toEqual({ do: 'wait', on: 'approval', until: pending.tPendingDeadline });
    expect(step(pending, pending.tLock + 5n, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'cancel_pending' }, row: 'A4', secret: false });
    expect(step(pending, pending.tPendingDeadline - 1n)).toMatchObject({ do: 'wait' });
    expect(step(pending, pending.tPendingDeadline)).toMatchObject({ do: 'call', call: { name: 'expire_pending' }, row: 'A5', caller: 'anyone' });
  });

  it('approved, no notice: keyless refund at T_note (row 2); a cancel before it is a keyed refund (row 3)', () => {
    expect(step(active, active.tNoteDeadline - 1n)).toMatchObject({ do: 'wait', on: 'notice', until: active.tNoteDeadline });
    const keyless = step(active, active.tNoteDeadline);
    expect(keyless).toMatchObject({ do: 'call', call: { name: 'refund_unnoticed' }, row: 'A8', secret: false });
    expect(step(active, active.tLock + 10n, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10a', secret: true });
  });

  it('noticed: needs the opening, then the lock report; sets ready at depth, never before the minimum', () => {
    const t = noticed.tNotice + 30n;
    expect(step(noticed, t)).toEqual({ do: 'need', fact: 'notice-opening' });
    expect(step(noticed, t, { noticeOpens: true })).toEqual({ do: 'need', fact: 'lock-report' });
    const readyMin = noticed.tNotice + BigInt(noticed.depth * 60);
    expect(step(noticed, readyMin - 1n, { noticeOpens: true, lock: GOOD })).toEqual({ do: 'wait', on: 'ready-minimum', until: readyMin });
    expect(step(noticed, readyMin, { noticeOpens: true, lock: GOOD })).toMatchObject({ do: 'call', call: { name: 'set_ready' }, row: 'A9', caller: 'session', notAfter: noticed.tClaimOpen - 1n });
  });

  it('noticed, lock not at depth: refunds by itself from T_cut and never after T_co − M (rows 4 and F-1)', () => {
    for (const f of [{ noticeOpens: true, lock: SHALLOW }, { noticeOpens: true, lock: BAD }, { noticeOpens: false }] as Partial<TakerFacts>[]) {
      expect(step(noticed, noticed.tCut - 1n, f).do).toBe('wait');
      expect(step(noticed, noticed.tCut, f)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10b', secret: true, notAfter: noticed.tClaimOpen - M });
      expect(step(noticed, noticed.tClaimOpen - M, f)).toMatchObject({ do: 'call', call: { name: 'refund' } });
      // One second later the refund could land in the maker's window: it is not sent.
      expect(step(noticed, noticed.tClaimOpen - M + 1n, f)).toEqual({ do: 'wait', on: 'expiry', until: noticed.tFinal + 2_592_000n, warning: 'refund-window-missed' });
    }
    expect(step(noticed, noticed.tCut - 1n, { noticeOpens: false })).toMatchObject({ warning: 'notice-invalid' });
    expect(step(noticed, noticed.tCut - 1n, { noticeOpens: true, lock: BAD })).toMatchObject({ warning: 'lock-invalid' });
  });

  it('a notice that does not open its commitment is "no lock": ready is never set on it', () => {
    for (let t = noticed.tNotice; t < noticed.tClaimOpen; t += 137n) {
      const d = step(noticed, t, { noticeOpens: false, lock: GOOD });
      expect(d.do === 'call' && d.call.name === 'set_ready', `at ${t}`).toBe(false);
    }
  });

  it('ready: waits for the claim, refunds from T_cd (row 7), stops at T_final − M, resumes at T_exp', () => {
    expect(step(ready, ready.tClaimDeadline - 1n)).toEqual({ do: 'wait', on: 'claim', until: ready.tClaimDeadline });
    expect(step(ready, ready.tClaimDeadline)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10e', notAfter: ready.tFinal - M });
    expect(step(ready, ready.tFinal - M + 1n)).toMatchObject({ do: 'wait', warning: 'refund-window-missed' });
    expect(step(ready, ready.tFinal + 2_592_000n)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10f', notAfter: null });
  });

  it('after an abort: refunds at once (rows 5 and the early aborts)', () => {
    const hold = after(chain, 'rows/A/5-abort-late-then-refund', 3);
    expect(hold.state).toBe(SWAP_STATE.ABORTED_HOLD);
    expect(step(hold, hold.tClaimOpen + 100n)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10c' });
    const free = after(chain, 'rows/A/abort-early-then-refund', 3);
    expect(free.state).toBe(SWAP_STATE.ABORTED_FREE);
    expect(step(free, free.tNotice + 100n)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'A10d' });
  });

  it('deposit: cranks the release at T_hold and the split at T_split', () => {
    const held = after(chain, 'deposit/A/held-then-returned', 3);
    expect(held.state).toBe(SWAP_STATE.HOLD);
    expect(step(held, held.tRefund + 1799n)).toEqual({ do: 'wait', on: 'deposit-hold', until: held.tRefund + 1800n });
    expect(step(held, held.tRefund + 1800n)).toMatchObject({ do: 'call', call: { name: 'release_deposit' }, caller: 'anyone' });
    const withheld = after(chain, 'deposit/A/withheld-then-split', 4);
    expect(withheld.state).toBe(SWAP_STATE.WITHHELD);
    expect(step(withheld, withheld.tRefund + 5_184_000n - 1n).do).toBe('wait');
    expect(step(withheld, withheld.tRefund + 5_184_000n)).toMatchObject({ do: 'call', call: { name: 'split_deposit' } });
  });

  it('after the maker claim: sweeps with the revealed share, then closes the account', () => {
    expect(done.flags & SWAP_FLAG.REVEALED).toBeTruthy();
    expect(step(done, done.tSettled + 1n)).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    expect(step(done, done.tSettled + 1n, { swept: true })).toMatchObject({ do: 'call', call: { name: 'close_swap' }, caller: 'session' });
    expect(takerStep({ swap: view('ethereum', done), now: done.tSettled + 1n, swept: true })).toEqual({ do: 'done', outcome: 'completed' });
    expect(step(NO_SWAP, 5n)).toEqual({ do: 'done', outcome: 'closed' });
  });

  it('a parked payout is withdrawn before anything else', () => {
    const parked = after(chain, 'parked/A/refund', 3);
    expect(parked.owedTaker > 0n).toBe(true);
    const d = step({ ...parked, state: SWAP_STATE.DONE }, parked.tRefund + 5n);
    expect(d).toMatchObject({ do: 'call', call: { name: 'withdraw_owed', who: 'taker' }, caller: 'taker' });
  });

  it('"at risk" and the banner deadline follow SPEC 8.5', () => {
    expect(takerAtRisk(view(chain, pending))).toBe(false);
    expect(takerAtRisk(view(chain, active))).toBe(true);
    expect(takerAtRisk(view(chain, noticed))).toBe(true);
    expect(takerAtRisk(view(chain, ready))).toBe(false);
    expect(takerAtRisk(view(chain, done))).toBe(false);
    expect(takerRefundDeadline(view(chain, noticed))).toBe(noticed.tClaimOpen - M);
    expect(takerRefundDeadline(view(chain, ready))).toBe(ready.tFinal - M);
    expect(takerRefundDeadline(view('ethereum', after('ethereum', 'happy/A/auto', 4)))).toBe(after('ethereum', 'happy/A/auto', 4).tFinal - 1800n);
  });
});

describe('taker, direction B (the taker is the claimer)', () => {
  const chain = 'solana' as const;
  const M = 300n;
  const pending = after(chain, 'happy/B/auto', 1);
  const active = after(chain, 'happy/B/auto', 2);
  const noticed = after(chain, 'happy/B/auto', 3);
  const ready = after(chain, 'happy/B/auto', 4);
  const step = (s: ModelSwap, now: bigint, f: Partial<TakerFacts> = {}, c: ChainName = chain) => takerStep({ swap: view(c, s), now, ...f });

  it('pending: waits for the funding, cranks the lapse at T_fund', () => {
    expect(step(pending, pending.tLock + 1n)).toEqual({ do: 'wait', on: 'funding', until: pending.tPendingDeadline });
    expect(step(pending, pending.tPendingDeadline)).toMatchObject({ do: 'call', call: { name: 'expire_pending' }, row: 'B4' });
  });

  it('funded: shows the address only with 180 s left before T_note (600 s on Ethereum)', () => {
    expect(step(active, active.tNoteDeadline - 180n)).toEqual({ do: 'offchain', action: 'show-address', notAfter: active.tNoteDeadline - 180n });
    expect(step(active, active.tNoteDeadline - 179n)).toMatchObject({ do: 'wait', on: 'maker-refund', warning: 'too-late-to-pay' });
    const eth = after('ethereum', 'happy/B/auto', 2);
    expect(step(eth, eth.tNoteDeadline - 600n, { makerProofOk: true }, 'ethereum')).toMatchObject({ do: 'offchain', action: 'show-address' });
    expect(step(eth, eth.tNoteDeadline - 599n, { makerProofOk: true }, 'ethereum')).toMatchObject({ warning: 'too-late-to-pay' });
  });

  it('Ethereum: never shows the address without a verified proof for the funded share', () => {
    const eth = after('ethereum', 'happy/B/auto', 2);
    expect(step(eth, eth.tActive + 10n, {}, 'ethereum')).toEqual({ do: 'need', fact: 'dleq-proof' });
    for (let t = eth.tActive; t < eth.tFinal; t += 9973n) {
      const d = step(eth, t, { makerProofOk: false }, 'ethereum');
      expect(d.do === 'offchain', `at ${t}`).toBe(false);
      expect(d).toMatchObject({ warning: 'maker-proof-invalid' });
    }
    // Nobody acts: the take deposit comes back at T_exp (B11).
    expect(step(eth, eth.tFinal + 2_592_000n, { makerProofOk: false }, 'ethereum')).toMatchObject({ do: 'call', call: { name: 'expire_unnoticed' }, row: 'B11' });
  });

  it('paid: posts the notice, late if need be, until T_nl', () => {
    expect(step(active, active.tActive + 60n, { paid: true })).toMatchObject({ do: 'call', call: { name: 'post_notice' }, row: 'B6', caller: 'session' });
    const tNl = active.tFinal - BigInt(active.dC + active.wC + 86_400);
    expect(step(active, active.tNoteDeadline + 5n, { paid: true })).toMatchObject({ do: 'call', call: { name: 'post_notice' }, notAfter: tNl - 1n });
    expect(step(active, tNl, { paid: true })).toMatchObject({ do: 'wait', warning: 'notice-window-missed' });
  });

  it('noticed: waits for ready; claims without it from T_co (B10b) through T_final until T_exp − M', () => {
    expect(step(noticed, noticed.tClaimOpen - 1n)).toEqual({ do: 'wait', on: 'ready', until: noticed.tClaimOpen });
    expect(step(noticed, noticed.tClaimOpen)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10b', secret: true });
    const tExp = noticed.tFinal + 2_592_000n;
    expect(step(noticed, noticed.tFinal + 5n)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10c', notAfter: tExp - M });
    expect(step(noticed, tExp - M + 1n)).toMatchObject({ do: 'wait', warning: 'claim-window-missed', until: null });
    expect(step(noticed, noticed.tNotice + 10n, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'B8' });
  });

  it('ready: claims at once and never after T_cd − M; comes back at T_final', () => {
    expect(step(ready, ready.tReady + 1n)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10a', notAfter: ready.tClaimDeadline - M });
    expect(step(ready, ready.tClaimDeadline - M + 1n)).toEqual({ do: 'wait', on: 'final', until: ready.tFinal, warning: 'claim-window-missed' });
    expect(step(ready, ready.tFinal)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10c' });
  });

  it('after a maker refund the XMR is recovered with the revealed share', () => {
    const refunded = after(chain, 'rows/B/refund-unconfirmed', 4);
    expect(refunded.state).toBe(SWAP_STATE.HOLD);
    expect(step(refunded, refunded.tRefund + 5n, { paid: true })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    expect(step(refunded, refunded.tRefund + 5n, { paid: true, swept: true })).toMatchObject({ do: 'wait', on: 'deposit-hold' });
    // The deposit crank comes first once it is due.
    expect(step(refunded, refunded.tRefund + 1800n, { paid: true })).toMatchObject({ do: 'call', call: { name: 'release_deposit' } });
    // A backout before any payment leaves nothing to recover.
    const backout = after(chain, 'rows/B/backout-pre-notice', 3);
    expect(step(backout, backout.tSettled + 1n)).toEqual({ do: 'done', outcome: 'refunded' });
  });
});

describe('maker, direction A (the maker is the claimer)', () => {
  const chain = 'solana' as const;
  const M = 300n;
  const pending = after(chain, 'happy/A/window', 1);
  const active = after(chain, 'happy/A/auto', 1);
  const noticed = after(chain, 'happy/A/auto', 2);
  const ready = after(chain, 'happy/A/auto', 3);
  const step = (s: ModelSwap, now: bigint, f: Partial<MakerFacts> = {}, c: ChainName = chain) => makerStep({ swap: view(c, s), now, ...f });

  it('pending: asks for a decision, approves in the window, rejects by reason', () => {
    expect(step(pending, pending.tLock + 1n)).toEqual({ do: 'need', fact: 'approval-decision' });
    expect(step(pending, pending.tLock + 1n, { approval: { approve: true } })).toMatchObject({ do: 'call', call: { name: 'approve' }, row: 'A2', notAfter: pending.tPendingDeadline - 1n });
    expect(step(pending, pending.tPendingDeadline, { approval: { approve: true } })).toEqual({ do: 'wait', on: 'lapse', until: null });
    expect(step(pending, pending.tLock + 1n, { approval: { approve: false, reason: 2 } })).toMatchObject({ do: 'call', call: { name: 'reject', reason: 2 }, row: 'A3' });
  });

  it('Ethereum: no approval without a verified taker proof; an unusable one is rejected with reason 1', () => {
    const eth = after('ethereum', 'happy/A/auto', 1);
    expect(eth.state).toBe(SWAP_STATE.PENDING);
    expect(step(eth, eth.tLock + 1n, { approval: { approve: true } }, 'ethereum')).toEqual({ do: 'need', fact: 'dleq-proof' });
    expect(step(eth, eth.tLock + 1n, { approval: { approve: true }, takerProofOk: false }, 'ethereum')).toMatchObject({ do: 'call', call: { name: 'reject', reason: 1 } });
    expect(step(eth, eth.tLock + 1n, { approval: { approve: true }, takerProofOk: true }, 'ethereum')).toMatchObject({ do: 'call', call: { name: 'approve' } });
  });

  it('approved: prepares the lock without relaying, posts the notice, and only then relays', () => {
    const t = active.tActive + 5n;
    expect(step(active, t)).toEqual({ do: 'need', fact: 'commitment-check' });
    expect(step(active, t, { commitmentsOk: true })).toMatchObject({ do: 'offchain', action: 'prepare-lock-tx' });
    expect(step(active, t, { commitmentsOk: true, lockTx: 'prepared' })).toMatchObject({ do: 'call', call: { name: 'post_notice' }, row: 'A6', notAfter: active.tNoteDeadline - 1n });
    // In ACTIVE the XMR is never relayed, whatever the facts say.
    for (const lockTx of ['none', 'prepared', 'relayed', 'unavailable'] as const) expect(step(active, t, { commitmentsOk: true, lockTx })).not.toMatchObject({ action: 'relay-xmr' });
    expect(step(noticed, noticed.tNotice + 20n, { lockTx: 'prepared' })).toMatchObject({ do: 'offchain', action: 'relay-xmr', notAfter: noticed.tCut - 1n });
  });

  it('aborts at once when it cannot stand behind the swap', () => {
    const t = active.tActive + 5n;
    expect(step(active, t, { commitmentsOk: false })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'A7a' });
    expect(step(active, t, { commitmentsOk: true, lockTx: 'unavailable' })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'A7a' });
    expect(step(noticed, noticed.tNotice + 20n, { lockTx: 'relayed', lockFailed: true })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'A7b' });
    expect(step(noticed, noticed.tClaimOpen + 20n, { lockTx: 'relayed', lockFailed: true })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'A7c' });
    // Past T_note nothing was broadcast and the taker's refund is keyless: nothing to send.
    expect(step(active, active.tNoteDeadline, { commitmentsOk: true, lockTx: 'prepared' })).toEqual({ do: 'wait', on: 'taker-refund', until: null, warning: 'maker-fault' });
  });

  it('rebroadcasts a lock that dropped out of the chain', () => {
    expect(step(noticed, noticed.tNotice + 600n, { lockTx: 'relayed', lock: MISSING })).toEqual({ do: 'offchain', action: 'rebroadcast-xmr', notAfter: null });
  });

  it('ready: claims no later than T_cd − M; a missed window waits for T_final (row 8)', () => {
    expect(step(ready, ready.tReady + 1n, { lockTx: 'relayed' })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11a', secret: true, notAfter: ready.tClaimDeadline - M });
    expect(step(ready, ready.tClaimDeadline - M + 1n, { lockTx: 'relayed' })).toEqual({ do: 'wait', on: 'final', until: ready.tFinal, warning: 'claim-window-missed' });
    expect(step(ready, ready.tFinal, { lockTx: 'relayed' })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11c', notAfter: ready.tFinal + 2_592_000n - M });
  });

  it('taker never sets ready: from T_co claims when the lock is confirmed, aborts otherwise (rows 5 and 6)', () => {
    const t = noticed.tClaimOpen;
    expect(step(noticed, t - 1n, { lockTx: 'relayed', lock: GOOD })).toEqual({ do: 'wait', on: 'ready', until: t });
    expect(step(noticed, t, { lockTx: 'relayed' })).toEqual({ do: 'need', fact: 'lock-report' });
    expect(step(noticed, t, { lockTx: 'relayed', lock: GOOD })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11b' });
    expect(step(noticed, t, { lockTx: 'relayed', lock: SHALLOW })).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'A7c' });
    expect(step(noticed, t, { lockTx: 'relayed', lock: GOOD, withoutReady: 'abort' })).toMatchObject({ do: 'call', call: { name: 'abort' } });
    // An abort is a waiver until T_final, not forever.
    const aborted = after(chain, 'rows/A/5-abort-late-then-refund', 3);
    expect(step(aborted, aborted.tFinal - 1n, { lockTx: 'relayed' })).toEqual({ do: 'wait', on: 'final', until: aborted.tFinal });
    expect(step(aborted, aborted.tFinal, { lockTx: 'relayed' })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11c' });
  });

  it('after a taker refund: withholds only inside the hold and with evidence, sweeps the XMR back, publishes the opening', () => {
    const held = after(chain, 'deposit/A/withheld-then-released', 3);
    expect(held.state).toBe(SWAP_STATE.HOLD);
    const t = held.tRefund + 10n;
    expect(step(held, t, { lockTx: 'relayed', withhold: true })).toMatchObject({ do: 'call', call: { name: 'withhold', evidence: 'opens' }, notAfter: held.tRefund + 1799n });
    // Refused at or after T_hold even if nobody cranked the release: it is not proposed.
    expect(step(held, held.tRefund + 1800n, { lockTx: 'relayed', withhold: true, swept: true })).not.toMatchObject({ call: { name: 'withhold' } });
    expect(step(held, t, { lockTx: 'relayed' })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    expect(step(held, t, { lockTx: 'relayed', swept: true })).toMatchObject({ do: 'call', call: { name: 'publish_evidence' } });
    expect(step(held, t, { lockTx: 'relayed', release: true })).toMatchObject({ do: 'call', call: { name: 'release_deposit' }, caller: 'operator' });
    // A cancel before any notice: no XMR was relayed, nothing to sweep, no evidence exists.
    const cancelled = after(chain, 'rows/A/3-cancel-after-approval', 2);
    expect(step(cancelled, cancelled.tRefund + 5n, { lockTx: 'prepared', withhold: true })).toMatchObject({ do: 'call', call: { name: 'withhold', evidence: 'absent' } });
    expect(step(cancelled, cancelled.tRefund + 5n, { lockTx: 'prepared' })).toMatchObject({ do: 'wait', on: 'deposit-hold' });
  });
});

describe('maker, direction B (the maker is the locker)', () => {
  const chain = 'solana' as const;
  const M = 300n;
  const pending = after(chain, 'happy/B/auto', 1);
  const active = after(chain, 'happy/B/auto', 2);
  const noticed = after(chain, 'happy/B/auto', 3);
  const ready = after(chain, 'happy/B/auto', 4);
  const done = after(chain, 'happy/B/auto', 5);
  const step = (s: ModelSwap, now: bigint, f: Partial<MakerFacts> = {}) => makerStep({ swap: view(chain, s), now, ...f });

  it('pending: funds before T_fund; outside window mode a refusal is a lapse, not a reject', () => {
    expect(step(pending, pending.tLock + 1n, { approval: { approve: true } })).toMatchObject({ do: 'call', call: { name: 'fund' }, row: 'B5', notAfter: pending.tPendingDeadline - 1n });
    expect(step(pending, pending.tLock + 1n, { approval: { approve: false, reason: 0 } })).toEqual({ do: 'wait', on: 'lapse', until: pending.tPendingDeadline, refused: 'reject-not-available' });
    const window = after(chain, 'happy/B/window', 1);
    expect(step(window, window.tLock + 1n, { approval: { approve: false, reason: 0 } })).toMatchObject({ do: 'call', call: { name: 'reject', reason: 0 }, row: 'B3' });
  });

  it('funded: waits for the notice; refunds when none came by T_note (B9b)', () => {
    expect(step(active, active.tNoteDeadline - 1n)).toEqual({ do: 'wait', on: 'notice', until: active.tNoteDeadline });
    expect(step(active, active.tNoteDeadline)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9b', secret: true });
    expect(step(active, active.tActive + 5n, { backOut: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9a' });
  });

  it('noticed: verifies, re-checks the commitments, sets ready at depth', () => {
    const t = noticed.tNotice + BigInt(noticed.depth * 60);
    expect(step(noticed, t)).toEqual({ do: 'need', fact: 'notice-opening' });
    expect(step(noticed, t, { noticeOpens: true })).toEqual({ do: 'need', fact: 'lock-report' });
    expect(step(noticed, t, { noticeOpens: true, lock: GOOD })).toEqual({ do: 'need', fact: 'commitment-check' });
    expect(step(noticed, t - 1n, { noticeOpens: true, lock: GOOD, commitmentsOk: true })).toMatchObject({ do: 'wait', on: 'ready-minimum' });
    expect(step(noticed, t, { noticeOpens: true, lock: GOOD, commitmentsOk: true })).toMatchObject({ do: 'call', call: { name: 'set_ready' }, row: 'B7' });
    expect(step(noticed, t, { noticeOpens: true, lock: GOOD, commitmentsOk: false })).toMatchObject({ do: 'call', call: { name: 'refund' }, urgent: true });
  });

  it('false notice: refunds in [T_cut, T_co − M], the hardest deadline (F-2)', () => {
    for (const f of [{ noticeOpens: true, lock: SHALLOW }, { noticeOpens: true, lock: BAD }, { noticeOpens: false }, { noticeOpens: true, lock: MISSING }] as Partial<MakerFacts>[]) {
      expect(step(noticed, noticed.tCut - 1n, f).do).toBe('wait');
      expect(step(noticed, noticed.tCut, f)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9d', urgent: true, notAfter: noticed.tClaimOpen - M });
      expect(step(noticed, noticed.tClaimOpen - M, f)).toMatchObject({ do: 'call', call: { name: 'refund' } });
      expect(step(noticed, noticed.tClaimOpen - M + 1n, f)).toMatchObject({ do: 'wait', warning: 'refund-window-missed' });
    }
  });

  it('ready: the taker misses its claim, the maker refunds from T_cd (B9e)', () => {
    expect(step(ready, ready.tClaimDeadline - 1n)).toEqual({ do: 'wait', on: 'claim', until: ready.tClaimDeadline });
    expect(step(ready, ready.tClaimDeadline)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9e', notAfter: ready.tFinal - M });
    expect(step(ready, ready.tFinal + 2_592_000n)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9g' });
  });

  it('after the taker claim: sweeps the XMR with the revealed share, then closes', () => {
    expect(step(done, done.tSettled + 1n)).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    expect(step(done, done.tSettled + 1n, { swept: true })).toMatchObject({ do: 'call', call: { name: 'close_swap' }, caller: 'operator' });
  });

  it('held take deposit: withholds without evidence inside the hold only', () => {
    const held = after(chain, 'deposit/B/no-notice-withheld-then-split', 3);
    expect(held.state).toBe(SWAP_STATE.HOLD);
    expect(step(held, held.tRefund + 1n, { withhold: true })).toMatchObject({ do: 'call', call: { name: 'withhold', evidence: 'absent' } });
    expect(step(held, held.tRefund + 1800n, { withhold: true })).toEqual({ do: 'wait', on: 'deposit-hold', until: held.tRefund + 1800n, refused: 'hold-ended' });
  });
});

// ------------------------------------------------------------------ explicit requests (BUG-1 of tests/e2e/BUGS.md)

describe('an explicit request wins while it can be carried out, and is refused with a reason when it cannot', () => {
  const chain = 'solana' as const;
  const M = 300n;
  const EXP = 2_592_000n;
  const T = (s: ModelSwap, now: bigint, f: Partial<TakerFacts> = {}) => takerStep({ swap: view(chain, s), now, ...f });
  const Mk = (s: ModelSwap, now: bigint, f: Partial<MakerFacts> = {}) => makerStep({ swap: view(chain, s), now, ...f });

  describe('taker, direction A: "refund this swap"', () => {
    const pending = after(chain, 'happy/A/window', 1);
    const active = after(chain, 'happy/A/auto', 1);
    const noticed = after(chain, 'happy/A/auto', 2);
    const ready = after(chain, 'happy/A/auto', 3);
    const done = after(chain, 'happy/A/auto', 4);
    const refund = { do: 'call', call: { name: 'refund' }, caller: 'session', secret: true };

    it('NOTICED, lock confirmed: the refund wins over waiting for, and over setting, ready (BUG-1)', () => {
      const readyMin = noticed.tNotice + BigInt(noticed.depth * 60);
      const good = { noticeOpens: true, lock: GOOD, cancel: true };
      // Before the ready minimum (where the e2e suite found it): refund now, not "wait".
      expect(T(noticed, readyMin - 30n, good)).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'session', secret: true, notAfter: noticed.tClaimOpen - M, row: 'A10b' });
      // After it: refund, not set_ready.
      expect(T(noticed, readyMin + 5n, good)).toMatchObject({ ...refund, row: 'A10b' });
      // Through the last second of the refund window, before and after T_cut.
      for (const t of [noticed.tNotice, noticed.tCut - 1n, noticed.tCut, noticed.tClaimOpen - M]) expect(T(noticed, t, good), `${t}`).toMatchObject({ ...refund, row: 'A10b' });
      // Without the request nothing changed: the tab still sets ready on a confirmed lock.
      expect(T(noticed, readyMin + 5n, { noticeOpens: true, lock: GOOD })).toMatchObject({ do: 'call', call: { name: 'set_ready' } });
    });

    it('NOTICED: the refund wins whatever is known about the lock, and needs no fact first', () => {
      const t = noticed.tNotice + 10n;
      for (const f of [{}, { noticeOpens: true }, { noticeOpens: false }, { noticeOpens: true, lock: SHALLOW }, { noticeOpens: true, lock: BAD }, { noticeOpens: true, lock: MISSING }] as Partial<TakerFacts>[]) {
        const d = T(noticed, t, { ...f, cancel: true });
        expect(d, JSON.stringify(f)).toMatchObject({ ...refund, row: 'A10b' });
        expect(d.refused).toBeUndefined();
      }
    });

    it('NOTICED after T_co − M: refused (refund-window-closed); the automatic step is still taken', () => {
      const t = noticed.tClaimOpen - M + 1n;
      // A confirmed lock: ready is still worth setting; the page says the refund is no longer possible.
      expect(T(noticed, t, { noticeOpens: true, lock: GOOD, cancel: true })).toMatchObject({ do: 'call', call: { name: 'set_ready' }, refused: 'refund-window-closed' });
      expect(T(noticed, t, { noticeOpens: true, lock: SHALLOW, cancel: true })).toEqual({ do: 'wait', on: 'expiry', until: noticed.tFinal + EXP, warning: 'refund-window-missed', refused: 'refund-window-closed' });
      expect(T(noticed, noticed.tClaimOpen + 5n, { cancel: true })).toMatchObject({ do: 'wait', refused: 'refund-window-closed' });
      // At T_exp the refund is open again and the request is carried out.
      const late = T(noticed, noticed.tFinal + EXP, { cancel: true });
      expect(late).toMatchObject({ ...refund, row: 'A10f' });
      expect(late.refused).toBeUndefined();
    });

    it('READY: refused (ready-already-set) until T_cd, carried out from T_cd, refused again after T_final − M', () => {
      expect(T(ready, ready.tReady + 1n, { cancel: true })).toEqual({ do: 'wait', on: 'claim', until: ready.tClaimDeadline, refused: 'ready-already-set' });
      expect(T(ready, ready.tClaimDeadline - 1n, { cancel: true }).refused).toBe('ready-already-set');
      const at = T(ready, ready.tClaimDeadline, { cancel: true });
      expect(at).toMatchObject({ ...refund, row: 'A10e' });
      expect(at.refused).toBeUndefined();
      expect(T(ready, ready.tFinal - M + 1n, { cancel: true })).toMatchObject({ do: 'wait', on: 'expiry', refused: 'refund-window-closed' });
      expect(T(ready, ready.tFinal + EXP, { cancel: true })).toMatchObject({ ...refund, row: 'A10f' });
      // Without a request there is nothing to refuse.
      expect(T(ready, ready.tReady + 1n).refused).toBeUndefined();
    });

    it('PENDING and ACTIVE: carried out at once; after T_note by the keyless refund', () => {
      expect(T(pending, pending.tLock + 1n, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'cancel_pending' }, row: 'A4' });
      expect(T(pending, pending.tPendingDeadline + 5n, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'cancel_pending' } });
      expect(T(active, active.tActive + 1n, { cancel: true })).toMatchObject({ ...refund, row: 'A10a' });
      const keyless = T(active, active.tNoteDeadline, { cancel: true });
      expect(keyless).toMatchObject({ do: 'call', call: { name: 'refund_unnoticed' }, secret: false });
      expect(keyless.refused).toBeUndefined();
    });

    it('aborted: the refund is automatic inside its window; outside it the request is refused', () => {
      const hold = after(chain, 'rows/A/5-abort-late-then-refund', 3);
      expect(T(hold, hold.tFinal - M, { cancel: true })).toMatchObject({ ...refund, row: 'A10c' });
      expect(T(hold, hold.tFinal - M + 1n, { cancel: true })).toMatchObject({ do: 'wait', refused: 'refund-window-closed' });
      expect(T(hold, hold.tFinal - M + 1n).refused).toBeUndefined();
    });

    it('settled: after the maker\'s claim there is nothing to refund (already-settled); after a refund the request is simply done', () => {
      expect(T(done, done.tSettled + 1n, { cancel: true })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null, refused: 'already-settled' });
      expect(T(done, done.tSettled + 1n, { cancel: true, swept: true })).toMatchObject({ refused: 'already-settled' });
      const held = after(chain, 'deposit/A/held-then-returned', 3);
      expect(T(held, held.tRefund + 5n, { cancel: true })).toEqual({ do: 'wait', on: 'deposit-hold', until: held.tRefund + 1800n });
    });
  });

  describe('taker, direction B: "cancel"', () => {
    const pending = after(chain, 'happy/B/auto', 1);
    const active = after(chain, 'happy/B/auto', 2);
    const noticed = after(chain, 'happy/B/auto', 3);
    const ready = after(chain, 'happy/B/auto', 4);
    const done = after(chain, 'happy/B/auto', 5);
    const abort = { do: 'call', call: { name: 'abort' }, caller: 'session', row: 'B8', secret: false };

    it('PENDING: cancelled at once', () => {
      expect(T(pending, pending.tLock + 1n, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'cancel_pending' }, row: 'B2' });
    });

    it('ACTIVE, nothing paid: the address is never shown; the taker has no call of its own (cannot-exit-after-funding)', () => {
      for (let t = active.tActive; t < active.tFinal; t += 7919n) {
        const d = T(active, t, { cancel: true, makerProofOk: true });
        expect(d.do === 'offchain', `at ${t}`).toBe(false);
        expect(d).toMatchObject({ do: 'wait', on: 'maker-refund', refused: 'cannot-exit-after-funding' });
      }
      // The same instant without the request shows the address.
      expect(T(active, active.tActive + 1n)).toMatchObject({ do: 'offchain', action: 'show-address' });
      // On Ethereum the request also spares the proof fetch.
      const eth = after('ethereum', 'happy/B/auto', 2);
      expect(takerStep({ swap: view('ethereum', eth), now: eth.tActive + 1n, cancel: true })).toMatchObject({ do: 'wait', refused: 'cannot-exit-after-funding' });
      // Nobody acts: the deposit comes back at T_exp.
      expect(T(active, active.tFinal + EXP, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'expire_unnoticed' }, refused: 'cannot-exit-after-funding' });
    });

    it('ACTIVE, XMR already paid: the notice is posted regardless (it protects the XMR); the abort follows', () => {
      const d = T(active, active.tActive + 60n, { cancel: true, paid: true });
      expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' } });
      expect(d.refused).toBeUndefined();
    });

    it('NOTICED: the abort wins over waiting for ready and over the claim, until T_final', () => {
      expect(T(noticed, noticed.tNotice + 10n, { cancel: true })).toMatchObject(abort);
      // From T_co the claim is open, but the user asked to back out.
      expect(T(noticed, noticed.tClaimOpen, { cancel: true })).toMatchObject({ ...abort, notAfter: noticed.tFinal - 1n });
      expect(T(noticed, noticed.tFinal - 1n, { cancel: true })).toMatchObject(abort);
      // At T_final an abort is no longer accepted: refused, and the claim (the taker's only exit) proceeds.
      expect(T(noticed, noticed.tFinal, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10c', refused: 'abort-window-closed' });
      expect(T(noticed, noticed.tFinal + EXP - M + 1n, { cancel: true })).toMatchObject({ do: 'wait', refused: 'abort-window-closed' });
      expect(T(noticed, noticed.tClaimOpen).refused).toBeUndefined();
    });

    it('READY: the abort wins over the claim until T_final; afterwards it is refused', () => {
      expect(T(ready, ready.tReady + 1n, { cancel: true })).toMatchObject(abort);
      expect(T(ready, ready.tClaimDeadline + 5n, { cancel: true })).toMatchObject(abort);
      expect(T(ready, ready.tFinal, { cancel: true })).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10c', refused: 'abort-window-closed' });
      expect(T(ready, ready.tReady + 1n)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10a' });
    });

    it('after the abort, and after settlement', () => {
      const aborted = after(chain, 'rows/B/taker-abort-then-refund', 4);
      expect(aborted.state).toBe(SWAP_STATE.ABORTED_HOLD);
      const d = T(aborted, aborted.tNotice + 500n, { cancel: true, paid: true });
      expect(d).toEqual({ do: 'wait', on: 'maker-refund', until: aborted.tFinal });
      expect(T(done, done.tSettled + 1n, { cancel: true, paid: true })).toEqual({ do: 'done', outcome: 'completed', refused: 'already-settled' });
    });
  });

  describe('maker: reject, back out, withhold, release', () => {
    it('reject: carried out before any proof check; refused where a take cannot be rejected', () => {
      const eth = after('ethereum', 'happy/A/auto', 1);
      // An explicit rejection does not wait for the taker's DLEQ proof.
      expect(makerStep({ swap: view('ethereum', eth), now: eth.tLock + 1n, approval: { approve: false, reason: 0 } })).toMatchObject({ do: 'call', call: { name: 'reject', reason: 0 } });
      // Approving still does.
      expect(makerStep({ swap: view('ethereum', eth), now: eth.tLock + 1n, approval: { approve: true } })).toEqual({ do: 'need', fact: 'dleq-proof' });
      const takeAuto = after(chain, 'happy/B/auto', 1);
      expect(Mk(takeAuto, takeAuto.tLock + 1n, { approval: { approve: false, reason: 0 } })).toMatchObject({ do: 'wait', on: 'lapse', refused: 'reject-not-available' });
      const takeWindow = after(chain, 'happy/B/window', 1);
      expect(Mk(takeWindow, takeWindow.tLock + 1n, { approval: { approve: false, reason: 2 } })).toMatchObject({ do: 'call', call: { name: 'reject', reason: 2 } });
    });

    it('back out (direction B): wins over setting ready while the refund window is open', () => {
      const active = after(chain, 'happy/B/auto', 2);
      const noticed = after(chain, 'happy/B/auto', 3);
      const ready = after(chain, 'happy/B/auto', 4);
      const good = { noticeOpens: true, lock: GOOD, commitmentsOk: true, backOut: true };
      expect(Mk(active, active.tActive + 5n, { backOut: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9a' });
      const readyMin = noticed.tNotice + BigInt(noticed.depth * 60);
      // Lock confirmed and ready allowed: the maker asked for its escrow back, so it refunds.
      expect(Mk(noticed, readyMin + 5n, good)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9c', secret: true, notAfter: noticed.tClaimOpen - M });
      expect(Mk(noticed, noticed.tNotice + 1n, { backOut: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9c' });
      expect(Mk(noticed, noticed.tCut, good)).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9d' });
      expect(Mk(noticed, noticed.tClaimOpen - M, good)).toMatchObject({ do: 'call', call: { name: 'refund' } });
      // One second later it could leak the share: refused, and ready is set on the confirmed lock instead.
      expect(Mk(noticed, noticed.tClaimOpen - M + 1n, good)).toMatchObject({ do: 'call', call: { name: 'set_ready' }, refused: 'refund-window-closed' });
      expect(Mk(noticed, noticed.tClaimOpen - M + 1n, { backOut: true, noticeOpens: false })).toMatchObject({ do: 'wait', refused: 'refund-window-closed' });
      // After a late notice the same request holds the taker's deposit.
      const late = after(chain, 'B/late-notice-then-refund', 3);
      expect(late.flags & 16).toBeTruthy();
      expect(Mk(late, late.tNotice + 1n, { backOut: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9h' });
      // READY: no refund before T_cd.
      expect(Mk(ready, ready.tReady + 1n, { backOut: true })).toEqual({ do: 'wait', on: 'claim', until: ready.tClaimDeadline, refused: 'ready-already-set' });
      expect(Mk(ready, ready.tClaimDeadline, { backOut: true })).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9e' });
      expect(Mk(ready, ready.tFinal - M + 1n, { backOut: true })).toMatchObject({ do: 'wait', refused: 'refund-window-closed' });
      expect(Mk(ready, ready.tReady + 1n).refused).toBeUndefined();
    });

    it('withhold: inside the hold only (hold-ended afterwards); release: wins over withhold; neither without a held deposit', () => {
      const held = after(chain, 'deposit/A/withheld-then-released', 3);
      const withheld = after(chain, 'deposit/A/withheld-then-split', 4);
      expect(withheld.state).toBe(SWAP_STATE.WITHHELD);
      const tHold = held.tRefund + 1800n;
      expect(Mk(held, tHold - 1n, { withhold: true, lockTx: 'relayed' })).toMatchObject({ do: 'call', call: { name: 'withhold' } });
      // At T_hold the contract refuses it, whatever else there is to do.
      expect(Mk(held, tHold, { withhold: true, lockTx: 'relayed' })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null, refused: 'hold-ended' });
      expect(Mk(held, tHold, { withhold: true, lockTx: 'relayed', swept: true })).toMatchObject({ do: 'call', call: { name: 'publish_evidence' }, refused: 'hold-ended' });
      // A release asked for together with a withhold: the taker gets its deposit.
      expect(Mk(held, tHold - 1n, { withhold: true, release: true })).toMatchObject({ do: 'call', call: { name: 'release_deposit' }, caller: 'operator' });
      expect(Mk(withheld, withheld.tRefund + 99_999n, { release: true })).toMatchObject({ do: 'call', call: { name: 'release_deposit' } });
      // Already withheld: asking again is not a refusal.
      expect(Mk(withheld, withheld.tRefund + 100n, { withhold: true, lockTx: 'relayed', swept: true }).refused).toBeUndefined();
      // No deposit in the hold: before any refund, and after settlement.
      const noticed = after(chain, 'happy/A/auto', 2);
      const done = after(chain, 'happy/A/auto', 4);
      expect(Mk(noticed, noticed.tNotice + 5n, { release: true, lockTx: 'relayed' })).toMatchObject({ do: 'wait', on: 'ready', refused: 'no-deposit-held' });
      expect(Mk(noticed, noticed.tNotice + 5n, { withhold: true, lockTx: 'relayed' }).refused).toBe('no-deposit-held');
      expect(Mk(done, done.tSettled + 5n, { release: true })).toEqual({ do: 'done', outcome: 'completed', refused: 'no-deposit-held' });
      expect(Mk(noticed, noticed.tNotice + 5n, { lockTx: 'relayed' }).refused).toBeUndefined();
    });

    it('abort instead of a claim without ready (direction A): until T_final; refused after it', () => {
      const noticed = after(chain, 'happy/A/auto', 2);
      const f = { lockTx: 'relayed' as const, lock: GOOD, withoutReady: 'abort' as const };
      expect(Mk(noticed, noticed.tClaimOpen, f)).toMatchObject({ do: 'call', call: { name: 'abort' }, row: 'A7c' });
      expect(Mk(noticed, noticed.tFinal - 1n, f)).toMatchObject({ do: 'call', call: { name: 'abort' } });
      expect(Mk(noticed, noticed.tFinal, f)).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11c', refused: 'abort-window-closed' });
      expect(Mk(noticed, noticed.tFinal, { lockTx: 'relayed', lock: GOOD }).refused).toBeUndefined();
    });
  });
});
