/**
 * The local API for the console (SPEC 7.8): express on `api_bind` (loopback), bearer token from
 * the keystore directory, JSON, amounts as decimal strings. Shapes are `@xmrswap/protocol`'s
 * `daemon-api.ts`. `WS /api/ws` pushes the six channels: a snapshot on subscribe, then updates,
 * with a ping every 30 s.
 *
 * Beyond the frozen routes (all listed in DEVIATIONS.md under "Console contract"): the socket
 * accepts the token as `?token=` (a browser cannot set a header on a WebSocket); the built
 * console is served from this same origin when `[daemon].console_dir` names it; other origins
 * are refused unless listed in `[daemon].cors_origins`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { COUNTER_NAMES, base58Encode, type ChainName, type Contact, MAX_CONTACTS, MAX_CONTACT_LEN, MAX_ONION_LEN, type Market, SWAP_STATE, SWAP_STATE_NAMES } from '@xmrswap/protocol';
import { type AdvanceApprovalRequest, type ApiError, type ApprovalRevokeRequest, type ApprovalsResponse, type AssetId, type ConfigResponse, type FeesResponse, type InventoryResponse, type OffersResponse, type PauseResponse, type RebalanceManualRequest, type RebalanceRunRequest, type RegistrationAction, type SwapAction, type SwapActionResponse, type TxResult, WS_CHANNELS, WS_PING_SECS, type WsChannel, type WsClientMessage, type WsServerMessage } from '@xmrswap/protocol/daemon-api';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { REFRESH_CU, loadConfig, updateCost } from '../config/load.js';
import { ConfigRejected, type Daemon } from '../daemon.js';
import { depositViews } from '../deposits/index.js';
import { swapCosts } from '../stats/costs.js';
import { type ChainCounters, feesView, statsView } from '../stats/index.js';
import { pendingApproval, snapshotOf, swapDetail, swapSummary } from '../swaps/views.js';
import { splitBind } from '../tor/index.js';
import { errMsg } from '../util.js';

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? code);
    this.name = 'ApiHttpError';
  }
}
const fail = (status: number, code: string, detail?: string, extra?: Record<string, unknown>): never => {
  throw new ApiHttpError(status, code, detail, extra);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const amountOk = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const ASSETS: AssetId[] = ['xmr', 'sol', 'eth', 'usdc_sol', 'usdc_eth'];

/** Plain words for each reason an operator instruction can be refused with. */
export const REFUSALS: Record<string, string> = {
  'ready-already-set': 'ready is set; the swap can no longer be backed out of until the claim window closes',
  'refund-window-closed': 'the refund window is over; a refund sent now could land in the taker\'s claim window and leak the key share',
  'abort-window-closed': 'an abort is no longer accepted in this state',
  'already-settled': 'the swap is already settled',
  'reject-not-available': 'a pending take cannot be rejected on Solana outside window mode; it can only be left to lapse',
  'hold-ended': 'the 30-minute hold has ended; a deposit can no longer be withheld',
  'no-deposit-held': 'no deposit is held or withheld on this swap',
  'cannot-exit-after-funding': 'after funding, the taker has no call that ends the swap',
  'not-available-in-state': 'the swap is not in a state that accepts it',
  'dry-run': 'the daemon is in dry run and sends no transaction',
  'freeze-not-available': 'this swap names no watcher (or its offer has no freeze window): only such a swap can be paused',
  'freeze-window-closed': 'a pause is accepted only after the notice and before the claim opens',
  'already-frozen': 'the swap is, or was, paused: a swap can be paused once',
};
/** The chain's two cap refusals (SPEC 11.1): expected outcomes with their own code, never the maker's limit and never an internal error. */
export const CAP_CODES = ['SwapCapExceeded', 'OpenCapExceeded'] as const;

export interface ApiServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startApi(d: Daemon, opts: { bind?: string } = {}): Promise<ApiServer> {
  const app = express();
  app.disable('x-powered-by');
  const [host, port] = splitBind(opts.bind ?? d.config.raw.daemon.api_bind);
  const tokenBytes = Buffer.from(d.token);
  const tokenOk = (given: string | null | undefined): boolean => {
    if (!given) return false;
    const g = Buffer.from(given);
    return g.length === tokenBytes.length && timingSafeEqual(g, tokenBytes);
  };

  // ---- CORS: same-origin by default; other origins only when the maker lists them.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && d.config.raw.daemon.cors_origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
      if (req.method === 'OPTIONS') return void res.status(204).end();
    }
    next();
  });
  app.use('/api', express.json({ limit: '2mb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ') || !tokenOk(h.slice(7))) return void res.status(401).json({ error: 'unauthorized', detail: 'Missing or wrong bearer token.' } satisfies ApiError);
    next();
  });

  type Handler = (req: Request) => unknown | Promise<unknown>;
  const route = (method: 'get' | 'put' | 'post', path: string, h: Handler): void => {
    app[method](path, (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => h(req))
        .then((out) => res.json(out))
        .catch(next);
    });
  };
  /** Chain-sending actions are refused in dry run: nothing is sent, and the console says so. */
  const needLive = (what: string): void => {
    if (!d.live) fail(409, 'dry_run', `Dry run: ${what} was not sent. Switch the daemon to live mode to send transactions.`);
  };
  const body = (req: Request): Record<string, unknown> => (isObj(req.body) ? req.body : {});

  // ---------------------------------------------------------------- status
  route('get', '/api/status', () => d.status());

  // ---------------------------------------------------------------- configuration
  const solUsd = (): number | null => d.prices.usd('sol');
  const withCost = <T extends { update_cost: unknown; effective: unknown[] }>(validation: T, cfg = d.config): T => ({ ...validation, update_cost: validation.update_cost ? updateCost(cfg.raw, cfg.offers, solUsd()) : null });
  const configResponse = (): ConfigResponse => ({ toml: d.load.toml, parsed: d.load.parsed, validation: withCost(d.load.validation), revision: d.load.revision });
  const apply = (toml: unknown, source: 'api' | 'import', base?: unknown): ConfigResponse => {
    if (typeof toml !== 'string') return fail(400, 'bad_request', 'The body needs a "toml" string.');
    try {
      d.applyConfig(toml, source, typeof base === 'string' ? base : undefined);
    } catch (e) {
      if (!(e instanceof ConfigRejected)) throw e;
      if (e.code === 'revision_conflict') fail(409, 'revision_conflict', 'The configuration changed since you loaded it. Reload, then apply your edit again.');
      // Every daemon-side error on its key, so the console can place each one on its field.
      fail(e.code === 'invalid_toml' ? 400 : 422, e.code, e.message, { issues: e.result?.validation.errors ?? [], warnings: e.result?.validation.warnings ?? [] });
    }
    return configResponse();
  };
  route('get', '/api/config', () => configResponse());
  route('put', '/api/config', (req) => {
    if (typeof body(req)['base_revision'] !== 'string') fail(400, 'bad_request', 'toml and base_revision are required.');
    return apply(body(req)['toml'], 'api', body(req)['base_revision']);
  });
  route('post', '/api/config/validate', (req) => {
    const toml = body(req)['toml'];
    if (typeof toml !== 'string') return fail(400, 'bad_request', 'toml is required.');
    const r = loadConfig(toml);
    return { ...(r.config ? withCost(r.validation, r.config) : r.validation), ...({ sol_usd: solUsd(), compute_units_per_update: REFRESH_CU, ...(r.config ? { swap_cost: swapCosts(r.config.raw) } : {}) } as object) };
  });
  route('get', '/api/config/log', () => ({ entries: d.store.configLog().map((e) => ({ at: e.at, revision: e.revision, changes: e.changes, source: e.source })) }));
  route('get', '/api/config/export', () => ({ toml: d.load.toml, exported_at: d.store.now() }));
  route('post', '/api/config/import', (req) => apply(body(req)['toml'], 'import'));

  // ---------------------------------------------------------------- registration
  route('get', '/api/registration', () => d.registration.status());
  route('post', '/api/registration/tx', async (req) => {
    const a = body(req) as unknown as RegistrationAction;
    if ((a.chain !== 'solana' && a.chain !== 'ethereum') || typeof a.action !== 'string') fail(400, 'bad_request', 'chain and action are required.');
    const reg = await d.registration.status();
    const side = a.chain === 'solana' ? reg.solana : reg.ethereum;
    if (a.action === 'register_maker') {
      if (a.chain === 'ethereum' && !reg.solana.registered) fail(409, 'solana_first', 'Register on Solana first: every maker registers there, including Ethereum-only makers.');
      if (side.registered) fail(409, 'already_registered', `Already registered on ${a.chain}.`);
    } else if (!side.registered) fail(409, 'not_registered', `Not registered on ${a.chain} yet.`);
    try {
      return await d.registration.buildTx(a);
    } catch (e) {
      return fail(400, 'bad_request', errMsg(e));
    }
  });
  route('post', '/api/registration/submit', async (req) => {
    const b = body(req);
    if (typeof b['request_id'] !== 'string' || typeof b['signed'] !== 'string') return fail(400, 'bad_request', 'request_id and signed are required.');
    try {
      return await d.registration.submit(b['request_id'], b['signed']);
    } catch (e) {
      const m = errMsg(e);
      return fail(m.includes('request_id') ? 404 : 400, m.includes('request_id') ? 'unknown_request' : 'bad_signature', m);
    }
  });
  /** Edit what the operator key publishes: contact channels and the onion address (not in the frozen API). */
  route('put', '/api/registration/published', async (req) => {
    const b = body(req);
    // Refused BEFORE anything is stored: an edit made in dry run must not go out later by surprise when the daemon turns live.
    needLive('the registry update');
    if (b['contacts'] !== undefined) {
      const c = b['contacts'];
      if (!Array.isArray(c) || c.length > MAX_CONTACTS || !c.every((x) => isObj(x) && Number.isInteger(x['kind']) && (x['kind'] as number) >= 0 && (x['kind'] as number) <= 255 && typeof x['value'] === 'string' && Buffer.byteLength(x['value']) <= MAX_CONTACT_LEN)) return fail(400, 'bad_request', `contacts: at most ${MAX_CONTACTS} entries of { kind, value }, each value at most ${MAX_CONTACT_LEN} bytes.`);
      d.store.setKv('published:contacts', JSON.stringify((c as Contact[]).map((x) => ({ kind: x.kind, value: x.value }))));
    }
    if (b['onion'] !== undefined) {
      const o = b['onion'];
      if (o !== null && (typeof o !== 'string' || o.length > MAX_ONION_LEN || !/^[a-z2-7]{56}\.onion$/.test(o))) return fail(400, 'bad_request', 'onion: a v3 onion host (56 base32 characters + .onion), or null to follow the Tor hostname file.');
      if (o === null) d.store.db.prepare("DELETE FROM kv WHERE key = 'published:onion'").run();
      else d.store.setKv('published:onion', JSON.stringify(o));
    }
    const tx = await d.registration.syncPublished();
    return { tx: tx ? ({ chain: 'solana', id: tx, status: 'sent' } satisfies TxResult) : null, registration: await d.registration.status() };
  });
  /** The identity link's trace: every recorded `LinkChanged`, newest first (not in the frozen API). */
  route('get', '/api/registration/links', async () => {
    // `old` / `new` are what each chain's record points at: an Ethereum address (0x) in the Solana record, a Solana
    // owner key (base58) in the Ethereum record; the raw bytes stay beside them. `superseded`: replaced by a later
    // change before it took effect (the next event's `old` is not this entry's `new`).
    type Entry = { chain: ChainName; old: string; new: string; old_hex: string; new_hex: string; effective_at: number; superseded: boolean };
    const entries: Entry[] = [];
    const hexOf = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
    const shown = (b: Uint8Array): string => (b.every((x) => x === 0) ? '' : b.length === 32 ? base58Encode(b) : hexOf(b));
    const add = (chain: ChainName, list: { old: Uint8Array; next: Uint8Array; effectiveAt: bigint }[]) =>
      list.forEach((c, i) => entries.push({ chain, old: shown(c.old), new: shown(c.next), old_hex: hexOf(c.old), new_hex: hexOf(c.next), effective_at: Number(c.effectiveAt), superseded: i + 1 < list.length && hexOf(list[i + 1]!.old) !== hexOf(c.next) }));
    if (d.sol) add('solana', await d.sol.client.linkChanges(d.sol.makerPda).catch(() => []));
    if (d.eth) add('ethereum', await d.eth.client.linkChanges(d.eth.makerAddress, { fromBlock: BigInt(d.config.raw.ethereum.from_block), toBlock: d.eth.tag }).catch(() => []));
    entries.sort((x, y) => y.effective_at - x.effective_at);
    return { entries };
  });

  // ---------------------------------------------------------------- offers
  const offersResponse = (views: OffersResponse['offers'], cfg = d.config, validation = d.load.validation): OffersResponse => {
    const fees = d.store.feesSince(d.store.now() - 86_400);
    const sum = (kinds: string[], asset: string) => fees.filter((f) => kinds.includes(f.kind) && f.asset === asset).reduce((a, f) => a + BigInt(f.amount), 0n);
    const count = (kinds: string[]) => fees.filter((f) => kinds.includes(f.kind)).length;
    const est = validation.update_cost ? updateCost(cfg.raw, cfg.offers, solUsd()) : null;
    const balance = lastSolBalance;
    const daily = [est ? BigInt(est.daily_lamports) : 0n, sum(['refresh_offers'], 'sol')].reduce((a, b) => (a > b ? a : b)) + d.dailySwapLamports();
    return {
      offers: views, update_cost: est, spent_24h_lamports: sum(['refresh_offers'], 'sol').toString(), runway_days: balance !== null && daily > 0n ? Number(balance) / Number(daily) : null,
      occasional: [
        { kind: 'key_refill', count_24h: count(['refill_keys']), cost: sum(['refill_keys'], 'sol').toString(), asset: 'sol' },
        { kind: 'key_rotation', count_24h: count(['rotate_enc_key']), cost: sum(['rotate_enc_key'], 'sol').toString(), asset: 'sol' },
        { kind: 'quote_on_request', count_24h: count(['post_quote', 'set_eth_quote', 'set_offer']), cost: sum(['post_quote', 'set_eth_quote', 'set_offer'], 'sol').toString(), asset: 'sol' },
        { kind: 'eth_registry', count_24h: count(['eth_registry']), cost: sum(['eth_registry'], 'eth').toString(), asset: 'eth' },
      ],
      // Additions to the frozen shape, for the console's instant estimate.
      ...({ sol_usd: solUsd(), compute_units_per_update: REFRESH_CU, swap_cost: swapCosts(cfg.raw), caps: d.caps.view() } as object),
    };
  };
  let lastSolBalance: bigint | null = null;
  const refreshBalance = async (): Promise<void> => {
    if (d.sol) lastSolBalance = (await d.sol.client.transport.getAccount(d.sol.operator).catch(() => null))?.lamports ?? lastSolBalance;
  };
  route('get', '/api/offers', async () => {
    await refreshBalance();
    const computed = d.offers.latest().length ? d.offers.latest() : await d.offers.compute();
    return offersResponse(d.offers.views(computed));
  });
  route('post', '/api/offers/preview', async (req) => {
    const toml = body(req)['toml'];
    if (typeof toml !== 'string') return fail(400, 'bad_request', 'toml is required.');
    const r = loadConfig(toml);
    if (!r.config) return fail(422, 'invalid_config', r.validation.errors[0] ? `${r.validation.errors[0].path}: ${r.validation.errors[0].message}` : 'The configuration has errors.', { issues: r.validation.errors, warnings: r.validation.warnings });
    // What the engine would post with this configuration: computed, never sent.
    return offersResponse(d.offers.views(await d.offers.compute(r.config), false), r.config, r.validation);
  });

  // ---------------------------------------------------------------- swaps
  const swapRow = (ref: string) => d.store.swap(ref) ?? fail(404, 'unknown_swap', `No swap ${ref}.`);
  route('get', '/api/swaps', (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(500, Math.max(1, Number(q['limit'] ?? 100) || 100));
    const before = q['before'] !== undefined ? Number(q['before']) : null;
    const rows = d.store
      .swaps({ ...(q['open'] !== undefined ? { open: q['open'] === 'true' } : {}), ...(q['chain'] ? { chain: q['chain'] } : {}) })
      .filter((r) => (!q['state'] || SWAP_STATE_NAMES[r.state] === q['state']) && (before === null || r.opened_at < before));
    const page = rows.slice(0, limit);
    return { swaps: page.map((r) => swapSummary(r, d.store.now(), d.store)), next_before: rows.length > limit ? page[page.length - 1]!.opened_at : null };
  });
  route('get', '/api/swaps/:ref', (req) => swapDetail(d.store, swapRow(req.params['ref']!), d.store.now(), d.executor.lockReports.get(req.params['ref']!)));
  const swapAction = (action: SwapAction, patch: (req: Request) => Parameters<Daemon['executor']['manual']>[1]): void => {
    route('post', `/api/swaps/:ref/${action}`, async (req): Promise<SwapActionResponse> => {
      const ref = req.params['ref']!;
      const row = swapRow(ref);
      const summary = swapSummary(row, d.store.now(), d.store);
      if (!summary.actions.includes(action)) fail(409, 'action_unavailable', `"${action}" is not available for this swap in state ${summary.state}.`);
      needLive(`the ${action} transaction`);
      const out = await d.executor.manual(ref, patch(req));
      const ins = out.instruction;
      const tx: TxResult | null = ins?.tx ? { chain: row.chain, id: ins.tx, status: 'confirmed' } : null;
      // Never a silent no-op: carried out (with the transaction), refused (with the reason), or pending behind a transaction in flight.
      const outcome = ins?.status ?? 'pending';
      const waiting = out.kind === 'waiting' ? `waiting on ${out.on}` : out.kind === 'error' ? out.error : out.kind === 'parked' ? out.why : 'in progress';
      return {
        ok: outcome !== 'refused', tx,
        detail: outcome === 'carried_out' ? `${action}: carried out` : outcome === 'refused' ? `${action} was not carried out: ${REFUSALS[ins!.reason ?? ''] ?? ins!.reason}` : `${action} is recorded and will be carried out as soon as it can be (${waiting}); it survives a restart`,
        ...({ outcome, ...(outcome === 'refused' ? { refused: ins!.reason } : {}) } as object),
      };
    });
  };
  swapAction('approve', () => ({ approve: true }));
  swapAction('reject', (req) => {
    const reason = body(req)['reason'] ?? 0;
    if (reason !== 0 && reason !== 1 && reason !== 2) fail(400, 'bad_request', 'reason must be 0, 1 or 2.');
    return { approve: false, rejectReason: reason as 0 | 1 | 2 };
  });
  swapAction('abort', () => ({ abort: true }));
  swapAction('withhold', () => ({ withhold: true }));
  swapAction('release', () => ({ release: true, withhold: false }));
  swapAction('publish-evidence', () => ({ publishEvidence: true }));

  /** The unsigned transaction that pulls a payout parked for the maker (not in the frozen API); submit it through `POST /api/registration/submit`. */
  route('post', '/api/swaps/:ref/withdraw-owed-tx', async (req) => {
    const row = swapRow(req.params['ref']!);
    const chain = row.chain === 'solana' ? d.sol : d.eth;
    const view = chain ? await chain.getSwap(row.ref) : null;
    if (!view) return fail(409, 'action_unavailable', 'The swap cannot be read on its chain right now.');
    try {
      return await d.registration.buildWithdrawOwed(view);
    } catch (e) {
      return fail(409, 'nothing_owed', errMsg(e));
    }
  });

  /**
   * Deliver a parked payout without the key it is owed to (SPEC 11.2; not in the frozen API). Ethereum: the permissionless
   * `pushOwed(token, account)` retries the push to the account itself, for each account of this swap's parties that has a
   * parked balance. Solana: claim proceeds parked for a payout address are paid to that address and no other
   * (`withdraw_owed(0)`, destination pinned by the program). The operator pays the fee; nothing can be redirected.
   */
  route('post', '/api/swaps/:ref/deliver-owed', async (req) => {
    const row = swapRow(req.params['ref']!);
    const chain = row.chain === 'solana' ? d.sol : d.eth;
    const view = chain ? await chain.getSwap(row.ref) : null;
    if (!view) return fail(409, 'action_unavailable', 'The swap cannot be read on its chain right now.');
    needLive('the delivery');
    try {
      const txs = await d.deliverOwed(view, row.ref);
      if (txs.length === 0) return fail(409, 'nothing_owed', 'Nothing is parked that this daemon can deliver for this swap.');
      return { txs };
    } catch (e) {
      if (e instanceof ApiHttpError) throw e;
      return fail(409, 'delivery_refused', errMsg(e));
    }
  });

  // ---------------------------------------------------------------- Amendment 1: caps, freezes, the maker's watcher (not in the frozen API)
  route('get', '/api/caps', async () => {
    await d.caps.refresh(true).catch(() => undefined);
    const computed = d.offers.latest().length ? d.offers.latest() : await d.offers.compute();
    return {
      caps: d.caps.view(),
      offers: computed.filter((c) => c.offer.configured).map((c) => ({ market: c.offer.market, direction: c.offer.direction, enabled: c.enabled, capacity_xmr: c.capacityXmr.toString(), capacity_limit: c.limit, cap_reached: c.capReached, reason: c.reason })),
      refused_quotes: d.caps.refusedQuotes,
    };
  });
  route('get', '/api/freezes', async () => {
    const freezes = d.store.freezes();
    const byTaker = new Map<string, number>();
    for (const f of freezes) if (f.direction === 0) byTaker.set(f.taker, (byTaker.get(f.taker) ?? 0) + 1);
    const a = d.config.raw.approvals;
    const names = ['freezes', 'refunds_after_freeze', 'backouts_after_freeze', 'claims_after_freeze'] as const;
    return {
      freezes: freezes.map((f) => ({ ref: f.swap_ref, chain: f.chain, direction: f.direction === 0 ? 'A' : 'B', taker: f.taker, watcher: f.watcher, frozen_by: f.frozen_by, t_freeze: f.t_freeze, t_ff: f.t_ff, state: SWAP_STATE_NAMES[d.store.swap(f.swap_ref)?.state ?? 0] ?? 'NONE' })),
      by_taker: [...byTaker].map(([taker, count]) => ({ taker, count })).sort((x, y) => y.count - x.count),
      counters: (await chainCounters()).map((c) => ({ chain: c.chain, ...Object.fromEntries(names.map((n) => [n, c.counters[COUNTER_NAMES.indexOf(n)] ?? 0])) })),
      settings: { refuse_watchers: a.refuse_watchers, deny_watchers: a.deny_watchers, max_taker_freezes: a.max_taker_freezes ?? null },
    };
  });
  route('get', '/api/watcher', async () => {
    await d.watcher.probe().catch(() => undefined);
    return { status: d.watcher.status(d.store.now()), acks: d.store.watchAcks().map((a) => ({ ref: a.swap_ref, chain: a.chain, watcher: a.watcher, watching_until: a.watching_until, sig: a.sig, at: a.at, open: d.store.swap(a.swap_ref)?.terminal === 0 })) };
  });

  // ---------------------------------------------------------------- inventory
  route('get', '/api/inventory', async (): Promise<InventoryResponse> => {
    const paying: InventoryResponse['paying'] = [];
    for (const market of ['sol', 'eth', 'usdc_sol', 'usdc_eth'] as Market[]) {
      const balance = await d.payingBalance(market).catch(() => null);
      if (balance === null) continue;
      paying.push({ asset: market, balance: balance.toString(), cap: d.payingCap(market)?.toString() ?? null, escrowed: d.escrowed(market).toString() });
    }
    return { ...d.inventory.view(d.risk.inFlightXmr()), paying };
  });
  route('post', '/api/inventory/split', async (req) => {
    const ladder = body(req)['ladder'];
    let rungs: { sizeXmr: bigint; count: number }[] | undefined;
    if (ladder !== undefined) {
      if (!Array.isArray(ladder) || !ladder.every((r) => isObj(r) && amountOk(r['size_xmr']) && Number.isInteger(r['count']) && (r['count'] as number) > 0)) return fail(400, 'bad_request', 'ladder rows need size_xmr (piconero string) and count.');
      rungs = (ladder as { size_xmr: string; count: number }[]).map((r) => ({ sizeXmr: BigInt(r.size_xmr), count: r.count }));
    }
    needLive('the split transaction');
    await d.inventory.sync();
    return d.inventory.split(rungs);
  });

  // ---------------------------------------------------------------- approvals
  const epochs = async (): Promise<ApprovalsResponse['epochs']> => {
    const out: ApprovalsResponse['epochs'] = [];
    const sm = d.sol ? await d.sol.client.getMaker(d.sol.makerPda, 'finalized').catch(() => null) : null;
    if (sm) out.push({ chain: 'solana', approval_epoch: sm.approvalEpoch, quote_epoch: sm.quoteEpoch });
    const em = d.eth ? await d.eth.client.getMaker(d.eth.makerAddress, d.eth.tag).catch(() => null) : null;
    if (em) out.push({ chain: 'ethereum', approval_epoch: em.approvalEpoch, quote_epoch: em.quoteEpoch });
    return out;
  };
  route('get', '/api/approvals', async (): Promise<ApprovalsResponse> => {
    const e = await epochs();
    const pending = [];
    for (const row of d.store.swaps({ open: true }).filter((r) => r.state === SWAP_STATE.PENDING)) {
      const v = snapshotOf(row);
      if (!v) continue;
      const decision = await d.approvals.decide(v, row, d.config.offers.find((o) => o.market === row.market && o.directionCode === row.direction));
      const p = pendingApproval(row, decision, d.config.raw.approvals.deny_watchers, d.store.takerFreezes(row.taker));
      if (p) pending.push(p);
    }
    return { pending, advance: d.approvals.records(Object.fromEntries(e.map((x) => [x.chain, x.approval_epoch])), {}), epochs: e };
  });
  route('post', '/api/approvals/advance', async (req) => {
    const b = body(req) as unknown as AdvanceApprovalRequest;
    if ((b.chain !== 'solana' && b.chain !== 'ethereum') || typeof b.taker !== 'string' || !amountOk(b.max_xmr) || typeof b.days !== 'number' || !(b.days > 0)) return fail(400, 'bad_request', 'chain, taker, max_xmr (piconero) and days are required.');
    if (b.max_xmr === '0') return fail(400, 'bad_request', 'The size limit must be more than 0.');
    try {
      const r = await d.approvals.issue({ chain: b.chain, taker: b.taker, ...(b.market ? { market: b.market } : {}), ...(b.direction ? { direction: b.direction } : {}), maxXmr: BigInt(b.max_xmr), days: b.days });
      return { record: r.record, sig: r.sig };
    } catch (e) {
      return fail(400, 'bad_request', errMsg(e));
    }
  });
  route('post', '/api/approvals/revoke', async (req) => {
    const b = body(req) as unknown as ApprovalRevokeRequest & { id?: string; all?: boolean };
    if (b.chain !== 'solana' && b.chain !== 'ethereum') return fail(400, 'bad_request', 'chain is required.');
    const txs: TxResult[] = [];
    if (b.all === true) {
      needLive('the epoch bump');
      // Bumping the approval epoch kills every outstanding approval.
      if (b.chain === 'solana') {
        if (!d.sol) return fail(409, 'not_registered', 'Solana is not configured.');
        const sol = d.sol;
        const { tx } = await d.journal.broadcast('sol_tx', null, { call: 'bump_epochs' }, (onSigned) => sol.sendInstructions([sol.client.program.bumpEpochs(sol.operator, sol.makerPda, true, false)], onSigned));
        txs.push({ chain: 'solana', id: tx!, status: 'sent' });
      } else {
        if (!d.eth) return fail(409, 'not_registered', 'Ethereum is not configured.');
        const eth = d.eth;
        const { tx } = await d.journal.broadcast('eth_tx', null, { call: 'bump_epochs' }, (onSigned) => eth.sendCall(eth.client.contract.bumpEpochs(false, true), onSigned));
        txs.push({ chain: 'ethereum', id: tx!, status: 'sent' });
      }
      for (const r of d.store.approvals()) if (r.chain === b.chain) d.store.revokeApproval(r.id);
      return { txs };
    }
    if (b.chain !== 'ethereum' || typeof b.id !== 'string') return fail(400, 'bad_request', 'A single approval can be revoked only on Ethereum; on Solana bump the epoch.');
    if (!d.store.approvals().some((r) => r.id === b.id)) return fail(404, 'unknown_approval', 'No such approval.');
    needLive('the revocation');
    if (!d.eth) return fail(409, 'not_registered', 'Ethereum is not configured.');
    const eth = d.eth;
    const { tx } = await d.journal.broadcast('eth_tx', null, { call: 'revoke_approval' }, (onSigned) => eth.sendCall(eth.client.contract.revokeApproval(Uint8Array.from(Buffer.from(b.id!.slice(2), 'hex'))), onSigned));
    d.store.revokeApproval(b.id);
    return { txs: [{ chain: 'ethereum', id: tx!, status: 'sent' } satisfies TxResult] };
  });

  // ---------------------------------------------------------------- deposits, inbox
  route('get', '/api/deposits', () => ({ deposits: depositViews(d.store, (row) => d.config.offers.find((o) => o.market === row.market && o.directionCode === row.direction), d.prices.usd('xmr')) }));
  route('get', '/api/inbox', () => {
    const items = d.inbox.items();
    return { items, unread: items.filter((i) => i.direction === 'in' && !i.read).length };
  });
  route('post', '/api/inbox/:id/reply', async (req) => {
    const text = body(req)['text'];
    if (!d.store.message(req.params['id']!)) return fail(404, 'unknown_message', 'No such message.');
    if (typeof text !== 'string' || text.trim() === '') return fail(400, 'bad_request', 'The reply is empty.');
    if (text.length > 2_000) return fail(400, 'too_long', 'A message holds at most 2,000 characters.');
    try {
      return await d.inbox.reply(req.params['id']!, text);
    } catch (e) {
      return fail(409, 'cannot_reply', errMsg(e));
    }
  });
  route('post', '/api/inbox/:id/read', (req) => {
    if (!d.store.message(req.params['id']!)) return fail(404, 'unknown_message', 'No such message.');
    return d.inbox.markRead(req.params['id']!);
  });

  // ---------------------------------------------------------------- rebalancing
  const refillOr = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const m = errMsg(e);
      if (/unknown refill/.test(m)) return fail(404, 'unknown_refill', m);
      return fail(409, /allow-list/.test(m) ? 'not_allowed' : 'refill_refused', m);
    }
  };
  route('get', '/api/rebalance', () => d.rebalance.view());
  route('post', '/api/rebalance/run', async (req) => {
    const b = body(req) as unknown as RebalanceRunRequest;
    if (!ASSETS.includes(b.from) || !ASSETS.includes(b.to) || b.from === b.to) return fail(400, 'bad_request', 'from and to must be two different assets.');
    if ((b.amount_in === undefined) === (b.amount_out === undefined) || !amountOk(b.amount_in ?? b.amount_out)) return fail(400, 'bad_request', 'Give exactly one of amount_in and amount_out.');
    return refillOr(() => d.rebalance.run({ from: b.from, to: b.to, ...(b.amount_in !== undefined ? { amountIn: BigInt(b.amount_in) } : {}), ...(b.amount_out !== undefined ? { amountOut: BigInt(b.amount_out) } : {}), ...(b.venue ? { venue: b.venue } : {}) }));
  });
  route('post', '/api/rebalance/approve/:id', (req) => {
    needLive('the refill');
    return refillOr(() => d.rebalance.approve(req.params['id']!));
  });
  route('post', '/api/rebalance/cancel/:id', (req) => refillOr(() => d.rebalance.cancel(req.params['id']!)));
  route('post', '/api/rebalance/manual', (req) => {
    const b = body(req) as unknown as RebalanceManualRequest;
    if (!ASSETS.includes(b.from) || !ASSETS.includes(b.to) || b.from === b.to || !amountOk(b.amount_in) || !amountOk(b.amount_out)) return fail(400, 'bad_request', 'from, to, amount_in and amount_out are required.');
    return d.rebalance.manual(b);
  });
  /** Acknowledge a failed or held refill once the maker has checked it; `choice` resolves a held order (not in the frozen API). */
  route('post', '/api/rebalance/ack/:id', (req) => refillOr(() => d.rebalance.acknowledge(req.params['id']!, body(req)['choice'] === 'continue' || body(req)['choice'] === 'refund' ? (body(req)['choice'] as 'continue' | 'refund') : undefined)));

  // ---------------------------------------------------------------- alerts (acknowledge: not in the frozen API)
  route('post', '/api/alerts/:id/ack', (req) => {
    const id = Number(req.params['id']);
    const changed = Number.isInteger(id) ? d.store.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id).changes : 0;
    if (changed === 0) return fail(404, 'unknown_alert', 'No such alert.');
    return d.alerts.list(100).find((a) => a.id === String(id));
  });

  // ---------------------------------------------------------------- keys
  route('get', '/api/keys', () => d.rotation.view());
  route('post', '/api/keys/rotate', async () => {
    needLive('the key rotation');
    if (!d.sol) return fail(409, 'not_registered', 'Key rotation needs the Solana registration.');
    const r = await d.rotation.rotate();
    return { version: r.version, tx: { chain: 'solana', id: r.tx, status: 'sent' } satisfies TxResult };
  });

  // ---------------------------------------------------------------- stats, fees
  const chainCounters = async (): Promise<ChainCounters[]> => {
    const out: ChainCounters[] = [];
    const sm = d.sol ? await d.sol.client.getMaker(d.sol.makerPda, 'finalized').catch(() => null) : null;
    if (sm) out.push({ chain: 'solana', counters: sm.counters.slice(0, COUNTER_NAMES.length), responseSecsSum: sm.responseSecsSum });
    const em = d.eth ? await d.eth.client.getMaker(d.eth.makerAddress, d.eth.tag).catch(() => null) : null;
    if (em) out.push({ chain: 'ethereum', counters: em.counters.slice(0, COUNTER_NAMES.length), responseSecsSum: em.responseSecsSum });
    return out;
  };
  route('get', '/api/stats', async (req) => statsView(d.store, await chainCounters(), Number((req.query as Record<string, string>)['since'] ?? 0) || 0));
  route('get', '/api/fees', async (): Promise<FeesResponse> => {
    const balances: FeesResponse['operator_balances'] = [];
    for (const [market, chain] of [['sol', 'solana'], ['usdc_sol', 'solana'], ['eth', 'ethereum'], ['usdc_eth', 'ethereum']] as [Market, ChainName][]) {
      const b = await d.payingBalance(market).catch(() => null);
      if (b !== null) balances.push({ chain, asset: market, balance: b.toString() });
    }
    const est = d.load.validation.update_cost ? updateCost(d.config.raw, d.config.offers, solUsd()) : null;
    return {
      ...feesView(d.store, { estimate: est, balances, usd: (a) => d.prices.usd(a), runwayAlertDays: d.config.raw.alerts.fee_runway_days, dailySwapLamports: d.dailySwapLamports() }),
      ...({ sol_usd: solUsd(), compute_units_per_update: REFRESH_CU, swap_cost: swapCosts(d.config.raw), daily_swap_lamports: d.dailySwapLamports().toString(), eth_runway_swaps: await d.ethRunwaySwaps().catch(() => null) } as object),
    };
  });

  // ---------------------------------------------------------------- pause switch
  const setPaused = async (paused: boolean, bump: boolean, reason: string): Promise<PauseResponse> => {
    // The local switch takes effect at once (offers are refreshed as disabled, new locks are rejected or aborted) even when no transaction can be sent.
    d.risk.setPaused(paused, reason);
    const txs: TxResult[] = [];
    if (d.live && d.sol) {
      const sol = d.sol;
      const p = sol.client.program;
      const ixs = [p.setPaused(sol.operator, sol.makerPda, paused), ...(bump ? [p.bumpEpochs(sol.operator, sol.makerPda, true, true)] : [])];
      try {
        const { tx } = await d.journal.broadcast('sol_tx', null, { call: paused ? 'set_paused' : 'set_resumed' }, (onSigned) => sol.sendInstructions(ixs, onSigned));
        txs.push({ chain: 'solana', id: tx!, status: 'sent' });
      } catch (e) {
        txs.push({ chain: 'solana', id: '', status: 'failed', error: errMsg(e) });
      }
    }
    if (d.live && d.eth && bump) {
      const eth = d.eth;
      try {
        const { tx } = await d.journal.broadcast('eth_tx', null, { call: 'bump_epochs' }, (onSigned) => eth.sendCall(eth.client.contract.bumpEpochs(true, true), onSigned));
        txs.push({ chain: 'ethereum', id: tx!, status: 'sent' });
      } catch (e) {
        txs.push({ chain: 'ethereum', id: '', status: 'failed', error: errMsg(e) });
      }
    }
    await d.offers.tick(true).catch(() => undefined);
    push('status');
    push('offers');
    return { paused, txs };
  };
  route('post', '/api/pause', (req) => setPaused(true, body(req)['bump_epochs'] === true, typeof body(req)['reason'] === 'string' ? (body(req)['reason'] as string) : ''));
  route('post', '/api/resume', () => setPaused(false, false, ''));

  // ---------------------------------------------------------------- errors, static console
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not_found' } satisfies ApiError));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiHttpError) return void res.status(err.status).json({ error: err.code, ...(err.message !== err.code ? { detail: err.message } : {}), ...err.extra });
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) return void res.status(status).json({ error: 'bad_request', detail: 'The body is not JSON.' } satisfies ApiError);
    // Never a stack trace or a secret: the message only.
    res.status(500).json({ error: 'internal', detail: errMsg(err) } satisfies ApiError);
  });
  const consoleDir = d.consoleDir();
  if (consoleDir) {
    app.use(express.static(consoleDir, { index: 'index.html' }));
    app.get('*', (_req, res) => res.sendFile('index.html', { root: consoleDir }));
  }

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true });
  const subs = new Map<import('ws').WebSocket, Set<WsChannel>>();
  const snapshot = async (channel: WsChannel): Promise<unknown> => {
    switch (channel) {
      case 'status':
        return d.status();
      case 'swaps':
        return d.store.swaps().slice(0, 200).map((r) => swapSummary(r, d.store.now(), d.store));
      case 'offers':
        return d.offers.views();
      case 'inbox':
        return d.inbox.items();
      case 'rebalance':
        return (await d.rebalance.view()).refills;
      case 'alerts':
        return d.alerts.list(50);
    }
  };
  const sendTo = (ws: import('ws').WebSocket, m: WsServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  function push(channel: WsChannel, data?: unknown): void {
    const targets = [...subs].filter(([, set]) => set.has(channel)).map(([ws]) => ws);
    if (targets.length === 0) return;
    void Promise.resolve(data ?? snapshot(channel))
      .then((payload) => targets.forEach((ws) => sendTo(ws, { op: 'update', channel, data: payload } as WsServerMessage)))
      .catch(() => undefined);
  }
  const offs = [
    d.executor.events.on('swap', (ref) => {
      const row = d.store.swap(ref);
      if (row) push('swaps', [swapSummary(row, d.store.now(), d.store)]);
    }),
    d.offers.events.on('offers', () => push('offers')),
    d.inbox.events.on('message', (m) => push('inbox', [m])),
    d.alerts.events.on('alert', (a) => push('alerts', [a])),
    d.events.on('config', () => (push('status'), push('offers'))),
    d.events.on('status', () => (push('status'), push('rebalance'))),
  ];
  const ping = setInterval(() => subs.forEach((_s, ws) => sendTo(ws, { op: 'ping' })), WS_PING_SECS * 1000);
  ping.unref();

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once('error', reject);
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === `http://${req.headers.host}` || d.config.raw.daemon.cors_origins.includes(origin);
    if (url.pathname !== '/api/ws' || !sameOrigin || !(tokenOk(url.searchParams.get('token')) || tokenOk(bearer))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      subs.set(ws, new Set());
      ws.on('message', (raw) => {
        let m: WsClientMessage;
        try {
          m = JSON.parse(String(raw)) as WsClientMessage;
        } catch {
          return sendTo(ws, { op: 'error', error: 'not JSON' });
        }
        if (m.op === 'pong') return;
        if ((m.op !== 'subscribe' && m.op !== 'unsubscribe') || !Array.isArray(m.channels)) return sendTo(ws, { op: 'error', error: 'unknown op' });
        for (const c of m.channels) {
          if (!(WS_CHANNELS as readonly string[]).includes(c)) {
            sendTo(ws, { op: 'error', error: `unknown channel ${String(c)}` });
            continue;
          }
          if (m.op === 'unsubscribe') subs.get(ws)?.delete(c);
          else {
            subs.get(ws)?.add(c);
            void snapshot(c)
              .then((data) => sendTo(ws, { op: 'snapshot', channel: c, data } as WsServerMessage))
              .catch((e) => sendTo(ws, { op: 'error', error: errMsg(e) }));
          }
        }
      });
      ws.on('close', () => subs.delete(ws));
    });
  });
  const actual = (server.address() as { port: number }).port;
  return {
    server, port: actual, url: `http://${host}:${actual}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(ping);
        offs.forEach((off) => off());
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
