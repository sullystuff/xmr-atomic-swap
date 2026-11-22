# Quick start

This page gets the interface running on your own machine and tells you which address to open. Read [the warnings](README.md#read-this-first) first: the software is unaudited, the contracts are still upgradable by the project owner, and closing the tab at the wrong moment can lose your funds.

## Prerequisites

You need:

1. **Node.js 22** (22.21 or later, below 23) and **pnpm 9.15.0**. Check them:

   ```sh
   node --version
   pnpm --version
   ```

   Expected output (your Node patch version may be higher):

   ```text
   v22.21.0
   9.15.0
   ```

2. **The source code**, as a checkout of this repository, [verified](verifying-the-download.md) if you downloaded an archive.

3. **A built web UI.** Either of:
   - a release directory whose checksums you have verified (see [Verifying the download](verifying-the-download.md)); or
   - a build from source. The page's cryptography is compiled from Rust to WebAssembly, so a build from source also needs the Rust toolchain named in `rust-toolchain.toml` with the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` version 0.2.130. The start command builds the UI for you if it is missing and those tools are present.

   Not run on the machine where this was written (the tools were already installed there):

   ```sh not-run
   rustup target add wasm32-unknown-unknown
   cargo install wasm-bindgen-cli --version 0.2.130 --locked
   ```

4. **A Solana RPC URL.** Your own node, or a provider. There is no default, on purpose: whoever runs the endpoint sees your queries and transactions. The endpoint must allow `getProgramAccounts` (some free public endpoints refuse it).

5. **Monero nodes.** One node you run yourself, or two or more nodes run by different people. There is no default. A single dishonest node could show the page a lock that does not exist.

6. **A Tor client**, if you want messages to go over Tor. Without one the interface still works and sends messages on-chain instead (see [below](#tor)).

Docker is not needed. A container setup is provided for people who prefer one; see [With containers](#with-containers).

## The one command

Install the dependencies once:

```sh
pnpm install --no-frozen-lockfile
```

Give the bundle your Solana RPC URL through the environment. The URL is treated as a secret because provider URLs usually contain an API key: it never goes in a settings file, and no command prints it.

```sh
export SOLANA_RPC_URL='<your Solana RPC URL>'
```

Copy the example settings and name your Monero nodes in the copy:

```sh
cp deploy/xmrswap.example.toml deploy/xmrswap.toml
```

In `deploy/xmrswap.toml`, find `monero_nodes` under `[relay]` and list your nodes, for example:

```toml
monero_nodes = ["http://127.0.0.1:18081"]
```

If that one node is your own, also set `own_node = true` under `[ui]`. With two or more nodes leave `own_node` as it is.

Now start the web UI and the relay:

```sh
pnpm --filter @xmrswap/deploy start
```

Expected output:

```text
[relay] listening on 127.0.0.1:8787; Tor SOCKS proxy 127.0.0.1:9050; 2 Monero node(s)

NOTICE: this software is unaudited. The contracts can still be changed by the project owner.
        Closing the tab at the wrong moment during a swap can lose your funds.

Web UI and relay are running. Open this address in your browser:

    http://127.0.0.1:8780/

Status page:  http://127.0.0.1:8780/#/status
Status check: pnpm --filter @xmrswap/deploy run status

Tor: a SOCKS proxy answers at 127.0.0.1:9050. (Whether Tor has connected to the network shows on the Status page.)

Press Ctrl-C to stop. Do not stop it while a swap is in progress: the page reaches your
Monero nodes through this server and cannot confirm a lock without it.
```

If something is missing, the same output says so in plain words: "Solana RPC: not set", "Monero nodes: none set", or the Tor guidance shown [below](#tor). The server still starts, so you can open the page and read its Status page.

## The local address to open

Open **`http://127.0.0.1:8780/`** in a desktop browser.

- Use exactly this address every time. The browser keeps your settings and swap data separately for each address, so `http://localhost:8780/` and `http://127.0.0.1:8780/` are two different, empty stores. See [Backups and upgrades](backups-and-upgrades.md).
- The server answers only on this machine. Other devices on your network cannot reach it.
- You need a Solana wallet extension that supports the Wallet Standard (current Solana wallets do). The page does not bundle wallet connectors that load code from third parties.

Then go to [Checking it works](checking-it-works.md) before you swap anything.

## Tor

The bundle never starts, stops or reconfigures a Tor client. It connects to the SOCKS port named by `tor_socks` (default `127.0.0.1:9050`) and nothing more. If nothing answers there, the start command prints:

```text
Tor: nothing answers as a SOCKS proxy at 127.0.0.1:9050.
  The UI still works without it: messages to makers fall back to on-chain
  (Solana swaps only; each message costs a transaction fee and who messaged whom is public).
  This command never starts or changes a Tor client. To use the Tor channel, do one of:
    - start the Tor service your system already has (its SOCKS port is normally 127.0.0.1:9050);
    - run your own copy, no root needed:
        tor --SocksPort 127.0.0.1:9050 --DataDirectory "$HOME/.local/share/xmrswap-tor"
    - keep Tor Browser open and set [relay] tor_socks = "127.0.0.1:9150".
  No restart is needed: the relay tries the proxy again on every request.
```

Your three options, in more detail:

- **A Tor service is already installed.** Start it the way your system starts services. Its SOCKS port is normally `127.0.0.1:9050`, which is the bundle's default.
- **Run your own copy.** Install the `tor` package, then run it as your own user in a second terminal. Not run on the machine where this was written (it would connect to the real Tor network):

  ```sh not-run
  tor --SocksPort 127.0.0.1:9050 --DataDirectory "$HOME/.local/share/xmrswap-tor"
  ```

  Wait until it prints `Bootstrapped 100% (done)`.
- **Tor Browser is running.** It provides a SOCKS port at `127.0.0.1:9150` while it is open. In `deploy/xmrswap.toml` set `tor_socks = "127.0.0.1:9150"` under `[relay]` and restart the bundle.

You do not need to restart the bundle after starting Tor.

## Start it at login

`deploy/systemd/xmrswap-selfhost.service` is an example systemd user unit. It is only an example: nothing installs it for you, and it does not start Tor. Read the comments at the top of the file, adjust the paths, and put your RPC URLs in `~/.config/xmrswap/env` (readable by you only). Not run on the machine where this was written:

```sh not-run
mkdir -p ~/.config/systemd/user ~/.config/xmrswap
cp deploy/systemd/xmrswap-selfhost.service ~/.config/systemd/user/
chmod 600 ~/.config/xmrswap/env
systemctl --user daemon-reload
systemctl --user enable --now xmrswap-selfhost.service
```

## With containers

`deploy/compose.yaml` runs the same two programs, plus a Tor client, in containers. The UI is published on `127.0.0.1:8780` only.

**This path has not been run.** The machine this bundle was written on has no Docker. The compose file is checked by the tests as a document (valid YAML, valid against `deploy/compose.schema.json`, ports bound to localhost only), but the images have never been built. Expect to fix small things. Not run on the machine where this was written:

```sh not-run
SOLANA_RPC_URL='<your Solana RPC URL>' RELAY_MONERO_NODES='<node URL>,<node URL>' docker compose -f deploy/compose.yaml up --build
```

Things to know before you try it:

- The first build compiles the Rust core and can take a long time.
- A Monero node running on the same machine is not `127.0.0.1` from inside a container. Use an address the container can reach.
- Here the Tor client is part of the bundle and is started by Docker, in its own container with no published port.

## Stopping

Press Ctrl-C in the terminal where the bundle runs. **Do not stop it while a swap is in progress**: the page reaches your Monero nodes through this server, and it cannot confirm a lock without it.
