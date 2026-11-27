/**
 * `SolanaTransport`: the seam between the SDK and a Solana JSON-RPC endpoint (SPEC 9.2). The
 * production implementation wraps a `@solana/web3.js` `Connection`; unit tests inject a fake;
 * the integration tests point the same wrapper at `tools/svm-rpc`.
 *
 * It is deliberately small: only what the client, the watchers and the message transport call.
 * Nothing here knows a key. Subscriptions are optional: a transport without them (svm-rpc has
 * no WebSocket) is polled, which is also the catch-up path in production.
 */
import { type Commitment, Connection, type GetProgramAccountsFilter, PublicKey } from '@solana/web3.js';
import { base58Decode } from '@xmrswap/protocol';
import type { Bytes } from '../util.js';

export interface SolanaAccount {
  pubkey: string;
  data: Bytes;
  lamports: bigint;
  /** Owner program, base58. */
  owner: string;
}

export type ProgramFilter = { memcmp: { offset: number; bytes: string } } | { dataSize: number };

export interface SimulationResult {
  err: unknown | null;
  logs: string[];
  unitsConsumed: number | null;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown | null;
}

export interface TransactionInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown | null;
  logs: string[];
  /** Top-level instructions with resolved account keys. */
  instructions: { programId: string; accounts: string[]; data: Bytes }[];
}

export type Level = 'processed' | 'confirmed' | 'finalized';

export interface SolanaTransport {
  getAccount(pubkey: string, level?: Level): Promise<SolanaAccount | null>;
  getAccounts(pubkeys: string[], level?: Level): Promise<(SolanaAccount | null)[]>;
  getProgramAccounts(programId: string, filters: ProgramFilter[], level?: Level): Promise<SolanaAccount[]>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getMinimumBalanceForRentExemption(size: number): Promise<bigint>;
  getGenesisHash(): Promise<string>;
  /** Lamports of an address (0 for an account that does not exist). */
  getBalance(pubkey: string, level?: Level): Promise<bigint>;
  /** The current block height: a transaction is dead once it passes the `lastValidBlockHeight` of its blockhash. */
  getBlockHeight(level?: Level): Promise<number>;
  /** Simulate a signed or unsigned wire transaction. */
  simulate(wire: Bytes): Promise<SimulationResult>;
  /** Send a signed wire transaction with preflight. Returns the signature. */
  send(wire: Bytes): Promise<string>;
  getSignatureStatus(signature: string): Promise<{ level: Level; err: unknown | null } | null>;
  /** Newest first. `until` stops before that signature. */
  getSignaturesForAddress(address: string, opts?: { until?: string; before?: string; limit?: number }): Promise<SignatureInfo[]>;
  getTransaction(signature: string): Promise<TransactionInfo | null>;
  /** Live account changes of a program; returns an unsubscribe function. Absent = poll only. */
  subscribeProgramAccounts?(programId: string, filters: ProgramFilter[], onChange: (account: SolanaAccount) => void): () => void;
  /** Live notification of transactions mentioning an address; returns an unsubscribe function. Absent = poll only. */
  subscribeLogs?(mention: string, onLogs: (entry: { signature: string; logs: string[]; err: unknown | null }) => void): () => void;
}

/**
 * The production transport over a web3.js `Connection`. The caller creates the `Connection`
 * from the endpoint the user configured; the SDK never reads `solana config` or any CLI wallet.
 * `subscriptions: false` (svm-rpc, or an endpoint without WebSocket) leaves the two subscribe
 * methods out, so the client polls.
 */
export function connectionTransport(connection: Connection, opts: { subscriptions?: boolean } = {}): SolanaTransport {
  const toAccount = (pubkey: string, a: { data: Buffer | Uint8Array; lamports: number; owner: PublicKey }): SolanaAccount => ({
    pubkey,
    data: new Uint8Array(a.data),
    lamports: BigInt(a.lamports),
    owner: a.owner.toBase58(),
  });
  const filters = (f: ProgramFilter[]): GetProgramAccountsFilter[] => f as GetProgramAccountsFilter[];
  const t: SolanaTransport = {
    async getAccount(pubkey, level = 'finalized') {
      const a = await connection.getAccountInfo(new PublicKey(pubkey), level);
      return a ? toAccount(pubkey, a) : null;
    },
    async getAccounts(pubkeys, level = 'finalized') {
      const out: (SolanaAccount | null)[] = [];
      for (let i = 0; i < pubkeys.length; i += 100) {
        const chunk = pubkeys.slice(i, i + 100);
        const got = await connection.getMultipleAccountsInfo(
          chunk.map((p) => new PublicKey(p)),
          level,
        );
        got.forEach((a, k) => out.push(a ? toAccount(chunk[k]!, a) : null));
      }
      return out;
    },
    async getProgramAccounts(programId, f, level = 'finalized') {
      const got = await connection.getProgramAccounts(new PublicKey(programId), { commitment: level, filters: filters(f) });
      return got.map((g) => toAccount(g.pubkey.toBase58(), g.account));
    },
    getLatestBlockhash: () => connection.getLatestBlockhash('finalized'),
    getMinimumBalanceForRentExemption: async (size) => BigInt(await connection.getMinimumBalanceForRentExemption(size)),
    getGenesisHash: () => connection.getGenesisHash(),
    getBalance: async (pubkey, level = 'finalized') => BigInt(await connection.getBalance(new PublicKey(pubkey), level)),
    getBlockHeight: (level = 'finalized') => connection.getBlockHeight(level),
    async simulate(wire) {
      // Raw RPC: web3.js's typed overloads insist on its own transaction classes.
      const res = (await (connection as unknown as { _rpcRequest(m: string, p: unknown[]): Promise<any> })._rpcRequest('simulateTransaction', [
        Buffer.from(wire).toString('base64'),
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' },
      ])) as { error?: { message: string }; result?: { value: { err: unknown; logs: string[] | null; unitsConsumed?: number } } };
      if (res.error || !res.result) throw new Error(`simulateTransaction: ${res.error?.message ?? 'no result'}`);
      const v = res.result.value;
      return { err: v.err ?? null, logs: v.logs ?? [], unitsConsumed: v.unitsConsumed ?? null };
    },
    // Preflight is never skipped: a secret-bearing transaction that would fail must not be broadcast.
    send: (wire) => connection.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: 'processed' }),
    async getSignatureStatus(signature) {
      const s = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (!s) return null;
      return { level: (s.confirmationStatus ?? 'processed') as Level, err: s.err ?? null };
    },
    async getSignaturesForAddress(address, o = {}) {
      const got = await connection.getSignaturesForAddress(new PublicKey(address), { ...(o.until ? { until: o.until } : {}), ...(o.before ? { before: o.before } : {}), ...(o.limit ? { limit: o.limit } : {}) }, 'finalized');
      return got.map((g) => ({ signature: g.signature, slot: g.slot, blockTime: g.blockTime ?? null, err: g.err ?? null }));
    },
    async getTransaction(signature) {
      const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (!tx) return null;
      const keys = tx.transaction.message.getAccountKeys(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined);
      const instructions = tx.transaction.message.compiledInstructions.map((ix) => ({
        programId: keys.get(ix.programIdIndex)!.toBase58(),
        accounts: ix.accountKeyIndexes.map((i) => keys.get(i)!.toBase58()),
        data: new Uint8Array(ix.data),
      }));
      return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, err: tx.meta?.err ?? null, logs: tx.meta?.logMessages ?? [], instructions };
    },
  };
  if (opts.subscriptions !== false) {
    t.subscribeProgramAccounts = (programId, f, onChange) => {
      const id = connection.onProgramAccountChange(new PublicKey(programId), (info) => onChange(toAccount(info.accountId.toBase58(), info.accountInfo)), { commitment: 'confirmed' as Commitment, filters: filters(f) });
      return () => void connection.removeProgramAccountChangeListener(id);
    };
    t.subscribeLogs = (mention, onLogs) => {
      const id = connection.onLogs(new PublicKey(mention), (l) => onLogs({ signature: l.signature, logs: l.logs, err: l.err ?? null }), 'confirmed');
      return () => void connection.removeOnLogsListener(id);
    };
  }
  return t;
}

/** `memcmp` filter on raw bytes (base58-encoded for the RPC). */
export const memcmp = (offset: number, bytes: string | Bytes): ProgramFilter => ({ memcmp: { offset, bytes: typeof bytes === 'string' ? bytes : new PublicKey(padTo32(bytes)).toBase58() } });
function padTo32(b: Bytes): Bytes {
  if (b.length !== 32) throw new Error('memcmp helper takes a base58 string or 32 bytes');
  return b;
}
/** Whether an account passes a filter list, exactly as an RPC node evaluates it. Used by fakes and by the subscription fallback. */
export function matchesFilters(data: Bytes, filters: ProgramFilter[]): boolean {
  return filters.every((f) => {
    if ('dataSize' in f) return data.length === f.dataSize;
    const want = base58Decode(f.memcmp.bytes);
    if (f.memcmp.offset + want.length > data.length) return false;
    for (let i = 0; i < want.length; i++) if (data[f.memcmp.offset + i] !== want[i]) return false;
    return true;
  });
}
