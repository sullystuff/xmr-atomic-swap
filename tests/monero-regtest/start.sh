#!/usr/bin/env bash
# Start a private regtest network: two monerod nodes (A mines, B follows over localhost p2p)
# and one monero-wallet-rpc. Idempotent.
#   ./start.sh          keep existing chain
#   ./start.sh --fresh  wipe chain + wallets first
set -euo pipefail
source "$(dirname "$0")/env.sh"
if [[ "${1:-}" == "--fresh" ]]; then "$XMR_ROOT/stop.sh" || true; rm -rf "$XMR_STATE"; fi
mkdir -p "$XMR_STATE"/{a,b,wallets,logs}

alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_node() { # name p2p rpc peer_p2p [extra monerod flags...]
  local name=$1 p2p=$2 rpc=$3 peer=$4; shift 4
  alive "$XMR_STATE/monerod-$name.pid" && return 0
  # --regtest + --fixed-difficulty 1: blocks are mined instantly on demand via generateblocks.
  # --add-exclusive-node: talk ONLY to the sibling on localhost (never to seed nodes; regtest shares
  #   mainnet's network id, so this matters). --keep-fakechain keeps the DB across restarts.
  # --rpc-access-control-origins '*': answer CORS preflights so a browser page can use the node.
  # --config-file: monerod otherwise loads ~/.bitmonero/bitmonero.conf EVEN WITH --data-dir set, silently
  #   inheriting a live node's settings (restricted-rpc, proxy, ...). Point it at our own empty file.
  : > "$XMR_STATE/$name/regtest.conf"
  nohup "$XMR_BIN/monerod" --regtest --fixed-difficulty 1 --keep-fakechain \
    --config-file "$XMR_STATE/$name/regtest.conf" \
    --data-dir "$XMR_STATE/$name" --no-igd --no-zmq --disable-dns-checkpoints --check-updates disabled \
    --p2p-bind-ip 127.0.0.1 --p2p-bind-port "$p2p" --hide-my-port --allow-local-ip \
    --add-exclusive-node "127.0.0.1:$peer" --out-peers 1 --in-peers 1 \
    --rpc-bind-ip 127.0.0.1 --rpc-bind-port "$rpc" --rpc-ssl disabled \
    --rpc-access-control-origins '*' "$@" \
    --non-interactive --log-level 0 --max-log-file-size 2000000 --log-file "$XMR_STATE/logs/monerod-$name.log" \
    >"$XMR_STATE/logs/monerod-$name.out" 2>&1 &
  echo $! > "$XMR_STATE/monerod-$name.pid"
}
wait_http() { # url body what
  for i in $(seq 1 80); do
    curl -sf -m 2 "$1" ${2:+-d "$2"} >/dev/null && return 0; sleep 0.5
  done
  echo "$3 did not come up; see $XMR_STATE/logs"; exit 1
}

start_node a "$XMR_P2P_PORT"   "$XMR_RPC_PORT"   "$XMR_P2P_PORT_B"
# Node B also exposes a RESTRICTED RPC port: what a public remote node offers.
start_node b "$XMR_P2P_PORT_B" "$XMR_RPC_PORT_B" "$XMR_P2P_PORT" --rpc-restricted-bind-port "$XMR_RPC_PORT_B_RESTRICTED"
wait_http "$XMR_DAEMON_URL/get_height" "" "monerod A"
wait_http "$XMR_DAEMON_URL_B/get_height" "" "monerod B"

if ! alive "$XMR_STATE/wallet-rpc.pid"; then
  nohup "$XMR_BIN/monero-wallet-rpc" --wallet-dir "$XMR_STATE/wallets" --disable-rpc-login \
    --rpc-bind-ip 127.0.0.1 --rpc-bind-port "$XMR_WALLET_RPC_PORT" --rpc-ssl disabled \
    --daemon-address "127.0.0.1:$XMR_RPC_PORT" --daemon-ssl disabled --trusted-daemon \
    --allow-mismatched-daemon-version --no-initial-sync \
    --log-level 0 --max-log-file-size 2000000 --log-file "$XMR_STATE/logs/wallet-rpc.log" \
    >"$XMR_STATE/logs/wallet-rpc.out" 2>&1 &
  echo $! > "$XMR_STATE/wallet-rpc.pid"
fi
wait_http "$XMR_WALLET_URL/json_rpc" '{"jsonrpc":"2.0","id":"0","method":"get_version"}' "wallet-rpc"
echo "regtest up: node A $XMR_DAEMON_URL  node B $XMR_DAEMON_URL_B  wallet-rpc $XMR_WALLET_URL  state $XMR_STATE"
