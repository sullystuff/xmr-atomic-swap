/**
 * The Ethereum side of the executor: the SDK's `EthereumClient` plus the operator key. Every
 * read is at the configured finality tag (`finalized` by default), and a transaction counts as
 * confirmed only once its block is at or below that tag.
 */
import { type Address, type Hex, ETH_NATIVE } from '@xmrswap/protocol';
import { type CallMaterial, ContractError, type EthCall, type EthMaker, type EthSigner, type EthereumClient, type FlowCall, SdkError, type SwapView, ethereumCall, hex0x } from '@xmrswap/sdk';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { type OnSigned, Refused, type SwapChain, type TxStatus } from './types.js';

const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)']);

export interface EthereumChainOptions {
  client: EthereumClient;
  operator: EthSigner;
  /** The maker's registered (owner) address. */
  maker: Address;
  finality?: 'finalized' | 'safe';
  /** The block-scan cursor, persisted by the caller. */
  cursor: { get(): bigint; set(next: bigint): void };
  clock?: () => number;
  /** A transaction that neither lands nor is replaced for this long is reported `pending` with `stuck` meta; the executor parks it. */
  stuckAfterMs?: number;
}

export class EthereumChain implements SwapChain {
  readonly chain = 'ethereum' as const;
  readonly client: EthereumClient;
  readonly makerAddress: Address;
  readonly tag: 'finalized' | 'safe';
  private readonly signer: EthSigner;
  private readonly o: EthereumChainOptions;
  private known = new Set<string>();

  constructor(o: EthereumChainOptions) {
    this.o = o;
    this.client = o.client;
    this.signer = o.operator;
    this.makerAddress = o.maker.toLowerCase() as Address;
    this.tag = o.finality ?? 'finalized';
  }
  get operator(): string {
    return this.signer.address.toLowerCase();
  }
  private clock(): number {
    return (this.o.clock ?? Date.now)();
  }

  now(): Promise<bigint> {
    return this.client.chainTime(this.tag);
  }
  getSwap(ref: string): Promise<SwapView | null> {
    return this.client.getSwap(Uint8Array.from(Buffer.from(ref.slice(2), 'hex')), this.tag, true);
  }
  refOf(s: SwapView): string {
    return hex0x(s.swapRef);
  }
  async maker(): Promise<EthMaker> {
    const m = await this.client.getMaker(this.makerAddress, this.tag);
    if (!m) throw new SdkError('NotRegistered', `no maker record for ${this.makerAddress}`);
    return m;
  }

  /** `eth_getLogs` from the stored cursor up to the finality tag: every swap id an event of this maker names. */
  async discover(): Promise<SwapView[]> {
    const head = await this.client.blockNumber(this.tag);
    const ids = new Set<string>();
    let from = this.o.cursor.get();
    while (from <= head) {
      const to = from + 1_999n < head ? from + 1_999n : head;
      for (const e of await this.client.getEvents({ fromBlock: from, toBlock: to }, { maker: this.makerAddress })) {
        const id = e.args['swapId'];
        if (typeof id === 'string') ids.add(id.toLowerCase());
      }
      from = to + 1n;
    }
    const out: SwapView[] = [];
    for (const id of ids) {
      if (this.known.has(id)) continue;
      const s = await this.getSwap(id);
      if (s) out.push(s);
      this.known.add(id);
    }
    // Only now is the range done: a crash before this line rescans it.
    this.o.cursor.set(head + 1n);
    return out;
  }

  /** Simulate (a revert is refused before signing), sign and submit. The hash is handed to `onSigned` before the raw transaction leaves. */
  sendCall(call: EthCall, onSigned: OnSigned, opts: { secret?: boolean } = {}): Promise<Hex> {
    // One at a time: the operator's nonce is read from the node inside `send`, and two sends reading it together would sign the same one.
    const next = this.sending.then(() => this.sendOne(call, onSigned, opts), () => this.sendOne(call, onSigned, opts));
    this.sending = next.catch(() => undefined);
    return next;
  }
  private sending: Promise<unknown> = Promise.resolve();
  private async sendOne(call: EthCall, onSigned: OnSigned, opts: { secret?: boolean }): Promise<Hex> {
    const hooked: EthSigner = {
      address: this.signer.address,
      signTransaction: async (tx) => {
        const raw = await this.signer.signTransaction(tx);
        onSigned(keccak256(raw), { nonce: tx.nonce, from: this.signer.address, signedAtMs: this.clock() });
        return raw;
      },
    };
    try {
      return await this.client.send(call, hooked, opts);
    } catch (e) {
      if (e instanceof ContractError) throw new Refused(e.code, e.message);
      throw e;
    }
  }

  /** Make sure the contract may pull `amount` of `token` from the operator (direction B funding with USDC). */
  async ensureAllowance(token: Address, amount: bigint, onSigned: OnSigned): Promise<Hex | null> {
    if (token === ETH_NATIVE) return null;
    const data = encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [this.signer.address, this.client.contract.address] });
    const have = BigInt((await this.client.transport.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] })) as string);
    if (have >= amount) return null;
    return this.sendCall({ to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [this.client.contract.address, amount] }), value: 0n }, onSigned);
  }

  async send(s: SwapView, call: FlowCall, m: CallMaterial, onSigned: OnSigned): Promise<string | null> {
    const built = ethereumCall(this.client.contract, s, call, m);
    if (!built) return null;
    return this.sendCall(built, onSigned, { secret: call.name === 'claim' || call.name === 'refund' });
  }

  async status(tx: string, meta: Record<string, unknown> | null): Promise<TxStatus> {
    const r = (await this.client.transport.request({ method: 'eth_getTransactionReceipt', params: [tx] })) as { blockNumber: string; status: string; gasUsed?: string; effectiveGasPrice?: string } | null;
    if (r) {
      const fee = r.gasUsed && r.effectiveGasPrice ? BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) : undefined;
      if (BigInt(r.status) !== 1n) return { state: 'failed', ...(fee !== undefined ? { fee } : {}) };
      const final = await this.client.isFinal(tx as Hex, this.tag);
      return { state: final ? 'confirmed' : 'pending', ...(fee !== undefined ? { fee } : {}) };
    }
    // No receipt: if the account's nonce has moved past this transaction's, another one took its place.
    const nonce = typeof meta?.['nonce'] === 'number' ? (meta['nonce'] as number) : null;
    const from = typeof meta?.['from'] === 'string' ? (meta['from'] as string) : this.signer.address;
    if (nonce !== null) {
      const used = Number(BigInt((await this.client.transport.request({ method: 'eth_getTransactionCount', params: [from, this.tag] })) as string));
      if (used > nonce) return { state: 'dead' };
    }
    return { state: 'pending' };
  }

  balanceOf(token: Address, account: Address): Promise<bigint> {
    if (token === ETH_NATIVE) return this.client.transport.request({ method: 'eth_getBalance', params: [account, 'latest'] }).then((v) => BigInt(v as string));
    const data = encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [account] });
    return this.client.transport.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] }).then((v) => BigInt(v as string));
  }
  /** A plain transfer of ETH or an ERC-20 (rebalancer `sendEth`). */
  transferCall(token: Address, to: Address, amount: bigint): EthCall {
    if (token === ETH_NATIVE) return { to, data: '0x', value: amount };
    return { to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] }), value: 0n };
  }
}
