# Troubleshooting

Find the message you see, in the status command's output or on the page's Status page. Run the status command first; it names most problems directly:

```sh
pnpm --filter @xmrswap/deploy run status
```

One thing to keep in mind throughout: **a refund never depends on the relay, on Tor or on the bundle's messaging.** It goes from the page straight to the chain through your Solana or Ethereum RPC. What a refund does need is the tab open and the RPC reachable.

## Tor unreachable

**What you see.** The status command prints:

```text
FAIL  Tor proxy not reachable
      Nothing answers as a SOCKS proxy at 127.0.0.1:9050. Start a Tor client or set [relay] tor_socks. Until then messages fall back to on-chain (Solana swaps only).
```

The Status page shows "Tor proxy not reachable: The relay cannot reach its Tor proxy. Messages fall back to on-chain."

**What it means.** No Tor client is listening where the relay looks for one. The bundle does not start Tor.

**What to do.** Start a Tor client, or point `tor_socks` at one that is running. The three ways are in the quick start under [Tor](quick-start.md#tor). No restart of the bundle is needed; press "Check again".

### The fallback to on-chain messaging

While Tor is unreachable (or the relay is down, or a maker lists no onion address), the page sends its messages to makers through the Solana program instead. You do not switch this on; it happens by itself. Know what changes:

- **It works for Solana swaps only.** Ethereum swaps need a key proof that is fetched through the relay or from a maker's HTTPS endpoint, so without Tor they may not be available.
- **Each message costs a transaction fee**, paid from your wallet.
- **Who messaged whom, and when, becomes public** on-chain. The content stays encrypted.
- Your Solana RPC provider sees the messages being posted.

To use only this path on purpose, choose "On-chain only" under "Connection mode" on the Settings page.

### "Tor proxy reachable" but "No maker reachable over Tor"

The SOCKS port answered, but a request to a maker did not get through. Most often Tor is still connecting to the network: wait a minute and press "Check again". If you ran `tor` yourself, wait for `Bootstrapped 100% (done)` in its output. It can also mean that the makers tried are offline, or that the port belongs to some other SOCKS proxy that is not Tor.

"Maker reachable over Tor: Off" is not an error: no registered maker lists an onion address, so there is nothing to test.

## RPC rate limits

**What you see.** Any of:

```text
FAIL  Solana RPC problem
      the endpoint is rate-limiting you (HTTP 429).
```

```text
warn  Relay reachable, but it has not read the maker list
      The registry has not been read yet. If this stays, the Solana RPC is refusing getProgramAccounts or rate-limiting; until then every forward is refused and messages fall back to on-chain.
```

On the page: an empty offer list, "Solana RPC unreachable" on the Status page, or an alarm sound and a notification during a swap. The relay's own output may show `registry refresh failed`.

**What it means.** Your RPC provider is refusing some requests. The page re-reads chain state every few seconds, and both the page and the relay list accounts with `getProgramAccounts`, which many free endpoints limit heavily or refuse outright.

**What to do.**

- Use an endpoint that allows `getProgramAccounts`. This is a hard requirement: without it the page cannot list makers or offers and the relay cannot build its maker list.
- Use a paid plan, or your own Solana node. Your own node is also the only way to keep your queries to yourself.
- Slow the page down: `[ui] poll_ms` (default 4000 milliseconds) controls how often the page re-reads state. A slower page notices the maker's steps later, so do not raise it far. If you have already saved settings in the page, the browser's copy wins; see the last rows of the table under "Other messages".
- **Do not start a swap on an endpoint that is rate-limiting you.** During a swap the page must be able to read the chain and send a refund in time. If the connection drops while a swap is open, the page sounds an alarm and shows the time left; fix the connection (or enter a different RPC URL on the Settings page) before that time runs out.

If the message is `the endpoint refused the request (HTTP 401)` or `(HTTP 403)`, the API key in your RPC URL is wrong or expired.

## A Monero node out of sync, or nodes disagreeing

The page counts an XMR lock as confirmed only if **every** node you configured answers and they agree. Anything else is treated as "not confirmed". This is deliberate: a single node that lies or lags could otherwise make the page believe in a lock that is not there, and you would pay for nothing.

**A node is behind.**

```text
FAIL  Monero nodes
      The nodes are 10 blocks apart: node 0 at height 3300000; node 1 at height 3299990. One of them is out of sync or on another chain; locks will not count as confirmed until they agree.
```

The lower one is still synchronising, or has stalled. If it is yours, wait for it to catch up (`A node reports it is still synchronising` is the milder form of this). If it is someone else's, replace it with another node.

**Nodes disagree.**

```text
FAIL  Monero nodes
      Nodes at the same height report different blocks: node 0 at height 3300000; node 1 at height 3300000. They are on different chains; locks will not count as confirmed.
```

Two nodes at the same height report different blocks. A difference that lasts one check can be an ordinary short-lived fork: check again after a few minutes. If it persists, one node is on a different network (check `monero_network`) or is not honest. Remove it. Do not lock anything until the nodes agree.

**A node does not answer.**

```text
FAIL  Monero nodes
      node 1 did not answer (HTTP 502 upstream_unreachable). While a node is unreachable no lock counts as confirmed.
```

`HTTP 502 upstream_unreachable` means the bundle could not reach that node: wrong address, node down, or, for a `.onion` node, Tor not working. `HTTP 429 rate_limited` means the relay's own per-client limit was reached; see the table below.

**Only one node.** `Only one node is configured and it is not marked as your own`: add a second node run by someone else, or, if the node really is yours, set `own_node = true` under `[ui]`.

**During a swap.** If the nodes stop agreeing while you are waiting for a lock to confirm, the page keeps waiting and, if they still do not agree a safe margin before the deadline, refunds by itself. Keep the tab open. Do not replace a node mid-swap unless one is clearly dead.

## Other messages

| What you see | Cause | Fix |
| --- | --- | --- |
| `cannot start: an address is already in use` | Another copy is running, or another program uses port 8780 or 8787. | Stop the other copy, or change `[ui] listen` / `[relay] bind`. If you change `listen`, see the note on addresses in [Backups and upgrades](backups-and-upgrades.md). |
| `cannot start: no built web UI in ...` | The interface has not been built. | Build it (needs Rust and wasm-bindgen, see the quick start) or point `[ui] dist` at a verified release. |
| `wasm-bindgen CLI is "..."; this build needs 0.2.130` during a build | Wrong or missing `wasm-bindgen-cli`. | Install exactly that version; the message prints the command. |
| `configuration error: ... unknown key "..."` | A mistyped setting name. | Compare with `deploy/xmrswap.example.toml`. |
| `configuration error: ... expected the NAME of an environment variable` | An RPC URL was put in the settings file. | Put the URL in the environment variable instead; the file holds only the variable's name. |
| `{"error":"bad_host"}` in the browser | You opened the page by a name the server does not answer to, such as the machine's network address. | Open `http://127.0.0.1:8780/`. To serve another name on purpose, see [Exposing the relay publicly](exposing-the-relay.md). |
| Status page: "Relay not reachable ... must be started with RELAY_ALLOWED_ORIGINS" | The page's relay setting points at a relay on a different address than the page. | On the Settings page set "Relay URL" to `/`. With the bundle, the relay is always on the page's own address. |
| `rate_limited` or `HTTP 429` from your own relay | The per-client limit was reached, usually because `[relay.rate_limit]` in your file is set to the relay's small public values. | Remove those two keys from `deploy/xmrswap.toml` to get the bundle's defaults, or raise them. |
| `upstream_too_large` on a Monero call | A node response was larger than `monero_max_response_bytes`. | Raise `[relay] monero_max_response_bytes`. |
| `FAIL Solana RPC connected, but the program is not there` | The RPC is for a different cluster, or the program id is wrong, or (in this version) nothing is deployed. | Check the RPC URL's cluster and the program id: [Verifying the download](verifying-the-download.md). |
| A setting changed in `deploy/xmrswap.toml` has no effect in the page | You saved settings in the page before; the browser's copy wins. | Make the same change on the page's Settings page. See [Configuration reference](configuration.md#how-the-file-and-the-browser-settings-fit-together). |
| The page is empty after moving to a new port or to `localhost` | Browser storage is separate for each address. | Open the old address, or load your recovery file at the new one. See [Backups and upgrades](backups-and-upgrades.md). |

## Running your own Monero node

Through the bundle (the normal setup) your node needs no special options: list it in `monero_nodes` and the bundle calls it for the page.

Only if you enter your node's address **directly** on the page's Settings page, bypassing the bundle, must the node allow calls from the page's address. Not run on the machine where this was written:

```sh not-run
monerod --rpc-access-control-origins http://127.0.0.1:8780
```

A page served over HTTPS additionally cannot call a plain `http://` node unless it is on localhost; use the bundle's proxy for that.
