// Small shared helpers of the end-to-end harness. Loopback only.
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const e2eRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(e2eRoot, '../..');
/** Everything a run writes (chains, wallets, daemon data, logs, browser profiles) lives here and is removed afterwards. */
export const stateRoot = process.env['E2E_STATE'] ?? path.join(e2eRoot, '.state');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const fill = (n: number): Uint8Array => new Uint8Array(32).fill(n);
export const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const XMR = 1_000_000_000_000n;
export const SOL = 1_000_000_000n;
export const ETH = 10n ** 18n;
export const USDC = 1_000_000n;

export function assertLoopback(url: string): string {
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url)) throw new Error(`e2e endpoints are loopback only, not ${url}`);
  return url;
}

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
  /** What the rest of the world does between two looks (mine a block, tick a maker). */
  between?: () => Promise<unknown>;
  /** Extra context for the failure message. */
  context?: () => Promise<unknown> | unknown;
}

/** Poll until `cond` returns something truthy; never sleeps to reach a deadline (deadlines are reached with `advance`). */
export async function waitFor<T>(what: string, cond: () => Promise<T | null | undefined | false> | T | null | undefined | false, o: WaitOpts = {}): Promise<T> {
  const end = Date.now() + (o.timeoutMs ?? 90_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await cond();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) {
      let ctx = '';
      try {
        ctx = o.context ? `\ncontext: ${JSON.stringify(await o.context(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}` : '';
      } catch {
        // no context
      }
      throw new Error(`timed out waiting for: ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))})${ctx}`);
    }
    if (o.between) await o.between();
    await sleep(o.intervalMs ?? 250);
  }
}

export async function jsonRpc<T = any>(url: string, method: string, params: unknown = [], path = ''): Promise<T> {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code, data: body.error.data });
  return body.result as T;
}

export const big = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
