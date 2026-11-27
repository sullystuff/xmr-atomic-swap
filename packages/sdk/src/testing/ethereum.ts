import { IXmrSwapAbi } from '@xmrswap/protocol';
import { type Abi, decodeFunctionData, encodeErrorResult, encodeEventTopics, encodeAbiParameters, encodeFunctionResult } from 'viem';
import type { EthTransport } from '../ethereum/client.js';

const ABI = IXmrSwapAbi as unknown as Abi;
type Hex = `0x${string}`;

/** A revert with a custom error of the frozen ABI, thrown from a `FakeEthereum` view handler. */
export class FakeRevert extends Error {
  constructor(readonly errorName: string) {
    super(`execution reverted: ${errorName}`);
  }
}

export interface FakeBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/**
 * An EIP-1193 transport over a scripted contract. Views are answered by `views[functionName]`
 * (decoded arguments in, a value for viem to ABI-encode out); logs come from `emit`; blocks and
 * the `latest` / `finalized` heads are set by the test. It records every request.
 */
export class FakeEthereum implements EthTransport {
  chainId = 31337n;
  latest = 100n;
  finalized = 90n;
  readonly blocks = new Map<bigint, FakeBlock>();
  readonly views: Record<string, (args: readonly unknown[], ctx: { tag: string; from?: string; value?: string }) => unknown> = {};
  readonly logs: { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex }[] = [];
  readonly receipts = new Map<string, { blockNumber: Hex; blockHash: Hex; status: Hex }>();
  readonly requests: { method: string; params?: unknown[] }[] = [];
  /** Raw transactions it was asked to broadcast. */
  readonly sentRaw: Hex[] = [];
  baseFeePerGas = 10_000_000_000n;
  gasEstimate = 100_000n;
  readonly nonces = new Map<string, number>();
  /** Addresses that have code (lowercase): what `eth_getCode` answers `0x60…` for. */
  readonly code = new Set<string>();
  /** Balances in wei by lowercase address: what `eth_getBalance` answers (0 when absent). */
  readonly balances = new Map<string, bigint>();

  constructor(readonly contract: Hex) {}

  /** The block at a height, created on demand with a deterministic hash and a 12 s cadence. */
  block(n: bigint): FakeBlock {
    let b = this.blocks.get(n);
    if (!b) {
      b = { number: n, hash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: 1_800_000_000n + n * 12n };
      this.blocks.set(n, b);
    }
    return b;
  }
  /** Replace the canonical block at a height (a reorg). */
  reorg(n: bigint, hash: Hex): void {
    this.blocks.set(n, { ...this.block(n), hash });
  }

  /** Append an event of the frozen ABI as a log in block `blockNumber`. */
  emit(eventName: string, args: Record<string, unknown>, blockNumber: bigint, transactionHash: Hex = `0x${'ab'.repeat(32)}`): void {
    const ev = (ABI as readonly { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean; components?: unknown }[] }[]).find((e) => e.type === 'event' && e.name === eventName);
    if (!ev) throw new Error(`no event ${eventName}`);
    const topics = encodeEventTopics({ abi: ABI, eventName, args } as never) as Hex[];
    const plain = ev.inputs!.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) as Hex;
    this.logs.push({ address: this.contract, topics, data, blockNumber: `0x${blockNumber.toString(16)}`, blockHash: this.block(blockNumber).hash, transactionHash, logIndex: `0x${this.logs.length.toString(16)}` });
  }

  private resolve(tag: string): bigint {
    if (tag === 'latest' || tag === 'pending') return this.latest;
    if (tag === 'finalized' || tag === 'safe') return this.finalized;
    return BigInt(tag);
  }

  async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.requests.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return `0x${this.chainId.toString(16)}`;
      case 'eth_getBlockByNumber': {
        const n = this.resolve(params[0] as string);
        if (n > this.latest) return null;
        const b = this.block(n);
        return { number: `0x${b.number.toString(16)}`, hash: b.hash, timestamp: `0x${b.timestamp.toString(16)}`, baseFeePerGas: `0x${this.baseFeePerGas.toString(16)}` };
      }
      case 'eth_estimateGas':
        return `0x${this.gasEstimate.toString(16)}`;
      case 'eth_getTransactionCount':
        return `0x${(this.nonces.get(String(params[0]).toLowerCase()) ?? 0).toString(16)}`;
      case 'eth_sendRawTransaction':
        this.sentRaw.push(params[0] as Hex);
        return `0x${this.sentRaw.length.toString(16).padStart(64, '0')}`;
      case 'eth_call': {
        const call = params[0] as { to: string; data: Hex; from?: string; value?: string };
        const { functionName, args } = decodeFunctionData({ abi: ABI, data: call.data });
        const view = this.views[functionName];
        if (!view) throw new Error(`FakeEthereum: no handler for ${functionName}`);
        try {
          const result = view(args ?? [], { tag: params[1] as string, ...(call.from ? { from: call.from } : {}), ...(call.value ? { value: call.value } : {}) });
          return encodeFunctionResult({ abi: ABI, functionName, result } as never);
        } catch (e) {
          if (e instanceof FakeRevert) throw Object.assign(new Error(e.message), { code: 3, data: encodeErrorResult({ abi: ABI, errorName: e.errorName } as never) });
          throw e;
        }
      }
      case 'eth_getLogs': {
        const f = params[0] as { fromBlock: string; toBlock: string; topics?: (Hex | null)[] };
        const from = this.resolve(f.fromBlock);
        const to = this.resolve(f.toBlock);
        return this.logs.filter((l) => {
          const n = BigInt(l.blockNumber);
          if (n < from || n > to) return false;
          return (f.topics ?? []).every((t, i) => t === null || l.topics[i]?.toLowerCase() === t.toLowerCase());
        });
      }
      case 'eth_getBalance':
        return `0x${(this.balances.get(String(params[0]).toLowerCase()) ?? 0n).toString(16)}`;
      case 'eth_getCode':
        return this.code.has(String(params[0]).toLowerCase()) || String(params[0]).toLowerCase() === this.contract.toLowerCase() ? '0x6080' : '0x';
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as string) ?? null;
      default:
        throw new Error(`FakeEthereum: unsupported method ${method}`);
    }
  }
}
