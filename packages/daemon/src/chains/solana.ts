/** The Solana side of the executor: the SDK's `SolanaClient` plus the operator key. */
import type { TransactionInstruction } from '@solana/web3.js';
import { type Maker, base58Encode } from '@xmrswap/protocol';
import { type CallMaterial, type FlowCall, ProgramError, SdkError, type SolanaClient, type SolanaSigner, type SwapView, solanaInstruction } from '@xmrswap/sdk';
import { PublicKey } from '@solana/web3.js';
import { type OnSigned, Refused, type SwapChain, type TxStatus } from './types.js';

export interface SolanaChainOptions {
  client: SolanaClient;
  operator: SolanaSigner;
  /** Maker PDA, base58. */
  makerPda: string;
  /** Current block height, to tell an expired blockhash from a slow transaction. Absent: a wall-clock allowance is used. */
  blockHeight?: () => Promise<number>;
  /** Milliseconds; injectable for tests. */
  clock?: () => number;
  /** How long a transaction whose blockhash validity cannot be checked is given before it counts as dead. */
  deadAfterMs?: number;
}

export class SolanaChain implements SwapChain {
  readonly chain = 'solana' as const;
  readonly client: SolanaClient;
  readonly makerPda: string;
  private readonly signer: SolanaSigner;
  private readonly o: SolanaChainOptions;
  private makerCache: { at: number; maker: Maker } | null = null;
  private burn: boolean | null = null;

  constructor(o: SolanaChainOptions) {
    this.o = o;
    this.client = o.client;
    this.signer = o.operator;
    this.makerPda = o.makerPda;
  }
  get operator(): string {
    return this.signer.publicKey;
  }
  private clock(): number {
    return (this.o.clock ?? Date.now)();
  }

  now(): Promise<bigint> {
    return this.client.chainTime('finalized');
  }
  getSwap(ref: string): Promise<SwapView | null> {
    return this.client.getSwap(ref, 'finalized');
  }
  discover(): Promise<SwapView[]> {
    return this.client.listSwapsByMaker(this.makerPda, undefined, 'finalized');
  }
  refOf(s: SwapView): string {
    return new PublicKey(s.swapRef).toBase58();
  }

  /** The maker's registry record (cached for a few seconds; `fresh` re-reads). */
  async maker(fresh = false): Promise<Maker> {
    if (!fresh && this.makerCache && this.clock() - this.makerCache.at < 5_000) return this.makerCache.maker;
    const maker = await this.client.getMaker(this.makerPda, 'finalized');
    if (!maker) throw new SdkError('NotRegistered', `no maker account at ${this.makerPda}`);
    this.makerCache = { at: this.clock(), maker };
    return maker;
  }

  /** Simulate, sign as the operator and broadcast. The signature is handed to `onSigned` before the wire transaction leaves. */
  async sendInstructions(instructions: TransactionInstruction[], onSigned: OnSigned): Promise<string> {
    let tx;
    try {
      tx = await this.client.prepare(this.signer.publicKey, instructions);
    } catch (e) {
      if (e instanceof ProgramError) throw new Refused(e.code, e.logs.slice(-3).join(' | '));
      throw e;
    }
    const { lastValidBlockHeight } = await this.client.transport.getLatestBlockhash();
    const hooked: SolanaSigner = {
      publicKey: this.signer.publicKey,
      sign: async (message) => {
        const sig = await this.signer.sign(message);
        // A byte-identical transaction on the same blockhash has the same signature: the cluster would treat it as the
        // one already sent, and a status lookup would report THAT one as this one's success. Refuse before anything is recorded.
        if ((await this.client.transport.getSignatureStatus(base58Encode(sig))) !== null) throw new Refused('DuplicateTransaction', 'identical to a transaction already sent on this blockhash; it is sent again on the next one');
        onSigned(base58Encode(sig), { lastValidBlockHeight, signedAtMs: this.clock() });
        return sig;
      },
    };
    return this.client.signAndSend(tx, [hooked]);
  }

  async send(s: SwapView, call: FlowCall, m: CallMaterial, onSigned: OnSigned): Promise<string | null> {
    const maker = await this.maker();
    if (this.burn === null) this.burn = (await this.client.getConfig('finalized'))?.splitMode === 1;
    const ix = solanaInstruction(this.client.program, s, { operator: maker.operator, payout: maker.payout, ...(this.burn ? { burn: true } : {}) }, this.signer.publicKey, call, m);
    return this.sendInstructions([ix], onSigned);
  }

  async status(tx: string, meta: Record<string, unknown> | null): Promise<TxStatus> {
    const s = await this.client.transport.getSignatureStatus(tx);
    if (s) {
      if (s.err) return { state: 'failed' };
      return s.level === 'finalized' ? { state: 'confirmed', fee: 5_000n } : { state: 'pending' };
    }
    const lastValid = typeof meta?.['lastValidBlockHeight'] === 'number' ? (meta['lastValidBlockHeight'] as number) : null;
    if (this.o.blockHeight && lastValid !== null) return { state: (await this.o.blockHeight()) > lastValid ? 'dead' : 'pending' };
    const signedAt = typeof meta?.['signedAtMs'] === 'number' ? (meta['signedAtMs'] as number) : 0;
    return { state: this.clock() - signedAt > (this.o.deadAfterMs ?? 120_000) ? 'dead' : 'pending' };
  }
}
