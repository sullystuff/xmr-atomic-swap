/**
 * Routing, limits and safety controls of SPEC 7.7 over a set of venue adapters.
 *
 * The daemon decides WHEN to refill (levels, schedule, manual run) and supplies the
 * `ExecContext`; this class decides WHERE and HOW MUCH, and refuses what the settings forbid:
 *
 * - payouts and refunds only to allow-listed own addresses;
 * - per-transaction, per-day and per-venue caps, and each venue's share of the daily cap;
 * - the in-transit cap across all venues;
 * - the total cost against the reference price (a refill is skipped when every venue exceeds it);
 * - a small test transfer first for any venue/address pair that has not completed a refill;
 * - modes `auto`, `approve` and `alert` per venue;
 * - stalled refills are cancelled where the venue allows it, the venue cools down, and the
 *   refill is retried on the next venue;
 * - every finished refill is written to the cost log.
 */
import { type Allowlist, assertRequestAllowed } from './allowlist.js';
import { toFloat, unitsForUsd, usdValue } from './assets.js';
import type { CostLog, CostLogEntry } from './cost-log.js';
import { type RebalanceMode, type RebalanceSettings, venueOrder } from './settings.js';
import { type AssetId, type ExecContext, type PriceSource, type RefillRequest, type RefillState, type RefillStatus, type VenueAdapter, type VenueId, type VenueQuote, VenueError } from './types.js';

export interface StateStore { load(): Promise<string | undefined>; save(snapshot: string): Promise<void> }

export type AlertKind = 'approval_needed' | 'refill_suggested' | 'skipped' | 'held' | 'stalled' | 'failed' | 'cancelled' | 'venue_cooldown' | 'test_transfer';
export interface RebalanceAlert { kind: AlertKind; message: string; venue?: VenueId; refillId?: string }

export type RecordState = 'awaiting_approval' | RefillState | 'cancelled';
const ACTIVE: readonly RecordState[] = ['pending', 'depositing', 'processing', 'paying_out', 'held'];

export interface RefillRecord {
  id: string;
  venue: VenueId;
  /** What this record sends (already cut to the caps, or to the test size). */
  request: RefillRequest;
  /** What is left of the refill once this record is done: set on a test transfer. */
  remainder: RefillRequest | null;
  state: RecordState;
  quote: VenueQuote;
  handle: string | null;
  /** Value sent, in USD at the reference price when the refill started. */
  valueUsd: number;
  referenceUsd: { from: number; to: number };
  startedAt: number;
  finishedAt: number | null;
  received: bigint | null;
  txids: string[];
  detail: string | null;
  test: boolean;
  /** Approved by the maker (approve mode); its continuation after a test transfer needs no second approval. */
  approved: boolean;
  /** Venues this refill has already been tried on. */
  tried: VenueId[];
  /** A failed refill whose funds may still sit with the venue: it keeps counting against the in-transit cap until acknowledged. */
  unresolved: boolean;
  alerted: AlertKind[];
}

export interface Candidate {
  venue: VenueId;
  ok: boolean;
  reason?: string;
  mode: RebalanceMode;
  test: boolean;
  quote?: VenueQuote;
  valueUsd?: number;
  remainder?: RefillRequest | null;
}
export interface RefillPlan { request: RefillRequest; candidates: Candidate[]; chosen: Candidate | null; reason: string | null }
export interface RunResult { outcome: 'executed' | 'awaiting_approval' | 'alerted' | 'skipped'; plan: RefillPlan; refill?: RefillRecord }
export interface RunOptions { venue?: VenueId; exclude?: VenueId[]; approved?: boolean; tried?: VenueId[] }

export interface RebalancerDeps {
  settings: RebalanceSettings;
  adapters: Partial<Record<VenueId, VenueAdapter>>;
  prices: PriceSource;
  /** Defaults to `settings.allowlist`. The daemon fills it with the inventory wallet and the operator and payout addresses. */
  allowlist?: Allowlist;
  /** Unix seconds. */
  now: () => number;
  costLog?: CostLog;
  state?: StateStore;
  onAlert?: (alert: RebalanceAlert) => void;
}

interface Snapshot { records: RefillRecord[]; ledger: { t: number; venue: VenueId; usd: number; id: string }[]; cooldowns: Partial<Record<VenueId, number>>; proven: string[]; seq: number }

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const reviver = (_k: string, v: unknown) => (v && typeof v === 'object' && typeof (v as { $bigint?: unknown }).$bigint === 'string' ? BigInt((v as { $bigint: string }).$bigint) : v);

const isUsdc = (a: AssetId) => a === 'usdc_sol' || a === 'usdc_eth';
const DAY = 86_400;

export class Rebalancer {
  private readonly d: RebalancerDeps;
  private readonly allow: Allowlist;
  private s: Snapshot = { records: [], ledger: [], cooldowns: {}, proven: [], seq: 0 };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: RebalancerDeps) {
    this.d = deps;
    this.allow = deps.allowlist ?? deps.settings.allowlist;
  }

  /** Loads persisted state. Call once before use when a `state` store is given. */
  async init(): Promise<void> {
    const raw = await this.d.state?.load();
    if (raw) this.s = JSON.parse(raw, reviver) as Snapshot;
  }

  private async persist(): Promise<void> { await this.d.state?.save(JSON.stringify(this.s, replacer)); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
  private alert(a: RebalanceAlert): void { try { this.d.onAlert?.(a); } catch { /* an alert sink must not break a refill */ } }
  private alertOnce(r: RefillRecord, kind: AlertKind, message: string): void {
    if (r.alerted.includes(kind)) return;
    r.alerted.push(kind);
    this.alert({ kind, message, venue: r.venue, refillId: r.id });
  }

  // ---------------------------------------------------------------- read side

  refills(): readonly RefillRecord[] { return this.s.records; }
  refill(id: string): RefillRecord {
    const r = this.s.records.find((x) => x.id === id);
    if (!r) throw new Error(`unknown refill ${id}`);
    return r;
  }
  /** Value sitting with third parties right now, in USD. */
  inTransitUsd(): number {
    return this.s.records.reduce((a, r) => a + (ACTIVE.includes(r.state) || r.unresolved ? r.valueUsd : 0), 0);
  }
  /** USD started in the trailing 24 hours, in total or on one venue. */
  daySpentUsd(venue?: VenueId): number {
    const since = this.d.now() - DAY;
    return this.s.ledger.reduce((a, e) => a + (e.t > since && (!venue || e.venue === venue) ? e.usd : 0), 0);
  }
  cooldownUntil(venue: VenueId): number | null {
    const u = this.s.cooldowns[venue];
    return u !== undefined && u > this.d.now() ? u : null;
  }
  mode(venue: VenueId): RebalanceMode { return this.d.settings.venues[venue].mode ?? this.d.settings.mode; }
  private proven(venue: VenueId, address: string): boolean { return this.s.proven.includes(`${venue}|${address}`); }

  private cool(venue: VenueId, why: string): void {
    const minutes = this.d.settings.routing.cooldown_minutes;
    if (minutes <= 0) return;
    this.s.cooldowns[venue] = this.d.now() + minutes * 60;
    this.alert({ kind: 'venue_cooldown', venue, message: `${venue} is cooling down for ${minutes} min: ${why}` });
  }

  // ---------------------------------------------------------------- planning

  private async requestUsd(req: RefillRequest): Promise<number> {
    return req.amountIn !== undefined ? usdValue(this.d.prices, req.from, req.amountIn) : usdValue(this.d.prices, req.to, req.amountOut!);
  }

  /** The request cut down to `usd` of value at the reference price (never enlarged). */
  private async scale(req: RefillRequest, usd: number, requestedUsd: number): Promise<RefillRequest> {
    if (usd >= requestedUsd) return req;
    const out: RefillRequest = { ...req };
    if (req.amountIn !== undefined) {
      const a = await unitsForUsd(this.d.prices, req.from, usd);
      out.amountIn = a < req.amountIn ? a : req.amountIn;
    } else {
      const a = await unitsForUsd(this.d.prices, req.to, usd);
      out.amountOut = a < req.amountOut! ? a : req.amountOut!;
    }
    return out;
  }

  private minus(req: RefillRequest, part: RefillRequest): RefillRequest | null {
    const out: RefillRequest = { ...req };
    if (req.amountIn !== undefined) { out.amountIn = req.amountIn - (part.amountIn ?? 0n); return out.amountIn > 0n ? out : null; }
    out.amountOut = req.amountOut! - (part.amountOut ?? 0n);
    return out.amountOut > 0n ? out : null;
  }

  private plus(a: RefillRequest, b: RefillRequest | null): RefillRequest {
    if (!b) return a;
    const out: RefillRequest = { ...a };
    if (a.amountIn !== undefined && b.amountIn !== undefined) out.amountIn = a.amountIn + b.amountIn;
    else if (a.amountOut !== undefined && b.amountOut !== undefined) out.amountOut = a.amountOut + b.amountOut;
    return out;
  }

  /** Prices a refill on the enabled venues and applies every cap. Sends nothing. */
  async plan(req: RefillRequest, opts: RunOptions = {}): Promise<RefillPlan> {
    assertRequestAllowed(this.allow, req);
    if (req.from === req.to) throw new Error('from and to are the same asset');
    if ((req.amountIn === undefined) === (req.amountOut === undefined)) throw new Error('exactly one of amountIn and amountOut must be set');
    if ((req.amountIn ?? req.amountOut!) <= 0n) throw new Error('amount must be positive');
    const st = this.d.settings;
    const plan: RefillPlan = { request: req, candidates: [], chosen: null, reason: null };
    const requestedUsd = await this.requestUsd(req);

    // Moving USDC between chains is its own switch, venue and limits.
    const cross = isUsdc(req.from) && isUsdc(req.to);
    if (cross && !st.cross_chain.enabled) { plan.reason = 'cross-chain moves are off ([rebalance.cross_chain])'; return plan; }

    const caps: [string, number][] = [
      ['max_per_tx_usd', st.routing.max_per_tx_usd ?? Infinity],
      ['max_per_day_usd', (st.routing.max_per_day_usd ?? Infinity) - this.daySpentUsd()],
      ['max_in_transit_usd', (st.max_in_transit_usd ?? Infinity) - this.inTransitUsd()],
    ];
    if (cross) caps.push(['cross_chain.max_per_tx_usd', st.cross_chain.max_per_tx_usd ?? Infinity]);
    const tightest = (list: [string, number][]) => list.reduce((a, b) => (b[1] < a[1] ? b : a));
    const global = tightest(caps);
    if (global[1] <= 0) { plan.reason = `${global[0]} is used up`; return plan; }

    const order = venueOrder(st).filter((v) => (!opts.venue || v === opts.venue) && (!cross || v === st.cross_chain.venue));
    for (const venue of order) {
      const vs = st.venues[venue];
      const c: Candidate = { venue, ok: false, mode: this.mode(venue), test: false };
      const no = (reason: string) => { c.reason = reason; plan.candidates.push(c); };
      const adapter = this.d.adapters[venue];
      if (!vs.enabled) continue;
      if (!adapter) { no('no adapter is configured'); continue; }
      if (opts.exclude?.includes(venue)) { no('already tried for this refill'); continue; }
      const cd = this.cooldownUntil(venue);
      if (cd) { no(`cooling down for another ${Math.ceil((cd - this.d.now()) / 60)} min`); continue; }

      try {
        const health = await adapter.health();
        if (!health.ok) { no(`unhealthy: ${health.reason ?? 'no reason given'}`); continue; }

        const share = vs.max_share_pct ?? st.routing.max_share_pct;
        const venueCap = tightest([
          global,
          [`venues.${venue}.max_per_tx_usd`, vs.max_per_tx_usd ?? Infinity],
          [`venues.${venue}.max_per_day_usd`, (vs.max_per_day_usd ?? Infinity) - this.daySpentUsd(venue)],
          ['max_share_pct', share !== undefined && st.routing.max_per_day_usd !== undefined ? (share / 100) * st.routing.max_per_day_usd - this.daySpentUsd(venue) : Infinity],
        ]);
        if (venueCap[1] <= 0) { no(`${venueCap[0]} is used up`); continue; }
        let allowedUsd = Math.min(requestedUsd, venueCap[1]);

        const limits = await adapter.limits(req.from, req.to);
        const minUsd = await usdValue(this.d.prices, req.from, limits.min);
        if (limits.max !== null) allowedUsd = Math.min(allowedUsd, await usdValue(this.d.prices, req.from, limits.max));
        if (allowedUsd < minUsd) { no(`${allowedUsd < requestedUsd ? `the caps leave ${allowedUsd.toFixed(2)} USD` : 'the amount is'} below the venue minimum (${minUsd.toFixed(2)} USD)`); continue; }

        // A venue/address pair that has never completed a refill gets a small one first.
        if (st.test_transfer_usd > 0 && !this.proven(venue, req.payoutAddress)) {
          c.test = true;
          allowedUsd = Math.min(allowedUsd, Math.max(st.test_transfer_usd, minUsd * 1.01));
        }

        let piece = await this.scale(req, allowedUsd, requestedUsd);
        const rate = (vs as { rate?: 'fixed' | 'float' }).rate;
        if (rate) piece = { ...piece, rate };
        const quote = await adapter.quote(piece);
        if (quote.venue !== venue) { no('the adapter returned a quote for another venue'); continue; }
        const valueUsd = await usdValue(this.d.prices, req.from, quote.amountIn);
        if (valueUsd > allowedUsd * 1.02) { no(`the quote needs ${valueUsd.toFixed(2)} USD, above the ${allowedUsd.toFixed(2)} USD the caps allow`); continue; }
        const limit = (cross ? st.cross_chain.max_cost_pct : undefined) ?? vs.max_cost_pct ?? st.max_cost_pct ?? Infinity;
        c.quote = quote;
        c.valueUsd = valueUsd;
        if (quote.costPct > limit) { no(`total cost ${quote.costPct.toFixed(2)}% is above the ${limit}% limit`); continue; }
        c.remainder = this.minus(req, piece);
        c.ok = true;
        plan.candidates.push(c);
        if (st.routing.choose === 'priority') break;
      } catch (e) {
        if (e instanceof Error && e.name === 'AllowlistError') throw e;
        no((e as Error).message);
      }
    }

    const ok = plan.candidates.filter((c) => c.ok);
    if (ok.length === 0) {
      plan.reason = plan.candidates.length === 0 ? 'no venue is enabled for this refill' : `no venue can take this refill: ${plan.candidates.map((c) => `${c.venue}: ${c.reason}`).join('; ')}`;
      return plan;
    }
    // Best net quote: the lowest total cost against the reference price. Ties go to the priority order.
    plan.chosen = st.routing.choose === 'priority' ? ok[0]! : ok.reduce((a, b) => (b.quote!.costPct < a.quote!.costPct ? b : a));
    return plan;
  }

  // ---------------------------------------------------------------- running

  private async newRecord(c: Candidate, tried: VenueId[], approved: boolean): Promise<RefillRecord> {
    const q = c.quote!;
    const r: RefillRecord = {
      id: `refill-${this.d.now()}-${++this.s.seq}`, venue: c.venue, request: q.request, remainder: c.remainder ?? null, state: 'awaiting_approval', quote: q, handle: null,
      valueUsd: c.valueUsd!, referenceUsd: { from: await this.d.prices.usd(q.request.from), to: await this.d.prices.usd(q.request.to) },
      startedAt: this.d.now(), finishedAt: null, received: null, txids: [], detail: null, test: c.test, approved, tried: [...tried, c.venue], unresolved: false, alerted: [],
    };
    this.s.records.push(r);
    return r;
  }

  /** Hands a record to its adapter. Returns false when the venue failed before anything was sent. */
  private async start(r: RefillRecord, ctx: ExecContext): Promise<boolean> {
    // Checked again at the last moment, whatever the caller did.
    assertRequestAllowed(this.allow, r.request);
    const adapter = this.d.adapters[r.venue]!;
    r.state = 'pending';
    r.startedAt = this.d.now();
    this.s.ledger = this.s.ledger.filter((e) => e.t > this.d.now() - DAY);
    this.s.ledger.push({ t: r.startedAt, venue: r.venue, usd: r.valueUsd, id: r.id });
    // On record, and counted against the caps, before the adapter sends anything.
    await this.persist();
    if (r.test) this.alert({ kind: 'test_transfer', venue: r.venue, refillId: r.id, message: `first transfer to this ${r.venue} address: sending a test of ${r.valueUsd.toFixed(2)} USD before the rest` });
    // Count what the adapter hands to the wallet, so a failure before any send is known to be clean whatever it threw.
    let sends = 0;
    const counting: ExecContext = {
      journal: (step, data) => ctx.journal(step, data),
      sendSol: (x) => { sends++; return ctx.sendSol(x); },
      sendEth: (x) => { sends++; return ctx.sendEth(x); },
      sendXmr: (x) => { sends++; return ctx.sendXmr(x); },
      now: () => ctx.now(),
    };
    try {
      r.handle = (await adapter.execute(r.quote, counting)).handle;
      await this.persist();
      return true;
    } catch (e) {
      const moved = sends > 0 && (e instanceof VenueError ? e.fundsMoved : true);
      r.detail = (e as Error).message;
      if (!moved) {
        r.state = 'failed';
        r.finishedAt = this.d.now();
        this.s.ledger = this.s.ledger.filter((x) => x.id !== r.id);
        this.cool(r.venue, r.detail);
        await this.persist();
        return false;
      }
      // Something may have left the wallet: park it for the maker and keep it counted as in transit.
      r.state = 'held';
      this.alertOnce(r, 'held', `${r.venue} refill needs review: ${r.detail}`);
      await this.persist();
      return true;
    }
  }

  private async runLocked(req: RefillRequest, ctx: ExecContext, opts: RunOptions): Promise<RunResult> {
    const exclude = [...(opts.exclude ?? [])];
    const tried = [...(opts.tried ?? [])];
    for (;;) {
      const plan = await this.plan(req, { ...opts, exclude });
      const c = plan.chosen;
      if (!c) {
        this.alert({ kind: 'skipped', message: `refill ${req.from} -> ${req.to} skipped: ${plan.reason}` });
        return { outcome: 'skipped', plan };
      }
      const mode = opts.approved ? 'auto' : c.mode;
      const q = c.quote!;
      const summary = `${c.venue}: ${toFloat(req.from, q.amountIn)} ${req.from} -> ${toFloat(req.to, q.amountOut)} ${req.to} at ${q.costPct.toFixed(2)}% total cost${c.test ? ' (test transfer)' : ''}`;
      if (mode === 'alert') {
        this.alert({ kind: 'refill_suggested', venue: c.venue, message: summary });
        return { outcome: 'alerted', plan };
      }
      const r = await this.newRecord(c, tried, !!opts.approved);
      if (mode === 'approve') {
        await this.persist();
        this.alertOnce(r, 'approval_needed', `approve refill ${r.id}? ${summary}`);
        return { outcome: 'awaiting_approval', plan, refill: r };
      }
      if (await this.start(r, ctx)) return { outcome: 'executed', plan, refill: r };
      // Clean failure before any send: the venue is cooling down; try the next one.
      exclude.push(c.venue);
      tried.push(c.venue);
    }
  }

  /** Plans a refill and, depending on the chosen venue's mode, executes it, queues it for approval, or only raises an alert. */
  run(req: RefillRequest, ctx: ExecContext, opts: RunOptions = {}): Promise<RunResult> {
    return this.serial(() => this.runLocked(req, ctx, opts));
  }

  /** Executes a refill that was waiting for approval, after pricing it again and re-applying every cap. */
  approve(id: string, ctx: ExecContext): Promise<RefillRecord> {
    return this.serial(async () => {
      const r = this.refill(id);
      if (r.state !== 'awaiting_approval') throw new Error(`refill ${id} is not waiting for approval`);
      const plan = await this.plan(this.plus(r.request, r.remainder), { venue: r.venue });
      const c = plan.chosen;
      if (!c) {
        r.state = 'cancelled';
        r.finishedAt = this.d.now();
        r.detail = `no longer possible: ${plan.reason}`;
        await this.persist();
        this.alertOnce(r, 'cancelled', `refill ${id} was approved but can no longer run: ${plan.reason}`);
        return r;
      }
      r.quote = c.quote!; r.request = c.quote!.request; r.remainder = c.remainder ?? null; r.valueUsd = c.valueUsd!; r.test = c.test; r.approved = true;
      await this.start(r, ctx);
      return r;
    });
  }

  /** Declines a refill that was waiting for approval. */
  reject(id: string): Promise<RefillRecord> {
    return this.serial(async () => {
      const r = this.refill(id);
      if (r.state !== 'awaiting_approval') throw new Error(`refill ${id} is not waiting for approval`);
      r.state = 'cancelled'; r.finishedAt = this.d.now(); r.detail = 'rejected by the maker';
      await this.persist();
      return r;
    });
  }

  /** Cancels a running refill where its venue allows it. */
  cancel(id: string, ctx: ExecContext): Promise<RefillRecord> {
    return this.serial(async () => {
      const r = this.refill(id);
      if (r.state === 'awaiting_approval') { r.state = 'cancelled'; r.finishedAt = this.d.now(); r.detail = 'cancelled by the maker'; await this.persist(); return r; }
      if (!ACTIVE.includes(r.state) || !r.handle) throw new Error(`refill ${id} is not running`);
      const adapter = this.d.adapters[r.venue]!;
      if (!adapter.cancel) throw new Error(`${r.venue} cannot cancel a refill`);
      await adapter.cancel(r.handle, ctx);
      await this.finish(r, 'cancelled', 'cancelled by the maker');
      await this.persist();
      return r;
    });
  }

  /** Resolves a held order where the venue offers a choice (ChangeNOW, FixedFloat). */
  resolveHeld(id: string, choice: 'continue' | 'refund', ctx: ExecContext): Promise<void> {
    return this.serial(async () => {
      const r = this.refill(id);
      const adapter = this.d.adapters[r.venue]!;
      if (r.state !== 'held' || !r.handle) throw new Error(`refill ${id} is not held`);
      if (!adapter.resolveHeld) throw new Error(`${r.venue} offers no way to resolve a held order; contact its support`);
      await adapter.resolveHeld(r.handle, choice, ctx);
    });
  }

  /**
   * The maker has dealt with a refill by hand. A failed one stops counting against the
   * in-transit cap; a held one (an ambiguous send, or a venue hold settled outside) is closed.
   */
  acknowledge(id: string): Promise<void> {
    return this.serial(async () => {
      const r = this.refill(id);
      if (r.state === 'held') await this.finish(r, 'failed', `${r.detail ? `${r.detail}; ` : ''}closed by the maker`);
      else if (r.state !== 'failed') throw new Error(`refill ${id} is neither held nor failed`);
      r.unresolved = false;
      await this.persist();
    });
  }

  // ---------------------------------------------------------------- tracking

  private timeoutSeconds(venue: VenueId): number {
    return (venue === 'wxmr_bridge' ? this.d.settings.venues.wxmr_bridge.stalled_redeem_minutes : this.d.settings.routing.venue_timeout_minutes) * 60;
  }

  private async finish(r: RefillRecord, outcome: CostLogEntry['outcome'], detail?: string): Promise<void> {
    r.state = outcome;
    r.finishedAt = this.d.now();
    if (detail) r.detail = detail;
    const q = r.quote;
    const inFloat = toFloat(r.request.from, q.amountIn);
    const gotUsd = r.received !== null ? toFloat(r.request.to, r.received) * r.referenceUsd.to : null;
    const measured = outcome === 'done' && gotUsd !== null && r.valueUsd > 0;
    await this.d.costLog?.append({
      id: r.id, venue: r.venue, from: r.request.from, to: r.request.to, amountIn: q.amountIn.toString(), amountOut: r.received?.toString() ?? null,
      rateType: r.request.rate, rate: r.received !== null && inFloat > 0 ? toFloat(r.request.to, r.received) / inFloat : null,
      referenceUsd: r.referenceUsd, valueInUsd: r.valueUsd, quotedCostPct: q.costPct, quotedFeesUsd: q.feesUsd,
      measuredCostPct: measured ? ((r.valueUsd - gotUsd) / r.valueUsd) * 100 : null, measuredFeesUsd: measured ? r.valueUsd - gotUsd : null,
      startedAt: r.startedAt, finishedAt: r.finishedAt, outcome, testTransfer: r.test, txids: r.txids, detail: r.detail,
    });
  }

  /**
   * Polls every running refill once: records progress, finishes and logs completed ones, sends
   * the rest of a refill after its test transfer, and handles failures and stalls (cancel where
   * possible, cool the venue down, retry on the next venue). Returns the records it changed.
   */
  tick(ctx: ExecContext): Promise<RefillRecord[]> {
    return this.serial(async () => {
      const changed: RefillRecord[] = [];
      const followUps: { req: RefillRequest; opts: RunOptions }[] = [];
      for (const r of [...this.s.records]) {
        if (!ACTIVE.includes(r.state) || !r.handle) continue;
        const adapter = this.d.adapters[r.venue];
        if (!adapter) continue;
        const before = `${r.state}|${r.detail}|${r.txids.length}`;
        let st: RefillStatus | null = null;
        try {
          st = adapter.advance ? await adapter.advance(r.handle, ctx) : await adapter.status(r.handle);
        } catch (e) {
          r.detail = `status check failed: ${(e as Error).message}`;
        }
        if (st) {
          r.txids = [...new Set([...r.txids, ...st.txids])];
          if (st.received !== undefined) r.received = st.received;
          r.detail = st.detail ?? null;
          const retry = (): void => { followUps.push({ req: this.plus(r.request, r.remainder), opts: { exclude: r.tried, tried: r.tried } }); };
          if (st.state === 'done') {
            // An adapter that stopped early used less than was quoted; measure against what it used.
            if (st.unfilled !== undefined && st.unfilled > 0n && st.unfilled < r.quote.amountIn) {
              r.valueUsd *= toFloat(r.request.from, r.quote.amountIn - st.unfilled) / toFloat(r.request.from, r.quote.amountIn);
              r.quote = { ...r.quote, amountIn: r.quote.amountIn - st.unfilled };
            }
            await this.finish(r, 'done');
            if (!this.proven(r.venue, r.request.payoutAddress)) this.s.proven.push(`${r.venue}|${r.request.payoutAddress}`);
            if (st.unfilled !== undefined && st.unfilled > 0n) {
              // The venue could not take all of it: pass the rest to the next venue.
              const rest: RefillRequest = { from: r.request.from, to: r.request.to, amountIn: st.unfilled, rate: r.request.rate, payoutAddress: r.request.payoutAddress, refundAddress: r.request.refundAddress };
              followUps.push({ req: rest, opts: { exclude: r.tried, tried: r.tried } });
            }
            // The test transfer arrived: send the rest on the same venue. An approved refill needs no second approval.
            if (r.remainder) followUps.push({ req: r.remainder, opts: { venue: r.venue, approved: r.approved } });
          } else if (st.state === 'refunded') {
            await this.finish(r, 'refunded');
            this.cool(r.venue, 'the refill was refunded');
            retry();
          } else if (st.state === 'failed') {
            r.unresolved = !(st.unfilled !== undefined && st.unfilled >= r.quote.amountIn);
            await this.finish(r, 'failed');
            this.cool(r.venue, r.detail ?? 'the refill failed');
            this.alertOnce(r, 'failed', `${r.venue} refill ${r.id} failed${r.detail ? `: ${r.detail}` : ''}${r.unresolved ? '. Its value stays counted as in transit until acknowledged.' : ''}`);
            retry();
          } else {
            r.state = st.state;
            if (st.state === 'held') this.alertOnce(r, 'held', `${r.venue} is holding refill ${r.id}${r.detail ? `: ${r.detail}` : ''}`);
          }
        }
        // Stalled: past its timeout and not finished. A held order is the venue's decision and is not cancelled automatically.
        if (ACTIVE.includes(r.state) && r.state !== 'held' && this.d.now() - r.startedAt > this.timeoutSeconds(r.venue)) {
          const minutes = Math.round((this.d.now() - r.startedAt) / 60);
          let cancelled = false, why = 'the venue cannot cancel a refill';
          if (adapter.cancel) {
            try { await adapter.cancel(r.handle, ctx); cancelled = true; } catch (e) { why = (e as Error).message; }
          }
          // The cancel is tried again on every poll; the cooldown and the alert happen once.
          if (!r.alerted.includes('stalled')) this.cool(r.venue, `refill ${r.id} stalled for ${minutes} min`);
          if (cancelled) {
            await this.finish(r, 'cancelled', `stalled for ${minutes} min; cancelled and retried on the next venue`);
            if (!r.alerted.includes('stalled')) r.alerted.push('stalled');
            this.alert({ kind: 'stalled', venue: r.venue, refillId: r.id, message: `${r.venue} refill ${r.id} stalled for ${minutes} min and was cancelled; retrying on the next venue` });
            followUps.push({ req: this.plus(r.request, r.remainder), opts: { exclude: r.tried, tried: r.tried } });
          } else {
            // Still out there: it is not retried elsewhere, so the same value is never in two places.
            this.alertOnce(r, 'stalled', `${r.venue} refill ${r.id} has stalled for ${minutes} min and could not be cancelled (${why}); it is still being tracked`);
          }
        }
        if (before !== `${r.state}|${r.detail}|${r.txids.length}`) changed.push(r);
      }
      await this.persist();
      for (const f of followUps) {
        const res = await this.runLocked(f.req, ctx, f.opts);
        if (res.refill) changed.push(res.refill);
      }
      return changed;
    });
  }
}
