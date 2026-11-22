/** React bindings for the daemon client: the client and clock contexts, live state, queries and actions. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChainName } from '@xmrswap/protocol';
import type { InboxItem, StatusResponse, SwapSummary, WsChannel } from '@xmrswap/protocol/daemon-api';
import { ApiFailure, describeError, type CallArgs, type Connection, type DaemonClient, type HttpRoute } from './client.js';
import type { ApiRoutes } from '@xmrswap/protocol/daemon-api';

// ------------------------------------------------------------------ client and clock

const ClientContext = createContext<DaemonClient | null>(null);
export function useClient(): DaemonClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('no daemon client in context');
  return c;
}

/** Unix seconds on this machine. */
export type Clock = () => number;
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);
const ClockContext = createContext<Clock>(systemClock);

/** Local time in seconds, re-rendering once a second. */
export function useNow(): number {
  const clock = useContext(ClockContext);
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), 1_000);
    return () => clearInterval(id);
  }, [clock]);
  return now;
}

// ------------------------------------------------------------------ live state

export interface LiveState {
  connection: Connection;
  status: StatusResponse | null;
  statusError: unknown;
  /** Open swaps, for the navigation counts. */
  swaps: SwapSummary[] | null;
  inbox: InboxItem[] | null;
  /** Bumped whenever the daemon pushes on a channel (or the fallback poll fires). */
  ticks: Readonly<Record<WsChannel, number>>;
  refresh(): void;
}
const ZERO_TICKS: Record<WsChannel, number> = { status: 0, swaps: 0, offers: 0, inbox: 0, rebalance: 0, alerts: 0 };
const LiveContext = createContext<LiveState>({ connection: 'connecting', status: null, statusError: null, swaps: null, inbox: null, ticks: ZERO_TICKS, refresh: () => undefined });
export const useLive = (): LiveState => useContext(LiveContext);

/** Chain time: every deadline is chain time, so countdowns subtract the measured clock skew. */
export function useChainNow(): (chain: ChainName) => number {
  const now = useNow();
  const { status } = useLive();
  return useCallback(
    (chain: ChainName) => {
      const skew = status?.chains.find((c) => c.chain === chain)?.clock_skew_secs ?? 0;
      return now - skew;
    },
    [now, status],
  );
}

/** How often the pages re-read the daemon while the push channel is down. */
export const POLL_MS = 15_000;

export function DaemonProvider({ client, clock = systemClock, onUnauthorized, children }: { client: DaemonClient; clock?: Clock; onUnauthorized?: () => void; children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [swaps, setSwaps] = useState<SwapSummary[] | null>(null);
  const [inbox, setInbox] = useState<InboxItem[] | null>(null);
  const [ticks, setTicks] = useState(ZERO_TICKS);
  const alive = useRef(true);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const loadStatus = useCallback(() => {
    client.call('status').then(
      (s) => {
        if (!alive.current) return;
        setStatus(s);
        setStatusError(null);
      },
      (e: unknown) => {
        if (!alive.current) return;
        setStatusError(e);
        if (e instanceof ApiFailure && e.unauthorized) unauthorized.current?.();
      },
    );
  }, [client]);
  const loadSwaps = useCallback(() => {
    client.call('swaps', { body: { open: true, limit: 500 } }).then(
      (r) => alive.current && setSwaps(r.swaps),
      () => undefined,
    );
  }, [client]);
  const loadInbox = useCallback(() => {
    client.call('inbox').then(
      (r) => alive.current && setInbox(r.items),
      () => undefined,
    );
  }, [client]);
  const refresh = useCallback(() => {
    loadStatus();
    loadSwaps();
    loadInbox();
  }, [loadStatus, loadSwaps, loadInbox]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const stop = client.live({
      onConnection: (c) => alive.current && setConnection(c),
      onData: (channel, data, op) => {
        if (!alive.current) return;
        if (channel === 'status') {
          setStatus(data as StatusResponse);
          setStatusError(null);
        }
        // Pushes carry only what changed, so lists are re-read over HTTP.
        if (op === 'update') {
          if (channel === 'swaps') loadSwaps();
          if (channel === 'inbox') loadInbox();
          setTicks((t) => ({ ...t, [channel]: t[channel] + 1 }));
        }
      },
    });
    return () => {
      alive.current = false;
      stop();
    };
  }, [client, refresh, loadSwaps, loadInbox]);

  // Without the push channel, fall back to polling.
  useEffect(() => {
    if (connection === 'live') return;
    const id = setInterval(() => {
      refresh();
      setTicks((t) => ({ status: t.status + 1, swaps: t.swaps + 1, offers: t.offers + 1, inbox: t.inbox + 1, rebalance: t.rebalance + 1, alerts: t.alerts + 1 }));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [connection, refresh]);

  const live = useMemo<LiveState>(() => ({ connection, status, statusError, swaps, inbox, ticks, refresh }), [connection, status, statusError, swaps, inbox, ticks, refresh]);
  return (
    <ClientContext.Provider value={client}>
      <ClockContext.Provider value={clock}>
        <LiveContext.Provider value={live}>
          <ToastProvider>{children}</ToastProvider>
        </LiveContext.Provider>
      </ClockContext.Provider>
    </ClientContext.Provider>
  );
}

// ------------------------------------------------------------------ queries

export interface Query<T> {
  data: T | undefined;
  error: unknown;
  /** True until the first answer (or first error) arrives. */
  loading: boolean;
  reload(): void;
}

/** Read a route. Re-reads when its arguments change, when the daemon pushes on one of `channels`, and on `reload()`. */
export function useQuery<N extends HttpRoute>(name: N, args?: CallArgs<N>, channels: readonly WsChannel[] = []): Query<ApiRoutes[N]['response']> {
  const client = useClient();
  const { ticks } = useLive();
  const [state, setState] = useState<{ data: ApiRoutes[N]['response'] | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(args ?? null);
  const tick = channels.reduce((n, c) => n + ticks[c], 0);
  const argsRef = useRef(args);
  argsRef.current = args;
  useEffect(() => {
    let live = true;
    client.call(name, argsRef.current).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: unknown) => live && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      live = false;
    };
  }, [client, name, key, nonce, tick]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

// ------------------------------------------------------------------ toasts and actions

export interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}
interface ToastApi {
  toasts: Toast[];
  notify(tone: Toast['tone'], text: string): void;
  dismiss(id: number): void;
}
const ToastContext = createContext<ToastApi>({ toasts: [], notify: () => undefined, dismiss: () => undefined });
export const useToasts = (): ToastApi => useContext(ToastContext);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback(
    (tone: Toast['tone'], text: string) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { id, tone, text }]);
      // Errors stay until dismissed; confirmations clear themselves.
      if (tone !== 'bad') setTimeout(() => dismiss(id), 8_000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ toasts, notify, dismiss }), [toasts, notify, dismiss]);
  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}

/** Run a daemon action with a busy flag, a confirmation and a plain-words error. */
export function useAction(): { busy: string | null; run<T>(key: string, fn: () => Promise<T>, done?: string | ((r: T) => string)): Promise<T | undefined> } {
  const { notify } = useToasts();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, done?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (done) notify('ok', typeof done === 'function' ? done(r) : done);
        return r;
      } catch (e) {
        notify('bad', describeError(e));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );
  return { busy, run };
}
