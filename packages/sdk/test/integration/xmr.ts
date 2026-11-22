// The Monero side of the integration tests: the regtest's two daemons and its wallet-rpc
// (tests/monero-regtest, started by global-setup). The wallet stands in for the maker's
// inventory wallet (direction A) and for the taker's own wallet (direction B).
import { type SweepOutcome, sweepJoint } from '@xmrswap/core-wasm';
import type { LockReport } from '../../src/flows/types.js';
import { daemonNode } from '../../src/monero/rpc.js';
import { type VerifyLockResult, verifyLock } from '../../src/monero/verify.js';
import { lockReport } from '../../src/monero/watch.js';
import { type Bytes, hex } from '../../src/util.js';

export const NODE_A = process.env.XMR_DAEMON_URL ?? 'http://127.0.0.1:48081';
export const NODE_B = process.env.XMR_DAEMON_URL_B ?? 'http://127.0.0.1:48085';
export const NODES = [NODE_A, NODE_B];
const WALLET = process.env.XMR_WALLET_URL ?? 'http://127.0.0.1:48083';
export const XMR = 1_000_000_000_000n;
/** Regtest fees are far above mainnet's; the production cap (`sweepMaxFee`) does not fit them. */
export const REGTEST_MAX_FEE = 100_000_000_000n;

for (const u of [NODE_A, NODE_B, WALLET]) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error(`integration endpoints are loopback only, not ${u}`);

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
async function jsonRpc(url: string, method: string, params: unknown = {}): Promise<any> {
  const r = await post(`${url}/json_rpc`, { jsonrpc: '2.0', id: '0', method, params });
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
const wallet = (method: string, params: unknown = {}) => jsonRpc(WALLET, method, params);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const a = daemonNode(NODE_A);
const b = daemonNode(NODE_B);
let minerAddress: string | null = null;

/** Wait until node B has caught up with node A. */
export async function synced(): Promise<number> {
  for (let i = 0; i < 300; i++) {
    const [x, y] = await Promise.all([a.info(), b.info()]);
    if (x.height === y.height && x.top_block_hash === y.top_block_hash) return x.height;
    await sleep(100);
  }
  throw new Error('the regtest nodes did not converge');
}

/** The wallet's primary address; opens (or creates) the wallet on first use. */
export async function walletAddress(): Promise<string> {
  if (minerAddress) return minerAddress;
  try {
    await wallet('close_wallet');
  } catch {
    // none open
  }
  try {
    await wallet('open_wallet', { filename: 'sdk-integration', password: '' });
  } catch {
    await wallet('create_wallet', { filename: 'sdk-integration', password: '', language: 'English' });
  }
  minerAddress = (await wallet('get_address', { account_index: 0 })).address as string;
  return minerAddress;
}

/** Mine `n` blocks on node A to the wallet and wait for node B. */
export async function mine(n: number): Promise<number> {
  const address = await walletAddress();
  for (let left = n; left > 0; left -= 50) await jsonRpc(NODE_A, 'generateblocks', { amount_of_blocks: Math.min(left, 50), wallet_address: address, starting_nonce: 0 });
  return synced();
}

/** Spendable coinbase and enough outputs on the chain for 16-member rings. */
export async function funded(): Promise<void> {
  await walletAddress();
  const h = (await a.info()).height;
  if (h < 170) await mine(170 - h);
  await wallet('refresh');
}

/** Build a payment without relaying it (the maker's direction-A lock: the notice comes first). */
export async function prepareTransfer(address: string, amount: bigint): Promise<{ txid: string; txHex: string }> {
  await funded();
  const r = await wallet('transfer', { destinations: [{ address, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, do_not_relay: true, get_tx_hex: true });
  return { txid: r.tx_hash, txHex: r.tx_blob };
}

/** Relay a raw transaction through node A (also the "rebroadcast the stored transaction" path). */
export async function relay(txHex: string): Promise<void> {
  const r = await post(`${NODE_A}/send_raw_transaction`, { tx_as_hex: txHex, do_not_relay: false });
  if (r.status !== 'OK') throw new Error(`send_raw_transaction: ${r.reason || r.status}`);
}

/** Pay from the wallet and relay at once (the taker's direction-B payment from its own wallet). */
export async function pay(address: string, amount: bigint): Promise<string> {
  await funded();
  const r = await wallet('transfer', { destinations: [{ address, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0 });
  return r.tx_hash as string;
}

/** After a relayed spend: mine it and let the wallet see its own spent outputs before the next transfer. */
export async function settle(blocks = 1): Promise<void> {
  await mine(blocks);
  await wallet('refresh');
}

export async function chainHeight(): Promise<number> {
  return (await a.info()).height;
}

export interface JointKeys {
  /** hex */
  viewPriv: string;
  spendPub: string;
}

/** `verifyLock` against both regtest nodes. */
export function verify(txid: string, joint: JointKeys, minAmount: bigint, minConf: number): Promise<VerifyLockResult> {
  return verifyLock({ nodes: NODES, txid, viewPriv: joint.viewPriv, spendPub: joint.spendPub, minAmount, minConf });
}

/** Poll `verifyLock` until it reports `want` (the nodes need a moment to agree after a block). */
export async function verifyUntil(txid: string, joint: JointKeys, minAmount: bigint, minConf: number, want: VerifyLockResult['state']): Promise<VerifyLockResult> {
  let last: VerifyLockResult | null = null;
  for (let i = 0; i < 100; i++) {
    last = await verify(txid, joint, minAmount, minConf);
    if (last.state === want) return last;
    await sleep(150);
  }
  throw new Error(`the lock never became ${want}: ${JSON.stringify(last, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
}
export const report = (r: VerifyLockResult): LockReport => lockReport(r);

/** Sweep exactly the verified output of a joint address with the combined key, and mine the sweep. */
export async function sweep(p: { spendKey: Bytes; viewKey: Bytes; lock: VerifyLockResult; txid: string; destination?: string }): Promise<SweepOutcome> {
  if (p.lock.blockHeight === undefined || p.lock.outputIndex === undefined) throw new Error('sweep needs a verified, mined lock');
  // Consensus refuses to spend an output before it is 10 blocks deep.
  const depth = (await chainHeight()) - p.lock.blockHeight;
  if (depth < 10) await mine(10 - depth);
  const out = await sweepJoint({
    daemonUrl: NODE_A,
    network: 'regtest',
    spendKey: p.spendKey,
    viewKey: p.viewKey,
    lockHeight: p.lock.blockHeight,
    lockTxid: Uint8Array.from(Buffer.from(p.txid, 'hex')),
    outputIndex: BigInt(p.lock.outputIndex),
    destination: p.destination ?? (await walletAddress()),
    maxFee: REGTEST_MAX_FEE,
    publish: true,
  });
  await settle(1);
  return out;
}

/** Whether node B (which only follows A) has a transaction in a block. */
export async function isMined(txid: string): Promise<boolean> {
  const e = await b.tx(txid);
  return e !== null && !e.in_pool;
}

export const txidBytes = (txid: string): Bytes => Uint8Array.from(Buffer.from(txid, 'hex'));
export const txidHex = (txid: Bytes): string => hex(txid);
