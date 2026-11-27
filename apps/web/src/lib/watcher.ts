/**
 * The optional watcher (SPEC 11.6), from the taker's side. Off by default: the tab is the
 * watcher. A watcher is given one key that opens one swap's lock notice; it can pause (freeze)
 * that swap once and can do nothing else. What it buys is time, and only where the offer's
 * freeze window is long enough to add any: the page computes that for the offer at hand and
 * does not present a watcher as protection where it gives none.
 */
import type { DerivedKeys } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type ChainName } from '@xmrswap/protocol';
import { type HttpFetch, type SwapView, type WatchAck, type WatchInfo, WatcherClient, WatcherRefused, noticeKey, verifyWatchAck, watchDeployment } from '@xmrswap/sdk';
import { formatDuration } from './format.js';

/** A watcher the user chose, as remembered with the swap. Nothing here is secret. */
export interface WatcherNote {
  url: string;
  /** The watcher's Solana key: notice keys are sealed to it and acknowledgements are signed with it. */
  solana: string;
  /** The key named in the swap on its own chain (the Solana key, or the watcher's Ethereum address). */
  address: string;
  /** The verified acknowledgement, once `register()` returned one. */
  ack?: { watching_until: number; sig: string; swap_ref: string };
  /** Why the last registration attempt failed. */
  error?: string;
}

export const WATCHER_SEES = 'The watcher sees which swap you are in, its amount, its timing and the Monero transaction that pays you. It cannot move funds. It can fail.';
export const WATCHER_CAN = 'It can do one thing: pause this swap once, which delays the moment the maker can take your payment. It never holds your keys, cannot refund for you and cannot set ready.';

export interface FreezeGain {
  /** Seconds after the maker's notice by which you must be back without a watcher: `D_c − M`. */
  withoutSecs: number;
  /** Extra seconds a pause adds when it comes at the earliest moment (a notice that does not open). */
  leastExtraSecs: number;
  /** Extra seconds when it comes at the refund cutoff (a lock that never confirmed). */
  atCutoffExtraSecs: number;
  /** A watcher can add time on this offer at all. */
  useful: boolean;
}

/**
 * What a pause really adds for an offer. The maker's claim opens at `T_ff = max(t_Z + W_z, T_co)`:
 * a pause at time `t_Z` after the notice adds `max(0, (t_Z − t_N) + W_z − D_c)`. A watcher pauses
 * at once when the notice does not open, or at the cutoff `Δ_cut` when the lock is not confirmed.
 */
export function freezeGain(o: { chain: ChainName; claimDelay: number; freezeWindow: number }, depth: number): FreezeGain {
  const c = CHAIN_CONSTS[o.chain];
  const cut = c.finalitySecs + depth * c.blockAllowanceSecs + c.cutMarginSecs;
  const least = Math.max(0, o.freezeWindow - o.claimDelay);
  const atCut = o.freezeWindow > 0 ? Math.max(0, cut + o.freezeWindow - o.claimDelay) : 0;
  return { withoutSecs: o.claimDelay - c.marginSecs, leastExtraSecs: least, atCutoffExtraSecs: atCut, useful: atCut > 0 };
}

/** Whether a watcher may be named on a lock against this offer and would add time: the same rule for a single swap and for each leg of a large one. */
export const watcherEligible = (o: { chain: ChainName; direction: number; claimDelay: number; freezeWindow: number }, depth: number): boolean => o.direction === 0 && o.freezeWindow > 0 && freezeGain(o, depth).useful;

/** One honest sentence about what a watcher adds on this offer. */
export function freezeGainText(g: FreezeGain, freezeWindow: number): string {
  if (freezeWindow === 0) return 'This offer accepts no watcher.';
  if (!g.useful) return `This offer's pause window of ${formatDuration(freezeWindow)} is too short to add anything: the maker could take your payment at the same moment with or without a pause. A watcher would give no protection here, so none is offered.`;
  const without = formatDuration(g.withoutSecs);
  if (g.leastExtraSecs === g.atCutoffExtraSecs || g.leastExtraSecs > 0)
    return `Without a watcher this tab must be back within ${without} of the maker's notice. A pause adds between ${formatDuration(g.leastExtraSecs)} and ${formatDuration(g.atCutoffExtraSecs)} to that, depending on when it happens.`;
  return `Without a watcher this tab must be back within ${without} of the maker's notice. A pause at the refund cutoff adds ${formatDuration(g.atCutoffExtraSecs)}; a pause right at the notice adds nothing on this offer, because its pause window is shorter than the maker's claim delay.`;
}

/**
 * The earliest chain second at which the maker's claim could open on a watched swap whatever
 * happens, less the broadcast margin: "come back before" for the qualified Safe-to-close state.
 * Conservative: it assumes the pause comes as early as it can.
 */
export function comeBackBefore(s: Pick<SwapView, 'chain' | 'tNotice' | 'tActive' | 'tLock' | 'wZ' | 'dC'>): bigint {
  const base = s.tNotice > 0n ? s.tNotice : s.tActive > 0n ? s.tActive : s.tLock;
  return base + BigInt(Math.max(s.wZ, s.dC)) - BigInt(CHAIN_CONSTS[s.chain].marginSecs);
}

/** The qualified Safe-to-close text of SPEC 11.6, with its two figures. */
export const watchedSafeText = (before: string, deposit: string): string =>
  `A watcher will pause this swap if the lock does not check out. If it does, come back before ${before} to refund; coming back late, or a watcher that fails, can still cost you your payment. A refund after a pause can cost the deposit of ${deposit}.`;

export async function watcherInfo(url: string, fetchFn?: HttpFetch): Promise<WatchInfo> {
  return new WatcherClient(url, fetchFn).info();
}

/**
 * Hand a swap to its watcher. The request is authenticated as the swap's locker (wire format 2):
 * it is sealed with the taker's encryption secret for this swap and bound to the deployment, so
 * only the party that locked can register it. Resolves only with an acknowledgement signed by the
 * key the swap names; a watcher that rejects the request, or speaks an older format, throws and
 * the swap stays unwatched.
 */
export async function registerWithWatcher(w: Pick<WatcherNote, 'url' | 'solana'>, s: SwapView, keys: DerivedKeys, deployment: { programId: string } | { chainId: number; contract: string }, issuedAt?: bigint, fetchFn?: HttpFetch): Promise<WatchAck> {
  // `issuedAt` is the chain's time as this page last read it: every time on this site is the chain's, and the watcher compares it with the swap's own lock time.
  return new WatcherClient(w.url, fetchFn).register({ chain: s.chain, swapRef: s.swapRef, noticeKey: noticeKey(s, keys.encSecret), lockerEncSecret: keys.encSecret, deployment: watchDeployment(deployment), watcherSolanaKey: w.solana, ...(issuedAt !== undefined ? { issuedAt } : {}) });
}

/** Why a watcher did not acknowledge, in plain words. */
export function watcherRefusalText(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  if (code === 'WatchFormatUnsupported' || /WatchFormatUnsupported/.test(msg)) return 'The watcher speaks an older or newer request format than this page and did not accept the request';
  if (code === 'WatchAckInvalid') return 'The watcher answered, but not with an acknowledgement signed by the key this swap names';
  if (e instanceof WatcherRefused) return `The watcher rejected the request (${msg.replace(/^[A-Za-z]+:\s*/, '')})`;
  return msg;
}

/** Whether the stored acknowledgement is the named watcher's for this swap: only then is the swap treated as watched. */
export function acknowledged(w: WatcherNote | undefined, s: SwapView | null): boolean {
  if (!w?.ack || !s || s.watcherAddress === null) return false;
  if (s.watcherAddress.toLowerCase() !== w.address.toLowerCase()) return false;
  try {
    return verifyWatchAck(w.ack, { chain: s.chain, swapRef: s.swapRef, watcherSolanaKey: w.solana });
  } catch {
    return false;
  }
}
