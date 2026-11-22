/**
 * The identity link across chains and the merged reputation (SPEC 3.7, 5.6).
 *
 * The Solana maker record names an Ethereum address; the Ethereum record names a Solana owner
 * key. Neither contract reads the other. Two records are one identity **only when both pointers
 * are in effect and point at each other**; a one-sided pointer is ignored. A change or removal
 * takes effect after `LINK_DELAY_SECS`, and history stays attached to both keys after an
 * unlink, so a bad record cannot be shed.
 */
import { COUNTER, COUNTER_NAMES, COUNTER_SLOTS, type CounterName, base58Decode } from '@xmrswap/protocol';
import { type Bytes, bytesEqual, hex, isZero, unhex } from '../util.js';

/** The link fields of the Solana `Maker` account. */
export interface SolanaLinkFields {
  /** The owner key (base58): what the Ethereum record must point at. */
  owner: string;
  ethLink: Bytes;
  ethLinkNext: Bytes;
  ethLinkNextAt: bigint;
}
/** The link fields of the Ethereum `Maker` record, keyed by the maker's registering address. */
export interface EthereumLinkFields {
  /** The maker's registered (owner) address: what the Solana record must point at. */
  address: string;
  solanaOwner: string | Bytes;
  solanaOwnerNext: string | Bytes;
  solanaOwnerNextAt: bigint;
}

const b = (x: string | Bytes): Bytes => (typeof x === 'string' ? unhex(x) : x);

/**
 * The Ethereum address a Solana record points at, as of `now` (Solana chain time): the pending
 * value once `now >= eth_link_next_at`, otherwise the current one. `null` = no pointer.
 */
export function effectiveEthLink(m: SolanaLinkFields, now: bigint): Bytes | null {
  const cur = m.ethLinkNextAt !== 0n && now >= m.ethLinkNextAt ? m.ethLinkNext : m.ethLink;
  return isZero(cur) ? null : cur;
}
/** The Solana owner key an Ethereum record points at, as of `now` (Ethereum chain time). */
export function effectiveSolanaLink(m: EthereumLinkFields, now: bigint): Bytes | null {
  const cur = m.solanaOwnerNextAt !== 0n && now >= m.solanaOwnerNextAt ? b(m.solanaOwnerNext) : b(m.solanaOwner);
  return isZero(cur) ? null : cur;
}

export type LinkStatus =
  /** Neither record points anywhere. */
  | 'none'
  /** Only one pointer is in effect, or the two do not point at each other: ignored. */
  | 'one-sided'
  /** Both pointers are in effect and point at each other: one identity. */
  | 'mutual';

export interface LinkView {
  status: LinkStatus;
  /** A change or removal is scheduled on either side (shown to the user; not yet in effect). */
  pendingChange: boolean;
}

/**
 * The link between a Solana record and the Ethereum record it names. Each chain's pointer is
 * evaluated at that chain's own time.
 */
export function linkStatus(sol: SolanaLinkFields, eth: EthereumLinkFields | null, nowSolana: bigint, nowEthereum: bigint): LinkView {
  const toEth = effectiveEthLink(sol, nowSolana);
  const toSol = eth ? effectiveSolanaLink(eth, nowEthereum) : null;
  const pendingChange = (sol.ethLinkNextAt !== 0n && nowSolana < sol.ethLinkNextAt) || (eth !== null && eth.solanaOwnerNextAt !== 0n && nowEthereum < eth.solanaOwnerNextAt);
  if (!toEth && !toSol) return { status: 'none', pendingChange };
  const mutual = toEth !== null && toSol !== null && eth !== null && bytesEqual(toEth, unhex(eth.address)) && bytesEqual(toSol, base58Decode(sol.owner));
  return { status: mutual ? 'mutual' : 'one-sided', pendingChange };
}

/**
 * Pairs of keys that were ever seen mutually linked. Clients keep history attached to both keys
 * after an unlink; this is the memory that makes that possible for a reader that only sees
 * current state. Persist `toJSON()` and restore with `LinkMemory.from`.
 */
export class LinkMemory {
  private readonly pairs = new Set<string>();
  private static key(solanaOwner: string, ethAddress: string): string {
    return `${solanaOwner}|${ethAddress.toLowerCase()}`;
  }
  remember(solanaOwner: string, ethAddress: string): void {
    this.pairs.add(LinkMemory.key(solanaOwner, ethAddress));
  }
  has(solanaOwner: string, ethAddress: string): boolean {
    return this.pairs.has(LinkMemory.key(solanaOwner, ethAddress));
  }
  /** Every Ethereum address ever mutually linked to this Solana owner. */
  ethereumOf(solanaOwner: string): string[] {
    return [...this.pairs].filter((p) => p.startsWith(`${solanaOwner}|`)).map((p) => p.split('|')[1]!);
  }
  toJSON(): string[] {
    return [...this.pairs].sort();
  }
  static from(pairs: readonly string[]): LinkMemory {
    const m = new LinkMemory();
    for (const p of pairs) if (/^[1-9A-HJ-NP-Za-km-z]{32,44}\|0x[0-9a-f]{40}$/.test(p)) m.pairs.add(p);
    return m;
  }
}

// ------------------------------------------------------------------ counters and derived figures

/** One chain's record of a maker. */
export interface MakerCounters {
  /** `[u32; 40]`, ids of SPEC 3.7. */
  counters: readonly number[];
  responseSecsSum: bigint;
}

/** Add the counters of a maker's linked records (plain sums: two `u32` counters cannot overflow a number). */
export function mergeCounters(records: readonly MakerCounters[]): MakerCounters {
  const counters = new Array<number>(COUNTER_SLOTS).fill(0);
  let responseSecsSum = 0n;
  for (const r of records) {
    for (let i = 0; i < COUNTER_SLOTS; i++) counters[i] = counters[i]! + (r.counters[i] ?? 0);
    responseSecsSum += r.responseSecsSum;
  }
  return { counters, responseSecsSum };
}

export interface Reputation {
  /** Every counter by name. */
  counts: Readonly<Record<CounterName, number>>;
  /** The only counter that costs the 0.05% fee; the denominator for "relative to completed". */
  completed: number;
  /** `approvals / (approvals + rejections + approval_timeouts)`; `null` with no history. No-fault rejections are left out. */
  approvalRate: number | null;
  /** `response_secs_sum / approvals`, seconds. */
  meanResponseSecs: number | null;
  /** `withholds / (withholds + deposits_returned)`. */
  withholdRate: number | null;
  /** `(withholds − releases) / withholds`. */
  unreleasedRate: number | null;
  /** Provable maker faults (ids 11, 12, 13), absolute. */
  faults: { missedNotices: number; missedClaims: number; missedFunds: number; total: number };
  /** Withheld deposits never released, absolute. */
  unreleased: number;
  /** The same figures relative to `completed` (`null` when nothing was completed). Self-trading inflates the ratios above at fee-free cost; these it cannot. */
  perCompleted: { faults: number | null; withholds: number | null; unreleased: number | null };
  /** The maker's own statement, shown beside `rejections` so ordinary rejections cannot hide there unnoticed. */
  rejectionsNoFault: number;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/** The figures clients derive from a maker's (merged) counters. */
export function reputationOf(m: MakerCounters): Reputation {
  const counts = Object.fromEntries(COUNTER_NAMES.map((n) => [n, m.counters[COUNTER[n]] ?? 0])) as Record<CounterName, number>;
  const faults = { missedNotices: counts.missed_notices, missedClaims: counts.missed_claims, missedFunds: counts.missed_funds, total: counts.missed_notices + counts.missed_claims + counts.missed_funds };
  const unreleased = Math.max(0, counts.withholds - counts.releases);
  return {
    counts,
    completed: counts.completed,
    approvalRate: ratio(counts.approvals, counts.approvals + counts.rejections + counts.approval_timeouts),
    meanResponseSecs: counts.approvals > 0 ? Number(m.responseSecsSum) / counts.approvals : null,
    withholdRate: ratio(counts.withholds, counts.withholds + counts.deposits_returned),
    unreleasedRate: ratio(unreleased, counts.withholds),
    faults,
    unreleased,
    perCompleted: { faults: ratio(faults.total, counts.completed), withholds: ratio(counts.withholds, counts.completed), unreleased: ratio(unreleased, counts.completed) },
    rejectionsNoFault: counts.rejections_no_fault,
  };
}

export interface MergedIdentity {
  link: LinkView;
  /** The Ethereum record's history is merged into the figures. */
  merged: boolean;
  /** The records are no longer mutually linked but were: history stays attached. */
  historical: boolean;
  reputation: Reputation;
}

/**
 * The reputation of a Solana maker, merged with its Ethereum record when the two are mutually
 * linked now, or were (per `memory`). A one-sided pointer merges nothing: otherwise a maker
 * could claim a stranger's good history, or pin its own bad one on somebody else.
 */
export function mergedReputation(
  sol: SolanaLinkFields & MakerCounters,
  eth: (EthereumLinkFields & MakerCounters) | null,
  now: { solana: bigint; ethereum: bigint },
  memory?: LinkMemory,
): MergedIdentity {
  const link = linkStatus(sol, eth, now.solana, now.ethereum);
  const mutual = link.status === 'mutual' && eth !== null;
  if (mutual) memory?.remember(sol.owner, eth.address);
  const historical = !mutual && eth !== null && memory?.has(sol.owner, eth.address) === true;
  const merged = mutual || historical;
  return { link, merged, historical, reputation: reputationOf(merged && eth ? mergeCounters([sol, eth]) : sol) };
}

export const ethAddressHex = (a: Bytes): string => `0x${hex(a)}`;
