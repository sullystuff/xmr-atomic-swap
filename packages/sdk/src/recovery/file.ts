/**
 * The recovery file (SPEC 8.4): one file for every swap, because each per-swap secret is derived
 * from the seed and the swap's on-chain nonce. The format and its shape check are frozen in
 * `@xmrswap/protocol`; this module creates, encrypts, opens and uses it.
 */
import { type DerivedKeys, passphraseOpen, passphraseSeal } from '@xmrswap/core-wasm';
import { type ChainName, RECOVERY_FORMAT, type RecoveryFile, type RecoveryFileEncrypted, RecoveryFileError, type RecoveryFilePlain, parseRecoveryFile } from '@xmrswap/protocol';
import { takerSwapKeys } from '../flows/keys.js';
import { type Bytes, fromBase64, hex, toBase64, unhex } from '../util.js';

export interface RecoveryInit {
  /** 32 bytes; defaults to fresh randomness. */
  seed?: Bytes;
  wallets?: { solana?: string[]; ethereum?: string[] };
  /** The Solana program id and Ethereum contract the file is made for. */
  programId: string;
  contract: string;
  /** Defaults to now. The only use of a local clock in the SDK: it is a label, not a deadline. */
  createdAt?: Date;
}

/** A new plain recovery file. Created and downloaded before the first lock. */
export function createRecoveryFile(init: RecoveryInit): RecoveryFilePlain {
  const seed = init.seed ?? crypto.getRandomValues(new Uint8Array(32));
  if (seed.length !== 32) throw new RecoveryFileError('the seed is 32 bytes');
  return {
    format: RECOVERY_FORMAT,
    created_at: (init.createdAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    seed: hex(seed),
    wallets: { solana: [...(init.wallets?.solana ?? [])], ethereum: [...(init.wallets?.ethereum ?? [])] },
    program_id: init.programId,
    contract: init.contract,
  };
}

export const isEncrypted = (f: RecoveryFile): f is RecoveryFileEncrypted => 'seed_enc' in f;

/** Replace the seed by `seed_enc` (scrypt + XChaCha20-Poly1305 through core-wasm; takes about a second). */
export function encryptRecoveryFile(file: RecoveryFilePlain, passphrase: string): RecoveryFileEncrypted {
  if (passphrase.length === 0) throw new RecoveryFileError('an empty passphrase protects nothing');
  const { seed, ...rest } = file;
  return { ...rest, seed_enc: toBase64(passphraseSeal(passphrase, unhex(seed))) };
}

/** The 32-byte seed of a recovery file. An encrypted file needs its passphrase; a wrong one throws. */
export function recoverySeed(file: RecoveryFile, passphrase?: string): Bytes {
  if (!isEncrypted(file)) return unhex(file.seed);
  if (passphrase === undefined) throw new RecoveryFileError('this recovery file is encrypted: a passphrase is required');
  let seed: Bytes;
  try {
    seed = passphraseOpen(passphrase, fromBase64(file.seed_enc));
  } catch {
    throw new RecoveryFileError('wrong passphrase or damaged recovery file');
  }
  if (seed.length !== 32) throw new RecoveryFileError('the decrypted seed is not 32 bytes');
  return seed;
}

/** Parse and shape-check the text of a recovery file (frozen rules of `@xmrswap/protocol`). */
export function readRecoveryFile(text: string): RecoveryFile {
  return parseRecoveryFile(text);
}

/** The text to download. */
export function writeRecoveryFile(file: RecoveryFile): string {
  parseRecoveryFile(JSON.stringify(file));
  return JSON.stringify(file, null, 2) + '\n';
}

/** Record a wallet address in the file (idempotent). */
export function withWallet<F extends RecoveryFile>(file: F, chain: ChainName, address: string): F {
  const list = file.wallets[chain];
  const norm = chain === 'ethereum' ? address.toLowerCase() : address;
  if (list.some((a) => (chain === 'ethereum' ? a.toLowerCase() : a) === norm)) return file;
  return { ...file, wallets: { ...file.wallets, [chain]: [...list, norm] } };
}

/**
 * The file was made for this deployment. A file for another program id or contract would derive
 * the right keys but the caller is probably looking at the wrong chain state.
 */
export function matchesDeployment(file: RecoveryFile, programId: string, contract: string): boolean {
  return file.program_id === programId && file.contract.toLowerCase() === contract.toLowerCase();
}

/**
 * Resume: the keys of one swap from the seed and the nonce stored on-chain (Solana: in the swap
 * account; Ethereum: `getSwap(...).swapNonce`). Throws `ScalarZero` if the share id is burned.
 */
export function resumeSwapKeys(seed: Bytes, chain: ChainName, swapNonce: Bytes): DerivedKeys {
  return takerSwapKeys(seed, chain, swapNonce);
}
