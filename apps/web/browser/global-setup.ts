// Runs once before the browser tests: builds what is missing (never rebuilds), builds the UI,
// and starts the Monero regtest of tests/monero-regtest; stops it afterwards. Loopback only.
// The regtest harness stops only the processes it started (by pidfile); other Monero processes
// on this machine are never touched. The package script holds /tmp/xmrswap-integration.lock.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });

/** A build of another package that fails while its owner is mid-change is retried, not patched. */
function retry(what: string, f: () => void, attempts = 4): void {
  for (let i = 1; ; i++) {
    try {
      f();
      return;
    } catch (e) {
      if (i === attempts) throw e;
      console.warn(`${what} failed (attempt ${i}); waiting 30 s and retrying`);
      execFileSync('sleep', ['30']);
    }
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const svm = process.env.SVM_RPC_BIN ?? path.join(repo, 'tools/svm-rpc/target/debug/svm-rpc');
  if (!existsSync(svm)) retry('svm-rpc build', () => run('cargo', ['build', '--locked'], path.join(repo, 'tools/svm-rpc')));
  if (!existsSync(path.join(repo, 'solana/program/target/deploy/xmr_swap.so'))) retry('program build', () => run('cargo', ['build-sbf'], path.join(repo, 'solana/program')));
  // The browser tests run against the production build of the UI.
  run('pnpm', ['exec', 'vite', 'build'], path.resolve(here, '..'));

  const regtest = path.join(repo, 'tests/monero-regtest');
  const env = { ...process.env, XMR_BIN: process.env.XMR_BIN ?? path.join(process.env.HOME ?? '', 'monero') };
  if (!existsSync(path.join(env.XMR_BIN, 'monerod'))) throw new Error(`browser tests: no monerod in ${env.XMR_BIN}; set XMR_BIN to the directory holding monerod and monero-wallet-rpc 0.18.4.5`);
  run('bash', ['./start.sh', '--fresh'], regtest, env);
  return async () => {
    run('bash', ['./stop.sh'], regtest, env);
  };
}
