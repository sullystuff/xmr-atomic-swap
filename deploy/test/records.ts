/** A record in a releases directory for a given UI directory, with a stand-in console and program (tests only). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleRelease } from '../src/release/assemble.js';
import type { Manifest } from '../src/release/manifest.js';
import { tmp } from './tmp.js';

export async function recordFor(webDir: string, version = 'dev-snapshot'): Promise<{ releases: string; manifest: Manifest }> {
  const scratch = tmp();
  const consoleDir = path.join(scratch, 'console');
  mkdirSync(consoleDir);
  writeFileSync(path.join(consoleDir, 'index.html'), '<!doctype html><div id="console"></div>');
  const so = path.join(scratch, 'xmr_swap.so');
  writeFileSync(so, Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(200, 9)]));
  const releases = path.join(scratch, 'releases');
  const { manifest } = await assembleRelease({
    out: path.join(releases, version),
    web: webDir,
    console: consoleDir,
    program: { file: so, method: 'local-sbf' },
    doubleBuild: 'not-run',
    lockfile: 'prebuilt',
    version,
    status: 'development-snapshot',
    commit: 'cd'.repeat(20),
    commitTime: '2026-11-27T10:00:00Z',
    tools: { node: process.version },
  });
  return { releases, manifest };
}
