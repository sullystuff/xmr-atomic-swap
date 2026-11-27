/**
 * The bundle's single settings file (SPEC 8.8, DESIGN "Self-hosting the web UI").
 *
 * `xmrswap.toml` has two tables:
 *  - `[ui]`: the static server and the defaults handed to the page (`config.json`);
 *  - `[relay]`: exactly the keys of the relay's own `relay.toml` (SPEC 6.5), passed to the
 *    relay's loader unchanged, so the relay's validation and `RELAY_*` overrides apply as is.
 *
 * `SETTINGS` below is the one list the example file, the documentation table and the loader are
 * all built from; a test holds it to the relay's real keys and the page's real settings.
 * Secrets never go in the file: RPC URLs are read from environment variables named here.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_ADDRESS, CONTRACT_CHAIN_ID, PROGRAM_ID } from '@xmrswap/protocol';
import { ConfigError, type RelayConfig, isLoopback, loadConfig as loadRelayConfig } from '@xmrswap/relay';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export { ConfigError };

/** `deploy/`: relative paths in the settings resolve against it. */
export const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS_FILE_ENV = 'XMRSWAP_SELFHOST_CONFIG';
export const DEFAULT_SETTINGS_FILE = 'xmrswap.toml';

export type MoneroNetwork = 'mainnet' | 'stagenet' | 'testnet' | 'regtest';
const NETWORKS: readonly MoneroNetwork[] = ['mainnet', 'stagenet', 'testnet', 'regtest'];

export interface SettingDef {
  /** TOML table: `ui`, `relay` or `relay.rate_limit`. */
  table: 'ui' | 'relay' | 'relay.rate_limit';
  key: string;
  /** Environment variable that overrides the file. */
  env: string;
  /** The default as TOML source text. */
  defaultToml: string;
  /** The default in words, when the TOML text alone would mislead. */
  defaultNote?: string;
  /** True when the example file shows the key commented out (no fixed default to print). */
  commented?: boolean;
  /** What the setting does, in plain words. One paragraph; used in the file and the docs. */
  effect: string;
}

/**
 * Per-client limits when the file sets none. The relay's own defaults (60 requests and 4 MiB a
 * minute) are sized for strangers using a public relay for messages. Here the one client is the
 * user's own page, which also reaches its Monero nodes through the relay: a lock check is three
 * or more node calls per node every few seconds, and a sweep moves megabytes.
 */
export const LOCAL_RATE_LIMIT = { requests_per_minute: 6000, bytes_per_minute: 1024 * 1024 * 1024 } as const;

/** Every setting of the bundle, in file order. */
export const SETTINGS: readonly SettingDef[] = [
  {
    table: 'ui',
    key: 'listen',
    env: 'XMRSWAP_UI_LISTEN',
    defaultToml: '"127.0.0.1:8780"',
    effect:
      'Address the web UI is served on. This is the address you open in the browser. The same server passes /relay/ and /monero/ on to the relay, so the page and the relay share one origin. Keep it on 127.0.0.1 unless you have read the page on exposing the relay publicly.',
  },
  {
    table: 'ui',
    key: 'dist',
    env: 'XMRSWAP_UI_DIST',
    defaultToml: '"../apps/web/dist"',
    effect: 'Directory holding the built web UI (index.html and assets). A relative path is taken from the deploy/ directory. Point it at an unpacked release after you have verified its checksums.',
  },
  {
    table: 'ui',
    key: 'releases',
    env: 'XMRSWAP_UI_RELEASES',
    defaultToml: '"../releases"',
    effect:
      'Directory of recorded builds: one sub-directory per version, each holding a release.json. At start the bundle hashes the UI it is about to serve and looks there for a record with the same tree hash. The result is served at /release.json and shown by the status command. A relative path is taken from the deploy/ directory.',
  },
  {
    table: 'ui',
    key: 'public_origin',
    env: 'XMRSWAP_UI_PUBLIC_ORIGIN',
    defaultToml: '""',
    defaultNote: 'empty: the origin is http:// followed by `listen`',
    effect:
      'The origin the browser uses to reach the UI, for example "https://swap.example.org", when that differs from `listen` (a reverse proxy or a container port mapping). The server answers only requests whose Host header matches `listen` or this origin, and the Monero proxy addresses given to the page are built from it.',
  },
  {
    table: 'ui',
    key: 'give_page_rpc_urls',
    env: 'XMRSWAP_UI_GIVE_PAGE_RPC_URLS',
    defaultToml: 'true',
    effect:
      'When true, the page is given the Solana and Ethereum RPC URLs from your environment as its starting values, so you do not have to type them. Anyone who can load the page can read them, including any API key in them. On your own machine that is only you. Set it to false if other people can load the page; each visitor then enters an RPC URL on the Settings page.',
  },
  {
    table: 'ui',
    key: 'ethereum_rpc_url_env',
    env: 'XMRSWAP_UI_ETHEREUM_RPC_URL_ENV',
    defaultToml: '"ETHEREUM_RPC_URL"',
    effect:
      'NAME of the environment variable holding the Ethereum RPC URL given to the page. If the variable is not set, the ETH and USDC-on-Ethereum markets are switched off. The URL itself never goes in this file, because provider URLs usually contain an API key.',
  },
  {
    table: 'ui',
    key: 'ethereum_chain_id',
    env: 'XMRSWAP_UI_ETHEREUM_CHAIN_ID',
    defaultToml: String(CONTRACT_CHAIN_ID ?? 1),
    defaultNote: 'pinned by the release; 1 while no contract is deployed',
    effect: 'Chain id the Ethereum RPC must report. The page refuses an RPC that reports another chain.',
  },
  {
    table: 'ui',
    key: 'contract_address',
    env: 'XMRSWAP_UI_CONTRACT_ADDRESS',
    defaultToml: JSON.stringify(CONTRACT_ADDRESS ?? ''),
    defaultNote: 'pinned by the release; empty while no contract is deployed',
    effect: 'Ethereum contract address given to the page. Leave it alone unless you are testing: it must equal the published address, and the page shows it for checking.',
  },
  {
    table: 'ui',
    key: 'monero_network',
    env: 'XMRSWAP_UI_MONERO_NETWORK',
    defaultToml: '"mainnet"',
    effect: 'Monero network the page expects its nodes to be on: "mainnet", "stagenet", "testnet" or "regtest".',
  },
  {
    table: 'ui',
    key: 'own_node',
    env: 'XMRSWAP_UI_OWN_NODE',
    defaultToml: 'false',
    effect:
      'Set to true only if `monero_nodes` lists exactly one node and you run that node yourself. With false, the page needs two or more nodes and refuses to count a lock as confirmed unless they agree.',
  },
  {
    table: 'ui',
    key: 'poll_ms',
    env: 'XMRSWAP_UI_POLL_MS',
    defaultToml: '4000',
    effect:
      'How often the page re-reads chain state, in milliseconds (1000 to 60000). Raise it if your Solana RPC provider rate-limits you. A slower page notices the maker\'s steps later, so do not raise it far.',
  },
  {
    table: 'relay',
    key: 'bind',
    env: 'RELAY_BIND',
    defaultToml: '"127.0.0.1:8787"',
    effect: 'Address the relay itself listens on. The browser never calls it directly; the UI server passes requests on to it. Localhost only unless changed on purpose.',
  },
  {
    table: 'relay',
    key: 'tor_socks',
    env: 'RELAY_TOR_SOCKS',
    defaultToml: '"127.0.0.1:9050"',
    effect: "Address of the Tor client's SOCKS5 proxy. 9050 is Tor's standard port; Tor Browser uses 9150. The bundle does not start Tor: it only connects to this address. Onion names are resolved by Tor, never by the relay.",
  },
  {
    table: 'relay',
    key: 'solana_rpc_url_env',
    env: 'RELAY_SOLANA_RPC_URL_ENV',
    defaultToml: '"SOLANA_RPC_URL"',
    effect:
      'NAME of the environment variable holding the Solana RPC URL. The relay reads the list of makers through it and the page uses it for everything on Solana. There is no default URL: whoever runs the endpoint sees your queries and transactions. Without it the relay forwards nothing and you must type an RPC URL into the Settings page.',
  },
  {
    table: 'relay',
    key: 'program_id',
    env: 'RELAY_PROGRAM_ID',
    defaultToml: JSON.stringify(PROGRAM_ID),
    defaultNote: 'pinned by the release',
    effect: 'The Solana swap program. The relay forwards only to makers registered in it, and the page uses it for every swap. Leave it alone unless you are testing: it must equal the published program id.',
  },
  {
    table: 'relay',
    key: 'monero_nodes',
    env: 'RELAY_MONERO_NODES',
    defaultToml: '[]',
    defaultNote: 'none; must be set',
    effect:
      'Monero nodes, as http(s)://host[:port] with no path. The relay serves the n-th one at /monero/<n>/ (counting from 0) and the page is told to use those addresses, so the browser can reach plain-http and .onion nodes. Use your own node, or at least two nodes run by different people. A .onion node is reached through Tor. The environment variable takes a comma-separated list.',
  },
  {
    table: 'relay',
    key: 'monero_max_response_bytes',
    env: 'RELAY_MONERO_MAX_RESPONSE_BYTES',
    defaultToml: '16777216',
    defaultNote: '16 MiB',
    effect: 'Largest Monero node response the proxy will carry. A larger response is refused with `upstream_too_large`.',
  },
  {
    table: 'relay',
    key: 'allowed_origins',
    env: 'RELAY_ALLOWED_ORIGINS',
    defaultToml: '[]',
    defaultNote: 'none: same-origin only',
    effect:
      'Other web origins allowed to call the relay from a browser. Not needed with this bundle, because the page and the relay share one origin. Never use "*" on your own machine: any web page you visit could then use your relay and your Monero nodes.',
  },
  {
    table: 'relay',
    key: 'trust_proxy_hops',
    env: 'RELAY_TRUST_PROXY_HOPS',
    defaultToml: '0',
    effect:
      'Number of reverse proxies you have put in front of the UI server, whose X-Forwarded-For header is trusted when counting requests per client address. 0 means none. The UI server itself is counted automatically; do not add 1 for it.',
  },
  {
    table: 'relay',
    key: 'debug_log',
    env: 'RELAY_DEBUG_LOG',
    defaultToml: 'false',
    effect: 'When true the relay logs, for every forwarded request, the client address and the onion address it contacted, and prints a warning at start. Message bodies are never logged. Leave it off.',
  },
  {
    table: 'relay.rate_limit',
    key: 'requests_per_minute',
    env: 'RELAY_RATE_REQUESTS_PER_MINUTE',
    defaultToml: String(LOCAL_RATE_LIMIT.requests_per_minute),
    defaultNote: "this bundle's default for one user on localhost; the relay's own default is 60",
    effect:
      'Requests one client address may make per minute, counting messages and Monero node calls together. Beyond it the relay answers 429 `rate_limited` until the minute ends. The page checks every lock against every Monero node every few seconds through this relay, which needs far more than a public relay allows a stranger; lower it before exposing the relay publicly.',
  },
  {
    table: 'relay.rate_limit',
    key: 'bytes_per_minute',
    env: 'RELAY_RATE_BYTES_PER_MINUTE',
    defaultToml: String(LOCAL_RATE_LIMIT.bytes_per_minute),
    defaultNote: "1 GiB; this bundle's default for one user on localhost; the relay's own default is 4194304 (4 MiB)",
    effect: 'Bytes (requests and relayed responses together) one client address may move per minute. The final XMR sweep downloads several megabytes from the Monero node in one go. Lower it before exposing the relay publicly.',
  },
];

export interface UiSettings {
  listenHost: string;
  listenPort: number;
  /** Absolute path of the built UI. */
  dist: string;
  /** Absolute path of the directory of recorded builds. */
  releases: string;
  /** Empty = derived from the request's Host. */
  publicOrigin: string;
  /** Whether `config.json` carries the RPC URLs. */
  givePageRpcUrls: boolean;
  /** Read from the environment variable named by `ethereum_rpc_url_env`; `null` = not set. */
  ethereumRpcUrl: string | null;
  ethereumChainId: number;
  contractAddress: string;
  moneroNetwork: MoneroNetwork;
  ownNode: boolean;
  pollMs: number;
}

export interface BundleSettings {
  ui: UiSettings;
  /** What the relay is started with. `trustProxyHops` already counts the UI server. */
  relay: RelayConfig;
  /** The file the settings were read from, or `null` when only defaults and the environment were used. */
  file: string | null;
}

type Env = Record<string, string | undefined>;

const UI_KEYS = SETTINGS.filter((s) => s.table === 'ui').map((s) => s.key);

function hostPort(value: unknown, what: string): { host: string; port: number } {
  const m = typeof value === 'string' ? /^(\[[0-9a-fA-F:]+\]|[^:\s]+):(\d{1,5})$/.exec(value) : null;
  const port = m ? Number(m[2]) : NaN;
  if (!m || port > 65535) throw new ConfigError(`${what}: expected host:port, got ${JSON.stringify(value)}`);
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

function bool(value: unknown, what: string): boolean {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new ConfigError(`${what}: expected true or false`);
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ConfigError(`${what}: expected a string`);
  return value;
}

function httpUrlFromEnv(env: Env, name: string, what: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError(`${what}: expected the NAME of an environment variable, not a URL (secrets stay out of the file)`);
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    /* reported below */
  }
  // The value is never echoed: a provider URL usually embeds an API key.
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new ConfigError(`${name}: expected an http or https URL`);
  return raw;
}

export interface LoadOptions {
  env?: Env;
  /** Contents of the settings file, if any. */
  toml?: string;
  /** Path the contents came from (for messages only). */
  file?: string | null;
}

/** Build the settings from TOML text and environment variables. Throws `ConfigError`. */
export function loadSettings(opts: LoadOptions = {}): BundleSettings {
  const env = opts.env ?? {};
  let doc: Record<string, unknown> = {};
  if (opts.toml !== undefined) {
    try {
      doc = parseToml(opts.toml) as Record<string, unknown>;
    } catch (e) {
      throw new ConfigError(`settings file: ${(e as Error).message}`);
    }
  }
  for (const k of Object.keys(doc)) if (k !== 'ui' && k !== 'relay') throw new ConfigError(`settings file: unknown table or key "${k}" (expected [ui] and [relay])`);
  const table = (name: string): Record<string, unknown> => {
    const t = doc[name] ?? {};
    if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new ConfigError(`[${name}]: expected a table`);
    return t as Record<string, unknown>;
  };
  const ui = table('ui');
  for (const k of Object.keys(ui)) if (!UI_KEYS.includes(k)) throw new ConfigError(`settings file: unknown key "ui.${k}"`);
  const defaults = Object.fromEntries(SETTINGS.filter((s) => s.table === 'ui').map((s) => [s.key, parseToml(`v = ${s.defaultToml}`)['v']]));
  const pick = (key: string): unknown => {
    const def = SETTINGS.find((s) => s.table === 'ui' && s.key === key)!;
    const fromEnv = env[def.env];
    return fromEnv !== undefined ? fromEnv : (ui[key] ?? defaults[key]);
  };

  const listen = hostPort(pick('listen'), 'ui.listen');
  const distRaw = str(pick('dist'), 'ui.dist');
  if (distRaw === '') throw new ConfigError('ui.dist: expected a directory');
  const releasesRaw = str(pick('releases'), 'ui.releases');
  if (releasesRaw === '') throw new ConfigError('ui.releases: expected a directory');
  let publicOrigin = str(pick('public_origin'), 'ui.public_origin');
  if (publicOrigin !== '') {
    let u: URL | null = null;
    try {
      u = new URL(publicOrigin);
    } catch {
      /* reported below */
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== publicOrigin)
      throw new ConfigError(`ui.public_origin: expected a bare origin such as "https://swap.example.org", got "${publicOrigin}"`);
    publicOrigin = u.origin;
  }
  const chainRaw = pick('ethereum_chain_id');
  const chainId = typeof chainRaw === 'string' && /^\d+$/.test(chainRaw) ? Number(chainRaw) : chainRaw;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) throw new ConfigError('ui.ethereum_chain_id: expected a positive integer');
  const contract = str(pick('contract_address'), 'ui.contract_address');
  if (contract !== '' && !/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new ConfigError('ui.contract_address: expected 0x followed by 40 hex digits, or empty');
  const network = str(pick('monero_network'), 'ui.monero_network') as MoneroNetwork;
  if (!NETWORKS.includes(network)) throw new ConfigError(`ui.monero_network: expected one of ${NETWORKS.join(', ')}`);
  const ownNode = bool(pick('own_node'), 'ui.own_node');
  const givePageRpcUrls = bool(pick('give_page_rpc_urls'), 'ui.give_page_rpc_urls');
  const pollRaw = pick('poll_ms');
  const pollMs = typeof pollRaw === 'string' && /^\d+$/.test(pollRaw) ? Number(pollRaw) : pollRaw;
  if (typeof pollMs !== 'number' || !Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60_000) throw new ConfigError('ui.poll_ms: expected a whole number of milliseconds from 1000 to 60000');
  const ethereumRpcUrl = httpUrlFromEnv(env, str(pick('ethereum_rpc_url_env'), 'ui.ethereum_rpc_url_env'), 'ui.ethereum_rpc_url_env');

  // The [relay] table is a relay.toml: the relay's own loader validates it and applies RELAY_*.
  const relayTable = { ...table('relay') };
  if (relayTable['program_id'] === undefined) relayTable['program_id'] = PROGRAM_ID;
  const rate = relayTable['rate_limit'];
  if (rate === undefined || (typeof rate === 'object' && rate !== null && !Array.isArray(rate))) relayTable['rate_limit'] = { ...LOCAL_RATE_LIMIT, ...(rate as Record<string, unknown> | undefined) };
  let relay: RelayConfig;
  try {
    relay = loadRelayConfig({ env, toml: stringifyToml(relayTable) });
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`[relay] ${e.message.replace(/^relay\.toml: /, '')}`);
    throw e;
  }
  if (relay.programId === null) relay.programId = PROGRAM_ID;
  // The UI server is one proxy hop in front of the relay and always adds the caller's address.
  relay.trustProxyHops += 1;

  if (ownNode && relay.moneroNodes.length !== 1) throw new ConfigError('ui.own_node: true only makes sense with exactly one entry in relay.monero_nodes');
  if (relay.bindHost === listen.host && relay.bindPort === listen.port && listen.port !== 0) throw new ConfigError('ui.listen and relay.bind must be different addresses');

  return {
    ui: {
      listenHost: listen.host,
      listenPort: listen.port,
      dist: path.resolve(DEPLOY_DIR, distRaw),
      releases: path.resolve(DEPLOY_DIR, releasesRaw),
      publicOrigin,
      givePageRpcUrls,
      ethereumRpcUrl,
      ethereumChainId: chainId,
      contractAddress: contract,
      moneroNetwork: network,
      ownNode,
      pollMs,
    },
    relay,
    file: opts.file ?? null,
  };
}

/**
 * Settings for the running process: `XMRSWAP_SELFHOST_CONFIG` names the file; otherwise
 * `./xmrswap.toml` in the working directory is used if it exists. `RELAY_CONFIG` is not read.
 */
export function loadSettingsFromProcess(env: Env = process.env, cwd: string = process.cwd()): BundleSettings {
  const explicit = env[SETTINGS_FILE_ENV];
  const file = explicit !== undefined && explicit !== '' ? path.resolve(cwd, explicit) : path.join(cwd, DEFAULT_SETTINGS_FILE);
  if (!existsSync(file)) {
    if (explicit !== undefined && explicit !== '') throw new ConfigError(`${SETTINGS_FILE_ENV}: cannot read "${explicit}"`);
    return loadSettings({ env });
  }
  let toml: string;
  try {
    toml = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read "${file}": ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  return loadSettings({ env, toml, file });
}

export { isLoopback };

// ------------------------------------------------------------------ generated text

function wrap(text: string, width = 96): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** The example settings file: every setting with its default, as shipped in `xmrswap.example.toml`. */
export function exampleToml(): string {
  const lines: string[] = [
    '# Settings for the self-hosting bundle (@xmrswap/deploy). Copy this file to xmrswap.toml in the',
    '# same directory and edit the copy. Every key is optional; the values shown are the defaults.',
    '# Each key can also be set by the environment variable named beside it, which wins over the file.',
    '# The file is found as ./xmrswap.toml in deploy/, or through XMRSWAP_SELFHOST_CONFIG.',
    '#',
    '# RPC URLs are secrets (they usually contain an API key) and never go in this file: they are',
    '# read from environment variables. The full reference is docs/self-hosting/configuration.md.',
    '# This file is generated: `pnpm --filter @xmrswap/deploy run docs` rewrites it.',
  ];
  let current = '';
  for (const s of SETTINGS) {
    if (s.table !== current) {
      current = s.table;
      lines.push('', `[${current}]`);
    }
    lines.push('');
    for (const l of wrap(s.effect)) lines.push(`# ${l}`);
    lines.push(`# Environment: ${s.env}${s.defaultNote ? `. Default: ${s.defaultNote}.` : ''}`);
    lines.push(`${s.key} = ${s.defaultToml}`);
  }
  return `${lines.join('\n')}\n`;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** The Markdown table of the bundle's settings for the configuration reference. */
export function settingsTable(): string {
  const rows = ['| Setting | Environment variable | Default | What it does |', '| --- | --- | --- | --- |'];
  for (const s of SETTINGS) {
    const def = `\`${s.defaultToml}\`${s.defaultNote ? ` (${s.defaultNote})` : ''}`;
    rows.push(`| \`[${s.table}] ${s.key}\` | \`${s.env}\` | ${cell(def)} | ${cell(s.effect)} |`);
  }
  return rows.join('\n');
}

export interface PageSettingDef {
  /** Key in the page's settings (and in `config.json`). */
  key: string;
  /** The page's own default, as JSON text. */
  defaultJson: string;
  /** What this bundle sets it to, or `null` when the bundle leaves the page's default. */
  bundle: string | null;
  effect: string;
}

/**
 * Every setting of the page (`apps/web/src/lib/settings.ts`). They are stored in the browser;
 * the bundle supplies starting values through `config.json`. A test holds this list and its
 * defaults to the page's real `DEFAULT_SETTINGS`.
 */
export const PAGE_SETTINGS: readonly PageSettingDef[] = [
  { key: 'solanaRpc', defaultJson: '""', bundle: 'the URL in the variable named by `[relay] solana_rpc_url_env`, if set and `[ui] give_page_rpc_urls` is true', effect: 'Solana RPC URL. Reads the registry and swaps, submits transactions. No default: nothing works until it is set.' },
  { key: 'ethereumRpc', defaultJson: '""', bundle: 'the URL in the variable named by `[ui] ethereum_rpc_url_env`, if set and `[ui] give_page_rpc_urls` is true', effect: 'Ethereum RPC URL. Empty switches the ETH and USDC-on-Ethereum markets off.' },
  { key: 'ethereumChainId', defaultJson: String(CONTRACT_CHAIN_ID ?? 1), bundle: '`[ui] ethereum_chain_id`', effect: 'Chain id the Ethereum RPC must report.' },
  { key: 'moneroNodes', defaultJson: '[]', bundle: 'one proxy address per entry of `[relay] monero_nodes`: `<origin>/monero/0`, `<origin>/monero/1`, ...', effect: 'Monero nodes the page checks every XMR lock against. The first one is used for the final sweep. No default: locking is disabled until set.' },
  { key: 'ownNode', defaultJson: 'false', bundle: '`[ui] own_node`', effect: 'Declares a single configured node to be your own, so one node is accepted.' },
  { key: 'moneroNetwork', defaultJson: '"mainnet"', bundle: '`[ui] monero_network`', effect: 'Monero network.' },
  { key: 'relayUrl', defaultJson: '""', bundle: '`"/"` (the same origin as the page)', effect: 'Where the relay is: a URL, or a path on the same site.' },
  { key: 'mode', defaultJson: '"hosted"', bundle: '`"self-hosted"`', effect: 'Connection mode: `hosted`, `self-hosted`, `tor-direct` or `onchain`. See "Who sees what".' },
  { key: 'programId', defaultJson: JSON.stringify(PROGRAM_ID), bundle: '`[relay] program_id`', effect: 'Solana program id. Pinned by the release and shown for checking.' },
  { key: 'contract', defaultJson: JSON.stringify(CONTRACT_ADDRESS ?? ''), bundle: '`[ui] contract_address`', effect: 'Ethereum contract address. Pinned by the release and shown for checking.' },
  { key: 'minDepth', defaultJson: '0', bundle: null, effect: 'Your own minimum number of Monero confirmations. 0 uses the protocol tiers only.' },
  { key: 'refXmrUsd', defaultJson: '""', bundle: null, effect: 'Your reference XMR price in USD, used to compare offers. The page fetches no price feed.' },
  { key: 'refSolUsd', defaultJson: '""', bundle: null, effect: 'Your reference SOL price in USD.' },
  { key: 'refEthUsd', defaultJson: '""', bundle: null, effect: 'Your reference ETH price in USD.' },
  { key: 'theme', defaultJson: '"system"', bundle: null, effect: 'Appearance: `system`, `light` or `dark`.' },
  { key: 'pollMs', defaultJson: '4000', bundle: '`[ui] poll_ms`', effect: 'How often the page re-reads chain state, in milliseconds. Raise it if your RPC provider rate-limits you.' },
  { key: 'sweepMaxFee', defaultJson: '""', bundle: null, effect: 'Override of the Monero sweep fee cap, in piconero. Empty uses the protocol cap. For test networks only.' },
];

export function pageSettingsTable(): string {
  const rows = ['| Page setting | Page default | Set by this bundle to | What it does |', '| --- | --- | --- | --- |'];
  for (const s of PAGE_SETTINGS) rows.push(`| \`${s.key}\` | \`${s.defaultJson}\` | ${cell(s.bundle ?? 'not set (page default)')} | ${cell(s.effect)} |`);
  return rows.join('\n');
}

/** Other environment variables the bundle reads. */
export const OTHER_ENV: readonly { env: string; effect: string }[] = [
  { env: SETTINGS_FILE_ENV, effect: 'Path of the settings file. Without it, `xmrswap.toml` in `deploy/` is used if it exists; otherwise defaults and environment variables only.' },
  { env: 'SOLANA_RPC_URL', effect: 'The Solana RPC URL (the name can be changed with `[relay] solana_rpc_url_env`). No default.' },
  { env: 'ETHEREUM_RPC_URL', effect: 'The Ethereum RPC URL (the name can be changed with `[ui] ethereum_rpc_url_env`). Optional.' },
];

export function otherEnvTable(): string {
  const rows = ['| Environment variable | What it does |', '| --- | --- |'];
  for (const e of OTHER_ENV) rows.push(`| \`${e.env}\` | ${cell(e.effect)} |`);
  return rows.join('\n');
}

/** The generated part of `docs/self-hosting/configuration.md`, between the two marker lines. */
export const DOCS_BEGIN = '<!-- BEGIN GENERATED SETTINGS (pnpm --filter @xmrswap/deploy run docs) -->';
export const DOCS_END = '<!-- END GENERATED SETTINGS -->';

export function generatedDocs(): string {
  return [
    DOCS_BEGIN,
    '',
    '## Settings file',
    '',
    settingsTable(),
    '',
    '## Other environment variables',
    '',
    otherEnvTable(),
    '',
    '## Settings in the browser',
    '',
    pageSettingsTable(),
    '',
    DOCS_END,
  ].join('\n');
}
