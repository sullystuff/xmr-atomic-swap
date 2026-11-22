# Backups and upgrades

Where the things you must not lose are kept, what to back up, and how to upgrade the bundle without losing a swap that is in progress.

## Where swap state and recovery files live

Nothing about your swaps is stored by the bundle. The server keeps no database, no keys and no log. Everything lives in three places:

| What | Where it lives | Survives |
| --- | --- | --- |
| The swap itself: amounts, deadlines, its current step | On-chain, in the Solana program or the Ethereum contract | Everything. Any copy of the page can read it again |
| **The recovery seed**: one secret from which every swap's keys are derived | (1) In the page's memory while the tab is open. (2) In the tab's session storage, so reloading that tab resumes at once. (3) Only if you set a device passphrase: sealed in the browser's IndexedDB. (4) **In the recovery file you download** | (1) and (2) end when the tab is closed. (3) ends when the browser's site data is cleared. (4) is the only real backup |
| The recovery file, `xmrswap-recovery-....json` | Wherever your browser saves downloads, until you move it | As long as you keep it |
| Page settings (RPC URL, nodes, connection mode) | The browser's local storage for the page's address | Until site data is cleared |
| Large-swap orders and your message threads with makers | The browser's IndexedDB, encrypted with a key derived from the seed | Until site data is cleared; readable again only with the same seed |
| Small notes per swap (the XMR address you chose, the id of a sweep already sent) | The browser's local storage | Until site data is cleared. Conveniences only |

Three things follow from this.

**The recovery file is the backup. There is no other.** With the recovery file and the wallet you paid from, any copy of the page on any machine can find your swaps on-chain and continue or refund them. Without the seed, a swap that is not finished cannot be refunded and its XMR cannot be collected: the funds are lost. The page does not let you lock funds until you have downloaded the file and ticked the box saying you saved it.

**Browser storage belongs to one address.** The browser keeps separate storage for `http://127.0.0.1:8780`, `http://localhost:8780`, a different port, and any hosted site. If you open the page at a different address it starts empty: no settings, no seed. Nothing is lost, but you must load your recovery file there. Always open the same address, and do not change `[ui] listen` while a swap is in progress.

**Clearing site data, private windows and "clear on exit" delete the browser's copies.** If your browser clears storage when it closes, the recovery file is the only thing that brings a swap back.

## What to back up, and how

1. **The recovery file.** Download it from the page's Settings page ("Recovery file") before your first swap; the page makes you. Move it out of the downloads folder to somewhere that survives this computer failing, for example an encrypted USB stick or a password manager's file store. You can protect the file itself with a passphrase when you download it.
   - Anyone who has the file (and its passphrase, if set) holds the keys for your open swaps. Keep it private.
   - One file covers all swaps made with that seed, past and future. You do not need a new backup per swap.
   - If you ever load a different recovery file into the page, swaps made with the old seed can only be resumed with the old file. Keep both.
2. **`deploy/xmrswap.toml`**, your settings. It holds no secrets and is easy to recreate.
3. **Your RPC URLs**, wherever you keep them (your shell profile or the env file of the systemd unit). They are secrets if they contain an API key.

There is nothing else. The bundle's own directory can be deleted and rebuilt at any time.

## Getting back after something went wrong

| What happened | What to do |
| --- | --- |
| The tab was reloaded | Nothing. It resumes by itself. |
| The tab or browser was closed, or the computer restarted | Start the bundle if it is not running, open the same address, and load the recovery file or type your device passphrase. The page finds your swaps on-chain, resumes at once, refunds whatever can still be refunded, and tells you plainly if a deadline passed while it was closed. **Do this immediately**: deadlines keep running while the tab is closed. |
| The browser's data was cleared, or you are on another machine | Start the bundle there, open it, enter your settings, load the recovery file, and connect the wallet you paid from. |
| The bundle's server stopped during a swap | Start it again at once, at the same address. Leave the tab open; it reconnects by itself. While the server is down the page cannot reach your Monero nodes, so it cannot confirm a lock. If that lasts until a safe margin before the deadline, the page refunds by itself, provided the tab is open and your Solana RPC is reachable. |
| The recovery file is lost and no browser still has the seed | Open swaps made with that seed cannot be completed or refunded by you. Finished swaps are not affected. |

## Upgrades

### The rule

**Upgrade only when no swap is in progress.** Wait until the page shows "Safe to close" for every swap, or until the Activity page shows nothing open. An upgrade is then just replacing files.

Upgrading does not touch your swap state, because none of it is in the bundle. The risk during an upgrade is only time: while the server is stopped the page cannot check Monero locks, and a new version of the page loads only when the tab is reloaded.

### Steps

1. Check the page: no swap is in progress, and you have your recovery file.
2. Stop the bundle with Ctrl-C.
3. Get the new version and verify it ([Verifying the download](verifying-the-download.md)). For a source checkout, update it with git. Not run on the machine where this was written:

   ```sh not-run
   git pull
   ```

4. Install dependencies for the new version:

   ```sh
   pnpm install --no-frozen-lockfile
   ```

5. Rebuild the interface, or point `[ui] dist` at the new verified release. **The start command builds the interface only when it is missing; it does not rebuild an old one.** After updating the source you must rebuild it yourself. Not run in this form on the machine where this was written:

   ```sh not-run
   pnpm --filter @xmrswap/web build
   ```

6. Compare your settings file with the new `deploy/xmrswap.example.toml`. A setting that was removed or renamed stops the bundle at start with a message naming it; nothing is silently ignored.
7. Start the bundle **at the same address as before**:

   ```sh
   pnpm --filter @xmrswap/deploy start
   ```

8. Reload the tab so the browser loads the new page. Your settings and seed are still there, because the address did not change.
9. Run the checks in [Checking it works](checking-it-works.md), and compare the program id and contract address with the published ones again. A new release can pin new ones. If you saved settings in the page before, the browser's saved program id and contract address win over the release's; update them on the Settings page if the release changed them.

### If a swap is in progress and you cannot wait

Avoid this. If you must restart or replace the bundle while a swap is open:

- **Do not close or reload the tab.** The page already loaded keeps running the old code and keeps protecting the swap. It only needs the server back to reach your Monero nodes.
- Keep the downtime to a minute or two. Prepare the new version in a separate directory first, so that the switch is "stop the old one, start the new one".
- Start the new one at the same address and with the same Monero nodes.
- Watch the red banner's countdown. If the server will not come back in time, the page refunds by itself a safe margin before the deadline; let it.
- Do not move to a release that pins a different program id or contract address while a swap is open. The open swap lives in the old program; finish it with the old page first. A recovery file records which program and contract it was made for, and the page warns when you load one made for a different deployment.

### Going back

To return to the previous version, repeat the steps with the old files. Nothing in the browser is changed by an upgrade, so there is nothing to convert back.
