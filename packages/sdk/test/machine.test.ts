// The TypeScript state machine must be the reference model: every row and every sequence of
// interfaces/vectors/transitions.json is replayed through it (SPEC 2.12, 3).
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, COUNTER_NAMES, SWAP_STATE_NAMES, type ChainName } from '@xmrswap/protocol';
import { type Effects, ModelError, type ModelSwap, NO_SWAP, apply, enabled, newMakerRecord, recordEffects, type MakerRecord, isSecretBearing, type Role } from '../src/machine/model.js';
import { type VectorStep, callOf, envOf, swapOf, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const v = vector('transitions');

function run(chain: ChainName, swap: ModelSwap, step: VectorStep): Effects | ModelError {
  try {
    return apply(chain, swap, callOf(step), step.caller, BigInt(step.at), envOf(step));
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
}

function checkExpect(chain: ChainName, label: string, before: ModelSwap, step: VectorStep, got: Effects | ModelError): ModelSwap {
  const e = step.expect;
  if (!e.ok) {
    expect(got, label).toBeInstanceOf(ModelError);
    expect((got as ModelError).chainName(chain), label).toBe(e.error);
    return before; // a refused call changes nothing
  }
  if (got instanceof ModelError) throw new Error(`${label}: expected success, got ${got.code}`);
  expect(got.swap, label).toEqual(swapOf(e.swap));
  expect(SWAP_STATE_NAMES[got.swap.state], label).toBe(e.state);
  expect(got.counter, label).toBe(e.counter);
  if (e.counter !== null) expect(COUNTER_NAMES[got.counter!], label).toBe(e.counter_name);
  expect(got.escrowIn, label).toBe(BigInt(e.escrow_in));
  expect(got.closed, label).toBe(e.closed);
  expect(got.openPending, label).toBe(e.open_pending);
  expect(got.responseSecs, label).toBe(e.response_secs === null ? null : BigInt(e.response_secs));
  expect(got.volume, label).toBe(BigInt(e.volume));
  expect(got.withheldVolume, label).toBe(BigInt(e.withheld_volume));
  expect(
    got.payouts.map((p) => ({ to: p.to, amount: p.amount.toString(), parked: p.parked })),
    label,
  ).toEqual(e.payouts.map((p: any) => ({ to: p.to, amount: p.amount, parked: p.parked })));
  return got.swap;
}

describe('transitions.json rows', () => {
  for (const chain of ['solana', 'ethereum'] as const) {
    it(`replays every ${chain} row`, () => {
      const rows = v.rows.filter((r: any) => r.chain === chain);
      expect(rows.length).toBe(v.summary[chain].rows);
      let rejected = 0;
      for (const [i, r] of rows.entries()) {
        const label = `${chain} row ${i} ${r.id} ${r.case}`;
        let swap: ModelSwap = NO_SWAP;
        if (r.open) {
          for (const s of [r.open, ...r.setup] as VectorStep[]) {
            const fx = run(chain, swap, s);
            if (fx instanceof ModelError) throw new Error(`${label}: setup ${s.call} failed with ${fx.code}`);
            swap = fx.swap;
          }
          expect(swap, `${label} (from)`).toEqual(swapOf(r.from));
        }
        expect(SWAP_STATE_NAMES[swap.state], label).toBe(r.from_state);
        checkExpect(chain, label, swap, r.step, run(chain, swap, r.step));
        if (!r.ok) rejected++;
      }
      expect(rejected).toBe(v.summary[chain].rows_rejected);
    });
  }

  it('names every case by row index', () => {
    expect(v.cases.length).toBe(v.rows.length);
    for (const c of v.cases) {
      const r = v.rows[c.row];
      expect(c.valid).toBe(r.ok);
      if (!c.valid) expect(c.error).toBe(r.step.expect.error);
    }
  });
});

describe('transitions.json sequences', () => {
  const makerOf = (j: any): MakerRecord => ({
    counters: j.counters,
    responseSecsSum: BigInt(j.response_secs_sum),
    volume: BigInt(j.volume),
    withheldVolume: BigInt(j.withheld_volume),
    openPending: j.open_pending,
  });
  for (const chain of ['solana', 'ethereum'] as const) {
    it(`replays every ${chain} sequence with its maker record`, () => {
      const seqs = v.sequences.filter((q: any) => q.chain === chain);
      expect(seqs.length).toBe(v.summary[chain].sequences);
      for (const q of seqs) {
        let swap: ModelSwap = NO_SWAP;
        let maker = makerOf(q.initial_maker);
        for (const [i, step] of (q.steps as VectorStep[]).entries()) {
          const label = `${chain} ${q.name} step ${i} ${step.call}`;
          const got = run(chain, swap, step);
          swap = checkExpect(chain, label, swap, step, got);
          if (!(got instanceof ModelError)) {
            maker = recordEffects(chain, maker, got);
            expect(maker, label).toEqual(makerOf(step.expect.maker));
          }
        }
        expect(swap, `${q.name} final`).toEqual(swapOf(q.final.swap));
        expect(maker, `${q.name} final maker`).toEqual(makerOf(q.final.maker));
      }
    });
  }

  it('saturates counters and totals and never fails', () => {
    let m = newMakerRecord();
    m.counters[8] = 0xffff_ffff;
    m.responseSecsSum = (1n << 64n) - 2n;
    m.volume = (1n << 64n) - 6n;
    const fx: Effects = { swap: NO_SWAP, payouts: [], escrowIn: 0n, counter: 8, responseSecs: 10n, volume: 100n, withheldVolume: 0n, openPending: -1, closed: false };
    m = recordEffects('solana', m, fx);
    expect(m.counters[8]).toBe(0xffff_ffff);
    expect(m.responseSecsSum).toBe((1n << 64n) - 1n);
    expect(m.volume).toBe((1n << 64n) - 1n);
    expect(m.openPending).toBe(0);
  });
});

describe('invariant 1: exclusive windows', () => {
  // In every state of the corpus and at every boundary second, secret-bearing calls by two
  // different parties are never enabled together.
  it('never enables a refund and a claim at the same instant', () => {
    for (const chain of ['solana', 'ethereum'] as const) {
      const c = CHAIN_CONSTS[chain];
      const seen = new Set<string>();
      let checked = 0;
      const visit = (j: any) => {
        if (!j || j.state_code === 0) return;
        const key = JSON.stringify(j);
        if (seen.has(key)) return;
        seen.add(key);
        const s = swapOf(j);
        const marks = [s.tLock, s.tPendingDeadline, s.tActive, s.tNoteDeadline, s.tNotice, s.tCut, s.tClaimOpen, s.tReady, s.tClaimDeadline, s.tFinal, s.tFinal + BigInt(c.expirySecs), s.tRefund];
        const locker: Role = s.direction === 0 ? 'taker' : 'operator';
        const claimer: Role = s.direction === 0 ? 'operator' : 'taker';
        for (const m of marks) {
          if (m === 0n) continue;
          for (const now of [m - 1n, m, m + 1n]) {
            const refund = enabled(chain, s, { name: 'refund' }, locker, now);
            const claim = enabled(chain, s, { name: 'claim' }, claimer, now);
            expect(refund && claim, `${chain} ${j.state} at ${now}`).toBe(false);
            checked++;
          }
        }
      };
      for (const q of v.sequences) if (q.chain === chain) for (const s of q.steps) visit(s.expect?.swap);
      expect(checked).toBeGreaterThan(1000);
    }
    expect(isSecretBearing('refund') && isSecretBearing('claim') && !isSecretBearing('abort')).toBe(true);
  });
});
