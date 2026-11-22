/**
 * Encryption keys and their rotation (DESIGN "Key rotation"; SPEC 7.1 `rotation/`, 7.3).
 *
 * Keys are random per version and stored sealed in the database. A retired private key is kept
 * until its expiry time has passed AND every swap opened under that version has closed, then
 * deleted. Rotation is one operator-signed `rotate_enc_key`; offers are unaffected.
 */
import { randomBytes } from 'node:crypto';
import { x25519Public } from '@xmrswap/core-wasm';
import type { EncKeyView, KeysResponse } from '@xmrswap/protocol/daemon-api';
import type { SolanaChain } from '../chains/solana.js';
import type { Keystore } from '../keystore/index.js';
import type { Store } from '../store/db.js';
import type { Journal } from '../store/journal.js';
import { type Bytes, hex, unhex } from '../util.js';

export class EncKeys {
  constructor(
    private readonly store: Store,
    private readonly keystore: Keystore,
  ) {}

  /** The private key of a version the daemon still holds, or `null` (never held, or deleted). */
  secretFor = (version: number): Bytes | null => {
    const row = this.store.encKey(version);
    return row?.sealed_secret ? this.keystore.openDb(new Uint8Array(row.sealed_secret)) : null;
  };
  publicFor(version: number): Bytes | null {
    const row = this.store.encKey(version);
    return row ? unhex(row.public_key) : null;
  }
  /** The newest published version (what the registry shows), or the newest of all before registration. */
  current(): { version: number; publicKey: Bytes } | null {
    const rows = this.store.encKeys();
    const row = [...rows].reverse().find((r) => r.published === 1) ?? rows[rows.length - 1];
    return row ? { version: row.version, publicKey: unhex(row.public_key) } : null;
  }
  /** Generate and store a key for `version` (not yet published). Idempotent per version. */
  ensure(version: number, secret: Bytes = randomBytes(32)): Bytes {
    const have = this.store.encKey(version);
    if (have) return unhex(have.public_key);
    const pub = x25519Public(secret);
    this.store.insertEncKey(version, hex(pub), this.keystore.sealDb(secret), false);
    return pub;
  }
  markPublished(version: number): void {
    this.store.updateEncKey(version, { published: true });
  }
}

export interface RotationOptions {
  store: Store;
  keys: EncKeys;
  journal: Journal;
  solana: () => SolanaChain | null;
  intervalHours: () => number;
  graceHours: () => number;
  dryRun: () => boolean;
}

export class Rotation {
  constructor(private readonly o: RotationOptions) {}

  /**
   * Bring the key table in line with the registry: adopt the registered version as published,
   * and finish (or forget) a rotation that a crash interrupted. The chain wins for state.
   */
  async reconcile(): Promise<void> {
    const sol = this.o.solana();
    if (!sol) return;
    const maker = await sol.maker(true);
    for (const row of this.o.store.encKeys()) {
      const onChain = row.version === maker.encKeyVersion && hex(maker.encKey) === row.public_key;
      const previous = row.version === maker.encKeyVersion - 1 && hex(maker.prevEncKey) === row.public_key;
      if (onChain && row.published === 0) this.o.keys.markPublished(row.version);
      if (previous && row.expires_at === null) this.o.store.updateEncKey(row.version, { expires_at: Number(maker.prevEncKeyExpiresAt), published: true });
      // A generated key whose rotation never landed, and whose version the registry has passed or not reached with this key: never published, safe to drop.
      if (row.published === 0 && !onChain && row.version <= maker.encKeyVersion) this.o.store.deleteEncKeyRow(row.version);
    }
  }

  /** Rotate now: generate the next version's key (stored first), send `rotate_enc_key`, publish. */
  async rotate(): Promise<{ version: number; tx: string }> {
    const sol = this.o.solana();
    if (!sol) throw new Error('key rotation needs the Solana registration');
    if (this.o.dryRun()) throw new Error('dry run: no transaction is sent');
    await this.reconcile();
    const maker = await sol.maker(true);
    const next = maker.encKeyVersion + 1;
    const pub = this.o.keys.ensure(next);
    const now = await sol.now();
    const prevExpiresAt = now + BigInt(Math.round(this.o.graceHours() * 3600));
    const { tx } = await this.o.journal.broadcast('sol_tx', null, { call: 'rotate_enc_key', version: next }, (onSigned) => sol.sendInstructions([sol.client.program.rotateEncKey(sol.operator, sol.makerPda, pub, prevExpiresAt)], onSigned));
    this.o.store.setMeta('last_rotation_at', String(this.o.store.now()));
    return { version: next, tx: tx! };
  }

  /** Called on a timer: finish pending rotations, rotate on schedule, delete retired keys whose grace has ended. */
  async tick(): Promise<void> {
    await this.reconcile();
    const interval = this.o.intervalHours();
    const last = Number(this.o.store.meta('last_rotation_at') ?? '0');
    if (interval > 0 && !this.o.dryRun() && this.o.solana() && this.o.store.now() - last >= interval * 3600) await this.rotate();
    await this.prune();
  }

  /** Open swaps that still need a version's private key. */
  openSwaps(version: number): number {
    return this.o.store.swaps({ open: true }).filter((s) => s.enc_version === version).length;
  }
  /** Delete a retired private key once its expiry has passed (chain time) and no open swap was opened under it. */
  async prune(): Promise<number[]> {
    const sol = this.o.solana();
    const now = sol ? Number(await sol.now()) : this.o.store.now();
    const current = this.o.keys.current()?.version ?? 0;
    const deleted: number[] = [];
    for (const row of this.o.store.encKeys()) {
      if (row.version >= current || row.sealed_secret === null || row.published === 0) continue;
      if (row.expires_at === null || now < row.expires_at) continue;
      if (this.openSwaps(row.version) > 0) continue;
      this.o.store.updateEncKey(row.version, { deleted: true });
      deleted.push(row.version);
    }
    return deleted;
  }

  view(): KeysResponse {
    const current = this.o.keys.current()?.version ?? 0;
    const keys: EncKeyView[] = this.o.store.encKeys().map((r) => ({ version: r.version, public_key: r.public_key, current: r.version === current, expires_at: r.expires_at, open_swaps: this.openSwaps(r.version), deleted_at: r.deleted_at }));
    const interval = this.o.intervalHours();
    const last = Number(this.o.store.meta('last_rotation_at') ?? '0');
    return { keys, rotation_interval_hours: interval, grace_hours: this.o.graceHours(), next_rotation_at: interval > 0 ? (last || this.o.store.now()) + interval * 3600 : null };
  }
}
