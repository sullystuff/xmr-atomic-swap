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

/** Stable short revision of a file's text (FNV-1a, 64 bit). Not a security hash: it detects concurrent edits. */
export function revisionOf(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
