// Shared by checksums.mjs and verify.mjs. Plain Node, no dependencies, so a download can be
// verified before anything is installed.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
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

/**
 * The entries of a file tree: every regular file under `dir` with its SHA-256 and size, sorted
 * by path in byte order. File order on disk, timestamps, owners and permissions play no part.
 */
export async function treeEntries(dir) {
  const out = [];
  for (const file of listFiles(dir)) out.push({ path: file, sha256: await sha256(path.join(dir, file)), size: statSync(path.join(dir, file)).size });
  return out;
}

/** The canonical listing of a tree: one `<sha256>  <path>` line per file, as `sha256sum` prints it. */
export function listingText(entries) {
  return entries.map((e) => `${e.sha256}  ${e.path}\n`).join('');
}

/**
 * The tree hash: the SHA-256 of the canonical listing. Two trees have the same tree hash exactly
 * when they hold the same paths with the same contents. It can be recomputed with coreutils:
 *   cd <dir> && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum
 */
export function treeHash(entries) {
  return createHash('sha256').update(listingText(entries)).digest('hex');
}

/**
 * The executable hash of a Solana program, as `solana-verify get-executable-hash` computes it:
 * the SHA-256 of the file with its trailing zero bytes removed. (A deployed program sits in an
 * account that is padded with zeros, so the padding must not count.)
 */
export function executableHash(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
}
