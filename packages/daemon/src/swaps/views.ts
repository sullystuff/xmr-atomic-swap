/** Swap rows as the console sees them (`GET /api/swaps`, `GET /api/swaps/:ref`, `GET /api/approvals`). */
import { CHAIN_CONSTS, COUNTER_NAMES, COUNTER_NONE, type Market, SWAP_FLAG, SWAP_STATE, SWAP_STATE_NAMES } from '@xmrswap/protocol';
import type { PendingApproval, SwapAction, SwapDeadlines, SwapDetail, SwapExtras, SwapSummary } from '@xmrswap/protocol/daemon-api';
import { type LockReport, type SwapView, deadlinesOf } from '@xmrswap/sdk';
import { inboxItem } from '../inbox/index.js';
import type { Store, SwapRow } from '../store/db.js';
import { fromJson } from '../util.js';

const n = (t: bigint | null | undefined): number | null => (t === null || t === undefined || t === 0n ? null : Number(t));
export const snapshotOf = (row: SwapRow): SwapView | null => (row.snapshot ? fromJson<SwapView>(row.snapshot) : null);

export const instructionView = (row: SwapRow): { action: string; at: number; status: string; reason: string | null; tx: string | null } | null =>
  row.facts.instruction ? { action: row.facts.instruction.action, at: row.facts.instruction.at, status: row.facts.instruction.status, reason: row.facts.instruction.reason ?? null, tx: row.facts.instruction.tx ?? null } : null;

/** Manual actions the state allows right now (the executor still checks every one against the flow). */
export function actionsFor(row: SwapRow, v: SwapView | null, now: number): SwapAction[] {
  if (!v || row.terminal) return [];
  const S = SWAP_STATE;
  const d = deadlinesOf(v.chain, v);
  const out: SwapAction[] = [];
  if (v.state === S.PENDING && (d.tPend === null || now < Number(d.tPend))) out.push('approve', 'reject');
  if (v.state === S.ACTIVE || v.state === S.NOTICED || v.state === S.FROZEN) out.push('abort');
  if (v.state === S.HOLD && d.tHold !== null && now < Number(d.tHold)) out.push('withhold');
  if (v.state === S.HOLD || v.state === S.WITHHELD) out.push('release');
  if ((v.flags & SWAP_FLAG.NOTICE) !== 0 && (v.flags & SWAP_FLAG.EVIDENCE) === 0 && v.direction === 0 && v.state !== S.NOTICED && v.state !== S.READY) out.push('publish-evidence');
  return out;
}

function nextDeadline(v: SwapView, now: number): { at: number; label: string } | null {
  const d = deadlinesOf(v.chain, v);
  const S = SWAP_STATE;
  const candidates: [bigint | null, string][] =
    v.state === S.PENDING ? [[d.tPend, v.direction === 0 ? 'approval window closes; the taker is refunded in full' : 'funding deadline']]
    : v.state === S.ACTIVE ? [[d.tNote, v.direction === 0 ? 'lock notice due; a miss is recorded against the maker' : "taker's notice due"]]
    : v.state === S.NOTICED ? [[d.tCut, v.direction === 0 ? 'the taker refunds automatically if the lock is not at depth' : 'refund the escrow if the XMR is not at depth'], [d.tCo, 'claim opens without ready']]
    : v.state === S.FROZEN ? [[d.tFf, v.direction === 0 ? 'the pause ends: claim opens without ready (the taker may still set ready or refund before it)' : "the pause ends: the taker may claim without ready; set ready or refund before it"]]
    : v.state === S.READY ? [[d.tCd, v.direction === 0 ? 'claim deadline; a miss is recorded against the maker' : "taker's claim deadline"]]
    : v.state === S.HOLD ? [[d.tHold, 'deposit hold ends; anyone may release']]
    : v.state === S.WITHHELD ? [[d.tSplit, 'withheld deposit is split']]
    : [[d.tFinal, 'final deadline']];
  const next = candidates.filter(([t]) => t !== null && Number(t) > now).sort((a, b) => Number(a[0]! - b[0]!))[0] ?? candidates.filter(([t]) => t !== null)[0];
  return next && next[0] !== null ? { at: Number(next[0]), label: next[1] } : null;
}

const same = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();
/** The addresses a swap names besides its two parties (SPEC 11.2, 11.6). The payout is shown only when it is not the taker's own address. */
export function swapExtras(v: SwapView | null, ack: { watching_until: number } | undefined): SwapExtras {
  return {
    payout: v && v.direction === 1 && v.payoutAddress !== null && !same(v.payoutAddress, v.taker) ? v.payoutAddress : null,
    watcher: v?.watcherAddress ?? null, freeze_window_secs: v?.wZ ?? 0, watching_until: ack?.watching_until ?? null,
  };
}

export function swapSummary(row: SwapRow, now: number, store?: Store): SwapSummary {
  const v = snapshotOf(row);
  const frozen = v && v.tFreeze !== 0n ? { t_freeze: Number(v.tFreeze), t_ff: n(deadlinesOf(v.chain, v).tFf), frozen_by: store?.freeze(row.ref)?.frozen_by ?? null } : null;
  return {
    chain: row.chain, ref: row.ref, market: row.market as Market, direction: row.direction === 0 ? 'A' : 'B', state: SWAP_STATE_NAMES[row.state] ?? 'NONE', phase: row.phase, taker: row.taker,
    xmr: row.xmr, amount: row.amount, deposit: row.deposit, depth: row.depth, opened_at: row.opened_at, next_deadline: v && !row.terminal ? nextDeadline(v, now) : null,
    outcome: v && v.outcome !== COUNTER_NONE ? (COUNTER_NAMES[v.outcome] ?? null) : null, needs_review: row.needs_review === 1, actions: actionsFor(row, v, now),
    // Additions to the frozen summary: the swap's effective mode, and the operator's latest instruction with what became of it.
    ...({ mode: v?.mode ?? 0, instruction: instructionView(row) } as object),
    extras: swapExtras(v, store?.watchAck(row.ref)),
    // Additions (Amendment 1): when the swap was paused, until when, and by whom as far as the chain tells; `null` = never paused.
    ...({ frozen } as object),
  };
}

export function swapDetail(store: Store, row: SwapRow, now: number, lock: LockReport | undefined): SwapDetail {
  const v = snapshotOf(row);
  const d = v ? deadlinesOf(v.chain, v) : null;
  const c = CHAIN_CONSTS[row.chain];
  const deadlines: SwapDeadlines = {
    t_lock: row.opened_at, t_pending_deadline: n(v?.tPendingDeadline), t_active: n(v?.tActive), t_note_deadline: n(v?.tNoteDeadline), t_notice: n(v?.tNotice), t_cut: n(v?.tCut), t_claim_open: n(v?.tClaimOpen), t_ready: n(v?.tReady),
    t_claim_deadline: n(v?.tClaimDeadline), t_final: Number(v?.tFinal ?? 0n), t_exp: Number(d?.tExp ?? BigInt(c.expirySecs)), t_refund: n(v?.tRefund), t_hold: n(d?.tHold), t_split: n(d?.tSplit), t_settled: n(v?.tSettled), t_freeze: n(v?.tFreeze), t_ff: v && v.tFreeze !== 0n ? n(d?.tFf) : null,
  };
  return {
    ...swapSummary(row, now, store), mode: v?.mode ?? 0, flags: v?.flags ?? 0, deposit_state: v?.depositState ?? 0, deadlines, joint_address: row.joint_address,
    lock_txid: row.lock_txid ?? store.lockTx(row.ref)?.txid ?? null, lock_confirmations: lock?.confirmations ?? null, lock_state: lock?.state ?? null, sweep_txid: row.sweep_txid,
    evidence_published: v ? (v.flags & SWAP_FLAG.EVIDENCE) !== 0 : false,
    intents: store.intents({ swapRef: row.ref }).map((i) => ({ id: String(i.id), kind: `${i.kind}${typeof i.payload['call'] === 'string' ? `:${i.payload['call']}` : ''}`, status: i.status, tx: i.tx, at: i.created_at })),
    messages: store.messages(row.ref).map(inboxItem), last_error: row.last_error,
    // Additions (Amendment 1): the watcher's signed acknowledgement, and the freeze as recorded.
    ...({ watcher_ack: ack(store, row.ref), freeze: store.freeze(row.ref) ?? null } as object),
  };
}

const ack = (store: Store, ref: string): { watcher: string; watching_until: number; sig: string; at: number } | null => {
  const a = store.watchAck(ref);
  return a ? { watcher: a.watcher, watching_until: a.watching_until, sig: a.sig, at: a.at } : null;
};

export function pendingApproval(row: SwapRow, d: { recommendation: 'approve' | 'reject'; reasons: string[] }, denyWatchers: string[] = [], takerFreezes = 0): PendingApproval | null {
  const v = snapshotOf(row);
  if (!v || v.state !== SWAP_STATE.PENDING || row.terminal) return null;
  return { chain: row.chain, ref: row.ref, market: row.market as Market, direction: row.direction === 0 ? 'A' : 'B', taker: row.taker, xmr: row.xmr, amount: row.amount, deadline: Number(v.tPendingDeadline), recommendation: d.recommendation, reasons: d.reasons, dleq_ok: row.chain === 'ethereum' ? (row.facts.takerProofOk ?? null) : null,
    payout: swapExtras(v, undefined).payout, watcher: v.watcherAddress, watcher_denied: v.watcherAddress !== null && denyWatchers.some((w) => same(w, v.watcherAddress!)),
    // Additions (Amendment 1): the freeze window the lock carries, and how often this taker's swaps with this maker were paused.
    ...({ freeze_window_secs: v.wZ, taker_freezes: takerFreezes } as object),
  };
}
