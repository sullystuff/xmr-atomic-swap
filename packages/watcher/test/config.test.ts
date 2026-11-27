// Settings: TOML and environment, loopback unless allowed on purpose, secrets by variable name
// only, the Monero node policy, and an example file that documents every key.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = readFileSync(path.join(here, '../watcher.example.toml'), 'utf8');
const PROGRAM = 'XMRsw4p111111111111111111111111111111111111';
const ENV = { SOLANA_RPC_URL: 'https://rpc.example/?api-key=SECRET', ETHEREUM_RPC_URL: 'https://eth.example/v2/SECRET' };
const minimal = `
[monero]
nodes = ["http://127.0.0.1:18081", "http://127.0.0.1:18082"]
[solana]
program_id = "${PROGRAM}"
`;
const err = (toml: string, env: Record<string, string> = ENV): string => {
  try {
    loadConfig({ toml, env });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  return 'accepted';
};

describe('configuration', () => {
  it('the example file loads once its placeholders are filled, and every value it shows is the default', () => {
    const filled = example.replace('"<program id>"', `"${PROGRAM}"`).replace('"<contract address>"', '"0x00000000000000000000000000000000000C0de1"');
    const c = loadConfig({ toml: filled, env: ENV, baseDir: '/etc/watcher' });
    expect(c).toMatchObject({
      bindHost: '127.0.0.1', bindPort: 8790, allowNonLoopback: false, trustProxyHops: 0, dataDir: '/etc/watcher/watcher-data', passphraseEnv: 'WATCHER_PASSPHRASE', network: 'mainnet',
      pollSecs: DEFAULTS.pollSecs, maxSwaps: DEFAULTS.maxSwaps, maxKeysPerSwap: DEFAULTS.maxKeysPerSwap, retentionDays: DEFAULTS.retentionDays, stopConfirmations: DEFAULTS.stopConfirmations,
      minLeadSecs: DEFAULTS.minLeadSecs, attemptTimeoutSecs: DEFAULTS.attemptTimeoutSecs, requestsPerMinute: 60, registrationsPerMinute: 10, maxBodyBytes: 1024, debugLog: false, ownNode: false,
      moneroNodes: ['http://127.0.0.1:18081', 'https://node.example.org:18089'],
    });
    expect(c.solana).toEqual({ rpcUrl: ENV.SOLANA_RPC_URL, programId: PROGRAM, genesisHash: null, commitment: 'finalized', priorityFeeMicroLamports: 0n, maxComputeUnits: 200_000, perSwapLimit: 100_000n, perDayLimit: 5_000_000n });
    expect(c.ethereum).toEqual({ rpcUrl: ENV.ETHEREUM_RPC_URL, contract: '0x00000000000000000000000000000000000c0de1', chainId: 1, readTag: 'finalized', maxFeePerGas: 100_000_000_000n, priorityFeePerGas: 1_000_000_000n, perSwapLimit: 30_000_000_000_000_000n, perDayLimit: 300_000_000_000_000_000n });
    // The defaults in the code are the ones the example shows.
    const bare = loadConfig({ toml: `${minimal}\n[ethereum]\ncontract = "0x00000000000000000000000000000000000C0de1"\nchain_id = 1\n`, env: ENV, baseDir: '/etc/watcher' });
    expect({ ...bare, moneroNodes: c.moneroNodes }).toEqual(c);
  });

  it('the example documents every key the loader accepts, and the loader accepts no key it does not document', async () => {
    const src = readFileSync(path.join(here, '../src/config.ts'), 'utf8');
    const top = /const TOP_KEYS = \[([^\]]+)\]/.exec(src)![1]!.match(/'([a-z_]+)'/g)!.map((k) => k.slice(1, -1));
    const tables = [...src.matchAll(/^  (margins|monero|rate_limit|solana|ethereum): \[([^\]]+)\]/gm)].map((mm) => [mm[1]!, mm[2]!.match(/'([a-z_]+)'/g)!.map((k) => k.slice(1, -1))] as const);
    expect(tables.length).toBe(5);
    for (const k of top) expect(example, k).toMatch(new RegExp(`^(\\[${k}\\]|${k} = )`, 'm'));
    for (const [t, keys] of tables) {
      const body = example.slice(example.indexOf(`\n[${t}]\n`));
      for (const k of keys) expect(body, `${t}.${k}`).toMatch(new RegExp(`^${k} = `, 'm'));
    }
    expect(err(`bogus = 1\n${minimal}`)).toMatch(/unknown key "bogus"/);
    expect(err(`${minimal}\npriority = 1`)).toMatch(/unknown key "solana.priority"/);
    expect(err('not toml [')).toMatch(/^watcher\.toml: /);
  });

  it('binds to loopback by default and refuses any other address unless allowed on purpose', () => {
    expect(loadConfig({ toml: minimal, env: ENV })).toMatchObject({ bindHost: '127.0.0.1', bindPort: 8790 });
    for (const bind of ['0.0.0.0:8790', '192.168.1.5:8790', '[::]:8790', 'watcher.example.org:443']) {
      expect(err(`bind = "${bind}"\n${minimal}`), bind).toMatch(/is not a loopback address/);
      expect(err(minimal, { ...ENV, WATCHER_BIND: bind }), bind).toMatch(/is not a loopback address/);
    }
    for (const bind of ['127.0.0.1:1', 'localhost:9000', '[::1]:8790', '127.8.9.10:80']) expect(loadConfig({ toml: `bind = "${bind}"\n${minimal}`, env: ENV }).bindPort).toBeGreaterThan(0);
    expect(loadConfig({ toml: `bind = "0.0.0.0:8790"\nallow_non_loopback = true\n${minimal}`, env: ENV })).toMatchObject({ bindHost: '0.0.0.0', allowNonLoopback: true });
    expect(err(`bind = "127.0.0.1"\n${minimal}`)).toMatch(/expected host:port/);
  });

  it('takes RPC URLs and the passphrase by environment variable name only, and never echoes a URL', () => {
    expect(err(minimal.replace('program_id', 'rpc_url_env = "https://rpc.example/?api-key=SECRET"\nprogram_id'))).toMatch(/expected the NAME of an environment variable/);
    expect(err(`passphrase_env = "hunter2 is my passphrase"\n${minimal}`)).toMatch(/expected the NAME of an environment variable, not the passphrase/);
    expect(err(minimal, {})).toBe('solana: the environment variable SOLANA_RPC_URL (the RPC URL) is not set');
    const bad = err(minimal, { SOLANA_RPC_URL: 'ftp://user:SECRET@rpc.example' });
    expect(bad).toBe('SOLANA_RPC_URL: expected an http or https URL');
    expect(err(minimal.replace('[solana]', '[solana]\nrpc_url_env = "MY_RPC"'), { MY_RPC: 'http://127.0.0.1:8899' })).toBe('accepted');
  });

  it('enforces the Monero node policy: two or more nodes, or one declared own', () => {
    const sol = `[solana]\nprogram_id = "${PROGRAM}"`;
    expect(err(sol)).toMatch(/at least one Monero node is required/);
    expect(err(`[monero]\nnodes = ["http://127.0.0.1:18081"]\n${sol}`)).toMatch(/two or more independently operated nodes, or one node with own_node = true/);
    expect(err(`[monero]\nnodes = ["http://127.0.0.1:18081"]\nown_node = true\n${sol}`)).toBe('accepted');
    expect(err(`[monero]\nnodes = ["http://a:1", "http://b:1"]\nown_node = true\n${sol}`)).toMatch(/applies to exactly one node/);
    expect(err(`[monero]\nnodes = ["http://a:1", "http://a:1/"]\n${sol}`)).toMatch(/listed twice/);
    expect(err(`[monero]\nnodes = ["http://user:pw@a:1", "http://b:1"]\n${sol}`)).toMatch(/credentials/);
    expect(err(`[monero]\nnodes = ["http://a:1/json_rpc", "http://b:1"]\n${sol}`)).toMatch(/must not have a path/);
    expect(loadConfig({ toml: sol, env: { ...ENV, WATCHER_MONERO_NODES: 'http://a:1, http://b:2' } }).moneroNodes).toEqual(['http://a:1', 'http://b:2']);
  });

  it('needs at least one chain, a pinned program or contract, and a chain id; validates margins and limits', () => {
    const mon = '[monero]\nnodes = ["http://a:1", "http://b:1"]';
    expect(err(mon)).toMatch(/no chain is configured/);
    expect(err(`${mon}\n[solana]\nprogram_id = "nope"`)).toMatch(/expected a base58 Solana address/);
    expect(err(`${mon}\n[solana]\nprogram_id = "${PROGRAM}"\ngenesis_hash = "x"`)).toMatch(/genesis_hash/);
    expect(err(`${mon}\n[ethereum]\ncontract = "0x00000000000000000000000000000000000C0de1"`)).toMatch(/chain_id: required/);
    expect(err(`${mon}\n[ethereum]\ncontract = "0x0000000000000000000000000000000000000000"\nchain_id = 1`)).toMatch(/expected a 0x address/);
    expect(err(`${mon}\n[ethereum]\ncontract = "0x00000000000000000000000000000000000C0de1"\nchain_id = 1\npriority_fee_gwei = 200`)).toMatch(/above max_fee_per_gas_gwei/);
    expect(err(`${minimal}\ncommitment = "processed"`)).toMatch(/expected one of finalized, confirmed/);
    expect(err(`${minimal}\nper_swap_limit_lamports = -1`)).toMatch(/non-negative integer/);
    expect(err(`poll_secs = 0\n${minimal}`)).toMatch(/poll_secs/);
    expect(err(`max_swaps = "many"\n${minimal}`)).toMatch(/max_swaps/);
    expect(err(`${minimal}\n[margins]\nattempt_timeout_secs = 5`)).toMatch(/attempt_timeout_secs/);
    expect(err(`${minimal}\n[rate_limit]\nmax_body_bytes = 10`)).toMatch(/max_body_bytes/);
    const c = loadConfig({ toml: `retention_days = 0\n${minimal}\n[margins]\nmin_lead_secs = 600`, env: { ...ENV, WATCHER_MAX_SWAPS: '7', WATCHER_DEBUG_LOG: 'true' } });
    expect(c).toMatchObject({ retentionDays: 0, minLeadSecs: 600, maxSwaps: 7, debugLog: true, ethereum: null });
  });
});
