// Starts the svm-rpc binary (docs/SPEC.md 9.2) for a test run. Node only; browser code
// imports `@xmrswap/svm-rpc/client`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SvmRpcClient } from './client.mjs';

export * from './client.mjs';

/** The crate directory (`tools/svm-rpc`). */
export const crateDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `$SVM_RPC_BIN`, else the crate's dev build. */
export function binaryPath() {
  return process.env.SVM_RPC_BIN || join(crateDir, 'target', 'debug', 'svm-rpc');
}

/** Builds the binary with `cargo build --locked` in the crate's own workspace. */
export function buildBinary() {
  const res = spawnSync('cargo', ['build', '--locked'], { cwd: crateDir, stdio: ['ignore', 'inherit', 'inherit'] });
  if (res.status !== 0) throw new Error(`cargo build of svm-rpc failed (${res.error?.message ?? `exit ${res.status}`})`);
}

/**
 * Starts one svm-rpc on 127.0.0.1 and resolves once it serves. The process exits when this
 * process does. There is no option to bind another address.
 */
export async function startSvmRpc({ port = 0, programs = [], unixTimestamp, build = true } = {}) {
  const bin = binaryPath();
  if (!existsSync(bin)) {
    if (process.env.SVM_RPC_BIN || !build) throw new Error(`svm-rpc binary not found at ${bin}`);
    buildBinary();
  }
  const args = ['--port', String(port), '--die-with-parent'];
  for (const { programId, soPath } of programs) {
    args.push('--program', `${typeof programId === 'string' ? programId : programId.toBase58()}=${soPath}`);
  }
  if (unixTimestamp != null) args.push('--unix-timestamp', BigInt(unixTimestamp).toString());

  // stdin stays open as a pipe: the binary exits when it closes, i.e. when this process dies.
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const url = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      const m = /^svm-rpc listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (m) resolve(m[1]);
      else reject(new Error(`unexpected svm-rpc output: ${line}`));
    });
    child.once('error', reject);
    exited.then(({ code, signal }) => reject(new Error(`svm-rpc exited before serving (${signal ?? `exit ${code}`}): ${stderr.trim()}`)));
  });
  child.stdout.resume();

  return new SvmRpc(url, child, exited);
}

export class SvmRpc extends SvmRpcClient {
  #child;
  #exited;

  constructor(url, child, exited) {
    super(url);
    this.port = Number(new URL(url).port);
    this.#child = child;
    this.#exited = exited;
  }

  /** Stops the process; all state is gone. */
  async stop() {
    this.#child.kill('SIGTERM');
    await this.#exited;
  }
}
