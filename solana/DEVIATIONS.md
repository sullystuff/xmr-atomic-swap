# WP2 deviations from `docs/SPEC.md`

Recorded by work package 2 (the Solana program) while building M1. Same conventions as
`docs/research/wp1-deviations.md`: **Deviation** = the program differs from the text;
**Choice** = the text was silent or ambiguous; **Note** = built as written, but someone else
needs to know. Where SPEC and the frozen interfaces or vectors disagreed, the frozen artifact won.

Nothing under `interfaces/` was edited. No interface change is requested; the two items an
architect may want to fold back are marked **(for SPEC)**.

## Spike (SPEC 4.6)

| # | Kind | What | Why |
| --- | --- | --- | --- |
| K1 | Note | **The Ed25519-precompile path works under LiteSVM 0.16.0; the `Approval`-account fallback is not needed.** A `sol_signed.json` instruction (302 bytes of data, all three instruction-index fields `0xFFFF`) passes the runtime's precompile, the program reads it through the instructions sysvar at `approval_ix`, and a tampered signature fails the transaction before the program runs. | First task of WP2. Tests: `approval::spike_precompile_verifies_vector_instructions_verbatim`, `approval::every_sol_signed_case_through_lock_and_take`. |
| K2 | Note | LiteSVM loads the precompiles only with its `precompiles` cargo feature. `solana/tests` enables it; **`tools/svm-rpc` (WP4) must too**, or every transaction carrying an advance approval fails with "program not found". | `litesvm = { version = "=0.16.0", features = ["precompiles"] }`. |
| K3 | Note | A transaction with an approval pays for two signatures (10,000 lamports): the precompile's signature counts toward the fee. | Observed; clients that budget fees exactly need it. |

## Build

| # | Spec | Kind | What | Why |
| --- | --- | --- | --- | --- |
| B1 | 1.3 `solana/program` dependencies | Deviation | Added `solana-sha256-hasher = "2.3"` (the SHA-256 syscall). `Cargo.lock` gained that one dependency edge; the crate was already locked at 2.3.0 and the `blake3` pin is untouched. | Anchor 0.32.1's `solana_program` facade has no `hash` module. |
| B2 | 1.3 `solana/tests` dependencies | Deviation | Added `serde_json`, `hex`, `solana-account`, and the `precompiles` feature of `litesvm`. One test binary (`tests/suite.rs`, `autotests = false`); dependencies are built at `opt-level = 2` with no debug info. | Vectors are JSON; `set_account` needs the account type; one binary because each links LiteSVM statically. |
| B3 | 4 "Box every typed token account" | Note | `RefreshOffers.eth_board` is `Option<Box<Account<EthBoard>>>` (the 1,333-byte struct must not sit on the SBF stack) and `OpenSwap.taker` is an `UncheckedAccount` with `signer @ Unauthorized`. The generated IDL is identical (`check-idl.mjs` passes). | See V1 for the second. |

## Conventions the vectors fix

| # | Spec | Kind | What | Why |
| --- | --- | --- | --- | --- |
| V1 | 4.4 "Signer: taker wallet" | Choice | A `lock` or `take` without the taker's signature fails with `Unauthorized` (6000), not Anchor's `AccountNotSigner`. | `transitions.json` rows "A1/B1 wrong caller" expect `Unauthorized`. On Solana the only way another party can "call lock" for a taker is to submit it unsigned. |
| V2 | 4.4 step 4, 4.8 `StaleEpoch` | Choice | Every reason an advance approval does not admit the lock (not yet valid, expired, wrong asset or direction, over `max_xmr`, stale epoch, wrong key, wrong bindings, wrong length or tag) is `ApprovalInvalid`. `SignatureInstructionInvalid` is only for an instruction that is not a single self-contained Ed25519 signature (or a missing sysvar account). `StaleEpoch` is used for quotes only. | `sol_signed.json` gives `ApprovalInvalid` for all of them, including `stale-epoch`. |
| V3 | 4.5 "Session key lamports ... the lamports go to the swap account and are added to `owed_taker`" | Deviation **(for SPEC)** | When the taker cannot hold the swept lamports they go to the swap account and are **not** added to `owed_taker`. They return to the taker with the rent when the swap is closed. | The vector `parked/A/refund` (session-key caller, taker cannot receive) fixes `owed_taker` to exactly the parked payout. For a USDC swap `owed_taker` is in token units, so adding lamports to it would be wrong in any case. |
| V4 | 3.4 "closed" rows | Choice | A row marked closed closes the swap (and its vault) in the same instruction only if nothing was parked, nothing is owed, the taker's wallet can hold lamports and, for USDC, the vault can be emptied. Otherwise it ends in DONE and `close_swap` finishes the job. | The first condition is the model's; the others only arise in states the model does not describe. |
| V5 | 3.1 arithmetic | Note | **Superseded by M1 follow-up 2.** `lock`, `take` and `post_quote` refuse `xmr == 0` or `amount == 0` with `AmountOutOfRange` (a direction-B dust take whose floor is zero would lock the taker's XMR against nothing). The check is repeated where a quote is consumed. | SPEC 3.1; `transitions.json` rows "amount zero" / "xmr zero"; `amounts.json` op `swap`. Tests: `fees::zero_amount_and_zero_xmr_are_refused_by_lock_take_and_post_quote`, `fees::amounts_json_swap_refuses_zero_xmr_and_zero_amounts`. |
| V6 | 4.4 step 3 | Choice | `lock`/`take` do not re-check that an offer's tiers are well formed (`set_offer` and `refresh_offers` do). A size with no used depth tier gives depth 0, which the bounds refuse with `DepthInvalid`; with no used price tier, `TiersInvalid`. | Row "depth zero" expects `DepthInvalid` from the lock. |

## Pay or park (SPEC 4.5)

| # | Kind | What | Why |
| --- | --- | --- | --- |
| P1 | Choice | **Addresses that can never change are requirements; destination *state* always parks.** The `taker` account, the taker's associated token account, the Treasury PDA (or the incinerator for a burned split) and the treasury vault must be the right addresses, in every instruction including `claim` and `refund`: a wrong one fails with `Unauthorized`, a token account left out of a USDC swap's instruction with `WrongAsset`. Whether such an account exists, is initialised, is frozen, is executable or would stay rent-exempt never fails anything: the payout is parked. | Without this, any caller of a keyless instruction (`expire_pending`, `refund_unnoticed`, `release_deposit`, `split_deposit`, `expire_unnoticed`) could force the taker's money to be parked by omitting or mis-naming an account. These addresses are fixed at lock, so a simulation catches a mistake. |
| P2 | Choice | **The maker's destination is soft.** If `maker_wallet` is not the wallet the instruction pays (`maker.payout` for a claim in A, `maker.operator` for a refund in B) or `maker_token` is not its associated token account, the payout is parked for the owner to `withdraw_owed`. | `set_payout` / `set_operator` can land between a claim's simulation and its execution; the claim's secret would be public either way. Test: `park::a_payout_address_changed_under_a_claim_in_flight_parks_instead_of_failing`. |
| P3 | Choice | The incinerator is always able to receive (the runtime exempts it from rent), so a burned SOL half is never parked for being below the rent minimum. If a USDC burn is impossible (frozen vault) the half is parked in `owed_treasury`, and `withdraw_owed(2)` later delivers it to the treasury vault, not to a burn. | The runtime's rule; the second is the only consistent destination for a pinned withdrawal. |
| P4 | Note | In burn mode (`split_mode = 1`) `split_deposit` on a SOL swap must be given the incinerator in the `treasury` slot; the Treasury PDA is refused there. Fees of a claim go to the Treasury PDA in both modes. | 4.5 table. |
| P5 | Deviation (S5 of WP1) | `withdraw_owed` does not create the destination token account. | The Settle list has no associated-token program and no payer. The caller puts an idempotent ATA-create instruction before it in the same transaction. |
| P6 | Note | Order of effects inside a settling instruction: token CPIs, then the session-key sweep (a system-program CPI), then lamports moved by hand (SOL payouts, closing the swap). | The runtime compares the caller's lamport total when a CPI starts; a hand-moved account that is not passed to that CPI has not been written back yet (`UnbalancedInstruction`). |
| P7 | Note | A session key funded with exactly the rent minimum can never pay a fee (a fee payer must end a transaction rent-exempt or at zero, and the fee is taken first). The budget must be the rent minimum plus one fee per transaction; the last one sweeps the key to zero. | Test `session::session_key_lamport_rules`. Consequence: the sweep is always at least the rent minimum, so it only fails to reach a taker whose wallet is executable. |

## Errors where the text names none

| # | Where | Error |
| --- | --- | --- |
| E1 | A malformed argument: `split_mode > 1`, offer `mode > 2`, `inbox_policy > 1`, board slot `>= 4`, `refill_keys` with 0 or more than 8 slots or an index `>= 16`, `withdraw_owed` with `who > 2`, `transfer_admin` to the default key, `refresh_offers` with fewer accounts than offers, refreshing an empty board slot | `ProgramError::InvalidArgument` |
| E2 | `reject` with a reason above 2 (M7 of WP1) | `BadState` |
| E3 | `post_quote`: `expires_at < now` / `expires_at > now + 120` | `QuoteExpired` / `QuoteMismatch` |
| E4 | `rotate_enc_key`: `prev_expires_at < now` | `TooLate` |
| E5 | `lock`/`take` with both or neither of `offer` and `quote` | `BadState` |
| E6 | An offer that belongs to another maker; `quote_rent_receiver` that is not the operator; a swap whose `maker` is not the maker account passed | `Unauthorized` |
| E7 | `sweep_treasury` (SOL) for more than the lamports above the rent minimum; `set_offer` with `min_xmr > max_xmr` or `max_xmr = 0` | `AmountOutOfRange` |
| E8 | `close_swap` of a swap that is not DONE or that still owes something (checked before the caller) | `NotClosable` |

## Registry details the text leaves open

| # | Spec | What |
| --- | --- | --- |
| R1 | 4.3 `set_offer` "validates every bound ... against the deepest used depth tier" | `W_a` is checked only for a WINDOW offer. The final window is checked for every pending kind a swap from the offer can start in (WINDOW: `W_a`; direction B: also `W_n`, which an approved take waits). `price_above[0]` must be 0; the price tiers are checked for being well formed at `refresh_offers`, when an offer is enabled (prices arrive there). Depth tiers all unused is `DepthInvalid`; otherwise malformed tiers are `TiersInvalid`. |
| R2 | 4.3 `refresh_offers` | Only a board slot that holds a quote (`set_eth_quote` was called for it) can be refreshed. `OffersRefreshed.count` is offers plus Ethereum entries. |
| R3 | 4.3 `set_eth_link` | A second change before the pending one matures replaces it and restarts the 7-day delay. |
| R4 | 4.4 quotes | A quote's swap stores `price = 0` (a quote has an amount, not a price). An advance approval presented together with a quote is still verified. Offer size limits and capacity do not apply to a quote. |
| R5 | 4.4 step 5 | `approve` does not consume offer capacity (a pending lock reserves none and the maker chooses to approve). |
| R6 | 4.3 `initialize` | The treasury vault bump is not stored; the vault address is re-derived where it is checked. |

## SPEC 4.10 transaction sizes **(for SPEC)**

Measured with one signature and the two compute-budget instructions, each transaction executed
(`sizes::every_transaction_of_spec_4_10_fits_one_legacy_transaction`). Ten of the eleven rows are
exactly the hand-computed figures. One differs:

| Transaction | SPEC | Measured |
| --- | --- | --- |
| `lock`, USDC, against a `Quote` account | 15 keys, 875 bytes | **14 keys, 843 bytes** (the offer is dropped, the quote and its rent receiver are added: 13 − 1 + 2) |

The largest single-swap transaction is `lock`, USDC, with an advance approval: 1,182 bytes. Two
USDC locks for two makers are 1,244 bytes and do not fit, as the text says.

## Compute units (SPEC 4.9)

Measured by `sizes::compute_units_of_the_main_instructions` (address-dependent by a few hundred
units; asserted as ceilings).

| Instruction | SOL | USDC |
| --- | --- | --- |
| `lock` (offer, ACTIVE) | 38,000 | 47,900 |
| `lock` + advance approval | 37,300 | 45,700 |
| `take` | 40,900 | 46,300 |
| `approve` / `fund` | 23,100 / 25,800 | 23,100 / 29,600 |
| `post_notice` / `set_ready` | 14,800 / 14,700 | same |
| `claim` (A) / `claim` (B, session key) | 25,100 / 27,200 | 33,900 / 36,000 |
| `refund` (A, session key, held) / `refund` (B) | 24,300 / 22,900 | 30,000 / 33,300 |
| `withhold` with evidence / `split_deposit` | 15,100 / 22,300 | 15,100 / 31,200 |
| `close_swap` | 18,700 | 23,400 |
| `refill_keys`, 8 slots | 73,700 | |
| `refresh_offers`, 4 offers + 4 ETH quotes | 20,100 | |

## How the vectors are replayed

| # | Vector | Note |
| --- | --- | --- |
| T1 | `transitions.json` | All 405 Solana rows and 182 sequences (729 steps) run against the built program, **twice**: with SOL and with USDC as the asset. `chain: both` never occurs (C15 of WP1). Compared per step: result or exact error, the whole swap record, the maker's counters and totals, and every lamport and token (escrow in, paid, parked, session sweep, rent on close). |
| T2 | `transitions.json`, terms out of bounds | `set_offer` refuses such terms (asserted, same error). To exercise the check in `lock`/`take` itself the offer account is then written directly with `set_account`. |
| T2b | `transitions.json`, "amount zero" | No price turns a nonzero `xmr` into an amount of zero in direction A, and a price of zero marks a tier unused, so these rows are quotes: `post_quote` refuses them (asserted, same error), and the `Quote` account is then written directly so that `lock`/`take` itself refuses. `amounts.json` `swap-*-zero-price` is replayed the same way (a live offer cannot carry a zero price: `refresh_offers` answers `TiersInvalid`). |
| T3 | `transitions.json`, "cannot receive" | USDC: the destination token account is frozen. SOL: the destination is replaced by an executable account (a payout address that is a program). LiteSVM refuses to mark an ordinary account executable, so the stand-in is owned by the native loader. The one exception is a direction-B refund on SOL: the destination is the operator, which signs and pays the fee and cannot be executable, so the maker's destination is made unusable by naming another wallet in `maker_wallet` (P2). |
| T4 | `transitions.json`, session key after a sweep | A session key swept to zero by an earlier step is sent lamports again before a later step that it signs, so the program (not the fee check) answers. |
| T5 | `sol_signed.json` | The vectors are signed for a placeholder program id, maker and taker. Each case is checked byte for byte against the harness's encoder and the runtime's precompile, and then replayed through `lock`/`take` with those three bindings replaced by the real ones (a binding the case makes wrong stays wrong), signed with the vectors' operator seed at the case's time, asset, direction, size and epoch. |
| T6 | `pok.json` | A proof's context is a PDA the vectors cannot choose. The four valid proofs are reproduced byte for byte by the harness's prover; the eleven invalid kinds are rebuilt for real contexts and refused at all six instructions that store a share. |
| T7 | `amounts.json` | Cases are selected by their `chains` field. A `pay`, `receive`, `bps` or `tier` case whose size or result is zero states arithmetic only; on-chain that open is refused, and the test asserts the refusal. `split-0` uses a swap with a 0 bps deposit. The `u64::MAX` split is run on a real held swap whose `deposit` field and vault balance are written directly (no amount has a 1% deposit that large). The tier cases run as direction-A locks (direction B would round small sizes to zero). |
| T8 | `terms.json` | `extremes` uses values no offer may carry; its hash is checked against the harness only. The other six are published and compared with the stored `terms_hash`. |
| T9 | `points.json` | All 18 invalid commitments at all six instructions; all 100 valid points locked and opened by a real refund; the six bad openings; Monero's 272 rows (256 locked and refunded with Monero's own key pairs, 16 unreduced secrets refused); the 14 low-order X25519 encodings at `register_maker`, `rotate_enc_key`, `lock`, `take`. |

No vector row or case was skipped, weakened or special-cased to pass.

## What WP5 (SDK) and the end-to-end harness need to know

- An absent optional account is the program id, read-only. For a USDC swap all six token slots of
  the Settle list must be filled; for SOL all six are absent.
- With the two compute-budget instructions first, the Ed25519 instruction is index 2:
  `approval_ix = Some(2)`. Its data layout is header (2) ‖ offsets (14) ‖ key (32) ‖ signature
  (64) ‖ message (190); the program accepts any offsets as long as they stay inside that
  instruction.
- `maker_wallet` / `maker_token`: `maker.payout` (and its ATA) for `claim` in A; `maker.operator`
  (and its ATA) for `refund` in B. For `withdraw_owed(0)` the `taker` / `taker_token` slots are
  the destination the taker names; for `withdraw_owed(1)` (signer: the maker's **owner**) the
  `maker_wallet` / `maker_token` slots are; for `withdraw_owed(2)` the treasury slots are pinned.
- Token destinations are never created by a payout. A missing or frozen taker ATA or payout ATA
  parks the payout; `withdraw_owed` needs an existing destination token account.
- `fund` takes the operator's own token account in `operator_token`.
- An offer is live only after `set_offer` **and** a `refresh_offers`, and direction A in auto mode
  needs pool keys (`refill_keys`, a slot that is filled and unused cannot be overwritten). Every
  `refresh_offers` resets `capacity_xmr`. `set_offer` zeroes the prices and disables the offer.
- The session-key budget rule is P7. A wallet-signed `refund`/`claim` does not sweep the key;
  `close_swap` signed by the key does.
- `close_swap`: after a claim only the locker side may close (A: taker or its key); after a
  refund only the claimer side (A: operator), or the taker once `t_settled + 30 days` has passed.
  It returns all rent (swap and vault) to the taker.
- Re-locking with the same nonce after a cancel reuses the PDA; the open hash then differs
  (`binding.rs`), which is what `expected_open` is for.
- Events are Anchor `emit!` logs (`Program data:` lines). `PayoutParked.who` /
  `OwedWithdrawn.who`: 0 taker, 1 maker, 2 treasury.
- LiteSVM specifics hit while testing: `set_account` refuses `executable: true` unless the owner
  is a loader with a valid program (or the native loader); a failed transaction still charges
  the fee payer; a byte-identical retry needs a fresh blockhash.
