// Constants, messages, the recovery file and the daemon API.
import { describe, expect, it } from 'vitest';
import * as p from '../src/index.js';
import * as api from '../src/daemon-api.js';
import { frozenIdl } from './helpers.js';

describe('constants', () => {
  it('counter ids of SPEC 3.7', () => {
    expect(p.COUNTER_NAMES.length).toBe(33);
    expect(p.COUNTER.locks).toBe(0);
    expect(p.COUNTER.completed).toBe(8);
    expect(p.COUNTER.missed_notices).toBe(11);
    expect(p.COUNTER.missed_claims).toBe(12);
    expect(p.COUNTER.missed_funds).toBe(13);
    expect(p.COUNTER.taker_claims_without_ready).toBe(19);
    expect(p.COUNTER.expired_refunds).toBe(27);
    expect(p.COUNTER.splits).toBe(31);
    expect(p.COUNTER.rejections_no_fault).toBe(32);
    expect(p.FAULT_COUNTERS.map((n) => p.COUNTER[n])).toEqual([11, 12, 13]);
    // The on-chain array has 40 slots.
    const counters = frozenIdl().types.find((t: any) => t.name === 'Maker').type.fields.find((f: any) => f.name === 'counters');
    expect(counters.type).toEqual({ array: ['u32', p.COUNTER_SLOTS] });
  });

  it('states, flags and the per-chain table of SPEC 3.1', () => {
    expect(p.SWAP_STATE_NAMES.map((n) => p.SWAP_STATE[n])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p.SWAP_FLAG).toEqual({ NOTICE: 1, EVIDENCE: 2, REVEALED: 4, REVEALER_LOCKER: 8, LATE_NOTICE: 16 });
    expect(p.DEPOSIT_STATE).toEqual({ NONE: 0, HELD: 1, WITHHELD: 2, RETURNED: 3, RELEASED: 4, SPLIT: 5 });
    const s = p.SOLANA_CONSTS;
    const e = p.ETHEREUM_CONSTS;
    expect([s.feeBps, s.maxDepositBps, s.holdSecs, s.splitSecs, s.expirySecs, s.blockAllowanceSecs, s.cutMarginSecs]).toEqual([5, 500, 1800, 5184000, 2592000, 180, 900]);
    expect([e.feeBps, e.maxDepositBps, e.holdSecs, e.splitSecs, e.expirySecs, e.blockAllowanceSecs, e.cutMarginSecs]).toEqual([5, 500, 1800, 5184000, 2592000, 180, 900]);
    expect([s.marginSecs, s.finalitySecs, s.minNoticeSecs, s.maxNoticeSecs, s.minClaimDelaySecs]).toEqual([300, 15, 300, 3600, 3600]);
    expect([e.marginSecs, e.finalitySecs, e.minNoticeSecs, e.maxNoticeSecs, e.minClaimDelaySecs]).toEqual([1800, 1200, 1500, 3600, 7200]);
    expect([s.maxApprovalSecs, s.maxFinalSecs, s.readyMinSecsPerConf, s.closeGraceSecs, s.linkDelaySecs, s.maxOpenPending]).toEqual([3600, 2592000, 60, 2592000, 604800, 64]);
    expect([e.maxApprovalSecs, e.maxFinalSecs, e.readyMinSecsPerConf, e.linkDelaySecs, e.maxOpenPending]).toEqual([3600, 2592000, 60, 604800, 64]);
    expect([s.explicitApprove, s.openSecretCalls, s.lapseIsFault]).toEqual([false, false, true]);
    expect([e.explicitApprove, e.openSecretCalls, e.lapseIsFault]).toEqual([true, true, false]);
    expect(p.MARKETS.map((m) => p.MARKET_CHAIN[m])).toEqual(['solana', 'solana', 'ethereum', 'ethereum']);
  });

  it('sweep fee cap and the taker depth table', () => {
    expect(p.sweepMaxFee(0n)).toBe(2_000_000_000n);
    expect(p.sweepMaxFee(400n * 10n ** 9n)).toBe(2_000_000_000n);
    expect(p.sweepMaxFee(10n ** 12n)).toBe(5_000_000_000n);
    expect(p.takerDepthFor(0n)).toBe(2);
    expect(p.takerDepthFor(10n ** 12n - 1n)).toBe(2);
    expect(p.takerDepthFor(10n ** 12n)).toBe(10);
    expect(p.takerDepthFor(50n * 10n ** 12n - 1n)).toBe(10);
    expect(p.takerDepthFor(50n * 10n ** 12n)).toBe(25);
  });
});

describe('messages (SPEC 6.1)', () => {
  const roundTrip = (m: p.Message) => p.parseMessage(p.encodeMessage(m));

  it('every type round-trips', () => {
    const samples: p.Message[] = [
      { t: 'quote_request', chain: 'solana', market: 'usdc_sol', direction: 'A', xmr: '2500000000000', taker: 'Taker1111', note: 'hi' },
      { t: 'quote_response', ok: true, chain: 'solana', quote_id: '77', expires_at: '1800000120' },
      { t: 'quote_response', ok: true, chain: 'ethereum', quote: 'AAAA' },
      { t: 'quote_response', ok: false, detail: 'too large' },
      { t: 'approval_request', chain: 'ethereum', taker: '0x2222222222222222222222222222222222222222', max_xmr: '5000000000000' },
      { t: 'approval_response', ok: true, chain: 'solana', asset: 255, direction: 0, max_xmr: '5', not_before: '1', expires_at: '2', epoch: 3, approval_id: '4', sig: 'c2ln' },
      { t: 'approval_response', ok: true, chain: 'ethereum', maker: '0x11', taker: '0x22', token: '0x33', direction: 255, max_xmr: '5', not_before: '1', valid_until: '2', epoch: 3, approval_id: '0x44', sig: 'c2ln' },
      { t: 'approval_response', ok: false },
      { t: 'inbox', text: 'please release my deposit', action: 'release_deposit', reply_to: 'Taker1111' },
      { t: 'inbox_reply', text: 'done', in_reply_to: 'ab'.repeat(32) },
      { t: 'notice_copy', commitment: '01'.repeat(32), ciphertext: '02'.repeat(104) },
      { t: 'ack', in_reply_to: 'cd'.repeat(32) },
      { t: 'error', code: 'stale_key' },
    ];
    for (const m of samples) expect(roundTrip(m)).toEqual(m);
    expect(new Set(samples.map((m) => m.t))).toEqual(new Set(p.MESSAGE_TYPES));
  });

  it('malformed messages are refused', () => {
    const bad: [unknown, RegExp][] = [
      ['not json', /not UTF-8 JSON/],
      [[1, 2], /not a JSON object/],
      [{ t: 'nope' }, /unknown message type/],
      [{ t: 'quote_request', chain: 'bitcoin', market: 'sol', direction: 'A', xmr: '1', taker: 'x' }, /chain/],
      [{ t: 'quote_request', chain: 'solana', market: 'sol', direction: 'A', xmr: 1, taker: 'x' }, /xmr must be a string/],
      [{ t: 'quote_request', chain: 'solana', market: 'sol', direction: 'A', xmr: '1.5', taker: 'x' }, /decimal/],
      [{ t: 'quote_request', chain: 'solana', market: 'sol', direction: 'A', xmr: '01', taker: 'x' }, /decimal/],
      [{ t: 'quote_response', ok: 'yes' }, /ok must be a boolean/],
      [{ t: 'quote_response', ok: true, chain: 'solana', quote_id: '1' }, /expires_at/],
      [{ t: 'inbox', text: 'x'.repeat(2001) }, /longer than 2000/],
      [{ t: 'inbox', text: 'x', action: 'send_money' }, /action/],
      [{ t: 'notice_copy', commitment: '01'.repeat(32), ciphertext: '02'.repeat(103) }, /104 bytes/],
      [{ t: 'ack', in_reply_to: 'AB'.repeat(32) }, /lowercase hex/],
      [{ t: 'error', code: 'oops' }, /code/],
    ];
    for (const [value, expected] of bad) {
      expect(() => p.parseMessage(typeof value === 'string' ? value : JSON.stringify(value)), JSON.stringify(value)).toThrow(expected);
    }
    expect(() => p.parseMessage(Uint8Array.of(0xff, 0xfe))).toThrow(p.MessageError);
  });

  it('maker routes and the relay path rule agree', () => {
    const h = 'ab'.repeat(32);
    for (const path of [p.MAKER_ROUTES.info, p.MAKER_ROUTES.msg, p.MAKER_ROUTES.dleq(h), p.MAKER_ROUTES.pool(h), p.MAKER_ROUTES.replies(h)]) {
      expect(path, path).toMatch(p.MAKER_PATH_PATTERN);
    }
    for (const path of ['/xs/v1/dleq/' + 'AB'.repeat(32), '/xs/v1/dleq/abcd', '/xs/v1/msg/../info', '/xs/v2/info', '/xs/v1/info?x=1', '/admin', 'http://evil/xs/v1/info']) {
      expect(path, path).not.toMatch(p.MAKER_PATH_PATTERN);
    }
    expect(p.RELAY_ROUTES.monero(1, '/get_height')).toBe('/monero/1/get_height');
    expect(p.RELAY_LIMITS.requestBody).toBe(98_304);
    expect(p.MONERO_PROXY_PATHS).toContain('/send_raw_transaction');
    // A full-size proof fits the relay's body limit as base64 inside JSON.
    expect(Math.ceil(p.DLEQ_BLOB_LEN / 3) * 4).toBeLessThan(p.RELAY_LIMITS.requestBody);
  });
});

describe('recovery file (SPEC 8.4)', () => {
  const base = { format: 'xmrswap-recovery/1', created_at: '2026-11-21T12:00:00Z', wallets: { solana: ['A'], ethereum: ['0xB'] }, program_id: 'P', contract: '0xC' };

  it('accepts a plain and an encrypted file', () => {
    expect(p.parseRecoveryFile(JSON.stringify({ ...base, seed: 'ab'.repeat(32) }))).toMatchObject({ seed: 'ab'.repeat(32) });
    expect(p.parseRecoveryFile(JSON.stringify({ ...base, seed_enc: 'AAAA' }))).toMatchObject({ seed_enc: 'AAAA' });
  });

  it('refuses everything else', () => {
    const bad: [unknown, RegExp][] = [
      [{ ...base, format: 'xmrswap-recovery/2', seed: 'ab'.repeat(32) }, /unsupported format/],
      [{ ...base }, /exactly one of seed and seed_enc/],
      [{ ...base, seed: 'ab'.repeat(32), seed_enc: 'AAAA' }, /exactly one/],
      [{ ...base, seed: 'AB'.repeat(32) }, /lowercase hex/],
      [{ ...base, seed: 'ab'.repeat(31) }, /32 bytes/],
      [{ ...base, seed: 'ab'.repeat(32), created_at: 'yesterday' }, /ISO date/],
      [{ ...base, seed: 'ab'.repeat(32), wallets: { solana: ['A'] } }, /wallets/],
      [{ ...base, seed: 'ab'.repeat(32), program_id: 5 }, /program_id/],
    ];
    for (const [value, expected] of bad) expect(() => p.parseRecoveryFile(JSON.stringify(value))).toThrow(expected);
    expect(() => p.parseRecoveryFile('{')).toThrow(/not JSON/);
  });
});

describe('daemon API (SPEC 7.8)', () => {
  it('lists every route of the specification, each once', () => {
    const got = Object.values(api.ROUTES).map((r) => `${r.method} ${r.path}`);
    expect(new Set(got).size).toBe(got.length);
    const spec = [
      'GET /api/status',
      'GET /api/config', 'PUT /api/config', 'POST /api/config/validate', 'GET /api/config/log', 'GET /api/config/export', 'POST /api/config/import',
      'GET /api/registration', 'POST /api/registration/tx', 'POST /api/registration/submit',
      'GET /api/offers', 'POST /api/offers/preview',
      'GET /api/swaps', 'GET /api/swaps/:ref',
      'POST /api/swaps/:ref/approve', 'POST /api/swaps/:ref/reject', 'POST /api/swaps/:ref/abort', 'POST /api/swaps/:ref/withhold', 'POST /api/swaps/:ref/release', 'POST /api/swaps/:ref/publish-evidence',
      'GET /api/inventory', 'POST /api/inventory/split',
      'GET /api/approvals', 'POST /api/approvals/advance', 'POST /api/approvals/revoke',
      'GET /api/deposits',
      'GET /api/inbox', 'POST /api/inbox/:id/reply', 'POST /api/inbox/:id/read',
      'GET /api/rebalance', 'POST /api/rebalance/run', 'POST /api/rebalance/approve/:id', 'POST /api/rebalance/cancel/:id', 'POST /api/rebalance/manual',
      'GET /api/keys', 'POST /api/keys/rotate',
      'GET /api/stats', 'GET /api/fees',
      'POST /api/pause', 'POST /api/resume',
      'WS /api/ws',
    ];
    expect([...got].sort()).toEqual([...spec].sort());
    expect(api.WS_CHANNELS).toEqual(['status', 'swaps', 'offers', 'inbox', 'rebalance', 'alerts']);
    expect(api.WS_PING_SECS).toBe(30);
  });

  it('routePath fills and escapes parameters', () => {
    expect(api.routePath('status')).toBe('/api/status');
    expect(api.routePath('swapPublishEvidence', { ref: '0xabc' })).toBe('/api/swaps/0xabc/publish-evidence');
    expect(api.routePath('inboxReply', { id: 'a/b' })).toBe('/api/inbox/a%2Fb/reply');
    expect(() => api.routePath('swap')).toThrow(/needs :ref/);
  });

  it('is also exported as a namespace from the package root', () => {
    expect(p.daemonApi.ROUTES).toBe(api.ROUTES);
  });
});
