#!/usr/bin/env bash
# Install Docker in ROOTLESS mode for one user, for the reproducible program build
# (`solana-verify build`). Debian 12/13.
#
# Run once:   sudo bash scripts/setup-docker-rootless.sh [username]
#
# Why rootless, and what this script deliberately avoids:
#   - The ordinary root Docker daemon rewrites the host firewall when it starts and sets
#     the FORWARD policy to DROP. On a machine that also forwards traffic for libvirt
#     guests (virbr0) or WireGuard (wg0), that can cut those off. So the system-wide
#     docker.service and docker.socket are MASKED before the packages are installed and
#     are never started.
#   - Nobody is added to the `docker` group (membership is equivalent to root).
#   - The daemon runs as the user, under `systemctl --user`, with its data in
#     ~/.local/share/docker. Containers reach the network through slirp4netns; no host
#     firewall rule is added and no port is published.
#
# What it changes on the system:
#   - adds Docker's apt repository and signing key (/etc/apt/keyrings/docker.asc,
#     /etc/apt/sources.list.d/docker.list)
#   - installs: docker-ce docker-ce-cli containerd.io docker-buildx-plugin
#               docker-ce-rootless-extras uidmap slirp4netns dbus-user-session
#               fuse-overlayfs ca-certificates curl
#   - masks docker.service and docker.socket; leaves containerd.service disabled
#   - makes sure the user has subordinate uid/gid ranges (/etc/subuid, /etc/subgid)
#   - enables lingering for the user, so the user daemon survives logout
#   - as the user: installs and starts the rootless daemon (~/.config/systemd/user/docker.service)
#
# Undo:  as the user  `dockerd-rootless-setuptool.sh uninstall && rootlesskit rm -rf ~/.local/share/docker`
#        then as root `apt-get purge docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras`
#                     `systemctl unmask docker.service docker.socket`
#                     `rm /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc`

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash $0 [username]" >&2
  exit 1
fi

TARGET_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "Could not tell which user to set Docker up for. Pass it: sudo bash $0 <username>" >&2
  exit 1
fi
if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "No such user: $TARGET_USER" >&2
  exit 1
fi
TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"

. /etc/os-release
if [[ "${ID:-}" != "debian" ]]; then
  echo "This script is written for Debian (found: ${ID:-unknown}). Stopping." >&2
  exit 1
fi
CODENAME="${VERSION_CODENAME:?no VERSION_CODENAME in /etc/os-release}"
ARCH="$(dpkg --print-architecture)"

echo "==> Setting up rootless Docker for user '$TARGET_USER' on Debian $CODENAME ($ARCH)"

# Unprivileged user namespaces are required for rootless mode.
if [[ -r /proc/sys/kernel/unprivileged_userns_clone ]] && [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" != "1" ]]; then
  echo "kernel.unprivileged_userns_clone is 0: rootless Docker cannot run." >&2
  echo "Enable it yourself if you want this (sysctl kernel.unprivileged_userns_clone=1), then re-run." >&2
  exit 1
fi

# 1. Make sure the root daemon can never start, BEFORE its package is installed.
#    (The package's post-install step would otherwise start it and rewrite the firewall.)
echo "==> Masking the system-wide docker.service and docker.socket"
systemctl mask docker.service docker.socket >/dev/null 2>&1 || true

# 2. Docker's apt repository.
echo "==> Adding Docker's apt repository"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq

# 3. Packages.
echo "==> Installing packages"
apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras \
  uidmap slirp4netns dbus-user-session fuse-overlayfs >/dev/null

# The root daemon must be down and stay down. containerd is not needed system-wide either.
systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true
systemctl mask docker.service docker.socket >/dev/null 2>&1 || true
systemctl disable --now containerd.service >/dev/null 2>&1 || true
if systemctl is-active --quiet docker.service; then
  echo "The system docker.service is running although it was masked. Stopping here; nothing else was changed." >&2
  exit 1
fi

# 4. Subordinate id ranges for the user.
ensure_subid() {
  local file="$1"
  if ! grep -q "^${TARGET_USER}:" "$file" 2>/dev/null; then
    echo "==> Adding a subordinate id range for $TARGET_USER to $file"
    # Pick a range above every existing one.
    local start
    start="$(awk -F: 'BEGIN{m=100000} {e=$2+$3; if (e>m) m=e} END{print m}' "$file" 2>/dev/null || echo 100000)"
    echo "${TARGET_USER}:${start}:65536" >> "$file"
  fi
}
touch /etc/subuid /etc/subgid
ensure_subid /etc/subuid
ensure_subid /etc/subgid

# 5. Let the user's services run without an open login session.
echo "==> Enabling lingering for $TARGET_USER"
loginctl enable-linger "$TARGET_USER"

# Wait for the user's runtime directory and bus.
for _ in $(seq 1 20); do
  [[ -S "/run/user/${TARGET_UID}/bus" ]] && break
  sleep 0.5
done
# A socket file can be left behind by a user manager that is no longer running, so test
# the manager itself, not the file.
if ! systemctl is-active --quiet "user@${TARGET_UID}.service"; then
  echo "==> Packages are installed, but the systemd user manager for $TARGET_USER is not running"
  echo "    (systemctl status user@${TARGET_UID}.service). The rootless daemon cannot be managed by"
  echo "    systemd until it is. Start it by hand instead, as $TARGET_USER, without sudo:"
  echo "      bash $(dirname "$0")/docker-rootless-start.sh"
  echo "    System docker.service: $(systemctl is-enabled docker.service 2>/dev/null || true) / $(systemctl is-active docker.service 2>/dev/null || true)"
  exit 0
fi

# 6. The rootless daemon, installed and started as the user.
echo "==> Installing the rootless daemon as $TARGET_USER"
as_user() {
  sudo -u "$TARGET_USER" -H env \
    XDG_RUNTIME_DIR="/run/user/${TARGET_UID}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${TARGET_UID}/bus" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@"
}
as_user dockerd-rootless-setuptool.sh install
as_user systemctl --user enable --now docker.service

# 7. Point the user's `docker` at the rootless socket.
PROFILE_LINE="export DOCKER_HOST=unix:///run/user/${TARGET_UID}/docker.sock"
for rc in "$TARGET_HOME/.profile" "$TARGET_HOME/.bashrc"; do
  if [[ -f "$rc" ]] && ! grep -qF "$PROFILE_LINE" "$rc"; then
    printf '\n# Rootless Docker\n%s\n' "$PROFILE_LINE" >> "$rc"
    chown "$TARGET_USER": "$rc"
  fi
done

# 8. Check.
echo "==> Checking"
if as_user env DOCKER_HOST="unix:///run/user/${TARGET_UID}/docker.sock" docker info --format '{{.ServerVersion}} rootless={{range .SecurityOptions}}{{.}} {{end}}' 2>/dev/null | grep -q rootless; then
  as_user env DOCKER_HOST="unix:///run/user/${TARGET_UID}/docker.sock" docker info --format 'Docker {{.ServerVersion}}, storage driver {{.Driver}}, data in {{.DockerRootDir}}'
  echo "==> Done. Rootless Docker is running for $TARGET_USER."
  echo "    System docker.service: $(systemctl is-enabled docker.service 2>/dev/null || true) / $(systemctl is-active docker.service 2>/dev/null || true)"
  echo "    New shells have DOCKER_HOST set; in an existing shell run:"
  echo "      $PROFILE_LINE"
  echo "    Free space on the data volume:"
  df -h "$TARGET_HOME" | tail -1
else
  echo "Docker was installed but the rootless daemon did not answer. See:" >&2
  echo "  sudo -u $TARGET_USER XDG_RUNTIME_DIR=/run/user/${TARGET_UID} journalctl --user -u docker.service -n 50" >&2
  exit 1
fi
