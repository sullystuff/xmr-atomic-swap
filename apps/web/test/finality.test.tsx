// tests/e2e/BUGS.md O3: selling XMR on Ethereum, the pay address appeared minutes after the maker
// funded. Reproduced here deterministically: the page acts on finalized state only (required: the
// taker must not pay XMR against a deposit that can be reorganised away), and on a chain whose
// finalized tag does not move the funded swap stays invisible to the flow. The page must say what
// it is waiting for; and the maker's key proof must neither block a pass nor be re-fetched.
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SWAP_STATE } from '@xmrswap/protocol';
import { type SwapView, deadlinesOf, init } from '@xmrswap/sdk';
import { Engine, finalityEta } from '../src/lib/engine.js';
import { expectedSecs, offerWarnings, solanaRow } from '../src/lib/market.js';
import { safetyOf } from '../src/lib/safety.js';
import { FakeMonero, ModelChain, TAKER, TAKER_SEED, XMR, offer, profile } from './fakes.js';
import { makeRig, mount } from './harness.js';

await init();
type Proof = { ok: true } | { ok: false } | { retry: string };

function ethRig(proof: (s: SwapView) => Promise<Proof>, proofTimeoutMs?: number) {
  const eth = new ModelChain('ethereum');
  eth.lagging = true;
  const sol = new ModelChain('solana');
  const monero = new FakeMonero();
  let clock = 1_000_000;
  const calls = { proof: 0 };
  const engine = new Engine({
    ports: () => ({ solana: sol, ethereum: eth }),
    monero,
    seed: () => TAKER_SEED,
    takers: () => ({ solana: [TAKER], ethereum: [TAKER] }),
    network: () => 'mainnet',
    makerProof: (s) => (calls.proof++, proof(s)),
    nowMs: () => clock,
    ...(proofTimeoutMs !== undefined ? { proofTimeoutMs } : {}),
  });
  const of = (ref: string) => engine.get(ref)!;
  return { eth, sol, monero, engine, of, calls, tick: (ms: number) => void (clock += ms) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('O3: a funded Ethereum sell and the finalized tag', () => {
  it('the flow sees the funding only when it is final; until then the engine reports what it is waiting for and for how long', async () => {
    const r = ethRig(async () => ({ ok: true }));
    const { ref } = r.eth.open({ direction: 1, wA: 3600 });
    r.eth.finalize();
    await r.engine.poll();
    expect(r.of(ref)).toMatchObject({ pending: null, leg: 'pending-approval' });

    // The maker funds. The block is mined but not final: finality trails the head by 15 minutes.
    r.eth.advance(900);
    r.eth.finalize();
    r.eth.advance(900);
    r.eth.maker.fund(ref);
    for (let i = 0; i < 5; i++) await r.engine.poll();
    const t = r.of(ref);
    // Nothing is decided from the head: no proof is fetched, no address exists.
    expect(t.view!.state).toBe(SWAP_STATE.PENDING);
    expect(t.decision).toMatchObject({ do: 'wait', on: 'funding' });
    expect(t.joint).toBeNull();
    expect(r.calls.proof).toBe(0);
    // But the page knows, and knows how long: the lag (900 s) less the time since the funding (0 s).
    expect(t.pending).toMatchObject({ etaSecs: 900 });
    expect(t.pending!.view.state).toBe(SWAP_STATE.ACTIVE);
    // While something is not final the page does not call itself safe to close.
    expect(safetyOf(r.engine.getState(), true).safeToClose).toBe(false);

    // Time passes without the finalized tag moving (the e2e chain mines no block on its own): still
    // waiting, and the estimate honestly does not shrink: it is the distance the tag still has to travel.
    r.eth.advance(600);
    await r.engine.poll();
    expect(r.of(ref).pending).toMatchObject({ etaSecs: 900 });
    expect(r.of(ref).decision).toMatchObject({ do: 'wait', on: 'funding' });

    // Finality arrives: the proof is checked and the address shown on the next passes.
    r.eth.finalize();
    await r.engine.poll();
    await settle();
    await r.engine.poll();
    expect(r.of(ref).pending).toBeNull();
    expect(r.of(ref).proof).toEqual({ phase: 'ok' });
    expect(r.of(ref).decision).toMatchObject({ do: 'offchain', action: 'show-address' });
    expect(r.of(ref).joint?.address).toMatch(/^4/);
  });

  it('the estimate: how far finality trails the head, less how long ago the change happened', async () => {
    const r = ethRig(async () => ({ ok: true }));
    const { view } = r.eth.open({ direction: 1 });
    expect(finalityEta(view, { latestTime: view.tLock + 100n, finalizedTime: view.tLock - 800n })).toBe(800);
    expect(finalityEta(view, { latestTime: view.tLock + 1000n, finalizedTime: view.tLock + 100n })).toBe(0);
  });

  it('a taker lock that is in a block but not final is shown as waiting, never as closed', async () => {
    const r = ethRig(async () => ({ ok: true }));
    const { view, ref } = r.eth.open({ direction: 0 });
    r.engine.adopt(view, { market: 'eth' });
    await r.engine.poll();
    const t = r.of(ref);
    expect(t.view).toBeNull();
    expect(t.pending!.view.state).toBe(SWAP_STATE.PENDING);
    expect(t.leg).toBe('pending-approval');
    expect(t.note.closed).toBeUndefined();
    expect(safetyOf(r.engine.getState(), true)).toMatchObject({ safeToClose: false });
    expect(safetyOf(r.engine.getState(), true).open).toHaveLength(1);
  });
});

describe("the maker's key proof (Ethereum, selling)", () => {
  async function funded(proof: (s: SwapView) => Promise<Proof>, timeout?: number) {
    const r = ethRig(proof, timeout);
    r.eth.lagging = false;
    const { ref } = r.eth.open({ direction: 1 });
    r.eth.maker.fund(ref);
    return { r, ref };
  }

  it('a slow proof endpoint never holds up a pass: another swap is refunded meanwhile', async () => {
    let release!: (p: Proof) => void;
    const { r, ref } = await funded(() => new Promise<Proof>((res) => (release = res)));
    // An at-risk Solana swap whose cutoff has come.
    const a = r.sol.open();
    r.sol.maker.notice(a.ref, 'ab'.repeat(32));
    r.sol.warpTo(deadlinesOf('solana', r.sol.swaps.get(a.ref)!).tCut!);
    await r.engine.poll();
    // The pass finished with the proof still outstanding, and the refund went out.
    expect(r.of(ref).proof).toEqual({ phase: 'checking', attempts: 1 });
    expect(r.sol.calls).toEqual([[a.ref, 'refund', 'session']]);
    await r.engine.poll();
    await r.engine.poll();
    expect(r.calls.proof).toBe(1);
    release({ ok: true });
    await settle();
    await r.engine.poll();
    expect(r.of(ref).decision).toMatchObject({ do: 'offchain', action: 'show-address' });
  });

  it('a failed download is a visible, retried condition; once verified the proof is never fetched again', async () => {
    const answers: Proof[] = [{ retry: 'The relay refused the proof download (upstream_timeout)' }, { retry: "The maker's endpoint is not serving the proof for this share yet" }, { ok: true }];
    const { r, ref } = await funded(async () => answers.shift()!);
    await r.engine.poll();
    await settle();
    expect(r.of(ref).proof).toMatchObject({ phase: 'retrying', error: 'The relay refused the proof download (upstream_timeout)', attempts: 1 });
    expect(r.of(ref).decision).toEqual({ do: 'need', fact: 'dleq-proof' });
    // Polls inside the pause do not hammer the endpoint.
    await r.engine.poll();
    await r.engine.poll();
    expect(r.calls.proof).toBe(1);
    r.tick(2000);
    await r.engine.poll();
    await settle();
    expect(r.of(ref).proof).toMatchObject({ phase: 'retrying', attempts: 2 });
    r.tick(4000);
    await r.engine.poll();
    await settle();
    await r.engine.poll();
    expect(r.of(ref).proof).toEqual({ phase: 'ok' });
    expect(r.of(ref).decision).toMatchObject({ do: 'offchain', action: 'show-address' });
    // The address stays up from now on without another download, however many passes follow.
    for (let i = 0; i < 20; i++) await r.engine.poll();
    expect(r.calls.proof).toBe(3);
    expect(r.of(ref).decision).toMatchObject({ do: 'offchain', action: 'show-address' });
  });

  it('a download that hangs is cut off and retried', async () => {
    const { r, ref } = await funded(() => new Promise<Proof>(() => undefined), 20);
    await r.engine.poll();
    await new Promise((res) => setTimeout(res, 40));
    expect(r.of(ref).proof).toMatchObject({ phase: 'retrying', error: 'The proof download did not finish within 0 s', attempts: 1 });
  });

  it('a proof that does not verify is final: the address is never shown', async () => {
    const { r, ref } = await funded(async () => ({ ok: false }));
    await r.engine.poll();
    await settle();
    await r.engine.poll();
    expect(r.of(ref).proof).toEqual({ phase: 'invalid' });
    expect(r.of(ref).decision).toMatchObject({ do: 'wait', warning: 'maker-proof-invalid' });
    for (let i = 0; i < 5; i++) await r.engine.poll();
    expect(r.calls.proof).toBe(1);
  });
});

describe('the page never looks idle while it waits', () => {
  async function page(proof: (s: SwapView) => Promise<Proof>) {
    const chain = new ModelChain('ethereum');
    chain.lagging = true;
    const rig = makeRig({ chain, makerProof: proof });
    const { ref } = chain.open({ direction: 1, wA: 3600 });
    chain.finalize();
    await mount(rig, `#/swap/${ref}`);
    rig.backup();
    await rig.pass();
    return { rig, chain, ref };
  }

  it('waiting for finality: says so, with the estimate, the notice deadline and why; then the proof check; then the address', async () => {
    let release!: (p: Proof) => void;
    const { rig, chain, ref } = await page(() => new Promise<Proof>((res) => (release = res)));
    chain.advance(960);
    chain.finalize();
    chain.advance(960);
    chain.maker.fund(ref);
    await rig.pass();
    const wait = screen.getByText('The maker has funded. Waiting for its deposit to be final on Ethereum: about 16 min').closest('[role="status"]')!;
    expect(wait.textContent).toMatch(/XMR sent against a deposit that later disappears could be lost\. On mainnet this wait is normally 13 to 19 minutes\./);
    expect(wait.textContent).toMatch(/The maker's notice window runs meanwhile: \d\d:\d\d left/);
    expect(screen.queryByTestId('pay-xmr')).toBeNull();
    expect(screen.queryByTestId('safe-banner')).toBeNull();

    chain.finalize();
    await rig.pass();
    const proving = screen.getByText("Verifying the maker's key proof").closest('[role="status"]')!;
    expect(proving.textContent).toMatch(/downloading the proof \(about 57 kB\).*The address can be shown for another \d\d:\d\d/);
    expect(screen.queryByTestId('pay-xmr')).toBeNull();

    await act(async () => {
      release({ ok: true });
      await settle();
    });
    await rig.pass();
    expect(screen.getByTestId('pay-xmr')).toBeTruthy();
    expect(screen.queryByText("Verifying the maker's key proof")).toBeNull();
  });

  it('a failed proof download is shown with its reason and the consequence, and an invalid proof says not to pay', async () => {
    const answers: Proof[] = [{ retry: 'The relay or the maker\'s endpoint did not answer' }, { ok: false }];
    const { rig, chain, ref } = await page(async () => answers.shift()!);
    chain.maker.fund(ref);
    chain.finalize();
    await rig.pass();
    await act(settle);
    const retry = screen.getByText('Retrying the proof download (attempt 1 failed)').closest('[role="alert"]')!;
    expect(retry.textContent).toMatch(/The relay or the maker's endpoint did not answer\. The page tries again in a few seconds.*could be lost/);
    await act(async () => new Promise((res) => setTimeout(res, 2100)));
    await rig.pass();
    await act(settle);
    await rig.pass();
    expect(screen.getByText("The maker's key proof does not verify. Do not send XMR").closest('[role="alert"]')!.textContent).toMatch(/could be lost; the address is not shown/);
    expect(screen.queryByTestId('pay-xmr')).toBeNull();
  }, 20_000);

  it('before a sell on Ethereum starts, the required finality wait and its realistic length are stated', () => {
    const p = profile(1);
    const r = { ...solanaRow('o', offer(p.pda, { direction: 1, wN: 1800 }), p, null), chain: 'ethereum' as const, market: 'eth' as const };
    const w = offerWarnings({ row: r, pricing: { amount: 10n ** 18n, deposit: 10n ** 16n, depth: 2 }, xmr: XMR, minDepth: 0, upgrade: { frozen: true, authority: null } }).find((x) => x.id === 'eth-finality')!;
    expect(w.title).toBe('On Ethereum you wait 13 to 19 minutes before you can pay');
    expect(w.text).toMatch(/The wait is required: XMR sent against a deposit that a chain reorganisation could still remove could be lost\..*notice window of 30 min/);
    const buy = offerWarnings({ row: { ...r, direction: 0 }, pricing: { amount: 10n ** 18n, deposit: 10n ** 16n, depth: 2 }, xmr: XMR, minDepth: 0, upgrade: { frozen: true, authority: null } }).find((x) => x.id === 'eth-finality')!;
    expect(buy.text).toMatch(/13 to 19 minutes.*you can lose your funds/);
    // Solana offers carry no such warning, and the expected duration of an Ethereum swap includes two finality waits.
    expect(offerWarnings({ row: { ...r, chain: 'solana', market: 'sol' }, pricing: { amount: 1n, deposit: 0n, depth: 2 }, xmr: XMR, minDepth: 0, upgrade: { frozen: true, authority: null } }).some((x) => x.id === 'eth-finality')).toBe(false);
    expect(expectedSecs({ startsPending: true, approvalWindow: 120, chain: 'ethereum' }, 2)).toBe(120 + 360 + 2400);
    expect(expectedSecs({ startsPending: false, approvalWindow: 0, chain: 'solana' }, 2)).toBe(360);
  });
});
