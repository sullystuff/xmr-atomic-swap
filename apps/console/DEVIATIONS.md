# WP9 maker console: deviations, interpretations and requests

Built to `docs/SPEC.md` 8.1 against the frozen `@xmrswap/protocol` daemon-API types, with a mock
daemon (`src/mock/`, `server/`) standing in for WP8. Nothing outside `apps/console/` was edited.

## Deviations from the specification

1. **WebSocket authentication.** A browser cannot set an `Authorization` header on a WebSocket and
   the frozen types do not say how `WS /api/ws` is authenticated. The console sends the bearer
   token as `?token=` on the socket URL; the mock accepts that or the header. The daemon must
   accept one browser-usable form (query parameter or subprotocol).
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
- The mock refuses chain-sending actions in dry run with `409 dry_run`, answers an invalid PUT
  with `422 invalid_config`, a stale `base_revision` with `409 revision_conflict`. These codes are
  the mock's choice; the real daemon's are not specified.

## Requests against WP1 / WP8 (not in the frozen API)

- A route to edit **contact channels and the onion address** (`set_contacts`, `set_onion`); the
  console can only display them.
- **Link history** (`LinkChanged` events) so the identity-link trace can list past changes; today
  only `current`, `pending` and `pending_effective_at` are available.
- **Acknowledge** routes for alerts and for failed or held refills (`Rebalancer.acknowledge`,
  `resolveHeld`), and a way to redeem held wXMR.
- A **SOL/USD price** field: the dollar figure for a draft is derived from the last estimate's
  `daily_usd ÷ daily_lamports`.
- Per-chain **owner-pause state** (status has one `paused.owner` flag for both chains).
- `ApiError` carries one `detail` string; a structured list of `ConfigIssue` on a refused PUT or
  import would let the console place every daemon-side error on its field.
- CORS headers (or serving the built console from the daemon's own origin) when the console is
  not same-origin; `pnpm dev:daemon` proxies `/api` instead.
