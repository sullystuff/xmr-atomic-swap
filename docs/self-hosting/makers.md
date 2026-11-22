# For makers

A maker offers XMR for SOL, ETH or USDC (or the reverse) and completes swaps automatically. This page is about running the maker's two programs on the maker's own machine. It is separate from the rest of this guide: takers do not need any of it.

The same warnings apply, with more at stake: the software is unaudited, the contracts are still upgradable by the project owner, and a maker's machine holds keys that can spend the maker's funds.

## What you run

| Program | What it does |
| --- | --- |
| The daemon (`packages/daemon`) | Always on. Publishes your offers, watches both chains and Monero, locks XMR, claims payments, handles refunds, and keeps the durable state of every swap. It holds your hot keys. |
| The console (`apps/console`) | A web page for configuring and watching the daemon. It holds no keys and talks only to your daemon. |
| `monero-wallet-rpc` and a Monero node | Your XMR inventory and your view of the Monero chain. |
| A Tor client (optional) | Lets takers reach you over an onion service instead of on-chain messages. You run it; the daemon does not start it. |

**Run all of it on a machine you control.** No hosted site ever holds maker keys, and none should be given them. The daemon's API and the console listen on `127.0.0.1` only. To use the console from another computer, use an SSH tunnel; do not expose the port.

## Running the daemon

The daemon reads one TOML file. `docs/DESIGN.md` ("Maker configuration") describes the settings and contains example files. Secrets are never in the file: every key ending in `_env` names an environment variable that holds the secret.

**1. Check a configuration without starting anything.** Give the file's full path:

```sh
pnpm --filter @xmrswap/daemon run config:check /full/path/to/maker.toml
```

It prints every error and warning, the terms each enabled offer would actually have, and what keeping the offers refreshed costs per day. The last lines for the example file in `docs/DESIGN.md`:

```text
offer    usdc_sol sell_xmr: mode auto, approval window 60 s, notice 600 s, claim delay 101 min (bound 101 min), claim window 30 min, final 7 d, deposit 0 bps, depth 2 from 0 XMR, 10 from 1 XMR, 25 from 50 XMR
offer    sol sell_xmr: mode auto, approval window 60 s, notice 600 s, claim delay 101 min (bound 101 min), claim window 30 min, final 7 d, deposit 0 bps, depth 2 from 0 XMR, 10 from 1 XMR, 25 from 50 XMR
cost     one update every 15 s: 5000 lamports each, 0.0288 SOL per day
ok       10 warning(s)
```

Read every warning. A line starting with `error` means the daemon would refuse to start.

**2. Start in dry-run mode first.** `mode = "dry_run"` under `[daemon]` is the default: the daemon computes and shows offers and decisions but sends no transaction and moves no XMR. Run it this way until what it shows is what you intend. Not run on the machine where this was written (it needs a Solana RPC, a Monero node and a wallet):

```sh not-run
export XMRSWAP_KEYSTORE_PASSPHRASE='<a long passphrase>'
export SOLANA_RPC_URL='<your Solana RPC URL>'
export MONERO_WALLET_RPC_URL='<your monero-wallet-rpc URL>'
pnpm --filter @xmrswap/daemon start /full/path/to/maker.toml
```

It prints where its API listens and where the access token is:

```text
xmrswap-daemon dry_run: API on http://127.0.0.1:7071 (token in <data directory>/api-token)
```

**3. Go live** by setting `mode = "live"` under `[daemon]` and restarting, once the dry run looks right.

### Settings that need a restart

Most settings take effect when you save them, from the console or by editing the file. These do not: a change is saved, logged and raises an alert, and takes effect only at the next start.

- Everything under `[solana]`, `[ethereum]` and `[monero]` (endpoints, the program id, the contract address, wallet connection), except the Solana priority fee and the Ethereum finality setting.
- Everything under `[daemon]` (data directory, API address, keystore passphrase variable, console directory), except `mode` and the list of allowed web origins.
- Keys.

Restarting is safe at any time in the sense that no swap state is lost (see "Restarts" below), but it is not free: a daemon that is down can miss a deadline.

## Running the console

Build the console once, then let the daemon serve it from its own address, so that the console and the API share an origin and nothing else can call the API from a browser. Not run on the machine where this was written (the console was already built there):

```sh not-run
pnpm --filter @xmrswap/console build
```

In the maker file, under `[daemon]`, name the built directory:

```toml
[daemon]
console_dir = "/full/path/to/apps/console/dist"
```

Restart the daemon and open `http://127.0.0.1:7071/`. The console asks for the access token: it is the contents of the `api-token` file in the daemon's data directory. That file is created on first start and is readable only by you. Anyone with the token can control the daemon, so treat it like a password.

## Keys

| Key | Where it is | What it can do |
| --- | --- | --- |
| **Owner key** (one per chain) | **Not on the daemon's machine.** Keep it cold: a hardware wallet or an offline machine. | Registers the maker, links the Solana and Ethereum identities, sets the payout address, replaces the operator key. The console builds these transactions for you to sign with the owner wallet; the daemon never sees the key. |
| **Operator keys** (Solana and Ethereum) | In `keystore.json` in the daemon's data directory, encrypted with the keystore passphrase. | Publish offers, approve, post notices, claim. They also pay for the escrows of buy-XMR offers, so whatever balance they hold can be committed by anyone who steals them. |
| **Key-share seed** | In the same `keystore.json`. | Derives the maker's half of the key of every swap's XMR. |
| **Message encryption keys** | In the daemon's database, encrypted; rotated on your schedule. | Decrypt takers' messages. |
| **Monero wallet** | In `monero-wallet-rpc`'s own wallet files. | Spends your XMR inventory. |
| **Keystore passphrase** | In the environment variable named by `keystore_passphrase_env` (default `XMRSWAP_KEYSTORE_PASSPHRASE`). | Unlocks `keystore.json`. |
| **API token** | `api-token` in the data directory. | Full control of the daemon through its API. |

Practical rules:

- Keep only working balances on the operator addresses, and set `paying_caps` under `[liquidity]`. A stolen operator key can commit the balance it finds.
- Never put the owner key on the daemon's machine.
- The database is tied to one maker identity and one inventory wallet at first start and refuses to open against others. Do not copy a data directory to run a second maker.

## Backups

Back up, from the daemon's data directory (`data_dir`, default `./data` next to the maker file):

| What | Why | When |
| --- | --- | --- |
| `keystore.json` **and its passphrase**, stored separately | Without both, the maker's half of every open swap's XMR key is gone, and with it the XMR in those swaps. | Once, right after the first start, and again if you ever replace an operator key. |
| The Monero wallet's seed words or wallet files | Your inventory. | Once, when the wallet is created. |
| The maker file (`maker.toml`) | Your settings. | When it changes. |
| `daemon.sqlite` | Per-swap records: prepared transactions, intents, message keys, history. | See below. |
| The owner keys | Control of your registration. | Once; keep them offline. |

About the database: the daemon is built so that the chain plus the keystore are enough to finish or refund every swap after a restart, and the database holds what makes that exact (which transaction was already sent, prepared Monero transactions). **Restoring an old copy of the database over a newer one is dangerous**: the daemon would believe that things it already sent were never sent. Back it up for disaster recovery, but after restoring one, start in `dry_run` mode and resolve everything the daemon parks as "needs review" before going live. Never run two daemons from copies of the same data directory.

Do not back up the `api-token` file to shared storage; it is recreated if missing.

## Restarts and upgrades

On start the daemon reconciles before it quotes anything: it reloads every unfinished swap, compares it with the chain, looks up every transaction it had sent, re-checks its XMR locks, recomputes every deadline and acts at once on any that are due. A stopped daemon's offers expire by themselves within their validity time, so takers cannot lock against a daemon that has been down for longer than that.

To upgrade: pause new swaps from the console, wait until no swap is open, stop the daemon, update and rebuild, run `config:check` against the new version, start in `dry_run`, look at the dashboard, then go live. If you cannot wait for open swaps to finish, keep the downtime short and read the next section first.

## What a missed deadline costs

The daemon has to act inside time windows. If it is down, cut off from its RPC or its Monero node, or out of fee money when a window closes, this is what happens.

| What was missed | When you sell XMR (the taker pays SOL, ETH or USDC) | Cost to you |
| --- | --- | --- |
| Approving a pending lock inside your approval window | The taker gets a full refund. | No funds. Counted in your public approval rate. |
| Posting the lock notice by the notice deadline, after approving | The taker gets a full refund, with nothing withheld. | No funds. **A public fault** (`missed_notices`) on your record. |
| Claiming after the taker set ready, before your claim deadline | The taker refunds everything, with nothing withheld. You get your XMR back, because the refund reveals the taker's half of the key. | You lose the trade, pay Monero fees, your XMR is tied up until you sweep it back. **A public fault** (`missed_claims`). |

| What was missed | When you buy XMR (you escrow SOL, ETH or USDC; the taker sends XMR) | Cost to you |
| --- | --- | --- |
| Funding the escrow by the deadline after a taker takes your offer | The take lapses; the taker's small deposit is returned. | No funds. **A public fault** (`missed_funds`) outside window mode. |
| **Checking the taker's XMR lock, then either setting ready or refunding, before your deadline** | A taker who never really locked the XMR can claim your escrow once the deadline passes. | **You can lose the whole escrowed amount.** This is the daemon's hardest deadline, and the maker's version of a taker closing the tab at the wrong moment. |

In every case the record is public and permanent. Takers choose makers by it: missed deadlines, withhold rates and completed volume are shown beside your offers. A maker that was provably late also cannot withhold the taker's deposit for that swap.

What reduces the risk:

- Run the daemon on a machine that stays up, with a Solana RPC and Monero nodes you can rely on. Configure fallback RPC URLs.
- Keep fee balances topped up; the console shows the fee runway and alerts when it is short.
- Use the pause switch before planned downtime, and wait for open swaps to finish.
- Size `max_in_flight_xmr` and `paying_caps` to what you can afford to have at risk at once.
- Answer alerts. Anything the daemon is unsure about is parked as "needs review" and waits for you; it is never re-sent blindly.

## Tor for makers

With on-chain messaging the daemon needs no inbound connection and no Tor. To also accept messages over Tor, enable `[tor]` in the maker file and add an onion service to **your own** Tor client's configuration. The daemon prints the two lines to add:

```sh
pnpm --filter @xmrswap/daemon exec tsx src/cli.ts tor print-torrc /full/path/to/maker.toml
```

```text
HiddenServiceDir /var/lib/tor/xmrswap-maker
HiddenServicePort 80 127.0.0.1:7072
```

Adding them to your Tor configuration and reloading Tor is done by you, the way your system manages Tor; the daemon does not change Tor's configuration.
