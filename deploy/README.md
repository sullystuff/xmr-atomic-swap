# Self-hosting bundle (`@xmrswap/deploy`)

Runs the taker web UI and the relay together on your own machine, on one loopback address, with Node only. The user guide is [`docs/self-hosting/`](../docs/self-hosting/README.md); start there.

The software is unaudited, the contracts are upgradable by the project owner until frozen, and closing the tab at the wrong moment during a swap can lose funds.

| Command (from the repository root) | What it does |
| --- | --- |
| `pnpm --filter @xmrswap/deploy start` | Serves the built UI on `127.0.0.1:8780`, starts the relay on `127.0.0.1:8787`, and says how to get a Tor proxy if none answers. It never starts or changes Tor. |
| `pnpm --filter @xmrswap/deploy run status` | Checks the running bundle: UI, relay, Tor proxy, Solana RPC, Monero nodes. Exit 1 if anything fails. `--json` for scripts. |
| `pnpm --filter @xmrswap/deploy run settings` | Prints the effective settings (never an RPC URL). |
| `pnpm --filter @xmrswap/deploy run pinned` | Prints the program id and contract address the release pins. |
| `pnpm --filter @xmrswap/deploy run release` | Copies the built UI into `deploy/release/` with `release.json` and `SHA256SUMS`. |
| `node deploy/scripts/verify.mjs <dir>` | Verifies a directory against its `SHA256SUMS`. No dependencies. |
| `pnpm --filter @xmrswap/deploy run docs` | Regenerates the settings tables in the docs and `xmrswap.example.toml` (`--check` only compares). |
| `pnpm --filter @xmrswap/deploy test` | The acceptance command. Loopback fakes only; needs a Chromium for the Status-page test. |

| File | Purpose |
| --- | --- |
| `xmrswap.example.toml` | Every setting with its default. Copy to `xmrswap.toml`. |
| `src/` | `settings.ts` (the one list of settings), `server.ts` (static files and the proxy to the relay), `checks.ts` (status), `cli.ts`. |
| `scripts/` | `checksums.mjs`, `verify.mjs`, `release.mjs`, `ensure-ui.mjs`. |
| `systemd/xmrswap-selfhost.service` | Example user unit. Not installed by anything. |
| `compose.yaml`, `compose.schema.json`, `docker/` | For Docker users. Never run on the build machine; validated as YAML against the schema only. |
| `DEVIATIONS.md` | Where this package differs from the specification, and requests to other packages. |
