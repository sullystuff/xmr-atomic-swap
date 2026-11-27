/**
 * The watcher's two keys and everything that may be done with them.
 *
 * `WatcherKeys` is the only holder of key material in the process, and it offers exactly five
 * operations: open a watch request sealed to the Solana key, sign an acknowledgement, seal and
 * open a notice key for storage, and sign a transaction **after proving to itself that the
 * transaction is one `freeze` and nothing else**. There is no "sign these bytes" method: a
 * caller with a bug, or one misled by a lying RPC endpoint, cannot obtain a signature over
 * anything but a freeze of the named swap on the pinned program or contract (SPEC 11.6: "it
 * can call `freeze` once on a swap that names it" and nothing more).
 *
 * The keystore file holds both keys sealed under a passphrase (scrypt + XChaCha20-Poly1305,
 * through the core, as the maker daemon's keystore); the passphrase comes from the environment.
 * The watcher holds no Monero key, no spend share and no encryption secret of any swap.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ComputeBudgetProgram, Message, PublicKey, type Transaction } from '@solana/web3.js';
import { passphraseOpen, passphraseSeal } from '@xmrswap/core-wasm';
import { type ChainName, base58Decode, encodeInstructionData } from '@xmrswap/protocol';
import { type Bytes, type WatchAck, XmrSwapContract, configPda, hex, openWatchRequest, seedSigner, signWatchAck, unhex } from '@xmrswap/sdk';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';

const FILE = 'watcher-keystore.json';

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}
/** A transaction was offered for signing that is not exactly one permitted `freeze`. Nothing was signed. */
export class NotAFreeze extends Error {
  readonly code = 'NotAFreeze';
  constructor(detail: string) {
    super(`refusing to sign: ${detail}`);
    this.name = 'NotAFreeze';
  }
}

/** What a Solana freeze must look like to be signed. */
export interface SolanaPins {
  programId: string;
  maxComputeUnits: number;
  maxPriorityFeeMicroLamports: bigint;
}
/** What an Ethereum freeze must look like to be signed. */
export interface EthereumPins {
  contract: `0x${string}`;
  chainId: number;
  maxGas: bigint;
  maxFeePerGas: bigint;
}
export interface EthFreezeTx {
  chainId: number;
  nonce: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

const FREEZE_DATA = encodeInstructionData('freeze', {});
/** Compiled instruction data is base58 text in web3.js's legacy `Message`. */
function decodeIxData(data: string): Uint8Array {
  try {
    return data === '' ? new Uint8Array(0) : base58Decode(data);
  } catch {
    throw new NotAFreeze('undecodable instruction data');
  }
}
const bytesEq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Throws `NotAFreeze` unless `messageBytes` is a legacy message that: is paid and signed by
 * `watcher` alone; holds exactly `SetComputeUnitLimit`, `SetComputeUnitPrice` (both within the
 * pins) and one instruction of the pinned program whose data is the `freeze` discriminator and
 * nothing else, on accounts `(watcher, swapRef, <maker>, config PDA)`.
 */
export function assertSolanaFreeze(messageBytes: Bytes, watcher: string, swapRef: Bytes, pins: SolanaPins): void {
  let m: Message;
  try {
    m = Message.from(messageBytes);
  } catch {
    throw new NotAFreeze('not a legacy Solana message');
  }
  const keys = m.accountKeys.map((k) => k.toBase58());
  if (m.header.numRequiredSignatures !== 1 || keys[0] !== watcher) throw new NotAFreeze('the watcher must be the only signer and the fee payer');
  if (m.instructions.length !== 3) throw new NotAFreeze(`expected 3 instructions, got ${m.instructions.length}`);
  const ix = m.instructions.map((i) => ({ program: keys[i.programIdIndex]!, accounts: i.accounts.map((a) => keys[a]!), data: decodeIxData(i.data) }));
  const budget = ComputeBudgetProgram.programId.toBase58();
  const [limit, price, freeze] = ix as [(typeof ix)[0], (typeof ix)[0], (typeof ix)[0]];
  if (limit.program !== budget || limit.accounts.length !== 0 || limit.data.length !== 5 || limit.data[0] !== 2) throw new NotAFreeze('instruction 0 is not SetComputeUnitLimit');
  if (new DataView(limit.data.buffer, limit.data.byteOffset).getUint32(1, true) > pins.maxComputeUnits) throw new NotAFreeze('the compute-unit limit is above the configured bound');
  if (price.program !== budget || price.accounts.length !== 0 || price.data.length !== 9 || price.data[0] !== 3) throw new NotAFreeze('instruction 1 is not SetComputeUnitPrice');
  if (new DataView(price.data.buffer, price.data.byteOffset).getBigUint64(1, true) > pins.maxPriorityFeeMicroLamports) throw new NotAFreeze('the priority fee is above the configured bound');
  if (freeze.program !== pins.programId) throw new NotAFreeze('instruction 2 is not for the swap program');
  if (!bytesEq(freeze.data, FREEZE_DATA)) throw new NotAFreeze('instruction 2 is not `freeze`');
  if (freeze.accounts.length !== 4 || freeze.accounts[0] !== watcher || freeze.accounts[1] !== new PublicKey(swapRef).toBase58() || freeze.accounts[3] !== configPda(pins.programId).toBase58())
    throw new NotAFreeze('the freeze does not name the watcher, this swap and the program config');
}
/** Throws `NotAFreeze` unless `tx` calls `freeze(swapRef)` on the pinned contract, on the pinned chain, with no value and within the gas and fee pins. */
export function assertEthereumFreeze(tx: EthFreezeTx, swapRef: Bytes, pins: EthereumPins): void {
  if (tx.chainId !== pins.chainId) throw new NotAFreeze('wrong chain id');
  if (tx.to.toLowerCase() !== pins.contract.toLowerCase()) throw new NotAFreeze('not addressed to the swap contract');
  if (tx.value !== 0n) throw new NotAFreeze('a freeze carries no value');
  if (tx.data.toLowerCase() !== new XmrSwapContract(pins.contract).freeze(swapRef).data.toLowerCase()) throw new NotAFreeze('the calldata is not `freeze` of this swap');
  if (tx.gas > pins.maxGas) throw new NotAFreeze('the gas limit is above the bound');
  if (tx.maxFeePerGas > pins.maxFeePerGas || tx.maxPriorityFeePerGas > tx.maxFeePerGas) throw new NotAFreeze('the fee per gas is above the configured bound');
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) throw new NotAFreeze('bad nonce');
}

export class WatcherKeys {
  /** The Solana key, base58: named as watcher on Solana; notice keys are sealed to it and acknowledgements signed with it. */
  readonly solana: string;
  /** The Ethereum address, lowercase: named as watcher there. */
  readonly ethereum: `0x${string}`;
  readonly #solanaSeed: Bytes;
  readonly #eth: PrivateKeyAccount;
  readonly #ethKey: Bytes;
  readonly #dbKey: Buffer;

  constructor(solanaSeed: Bytes, ethereumKey: Bytes) {
    if (solanaSeed.length !== 32 || ethereumKey.length !== 32) throw new KeystoreError('both keys are 32 bytes');
    this.#solanaSeed = solanaSeed.slice();
    this.solana = seedSigner(this.#solanaSeed).publicKey;
    this.#ethKey = ethereumKey.slice();
    this.#eth = privateKeyToAccount(`0x${hex(this.#ethKey)}`);
    this.ethereum = this.#eth.address.toLowerCase() as `0x${string}`;
    this.#dbKey = Buffer.from(hkdfSync('sha256', this.#solanaSeed, Buffer.from('xmrswap-watcher'), Buffer.from('notice-keys/v1'), 32));
  }

  static generate(): WatcherKeys {
    return new WatcherKeys(randomBytes(32), randomBytes(32));
  }
  static exists(dir: string): boolean {
    return existsSync(path.join(dir, FILE));
  }
  /** The public keys recorded in a keystore file, readable without the passphrase. */
  static publicKeys(dir: string): { solana: string; ethereum: string } {
    const j = readKeystore(dir);
    return { solana: j.solana, ethereum: j.ethereum };
  }
  /** Seal and write the keystore (mode 0600). Refuses to overwrite an existing file. */
  save(dir: string, passphrase: string): void {
    if (!passphrase) throw new KeystoreError('the keystore passphrase is empty');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, FILE);
    if (existsSync(file)) throw new KeystoreError(`${file} exists; refusing to overwrite a keystore`);
    const plain = Buffer.from(JSON.stringify({ solana_seed: hex(this.#solanaSeed), ethereum_key: hex(this.#ethKey) }));
    writeFileSync(file, JSON.stringify({ version: 1, solana: this.solana, ethereum: this.ethereum, sealed: Buffer.from(passphraseSeal(passphrase, plain)).toString('base64') }), { mode: 0o600, flag: 'wx' });
  }
  static open(dir: string, passphrase: string): WatcherKeys {
    const parsed = readKeystore(dir);
    let plain: Bytes;
    try {
      plain = passphraseOpen(passphrase, Uint8Array.from(Buffer.from(parsed.sealed, 'base64')));
    } catch {
      throw new KeystoreError('wrong passphrase, or the keystore is damaged');
    }
    const j = JSON.parse(Buffer.from(plain).toString('utf8')) as { solana_seed: string; ethereum_key: string };
    const keys = new WatcherKeys(unhex(j.solana_seed), unhex(j.ethereum_key));
    if (keys.solana !== parsed.solana || keys.ethereum !== parsed.ethereum.toLowerCase()) throw new KeystoreError('the keystore does not hold the keys it names');
    return keys;
  }
  /** Open the keystore of a data directory, generating both keys on first start. */
  static openOrCreate(dir: string, passphrase: string): { keys: WatcherKeys; created: boolean } {
    if (!passphrase) throw new KeystoreError('the keystore passphrase is empty');
    if (WatcherKeys.exists(dir)) return { keys: WatcherKeys.open(dir, passphrase), created: false };
    const keys = WatcherKeys.generate();
    keys.save(dir, passphrase);
    return { keys, created: true };
  }

  // ---------------------------------------------------------------- the watch protocol

  /** Validate a watch request and recover the notice key sealed to this watcher for that chain and swap (SDK `openWatchRequest`). */
  openRequest(body: unknown): { chain: ChainName; swapRef: Bytes; noticeKey: Bytes } {
    return openWatchRequest(body, this.#solanaSeed);
  }
  signAck(chain: ChainName, swapRef: Bytes, watchingUntil: bigint): WatchAck {
    return signWatchAck({ chain, swapRef, watchingUntil, watcherSeed: this.#solanaSeed });
  }

  // ---------------------------------------------------------------- notice keys at rest

  /** AES-256-GCM under a key derived from the keystore, bound to the chain and the swap. */
  sealForStore(chain: ChainName, swapRef: Bytes, noticeKey: Bytes): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#dbKey, iv);
    c.setAAD(Buffer.concat([Buffer.from(chain), Buffer.from(swapRef)]));
    const ct = Buffer.concat([c.update(noticeKey), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  openFromStore(chain: ChainName, swapRef: Bytes, sealed: Uint8Array): Bytes {
    const b = Buffer.from(sealed);
    const d = createDecipheriv('aes-256-gcm', this.#dbKey, b.subarray(0, 12));
    d.setAAD(Buffer.concat([Buffer.from(chain), Buffer.from(swapRef)]));
    d.setAuthTag(b.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
  }

  // ---------------------------------------------------------------- the only two signatures over transactions

  /** Sign an unsigned legacy transaction if and only if it is one freeze of `swapRef` (`assertSolanaFreeze`). Returns the wire bytes and the signature. */
  signSolanaFreeze(tx: Transaction, swapRef: Bytes, pins: SolanaPins): { wire: Bytes; signature: Bytes } {
    const message = new Uint8Array(tx.serializeMessage());
    assertSolanaFreeze(message, this.solana, swapRef, pins);
    const signature = seedSigner(this.#solanaSeed).sign(message) as Bytes;
    tx.addSignature(new PublicKey(this.solana), Buffer.from(signature));
    // The bytes that leave are the bytes that were checked.
    const wire = new Uint8Array(tx.serialize());
    if (!bytesEq(wire.subarray(1 + 64), message)) throw new NotAFreeze('the serialised transaction differs from the checked message');
    return { wire, signature };
  }

  /** Sign an EIP-1559 transaction if and only if it is `freeze(swapRef)` on the pinned contract and chain (`assertEthereumFreeze`). */
  async signEthereumFreeze(tx: EthFreezeTx, swapRef: Bytes, pins: EthereumPins): Promise<`0x${string}`> {
    assertEthereumFreeze(tx, swapRef, pins);
    return this.#eth.signTransaction({ type: 'eip1559', ...tx });
  }
}

function readKeystore(dir: string): { version: number; solana: string; ethereum: string; sealed: string } {
  const file = path.join(dir, FILE);
  let parsed: { version?: number; solana?: string; ethereum?: string; sealed?: string };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
  } catch {
    throw new KeystoreError(`cannot read ${file}`);
  }
  if (parsed.version !== 1 || typeof parsed.sealed !== 'string' || typeof parsed.solana !== 'string' || typeof parsed.ethereum !== 'string') throw new KeystoreError('unknown keystore format');
  return parsed as { version: number; solana: string; ethereum: string; sealed: string };
}
