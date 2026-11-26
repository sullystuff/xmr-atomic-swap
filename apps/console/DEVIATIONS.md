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
4. **Saving changes only the edited lines** (`src/lib/config/edit.ts`): comments, layout and keys
   the console does not know stay byte for byte. A file with multi-line values or arrays of
   tables is written afresh instead (values kept, comments lost), and the save bar says so.
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
- **The daemon is the judge of the file** (fix for e2e BUG-2). The console's schema is a second
  copy and will lag: a key it does not know is never an error locally. It is kept untouched,
  listed under "Settings not editable here" with the daemon's verdict, and removable there. A
  save is blocked only by the daemon's own validation; a local finding the daemon does not share
  is shown as a warning. A test reads the daemon's and the rebalancer's schema sources and fails
  when they define a key the console has no control for.
- `[rebalance.venues.exchange.withdraw_keys]` is editable on the Rebalancing page (beside the
  allow-list) and on Configuration. A key without an allow-list entry, or an allow-listed address
  without a key while the exchange is enabled, is a warning. With no allow-list in the file the
  daemon's default list applies, which the console cannot see, so nothing is flagged then.

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

Answered by the daemon in its A11 to A16 and read by the console: upgrade status per chain with
authority, reason and check time; a dry-run published edit refused before it is stored;
`tor.published` and `registry_onion`; `needs_acknowledgement` / `acknowledged` on refills; `mode`
and `instruction` on every swap summary; link history as display addresses with `superseded`;
`sol_usd` and `compute_units_per_update` on validate; one list of ten refusal reasons; the
unsigned transaction for a parked payout.

Still open. None is worked around silently.

Price sources (daemon 99986cf, its A17 and "Price sources"): confirmed and matched. The console
uses the daemon's exact warning and error texts for the conditions it also checks locally (as
warnings; a sentence the daemon reports as an error is shown once, as the error), reads
`source`, `fallbacks`, `cross_check`, `priced_by` and `price_unit` on offers, and shows a pool's
averaging window still filling as "no price yet".

- **"No price yet" is read from `disabled_reason` text** (`the averaging window is not filled yet
  (N of M s)`); a structured field for why `priced_by` is `null` would be sturdier.
- `docs/DESIGN.md` and SPEC 7.2 still state the old cross-check-only rule (the architect's to update).

1. **Nothing on a swap says a payout is parked** (only an alert). The console therefore offers
   "Withdraw parked payout" on every swap page and reports `409 nothing_owed` in place as
   "Nothing is parked for this swap". A `parked` amount on the swap detail would let it show the
   action only where it applies, and name the amount.
2. **Held wXMR has no route** (declined, A15). The console marks stopped bridge refills as needing
   manual action; it cannot tell how much wXMR the wallet actually holds, because no field
   reports it.
3. **`tor.reachable` is always `null`** (the daemon runs no Tor client). The console says "not
   checked by the daemon".
4. On Ethereum the parked-payout transaction is signed by whichever address the balance is keyed
   to; the console shows the daemon's summary naming it, but cannot check the wallet's account
   against it before signing, since the response does not carry that address as a field.
