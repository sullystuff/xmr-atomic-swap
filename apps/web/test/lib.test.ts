// Pure logic: formatting, settings, ranking and reference prices, the router wiring of the
// large-swap tool, node agreement, the sealed store and the vault.
import { describe, expect, it } from 'vitest';
import { COUNTER } from '@xmrswap/protocol';
import { type LegState, init } from '@xmrswap/sdk';
import { formatAsset, formatClock, formatDuration, formatUnits, formatXmrAmount, looksLikeXmrAddress, parseUnits, parseXmr } from '../src/lib/format.js';
import { rankRows, referenceFor, vsReferenceBps } from '../src/lib/market.js';
import { type Order, nextWave, orderProgress, planOrder, stalledMakers } from '../src/lib/orders.js';
import { SealedStore } from '../src/lib/sealed.js';
import { DEFAULT_SETTINGS, MODE_INFO, relayUrlOf, settingsProblems } from '../src/lib/settings.js';
import { moneroAgreement, upgradeCheck } from '../src/lib/status.js';
import { MemoryKV } from '../src/lib/storage.js';
import { Vault, seedTag } from '../src/lib/vault.js';
import { SOL, T0, TAKER_SEED, XMR, row } from './fakes.js';

// The fixtures below derive real keys at collection time.
await init();

describe('amounts are exact and never rounded up', () => {
  it('formats and parses atomic units', () => {
    expect(formatUnits(1_234_567_891n, 9, 6)).toBe('1.234567');
    expect(formatUnits(1_999_999_999n, 9, 2, 2)).toBe('1.99');
    expect(formatAsset(750_000_000n, 'sol')).toBe('0.75');
    expect(formatAsset(1_234_500_000n, 'usdc_sol')).toBe('1,234.50');
    expect(formatXmrAmount(XMR / 2n)).toBe('0.50');
    expect(parseXmr('1.5')).toBe(1_500_000_000_000n);
    expect(parseXmr('0.0000000000001')).toBeNull();
    expect(parseUnits('1,000.25', 6)).toBe(1_000_250_000n);
    for (const bad of ['', '-1', '1e3', 'abc', '1.2.3']) expect(parseUnits(bad, 9), bad).toBeNull();
  });
  it('formats durations, countdowns and checks address shape', () => {
    expect(formatDuration(6060)).toBe('1 h 41 min');
    expect(formatDuration(245)).toBe('4 min 05 s');
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatClock(3661)).toBe('1:01:01');
    expect(formatClock(59)).toBe('00:59');
    expect(looksLikeXmrAddress(`4${'A'.repeat(94)}`)).toBe(true);
    expect(looksLikeXmrAddress('4short')).toBe(false);
    expect(looksLikeXmrAddress(`4${'0'.repeat(94)}`)).toBe(false);
  });
});

describe('settings have no hidden defaults', () => {
  const ok = { ...DEFAULT_SETTINGS, solanaRpc: 'https://rpc.example', moneroNodes: ['https://a.example', 'https://b.example'] };
  it('requires a Solana RPC and two nodes, or one node declared as the user own', () => {
    expect(settingsProblems(DEFAULT_SETTINGS, false).map((p) => p.field)).toEqual(['solanaRpc', 'moneroNodes']);
    expect(settingsProblems(ok, false)).toEqual([]);
    const one = { ...ok, moneroNodes: ['https://a.example'] };
    expect(settingsProblems(one, false)[0]!.message).toMatch(/A single dishonest node could fake a lock and you could lose your funds/);
    expect(settingsProblems({ ...one, ownNode: true }, false)).toEqual([]);
    expect(settingsProblems({ ...ok, moneroNodes: ['https://a.example', 'https://a.example'] }, false)[0]!.message).toMatch(/one source, not two/);
  });
  it('an HTTPS page cannot use a plain-http node other than localhost', () => {
    const s = { ...ok, moneroNodes: ['http://node.example:18081', 'http://127.0.0.1:18081'] };
    const p = settingsProblems(s, true);
    expect(p).toHaveLength(1);
    expect(p[0]!.message).toMatch(/cannot call http:\/\/node\.example:18081/);
    expect(settingsProblems(s, false)).toEqual([]);
  });
  it('the relay is used only in the relay modes, and every mode says what it reveals', () => {
    expect(relayUrlOf({ ...ok, mode: 'hosted', relayUrl: 'https://relay.example/' })).toBe('https://relay.example');
    expect(relayUrlOf({ ...ok, mode: 'onchain', relayUrl: 'https://relay.example' })).toBeNull();
    expect(relayUrlOf({ ...ok, mode: 'tor-direct', relayUrl: 'https://relay.example' })).toBeNull();
    expect(MODE_INFO.hosted.learnsIp).toMatch(/site operator sees your IP address/);
    expect(MODE_INFO['self-hosted'].note).toContain('RELAY_ALLOWED_ORIGINS');
    expect(MODE_INFO['self-hosted'].learnsIp).toMatch(/Nobody on the relay side/);
    expect(MODE_INFO['tor-direct'].note).toMatch(/Untested/);
    expect(MODE_INFO.onchain.learnsIp).toMatch(/Solana RPC provider/);
    expect(MODE_INFO.onchain.note).toMatch(/Ethereum swaps need a relay/);
  });
});

describe('offers', () => {
  const rows = [
    row(1, { price: (150n * SOL) / 100n }, { volume: 10n * SOL, counters: { [COUNTER.completed]: 4 } }),
    row(2, { price: (148n * SOL) / 100n }, { volume: 500n * SOL, counters: { [COUNTER.completed]: 90, [COUNTER.withholds]: 1, [COUNTER.deposits_returned]: 3, [COUNTER.missed_notices]: 2, [COUNTER.approvals]: 9, [COUNTER.rejections]: 1 }, responseSecsSum: 180n }),
    row(3, { price: (149n * SOL) / 100n, mode: 1 }, { volume: 500n * SOL, counters: { [COUNTER.completed]: 20 } }),
    row(4, { price: (140n * SOL) / 100n, direction: 1 }, { volume: 900n * SOL }),
  ];
  it('ranks by completed volume, then completed swaps, and filters by market, direction and approval mode', () => {
    expect(rankRows(rows, { market: 'sol', direction: 0, mode: null }).map((r) => r.id)).toEqual([rows[1]!.id, rows[2]!.id, rows[0]!.id]);
    expect(rankRows(rows, { market: 'sol', direction: 0, mode: 1 }).map((r) => r.id)).toEqual([rows[2]!.id]);
    expect(rankRows(rows, { market: 'sol', direction: 1, mode: null }).map((r) => r.id)).toEqual([rows[3]!.id]);
    expect(rankRows(rows, { market: 'usdc_sol', direction: 0, mode: null })).toEqual([]);
  });
  it('carries the maker history: approval rate, response time, faults and withhold rate, absolute and relative', () => {
    const rep = rows[1]!.maker.identity.reputation;
    expect(rep).toMatchObject({ completed: 90, approvalRate: 0.9, meanResponseSecs: 20, withholdRate: 0.25, unreleased: 1 });
    expect(rep.faults.total).toBe(2);
    expect(rep.perCompleted.faults).toBeCloseTo(2 / 90);
    // A maker with no history has no rates, and the router treats it as withholding every time.
    expect(rows[0]!.maker.identity.reputation).toMatchObject({ approvalRate: null, withholdRate: null });
  });
  it('compares rates with the user own reference when set, otherwise the median offer, and fetches nothing', () => {
    const buy = rows.filter((r) => r.direction === 0);
    expect(referenceFor('sol', buy, { refXmrUsd: '', refSolUsd: '', refEthUsd: '' })).toEqual({ price: (149n * SOL) / 100n, source: 'median' });
    expect(referenceFor('sol', buy, { refXmrUsd: '300', refSolUsd: '200', refEthUsd: '' })).toEqual({ price: (150n * SOL) / 100n, source: 'settings' });
    expect(referenceFor('usdc_sol', [], { refXmrUsd: '300.5', refSolUsd: '', refEthUsd: '' })).toEqual({ price: 300_500_000n, source: 'settings' });
    expect(referenceFor('eth', [], { refXmrUsd: '', refSolUsd: '', refEthUsd: '' })).toBeNull();
    expect(vsReferenceBps((1515n * SOL) / 1000n, (150n * SOL) / 100n)).toBe(100);
  });
});

describe('large-swap orders', () => {
  const rows = [row(1, { price: (150n * SOL) / 100n, maxXmr: (3n * XMR) / 10n }), row(2, { price: (151n * SOL) / 100n, maxXmr: (3n * XMR) / 10n }), row(3, { price: (152n * SOL) / 100n, maxXmr: (3n * XMR) / 10n })];
  const order = (o: Partial<Order> = {}): Order => ({ id: 'o', market: 'sol', totalPay: ((12n * SOL) / 10n).toString(), worstPrice: ((16n * SOL) / 10n).toString(), maxInFlight: ((9n * SOL) / 10n).toString(), deadline: (T0 + 7200n).toString(), destination: 'x', referencePrice: null, minDepth: 0, createdAt: 0, legs: [], excluded: [], caps: {}, stopped: false, ...o });
  const plan = (o: Order) => planOrder(o, rows, BigInt(o.totalPay), BigInt(o.maxInFlight));

  it('the plan is the router: waves under the in-flight limit, one leg per maker per wave, stop at the worst rate', () => {
    const p = plan(order());
    expect(p.waves.map((w) => w.legs.map((l) => l.makerId))).toEqual([[rows[0]!.maker.pda, rows[1]!.maker.pda], [rows[0]!.maker.pda]]);
    expect(p.waves[0]!.pay <= (9n * SOL) / 10n).toBe(true);
    expect(p.unfilledPay).toBe(0n);
    // Two SOL legs travel in one transaction.
    expect(p.waves[0]!.transactions).toEqual([[0, 1]]);
    const strict = plan(order({ worstPrice: ((1505n * SOL) / 1000n).toString() }));
    expect(strict.waves.flatMap((w) => w.legs.map((l) => l.makerId))).toEqual([rows[0]!.maker.pda, rows[0]!.maker.pda, rows[0]!.maker.pda]);
    expect(strict.dropped.map((d) => d.reason)).toContain('worse-than-limit');
  });

  it('edits are constraints on the router input: a removed maker and a capped leg are re-planned around', () => {
    const removed = plan(order({ excluded: [rows[0]!.maker.pda] }));
    expect(removed.waves[0]!.legs.map((l) => l.makerId)).toEqual([rows[1]!.maker.pda, rows[2]!.maker.pda]);
    const capped = plan(order({ caps: { [rows[0]!.id]: (XMR / 10n).toString() } }));
    expect(capped.waves[0]!.legs[0]).toMatchObject({ makerId: rows[0]!.maker.pda, xmr: XMR / 10n });
    expect(capped.waves[0]!.legs.length).toBeGreaterThan(1);
  });

  it('a stalled maker is left out, the remainder is re-planned within the limit, and the report lists filled and unfilled', () => {
    const legs = plan(order()).waves[0]!.legs.map((l, i) => ({ offerId: l.offerId, makerPda: l.makerId, xmr: l.xmr.toString(), pay: l.pay.toString(), price: l.price.toString(), depth: l.depth, wave: 1, ref: `ref${i}` }));
    let o = order({ legs });
    const states: Record<string, LegState> = { ref0: 'locked', ref1: 'locked' };
    const stateOf = (r: string) => states[r];
    // Both legs in flight: the limit is used up, nothing opens.
    expect(nextWave(o, rows, stateOf, T0)).toBeNull();
    expect(orderProgress(o, stateOf, T0, null)).toMatchObject({ finished: false, room: 0n });

    // Leg 0 is claimed; leg 1 is still locked with maker 2, so maker 2 is busy and maker 1 is free again.
    states.ref0 = 'claimed';
    const w2 = nextWave(o, rows, stateOf, T0)!;
    expect(w2.legs.map((l) => l.makerId)).toEqual([rows[0]!.maker.pda]);
    expect(w2.pay <= (45n * SOL) / 100n).toBe(true);

    // Maker 2 stalls and its leg is refunded: it is excluded from then on.
    states.ref1 = 'refunded';
    expect(stalledMakers(o, stateOf)).toEqual([rows[1]!.maker.pda]);
    o = { ...o, excluded: stalledMakers(o, stateOf) };
    const w3 = nextWave(o, rows, stateOf, T0)!;
    expect(w3.legs.map((l) => l.makerId).includes(rows[1]!.maker.pda)).toBe(false);

    // After the order deadline no wave opens and the remainder is reported unfilled.
    expect(nextWave(o, rows, stateOf, T0 + 7201n)).toBeNull();
    const p = orderProgress(o, stateOf, T0 + 7201n, null);
    expect(p).toMatchObject({ finished: true, stoppedBecause: 'deadline' });
    expect(p.report.filledPay).toBe(BigInt(legs[0]!.pay));
    expect(p.report.refundedPay).toBe(BigInt(legs[1]!.pay));
    expect(p.report.unfilledPay).toBe(BigInt(o.totalPay) - BigInt(legs[0]!.pay));
    // A stopped order opens nothing either.
    expect(nextWave({ ...o, stopped: true }, rows, stateOf, T0)).toBeNull();
  });
});

describe('status checks', () => {
  const info = (height: number, top = `h${height}`) => ({ height, top_block_hash: top });
  it('Monero nodes agree only when all answer, are within a block, and report the same block at the same height', () => {
    expect(moneroAgreement([], false).state).toBe('fail');
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }, { url: 'b', info: info(100), error: null }], false)).toMatchObject({ state: 'ok', detail: expect.stringMatching(/2 nodes in agreement/) });
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }, { url: 'b', info: info(101), error: null }], false).state).toBe('ok');
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }, { url: 'b', info: info(100, 'other'), error: null }], false)).toMatchObject({ state: 'fail', detail: expect.stringMatching(/different chains/) });
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }, { url: 'b', info: info(140), error: null }], false)).toMatchObject({ state: 'fail', detail: expect.stringMatching(/40 blocks apart/) });
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }, { url: 'b', info: null, error: 'timeout' }], false)).toMatchObject({ state: 'fail', detail: expect.stringMatching(/b did not answer \(timeout\)/) });
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }], false).state).toBe('fail');
    expect(moneroAgreement([{ url: 'a', info: info(100), error: null }], true).state).toBe('ok');
  });
  it('states the upgrade status of each contract', () => {
    expect(upgradeCheck('u', 'Solana program', { frozen: false, authority: 'Auth' }, true)).toMatchObject({ state: 'warn', label: 'Solana program: still upgradable', detail: expect.stringMatching(/held by Auth.*could take funds in escrow/) });
    expect(upgradeCheck('u', 'Solana program', { frozen: true, authority: null }, true)).toMatchObject({ state: 'ok', label: 'Solana program: immutable' });
    expect(upgradeCheck('u', 'Ethereum contract', { frozen: null, authority: null }, true).state).toBe('warn');
    expect(upgradeCheck('u', 'Ethereum contract', { frozen: null, authority: null }, false).state).toBe('off');
  });
});

describe('what is kept on the device', () => {
  it('the sealed store is unreadable without the seed and under another seed', async () => {
    const kv = new MemoryKV();
    let seed: Uint8Array | null = TAKER_SEED;
    const store = new SealedStore(kv, () => seed);
    expect(await store.put('order.1', { destination: '4secret', total: '12' })).toBe(true);
    expect([...kv.map.values()][0]).not.toContain('4secret');
    expect(await store.get('order.1')).toEqual({ destination: '4secret', total: '12' });
    seed = new Uint8Array(32).fill(1);
    expect(await store.get('order.1')).toBeNull();
    seed = null;
    expect(await store.get('order.1')).toBeNull();
    expect(await store.put('order.2', {})).toBe(false);
    expect(kv.map.size).toBe(1);
  });

  it('the vault: a reload keeps the tab seed, a sealed copy needs its passphrase, and forgetting removes everything', async () => {
    const kv = new MemoryKV();
    const dep = () => ({ programId: 'Prog', contract: '' });
    const v = new Vault(kv, dep);
    await v.init();
    expect(v.getState()).toMatchObject({ unlocked: false, backedUp: false, sealedOnDevice: false });
    v.create();
    const tag = seedTag(v.requireSeed());
    v.confirmSaved(true);
    // Confirming before a download does nothing.
    expect(v.getState().backedUp).toBe(false);
    v.markDownloaded();
    v.confirmSaved(true);
    expect(v.getState()).toMatchObject({ unlocked: true, downloaded: true, backedUp: true, tag });
    v.noteWallet('solana', 'Wallet1');
    expect(JSON.parse(v.fileText())).toMatchObject({ format: 'xmrswap-recovery/1', program_id: 'Prog', wallets: { solana: ['Wallet1'], ethereum: [] } });
    await expect(v.remember('short')).rejects.toThrow(/at least 8/);
    await v.remember('a long passphrase');

    // A reload of the tab: same session storage.
    const reloaded = new Vault(kv, dep);
    await reloaded.init();
    expect(reloaded.getState()).toMatchObject({ unlocked: true, backedUp: true, tag, sealedOnDevice: true });

    // The tab was closed: only the sealed copy is left.
    sessionStorage.clear();
    const reopened = new Vault(kv, dep);
    await reopened.init();
    expect(reopened.getState()).toMatchObject({ unlocked: false, sealedOnDevice: true });
    await expect(reopened.unlock('wrong passphrase')).rejects.toThrow(/wrong/);
    await reopened.unlock('a long passphrase');
    expect(reopened.getState()).toMatchObject({ unlocked: true, backedUp: true, tag });

    await reopened.forget();
    expect(reopened.getState()).toMatchObject({ unlocked: false, sealedOnDevice: false, backedUp: false });
    expect(sessionStorage.getItem('xmrswap.seed')).toBeNull();
    expect(kv.map.size).toBe(0);
  }, 60_000);
});
