// The Monero side: the regtest of tests/monero-regtest (two nodes, one wallet-rpc) under this
// package's own state directory, further wallet-rpc processes (one per wallet that must stay
// open: the taker's own wallet, more makers' inventory wallets), and a tampering proxy that
// stands in front of a real node to play a node that is down or that disagrees.
// Regtest only; nothing here touches another Monero process on this machine.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type Proc, startProc } from './procs.js';
import { jsonRpc, repoRoot, sleep, stateRoot, waitFor } from './util.js';

export const XMR_BIN = process.env['XMR_BIN'] ?? path.join(process.env['HOME'] ?? '', 'monero');
export const XMR_STATE = path.join(stateRoot, 'monero');
export const NODE_A = 'http://127.0.0.1:48081';
export const NODE_B = 'http://127.0.0.1:48085';
/** The wallet-rpc `start.sh` runs: the first maker's inventory wallet lives here. */
export const WALLET_RPC_MAKER = 'http://127.0.0.1:48083';
/** Regtest fees are far above mainnet's; the production cap does not fit them. */
export const REGTEST_MAX_FEE = 100_000_000_000n;
const regtestDir = path.join(repoRoot, 'tests/monero-regtest');
const regtestEnv = (): NodeJS.ProcessEnv => ({ ...process.env, XMR_BIN, XMR_STATE });

export function startRegtest(): void {
  if (!existsSync(path.join(XMR_BIN, 'monerod'))) throw new Error(`e2e: no monerod in ${XMR_BIN}; set XMR_BIN to the directory holding monerod and monero-wallet-rpc`);
  execFileSync('bash', ['./start.sh', '--fresh'], { cwd: regtestDir, env: regtestEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
}
export function stopRegtest(): void {
  try {
    execFileSync('bash', ['./stop.sh'], { cwd: regtestDir, env: regtestEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    // nothing was running
  }
}

// ------------------------------------------------------------------ nodes

export const nodeRpc = <T = any>(url: string, method: string, params: unknown = {}): Promise<T> => jsonRpc<T>(url, method, params, '/json_rpc');
export async function nodeOther<T = any>(url: string, route: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${url}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
export const tip = async (url: string): Promise<{ height: number; hash: string }> => {
  const r = await nodeRpc<{ height: number; top_block_hash: string }>(url, 'get_info');
  return { height: r.height, hash: r.top_block_hash };
};
export async function synced(): Promise<number> {
  for (let i = 0; i < 600; i++) {
    const [a, b] = await Promise.all([tip(NODE_A), tip(NODE_B)]);
    if (a.height === b.height && a.hash === b.hash) return a.height;
    await sleep(100);
  }
  throw new Error('the regtest nodes did not converge');
}
/** Mine `n` blocks on node A to `address` and wait until node B follows. */
export async function mine(n: number, address: string): Promise<number> {
  for (let left = n; left > 0; left -= 50) await nodeRpc(NODE_A, 'generateblocks', { amount_of_blocks: Math.min(left, 50), wallet_address: address, starting_nonce: 0 });
  return synced();
}
export async function txInfo(txid: string, node = NODE_B): Promise<{ inPool: boolean; height: number | null } | null> {
  const r = await nodeOther<{ txs?: { in_pool: boolean; block_height?: number }[] }>(node, 'get_transactions', { txs_hashes: [txid] });
  const e = r.txs?.[0];
  return e ? { inPool: e.in_pool, height: e.in_pool ? null : (e.block_height ?? null) } : null;
}
export const isMined = async (txid: string): Promise<boolean> => (await txInfo(txid))?.inPool === false;
export const poolTxids = async (node = NODE_A): Promise<string[]> => (await nodeOther<{ tx_hashes?: string[] }>(node, 'get_transaction_pool_hashes', {})).tx_hashes ?? [];

/**
 * A real reorganisation: both nodes forget the last `depth` blocks and everything those blocks
 * (and the pool) carried, then a longer chain without them is mined. Returns the new height.
 */
export async function reorg(depth: number, mineTo: string): Promise<number> {
  // Pop on both nodes first (a node that is ahead would hand the block straight back to the other), then empty both
  // pools until they stay empty: a popped transaction returns to its node's pool and is relayed to the peer.
  for (const n of [NODE_A, NODE_B]) await nodeOther(n, 'pop_blocks', { nblocks: depth });
  for (let quiet = 0, i = 0; quiet < 3 && i < 40; i++) {
    for (const n of [NODE_A, NODE_B]) await nodeRpc(n, 'flush_txpool', {});
    await sleep(150);
    quiet = (await poolTxids(NODE_A)).length + (await poolTxids(NODE_B)).length === 0 ? quiet + 1 : 0;
  }
  return mine(depth + 1, mineTo);
}

// ------------------------------------------------------------------ wallets

export class Wallet {
  constructor(
    readonly url: string,
    readonly name: string,
  ) {}
  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    return jsonRpc<T>(this.url, method, params, '/json_rpc');
  }
  async open(): Promise<string> {
    await this.call('close_wallet').catch(() => undefined);
    try {
      await this.call('open_wallet', { filename: this.name, password: '' });
    } catch {
      await this.call('create_wallet', { filename: this.name, password: '', language: 'English' });
    }
    return this.address();
  }
  async address(): Promise<string> {
    return (await this.call<{ address: string }>('get_address', { account_index: 0 })).address;
  }
  refresh(): Promise<unknown> {
    return this.call('refresh');
  }
  async balance(): Promise<{ balance: bigint; unlocked: bigint }> {
    await this.refresh();
    const r = await this.call<{ balance: number | string; unlocked_balance: number | string }>('get_balance', { account_index: 0 });
    return { balance: BigInt(r.balance), unlocked: BigInt(r.unlocked_balance) };
  }
  /** Pay and relay at once; returns the transaction id. */
  async pay(address: string, amount: bigint): Promise<string> {
    await this.refresh();
    const r = await this.call<{ tx_hash: string }>('transfer', { destinations: [{ address, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0 });
    return r.tx_hash;
  }
  /** What this wallet received in `txid` (piconero), or `null` when it does not know the transaction. */
  async received(txid: string): Promise<bigint | null> {
    await this.refresh();
    try {
      const r = await this.call<{ transfers?: { type: string; amount: number }[]; transfer?: { type: string; amount: number } }>('get_transfer_by_txid', { txid });
      const all = r.transfers ?? (r.transfer ? [r.transfer] : []);
      const ins = all.filter((t) => t.type === 'in' || t.type === 'pool');
      return ins.length ? ins.reduce((s, t) => s + BigInt(t.amount), 0n) : null;
    } catch {
      return null;
    }
  }
}

/** One more monero-wallet-rpc on its own port and wallet directory (regtest node A). */
export async function startWalletRpc(name: string, port: number): Promise<{ url: string; proc: Proc }> {
  const dir = path.join(XMR_STATE, `wallets-${name}`);
  mkdirSync(dir, { recursive: true });
  const proc = startProc(`wallet-rpc-${name}`, path.join(XMR_BIN, 'monero-wallet-rpc'), [
    '--wallet-dir', dir, '--disable-rpc-login', '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--rpc-ssl', 'disabled',
    '--daemon-address', '127.0.0.1:48081', '--daemon-ssl', 'disabled', '--trusted-daemon', '--allow-mismatched-daemon-version', '--no-initial-sync',
    '--log-level', '0', '--max-log-file-size', '2000000', '--log-file', path.join(XMR_STATE, 'logs', `wallet-rpc-${name}.log`),
  ]);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`wallet-rpc ${name}`, async () => (await jsonRpc(url, 'get_version', {}, '/json_rpc')) && true, { timeoutMs: 40_000 });
  return { url, proc };
}

// ------------------------------------------------------------------ a node that can lie or go away

export type NodeMode = 'honest' | 'down' | 'hide-tx' | 'stale';
export interface NodeProxy {
  url: string;
  mode: NodeMode;
  /** Requests served, by route. */
  hits: Record<string, number>;
  /** Hold every answer back this long (a slow node). */
  delayMs: number;
  /** Requests this proxy is holding or forwarding right now. */
  pending: number;
  close(): Promise<void>;
}

/**
 * A pass-through HTTP proxy in front of a real regtest node. `honest` relays verbatim. `down`
 * drops the connection. `hide-tx` answers transaction lookups as if the node had never seen the
 * transaction (a node on another fork, or a lying one). `stale` reports a tip one block behind
 * with a different hash. CORS is answered here so a browser page can use it like the node itself.
 */
export async function startNodeProxy(target: string): Promise<NodeProxy> {
  const state: NodeProxy = { url: '', mode: 'honest', hits: {}, delayMs: 0, pending: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    if (state.mode === 'down') return void req.socket.destroy();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const route = (req.url ?? '/').replace(/^\//, '');
        state.hits[route] = (state.hits[route] ?? 0) + 1;
        state.pending++;
        res.once('close', () => state.pending--);
        if (state.delayMs > 0) await sleep(state.delayMs);
        try {
          const up = await fetch(`${target}/${route}`, { method: req.method ?? 'POST', headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}) });
          let out = Buffer.from(await up.arrayBuffer());
          const type = up.headers.get('content-type') ?? 'application/json';
          if (state.mode === 'hide-tx' && route === 'get_transactions') {
            const asked = (JSON.parse(body.toString() || '{}') as { txs_hashes?: string[] }).txs_hashes ?? [];
            out = Buffer.from(JSON.stringify({ status: 'OK', missed_tx: asked, txs: [], untrusted: false }));
          }
          if (state.mode === 'stale' && route === 'json_rpc' && /"get_info"/.test(body.toString())) {
            const j = JSON.parse(out.toString()) as { result: { height: number; top_block_hash: string } };
            j.result.height -= 1;
            j.result.top_block_hash = 'ee'.repeat(32);
            out = Buffer.from(JSON.stringify(j));
          }
          res.writeHead(up.status, { ...cors, 'content-type': type });
          res.end(out);
        } catch {
          res.writeHead(502, cors).end();
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return state;
}
