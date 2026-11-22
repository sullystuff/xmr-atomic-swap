/**
 * StealthEX (`api.stealthex.io/v4`, `Authorization: Bearer <key>`).
 *
 * UNCONFIRMED AND OFF BY DEFAULT. XMR is listed on the site's supported-coins page, but the API
 * currency list needs a key and was not checked (docs/research/local-assets.md, section 5; SPEC
 * "Open risks"). The symbol/network codes and response field names below are assumptions from
 * the public API reference; re-read the service's currency list and terms before enabling.
 */
import { fromAtomic, toAtomic } from '../assets.js';
import { dec, obj, optDec, optStr, requestJson, str } from '../http.js';
import type { AssetId, RefillRequest, RefillState, RefillStatus, VenueQuote } from '../types.js';
import { type AssetTable, type CreatedOrder, type Estimate, type InstantDeps, InstantSwapAdapter, txids } from './instant.js';

export const STEALTHEX_BASE = 'https://api.stealthex.io/v4';
export const STEALTHEX_ASSETS: AssetTable<{ symbol: string; network: string }> = {
  xmr: { symbol: 'xmr', network: 'mainnet' },
  sol: { symbol: 'sol', network: 'mainnet' },
  eth: { symbol: 'eth', network: 'mainnet' },
  usdc_sol: { symbol: 'usdc', network: 'sol' },
  usdc_eth: { symbol: 'usdc', network: 'erc20' },
};

const STATES: Record<string, RefillState> = {
  waiting: 'pending', confirming: 'depositing', exchanging: 'processing', sending: 'paying_out', verifying: 'held',
  finished: 'done', failed: 'failed', refunded: 'refunded', expired: 'failed',
};

export class StealthExAdapter extends InstantSwapAdapter {
  readonly id = 'stealthex' as const;
  private readonly base: string;
  constructor(deps: InstantDeps) { super(deps); this.base = deps.baseUrl ?? STEALTHEX_BASE; }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey()}`, 'content-type': 'application/json' };
  }
  private route(from: AssetId, to: AssetId) { return { from: STEALTHEX_ASSETS[from], to: STEALTHEX_ASSETS[to] }; }
  private rate(rate: 'fixed' | 'float'): string { return rate === 'fixed' ? 'fixed' : 'floating'; }
  private post(path: string, body: unknown): Promise<unknown> {
    return requestJson(this.http, { method: 'POST', url: `${this.base}${path}`, headers: this.headers(), body: JSON.stringify(body) });
  }

  protected canQuoteByOutput(_req: RefillRequest): boolean { return true; }

  protected async estimate(req: RefillRequest, amount: { amountIn: bigint } | { amountOut: bigint }): Promise<Estimate> {
    const reversed = 'amountOut' in amount;
    const r = obj(await this.post('/rates/estimated-amount', {
      route: this.route(req.from, req.to),
      amount: Number(reversed ? fromAtomic(req.to, amount.amountOut) : fromAtomic(req.from, amount.amountIn)),
      estimation: reversed ? 'reversed' : 'direct', rate: this.rate(req.rate),
    }), 'stealthex estimate');
    const estimated = dec(r['estimated_amount'], 'stealthex estimated_amount');
    const est: Estimate = reversed
      ? { amountIn: toAtomic(req.from, estimated), amountOut: amount.amountOut, raw: r }
      : { amountIn: amount.amountIn, amountOut: toAtomic(req.to, estimated), raw: r };
    const rate = r['rate'];
    if (rate && typeof rate === 'object') {
      const until = optStr((rate as Record<string, unknown>)['valid_until']);
      if (until && Number.isFinite(Date.parse(until))) est.expiresAt = Math.floor(Date.parse(until) / 1000);
    }
    return est;
  }

  protected async range(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    const r = obj(await this.post('/rates/range', { route: this.route(from, to), estimation: 'direct', rate: 'floating' }), 'stealthex range');
    const max = optDec(r['max_amount']);
    return { min: toAtomic(from, dec(r['min_amount'], 'stealthex min_amount')), max: max === undefined ? null : toAtomic(from, max) };
  }

  protected async create(quote: VenueQuote): Promise<CreatedOrder> {
    const req = quote.request;
    const reversed = req.amountOut !== undefined;
    const body: Record<string, unknown> = {
      route: this.route(req.from, req.to),
      amount: Number(reversed ? fromAtomic(req.to, quote.amountOut) : fromAtomic(req.from, quote.amountIn)),
      estimation: reversed ? 'reversed' : 'direct', rate: this.rate(req.rate),
      address: req.payoutAddress, refund_address: req.refundAddress,
    };
    const rate = obj(quote.raw, 'stealthex quote')['rate'];
    const rateId = rate && typeof rate === 'object' ? optStr((rate as Record<string, unknown>)['id']) : undefined;
    if (rateId) body['rate_id'] = rateId;
    const r = obj(await this.post('/exchanges', body), 'stealthex create');
    const deposit = obj(r['deposit'], 'stealthex deposit');
    const order: CreatedOrder = { orderId: str(r['id'], 'stealthex id'), depositAddress: str(deposit['address'], 'stealthex deposit address'), extra: [req.to] };
    const amt = optDec(deposit['expected_amount']) ?? optDec(deposit['amount']);
    if (amt !== undefined) order.depositAmount = toAtomic(req.from, amt);
    const w = r['withdrawal'];
    const payout = w && typeof w === 'object' ? optStr((w as Record<string, unknown>)['address']) : undefined;
    if (payout) order.payoutAddress = payout;
    const memo = optStr(deposit['extra_id']);
    if (memo) order.memo = memo;
    return order;
  }

  protected async fetchStatus(orderId: string, extra: string[]): Promise<RefillStatus> {
    const r = obj(await requestJson(this.http, { method: 'GET', url: `${this.base}/exchanges/${encodeURIComponent(orderId)}`, headers: this.headers() }), 'stealthex status');
    const raw = str(r['status'], 'stealthex status');
    const deposit = (r['deposit'] ?? {}) as Record<string, unknown>;
    const withdrawal = (r['withdrawal'] ?? {}) as Record<string, unknown>;
    const ids = txids(optStr(deposit['tx_hash']), optStr(withdrawal['tx_hash']));
    const state = STATES[raw];
    if (!state) return { state: 'held', detail: `unknown StealthEX status "${raw}"`, txids: ids };
    const out: RefillStatus = { state, txids: ids };
    if (state === 'held') out.detail = 'StealthEX is verifying this exchange (compliance hold); contact its support';
    if (raw === 'expired') out.detail = 'order expired';
    const to = extra[0] as AssetId | undefined;
    const got = optDec(withdrawal['amount']);
    if (state === 'done' && to && got !== undefined) out.received = toAtomic(to, got);
    return out;
  }
}
