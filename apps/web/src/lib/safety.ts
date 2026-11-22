/**
 * The page-wide safety picture (SPEC 8.5): which legs are at risk, the deadline the standing
 * banner counts down to, and whether the green "Safe to close" state may be shown. Pure.
 */
import { SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf } from '@xmrswap/sdk';
import type { EngineState, Tracked } from './engine.js';
import { formatClock } from './format.js';

export interface Safety {
  /** Legs paying SOL, ETH or USDC that are locked and not yet Ready or Refunded. */
  atRisk: Tracked[];
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

const settled = (t: Tracked): boolean => t.view === null || (t.decision !== null && t.decision.do === 'done');

export function safetyOf(engine: EngineState, backedUp: boolean): Safety {
  const open = engine.swaps.filter((t) => !settled(t));
  const atRisk = open.filter((t) => t.atRisk);
  const deadline = atRisk.reduce<bigint | null>((min, t) => (t.refundDeadline !== null && (min === null || t.refundDeadline < min) ? t.refundDeadline : min), null);
  const sellOpen = open.filter((t) => t.view?.direction === 1 && t.view.state !== SWAP_STATE.PENDING && t.view.state !== SWAP_STATE.DONE);
  const blind = open.filter((t) => t.keys === null);
  let comeBackBefore: bigint | null = null;
  for (const t of open) {
    if (t.view && t.view.direction === 0 && t.view.state === SWAP_STATE.READY) {
      const d = deadlinesOf(t.view.chain, t.view);
      const before = d.tFinal - d.margin;
      if (comeBackBefore === null || before < comeBackBefore) comeBackBefore = before;
    }
  }
  const chainsSeen = open.every((t) => engine.health[t.chain].ok);
  const safeToClose = engine.ready && backedUp && open.length > 0 && atRisk.length === 0 && sellOpen.length === 0 && blind.length === 0 && chainsSeen;
  return { atRisk, deadline, safeToClose, comeBackBefore, sellOpen, blind, open };
}

/** Chain time now, extrapolated from the last read with the local clock. For display only; decisions use a fresh read. */
export function chainNow(engine: EngineState, chain: 'solana' | 'ethereum', nowMs: number = Date.now()): bigint | null {
  const c = engine.clock[chain];
  if (!c) return null;
  return c.chain + BigInt(Math.max(0, Math.floor((nowMs - c.at) / 1000)));
}

/** Seconds left until the banner's deadline, on the chain's clock. */
export function secondsLeft(engine: EngineState, s: Safety, nowMs: number = Date.now()): number | null {
  if (s.deadline === null || s.atRisk.length === 0) return null;
  const now = chainNow(engine, s.atRisk[0]!.chain, nowMs);
  return now === null ? null : Math.max(0, Number(s.deadline - now));
}

/** The tab title while a leg is at risk (SPEC 8.5 item 3). */
export const riskTitle = (left: number | null): string => (left === null ? 'Do not close this tab' : `Do not close this tab: ${formatClock(left)} left`);
export const BASE_TITLE = 'XMR atomic swaps';
