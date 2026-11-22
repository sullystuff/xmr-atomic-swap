/**
 * Settings (SPEC 6.5): environment variables or `relay.toml`. An environment variable wins over
 * the file; the file wins over the default. Secrets are never in the file: the Solana RPC URL is
 * named by environment variable only (SPEC 1.5).
 */
import { readFileSync } from 'node:fs';
import { RELAY_LIMITS, base58Decode } from '@xmrswap/protocol';
import { parse as parseToml } from 'smol-toml';

export interface RelayConfig {
  /** Address the HTTP server binds to. Default `127.0.0.1`: localhost only unless changed on purpose. */
  bindHost: string;
  bindPort: number;
  /** Tor's SOCKS5 proxy. Default `127.0.0.1:9050`. */
  torSocksHost: string;
  torSocksPort: number;
  /** Read from the environment variable named by `solana_rpc_url_env`; `null` = not set. */
  solanaRpcUrl: string | null;
  /** The swap program whose maker accounts form the registry; `null` = not set. */
  programId: string | null;
  /** Monero node base URLs. `POST /monero/<n>/...` goes to the n-th (from 0). Empty = proxy off. */
  moneroNodes: string[];
  requestsPerMinute: number;
  bytesPerMinute: number;
  /** Largest Monero node response the proxy will carry. */
  moneroMaxResponseBytes: number;
  /** Log request metadata (client IP, destination onion). Off by default. */
  debugLog: boolean;
  /** Origins allowed to call the relay cross-origin (`*` = any). Empty = same-origin only. */
  allowedOrigins: string[];
  /** Number of reverse proxies in front of the relay whose `X-Forwarded-For` is trusted. Default 0. */
  trustProxyHops: number;
}

export const DEFAULTS = {
  bind: '127.0.0.1:8787',
  torSocks: '127.0.0.1:9050',
  solanaRpcUrlEnv: 'SOLANA_RPC_URL',
  requestsPerMinute: RELAY_LIMITS.defaultRequestsPerMinute,
  bytesPerMinute: RELAY_LIMITS.defaultBytesPerMinute,
  moneroMaxResponseBytes: 16 * 1024 * 1024,
} as const;

export class ConfigError extends Error {}

const TOP_KEYS = [
  'bind',
  'tor_socks',
  'solana_rpc_url_env',
  'program_id',
  'monero_nodes',
  'monero_max_response_bytes',
  'rate_limit',
  'debug_log',
  'allowed_origins',
  'trust_proxy_hops',
] as const;
const RATE_KEYS = ['requests_per_minute', 'bytes_per_minute'] as const;

function hostPort(value: string, what: string): { host: string; port: number } {
  const m = /^(\[[0-9a-fA-F:]+\]|[^:\s]+):(\d{1,5})$/.exec(value);
  const port = m ? Number(m[2]) : NaN;
  if (!m || port > 65535) throw new ConfigError(`${what}: expected host:port, got "${value}"`);
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

function positiveInt(value: unknown, what: string, min = 1): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) throw new ConfigError(`${what}: expected an integer of at least ${min}`);
  return n;
}

function bool(value: unknown, what: string): boolean {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0' || value === '') return false;
  throw new ConfigError(`${what}: expected true or false`);
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ConfigError(`${what}: expected a string`);
  return value;
}

function strList(value: unknown, what: string): string[] {
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new ConfigError(`${what}: expected a list of strings`);
}

/** A Monero node is `http(s)://host[:port]` and nothing else: no credentials, path, query or fragment. */
export function normaliseMoneroNode(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`monero_nodes: "${value}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`monero_nodes: "${value}" must be http or https`);
  if (url.username || url.password) throw new ConfigError('monero_nodes: credentials in a node URL are not supported');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new ConfigError(`monero_nodes: "${value}" must not have a path or query`);
  if (url.hostname.endsWith('.onion') && url.protocol !== 'http:') throw new ConfigError(`monero_nodes: "${value}": an onion node must be http`);
  return url.origin;
}

function checkOrigin(value: string): string {
  if (value === '*') return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`allowed_origins: "${value}" is not an origin`);
  }
  if (url.origin !== value) throw new ConfigError(`allowed_origins: "${value}" must be a bare origin such as "${url.origin}"`);
  return value;
}

export interface LoadOptions {
  env?: Record<string, string | undefined>;
  /** Contents of `relay.toml`, if any. */
  toml?: string;
}

/** Build the configuration from TOML text and environment variables. Throws `ConfigError`. */
export function loadConfig(opts: LoadOptions = {}): RelayConfig {
  const env = opts.env ?? {};
  let file: Record<string, unknown> = {};
  if (opts.toml !== undefined) {
    try {
      file = parseToml(opts.toml) as Record<string, unknown>;
    } catch (e) {
      throw new ConfigError(`relay.toml: ${(e as Error).message}`);
    }
    for (const k of Object.keys(file)) if (!(TOP_KEYS as readonly string[]).includes(k)) throw new ConfigError(`relay.toml: unknown key "${k}"`);
  }
  const rate = file['rate_limit'] ?? {};
  if (typeof rate !== 'object' || rate === null || Array.isArray(rate)) throw new ConfigError('rate_limit: expected a table');
  for (const k of Object.keys(rate)) if (!(RATE_KEYS as readonly string[]).includes(k)) throw new ConfigError(`relay.toml: unknown key "rate_limit.${k}"`);
  const rateTable = rate as Record<string, unknown>;

  const pick = (envName: string, fileValue: unknown): unknown => (env[envName] !== undefined ? env[envName] : fileValue);

  const bind = hostPort(str(pick('RELAY_BIND', file['bind']) ?? DEFAULTS.bind, 'bind'), 'bind');
  const tor = hostPort(str(pick('RELAY_TOR_SOCKS', file['tor_socks']) ?? DEFAULTS.torSocks, 'tor_socks'), 'tor_socks');

  const rpcEnvName = str(pick('RELAY_SOLANA_RPC_URL_ENV', file['solana_rpc_url_env']) ?? DEFAULTS.solanaRpcUrlEnv, 'solana_rpc_url_env');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rpcEnvName))
    throw new ConfigError('solana_rpc_url_env: expected the NAME of an environment variable, not a URL (secrets stay out of the file)');
  const rpcRaw = env[rpcEnvName];
  let solanaRpcUrl: string | null = null;
  if (rpcRaw !== undefined && rpcRaw !== '') {
    let u: URL | null = null;
    try {
      u = new URL(rpcRaw);
    } catch {
      /* reported below */
    }
    // The value is never echoed: a provider URL usually embeds an API key.
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new ConfigError(`${rpcEnvName}: expected an http or https URL`);
    solanaRpcUrl = rpcRaw;
  }

  const programRaw = pick('RELAY_PROGRAM_ID', file['program_id']);
  let programId: string | null = null;
  if (programRaw !== undefined && programRaw !== '') {
    programId = str(programRaw, 'program_id');
    let ok = false;
    try {
      ok = base58Decode(programId).length === 32;
    } catch {
      ok = false;
    }
    if (!ok) throw new ConfigError('program_id: expected a base58 Solana address');
  }

  const nodesRaw = pick('RELAY_MONERO_NODES', file['monero_nodes']);
  const moneroNodes = nodesRaw === undefined ? [] : strList(nodesRaw, 'monero_nodes').map(normaliseMoneroNode);

  const originsRaw = pick('RELAY_ALLOWED_ORIGINS', file['allowed_origins']);
  const allowedOrigins = originsRaw === undefined ? [] : strList(originsRaw, 'allowed_origins').map(checkOrigin);

  return {
    bindHost: bind.host,
    bindPort: bind.port,
    torSocksHost: tor.host,
    torSocksPort: tor.port,
    solanaRpcUrl,
    programId,
    moneroNodes,
    requestsPerMinute: positiveInt(
      pick('RELAY_RATE_REQUESTS_PER_MINUTE', rateTable['requests_per_minute']) ?? DEFAULTS.requestsPerMinute,
      'rate_limit.requests_per_minute',
    ),
    bytesPerMinute: positiveInt(pick('RELAY_RATE_BYTES_PER_MINUTE', rateTable['bytes_per_minute']) ?? DEFAULTS.bytesPerMinute, 'rate_limit.bytes_per_minute'),
    moneroMaxResponseBytes: positiveInt(
      pick('RELAY_MONERO_MAX_RESPONSE_BYTES', file['monero_max_response_bytes']) ?? DEFAULTS.moneroMaxResponseBytes,
      'monero_max_response_bytes',
    ),
    debugLog: bool(pick('RELAY_DEBUG_LOG', file['debug_log']) ?? false, 'debug_log'),
    allowedOrigins,
    trustProxyHops: positiveInt(pick('RELAY_TRUST_PROXY_HOPS', file['trust_proxy_hops']) ?? 0, 'trust_proxy_hops', 0),
  };
}

/**
 * Configuration for the running process: `RELAY_CONFIG` names the file; otherwise `./relay.toml`
 * is used if it exists.
 */
export function loadConfigFromProcess(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): RelayConfig {
  const explicit = env['RELAY_CONFIG'];
  let toml: string | undefined;
  try {
    toml = readFileSync(explicit ?? `${cwd}/relay.toml`, 'utf8');
  } catch (e) {
    if (explicit !== undefined) throw new ConfigError(`RELAY_CONFIG: cannot read "${explicit}": ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  return loadConfig(toml === undefined ? { env } : { env, toml });
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
