import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { App, Observable } from '../lib/app.js';
import type { EngineState } from '../lib/engine.js';
import { type Safety, chainNow, safetyOf } from '../lib/safety.js';
import type { VaultState } from '../lib/vault.js';

export const AppContext = createContext<App | null>(null);
export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('AppContext is missing');
  return app;
}

export function useObs<T>(o: Observable<T>): T {
  return useSyncExternalStore(o.subscribe, o.get, o.get);
}
export function useEngine(): EngineState {
  const app = useApp();
  return useSyncExternalStore(app.engine.subscribe, app.engine.getState, app.engine.getState);
}
export function useVault(): VaultState {
  const app = useApp();
  return useSyncExternalStore(app.vault.subscribe, app.vault.getState, app.vault.getState);
}
export function useGuard() {
  const app = useApp();
  return useSyncExternalStore(app.guard.subscribe, app.guard.getStatus, app.guard.getStatus);
}
export function useSafety(): Safety {
  const engine = useEngine();
  const vault = useVault();
  return safetyOf(engine, vault.backedUp);
}

/** Re-render once a second (countdowns). Returns the local time in ms. */
export function useTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Chain time for display, extrapolated between polls. `null` until the chain was read once. */
export function useChainNow(chain: 'solana' | 'ethereum'): bigint | null {
  const engine = useEngine();
  const now = useTick();
  return chainNow(engine, chain, now);
}

// ------------------------------------------------------------------ hash router

export interface Route {
  path: string[];
  query: URLSearchParams;
}
const parse = (): Route => {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p = '', q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
};
export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
export const href = (...parts: string[]): string => `#/${parts.map(encodeURIComponent).join('/')}`;
export function navigate(...parts: string[]): void {
  window.location.hash = href(...parts);
}
