# Adversarial review of SPEC.md: fund safety and atomicity

2026-11-21. Reviewed: `docs/SPEC.md` (all of sections 2 to 5, 6.1 to 6.4, 7.4 to 7.6, 8.3, 8.4, Interpretations, Open risks), with `docs/research/protocol.md` section 7 (threat model) and `tests/monero-regtest/rust-sweep/src/lib.rs` as cross-checks. Nothing was executed; every finding is from reading. Items already listed under SPEC "Open risks" (closed tab, maker downtime in B, shallow depth, withhold griefing, late secrets, USDC freeze) are not repeated.

Severity: **critical** = fund loss or permanent lock for an honest party following the spec; **major** = griefing with real cost, or a spec gap that will produce a vulnerable implementation; **minor** = everything else.

Count: 1 critical, 9 major, 8 minor.

---

## Critical

### C1. Ethereum direction B: nobody verifies the maker's share, so the maker can take the XMR and refund

Sections 2.6 (table "Who verifies what"), 3.5, 3.11 item (3), 5.3 `fund`, 6.4.

The spec makes the taker verify the maker's DLEQ proof only "before sending `lock`", for "the chosen pool leaf". Direction B has no pool (`keyRoot` is zero); the maker's `key`, `key2`, `spendPub` and `view` first appear in `fund`, and the contract checks nothing about them (there is no on-chain proof of knowledge on Ethereum). No rule anywhere tells the taker to fetch and verify a proof for the funded share before paying XMR. Section 3.5 only says the page shows the joint address "once the swap is ACTIVE and the maker's escrow is final".

Attack (malicious maker, no special timing):

1. Taker calls `take`; `S_T` is public in the `Locked` event.
2. Maker calls `fund` with `spendPub = x·G − S_T` for an `x` it chose, and `key`/`key2` = the twins of an unrelated scalar `s'`.
3. Taker derives the joint address (spend key `x·G`), pays XMR, posts the notice, which hands the maker `v_T`.
4. Maker now holds the full spend key `x` and the full view key. It calls `refund(s')` before `T_cut` (B9c: escrow back, no hold) and sweeps the XMR once it is 10 deep.
5. The taker learns `s'`, which opens nothing. It has lost all of its XMR.

A weaker variant (honest `spendPub`, unrelated `key`) leaves the taker's XMR locked forever after any maker refund.

Fix (spec change):

- Section 2.6 table, add a row: "Maker's share supplied in `fund` (direction B) | Taker's browser | Showing the joint address or sending any XMR. The proof is fetched by `S_M` from the maker's blob endpoint; `dleqVerify` output MUST equal `makerSpendPub`, `makerKey`, `makerKey2` read from contract storage at the `finalized` tag. On failure the page never shows the address and tells the user to wait for the maker's refund."
- Section 6.4: "Maker, before `fund`: its own proof for the share is being served."
- Section 3.11 taker item (3): replace "before locking" with "before locking (A) and before showing the joint address (B)".
- Section 9.4: add a scenario "B/ETH: maker funds with a rogue `spendPub`; taker page refuses to show the address".

---

## Major

### M1. Solana direction B without a window: `T_co` and `T_cd` can pass `T_final`, so the maker's refund and the taker's claim are open at the same time

Sections 3.1 (bound on `W_f`), 3.2 (rule 1), 3.5 (B1, B9c/B9d, B10c), 2.9 (Solana quote has no `w_a`).

In AUTO mode and for signed quotes, `T_fund = t_take + W_n`, then `T_note = t_F + W_n`. So `T_co` can be as late as `t_take + 2·W_n + D_c`. The lock-time bound is `W_f >= W_a + W_n + D_c + W_c + 86,400`, which counts `W_n` once (and `W_a`, which this path never uses; a quote has none). `W_n` has a floor but no cap. With `W_n > W_a + 86,400` (for a quote: `W_n > 86,400`) a maker can fund late and get `T_co > T_final`. Then in NOTICED:

- B9d (maker refund) is open while `T_cut <= now < T_co`; the row has no `now < T_final` gate.
- B10c (taker claim) is open while `T_final <= now < T_exp`.

Both secret-bearing calls are enabled during `[T_final, T_co)`. The taker cannot use B10b (its interval is empty), so its client claims at `T_final`. A maker that sees or anticipates that transaction lands `refund(s_M)` first: the taker's claim fails but has published `s_T`, the maker has the escrow back and both keys. The section 3.2 guarantee "`T_cd < T_final − 86,400`" is already false whenever `W_n > W_a` on this path. Any maker can publish such an offer; nothing in section 8 tells the UI to refuse it. Precondition for theft: transaction-ordering visibility on Solana (a colluding RPC or leader); without it the result is a coin-flip race, which rule 1 exists to prevent.

Fix:

- Section 3.1: add `MAX_NOTICE_SECS = 3,600` (both chains) and the bound `W_n <= MAX_NOTICE_SECS`. Change the `W_f` bound to `W_p + W_n + D_c + W_c + 86,400 <= W_f`, where `W_p` is the pending window actually used by this swap (`W_a`, or `W_n` for direction B without a window, or 0 when the swap starts ACTIVE).
- Sections 3.4/3.5: add an explicit `now < T_final` gate to every pre-final row that lacks one (A9, A10a, A10b, B6, B7, B9a to B9d), and state "`post_notice` MUST fail if `now + D_c >= T_final − 86,400`; `set_ready` MUST fail if `now + W_c >= T_final − 86,400`".
- `deadlines.json`: add cases with `W_n` at its cap and funding at the last second.

### M2. Direction B: a notice that misses `T_note` can never be posted, so the taker's XMR depends on the maker choosing to refund

Sections 3.5 (B6, B9b, note "There is no keyless refund in direction B"), 3.2.

In ACTIVE after `T_note` the only enabled call is the maker's `refund(s_M)`. A taker who paid XMR and whose notice landed one second late (section 3.5 allows the address to be shown with 180 s left; on Ethereum the notice is an L1 transaction) has no call of its own in any state, forever. If the maker's daemon is gone (lost database: "a share whose row is missing is not usable", section 7.6 item 6; lost seed; abandoned maker) the escrow and the XMR are both locked permanently. A maker that prefers to burn `amount` can burn the same value of the taker's XMR at will. The safety claim "a taker who really locked XMR, even late, always recovers it" is conditional on maker liveness and good will.

Fix: in direction B, `T_note` stops closing the notice. B6 becomes "ACTIVE, `now < T_final − D_c − W_c − 86,400`"; a notice landing at or after `T_note` sets flag bit "late notice", and B9c is disabled for a late notice (the maker's refund after a late notice always holds `Dp`, counter `taker_no_notice`). B9b stays as is. The taker then always reaches NOTICED and B10b/B10c. Add the rows to `transitions.json`.

### M3. `approve`, `fund` and `reject` are not bound to the contents of the lock they act on

Sections 4.4 (`approve`, `fund`), 5.3 (`approve(bytes32 swapId)`, `fund`), 7.5 (direction A step 1, direction B step 1), 4.5 (pending outcomes close the Solana account).

- **Ethereum (reorg).** `W_a` defaults to 120 s and finality takes 13 to 19 minutes, so the daemon necessarily approves a non-final `lock` (section 7.5 says so). `swapId` is `keccak(taker, nonce)` and binds no terms. After a short reorg a taker can replace its `lock` with one carrying the same nonce and different `TakerKeys`: `spendPub = x·G − S_M` (the leaf is public) and `key`/`key2` for an unrelated `s'`. The maker's `approve(swapId)` applies to the replacement. The spec does not make the daemon re-verify the proof against finalized state before it locks XMR; if it does not, the taker sweeps the maker's XMR with `x` (it gets `v_M` from the notice) and then refunds with `s'`.
- **Solana.** `cancel_pending` closes the swap account, so the same taker can `lock`/`take` again at the same PDA with a different size or share while the maker's `approve`/`fund` is in flight. The maker funds or approves a swap its rules (per-taker limit, exposure, deny list, `paying_caps`) never evaluated.

Fix:

- `approve`, `fund` and `reject` take `expected: [u8; 32]` / `bytes32 expected` = `SHA256(DS("open") ‖ swap_ref ‖ t_lock ‖ xmr ‖ amount ‖ taker_spend_pub ‖ taker key and key2 (Ethereum) ‖ taker_view ‖ taker_enc_key)`, stored at lock; mismatch fails with `BadState`.
- Section 7.5: "Before `post_notice` (A) and before `set_ready` (B) the daemon MUST re-read the swap at `finalized` and require the stored commitments to equal the ones whose proof it verified; otherwise `abort` (A) or `refund` (B)."

### M4. Ethereum: `swapNonce` is not recoverable from contract state or events, so the recovery file cannot rebuild the taker's keys

Sections 2.2 (taker `share_id` = `swap_nonce`), 5.2 (`Swap` struct), 5.5 (`Locked` event), 8.4 ("Resume after a reload: … Ethereum `Locked` events, re-derive each swap's keys from the seed and its nonce").

The nonce is hashed into `swapId` and appears nowhere else: not in the `Swap` struct, not in `Locked`. A taker restoring from the recovery file on another device (or after IndexedDB is cleared) cannot derive `s_T`, the session key or the encryption key. In direction A it cannot refund; in direction B it cannot claim. The only source is the calldata of the original transaction, which the spec never mentions and which needs a node that still serves that transaction body. Solana stores `swap_nonce` in the account.

Fix: add `bytes16 swapNonce` to the `Swap` struct and to the `Locked` event; section 8.4 names storage (`getSwap`) as the source, with events only as an index.

### M5. The taker cannot rebuild the joint view key from chain state plus the recovery file after the maker rotates its encryption key twice (and on Ethereum after log pruning)

Sections 2.8, 3.10 rows 6 and 8 ("XMR stays collectable with `s_M`"), 4.2 (`Maker.enc_key`, `prev_enc_key` only), 4.3 `rotate_enc_key` ("No minimum interval"), 4.7 (`EncKeyRotated { version, prev_expires_at }` carries no key), 5.2 (no ciphertext or evidence in storage), 5.3 (`postNotice`: "ciphertext in the event").

In direction A the maker's view share `v_M` exists only inside the notice ciphertext. Spending the lock output needs `v_M + v_T` as well as both spend shares. Decrypting needs `X25519(taker enc secret, maker public key of the recorded version)`. The swap records only the version number; the maker account keeps the current and one previous key; the rotation event does not carry the key. After two rotations (the operator can do both in one block) the public key for the swap's version is nowhere on-chain. On Ethereum the ciphertext itself is only in a log, and `publishEvidence` only emits a log. A taker in rows 6 or 8 of section 3.10 who returns with only the recovery file, after the maker has claimed, holds `s_M` and `s_T` and still cannot sweep. `publish_evidence` is optional for the maker.

Fix:

- `lock`/`take` copy the maker's X25519 public key of the named version into the swap (`maker_enc_key: [u8; 32]`, Solana from the 42 reserved bytes; Ethereum `bytes32 makerEncKey` passed by the taker and included in `Locked`).
- Direction A `claim` takes `(txid, v_M)` and MUST open `notice_commitment` (one SHA-256); both are written to state. A view share is "not a safety secret" (section 0), so this costs nothing and makes the XMR collectable from chain state alone.
- Ethereum `Swap` gains `bytes32 evidenceTxid, evidenceView`; `publishEvidence` and `withhold` store them.
- Section 3.11 taker item (4): "the decrypted `(txid, v_M)` MUST open `notice_commitment`; a mismatch is treated as no lock".

### M6. Lock verification and sweep do not handle duplicate one-time keys or extra outputs to the joint address

Sections 2.11 (checks 1 to 5; `SweepParams`), `protocol.md` T1 ("no duplicate output key" is listed there and dropped from the spec).

`verifyLock` examines one txid ("exactly one output pays the joint address" is per transaction). `sweep_joint` takes only `lock_height`; the prototype scans that whole block and spends **every** output to the joint address it finds. The XMR locker knows the address and can, at the cost of dust:

- put a second transaction in the same block that reuses the lock's transaction key and output index, producing the same one-time key and therefore the same key image. The sweep then builds a transaction with two inputs sharing a key image, which every node rejects. The automated sweep fails every time; an implementation that "fixes" this by spending outputs one at a time can spend the dust first and burn the real output for good.
- put many dust outputs to the joint address in that block so the sweep exceeds input or size limits, or `max_fee`.

The victim is the party that already paid (taker in A after the maker's claim; maker in B after the taker's claim). The attacker loses nothing it had not already given up.

Fix:

- `SweepParams` gains `lock_txid: [u8; 32]` and `output_index`; the sweep MUST spend exactly that output and ignore all others. Other outputs to the joint address are reported, never auto-spent in the same transaction.
- `verifyLock` adds check 6: no other output in the lock's block, or in the blocks from the swap's start height to the tip, carries the same one-time key (the scanner compares output keys of transactions it must fetch anyway for the view-key scan of the lock block; `state = invalid`, reason `duplicate-output-key`).
- `monero_tx.json`: add a duplicate-key pair and a dust-flood block recorded from regtest.

### M7. Solana: `taker_enc_key` is not validated, giving a taker a free way to force maker aborts or a "provable fault" and to drain key-pool slots

Sections 2.8 ("reject an all-zero result"), 4.4 `lock` checks 1 to 6, 3.4 (A7a, A8), 3.7 (fault ids), `protocol.md` T13.

`lock` validates `taker_spend_pub`, the proof and `taker_view`, but accepts any 32 bytes as `taker_enc_key`. With a low-order X25519 point (all zeros, for instance) the Diffie-Hellman result is all zero, which section 2.8 tells the daemon to reject, so it cannot build the lock notice. In AUTO mode the swap is already ACTIVE and has consumed a pool slot and `capacity_xmr`. The daemon must `abort` (A7a, counter `aborts_pre_notice`) or lapse (A8, counter `missed_notices`, a "provable maker fault"). Both return the full `amount` with no deposit hold, so the attack costs transaction fees only. Sixteen such locks empty an offer's pool.

Fix:

- Section 4.4 check 2 (and `take`): reject `taker_enc_key` if it is one of the low-order Curve25519 u-coordinates (the fixed list of 7 canonical encodings and their non-canonical aliases, as a constant table), error `InvalidKeyCommitment`. Same check for `enc_key` in `register_maker`/`rotate_enc_key`. Add cases to `envelope.json`.
- Section 2.8: "If the result is still all zero the maker posts the notice under `K` derived from the zero secret rather than aborting", so no taker input can make the notice impossible.
- Ethereum: the daemon rejects such locks; see M8 for the counter.

### M8. Counters: one actor can fill a maker's pending slots, lower its approval rate at gas cost, and a maker can dilute its own ratios for free

Sections 3.1 (`MAX_OPEN_PENDING` = 64 per maker), 3.7 (derived rates), 3.8, 5.3, 7.1 (`approvals/`: "under flood it stops answering rather than sending rejections"), `protocol.md` T11 ("per-taker and per-offer caps", not carried into the spec).

- **Smear and denial of service.** The pending cap is per maker only. One wallet opens 64 pending locks (Ethereum: every swap; Solana: window mode) and re-opens them as they lapse. All funds come back. While it runs, no honest taker can lock (`TooManyPending`). On Ethereum the attacker simply never uploads a DLEQ proof, so the honest daemon cannot approve: each lock ends as `rejections` or `approval_timeouts`, both in the denominator of the approval rate the UI shows. The maker cannot prove on-chain that the taker was at fault.
- **Laundering.** Refunds are fee-free. A maker trading with itself can run lock, approve, `refund` (A10a), `release_deposit` at transaction-fee cost, inflating `approvals` and `deposits_returned` and so diluting the approval, response-time and withhold rates. Only `completed` and `volume` cost 5 bps.

Fix:

- Section 3.1: add `MAX_OPEN_PENDING_PER_TAKER = 2`, enforced at `lock`/`take` (Solana: a small per-(maker, taker) counter PDA; Ethereum: a mapping). A lapse or a rejection keeps a `PENDING_COOLDOWN_SECS` for that taker with that maker.
- Section 3.7: `reject` takes a reason byte; reason 1 ("no valid proof or unusable input", Ethereum) increments a new counter `rejections_unusable` in place of `rejections` and is excluded from the approval rate. Lapses while `open_pending == MAX_OPEN_PENDING` do not count as `approval_timeouts`.
- Section 3.7 derived rates: clients MUST show withhold and fault figures as absolute counts and relative to `completed` (the only fee-bearing denominator), not relative to counters that are free to inflate.

### M9. `transitions.json` cannot catch several divergences between the two contracts

Sections 2.12 (reference model, vector table), 3.8, 5.3.

"Both contracts MUST replay every row" over `(direction, mode, from_state, call, caller, time offset, …)`, but:

- Caller rules differ by chain: `claim`/`refund` are callable by anyone on Ethereum and only by the named signer on Solana. A row with a third-party caller has opposite expected results. `ChainConsts` is not specified to carry this, nor `EXPLICIT_APPROVE`, nor "every lapse counts as `approval_timeouts`".
- Rows are single transitions at one time offset. Nothing forces sequences whose derived deadlines interact (late fund then late notice, as in M1; ready at `T_co − 1`; refund at `T_final − 1` followed by claim at `T_final`).
- Pay-or-park outcomes (`owed_*` versus paid), `D == 0` shortcuts, the HOLD sub-machine at the `T_hold` and `T_split` boundary seconds, and counter saturation are not listed as columns or cases.
- The model is the only oracle and is written by the same work package as the vectors; an error in it is replicated to both chains.

Fix (section 2.12): `ChainConsts` MUST include `explicit_approve`, `open_secret_calls` (anyone may call `claim`/`refund`) and the lapse-counter rule, and vectors are emitted once per chain. `transitions.json` gains `sequences`: multi-step scripts with absolute times, each step listing expected state, every `t_*` field, payouts split into paid and parked, and all 32 counters. Required sequences are enumerated in section 9.4 (at least: every boundary second of every row; the M1 and M2 cases; a parked payout on each secret-bearing call; `D == 0`). The model is additionally property-tested for rule 1 (for random parameters within bounds and random call sequences, never two secret-bearing calls by different parties enabled at the same instant), and that test is an acceptance command.

---

## Minor

### m1. Checked counter arithmetic can make a secret-bearing call fail

Sections 1.3 (`overflow-checks = true`), 3.7, 4.8 (`MathOverflow`), 5.2. `u32` counters and `u64` sums that overflow revert `claim`/`refund` after the secret is public. Out of reach economically today, but it is an unconditional revert path on a call that "never reverts". Fix: "Counter and volume updates saturate; they MUST NOT be able to fail any instruction" on both chains, with a vector at `u32::MAX`.

### m2. Ethereum key reuse is tracked by leaf hash, not by share

Sections 2.7, 5.2 (`keyUsed[maker][leaf]`). The leaf hash includes the index, so the same share in a re-signed pool at another index is a different leaf and can be approved twice. Only daemon bookkeeping prevents reuse (threat T5). Fix: key the mapping by `keyAddr` (`keyUsed[maker][keyAddr]`) and have `fund` mark and check it too.

### m3. Anyone can block `close_swap` for a USDC swap with one micro-USDC

Section 4.5 ("closes the vault (must be empty)"). A transfer of dust into the swap vault after settlement makes the close fail with `VaultNotEmpty` forever; the taker's rent for two accounts is stuck. Fix: `close_swap` first transfers any vault balance not covered by `owed_*` to the treasury vault (pay-or-burn), then closes.

### m4. A settled Solana swap can be closed by anyone after 30 days, deleting the revealed scalar

Sections 4.5, 3.10 row 8. A taker who returns later than `t_settled + CLOSE_GRACE_SECS` must find `s_M` in transaction history, which section 4.5 itself says is pruned. Fix: third-party close after the grace period is allowed only when flag bit "secret revealed" is clear; otherwise only the non-revealing party may close, at any time.

### m5. Seed derived from a wallet signature over a fixed message

Section 8.4. Any site that gets the same message signed obtains the seed, hence every spend share and session key; with a colluding maker that is `set_ready` plus claim on any open swap. Fix: the message MUST include the program id, cluster genesis hash and a per-wallet random salt stored on-chain or in the recovery file, and start with a human-readable warning; the UI states that signing it elsewhere gives away the funds.

### m6. View shares and Ethereum commitments are not checked for canonical form off-chain

Sections 2.2, 4.4 (`fund`: "validates as `approve`", no rule for `maker_view`), 5.3 ("taker keys nonzero"). A `view` value at or above `ℓ`, or zero, is interpreted differently by different implementations, so the two sides derive different joint addresses and the swap fails after XMR is locked. Fix: Solana `fund` requires `maker_view` canonical and nonzero; Ethereum `lock`, `take` and `fund` require `0 < view < ℓ` (one comparison); clients reject the swap otherwise and also require `v_M + v_T != 0`.

### m7. A DLEQ blob is valid for whoever presents it

Section 2.6 ("Proofs carry no context binding"). A taker can lock with the maker's own leaf commitments and upload the maker's own blob; the daemon's check passes although the taker knows nothing. No theft path was found (the windows keep it from using `s_M`), but it defeats the proof-of-knowledge purpose and leaves the swap un-refundable. Fix: section 7.5, the daemon MUST reject a taker commitment equal to any share in its `key_shares` table; the taker MUST reject a maker share equal to its own.

### m8. Solana session-key sweep is not pay-or-park

Section 4.5 ("Session key lamports"). The last step of `refund`/`claim` transfers the session key's remaining lamports to the taker wallet. If that wallet is at zero lamports and the remainder is below the rent minimum (possible after priority fees), the transfer fails and so does the secret-bearing instruction. Fix: "If the taker account would not be rent-exempt after the sweep, the lamports go to the swap account and are added to `owed_taker`."
