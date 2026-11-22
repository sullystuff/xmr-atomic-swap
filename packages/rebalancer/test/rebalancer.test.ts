/**
 * Routing, caps and safety controls, with scripted venues. USDC -> XMR at reference prices
 * 1 and 400 USD.
 */
import { describe, expect, it } from 'vitest';
import {
  AllowlistError, type ExecContext, MemoryCostLog, type RebalanceAlert, Rebalancer, type RefillRequest, type RefillStatus, type VenueAdapter, type VenueId, type VenueQuote,
  VenueError, guardAdapter, measuredCostPct, parseRebalanceSettings,
} from '../src/index.js';
import { ALLOW, ETH_ADDR, SOL_ADDR, XMR_ADDR, XMR_ADDR_2, fakeCtx, prices } from './helpers.js';

const NOW = 1_800_000_000;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const req = (usd: number, over: Partial<RefillRequest> = {}): RefillRequest => ({ from: 'usdc_sol', to: 'xmr', amountIn: usdc(usd), rate: 'float', payoutAddress: XMR_ADDR, refundAddress: SOL_ADDR, ...over });

/** A venue that quotes at a fixed cost and reports whatever status the test sets. */
class Venue implements VenueAdapter {
  costPct: number;
  min = usdc(10);
  max: bigint | null = null;
  healthy: { ok: boolean; reason?: string } = { ok: true };
  quotes: RefillRequest[] = [];
  executed: VenueQuote[] = [];
  statuses = new Map<string, RefillStatus>();
  failExecute?: VenueError;
  cancelled: string[] = [];
  cancel?: (handle: string, ctx?: ExecContext) => Promise<void>;
  resolved: [string, string][] = [];
  resolveHeld?: (handle: string, choice: 'continue' | 'refund') => Promise<void>;
  constructor(readonly id: VenueId, costPct: number, opts: { cancellable?: boolean; resolvable?: boolean } = {}) {
    this.costPct = costPct;
    if (opts.cancellable) this.cancel = async (h) => { this.cancelled.push(h); };
    if (opts.resolvable) this.resolveHeld = async (h, c) => { this.resolved.push([h, c]); };
  }
  async health() { return this.healthy; }
  async limits() { return { min: this.min, max: this.max }; }
  async quote(r: RefillRequest): Promise<VenueQuote> {
    this.quotes.push(r);
    const amountIn = r.amountIn ?? (r.amountOut! * 400n) / 1_000_000n; // piconero -> micro-USDC at 400
    // amountOut in piconero: USD value less the cost, at 400 USD per XMR.
    const amountOut = BigInt(Math.floor((Number(amountIn) / 1e6) * (1 - this.costPct / 100) / 400 * 1e12));
    return { venue: this.id, request: r, amountIn, amountOut, feesUsd: (Number(amountIn) / 1e6) * this.costPct / 100, costPct: this.costPct, expiresAt: NOW + 10_000_000, raw: {} };
  }
  async execute(q: VenueQuote, ctx: ExecContext) {
    if (this.failExecute) throw this.failExecute;
    await ctx.journal(`${this.id}.send`, {});
    await ctx.sendSol({ kind: 'transfer', asset: 'usdc_sol', to: `${this.id}-deposit`, amount: q.amountIn });
    this.executed.push(q);
    const handle = `${this.id}:${this.executed.length}`;
    this.statuses.set(handle, { state: 'depositing', txids: [] });
    return { handle };
  }
  async status(handle: string) { return this.statuses.get(handle)!; }
  finish(handle: string, q: VenueQuote, over: Partial<RefillStatus> = {}) { this.statuses.set(handle, { state: 'done', received: q.amountOut, txids: ['payout'], ...over }); }
}

const VENUE_ENV: Partial<Record<VenueId, Record<string, unknown>>> = {
  changenow: { api_key_env: 'A' }, fixedfloat: { api_key_env: 'A', api_secret_env: 'B' }, stealthex: { api_key_env: 'A' }, houdiniswap: { api_key_env: 'A', api_secret_env: 'B' },
  exchange: { name: 'kraken', api_key_env: 'A', api_secret_env: 'B' },
};

function setup(o: { venues: Venue[]; settings?: Record<string, any>; venueSettings?: Partial<Record<VenueId, Record<string, unknown>>>; guard?: boolean }) {
  const venues: Record<string, unknown> = {};
  for (const v of o.venues) venues[v.id] = { enabled: true, ...VENUE_ENV[v.id], ...(o.venueSettings?.[v.id] ?? {}) };
  const { settings } = parseRebalanceSettings({ mode: 'auto', max_cost_pct: 1.5, ...(o.settings ?? {}), venues, allowlist: ALLOW });
  const ctx = fakeCtx(NOW);
  const alerts: RebalanceAlert[] = [];
  const costLog = new MemoryCostLog();
  const adapters: Partial<Record<VenueId, VenueAdapter>> = {};
  for (const v of o.venues) adapters[v.id] = v;
  let saved: string | undefined;
  const state = { load: async () => saved, save: async (s: string) => { saved = s; } };
  const rb = new Rebalancer({ settings, adapters, prices: prices(), now: () => ctx.clock.t, costLog, state, onAlert: (a) => alerts.push(a) });
  return { rb, ctx, alerts, costLog, settings, adapters, state, saved: () => saved };
}

describe('routing', () => {
  it('best_quote picks the lowest total cost among enabled venues', async () => {
    const cn = new Venue('changenow', 0.9), ff = new Venue('fixedfloat', 0.6), bridge = new Venue('wxmr_bridge', 0.8);
    const { rb, ctx } = setup({ venues: [cn, ff, bridge], settings: { routing: { choose: 'best_quote' } } });
    const res = await rb.run(req(1000), ctx);
    expect(res.outcome).toBe('executed');
    expect(res.refill!.venue).toBe('fixedfloat');
    expect(res.plan.candidates.map((c) => [c.venue, c.ok, c.quote?.costPct])).toEqual([['wxmr_bridge', true, 0.8], ['changenow', true, 0.9], ['fixedfloat', true, 0.6]]);
    expect(ff.executed).toHaveLength(1);
    expect(cn.executed).toHaveLength(0);
  });

  it('priority takes the first venue in order that qualifies, without asking the rest', async () => {
    const cn = new Venue('changenow', 0.9), ff = new Venue('fixedfloat', 0.6);
    const { rb, ctx } = setup({ venues: [cn, ff], settings: { routing: { choose: 'priority', priority: ['changenow', 'fixedfloat'] } } });
    expect((await rb.run(req(1000), ctx)).refill!.venue).toBe('changenow');
    expect(ff.quotes).toHaveLength(0);
  });

  it('priority falls through a venue that is unhealthy, over the cost limit or below its minimum', async () => {
    const a = new Venue('changenow', 0.5), b = new Venue('fixedfloat', 2.0), c = new Venue('stealthex', 0.5), d = new Venue('houdiniswap', 1.2);
    a.healthy = { ok: false, reason: 'environment variable CHANGENOW_KEY is not set' };
    c.min = usdc(5000);
    const { rb, ctx } = setup({ venues: [a, b, c, d], settings: { routing: { choose: 'priority', priority: ['changenow', 'fixedfloat', 'stealthex', 'houdiniswap'] } } });
    const res = await rb.run(req(1000), ctx);
    expect(res.refill!.venue).toBe('houdiniswap');
    expect(res.plan.candidates.map((x) => x.reason)).toEqual([
      'unhealthy: environment variable CHANGENOW_KEY is not set', 'total cost 2.00% is above the 1.5% limit', 'the amount is below the venue minimum (5000.00 USD)', undefined,
    ]);
  });

  it('uses each venue\'s configured rate type', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], venueSettings: { changenow: { rate: 'fixed' } } });
    await rb.run(req(1000), ctx);
    expect(cn.quotes[0]!.rate).toBe('fixed');
  });

  it('a manual run can name the venue', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx } = setup({ venues: [cn, ff], settings: { routing: { choose: 'best_quote' } } });
    expect((await rb.run(req(1000), ctx, { venue: 'fixedfloat' })).refill!.venue).toBe('fixedfloat');
  });
});

describe('cost limit', () => {
  it('skips the refill when every venue exceeds max_cost_pct, and sends nothing', async () => {
    const cn = new Venue('changenow', 1.6), ff = new Venue('fixedfloat', 2.4);
    const { rb, ctx, alerts } = setup({ venues: [cn, ff], settings: { routing: { choose: 'best_quote' } } });
    const res = await rb.run(req(1000), ctx);
    expect(res.outcome).toBe('skipped');
    expect(res.plan.reason).toMatch(/changenow: total cost 1.60% is above the 1.5% limit; fixedfloat: total cost 2.40% is above the 1.5% limit/);
    expect(ctx.sol).toEqual([]);
    expect(rb.refills()).toEqual([]);
    expect(alerts.map((a) => a.kind)).toEqual(['skipped']);
  });

  it('a venue\'s own max_cost_pct overrides the global one, in either direction', async () => {
    const bridge = new Venue('wxmr_bridge', 1.2), ff = new Venue('fixedfloat', 1.8);
    const { rb, ctx } = setup({ venues: [bridge, ff], venueSettings: { wxmr_bridge: { max_cost_pct: 1.0 }, fixedfloat: { max_cost_pct: 2.0 } }, settings: { routing: { choose: 'best_quote' } } });
    const res = await rb.run(req(1000), ctx);
    expect(res.refill!.venue).toBe('fixedfloat');
    expect(res.plan.candidates[0]).toMatchObject({ venue: 'wxmr_bridge', ok: false, reason: 'total cost 1.20% is above the 1% limit' });
  });

  it('exactly at the limit is allowed', async () => {
    const cn = new Venue('changenow', 1.5);
    const { rb, ctx } = setup({ venues: [cn] });
    expect((await rb.run(req(1000), ctx)).outcome).toBe('executed');
  });
});

describe('caps', () => {
  it('cuts a refill to max_per_tx_usd', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { routing: { max_per_tx_usd: 2000 } } });
    const res = await rb.run(req(5000), ctx);
    expect(res.refill!.quote.amountIn).toBe(usdc(2000));
    expect(ctx.sol[0]).toMatchObject({ amount: usdc(2000) });
  });

  it('enforces max_per_day_usd over a rolling 24 hours', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { routing: { max_per_day_usd: 3000 } } });
    expect((await rb.run(req(2000), ctx)).refill!.quote.amountIn).toBe(usdc(2000));
    expect((await rb.run(req(2000), ctx)).refill!.quote.amountIn).toBe(usdc(1000)); // only 1000 left today
    const third = await rb.run(req(2000), ctx);
    expect(third.outcome).toBe('skipped');
    expect(third.plan.reason).toBe('max_per_day_usd is used up');
    expect(rb.daySpentUsd()).toBe(3000);
    ctx.clock.t += 86_401;
    expect(rb.daySpentUsd()).toBe(0);
    expect((await rb.run(req(2000), ctx)).outcome).toBe('executed');
  });

  it('enforces per-venue per-transaction and per-day caps, moving on to the next venue', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx } = setup({ venues: [cn, ff], venueSettings: { changenow: { max_per_tx_usd: 500, max_per_day_usd: 800 } }, settings: { routing: { priority: ['changenow', 'fixedfloat'] } } });
    expect((await rb.run(req(1000), ctx)).refill).toMatchObject({ venue: 'changenow', valueUsd: 500 });
    expect((await rb.run(req(1000), ctx)).refill).toMatchObject({ venue: 'changenow', valueUsd: 300 });
    const third = await rb.run(req(1000), ctx);
    expect(third.refill).toMatchObject({ venue: 'fixedfloat', valueUsd: 1000 });
    expect(third.plan.candidates[0]).toMatchObject({ venue: 'changenow', reason: 'venues.changenow.max_per_day_usd is used up' });
  });

  it('caps each venue\'s share of the daily limit', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx } = setup({ venues: [cn, ff], settings: { routing: { priority: ['changenow', 'fixedfloat'], max_per_day_usd: 10_000, max_share_pct: 40 } } });
    expect((await rb.run(req(6000), ctx)).refill).toMatchObject({ venue: 'changenow', valueUsd: 4000 });
    expect((await rb.run(req(6000), ctx)).refill).toMatchObject({ venue: 'fixedfloat', valueUsd: 4000 });
    expect(rb.daySpentUsd('changenow')).toBe(4000);
  });

  it('respects the venue\'s own maximum, and will not go below its minimum', async () => {
    const cn = new Venue('changenow', 0.5);
    cn.max = usdc(700);
    const { rb, ctx } = setup({ venues: [cn], settings: { routing: { max_per_tx_usd: 5 } } });
    const small = await rb.run(req(1000), ctx);
    expect(small.outcome).toBe('skipped');
    expect(small.plan.reason).toMatch(/the caps leave 5.00 USD below the venue minimum \(10.00 USD\)/);
    const two = setup({ venues: [cn] });
    expect((await two.rb.run(req(1000), two.ctx)).refill!.quote.amountIn).toBe(usdc(700));
  });

  it('scales a refill asked for by output', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { routing: { max_per_tx_usd: 1000 } } });
    const { amountIn: _d, ...r } = req(0);
    const res = await rb.run({ ...r, amountOut: 5_000_000_000_000n }, ctx); // 5 XMR = 2000 USD
    expect(cn.quotes[0]!.amountOut).toBe(2_500_000_000_000n);
    expect(res.refill!.valueUsd).toBe(1000);
  });
});

describe('in-transit cap', () => {
  it('bounds the value sitting with third parties across all venues, and frees it when a refill finishes', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx } = setup({ venues: [cn, ff], settings: { max_in_transit_usd: 3000, routing: { priority: ['changenow', 'fixedfloat'] } } });
    const first = await rb.run(req(2000), ctx);
    expect(rb.inTransitUsd()).toBe(2000);
    const second = await rb.run(req(2000), ctx, { venue: 'fixedfloat' });
    expect(second.refill!.valueUsd).toBe(1000); // only 1000 of headroom left
    expect(rb.inTransitUsd()).toBe(3000);
    const third = await rb.run(req(500), ctx);
    expect(third.outcome).toBe('skipped');
    expect(third.plan.reason).toBe('max_in_transit_usd is used up');

    cn.finish(first.refill!.handle!, first.refill!.quote);
    await rb.tick(ctx);
    expect(rb.inTransitUsd()).toBe(1000);
    expect((await rb.run(req(500), ctx)).outcome).toBe('executed');
  });

  it('a held refill keeps counting; a failed one counts until the maker acknowledges it', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, alerts } = setup({ venues: [cn], settings: { max_in_transit_usd: 3000, routing: { cooldown_minutes: 0 } } });
    const r = (await rb.run(req(2000), ctx)).refill!;
    cn.statuses.set(r.handle!, { state: 'held', detail: 'compliance review', txids: [] });
    await rb.tick(ctx);
    await rb.tick(ctx);
    expect(rb.refill(r.id).state).toBe('held');
    expect(rb.inTransitUsd()).toBe(2000);
    expect(alerts.filter((a) => a.kind === 'held')).toHaveLength(1); // once, not on every poll

    cn.statuses.set(r.handle!, { state: 'failed', detail: 'venue error', txids: [] });
    await rb.tick(ctx);
    expect(rb.refill(r.id)).toMatchObject({ state: 'failed', unresolved: true });
    expect(rb.inTransitUsd()).toBe(2000);
    await rb.acknowledge(r.id);
    expect(rb.inTransitUsd()).toBe(0);
  });
});

describe('address allow-list', () => {
  it('refuses a payout or refund address that is not the maker\'s own, before any venue is asked', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn] });
    await expect(rb.run(req(1000, { payoutAddress: XMR_ADDR_2 }), ctx)).rejects.toThrow(AllowlistError);
    await expect(rb.run(req(1000, { refundAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }), ctx)).rejects.toThrow(/refund address for usdc_sol is not on the sol allow-list/);
    await expect(rb.plan(req(1000, { payoutAddress: XMR_ADDR_2 }))).rejects.toThrow(AllowlistError);
    expect(cn.quotes).toEqual([]);
    expect(ctx.sol).toEqual([]);
  });

  it('an empty allow-list allows nothing', async () => {
    const cn = new Venue('changenow', 0.5);
    const { settings } = parseRebalanceSettings({ mode: 'auto', venues: { changenow: { enabled: true, api_key_env: 'A' } } });
    const rb = new Rebalancer({ settings, adapters: { changenow: cn }, prices: prices(), now: () => NOW });
    await expect(rb.run(req(1000), fakeCtx(NOW))).rejects.toThrow(AllowlistError);
  });

  it('checks the address family of each side: a USDC-on-Ethereum payout needs an allow-listed ETH address (any letter case)', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { cross_chain: { enabled: true, venue: 'changenow' } } });
    const cross = (payoutAddress: string): RefillRequest => ({ from: 'usdc_sol', to: 'usdc_eth', amountIn: usdc(1000), rate: 'float', payoutAddress, refundAddress: SOL_ADDR });
    await expect(rb.plan(cross(SOL_ADDR))).rejects.toThrow(/payout address for usdc_eth is not on the eth allow-list/);
    await expect(rb.plan(cross('0x000000000000000000000000000000000000dEaD'))).rejects.toThrow(AllowlistError);
    expect((await rb.plan(cross(ETH_ADDR.toLowerCase()))).chosen).not.toBeNull();
  });

  it('is enforced again inside the adapter guard, for callers that bypass the rebalancer', async () => {
    const cn = new Venue('changenow', 0.5);
    const guarded = guardAdapter(cn, ALLOW);
    await expect(guarded.quote(req(1000, { payoutAddress: XMR_ADDR_2 }))).rejects.toThrow(AllowlistError);
    const q = await guarded.quote(req(1000));
    const ctx = fakeCtx(NOW);
    // A quote tampered with after it was priced is still refused at execute.
    await expect(guarded.execute({ ...q, request: { ...q.request, payoutAddress: XMR_ADDR_2 } }, ctx)).rejects.toThrow(AllowlistError);
    expect(ctx.sol).toEqual([]);
    expect((await guarded.execute(q, ctx)).handle).toBe('changenow:1');
    expect(guarded.id).toBe('changenow');
    expect(await guarded.health()).toEqual({ ok: true });
  });

  it('is checked again at the moment of execution, after an approval', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, settings } = setup({ venues: [cn], settings: { mode: 'approve' } });
    const pending = (await rb.run(req(1000), ctx)).refill!;
    settings.allowlist.xmr.length = 0; // the maker removed the address in the meantime
    await expect(rb.approve(pending.id, ctx)).rejects.toThrow(AllowlistError);
    expect(ctx.sol).toEqual([]);
  });
});

describe('test transfer', () => {
  it('sends a small first transfer to a new venue/address, and the rest only after it arrives', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, alerts } = setup({ venues: [cn], settings: { test_transfer_usd: 50 } });
    const first = await rb.run(req(2000), ctx);
    expect(first.refill).toMatchObject({ test: true, valueUsd: 50 });
    expect(first.refill!.remainder!.amountIn).toBe(usdc(1950));
    expect(ctx.sol.map((s) => (s as { amount: bigint }).amount)).toEqual([usdc(50)]);
    expect(alerts.some((a) => a.kind === 'test_transfer')).toBe(true);

    // Still in flight: nothing more goes out.
    await rb.tick(ctx);
    expect(ctx.sol).toHaveLength(1);

    cn.finish(first.refill!.handle!, first.refill!.quote);
    const changed = await rb.tick(ctx);
    expect(ctx.sol.map((s) => (s as { amount: bigint }).amount)).toEqual([usdc(50), usdc(1950)]);
    expect(changed.at(-1)).toMatchObject({ venue: 'changenow', test: false, valueUsd: 1950 });

    // The pair is now proven: the next refill goes out whole.
    cn.finish('changenow:2', changed.at(-1)!.quote);
    await rb.tick(ctx);
    expect((await rb.run(req(800), ctx)).refill).toMatchObject({ test: false, valueUsd: 800 });
  });

  it('a new address on a known venue is tested again', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, settings } = setup({ venues: [cn], settings: { test_transfer_usd: 50 } });
    settings.allowlist.xmr.push(XMR_ADDR_2);
    const first = (await rb.run(req(40), ctx)).refill!;
    expect(first).toMatchObject({ test: true, valueUsd: 40, remainder: null }); // smaller than the test size: it is its own test
    cn.finish(first.handle!, first.quote);
    await rb.tick(ctx);
    expect((await rb.run(req(1000), ctx)).refill!.test).toBe(false);
    expect((await rb.run(req(1000, { payoutAddress: XMR_ADDR_2 }), ctx)).refill).toMatchObject({ test: true, valueUsd: 50 });
  });

  it('a failed test transfer proves nothing and the rest is not sent to that venue', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { test_transfer_usd: 50 } });
    const first = (await rb.run(req(2000), ctx)).refill!;
    cn.statuses.set(first.handle!, { state: 'failed', detail: 'expired', txids: [] });
    await rb.tick(ctx);
    expect(ctx.sol).toHaveLength(1);
    ctx.clock.t += 3600; // past the cooldown
    await rb.acknowledge(first.id);
    expect((await rb.run(req(2000), ctx)).refill).toMatchObject({ test: true, valueUsd: 50 });
  });

  it('uses the venue minimum when it is above the test size', async () => {
    const cn = new Venue('changenow', 0.5);
    cn.min = usdc(80);
    const { rb, ctx } = setup({ venues: [cn], settings: { test_transfer_usd: 50 } });
    expect((await rb.run(req(2000), ctx)).refill!.valueUsd).toBeCloseTo(80.8, 6);
  });
});

describe('modes', () => {
  it('auto executes at once', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { mode: 'auto' } });
    const res = await rb.run(req(1000), ctx);
    expect(res.outcome).toBe('executed');
    expect(res.refill!.state).toBe('pending');
    expect(ctx.sol).toHaveLength(1);
  });

  it('approve queues the refill and sends nothing until the maker approves; approval re-prices and re-checks', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, alerts } = setup({ venues: [cn], settings: { mode: 'approve' } });
    const res = await rb.run(req(1000), ctx);
    expect(res.outcome).toBe('awaiting_approval');
    expect(res.refill!.state).toBe('awaiting_approval');
    expect(ctx.sol).toEqual([]);
    expect(rb.inTransitUsd()).toBe(0);
    expect(alerts.map((a) => a.kind)).toEqual(['approval_needed']);
    await rb.tick(ctx);
    expect(ctx.sol).toEqual([]);

    cn.costPct = 0.7; // the price moved while it waited
    const approved = await rb.approve(res.refill!.id, ctx);
    expect(approved.state).toBe('pending');
    expect(approved.quote.costPct).toBe(0.7);
    expect(ctx.sol).toHaveLength(1);
    await expect(rb.approve(res.refill!.id, ctx)).rejects.toThrow(/not waiting for approval/);
  });

  it('an approval is void when the refill no longer fits the cost limit', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { mode: 'approve' } });
    const res = await rb.run(req(1000), ctx);
    cn.costPct = 3;
    const r = await rb.approve(res.refill!.id, ctx);
    expect(r).toMatchObject({ state: 'cancelled', detail: expect.stringContaining('above the 1.5% limit') });
    expect(ctx.sol).toEqual([]);
  });

  it('a rejected refill is cancelled', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { mode: 'approve' } });
    const res = await rb.run(req(1000), ctx);
    expect((await rb.reject(res.refill!.id)).state).toBe('cancelled');
    await expect(rb.approve(res.refill!.id, ctx)).rejects.toThrow();
  });

  it('alert only raises an alert: no record, nothing sent, nothing to approve', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, alerts } = setup({ venues: [cn], settings: { mode: 'alert' } });
    const res = await rb.run(req(1000), ctx);
    expect(res.outcome).toBe('alerted');
    expect(res.refill).toBeUndefined();
    expect(rb.refills()).toEqual([]);
    expect(ctx.sol).toEqual([]);
    expect(alerts).toEqual([{ kind: 'refill_suggested', venue: 'changenow', message: 'changenow: 1000 usdc_sol -> 2.4875 xmr at 0.50% total cost' }]);
  });

  it('the mode can differ per venue', async () => {
    const cn = new Venue('changenow', 0.9), ff = new Venue('fixedfloat', 0.5);
    const { rb, ctx } = setup({ venues: [cn, ff], settings: { mode: 'approve', routing: { choose: 'best_quote' } }, venueSettings: { fixedfloat: { mode: 'auto' } } });
    expect(rb.mode('changenow')).toBe('approve');
    expect(rb.mode('fixedfloat')).toBe('auto');
    expect((await rb.run(req(1000), ctx)).outcome).toBe('executed');
    expect((await rb.run(req(1000), ctx, { venue: 'changenow' })).outcome).toBe('awaiting_approval');
  });

  it('after an approved test transfer the rest needs no second approval', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx } = setup({ venues: [cn], settings: { mode: 'approve', test_transfer_usd: 50 } });
    const res = await rb.run(req(1000), ctx);
    const r = await rb.approve(res.refill!.id, ctx);
    expect(r).toMatchObject({ test: true, valueUsd: 50, approved: true });
    cn.finish(r.handle!, r.quote);
    await rb.tick(ctx);
    expect(ctx.sol.map((s) => (s as { amount: bigint }).amount)).toEqual([usdc(50), usdc(950)]);
  });
});

describe('failure handling', () => {
  it('a venue that fails before sending anything cools down and the refill goes to the next venue at once', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    cn.failExecute = new VenueError('changenow', 'the order pays out to an address other than the one requested; nothing was sent', false);
    const { rb, ctx, alerts } = setup({ venues: [cn, ff], settings: { routing: { priority: ['changenow', 'fixedfloat'] } } });
    const res = await rb.run(req(1000), ctx);
    expect(res.refill!.venue).toBe('fixedfloat');
    expect(rb.refills().map((r) => [r.venue, r.state])).toEqual([['changenow', 'failed'], ['fixedfloat', 'pending']]);
    expect(rb.cooldownUntil('changenow')).toBe(NOW + 30 * 60);
    expect(rb.daySpentUsd('changenow')).toBe(0); // nothing was spent there
    expect(rb.inTransitUsd()).toBe(1000);
    expect(alerts.some((a) => a.kind === 'venue_cooldown' && a.venue === 'changenow')).toBe(true);

    // During the cooldown the venue is not asked; afterwards it is.
    cn.failExecute = undefined as unknown as VenueError;
    const quotesBefore = cn.quotes.length;
    await rb.run(req(1000), ctx);
    expect(cn.quotes.length).toBe(quotesBefore);
    ctx.clock.t += 30 * 60 + 1;
    expect((await rb.run(req(1000), ctx)).refill!.venue).toBe('changenow');
  });

  it('an ambiguous send is parked as held, kept in transit, and not retried elsewhere, until the maker closes it', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx, alerts, costLog } = setup({ venues: [cn, ff], settings: { routing: { priority: ['changenow', 'fixedfloat'] } } });
    // The wallet throws while sending: nobody knows whether the deposit went out.
    ctx.failNextSend = 'rpc timeout';
    const res = await rb.run(req(1000), ctx);
    expect(res.refill).toMatchObject({ venue: 'changenow', state: 'held', detail: 'rpc timeout' });
    expect(ff.executed).toEqual([]);
    expect(rb.inTransitUsd()).toBe(1000);
    expect(alerts.some((a) => a.kind === 'held')).toBe(true);
    await rb.tick(ctx);
    expect(rb.inTransitUsd()).toBe(1000);

    await rb.acknowledge(res.refill!.id);
    expect(rb.refill(res.refill!.id)).toMatchObject({ state: 'failed', detail: 'rpc timeout; closed by the maker' });
    expect(rb.inTransitUsd()).toBe(0);
    expect(costLog.entries[0]).toMatchObject({ outcome: 'failed', measuredCostPct: null });
    await expect(rb.acknowledge(res.refill!.id)).resolves.toBeUndefined();
  });

  it('any error thrown before the adapter hands anything to the wallet is a clean failure, whatever its type', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    cn.execute = async () => { throw new Error('POST https://api.changenow.io/v2/exchange -> 500'); };
    // A venue claiming funds moved without ever calling a sender is not believed either.
    ff.failExecute = new VenueError('fixedfloat', 'confused', true);
    const st = new Venue('stealthex', 1.0);
    const { rb, ctx } = setup({ venues: [cn, ff, st], settings: { routing: { priority: ['changenow', 'fixedfloat', 'stealthex'] } } });
    const res = await rb.run(req(1000), ctx);
    expect(rb.refills().map((r) => [r.venue, r.state])).toEqual([['changenow', 'failed'], ['fixedfloat', 'failed'], ['stealthex', 'pending']]);
    expect(res.refill!.venue).toBe('stealthex');
    expect(rb.inTransitUsd()).toBe(1000);
    expect(ctx.sol).toHaveLength(1);
  });

  it('a refunded refill is retried on the next venue, and the first venue cools down', async () => {
    const cn = new Venue('changenow', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx } = setup({ venues: [cn, ff], settings: { routing: { priority: ['changenow', 'fixedfloat'] } } });
    const first = (await rb.run(req(1000), ctx)).refill!;
    cn.statuses.set(first.handle!, { state: 'refunded', txids: ['refundtx'] });
    const changed = await rb.tick(ctx);
    expect(rb.refill(first.id).state).toBe('refunded');
    expect(changed.at(-1)).toMatchObject({ venue: 'fixedfloat', state: 'pending', tried: ['changenow', 'fixedfloat'] });
    expect(ff.executed[0]!.amountIn).toBe(usdc(1000));
    expect(rb.cooldownUntil('changenow')).not.toBeNull();
  });

  it('when a venue fills only part, the unfilled input goes to the next venue', async () => {
    const bridge = new Venue('wxmr_bridge', 0.5), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx, costLog } = setup({ venues: [bridge, ff], settings: { routing: { priority: ['wxmr_bridge', 'fixedfloat'] } } });
    const first = (await rb.run(req(3000), ctx)).refill!;
    // One of three pieces filled: 1000 USDC in, 2.4875 XMR out; 2000 USDC untouched.
    bridge.statuses.set(first.handle!, { state: 'done', received: 2_487_500_000_000n, unfilled: usdc(2000), txids: [] });
    await rb.tick(ctx);
    expect(ff.executed[0]!.amountIn).toBe(usdc(2000));
    expect(costLog.entries[0]).toMatchObject({ venue: 'wxmr_bridge', amountIn: '1000000000', valueInUsd: 1000 });
    expect(costLog.entries[0]!.measuredCostPct).toBeCloseTo(0.5, 6);
  });
});

describe('stalled refills', () => {
  it('cancels a stalled bridge redemption after stalled_redeem_minutes, cools the bridge down, and retries on the next venue', async () => {
    const bridge = new Venue('wxmr_bridge', 0.5, { cancellable: true }), ff = new Venue('fixedfloat', 0.9);
    const { rb, ctx, alerts, costLog } = setup({ venues: [bridge, ff], settings: { routing: { priority: ['wxmr_bridge', 'fixedfloat'] } }, venueSettings: { wxmr_bridge: { stalled_redeem_minutes: 60 } } });
    const first = (await rb.run(req(1000), ctx)).refill!;
    bridge.statuses.set(first.handle!, { state: 'processing', txids: ['swap'] });

    ctx.clock.t += 59 * 60;
    await rb.tick(ctx);
    expect(bridge.cancelled).toEqual([]);

    ctx.clock.t += 2 * 60;
    const changed = await rb.tick(ctx);
    expect(bridge.cancelled).toEqual([first.handle]);
    expect(rb.refill(first.id)).toMatchObject({ state: 'cancelled', detail: 'stalled for 61 min; cancelled and retried on the next venue' });
    expect(rb.cooldownUntil('wxmr_bridge')).toBe(ctx.clock.t + 30 * 60);
    expect(changed.at(-1)).toMatchObject({ venue: 'fixedfloat', state: 'pending' });
    expect(ff.executed).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === 'stalled')).toHaveLength(1);
    expect(costLog.entries[0]).toMatchObject({ venue: 'wxmr_bridge', outcome: 'cancelled', measuredCostPct: null });

    // While it cools down the bridge is skipped even though it is first in the order.
    expect((await rb.plan(req(1000))).candidates[0]).toMatchObject({ venue: 'wxmr_bridge', ok: false, reason: 'cooling down for another 30 min' });
  });

  it('other venues use venue_timeout_minutes', async () => {
    const cn = new Venue('changenow', 0.5, { cancellable: true });
    const { rb, ctx } = setup({ venues: [cn], settings: { routing: { venue_timeout_minutes: 120 } } });
    await rb.run(req(1000), ctx);
    ctx.clock.t += 119 * 60; await rb.tick(ctx);
    expect(cn.cancelled).toEqual([]);
    ctx.clock.t += 2 * 60; await rb.tick(ctx);
    expect(cn.cancelled).toHaveLength(1);
  });

  it('a stalled refill that cannot be cancelled keeps being tracked and is not sent a second time elsewhere', async () => {
    const bridge = new Venue('wxmr_bridge', 0.5), ff = new Venue('fixedfloat', 0.9);
    bridge.cancel = async () => { throw new VenueError('wxmr_bridge', '1 redemption(s) are already being sent by the bridge and can no longer be cancelled'); };
    const { rb, ctx, alerts } = setup({ venues: [bridge, ff], settings: { routing: { priority: ['wxmr_bridge', 'fixedfloat'] } } });
    const first = (await rb.run(req(1000), ctx)).refill!;
    bridge.statuses.set(first.handle!, { state: 'paying_out', txids: [] });
    ctx.clock.t += 61 * 60;
    await rb.tick(ctx);
    await rb.tick(ctx);
    expect(rb.refill(first.id).state).toBe('paying_out');
    expect(ff.executed).toEqual([]);
    expect(rb.inTransitUsd()).toBe(1000);
    expect(alerts.filter((a) => a.kind === 'stalled')).toHaveLength(1);
    expect(alerts.find((a) => a.kind === 'stalled')!.message).toMatch(/could not be cancelled \(wxmr_bridge: 1 redemption/);

    // It still completes normally if the bridge pays out late.
    bridge.finish(first.handle!, first.quote);
    await rb.tick(ctx);
    expect(rb.refill(first.id).state).toBe('done');
  });

  it('a venue with no cancel is alerted on and cooled down, once', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, alerts } = setup({ venues: [cn] });
    await rb.run(req(1000), ctx);
    ctx.clock.t += 121 * 60;
    await rb.tick(ctx); await rb.tick(ctx);
    expect(alerts.filter((a) => a.kind === 'stalled')).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === 'venue_cooldown')).toHaveLength(1);
  });

  it('a held order is not cancelled automatically; the maker resolves it', async () => {
    const ff = new Venue('fixedfloat', 0.5, { cancellable: true, resolvable: true });
    const { rb, ctx } = setup({ venues: [ff] });
    const r = (await rb.run(req(1000), ctx)).refill!;
    ff.statuses.set(r.handle!, { state: 'held', detail: 'emergency', txids: [] });
    ctx.clock.t += 500 * 60;
    await rb.tick(ctx);
    expect(ff.cancelled).toEqual([]);
    await rb.resolveHeld(r.id, 'refund', ctx);
    expect(ff.resolved).toEqual([[r.handle, 'refund']]);
  });
});

describe('cost log', () => {
  it('logs every finished refill with venue, rate, fees and time, and the measured cost', async () => {
    const cn = new Venue('changenow', 0.5);
    const { rb, ctx, costLog } = setup({ venues: [cn], venueSettings: { changenow: { rate: 'fixed' } } });
    const r = (await rb.run(req(2000), ctx)).refill!;
    ctx.clock.t += 900;
    // Quoted 4.975 XMR; 4.96 arrived.
    cn.finish(r.handle!, r.quote, { received: 4_960_000_000_000n, txids: ['payin', 'payout'] });
    await rb.tick(ctx);
    expect(costLog.entries).toHaveLength(1);
    const e = costLog.entries[0]!;
    expect(e).toMatchObject({
      id: r.id, venue: 'changenow', from: 'usdc_sol', to: 'xmr', amountIn: '2000000000', amountOut: '4960000000000', rateType: 'fixed',
      referenceUsd: { from: 1, to: 400 }, valueInUsd: 2000, quotedCostPct: 0.5, startedAt: NOW, finishedAt: NOW + 900, outcome: 'done', testTransfer: false, txids: ['payin', 'payout'],
    });
    expect(e.rate).toBeCloseTo(0.00248, 9);          // XMR per USDC
    expect(e.measuredFeesUsd).toBeCloseTo(16, 6);    // 2000 - 4.96 * 400
    expect(e.measuredCostPct).toBeCloseTo(0.8, 6);
    await rb.tick(ctx);
    expect(costLog.entries).toHaveLength(1);          // logged once
  });

  it('gives the offer engine a value-weighted measured cost, ignoring refills that did not complete', () => {
    const base = { id: 'x', venue: 'changenow' as const, from: 'usdc_sol' as const, to: 'xmr' as const, amountIn: '0', amountOut: '0', rateType: 'float' as const, rate: 1, referenceUsd: { from: 1, to: 400 }, quotedCostPct: 0, quotedFeesUsd: 0, measuredFeesUsd: 0, startedAt: 0, testTransfer: false, txids: [], detail: null };
    const entries = [
      { ...base, valueInUsd: 1000, measuredCostPct: 1.0, finishedAt: 100, outcome: 'done' as const },
      { ...base, valueInUsd: 3000, measuredCostPct: 0.6, finishedAt: 200, outcome: 'done' as const, venue: 'fixedfloat' as const },
      { ...base, valueInUsd: 9000, measuredCostPct: null, finishedAt: 300, outcome: 'failed' as const },
    ];
    expect(measuredCostPct(entries)).toBeCloseTo(0.7, 9);
    expect(measuredCostPct(entries, { since: 150 })).toBeCloseTo(0.6, 9);
    expect(measuredCostPct(entries, { venue: 'changenow' })).toBeCloseTo(1.0, 9);
    expect(measuredCostPct([])).toBeNull();
  });
});

describe('persistence', () => {
  it('saves before the adapter sends, and a restart resumes tracking with caps intact', async () => {
    const cn = new Venue('changenow', 0.5);
    const first = setup({ venues: [cn], settings: { max_in_transit_usd: 3000, routing: { max_per_day_usd: 5000 } } });
    let savedAtSend: string | undefined;
    const realSend = first.ctx.sendSol.bind(first.ctx);
    first.ctx.sendSol = async (s) => { savedAtSend = first.saved(); return realSend(s); };
    const r = (await first.rb.run(req(2000), first.ctx)).refill!;
    expect(JSON.parse(savedAtSend!).records[0]).toMatchObject({ id: r.id, state: 'pending', valueUsd: 2000 });

    const { settings } = parseRebalanceSettings({ mode: 'auto', max_cost_pct: 1.5, max_in_transit_usd: 3000, routing: { max_per_day_usd: 5000 }, venues: { changenow: { enabled: true, api_key_env: 'A' } }, allowlist: ALLOW });
    const costLog = new MemoryCostLog();
    const restarted = new Rebalancer({ settings, adapters: { changenow: cn }, prices: prices(), now: () => first.ctx.clock.t, state: first.state, costLog });
    await restarted.init();
    expect(restarted.inTransitUsd()).toBe(2000);
    expect(restarted.daySpentUsd()).toBe(2000);
    expect(restarted.refill(r.id).quote.amountIn).toBe(usdc(2000)); // bigint survived the round trip
    cn.finish(r.handle!, r.quote);
    await restarted.tick(first.ctx);
    expect(restarted.refill(r.id).state).toBe('done');
    expect(costLog.entries).toHaveLength(1);
  });
});

describe('cross-chain USDC', () => {
  const cross: RefillRequest = { from: 'usdc_sol', to: 'usdc_eth', amountIn: usdc(5000), rate: 'float', payoutAddress: ETH_ADDR, refundAddress: SOL_ADDR };
  class UsdcVenue extends Venue {
    override async quote(r: RefillRequest): Promise<VenueQuote> {
      this.quotes.push(r);
      const out = (r.amountIn! * BigInt(Math.round((100 - this.costPct) * 100))) / 10_000n;
      return { venue: this.id, request: r, amountIn: r.amountIn!, amountOut: out, feesUsd: 0, costPct: this.costPct, expiresAt: NOW + 1e6, raw: {} };
    }
  }

  it('is off unless [rebalance.cross_chain] is enabled, and then uses only its venue and its limits', async () => {
    const cn = new UsdcVenue('changenow', 0.3), ff = new UsdcVenue('fixedfloat', 0.1);
    const off = setup({ venues: [cn, ff] });
    expect(await off.rb.run(cross, off.ctx)).toMatchObject({ outcome: 'skipped', plan: { reason: 'cross-chain moves are off ([rebalance.cross_chain])' } });

    const on = setup({ venues: [cn, ff], settings: { routing: { choose: 'best_quote' }, cross_chain: { enabled: true, venue: 'changenow', max_per_tx_usd: 2000, max_cost_pct: 0.5 } } });
    const res = await on.rb.run(cross, on.ctx);
    expect(res.refill).toMatchObject({ venue: 'changenow', valueUsd: 2000 });
    expect(ff.quotes).toEqual([]);
    expect(on.ctx.sol[0]).toMatchObject({ amount: usdc(2000) });

    cn.costPct = 0.8;
    expect((await on.rb.run(cross, on.ctx)).plan.reason).toMatch(/total cost 0.80% is above the 0.5% limit/);
  });
});
