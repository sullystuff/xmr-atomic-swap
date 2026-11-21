#!/usr/bin/env bash
# Regenerate interfaces/ethereum/IXmrSwap.abi.json from IXmrSwap.sol with forge (offline; solc
# 0.8.31). Only the owner of work package 1 runs this, and only for an agreed interface change.
#   interfaces/tools/build-abi.sh           write the ABI
#   interfaces/tools/build-abi.sh --check   fail if the committed ABI differs
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"
cp "$root/interfaces/ethereum/IXmrSwap.sol" "$work/src/"
cat > "$work/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "out"
solc = "0.8.31"
evm_version = "osaka"
offline = true
TOML
(cd "$work" && forge build --silent)
node -e '
const fs = require("fs");
const abi = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).abi;
process.stdout.write(JSON.stringify(abi, null, 2) + "\n");
' "$work/out/IXmrSwap.sol/IXmrSwap.json" > "$work/abi.json"
if [[ "${1:-}" == "--check" ]]; then
  diff -u "$root/interfaces/ethereum/IXmrSwap.abi.json" "$work/abi.json" && echo "IXmrSwap.abi.json matches IXmrSwap.sol"
else
  cp "$work/abi.json" "$root/interfaces/ethereum/IXmrSwap.abi.json"
  echo "wrote interfaces/ethereum/IXmrSwap.abi.json"
fi
