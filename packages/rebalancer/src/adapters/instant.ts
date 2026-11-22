/**
 * Shared flow of the four instant-swap adapters: quote by API, create an order, check what the
 * service created against what was asked, then send the paying asset to the one-time deposit
 * address through `ExecContext`.
 */
import { ADDRESS_FAMILY, costAgainstReference, mulDivCeil, unitsForUsd, usdValue } from '../assets.js';
import { type EnvReader, type HttpClient, processEnv } from '../http.js';
import { type AssetId, type ExecContext, type PriceSource, type RefillRequest, type RefillStatus, type VenueAdapter, type VenueId, type VenueQuote, VenueError } from '../types.js';

export interface InstantDeps {
  http: HttpClient;
  prices: PriceSource;
  /** Names of the environment variables holding the credentials. The values are read at call time and never stored, logged or journalled. */
  apiKeyEnv?: string | undefined;
  apiSecretEnv?: string | undefined;
  env?: EnvReader;
  baseUrl?: string;
  /** Unix seconds. */
  now?: () => number;
  /** Network fee, in USD, of sending the paying asset to the deposit address. Added to the quoted cost. */
  depositFeeUsd?: (asset: AssetId) => number;
}

export interface Estimate { amountIn: bigint; amountOut: bigint; expiresAt?: number; raw: unknown }
export interface CreatedOrder {
  orderId: string;
  depositAddress: string;
  /** What the service expects to receive, when it says. */
  depositAmount?: bigint;
  /** The payout address the service recorded, when it echoes it. */
  payoutAddress?: string;
  /** A deposit memo or tag. None of the five assets uses one, so an order that asks for one is refused. */
  memo?: string;
  /** Extra handle fields (FixedFloat's order token). */
  extra?: string[];
}

/** The service may ask for at most this much more than the quote before the order is abandoned unsent. */
const DEPOSIT_TOLERANCE_BPS = 50n;

export function sendAsset(ctx: ExecContext, asset: AssetId, to: string, amount: bigint): Promise<string> {
  switch (asset) {
    case 'xmr': return ctx.sendXmr({ to, amount });
    case 'sol': case 'usdc_sol': return ctx.sendSol({ kind: 'transfer', asset, to, amount });
    case 'eth': case 'usdc_eth': return ctx.sendEth({ asset, to, amount });
  }
}

export function sameAddress(asset: AssetId, a: string, b: string): boolean {
  return ADDRESS_FAMILY[asset] === 'eth' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export abstract class InstantSwapAdapter implements VenueAdapter {
  abstract readonly id: VenueId;
  /** Whether the service needs a secret as well as a key. */
  protected readonly needsSecret: boolean = false;
  protected readonly http: HttpClient;
  protected readonly prices: PriceSource;
  protected readonly now: () => number;
  private readonly env: EnvReader;
  private readonly keyEnv: string | undefined;
  private readonly secretEnv: string | undefined;
  private readonly depositFeeUsd: (asset: AssetId) => number;

  constructor(deps: InstantDeps) {
    this.http = deps.http;
    this.prices = deps.prices;
    this.env = deps.env ?? processEnv;
    this.keyEnv = deps.apiKeyEnv;
    this.secretEnv = deps.apiSecretEnv;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.depositFeeUsd = deps.depositFeeUsd ?? (() => 0);
  }

  // ---- what each service implements
  protected abstract estimate(req: RefillRequest, amount: { amountIn: bigint } | { amountOut: bigint }): Promise<Estimate>;
  /** Whether the service can price a fixed output directly for this request. */
  protected abstract canQuoteByOutput(req: RefillRequest): boolean;
  protected abstract range(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }>;
  protected abstract create(quote: VenueQuote): Promise<CreatedOrder>;
  protected abstract fetchStatus(orderId: string, extra: string[]): Promise<RefillStatus>;

  // ---- credentials
  protected apiKey(): string { return this.credential(this.keyEnv, 'API key'); }
  protected apiSecret(): string { return this.credential(this.secretEnv, 'API secret'); }
  private credential(name: string | undefined, what: string): string {
    if (!name) throw new VenueError(this.id, `no environment variable is configured for the ${what}`);
    const v = this.env(name);
    if (!v) throw new VenueError(this.id, `environment variable ${name} (${what}) is not set`);
    return v;
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    try {
      this.apiKey();
      if (this.needsSecret) this.apiSecret();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async limits(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    this.checkPair(from, to);
    return this.range(from, to);
  }

  protected checkPair(from: AssetId, to: AssetId): void {
    if (from === to) throw new VenueError(this.id, 'from and to are the same asset');
  }

  async quote(req: RefillRequest): Promise<VenueQuote> {
    this.checkPair(req.from, req.to);
    if ((req.amountIn === undefined) === (req.amountOut === undefined)) throw new VenueError(this.id, 'exactly one of amountIn and amountOut must be set');
    let est: Estimate;
    if (req.amountIn !== undefined) {
      est = await this.estimate(req, { amountIn: req.amountIn });
    } else if (this.canQuoteByOutput(req)) {
      est = await this.estimate(req, { amountOut: req.amountOut! });
    } else {
      // Price a probe at the reference rate, then scale the input so the output covers the request.
      const probeIn = await unitsForUsd(this.prices, req.from, await usdValue(this.prices, req.to, req.amountOut!));
      const probe = await this.estimate(req, { amountIn: probeIn });
      if (probe.amountOut <= 0n) throw new VenueError(this.id, 'the service quoted a zero output');
      est = await this.estimate(req, { amountIn: mulDivCeil(probeIn, req.amountOut!, probe.amountOut) });
    }
    if (est.amountIn <= 0n || est.amountOut <= 0n) throw new VenueError(this.id, 'the service quoted a zero amount');
    const cost = await costAgainstReference(this.prices, req.from, est.amountIn, req.to, est.amountOut, this.depositFeeUsd(req.from));
    return {
      venue: this.id, request: req, amountIn: est.amountIn, amountOut: est.amountOut,
      feesUsd: cost.feesUsd, costPct: cost.costPct, expiresAt: est.expiresAt ?? this.now() + 60, raw: est.raw,
    };
  }

  async execute(quote: VenueQuote, ctx: ExecContext): Promise<{ handle: string }> {
    if (quote.venue !== this.id) throw new VenueError(this.id, `quote belongs to ${quote.venue}`);
    if (ctx.now() >= quote.expiresAt) throw new VenueError(this.id, 'quote has expired');
    const req = quote.request;
    await ctx.journal(`${this.id}.create_order`, { from: req.from, to: req.to, amountIn: quote.amountIn.toString(), amountOut: quote.amountOut.toString(), rate: req.rate, payoutAddress: req.payoutAddress, refundAddress: req.refundAddress });
    const order = await this.create(quote);
    const handle = [this.id, order.orderId, ...(order.extra ?? [])].join(':');
    await ctx.journal(`${this.id}.order_created`, { handle, depositAddress: order.depositAddress, depositAmount: order.depositAmount?.toString() ?? null });

    // Nothing has been sent yet: any mismatch abandons the order, which then expires unfunded.
    if (order.payoutAddress !== undefined && !sameAddress(req.to, order.payoutAddress, req.payoutAddress)) {
      throw new VenueError(this.id, 'the order pays out to an address other than the one requested; nothing was sent');
    }
    if (order.memo) throw new VenueError(this.id, 'the order requires a deposit memo, which is not supported; nothing was sent');
    if (!order.depositAddress) throw new VenueError(this.id, 'the order has no deposit address; nothing was sent');
    const amount = order.depositAmount ?? quote.amountIn;
    if (amount > quote.amountIn + (quote.amountIn * DEPOSIT_TOLERANCE_BPS) / 10_000n) {
      throw new VenueError(this.id, 'the order asks for more than the quoted amount; nothing was sent');
    }

    await ctx.journal(`${this.id}.send_deposit`, { handle, asset: req.from, to: order.depositAddress, amount: amount.toString() });
    let txid: string;
    try {
      txid = await sendAsset(ctx, req.from, order.depositAddress, amount);
    } catch (e) {
      throw new VenueError(this.id, `sending the deposit for order ${order.orderId} failed or is unconfirmed (${(e as Error).message}); it is not re-sent`, true);
    }
    await ctx.journal(`${this.id}.deposit_sent`, { handle, txid });
    return { handle };
  }

  protected parseHandle(handle: string): { orderId: string; extra: string[] } {
    const [venue, orderId, ...extra] = handle.split(':');
    if (venue !== this.id || !orderId) throw new VenueError(this.id, 'not a handle of this venue');
    return { orderId, extra };
  }

  async status(handle: string): Promise<RefillStatus> {
    const { orderId, extra } = this.parseHandle(handle);
    return this.fetchStatus(orderId, extra);
  }
}

/** Drops empty entries from a transaction-id list. */
export function txids(...ids: (string | undefined | null)[]): string[] {
  return ids.filter((x): x is string => typeof x === 'string' && x !== '');
}

/** Per-venue asset codes. Each adapter exports its table; all are assumptions to re-check against the service's currency list. */
export type AssetTable<T> = Record<AssetId, T>;
