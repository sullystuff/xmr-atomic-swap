/** Renders the console against the in-process mock daemon: no network, no timers of its own. */
import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { Console } from '../src/App.js';
import { DaemonClient } from '../src/api/client.js';
import { MOCK_TOKEN, MockDaemon, type MockOptions } from '../src/mock/daemon.js';
import { mockFetch, mockSockets, type MockSocketControl } from '../src/mock/transport.js';

export const T0 = 1_795_000_000;

export interface Mounted extends RenderResult {
  daemon: MockDaemon;
  client: DaemonClient;
  sockets: MockSocketControl;
  user: UserEvent;
  /** Move the shared clock (daemon and console) forward. */
  advance(secs: number): void;
  now(): number;
}

export function mount(route = '', opts: MockOptions & { delayMs?: number; offline?: () => boolean; noSocket?: boolean; prepare?: (daemon: MockDaemon) => void } = {}): Mounted {
  let t = T0;
  const clock = (): number => t;
  const daemon = new MockDaemon({ now: clock, ...opts });
  opts.prepare?.(daemon);
  const sockets = mockSockets(daemon);
  if (opts.noSocket) sockets.refuse = true;
  const client = new DaemonClient({
    token: MOCK_TOKEN,
    fetch: mockFetch(daemon, { ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}), ...(opts.offline ? { offline: opts.offline } : {}) }),
    socket: sockets.factory,
    backoffMs: [60_000],
  });
  window.location.hash = route;
  const view = render(<Console client={client} clock={clock} />);
  return { ...view, daemon, client, sockets, user: userEvent.setup(), advance: (s) => (t += s), now: clock };
}

/** Text of the summary tile with this label. */
export const stat = (label: string): string => {
  const el = [...document.querySelectorAll('.stat')].find((s) => s.querySelector('dt')?.textContent === label);
  if (!el) throw new Error(`no tile labelled ${label}`);
  return text(el);
};

/** Text of an element with whitespace collapsed. */
export const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
