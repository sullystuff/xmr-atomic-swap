/**
 * Putting built artefacts into a release directory and writing its record:
 *
 *   <out>/web/...  <out>/console/...  <out>/program/xmr_swap.so      the artefacts
 *   <out>/release.json  <out>/web.SHA256SUMS  <out>/console.SHA256SUMS   the record (the tracked part)
 *   <out>/SHA256SUMS                                                  every file above
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONTRACT_ADDRESS, CONTRACT_CHAIN_ID, PROGRAM_ID } from '@xmrswap/protocol';
import { SUMS_FILE, listingText, treeEntries } from '../../scripts/sums.mjs';
import { COMMANDS, WASM_RUSTFLAGS } from './build.js';
import { CID_PARAMS } from './cid.js';
import { type DoubleBuild, MANIFEST_FILE, type Manifest, ManifestError, type ProgramMethod, type ReleaseRecord, type TreeName, canonicalBuild, checkManifest, describeProgram, describeTree, sumsFile, writeRecord } from './manifest.js';

export interface AssembleInput {
  out: string;
  web: string;
  console: string;
  program: { file: string; method: ProgramMethod; image?: string; tool?: string };
  doubleBuild: DoubleBuild;
  lockfile: Manifest['build']['lockfile'];
  version: string;
  status: Manifest['status'];
  note?: string;
  commit: string;
  commitTime: string;
  tools: Record<string, string>;
}

export const PROGRAM_COMMAND: Readonly<Record<ProgramMethod, string>> = { 'local-sbf': COMMANDS.program, 'solana-verify-docker': COMMANDS.programDocker };

/** Refuse to replace a directory that is neither empty nor an earlier release. */
function prepareOut(out: string): void {
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(path.join(out, MANIFEST_FILE)) && !existsSync(path.join(out, SUMS_FILE)))
    throw new ManifestError(`${out} exists and is not an earlier release; choose another directory`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'program'), { recursive: true });
}

export async function assembleRelease(input: AssembleInput): Promise<ReleaseRecord & { texts: Record<TreeName, string> }> {
  for (const [name, dir] of [['web', input.web], ['console', input.console]] as const)
    if (!existsSync(path.join(dir, 'index.html'))) throw new ManifestError(`${name}: no index.html in ${dir}`);
  // The UI must be a build of the deployment this checkout pins; otherwise the record would name the wrong program.
  const assets = path.join(input.web, 'assets');
  const webJs = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  if (!webJs.some((f) => readFileSync(path.join(assets, f), 'utf8').includes(PROGRAM_ID)))
    throw new ManifestError(`web: the built UI does not contain the program id ${PROGRAM_ID} that this checkout pins. Run the release from a checkout of the commit being built.`);

  prepareOut(input.out);
  cpSync(input.web, path.join(input.out, 'web'), { recursive: true });
  cpSync(input.console, path.join(input.out, 'console'), { recursive: true });
  const so = path.join(input.out, 'program', 'xmr_swap.so');
  cpSync(input.program.file, so);

  const web = await describeTree(path.join(input.out, 'web'), 'web');
  const console_ = await describeTree(path.join(input.out, 'console'), 'console');
  const { image, tool } = input.program;
  const builds = [await describeProgram(so, input.program.method, PROGRAM_COMMAND[input.program.method], input.doubleBuild, { ...(image ? { image } : {}), ...(tool ? { tool } : {}) })];
  const canonical = canonicalBuild(builds);
  const manifest: Manifest = {
    format: 'xmrswap-release/1',
    version: input.version,
    status: input.status,
    ...(input.note ? { note: input.note } : {}),
    commit: input.commit,
    commit_time: input.commitTime,
    program_id: PROGRAM_ID,
    contract: CONTRACT_ADDRESS,
    chain_id: CONTRACT_CHAIN_ID,
    program_executable_hash: canonical.build.executable_hash,
    program_hash_source: canonical.source,
    web_tree_hash: web.tree_hash,
    console_tree_hash: console_.tree_hash,
    web_cid: web.cid,
    console_cid: console_.cid,
    cid_params: CID_PARAMS,
    onchain: { deployed: false },
    tools: input.tools,
    build: { host: `${process.platform}-${process.arch}`, wasm_rustflags: WASM_RUSTFLAGS, lockfile: input.lockfile },
    program_builds: builds,
    web: { files: web.files, bytes: web.bytes, command: `${COMMANDS.wasm} && ${COMMANDS.web}`, double_build: input.doubleBuild },
    console: { files: console_.files, bytes: console_.bytes, command: COMMANDS.console, double_build: input.doubleBuild },
  };
  const texts = { web: web.listing, console: console_.listing };
  writeRecord(input.out, manifest, texts);
  writeFileSync(path.join(input.out, SUMS_FILE), listingText(await treeEntries(input.out)));
  return { manifest, texts, sums: { web: web.entries.map((e) => ({ hash: e.sha256, file: e.path })), console: console_.entries.map((e) => ({ hash: e.sha256, file: e.path })) } };
}

/** Record another build of the program (a different method) in a manifest. The front ends are untouched. */
export async function addProgramBuild(manifest: Manifest, file: string, method: ProgramMethod, doubleBuild: DoubleBuild = 'not-run', extra: { image?: string; tool?: string } = {}): Promise<Manifest> {
  if (manifest.program_builds.some((p) => p.method === method)) throw new ManifestError(`the record already holds a ${method} build of the program`);
  const builds = [...manifest.program_builds, await describeProgram(file, method, PROGRAM_COMMAND[method], doubleBuild, extra)];
  const canonical = canonicalBuild(builds);
  return checkManifest({ ...manifest, program_executable_hash: canonical.build.executable_hash, program_hash_source: canonical.source, program_builds: builds });
}

/** Copy the tracked part of a release directory (the three record files) into `releases/<version>/`. */
export function recordFiles(): string[] {
  return [MANIFEST_FILE, sumsFile('web'), sumsFile('console')];
}
