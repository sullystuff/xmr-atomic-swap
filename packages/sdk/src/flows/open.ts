/**
 * Opening a swap (SPEC 4.4, 5.3): everything a `lock` or `take` carries, derived in one place
 * from the recovery seed, a fresh nonce and the offer or quote the user reviewed. Pure: these
 * functions build instructions and calldata; the caller's wallet signs and sends them.
 *
 * Before calling these the client has: saved the recovery file; checked the offer against its
 * terms hash (`offerProblem`) or the quote (`solQuoteProblem`, `ethQuoteProblem`); and, on
 * Ethereum, verified the maker's DLEQ proof for the leaf (`fetchProof`) and uploaded its own
 * (`uploadOwnProof`).
 */
import type { TransactionInstruction } from '@solana/web3.js';
import { type DerivedKeys, type EthApproval, type EthQuote, depositOf, ethSwapId } from '@xmrswap/core-wasm';
import { type Address, BPS_DENOMINATOR, type Maker, type Offer, POOL_SLOTS, type Quote, SESSION_BUDGET_LAMPORTS } from '@xmrswap/protocol';
import { type EthCall, type PoolLeafArg, type XmrSwapContract } from '../ethereum/client.js';
import { type Pricing, priceEthQuote, priceOffer } from '../registry/pricing.js';
import type { SignedSolApproval } from '../signing/solana.js';
import type { XmrSwapProgram } from '../solana/instructions.js';
import { APPROVAL_IX_INDEX, approvalEd25519Ix } from '../solana/tx.js';
import { type Bytes, SdkError, unhex } from '../util.js';
import { ethereumOpenKeys, newSwapNonce, solanaOpenKeys, takerSwapKeys } from './keys.js';

/** The base fee of a Solana transaction, per signature. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/**
 * The base fee of an open transaction: one signature (the taker's), or two when it presents an
 * advance approval, because the Ed25519 precompile's signature is charged too (10,000 lamports).
 * Priority fees come on top.
 */
export const solanaOpenFee = (withApproval: boolean): bigint => LAMPORTS_PER_SIGNATURE * (withApproval ? 2n : 1n);

/** A: the most the taker will pay. B: the least it will receive. `slippageBps` widens the quoted amount. */
function bound(amount: bigint, direction: number, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) throw new SdkError('BadSlippage', 'slippage is 0 to 10,000 basis points');
  const delta = (amount * BigInt(slippageBps)) / BPS_DENOMINATOR;
  return direction === 0 ? amount + delta : amount - delta;
}

export interface SolanaOpenInput {
  program: XmrSwapProgram;
  /** The taker's wallet, base58: the signer and fee payer of the open transaction. */
  taker: string;
  /** Maker PDA, base58. */
  makerPda: string;
  /** The maker's registry record: the encryption key version the swap's messages will use, and the operator (quote rent receiver). */
  maker: Pick<Maker, 'encKeyVersion' | 'operator'>;
  /** The 32-byte recovery seed. */
  seed: Bytes;
  /** Defaults to a fresh random nonce. Never reuse one. */
  swapNonce?: Bytes;
  xmr: bigint;
  /** A public offer, or the taker-bound `Quote` account the maker posted. Its direction decides `lock` or `take`. */
  source: { offer: Offer } | { quote: Quote };
  /** Tolerance on the amount, in basis points (offers only; a quote's amount is exact). */
  slippageBps?: number;
  /** A valid advance approval to present; its Ed25519 instruction is placed right after the compute-budget pair. */
  approval?: SignedSolApproval;
  /** `Rent::minimum_balance(0)`: `getMinimumBalanceForRentExemption(0)` of the endpoint. Never hard-coded. */
  rentExemptMinimum: bigint;
}

export interface SolanaOpenPlan {
  direction: 0 | 1;
  swapNonce: Bytes;
  /** The swap PDA, base58: the swap's `swap_ref`, known before the transaction is sent. */
  swapPda: string;
  keys: DerivedKeys;
  /** What the swap will cost: for a quote, its exact amount. */
  amount: bigint;
  deposit: bigint;
  depth: number;
  /** `max_pay` (A) or `min_receive` (B) put in the instruction. */
  limit: bigint;
  /** Lamports forwarded to the session key: the rent minimum plus the SDK budget. */
  sessionLamports: bigint;
  /** The base fee the taker's wallet pays for this transaction: 5,000 lamports, or 10,000 with an advance approval. */
  feeLamports: bigint;
  /** The program instructions, in order; pass them to `SolanaClient.prepare`. A single open is always a legacy transaction. */
  instructions: TransactionInstruction[];
}

/** Build a Solana `lock` (direction A) or `take` (direction B). */
export function planSolanaOpen(i: SolanaOpenInput): SolanaOpenPlan {
  const swapNonce = i.swapNonce ?? newSwapNonce();
  const keys = takerSwapKeys(i.seed, 'solana', swapNonce);
  const swap = i.program.swapPda(i.taker, swapNonce);
  const open = solanaOpenKeys(keys, swap.toBytes());
  let direction: 0 | 1;
  let asset: number;
  let amount: bigint;
  let deposit: bigint;
  let depth: number;
  let limit: bigint;
  let expectedTermsHash: Bytes = new Uint8Array(32);
  let minSeq = 0n;
  let keyHint = 0;
  if ('offer' in i.source) {
    const o = i.source.offer;
    if (o.maker !== i.makerPda) throw new SdkError('QuoteMismatch', 'the offer belongs to another maker');
    const p: Pricing = priceOffer(o, i.xmr);
    direction = o.direction === 0 ? 0 : 1;
    asset = o.asset;
    amount = p.amount;
    deposit = p.deposit;
    depth = p.depth;
    limit = bound(p.amount, direction, i.slippageBps ?? 0);
    // The program refuses the lock if the terms changed since the user saw them, or the offer went backwards.
    expectedTermsHash = o.termsHash;
    minSeq = o.seq;
    // A hint only: the first pool slot that is filled and unused.
    for (let s = 0; s < POOL_SLOTS; s++) {
      if ((o.poolFilled >> s) & 1 && !((o.poolUsed >> s) & 1)) {
        keyHint = s;
        break;
      }
    }
  } else {
    const q = i.source.quote;
    if (q.maker !== i.makerPda || q.taker !== i.taker) throw new SdkError('QuoteMismatch', 'the quote is bound to another maker or taker');
    if (q.xmr !== i.xmr) throw new SdkError('QuoteMismatch', 'the quote is for another size');
    direction = q.direction === 0 ? 0 : 1;
    asset = q.asset;
    amount = q.amount;
    deposit = depositOf(q.amount, q.depBps);
    depth = q.depth;
    limit = q.amount;
  }
  const sessionLamports = i.rentExemptMinimum + SESSION_BUDGET_LAMPORTS;
  const common = {
    swapNonce,
    sessionLamports,
    asset,
    xmr: i.xmr,
    expectedTermsHash,
    minSeq,
    takerSpendPub: open.takerSpendPub,
    takerPok: open.takerPok,
    takerEncKey: open.takerEncKey,
    makerEncVersion: i.maker.encKeyVersion,
    approvalIx: i.approval ? APPROVAL_IX_INDEX : null,
  };
  const source = 'offer' in i.source ? ({ offer: true } as const) : { quoteId: i.source.quote.quoteId, operator: i.maker.operator };
  const who = { taker: i.taker, maker: i.makerPda, sessionKey: open.sessionKey, source };
  const ix =
    direction === 0
      ? i.program.lock({ ...who, args: { ...common, maxPay: limit, takerView: open.takerView, keyHint } })
      : i.program.take({ ...who, args: { ...common, minReceive: limit } });
  const instructions = i.approval ? [approvalEd25519Ix(i.approval.operatorPub, i.approval.signature, i.approval.message), ix] : [ix];
  return { direction, swapNonce, swapPda: swap.toBase58(), keys, amount, deposit, depth, limit, sessionLamports, feeLamports: solanaOpenFee(i.approval !== undefined), instructions };
}

export interface EthereumOpenInput {
  contract: XmrSwapContract;
  /** The taker's address: `msg.sender` of the open transaction. */
  taker: Address;
  /** The verified quote and its signature. Its direction decides `lock` or `take`. */
  quote: EthQuote;
  sig: Bytes;
  /** The maker's X25519 key and its version, read from the maker's Solana record. */
  maker: { encKeyVersion: number; encKey: Bytes };
  seed: Bytes;
  swapNonce?: Bytes;
  xmr: bigint;
  slippageBps?: number;
  /** Direction A: the pool leaf picked with `pickLeaf`, whose DLEQ proof was verified, with its Merkle proof. */
  leaf?: PoolLeafArg;
  approval?: { approval: EthApproval; sig: Bytes };
  /** Wei forwarded to the session key (`ethSessionBudget`); shown to the user before locking. */
  sessionBudget: bigint;
}

export interface EthereumOpenPlan {
  direction: 0 | 1;
  swapNonce: Bytes;
  /** `swapId`, 32 bytes: the swap's `swap_ref`. */
  swapId: Bytes;
  keys: DerivedKeys;
  amount: bigint;
  deposit: bigint;
  depth: number;
  limit: bigint;
  /** The transaction to send from the taker's wallet. For USDC an allowance of `amount` (A) or `deposit` (B) must already exist. */
  call: EthCall;
}

/** Build an Ethereum `lock` (direction A) or `take` (direction B). */
export function planEthereumOpen(i: EthereumOpenInput): EthereumOpenPlan {
  const swapNonce = i.swapNonce ?? newSwapNonce();
  const keys = takerSwapKeys(i.seed, 'ethereum', swapNonce);
  const direction: 0 | 1 = i.quote.direction === 0 ? 0 : 1;
  const p = priceEthQuote(i.quote, i.xmr);
  const takerKeys = ethereumOpenKeys(keys, direction, i.maker);
  const limit = bound(p.amount, direction, i.slippageBps ?? 0);
  const common = { quote: i.quote, sig: i.sig, xmr: i.xmr, swapNonce, sessionKey: takerKeys.sessionKey as Address, sessionBudget: i.sessionBudget, takerKeys, ...(i.approval ? { approval: i.approval } : {}) };
  let call: EthCall;
  if (direction === 0) {
    if (!i.leaf) throw new SdkError('NoLeaf', 'a direction-A lock names a pool leaf with a verified proof');
    call = i.contract.lock({ ...common, amount: p.amount, maxPay: limit, leaf: i.leaf });
  } else call = i.contract.take({ ...common, deposit: p.deposit, minReceive: limit });
  return { direction, swapNonce, swapId: ethSwapId(unhex(i.taker), swapNonce), keys, amount: p.amount, deposit: p.deposit, depth: p.depth, limit, call };
}
