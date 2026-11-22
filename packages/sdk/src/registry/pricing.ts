/**
 * What a swap of a given size costs against an offer or a quote (SPEC 3.1 arithmetic). Rounding
 * (`payAmount`, `receiveAmount`, `depositOf`, `feeOf`) is the core's; only the tier lookup lives
 * here, because the frozen wasm API does not export it. It is tested against `amounts.json`.
 */
import { type EthQuote, depositOf, feeOf, payAmount, receiveAmount } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type ChainName, type Offer } from '@xmrswap/protocol';
import { SdkError } from '../util.js';

/**
 * The value of the highest used tier with `xmr >= above[i]`. Tiers are well formed when
 * `above[0] == 0`, tier 0 is used (nonzero value), used thresholds strictly increase and unused
 * tiers trail (the threshold of an unused tier is ignored). Anything else is `TiersInvalid`.
 */
export function tierValue(above: readonly bigint[], values: readonly bigint[], xmr: bigint): bigint {
  if (above.length !== 3 || values.length !== 3) throw new SdkError('TiersInvalid', 'three tiers are expected');
  if (above[0] !== 0n || values[0] === 0n) throw new SdkError('TiersInvalid', 'tier 0 must start at zero and be used');
  let value = values[0]!;
  let ended = false;
  for (let i = 1; i < 3; i++) {
    if (values[i] === 0n) {
      ended = true;
      continue;
    }
    if (ended) throw new SdkError('TiersInvalid', 'a used tier follows an unused one');
    if (above[i]! <= above[i - 1]!) throw new SdkError('TiersInvalid', 'tier thresholds must strictly increase');
    if (xmr >= above[i]!) value = values[i]!;
  }
  return value;
}

/** The terms a swap of `xmr` piconero gets. */
export interface Pricing {
  /** Asset base units per 1 XMR, from the size tier. */
  price: bigint;
  /** Monero confirmations required, from the depth tier. */
  depth: number;
  /** A: what the taker pays (`ceil`). B: what the maker escrows and the taker receives before the fee (`floor`). */
  amount: bigint;
  /** A: the part of `amount` that can be held. B: the take deposit the taker posts. */
  deposit: bigint;
  /** Deducted from the claimer's payout on a claim: the maker's in A, the taker's in B. */
  fee: bigint;
}

function price(chain: ChainName, direction: number, xmr: bigint, tierXmr: readonly bigint[], tierPrice: readonly bigint[], depthXmr: readonly bigint[], depths: readonly number[], depBps: number): Pricing {
  const p = tierValue(tierXmr, tierPrice, xmr);
  const depth = Number(tierValue(depthXmr, depths.map(BigInt), xmr));
  const amount = direction === 0 ? payAmount(xmr, p, chain) : receiveAmount(xmr, p, chain);
  return { price: p, depth, amount, deposit: depositOf(amount, depBps), fee: feeOf(amount, CHAIN_CONSTS[chain].feeBps) };
}

/**
 * Price a size against a Solana offer. Throws `AmountOutOfRange` outside `min_xmr..max_xmr` and
 * `CapacityExceeded` above `capacity_xmr` (what the program checks at lock).
 */
export function priceOffer(o: Offer, xmr: bigint): Pricing {
  if (xmr < o.minXmr || xmr > o.maxXmr) throw new SdkError('AmountOutOfRange', `${xmr} piconero is outside the offer's ${o.minXmr}..${o.maxXmr}`);
  if (xmr > o.capacityXmr) throw new SdkError('CapacityExceeded', `${xmr} piconero is over the offer's capacity ${o.capacityXmr}`);
  return price('solana', o.direction, xmr, o.priceAbove, o.prices, o.depthAbove, [...o.depths], o.depBps);
}

/** Price a size against an Ethereum quote. Throws `AmountOutOfRange` outside `minXmr..maxXmr`. */
export function priceEthQuote(q: EthQuote, xmr: bigint): Pricing {
  if (xmr < q.minXmr || xmr > q.maxXmr) throw new SdkError('AmountOutOfRange', `${xmr} piconero is outside the quote's ${q.minXmr}..${q.maxXmr}`);
  return price('ethereum', q.direction, xmr, q.tierXmr, q.tierPrice, q.depthXmr, q.depth, q.depositBps);
}

/** What the taker ends up with on a completed swap, in the escrowed asset's base units (direction B), after the fee and with its deposit back. */
export const takerReceives = (p: Pricing): bigint => p.amount - p.fee;
