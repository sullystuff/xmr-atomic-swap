/**
 * Logging. `info` lines are operational only (start, stop, a freeze sent, a failure class) and
 * never carry request data. `debug` lines add the swap reference and are emitted only when the
 * debug flag is on. Request bodies, notice keys, sealed keys, key material and RPC URLs are
 * never logged at any level: nothing in this package passes them to a logger.
 */
export interface Logger {
  info(message: string): void;
  debug(message: string): void;
  readonly debugEnabled: boolean;
}
export type LogSink = (line: string) => void;
export const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};
export const DEBUG_WARNING = 'WARNING: debug logging is ON. Swap references and client IP addresses are being written to the log. Turn it off for normal operation.';

export function createLogger(debugEnabled: boolean, sink: LogSink = stdoutSink): Logger {
  return {
    debugEnabled,
    info: (message) => sink(`[watcher] ${message}`),
    debug: debugEnabled ? (message) => sink(`[watcher:debug] ${message}`) : () => {},
  };
}

/** The class of an error, safe to log: a code or a constructor name, never a message (messages may embed an RPC URL). */
export function errorClass(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code)) return code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : 'error';
}
