// Builds what the UI imports only when its output is missing (never rebuilds): the wasm of
// @xmrswap/core-wasm and the dist/ of protocol, core-wasm and sdk. Same pattern as the SDK's.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const run = (filter, script) => execFileSync('pnpm', ['--filter', filter, script], { cwd: repo, stdio: 'inherit' });
if (!existsSync(path.join(repo, 'packages/core-wasm/pkg/web/swap_core_bg.wasm')) || !existsSync(path.join(repo, 'packages/core-wasm/pkg/node/swap_core.js'))) run('@xmrswap/core-wasm', 'build');
if (!existsSync(path.join(repo, 'packages/core-wasm/dist/index.js'))) run('@xmrswap/core-wasm', 'build:ts');
if (!existsSync(path.join(repo, 'packages/protocol/dist/index.js'))) run('@xmrswap/protocol', 'build');
if (!existsSync(path.join(repo, 'packages/sdk/dist/index.js'))) run('@xmrswap/sdk', 'build');
