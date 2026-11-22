/**
 * The Ethereum client: calldata builders for every function of the frozen ABI, storage readers
 * (state is read with `eth_call`, at the `finalized` tag before anyone acts; logs are only an
 * index), event decoding, a log watcher with a cursor, and the finality check of SPEC 3.2.
 *
 * The seam is `EthTransport`, an EIP-1193 `request` function: a viem transport, a wallet
 * provider, anvil, or a fake in tests. The client holds no key.
 */
import type { EthApproval, EthQuote } from '@xmrswap/core-wasm';
import { type Address, ETH_NATIVE, type Hex, IXmrSwapAbi } from '@xmrswap/protocol';
import { type Abi, decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData } from 'viem';
import { type EthSwapStruct, type SwapView, viewFromEthereum } from '../machine/view.js';
import { EMPTY_ETH_APPROVAL, approvalMessage, quoteMessage } from '../signing/eip712.js';
import { type Bytes, SdkError, beToBig, hex0x, leToBig, unhex } from '../util.js';

const ABI = IXmrSwapAbi as unknown as Abi;

/** EIP-1193. */
export interface EthTransport {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export type BlockTag = 'latest' | 'safe' | 'finalized' | bigint;
const tagParam = (t: BlockTag): string => (typeof t === 'bigint' ? `0x${t.toString(16)}` : t);

/** A call to send: `to`, calldata and the ETH value that must accompany it. */
export interface EthCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface TakerKeysArg {
  spendPub: Bytes;
  /** `keyAddr` and `keyAddr2` of the taker's secp256k1 twin (`twinCommitments`). */
  key: Address;
  key2: Address;
  /** `v_T` in clear (direction A); 32 zero bytes in direction B. */
  viewShare: Bytes;
  encKey: Bytes;
  makerEncVersion: number;
  /** The maker's X25519 key of that version, as read from the Solana registry. */
  makerEncKey: Bytes;
}
export interface PoolLeafArg {
  index: number;
  key: Address;
  key2: Address;
  spendPub: Bytes;
  /** Sibling hashes, bottom-up. */
  proof: Bytes[];
}

/** The `Maker` record of the contract (SPEC 5.2). */
export interface EthMaker {
  operator: Address;
  payout: Address;
  quoteEpoch: number;
  approvalEpoch: number;
  paused: boolean;
  registeredAt: bigint;
  /** Linked Solana owner key, 32 bytes hex; zero = none. */
  solanaOwner: Hex;
  solanaOwnerNext: Hex;
  solanaOwnerNextAt: bigint;
  openPending: number;
  responseSecsSum: bigint;
  counters: number[];
}

export interface DecodedEthEvent {
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: string;
  removed?: boolean;
}

/** A revert decoded against the contract's custom errors. `code` is the error name (`BadState`, `TooLate`, …). */
export class ContractError extends SdkError {
  constructor(name: string, detail?: string) {
    super(name, detail);
    this.name = 'ContractError';
  }
}

/** The custom error name inside revert data, or `null`. */
export function contractErrorName(data: unknown): string | null {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null;
  try {
    return decodeErrorResult({ abi: ABI, data: data as Hex }).errorName;
  } catch {
    return null;
  }
}
function revertData(e: unknown): unknown {
  // Providers nest revert data differently; look two levels down.
  const x = e as { data?: unknown; cause?: { data?: unknown }; error?: { data?: unknown } };
  const d = x?.data ?? x?.cause?.data ?? x?.error?.data;
  return typeof d === 'object' && d !== null ? (d as { data?: unknown }).data : d;
}

const b32 = (b: Bytes): Hex => {
  if (b.length !== 32) throw new SdkError('BadLength', 'expected 32 bytes');
  return hex0x(b);
};
/** A spend share (32 little-endian bytes) as the `uint256` the contract takes. */
export const secretToUint = (secret: Bytes): bigint => {
  if (secret.length !== 32) throw new SdkError('BadLength', 'a spend share is 32 bytes');
  return leToBig(secret);
};

/** Calldata builders bound to one deployment. Pure: no transport, no key. */
export class XmrSwapContract {
  readonly address: Address;
  /** The one USDC address the contract accepts; needed only to tell ETH from USDC legs. */
  constructor(address: Address) {
    this.address = address.toLowerCase() as Address;
  }

  /** Encode any function of the frozen ABI. */
  encode(functionName: string, args: unknown[], value = 0n): EthCall {
    return { to: this.address, data: encodeFunctionData({ abi: ABI, functionName, args }), value };
  }

  // ---- registry
  registerMaker(operator: Address, payout: Address, solanaOwner: Bytes): EthCall {
    return this.encode('registerMaker', [operator, payout, b32(solanaOwner)]);
  }
  setOperator(operator: Address): EthCall {
    return this.encode('setOperator', [operator]);
  }
  setPayout(payout: Address): EthCall {
    return this.encode('setPayout', [payout]);
  }
  /** 32 bytes of the Solana owner key; zeros = unlink. A change takes effect after `LINK_DELAY_SECS`. */
  setSolanaLink(solanaOwner: Bytes): EthCall {
    return this.encode('setSolanaLink', [b32(solanaOwner)]);
  }
  setPaused(paused: boolean): EthCall {
    return this.encode('setPaused', [paused]);
  }
  bumpEpochs(quotes: boolean, approvals: boolean): EthCall {
    return this.encode('bumpEpochs', [quotes, approvals]);
  }
  cancelQuote(quoteId: bigint): EthCall {
    return this.encode('cancelQuote', [quoteId]);
  }
  revokeApproval(approvalId: Bytes): EthCall {
    return this.encode('revokeApproval', [b32(approvalId)]);
  }

  // ---- opening
  private takerKeys(tk: TakerKeysArg) {
    return { spendPub: b32(tk.spendPub), key: tk.key, key2: tk.key2, viewShare: b32(tk.viewShare), encKey: b32(tk.encKey), makerEncVersion: tk.makerEncVersion, makerEncKey: b32(tk.makerEncKey) };
  }
  /**
   * `lock` (A1). `amount` is what the quote prices `xmr` at (`priceEthQuote`); it decides the
   * value: ETH needs `amount + sessionBudget`, USDC needs `sessionBudget` (and an allowance).
   * Without an approval the contract takes an empty one and an empty signature.
   */
  lock(p: {
    quote: EthQuote;
    sig: Bytes;
    xmr: bigint;
    amount: bigint;
    maxPay: bigint;
    swapNonce: Bytes;
    sessionKey: Address;
    sessionBudget: bigint;
    takerKeys: TakerKeysArg;
    leaf: PoolLeafArg;
    approval?: { approval: EthApproval; sig: Bytes };
  }): EthCall {
    if (p.swapNonce.length !== 16) throw new SdkError('BadNonce', 'a swap nonce is 16 bytes');
    if (p.amount > p.maxPay) throw new SdkError('PriceMoved', 'the amount is above maxPay');
    const eth = beToBig(p.quote.token) === 0n;
    return this.encode(
      'lock',
      [
        quoteMessage(p.quote),
        hex0x(p.sig),
        p.xmr,
        p.maxPay,
        hex0x(p.swapNonce),
        p.sessionKey,
        p.sessionBudget,
        this.takerKeys(p.takerKeys),
        { index: p.leaf.index, key: p.leaf.key, key2: p.leaf.key2, spendPub: b32(p.leaf.spendPub), proof: p.leaf.proof.map(b32) },
        approvalMessage(p.approval?.approval ?? EMPTY_ETH_APPROVAL),
        hex0x(p.approval?.sig ?? new Uint8Array(0)),
      ],
      (eth ? p.amount : 0n) + p.sessionBudget,
    );
  }
  /** `take` (B1). `deposit` is the take deposit (`priceEthQuote(...).deposit`): ETH needs `deposit + sessionBudget`. */
  take(p: {
    quote: EthQuote;
    sig: Bytes;
    xmr: bigint;
    deposit: bigint;
    minReceive: bigint;
    swapNonce: Bytes;
    sessionKey: Address;
    sessionBudget: bigint;
    takerKeys: TakerKeysArg;
    approval?: { approval: EthApproval; sig: Bytes };
  }): EthCall {
    if (p.swapNonce.length !== 16) throw new SdkError('BadNonce', 'a swap nonce is 16 bytes');
    const eth = beToBig(p.quote.token) === 0n;
    return this.encode(
      'take',
      [quoteMessage(p.quote), hex0x(p.sig), p.xmr, p.minReceive, hex0x(p.swapNonce), p.sessionKey, p.sessionBudget, this.takerKeys(p.takerKeys), approvalMessage(p.approval?.approval ?? EMPTY_ETH_APPROVAL), hex0x(p.approval?.sig ?? new Uint8Array(0))],
      (eth ? p.deposit : 0n) + p.sessionBudget,
    );
  }
  approve(swapId: Bytes, expectedOpen: Bytes): EthCall {
    return this.encode('approve', [b32(swapId), b32(expectedOpen)]);
  }
  /** `fund` (B5). ETH: `value` = `amount`; USDC: zero value and an allowance from the operator. */
  fund(p: { swapId: Bytes; expectedOpen: Bytes; key: Address; key2: Address; spendPub: Bytes; viewShare: Bytes; amount: bigint; token: Address }): EthCall {
    return this.encode('fund', [b32(p.swapId), b32(p.expectedOpen), p.key, p.key2, b32(p.spendPub), b32(p.viewShare)], p.token.toLowerCase() === ETH_NATIVE ? p.amount : 0n);
  }
  reject(swapId: Bytes, expectedOpen: Bytes, reason: 0 | 1 | 2): EthCall {
    return this.encode('reject', [b32(swapId), b32(expectedOpen), reason]);
  }

  // ---- progress and settlement
  private simple(name: string, swapId: Bytes): EthCall {
    return this.encode(name, [b32(swapId)]);
  }
  cancelPending = (swapId: Bytes): EthCall => this.simple('cancelPending', swapId);
  expirePending = (swapId: Bytes): EthCall => this.simple('expirePending', swapId);
  setReady = (swapId: Bytes): EthCall => this.simple('setReady', swapId);
  abort = (swapId: Bytes): EthCall => this.simple('abort', swapId);
  refundUnnoticed = (swapId: Bytes): EthCall => this.simple('refundUnnoticed', swapId);
  expireUnnoticed = (swapId: Bytes): EthCall => this.simple('expireUnnoticed', swapId);
  releaseDeposit = (swapId: Bytes): EthCall => this.simple('releaseDeposit', swapId);
  splitDeposit = (swapId: Bytes): EthCall => this.simple('splitDeposit', swapId);
  postNotice(swapId: Bytes, commitment: Bytes, ciphertext: Bytes): EthCall {
    if (ciphertext.length !== 104) throw new SdkError('BadNotice', 'a notice ciphertext is 104 bytes');
    return this.encode('postNotice', [b32(swapId), b32(commitment), hex0x(ciphertext)]);
  }
  /** `refund` (A10, B9): callable by anyone; the secret is the authorisation. Simulate first; use a private relay when one is configured. */
  refund(swapId: Bytes, secret: Bytes): EthCall {
    return this.encode('refund', [b32(swapId), secretToUint(secret)]);
  }
  /** `claim` (A11, B10): callable by anyone. */
  claim(swapId: Bytes, secret: Bytes): EthCall {
    return this.encode('claim', [b32(swapId), secretToUint(secret)]);
  }
  /** `withhold`: without evidence pass `null` (zeros on the wire). */
  withhold(swapId: Bytes, evidence: { txid: Bytes; view: Bytes } | null): EthCall {
    const zero = new Uint8Array(32);
    return this.encode('withhold', [b32(swapId), b32(evidence?.txid ?? zero), b32(evidence?.view ?? zero)]);
  }
  publishEvidence(swapId: Bytes, txid: Bytes, view: Bytes): EthCall {
    return this.encode('publishEvidence', [b32(swapId), b32(txid), b32(view)]);
  }
  withdrawOwed(token: Address, to: Address): EthCall {
    return this.encode('withdrawOwed', [token, to]);
  }
  /** `postMessage`: the costly fallback transport. Cap 900 bytes. */
  postMessage(to: Address, swapId: Bytes | null, payload: Bytes): EthCall {
    if (payload.length > 900) throw new SdkError('MessageTooLarge', `${payload.length} bytes is over the 900-byte on-chain cap`);
    return this.encode('postMessage', [to, b32(swapId ?? new Uint8Array(32)), hex0x(payload)]);
  }
}

/**
 * The session budget on Ethereum (SPEC 5.4): four calls at a capped gas price. The budget is
 * shown before locking; what is left returns to the taker with a plain transfer at the end.
 */
export function ethSessionBudget(maxFeePerGasWei: bigint, gasPerCall = 150_000n, calls = 4n): bigint {
  return maxFeePerGasWei * gasPerCall * calls;
}

export interface EthereumClientOptions {
  transport: EthTransport;
  contract: Address;
  /**
   * Where secret-bearing transactions (`claim`, `refund`) are submitted when configured: a
   * private relay, so the secret is not visible in the public mempool before it is mined.
   */
  privateTransport?: EthTransport;
  /** Refuse to send when the fee the network asks for is above this (wei per gas). */
  maxFeePerGas?: bigint;
}

/** Signs an EIP-1559 transaction: a viem `LocalAccount` (the derived session key, the daemon's operator key) satisfies it. */
export interface EthSigner {
  address: Address;
  signTransaction(tx: { type: 'eip1559'; chainId: number; nonce: number; to: Address; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex>;
}

export class EthereumClient {
  readonly transport: EthTransport;
  readonly contract: XmrSwapContract;

  private readonly privateTransport: EthTransport | null;
  private readonly maxFeePerGas: bigint | null;

  constructor(o: EthereumClientOptions) {
    this.transport = o.transport;
    this.contract = new XmrSwapContract(o.contract);
    this.privateTransport = o.privateTransport ?? null;
    this.maxFeePerGas = o.maxFeePerGas ?? null;
  }

  /** Refuse an endpoint on another chain before trusting anything it says. */
  async verifyChainId(expected: bigint | number): Promise<void> {
    const got = BigInt((await this.transport.request({ method: 'eth_chainId' })) as string);
    if (got !== BigInt(expected)) throw new SdkError('WrongChain', `the endpoint's chain id is ${got}, expected ${expected}`);
  }

  private async block(tag: BlockTag): Promise<{ number: bigint; hash: Hex; timestamp: bigint } | null> {
    const b = (await this.transport.request({ method: 'eth_getBlockByNumber', params: [tagParam(tag), false] })) as { number: string; hash: Hex; timestamp: string } | null;
    return b ? { number: BigInt(b.number), hash: b.hash, timestamp: BigInt(b.timestamp) } : null;
  }

  /** Chain time: `block.timestamp` of the block at `tag`. Every deadline uses it. */
  async chainTime(tag: BlockTag = 'finalized'): Promise<bigint> {
    const b = await this.block(tag);
    if (!b) throw new SdkError('NoBlock', `no block at ${String(tag)}`);
    return b.timestamp;
  }

  /** A view call at a block tag. A revert becomes a `ContractError` named after the custom error. */
  async read<T = unknown>(functionName: string, args: unknown[] = [], tag: BlockTag = 'finalized'): Promise<T> {
    const call = this.contract.encode(functionName, args);
    let data: Hex;
    try {
      data = (await this.transport.request({ method: 'eth_call', params: [{ to: call.to, data: call.data }, tagParam(tag)] })) as Hex;
    } catch (e) {
      throw new ContractError(contractErrorName(revertData(e)) ?? 'CallFailed', (e as Error).message);
    }
    return decodeFunctionResult({ abi: ABI, functionName, data }) as T;
  }

  /**
   * Simulate a call from `from` at `tag` (default `latest`: the state it would execute on).
   * Throws a `ContractError` if it would revert. Never broadcast a secret that fails here.
   */
  async simulate(call: EthCall, from: Address, tag: BlockTag = 'latest'): Promise<void> {
    try {
      await this.transport.request({ method: 'eth_call', params: [{ from, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` }, tagParam(tag)] });
    } catch (e) {
      throw new ContractError(contractErrorName(revertData(e)) ?? 'CallFailed', (e as Error).message);
    }
  }

  /**
   * Simulate, price, sign and submit one call. Returns the transaction hash.
   *
   * The call is simulated first from the signer (a revert throws a `ContractError` and nothing
   * is signed), gas is the node's estimate × 1.2, the fee is twice the base fee plus the tip and
   * is refused above `maxFeePerGas`. A call marked `secret` goes to the private transport when
   * one is configured.
   */
  async send(call: EthCall, signer: EthSigner, opts: { secret?: boolean; priorityFee?: bigint } = {}): Promise<Hex> {
    await this.simulate(call, signer.address);
    const tx = { from: signer.address, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` };
    let estimate: bigint;
    try {
      estimate = BigInt((await this.transport.request({ method: 'eth_estimateGas', params: [tx] })) as string);
    } catch (e) {
      throw new ContractError(contractErrorName(revertData(e)) ?? 'CallFailed', (e as Error).message);
    }
    const [chainId, nonce, head] = await Promise.all([
      this.transport.request({ method: 'eth_chainId' }) as Promise<string>,
      this.transport.request({ method: 'eth_getTransactionCount', params: [signer.address, 'pending'] }) as Promise<string>,
      this.transport.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as Promise<{ baseFeePerGas?: string } | null>,
    ]);
    const tip = opts.priorityFee ?? 1_000_000_000n;
    const maxFeePerGas = BigInt(head?.baseFeePerGas ?? '0x0') * 2n + tip;
    if (this.maxFeePerGas !== null && maxFeePerGas > this.maxFeePerGas) throw new SdkError('FeeTooHigh', `the network asks ${maxFeePerGas} wei per gas, over the configured cap ${this.maxFeePerGas}`);
    const signed = await signer.signTransaction({ type: 'eip1559', chainId: Number(BigInt(chainId)), nonce: Number(BigInt(nonce)), to: call.to, data: call.data, value: call.value, gas: (estimate * 12n) / 10n, maxFeePerGas, maxPriorityFeePerGas: tip });
    const via = opts.secret && this.privateTransport ? this.privateTransport : this.transport;
    return (await via.request({ method: 'eth_sendRawTransaction', params: [signed] })) as Hex;
  }

  // ---------------------------------------------------------------- readers

  /** The swap as a chain-neutral view, or `null` when no such swap exists (state 0). `withOwed` also reads the parked payouts. */
  async getSwap(swapId: Bytes, tag: BlockTag = 'finalized', withOwed = false): Promise<SwapView | null> {
    const s = await this.read<EthSwapStruct>('getSwap', [b32(swapId)], tag);
    if (s.state === 0) return null;
    if (!withOwed) return viewFromEthereum(hex0x(swapId), s);
    const [taker, maker] = await Promise.all([this.owedOf(s.token as Address, s.taker as Address, tag), this.makerOwed(s, tag)]);
    return viewFromEthereum(hex0x(swapId), s, { taker, maker });
  }
  private async makerOwed(s: EthSwapStruct, tag: BlockTag): Promise<bigint> {
    const m = await this.getMaker(s.maker as Address, tag);
    if (!m) return 0n;
    const [a, b] = await Promise.all([this.owedOf(s.token as Address, m.payout, tag), this.owedOf(s.token as Address, m.operator, tag)]);
    return m.payout.toLowerCase() === m.operator.toLowerCase() ? a : a + b;
  }
  /** The maker record, or `null` when the address is not registered. */
  async getMaker(maker: Address, tag: BlockTag = 'finalized'): Promise<EthMaker | null> {
    const m = await this.read<EthMaker & { counters: readonly number[] }>('getMaker', [maker], tag);
    if (BigInt(m.operator) === 0n) return null;
    return { ...m, operator: m.operator.toLowerCase() as Address, payout: m.payout.toLowerCase() as Address, counters: [...m.counters] };
  }
  async counters(maker: Address, tag: BlockTag = 'finalized'): Promise<number[]> {
    return [...(await this.read<readonly number[]>('counters', [maker], tag))];
  }
  /** Every swap id of a taker (the resume path; logs are only an index). */
  async swapsOf(taker: Address, tag: BlockTag = 'finalized', page = 100n): Promise<Hex[]> {
    const out: Hex[] = [];
    for (let from = 0n; ; from += page) {
      const got = await this.read<readonly Hex[]>('swapsOf', [taker, from, page], tag);
      out.push(...got);
      if (BigInt(got.length) < page) return out;
    }
  }
  isKeyUsed(maker: Address, keyAddr: Address, tag: BlockTag = 'finalized'): Promise<boolean> {
    return this.read<boolean>('isKeyUsed', [maker, keyAddr], tag);
  }
  isQuoteCancelled(maker: Address, quoteId: bigint, tag: BlockTag = 'finalized'): Promise<boolean> {
    return this.read<boolean>('isQuoteCancelled', [maker, quoteId], tag);
  }
  isApprovalRevoked(maker: Address, approvalId: Bytes, tag: BlockTag = 'finalized'): Promise<boolean> {
    return this.read<boolean>('isApprovalRevoked', [maker, b32(approvalId)], tag);
  }
  owedOf(token: Address, account: Address, tag: BlockTag = 'finalized'): Promise<bigint> {
    return this.read<bigint>('owedOf', [token, account], tag);
  }
  async volumeOf(maker: Address, token: Address, tag: BlockTag = 'finalized'): Promise<{ volume: bigint; withheldVolume: bigint }> {
    const [volume, withheldVolume] = await this.read<readonly [bigint, bigint]>('volumeOf', [maker, token], tag);
    return { volume, withheldVolume };
  }
  async usdc(tag: BlockTag = 'finalized'): Promise<Address> {
    return (await this.read<string>('usdc', [], tag)).toLowerCase() as Address;
  }
  domainSeparator(tag: BlockTag = 'finalized'): Promise<Hex> {
    return this.read<Hex>('domainSeparator', [], tag);
  }

  // ---------------------------------------------------------------- finality (SPEC 3.2 rule 2)

  /**
   * "Finalized" means the transaction's block is at or below the `finalized` tag **and** the
   * receipt's block hash is still the canonical hash at that height.
   */
  async isFinal(txHash: Hex, tag: 'finalized' | 'safe' = 'finalized'): Promise<boolean> {
    const r = (await this.transport.request({ method: 'eth_getTransactionReceipt', params: [txHash] })) as { blockNumber: string; blockHash: Hex; status: string } | null;
    if (!r) return false;
    if (BigInt(r.status) !== 1n) throw new ContractError('TransactionReverted', txHash);
    const fin = await this.block(tag);
    if (!fin || BigInt(r.blockNumber) > fin.number) return false;
    const canonical = await this.block(BigInt(r.blockNumber));
    return canonical !== null && canonical.hash.toLowerCase() === r.blockHash.toLowerCase();
  }

  // ---------------------------------------------------------------- events

  /** Decode one raw log of the contract; `null` for a log that is not one of its events. */
  decodeLog(log: RawLog): DecodedEthEvent | null {
    if (log.address.toLowerCase() !== this.contract.address || log.removed) return null;
    try {
      const d = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args?: Record<string, unknown> };
      return { name: d.eventName, args: d.args ?? {}, blockNumber: BigInt(log.blockNumber), blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)) };
    } catch {
      return null;
    }
  }

  /**
   * The contract's events in a block range, optionally for one swap or one maker (both are
   * indexed in every swap event). Logs are an index: read state before acting on them.
   */
  async getEvents(range: { fromBlock: bigint; toBlock: BlockTag }, filter: { swapId?: Bytes; maker?: Address } = {}): Promise<DecodedEthEvent[]> {
    const topics: (Hex | null)[] = [null, filter.swapId ? b32(filter.swapId) : null, filter.maker ? (`0x${filter.maker.slice(2).toLowerCase().padStart(64, '0')}` as Hex) : null];
    while (topics.length > 1 && topics[topics.length - 1] === null) topics.pop();
    const logs = (await this.transport.request({ method: 'eth_getLogs', params: [{ address: this.contract.address, fromBlock: tagParam(range.fromBlock), toBlock: tagParam(range.toBlock), topics }] })) as RawLog[];
    return logs.map((l) => this.decodeLog(l)).filter((e): e is DecodedEthEvent => e !== null);
  }

  /** Messages posted to `to` through the `Message` event (the fallback transport). */
  async listMessages(to: Address, range: { fromBlock: bigint; toBlock: BlockTag }): Promise<{ from: Address; swapId: Hex; payload: Bytes; blockNumber: bigint; transactionHash: Hex }[]> {
    const events = await this.getEvents(range);
    return events
      .filter((e) => e.name === 'Message' && String(e.args.to).toLowerCase() === to.toLowerCase())
      .map((e) => ({ from: String(e.args.from).toLowerCase() as Address, swapId: e.args.swapId as Hex, payload: unhex(e.args.payload as string), blockNumber: e.blockNumber, transactionHash: e.transactionHash }));
  }

  /** Follow the contract's events from a stored cursor. See `EthEventWatcher`. */
  watchEvents(onEvent: (e: DecodedEthEvent) => void, opts: { fromBlock: bigint; tag?: 'finalized' | 'safe' | 'latest'; filter?: { swapId?: Bytes; maker?: Address }; maxRange?: bigint }): EthEventWatcher {
    return new EthEventWatcher(this, onEvent, opts);
  }

  async blockNumber(tag: BlockTag = 'finalized'): Promise<bigint> {
    const b = await this.block(tag);
    if (!b) throw new SdkError('NoBlock', `no block at ${String(tag)}`);
    return b.number;
  }
}

/**
 * `eth_getLogs` from a stored cursor up to a block tag (`finalized` by default, so nothing it
 * reports can be reorged away). `poll()` is one catch-up pass and advances `cursor`; `start()`
 * runs it on a timer. The daemon persists `cursor` and resumes from it.
 */
export class EthEventWatcher {
  /** The next block to scan. */
  cursor: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly tag: 'finalized' | 'safe' | 'latest';
  private readonly maxRange: bigint;

  constructor(
    private readonly client: EthereumClient,
    private readonly onEvent: (e: DecodedEthEvent) => void,
    private readonly opts: { fromBlock: bigint; tag?: 'finalized' | 'safe' | 'latest'; filter?: { swapId?: Bytes; maker?: Address }; maxRange?: bigint },
  ) {
    this.cursor = opts.fromBlock;
    this.tag = opts.tag ?? 'finalized';
    this.maxRange = opts.maxRange ?? 2_000n;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const head = await this.client.blockNumber(this.tag);
      while (this.cursor <= head) {
        const to = this.cursor + this.maxRange - 1n < head ? this.cursor + this.maxRange - 1n : head;
        const events = await this.client.getEvents({ fromBlock: this.cursor, toBlock: to }, this.opts.filter ?? {});
        for (const e of events) this.onEvent(e);
        this.cursor = to + 1n;
      }
    } finally {
      this.busy = false;
    }
  }

  start(pollMs = 12_000, onError: (e: unknown) => void = () => {}): void {
    if (this.timer) return;
    const run = () => void this.poll().catch(onError);
    this.timer = setInterval(run, pollMs);
    run();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
