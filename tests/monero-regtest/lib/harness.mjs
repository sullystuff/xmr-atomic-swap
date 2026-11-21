// Reusable regtest actions: mine, fund, sweep. Used by e2e.mjs, the CLIs and (later) integration tests.
import { Daemon, WalletRpc, DAEMON_A, DAEMON_B, WALLET_URL } from './rpc.mjs';
import { XMR } from './monero.mjs';

export const daemonA = new Daemon(DAEMON_A), daemonB = new Daemon(DAEMON_B), wallet = new WalletRpc(WALLET_URL);
export const NODES = [DAEMON_A, DAEMON_B];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until node B has caught up with node A (same height and tip). */
export async function waitSynced(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const [a, b] = await Promise.all([daemonA.info(), daemonB.info()]);
    if (a.height === b.height && a.top_block_hash === b.top_block_hash) return a.height;
    if (Date.now() - t0 > timeoutMs) throw new Error(`nodes did not converge: A=${a.height} B=${b.height}`);
    await sleep(200);
  }
}
let minerAddr;
/** Address of the harness's miner wallet (created on first use). Leaves that wallet open. */
export async function minerAddress() { await wallet.openOrCreate('miner'); return (minerAddr = await wallet.address()); }
/** Mine n blocks on node A to the miner wallet and wait for node B to follow. */
export async function mine(n, address) {
  address ??= minerAddr ?? (await minerAddress());
  for (let left = n; left > 0; left -= 50) await daemonA.generate(Math.min(left, 50), address);
  return waitSynced();
}
/** Make sure the miner has spendable coinbase and the chain has enough outputs for 16-member rings. */
export async function ensureFunded(minHeight = 160) {
  const addr = await minerAddress(); const h = (await daemonA.info()).height;
  if (h < minHeight) await mine(minHeight - h, addr);
  await wallet.refresh(); return addr;
}
/** Pay `amount` piconero from the miner wallet to `address`. Returns { txid, txKey, fee }. */
export async function fund(address, amount, { unlockTime = 0 } = {}) {
  await ensureFunded();
  const r = await wallet.call('transfer', { destinations: [{ address, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: unlockTime, get_tx_key: true });
  return { txid: r.tx_hash, txKey: r.tx_key, fee: BigInt(r.fee) };
}
/**
 * Sweep everything from the joint address with the full spend key, via monero-wallet-rpc
 * (this is what the Rust maker daemon does over HTTP). Returns { txids, amount, fee }.
 */
export async function sweepWithWalletRpc({ name, address, viewKey, spendKey, restoreHeight, destination }) {
  await wallet.fromKeys({ name, address, viewKey, spendKey, restoreHeight });
  try {
    await wallet.refresh();
    const bal = await wallet.balance();
    if (BigInt(bal.unlocked_balance) === 0n) throw Object.assign(new Error(`nothing unlocked yet (balance ${bal.balance}, unlocks in ${bal.blocks_to_unlock} blocks)`), { locked: true, blocksToUnlock: bal.blocks_to_unlock });
    const r = await wallet.call('sweep_all', { address: destination, account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, get_tx_keys: true });
    return { txids: r.tx_hash_list, amount: r.amount_list.reduce((a, b) => a + BigInt(b), 0n), fee: r.fee_list.reduce((a, b) => a + BigInt(b), 0n) };
  } finally { await wallet.close(); }
}
export { XMR };
