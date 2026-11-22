# Running the swap interface on your own machine

This guide shows how to run the complete taker web interface yourself: the page, the relay that connects it to Tor, and the checks that tell you it works. Running it yourself is a fully supported way to use the software, not a fallback.

## Read this first

- **The software is unaudited.** Nobody independent has reviewed the contracts, the cryptography or this bundle. Use amounts you can afford to lose.
- **The contracts can still be changed by the project owner.** The Solana program and the Ethereum contract launch upgradable, and the project owner holds the upgrade key. Until that key is given up, you are trusting the key holder not to change the rules; a malicious upgrade could take funds held in a swap. The Status page shows the current state.
- **Closing the tab at the wrong moment can lose your funds.** Every step that moves money runs in your browser. No server can finish or refund a swap for you. If the tab is closed, the computer sleeps, or the connection drops while the page says "Do not close this tab", a dishonest maker can end up with your payment. Putting a laptop to sleep, shutting the lid, or a phone switching apps all count as closing the tab.
- **Nothing is deployed to a live network yet.** This version pins a development program id and no Ethereum contract address. The pages below describe how the bundle behaves; they do not tell you where a live deployment is.

## Why run it yourself

When you use somebody else's site, that site's operator sees your IP address, sees which maker you contact and when, and controls the code your browser runs. When you run the bundle on your own machine, the page comes from your own disk and the relay and the Tor client are yours, so nobody on the relay side learns your IP address or your message timing.

Running it yourself does **not** hide you from your Solana RPC provider or from the Monero nodes you use, unless those are also yours. [Who sees what](who-sees-what.md) lists this for each way of running the interface.

## What you run

| Part | What it does | Needed |
| --- | --- | --- |
| Web UI (static files) | The interface. All cryptography runs in your browser. | Yes |
| Relay | Passes encrypted messages between the page and makers' onion services, and gives the page a way to reach your Monero nodes. | Only for the Tor channel and for Monero nodes the browser cannot call directly |
| Tor client | The proxy the relay sends through. **You start it; the bundle never starts or changes Tor.** | Only for the Tor channel |
| Solana RPC endpoint | Reads the list of makers and your swaps; submits your transactions. | Yes: your own node, or a provider |
| Monero nodes | Used to check that the maker really locked the XMR. | Yes: your own node, or at least two nodes run by different people |

One command starts the web UI and the relay together, both on `127.0.0.1`.

## Pages

| Page | What it covers |
| --- | --- |
| [Quick start](quick-start.md) | What to install, the one command, the address to open |
| [Configuration reference](configuration.md) | Every setting, its default and its effect |
| [Safe defaults](safe-defaults.md) | What the bundle does out of the box to keep you safe, and what it cannot protect |
| [Exposing the relay publicly](exposing-the-relay.md) | Requirements if you let other people use your relay |
| [Who sees what](who-sees-what.md) | What each party learns, for each way of running the interface |
| [Verifying the download](verifying-the-download.md) | Checksums, and checking the program id and contract address |
| [Checking it works](checking-it-works.md) | The status command and the Status page |
| [Troubleshooting](troubleshooting.md) | Tor unreachable, RPC rate limits, Monero nodes out of sync or disagreeing |
| [Backups and upgrades](backups-and-upgrades.md) | Where your swap state lives; upgrading without losing a swap in progress |
| [For makers](makers.md) | Running the daemon and the console on your own machine |

## How to read the commands

Commands are run from the top directory of the repository unless a page says otherwise. A block marked "Not run on the machine where this was written" is a command the authors could not run there (for example, anything that needs Docker, a real Tor network connection or a real node); treat it as a starting point and check it against that tool's own documentation.
