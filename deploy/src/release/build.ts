/**
 * Building the three artefacts from one commit, away from the working checkout.
 *
 * The commit is exported with `git archive` into an empty staging directory and everything is
 * built there with each package's own build command, so the result depends on the commit and
 * the tools, not on whatever is lying in the working tree, and no other package's build output
 * is touched. Nothing here deploys, signs or contacts a cluster.
 *
 * One thing is added to the packages' own commands, through the environment only: the wasm core
 * is compiled with `--remap-path-prefix` for the staging directory and the cargo home. Without
 * it the compiler writes those two absolute paths into the wasm (panic locations), so the same
 * source gives a different file in every directory and for every user name.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class BuildError extends Error {}

export const COMMANDS = {
  install: 'pnpm install --frozen-lockfile',
  wasm: 'pnpm --filter @xmrswap/core-wasm build',
  web: 'pnpm --filter @xmrswap/web build',
  console: 'pnpm --filter @xmrswap/console build',
  program: 'cargo build-sbf -- --locked',
  programDocker: '(cd solana/program && solana-verify build --library-name xmr_swap)',
  solanaVerifyInstall: 'cargo install solana-verify --version 0.4.11 --locked',
} as const;
/** The flags added for the wasm build, with the two machine-specific paths named, not spelled out. */
export const WASM_RUSTFLAGS = '--remap-path-prefix=<checkout>=/xmrswap --remap-path-prefix=<cargo home>=/cargo';

export type BuildTarget = 'web' | 'console' | 'program';

export interface StageOptions {
  /** Pass `--offline` to pnpm and cargo: fail rather than download. */
  offline?: boolean;
  /**
   * Cargo home for the wasm build only (a different path to the same registry shows that the path
   * does not leak into the wasm). The program build always uses the real cargo home: cargo-build-sbf
   * removes source paths by stripping each crate's working directory, which a linked cargo home defeats.
   */
  wasmCargoHome?: string;
  /**
   * When the commit's lockfile does not cover its package.json files (between milestones the
   * lockfile lags), install anyway and say so in the result. A release never allows this.
   */
  allowLockfileUpdate?: boolean;
  /** Called with one line per step. */
  log?: (line: string) => void;
  targets?: readonly BuildTarget[];
}

export interface StageResult {
  dir: string;
  /** frozen: installed exactly from the committed lockfile. updated: the lockfile was behind and pnpm resolved the rest. */
  lockfile: 'frozen' | 'updated';
  web: string | null;
  console: string | null;
  program: string | null;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string, what: string): void {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(logFile, `$ ${cmd} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (r.error) throw new BuildError(`${what}: cannot run ${cmd} (${(r.error as NodeJS.ErrnoException).code ?? r.error.message}). Is it installed?`);
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-25).join('\n');
    throw new BuildError(`${what} failed (exit ${r.status}). Last lines:\n${tail}\nFull log: ${logFile}`);
  }
}

const git = (repo: string, args: string[]): string => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new BuildError(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trimEnd();
};

/** The full hash of a commit, and its committer time in UTC. */
export function resolveCommit(repo: string, ref: string): { commit: string; time: string; epoch: number } {
  const commit = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const epoch = Number(git(repo, ['show', '-s', '--format=%ct', commit]));
  return { commit, epoch, time: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

/** Tracked files with uncommitted changes outside deploy/ and docs/. A build is made from the commit, so these are not in it. */
export function uncommittedInputs(repo: string): string[] {
  const out = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  return out === '' ? [] : out.split('\n').map((l) => l.slice(3)).filter((f) => !f.startsWith('deploy/') && !f.startsWith('docs/'));
}

/** Export `commit` into the empty directory `dir` (tracked files only). */
export function exportCommit(repo: string, commit: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new BuildError(`${dir} is not empty`);
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', commit], { maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new BuildError(`git archive failed: ${archive.stderr.toString().trim()}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new BuildError(`tar failed: ${untar.stderr.toString().trim()}`);
}

/**
 * A second cargo home at another path that shares the downloaded crates of the real one through
 * links. Building with it gives the registry a different absolute path without downloading anything.
 */
export function aliasCargoHome(dir: string): string {
  const real = process.env['CARGO_HOME'] ?? path.join(os.homedir(), '.cargo');
  mkdirSync(dir, { recursive: true });
  for (const sub of ['registry', 'git']) if (existsSync(path.join(real, sub)) && !existsSync(path.join(dir, sub))) symlinkSync(path.join(real, sub), path.join(dir, sub));
  return dir;
}

/** Build the requested artefacts in `dir`, which holds an exported commit. */
export function buildStage(dir: string, epoch: number, opts: StageOptions = {}): StageResult {
  const targets = opts.targets ?? ['web', 'console', 'program'];
  const log = opts.log ?? (() => {});
  const logs = path.join(dir, '.build-logs');
  mkdirSync(logs, { recursive: true });
  const cargoHome = process.env['CARGO_HOME'] ?? path.join(os.homedir(), '.cargo');
  const wasmCargoHome = opts.wasmCargoHome ?? cargoHome;
  // A fixed, small environment: the tools, where they keep their caches, and nothing else from the caller's shell.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    CARGO_HOME: cargoHome,
    ...(process.env['RUSTUP_HOME'] ? { RUSTUP_HOME: process.env['RUSTUP_HOME'] } : {}),
    ...(process.env['WASM_BINDGEN'] ? { WASM_BINDGEN: process.env['WASM_BINDGEN'] } : {}),
    TZ: 'UTC',
    LC_ALL: 'C',
    LANG: 'C',
    CI: 'true',
    SOURCE_DATE_EPOCH: String(epoch),
    ...(opts.offline ? { CARGO_NET_OFFLINE: 'true' } : {}),
  };
  const step = (name: string, f: () => void): void => {
    const t = Date.now();
    f();
    log(`  ${name} (${Math.round((Date.now() - t) / 1000)} s)`);
  };
  const needsNode = targets.includes('web') || targets.includes('console');
  let lockfile: 'frozen' | 'updated' = 'frozen';
  if (needsNode)
    step('install', () => {
      const offline = opts.offline ? ['--offline'] : [];
      try {
        run('pnpm', ['install', '--frozen-lockfile', ...offline], dir, env, path.join(logs, 'install.log'), COMMANDS.install);
      } catch (e) {
        const outdated = e instanceof BuildError && /OUTDATED_LOCKFILE|specifiers in the lockfile/.test(readFileSync(path.join(logs, 'install.log'), 'utf8'));
        if (!outdated) throw e;
        if (!opts.allowLockfileUpdate)
          throw new BuildError("the commit's pnpm-lock.yaml does not match its package.json files. A release must be built from a commit with an up-to-date lockfile, or the dependencies are not pinned.");
        log('  NOTE: pnpm-lock.yaml is behind the package.json files of this commit; installing without --frozen-lockfile.');
        run('pnpm', ['install', '--no-frozen-lockfile', ...offline], dir, env, path.join(logs, 'install-unfrozen.log'), 'pnpm install --no-frozen-lockfile');
        lockfile = 'updated';
      }
    });
  if (targets.includes('web')) {
    const flags = `--remap-path-prefix=${dir}=/xmrswap --remap-path-prefix=${wasmCargoHome}=/cargo`;
    step('wasm core', () => run('pnpm', ['--filter', '@xmrswap/core-wasm', 'build'], dir, { ...env, CARGO_HOME: wasmCargoHome, RUSTFLAGS: flags }, path.join(logs, 'wasm.log'), COMMANDS.wasm));
    step('web UI', () => run('pnpm', ['--filter', '@xmrswap/web', 'build'], dir, env, path.join(logs, 'web.log'), COMMANDS.web));
  }
  if (targets.includes('console')) step('console', () => run('pnpm', ['--filter', '@xmrswap/console', 'build'], dir, env, path.join(logs, 'console.log'), COMMANDS.console));
  if (targets.includes('program'))
    step('program', () => run('cargo', ['build-sbf', '--', '--locked', ...(opts.offline ? ['--offline'] : [])], path.join(dir, 'solana/program'), env, path.join(logs, 'program.log'), COMMANDS.program));
  const out = (rel: string, wanted: boolean): string | null => {
    if (!wanted) return null;
    const p = path.join(dir, rel);
    if (!existsSync(p)) throw new BuildError(`the build finished but ${rel} is missing`);
    return p;
  };
  return {
    dir,
    lockfile,
    web: out('apps/web/dist', targets.includes('web')),
    console: out('apps/console/dist', targets.includes('console')),
    program: out('solana/program/target/deploy/xmr_swap.so', targets.includes('program')),
  };
}

function version(cmd: string, args: string[], pick: RegExp): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = pick.exec(`${r.stdout}${r.stderr}`);
  return m ? m[1]! : null;
}

/** Versions of the build tools on this machine, as each reports itself. Missing tools are left out. */
export function toolVersions(repo: string, solanaVerify = 'solana-verify'): Record<string, string> {
  const out: Record<string, string> = { node: process.version };
  const add = (key: string, v: string | null): void => {
    if (v) out[key] = v;
  };
  add('pnpm', version('pnpm', ['--version'], /(\d+\.\d+\.\d+)/));
  // Asked inside the repository so that rust-toolchain.toml selects the compiler the wasm build uses.
  // Only asked, never installed: rustup would otherwise download a missing toolchain.
  const r = spawnSync('rustc', ['--version'], { cwd: repo, encoding: 'utf8', env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' } });
  add('rustc_wasm', r.status === 0 ? (/rustc (\S+)/.exec(r.stdout)?.[1] ?? null) : null);
  add('wasm_bindgen', version(process.env['WASM_BINDGEN'] ?? 'wasm-bindgen', ['--version'], /(\d+\.\d+\.\d+)/));
  const sbf = spawnSync('cargo', ['build-sbf', '--version'], { encoding: 'utf8' });
  if (sbf.status === 0) {
    add('cargo_build_sbf', /solana-cargo-build-sbf (\S+)/.exec(sbf.stdout)?.[1] ?? null);
    add('platform_tools', /platform-tools (\S+)/.exec(sbf.stdout)?.[1] ?? null);
    add('rustc_sbf', /rustc (\S+)/.exec(sbf.stdout)?.[1] ?? null);
  }
  add('solana_verify', version(solanaVerify, ['--version'], /solana-verify (\S+)/));
  try {
    const lock = readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8');
    add('vite', /\n {2}vite@(\d+\.\d+\.\d+)/.exec(lock)?.[1] ?? null);
  } catch {
    /* not recorded */
  }
  return out;
}

/** The solana-verify to use: `$SOLANA_VERIFY`, else the pinned copy under deploy/.tools, else the one on the PATH. */
export function solanaVerifyBin(deployDir: string): string {
  const pinned = path.join(deployDir, '.tools/bin/solana-verify');
  return process.env['SOLANA_VERIFY'] ?? (existsSync(pinned) ? pinned : 'solana-verify');
}

/** `solana-verify get-executable-hash <file>`, or `null` when the tool is not installed. */
export function solanaVerifyExecutableHash(file: string, bin = 'solana-verify'): string | null {
  const r = spawnSync(bin, ['get-executable-hash', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return /^([0-9a-f]{64})$/m.exec(r.stdout)?.[1] ?? null;
}
