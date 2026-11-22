# Safe defaults

What the bundle does without being asked, why, and what it cannot protect you from. If you intend to let other people use your relay, read [Exposing the relay publicly](exposing-the-relay.md) instead of changing these one by one.

## What is on by default

| Default | Why |
| --- | --- |
| The web UI listens on `127.0.0.1:8780` and the relay on `127.0.0.1:8787`. | Only programs on your own machine can connect. Nothing is reachable from your network or the internet. |
| The page and the relay share one address (one origin). | The relay sends no cross-origin (CORS) headers, so a web page from any other site cannot call your relay or your Monero nodes from your browser. |
| The server answers only requests addressed to its own name (`127.0.0.1:8780`, `localhost:8780`). | A web site that points its own domain name at `127.0.0.1` to reach local services gets `421 bad_host`. |
| The relay forwards only to onion addresses of makers currently registered in the pinned Solana program. | It cannot be used as a general proxy into Tor. |
| The relay passes on only a fixed list of read-only Monero node calls, plus sending a transaction. | The page cannot be used to control your node. |
| No message log. The relay prints a start line and warnings; it never logs message bodies, onion addresses or client addresses. | There is nothing to leak or hand over later. |
| No default Solana RPC, Ethereum RPC or Monero node. | Whoever runs them sees your queries, so the choice is yours and nothing is contacted until you make it. |
| RPC URLs are read from environment variables and never printed. | Provider URLs usually contain an API key. |
| The program id and contract address are the ones the release pins. | A page pointed at another program could take your funds. The status command warns if they differ. |
| The bundle never starts, stops or reconfigures Tor. | Your Tor client stays under your control. |
| The page makes no third-party requests: no price feed, no analytics, no fonts, no wallet connectors loaded from elsewhere. | Nobody else learns that you opened it. |
| The page carries a strict Content-Security-Policy and the server adds headers that forbid framing and content-type guessing. | Limits what injected content could do. |
| Per-client limits on the relay: 6000 requests and 1 GiB per minute. | Stops a runaway loop. These are sized for one person on localhost; they are **not** suitable for a public relay. |

You can confirm several of these yourself while the bundle runs. A request with a foreign name is refused:

```sh
curl -s -H 'Host: evil.example' http://127.0.0.1:8780/
```

```text
{"error":"bad_host"}
```

A forward to an onion address that is not a registered maker is refused:

```sh
curl -s -X POST -H 'content-type: application/json' -d '{"onion":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion","method":"GET","path":"/xs/v1/info"}' http://127.0.0.1:8780/relay/v1/forward
```

```text
{"error":"onion_not_listed"}
```

A Monero node call that is not on the list is refused:

```sh
curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"0","method":"stop_daemon"}' http://127.0.0.1:8780/monero/0/json_rpc
```

```text
{"error":"monero_method_not_allowed"}
```

## What the defaults do not protect

- **Other programs and other users on the same machine.** Anything running on your computer can connect to `127.0.0.1:8780` and `127.0.0.1:8787`. It could use your relay and your Monero nodes, and it could read `http://127.0.0.1:8780/config.json`, which contains your Solana and Ethereum RPC URLs including any API key in them. Do not run the bundle on a machine you share with people you do not trust.
- **Your RPC provider and remote Monero nodes.** They see what you ask them. See [Who sees what](who-sees-what.md).
- **A compromised browser or extension.** The keys for a swap live in the page. A malicious browser extension with access to the page can read them.
- **A modified copy of the software.** Verify what you downloaded: see [Verifying the download](verifying-the-download.md).
- **The contracts.** They are unaudited and still upgradable by the project owner.
- **You closing the tab.** The page warns you; it cannot stop you.

## Settings that weaken the defaults

Leave these alone unless you know exactly why you are changing them.

| Setting | Risk when changed |
| --- | --- |
| `[ui] listen` or `[relay] bind` set to anything other than a `127.` address | The bundle becomes reachable from other machines. See [Exposing the relay publicly](exposing-the-relay.md). |
| `[relay] allowed_origins = ["*"]` | Any web page you visit can use your relay and your Monero nodes from your browser. Never do this. |
| `[ui] give_page_rpc_urls = true` (the default) on a page other people can load | Every visitor can read your RPC URLs and any API key in them. |
| `[relay] debug_log = true` | The relay starts logging client addresses and the onion addresses they contact. |
| `[relay] program_id` or `[ui] contract_address` changed | The page and relay follow a different program or contract. A wrong one can take your funds. |
| `[ui] own_node = true` when the node is not yours | The page trusts a single stranger's node to tell it whether a lock exists. |
