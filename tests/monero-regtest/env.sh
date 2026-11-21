# Shared settings for the Monero regtest harness. Source this; do not execute.
# Ports are deliberately far from Monero defaults (18080-18089, 28080-28089, 38080-38089)
# so nothing already running on this machine is disturbed.
export XMR_BIN="${XMR_BIN:-/home/sully/monero}"           # dir holding monerod + monero-wallet-rpc
export XMR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Throwaway state (chains, wallets, logs, pidfiles) always lives under <repo>/.scratch/monero/state,
# which is gitignored, whether the harness runs from tests/monero-regtest or from .scratch/monero.
if [[ -z "${XMR_STATE:-}" ]]; then
  case "$XMR_ROOT" in
    */.scratch/monero) XMR_STATE="$XMR_ROOT/state" ;;
    *) XMR_STATE="$(cd "$XMR_ROOT/../.." && pwd)/.scratch/monero/state" ;;
  esac
fi
export XMR_STATE
export XMR_P2P_PORT=48080  XMR_RPC_PORT=48081      # node A (the one we mine on)
export XMR_P2P_PORT_B=48084 XMR_RPC_PORT_B=48085   # node B (independent second opinion, syncs from A over p2p)
export XMR_RPC_PORT_B_RESTRICTED=48086           # node B again, restricted RPC (like a public node)
export XMR_WALLET_RPC_PORT=48083                   # monero-wallet-rpc (miner/maker/sweeper wallets)
export XMR_DAEMON_URL="http://127.0.0.1:$XMR_RPC_PORT"
export XMR_DAEMON_URL_B="http://127.0.0.1:$XMR_RPC_PORT_B"
export XMR_DAEMON_URL_B_RESTRICTED="http://127.0.0.1:$XMR_RPC_PORT_B_RESTRICTED"
export XMR_WALLET_URL="http://127.0.0.1:$XMR_WALLET_RPC_PORT"
