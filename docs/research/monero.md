# Monero side: joint address, lock verification, sweeping

2026-11-21. Prototype and harness: `tests/monero-regtest/` (working copy with build outputs in `.scratch/monero/`).

Every claim below is tagged:

- **RAN**: executed on a private regtest (monerod / monero-wallet-rpc v0.18.4.5, two nodes) by a script kept in the harness.
- **READ**: from Monero source constants or from memory of public events; not executed here. Re-check before relying on it.

## Summary

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Joint address derivation and trust-minimised lock verification | Plain key addition; standard address encoding. Verification is ~250 lines of pure JS (`@noble/*`), checks txid, destination, amount commitment and unlock time locally, and takes depth as the minimum over several nodes that must agree. | RAN |
| 2 | Sweeping with both halves | Three paths work. Daemon: `monero-wallet-rpc` or the `monero-wallet` 0.2.0 crate. Browser: the same Rust crate compiled to wasm32, talking to a CORS-enabled node over `fetch`. monero-ts could not be proven. | RAN (monero-ts: partly) |
| 3 | End-to-end demo | `pnpm e2e`, `e2e:rust`, `e2e:browser` all pass. | RAN |
| 4 | Monero facts | 10-block lock and change locking demonstrated; block time and reorg guidance from source/memory. | RAN + READ |
| 5 | Taker sells XMR | Taker pays from their own wallet; the page finds the deposit by view-key scanning and verifies it. | RAN |

## 1. Joint address

### Keys

Monero private keys are scalars mod ℓ (ℓ = 2^252 + 27742317777372353535851937790883648493), written as 32 bytes little-endian. Public keys are compressed ed25519 points. Each party generates two independent random scalars: a spend half `s` and a view half `v`.

```
S = S_maker + S_taker          (point addition of the public spend halves)
s = s_maker + s_taker  mod ℓ   (known to nobody until a claim or refund reveals one half)
v = v_maker + v_taker  mod ℓ   (both parties know it once the view halves are exchanged)
V = v·G
```

What each side must hand over: its public spend half `S_x` (the on-chain commitment) and its **private** view half `v_x`. The maker needs only `V_taker` to compute the address, but needs `v_taker` to scan and to publish evidence, so exchange the private half.

Rules the code enforces (`lib/monero.mjs`, `jointPublic`):

- Reject a spend half that is the identity or has a torsion component (not in the prime-order subgroup). RAN: an order-8 point is rejected.
- Reject scalars that are zero or not canonical (≥ ℓ).
- Each client recomputes the address from the halves. Never trust an address stored or sent by the other side.

The joint wallet is **not** a seed wallet. A normal wallet derives `v = H(s)`; here `v` is independent. Restoring it anywhere requires all three of address, view key and spend key ("generate from keys"). RAN: monero-ts and wallet-rpc both accept that triple and reject a wrong spend key.

### Address encoding

```
data    = varint(prefix) ‖ S (32) ‖ V (32)
address = monero_base58( data ‖ keccak256(data)[0..4] )      69 bytes → 95 characters
```

Monero base58 encodes 8-byte blocks to 11 characters (big-endian), with a 5-byte final block as 7 characters. It is not Bitcoin base58.

| Network | Standard | Integrated | Subaddress | Standard address starts with |
| --- | --- | --- | --- | --- |
| Mainnet | 18 | 19 | 42 | `4` |
| Stagenet | 24 | 25 | 36 | `5` |
| Testnet | 53 | 54 | 63 | `9` or `A` |
| Regtest (`fakechain`) | 18 | 19 | 42 | `4` (identical to mainnet) |

RAN: regtest uses mainnet prefixes. `get_info.nettype` reports `fakechain`, and wallet-rpc accepted our prefix-18 address as a view-only wallet with the joint view key. Wallet libraries must be told "mainnet" when pointed at regtest. The joint address is always a standard address; never a subaddress or integrated address.

Test vector (from a run):

```
S_maker 6f863e268cff9390a698f23843f802584c7bd2e3bc74593e60dd4138da1de31c
S_taker 07c805e21c0057430b82a791f66fdc0d185d398e4f8fb73a955b6bada1ac88d9
v_maker c6367a52bf1ab84df6e44d2f4b5a12fa490bf9351654a5b610f568122e5b7002
v_taker 2f246ff530c01376f39b9e2e95e9dcd953e6020a2b984bad02203c4e596c5906
S       2db092644300d969e9c5f82caffedc48767ad40d341cc4ee7187731aa072b5b4
v       f55ae947f0dacbc3e980ec5de043efd39df1fb3f41ecf0631315a56087c7c908
V       fb9cea73d65c85a70877f532feebb8fe021f43f2fc2e9a79710f1e793765e8b5
mainnet  43MXoVqwCynJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXkmBPX
stagenet 53ZZtLktratJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXm9Npw
testnet  9tu5HkWCVLtJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMV285eg
```

### Verifying the lock from the txid and view key

Implemented in `lib/verify.mjs` (`verifyLock`), pure JS, same file runs in Node and in the browser. RAN in both.

Per node, two calls: `POST /get_transactions {txs_hashes:[txid]}` and `POST /json_rpc get_info` (plus `get_block` at the reported height).

Checked locally, where a node cannot lie:

1. **The blob is the transaction.** Parse the raw hex and recompute `txid = keccak(keccak(prefix) ‖ keccak(rct_base) ‖ keccak(rct_prunable))`. Pruned nodes return `pruned_as_hex` + `prunable_hash`; that works too. A node returning any other blob is rejected.
2. **Destination.** For each output `i`, with tx public key `R` from `extra` (or the per-output additional key): `D = 8·v·R`, `P' = Hs(D ‖ varint(i))·G + S`. A match with the output key means it pays the joint address. The one-byte view tag is checked first.
3. **Amount.** `amount = enc_amount XOR keccak("amount" ‖ Hs)[0..8]`, then recompute `mask = Hs("commitment_mask" ‖ Hs)` and require `mask·G + amount·H` to equal the output's commitment. Without this step the decrypted amount is whatever the sender typed.
4. **Unlock time** is 0, RingCT type is 6 (CLSAG + Bulletproofs+), exactly one output pays us, amount ≥ expected.

Taken from nodes, so compared across them:

5. **Inclusion and depth.** Every node must return the tx, place it in the same block (same height and block hash, and that block must list the txid). Confirmations = `height − block_height`, and the result is the **minimum** over all nodes that answered; a node that lacks the tx or has it only in its mempool counts as 0. `double_spend_seen` on any node blocks.

What this does and does not give you:

- The verifier passes only if **every** queried node agrees, so an attacker must control all of them. One honest node is enough for safety. A lying or lagging node can only stall the swap, which ends in the automatic refund.
- The browser does not verify ring signatures, range proofs or proof-of-work (RandomX is impractical in a tab). A set of colluding nodes can therefore show a lock that does not exist. Hence: own node preferred, otherwise at least two operated by different parties.
- Confirmations can go **down**. The page must keep polling until it has swept, not stop at "ready".

RAN results (`e2e.mjs`, `edge-cases.mjs`):

| Case | Result |
| --- | --- |
| Lock in mempool | `pending`, amount decoded, 0 conf |
| A single view half used as the view key | `invalid`: no output pays the address |
| Expected amount 1 piconero higher | `invalid` |
| Unknown txid | `not-found` |
| One of two nodes unreachable | never `ok` |
| 1, 9, 10 blocks | `confirming` → `confirmed` at the configured depth |
| Lock tx that also pays a subaddress (additional tx keys) | found and verified |
| One node rolled back 2 blocks | `confirming`, 0 conf, "mined on only 1/2 nodes" |
| 3-block fork without the lock replaces the 2-block chain | `pending`, 0 conf on both |

Not exercised: a lock with non-zero `unlock_time`. Wallet software 0.18.4.5 refuses to build one ("Transaction cannot have non-zero unlock time", RAN), but consensus still accepts them (READ), so the check stays. Tampered-amount and wrong-blob paths are implemented but have no negative test.

Notes for the build:

- After the reorg above, the orphaned lock sat in one node's mempool and was not re-mined by the other. The maker daemon must keep the raw lock tx and rebroadcast it after a reorg.
- A transaction reaches other nodes' mempools seconds later (Dandelion++). "Not found yet" right after the lock notice is normal; poll.
- The lock notice needs only the txid and `v_maker`. The transaction private key is not needed.

## 2. Sweeping with both halves

All three were RAN against regtest, sweeping a real lock to a separate wallet and checking the amount arrived.

| Path | Versions | How | Result |
| --- | --- | --- | --- |
| `monero-wallet-rpc` | 0.18.4.5 | `generate_from_keys {address, viewkey, spendkey, restore_height}` → `refresh` → `sweep_all` | Works. Refuses at 1 and 9 confirmations ("unlocks in N blocks"), succeeds at 10. |
| Rust, native | `monero-wallet` 0.2.0, `monero-daemon-rpc` 0.2.0, `monero-simple-request-rpc` 0.1.0 (monero-oxide) | Scan the one block holding the lock, pick decoys via the node, sign, publish | Works, ~50 ms, no wallet file, no sync. |
| Rust → wasm32, in Chromium 151 | same crates + `wasm-bindgen` 0.2.130, transport = `fetch` | Same core as native; `src/wasm.rs` is ~70 lines | Works, ~175 ms. 1.48 MB wasm (518 kB gzip). Page on another origin, so CORS was real. |
| monero-ts (wallet2 in WASM) | 0.11.22 (bundles Monero 0.18.5.4; 2.6 MB + 3.7 MB worker) | `createWalletFull` from keys → `sync` → `sweepUnlocked` | **Not proven.** Key import works; sync fails on regtest. |

### Recommendation

- **Browser: the Rust core compiled to wasm32** (`tests/monero-regtest/rust-sweep`). It is the only browser path proven end to end, it is small, needs no chain sync, and shares code with the daemon.
- **Maker daemon:** use the same Rust core for joint-address work (verify, sweep, recover). Keep `monero-wallet-rpc` for the maker's own inventory wallet (funding locks, pre-splitting, balances), where wallet2's output tracking is worth having.
- **Escape hatch:** the recovery file should contain address, view key, both spend halves once known, lock txid and height. Those restore in any standard wallet with "generate from keys" (RAN via wallet-rpc).

### Why monero-ts is not the choice

wallet2 checks every block's hard-fork version against the mainnet/stagenet/testnet height table. Regtest is at v16 from block 1, so sync throws `Unexpected hard fork version v16 at height …` (RAN). `monero-wallet-rpc` has `--allow-mismatched-daemon-version`; monero-ts exposes nothing equivalent. Consequence: monero-ts cannot be integration-tested on regtest at all, only on a live network. `browser/sweep-monero-ts.mjs` is kept as an untested fallback.

### What node access the browser needs

Measured in the browser run. Verification: `/json_rpc` (`get_info`, `get_block`) and `/get_transactions`, on each node. One sweep, one node, 13 requests: `/json_rpc`, `/get_height`, `/get_transactions`, `/get_o_indexes.bin`, `/get_output_distribution.bin`, `/get_outs.bin`, `/send_raw_transaction`.

- **Restricted RPC is enough.** RAN: scan, verify and sweep all succeeded through a `--rpc-restricted-bind-port` port. A public-style node works.
- **CORS is required.** monerod must run with `--rpc-access-control-origins <origin>` (RAN with `*`; it answers preflights and echoes the origin, on the restricted port too). Most public nodes do not set it (READ), so do not assume arbitrary public nodes work from a tab.
- **HTTPS pages cannot call `http://` nodes** other than localhost (mixed content, READ), and monerod's self-signed RPC TLS will not satisfy a browser. In practice: a node on `127.0.0.1`, or a reverse proxy with a real certificate that forwards only the seven paths above.
- A proxy is a node from the trust point of view. Two proxies run by one operator count as one source.
- The node used for the sweep sees which outputs were requested as ring members. It cannot steal; a malicious one can weaken privacy of that sweep. Use the user's most trusted node for it.

### Caveats of the Rust path

- The sweep pays the destination plus a zero-amount dummy output with `Change::fingerprintable(None)`. The crate documents small fingerprints for this shape (dummy payment ID handling). Privacy only, not safety.
- The prototype asks the node for a fee rate with no cap (`u64::MAX`). Cap it in production; a hostile node could otherwise burn the swept amount as fee.
- These crates are 0.x. Audit status was not checked. The next Monero hard fork (FCMP++/Carrot, READ, date unknown) changes transaction construction; the sweep code and the pinned crate versions will need an update at that fork.
- The transport wraps JS futures in `SendWrapper` because the crate requires `Send` futures. Sound on single-threaded wasm; do not move it to a threaded wasm build unchanged.

## 3. End-to-end demonstration

`tests/monero-regtest/` (see its README). All scripts assert and exit non-zero on failure.

| Script | Proves |
| --- | --- |
| `e2e.mjs` | Two halves → joint address (cross-checked by wallet-rpc) → fund → verify in mempool, negative cases → sweep refused at 1 and 9 conf → verified at 10 → sweep with `s_m + s_t` → destination receives `amount − fee` exactly. |
| `edge-cases.mjs` | Time-lock refusal by the wallet, additional tx keys, a real 2-block reorg across two nodes. |
| `deposit-watch.mjs` | Unannounced deposit found by view-key scan through a restricted node, verified, swept through the restricted node. |
| `presplit-demo.mjs` | Change locking and pre-splitting (section 4). |
| `run-rust-sweep.mjs` | Native Rust sweep, including refusal at 9 conf. |
| `browser/run-browser-sweep.mjs` | Headless Chromium: in-page verification against two nodes and in-page wasm sweep, cross-origin. |
| `browser/monero-ts-check.mjs` | monero-ts key import works; regtest sync fails. |

Harness gotchas found the hard way:

- monerod loads `~/.bitmonero/bitmonero.conf` even with `--data-dir` set. The first regtest silently inherited `restricted-rpc` and a Tor `proxy` from the live node's config. `start.sh` now passes its own `--config-file`.
- Two regtest nodes need `--allow-local-ip` and `--add-exclusive-node` to peer on localhost. Regtest shares mainnet's network ID, so exclusive peering also keeps it off the real network.

## 4. Monero facts the design relies on

| Fact | Value | Status |
| --- | --- | --- |
| Spend lock on every output, including change | 10 blocks, consensus rule | RAN: sweep refused at 9 conf, accepted at 10; `monero-oxide` `DEFAULT_LOCK_WINDOW = 10` |
| Coinbase lock | 60 blocks | READ (`COINBASE_LOCK_WINDOW`) |
| Block time | 120 s target, so 10 blocks ≈ 20 min, 25 ≈ 50 min. Individual blocks vary widely. | READ (`BLOCK_TIME = 120`) |
| Outputs per transaction | up to 16 | READ |
| Ring size | 16, fixed | RAN |
| Mempool lifetime of an unmined tx | about 3 days | READ |

### The 10-block lock and the confirmation tiers

- A 2-confirmation policy lets the swap **complete** after about 4 minutes, but the taker still cannot **spend** the XMR until the lock has 10 confirmations. RAN: with `CONF=2` the lock verifies at 2 and the sweep is refused until 10. The UI must show "yours, spendable in N blocks", and the recovery file must allow sweeping later.
- After the sweep the XMR is a new output in the taker's wallet, locked for another 10 blocks.

### Reorg guidance for 2 / 10 / 25

READ, from memory of public reports; verify before publishing numbers in the UI. In August and September 2025 a single mining pool with a very large hashrate share caused repeated reorgs on mainnet, the deepest reported at 18 blocks, which invalidated already-"confirmed" transactions. Some exchanges raised deposit requirements far above 10 for a period.

| Depth | Wait | Reading |
| --- | --- | --- |
| 2 | ~4 min | Protects against ordinary 1-block races only. Suitable for amounts the at-risk party can afford to lose. |
| 10 | ~20 min | The wallet default and the point where the output becomes spendable. Was not sufficient during the 2025 episode. |
| 25+ | ~50 min+ | Deeper than the deepest reorg reported in 2025. Use for large swaps, and raise it if the network is visibly unstable. |

Who carries the risk: when the maker sells XMR, the **taker** does (a reorg after the maker's claim can remove the lock). When the taker sells XMR, the **maker** does. So the at-risk side must enforce its own minimum depth; the taker UI should not accept an offer's depth blindly. The design's rule to set depth from the total in flight is right: one reorg hits every pending leg.

Recommended additions: a guardrail that pauses or raises depth when nodes report recent reorgs or alternate chains; sweep as soon as the key is known and the output is unlocked; keep verifying until the sweep itself is confirmed.

### Pre-splitting outputs

RAN (`presplit-demo.mjs`):

```
maker holds ONE 10 XMR output : balance 10      unlocked 10
after locking 1 XMR for swap 1: balance 8.998   unlocked 0
swap 2 right away             : REFUSED -> not enough unlocked money
10 blocks later               : balance 8.998   unlocked 8.998
after pre-split + 10 blocks   : 4 locks sent back to back in the same block window
```

- Spending any part of an output locks all of its change for 10 blocks. One output funds one swap per ~20 minutes.
- One transaction can create up to 16 outputs, so a split tx yields 15 ladder outputs plus change. The new outputs are themselves locked for 10 blocks.
- Size ladder outputs slightly above the offer size so one output covers amount plus fee. Otherwise the wallet combines two outputs and locks both.
- wallet-rpc chooses inputs itself. The daemon should track which output backs which swap (wallet-rpc `freeze`/`thaw` by key image, READ), or build lock transactions with `monero-wallet` directly for exact control.
- Published capacity must count unlocked outputs, not balance.

### Maker recovery after a taker refund

The refund on Solana or Ethereum publishes `s_taker`. The maker is then the only party holding both halves.

1. Read `s_taker` from the refund, check `s_taker·G == S_taker` (the contract already did).
2. `s = s_maker + s_taker mod ℓ`.
3. Sweep the joint address to the maker's wallet, with the same code path as the taker's sweep (RAN: the sweep demos are exactly this operation; the key sum does not care which half was revealed).

Operational points:

- The sweep is possible only once the maker's own lock has 10 confirmations. A refund 5 minutes after the lock means waiting.
- The recovered amount is `lock − fee`, in a new output locked for 10 more blocks, and no longer ladder-sized. The inventory splitter must re-split it.
- Persist `s_maker`, `v`, the address, the lock txid and the raw lock tx durably **before** broadcasting the lock. Losing `s_maker` after locking loses the XMR in every outcome.
- If the lock never confirmed, there is nothing to sweep; the inputs are still the maker's once the tx expires from mempools.
- Never reuse a joint address or a key half.

### Key-half hygiene

Outside the Monero question proper, but it decides whether the address is safe to fund. A party could choose its public half as `X − S_other`, making the joint key one it controls alone. In this design every path that pays that party requires revealing the discrete log of its half, which it would not know, so the attack defeats itself as long as that holds for **every** fund-moving path. Cheap insurance: require a proof of knowledge of each half at swap creation (a signature under `S_x` over the swap ID), and reject non-prime-order points on-chain as the JS already does.

## 5. Taker sells XMR

Recommendation, as expected: **the taker pays from their own wallet to the address the page shows. The browser holds no XMR spending key for the payment; it only watches and verifies.**

RAN (`deposit-watch.mjs`): a payment made by an ordinary wallet, with no txid given to the watcher, was found in the mempool and again after mining, by view-key scanning through a restricted node, then verified across two nodes.

What the page does:

1. Generate the taker's halves, derive the joint address, and show it with the exact amount as text, QR and a `monero:<address>?tx_amount=<xmr>` URI.
2. Watch with `findDeposits` (`lib/watch.mjs`): `get_transaction_pool_hashes`, `get_block` for each new height, `get_transactions` in batches of 100, and the same output scan as section 1. Cost per transaction is one scalar multiplication. Run it against at least two nodes.
3. Offer a "paste your transaction ID" shortcut, which skips the scan.
4. Run `verifyLock` on each candidate and show confirmations against the maker's required depth.
5. Post the txid as the lock notice. The maker's daemon verifies independently with the same rules before setting ready.

What the taker must be told before paying:

- Send one transaction, for at least the exact amount, to exactly this address, before the deadline shown. Underpayment is not a lock.
- Pay from a wallet you control. Exchange withdrawals can be delayed past the deadline or batched.
- Give an XMR refund address up front. If the maker refunds and reveals its half, the page sweeps the joint address back to that address (the proven browser sweep), after the 10-block lock.
- The backup file is needed for that refund sweep. Same "back up before you pay" gate as the other direction.

Open design issue: XMR sent to the joint address **after** the take has lapsed is recoverable only if the maker reveals its half. The flow needs an explicit path (and a reason for the maker to follow it) for late deposits, or the page must refuse to show the address once too little time remains for the payment to confirm.

## Recommendations for the build

1. Ship `lib/monero.mjs` + `lib/verify.mjs` + `lib/watch.mjs` as the browser's Monero verification layer (pure JS, no WASM). Port the same checks to Rust for the daemon, or call the `monero-wallet` scanner.
2. Promote `rust-sweep` to a shared crate used by the maker daemon (native) and the web UI (wasm32). Pin `wasm-bindgen` to the CLI version in CI.
3. Node configuration takes a list. Require two or more independently operated sources unless one is the user's own node. Fail closed on disagreement.
4. Ship a small allow-listed reverse proxy (seven paths) with the self-hosted bundle, and document `--rpc-access-control-origins` for people running their own node.
5. Use `tests/monero-regtest` as the integration harness. It cannot test monero-ts; that is one more reason not to depend on it.
6. Maker daemon: store raw lock transactions and rebroadcast after reorgs; count unlocked outputs for capacity; re-split recovered and change outputs.
7. UI: distinguish "confirmed for the swap" from "spendable" (10 blocks), and keep watching until the sweep confirms.
8. Before mainnet: re-verify the 2025 reorg figures and the consensus status of `unlock_time`, check the monero-oxide audit status, and run the browser sweep once on stagenet.
