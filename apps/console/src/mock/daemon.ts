/**
 * An in-memory stand-in for the maker daemon's local API (SPEC 7.8), implementing every route
 * of `@xmrswap/protocol`'s `ROUTES` and the WebSocket channels with the frozen request and
 * response shapes. It has no network code: `handle()` takes a method, a path and a body, so the
 * tests call it through a fetch shim and `server/mock-server.ts` puts it behind loopback HTTP.
 *
 * It moves no funds and holds no keys. Transaction ids it returns are synthetic.
 */
import { CHAIN_CONSTS, MARKET_CHAIN, base58Decode, toHex, type ChainName, type Market } from '@xmrswap/protocol';
import {
  ROUTES,
  WS_CHANNELS,
  type AdvanceApprovalRecord,
  type AdvanceApprovalRequest,
  type Alert,
  type ApiError,
  type ApprovalRevokeRequest,
  type ApprovalsResponse,
  type ConfigLogEntry,
  type ConfigResponse,
  type ConfigValidation,
  type DaemonMode,
  type DepositView,
  type EncKeyView,
  type FeesResponse,
  type InboxItem,
  type InventoryResponse,
  type KeysResponse,
  type OfferView,
  type OffersResponse,
  type PendingApproval,
  type RebalanceManualRequest,
  type RebalanceResponse,
  type RebalanceRunRequest,
  type RefillView,
  type RegistrationAction,
  type RegistrationResponse,
  type RegistrationTxResponse,
  type RouteName,
  type StatsResponse,
  type StatusResponse,
  type SwapAction,
  type SwapDetail,
  type SwapSummary,
  type TxResult,
  type VenueId,
  type WsChannel,
  type WsClientMessage,
  type WsPayloads,
  type WsServerMessage,
} from '@xmrswap/protocol/daemon-api';
import { VENUES, isPool } from '../lib/config/schema.js';
import { ConfigSyntaxError, diffConfig, getPath, isTable, parseToml, revisionOf, type Toml } from '../lib/config/toml.js';
import { missingPrice, missingPriceMessage, pairsFrom, poolState, resolveOffers, unknownKeys, validateConfig, withDefaults, type ResolvedOffer } from '../lib/config/validate.js';
import { runwayDays } from '../lib/cost.js';
import {
  ADDR,
  DEFAULT_TOML,
  REFERENCE_USD,
  fakeHex,
  fakeSol,
  seedAlerts,
  seedApprovals,
  seedDeposits,
  seedInbox,
  seedInventory,
  seedKeys,
  seedRefills,
  seedRegistration,
  seedSwaps,
  sol,
  xmr,
} from './fixtures.js';

export const MOCK_TOKEN = 'mock-token';

export interface MockOptions {
  /** Unix seconds; defaults to the wall clock. Tests pass a controllable clock. */
  now?: () => number;
  token?: string;
  toml?: string;
  /** Start with no swaps, messages, refills or alerts (an unused daemon). */
  empty?: boolean;
  /**
   * Keys the daemon's schema defines that this console's copy of the schema does not (dotted paths).
   * The two copies drift; tests use this to stand for a daemon that is ahead of the console.
   */
  daemonKnows?: readonly string[];
  /** Whether the registry lists a blob endpoint. */
  blobEndpoint?: boolean;
  /** `true`, `false` or `null` per chain: can the program or contract still be upgraded. */
  upgradeable?: { solana: boolean | null; ethereum: boolean | null };
}
export interface MockResponse {
  status: number;
  body: unknown;
}
export interface MockRequest {
  method: string;
  /** Path with an optional query string. */
  path: string;
  body?: unknown;
  /** The `Authorization` header. */
  authorization?: string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
const fail = (status: number, code: string, detail?: string, extra: Record<string, unknown> = {}): never => {
  throw new HttpError(status, code, detail, extra);
};

/** The daemon's words for each reason an operator instruction can be refused with (its `REFUSALS`). */
export const REFUSALS: Record<string, string> = {
  'ready-already-set': 'ready is set; the swap can no longer be backed out of until the claim window closes',
  'refund-window-closed': "the refund window is over; a refund sent now could land in the taker's claim window and leak the key share",
  'abort-window-closed': 'an abort is no longer accepted in this state',
  'already-settled': 'the swap is already settled',
  'reject-not-available': 'a pending take cannot be rejected on Solana outside window mode; it can only be left to lapse',
  'hold-ended': 'the 30-minute hold has ended; a deposit can no longer be withheld',
  'no-deposit-held': 'no deposit is held or withheld on this swap',
  'not-available-in-state': 'the swap is not in a state that accepts it',
  'dry-run': 'the daemon is in dry run and sends no transaction',
};
/** Compute units the daemon charges one offer update at (20,100 measured × 1.2). */
export const REFRESH_CU = 24_120;

type Params = Record<string, string>;
type Handler = (ctx: { params: Params; query: URLSearchParams; body: unknown }) => unknown;

const OPEN_STATES = new Set(['PENDING', 'ACTIVE', 'NOTICED', 'READY', 'ABORTED_FREE', 'ABORTED_HOLD', 'HOLD', 'WITHHELD']);

export class MockDaemon {
  readonly token: string;
  readonly startedAt: number;
  private readonly clock: () => number;
  private toml: string;
  private parsed: Toml;
  private readonly log: ConfigLogEntry[] = [];
  private registration: RegistrationResponse;
  private swaps: SwapDetail[];
  private pending: PendingApproval[];
  private advance: AdvanceApprovalRecord[];
  private deposits: DepositView[];
  private inbox: InboxItem[];
  private refills: RefillView[];
  private keys: EncKeyView[];
  private alerts: Alert[];
  private inventory: InventoryResponse;
  private paused = { owner: false, operator: false };
  private ownerPaused: Record<ChainName, boolean> = { solana: false, ethereum: false };
  private epochs: Record<ChainName, { approval_epoch: number; quote_epoch: number }> = {
    solana: { approval_epoch: 2, quote_epoch: 5 },
    ethereum: { approval_epoch: 2, quote_epoch: 3 },
  };
  private upgradeable: { solana: boolean | null; ethereum: boolean | null };
  private lastRotationAt: number;
  private seq = 100;
  private readonly registrationRequests = new Map<string, RegistrationAction>();
  private readonly sockets = new Set<{ channels: Set<WsChannel>; send: (m: WsServerMessage) => void }>();
  private readonly routes: { name: RouteName; method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  /** Tests set this to make the next request fail with a 500, to exercise error states. */
  failNext: string | null = null;

  constructor(opts: MockOptions = {}) {
    this.clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.token = opts.token ?? MOCK_TOKEN;
    this.daemonKnows = opts.daemonKnows ?? [];
    const now = this.now();
    this.startedAt = now - 6 * 86_400 - 4_000;
    this.toml = opts.toml ?? DEFAULT_TOML;
    this.parsed = parseToml(this.toml);
    this.registration = seedRegistration();
    if (opts.blobEndpoint === false) {
      this.registration.blob_endpoint = false;
      this.registration.solana.contacts = this.registration.solana.contacts.filter((c) => c.kind !== 5);
    }
    this.upgradeable = opts.upgradeable ?? { solana: true, ethereum: true };
    const empty = opts.empty === true;
    this.swaps = empty ? [] : seedSwaps(now);
    const approvals = seedApprovals(now);
    this.pending = empty ? [] : approvals.pending;
    this.advance = empty ? [] : approvals.advance;
    this.deposits = empty ? [] : seedDeposits(now);
    this.inbox = empty ? [] : seedInbox(now);
    this.refills = empty ? [] : seedRefills(now);
    this.keys = empty ? [seedKeys(now)[0] as EncKeyView] : seedKeys(now);
    this.alerts = empty ? [] : seedAlerts(now);
    this.inventory = seedInventory();
    this.lastRotationAt = now - 30 * 3_600;
    this.log.push({
      at: this.startedAt,
      revision: revisionOf(this.toml),
      changes: [{ path: '(file)', old: null, new: 'loaded at start' }],
      source: 'file',
    });
    if (this.registration.solana.link.current) this.linkLog.push(linkEntry('solana', null, this.registration.solana.link.current, now - 200 * 86_400));
    if (this.registration.ethereum.link.current) this.linkLog.push(linkEntry('ethereum', null, this.registration.ethereum.link.current, now - 200 * 86_400 + 600));
    this.defineRoutes();
  }

  now(): number {
    return this.clock();
  }

  // ---------------------------------------------------------------- transport

  handle(req: MockRequest): MockResponse {
    const [rawPath = '', rawQuery = ''] = req.path.split('?');
    if (!rawPath.startsWith('/api/')) return { status: 404, body: { error: 'not_found' } satisfies ApiError };
    if (req.authorization !== `Bearer ${this.token}`) {
      return { status: 401, body: { error: 'unauthorized', detail: 'Missing or wrong bearer token.' } satisfies ApiError };
    }
    if (this.failNext !== null) {
      const detail = this.failNext;
      this.failNext = null;
      return { status: 500, body: { error: 'internal', detail } satisfies ApiError };
    }
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(rawPath);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method.toUpperCase()) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
      try {
        return { status: 200, body: r.handler({ params, query: new URLSearchParams(rawQuery), body: req.body }) };
      } catch (e) {
        if (e instanceof HttpError) {
          const body: ApiError = e.detail === undefined ? { error: e.code } : { error: e.code, detail: e.detail };
          return { status: e.status, body: { ...body, ...e.extra } };
        }
        return { status: 500, body: { error: 'internal', detail: e instanceof Error ? e.message : String(e) } satisfies ApiError };
      }
    }
    return pathMatched ? { status: 405, body: { error: 'method_not_allowed' } satisfies ApiError } : { status: 404, body: { error: 'not_found' } satisfies ApiError };
  }

  /** One WebSocket connection: returns what the transport calls with each client message, and a close function. */
  connect(send: (m: WsServerMessage) => void): { receive: (m: WsClientMessage) => void; close: () => void } {
    const socket = { channels: new Set<WsChannel>(), send };
    this.sockets.add(socket);
    return {
      receive: (m) => {
        if (m.op === 'subscribe') {
          for (const c of m.channels) {
            if (!(WS_CHANNELS as readonly string[]).includes(c)) {
              send({ op: 'error', error: `unknown channel ${String(c)}` });
              continue;
            }
            socket.channels.add(c);
            send(this.message('snapshot', c));
          }
        } else if (m.op === 'unsubscribe') for (const c of m.channels) socket.channels.delete(c);
      },
      close: () => void this.sockets.delete(socket),
    };
  }
  /** Sends the 30-second ping to every connection (the transport owns the timer). */
  ping(): void {
    for (const s of this.sockets) s.send({ op: 'ping' });
  }
  get connections(): number {
    return this.sockets.size;
  }

  private snapshot<C extends WsChannel>(channel: C): WsPayloads[C] {
    const data: WsPayloads = {
      status: this.status(),
      swaps: this.swaps.map((x) => summary(this.view(x))),
      offers: this.offers().offers,
      inbox: this.inbox,
      rebalance: this.refills.map((r) => this.refillView(r)),
      alerts: this.alerts,
    };
    return data[channel];
  }
  private message(op: 'snapshot' | 'update', channel: WsChannel): WsServerMessage {
    return { op, channel, data: this.snapshot(channel) } as WsServerMessage;
  }
  private push(...channels: WsChannel[]): void {
    for (const s of this.sockets) for (const c of channels) if (s.channels.has(c)) s.send(this.message('update', c));
  }

  private route(name: RouteName, handler: Handler): void {
    const { method, path } = ROUTES[name];
    this.routeAt(name, method, path, handler);
  }
  /** A route the daemon adds to the frozen API. */
  private routeAt(name: string, method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:([a-z_]+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ name: name as RouteName, method, pattern, keys, handler });
  }

  // ---------------------------------------------------------------- derived state

  /** Test seam: a two-step transfer of the Ethereum proxy's ownership is waiting. */
  pendingUpgradeAuthority: string | null = null;
  /** Test seam: why a chain's upgrade status could not be read. */
  upgradeReason = 'the RPC endpoint did not answer the upgrade-authority read';
  private upgradeExtras(chain: ChainName, now: number): object {
    const u = this.upgradeable[chain];
    return {
      upgrade_status: u === true ? 'upgradable' : u === false ? 'immutable' : 'unknown',
      upgrade_reason: u === null ? this.upgradeReason : null,
      upgrade_pending_authority: chain === 'ethereum' && u === true ? this.pendingUpgradeAuthority : null,
      upgrade_implementation: u === null ? null : chain === 'solana' ? fakeSol('program-data') : `0x${fakeHex('implementation', 20)}`,
      upgrade_checked_at: now - 20,
    };
  }
  private get mode(): DaemonMode {
    return getPath(this.parsed, 'daemon.mode') === 'live' ? 'live' : 'dry_run';
  }
  private get dryRun(): boolean {
    return this.mode === 'dry_run' || getPath(this.parsed, 'guardrails.dry_run') === true;
  }
  private requireLive(what: string): void {
    if (this.dryRun) fail(409, 'dry_run', `Dry run: ${what} was not sent. Switch the daemon to live mode to send transactions.`);
  }
  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
  private tx(chain: ChainName, label: string): TxResult {
    const id = chain === 'solana' ? fakeSol(`sig:${label}:${this.seq++}`) + fakeSol(`sig2:${label}:${this.seq}`) : `0x${fakeHex(`tx:${label}:${this.seq++}`, 32)}`;
    return { chain, id, status: 'confirmed' };
  }

  private readonly daemonKnows: readonly string[];
  /**
   * The daemon's verdict. Its schema is strict: a key it does not define is an error, reported
   * as zod does, on the parent table ("Unrecognized key"). The daemon, not the console, knows
   * which keys those are.
   */
  private validation(toml: Toml = this.parsed): ConfigValidation {
    const v = validateConfig(toml, { blobEndpoint: this.registration.blob_endpoint, solUsd: this.solUsd, expectedTriggeredPerDay: 310 });
    // What the maker picks is what runs; the risks are warnings. The daemon refuses only what cannot work:
    // a pool that is named but not in the file, a market its sources cannot price, a USD guardrail with no USD figure.
    const refused: { path: string; message: string }[] = [];
    for (const o of resolveOffers(toml, { blobEndpoint: this.registration.blob_endpoint })) {
      if (!o.wanted) continue;
      const base = `markets.${o.market}.${o.direction}`;
      const where = `${o.market} ${o.direction}`;
      for (const src of new Set([o.source, ...o.fallbacks, ...(o.crossCheck ? [o.crossCheck] : [])])) {
        if (isPool(src) && poolState(toml, src) === 'absent') refused.push({ path: `${base}.${src === o.source ? 'source' : o.fallbacks.includes(src) ? 'fallbacks' : 'cross_check'}`, message: `${src} is named but [pricing.sources.${src}] is not in the file` });
      }
      const chain = [o.source, ...o.fallbacks];
      const miss = missingPrice(o.market, o.source, chain, toml);
      if (miss) refused.push({ path: `${base}.source`, message: missingPriceMessage(where, o.source, miss) });
      else {
        const usdKnown = chain.some((src) => pairsFrom(src, toml).some((g) => g === 'XMR/USD' || g === 'SOL/USD'));
        const band = getPath(toml, 'guardrails.price_band_usd');
        if (!usdKnown && band !== undefined && band !== false)
          refused.push({ path: `${base}.source`, message: `${where} has a hard price band in USD; ${o.source} gives XMR/SOL and nothing here supplies SOL/USD — add coingecko or coinmarketcap as this market's source for SOL/USD, or remove guardrails.price_band_usd` });
      }
    }
    if (refused.length > 0) {
      v.ok = false;
      v.errors.push(...refused);
      v.effective = v.effective.filter((e) => !refused.some((u) => u.path.startsWith(`markets.${e.market}.${e.direction}.`)));
    }
    const strange = unknownKeys(toml).filter((k) => !this.daemonKnows.some((p) => k === p || k.startsWith(`${p}.`)));
    if (strange.length === 0) return v;
    const errors = strange.map((k) => {
      const dot = k.lastIndexOf('.');
      return { path: dot < 0 ? '' : k.slice(0, dot), message: `Unrecognized key: "${k.slice(dot + 1)}"` };
    });
    return { ...v, ok: false, errors: [...errors, ...v.errors], effective: [], update_cost: null };
  }
  private configResponse(): ConfigResponse {
    return { toml: this.toml, parsed: withDefaults(this.parsed), validation: this.validation(), revision: revisionOf(this.toml) };
  }
  private parseOr400(toml: unknown): Toml {
    if (typeof toml !== 'string') fail(400, 'bad_request', 'The body needs a "toml" string.');
    try {
      return parseToml(toml as string);
    } catch (e) {
      const where = e instanceof ConfigSyntaxError && e.line !== null ? ` (line ${e.line})` : '';
      return fail(400, 'invalid_toml', `${e instanceof Error ? e.message : 'invalid TOML'}${where}`, { issues: [], warnings: [] });
    }
  }
  private applyConfig(toml: string, source: ConfigLogEntry['source']): ConfigResponse {
    const next = this.parseOr400(toml);
    const v = this.validation(next);
    if (!v.ok) {
      const first = v.errors[0];
      fail(422, 'invalid_config', first ? `${first.path}: ${first.message}` : 'The configuration has errors.', { issues: v.errors, warnings: v.warnings });
    }
    const changes = diffConfig(this.parsed, next);
    this.toml = toml;
    this.parsed = next;
    // Applied in place: nothing restarts, `started_at` is unchanged.
    if (changes.length > 0) this.log.push({ at: this.now(), revision: revisionOf(toml), changes, source });
    this.push('status', 'offers');
    return this.configResponse();
  }

  private status(): StatusResponse {
    const now = this.now();
    const guardrails: string[] = [];
    return {
      version: '0.1.0-mock',
      core_version: '0.1.0',
      mode: this.mode,
      started_at: this.startedAt,
      uptime_secs: now - this.startedAt,
      maker: { solana: this.registration.solana.maker, ethereum: this.registration.ethereum.maker },
      chains: [
        {
          chain: 'solana',
          connected: true,
          endpoint: 'primary (SOLANA_RPC_URL)',
          network: fakeSol('genesis'),
          network_ok: true,
          chain_time: now - 1,
          clock_skew_secs: 1,
          contract: ADDR.program,
          upgradeable: this.upgradeable.solana,
          upgrade_authority: this.upgradeable.solana ? ADDR.upgradeAuthoritySol : null,
          ...this.upgradeExtras('solana', now),
        },
        {
          chain: 'ethereum',
          connected: true,
          endpoint: 'primary (ETH_RPC_URL)',
          network: '1',
          network_ok: true,
          chain_time: now - 7,
          clock_skew_secs: 7,
          finality: getPath(this.parsed, 'ethereum.finality') === 'safe' ? 'safe' : 'finalized',
          contract: ADDR.contract,
          upgradeable: this.upgradeable.ethereum,
          upgrade_authority: this.upgradeable.ethereum ? ADDR.upgradeAuthorityEth : null,
          ...this.upgradeExtras('ethereum', now),
        },
      ],
      monero: {
        nodes: [
          { label: 'node A (own)', ok: true, height: 3_412_882, top_hash: fakeHex('top', 32) },
          { label: 'node B', ok: true, height: 3_412_882, top_hash: fakeHex('top', 32) },
        ],
        agree: true,
        wallet_rpc_ok: true,
        reorg_guard_active: false,
      },
      tor: {
        enabled: getPath(this.parsed, 'tor.enabled') === true,
        // What the daemon wants listed, against what the registry shows (A12). It runs no Tor client, so `reachable` is never known.
        onion: this.desired.onion !== undefined ? this.desired.onion : this.registration.solana.onion,
        published: (this.desired.onion !== undefined ? this.desired.onion : this.registration.solana.onion) !== null && (this.desired.onion === undefined || this.desired.onion === this.registration.solana.onion),
        reachable: null,
        ...({ registry_onion: this.registration.solana.onion } as object),
      },
      // `chains` is the daemon's addition: the owner's pause is per chain, and on Ethereum the operator cannot pause.
      paused: {
        ...this.paused,
        guardrails,
        ...({ chains: (['solana', 'ethereum'] as const).map((chain) => ({ chain, owner: this.ownerPaused[chain], operator: chain === 'solana' && this.paused.operator })) } as object),
      },
      needs_review: this.swaps.filter((s) => s.needs_review).length,
      alerts: this.alerts,
    };
  }

  private offerView(o: ResolvedOffer): OfferView {
    const now = this.now();
    const decimals = { sol: 9, usdc_sol: 6, eth: 18, usdc_eth: 6 }[o.market];
    const assetUsd = o.market === 'sol' ? REFERENCE_USD.sol : o.market === 'eth' ? REFERENCE_USD.eth : 1;
    const toBase = (usdPerXmr: number): string => (BigInt(Math.round((usdPerXmr / assetUsd) * 1e6)) * 10n ** BigInt(decimals - 6)).toString();
    const sign = o.direction === 'sell_xmr' ? 1 : -1;
    const dev = typeof o.values.deviation_pct === 'number' ? o.values.deviation_pct : 2;
    const tiers = [{ above_xmr: '0', price: toBase(REFERENCE_USD.xmr * (1 + (sign * dev) / 100)) }];
    for (const t of Array.isArray(o.values.size_tiers) ? o.values.size_tiers : []) {
      if (isTable(t) && typeof t.above_xmr === 'number' && typeof t.extra_pct === 'number')
        tiers.push({ above_xmr: xmr(t.above_xmr), price: toBase(REFERENCE_USD.xmr * (1 + (sign * (dev + t.extra_pct)) / 100)) });
    }
    const on = o.terms.enabled;
    const live = on && !this.dryRun && !this.paused.operator && !this.paused.owner;
    const eth = o.chain === 'ethereum';
    const reason = !o.wanted
      ? 'Switched off in the configuration'
      : o.keptOff.length > 0
        ? `Kept off: ${o.keptOff.join('; ')}`
        : this.paused.operator || this.paused.owner
          ? 'Paused'
          : this.dryRun
            ? 'Dry run: computed but not published'
            : undefined;
    const view: OfferView = {
      market: o.market,
      direction: o.direction,
      live,
      enabled: on,
      reference_price: on ? toBase(REFERENCE_USD.xmr) : null,
      price_tiers: on ? tiers : [],
      deviation_pct: dev,
      min_xmr: xmr(typeof o.values.min_xmr === 'number' ? o.values.min_xmr : 0.1),
      max_xmr: xmr(o.maxXmr ?? 0),
      capacity_xmr: on ? (o.direction === 'sell_xmr' ? this.inventory.capacity_xmr : xmr(Math.min(o.maxXmr ?? 0, 120))) : '0',
      terms: o.terms,
      key_pool: !on || o.direction === 'buy_xmr' ? null : eth ? { size: 64, available: 57 } : { size: 16, available: o.market === 'sol' ? 3 : 11 },
      seq_or_quote_id: live ? (eth ? '8841' : '120394') : null,
      updated_at: live ? now - 6 : null,
      valid_until: live ? now - 6 + (typeof o.values.offer_valid_seconds === 'number' ? o.values.offer_valid_seconds : 60) : null,
    };
    if (reason !== undefined) view.disabled_reason = reason;
    return view;
  }

  private operatorLamports = BigInt(sol(2.4));
  /** The daemon's SOL price; `null` when no source has answered. Tests may change it. */
  solUsd: number | null = REFERENCE_USD.sol;
  private offers(cfg: Toml = this.parsed): OffersResponse & { sol_usd: number | null; compute_units_per_update: number } {
    const v = this.validation(cfg);
    const offers = resolveOffers(cfg, { blobEndpoint: this.registration.blob_endpoint }).map((o) => this.offerView(o));
    const daily = v.update_cost ? BigInt(v.update_cost.daily_lamports) : 0n;
    return {
      offers,
      update_cost: v.update_cost,
      spent_24h_lamports: this.dryRun ? '0' : ((daily * 97n) / 100n).toString(),
      runway_days: runwayDays(this.operatorLamports, daily),
      occasional: [
        { kind: 'key_refill', count_24h: 3, cost: '15000', asset: 'sol' },
        { kind: 'key_rotation', count_24h: 1, cost: '5000', asset: 'sol' },
        { kind: 'quote_on_request', count_24h: 2, cost: '3200000', asset: 'sol' },
        { kind: 'eth_registry', count_24h: 1, cost: '412000000000000', asset: 'eth' },
      ],
      sol_usd: this.solUsd,
      compute_units_per_update: REFRESH_CU,
    };
  }

  private findSwap(ref: string): SwapDetail {
    const s = this.swaps.find((x) => x.ref === ref);
    return s ?? fail(404, 'unknown_swap', `No swap ${ref}.`);
  }
  /** Manual actions the stored state allows right now (the daemon's `actionsFor`); the chain has the last word. */
  private actionsOf(s: SwapDetail): SwapAction[] {
    const now = this.now();
    const out: SwapAction[] = [];
    if (s.state === 'DONE' || s.state === 'NONE') return out;
    if (s.state === 'PENDING' && (s.deadlines.t_pending_deadline === null || now < s.deadlines.t_pending_deadline)) out.push('approve', 'reject');
    if (s.state === 'ACTIVE' || s.state === 'NOTICED') out.push('abort');
    if (s.state === 'HOLD' && s.deadlines.t_hold !== null && now < s.deadlines.t_hold) out.push('withhold');
    if (s.state === 'HOLD' || s.state === 'WITHHELD') out.push('release');
    if (s.deadlines.t_notice !== null && !s.evidence_published && s.direction === 'A' && s.state !== 'NOTICED' && s.state !== 'READY') out.push('publish-evidence');
    return out;
  }
  private instructionOf(ref: string): object | null {
    const i = this.instructions.get(ref);
    return i ? { action: i.action, at: i.at, status: i.status, reason: i.reason, tx: i.tx } : null;
  }
  /** The swap as the API shows it: actions computed now, and the operator's latest instruction. */
  private view(s: SwapDetail): SwapDetail {
    return { ...s, actions: this.actionsOf(s), ...({ instruction: this.instructionOf(s.ref) } as object) };
  }
  private settle(s: SwapDetail, outcome: SwapDetail['outcome']): void {
    s.state = 'DONE';
    s.phase = 'settled';
    s.outcome = outcome;
    s.next_deadline = null;
    s.deadlines.t_settled = this.now();
  }
  private readonly acknowledged = new Set<string>();
  /** Swaps with a payout parked on chain, and the address it is keyed to. */
  private readonly parked = new Map<string, string>();
  private readonly owedRequests = new Map<string, string>();
  /** Test seam: a payout of this swap could not be delivered and is parked in the contract. */
  parkPayout(ref: string, keyedTo: string): void {
    this.parked.set(ref, keyedTo);
  }
  private desired: { contacts?: { kind: number; value: string }[]; onion?: string | null } = {};
  /** Every recorded `LinkChanged`, as 0x-hex bytes. Seeded with the two first links. */
  private linkLog: { chain: ChainName; old: string; new: string; old_hex: string; new_hex: string; effective_at: number; superseded: boolean }[] = [];
  private readonly instructions = new Map<string, { action: SwapAction; at: number; status: 'pending' | 'carried_out' | 'refused'; reason: string | null; tx: string | null; body: unknown }>();
  private readonly inFlight = new Map<string, string>();
  private readonly chainRefuses = new Map<string, string>();
  /** Test seam: a transaction of this swap is still in flight, so an instruction waits behind it. */
  holdTransaction(ref: string, waitingOn = 'the claim transaction'): void {
    this.inFlight.set(ref, waitingOn);
  }
  /** Test seam: the chain is ahead of the stored state, so the next instruction on this swap is refused with this reason. */
  chainSays(ref: string, reason: string): void {
    this.chainRefuses.set(ref, reason);
  }
  /** Test seam: the transaction in flight lands; a pending instruction is carried out or refused on this step. */
  landTransaction(ref: string): void {
    this.inFlight.delete(ref);
    const ins = this.instructions.get(ref);
    if (!ins || ins.status !== 'pending') return;
    const s = this.findSwap(ref);
    this.resolve(s, ins);
    if ((ins.status as string) === 'refused') {
      this.alerts.unshift({ id: String(this.seq++), at: this.now(), level: 'warning', kind: 'instruction_refused', message: `${ins.action} on swap ${ref} was not carried out: ${REFUSALS[ins.reason ?? ''] ?? ins.reason}`, swap_ref: ref, acknowledged: false });
      this.push('alerts');
    }
    this.push('swaps', 'status');
  }
  /** One step of the flow for an instruction: carried out with its transaction, or refused with the reason. One-shot either way. */
  private resolve(s: SwapDetail, ins: { action: SwapAction; status: 'pending' | 'carried_out' | 'refused'; reason: string | null; tx: string | null; body: unknown }): void {
    const refusal = this.chainRefuses.get(s.ref);
    if (refusal !== undefined) {
      this.chainRefuses.delete(s.ref);
      ins.status = 'refused';
      ins.reason = refusal;
      return;
    }
    const now = this.now();
    switch (ins.action) {
      case 'approve':
        s.state = 'ACTIVE';
        s.phase = 'approved';
        s.deadlines.t_active = now;
        s.deadlines.t_note_deadline = now + CHAIN_CONSTS[s.chain].minNoticeSecs + 300;
        s.next_deadline = { at: s.deadlines.t_note_deadline, label: 'Lock-notice deadline; a miss is recorded against you' };
        this.pending = this.pending.filter((p) => p.ref !== s.ref);
        break;
      case 'reject': {
        const reason = isTable(ins.body) ? (ins.body.reason ?? 0) : 0;
        this.settle(s, reason === 0 ? 'rejections' : 'rejections_no_fault');
        this.pending = this.pending.filter((p) => p.ref !== s.ref);
        break;
      }
      case 'abort':
        s.state = s.deposit !== '0' ? 'ABORTED_HOLD' : 'ABORTED_FREE';
        s.phase = 'aborted';
        s.next_deadline = { at: s.deadlines.t_final, label: 'Final deadline for the taker to collect' };
        break;
      case 'withhold': {
        s.state = 'WITHHELD';
        s.phase = 'deposit_withheld';
        s.deposit_state = 2;
        const d = this.deposits.find((x) => x.ref === s.ref);
        if (d) {
          d.state = 'withheld';
          if (d.evidence_required) s.evidence_published = true;
        }
        s.next_deadline = d ? { at: d.split_at, label: '60-day split: half to the taker, half to the treasury' } : null;
        s.deadlines.t_split = d?.split_at ?? null;
        break;
      }
      case 'release':
        s.deposit_state = 4;
        this.settle(s, 'releases');
        this.deposits = this.deposits.filter((x) => x.ref !== s.ref);
        break;
      case 'publish-evidence':
        s.evidence_published = true;
        break;
    }
    ins.status = 'carried_out';
    ins.tx = this.tx(s.chain, ins.action).id;
  }
  /**
   * An operator instruction (the daemon's A10): always answered 200 with `outcome` carried_out,
   * refused (with `refused`) or pending; it is written down before anything acts on it.
   */
  private swapAction(ref: string, action: SwapAction, body: unknown): Record<string, unknown> {
    const s = this.findSwap(ref);
    if (!this.actionsOf(s).includes(action)) fail(409, 'action_unavailable', `"${action}" is not available for this swap in state ${s.state}.`);
    this.requireLive(`the ${action} transaction`);
    if (action === 'reject') {
      const reason = isTable(body) ? (body.reason ?? 0) : 0;
      if (reason !== 0 && reason !== 1 && reason !== 2) fail(400, 'bad_request', 'reason must be 0, 1 or 2.');
    }
    const ins = { action, at: this.now(), status: 'pending' as 'pending' | 'carried_out' | 'refused', reason: null as string | null, tx: null as string | null, body };
    this.instructions.set(ref, ins);
    const waiting = this.inFlight.get(ref);
    if (waiting === undefined) this.resolve(s, ins);
    this.push('swaps', 'status');
    const { status, reason, tx: txId } = ins as { status: 'pending' | 'carried_out' | 'refused'; reason: string | null; tx: string | null };
    const tx: TxResult | null = txId ? { chain: s.chain, id: txId, status: 'confirmed' } : null;
    return {
      ok: status !== 'refused',
      tx,
      detail:
        status === 'carried_out'
          ? `${action}: carried out`
          : status === 'refused'
            ? `${action} was not carried out: ${REFUSALS[reason ?? ''] ?? reason}`
            : `${action} is recorded and will be carried out as soon as it can be (waiting on ${waiting}); it survives a restart`,
      outcome: status,
      ...(status === 'refused' ? { refused: reason } : {}),
    };
  }

  private approvals(): ApprovalsResponse {
    const now = this.now();
    return {
      pending: this.pending.filter((p) => p.deadline > now),
      advance: this.advance.map((a) => ({ ...a, active: a.active && a.expires_at > now && a.epoch === this.epochs[a.chain].approval_epoch })),
      epochs: (['solana', 'ethereum'] as const).map((chain) => ({ chain, ...this.epochs[chain] })),
    };
  }

  private rebalance(): RebalanceResponse {
    const now = this.now();
    const global = getPath(this.parsed, 'rebalance.mode');
    const mode = global === 'auto' || global === 'approve' ? global : 'alert';
    const balances: Record<string, string> = {
      xmr: this.inventory.xmr.balance,
      ...Object.fromEntries(this.inventory.paying.map((p) => [p.asset, p.balance])),
    };
    const decimals = { xmr: 12, sol: 9, eth: 18, usdc_sol: 6, usdc_eth: 6 } as const;
    const level = (asset: keyof typeof decimals, key: string): string | null => {
      const v = getPath(this.parsed, `rebalance.levels.${asset}.${key}`);
      return typeof v === 'number' ? (BigInt(Math.round(v * 1e6)) * 10n ** BigInt(decimals[asset] - 6)).toString() : null;
    };
    // A failed refill keeps counting until the maker acknowledges it.
    const inTransit = this.refills.filter((r) => ['pending', 'depositing', 'processing', 'paying_out', 'held'].includes(r.state) || (r.state === 'failed' && !this.acknowledged.has(r.id)));
    const cap = getPath(this.parsed, 'rebalance.max_in_transit_usd');
    return {
      mode,
      levels: (Object.keys(decimals) as (keyof typeof decimals)[]).map((asset) => ({
        asset,
        balance: balances[asset] ?? '0',
        low: level(asset, 'low'),
        target: level(asset, 'target'),
        high: level(asset, 'high'),
      })),
      venues: VENUES.map((id) => {
        const v = getPath(this.parsed, `rebalance.venues.${id}`);
        const t = isTable(v) ? v : {};
        const enabled = t.enabled === true;
        const venueMode = t.mode === 'auto' || t.mode === 'approve' || t.mode === 'alert' ? t.mode : mode;
        const unnamed = id === 'exchange' && enabled && (typeof t.name !== 'string' || /^<.*>$/.test(t.name));
        const cooling = id === 'fixedfloat' && enabled && this.refills.some((r) => r.venue === 'fixedfloat' && r.state === 'held');
        return {
          id,
          enabled,
          mode: venueMode,
          healthy: enabled && !unnamed && !cooling,
          reason: !enabled ? null : unnamed ? 'The exchange is not named yet' : cooling ? 'An order is held in its emergency state' : null,
          cooldown_until: cooling ? now + 14 * 60 : null,
        };
      }),
      in_transit_usd: inTransit.reduce((sum, r) => sum + usdValue(r), 0),
      max_in_transit_usd: typeof cap === 'number' ? cap : null,
      refills: [...this.refills].sort((a, b) => b.started_at - a.started_at).map((r) => this.refillView(r)),
    };
  }
  private refillView(r: RefillView): RefillView {
    const acknowledged = r.state === 'failed' && this.acknowledged.has(r.id);
    return { ...r, ...({ needs_acknowledgement: r.state === 'held' || (r.state === 'failed' && !acknowledged), acknowledged } as object) };
  }
  private findRefill(id: string): RefillView {
    return this.refills.find((r) => r.id === id) ?? fail(404, 'unknown_refill', `No refill ${id}.`);
  }

  private keysResponse(): KeysResponse {
    const interval = getPath(this.parsed, 'rotation.interval_hours');
    const grace = getPath(this.parsed, 'rotation.grace_hours');
    const hours = typeof interval === 'number' ? interval : 0;
    return {
      keys: this.keys,
      rotation_interval_hours: hours,
      grace_hours: typeof grace === 'number' ? grace : 24,
      next_rotation_at: hours > 0 ? this.lastRotationAt + hours * 3_600 : null,
    };
  }

  private stats(): StatsResponse {
    return {
      since: this.startedAt - 24 * 86_400,
      fills: 214,
      volume: [
        { market: 'usdc_sol', xmr: xmr(1_840.5), asset: '758340120000' },
        { market: 'sol', xmr: xmr(612), asset: sol(1_371.4) },
        { market: 'usdc_eth', xmr: xmr(205), asset: '84530000000' },
      ],
      spread_earned_usd: 16_482.37,
      counters: [
        { chain: 'solana', values: { locks: 231, approvals: 64, rejections: 5, approval_timeouts: 1, completed: 196, missed_notices: 1, missed_claims: 0, aborts_late: 2, withholds: 3, releases: 2, deposits_returned: 11 } },
        { chain: 'ethereum', values: { locks: 22, approvals: 21, rejections: 1, completed: 18, missed_notices: 0, missed_claims: 0, withholds: 0 } },
      ],
      rates: { approval: 0.934, mean_response_secs: 11.4, abort: 0.012, withhold: 0.014, unreleased: 0.005 },
      missed_deadlines: 1,
      uptime_pct: 99.82,
    };
  }
  private fees(): FeesResponse {
    const o = this.offers();
    const spent = BigInt(o.spent_24h_lamports) + 15_000n + 5_000n + 3_200_000n;
    const alertDays = getPath(this.parsed, 'alerts.fee_runway_days');
    return {
      estimate: o.update_cost,
      spent_24h: [
        { asset: 'sol', amount: spent.toString(), usd: this.solUsd === null ? null : (Number(spent) / 1e9) * this.solUsd },
        { asset: 'eth', amount: '412000000000000', usd: 0.000412 * REFERENCE_USD.eth },
      ],
      operator_balances: [
        { chain: 'solana', asset: 'sol', balance: this.operatorLamports.toString() },
        { chain: 'ethereum', asset: 'eth', balance: '310000000000000000' },
      ],
      runway_days: o.runway_days,
      runway_alert_days: typeof alertDays === 'number' ? alertDays : 7,
      ...({ sol_usd: this.solUsd, compute_units_per_update: REFRESH_CU } as object),
    };
  }

  /** Test seam: a refill fails at its venue. */
  failRefill(id: string, detail: string): void {
    const r = this.findRefill(id);
    r.state = 'failed';
    r.finished_at = this.now();
    r.detail = detail;
    this.push('rebalance');
  }
  /** Test seam: set the fee wallet's SOL balance. */
  setOperatorLamports(v: bigint): void {
    this.operatorLamports = v;
  }
  /** Test seam: deliver a taker message, as the inbox module would. */
  receiveMessage(item: Omit<InboxItem, 'id' | 'at' | 'direction' | 'read' | 'in_reply_to'>): InboxItem {
    const msg: InboxItem = { ...item, id: this.nextId('msg'), at: this.now(), direction: 'in', read: false, in_reply_to: null };
    this.inbox.push(msg);
    const s = this.swaps.find((x) => x.ref === item.swap_ref);
    if (s) s.messages.push(msg);
    this.push('inbox');
    return msg;
  }

  private registrationTx(a: RegistrationAction): RegistrationTxResponse {
    if (!isTable(a) || (a.chain !== 'solana' && a.chain !== 'ethereum') || typeof a.action !== 'string') fail(400, 'bad_request', 'chain and action are required.');
    const reg = this.registration;
    if (a.action === 'register_maker') {
      if (a.chain === 'ethereum' && !reg.solana.registered) fail(409, 'solana_first', 'Register on Solana first: every maker registers there, including Ethereum-only makers.');
      if ((a.chain === 'solana' ? reg.solana : reg.ethereum).registered) fail(409, 'already_registered', `Already registered on ${a.chain}.`);
    } else if (!(a.chain === 'solana' ? reg.solana : reg.ethereum).registered) fail(409, 'not_registered', `Not registered on ${a.chain} yet.`);
    const request_id = this.nextId('reg');
    this.registrationRequests.set(request_id, a);
    const summary = describeAction(a);
    if (a.chain === 'solana') {
      // A legacy message whose header says one signature is required; the body is filler.
      const message = new Uint8Array(96);
      message[0] = 1;
      for (let i = 3; i < message.length; i++) message[i] = (i * 31 + request_id.length) & 0xff;
      return {
        request_id,
        unsigned: { chain: 'solana', message_b64: toBase64(message), recent_blockhash: fakeSol(`blockhash:${request_id}`), fee_payer: reg.solana.owner ?? ('owner' in a ? a.owner : ADDR.solOwner) },
        summary,
      };
    }
    return { request_id, unsigned: { chain: 'ethereum', chain_id: 1, to: ADDR.contract, data: `0x${fakeHex(`calldata:${request_id}`, 68)}`, value: '0' }, summary };
  }
  private registrationSubmit(body: unknown): TxResult {
    if (!isTable(body) || typeof body.request_id !== 'string' || typeof body.signed !== 'string') return fail(400, 'bad_request', 'request_id and signed are required.');
    const owed = this.owedRequests.get(body.request_id);
    if (owed !== undefined) {
      const sw = this.findSwap(owed);
      const good = sw.chain === 'solana' ? /^[A-Za-z0-9+/]{80,}={0,2}$/.test(body.signed) : /^0x[0-9a-fA-F]{20,}$/.test(body.signed);
      if (!good) return fail(400, 'bad_signature', sw.chain === 'solana' ? 'Expected a signed Solana transaction in base64.' : 'Expected a signed raw Ethereum transaction as 0x-hex.');
      this.owedRequests.delete(body.request_id);
      this.parked.delete(owed);
      return this.tx(sw.chain, 'withdraw_owed');
    }
    const a = this.registrationRequests.get(body.request_id);
    if (!a) return fail(404, 'unknown_request', 'No unsigned transaction with that request id; build it again.');
    const okShape = a.chain === 'solana' ? /^[A-Za-z0-9+/]{80,}={0,2}$/.test(body.signed) : /^0x[0-9a-fA-F]{20,}$/.test(body.signed);
    if (!okShape) return fail(400, 'bad_signature', a.chain === 'solana' ? 'Expected a signed Solana transaction in base64.' : 'Expected a signed raw Ethereum transaction as 0x-hex.');
    this.registrationRequests.delete(body.request_id);
    const now = this.now();
    const reg = this.registration;
    const delay = CHAIN_CONSTS[a.chain].linkDelaySecs;
    const setLink = (side: 'solana' | 'ethereum', target: string): void => {
      const link = reg[side].link;
      const next = target === '' ? null : target;
      if (next !== link.current) {
        // A change made while another is still pending replaces it: that one never takes effect.
        for (const e of this.linkLog) if (e.chain === side && e.effective_at > now) e.superseded = true;
        this.linkLog.unshift(linkEntry(side, link.current, next, link.current === null && link.pending === null ? now : now + delay));
      }
      if (link.current === null && link.pending === null) link.current = next; // the first link is immediate
      else if (next === link.current) {
        link.pending = null;
        link.pending_effective_at = null;
      } else {
        // A change or removal is a recorded event with a delay.
        link.pending = next ?? '';
        link.pending_effective_at = now + delay;
      }
    };
    switch (a.action) {
      case 'register_maker':
        if (a.chain === 'solana') Object.assign(reg.solana, { registered: true, maker: ADDR.solMaker, owner: a.owner, operator: a.operator, payout: a.payout, payout_usdc_account: true, enc_key_version: 1, inbox_policy: 'open' });
        else {
          Object.assign(reg.ethereum, { registered: true, maker: a.owner, operator: a.operator, payout: a.payout, quote_epoch: 0, approval_epoch: 0 });
          reg.ethereum.link.current = a.solana_owner;
        }
        break;
      case 'set_operator':
        reg[a.chain].operator = a.operator;
        break;
      case 'set_payout':
        reg[a.chain].payout = a.payout;
        break;
      case 'set_eth_link':
        setLink('solana', a.eth_address);
        break;
      case 'set_solana_link':
        setLink('ethereum', a.solana_owner);
        break;
      case 'set_paused':
        this.ownerPaused[a.chain] = a.paused;
        this.paused.owner = this.ownerPaused.solana || this.ownerPaused.ethereum;
        break;
    }
    this.refreshMutual();
    this.push('status', 'offers');
    return this.tx(a.chain, a.action);
  }
  private refreshMutual(): void {
    const { solana: s, ethereum: e } = this.registration;
    const mutual = s.registered && e.registered && s.link.current !== null && s.link.current === e.maker && e.link.current !== null && e.link.current === s.owner;
    s.link.mutual = mutual;
    e.link.mutual = mutual;
  }
  /** Test seam: let a pending link change take effect, as the chain would after the delay. */
  settleLinks(): void {
    const now = this.now();
    for (const side of ['solana', 'ethereum'] as const) {
      const link = this.registration[side].link;
      if (link.pending !== null && link.pending_effective_at !== null && link.pending_effective_at <= now) {
        link.current = link.pending === '' ? null : link.pending;
        link.pending = null;
        link.pending_effective_at = null;
      }
    }
    this.refreshMutual();
  }
  /** Test seam: replace the registration record. */
  setRegistration(mutate: (r: RegistrationResponse) => void): void {
    mutate(this.registration);
    this.refreshMutual();
  }

  // ---------------------------------------------------------------- routes

  private defineRoutes(): void {
    this.route('status', () => this.status());

    this.route('configGet', () => this.configResponse());
    this.route('configPut', ({ body }) => {
      if (!isTable(body) || typeof body.toml !== 'string' || typeof body.base_revision !== 'string') return fail(400, 'bad_request', 'toml and base_revision are required.');
      if (body.base_revision !== revisionOf(this.toml)) return fail(409, 'revision_conflict', 'The configuration changed since you loaded it. Reload, then apply your edit again.');
      return this.applyConfig(body.toml, 'api');
    });
    this.route('configValidate', ({ body }) => ({ ...this.validation(this.parseOr400(isTable(body) ? body.toml : undefined)), sol_usd: this.solUsd, compute_units_per_update: REFRESH_CU }));
    this.route('configLog', () => ({ entries: [...this.log].reverse() }));
    this.route('configExport', () => ({ toml: this.toml, exported_at: this.now() }));
    this.route('configImport', ({ body }) => {
      if (!isTable(body) || typeof body.toml !== 'string') return fail(400, 'bad_request', 'toml is required.');
      return this.applyConfig(body.toml, 'import');
    });

    this.route('registration', () => {
      this.settleLinks();
      return this.registration;
    });
    this.route('registrationTx', ({ body }) => this.registrationTx(body as RegistrationAction));
    this.route('registrationSubmit', ({ body }) => this.registrationSubmit(body));

    // Additions to the frozen API (the daemon's "Console contract" A5).
    this.routeAt('registrationPublished', 'PUT', '/api/registration/published', ({ body }) => {
      const b = isTable(body) ? body : {};
      // Refused in dry run before anything is stored (A13).
      this.requireLive('the registry update');
      if (b.contacts !== undefined) {
        const c = b.contacts;
        const ok = Array.isArray(c) && c.length <= 6 && c.every((x) => isTable(x) && Number.isInteger(x.kind) && (x.kind as number) >= 0 && (x.kind as number) <= 255 && typeof x.value === 'string' && new TextEncoder().encode(x.value).length <= 96);
        if (!ok) return fail(400, 'bad_request', 'contacts: at most 6 entries of { kind, value }, each value at most 96 bytes.');
        this.desired.contacts = (c as { kind: number; value: string }[]).map((x) => ({ kind: x.kind, value: x.value }));
      }
      if (b.onion !== undefined) {
        const o = b.onion;
        if (o !== null && (typeof o !== 'string' || !/^[a-z2-7]{56}\.onion$/.test(o))) return fail(400, 'bad_request', 'onion: a v3 onion host (56 base32 characters + .onion), or null to follow the Tor hostname file.');
        this.desired.onion = o as string | null;
      }
      const reg = this.registration.solana;
      const changed = JSON.stringify(reg.contacts) !== JSON.stringify(this.desired.contacts ?? reg.contacts) || (this.desired.onion !== undefined && this.desired.onion !== reg.onion);
      if (this.desired.contacts) reg.contacts = this.desired.contacts;
      if (this.desired.onion !== undefined) reg.onion = this.desired.onion;
      this.registration.blob_endpoint = reg.onion !== null || reg.contacts.some((c) => c.kind === 5);
      this.push('status', 'offers');
      return { tx: changed ? { ...this.tx('solana', 'set_contacts'), status: 'sent' } : null, registration: this.registration };
    });
    this.routeAt('registrationLinks', 'GET', '/api/registration/links', () => ({ entries: [...this.linkLog].sort((x, y) => y.effective_at - x.effective_at) }));
    this.routeAt('alertAck', 'POST', '/api/alerts/:id/ack', ({ params }) => {
      const a = this.alerts.find((x) => x.id === params.id) ?? fail(404, 'unknown_alert', 'No such alert.');
      a.acknowledged = true;
      this.push('alerts', 'status');
      return a;
    });
    this.routeAt('rebalanceAck', 'POST', '/api/rebalance/ack/:id', ({ params, body }) => {
      const r = this.findRefill(params.id ?? '');
      const choice = isTable(body) && (body.choice === 'continue' || body.choice === 'refund') ? body.choice : undefined;
      if (r.state === 'held' && choice) {
        r.state = choice === 'continue' ? 'processing' : 'refunded';
        r.detail = choice === 'continue' ? 'Continued at the venue’s new rate.' : 'Refunded by the venue, minus its network fee.';
        if (choice === 'refund') r.finished_at = this.now();
      } else if (r.state === 'held') {
        r.state = 'failed';
        r.finished_at = this.now();
        r.detail = `${r.detail ? `${r.detail}; ` : ''}closed by the maker`;
        this.acknowledged.add(r.id);
      } else if (r.state === 'failed') this.acknowledged.add(r.id);
      else return fail(409, 'refill_refused', `refill ${r.id} is neither held nor failed`);
      this.push('rebalance');
      return this.refillView(r);
    });

    this.route('offers', () => this.offers());
    this.route('offersPreview', ({ body }) => {
      const cfg = this.parseOr400(isTable(body) ? body.toml : undefined);
      const pv = this.validation(cfg);
      if (!pv.ok) return fail(422, 'invalid_config', pv.errors[0] ? `${pv.errors[0].path}: ${pv.errors[0].message}` : 'The configuration has errors.', { issues: pv.errors, warnings: pv.warnings });
      const out = this.offers(cfg);
      // A preview is never live.
      return { ...out, offers: out.offers.map((o) => ({ ...o, live: false, seq_or_quote_id: null, updated_at: null, valid_until: null })) };
    });

    this.route('swaps', ({ query }) => {
      let list = [...this.swaps].sort((a, b) => b.opened_at - a.opened_at);
      const state = query.get('state');
      const chain = query.get('chain');
      const open = query.get('open');
      const before = query.get('before');
      if (state) list = list.filter((s) => s.state === state);
      if (chain) list = list.filter((s) => s.chain === chain);
      if (open !== null) list = list.filter((s) => OPEN_STATES.has(s.state) === (open === 'true'));
      if (before) list = list.filter((s) => s.opened_at < Number(before));
      const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 100) || 100));
      const page = list.slice(0, limit);
      const last = page[page.length - 1];
      return { swaps: page.map((x) => summary(this.view(x))), next_before: list.length > limit && last ? last.opened_at : null };
    });
    this.route('swap', ({ params }) => this.view(this.findSwap(params.ref ?? '')));
    // A14: the unsigned transaction that withdraws a payout parked for this swap.
    this.routeAt('withdrawOwedTx', 'POST', '/api/swaps/:ref/withdraw-owed-tx', ({ params }) => {
      const sw = this.findSwap(params.ref ?? '');
      const who = this.parked.get(sw.ref);
      if (who === undefined) return fail(409, 'nothing_owed', 'Nothing is parked for this swap.');
      const request_id = this.nextId('owed');
      this.owedRequests.set(request_id, sw.ref);
      const summaryText = `Withdraw the payout parked for this swap to ${who}. It was parked because the payout address could not receive it when the swap settled.`;
      if (sw.chain === 'solana') {
        const message = new Uint8Array(96);
        message[0] = 1;
        for (let i = 3; i < message.length; i++) message[i] = (i * 17 + request_id.length) & 0xff;
        return { request_id, unsigned: { chain: 'solana', message_b64: toBase64(message), recent_blockhash: fakeSol(`blockhash:${request_id}`), fee_payer: this.registration.solana.owner ?? ADDR.solOwner }, summary: summaryText };
      }
      return { request_id, unsigned: { chain: 'ethereum', chain_id: 1, to: ADDR.contract, data: `0x${fakeHex(`calldata:${request_id}`, 36)}`, value: '0' }, summary: summaryText };
    });
    const action = (name: RouteName, a: SwapAction): void => this.route(name, ({ params, body }) => this.swapAction(params.ref ?? '', a, body));
    action('swapApprove', 'approve');
    action('swapReject', 'reject');
    action('swapAbort', 'abort');
    action('swapWithhold', 'withhold');
    action('swapRelease', 'release');
    action('swapPublishEvidence', 'publish-evidence');

    this.route('inventory', () => this.inventory);
    this.route('inventorySplit', ({ body }) => {
      this.requireLive('the split');
      const ladder = isTable(body) && Array.isArray(body.ladder) ? body.ladder : null;
      let created = 0;
      if (ladder) {
        for (const row of ladder) {
          if (!isTable(row) || typeof row.size_xmr !== 'string' || typeof row.count !== 'number' || !/^\d+$/.test(row.size_xmr)) return fail(400, 'bad_request', 'ladder rows need size_xmr (piconero string) and count.');
          created += row.count;
        }
      } else created = this.inventory.ladder.reduce((n, l) => n + Math.max(0, l.target_count - l.unlocked_count - l.locked_count), 0);
      if (created === 0) return { txids: [], created: 0 };
      if (created > 15) created = 15; // at most 15 ladder outputs per transaction
      const first = this.inventory.ladder[0];
      if (first) first.locked_count += created;
      return { txids: [fakeHex(`split:${this.seq++}`, 32)], created };
    });

    this.route('approvals', () => this.approvals());
    this.route('approvalsAdvance', ({ body }) => {
      const b = body as AdvanceApprovalRequest;
      if (!isTable(body) || (b.chain !== 'solana' && b.chain !== 'ethereum') || typeof b.taker !== 'string' || b.taker === '' || typeof b.max_xmr !== 'string' || !/^\d+$/.test(b.max_xmr) || typeof b.days !== 'number' || !(b.days > 0))
        return fail(400, 'bad_request', 'chain, taker, max_xmr (piconero) and days are required.');
      if (b.max_xmr === '0') return fail(400, 'bad_request', 'The size limit must be more than 0.');
      const now = this.now();
      const record: AdvanceApprovalRecord = {
        chain: b.chain,
        id: b.chain === 'solana' ? String(this.seq++) : `0x${fakeHex(`approval:${this.seq++}`, 32)}`,
        taker: b.taker,
        market: b.market ?? null,
        direction: b.direction ?? null,
        max_xmr: b.max_xmr,
        not_before: now,
        expires_at: now + Math.round(b.days * 86_400),
        epoch: this.epochs[b.chain].approval_epoch,
        active: true,
      };
      this.advance.unshift(record);
      return { record, sig: toBase64(new Uint8Array(64).map((_, i) => (i * 7 + this.seq) & 0xff)) };
    });
    this.route('approvalsRevoke', ({ body }) => {
      const b = body as ApprovalRevokeRequest;
      if (!isTable(body) || (b.chain !== 'solana' && b.chain !== 'ethereum')) return fail(400, 'bad_request', 'chain is required.');
      this.requireLive('the revocation');
      if ('all' in b && b.all === true) {
        this.epochs[b.chain].approval_epoch += 1;
        return { txs: [this.tx(b.chain, 'bump_epoch')] };
      }
      if (b.chain !== 'ethereum' || !('id' in b)) return fail(400, 'bad_request', 'A single approval can be revoked only on Ethereum; on Solana bump the epoch.');
      const rec = this.advance.find((a) => a.chain === 'ethereum' && a.id === b.id);
      if (!rec) return fail(404, 'unknown_approval', 'No such approval.');
      rec.active = false;
      return { txs: [this.tx('ethereum', 'revoke')] };
    });

    this.route('deposits', () => ({ deposits: this.deposits }));

    this.route('inbox', () => ({ items: [...this.inbox].sort((a, b) => b.at - a.at), unread: this.inbox.filter((m) => m.direction === 'in' && !m.read).length }));
    this.route('inboxReply', ({ params, body }) => {
      const to = this.inbox.find((m) => m.id === params.id) ?? fail(404, 'unknown_message', 'No such message.');
      const text = isTable(body) && typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '') return fail(400, 'bad_request', 'The reply is empty.');
      if (text.length > 2_000) return fail(400, 'too_long', 'A message holds at most 2,000 characters.');
      const reply: InboxItem = { id: this.nextId('msg'), at: this.now(), direction: 'out', transport: to.transport, type: 'inbox_reply', swap_ref: to.swap_ref, peer: to.peer, text, action: null, read: true, in_reply_to: to.id };
      this.inbox.push(reply);
      to.read = true;
      const s = this.swaps.find((x) => x.ref === to.swap_ref);
      if (s) s.messages.push(reply);
      this.push('inbox');
      return reply;
    });
    this.route('inboxRead', ({ params }) => {
      const m = this.inbox.find((x) => x.id === params.id) ?? fail(404, 'unknown_message', 'No such message.');
      m.read = true;
      this.push('inbox');
      return m;
    });

    this.route('rebalance', () => this.rebalance());
    this.route('rebalanceRun', ({ body }) => {
      const b = body as RebalanceRunRequest;
      if (!isTable(body) || typeof b.from !== 'string' || typeof b.to !== 'string' || b.from === b.to) return fail(400, 'bad_request', 'from and to must be two different assets.');
      if ((b.amount_in === undefined) === (b.amount_out === undefined)) return fail(400, 'bad_request', 'Give exactly one of amount_in and amount_out.');
      const state = this.rebalance();
      const venues = state.venues.filter((v) => v.enabled && v.healthy);
      const venue = b.venue ? venues.find((v) => v.id === b.venue) : venues[0];
      if (!venue) return fail(409, 'refill_refused', b.venue ? `${b.venue} is not enabled or not healthy.` : 'No enabled venue can take this refill.');
      const refill: RefillView = {
        id: this.nextId('refill'),
        venue: venue.id as VenueId,
        from: b.from,
        to: b.to,
        amount_in: b.amount_in ?? '0',
        amount_out: b.amount_out ?? null,
        cost_pct: 0.9,
        fees_usd: null,
        state: venue.mode === 'auto' ? 'pending' : 'awaiting_approval',
        started_at: this.now(),
        finished_at: null,
        venue_order_id: null,
        txids: [],
        detail: venue.mode === 'alert' ? 'Manual run in alert-only mode: waits for your approval.' : 'Manual run.',
      };
      if (refill.state === 'pending') this.checkTransitCap(refill, state);
      this.refills.push(refill);
      this.push('rebalance');
      return this.refillView(refill);
    });
    this.route('rebalanceApprove', ({ params }) => {
      const r = this.findRefill(params.id ?? '');
      if (r.state !== 'awaiting_approval') return fail(409, 'refill_refused', `refill ${r.id} is not awaiting approval (${r.state})`);
      this.requireLive('the refill');
      this.checkTransitCap(r, this.rebalance());
      r.state = 'pending';
      this.push('rebalance');
      return this.refillView(r);
    });
    this.route('rebalanceCancel', ({ params }) => {
      const r = this.findRefill(params.id ?? '');
      if (r.state !== 'awaiting_approval' && r.state !== 'pending') return fail(409, 'refill_refused', `refill ${r.id} is ${r.state} and can no longer be cancelled`);
      r.state = 'cancelled';
      r.finished_at = this.now();
      this.push('rebalance');
      return this.refillView(r);
    });
    this.route('rebalanceManual', ({ body }) => {
      const b = body as RebalanceManualRequest;
      const amt = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v) && v !== '0';
      if (!isTable(body) || typeof b.from !== 'string' || typeof b.to !== 'string' || b.from === b.to || !amt(b.amount_in) || !amt(b.amount_out)) return fail(400, 'bad_request', 'from, to, amount_in and amount_out are required.');
      const now = this.now();
      const r: RefillView = { id: this.nextId('refill'), venue: 'manual', from: b.from, to: b.to, amount_in: b.amount_in, amount_out: b.amount_out, cost_pct: null, fees_usd: null, state: 'done', started_at: now, finished_at: now, venue_order_id: null, txids: [], detail: b.note ?? null };
      this.refills.push(r);
      this.push('rebalance');
      return this.refillView(r);
    });

    this.route('keys', () => this.keysResponse());
    this.route('keysRotate', () => {
      this.requireLive('the key rotation');
      const now = this.now();
      const grace = this.keysResponse().grace_hours;
      const current = this.keys.find((k) => k.current);
      const version = (current?.version ?? 0) + 1;
      if (current) {
        current.current = false;
        current.expires_at = now + Math.round(grace * 3_600);
      }
      this.keys.unshift({ version, public_key: fakeHex(`enc-${version}`, 32), current: true, expires_at: null, open_swaps: 0, deleted_at: null });
      this.registration.solana.enc_key_version = version;
      this.lastRotationAt = now;
      return { version, tx: this.tx('solana', 'rotate_enc_key') };
    });

    this.route('stats', () => this.stats());
    this.route('fees', () => this.fees());

    this.route('pause', ({ body }) => {
      this.paused.operator = true;
      const txs = this.dryRun ? [] : [this.tx('solana', 'set_paused'), this.tx('ethereum', 'set_paused')];
      if (isTable(body) && body.bump_epochs === true && !this.dryRun) {
        for (const chain of ['solana', 'ethereum'] as const) {
          this.epochs[chain].approval_epoch += 1;
          this.epochs[chain].quote_epoch += 1;
          txs.push(this.tx(chain, 'bump_epochs'));
        }
      }
      this.push('status', 'offers');
      return { paused: true, txs };
    });
    this.route('resume', () => {
      this.paused.operator = false;
      const txs = this.dryRun ? [] : [this.tx('solana', 'set_paused'), this.tx('ethereum', 'set_paused')];
      this.push('status', 'offers');
      return { paused: this.paused.owner, txs };
    });
  }

  private checkTransitCap(r: RefillView, state: RebalanceResponse): void {
    if (state.max_in_transit_usd === null) return;
    const after = state.in_transit_usd + usdValue(r);
    if (after > state.max_in_transit_usd)
      fail(409, 'refill_refused', `This refill would put $${Math.round(after).toLocaleString('en-US')} in transit, above the cap of $${state.max_in_transit_usd.toLocaleString('en-US')}.`);
  }
}

function linkEntry(chain: ChainName, old: string | null, next: string | null, effective_at: number): { chain: ChainName; old: string; new: string; old_hex: string; new_hex: string; effective_at: number; superseded: boolean } {
  const hex = (v: string | null): string => (v === null || v === '' ? `0x${'00'.repeat(chain === 'solana' ? 20 : 32)}` : linkBytesHex(v));
  return { chain, old: old ?? '', new: next ?? '', old_hex: hex(old), new_hex: hex(next), effective_at, superseded: false };
}

/** A link target as the chain stores it: 20 bytes for an Ethereum address, 32 for a Solana key. */
function linkBytesHex(v: string): string {
  if (/^0x[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
  try {
    return `0x${toHex(base58Decode(v))}`;
  } catch {
    return `0x${[...new TextEncoder().encode(v)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
}

function usdValue(r: RefillView): number {
  const d = { xmr: 12, sol: 9, eth: 18, usdc_sol: 6, usdc_eth: 6 }[r.from];
  const price = r.from === 'xmr' ? REFERENCE_USD.xmr : r.from === 'sol' ? REFERENCE_USD.sol : r.from === 'eth' ? REFERENCE_USD.eth : 1;
  return (Number(BigInt(r.amount_in) / 10n ** BigInt(d - 6)) / 1e6) * price;
}

function summary(s: SwapDetail): SwapSummary {
  const x = s as SwapDetail & { instruction?: unknown };
  return {
    chain: s.chain,
    ref: s.ref,
    market: s.market,
    direction: s.direction,
    state: s.state,
    phase: s.phase,
    taker: s.taker,
    xmr: s.xmr,
    amount: s.amount,
    deposit: s.deposit,
    depth: s.depth,
    opened_at: s.opened_at,
    next_deadline: s.next_deadline,
    outcome: s.outcome,
    needs_review: s.needs_review,
    actions: s.actions,
    // The daemon's additions (A13).
    ...({ mode: s.mode, instruction: x.instruction ?? null } as object),
  };
}

function describeAction(a: RegistrationAction): string {
  const chain = a.chain === 'solana' ? 'Solana' : 'Ethereum';
  switch (a.action) {
    case 'register_maker':
      return `Register this maker on ${chain} with operator ${a.operator} and payout ${a.payout}.`;
    case 'set_operator':
      return `Replace the operator key on ${chain} with ${a.operator}.`;
    case 'set_payout':
      return `Send future ${chain} payouts to ${a.payout}.`;
    case 'set_eth_link':
      return a.eth_address === '' ? 'Remove the link from the Solana record to Ethereum. It takes effect after 7 days and stays on record.' : `Point the Solana record at the Ethereum address ${a.eth_address}. A change takes effect after 7 days and stays on record.`;
    case 'set_solana_link':
      return a.solana_owner === '' ? 'Remove the link from the Ethereum record to Solana. It takes effect after 7 days and stays on record.' : `Point the Ethereum record at the Solana key ${a.solana_owner}. A change takes effect after 7 days and stays on record.`;
    case 'set_paused':
      return `${a.paused ? 'Pause' : 'Resume'} this maker on ${chain} with the owner key.`;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const marketChain = (m: Market): ChainName => MARKET_CHAIN[m];
