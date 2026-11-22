#!/usr/bin/env node
import { startRelay } from './app.js';
import { ConfigError, loadConfigFromProcess } from './config.js';

try {
  const relay = await startRelay(loadConfigFromProcess());
  const stop = (): void => {
    void relay.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`relay: configuration error: ${err.message}\n`);
    process.exit(2);
  }
  const code = (err as NodeJS.ErrnoException).code;
  process.stderr.write(`relay: failed to start${code ? ` (${code})` : ''}\n`);
  process.exit(1);
}
