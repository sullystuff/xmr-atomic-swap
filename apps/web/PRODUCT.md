# Product

## Register

product

## Users

People swapping SOL, USDC or ETH for XMR (or selling XMR) directly with makers, with no custodian. They arrive at a desk or on a phone, usually in the evening, about to commit real money, and then have to keep one tab open and watch a countdown for anywhere from twenty minutes to two hours. Many are privacy-minded and technically literate; some are not, and the interface must not assume they know what a key share is.

## Product purpose

A static web app that runs an atomic swap entirely in the browser: keys, signing, lock checks, refunds and the final XMR sweep. Nobody can rescue a swap if the tab closes at the wrong moment, so the interface's first job is to make the state of the user's money, the next deadline and "is it safe to leave" impossible to misread.

## Brand personality

Cypherpunk, competent, verifiable. Calm and precise rather than loud. Shows the mechanics (addresses, program ids, node agreement) instead of hiding them. Plain words; every warning names the consequence.

## Visual direction

The owner's existing system: Monero orange `#ff6600` on near-black `#0d0d0d`, with a light theme of equal quality. Orange is for the primary action and current selection only. Red is reserved for "funds at risk"; green is reserved for "Safe to close". System fonts only (nothing is fetched at runtime), with tabular monospace figures for amounts, addresses and countdowns.

## Anti-references

Exchange dashboards with tickers and glow. Gradient-and-glass "web3" landing pages. Emoji. Decorative motion. Anything that makes a deadline look like decoration.

## Design principles

1. Money and deadlines first: the amount at stake and the next deadline are the largest things on any swap screen.
2. One colour, one meaning: red means funds can be lost now; green means safe to close; neither is used for anything else.
3. Say the consequence: no instruction without what happens if it is ignored.
4. Verifiable by default: program id, contract, nodes and who sees what are always one click away.
5. Works with nothing but static files: no third-party request, ever.

## Accessibility

WCAG 2.2 AA. Full keyboard operation, visible focus, live regions for state changes and countdown milestones, reduced-motion respected, colour never the only signal.
