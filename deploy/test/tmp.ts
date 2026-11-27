/** Temporary directories for the tests: all under one root per test process, removed when it exits. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'xmrswap-deploy-test-'));
// Registered once per test file that imports this module.
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A new empty directory. */
export function tmp(): string {
  return mkdtempSync(path.join(root, 't-'));
}
