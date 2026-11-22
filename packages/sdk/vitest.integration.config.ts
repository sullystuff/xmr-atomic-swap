import { defineConfig } from 'vitest/config';

// Integration tests (milestone M2): svm-rpc, anvil and the Monero regtest, all on loopback.
export default defineConfig({
  test: { include: ['test/integration/*.test.ts'], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false },
});
