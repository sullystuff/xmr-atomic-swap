import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { call, closeAll, closedPort } from './helpers.js';

afterEach(closeAll);

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

function run(env: Record<string, string>) {
  // A clean environment: nothing from the developer's shell, and never the system Tor port.
  const child = spawn(process.execPath, ['--import', 'tsx', main], { cwd, env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, out: () => out, err: () => err };
}

describe('the relay binary', () => {
  it('starts from environment variables, serves status and stops on SIGTERM', async () => {
    const port = await closedPort();
    const p = run({ RELAY_BIND: `127.0.0.1:${port}`, RELAY_TOR_SOCKS: `127.0.0.1:${await closedPort()}`, RELAY_CONFIG: '/dev/null' });
    try {
      for (let i = 0; i < 100 && !p.out().includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(p.out()).toContain(`[relay] listening on 127.0.0.1:${port}`);
      const status = await call(port, '/relay/v1/status');
      expect(status.json()).toEqual({ tor_ok: false, registry_age_secs: 0, makers: 0, monero_nodes: [] });
    } finally {
      p.child.kill('SIGTERM');
    }
    expect(await p.exited).toBe(0);
    expect(p.err()).toBe('');
  });

  it('exits with a message on a bad setting', async () => {
    const p = run({ RELAY_BIND: 'nonsense', RELAY_CONFIG: '/dev/null' });
    expect(await p.exited).toBe(2);
    expect(p.err()).toContain('configuration error: bind');
  });

  it('ships an example relay.toml that loads and equals the defaults', () => {
    const toml = readFileSync(new URL('../relay.example.toml', import.meta.url), 'utf8');
    expect(loadConfig({ toml })).toEqual(loadConfig());
  });
});
