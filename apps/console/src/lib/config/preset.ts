/**
 * The "wXMR only" setup as a change to a configuration: quote from the wXMR pool and refill
 * through the wXMR bridge alone. It only computes the change; nothing is applied or saved here.
 */
import type { Market } from '@xmrswap/protocol';
import type { MarketDirection } from '@xmrswap/protocol/daemon-api';
import { DIRECTIONS, MARKETS, POOL_SOURCES, VENUES, type PoolSource } from './schema.js';
import { getPath, setPath, type Toml } from './toml.js';
import { missingPrice, poolQuote, poolState, resolveOffer, type MissingPrice } from './validate.js';

export const WXMR_ONLY_LABEL = 'Quote from the wXMR pool and refill through the wXMR bridge only';

export interface WxmrOnlyPlan {
  /** The configuration with the preset applied. */
  next: Toml;
  /** Enabled offers switched to a pool as their only source, and which pool. */
  priced: { market: Market; direction: MarketDirection; pool: PoolSource; quote: 'usdc' | 'sol' }[];
  /** Enabled offers left as they are, because no pool alone can price their market. */
  untouched: { market: Market; direction: MarketDirection; missing: MissingPrice }[];
  venuesSwitchedOff: string[];
  crossChainSwitchedOff: boolean;
  /** No pool section is in the file at all: its addresses have to be entered before a pool can price anything. */
  noPool: boolean;
}

/** The pool in the file that prices this market by itself. A pool the file does not have is never proposed: the daemon refuses a source with no section. */
function poolAlone(market: Market, cfg: Toml): PoolSource | null {
  const prices = (p: PoolSource): boolean => missingPrice(market, p, [p], cfg) === null;
  return POOL_SOURCES.find((p) => poolState(cfg, p) !== 'absent' && prices(p)) ?? null;
}

export function wxmrOnlyPlan(cfg: Toml): WxmrOnlyPlan {
  let next = cfg;
  const priced: WxmrOnlyPlan['priced'] = [];
  const untouched: WxmrOnlyPlan['untouched'] = [];
  for (const market of MARKETS) {
    for (const direction of DIRECTIONS) {
      const o = resolveOffer(cfg, market, direction, { blobEndpoint: null });
      if (!o.wanted) continue;
      const pool = poolAlone(market, cfg);
      if (pool === null) {
        untouched.push({ market, direction, missing: missingPrice(market, 'wxmr_pool', ['wxmr_pool'], cfg) as MissingPrice });
        continue;
      }
      const base = `markets.${market}.${direction}`;
      priced.push({ market, direction, pool, quote: poolQuote(cfg, pool) });
      next = setPath(next, `${base}.source`, pool);
      next = setPath(next, `${base}.fallbacks`, undefined);
      // No cross-check for this market only: the setting for all markets is left for the others.
      const global = getPath(cfg, 'pricing.cross_check');
      const globalSet = typeof global === 'string' && global !== '' && global !== 'none';
      next = setPath(next, `${base}.cross_check`, globalSet ? 'none' : undefined);
    }
  }

  const venuesSwitchedOff: string[] = [];
  for (const v of VENUES) {
    const on = getPath(cfg, `rebalance.venues.${v}.enabled`) === true;
    if (v === 'wxmr_bridge') {
      if (!on) next = setPath(next, `rebalance.venues.${v}.enabled`, true);
    } else if (on) {
      venuesSwitchedOff.push(v);
      next = setPath(next, `rebalance.venues.${v}.enabled`, false);
    }
  }
  next = setPath(next, 'rebalance.routing.priority', ['wxmr_bridge']);
  // Cross-chain USDC moves need another venue; with the bridge alone they cannot run.
  const crossChainSwitchedOff = getPath(cfg, 'rebalance.cross_chain.enabled') === true;
  if (crossChainSwitchedOff) next = setPath(next, 'rebalance.cross_chain.enabled', false);
  return { next, priced, untouched, venuesSwitchedOff, crossChainSwitchedOff, noPool: POOL_SOURCES.every((p) => poolState(cfg, p) === 'absent') };
}
