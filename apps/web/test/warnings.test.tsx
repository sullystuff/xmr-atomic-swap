// The mandatory warnings: every item of DESIGN "Warnings the interface must show" and of SPEC 8.5
// has its own test here. They run the real React tree over a chain that follows the reference
// state machine; nothing is mocked at the component level.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { deadlinesOf } from '@xmrswap/sdk';
import { formatClock, formatTime } from '../src/lib/format.js';
import { BACKUP_BLOCKER, lockBlockers } from '../src/lib/gates.js';
import { MODE_INFO, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { type OfferWarning, offerWarnings, solanaRow } from '../src/lib/market.js';
import { CONFIRM_TEXT } from '../src/ui/ConfirmLock.js';
import { CONTACT_WARNING } from '../src/pages/MakerPage.js';
import { SOL, T0, XMR, offer, profile, row } from './fakes.js';
import { SWAP_STATE } from '@xmrswap/protocol';
import { DEST, makeRig, mount, seedWithoutBackup } from './harness.js';

const TXID = 'ab'.repeat(32);
const LOSS = /lose|lost/i;
const disabled = (el: HTMLElement): boolean => (el as HTMLButtonElement | HTMLInputElement).disabled;

async function fillReview(user: ReturnType<typeof userEvent.setup>, xmr = '2') {
  await user.type(await screen.findByLabelText('XMR to buy'), xmr);
  await user.type(screen.getByLabelText('Your XMR address'), DEST);
}

describe('1. Confirmation before locking', () => {
  it('is a full-screen dialog with the exact words, the expected duration and the deadline time, and nothing is locked until the box is ticked', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await fillReview(user);
    const lock = screen.getByTestId('lock-button');
    await waitFor(() => expect(disabled(lock)).toBe(false));
    expect(screen.queryByTestId('confirm-lock')).toBeNull();
    await user.click(lock);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveProperty('className', 'fullscreen');
    const confirm = within(dialog);
    expect(confirm.getByRole('heading', { level: 1 }).textContent).toBe(CONFIRM_TEXT);
    expect(CONFIRM_TEXT).toBe('Keep this tab open until it says Safe to close. If you close it, let the computer sleep or lose your connection before then, you can lose your funds.');
    // Expected duration: (depth 2 + 1) × 120 s. Deadline: notice window + claim delay from now, on the chain's clock.
    expect(confirm.getByText('Expected duration').parentElement!.textContent).toContain('6 min');
    expect(confirm.getByText(/Stay until Safe to close, at the latest/).parentElement!.textContent).toContain(formatTime(T0 + 600n + 3600n, T0));
    // The offer's own warnings are repeated here.
    expect(confirm.getByText(/After 1 h the maker can take your payment even if you have not confirmed/)).toBeTruthy();

    const go = confirm.getByRole('button', { name: 'Lock 3.00 SOL' });
    expect(disabled(go)).toBe(true);
    expect(rig.opened).toEqual([]);
    await user.click(confirm.getByRole('checkbox'));
    expect(disabled(go)).toBe(false);
    await user.click(go);
    await waitFor(() => expect(rig.opened).toEqual([{ offer: rig.rows[0]!.id, xmr: 2n * XMR }]));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/swap\/[1-9A-HJ-NP-Za-km-z]+$/));
  });

  it('going back locks nothing, and the box is unticked again the next time', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await fillReview(user);
    await user.click(screen.getByTestId('lock-button'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Go back' }));
    expect(rig.opened).toEqual([]);
    await user.click(screen.getByTestId('lock-button'));
    expect((within(screen.getByRole('dialog')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('the application refuses a lock that was not acknowledged, whatever the screen did', async () => {
    const rig = makeRig();
    await mount(rig);
    rig.backup();
    await expect(rig.app.openSwap({ row: rig.rows[0]!, xmr: XMR, destination: DEST, acknowledged: false })).rejects.toThrow(/you can lose your funds/);
    expect(rig.opened).toEqual([]);
  });

  it('a refused lock is reported as "nothing was locked" and leaves the dialog open', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await fillReview(user);
    await user.click(screen.getByTestId('lock-button'));
    rig.failOpen.message = 'The maker changed the terms of this offer after you reviewed them. Nothing was locked; review the new terms.';
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Lock/ }));
    expect((await screen.findByText('Nothing was locked')).closest('[role="alert"]')!.textContent).toMatch(/changed the terms/);
    expect(rig.chain.swaps.size).toBe(0);
  });
});

describe('2. Backup first', () => {
  it('the lock button stays disabled, with the reason, until the recovery file is downloaded and confirmed', async () => {
    const user = userEvent.setup();
    const rig = makeRig();
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    await fillReview(user);
    const lock = screen.getByTestId('lock-button');
    expect(disabled(lock)).toBe(true);
    expect(screen.getByText(BACKUP_BLOCKER)).toBeTruthy();
    expect(BACKUP_BLOCKER).toMatch(/cannot be refunded or collected/);

    // Creating the seed is not a backup.
    await user.click(screen.getByRole('button', { name: 'Create a recovery file' }));
    expect(disabled(lock)).toBe(true);
    // The confirmation box cannot be ticked before the download.
    const saved = screen.getByRole('checkbox', { name: /I saved the recovery file/ });
    expect(disabled(saved)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Download recovery file' }));
    await waitFor(() => expect(disabled(saved)).toBe(false));
    // Downloaded but not confirmed: still no lock.
    expect(disabled(lock)).toBe(true);
    await user.click(saved);
    await waitFor(() => expect(disabled(lock)).toBe(false));
    expect(screen.queryByText(BACKUP_BLOCKER)).toBeNull();
  });

  it('the gate lists the backup first and the application refuses to open a swap without it', async () => {
    expect(lockBlockers({ backedUp: false, chain: 'solana', walletConnected: true, settings: { ...DEFAULT_SETTINGS, solanaRpc: 'http://x', moneroNodes: ['http://a', 'http://b'] }, inputError: null, offerProblem: null })).toEqual([BACKUP_BLOCKER]);
    const rig = makeRig();
    await mount(rig);
    await expect(rig.app.openSwap({ row: rig.rows[0]!, xmr: XMR, destination: DEST, acknowledged: true })).rejects.toThrow(/Save your recovery file first/);
    expect(rig.opened).toEqual([]);
  });

  it('a seed loaded from a recovery file counts as backed up; a wrong passphrase does not load', async () => {
    const a = makeRig();
    await mount(a);
    a.backup();
    const plain = a.app.vault.fileText();
    const sealed = a.app.vault.fileText('correct horse');
    sessionStorage.clear();
    localStorage.clear();
    const b = makeRig();
    await act(async () => {
      await b.app.vault.init();
    });
    expect(() => b.app.vault.load(sealed, 'wrong')).toThrow(/does not open/);
    expect(b.app.vault.getState().backedUp).toBe(false);
    act(() => void b.app.vault.load(sealed, 'correct horse'));
    expect(b.app.vault.getState()).toMatchObject({ backedUp: true, tag: a.app.vault.getState().tag });
    expect(JSON.parse(plain)).toMatchObject({ format: 'xmrswap-recovery/1' });
  }, 60_000);
});

describe('3. Standing banner', () => {
  it('is red, reads "Do not close this tab" with a countdown to the refund deadline, and the tab title shows the same', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    const banner = screen.getByTestId('risk-banner');
    expect(banner).toHaveProperty('className', 'banner banner-risk');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(within(banner).getByText('Do not close this tab')).toBeTruthy();
    const d = deadlinesOf('solana', rig.chain.swaps.get(ref)!);
    const left = Number(d.tCo! - d.margin - rig.chain.now_);
    // The countdown runs on the chain's clock; the local second may have ticked since the read.
    const shown = within(banner).getByRole('timer').textContent!;
    expect([formatClock(left), formatClock(left - 1)]).toContain(shown);
    expect(banner.textContent).toMatch(/you can lose your funds/);
    expect(rig.env.doc.title).toBe(`Do not close this tab: ${shown} left`);
  });

  it('is up for an active swap before the notice and gone once every leg is Ready or Refunded', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    await mount(rig);
    rig.backup();
    expect(screen.getByTestId('risk-banner')).toBeTruthy();
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    await rig.pass();
    expect(screen.queryByTestId('risk-banner')).toBeNull();
    expect(rig.env.doc.title).not.toMatch(/Do not close/);
  });

  it('a pending lock raises no banner: it is safe to close', async () => {
    const rig = makeRig();
    rig.chain.open({ mode: 1 });
    await mount(rig);
    rig.backup();
    await rig.pass();
    expect(screen.queryByTestId('risk-banner')).toBeNull();
    expect(screen.getByTestId('safe-banner')).toBeTruthy();
  });
});

describe('4. Leave-page prompt', () => {
  it('a beforeunload confirmation is armed exactly while a leg is at risk', async () => {
    const rig = makeRig();
    await mount(rig);
    rig.backup();
    expect(rig.env.unloadHandlers.size).toBe(0);
    const { ref } = rig.chain.open();
    await rig.pass();
    expect(rig.env.unloadHandlers.size).toBe(1);
    // The handler asks the browser to confirm: it cancels the event and sets a return value.
    const event = { preventDefault: () => void (event.prevented = true), prevented: false, returnValue: '' as string };
    const answer = [...rig.env.unloadHandlers][0]!(event as unknown as BeforeUnloadEvent);
    expect(event.prevented).toBe(true);
    expect(event.returnValue).toMatch(/you can lose your funds/);
    expect(answer).toBe(event.returnValue);

    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    await rig.pass();
    // Ready: leaving is safe, so the prompt is disarmed.
    expect(rig.env.unloadHandlers.size).toBe(0);
  });
});

describe('5. Keep awake', () => {
  it('requests the Screen Wake Lock while a leg is at risk, says so, and releases it afterwards', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    await mount(rig);
    rig.backup();
    await rig.pass();
    expect(rig.env.wakeRequests).toBe(1);
    await waitFor(() => expect(screen.getByTestId('risk-banner').textContent).toContain('The screen is being kept on.'));
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    await rig.pass();
    expect(rig.env.released).toBe(1);
  });

  it('where the browser cannot keep the screen on, the banner tells the user to do it', async () => {
    const rig = makeRig({ wakeLock: false });
    rig.chain.open();
    await mount(rig);
    await waitFor(() => expect(screen.getByTestId('risk-banner').textContent).toContain('This browser cannot keep the screen on: turn off sleep yourself.'));
    expect(rig.app.guard.getStatus().wakeLock).toBe('unsupported');
  });

  it('the confirmation recommends a desktop computer, and insists on it for a large swap', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: [row(1, { depths: Uint8Array.of(25, 0, 0) })] });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    rig.backup();
    await fillReview(user, '60');
    await user.click(screen.getByTestId('lock-button'));
    expect(screen.getByRole('dialog').textContent).toMatch(/The page asks the browser to keep the screen on\. For a swap this size use a desktop computer on mains power/);
  });
});

describe('6. Connection alarm', () => {
  it('a dropped Solana connection during an at-risk swap sounds the alarm and notifies with the time left', async () => {
    const rig = makeRig();
    rig.chain.open();
    await mount(rig);
    rig.backup();
    await rig.pass();
    expect(rig.env.beeps).toBe(0);
    rig.chain.down = true;
    await rig.pass();
    expect(rig.env.beeps).toBe(1);
    expect(rig.env.notes).toHaveLength(1);
    const [title, body] = rig.env.notes[0]!;
    expect(title).toBe('Connection lost during a swap');
    expect(body).toMatch(/^The Solana connection dropped\. (10 min|9 min \d\d s) left before the refund deadline\. If it does not come back in time you can lose your funds\.$/);
    expect((await screen.findByText('Connection lost while a swap is at risk')).closest('[role="alert"]')!.textContent).toContain(body);

    // It keeps sounding every 30 seconds while the connection is down, without repeating the notification.
    const t = Date.now();
    act(() => rig.app.guard.update(rig.app.engine.getState(), rig.app.safety(), t + 31_000));
    expect(rig.env.beeps).toBe(2);
    expect(rig.env.notes).toHaveLength(1);

    rig.chain.down = false;
    await rig.pass();
    expect(rig.app.guard.getStatus().alarm).toBeNull();
    expect(screen.queryByText('Connection lost while a swap is at risk')).toBeNull();
  });

  it('a dropped Monero connection raises it too; with nothing at risk there is no alarm', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    await mount(rig);
    rig.backup();
    await rig.pass();
    expect(rig.env.beeps).toBe(0);
    rig.monero.down = true;
    await rig.pass();
    expect(rig.env.beeps).toBe(1);
    expect(rig.env.notes[0]![1]).toMatch(/^The Monero connection dropped\./);

    const calm = makeRig();
    calm.chain.open({ mode: 1 });
    await mount(calm);
    calm.chain.down = true;
    await calm.pass();
    expect(calm.env.beeps).toBe(0);
    expect(calm.env.notes).toEqual([]);
  });
});

describe('7. Automatic refund', () => {
  it('if the lock is not at depth at the cutoff the tab refunds by itself with the session key, and says so', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirming', confirmations: 1 });
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    const d = deadlinesOf('solana', rig.chain.swaps.get(ref)!);
    // The swap page announces the cutoff before it happens.
    expect(screen.getByLabelText('Refund deadline').textContent).toContain(`If the lock is not confirmed by ${formatTime(d.tCut!, rig.chain.now_)} the tab refunds by itself.`);
    rig.chain.warpTo(d.tCut! - 1n);
    await rig.pass();
    expect(rig.chain.calls).toEqual([]);
    rig.chain.warpTo(d.tCut!);
    await rig.pass();
    // Signed by the session key: no wallet was involved.
    expect(rig.chain.calls).toEqual([[ref, 'refund', 'session']]);
    expect(screen.getByText('This tab refunded by itself').closest('[role="status"]')!.textContent).toMatch(/had not reached the required depth by the safety cutoff/);
    expect(screen.queryByTestId('risk-banner')).toBeNull();
  });
});

describe('8. Safe to close', () => {
  it('is green and appears only when every leg is Ready, Claimed or Refunded and the backup exists; Ready adds when to come back', async () => {
    const rig = makeRig();
    const a = rig.chain.open();
    const b = rig.chain.open();
    for (const x of [a, b]) rig.chain.maker.notice(x.ref, x === a ? TXID : 'cd'.repeat(32));
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.monero.locks.set('cd'.repeat(32), { state: 'confirming', confirmations: 1 });
    rig.chain.advance(120);
    await mount(rig);
    rig.backup();
    await rig.pass();
    // One leg Ready, one still at risk: not safe.
    expect(screen.queryByTestId('safe-banner')).toBeNull();
    expect(screen.getByTestId('risk-banner')).toBeTruthy();

    rig.monero.locks.set('cd'.repeat(32), { state: 'confirmed', confirmations: 2 });
    await rig.pass();
    const safe = screen.getByTestId('safe-banner');
    expect(safe).toHaveProperty('className', 'banner banner-safe');
    expect(within(safe).getByText('Safe to close')).toBeTruthy();
    const d = deadlinesOf('solana', rig.chain.swaps.get(a.ref)!);
    expect(safe.textContent).toContain(`If the maker does not complete, come back before ${formatTime(d.tFinal - d.margin, rig.chain.now_)} to refund.`);
    expect(rig.env.doc.title).toBe('Safe to close · XMR atomic swaps');

    // Claimed (the XMR waits at the joint address) is still safe.
    rig.chain.maker.claim(a.ref);
    await rig.pass();
    expect(screen.getByTestId('safe-banner')).toBeTruthy();
  });

  it('is never shown without the backup, or while the chain cannot be seen', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    rig.monero.locks.set(TXID, { state: 'confirmed', confirmations: 2 });
    rig.chain.advance(120);
    // A seed exists in the tab but the file was never confirmed as saved.
    seedWithoutBackup();
    await mount(rig);
    expect(rig.chain.swaps.get(ref)!.state).toBe(SWAP_STATE.READY);
    expect(rig.app.vault.getState()).toMatchObject({ unlocked: true, backedUp: false });
    expect(screen.queryByTestId('safe-banner')).toBeNull();
    rig.backup();
    await rig.pass();
    expect(screen.getByTestId('safe-banner')).toBeTruthy();
    rig.chain.down = true;
    await rig.pass();
    expect(screen.queryByTestId('safe-banner')).toBeNull();
  });
});

describe('9. On return', () => {
  it('a reopened tab resumes at once and refunds what is still refundable, with no click', async () => {
    const first = makeRig();
    const { ref } = first.chain.open();
    first.chain.maker.notice(ref, TXID);
    await mount(first);
    first.backup();
    first.app.stop();

    // The tab was gone past the cutoff. A new tab (same session storage: a reload) starts.
    const d = deadlinesOf('solana', first.chain.swaps.get(ref)!);
    first.chain.warpTo(d.tCut! + 60n);
    const again = makeRig({ chain: first.chain, kv: first.kv });
    window.location.hash = `#/swap/${ref}`;
    await act(async () => {
      await again.app.start();
      await again.app.engine.poll();
    });
    expect(first.chain.calls).toEqual([[ref, 'refund', 'session']]);
  });

  it('states plainly what was lost when a deadline passed while the tab was away', async () => {
    const rig = makeRig();
    const { ref } = rig.chain.open();
    rig.chain.maker.notice(ref, TXID);
    const d = deadlinesOf('solana', rig.chain.swaps.get(ref)!);
    // The maker announced a lock that never existed and claimed at its claim delay.
    rig.chain.warpTo(d.tCo!);
    rig.chain.maker.claim(ref);
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    const alert = screen.getByText('A deadline passed while this tab was away').closest('[role="alert"]')!;
    expect(alert.textContent).toMatch(/the maker took your payment without your confirmation\. The XMR lock it announced does not check out, so there is nothing to collect: your payment is lost\./);
  });

  it('with swaps open and no seed loaded it says so at once, with the consequence', async () => {
    const rig = makeRig();
    rig.chain.open();
    await mount(rig);
    const alert = (await screen.findByText('Swaps are open but the recovery seed is not loaded')).closest('[role="alert"]')!;
    expect(alert.textContent).toMatch(/If a refund deadline passes first you can lose your funds/);
    expect(rig.chain.calls).toEqual([]);
  });
});

describe('10. Offer-specific warnings before locking (SPEC 8.5 item 10)', () => {
  const base = { xmr: 2n * XMR, minDepth: 0, upgrade: { frozen: true as boolean | null, authority: null } };
  const of = (o: Parameters<typeof offer>[1], extra: Partial<Parameters<typeof offerWarnings>[0]> = {}): Record<string, OfferWarning> => {
    const p = profile(1);
    const r = solanaRow('offer', offer(p.pda, o), p, null);
    const xmr = extra.xmr ?? base.xmr;
    return Object.fromEntries(offerWarnings({ ...base, row: r, pricing: r.price(xmr), ...extra }).map((w) => [w.id, w]));
  };

  it('approval window above 60 s: how long funds may be held', () => {
    expect(of({ mode: 1, wA: 60 })['approval-window']).toBeUndefined();
    expect(of({ mode: 0, wA: 600 })['approval-window']).toBeUndefined();
    const w = of({ mode: 1, wA: 300 })['approval-window']!;
    expect(w.title).toBe('This maker can take up to 5 min to approve');
    expect(w.text).toMatch(/Your 3\.00 SOL is locked in escrow while you wait, for up to 5 min, and you cannot use it/);
  });

  it('claim delay and its consequence', () => {
    const w = of({ dC: 6060 })['claim-delay']!;
    expect(w.title).toBe('After 1 h 41 min the maker can take your payment even if you have not confirmed');
    expect(w.text).toMatch(/you lose your 3\.00 SOL/);
  });

  it('deposit: the amount that can be withheld and lost', () => {
    expect(of({ depBps: 0 }).deposit).toBeUndefined();
    const w = of({ depBps: 200 }).deposit!;
    expect(w.title).toBe('Deposit: 2% of your payment');
    expect(w.text).toContain('If you cancel or refund after approval, up to 0.06 SOL can be withheld for up to 60 days and half of it lost.');
  });

  it('USDC markets: the issuer can freeze it', () => {
    expect(of({})['usdc-freeze']).toBeUndefined();
    const w = of({ asset: 1, price: 150_000_000n })['usdc-freeze']!;
    expect(w.text).toContain('The issuer can freeze USDC mid-swap; a freeze can strand funds.');
    expect(w.text).toMatch(LOSS);
  });

  it('upgrade status of the contract: upgradable, unknown, and nothing when immutable', () => {
    expect(of({}).upgradable).toBeUndefined();
    const up = of({}, { upgrade: { frozen: false, authority: 'Auth111' } }).upgradable!;
    expect(up.title).toBe('The Solana program can still be upgraded');
    expect(up.text).toMatch(/held by the project owner \(Auth111\).*you could lose them/);
    expect(of({}, { upgrade: { frozen: null, authority: null } })['upgrade-unknown']!.text).toMatch(/you could lose funds in escrow/);
  });

  it("depth below the user's own minimum, and below the protocol's tier for the size", () => {
    // 2 confirmations at 0.5 XMR meets the protocol tier (2 below 1 XMR).
    expect(of({}, { xmr: XMR / 2n }).depth).toBeUndefined();
    // The same offer at 2 XMR needs 10.
    expect(of({}).depth!.title).toBe('Only 2 Monero confirmations; your minimum for this size is 10');
    // The user's own minimum is stricter than the tier.
    const w = of({}, { xmr: XMR / 2n, minDepth: 6 }).depth!;
    expect(w.title).toBe('Only 2 Monero confirmations; your minimum for this size is 6');
    expect(w.text).toMatch(/you would lose your 0\.75 SOL/);
  });

  it('selling XMR: one transaction, exact amount, own wallet, refund address, and what closing the tab costs', () => {
    const w = of({ direction: 1 })['sell-terms']!;
    expect(w.text).toMatch(/send one transaction for at least the exact amount to exactly that address before the time shown, from a wallet you control, not an exchange withdrawal/);
    expect(w.text).toContain('If you close this tab the swap unwinds when the maker refunds; your XMR is recoverable with the recovery file, and your deposit can be withheld');
  });

  it('they are on the review page before the lock button can be used', async () => {
    const user = userEvent.setup();
    const rig = makeRig({ rows: [row(1, { mode: 1, wA: 300, depBps: 200 })] });
    await mount(rig, `#/swap/new/${rig.rows[0]!.id}`);
    await fillReview(user);
    for (const id of ['approval-window', 'claim-delay', 'deposit', 'upgradable', 'depth']) expect(document.getElementById(`review-warn-${id}`), id).not.toBeNull();
    expect(disabled(screen.getByTestId('lock-button'))).toBe(true);
  });
});

describe('Consequences, not just instructions', () => {
  it('every warning the interface can raise says that funds can be lost (or, for a pending lock, held)', () => {
    const p = profile(1);
    const all = [
      ...offerWarnings({ row: solanaRow('o', offer(p.pda, { mode: 1, wA: 300, asset: 1, price: 150_000_000n, depBps: 300 }), p, null), pricing: { amount: 300_000_000n, deposit: 9_000_000n, depth: 2 }, xmr: 2n * XMR, minDepth: 30, upgrade: { frozen: false, authority: null } }),
      ...offerWarnings({ row: solanaRow('o', offer(p.pda, { direction: 1 }), p, null), pricing: { amount: 3n * SOL, deposit: SOL / 100n, depth: 25 }, xmr: 2n * XMR, minDepth: 0, upgrade: { frozen: null, authority: null } }),
    ];
    expect(all.map((w) => w.id).sort()).toEqual(['approval-window', 'claim-delay', 'deposit', 'depth', 'sell-terms', 'upgradable', 'upgrade-unknown', 'usdc-freeze']);
    for (const w of all) {
      if (w.id === 'approval-window') expect(w.text, w.id).toMatch(/locked in escrow/);
      else expect(w.text, w.id).toMatch(LOSS);
    }
    for (const text of [CONFIRM_TEXT, BACKUP_BLOCKER, CONTACT_WARNING]) expect(text).toMatch(/lose your funds|cannot be refunded or collected|nobody legitimate asks for a seed phrase or key share/);
    // Each connection mode says who learns the user's IP.
    for (const m of Object.values(MODE_INFO)) expect(m.learnsIp.length).toBeGreaterThan(20);
  });
});
