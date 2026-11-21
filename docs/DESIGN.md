# XMR atomic swaps on Solana and Ethereum

2026-11-21 · @sully

## Summary

A SOL↔XMR atomic swap can use an on-chain maker registry on Solana in place of Tor rendezvous discovery. The registry, the offers and the swap escrow can all live in one program, so discovery and each maker's public record share one source of truth.

The design is deployed twice: a program on Solana for SOL and USDC, and a contract on Ethereum for ETH and USDC. Each holds its own registry, offers and escrow.

The main cost is maker privacy: a registered maker's address, volume and timing are public on the SOL side. The Monero leg stays private.

This is a design sketch. Nothing here has been built or audited.

## Decisions

These are settled. Where another section still says otherwise, this table wins.

|  Topic | Decision |
|  Offers | Makers publish offers on Solana. Quotes on request are kept only for oversized swaps. |
|  Approval | Set per offer: auto-accept, approve within a window, or approved in advance. Each maker sets its window; 60 seconds or less is strongly recommended, and takers see a warning on anything longer. |
|  Screening | Up to each maker. The contract has no screening rules. |
|  Maker bond | None. Missed deadlines are recorded publicly against the maker. |
|  Anti-spam deposit | Eigenwallet's model. Up to 5% of the locked amount, held for 30 minutes on a refund. The maker may withhold it but can never receive it. |
|  Withheld deposits | If still unreleased after 60 days, half returns to the taker and half goes to the protocol treasury. Before then the taker can message the maker to negotiate a release. |
|  Maker claim without ready | Delay set per offer, 60 minutes at least, with a taker warning. |
|  Deadlines | Lock notice: 10 minutes. Automatic refund cutoff: confirmation time plus 15 minutes. Final deadline: 7 days. |
|  Protocol fee | 0.05% of each completed swap, paid to the protocol treasury. |
|  Upgrades | Upgradable at launch, with the key held by the project owner. Made immutable later. |
|  Launch scope | Both directions, on Solana and Ethereum. |
|  Price sources | A wXMR pool is a cross-check only. |
|  Confirmation depth | 2, 10, and 25 or more Monero confirmations, by swap size. |
|  Contact | Every maker has a built-in encrypted inbox. Other contact channels are optional. |

Assumed until confirmed:
- The browser tab uses a session key to refund automatically, with no wallet prompt.
- Refund watchers are allowed only when the taker runs them.
- BTC and Dash are left for later.

## What the program holds

The program keeps two kinds of account, one per maker and one per swap.

|  Account | Contents |
|  Maker account (one per maker) | Offers, approval mode and window, deposit percentage, encryption key, optional onion address and contact channels, outcome counters, registration slot |
|  Swap account (one per swap) | Both Monero key commitments, joint address, amounts, deadlines, approval state, lock notice, ready flag, anti-spam deposit |

Discovery becomes a single query: any client lists all maker accounts from any RPC node. No rendezvous server is needed. Registering is free, so the UI ranks makers by completed volume.

## Contracts on Solana and Ethereum

Two independent deployments enforce swaps: a Solana program for SOL and USDC legs, and an Ethereum contract for ETH and USDC legs. Each has its own maker registry, offers and escrow, and both apply the same outcome rules.

|  | Solana program | Ethereum contract |
|  Assets escrowed | SOL, USDC (Solana token) | ETH, USDC (Ethereum token) |
|  Protocol fee | 0.05% of each completed swap, paid to the treasury | 0.05% of each completed swap, paid to the treasury |
|  Key-share check on claim | Direct, because Solana and Monero share a curve | Indirect: a twin key on Ethereum's curve, plus an off-chain proof that both keys hide the same secret |
|  Offers | Published on-chain and refreshed by the maker | Short-lived signed quotes posted on Solana, checked by the contract |
|  Finality before the maker locks XMR | Under a second | Roughly 13 to 15 minutes for full finality (to be verified) |
|  Timeouts | Tens of minutes | Longer, to cover Ethereum finality plus Monero confirmations |
|  On-chain messaging | Cheap; the baseline channel | Costly per message; a fallback only |
|  Upgrades | Upgradable at launch; authority revoked later | Upgradable at launch; ownership renounced later |

- **One maker, two registrations.** A maker registers separately on each chain it serves. The two records share one identity, described under Shared maker identity below.
- **Records stay**** local.** Each contract records only the faults it can prove on its own chain. Neither needs to read the other.
- **Messaging for Ethereum legs.** Signed quotes, lock notices and inbox messages for ETH and USDC-ETH swaps go through the Solana program when the maker is registered there, or over Tor. Ethereum events are the fallback.
- **Key rotation on Ethereum costs gas.** A maker that rotates often can keep its encryption key in the Solana registry and point its Ethereum record at it.
- **USDC can be frozen by its issuer on either chain.** A freeze mid-swap breaks atomicity, so USDC legs carry that extra risk.

### Shared maker identity

A maker can present one identity across Solana and Ethereum, so takers see a single profile with combined history.
- **Linking by mutual pointers.** The maker's Solana record names its Ethereum address, and its Ethereum record names its Solana key. Each record is written by a transaction from that chain's own key, so a link that points both ways is proven by both keys. Neither contract has to verify the other chain's signatures.
- **No one-sided claims.** A pointer in only one direction is ignored. Nobody can attach themselves to another maker's record.
- **One to one.** Each key links to at most one counterpart at a time.
- **Shared settings.** The Solana record is the home for the encryption key, its rotation and the onion address. The Ethereum record points to it, which avoids paying Ethereum gas for every rotation.
- **Shared reputation.** Clients merge fills, missed deadlines, withholds and attributed aborts from both chains into one history. A fault on either chain counts against the whole identity.
- **Separate ****recor****ds.** Each contract keeps its own counters, and clients combine them. Neither contract reads the other, so no bridge is needed.
- **Unlinking leaves a trace.** Changing or removing a link is a recorded event with a delay before it takes effect. Clients keep past history attached to both keys, so a maker cannot shed a bad record by unlinking.
- **One console.** The maker configuration manages both registrations and the link from the same page.

## Swap flow

Makers publish offers on Solana, and a taker starts a swap by locking funds against one. The steps below cover a taker paying SOL or USDC for XMR. Quotes on request remain available for swaps larger than a maker's posted limits.

### Steps
- **Offer.** The maker publishes its price, size limits, fees, deadlines, approval mode and a pool of one-time key shares, and refreshes the offer on the schedule it chose.
- **Lock.** The taker locks SOL or USDC against the offer as it stands at that moment and picks an unused key share. The price is fixed here.
- **Approval.** This depends on the offer's approval mode. Auto-accept offers skip it.
- **XMR lock and notice.** The maker sends XMR to the joint address and posts a lock notice through the program: the transaction ID and its half of the view key.
- **Check.** The taker's browser verifies the lock and waits for the required Monero confirmations.
- **Ready.** The browser sets ready. This moves no funds.
- **Claim.** The maker claims the SOL or USDC, which publishes its half of the Monero key.
- **Sweep.** The browser combines both halves and takes the XMR.

### Approval modes

Each offer states its mode on-chain, so the web UI can filter on it.

|  Mode | How it works | Taker experience |
|  Auto-accept | No approval step | The swap proceeds at once |
|  Approve within a window | The lock is pending until the maker approves or rejects | A short wait |
|  Approved in advance | The maker signs an approval for the taker's address, with a size limit and an expiry. The taker presents it when locking. | One request, then instant swaps until it expires |

Rules for the approval window:
- **Set by each maker.** The window length is a per-offer setting.
- **60 seconds recommended.** The maker console strongly recommends 60 seconds or less and says why: longer windows hold taker funds and deter takers.
- **Warning above 60 seconds.** The taker UI shows a warning on any offer with a longer window, before locking, stating how long funds may be held.
- **Full refund if not approved.** A rejection or an expired window returns everything, with no fee. Anyone can send that refund, because it needs no key share and always pays the taker's address.
- **Taker can leave while pending.** The taker can cancel a pending lock at any time for a full refund.
- **Pending locks reserve nothing.** They use none of the maker's capacity or one-time keys until approved.
- **Decisions are counted.** The program records approvals, rejections and timeouts, so the UI can show each maker's approval rate and typical response time.

### Refunds and deposits

A refund is free only when the maker is provably late. Every other refund after approval reveals the taker's key half, so the maker can recover any XMR it sent, and puts a small anti-spam deposit on hold.

|  Situation | Taker gets back | Maker |
|  Pending approval: rejected, expired or cancelled | Everything | No fault |
|  Approved, but no lock notice by the notice deadline | Everything; the miss is recorded against the maker | Provable fault |
|  Taker cancels after approval, before the notice deadline | Everything, less any deposit withheld | No fault; may withhold the deposit |
|  Taker refunds after a lock notice | Everything, less any deposit withheld | Recovers its XMR; may withhold the deposit |
|  Taker never sets ready; maker chooses to abort after its claim delay | Everything, less any deposit withheld, once the taker returns to collect | Recovers its XMR when the taker collects; may withhold the deposit |
|  Taker never sets ready or refunds; maker claims after its claim delay | The XMR, if the maker locked it | Takes the funds. The claim publishes its key half. |
|  Ready set, but the maker does not claim by its deadline | Everything; the miss is recorded against the maker | Provable fault |
|  Taker never returns by the final deadline | Nothing | Takes the funds. The claim publishes the maker's key half, so the XMR stays collectable. |

The anti-spam deposit follows eigenwallet's model: a percentage set per offer, shown to the taker before locking, taken from the locked amount and capped by the contract at 5%. On a refund the deposit is held for 30 minutes and then returned to the taker, unless the maker withholds it. A withheld deposit can never go to the maker; the maker can only release it to the taker later. Each maker's withhold rate is public, and a maker that was provably late cannot withhold. A held deposit that the maker has not released after 60 days is split: half returns to the taker and half goes to the protocol treasury. Until then the taker can message the maker to ask for a release. Each maker also sets how long it waits before it can claim without the taker's ready. The contract's floor is 60 minutes, and the taker UI states the consequence before locking.

### Ethereum markets

Frequent on-chain updates cost too much on Ethereum, so the maker posts short-lived signed quotes on the Solana board and the taker submits one with the Ethereum lock. The Ethereum contract applies the same approval modes and refund rules.

### Taker sells XMR

The roles mirror. The taker takes a buy-XMR offer with a small fee, the maker must lock SOL or USDC by a deadline, or the take lapses and is recorded against it, the taker then locks XMR, and the taker claims once the maker sets ready.

## What registering on Solana does and doesn't replace

The registry replaces discovery and identity, but not the message channel, and it removes maker anonymity on the SOL side.
- **It replaces discovery and identity.** In eigenwallet, each maker runs a Tor hidden service that hides its IP address, and takers connect to it to take offers ([eigenswap](https://eigenwallet.org/eigenswap.html)).
- **It doesn't replace the message channel.** Published offers remove the quote round trip, but lock notices, approvals and inbox messages still have to travel somehow. There are two options, and a maker can offer either or both:
- **Endpoint in the registry.** The maker lists an address. A domain exposes their IP; an onion address keeps Tor in the picture after all.
- **Messaging through the program.** Messages are posted on-chain as encrypted payloads. Makers need no inbound connectivity. Alpenglow targets roughly 150 ms finality ([Solana](https://solana.com/upgrades/alpenglow)), so round trips are fast and cheap. The cost is that who messaged whom, and when, is public.
- **It removes maker anonymity on the SOL side.** A maker's address, swap volume and timing are public and linkable. Anyone can see who provides XMR liquidity and how much. Makers would need to weigh that exposure themselves, including the regulatory side.

## Message channels and key rotation

On-chain messaging is the baseline channel every maker supports, and Tor is an optional second channel a maker can switch on. Makers can rotate their encryption key as often as they like.

### Channels

|  Channel | Carries | Public metadata | Cost |
|  On-chain (always available) | Lock notices, approvals, inbox messages and quote requests for oversized swaps, as encrypted payloads | Who messaged whom, and when | A transaction fee per message |
|  Tor (optional) | The same messages, sent to the maker's onion address | None | No fee; the maker rate-limits instead |

A maker opts in to Tor by listing an onion address in its maker account. Clients prefer Tor when a maker lists it and fall back to on-chain messaging if the onion service is unreachable.

Lock, ready, claim, refund and abort evidence always go through the program, whichever channel is used. Nothing safety-critical depends on Tor.

### Key rotation
- **Any frequency.** Rotation is one instruction signed by the maker's operator key. The program enforces no minimum interval.
- **Versioned keys.** The maker account stores the current encryption key, a version number, and the previous key with an expiry slot. Every message names the key version it was encrypted to.
- **Grace period.** The daemon keeps a retired private key until its expiry slot has passed and every swap opened under it has closed, then deletes it.
- **In-flight swaps are unaffected.** The taker uses a fresh one-time key per swap, and both sides derive a session key from the handshake. A swap keeps its session key through any number of rotations.
- **Stale requests retry.** A request encrypted to an expired version is rejected. The client re-reads the registry and sends again.
- **Offer****s are separate.** Offers are published with the operator key, not the encryption key, so rotation never affects an offer.
- **Onion address too.** The listed onion address is updated the same way.

### Contacting a maker

Every maker can be reached through a built-in encrypted inbox, and may also publish other contact channels.
- **Built-in inbox, the default.** A taker encrypts a message to the maker's published public key and sends it through the program, or over Tor if the maker lists an onion address. The message can carry a swap ID and always carries a key for the reply.
- **Read in the maker console.** Messages appear in an inbox beside the swap they refer to, with the relevant action to hand, such as releasing a held deposit. Replies go back encrypted to the taker's key and show in the taker UI.
- **Key rotation.** Each message names the key version it was encrypted to, and the daemon keeps retired keys through their grace period, so messages sent around a rotation still open.
- **Spam control.** A message costs a transaction fee. Makers can restrict the inbox to takers who have a swap with them.
- **Optional channels.** A maker may list others in its registry record, such as a Matrix room, Discord, Telegram, email or a website, and update them like its onion address.
- **Shown with a warning.** Listed channels are the maker's own claims and are not verified. The UI labels them as maker-provided and reminds takers that nobody legitimate asks for a seed phrase or key share.

The main use is the one the contract cannot settle: asking a maker to release a withheld deposit before the 60-day split.

## Differences from the Bitcoin design

The Solana version keeps eigenwallet's anti-spam deposit, shortens the deadlines and adds a public record of maker faults, but has the same blind spot on the Monero side.
- **A gentler punish path****.** In eigenwallet a taker who fails to refund in time can lose the Bitcoin with no guarantee of the Monero. Here a maker that claims after its claim delay must publish its key half, so the taker can still collect any XMR that was locked.
- **Timeouts shrink.** Solana finality is near-instant, so the windows only need to cover the chosen Monero confirmation depth: tens of minutes, not hours.
- **The blind spot stays.** The program still can't see whether XMR was locked. A refund after a lock notice puts the anti-spam deposit on hold, and the notice's view key lets anyone check the maker's claim against the Monero chain.

## Upgrades, then immutability

The contracts launch upgradable, with the upgrade key held by the project owner, and are made immutable later. Until then users are trusting the key holder not to change the rules, and the UI should state the current status. The steps below apply when the contracts are frozen.
- **Revoke the upgrade authority.** Solana programs are upgradeable by default.
- **Publish a verifiable build** so anyone can confirm the deployed bytecode matches the source.
- **Keep parameters in the ****offer****.** Deposits, fees and deadlines can't be tuned after freezing, so they belong in each offer, not in global constants.
- **Close swap accounts on completion** to return the rent deposit. Takers fund the account they create, so spam costs them.

## Maker tools

Makers need an always-on daemon that executes swaps and a web console that configures it. With on-chain messaging the daemon needs no inbound connectivity and no Tor service; it only watches the program through an RPC node and a Monero node.

|  Tool | What it does | Why it matters |
|  Registration manager | Registers the maker on each chain, links the two identities and publishes its contact channels. | This record is what takers see when choosing a maker. |
|  Inventory splitter | Pre-splits XMR into outputs sized to the offer ladder and re-splits change after each swap. | A spent output's change is locked for 10 blocks (about 20 minutes), so one output funds one swap at a time. |
|  Offer engine | Prices from a reference feed plus a spread, with per-asset limits. Widens the spread as volatility or inventory skew grows. Publishes each offer on-chain and keeps it refreshed. | A taker can lock against a live offer at once, so pricing errors are costly. |
|  Swap daemon | Watches the program, locks XMR, claims, and handles refunds. Stores key shares durably and resumes after a restart. | A missed deadline is recorded publicly against the maker. |
|  Risk controls | Maximum in-flight exposure, per-taker limits, confirmation depth by swap size, abort-fee settings, and a pause switch. | Limits losses from price moves, spam and Monero reorgs. |
|  Rebalancing and refills | Refills XMR and rebalances SOL, ETH and USDC through the venues the maker enables: a wXMR bridge, exchanges and instant-swap services. Runs automatically, with approval, or as alerts only. | Daily capacity is roughly inventory × (24 h ÷ cycle time), capped by refill speed. |
|  Evidence publisher | After an ambiguous abort, publishes the joint view key and the lock transaction ID. | Lets clients verify the XMR lock and attribute the abort correctly. |
|  Dashboard | Fills, spread earned, abort and withhold rates, missed deadlines and uptime. | Makers and takers both judge a maker on this history. |
|  Key rotation | Rotates the encryption key on a schedule the maker sets, or on demand. Keeps retired keys until their grace period ends, then deletes them. | Limits what a leaked key exposes, without interrupting in-flight swaps. |
|  Tor service (optional) | Runs an onion service for the message channel and lists or updates its address in the registry. | Keeps messages off-chain and hides the maker's network location. |
|  Approvals | Approves or rejects pending locks within the maker's window, by the maker's own rules, and issues advance approvals for chosen addresses. | A missed window refunds the taker and shows in the maker's approval rate. |
|  Deposit handling | Applies the withhold policy during the 30-minute hold and releases held deposits on request. | Withhold rates are public, and unreleased deposits are split after 60 days. |
|  Inbox | Shows encrypted messages from takers beside the swap they concern, with the matching action to hand. | It is the default way takers reach a maker. |

Key separation: the registry should support two keys per maker. A cold owner key controls the registration and the identity link. A hot operator key, held by the daemon, publishes offers and claims.

## Maker configuration

One configuration covers liquidity, offers and pricing for all four markets, edited on a single console page or as a single file. Every value in this section is a setting; none is hard-coded.

### Markets

|  Market | Enforced by | Maker receives or pays | Reference prices needed |
|  USDC-SOL | Solana program | USDC on Solana | XMR/USD |
|  SOL | Solana program | SOL | XMR/USD and SOL/USD, or XMR/SOL directly |
|  USDC-ETH | Ethereum contract | USDC on Ethereum | XMR/USD |
|  ETH | Ethereum contract | ETH | XMR/USD and ETH/USD |

Each market switches on or off separately for selling XMR and for buying XMR.

### Price sources

The maker picks a primary source per market and an ordered list of fallbacks.

|  Source | Gives | Needs | Watch for |
|  wXMR pool on Solana | An on-chain XMR price in USDC or SOL, read from a pool the maker names | The token address and pool address, both pinned | Thin liquidity; see below |
|  CoinGecko API | Aggregated XMR, SOL and ETH prices in USD | An API key; the plan's rate limit | Update lag and outages |
|  CoinMarketCap API | Aggregated XMR, SOL and ETH prices in USD | An API key; the plan's rate limit | Update lag and outages |

The wXMR source needs care. On 21 November 2026 the token showed about $392,500 of liquidity spread across 719 pools, and one of its USDC pools held about $35,700 ([token](https://dexpaprika.com/solana/token/WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp), [pool](https://dexpaprika.com/solana/pool/GgB61FHx6PbuCixFnVat2KrDMDA3kCKLjep9rGKUN2Wd)). A pool that small can be pushed off-market cheaply by someone who then takes the maker's quote. The bridge redeems wXMR for XMR at a 0.1% fee, which should hold the price near real XMR, but a thin pool can still drift between arbitrage trades.

Source settings:
- Primary source and fallback order, per market
- Refresh interval and maximum price age
- Cross-check source and the largest disagreement allowed, in percent
- Minimum pool liquidity and averaging window, for pool sources
- What to do when a check fails: pause quoting, or widen the deviation by a set amount

### Offer settings

These apply per market and per direction.

|  Setting | What it controls | Example value |
|  Enabled | Whether the offer is live | On |
|  Deviation from reference | Percent added to the reference price when selling XMR, or subtracted when buying. May be negative. | 1.5% |
|  Size tiers | Extra deviation above a swap size | +0.5% above 50 XMR |
|  Inventory skew | Extra deviation as inventory moves away from its target | Up to 1% |
|  Swap size | Smallest and largest swap accepted | 0.1 to 200 XMR |
|  Offer validity | How long an offer stays live without a refresh, so a stopped daemon's offers lapse | 60 seconds |
|  Confirmation depth | Monero confirmations required, by swap size | 10 below 50 XMR, 25 above |
|  Deadlines | The lock-notice and final deadlines | 10 minutes and 7 days |
|  Anti-spam deposit | Percent of the locked amount held on a refund; 5% at most | 2% |
|  Daily volume cap | Total the offer will fill in a day | 2,000 XMR |
|  Approval mode | Auto-accept, approve within a window, or approved in advance | Auto-accept |
|  Approval window | How long a pending lock waits for approval. 60 seconds or less is strongly recommended; anything longer shows takers a warning. | 60 seconds |
|  Claim delay | How long before the maker can claim without the taker's ready. 60 minutes at least. | 90 minutes |
|  Withhold policy | When to withhold a refunding taker's deposit: never, always, or by rule | When the price moved against the maker |

Offer price = reference price × (1 + deviation + size tier + inventory skew).

### Offer updates and daily cost

A maker that publishes offers on Solana chooses how often to refresh them, and the console shows what that frequency costs per day in SOL before the setting is saved.

Daily cost = updates per day × fee per update, where updates per day = 86,400 ÷ the interval in seconds. The fee per update is Solana's base fee of 5,000 lamports per signature (0.000005 SOL) plus any priority fee the maker adds ([Solana fee structure](https://solana.com/docs/core/fees/fee-structure)).

|  Update interval | Updates per day | Daily cost at the base fee |
|  1 second | 86,400 | 0.432 SOL |
|  5 seconds | 17,280 | 0.0864 SOL |
|  10 seconds | 8,640 | 0.0432 SOL |
|  30 seconds | 2,880 | 0.0144 SOL |
|  60 seconds | 1,440 | 0.0072 SOL |

One transaction refreshes all of a maker's markets, including the signed quotes for the Ethereum markets, so the cost does not multiply by the number of markets.

What the console shows:
- **Live estimate.** The daily cost in SOL, with a dollar equivalent, recalculated as the maker changes the interval or the priority fee.
- **Actual spend.** Fees paid over the last 24 hours, next to the estimate.
- **Runway.** How many days of updates the fee wallet covers at the current rate, with an alert threshold.
- **Move-triggered updates.** If the maker chooses to update only when the price moves by a set percent, the console shows the expected cost and the maximum.
- **Occasional costs.** Key rotations and Ethereum registry changes are listed separately, the latter in ETH.

Settings: update interval, an optional price-move trigger with a minimum refresh interval, and the priority fee.

### Liquidity settings
- **XMR inventory.** One shared pool or a fixed allocation per market, a reserve that is never offered, and the output ladder: which sizes to pre-split and how many of each.
- **Paying balances.** Caps on SOL, ETH and each USDC balance committed to buy-XMR offers.
- **Targets and alerts.** Target inventory per asset and the thresholds that trigger refill alerts.
- **Exposure limits.** Largest total in flight, and largest amount per taker.

### Guardrails

Each guardrail has its own thresholds and can be switched off.
- **Volatility pause.** Stop quoting if the reference moves more than a set percent within a set time.
- **Disagreement pause.** Stop quoting if the primary and cross-check sources differ by more than the allowed percent.
- **Stale price pause.** Stop quoting if no fresh price has arrived within the maximum age.
- **Hard price band.** Never quote outside a manual minimum and maximum price per XMR.
- **Dry run.** Show the offers the engine would post, without posting them.

### Where settings live
- **Private.** Price sources, API keys, the deviation formula, inventory and guardrails stay on the maker's machine.
- **Published.** Enabled markets, size limits and channels go to the registry, in one transaction per chain when they change.
- **Changes.** Edits are validated before saving, apply without a restart and are recorded in a change log. The whole configuration exports and imports as one file.

### Example file

```toml
[pricing]
refresh_seconds = 15
max_age_seconds = 60
cross_check = "coinmarketcap"
max_disagreement_pct = 1.0
on_failure = "pause"

[pricing.sources.coingecko]
api_key_env = "COINGECKO_KEY"

[pricing.sources.coinmarketcap]
api_key_env = "CMC_KEY"

[pricing.sources.wxmr_pool]
token = "<wXMR token address>"
pool = "<pool address>"
min_liquidity_usd = 250000
average_seconds = 300

[markets.usdc_sol.sell_xmr]
enabled = true
source = "coingecko"
fallbacks = ["coinmarketcap"]
deviation_pct = 1.5
size_tiers = [{ above_xmr = 50, extra_pct = 0.5 }]
min_xmr = 0.1
max_xmr = 200
offer_valid_seconds = 60

[markets.sol.sell_xmr]
enabled = true
source = "wxmr_pool"
fallbacks = ["coingecko"]
deviation_pct = 2.0

[markets.usdc_eth.sell_xmr]
enabled = true
source = "coingecko"
deviation_pct = 2.0

[markets.eth.sell_xmr]
enabled = false

[liquidity]
xmr_reserve = 50
output_ladder = [{ size_xmr = 5, count = 20 }, { size_xmr = 50, count = 6 }]
max_in_flight_xmr = 400

[guardrails]
volatility_pause = { move_pct = 3.0, window_seconds = 600 }
price_band_usd = { min = 300, max = 900 }
```

## Liquidity rebalancing and refills

A maker that sells XMR ends up holding SOL, ETH or USDC and needs XMR back, so the console includes a rebalancer that moves value between assets through whichever venues the maker enables. Each venue sits behind the same adapter interface, and each can run automatically, wait for approval, or only raise an alert.

### Venue types

|  Venue type | Examples | How a refill works | Who holds the funds meanwhile | Watch for |
|  wXMR bridge with a Solana exchange | wXMR on Solana | Swap USDC or SOL for wXMR on a decentralised exchange, then redeem wXMR for XMR through the bridge. The reverse path sells XMR. | The bridge operator | Thin pools on the exchange leg, and bridge custody; see the wXMR bridge adapter below |
|  Centralised exchanges | Any exchange with an XMR market and an API, on the maker's own account | Deposit the paying asset, trade, withdraw XMR | The exchange | Account verification, withdrawal limits and delays, and long confirmation waits on XMR deposits |
|  Instant-swap services | ChangeNOW, StealthEX, HoudiniSwap, FixedFloat (ff.io) | Request a quote by API, send the paying asset to a one-time deposit address, receive XMR at the maker's address | The service, for the length of the swap | Per-swap limits, the service's spread, and swaps held for compliance review |
|  Opposite-side flow | The maker's own buy-XMR offers | Tighten the buy-side deviation to attract takers selling XMR | Nobody; these are atomic swaps | Slow, and depends on demand |
|  Manual | A refill done outside the console | The maker records it so inventory and cost tracking stay correct | Varies | Nothing is automated |

### Instant-swap services

All four publish an API, so each can have its own adapter.

|  Service | API access | Rate options | Notes |
|  [ChangeNOW](https://changenow.io/api/docs/support) | API key from its partner programme | Standard and fixed rate | Says its liquidity combines centralised and decentralised exchanges |
|  [StealthEX](https://stealthex.io/partners/api/) | Free API key | Not stated on the page read | Partners can set a fee per transaction |
|  [HoudiniSwap](https://houdini-swap.gitbook.io/houdini-swap/integrations/api) | API key and secret | Fixed and variable rate | Routes through exchange partners. An order can stop at a "Contact Support" status when flagged for compliance review. |
|  [FixedFloat (ff.io)](https://ff.io/api) | API key and secret; signed requests | Fixed and float | A deposit outside the quoted limits puts the order into an emergency state: continue at the new rate, or refund minus the network fee |

### wXMR bridge adapter

The wXMR bridge is an enabled refill venue: the adapter buys wXMR on a Solana exchange and redeems it for native XMR, as long as the total cost stays inside the maker's limit. Terms below are from the bridge's own [site](https://wxmr.io/) and [docs](https://wxmr.io/docs).

|  Item | Detail |
|  Fee | 0.1% in each direction, charged in wXMR |
|  Minimum | 0.1 XMR in each direction |
|  Maximum | None stated |
|  XMR to wXMR | Send XMR to a reusable deposit address tied to the Solana wallet; wXMR is minted after 10 Monero confirmations |
|  wXMR to XMR | Approve one Solana transaction naming a Monero address; the bridge then sends the XMR |
|  Stuck redemption | A pending request can be cancelled after an on-chain waiting period. The wXMR comes back; the fee does not. |
|  Screening | None described for the bridge itself |
|  Reserve proofs | Published daily; anyone can check one with a Monero wallet and a synced node |
|  Liveness | A public heartbeat; the bridge counts as offline after 6 minutes without an update |
|  Integration | No integrator API is documented. The adapter calls the bridge program directly; the frontend is open source. |

How a refill runs:
- **Quote.** Price the exchange leg from USDC or SOL into wXMR, then add the 0.1% bridge fee and network fees. Compare the total with the reference price.
- **Fill only if good enough.** Execute when the total cost is within the maker's limit. Otherwise split the order into smaller pieces, wait for the pool to recover, or pass the remainder to the next venue.
- **Redeem at once.** Send the wXMR straight to redemption so the maker does not sit on it.
- **Track.** Follow the request until the XMR arrives. If it stalls past a set time, cancel it and retry elsewhere.

Selling XMR runs the other way: deposit XMR, wait for the mint, sell wXMR on the exchange.

How its risk compares:
- **Fewer ways to be stopped.** There is no account, no stated cap and no described screening. The project owner reports the operator has never frozen funds; this was not verified independently.
- **Custody risk remains.** The XMR reserve sits with the bridge. Its operator is unnamed, and the docs do not state how the reserve is held, whether mints or redemptions can be paused, or who can upgrade the program.
- **Exposure is brief if wXMR is not held.** Redeeming immediately limits the risk to the redemption window.
- **Liquidity is the practical limit.** Pools are small, so large refills must be split or shared with other venues.
- **Refills are public.** Bridge records link the Solana wallet to the Monero destination, amount and timing.

Adapter controls: a maximum total cost, a cap on wXMR held at any time, a piece size tied to pool depth, a heartbeat check before each refill, and an optional reserve-proof check before refills above a set size.

### Rebalancing settings

Every item is configurable per asset and per venue.
- **Triggers.** Low, target and high levels for XMR, SOL, ETH and each USDC balance; a schedule; or a manual run.
- **Mode.** Automatic, approve each refill, or alert only.
- **Venue choice.** A fixed priority order, or the best net quote among enabled venues. Caps on each venue's share, on each transaction and on each day.
- **Cost limits.** The largest total cost allowed against the reference price, in percent. A refill is skipped if every venue exceeds it.
- **Rate type.** Fixed or floating, where the venue offers both.
- **Cross-chain moves.** Shifting USDC between the Solana and Ethereum sides.
- **Failure handling.** Timeouts, retry on the next venue, and a cooldown for a venue that failed.

### Safety controls
- **Address allow-list.** Refills pay out only to the maker's own XMR, SOL and ETH addresses.
- **In-transit cap.** A limit on the total value sitting with third parties at once. This bounds the loss if a venue fails or holds a transfer.
- **Test transfer.** A small first transfer for any new venue or address.
- **Local credentials.** API keys stay encrypted on the maker's machine. Where a venue allows it, keys are restricted to allow-listed withdrawal addresses.
- **Cost tracking.** Every refill is logged with venue, rate, fees and time. The measured refill cost can feed the offer engine, so the deviation covers it.

Each venue applies its own terms and screening. Meeting them is the maker's responsibility.

### Example settings

```toml
[rebalance]
mode = "approve"            # "auto", "approve" or "alert"
max_cost_pct = 1.5
max_in_transit_usd = 50000
test_transfer_usd = 50

[rebalance.levels.xmr]
low = 150
target = 400
high = 700

[rebalance.levels.usdc_sol]
high = 120000

[rebalance.routing]
choose = "best_quote"       # or "priority"
priority = ["wxmr_bridge", "exchange", "changenow", "fixedfloat", "stealthex", "houdiniswap"]
max_per_tx_usd = 20000
max_per_day_usd = 150000

[rebalance.venues.wxmr_bridge]
enabled = true
max_cost_pct = 1.0          # exchange leg + 0.1% bridge fee + network fees
max_piece_pct_of_pool = 2.0
max_wxmr_held = 5
redeem_immediately = true
require_heartbeat = true
reserve_proof_check_above_xmr = 50
stalled_redeem_minutes = 60

[rebalance.venues.exchange]
enabled = true
name = "<exchange>"
api_key_env = "EXCHANGE_KEY"
withdraw_address_allowlist = true

[rebalance.venues.changenow]
enabled = true
rate = "fixed"
api_key_env = "CHANGENOW_KEY"

[rebalance.venues.fixedfloat]
enabled = true
rate = "float"
api_key_env = "FF_KEY"

[rebalance.venues.stealthex]
enabled = false

[rebalance.venues.houdiniswap]
enabled = false
```

## Large-swap tool for takers (web UI)

The large-swap tool splits one order into legs across several makers, opens them in one transaction and tracks each leg to completion. Each leg is an ordinary swap with its own keys and joint address, so a failed leg never affects the others.

### How an order runs
- **Order entry.** The taker sets the paying asset (SOL or USDC), total amount, destination XMR address, worst acceptable rate, maximum in-flight exposure and a deadline.
- **Offer**** collection.** The tool reads every maker's published offer and shows rate, maximum size, approval mode, deposit, claim delay and history for each.
- **Plan.** A router proposes a split that minimises cost within each maker's limits and within the in-flight cap. The taker can edit legs. The plan shows the blended rate against a reference price and the expected duration.
- **Batch lock.** One Solana transaction opens every leg in the current wave. If the order is larger than the in-flight cap, the tool runs in waves and opens new legs as earlier ones settle.
- **Monitoring.** A status board tracks every leg through the states below.
- **Settlement.** Each completed leg yields the keys to its joint address. The tool sweeps the XMR to the destination address or exports the keys.
- **Exceptions.** If a maker stalls, the tool refunds that leg and re-plans the unfilled remainder. The final report lists filled and unfilled amounts.

### Leg states

|  State | Meaning | What the tool does |
|  Planned | A live offer is selected for this leg | Waits for the taker to approve the plan |
|  Pending approval | Funds are locked and the maker has not yet approved. Skipped for auto-accept offers. | Refunds in full if rejected or the window expires |
|  Locked | Taker's SOL or USDC is in escrow | Watches Monero for the maker's lock |
|  XMR seen | Lock found, confirmations counting | Shows progress toward the required depth |
|  Ready | Taker has confirmed the lock | Waits for the maker's claim |
|  Claimed | Maker took the funds and revealed their key share | Computes the joint spend key |
|  Swept | XMR moved to the destination address | Closes the leg |
|  Refunded | Leg unwound; funds returned | Re-plans the remainder |

### Safeguards
- **Stay online until every leg is Ready or Refunded.** If the maker's lock notice does not check out, the taker must refund before the maker's claim delay ends. After it, the maker can claim without the taker's ready. The tool warns before the tab closes, as set out under Client-side custody. A refund watcher is safe only when the taker runs it themselves, because it has to hold the taker's key share.
- **Back up key shares before locking.** One recovery file, or shares derived from a wallet signature, covers all legs. The tool refuses to lock until this is done.
- **Set confirmation depth from the total in flight.** A Monero reorg affects every pending leg at once, so parallel legs do not spread that risk.
- **Verify Monero data against several nodes.** A single dishonest node could fake a lock.
- **Resume after a reload.** Leg state is rebuilt from the program's accounts plus the saved key shares.

## Client-side custody

Every operation that touches funds runs in the user's browser: key generation, key shares, signing, lock checks, refunds and the final XMR sweep. The web server and the relay never hold a key and cannot move funds, which also means they cannot rescue a swap. If the tab closes at the wrong moment, nobody else can act for the user.

### What runs where

|  Operation | Runs in | What the server sees |
|  Generating and storing key shares | The browser | Nothing |
|  Signing the lock transaction | The browser, through the user's wallet | Nothing |
|  Setting ready and refunding | The browser, with a session key | Nothing |
|  Checking the XMR lock and its confirmations | The browser, querying Monero nodes | Nothing |
|  Computing the joint spend key and sweeping XMR | The browser | Nothing |
|  Lock notices, approvals and inbox messages | Encrypted in the browser | Ciphertext only, through the relay |
|  Serving the interface | The web server | Page requests |

The session key is created in the page and registered with the swap at lock time. It can only set ready or refund that one swap, and a refund always pays the taker's own address. This lets the tab refund by itself, with no wallet prompt for the user to miss.

Makers are different: their keys live in their own always-on daemon on their own machine. The console only talks to that daemon, and the hosted site never holds maker keys.

### When closing the tab can lose funds

|  Situation | What can happen | Outcome |
|  Paying SOL, ETH or USDC; leg is locked but not yet Ready or Refunded | The maker posts a false lock notice, the taker does not refund before the maker's claim delay of 60 minutes or more, and the maker then claims | Funds lost |
|  Key shares lost before the swap completes, with no backup | Neither the refund nor the XMR can be reached | Funds lost |
|  Leg is Ready or Claimed, and a backup exists | The XMR waits at the joint address | Safe to close |
|  Paying XMR; tab closes after the XMR lock | The swap unwinds once the maker refunds | Delayed, not lost, if the key share is kept |
|  Lock is pending approval; tab closes | The window expires and anyone can send the full refund | Safe to close |

Closing the tab includes putting the computer to sleep, shutting a laptop lid, losing the connection, or a phone switching to another app.

### Warnings the interface must show
- **Confirmation before locking.** A full-screen notice in plain words: "Keep this tab open until it says Safe to close. If you close it, let the computer sleep or lose your connection before then, you can lose your funds." It shows the expected duration and the deadline time, and the user must tick a box to continue.
- **Backup first.** The lock button stays disabled until the recovery file is saved.
- **Standing banner.** While any leg is at risk, a red banner reads "Do not close this tab" with a countdown to the refund deadline. The tab title shows the same.
- **Leave-page prompt.** Closing, reloading or navigating away triggers the browser's confirmation while any leg is at risk.
- **Keep awake.** The page asks the browser to keep the screen on, and recommends a desktop computer for large swaps.
- **Connection alarm.** If the Solana, Ethereum or Monero connection drops, a sound and a notification give the time left.
- **Automatic refund.** If the XMR lock has not reached the required depth by a safety margin before the deadline, the tab refunds by itself.
- **Safe to close.** A green state appears only when every leg is Ready, Claimed or Refunded and the backup exists.
- **On return.** A reopened tab resumes at once, refunds anything still refundable, and states plainly what was lost if a deadline passed.
- **Consequences, not just instructions.** Every warning says that funds can be lost, not only what to do.

## Tor relay in the web UI

A browser on the ordinary internet cannot open Tor connections, so the web server relays messages between the user and makers' onion services. The relay carries ciphertext only.

### Message path
- The browser encrypts the message to the maker's current registry key and sends it to the relay over HTTPS.
- The relay checks that the destination is an onion address currently listed in the registry, then forwards the message through its Tor client.
- The maker's daemon replies. The reply is encrypted to the taker's one-time key and signed by the maker's operator key.
- The relay passes the reply back. The browser verifies the signature against the registry before using it.

### What the relay operator can and cannot do

|  | Relay operator |
|  Can see | The user's IP address, which maker they contact, message sizes and timing |
|  Cannot see | Message contents: inbox messages, approvals, key shares, view keys |
|  Can do | Drop or delay messages |
|  Cannot do | Read, alter or forge messages; move funds; block a refund, which goes from the wallet straight to Solana |

### Relay rules
- Forward only to onion addresses listed in the registry, so the relay is not an open proxy.
- Enforce the protocol's message size cap and per-IP rate limits.
- Keep no message logs by default.
- If the relay is down, the UI falls back to on-chain messaging.

### Connection modes

|  Mode | Who runs the relay | Who learns the user's IP | Use when |
|  Hosted | The site operator | The site operator | Convenience matters most |
|  Self-hosted | The user, on their own machine | Nobody on the relay side | The user wants no third party in the path |
|  Tor Browser, direct | No relay | Nobody | The user is already on Tor. Needs makers to accept cross-origin requests; untested |
|  On-chain only | No relay | The Solana RPC provider | Tor is unavailable or the maker lists no onion address |

In every mode the user's Solana RPC provider sees their on-chain queries and transactions unless they run their own node.

## Self-hosting the web UI

Anyone can run the full web UI on their own machine, and the public documentation must treat that as a first-class path. A local install puts the relay and Tor client under the user's control, so no third party sees their IP address or message timing.

### What you run

|  Component | Purpose | Required |
|  Web UI (static files) | The interface. All cryptography runs in the browser. | Yes |
|  Relay service | Bridges the browser to Tor | Only for the Tor channel |
|  Tor client | Provides the proxy the relay sends through | Only for the Tor channel |
|  Solana RPC endpoint | Reads the registry and submits transactions | Yes; own node or a provider |
|  Monero nodes | Verify XMR locks and confirmation depth | Yes; own node preferred, otherwise at least two remote nodes |

### Proposed settings

|  Setting | Default | Notes |
|  Solana RPC URL | None; must be set | A provider sees the user's queries |
|  Monero nodes | None; must be set | The UI compares answers across nodes |
|  Tor proxy address | 127.0.0.1:9050 | Tor's standard local port |
|  Relay bind address | 127.0.0.1 | Localhost only unless changed on purpose |
|  Program ID | Pinned in the release | Shown in the UI for checking |

### What the documentation must cover
- **Quick start.** Prerequisites, one command that starts the UI, relay and Tor together, and the local address to open.
- **Configuration reference.** Every setting with its default and effect.
- **Safe defaults.** The relay binds to localhost. Exposing it publicly gets its own page, with the relay rules above as requirements.
- **Who sees what.** The relay and connection-mode tables, in plain language, for each way of running the UI.
- **Verifying the download.** Checksums or a reproducible build, and how to check the program ID against the published one.
- **Checking it works.** A status page showing Tor reachable, RPC connected and Monero nodes in agreement.
- **Troubleshooting.** Tor unreachable and the fallback to on-chain messaging, RPC rate limits, and a Monero node out of sync.
- **Backups and upgrades.** Where swap state and recovery files live, and how to upgrade without losing an in-flight swap.

## Status and open items

Nothing in this design has been built or audited, and two Solana specifics have not been checked against current documentation.
- Confirm how the Ethereum contract verifies a signed quote posted on Solana, and how each contract verifies an advance approval.
- Confirm the curve syscall used to check a revealed key share is available on mainnet.
- Model the economics: deposit percentage, deadlines and the protocol fee.
- Draft the account layouts and instruction set as a program skeleton.
- Confirm the Ethereum finality figure used for timeouts.
- Specify the Ethereum contract, including the identity link between a maker's two registrations.
- Decided: a wXMR pool is a cross-check price source only.
- Confirm the wXMR bridge's custody model, pause powers and program upgrade authority, and work out its direct program calls, since no integrator API is documented.
- Read each instant-swap service's terms and limits for XMR before enabling its adapter by default.
- Decided: each maker sets its claim delay, with a 60-minute floor and a taker warning.
- Decided: makers publish offers on Solana by default, with quotes on request kept for oversized swaps. The swap flow section is reworked. All sections now follow the decisions table.

## Sources
- [What is eigenswap?](https://eigenwallet.org/eigenswap.html) (eigenwallet)
- [Alpenglow](https://solana.com/upgrades/alpenglow) (Solana)
- [Wrapped Monero (wXMR) on Solana](https://dexpaprika.com/solana/token/WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp) (DexPaprika)
- [wXMR/USDC pool](https://dexpaprika.com/solana/pool/GgB61FHx6PbuCixFnVat2KrDMDA3kCKLjep9rGKUN2Wd) (DexPaprika)
- [ChangeNOW exchange API](https://changenow.io/api/docs/support)
- [StealthEX public API](https://stealthex.io/partners/api/)
- [Houdini Swap API](https://houdini-swap.gitbook.io/houdini-swap/integrations/api)
- [FixedFloat API](https://ff.io/api)
- [wXMR bridge](https://wxmr.io/) and its [docs](https://wxmr.io/docs)
- [Solana fee structure](https://solana.com/docs/core/fees/fee-structure)
