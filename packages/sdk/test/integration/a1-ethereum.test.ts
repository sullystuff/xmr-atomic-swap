// Amendment 1 on Ethereum (SPEC 11): beta caps, the payout address of a sell with `pushOwed`,
// the keyless freeze by a watcher in both directions, and a swap resumed from the wallet-derived
// seed. The SDK against the real contract on a local anvil, with real XMR on the Monero regtest.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DerivedKeys, type EthQuote, type JointAddress, init } from '@xmrswap/core-wasm';
import { type Address, COUNTER, DEPOSIT_STATE, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import { encodeFunctionData, parseAbi } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { ContractError, ETH_SESSION_GAS, ETH_SESSION_GAS_MARGIN_PCT, ETH_SESSION_GAS_PER_CALL, ETH_WATCHER_GAS, ethSessionBudget } from '../../src/ethereum/client.js';
import { ethereumCall } from '../../src/flows/execute.js';
import { buildNotice, jointSpendKey, newSwapNonce, openNotice, swapJointAddress, takerSwapKeys } from '../../src/flows/keys.js';
import { makerStep } from '../../src/flows/maker.js';
import { planEthereumOpen } from '../../src/flows/open.js';
import { takerStep } from '../../src/flows/taker.js';
import { type SwapView, deadlinesOf, isCounted } from '../../src/machine/view.js';
import { fetchPool, fetchProof, leafArgument, pickLeaf, uploadOwnProof } from '../../src/messages/blobs.js';
import type { HttpFetch } from '../../src/messages/transports.js';
import { resumeSwapKeys } from '../../src/recovery/file.js';
import { CapReached } from '../../src/registry/caps.js';
import { priceEthQuote } from '../../src/registry/pricing.js';
import { signEthQuote } from '../../src/signing/eip712.js';
import { type Bytes, hex, hex0x, unhex } from '../../src/util.js';
import { unlockWalletSeed, walletKeyRecoveryFile, walletKeyTypedData } from '../../src/wallet/seed.js';
import { WATCH_ROUTES, WatcherClient, noticeKey, noticeKeyFor, parseWatchRequest, signWatchAck, verifyWatchRequest, watchDeployment } from '../../src/watcher/protocol.js';
import { type WatcherDecision, watcherFacts, watcherStep } from '../../src/watcher/step.js';
import { DEFAULT_ETH_CAPS, ETH_NATIVE, type EthWorld, fundForGas, startEthereum } from './eth.js';
import * as xmr from './xmr.js';

let w: EthWorld;
const X = xmr.XMR;
const takerSeed = new Uint8Array(32).fill(53);
const zero20 = new Uint8Array(20);
const BUDGET = ethSessionBudget(5_000_000_000n);
const M = 1800n;
/** A day: on Ethereum the claim delay is two hours, so a shorter window frozen at T_cut would end before T_co. */
const FREEZE_WINDOW = 86_400;
/** The watcher's Ed25519 seed: its Solana key, to which notice keys are sealed and which signs acknowledgements. */
const WATCHER_SEED = new Uint8Array(32).fill(9);
let quoteCounter = 500n;

beforeAll(async () => {
  await init();
  w = await startEthereum();
  await xmr.funded();
});
afterAll(async () => {
  await w?.stop();
});

const takerAddr = () => w.taker.address.toLowerCase() as Address;
const makerAddr = () => w.owner.address.toLowerCase() as Address;
const lower = (a: PrivateKeyAccount) => a.address.toLowerCase() as Address;
const jointKeys = (j: JointAddress) => ({ viewPriv: hex(j.viewPriv), spendPub: hex(j.spendPub) });
const openValue = async (token: Address): Promise<bigint> => (await w.client.capsOf(token, 'latest')).openValue;
const counter = async (name: keyof typeof COUNTER): Promise<number> => (await w.maker()).counters[COUNTER[name]]!;
const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof ContractError || e instanceof CapReached ? e.code : `other: ${(e as Error).message}`;
  }
  return 'accepted';
};

async function signQuote(over: Partial<EthQuote> & { direction: 0 | 1 }): Promise<{ q: EthQuote; sig: Uint8Array }> {
  const m = await w.maker();
  const token = over.token ?? unhex(ETH_NATIVE);
  const usdc = hex0x(token) === w.usdc;
  const q: EthQuote = {
    maker: unhex(makerAddr()), taker: zero20, token, approvalMode: 0, minXmr: X / 100n, maxXmr: 1000n * X,
    tierXmr: [0n, 0n, 0n], tierPrice: [usdc ? 150_000_000n : 60_000_000_000_000_000n, 0n, 0n], depthXmr: [0n, 0n, 0n], depth: [2, 0, 0],
    depositBps: 100, approvalWindow: 600, noticeWindow: 1800, claimDelay: 7200, claimWindow: 5400, finalWindow: 604_800,
    validUntil: (await w.now()) + 170n, epoch: m.quoteEpoch, keyRoot: over.direction === 0 ? w.newPool(2) : new Uint8Array(32), quoteId: ++quoteCounter, freezeWindow: 0, ...over,
  };
  return { q, sig: await signEthQuote(w.operatorKey, w.deployment, q) };
}

/** A direction-A lock, reading the caps first as a client does. Returns the pending swap. */
async function lockA(q: EthQuote, sig: Uint8Array, xmrAmount: bigint, extra: { watcher?: Address; seed?: Bytes; taker?: PrivateKeyAccount } = {}) {
  const taker = extra.taker ?? w.taker;
  const seed = extra.seed ?? takerSeed;
  const pool = await fetchPool(w.http, q.keyRoot);
  const leaf = await pickLeaf(pool, { isKeyUsed: (k) => w.client.isKeyUsed(makerAddr(), k, 'latest') });
  const swapNonce = newSwapNonce();
  const keys = takerSwapKeys(seed, 'ethereum', swapNonce);
  await fetchProof(w.http, { spendPub: leaf.spendPub, keyAddr: leaf.key, keyAddr2: leaf.key2 }, [keys.spendPub]);
  await uploadOwnProof(w.http, keys.spend);
  const caps = await w.client.capsOf(hex0x(q.token) as Address, 'latest');
  const plan = planEthereumOpen({ contract: w.client.contract, taker: lower(taker), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed, swapNonce, xmr: xmrAmount, leaf: leafArgument(pool, leaf), sessionBudget: BUDGET, caps, ...(extra.watcher ? { watcher: extra.watcher } : {}) });
  if (hex0x(q.token) === w.usdc) await w.usdcApprove(taker, plan.amount);
  await w.send(plan.call, taker);
  return { plan, session: privateKeyToAccount(hex0x(plan.keys.sessionSecret)), s: (await w.swap(plan.swapId))!, pricing: priceEthQuote(q, xmrAmount) };
}

async function makerApproves(s: SwapView): Promise<{ s: SwapView; share: DerivedKeys }> {
  const d = makerStep({ swap: s, now: await w.now(), takerProofOk: true, approval: { approve: true } });
  expect(d).toMatchObject({ do: 'call', call: { name: 'approve' } });
  await w.exec(s, d, {});
  const active = (await w.swap(s.swapRef))!;
  expect(active.state).toBe(SWAP_STATE.ACTIVE);
  return { s: active, share: w.shares.get(hex(active.makerSpendPub))! };
}

async function notice(s: SwapView, share: DerivedKeys, txid: Uint8Array): Promise<SwapView> {
  const d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
  expect(d).toMatchObject({ do: 'call', call: { name: 'post_notice' } });
  await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, txid, share.view) });
  return (await w.swap(s.swapRef))!;
}

/** A direction-B take. Returns the pending swap. */
async function takeB(q: EthQuote, sig: Uint8Array, xmrAmount: bigint, extra: { payout?: Address } = {}) {
  const swapNonce = newSwapNonce();
  const keys = takerSwapKeys(takerSeed, 'ethereum', swapNonce);
  await uploadOwnProof(w.http, keys.spend);
  const token = hex0x(q.token) as Address;
  const caps = await w.client.capsOf(token, 'latest');
  const plan = planEthereumOpen({ contract: w.client.contract, taker: takerAddr(), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, swapNonce, xmr: xmrAmount, sessionBudget: BUDGET, caps, ...(extra.payout ? { payout: extra.payout } : {}) });
  if (token === w.usdc) await w.usdcApprove(w.taker, plan.deposit);
  await w.send(plan.call, w.taker);
  return { plan, session: privateKeyToAccount(hex0x(plan.keys.sessionSecret)), s: (await w.swap(plan.swapId))!, pricing: priceEthQuote(q, xmrAmount) };
}

/** The maker funds a pending take with a fresh share, optionally naming its watcher. */
async function fund(s: SwapView, watcher?: Address) {
  const share = w.newShare();
  const d = makerStep({ swap: s, now: await w.now(), takerProofOk: true, approval: { approve: true } });
  expect(d).toMatchObject({ do: 'call', call: { name: 'fund' } });
  if (s.asset === w.usdc) await w.usdcApprove(w.operator, s.amount);
  await w.exec(s, d, {}, { makerShare: { spendPub: share.keys.spendPub, key: share.key, key2: share.key2, view: share.keys.view }, ...(watcher ? { watcher } : {}) });
  return { s: (await w.swap(s.swapRef))!, share: share.keys };
}

// ------------------------------------------------------------------ a watcher service, in process

function watcherService() {
  const keys = new Map<string, Uint8Array>();
  const posted: string[] = [];
  const { ed25519 } = require_noble();
  const solanaKey = require_base58(ed25519.getPublicKey(WATCHER_SEED));
  const fetchFn: HttpFetch = async (url, init) => {
    const reply = (status: number, j: unknown) => ({ status, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer });
    if (url.endsWith(WATCH_ROUTES.info)) return reply(200, { solana: solanaKey, ethereum: w.watcher.address, max_swaps: 10, monero_nodes: xmr.NODES.length });
    if (url.endsWith(WATCH_ROUTES.swaps) && init.method === 'POST') {
      posted.push(init.body as string);
      // Accepted only if the swap exists at `finalized`, names this watcher and is not settled, and the
      // request verifies against it: only the swap's locker can have sealed it.
      const parsed = parseWatchRequest(JSON.parse(init.body as string));
      const s = await w.client.getSwap(parsed.swapRef, 'finalized');
      if (!s || s.watcherAddress !== lower(w.watcher) || s.state === SWAP_STATE.DONE) return reply(404, { error: 'no such swap names this watcher' });
      let req;
      try {
        req = verifyWatchRequest(JSON.parse(init.body as string), { watcherSeed: WATCHER_SEED, swap: s, deployment: watchDeployment({ chainId: w.deployment.chainId, contract: w.contract }), now: await w.now() });
      } catch (e) {
        return reply(403, { error: (e as { code?: string }).code });
      }
      keys.set(hex(req.swapRef), req.noticeKey);
      const until = (s.tNoteDeadline === 0n ? s.tFinal : s.tNoteDeadline) + BigInt(s.dC);
      return reply(200, signWatchAck({ chain: req.chain, swapRef: req.swapRef, watchingUntil: until, watcherSeed: WATCHER_SEED }));
    }
    return reply(404, {});
  };
  async function pass(swapId: Bytes): Promise<WatcherDecision> {
    const key = keys.get(hex(swapId));
    if (!key) throw new Error('the watcher was never given this swap');
    await w.finalize();
    const swap = await w.client.getSwap(swapId, 'finalized');
    const base = { swap, now: await w.client.chainTime('finalized'), watcher: lower(w.watcher) };
    let d = watcherStep(base);
    if (d.do === 'need') {
      const facts = await watcherFacts({ swap: swap!, noticeKey: key, nodes: xmr.NODES, network: 'regtest' });
      d = watcherStep({ ...base, ...facts });
    }
    if (d.do === 'call') await w.exec(swap!, d, {});
    return d;
  }
  return { client: new WatcherClient('https://watcher.test', fetchFn), pass, posted, keys, solanaKey };
}
import { ed25519 as nobleEd25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@xmrswap/protocol';
const require_noble = () => ({ ed25519: nobleEd25519 });
const require_base58 = (b: Uint8Array): string => base58Encode(b);

// ------------------------------------------------------------------ caps

describe('beta caps (SPEC 11.1)', () => {
  it('a swap exactly at the caps opens; one above is refused by the client and by the contract; exits free the open value', async () => {
    // The world's caps are out of reach; the owner now sets the beta's for ETH: one swap of 1 XMR, two open at once.
    const { q, sig } = await signQuote({ direction: 0 });
    const one = priceEthQuote(q, X).amount;
    expect(await w.client.capsOf(ETH_NATIVE, 'latest')).toEqual({ on: true, maxSwap: DEFAULT_ETH_CAPS.maxSwap, maxOpen: DEFAULT_ETH_CAPS.maxOpen, openValue: 0n });
    await w.setCaps(ETH_NATIVE, one, 2n * one);
    const caps = await w.client.capsOf(ETH_NATIVE, 'latest');
    expect(caps).toEqual({ on: true, maxSwap: one, maxOpen: 2n * one, openValue: 0n });
    // USDC is another asset with its own caps.
    expect((await w.client.capsOf(w.usdc, 'latest')).maxSwap).toBe(DEFAULT_ETH_CAPS.maxSwap);

    // Exactly at the per-swap cap.
    const first = await lockA(q, sig, X);
    expect(first.s).toMatchObject({ state: SWAP_STATE.PENDING, amount: one });
    expect(isCounted(first.s)).toBe(true);
    expect(await openValue(ETH_NATIVE)).toBe(one);

    // Above it: "cap reached" from the client before anything is signed, and a revert when a client skips the check.
    const blind = async (xmrAmount: bigint, quote: { q: EthQuote; sig: Uint8Array }) => {
      const pool = await fetchPool(w.http, quote.q.keyRoot);
      const leaf = await pickLeaf(pool, { isKeyUsed: (k) => w.client.isKeyUsed(makerAddr(), k, 'latest') });
      const swapNonce = newSwapNonce();
      await uploadOwnProof(w.http, takerSwapKeys(takerSeed, 'ethereum', swapNonce).spend);
      return { leaf: leafArgument(pool, leaf), swapNonce };
    };
    const q2 = await signQuote({ direction: 0 });
    const b = await blind(X + 10n ** 6n, q2);
    const input = { contract: w.client.contract, taker: takerAddr(), quote: q2.q, sig: q2.sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, swapNonce: b.swapNonce, leaf: b.leaf, sessionBudget: BUDGET, slippageBps: 100 };
    expect(await errorCode((async () => planEthereumOpen({ ...input, xmr: X + 10n ** 6n, caps: await w.client.capsOf(ETH_NATIVE, 'latest') }))())).toBe('SwapCapExceeded');
    expect(await errorCode(w.send(planEthereumOpen({ ...input, xmr: X + 10n ** 6n }).call, w.taker))).toBe('SwapCapExceeded');
    expect(() => priceEthQuote(q2.q, X + 10n ** 6n, caps)).toThrow(CapReached);

    // A second swap fills the open value exactly; a third has no headroom.
    const second = await lockA(q2.q, q2.sig, X);
    expect(await openValue(ETH_NATIVE)).toBe(2n * one);
    const q3 = await signQuote({ direction: 0 });
    const b3 = await blind(X, q3);
    const input3 = { ...input, quote: q3.q, sig: q3.sig, swapNonce: b3.swapNonce, leaf: b3.leaf, xmr: X };
    expect(await errorCode((async () => planEthereumOpen({ ...input3, caps: await w.client.capsOf(ETH_NATIVE, 'latest') }))())).toBe('OpenCapExceeded');
    expect(await errorCode(w.send(planEthereumOpen(input3).call, w.taker))).toBe('OpenCapExceeded');

    // Exit: the taker cancels the pending first swap.
    await w.exec(first.s, takerStep({ swap: first.s, now: await w.now(), cancel: true }), { session: first.session });
    expect(isCounted((await w.swap(first.plan.swapId))!)).toBe(false);
    expect(await openValue(ETH_NATIVE)).toBe(one);
    // The owner lowers the caps to zero. Invariant 3: the open swap goes on as if nothing had changed...
    await w.setCaps(ETH_NATIVE, 0n, 0n);
    expect(await errorCode(w.send(planEthereumOpen(input3).call, w.taker))).toBe('SwapCapExceeded');
    const approved = await makerApproves(second.s);
    // ...a keyed refund frees its value when the swap enters the hold...
    await w.exec(approved.s, takerStep({ swap: approved.s, now: await w.now(), cancel: true }), { session: second.session }, { secret: second.plan.keys.spend });
    const held = (await w.swap(second.plan.swapId))!;
    expect(held.state).toBe(SWAP_STATE.HOLD);
    expect(await openValue(ETH_NATIVE)).toBe(0n);
    // ...and the held deposit is released at T_hold.
    await w.advanceTo(deadlinesOf('ethereum', held).tHold!);
    await w.exec(held, takerStep({ swap: held, now: await w.now() }), {});
    expect(await w.swap(second.plan.swapId)).toMatchObject({ state: SWAP_STATE.DONE, depositState: DEPOSIT_STATE.RETURNED });
    await w.setCaps(ETH_NATIVE, DEFAULT_ETH_CAPS.maxSwap, DEFAULT_ETH_CAPS.maxOpen);
  });

  it('open value is freed by the other ways a swap can end, in both directions', async () => {
    const freed: string[] = [];
    const expectFreed = async (token: Address, label: string) => {
      expect(await openValue(token), label).toBe(0n);
      freed.push(label);
    };
    // ---- direction A: rejected; lapsed; no notice by the deadline; claimed without ready
    {
      const { q, sig } = await signQuote({ direction: 0 });
      const o = await lockA(q, sig, X);
      expect(await openValue(ETH_NATIVE)).toBe(o.pricing.amount);
      await w.exec(o.s, makerStep({ swap: o.s, now: await w.now(), takerProofOk: true, approval: { approve: false, reason: 0 } }), {});
      await expectFreed(ETH_NATIVE, 'A reject');
    }
    {
      const { q, sig } = await signQuote({ direction: 0 });
      const o = await lockA(q, sig, X);
      await w.advanceTo(deadlinesOf('ethereum', o.s).tPend!);
      await w.exec(o.s, takerStep({ swap: o.s, now: await w.now() }), {});
      await expectFreed(ETH_NATIVE, 'A expire_pending');
    }
    {
      const { q, sig } = await signQuote({ direction: 0 });
      const o = await lockA(q, sig, X);
      const a = await makerApproves(o.s);
      await w.advanceTo(deadlinesOf('ethereum', a.s).tNote!);
      await w.exec(a.s, takerStep({ swap: a.s, now: await w.now() }), {});
      await expectFreed(ETH_NATIVE, 'A refund_unnoticed');
    }
    {
      const { q, sig } = await signQuote({ direction: 0 });
      const o = await lockA(q, sig, X);
      const a = await makerApproves(o.s);
      const s = await notice(a.s, a.share, new Uint8Array(32).fill(0xe2));
      await w.advanceTo(deadlinesOf('ethereum', s).tCo!);
      expect(await openValue(ETH_NATIVE)).toBe(o.pricing.amount);
      await w.exec(s, makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withoutReady: 'claim' }), {}, { secret: a.share.spend });
      await expectFreed(ETH_NATIVE, 'A claim');
    }
    // ---- direction B counts amount + deposit from the take
    {
      const { q, sig } = await signQuote({ direction: 1 });
      const o = await takeB(q, sig, X);
      expect(await openValue(ETH_NATIVE)).toBe(o.pricing.amount + o.pricing.deposit);
      await w.exec(o.s, takerStep({ swap: o.s, now: await w.now(), cancel: true }), { session: o.session });
      await expectFreed(ETH_NATIVE, 'B cancel_pending');
    }
    {
      const { q, sig } = await signQuote({ direction: 1 });
      const o = await takeB(q, sig, X);
      const f = await fund(o.s);
      expect(await openValue(ETH_NATIVE)).toBe(o.pricing.amount + o.pricing.deposit);
      const d = makerStep({ swap: f.s, now: await w.now(), backOut: true });
      expect(d).toMatchObject({ do: 'call', call: { name: 'refund' }, row: 'B9a' });
      await w.exec(f.s, d, {}, { secret: f.share.spend });
      await expectFreed(ETH_NATIVE, 'B maker backs out');
    }
    expect(freed.length).toBe(6);
  });
});

// ------------------------------------------------------------------ payout address

describe('a sell with a fresh payout address (SPEC 11.2)', () => {
  const blacklist = (who: Address, on: boolean) => w.send({ to: w.usdc, data: encodeFunctionData({ abi: parseAbi(['function setBlacklisted(address who, bool on)']), functionName: 'setBlacklisted', args: [who, on] }), value: 0n }, w.stranger);

  it('the claim pays an address that holds no ETH and signs nothing; the taking wallet receives nothing', async () => {
    const fresh = lower(privateKeyToAccount(hex0x(new Uint8Array(32).fill(0x61))));
    expect(await w.balance(fresh)).toBe(0n);
    expect(await w.client.payoutProblem(fresh)).toEqual({ verdict: 'ok', reason: null });
    // What the contract reverts on, the client refuses first: zero, and the contract itself.
    expect(await w.client.payoutProblem(ETH_NATIVE)).toEqual({ verdict: 'refuse', reason: 'invalid-address' });
    expect(await w.client.payoutProblem(w.contract)).toEqual({ verdict: 'refuse', reason: 'invalid-address' });
    // A contract address is possible but said: the mock USDC has code.
    expect(await w.client.payoutProblem(w.usdc)).toEqual({ verdict: 'warn', reason: 'contract' });

    const { q, sig } = await signQuote({ direction: 1, token: unhex(w.usdc) });
    const takerUsdc = await w.usdcBalance(w.taker.address);
    const o = await takeB(q, sig, 2n * X, { payout: fresh });
    expect(o.s).toMatchObject({ state: SWAP_STATE.PENDING, payout: 'other', payoutAddress: fresh });
    expect(await openValue(w.usdc)).toBe(o.pricing.amount + o.pricing.deposit);
    const f = await fund(o.s);
    let s = f.s;
    // The taker pays real XMR and posts the notice; the maker verifies on two nodes and sets ready.
    const joint = swapJointAddress(s, o.plan.keys.view, 'regtest');
    const paid = await xmr.pay(joint.address, s.xmr);
    await w.exec(s, takerStep({ swap: s, now: await w.now(), makerProofOk: true, paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, xmr.txidBytes(paid), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapId))!;
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    const makerJoint = swapJointAddress(s, opened.view, 'regtest');
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(paid, jointKeys(makerJoint), s.xmr, s.depth, 'confirmed');
    await w.advanceTo(deadlinesOf('ethereum', s).tReadyMin!);
    await w.exec(s, makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock), commitmentsOk: true }), {});
    s = (await w.swap(o.plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.READY);
    // The session key claims; amount − fee + the take deposit arrive at the fresh address.
    const d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, caller: 'session', row: 'B10a' });
    await w.exec(s, d, { session: o.session }, { secret: o.plan.keys.spend });
    s = (await w.client.getSwap(o.plan.swapId, 'latest', true))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed, owedTaker: 0n });
    expect(await w.usdcBalance(fresh)).toBe(o.pricing.amount - o.pricing.fee + o.pricing.deposit);
    expect(await w.usdcBalance(w.taker.address)).toBe(takerUsdc - o.pricing.deposit);
    expect(await w.balance(fresh)).toBe(0n);
    expect(await openValue(w.usdc)).toBe(0n);
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, f.share.spend, 'maker'), viewKey: makerJoint.viewPriv, lock, txid: paid });
    expect(swept.published).toBe(true);
  });

  it('proceeds that cannot be pushed are parked under the payout address; anyone delivers them with pushOwed', async () => {
    const freshAccount = privateKeyToAccount(hex0x(new Uint8Array(32).fill(0x62)));
    const fresh = lower(freshAccount);
    const { q, sig } = await signQuote({ direction: 1, token: unhex(w.usdc) });
    const takerUsdc = await w.usdcBalance(w.taker.address);
    const o = await takeB(q, sig, X, { payout: fresh });
    const f = await fund(o.s);
    let s = f.s;
    // The escrow only sees the notice: no XMR is needed for the parking path.
    await w.exec(s, takerStep({ swap: s, now: await w.now(), makerProofOk: true, paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, new Uint8Array(32).fill(0xe3), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapId))!;
    await w.advanceTo(deadlinesOf('ethereum', s).tCo!);
    // The token refuses the transfer to the payout address at the moment of the claim.
    await blacklist(fresh, true);
    const claim = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(claim).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'B10b' });
    await w.exec(s, claim, { session: o.session }, { secret: o.plan.keys.spend });
    const proceeds = o.pricing.amount - o.pricing.fee + o.pricing.deposit;
    s = (await w.client.getSwap(o.plan.swapId, 'latest', true))!;
    // The claim succeeded (its secret is public); the proceeds are owed to the payout address, not to the taker.
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, payout: 'other', payoutAddress: fresh, owedTaker: proceeds });
    expect(s.flags & SWAP_FLAG.REVEALED).toBeTruthy();
    expect(await w.client.owedOf(w.usdc, fresh, 'latest')).toBe(proceeds);
    expect(await w.client.owedOf(w.usdc, takerAddr(), 'latest')).toBe(0n);
    expect(await w.usdcBalance(fresh)).toBe(0n);
    expect(await openValue(w.usdc)).toBe(0n);
    // The taking wallet has nothing to pull.
    expect(await errorCode(w.send(w.client.contract.withdrawOwed(w.usdc, takerAddr()), w.taker))).toBe('NothingOwed');
    // The flow says what to do: anyone pushes the balance to the payout address itself.
    const d = takerStep({ swap: s, now: await w.now(), paid: true });
    expect(d).toEqual({ do: 'call', call: { name: 'push_owed', who: 'payout' }, caller: 'anyone', secret: false, notAfter: null, row: 'deliver_owed' });
    // While the address still cannot receive, the push reverts and the balance stays parked.
    await expect(w.exec(s, d, {})).rejects.toBeInstanceOf(ContractError);
    expect(await w.client.owedOf(w.usdc, fresh, 'latest')).toBe(proceeds);
    await blacklist(fresh, false);
    // A stranger pays the gas; the payout address needs no ETH at all.
    expect(await w.balance(fresh)).toBe(0n);
    const strangerUsdc = await w.usdcBalance(w.stranger.address);
    await w.exec(s, d, {});
    expect(await w.usdcBalance(fresh)).toBe(proceeds);
    expect(await w.usdcBalance(w.stranger.address)).toBe(strangerUsdc);
    expect(await w.usdcBalance(w.taker.address)).toBe(takerUsdc - o.pricing.deposit);
    expect(await w.client.owedOf(w.usdc, fresh, 'latest')).toBe(0n);
    expect(await errorCode(w.send(w.client.contract.pushOwed(w.usdc, fresh), w.stranger))).toBe('NothingOwed');
    s = (await w.client.getSwap(o.plan.swapId, 'latest', true))!;
    expect(takerStep({ swap: s, now: await w.now(), paid: true })).toEqual({ do: 'done', outcome: 'completed' });
    void freshAccount;
  });
});

// ------------------------------------------------------------------ freeze, direction A

describe('a buy watched by a watcher (SPEC 11.6, direction A)', () => {
  const svc = watcherService();

  /** Lock naming the watcher's Ethereum key, have it approved, and hand the swap over once it is final. */
  async function watchedLock(xmrAmount: bigint) {
    const info = await svc.client.info();
    expect(info.ethereum).toBe(lower(w.watcher));
    const { q, sig } = await signQuote({ direction: 0, freezeWindow: FREEZE_WINDOW });
    const o = await lockA(q, sig, xmrAmount, { watcher: info.ethereum as Address });
    expect(o.s).toMatchObject({ state: SWAP_STATE.PENDING, watcher: true, watcherAddress: info.ethereum, wZ: FREEZE_WINDOW });
    const a = await makerApproves(o.s);
    // The notice key is computable before any notice exists; it is sealed to the watcher's Solana key whichever chain the swap is on.
    const key = noticeKeyFor({ side: 'taker', ownEncSecret: o.plan.keys.encSecret, peerEncPub: a.s.makerEncKey });
    expect(hex(key)).toBe(hex(noticeKey(a.s, o.plan.keys.encSecret)));
    // The service accepts a swap only once it finds it at `finalized`.
    const reg = { chain: 'ethereum' as const, swapRef: a.s.swapRef, noticeKey: key, watcherSolanaKey: info.solana, deployment: watchDeployment({ chainId: w.deployment.chainId, contract: w.contract }), issuedAt: await w.now() };
    await expect(svc.client.register({ ...reg, lockerEncSecret: o.plan.keys.encSecret })).rejects.toMatchObject({ status: 404 });
    await w.finalize();
    // A stranger (or the maker, the counterparty) cannot hand this swap to the watcher; nor does a request made for another contract open.
    for (const lockerEncSecret of [new Uint8Array(32).fill(0x33), w.makerEnc.encSecret]) await expect(svc.client.register({ ...reg, lockerEncSecret })).rejects.toMatchObject({ status: 403 });
    await expect(svc.client.register({ ...reg, lockerEncSecret: o.plan.keys.encSecret, deployment: watchDeployment({ chainId: 1, contract: w.contract }) })).rejects.toMatchObject({ status: 403 });
    expect(svc.keys.has(hex(a.s.swapRef))).toBe(false);
    const ack = await svc.client.register({ ...reg, lockerEncSecret: o.plan.keys.encSecret });
    expect(BigInt(ack.watching_until)).toBe(a.s.tNoteDeadline + BigInt(a.s.dC));
    expect(svc.posted.at(-1)).not.toContain(hex(key));
    return { ...o, s: a.s, share: a.share, key };
  }

  it('a watcher needs a quote with a freeze window', async () => {
    const { q, sig } = await signQuote({ direction: 0 });
    const pool = await fetchPool(w.http, q.keyRoot);
    const leaf = await pickLeaf(pool, { isKeyUsed: (k) => w.client.isKeyUsed(makerAddr(), k, 'latest') });
    const swapNonce = newSwapNonce();
    await uploadOwnProof(w.http, takerSwapKeys(takerSeed, 'ethereum', swapNonce).spend);
    const input = { contract: w.client.contract, taker: takerAddr(), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: takerSeed, swapNonce, xmr: X, leaf: leafArgument(pool, leaf), sessionBudget: BUDGET };
    expect(() => planEthereumOpen({ ...input, watcher: lower(w.watcher) })).toThrow(/WatcherNotAllowed/);
    // A client that skips the check: the contract refuses the same lock.
    const forced = w.client.contract.lock({ quote: q, sig, xmr: X, amount: priceEthQuote(q, X).amount, maxPay: priceEthQuote(q, X).amount, swapNonce, sessionKey: lower(w.stranger), sessionBudget: BUDGET, takerKeys: decodeTakerKeys(planEthereumOpen(input)), leaf: input.leaf, watcher: lower(w.watcher) });
    expect(await errorCode(w.send(forced, w.taker))).toBe('WatcherNotAllowed');
  });

  it('the tab is closed; the notice is false; the watcher freezes; the maker cannot claim at the claim delay; the taker returns inside the window and refunds', async () => {
    const { plan, s: active, share, pricing } = await watchedLock(X);
    const freezes = await counter('freezes');
    const refunds = await counter('refunds_after_freeze');
    expect(await svc.pass(plan.swapId)).toEqual({ do: 'wait', on: 'notice', until: active.tNoteDeadline });
    // The maker posts a notice for a transaction that does not exist and locks no XMR.
    let s = await notice(active, share, new Uint8Array(32).fill(0xfa));
    const dl = deadlinesOf('ethereum', s);
    expect(await svc.pass(plan.swapId)).toEqual({ do: 'wait', on: 'lock-check', until: dl.tCut });
    await w.advanceTo(dl.tCut!);
    expect(await svc.pass(plan.swapId)).toEqual({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', notAfter: dl.tCo! - M, why: 'lock-not-confirmed' });
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const ff = deadlinesOf('ethereum', s).tFf!;
    expect(ff).toBe(s.tFreeze + BigInt(FREEZE_WINDOW));
    expect(ff > dl.tCo!).toBe(true);
    expect(await counter('freezes')).toBe(freezes + 1);
    expect(await svc.pass(plan.swapId)).toEqual({ do: 'stop', why: 'frozen' });
    // It cannot freeze twice and can do nothing else; a stranger cannot freeze at all.
    expect(await errorCode(w.send(w.client.contract.freeze(plan.swapId), w.watcher))).toBe('BadState');
    expect(await errorCode(w.send(w.client.contract.setReady(plan.swapId), w.watcher))).toBe('Unauthorized');

    // The claim delay runs out. Without the freeze the maker would take the payment now.
    await w.advanceTo(dl.tCo!);
    expect(await errorCode(w.send(ethereumCall(w.client.contract, s, { name: 'claim' }, { secret: share.spend })!, w.operator))).toBe('TooEarly');
    expect(makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', withoutReady: 'claim' })).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });

    // The taker comes back inside the freeze window with chain state and its seed.
    await w.advanceTo(dl.tCo! + 3600n);
    const keys = resumeSwapKeys(takerSeed, 'ethereum', s.swapNonce);
    const opened = openNotice(s, keys.encSecret)!;
    const joint = swapJointAddress(s, opened.view, 'regtest');
    const lock = await xmr.verify(hex(opened.txid), jointKeys(joint), s.xmr, s.depth);
    expect(lock.state).toBe('not-found');
    const d = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'session', secret: true, notAfter: ff - M, row: 'Z3' });
    const takerBefore = await w.balance(w.taker.address);
    await w.exec(s, d, { session: privateKeyToAccount(hex0x(keys.sessionSecret)) }, { secret: keys.spend });
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.HOLD, depositState: DEPOSIT_STATE.HELD });
    expect((await w.balance(w.taker.address)) - takerBefore >= pricing.amount - pricing.deposit).toBe(true);
    expect(await counter('refunds_after_freeze')).toBe(refunds + 1);
    expect(await openValue(ETH_NATIVE)).toBe(0n);
  });

  it('the taker does NOT return: the lock was only slow; the maker claims at the frozen-final time, publishing its half, and the XMR is the taker\'s', async () => {
    const { plan, s: active, share, pricing } = await watchedLock(X);
    const claims = await counter('claims_after_freeze');
    const joint = swapJointAddress(active, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, active.xmr);
    let s = await notice(active, share, xmr.txidBytes(lockTx.txid));
    await xmr.relay(lockTx.txHex);
    const dl = deadlinesOf('ethereum', s);
    await w.advanceTo(dl.tCut!);
    // In the pool on both nodes, valid, but not confirmed at T_cut: the watcher freezes.
    expect(await svc.pass(plan.swapId)).toMatchObject({ do: 'call', call: { name: 'freeze' }, why: 'lock-not-confirmed' });
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const ff = deadlinesOf('ethereum', s).tFf!;
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(lockTx.txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    await w.advanceTo(dl.tCo!);
    expect(await errorCode(w.send(ethereumCall(w.client.contract, s, { name: 'claim' }, { secret: share.spend })!, w.operator))).toBe('TooEarly');
    await w.advanceTo(ff);
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, caller: 'operator', row: 'Z4', secret: true });
    const payoutBefore = await w.balance(w.payout.address);
    await w.exec(s, d, {}, { secret: share.spend });
    const done = (await w.swap(plan.swapId))!;
    expect(done).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.claims_after_freeze });
    expect(await counter('claims_after_freeze')).toBe(claims + 1);
    expect(await w.balance(w.payout.address)).toBe(payoutBefore + pricing.amount - pricing.fee);
    // The claim published the maker's half: the taker sweeps whenever it returns.
    expect(hex(done.revealed)).toBe(hex(share.spend));
    const keys = resumeSwapKeys(takerSeed, 'ethereum', done.swapNonce);
    const opened = openNotice(done, keys.encSecret)!;
    const takerJoint = swapJointAddress(done, opened.view, 'regtest');
    const swept = await xmr.sweep({ spendKey: jointSpendKey(done, keys.spend, 'taker'), viewKey: takerJoint.viewPriv, lock, txid: hex(opened.txid) });
    expect(swept.published).toBe(true);
    expect(await openValue(ETH_NATIVE)).toBe(0n);
  });

  it('a wrongly frozen honest swap is un-frozen by the taker setting ready, and completes normally', async () => {
    const { plan, s: active, share, session } = await watchedLock(X);
    const joint = swapJointAddress(active, share.view, 'regtest');
    const lockTx = await xmr.prepareTransfer(joint.address, active.xmr);
    let s = await notice(active, share, xmr.txidBytes(lockTx.txid));
    await xmr.relay(lockTx.txHex);
    await xmr.settle(2);
    const lock = await xmr.verifyUntil(lockTx.txid, jointKeys(joint), s.xmr, s.depth, 'confirmed');
    const dl = deadlinesOf('ethereum', s);
    await w.advanceTo(dl.tCut!);
    // An honest watcher leaves a confirmed lock alone...
    expect(await svc.pass(plan.swapId)).toEqual({ do: 'wait', on: 'recheck', until: dl.tCo! - M });
    // ...a malicious one freezes anyway. That is all it can do.
    await w.send(w.client.contract.freeze(plan.swapId), w.watcher);
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    // The taker returns, verifies for itself and sets ready.
    await w.advanceTo(deadlinesOf('ethereum', s).tReadyMin!);
    const ready = takerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(ready).toMatchObject({ do: 'call', call: { name: 'set_ready' }, caller: 'session', row: 'Z2' });
    await w.exec(s, ready, { session });
    s = (await w.swap(plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.READY);
    const d = makerStep({ swap: s, now: await w.now(), lockTx: 'relayed', lock: xmr.report(lock) });
    expect(d).toMatchObject({ do: 'call', call: { name: 'claim' }, row: 'A11a' });
    await w.exec(s, d, {}, { secret: share.spend });
    s = (await w.swap(plan.swapId))!;
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.completed });
    const swept = await xmr.sweep({ spendKey: jointSpendKey(s, plan.keys.spend, 'taker'), viewKey: joint.viewPriv, lock, txid: lockTx.txid });
    expect(swept.published).toBe(true);
  });
});

/** The taker keys a plan put in its calldata, to build the same lock with one argument changed. */
function decodeTakerKeys(plan: ReturnType<typeof planEthereumOpen>) {
  const twin = { spendPub: plan.keys.spendPub, viewShare: plan.keys.view, encKey: plan.keys.encPub, makerEncVersion: 1, makerEncKey: w.makerEnc.encPub };
  // The twin addresses are in the plan's own calldata; re-derive them through the SDK's helper.
  return { ...twin, ...twinOf(plan.keys.spend) };
}
import { twinCommitments } from '@xmrswap/core-wasm';
const twinOf = (spend: Bytes): { key: Address; key2: Address } => {
  const t = twinCommitments(spend);
  return { key: hex0x(t.keyAddr) as Address, key2: hex0x(t.keyAddr2) as Address };
};

// ------------------------------------------------------------------ freeze, direction B

describe('a sell watched by the maker\'s watcher (SPEC 11.6, direction B)', () => {
  it('the daemon is down; the taker posts a false notice; the watcher freezes; the taker cannot claim at the claim delay; the maker returns and refunds, and the deposit goes back at once', async () => {
    const svc = watcherService();
    const backouts = await counter('backouts_after_freeze');
    const { q, sig } = await signQuote({ direction: 1, freezeWindow: FREEZE_WINDOW });
    const o = await takeB(q, sig, X);
    const info = await svc.client.info();
    const f = await fund(o.s, info.ethereum as Address);
    let s = f.s;
    expect(s).toMatchObject({ state: SWAP_STATE.ACTIVE, watcher: true, watcherAddress: lower(w.watcher), wZ: FREEZE_WINDOW, payout: 'taker', payoutAddress: takerAddr() });
    await w.finalize();
    const reg = { chain: 'ethereum' as const, swapRef: s.swapRef, noticeKey: noticeKey(s, w.makerEnc.encSecret), watcherSolanaKey: info.solana, deployment: watchDeployment({ chainId: w.deployment.chainId, contract: w.contract }), issuedAt: await w.now() };
    await expect(svc.client.register({ ...reg, lockerEncSecret: o.plan.keys.encSecret })).rejects.toMatchObject({ status: 403 });
    await svc.client.register({ ...reg, lockerEncSecret: w.makerEnc.encSecret });

    // The taker never pays XMR and posts a notice for a transaction that does not exist.
    await w.exec(s, takerStep({ swap: s, now: await w.now(), makerProofOk: true, paid: true }), { session: o.session }, { notice: buildNotice(s, o.plan.keys.encSecret, new Uint8Array(32).fill(0xfb), o.plan.keys.view) });
    s = (await w.swap(o.plan.swapId))!;
    const dl = deadlinesOf('ethereum', s);
    expect(await svc.pass(o.plan.swapId)).toEqual({ do: 'wait', on: 'lock-check', until: dl.tCut });
    await w.advanceTo(dl.tCut!);
    expect(await svc.pass(o.plan.swapId)).toMatchObject({ do: 'call', call: { name: 'freeze' }, caller: 'watcher', why: 'lock-not-confirmed' });
    s = (await w.swap(o.plan.swapId))!;
    expect(s.state).toBe(SWAP_STATE.FROZEN);
    const ff = deadlinesOf('ethereum', s).tFf!;
    expect(ff > dl.tCo!).toBe(true);

    // Without the freeze the taker would claim the maker's escrow at T_co.
    await w.advanceTo(dl.tCo!);
    expect(takerStep({ swap: s, now: await w.now(), paid: true })).toEqual({ do: 'wait', on: 'ready', until: ff, warning: 'frozen' });
    expect(await errorCode(w.send(ethereumCall(w.client.contract, s, { name: 'claim' }, { secret: o.plan.keys.spend })!, o.session))).toBe('TooEarly');

    // The daemon comes back inside the freeze window, verifies for itself and refunds.
    await w.advanceTo(dl.tCo! + 3600n);
    const opened = openNotice(s, w.makerEnc.encSecret)!;
    const joint = swapJointAddress(s, opened.view, 'regtest');
    const lock = await xmr.verify(hex(opened.txid), jointKeys(joint), s.xmr, s.depth);
    const d = makerStep({ swap: s, now: await w.now(), noticeOpens: true, lock: xmr.report(lock) });
    expect(d).toEqual({ do: 'call', call: { name: 'refund' }, caller: 'operator', secret: true, notAfter: ff - M, row: 'Z3', urgent: true });
    const takerBefore = await w.balance(w.taker.address);
    const operatorBefore = await w.balance(w.operator.address);
    await w.exec(s, d, {}, { secret: f.share.spend });
    s = (await w.swap(o.plan.swapId))!;
    // Z3 in B: the escrow returns to the maker and the take deposit to the taker at once; nothing is held.
    expect(s).toMatchObject({ state: SWAP_STATE.DONE, outcome: COUNTER.backouts_after_freeze });
    expect(s.depositState).not.toBe(DEPOSIT_STATE.HELD);
    expect(await counter('backouts_after_freeze')).toBe(backouts + 1);
    expect((await w.balance(w.taker.address)) - takerBefore >= o.pricing.deposit).toBe(true);
    expect((await w.balance(w.operator.address)) - operatorBefore > o.pricing.amount - 10n ** 16n).toBe(true);
    expect(await openValue(ETH_NATIVE)).toBe(0n);
  });
});

// ------------------------------------------------------------------ wallet-derived key

describe('the wallet-derived key (SPEC 11.3)', () => {
  it('a swap opened with the wallet key is resumed on a "new device" from the wallet alone', async () => {
    // An externally owned account that has never swapped; `eth_signTypedData_v4` with RFC 6979 nonces.
    const wallet = privateKeyToAccount(hex0x(new Uint8Array(32).fill(0x71)));
    await fundForGas(w, lower(wallet));
    const ctx = { chain: 'ethereum' as const, wallet: lower(wallet), chainId: w.deployment.chainId, contract: w.contract };
    let prompts = 0;
    const signTypedData = async () => {
      prompts++;
      return unhex(await wallet.signTypedData(walletKeyTypedData(ctx)));
    };
    const known = async () => {
      await w.finalize();
      const ids = await w.client.swapsOf(lower(wallet));
      const swaps = await Promise.all(ids.map((id) => w.client.getSwap(unhex(id))));
      return swaps.map((s) => ({ swapNonce: s!.swapNonce, takerSpendPub: s!.takerSpendPub }));
    };
    expect(await known()).toEqual([]);
    const first = await unlockWalletSeed(ctx, signTypedData, []);
    expect(prompts).toBe(2);
    expect(first.provedBy).toBe('two-signatures');
    const { q, sig } = await signQuote({ direction: 0 });
    const o = await lockA(q, sig, X, { seed: first.seed, taker: wallet });
    const a = await makerApproves(o.s);

    // ---- a new device: only the wallet.
    prompts = 0;
    const swaps = await known();
    expect(swaps.length).toBe(1);
    const again = await unlockWalletSeed(ctx, signTypedData, swaps);
    expect(prompts).toBe(1);
    expect(again).toMatchObject({ provedBy: 'swap-commitments', swapsChecked: 1 });
    expect(hex(again.seed)).toBe(hex(first.seed));
    // A signature under another chain id or contract is not this deployment's key.
    await expect(unlockWalletSeed(ctx, async () => unhex(await wallet.signTypedData(walletKeyTypedData({ ...ctx, chainId: 1 }))), swaps)).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });

    // The resumed keys act on the swap: the session key derived from the seed cancels it (a keyed refund).
    const keys = resumeSwapKeys(again.seed, 'ethereum', a.s.swapNonce);
    expect(hex0x(keys.sessionPub)).toBe(a.s.sessionKey);
    const d = takerStep({ swap: a.s, now: await w.now(), cancel: true });
    expect(d).toMatchObject({ do: 'call', call: { name: 'refund' }, caller: 'session', row: 'A10a' });
    await w.exec(a.s, d, { session: privateKeyToAccount(hex0x(keys.sessionSecret)) }, { secret: keys.spend });
    expect(await w.swap(o.plan.swapId)).toMatchObject({ state: SWAP_STATE.HOLD });
    // "Export recovery file": the ordinary format, holding the derived seed, for this wallet.
    const file = walletKeyRecoveryFile(ctx, again.seed, { programId: '11111111111111111111111111111111', contract: w.contract });
    expect(file.wallets).toEqual({ solana: [], ethereum: [lower(wallet)] });
    expect(file.seed).toBe(hex(again.seed));
  });
});

// ------------------------------------------------------------------ gas of the amended calls

describe('gas (Amendment 1)', () => {
  it('the opens grew, the session-key calls still fit one budgeted slot, and a freeze is cheap', () => {
    const dearest = new Map<string, bigint>();
    for (const g of w.gas) dearest.set(g.fn, g.gasUsed > (dearest.get(g.fn) ?? 0n) ? g.gasUsed : (dearest.get(g.fn) ?? 0n));
    console.info(`ethereum gas after Amendment 1, dearest per call: ${[...dearest].map(([fn, used]) => `${fn} ${used}`).join(', ')}`);
    if (process.env.XMRSWAP_GAS_OUT) writeFileSync(`${process.env.XMRSWAP_GAS_OUT}.a1`, JSON.stringify(Object.fromEntries([...dearest].map(([k, v]) => [k, Number(v)])), null, 2));
    for (const fn of ['lock', 'take', 'fund', 'freeze', 'pushOwed', 'claim', 'refund', 'setReady', 'postNotice']) expect(dearest.has(fn), fn).toBe(true);
    // Every call a session key or a watcher sends fits the per-call figure the budget is sized by.
    for (const [fn, used] of dearest) if (fn !== 'lock' && fn !== 'take' && fn !== 'fund') expect(used <= ETH_SESSION_GAS_PER_CALL, `${fn} used ${used}`).toBe(true);
    // The session-key calls of this file stay within their measured figures plus the margin (a ready that
    // un-freezes, a claim paid to a fresh payout address); so do the watcher's and the deliverer's.
    const session = new Set([w.owner, w.operator, w.payout, w.taker, w.stranger, w.watcher].map((a) => a.address.toLowerCase()));
    for (const g of w.gas.filter((x) => !session.has(x.from) && x.fn in ETH_SESSION_GAS)) {
      const figure = ETH_SESSION_GAS[g.fn as keyof typeof ETH_SESSION_GAS];
      expect(g.gasUsed <= (figure * (100n + ETH_SESSION_GAS_MARGIN_PCT)) / 100n, `${g.fn} used ${g.gasUsed}, figure ${figure}`).toBe(true);
    }
    for (const fn of ['freeze', 'pushOwed'] as const) {
      const used = dearest.get(fn)!;
      expect(used <= (ETH_WATCHER_GAS[fn] * (100n + ETH_SESSION_GAS_MARGIN_PCT)) / 100n && used * 3n >= ETH_WATCHER_GAS[fn] * 2n, `${fn} used ${used}`).toBe(true);
    }
    // The opens are the wallet's. Measured here as whole transactions, the dearest variant of this file (a
    // lock with a watcher on the first write of the asset's open value: 621,433; a USDC take with a payout
    // address: 549,071); ethereum/STORAGE.md has the per-variant table.
    expect(dearest.get('lock')! < 690_000n).toBe(true);
    expect(dearest.get('take')! < 610_000n).toBe(true);
  });
});
