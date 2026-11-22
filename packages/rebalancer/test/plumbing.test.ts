import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { HttpError, JsonlCostLog, connectionRpc, formatUnits, lamportDelta, parseUnits, redactUrl, requestJson, tokenDelta, type CostLogEntry } from '../src/index.js';
import { FixtureHttp, SOL_ADDR } from './helpers.js';

describe('amounts', () => {
  it('converts decimal strings exactly and cuts, never rounds up, extra digits', () => {
    expect(parseUnits('4.9612', 12)).toBe(4_961_200_000_000n);
    expect(parseUnits('0.1234567891239', 12)).toBe(123_456_789_123n);
    expect(parseUnits(2000, 6)).toBe(2_000_000_000n);
    expect(parseUnits(1e-7, 12)).toBe(100_000n);
    expect(parseUnits('.5', 6)).toBe(500_000n);
    expect(parseUnits('123456789012345678.123456789012345678', 18)).toBe(123_456_789_012_345_678_123_456_789_012_345_678n);
    expect(formatUnits(4_961_200_000_000n, 12)).toBe('4.9612');
    expect(formatUnits(2_000_000_000n, 6)).toBe('2000');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    for (const bad of ['-1', '1e5', 'abc', '', '1.2.3']) expect(() => parseUnits(bad, 6)).toThrow();
    expect(() => parseUnits(-1, 6)).toThrow();
  });
});

describe('http', () => {
  it('errors carry the path and status but never the query string', async () => {
    const http = new FixtureHttp([{ method: 'GET', path: '/thing', status: 500, body: { message: 'boom' } }]);
    const err = await requestJson(http, { method: 'GET', url: 'https://venue.example/thing?apikey=SECRETVALUE&x=1', headers: { authorization: 'Bearer SECRETVALUE' } }).then(() => new Error('did not throw'), (e: Error) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('GET https://venue.example/thing -> 500: boom');
    expect(String(err.stack)).not.toContain('SECRETVALUE');
    expect(redactUrl('https://a/b?c=d')).toBe('https://a/b');
  });
  it('a 2xx body that is not JSON is an error', async () => {
    const http = new FixtureHttp([{ method: 'GET', path: '/thing', body: '<html>' }]);
    await expect(requestJson(http, { method: 'GET', url: 'https://venue.example/thing' })).rejects.toThrow(/not JSON/);
  });
});

describe('connectionRpc', () => {
  it('maps a web3.js Connection onto the narrow read interface, at finalized commitment', async () => {
    const wallet = new PublicKey(SOL_ADDR);
    const calls: unknown[][] = [];
    const conn = {
      getAccountInfo: async (...a: unknown[]) => { calls.push(['getAccountInfo', ...a]); return { owner: wallet, data: Buffer.from([1, 2, 3]), lamports: 42 }; },
      getMultipleAccountsInfo: async (keys: PublicKey[], c: string) => { calls.push(['getMultipleAccountsInfo', keys.length, c]); return keys.map((_, i) => (i === 1 ? null : { owner: wallet, data: Buffer.from([9]), lamports: 1 })); },
      getSignaturesForAddress: async (_k: PublicKey, o: unknown, c: string) => { calls.push(['getSignaturesForAddress', o, c]); return [{ signature: 'sigA', err: null }, { signature: 'sigB', err: { x: 1 } }]; },
      getTransaction: async (sig: string) => (sig === 'missing' ? null : {
        blockTime: 1_800_000_000,
        transaction: { message: { getAccountKeys: () => ({ get: (i: number) => (i === 0 ? wallet : new PublicKey('11111111111111111111111111111111')) }) } },
        meta: {
          err: null, logMessages: ['Program log: hi'], preBalances: [5_000_000_000, 1], postBalances: [4_999_990_000, 1],
          preTokenBalances: [{ owner: SOL_ADDR, mint: 'MintA', uiTokenAmount: { amount: '100' } }],
          postTokenBalances: [{ owner: SOL_ADDR, mint: 'MintA', uiTokenAmount: { amount: '250' } }, { owner: SOL_ADDR, mint: 'MintB', uiTokenAmount: { amount: '7' } }],
        },
      }),
    };
    const rpc = connectionRpc(conn as never);
    expect(await rpc.getAccount(SOL_ADDR)).toEqual({ owner: SOL_ADDR, data: new Uint8Array([1, 2, 3]), lamports: 42n });
    expect((calls[0] as unknown[])[2]).toBe('finalized');
    expect((await rpc.getAccounts([SOL_ADDR, SOL_ADDR, SOL_ADDR])).map((a) => a?.lamports)).toEqual([1n, undefined, 1n]);
    expect(await rpc.getSignatures(SOL_ADDR, 20)).toEqual([{ signature: 'sigA', err: null }, { signature: 'sigB', err: { x: 1 } }]);
    expect(await rpc.getTransaction('missing')).toBeNull();
    const tx = (await rpc.getTransaction('sigA'))!;
    expect(tx.logs).toEqual(['Program log: hi']);
    expect(tokenDelta(tx, SOL_ADDR, 'MintA')).toBe(150n);
    expect(tokenDelta(tx, SOL_ADDR, 'MintB')).toBe(7n);    // an account created by the transaction
    expect(tokenDelta(tx, 'someone-else', 'MintA')).toBe(0n);
    expect(lamportDelta(tx, SOL_ADDR)).toBe(-10_000n);
  });
});

describe('JSONL cost log', () => {
  it('appends one JSON object per line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp7-costlog-'));
    try {
      const path = join(dir, 'refills.jsonl');
      const log = new JsonlCostLog(path);
      const e: CostLogEntry = { id: 'r1', venue: 'changenow', from: 'usdc_sol', to: 'xmr', amountIn: '1', amountOut: '2', rateType: 'float', rate: 2, referenceUsd: { from: 1, to: 400 }, valueInUsd: 1, quotedCostPct: 0.5, quotedFeesUsd: 0, measuredCostPct: 0.6, measuredFeesUsd: 0, startedAt: 1, finishedAt: 2, outcome: 'done', testTransfer: false, txids: [], detail: null };
      await log.append(e);
      await log.append({ ...e, id: 'r2' });
      expect(readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['r1', 'r2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Jupiter client', () => {
  it('parses a swap/v1 quote (hand-written fixture) and refuses one that answers a different question', async () => {
    const { JupiterClient, USDC_MINT, WXMR_MINT } = await import('../src/index.js');
    const { fixture } = await import('./helpers.js');
    const f = fixture('jupiter.json');
    const http = new FixtureHttp([{ method: 'GET', path: '/quote', body: f.quote_usdc_wxmr }]);
    const jup = new JupiterClient({ http, slippageBps: 30 });
    const q = await jup.quote(USDC_MINT.toBase58(), WXMR_MINT.toBase58(), 400_000_000n);
    expect(q).toMatchObject({ inAmount: 400_000_000n, outAmount: 996_000_000_000n, minOutAmount: 991_020_000_000n });
    expect(q.priceImpactPct).toBeCloseTo(0.31, 9); // the API reports a fraction; the client works in percent
    expect(q.raw).toEqual(f.quote_usdc_wxmr);
    expect(new URL(http.requests[0]!.url).searchParams.get('slippageBps')).toBe('30');
    await expect(jup.quote(USDC_MINT.toBase58(), WXMR_MINT.toBase58(), 500_000_000n)).rejects.toThrow(/different swap/);
    http.routes = [{ method: 'POST', path: '/swap', body: { swapTransaction: 'not-a-transaction' } }];
    await expect(jup.swapTransaction(q, SOL_ADDR)).rejects.toThrow(/does not parse/);
  });
});
