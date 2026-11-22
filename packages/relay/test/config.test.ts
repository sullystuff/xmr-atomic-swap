import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopback, loadConfig, loadConfigFromProcess } from '../src/index.js';

const PROGRAM_ID = '5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u';

describe('configuration', () => {
  it('has the documented defaults', () => {
    expect(loadConfig()).toEqual({
      bindHost: '127.0.0.1',
      bindPort: 8787,
      torSocksHost: '127.0.0.1',
      torSocksPort: 9050,
      solanaRpcUrl: null,
      programId: null,
      moneroNodes: [],
      requestsPerMinute: 60,
      bytesPerMinute: 4_194_304,
      moneroMaxResponseBytes: 16_777_216,
      debugLog: false,
      allowedOrigins: [],
      trustProxyHops: 0,
    });
  });

  const toml = `
bind = "127.0.0.1:9999"
tor_socks = "127.0.0.1:9150"
solana_rpc_url_env = "MY_RPC"
program_id = "${PROGRAM_ID}"
monero_nodes = ["http://127.0.0.1:18081", "https://node.example:18089/"]
allowed_origins = ["http://127.0.0.1:8080"]
debug_log = false
trust_proxy_hops = 1

[rate_limit]
requests_per_minute = 120
bytes_per_minute = 8000000
`;

  it('reads relay.toml, with the RPC URL taken from the named environment variable', () => {
    const c = loadConfig({ toml, env: { MY_RPC: 'https://rpc.example/?api-key=k', SOLANA_RPC_URL: 'https://ignored.example' } });
    expect(c).toMatchObject({
      bindPort: 9999,
      torSocksPort: 9150,
      solanaRpcUrl: 'https://rpc.example/?api-key=k',
      programId: PROGRAM_ID,
      moneroNodes: ['http://127.0.0.1:18081', 'https://node.example:18089'],
      allowedOrigins: ['http://127.0.0.1:8080'],
      requestsPerMinute: 120,
      bytesPerMinute: 8_000_000,
      trustProxyHops: 1,
    });
  });

  it('lets an environment variable override the file', () => {
    const c = loadConfig({
      toml,
      env: {
        RELAY_BIND: '[::1]:7000',
        RELAY_TOR_SOCKS: 'tor:9050',
        RELAY_MONERO_NODES: 'http://a.example:18081, http://b.example:18081',
        RELAY_RATE_REQUESTS_PER_MINUTE: '7',
        RELAY_RATE_BYTES_PER_MINUTE: '1000',
        RELAY_DEBUG_LOG: 'true',
        RELAY_ALLOWED_ORIGINS: '*',
      },
    });
    expect(c).toMatchObject({
      bindHost: '::1',
      bindPort: 7000,
      torSocksHost: 'tor',
      moneroNodes: ['http://a.example:18081', 'http://b.example:18081'],
      requestsPerMinute: 7,
      bytesPerMinute: 1000,
      debugLog: true,
      allowedOrigins: ['*'],
      solanaRpcUrl: null,
    });
  });

  it('rejects bad settings', () => {
    const bad: [string, Parameters<typeof loadConfig>[0]][] = [
      ['unknown key', { toml: 'bindd = "x"' }],
      ['unknown rate key', { toml: '[rate_limit]\nper_second = 1' }],
      ['not TOML', { toml: 'bind = ' }],
      ['bind without port', { env: { RELAY_BIND: '127.0.0.1' } }],
      ['bind port range', { env: { RELAY_BIND: '127.0.0.1:70000' } }],
      ['tor_socks', { env: { RELAY_TOR_SOCKS: 'socks5://127.0.0.1:9050' } }],
      ['rpc URL in the file', { toml: 'solana_rpc_url_env = "https://rpc.example/?api-key=secret"' }],
      ['rpc URL scheme', { env: { SOLANA_RPC_URL: 'ftp://x' } }],
      ['program id', { env: { RELAY_PROGRAM_ID: 'not-base58!' } }],
      ['program id length', { env: { RELAY_PROGRAM_ID: '11111111' } }],
      ['monero scheme', { env: { RELAY_MONERO_NODES: 'tcp://node:18081' } }],
      ['monero path', { env: { RELAY_MONERO_NODES: 'http://node:18081/json_rpc' } }],
      ['monero query', { env: { RELAY_MONERO_NODES: 'http://node:18081/?x=1' } }],
      ['monero credentials', { env: { RELAY_MONERO_NODES: 'http://user:pass@node:18081' } }],
      ['monero onion https', { env: { RELAY_MONERO_NODES: `https://${'a'.repeat(56)}.onion:18081` } }],
      ['monero not a list', { toml: 'monero_nodes = 5' }],
      ['rate zero', { env: { RELAY_RATE_REQUESTS_PER_MINUTE: '0' } }],
      ['rate not a number', { env: { RELAY_RATE_BYTES_PER_MINUTE: 'lots' } }],
      ['rate float', { toml: '[rate_limit]\nrequests_per_minute = 1.5' }],
      ['debug', { env: { RELAY_DEBUG_LOG: 'yes please' } }],
      ['origin with path', { env: { RELAY_ALLOWED_ORIGINS: 'https://ui.example/app' } }],
      ['origin', { env: { RELAY_ALLOWED_ORIGINS: 'ui.example' } }],
      ['hops', { env: { RELAY_TRUST_PROXY_HOPS: '-1' } }],
    ];
    for (const [name, opts] of bad) expect(() => loadConfig(opts), name).toThrow(ConfigError);
  });

  it('never echoes the RPC URL in an error', () => {
    try {
      loadConfig({ env: { SOLANA_RPC_URL: 'wss://rpc.example/?api-key=TOPSECRET' } });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('TOPSECRET');
    }
  });

  it('finds relay.toml through RELAY_CONFIG or the working directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
    writeFileSync(join(dir, 'relay.toml'), 'bind = "127.0.0.1:4321"\n');
    writeFileSync(join(dir, 'other.toml'), 'bind = "127.0.0.1:1234"\n');
    expect(loadConfigFromProcess({}, dir).bindPort).toBe(4321);
    expect(loadConfigFromProcess({ RELAY_CONFIG: join(dir, 'other.toml') }, dir).bindPort).toBe(1234);
    expect(loadConfigFromProcess({}, join(dir, 'missing')).bindPort).toBe(8787);
    expect(() => loadConfigFromProcess({ RELAY_CONFIG: join(dir, 'nope.toml') }, dir)).toThrow(ConfigError);
  });

  it('knows a loopback address', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) expect(isLoopback(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com']) expect(isLoopback(h)).toBe(false);
  });
});
