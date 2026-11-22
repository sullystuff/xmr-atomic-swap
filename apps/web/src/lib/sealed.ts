/**
 * Private notes kept on this device (the large-swap order, inbox threads), encrypted "like the
 * seed" (SPEC 8.6): AES-256-GCM under a key the core derives from the recovery seed. Without the
 * seed the records are unreadable; with the recovery file they open again on the same device.
 */
import { deriveKeys } from '@xmrswap/core-wasm';
import { fromBase64, toBase64 } from '@xmrswap/sdk';
import type { KV } from './storage.js';

const LABEL = new TextEncoder().encode('xmrswap-web-kv01');

export class SealedStore {
  private key: Promise<CryptoKey> | null = null;
  private keyTag: string | null = null;
  constructor(
    private readonly kv: KV,
    private readonly seed: () => Uint8Array | null,
  ) {}

  private cryptoKey(): Promise<CryptoKey> | null {
    const seed = this.seed();
    if (!seed) return null;
    const k = deriveKeys(seed, 1, LABEL);
    const tag = toBase64(k.encPub);
    if (this.keyTag !== tag) {
      this.keyTag = tag;
      this.key = crypto.subtle.importKey('raw', k.encSecret.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return this.key;
  }

  /** `false` when no seed is loaded: nothing is written in clear. */
  async put(name: string, value: unknown): Promise<boolean> {
    const key = this.cryptoKey();
    if (!key) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key, new TextEncoder().encode(JSON.stringify(value))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    await this.kv.set(name, toBase64(out));
    return true;
  }

  /** `null` when absent, when no seed is loaded, or when the record was sealed under another seed. */
  async get<T>(name: string): Promise<T | null> {
    const key = this.cryptoKey();
    const stored = await this.kv.get(name);
    if (!key || !stored) return null;
    try {
      const raw = fromBase64(stored);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await key, raw.slice(12));
      return JSON.parse(new TextDecoder().decode(pt)) as T;
    } catch {
      return null;
    }
  }

  del(name: string): Promise<void> {
    return this.kv.del(name);
  }
  names(prefix: string): Promise<string[]> {
    return this.kv.keys(prefix);
  }
}
