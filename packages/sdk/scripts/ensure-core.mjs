#!/usr/bin/env node
// The SDK calls @xmrswap/core-wasm, whose wasm (packages/core-wasm/pkg) is built only by that
// package's own build (WP1 deviation W10). Build it when it is missing; never rebuild otherwise.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const need = ['packages/core-wasm/pkg/node/swap_core_bg.wasm', 'packages/core-wasm/dist/index.js', 'packages/protocol/dist/index.js'];
const missing = need.filter((f) => !existsSync(path.join(repo, f)));
if (missing.length) {
  console.log(`@xmrswap/sdk: building what is missing (${missing.join(', ')})`);
  if (missing.some((f) => f.includes('protocol'))) execFileSync('pnpm', ['--filter', '@xmrswap/protocol', 'build'], { cwd: repo, stdio: 'inherit' });
  if (missing.some((f) => f.includes('core-wasm'))) execFileSync('pnpm', ['--filter', '@xmrswap/core-wasm', 'build'], { cwd: repo, stdio: 'inherit' });
}
