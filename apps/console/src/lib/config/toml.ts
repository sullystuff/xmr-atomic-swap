/** The configuration file as text and as a plain object, with immutable path helpers. */
import { parse, stringify, TomlError } from 'smol-toml';

export type Toml = Record<string, unknown>;

export class ConfigSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
    readonly column: number | null,
  ) {
    super(message);
    this.name = 'ConfigSyntaxError';
  }
}

export function parseToml(text: string): Toml {
  try {
    return parse(text) as Toml;
  } catch (e) {
    if (e instanceof TomlError) throw new ConfigSyntaxError(e.message.split('\n')[0] ?? 'invalid TOML', e.line, e.column);
    throw new ConfigSyntaxError(e instanceof Error ? e.message : 'invalid TOML', null, null);
  }
}

export function stringifyToml(value: Toml): string {
  const text = stringify(prune(value) as Toml);
  return text.endsWith('\n') ? text : `${text}\n`;
}

export const isTable = (v: unknown): v is Toml => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** Drop `undefined` values and tables left empty by a removal. */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (!isTable(v)) return v;
  const out: Toml = {};
  for (const [k, child] of Object.entries(v)) {
    if (child === undefined) continue;
    out[k] = prune(child);
  }
  return out;
}

export const splitPath = (path: string): string[] => (path === '' ? [] : path.split('.'));

export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of splitPath(path)) {
    if (!isTable(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Returns a copy of `root` with `path` set; `undefined` removes the key and any table it leaves empty. */
export function setPath(root: Toml, path: string, value: unknown): Toml {
  const keys = splitPath(path);
  const walk = (node: Toml, i: number): Toml => {
    const key = keys[i] as string;
    const copy: Toml = { ...node };
    if (i === keys.length - 1) {
      if (value === undefined) delete copy[key];
      else copy[key] = value;
      return copy;
    }
    const child = isTable(node[key]) ? (node[key] as Toml) : {};
    const next = walk(child, i + 1);
    if (value === undefined && Object.keys(next).length === 0) delete copy[key];
    else copy[key] = next;
    return copy;
  };
  return keys.length === 0 ? root : walk(root, 0);
}

/** Every leaf as a dotted path with its value rendered as text; arrays count as leaves. */
export function flatten(root: unknown, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (isTable(root)) {
    for (const [k, v] of Object.entries(root)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (root !== undefined) out.set(prefix, renderValue(root));
  return out;
}

export function renderValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.map(renderValue).join(', ')}]`;
  if (isTable(v)) return `{ ${Object.entries(v).map(([k, x]) => `${k} = ${renderValue(x)}`).join(', ')} }`;
  return String(v);
}

export interface ConfigChange {
  path: string;
  old: string | null;
  new: string | null;
}
/** Keys that differ between two configurations, sorted by path. */
export function diffConfig(before: Toml, after: Toml): ConfigChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: ConfigChange[] = [];
  for (const path of paths) {
    const o = a.get(path) ?? null;
    const n = b.get(path) ?? null;
    if (o !== n) out.push({ path, old: o, new: n });
  }
  return out;
}

/** A `<…>` string is a placeholder: accepted, warned about, and the feature that needs it stays off (SPEC 7.2). */
export const isPlaceholder = (v: unknown): boolean => typeof v === 'string' && /^<.*>$/.test(v.trim());

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** SHA-256 of a UTF-8 string, as lowercase hex. Synchronous, so the mock can use it anywhere. */
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const len = msg.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      w[i] = ((w[i - 16] as number) + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + (w[i - 7] as number) + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = ((h[i] as number) + v) >>> 0));
  }
  return [...h].map((v) => v.toString(16).padStart(8, '0')).join('');
}

/** The file's revision as the daemon computes it: the first 16 hex characters of its SHA-256. It detects concurrent edits. */
export function revisionOf(text: string): string {
  return sha256Hex(text).slice(0, 16);
}
