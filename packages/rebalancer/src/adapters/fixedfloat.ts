/**
 * FixedFloat (`ff.io/api/v2`; `X-API-KEY` plus `X-API-SIGN` = HMAC-SHA256 of the JSON body with
 * the API secret, hex).
 *
 * Built from the public API page read on 2026-11-21 (docs/research/local-assets.md, section 5).
 * XMR pairs appear in the public rates export. Currency codes and response field names have NOT
 * been checked against the live API: no key was used. Only `create` (50 units) has a documented
 * weight; the other calls are budgeted at 1 unit each as an assumption.
 */
import { createHmac } from 'node:crypto';
import { fromAtomic, toAtomic } from '../assets.js';
import { dec, HttpError, obj, optDec, optStr, str } from '../http.js';
import { type AssetId, type RefillRequest, type RefillState, type RefillStatus, type VenueQuote, VenueError } from '../types.js';
import { type AssetTable, type CreatedOrder, type Estimate, type InstantDeps, InstantSwapAdapter, txids } from './instant.js';

export const FIXEDFLOAT_BASE = 'https://ff.io/api/v2';
export const FIXEDFLOAT_ASSETS: AssetTable<string> = { xmr: 'XMR', sol: 'SOL', eth: 'ETH', usdc_sol: 'USDCSOL', usdc_eth: 'USDCETH' };
export const FIXEDFLOAT_WEIGHT_PER_MINUTE = 250;
const WEIGHTS: Record<string, number> = { '/create': 50 };

const STATES: Record<string, RefillState> = { NEW: 'pending', PENDING: 'depositing', EXCHANGE: 'processing', WITHDRAW: 'paying_out', DONE: 'done', EXPIRED: 'failed', EMERGENCY: 'held' };

export function fixedFloatSign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export class FixedFloatAdapter extends InstantSwapAdapter {
  readonly id = 'fixedfloat' as const;
  protected override readonly needsSecret = true;
  private readonly base: string;
  private spent: { t: number; w: number }[] = [];
  constructor(deps: InstantDeps) { super(deps); this.base = deps.baseUrl ?? FIXEDFLOAT_BASE; }

  /** Refuses a call that would pass 250 weight units in the trailing minute, rather than letting the service ban the key. */
  private budget(path: string): void {
    const now = this.now();
    this.spent = this.spent.filter((s) => now - s.t < 60);
    const w = WEIGHTS[path] ?? 1;
    if (this.spent.reduce((a, s) => a + s.w, 0) + w > FIXEDFLOAT_WEIGHT_PER_MINUTE) throw new VenueError(this.id, 'local rate budget (250 weight units per minute) is used up; try again in a minute');
    this.spent.push({ t: now, w });
  }

  private async call(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const headers = { 'X-API-KEY': this.apiKey(), 'X-API-SIGN': fixedFloatSign(body, this.apiSecret()), 'content-type': 'application/json; charset=UTF-8', accept: 'application/json' };
    this.budget(path);
    const url = `${this.base}${path}`;
    const res = await this.http.request({ method: 'POST', url, headers, body });
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); } catch { throw new HttpError('POST', url, res.status, 'response is not JSON'); }
    const r = obj(parsed, 'fixedfloat response');
    if (res.status < 200 || res.status >= 300 || r['code'] !== 0) throw new HttpError('POST', url, res.status, `code ${String(r['code'])}: ${String(r['msg'] ?? '').slice(0, 200)}`);
    return obj(r['data'], 'fixedfloat data');
  }

  protected canQuoteByOutput(_req: RefillRequest): boolean { return true; }

  private priceBody(req: { from: AssetId; to: AssetId; rate: 'fixed' | 'float' }, amount: { amountIn: bigint } | { amountOut: bigint }) {
    const byOutput = 'amountOut' in amount;
    return {
      type: req.rate, fromCcy: FIXEDFLOAT_ASSETS[req.from], toCcy: FIXEDFLOAT_ASSETS[req.to], direction: byOutput ? 'to' : 'from',
      amount: byOutput ? fromAtomic(req.to, amount.amountOut) : fromAtomic(req.from, amount.amountIn),
    };
  }

  protected async estimate(req: RefillRequest, amount: { amountIn: bigint } | { amountOut: bigint }): Promise<Estimate> {
    const d = await this.call('/price', this.priceBody(req, amount));
    const errors = Array.isArray(d['errors']) ? d['errors'].map(String) : [];
    if (errors.length) throw new VenueError(this.id, `quote refused: ${errors.join(', ')}`);
    const from = obj(d['from'], 'fixedfloat from'), to = obj(d['to'], 'fixedfloat to');
    return { amountIn: toAtomic(req.from, dec(from['amount'], 'fixedfloat from.amount')), amountOut: toAtomic(req.to, dec(to['amount'], 'fixedfloat to.amount')), raw: d };
  }

  protected async range(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    // `/price` reports the pair's limits whatever amount is asked; a refusal such as LIMIT_MIN is expected here.
    const d = await this.call('/price', this.priceBody({ from, to, rate: 'float' }, { amountIn: toAtomic(from, '1') }));
    const f = obj(d['from'], 'fixedfloat from');
    const max = optDec(f['max']);
    return { min: toAtomic(from, dec(f['min'], 'fixedfloat from.min')), max: max === undefined ? null : toAtomic(from, max) };
  }

  protected async create(quote: VenueQuote): Promise<CreatedOrder> {
    const req = quote.request;
    const amount = req.amountOut !== undefined ? { amountOut: quote.amountOut } : { amountIn: quote.amountIn };
    const d = await this.call('/create', { ...this.priceBody(req, amount), toAddress: req.payoutAddress });
    const from = obj(d['from'], 'fixedfloat from'), to = obj(d['to'], 'fixedfloat to');
    // FixedFloat takes no refund address at creation; it is kept in the handle for the emergency refund.
    const order: CreatedOrder = { orderId: str(d['id'], 'fixedfloat id'), depositAddress: str(from['address'], 'fixedfloat from.address'), extra: [str(d['token'], 'fixedfloat token'), req.to, req.refundAddress] };
    const amt = optDec(from['amount']);
    if (amt !== undefined) order.depositAmount = toAtomic(req.from, amt);
    const payout = optStr(to['address']);
    if (payout) order.payoutAddress = payout;
    const memo = optStr(from['tag']);
    if (memo) order.memo = memo;
    return order;
  }

  protected async fetchStatus(orderId: string, extra: string[]): Promise<RefillStatus> {
    const d = await this.call('/order', { id: orderId, token: extra[0] ?? '' });
    const raw = str(d['status'], 'fixedfloat status');
    const from = (d['from'] ?? {}) as Record<string, unknown>, to = (d['to'] ?? {}) as Record<string, unknown>, back = (d['back'] ?? {}) as Record<string, unknown>;
    const tx = (side: Record<string, unknown>) => optStr(((side['tx'] ?? {}) as Record<string, unknown>)['id']);
    const ids = txids(tx(from), tx(to), tx(back));
    let state = STATES[raw];
    if (!state) return { state: 'held', detail: `unknown FixedFloat status "${raw}"`, txids: ids };
    const emergency = (d['emergency'] ?? {}) as Record<string, unknown>;
    if (state === 'done' && emergency['choice'] === 'REFUND') state = 'refunded';
    const out: RefillStatus = { state, txids: ids };
    if (state === 'held') {
      const why = Array.isArray(emergency['status']) ? emergency['status'].map(String).join(', ') : '';
      out.detail = `FixedFloat emergency${why ? ` (${why})` : ''}: the deposit was outside the quoted limits or late; choose continue or refund`;
    }
    if (raw === 'EXPIRED') out.detail = 'order expired';
    const asset = extra[1] as AssetId | undefined;
    const got = optDec(to['amount']);
    if (state === 'done' && asset && got !== undefined) out.received = toAtomic(asset, got);
    return out;
  }

  /** `POST /emergency`: continue at the new rate, or refund (minus the network fee) to the refund address the refill was created with. */
  async resolveHeld(handle: string, choice: 'continue' | 'refund'): Promise<void> {
    const { orderId, extra } = this.parseHandle(handle);
    const payload: Record<string, unknown> = { id: orderId, token: extra[0] ?? '', choice: choice === 'continue' ? 'EXCHANGE' : 'REFUND' };
    if (choice === 'refund') {
      if (!extra[2]) throw new VenueError(this.id, 'handle carries no refund address');
      payload['address'] = extra[2];
    }
    await this.call('/emergency', payload);
  }
}
