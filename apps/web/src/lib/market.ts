/**
 * Offers as the interface sees them (SPEC 8.2 "Offers"): every maker's published offers and
 * verified Ethereum quotes in one row shape, ranked by completed volume, each with the maker's
 * merged cross-chain history; the offer-specific warnings shown before locking (SPEC 8.5 item
 * 10); and the reference price the rate is compared with.
 */
import type { EthQuote } from '@xmrswap/core-wasm';
import { type Address, type ChainName, ETH_NATIVE, MARKET_CHAIN, type Market, type Offer, PICONERO_PER_XMR, takerDepthFor } from '@xmrswap/protocol';
import { type EthereumClient, type LinkMemory, type MakerProfile, type Pricing, type RouterOffer, type SolanaClient, hex, hex0x, listMakerProfiles, listOffers, priceEthQuote, priceOffer, tierValue, verifiedBoardQuotes } from '@xmrswap/sdk';
import { ASSET_LABEL, bpsPercent, formatAsset, formatDuration, formatTime } from './format.js';
import type { Settings } from './settings.js';

export interface OfferRow {
  /** Offer account (Solana) or `<maker PDA>:eth:<slot>`. */
  id: string;
  chain: ChainName;
  market: Market;
  /** 0 = the taker buys XMR; 1 = the taker sells XMR. */
  direction: 0 | 1;
  maker: MakerProfile;
  /** 0 auto-accept, 1 approve within a window, 2 approved in advance. */
  mode: number;
  /** `W_a`, seconds. Only matters when the swap can wait for approval. */
  approvalWindow: number;
  /** Whether a lock against this offer starts pending. */
  startsPending: boolean;
  depBps: number;
  /** `D_c`: seconds after the notice until the maker can claim without ready. */
  claimDelay: number;
  noticeWindow: number;
  claimWindow: number;
  finalWindow: number;
  minXmr: bigint;
  maxXmr: bigint;
  capacityXmr: bigint;
  /** Price of the smallest tier, base units per XMR. */
  basePrice: bigint;
  /** Completed volume of this maker in this market's asset (the ranking key). */
  volume: bigint;
  /** Why a lock would be refused right now, or `null`. */
  problem: string | null;
  price(xmr: bigint): Pricing;
  depthFor(xmr: bigint): number;
  source: { offer: Offer } | { quote: EthQuote; sig: Uint8Array; slot: number };
}

export const marketOf = (chain: ChainName, asset: string | number): Market => {
  if (chain === 'solana') return Number(asset) === 0 ? 'sol' : 'usdc_sol';
  return String(asset).toLowerCase() === ETH_NATIVE ? 'eth' : 'usdc_eth';
};

const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  Paused: 'The maker has paused new swaps.',
  OfferDisabled: 'The maker switched this offer off.',
  OfferStale: 'The maker has not refreshed this offer; it has lapsed.',
  TermsChanged: 'The offer changed since you looked at it.',
  SeqTooOld: 'The offer changed since you looked at it.',
};

export function solanaRow(pubkey: string, offer: Offer, maker: MakerProfile, problem: string | null): OfferRow {
  const market = marketOf('solana', offer.asset);
  const direction = offer.direction === 0 ? 0 : 1;
  // Outside window mode a buy starts ACTIVE at once; a sell always waits for the maker's funds.
  const startsPending = offer.mode === 1 || direction === 1;
  return {
    id: pubkey,
    chain: 'solana',
    market,
    direction,
    maker,
    mode: offer.mode,
    approvalWindow: offer.mode === 1 ? offer.wA : direction === 1 ? offer.wN : 0,
    startsPending,
    depBps: offer.depBps,
    claimDelay: offer.dC,
    noticeWindow: offer.wN,
    claimWindow: offer.wC,
    finalWindow: offer.wF,
    minXmr: offer.minXmr,
    maxXmr: offer.maxXmr,
    capacityXmr: offer.capacityXmr,
    basePrice: offer.prices[0] ?? 0n,
    volume: maker.solana.volume[offer.asset] ?? 0n,
    problem: problem ? (PROBLEM_TEXT[problem] ?? problem) : null,
    price: (xmr) => priceOffer(offer, xmr),
    depthFor: (xmr) => Number(tierValue(offer.depthAbove, [...offer.depths].map(BigInt), xmr)),
    source: { offer },
  };
}

export function ethereumRow(maker: MakerProfile, slot: number, quote: EthQuote, sig: Uint8Array, usdc: Address | null, volume: bigint, now: bigint): OfferRow {
  const token = hex0x(quote.token);
  const market: Market = token === ETH_NATIVE ? 'eth' : 'usdc_eth';
  const left = Number(quote.validUntil - now);
  return {
    id: `${maker.pda}:eth:${slot}`,
    chain: 'ethereum',
    market,
    direction: quote.direction === 0 ? 0 : 1,
    maker,
    mode: quote.approvalMode,
    approvalWindow: quote.approvalWindow,
    // Every Ethereum swap is approved explicitly (SPEC 3.8).
    startsPending: true,
    depBps: quote.depositBps,
    claimDelay: quote.claimDelay,
    noticeWindow: quote.noticeWindow,
    claimWindow: quote.claimWindow,
    finalWindow: quote.finalWindow,
    minXmr: quote.minXmr,
    maxXmr: quote.maxXmr,
    capacityXmr: quote.maxXmr,
    basePrice: quote.tierPrice[0],
    volume,
    problem: token !== ETH_NATIVE && usdc !== null && token.toLowerCase() !== usdc.toLowerCase() ? 'This quote names a token the contract does not accept.' : left < 36 ? 'This quote is about to expire.' : null,
    price: (xmr) => priceEthQuote(quote, xmr),
    depthFor: (xmr) => priceEthQuote(quote, xmr).depth,
    source: { quote, sig, slot },
  };
}

export interface RegistrySnapshot {
  makers: MakerProfile[];
  rows: OfferRow[];
  /** Board slots that were not shown, and why (for the status page). */
  discarded: { maker: string; slot: number; reason: string }[];
  now: { solana: bigint; ethereum: bigint | null };
}

/** Read the whole registry: makers with merged history, every Solana offer, every verified Ethereum quote. */
export async function readRegistry(solana: SolanaClient, ethereum: EthereumClient | null, settings: Pick<Settings, 'contract' | 'ethereumChainId'>, memory?: LinkMemory): Promise<RegistrySnapshot> {
  const nowSol = await solana.chainTime();
  let eth = ethereum;
  let nowEth: bigint | null = null;
  if (eth) {
    try {
      nowEth = await eth.chainTime('latest');
    } catch {
      // The Ethereum RPC is down: show the Solana side alone rather than nothing.
      eth = null;
    }
  }
  const makers = await listMakerProfiles(solana, eth, { solana: nowSol, ethereum: nowEth ?? nowSol }, memory);
  const rows: OfferRow[] = [];
  for (const asset of [0, 1]) for (const direction of [0, 1]) for (const o of await listOffers(solana, makers, { asset, direction }, nowSol)) rows.push(solanaRow(o.pubkey, o.offer, o.maker, o.problem));
  const discarded: RegistrySnapshot['discarded'] = [];
  if (eth && nowEth !== null && /^0x[0-9a-fA-F]{40}$/.test(settings.contract)) {
    const d = { chainId: settings.ethereumChainId, contract: settings.contract as Address };
    let usdc: Address | null = null;
    try {
      usdc = await eth.usdc('latest');
    } catch {
      usdc = null;
    }
    for (const m of makers) {
      if (!m.ethereum) continue;
      const board = await verifiedBoardQuotes(solana, m, d, nowEth);
      for (const x of board.discarded) discarded.push({ maker: m.pda, ...x });
      for (const q of board.quotes) {
        let volume = 0n;
        try {
          volume = (await eth.volumeOf(m.ethereum.address, hex0x(q.quote.token) as Address, 'latest')).volume;
        } catch {
          volume = 0n;
        }
        rows.push(ethereumRow(m, q.slot, q.quote, q.sig, usdc, volume, nowEth));
      }
    }
  }
  return { makers, rows, discarded, now: { solana: nowSol, ethereum: nowEth } };
}

export interface OfferFilter {
  market: Market;
  direction: 0 | 1;
  /** `null` = any approval mode. */
  mode: number | null;
}

/** The rows of one market and direction, ranked by the maker's completed volume (then completed swaps, then price). */
export function rankRows(rows: readonly OfferRow[], f: OfferFilter): OfferRow[] {
  return rows
    .filter((r) => r.market === f.market && r.direction === f.direction && (f.mode === null || r.mode === f.mode))
    .sort((a, b) => {
      if (a.volume !== b.volume) return a.volume > b.volume ? -1 : 1;
      const ca = a.maker.identity.reputation.completed;
      const cb = b.maker.identity.reputation.completed;
      if (ca !== cb) return cb - ca;
      // Buying XMR: cheaper first. Selling: the maker that pays more first.
      if (a.basePrice !== b.basePrice) return (a.basePrice < b.basePrice) === (f.direction === 0) ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

// ------------------------------------------------------------------ reference price

const decimalToScaled = (text: string, scale: number): bigint | null => {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  const v = BigInt(w) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale));
  return v > 0n ? v : null;
};

export interface Reference {
  /** Base units of the market's asset per 1 XMR. */
  price: bigint;
  source: 'settings' | 'median';
}

/**
 * The reference a rate is compared with. The page fetches no price feed (no third-party
 * request, ever): it is the user's own figures from Settings when present, otherwise the median
 * of the listed offers, labelled as such.
 */
export function referenceFor(market: Market, rows: readonly OfferRow[], s: Pick<Settings, 'refXmrUsd' | 'refSolUsd' | 'refEthUsd'>): Reference | null {
  const xmr = decimalToScaled(s.refXmrUsd, 8);
  const decimals = market === 'sol' ? 9 : market === 'eth' ? 18 : 6;
  if (xmr !== null) {
    if (market === 'usdc_sol' || market === 'usdc_eth') return { price: (xmr * 10n ** 6n) / 10n ** 8n, source: 'settings' };
    const asset = decimalToScaled(market === 'sol' ? s.refSolUsd : s.refEthUsd, 8);
    if (asset !== null) return { price: (xmr * 10n ** BigInt(decimals)) / asset, source: 'settings' };
  }
  const prices = rows.filter((r) => r.market === market && r.problem === null && r.basePrice > 0n).map((r) => r.basePrice).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (prices.length === 0) return null;
  return { price: prices[Math.floor((prices.length - 1) / 2)]!, source: 'median' };
}

/** `price` against the reference in basis points; positive = dearer for a buyer. */
export const vsReferenceBps = (price: bigint, ref: bigint): number => (ref === 0n ? 0 : Number(((price - ref) * 10_000n) / ref));

// ------------------------------------------------------------------ router input

export function routerOffer(r: OfferRow): RouterOffer {
  const rep = r.maker.identity.reputation;
  return {
    id: r.id,
    makerId: r.maker.pda,
    chain: r.chain,
    asset: r.chain === 'solana' && 'offer' in r.source ? r.source.offer.asset : 0,
    minXmr: r.minXmr,
    maxXmr: r.maxXmr,
    capacityXmr: r.capacityXmr,
    mode: r.mode,
    approvalWindow: r.approvalWindow,
    depBps: r.depBps,
    withholdRate: rep.withholdRate,
    faultRate: rep.perCompleted.faults,
    price: r.price,
  };
}

// ------------------------------------------------------------------ warnings before locking (SPEC 8.5 item 10)

export type OfferWarningId = 'approval-window' | 'claim-delay' | 'deposit' | 'usdc-freeze' | 'upgradable' | 'upgrade-unknown' | 'depth' | 'sell-terms';
export interface OfferWarning {
  id: OfferWarningId;
  title: string;
  text: string;
}

export interface UpgradeStatus {
  /** `true` = immutable; `false` = still upgradable; `null` = could not be read. */
  frozen: boolean | null;
  authority: string | null;
}

export interface WarningInput {
  row: Pick<OfferRow, 'chain' | 'market' | 'direction' | 'mode' | 'approvalWindow' | 'startsPending' | 'claimDelay' | 'depBps' | 'noticeWindow'>;
  pricing: Pick<Pricing, 'amount' | 'deposit' | 'depth'>;
  xmr: bigint;
  /** The user's own minimum depth from Settings (0 = none). */
  minDepth: number;
  upgrade: UpgradeStatus;
  /** Total XMR in flight including this swap, for the depth tiers (large swaps). Defaults to `xmr`. */
  inFlightXmr?: bigint;
}

/** Every offer-specific warning that applies, each stating its consequence. */
export function offerWarnings(i: WarningInput): OfferWarning[] {
  const out: OfferWarning[] = [];
  const asset = ASSET_LABEL[i.row.market];
  const amount = `${formatAsset(i.pricing.amount, i.row.market)} ${asset}`;
  const chain = i.row.chain === 'solana' ? 'Solana program' : 'Ethereum contract';
  if (i.row.direction === 0) {
    if (i.row.startsPending && i.row.approvalWindow > 60)
      out.push({
        id: 'approval-window',
        title: `This maker can take up to ${formatDuration(i.row.approvalWindow)} to approve`,
        text: `Your ${amount} is locked in escrow while you wait, for up to ${formatDuration(i.row.approvalWindow)}, and you cannot use it for anything else. If the maker rejects or does not answer, everything comes back to you with no fee. You can cancel at any time while it is pending.`,
      });
    out.push({
      id: 'claim-delay',
      title: `After ${formatDuration(i.row.claimDelay)} the maker can take your payment even if you have not confirmed`,
      text: `The clock starts when the maker announces its XMR lock. This tab checks that lock and refunds by itself if it does not check out, but only while it is open and connected. If it is closed, asleep or offline past that point and the lock was false, you lose your ${amount}.`,
    });
    if (i.pricing.deposit > 0n)
      out.push({
        id: 'deposit',
        title: `Deposit: ${bpsPercent(i.row.depBps)} of your payment`,
        text: `If you cancel or refund after approval, up to ${formatAsset(i.pricing.deposit, i.row.market)} ${asset} can be withheld for up to 60 days and half of it lost. The maker can never receive it; a maker that was provably late cannot withhold it.`,
      });
  } else {
    out.push({
      id: 'sell-terms',
      title: 'You pay XMR from your own wallet',
      text: `You post a deposit of ${formatAsset(i.pricing.deposit, i.row.market)} ${asset} now. Once the maker has funded the swap you will be shown one address: send one transaction for at least the exact amount to exactly that address before the time shown, from a wallet you control, not an exchange withdrawal. If you close this tab the swap unwinds when the maker refunds; your XMR is recoverable with the recovery file, and your deposit can be withheld for up to 60 days and half of it lost.`,
    });
  }
  if (i.row.market === 'usdc_sol' || i.row.market === 'usdc_eth')
    out.push({ id: 'usdc-freeze', title: 'USDC can be frozen by its issuer', text: 'The issuer can freeze USDC mid-swap; a freeze can strand funds. Nobody in this swap can undo a freeze, so USDC swaps carry a risk of loss that SOL and ETH swaps do not.' });
  if (i.upgrade.frozen === false)
    out.push({
      id: 'upgradable',
      title: `The ${chain} can still be upgraded`,
      text: `The upgrade key is held by the project owner${i.upgrade.authority ? ` (${i.upgrade.authority})` : ''}. Until the code is made immutable you are trusting that key holder not to change the rules; a malicious or mistaken upgrade could take the funds in escrow, and you could lose them.`,
    });
  else if (i.upgrade.frozen === null)
    out.push({ id: 'upgrade-unknown', title: `The upgrade status of the ${chain} could not be read`, text: 'Treat it as upgradable: whoever holds the upgrade key could change the rules and you could lose funds in escrow. Check the Status page before locking.' });
  const required = Math.max(i.minDepth, takerDepthFor(i.inFlightXmr ?? i.xmr));
  if (i.pricing.depth < required)
    out.push({
      id: 'depth',
      title: `Only ${i.pricing.depth} Monero confirmation${i.pricing.depth === 1 ? '' : 's'}; your minimum for this size is ${required}`,
      text: `The swap completes once the maker's XMR lock is ${i.pricing.depth} block${i.pricing.depth === 1 ? '' : 's'} deep. A Monero chain reorganisation deeper than that could undo the lock after you have paid, and you would lose your ${i.row.direction === 0 ? amount : 'XMR'}. Choose a smaller size, another offer, or accept the risk.`,
    });
  return out;
}

/** The rough duration of a swap, for display: approval, then (depth + 1) blocks of two minutes, as the router estimates it. */
export const expectedSecs = (row: Pick<OfferRow, 'startsPending' | 'approvalWindow'>, depth: number): number => (row.startsPending ? row.approvalWindow : 0) + (depth + 1) * 120;

/** The latest time the maker's claim-without-ready can open if everything takes as long as allowed: the "deadline time" of the confirmation screen. */
export function worstCaseClaimOpen(row: Pick<OfferRow, 'startsPending' | 'approvalWindow' | 'noticeWindow' | 'claimDelay'>, now: bigint): bigint {
  return now + BigInt((row.startsPending ? row.approvalWindow : 0) + row.noticeWindow + row.claimDelay);
}

export const describeDeadline = (t: bigint, now: bigint): string => formatTime(t, now);

export const xmrFor = (pay: bigint, price: bigint): bigint => (price > 0n ? (pay * PICONERO_PER_XMR) / price : 0n);
export const isUsdc = (m: Market): boolean => m === 'usdc_sol' || m === 'usdc_eth';
export const chainOfMarket = (m: Market): ChainName => MARKET_CHAIN[m];
export { hex };
