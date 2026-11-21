# SPEC.md adversarial review: fidelity to DESIGN.md and buildability

2026-11-21. Reviewed: `docs/SPEC.md` (1,825 lines) against `docs/DESIGN.md` and `docs/research/*.md`, plus the toolchain on this machine. Nothing was built; byte counts below are hand-computed from the layouts in the spec and are marked as such.

Severity: **critical** = components built to spec would not interoperate, or a Decision is violated. **major** = a feature is dropped, an acceptance command cannot run, or independent implementers must invent an interface. **minor** = imprecision with an obvious fix.

Totals: 3 critical, 13 major, 24 minor.

Checked and found consistent (no finding): Swap account offsets (sum to 704), Offer (768), Maker (max 1,141 of 1,280), Config (256), EthBoard (1,341 of 1,408), compact Ethereum quote offsets (102..150, 199..207, 243..251, total 251), DleqBlob length (56,679), `Maker`/`Swap` discriminators (recomputed: `6MSKcZArUDQ`, `9zzgj4NEBqr`), every row of DESIGN's refund table (section 3.10), all ten taker warnings, all 13 maker tools have a module, all eight self-hosting documentation items, the relay can/cannot table and four connection modes, both DESIGN TOML blocks against the key list in 7.2 (subject to M2 and m1), toolchain versions against the research notes and against this machine (rustc 1.94.1, node 22.21.0, pnpm 9.15.0, anchor 0.32.1, solana 3.0.9, forge/anvil 1.7.1).

---

## Critical

### C1. Ethereum direction A: no way for a taker to obtain the key-pool leaves of a published quote
Sections 2.7, 4.2 (EthBoard), 5.3 (`lock`), 6.1, 6.3, 6.4.

`lock` needs a `PoolLeaf { index, key, key2, spendPub, proof }`. The Solana board carries only `keyRoot`. The only place leaves are ever transmitted is `quote_response.leaves`, which exists only for requested (oversized) quotes. The maker endpoint has four routes (`info`, `msg`, `dleq/<S>`), none of which lists a pool, and the relay path regex allows nothing else. Section 6.4 says "fetch `GET /xs/v1/dleq/<S>` for the chosen pool leaf" without saying where `S` came from. The daemon (WP8), SDK (WP5) and relay (WP6) cannot interoperate on any ordinary Ethereum direction-A swap.

Fix: add to 6.3 `GET /xs/v1/pool/<keyRoot hex>` returning `{ leaves: [{ index, key, key2, spend_pub }] }` (client recomputes the root and its own proof with `merkleRoot`/`merkleProof`); add it to the relay regex in 6.5 (`pool/[0-9a-f]{64}`) and to the HTTPS blob endpoint (contact kind 5); state the response size against the caps (64 leaves is about 13 kB of JSON; 256 leaves exceeds the 16,384-byte Tor cap, so either cap pools at 64 or exempt this route up to 60,000). Add the step to 6.4 and to scenario E-1.

### C2. Ethereum: the auto-refund cutoff ignores the finality wait the spec itself imposes, so shallow-depth swaps refund before the lock can confirm
Sections 3.1 (`Δ_cut`), 3.2 rule 2, 3.4 notes, 7.5 step 4-5.

`Δ_cut = d × 180 + 900` on both chains. The maker MUST wait until NOTICED is final before relaying XMR; on Ethereum "final" is the `finalized` tag, 12.8 to 19.2 minutes after inclusion (the spec's own figure). At depth 2, `T_cut = t_N + 21 min`, but the XMR is broadcast at `t_N + 13..19 min` and needs about 4 more minutes on average (Poisson) for two blocks. The taker's tab, built to 8.5 item 7, refunds at `T_cut`; the deposit is then held. The default tier for swaps under 1 XMR therefore fails most of the time on `eth` and `usdc_eth`; depth 10 (45 min vs 13..19 + about 20) has little slack. The harness will not catch it because it mines on demand. This breaks Launch scope ("both directions, on Solana and Ethereum") in practice.

Fix: define `Δ_cut = F + d × B + CUT_MARGIN_SECS` (Solana 15 s is negligible; Ethereum adds 1,200 s: cutoffs 41 / 65 / 110 min). Recompute the dependent bound `D_c >= max(MIN_CLAIM_DELAY_SECS, Δ_cut + 2M)`: Ethereum at depth 25 becomes 170 min, above the current 150-minute default, so raise the Ethereum default `claim_delay_minutes` to 180. Update the defaults table in 3.1, 7.2, `deadlines.json`, and add a sign-off row.

### C3. Solana: a taker-bound quote `lock` does not fit in a transaction (USDC), and is at the limit for SOL
Sections 2.9, 4.4 (`QuoteArgs`), 4.6. Decision affected: "Quotes on request are kept for oversized swaps."

The design carries every quote field twice: once in the Ed25519 instruction message and again in `QuoteArgs` (the program "rebuilds" the message from arguments). Hand count for a legacy transaction, USDC, with the two compute-budget instructions the SDK is required to add: 14 account keys (448) + Ed25519 instruction (16 header + 96 key and signature + about 239 message = about 355 with framing) + `lock` (8 + 277 + 2 + 144 `QuoteArgs` = 431, about 447 with framing) + compute budget (20) + signature, header, blockhash (102) = about **1,372 bytes** against the 1,232 limit. SOL: about 1,244. A v0 transaction with a lookup table for the five static accounts (config, system program, instructions sysvar, mint, token program; program ids cannot come from a table) saves about 120 bytes: USDC is still about 1,250. The Ed25519-precompile path was never prototyped (research marks it as read, not run) and is absent from Open risks. Scenario M-3 cannot pass on `usdc_sol`.

Fix (pick one and prototype it in WP2 before the IDL freezes this path):
(a) `QuoteArgs` becomes `{ ix_index: u8, maker_pok: [u8; 64] }`; the program parses the remaining fields out of the Ed25519 instruction's message bytes instead of taking them as arguments (saves 79 bytes; then fits with a lookup table), and section 4.4 states that quoted and approved locks MUST be v0 transactions with the protocol lookup table; or
(b) drop the precompile for quotes: add an operator-signed `post_quote(taker, terms…, maker_spend_pub, maker_pok)` that creates a small `Quote` PDA (`"quote"`, maker, `quote_id`), and `lock` consumes and closes it. No signature duplication, no sliding window, maker pays one fee.
Add the chosen path to Open risks with the other as fallback.

---

## Major

### M1. `transitions.json` cannot be replayed "every row" by both contracts
Sections 2.12, 3.8, 5.3, 9.1.

The rows differ by chain: `EXPLICIT_APPROVE` (no AUTO lock to ACTIVE on Ethereum; B4 is always `approval_timeouts`, so counter 13 `missed_funds` is unreachable there), different constants (`M`, `F`, floors), and different caller rules (`claim`/`refund` are signer-gated on Solana and callable by anyone on Ethereum, so every "wrong caller, rejected" row has opposite expected results). The row tuple has no chain field.

Fix: add `chain` (`solana` | `ethereum` | `both`) to each row and generate rows from `apply(..., consts: &ChainConsts)` per chain; change "Both contracts MUST replay every row" to "every row whose `chain` matches". State in 3.7 that counter 13 is Solana-only, and note under Interpretations that DESIGN's "the take lapses and is recorded against it" is recorded on Ethereum only as an approval timeout.

### M2. The default claim delay violates the contract's own bound at the default depth tiers
Sections 3.1, 4.3 (`set_offer`), 7.2, 8.1.

Defaults: depth tiers 2 / 10 / 25 and `claim_delay_minutes = 90` (Solana). `set_offer` validates against the deepest used tier: `D_c >= Δ_cut + 2M = 90 + 10 = 100 min`. So an offer built from defaults is rejected with `ClaimDelayTooShort`. DESIGN's first TOML block sets neither key and has `max_xmr = 200` (tier 25 in use), so it "passes `config check`" only if the check does not apply the on-chain bounds, and then fails at `set_offer`.

Fix: make the daemon default `claim_delay_minutes = "auto"` = `max(90, ceil((Δ_cut(deepest used tier) + 2M) / 60))`, i.e. 100 on Solana at depth 25 (and per C2, 180 on Ethereum). Require `config check` to run every section 3.1 bound and report the effective value. Note the change from DESIGN's 90-minute example under Interpretations.

### M3. A swap does not record the maker's encryption public key, so two rotations plus a reload break notice decryption
Sections 2.8, 4.2 (Swap, Maker), 5.2, 8.4. DESIGN: "A swap keeps its session key through any number of rotations"; "leg state is rebuilt from the program's accounts plus the saved key shares".

The swap stores only `maker_enc_version`. The Maker account keeps the current and one previous key. After two rotations a reloaded tab cannot recover the maker's X25519 key for the swap's version from account state (the `EncKeyRotated` event does not even carry the key), cannot derive `K("notice")`, cannot verify the lock, and must refund with the deposit held.

Fix: add `maker_enc_key: [u8; 32]` to the Solana Swap (the 42 reserved bytes allow it; the program copies it from the Maker account at `lock`/`take`) and `bytes32 makerEncKey` to `TakerKeys`/the Ethereum Swap and `Locked` event (supplied by the taker, checked by the daemon before approval). Add the key to `EncKeyRotated`.

### M4. Ethereum: `swapNonce` is not on-chain, so "one recovery file covers every swap" does not hold
Sections 5.2, 5.5, 8.4.

All taker secrets derive from `seed` + `swap_nonce`. On Ethereum the nonce is only in `lock` calldata: it is in neither the Swap struct nor the `Locked` event, and `swapId` is a hash of it. Resume also relies on scanning `Locked` logs, which the spec elsewhere calls "prunable history".

Fix: add `bytes16 swapNonce` to the Swap struct and to `Locked`; index `taker` in `Locked`; add a view `swapsOf(address taker, uint256 from, uint256 count) returns (bytes32[])` backed by a per-taker array so resume needs only `eth_call`.

### M5. Ethereum direction B: nothing requires the taker to verify the maker's DLEQ proof before sending XMR
Sections 2.6 ("Who verifies what"), 3.11, 6.4, scenario E-1.

In B the maker's commitments arrive in `fund`. The table and 6.4 cover only the pool leaf before `lock`. If `spendPub` in `fund` is not the ed25519 image of the secp scalar behind `key`/`key2`, the maker can take its escrow back with a free refund (B9c) and the taker's XMR at the joint address is unspendable by anyone. A UI built literally to the spec has this hole.

Fix: add a third row to the 2.6 table: "Maker's share supplied in `fund` | Taker's browser | Showing the joint address / sending XMR; the page refuses otherwise". Add to 6.4 (maker serves the blob at `GET /xs/v1/dleq/<S>` before calling `fund`), to 3.11 taker item 3, to the 3.5 "order of the taker's steps" note, and to E-1.

### M6. Inbox replies have no delivery path over Tor, and the taker's key for non-swap messages is undefined
Sections 2.2, 2.8, 6.1, 6.3, 6.5. DESIGN: "Replies go back encrypted to the taker's key and show in the taker UI."

`inbox_reply` is "possibly later", but the Tor transport is request/response only and there is no polling route; the `inbox` body carries no chain address, so the daemon cannot fall back to `post_message` when `swap_ref` is zero. Separately, `enc` is derived per `share_id = swap_nonce`; for `quote_request`, `approval_request` and swap-less `inbox` there is no nonce, so a reloaded tab cannot re-derive the key to read replies.

Fix: (1) add `reply_to` (the taker's address on `chain`) to `inbox`, `quote_request`, `approval_request`; the daemon delivers late replies by `post_message` to that address. Or add `GET /xs/v1/replies/<taker_pub hex>` and allow it in the relay regex. (2) Define the contact key: `share_id = SHA256(DS("contact") ‖ maker PDA)[0..16]`, `chain_tag = 0x01`, key `okm("enc")`; add it to `keys.json`.

### M7. Relay body cap is smaller than a relayed DLEQ upload
Sections 2.6, 6.5.

`PUT /xs/v1/dleq/<S>` carries 56,679 bytes; as `body_b64` inside the `forward` JSON that is about 75.6 kB. "Body cap 60,000 bytes" read as the HTTP body limit (the natural express implementation) rejects every taker proof, so no Ethereum swap works through the relay. The same single cap also lets 60 kB through to `/msg`, where the protocol cap is 16,384.

Fix: "Decoded upstream body cap: 16,384 bytes for `/xs/v1/msg`, 60,000 bytes for `/xs/v1/dleq/*`; the relay's own request-body limit is 96 kB." Add a relay test that forwards a real vector blob.

### M8. `MAX_OPEN_PENDING = 64` is an undeclared deviation, a cheap denial of service, and its bookkeeping is incomplete
Sections 3.1, 4.4, 4.5, 5.3.

Not in DESIGN, not in either Interpretations table. On Ethereum every swap starts PENDING, so 64 minimum-size locks (fully refundable, gas only) block every other taker for `W_a`, repeatably. Only `approve` is said to decrement `open_pending`; `fund`, `reject`, `cancel_pending` and `expire_pending` are silent, so a literal implementation jams permanently. B-AUTO `take` also decrements `capacity_xmr` while PENDING, contradicting 3.3 and 3.8 ("reserves no capacity").

Fix: list the cap under "pending owner sign-off"; make it per maker **and** add a per-taker cap (for example 2 open pending per taker per maker); state that every exit from PENDING (A2-A5, B2-B5) decrements; reword 3.3/3.8 to "reserves no key share; in direction B auto mode the take reserves capacity until funded or lapsed".

### M9. Advance-approval locks on USDC need a v0 transaction with a lookup table; batch size is overstated; none of it is prototyped
Sections 4.4, 4.6, 8.6, 9.2, Open risks.

Hand count for `lock` + Ed25519 approval instruction + compute budget on USDC with an offer: about 1,250 bytes legacy (15 keys). It fits only as v0 with a lookup table, which the spec mentions only for batching. Who creates the protocol lookup table, its contents, and how tests get one are unspecified. Batch: each SOL leg is about 285 bytes of data plus two unshareable keys (swap, session) plus maker and offer; three legs do not fit even with a table (about 1,400), so "2 to 3 legs" should read "2". The research estimate was made for a 180-byte lock.

Fix: add a section "Transaction format": all `lock`/`take` are v0; a protocol lookup table (config, system program, instructions sysvar, USDC mint, token program, treasury) is created at deployment and its address is pinned next to the program id; `svm-rpc` control method `svm_createLookupTable(addresses)`; SDK builds a per-order table for makers/offers only when a wave has more than two legs. Change 4.4 and 8.6 to "2 legs per transaction (1 for USDC with an approval)". Add "Ed25519 precompile verification through the instructions sysvar; v0 + lookup tables under LiteSVM 0.16.0" to Open risks, with fallback C3(b).

### M10. Account lists exist only for `lock`; the frozen IDL must be hand-written before any program exists
Sections 4.3, 4.5, 10.2 (WP1), 10.3.

For about 35 instructions the spec gives signer and args but no ordered account list ("whichever payout accounts its rows need"); `TakeArgs` is defined by difference; `Treasury` (16 bytes) has no layout; Solidity signatures for `reject`, `cancelPending`, `expirePending`, `setReady`, `abort`, `refundUnnoticed`, `releaseDeposit`, `splitDeposit` and most event parameters are elided with "…". All of this is delegated to WP1's artifacts, which makes interop safe but makes the spec unreviewable, and WP1 must produce an Anchor-shaped IDL by hand that `anchor idl build` output from WP2 later has to match field for field (never tried).

Fix: either add the full account tables and Solidity interface to sections 4 and 5, or (better) move ownership of a signatures-only program skeleton (`solana/program/src/lib.rs` with `#[derive(Accounts)]` structs and empty handlers) and `IXmrSwap.sol` into WP1's deliverable, generate the frozen IDL with `anchor idl build` from that skeleton, and hand `solana/program` to WP2 at M0. Define in 10.3 what `check-idl.mjs` normalises (docs, PDA seed metadata, optional-account encoding). Also drop the unused `event-cpi` feature from 1.3 (section 4 says `emit!`; `emit_cpi!` would add two accounts to every instruction).

### M11. WP1's acceptance command cannot run on this machine from a clean checkout
Sections 1.2, 10.3.

(a) `wasm-bindgen` CLI is not installed (not on PATH, not in `~/.cargo/bin`). (b) `tests/monero-regtest` is not in `pnpm-workspace.yaml` (it has its own lockfile), so after a root `pnpm install` it has no `node_modules` and `pnpm test` there fails on the first import. (c) Its `test` script runs `run-rust-sweep.mjs` and `browser/run-browser-sweep.mjs`, which need `rust-sweep` (being moved into swap-core) and a prior `build:wasm`. (d) `XMR_BIN` defaults to `/home/sully/monero` in `env.sh`; fine here, but unstated.

Fix: add a "Prerequisites" block to 10.3: `cargo install wasm-bindgen-cli --version 0.2.130 --locked`; Monero 0.18.4.5 binaries at `$XMR_BIN`; Chromium via `CHROMIUM=` or any build in `~/.cache/ms-playwright` (this machine has builds 1217 and 1234, not the one `playwright-core` 1.56.1 would download, so tests MUST use the harness's `executablePath` discovery, not "Playwright's bundled build"). Add `tests/monero-regtest` to the pnpm workspace and require WP1 to repoint its scripts at `@xmrswap/core-wasm`.

### M12. Sections 4 and 5 tell engineers to lift code from `.scratch/`, which is gitignored
Sections 4 (intro), 5 (intro), `.gitignore`.

`.scratch/solana-curve/program/` and `.scratch/eth-keycheck/evm/` exist only in the author's working tree. An engineer in a fresh clone or worktree has only the excerpts in the research notes (which do not contain `_payout`, the upgrade tests or the session-key sweep in full).

Fix: before M0, commit the two prototypes under `docs/research/prototypes/{solana-curve,eth-keycheck}/` (without `keys/`, `target/`, `out/`) and change both references; or state that the research notes are the only source and delete the `.scratch` references.

### M13. DESIGN's "Cross-chain moves: shifting USDC between the Solana and Ethereum sides" is dropped
Sections 7.2, 7.7. DESIGN "Rebalancing settings".

No venue, config key or rule covers `usdc_sol ↔ usdc_eth`, and there is no Interpretations entry.

Fix: add `[rebalance.cross_chain] enabled (false), venue (one of the enabled venue ids), max_per_tx_usd, max_cost_pct`; state in 7.7 that the `exchange` adapter (withdraw on the other network) and the instant-swap adapters MUST accept `from: usdc_sol, to: usdc_eth` and the reverse, and that levels on `usdc_sol`/`usdc_eth` trigger it. Or record the omission under "pending owner sign-off".

---

## Minor

### Fidelity

- **m1. 7.2 "Every key has a default" is not true in the table.** `max_xmr`, `deviation_pct`, `source`, `daily_cap_xmr`, `max_in_flight_xmr`, `max_per_taker_xmr` show none, and DESIGN's `[markets.sol.sell_xmr]` is enabled without `max_xmr`. Also unstated: DESIGN's block enables `usdc_eth` with no blob endpoint, which 6.4 forbids. Fix: give each a default (`max_xmr` = largest ladder size, `deviation_pct` = 2.0, `source` = `"coingecko"`, caps = unlimited) and say that a missing blob endpoint is a `config check` warning that keeps the market off, not an error.
- **m2. Per-venue rebalance mode.** DESIGN: each venue "can run automatically, wait for approval, or only raise an alert"; 7.7 says "per venue" but the venue tables in 7.2 have no `mode` key. Fix: add optional `mode` to every `[rebalance.venues.*]`, defaulting to `[rebalance].mode`.
- **m3. Rebalancer settings without keys.** Timeouts (DESIGN "Failure handling"), the own-address allow-list (DESIGN "Safety controls"), and the price sources' rate limit have no config keys. Fix: add `[rebalance.routing] venue_timeout_minutes`, `[rebalance.allowlist] xmr, sol, eth` (default: inventory wallet and operator addresses), `[pricing.sources.*] min_interval_seconds`.
- **m4. Offer engine "widens the spread as volatility grows".** Only a volatility pause exists. Fix: add `volatility_widen = { per_pct_move, max_pct }` to `[markets.*.*]`, or note under Interpretations that it is covered by pause plus `on_failure = "widen"`.
- **m5. Tor service tool.** DESIGN: "Runs an onion service"; 7.1: "Does not manage the Tor process". Fix: add an Interpretations row and have `daemon tor print-torrc` emit the two `HiddenService*` lines.
- **m6. Per-taker limit has no mechanism in auto mode.** A Solana AUTO lock is ACTIVE at once; the daemon can only `abort` (A7a), which shows as `aborts_pre_notice`. Fix: say so in 7.1 `risk/`, and have `config check` warn when `max_per_taker_xmr` is set on an auto offer.
- **m7. Offer-update cost panel omits `refill_keys`.** Each AUTO fill consumes a pool slot and refills are extra transactions. Fix: add "key-pool refills (per fill)" to the occasional-costs line in 8.1.
- **m8. Large-swap order state is not persisted.** "Resume after a reload" covers legs, but plan, remainder, worst rate, destination address and deadline are not on-chain or in the recovery file. Fix: 8.6: store the order in IndexedDB, encrypted like the seed; on reload with no stored order, legs still resume and the remainder is reported unfilled. Also define "depth required for the total in flight" as a table of constants in `@xmrswap/protocol` (2 / 10 / 25 at 1 and 50 XMR) and say what the order `deadline` does (no new wave after it).
- **m9. 8.8 configuration reference omits the Ethereum RPC URL and relay URL** although 8.2 Settings has them. Fix: add both.
- **m10. EthBoard quotes are not tied to the board's owner.** A Solana maker can post another maker's signed quotes. Fix: 2.10: clients MUST discard a board quote whose `maker` is not the board owner's mutually linked Ethereum address.
- **m11. Leaf collisions count against the maker.** Two takers naming the same leaf: the second must be rejected and lowers the approval rate. Fix: `approve(bytes32 swapId, PoolLeaf leaf)` lets the operator substitute an unused leaf of the same root (taker verifies its DLEQ before `set_ready`), or count that case under a separate reason.

### Buildability

- **m12. A keyed refund in ACTIVE after `T_note` is undefined in A.** Rule 1's table says locker refund is enabled in ACTIVE at any time; A10a stops at `T_note`. A refund that lands late fails and still publishes `s_T`, contrary to the note under 3.4. Fix: add A10a′: `refund(s_T)` in ACTIVE at `now >= T_note` behaves as A8 (full amount, `missed_notices`, DONE).
- **m13. Direction B, ACTIVE, maker never refunds: the take deposit has no exit.** B6 closes at `T_note`; `T_exp` rules cover only post-notice states. Fix: add B11 `expire_unnoticed` (anyone, ACTIVE, `now >= T_exp`): `Dp` to the taker, `amount` to `owed_maker`, DONE.
- **m14. `LockArgs`/`TakeArgs` have no `asset`.** With a quote the offer account is omitted, yet the signed message includes `asset`. Fix: add `asset: u8` to both and check it against the offer or the presence of the mint.
- **m15. Ethereum `approve(swapId)` "copies the leaf's commitments" but only the leaf hash is stored.** Fix: `lock` writes `makerKey`, `makerKey2`, `makerSpendPub` provisionally; `approve` only marks the leaf used.
- **m16. "closed" on Ethereum.** Swaps are never deleted; say that A3, A4, A5, A7a, A8, B2-B4 end in DONE with `outcome` set, and that a `swapId` can never be reused.
- **m17. Ethereum M-3 "replayed quote id refused" has no contract mechanism** (quotes are multi-use; only `quoteCancelled` exists). Fix: when `q.taker != address(0)` mark `quoteCancelled[maker][quoteId]` at lock; or restrict the assertion to Solana.
- **m18. Boundary conventions differ.** Rule 1 is half-open, but offers use `now <= updated_at + valid_secs`, Ethereum quotes `<= validUntil`, Ethereum approvals `<= validUntil` vs Solana `< expires_at`. Fix: state that validity fields are inclusive on Ethereum and exclusive on Solana, or align them, and add boundary rows to `sol_signed.json`/`eip712.json`.
- **m19. `terms_hash` field widths are implicit.** Fix: write the encoding with types (`u8, u8, u8, u16, u16, u32 × 5, (u64, u8) × 3`, little-endian, 59 bytes after the tag).
- **m20. EIP-712 fixed-size arrays (`uint64[3]`, `uint256[3]`, `uint8[3]`) were not in the prototype.** Fix: add to Open risks; fallback is nine scalar fields per tier set.
- **m21. On-chain message cap vs payload.** A Solana `quote_response` with every 2.9 field, signature and `maker_pok` in hex JSON plus 176 bytes of envelope is about 1,050 bytes, over the 900 cap. Fix: the response omits `cluster_tag`, `program_id`, `maker`, `taker` (the client fills them in) and encodes `sig`/`maker_pok` in base64; add a size vector to `envelope.json`.
- **m22. WP3 clean-checkout prerequisites.** `ethereum/lib` must be vendored (`forge install --no-git`, committed) since acceptance runs offline after `pnpm install`; `foundry.toml` needs `fs_permissions = [{ access = "read", path = "../interfaces/vectors" }]` for `vm.readFile`.
- **m23. WP12: Docker is not installed on this machine.** "Validates the compose file" must be a schema check without `docker compose`, and the "one command" needs a non-Docker equivalent to be testable. Fix: `deploy/` also ships `pnpm --filter @xmrswap/deploy start` (static server + relay; Tor from `/usr/bin/tor` if present) and the test uses that.
- **m24. Smaller ownership and process gaps.** (a) The wXMR bridge IDL lives outside the repository; WP7 cannot "vendor the current IDL": the architect must add it at `packages/rebalancer/vendor/wxmr_bridge.json` before M1. (b) Packages may not commit `pnpm-lock.yaml`, so a clean `pnpm install --frozen-lockfile` fails between milestones; say acceptance runs with `--no-frozen-lockfile`. (c) A root `rust-toolchain.toml` (1.94.1) now sits above `solana/program`; confirm `cargo build-sbf` still selects its own toolchain, since the prototype had no such file above it. (d) The Ethereum notice ciphertext lives only in an event while 5.2 calls logs prunable; store it (four slots) or say why recent-log availability is enough.
