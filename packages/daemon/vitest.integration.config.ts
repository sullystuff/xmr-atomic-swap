import { defineConfig } from 'vitest/config';

// Integration: the real daemon against svm-rpc + the built program, anvil + the contract, and
// the Monero regtest. Loopback only. Always run under `flock /tmp/xmrswap-integration.lock`
// (the `test:integration` script does): other packages share the same ports.
export default defineConfig({
  test: {
    include: ['test/integration/*.test.ts'],
    globalSetup: ['../sdk/test/integration/global-setup.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
