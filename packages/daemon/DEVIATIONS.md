# WP8 (maker daemon) deviations from `docs/SPEC.md`

Same vocabulary as the other hand-over files. **Deviation** = differs from the text. **Choice** =
the text was silent and the smallest sound reading was taken. **Note** = built as written, but
the next package needs to know. **Gap** = specified, not (fully) built. Nothing outside
`packages/daemon/` was edited.

## Configuration (7.2)

| # | Kind | What |
| --- | --- | --- |
| C1 | Choice | Keys added, all optional: `[solana].maker_owner` and `[ethereum].maker_owner` (the public owner keys; without them the daemon cannot know which maker it is), `[solana].subscriptions`, `[ethereum].from_block`, `[monero].own_node`, `[monero].sweep_max_fee` (regtest), `[offers].eth_pool_size` (64), `[liquidity].ladder_headroom_pct` (1.0), `[registration].contacts`, `[daemon].console_dir`, `[daemon].cors_origins`, per offer `without_ready` (`"claim"`/`"abort"`), per keyed source `base_url`, and for the pool `base_vault`, `quote_vault`, `quote`. Unknown keys are errors. |
| C2 | Choice | The wXMR pool reader prices from the pool's two reserve token accounts (named in the file). It does not decode the DLMM pool account. Without the vault addresses the pool cross-check stays off (warning). |
| C3 | Deviation | "Apply without a restart" covers everything except endpoints and keys: a change under `[solana]`, `[ethereum]`, `[monero]` or `[daemon]` (other than `mode`, the priority fee, finality and CORS) is saved and logged, raises an alert, and takes effect at the next start. |
| C4 | Choice | `claim_delay_minutes = "auto"` counts a depth tier as in use when its threshold is at or below `max_xmr`. The published `max_xmr` stays the configured one; `capacity_xmr` is capped at the largest unlocked output, so no single lock can exceed what one output funds. |
| C5 | Note | The bound check of 3.1 is written out in `config/load.ts` and held to the core's `deadlines().boundError` by a test. |

## Durable state and recovery (7.4, 7.6)

| # | Kind | What |
| --- | --- | --- |
| S1 | Choice | Intent life cycle: `planned` (row written before the action) → `sent` (written with the transaction id after signing and BEFORE the bytes leave) → `confirmed`/`failed`. A row found `planned` after a crash was never signed: it is failed and the state machine re-plans from finalized state. A `sent` row is looked up; found = confirmed; blockhash expired or nonce consumed = failed and re-planned; otherwise the swap waits. After 5 minutes (Solana) or 1 hour (Ethereum) unresolved it is parked `needs_review` with a critical alert and is still never re-sent, but it keeps being looked up, so a transaction that lands late is picked up. Transfers to third parties (`venue_transfer`, `xmr_send`) found unresolved at start are parked and never re-sent. |
| S2 | Choice | Monero: the lock is built with `do_not_relay`, stored, and relayed later from the stored bytes; a relay is repeated with the same bytes, so it cannot become a second payment. The sweep is built once (not published), stored, then published; a repeat publishes the stored bytes. |
| S3 | Choice | Coin control: every wallet output is kept frozen in wallet-rpc and only the output reserved for a swap (or the sources of a split or payment) is thawed while the transaction is built. `refills` is not a table: the rebalancer's snapshot and the adapters' state live in `kv`. |
| S4 | Deviation | Encryption private keys in the database are sealed with AES-256-GCM (Node's crypto) under a key derived from the keystore seed by HKDF, not with the core's `passphraseSeal` (scrypt per key would cost seconds per message). The keystore file itself uses `passphraseSeal` as specified. |

## Modules (7.1, 7.5)

| # | Kind | What |
| --- | --- | --- |
| M1 | Note | Inbox: Solana, Tor and the Ethereum-event fallback are read (Ethereum up to the finality tag, from a stored block cursor that starts at block 0). A reply to an Ethereum-transport message is kept at the replies route and posted on Solana when the taker gave a `reply_to`; the daemon never posts a message through the Ethereum contract. |
| M2 | Note | `withdraw_owed` needs a key the daemon does not use for it: a parked payout raises an alert, and `POST /api/swaps/:ref/withdraw-owed-tx` builds the unsigned transaction (A14). |
| M3 | Gap | Opposite-side flow is an alert ("tighten the buy-side deviation"), not an automatic change; the measured refill cost is available (`Rebalance.measuredCostPct`) but is not fed into the deviation automatically. `routing.schedule` understands `every <n>h` / `every <n>m` only. |
| M4 | Note | Status: the upgrade status of both deployments is read from chain state (A11). `tor.published` is real (A12); `tor.reachable` stays `null`: the daemon runs no Tor client and cannot test its own onion service from outside. The reorg guard is driven by the node-status loop (a tip that moves back or changes hash). |
| M5 | Choice | Endpoint rate limits: all circuits arrive from the local Tor, so there is one limit for the endpoint and one per taker key. |
| M6 | Choice | On Ethereum the operator cannot pause (`setPaused` is the owner's); the pause switch stops quoting locally, rejects new locks, and bumps the epochs when asked. |
| M7 | Choice | `[approvals].advance` entries are honoured when the taker asks (`approval_request`), not issued ahead of time. Quotes on request use the same limits as offers and at most the largest unlocked output. |
| M8 | Note | Fees: a Solana transaction is recorded as 5,000 lamports plus the priority fee at 24,120 compute units (20,100 × 1.2); the figure is a constant, not measured per update. A wallet-rpc payment above 2^53 piconero is refused (JSON number precision). |
| M9 | Note | Tests: `pnpm --filter @xmrswap/daemon test` is type-check plus unit tests on the SDK's fakes. The integration test (four full swaps against svm-rpc + the program, anvil + the contract, regtest) is `pnpm --filter @xmrswap/daemon test:integration`, which takes `/tmp/xmrswap-integration.lock` itself. It uses its own regtest wallets (`daemon-it-maker`, `daemon-it-taker`) because the daemon freezes its wallet's outputs. |

## Console contract

What the real API does where the console's mock or the frozen types say otherwise or nothing.
`test/api-contract.test.ts` drives every frozen route through the console's own client.

| # | Subject | Daemon |
| --- | --- | --- |
| A1 | WebSocket auth | `?token=` on the socket URL or the `Authorization` header. A cross-origin upgrade is refused unless the origin is in `[daemon].cors_origins`. |
| A2 | Error codes | As the mock: `401 unauthorized`, `409 revision_conflict`, `409 dry_run`, `422 invalid_config`, `400 invalid_toml`, `404 unknown_swap` / `unknown_message` / `unknown_refill` / `unknown_request` / `unknown_approval`, `409 action_unavailable`, `409 already_registered` / `not_registered` / `solana_first`, `400 bad_signature`, `400 too_long`. Not used by the daemon: `window_closed`, `hold_ended` (both surface as `action_unavailable`), `no_venue`, `in_transit_cap`, `not_awaiting_approval`, `cannot_cancel` (a refused refill is `409 refill_refused` or `409 not_allowed` with the package's message). |
| A3 | Structured config errors | A refused `PUT /api/config`, import or preview carries `issues: ConfigIssue[]` and `warnings` beside `error` and `detail`. |
| A4 | Dry run | Refused with `409 dry_run`: swap actions, split, rotate, revoke, refill approval, published-settings edits. `POST /api/pause` works in dry run (local switch, `txs: []`). `POST /api/rebalance/run` is not refused: it plans, and the package's mode decides. |
| A5 | New routes | `PUT /api/registration/published` `{ contacts?, onion? }` → `{ tx, registration }` (operator-signed `set_contacts` / `set_onion`; `onion: null` follows the Tor hostname file again). `GET /api/registration/links` → `{ entries: [{ chain, old, new, effective_at }] }` from `LinkChanged` on both chains. `POST /api/alerts/:id/ack` → the alert. `POST /api/rebalance/ack/:id` with optional `{ choice: "continue" \| "refund" }` → the refill (acknowledge, or resolve a held order). Redeeming held wXMR has no route. |
| A6 | Extra fields | `status.paused.chains: [{ chain, owner, operator }]`. `sol_usd` and `compute_units_per_update` on `GET /api/fees`, `GET /api/offers` and the preview; `update_cost.daily_usd` is filled whenever a SOL price is known. |
| A7 | Same origin | `[daemon].console_dir` serves the built console from the API's origin (loopback). Other origins get CORS only when listed. |
| A8 | Swap actions | An action records the maker's decision and steps the swap through the same flow as an automatic one; `tx` is the transaction that step sent, or `null` when the flow had nothing to send yet (`detail` says what it waits on). `publish-evidence` is offered only while evidence is due; the daemon publishes it by itself after an abort or refund. |
| A9 | Revision | `revision` is the first 16 hex characters of SHA-256 of the file. The form's round trip works because `parsed` holds exactly the schema's keys; a key the daemon does not know is an error, not ignored. |
| A10 | Operator instructions (new fields) | Every `POST /api/swaps/:ref/{approve,reject,abort,withhold,release,publish-evidence}` answers 200 with, beside the frozen `ok` / `tx` / `detail`: `outcome: "carried_out" \| "refused" \| "pending"` and, when refused, `refused: <reason>`. `ok` is `false` only when refused; `detail` is always a sentence the console can show as it is. Reasons: the SDK's `ready-already-set`, `refund-window-closed`, `abort-window-closed`, `already-settled`, `reject-not-available`, `hold-ended`, `no-deposit-held`, plus the daemon's `not-available-in-state` and `dry-run`. `pending` means the instruction is on record behind a transaction still in flight and is carried out or refused on a later step (an `instruction_refused` alert is raised if refused). `GET /api/swaps/:ref` gains `instruction: { action, at, status, reason, tx } \| null`. The console's client needs `outcome`, `refused` and `instruction` to display these; today it shows `detail` when `ok` is false. |
| A11 | Upgrade status | `status.chains[]`: `upgradeable` (`true` / `false` / `null`) and `upgrade_authority` are filled from chain state, plus `upgrade_status: "upgradable" \| "immutable" \| "unknown"`, `upgrade_reason` (why unknown), `upgrade_pending_authority` (Ethereum: a two-step ownership transfer waiting), `upgrade_implementation` (Ethereum: the ERC-1967 implementation; Solana: the ProgramData account) and `upgrade_checked_at`. Solana: the program's ProgramData upgrade authority (present = upgradable; absent, or a non-upgradeable loader = immutable). Ethereum: the proxy's `owner()` at the finality tag (zero after `renounceOwnership()` = immutable). Refreshed every minute and whenever a status older than that is asked for. The two linked libraries are not listed separately. |
| A12 | Tor | `tor.published` is true when the registry's onion address equals the one the daemon wants listed; `tor.registry_onion` is what the registry shows. `tor.reachable` stays `null` (M4). |
| A13 | Console requests 2, 4, 5, 7, 8 | A published-settings edit in dry run is refused with `409 dry_run` before anything is stored. `RefillView` gains `needs_acknowledgement` (held, or failed with funds possibly at the venue: offer Acknowledge on this) and `acknowledged` (failed and closed). `SwapSummary` (list, detail and the `swaps` channel) gains `mode` and `instruction`. Link history: `old` / `new` are an Ethereum address (0x) for the Solana record and a base58 Solana key for the Ethereum record (empty = no link), with `old_hex` / `new_hex` and `superseded` (replaced before it took effect). `POST /api/config/validate` carries `sol_usd` and `compute_units_per_update`. |
| A14 | Parked payouts | `POST /api/swaps/:ref/withdraw-owed-tx` → `RegistrationTxResponse` (unsigned; submit through `POST /api/registration/submit`); `409 nothing_owed` when nothing is parked. Solana: signed by the owner key. Ethereum: signed by whichever of the payout, operator or owner address the balance is keyed to (the summary names it). |
| A15 | Declined | A route to redeem held wXMR: the bridge adapter runs on documented assumptions with no IDL supplied (rebalancer A1), and a redemption sends value to a third party; it should not get a one-click route before the adapter is checked against the real program. |
| A16 | Refusal reasons (the full list) | `refused` on a swap action and `instruction.reason` are one of: the SDK's `ready-already-set`, `refund-window-closed`, `abort-window-closed`, `already-settled`, `cannot-exit-after-funding`, `reject-not-available`, `hold-ended`, `no-deposit-held`, passed through unchanged; plus the daemon's own `not-available-in-state` (the flow went another way without naming a reason, for example an approval after the window closed) and `dry-run`. `cannot-exit-after-funding` is a taker-side reason and no maker action produces it today; it is in the list so the console needs one table. Any future SDK reason is passed through as it is, with `detail` in plain words. |

## Operator instructions (follow-up to the SDK's BUG-1)

An instruction is written to the swap's row (`facts.instruction`, with its flag in `facts.manual`) before anything acts on it, so it is honoured after a crash or restart; the crash matrix cuts at that point too (`instructed`). What the audit changed:

- **Abort in direction A once ready is set** was silently overtaken by the automatic claim. It is now refused with `ready-already-set`.
- **A refused instruction left its flag set** and could fire later when the state changed. Instructions are one-shot; the flag is cleared when the instruction settles. Exception: a refused *reject* (Solana take outside window mode) stays the decision, so the daemon does not fund a take the operator said no to; it lapses.
- **An instruction whose own transaction died** was forgotten. It now counts as carried out only when its transaction is confirmed, and is planned again otherwise.
- **Pause** did not stop an automatic approval whose verdict was already on record. While paused, a stored automatic "approve" is not acted on; the rules decide again and reject. An explicit approval by the operator is still honoured while paused.
- A standing "do not withhold this one" (`withhold: false`) is a policy override, not a one-shot instruction, and persists.

