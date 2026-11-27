#!/usr/bin/env bash
# Start the rootless Docker daemon by hand, for a user whose systemd user manager is not
# running (so `systemctl --user` cannot manage it). No sudo. Safe to run twice.
#
#   bash scripts/docker-rootless-start.sh          start if not running
#   bash scripts/docker-rootless-start.sh stop     stop it
#
# Without a user systemd bus the daemon cannot use the systemd cgroup driver, so this
# writes ~/.config/docker/daemon.json with the cgroupfs driver if that file does not exist.
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PATH="/usr/bin:/sbin:/usr/sbin:$PATH"
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/docker-rootless"
mkdir -p "$LOG_DIR"

if [[ "${1:-start}" == "stop" ]]; then
  pkill -u "$(id -u)" -f "^rootlesskit --state-dir=${XDG_RUNTIME_DIR}/dockerd-rootless" || true
  echo "stopped"
  exit 0
fi

if docker info >/dev/null 2>&1; then
  echo "rootless Docker is already running ($DOCKER_HOST)"
  exit 0
fi

mkdir -p "$HOME/.config/docker"
if [[ ! -e "$HOME/.config/docker/daemon.json" ]]; then
  printf '{\n  "exec-opts": ["native.cgroupdriver=cgroupfs"]\n}\n' > "$HOME/.config/docker/daemon.json"
fi

(setsid nohup dockerd-rootless.sh > "$LOG_DIR/dockerd.log" 2>&1 &)
for _ in $(seq 1 40); do
  if docker info >/dev/null 2>&1; then
    docker info --format 'Docker {{.ServerVersion}}, cgroup driver {{.CgroupDriver}}, data in {{.DockerRootDir}}'
    echo "export DOCKER_HOST=$DOCKER_HOST"
    exit 0
  fi
  sleep 1
done
echo "the daemon did not come up; see $LOG_DIR/dockerd.log" >&2
exit 1
