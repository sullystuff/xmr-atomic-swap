/** A base58 address, or anything with `toBase58()` such as a web3.js `PublicKey`. */
export type Address = string | { toBase58(): string };
/** Atomic units. Sent as a decimal string; never a float. */
export type Amount = bigint | number | string;

export interface ClockState {
  slot: number;
  blockHeight: number;
  unixTimestamp: number;
}

export interface SetAccountInput {
  lamports: Amount;
  /** Defaults to the system program. */
  owner?: Address;
  data?: Uint8Array;
  executable?: boolean;
}

/** Solana cluster genesis hashes. svm-rpc reports none of these. */
export declare const REAL_GENESIS_HASHES: Readonly<Record<'mainnet-beta' | 'devnet' | 'testnet', string>>;

export declare class SvmRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
}

/** The `svm_*` control methods of docs/SPEC.md 9.2. Refuses any URL that is not loopback http. */
export declare class SvmRpcClient {
  constructor(url: string);
  readonly url: string;
  /** One JSON-RPC call; throws `SvmRpcError` on an error response. */
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Loads a built `.so` at `programId` under the upgradeable loader, with no upgrade authority. */
  addProgram(programId: Address, soPath: string): Promise<{ programId: string; programData: string }>;
  /** Writes the upgrade authority into the ProgramData account; `null` clears it. */
  setUpgradeAuthority(programId: Address, authority: Address | null): Promise<void>;
  /** Adds lamports in-process (no transaction). Returns the new balance. */
  airdrop(pubkey: Address, lamports: Amount): Promise<bigint>;
  /** Moves `unix_timestamp` by `seconds` and the slot by 2.5 per second, and expires every blockhash. */
  warp(seconds: Amount): Promise<ClockState>;
  /** Sets `unix_timestamp`; takes one slot; blockhashes stay valid. */
  setClock(unixTimestamp: Amount): Promise<ClockState>;
  /** Creates an SPL Token mint with `authority` as mint and freeze authority. Returns its address. */
  createMint(decimals: number, authority: Address, mint?: Address): Promise<string>;
  /** Credits the owner's associated token account, creating it if missing. Returns its address. */
  mintTo(mint: Address, owner: Address, amount: Amount): Promise<string>;
  setTokenAccountFrozen(tokenAccount: Address, frozen: boolean): Promise<void>;
  /** Overwrites an account; `null` deletes it. */
  setAccount(pubkey: Address, account: SetAccountInput | null): Promise<void>;
  /** Creates an active address lookup table usable at once. Returns its address. */
  createLookupTable(addresses: Address[], authority?: Address): Promise<string>;
}

export interface SignatureStatusLike {
  slot: number;
  err: unknown;
  confirmationStatus?: string | undefined;
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Waits until `signature` has landed, by polling `getSignatureStatuses`. svm-rpc has no
 * WebSocket, so web3.js `confirmTransaction` / `sendAndConfirmTransaction` cannot be used.
 * Resolves with the status (check `err`); rejects after `timeoutMs` if it never lands.
 */
export declare function confirmSignature<S extends SignatureStatusLike>(
  connection: { getSignatureStatuses(signatures: string[]): Promise<{ value: (S | null)[] }> },
  signature: string,
  options?: PollOptions,
): Promise<S>;

/**
 * Sends a fully signed transaction (legacy or versioned) and waits for it by polling.
 * Throws if the transaction landed with an error. Returns the signature.
 */
export declare function sendAndConfirm<O extends object = object>(
  connection: {
    sendRawTransaction(raw: Uint8Array | Buffer | number[], options?: O): Promise<string>;
    getSignatureStatuses(signatures: string[]): Promise<{ value: (SignatureStatusLike | null)[] }>;
  },
  transaction: { serialize(): Uint8Array | Buffer },
  options?: O & PollOptions,
): Promise<string>;
