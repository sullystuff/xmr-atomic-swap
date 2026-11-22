/**
 * `@xmrswap/sdk`: chain clients, Monero verification, taker and maker flows, message
 * transports, signing, the registry reader and the router (SPEC 10.2, WP5).
 *
 * Call `await init()` (re-exported from `@xmrswap/core-wasm`) once before anything that touches
 * keys, proofs, envelopes or amounts. Nothing in this package reads `solana config`, a CLI
 * wallet or a default endpoint: every endpoint and key is passed in by the caller.
 */
export { init, isReady } from '@xmrswap/core-wasm';

export * from './util.js';

// The state machine and the chain-neutral swap view.
export * as machine from './machine/model.js';
export type { Call, CallName, Effects, Env, MakerRecord, ModelErrorName, ModelSwap, OpenArgs, Party, Payout, Role, SwapParams } from './machine/model.js';
export { ModelError, NO_SWAP, apply, enabled, errorOf, isSecretBearing, pendingKind } from './machine/model.js';
export * from './machine/view.js';

// Flows.
export type { Decision, FlowCall, LockReport, Need, OffchainAction, Warning } from './flows/types.js';
export * from './flows/taker.js';
export * from './flows/maker.js';
export * from './flows/keys.js';

// Solana.
export * from './solana/pdas.js';
export * from './solana/instructions.js';
export * from './solana/tx.js';
export * from './solana/transport.js';
export * from './solana/client.js';

// Ethereum.
export * from './ethereum/client.js';

// Monero.
export * as moneroTx from './monero/tx.js';
export { formatXmr, parseTx, computeTxid, scanTx } from './monero/tx.js';
export * from './monero/rpc.js';
export * from './monero/verify.js';
export * from './monero/watch.js';

// Messages.
export * from './messages/envelope.js';
export * from './messages/transports.js';
export * from './messages/blobs.js';

// Signed objects.
export * from './signing/solana.js';
export * from './signing/eip712.js';

// Registry, reputation, pricing.
export * from './registry/pricing.js';
export * from './registry/reputation.js';
export * from './registry/reader.js';

// Router and recovery file.
export * from './router/plan.js';
export * from './recovery/file.js';
