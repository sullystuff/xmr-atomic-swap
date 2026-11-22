/**
 * Maker key shares (SPEC 2.2): 16 random bytes of share id per share, WRITTEN TO THE DATABASE
 * BEFORE the share is published, signed into a quote or used. The secret is re-derived from the
 * keystore seed; a restored old database generates new random ids, so it cannot re-issue a share.
 */
import { randomBytes } from 'node:crypto';
import type { DerivedKeys } from '@xmrswap/core-wasm';
import type { ChainName } from '@xmrswap/protocol';
import type { Keystore } from '../keystore/index.js';
import type { ShareRow, ShareStatus, Store } from '../store/db.js';
import { type Bytes, hex, unhex } from '../util.js';

export class Shares {
  constructor(
    private readonly store: Store,
    private readonly keystore: Keystore,
  ) {}

  /** A fresh share: its row exists before this returns. */
  create(chain: ChainName, purpose: string, swapRef: string | null = null, status: ShareStatus = 'fresh'): { row: ShareRow; keys: DerivedKeys } {
    for (;;) {
      const shareId = hex(randomBytes(16));
      const keys = this.keystore.shareKeys(chain, shareId);
      if (keys.spend.every((b) => b === 0)) continue; // SPEC 2.2: reject and treat the id as burned
      const row = { share_id: shareId, chain, spend_pub: hex(keys.spendPub), status, purpose, swap_ref: swapRef };
      this.store.insertShare(row);
      return { row: { ...row, created_at: this.store.now() }, keys };
    }
  }
  keysOf(row: ShareRow): DerivedKeys {
    return this.keystore.shareKeys(row.chain, row.share_id);
  }
  /** The maker's share of a swap: the one bound to it, or the one whose commitment the swap names. */
  forSwap(swapRef: string, makerSpendPub?: Bytes): { row: ShareRow; keys: DerivedKeys } | null {
    const named = makerSpendPub && !makerSpendPub.every((b) => b === 0) ? this.store.shareByPub(hex(makerSpendPub)) : undefined;
    const row = named ?? this.store.shareForSwap(swapRef);
    if (!row || row.status === 'burned') return null;
    // A share another swap already holds is not this swap's share (two takers named one leaf).
    if (row.swap_ref && row.swap_ref !== swapRef) return null;
    return { row, keys: this.keysOf(row) };
  }
  bind(row: ShareRow, swapRef: string): void {
    this.store.setShare(row.share_id, 'bound', swapRef);
  }
  /** Every commitment this maker ever issued: a taker presenting one of them is replaying our share (SPEC 2.6). */
  ownCommitments(): Bytes[] {
    return this.store.shares().map((s) => unhex(s.spend_pub));
  }
  isOwn(spendPub: Bytes): boolean {
    return this.store.shareByPub(hex(spendPub)) !== undefined;
  }
}
