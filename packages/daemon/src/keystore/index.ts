/**
 * Keys and custody (SPEC 7.3). `keystore.json` in the data directory holds the key-share seed
 * and the two operator keys, sealed with the passphrase (scrypt + XChaCha20-Poly1305, through
 * the core). It never holds a cold owner key. Encryption private keys live in the database,
 * sealed with a key derived from the seed. Nothing here logs a secret.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type DerivedKeys, passphraseOpen, passphraseSeal } from '@xmrswap/core-wasm';
import type { ChainName } from '@xmrswap/protocol';
import { type EthSigner, type SolanaSigner, makerShareKeys, seedSigner } from '@xmrswap/sdk';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type Bytes, hex, unhex } from '../util.js';

export interface KeystoreSecrets {
  /** The key-share seed (32 bytes): every maker spend and view share derives from it and a random share id. */
  seed: Bytes;
  /** Ed25519 seed of the Solana operator (hot) key. */
  solanaOperator: Bytes;
  /** secp256k1 private key of the Ethereum operator (hot) key. */
  ethereumOperator: Bytes;
}

const FILE = 'keystore.json';
const TOKEN_FILE = 'api-token';

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

export class Keystore {
  readonly solana: SolanaSigner;
  readonly ethereum: PrivateKeyAccount;
  private readonly dbKey: Buffer;

  constructor(private readonly secrets: KeystoreSecrets) {
    for (const [name, v] of Object.entries(secrets)) if (!(v instanceof Uint8Array) || v.length !== 32) throw new KeystoreError(`${name} must be 32 bytes`);
    this.solana = seedSigner(secrets.solanaOperator);
    this.ethereum = privateKeyToAccount(`0x${hex(secrets.ethereumOperator)}`);
    this.dbKey = Buffer.from(hkdfSync('sha256', secrets.seed, Buffer.from('xmrswap-daemon'), Buffer.from('enc-keys/v1'), 32));
  }

  static generate(): Keystore {
    return new Keystore({ seed: randomBytes(32), solanaOperator: randomBytes(32), ethereumOperator: randomBytes(32) });
  }
  static exists(dir: string): boolean {
    return existsSync(path.join(dir, FILE));
  }
  /** Seal and write `keystore.json` (mode 0600). Refuses to overwrite an existing file. */
  save(dir: string, passphrase: string): void {
    if (!passphrase) throw new KeystoreError('the keystore passphrase is empty');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    if (existsSync(file)) throw new KeystoreError(`${file} exists; refusing to overwrite a keystore`);
    const plain = Buffer.from(JSON.stringify({ seed: hex(this.secrets.seed), solana_operator: hex(this.secrets.solanaOperator), ethereum_operator: hex(this.secrets.ethereumOperator) }));
    writeFileSync(file, JSON.stringify({ version: 1, sealed: Buffer.from(passphraseSeal(passphrase, plain)).toString('base64') }), { mode: 0o600 });
  }
  static open(dir: string, passphrase: string): Keystore {
    const file = path.join(dir, FILE);
    let parsed: { version?: number; sealed?: string };
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; sealed?: string };
    } catch {
      throw new KeystoreError(`cannot read ${file}`);
    }
    if (parsed.version !== 1 || typeof parsed.sealed !== 'string') throw new KeystoreError('unknown keystore format');
    let plain: Bytes;
    try {
      plain = passphraseOpen(passphrase, Uint8Array.from(Buffer.from(parsed.sealed, 'base64')));
    } catch {
      throw new KeystoreError('wrong passphrase, or the keystore is damaged');
    }
    const j = JSON.parse(Buffer.from(plain).toString('utf8')) as { seed: string; solana_operator: string; ethereum_operator: string };
    return new Keystore({ seed: unhex(j.seed), solanaOperator: unhex(j.solana_operator), ethereumOperator: unhex(j.ethereum_operator) });
  }
  /** Open the keystore of a data directory, creating a fresh one on first start. */
  static openOrCreate(dir: string, passphrase: string): Keystore {
    if (Keystore.exists(dir)) return Keystore.open(dir, passphrase);
    const k = Keystore.generate();
    k.save(dir, passphrase);
    return k;
  }

  /** The Solana operator's Ed25519 seed: signs envelopes and advance approvals through the SDK. */
  get solanaOperatorSeed(): Bytes {
    return this.secrets.solanaOperator;
  }
  get ethereumOperatorKey(): `0x${string}` {
    return `0x${hex(this.secrets.ethereumOperator)}`;
  }
  get ethSigner(): EthSigner {
    return this.ethereum as unknown as EthSigner;
  }
  /** Re-derive a share's keys from the seed and its share id (the secret itself is never stored). */
  shareKeys(chain: ChainName, shareIdHex: string): DerivedKeys {
    return makerShareKeys(this.secrets.seed, chain, unhex(shareIdHex));
  }

  /** Seal a database secret (an X25519 private key): AES-256-GCM, `nonce[12] ‖ tag[16] ‖ ciphertext`. */
  sealDb(plain: Bytes): Bytes {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.dbKey, nonce);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Uint8Array.from(Buffer.concat([nonce, c.getAuthTag(), ct]));
  }
  openDb(sealed: Bytes): Bytes {
    const b = Buffer.from(sealed);
    const d = createDecipheriv('aes-256-gcm', this.dbKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Uint8Array.from(Buffer.concat([d.update(b.subarray(28)), d.final()]));
  }
}

/** The bearer token of the local API, kept beside the keystore (mode 0600); created on first use. */
export function apiToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, TOKEN_FILE);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
