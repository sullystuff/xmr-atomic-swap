// Runs once before the integration files: builds what is missing (never rebuilds) and starts the
// Monero regtest of tests/monero-regtest; stops it afterwards. Everything is loopback only.
// The regtest harness stops only the processes it started (by pidfile); other Monero processes
// on the machine are never touched.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });

export default async function setup(): Promise<() => Promise<void>> {
  const svm = process.env.SVM_RPC_BIN ?? path.join(repo, 'tools/svm-rpc/target/debug/svm-rpc');
  if (!existsSync(svm)) run('cargo', ['build', '--locked'], path.join(repo, 'tools/svm-rpc'));
  if (!existsSync(path.join(repo, 'solana/program/target/deploy/xmr_swap.so'))) run('cargo', ['build-sbf'], path.join(repo, 'solana/program'));
  if (!existsSync(path.join(repo, 'ethereum/out/XmrSwap.sol/XmrSwap.json'))) run('forge', ['build'], path.join(repo, 'ethereum'));

  const regtest = path.join(repo, 'tests/monero-regtest');
  const env = { ...process.env, XMR_BIN: process.env.XMR_BIN ?? path.join(process.env.HOME ?? '', 'monero') };
  if (!existsSync(path.join(env.XMR_BIN, 'monerod'))) throw new Error(`integration: no monerod in ${env.XMR_BIN}; set XMR_BIN to the directory holding monerod and monero-wallet-rpc 0.18.4.5`);
  run('bash', ['./start.sh', '--fresh'], regtest, env);
  return async () => {
    run('bash', ['./stop.sh'], regtest, env);
  };
}
