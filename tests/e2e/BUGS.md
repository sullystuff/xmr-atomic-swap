# Bugs found by the end-to-end suite (WP11)

Each confirmed bug has: the package, the symptom, the reproduction command and a diagnosis. While a bug is open its test states the correct behaviour at full strength in a separate known-failures file and is reported separately as an expected failure (`scenarios/known.ts`, `scripts/run.mjs`); once fixed, the test becomes an ordinary scenario. Nothing in another package was patched from here. **No bug is open at the moment**; the known-failures group is empty.

## Confirmed, open

None.

## Fixed

### BUG-2 (FIXED) · `apps/console` (`src/lib/config/schema.ts`, `validate.ts`) · "Validate and save" refuses a configuration the daemon accepts

**Symptom.** With `[pricing.sources.coingecko] base_url = "…"` in the maker's file (a key the daemon's schema defines, daemon DEVIATIONS C1; this harness needs it to point the price source at loopback), every save from the console's Configuration page stops with "Not saved: 1 error has to be fixed first" and, under Review, `pricing.sources.coingecko.base_url: Unknown key "base_url" in [pricing.sources.coingecko]. The daemon refuses keys it does not know.` The daemon does know it: it started on that file and `GET /api/config` reports `validation.ok = true`. The edit never reaches the daemon, so a maker with such a file cannot change any setting from the console. Before commit `a5dab22` the same scenario saved (three green runs of `03-modes-console`).

**Reproduce.** `(at the time) pnpm --filter @xmrswap/e2e test -- scenarios/99-known-failures.test.ts` (test "BUG-2", about one minute): opens the console in Chromium against the live daemon, changes SOL buy-XMR "Deviation from reference" to 5, clicks Validate and save, and expects the new price on-chain and the edit in the file.

**Diagnosis.** The console's own schema for the keyed price sources lists `api_key_env` and `min_interval_seconds` only; `base_url` is missing, and since `a5dab22` a key missing from the console's schema is an error rather than a warning. The daemon's schema (`packages/daemon/src/config/schema.ts`, `keyedSource`) has `base_url`. The wXMR pool keys of daemon C1 (`base_vault`, `quote_vault`, `quote`) are worth checking against the console's schema in the same pass. The console should either carry every daemon key or let the daemon's validation (which it already asks for: "checking with the daemon…") be the judge of unknown keys.

**Fixed** by `8762bf0` (console: the daemon judges the configuration; unknown keys are kept and never block a save; saves patch only the edited lines) with `4b53d45`. Now the ordinary scenario "Configuration" in `03-modes-console`: the edit is made and saved in the console in Chromium, the new price is on-chain without a restart, and the file keeps its `base_url` line.

### BUG-3 (FIXED) · `packages/daemon` (`src/swaps/executor.ts`, `manual` / `step` / `settleInstruction`) · a valid operator instruction is refused when it arrives during the daemon's own pass over the swap

**Symptom.** Intermittently, an operator action that the swap's state accepts comes back "not carried out … The swap has moved on and is no longer in a state that accepts this" (`refused: not-available-in-state`), nothing is sent, and the swap is in fact still in the same state with the action still offered. Seen in `03-modes-console` as "Release deposit" on a WITHHELD deposit refused while the row still showed WITHHELD and `actions: ["release"]`; pressing the button again works. The answer is wrong (the state did not move on) and, for a time-boxed action such as a withhold inside the 30-minute hold or an approval inside its window, an operator who trusts it loses the action.

**Reproduce.** `(at the time) pnpm --filter @xmrswap/e2e test -- scenarios/99-known-failures.test.ts` (test "BUG-3", about a minute). A swap is put in HOLD; one of the daemon's Monero nodes is made slow (4 s per answer) so that each of the daemon's passes over the swap, which look for its lock, lasts seconds; the test waits until such a pass is provably in flight (a request is waiting in the slow node) and sends `POST /api/swaps/:ref/release`. Expected: carried out (or pending, then carried out), `deposits_returned` moves. Observed: refused, nothing sent.

**Diagnosis.** `manual()` writes the instruction to the row (`facts.instruction`, status `pending`) and then awaits `step(ref)`, which is serialised per swap. If the periodic tick's `step` for the same swap is already running, it finishes first; at its end it calls `settleInstruction(ref, last)`, finds a pending instruction that its own pass (decided before the instruction existed) did not carry out, matches none of the "still in flight" cases, and falls through to `refused: ownRefusal(...)` = `not-available-in-state`, clearing the flag. The instruction's own `step` then finds nothing to do. Suggested fix for the owner: let a step settle only an instruction that existed when the step read its facts (for example compare `instruction.at`/`mark` with a marker taken at the start of the pass), or settle only inside the step that `manual()` itself started.

**Fixed** by `49be4b9` (daemon: instructions are settled only by a later pass). Now an ordinary regression scenario in `05-faults-maker` (instruction sent while a pass is provably in flight: carried out). The workaround is gone: `Maker.instruct` and the console helper in `03-modes-console` send each action exactly once and fail on a refusal.

### BUG-4 (FIXED) · `packages/daemon` (`src/inventory/index.ts`, lock preparation) · two locks can spend the same Monero output; the second swap is aborted after its notice

**Symptom.** Now and then the daemon posts its notice, records `xmr_relay: confirmed`, in the same second raises the critical alert `lock_double_spend` ("an input of the lock transaction was spent elsewhere; aborting") and aborts the swap (A7b, public counter `aborts_early`). The taker refunds in full; the maker loses the swap and has announced a lock that never existed on any node. Seen four times in `05-faults-maker` (always the first lock after a direction-B sweep had landed in the inventory wallet and another lock had just been mined).

**Reproduce.** `(at the time) pnpm --filter @xmrswap/e2e test -- scenarios/99-known-failures.test.ts` (test "BUG-4", one to three minutes). An output is paid to the inventory wallet and unlocked, the wallet is refreshed (as wallet-rpc does by itself every 20 s), and two buy-XMR swaps are opened one after the other; repeated up to six times because the window depends on the daemon's 30-second inventory timer. Expected: both locks are relayed. Observed: the second swap is aborted with `lock_double_spend`.

**Diagnosis** (from the daemon's own database after an occurrence: `lock_txs.key_images` of two consecutive swaps were `[A, W]` and `[B, W]`). Coin control thaws the one reserved output and lets the wallet build the transaction, but any other output that is unfrozen at that moment (one that arrived since the last `sync`: a swept joint address, a payment, change) can be added by the wallet as a second input. The daemon stores both key images but re-freezes only the output it thawed (`finally { freeze(output.key_image) }`), so `W` stays unfrozen; the wallet did not relay the transaction itself (`do_not_relay`) and so still counts `W` as unspent until its next refresh. A lock prepared before that refresh takes `W` again; the node refuses it as a double spend, yet the relay is journaled as `confirmed`; the next pass finds the lock on no node and its key image spent, and aborts. Suggested fixes for the owner: freeze every output before thawing the reserved one (or refresh and `sync` inside the same serialised section before each prepare); after a prepare, freeze and mark spent every key image the transaction uses; refuse a prepared transaction whose inputs are not exactly the reserved output; and do not journal a relay the node refused as confirmed.

**Fixed** by `49be4b9` (daemon: exclusive lock inputs, truthful relay journal, pre-notice check). Now an ordinary regression scenario in `05-faults-maker`: three rounds of back-to-back locks from a wallet holding an unfrozen extra output; both lock transactions are read from the node, their key images are disjoint, both verify for the taker, no `lock_double_spend` alert, no abort counter. The workaround (`inventorySettled`) is removed from every scenario.


### BUG-1 (FIXED) · `packages/sdk` (`src/flows/taker.ts`, `takerA`, state NOTICED) · the taker's confirmed refund request is ignored once the XMR lock is confirmed

**Symptom.** In the web UI, on a buy-XMR swap whose lock has reached its confirmation depth but for which `set_ready` is not yet allowed (the contract's minimum wait, `t_N + depth × 60 s`), the user clicks **Refund this swap**, reads "You get … back now. The deposit of … is held for 30 minutes…" and clicks **Yes, refund**. Nothing is sent. When the minimum wait ends the tab sets ready instead, and the maker claims: the swap completes although the user explicitly asked to back out (DESIGN refund table row 4, SPEC A10b, is allowed at every instant of NOTICED before `T_co`). No funds are lost (the user receives the XMR), but the page does the opposite of what it just confirmed, and the user cannot back out during that window at all. First seen on Ethereum in `01-happy` (there the minimum wait elapses in real time, so the swap ran to completion); the minimal reproduction is on Solana, where the clock stands still.

**Reproduce.** `pnpm --filter @xmrswap/e2e test -- scenarios/99-known-failures.test.ts` (test "BUG-1"; about two minutes). It locks 0.4 XMR in the browser against the real daemon, mines the lock to depth, clicks Refund and Yes, and expects HOLD within 30 s; the swap stays NOTICED.

**Diagnosis.** `takerA` returns before it looks at `f.cancel` whenever the lock is good:

```ts
if (lockGood) return now >= d.tReadyMin! ? call({ name: 'set_ready' }, …) : wait('ready-minimum', d.tReadyMin);
…
if (refundable && (f.cancel || now >= d.tCut!)) return call({ name: 'refund' }, 'session', 'A10b', tCo - M);
```

The engine (`apps/web/src/lib/engine.ts`) passes `cancel: true` correctly; the flow drops it. A refund asked for while the lock is still unconfirmed works (that path is covered in `01-happy` on Ethereum and `03-modes-console` on Solana). Suggested fix for the owner: test `f.cancel && refundable` before the `lockGood` branch (and decide whether the same applies to a confirmed lock in READY, where the model has no refund before `T_cd`: there the page should say so instead of offering the button).

**Fixed** by `0ecae9d` (SDK: an explicit request wins while the contract still accepts it, and is refused with a reason otherwise), with `d10d82b` (web: a visible outcome for every request) and `e15686d` (daemon: operator instructions journaled and always answered). The known-failure test reported "NOW PASSES" on the first run against those commits and is now two ordinary scenarios in `04-faults-taker` ("the taker asks to get out"): a refund asked after the lock is confirmed is carried out, the tab never sets ready, the daemon recovers its XMR and the deposit is held then collected; a refund asked after ready shows the refusal and the swap completes. The reproduction command above no longer applies.

## Observations (not bugs, or not reproduced; no test attached)

| # | Package | What was seen | Why it is not filed as a bug |
| --- | --- | --- | --- |
| O1 | `apps/web` | While one of two Monero nodes does not answer, the swap page shows "2 of 2 confirmations on every node" directly above "Not counted as confirmed: node-failed: …". | Behaviour is right (the tab does not set ready and refunds at the cutoff: `04-faults-taker`); only the first line's wording claims more than is known. Cosmetic. |
| O2 | `apps/web` | In the large-swap tool, when a leg settles in the same instant the remaining makers' offers have lapsed, the automatic next wave is not retried: the board keeps "Open next wave" until the user clicks. | Documented fallback (web W12). It showed up here because tests jump the chain clock past the 60-second offer validity; a live maker refreshes continuously. `06-large` now publishes offers valid for an hour, and still clicks the button if the page leaves it. |
| O3 (closed) | harness, `apps/web` | Selling XMR on Ethereum, the pay-address panel sometimes appeared 62–159 s after the maker's funding. | Root cause was this harness: anvil was started without `--block-time`, so `finalized` moved only when unrelated transactions mined blocks, and the page rightly waits for finality. Fixed here (`--block-time 1` in `src/chains.ts`); the page now also says what it waits for (`4823682`). `01-happy` asserts the waiting message while finality is held back and the address within 20 s of release; a late address is still written to the run's observations. |
| O4 | `packages/daemon` | A daemon started before it is registered on Ethereum raises `eth_quotes_failed: NotRegistered`, which stays in the alert list after registration. | Expected at first start; the alert is a warning and can be acknowledged. |
| O5 | `packages/daemon` | A parked payout is only an alert; the daemon cannot withdraw it. | Documented gap (daemon M2): `withdraw_owed` needs the owner key. `05-faults-maker` withdraws with the owner key. |
