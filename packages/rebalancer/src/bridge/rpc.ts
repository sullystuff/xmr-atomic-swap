/**
 * The narrow Solana read interface the bridge adapter needs. The daemon passes
 * `connectionRpc(connection)` over its own failover connection; tests pass a fake. The adapter
 * never signs and never sends: transactions go out through `ExecContext.sendSol`.
 */
import { type Connection, PublicKey } from '@solana/web3.js';

export interface RpcAccount { owner: string; data: Uint8Array; lamports: bigint }
export interface RpcTransaction {
  /** Null when the transaction succeeded. */
  err: unknown;
  logs: string[];
  /** Token balances of every (owner, mint) the transaction touched, before and after, in base units. */
  tokenBalances: { owner: string; mint: string; pre: bigint; post: bigint }[];
  /** Lamport balances by account, before and after. */
  lamports: { address: string; pre: bigint; post: bigint }[];
  blockTime: number | null;
}
export interface SolanaRpc {
  getAccount(address: string): Promise<RpcAccount | null>;
  getAccounts(addresses: string[]): Promise<(RpcAccount | null)[]>;
  /** Newest first. */
  getSignatures(address: string, limit: number): Promise<{ signature: string; err: unknown }[]>;
  getTransaction(signature: string): Promise<RpcTransaction | null>;
}

/** Adapts a web3.js `Connection`. Reads that credit funds use `finalized`. */
export function connectionRpc(conn: Connection, commitment: 'confirmed' | 'finalized' = 'finalized'): SolanaRpc {
  const map = (a: { owner: PublicKey; data: Buffer | Uint8Array; lamports: number } | null): RpcAccount | null =>
    a ? { owner: a.owner.toBase58(), data: new Uint8Array(a.data), lamports: BigInt(a.lamports) } : null;
  return {
    async getAccount(address) { return map(await conn.getAccountInfo(new PublicKey(address), commitment)); },
    async getAccounts(addresses) {
      const out: (RpcAccount | null)[] = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const part = await conn.getMultipleAccountsInfo(addresses.slice(i, i + 100).map((a) => new PublicKey(a)), commitment);
        out.push(...part.map(map));
      }
      return out;
    },
    async getSignatures(address, limit) {
      return (await conn.getSignaturesForAddress(new PublicKey(address), { limit }, commitment)).map((s) => ({ signature: s.signature, err: s.err }));
    },
    async getTransaction(signature) {
      const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment });
      if (!tx || !tx.meta) return null;
      const meta = tx.meta;
      const key = (o: string | undefined, m: string) => `${o ?? ''}|${m}`;
      const balances = new Map<string, { owner: string; mint: string; pre: bigint; post: bigint }>();
      for (const b of meta.preTokenBalances ?? []) balances.set(key(b.owner, b.mint), { owner: b.owner ?? '', mint: b.mint, pre: BigInt(b.uiTokenAmount.amount), post: 0n });
      for (const b of meta.postTokenBalances ?? []) {
        const e = balances.get(key(b.owner, b.mint)) ?? { owner: b.owner ?? '', mint: b.mint, pre: 0n, post: 0n };
        e.post = BigInt(b.uiTokenAmount.amount);
        balances.set(key(b.owner, b.mint), e);
      }
      const keys = tx.transaction.message.getAccountKeys(meta.loadedAddresses ? { accountKeysFromLookups: meta.loadedAddresses } : undefined);
      const lamports = meta.preBalances.map((pre, i) => ({ address: keys.get(i)?.toBase58() ?? '', pre: BigInt(pre), post: BigInt(meta.postBalances[i] ?? pre) }));
      return { err: meta.err, logs: meta.logMessages ?? [], tokenBalances: [...balances.values()], lamports, blockTime: tx.blockTime ?? null };
    },
  };
}

/** How much of `mint` the owner gained in a transaction, from the transaction's own balance records. */
export function tokenDelta(tx: RpcTransaction, owner: string, mint: string): bigint {
  let d = 0n;
  for (const b of tx.tokenBalances) if (b.owner === owner && b.mint === mint) d += b.post - b.pre;
  return d;
}

/** The owner's lamport change in a transaction (fees included). */
export function lamportDelta(tx: RpcTransaction, address: string): bigint {
  let d = 0n;
  for (const b of tx.lamports) if (b.address === address) d += b.post - b.pre;
  return d;
}
