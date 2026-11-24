# XMR atomic swaps on Solana and Ethereum

**Experimental and unaudited. Nothing here has been deployed to, or run on, any live network. Do not use it with real funds.** Read `docs/STATUS.md` first.

This repository implements atomic swaps between Monero and SOL, ETH or USDC, in both directions. Makers publish offers in an on-chain registry; a Solana program and an Ethereum contract hold the escrow and apply the same state machine; the Monero side is a two-party joint address whose spend key is completed by whichever secret the escrow reveals. A maker runs an always-on daemon with a local console; a taker uses a static web page in which every key, check and signature stays in the browser. No licence has been chosen yet; until the owner picks one, no rights are granted.

## Repository map

| Path | Contents |
| --- | --- |
| `crates/` | `swap-core`: the Rust core (cryptography, encodings, Monero sweep, reference state machine, vector generator) |
| `interfaces/` | Frozen interfaces: the Solana IDL, the Solidity interface and ABI, shared test vectors, conformance checkers |
| `packages/` | `core-wasm`, `protocol`, `sdk`, `relay`, `rebalancer`, `daemon` (TypeScript, Node 22) |
| `apps/` | `console` (maker console) and `web` (taker UI), both React, built to static files |
| `solana/` | The Anchor program and its in-process tests |
| `ethereum/` | The Foundry project: contract, libraries, tests, an anvil-only deploy script |
| `tools/` | `svm-rpc`: a test-only JSON-RPC facade over an in-memory Solana VM |
| `tests/` | `monero-regtest` (private two-node Monero harness) and `e2e` (the end-to-end suite) |
| `deploy/` | The self-hosting bundle (static UI server, relay, settings, release checksums) |
| `docs/` | Design, specification, status, research notes, self-hosting guide |

## Prerequisites

- Rust 1.94.1 with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- `cargo install wasm-bindgen-cli --version 0.2.130 --locked`
- Solana CLI 3.0.9 (for `cargo build-sbf` only) and Anchor CLI 0.32.1 (for `anchor idl build` only)
- Foundry 1.7.1 (`forge`, `anvil`)
- Node 22.21 or later in the 22 line, and pnpm 9.15.0
- `monerod` and `monero-wallet-rpc` 0.18.4.5 in a directory named by `XMR_BIN`
- A Chromium binary, named by `CHROMIUM` or present in the Playwright cache

**Solana tests run in-process** (LiteSVM, or the `svm-rpc` facade over it). There is no local validator, no test reads the Solana CLI configuration or wallet, and **no command in this repository deploys or sends a transaction to a live network**. Ethereum tests use forge's in-process EVM or a local anvil; Monero tests use a private regtest bound to loopback.

## Build and test

```sh
pnpm install --no-frozen-lockfile
export XMR_BIN=<directory holding monerod and monero-wallet-rpc>
```

Core, vectors and wasm:

```sh
cargo test -p swap-core
cargo run -p swap-core --bin gen-vectors -- --check interfaces/vectors
pnpm --filter @xmrswap/core-wasm build && pnpm --filter @xmrswap/core-wasm test
pnpm --filter @xmrswap/protocol test
```

Solana program (in-process):

```sh
(cd solana/program && cargo build-sbf && anchor idl build -o target/idl/xmr_swap.json)
(cd solana/tests && cargo test)
node interfaces/tools/check-idl.mjs solana/program/target/idl/xmr_swap.json
```

Ethereum contract:

```sh
(cd ethereum && forge test && forge inspect XmrSwap abi --json > out/XmrSwap.abi.json)
node interfaces/tools/check-abi.mjs ethereum/out/XmrSwap.abi.json
```

Packages (unit tests):

```sh
(cd tools/svm-rpc && cargo test) && pnpm --filter @xmrswap/svm-rpc test
pnpm --filter @xmrswap/sdk test
pnpm --filter @xmrswap/relay test
pnpm --filter @xmrswap/rebalancer test
pnpm --filter @xmrswap/daemon test
pnpm --filter @xmrswap/console test && pnpm --filter @xmrswap/console build
pnpm --filter @xmrswap/web test && pnpm --filter @xmrswap/web build
pnpm --filter @xmrswap/deploy test
```

Integration (these start the regtest, `svm-rpc` and anvil on loopback and take a shared lock, so run one at a time):

```sh
(cd tests/monero-regtest && ./start.sh --fresh && pnpm test; rc=$?; ./stop.sh; exit $rc)
pnpm --filter @xmrswap/sdk test:integration
pnpm --filter @xmrswap/daemon test:integration
pnpm --filter @xmrswap/web test:browser
```

End to end (the real daemon, relay, both UIs in Chromium, the program, the contract and regtest Monero):

```sh
pnpm --filter @xmrswap/e2e test
```

What the end-to-end suite does and does not cover is in `tests/e2e/COVERAGE.md`.

## Running it locally against the test stack

Everything below is loopback only and uses test chains.

The taker UI with three scripted makers on Solana:

```sh
pnpm --filter @xmrswap/web build
pnpm --filter @xmrswap/web stack           # prints the URL; HEADED=1 opens Chromium with a test wallet
```

The whole system (real maker daemon and console, relay, taker UI, both chains, regtest):

```sh
pnpm --filter @xmrswap/e2e stack           # prints the URLs; Ctrl-C stops everything
```

The maker daemon on its own (dry run is the default; it sends nothing):

```sh
pnpm --filter @xmrswap/daemon config:check <file.toml>
pnpm --filter @xmrswap/daemon start
```

The self-hosting bundle (static UI and relay on one loopback origin; it does not start Tor):

```sh
pnpm --filter @xmrswap/deploy start
pnpm --filter @xmrswap/deploy run status
```

## Documents

- `docs/DESIGN.md`: the product design
- `docs/SPEC.md`: the implementation specification, kept in line with the code
- `docs/STATUS.md`: what is built, what is proven, what is not, and what the owner still has to decide
- `docs/self-hosting/`: running the taker UI and relay yourself
