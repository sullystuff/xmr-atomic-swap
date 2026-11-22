# WP9 maker console: deviations, interpretations and requests

Built to `docs/SPEC.md` 8.1 against the frozen `@xmrswap/protocol` daemon-API types, with a mock
daemon (`src/mock/`, `server/`) standing in for WP8. Nothing outside `apps/console/` was edited.

## Deviations from the specification

1. **WebSocket authentication.** The console sends the bearer token as `?token=` on the socket
   URL, which the real daemon accepts (its A1).
2. **Tailwind.** Tailwind 4 is loaded (`@import 'tailwindcss'`, SPEC 8) but the console's own
   component classes in `src/styles.css` carry the design; few utilities are used.
3. **Light theme.** SPEC 8 names orange on near-black; the work order also asks for light. Dark is
   the default design, light follows the system setting or the top-bar choice.
4. **Saving from the form rewrites the file.** The form serialises the parsed configuration, so
   comments of a hand-edited file are lost on a form save. Import and export keep the file byte
   for byte. The UI says so.
5. **No Playwright test.** SPEC 9.1 lists Playwright "for the warning gates", which are taker-UI
   gates; the WP9 acceptance command is vitest plus build, and all console tests are vitest with
   Testing Library (jsdom), plus one loopback HTTP/WebSocket test of the mock server.
6. **Ethereum owner signing.** `POST /api/registration/submit` takes a signed raw transaction, but
   common browser wallets refuse `eth_signTransaction`. The console tries it, explains a refusal,
   and always offers a paste box for a transaction signed offline (also the natural path for a
   cold key). It never asks a wallet to broadcast. Wallet signing was tested with fake wallets
   only, never with a real extension.

## Interpretations

- **Priority fee.** `[solana].priority_fee_microlamports` is read as micro-lamports per compute
  unit. For the instant estimate it is converted with an assumed limit of 24,120 CU for
  `refresh_offers` (20,100 measured × 1.2, SPEC 4.9); the daemon's `lamports_per_update` for the
  same draft replaces the assumption as soon as `POST /api/config/validate` answers.
- **Move-triggered updates.** Maximum = 86,400 ÷ max(update interval, minimum refresh interval).
  The expected count is the daemon's `triggered_per_day.expected`, floored at one refresh per
  shortest `offer_valid_seconds` among enabled offers (an idle offer must still be refreshed).
- **"Deepest tier in use"** for the claim-delay bound: a depth tier counts when its threshold is
  at or below the offer's largest swap (`max_xmr`, default the largest ladder size).
- **Ethereum market without a blob endpoint.** The console refuses to switch one on (8.1); a file
  that already enables one imports with the warning of 7.2 and the market is shown as kept off.
- **Defaults not stated in 7.2** and assumed: `withhold_policy = "never"`, `monero.own_node`,
  `rebalance.routing.schedule` as free text, `liquidity.targets` as a table per asset.
- **Dry run** exists twice in 7.2 (`[daemon].mode` and `[guardrails].dry_run`); the console shows
  both and treats either as dry run.
- **Unknown keys are errors**, as in the daemon's strict schema; the keys it added
  (`console_dir`, `cors_origins`, `maker_owner`, `subscriptions`, `from_block`, `sweep_max_fee`,
  `eth_pool_size`, `ladder_headroom_pct`, `[registration].contacts`) are in the form.

## Brought in line with the real daemon (packages/daemon/DEVIATIONS.md, A1 to A10)

The client and the mock follow the daemon: `?token=` sockets; its error codes, with `issues` on a
refused configuration placed on their fields; `PUT /api/registration/published`,
`GET /api/registration/links`, `POST /api/alerts/:id/ack`, `POST /api/rebalance/ack/:id`;
`status.paused.chains`; `sol_usd` and `compute_units_per_update` in the cost estimate; SHA-256
revisions; actions offered by the daemon's own state rule. Every operator action shows its
outcome where it was given (carried out, pending with the instruction shown on the swap, refused
with the reason and what happens instead) and is disabled when the known state says it would be
refused. The daemon's `test/api-contract.test.ts` passes against this client.

The mock's seams for outcomes (`chainSays`, `holdTransaction`, `landTransaction`) are test
devices; the real refusals come from the SDK flows.

## Requests to the daemon

Behaviour that looks wrong or leaves the console unable to do what DESIGN asks. None is worked
around silently.

1. **Upgrade status is always `null`** (its M4). DESIGN requires the UI to state whether the
   contracts are still upgradable; against the real daemon the console can only say "unknown,
   treat as upgradable". Please read the Solana upgrade authority and the proxy admin.
2. **`PUT /api/registration/published` in dry run** stores the wanted contacts and onion address
   and then answers `409 dry_run`. The console reports "Not published", yet the edit is kept and
   goes out when the daemon turns live. Refuse before storing, or answer 200 with "saved, not sent".
3. **`tor.published` is always `false` and `tor.reachable` always `null`**, so the Status page
   shows a listed onion address as "Not published".
4. **A failed refill has no "acknowledged" flag** in `RefillView`: after `POST /api/rebalance/ack`
   the console cannot tell and keeps offering Acknowledge (the in-transit total does drop).
5. **Swap summaries carry neither `mode` nor `instruction`** (list and WebSocket). In lists the
   console therefore cannot pre-disable a reject of a Solana take outside window mode, nor hold
   other actions while an instruction is pending; both work on the swap's own page.
6. **Refusal reasons differ between documents**: the work order lists `cannot-exit-after-funding`;
   the daemon lists `not-available-in-state` and `dry-run` instead. The console has words for all
   ten and shows the daemon's `detail` for any other.
7. **Link history is raw bytes** (`0x` hex for Solana keys too) with no marker for an entry that
   was superseded before it took effect; the console converts 32-byte values to base58.
8. `POST /api/config/validate` carries no `sol_usd`; the draft estimate uses the price from
   `GET /api/fees` or `GET /api/offers`.
9. Still missing: a route to redeem held wXMR, and `withdraw_owed` for a parked payout (its M2
   says this is left to the console, but no unsigned-transaction action exists for it).
