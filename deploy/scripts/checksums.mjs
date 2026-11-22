#!/usr/bin/env node
// Write <dir>/SHA256SUMS: the SHA-256 of every file under <dir>, in the format of `sha256sum`
// (so `cd <dir> && sha256sum -c SHA256SUMS` also works). The list is sorted and holds relative
// paths only, so the same files always give the same list.
//   node scripts/checksums.mjs <dir>
import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SUMS_FILE, listFiles, sha256 } from './sums.mjs';

const dir = process.argv[2];
if (!dir || process.argv.length > 3) {
  console.error('usage: checksums.mjs <directory>');
  process.exit(2);
}
try {
  if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  const files = listFiles(dir);
  if (files.length === 0) throw new Error('the directory is empty');
  const lines = [];
  for (const file of files) lines.push(`${await sha256(path.join(dir, file))}  ${file}`);
  writeFileSync(path.join(dir, SUMS_FILE), `${lines.join('\n')}\n`);
  console.log(`wrote ${path.join(dir, SUMS_FILE)}: ${files.length} files`);
  console.log(`sha256 of the list itself: ${await sha256(path.join(dir, SUMS_FILE))}`);
} catch (e) {
  console.error(`checksums: ${dir}: ${e.message}`);
  process.exit(1);
}
