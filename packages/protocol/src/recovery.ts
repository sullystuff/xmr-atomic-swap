/**
 * The recovery file (SPEC 8.4). One file covers every swap: every per-swap secret is derived
 * from the seed and the swap's on-chain nonce.
 */
export const RECOVERY_FORMAT = 'xmrswap-recovery/1';

interface RecoveryBase {
  format: typeof RECOVERY_FORMAT;
  /** ISO 8601, UTC. */
  created_at: string;
  wallets: { solana: string[]; ethereum: string[] };
  /** Solana program id the file was made for. */
  program_id: string;
  /** Ethereum contract (proxy) address. */
  contract: string;
}
export interface RecoveryFilePlain extends RecoveryBase {
  /** 32 bytes, lowercase hex. */
  seed: string;
}
export interface RecoveryFileEncrypted extends RecoveryBase {
  /** `passphraseSeal(passphrase, seed)` of `@xmrswap/core-wasm`, base64. */
  seed_enc: string;
}
export type RecoveryFile = RecoveryFilePlain | RecoveryFileEncrypted;

export class RecoveryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryFileError';
  }
}

/** Validate the shape of a parsed recovery file. Does not decrypt. */
export function parseRecoveryFile(json: string): RecoveryFile {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new RecoveryFileError('not JSON');
  }
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object' || o === null) throw new RecoveryFileError('not an object');
  if (o.format !== RECOVERY_FORMAT) throw new RecoveryFileError(`unsupported format ${JSON.stringify(o.format)}`);
  const hasSeed = typeof o.seed === 'string';
  const hasEnc = typeof o.seed_enc === 'string';
  if (hasSeed === hasEnc) throw new RecoveryFileError('exactly one of seed and seed_enc is required');
  if (hasSeed && !/^[0-9a-f]{64}$/.test(o.seed as string)) throw new RecoveryFileError('seed must be 32 bytes of lowercase hex');
  if (typeof o.created_at !== 'string' || Number.isNaN(Date.parse(o.created_at))) throw new RecoveryFileError('created_at must be an ISO date');
  const w = o.wallets as Record<string, unknown> | undefined;
  const list = (x: unknown) => Array.isArray(x) && x.every((a) => typeof a === 'string');
  if (typeof w !== 'object' || w === null || !list(w.solana) || !list(w.ethereum)) throw new RecoveryFileError('wallets must list solana and ethereum addresses');
  if (typeof o.program_id !== 'string' || typeof o.contract !== 'string') throw new RecoveryFileError('program_id and contract are required');
  return o as unknown as RecoveryFile;
}

/** What "Export keys" writes for a swap whose two spend shares are known; restores in standard Monero wallet software ("generate from keys"). */
export interface ExportedJointWallet {
  address: string;
  /** Private view key, lowercase hex. */
  view_key: string;
  /** Private spend key, lowercase hex. */
  spend_key: string;
  lock_txid: string;
  lock_height: number;
}
