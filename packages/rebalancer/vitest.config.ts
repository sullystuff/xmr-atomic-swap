import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// SPEC 7.7 / 10.1: the bridge IDL is supplied by the project owner. Until it is, the conformance
// suite in test/bridge-idl.test.ts is skipped, and the run says so in plain words at the end.
const idlPath = process.env['WXMR_BRIDGE_IDL'] || fileURLToPath(new URL('./vendor/wxmr_bridge.json', import.meta.url));
const notice = () => {
  if (existsSync(idlPath)) return;
  console.log(
    '\n SKIPPED  wXMR bridge IDL conformance (test/bridge-idl.test.ts): packages/rebalancer/vendor/wxmr_bridge.json has not been supplied by the owner.\n' +
    '          The bridge instruction encodings and account layouts are tested against BRIDGE-ASSUMPTIONS.md only, not against the real IDL.\n',
  );
};
let printed = false;
const once = () => { if (!printed) { printed = true; notice(); } };

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    reporters: ['default', { onTestRunEnd: once, onFinished: once }],
  },
});
