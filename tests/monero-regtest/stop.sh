#!/usr/bin/env bash
# Stop ONLY the processes this harness started (by pidfile). Never pkill by name:
# other monerod / wallet-rpc instances may run on this machine.
source "$(dirname "$0")/env.sh"
for name in wallet-rpc monerod-b monerod-a; do
  f="$XMR_STATE/$name.pid"
  if [[ -f "$f" ]]; then
    pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null && grep -q "$XMR_STATE" "/proc/$pid/cmdline" 2>/dev/null; then
      kill "$pid"; for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
      echo "stopped $name ($pid)"
    fi
    rm -f "$f"
  fi
done
