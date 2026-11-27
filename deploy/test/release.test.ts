/**
 * The checkable build (SPEC 11.5): tree hashes, offline IPFS CIDs, the executable hash, the
 * record format, tamper detection per artefact, and the on-chain comparison against a fake RPC.
 * Nothing here builds from source (that is `determinism.test.ts`), deploys or leaves loopback.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID, base58Encode } from '@xmrswap/protocol';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { executableHash, listingText, treeEntries, treeHash } from '../scripts/sums.mjs';
import { addProgramBuild, assembleRelease } from '../src/release/assemble.js';
import { CID_PARAMS, treeCid } from '../src/release/cid.js';
import { type Manifest, ManifestError, checkManifest, checkRecord, readRecord, servedRelease } from '../src/release/manifest.js';
import { fetchProgramHash } from '../src/release/onchain.js';
import { describeServed, startBundle } from '../src/server.js';
import { loadSettings } from '../src/settings.js';
import { call, closeAll, onClose, startFakeSolana } from './fakes.js';
import { tmp } from './tmp.js';

afterEach(closeAll);

const deployDir = fileURLToPath(new URL('..', import.meta.url));
const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** A file tree written in the given order. */
function tree(files: [string, string | Uint8Array][], dir = tmp()): string {
  for (const [name, content] of files) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const BIG = Buffer.alloc(600_000, 7).map((_, i) => (i * 131 + 17) & 255);
const WEB: [string, string | Uint8Array][] = [
  ['index.html', '<!doctype html><div id="root"></div><script src="./assets/app.js"></script>'],
  ['assets/app.js', `export const program = "${PROGRAM_ID}";`],
  ['assets/core.wasm', BIG],
  ['favicon.svg', '<svg/>'],
];
const CONSOLE: [string, string][] = [
  ['index.html', '<!doctype html><div id="console"></div>'],
  ['assets/console.js', 'console.log("console")'],
];
/** Something shaped like a program binary: an ELF magic, content, and trailing zero padding. */
function elf(seed: number, padding = 2000): Buffer {
  const b = Buffer.alloc(3000 + padding);
  b.write('\x7fELF', 'latin1');
  for (let i = 4; i < 3000; i++) b[i] = (i * 31 + seed) & 255;
  b[2999] = 0x5a;
  return b;
}
function program(seed = 7, padding = 2000): string {
  const file = path.join(tmp(), 'xmr_swap.so');
  writeFileSync(file, elf(seed, padding));
  return file;
}

const COMMIT = 'ab'.repeat(20);
async function release(over: Partial<Parameters<typeof assembleRelease>[0]> = {}) {
  const out = path.join(tmp(), 'release');
  const r = await assembleRelease({
    out,
    web: tree(WEB),
    console: tree(CONSOLE),
    program: { file: program(), method: 'local-sbf' },
    doubleBuild: 'not-run',
    lockfile: 'prebuilt',
    version: 'dev-snapshot',
    status: 'development-snapshot',
    commit: COMMIT,
    commitTime: '2026-11-27T10:00:00Z',
    tools: { node: process.version },
    ...over,
  });
  return { out, ...r };
}

/** The release CLI as a separate process (not blocking this one, which plays the RPC). */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(deployDir, 'src/release/cli.ts'), ...args], { cwd: deployDir, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

describe('tree hash', () => {
  it('does not depend on the order files were written in, their timestamps or their permissions', async () => {
    const a = tree(WEB);
    const b = tree([...WEB].reverse());
    utimesSync(path.join(b, 'index.html'), new Date(0), new Date(86_400_000));
    utimesSync(path.join(b, 'assets'), new Date(1), new Date(2));
    chmodSync(path.join(b, 'assets/app.js'), 0o755);
    // Written elsewhere first and moved in: a different inode order in the directory.
    renameSync(path.join(b, 'favicon.svg'), path.join(b, 'zz'));
    renameSync(path.join(b, 'zz'), path.join(b, 'favicon.svg'));
    const [ea, eb] = [await treeEntries(a), await treeEntries(b)];
    expect(eb).toEqual(ea);
    expect(treeHash(eb)).toBe(treeHash(ea));
    expect(await treeCid(b, eb.map((e) => e.path).reverse())).toBe(await treeCid(a, ea.map((e) => e.path)));
  });

  it('is the SHA-256 of the sorted sha256sum listing, and coreutils gives the same value', async () => {
    const dir = tree(WEB);
    const entries = await treeEntries(dir);
    expect(entries.map((e) => e.path)).toEqual(['assets/app.js', 'assets/core.wasm', 'favicon.svg', 'index.html']);
    const listing = entries.map((e) => `${sha(readFileSync(path.join(dir, e.path)))}  ${e.path}\n`).join('');
    expect(listingText(entries)).toBe(listing);
    expect(treeHash(entries)).toBe(sha(listing));
    // The command the docs give for checking a tree hash without this repository.
    const shell = spawnSync('bash', ['-c', "find . -type f -printf '%P\\n' | LC_ALL=C sort | xargs -d '\\n' sha256sum | sha256sum"], { cwd: dir, encoding: 'utf8' });
    expect(shell.stdout.split(' ')[0]).toBe(treeHash(entries));
  });

  it('changes when a byte, a name or the set of files changes', async () => {
    const base = treeHash(await treeEntries(tree(WEB)));
    const flipped = Buffer.from(BIG);
    flipped[300_000]! ^= 1;
    const variants: [string, string | Uint8Array][][] = [
      WEB.map(([n, c]) => (n === 'assets/core.wasm' ? [n, flipped] : [n, c])),
      WEB.map(([n, c]) => (n === 'favicon.svg' ? ['favicon2.svg', c] : [n, c])),
      [...WEB, ['assets/extra.js', '']],
      WEB.slice(1),
      WEB.map(([n, c]) => (n === 'index.html' ? [n, `${String(c)}\n`] : [n, c])),
    ];
    const hashes = new Set([base]);
    for (const v of variants) hashes.add(treeHash(await treeEntries(tree(v))));
    expect(hashes.size).toBe(variants.length + 1);
  });
});

describe('IPFS CID, computed offline', () => {
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  /** Multibase base32 (lower case, no padding) with the `b` prefix, written out here independently of the library. */
  const base32 = (bytes: Uint8Array): string => {
    let bits = 0;
    let value = 0;
    let out = 'b';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += B32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
  };
  const cidV1 = (codec: number, block: Uint8Array): Buffer => Buffer.concat([Buffer.from([0x01, codec, 0x12, 0x20]), createHash('sha256').update(block).digest()]);

  it('gives the well-known CID of the empty directory', async () => {
    expect(await treeCid(tmp(), [])).toBe('bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354');
  });

  it('equals a directory block built by hand for a one-file tree', async () => {
    const content = Buffer.from('hello world\n');
    const dir = tree([['hello.txt', content]]);
    // The file is one raw leaf; the directory is a dag-pb node with one link and UnixFS data "Directory".
    const leaf = cidV1(0x55, content);
    const name = Buffer.from('hello.txt');
    const link = Buffer.concat([Buffer.from([0x0a, leaf.length]), leaf, Buffer.from([0x12, name.length]), name, Buffer.from([0x18, content.length])]);
    const node = Buffer.concat([Buffer.from([0x12, link.length]), link, Buffer.from([0x0a, 0x02, 0x08, 0x01])]);
    expect(await treeCid(dir, ['hello.txt'])).toBe(base32(cidV1(0x70, node)));
    // The leaf's CID is the raw codec over the SHA-256 of the content.
    expect(leaf.subarray(4).toString('hex')).toBe(sha(content));
    expect(base32(leaf)).toMatch(/^bafkrei[a-z2-7]{52}$/);
  });

  it('covers multi-chunk files and changes with any byte', async () => {
    const a = await treeCid(tree(WEB), WEB.map(([n]) => n));
    expect(a).toMatch(/^bafybei[a-z2-7]{52}$/);
    const flipped = Buffer.from(BIG);
    flipped[599_999]! ^= 1;
    const changed = WEB.map(([n, c]): [string, string | Uint8Array] => (n === 'assets/core.wasm' ? [n, flipped] : [n, c]));
    expect(await treeCid(tree(changed), changed.map(([n]) => n))).not.toBe(a);
    expect(CID_PARAMS).toContain('cidv1');
    expect(CID_PARAMS).toContain('chunker=size-262144');
  });
});

describe('program executable hash', () => {
  it('ignores trailing zero padding and nothing else', () => {
    const base = executableHash(elf(7, 0));
    expect(executableHash(elf(7, 2000))).toBe(base);
    expect(executableHash(elf(7, 1_000_000))).toBe(base);
    expect(executableHash(elf(8, 2000))).not.toBe(base);
    const inner = elf(7, 0);
    inner[100] = 0;
    expect(executableHash(inner)).not.toBe(base);
    expect(base).toBe(sha(elf(7, 0)));
  });

  it('is the value solana-verify get-executable-hash printed for the same bytes', () => {
    // Recorded from `solana-verify get-executable-hash` 0.2.11 and 0.4.11 on a file with exactly
    // these bytes. determinism.test.ts asks the installed tool again for the real program.
    expect(executableHash(elf(7, 2000))).toBe('7662d6026e60f13b86386e7c4f5121498f5f7c97960a2a6e7b792351da21195c');
  });
});

describe('release record', () => {
  it('a release directory holds the artefacts, the record and a list of everything', async () => {
    const r = await release();
    const all = (await treeEntries(r.out)).map((e) => e.path);
    expect(all).toEqual(['console.SHA256SUMS', 'console/assets/console.js', 'console/index.html', 'program/xmr_swap.so', 'release.json', 'web.SHA256SUMS', 'web/assets/app.js', 'web/assets/core.wasm', 'web/favicon.svg', 'web/index.html']);
    expect(readFileSync(path.join(r.out, 'SHA256SUMS'), 'utf8')).toBe(listingText(await treeEntries(r.out)));
    const m = r.manifest;
    // SPEC 11.5: the tree hash is the SHA-256 of the tree's SHA256SUMS file.
    expect(m.web_tree_hash).toBe(sha(readFileSync(path.join(r.out, 'web.SHA256SUMS'))));
    expect(m.console_tree_hash).toBe(sha(readFileSync(path.join(r.out, 'console.SHA256SUMS'))));
    expect(m.web_tree_hash).toBe(treeHash(await treeEntries(path.join(r.out, 'web'))));
    expect(m).toMatchObject({ format: 'xmrswap-release/1', version: 'dev-snapshot', status: 'development-snapshot', commit: COMMIT, program_id: PROGRAM_ID, program_hash_source: 'local', onchain: { deployed: false } });
    expect(m.program_builds).toEqual([expect.objectContaining({ method: 'local-sbf', executable_hash: executableHash(elf(7)), sha256: sha(elf(7)), size: 5000, double_build: 'not-run' })]);
    expect(m.program_executable_hash).toBe(executableHash(elf(7)));
    expect(readRecord(r.out).manifest).toEqual(m);
    expect(readRecord(path.join(r.out, 'release.json')).manifest).toEqual(m);
  });

  it('validates against the bundled schema, and the schema refuses malformed records', async () => {
    const { manifest } = await release();
    const schema = JSON.parse(readFileSync(path.join(deployDir, 'release.schema.json'), 'utf8')) as object;
    const validate = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    const bad: [string, (m: any) => void][] = [
      ['a short commit', (m) => void (m.commit = 'abc123')],
      ['an unknown key', (m) => void (m.signed_by = 'nobody')],
      ['an unknown status', (m) => void (m.status = 'final')],
      ['an unknown build method', (m) => void (m.program_builds[0].method = 'somewhere')],
      ['an unknown hash source', (m) => void (m.program_hash_source = 'ci')],
      ['a missing tree hash', (m) => void delete m.web_tree_hash],
      ['a truncated hash', (m) => void (m.console_tree_hash = m.console_tree_hash.slice(1))],
      ['a CID that is not CIDv1 base32', (m) => void (m.web_cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')],
      ['no program build', (m) => void (m.program_builds = [])],
      ['a wrong format tag', (m) => void (m.format = 'xmrswap-release/2')],
      ['a bad program id', (m) => void (m.program_id = '0x1234')],
    ];
    for (const [what, change] of bad) {
      const m = structuredClone(manifest) as Manifest;
      change(m);
      expect(validate(m), what).toBe(false);
      expect(() => checkManifest(m), what).toThrow(ManifestError);
    }
  });

  it('refuses records that contradict themselves', async () => {
    const { manifest, texts } = await release();
    const change = (f: (m: Manifest) => void): Manifest => {
      const m = structuredClone(manifest);
      f(m);
      return m;
    };
    // The headline hash must be the hash of a recorded build, from the source it names.
    expect(() => checkManifest(change((m) => void (m.program_executable_hash = 'f'.repeat(64))))).toThrow(/must be the local build's/);
    expect(() => checkManifest(change((m) => void (m.program_hash_source = 'docker')))).toThrow(/must be the local build's/);
    expect(() => checkManifest(change((m) => void m.program_builds.push({ ...m.program_builds[0]! })))).toThrow(/listed twice/);
    // A release cannot be named like a snapshot, and cannot rest on a local program build.
    expect(() => checkManifest(change((m) => void (m.status = 'release')))).toThrow(/development version name/);
    expect(() => checkManifest(change((m) => void ((m.status = 'release'), (m.version = '1.0.0'))))).toThrow(/Docker build/);
    const dockered = await addProgramBuild(manifest, program(99), 'solana-verify-docker');
    expect(() => checkManifest({ ...dockered, status: 'release', version: '1.0.0' })).toThrow(/committed lockfile/);
    expect(checkManifest({ ...dockered, status: 'release', version: '1.0.0', build: { ...dockered.build, lockfile: 'frozen' } }).status).toBe('release');
    // The file lists are bound to the record by the tree hashes.
    expect(() => checkRecord(manifest, { ...texts, web: texts.web.replace('favicon.svg', 'favicon.png') })).toThrow(/web\.SHA256SUMS is not the list web_tree_hash commits to/);
    expect(() => checkRecord(manifest, { web: texts.console, console: texts.web })).toThrow(ManifestError);
    expect(checkRecord(manifest, texts).sums.web.map((e) => e.file)).toEqual(['assets/app.js', 'assets/core.wasm', 'favicon.svg', 'index.html']);
  });

  it('refuses to describe a UI built for another program, or something that is not a program', async () => {
    const other = WEB.map(([n, c]): [string, string | Uint8Array] => (n === 'assets/app.js' ? [n, 'export const program = "11111111111111111111111111111111";'] : [n, c]));
    await expect(release({ web: tree(other) })).rejects.toThrow(/does not contain the program id/);
    const notElf = path.join(tmp(), 'xmr_swap.so');
    writeFileSync(notElf, 'not a program');
    await expect(release({ program: { file: notElf, method: 'local-sbf' } })).rejects.toThrow(/not an ELF file/);
  });

  it('records the Docker build beside the local one and never lets one stand for the other', async () => {
    const { manifest } = await release();
    const docker = program(99);
    const next = await addProgramBuild(manifest, docker, 'solana-verify-docker', 'identical', { image: 'example/image@sha256:' + 'a'.repeat(64), tool: '0.4.11' });
    expect(next.program_builds.map((b) => b.method)).toEqual(['local-sbf', 'solana-verify-docker']);
    expect(next.program_builds[0]).toEqual(manifest.program_builds[0]);
    expect(next.program_builds[1]).toMatchObject({ executable_hash: executableHash(elf(99)), double_build: 'identical', tool: '0.4.11' });
    // The hash to expect on-chain is now the Docker one, and says so.
    expect(next.program_hash_source).toBe('docker');
    expect(next.program_executable_hash).toBe(executableHash(elf(99)));
    expect(next.program_executable_hash).not.toBe(manifest.program_executable_hash);
    await expect(addProgramBuild(next, docker, 'solana-verify-docker')).rejects.toThrow(/already holds a solana-verify-docker build/);
  });
});

describe('the record tracked in this repository', () => {
  it('is a valid record and is plainly a development snapshot, with both program builds told apart', () => {
    const dir = fileURLToPath(new URL('../../releases/dev-snapshot', import.meta.url));
    const { manifest, sums } = readRecord(dir);
    expect(manifest.version).toBe('dev-snapshot');
    expect(manifest.status).toBe('development-snapshot');
    expect(manifest.note).toContain('Not a release');
    expect(manifest.onchain).toEqual({ deployed: false });
    expect(manifest.program_id).toBe(PROGRAM_ID);
    expect(manifest.build.lockfile).toBe('frozen');
    expect(manifest.web.double_build).toBe('identical');
    expect(manifest.console.double_build).toBe('identical');
    const local = manifest.program_builds.find((b) => b.method === 'local-sbf')!;
    const docker = manifest.program_builds.find((b) => b.method === 'solana-verify-docker')!;
    expect(local.double_build).toBe('identical');
    expect(docker.double_build).toBe('identical');
    expect(docker.image).toMatch(/^solanafoundation\/solana-verifiable-build@sha256:[0-9a-f]{64}$/);
    expect(docker.tool).toBe('0.4.11');
    // The headline hash is the Docker one and is labelled as such.
    expect(manifest.program_hash_source).toBe('docker');
    expect(manifest.program_executable_hash).toBe(docker.executable_hash);
    expect(sums.web.some((e) => e.file === 'index.html')).toBe(true);
    // No machine path in the record.
    expect(readFileSync(path.join(dir, 'release.json'), 'utf8')).not.toMatch(/\/home\/|\/tmp\//);
  });
});

describe('run verify', () => {
  it('matches every artefact of an untouched release directory, and says what that does and does not show', async () => {
    const r = await release();
    const v = await cli(['verify', r.out]);
    expect(v.code, v.out + v.err).toBe(0);
    expect(v.out).toContain('Record   dev-snapshot (DEVELOPMENT SNAPSHOT, not a release)');
    expect(v.out).toContain(`commit   ${COMMIT}`);
    expect(v.out).toContain("LOCAL build of the recorder's machine, not the Docker build");
    expect(v.out).toMatch(new RegExp(`MATCH        web      tree hash ${r.manifest.web_tree_hash}, 4 files, IPFS ${r.manifest.web_cid}`));
    expect(v.out).toMatch(new RegExp(`MATCH        console  tree hash ${r.manifest.console_tree_hash}`));
    expect(v.out).toContain(`MATCH        program  executable hash ${r.manifest.program_executable_hash} (the record's local-sbf build)`);
    expect(v.out).toContain('NOT CHECKED  on-chain this record names no deployment: there is no on-chain program to verify yet');
    expect(v.out).toContain('3 matched, 1 not compared, against files on disk (nothing was rebuilt).');
    expect(v.out).toContain('Only a rebuild (--rebuild) shows that the record matches the source.');
    expect(v.out).toContain('A match does not show that the source is safe: the software is unaudited.');
  });

  it('detects tampering in each artefact separately and names the file', async () => {
    // The taker UI.
    const web = await release();
    appendFileSync(path.join(web.out, 'web/assets/app.js'), '\n// changed');
    const w = await cli(['verify', web.out, '--only', 'web']);
    expect(w.code).toBe(1);
    expect(w.out).toMatch(/MISMATCH {5}web {6}tree hash is [0-9a-f]{64}, the record says/);
    expect(w.out).toContain('changed   assets/app.js');
    // The release directory's own list of everything notices it too.
    expect(w.out).toContain('MISMATCH     files    the release directory does not match its SHA256SUMS');
    expect(w.out).toContain('changed: web/assets/app.js');
    expect(w.out).toContain('MISMATCH');
    expect(w.out).not.toMatch(/MATCH {8}web/);

    // The console: a file added and one removed.
    const con = await release();
    writeFileSync(path.join(con.out, 'console/assets/extra.js'), 'x');
    rmSync(path.join(con.out, 'console/index.html'));
    const c = await cli(['verify', con.out, '--prebuilt', `console=${path.join(con.out, 'console')}`, '--only', 'console,web']);
    expect(c.code).toBe(1);
    expect(c.out).toContain('extra     assets/extra.js');
    expect(c.out).toContain('missing   index.html');
    expect(c.out).toMatch(/MISMATCH {5}console/);

    // The program: one byte.
    const prog = await release();
    const so = path.join(prog.out, 'program/xmr_swap.so');
    const bytes = readFileSync(so);
    bytes[1500]! ^= 0x01;
    writeFileSync(so, bytes);
    const p = await cli(['verify', prog.out, '--only', 'program']);
    expect(p.code).toBe(1);
    expect(p.out).toMatch(/MISMATCH {5}program {2}executable hash is [0-9a-f]{64}, which is none of the recorded builds/);
    expect(p.out).toContain(`recorded local-sbf: ${prog.manifest.program_executable_hash}`);
    expect(p.out).toContain('MISMATCH     files    the release directory does not match its SHA256SUMS');
    expect(p.out).toContain('changed: program/xmr_swap.so');
    expect(p.out).toContain('2 MISMATCHES. What was checked is not what the record says. Do not use it.');

    // Trailing zero padding is not a change to the program (a deployed program is padded).
    const padded = await release();
    appendFileSync(path.join(padded.out, 'program/xmr_swap.so'), Buffer.alloc(4096));
    const pp = await cli(['verify', padded.out, '--prebuilt', `program=${path.join(padded.out, 'program/xmr_swap.so')}`, '--only', 'program']);
    expect(pp.out).toContain('MATCH        program');
  });

  it('refuses a record whose own files were edited', async () => {
    const hash = await release();
    const file = path.join(hash.out, 'release.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(hash.manifest.web_tree_hash, 'e'.repeat(64)));
    const h = await cli(['verify', hash.out]);
    expect(h.code).toBe(1);
    expect(h.err).toContain('web.SHA256SUMS is not the list web_tree_hash commits to');

    const list = await release();
    appendFileSync(path.join(list.out, 'console.SHA256SUMS'), `${'0'.repeat(64)}  assets/backdoor.js\n`);
    const l = await cli(['verify', list.out]);
    expect(l.code).toBe(1);
    expect(l.err).toContain('console.SHA256SUMS is not the list console_tree_hash commits to');

    const junk = await release();
    writeFileSync(path.join(junk.out, 'release.json'), '{"format":"xmrswap-release/1"}');
    expect((await cli(['verify', junk.out])).err).toContain('not a valid release.json');
    expect((await cli(['verify', path.join(tmp(), 'nowhere')])).code).toBe(1);
    expect((await cli(['verify'])).code).toBe(2);
  });

  it('does not compare builds made by different methods', async () => {
    const r = await release();
    const other = program(99);
    const v = await cli(['verify', r.out, '--only', 'program', '--prebuilt', `program=${other}`, '--program-method', 'solana-verify-docker']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('NOT COMPARED program  built with solana-verify-docker; the record holds only local-sbf');
    expect(v.out).toContain('Hashes from different build methods are not expected to be equal.');
    expect(v.out).toContain('0 matched, 2 not compared');

    // Once the Docker build is recorded (through the CLI), it is the one compared, and the headline hash follows it.
    const add = await cli(['add-program', r.out, other, '--double-build', 'identical', '--tool', '0.4.11']);
    expect(add.code, add.err).toBe(0);
    expect(add.out).toContain(`program_executable_hash is now ${executableHash(elf(99))} (source: docker)`);
    expect(add.out).toContain('never compare across methods');
    const again = await cli(['verify', r.out, '--only', 'program', '--prebuilt', `program=${other}`, '--program-method', 'solana-verify-docker']);
    expect(again.out).toContain(`MATCH        program  executable hash ${executableHash(elf(99))} (solana-verify-docker)`);
    expect(again.out).toContain('expected executable hash ' + executableHash(elf(99)) + ' (from the Docker build)');
    // The local binary in the release directory still matches its own entry.
    expect((await cli(['verify', r.out, '--only', 'program'])).out).toContain("(the record's local-sbf build)");
  });

  it('assembles from prebuilt artefacts through the CLI and says that nothing was built', async () => {
    const out = path.join(tmp(), 'release');
    const r = await cli(['release', '--prebuilt', `web=${tree(WEB)}`, '--prebuilt', `console=${tree(CONSOLE)}`, '--prebuilt', `program=${program()}`, '--out', out, '--commit', 'HEAD']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Nothing is built, so nothing here shows that they come from commit');
    expect(r.out).toContain('double build       not run');
    expect(r.out).toContain('Nothing was deployed or published. There is no on-chain program to verify yet.');
    const m = readRecord(out).manifest;
    expect(m.status).toBe('development-snapshot');
    expect(m.note).toContain('Not a release');
    expect(m.web.double_build).toBe('not-run');
    expect((await cli(['release', '--prebuilt', `web=${tree(WEB)}`])).code).toBe(2);
    expect((await cli(['release', '--status', 'release'])).err).toContain('a release needs --version');
  });
});

describe('the program on-chain, against a fake RPC', () => {
  const authority = base58Encode(randomBytes(32));

  it('reads the deployed bytes as solana-verify does: after the 45-byte header, without the zero padding', async () => {
    const rpc = await startFakeSolana();
    rpc.deploy(PROGRAM_ID, elf(7, 0), authority, 50_000);
    const p = await fetchProgramHash(rpc.url, PROGRAM_ID);
    expect(p).toEqual({ found: true, loader: 'upgradeable', executable_hash: executableHash(elf(7)), size: 3000 + 50_000, upgrade_authority: authority, last_deployed_slot: 123_456 });
    rpc.deploy(PROGRAM_ID, elf(7, 0), null, 0);
    expect(await fetchProgramHash(rpc.url, PROGRAM_ID)).toMatchObject({ executable_hash: executableHash(elf(7)), upgrade_authority: null });
    expect(await fetchProgramHash(rpc.url, '11111111111111111111111111111111')).toEqual({ found: false });
    // Read-only: account reads and nothing else.
    expect(new Set(rpc.methods)).toEqual(new Set(['getAccountInfo']));
    rpc.refuseWith = 429;
    await expect(fetchProgramHash(rpc.url, PROGRAM_ID)).rejects.toThrow(/HTTP 429/);
  });

  it('verify --onchain reports a match, with the upgrade authority', async () => {
    const r = await release();
    const rpc = await startFakeSolana();
    rpc.deploy(PROGRAM_ID, elf(7, 0), authority, 10_000);
    const url = `${rpc.url}/?api-key=SECRET-KEY-123`;
    const v = await cli(['verify', r.out, '--onchain'], { SOLANA_RPC_URL: url });
    expect(v.code, v.out + v.err).toBe(0);
    expect(v.out).toContain(`MATCH        on-chain program ${PROGRAM_ID} has executable hash ${executableHash(elf(7))}, the record's local-sbf build`);
    expect(v.out).toContain(`upgrade authority: ${authority}: that key can still replace the program`);
    expect(v.out).toContain(`Independent check: solana-verify get-program-hash -u <your RPC URL> ${PROGRAM_ID}`);
    expect(v.out).toContain('4 matched');
    expect(v.out + v.err).not.toContain('SECRET-KEY-123');

    rpc.deploy(PROGRAM_ID, elf(7, 0), null, 0);
    expect((await cli(['verify', r.out, '--onchain', '--only', 'program'], { SOLANA_RPC_URL: url })).out).toContain('upgrade authority: none: the program is immutable');
  });

  it('verify --onchain reports a mismatch when another program is deployed', async () => {
    const r = await release();
    const rpc = await startFakeSolana();
    rpc.deploy(PROGRAM_ID, elf(8, 0), authority);
    const v = await cli(['verify', r.out, '--onchain'], { MY_RPC: rpc.url, SOLANA_RPC_URL: 'http://127.0.0.1:1/unused' });
    // The default variable points nowhere: the named one must be used.
    const named = await cli(['verify', r.out, '--onchain', '--rpc-url-env', 'MY_RPC'], { MY_RPC: rpc.url });
    expect(v.code).toBe(1);
    expect(v.err).toContain('the RPC endpoint is not reachable');
    expect(named.code).toBe(1);
    expect(named.out).toContain(`MISMATCH     on-chain program ${PROGRAM_ID} has executable hash ${executableHash(elf(8))}`);
    expect(named.out).toContain(`the record's local-sbf build is ${executableHash(elf(7))}`);
    expect(named.out).toContain('The deployed program is not a build this record holds.');
    expect(named.out).toContain('1 MISMATCH. What was checked is not what the record says. Do not use it.');
  });

  it('says plainly that nothing is deployed when the program is not there', async () => {
    const r = await release();
    const rpc = await startFakeSolana();
    rpc.programs.clear();
    const v = await cli(['verify', r.out, '--onchain'], { SOLANA_RPC_URL: rpc.url });
    expect(v.code).toBe(0);
    expect(v.out).toContain(`NOT CHECKED  on-chain no program at ${PROGRAM_ID} on the cluster behind SOLANA_RPC_URL`);
    expect(v.out).toContain('this record names no deployment, so there is no on-chain program to verify yet');
    // Another program id can be asked about; a malformed one is refused before any request.
    const other = base58Encode(randomBytes(32));
    rpc.deploy(other, elf(7, 0), null);
    expect((await cli(['verify', r.out, '--onchain', '--program-id', other, '--only', 'program'], { SOLANA_RPC_URL: rpc.url })).out).toContain(`MATCH        on-chain program ${other}`);
    expect((await cli(['verify', r.out, '--onchain', '--program-id', 'not-an-address'], { SOLANA_RPC_URL: rpc.url })).code).toBe(2);
    expect((await cli(['verify', r.out, '--onchain'])).err).toContain('--onchain needs the Solana RPC URL in the environment variable SOLANA_RPC_URL');
  });
});

describe('what the bundle says it is serving', () => {
  /** A releases directory holding one record made from `web`. */
  async function recorded(web: string, version = 'dev-snapshot'): Promise<{ releases: string; manifest: Manifest }> {
    const releases = tmp();
    const r = await release({ out: path.join(releases, version), web, version });
    return { releases, manifest: r.manifest };
  }

  it('serves /release.json with the tree hash of the UI and the record that has it', async () => {
    const web = tree(WEB);
    const { releases, manifest } = await recorded(web);
    const settings = loadSettings({ env: { XMRSWAP_UI_LISTEN: '127.0.0.1:0', RELAY_BIND: '127.0.0.1:0', XMRSWAP_UI_DIST: web, XMRSWAP_UI_RELEASES: releases } });
    const bundle = await startBundle(settings, { relay: { logSink: () => {} } });
    onClose(() => bundle.close());
    const res = await call(bundle.port, '/release.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      format: 'xmrswap-served/1',
      ui: { tree_hash: manifest.web_tree_hash, files: 4, bytes: manifest.web.bytes },
      recorded: true,
      release: {
        version: 'dev-snapshot',
        status: 'development-snapshot',
        commit: COMMIT,
        commit_time: '2026-11-27T10:00:00Z',
        program_id: PROGRAM_ID,
        contract: null,
        chain_id: null,
        web_tree_hash: manifest.web_tree_hash,
        web_cid: manifest.web_cid,
        program_executable_hash: manifest.program_executable_hash,
        program_hash_source: 'local',
        program_builds: [{ method: 'local-sbf', executable_hash: manifest.program_executable_hash }],
        onchain_deployed: false,
      },
    });
    expect(bundle.served).toEqual(res.json());
  });

  it('says "not recorded" for a UI that differs from every record by one byte, and for a damaged record', async () => {
    const web = tree(WEB);
    const { releases, manifest } = await recorded(web);
    appendFileSync(path.join(web, 'assets/app.js'), ' ');
    const changed = await describeServed(web, releases);
    expect(changed.recorded).toBe(false);
    expect(changed.release).toBeNull();
    expect(changed.ui.tree_hash).not.toBe(manifest.web_tree_hash);

    // A record whose list was edited to "match" a changed UI is not believed.
    const web2 = tree(WEB);
    const second = await recorded(web2);
    const dir = path.join(second.releases, 'dev-snapshot');
    appendFileSync(path.join(web2, 'assets/app.js'), ' ');
    const entries = await treeEntries(web2);
    const m = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')) as Manifest;
    m.web_tree_hash = treeHash(entries);
    writeFileSync(path.join(dir, 'release.json'), JSON.stringify(m));
    expect((await describeServed(web2, second.releases)).recorded).toBe(false);
    expect((await describeServed(web2, path.join(tmp(), 'missing'))).recorded).toBe(false);
  });

  it('prefers a release over a snapshot of the same tree', async () => {
    const { manifest } = await release();
    const docker = await addProgramBuild(manifest, program(99), 'solana-verify-docker');
    const real: Manifest = { ...docker, version: '1.0.0', status: 'release', build: { ...docker.build, lockfile: 'frozen' } };
    checkManifest(real);
    const served = servedRelease({ tree_hash: manifest.web_tree_hash, files: 4, bytes: 1 }, [manifest, real]);
    expect(served.release).toMatchObject({ version: '1.0.0', status: 'release', program_hash_source: 'docker' });
  });
});
