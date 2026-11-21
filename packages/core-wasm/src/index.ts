/**
 * `@xmrswap/core-wasm`: the typed wrapper over the two wasm-bindgen builds of `crates/swap-core`
 * (SPEC 2.12). Everything in SPEC section 2 is implemented once, in Rust; TypeScript reaches it
 * through this module and MUST NOT re-implement it.
 *
 * Call `await init()` once before anything else. In Node it loads the `nodejs` build; in a
 * browser or worker it loads the `web` build and fetches the `.wasm` file (pass `wasm` to say
 * where it is served from when a bundler moved this module).
 *
 * Conventions: byte arguments and results are `Uint8Array`; `u64` and larger integers are
 * `bigint`; structured values are plain objects with camelCase keys. A refused input throws a
 * `CoreError` whose `code` is the Rust error name (for example `PokInvalid`).
 */

export type Bytes = Uint8Array;
export type Network = 'mainnet' | 'stagenet' | 'testnet' | 'regtest';
export type ChainName = 'solana' | 'ethereum';
/** `0x01` Solana, `0x02` Ethereum (SPEC 2.1). */
export const CHAIN_TAG = { solana: 1, ethereum: 2 } as const;
export type ChainTag = (typeof CHAIN_TAG)[ChainName];

/** A refused input or failed check. `code` is the Rust error name. */
export class CoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

export interface DerivedKeys {
  /** Spend share `s`, 32 bytes little-endian, `0 < s < 2^252`. */
  spend: Bytes;
  /** `S = s·G`. */
  spendPub: Bytes;
  /** View share `v`, canonical and nonzero. */
  view: Bytes;
  /** Solana: the 32-byte Ed25519 seed. Ethereum: the secp256k1 private key, 32 bytes big-endian. */
  sessionSecret: Bytes;
  /** Solana: the 32-byte Ed25519 public key. Ethereum: the 20-byte address. */
  sessionPub: Bytes;
  /** X25519 static secret. */
  encSecret: Bytes;
  encPub: Bytes;
}

export interface JointAddress {
  address: string;
  /** `S = S_a + S_b`. */
  spendPub: Bytes;
  /** `v = v_a + v_b mod l`: scans for the lock, cannot spend. */
  viewPriv: Bytes;
  viewPub: Bytes;
}

export interface TwinCommitments {
  /** `address(s·G_secp)`, 20 bytes. */
  keyAddr: Bytes;
  /** `address((T2·s)·G_secp)`, 20 bytes. */
  keyAddr2: Bytes;
  /** The twin public key, 33 bytes. */
  secpCompressed: Bytes;
}

export interface DleqStatement extends TwinCommitments {
  /** `S`, the ed25519 spend commitment the blob proves the twin of. */
  spendPub: Bytes;
}

export interface EnvelopeHeader {
  version: number;
  flags: number;
  /** Flag bit 0: sent by the maker. */
  fromMaker: boolean;
  makerKeyVersion: number;
  /** The non-maker party's X25519 public key: the key for the reply. */
  takerPub: Bytes;
  /** `swap_ref`, or 32 zero bytes when the message concerns no swap. */
  swapRef: Bytes;
}

export interface EnvelopeSealArgs {
  /** True when the maker is the sender. The result then still needs `envelopeSign`. */
  fromMaker: boolean;
  makerKeyVersion: number;
  /** The sender's X25519 secret. */
  ownSecret: Bytes;
  /** The recipient's X25519 public key. */
  peerPub: Bytes;
  /** Defaults to 32 zero bytes. */
  swapRef?: Bytes;
  plaintext: Bytes;
  /** 24 bytes. Defaults to fresh randomness; pass one only in tests. */
  nonce?: Bytes;
  /** Size cap for the finished envelope: 900 on-chain (`ENVELOPE_MAX_ONCHAIN`), 16,384 over Tor (the default). */
  maxLen?: number;
}

export interface EnvelopeOpenArgs {
  envelope: Bytes;
  /** The recipient's X25519 secret. */
  ownSecret: Bytes;
  /** Recipient is a taker: the maker's X25519 key of the version named in the header. */
  makerPub?: Bytes;
  /** Recipient is a taker: the maker's operator key from the registry. Required: a maker's envelope is never opened unsigned. */
  operatorPub?: Bytes;
}

export interface NoticeKeys {
  /** The caller's X25519 secret. */
  ownSecret: Bytes;
  /** The counterparty's X25519 public key as stored in the swap. */
  peerPub: Bytes;
  /** Which party the caller is. */
  side: 'taker' | 'maker';
  swapRef: Bytes;
}
export interface NoticeSealArgs extends NoticeKeys {
  /** The 32 bytes of the Monero transaction id as its hex string reads. */
  txid: Bytes;
  /** The claimer's private view share `v_C`. */
  view: Bytes;
  /** 24 bytes. Defaults to fresh randomness. */
  nonce?: Bytes;
}
export interface NoticeOpenArgs extends NoticeKeys {
  /** 104 bytes. */
  ciphertext: Bytes;
  /** The on-chain `notice_commitment`; the opening must match it. */
  commitment: Bytes;
}

export interface SolApprovalFields {
  clusterTag: Bytes;
  programId: Bytes;
  /** Maker PDA. */
  maker: Bytes;
  taker: Bytes;
  /** `0`, `1`, or `0xff` = any. */
  asset: number;
  /** `0` = A, `1` = B, `0xff` = any. */
  direction: number;
  maxXmr: bigint;
  notBefore: bigint;
  expiresAt: bigint;
  epoch: number;
  approvalId: bigint;
}

export interface TermsHashFields {
  asset: number;
  direction: number;
  mode: number;
  depBps: number;
  /** Defaults to `FEE_BPS` (5). */
  feeBps?: number;
  wA: number;
  wN: number;
  dC: number;
  wC: number;
  wF: number;
  depthAbove: [bigint, bigint, bigint];
  depths: [number, number, number];
}

export interface OpenHashSolanaFields {
  /** Swap PDA. */
  swap: Bytes;
  tLock: bigint;
  direction: number;
  asset: number;
  xmr: bigint;
  amount: bigint;
  deposit: bigint;
  takerSpendPub: Bytes;
  /** The locker's view share as stored at lock; 32 zero bytes in direction B. */
  lockerView: Bytes;
  takerEncKey: Bytes;
  makerEncKey: Bytes;
}

export interface OpenHashEthereumFields {
  swapId: Bytes;
  tLock: bigint;
  direction: number;
  /** 20 bytes; zero = ETH. */
  token: Bytes;
  xmr: bigint;
  amount: bigint;
  deposit: bigint;
  takerSpendPub: Bytes;
  takerKey: Bytes;
  takerKey2: Bytes;
  takerView: Bytes;
  takerEncKey: Bytes;
  makerEncKey: Bytes;
  keyLeaf: Bytes;
}

export interface Eip712Domain {
  chainId: bigint;
  /** The proxy address, 20 bytes. */
  verifyingContract: Bytes;
}

/** The EIP-712 `Quote` (SPEC 2.10). Addresses are 20 bytes; prices must fit `u128`. */
export interface EthQuote {
  maker: Bytes;
  /** Zero = public quote. */
  taker: Bytes;
  /** Zero = ETH. */
  token: Bytes;
  direction: number;
  approvalMode: number;
  minXmr: bigint;
  maxXmr: bigint;
  tierXmr: [bigint, bigint, bigint];
  tierPrice: [bigint, bigint, bigint];
  depthXmr: [bigint, bigint, bigint];
  depth: [number, number, number];
  depositBps: number;
  approvalWindow: number;
  noticeWindow: number;
  claimDelay: number;
  claimWindow: number;
  finalWindow: number;
  validUntil: bigint;
  epoch: number;
  keyRoot: Bytes;
  quoteId: bigint;
}

/** The EIP-712 `Approval` (SPEC 2.10). */
export interface EthApproval {
  maker: Bytes;
  taker: Bytes;
  /** A token, or 20 bytes of `0xff` = any. */
  token: Bytes;
  /** 0, 1, or 255 = any. */
  direction: number;
  maxXmr: bigint;
  notBefore: bigint;
  validUntil: bigint;
  epoch: number;
  approvalId: Bytes;
}

export interface DeadlineParams {
  chain: ChainName;
  /** How the swap starts: ACTIVE (`none`), waiting for approval (`approval`: `W_p = W_a`), or a direction-B take outside window mode (`funding`: `W_p = W_n`). */
  pending: 'none' | 'approval' | 'funding';
  wA: number;
  wN: number;
  dC: number;
  wC: number;
  wF: number;
  depth: number;
  depBps: number;
  tLock: bigint;
  tActive?: bigint;
  tNotice?: bigint;
  tReady?: bigint;
  tRefund?: bigint;
}

export interface Deadlines {
  /** Name of the first violated bound of SPEC 3.1, or `null` when the parameters are acceptable. */
  boundError: string | null;
  /** The pending window this swap uses. */
  wP: number;
  deltaCut: bigint;
  minClaimDelay: bigint;
  minClaimWindow: bigint;
  minFinalWindow: bigint;
  /** `null` = the event it derives from has not happened (or the swap does not start PENDING). */
  tPend: bigint | null;
  tNote: bigint | null;
  tCut: bigint | null;
  tCo: bigint | null;
  tReadyMin: bigint | null;
  tCd: bigint | null;
  tFinal: bigint;
  tNl: bigint;
  tExp: bigint;
  tHold: bigint | null;
  tSplit: bigint | null;
}

export interface SweepParams {
  /** Monero daemon RPC base URL. Restricted RPC is enough; browsers need CORS or the allow-listed proxy. */
  daemonUrl: string;
  network: Network;
  /** `s_maker + s_taker mod l`. */
  spendKey: Bytes;
  /** `v_maker + v_taker mod l`. */
  viewKey: Bytes;
  lockHeight: number;
  /** The verified lock transaction, 32 bytes. */
  lockTxid: Bytes;
  /** Index of the verified output inside that transaction. */
  outputIndex: bigint;
  /** Standard address or subaddress. */
  destination: string;
  /** Piconero; the sweep fails rather than pay more. */
  maxFee: bigint;
  /** `false` builds and signs only. */
  publish: boolean;
}

export interface SweepOutcome {
  jointAddress: string;
  txid: string;
  amount: bigint;
  fee: bigint;
  txHex: string;
  published: boolean;
  /** Other outputs to the joint address in the lock's block (`"<txid>:<index>"`). They were not spent. */
  ignored: { output: string; amount: bigint }[];
}

/** Size caps of SPEC 2.8. */
export const ENVELOPE_MAX_ONCHAIN = 900;
export const ENVELOPE_MAX_TOR = 16_384;
/** Largest DLEQ blob a verifier accepts (SPEC 2.6). */
export const DLEQ_MAX_BLOB = 60_000;

/** The shape of the wasm-bindgen module (both targets export the same functions). */
interface Raw {
  deriveKeys(seed: Bytes, chainTag: number, shareId: Bytes): DerivedKeys;
  contactShareId(makerPda: Bytes): Bytes;
  validatePoint(p: Bytes): boolean;
  scalarMatches(s: Bytes, commitment: Bytes): boolean;
  addScalars(a: Bytes, b: Bytes): Bytes;
  pokProve(s: Bytes, ctx: Bytes): Bytes;
  pokVerify(spendPub: Bytes, ctx: Bytes, pok: Bytes): boolean;
  jointAddress(a: Bytes, b: Bytes, viewA: Bytes, viewB: Bytes, network: string): JointAddress;
  twinCommitments(s: Bytes): TwinCommitments;
  dleqProve(s: Bytes): Bytes;
  dleqVerify(blob: Bytes): DleqStatement;
  keyLeaf(index: number, keyAddr: Bytes, keyAddr2: Bytes, spendPub: Bytes): Bytes;
  merkleRoot(leaves: Bytes[]): Bytes;
  merkleProof(leaves: Bytes[], index: number): Bytes[];
  x25519Public(secret: Bytes): Bytes;
  isLowOrderX25519(pub: Bytes): boolean;
  envelopeSeal(args: EnvelopeSealArgs): Bytes;
  envelopeOpen(args: EnvelopeOpenArgs): { plaintext: Bytes; header: EnvelopeHeader };
  envelopeHeader(envelope: Bytes): EnvelopeHeader;
  envelopeSign(envelope: Bytes, operatorSeed: Bytes): Bytes;
  envelopeVerifySig(envelope: Bytes, operatorPub: Bytes): boolean;
  noticeCommitment(swapRef: Bytes, txid: Bytes, view: Bytes): Bytes;
  noticeSeal(args: NoticeSealArgs): Bytes;
  noticeOpen(args: NoticeOpenArgs): { txid: Bytes; view: Bytes };
  encodeSolApproval(fields: SolApprovalFields): Bytes;
  termsHash(fields: TermsHashFields): Bytes;
  openHashSolana(fields: OpenHashSolanaFields): Bytes;
  openHashEthereum(fields: OpenHashEthereumFields): Bytes;
  ethSwapId(taker: Bytes, swapNonce: Bytes): Bytes;
  encodeEthQuoteCompact(quote: EthQuote, sig?: Bytes): Bytes;
  decodeEthQuoteCompact(bytes: Bytes): { quote: EthQuote; sig?: Bytes };
  quoteDigest(domain: Eip712Domain, quote: EthQuote): Bytes;
  approvalDigest(domain: Eip712Domain, approval: EthApproval): Bytes;
  payAmount(xmr: bigint, price: bigint, chain?: string): bigint;
  receiveAmount(xmr: bigint, price: bigint, chain?: string): bigint;
  depositOf(amount: bigint, bps: number): bigint;
  feeOf(amount: bigint, bps: number): bigint;
  splitOf(deposit: bigint): { toTaker: bigint; toTreasury: bigint };
  deadlines(params: DeadlineParams): Deadlines;
  passphraseSeal(passphrase: Bytes, plaintext: Bytes): Bytes;
  passphraseOpen(passphrase: Bytes, sealed: Bytes): Bytes;
  sweepJoint(params: SweepParams): Promise<SweepOutcome>;
  coreVersion(): string;
}

let raw: Raw | undefined;

const IS_NODE =
  typeof process !== 'undefined' && typeof process.versions === 'object' && typeof process.versions.node === 'string';

export interface InitOptions {
  /**
   * Browser only: where the `swap_core_bg.wasm` of the `web` build is served, or its bytes or a
   * compiled module. Defaults to the file next to this package's `pkg/web/swap_core.js`.
   */
  wasm?: string | URL | BufferSource | WebAssembly.Module | Response | Promise<Response>;
}

/** Load the wasm build that fits the runtime. Idempotent. */
export async function init(options: InitOptions = {}): Promise<void> {
  if (raw) return;
  if (IS_NODE) {
    // A computed specifier keeps bundlers from following the Node build into a browser bundle.
    const nodeBuild = ['..', 'pkg', 'node', 'swap_core.js'].join('/');
    const mod = (await import(/* @vite-ignore */ nodeBuild)) as { default?: Raw } & Raw;
    raw = mod.default ?? mod;
  } else {
    // @ts-ignore -- generated by `pnpm build`; absent on a clean checkout
    const mod = (await import('../pkg/web/swap_core.js')) as { default: (init: { module_or_path: unknown }) => Promise<unknown> } & Raw;
    await mod.default({ module_or_path: options.wasm ?? new URL('../pkg/web/swap_core_bg.wasm', import.meta.url) });
    raw = mod;
  }
}

/** True once `init()` has completed. */
export function isReady(): boolean {
  return raw !== undefined;
}

function core(): Raw {
  if (!raw) throw new CoreError('NotInitialized', '@xmrswap/core-wasm: call `await init()` first');
  return raw;
}

function toCoreError(e: unknown): CoreError {
  if (e instanceof CoreError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const code = /^[A-Za-z]+/.exec(message)?.[0] ?? 'Unknown';
  return new CoreError(code, message);
}
function call<T>(f: (r: Raw) => T): T {
  const r = core();
  try {
    return f(r);
  } catch (e) {
    throw toCoreError(e);
  }
}

const utf8 = (s: string | Bytes): Bytes => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

// ------------------------------------------------------------------ SPEC 2.2

/** Derive every key of one share id from the 32-byte seed. Throws `ScalarZero` if the share is unusable (the id is burned). */
export const deriveKeys = (seed: Bytes, chainTag: ChainTag, shareId: Bytes): DerivedKeys =>
  call((r) => r.deriveKeys(seed, chainTag, shareId));
/** Share id of the per-maker contact key: `SHA256(DS("contact") ‖ maker PDA)[0..16]`. Derive with `CHAIN_TAG.solana`; the key is `enc*`. */
export const contactShareId = (makerPda: Bytes): Bytes => call((r) => r.contactShareId(makerPda));

// ------------------------------------------------------------------ SPEC 2.3 - 2.5

/** `is_valid_key_commitment`: canonical, non-identity, prime-order. */
export const validatePoint = (point: Bytes): boolean => call((r) => r.validatePoint(point));
/** `s` canonical and `s·G == commitment`. */
export const scalarMatches = (s: Bytes, commitment: Bytes): boolean => call((r) => r.scalarMatches(s, commitment));
/** `a + b mod l`: the joint spend key from the two shares. */
export const addScalars = (a: Bytes, b: Bytes): Bytes => call((r) => r.addScalars(a, b));
/** Proof of knowledge of spend share `s` bound to `ctx` (maker PDA or swap PDA). 64 bytes. */
export const pokProve = (s: Bytes, ctx: Bytes): Bytes => call((r) => r.pokProve(s, ctx));
export const pokVerify = (spendPub: Bytes, ctx: Bytes, pok: Bytes): boolean => call((r) => r.pokVerify(spendPub, ctx, pok));
/** The joint address from the two public spend halves and the two private view halves. Never trust an address sent by the other side. */
export const jointAddress = (spendPubA: Bytes, spendPubB: Bytes, viewA: Bytes, viewB: Bytes, network: Network): JointAddress =>
  call((r) => r.jointAddress(spendPubA, spendPubB, viewA, viewB, network));

// ------------------------------------------------------------------ SPEC 2.6, 2.7

export const twinCommitments = (s: Bytes): TwinCommitments => call((r) => r.twinCommitments(s));
/** Prove that the secp256k1 twin and the ed25519 commitment hide the same share. Returns the 56,679-byte `DleqBlob`. */
export const dleqProve = (s: Bytes): Bytes => call((r) => r.dleqProve(s));
/** Verify a `DleqBlob` and return what it proves. Compare `keyAddr`/`keyAddr2` with the on-chain values. Throws on failure. */
export const dleqVerify = (blob: Bytes): DleqStatement => call((r) => r.dleqVerify(blob));
export const keyLeaf = (index: number, keyAddr: Bytes, keyAddr2: Bytes, spendPub: Bytes): Bytes =>
  call((r) => r.keyLeaf(index, keyAddr, keyAddr2, spendPub));
/** Root of a key pool: a power of two, 2 to 256 leaves, in index order. */
export const merkleRoot = (leaves: Bytes[]): Bytes => call((r) => r.merkleRoot(leaves));
/** Sibling hashes, bottom-up, for `MerkleProof.verifyCalldata`. */
export const merkleProof = (leaves: Bytes[], index: number): Bytes[] => call((r) => r.merkleProof(leaves, index));

// ------------------------------------------------------------------ SPEC 2.8

export const x25519Public = (secret: Bytes): Bytes => call((r) => r.x25519Public(secret));
/** True for the fourteen encodings of low-order Curve25519 points. */
export const isLowOrderX25519 = (pub: Bytes): boolean => call((r) => r.isLowOrderX25519(pub));
/** Encrypt a message. A maker's envelope must then go through `envelopeSign`. */
export const envelopeSeal = (args: EnvelopeSealArgs): Bytes => call((r) => r.envelopeSeal(args));
/** Authenticate and decrypt. A maker's envelope needs `makerPub` and `operatorPub`. */
export const envelopeOpen = (args: EnvelopeOpenArgs): { plaintext: Bytes; header: EnvelopeHeader } =>
  call((r) => r.envelopeOpen(args));
/** Parse bytes 0..72 without decrypting (to find the key version and `swap_ref`). */
export const envelopeHeader = (envelope: Bytes): EnvelopeHeader => call((r) => r.envelopeHeader(envelope));
/** Append the maker's operator signature. `operatorSeed` is the 32-byte Ed25519 seed. */
export const envelopeSign = (envelope: Bytes, operatorSeed: Bytes): Bytes => call((r) => r.envelopeSign(envelope, operatorSeed));
export const envelopeVerifySig = (envelope: Bytes, operatorPub: Bytes): boolean =>
  call((r) => r.envelopeVerifySig(envelope, operatorPub));
export const noticeCommitment = (swapRef: Bytes, txid: Bytes, view: Bytes): Bytes =>
  call((r) => r.noticeCommitment(swapRef, txid, view));
/** The 104-byte lock notice ciphertext. */
export const noticeSeal = (args: NoticeSealArgs): Bytes => call((r) => r.noticeSeal(args));
/** Decrypt a lock notice and require it to open `commitment`. Any failure means "no lock". */
export const noticeOpen = (args: NoticeOpenArgs): { txid: Bytes; view: Bytes } => call((r) => r.noticeOpen(args));

// ------------------------------------------------------------------ SPEC 2.9, 4.2, 3.12, 2.10

/** The exact 190 bytes of an advance approval, for the operator's Ed25519 signature. */
export const encodeSolApproval = (fields: SolApprovalFields): Bytes => call((r) => r.encodeSolApproval(fields));
export const termsHash = (fields: TermsHashFields): Bytes => call((r) => r.termsHash(fields));
export const openHashSolana = (fields: OpenHashSolanaFields): Bytes => call((r) => r.openHashSolana(fields));
export const openHashEthereum = (fields: OpenHashEthereumFields): Bytes => call((r) => r.openHashEthereum(fields));
/** `swapId = keccak256(abi.encode(taker, bytes16 swapNonce))`. */
export const ethSwapId = (taker: Bytes, swapNonce: Bytes): Bytes => call((r) => r.ethSwapId(taker, swapNonce));
/** The compact board form: 251 bytes, or 316 with the 65-byte signature appended. */
export const encodeEthQuoteCompact = (quote: EthQuote, sig?: Bytes): Bytes => call((r) => r.encodeEthQuoteCompact(quote, sig));
export const decodeEthQuoteCompact = (bytes: Bytes): { quote: EthQuote; sig?: Bytes } =>
  call((r) => r.decodeEthQuoteCompact(bytes));
/** The EIP-712 digest the operator signs; equals the contract's `hashQuote`. */
export const quoteDigest = (domain: Eip712Domain, quote: EthQuote): Bytes => call((r) => r.quoteDigest(domain, quote));
export const approvalDigest = (domain: Eip712Domain, approval: EthApproval): Bytes =>
  call((r) => r.approvalDigest(domain, approval));

// ------------------------------------------------------------------ SPEC 3 arithmetic

/** Direction A: `ceil(xmr × price / 10^12)`. With `chain`, throws `MathOverflow` above that chain's amount type. */
export const payAmount = (xmr: bigint, price: bigint, chain?: ChainName): bigint => call((r) => r.payAmount(xmr, price, chain));
/** Direction B: `floor(xmr × price / 10^12)`. */
export const receiveAmount = (xmr: bigint, price: bigint, chain?: ChainName): bigint =>
  call((r) => r.receiveAmount(xmr, price, chain));
/** `floor(amount × bps / 10^4)`. */
export const depositOf = (amount: bigint, bps: number): bigint => call((r) => r.depositOf(amount, bps));
/** `floor(amount × bps / 10^4)`, taken only on a claim. */
export const feeOf = (amount: bigint, bps: number): bigint => call((r) => r.feeOf(amount, bps));
/** The 60-day split: `ceil(D/2)` to the taker, `floor(D/2)` to the treasury. */
export const splitOf = (deposit: bigint): { toTaker: bigint; toTreasury: bigint } => call((r) => r.splitOf(deposit));
/** Bound check and every deadline of SPEC 3.2 that the given event times determine. */
export const deadlines = (params: DeadlineParams): Deadlines => call((r) => r.deadlines(params));

// ------------------------------------------------------------------ SPEC 2.11, 2.12

/** Sweep exactly the verified lock output of the joint address. Uses the global `fetch`. */
export async function sweepJoint(params: SweepParams): Promise<SweepOutcome> {
  const r = core();
  try {
    return await r.sweepJoint(params);
  } catch (e) {
    throw toCoreError(e);
  }
}
/** scrypt (N = 2^17, r = 8, p = 1) + XChaCha20-Poly1305: `0x01 ‖ salt[16] ‖ nonce[24] ‖ ciphertext`. Takes about a second. */
export const passphraseSeal = (passphrase: string | Bytes, plaintext: Bytes): Bytes =>
  call((r) => r.passphraseSeal(utf8(passphrase), plaintext));
export const passphraseOpen = (passphrase: string | Bytes, sealed: Bytes): Bytes =>
  call((r) => r.passphraseOpen(utf8(passphrase), sealed));

/** Version of the Rust crate inside the wasm. */
export const coreVersion = (): string => call((r) => r.coreVersion());
