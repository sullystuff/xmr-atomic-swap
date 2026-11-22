/**
 * `monero-wallet-rpc` client for the maker's inventory wallet (SPEC 7; `docs/research/monero.md`
 * section 4), and the node-side calls the daemon needs beyond the SDK's read-only `MoneroNode`
 * seam: relaying a stored raw transaction and asking whether key images are spent.
 *
 * Both take an injectable fetch; tests stand in fakes for the whole interface.
 */
export type JsonFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface WalletOutput {
  keyImage: string;
  amount: bigint;
  blockHeight: number | null;
  unlocked: boolean;
  frozen: boolean;
  spent: boolean;
  txid: string;
}
export interface PreparedTx {
  txid: string;
  txHex: string;
  fee: bigint;
  /** Key images of the inputs, when the wallet reports them. */
  keyImages: string[];
}

/** What the inventory, the splitter and the rebalancer ask of the inventory wallet. */
export interface InventoryWallet {
  address(): Promise<string>;
  refresh(): Promise<void>;
  height(): Promise<number>;
  outputs(): Promise<WalletOutput[]>;
  freeze(keyImage: string): Promise<void>;
  thaw(keyImage: string): Promise<void>;
  /** Build and sign a payment WITHOUT relaying it. Throws `WalletError('not_enough')` when the unfrozen outputs cannot cover it. */
  prepare(destinations: { address: string; amount: bigint }[]): Promise<PreparedTx>;
  checkReserveProof?(address: string, message: string, signature: string): Promise<{ good: boolean; total: bigint; spent: bigint }>;
}

export class WalletError extends Error {
  constructor(
    readonly code: 'not_enough' | 'rpc' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export class WalletRpc implements InventoryWallet {
  private readonly url: string;
  private readonly fetchFn: JsonFetch;
  private readonly auth: string | null;

  constructor(url: string, opts: { fetchFn?: JsonFetch; user?: string; password?: string; timeoutMs?: number } = {}) {
    this.url = url.replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? ((u, init) => fetch(u, init));
    // monero-wallet-rpc speaks digest auth; behind a loopback bind `--disable-rpc-login` is usual. Basic is sent when a login is configured (a reverse proxy in front).
    this.auth = opts.user ? `Basic ${Buffer.from(`${opts.user}:${opts.password ?? ''}`).toString('base64')}` : null;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }
  private readonly timeoutMs: number;

  async call<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await this.fetchFn(`${this.url}/json_rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.auth ? { authorization: this.auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new WalletError('unreachable', `wallet-rpc ${method}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new WalletError('rpc', `wallet-rpc ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      // -17 WALLET_RPC_ERROR_CODE_NOT_ENOUGH_MONEY, -37 NOT_ENOUGH_UNLOCKED_MONEY, -4 generic transfer error "not enough".
      const notEnough = body.error.code === -17 || body.error.code === -37 || /not enough|no unlocked balance/i.test(body.error.message);
      throw new WalletError(notEnough ? 'not_enough' : 'rpc', `wallet-rpc ${method}: ${body.error.message}`);
    }
    return body.result as T;
  }

  async address(): Promise<string> {
    return (await this.call<{ address: string }>('get_address', { account_index: 0 })).address;
  }
  async refresh(): Promise<void> {
    await this.call('refresh');
  }
  async height(): Promise<number> {
    return (await this.call<{ height: number }>('get_height')).height;
  }
  async outputs(): Promise<WalletOutput[]> {
    const r = await this.call<{ transfers?: { amount: number | string; key_image: string; block_height?: number; unlocked?: boolean; frozen?: boolean; spent?: boolean; tx_hash: string }[] }>('incoming_transfers', { transfer_type: 'available', account_index: 0, verbose: true });
    return (r.transfers ?? []).map((t) => ({ keyImage: t.key_image, amount: BigInt(t.amount), blockHeight: t.block_height ?? null, unlocked: t.unlocked !== false, frozen: !!t.frozen, spent: !!t.spent, txid: t.tx_hash }));
  }
  async freeze(keyImage: string): Promise<void> {
    await this.call('freeze', { key_image: keyImage });
  }
  async thaw(keyImage: string): Promise<void> {
    await this.call('thaw', { key_image: keyImage });
  }
  async prepare(destinations: { address: string; amount: bigint }[]): Promise<PreparedTx> {
    // Amounts are u64 piconero; JSON numbers lose precision above 2^53 (9,007 XMR), so larger sends are refused here.
    for (const d of destinations) if (d.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError('rpc', 'amount above 2^53 piconero cannot be sent in one wallet-rpc call');
    const r = await this.call<{ tx_hash: string; tx_blob: string; fee: number; spent_key_images?: { key_images?: string[] } }>('transfer', {
      destinations: destinations.map((d) => ({ address: d.address, amount: Number(d.amount) })), account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, do_not_relay: true, get_tx_hex: true,
    });
    return { txid: r.tx_hash, txHex: r.tx_blob, fee: BigInt(r.fee), keyImages: r.spent_key_images?.key_images ?? [] };
  }
  async checkReserveProof(address: string, message: string, signature: string): Promise<{ good: boolean; total: bigint; spent: bigint }> {
    const r = await this.call<{ good: boolean; total?: number; spent?: number }>('check_reserve_proof', { address, message, signature });
    return { good: r.good, total: BigInt(r.total ?? 0), spent: BigInt(r.spent ?? 0) };
  }
  async openOrCreate(filename: string, password = ''): Promise<void> {
    try {
      await this.call('open_wallet', { filename, password });
    } catch {
      await this.call('create_wallet', { filename, password, language: 'English' });
    }
  }
}

export interface RelayResult {
  ok: boolean;
  reason?: string;
  doubleSpend?: boolean;
}
/** Node-side writes: relay a raw transaction; ask whether key images are spent. */
export interface MoneroBroadcaster {
  sendRaw(txHex: string): Promise<RelayResult>;
  keyImagesSpent(keyImages: string[]): Promise<boolean[]>;
}

/** Broadcast through the configured nodes, most trusted first: the first that accepts wins. */
export function nodeBroadcaster(urls: string[], fetchFn: JsonFetch = (u, init) => fetch(u, init)): MoneroBroadcaster {
  const post = async (url: string, path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetchFn(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  return {
    async sendRaw(txHex) {
      let last: RelayResult = { ok: false, reason: 'no node configured' };
      for (const url of urls) {
        try {
          const r = await post(url, 'send_raw_transaction', { tx_as_hex: txHex, do_not_relay: false });
          if (r['status'] === 'OK') return { ok: true };
          last = { ok: false, reason: String(r['reason'] || r['status']), doubleSpend: r['double_spend'] === true };
          if (last.doubleSpend) return last;
        } catch (e) {
          last = { ok: false, reason: (e as Error).message };
        }
      }
      return last;
    },
    async keyImagesSpent(keyImages) {
      if (keyImages.length === 0) return [];
      let lastError: unknown = new Error('no node configured');
      for (const url of urls) {
        try {
          const r = await post(url, 'is_key_image_spent', { key_images: keyImages });
          // 0 = unspent, 1 = spent in the chain, 2 = spent in the pool.
          return ((r['spent_status'] as number[] | undefined) ?? []).map((s) => s === 1);
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },
  };
}
