// Starting the service from a configuration (keystore on first start, endpoint checks, the
// HTTP server), and the command line: `start`, `status`, `pubkey`.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID } from '@xmrswap/protocol';
import type { EthTransport } from '@xmrswap/sdk';
import { FakeEthereum, FakeMoneroNode, FakeSolana } from '@xmrswap/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { KeystoreError, WatcherKeys } from '../src/keys.js';
import { type Running, startWatcher } from '../src/run.js';
import { CONTRACT } from './world.js';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = { SOLANA_RPC_URL: 'http://127.0.0.1:1', ETHEREUM_RPC_URL: 'http://127.0.0.1:1' };
const toml = (dir: string, extra = '', bind = '127.0.0.1:0'): string =>
  `bind = "${bind}"\ndata_dir = ${JSON.stringify(dir)}\nnetwork = "regtest"\n${extra}\n[monero]\nnodes = ["http://127.0.0.1:1", "http://127.0.0.1:2"]\n[solana]\nprogram_id = "${PROGRAM_ID}"\n[ethereum]\ncontract = "${CONTRACT}"\nchain_id = 31337\n`;
const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-run-'));
const ethTransport = (fake: FakeEthereum): EthTransport => ({ request: (a) => (a.method === 'eth_getBalance' ? Promise.resolve('0xde0b6b3a7640000') : fake.request(a)) });
const fakes = () => ({ solanaTransport: new FakeSolana({ subscriptions: false }), ethereumTransport: ethTransport(new FakeEthereum(CONTRACT)), moneroNodes: [new FakeMoneroNode('a', 100), new FakeMoneroNode('b', 100)] });

const running: Running[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

describe('starting the service', () => {
  it('generates the keystore on first start, binds the database to it, serves on loopback, and reopens with the same keys', async () => {
    const dir = tmp();
    const lines: string[] = [];
    const first = await startWatcher(loadConfig({ toml: toml(dir), env: ENV }), { passphrase: 'pass one', loop: false, logSink: (l) => lines.push(l), ...fakes() });
    running.push(first);
    expect(readdirSync(dir).filter((f) => !f.endsWith('-wal') && !f.endsWith('-shm')).sort()).toEqual(['watcher-keystore.json', 'watcher.sqlite']);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${first.url}/watch/v1/info`)).json()).toEqual({ solana: first.keys.solana, ethereum: first.keys.ethereum, max_swaps: 200, monero_nodes: 2, chains: ['solana', 'ethereum'] });
    const health = (await (await fetch(`${first.url}/watch/v1/health`)).json()) as { chains: Record<string, { reachable: boolean; fee_balance: string; runway_freezes: number }>; monero: unknown };
    expect(health.chains['ethereum']).toMatchObject({ reachable: true, fee_balance: '1000000000000000000', runway_freezes: 101 });
    expect(health.chains['solana']).toMatchObject({ reachable: true, fee_balance: '0', runway_freezes: 0, accepting: false });
    expect(health.monero).toEqual({ nodes: 2, reachable: 2, agreeing: true });
    expect(lines.join('\n')).toContain('generated a new watcher keystore');
    // Nothing secret reaches the log: not the passphrase, not an RPC URL.
    for (const secret of ['pass one', 'http://127.0.0.1:1']) expect(lines.join('\n')).not.toContain(secret);
    const keys = [first.keys.solana, first.keys.ethereum];
    await running.pop()!.stop();
    await expect(startWatcher(loadConfig({ toml: toml(dir), env: ENV }), { passphrase: 'wrong', loop: false, logSink: () => {}, ...fakes() })).rejects.toBeInstanceOf(KeystoreError);
    await expect(startWatcher(loadConfig({ toml: toml(dir), env: ENV }), { passphrase: '', loop: false, logSink: () => {}, ...fakes() })).rejects.toBeInstanceOf(KeystoreError);
    const second = await startWatcher(loadConfig({ toml: toml(dir), env: ENV }), { passphrase: 'pass one', loop: false, logSink: () => {}, ...fakes() });
    running.push(second);
    expect([second.keys.solana, second.keys.ethereum]).toEqual(keys);
  });

  it('refuses an endpoint of another cluster or chain before believing anything it says', async () => {
    const wrongChain = new FakeEthereum(CONTRACT);
    wrongChain.chainId = 1n;
    await expect(startWatcher(loadConfig({ toml: toml(tmp()), env: ENV }), { passphrase: 'p', loop: false, logSink: () => {}, ...fakes(), ethereumTransport: ethTransport(wrongChain) })).rejects.toThrow(/ethereum: the endpoint is not the configured chain \(chain id\)/);
    const withGenesis = toml(tmp()).replace('[solana]', '[solana]\ngenesis_hash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"');
    await expect(startWatcher(loadConfig({ toml: withGenesis, env: ENV }), { passphrase: 'p', loop: false, logSink: () => {}, ...fakes() })).rejects.toBeInstanceOf(ConfigError);
    const rightGenesis = toml(tmp()).replace('[solana]', `[solana]\ngenesis_hash = "${new FakeSolana().genesis}"`);
    running.push(await startWatcher(loadConfig({ toml: rightGenesis, env: ENV }), { passphrase: 'p', loop: false, logSink: () => {}, ...fakes() }));
  });

  it('starts when the endpoints are down (it can only wait), reports it in health, and refuses watches meanwhile', async () => {
    const dir = tmp();
    // No test seams: the real transports, pointed at a closed loopback port.
    const r = await startWatcher(loadConfig({ toml: toml(dir), env: ENV }), { passphrase: 'p', loop: false, logSink: () => {} });
    running.push(r);
    const res = await fetch(`${r.url}/watch/v1/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, accepting: false, chains: { solana: { reachable: false }, ethereum: { reachable: false } }, monero: { nodes: 2, reachable: 0, agreeing: false } });
    await r.watcher.tick();
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
const tsx = path.join(pkg, 'node_modules/.bin/tsx');
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(tsx, [path.join(pkg, 'src/cli.ts'), ...args], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env }, cwd: pkg }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('the command line', () => {
  it('pubkey creates the keystore once and prints the two keys; start, status and a clean stop work end to end', async () => {
    const dir = tmp();
    const port = await freePort();
    const file = path.join(dir, 'watcher.toml');
    writeFileSync(file, toml(path.join(dir, 'data'), 'poll_secs = 1', `127.0.0.1:${port}`));
    const env = { ...ENV, WATCHER_PASSPHRASE: 'cli passphrase' };

    // No keystore and no passphrase: it says which variable is missing.
    const none = await cli(['pubkey', '--config', file], ENV);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('set WATCHER_PASSPHRASE to create one');
    const made = await cli(['pubkey', '--config', file], env);
    expect(made.code).toBe(0);
    const keys = JSON.parse(made.stdout) as { solana: string; ethereum: string };
    expect(keys).toEqual(WatcherKeys.publicKeys(path.join(dir, 'data')));
    // Afterwards it needs no passphrase.
    expect(JSON.parse((await cli(['pubkey', '--config', file], ENV)).stdout)).toEqual(keys);

    const down = await cli(['status', '--config', file], ENV);
    expect(down.code).toBe(1);
    expect(JSON.parse(down.stdout)).toMatchObject({ running: false, health: null });

    const noPass = await cli(['start', '--config', file], ENV);
    expect(noPass.code).toBe(1);
    expect(noPass.stderr).toContain('the environment variable WATCHER_PASSPHRASE (the keystore passphrase) is not set');

    const child = spawn(tsx, [path.join(pkg, 'src/cli.ts'), 'start', '--config', file], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env }, cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    for (let i = 0; i < 300 && !out.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain(`listening on 127.0.0.1:${port}`);
    expect(out).toContain(`watcher keys: solana ${keys.solana}, ethereum ${keys.ethereum}`);
    expect(await (await fetch(`http://127.0.0.1:${port}/watch/v1/info`)).json()).toMatchObject(keys);
    const up = await cli(['status', '--config', file], ENV);
    // Running, but its endpoints are closed ports: not healthy, and it says so.
    expect(up.code).toBe(1);
    expect(JSON.parse(up.stdout)).toMatchObject({ running: true, health: { ok: false, chains: { solana: { reachable: false } } }, watches: {} });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    // Nothing secret was printed.
    for (const secret of ['cli passphrase', ENV.SOLANA_RPC_URL]) expect(out).not.toContain(secret);
    expect(readFileSync(path.join(dir, 'data/watcher-keystore.json'), 'utf8')).not.toContain('cli passphrase');
  });

  it('refuses a non-loopback bind, an unknown command and an unreadable file, with a message and a non-zero exit', async () => {
    const dir = tmp();
    const file = path.join(dir, 'watcher.toml');
    writeFileSync(file, toml(path.join(dir, 'data'), '', '0.0.0.0:8790'));
    const bind = await cli(['start', '--config', file], { ...ENV, WATCHER_PASSPHRASE: 'p' });
    expect(bind.code).toBe(2);
    expect(bind.stderr).toContain('is not a loopback address');
    expect((await cli(['freeze-everything'], ENV)).code).toBe(2);
    expect((await cli([], ENV)).stderr).toContain('usage: xmrswap-watcher <start|status|pubkey>');
    const missing = await cli(['start', '--config', path.join(dir, 'nope.toml')], ENV);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read');
  });
});
