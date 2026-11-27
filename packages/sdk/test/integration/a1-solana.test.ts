// Amendment 1 on Solana (SPEC 11): beta caps, the payout address of a sell, the keyless freeze
// by a watcher in both directions, and a swap resumed from the wallet-derived seed. The SDK
// against the real program inside tools/svm-rpc, with real XMR on the Monero regtest.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { type DerivedKeys, type JointAddress, init } from '@xmrswap/core-wasm';
import { COUNTER, DEPOSIT_STATE, PROGRAM_ID, SWAP_FLAG, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import { solanaInstruction } from '../../src/flows/execute.js';
import { buildNotice, jointSpendKey, openNotice, solanaMakerShare, swapJointAddress } from '../../src/flows/keys.js';
import { type MakerFacts, makerStep } from '../../src/flows/maker.js';
import { planSolanaOpen, solanaPayoutInvalid } from '../../src/flows/open.js';
import { type TakerFacts, takerStep } from '../../src/flows/taker.js';
import { type SwapView, deadlinesOf, isCounted } from '../../src/machine/view.js';
import type { HttpFetch } from '../../src/messages/transports.js';
import { resumeSwapKeys } from '../../src/recovery/file.js';
import { CapReached } from '../../src/registry/caps.js';
import { priceOffer } from '../../src/registry/pricing.js';
import { planRoute } from '../../src/router/plan.js';
import { ProgramError, type SolanaSigner, seedSigner } from '../../src/solana/client.js';
import { ata } from '../../src/solana/pdas.js';
import { hex } from '../../src/util.js';
import { unlockWalletSeed, walletKeyRecoveryFile, walletKeySolanaRequest } from '../../src/wallet/seed.js';
import { WATCH_ROUTES, WatcherClient, noticeKey, noticeKeyFor, parseWatchRequest, signWatchAck, verifyWatchRequest, watchDeployment } from '../../src/watcher/protocol.js';
import { type WatcherDecision, watcherFacts, watcherStep } from '../../src/watcher/step.js';
import { DEFAULT_CAPS, type SolWorld, XMR as X, startSolana } from './sol.js';
import * as xmr from './xmr.js';

let w: SolWorld;
const takerSeed = new Uint8Array(32).fill(52);
const WATCHER_SEED = new Uint8Array(32).fill(9);
const PRICE = 150_000_000n; // lamports (or USDC base units) per XMR
const FREEZE_WINDOW = 3_600;
const DEPLOYMENT = watchDeployment({ programId: PROGRAM_ID });

beforeAll(async () => {
  await init();
  w = await startSolana();
  await xmr.funded();
});
afterAll(async () => {
  await w?.stop();
});

const hexPda = (s: SwapView): string => new PublicKey(s.swapRef).toBase58();
const jointKeys = (j: JointAddress) => ({ viewPriv: hex(j.viewPriv), spendPub: hex(j.spendPub) });
const openValue = async (asset: number): Promise<bigint> => (await w.client.getCaps(asset)).openValue;
const counter = async (name: keyof typeof COUNTER): Promise<number> => (await w.maker()).counters[COUNTER[name]]!;
const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof ProgramError || e instanceof CapReached ? e.code : `other: ${(e as Error).message}`;
  }
  return 'accepted';
};

/** The live offer of a market, refreshed if the tests warped past its validity. */
async function liveOffer(asset: number, direction: number) {
  let offer = (await w.client.getOffer(w.makerPda, asset, direction))!;
  if ((await w.now()) > offer.updatedAt + BigInt(offer.validSecs) - 30n) {
    await w.send([w.client.program.refreshOffers(w.operator.publicKey, w.makerPda, [{ asset, direction, enabled: true, prices: [offer.prices[0]!, 0n, 0n], capacityXmr: 1000n * X }])], [w.operator]);
    offer = (await w.client.getOffer(w.makerPda, asset, direction))!;
  }
  return offer;
}

/** Open a swap against the live offer, reading the caps first as a client does. */
async function open(asset: number, direction: 0 | 1, xmrAmount: bigint, extra: { watcher?: string; payout?: string; payoutTokenRent?: bigint; seed?: Uint8Array; taker?: SolanaSigner } = {}) {
  const maker = await w.maker();
  const offer = await liveOffer(asset, direction);
  const taker = extra.taker ?? w.taker;
  const caps = await w.client.getCaps(asset);
  const plan = planSolanaOpen({
    program: w.client.program,
    taker: taker.publicKey,
    makerPda: w.makerPda,
    maker,
    seed: extra.seed ?? takerSeed,
    xmr: xmrAmount,
    source: { offer },
    rentExemptMinimum: w.rent0,
    caps,
    ...(extra.watcher ? { watcher: extra.watcher } : {}),
    ...(extra.payout ? { payout: extra.payout } : {}),
    ...(extra.payoutTokenRent !== undefined ? { payoutTokenRent: extra.payoutTokenRent } : {}),
  });
  await w.send(plan.instructions, [taker]);
  const s = (await w.swap(plan.swapPda))!;
  return { plan, s, session: seedSigner(plan.keys.sessionSecret), pricing: priceOffer(offer, xmrAmount), offer };
}

/** The maker funds a pending take with a fresh share, optionally naming its watcher. */
async function fund(s: SwapView, watcher?: string): Promise<{ s: SwapView; share: DerivedKeys }> {
  const share = w.newShare();
  const d = makerStep({ swap: s, now: await w.now(), approval: { approve: true } });
  expect(d).toMatchObject({ do: 'call', call: { name: 'fund' } });
  await w.exec(s, d, {}, { makerShare: { ...solanaMakerShare(share, base58Decode(w.makerPda)), spendPub: share.spendPub, view: share.view }, ...(watcher ? { watcher } : {}) });
  return { s: (await w.swap(hexPda(s)))!, share };
}

/** Direction A, maker side: post a notice for `txid` (real or not). */
async function notice(s: SwapView, share: DerivedKeys, txid: Uint8Array): Promise<SwapView> {
  const d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
  expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' } });
  await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, txid, share.view) });
  return (await w.swap(hexPda(s)))!;
}

// ------------------------------------------------------------------ a watcher service, in process

/**
 * What `packages/watcher` will be, reduced to the SDK calls it makes: it accepts a swap only if
 * it finds it on chain naming its key, keeps the notice key, and then loops "read the swap,
 * gather the facts with view data, do what `watcherStep` says". It holds one Solana key.
 */
function watcherService() {
  const keys = new Map<string, Uint8Array>();
  const posted: string[] = [];
  const fetchFn: HttpFetch = async (url, init) => {
    const reply = (status: number, j: unknown) => ({ status, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer });
    if (url.endsWith(WATCH_ROUTES.info)) return reply(200, { solana: w.watcher.publicKey, ethereum: '0x0000000000000000000000000000000000000009', max_swaps: 10, monero_nodes: xmr.NODES.length });
    if (url.endsWith(WATCH_ROUTES.swaps) && init.method === 'POST') {
      posted.push(init.body as string);
      // Find the swap the request names, then verify the request against it: only its locker can have sealed it.
      const parsed = parseWatchRequest(JSON.parse(init.body as string));
      const pda = new PublicKey(parsed.swapRef).toBase58();
      const s = await w.client.getSwap(pda, 'finalized');
      if (!s || s.watcherAddress !== w.watcher.publicKey || s.state === SWAP_STATE.DONE) return reply(404, { error: 'no such swap names this watcher' });
      let req;
      try {
        req = verifyWatchRequest(JSON.parse(init.body as string), { watcherSeed: WATCHER_SEED, swap: s, deployment: DEPLOYMENT, now: await w.now() });
      } catch (e) {
        return reply(403, { error: (e as { code?: string }).code });
      }
      keys.set(pda, req.noticeKey);
      // The latest T_co this swap can have: a notice at the last second of its window.
      const until = (s.tNoteDeadline === 0n ? s.tFinal : s.tNoteDeadline) + BigInt(s.dC);
      return reply(200, signWatchAck({ chain: req.chain, swapRef: req.swapRef, watchingUntil: until, watcherSeed: WATCHER_SEED }));
    }
    return reply(404, {});
  };
  /** One pass of the service's loop for one swap. Sends the freeze when the step says so. */
  async function pass(pda: string): Promise<WatcherDecision> {
    const key = keys.get(pda);
    if (!key) throw new Error('the watcher was never given this swap');
    const swap = await w.client.getSwap(pda, 'finalized');
    const base = { swap, now: await w.now(), watcher: w.watcher.publicKey };
    let d = watcherStep(base);
    if (d.do === 'need') {
      const facts = await watcherFacts({ swap: swap!, noticeKey: key, nodes: xmr.NODES, network: 'regtest' });
      d = watcherStep({ ...base, ...facts });
    }
    if (d.do === 'call') await w.exec(swap!, d, {});
    return d;
  }
  return { client: new WatcherClient('https://watcher.test', fetchFn), pass, posted, keys };
}

// ------------------------------------------------------------------ caps

describe('beta caps (SPEC 11.1)', () => {
  it('a swap exactly at the caps opens; one above is refused by the client and by the program; every exit frees its open value', async () => {
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE });
    const offer = await liveOffer(0, 0);
    const one = priceOffer(offer, X).amount;
    expect(one).toBe(PRICE);
    // The world starts with caps far out of reach; the admin now sets the beta's: one swap of 1 XMR, two open at once.
    expect(await w.client.getCaps(0)).toEqual({ on: true, maxSwap: DEFAULT_CAPS.maxSwap[0], maxOpen: DEFAULT_CAPS.maxOpen[0], openValue: 0n });
    await w.setCaps({ maxSwap: [one, DEFAULT_CAPS.maxSwap[1]], maxOpen: [2n * one, DEFAULT_CAPS.maxOpen[1]] });
    expect(await w.client.getCaps(0)).toEqual({ on: true, maxSwap: one, maxOpen: 2n * one, openValue: 0n });

    // Exactly at the per-swap cap.
    const first = await open(0, 0, X);
    expect(first.s).toMatchObject({ state: SWAP_STATE.ACTIVE, amount: one });
    expect(isCounted(first.s)).toBe(true);
    expect(await openValue(0)).toBe(one);

    // One piconero-step above it: the client says "cap reached" before anything is signed...
    const maker = await w.maker();
    const above = X + 10_000n;
    expect(priceOffer(offer, above).amount > one).toBe(true);
    const caps = await w.client.getCaps(0);
    const refused = (() => {
      try {
        planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: above, source: { offer }, rentExemptMinimum: w.rent0, caps });
      } catch (e) {
        return e;
      }
    })();
    expect(refused).toBeInstanceOf(CapReached);
    expect(refused).toMatchObject({ code: 'SwapCapExceeded', maxSwap: one, headroom: one });
    expect(() => priceOffer(offer, above, caps)).toThrow(CapReached);
    // ...and the program refuses the same lock when a client skips the check.
    const blind = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: above, source: { offer }, rentExemptMinimum: w.rent0, slippageBps: 100 });
    expect(await errorCode(w.send(blind.instructions, [w.taker]))).toBe('SwapCapExceeded');
    expect(await openValue(0)).toBe(one);

    // A second swap fills the open value exactly.
    const second = await open(0, 0, X);
    expect(await openValue(0)).toBe(2n * one);
    // A third has no headroom: "cap reached" (not a maker limit), from the client, the router and the program.
    const full = await w.client.getCaps(0);
    expect(await errorCode((async () => planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: X, source: { offer }, rentExemptMinimum: w.rent0, caps: full }))())).toBe('OpenCapExceeded');
    const route = planRoute(
      { totalPay: one, worstPrice: 2n * PRICE, maxInFlight: 10n * one, deadline: (await w.now()) + 3600n },
      [{ id: 'a', makerId: w.makerPda, chain: 'solana', asset: 0, minXmr: offer.minXmr, maxXmr: offer.maxXmr, capacityXmr: offer.capacityXmr, mode: 0, approvalWindow: 60, depBps: offer.depBps, withholdRate: 0, faultRate: 0, price: (x) => priceOffer(offer, x), caps: full }],
    );
    expect(route).toMatchObject({ waves: [], capReached: true, dropped: [{ offerId: 'a', reason: 'cap-reached' }] });
    const third = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: X, source: { offer }, rentExemptMinimum: w.rent0 });
    expect(await errorCode(w.send(third.instructions, [w.taker]))).toBe('OpenCapExceeded');

    // Exit 1: the taker cancels (a keyed refund, A10a). The value is freed when the swap enters the hold.
    let d = takerStep({ swap: first.s, now: await w.now(), cancel: true });
    await w.exec(first.s, d, { session: first.session }, { secret: first.plan.keys.spend });
    const held = (await w.swap(first.plan.swapPda))!;
    expect(held.state).toBe(SWAP_STATE.HOLD);
    expect(isCounted(held)).toBe(false);
    expect(await openValue(0)).toBe(one);
    // The room is usable at once, while the deposit of the first swap is still held.
    const again = await open(0, 0, X);
    expect(await openValue(0)).toBe(2n * one);

    // Exit 2: no notice by the deadline; a stranger sends the keyless refund (A8) and the account closes.
    await w.warpTo(deadlinesOf('solana', second.s).tNote!);
    d = takerStep({ swap: second.s, now: await w.now() });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund_unnoticed' }, caller: 'anyone' });
    await w.exec(second.s, d, {});
    expect(await w.swap(second.plan.swapPda)).toBe(null);
    expect(await openValue(0)).toBe(one);

    // The admin lowers the cap below what is open. Invariant 3: the open swap's exits are untouched...
    await w.setCaps({ maxSwap: [0n, 0n], maxOpen: [0n, 0n] });
    expect(await errorCode(w.send(third.instructions, [w.taker]))).toBe('SwapCapExceeded');
    await w.exec(again.s, takerStep({ swap: again.s, now: await w.now() }), {});
    expect(await w.swap(again.plan.swapPda)).toBe(null);
    expect(await openValue(0)).toBe(0n);
    // ...and the held deposit of the first swap is released as if nothing had changed.
    await w.warpTo(deadlinesOf('solana', held).tHold!);
    await w.exec(held, takerStep({ swap: held, now: await w.now() }), {});
    expect(await w.swap(first.plan.swapPda)).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RETURNED });
    expect(await openValue(0)).toBe(0n);
    await w.setCaps({ maxSwap: [...DEFAULT_CAPS.maxSwap], maxOpen: [...DEFAULT_CAPS.maxOpen] });
  });

  it('open value is freed by every other way a swap can end, in both directions', async () => {
    const freed: string[] = [];
    const expectFreed = async (asset: number, label: string) => {
      expect(await openValue(asset), label).toBe(0n);
      freed.push(label);
    };
    // ---- direction A, pending for approval (window mode): cancel, reject, lapse
    await w.publishOffer({ asset: 0, direction: 0, mode: 1, price: PRICE });
    for (const exit of ['cancel_pending', 'reject', 'expire_pending'] as const) {
      const o = await open(0, 0, X);
      expect(o.s.state).toBe(SWAP_STATE.PENDING);
      expect(await openValue(0)).toBe(o.pricing.amount);
      if (exit === 'cancel_pending') await w.exec(o.s, takerStep({ swap: o.s, now: await w.now(), cancel: true }), { session: o.session });
      else if (exit === 'reject') await w.exec(o.s, makerStep({ swap: o.s, now: await w.now(), approval: { approve: false, reason: 0 } }), {});
      else {
        await w.warpTo(deadlinesOf('solana', o.s).tPend!);
        await w.exec(o.s, takerStep({ swap: o.s, now: await w.now() }), {});
      }
      expect(await w.swap(o.plan.swapPda)).toBe(null);
      await expectFreed(0, `A ${exit}`);
    }
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE });

    // ---- direction A after a notice: the maker aborts, the taker refunds
    {
      const o = await open(0, 0, X);
      const share = w.shares.get(hex(o.s.makerSpendPub))!;
      let s = await notice(o.s, share, new Uint8Array(32).fill(0xe1));
      await w.exec(s, makerStep({ swap: s, now: await w.now(), lockTx: 'prepared', lockFailed: true }), {});
      s = (await w.swap(o.plan.swapPda))!;
      expect([SWAP_STATE.ABORTED_FREE, SWAP_STATE.ABORTED_HOLD]).toContain(s.state);
      // An aborted swap is still open: its value is counted until the refund.
      expect(await openValue(0)).toBe(o.pricing.amount);
      await w.exec(s, takerStep({ swap: s, now: await w.now() }), { session: o.session }, { secret: o.plan.keys.spend });
      await expectFreed(0, 'A abort then refund');
    }
    // ---- direction A: the maker claims without ready at T_co (the escrow only sees the notice)
    {
      const o = await open(0, 0, X);
      const share = w.shares.get(hex(o.s.makerSpendPub))!;
      const s = await notice(o.s, share, new Uint8Array(32).fill(0xe2));
      await w.warpTo(deadlinesOf('solana', s).tCo!);
      await w.exec(s, makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withoutReady: 'claim' }), {}, { secret: share.spend });
      await expectFreed(0, 'A claim');
    }

    // ---- direction B counts amount + deposit from the take: cancel, back out, lapse without a notice
    await w.publishOffer({ asset: 0, direction: 1, mode: 0, price: PRICE });
    {
      const o = await open(0, 1, X);
      expect(o.s.state).toBe(SWAP_STATE.PENDING);
      // The whole amount is counted although only the deposit is escrowed yet.
      expect(await openValue(0)).toBe(o.pricing.amount + o.pricing.deposit);
      await w.exec(o.s, takerStep({ swap: o.s, now: await w.now(), cancel: true }), { session: o.session });
      await expectFreed(0, 'B cancel_pending');
    }
    {
      const o = await open(0, 1, X);
      const f = await fund(o.s);
      expect(await openValue(0)).toBe(o.pricing.amount + o.pricing.deposit);
      const d = makerStep({ swap: f.s, now: await w.now(), backOut: true });
      expect(d).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9a' });
      await w.exec(f.s, d, {}, { secret: f.share.spend });
      await expectFreed(0, 'B maker backs out');
    }
    {
      const o = await open(0, 1, X);
      const f = await fund(o.s);
      await w.warpTo(deadlinesOf('solana', f.s).tExp);
      const d = takerStep({ swap: f.s, now: await w.now() });
      expect(d).toMatchObject({ do: 'call', call: { name: 'expire_unnoticed' } });
      await w.exec(f.s, d, {});
      await expectFreed(0, 'B expire_unnoticed');
    }
    expect(freed.length).toBe(8);
  });
});

// ------------------------------------------------------------------ payout address

describe('a sell with a fresh payout address (SPEC 11.2)', () => {
  it('USDC to an address with no token account: created by the claiming session key; the taking wallet receives nothing', async () => {
    await w.publishOffer({ asset: 1, direction: 1, mode: 0, price: PRICE });
    const fresh = seedSigner(new Uint8Array(32).fill(0x61));
    // The address was never used: no lamports, no token account.
    expect(await w.balance(fresh.publicKey)).toBe(0n);
    const check = await w.client.payoutProblem(fresh.publicKey, 1);
    expect(check).toMatchObject({ verdict: 'ok', tokenAccountMissing: true });
    expect(check.tokenAccountRent > 0n).toBe(true);
    // What the program refuses by the address, the client refuses first: a token account, the program, the default key.
    const takerAta = ata(w.taker.publicKey, w.usdc).toBase58();
    for (const bad of [takerAta, PROGRAM_ID, '11111111111111111111111111111111']) {
      expect(await w.client.payoutProblem(bad, 1)).toMatchObject({ verdict: 'refuse', reason: 'invalid-address' });
      expect(solanaPayoutInvalid(bad, PROGRAM_ID)).toBe(true);
    }
    // The program agrees (a client that skips the check).
    {
      const maker = await w.maker();
      const offer = await liveOffer(1, 1);
      const plan = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: X, source: { offer }, rentExemptMinimum: w.rent0 });
      const ix = w.client.program.take({ taker: w.taker.publicKey, maker: w.makerPda, sessionKey: base58SessionKey(plan), source: { offer: true }, args: { ...takeArgsOf(plan), payout: takerAta } });
      expect(await errorCode(w.send([ix], [w.taker]))).toBe('PayoutInvalid');
    }

    const takerUsdc = await w.tokenBalance(w.taker.publicKey);
    const o = await open(1, 1, 2n * X, { payout: fresh.publicKey, payoutTokenRent: check.tokenAccountRent });
    expect(o.s).toMatchObject({ state: SWAP_STATE.PENDING, payout: 'other', payoutAddress: fresh.publicKey });
    expect(o.plan.sessionLamports).toBe(planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker: await w.maker(), seed: takerSeed, xmr: 2n * X, source: { offer: o.offer }, rentExemptMinimum: w.rent0 }).sessionLamports + check.tokenAccountRent);
    expect(await openValue(1)).toBe(o.pricing.amount + o.pricing.deposit);
    // The maker funds knowing the payout address: it is in the open hash its fund carries.
    const f = await fund(o.s);
    let s = f.s;
    expect(s.state).toBe(SWAP_STATE.ACTIVE);

    // The taker pays real XMR, posts the notice; the maker verifies on two nodes and sets ready.
    const joint = swapJointAddress(s, o.plan.keys.view, 'regtest');
    const paid = await xmr.pay(joint.address, s.xmr);
    await w.exec(s, takerStep({ swap: s, now: await w.now(), paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, xmr.txidBytes(paid), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapPda))!;
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    const makerJoint = swapJointAddress(s, opened.view, 'regtest');
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(paid, jointKeys(makerJoint), s.xmr, s.depth, 'confirmed');
    await w.warpTo(deadlinesOf('solana', s).tReadyMin!);
    await w.exec(s, makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock), commitmentsOk: true }), {});
    s = (await w.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.READY);

    // The session key claims. The proceeds (amount − fee + the take deposit) go to the fresh address, whose token account the claim creates.
    const d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, caller: 'session', row: 'B10a' });
    const sig = await w.exec(s, d, { session: o.session }, { secret: o.plan.keys.spend });
    s = (await w.swap(o.plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed, owedTaker: 0n });
    expect(await w.tokenBalance(fresh.publicKey)).toBe(o.pricing.amount - o.pricing.fee + o.pricing.deposit);
    // The taking wallet paid the deposit and got no USDC back: the wallet that pays need not be the one that receives.
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(takerUsdc - o.pricing.deposit);
    // The payout address still holds no lamports: it needed no balance and signed nothing.
    expect(await w.balance(fresh.publicKey)).toBe(0n);
    expect((await w.client.eventsOf(sig)).map((e) => e.name)).not.toContain('PayoutParked');
    expect(await openValue(1)).toBe(0n);
    expect(takerStep({ swap: s, now: await w.now(), paid: true })).toEqual({ do: 'done', outcome: 'completed' });
    // The maker sweeps the XMR with the share the claim revealed.
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, f.share.spend, 'maker'), viewKey: makerJoint.viewPriv, lock, txid: paid });
    expect(swept.published).toBe(true);
  });

  it('the claimer does not create the token account: the proceeds are parked for the payout address, which only it can redirect and anyone can deliver', async () => {
    const fresh = seedSigner(new Uint8Array(32).fill(0x62));
    const takerUsdc = await w.tokenBalance(w.taker.publicKey);
    const o = await open(1, 1, X, { payout: fresh.publicKey });
    const f = await fund(o.s);
    let s = f.s;
    // The escrow only sees the notice: no XMR is needed for the parking path.
    await w.exec(s, takerStep({ swap: s, now: await w.now(), paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, new Uint8Array(32).fill(0xe3), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapPda))!;
    await w.warpTo(deadlinesOf('solana', s).tCo!);
    const claim = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(claim).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10b' });
    // The claiming key declines to create the payout's token account (or could not pay its rent): the
    // associated-token program is not passed, and a claim never fails on its destination.
    const sig = await w.exec(s, claim, { session: o.session }, { secret: o.plan.keys.spend, createPayoutToken: false });
    s = (await w.swap(o.plan.swapPda))!;
    // The claim succeeded and its secret is public; the proceeds stayed in escrow, owed to the payout address.
    const proceeds = o.pricing.amount - o.pricing.fee + o.pricing.deposit;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, payout: 'other', payoutAddress: fresh.publicKey, owedTaker: proceeds });
    expect(s.flags & SWAP_FLAG.REVEALED).toBeTruthy();
    expect((await w.client.eventsOf(sig)).map((e) => e.name)).toContain('PayoutParked');
    expect(await w.tokenBalance(fresh.publicKey)).toBe(0n);
    // The swap has ended: its open value is free even though a balance is parked.
    expect(await openValue(1)).toBe(0n);

    // The taking wallet cannot pull or redirect them.
    const byTaker = solanaInstruction(w.client.program, s, await w.maker(), w.taker.publicKey, { name: 'withdraw_owed', who: 'taker' }, { destination: w.taker.publicKey });
    expect(await errorCode(w.send([byTaker], [w.taker]))).toBe('Unauthorized');
    // The flow says what to do: anyone delivers them, to the payout address and nowhere else.
    const d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toEqual({ do: 'call', call: { name: 'withdraw_owed', who: 'payout' }, caller: 'anyone', secret: false, notAfter: null, row: 'deliver_owed' });
    // A stranger first creates the token account (idempotent), then delivers.
    const strangerUsdc = await w.tokenBalance(w.stranger.publicKey);
    const create = createAssociatedTokenAccountIdempotentInstruction(new PublicKey(w.stranger.publicKey), ata(fresh.publicKey, w.usdc), new PublicKey(fresh.publicKey), new PublicKey(w.usdc));
    const deliver = solanaInstruction(w.client.program, s, await w.maker(), w.stranger.publicKey, d.do === 'call' ? d.call : { name: 'close_swap' });
    await w.send([create, deliver], [w.stranger]);
    expect(await w.tokenBalance(fresh.publicKey)).toBe(proceeds);
    expect(await w.tokenBalance(w.stranger.publicKey)).toBe(strangerUsdc);
    expect(await w.tokenBalance(w.taker.publicKey)).toBe(takerUsdc - o.pricing.deposit);
    s = (await w.swap(o.plan.swapPda))!;
    expect(s.owedTaker).toBe(0n);
    expect(await errorCode(w.send([solanaInstruction(w.client.program, s, await w.maker(), w.stranger.publicKey, { name: 'withdraw_owed', who: 'payout' })], [w.stranger]))).toBe('NothingOwed');
  });
});

/** The take arguments a plan built, to resend them with one field changed. */
function takeArgsOf(plan: ReturnType<typeof planSolanaOpen>) {
  const ix = plan.instructions.at(-1)!;
  // Decode through the frozen codec the builder used.
  return decodeTake(ix.data);
}
import { decodeInstructionData } from '@xmrswap/protocol';
function decodeTake(data: Uint8Array) {
  const d = decodeInstructionData(data);
  if (!d || d.name !== 'take') throw new Error('not a take');
  return (d.args as { args: import('@xmrswap/protocol').TakeArgs }).args;
}
const base58SessionKey = (plan: ReturnType<typeof planSolanaOpen>): string => seedSigner(plan.keys.sessionSecret).publicKey;

// ------------------------------------------------------------------ freeze, direction A

describe('a buy watched by a watcher (SPEC 11.6, direction A)', () => {
  const svc = watcherService();

  /** Lock naming the service's watcher key and hand the swap over, as the tab does before it closes. */
  async function watchedLock(xmrAmount: bigint) {
    const info = await svc.client.info();
    expect(info.solana).toBe(w.watcher.publicKey);
    const o = await open(0, 0, xmrAmount, { watcher: info.solana });
    expect(o.s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: true, watcherAddress: info.solana, wZ: FREEZE_WINDOW });
    // The notice key is computable at lock time, before any notice exists.
    const key = noticeKeyFor({ side: 'taker', ownEncSecret: o.plan.keys.encSecret, peerEncPub: o.s.makerEncKey });
    expect(hex(key)).toBe(hex(noticeKey(o.s, o.plan.keys.encSecret)));
    const reg = { chain: 'solana' as const, swapRef: o.s.swapRef, noticeKey: key, watcherSolanaKey: info.solana, deployment: DEPLOYMENT, issuedAt: await w.now() };
    // A stranger (or the maker, the counterparty) cannot hand this swap to the watcher, with a wrong key or the right one.
    for (const lockerEncSecret of [new Uint8Array(32).fill(0x33), w.makerEnc.encSecret]) await expect(svc.client.register({ ...reg, lockerEncSecret })).rejects.toMatchObject({ status: 403 });
    await expect(svc.client.register({ ...reg, noticeKey: new Uint8Array(32).fill(0x44), lockerEncSecret: new Uint8Array(32).fill(0x33) })).rejects.toMatchObject({ status: 403 });
    expect(svc.keys.has(o.plan.swapPda)).toBe(false);
    // The locker's own request: authenticated with the one-time encryption key the lock put on chain. No wallet prompt.
    const ack = await svc.client.register({ ...reg, lockerEncSecret: o.plan.keys.encSecret });
    expect(BigInt(ack.watching_until)).toBe(o.s.tNoteDeadline + BigInt(o.s.dC));
    // The key travelled sealed.
    expect(svc.posted.at(-1)).not.toContain(hex(key));
    return { ...o, share: w.shares.get(hex(o.s.makerSpendPub))!, key };
  }

  it('the offer must have a freeze window; the watcher key holds nothing but a fee balance', async () => {
    // Without a freeze window a lock that names a watcher is refused: by the client, and by the program.
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE });
    const maker = await w.maker();
    const plain = await liveOffer(0, 0);
    expect(() => planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: X, source: { offer: plain }, rentExemptMinimum: w.rent0, watcher: w.watcher.publicKey })).toThrow(/WatcherNotAllowed/);
    const forced = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: takerSeed, xmr: X, source: { offer: { ...plain, wZ: FREEZE_WINDOW } }, rentExemptMinimum: w.rent0, watcher: w.watcher.publicKey });
    expect(await errorCode(w.send(forced.instructions, [w.taker]))).toBe('WatcherNotAllowed');
    // The maker now offers a one-hour freeze window: a term of the offer, covered by its hash.
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE, terms: { wZ: FREEZE_WINDOW } });
    const offer = await liveOffer(0, 0);
    expect(offer.wZ).toBe(FREEZE_WINDOW);
    expect(hex(offer.termsHash)).not.toBe(hex(plain.termsHash));
  });

  it('the tab is closed; the notice is false; the watcher freezes; the maker cannot claim at the claim delay; the taker returns inside the window and refunds', async () => {
    const takerBefore = await w.balance(w.taker.publicKey);
    const { plan, s: active, share, pricing } = await watchedLock(X);
    const freezes = await counter('freezes');
    const refunds = await counter('refunds_after_freeze');
    // The watcher follows the swap; there is no notice yet.
    expect(await svc.pass(plan.swapPda)).toEqual({ do: 'wait', on: 'notice', until: active.tNoteDeadline });

    // The maker posts a notice for a transaction that does not exist and locks no XMR.
    let s = await notice(active, share, new Uint8Array(32).fill(0xfa));
    const dl = deadlinesOf('solana', s);
    // The watcher decrypts the notice with the key it was given and looks for the lock on both nodes: nothing. It waits for T_cut.
    expect(await svc.pass(plan.swapPda)).toEqual({ do: 'wait', on: 'lock-check', until: dl.tCut });
    await w.warpTo(dl.tCut!);
    const frozenBy = await svc.pass(plan.swapPda);
    expect(frozenBy).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: dl.tCo! - 300n, why: 'lock-not-confirmed' });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.FROZEN, tFreeze: dl.tCut });
    const ff = deadlinesOf('solana', s).tFf!;
    expect(ff).toBe(s.tFreeze + BigInt(FREEZE_WINDOW));
    expect(ff > dl.tCo!).toBe(true);
    expect(await counter('freezes')).toBe(freezes + 1);
    // A freeze moves nothing and the watcher is done with the swap.
    expect(await openValue(0)).toBe(pricing.amount);
    expect(await svc.pass(plan.swapPda)).toEqual({ do: 'stop', why: 'frozen' });
    // It cannot freeze twice, and it can do nothing else.
    expect(await errorCode(w.send([w.client.program.freeze({ caller: w.watcher.publicKey, swap: plan.swapPda, maker: w.makerPda })], [w.watcher]))).toBe('BadState');
    expect(await errorCode(w.send([w.client.program.setReady({ caller: w.watcher.publicKey, swap: plan.swapPda, maker: w.makerPda })], [w.watcher]))).toBe('Unauthorized');

    // The claim delay runs out. Without the freeze the maker would take the payment now.
    await w.warpTo(dl.tCo!);
    const early = solanaInstruction(w.client.program, s, await w.maker(), w.operator.publicKey, { name: 'claim' }, { secret: share.spend });
    expect(await errorCode(w.send([early], [w.operator]))).toBe('TooEarly');
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withoutReady: 'claim' })).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });
    expect((await w.swap(plan.swapPda))!.flags & SWAP_FLAG.REVEALED).toBe(0);

    // The taker comes back inside the freeze window with nothing but chain state and its seed.
    await w.warpTo(dl.tCo! + 60n);
    const keys = resumeSwapKeys(takerSeed, 'solana', s.swapNonce);
    expect(takerStep({ swap: s, now: await w.now() })).toEqual({ do: 'need', fact: 'notice-opening' });
    const opened = openNotice(s, keys.encSecret)!;
    const joint = swapJointAddress(s, opened.view, 'regtest');
    const lock = await xmr.verify(hex(opened.txid), jointKeys(joint), s.xmr, s.depth);
    expect(lock.state).toBe('not-found');
    const d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'session', secret: true, notAfter: ff - 300n, row: 'Z3' });
    await w.exec(s, d, { session: seedSigner(keys.sessionSecret) }, { secret: keys.spend });
    s = (await w.swap(plan.swapPda))!;
    // amount − D is back; D is held and can be withheld: a refund after a freeze always leaves the deposit withholdable.
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    expect(await counter('refunds_after_freeze')).toBe(refunds + 1);
    expect(await openValue(0)).toBe(0n);
    await w.warpTo(deadlinesOf('solana', s).tHold!);
    await w.exec(s, takerStep({ swap: s, now: await w.now() }), {});
    expect(await w.swap(plan.swapPda)).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RETURNED });
    // The taker lost fees and rent only.
    const lost = takerBefore - (await w.balance(w.taker.publicKey));
    expect(lost > 0n && lost < 10_000_000n).toBe(true);
  });

  it('the taker does NOT return: the lock was only slow; the maker claims at the frozen-final time, publishing its half, and the XMR is the taker\'s', async () => {
    const { plan, s: active, share, pricing } = await watchedLock(X);
    const claims = await counter('claims_after_freeze');
    // A real lock, relayed after the notice but not mined by T_cut.
    const joint = swapJointAddress(active, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, active.xmr);
    let s = await notice(active, share, xmr.txidBytes(lockTx.txid));
    await xmr.relay(lockTx.txHex);
    const dl = deadlinesOf('solana', s);
    await w.warpTo(dl.tCut!);
    // The watcher sees the transaction in the pool on both nodes: valid, but not confirmed at T_cut. It freezes.
    expect(await svc.pass(plan.swapPda)).toMatchObject({ do: 'call', call: { name: 'freeze' }, why: 'lock-not-confirmed' });
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const ff = deadlinesOf('solana', s).tFf!;
    // The blocks come. The maker's lock is good; the taker's tab stays closed.
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(lockTx.txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    await w.warpTo(dl.tCo!);
    expect(await errorCode(w.send([solanaInstruction(w.client.program, s, await w.maker(), w.operator.publicKey, { name: 'claim' }, { secret: share.spend })], [w.operator]))).toBe('TooEarly');
    await w.warpTo(ff - 1n);
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) })).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });
    await w.warpTo(ff);
    // The taker missed its window; from T_ff the claim is the maker's.
    expect(takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) })).toMatchObject({ do: 'wait', on: 'expiry', warning: 'refund-window-missed' });
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, caller: 'operator', row: 'Z4', secret: true });
    const payoutBefore = await w.balance(w.payout.publicKey);
    await w.exec(s, d, {}, { secret: share.spend });
    const done = (await w.swap(plan.swapPda))!;
    expect(done).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.claims_after_freeze });
    expect(await counter('claims_after_freeze')).toBe(claims + 1);
    expect(await w.balance(w.payout.publicKey)).toBe(payoutBefore + pricing.amount - pricing.fee);
    // The claim published the maker's half: the taker, whenever it returns, sweeps the XMR.
    expect(hex(done.revealed)).toBe(hex(share.spend));
    expect(takerStep({ swap: done, now: await w.now() })).toEqual({ do: 'offchain', action: 'sweep', notAfter: null });
    const keys = resumeSwapKeys(takerSeed, 'solana', done.swapNonce);
    const opened = openNotice(done, keys.encSecret)!;
    const takerJoint = swapJointAddress(done, opened.view, 'regtest');
    const swept = await xmr.sweep({ spendKey: jointSpendKey(done, keys.spend, 'taker'), viewKey: takerJoint.viewPriv, lock, txid: hex(opened.txid) });
    expect(swept.published).toBe(true);
    expect(await xmr.isMined(swept.txid)).toBe(true);
    expect(await openValue(0)).toBe(0n);
  });

  it('a wrongly frozen honest swap is un-frozen by the taker setting ready, and completes normally', async () => {
    const { plan, s: active, share, session, pricing } = await watchedLock(X);
    const joint = swapJointAddress(active, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, active.xmr);
    let s = await notice(active, share, xmr.txidBytes(lockTx.txid));
    await xmr.relay(lockTx.txHex);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(lockTx.txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    const dl = deadlinesOf('solana', s);
    // An honest watcher would not freeze this: the lock is confirmed on both nodes.
    await w.warpTo(dl.tCut!);
    const facts = await watcherFacts({ swap: s, noticeKey: svc.keys.get(plan.swapPda)!, nodes: xmr.NODES, network: 'regtest' });
    expect(facts.lock).toMatchObject({ state: 'confirmed', ok: true });
    expect(watcherStep({ swap: s, now: await w.now(), watcher: w.watcher.publicKey, ...facts })).toEqual({ do: 'wait', on: 'recheck', until: dl.tCo! - 300n });
    // A malicious (or broken) watcher freezes anyway. That is all it can do.
    await w.send([w.client.program.freeze({ caller: w.watcher.publicKey, swap: plan.swapPda, maker: w.makerPda })], [w.watcher]);
    s = (await w.swap(plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    // The taker returns, verifies the lock itself, and sets ready: the swap is un-frozen.
    const opened = openNotice(s, plan.keys.encSecret)!;
    expect(hex(opened.txid)).toBe(lockTx.txid);
    const tf: Partial<TakerFacts> = { noticeOpens: true, lock: xmr.report(lock) };
    await w.warpTo(deadlinesOf('solana', s).tReadyMin!);
    const ready = takerStep({ swap: s, now: await w.now(), ...tf });
    expect(ready).toMatchObject({ do: 'call', call: { name: 'set_ready' }, caller: 'session', row: 'Z2' });
    await w.exec(s, ready, { session });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.READY });
    expect(s.tFreeze > 0n).toBe(true);
    // The freeze cost the maker nothing here: it claims in the ordinary claim window.
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11a' });
    const payoutBefore = await w.balance(w.payout.publicKey);
    await w.exec(s, d, {}, { secret: share.spend });
    s = (await w.swap(plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    expect(await w.balance(w.payout.publicKey)).toBe(payoutBefore + pricing.amount - pricing.fee);
    // And the taker has its XMR.
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, plan.keys.spend, 'taker'), viewKey: joint.viewPriv, lock, txid: lockTx.txid });
    expect(swept.published).toBe(true);
  });
});

// ------------------------------------------------------------------ freeze, direction B

describe('a sell watched by the maker\'s watcher (SPEC 11.6, direction B)', () => {
  it('the daemon is down; the taker posts a false notice; the watcher freezes; the taker cannot claim at the claim delay; the maker returns and refunds, and the deposit goes back at once', async () => {
    const svc = watcherService();
    await w.publishOffer({ asset: 0, direction: 1, mode: 0, price: PRICE, terms: { wZ: FREEZE_WINDOW } });
    const backouts = await counter('backouts_after_freeze');
    const o = await open(0, 1, X);
    // The maker names its watcher at fund and hands it the notice key over HTTPS.
    const info = await svc.client.info();
    const f = await fund(o.s, info.solana);
    let s = f.s;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: true, watcherAddress: w.watcher.publicKey, wZ: FREEZE_WINDOW, payout: 'taker', payoutAddress: w.taker.publicKey });
    // The taker (the claimer here) cannot register the maker's swap; the maker does, with the key of the version in the swap.
    const reg = { chain: 'solana' as const, swapRef: s.swapRef, noticeKey: noticeKey(s, w.makerEnc.encSecret), watcherSolanaKey: info.solana, deployment: DEPLOYMENT, issuedAt: await w.now() };
    await expect(svc.client.register({ ...reg, lockerEncSecret: o.plan.keys.encSecret })).rejects.toMatchObject({ status: 403 });
    await svc.client.register({ ...reg, lockerEncSecret: w.makerEnc.encSecret });
    const operatorBefore = await w.balance(w.operator.publicKey);
    const takerBefore = await w.balance(w.taker.publicKey);

    // The taker never pays XMR and posts a notice for a transaction that does not exist.
    await w.exec(s, takerStep({ swap: s, now: await w.now(), paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, new Uint8Array(32).fill(0xfb), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapPda))!;
    const dl = deadlinesOf('solana', s);
    expect(await svc.pass(o.plan.swapPda)).toEqual({ do: 'wait', on: 'lock-check', until: dl.tCut });
    await w.warpTo(dl.tCut!);
    expect(await svc.pass(o.plan.swapPda)).toMatchObject({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', why: 'lock-not-confirmed' });
    s = (await w.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const ff = deadlinesOf('solana', s).tFf!;

    // Without the freeze the taker would claim the maker's escrow at T_co.
    await w.warpTo(dl.tCo!);
    expect(takerStep({ swap: s, now: await w.now(), paid: true })).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });
    const steal = solanaInstruction(w.client.program, s, await w.maker(), o.session.publicKey, { name: 'claim' }, { secret: o.plan.keys.spend });
    expect(await errorCode(w.send([steal], [o.session]))).toBe('TooEarly');
    expect((await w.swap(o.plan.swapPda))!.flags & SWAP_FLAG.REVEALED).toBe(0);

    // The daemon comes back inside the freeze window, verifies for itself and refunds.
    await w.warpTo(dl.tCo! + 120n);
    const mf: Partial<MakerFacts> = {};
    expect(makerStep({ swap: s, now: await w.now(), ...mf })).toEqual({ do: 'need', fact: 'notice-opening' });
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    const joint = swapJointAddress(s, opened.view, 'regtest');
    const lock = await xmr.verify(hex(opened.txid), jointKeys(joint), s.xmr, s.depth);
    const d = makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'operator', secret: true, notAfter: ff - 300n, row: 'Z3', urgent: true });
    await w.exec(s, d, {}, { secret: f.share.spend });
    // Z3 in B: the escrow returns to the maker and the take deposit to the taker at once; nothing is ever held.
    s = (await w.swap(o.plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.backouts_after_freeze, depositState: DEPOSIT_STATE.NONE });
    expect(hex(s.revealed)).toBe(hex(f.share.spend));
    expect(await counter('backouts_after_freeze')).toBe(backouts + 1);
    expect((await w.balance(w.operator.publicKey)) - operatorBefore > o.pricing.amount - 100_000n).toBe(true);
    expect((await w.balance(w.taker.publicKey)) - takerBefore >= o.pricing.deposit).toBe(true);
    expect(await openValue(0)).toBe(0n);
  });
});

// ------------------------------------------------------------------ wallet-derived key

describe('the wallet-derived key (SPEC 11.3)', () => {
  it('a swap opened with the wallet key is resumed on a "new device" from the wallet alone', async () => {
    await w.publishOffer({ asset: 0, direction: 0, mode: 0, price: PRICE });
    // A wallet that has never swapped; `signMessage` is the wallet's Ed25519 signature over the exact bytes.
    const wallet = seedSigner(new Uint8Array(32).fill(0x71));
    await w.svm.airdrop(wallet.publicKey, 10_000_000_000n);
    const ctx = { chain: 'solana' as const, wallet: wallet.publicKey, genesisHash: w.genesis, programId: PROGRAM_ID };
    let prompts = 0;
    const signMessage = async () => {
      prompts++;
      return wallet.sign(walletKeySolanaRequest(ctx).bytes);
    };
    const known = async () => (await w.client.listSwapsByTaker(wallet.publicKey)).map((s) => ({ swapNonce: s.swapNonce, takerSpendPub: s.takerSpendPub }));

    // First use: no swaps on chain, so the wallet signs twice and the two signatures must agree.
    expect(await known()).toEqual([]);
    const first = await unlockWalletSeed(ctx, signMessage, await known());
    expect(prompts).toBe(2);
    expect(first.provedBy).toBe('two-signatures');
    const o = await open(0, 0, X, { seed: first.seed, taker: wallet });
    expect(o.s.state).toBe(SWAP_STATE.ACTIVE);
    const share = w.shares.get(hex(o.s.makerSpendPub))!;
    const joint = swapJointAddress(o.s, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, o.s.xmr);
    await notice(o.s, share, xmr.txidBytes(lockTx.txid));
    await xmr.relay(lockTx.txHex);
    await xmr.settle(2);

    // ---- a new device: no recovery file, no session storage, only the wallet.
    prompts = 0;
    const swaps = await known();
    expect(swaps.length).toBe(1);
    const again = await unlockWalletSeed(ctx, signMessage, swaps);
    // A returning user signs once; the seed is proved against the commitment stored in its swap.
    expect(prompts).toBe(1);
    expect(again).toMatchObject({ provedBy: 'swap-commitments', swapsChecked: 1 });
    expect(hex(again.seed)).toBe(hex(first.seed));
    // Another wallet's key, or a wallet that signs differently, would not reproduce the commitment.
    const other = seedSigner(new Uint8Array(32).fill(0x72));
    await expect(unlockWalletSeed({ ...ctx, wallet: other.publicKey }, async () => other.sign(walletKeySolanaRequest({ ...ctx, wallet: other.publicKey }).bytes), swaps)).rejects.toMatchObject({ code: 'WalletSeedMismatch' });

    // Everything about the swap comes back from chain state and that seed: verify the lock, set ready.
    let s = (await w.client.listSwapsByTaker(wallet.publicKey))[0]!;
    expect(s.state).toBe(SWAP_STATE.NOTICED);
    const keys = resumeSwapKeys(again.seed, 'solana', s.swapNonce);
    const opened = openNotice(s, keys.encSecret)!;
    expect(hex(opened.txid)).toBe(lockTx.txid);
    const takerJoint = swapJointAddress(s, opened.view, 'regtest');
    const lock = await xmr.verifyUntil(lockTx.txid, jointKeys(takerJoint), s.xmr, s.depth, 'confirmed');
    await w.warpTo(deadlinesOf('solana', s).tReadyMin!);
    const d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'set_ready' }, caller: 'session' });
    await w.exec(s, d, { session: seedSigner(keys.sessionSecret) });
    s = (await w.swap(o.plan.swapPda))!;
    expect(s.state).toBe(SWAP_STATE.READY);
    // The maker claims; the resumed keys sweep the XMR.
    await w.exec(s, makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) }), {}, { secret: share.spend });
    s = (await w.swap(o.plan.swapPda))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, keys.spend, 'taker'), viewKey: takerJoint.viewPriv, lock, txid: lockTx.txid });
    expect(swept.published).toBe(true);

    // "Export recovery file" in this mode: the ordinary file, holding the derived seed.
    const file = walletKeyRecoveryFile(ctx, again.seed, { programId: PROGRAM_ID, contract: '0x0000000000000000000000000000000000000000' });
    expect(file.wallets.solana).toEqual([wallet.publicKey]);
    expect(hex(resumeSwapKeys(Uint8Array.from(Buffer.from(file.seed, 'hex')), 'solana', s.swapNonce).spendPub)).toBe(hex(s.takerSpendPub));
  });
});
