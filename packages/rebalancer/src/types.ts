/**
 * The venue adapter interface of SPEC 7.7.
 *
 * The block marked FROZEN is the text of SPEC 7.7. Everything else in this file is either a
 * shape the spec elided (`sendSol(...)`) or an optional extension; each is recorded in
 * `DEVIATIONS.md`. A caller written against the frozen text compiles against these types.
 */
import type { TransactionInstruction } from '@solana/web3.js';
import type { AssetId, VenueId } from '@xmrswap/protocol/daemon-api';

export type { AssetId, VenueId };

// ---------------------------------------------------------------- FROZEN (SPEC 7.7)

export interface RefillRequest {
  from: AssetId;
  to: AssetId;
  /** Exactly one of `amountIn` and `amountOut` is set. Atomic units. */
  amountIn?: bigint;
  amountOut?: bigint;
  rate: 'fixed' | 'float';
  payoutAddress: string;
  refundAddress: string;
}

export interface VenueQuote {
  venue: VenueId;
  request: RefillRequest;
  amountIn: bigint;
  amountOut: bigint;
  /** Total cost in USD at the reference price: value in, minus value out, plus network fees. */
  feesUsd: number;
  /** The same cost as a percentage of the value in. Negative when the venue beats the reference. */
  costPct: number;
  /** Unix seconds. */
  expiresAt: number;
  pieces?: number;
  raw: unknown;
}

export type RefillState = 'pending' | 'depositing' | 'processing' | 'paying_out' | 'done' | 'held' | 'failed' | 'refunded';

export type RefillStatus = {
  state: RefillState;
  detail?: string;
  received?: bigint;
  txids: string[];
  /** Extension (DEVIATIONS R3): input the venue did not use and never took, for the next venue. */
  unfilled?: bigint;
};

export interface VenueAdapter {
  readonly id: VenueId;
  health(): Promise<{ ok: boolean; reason?: string }>;
  limits(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }>;
  quote(req: RefillRequest): Promise<VenueQuote>;
  /** Journals every step through `ctx` before sending. */
  execute(quote: VenueQuote, ctx: ExecContext): Promise<{ handle: string }>;
  status(handle: string): Promise<RefillStatus>;
  /** Extension (DEVIATIONS R2): `ctx` is optional; the bridge needs one to send the cancel transaction. */
  cancel?(handle: string, ctx?: ExecContext): Promise<void>;
  resolveHeld?(handle: string, choice: 'continue' | 'refund', ctx?: ExecContext): Promise<void>;
  /**
   * Extension (DEVIATIONS R2): venues whose refill has steps after the first send (the bridge's
   * later pieces and its reverse path, the exchange's trade and withdrawal) take them here.
   * Idempotent; safe to call on every poll and after a restart. Adapters without it are polled
   * with `status`.
   */
  advance?(handle: string, ctx: ExecContext): Promise<RefillStatus>;
}

/** The spec elides the argument lists of the three senders; these are the shapes built here (DEVIATIONS R1). */
export type SolSend =
  | { kind: 'transfer'; asset: 'sol' | 'usdc_sol'; to: string; amount: bigint }
  /** Unsigned instructions; the daemon adds the blockhash, fee payer and signature. */
  | { kind: 'instructions'; instructions: TransactionInstruction[]; label: string }
  /** A base64 versioned transaction built by an aggregator for the maker's wallet to sign. */
  | { kind: 'versioned_tx'; base64: string; label: string };
export interface EthSend { asset: 'eth' | 'usdc_eth'; to: string; amount: bigint }
export interface XmrSend { to: string; amount: bigint }

export interface ExecContext {
  journal(step: string, data: unknown): Promise<void>;
  /** Resolves with the signature once the transaction is confirmed. Never re-sends on ambiguity. */
  sendSol(send: SolSend): Promise<string>;
  sendEth(send: EthSend): Promise<string>;
  sendXmr(send: XmrSend): Promise<string>;
  /** Unix seconds. */
  now(): number;
}

// ---------------------------------------------------------------- shared helpers

/** USD price of one whole unit of an asset: the maker's reference price. */
export interface PriceSource {
  usd(asset: AssetId): Promise<number>;
}

/** Durable key-value state for adapters whose refills have more than one step. The daemon backs it with SQLite. */
export interface AdapterStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export class MemoryStore implements AdapterStore {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async put(key: string, value: string): Promise<void> { this.map.set(key, value); }
}

/**
 * An adapter failure. `fundsMoved` says whether a send through `ExecContext` had been attempted
 * when it was thrown: `false` means nothing left the wallet and another venue can be tried at
 * once; `true` means the outcome needs review and nothing is re-sent.
 */
export class VenueError extends Error {
  readonly venue: VenueId;
  readonly fundsMoved: boolean;
  constructor(venue: VenueId, message: string, fundsMoved = false) {
    super(`${venue}: ${message}`);
    this.name = 'VenueError';
    this.venue = venue;
    this.fundsMoved = fundsMoved;
  }
}

export const TERMINAL_STATES: readonly RefillState[] = ['done', 'failed', 'refunded'];
