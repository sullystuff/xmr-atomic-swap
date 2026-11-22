# End-to-end coverage (WP11)

What `pnpm --filter @xmrswap/e2e test` proves at system level, scenario by scenario, against the list in `docs/SPEC.md` 9.4 and the WP11 brief. Nothing here is faked: a scenario that cannot be run with the real processes is listed as **package only** (proven in a package's own tests, not here) or **not covered**, with the reason, instead of being approximated.

"System level" means all of these at once, on loopback: the real daemon (`packages/daemon/src/cli.ts start`, live mode, its own process, registered through its own API with an owner key held outside it), the real relay process behind a fake SOCKS5 "Tor", the built taker UI and the built console in Chromium, the built Solana program inside `tools/svm-rpc`, the contract on anvil behind its proxy, and real XMR on the Monero regtest (two nodes, one wallet-rpc per wallet).

Taker column: **UI** = the built web UI in Chromium with injected test wallets; **SDK** = the taker's steps through `@xmrswap/sdk` (messages still travel relay → fake Tor → daemon endpoint).

## Summary

Of the 31 scenario ids of SPEC 9.4: **18 covered** at system level (H-A, H-B, M-1, R-2, R-3, R-4, R-4w, R-5, R-6, R-7, R-8, F-1, F-2, P-1, N-2, D-1, L-1, U-1), **9 partly covered** with the remainder proven only in package tests (M-2, R-9, B-x, X-1, N-1, V-1, K-1, E-1, T-1), **2 package only** (M-4, B-y), **2 not covered** anywhere at system level (M-3, X-2). The reasons are in the table. One bug in another package was found and is kept as a known failure (`BUGS.md`, BUG-1).

Files: `01-happy` (eight happy-path swaps in the browser, UI refund and recovery on Ethereum), `02-refunds` (the refund table and direction-B unwinds), `03-modes-console` (approval modes, pending rows, the console in a browser), `04-faults-taker` (false notices, node disagreement, reload and recovery, the UI's fault refund, relay down), `05-faults-maker` (node down, reorg, duplicate key, false notice in B, crashes, frozen and blacklisted payouts, key rotation, Ethereum rejections), `06-large` (three daemons), `99-known-failures`.

## Scenarios of SPEC 9.4

| Id | Status | Where | Taker | Notes |
| --- | --- | --- | --- | --- |
| H-A | covered | `01-happy` | UI, all four markets | XMR arrives in the destination wallet; payout = amount − fee; treasury = fee; taker paid amount; counters; inventory down by xmr + fee. SDK takers run direction A on all four markets in `02`, `05`. |
| H-B | covered | `01-happy` | UI, all four markets | Taker receives amount − fee (deposit returned with it); daemon sweeps the joint address; operator paid amount. |
| M-1 | covered (Solana) | `03-modes-console` | UI + SDK | Window offer: approve and reject in the console (browser), expiry cranked by a stranger (and refused one second early), taker cancel, automatic approval under `auto_max_xmr`. Ethereum pending rows: rejection reasons 1 and 2 in `05`; Ethereum expiry and cancel are **package only** (`ethereum` replay, `sdk` integration). |
| M-2 | partly covered | `03-modes-console` | UI + SDK | Valid advance approval requested by the page over the relay, stored, presented (advance-only offer, and a window offer turned immediate); lock without approval refused (`ApprovalRequired`). Expired / wrong taker / over limit / stale epoch: **package only** (`solana/tests`, `sdk` integration). Ethereum advance approvals: **package only** (the UI requests them on Solana only, web W16). |
| M-3 | **not covered** | | | Oversized taker-bound quotes. The UI has no flow that asks for one, and the daemon answers quote requests only over its endpoint (daemon M7); proven in `solana/tests`, `ethereum` and `sdk` integration. TODO: an SDK-taker scenario that requests a bound quote from the live daemon on all four markets. |
| M-4 | **package only** | `solana/tests`, `ethereum`, `sdk` integration | | Approval bound to the lock (cancel and re-lock at the same id). Needs a taker racing the daemon's approval inside one polling interval; not deterministic against a real process. TODO: add a daemon test hook, or a paused-daemon variant. |
| R-2 | covered | `02-refunds` | SDK | Solana (daemon down from before the lock) and Ethereum (daemon killed right after its approval). Keyless refund refused one second early; `missed_notices`; no XMR broadcast. |
| R-3 | covered | `02-refunds` | SDK | Solana USDC, exact amounts; hold; release refused one second early. |
| R-4 | covered | `02-refunds`, `01-happy` | SDK (usdc_sol, usdc_eth), UI (eth) | Maker recovers its XMR with the revealed share; inventory back less two network fees; deposit held then returned. |
| R-4w | covered | `02-refunds`, `03-modes-console` | SDK, UI | Daemon withholds by policy with the evidence on-chain; 60-day split by clock warp (ceil/floor, never the maker; refused one second early); console withhold, then release on the taker's inbox request. "Withhold without a matching opening fails": **package only** (the daemon never sends one). |
| R-5 | covered | `02-refunds` | SDK | Solana USDC, offer set to abort. |
| R-6 | covered | `02-refunds` | SDK | Solana SOL; taker sweeps later with `s_M` from the account. |
| R-7 | covered | `02-refunds`, `04-faults-taker` | SDK, UI | Refund refused one second before `T_cd`; `missed_claims`; restarted daemon recovers its XMR. In the UI: "Safe to close" while ready, then the tab's own fault refund. |
| R-8 | covered | `02-refunds` | SDK | 7-day warp; `claims_after_final`; XMR swept afterwards from the seed. |
| R-9 | partly covered | `02-refunds` | SDK | A7b then A10d (console abort); A10f at `T_exp` after a 37-day warp (refused before). A7a and A7d: **package only**. |
| F-1 | covered (Solana) | `04-faults-taker` | UI | Wrong amount, wrong address, never broadcast, each by a dishonest SDK maker registered beside the real one: no ready, auto-refund at `T_cut` (nothing one second before), the maker's claim at `T_co` fails. Ethereum: **not covered** (the dishonest maker is Solana only). |
| F-2 | covered | `05-faults-maker` | SDK | Daemon refunds inside `[T_cut, T_co − M]`; `refunds_unconfirmed`. |
| B-x | partly covered | `02-refunds`, `05-faults-maker` | SDK | B4 (`missed_funds`), B9a (console backout), B9b (`taker_no_notice`), B9d (false notice; duplicate key). B9c, B9e, B9f/B8, B9h and the late-notice claim, B10b, B11: **package only** (`transitions.json` replays on both chains, `sdk` integration). |
| B-y | **package only** | `crates/swap-core`, chain replays | | Extreme deadlines; a property of the bounds, not of the processes. |
| X-1 | partly covered | several | | One-second-before refusals for `T_note`, `T_pend`, `T_hold`, `T_split`, `T_cd`, `T_exp` (contract) and `T_cut` (the tab). The full boundary matrix is the `transitions.json` replay: **package only**. |
| X-2 | **not covered** | | | A full simulated Ethereum finality delay (1,152 s) before the XMR leaves. anvil here finalises in two blocks; simulating 13–19 minutes of finality needs a finality-tag proxy in front of anvil. The daemon's waits on `finalized` are exercised (every Ethereum swap), at short delay only. |
| P-1 | covered | `05-faults-maker` | SDK | Frozen payout token account (Solana) and blacklisted payout address (Ethereum): claim succeeds, key revealed, payout parked, later withdrawn. ETH-rejecting recipient: **package only** (`ethereum`). |
| N-1 | partly covered | `04-faults-taker`, `05-faults-maker` | UI, SDK | Page: a node that hides the transaction (never ready; refund at cutoff), a node down then back. Daemon: a node down (no ready), a real one-block reorg with the pool flushed (same stored transaction relayed again). "Lock replaced by a fork": **not covered** (needs a conflicting spend mined on a private fork). |
| N-2 | covered | `05-faults-maker` | SDK | A REAL second output with the lock's one-time key in the lock's block (`tools/dupkey`, m1-followups item 13): `verifyLock` and the live daemon both call it invalid. Dust outputs: lock verifies, the daemon's sweep spends exactly the verified output. The page as the verifier of a duplicate: **not covered** (same code path as the SDK check; needs the dishonest maker to drive the tool). |
| V-1 | partly covered | `04-faults-taker`, `01-happy` | UI | New profile from the recovery file alone, direction A, Solana and Ethereum. Not combined with two key rotations; direction B before the claim on Ethereum: **not covered**. |
| D-1 | covered (key points) | `05-faults-maker`, `02-refunds` | SDK | Direction A: killed before the notice (R-2), at the notice / during the XMR relay, after ready before the claim (and R-7). Direction B: after funding, after ready. One lock transaction, one sweep, nothing parked. Every intent state: **package only** (`daemon` crash-recovery tests). |
| K-1 | partly covered | `05-faults-maker` | SDK | Rotation while a swap is in flight; next swap under the new version. `stale_key` on an inbox message and an expired version: **package only**. |
| E-1 | partly covered | `01-happy`, `05-faults-maker` | UI, SDK | Pool and proofs through the relay on every Ethereum swap; reject reason 1 (no taker proof); same leaf twice (reason 2); waits on `finalized`. A rogue funded share in direction B: **package only** (`sdk`). |
| T-1 | partly covered | `01`, `03`, `04` | UI, SDK | Forward to a listed onion with DLEQ upload and pool fetch; an unlisted onion refused; a reply read from the replies route; on-chain fallback when the relay is down, both ways. Oversize body and disallowed path: **package only** (`relay`). |
| L-1 | covered | `06-large` | UI | Three REAL daemons, two waves under the limit, one daemon killed, remainder re-planned, report, sweeps. |
| U-1 | covered | `01`, `04` | UI | No lock without the backup; nothing reaches the wallet before the checkbox; banner, title and leave prompt; "Safe to close" only while ready; reload resumes; auto-refund. |

## Console against the live daemon (browser)

| Action | Status | Where |
| --- | --- | --- |
| Approve a pending lock | covered | `03-modes-console` |
| Reject a pending lock | covered | `03-modes-console` |
| Release a held deposit before the hold ends | covered | `03-modes-console` |
| Withhold, then release a withheld deposit | covered | `03-modes-console` |
| Reply to an inbox message (taker reads the reply) | covered | `03-modes-console` |
| Change an offer setting and see it applied (on-chain price, file, change log, taker page) | covered | `03-modes-console` |
| Registration, keys, rebalancing, inventory pages | **not covered** in a browser; the registration and rotation routes are used through the API by the harness |

## Asserted in every scenario that completes or unwinds a swap

Final balances on the paying chain (taker, maker payout or operator, treasury; exact for USDC, within a stated fee bound for SOL and ETH), what happened to the XMR (arrived by transaction id, or recovered into the inventory wallet), the maker's public counters as a delta, and at the end of each file that no log of any process (daemons, relay, anvil, monerod, wallet-rpc) contains a seed, operator key, passphrase, API token, recovery seed or per-swap spend, encryption or session secret.

## Known limits of the harness

- anvil runs with `--slots-in-an-epoch 1` and one block a second: `finalized` is two blocks behind the head. Solana time moves only by `advance`; Ethereum time also drifts forward one second per block.
- The fake Tor is a SOCKS5 server that maps each maker's test onion name to its endpoint port. Nothing touches the system Tor or the Tor network.
- Price sources are a loopback stand-in for CoinGecko's `simple/price`; venues and the rebalancer are not exercised (**package only**, `rebalancer`).
- Scenarios that prove "the daemon does nothing before T" wait one polling interval (a few seconds of real time) after moving the clock to just before T. No scenario sleeps to reach a deadline.
