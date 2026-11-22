# Bugs found by the end-to-end suite (WP11)

Each confirmed bug has: the package, the symptom, the reproduction command, a diagnosis, and a test in `scenarios/99-known-failures.test.ts` that states the correct behaviour at full strength and is reported separately as an expected failure until the owner fixes it (`scenarios/known.ts`). Nothing in another package was patched and no assertion was weakened to get the suite green.

## Confirmed

### BUG-1 · `packages/sdk` (`src/flows/taker.ts`, `takerA`, state NOTICED) · the taker's confirmed refund request is ignored once the XMR lock is confirmed

**Symptom.** In the web UI, on a buy-XMR swap whose lock has reached its confirmation depth but for which `set_ready` is not yet allowed (the contract's minimum wait, `t_N + depth × 60 s`), the user clicks **Refund this swap**, reads "You get … back now. The deposit of … is held for 30 minutes…" and clicks **Yes, refund**. Nothing is sent. When the minimum wait ends the tab sets ready instead, and the maker claims: the swap completes although the user explicitly asked to back out (DESIGN refund table row 4, SPEC A10b, is allowed at every instant of NOTICED before `T_co`). No funds are lost (the user receives the XMR), but the page does the opposite of what it just confirmed, and the user cannot back out during that window at all. First seen on Ethereum in `01-happy` (there the minimum wait elapses in real time, so the swap ran to completion); the minimal reproduction is on Solana, where the clock stands still.

**Reproduce.** `pnpm --filter @xmrswap/e2e test -- scenarios/99-known-failures.test.ts` (test "BUG-1"; about two minutes). It locks 0.4 XMR in the browser against the real daemon, mines the lock to depth, clicks Refund and Yes, and expects HOLD within 30 s; the swap stays NOTICED.

**Diagnosis.** `takerA` returns before it looks at `f.cancel` whenever the lock is good:

```ts
if (lockGood) return now >= d.tReadyMin! ? call({ name: 'set_ready' }, …) : wait('ready-minimum', d.tReadyMin);
…
if (refundable && (f.cancel || now >= d.tCut!)) return call({ name: 'refund' }, 'session', 'A10b', tCo - M);
```

The engine (`apps/web/src/lib/engine.ts`) passes `cancel: true` correctly; the flow drops it. A refund asked for while the lock is still unconfirmed works (that path is covered in `01-happy` on Ethereum and `03-modes-console` on Solana). Suggested fix for the owner: test `f.cancel && refundable` before the `lockGood` branch (and decide whether the same applies to a confirmed lock in READY, where the model has no refund before `T_cd`: there the page should say so instead of offering the button).

**Test.** `scenarios/99-known-failures.test.ts`, reported under "known failures" by `scripts/run.mjs`. It fails the run when the bug stops reproducing.

## Observations (not bugs, or not reproduced; no test attached)

| # | Package | What was seen | Why it is not filed as a bug |
| --- | --- | --- | --- |
| O1 | `apps/web` | While one of two Monero nodes does not answer, the swap page shows "2 of 2 confirmations on every node" directly above "Not counted as confirmed: node-failed: …". | Behaviour is right (the tab does not set ready and refunds at the cutoff: `04-faults-taker`); only the first line's wording claims more than is known. Cosmetic. |
| O2 | `apps/web` | In the large-swap tool, when a leg settles in the same instant the remaining makers' offers have lapsed, the automatic next wave is not retried: the board keeps "Open next wave" until the user clicks. | Documented fallback (web W12). It shows up here because tests jump the chain clock past the 60-second offer validity; a live maker refreshes continuously. The scenario clicks the button when the page leaves it. |
| O3 | `apps/web` | Once, in an early run where every scenario used a fresh browser profile on the same Ethereum wallet, the sell-XMR pay address appeared about two minutes after the maker's funding was mined. | Not reproduced: a dedicated probe (fresh profile, two earlier Ethereum swaps of the same wallet under another seed) showed the address within seconds, and the suite now shows it within seconds on every run. |
| O4 | `packages/daemon` | A daemon started before it is registered on Ethereum raises `eth_quotes_failed: NotRegistered`, which stays in the alert list after registration. | Expected at first start; the alert is a warning and can be acknowledged. |
| O5 | `packages/daemon` | A parked payout is only an alert; the daemon cannot withdraw it. | Documented gap (daemon M2): `withdraw_owed` needs the owner key. `05-faults-maker` withdraws with the owner key. |
