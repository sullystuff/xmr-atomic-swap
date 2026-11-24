/**
 * Builds the adapters the settings enable, each behind the address allow-list guard.
 */
import { ChangeNowAdapter } from './adapters/changenow.js';
import { ExchangeAdapter, type ExchangeDriver } from './adapters/exchange.js';
import { FixedFloatAdapter } from './adapters/fixedfloat.js';
import { HoudiniSwapAdapter } from './adapters/houdiniswap.js';
import type { InstantDeps } from './adapters/instant.js';
import { KrakenDriver } from './adapters/kraken.js';
import { StealthExAdapter } from './adapters/stealthex.js';
import { type Allowlist, guardAdapter } from './allowlist.js';
import { type PoolDepthReader, WxmrBridgeAdapter } from './bridge/adapter.js';
import type { ReserveProofVerifier } from './bridge/heartbeat.js';
import { JupiterClient } from './bridge/jupiter.js';
import type { SolanaRpc } from './bridge/rpc.js';
import type { EnvReader, HttpClient } from './http.js';
import type { RebalanceSettings } from './settings.js';
import type { AdapterStore, AssetId, ExecContext, PriceSource, VenueAdapter, VenueId } from './types.js';

export interface AdapterDeps {
  settings: RebalanceSettings;
  /** Defaults to `settings.allowlist`. */
  allowlist?: Allowlist;
  http: HttpClient;
  prices: PriceSource;
  env?: EnvReader;
  store?: AdapterStore;
  now?: () => number;
  depositFeeUsd?: (asset: AssetId) => number;
  /** Needed for the wXMR bridge. Without both, the bridge adapter is not built. */
  solanaRpc?: SolanaRpc;
  solanaWallet?: string;
  reserveVerifier?: ReserveProofVerifier;
  poolDepth?: PoolDepthReader;
  execContext?: ExecContext;
  jupiterBaseUrl?: string;
  /** @deprecated Set `[rebalance.venues.exchange.withdraw_keys]` instead; entries there take precedence over these. */
  exchangeWithdrawKeys?: Record<string, string>;
  /** Overrides the built-in driver lookup by `name`. */
  exchangeDriver?: ExchangeDriver;
}

export interface BuiltAdapters { adapters: Partial<Record<VenueId, VenueAdapter>>; warnings: string[] }

export function createAdapters(d: AdapterDeps): BuiltAdapters {
  const allow = d.allowlist ?? d.settings.allowlist;
  const v = d.settings.venues;
  const adapters: Partial<Record<VenueId, VenueAdapter>> = {};
  const warnings: string[] = [];
  const instant = (s: { api_key_env?: string | undefined; api_secret_env?: string | undefined }): InstantDeps => {
    const deps: InstantDeps = { http: d.http, prices: d.prices, apiKeyEnv: s.api_key_env, apiSecretEnv: s.api_secret_env };
    if (d.env) deps.env = d.env;
    if (d.now) deps.now = d.now;
    if (d.depositFeeUsd) deps.depositFeeUsd = d.depositFeeUsd;
    return deps;
  };

  if (v.changenow.enabled) adapters.changenow = guardAdapter(new ChangeNowAdapter(instant(v.changenow)), allow);
  if (v.fixedfloat.enabled) adapters.fixedfloat = guardAdapter(new FixedFloatAdapter(instant(v.fixedfloat)), allow);
  if (v.stealthex.enabled) adapters.stealthex = guardAdapter(new StealthExAdapter(instant(v.stealthex)), allow);
  if (v.houdiniswap.enabled) adapters.houdiniswap = guardAdapter(new HoudiniSwapAdapter(instant(v.houdiniswap)), allow);

  if (v.exchange.enabled) {
    let driver = d.exchangeDriver;
    if (!driver && v.exchange.name?.toLowerCase() === 'kraken') {
      const withdrawKeys = { ...(d.exchangeWithdrawKeys ?? {}), ...v.exchange.withdraw_keys };
      for (const address of Object.keys(withdrawKeys)) {
        const onList = allow.xmr.includes(address) || allow.sol.includes(address) || allow.eth.some((a) => a.toLowerCase() === address.toLowerCase());
        if (!onList) warnings.push(`rebalance.venues.exchange.withdraw_keys has an address that is not on the allow-list (key "${withdrawKeys[address]}"); withdrawals to it are refused`);
      }
      if (Object.keys(withdrawKeys).length === 0) warnings.push('rebalance.venues.exchange.withdraw_keys is empty: the exchange cannot withdraw to any address');
      driver = new KrakenDriver({ http: d.http, apiKeyEnv: v.exchange.api_key_env, apiSecretEnv: v.exchange.api_secret_env, withdrawKeys, allowlist: allow, ...(d.env ? { env: d.env } : {}) });
    }
    if (!driver) warnings.push(`rebalance.venues.exchange.name "${v.exchange.name ?? ''}" has no driver; the exchange venue is off`);
    else adapters.exchange = guardAdapter(new ExchangeAdapter({ driver, prices: d.prices, ...(d.store ? { store: d.store } : {}), ...(d.now ? { now: d.now } : {}), ...(d.depositFeeUsd ? { depositFeeUsd: d.depositFeeUsd } : {}) }), allow);
  }

  if (v.wxmr_bridge.enabled) {
    if (!d.solanaRpc || !d.solanaWallet) warnings.push('the wXMR bridge is enabled but no Solana RPC or wallet was supplied; the bridge venue is off');
    else {
      adapters.wxmr_bridge = guardAdapter(new WxmrBridgeAdapter({
        rpc: d.solanaRpc, wallet: d.solanaWallet, prices: d.prices, settings: v.wxmr_bridge, allowlist: allow,
        jupiter: new JupiterClient({ http: d.http, ...(d.jupiterBaseUrl ? { baseUrl: d.jupiterBaseUrl } : {}) }),
        ...(d.store ? { store: d.store } : {}), ...(d.now ? { now: d.now } : {}), ...(d.reserveVerifier ? { reserveVerifier: d.reserveVerifier } : {}),
        ...(d.poolDepth ? { poolDepth: d.poolDepth } : {}), ...(d.execContext ? { execContext: d.execContext } : {}),
      }), allow);
    }
  }
  return { adapters, warnings };
}
