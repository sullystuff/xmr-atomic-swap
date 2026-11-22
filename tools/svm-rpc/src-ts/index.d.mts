import type { Address, Amount } from './client.mjs';
import { SvmRpcClient } from './client.mjs';

export * from './client.mjs';

/** The crate directory (`tools/svm-rpc`). */
export declare const crateDir: string;
/** `$SVM_RPC_BIN`, else the crate's dev build (`target/debug/svm-rpc`). */
export declare function binaryPath(): string;
/** Builds the binary with `cargo build --locked` in the crate's own workspace. */
export declare function buildBinary(): void;

export interface StartOptions {
  /** Port on 127.0.0.1. Default 0: a free port. */
  port?: number;
  /** Built programs to load before serving. */
  programs?: { programId: Address; soPath: string }[];
  /** Starting `Clock.unix_timestamp`. Default 1,795,000,000. */
  unixTimestamp?: Amount;
  /** Build the binary when it is missing. Default true. */
  build?: boolean;
}

/** A running svm-rpc process and its control client. */
export declare class SvmRpc extends SvmRpcClient {
  private constructor();
  readonly port: number;
  /** Stops the process; all state is gone. */
  stop(): Promise<void>;
}

/**
 * Starts one svm-rpc on 127.0.0.1 and resolves once it serves. The process exits when this
 * process does. There is no option to bind another address.
 */
export declare function startSvmRpc(options?: StartOptions): Promise<SvmRpc>;
