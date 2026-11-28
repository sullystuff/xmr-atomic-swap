#!/usr/bin/env node
// The watcher imports the built output of its workspace dependencies. Build what is missing or
// older than its sources; never rebuild what is current (other engineers share this checkout).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// [package, a file its build produces, the TypeScript source directory that file is built from (or null)]
const need = [
  ['@xmrswap/protocol', 'packages/protocol/dist/index.js', 'packages/protocol/src'],
  ['@xmrswap/core-wasm', 'packages/core-wasm/pkg/node/swap_core_bg.wasm', null],
  ['@xmrswap/core-wasm', 'packages/core-wasm/dist/index.js', null],
  ['@xmrswap/sdk', 'packages/sdk/dist/index.js', 'packages/sdk/src'],
  ['@xmrswap/sdk', 'packages/sdk/dist/testing/index.js', null],
];
function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}
const built = new Set();
for (const [pkg, file, src] of need) {
  if (built.has(pkg)) continue;
  const out = path.join(repo, file);
  const missing = !existsSync(out);
  const stale = !missing && src !== null && newest(path.join(repo, src)) > statSync(out).mtimeMs;
  if (!missing && !stale) continue;
  console.log(`@xmrswap/watcher: building ${pkg} (${missing ? `missing ${file}` : `${file} is older than ${src}`})`);
  execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: repo, stdio: 'inherit' });
  built.add(pkg);
}
