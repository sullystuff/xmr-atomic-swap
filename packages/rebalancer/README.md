# @xmrswap/rebalancer

Venue adapters for refilling a maker's inventory, and the routing, limits and safety controls
that drive them (SPEC 7.7, DESIGN "Liquidity rebalancing and refills"). Used by the maker
daemon only; none of it runs in the console's browser.

Nothing here holds a key, opens a connection of its own, or moves funds except through the
daemon's `ExecContext`:

| Dependency | Injected as | In tests |
| --- | --- | --- |
| Venue HTTP APIs, Jupiter | `HttpClient` | Fixture clients; no network path |
| Solana reads | `SolanaRpc` (`connectionRpc(connection)` in the daemon) | In-memory accounts |
| Sending SOL, USDC, ETH, XMR; signing | `ExecContext` | A recording fake |
| Reference prices | `PriceSource` | Fixed prices |
| API credentials | Environment variable **names** (`api_key_env`, `api_secret_env`), read at call time | A fake reader |
| Reserve-proof verification | `ReserveProofVerifier` (the maker's own Monero node) | A fake |

## Use

```ts
const { settings, warnings } = parseRebalanceToml(tomlText);            // DESIGN's example parses unchanged
const { adapters } = createAdapters({ settings, allowlist, http, prices, solanaRpc, solanaWallet, store });
const rebalancer = new Rebalancer({ settings, adapters, prices, allowlist, now, costLog, state, onAlert });
await rebalancer.init();

await rebalancer.run({ from: 'usdc_sol', to: 'xmr', amountIn, rate: 'float', payoutAddress, refundAddress }, ctx);
await rebalancer.tick(ctx);          // poll: progress, completions, test-transfer follow-ups, stalls, retries
await rebalancer.approve(id, ctx);   // approve mode
```

## Adapters

| Venue | Status | Confidence |
| --- | --- | --- |
| `wxmr_bridge` | Refill (USDC or SOL to XMR) and reverse. Jupiter exact-in in pieces sized against pool depth, wXMR measured from the swap's own token balances, `request_withdrawal` for exactly that, tracking to the Monero txid, `cancel_withdrawal` for stalls, heartbeat and reserve-proof checks, fee and authorities read from chain. | Encodings follow `BRIDGE-ASSUMPTIONS.md`; **not yet checked against the owner-supplied IDL** (`vendor/wxmr_bridge.json` is absent), nor against the deployed program. |
| `exchange` | Deposit, trade, withdraw as a restart-safe state machine over a thin driver. One driver: Kraken. | Request signing matches Kraken's published example. Everything else is from the docs and unverified live. |
| `changenow` | Quote (standard and fixed-rate), limits, create, status, continue/refund for held orders. | Endpoints from the research; response fields unverified live. XMR is on the public currency list. |
| `fixedfloat` | Signed requests, quote, limits, create, status, emergency continue/refund, local rate budget. | Same. XMR pairs appear in the public rates export. |
| `stealthex` | Quote, limits, create, status (`verifying` is the hold state). | **XMR support unconfirmed** (the API currency list needs a key). **Disabled by default**; enabling it warns. |
| `houdiniswap` | Quote, limits, create by `quoteId`, numeric statuses. | **XMR as a payout token unconfirmed**; field names are the least certain. **Disabled by default**; enabling it warns. |

Every fixture under `test/fixtures/` is hand-written from public documentation; none is
recorded. Before a venue is enabled for real, re-read its terms and currency list and record
real responses.

All instant-swap adapters and the exchange accept `usdc_sol` to `usdc_eth` and back; the
`Rebalancer` routes those only when `[rebalance.cross_chain]` is on.

Before funds are sent, an instant-swap order is abandoned (it then expires unfunded) if the
service recorded a payout address other than the one asked for, asks for more than the quote
plus 0.5%, or wants a deposit memo.

## What the `Rebalancer` enforces

- **Address allow-list.** Payouts and refunds only to the maker's own XMR, SOL and ETH
  addresses; an empty list allows nothing. Checked on every request, again just before
  execution, and again inside every adapter built by `createAdapters`.
- **Caps.** `max_per_tx_usd`, `max_per_day_usd` (rolling 24 hours), per-venue versions of both,
  and each venue's `max_share_pct` of the daily cap. A larger refill is cut to fit.
- **In-transit cap.** `max_in_transit_usd` across all venues, counted from before the first
  send until the refill finishes; held refills and unacknowledged failures keep counting.
- **Cost limit.** `max_cost_pct` against the reference price, per venue or global. A refill is
  skipped when every venue exceeds it.
- **Routing.** `priority` (first venue that qualifies) or `best_quote` (lowest total cost).
- **Test transfer.** A venue/address pair that has never completed a refill gets
  `test_transfer_usd` first; the rest follows when it arrives.
- **Modes.** `auto`, `approve` (queued; approval re-prices and re-checks everything), `alert`
  (alert only), per venue.
- **Stalls and failures.** Past `stalled_redeem_minutes` (bridge) or `venue_timeout_minutes`, a
  refill is cancelled where the venue allows, the venue cools down for `cooldown_minutes`, and
  the refill is retried on the next venue. A send whose outcome is unknown is never repeated.
- **Cost log.** Every finished refill: venue, rate, quoted and measured cost, fees, times,
  transaction ids. `measuredCostPct(entries)` is the value-weighted figure for the offer engine.

## Bridge specifics

- The withdrawal nonce is `max(last + 1, now in ms)`, saved and journalled **before** the
  request is sent; a re-send uses the same nonce, so it cannot create a second withdrawal.
- A redemption can be cancelled only while `Pending` and at least 300 s old; once the bridge
  marks it `Sending` it can never be cancelled. A cancel returns wXMR (not USDC) and the bridge
  keeps its fee; `redeemHeld` sends that wXMR to redemption again.
- `authorities()` returns the program's upgrade authority and the config authority for the
  daemon to show before first use.
- Refills are public: bridge records link the Solana wallet to the Monero address, amount and
  time.

See `BRIDGE-ASSUMPTIONS.md` for the assumed program interface and `DEVIATIONS.md` for every
departure from the specification.
