# Exposing the relay publicly

Everything else in this guide keeps the relay on `127.0.0.1`, for you alone. This page is for the different case where you run a relay, and perhaps the page, **for other people**. Do not follow it just to reach your own bundle from another of your devices; use an SSH tunnel or a VPN for that and keep the bundle on localhost.

## What you take on

Read this before deciding.

- **Your users have to trust you.** You will see each user's IP address, which maker they contact, and the size and timing of their messages. You cannot read, change or forge the messages, move funds, or block a refund. Say this to your users in plain words; [Who sees what](who-sees-what.md) has the table.
- **If you also serve the page, your users run your code.** A changed page could take their funds. Publish the checksums of what you serve so users can compare ([Verifying the download](verifying-the-download.md)), and tell them they can run the bundle themselves instead.
- **You will be a target.** A public relay is a public service that reaches into Tor.
- The software is unaudited.

## Requirements

The four relay rules of the design are requirements for a public relay. Each one says what you must do and how to check it.

### 1. Forward only to registered makers

The relay must not be an open proxy. It forwards only to onion addresses listed by maker accounts in the Solana program, and only to the protocol's own paths.

- Leave `[relay] program_id` at the pinned value and give the relay a working Solana RPC URL. Without an RPC the relay knows no makers and refuses everything.
- Do not put a second, more permissive proxy in front of it that forwards other paths to Tor.
- If the relay cannot refresh the maker list for 10 minutes it refuses every forward until it can. That is intended.

Check, from outside, that an unregistered onion address is refused (shown here against a local bundle; use your public address):

```sh
curl -s -X POST -H 'content-type: application/json' -d '{"onion":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion","method":"GET","path":"/xs/v1/info"}' http://127.0.0.1:8780/relay/v1/forward
```

```text
{"error":"onion_not_listed"}
```

### 2. Enforce the size cap and per-address rate limits

The size caps are built in and cannot be switched off: 16,384 bytes for a message, 60,000 bytes for a key proof, 96 kB for any request.

The rate limits are yours to set, and **the bundle's defaults are wrong for a public relay**: they are sized for one person on localhost. For a public relay:

- Set `[relay.rate_limit] requests_per_minute = 60` and `bytes_per_minute = 4194304` (the relay's own defaults), or lower.
- Set `[relay] trust_proxy_hops` to the number of reverse proxies in front of the bundle (1 for the usual single reverse proxy). If it is too low, every user shares one budget, because the relay sees only your proxy's address. If it is too high, a user can forge the `X-Forwarded-For` header and get a fresh budget on every request.
- Make sure your reverse proxy **appends** the client address to `X-Forwarded-For` rather than passing through what the client sent as-is.
- Decide whether to serve Monero nodes at all. With the public limits above, the Monero proxy is too slow for a page to follow a swap, and whoever uses it is trusting your node. The simplest safe choice is `monero_nodes = []` on a public relay; users then name their own nodes on the Settings page.

Check: send more requests in a minute than the limit from one address and confirm you get `429` with `{"error":"rate_limited"}` and a `Retry-After` header, while a second address is still served.

### 3. Keep no message logs

- Leave `[relay] debug_log = false`. With it on, the relay logs every client address together with the onion address it contacted.
- Turn off access logging in your reverse proxy for `/relay/` and `/monero/`, or you have rebuilt the same log one layer up.
- Do not keep packet captures or per-request metrics that record client addresses.

Check: read your relay's output and your reverse proxy's logs after some traffic. Neither should contain an onion address or a client address.

### 4. Let the interface fall back

If your relay is down or refuses a request, the page falls back to on-chain messaging for Solana swaps. You do not configure this, but do not work against it:

- Answer errors promptly. Do not hold connections open or serve an error page with status 200.
- Do not promise your users availability the relay cannot give. A refund never depends on the relay: it goes from the user's browser straight to the chain.

## Other things you must do

- **Serve it over HTTPS.** Put a reverse proxy that terminates TLS in front of the bundle and keep the bundle itself on `127.0.0.1`. Browsers refuse to let an HTTPS page call a plain-HTTP relay.
- **Tell the bundle its public address.** Set `[ui] public_origin = "https://swap.example.org"` (your own address, no path, no trailing slash). The server answers only requests whose Host header is `listen` or this origin.
- **Keep the relay's own port closed.** Leave `[relay] bind = "127.0.0.1:8787"`. Only the UI server needs to reach it.
- **Serving only a relay for a page hosted elsewhere:** set `[relay] allowed_origins` to that page's exact origin, for example `["https://swap.example.org"]`. Never `"*"`.
- **Do not hand your RPC URL to visitors.** By default the page is given the Solana and Ethereum RPC URLs from your environment, which on a public page means every visitor can read them, including any API key. Set `[ui] give_page_rpc_urls = false`. The relay keeps using the Solana RPC to read the maker list; each visitor enters their own RPC URL on the Settings page. The start command prints a warning if you forget.
- **Run your Tor client as a client only.** It needs no inbound ports.

## Example reverse proxy

A minimal nginx server block. Not run on the machine where this was written; adapt it and test it:

```nginx
server {
    listen 443 ssl;
    server_name swap.example.org;
    # ssl_certificate and ssl_certificate_key go here.

    access_log off;                                  # requirement 3

    location / {
        proxy_pass http://127.0.0.1:8780;
        proxy_set_header Host swap.example.org;      # must equal the host of [ui] public_origin
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # appends the client address
        client_max_body_size 128k;
    }
}
```

With this in front, the matching settings are:

```toml
[ui]
public_origin = "https://swap.example.org"
give_page_rpc_urls = false

[relay]
trust_proxy_hops = 1
monero_nodes = []

[relay.rate_limit]
requests_per_minute = 60
bytes_per_minute = 4194304
```

After any change, run through the checks under each requirement again from a machine outside your network.
