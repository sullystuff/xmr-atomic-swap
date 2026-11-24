/**
 * Save an edit by changing only the lines it touches. The file is the maker's: comments, layout
 * and every key this console does not know stay exactly as they were. If the file is laid out
 * in a way this editor cannot patch safely (multi-line values, arrays of tables), it falls back
 * to writing the whole configuration afresh; either way the result is checked to parse back to
 * exactly the wanted configuration.
 */
import { diffConfig, flatten, getPath, isTable, parseToml, splitPath, stringifyToml, type Toml } from './toml.js';

const BARE = /^[A-Za-z0-9_-]+$/;
const keyText = (k: string): string => (BARE.test(k) ? k : JSON.stringify(k));

/** A value on one line: inline tables and arrays, as TOML writes them. */
export function inlineToml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('not a finite number');
    return String(v);
  }
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[ ${v.map(inlineToml).join(', ')} ]`;
  if (isTable(v)) {
    const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${keyText(k)} = ${inlineToml(x)}`);
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }
  throw new Error('value cannot be written as TOML');
}

interface Line {
  text: string;
  /** Dotted path of the table this line sits in. */
  table: string;
  /** The key this line defines, when it is a `key = value` line. */
  key: string | null;
}

/** Whether brackets, braces and quotes are closed at the end of this `key = value` line. */
function closed(value: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (value.startsWith(c.repeat(3), i)) return false; // a multi-line string
      quote = c;
    } else if (c === '#') break;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth === 0 && quote === null;
}

function scan(text: string): Line[] {
  let table = '';
  return text.split('\n').map((raw) => {
    const t = raw.trim();
    if (t.startsWith('[[')) throw new Error('arrays of tables are not patched');
    const header = /^\[([^\]]+)\]\s*(#.*)?$/.exec(t);
    if (header) {
      table = splitHeader(header[1] as string).join('.');
      return { text: raw, table, key: null };
    }
    const kv = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=(.*)$/.exec(t);
    if (!kv) {
      if (t !== '' && !t.startsWith('#')) throw new Error('a line this editor cannot place');
      return { text: raw, table, key: null };
    }
    if (!closed(kv[2] as string)) throw new Error('a value that spans lines');
    const k = kv[1] as string;
    return { text: raw, table, key: k.startsWith('"') ? (JSON.parse(k) as string) : k.startsWith("'") ? k.slice(1, -1) : k };
  });
}
function splitHeader(h: string): string[] {
  return h.split('.').map((p) => {
    const t = p.trim();
    if (t.startsWith('"') || t.startsWith("'")) return t.slice(1, -1);
    if (!BARE.test(t)) throw new Error('a table name this editor cannot read');
    return t;
  });
}

const same = (a: Toml, b: Toml): boolean => {
  const x = flatten(a);
  const y = flatten(b);
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
};

function patch(original: string, before: Toml, wanted: Toml): string {
  const lines = scan(original);
  const done = new Set<string>();
  for (const change of diffConfig(before, wanted)) {
    const parts = splitPath(change.path);
    // The line that holds this value: the key itself, or an inline table or array further up.
    let holder: { table: string; key: string } | null = null;
    for (let k = parts.length - 1; k >= 0 && !holder; k--) {
      const table = parts.slice(0, k).join('.');
      const key = parts[k] as string;
      if (lines.some((l) => l.key === key && l.table === table)) holder = { table, key };
    }
    const target = holder ?? { table: parts.slice(0, -1).join('.'), key: parts[parts.length - 1] as string };
    const full = target.table === '' ? target.key : `${target.table}.${target.key}`;
    if (done.has(full)) continue;
    done.add(full);
    const value = getPath(wanted, full);
    const at = lines.findIndex((l) => l.key === target.key && l.table === target.table);
    if (at >= 0) {
      if (value === undefined) lines.splice(at, 1);
      else {
        const indent = /^\s*/.exec((lines[at] as Line).text)?.[0] ?? '';
        (lines[at] as Line).text = `${indent}${keyText(target.key)} = ${inlineToml(value)}`;
      }
      continue;
    }
    if (value === undefined) continue;
    const text = `${keyText(target.key)} = ${inlineToml(value)}`;
    // Into its table when the file has one: after the table's last line that is not blank.
    let last = -1;
    lines.forEach((l, i) => {
      if (l.table === target.table && l.text.trim() !== '' && (target.table !== '' || l.key !== null || i === 0)) last = i;
    });
    const hasTable = target.table === '' ? true : lines.some((l) => l.table === target.table);
    if (hasTable && target.table === '') {
      // Root keys go before the first table header.
      const firstHeader = lines.findIndex((l) => l.table !== '');
      lines.splice(firstHeader < 0 ? lines.length : firstHeader, 0, { text, table: '', key: target.key });
    } else if (hasTable) lines.splice(last + 1, 0, { text, table: target.table, key: target.key });
    else {
      while (lines.length > 0 && (lines[lines.length - 1] as Line).text.trim() === '') lines.pop();
      lines.push({ text: '', table: target.table, key: null }, { text: `[${splitPath(target.table).map(keyText).join('.')}]`, table: target.table, key: null }, { text, table: target.table, key: target.key }, { text: '', table: target.table, key: null });
    }
  }
  return lines.map((l) => l.text).join('\n');
}

/**
 * The text to save: `original` with only the edited keys changed. `kept` tells whether the
 * maker's own text survived (`false` = the whole file was written afresh).
 */
export function editToml(original: string, wanted: Toml): { toml: string; kept: boolean } {
  let before: Toml;
  try {
    before = parseToml(original);
  } catch {
    return { toml: stringifyToml(wanted), kept: false };
  }
  if (same(before, wanted)) return { toml: original, kept: true };
  try {
    const out = patch(original, before, wanted);
    const text = out.endsWith('\n') ? out : `${out}\n`;
    if (same(parseToml(text), wanted)) return { toml: text, kept: true };
  } catch {
    /* fall through to a fresh file */
  }
  return { toml: stringifyToml(wanted), kept: false };
}
