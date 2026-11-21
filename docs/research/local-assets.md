# Local assets survey: the wXMR workspace and instant-swap APIs

2026-11-21. Source: a read-only pass over the operator's wXMR workspace (referred to below as `wxmr/`) and the public API docs of the four instant-swap services in DESIGN.md. Nothing in `wxmr/` was modified or run.

This file contains no secrets. Credentials, RPC URLs and hosts are named by environment variable only. On-chain addresses are public.

Paths are relative to the `wxmr/` workspace root unless they start with `docs/`.

## 1. Tech stack and conventions

| Area | What is in use |
| --- | --- |
| Language | TypeScript everywhere for services and UIs (strict, `tsc --noEmit` as the check). Rust only for the Anchor programs. Two small tools (`wxmr-watcher`, `wxmr-explorer`) are dependency-light plain ESM JavaScript. |
| Node | 22+ (`engines` in most packages); `tsx` to run TS directly in services; `ts-node` + `tsc` build in `wxmr-backend`. |
| Solana program | Anchor 0.32.1 (`wxmr-backend/Anchor.toml`), `anchor-spl`, `InitSpace` account sizing, PDA seeds as byte-string literals, events via `emit!`, one `#[error_code]` enum. |
| Solana client | `@solana/web3.js` 1.98 + `@coral-xyz/anchor` 0.32.1 + `@solana/spl-token` 0.4. `@solana/kit` is used only where v1 transaction envelopes are needed. |
| EVM client | `ethers` 6 in `xmr-swap`; `viem` 2 in `wxmr-frontend/packages/core`. No Solidity or Foundry/Hardhat project exists locally, so the Ethereum contract toolchain is a free choice. |
| HTTP / push | `express` 4 + `ws` 8, bound to loopback, nginx in front for TLS and WebSocket upgrade. |
| Database | SQLite through `better-sqlite3` (WAL), one file per service. State machines are rows; every money movement writes an intent row before broadcasting. |
| Frontend | Turborepo + npm workspaces. Next.js 16 (App Router), React 19, Tailwind CSS 4, `@solana/wallet-adapter`, React Compiler plugin. Shared code in `packages/shared` (UI, providers, CSS tokens) and `packages/core` (chain logic, no React). |
| Config | `dotenv`; a single `config.ts` per service that reads env vars with defaults; `zod` validation in the bots. `EXECUTION_MODE=dry-run` is the default, `live` is opt-in. |
| Deployment | PM2 (`wxmr-frontend/ecosystem.config.js`) or `screen` sessions for services; Docker Compose as an alternative (`wxmr-frontend/deploy/docker-compose.yml`); nginx site configs under `deploy/nginx/`; release directories with an `-evidence` sibling holding test, lint and verification logs. Tor is a plain `torrc` hidden service pointing at the loopback port (`wxmr-frontend/deploy/README.md`, section 4). |
| Monero | Local `monerod` plus one `monero-wallet-rpc` per service with digest auth; each service has its own wallet. |

Test style:

- Unit tests: `vitest` in `xmr-swap`; Node's built-in runner (`node --test`, `tsx --test`) everywhere else. Pure money math and state transitions are tested without network access.
- Program tests: the real SBF build loaded into **LiteSVM** from `.cjs` test files (`wxmr-backend/tests/*.program.test.cjs`), not `anchor test` against a validator.
- Monero integration: Python drivers against a regtest daemon (`wxmr-backend/tests/monero-regtest.py`, `monero-utxo-regtest.py`).

Conventions worth copying:

- Amounts are `bigint` in atomic units end to end; decimal strings on the wire. JSON from wallet RPC is parsed losslessly (`wxmr-backend/src/reserve-proof.ts`, `parseExactRpc`).
- "Never re-send": persist intent, then broadcast; on any ambiguity park the item in `needs_review` instead of retrying.
- Each leg's input is the chain-observed output of the previous leg, never client input.
- Deposit detection is a height-cursor scan where the cursor advances in the same SQLite transaction that records the transfers.
- The database is bound to the wallet's primary address and refuses to start against another wallet.
- Solana RPC: verify the genesis hash before trusting an endpoint; finalized commitment for anything that credits funds.

## 2. Reusable code

### Monero

| File | What it does |
| --- | --- |
| `xmr-swap/src/monero.ts` | Compact wallet-RPC and daemon-RPC client. `DigestClient` implements HTTP digest auth pinned to one keep-alive socket (epee binds the nonce to the connection). Exports `walletRpc`, `daemonRpc`, `createSubaddress`, `getTransfersInHeightWindow`, `getPoolTransfers`, `isTransferStillConfirmed`, `getBalance`, `getWalletHeight`, `getDaemonHeight`, `validateXmrAddress`, `transferXmr`. Best starting point for the maker daemon. |
| `wxmr-backend/src/monero.ts` | Fuller client: `do_not_relay` prepare then `relay_tx` (`sendXmr`, `sendXmrBatch`, `relayPreparedXmr`), `getTxKey`, payment-proof checks, output listing/freeze/thaw, sweeps, `getTxConfirmations`, `getRawTransaction`. Use for the prepare-persist-relay payout pattern. |
| `wxmr-backend/src/utxo-planner.ts` | Chooses inputs and split outputs per payout (`planWithdrawal`, `chooseConsolidation`). Directly relevant to the maker's inventory splitter and output ladder. Notes in `wxmr-backend/docs/utxo-management.md`. |
| `wxmr-backend/src/xmr-transaction.ts` and `wxmr-frontend/apps/bridge/src/lib/xmr-transaction.ts` | Recomputes a Monero v2 transaction hash from the raw blob, in Node and in the browser. |
| `wxmr-frontend/packages/core/src/monero.ts` | Browser-safe Monero address decode and validation (base58, Keccak checksum, network tag, ed25519 point checks) built on `@noble/curves` and `@noble/hashes`. A port of the on-chain validator. Foundation for the taker UI's client-side key and address work. |
| `wxmr-backend/programs/wxmr-bridge/src/lib.rs` (lines ~30-300) | The same Monero address validation in Rust, on-chain, including ed25519 field checks. Reusable in the swap program for validating key commitments and addresses. |
| `wxmr-watcher/src/monero.js`, `wallet.js` | View-only wallet watcher that verifies payouts with `check_tx_key`; a model for the taker-side lock check and the evidence publisher. |
| `wxmr-frontend/apps/bridge/src/lib/monero-payment.ts`, `components/MoneroQrScanner.tsx` | `monero:` URI parsing and QR scanning. |

### Solana

| File | What it does |
| --- | --- |
| `xmr-swap/src/solana.ts` | Connection and keypair loading, SPL and SOL transfers, `signAndSendBase64Tx` for aggregator transactions, finalized balance reads, per-transaction balance deltas (`ownerMintDeltaInTx`, `ownerLamportsDeltaInTx`). |
| `wxmr-backend/src/rpc-failover.ts` | `RpcFailover`: primary/fallback HTTP and WebSocket endpoints with genesis-identity and slot checks; retries resend the exact signed bytes. |
| `wxmr-backend/src/program-account-watcher.ts` | `watchProgramAccounts`: filtered `programSubscribe` plus periodic `getProgramAccounts` catch-up after connect, reconnect and every 60 s. This is the pattern the maker daemon needs to watch swap accounts. |
| `wxmr-backend/src/heartbeat-transaction.ts` | Packs instructions into a legacy transaction up to the 1,232-byte limit with compute-budget instructions. Useful for batched offer refreshes and batch locks. |
| `wxmr-grid-bot/src/solana-stream.ts` | `StreamingConnection`: account subscriptions with fresh-read guarantees before signing. |
| `wxmr-frontend/apps/bridge/src/lib/rpc-client.ts` | Browser JSON-RPC client with a cross-tab rate budget (Web Locks), request coalescing, 5 s read cache, batch fallback. |
| `wxmr-frontend/packages/shared/src/solana-rpc.ts`, `components/SolanaRpcSettings.tsx` | User-selectable RPC endpoint stored in localStorage, checked with `getGenesisHash` before saving. Matches the self-hosting requirement in DESIGN.md. |
| `wxmr-frontend/packages/shared/src/providers.tsx` | Wallet-adapter provider setup. |
| `wxmr-explorer/src/subscription.js`, `indexer.js`, `events.js` | Signature-subscription indexer and Anchor event decoding without the Anchor runtime. |

### Price feeds

| File | Source | Notes |
| --- | --- | --- |
| `xmr-swap/src/pricing.ts` | CoinGecko `simple/price` (keyless) for XMR and SOL in USD; Jupiter quotes for the executable wXMR rate | Includes a 5% depeg flag, 30 s caches, size-bucketed quotes and tested `bigint` money math (`xmr-swap/test/pricing.test.ts`). |
| `wxmr-explorer/src/price.js`, `wxmr-arb/src/dexscreener.ts` | DEX Screener token-pairs API | Picks the deepest wXMR pair; exact-decimal USD conversion. |
| `wxmr-grid-bot/src/market.ts` | KuCoin XMR-USDT and USDC-USDT order books | Zod-validated, staleness and spread checks. A good third reference source. |
| `wxmr-grid-bot/src/pool.ts` | Meteora DLMM pool state read on-chain | Derives the wXMR/USDC price from the active bin. This is the direct-pool read needed for the `wxmr_pool` cross-check source. |
| `wxmr-frontend/apps/bridge/src/app/api/quotes/route.ts`, `hooks/useXmrPrice.ts` | Jupiter quote plus KuCoin book; server-cached XMR/USD | UI-side price display. |

There is **no CoinMarketCap client** anywhere in the workspace, and the CoinGecko calls are keyless. Both keyed clients named in DESIGN.md have to be written.

### WebSocket push

- `xmr-swap/src/ws.ts` + `events.ts`: a `ws` server on `/api/ws` with subscribe/unsubscribe channels, an immediate snapshot on subscribe, pushes on state change through an `EventEmitter`, 30 s ping with dead-connection cleanup, and a per-connection subscription cap. Tested in `xmr-swap/test/ws.test.ts`. Fits the maker console to daemon link as is.
- `xmr-swap/src/views.ts`: separation of internal rows from public views (for example `needs_review` shown as `under_review`).

### UI and design system

| File | What it is |
| --- | --- |
| `wxmr-frontend/packages/shared/src/styles/design-system.css` | CSS custom properties and component classes: Monero orange `#ff6600` on near-black `#0d0d0d`, `.xmr-card`, `.xmr-btn-primary`, `.xmr-input`, `.xmr-badge`, wallet-adapter overrides. |
| `wxmr-frontend/PRODUCT.md`, `xmr-swap/PRODUCT.md` | Product brief used for design work: "cypherpunk, competent, verifiable"; show the mechanics; calm during custody; plain words; WCAG AA. |
| `wxmr-frontend/packages/shared/src/components/` | `Swap.tsx`, `CopyAddress.tsx`, `SolanaRpcSettings.tsx`, `OpenSourceLink.tsx`, `icons.tsx`. |
| `wxmr-frontend/apps/bridge/src/components/` | `BridgeStatus.tsx` (online/stale indicator from the heartbeat), `SwapProgress.tsx` and `RoutePanel.tsx` under `xswap/` (multi-step progress), `CancelWithdrawalButton.tsx` (countdown to an on-chain delay), `WithdrawalRecovery.tsx`, `ReserveAuditCard.tsx`, `BridgeDialog.tsx`. |
| `wxmr-frontend/apps/bridge/src/lib/withdrawal-storage.ts` | Saves a request address to localStorage before wallet signing so it can be recovered after a reload. Same need as the taker UI's leg recovery. |

Not available locally: a Tor SOCKS relay service, a CMC client, any Ethereum contract, any adaptor-signature or key-share code.

## 3. wXMR bridge adapter facts

Authoritative sources: the program at `wxmr-backend/programs/wxmr-bridge/src/lib.rs` and the IDL at `wxmr-backend/src/idl/wxmr_bridge.json` (byte-identical to `wxmr-frontend/packages/core/src/idl/wxmr_bridge.json`).

Do **not** vendor `xmr-swap/src/idl/wxmr_bridge.json`: it is stale. It lacks `cancel_withdrawal` and the heartbeat instructions, and has old `mint_deposit` and `complete_withdrawal` signatures. `wxmr-backend/README.md` is also outdated in places (it describes `request_deposit` and 20 confirmations); the program source wins.

### Addresses and constants

| Item | Value |
| --- | --- |
| Bridge program | `EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8` |
| Withdraw wrapper program (optional) | `55grX3G396ZMLZgmc21YZfXWaVF69wwUBqxirGBxSP7p` (`programs/wxmr-withdraw-wrapper`): `withdraw_full_balance` redeems the whole token balance or a ledger delta by CPI |
| wXMR mint | `WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp`, classic SPL Token, **12 decimals** (1 base unit = 1 piconero). `wxmr-arb` assumes 9; that is a known bug. |
| Bridge authority (hard-coded) | `Ds4prSZNwyxTz4PZmHXoHDXFzLZ1c8MkfhUwGtqvAvpK` |
| Minimums | 0.1 XMR (`100_000_000_000` piconero) for deposits and withdrawals |
| Withdrawal fee | `BridgeConfig.fee_bps`, read at runtime from the config PDA; the frontend constant is 10 bps. A per-user `fee_override` PDA takes precedence when it exists. |
| Deposit fee | `DEPOSIT_FEE_BPS = 10` (0.1% of the gross XMR credited, minted to the treasury). Comments in `xmr-swap/src/bridge.ts` saying "no mint fee" predate this. |
| Deposit confirmations | 10 (`REQUIRED_CONFIRMATIONS` in `wxmr-backend/src/index.ts`) |
| Owner cancel delay | 300 seconds (`WITHDRAWAL_CANCEL_DELAY_SECONDS`) |

PDAs, all under the bridge program:

| Account | Seeds |
| --- | --- |
| Config | `"config"` |
| Fee treasury (token account) | `"fee_treasury"` |
| Fee override | `"fee_override"`, user |
| Deposit record | `"deposit"`, user |
| Withdrawal record | `"withdrawal"`, user, nonce as u64 LE |
| Withdrawal nonce watermark | `"withdrawal_state"`, user |
| Heartbeat root | `"heartbeat"` |
| Heartbeat page | `"heartbeat-page"`, one byte `generation % 2`, page index as u16 LE |
| Audit / reserve record | `"audit"`, id as u64 LE |

### Redeem (wXMR to XMR): `request_withdrawal`

Arguments: `nonce: u64, amount: u64, xmr_address: String, exact_out: bool`.

Accounts, in order:

1. `config` (read)
2. `withdrawal` (init, writable)
3. `wxmr_mint` (writable)
4. `user_token_account` (writable; the user's wXMR token account)
5. `fee_treasury` (writable)
6. `fee_override` (read; may be uninitialised)
7. `user` (signer, writable, pays rent)
8. `token_program`
9. `system_program`
10. `withdrawal_state` (init-if-needed, writable; kept last)

Behaviour:

- `nonce` must be strictly greater than `withdrawal_state.last_nonce`. The frontend uses `max(last_nonce + 1, Date.now() in ms)` (`getNextWithdrawalNonce` in `wxmr-frontend/packages/core/src/bridge.ts`). Persist the nonce before sending: the PDA is seeded by `(user, nonce)`, so a resend cannot create a second withdrawal.
- `exact_out = false`: `amount` is the total debit; fee = `amount * bps / 10000` goes to the treasury and `amount - fee` is burned and paid out as XMR. `exact_out = true`: `amount` is the net XMR received; the fee is added on top.
- The 0.1 XMR minimum is checked against `amount` as passed.
- The address is fully validated on-chain (mainnet standard, subaddress or integrated).
- The record starts `Pending`. The relayer marks it `Sending` at finalized commitment, pays, then `complete_withdrawal` closes the account and emits `WithdrawCompletedEvent { withdrawal_pda, user, amount, xmr_address, xmr_tx_hash, xmr_tx_key }`.

Tracking: fetch the `WithdrawalRecord` (status `Pending` / `Sending`); once it is closed, read the completion event from the PDA's signature history. `findWithdrawalCompletion` in `xmr-swap/src/bridge.ts` does this, and `wxmr-frontend/apps/bridge/src/lib/withdrawal-history.ts` handles v1 transactions and the archived transaction blob.

Working callers: `requestWithdrawal` in `xmr-swap/src/bridge.ts` (keypair signer) and `buildRequestWithdrawalTransaction` in `wxmr-frontend/packages/core/src/bridge.ts` (unsigned transaction with compute-budget instructions).

### Cancel: `cancel_withdrawal`

No arguments. Signed and paid by the withdrawal owner only.

Accounts, in order: `config`, `withdrawal` (writable, closed), `wxmr_mint` (writable), `user_token_account` (writable, the owner's ATA, created if missing), `user` (signer, writable), `authority` (writable; must equal `config.authority`), `withdrawal_state` (init-if-needed), `token_program`, `associated_token_program`, `system_program`.

Rules:

- Only `Pending` requests, and only once the request is at least 300 s old by Solana's clock. A `Sending` request can never be cancelled, even if the payout is delayed.
- The net amount is re-minted to the owner. The fee stays in the treasury and the record's rent goes to the bridge authority.
- The nonce stays consumed.

Reference implementation with pre-checks (owner, status, clock sysvar age): `buildCancelWithdrawalTransaction` in `wxmr-frontend/packages/core/src/bridge.ts`. Program-level tests: `wxmr-backend/tests/withdrawal-cancellation.program.test.cjs`.

`xmr-swap` has no cancel path today; the adapter must add one for the `stalled_redeem_minutes` control.

### Deposit (XMR to wXMR)

1. Call `create_deposit_account()` once per wallet. Accounts: `config`, `deposit` (init), `user` (signer, pays about 0.002 SOL rent), `system_program`. Create the owner's wXMR ATA in the same transaction so mints land directly; otherwise they go to a pending account and need `claim_pending_mint`.
2. The bridge authority then calls `assign_deposit_address`. Poll the `DepositRecord` until `status == Active` and `xmr_deposit_address` is non-empty. The address is a subaddress, permanent and reusable for that wallet.
3. Send at least 0.1 XMR. After 10 confirmations the relayer calls `mint_deposit`; the owner receives the amount less 0.1%.
4. Track the mint by watching `DepositRecord.total_deposited` grow by the gross amount sent (it counts gross, before the fee).

Working code: `createBridgeDepositAccount`, `fetchBridgeDeposit` in `xmr-swap/src/bridge.ts`; the full send-and-track loop in `xmr-swap/src/rebalancer.ts`; `createDepositAccountWithKeypair`, `fetchDepositAccount`, `claimPendingMintWithKeypair` in `wxmr-frontend/packages/core/src/bridge.ts`.

There is no HTTP API for any of this; the program accounts are the interface.

### Heartbeat

- On-chain only, no HTTP endpoint. Root account: PDA `"heartbeat"`, 58 bytes: 8-byte discriminator, `generation` u64, `updated_at` i64 (Solana clock), `page_count` u16, `digest` 32 bytes (SHA-256 of the gzip payload).
- Pages hold up to 700 bytes each, in two alternating banks; concatenate, verify the digest, gunzip, parse JSON of format `wxmr-heartbeat-v1`.
- Payload fields: `observedAt`, `moneroHeight`, `balanceAtomic`, `unlockedAtomic`, `targetAtomic`, `unlocks[]` (per-maturity buckets), `deposits[]` (pending deposits with confirmations and status), `latestReserve { account, id }`.
- Published every 5 minutes. The UI treats the bridge as offline when either `updated_at` or `observedAt` is more than 360 s old.
- `unlockedAtomic` is the XMR the bridge can pay out right now. The adapter should check it against the refill size before redeeming, not just liveness.

Reader to port: `wxmr-frontend/apps/bridge/src/lib/heartbeat.ts` (`fetchHeartbeat`, `decodeHeartbeatPages`, `validateHeartbeat`, `heartbeatOnline`). Writer and format notes: `wxmr-backend/src/heartbeat.ts` and the "Five-minute heartbeat" section of `wxmr-backend/docs/reserve-proofs.md`.

### Reserve proofs

- Native Monero reserve proofs are generated daily and stored as JSON (format `wxmr-reserve-v1`, at most 16,384 bytes) in an `AuditRecord` PDA with a millisecond id. The newest complete one is named by `latestReserve` in the heartbeat.
- The signed message binds the wallet address, Monero height and block hash, Solana genesis hash, program, mint, slot and wXMR supply.
- The proof shows assets with supply as a reference; it does not enumerate liabilities.
- Independent check: `wxmr-backend/scripts/verify-reserve.cjs <AUDIT_PDA>` with `SOLANA_RPC_URL`, `MONERO_DAEMON_RPC_URL` and `MONERO_RESERVE_VERIFY_RPC_URL` pointing at the verifier's own nodes; it calls `check_reserve_proof`.
- Parsers: `wxmr-frontend/apps/bridge/src/lib/reserve-proof.ts`, `audits.ts`. Spec: `wxmr-backend/docs/reserve-proofs.md`.
- `wxmr-watcher` is a separate read-only checker driven by a public manifest (`wxmr-watcher/public/mainnet.json`).

### Open items for the adapter

- The program's upgrade authority is not recorded in the source; read it from chain. The config authority can change the fee (`set_fee_bps`, up to 100%) and can reverse `Pending` withdrawals (`revert_withdrawal`). There is no pause instruction in the current source.
- Confirm the deployed program matches this source before relying on `cancel_withdrawal` and the deposit fee (the local `target/idl` copy is an older build).

## 4. DEX leg: USDC or SOL to wXMR

All existing swaps go through the **Jupiter aggregator HTTP API**. No code swaps directly against a pool.

| Where | API | Use |
| --- | --- | --- |
| `xmr-swap/src/jupiter.ts` | `swap/v1` on the keyless lite host (`JUPITER_API_BASE` overrides): `GET /quote` with `swapMode=ExactIn` and `slippageBps`, then `POST /swap` | Server-side. `jupBuildSwapTx` returns a base64 versioned transaction with a capped priority fee; `signAndSendBase64Tx` in `solana.ts` signs and sends it. |
| `xmr-swap/src/reverse-executor.ts` | Same | The complete USDC to wXMR to XMR pipeline: buy exact-in, measure the wXMR received from the transaction's own token-balance deltas, then `request_withdrawal` for exactly that amount. This is the refill path in DESIGN.md already working end to end. |
| `wxmr-arb/src/jupiter.ts` | `swap/v1` with an `x-api-key` header, `restrictIntermediateTokens=true`, `wrapAndUnwrapSol` | Keyed variant, class-based client. |
| `wxmr-frontend/apps/bridge/src/lib/jupiter-swap-client.ts` | `swap/v1` (Metis) from the browser, with referral fee and simulation errors | Browser-side quoting with debounce and 429 backoff. |
| `wxmr-frontend/packages/core/src/jupiter.ts`, `packages/shared/src/hooks/useJupiterQuote.ts` | Ultra API | Used by the standalone swap site. |

For SOL input, Jupiter takes the wrapped-SOL mint and wraps and unwraps automatically.

Pool depth: the main wXMR/USDC venue the operator manages is a Meteora DLMM pool (`GgoFghiA6Ca7YNmG6dRxwKQWkZhRK8ND47EREz46arot`, 10 bps bin step; `wxmr-grid-bot`). `wxmr-grid-bot/src/pool.ts` reads its price directly with `@meteora-ag/dlmm` and deliberately refuses to build swap instructions. For the adapter's `max_piece_pct_of_pool` control, use Jupiter's `priceImpactPct` per quote (as `sizedReverseQuote` in `xmr-swap/src/pricing.ts` does) plus a direct pool read for depth.

## 5. Instant-swap service APIs

Read on 2026-11-21 from each service's public documentation or published API spec. Limits, fees and XMR availability can change; re-check before enabling an adapter.

| Service | Base URL | Auth | Quote | Create | Status | Rate types | XMR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ChangeNOW | `api.changenow.io/v2` (v1 still documented) | `x-changenow-api-key` header | `GET /exchange/estimated-amount` (`flow=standard` or `fixed-rate`); limits from `GET /exchange/range` and `/exchange/min-amount` | `POST /exchange` | `GET /exchange/by-id?id=` | Standard (floating) and fixed | Yes: the public currency list returns `xmr` on network `xmr` with fixed rate supported |
| StealthEX | `api.stealthex.io/v4` | `Authorization: Bearer <key>` | `POST /rates/estimated-amount`; limits from `POST /rates/range` | `POST /exchanges` | `GET /exchanges/{id}` | `floating` and `fixed` | Listed on the site's supported-coins page; the API currency list needs a key and was not checked |
| HoudiniSwap | `api-partner.houdiniswap.com/v2` | `Authorization: <ApiKey>:<ApiSecret>` (raw, no prefix); backend use only | `GET /quotes`; limits from `GET /minMax`; tokens from `GET /tokens` | `POST /exchanges` with a `quoteId` | `GET /orders/{houdiniId}`; a WebSocket feed is also documented | Variable and fixed; route types private, standard and DEX | Monero is used as the hop on private routes (`useXmr`); XMR as a payout token was not confirmed without a key |
| FixedFloat | `ff.io/api/v2` | `X-API-KEY` plus `X-API-SIGN` = HMAC-SHA256 of the JSON body with the API secret | `POST /price`; currencies from `POST /ccies` | `POST /create` | `POST /order` with `id` and `token` | `fixed` (1% fee) and `float` (0.5% fee) | Yes: XMR pairs appear in the public rates export |

Notes for adapter design:

- ChangeNOW v2 also exposes `GET /exchange/actions`, `POST /exchange/continue` and `POST /exchange/refund` for held or out-of-range orders.
- StealthEX order statuses: `waiting`, `confirming`, `exchanging`, `sending`, `verifying`, `finished`, `failed`, `refunded`, `expired`. `verifying` is the hold state to alert on.
- Houdini order statuses are numeric: 0 waiting, 1 confirming, 2 exchanging, 3 anonymizing, 4 completed, 5 expired, 6 failed, 7 refunded, 8 deleted. Orders are queryable for 48 hours.
- FixedFloat rate limit is 250 weight units per minute, with `create` costing 50. `POST /emergency` (`choice` of exchange or refund) resolves an order that went into the emergency state.
- All four need the secret kept server-side, so these adapters belong in the maker daemon, never in the console's browser code.

Sources:

- ChangeNOW: [docs landing page](https://changenow.io/api/docs/support) and its linked [Postman collection](https://documenter.getpostman.com/view/8180765/SVfTPnM8)
- StealthEX: [partner page](https://stealthex.io/partners/api/) and [API reference](https://api.stealthex.io/docs)
- HoudiniSwap: [authentication](https://docs.houdini.com/developer-hub/getting-started/authentication), [order lifecycle](https://docs.houdini.com/developer-hub/core-concepts/order-lifecycle) and the published OpenAPI spec for the partner API v2
- FixedFloat: [API page](https://ff.io/api)
