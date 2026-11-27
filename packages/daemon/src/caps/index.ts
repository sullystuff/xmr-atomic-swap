/**
 * The deployment's beta caps as the daemon sees them (SPEC 11.1): read per market from the
 * chain, never assumed. Only `lock` and `take` are ever refused by a cap, and the daemon sends
 * neither; what it must do is never invite an open the chain would refuse: offers and quotes
 * are sized to what the caps leave, and a cap that stops quoting is reported as exactly that
 * ("cap reached"), never as the maker's own limit.
 *
 * A fresh deployment reads switched on with zero caps: nothing can open. The daemon then starts
 * cleanly, publishes nothing, and says why.
 */
import { depositOf, payAmount, receiveAmount } from '@xmrswap/core-wasm';
import { type AssetCaps, type ChainName, ETH_NATIVE, MARKET_CHAIN, type Market, capsRefusal } from '@xmrswap/protocol';
import type { MarketCaps } from '@xmrswap/protocol/daemon-api';
import { type CapKind, type Pricing, capRoom, largestUnderCaps } from '@xmrswap/sdk';
import type { EthereumChain } from '../chains/ethereum.js';
import type { SolanaChain } from '../chains/solana.js';
import { errMsg } from '../util.js';

export const MARKETS: Market[] = ['sol', 'usdc_sol', 'eth', 'usdc_eth'];
const SOLANA_DEFAULT_KEY = '11111111111111111111111111111111';

export interface CapsReading {
  caps: AssetCaps;
  /** The configuration can no longer be changed: caps that are on stay as they are for good. */
  frozen: boolean;
  /** Local milliseconds. */
  at: number;
}

export interface CapsOptions {
  solana: () => SolanaChain | null;
  ethereum: () => EthereumChain | null;
  /** Ethereum: ownership was renounced (read with the upgrade status), so nobody can change the caps. */
  ethereumFrozen?: () => boolean;
  /** How long a reading is used before the chain is asked again, milliseconds. */
  ttlMs?: number;
  clock?: () => number;
}

/** What the caps allow of one offer right now. */
export interface CapFit {
  /** The largest size the caps accept, at most `hi`; `null` = not even the offer's minimum fits. */
  xmr: bigint | null;
  /** Which cap bound it (or refused it); `null` = the caps did not bind. */
  limit: CapKind | null;
}

export class Caps {
  private readings = new Map<Market, CapsReading>();
  private errors = new Map<ChainName, string>();
  private readonly ttl: number;
  /** Quote requests answered "cap reached" since the start (a dashboard figure). */
  refusedQuotes = 0;

  constructor(private readonly o: CapsOptions) {
    // Every sizing pass reads the chain afresh by default: an offer sized from a stale open value invites an open the chain refuses.
    this.ttl = o.ttlMs ?? 0;
  }
  private clock(): number {
    return (this.o.clock ?? Date.now)();
  }

  /** Read the caps of every connected chain. Opens are planned by takers against `confirmed`; the daemon sizes offers from the same view. */
  async refresh(force = false): Promise<void> {
    const t = this.clock();
    const fresh = (m: Market) => !force && this.readings.has(m) && t - this.readings.get(m)!.at < this.ttl;
    const sol = this.o.solana();
    if (sol && !(fresh('sol') && fresh('usdc_sol'))) {
      try {
        const config = await sol.client.getConfig('confirmed');
        if (!config) throw new Error('the program has no Config account');
        const frozen = config.admin === SOLANA_DEFAULT_KEY;
        for (const [market, asset] of [['sol', 0], ['usdc_sol', 1]] as const) this.readings.set(market, { caps: { on: config.capsOn !== 0, maxSwap: config.maxSwap[asset]!, maxOpen: config.maxOpen[asset]!, openValue: config.openValue[asset]! }, frozen, at: t });
        this.errors.delete('solana');
      } catch (e) {
        this.errors.set('solana', errMsg(e));
        this.readings.delete('sol');
        this.readings.delete('usdc_sol');
      }
    }
    const eth = this.o.ethereum();
    if (eth && !(fresh('eth') && fresh('usdc_eth'))) {
      try {
        const usdc = await eth.client.usdc(eth.tag);
        const frozen = this.o.ethereumFrozen?.() ?? false;
        for (const [market, token] of [['eth', ETH_NATIVE], ['usdc_eth', usdc]] as const) this.readings.set(market, { caps: await eth.client.capsOf(token as `0x${string}`, 'latest'), frozen, at: t });
        this.errors.delete('ethereum');
      } catch (e) {
        this.errors.set('ethereum', errMsg(e));
        this.readings.delete('eth');
        this.readings.delete('usdc_eth');
      }
    }
  }

  /** The last reading of a market's caps; `null` = its chain is not connected or could not be read. */
  of(market: Market): CapsReading | null {
    return this.readings.get(market) ?? null;
  }
  /** Whether a market's chain is connected at all (an unreadable connected chain fails closed; an unconfigured one has no caps to respect). */
  connected(market: Market): boolean {
    return MARKET_CHAIN[market] === 'solana' ? this.o.solana() !== null : this.o.ethereum() !== null;
  }
  errorOf(chain: ChainName): string | null {
    return this.errors.get(chain) ?? null;
  }

  /**
   * The largest size in `lo..hi` the caps accept for an offer priced by `priceAt` (asset base
   * units per XMR at a size), and which cap bound it. Direction B counts `amount + deposit`.
   */
  fit(caps: AssetCaps, o: { chain: ChainName; directionCode: 0 | 1; depositBps: number }, priceAt: (xmr: bigint) => bigint, lo: bigint, hi: bigint): CapFit {
    if (!caps.on) return { xmr: hi, limit: null };
    const pricing = (xmr: bigint): Pricing => {
      const price = priceAt(xmr);
      const amount = o.directionCode === 0 ? payAmount(xmr, price, o.chain) : receiveAmount(xmr, price, o.chain);
      return { price, depth: 0, amount, deposit: depositOf(amount, o.depositBps), fee: 0n };
    };
    const why = (xmr: bigint): CapKind | null => {
      const p = pricing(xmr);
      return capsRefusal(caps, o.directionCode, p.amount, p.deposit);
    };
    if (hi < lo) return { xmr: null, limit: why(lo) };
    const best = largestUnderCaps(caps, o.directionCode, pricing, lo, hi);
    if (!best) return { xmr: null, limit: why(lo) ?? 'OpenCapExceeded' };
    if (best.xmr === hi) return { xmr: hi, limit: null };
    return { xmr: best.xmr, limit: why(best.xmr + 1n) ?? why(hi) };
  }

  /** Plain words for a cap refusal: always starts with "cap reached", which the maker's own limits never do. */
  static reason(kind: CapKind, caps: AssetCaps, frozen = false): string {
    const room = capRoom(caps);
    if (caps.maxSwap === 0n && caps.maxOpen === 0n) return `cap reached: this deployment's caps are switched on and zero, so nothing can open until its admin sets them${frozen ? ' (the configuration is frozen: they stay zero for good)' : ' (a fresh deployment starts this way)'}`;
    if (kind === 'SwapCapExceeded') return `cap reached: one swap may be at most ${caps.maxSwap} base units during the beta, less than this offer's smallest swap`;
    return `cap reached: ${room?.headroom ?? 0n} of ${caps.maxOpen} base units of open value are left during the beta, less than this offer's smallest swap; it returns as open swaps settle`;
  }

  /** `status.caps` (SPEC 11.1): every market of a connected chain; `caps: null` when the chain could not be read. */
  view(): MarketCaps[] {
    const out: MarketCaps[] = [];
    for (const market of MARKETS) {
      if (!this.connected(market)) continue;
      const r = this.of(market);
      out.push({ market, caps: r ? { on: r.caps.on, max_swap: r.caps.maxSwap.toString(), max_open: r.caps.maxOpen.toString(), open_value: r.caps.openValue.toString(), headroom: (r.caps.maxOpen > r.caps.openValue ? r.caps.maxOpen - r.caps.openValue : 0n).toString(), frozen: r.frozen && r.caps.on } : null });
    }
    return out;
  }
}
