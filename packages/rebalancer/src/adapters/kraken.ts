/**
 * Kraken driver for the `exchange` adapter (`name = "kraken"`).
 *
 * Why Kraken: it lists XMR against USD, and it only withdraws to addresses that were registered
 * on the account under a key name, which is the withdrawal allow-list DESIGN asks for.
 *
 * Written from the public REST documentation; NOT exercised against the live API (no key was
 * used). The request signature is checked against the worked example in Kraken's docs. Asset
 * codes, pair names, deposit-method names and the `viqc` order flag are assumptions to verify on
 * the maker's own account with a small amount before enabling; all are overridable.
 */
import { createHash, createHmac } from 'node:crypto';
import { formatUnits, parseUnits, DECIMALS } from '../assets.js';
import { type EnvReader, type HttpClient, HttpError, obj, optDec, optStr, processEnv, query, str } from '../http.js';
import type { AssetId } from '../types.js';
import type { ExchangeDriver } from './exchange.js';

export const KRAKEN_BASE = 'https://api.kraken.com';

export interface KrakenOptions {
  http: HttpClient;
  apiKeyEnv?: string | undefined;
  apiSecretEnv?: string | undefined;
  env?: EnvReader;
  baseUrl?: string;
  /** Milliseconds; nonces must increase. */
  nonce?: () => number;
  /** Payout address -> the key name it is registered under on the Kraken account. Withdrawals to any other address are refused. */
  withdrawKeys: Record<string, string>;
  /** Taker fee applied to estimates, in basis points (default 40; the real fee depends on the account's volume tier). */
  takerFeeBps?: number;
  assets?: Partial<Record<AssetId, { code: string; depositMethod: string; pair: string }>>;
}

/** `pair` is the asset's market against USD; `code` its balance and funding code. */
export const KRAKEN_ASSETS: Record<AssetId, { code: string; depositMethod: string; pair: string }> = {
  xmr: { code: 'XMR', depositMethod: 'Monero', pair: 'XMRUSD' },
  sol: { code: 'SOL', depositMethod: 'Solana', pair: 'SOLUSD' },
  eth: { code: 'ETH', depositMethod: 'Ethereum (ERC20)', pair: 'ETHUSD' },
  usdc_sol: { code: 'USDC', depositMethod: 'USDC (Solana)', pair: 'USDCUSD' },
  usdc_eth: { code: 'USDC', depositMethod: 'USDC (ERC20)', pair: 'USDCUSD' },
};
const USD_DECIMALS = 4;

/** API-Sign = base64(HMAC-SHA512(base64-decoded secret, path + SHA256(nonce + POST data))). */
export function krakenSign(path: string, nonce: string, postData: string, secretB64: string): string {
  const inner = createHash('sha256').update(nonce + postData).digest();
  return createHmac('sha512', Buffer.from(secretB64, 'base64')).update(Buffer.concat([Buffer.from(path), inner])).digest('base64');
}

export class KrakenDriver implements ExchangeDriver {
  readonly name = 'kraken';
  private readonly o: KrakenOptions;
  private readonly env: EnvReader;
  private readonly assets: Record<AssetId, { code: string; depositMethod: string; pair: string }>;
  private lastNonce = 0;
  constructor(options: KrakenOptions) {
    this.o = options;
    this.env = options.env ?? processEnv;
    this.assets = { ...KRAKEN_ASSETS, ...(options.assets ?? {}) } as Record<AssetId, { code: string; depositMethod: string; pair: string }>;
  }

  private cred(name: string | undefined, what: string): string {
    if (!name) throw new Error(`kraken: no environment variable is configured for the ${what}`);
    const v = this.env(name);
    if (!v) throw new Error(`kraken: environment variable ${name} (${what}) is not set`);
    return v;
  }

  ready(): { ok: boolean; reason?: string } {
    try { this.cred(this.o.apiKeyEnv, 'API key'); this.cred(this.o.apiSecretEnv, 'API secret'); return { ok: true }; } catch (e) { return { ok: false, reason: (e as Error).message }; }
  }

  private unwrap(method: string, url: string, status: number, body: string): unknown {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new HttpError(method, url, status, 'response is not JSON'); }
    const r = obj(parsed, 'kraken response');
    const errors = Array.isArray(r['error']) ? r['error'].map(String) : [];
    if (status < 200 || status >= 300 || errors.length) throw new HttpError(method, url, status, errors.join(', ').slice(0, 200));
    return r['result'];
  }

  private async priv(name: string, params: Record<string, string>): Promise<unknown> {
    const path = `/0/private/${name}`;
    const n = Math.max(this.lastNonce + 1, (this.o.nonce ?? Date.now)());
    this.lastNonce = n;
    const nonce = String(n);
    const postData = new URLSearchParams({ nonce, ...params }).toString();
    const headers = { 'API-Key': this.cred(this.o.apiKeyEnv, 'API key'), 'API-Sign': krakenSign(path, nonce, postData, this.cred(this.o.apiSecretEnv, 'API secret')), 'content-type': 'application/x-www-form-urlencoded' };
    const url = (this.o.baseUrl ?? KRAKEN_BASE) + path;
    const res = await this.o.http.request({ method: 'POST', url, headers, body: postData });
    return this.unwrap('POST', url, res.status, res.body);
  }

  private async ticker(pair: string): Promise<{ ask: number; bid: number }> {
    const url = (this.o.baseUrl ?? KRAKEN_BASE) + '/0/public/Ticker' + query({ pair });
    const res = await this.o.http.request({ method: 'GET', url });
    const result = obj(this.unwrap('GET', url, res.status, res.body), 'kraken ticker');
    const t = obj(Object.values(result)[0], 'kraken ticker pair');
    const first = (v: unknown) => Number(Array.isArray(v) ? v[0] : NaN);
    const ask = first(t['a']), bid = first(t['b']);
    if (!(ask > 0) || !(bid > 0)) throw new Error('kraken: ticker has no bid or ask');
    return { ask, bid };
  }

  needsTrade(from: AssetId, to: AssetId): boolean { return this.assets[from].code !== this.assets[to].code; }

  async depositAddress(asset: AssetId): Promise<{ address: string; memo?: string }> {
    const a = this.assets[asset];
    const list = await this.priv('DepositAddresses', { asset: a.code, method: a.depositMethod });
    if (!Array.isArray(list) || list.length === 0) throw new Error(`kraken: no deposit address for ${a.code} via "${a.depositMethod}"; create one on the account first`);
    const first = obj(list[0], 'kraken deposit address');
    const out: { address: string; memo?: string } = { address: str(first['address'], 'kraken address') };
    const memo = optStr(first['tag']) ?? optStr(first['memo']);
    if (memo) out.memo = memo;
    return out;
  }

  async balance(asset: AssetId): Promise<bigint> {
    const r = obj(await this.priv('Balance', {}), 'kraken balance');
    const code = this.assets[asset].code;
    const v = optDec(r[code]) ?? optDec(r[`X${code}`]) ?? optDec(r[`Z${code}`]);
    return v === undefined ? 0n : parseUnits(v, DECIMALS[asset]);
  }

  async depositCredited(asset: AssetId, txid: string): Promise<bigint | null> {
    const a = this.assets[asset];
    const list = await this.priv('DepositStatus', { asset: a.code, method: a.depositMethod });
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const d = obj(item, 'kraken deposit');
      if (optStr(d['txid'])?.toLowerCase() !== txid.toLowerCase()) continue;
      if (d['status'] !== 'Success') return null;
      const amount = parseUnits(optDec(d['amount']) ?? '0', DECIMALS[asset]);
      const fee = parseUnits(optDec(d['fee']) ?? '0', DECIMALS[asset]);
      return amount > fee ? amount - fee : 0n;
    }
    return null;
  }

  private feeFactor(): number { return 1 - (this.o.takerFeeBps ?? 40) / 10_000; }

  async estimate(from: AssetId, to: AssetId, amountIn: bigint): Promise<bigint> {
    if (!this.needsTrade(from, to)) return amountIn;
    const sell = await this.ticker(this.assets[from].pair);
    const buy = await this.ticker(this.assets[to].pair);
    const usd = Number(formatUnits(amountIn, DECIMALS[from])) * sell.bid * this.feeFactor();
    const out = (usd / buy.ask) * this.feeFactor();
    return parseUnits(out.toFixed(12), DECIMALS[to]);
  }

  /**
   * Two market orders through USD: sell `from` for USD, then buy `to` with exactly the USD the
   * first order returned (`oflags=viqc`: volume in quote currency). The order id returned is
   * `<sell txid>|<client id>`. `orderStatus` places the second leg once the first has filled,
   * tagged with the same client id (`userref`), and looks for an order with that tag before
   * placing one, so a restart between placing and recording cannot place it twice.
   */
  async marketOrder(order: { from: AssetId; to: AssetId; amountIn: bigint; clientId: string }): Promise<{ orderId: string }> {
    const r = obj(await this.priv('AddOrder', {
      pair: this.assets[order.from].pair, type: 'sell', ordertype: 'market',
      volume: formatUnits(order.amountIn, DECIMALS[order.from]), userref: order.clientId,
    }), 'kraken AddOrder');
    const ids = r['txid'];
    if (!Array.isArray(ids) || ids.length !== 1) throw new Error('kraken: AddOrder returned no order id');
    return { orderId: `${String(ids[0])}|${order.clientId}` };
  }

  private async closed(txid: string): Promise<{ state: 'open' | 'filled' | 'failed'; cost: string; fee: string; volExec: string; detail?: string }> {
    const r = obj(await this.priv('QueryOrders', { txid }), 'kraken QueryOrders');
    const o = obj(r[txid], 'kraken order');
    const status = str(o['status'], 'kraken order status');
    const base = { cost: String(optDec(o['cost']) ?? '0'), fee: String(optDec(o['fee']) ?? '0'), volExec: String(optDec(o['vol_exec']) ?? '0') };
    if (status === 'closed') return { state: 'filled', ...base };
    if (status === 'canceled' || status === 'expired') return { state: 'failed', ...base, detail: status };
    return { state: 'open', ...base };
  }

  async orderStatus(orderId: string, _from: AssetId, to: AssetId): Promise<{ state: 'open' | 'filled' | 'failed'; received?: bigint; detail?: string }> {
    const [sellId = '', clientId = ''] = orderId.split('|');
    const sell = await this.closed(sellId);
    if (sell.state !== 'filled') return sell.detail ? { state: sell.state, detail: sell.detail } : { state: sell.state };
    // The sell leg's fee is charged in USD: what is left is cost minus fee.
    const usd = parseUnits(sell.cost, USD_DECIMALS) - parseUnits(sell.fee, USD_DECIMALS);
    if (usd <= 0n) return { state: 'failed', detail: 'the sell leg returned nothing' };

    let buyId: string | undefined;
    {
      // Was the second leg already placed?
      const open = obj(await this.priv('OpenOrders', { userref: clientId }), 'kraken OpenOrders');
      const closed = obj(await this.priv('ClosedOrders', { userref: clientId }), 'kraken ClosedOrders');
      const all = { ...obj(open['open'] ?? {}, 'open'), ...obj(closed['closed'] ?? {}, 'closed') };
      const pair = this.assets[to].pair;
      buyId = Object.entries(all).find(([id, o]) => id !== sellId && obj(obj(o, 'order')['descr'], 'descr')['type'] === 'buy' && obj(obj(o, 'order')['descr'], 'descr')['pair'] === pair)?.[0];
      if (!buyId) {
        const r = obj(await this.priv('AddOrder', { pair, type: 'buy', ordertype: 'market', volume: formatUnits(usd, USD_DECIMALS), oflags: 'viqc', userref: clientId }), 'kraken AddOrder');
        const txid = r['txid'];
        if (!Array.isArray(txid) || txid.length !== 1) throw new Error('kraken: AddOrder returned no order id');
        buyId = String(txid[0]);
      }
    }
    const buy = await this.closed(buyId);
    if (buy.state !== 'filled') return buy.detail ? { state: buy.state, detail: buy.detail } : { state: buy.state };
    // With `viqc` the fee comes out of the quote volume, so the executed base volume is what was bought.
    return { state: 'filled', received: parseUnits(buy.volExec, DECIMALS[to]) };
  }

  private key(address: string): string {
    const k = this.o.withdrawKeys[address];
    if (!k) throw new Error('kraken: the payout address is not registered as a withdrawal key on the account; register it and add it to withdraw_keys');
    return k;
  }

  async withdrawFee(asset: AssetId, address: string, amount: bigint): Promise<bigint> {
    const r = obj(await this.priv('WithdrawInfo', { asset: this.assets[asset].code, key: this.key(address), amount: formatUnits(amount, DECIMALS[asset]) }), 'kraken WithdrawInfo');
    return parseUnits(optDec(r['fee']) ?? '0', DECIMALS[asset]);
  }

  async withdraw(w: { asset: AssetId; address: string; amount: bigint }): Promise<{ withdrawalId: string }> {
    const r = obj(await this.priv('Withdraw', { asset: this.assets[w.asset].code, key: this.key(w.address), amount: formatUnits(w.amount, DECIMALS[w.asset]) }), 'kraken Withdraw');
    return { withdrawalId: str(r['refid'], 'kraken refid') };
  }

  async withdrawalStatus(asset: AssetId, withdrawalId: string): Promise<{ state: 'pending' | 'sent' | 'held' | 'failed'; txid?: string; amount?: bigint; detail?: string }> {
    const list = await this.priv('WithdrawStatus', { asset: this.assets[asset].code });
    if (!Array.isArray(list)) return { state: 'pending' };
    for (const item of list) {
      const w = obj(item, 'kraken withdrawal');
      if (w['refid'] !== withdrawalId) continue;
      const out: { state: 'pending' | 'sent' | 'held' | 'failed'; txid?: string; amount?: bigint; detail?: string } = { state: 'pending' };
      const txid = optStr(w['txid']);
      if (txid) out.txid = txid;
      const amount = optDec(w['amount']);
      if (amount !== undefined) out.amount = parseUnits(amount, DECIMALS[asset]);
      const status = String(w['status']);
      if (status === 'Success') out.state = 'sent';
      else if (status === 'Failure' || status === 'Canceled') { out.state = 'failed'; out.detail = status; }
      else if (optStr(w['status-prop']) === 'onhold') { out.state = 'held'; out.detail = 'Kraken has the withdrawal on hold'; }
      return out;
    }
    return { state: 'pending' };
  }

  async limits(from: AssetId, _to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    // Kraken publishes per-asset deposit and order minimums that change; a conservative floor of 10 USD is used.
    const { bid } = from.startsWith('usdc') ? { bid: 1 } : await this.ticker(this.assets[from].pair);
    return { min: parseUnits((10 / bid).toFixed(8), DECIMALS[from]), max: null };
  }
}

/** The concrete drivers, by `[rebalance.venues.exchange].name`. */
export const EXCHANGE_DRIVERS = ['kraken'] as const;
