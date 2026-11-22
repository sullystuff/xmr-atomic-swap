/**
 * HoudiniSwap (`api-partner.houdiniswap.com/v2`, `Authorization: <key>:<secret>`).
 *
 * UNCONFIRMED AND OFF BY DEFAULT. Monero is the hop on Houdini's private routes, but XMR as a
 * payout token was not confirmed without a key (docs/research/local-assets.md, section 5; SPEC
 * "Open risks"). Token identifiers, query parameters and response field names below are
 * assumptions from the published partner-API description; re-read `GET /tokens` and the
 * service's terms with a key before enabling.
 */
import { fromAtomic, toAtomic } from '../assets.js';
import { dec, obj, optDec, optStr, query, requestJson, str } from '../http.js';
import { type AssetId, type RefillRequest, type RefillState, type RefillStatus, type VenueQuote, VenueError } from '../types.js';
import { type AssetTable, type CreatedOrder, type Estimate, type InstantDeps, InstantSwapAdapter, txids } from './instant.js';

export const HOUDINI_BASE = 'https://api-partner.houdiniswap.com/v2';
export const HOUDINI_ASSETS: AssetTable<string> = { xmr: 'XMR', sol: 'SOL', eth: 'ETH', usdc_sol: 'USDCSOL', usdc_eth: 'USDC' };

/** 0 waiting, 1 confirming, 2 exchanging, 3 anonymizing, 4 completed, 5 expired, 6 failed, 7 refunded, 8 deleted. */
const STATES: Record<number, RefillState> = { 0: 'pending', 1: 'depositing', 2: 'processing', 3: 'processing', 4: 'done', 5: 'failed', 6: 'failed', 7: 'refunded', 8: 'failed' };
const STATE_NAMES = ['waiting', 'confirming', 'exchanging', 'anonymizing', 'completed', 'expired', 'failed', 'refunded', 'deleted'];

export class HoudiniSwapAdapter extends InstantSwapAdapter {
  readonly id = 'houdiniswap' as const;
  protected override readonly needsSecret = true;
  private readonly base: string;
  constructor(deps: InstantDeps) { super(deps); this.base = deps.baseUrl ?? HOUDINI_BASE; }

  private headers(): Record<string, string> {
    return { authorization: `${this.apiKey()}:${this.apiSecret()}`, 'content-type': 'application/json' };
  }

  /** `GET /quotes` prices an input only; an output request is scaled from a probe by the shared flow. */
  protected canQuoteByOutput(_req: RefillRequest): boolean { return false; }

  protected async estimate(req: RefillRequest, amount: { amountIn: bigint } | { amountOut: bigint }): Promise<Estimate> {
    if (!('amountIn' in amount)) throw new VenueError(this.id, 'quotes are priced by input only');
    const url = `${this.base}/quotes` + query({ from: HOUDINI_ASSETS[req.from], to: HOUDINI_ASSETS[req.to], amount: fromAtomic(req.from, amount.amountIn), anonymous: false, fixed: req.rate === 'fixed' });
    const r = await requestJson(this.http, { method: 'GET', url, headers: this.headers() });
    const list = Array.isArray(r) ? r : (obj(r, 'houdini quotes')['quotes'] as unknown);
    if (!Array.isArray(list) || list.length === 0) throw new VenueError(this.id, 'no quote for this pair (XMR payout may not be offered)');
    // The best output among the quotes of the requested rate type.
    let best: { out: bigint; q: Record<string, unknown> } | undefined;
    for (const item of list) {
      const q = obj(item, 'houdini quote');
      if (typeof q['fixed'] === 'boolean' && q['fixed'] !== (req.rate === 'fixed')) continue;
      const out = toAtomic(req.to, dec(q['amountOut'], 'houdini amountOut'));
      if (!best || out > best.out) best = { out, q };
    }
    if (!best) throw new VenueError(this.id, `no ${req.rate} quote for this pair`);
    str(best.q['quoteId'], 'houdini quoteId');
    return { amountIn: amount.amountIn, amountOut: best.out, raw: best.q };
  }

  protected async range(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    const url = `${this.base}/minMax` + query({ from: HOUDINI_ASSETS[from], to: HOUDINI_ASSETS[to], anonymous: false });
    const r = await requestJson(this.http, { method: 'GET', url, headers: this.headers() });
    const [min, max] = Array.isArray(r) ? r : [obj(r, 'houdini minMax')['min'], obj(r, 'houdini minMax')['max']];
    const m = optDec(max);
    return { min: toAtomic(from, dec(min, 'houdini min')), max: m === undefined ? null : toAtomic(from, m) };
  }

  protected async create(quote: VenueQuote): Promise<CreatedOrder> {
    const req = quote.request;
    const body = { quoteId: str(obj(quote.raw, 'houdini quote')['quoteId'], 'houdini quoteId'), addressTo: req.payoutAddress, refundAddress: req.refundAddress };
    const r = obj(await requestJson(this.http, { method: 'POST', url: `${this.base}/exchanges`, headers: this.headers(), body: JSON.stringify(body) }), 'houdini create');
    const order: CreatedOrder = { orderId: str(r['houdiniId'], 'houdiniId'), depositAddress: str(r['senderAddress'], 'houdini senderAddress'), extra: [req.to] };
    const amt = optDec(r['inAmount']);
    if (amt !== undefined) order.depositAmount = toAtomic(req.from, amt);
    const payout = optStr(r['receiverAddress']);
    if (payout) order.payoutAddress = payout;
    const memo = optStr(r['senderTag']);
    if (memo) order.memo = memo;
    return order;
  }

  protected async fetchStatus(orderId: string, extra: string[]): Promise<RefillStatus> {
    const r = obj(await requestJson(this.http, { method: 'GET', url: `${this.base}/orders/${encodeURIComponent(orderId)}`, headers: this.headers() }), 'houdini status');
    const code = Number(r['status']);
    const ids = txids(optStr(r['hashIn']), optStr(r['transactionHash']));
    const state = STATES[code];
    if (!state) return { state: 'held', detail: `unknown HoudiniSwap status ${String(r['status'])}`, txids: ids };
    // DESIGN: "An order can stop at a 'Contact Support' status when flagged for compliance review."
    const label = [optStr(r['statusText']), optStr(r['notified'])].join(' ');
    if (/support/i.test(label) && state !== 'done' && state !== 'refunded') return { state: 'held', detail: 'HoudiniSwap asks to contact support (compliance review)', txids: ids };
    const out: RefillStatus = { state, txids: ids };
    if (state === 'failed') out.detail = `order ${STATE_NAMES[code] ?? code}`;
    const to = extra[0] as AssetId | undefined;
    const got = optDec(r['outAmount']);
    if (state === 'done' && to && got !== undefined) out.received = toAtomic(to, got);
    return out;
  }
}
