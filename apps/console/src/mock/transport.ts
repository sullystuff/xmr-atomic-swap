/** In-process transports that put a `MockDaemon` behind the client's fetch and socket seams. No network. */
import type { WsClientMessage } from '@xmrswap/protocol/daemon-api';
import type { FetchLike, SocketFactory, SocketLike } from '../api/client.js';
import type { MockDaemon } from './daemon.js';

export function mockFetch(daemon: MockDaemon, opts: { delayMs?: number; offline?: () => boolean } = {}): FetchLike {
  return async (url, init) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.offline?.()) throw new TypeError('fetch failed');
    const u = new URL(url, 'http://127.0.0.1');
    const res = daemon.handle({
      method: init.method,
      path: u.pathname + u.search,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      authorization: init.headers.Authorization ?? null,
    });
    const text = JSON.stringify(res.body);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => text };
  };
}

export interface MockSocketControl {
  factory: SocketFactory;
  /** Close every open socket from the server side, as a daemon restart would. */
  dropAll(): void;
  /** Refuse new connections while true. */
  refuse: boolean;
  opened: number;
}

export function mockSockets(daemon: MockDaemon): MockSocketControl {
  const open = new Set<SocketLike>();
  const control: MockSocketControl = {
    refuse: false,
    opened: 0,
    dropAll() {
      for (const s of [...open]) s.close();
    },
    factory(url) {
      const token = new URL(url).searchParams.get('token');
      let closed = false;
      let conn: ReturnType<MockDaemon['connect']> | null = null;
      const socket: SocketLike = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data) {
          if (closed || !conn) return;
          conn.receive(JSON.parse(data) as WsClientMessage);
        },
        close() {
          if (closed) return;
          closed = true;
          open.delete(socket);
          conn?.close();
          queueMicrotask(() => socket.onclose?.({}));
        },
      };
      queueMicrotask(() => {
        if (closed) return;
        if (control.refuse || token !== daemon.token) {
          closed = true;
          socket.onerror?.({});
          socket.onclose?.({});
          return;
        }
        control.opened += 1;
        open.add(socket);
        conn = daemon.connect((m) => {
          const text = JSON.stringify(m);
          queueMicrotask(() => {
            if (!closed) socket.onmessage?.({ data: text });
          });
        });
        socket.onopen?.({});
      });
      return socket;
    },
  };
  return control;
}
