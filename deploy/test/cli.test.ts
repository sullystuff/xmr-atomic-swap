/**
 * The Node-only start command and the status command, as separate processes, the way a user
 * runs them. Every outside service is a loopback fake; the processes get a clean environment
 * (nothing from the developer's shell, never the system Tor port).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../src/settings.js';
import { recordFor } from './records.js';
import { type FakeMonero, type FakeSocks, type FakeSolana, call, closeAll, closedPort, fakeOnion, onClose, startFakeMaker, startFakeMonero, startFakeSocks, startFakeSolana } from './fakes.js';
import { tmp } from './tmp.js';

afterEach(closeAll);

const deployDir = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(deployDir, 'src/cli.ts');

interface Proc {
  exited: Promise<number | null>;
  out(): string;
  err(): string;
  kill(signal: NodeJS.Signals): void;
}

function run(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: deployDir, env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  onClose(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { exited, out: () => out, err: () => err, kill: (signal) => void child.kill(signal) };
}

async function waitFor(p: Proc, text: string): Promise<void> {
  for (let i = 0; i < 300 && !p.out().includes(text); i++) {
    if (await Promise.race([p.exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 100))])) break;
  }
  if (!p.out().includes(text)) throw new Error(`the process never printed "${text}".\nstdout:\n${p.out()}\nstderr:\n${p.err()}`);
}

interface Fakes {
  socks: FakeSocks;
  solana: FakeSolana;
  nodes: FakeMonero[];
  uiPort: number;
  env: Record<string, string>;
}

/** Fakes for everything outside the bundle, and the environment that points the bundle at them. */
async function fakes(): Promise<Fakes> {
  const socks = await startFakeSocks();
  const maker = await startFakeMaker();
  const onion = fakeOnion();
  socks.map.set(onion, maker.port);
  const solana = await startFakeSolana([onion]);
  const nodes = [await startFakeMonero(), await startFakeMonero()];
  const uiPort = await closedPort();
  // The settings file is the one a user would write; only the secret URL comes from the environment.
  const dir = tmp();
  const file = path.join(dir, 'xmrswap.toml');
  writeFileSync(
    file,
    [
      '[ui]',
      `listen = "127.0.0.1:${uiPort}"`,
      '[relay]',
      `bind = "127.0.0.1:${await closedPort()}"`,
      `tor_socks = "127.0.0.1:${socks.port}"`,
      `monero_nodes = ["${nodes[0]!.url}", "${nodes[1]!.url}"]`,
      '',
    ].join('\n'),
  );
  // A record of exactly the UI being served, as a release would ship one.
  const { releases } = await recordFor(loadSettings().ui.dist);
  return { socks, solana, nodes, uiPort, env: { XMRSWAP_SELFHOST_CONFIG: file, XMRSWAP_UI_RELEASES: releases, SOLANA_RPC_URL: `${solana.url}/?api-key=SECRET-KEY-123` } };
}

describe('pnpm --filter @xmrswap/deploy start', () => {
  it('is a Node-only command: no Docker, no Tor start', () => {
    const pkg = JSON.parse(readFileSync(path.join(deployDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['start']).toBe('node scripts/ensure-ui.mjs && tsx src/cli.ts start');
    expect(pkg.scripts['status']).toBe('tsx src/cli.ts status');
    for (const file of ['src/cli.ts', 'src/server.ts', 'src/checks.ts', 'src/settings.ts', 'scripts/ensure-ui.mjs']) {
      const src = readFileSync(path.join(deployDir, file), 'utf8');
      expect(src, file).not.toMatch(/\bdocker\b/i);
      // Nothing is spawned except the workspace build of a missing package.
      if (file !== 'scripts/ensure-ui.mjs') expect(src, file).not.toMatch(/child_process/);
      expect(src, file).not.toMatch(/systemctl|spawn\(\s*['"]tor['"]/);
    }
  });

  it('starts the UI and the relay on loopback, prints the address to open, and passes the status check', async () => {
    const f = await fakes();
    const p = run(['start'], f.env);
    await waitFor(p, 'Press Ctrl-C to stop');
    const open = `http://127.0.0.1:${f.uiPort}`;
    expect(p.out()).toContain(`    ${open}/\n`);
    expect(p.out()).toContain(`Status page:  ${open}/#/status`);
    expect(p.out()).toContain('this software is unaudited');
    expect(p.out()).toContain(`Build:        recorded build dev-snapshot (development-snapshot), commit ${'cd'.repeat(6)}`);
    expect(p.out()).toMatch(/ {14}UI tree hash [0-9a-f]{64}\n/);
    expect(p.out()).toContain(`Tor: a SOCKS proxy answers at 127.0.0.1:${f.socks.port}`);
    expect(p.out()).toMatch(/\[relay\] listening on 127\.0\.0\.1:\d+/);
    // An RPC URL carries an API key and is never printed.
    expect(p.out() + p.err()).not.toContain('SECRET-KEY-123');

    // The page, its settings and the relay, all from the one origin.
    const index = await call(f.uiPort, '/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<div id="root">');
    const cfg = (await call(f.uiPort, '/config.json', { headers: { host: `127.0.0.1:${f.uiPort}` } })).json();
    expect(cfg).toMatchObject({ mode: 'self-hosted', relayUrl: '/', programId: PROGRAM_ID, moneroNodes: [`${open}/monero/0`, `${open}/monero/1`] });
    await expect.poll(async () => (await call(f.uiPort, '/relay/v1/status')).json().makers).toBe(1);

    // The status command, as a second process.
    const st = run(['status'], f.env);
    expect(await st.exited, st.out() + st.err()).toBe(0);
    const text = st.out();
    expect(text).toContain('ok    Web UI served');
    expect(text).toContain('ok    Served UI is the recorded build dev-snapshot');
    expect(text).toContain(`A development snapshot (not a release), built from commit ${'cd'.repeat(20)}. UI tree hash `);
    expect(text).toContain('ok    Relay reachable');
    expect(text).toContain('It knows 1 maker');
    expect(text).toContain('ok    Tor proxy reachable');
    expect(text).toContain('ok    Solana RPC connected');
    expect(text).toContain(`Program ${PROGRAM_ID} found`);
    expect(text).toContain('off   Ethereum RPC');
    expect(text).toContain('ok    Monero nodes in agreement');
    expect(text).toContain('2 nodes in agreement: node 0 at height 3300000; node 1 at height 3300000');
    expect(text).toContain('ok    Program id is the one this release pins');
    expect(text).toContain('All checks passed.');
    expect(text + st.err()).not.toContain('SECRET-KEY-123');

    // --json gives the same checks for scripts.
    const js = run(['status', '--json'], f.env);
    expect(await js.exited).toBe(0);
    expect((JSON.parse(js.out()) as { id: string; state: string }[]).map((c) => `${c.id}:${c.state}`)).toEqual(['ui:ok', 'release:ok', 'relay:ok', 'tor:ok', 'solana:ok', 'ethereum:off', 'monero:ok', 'pinned:ok']);

    // A Monero node falls behind: the check fails and says which.
    f.nodes[1]!.height = 3_299_990;
    const behind = run(['status'], f.env);
    expect(await behind.exited).toBe(1);
    expect(behind.out()).toContain('FAIL  Monero nodes');
    expect(behind.out()).toContain('The nodes are 10 blocks apart: node 0 at height 3300000; node 1 at height 3299990');
    expect(behind.out()).toContain('1 problem to fix before swapping.');

    // Same height, different block: the nodes disagree.
    f.nodes[1]!.height = 3_300_000;
    f.nodes[1]!.topHash = 'cd'.repeat(32);
    const split = run(['status'], f.env);
    expect(await split.exited).toBe(1);
    expect(split.out()).toContain('Nodes at the same height report different blocks');
    f.nodes[1]!.topHash = f.nodes[0]!.topHash;

    // A node stops answering.
    f.nodes[0]!.down = true;
    const dead = run(['status'], f.env);
    expect(await dead.exited).toBe(1);
    expect(dead.out()).toContain('node 0 did not answer (HTTP 500)');
    f.nodes[0]!.down = false;

    // The RPC provider rate-limits.
    f.solana.refuseWith = 429;
    const limited = run(['status'], f.env);
    expect(await limited.exited).toBe(1);
    expect(limited.out()).toContain('FAIL  Solana RPC problem');
    expect(limited.out()).toContain('rate-limiting you (HTTP 429)');
    f.solana.refuseWith = null;

    // The RPC is for a cluster without the program.
    f.solana.programs.clear();
    const wrong = run(['status'], f.env);
    expect(await wrong.exited).toBe(1);
    expect(wrong.out()).toContain(`No program at ${PROGRAM_ID} on this cluster`);
    f.solana.programs.add(PROGRAM_ID);

    // Ctrl-C / SIGTERM stops both servers cleanly.
    p.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    expect(p.err()).toBe('');
    await expect(call(f.uiPort, '/')).rejects.toThrow();

    // With nothing running the status command says so and how to start it.
    const down = run(['status'], f.env);
    expect(await down.exited).toBe(1);
    expect(down.out()).toContain('FAIL  Web UI not running');
    expect(down.out()).toContain('Start it with: pnpm --filter @xmrswap/deploy start');
  });

  it('with no Tor proxy it still starts, explains how to get one without starting it, and the status check fails on Tor only', async () => {
    const f = await fakes();
    const dead = await closedPort();
    const env = { ...f.env, RELAY_TOR_SOCKS: `127.0.0.1:${dead}` };
    const p = run(['start'], env);
    await waitFor(p, 'Press Ctrl-C to stop');
    expect(p.out()).toContain(`Tor: nothing answers as a SOCKS proxy at 127.0.0.1:${dead}.`);
    expect(p.out()).toContain('messages to makers fall back to on-chain');
    expect(p.out()).toContain('This command never starts or changes a Tor client.');
    expect(p.out()).toContain('tor --SocksPort 127.0.0.1:9050 --DataDirectory "$HOME/.local/share/xmrswap-tor"');
    expect(p.out()).toContain('[relay] tor_socks = "127.0.0.1:9150"');
    expect((await call(f.uiPort, '/')).status).toBe(200);

    const st = run(['status'], env);
    expect(await st.exited).toBe(1);
    expect(st.out()).toContain('FAIL  Tor proxy not reachable');
    expect(st.out()).toContain('messages fall back to on-chain');
    expect(st.out()).toContain('ok    Solana RPC connected');
    expect(st.out()).toContain('ok    Monero nodes in agreement');
    expect(st.out()).toContain('1 problem to fix before swapping.');
    p.kill('SIGINT');
    expect(await p.exited).toBe(0);
  });

  it('with nothing configured it starts on the default address rules and says what is missing', async () => {
    const uiPort = await closedPort();
    const env = { XMRSWAP_SELFHOST_CONFIG: '/dev/null', XMRSWAP_UI_LISTEN: `127.0.0.1:${uiPort}`, XMRSWAP_UI_RELEASES: tmp(), RELAY_BIND: `127.0.0.1:${await closedPort()}`, RELAY_TOR_SOCKS: `127.0.0.1:${await closedPort()}` };
    const p = run(['start'], env);
    await waitFor(p, 'Press Ctrl-C to stop');
    expect(p.out()).toContain('Build:        not a recorded build (your own build, or changed files)');
    expect(p.out()).toContain('Solana RPC: not set.');
    expect(p.out()).toContain('Monero nodes: none set.');
    expect(p.out()).toContain('no Solana RPC URL or program id is set');
    const st = run(['status'], env);
    expect(await st.exited).toBe(1);
    expect(st.out()).toContain('warn  Served UI is not a recorded build');
    expect(st.out()).toContain('matches no record in the releases directory');
    expect(st.out()).toContain('warn  Relay reachable, but it has no maker list');
    expect(st.out()).toContain('FAIL  Solana RPC');
    expect(st.out()).toContain('No Monero node is configured');
    p.kill('SIGTERM');
    expect(await p.exited).toBe(0);
  });

  it('names a Monero node that cannot be reached at all', async () => {
    const f = await fakes();
    const env = { ...f.env, RELAY_MONERO_NODES: `${f.nodes[0]!.url},http://127.0.0.1:${await closedPort()}` };
    const p = run(['start'], env);
    await waitFor(p, 'Press Ctrl-C to stop');
    const st = run(['status'], env);
    expect(await st.exited).toBe(1);
    expect(st.out()).toContain('FAIL  Monero nodes');
    expect(st.out()).toContain('node 1 did not answer (HTTP 502 upstream_unreachable). While a node is unreachable no lock counts as confirmed.');
    p.kill('SIGTERM');
    await p.exited;
    // With the bundle stopped the nodes are asked directly, so the check still says which one is dead.
    const direct = run(['status'], env);
    expect(await direct.exited).toBe(1);
    expect(direct.out()).toContain('node 1 did not answer (ECONNREFUSED)');
    expect(direct.out()).not.toContain('node 0 did not answer');
  });

  it('warns at start when the page is public and would hand out the RPC URLs', async () => {
    const f = await fakes();
    const env = { ...f.env, XMRSWAP_UI_PUBLIC_ORIGIN: 'https://swap.example.org' };
    const p = run(['start'], env);
    await waitFor(p, 'Press Ctrl-C to stop');
    expect(p.out()).toContain('WARNING: the page is reachable from other machines and is given your RPC URLs.');
    expect(p.out()).toContain('    https://swap.example.org/\n');
    p.kill('SIGTERM');
    await p.exited;
    const quiet = run(['start'], { ...env, XMRSWAP_UI_GIVE_PAGE_RPC_URLS: 'false' });
    await waitFor(quiet, 'Press Ctrl-C to stop');
    expect(quiet.out()).not.toContain('WARNING');
    quiet.kill('SIGTERM');
    await quiet.exited;
  });

  it('refuses a second copy on the same address with a plain message', async () => {
    const f = await fakes();
    const p = run(['start'], f.env);
    await waitFor(p, 'Press Ctrl-C to stop');
    const second = run(['start'], f.env);
    expect(await second.exited).toBe(1);
    expect(second.err()).toContain('cannot start: an address is already in use');
    p.kill('SIGTERM');
    expect(await p.exited).toBe(0);
  });

  it('exits 2 with the reason on a bad setting, an unknown key or a URL in the file', async () => {
    const bad = run(['start'], { XMRSWAP_SELFHOST_CONFIG: '/dev/null', XMRSWAP_UI_LISTEN: 'nonsense' });
    expect(await bad.exited).toBe(2);
    expect(bad.err()).toContain('configuration error: ui.listen');

    const dir = tmp();
    const write = (text: string): string => {
      const file = path.join(dir, `${Math.random().toString(36).slice(2)}.toml`);
      writeFileSync(file, text);
      return file;
    };
    const unknown = run(['settings'], { XMRSWAP_SELFHOST_CONFIG: write('[ui]\nlisten_adress = "127.0.0.1:1"\n') });
    expect(await unknown.exited).toBe(2);
    expect(unknown.err()).toContain('unknown key "ui.listen_adress"');
    const unknownRelay = run(['settings'], { XMRSWAP_SELFHOST_CONFIG: write('[relay]\nsolana_rpc_url = "https://rpc.example/?key=abc"\n') });
    expect(await unknownRelay.exited).toBe(2);
    expect(unknownRelay.err()).toContain('unknown key "solana_rpc_url"');
    const urlInFile = run(['settings'], { XMRSWAP_SELFHOST_CONFIG: write('[relay]\nsolana_rpc_url_env = "https://rpc.example/?key=abc"\n') });
    expect(await urlInFile.exited).toBe(2);
    expect(urlInFile.err()).toContain('expected the NAME of an environment variable');
    const missing = run(['settings'], { XMRSWAP_SELFHOST_CONFIG: path.join(dir, 'absent.toml') });
    expect(await missing.exited).toBe(2);
  });
});

describe('settings and pinned', () => {
  it('prints the effective settings without the RPC URLs', async () => {
    const f = await fakes();
    const p = run(['settings'], { ...f.env, ETHEREUM_RPC_URL: 'https://eth.example/v2/ANOTHER-SECRET' });
    expect(await p.exited).toBe(0);
    expect(p.out()).toContain(`ui.listen          127.0.0.1:${f.uiPort}`);
    expect(p.out()).toContain('Solana RPC URL     set');
    expect(p.out()).toContain('Ethereum RPC URL   set');
    expect(p.out()).toContain(`program id         ${PROGRAM_ID} (pinned by this release)`);
    expect(p.out()).toContain('proxies in front   0');
    expect(p.out()).not.toContain('SECRET');
  });

  it('prints the pinned program id and contract address', async () => {
    const p = run(['pinned'], {});
    expect(await p.exited).toBe(0);
    expect(p.out()).toContain(`program id (Solana)          ${PROGRAM_ID}`);
    expect(p.out()).toContain('contract address (Ethereum)');
  });

  it('warns when the page is pointed at another program than the pinned one', async () => {
    const f = await fakes();
    const other = '11111111111111111111111111111111';
    f.solana.programs.add(other);
    const env = { ...f.env, RELAY_PROGRAM_ID: other };
    const p = run(['start'], env);
    await waitFor(p, 'Press Ctrl-C to stop');
    const st = run(['status'], env);
    await st.exited;
    expect(st.out()).toContain('warn  Program id differs from the one this release pins');
    expect(st.out()).toContain('could take your funds');
    p.kill('SIGTERM');
    await p.exited;
  });
});

describe('scripts/ensure-ui.mjs', () => {
  const script = path.join(deployDir, 'scripts/ensure-ui.mjs');
  const runScript = (env: Record<string, string>, cwd: string) => {
    const child = spawn(process.execPath, [script], { cwd, env: { PATH: '/nonexistent', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    return new Promise<{ code: number | null; out: string }>((r) => child.on('exit', (code) => r({ code, out })));
  };

  it('builds nothing when everything it needs exists (it never rebuilds)', async () => {
    // With an empty PATH there is no pnpm to call, so exit 0 proves nothing was built.
    const r = await runScript({}, deployDir);
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  it('requires a source build of the UI by default, and not when the settings point at an unpacked release', async () => {
    const plan = async (env: Record<string, string>, cwd: string): Promise<string[]> => {
      const child = spawn(process.execPath, [script, '--plan'], { cwd, env: { PATH: '/nonexistent', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      await new Promise((r) => child.on('exit', r));
      return out.trim().split('\n').map((l) => l.split(' ')[0]!);
    };
    expect(await plan({}, deployDir)).toEqual(['@xmrswap/protocol', '@xmrswap/relay', '@xmrswap/web']);
    const dir = tmp();
    writeFileSync(path.join(dir, 'xmrswap.toml'), '[ui]\ndist = "/srv/verified-release/web"\n');
    const withoutUi = ['@xmrswap/protocol', '@xmrswap/relay'];
    expect(await plan({ XMRSWAP_UI_DIST: '/srv/verified-release/web' }, deployDir)).toEqual(withoutUi);
    expect(await plan({ XMRSWAP_SELFHOST_CONFIG: path.join(dir, 'xmrswap.toml') }, deployDir)).toEqual(withoutUi);
    // The file is also found as ./xmrswap.toml in the working directory, as the start command finds it.
    expect(await plan({}, dir)).toEqual(withoutUi);
  });
});
