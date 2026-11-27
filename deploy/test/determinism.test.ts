/**
 * The build is repeatable on this machine (SPEC 11.9, A9): the commit at HEAD is exported and
 * built twice from clean, in two different directories (the wasm core also with the cargo home
 * at a different path), and the release step itself refuses unless the program, the taker UI
 * and the console come out identical. Then the installed `solana-verify` is asked for the
 * program's executable hash, which must be the recorded local hash.
 *
 * Offline: pnpm and cargo are told to fail rather than download. No Docker here (the Docker
 * build is `deploy/scripts/program-docker-build.sh`), no cluster, no wallet.
 * This takes a few minutes: it compiles the wasm core and the program twice.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, solanaVerifyBin } from '../src/release/build.js';
import { readRecord } from '../src/release/manifest.js';
import { fetchProgramHash } from '../src/release/onchain.js';
import { closeAll, startFakeSolana } from './fakes.js';
import { tmp } from './tmp.js';

afterEach(closeAll);

const deployDir = fileURLToPath(new URL('..', import.meta.url));

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: deployDir, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}
const cli = (args: string[], env: Record<string, string> = {}) => run(process.execPath, ['--import', 'tsx', path.join(deployDir, 'src/release/cli.ts'), ...args], { ...(process.env['CARGO_HOME'] ? { CARGO_HOME: process.env['CARGO_HOME'] } : {}), ...(process.env['RUSTUP_HOME'] ? { RUSTUP_HOME: process.env['RUSTUP_HOME'] } : {}), ...env });

describe('a release built twice on this machine', () => {
  it('has equal tree hashes and an equal program, and solana-verify agrees with the recorded local hash', async () => {
    const out = path.join(tmp(), 'release');
    const r = await cli(['release', '--offline', '--out', out]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toContain('build 2 (different directory; the wasm core also with the cargo home at a different path):');
    expect(r.out).toContain('The two builds are identical.');
    expect(r.out).toContain('double build       identical in two directories');

    const { manifest } = readRecord(out);
    expect(manifest.web.double_build).toBe('identical');
    expect(manifest.console.double_build).toBe('identical');
    expect(manifest.program_builds).toHaveLength(1);
    const local = manifest.program_builds[0]!;
    expect(local).toMatchObject({ method: 'local-sbf', double_build: 'identical' });
    // A local build is never presented as the Docker one.
    expect(manifest.program_hash_source).toBe('local');
    expect(manifest.status).toBe('development-snapshot');

    // Nothing of the build directories is left in the artefacts.
    for (const f of ['web', 'console']) {
      for (const e of readFileSync(path.join(out, `${f}.SHA256SUMS`), 'utf8').trim().split('\n')) {
        const bytes = readFileSync(path.join(out, f, e.slice(66)));
        expect(bytes.includes('xmrswap-release-'), `${f}/${e.slice(66)} names the build directory`).toBe(false);
        expect(bytes.includes(process.env['HOME'] ?? '/nonexistent-home'), `${f}/${e.slice(66)} names the home directory`).toBe(false);
      }
    }

    // solana-verify itself, on the built program.
    const sv = solanaVerifyBin(deployDir);
    const so = path.join(out, 'program/xmr_swap.so');
    const tool = await run(sv, ['get-executable-hash', so]).catch(() => null);
    if (tool === null) throw new Error(`solana-verify is not installed. Install the pinned version: ${COMMANDS.solanaVerifyInstall}`);
    expect(tool.code, tool.err).toBe(0);
    expect(tool.out.trim().split('\n').at(-1)).toBe(local.executable_hash);
    expect(r.out).toContain('solana-verify get-executable-hash prints the same value');

    // The release directory verifies against its own record, and a rebuild of one artefact matches it again.
    const v = await cli(['verify', out]);
    expect(v.code, v.out + v.err).toBe(0);
    expect(v.out).toContain('3 matched, 1 not compared, against files on disk (nothing was rebuilt).');
    const again = await cli(['verify', out, '--rebuild', '--only', 'console', '--offline']);
    expect(again.code, again.out + again.err).toBe(0);
    expect(again.out).toMatch(new RegExp(`MATCH        console  tree hash ${manifest.console_tree_hash}`));
    expect(again.out).toContain('1 matched, 1 not compared, against a rebuild from commit');

    // The same program "deployed" on a fake cluster (loopback): this tool and solana-verify read the same hash from it.
    const rpc = await startFakeSolana();
    rpc.deploy(PROGRAM_ID, readFileSync(so), null, 64 * 1024);
    const mine = await fetchProgramHash(rpc.url, PROGRAM_ID);
    expect(mine).toMatchObject({ found: true, executable_hash: local.executable_hash });
    // An empty home: the tool must not pick up the Solana CLI's configured cluster or wallet.
    const theirs = await run(sv, ['get-program-hash', '-u', rpc.url, PROGRAM_ID], { HOME: tmp() });
    expect(theirs.code, theirs.err).toBe(0);
    expect(theirs.out.trim().split('\n').at(-1)).toBe(local.executable_hash);
    const onchain = await cli(['verify', out, '--onchain', '--only', 'program'], { SOLANA_RPC_URL: rpc.url });
    expect(onchain.out).toContain(`MATCH        on-chain program ${PROGRAM_ID} has executable hash ${local.executable_hash}, the record's local-sbf build`);
    expect(existsSync(path.join(out, 'release.json'))).toBe(true);
  }, 900_000);
});
