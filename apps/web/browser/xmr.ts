// The Monero side of the browser tests: the regtest's two daemons and its wallet-rpc
// (tests/monero-regtest). The wallet stands in for the maker's inventory wallet (direction A),
// for the taker's own wallet (direction B) and for the taker's destination. Loopback only.
export const NODE_A = process.env.XMR_DAEMON_URL ?? 'http://127.0.0.1:48081';
export const NODE_B = process.env.XMR_DAEMON_URL_B ?? 'http://127.0.0.1:48085';
const WALLET = process.env.XMR_WALLET_URL ?? 'http://127.0.0.1:48083';
export const XMR = 1_000_000_000_000n;
/** Regtest fees are far above mainnet's; the production cap does not fit them. */
export const REGTEST_MAX_FEE = 100_000_000_000n;

for (const u of [NODE_A, NODE_B, WALLET]) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error(`test endpoints are loopback only, not ${u}`);

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
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const info = (url: string) => jsonRpc(url, 'get_info');

let address: string | null = null;

export async function synced(): Promise<number> {
  for (let i = 0; i < 300; i++) {
    const [x, y] = await Promise.all([info(NODE_A), info(NODE_B)]);
    if (x.height === y.height && x.top_block_hash === y.top_block_hash) return x.height;
    await sleep(100);
  }
  throw new Error('the regtest nodes did not converge');
}

/** The wallet's primary address; opens (or creates) the wallet on first use. */
export async function walletAddress(): Promise<string> {
  if (address) return address;
  try {
    await wallet('close_wallet');
  } catch {
    // none open
  }
  try {
    await wallet('open_wallet', { filename: 'web-browser-tests', password: '' });
  } catch {
    await wallet('create_wallet', { filename: 'web-browser-tests', password: '', language: 'English' });
  }
  address = (await wallet('get_address', { account_index: 0 })).address as string;
  return address;
}

/** Mine `n` blocks on node A to the wallet and wait for node B. */
export async function mine(n: number): Promise<number> {
  const a = await walletAddress();
  for (let left = n; left > 0; left -= 50) await jsonRpc(NODE_A, 'generateblocks', { amount_of_blocks: Math.min(left, 50), wallet_address: a, starting_nonce: 0 });
  return synced();
}

/** Spendable coinbase and enough outputs on the chain for 16-member rings. */
export async function funded(): Promise<void> {
  await walletAddress();
  const h = (await info(NODE_A)).height;
  if (h < 170) await mine(170 - h);
  await wallet('refresh');
}

/** Build a payment without relaying it (the maker's direction-A lock: the notice comes first). */
export async function prepareTransfer(to: string, amount: bigint): Promise<{ txid: string; txHex: string }> {
  await funded();
  const r = await wallet('transfer', { destinations: [{ address: to, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, do_not_relay: true, get_tx_hex: true });
  return { txid: r.tx_hash, txHex: r.tx_blob };
}

export async function relay(txHex: string): Promise<void> {
  const r = await post(`${NODE_A}/send_raw_transaction`, { tx_as_hex: txHex, do_not_relay: false });
  if (r.status !== 'OK') throw new Error(`send_raw_transaction: ${r.reason || r.status}`);
}

/** Pay from the wallet and relay at once (the taker's direction-B payment from its own wallet). */
export async function pay(to: string, amount: bigint): Promise<string> {
  await funded();
  const r = await wallet('transfer', { destinations: [{ address: to, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0 });
  return r.tx_hash as string;
}

/** Mine and let the wallet see its own spent outputs before the next transfer. */
export async function settle(blocks = 1): Promise<number> {
  const h = await mine(blocks);
  await wallet('refresh');
  return h;
}

export async function chainHeight(): Promise<number> {
  return (await info(NODE_A)).height;
}

/** What the wallet received in transaction `txid` (piconero), or `null` when it does not know it. */
export async function received(txid: string): Promise<bigint | null> {
  await wallet('refresh');
  try {
    const r = await wallet('get_transfer_by_txid', { txid });
    const all = (r.transfers ?? [r.transfer]) as { type: string; amount: number }[];
    const ins = all.filter((t) => t.type === 'in' || t.type === 'pool');
    return ins.length ? ins.reduce((s, t) => s + BigInt(t.amount), 0n) : null;
  } catch {
    return null;
  }
}

/** Whether node B (which only follows A) has a transaction in a block. */
export async function isMined(txid: string): Promise<boolean> {
  const r = await post(`${NODE_B}/get_transactions`, { txs_hashes: [txid] });
  const e = r.txs?.[0];
  return !!e && !e.in_pool;
}
