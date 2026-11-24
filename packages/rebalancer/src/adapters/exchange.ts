/**
 * Generic centralised-exchange adapter: deposit the paying asset, trade, withdraw, on the
 * maker's own account (SPEC 7.7). The adapter owns the state machine and the safety rules; a
 * thin `ExchangeDriver` speaks one exchange's API and is chosen by `name`.
 *
 * Steps after the deposit are taken by `advance`, which is idempotent: every order and
 * withdrawal is recorded in the adapter's store (and journalled) BEFORE the API call, and a
 * call whose outcome is unknown is never repeated; the refill goes to `held` for the maker.
 */
import { costAgainstReference, fromAtomic, mulDivCeil, unitsForUsd, usdValue } from '../assets.js';
import { type AdapterStore, type AssetId, type ExecContext, MemoryStore, type PriceSource, type RefillRequest, type RefillStatus, type VenueAdapter, type VenueQuote, VenueError } from '../types.js';
import { sendAsset } from './instant.js';

export interface ExchangeLeg { sell: string; buy: string }

export interface ExchangeDriver {
  readonly name: string;
  /** Checks that credentials are present; makes no request. */
  ready(): { ok: boolean; reason?: string };
  /** The account's deposit address for an asset. */
  depositAddress(asset: AssetId): Promise<{ address: string; memo?: string }>;
  /** Free balance. */
  balance(asset: AssetId): Promise<bigint>;
  /** The amount credited for a deposit transaction, or null while it is unconfirmed. */
  depositCredited(asset: AssetId, txid: string): Promise<bigint | null>;
  /** Expected output of trading `amountIn` of `from` into `to` at market, after trading fees. Equal assets on different networks trade 1:1. */
  estimate(from: AssetId, to: AssetId, amountIn: bigint): Promise<bigint>;
  /** Trades at market. `clientId` is unique per attempt and is what makes a retry detectable. Returns the amount of `to` obtained once filled. */
  marketOrder(order: { from: AssetId; to: AssetId; amountIn: bigint; clientId: string }): Promise<{ orderId: string }>;
  orderStatus(orderId: string, from: AssetId, to: AssetId): Promise<{ state: 'open' | 'filled' | 'failed'; received?: bigint; detail?: string }>;
  withdrawFee(asset: AssetId, address: string, amount: bigint): Promise<bigint>;
  /** Withdraws to an address. Drivers for exchanges with withdrawal allow-lists refuse an address that is not registered on the account. */
  withdraw(w: { asset: AssetId; address: string; amount: bigint }): Promise<{ withdrawalId: string }>;
  withdrawalStatus(asset: AssetId, withdrawalId: string): Promise<{ state: 'pending' | 'sent' | 'held' | 'failed'; txid?: string; amount?: bigint; detail?: string }>;
  limits(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }>;
  /** Whether the two assets need a trade (false for USDC moving between networks). */
  needsTrade(from: AssetId, to: AssetId): boolean;
  /** Throws, without making a request, when the exchange account may not withdraw this asset to this address. Checked before a quote, before the deposit and before the withdrawal. */
  assertPayoutAllowed?(asset: AssetId, address: string): void;
}

export interface ExchangeDeps {
  driver: ExchangeDriver;
  prices: PriceSource;
  store?: AdapterStore;
  now?: () => number;
  depositFeeUsd?: (asset: AssetId) => number;
}

type Phase = 'deposit_sent' | 'credited' | 'order_intent' | 'order_placed' | 'traded' | 'withdraw_intent' | 'withdrawing' | 'done' | 'failed' | 'held';
interface Rec {
  from: AssetId; to: AssetId; amountIn: string; payoutAddress: string;
  phase: Phase; detail?: string;
  depositTxid?: string; credited?: string;
  clientId?: string; orderId?: string; traded?: string;
  withdrawalId?: string; withdrawAmount?: string; payoutTxid?: string; received?: string;
}

export class ExchangeAdapter implements VenueAdapter {
  readonly id = 'exchange' as const;
  private readonly driver: ExchangeDriver;
  private readonly prices: PriceSource;
  private readonly store: AdapterStore;
  private readonly now: () => number;
  private readonly depositFeeUsd: (asset: AssetId) => number;
  private seq = 0;

  constructor(deps: ExchangeDeps) {
    this.driver = deps.driver;
    this.prices = deps.prices;
    this.store = deps.store ?? new MemoryStore();
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.depositFeeUsd = deps.depositFeeUsd ?? (() => 0);
  }

  async health(): Promise<{ ok: boolean; reason?: string }> { return this.driver.ready(); }

  limits(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    if (from === to) throw new VenueError(this.id, 'from and to are the same asset');
    return this.driver.limits(from, to);
  }

  private async net(req: RefillRequest, amountIn: bigint): Promise<bigint> {
    const gross = await this.driver.estimate(req.from, req.to, amountIn);
    const fee = await this.driver.withdrawFee(req.to, req.payoutAddress, gross);
    return gross > fee ? gross - fee : 0n;
  }

  async quote(req: RefillRequest): Promise<VenueQuote> {
    if (req.from === req.to) throw new VenueError(this.id, 'from and to are the same asset');
    if ((req.amountIn === undefined) === (req.amountOut === undefined)) throw new VenueError(this.id, 'exactly one of amountIn and amountOut must be set');
    this.checkPayout(req.to, req.payoutAddress);
    let amountIn: bigint;
    if (req.amountIn !== undefined) amountIn = req.amountIn;
    else {
      const probeIn = await unitsForUsd(this.prices, req.from, await usdValue(this.prices, req.to, req.amountOut!));
      const probeOut = await this.net(req, probeIn);
      if (probeOut <= 0n) throw new VenueError(this.id, 'estimated output is zero after fees');
      amountIn = mulDivCeil(probeIn, req.amountOut!, probeOut);
    }
    const amountOut = await this.net(req, amountIn);
    if (amountOut <= 0n) throw new VenueError(this.id, 'estimated output is zero after fees');
    const cost = await costAgainstReference(this.prices, req.from, amountIn, req.to, amountOut, this.depositFeeUsd(req.from));
    // A market order has no held rate: the quote is an estimate whatever `rate` asks for.
    return { venue: this.id, request: req, amountIn, amountOut, feesUsd: cost.feesUsd, costPct: cost.costPct, expiresAt: this.now() + 60, raw: { exchange: this.driver.name, estimate: true } };
  }

  /** Refuses a payout the driver would not be allowed to make, before any API call and before any funds move. */
  private checkPayout(asset: AssetId, address: string): void {
    try { this.driver.assertPayoutAllowed?.(asset, address); } catch (e) { throw new VenueError(this.id, (e as Error).message); }
  }

  private async load(handle: string): Promise<Rec> {
    const s = await this.store.get(handle);
    if (!s) throw new VenueError(this.id, `unknown handle ${handle}`);
    return JSON.parse(s) as Rec;
  }
  private save(handle: string, rec: Rec): Promise<void> { return this.store.put(handle, JSON.stringify(rec)); }

  async execute(quote: VenueQuote, ctx: ExecContext): Promise<{ handle: string }> {
    if (quote.venue !== this.id) throw new VenueError(this.id, `quote belongs to ${quote.venue}`);
    if (ctx.now() >= quote.expiresAt) throw new VenueError(this.id, 'quote has expired');
    const req = quote.request;
    this.checkPayout(req.to, req.payoutAddress);
    const dep = await this.driver.depositAddress(req.from);
    if (dep.memo) throw new VenueError(this.id, 'the deposit address requires a memo, which is not supported; nothing was sent');
    const handle = `exchange:${this.driver.name}:${ctx.now()}-${++this.seq}`;
    const rec: Rec = { from: req.from, to: req.to, amountIn: quote.amountIn.toString(), payoutAddress: req.payoutAddress, phase: 'deposit_sent' };
    await ctx.journal('exchange.send_deposit', { handle, exchange: this.driver.name, asset: req.from, to: dep.address, amount: rec.amountIn });
    try {
      rec.depositTxid = await sendAsset(ctx, req.from, dep.address, quote.amountIn);
    } catch (e) {
      throw new VenueError(this.id, `sending the deposit failed or is unconfirmed (${(e as Error).message}); it is not re-sent`, true);
    }
    await this.save(handle, rec);
    await ctx.journal('exchange.deposit_sent', { handle, txid: rec.depositTxid });
    return { handle };
  }

  private view(rec: Rec): RefillStatus {
    const ids = [rec.depositTxid, rec.payoutTxid].filter((x): x is string => !!x);
    const state: RefillStatus['state'] = (
      { deposit_sent: 'depositing', credited: 'processing', order_intent: 'processing', order_placed: 'processing', traded: 'processing', withdraw_intent: 'paying_out', withdrawing: 'paying_out', done: 'done', failed: 'failed', held: 'held' } as const
    )[rec.phase];
    const out: RefillStatus = { state, txids: ids };
    if (rec.detail) out.detail = rec.detail;
    if (rec.phase === 'done' && rec.received) out.received = BigInt(rec.received);
    return out;
  }

  /** Read-only view of the last recorded step. */
  async status(handle: string): Promise<RefillStatus> { return this.view(await this.load(handle)); }

  async advance(handle: string, ctx: ExecContext): Promise<RefillStatus> {
    const rec = await this.load(handle);
    const d = this.driver;
    const hold = async (detail: string): Promise<RefillStatus> => { rec.phase = 'held'; rec.detail = detail; await this.save(handle, rec); return this.view(rec); };

    if (rec.phase === 'deposit_sent') {
      const credited = await d.depositCredited(rec.from, rec.depositTxid!);
      if (credited === null) return this.view(rec);
      rec.credited = credited.toString();
      rec.phase = d.needsTrade(rec.from, rec.to) ? 'credited' : 'traded';
      if (rec.phase === 'traded') rec.traded = rec.credited;
      await this.save(handle, rec);
      await ctx.journal('exchange.deposit_credited', { handle, amount: rec.credited });
    }

    if (rec.phase === 'credited') {
      // Persist the intent, with the client id, before the order goes out.
      rec.clientId = `${ctx.now()}${String(++this.seq).padStart(3, '0')}`;
      rec.phase = 'order_intent';
      await this.save(handle, rec);
      await ctx.journal('exchange.market_order', { handle, from: rec.from, to: rec.to, amountIn: rec.credited, clientId: rec.clientId });
      try {
        // The input is what the exchange credited, never what was meant to arrive.
        const o = await d.marketOrder({ from: rec.from, to: rec.to, amountIn: BigInt(rec.credited!), clientId: rec.clientId });
        rec.orderId = o.orderId;
        rec.phase = 'order_placed';
        await this.save(handle, rec);
      } catch (e) {
        return hold(`market order outcome unknown (${(e as Error).message}); check the exchange account. It is not placed again.`);
      }
    } else if (rec.phase === 'order_intent') {
      return hold('a market order was being placed when the process stopped; check the exchange account. It is not placed again.');
    }

    if (rec.phase === 'order_placed') {
      const o = await d.orderStatus(rec.orderId!, rec.from, rec.to);
      if (o.state === 'open') return this.view(rec);
      if (o.state === 'failed' || o.received === undefined) return hold(`market order ${rec.orderId} did not fill${o.detail ? ` (${o.detail})` : ''}; the deposit is on the exchange account`);
      rec.traded = o.received.toString();
      rec.phase = 'traded';
      await this.save(handle, rec);
      await ctx.journal('exchange.order_filled', { handle, orderId: rec.orderId, received: rec.traded });
    }

    if (rec.phase === 'traded') {
      const amount = BigInt(rec.traded!);
      // The key map or the allow-list may have changed since the deposit: check again before asking for the withdrawal.
      try { this.checkPayout(rec.to, rec.payoutAddress); } catch (e) { return hold(`${(e as Error).message}. The funds are on the exchange account; no withdrawal was requested.`); }
      rec.withdrawAmount = amount.toString();
      rec.phase = 'withdraw_intent';
      await this.save(handle, rec);
      await ctx.journal('exchange.withdraw', { handle, asset: rec.to, address: rec.payoutAddress, amount: rec.withdrawAmount });
      try {
        const w = await d.withdraw({ asset: rec.to, address: rec.payoutAddress, amount });
        rec.withdrawalId = w.withdrawalId;
        rec.phase = 'withdrawing';
        await this.save(handle, rec);
      } catch (e) {
        return hold(`withdrawal outcome unknown (${(e as Error).message}); check the exchange account. It is not requested again.`);
      }
    } else if (rec.phase === 'withdraw_intent') {
      return hold('a withdrawal was being requested when the process stopped; check the exchange account. It is not requested again.');
    }

    if (rec.phase === 'withdrawing') {
      const w = await d.withdrawalStatus(rec.to, rec.withdrawalId!);
      if (w.txid) rec.payoutTxid = w.txid;
      if (w.state === 'sent') {
        rec.phase = 'done';
        rec.received = (w.amount ?? BigInt(rec.withdrawAmount!)).toString();
        await ctx.journal('exchange.withdrawn', { handle, txid: w.txid ?? null, amount: fromAtomic(rec.to, BigInt(rec.received)) });
      } else if (w.state === 'held') {
        rec.detail = w.detail ?? 'the exchange is holding the withdrawal';
        await this.save(handle, rec);
        return { ...this.view(rec), state: 'held' };
      } else if (w.state === 'failed') {
        rec.phase = 'failed';
        rec.detail = `withdrawal failed${w.detail ? ` (${w.detail})` : ''}; the funds are on the exchange account`;
      } else {
        delete rec.detail;
      }
      await this.save(handle, rec);
    }
    return this.view(rec);
  }
}
