// Offer engine against the simulated program: what is published, when, and with what capacity.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { ata, sharePokValid } from '@xmrswap/sdk';
import { base58Decode } from '@xmrswap/protocol';
import { XMR } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
function usdc(w: World, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
const count = (w: World, name: string) => w.sim.names().filter((n) => n === name).length;

describe('offer engine', () => {
  it('publishes terms and keys once, then ONE refresh_offers per interval covering every market', async () => {
    const w = await makeWorld();
    usdc(w, 10_000_000_000n);
    const d = await w.boot();
    await d.start();
    expect(count(w, 'set_offer')).toBe(2);
    expect(count(w, 'refill_keys')).toBe(2); // 16 slots, 8 per instruction
    expect(count(w, 'refresh_offers')).toBe(1);
    const refresh = w.sim.landed.find((l) => l.name === 'refresh_offers')!;
    expect((refresh.args['offers'] as unknown[]).length).toBe(2);

    const sell = w.sim.offer(0, 0)!;
    // 150 USD × (1 + 2%) ÷ 100 USD per SOL = 1.53 SOL per XMR.
    expect(sell).toMatchObject({ enabled: 1, mode: 0, minXmr: XMR / 10n, maxXmr: 20n * XMR, validSecs: 60, wN: 600, dC: 5400, wC: 1800, wF: 604_800, depBps: 0 });
    expect(sell.prices[0]).toBe(1_530_000_000n);
    expect([...sell.depths]).toEqual([2, 0, 0]);
    // Capacity is the largest unlocked output less the fee reserve: one output funds one lock.
    expect(sell.capacityXmr).toBe(5_050_000_000_000n - 1_000_000_000n);
    expect(sell.poolFilled).toBe(0xffff);
    // Every published key has a row written before it was published, and a proof of knowledge bound to the maker PDA.
    const rows = d.store.shares({ purpose: 'pool:sol' });
    expect(rows).toHaveLength(16);
    const refill = w.sim.landed.find((l) => l.name === 'refill_keys')!;
    for (const slot of refill.args['slots'] as { share: Uint8Array; pok: Uint8Array }[]) {
      expect(d.store.shareByPub(Buffer.from(slot.share).toString('hex'))?.status).toBe('published');
      expect(sharePokValid(slot.share, base58Decode(w.sim.makerPda), slot.pok)).toBe(true);
    }
    const buy = w.sim.offer(1, 1)!;
    expect(buy.prices[0]).toBe(147_000_000n); // 150 × (1 − 2%) USDC
    // 10,000 USDC buys 68.03 XMR at that price; the offer's own maximum caps it.
    expect(buy.capacityXmr).toBe(20n * XMR);

    // Inside the interval nothing more is sent; after it, exactly one more refresh and nothing else.
    await d.offers.tick();
    expect(count(w, 'refresh_offers')).toBe(1);
    w.sim.warp(15);
    w.prices.xmr = 160;
    expect(await d.offers.tick()).toMatchObject({ published: true });
    expect(count(w, 'refresh_offers')).toBe(2);
    expect(count(w, 'set_offer')).toBe(2);
    expect(count(w, 'refill_keys')).toBe(2);
    expect(w.sim.offer(0, 0)!.prices[0]).toBe(1_632_000_000n);
    // Fees spent are tracked per update; occasional costs are listed apart.
    const fees = d.store.feesSince(0);
    expect(fees.filter((f) => f.kind === 'refresh_offers')).toHaveLength(2);
    expect(fees.filter((f) => f.kind === 'refill_keys')).toHaveLength(2);
    expect(d.offers.views().find((v) => v.market === 'sol' && v.direction === 'sell_xmr')).toMatchObject({ live: true, enabled: true, key_pool: { size: 16, available: 16 }, capacity_xmr: '5049000000000', price_tiers: [{ above_xmr: '0', price: '1632000000' }] });
    d.store.close();
  });

  it('counts only UNLOCKED outputs; exposure limits and the daily cap shrink the capacity', async () => {
    const w = await makeWorld(`${BASE_TOML.replace('[liquidity]', '[liquidity]\nmax_in_flight_xmr = 6')}`, { outputs: [] });
    w.xmr.addOutput(5_050_000_000_000n, { unlocked: false });
    const d = await w.boot();
    await d.start();
    expect(d.offers.latest().find((c) => c.offer.market === 'sol')!).toMatchObject({ enabled: false, reason: expect.stringMatching(/no capacity/) });
    expect(w.sim.offer(0, 0)).toBeNull(); // never published, nothing to disable
    // The output unlocks: the offer goes live at the next refresh.
    w.xmr.mine(10);
    w.xmr.addOutput(5_050_000_000_000n);
    await d.maintainInventory();
    w.sim.warp(15);
    await d.offers.tick();
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 1, capacityXmr: 5_049_000_000_000n });
    // A 4 XMR swap in flight leaves 2 XMR under the 6 XMR in-flight limit.
    const opened = w.sim.open({ direction: 0, xmr: 4n * XMR, makerSpendPub: w.sim.takePoolKey(0) });
    await d.executor.tick();
    expect(d.store.swap(opened.pda)).toBeDefined();
    w.sim.warp(15);
    await d.offers.tick();
    expect(w.sim.offer(0, 0)!.capacityXmr).toBe(2n * XMR);
    d.store.close();
  });

  it('the pause switch and a guardrail publish the offer as disabled; resuming brings it back', async () => {
    const w = await makeWorld(`${BASE_TOML}\n[guardrails]\nprice_band_usd = { min = 100, max = 200 }\n`);
    const d = await w.boot();
    await d.start();
    expect(w.sim.offer(0, 0)!.enabled).toBe(1);
    d.risk.setPaused(true, 'maintenance');
    await d.offers.tick();
    expect(w.sim.offer(0, 0)).toMatchObject({ enabled: 0, capacityXmr: 0n });
    expect(d.offers.views().find((v) => v.market === 'sol')!.disabled_reason).toBe('paused: maintenance');
    d.risk.setPaused(false);
    await d.offers.tick();
    expect(w.sim.offer(0, 0)!.enabled).toBe(1);
    // The reference leaves the hard band: never quote outside it.
    w.prices.xmr = 199;
    w.sim.warp(15);
    await d.offers.tick();
    expect(w.sim.offer(0, 0)!.enabled).toBe(0);
    expect(d.offers.latest().find((c) => c.offer.market === 'sol')!.reason).toMatch(/price_band/);
    d.store.close();
  });

  it('dry run shows the offers it would post and posts nothing', async () => {
    for (const toml of [BASE_TOML.replace('mode = "live"', 'mode = "dry_run"'), `${BASE_TOML}\n[guardrails]\ndry_run = true\n`]) {
      const w = await makeWorld(toml);
      const d = await w.boot();
      await d.start();
      expect(await d.offers.tick(true)).toMatchObject({ published: false, reason: expect.stringMatching(/dry run/) });
      expect(w.sim.fake.sent).toHaveLength(0);
      const v = d.offers.views().find((x) => x.market === 'sol' && x.direction === 'sell_xmr')!;
      expect(v).toMatchObject({ enabled: true, live: false, price_tiers: [{ above_xmr: '0', price: '1530000000' }] });
      d.store.close();
    }
  });

  it('move-triggered updates: refresh on a move beyond the trigger, not below it, not more often than the minimum, and as a keep-alive', async () => {
    const w = await makeWorld(`${BASE_TOML}\n[offers]\nupdate_interval_seconds = 10\nprice_move_trigger_pct = 0.5\nmin_refresh_interval_seconds = 5\n`);
    const d = await w.boot();
    await d.start();
    expect(count(w, 'refresh_offers')).toBe(1);
    w.sim.warp(6);
    w.prices.xmr = 150.3; // +0.2%
    expect((await d.offers.tick()).published).toBe(false);
    w.sim.warp(1);
    w.prices.xmr = 151.5; // +1%
    expect(await d.offers.tick()).toMatchObject({ published: true, reason: expect.stringMatching(/price moved 1\.00%/) });
    w.sim.warp(2);
    w.prices.xmr = 155;
    expect((await d.offers.tick()).published).toBe(false); // inside the minimum interval
    w.sim.warp(3);
    expect((await d.offers.tick()).published).toBe(true);
    // No move at all: the keep-alive goes out before the 60 s validity lapses.
    w.sim.warp(40);
    expect((await d.offers.tick()).published).toBe(false);
    w.sim.warp(9);
    expect(await d.offers.tick()).toMatchObject({ published: true, reason: 'keep-alive' });
    expect(count(w, 'refresh_offers')).toBe(4);
    d.store.close();
  });

  it('refills the key pool when few unused keys are left', async () => {
    const w = await makeWorld();
    const d = await w.boot();
    await d.start();
    for (let i = 0; i < 12; i++) w.sim.takePoolKey(0);
    w.sim.warp(15);
    await d.offers.tick();
    expect(count(w, 'refill_keys')).toBe(4); // 12 used slots: two more instructions
    const o = w.sim.offer(0, 0)!;
    expect(o.poolFilled & ~o.poolUsed).toBe(0xffff);
    expect(d.store.shares({ purpose: 'pool:sol' })).toHaveLength(28);
    d.store.close();
  });

  it('answers a quote request for an oversized swap with a taker-bound on-chain quote, inside the same limits', async () => {
    const w = await makeWorld(BASE_TOML.replace('max_xmr = 20\nconfirmation_depth = [{ above_xmr = 0, depth = 2 }]\n\n[markets.usdc_sol.buy_xmr]', 'max_xmr = 2\nconfirmation_depth = [{ above_xmr = 0, depth = 2 }]\n\n[markets.usdc_sol.buy_xmr]'));
    const d = await w.boot();
    await d.start();
    const ok = await d.offers.quoteOnRequest({ chain: 'solana', market: 'sol', direction: 'A', xmr: (4n * XMR).toString(), taker: w.sim.taker });
    expect(ok).toMatchObject({ t: 'quote_response', ok: true, chain: 'solana' });
    const posted = w.sim.landed.find((l) => l.name === 'post_quote')!;
    expect(posted.args['terms']).toMatchObject({ taker: w.sim.taker, xmr: 4n * XMR, amount: 6_120_000_000n, direction: 0, depth: 2 });
    expect(d.store.shares({ purpose: 'quote' })).toHaveLength(1);
    // Larger than any unlocked output: refused, nothing posted.
    expect(await d.offers.quoteOnRequest({ chain: 'solana', market: 'sol', direction: 'A', xmr: (9n * XMR).toString(), taker: w.sim.taker })).toMatchObject({ ok: false, detail: expect.stringMatching(/no unlocked XMR output/) });
    expect(await d.offers.quoteOnRequest({ chain: 'solana', market: 'usdc_sol', direction: 'A', xmr: XMR.toString(), taker: w.sim.taker })).toMatchObject({ ok: false });
    expect(w.sim.names().filter((n) => n === 'post_quote')).toHaveLength(1);
    d.store.close();
  });
});
