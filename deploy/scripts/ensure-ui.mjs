#!/usr/bin/env node
// The bundle serves the built web UI and imports the built relay and protocol packages. Build
// what is missing; never rebuild what exists (other work may share this checkout). Building the
// UI from source needs the Rust toolchain and wasm-bindgen (see docs/self-hosting/quick-start.md).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const need = [
  ['@xmrswap/protocol', 'packages/protocol/dist/index.js'],
  ['@xmrswap/relay', 'packages/relay/dist/index.js'],
];
// A UI directory named in the environment (an unpacked release) is used as it is.
if (!process.env.XMRSWAP_UI_DIST) need.push(['@xmrswap/web', 'apps/web/dist/index.html']);
for (const [pkg, file] of need) {
  if (existsSync(path.join(repo, file))) continue;
  console.log(`@xmrswap/deploy: building ${pkg} (missing ${file})`);
  execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: repo, stdio: 'inherit' });
}
