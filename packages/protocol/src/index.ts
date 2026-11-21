/**
 * `@xmrswap/protocol`: the frozen TypeScript side of the interfaces (SPEC 1.1).
 *
 * - `constants`: every protocol constant of SPEC 3.1 per chain, states, counters, flags, sizes.
 * - `solana`: account, event and instruction codecs generated from the frozen IDL.
 * - `ethereum`: the frozen ABI and the EIP-712 type definitions.
 * - `messages`: off-chain message types, the maker endpoint and the relay.
 * - `recovery`: the recovery file.
 * - `daemon-api` (also at `@xmrswap/protocol/daemon-api`): the daemon's local API.
 *
 * Cryptography is not here: it lives in `@xmrswap/core-wasm`.
 */
export * from './constants.js';
export * as borsh from './borsh.js';
export { base58Decode, base58Encode, BorshError, fromHex, toHex } from './borsh.js';
export * from './solana.js';
export * from './ethereum.js';
export * from './messages.js';
export * from './recovery.js';
export * as daemonApi from './daemon-api.js';
