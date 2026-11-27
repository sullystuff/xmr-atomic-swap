/**
 * `watcherStep`: the whole behaviour of a watcher (Amendment 1, SPEC 11.6), as a pure function.
 *
 * A watcher follows a swap that names it. When a notice appears it decrypts and checks it with
 * the notice key, verifies the Monero lock with view data only, and **freezes** when the notice
 * does not open its commitment, or when the lock is not `confirmed` at `T_cut`, sending no later
 * than `T_co − M`. It stops when the swap is READY, FROZEN or settled. It never refunds, never
 * sets ready, proposes no other call, and holds no spend share.
 *
 * Like the other flows it does no I/O and reads no clock: the service loops "read the swap at
 * `finalized`, gather the facts it asks for (`watcherFacts`), do what it says".
 */
import type { Network } from '@xmrswap/core-wasm';
import { SWAP_STATE } from '@xmrswap/protocol';
import { swapJointAddress } from '../flows/keys.js';
import type { LockReport } from '../flows/types.js';
import { type SwapView, deadlinesOf } from '../machine/view.js';
import type { MoneroNode } from '../monero/rpc.js';
import { type VerifyLockResult, checkNodePolicy, verifyLock } from '../monero/verify.js';
import { lockReport } from '../monero/watch.js';
import { type Bytes, hex } from '../util.js';
import { openNoticeWithKey } from './protocol.js';

export interface WatcherFacts {
  /** The swap read at `finalized`, or `null` when no such swap exists (never opened, or closed). */
  swap: SwapView | null;
  /** Chain time of that read. */
  now: bigint;
  /** The watcher's own key on the swap's chain (base58, or a lowercase 0x address). */
  watcher: string;
  /**
   * Whether the notice on record opens its commitment under the notice key the locker gave:
   * `undefined` = not checked yet. `false` is "no lock" (SPEC 2.8) and is frozen at once.
   */
  noticeOpens?: boolean;
  /** `verifyLock` at the swap's depth under the node policy (two nodes, or one own node). */
  lock?: LockReport;
}

export type WatcherStop =
  /** The swap does not exist (any more). */
  | 'no-swap'
  /** The swap names another watcher, or none: this key can do nothing on it. */
  | 'not-named'
  /** Ready is set: the locker verified the lock itself. */
  | 'ready'
  /** Already frozen (by this watcher or by the locker): a swap is frozen once. */
  | 'frozen'
  /** Aborted, refunded or settled: nothing is left to protect. */
  | 'ended'
  /** `T_co − M` has passed: a freeze could no longer land before `T_co`. */
  | 'too-late';

export type WatcherDecision =
  | {
      do: 'call';
      call: { name: 'freeze' };
      caller: 'watcher';
      /** Last chain second at which the freeze may still be broadcast: `T_co − M`. */
      notAfter: bigint;
      why: 'notice-invalid' | 'lock-not-confirmed';
    }
  | { do: 'need'; fact: 'notice-opening' | 'lock-report' }
  | { do: 'wait'; on: 'notice' | 'lock-check' | 'recheck'; until: bigint | null }
  | { do: 'stop'; why: WatcherStop };

const same = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

export function watcherStep(f: WatcherFacts): WatcherDecision {
  const s = f.swap;
  if (!s || s.state === SWAP_STATE.NONE) return { do: 'stop', why: 'no-swap' };
  const S = SWAP_STATE;
  if (s.state === S.READY) return { do: 'stop', why: 'ready' };
  if (s.state === S.FROZEN) return { do: 'stop', why: 'frozen' };
  if (s.state !== S.PENDING && s.state !== S.ACTIVE && s.state !== S.NOTICED) return { do: 'stop', why: 'ended' };
  const d = deadlinesOf(s.chain, s);
  // Direction B names its watcher at fund: a pending take may not name anyone yet.
  if (s.state === S.PENDING && s.direction === 1) return { do: 'wait', on: 'notice', until: d.tPend };
  // Ethereum addresses compare case-insensitively; base58 keys exactly.
  if (s.watcherAddress === null || !(s.chain === 'ethereum' ? same(s.watcherAddress, f.watcher) : s.watcherAddress === f.watcher) || s.wZ === 0) return { do: 'stop', why: 'not-named' };
  if (s.state === S.PENDING) return { do: 'wait', on: 'notice', until: d.tPend };
  // No notice yet: the keyless refund protects the locker; a freeze is neither possible nor needed.
  if (s.state === S.ACTIVE) return { do: 'wait', on: 'notice', until: d.tNote };

  // NOTICED. A freeze is accepted before T_co; it is sent with the broadcast margin to spare.
  const last = d.tCo! - d.margin;
  if (f.now > last) return { do: 'stop', why: 'too-late' };
  const freeze = (why: 'notice-invalid' | 'lock-not-confirmed'): WatcherDecision => ({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: last, why });
  if (f.noticeOpens === undefined) return { do: 'need', fact: 'notice-opening' };
  // A notice that does not decrypt or does not open its commitment is no lock at all.
  if (!f.noticeOpens) return freeze('notice-invalid');
  if (f.lock === undefined) return { do: 'need', fact: 'lock-report' };
  const confirmed = f.lock.ok && f.lock.state === 'confirmed';
  if (f.now < d.tCut!) return { do: 'wait', on: 'lock-check', until: d.tCut };
  if (!confirmed) return freeze('lock-not-confirmed');
  // Confirmed at T_cut. Confirmations can go down: keep verifying until a freeze could no longer land.
  return { do: 'wait', on: 'recheck', until: last };
}

/**
 * The facts `watcherStep` asks for, gathered with view data only: open the notice with the
 * notice key, derive the joint address from the four public halves and the two view shares
 * (the locker's is in clear on-chain, the claimer's is in the notice), and run `verifyLock`
 * against every node. The node policy is enforced before anything is read: two or more nodes,
 * or one the operator declares its own. A verification that throws is "not confirmed".
 */
export async function watcherFacts(a: {
  swap: SwapView;
  noticeKey: Bytes;
  nodes: (string | MoneroNode)[];
  ownNode?: boolean;
  network: Network;
  verify?: typeof verifyLock;
}): Promise<{ noticeOpens: boolean; lock?: LockReport; result?: VerifyLockResult; txid?: Bytes }> {
  checkNodePolicy(a.nodes.length, a.ownNode);
  const opening = openNoticeWithKey(a.swap, a.noticeKey);
  if (!opening) return { noticeOpens: false };
  const failed: LockReport = { state: 'invalid', ok: false, confirmations: 0 };
  let viewPriv: Bytes;
  let spendPub: Bytes;
  try {
    // Validates both commitments and both view shares and refuses a zero sum; nothing here is a spend share.
    const joint = swapJointAddress(a.swap, opening.view, a.network);
    viewPriv = joint.viewPriv;
    spendPub = joint.spendPub;
  } catch {
    return { noticeOpens: true, lock: failed, txid: opening.txid };
  }
  try {
    const result = await (a.verify ?? verifyLock)({ nodes: a.nodes, ...(a.ownNode ? { ownNode: true } : {}), txid: hex(opening.txid), viewPriv: hex(viewPriv), spendPub: hex(spendPub), minAmount: a.swap.xmr, minConf: a.swap.depth });
    return { noticeOpens: true, lock: lockReport(result), result, txid: opening.txid };
  } catch {
    return { noticeOpens: true, lock: failed, txid: opening.txid };
  }
}
