import { type ProgramFilter, type SignatureInfo, type SimulationResult, type SolanaAccount, type SolanaTransport, type TransactionInfo, matchesFilters } from '../solana/transport.js';
import { CLOCK_SYSVAR } from '../solana/client.js';
import { type Bytes, bigToLe } from '../util.js';

/**
 * A `SolanaTransport` over a map of accounts. Tests put accounts in, set the clock, and decide
 * what simulation and sending do; it records every wire transaction it was asked to send.
 */
export class FakeSolana implements SolanaTransport {
  readonly accounts = new Map<string, SolanaAccount>();
  readonly sent: Bytes[] = [];
  readonly simulated: Bytes[] = [];
  readonly transactions = new Map<string, TransactionInfo>();
  /** Signatures per address, newest first. */
  readonly history = new Map<string, SignatureInfo[]>();
  genesis = 'FakeGenesis11111111111111111111111111111111';
  blockhash = '11111111111111111111111111111111';
  /** What `getBlockHeight` answers; a blockhash is valid for 150 blocks from it. */
  blockHeight = 850;
  /** What `simulate` answers; replace to make a simulation fail. */
  onSimulate: (wire: Bytes) => SimulationResult = () => ({ err: null, logs: [], unitsConsumed: 20_000 });
  /** What `send` answers; replace to make a send fail. */
  onSend: (wire: Bytes) => string = () => `sig${this.sent.length}`;
  /** Calls made, by method name: lets a test assert what was (not) asked. */
  readonly calls: Record<string, number> = {};
  private programSubs: { programId: string; filters: ProgramFilter[]; cb: (a: SolanaAccount) => void }[] = [];
  private logSubs: { mention: string; cb: (e: { signature: string; logs: string[]; err: unknown | null }) => void }[] = [];

  constructor(opts: { subscriptions?: boolean } = {}) {
    if (opts.subscriptions === false) {
      // A transport without WebSocket (svm-rpc): the optional methods are simply absent.
      (this as { subscribeProgramAccounts?: unknown }).subscribeProgramAccounts = undefined;
      (this as { subscribeLogs?: unknown }).subscribeLogs = undefined;
    }
    this.setClock(0n);
  }

  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  /** Set `Clock.unix_timestamp`. */
  setClock(unixTimestamp: bigint): void {
    const data = new Uint8Array(40);
    data.set(bigToLe(BigInt.asUintN(64, unixTimestamp), 8), 32);
    this.accounts.set(CLOCK_SYSVAR, { pubkey: CLOCK_SYSVAR, data, lamports: 1n, owner: 'Sysvar1111111111111111111111111111111111111' });
  }
  /** Create or overwrite an account, notifying program subscribers. */
  setAccount(pubkey: string, owner: string, data: Bytes, lamports = 1_000_000n): void {
    const a = { pubkey, data, lamports, owner };
    this.accounts.set(pubkey, a);
    for (const s of this.programSubs) if (s.programId === owner && matchesFilters(data, s.filters)) s.cb(a);
  }
  /** Close an account (a "closed" row). */
  deleteAccount(pubkey: string): void {
    const a = this.accounts.get(pubkey);
    this.accounts.delete(pubkey);
    if (a) for (const s of this.programSubs) if (s.programId === a.owner) s.cb({ ...a, data: new Uint8Array(0), lamports: 0n });
  }
  /** Record a landed transaction mentioning `addresses`, notifying log subscribers. */
  addTransaction(tx: TransactionInfo, addresses: string[]): void {
    this.transactions.set(tx.signature, tx);
    for (const addr of addresses) {
      this.history.set(addr, [{ signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, err: tx.err }, ...(this.history.get(addr) ?? [])]);
      for (const s of this.logSubs) if (s.mention === addr) s.cb({ signature: tx.signature, logs: tx.logs, err: tx.err });
    }
  }

  async getAccount(pubkey: string): Promise<SolanaAccount | null> {
    this.count('getAccount');
    return this.accounts.get(pubkey) ?? null;
  }
  async getAccounts(pubkeys: string[]): Promise<(SolanaAccount | null)[]> {
    this.count('getAccounts');
    return pubkeys.map((p) => this.accounts.get(p) ?? null);
  }
  async getProgramAccounts(programId: string, filters: ProgramFilter[]): Promise<SolanaAccount[]> {
    this.count('getProgramAccounts');
    return [...this.accounts.values()].filter((a) => a.owner === programId && matchesFilters(a.data, filters));
  }
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: this.blockhash, lastValidBlockHeight: this.blockHeight + 150 };
  }
  async getMinimumBalanceForRentExemption(size: number): Promise<bigint> {
    return BigInt(size + 128) * 5080n * 2n;
  }
  async getGenesisHash(): Promise<string> {
    return this.genesis;
  }
  async getBalance(pubkey: string): Promise<bigint> {
    return this.accounts.get(pubkey)?.lamports ?? 0n;
  }
  async getBlockHeight(): Promise<number> {
    return this.blockHeight;
  }
  async simulate(wire: Bytes): Promise<SimulationResult> {
    this.count('simulate');
    this.simulated.push(wire);
    return this.onSimulate(wire);
  }
  async send(wire: Bytes): Promise<string> {
    this.count('send');
    const sig = this.onSend(wire);
    this.sent.push(wire);
    return sig;
  }
  async getSignatureStatus(signature: string): Promise<{ level: 'processed' | 'confirmed' | 'finalized'; err: unknown | null } | null> {
    const tx = this.transactions.get(signature);
    return tx ? { level: 'finalized', err: tx.err } : null;
  }
  async getSignaturesForAddress(address: string, opts: { until?: string; limit?: number } = {}): Promise<SignatureInfo[]> {
    this.count('getSignaturesForAddress');
    const all = this.history.get(address) ?? [];
    const stop = opts.until ? all.findIndex((s) => s.signature === opts.until) : -1;
    return (stop >= 0 ? all.slice(0, stop) : all).slice(0, opts.limit ?? 1000);
  }
  async getTransaction(signature: string): Promise<TransactionInfo | null> {
    return this.transactions.get(signature) ?? null;
  }
  subscribeProgramAccounts?(programId: string, filters: ProgramFilter[], cb: (a: SolanaAccount) => void): () => void {
    const sub = { programId, filters, cb };
    this.programSubs.push(sub);
    return () => void (this.programSubs = this.programSubs.filter((s) => s !== sub));
  }
  subscribeLogs?(mention: string, cb: (e: { signature: string; logs: string[]; err: unknown | null }) => void): () => void {
    const sub = { mention, cb };
    this.logSubs.push(sub);
    return () => void (this.logSubs = this.logSubs.filter((s) => s !== sub));
  }
}
