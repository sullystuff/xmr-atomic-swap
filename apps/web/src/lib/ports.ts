/**
 * The seams between the UI's engine and the outside world. Everything the engine does to a
 * chain or to Monero goes through one of these, so the unit tests can stand in a model-backed
 * chain and scripted Monero nodes while the browser runs the real SDK clients.
 */
import type { Transaction, TransactionInstruction } from '@solana/web3.js';
import { type DerivedKeys, type SweepOutcome, type SweepParams, sweepJoint } from '@xmrswap/core-wasm';
import type { Address, ChainName, Hex } from '@xmrswap/protocol';
import {
  type CallMaterial,
  type Decision,
  type EthCall,
  EthereumClient,
  type EthTransport,
  type FoundDeposit,
  SolanaClient,
  type SwapView,
  type VerifyLockArgs,
  type VerifyLockResult,
  daemonNode,
  ethereumCall,
  findDeposits,
  hex,
  hex0x,
  seedSigner,
  solanaInstruction,
  unhex,
  verifyLock,
} from '@xmrswap/sdk';
import { PublicKey } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { TransactionExpired, plainSigningError } from './errors.js';

export type CallDecision = Extract<Decision, { do: 'call' }>;

/** The user's Solana wallet, reduced to what the page needs: it signs, the page sends. */
export interface SolanaWallet {
  address: string;
  signTransaction(tx: Transaction): Promise<Transaction>;
  /** The Wallet Standard `solana:signMessage` feature, when the wallet has it (needed only for the wallet-derived key). */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}
/** The user's Ethereum wallet (an injected EIP-1193 provider): it signs and sends. */
export interface EthereumWallet {
  address: Address;
  sendTransaction(call: EthCall): Promise<Hex>;
}

export class WalletNeeded extends Error {
  constructor(readonly chain: ChainName) {
    super(`Connect your ${chain === 'solana' ? 'Solana' : 'Ethereum'} wallet to send this transaction.`);
  }
}

export interface ChainPort {
  readonly chain: ChainName;
  /** Chain time in seconds. Every deadline uses it; the local clock never does. */
  now(): Promise<bigint>;
  listSwaps(taker: string): Promise<SwapView[]>;
  getSwap(ref: string): Promise<SwapView | null>;
  /**
   * Carry out one call the flow proposed. Session-key calls need no wallet prompt. A call the
   * session key cannot send (its budget was swept back by a refund or claim, or the call is the
   * taker's own) throws `WalletNeeded` unless `opts.wallet` is set: the background loop never
   * opens a wallet prompt by itself; the user clicks first. Resolves once the call is confirmed.
   */
  exec(s: SwapView, d: CallDecision, keys: DerivedKeys, m: CallMaterial, opts?: { wallet?: boolean }): Promise<string>;
  /**
   * Chains whose state is acted on only once final (Ethereum): the same swap as the newest block
   * shows it, for display only. The engine never decides from it; it lets the page say "the
   * maker's deposit is in a block, waiting for it to be final" instead of looking idle.
   */
  peek?(ref: string): Promise<SwapView | null>;
  /** How far finality trails the head right now, on the chain's clock: the time of the newest block and of the finalized one. */
  finality?(): Promise<{ latestTime: bigint; finalizedTime: bigint }>;
}

/** The display reference of a swap: the swap PDA in base58 (Solana) or the 0x swap id (Ethereum). */
export const swapRefOf = (s: SwapView): string => (s.chain === 'solana' ? new PublicKey(s.swapRef).toBase58() : hex0x(s.swapRef));

// ------------------------------------------------------------------ Solana

export class SolanaPort implements ChainPort {
  readonly chain = 'solana' as const;
  private rent0: bigint | null = null;
  private burn: boolean | null = null;
  constructor(
    readonly client: SolanaClient,
    private readonly wallet: () => SolanaWallet | null,
    private readonly pollMs = 400,
  ) {}

  now(): Promise<bigint> {
    return this.client.chainTime();
  }
  listSwaps(taker: string): Promise<SwapView[]> {
    return this.client.listSwapsByTaker(taker);
  }
  getSwap(ref: string): Promise<SwapView | null> {
    return this.client.getSwap(ref);
  }

  /** Sign with the user's wallet (one prompt), submit, and wait for confirmation. The transaction is simulated first. */
  async sendWithWallet(instructions: TransactionInstruction[]): Promise<string> {
    const w = this.wallet();
    if (!w) throw new WalletNeeded('solana');
    let tx: Transaction;
    try {
      tx = await this.client.prepare(w.address, instructions);
    } catch (e) {
      throw plainSigningError(e);
    }
    const lastValid = tx.lastValidBlockHeight;
    const signed = await w.signTransaction(tx);
    const sig = await this.client.submit(Uint8Array.from(signed.serialize()));
    // The transaction is dead only when its blockhash has expired by block height, never by a
    // wall-clock timeout: until then it may still land, and sending a second one could do the thing twice.
    for (;;) {
      if (await this.client.isConfirmed(sig)) return sig;
      if (lastValid !== undefined && (await this.client.blockhashExpired(lastValid))) {
        if (await this.client.isConfirmed(sig)) return sig;
        throw new TransactionExpired();
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** Whether the session key can still pay a fee and stay rent-exempt. */
  private async sessionFunded(sessionKey: string): Promise<boolean> {
    this.rent0 ??= await this.client.transport.getMinimumBalanceForRentExemption(0);
    const a = await this.client.transport.getAccount(sessionKey);
    return a !== null && a.lamports >= this.rent0 + 10_000n;
  }

  async exec(s: SwapView, d: CallDecision, keys: DerivedKeys, m: CallMaterial, opts: { wallet?: boolean } = {}): Promise<string> {
    const maker = await this.client.getMaker(s.maker);
    if (!maker) throw new Error('The maker record of this swap is gone from the registry.');
    if (this.burn === null) this.burn = ((await this.client.getConfig())?.splitMode ?? 0) === 1;
    const wallets = { operator: maker.operator, payout: maker.payout, ...(this.burn ? { burn: true } : {}) };
    const session = seedSigner(keys.sessionSecret);
    const bySession = d.caller === 'session' || (d.caller === 'anyone' && (await this.sessionFunded(session.publicKey)));
    if (bySession) {
      const ix = solanaInstruction(this.client.program, s, wallets, session.publicKey, d.call, m);
      return this.client.sendAndConfirm([ix], [session], { intervalMs: this.pollMs }).catch((e: unknown) => {
        throw plainSigningError(e);
      });
    }
    const w = this.wallet();
    if (!w || !opts.wallet) throw new WalletNeeded('solana');
    return this.sendWithWallet([solanaInstruction(this.client.program, s, wallets, w.address, d.call, { ...m, destination: m.destination ?? w.address })]);
  }
}

// ------------------------------------------------------------------ Ethereum

export class EthereumPort implements ChainPort {
  readonly chain = 'ethereum' as const;
  constructor(
    readonly client: EthereumClient,
    private readonly wallet: () => EthereumWallet | null,
    private readonly pollMs = 2000,
  ) {}

  now(): Promise<bigint> {
    return this.client.chainTime('latest');
  }
  async listSwaps(taker: string): Promise<SwapView[]> {
    const ids = await this.client.swapsOf(taker as Address);
    const views = await Promise.all(ids.map((id) => this.client.getSwap(unhex(id.slice(2)), undefined, true)));
    return views.filter((v): v is SwapView => v !== null);
  }
  getSwap(ref: string): Promise<SwapView | null> {
    return this.client.getSwap(unhex(ref.replace(/^0x/, '')), undefined, true);
  }

  peek(ref: string): Promise<SwapView | null> {
    return this.client.getSwap(unhex(ref.replace(/^0x/, '')), 'latest');
  }
  async finality(): Promise<{ latestTime: bigint; finalizedTime: bigint }> {
    const [latestTime, finalizedTime] = await Promise.all([this.client.chainTime('latest'), this.client.chainTime('finalized')]);
    return { latestTime, finalizedTime };
  }

  async sendWithWallet(call: EthCall): Promise<Hex> {
    const w = this.wallet();
    if (!w) throw new WalletNeeded('ethereum');
    // The RPC must be on the chain this site is for before anything is simulated or signed.
    if (this.client.chainId !== null) {
      try {
        await this.client.verifyChainId(this.client.chainId);
      } catch (e) {
        throw plainSigningError(e);
      }
    }
    // Never hand the wallet a call that would revert: a failed transaction still publishes its arguments.
    await this.client.simulate(call, w.address);
    const hash = await w.sendTransaction(call);
    await this.client.waitMined(hash, { intervalMs: this.pollMs });
    return hash;
  }

  private async sessionFunded(address: Address): Promise<boolean> {
    const bal = (await this.client.transport.request({ method: 'eth_getBalance', params: [address, 'latest'] })) as string;
    return BigInt(bal) > 0n;
  }

  async exec(s: SwapView, d: CallDecision, keys: DerivedKeys, m: CallMaterial, opts: { wallet?: boolean } = {}): Promise<string> {
    const call = ethereumCall(this.client.contract, s, d.call, { ...m, destination: m.destination ?? s.taker });
    if (!call) return '';
    const session = privateKeyToAccount(hex0x(keys.sessionSecret));
    const bySession = d.caller === 'session' || (d.caller === 'anyone' && (await this.sessionFunded(session.address)));
    if (bySession) {
      // Signed only for the pinned chain id, within the SDK's gas cap for this call and its fee cap.
      const hash = await this.client.send(call, session, { secret: d.secret }).catch((e: unknown) => {
        throw plainSigningError(e);
      });
      await this.client.waitMined(hash, { intervalMs: this.pollMs });
      return hash;
    }
    if (!opts.wallet) throw new WalletNeeded('ethereum');
    return this.sendWithWallet(call);
  }
}

/** An `EthTransport` over plain JSON-RPC with `fetch`: the user's configured Ethereum RPC. */
export function httpEthTransport(url: string, fetchFn: typeof fetch = fetch): EthTransport {
  let id = 0;
  return {
    async request({ method, params = [] }) {
      const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (!res.ok) throw new Error(`Ethereum RPC: HTTP ${res.status}`);
      const j = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
      return j.result;
    },
  };
}

// ------------------------------------------------------------------ Monero

export type TxStatus = 'unknown' | 'pool' | 'mined';

/** What the engine asks of Monero. Verification runs against every configured node; the sweep uses the first (the user's most trusted). */
export interface MoneroPort {
  /** Whether the configured nodes satisfy the node policy; a message when they do not. */
  policyProblem(): string | null;
  verify(a: Omit<VerifyLockArgs, 'nodes' | 'ownNode'>): Promise<VerifyLockResult>;
  findDeposits(a: { viewPriv: string; spendPub: string; fromHeight: number }): Promise<{ tipHeight: number; found: FoundDeposit[] }>;
  height(): Promise<number>;
  txStatus(txid: string): Promise<TxStatus>;
  sweep(p: Omit<SweepParams, 'daemonUrl' | 'network' | 'publish'>): Promise<SweepOutcome>;
}

export function moneroPort(cfg: () => { nodes: string[]; ownNode: boolean; network: SweepParams['network'] }): MoneroPort {
  // A site-relative node (`/monero/0`: the relay's proxy on this origin) is resolved against the page.
  const absolute = (n: string): string => (n.startsWith('/') && typeof location !== 'undefined' ? new URL(n, location.origin).toString() : n);
  const nodes = () => cfg().nodes.map((n) => absolute(n.trim()).replace(/\/+$/, '')).filter(Boolean);
  const policyProblem = (): string | null => {
    const n = nodes();
    if (n.length === 0) return 'No Monero node is configured.';
    if (n.length === 1 && !cfg().ownNode) return 'Only one Monero node is configured and it is not marked as your own.';
    return null;
  };
  return {
    policyProblem,
    verify: (a) => verifyLock({ ...a, nodes: nodes(), ownNode: cfg().ownNode }),
    async findDeposits(a) {
      const r = await findDeposits({ node: nodes()[0]!, ...a });
      return { tipHeight: r.tipHeight, found: r.found };
    },
    async height() {
      return (await daemonNode(nodes()[0]!).info()).height;
    },
    async txStatus(txid) {
      const e = await daemonNode(nodes()[0]!).tx(txid);
      return e === null ? 'unknown' : e.in_pool ? 'pool' : 'mined';
    },
    sweep: (p) => sweepJoint({ ...p, daemonUrl: nodes()[0]!, network: cfg().network, publish: true }),
  };
}

export { hex };
