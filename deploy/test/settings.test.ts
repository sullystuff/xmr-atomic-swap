/**
 * The settings reference cannot drift: the documented settings are held to the real ones in
 * three directions. (1) The bundle's list against the relay's own keys and environment names,
 * read from the relay's source and example file. (2) The page-settings list against the page's
 * real `DEFAULT_SETTINGS`. (3) The published text (docs page and example file) against the list.
 * A setting that exists in code but not in the docs, or the reverse, fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTRACT_ADDRESS, PROGRAM_ID } from '@xmrswap/protocol';
import { ConfigError, loadConfig as loadRelayConfig } from '@xmrswap/relay';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { pageConfig } from '../src/server.js';
import { DOCS_BEGIN, DOCS_END, OTHER_ENV, PAGE_SETTINGS, SETTINGS, SETTINGS_FILE_ENV, exampleToml, generatedDocs, loadSettings, loadSettingsFromProcess } from '../src/settings.js';

const repo = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(repo(rel), 'utf8');
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** A valid, non-default value for every setting: as TOML source and as an environment string. */
const SAMPLES: Record<string, { toml: string; env: string }> = {
  'ui.listen': { toml: '"127.0.0.1:9999"', env: '127.0.0.1:9999' },
  'ui.dist': { toml: '"/srv/ui"', env: '/srv/ui' },
  'ui.public_origin': { toml: '"https://swap.example.org"', env: 'https://swap.example.org' },
  'ui.ethereum_rpc_url_env': { toml: '"MY_ETH_URL"', env: 'MY_ETH_URL' },
  'ui.ethereum_chain_id': { toml: '11155111', env: '11155111' },
  'ui.contract_address': { toml: `"0x${'12'.repeat(20)}"`, env: `0x${'12'.repeat(20)}` },
  'ui.monero_network': { toml: '"stagenet"', env: 'stagenet' },
  'ui.own_node': { toml: 'true', env: 'true' },
  'relay.bind': { toml: '"127.0.0.1:9998"', env: '127.0.0.1:9998' },
  'relay.tor_socks': { toml: '"127.0.0.1:9150"', env: '127.0.0.1:9150' },
  'relay.solana_rpc_url_env': { toml: '"MY_SOL_URL"', env: 'MY_SOL_URL' },
  'relay.program_id': { toml: '"11111111111111111111111111111111"', env: '11111111111111111111111111111111' },
  'relay.monero_nodes': { toml: '["http://127.0.0.1:18081"]', env: 'http://127.0.0.1:18081' },
  'relay.monero_max_response_bytes': { toml: '1024', env: '1024' },
  'relay.allowed_origins': { toml: '["https://swap.example.org"]', env: 'https://swap.example.org' },
  'relay.trust_proxy_hops': { toml: '2', env: '2' },
  'relay.debug_log': { toml: 'true', env: 'true' },
  'relay.rate_limit.requests_per_minute': { toml: '7', env: '7' },
  'relay.rate_limit.bytes_per_minute': { toml: '4096', env: '4096' },
};
/** Variables the sample values refer to; `own_node = true` needs exactly one node. */
const BASE_ENV = { MY_ETH_URL: 'http://127.0.0.1:1/eth', MY_SOL_URL: 'http://127.0.0.1:1/sol' };
const name = (s: { table: string; key: string }): string => `${s.table}.${s.key}`;
const withNode = (s: { table: string; key: string }): string => (name(s) === 'ui.own_node' ? '[relay]\nmonero_nodes = ["http://127.0.0.1:18081"]\n' : '');

describe('the bundle settings against the relay', () => {
  const relaySrc = read('packages/relay/src/config.ts');
  const listOf = (constName: string): string[] => {
    const m = new RegExp(`const ${constName} = \\[([^\\]]+)\\]`).exec(relaySrc);
    if (!m) throw new Error(`${constName} not found in the relay's config.ts`);
    return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  };
  const relayKeys = [...listOf('TOP_KEYS').filter((k) => k !== 'rate_limit').map((k) => `relay.${k}`), ...listOf('RATE_KEYS').map((k) => `relay.rate_limit.${k}`)];
  const documentedRelay = SETTINGS.filter((s) => s.table !== 'ui');

  it('documents every key the relay accepts, and no key it does not', () => {
    expect(relayKeys.length).toBeGreaterThanOrEqual(11);
    expect(sorted(documentedRelay.map(name))).toEqual(sorted(relayKeys));
  });

  it('agrees with the relay example file on the key set', () => {
    const example = read('packages/relay/relay.example.toml');
    let table = 'relay';
    const keys: string[] = [];
    for (const line of example.split('\n')) {
      const t = /^\[([a-z_]+)\]$/.exec(line);
      if (t) table = `relay.${t[1]}`;
      const k = /^(?:# )?([a-z_]+) = /.exec(line);
      if (k) keys.push(`${table}.${k[1]}`);
    }
    expect(sorted(keys)).toEqual(sorted(documentedRelay.map(name)));
  });

  it('documents every RELAY_* variable the relay reads, and no other', () => {
    const inCode = new Set([...relaySrc.matchAll(/'(RELAY_[A-Z_]+)'/g)].map((m) => m[1]!));
    // RELAY_CONFIG names the relay's own file; the bundle has one file of its own instead.
    expect(inCode.delete('RELAY_CONFIG')).toBe(true);
    expect(sorted(documentedRelay.map((s) => s.env))).toEqual(sorted(inCode));
  });

  it('the relay itself accepts every documented relay key and refuses an undocumented one', () => {
    for (const s of documentedRelay) {
      const toml = s.table === 'relay' ? `${s.key} = ${SAMPLES[name(s)]!.toml}` : `[rate_limit]\n${s.key} = ${SAMPLES[name(s)]!.toml}`;
      expect(() => loadRelayConfig({ toml, env: BASE_ENV }), name(s)).not.toThrow();
    }
    expect(() => loadRelayConfig({ toml: 'not_a_setting = 1' })).toThrow(ConfigError);
    expect(() => loadSettings({ toml: '[relay]\nnot_a_setting = 1' })).toThrow(/unknown key "not_a_setting"/);
    expect(() => loadSettings({ toml: '[relay.rate_limit]\nnot_a_setting = 1' })).toThrow(/unknown key "rate_limit.not_a_setting"/);
    expect(() => loadSettings({ toml: '[ui]\nnot_a_setting = 1' })).toThrow(/unknown key "ui.not_a_setting"/);
    expect(() => loadSettings({ toml: '[other]\nx = 1' })).toThrow(/unknown table or key "other"/);
  });

  it('has the defaults the relay has, plus the pinned program id', () => {
    const relayDefaults = loadRelayConfig();
    const bundle = loadSettings().relay;
    // The deliberate differences, each documented in the reference: the release's program id is
    // filled in, the UI server counts as one proxy hop, and the per-client limits are sized for
    // one user whose page reaches its Monero nodes through the relay (deploy/DEVIATIONS.md D3).
    expect(bundle).toEqual({ ...relayDefaults, programId: PROGRAM_ID, trustProxyHops: 1, requestsPerMinute: 6000, bytesPerMinute: 1024 * 1024 * 1024 });
    expect(relayDefaults.requestsPerMinute).toBe(60);
    expect(relayDefaults.bytesPerMinute).toBe(4 * 1024 * 1024);
    // The defaults DESIGN proposes.
    expect(`${bundle.bindHost}:${bundle.bindPort}`).toBe('127.0.0.1:8787');
    expect(`${bundle.torSocksHost}:${bundle.torSocksPort}`).toBe('127.0.0.1:9050');
    expect(bundle.solanaRpcUrl).toBeNull();
    expect(bundle.moneroNodes).toEqual([]);
    expect(bundle.allowedOrigins).toEqual([]);
    expect(bundle.debugLog).toBe(false);
    const ui = loadSettings().ui;
    expect(ui.listenHost).toBe('127.0.0.1');
    expect(ui.contractAddress).toBe(CONTRACT_ADDRESS ?? '');
    // The documented default of each relay key is the one in the relay's example file.
    const example = parseToml(read('packages/relay/relay.example.toml')) as Record<string, unknown>;
    for (const s of documentedRelay.filter((d) => d.table === 'relay')) {
      if (example[s.key] !== undefined) expect(parseToml(`v = ${s.defaultToml}`)['v'], name(s)).toEqual(example[s.key]);
    }
    // Where the bundle's default differs from the relay's, the reference says what the relay's is.
    const relayRate = example['rate_limit'] as Record<string, number>;
    for (const s of documentedRelay.filter((d) => d.table === 'relay.rate_limit')) expect(s.defaultNote, name(s)).toContain(`the relay's own default is ${relayRate[s.key]}`);
  });
});

describe('every documented setting is real', () => {
  const defaults = loadSettings({ env: BASE_ENV });

  it('has a sample for every setting and no stray sample', () => {
    expect(sorted(Object.keys(SAMPLES))).toEqual(sorted(SETTINGS.map(name)));
    expect(new Set(SETTINGS.map((s) => s.env)).size).toBe(SETTINGS.length);
  });

  it('each key in the file changes the loaded settings', () => {
    for (const s of SETTINGS) {
      const toml = `${withNode(s)}[${s.table}]\n${s.key} = ${SAMPLES[name(s)]!.toml}\n`;
      const base = withNode(s) ? loadSettings({ env: BASE_ENV, toml: withNode(s) }) : defaults;
      expect(loadSettings({ env: BASE_ENV, toml }), name(s)).not.toEqual(base);
    }
  });

  it('each environment variable changes the loaded settings and wins over the file', () => {
    for (const s of SETTINGS) {
      const sample = SAMPLES[name(s)]!;
      const base = withNode(s) ? loadSettings({ env: BASE_ENV, toml: withNode(s) }) : defaults;
      const fromEnv = loadSettings({ env: { ...BASE_ENV, [s.env]: sample.env }, ...(withNode(s) ? { toml: withNode(s) } : {}) });
      expect(fromEnv, s.env).not.toEqual(base);
      // The same value from the file gives the same settings; the default in the file loses to the variable.
      expect(loadSettings({ env: BASE_ENV, toml: `${withNode(s)}[${s.table}]\n${s.key} = ${sample.toml}\n` }), s.env).toEqual(fromEnv);
      expect(loadSettings({ env: { ...BASE_ENV, [s.env]: sample.env }, toml: `${withNode(s)}[${s.table}]\n${s.key} = ${s.defaultToml}\n` }), s.env).toEqual(fromEnv);
    }
  });

  it('reads the RPC URLs only from the named environment variables', () => {
    const s = loadSettings({ env: { SOLANA_RPC_URL: 'https://sol.example/?k=1', ETHEREUM_RPC_URL: 'https://eth.example/k' } });
    expect(s.relay.solanaRpcUrl).toBe('https://sol.example/?k=1');
    expect(s.ui.ethereumRpcUrl).toBe('https://eth.example/k');
    expect(() => loadSettings({ env: { ETHEREUM_RPC_URL: 'ftp://x' } })).toThrow(/ETHEREUM_RPC_URL: expected an http or https URL/);
    expect(sorted(OTHER_ENV.map((e) => e.env))).toEqual(sorted([SETTINGS_FILE_ENV, 'SOLANA_RPC_URL', 'ETHEREUM_RPC_URL']));
  });

  it('finds the file through XMRSWAP_SELFHOST_CONFIG or as ./xmrswap.toml, and ignores RELAY_CONFIG', () => {
    const example = repo('deploy/xmrswap.example.toml');
    expect(loadSettingsFromProcess({ XMRSWAP_SELFHOST_CONFIG: example }, '/').file).toBe(example);
    expect(loadSettingsFromProcess({}, '/').file).toBeNull();
    expect(loadSettingsFromProcess({ RELAY_CONFIG: '/nonexistent/relay.toml' }, '/').file).toBeNull();
    expect(() => loadSettingsFromProcess({ XMRSWAP_SELFHOST_CONFIG: '/nonexistent/x.toml' }, '/')).toThrow(ConfigError);
  });

  it('refuses combinations that cannot work', () => {
    expect(() => loadSettings({ toml: '[ui]\nown_node = true' })).toThrow(/exactly one entry/);
    expect(() => loadSettings({ toml: '[ui]\nlisten = "127.0.0.1:8787"' })).toThrow(/must be different/);
    expect(() => loadSettings({ toml: '[ui]\npublic_origin = "https://swap.example.org/path"' })).toThrow(/bare origin/);
    expect(() => loadSettings({ toml: '[ui]\nmonero_network = "mainet"' })).toThrow(/expected one of/);
    expect(() => loadSettings({ toml: '[ui]\ncontract_address = "0x12"' })).toThrow(/40 hex digits/);
    expect(() => loadSettings({ toml: '[relay]\nmonero_nodes = ["http://user:pw@node.example:18081"]' })).toThrow(/credentials/);
  });
});

describe('the page settings against the web UI', () => {
  it('lists every setting of the page with its real default, and no other', async () => {
    // The page's own source of truth (not a package export, so it is loaded by path).
    const web = (await import(/* @vite-ignore */ repo('apps/web/src/lib/settings.ts'))) as { DEFAULT_SETTINGS: Record<string, unknown> };
    expect(PAGE_SETTINGS.map((s) => s.key)).toEqual(Object.keys(web.DEFAULT_SETTINGS));
    for (const s of PAGE_SETTINGS) expect(JSON.parse(s.defaultJson), s.key).toEqual(web.DEFAULT_SETTINGS[s.key]);
  });

  it('says exactly which page settings the bundle supplies', () => {
    const cfg = pageConfig(loadSettings({ env: { SOLANA_RPC_URL: 'http://127.0.0.1:1/', ETHEREUM_RPC_URL: 'http://127.0.0.1:2/' } }), 'http://127.0.0.1:8780');
    expect(sorted(Object.keys(cfg))).toEqual(sorted(PAGE_SETTINGS.filter((s) => s.bundle !== null).map((s) => s.key)));
  });
});

describe('the published text', () => {
  it('the configuration reference holds the generated tables, unchanged', () => {
    const page = read('docs/self-hosting/configuration.md');
    const begin = page.indexOf(DOCS_BEGIN);
    const end = page.indexOf(DOCS_END);
    expect(begin).toBeGreaterThan(0);
    expect(page.slice(begin, end + DOCS_END.length)).toBe(generatedDocs());
    // Belt and braces: every key, variable and default is literally on the page.
    for (const s of SETTINGS) {
      expect(page, name(s)).toContain(`\`[${s.table}] ${s.key}\``);
      expect(page, s.env).toContain(`\`${s.env}\``);
      expect(page, name(s)).toContain(`\`${s.defaultToml}\``);
    }
    for (const s of PAGE_SETTINGS) expect(page, s.key).toContain(`| \`${s.key}\` |`);
    // And the page documents nothing that is not a setting.
    const documented = [...page.matchAll(/^\| `\[([a-z_.]+)\] ([a-z_]+)` \|/gm)].map((m) => `${m[1]}.${m[2]}`);
    expect(sorted(documented)).toEqual(sorted(SETTINGS.map(name)));
    const documentedPage = [...page.slice(page.indexOf('## Settings in the browser')).matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]!);
    expect(documentedPage).toEqual(PAGE_SETTINGS.map((s) => s.key));
  });

  it('the example file is the generated one, lists every setting, and loads to the defaults', () => {
    const example = read('deploy/xmrswap.example.toml');
    expect(example).toBe(exampleToml());
    const doc = parseToml(example) as { ui: Record<string, unknown>; relay: Record<string, unknown> & { rate_limit: Record<string, unknown> } };
    const keys = [...Object.keys(doc.ui).map((k) => `ui.${k}`), ...Object.keys(doc.relay).filter((k) => k !== 'rate_limit').map((k) => `relay.${k}`), ...Object.keys(doc.relay.rate_limit).map((k) => `relay.rate_limit.${k}`)];
    expect(sorted(keys)).toEqual(sorted(SETTINGS.map(name)));
    expect(loadSettings({ toml: example })).toEqual(loadSettings());
  });
});
