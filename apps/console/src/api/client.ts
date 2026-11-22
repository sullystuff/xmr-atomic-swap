/**
 * The console's only way out: the maker's own daemon over its local HTTP and WebSocket API
 * (SPEC 7.8). Typed by the frozen `ApiRoutes`. It never talks to a chain, a price feed or any
 * other host, and it holds no key: the bearer token only authorises this loopback API.
 */
import { ROUTES, WS_CHANNELS, routePath, type Alert, type ApiError, type ApiRoutes, type ConfigIssue, type RegistrationTxResponse, type RouteName, type WsChannel, type WsClientMessage, type WsPayloads, type WsServerMessage } from '@xmrswap/protocol/daemon-api';
import type { ErrorExtras, ExtendedResponses, LinkEntry, PublishedRequest, PublishedResponse, RefillChoice, RefillViewX } from './extensions.js';

export interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<ResponseLike>;
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export class ApiFailure extends Error {
  constructor(
    /** HTTP status; 0 when the daemon could not be reached at all. */
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    /** Every configuration issue behind a refused save, import or preview (the daemon's A3). */
    readonly issues: ConfigIssue[] = [],
    readonly warnings: ConfigIssue[] = [],
  ) {
    super(detail ?? code);
    this.name = 'ApiFailure';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
  get unreachable(): boolean {
    return this.status === 0;
  }
}

/** Plain words for an error, for the UI. */
export function describeError(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.unreachable) return 'The daemon cannot be reached. Check that it is running and that this page is served from the same machine.';
    if (e.unauthorized) return 'The daemon refused the access token.';
    return e.detail ?? `The daemon answered with an error (${e.code}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

type Body<N extends RouteName> = ApiRoutes[N & keyof ApiRoutes]['request'];
type Result<N extends RouteName> = N extends keyof ExtendedResponses ? ExtendedResponses[N] : ApiRoutes[N & keyof ApiRoutes]['response'];
export type HttpRoute = Exclude<RouteName, 'ws'>;
export interface CallArgs<N extends HttpRoute> {
  params?: Record<string, string>;
  /** JSON body, or the query for a GET. */
  body?: Body<N>;
}

export type Connection = 'connecting' | 'live' | 'offline';
export interface LiveHandlers {
  onData<C extends WsChannel>(channel: C, data: WsPayloads[C], op: 'snapshot' | 'update'): void;
  onConnection(state: Connection): void;
}

export interface ClientOptions {
  /** Origin of the daemon API; empty for the origin this page was served from. */
  baseUrl?: string;
  token: string;
  fetch?: FetchLike;
  socket?: SocketFactory;
  /** Reconnect delays in milliseconds. */
  backoffMs?: readonly number[];
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly socketImpl: SocketFactory;
  private readonly backoff: readonly number[];

  constructor(opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.socketImpl = opts.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.backoff = opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000];
  }

  async call<N extends HttpRoute>(name: N, args: CallArgs<N> = {}): Promise<Result<N>> {
    const { method } = ROUTES[name];
    return this.request<Result<N>>(method, routePath(name, args.params ?? {}), args.body);
  }

  // Routes the daemon adds to the frozen API (its "Console contract" A5).

  /** Publish contact channels and the onion address with the operator key. */
  publishRegistration(body: PublishedRequest): Promise<PublishedResponse> {
    return this.request('PUT', '/api/registration/published', body);
  }
  /** The identity link's trace: every recorded change on both chains, newest first. */
  linkHistory(): Promise<{ entries: LinkEntry[] }> {
    return this.request('GET', '/api/registration/links', undefined);
  }
  acknowledgeAlert(id: string): Promise<Alert> {
    return this.request('POST', `/api/alerts/${encodeURIComponent(id)}/ack`, {});
  }
  /** Acknowledge a failed or held refill; `choice` resolves an order the venue holds. */
  acknowledgeRefill(id: string, choice?: RefillChoice): Promise<RefillViewX> {
    return this.request('POST', `/api/rebalance/ack/${encodeURIComponent(id)}`, choice ? { choice } : {});
  }

  /**
   * The unsigned transaction that withdraws a payout parked for this swap (the daemon's A14).
   * Signed like a registration action and relayed through `registrationSubmit`; `409 nothing_owed` when nothing is parked.
   */
  withdrawOwedTx(ref: string): Promise<RegistrationTxResponse> {
    return this.request('POST', `/api/swaps/${encodeURIComponent(ref)}/withdraw-owed-tx`, {});
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    let url = this.baseUrl + path;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (method === 'GET') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) if (v !== undefined && v !== null) q.set(k, String(v));
      const qs = q.toString();
      if (qs) url += `?${qs}`;
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res: ResponseLike;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e) {
      throw new ApiFailure(0, 'unreachable', e instanceof Error ? e.message : null);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiFailure(res.status, 'bad_response', 'The daemon sent something that is not JSON.');
    }
    if (!res.ok) {
      const err = (json ?? {}) as Partial<ApiError> & ErrorExtras;
      throw new ApiFailure(
        res.status,
        typeof err.error === 'string' ? err.error : `http_${res.status}`,
        typeof err.detail === 'string' ? err.detail : null,
        Array.isArray(err.issues) ? err.issues : [],
        Array.isArray(err.warnings) ? err.warnings : [],
      );
    }
    return json as T;
  }

  /** WebSocket address of `/api/ws`. A browser cannot set a header on a WebSocket, so the token rides in the query, which the daemon accepts (its A1). */
  socketUrl(): string {
    const base = this.baseUrl || (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1');
    const u = new URL(ROUTES.ws.path, base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', this.token);
    return u.toString();
  }

  /** Subscribe to every channel, reconnecting with backoff. Returns the function that stops it. */
  live(handlers: LiveHandlers, channels: readonly WsChannel[] = WS_CHANNELS): () => void {
    let stopped = false;
    let socket: SocketLike | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (stopped) return;
      handlers.onConnection(attempt === 0 ? 'connecting' : 'offline');
      let s: SocketLike;
      try {
        s = this.socketImpl(this.socketUrl());
      } catch {
        retry();
        return;
      }
      socket = s;
      const send = (m: WsClientMessage): void => s.send(JSON.stringify(m));
      s.onopen = () => {
        attempt = 0;
        handlers.onConnection('live');
        send({ op: 'subscribe', channels: [...channels] });
      };
      s.onmessage = (ev) => {
        let m: WsServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as WsServerMessage;
        } catch {
          return;
        }
        if (m.op === 'ping') send({ op: 'pong' });
        else if (m.op === 'snapshot' || m.op === 'update') handlers.onData(m.channel, m.data as never, m.op);
      };
      s.onclose = () => {
        if (socket === s) socket = null;
        retry();
      };
      s.onerror = () => undefined;
    };
    const retry = (): void => {
      if (stopped || timer !== null) return;
      handlers.onConnection('offline');
      const delay = this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? 5_000;
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };
    connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      const s = socket;
      socket = null;
      if (s) {
        s.onclose = null;
        s.close();
      }
    };
  }
}
