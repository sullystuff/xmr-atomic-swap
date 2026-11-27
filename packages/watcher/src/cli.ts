#!/usr/bin/env node
/**
 * `xmrswap-watcher start | status | pubkey [--config <file>]`.
 *
 * `start`  run the service (creates the keystore on first start; needs the passphrase variable).
 * `status` ask the running service for its health and print the local watch counts.
 * `pubkey` print the two keys a swap names as watcher (no passphrase needed once created).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfigFromProcess } from './config.js';
import { KeystoreError, WatcherKeys } from './keys.js';
import { DB_FILE, startWatcher } from './run.js';
import { Store, StoreError } from './store.js';

const USAGE = 'usage: xmrswap-watcher <start|status|pubkey> [--config <watcher.toml>]\n';

async function main(argv: string[]): Promise<number> {
  const args = argv.slice();
  const at = args.indexOf('--config');
  let configPath: string | undefined;
  if (at >= 0) {
    configPath = args[at + 1];
    if (!configPath) throw new ConfigError('--config needs a file');
    args.splice(at, 2);
  }
  const [command, ...rest] = args;
  if (rest.length > 0 || !command || !['start', 'status', 'pubkey'].includes(command)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const config = loadConfigFromProcess(process.env, process.cwd(), configPath);

  if (command === 'pubkey') {
    if (!WatcherKeys.exists(config.dataDir)) {
      const passphrase = process.env[config.passphraseEnv];
      if (!passphrase) throw new KeystoreError(`no keystore yet in the data directory; set ${config.passphraseEnv} to create one`);
      const { init } = await import('@xmrswap/sdk');
      await init();
      WatcherKeys.openOrCreate(config.dataDir, passphrase);
    }
    const k = WatcherKeys.publicKeys(config.dataDir);
    process.stdout.write(`${JSON.stringify({ solana: k.solana, ethereum: k.ethereum }, null, 2)}\n`);
    return 0;
  }

  if (command === 'status') {
    const host = config.bindHost.includes(':') ? `[${config.bindHost}]` : config.bindHost;
    let health: unknown = null;
    try {
      const res = await fetch(`http://${host}:${config.bindPort}/watch/v1/health`, { signal: AbortSignal.timeout(20_000) });
      health = await res.json();
    } catch {
      health = null;
    }
    let watches: Record<string, number> | null = null;
    const db = path.join(config.dataDir, DB_FILE);
    if (existsSync(db) && WatcherKeys.exists(config.dataDir)) {
      const store = new Store(db, WatcherKeys.publicKeys(config.dataDir));
      watches = store.countsByStatus();
      store.close();
    }
    process.stdout.write(`${JSON.stringify({ running: health !== null, health, watches }, null, 2)}\n`);
    return health !== null && (health as { ok?: boolean }).ok ? 0 : 1;
  }

  const passphrase = process.env[config.passphraseEnv];
  if (!passphrase) throw new KeystoreError(`the environment variable ${config.passphraseEnv} (the keystore passphrase) is not set`);
  const running = await startWatcher(config, { passphrase });
  process.stdout.write(`[watcher] watcher keys: solana ${running.keys.solana}, ethereum ${running.keys.ethereum}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.stop().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) process.stderr.write(`watcher: configuration error: ${err.message}\n`);
    else if (err instanceof KeystoreError || err instanceof StoreError) process.stderr.write(`watcher: ${err.message}\n`);
    else process.stderr.write(`watcher: failed${typeof (err as { code?: unknown })?.code === 'string' ? ` (${(err as { code: string }).code})` : ''}\n`);
    process.exit(err instanceof ConfigError ? 2 : 1);
  },
);
