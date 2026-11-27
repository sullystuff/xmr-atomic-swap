/**
 * The protocol's beta limits as the page words them (SPEC 11.1). Two limits must never be
 * confused: a maker's own (another maker may still take the size) and the deployment's cap
 * (nobody can, until open value is freed or the admin raises it). Everything here is the second.
 * Caps gate only new swaps: nothing here ever applies to a swap that is already open.
 */
import type { AssetCaps, Market } from '@xmrswap/protocol';
import { CapReached, type Pricing, capRoom, largestUnderCaps } from '@xmrswap/sdk';
import { ASSET_LABEL, formatAsset, formatXmrAmount } from './format.js';

/** `off`: nothing is checked. `closed`: the switch is on and a cap is zero, so nothing can open. */
export type CapsState = 'off' | 'closed' | 'open' | 'full';
export function capsState(caps: AssetCaps | undefined): CapsState {
  if (!caps || !caps.on) return 'off';
  if (caps.maxSwap === 0n || caps.maxOpen === 0n) return 'closed';
  return caps.openValue >= caps.maxOpen ? 'full' : 'open';
}

export const NOT_OPEN_TITLE = 'The protocol is not open yet';
export const notOpenText = (market: Market): string =>
  `New ${ASSET_LABEL[market]} swaps are switched off on-chain for now: the protocol's limits for this asset are set to zero. This is not an error and nothing is wrong with your wallet or the offers. Swaps that are already open are not affected; they can always be completed or refunded.`;

/** "At most 5.00 SOL per swap. 12.00 of 50.00 SOL open across all swaps; room for 38.00 SOL." */
export function capsLine(caps: AssetCaps | undefined, market: Market): string | null {
  const st = capsState(caps);
  if (st === 'off' || !caps) return null;
  const a = ASSET_LABEL[market];
  if (st === 'closed') return NOT_OPEN_TITLE;
  const room = capRoom(caps)!;
  return `Beta limits: at most ${formatAsset(caps.maxSwap, market)} ${a} per swap. ${formatAsset(caps.openValue, market)} of ${formatAsset(caps.maxOpen, market)} ${a} is open across all swaps right now, leaving room for ${formatAsset(room.headroom, market)} ${a}.`;
}

/**
 * Why an amount is refused by the caps, in plain words, with the largest size that still fits
 * when there is one. `price` is the offer's own pricing; `lo`/`hi` its size limits.
 */
export function capRefusalText(kind: CapReached['kind'], caps: AssetCaps, market: Market, direction: 0 | 1, fit?: { price: (xmr: bigint) => Pricing; lo: bigint; hi: bigint }): string {
  const a = ASSET_LABEL[market];
  if (capsState(caps) === 'closed') return `${NOT_OPEN_TITLE}. ${notOpenText(market)}`;
  const room = capRoom(caps);
  let best: string | null = null;
  if (fit) {
    try {
      const l = largestUnderCaps(caps, direction, fit.price, fit.lo, fit.hi);
      best = l ? ` The largest this offer can take under the limit right now is ${formatXmrAmount(l.xmr, 4)} XMR.` : ' Not even this offer\'s smallest size fits right now.';
    } catch {
      best = null;
    }
  }
  if (kind === 'SwapCapExceeded') return `This is above the protocol's beta limit of ${formatAsset(caps.maxSwap, market)} ${a} per swap. It is a limit of the protocol, not of this maker: no offer can take a larger single swap.${best ?? ''} For more, use the large-swap tool, which splits an order into legs.`;
  return `The protocol's beta limit on the total value open at once is nearly used up: ${formatAsset(caps.openValue, market)} of ${formatAsset(caps.maxOpen, market)} ${a} is open, leaving room for ${formatAsset(room?.headroom ?? 0n, market)} ${a}${direction === 1 ? ' (your deposit counts too)' : ''}. It is a limit of the protocol, not of this maker; room returns as other swaps complete.${best ?? ''}`;
}

/** The message for a cap refusal that came back from an open (the SDK's `CapReached`, or the chain's own error name). */
export function capErrorText(e: unknown, caps: AssetCaps | undefined, market: Market, direction: 0 | 1): string | null {
  const kind = e instanceof CapReached ? e.kind : /SwapCapExceeded/.test(String((e as { code?: string })?.code ?? e)) ? 'SwapCapExceeded' : /OpenCapExceeded/.test(String((e as { code?: string })?.code ?? e)) ? 'OpenCapExceeded' : null;
  if (!kind) return null;
  const c: AssetCaps = e instanceof CapReached ? { on: true, maxSwap: e.maxSwap, maxOpen: (caps?.maxOpen ?? e.headroom) as bigint, openValue: caps ? caps.openValue : 0n } : (caps ?? { on: true, maxSwap: 0n, maxOpen: 0n, openValue: 0n });
  return `${capRefusalText(kind, c, market, direction)} Nothing was locked.`;
}
