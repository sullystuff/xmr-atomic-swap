/**
 * Settings (SPEC 11.6): `watcher.toml` and environment variables. An environment variable wins
 * over the file; the file wins over the default. Secrets are never in the file: the chain RPC
 * URLs and the keystore passphrase are named by environment variable only (SPEC 1.5).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { base58Decode } from '@xmrswap/protocol';
import { parse as parseToml } from 'smol-toml';

export type MoneroNetwork = 'mainnet' | 'stagenet' | 'testnet' | 'regtest';

export interface SolanaSettings {
  /** Read from the environment variable named by `rpc_url_env`. */
  rpcUrl: string;
  programId: string;
  /** Expected genesis hash; the service refuses an endpoint of another cluster. `null` = not checked. */
  genesisHash: string | null;
  /** Level every swap and the clock are read at. */
  commitment: 'finalized' | 'confirmed';
  /** Priority fee, micro-lamports per compute unit. */
  priorityFeeMicroLamports: bigint;
  /** Upper bound of the compute-unit limit of a freeze. */
  maxComputeUnits: number;
  perSwapLimit: bigint;
  perDayLimit: bigint;
}

export interface EthereumSettings {
  rpcUrl: string;
  contract: `0x${string}`;
  chainId: number;
  /** Block tag every swap and the clock are read at. */
  readTag: 'finalized' | 'safe' | 'latest';
  /** The service never signs a transaction with a higher fee per gas (wei). */
  maxFeePerGas: bigint;
  priorityFeePerGas: bigint;
  perSwapLimit: bigint;
  perDayLimit: bigint;
}

export interface WatcherConfig {
  bindHost: string;
  bindPort: number;
  allowNonLoopback: boolean;
  trustProxyHops: number;
  dataDir: string;
  /** NAME of the environment variable holding the keystore passphrase. */
  passphraseEnv: string;
  network: MoneroNetwork;
  pollSecs: number;
  maxSwaps: number;
  retentionDays: number;
  /** A swap must be seen ended this many passes in a row before its watch is closed and its keys deleted. */
  stopConfirmations: number;
  /** Refuse a watch whose last sending second (`T_co − M`) is closer than this. */
  minLeadSecs: number;
  /** A broadcast transaction not seen on chain after this long is rebroadcast or replaced. */
  attemptTimeoutSecs: number;
  /** A watch request older than this (by its authenticated `issued_at`) is refused. */
  requestMaxAgeSecs: number;
  /** How far `issued_at` may lie ahead of the chain clock the service reads, or behind the swap's lock time. */
  requestClockSkewSecs: number;
  moneroNodes: string[];
  ownNode: boolean;
  requestsPerMinute: number;
  registrationsPerMinute: number;
  maxBodyBytes: number;
  debugLog: boolean;
  solana: SolanaSettings | null;
  ethereum: EthereumSettings | null;
}

export const DEFAULTS = {
  bind: '127.0.0.1:8790',
  dataDir: './watcher-data',
  passphraseEnv: 'WATCHER_PASSPHRASE',
  network: 'mainnet',
  pollSecs: 15,
  maxSwaps: 200,
  retentionDays: 30,
  stopConfirmations: 3,
  minLeadSecs: 120,
  attemptTimeoutSecs: 150,
  requestMaxAgeSecs: 3_600,
  requestClockSkewSecs: 1_800,
  requestsPerMinute: 60,
  registrationsPerMinute: 10,
  maxBodyBytes: 1024,
  solana: { rpcUrlEnv: 'SOLANA_RPC_URL', commitment: 'finalized', priorityFeeMicroLamports: 0n, maxComputeUnits: 200_000, perSwapLimit: 100_000n, perDayLimit: 5_000_000n },
  ethereum: { rpcUrlEnv: 'ETHEREUM_RPC_URL', readTag: 'finalized', maxFeePerGasGwei: 100, priorityFeeGwei: 1, perSwapLimit: 30_000_000_000_000_000n, perDayLimit: 300_000_000_000_000_000n },
} as const;

export class ConfigError extends Error {}

const TOP_KEYS = ['bind', 'allow_non_loopback', 'trust_proxy_hops', 'data_dir', 'passphrase_env', 'network', 'poll_secs', 'max_swaps', 'retention_days', 'stop_confirmations', 'debug_log', 'margins', 'monero', 'rate_limit', 'solana', 'ethereum'];
const TABLE_KEYS: Record<string, string[]> = {
  margins: ['min_lead_secs', 'attempt_timeout_secs', 'request_max_age_secs', 'request_clock_skew_secs'],
  monero: ['nodes', 'own_node'],
  rate_limit: ['requests_per_minute', 'registrations_per_minute', 'max_body_bytes'],
  solana: ['rpc_url_env', 'program_id', 'genesis_hash', 'commitment', 'priority_fee_micro_lamports', 'max_compute_units', 'per_swap_limit_lamports', 'per_day_limit_lamports'],
  ethereum: ['rpc_url_env', 'contract', 'chain_id', 'read_tag', 'max_fee_per_gas_gwei', 'priority_fee_gwei', 'per_swap_limit_wei', 'per_day_limit_wei'],
};

function hostPort(value: string, what: string): { host: string; port: number } {
  const m = /^(\[[0-9a-fA-F:]+\]|[^:\s]+):(\d{1,5})$/.exec(value);
  const port = m ? Number(m[2]) : NaN;
  if (!m || port > 65535) throw new ConfigError(`${what}: expected host:port, got "${value}"`);
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}
function int(value: unknown, what: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`${what}: expected an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}`);
  return n;
}
/** Amounts in base units may exceed 2^53: a TOML integer or a string of digits. */
function big(value: unknown, what: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new ConfigError(`${what}: expected a non-negative integer (a string of digits for large values)`);
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
function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new ConfigError(`${what}: expected one of ${allowed.join(', ')}`);
  return value as T;
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
function table(file: Record<string, unknown>, name: string): Record<string, unknown> {
  const t = file[name] ?? {};
  if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new ConfigError(`${name}: expected a table`);
  for (const k of Object.keys(t)) if (!TABLE_KEYS[name]!.includes(k)) throw new ConfigError(`watcher.toml: unknown key "${name}.${k}"`);
  return t as Record<string, unknown>;
}

/** A Monero node is `http(s)://host[:port]` and nothing else: no credentials, path, query or fragment. */
export function normaliseMoneroNode(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`monero.nodes: "${value}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`monero.nodes: "${value}" must be http or https`);
  if (url.username || url.password) throw new ConfigError('monero.nodes: credentials in a node URL are not supported');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new ConfigError(`monero.nodes: "${value}" must not have a path or query`);
  return url.origin;
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The URL held by the environment variable `name`, or `null` when unset. The value is never echoed: a provider URL usually embeds an API key. */
function urlFromEnv(env: Record<string, string | undefined>, name: string, what: string): string | null {
  if (!ENV_NAME.test(name)) throw new ConfigError(`${what}: expected the NAME of an environment variable, not a URL (secrets stay out of the file)`);
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    /* reported below */
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new ConfigError(`${name}: expected an http or https URL`);
  return raw;
}

export interface LoadOptions {
  env?: Record<string, string | undefined>;
  /** Contents of `watcher.toml`, if any. */
  toml?: string;
  /** Directory relative paths in the file resolve against. */
  baseDir?: string;
}

/** Build the configuration from TOML text and environment variables. Throws `ConfigError`. */
export function loadConfig(opts: LoadOptions = {}): WatcherConfig {
  const env = opts.env ?? {};
  let file: Record<string, unknown> = {};
  if (opts.toml !== undefined) {
    try {
      file = parseToml(opts.toml) as Record<string, unknown>;
    } catch (e) {
      throw new ConfigError(`watcher.toml: ${(e as Error).message}`);
    }
    for (const k of Object.keys(file)) if (!TOP_KEYS.includes(k)) throw new ConfigError(`watcher.toml: unknown key "${k}"`);
  }
  const margins = table(file, 'margins');
  const monero = table(file, 'monero');
  const rate = table(file, 'rate_limit');
  const pick = (envName: string, fileValue: unknown): unknown => (env[envName] !== undefined ? env[envName] : fileValue);

  const bind = hostPort(str(pick('WATCHER_BIND', file['bind']) ?? DEFAULTS.bind, 'bind'), 'bind');
  const allowNonLoopback = bool(pick('WATCHER_ALLOW_NON_LOOPBACK', file['allow_non_loopback']) ?? false, 'allow_non_loopback');
  if (!isLoopback(bind.host) && !allowNonLoopback)
    throw new ConfigError(`bind: "${bind.host}" is not a loopback address. The service listens on localhost only; put a TLS reverse proxy or an onion service in front of it, or set allow_non_loopback = true on purpose.`);

  const passphraseEnv = str(pick('WATCHER_PASSPHRASE_ENV', file['passphrase_env']) ?? DEFAULTS.passphraseEnv, 'passphrase_env');
  if (!ENV_NAME.test(passphraseEnv)) throw new ConfigError('passphrase_env: expected the NAME of an environment variable, not the passphrase');

  const nodes = strList(pick('WATCHER_MONERO_NODES', monero['nodes']) ?? [], 'monero.nodes').map(normaliseMoneroNode);
  const ownNode = bool(pick('WATCHER_MONERO_OWN_NODE', monero['own_node']) ?? false, 'monero.own_node');
  if (new Set(nodes).size !== nodes.length) throw new ConfigError('monero.nodes: the same node is listed twice; two nodes means two independently operated nodes');
  if (nodes.length === 0) throw new ConfigError('monero.nodes: at least one Monero node is required');
  if (nodes.length === 1 && !ownNode) throw new ConfigError('monero.nodes: list two or more independently operated nodes, or one node with own_node = true (SPEC 2.11)');
  if (nodes.length > 1 && ownNode) throw new ConfigError('monero.own_node: applies to exactly one node');

  let solana: SolanaSettings | null = null;
  if (file['solana'] !== undefined || env['WATCHER_SOLANA_PROGRAM_ID'] !== undefined) {
    const t = table(file, 'solana');
    const rpcEnv = str(t['rpc_url_env'] ?? DEFAULTS.solana.rpcUrlEnv, 'solana.rpc_url_env');
    const rpcUrl = urlFromEnv(env, rpcEnv, 'solana.rpc_url_env');
    if (rpcUrl === null) throw new ConfigError(`solana: the environment variable ${rpcEnv} (the RPC URL) is not set`);
    const programId = str(pick('WATCHER_SOLANA_PROGRAM_ID', t['program_id']) ?? '', 'solana.program_id');
    const isKey = (v: string): boolean => {
      try {
        return base58Decode(v).length === 32;
      } catch {
        return false;
      }
    };
    if (!isKey(programId)) throw new ConfigError('solana.program_id: expected a base58 Solana address (use the id pinned in the release)');
    const genesis = t['genesis_hash'] === undefined || t['genesis_hash'] === '' ? null : str(t['genesis_hash'], 'solana.genesis_hash');
    if (genesis !== null && !isKey(genesis)) throw new ConfigError('solana.genesis_hash: expected a base58 hash');
    solana = {
      rpcUrl,
      programId,
      genesisHash: genesis,
      commitment: oneOf(t['commitment'] ?? DEFAULTS.solana.commitment, 'solana.commitment', ['finalized', 'confirmed'] as const),
      priorityFeeMicroLamports: big(t['priority_fee_micro_lamports'] ?? DEFAULTS.solana.priorityFeeMicroLamports, 'solana.priority_fee_micro_lamports'),
      maxComputeUnits: int(t['max_compute_units'] ?? DEFAULTS.solana.maxComputeUnits, 'solana.max_compute_units', 1_000, 1_400_000),
      perSwapLimit: big(t['per_swap_limit_lamports'] ?? DEFAULTS.solana.perSwapLimit, 'solana.per_swap_limit_lamports'),
      perDayLimit: big(t['per_day_limit_lamports'] ?? DEFAULTS.solana.perDayLimit, 'solana.per_day_limit_lamports'),
    };
  }

  let ethereum: EthereumSettings | null = null;
  if (file['ethereum'] !== undefined || env['WATCHER_ETHEREUM_CONTRACT'] !== undefined) {
    const t = table(file, 'ethereum');
    const rpcEnv = str(t['rpc_url_env'] ?? DEFAULTS.ethereum.rpcUrlEnv, 'ethereum.rpc_url_env');
    const rpcUrl = urlFromEnv(env, rpcEnv, 'ethereum.rpc_url_env');
    if (rpcUrl === null) throw new ConfigError(`ethereum: the environment variable ${rpcEnv} (the RPC URL) is not set`);
    const contract = str(pick('WATCHER_ETHEREUM_CONTRACT', t['contract']) ?? '', 'ethereum.contract');
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract) || /^0x0{40}$/.test(contract)) throw new ConfigError('ethereum.contract: expected a 0x address (use the address pinned in the release)');
    if (t['chain_id'] === undefined && env['WATCHER_ETHEREUM_CHAIN_ID'] === undefined) throw new ConfigError('ethereum.chain_id: required (1 for mainnet); the service signs for this chain only');
    const gwei = 1_000_000_000n;
    ethereum = {
      rpcUrl,
      contract: contract.toLowerCase() as `0x${string}`,
      chainId: int(pick('WATCHER_ETHEREUM_CHAIN_ID', t['chain_id']), 'ethereum.chain_id'),
      readTag: oneOf(t['read_tag'] ?? DEFAULTS.ethereum.readTag, 'ethereum.read_tag', ['finalized', 'safe', 'latest'] as const),
      maxFeePerGas: BigInt(int(t['max_fee_per_gas_gwei'] ?? DEFAULTS.ethereum.maxFeePerGasGwei, 'ethereum.max_fee_per_gas_gwei', 1, 1_000_000)) * gwei,
      priorityFeePerGas: BigInt(int(t['priority_fee_gwei'] ?? DEFAULTS.ethereum.priorityFeeGwei, 'ethereum.priority_fee_gwei', 0, 1_000_000)) * gwei,
      perSwapLimit: big(t['per_swap_limit_wei'] ?? DEFAULTS.ethereum.perSwapLimit, 'ethereum.per_swap_limit_wei'),
      perDayLimit: big(t['per_day_limit_wei'] ?? DEFAULTS.ethereum.perDayLimit, 'ethereum.per_day_limit_wei'),
    };
    if (ethereum.priorityFeePerGas > ethereum.maxFeePerGas) throw new ConfigError('ethereum.priority_fee_gwei: above max_fee_per_gas_gwei');
  }
  if (!solana && !ethereum) throw new ConfigError('no chain is configured: add a [solana] or an [ethereum] table');

  return {
    bindHost: bind.host,
    bindPort: bind.port,
    allowNonLoopback,
    trustProxyHops: int(pick('WATCHER_TRUST_PROXY_HOPS', file['trust_proxy_hops']) ?? 0, 'trust_proxy_hops', 0, 16),
    dataDir: path.resolve(opts.baseDir ?? '.', str(pick('WATCHER_DATA_DIR', file['data_dir']) ?? DEFAULTS.dataDir, 'data_dir')),
    passphraseEnv,
    network: oneOf(pick('WATCHER_NETWORK', file['network']) ?? DEFAULTS.network, 'network', ['mainnet', 'stagenet', 'testnet', 'regtest'] as const),
    pollSecs: int(pick('WATCHER_POLL_SECS', file['poll_secs']) ?? DEFAULTS.pollSecs, 'poll_secs', 1, 300),
    maxSwaps: int(pick('WATCHER_MAX_SWAPS', file['max_swaps']) ?? DEFAULTS.maxSwaps, 'max_swaps', 1, 100_000),
    retentionDays: int(pick('WATCHER_RETENTION_DAYS', file['retention_days']) ?? DEFAULTS.retentionDays, 'retention_days', 0, 3650),
    stopConfirmations: int(file['stop_confirmations'] ?? DEFAULTS.stopConfirmations, 'stop_confirmations', 1, 100),
    minLeadSecs: int(margins['min_lead_secs'] ?? DEFAULTS.minLeadSecs, 'margins.min_lead_secs', 0, 86_400),
    attemptTimeoutSecs: int(margins['attempt_timeout_secs'] ?? DEFAULTS.attemptTimeoutSecs, 'margins.attempt_timeout_secs', 30, 3_600),
    requestMaxAgeSecs: int(margins['request_max_age_secs'] ?? DEFAULTS.requestMaxAgeSecs, 'margins.request_max_age_secs', 60, 604_800),
    requestClockSkewSecs: int(margins['request_clock_skew_secs'] ?? DEFAULTS.requestClockSkewSecs, 'margins.request_clock_skew_secs', 0, 86_400),
    moneroNodes: nodes,
    ownNode,
    requestsPerMinute: int(rate['requests_per_minute'] ?? DEFAULTS.requestsPerMinute, 'rate_limit.requests_per_minute'),
    registrationsPerMinute: int(rate['registrations_per_minute'] ?? DEFAULTS.registrationsPerMinute, 'rate_limit.registrations_per_minute'),
    maxBodyBytes: int(rate['max_body_bytes'] ?? DEFAULTS.maxBodyBytes, 'rate_limit.max_body_bytes', 256, 65_536),
    debugLog: bool(pick('WATCHER_DEBUG_LOG', file['debug_log']) ?? false, 'debug_log'),
    solana,
    ethereum,
  };
}

/** Configuration for the running process: `--config`, else `WATCHER_CONFIG`, else `./watcher.toml` if it exists. */
export function loadConfigFromProcess(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd(), explicitPath?: string): WatcherConfig {
  const explicit = explicitPath ?? env['WATCHER_CONFIG'];
  const file = explicit ? path.resolve(cwd, explicit) : path.join(cwd, 'watcher.toml');
  let toml: string | undefined;
  try {
    toml = readFileSync(file, 'utf8');
  } catch (e) {
    if (explicit !== undefined) throw new ConfigError(`cannot read "${explicit}": ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  return loadConfig(toml === undefined ? { env, baseDir: cwd } : { env, toml, baseDir: path.dirname(file) });
}
