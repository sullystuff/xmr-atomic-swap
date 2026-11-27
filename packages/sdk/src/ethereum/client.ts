/**
 * The Ethereum client: calldata builders for every function of the frozen ABI, storage readers
 * (state is read with `eth_call`, at the `finalized` tag before anyone acts; logs are only an
 * index), event decoding, a log watcher with a cursor, and the finality check of SPEC 3.2.
 *
 * The seam is `EthTransport`, an EIP-1193 `request` function: a viem transport, a wallet
 * provider, anvil, or a fake in tests. The client holds no key.
 */
import type { EthApproval, EthQuote } from '@xmrswap/core-wasm';
import { type Address, type AssetCaps, ETH_NATIVE, type Hex, IXmrSwapAbi, SWAP_FLAG } from '@xmrswap/protocol';
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
/** The zero address: "no watcher"; never a payout. */
const ZERO_ADDRESS = ETH_NATIVE;

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
    /** Amendment 1 (SPEC 11.6): the key that may freeze. Omit for none. `WatcherNotAllowed` against `freezeWindow == 0`. */
    watcher?: Address | null;
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
        p.watcher ?? ZERO_ADDRESS,
      ],
      (eth ? p.amount : 0n) + p.sessionBudget,
    );
  }
  /**
   * `take` (B1). `deposit` is the take deposit (`priceEthQuote(...).deposit`): ETH needs
   * `deposit + sessionBudget`. `payout` (Amendment 1, SPEC 11.2) is where the claim pays: the
   * taker's own address for the default. Zero and the contract itself are `BadValue`.
   */
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
    payout: Address;
  }): EthCall {
    if (p.swapNonce.length !== 16) throw new SdkError('BadNonce', 'a swap nonce is 16 bytes');
    const payout = p.payout.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(payout) || payout === ZERO_ADDRESS || payout === this.address) throw new SdkError('PayoutInvalid', 'the payout address is zero, malformed or the contract itself');
    const eth = beToBig(p.quote.token) === 0n;
    return this.encode(
      'take',
      [quoteMessage(p.quote), hex0x(p.sig), p.xmr, p.minReceive, hex0x(p.swapNonce), p.sessionKey, p.sessionBudget, this.takerKeys(p.takerKeys), approvalMessage(p.approval?.approval ?? EMPTY_ETH_APPROVAL), hex0x(p.approval?.sig ?? new Uint8Array(0)), payout],
      (eth ? p.deposit : 0n) + p.sessionBudget,
    );
  }
  approve(swapId: Bytes, expectedOpen: Bytes): EthCall {
    return this.encode('approve', [b32(swapId), b32(expectedOpen)]);
  }
  /** `fund` (B5). ETH: `value` = `amount`; USDC: zero value and an allowance from the operator. `watcher`: the maker's watcher (SPEC 11.6); omit for none. */
  fund(p: { swapId: Bytes; expectedOpen: Bytes; key: Address; key2: Address; spendPub: Bytes; viewShare: Bytes; amount: bigint; token: Address; watcher?: Address | null }): EthCall {
    return this.encode('fund', [b32(p.swapId), b32(p.expectedOpen), p.key, p.key2, b32(p.spendPub), b32(p.viewShare), p.watcher ?? ZERO_ADDRESS], p.token.toLowerCase() === ETH_NATIVE ? p.amount : 0n);
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
  /** `freeze` (Z1): the watcher the swap names, or the locker; NOTICED, before `T_co`, once. Moves nothing. */
  freeze = (swapId: Bytes): EthCall => this.simple('freeze', swapId);
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
  /** `pushOwed` (SPEC 11.2): anyone retries the push of `account`'s parked balance of `token` to `account` itself. */
  pushOwed(token: Address, account: Address): EthCall {
    return this.encode('pushOwed', [token, account]);
  }
  /** `setCaps` (owner): the largest `amount` of one swap and the largest open value of `token`. */
  setCaps(token: Address, maxSwap: bigint, maxOpen: bigint): EthCall {
    return this.encode('setCaps', [token, maxSwap, maxOpen]);
  }
  /** `setCapsOn` (owner): the global switch. */
  setCapsOn(on: boolean): EthCall {
    return this.encode('setCapsOn', [on]);
  }
  /** `postMessage`: the costly fallback transport. Cap 900 bytes. */
  postMessage(to: Address, swapId: Bytes | null, payload: Bytes): EthCall {
    if (payload.length > 900) throw new SdkError('MessageTooLarge', `${payload.length} bytes is over the 900-byte on-chain cap`);
    return this.encode('postMessage', [to, b32(swapId ?? new Uint8Array(32)), hex0x(payload)]);
  }
}

/**
 * Gas used by the calls a session key sends, measured on anvil against the contract of
 * Amendment 1 (the integration suite re-measures on every run and fails if a call exceeds its
 * figure by more than the margin): the most expensive observed variant of each (USDC, first
 * write of the slots it touches, a swap that was frozen, a claim paid to a fresh payout address).
 */
export const ETH_SESSION_GAS = {
  /** A9, and Z2 from FROZEN. */
  setReady: 65_600n,
  /** A4, B2. */
  cancelPending: 76_300n,
  /** A10 with the deposit held, USDC. */
  refund: 159_100n,
  /** B6: stores the 104-byte ciphertext. */
  postNotice: 218_400n,
  /** B10, USDC, paid to a payout address that held none. */
  claim: 182_600n,
} as const;
/** Margin added on top of the measured figures, in percent. */
export const ETH_SESSION_GAS_MARGIN_PCT = 25n;
/** The dearest session-key call (`postNotice`, 218,400) plus the margin. */
export const ETH_SESSION_GAS_PER_CALL = 273_000n;
/**
 * Gas of the calls only a watcher or a third party sends (measured, whole transactions): a
 * watcher's fee balance is sized by `freeze`; `pushOwed` is what delivering a parked balance costs.
 */
export const ETH_WATCHER_GAS = { freeze: 78_600n, pushOwed: 74_300n } as const;

/**
 * The session budget on Ethereum (SPEC 5.4): four calls at a capped gas price, each sized as
 * the dearest measured session-key call plus 25%. The budget is shown before locking; what is
 * left returns to the taker with a plain transfer at the end. A budget that runs out is a lost
 * automatic refund, so it errs high: the worst real sequences (A: ready then refund, 225,000
 * gas; B: notice then claim, 401,000) use well under half of it.
 */
export function ethSessionBudget(maxFeePerGasWei: bigint, gasPerCall = ETH_SESSION_GAS_PER_CALL, calls = 4n): bigint {
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
    // An empty answer is "no code at this address at this block": the tag predates the deployment, or the address is wrong.
    if (data === '0x') throw new ContractError('NoContract', `no contract at ${this.contract.address} at block ${String(tag)}`);
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

  /**
   * Poll for the receipt of a sent transaction. Resolves with its block once mined; a reverted
   * transaction throws `TransactionReverted`. Mined is not final: see `isFinal`.
   */
  async waitMined(txHash: Hex, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<{ blockNumber: bigint; blockHash: Hex; gasUsed: bigint }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    for (;;) {
      const r = (await this.transport.request({ method: 'eth_getTransactionReceipt', params: [txHash] })) as { blockNumber: string; blockHash: Hex; status: string; gasUsed: string } | null;
      if (r) {
        if (BigInt(r.status) !== 1n) throw new ContractError('TransactionReverted', txHash);
        return { blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash, gasUsed: BigInt(r.gasUsed) };
      }
      if (Date.now() > deadline) throw new SdkError('NotMined', `${txHash} was not mined in time`);
      await new Promise((res) => setTimeout(res, opts.intervalMs ?? 250));
    }
  }

  // ---------------------------------------------------------------- readers

  /** The swap as a chain-neutral view, or `null` when no such swap exists (state 0). `withOwed` also reads the parked payouts. */
  async getSwap(swapId: Bytes, tag: BlockTag = 'finalized', withOwed = false): Promise<SwapView | null> {
    let s: EthSwapStruct;
    try {
      s = await this.read<EthSwapStruct>('getSwap', [b32(swapId)], tag);
    } catch (e) {
      // At a block before the contract existed there is no such swap either.
      if (e instanceof ContractError && e.code === 'NoContract') return null;
      throw e;
    }
    if (s.state === 0) return null;
    if (!withOwed) return viewFromEthereum(hex0x(swapId), s);
    const owed = await this.owedFor(s.token as Address, s.taker as Address, s.maker as Address, tag);
    // Claim proceeds of a direction-B swap are parked under the payout address (SPEC 11.2).
    const claimed = (s.flags & SWAP_FLAG.REVEALED) !== 0 && (s.flags & SWAP_FLAG.REVEALER_LOCKER) === 0;
    const toPayout = s.direction === 1 && claimed && s.payout.toLowerCase() !== s.taker.toLowerCase();
    const takerSide = toPayout ? await this.owedOf(s.token as Address, s.payout as Address, tag) : owed.taker;
    return viewFromEthereum(hex0x(swapId), s, { taker: takerSide, maker: owed.payout + owed.operator + owed.owner });
  }

  /**
   * Parked payouts that a swap's parties can pull. The contract keys them by the address the
   * push would have gone to, not by swap: the taker; the maker's **payout** address (a
   * direction-A claim); its current **operator** (a direction-B refund); and the maker's
   * **owner** address (the escrow parked by `expireUnnoticed`). Each account pulls its own with
   * `withdrawOwed(token, to)`. The figures are account totals and may include other swaps.
   */
  async owedFor(token: Address, taker: Address, maker: Address, tag: BlockTag = 'finalized'): Promise<{ taker: bigint; payout: bigint; operator: bigint; owner: bigint; accounts: { payout: Address; operator: Address; owner: Address } | null }> {
    const m = await this.getMaker(maker, tag);
    const takerOwed = await this.owedOf(token, taker, tag);
    if (!m) return { taker: takerOwed, payout: 0n, operator: 0n, owner: 0n, accounts: null };
    const owner = maker.toLowerCase() as Address;
    // One address may play several roles; count each address once.
    const seen = new Map<string, bigint>();
    const of = async (a: Address): Promise<bigint> => {
      if (seen.has(a)) return 0n;
      const v = await this.owedOf(token, a, tag);
      seen.set(a, v);
      return v;
    };
    const payout = await of(m.payout);
    const operator = await of(m.operator);
    const ownerOwed = await of(owner);
    return { taker: takerOwed, payout, operator, owner: ownerOwed, accounts: { payout: m.payout, operator: m.operator, owner } };
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
  /**
   * The beta caps of `token` (SPEC 11.1): the switch, the per-swap cap, the open-value cap and
   * the open value. A fresh deployment reads `on` with zero caps: nothing opens. Read at
   * `latest` when planning an open: that is the state the open executes on.
   */
  async capsOf(token: Address, tag: BlockTag = 'finalized'): Promise<AssetCaps> {
    const [on, maxSwap, maxOpen, openValue] = await this.read<readonly [boolean, bigint, bigint, bigint]>('capsOf', [token], tag);
    return { on, maxSwap, maxOpen, openValue };
  }
  /**
   * Check a payout address before a `take` (SPEC 11.2). `refuse`: the contract reverts with
   * `BadValue` (zero, or the contract itself). `warn`: the address has code; a contract that
   * does not accept ETH inside the 30,000-gas stipend (or a blacklisted USDC holder) gets the
   * proceeds parked under its address, where `pushOwed` or its own `withdrawOwed` delivers them.
   */
  async payoutProblem(payout: Address, tag: BlockTag = 'latest'): Promise<{ verdict: 'ok' | 'warn' | 'refuse'; reason: 'invalid-address' | 'contract' | null }> {
    const p = payout.toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(p) || p === ZERO_ADDRESS || p === this.contract.address) return { verdict: 'refuse', reason: 'invalid-address' };
    return (await this.hasCode(p, tag)) ? { verdict: 'warn', reason: 'contract' } : { verdict: 'ok', reason: null };
  }
  /** Whether `address` has code at `tag`: a payout address that is a contract may refuse ETH or need more than the 30,000-gas stipend. */
  async hasCode(address: Address, tag: BlockTag = 'latest'): Promise<boolean> {
    const code = (await this.transport.request({ method: 'eth_getCode', params: [address, typeof tag === 'bigint' ? `0x${tag.toString(16)}` : tag] })) as string;
    return code !== '0x' && code !== '0x0';
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

  /**
   * The history of a maker's pointer at a Solana owner key: the value set at registration
   * (`MakerRegistered`) and every `LinkChanged` since, oldest first. Feed it to
   * `linkIntervals` / `rememberPastLinks` so that an unlink does not shed history.
   */
  async linkChanges(maker: Address, range: { fromBlock: bigint; toBlock: BlockTag } = { fromBlock: 0n, toBlock: 'finalized' }): Promise<{ old: Bytes; next: Bytes; effectiveAt: bigint }[]> {
    const events = await this.getEvents(range, {});
    const mine = events.filter((e) => (e.name === 'MakerRegistered' || e.name === 'LinkChanged') && String(e.args.maker).toLowerCase() === maker.toLowerCase());
    const out: { old: Bytes; next: Bytes; effectiveAt: bigint }[] = [];
    for (const e of mine) {
      if (e.name === 'MakerRegistered') {
        // The link named at registration is in effect at once.
        const b = await this.block(e.blockNumber);
        out.push({ old: new Uint8Array(32), next: unhex(e.args.solanaOwner as string), effectiveAt: b?.timestamp ?? 0n });
      } else out.push({ old: unhex(e.args.oldOwner as string), next: unhex(e.args.newOwner as string), effectiveAt: BigInt(e.args.effectiveAt as bigint) });
    }
    return out;
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
