/**
 * The wXMR bridge adapter against an in-memory stand-in for the bridge accounts and Jupiter
 * (bridge-helpers.ts). Nothing is recorded from chain or from the live API.
 */
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  type BridgeDeps, JupiterClient, MemoryStore, type RefillRequest, VenueError, WxmrBridgeAdapter, bridgePdas, parseRebalanceSettings, vaultPoolDepth,
  instructionDiscriminator, WXMR_MINT, USDC_MINT,
} from '../src/index.js';
import { AUTHORITY, FakeChain, FakeJupiter, UPGRADE_AUTHORITY, WALLET, enc, reserveReport } from './bridge-helpers.js';
import { ALLOW, SOL_ADDR, XMR_ADDR, XMR_ADDR_2, fakeCtx, prices } from './helpers.js';

const NOW = 1_800_000_000;
const P = bridgePdas();
const bridgeSettings = (over: Record<string, unknown> = {}) => parseRebalanceSettings({ venues: { wxmr_bridge: { enabled: true, max_cost_pct: 1.0, ...over } } }).settings.venues.wxmr_bridge;
const req = (over: Partial<RefillRequest> = {}): RefillRequest => ({ from: 'usdc_sol', to: 'xmr', amountIn: 400_000_000n, rate: 'float', payoutAddress: XMR_ADDR, refundAddress: SOL_ADDR, ...over });

function setup(over: Partial<BridgeDeps> & { settings?: ReturnType<typeof bridgeSettings> } = {}) {
  const chain = new FakeChain();
  chain.setHeartbeat({ updatedAt: NOW - 30 });
  const jup = new FakeJupiter();
  const ctx = fakeCtx(NOW, chain.onSol);
  chain.clock = ctx.clock;
  // By default a swap delivers exactly what the latest quote promised.
  chain.swapDelivers = () => BigInt(lastQuoteOut(jup));
  const store = new MemoryStore();
  const a = new WxmrBridgeAdapter({ rpc: chain, jupiter: new JupiterClient({ http: jup }), prices: prices(), wallet: SOL_ADDR, settings: bridgeSettings(), store, now: () => ctx.clock.t, allowlist: ALLOW, ...over });
  return { chain, jup, ctx, store, a };
}
/** The outAmount of the most recent quote the fake Jupiter served, as a string. */
function lastQuoteOut(jup: FakeJupiter): string {
  const url = new URL(jup.requests.filter((r) => r.url.includes('/quote')).at(-1)!.url);
  const amount = Number(url.searchParams.get('amount'));
  const usdIn = url.searchParams.get('inputMint') === USDC_MINT.toBase58() ? amount / 1e6 : (amount / 1e9) * 200;
  return String(Math.floor(((usdIn * (1 - (usdIn / 1000) * jup.impactPer1000Usd)) / jup.poolPrice) * 1e12));
}

describe('quote', () => {
  it('prices the exchange leg, takes the bridge fee read from the config PDA, and adds network fees', async () => {
    const { a, jup } = setup();
    const q = await a.quote(req());
    // 400 USDC, impact 0.04%: 399.84 USD / 401.6 = 0.995617529880 wXMR; less 10 bps = 0.994621912351 XMR.
    expect(q.amountIn).toBe(400_000_000n);
    expect(q.amountOut).toBe(994_621_912_351n);
    expect(q.pieces).toBe(1);
    // Value out 397.85 USD; network 0.003 SOL = 0.60 USD.
    expect(q.feesUsd).toBeCloseTo(400 - 397.8487649404 + 0.6, 6);
    expect(q.costPct).toBeCloseTo(0.6878, 3);
    expect(q.expiresAt).toBe(NOW + 30);
    const url = new URL(jup.requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://lite-api.jup.ag/swap/v1/quote');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ inputMint: USDC_MINT.toBase58(), outputMint: WXMR_MINT.toBase58(), amount: '400000000', swapMode: 'ExactIn' });
  });

  it('a per-user fee override takes precedence over the config fee', async () => {
    const { a, chain } = setup();
    chain.accounts.set(P.feeOverride(WALLET).toBase58(), enc.feeOverride(WALLET, 0));
    expect((await a.quote(req())).amountOut).toBe(995_617_529_880n);
    expect(await a.config()).toEqual({ feeBps: 0, authority: AUTHORITY.toBase58() });
  });

  it('sizes pieces against pool depth: each piece at most max_piece_pct_of_pool of the pool', async () => {
    const { a } = setup({ poolDepth: async () => ({ usd: 50_000 }) });
    // 2% of 50,000 USD = 1,000 USD per piece; 3,500 USDC needs four pieces of 875.
    const q = await a.quote(req({ amountIn: 3_500_000_000n }));
    expect(q.pieces).toBe(4);
    expect((q.raw as { pieces: string[] }).pieces).toEqual(['875000000', '875000000', '875000000', '875000000']);
    const uneven = await a.quote(req({ amountIn: 2_500_000_001n }));
    expect((uneven.raw as { pieces: string[] }).pieces).toEqual(['833333334', '833333334', '833333333']);
  });

  it('reads pool depth from the two vault accounts', async () => {
    const { chain } = setup();
    chain.accounts.set('VaultW', enc.token(WXMR_MINT, AUTHORITY, 50_000_000_000_000n));
    chain.accounts.set('VaultQ', enc.token(USDC_MINT, AUTHORITY, 21_000_000_000n));
    // 50 wXMR at 400 + 21,000 USDC
    expect(await vaultPoolDepth(chain, prices(), { wxmr: 'VaultW', quote: 'VaultQ', quoteAsset: 'usdc_sol' })()).toEqual({ usd: 41_000 });
    chain.accounts.set('VaultW', enc.token(USDC_MINT, AUTHORITY, 1n));
    await expect(vaultPoolDepth(chain, prices(), { wxmr: 'VaultW', quote: 'VaultQ', quoteAsset: 'usdc_sol' })()).rejects.toThrow(/does not hold wXMR/);
  });

  it('without a depth read, halves the piece until Jupiter\'s price impact is inside the limit', async () => {
    const { a, jup } = setup({ settings: bridgeSettings({ max_piece_pct_of_pool: 0.5, max_cost_pct: 5 }) });
    jup.impactPer1000Usd = 0.002; // 0.2% per 1000 USD
    // 8000 USD -> 1.6% impact; 4000 -> 0.8%; 2000 -> 0.4% <= 0.5%: four pieces.
    const q = await a.quote(req({ amountIn: 8_000_000_000n }));
    expect(q.pieces).toBe(4);
  });

  it('keeps each piece inside max_wxmr_held', async () => {
    const { a } = setup({ settings: bridgeSettings({ max_wxmr_held: 5 }) });
    // 5 wXMR at 400 = 2,000 USD per piece.
    expect((await a.quote(req({ amountIn: 5_000_000_000n }))).pieces).toBe(3);
  });

  it('refuses when the heartbeat is stale or missing, and when the bridge cannot pay the size out now', async () => {
    const stale = setup();
    stale.chain.setHeartbeat({ updatedAt: NOW - 30, observedAt: NOW - 400 });
    await expect(stale.a.quote(req())).rejects.toThrow(/heartbeat is stale/);
    expect(await stale.a.health()).toMatchObject({ ok: false, reason: expect.stringContaining('stale') });

    const none = setup();
    none.chain.accounts.delete(P.heartbeat().toBase58());
    await expect(none.a.quote(req())).rejects.toThrow(/no heartbeat/);

    const thin = setup();
    thin.chain.setHeartbeat({ updatedAt: NOW - 30, unlocked: 500_000_000_000n });
    await expect(thin.a.quote(req())).rejects.toThrow(/can pay out 0.5 XMR right now/);
    expect(await thin.a.health()).toEqual({ ok: true });
  });

  it('require_heartbeat = false skips the liveness check', async () => {
    const { a, chain } = setup({ settings: bridgeSettings({ require_heartbeat: false }) });
    chain.accounts.delete(P.heartbeat().toBase58());
    expect(await a.health()).toEqual({ ok: true });
    expect((await a.quote(req())).amountOut).toBe(994_621_912_351n);
  });

  it('above reserve_proof_check_above_xmr, needs a verified reserve proof', async () => {
    const s = bridgeSettings({ reserve_proof_check_above_xmr: 0.5 });
    const without = setup({ settings: s });
    await expect(without.a.quote(req())).rejects.toThrow(/no verifier/);
    // Below the threshold no proof is needed.
    expect((await without.a.quote(req({ amountIn: 150_000_000n }))).amountOut).toBeGreaterThan(0n);

    const calls: unknown[] = [];
    const withVerifier = setup({ settings: s, reserveVerifier: { check: async (p) => { calls.push(p); return { good: true, total: 900_000_000_000_000n, spent: 0n }; } } });
    await expect(withVerifier.a.quote(req())).rejects.toThrow(/published no reserve proof/);
    expect(calls).toEqual([]);

    // With a proof on chain, the maker's node is asked and the refill goes ahead.
    const id = 1_790_000_000_000;
    const account = P.audit(BigInt(id)).toBase58();
    withVerifier.chain.accounts.set(account, enc.audit(BigInt(id), reserveReport(id)));
    withVerifier.chain.setHeartbeat({ updatedAt: NOW - 30, latestReserve: { account, id } });
    expect((await withVerifier.a.quote(req())).amountOut).toBe(994_621_912_351n);
    expect(calls).toHaveLength(1);

    const bad = setup({ settings: s, reserveVerifier: { check: async () => ({ good: false, total: 0n, spent: 0n }) } });
    bad.chain.accounts.set(account, enc.audit(BigInt(id), reserveReport(id)));
    bad.chain.setHeartbeat({ updatedAt: NOW - 30, latestReserve: { account, id } });
    await expect(bad.a.quote(req())).rejects.toThrow(/reserve-proof check failed: the reserve proof does not verify/);
  });

  it('serves only USDC/SOL <-> XMR, and enforces the 0.1 XMR minimum', async () => {
    const { a } = setup();
    await expect(a.quote(req({ from: 'eth' }))).rejects.toThrow(/does not serve/);
    await expect(a.limits('usdc_sol', 'usdc_eth')).rejects.toThrow(/does not serve/);
    await expect(a.quote(req({ amountIn: 30_000_000n }))).rejects.toThrow(/less than the bridge minimum/);
    // 0.1 XMR at 400 = 40 USD, plus 5%.
    expect(await a.limits('usdc_sol', 'xmr')).toEqual({ min: 42_000_000n, max: null });
    expect(await a.limits('xmr', 'sol')).toEqual({ min: 100_000_000_000n, max: null });
  });

  it('prices SOL input through the wrapped-SOL mint', async () => {
    const { a, jup } = setup();
    const q = await a.quote(req({ from: 'sol', amountIn: 2_000_000_000n }));
    expect(new URL(jup.requests[0]!.url).searchParams.get('inputMint')).toBe('So11111111111111111111111111111111111111112');
    expect(q.amountOut).toBe(994_621_912_351n);
  });
});

describe('refill: swap, measure, redeem', () => {
  it('journals, swaps, then redeems exactly what the swap delivered, under a nonce persisted first', async () => {
    const { a, chain, ctx, store, jup } = setup();
    const q = await a.quote(req());
    // The swap lands a little short of the quote; the redemption must use the measured amount.
    chain.swapDelivers = () => 995_000_000_000n;
    const { handle } = await a.execute(q, ctx);

    expect(ctx.order).toEqual([
      'journal:wxmr_bridge.refill', 'journal:wxmr_bridge.swap', 'send:sol', 'journal:wxmr_bridge.swapped',
      'journal:wxmr_bridge.request_withdrawal', 'send:sol', 'journal:wxmr_bridge.withdrawal_requested',
    ]);
    expect(ctx.sol[0]).toMatchObject({ kind: 'versioned_tx' });
    expect(jup.swaps()).toBe(1);
    const posted = JSON.parse(jup.requests.find((r) => r.url.endsWith('/swap'))!.body!);
    expect(posted.userPublicKey).toBe(SOL_ADDR);
    expect(posted.quoteResponse.inAmount).toBe('400000000');

    const w = ctx.sol[1]!;
    if (w.kind !== 'instructions') throw new Error('expected instructions');
    const data = Buffer.from(w.instructions[0]!.data);
    expect(data.subarray(0, 8)).toEqual(instructionDiscriminator('request_withdrawal'));
    expect(data.readBigUInt64LE(8)).toBe(1_800_000_000_000n);      // nonce = now in ms
    expect(data.readBigUInt64LE(16)).toBe(995_000_000_000n);       // measured, not quoted
    expect(data.subarray(28, 28 + 95).toString()).toBe(XMR_ADDR);
    expect(data.at(-1)).toBe(0);                                    // exact_out = false

    // The nonce was journalled and stored before the request went out.
    const j = ctx.journalled.find((x) => x.step === 'wxmr_bridge.request_withdrawal')!.data as { nonce: string; amount: string };
    expect(j).toMatchObject({ nonce: '1800000000000', amount: '995000000000', xmrAddress: XMR_ADDR });
    expect(JSON.parse((await store.get(handle))!).withdrawals).toEqual([{ nonce: '1800000000000', amount: '995000000000', state: 'requested', sig: 'solsig2' }]);
    expect(chain.wxmr()).toBe(0n);
    expect(chain.nonces()).toEqual([1_800_000_000_000n]);
  });

  it('tracks Pending -> Sending -> completed, and reports the Monero txid and the amount paid', async () => {
    const { a, chain, ctx } = setup();
    chain.swapDelivers = () => 995_000_000_000n;
    const { handle } = await a.execute(await a.quote(req()), ctx);
    expect(await a.status(handle)).toMatchObject({ state: 'processing', txids: ['solsig1', 'solsig2'] });
    chain.markSending(1_800_000_000_000n);
    expect((await a.status(handle)).state).toBe('paying_out');
    chain.complete(1_800_000_000_000n, 'f00d'.repeat(16));
    // 995e9 less the 10 bps fee.
    expect(await a.status(handle)).toEqual({ state: 'done', received: 994_005_000_000n, txids: ['solsig1', 'solsig2', 'f00d'.repeat(16)] });
    // Advancing a finished refill sends nothing more.
    const sends = ctx.sol.length;
    expect((await a.advance(handle, ctx)).state).toBe('done');
    expect(ctx.sol.length).toBe(sends);
  });

  it('uses last_nonce + 1 when the stored watermark is ahead of the clock', async () => {
    const { a, chain, ctx } = setup();
    chain.accounts.set(P.withdrawalState(WALLET).toBase58(), enc.withdrawalState(WALLET, 1_900_000_000_000n));
    await a.execute(await a.quote(req()), ctx);
    expect(chain.nonces()).toEqual([1_900_000_000_001n]);
  });

  it('runs later pieces from advance, one swap and one redemption each', async () => {
    const { a, chain, ctx } = setup({ poolDepth: async () => ({ usd: 50_000 }) });
    const q = await a.quote(req({ amountIn: 2_400_000_000n })); // three pieces of 800
    expect(q.pieces).toBe(3);
    const { handle } = await a.execute(q, ctx);
    expect(ctx.sol.length).toBe(2);
    expect(await a.status(handle)).toMatchObject({ state: 'processing', detail: expect.stringContaining('of 3') });
    ctx.clock.t += 5; await a.advance(handle, ctx);
    ctx.clock.t += 5; await a.advance(handle, ctx);
    ctx.clock.t += 5; await a.advance(handle, ctx);
    expect(ctx.sol.length).toBe(6);
    const nonces = chain.nonces();
    expect(nonces).toHaveLength(3);
    for (const n of nonces) chain.complete(n, `tx${n}`);
    const st = await a.status(handle);
    expect(st.state).toBe('done');
    expect(st.unfilled).toBeUndefined();
    expect(st.txids.filter((t) => t.startsWith('tx'))).toHaveLength(3);
  });

  it('stops when a later piece no longer fits the cost limit and reports the unfilled input for the next venue', async () => {
    const { a, chain, ctx, jup } = setup({ poolDepth: async () => ({ usd: 50_000 }) });
    const { handle } = await a.execute(await a.quote(req({ amountIn: 2_400_000_000n })), ctx);
    jup.poolPrice = 410; // the pool moved 2.5% away from the 400 reference
    await a.advance(handle, ctx);
    expect(ctx.sol.length).toBe(2); // nothing more was bought
    expect(ctx.journalled.at(-1)).toMatchObject({ step: 'wxmr_bridge.stopped', data: { unfilled: '1600000000' } });
    chain.complete(chain.nonces()[0]!, 'paid1');
    const st = await a.status(handle);
    expect(st).toMatchObject({ state: 'done', unfilled: 1_600_000_000n, detail: expect.stringMatching(/stopped: piece 2 would cost 2\.\d+% .* above the 1% limit/) });
    // It stays stopped even if the price comes back.
    jup.poolPrice = 401.6;
    await a.advance(handle, ctx);
    expect(ctx.sol.length).toBe(2);
  });

  it('refuses at execute, with nothing sent, when the first piece no longer fits', async () => {
    const { a, ctx, jup } = setup();
    const q = await a.quote(req());
    jup.poolPrice = 410;
    const err = await a.execute(q, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect(err.fundsMoved).toBe(false);
    expect(ctx.sol).toEqual([]);
  });

  it('waits, without stopping, while the heartbeat is stale', async () => {
    const { a, chain, ctx } = setup({ poolDepth: async () => ({ usd: 50_000 }) });
    const { handle } = await a.execute(await a.quote(req({ amountIn: 1_600_000_000n })), ctx);
    chain.setHeartbeat({ updatedAt: NOW - 1000 });
    await a.advance(handle, ctx);
    expect(ctx.sol.length).toBe(2);
    chain.setHeartbeat({ updatedAt: ctx.clock.t - 10 });
    await a.advance(handle, ctx);
    expect(ctx.sol.length).toBe(4);
  });

  it('with redeem_immediately = false, accumulates up to the held cap and redeems in one request', async () => {
    const { a, chain, ctx } = setup({ settings: bridgeSettings({ redeem_immediately: false, max_wxmr_held: 5 }), poolDepth: async () => ({ usd: 40_000 }) });
    const { handle } = await a.execute(await a.quote(req({ amountIn: 1_600_000_000n })), ctx); // two pieces of 800
    expect(chain.nonces()).toEqual([]);
    expect(chain.wxmr()).toBeGreaterThan(1_900_000_000_000n);
    await a.advance(handle, ctx);
    expect(chain.nonces()).toHaveLength(1);
    expect(chain.wxmr()).toBe(0n);
  });

  it('never buys past max_wxmr_held when wXMR is already sitting in the wallet', async () => {
    const { a, chain, ctx } = setup({ settings: bridgeSettings({ max_wxmr_held: 1.5 }) });
    const q = await a.quote(req());
    chain.setWxmr(1_000_000_000_000n);
    await expect(a.execute(q, ctx)).rejects.toThrow(/more than 1.5 wXMR in the wallet/);
    expect(ctx.sol).toEqual([]);
  });
});

describe('refill: failures and restarts', () => {
  it('a swap whose outcome is unknown parks the refill; it is never re-sent', async () => {
    const { a, ctx, store } = setup();
    const q = await a.quote(req());
    ctx.failNextSend = 'blockhash expired?';
    const err = await a.execute(q, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect(err.fundsMoved).toBe(true);
    const handle = [...store.map.keys()][0]!;
    expect(await a.status(handle)).toMatchObject({ state: 'held', detail: expect.stringContaining('not re-sent') });
    await a.advance(handle, ctx);
    expect(ctx.sol).toEqual([]);
  });

  it('a restart with a swap intent on record parks the refill instead of swapping again', async () => {
    const { a, ctx, store, chain, jup } = setup({ poolDepth: async () => ({ usd: 50_000 }) });
    const { handle } = await a.execute(await a.quote(req({ amountIn: 1_600_000_000n })), ctx);
    const rec = JSON.parse((await store.get(handle))!);
    await store.put(handle, JSON.stringify({ ...rec, swapIntent: 1 }));
    const restarted = new WxmrBridgeAdapter({ rpc: chain, jupiter: new JupiterClient({ http: jup }), prices: prices(), wallet: SOL_ADDR, settings: bridgeSettings(), store, now: () => ctx.clock.t });
    expect(await restarted.advance(handle, ctx)).toMatchObject({ state: 'held', detail: expect.stringContaining('check the wallet') });
    expect(ctx.sol.length).toBe(2);
  });

  it('a swap that failed on chain, or delivered nothing readable, parks the refill', async () => {
    const { a, chain, ctx, store } = setup();
    chain.swapFails = true;
    await expect(a.execute(await a.quote(req()), ctx)).rejects.toThrow(/failed on chain/);
    expect(ctx.sol.length).toBe(1);
    expect(chain.nonces()).toEqual([]);
    expect([...store.map.keys()]).toHaveLength(1);
  });

  it('an unconfirmed withdrawal request is re-sent under the SAME nonce, and only if the record is not on chain', async () => {
    const { a, chain, ctx, store } = setup();
    const q = await a.quote(req());
    // First send (the swap) succeeds; the second (request_withdrawal) throws before reaching the chain.
    let n = 0;
    const realSend = ctx.sendSol.bind(ctx);
    ctx.sendSol = async (s) => { if (++n === 2) throw new Error('node unreachable'); return realSend(s); };
    await expect(a.execute(q, ctx)).rejects.toThrow(/unconfirmed/);
    const handle = [...store.map.keys()][0]!;
    expect(JSON.parse((await store.get(handle))!).withdrawals[0]).toMatchObject({ nonce: '1800000000000', state: 'intent' });
    expect(chain.nonces()).toEqual([]);

    ctx.clock.t += 600; // a later clock must not produce a new nonce
    await a.advance(handle, ctx);
    expect(chain.nonces()).toEqual([1_800_000_000_000n]);
    expect(JSON.parse((await store.get(handle))!).withdrawals).toHaveLength(1);

    // Again unconfirmed, but this time it did land: nothing is sent a second time.
    const second = setup();
    const q2 = await second.a.quote(req());
    let m = 0;
    const real2 = second.ctx.sendSol.bind(second.ctx);
    second.ctx.sendSol = async (s) => { const sig = await real2(s); if (++m === 2) throw new Error('timeout waiting for confirmation'); return sig; };
    await expect(second.a.execute(q2, second.ctx)).rejects.toThrow(/unconfirmed/);
    const h2 = [...second.store.map.keys()][0]!;
    expect(second.chain.nonces()).toEqual([1_800_000_000_000n]);
    const sends = second.ctx.sol.length;
    expect((await second.a.advance(h2, second.ctx)).state).toBe('processing');
    expect(second.ctx.sol.length).toBe(sends);
    expect(second.chain.nonces()).toEqual([1_800_000_000_000n]);
  });

  it('rejects a Jupiter transaction that is not payable and signable by the maker wallet alone', async () => {
    const { a, ctx, jup } = setup();
    const q = await a.quote(req());
    jup.swapPayer = new PublicKey(AUTHORITY);
    await expect(a.execute(q, ctx)).rejects.toThrow(/not payable and signable by the maker wallet alone/);
    expect(ctx.sol).toEqual([]);
  });

  it('refuses an expired quote', async () => {
    const { a, ctx } = setup();
    const q = await a.quote(req());
    ctx.clock.t = NOW + 31;
    await expect(a.execute(q, ctx)).rejects.toThrow(/expired/);
  });
});

describe('stalled redemption: cancel_withdrawal', () => {
  it('cannot cancel inside the 300 s on-chain delay', async () => {
    const { a, ctx } = setup();
    const { handle } = await a.execute(await a.quote(req()), ctx);
    ctx.clock.t += 299;
    await expect(a.cancel(handle, ctx)).rejects.toThrow(/only 300 s after/);
    expect(ctx.sol.length).toBe(2);
  });

  it('cancels a Pending redemption after the delay: the wXMR comes back, the fee does not', async () => {
    const { a, chain, ctx } = setup();
    chain.swapDelivers = () => 995_000_000_000n;
    const { handle } = await a.execute(await a.quote(req()), ctx);
    ctx.clock.t += 3600;
    await a.cancel(handle, ctx);
    const c = ctx.sol[2]!;
    if (c.kind !== 'instructions') throw new Error('expected instructions');
    const ix = c.instructions[0]!;
    expect(Buffer.from(ix.data)).toEqual(instructionDiscriminator('cancel_withdrawal'));
    expect(ix.keys[1]!.pubkey.equals(P.withdrawal(WALLET, 1_800_000_000_000n))).toBe(true);
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(AUTHORITY.toBase58()); // config.authority, read from chain
    expect(ctx.journalled.some((j) => j.step === 'wxmr_bridge.cancel_withdrawal')).toBe(true);
    expect(chain.wxmr()).toBe(994_005_000_000n);
    expect(await a.status(handle)).toMatchObject({ state: 'refunded', detail: expect.stringContaining('wXMR is back in the wallet') });
    expect(await a.heldWxmr()).toBe(994_005_000_000n);
  });

  it('can never cancel a redemption the bridge has marked Sending', async () => {
    const { a, chain, ctx } = setup();
    const { handle } = await a.execute(await a.quote(req()), ctx);
    chain.markSending(1_800_000_000_000n);
    ctx.clock.t += 3600;
    await expect(a.cancel(handle, ctx)).rejects.toThrow(/already being sent by the bridge/);
    expect(ctx.sol.length).toBe(2);
    expect((await a.status(handle)).state).toBe('paying_out');
  });

  it('the frozen one-argument cancel(handle) uses the ExecContext given at construction, and fails clearly without one', async () => {
    const bare = setup();
    const h = (await bare.a.execute(await bare.a.quote(req()), bare.ctx)).handle;
    bare.ctx.clock.t += 3600;
    await expect(bare.a.cancel(h)).rejects.toThrow(/needs an ExecContext/);

    const chain = new FakeChain();
    chain.setHeartbeat({ updatedAt: NOW - 30 });
    const jup = new FakeJupiter();
    const ctx = fakeCtx(NOW, chain.onSol);
    chain.clock = ctx.clock;
    chain.swapDelivers = () => 995_000_000_000n;
    const a = new WxmrBridgeAdapter({ rpc: chain, jupiter: new JupiterClient({ http: jup }), prices: prices(), wallet: SOL_ADDR, settings: bridgeSettings(), now: () => ctx.clock.t, execContext: ctx });
    const { handle } = await a.execute(await a.quote(req()), ctx);
    ctx.clock.t += 3600;
    await a.cancel(handle);
    expect(chain.nonces()).toEqual([]);
  });

  it('reports a redemption the config authority reversed', async () => {
    const { a, chain, ctx } = setup();
    const { handle } = await a.execute(await a.quote(req()), ctx);
    chain.revert(1_800_000_000_000n, 'address rejected');
    expect(await a.status(handle)).toMatchObject({ state: 'refunded' });
  });

  it('redeemHeld sends wXMR left in the wallet, to allow-listed addresses only', async () => {
    const { a, chain, ctx } = setup();
    chain.setWxmr(2_000_000_000_000n);
    await expect(a.redeemHeld(XMR_ADDR_2, ctx)).rejects.toThrow(/allow-list/);
    expect(ctx.sol).toEqual([]);
    const { handle } = await a.redeemHeld(XMR_ADDR, ctx);
    expect(chain.wxmr()).toBe(0n);
    chain.complete(chain.nonces()[0]!, 'heldpaid');
    expect(await a.status(handle)).toMatchObject({ state: 'done', received: 1_998_000_000_000n });
  });
});

describe('reverse: XMR -> wXMR -> USDC', () => {
  const rreq = (over: Partial<RefillRequest> = {}): RefillRequest => ({ from: 'xmr', to: 'usdc_sol', amountIn: 2_000_000_000_000n, rate: 'float', payoutAddress: SOL_ADDR, refundAddress: XMR_ADDR, ...over });

  it('quotes the sale net of the 0.1% deposit fee', async () => {
    const { a } = setup();
    const q = await a.quote(rreq());
    // 1.998 wXMR at 401.6 = 802.3968 USD, impact 0.0802%: 801.753 USDC
    expect(q.amountOut).toBe(801_752_959n);
    expect(q.costPct).toBeGreaterThan(-0.3);
    expect(q.costPct).toBeLessThan(0);
    await expect(a.quote(rreq({ amountIn: 50_000_000_000n }))).rejects.toThrow(/0\.1 XMR/);
  });

  it('creates the deposit account, waits for the address, deposits, waits for the mint, sells', async () => {
    const { a, chain, ctx, jup } = setup();
    const { handle } = await a.execute(await a.quote(rreq()), ctx);
    // One transaction: token account + create_deposit_account.
    const s0 = ctx.sol[0]!;
    if (s0.kind !== 'instructions') throw new Error('expected instructions');
    expect(s0.instructions).toHaveLength(2);
    expect(Buffer.from(s0.instructions[1]!.data)).toEqual(instructionDiscriminator('create_deposit_account'));
    expect(await a.status(handle)).toMatchObject({ state: 'pending' });
    await a.advance(handle, ctx);
    expect(ctx.xmr).toEqual([]); // no address yet

    chain.accounts.set(P.deposit(WALLET).toBase58(), enc.deposit({ owner: WALLET, address: XMR_ADDR_2, total: 7_000_000_000_000n, status: 1 }));
    expect((await a.advance(handle, ctx)).state).toBe('depositing');
    expect(ctx.xmr).toEqual([{ to: XMR_ADDR_2, amount: 2_000_000_000_000n }]);
    const j = ctx.journalled.find((x) => x.step === 'wxmr_bridge.deposit_xmr')!;
    expect(ctx.order.indexOf('journal:wxmr_bridge.deposit_xmr')).toBeLessThan(ctx.order.indexOf('send:xmr'));
    expect(j.data).toMatchObject({ totalDepositedBefore: '7000000000000' });

    // Not minted yet (total has not grown by the gross amount).
    chain.accounts.set(P.deposit(WALLET).toBase58(), enc.deposit({ owner: WALLET, address: XMR_ADDR_2, total: 8_000_000_000_000n, status: 1 }));
    expect((await a.advance(handle, ctx)).state).toBe('depositing');

    chain.accounts.set(P.deposit(WALLET).toBase58(), enc.deposit({ owner: WALLET, address: XMR_ADDR_2, total: 9_000_000_000_000n, status: 1 }));
    chain.setWxmr(1_998_000_000_000n);
    // The sale's proceeds are read from the swap transaction.
    const selling = fakeCtx(ctx.clock.t, (send, sig) => {
      if (send.kind === 'versioned_tx') chain.txs.set(sig, { err: null, logs: [], blockTime: 1, lamports: [], tokenBalances: [{ owner: SOL_ADDR, mint: USDC_MINT.toBase58(), pre: 10n, post: 801_000_010n }] });
    });
    expect(await a.advance(handle, selling)).toMatchObject({ state: 'done', received: 801_000_000n });
    expect(selling.sol).toHaveLength(1);
    expect(selling.order).toEqual(['journal:wxmr_bridge.minted', 'journal:wxmr_bridge.swap', 'send:sol', 'journal:wxmr_bridge.swapped']);
    const sold = new URL(jup.requests.filter((r) => r.url.includes('/quote')).at(-1)!.url).searchParams;
    expect([sold.get('inputMint'), sold.get('amount')]).toEqual([WXMR_MINT.toBase58(), '1998000000000']);
  });

  it('uses an existing deposit address at once, and pays out only to the maker wallet', async () => {
    const { a, chain, ctx } = setup();
    chain.accounts.set(P.deposit(WALLET).toBase58(), enc.deposit({ owner: WALLET, address: XMR_ADDR_2, total: 0n, status: 1 }));
    const q = await a.quote(rreq());
    await expect(a.execute({ ...q, request: { ...q.request, payoutAddress: AUTHORITY.toBase58() } }, ctx)).rejects.toThrow(/maker wallet only/);
    const { handle } = await a.execute(q, ctx);
    expect(ctx.sol).toEqual([]);
    expect(ctx.xmr).toEqual([{ to: XMR_ADDR_2, amount: 2_000_000_000_000n }]);
    await expect(a.cancel(handle, ctx)).rejects.toThrow(/cannot be cancelled/);
  });

  it('an XMR deposit whose outcome is unknown is parked, not re-sent', async () => {
    const { a, chain, ctx, store } = setup();
    chain.accounts.set(P.deposit(WALLET).toBase58(), enc.deposit({ owner: WALLET, address: XMR_ADDR_2, total: 0n, status: 1 }));
    ctx.failNextSend = 'wallet-rpc timeout';
    await expect(a.execute(await a.quote(rreq()), ctx)).rejects.toThrow(/not re-sent/);
    const handle = [...store.map.keys()][0]!;
    await a.advance(handle, ctx);
    expect(ctx.xmr).toEqual([]);
    expect((await a.status(handle)).state).toBe('held');
  });
});

describe('authorities', () => {
  it('reads the upgrade authority and the config authority from chain', async () => {
    const { a, chain } = setup();
    expect(await a.authorities()).toEqual({ upgradeAuthority: UPGRADE_AUTHORITY.toBase58(), configAuthority: AUTHORITY.toBase58(), feeBps: 10, defaultFeeBps: 10 });
    chain.accounts.set(P.programData().toBase58(), enc.programData(null));
    expect((await a.authorities()).upgradeAuthority).toBeNull();
  });
  it('refuses a config that names another mint or a 100% fee', async () => {
    const { a, chain } = setup();
    chain.accounts.set(P.config().toBase58(), enc.config({ feeBps: 10_000 }));
    await expect(a.quote(req())).rejects.toThrow(/100%/);
    chain.accounts.set(P.config().toBase58(), enc.config({ mint: USDC_MINT }));
    await expect(a.quote(req())).rejects.toThrow(/different mint/);
  });
});
