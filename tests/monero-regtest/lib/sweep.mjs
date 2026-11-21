// The native sweep of crates/swap-core (`xmr-joint-sweep`), driven as a child process.
// Build it first: `pnpm build` in this directory.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SWEEP_BIN = path.join(process.env.CARGO_TARGET_DIR || path.join(repo, 'target'), 'release/xmr-joint-sweep');

// Regtest fees are far above mainnet's, so the harness overrides the production fee cap
// (SWEEP_FEE_FLOOR / SWEEP_FEE_CAP_BPS in @xmrswap/protocol) with a generous one.
export const REGTEST_MAX_FEE = 100_000_000_000n; // 0.1 XMR

/**
 * Sweep exactly one verified output of the joint address.
 * Resolves to { jointAddress, txid, amount, fee, txHex, published, ignored: [{ output, amount }] }
 * (amounts as decimal strings); rejects with the binary's `error: …` line in `err.stderr`.
 */
export function sweepNative({ daemonUrl, network = 'regtest', spendKey, viewKey, lockHeight, lockTxid, outputIndex, destination, maxFee = REGTEST_MAX_FEE, publish = true }) {
  if (!existsSync(SWEEP_BIN)) throw new Error(`${SWEEP_BIN} not found: run \`pnpm build\` in tests/monero-regtest`);
  const args = [daemonUrl, network, spendKey, viewKey, String(lockHeight), lockTxid, String(outputIndex), destination, String(maxFee), ...(publish ? [] : ['--dry-run'])];
  return new Promise((resolve, reject) => {
    execFile(SWEEP_BIN, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(stderr.trim() || err.message), { stderr }));
      resolve(JSON.parse(stdout));
    });
  });
}
