/**
 * A small Borsh codec (the encoding of every Solana account, instruction argument and event of
 * the program). No dependencies; runs in Node and browsers.
 *
 * TypeScript mapping: `u8`/`u16`/`u32` are `number`; `u64`/`i64`/`u128` are `bigint`; `bool` is
 * `boolean`; a public key is a base58 `string`; `[u8; N]` and `bytes` are `Uint8Array`; other
 * arrays and vectors are arrays; `Option<T>` is `T | null`.
 */

/** The IDL type a codec implements; lets a test compare every codec with the frozen IDL. */
export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

export interface Codec<T> {
  readonly idl: IdlType;
  /** Encoded size when it does not depend on the value. */
  readonly size: number | null;
  read(r: Reader): T;
  write(w: Writer, value: T): void;
}

export class BorshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BorshError';
  }
}

export class Reader {
  private readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): number {
    if (this.offset + n > this.bytes.length) throw new BorshError(`unexpected end of data at ${this.offset} (+${n})`);
    const at = this.offset;
    this.offset += n;
    return at;
  }
  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.need(8), true);
  }
  i64(): bigint {
    return this.view.getBigInt64(this.need(8), true);
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  fixed(n: number): Uint8Array {
    const at = this.need(n);
    return this.bytes.slice(at, at + n);
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

export class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;
  private grow(n: number): number {
    if (this.length + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.length;
    this.length += n;
    return at;
  }
  u8(v: number): void {
    const x = int(v, 0xff);
    const at = this.grow(1); // grow() may replace the buffer and view: take the offset first
    this.view.setUint8(at, x);
  }
  u16(v: number): void {
    const x = int(v, 0xffff);
    const at = this.grow(2);
    this.view.setUint16(at, x, true);
  }
  u32(v: number): void {
    const x = int(v, 0xffff_ffff);
    const at = this.grow(4);
    this.view.setUint32(at, x, true);
  }
  u64(v: bigint): void {
    if (typeof v !== 'bigint' || v < 0n || v >= 1n << 64n) throw new BorshError(`u64 out of range: ${v}`);
    const at = this.grow(8);
    this.view.setBigUint64(at, v, true);
  }
  i64(v: bigint): void {
    if (typeof v !== 'bigint' || v < -(1n << 63n) || v >= 1n << 63n) throw new BorshError(`i64 out of range: ${v}`);
    const at = this.grow(8);
    this.view.setBigInt64(at, v, true);
  }
  u128(v: bigint): void {
    if (typeof v !== 'bigint' || v < 0n || v >= 1n << 128n) throw new BorshError(`u128 out of range: ${v}`);
    this.u64(v & ((1n << 64n) - 1n));
    this.u64(v >> 64n);
  }
  fixed(b: Uint8Array, n: number): void {
    if (!(b instanceof Uint8Array) || b.length !== n) throw new BorshError(`expected ${n} bytes, got ${b?.length}`);
    // grow() may replace the buffer: take the offset first.
    const at = this.grow(n);
    this.buf.set(b, at);
  }
  raw(b: Uint8Array): void {
    const at = this.grow(b.length);
    this.buf.set(b, at);
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function int(v: number, max: number): number {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new BorshError(`integer out of range: ${v}`);
  return v;
}

// ------------------------------------------------------------------ base58 (public keys)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const d = B58_INDEX.get(c);
    if (d === undefined) throw new BorshError(`invalid base58 character ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(d);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ codecs

export const u8: Codec<number> = { idl: 'u8', size: 1, read: (r) => r.u8(), write: (w, v) => w.u8(v) };
export const u16: Codec<number> = { idl: 'u16', size: 2, read: (r) => r.u16(), write: (w, v) => w.u16(v) };
export const u32: Codec<number> = { idl: 'u32', size: 4, read: (r) => r.u32(), write: (w, v) => w.u32(v) };
export const u64: Codec<bigint> = { idl: 'u64', size: 8, read: (r) => r.u64(), write: (w, v) => w.u64(v) };
export const i64: Codec<bigint> = { idl: 'i64', size: 8, read: (r) => r.i64(), write: (w, v) => w.i64(v) };
export const u128: Codec<bigint> = { idl: 'u128', size: 16, read: (r) => r.u128(), write: (w, v) => w.u128(v) };
export const bool: Codec<boolean> = {
  idl: 'bool',
  size: 1,
  read: (r) => {
    const b = r.u8();
    if (b > 1) throw new BorshError(`invalid bool ${b}`);
    return b === 1;
  },
  write: (w, v) => w.u8(v ? 1 : 0),
};
/** A 32-byte public key as a base58 string. */
export const pubkey: Codec<string> = {
  idl: 'pubkey',
  size: 32,
  read: (r) => base58Encode(r.fixed(32)),
  write: (w, v) => {
    const b = base58Decode(v);
    if (b.length !== 32) throw new BorshError(`public key must decode to 32 bytes: ${v}`);
    w.fixed(b, 32);
  },
};
export const string: Codec<string> = {
  idl: 'string',
  size: null,
  read: (r) => new TextDecoder('utf-8', { fatal: true }).decode(r.fixed(r.u32())),
  write: (w, v) => {
    const b = new TextEncoder().encode(v);
    w.u32(b.length);
    w.raw(b);
  },
};
/** `Vec<u8>`. */
export const bytes: Codec<Uint8Array> = {
  idl: 'bytes',
  size: null,
  read: (r) => r.fixed(r.u32()),
  write: (w, v) => {
    w.u32(v.length);
    w.raw(v);
  },
};
/** `[u8; N]`. */
export function fixedBytes(n: number): Codec<Uint8Array> {
  return { idl: { array: ['u8', n] }, size: n, read: (r) => r.fixed(n), write: (w, v) => w.fixed(v, n) };
}
/** `[T; N]`. */
export function array<T>(item: Codec<T>, n: number): Codec<T[]> {
  return {
    idl: { array: [item.idl, n] },
    size: item.size === null ? null : item.size * n,
    read: (r) => Array.from({ length: n }, () => item.read(r)),
    write: (w, v) => {
      if (!Array.isArray(v) || v.length !== n) throw new BorshError(`expected an array of ${n}`);
      for (const x of v) item.write(w, x);
    },
  };
}
export function vec<T>(item: Codec<T>): Codec<T[]> {
  return {
    idl: { vec: item.idl },
    size: null,
    read: (r) => Array.from({ length: r.u32() }, () => item.read(r)),
    write: (w, v) => {
      w.u32(v.length);
      for (const x of v) item.write(w, x);
    },
  };
}
export function option<T>(item: Codec<T>): Codec<T | null> {
  return {
    idl: { option: item.idl },
    size: null,
    read: (r) => {
      const tag = r.u8();
      if (tag > 1) throw new BorshError(`invalid option tag ${tag}`);
      return tag === 1 ? item.read(r) : null;
    },
    write: (w, v) => {
      if (v === null || v === undefined) w.u8(0);
      else {
        w.u8(1);
        item.write(w, v);
      }
    },
  };
}

export interface StructCodec<T> extends Codec<T> {
  /** IDL name of the struct. */
  readonly name: string;
  /** `[TypeScript field, IDL field, codec]` in encoding order. */
  readonly fields: ReadonlyArray<readonly [string, string, Codec<unknown>]>;
  /** Byte offset of a field from the start of the struct, when every earlier field is fixed-size. */
  offsetOf(field: string): number;
}

/** A struct: fields in order. `fields` is `[tsName, idlName, codec]`. */
export function struct<T>(name: string, fields: ReadonlyArray<readonly [string, string, Codec<any>]>): StructCodec<T> {
  const sizes = fields.map(([, , c]) => c.size);
  const size = sizes.every((s): s is number => s !== null) ? sizes.reduce((a, b) => a + b, 0) : null;
  return {
    idl: { defined: { name } },
    name,
    fields,
    size,
    read: (r) => {
      const out: Record<string, unknown> = {};
      for (const [key, , codec] of fields) out[key] = codec.read(r);
      return out as T;
    },
    write: (w, v) => {
      for (const [key, , codec] of fields) {
        const value = (v as Record<string, unknown>)[key];
        if (value === undefined) throw new BorshError(`${name}.${key} is missing`);
        codec.write(w, value);
      }
    },
    offsetOf: (field) => {
      let at = 0;
      for (const [key, , codec] of fields) {
        if (key === field) return at;
        if (codec.size === null) break;
        at += codec.size;
      }
      throw new BorshError(`${name}.${field} has no fixed offset`);
    },
  };
}

export function encode<T>(codec: Codec<T>, value: T): Uint8Array {
  const w = new Writer();
  codec.write(w, value);
  return w.finish();
}

/** Decode a whole buffer; trailing bytes are an error unless `allowTrailing`. */
export function decode<T>(codec: Codec<T>, data: Uint8Array, allowTrailing = false): T {
  const r = new Reader(data);
  const v = codec.read(r);
  if (!allowTrailing && r.remaining !== 0) throw new BorshError(`${r.remaining} trailing bytes`);
  return v;
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/.test(s)) throw new BorshError('expected lowercase hex');
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}
