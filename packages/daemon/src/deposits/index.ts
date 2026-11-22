/**
 * Deposit handling (DESIGN "Maker tools"; SPEC 7.1 `deposits/`): applies the withhold policy
 * inside the 30-minute hold (`never`, `always`, `price_moved`), releases held deposits on
 * request, and lists deposits approaching the 60-day split. A withheld deposit can never go to
 * the maker; withholding is a statement, and each maker's withhold rate is public.
 */
import { CHAIN_CONSTS, type Market, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import type { DepositView } from '@xmrswap/protocol/daemon-api';
import type { ResolvedOffer } from '../config/load.js';
import type { Store, SwapFacts, SwapRow } from '../store/db.js';
import { fromJson } from '../util.js';

/**
 * The policy's verdict for a refunding taker's deposit.
 *
 * `price_moved` withholds when the reference price moved against the maker by more than
 * `withhold_move_pct` between the lock and now: XMR fell while the maker's XMR was tied up
 * (direction A), or rose while its paying asset was (direction B). Without both prices the
 * rule does not withhold.
 */
export function withholdDecision(o: Pick<ResolvedOffer, 'withholdPolicy' | 'withholdMovePct' | 'directionCode'> | undefined, facts: SwapFacts, priceNowUsd: number | null): boolean {
  if (facts.manual?.withhold !== undefined) return facts.manual.withhold;
  if (!o || o.withholdPolicy === 'never') return false;
  if (o.withholdPolicy === 'always') return true;
  if (priceNowUsd === null || !facts.refPriceUsd) return false;
  const movePct = ((priceNowUsd - facts.refPriceUsd) / facts.refPriceUsd) * 100;
  return o.directionCode === 0 ? movePct < -o.withholdMovePct : movePct > o.withholdMovePct;
}

/** Whether the maker agrees to release: only by its own decision in the console. */
export const releaseDecision = (facts: SwapFacts): boolean => facts.manual?.release === true;

/** Held and withheld deposits with their countdowns (`GET /api/deposits`). */
export function depositViews(store: Store, offerFor: (row: SwapRow) => ResolvedOffer | undefined, priceNowUsd: number | null): DepositView[] {
  const out: DepositView[] = [];
  for (const row of store.swaps()) {
    if (row.state !== SWAP_STATE.HOLD && row.state !== SWAP_STATE.WITHHELD) continue;
    const snap = row.snapshot ? fromJson<{ tRefund: bigint; flags: number }>(row.snapshot) : null;
    if (!snap) continue;
    const c = CHAIN_CONSTS[row.chain];
    const refundedAt = Number(snap.tRefund);
    const decision = withholdDecision(offerFor(row), row.facts, priceNowUsd);
    out.push({
      chain: row.chain, ref: row.ref, market: row.market as Market, taker: row.taker, deposit: row.deposit, state: row.state === SWAP_STATE.HOLD ? 'held' : 'withheld',
      refunded_at: refundedAt, hold_until: refundedAt + c.holdSecs, split_at: refundedAt + c.splitSecs,
      evidence_required: row.direction === 0 && (snap.flags & SWAP_FLAG.NOTICE) !== 0,
      policy_decision: row.state === SWAP_STATE.WITHHELD ? (releaseDecision(row.facts) ? 'release' : 'none') : decision ? 'withhold' : 'none',
      release_requested: row.facts.releaseRequested === true,
    });
  }
  return out.sort((a, b) => a.split_at - b.split_at);
}
