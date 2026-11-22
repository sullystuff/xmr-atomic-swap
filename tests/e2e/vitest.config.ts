import { defineConfig } from 'vitest/config';

// End-to-end scenarios: one file at a time (they share the Monero regtest and its ports), each in
// its own process. `scripts/run.mjs` wraps this in the shared integration lock.
export default defineConfig({
  test: {
    include: ['scenarios/**/*.test.ts'],
    globalSetup: ['src/global-setup.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 900_000,
    teardownTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    sequence: { concurrent: false },
    retry: 0,
  },
});
