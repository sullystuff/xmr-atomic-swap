#!/usr/bin/env node
// The bundle serves the built web UI and imports the built relay and protocol packages. Build
// what is missing; never rebuild what exists (other work may share this checkout). Building the
// UI from source needs the Rust toolchain and wasm-bindgen (see docs/self-hosting/quick-start.md),
// so it is not attempted when the settings point at another UI directory (an unpacked release).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const deploy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(deploy, '..');
const DEFAULT_UI = path.join(repo, 'apps/web/dist');

/** The UI directory the start command will use: the environment, then the settings file, then the default. */
function uiDir() {
  if (process.env.XMRSWAP_UI_DIST) return path.resolve(deploy, process.env.XMRSWAP_UI_DIST);
  const file = process.env.XMRSWAP_SELFHOST_CONFIG ? path.resolve(process.cwd(), process.env.XMRSWAP_SELFHOST_CONFIG) : path.join(process.cwd(), 'xmrswap.toml');
  try {
    const dist = parse(readFileSync(file, 'utf8'))?.ui?.dist;
    if (typeof dist === 'string' && dist !== '') return path.resolve(deploy, dist);
  } catch {
    // No file, or one the start command will report on: fall through to the default.
  }
  return DEFAULT_UI;
}

const need = [
  ['@xmrswap/protocol', 'packages/protocol/dist/index.js'],
  ['@xmrswap/relay', 'packages/relay/dist/index.js'],
];
if (uiDir() === DEFAULT_UI) need.push(['@xmrswap/web', 'apps/web/dist/index.html']);
// --plan: only say what would be required (used by the tests).
if (process.argv.includes('--plan')) {
  for (const [pkg, file] of need) console.log(`${pkg} ${file}`);
  process.exit(0);
}
for (const [pkg, file] of need) {
  if (existsSync(path.join(repo, file))) continue;
  console.log(`@xmrswap/deploy: building ${pkg} (missing ${file})`);
  execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: repo, stdio: 'inherit' });
}
