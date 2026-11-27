#!/usr/bin/env bash
# The canonical, deterministic build of the Solana program: `solana-verify build`, which compiles
# inside a Docker image pinned by digest. This is the build a third party can repeat on any
# machine, and the one a release's program hash must come from.
#
#   bash deploy/scripts/program-docker-build.sh [<commit>] [--record releases/<version>]
#
# It exports <commit> (default HEAD; with --record: the record's commit) of solana/program into
# two fresh temporary directories, builds each in Docker, and requires the two executable hashes
# to be equal. With --record it then adds the hash to that record with method
# "solana-verify-docker". It builds only: no wallet, no cluster, no deployment, no published port.
#
# Needs: Docker (rootless is fine; set DOCKER_HOST), git, and solana-verify 0.4 or later
# (0.2 cannot read this program's Cargo.lock). The pinned version is installed with:
#   cargo install solana-verify --version 0.4.11 --locked
# $SOLANA_VERIFY names the binary; otherwise deploy/.tools/bin/solana-verify, then the PATH.
# The first run downloads the build image (about 3 GB) and the program's crates.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
commit=""
record=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --record) record="${2:?--record needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) commit="$1"; shift ;;
  esac
done

sv="${SOLANA_VERIFY:-}"
if [[ -z "$sv" ]]; then
  if [[ -x "$here/../.tools/bin/solana-verify" ]]; then sv="$here/../.tools/bin/solana-verify"; else sv="solana-verify"; fi
fi
command -v "$sv" >/dev/null || { echo "solana-verify not found. Install it: cargo install solana-verify --version 0.4.11 --locked" >&2; exit 1; }
tool="$("$sv" --version | awk '{print $2}')"
case "$tool" in 0.1.*|0.2.*|0.3.*) echo "solana-verify $tool is too old for this program's Cargo.lock; install 0.4.11" >&2; exit 1 ;; esac
docker info >/dev/null 2>&1 || { echo "Docker is not reachable. Start it (rootless: set DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock)." >&2; exit 1; }

if [[ -n "$record" ]]; then
  [[ "$record" = /* ]] || record="$PWD/$record"
  [[ -f "$record/release.json" ]] || { echo "$record/release.json does not exist" >&2; exit 1; }
  recorded="$(sed -n 's/^  "commit": "\([0-9a-f]\{40\}\)",$/\1/p' "$record/release.json")"
  [[ -n "$recorded" ]] || { echo "no commit in $record/release.json" >&2; exit 1; }
  if [[ -n "$commit" && "$(git -C "$repo" rev-parse "$commit^{commit}")" != "$recorded" ]]; then echo "the record is of commit $recorded, not $commit" >&2; exit 1; fi
  commit="$recorded"
fi
commit="$(git -C "$repo" rev-parse --verify "${commit:-HEAD}^{commit}")"

work="$(mktemp -d "${TMPDIR:-/tmp}/xmrswap-program-docker-XXXXXX")"
# solana-verify reads the Solana CLI's configuration from the home directory. It is given an empty one.
mkdir -p "$work/home"
build() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$repo" archive --format=tar "$commit" solana/program | tar -x -C "$dir"
  (cd "$dir/solana/program" && HOME="$work/home" DOCKER_HOST="${DOCKER_HOST:-}" "$sv" build --library-name xmr_swap) > "$dir/build.log" 2>&1 \
    || { tail -30 "$dir/build.log" >&2; echo "the Docker build failed; full log: $dir/build.log" >&2; exit 1; }
  HOME="$work/home" "$sv" get-executable-hash "$dir/solana/program/target/deploy/xmr_swap.so" | tail -1
}

echo "Building solana/program of commit $commit in Docker with solana-verify $tool, twice."
one="$(build "$work/one")"
echo "build 1: executable hash $one"
two="$(build "$work/second-build/in-a-deeper-directory")"
echo "build 2: executable hash $two"
if [[ "$one" != "$two" ]]; then
  echo "The two Docker builds are NOT identical. Kept for inspection: $work" >&2
  exit 1
fi
echo "The two Docker builds are identical."
image="$(docker image ls --digests --format '{{.Repository}}@{{.Digest}}' solanafoundation/solana-verifiable-build | head -1)"
echo "image: ${image:-unknown}"

so="$work/one/solana/program/target/deploy/xmr_swap.so"
if [[ -n "$record" ]]; then
  (cd "$repo" && pnpm --filter @xmrswap/deploy run add-program "$record" "$so" --method solana-verify-docker --double-build identical --tool "$tool" ${image:+--image "$image"})
  rm -rf "$work"
else
  mkdir -p "$here/../.build/program-docker"
  cp "$so" "$here/../.build/program-docker/xmr_swap.so"
  echo "binary: deploy/.build/program-docker/xmr_swap.so"
  rm -rf "$work"
fi
echo "Nothing was deployed. To compare a deployed program later: solana-verify get-program-hash -u <your RPC URL> <program id>"
