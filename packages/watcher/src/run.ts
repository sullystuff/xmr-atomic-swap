/**
 * Assemble a running watcher from its configuration: keystore, database, chain endpoints,
 * Monero nodes, the loop and the HTTP server. The CLI and the integration tests both start here.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { type ChainName } from '@xmrswap/protocol';
import { type EthTransport, type MoneroNode, type SolanaTransport, checkNodePolicy, connectionTransport, init, type verifyLock } from '@xmrswap/sdk';
import { type Listening, createApp, listen } from './app.js';
import { type ChainPort, EthereumChain, SolanaChain, httpEthTransport } from './chains.js';
import { ConfigError, type WatcherConfig, isLoopback } from './config.js';
import { WatcherKeys } from './keys.js';
import { type LogSink, type Logger, createLogger } from './log.js';
import { type FaultPoint, type ServiceSettings, Watcher } from './service.js';
import { Store } from './store.js';

export const DB_FILE = 'watcher.sqlite';

export interface RunOptions {
  /** The keystore passphrase (the CLI reads it from the environment variable the configuration names). */
  passphrase: string;
  logSink?: LogSink;
  /** `false`: build everything but do not start the timer; the caller drives `watcher.tick()`. */
  loop?: boolean;
  /** Test seams: transports instead of the configured URLs, Monero nodes in memory, a fault hook. */
  solanaTransport?: SolanaTransport;
  ethereumTransport?: EthTransport;
  moneroNodes?: (string | MoneroNode)[];
  verifyLock?: typeof verifyLock;
  fault?: (point: FaultPoint) => void;
  nowMs?: () => number;
}

export interface Running {
  watcher: Watcher;
  store: Store;
  keys: WatcherKeys;
  logger: Logger;
  http: Listening;
  url: string;
  stop(): Promise<void>;
}

export function serviceSettings(config: WatcherConfig): ServiceSettings {
  const limits: ServiceSettings['limits'] = {};
  if (config.solana) limits.solana = { perSwap: config.solana.perSwapLimit, perDay: config.solana.perDayLimit };
  if (config.ethereum) limits.ethereum = { perSwap: config.ethereum.perSwapLimit, perDay: config.ethereum.perDayLimit };
  return { maxSwaps: config.maxSwaps, maxKeysPerSwap: config.maxKeysPerSwap, retentionDays: config.retentionDays, stopConfirmations: config.stopConfirmations, minLeadSecs: config.minLeadSecs, attemptTimeoutSecs: config.attemptTimeoutSecs, limits };
}

export async function startWatcher(config: WatcherConfig, opts: RunOptions): Promise<Running> {
  if (!isLoopback(config.bindHost) && !config.allowNonLoopback) throw new ConfigError('bind: not a loopback address and allow_non_loopback is not set');
  checkNodePolicy(config.moneroNodes.length, config.ownNode);
  await init();
  const logger = createLogger(config.debugLog, opts.logSink);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const { keys, created } = WatcherKeys.openOrCreate(config.dataDir, opts.passphrase);
  if (created) logger.info('generated a new watcher keystore; fund its two addresses (see `pubkey`) before accepting swaps');
  const store = new Store(path.join(config.dataDir, DB_FILE), { solana: keys.solana, ethereum: keys.ethereum });

  const chains: Partial<Record<ChainName, ChainPort>> = {};
  if (config.solana) chains.solana = new SolanaChain(opts.solanaTransport ?? connectionTransport(new Connection(config.solana.rpcUrl, config.solana.commitment), { subscriptions: false }), config.solana, keys);
  if (config.ethereum) chains.ethereum = new EthereumChain(opts.ethereumTransport ?? httpEthTransport(config.ethereum.rpcUrl), config.ethereum, keys);
  // A wrong cluster or chain is refused before anything it says is believed. An unreachable endpoint is not fatal: the loop retries.
  for (const port of Object.values(chains)) {
    try {
      await port.verifyEndpoint();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'WrongCluster' || code === 'WrongChain') {
        store.close();
        throw new ConfigError(`${port.chain}: the endpoint is not the configured ${port.chain === 'solana' ? 'cluster (genesis hash)' : 'chain (chain id)'}`);
      }
      logger.info(`${port.chain}: the endpoint did not answer at start; retrying in the loop`);
    }
  }

  const watcher = new Watcher({
    settings: serviceSettings(config),
    store,
    keys,
    chains,
    monero: { nodes: opts.moneroNodes ?? config.moneroNodes, ownNode: config.ownNode, network: config.network, ...(opts.verifyLock ? { verify: opts.verifyLock } : {}) },
    logger,
    ...(opts.fault ? { fault: opts.fault } : {}),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
  });
  const http = await listen(createApp(watcher, config, logger, opts.nowMs), config, logger);
  if (opts.loop !== false) watcher.start(config.pollSecs * 1_000);
  return {
    watcher,
    store,
    keys,
    logger,
    http,
    url: http.url,
    async stop() {
      watcher.stop();
      await http.close();
      store.close();
    },
  };
}
