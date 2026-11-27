/**
 * The page-wide safety picture (SPEC 8.5): which legs are at risk, the deadline the standing
 * banner counts down to, and whether the green "Safe to close" state may be shown. Pure.
 */
import { SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf, endedInRefund } from '@xmrswap/sdk';
import type { EngineState, Tracked } from './engine.js';
import { formatClock } from './format.js';
import { comeBackBefore } from './watcher.js';

export interface Safety {
  /** Legs paying SOL, ETH or USDC that are locked and not yet Ready or Refunded. */
  atRisk: Tracked[];
  /**
   * At-risk legs a watcher has acknowledged (SPEC 11.6): the tab may be closed, with what remains
   * at risk stated. Everything else in `atRisk` is `uncovered` and keeps the red banner up.
   */
  covered: Tracked[];
  uncovered: Tracked[];
  /**
   * The qualified state: nothing is uncovered, at least one leg relies on a watcher, and the
   * backup exists. Never the plain green: it says what can still go wrong.
   */
  watchedSafe: boolean;
  /** For the qualified state: the earliest "come back before" over the covered legs. */
  watchedComeBack: bigint | null;
  /** The earliest chain second by which the tab must have acted for an at-risk leg. */
  deadline: bigint | null;
  /** Green: every leg is Ready, Claimed or Refunded (or only pending), the backup exists, and the page can see the chain. */
  safeToClose: boolean;
  /** Ready legs: "come back before this time to refund if the maker does not complete". */
  comeBackBefore: bigint | null;
  /** A sell-XMR leg is open: closing delays the swap and can cost the deposit. */
  sellOpen: Tracked[];
  /** Open legs whose keys the loaded seed does not derive, or with no seed loaded: the tab cannot act for them. */
  blind: Tracked[];
  /** Legs still in progress in any way. */
  open: Tracked[];
}

const settled = (t: Tracked): boolean => {
  if (t.view === null) return t.pending === null;
  if (t.decision !== null && t.decision.do === 'done') return true;
  // A swap whose keys this seed does not derive cannot be acted on, but one that is already settled
  // with nothing left for the taker to collect needs no action: a completed sell, or any refund.
  // (A deposit on hold is returned by a keyless call anyone may send.)
  if (t.keys !== null) return false;
  if (t.view.state === SWAP_STATE.HOLD || t.view.state === SWAP_STATE.WITHHELD) return true;
  return t.view.state === SWAP_STATE.DONE && (t.view.direction === 1 || endedInRefund(t.view));
};

export function safetyOf(engine: EngineState, backedUp: boolean): Safety {
  const open = engine.swaps.filter((t) => !settled(t));
  const atRisk = open.filter((t) => t.atRisk);
  const covered = atRisk.filter((t) => t.watched);
  const uncovered = atRisk.filter((t) => !t.watched);
  const deadline = uncovered.reduce<bigint | null>((min, t) => (t.refundDeadline !== null && (min === null || t.refundDeadline < min) ? t.refundDeadline : min), null);
  const sellOpen = open.filter((t) => t.view?.direction === 1 && t.view.state !== SWAP_STATE.PENDING && t.view.state !== SWAP_STATE.DONE);
  const blind = open.filter((t) => t.keys === null);
  let comeBack: bigint | null = null;
  for (const t of open) {
    if (t.view && t.view.direction === 0 && t.view.state === SWAP_STATE.READY) {
      const d = deadlinesOf(t.view.chain, t.view);
      const before = d.tFinal - d.margin;
      if (comeBack === null || before < comeBack) comeBack = before;
    }
  }
  const chainsSeen = open.every((t) => engine.health[t.chain].ok);
  // A state that is in a block but not final is not something to call safe: the tab has not acted on it yet.
  const unfinal = open.some((t) => t.pending !== null);
  const safeToClose = engine.ready && backedUp && !unfinal && open.length > 0 && atRisk.length === 0 && sellOpen.length === 0 && blind.length === 0 && chainsSeen;
  const watchedSafe = engine.ready && backedUp && !unfinal && covered.length > 0 && uncovered.length === 0 && sellOpen.length === 0 && blind.length === 0 && chainsSeen;
  const watchedComeBack = covered.reduce<bigint | null>((min, t) => {
    const b = comeBackBefore(t.view!);
    return min === null || b < min ? b : min;
  }, null);
  return { atRisk, covered, uncovered, watchedSafe, watchedComeBack, deadline, safeToClose, comeBackBefore: comeBack, sellOpen, blind, open };
}

/** Chain time now, extrapolated from the last read with the local clock. For display only; decisions use a fresh read. */
export function chainNow(engine: EngineState, chain: 'solana' | 'ethereum', nowMs: number = Date.now()): bigint | null {
  const c = engine.clock[chain];
  if (!c) return null;
  return c.chain + BigInt(Math.max(0, Math.floor((nowMs - c.at) / 1000)));
}

/** Seconds left until the banner's deadline, on the chain's clock. */
export function secondsLeft(engine: EngineState, s: Safety, nowMs: number = Date.now()): number | null {
  if (s.deadline === null || s.uncovered.length === 0) return null;
  const now = chainNow(engine, s.uncovered[0]!.chain, nowMs);
  return now === null ? null : Math.max(0, Number(s.deadline - now));
}

/** The tab title while a leg is at risk (SPEC 8.5 item 3). */
export const riskTitle = (left: number | null): string => (left === null ? 'Do not close this tab' : `Do not close this tab: ${formatClock(left)} left`);
export const BASE_TITLE = 'XMR atomic swaps';
