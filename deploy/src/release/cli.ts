#!/usr/bin/env node
/**
 * Release tooling:
 *
 *   release [options]                 build the program, the taker UI and the console from one commit,
 *                                     twice, in two different directories; require identical results;
 *                                     write a release directory with its manifest
 *   verify <manifest> [options]       rebuild (or take prebuilt artefacts) and compare with a manifest;
 *                                     optionally compare the program on-chain with the manifest
 *   add-program <manifest> <file.so>  record another build of the program (the Docker build) in a manifest
 *
 * Nothing here deploys, signs, holds a key or publishes anything. The only network use is what
 * pnpm and cargo need to fetch dependencies (none with --offline) and, for `verify --onchain`,
 * two read-only calls to the RPC URL the user supplies.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUMS_FILE, parseSums, treeEntries } from '../../scripts/sums.mjs';
import { DEPLOY_DIR } from '../settings.js';
import { addProgramBuild, assembleRelease, recordFiles } from './assemble.js';
import { BuildError, type BuildTarget, COMMANDS, type StageResult, aliasCargoHome, buildStage, exportCommit, resolveCommit, solanaVerifyBin, solanaVerifyExecutableHash, toolVersions, uncommittedInputs } from './build.js';
import { type ArtifactName, type ArtifactResult, MANIFEST_FILE, type Manifest, ManifestError, PROGRAM_METHODS, type ProgramMethod, type ReleaseRecord, compareProgram, compareTree, describeProgram, describeTree, manifestText, readRecord } from './manifest.js';
import { OnchainError, fetchProgramHash, isProgramId } from './onchain.js';

const REPO = path.resolve(DEPLOY_DIR, '..');
const RELEASES_DIR = path.join(REPO, 'releases');
const SOLANA_VERIFY = solanaVerifyBin(DEPLOY_DIR);
const out = (line = ''): void => void process.stdout.write(`${line}\n`);

class UsageError extends Error {}

interface Args {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
}

const VALUE_OPTIONS = ['--commit', '--version', '--status', '--note', '--out', '--prebuilt', '--program-method', '--only', '--program-id', '--rpc-url-env', '--method', '--work-dir', '--image', '--tool', '--double-build'];
const FLAG_OPTIONS = ['--offline', '--once', '--record', '--keep', '--onchain', '--rebuild'];

function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (FLAG_OPTIONS.includes(arg)) a.flags.add(arg);
    else if (VALUE_OPTIONS.includes(arg)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      a.values.set(arg, [...(a.values.get(arg) ?? []), v]);
    } else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else a.positional.push(arg);
  }
  return a;
}
const one = (a: Args, name: string): string | undefined => a.values.get(name)?.at(-1);

function method(value: string | undefined, fallback: ProgramMethod): ProgramMethod {
  if (value === undefined) return fallback;
  if (!(PROGRAM_METHODS as readonly string[]).includes(value)) throw new UsageError(`unknown build method "${value}" (expected ${PROGRAM_METHODS.join(' or ')})`);
  return value as ProgramMethod;
}

/** `--prebuilt web=<dir>`, `console=<dir>`, `program=<file.so>`; paths are taken from where the command was typed. */
function prebuilt(a: Args): Partial<Record<ArtifactName, string>> {
  const got: Partial<Record<ArtifactName, string>> = {};
  const base = process.env['INIT_CWD'] ?? process.cwd();
  for (const item of a.values.get('--prebuilt') ?? []) {
    const m = /^(web|console|program)=(.+)$/.exec(item);
    if (!m) throw new UsageError(`--prebuilt takes web=<dir>, console=<dir> or program=<file.so>, got "${item}"`);
    got[m[1] as ArtifactName] = path.resolve(base, m[2]!);
  }
  return got;
}
const userPath = (p: string): string => path.resolve(process.env['INIT_CWD'] ?? process.cwd(), p);

function workDir(a: Args): { dir: string; temporary: boolean } {
  const given = one(a, '--work-dir');
  if (given) {
    mkdirSync(userPath(given), { recursive: true });
    return { dir: mkdtempSync(path.join(userPath(given), 'build-')), temporary: false };
  }
  return { dir: mkdtempSync(path.join(os.tmpdir(), 'xmrswap-release-')), temporary: true };
}

/** Build `targets` from `commit` once or twice; with two builds, require identical artefacts. */
async function buildFromCommit(commit: string, epoch: number, work: string, targets: readonly BuildTarget[], opts: { offline: boolean; twice: boolean; allowLockfileUpdate: boolean }): Promise<{ first: StageResult; doubleBuild: 'identical' | 'not-run' }> {
  out(`Building ${targets.join(', ')} from commit ${commit}${opts.twice ? ', twice, in two directories' : ''}.`);
  out(opts.twice ? 'build 1:' : 'build:');
  const one_ = path.join(work, 'one');
  exportCommit(REPO, commit, one_);
  const first = buildStage(one_, epoch, { offline: opts.offline, targets, log: out, allowLockfileUpdate: opts.allowLockfileUpdate });
  if (!opts.twice) return { first, doubleBuild: 'not-run' };

  // The second build runs somewhere else, with the cargo home at another path too, so that a
  // path written into an artefact shows up as a difference.
  out('build 2 (different directory; the wasm core also with the cargo home at a different path):');
  const two = path.join(work, 'second-build', 'in-a-deeper-directory');
  exportCommit(REPO, commit, two);
  const second = buildStage(two, epoch, { offline: opts.offline, targets, log: out, allowLockfileUpdate: opts.allowLockfileUpdate, wasmCargoHome: aliasCargoHome(path.join(work, 'cargo-home-alias')) });

  const differences: string[] = [];
  for (const name of ['web', 'console'] as const) {
    if (!first[name] || !second[name]) continue;
    const a = await describeTree(first[name], name);
    const b = await describeTree(second[name], name);
    if (a.tree_hash !== b.tree_hash) {
      const bBy = new Map(b.entries.map((e) => [e.path, e.sha256]));
      const aPaths = new Set(a.entries.map((e) => e.path));
      differences.push(`${name}: tree hash ${a.tree_hash} (build 1) and ${b.tree_hash} (build 2)`);
      for (const e of a.entries) differences.push(bBy.has(e.path) ? (bBy.get(e.path) !== e.sha256 ? `  differs         ${e.path}` : '') : `  only in build 1 ${e.path}`);
      for (const e of b.entries) if (!aPaths.has(e.path)) differences.push(`  only in build 2 ${e.path}`);
    } else if (a.cid !== b.cid) differences.push(`${name}: same tree hash but different CIDs`);
  }
  if (first.program && second.program) {
    const a = await describeProgram(first.program, 'local-sbf', '', 'not-run');
    const b = await describeProgram(second.program, 'local-sbf', '', 'not-run');
    if (a.sha256 !== b.sha256) differences.push(`program: sha256 ${a.sha256} (build 1) and ${b.sha256} (build 2)`);
  }
  const real = differences.filter((d) => d !== '');
  if (real.length > 0) throw new BuildError(`the two builds are NOT identical:\n${real.join('\n')}\nThe build directories were kept for inspection: ${work}`);
  out('The two builds are identical.');
  return { first, doubleBuild: 'identical' };
}

async function release(a: Args): Promise<number> {
  const pre = prebuilt(a);
  const status = one(a, '--status') ?? 'development-snapshot';
  if (status !== 'development-snapshot' && status !== 'release') throw new UsageError('--status is development-snapshot or release');
  const version = one(a, '--version') ?? (status === 'release' ? undefined : 'dev-snapshot');
  if (!version) throw new UsageError('a release needs --version');
  const { commit, time, epoch } = resolveCommit(REPO, one(a, '--commit') ?? 'HEAD');
  const outDir = userPath(one(a, '--out') ?? path.join(DEPLOY_DIR, 'release'));
  const tools = toolVersions(REPO, SOLANA_VERIFY);
  const note =
    one(a, '--note') ??
    (status === 'development-snapshot' ? 'Development snapshot. Not a release: the program and both front ends are still changing, nothing is deployed, and no third party has verified this build.' : undefined);

  let web: string;
  let console_: string;
  let program: { file: string; method: ProgramMethod };
  let doubleBuild: 'identical' | 'not-run' = 'not-run';
  let lockfile: Manifest['build']['lockfile'] = 'prebuilt';
  let work: { dir: string; temporary: boolean } | null = null;

  const names = Object.keys(pre);
  if (names.length > 0) {
    if (!pre.web || !pre.console || !pre.program) throw new UsageError('with --prebuilt, give all three: web=<dir>, console=<dir> and program=<file.so>');
    out(`Assembling from prebuilt artefacts. Nothing is built, so nothing here shows that they come from commit ${commit}.`);
    web = pre.web;
    console_ = pre.console;
    program = { file: pre.program, method: method(one(a, '--program-method'), 'local-sbf') };
  } else {
    const dirty = uncommittedInputs(REPO);
    if (dirty.length > 0) out(`Note: ${dirty.length} tracked file(s) have uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', ...' : ''}). They are NOT in this build: it is made from the commit.`);
    work = workDir(a);
    const built = await buildFromCommit(commit, epoch, work.dir, ['web', 'console', 'program'], { offline: a.flags.has('--offline'), twice: !a.flags.has('--once'), allowLockfileUpdate: status !== 'release' });
    lockfile = built.first.lockfile;
    web = built.first.web!;
    console_ = built.first.console!;
    program = { file: built.first.program!, method: 'local-sbf' };
    doubleBuild = built.doubleBuild;
  }

  const { manifest } = await assembleRelease({ out: outDir, web, console: console_, program, doubleBuild, lockfile, version, status, ...(note ? { note } : {}), commit, commitTime: time, tools });
  if (work && work.temporary && !a.flags.has('--keep')) rmSync(work.dir, { recursive: true, force: true });

  // The executable hash is computed here by the same rule as solana-verify; when the tool is installed, ask it too.
  const mine = manifest.program_builds[0]!.executable_hash;
  const theirs = solanaVerifyExecutableHash(path.join(outDir, 'program', 'xmr_swap.so'), SOLANA_VERIFY);
  if (theirs !== null && theirs !== mine) throw new BuildError(`solana-verify get-executable-hash prints ${theirs}, this tool computed ${mine}. One of the two is wrong; do not use this record.`);

  out('');
  out(`release directory  ${outDir}`);
  out(`version            ${manifest.version} (${manifest.status})`);
  out(`commit             ${manifest.commit}`);
  out(`program            executable hash ${mine} (${program.method})`);
  out(`                   ${theirs !== null ? 'solana-verify get-executable-hash prints the same value' : 'solana-verify is not installed, so it was not asked'}`);
  out(`web                tree hash ${manifest.web_tree_hash}`);
  out(`                   IPFS ${manifest.web_cid}`);
  out(`console            tree hash ${manifest.console_tree_hash}`);
  out(`                   IPFS ${manifest.console_cid}`);
  out(`double build       ${doubleBuild === 'identical' ? 'identical in two directories' : 'not run'}`);
  if (lockfile === 'updated') out('lockfile           BEHIND the commit: some dependencies were resolved at build time and are not pinned by the commit');
  if (a.flags.has('--record')) {
    const dir = path.join(RELEASES_DIR, version);
    mkdirSync(dir, { recursive: true });
    for (const f of recordFiles()) cpSync(path.join(outDir, f), path.join(dir, f));
    out(`recorded           releases/${version}/ (${recordFiles().join(', ')})`);
  }
  out('');
  if (program.method === 'local-sbf') out(`The program hash is this machine's local build. The hash a release must carry comes from the Docker build: see deploy/scripts/program-docker-build.sh.`);
  out('Nothing was deployed or published. There is no on-chain program to verify yet.');
  return 0;
}

const LABEL: Readonly<Record<ArtifactResult['verdict'], string>> = { match: 'MATCH        ', mismatch: 'MISMATCH     ', 'not-comparable': 'NOT COMPARED ', 'not-checked': 'NOT CHECKED  ' };

function printResult(r: ArtifactResult): void {
  out(`${LABEL[r.verdict]}${r.artifact.padEnd(8)} ${r.summary}`);
  for (const d of r.details) out(`                      ${d}`);
}

async function onchain(m: Manifest, a: Args): Promise<ArtifactResult> {
  const programId = one(a, '--program-id') ?? m.program_id;
  if (!isProgramId(programId)) throw new UsageError(`--program-id: "${programId}" is not a Solana address`);
  const check = `Independent check: solana-verify get-program-hash -u <your RPC URL> ${programId}`;
  if (!a.flags.has('--onchain')) {
    return {
      artifact: 'on-chain',
      verdict: 'not-checked',
      summary: m.onchain.deployed ? 'not asked for (add --onchain, with the RPC URL in SOLANA_RPC_URL)' : 'this record names no deployment: there is no on-chain program to verify yet',
      details: m.onchain.deployed ? [] : ['Once a program is deployed, compare it with: run verify <record> --onchain (RPC URL in SOLANA_RPC_URL).'],
    };
  }
  const envName = one(a, '--rpc-url-env') ?? 'SOLANA_RPC_URL';
  const rpcUrl = process.env[envName];
  if (!rpcUrl) throw new UsageError(`--onchain needs the Solana RPC URL in the environment variable ${envName}`);
  if (!/^https?:\/\//.test(rpcUrl)) throw new UsageError(`${envName}: expected an http or https URL`);
  const p = await fetchProgramHash(rpcUrl, programId);
  if (!p.found) {
    return {
      artifact: 'on-chain',
      verdict: m.onchain.deployed ? 'mismatch' : 'not-checked',
      summary: `no program at ${programId} on the cluster behind ${envName}`,
      details: [m.onchain.deployed ? 'The record says the program is deployed. Check that the RPC URL is for the right cluster.' : 'That is expected: this record names no deployment, so there is no on-chain program to verify yet.'],
    };
  }
  const authority = p.loader === 'v2' ? 'none (immutable loader)' : p.upgrade_authority === null ? 'none: the program is immutable' : `${p.upgrade_authority}: that key can still replace the program`;
  const hit = m.program_builds.find((b) => b.executable_hash === p.executable_hash);
  if (hit) return { artifact: 'on-chain', verdict: 'match', summary: `program ${programId} has executable hash ${p.executable_hash}, the record's ${hit.method} build`, details: [`upgrade authority: ${authority}`, check] };
  return {
    artifact: 'on-chain',
    verdict: 'mismatch',
    summary: `program ${programId} has executable hash ${p.executable_hash}`,
    details: [...m.program_builds.map((b) => `the record's ${b.method} build is ${b.executable_hash}`), `upgrade authority: ${authority}`, 'The deployed program is not a build this record holds. Do not assume it was built from this source.', check],
  };
}

/** A release directory carries its artefacts beside the record; `releases/<version>/` carries the record only. */
function artefactsIn(dir: string): Partial<Record<ArtifactName, string>> {
  const got: Partial<Record<ArtifactName, string>> = {};
  if (existsSync(path.join(dir, 'web', 'index.html'))) got.web = path.join(dir, 'web');
  if (existsSync(path.join(dir, 'console', 'index.html'))) got.console = path.join(dir, 'console');
  if (existsSync(path.join(dir, 'program', 'xmr_swap.so'))) got.program = path.join(dir, 'program', 'xmr_swap.so');
  return got;
}

/** Every file of a release directory against its SHA256SUMS (the same check as scripts/verify.mjs). */
async function checkSums(dir: string): Promise<string[]> {
  const listed = new Map(parseSums(readFileSync(path.join(dir, SUMS_FILE), 'utf8')).map((e) => [e.file, e.hash]));
  const problems: string[] = [];
  const actual = await treeEntries(dir);
  const seen = new Set<string>();
  for (const e of actual) {
    seen.add(e.path);
    if (!listed.has(e.path)) problems.push(`not in ${SUMS_FILE}: ${e.path}`);
    else if (listed.get(e.path) !== e.sha256) problems.push(`changed: ${e.path}`);
  }
  for (const f of listed.keys()) if (!seen.has(f)) problems.push(`missing: ${f}`);
  return problems;
}

async function verify(a: Args): Promise<number> {
  const target = a.positional[0];
  if (!target) throw new UsageError('verify needs a record: a release directory, or releases/<version>');
  const where = userPath(target);
  const record: ReleaseRecord = readRecord(where);
  const m = record.manifest;
  const dir = existsSync(where) && !where.endsWith('.json') ? where : path.dirname(where);
  const only = one(a, '--only')?.split(',').map((s) => s.trim());
  if (only && only.some((n) => !['web', 'console', 'program'].includes(n))) throw new UsageError('--only takes web, console, program (comma-separated)');
  const wanted = (['web', 'console', 'program'] as const).filter((n) => !only || only.includes(n));
  const beside = a.flags.has('--rebuild') ? {} : artefactsIn(dir);
  const given = prebuilt(a);
  const pre = { ...beside, ...given };

  out(`Record   ${m.version} (${m.status === 'release' ? 'release' : 'DEVELOPMENT SNAPSHOT, not a release'})`);
  out(`commit   ${m.commit} (${m.commit_time})`);
  out(`program  expected executable hash ${m.program_executable_hash} (from the ${m.program_hash_source === 'docker' ? 'Docker build' : "LOCAL build of the recorder's machine, not the Docker build"})`);
  out('');

  const results: ArtifactResult[] = [];
  if (Object.keys(beside).length > 0 && existsSync(path.join(dir, SUMS_FILE))) {
    const problems = await checkSums(dir);
    if (problems.length > 0) results.push({ artifact: 'files', verdict: 'mismatch', summary: `the release directory does not match its ${SUMS_FILE}`, details: problems });
  }
  const toBuild = wanted.filter((n) => !pre[n]);
  let built: StageResult | null = null;
  let work: { dir: string; temporary: boolean } | null = null;
  if (toBuild.length > 0) {
    const { commit, epoch } = resolveCommit(REPO, m.commit);
    work = workDir(a);
    built = (await buildFromCommit(commit, epoch, work.dir, toBuild, { offline: a.flags.has('--offline'), twice: false, allowLockfileUpdate: true })).first;
    out('');
  }
  for (const name of wanted) {
    const source = pre[name] ?? built?.[name];
    if (!source || !existsSync(source)) {
      results.push({ artifact: name, verdict: 'mismatch', summary: `${source ?? name} does not exist`, details: [] });
      continue;
    }
    if (name === 'program') {
      // A rebuild here is always a local build. A supplied binary is compared with the method named, or with every recorded build.
      const how = pre.program ? (one(a, '--program-method') ? method(one(a, '--program-method'), 'local-sbf') : null) : 'local-sbf';
      results.push(compareProgram(m, source, how));
    } else results.push(await compareTree(record, name, source));
  }
  results.push(await onchain(m, a));
  if (work && work.temporary && !a.flags.has('--keep')) rmSync(work.dir, { recursive: true, force: true });

  for (const r of results) printResult(r);
  out('');
  const bad = results.filter((r) => r.verdict === 'mismatch').length;
  const good = results.filter((r) => r.verdict === 'match').length;
  const open = results.length - bad - good;
  const rebuilt = toBuild.length > 0;
  const supplied = wanted.some((n) => pre[n]);
  const source = rebuilt && supplied ? `a rebuild from commit ${m.commit.slice(0, 12)} and files on disk` : rebuilt ? `a rebuild from commit ${m.commit.slice(0, 12)}` : 'files on disk (nothing was rebuilt)';
  if (bad > 0) out(`${bad} MISMATCH${bad === 1 ? '' : 'ES'}. What was checked is not what the record says. Do not use it.`);
  else out(`${good} matched${open ? `, ${open} not compared` : ''}, against ${source}.`);
  if (bad === 0 && !rebuilt) out('Files on disk matching the record shows the files are the recorded ones. Only a rebuild (--rebuild) shows that the record matches the source.');
  out('A match does not show that the source is safe: the software is unaudited.');
  return bad > 0 ? 1 : 0;
}

async function addProgram(a: Args): Promise<number> {
  const [target, so] = a.positional;
  if (!target || !so) throw new UsageError('add-program needs <record directory> <file.so> [--method solana-verify-docker]');
  const dir = userPath(target);
  const record = readRecord(dir);
  const how = method(one(a, '--method'), 'solana-verify-docker');
  const double = one(a, '--double-build') ?? 'not-run';
  if (double !== 'identical' && double !== 'not-run') throw new UsageError('--double-build is identical or not-run');
  const image = one(a, '--image');
  const tool = one(a, '--tool');
  const next = await addProgramBuild(record.manifest, userPath(so), how, double, { ...(image ? { image } : {}), ...(tool ? { tool } : {}) });
  writeFileSync(path.join(dir, MANIFEST_FILE), manifestText(next));
  const added = next.program_builds.at(-1)!;
  out(`recorded ${added.method} build in ${path.join(target, MANIFEST_FILE)}: executable hash ${added.executable_hash}`);
  out(`program_executable_hash is now ${next.program_executable_hash} (source: ${next.program_hash_source})`);
  for (const b of next.program_builds) if (b !== added) out(`${b.method} build: ${b.executable_hash}${b.executable_hash === added.executable_hash ? ' (equal)' : ' (different, as expected for a different toolchain; never compare across methods)'}`);
  return 0;
}

const USAGE = `usage:
  release [--commit <ref>] [--version <v>] [--status development-snapshot|release] [--out <dir>] [--record] [--once] [--offline] [--keep] [--work-dir <dir>]
  release --prebuilt web=<dir> --prebuilt console=<dir> --prebuilt program=<file.so> [--program-method local-sbf|solana-verify-docker] ...
  verify <release directory | releases/<version>> [--rebuild] [--prebuilt name=<path>]... [--program-method <m>] [--only web,console,program] [--offline]
         [--onchain [--program-id <id>] [--rpc-url-env <NAME>]]
  add-program <record directory> <file.so> [--method solana-verify-docker] [--image <image@digest>] [--tool <version>] [--double-build identical]
(${COMMANDS.solanaVerifyInstall} installs the pinned solana-verify.)
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (cmd === 'release') return release(a);
  if (cmd === 'verify') return verify(a);
  if (cmd === 'add-program') return addProgram(a);
  process.stderr.write(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n${USAGE}`);
      process.exit(2);
    }
    if (e instanceof ManifestError || e instanceof BuildError || e instanceof OnchainError) {
      process.stderr.write(`failed: ${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
