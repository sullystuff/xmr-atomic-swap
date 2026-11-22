// Rebalancer integration: the daemon's ExecContext, allow-list, state, triggers and views around
// `@xmrswap/rebalancer`. Venue HTTP is a fixture (hand-written, from the rebalancer package); no venue is contacted.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import type { HttpClient, HttpRequest } from '@xmrswap/rebalancer';
import { ata, seedSigner } from '@xmrswap/sdk';
import type { Daemon } from '../src/daemon.js';
import { AmbiguousSend } from '../src/rebalance/index.js';
import { XMR } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.resolve(here, '../../rebalancer/test/fixtures/changenow.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const DEPOSIT = seedSigner(new Uint8Array(32).fill(0x66)).publicKey;

const REBALANCE = `
[rebalance]
mode = "approve"
max_cost_pct = 1.5
max_in_transit_usd = 50000

[rebalance.levels.xmr]
low = 30
target = 40

[rebalance.venues.changenow]
enabled = true
api_key_env = "CHANGENOW_KEY"
`;

function venueHttp(w: World, status: () => Record<string, unknown>): HttpClient & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      const p = new URL(req.url).pathname;
      const body = p.endsWith('/exchange/estimated-amount') ? fixture['estimate_standard'] : p.endsWith('/exchange/range') ? fixture['range'] : p.endsWith('/exchange/by-id') ? status() : p.endsWith('/exchange') ? { ...fixture['create'], payinAddress: DEPOSIT, payoutAddress: w.xmr.walletAddress, refundAddress: w.keystore.solana.publicKey } : null;
      return body ? { status: 200, body: JSON.stringify(body) } : { status: 404, body: '{}' };
    },
  };
}
async function boot(toml = BASE_TOML + REBALANCE): Promise<{ w: World; d: Daemon; http: ReturnType<typeof venueHttp>; state: { status: Record<string, unknown> } }> {
  const w = await makeWorld(toml);
  w.prices.xmr = 400;
  w.prices.sol = 200;
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, 100_000_000_000n, true);
  w.sim.fake.setAccount(ata(w.keystore.solana.publicKey, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
  const state = { status: fixture['status_waiting']! };
  const http = venueHttp(w, () => state.status);
  const d = await w.boot({ venueHttp: http, env: (n) => (n === 'CHANGENOW_KEY' ? 'cn-secret' : undefined) });
  await d.start();
  return { w, d, http, state };
}

describe('rebalancer integration', () => {
  it('supplies the maker\'s own addresses as the allow-list (the package default allows nothing)', async () => {
    const { w, d } = await boot();
    expect(await d.rebalance.allowlist()).toEqual({ xmr: [w.xmr.walletAddress], sol: [w.keystore.solana.publicKey, w.sim.maker().payout], eth: [] });
    const listed = await boot(`${BASE_TOML}${REBALANCE}\n[rebalance.allowlist]\nxmr = ["4configured"]\n`);
    expect((await listed.d.rebalance.allowlist()).xmr).toEqual(['4configured']);
    d.store.close();
    listed.d.store.close();
  });

  it('a refill in approve mode waits for the maker, then pays the venue through the intent journal and tracks it to completion', async () => {
    const { w, d, http, state } = await boot();
    const queued = await d.rebalance.run({ from: 'usdc_sol', to: 'xmr', amountIn: 2_000_000_000n });
    expect(queued).toMatchObject({ venue: 'changenow', from: 'usdc_sol', to: 'xmr', amount_in: '2000000000', state: 'awaiting_approval' });
    expect(queued.cost_pct).toBeCloseTo(0.776, 3);
    expect(w.sim.fake.sent.length).toBe(w.sim.fake.sent.length);
    const sentBefore = w.sim.fake.sent.length;
    const view = await d.rebalance.view();
    expect(view).toMatchObject({ mode: 'approve', max_in_transit_usd: 50000 });
    expect(view.venues.find((v) => v.id === 'changenow')).toMatchObject({ enabled: true, mode: 'approve' });
    expect(view.venues.find((v) => v.id === 'fixedfloat')).toMatchObject({ enabled: false });
    expect(view.levels.find((l) => l.asset === 'xmr')).toMatchObject({ low: '30000000000000', target: '40000000000000', balance: '20200000000000' });

    const running = await d.rebalance.approve(queued.id);
    expect(running.state).not.toBe('awaiting_approval');
    // Exactly one transaction left: a USDC transfer to the venue's deposit address, signed by the operator.
    expect(w.sim.fake.sent.length).toBe(sentBefore + 1);
    const tx = Transaction.from(w.sim.fake.sent[sentBefore]!);
    expect(tx.instructions.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === ata(DEPOSIT, w.sim.usdcMint).toBase58()))).toBe(true);
    // The order names the maker's own XMR address for the payout and its own Solana address for a refund.
    const create = JSON.parse(http.requests.find((r) => r.method === 'POST')!.body!) as Record<string, string>;
    expect(create).toMatchObject({ address: w.xmr.walletAddress, refundAddress: w.keystore.solana.publicKey });
    expect(http.requests.every((r) => !r.url.includes('cn-secret'))).toBe(true);
    // Journalled: every adapter step, and the transfer as an intent that was `sent` before it was confirmed.
    const intents = d.store.intents({ kind: 'venue_transfer' });
    expect(intents.map((i) => i.payload['step'] ?? i.payload['label'])).toEqual(['changenow.create_order', 'changenow.order_created', 'changenow.send_deposit', 'transfer usdc_sol', 'changenow.deposit_sent']);
    expect(intents.find((i) => i.payload['label'])).toMatchObject({ status: 'confirmed', tx: expect.any(String) });
    expect((await d.rebalance.view()).in_transit_usd).toBeCloseTo(2000, 0);

    // The venue pays out: the tick picks it up; the state survives a restart.
    state.status = fixture['status_finished']!;
    await d.rebalance.tick();
    const done = (await d.rebalance.view()).refills[0]!;
    expect(done).toMatchObject({ id: queued.id, state: 'done', venue_order_id: 'cn4f8a21b7c9d3e0' });
    expect(d.rebalance.measuredCostPct()).toBeCloseTo(0.776, 3);
    d.store.close();
    const again = await w.boot({ venueHttp: http, env: () => 'cn-secret' });
    expect((await again.rebalance.view()).refills[0]).toMatchObject({ id: queued.id, state: 'done' });
    again.store.close();
  });

  it('refuses a payout to an address that is not the maker\'s own, and sends nothing in dry run', async () => {
    const { w, d } = await boot();
    const sent = w.sim.fake.sent.length;
    // A request that would pay out somewhere else is refused by the package before any quote; nothing leaves.
    await d.rebalance.view();
    const rb = (d.rebalance as unknown as { rebalancer: { run(req: unknown, ctx: unknown): Promise<unknown> } }).rebalancer;
    await expect(rb.run({ from: 'usdc_sol', to: 'xmr', amountIn: 2_000_000_000n, rate: 'float', payoutAddress: '4' + 'Z'.repeat(94), refundAddress: w.keystore.solana.publicKey }, d.rebalance.ctx)).rejects.toThrow(/allow-list/);
    await expect(rb.run({ from: 'usdc_sol', to: 'xmr', amountIn: 2_000_000_000n, rate: 'float', payoutAddress: w.xmr.walletAddress, refundAddress: DEPOSIT }, d.rebalance.ctx)).rejects.toThrow(/allow-list/);
    expect(w.sim.fake.sent.length).toBe(sent);
    d.store.close();
    const dry = await boot((BASE_TOML + REBALANCE).replace('mode = "live"', 'mode = "dry_run"'));
    await expect(dry.d.rebalance.ctx.sendSol({ kind: 'transfer', asset: 'sol', to: DEPOSIT, amount: 1n })).rejects.toThrow(/dry run/);
    await expect(dry.d.rebalance.ctx.sendXmr({ to: 'x', amount: 1n })).rejects.toThrow(/dry run/);
    expect(dry.w.sim.fake.sent).toHaveLength(0);
    dry.d.store.close();
  });

  it('ExecContext: resolves only after confirmation; an unconfirmed send is parked for review and never re-sent', async () => {
    const w = await makeWorld(BASE_TOML + REBALANCE);
    const d = await w.boot();
    await d.start();
    const sig = await d.rebalance.ctx.sendSol({ kind: 'transfer', asset: 'sol', to: DEPOSIT, amount: 1_000_000n });
    expect(w.sim.fake.transactions.has(sig)).toBe(true);
    expect(d.store.intents({ kind: 'venue_transfer' }).pop()).toMatchObject({ status: 'confirmed', tx: sig });
    // XMR goes through the inventory: built, stored, relayed once.
    const txid = await d.rebalance.ctx.sendXmr({ to: 'venue-xmr-deposit', amount: XMR });
    expect(w.xmr.relays).toContain(txid);
    // A transfer that is broadcast and then neither lands nor expires in time is ambiguous.
    (d.rebalance as unknown as { o: { confirmTimeoutMs: number; pollMs: number } }).o.confirmTimeoutMs = 50;
    (d.rebalance as unknown as { o: { confirmTimeoutMs: number; pollMs: number } }).o.pollMs = 10;
    w.sim.dropSends = 1;
    const before = w.sim.fake.sent.length;
    await expect(d.rebalance.ctx.sendSol({ kind: 'transfer', asset: 'sol', to: DEPOSIT, amount: 2_000_000n })).rejects.toBeInstanceOf(AmbiguousSend);
    expect(w.sim.fake.sent.length).toBe(before + 1);
    expect(d.store.intents({ kind: 'venue_transfer' }).pop()!.status).toBe('needs_review');
    expect(d.alerts.list().find((a) => a.kind === 'rebalance_send_ambiguous')!.level).toBe('critical');
    // A restart does not re-send a transfer it finds unresolved: it parks it.
    const id = d.store.planIntent('venue_transfer', null, { label: 'interrupted' });
    d.store.close();
    const again = await w.boot();
    await again.recover();
    expect(again.store.intent(id)!.status).toBe('needs_review');
    expect(w.sim.fake.sent.length).toBe(before + 1);
    again.store.close();
  });

  it('level triggers alert, and never act past the mode; a manual refill is recorded with its cost; reserve proofs go to the wallet', async () => {
    const { w, d } = await boot();
    await d.rebalance.tick();
    // XMR (20.2 unlocked) is under its low level of 30: an alert, and in approve mode a refill waiting for the maker.
    expect(d.alerts.list().find((a) => a.kind === 'level_refill')!.message).toMatch(/xmr is below its low level/);
    const view = await d.rebalance.view();
    expect(view.refills).toHaveLength(1);
    expect(view.refills[0]).toMatchObject({ state: 'awaiting_approval', to: 'xmr' });
    const cancelled = await d.rebalance.cancel(view.refills[0]!.id);
    expect(cancelled.state).toBe('cancelled');
    const manual = d.rebalance.manual({ from: 'usdc_sol', to: 'xmr', amount_in: '4040000000', amount_out: (10n * XMR).toString(), note: 'OTC' });
    expect(manual).toMatchObject({ venue: 'manual', state: 'done', detail: 'OTC' });
    expect(manual.cost_pct).toBeCloseTo(0.990099, 4); // 4,040 USD for 10 XMR at 400
    expect((await d.rebalance.view()).refills.some((r) => r.venue === 'manual')).toBe(true);
    await expect(d.rebalance.reserveVerifier.check({ address: 'a', message: 'm', signature: 's' })).rejects.toThrow(/cannot check reserve proofs/);
    (w.xmr as unknown as { checkReserveProof: unknown }).checkReserveProof = async () => ({ good: true, total: 5n, spent: 1n });
    expect(await d.rebalance.reserveVerifier.check({ address: 'a', message: 'm', signature: 's' })).toEqual({ good: true, total: 5n, spent: 1n });
    d.store.close();
  });
});
