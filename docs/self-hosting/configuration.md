# Configuration reference

Every setting of the self-hosting bundle, its default and what it does.

## Where settings come from

There is one settings file: `deploy/xmrswap.toml`. It does not exist until you create it; copy `deploy/xmrswap.example.toml`, which lists every setting with its default.

```sh
cp deploy/xmrswap.example.toml deploy/xmrswap.toml
```

For each setting the bundle uses, in this order:

1. the environment variable named in the table, if it is set;
2. the value in the settings file, if the key is there;
3. the default.

Rules that apply to all settings:

- **RPC URLs never go in the file.** They usually contain an API key. The file holds only the *name* of the environment variable to read them from. No command prints an RPC URL.
- **An unknown key is an error**, not ignored: a mistyped name stops the bundle at start with a message naming the key.
- The file has two tables. `[ui]` is the web server and the starting values given to the page. `[relay]` holds exactly the relay's own settings; `[relay.rate_limit]` is a sub-table of it.
- The relay's own `relay.toml` and the `RELAY_CONFIG` variable are not used by the bundle. The `RELAY_*` variables in the table are.

To see what the bundle will actually use, without starting it:

```sh
pnpm --filter @xmrswap/deploy run settings
```

Expected output with no settings file and no variables set (the two directory paths are shown shortened here):

```text
settings file      (none: defaults and environment only)
ui.listen          127.0.0.1:8780
ui.dist            <repository>/apps/web/dist
ui.public_origin   (same as listen)
RPC URLs to page   yes (anyone who can load the page can read them)
Solana RPC URL     NOT SET
Ethereum RPC URL   NOT SET
ethereum chain id  1
contract address   (none)
program id         5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u (pinned by this release)
monero network     mainnet
monero nodes       (none)
relay.bind         127.0.0.1:8787
relay.tor_socks    127.0.0.1:9050
allowed origins    (none: same origin only)
proxies in front   0
rate limit         6000 requests and 1073741824 bytes per minute per client address
monero max reply   16777216 bytes
debug log          off
```

The three tables below are generated from the code and checked by the bundle's tests against the relay's and the page's real settings: a setting that exists in the code cannot be missing here, and nothing listed here can be missing from the code.

<!-- BEGIN GENERATED SETTINGS (pnpm --filter @xmrswap/deploy run docs) -->

## Settings file

| Setting | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `[ui] listen` | `XMRSWAP_UI_LISTEN` | `"127.0.0.1:8780"` | Address the web UI is served on. This is the address you open in the browser. The same server passes /relay/ and /monero/ on to the relay, so the page and the relay share one origin. Keep it on 127.0.0.1 unless you have read the page on exposing the relay publicly. |
| `[ui] dist` | `XMRSWAP_UI_DIST` | `"../apps/web/dist"` | Directory holding the built web UI (index.html and assets). A relative path is taken from the deploy/ directory. Point it at an unpacked release after you have verified its checksums. |
| `[ui] public_origin` | `XMRSWAP_UI_PUBLIC_ORIGIN` | `""` (empty: the origin is http:// followed by `listen`) | The origin the browser uses to reach the UI, for example "https://swap.example.org", when that differs from `listen` (a reverse proxy or a container port mapping). The server answers only requests whose Host header matches `listen` or this origin, and the Monero proxy addresses given to the page are built from it. |
| `[ui] give_page_rpc_urls` | `XMRSWAP_UI_GIVE_PAGE_RPC_URLS` | `true` | When true, the page is given the Solana and Ethereum RPC URLs from your environment as its starting values, so you do not have to type them. Anyone who can load the page can read them, including any API key in them. On your own machine that is only you. Set it to false if other people can load the page; each visitor then enters an RPC URL on the Settings page. |
| `[ui] ethereum_rpc_url_env` | `XMRSWAP_UI_ETHEREUM_RPC_URL_ENV` | `"ETHEREUM_RPC_URL"` | NAME of the environment variable holding the Ethereum RPC URL given to the page. If the variable is not set, the ETH and USDC-on-Ethereum markets are switched off. The URL itself never goes in this file, because provider URLs usually contain an API key. |
| `[ui] ethereum_chain_id` | `XMRSWAP_UI_ETHEREUM_CHAIN_ID` | `1` (pinned by the release; 1 while no contract is deployed) | Chain id the Ethereum RPC must report. The page refuses an RPC that reports another chain. |
| `[ui] contract_address` | `XMRSWAP_UI_CONTRACT_ADDRESS` | `""` (pinned by the release; empty while no contract is deployed) | Ethereum contract address given to the page. Leave it alone unless you are testing: it must equal the published address, and the page shows it for checking. |
| `[ui] monero_network` | `XMRSWAP_UI_MONERO_NETWORK` | `"mainnet"` | Monero network the page expects its nodes to be on: "mainnet", "stagenet", "testnet" or "regtest". |
| `[ui] own_node` | `XMRSWAP_UI_OWN_NODE` | `false` | Set to true only if `monero_nodes` lists exactly one node and you run that node yourself. With false, the page needs two or more nodes and refuses to count a lock as confirmed unless they agree. |
| `[ui] poll_ms` | `XMRSWAP_UI_POLL_MS` | `4000` | How often the page re-reads chain state, in milliseconds (1000 to 60000). Raise it if your Solana RPC provider rate-limits you. A slower page notices the maker's steps later, so do not raise it far. |
| `[relay] bind` | `RELAY_BIND` | `"127.0.0.1:8787"` | Address the relay itself listens on. The browser never calls it directly; the UI server passes requests on to it. Localhost only unless changed on purpose. |
| `[relay] tor_socks` | `RELAY_TOR_SOCKS` | `"127.0.0.1:9050"` | Address of the Tor client's SOCKS5 proxy. 9050 is Tor's standard port; Tor Browser uses 9150. The bundle does not start Tor: it only connects to this address. Onion names are resolved by Tor, never by the relay. |
| `[relay] solana_rpc_url_env` | `RELAY_SOLANA_RPC_URL_ENV` | `"SOLANA_RPC_URL"` | NAME of the environment variable holding the Solana RPC URL. The relay reads the list of makers through it and the page uses it for everything on Solana. There is no default URL: whoever runs the endpoint sees your queries and transactions. Without it the relay forwards nothing and you must type an RPC URL into the Settings page. |
| `[relay] program_id` | `RELAY_PROGRAM_ID` | `"5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u"` (pinned by the release) | The Solana swap program. The relay forwards only to makers registered in it, and the page uses it for every swap. Leave it alone unless you are testing: it must equal the published program id. |
| `[relay] monero_nodes` | `RELAY_MONERO_NODES` | `[]` (none; must be set) | Monero nodes, as http(s)://host[:port] with no path. The relay serves the n-th one at /monero/<n>/ (counting from 0) and the page is told to use those addresses, so the browser can reach plain-http and .onion nodes. Use your own node, or at least two nodes run by different people. A .onion node is reached through Tor. The environment variable takes a comma-separated list. |
| `[relay] monero_max_response_bytes` | `RELAY_MONERO_MAX_RESPONSE_BYTES` | `16777216` (16 MiB) | Largest Monero node response the proxy will carry. A larger response is refused with `upstream_too_large`. |
| `[relay] allowed_origins` | `RELAY_ALLOWED_ORIGINS` | `[]` (none: same-origin only) | Other web origins allowed to call the relay from a browser. Not needed with this bundle, because the page and the relay share one origin. Never use "*" on your own machine: any web page you visit could then use your relay and your Monero nodes. |
| `[relay] trust_proxy_hops` | `RELAY_TRUST_PROXY_HOPS` | `0` | Number of reverse proxies you have put in front of the UI server, whose X-Forwarded-For header is trusted when counting requests per client address. 0 means none. The UI server itself is counted automatically; do not add 1 for it. |
| `[relay] debug_log` | `RELAY_DEBUG_LOG` | `false` | When true the relay logs, for every forwarded request, the client address and the onion address it contacted, and prints a warning at start. Message bodies are never logged. Leave it off. |
| `[relay.rate_limit] requests_per_minute` | `RELAY_RATE_REQUESTS_PER_MINUTE` | `6000` (this bundle's default for one user on localhost; the relay's own default is 60) | Requests one client address may make per minute, counting messages and Monero node calls together. Beyond it the relay answers 429 `rate_limited` until the minute ends. The page checks every lock against every Monero node every few seconds through this relay, which needs far more than a public relay allows a stranger; lower it before exposing the relay publicly. |
| `[relay.rate_limit] bytes_per_minute` | `RELAY_RATE_BYTES_PER_MINUTE` | `1073741824` (1 GiB; this bundle's default for one user on localhost; the relay's own default is 4194304 (4 MiB)) | Bytes (requests and relayed responses together) one client address may move per minute. The final XMR sweep downloads several megabytes from the Monero node in one go. Lower it before exposing the relay publicly. |

## Other environment variables

| Environment variable | What it does |
| --- | --- |
| `XMRSWAP_SELFHOST_CONFIG` | Path of the settings file. Without it, `xmrswap.toml` in `deploy/` is used if it exists; otherwise defaults and environment variables only. |
| `SOLANA_RPC_URL` | The Solana RPC URL (the name can be changed with `[relay] solana_rpc_url_env`). No default. |
| `ETHEREUM_RPC_URL` | The Ethereum RPC URL (the name can be changed with `[ui] ethereum_rpc_url_env`). Optional. |

## Settings in the browser

| Page setting | Page default | Set by this bundle to | What it does |
| --- | --- | --- | --- |
| `solanaRpc` | `""` | the URL in the variable named by `[relay] solana_rpc_url_env`, if set and `[ui] give_page_rpc_urls` is true | Solana RPC URL. Reads the registry and swaps, submits transactions. No default: nothing works until it is set. |
| `ethereumRpc` | `""` | the URL in the variable named by `[ui] ethereum_rpc_url_env`, if set and `[ui] give_page_rpc_urls` is true | Ethereum RPC URL. Empty switches the ETH and USDC-on-Ethereum markets off. |
| `ethereumChainId` | `1` | `[ui] ethereum_chain_id` | Chain id the Ethereum RPC must report. |
| `moneroNodes` | `[]` | one proxy address per entry of `[relay] monero_nodes`: `<origin>/monero/0`, `<origin>/monero/1`, ... | Monero nodes the page checks every XMR lock against. The first one is used for the final sweep. No default: locking is disabled until set. |
| `ownNode` | `false` | `[ui] own_node` | Declares a single configured node to be your own, so one node is accepted. |
| `moneroNetwork` | `"mainnet"` | `[ui] monero_network` | Monero network. |
| `relayUrl` | `""` | `"/"` (the same origin as the page) | Where the relay is: a URL, or a path on the same site. |
| `mode` | `"hosted"` | `"self-hosted"` | Connection mode: `hosted`, `self-hosted`, `tor-direct` or `onchain`. See "Who sees what". |
| `programId` | `"5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u"` | `[relay] program_id` | Solana program id. Pinned by the release and shown for checking. |
| `contract` | `""` | `[ui] contract_address` | Ethereum contract address. Pinned by the release and shown for checking. |
| `minDepth` | `0` | not set (page default) | Your own minimum number of Monero confirmations. 0 uses the protocol tiers only. |
| `refXmrUsd` | `""` | not set (page default) | Your reference XMR price in USD, used to compare offers. The page fetches no price feed. |
| `refSolUsd` | `""` | not set (page default) | Your reference SOL price in USD. |
| `refEthUsd` | `""` | not set (page default) | Your reference ETH price in USD. |
| `theme` | `"system"` | not set (page default) | Appearance: `system`, `light` or `dark`. |
| `pollMs` | `4000` | `[ui] poll_ms` | How often the page re-reads chain state, in milliseconds. Raise it if your RPC provider rate-limits you. |
| `sweepMaxFee` | `""` | not set (page default) | Override of the Monero sweep fee cap, in piconero. Empty uses the protocol cap. For test networks only. |

<!-- END GENERATED SETTINGS -->

## How the file and the browser settings fit together

The page keeps its settings in your browser. The bundle only supplies **starting values**, through a small file the page reads when it loads (`/config.json`, served by the bundle and never written to disk).

This has one consequence you need to know: **once you press "Save settings" in the page, the browser's saved copy wins over the bundle for every setting**, including ones you did not change. If you later edit `deploy/xmrswap.toml` (for example to add a Monero node), also make the change on the page's Settings page, or the page keeps using the old value. The Status page always shows what the page is really using.

The Monero node addresses the page is given look like `http://127.0.0.1:8780/monero/0`. They point at the bundle, which passes the calls on to the nodes you listed in `monero_nodes`, in the same order. The page never learns the real node addresses and they are not shown in the browser.

## Checking that this page is current

```sh
pnpm --filter @xmrswap/deploy run docs --check
```

Expected output:

```text
The settings reference and the example file match the code.
```

Without `--check` the command rewrites the generated tables on this page and `deploy/xmrswap.example.toml`.
