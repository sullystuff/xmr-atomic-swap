import { defineConfig } from 'vitest/config';

// The acceptance command (SPEC 11.9, A5). Unit tests on the SDK fakes, plus `chains.test.ts`:
// the real program in svm-rpc and the real contract on a local anvil (own free loopback ports,
// in-memory Monero nodes). Real XMR on the Monero regtest is `test:integration`.
export default defineConfig({ test: { include: ['test/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } });
