/**
 * The two chains as the service sees them: read a swap and the clock, read the watcher's fee
 * balance, and build, broadcast and look up **one kind of transaction: `freeze`**.
 *
 * Nothing here trusts the endpoint with a decision that costs more than a bounded fee. The
 * program id, the contract address and the chain id are pinned from the configuration, never
 * read from the endpoint; the compute-unit limit, the gas limit and the fee per gas are bounded;
 * and the signature comes from `WatcherKeys`, which re-checks the finished transaction and
 * signs nothing that is not a freeze of the named swap.
 *
 * Building and broadcasting stay two steps (the SDK's one-call `send` is not used): the signed
 * bytes are journaled between them, which is what makes a restart send the same transaction
 * instead of a second one. On Solana the unsigned transaction comes from the SDK's bounded
 * `prepare`; on Ethereum it is assembled here with a fixed gas limit and, when a pending one
 * must be outbid, the same nonce.
 */
import { PublicKey } from '@solana/web3.js';
import { type ChainName, base58Encode } from '@xmrswap/protocol';
import { type Bytes, ETH_WATCHER_GAS, type EthTransport, EthereumClient, ProgramError, SdkError, SolanaClient, type SolanaTransport, type SwapView, hex, watchDeployment } from '@xmrswap/sdk';
import { keccak256 } from 'viem';
import type { EthereumSettings, SolanaSettings } from './config.js';
import type { EthFreezeTx, EthereumPins, SolanaPins, WatcherKeys } from './keys.js';

/** A signed freeze, ready to journal and then broadcast. */
export interface SignedFreeze {
  /** Signature (Solana, base58) or transaction hash (Ethereum). */
  txId: string;
  wire: Bytes;
  /** The most this transaction can cost, in lamports or wei. */
  maxFee: bigint;
  nonce: number | null;
  feePerGas: bigint | null;
  tipPerGas: bigint | null;
  /** Solana: the block height after which this transaction can no longer land. */
  validUntil: number | null;
}

/** The chain would refuse the freeze now (simulation failed). Nothing was signed. */
export class FreezeRefused extends Error {
  constructor(readonly code: string) {
    super(`the chain refuses a freeze now: ${code}`);
    this.name = 'FreezeRefused';
  }
}
/** The fee the network asks is above what the operator allows. Nothing was signed. */
export class FeeAboveLimit extends Error {
  readonly code = 'FeeAboveLimit';
  constructor() {
    super('the network fee is above the configured maximum');
    this.name = 'FeeAboveLimit';
  }
}

export interface ChainPort {
  readonly chain: ChainName;
  /** The watcher's own key on this chain, as a swap names it. */
  readonly address: string;
  /** The deployment a watch request must be bound to (SDK `watchDeployment`): the program id, or `chainId:contract`. Pinned from the configuration. */
  readonly deployment: string;
  /** Throws unless the endpoint is the configured cluster or chain. */
  verifyEndpoint(): Promise<void>;
  /** The swap at the configured finality, or `null` when there is none. */
  readSwap(swapRef: Bytes): Promise<SwapView | null>;
  /** Chain time at the same finality. */
  now(): Promise<bigint>;
  balance(): Promise<bigint>;
  /** The most one freeze can cost under the configured bounds: what a watch reserves. */
  freezeReserve(): bigint;
  /**
   * Simulate, bound and sign a freeze of `swap`. `replace` (Ethereum) reuses the nonce of an
   * earlier transaction with a higher fee, so at most one of the two can be mined.
   * `nonceFloor` is one above the highest nonce the journal still holds open.
   */
  buildFreeze(swap: SwapView, o?: { replace?: { nonce: number; feePerGas: bigint; tipPerGas: bigint }; nonceFloor?: number }): Promise<SignedFreeze>;
  /** Hand a signed freeze to the endpoint. Sending the same bytes twice is harmless. */
  broadcast(wire: Bytes): Promise<void>;
  lookup(txId: string): Promise<'landed' | 'failed' | 'unknown'>;
  /**
   * `true` (Ethereum): a pending transaction stays valid and can only be replaced at its nonce.
   * `false` (Solana): it dies with its blockhash (`expired`), and only then may a fresh one be built.
   */
  readonly replaceByNonce: boolean;
  /** Whether a transaction valid until block height `validUntil` can no longer land. */
  expired(validUntil: number | null): Promise<boolean>;
}

const LAMPORTS_PER_SIGNATURE = 5_000n;

export class SolanaChain implements ChainPort {
  readonly chain = 'solana' as const;
  readonly replaceByNonce = false;
  readonly address: string;
  readonly deployment: string;
  private readonly client: SolanaClient;
  private readonly pins: SolanaPins;

  constructor(
    private readonly transport: SolanaTransport,
    private readonly settings: Omit<SolanaSettings, 'rpcUrl'>,
    private readonly keys: WatcherKeys,
  ) {
    this.address = keys.solana;
    this.deployment = watchDeployment({ programId: settings.programId });
    // The SDK bounds what `prepare` builds: a simulation that reports more compute units than the bound is refused, not followed.
    this.client = new SolanaClient({ transport, programId: settings.programId, subscriptions: false, priorityFee: settings.priorityFeeMicroLamports, maxComputeUnits: settings.maxComputeUnits, maxPriorityFee: settings.priorityFeeMicroLamports });
    this.pins = { programId: settings.programId, maxComputeUnits: settings.maxComputeUnits, maxPriorityFeeMicroLamports: settings.priorityFeeMicroLamports };
  }

  async verifyEndpoint(): Promise<void> {
    if (this.settings.genesisHash) await this.client.verifyGenesis(this.settings.genesisHash);
    else await this.transport.getGenesisHash();
  }
  readSwap(swapRef: Bytes): Promise<SwapView | null> {
    return this.client.getSwap(new PublicKey(swapRef).toBase58(), this.settings.commitment);
  }
  now(): Promise<bigint> {
    return this.client.chainTime(this.settings.commitment);
  }
  balance(): Promise<bigint> {
    return this.client.getBalance(this.address, 'confirmed');
  }
  private fee(units: number): bigint {
    return LAMPORTS_PER_SIGNATURE + (BigInt(units) * this.settings.priorityFeeMicroLamports + 999_999n) / 1_000_000n;
  }
  freezeReserve(): bigint {
    return this.fee(this.settings.maxComputeUnits);
  }

  async buildFreeze(swap: SwapView): Promise<SignedFreeze> {
    if (swap.chain !== 'solana') throw new SdkError('WrongChain', 'not a Solana swap');
    const ix = this.client.program.freeze({ caller: this.address, swap: new PublicKey(swap.swapRef), maker: swap.maker });
    let tx;
    try {
      // Simulates first (a freeze the program would refuse is never signed) and sets the compute-unit limit within the bound.
      tx = await this.client.prepare(this.address, [ix]);
    } catch (e) {
      if (e instanceof ProgramError) throw new FreezeRefused(e.program ?? 'SimulationFailed');
      throw e;
    }
    const units = tx.instructions[0]!.data.readUInt32LE(1);
    const { wire, signature } = this.keys.signSolanaFreeze(tx, swap.swapRef, this.pins);
    return { txId: base58Encode(signature), wire, maxFee: this.fee(units), nonce: null, feePerGas: null, tipPerGas: null, validUntil: tx.lastValidBlockHeight ?? null };
  }
  async broadcast(wire: Bytes): Promise<void> {
    await this.transport.send(wire);
  }
  async lookup(txId: string): Promise<'landed' | 'failed' | 'unknown'> {
    const s = await this.transport.getSignatureStatus(txId);
    return s === null ? 'unknown' : s.err ? 'failed' : 'landed';
  }
  /** By block height, not by wall clock: a transaction is dead once the chain passes its blockhash's last valid height. */
  async expired(validUntil: number | null): Promise<boolean> {
    return validUntil !== null && (await this.client.blockhashExpired(validUntil, 'finalized'));
  }
}

/** The gas limit of a freeze: the SDK's measured figure plus a quarter. Never taken from the endpoint. */
export const ETH_FREEZE_GAS_LIMIT = (ETH_WATCHER_GAS.freeze * 125n) / 100n;

export class EthereumChain implements ChainPort {
  readonly chain = 'ethereum' as const;
  readonly replaceByNonce = true;
  readonly address: `0x${string}`;
  readonly deployment: string;
  private readonly client: EthereumClient;
  private readonly pins: EthereumPins;

  constructor(
    private readonly transport: EthTransport,
    private readonly settings: Omit<EthereumSettings, 'rpcUrl'>,
    private readonly keys: WatcherKeys,
  ) {
    this.address = keys.ethereum;
    this.deployment = watchDeployment({ chainId: settings.chainId, contract: settings.contract });
    this.client = new EthereumClient({ transport, contract: settings.contract, chainId: settings.chainId });
    this.pins = { contract: settings.contract, chainId: settings.chainId, maxGas: ETH_FREEZE_GAS_LIMIT, maxFeePerGas: settings.maxFeePerGas };
  }

  verifyEndpoint(): Promise<void> {
    return this.client.verifyChainId(this.settings.chainId);
  }
  readSwap(swapRef: Bytes): Promise<SwapView | null> {
    return this.client.getSwap(swapRef, this.settings.readTag);
  }
  now(): Promise<bigint> {
    return this.client.chainTime(this.settings.readTag);
  }
  async balance(): Promise<bigint> {
    return BigInt((await this.transport.request({ method: 'eth_getBalance', params: [this.address, 'latest'] })) as string);
  }
  freezeReserve(): bigint {
    return ETH_FREEZE_GAS_LIMIT * this.settings.maxFeePerGas;
  }

  async buildFreeze(swap: SwapView, o: { replace?: { nonce: number; feePerGas: bigint; tipPerGas: bigint }; nonceFloor?: number } = {}): Promise<SignedFreeze> {
    if (swap.chain !== 'ethereum') throw new SdkError('WrongChain', 'not an Ethereum swap');
    const call = this.client.contract.freeze(swap.swapRef);
    try {
      await this.client.simulate(call, this.address);
    } catch (e) {
      throw new FreezeRefused(typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'CallFailed');
    }
    const head = (await this.transport.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as { baseFeePerGas?: string } | null;
    const base = BigInt(head?.baseFeePerGas ?? '0x0');
    const tip = this.settings.priorityFeePerGas;
    // Twice the base fee plus the tip, as the SDK prices a call; never above the operator's maximum.
    let feePerGas = base * 2n + tip;
    if (feePerGas > this.settings.maxFeePerGas) feePerGas = this.settings.maxFeePerGas;
    if (base + tip > this.settings.maxFeePerGas) throw new FeeAboveLimit();
    let tipNow = tip;
    let nonce: number;
    if (o.replace) {
      // A replacement must pay at least 12.5% more in both fee fields; the same nonce means at most one of the two is mined.
      const bump = (v: bigint): bigint => (v * 1125n) / 1000n + 1n;
      if (bump(o.replace.feePerGas) > this.settings.maxFeePerGas) throw new FeeAboveLimit();
      if (feePerGas < bump(o.replace.feePerGas)) feePerGas = bump(o.replace.feePerGas);
      tipNow = bump(o.replace.tipPerGas) > tip ? bump(o.replace.tipPerGas) : tip;
      if (tipNow > feePerGas) tipNow = feePerGas;
      nonce = o.replace.nonce;
    } else {
      const pending = Number(BigInt((await this.transport.request({ method: 'eth_getTransactionCount', params: [this.address, 'pending'] })) as string));
      nonce = Math.max(pending, o.nonceFloor ?? 0);
    }
    const tx: EthFreezeTx = { chainId: this.settings.chainId, nonce, to: call.to, data: call.data, value: 0n, gas: ETH_FREEZE_GAS_LIMIT, maxFeePerGas: feePerGas, maxPriorityFeePerGas: tipNow };
    const raw = await this.keys.signEthereumFreeze(tx, swap.swapRef, this.pins);
    return { txId: keccak256(raw), wire: Uint8Array.from(Buffer.from(raw.slice(2), 'hex')), maxFee: ETH_FREEZE_GAS_LIMIT * feePerGas, nonce, feePerGas, tipPerGas: tipNow, validUntil: null };
  }
  async broadcast(wire: Bytes): Promise<void> {
    try {
      await this.transport.request({ method: 'eth_sendRawTransaction', params: [`0x${hex(wire)}`] });
    } catch (e) {
      // The endpoint already holds these exact bytes: that is what a rebroadcast after a restart looks like.
      if (/already known|known transaction|already imported|already in mempool/i.test(String((e as Error)?.message))) return;
      throw e;
    }
  }
  async expired(): Promise<boolean> {
    return false;
  }
  async lookup(txId: string): Promise<'landed' | 'failed' | 'unknown'> {
    const r = (await this.transport.request({ method: 'eth_getTransactionReceipt', params: [txId] })) as { status: string } | null;
    return r === null ? 'unknown' : BigInt(r.status) === 1n ? 'landed' : 'failed';
  }
}

/** A plain JSON-RPC transport over `fetch` for an Ethereum endpoint. The URL is never logged or put in an error. */
export function httpEthTransport(url: string, timeoutMs = 20_000): EthTransport {
  let id = 0;
  return {
    async request({ method, params }) {
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw Object.assign(new Error(`${method}: the Ethereum endpoint is unreachable`), { code: 'unreachable' });
      }
      if (!res.ok) throw Object.assign(new Error(`${method}: HTTP ${res.status}`), { code: 'unreachable' });
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code, data: body.error.data });
      return body.result;
    },
  };
}
