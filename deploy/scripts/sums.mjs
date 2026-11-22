// Shared by checksums.mjs and verify.mjs. Plain Node, no dependencies, so a download can be
// verified before anything is installed.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
import path from 'node:path';

export const SUMS_FILE = 'SHA256SUMS';
/** Files that sit beside the list and are not part of it: the list itself and a detached signature of it. */
const NOT_LISTED = new Set([SUMS_FILE, `${SUMS_FILE}.asc`, `${SUMS_FILE}.sig`, `${SUMS_FILE}.minisig`]);

export function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Every regular file under `dir`, as sorted relative paths with forward slashes. Links are refused. */
export function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (/[\n\r\\]/.test(entry.name)) throw new Error(`unsupported file name: ${JSON.stringify(child)}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        if (!(rel === '' && NOT_LISTED.has(entry.name))) out.push(child);
      } else throw new Error(`not a regular file (links and devices are refused): ${child}`);
    }
  };
  walk('');
  // Byte order, so the list is the same on every machine.
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Parse a SHA256SUMS file (the format of `sha256sum`: 64 hex digits, two spaces, the path). */
export function parseSums(text) {
  const entries = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`${SUMS_FILE} line ${i + 1} is not "<sha256>  <path>"`);
    const file = m[2];
    if (path.isAbsolute(file) || file.split('/').includes('..') || file.includes('\\')) throw new Error(`${SUMS_FILE} line ${i + 1} names a path outside the directory`);
    entries.push({ hash: m[1], file });
  }
  return entries;
}
