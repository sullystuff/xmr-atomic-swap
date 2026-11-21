// Minimal monerod / monero-wallet-rpc clients (plain fetch; works in Node 18+ and browsers).
export class RpcError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
async function post(url, body, timeoutMs = 600_000) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new RpcError(`${url}: HTTP ${res.status}`);
  return res.json();
}
export class Daemon {
  constructor(url) { this.url = url.replace(/\/$/, ''); }
  async json(method, params = {}) { const r = await post(`${this.url}/json_rpc`, { jsonrpc: '2.0', id: '0', method, params }); if (r.error) throw new RpcError(`${method}: ${r.error.message}`, r.error.code); return r.result; }
  async other(path, body = {}) { const r = await post(`${this.url}/${path}`, body); if (r.status && r.status !== 'OK') throw new RpcError(`${path}: ${r.status}`); return r; }
  info() { return this.json('get_info'); }
  headerByHeight(height) { return this.json('get_block_header_by_height', { height }).then((r) => r.block_header); }
  block(height) { return this.json('get_block', { height }); }
  /** Regtest only: mine `n` blocks to `address`. */
  generate(n, address) { return this.json('generateblocks', { amount_of_blocks: n, wallet_address: address, starting_nonce: 0 }); }
  /** Raw lookup of many txs (restricted nodes cap this at 100 per call). */
  async txs(txids) { const out = []; for (let i = 0; i < txids.length; i += 100) out.push(...((await this.other('get_transactions', { txs_hashes: txids.slice(i, i + 100), decode_as_json: false, prune: true })).txs || [])); return out; }
  poolHashes() { return this.other('get_transaction_pool_hashes', {}).then((r) => r.tx_hashes || []); }
  /** Raw tx lookup. Returns the entry or null if this node does not know the tx. */
  async tx(txid) { const r = await this.other('get_transactions', { txs_hashes: [txid], decode_as_json: false, prune: false }); return r.txs?.[0] ?? null; }
}
export class WalletRpc {
  constructor(url) { this.url = url.replace(/\/$/, ''); }
  async call(method, params = {}) { const r = await post(`${this.url}/json_rpc`, { jsonrpc: '2.0', id: '0', method, params }); if (r.error) throw new RpcError(`${method}: ${r.error.message}`, r.error.code); return r.result; }
  async close() { try { await this.call('close_wallet'); } catch { /* none open */ } }
  /** Open `name`, creating it if missing. */
  async openOrCreate(name) { await this.close(); try { await this.call('open_wallet', { filename: name, password: '' }); } catch { await this.call('create_wallet', { filename: name, password: '', language: 'English' }); } }
  /** Restore a wallet from raw keys. Omit spendKey for a view-only wallet. */
  async fromKeys({ name, address, viewKey, spendKey, restoreHeight = 0 }) {
    await this.close();
    return this.call('generate_from_keys', { filename: name, address, viewkey: viewKey, ...(spendKey ? { spendkey: spendKey } : {}), password: '', restore_height: restoreHeight, autosave_current: false });
  }
  address() { return this.call('get_address', { account_index: 0 }).then((r) => r.address); }
  refresh() { return this.call('refresh'); }
  balance() { return this.call('get_balance', { account_index: 0 }); }
}
export const env = (k, d) => (typeof process !== 'undefined' && process.env[k]) || d;
export const DAEMON_A = env('XMR_DAEMON_URL', 'http://127.0.0.1:48081');
export const DAEMON_B = env('XMR_DAEMON_URL_B', 'http://127.0.0.1:48085');
export const DAEMON_B_RESTRICTED = env('XMR_DAEMON_URL_B_RESTRICTED', 'http://127.0.0.1:48086');
export const WALLET_URL = env('XMR_WALLET_URL', 'http://127.0.0.1:48083');
