#!/usr/bin/env node
// Assemble the release artifact for the web UI: a copy of the built UI, a release.json naming
// what the build pins, and SHA256SUMS over both.
//   node scripts/release.mjs [output directory]     (default: deploy/release)
// The output directory is replaced. Nothing is uploaded or published.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_ADDRESS, CONTRACT_CHAIN_ID, PROGRAM_ID } from '@xmrswap/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = path.resolve(here, '..');
const ui = process.env.XMRSWAP_UI_DIST ? path.resolve(deploy, process.env.XMRSWAP_UI_DIST) : path.resolve(deploy, '../apps/web/dist');
const out = path.resolve(process.argv[2] ?? path.join(deploy, 'release'));

if (!existsSync(path.join(ui, 'index.html'))) {
  console.error(`release: no built web UI in ${ui}`);
  process.exit(1);
}
if (existsSync(out) && !existsSync(path.join(out, 'release.json')) && !existsSync(path.join(out, 'SHA256SUMS'))) {
  // Refuse to replace a directory that does not look like an earlier release.
  if (readdirSync(out).length > 0) {
    console.error(`release: ${out} exists and is not an earlier release; choose another directory`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(ui, path.join(out, 'web'), { recursive: true });
const version = JSON.parse(readFileSync(path.resolve(deploy, '../apps/web/package.json'), 'utf8')).version;
writeFileSync(
  path.join(out, 'release.json'),
  `${JSON.stringify({ name: 'xmrswap-web', version, programId: PROGRAM_ID, contract: CONTRACT_ADDRESS, chainId: CONTRACT_CHAIN_ID }, null, 2)}\n`,
);
execFileSync(process.execPath, [path.join(here, 'checksums.mjs'), out], { stdio: 'inherit' });
