/**
 * Logging. SPEC 6.5: no message logs by default: no bodies, no onion addresses, no client IPs.
 *
 * `info` lines are operational only (start, shutdown, configuration warnings) and never carry
 * request data. `debug` lines carry request metadata (client IP, destination, sizes) and are
 * emitted only when the debug flag is on. Bodies are never logged at any level.
 */
export interface Logger {
  info(message: string): void;
  /** Request metadata. Dropped unless the debug flag is on. */
  debug(message: string): void;
  readonly debugEnabled: boolean;
}

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export const DEBUG_WARNING =
  'WARNING: debug logging is ON. Client IP addresses and the onion addresses they contact are being written to the log. Turn it off for normal operation.';

export function createLogger(debugEnabled: boolean, sink: LogSink = stdoutSink): Logger {
  return {
    debugEnabled,
    info: (message) => sink(`[relay] ${message}`),
    debug: debugEnabled ? (message) => sink(`[relay:debug] ${message}`) : () => {},
  };
}
