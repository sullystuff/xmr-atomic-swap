/**
 * The four instant-swap adapters against HAND-WRITTEN fixtures (see fixtures/README.md). No
 * request leaves the process: `FixtureHttp` has no network path.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChangeNowAdapter, FixedFloatAdapter, HoudiniSwapAdapter, type RefillRequest, StealthExAdapter, VenueError, fixedFloatSign } from '../src/index.js';
import { FixtureHttp, SOL_ADDR, XMR_ADDR, everythingSeen, fakeCtx, fixture, prices } from './helpers.js';

const KEY = 'test-key-AAAA1111';
const SECRET = 'test-secret-BBBB2222';
const env = (name: string) => ({ CN_KEY: KEY, SX_KEY: KEY, HD_KEY: KEY, HD_SECRET: SECRET, FF_KEY: KEY, FF_SECRET: SECRET })[name];
const req = (over: Partial<RefillRequest> = {}): RefillRequest => ({ from: 'usdc_sol', to: 'xmr', amountIn: 2_000_000_000n, rate: 'float', payoutAddress: XMR_ADDR, refundAddress: SOL_ADDR, ...over });
const NOW = 1_800_000_000;

describe('ChangeNOW', () => {
  const f = fixture('changenow.json');
  const make = (routes: ConstructorParameters<typeof FixtureHttp>[0]) => {
    const http = new FixtureHttp(routes);
    return { http, a: new ChangeNowAdapter({ http, prices: prices(), apiKeyEnv: 'CN_KEY', env, now: () => NOW }) };
  };

  it('quotes a standard-flow refill and prices it against the reference', async () => {
    const { http, a } = make([{ method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard }]);
    const q = await a.quote(req());
    expect(q.venue).toBe('changenow');
    expect(q.amountIn).toBe(2_000_000_000n);
    expect(q.amountOut).toBe(4_961_200_000_000n);
    // 2000 USD in, 4.9612 XMR at 400 = 1984.48 USD out.
    expect(q.feesUsd).toBeCloseTo(15.52, 6);
    expect(q.costPct).toBeCloseTo(0.776, 6);
    expect(q.expiresAt).toBe(NOW + 60);
    const sent = http.last('/exchange/estimated-amount');
    expect(sent.url).toContain('https://api.changenow.io/v2/exchange/estimated-amount?');
    const p = new URL(sent.url).searchParams;
    expect(Object.fromEntries(p)).toEqual({ fromCurrency: 'usdc', toCurrency: 'xmr', fromNetwork: 'sol', toNetwork: 'xmr', flow: 'standard', type: 'direct', fromAmount: '2000' });
    expect(sent.headers?.['x-changenow-api-key']).toBe(KEY);
  });

  it('uses the fixed-rate flow with a rate id, and prices a fixed output with type=reverse', async () => {
    const { http, a } = make([
      { method: 'GET', path: '/exchange/estimated-amount', when: 'type=reverse', body: f.estimate_fixed_reverse },
      { method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_fixed },
    ]);
    const q = await a.quote(req({ rate: 'fixed' }));
    expect(new URL(http.last('/exchange/estimated-amount').url).searchParams.get('flow')).toBe('fixed-rate');
    expect(new URL(http.last('/exchange/estimated-amount').url).searchParams.get('useRateId')).toBe('true');
    expect(q.expiresAt).toBe(Date.parse('2027-01-15T08:10:00.000Z') / 1000);
    const { amountIn: _drop, ...byOut } = req({ rate: 'fixed' });
    const r = await a.quote({ ...byOut, amountOut: 5_000_000_000_000n });
    expect(r.amountIn).toBe(2_030_500_000n);
    expect(r.amountOut).toBe(5_000_000_000_000n);
    expect(new URL(http.last('/exchange/estimated-amount').url).searchParams.get('toAmount')).toBe('5');
  });

  it('scales the input from a probe when a float quote is asked for by output', async () => {
    const { http, a } = make([{ method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard }]);
    const { amountIn: _drop, ...byOut } = req();
    await a.quote({ ...byOut, amountOut: 5_000_000_000_000n });
    expect(http.count('/exchange/estimated-amount')).toBe(2);
    // Probe: 5 XMR at 400 = 2000 USDC; the fixture returns 4.9612 XMR, so the input grows by 5 / 4.9612.
    expect(new URL(http.requests[0]!.url).searchParams.get('fromAmount')).toBe('2000');
    expect(new URL(http.requests[1]!.url).searchParams.get('fromAmount')).toBe('2015.641378'); // rounded up, so the output covers the request
  });

  it('reads limits; a missing maximum is null', async () => {
    const { a } = make([{ method: 'GET', path: '/exchange/range', body: f.range }]);
    expect(await a.limits('usdc_sol', 'xmr')).toEqual({ min: 12_500_000n, max: null });
  });

  it('creates the order, journals before it sends, and sends exactly the quoted amount to the deposit address', async () => {
    const { http, a } = make([
      { method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard },
      { method: 'POST', path: '/exchange', body: f.create },
    ]);
    const ctx = fakeCtx(NOW);
    const { handle } = await a.execute(await a.quote(req()), ctx);
    expect(handle).toBe('changenow:cn4f8a21b7c9d3e0:xmr');
    expect(JSON.parse(http.last('/exchange').body!)).toEqual({ fromCurrency: 'usdc', toCurrency: 'xmr', fromNetwork: 'sol', toNetwork: 'xmr', fromAmount: '2000', toAmount: '', address: XMR_ADDR, refundAddress: SOL_ADDR, flow: 'standard', type: 'direct' });
    expect(ctx.sol).toEqual([{ kind: 'transfer', asset: 'usdc_sol', to: 'CnDepositAddr1111111111111111111111111111111', amount: 2_000_000_000n }]);
    expect(ctx.order).toEqual(['journal:changenow.create_order', 'journal:changenow.order_created', 'journal:changenow.send_deposit', 'send:sol', 'journal:changenow.deposit_sent']);
  });

  it('sends nothing when the service records a different payout address', async () => {
    const { a } = make([
      { method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard },
      { method: 'POST', path: '/exchange', body: { ...f.create, payoutAddress: '4' + 'Z'.repeat(94) } },
    ]);
    const ctx = fakeCtx(NOW);
    const err = await a.execute(await a.quote(req()), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).fundsMoved).toBe(false);
    expect(err.message).toMatch(/address other than the one requested/);
    expect(ctx.sol).toEqual([]);
  });

  it('sends nothing when the order asks for more than the quote or needs a memo', async () => {
    for (const bad of [{ fromAmount: 2100 }, { payinExtraId: '12345' }]) {
      const { a } = make([
        { method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard },
        { method: 'POST', path: '/exchange', body: { ...f.create, ...bad } },
      ]);
      const ctx = fakeCtx(NOW);
      await expect(a.execute(await a.quote(req()), ctx)).rejects.toThrow(/nothing was sent/);
      expect(ctx.sol).toEqual([]);
    }
  });

  it('refuses an expired quote and reports an unconfirmed deposit as funds-moved', async () => {
    const { a } = make([
      { method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard },
      { method: 'POST', path: '/exchange', body: f.create },
    ]);
    const q = await a.quote(req());
    const late = fakeCtx(NOW + 61);
    await expect(a.execute(q, late)).rejects.toThrow(/expired/);
    const ctx = fakeCtx(NOW);
    ctx.failNextSend = 'rpc timeout';
    const err = await a.execute(q, ctx).catch((e) => e);
    expect((err as VenueError).fundsMoved).toBe(true);
    expect(err.message).toMatch(/not re-sent/);
  });

  it('maps statuses: waiting, verifying (held), finished with the amount received', async () => {
    const { http, a } = make([{ method: 'GET', path: '/exchange/by-id', body: f.status_waiting }]);
    const h = 'changenow:cn4f8a21b7c9d3e0:xmr';
    expect(await a.status(h)).toEqual({ state: 'pending', txids: [] });
    http.routes = [{ method: 'GET', path: '/exchange/by-id', body: f.status_verifying }];
    expect(await a.status(h)).toMatchObject({ state: 'held', txids: ['5PayinSig'] });
    http.routes = [{ method: 'GET', path: '/exchange/by-id', body: f.status_finished }];
    expect(await a.status(h)).toEqual({ state: 'done', received: 4_958_000_000_000n, txids: ['5PayinSig', 'a1b2c3payouttxid'] });
    http.routes = [{ method: 'GET', path: '/exchange/by-id', body: { ...f.status_waiting, status: 'something_new' } }];
    expect(await a.status(h)).toMatchObject({ state: 'held', detail: expect.stringContaining('something_new') });
    await expect(a.status('fixedfloat:abc')).rejects.toThrow(/not a handle/);
  });

  it('resolves a held order with /exchange/continue or /exchange/refund', async () => {
    const { http, a } = make([{ method: 'POST', path: '/exchange/continue', body: {} }, { method: 'POST', path: '/exchange/refund', body: {} }]);
    await a.resolveHeld('changenow:cn4f8a21b7c9d3e0:xmr', 'continue');
    expect(JSON.parse(http.last('/exchange/continue').body!)).toEqual({ id: 'cn4f8a21b7c9d3e0' });
    await a.resolveHeld('changenow:cn4f8a21b7c9d3e0:xmr', 'refund');
    expect(http.count('/exchange/refund')).toBe(1);
  });

  it('is unhealthy without its key, and never puts the key in an error or the journal', async () => {
    const http = new FixtureHttp([
      { method: 'GET', path: '/exchange/estimated-amount', status: 401, body: f.error_unauthorized },
      { method: 'POST', path: '/exchange', body: f.create },
    ]);
    const missing = new ChangeNowAdapter({ http, prices: prices(), apiKeyEnv: 'CN_KEY', env: () => undefined });
    expect(await missing.health()).toEqual({ ok: false, reason: 'changenow: environment variable CN_KEY (API key) is not set' });
    const a = new ChangeNowAdapter({ http, prices: prices(), apiKeyEnv: 'CN_KEY', env, now: () => NOW });
    expect(await a.health()).toEqual({ ok: true });
    const err = await a.quote(req()).catch((e) => e);
    expect(err.message).toBe('GET https://api.changenow.io/v2/exchange/estimated-amount -> 401: Invalid api key');
    http.routes = [{ method: 'GET', path: '/exchange/estimated-amount', body: f.estimate_standard }, { method: 'POST', path: '/exchange', body: f.create }];
    const ctx = fakeCtx(NOW);
    await a.execute(await a.quote(req()), ctx);
    expect(everythingSeen(ctx, [err])).not.toContain(KEY);
  });

  it('accepts the cross-chain USDC pair', async () => {
    const { http, a } = make([{ method: 'GET', path: '/exchange/estimated-amount', body: { fromAmount: 1000, toAmount: 996.5 } }]);
    const q = await a.quote({ from: 'usdc_sol', to: 'usdc_eth', amountIn: 1_000_000_000n, rate: 'float', payoutAddress: '0x52908400098527886E0F7030069857D2E4169EE7', refundAddress: SOL_ADDR });
    expect(q.amountOut).toBe(996_500_000n);
    expect(q.costPct).toBeCloseTo(0.35, 6);
    const p = new URL(http.last('/exchange/estimated-amount').url).searchParams;
    expect([p.get('fromCurrency'), p.get('fromNetwork'), p.get('toCurrency'), p.get('toNetwork')]).toEqual(['usdc', 'sol', 'usdc', 'eth']);
  });
});

describe('StealthEX (XMR support unconfirmed; off by default)', () => {
  const f = fixture('stealthex.json');
  const make = (routes: ConstructorParameters<typeof FixtureHttp>[0]) => {
    const http = new FixtureHttp(routes);
    return { http, a: new StealthExAdapter({ http, prices: prices(), apiKeyEnv: 'SX_KEY', env, now: () => NOW }) };
  };

  it('quotes with a route object and bearer auth; fixed quotes carry the rate expiry', async () => {
    const { http, a } = make([
      { method: 'POST', path: '/rates/estimated-amount', when: '"rate":"fixed"', body: f.estimate_fixed },
      { method: 'POST', path: '/rates/estimated-amount', when: '"estimation":"reversed"', body: f.estimate_reversed },
      { method: 'POST', path: '/rates/estimated-amount', body: f.estimate },
    ]);
    const q = await a.quote(req());
    expect(q.amountOut).toBe(4_950_000_000_000n);
    const sent = http.last('/rates/estimated-amount');
    expect(sent.url).toBe('https://api.stealthex.io/v4/rates/estimated-amount');
    expect(sent.headers?.['authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(sent.body!)).toEqual({ route: { from: { symbol: 'usdc', network: 'sol' }, to: { symbol: 'xmr', network: 'mainnet' } }, amount: 2000, estimation: 'direct', rate: 'floating' });
    expect((await a.quote(req({ rate: 'fixed' }))).expiresAt).toBe(Date.parse('2027-01-15T08:10:00.000Z') / 1000);
    const { amountIn: _drop, ...byOut } = req();
    const r = await a.quote({ ...byOut, amountOut: 5_000_000_000_000n });
    expect(r.amountIn).toBe(2_022_400_000n);
  });

  it('reads limits, creates, sends, and maps verifying to held', async () => {
    const { http, a } = make([
      { method: 'POST', path: '/rates/range', body: f.range },
      { method: 'POST', path: '/rates/estimated-amount', body: f.estimate },
      { method: 'POST', path: '/exchanges', body: f.create },
      { method: 'GET', path: '/exchanges/sx81c2d3', body: f.status_verifying },
    ]);
    expect(await a.limits('usdc_sol', 'xmr')).toEqual({ min: 20_000_000n, max: 150_000_000_000n });
    const ctx = fakeCtx(NOW);
    const { handle } = await a.execute(await a.quote(req()), ctx);
    expect(JSON.parse(http.last('/exchanges').body!)).toMatchObject({ address: XMR_ADDR, refund_address: SOL_ADDR, amount: 2000 });
    expect(ctx.sol).toEqual([{ kind: 'transfer', asset: 'usdc_sol', to: 'SxDepositAddr111111111111111111111111111111', amount: 2_000_000_000n }]);
    expect(await a.status(handle)).toMatchObject({ state: 'held', txids: ['5SxPayin'] });
    http.routes = [{ method: 'GET', path: '/exchanges/sx81c2d3', body: f.status_finished }];
    expect(await a.status(handle)).toEqual({ state: 'done', received: 4_948_000_000_000n, txids: ['5SxPayin', 'sxpayouttxid'] });
    expect(everythingSeen(ctx)).not.toContain(KEY);
  });
});

describe('HoudiniSwap (XMR payout unconfirmed; off by default)', () => {
  const f = fixture('houdiniswap.json');
  const make = (routes: ConstructorParameters<typeof FixtureHttp>[0]) => {
    const http = new FixtureHttp(routes);
    return { http, a: new HoudiniSwapAdapter({ http, prices: prices(), apiKeyEnv: 'HD_KEY', apiSecretEnv: 'HD_SECRET', env, now: () => NOW }) };
  };

  it('needs both key and secret, sent as key:secret with no prefix', async () => {
    const { http, a } = make([{ method: 'GET', path: '/quotes', body: f.quotes }]);
    expect(await a.health()).toEqual({ ok: true });
    await a.quote(req());
    expect(http.last('/quotes').headers?.['authorization']).toBe(`${KEY}:${SECRET}`);
    const noSecret = new HoudiniSwapAdapter({ http, prices: prices(), apiKeyEnv: 'HD_KEY', env });
    expect((await noSecret.health()).ok).toBe(false);
  });

  it('picks the best quote of the requested rate type and creates with its quoteId', async () => {
    const { http, a } = make([
      { method: 'GET', path: '/quotes', body: f.quotes },
      { method: 'GET', path: '/minMax', body: f.minMax },
      { method: 'POST', path: '/exchanges', body: f.create },
    ]);
    const q = await a.quote(req());
    expect(q.amountOut).toBe(4_940_000_000_000n);
    expect((await a.quote(req({ rate: 'fixed' }))).amountOut).toBe(4_990_000_000_000n);
    expect(await a.limits('usdc_sol', 'xmr')).toEqual({ min: 25_000_000n, max: 100_000_000_000n });
    const ctx = fakeCtx(NOW);
    const { handle } = await a.execute(q, ctx);
    expect(JSON.parse(http.last('/exchanges').body!)).toEqual({ quoteId: 'hq-float-1', addressTo: XMR_ADDR, refundAddress: SOL_ADDR });
    expect(handle).toBe('houdiniswap:h9Qm2Xw7:xmr');
    expect(ctx.sol[0]).toMatchObject({ to: 'HdDepositAddr111111111111111111111111111111', amount: 2_000_000_000n });
    expect(everythingSeen(ctx)).not.toContain(SECRET);
  });

  it('says so when no quote comes back for the pair', async () => {
    const { a } = make([{ method: 'GET', path: '/quotes', body: f.quotes_empty }]);
    await expect(a.quote(req())).rejects.toThrow(/XMR payout may not be offered/);
  });

  it('maps the numeric statuses, and "Contact Support" to held', async () => {
    const { http, a } = make([{ method: 'GET', path: '/orders/h9Qm2Xw7', body: f.status_anonymizing }]);
    const h = 'houdiniswap:h9Qm2Xw7:xmr';
    expect(await a.status(h)).toEqual({ state: 'processing', txids: ['5HdPayin'] });
    http.routes = [{ method: 'GET', path: '/orders/h9Qm2Xw7', body: f.status_support }];
    expect(await a.status(h)).toMatchObject({ state: 'held', detail: expect.stringContaining('support') });
    http.routes = [{ method: 'GET', path: '/orders/h9Qm2Xw7', body: f.status_completed }];
    expect(await a.status(h)).toEqual({ state: 'done', received: 4_937_000_000_000n, txids: ['5HdPayin', 'hdpayouttxid'] });
    http.routes = [{ method: 'GET', path: '/orders/h9Qm2Xw7', body: f.status_refunded }];
    expect((await a.status(h)).state).toBe('refunded');
    for (const [code, state] of [[0, 'pending'], [1, 'depositing'], [2, 'processing'], [5, 'failed'], [6, 'failed'], [8, 'failed']] as const) {
      http.routes = [{ method: 'GET', path: '/orders/h9Qm2Xw7', body: { houdiniId: 'h9Qm2Xw7', status: code } }];
      expect((await a.status(h)).state).toBe(state);
    }
  });
});

describe('FixedFloat', () => {
  const f = fixture('fixedfloat.json');
  const make = (routes: ConstructorParameters<typeof FixtureHttp>[0], clock = { t: NOW }) => {
    const http = new FixtureHttp(routes);
    return { http, clock, a: new FixedFloatAdapter({ http, prices: prices(), apiKeyEnv: 'FF_KEY', apiSecretEnv: 'FF_SECRET', env, now: () => clock.t }) };
  };

  it('signs the exact body with HMAC-SHA256 (RFC 4231 test case 2)', () => {
    expect(fixedFloatSign('what do ya want for nothing?', 'Jefe')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('quotes with a signed request', async () => {
    const { http, a } = make([{ method: 'POST', path: '/price', body: f.price }]);
    const q = await a.quote(req());
    expect(q.amountIn).toBe(2_000_000_000n);
    expect(q.amountOut).toBe(4_946_000_000_000n);
    expect(q.costPct).toBeCloseTo(1.08, 6);
    const sent = http.last('/price');
    expect(sent.url).toBe('https://ff.io/api/v2/price');
    expect(sent.body).toBe('{"type":"float","fromCcy":"USDCSOL","toCcy":"XMR","direction":"from","amount":"2000"}');
    expect(sent.headers?.['X-API-KEY']).toBe(KEY);
    expect(sent.headers?.['X-API-SIGN']).toBe(createHmac('sha256', SECRET).update(sent.body!).digest('hex'));
  });

  it('prices a fixed output with direction "to", and refuses a quote the service flags', async () => {
    const { http, a } = make([{ method: 'POST', path: '/price', body: f.price }]);
    const { amountIn: _drop, ...byOut } = req({ rate: 'fixed' });
    await a.quote({ ...byOut, amountOut: 4_946_000_000_000n });
    expect(JSON.parse(http.last('/price').body!)).toEqual({ type: 'fixed', fromCcy: 'USDCSOL', toCcy: 'XMR', direction: 'to', amount: '4.946' });
    http.routes = [{ method: 'POST', path: '/price', body: f.price_limit_min }];
    await expect(a.quote(req({ amountIn: 1_000_000n }))).rejects.toThrow(/LIMIT_MIN/);
  });

  it('reads the pair limits from /price even when the probe amount is refused', async () => {
    const { a } = make([{ method: 'POST', path: '/price', body: f.price_limit_min }]);
    expect(await a.limits('usdc_sol', 'xmr')).toEqual({ min: 30_000_000n, max: 250_000_000_000n });
  });

  it('creates, sends, and keeps the order token and refund address in the handle for the emergency call', async () => {
    const { http, a } = make([
      { method: 'POST', path: '/price', body: f.price },
      { method: 'POST', path: '/create', body: f.create },
      { method: 'POST', path: '/order', body: f.order_emergency },
      { method: 'POST', path: '/emergency', body: f.emergency_ok },
    ]);
    const ctx = fakeCtx(NOW);
    const { handle } = await a.execute(await a.quote(req()), ctx);
    expect(JSON.parse(http.last('/create').body!)).toEqual({ type: 'float', fromCcy: 'USDCSOL', toCcy: 'XMR', direction: 'from', amount: '2000', toAddress: XMR_ADDR });
    expect(ctx.sol).toEqual([{ kind: 'transfer', asset: 'usdc_sol', to: 'FfDepositAddr111111111111111111111111111111', amount: 2_000_000_000n }]);
    expect(handle).toBe(`fixedfloat:TESTFF:order-token-not-a-credential:xmr:${SOL_ADDR}`);

    const st = await a.status(handle);
    expect(st).toMatchObject({ state: 'held', txids: ['5FfPayin'], detail: expect.stringContaining('LIMIT') });
    expect(JSON.parse(http.last('/order').body!)).toEqual({ id: 'TESTFF', token: 'order-token-not-a-credential' });

    await a.resolveHeld(handle, 'refund');
    expect(JSON.parse(http.last('/emergency').body!)).toEqual({ id: 'TESTFF', token: 'order-token-not-a-credential', choice: 'REFUND', address: SOL_ADDR });
    await a.resolveHeld(handle, 'continue');
    expect(JSON.parse(http.last('/emergency').body!)).toEqual({ id: 'TESTFF', token: 'order-token-not-a-credential', choice: 'EXCHANGE' });
    expect(everythingSeen(ctx)).not.toContain(KEY);
    expect(everythingSeen(ctx)).not.toContain(SECRET);
  });

  it('maps DONE, and DONE after a refund choice to refunded', async () => {
    const { http, a } = make([{ method: 'POST', path: '/order', body: f.order_done }]);
    const h = `fixedfloat:TESTFF:tok:xmr:${SOL_ADDR}`;
    expect(await a.status(h)).toEqual({ state: 'done', received: 4_944_100_000_000n, txids: ['5FfPayin', 'ffpayouttxid'] });
    http.routes = [{ method: 'POST', path: '/order', body: f.order_refunded }];
    expect(await a.status(h)).toEqual({ state: 'refunded', txids: ['5FfPayin', '5FfRefund'] });
  });

  it('turns a non-zero code into an error without the key, secret or signature', async () => {
    const { a } = make([{ method: 'POST', path: '/price', status: 200, body: f.error_sign }]);
    const err = await a.quote(req()).catch((e) => e);
    expect(err.message).toBe('POST https://ff.io/api/v2/price -> 200: code 401: Invalid signature');
  });

  it('stays inside 250 weight units a minute: create costs 50', async () => {
    const { http, a, clock } = make([{ method: 'POST', path: '/price', body: f.price }, { method: 'POST', path: '/create', body: f.create }]);
    const q = await a.quote(req());                               // 1 unit
    for (let i = 0; i < 4; i++) await a.execute(q, fakeCtx(NOW)); // 4 x 50
    expect(http.count('/create')).toBe(4);
    await expect(a.execute(q, fakeCtx(NOW))).rejects.toThrow(/rate budget/); // 201 + 50 > 250
    expect(http.count('/create')).toBe(4);
    clock.t = NOW + 61;
    await a.quote(req());                                          // the window has moved on
  });
});
