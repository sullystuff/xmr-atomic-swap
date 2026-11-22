/**
 * Address allow-list (DESIGN "Safety controls"): refills pay out, and refund, only to the
 * maker's own XMR, SOL and ETH addresses. It is enforced here, in two places that do not rely
 * on each other: the `Rebalancer` checks every request, and every adapter built by
 * `createAdapters` is wrapped by `guardAdapter`, which checks again at `quote` and `execute`.
 */
import { ADDRESS_FAMILY } from './assets.js';
import type { AssetId, ExecContext, RefillRequest, VenueAdapter, VenueQuote } from './types.js';

export interface Allowlist { xmr: readonly string[]; sol: readonly string[]; eth: readonly string[] }

export class AllowlistError extends Error {
  constructor(message: string) { super(message); this.name = 'AllowlistError'; }
}

export function isAllowed(list: Allowlist, asset: AssetId, address: string): boolean {
  const family = ADDRESS_FAMILY[asset];
  if (typeof address !== 'string' || address === '') return false;
  // EVM addresses compare without case (checksummed and lower-case forms are one address); the others are case-sensitive.
  return family === 'eth' ? list.eth.some((a) => a.toLowerCase() === address.toLowerCase()) : list[family].includes(address);
}

export function assertAllowed(list: Allowlist, asset: AssetId, address: string, role: 'payout' | 'refund'): void {
  if (!isAllowed(list, asset, address)) {
    throw new AllowlistError(`${role} address for ${asset} is not on the ${ADDRESS_FAMILY[asset]} allow-list; refills pay out only to the maker's own addresses`);
  }
}

/** The payout address receives `to`; the refund address receives `from` back. */
export function assertRequestAllowed(list: Allowlist, req: RefillRequest): void {
  assertAllowed(list, req.to, req.payoutAddress, 'payout');
  assertAllowed(list, req.from, req.refundAddress, 'refund');
}

/** Wraps an adapter so that no quote is priced and no refill is executed for an address off the list. */
export function guardAdapter<A extends VenueAdapter>(adapter: A, list: Allowlist): A {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'quote') return async (req: RefillRequest) => { assertRequestAllowed(list, req); return target.quote(req); };
      if (prop === 'execute') return async (quote: VenueQuote, ctx: ExecContext) => { assertRequestAllowed(list, quote.request); return target.execute(quote, ctx); };
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
