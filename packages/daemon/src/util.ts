/** Small helpers shared by every module. Nothing here touches a key or a socket. */
import { PICONERO_PER_XMR } from '@xmrswap/protocol';

export type Bytes = Uint8Array;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const nowSecs = (): number => Math.floor(Date.now() / 1000);

/** JSON with bigint (`{"$big":"…"}`) and bytes (`{"$hex":"…"}`), for payload columns. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x instanceof Uint8Array ? { $hex: Buffer.from(x).toString('hex') } : x));
}
export function fromJson<T = unknown>(s: string): T {
  return JSON.parse(s, (_k, x) => {
    if (x && typeof x === 'object') {
      if (typeof (x as { $big?: unknown }).$big === 'string') return BigInt((x as { $big: string }).$big);
      if (typeof (x as { $hex?: unknown }).$hex === 'string') return Uint8Array.from(Buffer.from((x as { $hex: string }).$hex, 'hex'));
    }
    return x;
  }) as T;
}

/** A decimal XMR figure (number or string, as a config file writes it) to piconero, exactly. */
export function xmrToPico(v: number | string): bigint {
  return decimalToUnits(v, 12);
}
export function decimalToUnits(v: number | string, decimals: number): bigint {
  const s = typeof v === 'number' ? (Number.isInteger(v) ? v.toString() : v.toFixed(Math.min(decimals, 12)).replace(/0+$/, '')) : v.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`not a non-negative decimal amount: ${String(v)}`);
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
export const picoToXmr = (p: bigint): number => Number(p) / Number(PICONERO_PER_XMR);
export const unitsToNumber = (u: bigint, decimals: number): number => Number(u) / 10 ** decimals;

export const hex = (b: Bytes): string => Buffer.from(b).toString('hex');
export const unhex = (s: string): Bytes => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));

/** A per-key mutex: calls with the same key run one after another. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** A typed event emitter small enough to read. */
export class Emitter<E extends Record<string, unknown>> {
  private subs: { [K in keyof E]?: ((v: E[K]) => void)[] } = {};
  on<K extends keyof E>(event: K, fn: (v: E[K]) => void): () => void {
    (this.subs[event] ??= []).push(fn);
    return () => void (this.subs[event] = (this.subs[event] ?? []).filter((f) => f !== fn));
  }
  emit<K extends keyof E>(event: K, v: E[K]): void {
    for (const fn of this.subs[event] ?? []) {
      try {
        fn(v);
      } catch {
        // a listener must not break the emitter
      }
    }
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? (('code' in e && typeof (e as { code?: unknown }).code === 'string' ? `${(e as { code: string }).code}: ` : '') + e.message) : String(e));
