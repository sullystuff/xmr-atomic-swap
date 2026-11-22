/**
 * What the swap executor asks of a chain. Both implementations are thin wrappers over the SDK
 * clients: they add the operator's signature, the "record the transaction id before it is
 * broadcast" hook the intent log needs, and the status lookup restart recovery uses.
 *
 * State is always read at `finalized` (SPEC 3.2 rule 2, 7.5): on Ethereum that is what makes
 * the daemon wait for finality before it locks XMR and before it claims.
 */
import type { ChainName } from '@xmrswap/protocol';
import type { CallMaterial, FlowCall, SwapView } from '@xmrswap/sdk';

/** `pending` = may still land; `dead` = can never land (blockhash expired, nonce consumed by another transaction). */
export type TxState = 'confirmed' | 'failed' | 'pending' | 'dead';
export interface TxStatus {
  state: TxState;
  /** Fee paid, in the chain's native base unit, when known. */
  fee?: bigint;
}
/** Called after signing and BEFORE broadcasting, with the transaction id and what a later status lookup needs. */
export type OnSigned = (tx: string, meta: Record<string, unknown>) => void;

export interface SwapChain {
  readonly chain: ChainName;
  /** The operator address that signs (base58 or 0x). */
  readonly operator: string;
  /** Chain time at `finalized`. */
  now(): Promise<bigint>;
  /** The swap at `finalized`, or `null` when it does not exist (never opened there yet, or closed). */
  getSwap(ref: string): Promise<SwapView | null>;
  /** Swaps naming this maker that exist at `finalized` and may be unknown to the database. */
  discover(): Promise<SwapView[]>;
  /** The reference string of a swap view: base58 PDA (Solana) or 0x swap id (Ethereum). */
  refOf(s: SwapView): string;
  /**
   * Simulate, sign and broadcast one flow call as the operator. A call that would fail is
   * refused before anything is signed (a refused secret is never broadcast). Returns the
   * transaction id, or `null` when the chain has nothing to send for this call.
   */
  send(s: SwapView, call: FlowCall, m: CallMaterial, onSigned: OnSigned): Promise<string | null>;
  /** Where a sent transaction stands, from its id and the metadata recorded at signing. */
  status(tx: string, meta: Record<string, unknown> | null): Promise<TxStatus>;
}

/** A refusal before broadcast: the simulation failed. Nothing left the process. */
export class Refused extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'Refused';
  }
}

/**
 * Endpoint failover: calls go to the current endpoint; a transport-level failure moves to the
 * next one and retries once per endpoint. Errors the endpoint answered with (program errors,
 * reverts, SDK refusals) are not transport failures and pass through.
 */
export function failover<T extends object>(endpoints: T[], isAnswer: (e: unknown) => boolean, onSwitch: (index: number, e: unknown) => void = () => {}): T & { readonly endpointIndex: number } {
  if (endpoints.length === 0) throw new Error('no endpoint configured');
  let current = 0;
  return new Proxy(endpoints[0]!, {
    get(_t, prop) {
      if (prop === 'endpointIndex') return current;
      const probe = (endpoints[current] as Record<string | symbol, unknown>)[prop];
      if (typeof probe !== 'function') return probe;
      return async (...args: unknown[]) => {
        let last: unknown;
        for (let attempt = 0; attempt < endpoints.length; attempt++) {
          const target = endpoints[current] as Record<string | symbol, (...a: unknown[]) => unknown>;
          try {
            return await target[prop]!(...args);
          } catch (e) {
            if (isAnswer(e)) throw e;
            last = e;
            current = (current + 1) % endpoints.length;
            onSwitch(current, e);
          }
        }
        throw last;
      };
    },
  }) as T & { readonly endpointIndex: number };
}
