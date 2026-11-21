# Monero regtest harness

A private two-node Monero regtest plus the code that proves the XMR side of the swap:
derive the 2-of-2 joint address, fund it, verify the lock with the view key against two nodes,
wait out the 10-block lock, and sweep with the summed spend key (wallet-rpc, the native sweep
binary of `crates/swap-core`, and `@xmrswap/core-wasm` inside a real browser tab).

Findings and rationale: `docs/research/monero.md`. The sweep rules: `docs/SPEC.md` section 2.11.

## Requirements

- `monerod` and `monero-wallet-rpc` v0.18.x in `$XMR_BIN` (default `$HOME/monero`)
- Node 22, pnpm 9 (this directory is a member of the root pnpm workspace: run `pnpm install` at
  the repository root); Rust 1.94 with the `wasm32-unknown-unknown` target
- `wasm-bindgen` CLI **0.2.130** (must equal the crate version):
  `cargo install wasm-bindgen-cli --version 0.2.130 --locked`
- A Chromium for the browser test (`CHROMIUM=/path`, else the newest build in the Playwright cache)

## Quick start

```sh
./start.sh --fresh        # node A :48081, node B :48085 (+ restricted :48086), wallet-rpc :48083
pnpm build                # @xmrswap/core-wasm (both targets) and the native sweep binary
pnpm e2e                  # the whole flow with monero-wallet-rpc as the sweeper
pnpm edge                 # additional tx keys, time-lock refusal, 2-block reorg
pnpm deposit-watch        # find an unannounced deposit by view-key scanning (restricted node)
pnpm presplit             # why one output funds one swap per 10 blocks
pnpm e2e:rust             # native sweep: 10-block lock, fee cap, exact-output selection with dust
pnpm e2e:browser          # verify + sweep inside headless Chromium (cross-origin), same rules
./stop.sh                 # ALWAYS stop when done
```

`pnpm test` builds, then runs all six. `CONF=2 pnpm e2e` uses a 2-confirmation policy.

`pnpm record-vectors` re-records `crates/swap-core/fixtures/monero_tx.json` (the source of
`interfaces/vectors/monero_tx.json`) from a fresh regtest. That changes a frozen vector file:
only the owner of work package 1 does it.

## Safety on a shared machine

- Regtest only. Ports 48080-48087, far from Monero defaults; everything binds to 127.0.0.1.
- All state (chains, wallets, logs, pidfiles) lives in `<repo>/.scratch/monero/state` (gitignored;
  override with `XMR_STATE`). `./start.sh --fresh` wipes only that directory.
- `stop.sh` kills only PIDs from its own pidfiles whose command line contains the state dir.
  It never kills by process name.
- `start.sh` passes `--config-file <state>/…/regtest.conf`. Without it monerod reads
  `~/.bitmonero/bitmonero.conf` **even when `--data-dir` is set** and silently inherits a live
  node's settings (we hit `restricted-rpc` and a Tor `proxy` that way).
- The two nodes peer only with each other (`--add-exclusive-node`); regtest shares mainnet's
  network id, so never run it with open peering.

## Layout

| Path | What |
| --- | --- |
| `env.sh`, `start.sh`, `stop.sh` | Network lifecycle. Source `env.sh` for ports/URLs. |
| `build.mjs` | Builds `@xmrswap/core-wasm` and the native `xmr-joint-sweep` binary from `crates/swap-core`. |
| `lib/monero.mjs` | Pure JS (only `@noble/*`): scalars, key halves, joint key, base58 + address codec, tx parser, txid recomputation, view-key output scan with commitment check. Runs in Node and browsers. |
| `lib/verify.mjs` | `verifyLock()`: multi-node lock verification (states `not-found / invalid / pending / confirming / confirmed`). Returns the `outputIndex` it verified and reports `duplicate-output-key` when another output in the lock transaction or its block carries the same one-time key. |
| `lib/watch.mjs` | `findDeposits()`: view-key scan of mempool + recent blocks when no txid is known. |
| `lib/rpc.mjs` | Tiny `fetch` clients for monerod and monero-wallet-rpc. |
| `lib/harness.mjs` | `mine`, `fund`, `ensureFunded`, `waitSynced`, `sweepWithWalletRpc`. Import these from integration tests. |
| `lib/sweep.mjs` | `sweepNative()`: runs the native sweep binary; `REGTEST_MAX_FEE` (regtest fees are far above mainnet's, so the harness overrides the production fee cap). |
| `e2e.mjs`, `edge-cases.mjs`, `deposit-watch.mjs`, `presplit-demo.mjs` | Runnable proofs (each asserts and exits non-zero on failure). |
| `run-rust-sweep.mjs` | Drives the native binary: refusal at 9 confirmations, the fee cap, a wrong output index, and a lock block with dust (the sweep spends exactly the named output and lists the rest as ignored). |
| `browser/` | `page.mjs` (bundled by esbuild; sweeps with `@xmrswap/core-wasm`), `run-browser-sweep.mjs` (Playwright driver; serves the page on :48087 so daemon calls are genuinely cross-origin), `prepare-lock.mjs`. |
| `record-vectors.mjs` | Records the `monero_tx.json` fixture. |

## Using it from tests

```js
import { mine, fund, NODES, XMR } from './lib/harness.mjs';
import { generateKeyHalf, jointPublic, encodeAddress } from './lib/monero.mjs';
import { verifyLock } from './lib/verify.mjs';

const maker = generateKeyHalf(), taker = generateKeyHalf();
const joint = jointPublic({ spendPubA: maker.spendPub, spendPubB: taker.spendPub, viewPrivA: maker.viewPriv, viewPrivB: taker.viewPriv });
const { txid } = await fund(encodeAddress(joint.spendPub, joint.viewPub, 'regtest'), 2n * XMR);
await mine(10);
const r = await verifyLock({ nodes: NODES, txid, viewPriv: joint.viewPriv, spendPub: joint.spendPub, minAmount: 2n * XMR, minConf: 10 });
```

## Regtest quirks worth knowing

- Addresses use **mainnet** prefixes (`4…`); `get_info.nettype` is `fakechain`. Wallet software must be told "mainnet".
- `monero-wallet-rpc` needs `--allow-mismatched-daemon-version` (regtest is at hard fork v16 from block 1).
- Blocks appear only when you call `mine()`; the chain needs ~160 blocks before the first spend
  (60-block coinbase lock, enough outputs for 16-member rings). `ensureFunded()` handles that.
- A transaction reaches the other node's mempool a few seconds late (Dandelion++); poll, don't assume.
- After a reorg the orphaned transaction is not re-mined automatically by a node that never had it
  in its pool; `mine()` after `pop_blocks` on one node creates a real fork (`edge-cases.mjs`).
- Regtest fees are much higher than mainnet's (about 0.007 XMR for a sweep); do not read fee numbers off this harness.
