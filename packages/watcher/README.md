# @xmrswap/watcher

A small always-on service that watches swaps for someone who cannot stay online, and pauses a swap when the other side's Monero lock is false or missing. It is the watcher of `docs/SPEC.md` section 11.6 (Amendment 1, work package A5). This page is for the person who runs one.

## What it does

In a swap, one party (the *locker*) escrows SOL, USDC or ETH, and the other locks XMR in a joint address and posts an encrypted *lock notice*. If the locker is offline when a false notice is posted, the other side can take the escrow after a delay. An offer with a freeze window lets the locker name one *watcher key* when it locks. That key can do exactly one thing on that one swap: call `freeze`, once. A freeze reveals nothing and moves nothing. It only postpones the other side's claim to a later time (`T_ff`), so the locker has hours or days, not about one hour, to come back and refund.

This service is that key, running on a machine that stays up:

1. The locker's client names this service's key in its `lock` (or, for a maker selling for XMR, in its `fund`), then posts the swap's *notice key* here.
2. The service checks on chain, at finality, that the swap exists, names its key and is still open, and that the request was made by that swap's locker. Only then does it store the watch and answer with a signed acknowledgement.
3. It follows the swap. When a notice appears it decrypts it with the notice key, derives the joint view key, and verifies the Monero lock against your Monero nodes.
4. It sends `freeze` when the notice does not open its commitment, or when the lock is not confirmed on every node at the cut-off time `T_cut`. It never sends later than `T_co − M`, the last moment a freeze can still land.
5. It stops when the swap is ready, frozen or settled, and deletes that swap's notice key.

The decision itself is the SDK's pure `watcherStep`; this package is the service around it and adds no rule of its own.

## What it sees

For each swap it watches, the service learns: which swap it is, its amount and timing (all public on chain), and, through the notice key, the Monero transaction that pays the joint address, that address and the amount. Whoever runs a watcher for other people sees this for every swap they hand over. The taker UI says so before anyone opts in.

It stores much less than it sees: the chain, the swap reference, where the watch stands, and the freeze transactions it sent itself. It does not store amounts, parties, Monero transaction ids, addresses or view keys. The notice key is stored encrypted under the keystore and deleted when the watch ends. A finished watch's record is deleted after `retention_days`.

It never logs a request body, a notice key or an RPC URL. With `debug_log = true` it also logs swap references and client IP addresses, and prints a warning that it does.

## What it can and cannot do

It can:

- call `freeze` once on a swap that names its key, while that swap is in the noticed state and before `T_co`;
- spend its own small fee balance doing so, within the limits you set.

It cannot, by construction:

- move, receive or redirect anyone's funds. `freeze` moves nothing, and a watcher key is never a recipient;
- refund, set ready, claim or abort. The key holder in this package (`src/keys.ts`) has no "sign this" method: it signs a transaction only after checking that it is one `freeze` of the named swap on the pinned program or contract, within the fee bounds. A wrong or dishonest RPC endpoint cannot get any other signature out of it. The service does not use the SDK's general `send` (which can carry any call): it builds the freeze, has the guard sign it, writes the signed bytes to its journal, and only then broadcasts them;
- block or delay the locker's own `refund` or `set_ready`, or extend a swap past its final deadline;
- recover XMR. It holds no spend share and no encryption secret of any swap, and it does not derive one.

## What it costs when it is wrong, and when it is down

**It can be down.** A watcher that is down, out of fee balance, cut off from its endpoints or started too late does nothing, and the locker is exactly where it would be without a watcher: if the notice was false and the locker does not return in time, the locker loses its payment. The acknowledgement is a promise to try, not a guarantee. Watch `status` and keep the fee keys funded.

**It can freeze wrongly.** It freezes when it cannot confirm a lock at `T_cut`. That includes a lock that is merely slow, and the case where your Monero nodes are down or disagree with each other (see below). A wrong freeze costs:

- the other side a delay of at most the offer's freeze window `W_z` before it can claim without a ready signal;
- the locker nothing if it returns, sees the lock is good and sets ready: the swap then completes normally. If the locker instead refunds after a freeze, its deposit can be withheld by the maker (direction A), which is how makers price the longer option.

If the locker never returns, the other side claims at `T_ff` and the swap completes; nobody loses funds to a wrong freeze.

**Two Monero nodes that disagree.** The rule is the spec's (2.11 and 11.6): a lock counts as confirmed only when every configured node returns the transaction in the same block; any disagreement or unreachable node means "not confirmed". Before `T_cut` that means *wait*. At `T_cut` it means *freeze*. The service fails closed in the direction that protects the locker's funds: a freeze is cheap and the locker can undo it, an unfrozen false lock is a total loss. The price is that a watcher whose Monero nodes are broken freezes every swap that reaches `T_cut`. Run reliable nodes, and check `monero.agreeing` in the health output.

**Only the locker can register a swap.** A watch request (wire format 2) is sealed to this watcher and authenticated with the locker's encryption key that the swap itself records on chain: the taker's one-time key when the taker is the locker, the maker's key when the maker is. The service reads the swap first and opens the request against that key, so a request made by anyone else does not open. That includes the counterparty, who knows the notice key too. Such a request is refused with `not_the_locker`; nothing is stored and nothing is spent. The request is also bound to the chain, to the program or `chainId:contract`, to the swap, to this watcher's key and to an `issued_at` time, so it cannot be replayed anywhere else. There is one key per swap. A swap whose locker never registers is simply not watched.

Each request must be fresh: not older than `request_max_age_secs` (an hour), and not dated further ahead of the chain clock, or further behind the swap's lock time, than `request_clock_skew_secs` (30 minutes). Posting the same request twice is harmless and returns the same acknowledgement. A newer request from the locker replaces the one on file; an older one arriving after it is refused with `superseded`. The first, unauthenticated format is refused with `unsupported_format`.

## Running it

Requirements: Node 22, a Solana and/or Ethereum RPC endpoint, and two or more Monero nodes run by different people (or exactly one node that is your own).

```sh
pnpm install
pnpm --filter @xmrswap/watcher build

cp packages/watcher/watcher.example.toml /etc/xmrswap/watcher.toml   # then edit it
export WATCHER_PASSPHRASE='a long passphrase'    # seals the keystore; keep it out of shell history
export SOLANA_RPC_URL='https://…'                # never written to the config file or the log
export ETHEREUM_RPC_URL='https://…'

node packages/watcher/dist/cli.js pubkey --config /etc/xmrswap/watcher.toml
node packages/watcher/dist/cli.js start  --config /etc/xmrswap/watcher.toml
node packages/watcher/dist/cli.js status --config /etc/xmrswap/watcher.toml
```

(`pnpm --filter @xmrswap/watcher start` runs the same `start` from source with `tsx`, reading `./watcher.toml` or `WATCHER_CONFIG`.)

- **`pubkey`** prints the two keys a swap names as watcher: a Solana key and an Ethereum address. They are generated on the first `start` or `pubkey` and stored sealed under the passphrase in `<data_dir>/watcher-keystore.json` (mode 0600). Notice keys are sealed to the Solana key and acknowledgements are signed with it, whichever chain the swap is on.
- **Fund both keys** with a small fee balance and nothing else: SOL on the Solana key, ETH on the Ethereum address. A freeze costs about 5,000 lamports, or about 80,000 gas. The service reserves the worst case per open watch (on Ethereum: 98,250 gas at `max_fee_per_gas_gwei`) and refuses new watches, with `insufficient_fee_balance`, when the balance cannot cover every open watch plus one. Never keep more on these keys than you are willing to lose with the machine.
- **`start`** runs until SIGINT or SIGTERM. It refuses to start against an endpoint of another chain id or (when `genesis_hash` is set) another cluster. If an endpoint is merely down it starts anyway and retries.
- **`status`** asks the running service for its health and prints the number of watches by state from the local database. Exit code 0 means running and healthy.

Every setting is documented in [`watcher.example.toml`](./watcher.example.toml). The ones to think about:

| Setting | Why it matters |
| --- | --- |
| `bind`, `allow_non_loopback` | The service listens on loopback and refuses any other address unless you allow it. Lockers reach it over HTTPS: put a TLS reverse proxy or an onion service in front, and set `trust_proxy_hops` so the per-IP limits see real addresses. |
| `[monero] nodes`, `own_node` | Two or more independent nodes, or one of your own. Broken nodes cause wrong freezes. |
| `[solana] program_id`, `[ethereum] contract`, `chain_id` | Pinned by you from the release. The service signs only for these. |
| `per_swap_limit_*`, `per_day_limit_*`, `max_fee_per_gas_gwei` | The most it will ever spend. A freeze that would exceed a limit is not sent, and the watch records why it missed. |
| `max_swaps`, `[rate_limit]` | Capacity and abuse limits. |
| `request_max_age_secs`, `request_clock_skew_secs` | How fresh a watch request must be. The skew has to cover how far the finalized clock runs behind real time (about 15 minutes on Ethereum). |
| `retention_days` | How long finished watches stay in the database. |

Back up the data directory (the keystore is the identity lockers named; the database holds the open watches). Losing either while swaps are open leaves those swaps unwatched.

## The API

All routes are unauthenticated and rate-limited per client IP. No route lists watches.

| Route | Answer |
| --- | --- |
| `GET /watch/v1/info` | `{ solana, ethereum, max_swaps, monero_nodes, chains }`: the keys to name as watcher, and which chains this instance serves. |
| `POST /watch/v1/swaps` with `{ v: 2, chain, swap_ref, deployment, issued_at, notice_key }` | `200 { swap_ref, watching_until, sig }` once the watch is on disk. `notice_key` is the SDK's `sealNoticeKey` (format 2), base64; `deployment` is the program id, or `chainId:contract`. `sig` is Ed25519 by the Solana key (`verifyWatchAck`). The SDK's `WatcherClient.register` does all of this. |
| `GET /watch/v1/swaps/<swap_ref>` | `{ swap_ref, chain, status, reason, waiting_for, watching_until, freeze_decided, freeze_transactions, last_checked_at, accepted_at, ended_at }`, or 404. |
| `GET /watch/v1/health` | Endpoint reachability, chain time, fee balance, the reserve per freeze and how many freezes the balance covers, today's spend, and whether the Monero nodes answer and agree. 503 when something is wrong. |

Refusals of a watch request, by `error`:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request`, `bad_notice_key` | Not a watch request. |
| 400 | `unsupported_format` | Not wire format 2 (the first format carried no proof of its sender). |
| 400 | `chain_not_served`, `wrong_deployment` | This instance has no endpoint for that chain; or the request is bound to another program or contract. |
| 400 | `stale_request` | `issued_at` is too old, ahead of the chain clock, or older than the swap. Make a new request. |
| 403 | `not_the_locker` | The request was not made by this swap's locker for this watcher and swap. |
| 404 | `not_watchable` | No swap at finality names this watcher under that reference. |
| 409 | `swap_ended`, `too_late` | Ready, frozen or settled already; or too little of the freeze window is left. |
| 409 | `superseded` | A newer request for this swap is already on file. |
| 413 | `too_large` | Body over `max_body_bytes`. |
| 429 | `rate_limited` | With `Retry-After`. |
| 503 | `insufficient_fee_balance` | The fee balance (or the per-swap limit) cannot cover another watch; `detail` says which. |
| 503 | `full`, `chain_unavailable` | At `max_swaps`; or the chain endpoint did not answer. |

A watch ends in one of three states, with a reason in plain words:

| `status` | Meaning |
| --- | --- |
| `frozen` | The swap is frozen on chain and this watcher sent the freeze. |
| `not_needed` | The locker set ready, the swap ended, the locker froze it itself, or the lock stayed confirmed through the whole window. Nothing was sent. |
| `window_missed` | A freeze was due, or the swap could not be judged, and nothing landed before the window closed. `reason` says why (endpoint unreachable, fee above the limit, a spend limit, started too late). This is the state to alert on. |

## How it survives a restart

State is one SQLite file (`<data_dir>/watcher.sqlite`, write-ahead log, full sync). The decision to freeze is written before a transaction is built, and the signed transaction is written before it is broadcast. After a crash at any point the next start reads the journal, looks the transaction up on chain, and rebroadcasts the same bytes if it is not there. It builds a new transaction only when the old one can no longer land (Solana: the chain is past the last valid block height of its blockhash) or, on Ethereum, as a replacement at the same nonce with a higher fee, so that at most one is ever mined. The chain accepts one freeze per swap; the journal makes sure the service pays for one.

## Tests

```sh
pnpm --filter @xmrswap/watcher test              # unit tests on the SDK fakes, plus the real program (svm-rpc) and contract (anvil)
pnpm --filter @xmrswap/watcher test:integration  # the same service with real XMR on the Monero regtest (needs XMR_BIN; takes /tmp/xmrswap-integration.lock)
```

Everything runs on loopback. Nothing in this package reads `solana config`, a CLI wallet or a default endpoint.
