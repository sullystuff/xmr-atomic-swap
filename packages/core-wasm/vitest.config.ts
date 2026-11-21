import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // scrypt at N = 2^17 and the cross-curve proof take a while in wasm.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
