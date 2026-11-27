/**
 * A recorded build (SPEC 11.5): `releases/<version>/` holds
 *
 *   release.json        one commit and, for each artefact built from it, a content hash
 *   web.SHA256SUMS      the taker UI's file list; its SHA-256 is `web_tree_hash`
 *   console.SHA256SUMS  the console's file list; its SHA-256 is `console_tree_hash`
 *
 * `deploy/release.schema.json` is the format of release.json. This module reads, checks and
 * compares records. Nothing here builds anything.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Ajv } from 'ajv';
import { type TreeEntry, executableHash, listingText, parseSums, sha256, treeEntries, treeHash } from '../../scripts/sums.mjs';
import { CID_PARAMS, treeCid } from './cid.js';

export type ProgramMethod = 'local-sbf' | 'solana-verify-docker';
export const PROGRAM_METHODS: readonly ProgramMethod[] = ['local-sbf', 'solana-verify-docker'];
export type DoubleBuild = 'identical' | 'not-run';
export type TreeName = 'web' | 'console';
export const TREE_NAMES: readonly TreeName[] = ['web', 'console'];
export type ArtifactName = TreeName | 'program';
export const MANIFEST_FILE = 'release.json';
export const sumsFile = (name: TreeName): string => `${name}.SHA256SUMS`;

export interface ProgramBuild {
  method: ProgramMethod;
  size: number;
  sha256: string;
  executable_hash: string;
  command: string;
  double_build: DoubleBuild;
  image?: string;
  tool?: string;
}

export interface TreeSummary {
  files: number;
  bytes: number;
  command: string;
  double_build: DoubleBuild;
}

export interface Manifest {
  format: 'xmrswap-release/1';
  version: string;
  status: 'development-snapshot' | 'release';
  note?: string;
  commit: string;
  commit_time: string;
  program_id: string;
  contract: string | null;
  chain_id: number | null;
  program_executable_hash: string;
  program_hash_source: 'docker' | 'local';
  web_tree_hash: string;
  console_tree_hash: string;
  web_cid: string;
  console_cid: string;
  cid_params: string;
  onchain: { deployed: boolean; cluster?: string };
  tools: Record<string, string>;
  build: { host: string; wasm_rustflags: string; lockfile: 'frozen' | 'updated' | 'prebuilt' };
  program_builds: ProgramBuild[];
  web: TreeSummary;
  console: TreeSummary;
}

/** A record as it sits in `releases/<version>/`: the manifest and the two file lists. */
export interface ReleaseRecord {
  manifest: Manifest;
  sums: Record<TreeName, { hash: string; file: string }[]>;
}

export class ManifestError extends Error {}

const require = createRequire(import.meta.url);
const schema = require('../../release.schema.json') as object;
const validate = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);

/** The build whose hash is the one to expect on-chain: the Docker build when recorded, else the local one. */
export function canonicalBuild(builds: readonly ProgramBuild[]): { build: ProgramBuild; source: 'docker' | 'local' } {
  const docker = builds.find((b) => b.method === 'solana-verify-docker');
  if (docker) return { build: docker, source: 'docker' };
  const local = builds.find((b) => b.method === 'local-sbf');
  if (!local) throw new ManifestError('no program build is recorded');
  return { build: local, source: 'local' };
}

/** Check a parsed release.json against the schema and against itself. Throws `ManifestError`. */
export function checkManifest(value: unknown): Manifest {
  if (!validate(value)) {
    const first = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '(release.json)'} ${e.message ?? ''}`.trim());
    throw new ManifestError(`not a valid release.json: ${first.join('; ')}`);
  }
  const m = value as Manifest;
  const methods = m.program_builds.map((p) => p.method);
  if (new Set(methods).size !== methods.length) throw new ManifestError('program_builds: a build method is listed twice');
  const { build, source } = canonicalBuild(m.program_builds);
  if (m.program_hash_source !== source || m.program_executable_hash !== build.executable_hash)
    throw new ManifestError(`program_executable_hash/program_hash_source must be the ${source} build's (${build.executable_hash})`);
  if (m.status === 'release') {
    if (/dev|snapshot/i.test(m.version)) throw new ManifestError('a record with status "release" cannot carry a development version name');
    if (m.program_hash_source !== 'docker') throw new ManifestError('a record with status "release" must take its program hash from the Docker build');
    if (m.build.lockfile !== 'frozen') throw new ManifestError('a record with status "release" must be built from the committed lockfile');
  }
  return m;
}

/** Check that the two file lists are the ones the manifest's tree hashes commit to. */
export function checkRecord(manifest: Manifest, texts: Record<TreeName, string>): ReleaseRecord {
  const sums = {} as ReleaseRecord['sums'];
  for (const name of TREE_NAMES) {
    const text = texts[name];
    const want = name === 'web' ? manifest.web_tree_hash : manifest.console_tree_hash;
    if (createHash('sha256').update(text).digest('hex') !== want) throw new ManifestError(`${sumsFile(name)} is not the list ${name}_tree_hash commits to (it was changed, or belongs to another record)`);
    let entries: { hash: string; file: string }[];
    try {
      entries = parseSums(text);
    } catch (e) {
      throw new ManifestError(`${sumsFile(name)}: ${(e as Error).message}`);
    }
    if (entries.length !== manifest[name].files) throw new ManifestError(`${sumsFile(name)} lists ${entries.length} files, release.json says ${manifest[name].files}`);
    sums[name] = entries;
  }
  return { manifest, sums };
}

/** Read `releases/<version>/` (or a release directory, which holds the same three files). */
export function readRecord(dirOrFile: string): ReleaseRecord {
  const dir = existsSync(dirOrFile) && statSync(dirOrFile).isDirectory() ? dirOrFile : path.dirname(dirOrFile);
  const read = (name: string): string => {
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch (e) {
      throw new ManifestError(`cannot read ${path.join(dir, name)}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  };
  let value: unknown;
  try {
    value = JSON.parse(read(MANIFEST_FILE));
  } catch (e) {
    if (e instanceof ManifestError) throw e;
    throw new ManifestError(`${path.join(dir, MANIFEST_FILE)} is not JSON`);
  }
  return checkRecord(checkManifest(value), { web: read(sumsFile('web')), console: read(sumsFile('console')) });
}

/** Stable text of a manifest: fixed key order (as built), two-space indent, trailing newline. */
export function manifestText(m: Manifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** Write the three files of a record into `dir`. */
export function writeRecord(dir: string, manifest: Manifest, texts: Record<TreeName, string>): void {
  checkRecord(checkManifest(manifest), texts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, MANIFEST_FILE), manifestText(manifest));
  for (const name of TREE_NAMES) writeFileSync(path.join(dir, sumsFile(name)), texts[name]);
}

// ------------------------------------------------------------------ describing artefacts on disk

export interface TreeDescription {
  entries: TreeEntry[];
  listing: string;
  tree_hash: string;
  cid: string;
  files: number;
  bytes: number;
}

export async function describeTree(dir: string, name: TreeName): Promise<TreeDescription> {
  const entries = await treeEntries(dir);
  if (entries.length === 0) throw new ManifestError(`${name}: ${dir} holds no files`);
  return { entries, listing: listingText(entries), tree_hash: treeHash(entries), cid: await treeCid(dir, entries.map((e) => e.path)), files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) };
}

export async function describeProgram(file: string, method: ProgramMethod, command: string, doubleBuild: DoubleBuild, extra: { image?: string; tool?: string } = {}): Promise<ProgramBuild> {
  const bytes = readFileSync(file);
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('latin1') !== '\x7fELF') throw new ManifestError(`program: ${file} is not an ELF file`);
  return { method, size: bytes.length, sha256: await sha256(file), executable_hash: executableHash(bytes), command, double_build: doubleBuild, ...extra };
}

// ------------------------------------------------------------------ comparing

export type Verdict = 'match' | 'mismatch' | 'not-comparable' | 'not-checked';
export interface ArtifactResult {
  artifact: ArtifactName | 'on-chain' | 'files';
  verdict: Verdict;
  /** One line: what was compared. */
  summary: string;
  /** What differs, or why nothing was compared. */
  details: string[];
}

/** Compare a file tree on disk with a record's list of it, file by file. */
export async function compareTree(r: ReleaseRecord, name: TreeName, dir: string): Promise<ArtifactResult> {
  const wantHash = name === 'web' ? r.manifest.web_tree_hash : r.manifest.console_tree_hash;
  const wantCid = name === 'web' ? r.manifest.web_cid : r.manifest.console_cid;
  const got = await describeTree(dir, name);
  if (got.tree_hash === wantHash) {
    // Same listing, so the CID must agree too; a difference would be a bug in one of the two computations.
    if (got.cid !== wantCid) return { artifact: name, verdict: 'mismatch', summary: `tree hash ${got.tree_hash} matches, but the IPFS CID does not`, details: [`recorded  ${wantCid}`, `computed  ${got.cid} (${CID_PARAMS})`] };
    return { artifact: name, verdict: 'match', summary: `tree hash ${got.tree_hash}, ${got.files} files, IPFS ${got.cid}`, details: [] };
  }
  const details: string[] = [];
  const wantBy = new Map(r.sums[name].map((e) => [e.file, e.hash]));
  const gotBy = new Map(got.entries.map((e) => [e.path, e.sha256]));
  for (const [p, h] of wantBy) {
    if (!gotBy.has(p)) details.push(`missing   ${p}`);
    else if (gotBy.get(p) !== h) details.push(`changed   ${p}`);
  }
  for (const p of gotBy.keys()) if (!wantBy.has(p)) details.push(`extra     ${p}`);
  return { artifact: name, verdict: 'mismatch', summary: `tree hash is ${got.tree_hash}, the record says ${wantHash}`, details };
}

/** Compare a program binary with the record: with the build of `method`, or (method `null`) with every recorded build. */
export function compareProgram(m: Manifest, file: string, method: ProgramMethod | null): ArtifactResult {
  const got = executableHash(readFileSync(file));
  if (method === null) {
    const hit = m.program_builds.find((p) => p.executable_hash === got);
    if (hit) return { artifact: 'program', verdict: 'match', summary: `executable hash ${got} (the record's ${hit.method} build)`, details: [] };
    return { artifact: 'program', verdict: 'mismatch', summary: `executable hash is ${got}, which is none of the recorded builds`, details: m.program_builds.map((p) => `recorded ${p.method}: ${p.executable_hash}`) };
  }
  const want = m.program_builds.find((p) => p.method === method);
  if (!want) {
    const have = m.program_builds.map((p) => p.method).join(', ');
    return {
      artifact: 'program',
      verdict: 'not-comparable',
      summary: `built with ${method}; the record holds only ${have}`,
      details: [`executable hash of this build: ${got}`, 'Hashes from different build methods are not expected to be equal. Build with the recorded method to compare.'],
    };
  }
  if (got === want.executable_hash) return { artifact: 'program', verdict: 'match', summary: `executable hash ${got} (${method})`, details: [] };
  return { artifact: 'program', verdict: 'mismatch', summary: `executable hash is ${got}, the record says ${want.executable_hash} (${method})`, details: [] };
}

// ------------------------------------------------------------------ what the bundle serves

/** `GET /release.json` of the bundle: what the served UI is, and the recorded build it equals, if any. */
export interface ServedRelease {
  format: 'xmrswap-served/1';
  /** Computed from the files being served when the bundle started. */
  ui: { tree_hash: string; files: number; bytes: number };
  /** True when a record in the releases directory has exactly this UI tree. */
  recorded: boolean;
  release: {
    version: string;
    status: Manifest['status'];
    commit: string;
    commit_time: string;
    program_id: string;
    contract: string | null;
    chain_id: number | null;
    web_tree_hash: string;
    web_cid: string;
    program_executable_hash: string;
    program_hash_source: 'docker' | 'local';
    /** Every recorded build of the program, so a local build is never mistaken for the Docker one. */
    program_builds: { method: ProgramMethod; executable_hash: string }[];
    onchain_deployed: boolean;
  } | null;
}

export function servedRelease(ui: ServedRelease['ui'], manifests: readonly Manifest[]): ServedRelease {
  // A real release wins over a snapshot that happens to record the same tree.
  const hit = [...manifests].sort((a, b) => (a.status === b.status ? 0 : a.status === 'release' ? -1 : 1)).find((m) => m.web_tree_hash === ui.tree_hash);
  return {
    format: 'xmrswap-served/1',
    ui,
    recorded: hit !== undefined,
    release: hit
      ? {
          version: hit.version,
          status: hit.status,
          commit: hit.commit,
          commit_time: hit.commit_time,
          program_id: hit.program_id,
          contract: hit.contract,
          chain_id: hit.chain_id,
          web_tree_hash: hit.web_tree_hash,
          web_cid: hit.web_cid,
          program_executable_hash: hit.program_executable_hash,
          program_hash_source: hit.program_hash_source,
          program_builds: hit.program_builds.map((p) => ({ method: p.method, executable_hash: p.executable_hash })),
          onchain_deployed: hit.onchain.deployed,
        }
      : null,
  };
}
