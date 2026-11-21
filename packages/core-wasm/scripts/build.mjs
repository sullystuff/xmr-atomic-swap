#!/usr/bin/env node
// Build crates/swap-core for wasm32 and bind it twice with wasm-bindgen (SPEC 2.12):
//   pkg/web   --target web     (browser)
//   pkg/node  --target nodejs  (daemon, SDK tests)
// then compile the TypeScript wrapper. The CLI version must equal the crate version.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_BINDGEN_VERSION = '0.2.130';
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkgDir, '../..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const bindgen = process.env.WASM_BINDGEN || 'wasm-bindgen';
const version = execFileSync(bindgen, ['--version'], { encoding: 'utf8' }).trim();
if (!version.includes(WASM_BINDGEN_VERSION)) {
  console.error(`wasm-bindgen CLI is "${version}"; this build needs ${WASM_BINDGEN_VERSION}:`);
  console.error(`  cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`);
  process.exit(1);
}

run('cargo', ['build', '-p', 'swap-core', '--lib', '--release', '--target', 'wasm32-unknown-unknown'], repo);
const wasm = path.join(repo, 'target/wasm32-unknown-unknown/release/swap_core.wasm');

rmSync(path.join(pkgDir, 'pkg'), { recursive: true, force: true });
for (const target of ['web', 'nodejs']) {
  const out = path.join(pkgDir, 'pkg', target === 'nodejs' ? 'node' : 'web');
  mkdirSync(out, { recursive: true });
  run(bindgen, ['--target', target, '--out-dir', out, wasm], repo);
}
// The nodejs target emits CommonJS; this package is "type": "module".
writeFileSync(path.join(pkgDir, 'pkg/node/package.json'), '{ "type": "commonjs" }\n');

run(process.execPath, [path.join(pkgDir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], pkgDir);
const kb = (f) => `${(statSync(path.join(pkgDir, f)).size / 1024).toFixed(0)} kB`;
console.log(`core-wasm built: web ${kb('pkg/web/swap_core_bg.wasm')}, node ${kb('pkg/node/swap_core_bg.wasm')}`);
