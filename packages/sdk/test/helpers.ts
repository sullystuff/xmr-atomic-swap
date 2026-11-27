import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChainName } from '@xmrswap/protocol';
import { SWAP_STATE } from '@xmrswap/protocol';
import type { Call, Env, ModelSwap, Role } from '../src/machine/model.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = new Map<string, unknown>();
/** A frozen vector suite from `interfaces/vectors`. */
export function vector(name: string): any {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(path.join(repoRoot, 'interfaces/vectors', `${name}.json`), 'utf8')));
  return cache.get(name);
}
export const vectorFile = (rel: string): Uint8Array => new Uint8Array(readFileSync(path.join(repoRoot, 'interfaces/vectors', rel)));

/** Deterministic pseudo-random bytes (xorshift), so failures reproduce. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => next() & 0xff);
  return { next, bytes };
}

// ------------------------------------------------------------------ transitions.json

export interface VectorStep {
  at: number;
  call: string;
  caller: Role;
  args: Record<string, any>;
  env: { maker_can_receive: boolean; taker_can_receive: boolean; treasury_can_receive: boolean; payout_can_receive: boolean; maker_paused: boolean; open_pending: number; caps: { on: boolean; max_swap: string; max_open: string; open_value: string } };
  /** `multi_sequences` only: the index of the step's swap. */
  swap?: number;
  expect?: any;
}

/** A swap as `transitions.json` writes it, in the model's shape. */
export function swapOf(j: any): ModelSwap {
  const t = (k: string) => BigInt(j[k]);
  return {
    state: j.state_code,
    direction: j.direction === 'A' ? 0 : 1,
    mode: j.mode,
    outcome: j.outcome,
    depositState: j.deposit_state,
    depth: j.depth,
    flags: j.flags,
    amount: BigInt(j.amount),
    deposit: BigInt(j.deposit),
    feeBps: j.fee_bps,
    wN: j.w_n,
    dC: j.d_c,
    wC: j.w_c,
    tLock: t('t_lock'),
    tPendingDeadline: t('t_pending_deadline'),
    tActive: t('t_active'),
    tNoteDeadline: t('t_note_deadline'),
    tNotice: t('t_notice'),
    tCut: t('t_cut'),
    tClaimOpen: t('t_claim_open'),
    tReady: t('t_ready'),
    tClaimDeadline: t('t_claim_deadline'),
    tFinal: t('t_final'),
    tRefund: t('t_refund'),
    tSettled: t('t_settled'),
    owedTaker: BigInt(j.owed_taker),
    owedMaker: BigInt(j.owed_maker),
    owedTreasury: BigInt(j.owed_treasury),
    payout: j.payout,
    watcher: j.watcher,
    wZ: j.w_z,
    tFreeze: t('t_freeze'),
  };
}

export function callOf(step: VectorStep): Call {
  const a = step.args;
  switch (step.call) {
    case 'lock':
    case 'take':
      return {
        name: step.call,
        args: { offerMode: a.offer_mode, approval: a.approval, amount: BigInt(a.amount), xmr: BigInt(a.xmr), wA: a.w_a, wN: a.w_n, dC: a.d_c, wC: a.w_c, wF: a.w_f, depth: a.depth, depBps: a.dep_bps, wZ: a.w_z, payout: a.payout, watcher: a.watcher },
      };
    case 'approve':
      return { name: 'approve', openOk: a.open_ok };
    case 'fund':
      return { name: 'fund', openOk: a.open_ok, watcher: a.watcher };
    case 'reject':
      return { name: 'reject', openOk: a.open_ok, reason: a.reason };
    case 'refund':
    case 'claim':
      return { name: step.call, secretOk: a.secret_ok };
    case 'withhold':
      return { name: 'withhold', evidence: a.evidence };
    case 'publish_evidence':
      return { name: 'publish_evidence', opens: a.opens };
    case 'withdraw_owed':
    case 'push_owed':
      return { name: step.call, who: a.who };
    default:
      return { name: step.call } as Call;
  }
}

export const envOf = (step: VectorStep): Env => ({
  takerCanReceive: step.env.taker_can_receive,
  makerCanReceive: step.env.maker_can_receive,
  treasuryCanReceive: step.env.treasury_can_receive,
  openPending: step.env.open_pending,
  payoutCanReceive: step.env.payout_can_receive,
  makerPaused: step.env.maker_paused,
  caps: { on: step.env.caps.on, maxSwap: BigInt(step.env.caps.max_swap), maxOpen: BigInt(step.env.caps.max_open), openValue: BigInt(step.env.caps.open_value) },
});

/** Every distinct open swap state that appears in `transitions.json` for a chain (the flow tests' corpus). */
export function corpus(chain: ChainName): ModelSwap[] {
  const v = vector('transitions');
  const seen = new Map<string, ModelSwap>();
  const add = (j: any) => {
    if (!j || j.state_code === SWAP_STATE.NONE) return;
    const key = JSON.stringify(j);
    if (!seen.has(key)) seen.set(key, swapOf(j));
  };
  for (const r of v.rows) {
    if (r.chain !== chain) continue;
    add(r.from);
    add(r.step.expect?.swap);
  }
  for (const q of v.sequences) {
    if (q.chain !== chain) continue;
    for (const s of q.steps) add(s.expect?.swap);
  }
  for (const q of v.multi_sequences) {
    if (q.chain !== chain) continue;
    for (const s of q.steps) add(s.expect?.swap);
  }
  return [...seen.values()];
}
