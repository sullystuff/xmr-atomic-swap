// Runs once before the scenario files: builds what the system needs (the two UIs always, so the
// browser runs the current sources; everything else only when missing), starts the Monero regtest
// under this package's own state directory, and removes everything afterwards. Loopback only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { XMR_STATE, startRegtest, stopRegtest } from './monero.js';
import { reapStale } from './procs.js';
import { repoRoot, stateRoot } from './util.js';

const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void => void execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });

export default async function setup(): Promise<() => Promise<void>> {
  for (const u of ['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'ANCHOR_WALLET', 'ANCHOR_PROVIDER_URL']) delete process.env[u];
  reapStale();
  stopRegtest();
  if (!process.env['E2E_KEEP_STATE']) rmSync(stateRoot, { recursive: true, force: true });
  mkdirSync(stateRoot, { recursive: true });

  if (!existsSync(process.env['SVM_RPC_BIN'] ?? path.join(repoRoot, 'tools/svm-rpc/target/debug/svm-rpc'))) run('cargo', ['build', '--locked'], path.join(repoRoot, 'tools/svm-rpc'));
  if (!existsSync(path.join(repoRoot, 'solana/program/target/deploy/xmr_swap.so'))) run('cargo', ['build-sbf'], path.join(repoRoot, 'solana/program'));
  if (!existsSync(path.join(repoRoot, 'ethereum/out/XmrSwap.sol/XmrSwap.json'))) run('forge', ['build'], path.join(repoRoot, 'ethereum'));
  for (const p of ['protocol', 'sdk', 'rebalancer', 'relay', 'daemon']) if (!existsSync(path.join(repoRoot, 'packages', p, 'dist/index.js'))) run('pnpm', ['--filter', `@xmrswap/${p}`, 'build'], repoRoot);
  if (!process.env['E2E_SKIP_BUILD']) {
    // (vitest sets NODE_ENV=test; the builds must not inherit it, or React's development build is bundled.)
    const env = { ...process.env, NODE_ENV: 'production' };
    run('pnpm', ['--filter', '@xmrswap/web', 'exec', 'vite', 'build'], repoRoot, env);
    run('pnpm', ['--filter', '@xmrswap/console', 'exec', 'vite', 'build'], repoRoot, env);
  }

  startRegtest();
  return async () => {
    reapStale();
    stopRegtest();
    reapStale();
    // Disk is tight: chains, wallets and browser profiles go; a failed run keeps its logs when asked to.
    if (process.env['E2E_KEEP_LOGS']) rmSync(XMR_STATE, { recursive: true, force: true });
    else rmSync(stateRoot, { recursive: true, force: true });
  };
}
