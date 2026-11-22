#!/usr/bin/env node
// Verify a directory against its SHA256SUMS. Plain Node, no dependencies: run it before
// installing anything.
//   node scripts/verify.mjs <dir>
// Exit 0 only if every listed file is present with the listed SHA-256 and the directory holds
// no file the list does not name. A changed, missing or extra file exits 1.
//
// This proves the files match the list. It does not prove the list is the published one:
// compare the "sha256 of the list itself" printed below with the published value, obtained
// over a channel you trust.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SUMS_FILE, listFiles, parseSums, sha256 } from './sums.mjs';

const dir = process.argv[2];
if (!dir || process.argv.length > 3) {
  console.error('usage: verify.mjs <directory holding SHA256SUMS>');
  process.exit(2);
}
let problems = 0;
const problem = (text) => {
  problems += 1;
  console.log(text);
};
try {
  if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  const sumsPath = path.join(dir, SUMS_FILE);
  let text;
  try {
    text = readFileSync(sumsPath, 'utf8');
  } catch {
    throw new Error(`no ${SUMS_FILE} in the directory`);
  }
  const entries = parseSums(text);
  if (entries.length === 0) throw new Error(`${SUMS_FILE} lists no files`);
  const listed = new Set();
  for (const { hash, file } of entries) {
    if (listed.has(file)) {
      problem(`LISTED TWICE  ${file}`);
      continue;
    }
    listed.add(file);
    let actual;
    try {
      actual = await sha256(path.join(dir, file));
    } catch {
      problem(`MISSING       ${file}`);
      continue;
    }
    if (actual !== hash) problem(`CHANGED       ${file}`);
  }
  for (const file of listFiles(dir)) if (!listed.has(file)) problem(`NOT IN LIST   ${file}`);
  if (problems > 0) {
    console.log(`FAILED: ${problems} problem${problems === 1 ? '' : 's'}. Do not use these files.`);
    process.exit(1);
  }
  console.log(`OK: ${entries.length} files match ${SUMS_FILE}`);
  console.log(`sha256 of the list itself: ${await sha256(sumsPath)}`);
} catch (e) {
  console.error(`verify: ${dir}: ${e.message}`);
  process.exit(1);
}
