/**
 * Transaction assembly (SPEC 4.10): the two compute-budget instructions the SDK always adds,
 * the Ed25519 instruction that carries an advance approval, legacy and v0 messages, and the
 * batching rule of the large-swap router.
 */
import { type AddressLookupTableAccount, ComputeBudgetProgram, Ed25519Program, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SOL_APPROVAL_LEN } from '@xmrswap/protocol';
import { type Bytes, SdkError, concat } from '../util.js';
import { type Key, pk } from './pdas.js';

/** A legacy or v0 transaction never exceeds this many bytes on the wire. */
export const MAX_TX_BYTES = 1232;
/** The default compute-unit limit used for the simulation that measures a transaction. */
export const SIMULATION_CU_LIMIT = 1_400_000;
/** The SDK sets the limit from simulation × 1.2 and never relies on the default (SPEC 4.9). */
export const cuLimitFromSimulation = (unitsConsumed: number): number => Math.min(SIMULATION_CU_LIMIT, Math.ceil(unitsConsumed * 1.2));

/** `SetComputeUnitLimit` and `SetComputeUnitPrice`: always both, always first. */
export function computeBudget(units: number, microLamports: bigint | number = 0): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(microLamports) })];
}
/** Index of the first instruction after the compute-budget pair: where an approval's Ed25519 instruction goes. */
export const APPROVAL_IX_INDEX = 2;

/**
 * The Ed25519 precompile instruction carrying an advance approval (SPEC 4.6): exactly one
 * signature; signature, key and message in this same instruction (all three instruction-index
 * fields `0xFFFF`). Data layout: header[2] ‖ offsets[14] ‖ pubkey[32] ‖ signature[64] ‖ message[190].
 */
export function approvalEd25519Data(operatorPub: Bytes, signature: Bytes, message: Bytes): Bytes {
  if (operatorPub.length !== 32 || signature.length !== 64) throw new SdkError('BadApproval', 'operator key is 32 bytes and the signature 64');
  if (message.length !== SOL_APPROVAL_LEN) throw new SdkError('BadApproval', `an advance approval is exactly ${SOL_APPROVAL_LEN} bytes`);
  const u16 = (n: number) => Uint8Array.of(n & 0xff, n >> 8);
  const PUB = 16;
  const SIG = PUB + 32;
  const MSG = SIG + 64;
  const head = concat(Uint8Array.of(1, 0), u16(SIG), u16(0xffff), u16(PUB), u16(0xffff), u16(MSG), u16(message.length), u16(0xffff));
  return concat(head, operatorPub, signature, message);
}
export function approvalEd25519Ix(operatorPub: Bytes, signature: Bytes, message: Bytes): TransactionInstruction {
  return new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.from(approvalEd25519Data(operatorPub, signature, message)) });
}

export interface TxPlan {
  payer: Key;
  /** Recent blockhash, base58. */
  blockhash: string;
  /** The program instructions, without the compute-budget pair. */
  instructions: TransactionInstruction[];
  /** Compute-unit limit; set it from `cuLimitFromSimulation`. */
  cuLimit: number;
  /** Priority fee in micro-lamports per compute unit. */
  cuPrice?: bigint | number;
}

/** An unsigned legacy transaction: compute budget first, then the instructions. A single lock or take is always legacy. */
export function legacyTransaction(p: TxPlan): Transaction {
  const tx = new Transaction({ feePayer: pk(p.payer), recentBlockhash: p.blockhash });
  tx.add(...computeBudget(p.cuLimit, p.cuPrice ?? 0), ...p.instructions);
  return tx;
}

/** An unsigned v0 transaction loading static accounts from lookup tables (the optional two-USDC-leg optimisation). */
export function v0Transaction(p: TxPlan, lookupTables: AddressLookupTableAccount[]): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: pk(p.payer), recentBlockhash: p.blockhash, instructions: [...computeBudget(p.cuLimit, p.cuPrice ?? 0), ...p.instructions] }).compileToV0Message(lookupTables);
  return new VersionedTransaction(message);
}

/** Serialised size on the wire, signatures included (zero-filled when not yet signed). */
export function wireSize(tx: Transaction | VersionedTransaction): number {
  return tx instanceof Transaction ? tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length : tx.serialize().length;
}

/** Throws when a transaction would not fit; web3.js itself only fails at send time. */
export function assertFits(tx: Transaction | VersionedTransaction): number {
  let size: number;
  try {
    size = wireSize(tx);
  } catch (e) {
    throw new SdkError('TransactionTooLarge', String((e as Error).message));
  }
  if (size > MAX_TX_BYTES) throw new SdkError('TransactionTooLarge', `${size} bytes is over ${MAX_TX_BYTES}`);
  return size;
}

/** A leg of a batched open, as the router sees it. */
export interface LegShape {
  /** 0 = SOL, 1 = USDC. */
  asset: number;
  /** The leg presents an advance approval. */
  approval: boolean;
}

/**
 * Batching rule for the large-swap tool (SPEC 4.10): two SOL legs per legacy transaction; one
 * USDC leg per legacy transaction (two with the protocol lookup table); a leg that uses an
 * advance approval travels alone. Returns groups of leg indices, in order.
 */
export function packLegs(legs: readonly LegShape[], opts: { lookupTable?: boolean } = {}): number[][] {
  const groups: number[][] = [];
  let open: { asset: number; members: number[] } | null = null;
  legs.forEach((leg, i) => {
    const cap = leg.asset === 0 ? 2 : opts.lookupTable ? 2 : 1;
    if (leg.approval || cap === 1) {
      groups.push([i]);
      return;
    }
    if (open && open.asset === leg.asset && open.members.length < cap) {
      open.members.push(i);
      if (open.members.length === cap) open = null;
      return;
    }
    open = { asset: leg.asset, members: [i] };
    groups.push(open.members);
  });
  return groups;
}

/** The Ed25519 program id, for decoding a transaction that carries an approval. */
export const ED25519_PROGRAM_ID: PublicKey = Ed25519Program.programId;
