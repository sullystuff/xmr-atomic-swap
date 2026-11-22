import { defineConfig } from 'vitest/config';

// Integration tests (milestone M2): svm-rpc, anvil and the Monero regtest, all on loopback.
// One file at a time: they share the regtest chain and its wallet.
export default defineConfig({
  test: {
    include: ['test/integration/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
