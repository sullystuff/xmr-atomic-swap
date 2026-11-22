// Integration harness (milestone M2). Everything it starts listens on loopback only and dies
// with the test run: `tools/svm-rpc` (an in-memory LiteSVM behind JSON-RPC), `anvil`, and the
// Monero regtest that `tests/monero-regtest/start.sh` runs. Nothing here reads `solana config`,
// a CLI wallet or any live endpoint.
//
// The harness fails loudly, naming what is missing, when the artifacts of WP2 (the program's
// .so), WP3 (the contract's forge output) or WP4 (the svm-rpc binary) are not built: an
// integration run that silently skipped would prove nothing.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '@solana/web3.js';
import { DEV_PROGRAM_ID } from '@xmrswap/protocol';
import { type EthTransport } from '../../src/ethereum/client.js';
import { type SolanaTransport, connectionTransport } from '../../src/solana/transport.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const ARTIFACTS = {
  svmRpc: process.env.SVM_RPC_BIN ?? path.join(repoRoot, 'tools/svm-rpc/target/debug/svm-rpc'),
  program: process.env.XMR_SWAP_SO ?? path.join(repoRoot, 'solana/program/target/deploy/xmr_swap.so'),
  contract: path.join(repoRoot, 'ethereum/out/XmrSwap.sol/XmrSwap.json'),
  proxy: path.join(repoRoot, 'ethereum/out/ERC1967Proxy.sol/ERC1967Proxy.json'),
};

export function requireArtifact(name: keyof typeof ARTIFACTS, builtBy: string): string {
  const p = ARTIFACTS[name];
  if (!existsSync(p)) throw new Error(`integration: ${p} is missing. Build it first (${builtBy}).`);
  return p;
}

function waitForLine(child: ChildProcess, pattern: RegExp, what: string, timeoutMs = 30_000): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${what} did not start within ${timeoutMs} ms:\n${buf}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = pattern.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${what} exited with code ${code}:\n${buf}`));
    });
  });
}

/** JSON-RPC over loopback HTTP, for the `svm_*` and `anvil_*` / `evm_*` control methods. */
export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`integration endpoints are loopback only, not ${url}`);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code, data: body.error.data });
  return body.result as T;
}

export interface SvmRpc {
  url: string;
  transport: SolanaTransport;
  /** `svm_warp(seconds)`: moves `unix_timestamp` and the slot together and expires the blockhash. */
  warp(seconds: number): Promise<void>;
  setClock(unixTimestamp: number): Promise<void>;
  airdrop(pubkey: string, lamports: bigint): Promise<void>;
  /** `svm_setUpgradeAuthority`: LiteSVM writes a ProgramData account with no authority; `initialize` needs one. */
  setUpgradeAuthority(authority: string): Promise<void>;
  createMint(decimals: number, authority: string): Promise<string>;
  mintTo(mint: string, owner: string, amount: bigint): Promise<string>;
  stop(): Promise<void>;
}

/** Start `svm-rpc` on a free loopback port with the built program loaded at the development id. */
export async function startSvmRpc(unixTimestamp = 1_800_000_000): Promise<SvmRpc> {
  const bin = requireArtifact('svmRpc', '`pnpm --filter @xmrswap/svm-rpc build`, WP4');
  const so = requireArtifact('program', '`cd solana/program && cargo build-sbf`, WP2');
  const child = spawn(bin, ['--port', '0', '--program', `${DEV_PROGRAM_ID}=${so}`, '--unix-timestamp', String(unixTimestamp)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const m = await waitForLine(child, /svm-rpc listening on (http:\/\/127\.0\.0\.1:\d+)/, 'svm-rpc');
  const url = m[1]!;
  // svm-rpc has no WebSocket: the SDK polls (`subscriptions: false`).
  const transport = connectionTransport(new Connection(url, 'finalized'), { subscriptions: false });
  return {
    url,
    transport,
    warp: (seconds) => rpc(url, 'svm_warp', [seconds]),
    setClock: (t) => rpc(url, 'svm_setClock', [t]),
    airdrop: (pubkey, lamports) => rpc(url, 'svm_airdrop', [pubkey, Number(lamports)]),
    setUpgradeAuthority: (authority) => rpc(url, 'svm_setUpgradeAuthority', [DEV_PROGRAM_ID, authority]),
    createMint: (decimals, authority) => rpc<string>(url, 'svm_createMint', [decimals, authority]),
    mintTo: (mint, owner, amount) => rpc<string>(url, 'svm_mintTo', [mint, owner, Number(amount)]),
    stop: async () => void child.kill(),
  };
}

export interface Anvil {
  url: string;
  transport: EthTransport;
  /** `evm_increaseTime` + `evm_mine`. */
  advance(seconds: number): Promise<void>;
  /** Mine enough blocks for the `finalized` tag to pass the current head. */
  finalize(): Promise<void>;
  stop(): Promise<void>;
}

/** Start `anvil` (chain id 31337) on a free loopback port. Never forks a live network. */
export async function startAnvil(): Promise<Anvil> {
  const child = spawn(process.env.ANVIL ?? 'anvil', ['--host', '127.0.0.1', '--port', '0', '--chain-id', '31337', '--timestamp', '1800000000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const m = await waitForLine(child, /Listening on (127\.0\.0\.1:\d+)/, 'anvil');
  const url = `http://${m[1]}`;
  return {
    url,
    transport: { request: ({ method, params }) => rpc(url, method, params ?? []) },
    advance: async (seconds) => {
      await rpc(url, 'evm_increaseTime', [seconds]);
      await rpc(url, 'evm_mine', []);
    },
    // anvil reports `finalized` two epochs (64 blocks) behind the head.
    finalize: async () => void (await rpc(url, 'anvil_mine', [65])),
    stop: async () => void child.kill(),
  };
}

/** The two regtest daemons of `tests/monero-regtest` (started by its `start.sh --fresh`; ports from its `env.sh`). */
export const MONERO_NODES = [process.env.XMR_DAEMON_URL ?? 'http://127.0.0.1:48081', process.env.XMR_DAEMON_URL_B ?? 'http://127.0.0.1:48085'];
