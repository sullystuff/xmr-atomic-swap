/**
 * Evidence publisher (DESIGN "Maker tools"; SPEC 7.1 `evidence/`): after an abort or refund
 * where a notice exists, the maker publishes the opening `(txid, v_C)` of its notice
 * commitment, so anyone can compute the joint view key and check the Monero lock. The opening
 * is also what a `withhold` after the maker's own notice must carry.
 */
import { SWAP_FLAG } from '@xmrswap/protocol';
import { type SwapView, evidenceOpens, hasFlag } from '@xmrswap/sdk';
import type { Store } from '../store/db.js';
import type { Shares } from '../swaps/shares.js';
import { type Bytes, unhex } from '../util.js';

/** The opening of this maker's notice for a direction-A swap, or `null` when it has none that opens the commitment on record. */
export function evidenceFor(store: Store, shares: Shares, ref: string, view: SwapView): { txid: Bytes; view: Bytes } | null {
  if (view.direction !== 0 || !hasFlag(view, SWAP_FLAG.NOTICE)) return null;
  const lock = store.lockTx(ref);
  const share = shares.forSwap(ref, view.makerSpendPub);
  if (!lock || !share) return null;
  const ev = { txid: unhex(lock.txid), view: share.keys.view };
  return evidenceOpens(view, ev.txid, ev.view) ? ev : null;
}

/** Evidence is due when a notice is on record, none was published, and the swap was aborted or refunded. */
export function evidenceDue(view: SwapView): boolean {
  return hasFlag(view, SWAP_FLAG.NOTICE) && !hasFlag(view, SWAP_FLAG.EVIDENCE);
}
