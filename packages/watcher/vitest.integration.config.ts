import { defineConfig } from 'vitest/config';

// Integration: the real service against svm-rpc + the built program, anvil + the contract, and
// real XMR on the Monero regtest. Loopback only. The `test:integration` script takes
// `flock /tmp/xmrswap-integration.lock` itself, once: other packages share the regtest's ports.
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
