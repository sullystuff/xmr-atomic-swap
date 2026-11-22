/**
 * `@xmrswap/relay`: the Tor relay for the taker web UI and the allow-listed Monero node proxy
 * (SPEC 6.5). Start it with `startRelay(loadConfigFromProcess())` or the `xmrswap-relay` binary.
 */
export { createRelay, startRelay, type Relay, type RelayDeps, type RunningRelay } from './app.js';
export { ConfigError, DEFAULTS, isLoopback, loadConfig, loadConfigFromProcess, normaliseMoneroNode, type LoadOptions, type RelayConfig } from './config.js';
export { DEBUG_WARNING, createLogger, stdoutSink, type LogSink, type Logger } from './log.js';
export { decodeBase64, isOnionHost, makerRouteOf, methodAllowed, type MakerRoute } from './onion.js';
export { RateLimiter, type RateLimitOptions } from './ratelimit.js';
export {
  RegistryCache,
  SolanaRegistrySource,
  emptyRegistrySource,
  type RegistryCacheOptions,
  type RegistrySnapshot,
  type RegistrySource,
} from './registry.js';
export { UpstreamError, probeSocks, upstreamFetch, type UpstreamErrorCode, type UpstreamRequest, type UpstreamResponse } from './upstream.js';
