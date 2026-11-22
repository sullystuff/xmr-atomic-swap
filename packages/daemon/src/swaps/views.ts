/** Swap rows as the console sees them (`GET /api/swaps`, `GET /api/swaps/:ref`, `GET /api/approvals`). */
import { CHAIN_CONSTS, COUNTER_NAMES, COUNTER_NONE, type Market, SWAP_FLAG, SWAP_STATE, SWAP_STATE_NAMES } from '@xmrswap/protocol';
import type { PendingApproval, SwapAction, SwapDeadlines, SwapDetail, SwapSummary } from '@xmrswap/protocol/daemon-api';
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
  if (v.state === S.ACTIVE || v.state === S.NOTICED) out.push('abort');
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
    : v.state === S.READY ? [[d.tCd, v.direction === 0 ? 'claim deadline; a miss is recorded against the maker' : "taker's claim deadline"]]
    : v.state === S.HOLD ? [[d.tHold, 'deposit hold ends; anyone may release']]
    : v.state === S.WITHHELD ? [[d.tSplit, 'withheld deposit is split']]
    : [[d.tFinal, 'final deadline']];
  const next = candidates.filter(([t]) => t !== null && Number(t) > now).sort((a, b) => Number(a[0]! - b[0]!))[0] ?? candidates.filter(([t]) => t !== null)[0];
  return next && next[0] !== null ? { at: Number(next[0]), label: next[1] } : null;
}

export function swapSummary(row: SwapRow, now: number): SwapSummary {
  const v = snapshotOf(row);
  return {
    chain: row.chain, ref: row.ref, market: row.market as Market, direction: row.direction === 0 ? 'A' : 'B', state: SWAP_STATE_NAMES[row.state] ?? 'NONE', phase: row.phase, taker: row.taker,
    xmr: row.xmr, amount: row.amount, deposit: row.deposit, depth: row.depth, opened_at: row.opened_at, next_deadline: v && !row.terminal ? nextDeadline(v, now) : null,
    outcome: v && v.outcome !== COUNTER_NONE ? (COUNTER_NAMES[v.outcome] ?? null) : null, needs_review: row.needs_review === 1, actions: actionsFor(row, v, now),
    // Additions to the frozen summary: the swap's effective mode, and the operator's latest instruction with what became of it.
    ...({ mode: v?.mode ?? 0, instruction: instructionView(row) } as object),
  };
}

export function swapDetail(store: Store, row: SwapRow, now: number, lock: LockReport | undefined): SwapDetail {
  const v = snapshotOf(row);
  const d = v ? deadlinesOf(v.chain, v) : null;
  const c = CHAIN_CONSTS[row.chain];
  const deadlines: SwapDeadlines = {
    t_lock: row.opened_at, t_pending_deadline: n(v?.tPendingDeadline), t_active: n(v?.tActive), t_note_deadline: n(v?.tNoteDeadline), t_notice: n(v?.tNotice), t_cut: n(v?.tCut), t_claim_open: n(v?.tClaimOpen), t_ready: n(v?.tReady),
    t_claim_deadline: n(v?.tClaimDeadline), t_final: Number(v?.tFinal ?? 0n), t_exp: Number(d?.tExp ?? BigInt(c.expirySecs)), t_refund: n(v?.tRefund), t_hold: n(d?.tHold), t_split: n(d?.tSplit), t_settled: n(v?.tSettled),
  };
  return {
    ...swapSummary(row, now), mode: v?.mode ?? 0, flags: v?.flags ?? 0, deposit_state: v?.depositState ?? 0, deadlines, joint_address: row.joint_address,
    lock_txid: row.lock_txid ?? store.lockTx(row.ref)?.txid ?? null, lock_confirmations: lock?.confirmations ?? null, lock_state: lock?.state ?? null, sweep_txid: row.sweep_txid,
    evidence_published: v ? (v.flags & SWAP_FLAG.EVIDENCE) !== 0 : false,
    intents: store.intents({ swapRef: row.ref }).map((i) => ({ id: String(i.id), kind: `${i.kind}${typeof i.payload['call'] === 'string' ? `:${i.payload['call']}` : ''}`, status: i.status, tx: i.tx, at: i.created_at })),
    messages: store.messages(row.ref).map(inboxItem), last_error: row.last_error,
    // An addition to the frozen shape: the operator's latest instruction and what became of it.
  };
}

export function pendingApproval(row: SwapRow, d: { recommendation: 'approve' | 'reject'; reasons: string[] }): PendingApproval | null {
  const v = snapshotOf(row);
  if (!v || v.state !== SWAP_STATE.PENDING || row.terminal) return null;
  return { chain: row.chain, ref: row.ref, market: row.market as Market, direction: row.direction === 0 ? 'A' : 'B', taker: row.taker, xmr: row.xmr, amount: row.amount, deadline: Number(v.tPendingDeadline), recommendation: d.recommendation, reasons: d.reasons, dleq_ok: row.chain === 'ethereum' ? (row.facts.takerProofOk ?? null) : null };
}
