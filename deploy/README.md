# Self-hosting bundle (`@xmrswap/deploy`)

Runs the taker web UI and the relay together on your own machine, on one loopback address, with Node only. The user guide is [`docs/self-hosting/`](../docs/self-hosting/README.md); start there.

The software is unaudited, the contracts are upgradable by the project owner until frozen, and closing the tab at the wrong moment during a swap can lose funds.

| Command (from the repository root) | What it does |
| --- | --- |
| `pnpm --filter @xmrswap/deploy start` | Serves the built UI on `127.0.0.1:8780`, starts the relay on `127.0.0.1:8787`, and says how to get a Tor proxy if none answers. It never starts or changes Tor. |
| `pnpm --filter @xmrswap/deploy run status` | Checks the running bundle: UI, relay, Tor proxy, Solana RPC, Monero nodes. Exit 1 if anything fails. `--json` for scripts. |
| `pnpm --filter @xmrswap/deploy run settings` | Prints the effective settings (never an RPC URL). |
| `pnpm --filter @xmrswap/deploy run pinned` | Prints the program id and contract address the release pins. |
| `pnpm --filter @xmrswap/deploy run release` | Builds the program, the taker UI and the console from one commit, twice, in two directories; refuses unless they are identical; writes `deploy/release/` (`--record`: also `releases/<version>/`). Deploys and publishes nothing. |
| `pnpm --filter @xmrswap/deploy run verify <record>` | Compares files on disk, or a rebuild from the record's commit, with a record. `--onchain` also compares a deployed program (nothing is deployed yet). |
| `bash deploy/scripts/program-docker-build.sh` | The canonical program build: `solana-verify build` in a pinned Docker image, twice. `--record <dir>` adds its hash to a record. |
| `node deploy/scripts/verify.mjs <dir>` | Verifies a directory against its `SHA256SUMS`. No dependencies. |
| `pnpm --filter @xmrswap/deploy run docs` | Regenerates the settings tables in the docs and `xmrswap.example.toml` (`--check` only compares). |
| `pnpm --filter @xmrswap/deploy test` | The acceptance command. Loopback fakes only; needs a Chromium for the Status-page test, and the build tools plus `solana-verify` for the double-build check (about three minutes; `run test:determinism` runs that part alone). |

| File | Purpose |
| --- | --- |
| `xmrswap.example.toml` | Every setting with its default. Copy to `xmrswap.toml`. |
| `src/` | `settings.ts` (the one list of settings), `server.ts` (static files and the proxy to the relay), `checks.ts` (status), `cli.ts`. |
| `src/release/` | The checkable build: `build.ts` (staging builds), `manifest.ts` (the record), `cid.ts` (offline IPFS CID), `onchain.ts` (deployed program hash), `cli.ts`. |
| `release.schema.json` | The format of a record's `release.json`. |
| `scripts/` | `checksums.mjs`, `verify.mjs`, `program-docker-build.sh`, `ensure-ui.mjs`. |
| `systemd/xmrswap-selfhost.service` | Example user unit. Not installed by anything. |
| `compose.yaml`, `compose.schema.json`, `docker/` | For Docker users. Validated as YAML against the schema by the tests; the images were built once by hand with rootless Docker. |
| `DEVIATIONS.md` | Where this package differs from the specification, and requests to other packages. |

## What the hashes mean

Records live in [`../releases/`](../releases/). Each has a `release.json` (commit, tool versions, hashes) and the two file lists it commits to. [`docs/self-hosting/verifying-the-download.md`](../docs/self-hosting/verifying-the-download.md) explains every hash and gives the check commands with their output. In short:

- A front end's **tree hash** is the SHA-256 of its sorted `sha256sum` listing; the **CID** is its IPFS address, computed offline (nothing is published).
- The program's **executable hash** is what `solana-verify` prints. Two builds are recorded and never compared with each other: `local-sbf` (this machine's tools) and `solana-verify-docker` (the canonical one).
- The only record today is `dev-snapshot`. It is not a release. Nothing is deployed, so there is no on-chain program to verify, and no third party has verified anything.
- A match shows that a build came from the recorded commit. It does not show that the source is safe: the software is unaudited.
