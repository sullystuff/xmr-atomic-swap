/** Alerts: stored, pushed to subscribers, and optionally posted to a webhook the maker names by environment variable. */
import type { Alert } from '@xmrswap/protocol/daemon-api';
import type { AlertRow, Store } from '../store/db.js';
import { Emitter } from '../util.js';

export type AlertFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

export const alertView = (r: AlertRow): Alert => ({ id: String(r.id), at: r.at, level: r.level, kind: r.kind, message: r.message, ...(r.swap_ref ? { swap_ref: r.swap_ref } : {}), acknowledged: r.acknowledged === 1 });

export class Alerts {
  readonly events = new Emitter<{ alert: Alert }>();
  /** One alert per (kind, subject) per window, so a failing timer does not flood the log. */
  private last = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly webhook: { url: () => string | undefined; fetch?: AlertFetch } = { url: () => undefined },
  ) {}

  raise(level: Alert['level'], kind: string, message: string, swapRef: string | null = null, dedupeSecs = 300): Alert | null {
    const key = `${kind}:${swapRef ?? ''}:${message}`;
    const t = this.store.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < dedupeSecs) return null;
    this.last.set(key, t);
    const a = alertView(this.store.addAlert(level, kind, message, swapRef));
    this.events.emit('alert', a);
    const url = this.webhook.url();
    if (url) {
      const f = this.webhook.fetch ?? ((u, init) => fetch(u, init));
      // The webhook body carries no secret: kind, level, message and the swap reference only.
      void Promise.resolve()
        .then(() => f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) }))
        .catch(() => undefined);
    }
    return a;
  }
  list(limit = 50): Alert[] {
    return this.store.alerts(limit).map(alertView);
  }
}
