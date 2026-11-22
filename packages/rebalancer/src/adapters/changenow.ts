/**
 * ChangeNOW (`api.changenow.io/v2`, header `x-changenow-api-key`).
 *
 * Built from the public documentation read on 2026-11-21 (docs/research/local-assets.md,
 * section 5). XMR is on the public currency list with fixed rate supported. Field names of the
 * responses, the ticker/network codes below and the bodies of `/exchange/continue` and
 * `/exchange/refund` have NOT been checked against the live API: no key was used.
 */
import { fromAtomic, toAtomic } from '../assets.js';
import { dec, obj, optDec, optStr, query, requestJson, str } from '../http.js';
import { type AssetId, type RefillRequest, type RefillState, type RefillStatus, type VenueQuote, VenueError } from '../types.js';
import { type AssetTable, type CreatedOrder, type Estimate, type InstantDeps, InstantSwapAdapter, txids } from './instant.js';

export const CHANGENOW_BASE = 'https://api.changenow.io/v2';
export const CHANGENOW_ASSETS: AssetTable<{ currency: string; network: string }> = {
  xmr: { currency: 'xmr', network: 'xmr' },
  sol: { currency: 'sol', network: 'sol' },
  eth: { currency: 'eth', network: 'eth' },
  usdc_sol: { currency: 'usdc', network: 'sol' },
  usdc_eth: { currency: 'usdc', network: 'eth' },
};

const STATES: Record<string, RefillState> = {
  new: 'pending', waiting: 'pending', confirming: 'depositing', exchanging: 'processing', sending: 'paying_out',
  finished: 'done', failed: 'failed', refunded: 'refunded', verifying: 'held', expired: 'failed',
};

export class ChangeNowAdapter extends InstantSwapAdapter {
  readonly id = 'changenow' as const;
  private readonly base: string;
  constructor(deps: InstantDeps) { super(deps); this.base = deps.baseUrl ?? CHANGENOW_BASE; }

  private headers(): Record<string, string> {
    return { 'x-changenow-api-key': this.apiKey(), 'content-type': 'application/json' };
  }
  private pair(from: AssetId, to: AssetId) {
    const f = CHANGENOW_ASSETS[from], t = CHANGENOW_ASSETS[to];
    return { fromCurrency: f.currency, toCurrency: t.currency, fromNetwork: f.network, toNetwork: t.network };
  }
  private flow(rate: 'fixed' | 'float'): string { return rate === 'fixed' ? 'fixed-rate' : 'standard'; }

  /** A fixed output can be priced only on the fixed-rate flow (`type=reverse`). */
  protected canQuoteByOutput(req: RefillRequest): boolean { return req.rate === 'fixed'; }

  protected async estimate(req: RefillRequest, amount: { amountIn: bigint } | { amountOut: bigint }): Promise<Estimate> {
    const reverse = 'amountOut' in amount;
    const url = `${this.base}/exchange/estimated-amount` + query({
      ...this.pair(req.from, req.to), flow: this.flow(req.rate), type: reverse ? 'reverse' : 'direct',
      fromAmount: reverse ? undefined : fromAtomic(req.from, amount.amountIn),
      toAmount: reverse ? fromAtomic(req.to, amount.amountOut) : undefined,
      useRateId: req.rate === 'fixed' ? true : undefined,
    });
    const r = obj(await requestJson(this.http, { method: 'GET', url, headers: this.headers() }), 'changenow estimate');
    const est: Estimate = {
      amountIn: toAtomic(req.from, dec(r['fromAmount'], 'changenow fromAmount')),
      amountOut: toAtomic(req.to, dec(r['toAmount'], 'changenow toAmount')),
      raw: r,
    };
    const until = optStr(r['validUntil']);
    if (until && Number.isFinite(Date.parse(until))) est.expiresAt = Math.floor(Date.parse(until) / 1000);
    if (req.rate === 'fixed' && !optStr(r['rateId'])) throw new VenueError(this.id, 'fixed-rate estimate came back without a rateId');
    return est;
  }

  protected async range(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    const url = `${this.base}/exchange/range` + query({ ...this.pair(from, to), flow: 'standard' });
    const r = obj(await requestJson(this.http, { method: 'GET', url, headers: this.headers() }), 'changenow range');
    const max = optDec(r['maxAmount']);
    return { min: toAtomic(from, dec(r['minAmount'], 'changenow minAmount')), max: max === undefined ? null : toAtomic(from, max) };
  }

  protected async create(quote: VenueQuote): Promise<CreatedOrder> {
    const req = quote.request;
    const byOutput = req.amountOut !== undefined && req.rate === 'fixed';
    const body: Record<string, unknown> = {
      ...this.pair(req.from, req.to),
      fromAmount: byOutput ? '' : fromAtomic(req.from, quote.amountIn),
      toAmount: byOutput ? fromAtomic(req.to, quote.amountOut) : '',
      address: req.payoutAddress, refundAddress: req.refundAddress,
      flow: this.flow(req.rate), type: byOutput ? 'reverse' : 'direct',
    };
    if (req.rate === 'fixed') body['rateId'] = str(obj(quote.raw, 'changenow quote')['rateId'], 'changenow rateId');
    const r = obj(await requestJson(this.http, { method: 'POST', url: `${this.base}/exchange`, headers: this.headers(), body: JSON.stringify(body) }), 'changenow create');
    const order: CreatedOrder = { orderId: str(r['id'], 'changenow id'), depositAddress: str(r['payinAddress'], 'changenow payinAddress') };
    const amt = optDec(r['fromAmount']);
    if (amt !== undefined) order.depositAmount = toAtomic(req.from, amt);
    const payout = optStr(r['payoutAddress']);
    if (payout) order.payoutAddress = payout;
    const memo = optStr(r['payinExtraId']);
    if (memo) order.memo = memo;
    // The asset is needed to read amounts back from the status call.
    order.extra = [req.to];
    return order;
  }

  protected async fetchStatus(orderId: string, extra: string[]): Promise<RefillStatus> {
    const url = `${this.base}/exchange/by-id` + query({ id: orderId });
    const r = obj(await requestJson(this.http, { method: 'GET', url, headers: this.headers() }), 'changenow status');
    const raw = str(r['status'], 'changenow status');
    const state = STATES[raw];
    const out: RefillStatus = state
      ? { state, txids: txids(optStr(r['payinHash']), optStr(r['payoutHash'])) }
      : { state: 'held', detail: `unknown ChangeNOW status "${raw}"`, txids: txids(optStr(r['payinHash']), optStr(r['payoutHash'])) };
    if (state === 'held') out.detail = 'ChangeNOW is verifying this exchange (compliance hold)';
    if (raw === 'expired') out.detail = 'order expired';
    const to = extra[0] as AssetId | undefined;
    const got = optDec(r['amountTo']);
    if (state === 'done' && to && got !== undefined) out.received = toAtomic(to, got);
    return out;
  }

  /** `POST /exchange/continue` or `/exchange/refund`. The refund goes to the refund address given at creation. */
  async resolveHeld(handle: string, choice: 'continue' | 'refund'): Promise<void> {
    const { orderId } = this.parseHandle(handle);
    await requestJson(this.http, { method: 'POST', url: `${this.base}/exchange/${choice}`, headers: this.headers(), body: JSON.stringify({ id: orderId }) });
  }
}
