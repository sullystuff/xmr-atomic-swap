/** Release checksums: generation, verification, and that tampering of any kind is caught. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID } from '@xmrswap/protocol';
import { describe, expect, it } from 'vitest';
import { loadSettings } from '../src/settings.js';
import { tmp } from './tmp.js';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const node = (script: string, ...args: string[]) => {
  // A clean environment and an unrelated working directory: the scripts need neither.
  const r = spawnSync(process.execPath, [path.join(scripts, script), ...args], { encoding: 'utf8', cwd: tmpdir(), env: { PATH: process.env['PATH'] ?? '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

/** A directory to checksum, made from the real built UI. */
function release(): string {
  const dir = path.join(tmp(), 'release');
  cpSync(loadSettings().ui.dist, path.join(dir, 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify({ name: 'xmrswap-web', programId: PROGRAM_ID })}\n`);
  const r = node('checksums.mjs', dir);
  expect(r.code, r.err).toBe(0);
  return dir;
}

describe('release checksums', () => {
  it('the release holds the built UI, what it pins, and a list that verifies', () => {
    const dir = release();
    expect(readdirSync(dir).sort()).toEqual(['SHA256SUMS', 'release.json', 'web']);
    expect(JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8'))).toMatchObject({ name: 'xmrswap-web', programId: PROGRAM_ID });
    const ui = loadSettings().ui.dist;
    expect(readFileSync(path.join(dir, 'web/index.html'))).toEqual(readFileSync(path.join(ui, 'index.html')));

    // The list is in sha256sum's format, sorted, one line per file, and each hash is right.
    const lines = readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    const names = lines.map((l) => l.slice(66));
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : 1)));
    expect(names).toContain('release.json');
    expect(names).toContain('web/index.html');
    expect(names.some((n) => n.endsWith('.wasm'))).toBe(true);
    expect(names).not.toContain('SHA256SUMS');
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}\S/);
      expect(createHash('sha256').update(readFileSync(path.join(dir, line.slice(66)))).digest('hex')).toBe(line.slice(0, 64));
    }

    const v = node('verify.mjs', dir);
    expect(v.code, v.out + v.err).toBe(0);
    expect(v.out).toContain(`OK: ${lines.length} files match SHA256SUMS`);
    // The digest of the list is what a publisher announces; both scripts print the same one.
    const digest = createHash('sha256').update(readFileSync(path.join(dir, 'SHA256SUMS'))).digest('hex');
    expect(v.out).toContain(`sha256 of the list itself: ${digest}`);
  });

  it('gives the same list for the same files (nothing machine-specific in it)', () => {
    const a = release();
    const b = path.join(tmp(), 'elsewhere');
    cpSync(a, b, { recursive: true });
    rmSync(path.join(b, 'SHA256SUMS'));
    expect(node('checksums.mjs', b).code).toBe(0);
    expect(readFileSync(path.join(b, 'SHA256SUMS'), 'utf8')).toBe(readFileSync(path.join(a, 'SHA256SUMS'), 'utf8'));
  });

  it('detects a tampered file, even one byte', () => {
    const dir = release();
    const js = readdirSync(path.join(dir, 'web/assets')).find((f) => f.endsWith('.js'))!;
    const file = path.join(dir, 'web/assets', js);
    const bytes = readFileSync(file);
    bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
    writeFileSync(file, bytes);
    const v = node('verify.mjs', dir);
    expect(v.code).toBe(1);
    expect(v.out).toContain(`CHANGED       web/assets/${js}`);
    expect(v.out).toContain('FAILED: 1 problem. Do not use these files.');
    expect(v.out).not.toContain('OK:');
  });

  it('detects a missing file, an added file and an edited list', () => {
    const missing = release();
    rmSync(path.join(missing, 'web/favicon.svg'));
    const m = node('verify.mjs', missing);
    expect(m.code).toBe(1);
    expect(m.out).toContain('MISSING       web/favicon.svg');

    const added = release();
    writeFileSync(path.join(added, 'web/assets/extra.js'), 'alert(1)');
    const a = node('verify.mjs', added);
    expect(a.code).toBe(1);
    expect(a.out).toContain('NOT IN LIST   web/assets/extra.js');

    const appended = release();
    appendFileSync(path.join(appended, 'web/index.html'), '\n');
    expect(node('verify.mjs', appended).code).toBe(1);

    const emptied = release();
    writeFileSync(path.join(emptied, 'SHA256SUMS'), '');
    const e = node('verify.mjs', emptied);
    expect(e.code).toBe(1);
    expect(e.err).toContain('lists no files');

    const noList = release();
    rmSync(path.join(noList, 'SHA256SUMS'));
    const n = node('verify.mjs', noList);
    expect(n.code).toBe(1);
    expect(n.err).toContain('no SHA256SUMS in the directory');
  });

  it('refuses a list that points outside the directory, and links inside it', () => {
    const outside = release();
    const secret = path.join(path.dirname(outside), 'outside.txt');
    writeFileSync(secret, 'x');
    const hash = createHash('sha256').update('x').digest('hex');
    appendFileSync(path.join(outside, 'SHA256SUMS'), `${hash}  ../outside.txt\n`);
    const o = node('verify.mjs', outside);
    expect(o.code).toBe(1);
    expect(o.err).toContain('names a path outside the directory');

    const linked = release();
    symlinkSync('/etc/hostname', path.join(linked, 'web/link'));
    const l = node('verify.mjs', linked);
    expect(l.code).toBe(1);
    expect(l.err).toContain('links and devices are refused');
  });

  it('a detached signature beside the list is not counted as an extra file', () => {
    const dir = release();
    writeFileSync(path.join(dir, 'SHA256SUMS.asc'), 'signature');
    expect(node('verify.mjs', dir).code).toBe(0);
  });

  it('the list is also accepted by sha256sum -c', () => {
    const dir = release();
    const out = execFileSync('sha256sum', ['--check', '--quiet', '--strict', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' });
    expect(out).toBe('');
  });

  it('prints usage without a directory, and refuses an empty one', () => {
    expect(node('verify.mjs').code).toBe(2);
    expect(node('checksums.mjs').code).toBe(2);
    const empty = tmp();
    mkdirSync(path.join(empty, 'x'));
    expect(node('checksums.mjs', path.join(empty, 'x')).code).toBe(1);
  });
});
