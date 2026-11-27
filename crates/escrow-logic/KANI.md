# Kani proofs (SPEC 11.4)

```
cargo install --locked kani-verifier && cargo kani setup     # once; under ~/.cargo and ~/.kani
cargo kani -p escrow-logic && cargo kani -p swap-core        # acceptance of A1
cargo kani -p escrow-logic -j 16 --output-format terse       # the same, in parallel
```

Pinned: **Kani 0.68.0** (CBMC 6.11.0, solver CaDiCaL, toolchain `nightly-2026-08-21`). Kani's stubbing feature is switched on in the root `Cargo.toml` (`[workspace.metadata.kani.unstable]`).

Harnesses: `crates/escrow-logic/src/proofs/` (one file per group) and `crates/swap-core/src/model_proofs.rs`. Every harness below was run on the build machine; the table is the last run (2026-11-27). "Solver" is Kani's own "Verification Time"; the whole run takes 40 minutes single-threaded on the build machine (2388 s of it in the solver).

## How to read the bounds

* **Record**: a harness that says "every record" takes a fully symbolic swap record: every field of every state, reachable or not, on both chains' constants. It is limited only by `sane` (`proofs/mod.rs`): times within ±2^40 s, amounts below 2^124 and within the chain's amount type, the deposit a share of the amount (A) or `amount + deposit` within the type (B, checked at `take`), the fee share the chain's constant.
* **Induction instead of sequences.** SPEC 11.4 asks for sequence properties bounded to 8 calls. Properties of whole runs are proved here as invariants: one harness shows `lock`/`take` establish the invariant, another that every call preserves it for every record that has it. That holds after any number of calls, for any number of swaps. Sequence harnesses are kept as cross-checks where the solver can carry them; their bounds are in their names.
* **`stub`**: `fee_of` (and `deposit_of`, where `open` runs) is replaced by "any value not above the amount". `fee_and_deposit_never_exceed_the_amount` proves that contract for the real function at every share the machine can pass, so the replacement only widens what is checked.
* **Widths.** The solver is a SAT solver. It cannot reorder long sums of 128-bit values, cancel a symbolic time out of a six-term inequality, or relate a product to its factors at full width. Where a property needs that, the harness is narrowed and the width is in its name (`_u8`, `_u12`, `_u16`, `_u24`, `_at_time_0`).

## Results

| Group | Harness | Property | Bound | Result | Solver |
| --- | --- | --- | --- | --- | --- |
| `arith` | `fee_and_deposit_never_exceed_the_amount` | Fee and deposit never exceed the amount; computing them cannot overflow | every `u128` amount; shares up to 8,191 bps (the machine passes 5 and at most 500) | proved | 5.7 s |
| `arith` | `the_fee_and_the_largest_deposit_stay_within_the_amount` | `fee_of` and `deposit_of` at 0, 5 and 500 bps stay within the amount | every `u128` amount | proved | 0.5 s |
| `arith` | `shares_up_to_100_percent_never_exceed_the_amount_u24` | The same for every share up to 10,000 bps | **amounts below 2^24** | proved | 34.7 s |
| `arith` | `shares_above_100_percent_never_overflow` | A share above 100% (never used) saturates without overflow | every `u128` amount | proved | 3.6 s |
| `arith` | `bps_is_the_exact_floor_u8` | `bps_of` is exactly `floor(amount × bps / 10^4)` | **amounts below 2^8**, shares up to 500 bps | proved | 1.6 s |
| `arith` | `split_halves_sum_to_the_deposit` | Split halves sum to the deposit; the taker's is the larger by at most one | every `u128` deposit | proved | 0.2 s |
| `arith` | `mul_div_never_overflows` | `mul_div` never panics or overflows; a zero divisor is refused | every three `u128` values | proved | 11.8 s |
| `arith` | `pay_amount_never_overflows` | `pay_amount` (direction A) never overflows and stays within the limit | every `u64` size, `u128` price and limit | proved | 1.3 s |
| `arith` | `receive_amount_never_overflows` | `receive_amount` (direction B), likewise | every `u64` size, `u128` price and limit | proved | 6.4 s |
| `arith` | `a_swap_amount_is_never_zero` | The amount of a swap is never zero and never above the limit, in either direction | every `u64` size, `u128` price and limit | proved | 10.3 s |
| `arith` | `pay_amount_of_something_is_never_zero_u16` | Direction A: a nonzero size at a nonzero price pays at least one unit and is not refused | **sizes and prices below 2^16** | proved | 0.6 s |
| `arith` | `mul_div_is_exact_u8` | `mul_div` is the exact floor and reports exactness | **operands below 2^8** | proved | 92.1 s |
| `arith` | `bounds_and_deadlines_never_overflow` | Bounds and deadlines are computed without overflow; `T_ff >= T_co`; accepted parameters are in range | every parameter the types admit; times within 2^40 | proved | 0.5 s |
| `arith` | `open_never_overflows` | `lock`/`take` never overflow; an accepted swap has `0 < amount <= max`, a deposit within the amount, a counted value that fits | any arguments, caller, environment; both chains (stub: deposit) | proved | 1.1 s |
| `encodings` | `canonical_scalar_is_exactly_below_l` | `is_canonical_scalar` accepts exactly the values below `ℓ` (and the nonzero variant excludes zero) | every 32 bytes | proved | 0.5 s |
| `encodings` | `low_order_x25519_keys_are_rejected` | All 14 low-order X25519 encodings are flagged, bit 255 never matters, nothing else is flagged | every 32 bytes | proved | 17.9 s |
| `encodings` | `identity_encodings_are_rejected` | Exactly the four spellings of the identity are flagged | every 32 bytes | proved | 0.3 s |
| `conservation` | `pending_rows_conserve_the_escrow` | `approve`, `fund`, `reject`, `cancel_pending`, `expire_pending`: stake in = stake out + paid + parked; each parked balance grows by exactly what was parked | every record | proved | 31.3 s |
| `conservation` | `notice_ready_freeze_and_abort_conserve_the_escrow` | The same for `post_notice`, `set_ready`, `freeze`, `abort`, `refund_unnoticed`, `expire_unnoticed`, `publish_evidence` | every record | proved | 30.0 s |
| `conservation` | `refunds_conserve_the_escrow` | The same for `refund` (every row, held or free) | every record | proved | 25.1 s |
| `conservation` | `claims_conserve_the_escrow` | The same for `claim` (every row) | every record (stub: fee) | proved | 31.1 s |
| `conservation` | `deposit_rows_conserve_the_escrow` | The same for `release_deposit`, `withhold`, `split_deposit` | every record | proved | 26.6 s |
| `conservation` | `parked_balances_conserve_the_escrow` | `withdraw_owed`, `pushOwed`: one balance leaves whole, once, to its own party; nothing else moves | every record | proved | 23.3 s |
| `conservation` | `nobody_is_paid_who_the_row_does_not_name` | Who each call may pay and how much; a direction-B claim pays the payout address and no other; the payout address is paid by nothing else | every record (stub: fee) | proved | 32.1 s |
| `conservation` | `the_deposit_never_reaches_the_maker` | In HOLD and WITHHELD no call pays or parks anything for the maker | every HOLD or WITHHELD record | proved | 14.8 s |
| `conservation` | `sequences_of_8_never_pay_more_than_was_locked_u12` | Sequences: the ledger (in minus paid) equals what the record holds after every call; paid never exceeds locked; a settled swap with nothing parked holds nothing | 8 calls, **amounts below 2^12**, opened at time 0 (stub: fee, deposit) | proved | 848.3 s |
| `windows` | `secret_calls_are_enabled_for_at_most_one_party` | Invariant 1: refund and claim are never both enabled, for any pair of callers; no claim without a notice | every record (no deadline order assumed), every instant | proved | 1.6 s |
| `windows` | `only_the_party_can_submit_its_secret_call_solana` | Solana: only the locker's keys refund, only the claimer's claim | every record | proved | 0.7 s |
| `windows` | `secret_call_windows_are_the_table` | The windows of SPEC 3.2 and 11.6 state by state, FROZEN included | every record | proved | 2.1 s |
| `exits` | `every_funded_state_has_an_exit_for_each_party` | Invariant 2: PENDING cancel/expire; ACTIVE refund and the keyless rows; post-notice claim throughout `[T_final, T_exp)` and locker refund from `T_exp`; HOLD/WITHHELD cranks; parked balances can be pulled | every record with the deadline order, every instant | proved | 74.6 s |
| `exits` | `done_is_final` | After DONE only parked balances move and evidence can be published | every DONE record | proved | 12.5 s |
| `exits` | `open_establishes_the_deadline_order_at_time_0` | Induction base: every accepted `lock`/`take` starts with the deadline order | any arguments and environment; **opened at time 0** (stub: deposit) | proved | 15.8 s |
| `exits` | `open_sets_every_deadline_as_the_opening_time_plus_its_window` | The opening time enters the record only as one added term per deadline; acceptance does not depend on it | any opening time within 2^40 | proved | 4.6 s |
| `exits` | `pending_rows_keep_the_deadline_order` | Induction step for `approve`, `fund`, `reject`, `cancel_pending`, `expire_pending` | every record with the invariant | proved | 23.1 s |
| `exits` | `post_notice_keeps_the_deadline_order` | Induction step for `post_notice` (late notices included) | every record with the invariant | proved | 21.9 s |
| `exits` | `freeze_and_abort_keep_the_deadline_order` | Induction step for `freeze` and `abort` | every record with the invariant | proved | 18.6 s |
| `exits` | `every_other_call_keeps_the_deadline_order` | Induction step for every remaining call but `set_ready`; no call leaves the deposit sub-machine or DONE | every record with the invariant | proved | 28.9 s |
| `exits` | `the_deadline_order_gives_the_ready_margin` | Lemma: NOTICED or FROZEN with the invariant has `T_co + W_z + W_c + 86,400 < T_final` | every record with the invariant | proved | 50.5 s |
| `exits` | `set_ready_keeps_the_deadline_order` | Induction step for `set_ready` (from NOTICED and from FROZEN): `T_cd < T_final − 86,400` | every record with the invariant and the margin | proved | 4.0 s |
| `exits` | `the_deadline_order_is_the_order_of_the_spec` | The invariant gives SPEC 3.2 and 11.6: `t_N < T_nl`, `T_cut <= T_co − 2M`, ready possible before `T_co`, `T_co <= T_ff < T_co + W_z`, `T_ff < T_final − W_c − 86,400`, `T_cd < T_final − 86,400` | every record with the invariant | proved | 44.3 s |
| `exits` | `sequences_of_3_keep_the_deadline_order` | Sequences: the invariant holds after every call | **3 calls**, opened at time 0 (stub: fee, deposit) | proved | 303.3 s |
| `switches` | `no_switch_changes_any_call_but_lock_and_take` | Invariant 3: carrying out any row with any payout plan gives the identical result under any two positions of caps, pause and pending count | every record, row and plan | proved | 8.6 s |
| `switches` | `caps_at_zero_and_every_pause_change_no_answer` | Invariant 3 end to end: every cap zero and the maker paused against no switch set: same decision, state, counter, open value, payouts | every record, call, caller, instant (stub: fee) | proved | 60.8 s |
| `switches` | `lock_and_take_obey_the_caps` | A pause and a fresh deployment refuse every open; an accepted open respects both caps; the add is exact and fits | any arguments and environment (stub: deposit) | proved | 1.6 s |
| `switches` | `counted_flag_is_an_invariant` | Counted exactly while open: preserved by every call; the open value drops by the counted value once, at the transition into HOLD or DONE; no swap re-opens | every record with the invariant (stub: fee) | proved | 28.0 s |
| `switches` | `sequences_of_8_open_value_is_the_sum_of_open_swaps_u12` | Sequences over two swaps: the open value is the others' plus the counted values of the swaps still open after every call | 8 calls, 2 swaps, **amounts below 2^12**, opened at time 0 (stub: fee, deposit) | proved | 399.6 s |
| `freeze` | `a_watcher_can_only_freeze` | For every call but `freeze` the watcher gets exactly the decision a stranger gets; a swap that does not name it gives it nothing | every record, call, instant | proved | 9.4 s |
| `freeze` | `freeze_moves_nothing` | `freeze`: only the named watcher or the locker, only NOTICED before `T_co`, only once; pays nothing; changes the state and `t_freeze` only | every record | proved | 4.0 s |
| `freeze` | `a_freeze_never_shortens_the_lockers_window` | `T_ff >= T_co`; after a freeze the locker's `refund` and `set_ready` are enabled until `T_ff` and wherever they were before; the claim opens at `T_ff`, at most `W_z` later | every NOTICED record, freeze time and later instant | proved | 6.3 s |
| `freeze` | `a_frozen_swap_can_always_be_unfrozen` | There is an instant at which the locker can set ready, giving READY with `T_cd = t_R + W_c` | every FROZEN record whose earliest ready precedes `T_co` | proved | 1.8 s |
| `swap-core` | `model_effects_are_the_shared_machines` | `Effects::from` carries every field and every payout of the shared machine's result, in order | every result value | proved | 6.3 s |
| `swap-core` | `maker_record_saturates_and_never_fails` | `MakerRecord::record` cannot fail; exactly the named counter moves, saturating; sums saturate within the limit | every record and effects | proved | 3.4 s |
| `swap-core` | `amount_wrappers_translate_faithfully` | The amount wrappers pass amounts through and keep the two refusals apart | every `u128` | proved | 0.0 s |

53 harnesses, 53 proved, 0 failed; solver time 2388 s in total.

## What remains unproven

1. **Sequences at eight calls.** SPEC 11.4 bounds sequence properties to 8 calls. The open-value sequence (two swaps) and the ledger sequence run at that bound with **amounts below 2^12**; the deadline-order sequence stops at **3 calls** (5 did not finish in ten minutes). All three properties are proved for every amount and without any bound on the number of calls by the inductions (`*_conserve_the_escrow`; `open_establishes_…`/`*_keep_the_deadline_order`; `lock_and_take_obey_the_caps`/`counted_flag_is_an_invariant`), with the two hand steps below.
2. **Two steps done by hand, not by the solver.** (a) Conservation is proved as two lines per call (the stake of the state; each parked balance); adding them to `held(before) + in == held(after) + paid` is by hand at full width, and by the solver only in the ledger sequence. (b) The base case of the deadline order is proved for a swap opened at time 0; `open_sets_every_deadline_as_the_opening_time_plus_its_window` proves the opening time is one added term in each deadline, and adding one constant to both sides of each inequality of the invariant is by hand.
3. **Arithmetic at full width.** `share <= amount` is proved for every `u128` amount at every share the machine uses (and up to 8,191 bps); for shares between 8,192 and 10,000 bps, which nothing uses, only below 2^24. That `bps_of` is the *exact* floor is proved below 2^8 only, and `mul_div` exactness below 2^8, "direction A never pays zero" below 2^16 (that `swap_amount` never returns zero is proved at full width: it checks). The unit tests and `amounts.json` cover the full width by example.
4. **Ranges.** Amounts below 2^124 (all of `u64`, so all of Solana; Ethereum's `uint256` beyond that is outside the model, which carries `u128`). Times within 2^40 seconds of the epoch.
5. An SMT back end would probably discharge 1 to 3 at full width. Kani accepts `--solver z3`, `bitwuzla` or `cvc5`, but none is installed here and installing one would make the acceptance command depend on it, so none was added: a decision for the owner.

## Counterexamples Kani found

1. **`T_ff = t_Z + W_z` lets a freeze shorten the locker's window** (SPEC 11.6; `docs/research/a1-deviations.md`, D1). First seen by the model's property test (`deadline_order_on_every_accepted_path`: depth 255, `W_z` = 3,600, freeze 10,276 s after the notice: `T_ff` precedes the earliest `set_ready`). As a Kani property: `freeze::a_freeze_never_shortens_the_lockers_window`; with the text's formula restored (mutation M1) Kani reports `t_ff >= s.t_claim_open` violated in seconds. Fixed in the model: `T_ff = max(t_Z + W_z, T_co)`. Neither chain has `freeze` yet; both must implement the maximum.
2. **Invariant 1 in direction B NOTICED relied on `T_cut < T_co`** (D3). `windows::secret_calls_are_enabled_for_at_most_one_party` takes every record, not only those the bounds allow, and found refund (before `T_cut`) and claim (from `T_co`) both enabled on a record with `T_cut > T_co`. Unreachable: the bounds give `T_cut <= T_co − 2M`, which the induction in `exits` proves. Fixed anyway: the refund rows before `T_cut` also close at `T_co`. No vector changed. The Solana program and the Ethereum contract have the same unreachable overlap in their own gates; the program loses it when it moves to this crate (A2), and the contract may add the same `min` for defence in depth.
3. **The open value could wrap, and `amount + deposit` could exceed the amount type in direction B** (D2). Found while writing the `switches` harnesses, not by a counterexample run: SPEC 11.1 lets only the subtraction saturate and checks nothing with the caps off. The model now refuses such an open. Unreachable with real token supplies. The Solana program computes the direction-B claim payout with `saturating_add` today (it would underpay rather than fail in that unreachable case); the cap accounting does not exist on either chain yet and must use the exact add.

No harness in the table reports a counterexample against the model as committed.

## Mutation checks

Each line: the model was broken on purpose, the named harness was run and **failed**, and the change was reverted (`git diff` clean, harness green again).

| # | The break | Harness | Result | First failed assertion |
| --- | --- | --- | --- | --- |
| M1 | T_ff as SPEC 11.6 writes it (t_Z + W_z, no maximum with T_co) | `a_freeze_never_shortens_the_lockers_window` | **failed**, as it must | `t_ff >= s.t_claim_open` |
| M2 | direction-B refund before T_cut not closed at T_co (the D3 hardening removed) | `secret_calls_are_enabled_for_at_most_one_party` | **failed**, as it must | `!(refund && claim)` |
| M3 | the counted flag is not cleared at the exit (a second subtraction becomes possible) | `counted_flag_is_an_invariant` | **failed**, as it must | `counted_invariant(&n)` |
| M4 | a direction-B claim pays the taking wallet instead of the payout address | `nobody_is_paid_who_the_row_does_not_name` | **failed**, as it must | `taker == 0 && payout + treasury == s.amount + s.deposit` |
| M5 | a held refund in direction A returns the whole amount (the deposit leaves and stays) | `refunds_conserve_the_escrow` | **failed**, as it must | `stake(&s) + fx.escrow_in == stake(&n) + out` |
| M6 | the watcher may also set ready | `a_watcher_can_only_freeze` | **failed**, as it must | `gate(&s, &call, Role::Watcher, now, c) ==` |
| M7 | the open value is subtracted only while the caps are switched on | `no_switch_changes_any_call_but_lock_and_take` | **failed**, as it must | `execute_plan(&s, row, &plan, now, &e1, c) ==` |
| M8 | is_canonical_scalar accepts the group order itself | `canonical_scalar_is_exactly_below_l` | **failed**, as it must | `is_canonical_scalar(&s) == below` |
| M9 | the treasury half of a split goes to the maker | `the_deposit_never_reaches_the_maker` | **failed**, as it must | `fx.payouts.total_for(Party::Maker) == 0` |
| M10 | max_open lets one unit too many through | `lock_and_take_obey_the_caps` | **failed**, as it must | `fx.open_value_after <= env.caps.max_open` |
| M11 | a pause changes how a row is carried out (everything is parked while the maker is paused) | `caps_at_zero_and_every_pause_change_no_answer` | **failed**, as it must | `a.payouts == b.payouts` |
| M12 | the claim-after-final window stays open after T_exp | `secret_calls_are_enabled_for_at_most_one_party` | **failed**, as it must | `!(refund && claim)` |

## Not covered (SPEC 11.4)

Curve arithmetic and the on-chain point check (syscalls), the proof of knowledge and DLEQ verification, account handling, PDA derivation, token transfers and anything else in the Solana runtime, the Monero side, and all Solidity. The Solana program is covered only as far as it calls this crate (A2); the Ethereum contract is held to the same rules by the vectors.
