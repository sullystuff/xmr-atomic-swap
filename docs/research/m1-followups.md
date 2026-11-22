# M1 follow-ups: implementation changes owed after the M1 merge

2026-11-21. Written by the architect while folding the M1 deviation files into `docs/SPEC.md`. Each row is a place where the implementation, not the specification, is to change. No code was edited. Everything else in the deviation files was accepted and SPEC.md now matches it.

None of these changes an API that the daemon, console or taker UI call, except where "API" says so.

## By package

| # | Package | Source | What must change | Why |
| --- | --- | --- | --- | --- |
| 1 | `crates/swap-core` (model, vectors) | solana V5, ethereum 13 | The reference model refuses a swap whose `amount` or `xmr` is zero with `AmountOutOfRange`; `transitions.json` and `amounts.json` gain the cases; regenerate. | The two chains must agree. A direction-B dust take that rounds to zero locks the taker's XMR against nothing. The contract's rule is the right one (SPEC 3.1). |
| 2 | `solana/program` | solana V5 | `lock` and `take` refuse `amount == 0` or `xmr == 0` with `AmountOutOfRange`; `post_quote` likewise. | Same. Depends on 1 for the vectors. |
| 3 | `crates/swap-core` (model, vectors) | ethereum 15, 16 | `ChainConsts` gains the caller rules of SPEC 3.13: on Ethereum no "lock/take by someone else" rows are generated (the taker is `msg.sender`), and `withdraw_owed` by an account that is owed nothing expects `NothingOwed`. Regenerate the Ethereum rows and the two sequences. | Vectors must carry chain-specific expectations so that no replay special-cases anything. The vectors are already per chain. |
| 4 | `ethereum` | ethereum 15, 16 | Remove the eight special cases (`foreignOpens`, `foreignPulls`) from the replay once 3 lands; the replay then compares every row as written. | "Each contract MUST replay every row … with no special cases." |
| 5 | `ethereum` | ethereum 4 | Pack the stored swap: an internal storage struct of about 17 slots (`amount` and `deposit` as `uint128` in one slot, small fields beside the addresses), with `getSwap` still returning the frozen interface struct. Re-measure gas. | About 110,000 gas (18%) off every `lock`. A layout cannot change under a live proxy, so it must be done before any deployment. The ABI is unchanged. |
| 6 | `crates/swap-core`, `packages/core-wasm` | sdk D2, D3 | Export `modelApply`, `modelEnabled` and `tierValue` through wasm (API addition). | One implementation of the state machine and of tier lookup. |
| 7 | `packages/sdk` | sdk D2, D3 | Once 6 lands, `apply`, `enabled` and `tierValue` call the core; delete `src/machine/model.ts`'s port and the copy in `registry/pricing.ts`. Exported names and types stay. Update the port for 1 and 3 in the meantime. | SPEC 2: TypeScript does not re-implement the protocol. |
| 8 | `packages/sdk` | sdk F9, P2, P4, D10 | Finish M2: fill in `test:integration` against the built program (`svm-rpc`), the contract (anvil) and regtest; measure per-call gas and replace the 150,000 placeholder in `ethSessionBudget`; run the v0 lookup-table transaction; confirm the `bytes32` / `revealed` byte-order assumption with the contract; add the 10,000-lamport fee of approval transactions to fee budgeting. | The SDK has not yet been run against anything real. A wrong session budget is a lost automatic refund. |
| 9 | `packages/sdk` | sdk F7 | Derive past identity links from `LinkChanged` events (both chains) in addition to the client-side `LinkMemory`. | DESIGN: a maker cannot shed a bad record by unlinking. A fresh client currently sees only current links. |
| 10 | `packages/protocol` | relay R2, R8 | Add the relay error shape and code list (`RelayError`), and export the pinned development program id (from `interfaces/solana/program-id.txt`) and, per release, the contract address (API addition). | The UI must tell "relay refused" from "maker refused"; the relay, the UI and the self-hosting bundle need one source for the program id. |
| 11 | `crates/swap-core` (vectors) | solana T7 | Each `amounts.json` case carries a `chains` field; the seven cases above `u64` are marked Ethereum-only. | So the Solana replay skips by data, not by a count in test code. |
| 12 | `packages/rebalancer` | rebalancer A3 | The settings schema accepts `[rebalance.venues.exchange.withdraw_keys]` (address to key name) and passes it to the Kraken driver. | The schema rejects unknown keys, and SPEC 7.2 now defines this one. |
| 13 | `tests/monero-regtest` (WP1) or `tests/e2e` (WP11) | wp1 C13 | Produce a real duplicate-one-time-key transaction on regtest (a small builder with a chosen tx private key) for scenario N-2. | The recorded vector is synthetic. |

## For the project owner (not code)

| # | Item | Source |
| --- | --- | --- |
| O1 | Place the current wXMR bridge IDL at `packages/rebalancer/vendor/wxmr_bridge.json`; confirm the deployed bridge matches its source. | rebalancer A1, `BRIDGE-ASSUMPTIONS.md` |
| O2 | The rulings listed as items 26 to 32 of "Interpretations pending owner sign-off" in `docs/SPEC.md`. | several |

## Order

1, 3, 11 (one regeneration of the vectors) → 2, 4, and the SDK port update in 7 → 6 → 7. Item 5 is independent. Items 8 and 10 should land early in M3: the daemon and UIs build on the SDK and need the program id and relay error types.
