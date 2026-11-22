/**
 * Offer engine (DESIGN "Maker tools", "Offer settings", "Offer updates and daily cost";
 * SPEC 7.1 `offers/`).
 *
 * Prices every market from its reference (`price.ts` holds DESIGN's formula), applies the
 * guardrails, sets each offer's capacity from unlocked ladder outputs, exposure limits and the
 * daily cap, and publishes: ONE `refresh_offers` transaction per interval covers every Solana
 * offer and every signed Ethereum quote. Key-pool refills, term changes and quote slots are
 * separate, occasional transactions. A stopped daemon's offers lapse through `valid_secs`.
 */
import { randomBytes } from 'node:crypto';
import { dleqProve, keyLeaf, merkleRoot, payAmount, receiveAmount, twinCommitments } from '@xmrswap/core-wasm';
import type { EthQuote } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type EthQuoteRefresh, type Market, type OfferRefresh, type OfferTerms, POOL_SLOTS, type QuoteRequest, type QuoteResponse, base58Decode } from '@xmrswap/protocol';
import type { OfferView } from '@xmrswap/protocol/daemon-api';
import { type EthDeployment, ProgramError, bytesEqual, encodeSignedQuote, hex0x, signEthQuote, solanaMakerShare, toBase64 } from '@xmrswap/sdk';
import { encodeEthQuoteCompact } from '@xmrswap/core-wasm';
import type { Alerts } from '../alerts/index.js';
import type { EthereumChain } from '../chains/ethereum.js';
import type { SolanaChain } from '../chains/solana.js';
import { type Config, REFRESH_CU, type ResolvedOffer, effectiveTerms, minClaimDelay, modeCode } from '../config/load.js';
import type { Keystore } from '../keystore/index.js';
import type { PriceEngine, Reference } from '../pricing/engine.js';
import { Risk } from '../risk/index.js';
import type { Store } from '../store/db.js';
import type { Journal } from '../store/journal.js';
import type { Shares } from '../swaps/shares.js';
import { type Bytes, Emitter, errMsg, hex, picoToXmr, unhex } from '../util.js';
import { type PricedOffer, priceOffer, xmrForUnits } from './price.js';

export interface ComputedOffer {
  offer: ResolvedOffer;
  ref: Reference;
  priced: PricedOffer;
  /** Publishable right now. */
  enabled: boolean;
  /** Why not, in plain words. */
  reason: string | null;
  capacityXmr: bigint;
  depthTiers: { aboveXmr: bigint; depth: number }[];
}

export interface OfferEngineOptions {
  store: Store;
  journal: Journal;
  alerts: Alerts;
  keystore: Keystore;
  shares: Shares;
  prices: PriceEngine;
  risk: Risk;
  config: () => Config;
  /** Unlocked-output capacity of the inventory. */
  capacity: () => { total: bigint; largest: bigint };
  /** XMR inventory in whole units, for the skew. */
  inventoryXmr: () => number;
  /** What the operator can still commit of a market's paying asset; `null` = unknown. */
  payingAvailable: (market: Market) => Promise<bigint | null>;
  solana: () => SolanaChain | null;
  ethereum: () => (EthereumChain & { deployment: EthDeployment }) | null;
}

const ETH_SLOT: Record<string, number> = { 'eth:sell_xmr': 0, 'eth:buy_xmr': 1, 'usdc_eth:sell_xmr': 2, 'usdc_eth:buy_xmr': 3 };
const solAsset = (market: string): number => (market === 'sol' ? 0 : 1);
const minBig = (...v: bigint[]): bigint => v.reduce((a, b) => (a < b ? a : b));
const key = (o: Pick<ResolvedOffer, 'market' | 'direction'>): string => `${o.market}:${o.direction}`;

interface StoredEthQuote {
  quote: EthQuote;
  /** What the static part was built from: a change means a new quote id and a new board slot write. */
  fingerprint: string;
  slotWritten: boolean;
}
interface PoolLeafRow {
  index: number;
  key: string;
  key2: string;
  spend_pub: string;
}

export class OfferEngine {
  readonly events = new Emitter<{ offers: ComputedOffer[] }>();
  private computed: ComputedOffer[] = [];
  private lastPublish = 0;
  private lastPriceRefresh = 0;
  private lastPublished = new Map<string, { price: bigint; enabled: boolean }>();
  private onChain = new Map<string, { seq: bigint; updatedAt: number; validSecs: number; poolFree: number }>();
  private ethPublished = new Map<string, { quoteId: bigint; validUntil: number }>();
  /** Confirmation poll interval, milliseconds. */
  pollMs = 200;

  constructor(private readonly o: OfferEngineOptions) {}

  latest(): ComputedOffer[] {
    return this.computed;
  }

  // ---------------------------------------------------------------- compute (also the dry-run preview)

  /** Price every offer of a configuration from the current references and limits. Sends nothing. */
  async compute(cfg: Config = this.o.config()): Promise<ComputedOffer[]> {
    const g = cfg.raw.guardrails;
    const band = g.price_band_usd || null;
    const targetXmr = cfg.raw.liquidity.targets.xmr ?? cfg.rebalance.levels.xmr?.target ?? null;
    const cap = this.o.capacity();
    const out: ComputedOffer[] = [];
    for (const offer of cfg.offers) {
      const ref = this.o.prices.reference(offer);
      const priced = priceOffer(offer, ref, { inventoryXmr: this.o.inventoryXmr(), targetXmr, band });
      let reason: string | null = offer.enabled ? null : (offer.disabledReason ?? 'switched off');
      if (!reason && this.o.risk.paused) reason = `paused${this.o.risk.pauseReason ? `: ${this.o.risk.pauseReason}` : ''}`;
      if (!reason && priced.blocked) reason = priced.blocked;
      let capacityXmr = 0n;
      if (!reason) {
        const limits: bigint[] = [];
        const remaining = this.o.risk.remaining(offer);
        if (remaining !== null) limits.push(remaining);
        if (offer.direction === 'sell_xmr') {
          // One output funds one lock: no single swap may be larger than the largest unlocked output.
          limits.push(cap.total, cap.largest);
          const alloc = cfg.raw.liquidity.allocation;
          if (alloc !== 'shared' && alloc[offer.market] !== undefined) limits.push(BigInt(Math.round(alloc[offer.market]! * 1e6)) * 1_000_000n);
        } else {
          const available = await this.o.payingAvailable(offer.market).catch(() => null);
          if (available !== null) limits.push(xmrForUnits(available, priced.tierPrice[0]));
        }
        capacityXmr = limits.length ? minBig(...limits) : offer.maxXmr;
        if (capacityXmr > offer.maxXmr && offer.maxXmr > 0n) capacityXmr = offer.maxXmr;
        if (capacityXmr < offer.minXmr) reason = offer.direction === 'sell_xmr' ? 'no capacity: not enough unlocked XMR outputs, or a limit is reached' : 'no capacity: the paying balance, its cap or a limit is reached';
      }
      out.push({ offer, ref, priced, enabled: reason === null, reason, capacityXmr: reason === null ? capacityXmr : 0n, depthTiers: this.o.risk.depthTiers(offer) });
    }
    return out;
  }

  // ---------------------------------------------------------------- the loop

  /** One pass: refresh prices when due, recompute, and publish when due. Called on a short timer. */
  async tick(force = false): Promise<{ published: boolean; reason: string }> {
    const cfg = this.o.config();
    const t = this.o.store.now();
    if (force || t - this.lastPriceRefresh >= cfg.raw.pricing.refresh_seconds) {
      await this.o.prices.refresh();
      this.lastPriceRefresh = t;
    }
    this.computed = await this.compute(cfg);
    this.events.emit('offers', this.computed);
    const dry = cfg.raw.daemon.mode !== 'live' || cfg.raw.guardrails.dry_run;
    if (dry) return { published: false, reason: 'dry run: offers are computed and shown, not posted' };
    const due = force ? 'forced' : this.due(cfg, t);
    if (!due) return { published: false, reason: 'not due' };
    try {
      await this.publish(cfg);
    } catch (e) {
      this.o.alerts.raise('warning', 'offer_refresh_failed', errMsg(e));
      return { published: false, reason: errMsg(e) };
    }
    this.lastPublish = t;
    return { published: true, reason: due };
  }

  /** Why a refresh is due now, or `null`. Interval mode: every interval. Move-triggered: on a price move (not more often than the minimum interval), on an enable flip, and as a keep-alive before the validity lapses. */
  private due(cfg: Config, t: number): string | null {
    const o = cfg.raw.offers;
    const since = t - this.lastPublish;
    const flipped = this.computed.some((c) => c.offer.configured && this.lastPublished.has(key(c.offer)) && this.lastPublished.get(key(c.offer))!.enabled !== c.enabled);
    if (o.price_move_trigger_pct === undefined) return since >= o.update_interval_seconds || flipped ? 'interval' : null;
    if (flipped) return 'an offer switched on or off';
    const live = this.computed.filter((c) => c.offer.configured);
    const minValid = live.reduce((m, c) => Math.min(m, c.offer.validSecs), Number.POSITIVE_INFINITY);
    if (this.lastPublish === 0 || since >= 0.8 * minValid) return 'keep-alive';
    if (since < (o.min_refresh_interval_seconds ?? o.update_interval_seconds)) return null;
    for (const c of live) {
      const last = this.lastPublished.get(key(c.offer));
      if (!c.enabled || !last || last.price === 0n) continue;
      const move = (Math.abs(Number(c.priced.tierPrice[0] - last.price)) / Number(last.price)) * 100;
      if (move >= o.price_move_trigger_pct) return `price moved ${move.toFixed(2)}%`;
    }
    return null;
  }

  private terms(c: ComputedOffer): OfferTerms {
    const o = c.offer;
    const depthAbove = [0n, 0n, 0n];
    const depths = new Uint8Array(3);
    c.depthTiers.forEach((t, i) => {
      depthAbove[i] = t.aboveXmr;
      depths[i] = t.depth;
    });
    const priceAbove = [0n, 0n, 0n];
    o.sizeTiers.forEach((t, i) => (priceAbove[i + 1] = t.aboveXmr));
    return { mode: modeCode(o.mode), minXmr: o.minXmr, maxXmr: o.maxXmr, validSecs: o.validSecs, priceAbove, depthAbove, depths, depBps: o.depositBps, wA: o.approvalWindowSecs, wN: o.noticeSecs, dC: o.claimDelaySecs, wC: o.claimWindowSecs, wF: o.finalSecs };
  }

  /** Publish to the Solana board: occasional transactions first (terms, key refills, quote slots), then the one refresh. */
  private async publish(cfg: Config): Promise<void> {
    const sol = this.o.solana();
    if (!sol) return;
    const program = sol.client.program;
    const op = sol.operator;
    const refreshes: OfferRefresh[] = [];

    for (const c of this.computed.filter((x) => x.offer.chain === 'solana' && x.offer.configured)) {
      const asset = solAsset(c.offer.market);
      const dir = c.offer.directionCode;
      const want = this.terms(c);
      let chainOffer = await sol.client.getOffer(sol.makerPda, asset, dir);
      const same = chainOffer !== null && chainOffer.mode === want.mode && chainOffer.minXmr === want.minXmr && chainOffer.maxXmr === want.maxXmr && chainOffer.validSecs === want.validSecs && chainOffer.depBps === want.depBps && chainOffer.wA === want.wA && chainOffer.wN === want.wN && chainOffer.dC === want.dC && chainOffer.wC === want.wC && chainOffer.wF === want.wF && want.priceAbove.every((v, i) => chainOffer!.priceAbove[i] === v) && want.depthAbove.every((v, i) => chainOffer!.depthAbove[i] === v) && bytesEqual(chainOffer.depths, want.depths);
      if (!same) {
        if (!c.enabled && chainOffer === null) continue; // never published and not publishable: nothing to do
        await this.send(sol, 'set_offer', [program.setOffer(op, sol.makerPda, asset, dir, want)], { market: c.offer.market, direction: c.offer.direction });
        chainOffer = await sol.client.getOffer(sol.makerPda, asset, dir);
      }
      if (!chainOffer) continue;
      if (dir === 0 && c.enabled) {
        // Refill the 16-slot key pool when few unused keys are left. Each share's row is written before it is published.
        const live = chainOffer.poolFilled & ~chainOffer.poolUsed;
        const free = Array.from({ length: POOL_SLOTS }, (_, i) => i).filter((i) => !((live >> i) & 1));
        if (POOL_SLOTS - free.length <= cfg.raw.offers.key_pool_low_water) {
          const pda = base58Decode(sol.makerPda);
          for (let i = 0; i < free.length; i += 8) {
            const slots = free.slice(i, i + 8).map((index) => ({ index, ...solanaMakerShare(this.o.shares.create('solana', `pool:${c.offer.market}`, null, 'published').keys, pda) }));
            await this.send(sol, 'refill_keys', [program.refillKeys(op, sol.makerPda, asset, slots)], { market: c.offer.market, count: slots.length });
          }
        }
      }
      refreshes.push({ asset, direction: dir, enabled: c.enabled, prices: c.enabled ? [...c.priced.tierPrice] : [...chainOffer.prices], capacityXmr: c.enabled ? c.capacityXmr : 0n });
    }

    const ethRefreshes = await this.ethQuotes(cfg, sol).catch((e) => {
      this.o.alerts.raise('warning', 'eth_quotes_failed', errMsg(e));
      return [] as EthQuoteRefresh[];
    });
    if (refreshes.length === 0 && ethRefreshes.length === 0) return;
    // One transaction refreshes all of the maker's markets, including the signed quotes for the Ethereum markets.
    await this.send(sol, 'refresh_offers', [program.refreshOffers(op, sol.makerPda, refreshes, ethRefreshes)], { offers: refreshes.length, eth_quotes: ethRefreshes.length });
    for (const c of this.computed) if (c.offer.configured) this.lastPublished.set(key(c.offer), { price: c.priced.tierPrice[0], enabled: c.enabled });
    for (const c of this.computed.filter((x) => x.offer.chain === 'solana' && x.offer.configured)) {
      const on = await sol.client.getOffer(sol.makerPda, solAsset(c.offer.market), c.offer.directionCode);
      if (on) this.onChain.set(key(c.offer), { seq: on.seq, updatedAt: Number(on.updatedAt), validSecs: on.validSecs, poolFree: popcount(on.poolFilled & ~on.poolUsed) });
    }
  }

  private async send(sol: SolanaChain, call: string, ixs: Parameters<SolanaChain['sendInstructions']>[0], extra: Record<string, unknown>): Promise<string> {
    const { id, tx } = await this.o.journal.broadcast('sol_tx', null, { call, ...extra }, (onSigned) => sol.sendInstructions(ixs, onSigned));
    // Intents of the offer loop resolve here: nobody else looks them up.
    try {
      await sol.client.waitConfirmed(tx!, { level: 'finalized', timeoutMs: 60_000, intervalMs: this.pollMs });
    } catch (e) {
      // Landed with an error: resolved as failed. Not seen in time: left `sent` for the start-up lookup.
      if (e instanceof ProgramError) this.o.store.setIntent(id, 'failed', { error: e.message });
      throw e;
    }
    this.o.store.setIntent(id, 'confirmed');
    this.o.store.recordFee('solana', call, 'sol', 5_000n + BigInt(Math.ceil((this.o.config().raw.solana.priority_fee_microlamports * REFRESH_CU) / 1_000_000)), tx);
    return tx!;
  }

  // ---------------------------------------------------------------- Ethereum quotes and key pools

  /** The current key pool of a token, or a new one when none exists or half of it is consumed (SPEC 2.7). */
  private pool(token: Bytes, size: number): { root: Bytes; leaves: PoolLeafRow[] } {
    const tokenHex = hex0x(token);
    const cur = this.o.store.currentPool<PoolLeafRow[]>(tokenHex);
    if (cur) {
      const used = cur.leaves.filter((l) => this.o.store.shareByPub(l.spend_pub)?.swap_ref).length;
      if (used * 2 < cur.leaves.length) return { root: unhex(cur.root), leaves: cur.leaves };
      this.o.store.retirePool(cur.root);
    }
    const leaves: PoolLeafRow[] = [];
    const hashes: Bytes[] = [];
    for (let index = 0; index < size; index++) {
      // Row first, then the proof the endpoint serves, then the leaf: a share is never signed into a root before it is recorded.
      const s = this.o.shares.create('ethereum', `ethpool:${tokenHex}`, null, 'published');
      const twin = twinCommitments(s.keys.spend);
      this.o.store.putBlob(s.row.spend_pub, dleqProve(s.keys.spend), true);
      leaves.push({ index, key: hex0x(twin.keyAddr), key2: hex0x(twin.keyAddr2), spend_pub: s.row.spend_pub });
      hashes.push(keyLeaf(index, twin.keyAddr, twin.keyAddr2, s.keys.spendPub));
    }
    const root = merkleRoot(hashes);
    this.o.store.putPool(hex(root), tokenHex, leaves);
    return { root, leaves };
  }

  private async ethContext(): Promise<{ eth: EthereumChain & { deployment: EthDeployment }; usdc: Bytes; quoteEpoch: number; now: bigint } | null> {
    const eth = this.o.ethereum();
    if (!eth) return null;
    const [maker, usdc, now] = await Promise.all([eth.maker(), eth.client.usdc(eth.tag), eth.client.chainTime('latest')]);
    return { eth, usdc: unhex(usdc), quoteEpoch: maker.quoteEpoch, now };
  }

  private buildEthQuote(c: ComputedOffer, ctx: { eth: EthereumChain; usdc: Bytes; quoteEpoch: number; now: bigint }, cfg: Config, bound?: { taker: Bytes; xmr: bigint; depth: number; price: bigint }): EthQuote {
    const o = c.offer;
    const token = o.market === 'eth' ? new Uint8Array(20) : ctx.usdc;
    const depthXmr: [bigint, bigint, bigint] = [0n, 0n, 0n];
    const depth: [number, number, number] = [0, 0, 0];
    if (bound) depth[0] = bound.depth;
    else
      c.depthTiers.forEach((t, i) => {
        depthXmr[i] = t.aboveXmr;
        depth[i] = t.depth;
      });
    const claimDelay = bound ? Math.max(o.claimDelaySecs, minClaimDelay('ethereum', bound.depth)) : o.claimDelaySecs;
    return {
      maker: unhex(ctx.eth.makerAddress), taker: bound?.taker ?? new Uint8Array(20), token, direction: o.directionCode, approvalMode: modeCode(o.mode),
      minXmr: bound?.xmr ?? o.minXmr, maxXmr: bound?.xmr ?? minBig(o.maxXmr, c.capacityXmr > 0n ? c.capacityXmr : o.maxXmr),
      tierXmr: bound ? [0n, 0n, 0n] : c.priced.tierAbove, tierPrice: bound ? [bound.price, 0n, 0n] : c.priced.tierPrice, depthXmr, depth,
      depositBps: o.depositBps, approvalWindow: o.approvalWindowSecs, noticeWindow: o.noticeSecs, claimDelay, claimWindow: o.claimWindowSecs, finalWindow: o.finalSecs,
      validUntil: ctx.now + BigInt(o.validSecs), epoch: ctx.quoteEpoch,
      keyRoot: o.directionCode === 0 ? this.pool(token, cfg.raw.offers.eth_pool_size).root : new Uint8Array(32),
      quoteId: randomBytes(8).readBigUInt64LE(),
    };
  }

  /** Sign this round's Ethereum quotes. A quote whose static part changed gets a new id and a board-slot write first. */
  private async ethQuotes(cfg: Config, sol: SolanaChain): Promise<EthQuoteRefresh[]> {
    const live = this.computed.filter((c) => c.offer.chain === 'ethereum' && c.offer.configured && c.enabled);
    if (live.length === 0) return [];
    const ctx = await this.ethContext();
    if (!ctx) return [];
    const out: EthQuoteRefresh[] = [];
    for (const c of live) {
      const slot = ETH_SLOT[key(c.offer)]!;
      const fresh = this.buildEthQuote(c, ctx, cfg);
      const fingerprint = hex(encodeEthQuoteCompact({ ...fresh, tierPrice: [0n, 0n, 0n], validUntil: 0n, quoteId: 0n }));
      const id = `ethboard:${key(c.offer)}`;
      const stored = this.o.store.quote<StoredEthQuote>(id)?.payload;
      const quote: EthQuote = stored && stored.fingerprint === fingerprint ? { ...fresh, quoteId: stored.quote.quoteId } : fresh;
      const sig = await signEthQuote(this.o.keystore.ethereumOperatorKey, ctx.eth.deployment, quote);
      if (!stored || stored.fingerprint !== fingerprint || !stored.slotWritten) {
        this.o.store.putQuote(id, 'ethereum', 'board', { quote, fingerprint, slotWritten: false } satisfies StoredEthQuote, Number(quote.validUntil));
        await this.send(sol, 'set_eth_quote', [sol.client.program.setEthQuote(sol.operator, sol.makerPda, slot, encodeEthQuoteCompact(quote), sig)], { market: c.offer.market, direction: c.offer.direction });
      }
      this.o.store.putQuote(id, 'ethereum', 'board', { quote, fingerprint, slotWritten: true } satisfies StoredEthQuote, Number(quote.validUntil));
      this.ethPublished.set(key(c.offer), { quoteId: quote.quoteId, validUntil: Number(quote.validUntil) });
      out.push({ slot, tierPrice: [...quote.tierPrice], validUntil: quote.validUntil, quoteId: quote.quoteId, sig });
    }
    return out;
  }

  /** The leaves of a pool this maker signed into a quote (`GET /xs/v1/pool/<keyRoot>`). */
  poolLeaves(rootHex: string): PoolLeafRow[] | null {
    return this.o.store.pool<PoolLeafRow[]>(rootHex)?.leaves ?? null;
  }

  // ---------------------------------------------------------------- quotes on request (oversized swaps)

  /**
   * Answer a `quote_request` with a taker-bound quote. Solana: the operator posts a `Quote`
   * account the taker's lock consumes. Ethereum: a bound EIP-712 quote in the compact form.
   * The same guardrails, limits and inventory rules as a published offer apply.
   */
  async quoteOnRequest(req: Pick<QuoteRequest, 'chain' | 'market' | 'direction' | 'xmr' | 'taker'>): Promise<QuoteResponse> {
    const refuse = (detail: string): QuoteResponse => ({ t: 'quote_response', ok: false, detail });
    const cfg = this.o.config();
    if (cfg.raw.daemon.mode !== 'live' || cfg.raw.guardrails.dry_run) return refuse('the maker is not quoting');
    if (!/^\d+$/.test(req.xmr)) return refuse('malformed size');
    const xmr = BigInt(req.xmr);
    const direction = req.direction === 'A' ? 'sell_xmr' : 'buy_xmr';
    const c = (this.computed.length ? this.computed : await this.compute(cfg)).find((x) => x.offer.market === req.market && x.offer.direction === direction);
    if (!c || !c.offer.configured || c.offer.chain !== req.chain) return refuse('this market is not offered');
    if (c.priced.blocked || this.o.risk.paused) return refuse('the maker is not quoting right now');
    if (xmr < c.offer.minXmr) return refuse('below the minimum size');
    const fits = this.o.risk.check({ ref: '', taker: req.taker, xmr }, c.offer);
    if (!fits.ok) return refuse(fits.reasons.join('; '));
    if (direction === 'sell_xmr' && this.o.capacity().largest < xmr) return refuse('no unlocked XMR output can fund this size');
    // The highest tier that applies to this size prices it.
    let price = c.priced.tierPrice[0];
    c.priced.tierAbove.forEach((above, i) => {
      if (i > 0 && c.priced.tierPrice[i] !== 0n && xmr >= above) price = c.priced.tierPrice[i]!;
    });
    const depth = Risk.depthFor(c.depthTiers, xmr);
    if (direction === 'buy_xmr') {
      const available = await this.o.payingAvailable(c.offer.market).catch(() => null);
      if (available !== null && available < receiveAmount(xmr, price, req.chain)) return refuse('the paying balance does not cover this size');
    }
    try {
      if (req.chain === 'solana') {
        const sol = this.o.solana();
        if (!sol) return refuse('Solana is not configured');
        const now = await sol.client.chainTime('finalized');
        const quoteId = randomBytes(8).readBigUInt64LE();
        const share = direction === 'sell_xmr' ? solanaMakerShare(this.o.shares.create('solana', 'quote', null, 'published').keys, base58Decode(sol.makerPda)) : null;
        const expiresAt = now + 110n;
        const amount = direction === 'sell_xmr' ? payAmount(xmr, price, 'solana') : receiveAmount(xmr, price, 'solana');
        const dC = Math.max(c.offer.claimDelaySecs, minClaimDelay('solana', depth));
        const terms = { quoteId, taker: req.taker, asset: solAsset(req.market), direction: c.offer.directionCode, depth, xmr, amount, depBps: c.offer.depositBps, wN: c.offer.noticeSecs, dC, wC: c.offer.claimWindowSecs, wF: Math.max(c.offer.finalSecs, c.offer.noticeSecs * 2 + dC + c.offer.claimWindowSecs + 86_400), makerSpendPub: share?.share ?? new Uint8Array(32), makerPok: share?.pok ?? new Uint8Array(64), expiresAt };
        this.o.store.putQuote(`sol:${quoteId}`, 'solana', 'bound', { taker: req.taker, xmr, amount, market: req.market, direction }, Number(expiresAt));
        await this.send(sol, 'post_quote', [sol.client.program.postQuote(sol.operator, sol.makerPda, terms)], { market: req.market, xmr: req.xmr });
        return { t: 'quote_response', ok: true, chain: 'solana', quote_id: quoteId.toString(), expires_at: expiresAt.toString() };
      }
      const ctx = await this.ethContext();
      if (!ctx) return refuse('Ethereum is not configured');
      const quote = this.buildEthQuote(c, ctx, cfg, { taker: unhex(req.taker), xmr, depth, price });
      quote.validUntil = ctx.now + BigInt(Math.min(c.offer.validSecs, 180));
      const sig = await signEthQuote(this.o.keystore.ethereumOperatorKey, ctx.eth.deployment, quote);
      this.o.store.putQuote(`eth:${quote.quoteId}`, 'ethereum', 'bound', { taker: req.taker, xmr, market: req.market, direction }, Number(quote.validUntil));
      return { t: 'quote_response', ok: true, chain: 'ethereum', quote: toBase64(encodeSignedQuote(quote, sig)) };
    } catch (e) {
      return refuse(CHAIN_CONSTS[req.chain] ? `could not quote: ${errMsg(e)}` : 'could not quote');
    }
  }

  // ---------------------------------------------------------------- views

  views(computed: ComputedOffer[] = this.computed, live = true): OfferView[] {
    return computed.map((c) => {
      const k = key(c.offer);
      const on = this.onChain.get(k);
      const eth = this.ethPublished.get(k);
      const pool = c.offer.chain === 'ethereum' && c.offer.directionCode === 0 ? this.ethPoolView(c) : c.offer.chain === 'solana' && c.offer.directionCode === 0 && on ? { size: POOL_SLOTS, available: on.poolFree } : null;
      const tiers = c.priced.tierPrice.map((price, i) => ({ above_xmr: c.priced.tierAbove[i]!.toString(), price: price.toString() })).filter((t, i) => i === 0 || t.price !== '0');
      return {
        market: c.offer.market, direction: c.offer.direction, live: live && c.enabled && (on !== undefined || eth !== undefined), enabled: c.enabled, ...(c.reason ? { disabled_reason: c.reason } : {}),
        reference_price: c.ref.xmrUsd === null || c.ref.assetUsd === null ? null : BigInt(Math.round((c.ref.xmrUsd / c.ref.assetUsd) * 10 ** c.offer.decimals)).toString(),
        price_tiers: tiers, deviation_pct: c.priced.deviationPct, min_xmr: c.offer.minXmr.toString(), max_xmr: c.offer.maxXmr.toString(), capacity_xmr: c.capacityXmr.toString(), terms: effectiveTerms(c.offer), key_pool: pool,
        seq_or_quote_id: on ? on.seq.toString() : eth ? eth.quoteId.toString() : null, updated_at: on?.updatedAt ?? null, valid_until: on ? on.updatedAt + on.validSecs : (eth?.validUntil ?? null),
      };
    });
  }
  private ethPoolView(c: ComputedOffer): { size: number; available: number } | null {
    const stored = this.o.store.quote<StoredEthQuote>(`ethboard:${key(c.offer)}`)?.payload;
    if (!stored) return null;
    const leaves = this.poolLeaves(hex(stored.quote.keyRoot));
    if (!leaves) return null;
    return { size: leaves.length, available: leaves.filter((l) => !this.o.store.shareByPub(l.spend_pub)?.swap_ref).length };
  }
  /** Whole-XMR figure of the largest swap the engine would quote now, for logs. */
  describe(): string {
    return this.computed.map((c) => `${key(c.offer)} ${c.enabled ? `on cap ${picoToXmr(c.capacityXmr)}` : `off (${c.reason})`}`).join('; ');
  }
}

const popcount = (n: number): number => {
  let c = 0;
  for (let v = n; v; v >>>= 1) c += v & 1;
  return c;
};
