# WP4 (`tools/svm-rpc`) deviations and hand-over notes

Recorded while building section 9.2 of `docs/SPEC.md`. "Deviation" = differs from the text. "Choice" = the text was silent. "Gap" = a real RPC node behaves differently and callers must allow for it.

No change to any root file or to `interfaces/` is requested. The root `Cargo.toml` already excludes this crate and `pnpm-workspace.yaml` already lists `tools/*`. `package.json` keeps the dependency versions WP1 wrote, so `pnpm-lock.yaml` is unaffected.

## Use

```ts
import { startSvmRpc, sendAndConfirm, confirmSignature } from '@xmrswap/svm-rpc';   // Node
import { SvmRpcClient } from '@xmrswap/svm-rpc/client';                              // browser-safe

const svm = await startSvmRpc({ programs: [{ programId, soPath }] });   // builds the binary if missing
const connection = new Connection(svm.url, 'confirmed');                // never pass a wsEndpoint
await svm.airdrop(wallet, 10n ** 9n);
const usdc = await svm.createMint(6, issuer);
await svm.mintTo(usdc, wallet, 1_000_000n);
await sendAndConfirm(connection, signedTx);                             // polls; no WebSocket
await svm.warp(3600);
await svm.stop();
```

Binary: `svm-rpc [--port <n>] [--program <id>=<path.so>]... [--unix-timestamp <s>] [--die-with-parent]`. It prints `svm-rpc listening on http://127.0.0.1:<port>` once it serves. `SVM_RPC_BIN` overrides the binary the helper starts.

## Deviations and choices

| # | Spec | Kind | What was done | Why |
| --- | --- | --- | --- | --- |
| D1 | 9.2 method table | Deviation | One standard method was added: `getHealth`. Two control methods take an optional extra argument: `svm_createMint(decimals, authority, mint?)` and `svm_createLookupTable(addresses, authority?)`. | Health checks are what harness start-up scripts poll. A chosen mint address lets a test pin the USDC mint in `Config`. |
| D2 | 9.2 "serving … on `127.0.0.1`" | Choice | The bind address is not configurable. `--host`, `--bind` and `--bind-address` exist only to be refused: any value but `127.0.0.1` exits with status 2 before a socket is opened. Requests whose `Host` is not loopback, or whose `Origin` is not a loopback page, get 403. Loopback origins get CORS headers. | The browser tests of `apps/web` call this from a page on another loopback port, so CORS is needed; a page from anywhere else must not be able to drive `svm_addProgram`. |
| D3 | 9.2 (no chain model given) | Choice | A transaction that lands is recorded at the current slot; then slot and block height move by one and a new blockhash is issued. Nothing else moves the slot except `svm_warp` and `svm_setClock`; wall-clock time never does. Block height is the slot minus 20,000,000. Start: slot 300,000,000, `unix_timestamp` 1,795,000,000 (the research harness's values). | Deterministic runs. |
| D4 | 9.1 "a fresh blockhash per transaction (`expire_blockhash`)" | Deviation | A blockhash stays valid for 150 block heights after it was issued, as on a cluster; LiteSVM's own check (latest hash only) is switched off and replaced by this window plus a duplicate-signature check over the whole history. | With "latest only", two parties that fetch a blockhash and then both send (taker and daemon in every end-to-end scenario) would see the second transaction fail with `BlockhashNotFound`. A byte-identical resend is still refused (`AlreadyProcessed`). |
| D5 | 9.2 `svm_warp(seconds)` | Choice | `unix_timestamp += seconds`; `slot += max(1, floor(seconds × 5 / 2))`; every blockhash issued before the warp becomes invalid. Returns `{slot, blockHeight, unixTimestamp}`. `svm_setClock(unixTimestamp)` sets the timestamp, takes one slot and leaves blockhashes valid. | "Moves `unix_timestamp` and the slot together and expires the blockhash". |
| D6 | 9.2 `svm_airdrop`, `svm_createMint`, `svm_mintTo` | Choice | All three write account state directly; none sends a transaction, so none has a signature or appears in history. `svm_createMint` makes `authority` both mint and freeze authority (USDC has both). `svm_mintTo(mint, owner, amount)` credits the owner's **associated** token account under the classic Token program, creating it rent-exempt if missing, raises the supply, and returns the account's address. Amounts are JSON integers or decimal strings. | The facade never holds a secret key. |
| D7 | 9.2 `svm_setAccount(pubkey, account)` | Choice | `account` is `{lamports, owner?, data?, executable?, rentEpoch?}` with `data` as base64 or as the `[base64, "base64"]` pair `getAccountInfo` returns; `null` deletes the account. | Shape not given. |
| D8 | 9.2 `svm_addProgram` | Choice | Loads under the upgradeable loader with no upgrade authority and returns `{programId, programData}`. `svm_setUpgradeAuthority(programId, authority \| null)` rewrites the option in the ProgramData account. | `initialize` (section 4.3) reads the ProgramData account. |
| D9 | 1.3 dependency block for `tools/svm-rpc` | Deviation | Used: `litesvm =0.16.0` with features `precompiles` and `serde`, `solana-account`, `solana-clock`, `solana-hash`, `solana-message`, `solana-pubkey`, `solana-rent`, `solana-signature`, `solana-transaction`, `solana-transaction-error`, `bincode` 1, `bs58`, `base64`, `serde_json`, `sha2`, `tiny_http` 0.12. Not used: `litesvm-token`, `curve25519-dalek`. | A server needs HTTP and JSON. `precompiles` loads the Ed25519 program that section 4.6 depends on (off by default in LiteSVM). Token accounts are written by layout, so `litesvm-token` is not needed. |
| D10 | 1.5 package `@xmrswap/svm-rpc` | Choice | The package is the crate plus a start helper in plain ES modules with hand-written `.d.mts` types (`src-ts/`), so it needs no build step. `pnpm --filter @xmrswap/svm-rpc build` runs `cargo build --locked`. It also exports `confirmSignature` and `sendAndConfirm` (polling). | See gap G1. |
| D11 | 9.2 "a fixed fake genesis hash" | Note | `getGenesisHash` is base58 of `sha256("xmrswap svm-rpc: in-memory LiteSVM, not a cluster")`. `getVersion` reports `solana-core` 4.2.2 (the Agave runtime inside LiteSVM 0.16.0), `feature-set` 0. | |
| D12 | 9.1 "one target dir" | Note | One Cargo profile (`dev`, dependencies at `opt-level = 3`, no debug info) serves `cargo test`, the binary and the TS test; `target/` is about 0.7 GB. | Disk. |

## Gaps against a real RPC node

| # | Gap | What to do |
| --- | --- | --- |
| G1 | **No WebSocket** (as 9.2 says). web3.js `confirmTransaction`, `sendAndConfirmTransaction`, Anchor's `provider.sendAndConfirm` and the `@solana/spl-token` action helpers (`createMint`, `transfer`, …) wait on a signature subscription and therefore hang until the blockhash expires. | Send with `sendRawTransaction` / `sendTransaction` and poll `getSignatureStatuses` (`sendAndConfirm`, `confirmSignature` from this package). Use spl-token's instruction builders, not its actions. |
| G2 | Slots do not advance with time. Code that waits for "N slots" or for the block height to pass `lastValidBlockHeight` never finishes on its own. | Call `svm_warp`. |
| G3 | Every transaction is final at once: `confirmationStatus` is always `finalized`, `confirmations` is `null`, and commitment and `minContextSlot` arguments are ignored. | |
| G4 | `jsonParsed` exists for SPL Token mints and token accounts only (other accounts fall back to base64, as a node does for unknown programs). `getTransaction` supports `json`, `base64` and `base58`, not `jsonParsed`, so `getParsedTransaction(s)` fails. `base64+zstd` is refused. With no `encoding`, account data comes back as base64 (a node defaults to base58); web3.js always sends one. | Decode with the codecs in `@xmrswap/protocol`. |
| G5 | Not implemented (each fails with `Method not found: <name>`): `getBlock`, `getBlocks`, `getTokenSupply`, `getTokenLargestAccounts`, `getTokenAccountsByDelegate`, `getSupply`, `requestAirdrop`, `getStakeMinimumDelegation`, every `*Subscribe`, and anything else outside the 9.2 table. | `svm_airdrop` replaces `requestAirdrop`. |
| G6 | Durable-nonce transactions are refused with `BlockhashNotFound`. | Not used by this project. |
| G7 | A transaction that invokes a program id with nothing loaded fails with `InvalidProgramForExecution` (LiteSVM); a node says `ProgramAccountNotFound`. Other errors use the node's JSON form (`{"InstructionError":[0,{"Custom":6000}]}`). | |
| G8 | `getProgramAccounts` and `getTokenAccountsByOwner` return results sorted by address; a node's order is arbitrary. `getProgramAccounts` filters: `memcmp` and `dataSize` only. | Do not rely on the order. |
| G9 | `Clock.epoch` stays 0 while `getEpochInfo` reports `slot / 432,000`; no epoch boundary processing exists (no rewards, no stake). `getRecentPrioritizationFees` is always one entry of 0. | |
| G10 | Transactions over 1,232 bytes are refused before execution (the packet limit of a node). LiteSVM keeps at most 10,000 bytes of logs per transaction, like a node. | |
| G11 | One request at a time, one thread; state is lost when the process exits. | Start one instance per test file if isolation is needed (start-up is a few milliseconds). |
