/**
 * The Solana client: account and event readers, the registry queries of SPEC 4.2, transaction
 * preparation (simulate, then a compute-unit limit of simulation × 1.2), sending, and the
 * polling and subscription watchers. Everything goes through a `SolanaTransport`.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, PublicKey, type Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  ACCOUNTS,
  type AccountName,
  type AccountTypes,
  type Config,
  type DecodedEvent,
  type EthBoard,
  type Maker,
  OFFSET,
  type Offer,
  type ProgramErrorName,
  type Quote,
  type Swap,
  base58Encode,
  decodeAccount,
  decodeInstructionData,
  errorName,
  parseEventLogs,
} from '@xmrswap/protocol';
import { type SwapView, viewFromSolana } from '../machine/view.js';
import { type Bytes, SdkError, bytesEqual, leToBig } from '../util.js';
import { XmrSwapProgram } from './instructions.js';
import { type Key, ethBoardPda, pk } from './pdas.js';
import { type Level, type ProgramFilter, type SolanaAccount, type SolanaTransport, matchesFilters } from './transport.js';
import { SIMULATION_CU_LIMIT, assertFits, cuLimitFromSimulation, legacyTransaction } from './tx.js';

/** Anything that can sign a transaction message: a derived session key, the daemon's operator key, a test key. */
export interface SolanaSigner {
  /** base58 */
  publicKey: string;
  sign(message: Bytes): Promise<Bytes> | Bytes;
}

/** A signer from a 32-byte Ed25519 seed (the session key of SPEC 2.2, an operator key from the keystore). */
export function seedSigner(seed: Bytes): SolanaSigner {
  if (seed.length !== 32) throw new SdkError('BadSeed', 'an Ed25519 seed is 32 bytes');
  const secret = seed.slice();
  return { publicKey: Keypair.fromSeed(secret).publicKey.toBase58(), sign: (message) => ed25519.sign(message, secret) };
}

/** Sysvar holding `Clock`: `unix_timestamp` is the i64 at offset 32. */
export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';

export interface SolanaClientOptions {
  transport: SolanaTransport;
  programId: Key;
  /** `Config.usdc_mint`; needed for USDC instructions. Read it with `getConfig()` when unknown. */
  usdcMint?: Key | null;
  /** `false` = never subscribe, poll only (svm-rpc has no WebSocket). Default: subscribe when the transport can. */
  subscriptions?: boolean;
  /** Priority fee, micro-lamports per compute unit. */
  priorityFee?: bigint | number;
}

/** A program error decoded from a failed simulation or transaction. */
export class ProgramError extends SdkError {
  readonly program: ProgramErrorName | null;
  readonly logs: string[];
  constructor(program: ProgramErrorName | null, raw: unknown, logs: string[]) {
    super(program ?? 'TransactionFailed', program ? undefined : JSON.stringify(raw));
    this.name = 'ProgramError';
    this.program = program;
    this.logs = logs;
  }
}

/** The program's error name inside a transaction error (`{ InstructionError: [i, { Custom: 6000 + n }] }`), or `null`. */
export function programErrorName(err: unknown): ProgramErrorName | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const custom = (ie?.[1] as { Custom?: number } | undefined)?.Custom;
  return typeof custom === 'number' ? errorName(custom) : null;
}

export interface OnChainMessage {
  signature: string;
  slot: number;
  blockTime: number | null;
  sender: string;
  recipient: string;
  /** The swap account named by the message, or `null`. */
  swap: string | null;
  /** The envelope bytes. */
  payload: Bytes;
}

export interface Listed<T> {
  pubkey: string;
  account: T;
}

export class SolanaClient {
  readonly transport: SolanaTransport;
  readonly program: XmrSwapProgram;
  readonly programId: string;
  readonly subscriptions: boolean;
  private readonly priorityFee: bigint | number;

  constructor(o: SolanaClientOptions) {
    this.transport = o.transport;
    this.program = new XmrSwapProgram(o.programId, o.usdcMint ?? null);
    this.programId = this.program.programId.toBase58();
    this.subscriptions = o.subscriptions !== false && typeof o.transport.subscribeProgramAccounts === 'function';
    this.priorityFee = o.priorityFee ?? 0;
  }

  /** A client for the same endpoint that knows the USDC mint (from `Config`). */
  withUsdcMint(mint: Key): SolanaClient {
    return new SolanaClient({ transport: this.transport, programId: this.programId, usdcMint: mint, subscriptions: this.subscriptions, priorityFee: this.priorityFee });
  }

  // ---------------------------------------------------------------- endpoint checks and time

  /** Refuse an endpoint that is not the expected cluster before trusting anything it says (SPEC 7.5). */
  async verifyGenesis(expected: string): Promise<void> {
    const got = await this.transport.getGenesisHash();
    if (got !== expected) throw new SdkError('WrongCluster', `the endpoint's genesis hash is ${got}, expected ${expected}`);
  }

  /** Chain time: `Clock.unix_timestamp`, the clock every deadline uses. Clients never use the local clock for a deadline. */
  async chainTime(level: Level = 'finalized'): Promise<bigint> {
    const a = await this.transport.getAccount(CLOCK_SYSVAR, level);
    if (!a || a.data.length < 40) throw new SdkError('NoClock', 'the Clock sysvar could not be read');
    return BigInt.asIntN(64, leToBig(a.data.subarray(32, 40)));
  }

  // ---------------------------------------------------------------- account readers

  private async read<N extends AccountName>(name: N, pubkey: Key, level?: Level): Promise<AccountTypes[N] | null> {
    const a = await this.transport.getAccount(pk(pubkey).toBase58(), level);
    if (!a) return null;
    if (a.owner !== this.programId) throw new SdkError('WrongOwner', `${pk(pubkey).toBase58()} is not owned by the program`);
    return decodeAccount(name, a.data);
  }
  private async list<N extends AccountName>(name: N, filters: ProgramFilter[], level?: Level): Promise<Listed<AccountTypes[N]>[]> {
    const all: ProgramFilter[] = [{ memcmp: { offset: OFFSET.discriminator, bytes: base58Encode(ACCOUNTS[name].discriminator) } }, ...filters];
    const got = await this.transport.getProgramAccounts(this.programId, all, level);
    // Never trust the node's filtering: re-check locally and decode strictly.
    return got.filter((a) => a.owner === this.programId && matchesFilters(a.data, all)).map((a) => ({ pubkey: a.pubkey, account: decodeAccount(name, a.data) }));
  }

  getConfig(level?: Level): Promise<Config | null> {
    return this.read('Config', this.program.config, level);
  }
  getMaker(makerPda: Key, level?: Level): Promise<Maker | null> {
    return this.read('Maker', makerPda, level);
  }
  getMakerByOwner(owner: Key, level?: Level): Promise<Maker | null> {
    return this.read('Maker', this.program.makerPda(owner), level);
  }
  getOffer(makerPda: Key, asset: number, direction: number, level?: Level): Promise<Offer | null> {
    return this.read('Offer', this.program.offerPda(makerPda, asset, direction), level);
  }
  getQuote(makerPda: Key, quoteId: bigint, level?: Level): Promise<Quote | null> {
    return this.read('Quote', this.program.quotePda(makerPda, quoteId), level);
  }
  getEthBoard(makerPda: Key, level?: Level): Promise<EthBoard | null> {
    return this.read('EthBoard', ethBoardPda(this.programId, makerPda), level);
  }
  getSwapAccount(swapPda: Key, level?: Level): Promise<Swap | null> {
    return this.read('Swap', swapPda, level);
  }
  /** The swap as a chain-neutral view, or `null` when the account does not exist (never opened, or closed). */
  async getSwap(swapPda: Key, level?: Level): Promise<SwapView | null> {
    const a = await this.getSwapAccount(swapPda, level);
    return a ? viewFromSolana(pk(swapPda).toBase58(), a) : null;
  }

  /** All makers (`memcmp(0, Maker discriminator)`). The endpoint must allow `getProgramAccounts`. */
  listMakers(level?: Level): Promise<Listed<Maker>[]> {
    return this.list('Maker', [], level);
  }
  /** Every offer, or one maker's (`memcmp(8, makerPda)`). */
  listOffers(makerPda?: Key, level?: Level): Promise<Listed<Offer>[]> {
    return this.list('Offer', makerPda ? [{ memcmp: { offset: OFFSET.offer.maker, bytes: pk(makerPda).toBase58() } }] : [], level);
  }
  listEthBoards(level?: Level): Promise<Listed<EthBoard>[]> {
    return this.list('EthBoard', [], level);
  }
  /** A taker's swaps (`memcmp(8, taker)`): the resume path; the nonce is in the account. */
  async listSwapsByTaker(taker: Key, level?: Level): Promise<SwapView[]> {
    const got = await this.list('Swap', [{ memcmp: { offset: OFFSET.swap.taker, bytes: pk(taker).toBase58() } }], level);
    return got.map((g) => viewFromSolana(g.pubkey, g.account));
  }
  /** A maker's swaps (`memcmp(40, makerPda)`), optionally in one state (`memcmp(72, state)`). */
  async listSwapsByMaker(makerPda: Key, state?: number, level?: Level): Promise<SwapView[]> {
    const got = await this.list('Swap', this.makerSwapFilters(makerPda, state), level);
    return got.map((g) => viewFromSolana(g.pubkey, g.account));
  }
  private makerSwapFilters(makerPda: Key, state?: number): ProgramFilter[] {
    const f: ProgramFilter[] = [{ memcmp: { offset: OFFSET.swap.maker, bytes: pk(makerPda).toBase58() } }];
    if (state !== undefined) f.push({ memcmp: { offset: OFFSET.swap.state, bytes: base58Encode(Uint8Array.of(state)) } });
    return f;
  }

  // ---------------------------------------------------------------- events and messages

  /** The program's events in a transaction's logs. Events are an index only; safety-relevant data is account state. */
  async eventsOf(signature: string): Promise<DecodedEvent[]> {
    const tx = await this.transport.getTransaction(signature);
    return tx ? parseEventLogs(tx.logs) : [];
  }

  /**
   * Messages posted to `recipient` with `post_message` (SPEC 6.2), oldest first. `until` is the
   * newest signature already processed. Failed transactions are skipped.
   */
  async listMessages(recipient: Key, opts: { until?: string; limit?: number } = {}): Promise<OnChainMessage[]> {
    const to = pk(recipient).toBase58();
    const sigs = await this.transport.getSignaturesForAddress(to, opts);
    const out: OnChainMessage[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await this.transport.getTransaction(s.signature);
      if (!tx || tx.err) continue;
      for (const ix of tx.instructions) {
        if (ix.programId !== this.programId) continue;
        let decoded;
        try {
          decoded = decodeInstructionData(ix.data);
        } catch {
          continue;
        }
        if (!decoded || decoded.name !== 'postMessage' || ix.accounts[1] !== to) continue;
        const swap = ix.accounts[2];
        out.push({ signature: s.signature, slot: tx.slot, blockTime: tx.blockTime, sender: ix.accounts[0]!, recipient: to, swap: swap && swap !== this.programId ? swap : null, payload: decoded.args.payload });
      }
    }
    return out.reverse();
  }

  // ---------------------------------------------------------------- transactions

  /**
   * Simulate the instructions, then return an unsigned legacy transaction whose compute-unit
   * limit is simulation × 1.2. A simulation that fails throws a `ProgramError` and nothing is
   * built: a secret-bearing transaction that would fail must never be broadcast.
   */
  async prepare(payer: Key, instructions: TransactionInstruction[], opts: { cuPrice?: bigint | number } = {}): Promise<Transaction> {
    const { blockhash } = await this.transport.getLatestBlockhash();
    const cuPrice = opts.cuPrice ?? this.priorityFee;
    const probe = legacyTransaction({ payer, blockhash, instructions, cuLimit: SIMULATION_CU_LIMIT, cuPrice });
    assertFits(probe);
    const sim = await this.transport.simulate(probe.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (sim.err) throw new ProgramError(programErrorName(sim.err), sim.err, sim.logs);
    if (sim.unitsConsumed === null) throw new SdkError('NoSimulation', 'the endpoint did not report consumed compute units');
    const tx = legacyTransaction({ payer, blockhash, instructions, cuLimit: cuLimitFromSimulation(sim.unitsConsumed), cuPrice });
    assertFits(tx);
    return tx;
  }

  /** Sign a prepared transaction with every required signer and send it (with preflight). Returns the signature. */
  async signAndSend(tx: Transaction, signers: SolanaSigner[]): Promise<string> {
    const message = tx.serializeMessage();
    for (const s of signers) tx.addSignature(new PublicKey(s.publicKey), Buffer.from(await s.sign(message)));
    if (!tx.verifySignatures(true)) throw new SdkError('MissingSignature', 'the transaction is not fully signed');
    return this.transport.send(tx.serialize());
  }

  /** `prepare` then `signAndSend`. The first signer pays. */
  async send(instructions: TransactionInstruction[], signers: SolanaSigner[], opts: { cuPrice?: bigint | number } = {}): Promise<string> {
    if (signers.length === 0) throw new SdkError('MissingSignature', 'a transaction needs a fee payer');
    return this.signAndSend(await this.prepare(signers[0]!.publicKey, instructions, opts), signers);
  }

  /**
   * `send`, then poll until the transaction is at `level` (no WebSocket needed). A transaction
   * that landed with an error throws a `ProgramError`; one that never lands throws `NotConfirmed`.
   */
  async sendAndConfirm(instructions: TransactionInstruction[], signers: SolanaSigner[], opts: { cuPrice?: bigint | number; level?: Level; timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
    const signature = await this.send(instructions, signers, opts);
    await this.waitConfirmed(signature, opts);
    return signature;
  }

  /** Poll `isConfirmed` until it holds. */
  async waitConfirmed(signature: string, opts: { level?: Level; timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    for (;;) {
      if (await this.isConfirmed(signature, opts.level ?? 'finalized')) return;
      if (Date.now() > deadline) throw new SdkError('NotConfirmed', `${signature} did not reach ${opts.level ?? 'finalized'} in time`);
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 200));
    }
  }

  /** Send a transaction a wallet already signed. */
  submit(wire: Bytes): Promise<string> {
    return this.transport.send(wire);
  }

  /**
   * The status of a signature at the wanted level: `true` once it is there, `false` while it is
   * not, and a `ProgramError` if the transaction failed. Callers poll; nothing here sleeps.
   */
  async isConfirmed(signature: string, level: Level = 'finalized'): Promise<boolean> {
    const s = await this.transport.getSignatureStatus(signature);
    if (!s) return false;
    if (s.err) throw new ProgramError(programErrorName(s.err), s.err, []);
    const rank: Record<Level, number> = { processed: 0, confirmed: 1, finalized: 2 };
    return rank[s.level] >= rank[level];
  }

  // ---------------------------------------------------------------- watchers

  /** Watch a maker's swaps (the daemon) or a taker's (the tab). See `SwapWatcher`. */
  watchSwaps(who: { maker: Key } | { taker: Key }, onChange: SwapListener): SwapWatcher {
    const filters: ProgramFilter[] =
      'maker' in who ? this.makerSwapFilters(who.maker) : [{ memcmp: { offset: OFFSET.swap.taker, bytes: pk(who.taker).toBase58() } }];
    return new SwapWatcher(this, [{ memcmp: { offset: OFFSET.discriminator, bytes: base58Encode(ACCOUNTS.Swap.discriminator) } }, ...filters], onChange);
  }

  /** Follow messages posted to `recipient`. See `MessageWatcher`. */
  watchMessages(recipient: Key, onMessage: (m: OnChainMessage) => void, since?: string): MessageWatcher {
    return new MessageWatcher(this, pk(recipient).toBase58(), onMessage, since);
  }
}

export type SwapListener = (change: { pubkey: string; swap: SwapView | null; previous: SwapView | null }) => void;

/**
 * Follows a filtered set of swap accounts. `poll()` is the whole truth: one full
 * `getProgramAccounts` at `finalized`, diffed against what was last reported, including accounts
 * that disappeared (a "closed" row closes the account; it is reported with `swap: null`).
 * `start()` runs `poll()` on a timer and, when the transport can subscribe, also re-polls as
 * soon as a change is pushed; the push is only a hint, so state is always read at `finalized`
 * before anyone acts on it (SPEC 3.2 rule 2).
 */
export class SwapWatcher {
  private known = new Map<string, { data: Bytes; view: SwapView }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private polling: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly client: SolanaClient,
    private readonly filters: ProgramFilter[],
    private readonly onChange: SwapListener,
  ) {}

  /** One catch-up pass. Concurrent calls collapse into one more pass after the running one. */
  poll(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.polling = this.pass().finally(() => {
      this.polling = null;
      if (this.again) {
        this.again = false;
        void this.poll().catch(() => {});
      }
    });
    return this.polling;
  }

  private async pass(): Promise<void> {
    const got = await this.client.transport.getProgramAccounts(this.client.programId, this.filters, 'finalized');
    const seen = new Set<string>();
    for (const a of got) {
      if (a.owner !== this.client.programId || !matchesFilters(a.data, this.filters)) continue;
      seen.add(a.pubkey);
      const prev = this.known.get(a.pubkey);
      if (prev && bytesEqual(prev.data, a.data)) continue;
      const view = viewFromSolana(a.pubkey, decodeAccount('Swap', a.data));
      this.known.set(a.pubkey, { data: a.data, view });
      this.onChange({ pubkey: a.pubkey, swap: view, previous: prev?.view ?? null });
    }
    for (const [pubkey, prev] of [...this.known]) {
      if (seen.has(pubkey)) continue;
      this.known.delete(pubkey);
      this.onChange({ pubkey, swap: null, previous: prev.view });
    }
  }

  /** Poll now, then every `pollMs` (default 60 s with subscriptions, 2 s without). */
  start(pollMs?: number, onError: (e: unknown) => void = () => {}): void {
    if (this.timer) return;
    const run = () => void this.poll().catch(onError);
    const subscribe = this.client.subscriptions ? this.client.transport.subscribeProgramAccounts : undefined;
    if (subscribe) this.unsubscribe = subscribe.call(this.client.transport, this.client.programId, this.filters, run);
    this.timer = setInterval(run, pollMs ?? (subscribe ? 60_000 : 2_000));
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** Follows `post_message` transactions to one recipient: poll with a signature cursor, plus a log subscription as a hint. */
export class MessageWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;

  constructor(
    private readonly client: SolanaClient,
    private readonly recipient: string,
    private readonly onMessage: (m: OnChainMessage) => void,
    /** Newest signature already processed. */
    public cursor?: string,
  ) {}

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const got = await this.client.listMessages(this.recipient, this.cursor ? { until: this.cursor } : {});
      for (const m of got) {
        this.cursor = m.signature;
        this.onMessage(m);
      }
    } finally {
      this.busy = false;
    }
  }

  start(pollMs?: number, onError: (e: unknown) => void = () => {}): void {
    if (this.timer) return;
    const run = () => void this.poll().catch(onError);
    const subscribe = this.client.subscriptions ? this.client.transport.subscribeLogs : undefined;
    if (subscribe) this.unsubscribe = subscribe.call(this.client.transport, this.recipient, run);
    this.timer = setInterval(run, pollMs ?? (subscribe ? 60_000 : 5_000));
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

export type { SolanaAccount };
