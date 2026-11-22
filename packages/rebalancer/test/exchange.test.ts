/**
 * The generic exchange adapter (with a scripted driver) and the Kraken driver against
 * HAND-WRITTEN fixtures (see fixtures/README.md).
 */
import { describe, expect, it } from 'vitest';
import { type AssetId, ExchangeAdapter, type ExchangeDriver, KrakenDriver, MemoryStore, type RefillRequest, VenueError, krakenSign } from '../src/index.js';
import { ETH_ADDR, FixtureHttp, SOL_ADDR, XMR_ADDR, everythingSeen, fakeCtx, fixture, prices } from './helpers.js';

const NOW = 1_800_000_000;
const req = (over: Partial<RefillRequest> = {}): RefillRequest => ({ from: 'usdc_sol', to: 'xmr', amountIn: 2_000_000_000n, rate: 'float', payoutAddress: XMR_ADDR, refundAddress: SOL_ADDR, ...over });

/** A driver whose answers the test sets step by step, and which counts what it was asked to do. */
function scripted() {
  const s = {
    credited: null as bigint | null, order: { state: 'open' as 'open' | 'filled' | 'failed', received: undefined as bigint | undefined },
    withdrawal: { state: 'pending' as 'pending' | 'sent' | 'held' | 'failed', txid: undefined as string | undefined },
    orders: [] as { from: AssetId; to: AssetId; amountIn: bigint; clientId: string }[], withdrawals: [] as { asset: AssetId; address: string; amount: bigint }[],
    failOrder: false, failWithdraw: false, memo: undefined as string | undefined,
  };
  const driver: ExchangeDriver = {
    name: 'scripted',
    ready: () => ({ ok: true }),
    depositAddress: async () => (s.memo ? { address: 'ExDeposit', memo: s.memo } : { address: 'ExDeposit' }),
    balance: async () => 0n,
    depositCredited: async () => s.credited,
    // 1 XMR = 402 USDC on this exchange, i.e. 0.5% worse than the 400 reference.
    estimate: async (from, to, amountIn) => (from === to || (from.startsWith('usdc') && to.startsWith('usdc')) ? amountIn : (amountIn * 1_000_000n) / 402n),
    marketOrder: async (o) => { if (s.failOrder) throw new Error('socket hang up'); s.orders.push(o); return { orderId: 'ORD1' }; },
    orderStatus: async () => (s.order.received === undefined ? { state: s.order.state } : { state: s.order.state, received: s.order.received }),
    withdrawFee: async (asset) => (asset === 'xmr' ? 100_000_000n : 1_000_000n),
    withdraw: async (w) => { if (s.failWithdraw) throw new Error('gateway timeout'); s.withdrawals.push(w); return { withdrawalId: 'W1' }; },
    withdrawalStatus: async () => (s.withdrawal.txid ? { state: s.withdrawal.state, txid: s.withdrawal.txid } : { state: s.withdrawal.state }),
    limits: async () => ({ min: 10_000_000n, max: null }),
    needsTrade: (from, to) => !(from.startsWith('usdc') && to.startsWith('usdc')),
  };
  return { s, driver };
}

describe('exchange adapter', () => {
  it('quotes the trade net of the withdrawal fee, against the reference price', async () => {
    const { driver } = scripted();
    const a = new ExchangeAdapter({ driver, prices: prices(), now: () => NOW });
    const q = await a.quote(req());
    // 2000 / 402 = 4.975124378109 XMR, less the 0.0001 XMR withdrawal fee.
    expect(q.amountOut).toBe(4_975_024_378_109n);
    expect(q.costPct).toBeCloseTo(0.4995, 3);
    expect(await a.limits('usdc_sol', 'xmr')).toEqual({ min: 10_000_000n, max: null });
  });

  it('runs deposit -> credit -> trade -> withdraw, journalling each step before it acts', async () => {
    const { s, driver } = scripted();
    const store = new MemoryStore();
    const a = new ExchangeAdapter({ driver, prices: prices(), store, now: () => NOW });
    const ctx = fakeCtx(NOW);
    const { handle } = await a.execute(await a.quote(req()), ctx);
    expect(ctx.sol).toEqual([{ kind: 'transfer', asset: 'usdc_sol', to: 'ExDeposit', amount: 2_000_000_000n }]);
    expect(ctx.order.slice(0, 2)).toEqual(['journal:exchange.send_deposit', 'send:sol']);
    expect(await a.status(handle)).toEqual({ state: 'depositing', txids: ['solsig1'] });

    // Not credited yet: nothing is traded.
    expect((await a.advance(handle, ctx)).state).toBe('depositing');
    expect(s.orders).toEqual([]);

    // The exchange credited slightly less than was sent; the trade uses what was credited.
    s.credited = 1_999_000_000n;
    expect((await a.advance(handle, ctx)).state).toBe('processing');
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({ from: 'usdc_sol', to: 'xmr', amountIn: 1_999_000_000n });
    const journalIdx = ctx.journalled.findIndex((j) => j.step === 'exchange.market_order');
    expect(journalIdx).toBeGreaterThan(-1);

    // Open order: polling again does not place a second one.
    await a.advance(handle, ctx);
    await a.advance(handle, ctx);
    expect(s.orders).toHaveLength(1);

    s.order = { state: 'filled', received: 4_970_000_000_000n };
    expect((await a.advance(handle, ctx)).state).toBe('paying_out');
    expect(s.withdrawals).toEqual([{ asset: 'xmr', address: XMR_ADDR, amount: 4_970_000_000_000n }]);
    await a.advance(handle, ctx);
    expect(s.withdrawals).toHaveLength(1);

    s.withdrawal = { state: 'sent', txid: 'xmrpayout' };
    expect(await a.advance(handle, ctx)).toEqual({ state: 'done', received: 4_970_000_000_000n, txids: ['solsig1', 'xmrpayout'] });
    expect(ctx.journalled.map((j) => j.step)).toEqual(['exchange.send_deposit', 'exchange.deposit_sent', 'exchange.deposit_credited', 'exchange.market_order', 'exchange.order_filled', 'exchange.withdraw', 'exchange.withdrawn']);
  });

  it('never repeats an order or a withdrawal whose outcome is unknown: the refill is held', async () => {
    for (const which of ['failOrder', 'failWithdraw'] as const) {
      const { s, driver } = scripted();
      const a = new ExchangeAdapter({ driver, prices: prices(), now: () => NOW });
      const ctx = fakeCtx(NOW);
      const { handle } = await a.execute(await a.quote(req()), ctx);
      s.credited = 2_000_000_000n;
      s.order = { state: 'filled', received: 4_970_000_000_000n };
      s[which] = true;
      const st = await a.advance(handle, ctx);
      expect(st.state).toBe('held');
      expect(st.detail).toMatch(/outcome unknown.*not (placed|requested) again/);
      s[which] = false;
      await a.advance(handle, ctx);
      await a.advance(handle, ctx);
      expect(which === 'failOrder' ? s.orders : s.withdrawals).toEqual([]);
    }
  });

  it('holds a refill that was interrupted between recording an intent and the API call', async () => {
    const { s, driver } = scripted();
    const store = new MemoryStore();
    const a = new ExchangeAdapter({ driver, prices: prices(), store, now: () => NOW });
    const ctx = fakeCtx(NOW);
    const { handle } = await a.execute(await a.quote(req()), ctx);
    // Simulate a crash right after the intent was saved.
    const rec = JSON.parse((await store.get(handle))!);
    await store.put(handle, JSON.stringify({ ...rec, phase: 'order_intent', credited: '2000000000', clientId: 'x' }));
    const restarted = new ExchangeAdapter({ driver, prices: prices(), store, now: () => NOW });
    expect(await restarted.advance(handle, ctx)).toMatchObject({ state: 'held', detail: expect.stringContaining('not placed again') });
    expect(s.orders).toEqual([]);
  });

  it('moves USDC across chains without a trade', async () => {
    const { s, driver } = scripted();
    const a = new ExchangeAdapter({ driver, prices: prices(), now: () => NOW });
    const ctx = fakeCtx(NOW);
    const q = await a.quote({ from: 'usdc_sol', to: 'usdc_eth', amountIn: 5_000_000_000n, rate: 'float', payoutAddress: ETH_ADDR, refundAddress: SOL_ADDR });
    expect(q.amountOut).toBe(4_999_000_000n);
    const { handle } = await a.execute(q, ctx);
    s.credited = 5_000_000_000n;
    expect((await a.advance(handle, ctx)).state).toBe('paying_out');
    expect(s.orders).toEqual([]);
    expect(s.withdrawals).toEqual([{ asset: 'usdc_eth', address: ETH_ADDR, amount: 5_000_000_000n }]);
  });

  it('refuses a deposit address that needs a memo, and an unconfirmed deposit is funds-moved', async () => {
    const { s, driver } = scripted();
    const a = new ExchangeAdapter({ driver, prices: prices(), now: () => NOW });
    s.memo = '991';
    const ctx = fakeCtx(NOW);
    await expect(a.execute(await a.quote(req()), ctx)).rejects.toThrow(/memo/);
    expect(ctx.sol).toEqual([]);
    s.memo = undefined;
    ctx.failNextSend = 'timeout';
    const err = await a.execute(await a.quote(req()), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect(err.fundsMoved).toBe(true);
  });
});

describe('Kraken driver', () => {
  const f = fixture('kraken.json');
  const KEY = 'kraken-key-CCCC3333';
  // base64 of 'kraken-test-secret-not-real'
  const SECRET = Buffer.from('kraken-test-secret-not-real').toString('base64');
  const env = (n: string) => ({ EXCHANGE_KEY: KEY, EXCHANGE_SECRET: SECRET })[n];
  const make = (routes: ConstructorParameters<typeof FixtureHttp>[0]) => {
    const http = new FixtureHttp(routes);
    let n = 1_800_000_000_000;
    return { http, d: new KrakenDriver({ http, apiKeyEnv: 'EXCHANGE_KEY', apiSecretEnv: 'EXCHANGE_SECRET', env, nonce: () => n++, withdrawKeys: { [XMR_ADDR]: 'maker-xmr' } }) };
  };

  it('reproduces the API-Sign of the worked example in Kraken\'s documentation', () => {
    // Published example values, not a credential.
    const sign = krakenSign('/0/private/AddOrder', '1616492376594', 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25',
      'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==');
    expect(sign).toBe('4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
  });

  it('signs private calls and sends a strictly increasing nonce', async () => {
    const { http, d } = make([{ method: 'POST', path: '/0/private/DepositAddresses', body: f.deposit_addresses }]);
    expect(await d.depositAddress('usdc_sol')).toEqual({ address: 'KrDepositAddr111111111111111111111111111111' });
    await d.depositAddress('usdc_sol');
    const [a, b] = http.requests;
    expect(a!.url).toBe('https://api.kraken.com/0/private/DepositAddresses');
    expect(a!.headers?.['API-Key']).toBe(KEY);
    const nonceA = new URLSearchParams(a!.body!).get('nonce')!, nonceB = new URLSearchParams(b!.body!).get('nonce')!;
    expect(BigInt(nonceB)).toBeGreaterThan(BigInt(nonceA));
    expect(a!.headers?.['API-Sign']).toBe(krakenSign('/0/private/DepositAddresses', nonceA, a!.body!, SECRET));
    expect(new URLSearchParams(a!.body!).get('asset')).toBe('USDC');
  });

  it('estimates through USD from the two tickers, after the taker fee on each leg', async () => {
    const { d } = make([
      { method: 'GET', path: '/0/public/Ticker', when: 'pair=USDCUSD', body: f.ticker_usdc },
      { method: 'GET', path: '/0/public/Ticker', when: 'pair=XMRUSD', body: f.ticker_xmr },
    ]);
    // 2000 USDC * 1.0000 * 0.996 = 1992 USD; / 401.00 = 4.967581047 XMR; * 0.996 = 4.947710723192 XMR
    expect(await d.estimate('usdc_sol', 'xmr', 2_000_000_000n)).toBe(4_947_710_723_192n);
    expect(await d.estimate('usdc_sol', 'usdc_eth', 2_000_000_000n)).toBe(2_000_000_000n);
    expect(d.needsTrade('usdc_sol', 'usdc_eth')).toBe(false);
  });

  it('reports a deposit as credited only once its status is Success', async () => {
    const { http, d } = make([{ method: 'POST', path: '/0/private/DepositStatus', body: f.deposit_status_pending }]);
    expect(await d.depositCredited('usdc_sol', 'solsig1')).toBeNull();
    http.routes = [{ method: 'POST', path: '/0/private/DepositStatus', body: f.deposit_status_success }];
    expect(await d.depositCredited('usdc_sol', 'solsig1')).toBe(2_000_000_000n);
    expect(await d.depositCredited('usdc_sol', 'another')).toBeNull();
  });

  it('withdraws only to an address registered under a key name', async () => {
    const { http, d } = make([{ method: 'POST', path: '/0/private/Withdraw', body: f.withdraw }, { method: 'POST', path: '/0/private/WithdrawInfo', body: f.withdraw_info }]);
    expect(await d.withdraw({ asset: 'xmr', address: XMR_ADDR, amount: 4_952_000_000_000n })).toEqual({ withdrawalId: 'WREF-123' });
    expect(Object.fromEntries(new URLSearchParams(http.last('/Withdraw').body!))).toMatchObject({ asset: 'XMR', key: 'maker-xmr', amount: '4.952' });
    expect(await d.withdrawFee('xmr', XMR_ADDR, 4_952_000_000_000n)).toBe(100_000_000n);
    await expect(d.withdraw({ asset: 'xmr', address: '4' + 'Q'.repeat(94), amount: 1n })).rejects.toThrow(/not registered as a withdrawal key/);
    expect(http.count('/Withdraw')).toBe(1);
  });

  it('drives a whole USDC -> XMR refill through the adapter: sell for USD, buy with the proceeds, withdraw', async () => {
    const { http, d } = make([
      { method: 'GET', path: '/0/public/Ticker', when: 'pair=USDCUSD', body: f.ticker_usdc },
      { method: 'GET', path: '/0/public/Ticker', when: 'pair=XMRUSD', body: f.ticker_xmr },
      { method: 'POST', path: '/0/private/WithdrawInfo', body: f.withdraw_info },
      { method: 'POST', path: '/0/private/DepositAddresses', body: f.deposit_addresses },
      { method: 'POST', path: '/0/private/DepositStatus', body: f.deposit_status_success },
      { method: 'POST', path: '/0/private/AddOrder', when: 'type=sell', body: f.add_order_sell },
      { method: 'POST', path: '/0/private/AddOrder', when: 'type=buy', body: f.add_order_buy },
      { method: 'POST', path: '/0/private/QueryOrders', when: 'OSELL', body: f.query_sell_closed },
      { method: 'POST', path: '/0/private/QueryOrders', when: 'OBUY', body: f.query_buy_closed },
      { method: 'POST', path: '/0/private/OpenOrders', body: f.open_orders_none },
      { method: 'POST', path: '/0/private/ClosedOrders', body: f.closed_orders_sell_only },
      { method: 'POST', path: '/0/private/Withdraw', body: f.withdraw },
      { method: 'POST', path: '/0/private/WithdrawStatus', body: f.withdraw_status_pending },
    ]);
    const a = new ExchangeAdapter({ driver: d, prices: prices(), now: () => NOW });
    const ctx = fakeCtx(NOW);
    const q = await a.quote(req());
    expect(q.amountOut).toBe(4_947_610_723_192n);
    const { handle } = await a.execute(q, ctx);
    expect(ctx.sol[0]).toMatchObject({ to: 'KrDepositAddr111111111111111111111111111111', amount: 2_000_000_000n });

    expect((await a.advance(handle, ctx)).state).toBe('paying_out');
    const sell = Object.fromEntries(new URLSearchParams(http.requests.find((r) => r.url.endsWith('/AddOrder') && r.body!.includes('type=sell'))!.body!));
    expect(sell).toMatchObject({ pair: 'USDCUSD', type: 'sell', ordertype: 'market', volume: '2000' });
    const buy = Object.fromEntries(new URLSearchParams(http.requests.find((r) => r.url.endsWith('/AddOrder') && r.body!.includes('type=buy'))!.body!));
    // The buy spends exactly what the sell returned: cost 2000 less the 6 USD fee.
    expect(buy).toMatchObject({ pair: 'XMRUSD', type: 'buy', ordertype: 'market', volume: '1994', oflags: 'viqc', userref: sell['userref'] });
    // The withdrawal is the base volume the buy executed.
    expect(Object.fromEntries(new URLSearchParams(http.last('/Withdraw').body!))).toMatchObject({ asset: 'XMR', key: 'maker-xmr', amount: '4.9521' });

    http.routes = http.routes.map((r) => (r.path.endsWith('/WithdrawStatus') ? { ...r, body: f.withdraw_status_success } : r));
    expect(await a.advance(handle, ctx)).toEqual({ state: 'done', received: 4_952_000_000_000n, txids: ['solsig1', 'krpayouttxid'] });
    expect(http.count('/AddOrder')).toBe(2);
    expect(http.count('/Withdraw')).toBe(1);
    expect(everythingSeen(ctx)).not.toContain(KEY);
    expect(everythingSeen(ctx)).not.toContain(SECRET);
  });

  it('finds a second leg that was already placed instead of placing it again', async () => {
    const { http, d } = make([
      { method: 'POST', path: '/0/private/QueryOrders', when: 'OSELL', body: f.query_sell_closed },
      { method: 'POST', path: '/0/private/QueryOrders', when: 'OBUY', body: f.query_buy_closed },
      { method: 'POST', path: '/0/private/OpenOrders', body: f.open_orders_none },
      { method: 'POST', path: '/0/private/ClosedOrders', body: f.closed_orders_both },
    ]);
    expect(await d.orderStatus('OSELL-AAAAA-111111|77', 'usdc_sol', 'xmr')).toEqual({ state: 'filled', received: 4_952_100_000_000n });
    expect(http.count('/AddOrder')).toBe(0);
  });

  it('surfaces API errors without the key, and reports missing credentials by variable name only', async () => {
    const { d } = make([{ method: 'POST', path: '/0/private/Balance', body: f.error_key }]);
    const err = await d.balance('xmr').catch((e) => e);
    expect(err.message).toBe('POST https://api.kraken.com/0/private/Balance -> 200: EAPI:Invalid key');
    const none = new KrakenDriver({ http: new FixtureHttp([]), apiKeyEnv: 'EXCHANGE_KEY', apiSecretEnv: 'EXCHANGE_SECRET', env: () => undefined, withdrawKeys: {} });
    expect(none.ready()).toEqual({ ok: false, reason: 'kraken: environment variable EXCHANGE_KEY (API key) is not set' });
  });
});
