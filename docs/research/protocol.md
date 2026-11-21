# Protocol research: prior art, state machines, resolutions, threat model

2026-11-21. Input: `docs/DESIGN.md` (its Decisions table wins). Nothing here is built or audited.
This document turns DESIGN into a precise protocol. Where DESIGN is silent or contradicts itself, section 6 proposes a resolution; anything that goes beyond the Decisions table is marked **[needs owner sign-off]**.

Contents: 1 Prior art · 2 Notation and parameters · 3 Direction A (taker buys XMR) · 4 Direction B (taker sells XMR) · 5 Deposit, fee, counters · 6 Ambiguities and resolutions · 7 Threat model · 8 Client and daemon obligations · 9 Open questions

---

## 1. Prior art (what was actually read)

### 1.1 Sources

| Source | How obtained | Status |
| --- | --- | --- |
| eigenwallet/core at commit `420c27211f98cd2547a2aebde4306955195d4818` (`swap-core/src/bitcoin/{withhold,mercy,reclaim,partial_refund,timelocks}.rs`, `swap-env/src/env.rs`, `swap-machine/src/{alice,bob}/mod.rs`, `swap/src/protocol/{alice,bob}/swap.rs`, `swap-p2p/src/protocols/{quote,swap_setup}.rs`, `swap/src/asb/recovery/grant_mercy.rs`, `docs/content/**`) | Saved copies in `.scratch/protocol/eig/` from the earlier attempt; read in full or by section | Read |
| docs.eigenwallet.org `/advanced/anti_spam_deposit`, `/faq/anti_spam_deposit` | Fetched live 2026-11-21; text matches the repo's `.mdx` | Read |
| `https://eigenwallet.org/eigenswap.html` (the link DESIGN cites) | Fetched live 2026-11-21 | **HTTP 404.** eigenwallet.org's home page links only to docs.eigenwallet.org. DESIGN's source list needs updating. |
| AthanorLabs/atomic-swap `ethereum/contracts/SwapCreator.sol`, `Secp256k1.sol`, `docs/protocol.md` (master) | Saved copies in `.scratch/protocol/src/`; `SwapCreator.sol` and `protocol.md` re-fetched live and matched | Read |

Not verified: Athanor's default timeout durations (not in the files read); the Ethereum finality figure; mainnet availability of the Solana curve25519 syscalls (covered by `.scratch/solana-curve`).

### 1.2 eigenwallet (BTC to XMR)

Roles: Bob = taker, holds BTC. Alice = maker, holds XMR.

**Timelocks** (`swap-env/src/env.rs`, Mainnet):

| Parameter | Value | Meaning |
| --- | --- | --- |
| `bitcoin_cancel_timelock` | 30 blocks (about 5 h) | Relative to the lock tx. After it either party may publish TxCancel. |
| `bitcoin_punish_timelock` | 144 blocks (about 24 h) | Relative to TxCancel. Taker's refund window; after it the maker may publish TxPunish. |
| `bitcoin_remaining_refund_timelock` | 2 blocks | Relative to TxPartialRefund. Taker's TxReclaim of the deposit becomes valid after it. The docs say "30min (3 blocks)"; code says 2. |
| `monero_finality_confirmations` | 10 | |
| `monero_lock_retry_timeout` | 30 min | If the maker cannot lock XMR in this time it starts an early refund. |
| `bitcoin_lock_mempool_timeout` | 10 min | |

**Paths.** Happy: lock, XMR lock, encrypted signature, redeem (reveals the maker's key through the adaptor signature). Refund: cancel after 5 h, then the taker's refund reveals `s_b` so the maker recovers XMR. Punish: if the taker has not refunded 24 h after cancel, the maker takes the BTC; the docs state "the protocol can no longer guarantee that the taker will get access to the Monero". "Cooperative redeem" after punish is voluntary.

**Early refund.** `TxEarlyRefund`, maker-initiated: a full refund when the maker cannot lock XMR (`AliceState::BtcEarlyRefundable`). No deposit applies. This is the precedent for DESIGN's "free refund when the maker is provably late".

**Anti-spam deposit, as implemented.**

| Transaction | Published by | Timelock | Effect |
| --- | --- | --- | --- |
| TxPartialRefund | Taker | After cancel | Output 0: refund minus deposit to the taker. Output 1 ("amnesty"): the deposit, into a 2-of-2. Publishing reveals the taker's Monero key half, like a full refund. |
| TxReclaim | Taker | `remaining_refund_timelock` after TxPartialRefund | Deposit to the taker's refund address. Pre-signed by the maker. |
| TxWithhold | Maker | None | Moves the deposit to a second 2-of-2 ("burn output"). Valid any time before TxReclaim confirms. |
| TxMercy | Maker | None | Burn output to the taker's refund address. Pre-signed by the taker at setup; the maker adds its signature only when it decides to (`grant_mercy`, a manual command). |

Facts that matter for us:
- The maker can never receive the deposit; every spend path of both 2-of-2 outputs pays the taker's refund address.
- The withhold decision is per swap and manual or policy driven (`should_publish_tx_withhold`; a hidden `always_withhold_deposit` flag).
- The ratio is quoted to the taker before the swap (`BidQuote.refund_policy.anti_spam_deposit_ratio`). Default 0; the daemon rejects configs above `MAX_ANTI_SPAM_DEPOSIT_RATIO = 0.2`. DESIGN's 5% cap is stricter.
- A withheld deposit that is never released stays locked forever. **There is no 60-day split in eigenwallet; that is new in DESIGN.**
- The taker reaches the maker out of band (Discord, Matrix) with the swap ID. DESIGN replaces that with the built-in inbox.
- Setup carries a cross-curve DLEQ proof of about 112 KB (`swap_setup.rs`, `BUF_SIZE` comment). This size matters for our Ethereum legs (R4).
- Quotes may carry a Monero reserve proof. We could reuse this for maker capacity claims (optional, not specified here).

### 1.3 AthanorLabs atomic-swap (ETH to XMR)

Roles: Alice locks ETH or an ERC-20; Bob locks XMR. One contract holds all swaps; only `keccak256(abi.encode(Swap))` and a `Stage` are stored.

| Function | Caller | Condition | Secret | Effect |
| --- | --- | --- | --- | --- |
| `newSwap(claimCommitment, refundCommitment, claimer, timeoutDuration1, timeoutDuration2, asset, value, nonce)` | Alice | value > 0, commitments nonzero | None | Escrow; `timeout1 = now + d1`, `timeout2 = timeout1 + d2`; Stage PENDING |
| `setReady(swap)` | Owner only | Stage PENDING | None | Stage READY |
| `claim(swap, secret)` | Claimer only | READY, or `now >= timeout1`; and `now < timeout2` | `s_b`, checked against `claimCommitment` | Value to the claimer |
| `claimRelayer(...)` | Anyone with the claimer's signature | Same as claim | `s_b` | Value minus fee to the claimer, fee to the relayer |
| `refund(swap, secret)` | Owner only | `now >= timeout2`, or (`now <= timeout1` and not READY) | `s_a`, checked against `refundCommitment` | Value to the owner |

Observations:
- **Claim without ready** already exists: Bob may claim after `timeout1` even if Alice never called ready. DESIGN's "maker claim without ready" is this, with a 60-minute floor.
- **After `timeout2` Bob can never claim.** If Alice never returns, Bob's XMR is stuck. DESIGN's final deadline reverses this in the maker's favour.
- **Boundary overlap.** At `block.timestamp == timeout1` with Stage PENDING both `claim` (`now < timeout1` is false) and `refund` (`now > timeout1` is false) are valid. A block with exactly that timestamp lets both secrets race. Our spec uses half-open intervals so no instant has both enabled.
- **Secret exposure on a failed transfer.** The contract's own comment warns that a failing token transfer "expos[es] Bob's secret while giving him nothing". Relevant to USDC freezes (T8).
- **Key check.** `Secp256k1.mulVerify` uses `ecrecover` as a scalar-multiplication oracle and compares only 160 bits; there is no range check on the scalar. The contract trusts an off-chain DLEQ proof that the secp256k1 key and the ed25519 key share a secret. `.scratch/eth-keycheck` already hardens this (range check `s < 2^252`, zero-address guard).
- The protocol doc tells both parties not to call `Refund()` or `Claim()` near `t_0` or `t_1` because a late transaction exposes a secret without effect. We turn that into explicit broadcast margins (section 2.4).
- No deposits, fees, approvals or reputation.

### 1.4 What we take from each

| Topic | Taken from | Change |
| --- | --- | --- |
| Escrow shape: two commitments, ready flag, claim/refund by revealing a scalar | Athanor | One program per chain; deadlines derived from events, not fixed at lock |
| Claim without ready | Athanor `timeout1` | Per-offer delay, 60 min floor, starts at the lock notice |
| Final deadline favours the XMR locker | New | Athanor favours the asset locker after `timeout2` |
| Deposit: partial refund, 30-minute hold, withhold, release | eigenwallet | Contract state instead of pre-signed transactions; 5% cap; 60-day split |
| Free refund when the maker cannot lock | eigenwallet early refund | Triggered by a missed on-chain deadline instead of maker goodwill |
| Punish | eigenwallet | Softened: any maker claim reveals its key half |

---

## 2. Notation and parameters

### 2.1 Roles and keys

- **Taker** T, **maker** M. **Direction A**: taker pays SOL, USDC or ETH and receives XMR. **Direction B**: taker pays XMR and receives SOL, USDC or ETH.
- **Locker** L escrows the chain asset and can refund. **Claimer** C locks XMR and can claim. A: L = taker, C = maker. B: L = maker, C = taker. The escrow machine is identical in L/C terms; only approval, deposit ownership and counters differ by direction.
- Spend-key shares `s_T`, `s_M` (ed25519 scalars, canonical, below 2^252). Commitments `S_T = s_T·G`, `S_M = s_M·G`.
- Joint Monero address: spend key `S_T + S_M`, view key `(v_T + v_M)·G`. Whoever learns both `s` shares and both `v` shares owns the XMR.
- View shares are not secrets of the swap's safety. L's view share is posted in clear at lock; C's view share travels in the lock notice (R6).
- On Ethereum each spend share also has a secp256k1 twin, stored as an address-form commitment, plus an off-chain cross-curve DLEQ proof (R4).
- `amount`: chain asset escrowed, in base units. `xmr`: piconero the claimer must lock.

### 2.2 On-chain checks of a revealed scalar

| Chain | Commit-time check | Reveal-time check |
| --- | --- | --- |
| Solana | `S` is a canonical, non-identity, prime-order ed25519 point (`is_valid_key_commitment` in `.scratch/solana-curve`) | `s` canonical and `s·G == S` (one `multiply_edwards` syscall) |
| Ethereum | Twin commitment nonzero; DLEQ proof hash recorded | `0 < s < 2^252` and `ecrecover`-trick address equals the twin commitment |

A reveal is always in the same transaction as the transfer it unlocks, and always emitted in an event.

### 2.3 Per-swap parameters (copied from the offer or quote at lock, immutable after)

| Symbol | Meaning | Default | Contract bound |
| --- | --- | --- | --- |
| `W_a` | Approval window | 60 s | Hard cap 3600 s **[sign-off]**; UI warns above 60 s |
| `W_n` | Notice window (C must post the lock notice) | 600 s Solana; 600 s + `F` Ethereum | Floor 300 s |
| `d` | Monero confirmations for this size tier | 2 / 10 / 25 | At least 1 |
| `B` | Per-block allowance used for "confirmation time" | 180 s | Constant (R8) |
| `Δ_cut` | `d·B + 900 s` | 21 / 45 / 90 min | Derived |
| `D_c` | Claim delay: C may claim without ready this long after the notice | 90 min | `>= max(3600 s, Δ_cut + 2·M)` |
| `W_c` | Claim window after ready | 30 min Solana; 90 min Ethereum | `>= F + 2·M` |
| `W_f` | Final window, from lock | 7 days | `>= W_a + W_n + D_c + W_c + 86400 s` |
| `W_x` | Expiry after the final deadline (dead-man recovery, R11) | 30 days | Constant **[sign-off]** |
| `dep_bps` | Anti-spam deposit | Maker's choice | `<= 500` |
| `fee_bps` | Protocol fee | 5 | Constant in global config |
| `M` | Broadcast margin (client rule) | 300 s Solana; 1800 s Ethereum | Used in the bounds above |
| `F` | Finality allowance | 15 s Solana; 960 s Ethereum (to be verified) | Chain constant |

### 2.4 Derived deadlines and the two rules that remove races

Direction A; B is the same with fund in place of lock.

```
t_lock ── W_a ──► T_appr                     (window mode only)
t_A (approval) ── W_n ──► T_note             lock notice must land before T_note
t_N (notice)  ── Δ_cut ──► T_cut             client auto-refund cutoff
t_N           ── D_c ───► T_co               claim-without-ready opens; L's refund closes
t_R (ready)   ── W_c ───► T_cd               C's claim window closes; L's fault refund opens
t_lock        ── W_f ───► T_final            C may claim in any post-notice state
T_final       ── W_x ───► T_exp              C's claim closes for good; L may refund
```

Order guaranteed by the bounds: `t_N < T_cut <= T_co − 2M`, `t_R < T_co`, `T_cd <= T_co + W_c < T_final − 86400 s`, `T_final < T_exp`.

**Rule 1, exclusive windows (contract).** All intervals are half-open `[from, to)` on the chain clock. In every state and at every instant, at most one party can submit a transaction that reveals a secret:

| State | Interval | Secret-bearing call enabled |
| --- | --- | --- |
| APPROVED (no notice) | any | L refund only (C has no claim without a notice, ever) |
| NOTICED | `[t_N, T_co)` | L refund |
| NOTICED | `[T_co, T_final)` | C claim |
| READY | `[t_R, T_cd)` | C claim |
| READY | `[T_cd, T_final)` | L refund |
| ABORTED (C waived) | `[.., T_final)` | L refund |
| any post-notice, non-terminal | `[T_final, T_exp)` | C claim |
| any post-notice, non-terminal | `[T_exp, ∞)` | L refund |

**Rule 2, broadcast margins and finality (clients).** A transaction that fails still publishes its arguments (failed Solana transactions are recorded; Ethereum calldata is public in the mempool). A secret that lands late hands the counterparty both keys once their window opens. Therefore:
- Never broadcast a secret-bearing transaction later than `M` before the boundary that opens the counterparty's window (`T_co`, `T_cd`, `T_final`, `T_exp`).
- Never broadcast one until the state it relies on is final (`F`): the maker claims only after `ready` is final; the XMR locker sends XMR only after the escrow is final.
- On Ethereum, send secret-bearing transactions through a private relay and with a fee that guarantees prompt inclusion.

`T_cut` is exactly the taker's Rule-2 deadline in the common case: the tab refunds at `T_cut` if the lock is not at depth, leaving at least `2M` before `T_co`.

**Why claim-after-delay and taker refund cannot race.** Refund in NOTICED is valid only while `now < T_co`; claim without ready only while `now >= T_co`. A refund included before `T_co` moves the swap to a terminal state, so a later claim fails without ever having been valid, and the honest maker's daemon does not broadcast a claim before it sees `now >= T_co` on a finalized block. A refund included at or after `T_co` fails; Rule 2 stops an honest taker from sending one that late.

---

## 3. Direction A: taker buys XMR with SOL, USDC or ETH

L = taker, C = maker. `D = floor(amount · dep_bps / 10000)` is part of `amount`, not extra.

### 3.1 States

| State | Meaning |
| --- | --- |
| PENDING | Funds escrowed, awaiting approval (window mode only). Reserves no capacity and no key share. |
| APPROVED | Maker is bound. `S_M` fixed in the swap. Notice clock running. |
| NOTICED | Lock notice on-chain. Taker verifying XMR. |
| READY | Taker confirmed the XMR lock. |
| ABORTED | Maker waived its claim until `T_final`. Sub-kind EARLY (before `T_co`) or LATE (at or after `T_co`). |
| HOLD | Refunded; deposit `D` still in escrow until `T_hold`. |
| WITHHELD | Maker withheld `D`. |
| CLOSED | Terminal. Account closed, rent to the taker. Outcome is in the event log and the counters. |

### 3.2 Transitions

"Session" means the per-swap session key (R3). "Anyone" means no signer beyond the fee payer. Counters are on the maker account (section 5.3).

| # | Call | Who | From, and time gate | Secret revealed and checked | Funds | Counter | To |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | `lock` (against an offer or a signed quote; optional advance approval) | Taker wallet | Offer live and fresh; price and terms checks (R7); `S_T` valid; `v_T` recorded | None | `amount` + session fee budget + rent from the taker into escrow | `locks` | PENDING (window mode) or APPROVED (auto, valid advance approval, or taker-bound quote) |
| A2 | `approve` | Maker operator | PENDING, `now < T_appr`; capacity available | None | None | `approvals`, `response_secs_sum` | APPROVED; sets `t_A`, `S_M`, decrements capacity |
| A3 | `reject` | Maker operator | PENDING | None | `amount` to the taker | `rejections` | CLOSED |
| A4 | `cancel_pending` | Taker wallet or session | PENDING, any time | None | `amount` to the taker | `pending_cancels` | CLOSED |
| A5 | `expire_pending` | Anyone | PENDING, `now >= T_appr` | None | `amount` to the taker | `approval_timeouts` | CLOSED |
| A6 | `post_notice(commitment, ciphertext)` | Maker operator | APPROVED, `now < T_note` | None (R6) | None | `notices` | NOTICED; sets `t_N`, `T_cut`, `T_co` |
| A7 | `maker_abort` | Maker operator | (a) APPROVED, `now < T_note` | None | (a) `amount` to the taker at once | (a) `aborts_pre_notice` | (a) CLOSED |
| | | | (b) NOTICED, `now < T_co` | | (b) none | (b) `aborts_early` | (b) ABORTED-EARLY |
| | | | (c) NOTICED, `T_co <= now < T_final` | | (c) none | (c) `aborts_late` | (c) ABORTED-LATE |
| | | | (d) READY, `now < T_final` | | (d) none | (d) `missed_claims` | (d) ABORTED-EARLY |
| A8 | `refund_unnoticed` | Anyone | APPROVED, `now >= T_note` | None | `amount` to the taker | `missed_notices` (fault) | CLOSED |
| A9 | `set_ready` | Taker wallet or session | NOTICED, `now < T_co` | None | None | `readies` | READY; sets `t_R`, `T_cd` |
| A10 | `refund(s_T)` | Taker wallet or session | (a) APPROVED, `now < T_note` | `s_T` against `S_T` | (a) `amount − D` to the taker; `D` held | (a) `taker_cancels_approved` | (a) HOLD |
| | | | (b) NOTICED, `now < T_co` | | (b) `amount − D`; `D` held | (b) `taker_refunds_noticed` | (b) HOLD |
| | | | (c) ABORTED-LATE, `now < T_final` | | (c) `amount − D`; `D` held | (c) `refunds_after_abort` | (c) HOLD |
| | | | (d) ABORTED-EARLY, `now < T_final` | | (d) `amount` | (d) `refunds_after_abort` | (d) CLOSED |
| | | | (e) READY, `T_cd <= now < T_final` | | (e) `amount` | (e) `missed_claims` (fault) | (e) CLOSED |
| | | | (f) NOTICED, READY or ABORTED, `now >= T_exp` | | (f) `amount` | (f) `expired_refunds` | (f) CLOSED |
| A11 | `claim(s_M)` | Maker operator | (a) READY, `now < T_cd` | `s_M` against `S_M` | `amount − fee` to the maker's payout address; `fee` to the treasury vault | (a) `completed`, `volume` | CLOSED |
| | | | (b) NOTICED, `T_co <= now < T_final` | | same | (b) `claims_without_ready`, `volume` | CLOSED |
| | | | (c) NOTICED, READY or ABORTED, `T_final <= now < T_exp` | | same | (c) `claims_after_final`, `volume` | CLOSED |
| A12 | Deposit calls | See 5.1 | HOLD, WITHHELD | None | `D` | See 5.1 | CLOSED |

Notes:
- If a `refund(s_T)` sent while APPROVED lands after the notice, it is still valid as A10b. The taker's client never sees a failed, secret-leaking refund from that race.
- A7a and A8 are the only keyless refunds after approval. They exist only where no lock notice was ever accepted, so the contract treats the XMR as never locked (R1).
- After ABORTED the maker's claim returns at `T_final` (A11c). An abort is a waiver until the final deadline, not forever; otherwise an absent taker would strand the maker's XMR.
- `claim` pays a payout address stored in the maker account, not the operator key (R3).

### 3.3 DESIGN's "Refunds and deposits" table, row by row

| # | DESIGN row | Transitions | Taker receives | Deposit | Maker |
| --- | --- | --- | --- | --- | --- |
| 1 | Pending: rejected, expired, cancelled | A3, A5, A4 | `amount` | Never held | No fault; `rejections`, `approval_timeouts`, `pending_cancels` |
| 2 | Approved, no notice by the deadline | A8 (or A7a) | `amount`, keyless, anyone can send | Never held | Fault: `missed_notices` (or `aborts_pre_notice`) |
| 3 | Taker cancels after approval, before the notice deadline | A10a | `amount − D` now | Held 30 min; withholdable | No fault |
| 4 | Taker refunds after a lock notice | A10b | `amount − D` now | Held 30 min; withholdable | Recovers XMR with `s_T` |
| 5 | Taker never sets ready; maker aborts after its claim delay | A7c then A10c | `amount − D` when the taker returns before `T_final` | Held 30 min; withholdable | Recovers XMR when the taker refunds; if the taker never returns, A11c |
| 6 | Taker never sets ready or refunds; maker claims after its claim delay | A11b | The XMR, if it was locked (`s_M` is public) | Not applicable | `amount − fee` |
| 7 | Ready set, maker misses its claim deadline | A10e | `amount` | Never held | Fault: `missed_claims`. Recovers XMR with `s_T` |
| 8 | Taker never returns by the final deadline | A11c | Nothing from escrow; XMR stays collectable with `s_M` | Not applicable | `amount − fee` |

Rows not in DESIGN but required for completeness: maker aborts before its claim delay (A7b, A7d: full refund, no hold, R10); expiry (A10f, R11).

---

## 4. Direction B: taker sells XMR

L = maker, C = taker. The maker escrows `amount`; the taker locks `xmr`. The taker posts a **take deposit** `Dp = floor(amount · dep_bps / 10000)` in the market's asset at take time (R12). The maker has no deposit (Decisions: no maker bond).

### 4.1 States

TAKEN (deposit posted, awaiting the maker's funds), FUNDED, NOTICED, READY, ABORTED (taker waived its claim), HOLD, WITHHELD, CLOSED.

### 4.2 Transitions

| # | Call | Who | From, and time gate | Secret | Funds | Counter | To |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | `take` (offer or signed quote; optional advance approval) | Taker wallet | Offer live; price and terms checks; `S_T` valid | None | `Dp` + session budget + rent into escrow | `takes` | TAKEN; `T_fund = t_take + W_a` (window mode) or `+ W_n` (auto, advance) |
| B2 | `cancel_take` | Taker wallet or session | TAKEN | None | `Dp` to the taker | `pending_cancels` | CLOSED |
| B3 | `reject_take` | Maker operator | TAKEN, window mode only | None | `Dp` to the taker | `rejections` | CLOSED |
| B4 | `lapse` | Anyone | TAKEN, `now >= T_fund` | None | `Dp` to the taker | Auto or advance: `missed_funds` (fault). Window: `approval_timeouts` | CLOSED |
| B5 | `fund` | Maker operator | TAKEN, `now < T_fund`; `S_M` valid; `v_M` recorded | None | `amount` from the maker into escrow | `approvals`, `response_secs_sum` | FUNDED; `T_note = t_F + W_n` |
| B6 | `post_notice(commitment, ciphertext)` | Taker wallet or session | FUNDED, `now < T_note` | None | None | `notices` | NOTICED; sets `t_N`, `T_cut`, `T_co` |
| B7 | `set_ready` | Maker operator | NOTICED, `now < T_co` | None | None | `readies` | READY; `T_cd = t_R + W_c` |
| B8 | `taker_abort` | Taker wallet or session | NOTICED or READY, `now < T_final` | None | None | `taker_aborts` | ABORTED |
| B9 | `maker_refund(s_M)` | Maker operator | (a) FUNDED, `now < T_note` | `s_M` against `S_M` | `amount` to the maker; `Dp` to the taker at once | (a) `backouts_pre_notice` | CLOSED |
| | | | (b) FUNDED, `now >= T_note` | | `amount` to the maker; `Dp` held | (b) `taker_no_notice` | HOLD |
| | | | (c) NOTICED, `now < T_cut` | | `amount` to the maker; `Dp` to the taker at once | (c) `backouts_post_notice` | CLOSED |
| | | | (d) NOTICED, `T_cut <= now < T_co` | | `amount` to the maker; `Dp` held | (d) `refunds_unconfirmed` | HOLD |
| | | | (e) READY, `T_cd <= now < T_final` | | `amount` to the maker; `Dp` held | (e) `taker_missed_claims` | HOLD |
| | | | (f) ABORTED, `now < T_final` | | `amount` to the maker; `Dp` held | (f) `refunds_after_abort` | HOLD |
| | | | (g) NOTICED, READY or ABORTED, `now >= T_exp` | | `amount` to the maker; `Dp` to the taker | (g) `expired_refunds` | CLOSED |
| B10 | `claim(s_T)` | Taker wallet or session | (a) READY, `now < T_cd` | `s_T` against `S_T` | `amount − fee + Dp` to the taker; `fee` to the treasury vault | (a) `completed`, `volume` | CLOSED |
| | | | (b) NOTICED, `T_co <= now < T_final` | | same | (b) `taker_claims_without_ready` (maker never set ready) | CLOSED |
| | | | (c) NOTICED, READY or ABORTED, `T_final <= now < T_exp` | | same | (c) `claims_after_final` | CLOSED |
| B11 | Deposit calls | See 5.1 | HOLD, WITHHELD | None | `Dp` | See 5.1 | CLOSED |

### 4.3 How faults and deposits mirror

| Situation | Direction A | Direction B |
| --- | --- | --- |
| Pending, not approved | Full refund, no fault | Deposit back, no fault |
| XMR locker posts no notice in time | Maker fault; keyless full refund | Taker at fault; maker refunds; take deposit held and withholdable (B9b) |
| Asset locker backs out before the XMR locker is late | Taker pays with a withholdable deposit (A10a, A10b) | Maker's backout is counted publicly; take deposit returned at once (B9a, B9c). No maker bond exists to hold. |
| Lock not confirmed by the cutoff | Taker auto-refunds at `T_cut`; deposit withholdable | Maker refunds in `[T_cut, T_co − M]`; take deposit withholdable (B9d) |
| Ready set, claimer misses the claim window | Maker fault; full refund (A10e) | Taker at fault; maker refunds; take deposit withholdable (B9e) |
| Asset locker absent past the claim delay | Maker may claim or abort (A11b, A7c) | Taker may claim (B10b). **The maker's daemon must refund a bad lock before `T_co − M` or lose the funds to a false notice.** |
| Final deadline | Maker may claim | Taker may claim |

Every `maker_refund` reveals `s_M`, so a taker who really locked XMR always recovers it. There is no keyless refund in direction B: the maker's daemon is always on and holds `s_M`.

The maker's free option in B (fund, watch the price during confirmations, refund before `T_cut`) costs it nothing on-chain. It is visible as `backouts_post_notice`, and the taker loses only time and two Monero fees. This follows from "no maker bond".

---

## 5. Deposit, fee, counters

### 5.1 Deposit sub-machine (both directions; `D` is the taker's deposit)

Entered by any refund marked "held" above. `T_hold = t_refund + 1800 s`. `T_split = t_refund + 60 days`.

| Call | Who | Gate | Funds | Counter | To |
| --- | --- | --- | --- | --- | --- |
| `release_deposit` | Anyone | HOLD, `now >= T_hold` | `D` to the taker | `deposits_returned` | CLOSED |
| `release_deposit` | Maker operator | HOLD (early) or WITHHELD, any time | `D` to the taker | `deposits_returned` or `releases` | CLOSED |
| `withhold(evidence?)` | Maker operator | HOLD, `now < T_hold`; if a lock notice exists and the maker is the XMR locker, `evidence` must open the notice commitment (R6) | None | `withholds`, `withheld_volume` | WITHHELD |
| `split_deposit` | Anyone | WITHHELD, `now >= T_split` | `ceil(D/2)` to the taker, `floor(D/2)` to the treasury vault | `splits` | CLOSED |

Invariants:
- No instruction can pay `D` to the maker, its payout address or its operator key. The only destinations are the taker's stored address and the treasury vault.
- Fault refunds (A7a, A8, A10d, A10e, A10f; B9a, B9c, B9g) never enter HOLD, so "a maker that was provably late cannot withhold" holds by construction.
- `withhold` is not available at or after `T_hold`, even if nobody has cranked `release_deposit` yet. The taker never has to race the maker. (eigenwallet lets the maker withhold until the taker's reclaim confirms.)
- The 60 days run from the refund, so `T_split` is known the moment the deposit is held.

### 5.2 Protocol fee

- `fee = floor(amount · 5 / 10000)`, charged on every `claim` (normal, without ready, after final). Never on refunds, held deposits or pending cancels.
- Taken out of the claimer's payout. A: the maker receives `amount − fee`. B: the taker receives `amount − fee`. The party receiving SOL, USDC or ETH pays (R9).
- Paid into a program-owned treasury vault per asset, swept by the treasury authority. A failing transfer to an external treasury account can then never block a claim (T8).
- The treasury's half of a 60-day split goes to the same vault and is not a "fee".

### 5.3 Outcome counters (per maker, per chain; each transition increments exactly one outcome counter)

| Group | Counters |
| --- | --- |
| Approval | `locks`/`takes`, `approvals`, `rejections`, `approval_timeouts`, `pending_cancels`, `response_secs_sum` |
| Progress | `notices`, `readies` |
| Completion | `completed`, `claims_without_ready`, `claims_after_final`, `volume` per asset |
| Maker faults (provable on-chain) | `missed_notices`, `missed_claims`, `missed_funds` |
| Maker choices | `aborts_pre_notice`, `aborts_early`, `aborts_late`, `backouts_pre_notice`, `backouts_post_notice`, `taker_claims_without_ready` |
| Taker-side unwinds | `taker_cancels_approved`, `taker_refunds_noticed`, `refunds_after_abort`, `taker_no_notice`, `refunds_unconfirmed`, `taker_missed_claims`, `taker_aborts`, `expired_refunds` |
| Deposits | `deposits_returned`, `withholds`, `withheld_volume`, `releases`, `splits` |

Clients derive: approval rate and mean response time; fault rate; withhold rate = `withholds / (withholds + deposits_returned)`; unreleased rate = `(withholds − releases) / withholds`. Every transition also emits an event carrying the swap ID so indexers can attribute per swap.

---

## 6. Ambiguities and contradictions in DESIGN, with proposed resolutions

### R1. What "reveals the taker's key half" requires on-chain

DESIGN: "Every other refund after approval reveals the taker's key half."

Resolution: the refund instruction takes the 32-byte scalar `s_T`; the program checks it against the commitment stored at lock (section 2.2), emits it in an event, and only then transfers. The check and the transfer are in one transaction, so a reveal without a refund cannot be recorded as a success.

Which refunds reveal:

| Refund | Reveal? | Reason |
| --- | --- | --- |
| Pending (A3, A4, A5) | No | Maker is not bound, no XMR can be locked |
| No notice by the deadline, or maker abort before a notice (A8, A7a) | No | No notice was accepted, and the maker can never claim. Keyless makes this "safe to close the tab". The daemon must post the notice before broadcasting XMR (section 8), so an honest maker never has XMR locked here. |
| All others, including the fault refund after a missed claim (A10e) | Yes | The XMR is, or may be, locked. Without the reveal a single missed deadline would burn the maker's whole XMR lock. Athanor does the same after `timeout2`. |

This narrows DESIGN's sentence "a refund is free only when the maker is provably late": **free means no deposit hold, not no reveal.**

### R2. How "anyone can send that refund" works

`expire_pending` (A5), `refund_unnoticed` (A8), `lapse` (B4), `release_deposit` after `T_hold` and `split_deposit` take no authority signature. They need no secret, and every destination is read from the swap account (`taker`, and for tokens the token account recorded at lock, re-created if it was closed). The caller pays only the transaction fee; rent returns to the taker. The UI, the maker daemon or any bot can crank them. A refund that needs `s_T` cannot be permissionless.

### R3. How the session key is authorised and limited

- Created in the page; its public key is an argument of `lock`/`take`, which the taker's wallet signs. That signature is the authorisation. It is stored in the swap account and valid for that swap only.
- It may call, for that swap: A: `cancel_pending`, `set_ready`, `refund`. B: `cancel_take`, `post_notice`, `taker_abort`, `claim`. DESIGN says "only set ready or refund"; direction B needs the other three.
- It can never choose a destination: all payouts go to the taker address stored at lock.
- The taker's wallet key can call everything the session key can (recovery on another device).
- It pays its own fees. `lock` transfers a fixed budget to it (suggest 0.003 SOL; on Ethereum an amount shown in the UI, sized for one `setReady` and one `refund` at a capped gas price). The client sweeps the remainder back at close.
- It does not replace `s_T`: a refund needs both the session key and the key share, which live in the same browser storage.
- Worst case if stolen: a premature `set_ready` (T7). The contract cannot prevent that; it can require `now >= t_N + d · 60 s` before `set_ready` so that a ready faster than Monero could possibly confirm is rejected **[sign-off]**.
- Maker side, same idea: `claim` pays the payout address in the maker account, set by the cold owner key. A stolen operator key cannot redirect proceeds.

### R4. Key-share pool versus per-swap commitments; Ethereum twins

DESIGN says the offer holds "a pool of one-time key shares", the taker "picks an unused key share", pending locks use no keys until approved, and the swap account holds "both Monero key commitments". These fit together as follows:

| Path | Where `S_M` comes from | When it is consumed |
| --- | --- | --- |
| Solana offer, auto-accept or advance approval | Pool slot in the offer account (suggest 16 slots with a used bitmap). The program takes the first free slot; a taker-supplied index is only a hint, so a front-runner taking the same slot cannot make the lock fail. | At `lock`: slot marked used, `S_M` copied into the swap |
| Solana offer, window mode | Supplied by the maker in `approve` | At approval. A pending lock holds nothing. |
| Signed quote (all Ethereum locks; oversized Solana swaps) | Carried in the quote; one leaf of a Merkle set of shares for public quotes | At `lock`; `used[share]` set |
| Direction B | Maker supplies `S_M` in `fund`; taker supplies `S_T` in `take` | No pool |

- The maker refills used slots in its normal offer refresh.
- Uniqueness: reuse of a share hurts only the party that reused it (T5), so the contract enforces it only within the pool and the quote set. The daemon and the browser derive shares from a seed plus a counter that is persisted before use, and the derivation path includes the chain.
- Order of commitment is not a safety issue. A rogue key (`S = X − S_other`) leaves its author unable to pass the reveal check, so it cannot claim or refund; the counterparty's exits still work.
- **Ethereum.** The contract checks a secp256k1 twin. The party about to rely on the other side's reveal must verify the DLEQ proof first: the taker before locking (maker's share), and the maker before sending XMR (taker's share). Proofs are too large for calldata (about 112 KB in eigenwallet). The lock records only the proof hash. Consequences:
  - The maker's proofs must be fetchable before the lock (maker endpoint, relay, or chunks through the Solana program), keyed by the hash in the signed quote. The taker client refuses to lock without a verified proof.
  - If the taker's proof is missing or invalid the maker must not send XMR. With contract-level auto-accept this would count as a maker fault the maker did not cause. **Resolution [sign-off]: on Ethereum, "auto-accept" is the daemon approving automatically after it has verified the proof; the contract always requires `approve`.** The UI may still label it auto-accept and show the maker's measured response time.
  - Alternative worth costing: verify the ed25519 relation directly in the EVM for the taker's refund path only (rare, taker-paid). That removes the taker's DLEQ proof and restores true auto-accept. Left to the Ethereum key-check research.

### R5. Advance-approval format

A message signed off-chain by the maker's operator key and presented in `lock`/`take`:

```
domain        "xmrswap/advance-approval/v1"
cluster_tag   32 bytes from global config (Solana) | chainId (Ethereum)
program       program ID | contract address
maker         maker account | maker address
taker         taker address (the only address that may use it)
market        asset mint or 0 for native; direction A or B; or ANY
max_amount    largest single swap, in the market's asset
not_before, expires_at
epoch         must equal maker.approval_epoch
approval_id   random 64-bit
```

- Solana: an Ed25519 precompile instruction in the same transaction, checked through the instructions sysvar (signer equals `maker.operator`, message bytes equal the canonical encoding).
- Ethereum: EIP-712 typed data, `ecrecover` equals `maker.operator`.
- Revocation: bumping `approval_epoch` cancels every outstanding approval; rotating the operator key does the same. Per-approval revocation is a small revocation record keyed by `approval_id`.
- DESIGN asks for "a size limit and an expiry". A cumulative limit would need per-approval state; instead the offer's on-chain capacity (R7) bounds total exposure.
- An approval never overrides offer terms, price, size limits or capacity.

### R6. Lock notice: content, privacy, evidence

DESIGN says the notice carries "the transaction ID and its half of the view key" and that the view key "lets anyone check the maker's claim". In clear, that would publish every maker Monero transaction and link it to a Solana swap, and "anyone" would still lack the other view half.

Resolution:
- L posts its view share in clear at lock (`v_T` in A, `v_M` in B). It is useless without the other half.
- `post_notice` carries `commitment = H(txid ‖ v_C ‖ salt)` and a ciphertext of `(txid, v_C, salt)` encrypted to L's per-swap encryption key. **The ciphertext must be on-chain**, not only on Tor: otherwise a notice could be posted that the taker cannot read.
- For Ethereum swaps the notice is an Ethereum transaction, because the Ethereum contract enforces `T_note` and cannot read Solana. DESIGN's "lock notices for ETH swaps go through the Solana program" can only be a faster duplicate.
- Evidence: opening the commitment in clear (`txid, v_C, salt`). With L's public view share, anyone can then check the Monero chain for an output of `xmr` to the joint address, `unlock_time` 0, and its inclusion height. The contract cannot check this; clients and indexers do, and label the swap "lock verified" or "lock not found".
- `withhold` after a notice must include the opening when the withholding maker is the XMR locker (direction A). In direction B the taker can publish its own opening (`publish_evidence`) to contest a withhold. This is what DESIGN's "Evidence publisher" does, made mandatory where the maker benefits from it.

### R7. Offer pinning, slippage, stale offers

Each Solana offer has `seq` (incremented on every change), `updated_at`, `valid_secs`, `price`, size limits, `capacity` and `terms_hash = H(dep_bps, approval mode, W_a, W_n, depth tiers, D_c, W_c, W_f, fee_bps)`.

`lock` arguments and checks:

| Argument | Check | Protects |
| --- | --- | --- |
| `xmr` (exact amount wanted) | Within the offer's limits and `capacity` (auto and advance: decremented at lock; window: at approval) | Maker inventory |
| `max_pay` | `pay = ceil(xmr · price / 10^12) <= max_pay`, using the price in the account at execution | Taker, against a price change between read and lock |
| `expected_terms_hash` | Must equal the offer's `terms_hash` | Taker, against a change of deposit, delays or mode |
| `min_seq` (optional) | `offer.seq >= min_seq` | Taker, against an RPC serving an old offer |
| none | `now <= updated_at + valid_secs`, offer enabled, maker not paused | Maker, against fills on a stale price |

"The price is fixed here" then means: the price in the account when the lock executes, bounded by the taker's `max_pay`. All terms are copied into the swap, so later offer changes never affect it. Direction B mirrors with `min_receive`.

For Ethereum the signed quote plays the offer's role: it fixes price, terms, size limits, key-share set, `expires_at` (suggest 60 to 120 s) and a `quote_id`. The contract checks the EIP-712 signature against the maker's registered quote signer, the expiry and `quote_epoch`, and that the share is unused. Posting the quote on Solana is for discovery only; the Ethereum contract never reads Solana.

### R8. "Automatic refund cutoff = confirmation time + 15 min"

- Definition: `T_cut = t_N + d · B + 900 s`, counted from the on-chain notice time on the chain clock. `d` is the depth of the swap's size tier.
- `B` must not be Monero's 120-second target. Blocks are a Poisson process, so with `B = 120 s` an honest lock misses the cutoff in about 2% of swaps at depth 10 and 7.5% at depth 25. With `B = 180 s` the miss rate is about 0.03%, 0.11% and 0.05% at depths 2, 10 and 25. Cutoffs become 21, 45 and 90 minutes after the notice.
- It is a client deadline, stored in the swap so every client agrees. The contract enforces only what follows from it: `D_c >= Δ_cut + 2M`, checked at lock. At depth 25 that makes the minimum claim delay 100 minutes on Solana, above the 60-minute floor; the console must show this.
- In direction B the contract does use `T_cut`: it is the earliest time a maker refund can put the take deposit on hold (B9d).
- At `T_cut`: if the lock is at depth, set ready; otherwise refund. After `T_co − M` the client must not refund at all (Rule 2).

### R9. Which side pays the fee

Unstated in DESIGN. Resolution: the fee is deducted from the escrowed asset at claim, so the recipient of SOL, USDC or ETH pays (maker in A, taker in B). Reasons: no second asset or transfer is needed; refunds are fee-free by construction; the taker's price in A is all-in. The UI shows the net figure in B. Makers fold it into their deviation.

### R10. Maker abort

DESIGN lists only "maker chooses to abort after its claim delay" (row 5). Left as is, a maker whose XMR lock failed has no honest exit before then. Resolution: `maker_abort` is allowed earlier, but an early abort (A7a, A7b, A7d) can never lead to a withheld deposit, and is counted separately. Only the late abort (A7c), where the taker demonstrably did not show up, leaves the deposit withholdable. "Abort-fee settings" under Risk controls has no meaning without a maker bond and should be removed or renamed to the withhold policy.

### R11. Final deadline and stranded funds

- `T_final = t_lock + W_f` (7 days by default), fixed at lock.
- After it the claimer may claim in any post-notice state, including after its own abort and after a missed claim window. Before a notice there is nothing to claim, so the final deadline does not apply.
- DESIGN leaves funds stranded forever if the claimer also never returns. Resolution **[sign-off]**: `T_exp = T_final + 30 days`; after it only the locker can refund, with no hold.
- "Safe to close" in the READY state is true only if the taker returns before `T_final − M` should the maker miss its claim window. The UI text should say so.

### R12. The sell-XMR direction: "a small fee", deposits and faults

DESIGN gives one sentence. Open points and resolutions:

| Point | Resolution |
| --- | --- |
| "A small fee" at take | A refundable **take deposit** under the same rules as the anti-spam deposit (at most 5% of the escrowed amount, held 30 minutes, withholdable, never to the maker, 60-day split). It is the only thing that makes a spam take cost anything, since the taker escrows nothing else. Paid in the market's asset. **[sign-off: asset and whether it is a deposit or a true fee]** |
| Maker's lock deadline | `T_fund`; a lapse in auto or advance mode is the fault `missed_funds` |
| Approval modes | Window mode: the maker may `reject_take` or let it lapse without fault. Funding is the approval. |
| Taker late with the notice or the claim | Maker refunds; take deposit withholdable (B9b, B9e) |
| Maker backs out early | Counted; take deposit returned at once (B9a, B9c) |
| Maker never sets ready | Taker claims after `D_c` (B10b); counted against the maker |
| Fee | Deducted from the taker's payout |
| "Paying XMR; tab closes: delayed, not lost" | True for the XMR if the key share is kept. The take deposit can still be withheld. The UI should say so. |

### R13. Deadline ordering

See section 2.4. Summary of what the contract enforces at lock: `D_c >= max(3600, d·B + 900 + 2M)`; `W_c >= F + 2M`; `W_f >= W_a + W_n + D_c + W_c + 86400`. With those, every secret-bearing call has an exclusive, half-open window.

### R14. Oversized quote on request

1. The taker sends an encrypted request through the inbox (on-chain or Tor): direction, asset, amount, taker address, reply key.
2. The maker screens it and replies with a **signed quote bound to the taker's address**: fixed `amount` and `xmr`, all terms, one fresh key share, `expires_at` (at most 120 s), `quote_id`.
3. The taker calls `lock` (or `take`) with the quote. The program verifies the operator signature (Ed25519 precompile on Solana, EIP-712 on Ethereum), the taker binding, the expiry and that `quote_id` is unused (sliding 256-bit window in the maker account on Solana, a mapping on Ethereum).
4. A taker-bound quote counts as approved in advance: the swap starts in APPROVED. Offer size limits do not apply; the contract floors and caps on terms still do.

The same quote format serves public Ethereum quotes (taker field empty, mode stated in the quote), so there is one code path.

### R15. Smaller contradictions

| DESIGN text | Problem | Resolution |
| --- | --- | --- |
| "Lock notice: 10 minutes" and Ethereum finality of 13 to 15 minutes | A maker that waits for finality cannot meet 10 minutes | `W_n = 600 s` after the escrow is final; on Ethereum the stored window is `600 + F` **[sign-off]** |
| "Timeouts: tens of minutes" on Solana | Claim delay floor is 60 minutes; depth 25 needs a 90-minute cutoff | Reword: notice and approval are minutes; everything after the XMR lock is 1 to 2 hours |
| "Makers publish offers on Solana", including quotes for Ethereum markets | An Ethereum-only maker has nowhere to publish | Launch requires a Solana registration for every maker; state it |
| "Pending locks reserve nothing" and the on-chain daily cap | Auto-accept needs on-chain capacity or simultaneous locks exceed inventory and create maker faults | `capacity` field, decremented at approval, reset on refresh (R7) |
| "Batch lock. One Solana transaction opens every leg" | A transaction is limited to 1232 bytes | Expect about 2 to 4 legs per transaction with an address lookup table; waves otherwise |
| "Close swap accounts on completion" | Deposits can be held 60 days | The account lives until the deposit is settled; history lives in events and counters |
| Deposit "held for 30 minutes" | eigenwallet's code uses 2 blocks, its docs say 3 blocks | We use 1800 s of chain time |
| Row 3: cancel after approval may cost the deposit | A taker who cancels seconds after an auto-accept can lose up to 5% | Keep (it is the anti-spam mechanism); the UI must warn before the lock, not after |
| "Refund watchers only when the taker runs them" | Direction B needs the same statement for makers | A maker-side watcher holds `s_M`; same rule |
| Sources list | eigenswap.html is 404 | Cite docs.eigenwallet.org and the repo commit |

---

## 7. Threat model

Severity is the worst outcome for an honest party that follows section 8.

| # | Attack | Outcome if unmitigated | Mitigation: contract | Mitigation: client or daemon | Residual |
| --- | --- | --- | --- | --- | --- |
| T1 | **Maker posts a false lock notice** (no XMR, wrong amount, wrong address, nonzero `unlock_time`, unconfirmed, duplicate one-time key) | A: maker claims after `D_c` and the taker loses `amount` | Claim without ready only at `T_co`; taker refund open until then; notice ciphertext mandatory on-chain | Taker verifies against at least two nodes: output to the joint address, exact amount, `unlock_time` 0, depth `d`, no duplicate output key. Auto-refund at `T_cut`. Full-screen tab warnings. | **High.** A taker whose tab is closed from `T_cut` to `T_co` loses everything. Inherent in DESIGN. |
| T1b | False notice plus withhold | Taker refunds correctly but loses up to 5% (2.5% after the split). Maker gains nothing. | Withhold after a notice must open the notice; deposit can never reach the maker; counters | Indexers verify the opening on Monero and flag "lock not found"; UI ranks on withhold and unreleased rates | **High as griefing.** The contract cannot see Monero. Cost to the attacker is reputation only. |
| T1c | Direction B: taker posts a false notice | Maker's daemon is offline past `T_co`: the taker claims `amount` | Same windows, mirrored | Daemon verifies and refunds in `[T_cut, T_co − M]`; alerting; a maker-run watcher | **High for makers with downtime.** Roughly 45 minutes of outage during a funded swap can lose it. |
| T2 | **Free option and griefing by the taker** (lock, watch the price while XMR confirms, refund) | Maker's XMR tied up; one-sided option | Deposit hold and withhold; capacity; `refund` always reveals `s_T` | Withhold policy "when the price moved against the maker"; per-taker limits; approval window as last look | Bounded by `dep_bps`. A taker that accepts losing the deposit still has the option. |
| T2b | Free option by the maker | A: decline to claim after ready. B: refund before `T_cut`. Taker loses time and Monero fees. | Fault and backout counters; no withhold on these paths | UI ranks on these rates | Accepted by "no maker bond". In A the taker can also simply wait: the maker's XMR stays locked until it claims at the original price or the taker refunds. |
| T3 | **Monero reorg or double spend** of the lock after the counterparty acted on it | Whoever relied on the lock loses the XMR after paying | None possible | Depth tiers by size and by total in flight; several nodes; daemon in B chooses its own depth. Note the lock output is unspendable for 10 blocks regardless of `d`. | **High for depth 2 and 10.** Multi-block Monero reorgs have happened in practice; depth 2 is only for amounts the party can afford to lose. |
| T3b | Ethereum reorg after a secret was broadcast | A reorged `ready` replaced by a `refund` gives the taker funds plus `s_M` | `W_c >= F + 2M` | Rule 2: act on finalized state only | Low if followed |
| T4 | **Front-running the lock**: maker or third party changes the offer, or takes the same key slot, just before the taker's lock | Worse price or terms; failed lock | `max_pay`, `expected_terms_hash`, first-free-slot assignment, quote bound to the taker where possible | Client reads at `confirmed`, sets a tight `max_pay` | Public Ethereum quote shares can be consumed by others; the taker loses gas only |
| T4b | Front-running a secret (Athanor's race) | Counterparty obtains both keys and the funds | Rule 1, half-open intervals | Rule 2; private relay on Ethereum | Low if followed. A stuck Ethereum transaction near a boundary is the remaining exposure. |
| T5 | **Key-share reuse** | Maker reuses `s_M`: once one claim reveals it, any later taker's refund lets anyone holding `s_M` take that XMR. Taker reuses `s_T`: after one refund reveals it, a later maker knows both shares and can sweep the XMR back after ready, then claim. | Pool slots and quote shares single-use; commitments validated | Shares derived from seed plus a counter persisted before use; path includes chain and direction; the recovery file stores the counter | Lost or rolled-back counter state (restored backup, cloned VM) reintroduces reuse. **High impact, low likelihood.** |
| T6 | **Replay** across chains, clusters or swaps of approvals, quotes or secrets | An approval or quote reused elsewhere; a secret valid in two swaps | Domain tag, cluster tag or chain ID, program ID, maker, taker, market, expiry and nonce in every signed object; `quote_id` window; swap ID from maker, taker and nonce | Separate key shares per chain | Low |
| T7 | **Session-key theft** (XSS, extension, shared machine) | With a colluding maker: premature `set_ready`, then a claim with no XMR locked. Alone: a forced refund costing the deposit. | Session key scoped to one swap; payouts only to the taker; optional minimum time before `set_ready` (R3) | Non-extractable WebCrypto key where the curve allows; strict CSP, no third-party scripts, self-hosting; `s_T` kept separately encrypted | **High impact.** A compromised page also holds `s_T`, so this cannot be fully solved in a browser. |
| T7b | Operator-key theft (maker) | Bad offers and withholds. In B: the attacker takes an offer, posts a false notice, and uses the operator key to fund and `set_ready`, then claims the maker's escrowed funds | Payout address under the cold owner key; pause by owner key; capacity limits | Daemon isolation; exposure limits | **High in B**: loss up to the paying balance the operator key can commit. Keep that balance capped. |
| T8 | **USDC freeze or blacklist** of the escrow, a party or the treasury | A claim or refund that reverts still publishes its secret in the failed transaction | Per-swap vault on Solana; before any token transfer, check the destination and vault state, and if a transfer cannot succeed record an `owed` balance instead of reverting (Ethereum: `try/catch`), withdrawable later to another address signed by the entitled party; fees accrue in a program vault | Simulate before sending a secret; never skip preflight | A freeze of the escrow itself strands funds. Atomicity is lost. Disclosed in the UI for USDC legs. |
| T9 | **Stale-offer sniping**: taker fills at a price the market has left | Maker sells XMR cheap | `valid_secs`, `updated_at` check, `capacity`, pause flag | Short validity; move-triggered refresh; volatility and disagreement pauses; size tiers; window mode for large sizes; wXMR pool as cross-check only | A maker's loss is bounded by its refresh interval times its capacity |
| T10 | **Withhold abuse**: maker withholds every deposit, or the protocol owner runs a maker and collects the treasury half after 60 days | Takers lose up to 5% on any refund | Deposit cap 500 bps; no withhold on fault refunds; strict `T_hold`; evidence opening | Withhold and unreleased rates shown before the lock; inbox for release requests | **Conflict of interest:** the treasury gains from unreleased withholds. Consider sending the treasury half to a burn address or disclosing treasury-linked makers. **[sign-off]** |
| T11 | **Pending-lock spam** (window mode) and slot or capacity exhaustion (auto mode) | Daemon load; offer appears full | Pending locks reserve nothing; taker pays rent; minimum size; per-taker and per-offer caps on open pending locks; capacity restored on a pre-notice refund | Daemon ignores rather than rejects when flooded; anyone cranks the expiry | Auto mode: each spam swap puts a deposit at risk |
| T12 | Maker never delivers the DLEQ proof, or delivers a bad one (Ethereum) | Taker locks against a twin that hides a different secret and never gets the XMR | Proof hash in the signed quote | Client verifies the proof before locking and refuses otherwise | Low if the client check is mandatory |
| T13 | Taker griefs the maker's record with inputs the maker cannot use | A maker fault the maker did not cause | Validate every taker input on-chain at lock (Solana); require `approve` on Ethereum (R4) | Indexers can re-verify on-chain inputs | Low after R4 |
| T14 | Dishonest Monero node or RPC | Fake lock shown as confirmed; stale offer shown | `min_seq` | Several independent nodes; own node recommended for large swaps | Medium for hosted defaults |
| T15 | Upgrade key | Rules or escrow changed by the key holder | Upgrade authority later revoked | UI shows upgrade status | Trust in the owner until frozen |
| T16 | Chain clock skew or halt | Deadlines pass during an outage | All deadlines on chain time, never wall-clock | Client compares chain time to local time and warns; margins `M` | A long halt can consume the refund window |

**Highest risks, in order:** T1 (tab closed between `T_cut` and `T_co`), T1c (maker downtime in direction B), T3 (shallow depth), T7 (browser compromise), T1b and T10 (withhold griefing and the treasury's incentive), T8 (USDC).

---

## 8. Client and daemon obligations (the contract cannot enforce these)

Taker client:
1. Fresh `s_T` per swap, derived from the recovery seed and a counter persisted before the lock. Back up before locking.
2. Verify offer terms against `terms_hash`; show deposit, claim delay, approval window and the maker's rates before the lock.
3. On Ethereum, verify the maker's DLEQ proof before locking.
4. Verify the lock notice fully (T1). At depth before `T_cut`: `set_ready`. At `T_cut` otherwise: `refund`.
5. Never broadcast a refund after `T_co − M`, `T_final − M`, or (as claimer in B) a claim after `T_cd − M`.
6. Direction B: post the notice on-chain and see it final before broadcasting the XMR transaction. Claim only after `ready` is final.
7. Read time from the chain, not the local clock.

Maker daemon:
1. Fresh `s_M` per swap; persist the counter before publishing a share; never share a derivation path between chains.
2. Direction A: construct the XMR transaction, post the notice, see it final, then broadcast. If the swap is no longer APPROVED/NOTICED, do not broadcast.
3. Send XMR only after the taker's escrow is final (Ethereum: `F`).
4. Claim only after `ready` is final and never later than `T_cd − M`. Simulate first.
5. Direction B: verify the taker's lock; `set_ready` at depth; otherwise `maker_refund` in `[T_cut, T_co − M]`. Treat this as the daemon's hardest deadline.
6. Decide withholds inside the 30-minute hold and attach the notice opening. Release on request.
7. If its own lock fails or is reorged, `maker_abort` at once.

---

## 9. Open questions for the owner

1. Approve the items marked **[sign-off]**: the `W_a` hard cap; `W_x = 30 days` expiry; explicit `approve` on Ethereum (R4); `600 s + F` notice window on Ethereum (R15); take deposit asset and nature in direction B (R12); minimum time before `set_ready` (R3); destination of the treasury half (T10).
2. `B = 180 s` in "confirmation time" (R8), which makes the cutoffs 21, 45 and 90 minutes.
3. Whether depth 2 should exist at all given T3, and above what size 25 becomes mandatory.
4. Whether to cost on-chain ed25519 verification on Ethereum for the refund path, to drop the taker's DLEQ proof.
5. Still unverified: Ethereum finality figure; mainnet status of the Solana curve syscalls; Monero address or key-derivation changes from any pending hard fork that would affect the joint address.
