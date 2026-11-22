# WP10 (taker web UI) deviations and hand-over notes

Same vocabulary as the other packages: **Deviation** = differs from the text; **Choice** = the text was silent or ambiguous and the smallest sound reading was taken; **Note** = built as written, but the next package needs to know; **Request** = a change this package would like elsewhere (nothing outside `apps/web/` was edited).

## Running it

```sh
pnpm --filter @xmrswap/web test           # type-check + unit and component tests (jsdom, SDK fakes)
pnpm --filter @xmrswap/web build          # static files in apps/web/dist
pnpm --filter @xmrswap/web test:browser   # Chromium against svm-rpc + the built program + Monero regtest (holds /tmp/xmrswap-integration.lock)
SCREENSHOTS=1 pnpm --filter @xmrswap/web test:browser   # the same run, also rewriting apps/web/screenshots/
```

Against the local test stack (svm-rpc with the built program, three makers with live offers, the regtest's two nodes; loopback only, nothing live):

```sh
export XMR_BIN=$HOME/monero
pnpm --filter @xmrswap/web build
pnpm --filter @xmrswap/web stack          # prints the URL and a development key; chain time follows the clock, a block every 10 s, makers stepped every 2 s; Ctrl-C stops everything
HEADED=1 pnpm --filter @xmrswap/web stack # the same, opening Chromium with a test wallet already installed
```

The page reads its deployment defaults from `config.json` next to `index.html` (same origin; optional): any key of `Settings` in `src/lib/settings.ts` (`solanaRpc`, `ethereumRpc`, `ethereumChainId`, `moneroNodes`, `ownNode`, `moneroNetwork`, `relayUrl`, `mode`, `programId`, `contract`, `pollMs`, `sweepMaxFee`). What the user saves in Settings overrides it. WP12's bundle should write this file (relay at `/`, Monero proxy nodes `/monero/0`, …).

**Relay CORS.** The relay sends no CORS headers by default. When the UI is served from another origin than the relay (another port counts) start the relay with `RELAY_ALLOWED_ORIGINS=<the page's origin>`, or serve both behind one origin. The Settings page says this next to the relay URL, and the Status page repeats it when the relay cannot be reached. `tor_ok` is shown as "Tor proxy reachable" and described as a SOCKS handshake only; "Maker reachable over Tor" is a real forward to a listed maker's `/xs/v1/info`.

## Deviations and choices

| # | Spec | Kind | What was done | Why |
| --- | --- | --- | --- | --- |
| W1 | 8.2 wallet connection: `@solana/wallet-adapter-wallets` | Deviation | `wallet-adapter-base` and `-react` are used at WP1's pins with **Wallet Standard discovery only** (`wallets={[]}`); nothing is imported from `-wallets` (it stays in `package.json` as WP1 wrote it). | The vendor adapters in `-wallets` pull in SDKs that fetch remote code or call third-party services at runtime (WalletConnect and others). Current Solana wallets register through the Wallet Standard, which needs none of that. |
| W2 | 8.3 "the seed … in memory and, encrypted under a user passphrase, in IndexedDB" | Choice | In memory; in `sessionStorage` for the life of the tab; and, only if the user sets a device passphrase in Settings, sealed in IndexedDB (`passphraseSeal`). | "A reopened tab resumes at once" (8.5 item 9) cannot wait for a passphrase prompt while a refund deadline runs. The tab-scoped copy dies with the tab, and a compromised page could read the in-memory seed anyway (Open risks). After the tab is closed the user loads the recovery file or types the device passphrase; the page says funds are at risk until they do. |
| W3 | 8.4 "download completed" | Choice | A browser cannot observe that a download finished. The gate is: the file was handed to the browser's download, then the user ticks "I saved the recovery file". The box is disabled before the download. A seed loaded from a file counts as backed up. | |
| W4 | 8.4 `wallets` in the recovery file | Note | Wallets connected when the file is downloaded are written into it; wallets that open swaps later are remembered in the browser only. A restored browser finds swaps of any wallet it is told about: by the file, or by connecting the wallet. | The file is downloaded before the first lock; rewriting it after every new wallet would mean asking the user to save it again. |
| W5 | 8.5 item 6 "a sound and a notification" | Note | The sound is three Web Audio tones (no audio file). Browsers allow neither sound nor notifications without a user gesture or permission; permission is requested when the user confirms a lock. Where both are refused the banner and the page notice remain. | |
| W6 | 8.5 item 5 Wake Lock | Note | Requested while any leg is at risk and re-acquired when the tab becomes visible again. Where the API is missing or refused, the red banner tells the user to turn off sleep. Headless Chromium refuses it, so the browser tests and screenshots show that wording. | |
| W7 | 3.6 `release_deposit` / `split_deposit` after a taker refund | Choice | The background loop never opens a wallet prompt on its own. A refund sweeps the session key's budget back to the taker, so the later deposit crank has no fee payer but the wallet: the page shows "Your deposit can be collected now" with a button. Calls the session key can still pay for are sent without asking. | A wallet popup nobody asked for is how users learn to click "Approve" blindly. There is no deadline on these calls and anyone (including the maker's daemon) may send them. |
| W8 | 8.2 "rate against a reference" | Choice | The page fetches no price feed (no third-party request). The reference is the user's own XMR, SOL and ETH figures from Settings, otherwise the median of the listed offers, and it is labelled as whichever it is. | Privacy and self-hosting are requirements; a price API is a third party. |
| W9 | 8.2 "ranked by completed volume" | Choice | Within one market and direction (the list is always filtered to one), by the maker's volume in that market's asset; ties by merged completed swaps, then by price. | Volumes in different assets are not comparable. |
| W10 | 8.6 "The taker can edit legs" | Choice | An edit is a constraint on the router's input, never a hand-built plan: changing a leg's size caps that offer at the new size, removing a leg excludes that maker, and `planRoute` re-plans around both. | "The UI does not re-implement" the router. |
| W11 | 8.6 batching, two USDC legs per transaction | Deviation | USDC legs are opened one per transaction (`lookupTable` is not set), SOL legs two per transaction. | The v0 lookup-table form needs a protocol lookup-table address pinned by the release; none is exported yet. Request to WP1/WP5: export it, then the tool sets `lookupTable: true`. |
| W12 | 8.6 waves | Choice | The first wave is opened by the user's confirmed click. Later waves are opened by the page when a leg settles (the wallet asks for a signature); if the wallet refuses, the board keeps an "Open next wave" button. A maker whose leg ended in a refund is excluded from re-planning; a maker with a leg in flight gets no second leg. | |
| W13 | 8.6 "stored in IndexedDB, encrypted like the seed" | Choice | Orders and inbox threads are sealed with AES-256-GCM (Web Crypto) under a key the core derives from the seed (`deriveKeys(seed, 1, "xmrswap-web-kv01").encSecret`). | `passphraseSeal` takes about a second per call and needs a passphrase the user may not have set; a seed-derived key opens again from the recovery file on the same device. |
| W14 | 8.2 Ethereum | Note | Ethereum swaps (lock, take, session-key calls through viem, pool and DLEQ blob checks, USDC allowance, upgrade status from `owner()`) are implemented on the SDK and type-checked, but **were not run in a browser against anvil**: this package's browser tests cover Solana, as the WP10 row asks. WP11's H-A/E-1 UI scenarios are their first run. Swap state is read at the SDK's default tag (`finalized`). | |
| W15 | 8.7 sweep | Choice | The sweep goes through the first configured node ("the most trusted"). A failed attempt spends nothing and is retried on every pass and on a button; "Export keys" is offered as soon as both shares are known; the swap account (which holds the maker's revealed share) is closed only after the sweep is mined or the user confirms the exported key file is saved. | monero.md: a possibly retryable decoy-selection failure. |
| W16 | 3.8 advance approval | Note | Requested from the maker page (`approval_request` over Tor, else on-chain), stored in the browser, checked with `solApprovalProblem` and presented automatically. Solana only. | |
| W17 | 8.5 item 1 "the deadline time" | Choice | The confirmation shows the latest moment the maker's claim-without-ready can open if every window runs out (`approval + notice window + claim delay` from now, chain time): the time by which the tab must have reached Safe to close. | The real `T_co` exists only after the notice. |
| W18 | 8.3 strict CSP | Note | The build injects `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src http: https:; …`. `connect-src` is open because the RPC, nodes and relay are user settings. No inline style attribute is used anywhere. A server that sends its own CSP header should send the same. | |
| W19 | Design | Note | `apps/web/PRODUCT.md` records the design brief (register, users, principles) the interface was built to. System fonts only. | |

## Test seams

- Unit and component tests run the real React tree over `test/fakes.ts`: `ModelChain`, a `ChainPort` whose swaps evolve by the SDK's reference state machine (`apply`) with real derived keys, notices and secrets, and `FakeMonero`, a scripted `MoneroPort`.
- Browser tests (`browser/`): `stack.ts` starts svm-rpc with the built program, registers makers and publishes offers, and plays each maker with `makerStep` (`TestMaker.step()`); `driver.ts` registers a Wallet Standard test wallet whose key stays in Node and counts every signature request, which is how the tests prove that only the lock ever reaches the wallet. The regtest is mined to 720 blocks before any sweep.

## Bugs found elsewhere

None. Every refusal the page predicted from the SDK's flows was the one the program gave.
