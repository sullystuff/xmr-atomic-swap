# Configuration reference

<!-- BEGIN GENERATED SETTINGS (pnpm --filter @xmrswap/deploy run docs) -->

## Settings file

| Setting | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `[ui] listen` | `XMRSWAP_UI_LISTEN` | `"127.0.0.1:8780"` | Address the web UI is served on. This is the address you open in the browser. The same server passes /relay/ and /monero/ on to the relay, so the page and the relay share one origin. Keep it on 127.0.0.1 unless you have read the page on exposing the relay publicly. |
| `[ui] dist` | `XMRSWAP_UI_DIST` | `"../apps/web/dist"` | Directory holding the built web UI (index.html and assets). A relative path is taken from the deploy/ directory. Point it at an unpacked release after you have verified its checksums. |
| `[ui] public_origin` | `XMRSWAP_UI_PUBLIC_ORIGIN` | `""` (empty: the origin is http:// followed by `listen`) | The origin the browser uses to reach the UI, for example "https://swap.example.org", when that differs from `listen` (a reverse proxy or a container port mapping). The server answers only requests whose Host header matches `listen` or this origin, and the Monero proxy addresses given to the page are built from it. |
| `[ui] ethereum_rpc_url_env` | `XMRSWAP_UI_ETHEREUM_RPC_URL_ENV` | `"ETHEREUM_RPC_URL"` | NAME of the environment variable holding the Ethereum RPC URL given to the page. If the variable is not set, the ETH and USDC-on-Ethereum markets are switched off. The URL itself never goes in this file, because provider URLs usually contain an API key. |
| `[ui] ethereum_chain_id` | `XMRSWAP_UI_ETHEREUM_CHAIN_ID` | `1` (pinned by the release; 1 while no contract is deployed) | Chain id the Ethereum RPC must report. The page refuses an RPC that reports another chain. |
| `[ui] contract_address` | `XMRSWAP_UI_CONTRACT_ADDRESS` | `""` (pinned by the release; empty while no contract is deployed) | Ethereum contract address given to the page. Leave it alone unless you are testing: it must equal the published address, and the page shows it for checking. |
| `[ui] monero_network` | `XMRSWAP_UI_MONERO_NETWORK` | `"mainnet"` | Monero network the page expects its nodes to be on: "mainnet", "stagenet", "testnet" or "regtest". |
| `[ui] own_node` | `XMRSWAP_UI_OWN_NODE` | `false` | Set to true only if `monero_nodes` lists exactly one node and you run that node yourself. With false, the page needs two or more nodes and refuses to count a lock as confirmed unless they agree. |
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
| `solanaRpc` | `""` | the URL in the variable named by `[relay] solana_rpc_url_env`, if set | Solana RPC URL. Reads the registry and swaps, submits transactions. No default: nothing works until it is set. |
| `ethereumRpc` | `""` | the URL in the variable named by `[ui] ethereum_rpc_url_env`, if set | Ethereum RPC URL. Empty switches the ETH and USDC-on-Ethereum markets off. |
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
| `pollMs` | `4000` | not set (page default) | How often the page re-reads chain state, in milliseconds. Raise it if your RPC provider rate-limits you. |
| `sweepMaxFee` | `""` | not set (page default) | Override of the Monero sweep fee cap, in piconero. Empty uses the protocol cap. For test networks only. |

<!-- END GENERATED SETTINGS -->
