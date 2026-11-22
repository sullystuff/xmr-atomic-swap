/**
 * A minimal monerod client over plain `fetch` (restricted RPC is enough), and the `MoneroNode`
 * seam the verifier takes so tests can stand in recorded nodes. The URL is whatever the user
 * configured: a node, or the relay's allow-listed proxy (`<relay>/monero/<n>`).
 */

export class MoneroRpcError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'MoneroRpcError';
    this.code = code;
  }
}

export interface NodeInfo {
  height: number;
  top_block_hash: string;
  nettype?: string;
  synchronized?: boolean;
}
/** One entry of `/get_transactions`. Full nodes return `as_hex`; pruned nodes `pruned_as_hex` + `prunable_hash`. */
export interface TxEntry {
  tx_hash: string;
  as_hex?: string;
  pruned_as_hex?: string;
  prunable_hash?: string;
  in_pool?: boolean;
  double_spend_seen?: boolean;
  block_height?: number;
}
export interface BlockInfo {
  block_header: { hash: string; height?: number };
  tx_hashes?: string[];
  miner_tx_hash?: string;
  /** The block as JSON text; carries the miner transaction's outputs. */
  json?: string;
}

/** What the verifier asks of a node. */
export interface MoneroNode {
  /** A label for reports (the URL). */
  readonly url: string;
  info(): Promise<NodeInfo>;
  /** One transaction, unpruned when the node has it; `null` if the node does not know it. */
  tx(txid: string): Promise<TxEntry | null>;
  /** Many transactions (pruned form is enough). */
  txs(txids: string[]): Promise<TxEntry[]>;
  block(height: number): Promise<BlockInfo>;
  poolHashes(): Promise<string[]>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A node reached over HTTP. `fetchFn` defaults to the global `fetch`; tests and the Tor path pass their own. */
export function daemonNode(url: string, opts: { fetchFn?: FetchLike; timeoutMs?: number } = {}): MoneroNode {
  const base = url.replace(/\/$/, '');
  const fetchFn: FetchLike = opts.fetchFn ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const post = async (path: string, body: unknown): Promise<any> => {
    const res = await fetchFn(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new MoneroRpcError(`${base}/${path}: HTTP ${res.status}`);
    return res.json();
  };
  const json = async (method: string, params: unknown = {}): Promise<any> => {
    const r = await post('json_rpc', { jsonrpc: '2.0', id: '0', method, params });
    if (r.error) throw new MoneroRpcError(`${method}: ${r.error.message}`, r.error.code);
    return r.result;
  };
  const other = async (path: string, body: unknown = {}): Promise<any> => {
    const r = await post(path, body);
    if (r.status && r.status !== 'OK') throw new MoneroRpcError(`${path}: ${r.status}`);
    return r;
  };
  return {
    url: base,
    info: () => json('get_info'),
    block: (height) => json('get_block', { height }),
    async tx(txid) {
      const r = await other('get_transactions', { txs_hashes: [txid], decode_as_json: false, prune: false });
      return r.txs?.[0] ?? null;
    },
    async txs(txids) {
      const out: TxEntry[] = [];
      // Restricted nodes cap this at 100 per call.
      for (let i = 0; i < txids.length; i += 100) out.push(...((await other('get_transactions', { txs_hashes: txids.slice(i, i + 100), decode_as_json: false, prune: true })).txs ?? []));
      return out;
    },
    poolHashes: async () => (await other('get_transaction_pool_hashes', {})).tx_hashes ?? [],
  };
}

export const asNode = (n: string | MoneroNode): MoneroNode => (typeof n === 'string' ? daemonNode(n) : n);
