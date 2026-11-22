/**
 * In-memory fakes for the SDK's seams, exported at `@xmrswap/sdk/testing` so the daemon, the
 * relay and the UIs can test against the same ones. None of them opens a socket.
 */
export * from './solana.js';
export * from './ethereum.js';
export * from './monero.js';
export * from './maker.js';
