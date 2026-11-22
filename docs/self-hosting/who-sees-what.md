# Who sees what

What each party can learn about you, for each way of running the interface. Nothing here depends on trusting a promise: it follows from where each program runs and what passes through it.

## The short version

- Messages between you and a maker are always encrypted in your browser. **No relay, server or RPC provider can read them**, whichever way you run the interface.
- What differs between the ways of running it is **who learns your IP address and when you were active**.
- **Your Solana RPC provider sees your on-chain queries and transactions in every mode, unless you run your own Solana node.** Running the bundle yourself does not change that.
- The swap itself is public on-chain: amounts, the wallet address you pay from, and timing are visible to everyone, as with any Solana or Ethereum transaction. The Monero side is private in the usual Monero way.

## What a relay operator can and cannot do

"Relay operator" means whoever runs the relay you use. If you run the bundle, that is you.

| | A relay operator |
| --- | --- |
| Can see | Your IP address, which maker you contact, and the size and timing of your messages |
| Cannot see | What the messages say: inbox messages, approvals, key shares, view keys |
| Can do | Drop or delay your messages |
| Cannot do | Read, change or forge messages; move funds; block a refund. A refund goes from your wallet straight to the chain and never passes through the relay |

If the relay drops your messages or is down, the page notices and sends them on-chain instead (Solana swaps).

## The four ways to connect

You choose one on the page's Settings page, under "Connection mode". The bundle starts the page in the second one.

| Mode | Who runs the relay | Who learns your IP address through the message channel | Use it when |
| --- | --- | --- | --- |
| Hosted | The operator of the site you are using | That operator | Convenience matters most to you |
| Self-hosted | You, on your own machine | Nobody on the relay side | You want no third party in the path. This is what the bundle sets up |
| Tor Browser, direct | Nobody: no relay | Nobody | You already use Tor Browser. It needs makers to accept requests from the page directly, and it is **untested** |
| On-chain only | Nobody: no relay | Your Solana RPC provider, which sees each message being posted | You have no Tor, or the maker lists no onion address. Solana swaps only. Each message costs a transaction fee, and who messaged whom, and when, is public on-chain (the content stays encrypted) |

## Each way of running the interface, party by party

"Sees" means the party can observe it if it chooses to; it does not mean it keeps a record.

### Using someone else's site (hosted page, hosted relay)

| Party | What it sees |
| --- | --- |
| The site operator, as web server | Your IP address and when you load the page. It also chooses the code your browser runs |
| The site operator, as relay | Your IP address, which maker you contact, message sizes and timing. Not the contents |
| The site operator, if you use its Monero proxy | Which Monero transactions and blocks your page asks about, which can reveal the lock transaction of your swap |
| Your Solana RPC provider | Your IP address, the wallet addresses and swaps you look up, the transactions you send, and when |
| Your Ethereum RPC provider, if you set one | The same, for Ethereum |
| The Monero nodes you named | Your IP address (or the site's, through its proxy) and which transactions you ask about |
| The maker | Your encrypted messages, arriving over Tor. Not your IP address |
| Everyone | The on-chain swap: amounts, your paying address, timing |

### Running the bundle yourself (self-hosted page, self-hosted relay)

| Party | What it sees |
| --- | --- |
| Web server and relay | They are yours. Nobody else sees page loads, which maker you contact, or message timing |
| The Tor network | That your machine uses Tor, as for any Tor user. Not which maker you reach or what you send |
| Your Solana RPC provider | Your IP address, the wallet addresses and swaps you look up, the transactions you send, and when. Also the relay's regular reading of the maker list. **Nothing changes here unless you run your own Solana node** |
| Your Ethereum RPC provider, if you set one | The same, for Ethereum |
| Remote Monero nodes | Your IP address and which transactions and blocks you ask about, which can reveal the lock transaction of your swap. To avoid this, run your own node, or use nodes with a `.onion` address: the relay reaches those through Tor |
| The maker | Your encrypted messages, arriving over Tor. Not your IP address |
| Everyone | The on-chain swap: amounts, your paying address, timing |

### Running the bundle yourself without Tor (self-hosted page, on-chain messages)

As above, except:

| Party | What it sees |
| --- | --- |
| Your Solana RPC provider | Additionally, each message you post, as a transaction from your address |
| Everyone | Additionally, that your address messaged that maker, and when. The message content stays encrypted |

Ethereum swaps are not possible this way: they need a relay or a maker's HTTPS endpoint to fetch a key proof.

### Tor Browser, direct (untested)

| Party | What it sees |
| --- | --- |
| The server you loaded the page from | A Tor exit address, not yours |
| Relay | None is used |
| Your Solana RPC provider | Your queries and transactions, from a Tor address rather than your own, if Tor Browser carries them |
| The maker | Your encrypted messages, over Tor |

This mode has not been tested. Do not rely on it for a swap that matters.

## Reducing what others see

| You want | Do this |
| --- | --- |
| No relay operator learning your IP address | Run the bundle (self-hosted mode) |
| Your RPC provider not seeing your queries | Run your own Solana node and set `SOLANA_RPC_URL` to it |
| Monero nodes not seeing your IP address or your lock transaction | Run your own Monero node, or use `.onion` nodes |
| Nobody choosing the code you run | Run the bundle from a download you have [verified](verifying-the-download.md) |
