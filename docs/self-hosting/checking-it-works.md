# Checking it works

Do this after the [quick start](quick-start.md) and before every swap that matters. There are two checks that ask the same questions from two places: a command in the terminal, and the Status page in the browser. The Status page is the one that counts, because it tests from where your swap will actually run.

The three things that must be true:

1. **Tor reachable**: the relay can reach its Tor proxy, and through it a maker.
2. **RPC connected**: the Solana RPC answers and knows the swap program.
3. **Monero nodes in agreement**: every node answers and they report the same chain.

## The status command

With the bundle running, in a second terminal:

```sh
pnpm --filter @xmrswap/deploy run status
```

Expected output when everything works (heights, counts and the genesis value will differ):

```text
ok    Web UI served
      http://127.0.0.1:8780/ (status page: http://127.0.0.1:8780/#/status).
ok    Relay reachable
      It knows 1 maker; registry read 5 s ago.
ok    Tor proxy reachable
      The SOCKS proxy at 127.0.0.1:9050 answered a handshake. That alone does not prove Tor has connected to the network; the page's Status page tests a real maker.
ok    Solana RPC connected
      Genesis <genesis hash of the cluster>. Program 5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u found.
off   Ethereum RPC
      Not configured. The ETH and USDC-on-Ethereum markets are switched off.
ok    Monero nodes in agreement
      2 nodes in agreement: node 0 at height 3300000; node 1 at height 3300000.
ok    Program id is the one this release pins
      5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u. Compare it with the published id yourself; see "Verifying the download".

All checks passed.
```

How to read it:

| First column | Meaning |
| --- | --- |
| `ok` | Works. |
| `warn` | Works, but read the line: something needs your attention. |
| `FAIL` | Does not work. Fix it before swapping. |
| `off` | Switched off by your settings, on purpose. |

The command exits with status 0 when nothing is `FAIL`, and 1 otherwise, so you can use it in a script. `pnpm --filter @xmrswap/deploy run status --json` prints the same checks as JSON.

What each line checks:

| Line | What was tested |
| --- | --- |
| Web UI served | The page and its starting settings load from the address you open. |
| Relay reachable | The relay answers through that same address, and has read the list of makers from Solana. |
| Tor proxy reachable | Something answered a SOCKS handshake at `tor_socks`. **This does not prove Tor is connected to the network.** A Tor client that is still starting, or any other SOCKS proxy on that port, passes this check. The Status page's "Maker reachable over Tor" is the real test. |
| Solana RPC connected | The RPC answered, and an executable program exists at the pinned program id on that cluster. |
| Ethereum RPC | If configured: the RPC answered and reports the expected chain id. |
| Monero nodes in agreement | Every node answered through the bundle's proxy; their heights are within one block of each other; nodes at the same height report the same block. |
| Program id | The page is given the program id this release pins. |

"Nodes" are numbered in the order of `monero_nodes` in your settings: node 0 is the first.

## The Status page

Open `http://127.0.0.1:8780/#/status` (or choose "Status" in the page's menu). The page runs its checks from your browser and shows one row for each. Nothing is reported to anyone.

At the top you want to see **"Everything needed for a swap is reachable"**. If instead it says "1 problem to fix before swapping" (or more), the rows marked "Problem" say what is wrong. Locking stays disabled while Solana or the Monero nodes cannot be checked.

The rows, and what a healthy one says:

| Row | Healthy | What it proves |
| --- | --- | --- |
| Solana RPC connected | OK | The page can read the chain and its clock. |
| Swap program found | OK | The program at the pinned id is initialised on this cluster. |
| Ethereum RPC | OK, or Off if you set none | As above for Ethereum. |
| Monero nodes in agreement | OK: "2 nodes in agreement: ..." | The same rule as the command, checked from the browser. |
| Relay reachable | OK: "It knows N makers; registry read N s ago" | The page found your relay on its own address. |
| Tor proxy reachable | OK | The relay's SOCKS proxy answered. A handshake only. |
| Maker reachable over Tor | OK: "Maker ... answered through the relay and Tor" | **The real Tor test**: a request went through your relay and Tor to a registered maker's onion service and the right maker answered. It shows "Off" when no registered maker lists an onion address. |
| Solana program: still upgradable / immutable | Attention while upgradable | Whether the project owner can still change the program. "Upgrade status unknown" means it could not be read; treat that as upgradable. |
| Ethereum contract: ... | The same, for the contract | |

Below the rows, "This browser" shows whether the page can keep the screen on, whether notifications are allowed, whether your clock agrees with the chain, and the program id and contract address in use. Compare those two with the published values: see [Verifying the download](verifying-the-download.md).

After changing anything, press **"Check again"**.

## A quick check without the page

The relay's own status, through the address the page uses:

```sh
curl -s http://127.0.0.1:8780/relay/v1/status
```

```text
{"tor_ok":true,"registry_age_secs":4,"makers":1,"monero_nodes":[{"ok":true,"height":3300000},{"ok":true,"height":3300000}]}
```

`tor_ok` is the SOCKS handshake only. `registry_age_secs` is how long ago the maker list was read; with no Solana RPC set, the relay has no list and `makers` stays 0. `monero_nodes` lists your nodes in order.

## When something is not ok

Every failing line says what to do. [Troubleshooting](troubleshooting.md) covers each case in more detail.
