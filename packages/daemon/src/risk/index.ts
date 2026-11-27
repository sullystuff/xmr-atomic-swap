/**
 * Risk controls (DESIGN "Maker tools"; SPEC 7.1 `risk/`): maximum in-flight exposure, the
 * per-taker limit, depth by swap size (raised while nodes report reorgs), the daily volume cap
 * and the pause switch. Everything is computed from the database, so it survives a restart.
 */
import { SWAP_STATE } from '@xmrswap/protocol';
import type { Config, ResolvedOffer } from '../config/load.js';
import type { Store, SwapRow } from '../store/db.js';

/** States in which the maker has value committed (its XMR in A, its escrow in B). */
const IN_FLIGHT: number[] = [SWAP_STATE.ACTIVE, SWAP_STATE.NOTICED, SWAP_STATE.READY, SWAP_STATE.FROZEN, SWAP_STATE.ABORTED_FREE, SWAP_STATE.ABORTED_HOLD];

export class Risk {
  /** Set by the Monero monitor while nodes report a reorganisation. */
  reorgSeenAt: number | null = null;

  constructor(
    private readonly store: Store,
    private readonly cfg: () => Config,
  ) {}

  // ---------------------------------------------------------------- pause switch
  get paused(): boolean {
    return this.store.meta('paused') === '1';
  }
  get pauseReason(): string | null {
    return this.store.meta('pause_reason');
  }
  setPaused(paused: boolean, reason = ''): void {
    this.store.setMeta('paused', paused ? '1' : '0');
    this.store.setMeta('pause_reason', reason);
  }

  // ---------------------------------------------------------------- exposure
  /**
   * Swaps that hold a share of the limits: those in flight, and pending ones this maker has already said yes to (the
   * approval or funding may be sent, or mined and not yet final, while the row still reads PENDING).
   */
  private open(): SwapRow[] {
    return this.store.swaps({ open: true }).filter((s) => IN_FLIGHT.includes(s.state) || (s.state === SWAP_STATE.PENDING && Risk.approved(s)));
  }
  static approved(s: SwapRow): boolean {
    return s.facts.manual?.approve === true || (s.facts.manual?.approve === undefined && s.facts.approval?.approve === true);
  }
  inFlightXmr(exclude?: string): bigint {
    return this.open().filter((s) => s.ref !== exclude).reduce((a, s) => a + BigInt(s.xmr), 0n);
  }
  takerXmr(taker: string, exclude?: string): bigint {
    return this.open().filter((s) => s.taker === taker && s.ref !== exclude).reduce((a, s) => a + BigInt(s.xmr), 0n);
  }
  /** XMR of swaps this offer started in the last 24 hours (rejected and never-started ones do not count). */
  dailyXmr(market: string, direction: 0 | 1, exclude?: string): bigint {
    const since = this.store.now() - 86_400;
    return this.store
      .swaps()
      .filter((s) => s.market === market && s.direction === direction && s.opened_at >= since && s.ref !== exclude)
      .filter((s) => s.facts.approval?.approve !== false)
      .reduce((a, s) => a + BigInt(s.xmr), 0n);
  }
  /** XMR the offer may still start: what is left under the in-flight limit and the daily cap. `null` = unlimited. */
  remaining(o: ResolvedOffer): bigint | null {
    const c = this.cfg();
    const limits: bigint[] = [];
    if (c.maxInFlightXmr !== null) limits.push(c.maxInFlightXmr - this.inFlightXmr());
    if (o.dailyCapXmr !== null) limits.push(o.dailyCapXmr - this.dailyXmr(o.market, o.directionCode));
    if (limits.length === 0) return null;
    const m = limits.reduce((a, b) => (a < b ? a : b));
    return m > 0n ? m : 0n;
  }

  /** Whether a new (pending or just-seen) swap fits the limits. `reasons` are plain words for the console. */
  check(swap: { ref: string; taker: string; xmr: bigint }, o: ResolvedOffer): { ok: boolean; reasons: string[] } {
    const c = this.cfg();
    const reasons: string[] = [];
    if (this.paused) reasons.push('the maker is paused');
    if (c.maxInFlightXmr !== null && this.inFlightXmr(swap.ref) + swap.xmr > c.maxInFlightXmr) reasons.push('over the in-flight limit');
    if (c.maxPerTakerXmr !== null && this.takerXmr(swap.taker, swap.ref) + swap.xmr > c.maxPerTakerXmr) reasons.push('over the per-taker limit');
    if (o.dailyCapXmr !== null && this.dailyXmr(o.market, o.directionCode, swap.ref) + swap.xmr > o.dailyCapXmr) reasons.push('over the daily volume cap');
    return { ok: reasons.length === 0, reasons };
  }

  // ---------------------------------------------------------------- depth by size
  get reorgGuardActive(): boolean {
    const g = this.cfg().raw.guardrails.reorg_guard;
    return g.enabled && this.reorgSeenAt !== null && this.store.now() - this.reorgSeenAt < 3_600;
  }
  /** The depth tiers to publish: the configured ones, raised to `raise_depth_to` while the reorg guard is active. */
  depthTiers(o: ResolvedOffer): { aboveXmr: bigint; depth: number }[] {
    if (!this.reorgGuardActive) return o.depthTiers;
    const floor = this.cfg().raw.guardrails.reorg_guard.raise_depth_to;
    return o.depthTiers.map((t) => ({ aboveXmr: t.aboveXmr, depth: Math.max(t.depth, floor) }));
  }
  static depthFor(tiers: { aboveXmr: bigint; depth: number }[], xmr: bigint): number {
    return tiers.reduce((d, t) => (xmr >= t.aboveXmr ? t.depth : d), tiers[0]?.depth ?? 1);
  }
}
