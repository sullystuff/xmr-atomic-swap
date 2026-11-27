/**
 * What a swap of a given size costs against an offer or a quote (SPEC 3.1 arithmetic). Rounding
 * (`payAmount`, `receiveAmount`, `depositOf`, `feeOf`) and the tier lookup are the core's.
 */
import { type EthQuote, depositOf, feeOf, payAmount, receiveAmount, tierValue as coreTierValue } from '@xmrswap/core-wasm';
import { type AssetCaps, CHAIN_CONSTS, type ChainName, type Offer, capsRefusal } from '@xmrswap/protocol';
import { SdkError } from '../util.js';
import { CapReached } from './caps.js';

/**
 * The value of the highest used tier with `xmr >= above[i]` (the core's `tierValue`). Tiers are
 * well formed when `above[0] == 0`, tier 0 is used (nonzero value), used thresholds strictly
 * increase and unused tiers trail. Anything else throws with code `TiersInvalid`.
 */
export function tierValue(above: readonly bigint[], values: readonly bigint[], xmr: bigint): bigint {
  if (above.length !== 3 || values.length !== 3) throw new SdkError('TiersInvalid', 'three tiers are expected');
  return coreTierValue([above[0]!, above[1]!, above[2]!], [values[0]!, values[1]!, values[2]!], xmr);
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
  // Both contracts refuse a swap of nothing: a dust take that rounds to zero would lock XMR against no escrow.
  if (xmr === 0n || amount === 0n) throw new SdkError('AmountOutOfRange', 'a swap of zero XMR, or one whose amount rounds to zero, is refused');
  return { price: p, depth, amount, deposit: depositOf(amount, depBps), fee: feeOf(amount, CHAIN_CONSTS[chain].feeBps) };
}

/** With `caps`, a priced size the deployment's caps refuse throws `CapReached` (never a maker-limit error). */
function capped(p: Pricing, direction: number, caps: AssetCaps | undefined): Pricing {
  if (caps) {
    const refusal = capsRefusal(caps, direction === 0 ? 0 : 1, p.amount, p.deposit);
    if (refusal) throw new CapReached(refusal, caps);
  }
  return p;
}

/**
 * Price a size against a Solana offer. Throws `AmountOutOfRange` outside `min_xmr..max_xmr` and
 * `CapacityExceeded` above `capacity_xmr` (what the program checks at lock): the **maker's**
 * limits. With `caps` (the asset's, from `SolanaClient.getCaps`) a size over the per-swap cap or
 * the remaining open value throws `CapReached` (`SwapCapExceeded` / `OpenCapExceeded`): the
 * **deployment's** limit, which no other maker can lift.
 */
export function priceOffer(o: Offer, xmr: bigint, caps?: AssetCaps): Pricing {
  if (xmr < o.minXmr || xmr > o.maxXmr) throw new SdkError('AmountOutOfRange', `${xmr} piconero is outside the offer's ${o.minXmr}..${o.maxXmr}`);
  if (xmr > o.capacityXmr) throw new SdkError('CapacityExceeded', `${xmr} piconero is over the offer's capacity ${o.capacityXmr}`);
  return capped(price('solana', o.direction, xmr, o.priceAbove, o.prices, o.depthAbove, [...o.depths], o.depBps), o.direction, caps);
}

/** Price a size against an Ethereum quote. Throws `AmountOutOfRange` outside `minXmr..maxXmr`, and `CapReached` against `caps` (`EthereumClient.capsOf(token)`). */
export function priceEthQuote(q: EthQuote, xmr: bigint, caps?: AssetCaps): Pricing {
  if (xmr < q.minXmr || xmr > q.maxXmr) throw new SdkError('AmountOutOfRange', `${xmr} piconero is outside the quote's ${q.minXmr}..${q.maxXmr}`);
  return capped(price('ethereum', q.direction, xmr, q.tierXmr, q.tierPrice, q.depthXmr, q.depth, q.depositBps), q.direction, caps);
}

/** What the taker ends up with on a completed swap, in the escrowed asset's base units (direction B), after the fee and with its deposit back. */
export const takerReceives = (p: Pricing): bigint => p.amount - p.fee;
