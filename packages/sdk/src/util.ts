/** Small byte helpers shared by every module. No cryptography lives here. */

export type Bytes = Uint8Array;

const HEX_RE = /^[0-9a-fA-F]*$/;

/** Lowercase hex without `0x`. */
export function hex(b: Bytes): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Hex (with or without `0x`) to bytes. Throws on odd length or a non-hex character. */
export function unhex(s: string): Bytes {
  const h = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (h.length % 2 !== 0 || !HEX_RE.test(h)) throw new Error('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** `0x`-prefixed lowercase hex, as viem takes it. */
export const hex0x = (b: Bytes): `0x${string}` => `0x${hex(b)}`;

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export const isZero = (b: Bytes): boolean => b.every((x) => x === 0);

/** Little-endian bytes to an unsigned integer. */
export function leToBig(b: Bytes): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}
/** Unsigned integer to `len` little-endian bytes. */
export function bigToLe(n: bigint, len = 32): Bytes {
  const o = new Uint8Array(len);
  let v = n;
  for (let i = 0; i < len; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('integer does not fit');
  return o;
}
/** Big-endian bytes to an unsigned integer. */
export function beToBig(b: Bytes): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}
/** Unsigned integer to `len` big-endian bytes. */
export function bigToBe(n: bigint, len = 32): Bytes {
  return bigToLe(n, len).reverse();
}

export function toBase64(b: Bytes): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
export function fromBase64(s: string): Bytes {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** A typed error with a stable `code`, so callers switch on codes and not on message text. */
export class SdkError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'SdkError';
    this.code = code;
  }
}

/** The `code` of whatever `f` throws (SdkError, CoreError), or `null` when it returns. */
export function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'Error';
  }
}
