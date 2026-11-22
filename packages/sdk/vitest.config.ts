import { defineConfig } from 'vitest/config';

// Unit tests: fakes and recorded vectors only. Nothing here opens a socket.
export default defineConfig({
  test: { include: ['test/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
