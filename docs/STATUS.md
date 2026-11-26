# Status

2026-11-23.

Everything in the design is built: the core crate, the Solana program, the Ethereum contract, the SDK, the maker daemon and console, the taker web UI, the relay, the rebalancer and the self-hosting bundle, and the end-to-end suite that runs them together on local test chains is green. **None of it has been audited and none of it has ever run on a live network**: no deployment, no real Tor, no real venue, no real Monero outside a private regtest. It is an experimental system that passes its own tests; it is not ready to hold anyone's money.

## What is built

The repository records no per-package test totals, so none are given here; the figures below are the ones its own records state.

| Package | What it is | Recorded evidence |
| --- | --- | --- |
| `crates/swap-core` | All cryptography and encodings, the Monero sweep, the reference state machine, the vector generator | Vectors regenerate identically; the model has a hand-written table test and a property test of the no-race rule |
| `packages/core-wasm`, `packages/protocol` | The core for Node and browsers; types, constants, codecs | The wasm build matches the native results on every vector; codecs are checked byte for byte against Anchor's |
| `solana/` | The Solana program | Replays all 405 Solana rows of `transitions.json` and every sequence, with SOL and with USDC, in-process on LiteSVM; no row skipped or special-cased |
| `ethereum/` | The Ethereum contract (one proxy, an implementation, two linked libraries) | Replays its 399 rows with no special cases; storage layout pinned slot by slot |
| `tools/svm-rpc` | Test-only JSON-RPC facade over an in-memory LiteSVM | Rust tests and a web3.js suite |
| `packages/sdk` | Chain clients, Monero verification, taker and maker decision flows, router | Unit suite replays the vectors through the core; integration suite against the built program, contract and regtest found no bug in them |
| `packages/relay` | Tor relay and allow-listed Monero proxy | Unit tests against a fake SOCKS server |
| `packages/rebalancer` | Venue adapter interface, router, six adapters | Unit tests against hand-written fixtures only |
| `packages/daemon` | The maker daemon | Unit tests including a crash matrix; an integration test of four full swaps |
| `apps/console` | The maker console | Component tests against a mock daemon; the daemon's API-contract test passes against its client |
| `apps/web` | The taker web UI | Component tests; browser tests on Solana against `svm-rpc` and regtest |
| `tests/e2e` | End-to-end suite | 31 scenario ids: 19 covered, 9 partly, 2 package-only, 1 not covered (`tests/e2e/COVERAGE.md`) |
| `deploy`, `docs/self-hosting` | Self-hosting bundle and documentation | Acceptance test on loopback fakes, including the Status page in Chromium |

## Test counts

Counts from the integrator's own re-runs on 2026-11-23, after the last change to each package. Where a suite was not re-run by the integrator, the figure is the package author's and is marked so.

| Package | Suite | Result |
| --- | --- | --- |
| `crates/swap-core` | `cargo test -p swap-core` | 118 pass (author's figure; 111 re-run before the follow-ups); 24 vector files reproducible (re-run) |
| `solana` | in-process program tests | 99 pass |
| `ethereum` | `forge test` | 156 pass |
| `tools/svm-rpc` | TypeScript client tests | 13 pass; 26 Rust tests (author's figure) |
| `packages/sdk` | unit | 228 pass |
| `packages/sdk` | integration (program, anvil, regtest) | 28 pass (author's figure; 27 re-run before the last fix) |
| `packages/relay` | unit | 73 pass |
| `packages/rebalancer` | unit | 176 pass, 18 skipped (bridge IDL not supplied) |
| `packages/daemon` | acceptance | 140 pass; integration 7 pass (author's figure) |
| `apps/console` | unit and build | 286 pass |
| `apps/web` | unit and build | 108 pass; browser 6 pass (author's figure; 5 re-run earlier) |
| `deploy` | acceptance | 79 pass |
| `tests/e2e` | full system | 74 pass in 19.0 min, no known failures |

## What is proven, and how

- **Both contracts implement the same state machine.** Each replays the vectors generated from one reference model, row by row and in multi-step sequences, including the second either side of every deadline, parked payouts and zero deposits.
- **The cryptography agrees across implementations.** Rust, wasm, the Solana program, Solidity, viem and `cast` produce the same bytes on the shared vectors (key derivation, proofs of knowledge, twin keys, Merkle pool, EIP-712, notice and envelope encryption).
- **The SDK drives the real program and contract.** Its integration suite runs against the built program, the contract on anvil and real XMR on a two-node regtest: every refusal it predicted was the one given, and balances matched to the unit.
- **The whole system completes and unwinds swaps.** The end-to-end suite runs the real daemon, relay, built UIs in Chromium, the program, the contract and regtest Monero together. Covered at system level (19 scenarios): happy paths in both directions on all four markets, approval modes, advance approvals, every row of the design's refund table, the 60-day split, false notices in both directions, pay-or-park, a real duplicate one-time key, daemon crashes, a three-maker large swap and the UI's safety gates. Every scenario checks final balances, where the XMR went, the maker's public counters, and that no process log holds a secret.
- **The suite found four real bugs** (one in the SDK, one in the console, two in the daemon, including two locks spending the same Monero output). All four are fixed and their tests are now ordinary scenarios.

## What is not proven

- **No audit** of the contracts, the core crate or anything else. The cross-curve DLEQ library (`sigma_fun` 0.9.0) has no independent audit, and the two-address key commitment on Ethereum is this project's own construction.
- **Never run on any live network.** No devnet, Sepolia or mainnet deployment; mainnet behaviour of the Solana program is inferred from an in-process runtime. No real Tor (a fake SOCKS server stands in). No real venue API. No Monero stagenet or mainnet. No real browser-wallet extension.
- **The rebalancer and all six venue adapters** are tested against hand-written fixtures only and are outside the end-to-end suite. The wXMR bridge adapter runs on documented assumptions: the bridge's IDL is not in the repository. The Kraken driver is unverified against the live API.
- **End-to-end gaps** (from `COVERAGE.md`): oversized quotes on request (M-3) were never run at system level; a dishonest maker on Ethereum; a lock replaced by a fork; the Ethereum timing scenario (X-2) at depth 10 (only depth 2 ran); recovery combined with two key rotations; approval-binding races (M-4) and extreme deadlines (B-y) are package tests only; the console's owner-key, key-rotation, rebalancing and inventory-split actions were never driven in a browser.
- **The bundle's compose file and Dockerfiles have never been built.** Release artifacts are a directory with checksums: no signature, no publication channel.
- The browser sweep has run only in Chromium and only on regtest. The next Monero hard fork will require updating the sweep.

## Risks inherent in the design

These are not defects; they follow from the design and no amount of testing removes them.

- **Closed tab.** A taker paying SOL, ETH or USDC whose tab is closed between the refund cutoff and the maker's claim delay loses everything to a maker that posted a false lock notice.
- **Maker downtime in the sell direction.** A daemon offline for roughly 45 minutes of a funded swap can lose its escrow to a taker's false notice.
- **False notice, then withhold.** A maker can post a false notice, wait for the refund and withhold the deposit: the taker loses up to 5% (half after 60 days). The maker gains nothing but pays only in reputation.
- **The treasury gains from unreleased withholds**, a conflict of interest for whoever controls it.
- **USDC freeze.** The issuer can freeze the escrow or pause the token mid-swap; atomicity is then lost.
- **Thin wXMR pool.** The pool is small enough to be pushed off-market cheaply, and refills through it must be split. Since 2026-11-26 the maker may choose it as a primary price source, even the only one; a maker who does relies on the pool's minimum-liquidity and averaging settings and the ordinary guardrails, and the console says so before saving.
- Also: shallow confirmation depth and Monero reorgs; a compromised browser page; a stolen operator key in the sell direction; secrets that land late; finality stalls; public maker activity; and, until frozen, trust in the upgrade key.

## Owner decisions outstanding

All 40 items of "Interpretations pending owner sign-off" in `docs/SPEC.md`, numbered as there. None has been signed off.

1. Explicit approval on every Ethereum swap ("auto-accept" is the daemon approving after it verifies the taker's proof) **Built:** On.
2. Ethereum lock-notice window **Built:** 10 min + 20 min finality allowance = 30 min.
3. Ethereum claim-delay floor and default **Built:** Floor 120 min, counted from the notice (stricter than "from approval"); daemon default 180 min, because the refund cutoff now includes the finality wait (item 5).
4. Expiry after the final deadline **Built:** 30 days.
5. Refund cutoff: per-confirmation allowance, plus the finality allowance **Built:** 180 s per confirmation and `F` added once: cutoffs of about 21, 45, 90 minutes on Solana and 41, 65, 110 on Ethereum.
6. Depth tiers and their thresholds; whether depth 2 should exist **Built:** 2 below 1 XMR, 10 below 50 XMR, 25 from 50 XMR.
7. Sell-XMR "small fee" **Built:** A refundable take deposit, in the market's asset, capped at 5%.
8. Destination of the treasury's half of a 60-day split (the treasury gains from unreleased withholds) **Built:** The treasury.
9. Hard cap on the approval window **Built:** 3,600 s.
10. Minimum time before `set_ready` (limits a stolen session key) **Built:** `depth × 60 s` after the notice.
11. Ethereum claim window and broadcast margin **Built:** 90 min; 30 min.
12. Advance-approval size limit is per swap, not cumulative **Built:** Per swap.
13. Identity-link delay **Built:** 7 days.
14. Every maker must register on Solana at launch **Built:** Required.
15. Time before anyone may close a settled Solana swap account **Built:** 30 days.
16. Ethereum quotes have no cumulative fill cap (approval bounds exposure) **Built:** No cap.
17. Ethereum default approval window. Because every Ethereum swap is approved explicitly and blocks are 12 s apart, the daemon default is 120 s, so Ethereum offers show DESIGN's "longer than 60 seconds" warning by default. **Built:** 120 s.
18. Cap on the notice window (needed so no refund and claim window can overlap) **Built:** 3,600 s.
19. Cap on open pending swaps per maker. Not in DESIGN. An attacker can fill the slots with refundable locks; the daemon frees them by rejecting unusable locks at once. A per-taker cap was considered and not adopted: it is evaded for free with more wallets and on Solana would add an account to every lock. **Built:** 64.
20. Sell direction: a notice after the deadline is still accepted, and a maker refund after it always holds the deposit **Built:** Accepted until `T_nl`.
21. Sell direction: after the expiry anyone can return a stranded take deposit; the maker's escrow is parked for it **Built:** On.
22. Rejections the maker attributes to unusable taker input or a leaf collision are counted apart from ordinary rejections and left out of the approval rate (the maker's own statement, shown beside the ordinary count) **Built:** On.
23. Seed derived from a wallet signature **Built:** Not offered.
24. Solana quotes on request are public on-chain accounts paid for by the maker, not signed blobs **Built:** On-chain `Quote` account.
25. Third parties can never close a settled Solana swap that holds a revealed share; the taker can after 30 days **Built:** As stated.
26. Zero-amount swaps are refused on both chains (a dust take that rounds to zero would lock the taker's XMR against nothing) **Built:** Refused, `AmountOutOfRange`.
27. Generic exchange driver **Built:** Kraken (`name = "kraken"`), unverified against the live API.
28. On Ethereum an operator address can serve one maker only; someone can register a record naming another maker's intended operator first, forcing that maker to pick another key **Built:** As built.
29. Router ranks offers by `price × (1 + dep_bps × withhold rate)` and treats a maker with no history as withholding every time **Built:** As built.
30. Rebalancer package defaults when a key is absent: alert only, every venue off, floating rate, priority routing, empty allow-list unless the daemon supplies one **Built:** As built.
31. The Ethereum contract is one proxy address backed by an implementation and two linked libraries (code-size limit); an upgrade replaces all three **Built:** As built.
32. The hosted relay sends no CORS headers unless an origin is allow-listed **Built:** Off.
33. The taker's recovery seed is kept in `sessionStorage` for the life of the tab, so a reload resumes without a prompt; sealed in IndexedDB only if the user sets a device passphrase **Built:** As built.
34. The self-hosting start command does not launch Tor (DESIGN: "one command that starts the UI, relay and Tor together"); only the untested compose file brings its own **Built:** As built.
35. The bundle's relay rate limit is 6,000 requests and 1 GiB per minute, 100 times the relay's own default **Built:** As built.
36. Changing an endpoint or key setting of the daemon needs a restart (DESIGN: edits "apply without a restart") **Built:** As built.
37. A release is a directory with checksums; no signature, archive or publication channel **Built:** As built.
38. Solana wallets through the Wallet Standard only; no vendor adapters **Built:** As built.
39. Opposite-side flow is an alert only, and measured refill cost is not fed into the offer deviation automatically **Built:** As built (listed as a follow-up).
40. Not adopted, for the owner to decide whether to cost: verifying ed25519 directly in the EVM on the taker's refund path, which would remove the taker's DLEQ proof and allow true auto-accept on Ethereum **Built:** Not built.

Separately: the wXMR bridge IDL has not been supplied (`packages/rebalancer/vendor/wxmr_bridge.json`), and no licence has been chosen.

## Before any real use, in this order

1. **Owner sign-offs**: the 40 items above. Changing a protocol constant means regenerating the vectors and re-running both replays.
2. **Supply the bridge IDL** and check the adapter against it and against the deployed bridge.
3. **External audit** of the Solana program, the Ethereum contract (including the linked libraries and the storage layout) and the core crate, with the DLEQ library and the two-address commitment named in scope.
4. **Trial on test networks**: Solana devnet, Sepolia and Monero stagenet, with real Tor, a real wallet extension, and each venue the owner means to enable, closing the end-to-end gaps listed above.
5. **Decide on a mainnet deployment** and who holds the upgrade-authority key (and the Ethereum owner, treasury and Solana admin keys).
6. **Freeze**: revoke the Solana upgrade authority, renounce the Ethereum owner, publish verifiable builds and signed releases.

Open follow-up work is listed under "Post-M4" in `docs/research/m1-followups.md`.
