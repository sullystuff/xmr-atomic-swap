#!/usr/bin/env node
// Build what the harness needs from crates/swap-core:
//   - @xmrswap/core-wasm (both wasm-bindgen targets and the wrapper): the in-browser sweep
//   - the native sweep binary `xmr-joint-sweep` (release)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'inherit' });
run('pnpm', ['--filter', '@xmrswap/core-wasm', 'build']);
run('cargo', ['build', '--release', '-p', 'swap-core', '--bin', 'xmr-joint-sweep']);
