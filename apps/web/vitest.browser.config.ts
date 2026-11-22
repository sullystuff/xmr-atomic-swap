import { defineConfig } from 'vitest/config';

// Browser tests: the built UI in Chromium against svm-rpc (the built Solana program in an
// in-memory LiteSVM) and the Monero regtest, all on loopback. One file at a time: they share the
// regtest chain and its wallet. The package script wraps this in `flock /tmp/xmrswap-integration.lock`.
export default defineConfig({
  test: {
    include: ['browser/*.test.ts'],
    globalSetup: ['browser/global-setup.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
