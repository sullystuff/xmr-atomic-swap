import { defineConfig } from 'vitest/config';

// Unit tests: fakes only (SPEC 9.1). Nothing here opens a socket beyond loopback HTTP to the
// daemon's own API server.
export default defineConfig({
  test: { include: ['test/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
