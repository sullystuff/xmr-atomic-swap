/**
 * A file that sets every key the daemon's schema defines (packages/daemon/src/config/schema.ts
 * and @xmrswap/rebalancer's settings), written the way the serialiser writes scalars so lines
 * can be compared byte for byte.
 */
const OFFER = `enabled = true
source = "coingecko"
fallbacks = [ "coinmarketcap" ]
cross_check = "coinmarketcap"
deviation_pct = 1.5
size_tiers = [ { above_xmr = 20, extra_pct = 0.5 } ]
inventory_skew_max_pct = 1
min_xmr = 0.1
max_xmr = 40
offer_valid_seconds = 90
confirmation_depth = [ { above_xmr = 0, depth = 2 }, { above_xmr = 1, depth = 10 } ]
notice_seconds = 1800
final_days = 7
deposit_pct = 2
daily_cap_xmr = 2000
approval_mode = "window"
approval_window_seconds = 60
claim_delay_minutes = 200
claim_window_minutes = 90
withhold_policy = "price_moved"
withhold_move_pct = 1.5
volatility_widen = { per_pct_move = 0.2, max_pct = 2 }
without_ready = "abort"
`;

export const FULL_DAEMON_TOML = `[pricing]
refresh_seconds = 15
max_age_seconds = 60
cross_check = "coinmarketcap"
max_disagreement_pct = 1
on_failure = "widen"
widen_pct = 0.5

[pricing.sources.coingecko]
api_key_env = "COINGECKO_KEY"
min_interval_seconds = 10
base_url = "http://127.0.0.1:9000"

[pricing.sources.coinmarketcap]
api_key_env = "CMC_KEY"
min_interval_seconds = 30
base_url = "http://127.0.0.1:9001"

[pricing.sources.wxmr_pool]
token = "WXMRexampleToken"
pool = "PoolExampleAddress"
base_vault = "BaseVaultExample"
quote_vault = "QuoteVaultExample"
quote = "usdc"
min_liquidity_usd = 250000
average_seconds = 300

[pricing.sources.wxmr_pool_sol]
token = "WXMRexampleToken"
pool = "SolPoolExampleAddress"
base_vault = "SolBaseVaultExample"
quote_vault = "SolQuoteVaultExample"
quote = "sol"
min_liquidity_usd = 0
average_seconds = 300

${(['usdc_sol', 'sol', 'usdc_eth', 'eth'] as const).map((m) => `[markets.${m}.sell_xmr]\n${OFFER}\n[markets.${m}.buy_xmr]\n${OFFER}`).join('\n')}
[liquidity]
xmr_reserve = 50
output_ladder = [ { size_xmr = 5, count = 20 }, { size_xmr = 50, count = 6 } ]
max_in_flight_xmr = 400
max_per_taker_xmr = 100
allocation = { usdc_sol = 100, sol = 100, usdc_eth = 50, eth = 50 }
paying_caps = { sol = 300, eth = 5, usdc_sol = 60000, usdc_eth = 20000 }
targets = { xmr = 400, sol = 200, eth = 3, usdc_sol = 50000, usdc_eth = 10000 }
ladder_headroom_pct = 1.5

[guardrails]
volatility_pause = { move_pct = 3, window_seconds = 600 }
disagreement_pause = true
stale_pause = true
price_band_usd = { min = 300, max = 900 }
dry_run = false
reorg_guard = { enabled = true, raise_depth_to = 30 }

[rebalance]
mode = "approve"
max_cost_pct = 1.5
max_in_transit_usd = 50000
test_transfer_usd = 50

[rebalance.levels.xmr]
low = 150
target = 400
high = 700

[rebalance.levels.sol]
low = 10
target = 100
high = 500

[rebalance.levels.eth]
low = 1
target = 2
high = 5

[rebalance.levels.usdc_sol]
low = 1000
target = 50000
high = 120000

[rebalance.levels.usdc_eth]
low = 1000
target = 10000
high = 30000

[rebalance.routing]
choose = "best_quote"
priority = [ "wxmr_bridge", "exchange", "changenow" ]
max_per_tx_usd = 20000
max_per_day_usd = 150000
max_share_pct = 60
cooldown_minutes = 30
venue_timeout_minutes = 120
schedule = "every 6h"

[rebalance.allowlist]
xmr = [ "4OwnInventoryAddressExample" ]
sol = [ "OwnSolAddressExample" ]
eth = [ "0x00000000000000000000000000000000000000ee" ]

[rebalance.cross_chain]
enabled = true
venue = "changenow"
max_per_tx_usd = 5000
max_cost_pct = 1

[rebalance.venues.wxmr_bridge]
enabled = true
mode = "auto"
max_cost_pct = 1
max_per_tx_usd = 10000
max_per_day_usd = 50000
max_share_pct = 50
max_piece_pct_of_pool = 2
max_wxmr_held = 5
redeem_immediately = true
require_heartbeat = true
reserve_proof_check_above_xmr = 50
stalled_redeem_minutes = 60

[rebalance.venues.exchange]
enabled = true
mode = "approve"
max_cost_pct = 1
max_per_tx_usd = 10000
max_per_day_usd = 50000
max_share_pct = 50
name = "kraken"
api_key_env = "EXCHANGE_KEY"
api_secret_env = "EXCHANGE_SECRET"
withdraw_address_allowlist = true

[rebalance.venues.exchange.withdraw_keys]
4OwnInventoryAddressExample = "xmr-main"
OwnSolAddressExample = "sol-main"
"0x00000000000000000000000000000000000000ee" = "eth-main"

${(['changenow', 'stealthex', 'houdiniswap', 'fixedfloat'] as const)
  .map((v) => `[rebalance.venues.${v}]\nenabled = ${v === 'changenow'}\nmode = "alert"\nmax_cost_pct = 1\nmax_per_tx_usd = 10000\nmax_per_day_usd = 50000\nmax_share_pct = 50\nrate = "fixed"\napi_key_env = "${v.toUpperCase()}_KEY"\napi_secret_env = "${v.toUpperCase()}_SECRET"\n`)
  .join('\n')}
[daemon]
data_dir = "./data"
api_bind = "127.0.0.1:7071"
mode = "live"
keystore_passphrase_env = "XMRSWAP_KEYSTORE_PASSPHRASE"
console_dir = "./console"
cors_origins = [ "http://127.0.0.1:5183" ]

[solana]
rpc_url_env = "SOLANA_RPC_URL"
ws_url_env = "SOLANA_WS_URL"
fallback_rpc_url_envs = [ "SOLANA_RPC_URL_2" ]
program_id = "ProgramIdExample"
expected_genesis = "GenesisExample"
priority_fee_microlamports = 1000
maker_owner = "OwnerKeyExample"
subscriptions = true

[ethereum]
rpc_url_env = "ETHEREUM_RPC_URL"
fallback_rpc_url_envs = [ "ETHEREUM_RPC_URL_2" ]
contract = "0x00000000000000000000000000000000000000c0"
chain_id = 1
finality = "finalized"
private_tx_url_env = "PRIVATE_TX_URL"
max_fee_gwei = 80
maker_owner = "0x00000000000000000000000000000000000000a0"
from_block = 100

[monero]
network = "mainnet"
node_url_envs = [ "MONERO_NODE_A", "MONERO_NODE_B" ]
own_node = false
wallet_rpc_url_env = "MONERO_WALLET_RPC_URL"
wallet_rpc_user_env = "MONERO_WALLET_RPC_USER"
wallet_rpc_password_env = "MONERO_WALLET_RPC_PASSWORD"
sweep_max_fee = 5000000000

[offers]
update_interval_seconds = 15
price_move_trigger_pct = 0.25
min_refresh_interval_seconds = 30
key_pool_low_water = 4
eth_pool_size = 64

[rotation]
interval_hours = 168
grace_hours = 24

[tor]
enabled = true
listen = "127.0.0.1:7072"
hostname_file = "./tor/hostname"
publish = true

[approvals]
allow = [ "AllowedTakerExample" ]
deny = [ "DeniedTakerExample" ]
auto_max_xmr = 25
advance = [ { taker = "RegularTakerExample", max_xmr = 100, days = 30 } ]

[inbox]
policy = "swap_only"

[alerts]
webhook_url_env = "ALERT_WEBHOOK_URL"
fee_runway_days = 7

[registration]
contacts = [ { kind = 5, value = "https://blobs.example.org/xs" } ]
`;

/** Every `key = value` line of a TOML text under its table header, as `table|line`. */
export function keyLines(toml: string): Set<string> {
  const out = new Set<string>();
  let table = '';
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) table = line;
    else out.add(`${table}|${line}`);
  }
  return out;
}
