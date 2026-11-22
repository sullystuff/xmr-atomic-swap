/**
 * The recovery seed in the page (SPEC 8.3, 8.4).
 *
 * One 32-byte seed covers every swap: each swap's spend share, view share, session key and
 * encryption key are derived from it and the swap's on-chain nonce. The seed lives:
 *  - in memory while the tab is open;
 *  - in `sessionStorage`, so a reload of this tab resumes at once with no prompt (it is gone
 *    when the tab closes; a compromised page could read the in-memory copy just as well);
 *  - optionally in IndexedDB, sealed under a passphrase (scrypt + XChaCha20-Poly1305 in the
 *    core), so a reopened browser can resume after the passphrase is typed;
 *  - in the recovery file the user downloads before the first lock. The file is the backup.
 *
 * `backedUp` is what gates every lock: the file was downloaded in this browser and the user
 * confirmed it is saved, or the seed was loaded from a file (which therefore exists).
 */
import { deriveKeys, passphraseOpen, passphraseSeal } from '@xmrswap/core-wasm';
import type { ChainName, RecoveryFile, RecoveryFilePlain } from '@xmrswap/protocol';
import { createRecoveryFile, encryptRecoveryFile, fromBase64, hex, isEncrypted, matchesDeployment, readRecoveryFile, recoverySeed, toBase64, unhex, withWallet, writeRecoveryFile } from '@xmrswap/sdk';
import { type KV, local } from './storage.js';

const SESSION_KEY = 'xmrswap.seed';
const SEALED_KEY = 'vault.sealed';
const META_KEY = 'xmrswap.vault.meta';

interface Meta {
  /** Public tag of the seed the flags below belong to. */
  tag: string;
  downloaded: boolean;
  confirmed: boolean;
  createdAt: string;
  wallets: { solana: string[]; ethereum: string[] };
}

export interface VaultState {
  /** A seed is in memory. */
  unlocked: boolean;
  /** A sealed seed is stored on this device and needs its passphrase. */
  sealedOnDevice: boolean;
  /** The recovery file was downloaded in this browser. */
  downloaded: boolean;
  /** The user confirmed the file is saved (or loaded the seed from a file). Locks are refused until this is true. */
  backedUp: boolean;
  /** Short public fingerprint of the seed, to tell files apart. */
  tag: string | null;
}

/** A public fingerprint of a seed: part of a derived public key, never the seed itself. */
export const seedTag = (seed: Uint8Array): string => hex(deriveKeys(seed, 1, new Uint8Array(16)).encPub).slice(0, 12);

export class Vault {
  private seed: Uint8Array | null = null;
  private meta: Meta | null = null;
  private sealed = false;
  private listeners = new Set<() => void>();
  private snapshot: VaultState = { unlocked: false, sealedOnDevice: false, downloaded: false, backedUp: false, tag: null };

  constructor(
    private readonly kv: KV,
    private readonly deployment: () => { programId: string; contract: string },
  ) {}

  subscribe = (f: () => void): (() => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
  getState = (): VaultState => this.snapshot;
  private emit(): void {
    this.snapshot = {
      unlocked: this.seed !== null,
      sealedOnDevice: this.sealed,
      downloaded: this.meta?.downloaded ?? false,
      backedUp: this.seed !== null && (this.meta?.confirmed ?? false),
      tag: this.meta?.tag ?? null,
    };
    for (const f of this.listeners) f();
  }

  /** Restore what survives a reload: the tab's seed, and whether a sealed copy exists. */
  async init(): Promise<void> {
    this.sealed = (await this.kv.get(SEALED_KEY)) !== null;
    try {
      const s = sessionStorage.getItem(SESSION_KEY);
      if (s && /^[0-9a-f]{64}$/.test(s)) this.adopt(unhex(s), false);
    } catch {
      // No sessionStorage: the seed stays in memory only.
    }
    this.emit();
  }

  private adopt(seed: Uint8Array, fromFile: boolean, file?: RecoveryFile): void {
    this.seed = seed;
    const tag = seedTag(seed);
    const stored = local.get<Meta | null>(META_KEY, null);
    this.meta =
      stored && stored.tag === tag
        ? stored
        : { tag, downloaded: false, confirmed: false, createdAt: file?.created_at ?? new Date().toISOString(), wallets: { solana: [...(file?.wallets.solana ?? [])], ethereum: [...(file?.wallets.ethereum ?? [])] } };
    if (fromFile) {
      this.meta.downloaded = true;
      this.meta.confirmed = true;
    }
    local.set(META_KEY, this.meta);
    try {
      sessionStorage.setItem(SESSION_KEY, hex(seed));
    } catch {
      // memory only
    }
  }

  /** The seed, for key derivation. Throws when the vault is locked. */
  requireSeed(): Uint8Array {
    if (!this.seed) throw new Error('The recovery seed is not loaded.');
    return this.seed;
  }
  get hasSeed(): boolean {
    return this.seed !== null;
  }

  /** Make a fresh seed. Nothing is backed up yet: locks stay disabled. */
  create(): void {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    this.adopt(seed, false);
    this.emit();
  }

  /** Record a wallet address in the file's wallet list (it tells a restored browser which wallets to look up). */
  noteWallet(chain: ChainName, address: string): void {
    if (!this.meta || this.meta.wallets[chain].includes(address)) return;
    this.meta.wallets[chain].push(address);
    local.set(META_KEY, this.meta);
  }
  wallets(): { solana: string[]; ethereum: string[] } {
    return this.meta?.wallets ?? { solana: [], ethereum: [] };
  }

  /** The text of the recovery file, optionally sealed under a passphrase (takes about a second). */
  fileText(passphrase?: string): string {
    const seed = this.requireSeed();
    const d = this.deployment();
    let file: RecoveryFilePlain = createRecoveryFile({ seed, programId: d.programId, contract: d.contract, createdAt: new Date(this.meta?.createdAt ?? Date.now()) });
    for (const a of this.meta?.wallets.solana ?? []) file = withWallet(file, 'solana', a);
    for (const a of this.meta?.wallets.ethereum ?? []) file = withWallet(file, 'ethereum', a);
    return writeRecoveryFile(passphrase ? encryptRecoveryFile(file, passphrase) : file);
  }

  /** The download was handed to the browser. The user still has to confirm that the file is saved. */
  markDownloaded(): void {
    if (!this.meta) return;
    this.meta.downloaded = true;
    local.set(META_KEY, this.meta);
    this.emit();
  }

  /** The user's statement that the file is saved somewhere safe. Only possible after a download. */
  confirmSaved(confirmed: boolean): void {
    if (!this.meta || !this.meta.downloaded) return;
    this.meta.confirmed = confirmed;
    local.set(META_KEY, this.meta);
    this.emit();
  }

  /**
   * Load a recovery file. Returns a warning when the file was made for another program or
   * contract (the keys derive correctly, but the user is probably looking at the wrong chain state).
   */
  load(text: string, passphrase?: string): { warning: string | null } {
    const file = readRecoveryFile(text);
    if (isEncrypted(file) && !passphrase) throw new Error('This recovery file is protected by a passphrase. Type it to open the file.');
    let seed: Uint8Array;
    try {
      seed = recoverySeed(file, passphrase);
    } catch {
      throw new Error('That passphrase does not open this recovery file.');
    }
    this.adopt(seed, true, file);
    this.emit();
    const d = this.deployment();
    return { warning: matchesDeployment(file, d.programId, d.contract) ? null : 'This recovery file was made for a different program or contract than this site uses. Your swaps may be on the other deployment.' };
  }

  /** Keep a sealed copy on this device so a reopened browser can resume after the passphrase is typed. */
  async remember(passphrase: string): Promise<void> {
    if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    await this.kv.set(SEALED_KEY, toBase64(passphraseSeal(passphrase, this.requireSeed())));
    this.sealed = true;
    this.emit();
  }

  /** Open the sealed copy stored on this device. */
  async unlock(passphrase: string): Promise<void> {
    const sealed = await this.kv.get(SEALED_KEY);
    if (!sealed) throw new Error('No recovery seed is stored on this device.');
    let seed: Uint8Array;
    try {
      seed = passphraseOpen(passphrase, fromBase64(sealed));
    } catch {
      throw new Error('That passphrase is wrong.');
    }
    this.adopt(seed, false);
    this.emit();
  }

  /** Remove the seed from this browser (memory, tab storage and the sealed copy). The recovery file is then the only copy. */
  async forget(): Promise<void> {
    this.seed = null;
    this.meta = null;
    this.sealed = false;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // nothing stored
    }
    local.del(META_KEY);
    await this.kv.del(SEALED_KEY);
    this.emit();
  }
}

/** Hand a text file to the browser's download machinery. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
