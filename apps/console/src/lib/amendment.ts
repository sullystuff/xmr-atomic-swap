/**
 * Amendment 1 (SPEC 11): the protocol's beta caps as the maker sees them, and what a freeze
 * window costs. Pure functions; amounts stay bigint.
 */
import { MAX_FREEZE_SECS, MIN_FREEZE_SECS, type Market } from '@xmrswap/protocol';
import type { MarketCaps, StatusResponse, SwapSummary } from '@xmrswap/protocol/daemon-api';
import { fmtMarketAmount } from './format.js';

// ------------------------------------------------------------------ caps (SPEC 11.1)

export type CapsKind =
  /** The chain could not be read. */
  | 'unknown'
  /** The switch is off: nothing is checked. */
  | 'off'
  /** Switch on and every cap zero: a fresh deployment. Nothing can open yet. */
  | 'not_open'
  /** The open value has reached `max_open`: no new swap until one exits. */
  | 'reached'
  /** Open, with headroom. */
  | 'open';

export interface CapsState {
  market: Market;
  kind: CapsKind;
  maxSwap: bigint;
  maxOpen: bigint;
  openValue: bigint;
  headroom: bigint;
  /** The configuration is frozen with the caps on: they stay as they are for good. */
  frozen: boolean;
  /** One plain sentence. */
  text: string;
}

export function capsState(m: MarketCaps): CapsState {
  const c = m.caps;
  const zero = { maxSwap: 0n, maxOpen: 0n, openValue: 0n, headroom: 0n, frozen: false };
  if (c === null) return { market: m.market, kind: 'unknown', ...zero, text: 'The caps could not be read from the chain. Until they can, assume nothing new can open.' };
  const maxSwap = BigInt(c.max_swap);
  const maxOpen = BigInt(c.max_open);
  const openValue = BigInt(c.open_value);
  // Recomputed rather than trusted: `max(0, max_open − open_value)`.
  const headroom = maxOpen > openValue ? maxOpen - openValue : 0n;
  const base = { market: m.market, maxSwap, maxOpen, openValue, headroom, frozen: c.frozen };
  const f = (v: bigint): string => fmtMarketAmount(m.market, v);
  const forGood = c.frozen ? ' The protocol’s configuration is frozen, so these caps stay as they are for good.' : '';
  if (!c.on) return { ...base, kind: 'off', text: `The protocol’s beta caps are switched off: no limit is checked. ${f(openValue)} is open.` };
  if (maxSwap === 0n && maxOpen === 0n) return { ...base, kind: 'not_open', text: `The protocol is not open yet: its beta caps are still at zero, so no swap can start. This is how a fresh deployment begins; the protocol’s admin opens it by setting caps.${forGood}` };
  if (headroom === 0n) return { ...base, kind: 'reached', text: `The protocol’s beta cap is reached: ${f(openValue)} of ${f(maxOpen)} open. No new swap can start until one settles.${forGood}` };
  return { ...base, kind: 'open', text: `${f(openValue)} of ${f(maxOpen)} open; ${f(headroom)} of headroom. Largest single swap: ${f(maxSwap)}.${forGood}` };
}

/** Why an offer's capacity is what it is, in the maker's words: the protocol's cap is never called the maker's own limit. */
export function capacityLimitText(limit: 'inventory' | 'max_swap' | 'max_open' | 'config', caps: CapsState | undefined, market: Market): string {
  const f = (v: bigint): string => fmtMarketAmount(market, v);
  switch (limit) {
    case 'inventory':
      return 'limited by your unlocked outputs';
    case 'config':
      return 'limited by your own settings (daily cap, exposure limits or largest swap)';
    case 'max_swap':
      return caps && caps.kind !== 'unknown' ? `limited by the protocol’s beta cap on one swap: ${f(caps.maxSwap)}` : 'limited by the protocol’s beta cap on one swap';
    case 'max_open':
      if (!caps || caps.kind === 'unknown') return 'limited by the protocol’s beta cap on open value';
      if (caps.kind === 'not_open') return 'the protocol is not open yet: its beta caps are at zero';
      if (caps.kind === 'reached') return `the protocol’s beta cap is reached: ${f(caps.openValue)} of ${f(caps.maxOpen)} open`;
      return `limited by the protocol’s beta cap: ${f(caps.openValue)} of ${f(caps.maxOpen)} open, ${f(caps.headroom)} left`;
  }
}

// ------------------------------------------------------------------ freeze window (SPEC 11.6)

export const MIN_FREEZE_HOURS = MIN_FREEZE_SECS / 3_600;
export const MAX_FREEZE_HOURS = MAX_FREEZE_SECS / 3_600;

export interface FreezeExposure {
  /** `W_z` in seconds; 0 = no watcher accepted. */
  windowSecs: number;
  /** Without a freeze the claim-without-ready opens `D_c` after the notice. */
  withoutSecs: number;
  /** With a freeze it opens at `T_ff = max(t_Z + W_z, T_co)`; a freeze just before `T_co` gives `D_c + W_z` after the notice. */
  worstSecs: number;
  /** How many times longer, rounded to one decimal (17 at `D_c` = 1.5 h and `W_z` = 24 h). */
  times: number;
}

/**
 * The longest the claimer can be made to wait after the lock notice before it may claim without
 * ready. Selling XMR (direction A) the claimer is the maker and the wait locks its XMR; buying
 * XMR (direction B) the claimer is the taker and the wait is the taker's, at the maker's option.
 */
export function freezeExposure(claimDelaySecs: number, freezeWindowSecs: number): FreezeExposure {
  const w = Math.max(0, freezeWindowSecs);
  const worst = claimDelaySecs + w;
  return { windowSecs: w, withoutSecs: claimDelaySecs, worstSecs: worst, times: claimDelaySecs > 0 ? Math.round((worst / claimDelaySecs) * 10) / 10 : 1 };
}

/** `T_ff = max(t_Z + W_z, T_co)`: when the claimer may claim a frozen swap (as the model and both chains compute it). */
export const frozenFinal = (tFreeze: number, freezeWindowSecs: number, tClaimOpen: number): number => Math.max(tFreeze + freezeWindowSecs, tClaimOpen);

/** Swap outcomes that mean the swap was frozen at some point. */
const FROZEN_OUTCOMES = new Set(['refunds_after_freeze', 'backouts_after_freeze', 'claims_after_freeze']);
/** How often each taker's swaps with this maker were frozen, from the swaps the daemon lists. */
export function freezeCounts(swaps: readonly Pick<SwapSummary, 'taker' | 'state' | 'outcome'>[]): Map<string, { frozen: number; swaps: number }> {
  const out = new Map<string, { frozen: number; swaps: number }>();
  for (const s of swaps) {
    const e = out.get(s.taker) ?? { frozen: 0, swaps: 0 };
    e.swaps += 1;
    if (s.state === 'FROZEN' || (s.outcome !== null && FROZEN_OUTCOMES.has(s.outcome))) e.frozen += 1;
    out.set(s.taker, e);
  }
  return out;
}

// ------------------------------------------------------------------ daemon health, for the watcher warning

/** Why the daemon counts as degraded, or an empty list when it does not. */
export function degradedReasons(status: Pick<StatusResponse, 'chains' | 'monero' | 'needs_review'>): string[] {
  const out: string[] = [];
  for (const c of status.chains) if (!c.connected) out.push(`${c.chain === 'solana' ? 'Solana' : 'Ethereum'} is not connected`);
  if (!status.monero.agree) out.push('the Monero nodes disagree');
  if (status.monero.nodes.some((n) => !n.ok)) out.push('a Monero node is down');
  if (!status.monero.wallet_rpc_ok) out.push('the inventory wallet cannot be reached');
  return out;
}
