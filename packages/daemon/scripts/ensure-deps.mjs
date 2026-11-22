#!/usr/bin/env node
// The daemon imports the built output of its workspace dependencies. Build what is missing;
// never rebuild what exists (other engineers share this checkout).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const need = [
  ['@xmrswap/protocol', 'packages/protocol/dist/index.js'],
  ['@xmrswap/core-wasm', 'packages/core-wasm/pkg/node/swap_core_bg.wasm'],
  ['@xmrswap/core-wasm', 'packages/core-wasm/dist/index.js'],
  ['@xmrswap/sdk', 'packages/sdk/dist/index.js'],
  ['@xmrswap/sdk', 'packages/sdk/dist/testing/index.js'],
  ['@xmrswap/rebalancer', 'packages/rebalancer/dist/index.js'],
];
const built = new Set();
for (const [pkg, file] of need) {
  if (existsSync(path.join(repo, file)) || built.has(pkg)) continue;
  console.log(`@xmrswap/daemon: building ${pkg} (missing ${file})`);
  execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: repo, stdio: 'inherit' });
  built.add(pkg);
}
