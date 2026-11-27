// Amendment 1 in the taker UI (SPEC 11): beta caps, the fresh payout address, the watcher and the
// paused state with the changed mandatory warnings, the wallet-derived key, and the release panel.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type AssetCaps, SWAP_STATE, WALLET_KEY_WARNINGS } from '@xmrswap/protocol';
import { CapReached, type SwapView, deadlinesOf, init, seedSigner, signWatchAck } from '@xmrswap/sdk';
import { PROGRAM_MISMATCH, type PayoutVerdict } from '../src/lib/app.js';
import { NOT_OPEN_TITLE, capErrorText, capRefusalText, capsLine, capsState } from '../src/lib/caps.js';
import { formatTime } from '../src/lib/format.js';
import { offerWarnings, solanaRow } from '../src/lib/market.js';
import { REFUSALS, refusalText } from '../src/lib/refusal.js';
import { parseServedRelease } from '../src/lib/release.js';
import { UNAVAILABLE_TEXT, siteProblem, unlockErrorText, walletKeyUnavailable, walletKeyWarnings } from '../src/lib/walletkey.js';
import { WATCHER_CAN, WATCHER_SEES, comeBackBefore, freezeGain, freezeGainText, watchedSafeText } from '../src/lib/watcher.js';
import { payoutText } from '../src/pages/NewSwapPage.js';
import { ModelChain, SOL, TAKER, XMR, offer, profile, row } from './fakes.js';
import { DEST, makeRig, mount } from './harness.js';

await init();
const TXID = 'ab'.repeat(32);
const caps = (o: Partial<AssetCaps> = {}): AssetCaps => ({ on: true, maxSwap: 5n * SOL, maxOpen: 50n * SOL, openValue: 12n * SOL, ...o });
const disabled = (el: HTMLElement): boolean => (el as HTMLButtonElement).disabled;
const WATCHER_SEED = new Uint8Array(32).fill(61);
const WATCHER = seedSigner(WATCHER_SEED).publicKey;
const DAY = 86_400;

async function review(user: ReturnType<typeof userEvent.setup>, label: string, xmr: string) {
  await user.type(await screen.findByLabelText(label), xmr);
}

// =====================================================================================  CAPS

describe('11.1 beta caps', () => {
  it('states: off, open, full, and closed (zero caps with the switch on)', () => {
    expect(capsState(undefined)).toBe('off');
    expect(capsState(caps({ on: false }))).toBe('off');
    expect(capsState(caps())).toBe('open');
    expect(capsState(caps({ openValue: 50n * SOL }))).toBe('full');
    expect(capsState(caps({ maxSwap: 0n, maxOpen: 0n, openValue: 0n }))).toBe('closed');
    expect(capsLine(caps(), 'sol')).toBe('Beta limits: at most 5.00 SOL per swap. 12.00 of 50.00 SOL is open across all swaps right now, leaving room for 38.00 SOL.');
    expect(capsLine(caps({ on: false }), 'sol')).toBeNull();
  });

  it('a cap refusal is worded as the protocol limit, never as the maker limit, with the largest size that still fits', () => {
    const r = row(1);
    const per = capRefusalText('SwapCapExceeded', caps(), 'sol', 0, { price: (x) => r.price(x), lo: r.minXmr, hi: r.maxXmr });
    expect(per).toMatch(/above the protocol's beta limit of 5\.00 SOL per swap\. It is a limit of the protocol, not of this maker/);
    expect(per).toMatch(/The largest this offer can take under the limit right now is 3\.3333 XMR\./);
    const open = capRefusalText('OpenCapExceeded', caps({ openValue: 49n * SOL }), 'sol', 1);
    expect(open).toMatch(/49\.00 of 50\.00 SOL is open, leaving room for 1\.00 SOL \(your deposit counts too\)\. It is a limit of the protocol, not of this maker; room returns as other swaps complete\./);
    // The SDK's error and the chain's own error name both map to the same wording.
    expect(capErrorText(new CapReached('SwapCapExceeded', caps()), caps(), 'sol', 0)).toMatch(/beta limit of 5\.00 SOL per swap.*Nothing was locked\.$/);
    expect(capErrorText(Object.assign(new Error('x'), { code: 'OpenCapExceeded' }), caps(), 'sol', 0)).toMatch(/total value open at once.*Nothing was locked\.$/);
    expect(capErrorText(new Error('User rejected the request.'), caps(), 'sol', 0)).toBeNull();
  });

  it('the review page shows the limits where the amount is chosen and caps the field with a plain reason', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ caps: { sol: caps() } });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    expect((await screen.findByTestId('caps-line')).textContent).toMatch(/at most 5\.00 SOL per swap\. 12\.00 of 50\.00 SOL is open/);
    await review(user, 'XMR to buy', '4');
    // 4 XMR × 1.5 = 6 SOL: above the per-swap cap, though well inside the maker's own limits.
    // Said at the field (as an alert) and again under the lock button.
    const err = (await screen.findAllByText(/above the protocol's beta limit of 5\.00 SOL per swap/)).find((e) => e.getAttribute('role') === 'alert')!;
    expect(err).toBeTruthy();
    expect(err.textContent).toMatch(/The largest this offer can take under the limit right now is 3\.3333 XMR/);
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    expect(disabled(screen.getByTestId('lock-button'))).toBe(true);
    // A size under the cap is priced and can be locked.
    fireEvent.change(screen.getByLabelText('XMR to buy'), { target: { value: '3' } });
    await waitFor(() => expect(screen.getByTestId('you-pay').textContent).toBe('4.50 SOL'));
    await waitFor(() => expect(disabled(screen.getByTestId('lock-button'))).toBe(false));
  });

  it('caps at zero read "the protocol is not open yet": information, not an error, and nothing can be locked', async () => {
    const user = userEvent.setup();
    const closed = caps({ maxSwap: 0n, maxOpen: 0n, openValue: 0n });
    const rig = makeRig({ caps: { sol: closed } });
    await mount(rig, '#/');
    const notice = (await screen.findByText(NOT_OPEN_TITLE)).closest('[data-kind]')!;
    expect(notice.getAttribute('data-kind')).toBe('info');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toMatch(/This is not an error.*Swaps that are already open are not affected; they can always be completed or refunded\./);

    window.location.hash = `#/swap/new/${rig.rows[0]!.id}`;
    rig.backup();
    await review(user, 'XMR to buy', '1');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    expect(disabled(screen.getByTestId('lock-button'))).toBe(true);
    expect(screen.getByText(`${NOT_OPEN_TITLE}: new SOL swaps are switched off on-chain for now.`)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a lock the chain refuses at the cap is reported as the cap, and nothing is locked', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ caps: { sol: caps() } });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to buy', '2');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    await user.click(screen.getByTestId('lock-button'));
    // Between the review and the lock another swap used up the room.
    rig.failOpen.message = capErrorText(new CapReached('OpenCapExceeded', caps({ openValue: 49n * SOL })), caps({ openValue: 49n * SOL }), 'sol', 0);
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Lock/ }));
    const alert = (await screen.findByText('Nothing was locked')).closest('[role="alert"]')!;
    expect(alert.textContent).toMatch(/protocol's beta limit on the total value open at once.*not of this maker.*Nothing was locked\./);
    expect(rig.chain.swaps.size).toBe(0);
  });

  it('the large-swap plan says when the unfilled remainder is due to the protocol cap rather than the makers', async () => {
    const user = userEvent.setup();
    const rows = [row(1, { price: (150n * SOL) / 100n }), row(2, { price: (151n * SOL) / 100n })];
    const rig = makeRig({ rows, caps: { sol: caps({ maxSwap: SOL, maxOpen: 13n * SOL, openValue: 12n * SOL }) } });
    await mount(rig, '#/large');
    await user.type(await screen.findByLabelText('Total to spend (SOL)'), '6');
    await user.type(screen.getByLabelText('Worst acceptable rate (SOL per XMR)'), '1.6');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    const note = (await screen.findByText("The protocol's beta limit shapes this plan")).closest('.notice')!;
    expect(note.textContent).toMatch(/at most 1\.00 SOL per swap.*leaving room for 1\.00 SOL.*not because makers lack XMR/);
    // No leg is above the per-swap cap, and a wave never exceeds the room that is left.
    for (const leg of screen.getAllByTestId('plan-leg')) expect(Number(within(leg).getAllByRole('cell')[2]!.textContent)).toBeLessThanOrEqual(1);
    // The maker that got no leg is listed as kept out by the protocol's limit, in those words.
    expect(screen.getByText(/^Left out:/).textContent).toMatch(/the protocol's beta limit leaves no room for it \(not the maker's limit\)/);
  });
});

// =====================================================================================  PAYOUT

describe('11.2 fresh payout address when selling XMR', () => {
  const FRESH = seedSigner(new Uint8Array(32).fill(88)).publicKey;
  const sell = (extra: Partial<Parameters<typeof makeRig>[0]> = {}, verdict: PayoutVerdict = { verdict: 'ok', reason: null, tokenAccountMissing: false, tokenAccountRent: 0n }) =>
    makeRig({ rows: [row(1, { direction: 1 })], extra: { payoutCheck: async () => verdict }, ...extra });

  it('says what each kind of bad address would do', () => {
    const v = (reason: string, verdict: 'warn' | 'refuse' = 'refuse'): PayoutVerdict => ({ verdict, reason, tokenAccountMissing: false, tokenAccountRent: 0n });
    expect(payoutText(v('token-account'))).toMatch(/token account, not a wallet\. The proceeds would follow that account's rules and could be stranded/);
    expect(payoutText(v('program'))).toMatch(/is a program, not a wallet\. Funds paid to it would follow that program's rules and could be lost/);
    expect(payoutText(v('program-owned', 'warn'))).toMatch(/controlled by another program.*stay parked until someone delivers them/);
    expect(payoutText(v('invalid-address'))).toMatch(/not an address the proceeds can be paid to/);
    expect(payoutText({ verdict: 'ok', reason: null, tokenAccountMissing: false, tokenAccountRent: 0n })).toBeNull();
  });

  it('is optional, defaults to the taking wallet, and explains what it hides and what it does not', async () => {
    const user = userEvent.setup();
    const rig = sell();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    const field = await screen.findByLabelText('Pay the SOL to another address (optional)');
    const hint = within(screen.getByTestId('payout')).getByText(/Left empty, the SOL is paid to the wallet that takes the offer/);
    expect(hint.textContent).toMatch(/an observer cannot link the proceeds to that wallet from the payout transaction alone/);
    expect(hint.textContent).toMatch(/the address and the amount are public in this swap, and funding the fresh address later from the same wallet links them/);
    expect(hint.textContent).toMatch(/cannot be changed; deposits and refunds always return to the taking wallet/);
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('paid-to').textContent).toBe('The wallet that takes the offer');

    await review(user, 'XMR to sell', '1');
    await user.type(screen.getByLabelText('Your XMR refund address'), DEST);
    await waitFor(() => expect(disabled(screen.getByTestId('lock-button'))).toBe(false));
    await user.click(screen.getByTestId('lock-button'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Post deposit/ }));
    await waitFor(() => expect(rig.requests).toHaveLength(1));
    expect(rig.requests[0]!.payout).toBeUndefined();
    expect([...rig.chain.swaps.values()][0]!.payoutAddress).toBe(TAKER);
  });

  it('a fresh address is checked first, passed to the take, and shown as bound on the swap page', async () => {
    const user = userEvent.setup();
    const rig = sell();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to sell', '1');
    await user.type(screen.getByLabelText('Your XMR refund address'), DEST);
    fireEvent.change(screen.getByLabelText('Pay the SOL to another address (optional)'), { target: { value: FRESH } });
    await waitFor(() => expect(screen.getByTestId('paid-to').textContent).toContain(FRESH.slice(0, 8)));
    await waitFor(() => expect(disabled(screen.getByTestId('lock-button'))).toBe(false));
    await user.click(screen.getByTestId('lock-button'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Post deposit/ }));
    await waitFor(() => expect(rig.requests[0]?.payout).toBe(FRESH));
    await rig.pass();
    const bound = await screen.findByTestId('bound-payout');
    expect(bound.textContent).toMatch(/SOL is paid to .*; this was fixed when the offer was taken and cannot change\./);
    expect(within(bound).getByTitle(FRESH)).toBeTruthy();
  });

  it('refuses an address that is itself a token account or a program', async () => {
    const user = userEvent.setup();
    const rig = sell({}, { verdict: 'refuse', reason: 'token-account', tokenAccountMissing: false, tokenAccountRent: 0n });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to sell', '1');
    await user.type(screen.getByLabelText('Your XMR refund address'), DEST);
    fireEvent.change(screen.getByLabelText('Pay the SOL to another address (optional)'), { target: { value: FRESH } });
    const err = (await screen.findAllByText(/This is a token account, not a wallet/)).find((e) => e.getAttribute('role') === 'alert')!;
    expect(err).toBeTruthy();
    expect(disabled(screen.getByTestId('lock-button'))).toBe(true);
  });

  it('warns, without refusing, about an address another program controls', async () => {
    const user = userEvent.setup();
    const rig = sell({}, { verdict: 'warn', reason: 'program-owned', tokenAccountMissing: false, tokenAccountRent: 0n });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to sell', '1');
    await user.type(screen.getByLabelText('Your XMR refund address'), DEST);
    fireEvent.change(screen.getByLabelText('Pay the SOL to another address (optional)'), { target: { value: FRESH } });
    expect((await screen.findByText('This address is not an ordinary wallet')).closest('.notice')!.textContent).toMatch(/controlled by another program/);
    await waitFor(() => expect(disabled(screen.getByTestId('lock-button'))).toBe(false));
  });

  it('USDC to an address with no token account: says the claimer pays to create it, funds the session key for it, and says the proceeds park otherwise', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: [row(1, { direction: 1, asset: 1, price: 150_000_000n })], extra: { payoutCheck: async () => ({ verdict: 'ok', reason: null, tokenAccountMissing: true, tokenAccountRent: 2_039_280n }) } });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to sell', '1');
    await user.type(screen.getByLabelText('Your XMR refund address'), DEST);
    fireEvent.change(screen.getByLabelText('Pay the USDC to another address (optional)'), { target: { value: FRESH } });
    const note = (await screen.findByText('This address has no USDC account yet')).closest('.notice')!;
    expect(note.textContent).toMatch(/whoever sends the claim pays for it: 0\.002039 SOL of account rent\. This page's session key sends the claim, so that amount is added to what the lock forwards to it/);
    expect(note.textContent).toMatch(/the proceeds are not lost: they stay parked for the payout address and anyone can deliver them/);
    await waitFor(() => expect(disabled(screen.getByTestId('lock-button'))).toBe(false));
    await user.click(screen.getByTestId('lock-button'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Post deposit/ }));
    await waitFor(() => expect(rig.requests[0]).toMatchObject({ payout: FRESH, payoutTokenRent: 2_039_280n }));
  });

  it('parked proceeds get a visible "deliver" action that the taking wallet can send but not redirect', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: [row(1, { direction: 1 })] });
    const { ref } = rig.chain.open({ direction: 1, payout: FRESH });
    rig.chain.maker.fund(ref);
    rig.monero.deposits = [{ txid: TXID, inPool: true, blockHeight: null, amount: XMR }];
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    rig.chain.advance(200);
    rig.chain.maker.ready(ref);
    // The payout address cannot receive: the claim succeeds and parks the proceeds for it.
    rig.chain.payoutBlocked = true;
    rig.chain.sessionEmpty = true;
    await rig.pass();
    expect(rig.chain.swaps.get(ref)!.owedTaker > 0n).toBe(true);
    const box = (await screen.findByText('The proceeds are parked for the payout address')).closest('.notice')!;
    expect(box.textContent).toMatch(/Nothing is lost: the amount is held by the program for that address and for no other, and anyone can deliver it there\..*it cannot redirect the money/);
    rig.chain.payoutBlocked = false;
    await user.click(within(box as HTMLElement).getByRole('button', { name: 'Deliver to the payout address' }));
    await waitFor(() => expect(rig.chain.swaps.get(ref)!.owedTaker).toBe(0n));
    expect(rig.chain.calls.at(-1)).toEqual([ref, 'withdraw_owed', 'anyone']);
  });

  it('the exported key file names the swap and its bound payout', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open({ direction: 1, payout: FRESH });
    rig.chain.maker.fund(ref);
    rig.monero.deposits = [{ txid: TXID, inPool: true, blockHeight: null, amount: XMR }];
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    rig.chain.advance(60);
    rig.chain.maker.refund(ref);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 3 });
    await rig.pass();
    expect(rig.app.engine.exportKeys(ref)).toMatchObject({ swap: ref, payout: FRESH, lock_txid: TXID });
  });
});

// =====================================================================================  WATCHER / FREEZE

describe('11.6 what a watcher really adds', () => {
  it('is computed for the offer at hand: nothing where the pause window is too short', () => {
    // Solana, depth 2, claim delay 1 h, pause 24 h: a pause at the cutoff adds 24 h − 1 h + 21 min 15 s.
    const g = freezeGain({ chain: 'solana', claimDelay: 3600, freezeWindow: DAY }, 2);
    expect(g).toEqual({ withoutSecs: 3300, leastExtraSecs: DAY - 3600, atCutoffExtraSecs: 1275 + DAY - 3600, useful: true });
    // Ethereum, 1 h pause against a 2 h claim delay: T_ff equals T_co, so a pause adds nothing.
    const none = freezeGain({ chain: 'ethereum', claimDelay: 7200, freezeWindow: 3600 }, 2);
    expect(none).toMatchObject({ leastExtraSecs: 0, atCutoffExtraSecs: 0, useful: false });
    expect(freezeGainText(none, 3600)).toMatch(/too short to add anything.*A watcher would give no protection here, so none is offered\./);
    expect(freezeGain({ chain: 'solana', claimDelay: 3600, freezeWindow: 0 }, 2).useful).toBe(false);
    expect(freezeGainText(g, DAY)).toMatch(/Without a watcher this tab must be back within 55 min of the maker's notice\. A pause adds between 23 h and 23 h 21 min/);
    // A window shorter than the claim delay still helps when the pause comes at the cutoff, and the text says which.
    const partial = freezeGain({ chain: 'solana', claimDelay: 6000, freezeWindow: 5400 }, 2);
    expect(partial).toMatchObject({ leastExtraSecs: 0, atCutoffExtraSecs: 675, useful: true });
    expect(freezeGainText(partial, 5400)).toMatch(/A pause at the refund cutoff adds 11 min 15 s; a pause right at the notice adds nothing on this offer/);
  });

  it('the watcher statement is the one the specification requires', () => {
    expect(WATCHER_SEES).toBe('The watcher sees which swap you are in, its amount, its timing and the Monero transaction that pays you. It cannot move funds. It can fail.');
    expect(WATCHER_CAN).toMatch(/pause this swap once.*never holds your keys, cannot refund for you and cannot set ready/);
  });

  it('the qualified Safe-to-close text is the one the specification requires', () => {
    expect(watchedSafeText('09:15 PM', '0.015 SOL')).toBe(
      'A watcher will pause this swap if the lock does not check out. If it does, come back before 09:15 PM to refund; coming back late, or a watcher that fails, can still cost you your payment. A refund after a pause can cost the deposit of 0.015 SOL.',
    );
  });

  it('item 10: a sell offer with a pause window warns that the maker can pause and the XMR stays locked', () => {
    const p = profile(1);
    const r = solanaRow('o', offer(p.pda, { direction: 1, wZ: DAY }), p, null);
    const w = offerWarnings({ row: r, pricing: r.price(XMR), xmr: XMR, minDepth: 0, upgrade: { frozen: true, authority: null } }).find((x) => x.id === 'freeze-sell')!;
    expect(w.title).toBe('This maker can pause the swap for up to 1 d');
    expect(w.text).toContain('This maker can pause the swap for up to 1 d; your XMR stays locked meanwhile');
    // Buying: the window and what it means for both sides, before locking.
    const buy = solanaRow('o', offer(p.pda, { wZ: DAY }), p, null);
    const b = offerWarnings({ row: buy, pricing: buy.price(XMR / 2n), xmr: XMR / 2n, minDepth: 0, upgrade: { frozen: true, authority: null } }).find((x) => x.id === 'freeze-buy')!;
    expect(b.title).toBe('This offer allows one pause of up to 1 d');
    expect(b.text).toMatch(/For you: the maker cannot take your payment without your confirmation until the pause ends.*a refund after a pause always leaves your deposit withholdable\. For the maker: its XMR stays tied up/);
    // No window, no such warning.
    const plain = solanaRow('o', offer(p.pda), p, null);
    expect(offerWarnings({ row: plain, pricing: plain.price(XMR / 2n), xmr: XMR / 2n, minDepth: 0, upgrade: { frozen: true, authority: null } }).some((x) => x.id.startsWith('freeze'))).toBe(false);
  });

  it('the three freeze refusals each have their own message', () => {
    for (const r of ['freeze-not-available', 'freeze-window-closed', 'already-frozen'] as const) expect(REFUSALS).toContain(r);
    expect(refusalText('freeze-not-available', true).text).toMatch(/only possible on a swap that named a watcher when it was locked/);
    expect(refusalText('freeze-window-closed', true).text).toMatch(/only accepted after the maker announced its lock and before its claim opens/);
    expect(refusalText('already-frozen', true).text).toMatch(/A swap can be paused once/);
  });
});

describe('11.6 the watcher option before locking', () => {
  const settings = { hostedWatcherUrl: 'https://watch.site.example', watcherUrl: '' };
  const info = { solana: WATCHER, ethereum: '0x00000000000000000000000000000000000000aa', max_swaps: 100, monero_nodes: 2 };

  it('is not shown on an offer without a pause window, and "this tab is my watcher" is the default where it is', async () => {
    const plain = makeRig({ settings });
    await mount(plain, `#/swap/new/${plain.rows[0]!.id}`);
    await screen.findByLabelText('XMR to buy');
    expect(screen.queryByTestId('watcher-option')).toBeNull();
    expect(screen.getByText('Pause window').nextElementSibling!.textContent).toBe('None: this offer accepts no watcher');
  });

  it('offers the hosted watcher with the honest statement, and names it in the lock only when chosen', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: [row(1, { wZ: DAY })], settings, extra: { watcherInfo: async () => info, registerWatcher: async () => new Promise(() => undefined) } });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    const option = await screen.findByTestId('watcher-option');
    const radios = within(option).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(within(option).getByText('This tab is my watcher').parentElement!.textContent).toMatch(/default.*Nobody else learns anything/);
    // My own watcher cannot be picked until its URL is set.
    expect(radios[2]!.disabled).toBe(true);
    expect(document.getElementById('watcher-statement')).toBeNull();

    await user.click(radios[1]!);
    const statement = document.getElementById('watcher-statement')!;
    expect(statement.textContent).toContain(WATCHER_SEES);
    expect(statement.textContent).toContain(WATCHER_CAN);
    expect(statement.textContent).toMatch(/counts as watched only once the watcher has acknowledged it with its signature; until then the red banner stays/);
    await waitFor(() => expect(within(statement).getByTitle(WATCHER)).toBeTruthy());

    await review(user, 'XMR to buy', '0.5');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    expect(document.getElementById('review-warn-freeze-buy')).not.toBeNull();
    await waitFor(() => expect(disabled(screen.getByTestId('lock-button'))).toBe(false));
    await user.click(screen.getByTestId('lock-button'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Lock/ }));
    await waitFor(() => expect(rig.requests[0]?.watcher).toBe(WATCHER));
    expect([...rig.chain.swaps.values()][0]!.watcherAddress).toBe(WATCHER);
  });

  it('with the default left alone the lock names no watcher', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: [row(1, { wZ: DAY })], settings, extra: { watcherInfo: async () => info } });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to buy', '0.5');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    await user.click(screen.getByTestId('lock-button'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Lock/ }));
    await waitFor(() => expect(rig.requests).toHaveLength(1));
    expect(rig.requests[0]!.watcher).toBeUndefined();
    expect([...rig.chain.swaps.values()][0]!.watcherAddress).toBeNull();
  });

  it('does not present a watcher as protection where it gives none', async () => {
    // A 1 h pause against a 1 h 40 min claim delay at depth 2: T_ff equals T_co.
    const rig = makeRig({ rows: [row(1, { wZ: 3600, dC: 6000 })], settings, extra: { watcherInfo: async () => info } });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    const option = await screen.findByTestId('watcher-option');
    expect(option.textContent).toMatch(/too short to add anything.*A watcher would give no protection here, so none is offered\./);
    expect(within(option).queryAllByRole('radio')).toHaveLength(0);
  });

  it('a watcher that answers with another key than the one pinned in Settings is refused', async () => {
    const rig = makeRig({ settings: { watcherUrl: 'https://my.watcher.example', watcherKey: TAKER }, extra: { watcherInfo: async () => info } });
    await mount(rig);
    await expect(rig.app.watcherFor('https://my.watcher.example')).rejects.toThrow(/not the one you pinned in Settings.*It was not used\./);
    expect(await rig.app.watcherFor('https://other.example')).toEqual(info);
  });
});

describe('11.6 at-risk logic and the changed warnings', () => {
  const note = { url: 'https://watch.site.example', solana: WATCHER, address: WATCHER };
  const ackFor = (s: SwapView, seed = WATCHER_SEED) => signWatchAck({ chain: s.chain, swapRef: s.swapRef, watchingUntil: Number(s.tLock) + 4200, watcherSeed: seed });

  async function watched(register: (s: SwapView) => Promise<ReturnType<typeof signWatchAck>>) {
    const rig = makeRig({ extra: { registerWatcher: async (_w, s) => register(s) } });
    const { ref } = rig.chain.open({ wZ: DAY, watcher: WATCHER });
    rig.app.engine.annotate(ref, { watcher: note, market: 'sol' });
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    await rig.pass();
    return { rig, ref };
  }

  it('without a watcher nothing changes: the red banner, the leave prompt, no early Safe to close', async () => {
    const rig = makeRig();
    rig.chain.open({ wZ: DAY });
    await mount(rig);
    rig.backup();
    await rig.pass();
    expect(screen.getByTestId('risk-banner')).toBeTruthy();
    expect(screen.queryByTestId('watched-banner')).toBeNull();
    expect(screen.queryByTestId('safe-banner')).toBeNull();
    expect(rig.env.unloadHandlers.size).toBe(1);
    expect(rig.app.safety()).toMatchObject({ watchedSafe: false, safeToClose: false });
  });

  it('item 3: a watcher that was named but has not acknowledged leaves the standing banner up', async () => {
    const { rig } = await watched(() => new Promise(() => undefined));
    expect(screen.getByTestId('risk-banner')).toBeTruthy();
    expect(screen.queryByTestId('watched-banner')).toBeNull();
    expect(rig.env.unloadHandlers.size).toBe(1);
    const pending = document.getElementById('watcher-pending')!;
    expect(pending.textContent).toMatch(/Waiting for the watcher to acknowledge this swap.*this swap is not watched: keep this tab open exactly as without a watcher, or you can lose your funds\./);
    expect(document.getElementById('watcher-ack')).toBeNull();
  });

  it('a watcher that fails to answer is shown as failing, and the swap stays unwatched', async () => {
    await watched(async () => Promise.reject(new Error('The watcher did not answer')));
    expect(document.getElementById('watcher-pending')!.textContent).toMatch(/The watcher has not acknowledged this swap.*The watcher did not answer\. The page keeps trying\./);
    expect(screen.getByTestId('risk-banner')).toBeTruthy();
  });

  it('an acknowledgement not signed by the key the swap names does not count', async () => {
    const { rig } = await watched(async (s) => ackFor(s, new Uint8Array(32).fill(9)));
    expect(rig.app.safety().watchedSafe).toBe(false);
    expect(screen.getByTestId('risk-banner')).toBeTruthy();
    expect(document.getElementById('watcher-pending')!.textContent).toMatch(/not with an acknowledgement signed by the key this swap names/);
  });

  it('item 8: with a verified acknowledgement the banner gives way to the qualified state, which says what remains at risk and by when to be back', async () => {
    const { rig, ref } = await watched(async (s) => ackFor(s));
    expect(screen.queryByTestId('risk-banner')).toBeNull();
    // Not the plain green: a state of its own.
    expect(screen.queryByTestId('safe-banner')).toBeNull();
    const banner = screen.getByTestId('watched-banner');
    expect(within(banner).getByText('Safe to close, with a watcher')).toBeTruthy();
    const s = rig.chain.swaps.get(ref)!;
    // Come back before: the earliest moment the maker's claim could open on a paused swap, less the margin.
    const before = comeBackBefore(s);
    expect(before).toBe(s.tActive + BigInt(DAY) - 300n);
    expect(screen.getByTestId('watched-text').textContent).toContain(watchedSafeText(formatTime(before, rig.chain.now_), '0.015 SOL'));
    expect(rig.env.unloadHandlers.size).toBe(0);
    expect(rig.env.doc.title).toBe('Safe to close, with a watcher · XMR atomic swaps');
    expect(document.getElementById('watcher-ack')!.textContent).toMatch(/Watcher acknowledged.*Its acknowledgement is signed by the key this swap names/);
    expect(rig.app.safety()).toMatchObject({ watchedSafe: true, safeToClose: false });

    // After the notice the time is counted from it; still qualified, still not green.
    rig.chain.advance(60);
    rig.chain.maker.notice(ref, TXID);
    await rig.pass();
    expect(comeBackBefore(rig.chain.swaps.get(ref)!)).toBe(rig.chain.swaps.get(ref)!.tNotice + BigInt(DAY) - 300n);
    expect(screen.getByTestId('watched-banner')).toBeTruthy();
    // Without the backup, never.
    expect(rig.app.safety()).toMatchObject({ watchedSafe: true });
  });

  it('once paused the swap needs the tab again: the banner counts down to the end of the pause', async () => {
    const { rig, ref } = await watched(async (s) => ackFor(s));
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirming', confirmations: 1 });
    await rig.pass();
    rig.chain.advance(1300);
    rig.chain.maker.watcherFreeze(ref);
    await rig.pass();
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.FROZEN);
    expect(screen.queryByTestId('watched-banner')).toBeNull();
    expect(screen.getByTestId('risk-banner')).toBeTruthy();
    const d = deadlinesOf('solana', rig.chain.swaps.get(ref)!);
    expect(rig.app.engine.get(ref)!.refundDeadline).toBe(d.tFf! - d.margin);
  });
});

describe('11.6 a paused swap (FROZEN)', () => {
  const note = { url: 'https://watch.site.example', solana: WATCHER, address: WATCHER };

  async function frozen(lock: 'good' | 'bad' | 'slow', by: 'watcher' | 'tab' = 'watcher') {
    const rig = makeRig({ extra: { registerWatcher: async () => new Promise(() => undefined) } });
    const { ref } = rig.chain.open({ wZ: DAY, watcher: WATCHER });
    rig.app.engine.annotate(ref, { watcher: note, market: 'sol' });
    rig.chain.advance(30);
    rig.chain.maker.notice(ref, TXID, lock !== 'bad');
    if (lock === 'good') rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    if (lock === 'slow') rig.monero.locks.set(TXID, { state: 'confirming', confirmations: 1 });
    return { rig, ref, by };
  }

  it('item 9, lock bad: on return the page checks the lock itself and refunds inside the pause, and says so', async () => {
    const { rig, ref } = await frozen('bad');
    // The tab was closed; the watcher paused the swap; the old claim time has long passed.
    rig.chain.maker.watcherFreeze(ref);
    const d0 = deadlinesOf('solana', rig.chain.swaps.get(ref)!);
    rig.chain.warpTo(d0.tCo! + 7200n);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.HOLD);
    expect(screen.getByText('This tab refunded by itself').closest('[role="status"]')!.textContent).toMatch(/The swap was paused, and when this tab checked the lock itself it did not check out, so the tab refunded inside the pause/);
  });

  it('item 9, lock good: a wrong pause is lifted by setting ready, and the page says why', async () => {
    const { rig, ref } = await frozen('good');
    rig.chain.maker.watcherFreeze(ref);
    rig.chain.advance(600);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'set_ready', 'session']]);
    expect(screen.getByText('The pause was lifted: the lock is good').closest('[role="status"]')!.textContent).toMatch(/checked the Monero lock itself on your nodes, found it confirmed, and set ready.*your deposit is not at stake/);
    expect(screen.getByTestId('safe-banner')).toBeTruthy();
  });

  it('shows who paused it and when, the time the pause ends with a countdown, and the two ways forward', async () => {
    const user = userEvent.setup();
    const { rig, ref } = await frozen('slow');
    rig.chain.advance(1300);
    rig.chain.maker.watcherFreeze(ref);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    const s = rig.chain.swaps.get(ref)!;
    const d = deadlinesOf('solana', s);
    const panel = screen.getByTestId('frozen');
    expect(within(panel).getByRole('heading', { name: 'This swap is paused' })).toBeTruthy();
    expect(panel.textContent).toContain(`Paused by the watcher you named`);
    expect(within(panel).getByTitle(WATCHER)).toBeTruthy();
    expect(panel.textContent).toContain(`at ${formatTime(s.tFreeze, rig.chain.now_)}`);
    expect(Number(within(panel).getByRole('timer').getAttribute('data-seconds-left'))).toBeGreaterThan(DAY - 1400);
    expect(panel.textContent).toContain(`At ${formatTime(d.tFf!, rig.chain.now_)}. To be safe a refund must be sent by ${formatTime(d.tFf! - d.margin, rig.chain.now_)}; after that, if the lock was false, your payment is lost.`);
    expect(panel.textContent).toMatch(/Confirm the lock\. If the pause was wrong and the maker's XMR lock is in fact good, the tab sets ready and the swap completes normally.*The lock is not confirmed yet; the tab keeps checking\./);
    expect(panel.textContent).toMatch(/Refund\. You get 1\.485 SOL back now\. The deposit of 0\.015 SOL is held for 30 minutes and, after a pause, the maker may always withhold it/);
    // The tab gives a valid but slow lock the window it was paused for; the user can still refund now.
    expect(rig.chain.calls).toEqual([]);
    await user.click(within(panel).getByRole('button', { name: 'Refund now' }));
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(screen.getByTestId('request-outcome').textContent).toMatch(/Refunded, as you asked/);
  });

  it('the user can pause from their own tab where the flow allows it, and it is recorded as theirs', async () => {
    const user = userEvent.setup();
    const { rig, ref } = await frozen('slow');
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    const control = screen.getByTestId('pause-control');
    expect(control.textContent).toMatch(/One pause, of up to 1 d: the maker cannot take your payment without your confirmation until it ends\. It moves no funds and reveals nothing.*A refund after a pause always leaves your deposit withholdable/);
    await user.click(within(control).getByRole('button', { name: 'Pause this swap' }));
    await rig.pass();
    expect(rig.chain.calls).toEqual([[ref, 'freeze', 'session']]);
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.FROZEN);
    expect(screen.getByTestId('frozen').textContent).toContain('Paused by this tab, at your request');
    // A swap is paused once.
    expect(screen.queryByTestId('pause-control')).toBeNull();
  });

  it('a swap that named no watcher offers no pause', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open({ wZ: DAY });
    rig.chain.maker.notice(ref, TXID);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    expect(rig.app.engine.get(ref)!.freezeRefusal).toBe('freeze-not-available');
    expect(screen.queryByTestId('pause-control')).toBeNull();
  });
});

// =====================================================================================  WALLET-DERIVED KEY

describe('11.3 wallet-derived key', () => {
  const SITE = 'swap.example.org';
  const signer = seedSigner(new Uint8Array(32).fill(5));
  const GENESIS = 'GenesisHash11111111111111111111111111111111';

  function walletRig(o: { site?: string; sign?: (m: Uint8Array) => Promise<Uint8Array>; chain?: ModelChain; noSignMessage?: boolean } = {}) {
    let signatures = 0;
    const rig = makeRig({
      ...(o.chain ? { chain: o.chain } : {}),
      settings: { walletKeySite: o.site ?? SITE },
      extra: { walletKeyChain: async () => ({ genesisHash: GENESIS, swaps: [...rig.chain.swaps.values()].map((v) => ({ swapNonce: v.swapNonce, takerSpendPub: v.takerSpendPub })) }) },
    });
    const connect = async () =>
      act(async () => {
        rig.app.setWallet('solana', {
          address: TAKER,
          signTransaction: async (tx) => tx,
          ...(o.noSignMessage ? {} : { signMessage: async (m: Uint8Array) => (signatures++, o.sign ? o.sign(m) : Uint8Array.from(await signer.sign(m))) }),
        });
      });
    return { rig, connect, count: () => signatures };
  }
  async function openChoice(rig: ReturnType<typeof makeRig>, connect: () => Promise<void>) {
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    await connect();
    fireEvent.click(await screen.findByText('Another way: use my wallet key (advanced, off by default)'));
    return screen.getByTestId('wallet-key');
  }

  it.each([
    [0, 'Anyone who obtains this signature, for example a phishing site that asks you to sign the same message, can take XMR you have not yet collected and act on your open swaps.'],
    [1, 'If you lose this wallet you lose access to those swaps unless you also export a recovery file.'],
    [2, `Only sign this message on ${SITE}.`],
  ])('warning %i is shown, in the exact words, before any signature', async (i, text) => {
    const { rig, connect, count } = walletRig();
    const box = await openChoice(rig, connect);
    const shown = within(within(box).getByTestId('wallet-key-warnings')).getAllByRole('listitem').map((li) => li.textContent);
    expect(shown[i]).toBe(text);
    expect(walletKeyWarnings(SITE)[i]).toBe(text);
    if (i < 2) expect(WALLET_KEY_WARNINGS[i]).toBe(text);
    expect(count()).toBe(0);
  });

  it('is off by default and separate from the recovery file; nothing is signed before the box is ticked', async () => {
    const { rig, connect, count } = walletRig();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    await connect();
    const details = await screen.findByTestId('wallet-key-details');
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole('button', { name: 'Create a recovery file' })).toBeTruthy();
    fireEvent.click(within(details).getByText(/Another way/));
    const box = screen.getByTestId('wallet-key');
    expect(disabled(within(box).getByRole('button', { name: 'Sign with my wallet to unlock' }))).toBe(true);
    expect(count()).toBe(0);
    expect(rig.app.vault.getState()).toMatchObject({ unlocked: false, mode: null });
  });

  it('a new wallet signs twice; identical signatures unlock, and the wallet then counts as the backup', async () => {
    const user = userEvent.setup();
    const { rig, connect, count } = walletRig();
    const box = await openChoice(rig, connect);
    await user.click(within(box).getByRole('checkbox'));
    await user.click(within(box).getByRole('button', { name: 'Sign with my wallet to unlock' }));
    await waitFor(() => expect(rig.app.vault.getState()).toMatchObject({ unlocked: true, backedUp: true, mode: 'wallet' }));
    expect(count()).toBe(2);
    // The lock gate is satisfied without a file, and the file is still on offer as an export.
    const backup = screen.getByTestId('backup');
    expect(backup.getAttribute('data-state')).toBe('saved');
    expect(backup.textContent).toMatch(/Wallet key.*Your wallet is the key: sign the same message on any device to resume\. Exporting a recovery file as well protects you if you lose the wallet\./);
    expect(within(backup).getByRole('button', { name: 'Export recovery file' })).toBeTruthy();
    const file = JSON.parse(rig.app.vault.fileText());
    expect(file).toMatchObject({ format: 'xmrswap-recovery/1', wallets: { solana: [TAKER], ethereum: [] } });
    expect(file.seed).toBe(Buffer.from(rig.app.vault.requireSeed()).toString('hex'));
  });

  it('a wallet that signs differently each time is refused in plain words, and nothing is unlocked', async () => {
    const user = userEvent.setup();
    let n = 0;
    // An Ed25519 signer that is valid but not deterministic does not exist for one key; a wallet that
    // rotates keys or adds a nonce to the message looks like this: two valid-looking, different answers.
    const other = seedSigner(new Uint8Array(32).fill(6));
    const { rig, connect } = walletRig({ sign: async (m) => Uint8Array.from(await (n++ === 0 ? signer : other).sign(m)) });
    const box = await openChoice(rig, connect);
    await user.click(within(box).getByRole('checkbox'));
    await user.click(within(box).getByRole('button', { name: 'Sign with my wallet to unlock' }));
    const alert = (await screen.findByText('The wallet key was not set up')).closest('[role="alert"]')!;
    expect(alert.textContent).toMatch(/Nothing was derived from it|gave two different signatures/);
    expect(rig.app.vault.getState().unlocked).toBe(false);
    expect(unlockErrorText({ code: 'NonDeterministicSigner' })).toMatch(/gave two different signatures for the same message\. A key made from it could never be made again, so your swaps would be lost: the wallet cannot be used this way\. Use a recovery file\./);
  });

  it('a returning user on a fresh browser profile signs once; the key is proved against the swaps found on-chain and they resume', async () => {
    const user = userEvent.setup();
    // First profile: set the key up and open a swap with it.
    const first = walletRig();
    await mount(first.rig);
    await first.connect();
    await act(async () => {
      await first.rig.app.unlockWalletKey();
    });
    const { ref } = first.rig.chain.open({ seed: first.rig.app.vault.requireSeed() });
    first.rig.chain.maker.notice(ref, TXID);
    first.rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    first.rig.app.stop();
    first.rig.chain.advance(300);

    // A new profile: no storage at all, only the wallet.
    localStorage.clear();
    sessionStorage.clear();
    const again = walletRig({ chain: first.rig.chain });
    again.rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    const box = await openChoice(again.rig, again.connect);
    await user.click(within(box).getByRole('checkbox'));
    await user.click(within(box).getByRole('button', { name: 'Sign with my wallet to unlock' }));
    await waitFor(() => expect(again.rig.app.vault.getState().mode).toBe('wallet'));
    expect(again.count()).toBe(1);
    await again.rig.pass();
    // The swap was found by the wallet's address and continued with the re-derived session key.
    expect(first.rig.chain.calls).toEqual([[ref, 'set_ready', 'session']]);
  });

  it('a wallet whose swaps were opened with other keys is refused and told to load the recovery file', async () => {
    const user = userEvent.setup();
    const { rig, connect } = walletRig();
    rig.chain.open();
    const box = await openChoice(rig, connect);
    await user.click(within(box).getByRole('checkbox'));
    await user.click(within(box).getByRole('button', { name: 'Sign with my wallet to unlock' }));
    const alert = (await screen.findByText('The wallet key was not set up')).closest('[role="alert"]')!;
    expect(alert.textContent).toMatch(/does not produce the keys of the swaps this wallet already has on-chain.*load the recovery file to resume them\. Nothing was changed\./);
    expect(rig.app.vault.getState().unlocked).toBe(false);
  });

  it('is shown as unavailable, with the reason, while the release has not fixed the site name', async () => {
    const { rig, connect, count } = walletRig({ site: '' });
    const box = await openChoice(rig, connect);
    expect(document.getElementById('wallet-key-unavailable')!.textContent).toMatch(/Not available yet.*has not yet fixed the site name that goes into the signed message.*Use a recovery file\./);
    expect(within(box).queryByRole('button', { name: 'Sign with my wallet to unlock' })).toBeNull();
    expect(within(box).queryByRole('checkbox')).toBeNull();
    await expect(rig.app.unlockWalletKey()).rejects.toThrow(/Not available in this release/);
    expect(count()).toBe(0);
    // The placeholder of the protocol package is never used as a site name.
    expect(rig.app.settings.get().walletKeySite).toBe('');
  });

  it('checks the Wallet Standard feature: a wallet that cannot sign a message is told so', async () => {
    const { rig, connect } = walletRig({ noSignMessage: true });
    const box = await openChoice(rig, connect);
    expect(document.getElementById('wallet-key-unavailable')!.textContent).toBe(UNAVAILABLE_TEXT['no-sign-message']);
    expect(UNAVAILABLE_TEXT['no-sign-message']).toMatch(/solana:signMessage is missing/);
    expect(disabled(within(box).getByRole('checkbox'))).toBe(true);
    expect(walletKeyUnavailable(SITE, null)).toBe('no-wallet');
    expect(walletKeyUnavailable(SITE, { signMessage: () => undefined })).toBeNull();
  });

  it('says so before asking when the page is neither the named site nor loopback', () => {
    expect(siteProblem('localhost', SITE)).toBeNull();
    expect(siteProblem(SITE, SITE)).toBeNull();
    expect(siteProblem('evil.example', SITE)).toMatch(new RegExp(SITE.replace(/\./g, '\\.')));
  });
});

// =====================================================================================  RELEASE

describe('11.5 the release panel on the Status page', () => {
  // The Status page talks to whatever RPC is configured; these tests are about the release panel only.
  const NO_RPC = { solanaRpc: '' };
  const served = (status: 'development-snapshot' | 'release') => ({
    format: 'xmrswap-served/1' as const,
    ui: { tree_hash: 'aa'.repeat(32), files: 6, bytes: 2_987_889 },
    recorded: true,
    release: { version: 'dev-snapshot', status, commit: 'c0ffee'.padEnd(40, '0'), commit_time: '2026-11-27T18:01:38Z', program_id: '5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u', contract: null, chain_id: null, web_tree_hash: 'aa'.repeat(32), program_executable_hash: 'ed'.repeat(32), program_hash_source: 'docker' as const },
  });

  it('with no record says "No release record" and how to check', async () => {
    const rig = makeRig({ settings: NO_RPC });
    await mount(rig, '#/status');
    const panel = await screen.findByTestId('release');
    expect((await within(panel).findByText('No release record')).closest('.notice')!.textContent).toMatch(/does not say which build these files are/);
    expect(panel.textContent).toMatch(/pnpm --filter @xmrswap\/deploy run verify/);
    expect(panel.textContent).toMatch(/solana-verify get-program-hash 5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u/);
  });

  it('shows version, commit, UI tree hash, program id and executable hash, and says "development snapshot" plainly', async () => {
    const rig = makeRig({ release: served('development-snapshot'), settings: NO_RPC });
    await mount(rig, '#/status');
    const panel = await screen.findByTestId('release');
    expect((await within(panel).findByText('Development snapshot')).closest('.notice')!.textContent).toMatch(/This is a development snapshot, not a release/);
    const text = panel.textContent!;
    expect(text).toContain('dev-snapshot');
    expect(text).toContain('c0ffee'.padEnd(40, '0'));
    expect(text).toContain('aa'.repeat(32));
    expect(text).toContain('ed'.repeat(32));
    expect(text).toMatch(/The same id this page is set to use\. It is the id pinned in this code\./);
    expect(text).toMatch(/From the reproducible Docker build\./);
    // What the page did not check itself is labelled as the server's word.
    expect(text).toMatch(/As reported by the server for the 6 files it serves\..*Not checked by this page\./);
    expect(text).toMatch(/None: no published build is pinned in this code yet\./);
    expect(within(panel).getByTestId('program-build').textContent).toMatch(/Computed by this page from the chain\. There is no published build to compare with/);
    expect(text).not.toMatch(/\bverified\b/i);
  });

  it('a deployed program that is not the expected build is a red warning and disables locking', async () => {
    const user = userEvent.setup();
    const mismatch = { status: 'mismatch' as const, hash: '11'.repeat(32), published: 'ed'.repeat(32) };
    const status = makeRig({ release: served('release'), programBuild: mismatch, settings: NO_RPC });
    await mount(status, '#/status');
    const build = await screen.findByTestId('program-build');
    await waitFor(() => expect(build.getAttribute('data-status')).toBe('mismatch'));
    expect(build.textContent).toMatch(/it is NOT the build this page expects\. The page and the chain disagree, so locking is disabled\./);
    expect(build.querySelector('.text-danger-text')).not.toBeNull();
    status.app.stop();
    cleanup();

    const rig = makeRig({ programBuild: mismatch });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await review(user, 'XMR to buy', '1');
    await user.type(screen.getByLabelText('Your XMR address'), DEST);
    await waitFor(() => expect(screen.getByText(PROGRAM_MISMATCH)).toBeTruthy());
    expect(disabled(screen.getByTestId('lock-button'))).toBe(true);
    await expect(rig.app.openSwap({ row: rig.rows[0]!, xmr: XMR, destination: DEST, acknowledged: true })).rejects.toThrow(/not the build this page expects/);
    expect(rig.opened).toEqual([]);
  });

  it('a matching program says so as something this page computed', async () => {
    const rig = makeRig({ release: served('release'), programBuild: { status: 'match', hash: 'ed'.repeat(32), published: 'ed'.repeat(32) }, settings: NO_RPC });
    await mount(rig, '#/status');
    await waitFor(() => expect(screen.getByTestId('program-build').textContent).toMatch(/Computed by this page from the chain: it matches the published build\./));
  });

  it('accepts only the served-record shape', () => {
    expect(parseServedRelease(served('release'))).not.toBeNull();
    expect(parseServedRelease({ ...served('release'), release: null })).toMatchObject({ release: null });
    for (const bad of [null, 'x', {}, { format: 'other' }, { format: 'xmrswap-served/1', ui: { tree_hash: 'short' }, release: null }]) expect(parseServedRelease(bad)).toBeNull();
  });
});
