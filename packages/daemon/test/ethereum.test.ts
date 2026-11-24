// Ethereum side with the SDK's FakeEthereum: signed quotes on the Solana board with a served key
// pool, and the finality rule: state is acted on only at the `finalized` tag, so the daemon
// waits for finality before it approves, before it locks XMR, and before it claims.
import { beforeAll, describe, expect, it } from 'vitest';
import { type DerivedKeys, dleqProve, ethSwapId, init, keyLeaf, openHashEthereum, twinCommitments, x25519Public } from '@xmrswap/core-wasm';
import { IXmrSwapAbi, SWAP_STATE } from '@xmrswap/protocol';
import { type EthSwapStruct, type ModelSwap, NO_SWAP, apply, decodeSignedQuote, hex0x, parsePool, takerSwapKeys, verifyEthQuote, verifyProof } from '@xmrswap/sdk';
import { FakeEthereum } from '@xmrswap/sdk/testing';
import { type Abi, decodeFunctionData, keccak256, parseTransaction } from 'viem';
import type { Daemon } from '../src/daemon.js';
import { XMR } from './sim.js';
import { BASE_TOML, ENC_SECRET_V1, type World, makeWorld } from './world.js';

const CONTRACT = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const OWNER = '0x0fbfe9b14731dddd51b145d6b23104e8bf7f676b';
const TAKER = '0x0f8183aefdf068dd8489b6edbf4e07965cf29246';
const USDC = '0xf9ab76450f884b429b2c128ac26fca8c2efdd5f5';
const zero32 = `0x${'00'.repeat(32)}`;
const ETH_TOML = `${BASE_TOML}
[ethereum]
contract = "${CONTRACT}"
chain_id = 31337
maker_owner = "${OWNER}"
rpc_url_env = "TEST_ETH_RPC"

[tor]
enabled = true

[offers]
eth_pool_size = 4

[markets.eth.sell_xmr]
enabled = true
min_xmr = 0.1
max_xmr = 5
confirmation_depth = [{ above_xmr = 0, depth = 2 }]
`;

beforeAll(async () => {
  await init();
});

async function boot(): Promise<{ w: World; d: Daemon; eth: FakeEthereum; swaps: Map<string, { latest: EthSwapStruct; final: EthSwapStruct | null }> }> {
  const w = await makeWorld(ETH_TOML);
  const eth = new FakeEthereum(CONTRACT);
  const swaps = new Map<string, { latest: EthSwapStruct; final: EthSwapStruct | null }>();
  const none = { state: 0 } as EthSwapStruct;
  eth.views['getMaker'] = () => ({ operator: w.keystore.ethereum.address, payout: '0x00000000000000000000000000000000000000bb', quoteEpoch: 3, approvalEpoch: 2, paused: false, registeredAt: 5n, solanaOwner: zero32, solanaOwnerNext: zero32, solanaOwnerNextAt: 0n, openPending: 0, responseSecsSum: 0n, counters: new Array(40).fill(0) });
  eth.views['usdc'] = () => USDC;
  eth.views['owedOf'] = () => 0n;
  eth.views['getSwap'] = ([id], ctx) => {
    const s = swaps.get(String(id).toLowerCase());
    const at = ctx.tag === 'latest' ? s?.latest : s?.final;
    return at ?? { ...[...swaps.values()][0]?.latest, ...none };
  };
  for (const fn of ['approve', 'reject', 'postNotice', 'claim', 'abort']) eth.views[fn] = () => undefined;
  const d = await w.boot({ ethTransport: eth });
  await d.start();
  // The key pool is generated in the background; the first quote goes out on the refresh after it is complete.
  await d.offers.poolsReady();
  await d.offers.tick(true);
  return { w, d, eth, swaps };
}
/** The calls the daemon broadcast on Ethereum, decoded. */
const sentCalls = (eth: FakeEthereum) => eth.sentRaw.map((raw) => ({ hash: keccak256(raw), ...decodeFunctionData({ abi: IXmrSwapAbi as unknown as Abi, data: parseTransaction(raw).data! }) }));
const landed = (eth: FakeEthereum, hash: string, block: bigint) => eth.receipts.set(hash, { blockNumber: `0x${block.toString(16)}`, blockHash: eth.block(block).hash, status: '0x1' });

describe('Ethereum quotes on the Solana board', () => {
  it('signs each quote with the operator key, publishes it in the one refresh transaction, and serves the key pool and its proofs', async () => {
    const { w, d } = await boot();
    const setQuote = w.sim.landed.filter((l) => l.name === 'set_eth_quote');
    expect(setQuote).toHaveLength(1);
    const refresh = w.sim.landed.filter((l) => l.name === 'refresh_offers').slice(1);
    expect((w.sim.landed.find((l) => l.name === 'refresh_offers')!.args['eth'] as unknown[]).length).toBe(0); // at start the pool was not ready: no quote yet, and nothing waited for it
    expect(refresh).toHaveLength(1); // one transaction for the Solana offers AND the Ethereum quote
    expect((refresh[0]!.args['offers'] as unknown[]).length).toBe(1); // the buy offer has no paying balance in this world and was never published
    const ethRefresh = (refresh[0]!.args['eth'] as { slot: number; tierPrice: bigint[]; validUntil: bigint; quoteId: bigint; sig: Uint8Array }[])[0]!;
    expect(ethRefresh.slot).toBe(0);
    // 150 USD × 1.02 ÷ 3,000 USD per ETH = 0.051 ETH per XMR.
    expect(ethRefresh.tierPrice[0]).toBe(51_000_000_000_000_000n);
    // The board slot expands to the EIP-712 quote, and the refreshed fields carry a signature that recovers to the operator.
    const stored = decodeSignedQuote(Uint8Array.from([...(setQuote[0]!.args['quote'] as Uint8Array), ...(setQuote[0]!.args['sig'] as Uint8Array)]));
    const quote = { ...stored.quote, tierPrice: ethRefresh.tierPrice as [bigint, bigint, bigint], validUntil: ethRefresh.validUntil, quoteId: ethRefresh.quoteId };
    const deployment = { chainId: 31337n, contract: CONTRACT as `0x${string}` };
    expect(await verifyEthQuote(deployment, quote, ethRefresh.sig, w.keystore.ethereum.address.toLowerCase() as `0x${string}`)).toBe(true);
    expect(await verifyEthQuote(deployment, { ...quote, maxXmr: quote.maxXmr + 1n }, ethRefresh.sig, w.keystore.ethereum.address.toLowerCase() as `0x${string}`)).toBe(false);
    expect(quote).toMatchObject({ direction: 0, approvalMode: 0, minXmr: XMR / 10n, epoch: 3, depositBps: 0, approvalWindow: 120, noticeWindow: 1800, claimDelay: 10_800, claimWindow: 5400, depth: [2, 0, 0] });
    expect(hex0x(quote.maker)).toBe(OWNER);
    expect(quote.validUntil).toBe(eth_now(d) + 150n);
    // The pool route serves the leaves of that root; each leaf's proof is served and proves exactly the leaf.
    const leaves = d.offers.poolLeaves(Buffer.from(quote.keyRoot).toString('hex'))!;
    expect(leaves).toHaveLength(4);
    const pool = parsePool(JSON.stringify({ leaves }), quote.keyRoot);
    for (const leaf of pool.leaves) {
      const row = d.store.shareByPub(Buffer.from(leaf.spendPub).toString('hex'))!;
      expect(row).toMatchObject({ chain: 'ethereum', status: 'published', swap_ref: null });
      verifyProof(d.store.blob(row.spend_pub)!, { spendPub: leaf.spendPub, keyAddr: leaf.key, keyAddr2: leaf.key2 });
    }
    // The next refresh keeps the quote id and the pool; only the dynamic fields move.
    w.sim.warp(15);
    w.prices.xmr = 160;
    await d.offers.tick();
    expect(w.sim.landed.filter((l) => l.name === 'set_eth_quote')).toHaveLength(1);
    const second = (w.sim.landed.filter((l) => l.name === 'refresh_offers')[2]!.args['eth'] as { quoteId: bigint; tierPrice: bigint[] }[])[0]!;
    expect(second.quoteId).toBe(ethRefresh.quoteId);
    expect(second.tierPrice[0]).toBe(54_400_000_000_000_000n);
    expect(d.offers.views().find((v) => v.market === 'eth' && v.direction === 'sell_xmr')).toMatchObject({ live: true, key_pool: { size: 4, available: 4 }, seq_or_quote_id: ethRefresh.quoteId.toString() });
    d.store.close();
  });
});
const eth_now = (d: Daemon): bigint => 1_800_000_000n + 100n * 12n + 0n * BigInt(d.startedAt);

describe('key pool generation stays off the hot path', () => {
  it('a large pool is generated in the background, one proof per turn: swap passes and timers stay prompt, and a restart resumes it', async () => {
    const w = await makeWorld(ETH_TOML.replace('eth_pool_size = 4', 'eth_pool_size = 32'));
    const eth = new FakeEthereum(CONTRACT);
    eth.views['getMaker'] = () => ({ operator: w.keystore.ethereum.address, payout: '0x00000000000000000000000000000000000000bb', quoteEpoch: 3, approvalEpoch: 2, paused: false, registeredAt: 5n, solanaOwner: zero32, solanaOwnerNext: zero32, solanaOwnerNextAt: 0n, openPending: 0, responseSecsSum: 0n, counters: new Array(40).fill(0) });
    eth.views['usdc'] = () => USDC;
    let d = await w.boot({ ethTransport: eth });
    const t0 = Date.now();
    await d.start(); // returns without waiting for 32 proofs
    const startMs = Date.now() - t0;
    expect(d.offers.poolProgress()).toEqual([{ token: `0x${'00'.repeat(20)}`, built: expect.any(Number) }]);
    // A Solana swap arrives while the pool is being generated: its passes run between proofs.
    const s = w.sim.open({ direction: 0, xmr: XMR, makerSpendPub: w.sim.takePoolKey(0) });
    const passes: number[] = [];
    let worstGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      worstGap = Math.max(worstGap, Date.now() - last);
      last = Date.now();
    }, 10);
    let built = 0;
    while (d.offers.poolProgress().length > 0 && built < 12) {
      const t = Date.now();
      await d.executor.tick();
      passes.push(Date.now() - t);
      built = d.offers.poolProgress()[0]?.built ?? 32;
      // The daemon's passes are timer-driven and do real I/O; the fakes answer without ever leaving the microtask queue.
      await new Promise((r) => setTimeout(r, 5));
    }
    clearInterval(timer);
    expect(passes.length).toBeGreaterThan(3); // many passes completed DURING the refill
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.NOTICED); // and did real work: lock built, notice posted, XMR relayed
    // No pass and no timer ever waited for more than a few proofs; the whole pool is seconds of CPU.
    const perProof = (Date.now() - t0) / Math.max(1, built);
    expect(Math.max(...passes)).toBeLessThan(Math.max(1500, perProof * 6));
    expect(worstGap).toBeLessThan(Math.max(1500, perProof * 4));
    expect(startMs).toBeLessThan(Math.max(1500, perProof * 6));
    // Restart mid-refill: the proofs already made are kept, the rest are generated, and the pool has exactly 32 leaves.
    const before = d.store.shares({ purpose: `ethpool:0x${'00'.repeat(20)}` }).length;
    expect(before).toBeLessThan(32);
    await d.stop(); // halts the generation; what was made is on disk
    const kept = d.offers.poolProgress().length;
    expect(kept).toBe(0);
    d = await w.boot({ ethTransport: eth });
    // (One more proof may have been finished while the daemon was stopping.)
    const resumedFrom = d.store.shares({ purpose: `ethpool:0x${'00'.repeat(20)}` }).length;
    expect(resumedFrom).toBeGreaterThanOrEqual(before);
    expect(resumedFrom).toBeLessThan(32);
    await d.start();
    await d.offers.poolsReady();
    await d.offers.tick(true);
    const pool = d.store.currentPool<{ spend_pub: string }[]>(`0x${'00'.repeat(20)}`)!;
    expect(pool.leaves).toHaveLength(32);
    expect(new Set(pool.leaves.map((l) => l.spend_pub)).size).toBe(32);
    expect(d.store.shares({ purpose: `ethpool:0x${'00'.repeat(20)}` })).toHaveLength(32);
    expect(w.sim.landed.filter((l) => l.name === 'set_eth_quote')).toHaveLength(1);
    d.store.close();
  }, 120_000);
});

describe('the Ethereum operator nonce', () => {
  it('two sends at once never sign the same nonce', async () => {
    const { d, eth } = await boot();
    // A node that answers the nonce slowly and counts what it was sent: unserialised, both sends would read nonce 0.
    const real = eth.request.bind(eth);
    eth.request = async (a) => {
      if (a.method === 'eth_getTransactionCount') {
        await new Promise((r) => setTimeout(r, 20));
        return `0x${eth.sentRaw.length.toString(16)}`;
      }
      return real(a);
    };
    eth.views['bumpEpochs'] = () => undefined;
    const call = () => d.eth!.client.contract.bumpEpochs(false, true);
    await Promise.all([d.eth!.sendCall(call(), () => {}), d.eth!.sendCall(call(), () => {}), d.eth!.sendCall(call(), () => {})]);
    expect(eth.sentRaw.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 1, 2]);
    d.store.close();
  });
});

describe('Ethereum message fallback', () => {
  it('reads messages posted through the contract, once, and only when final', async () => {
    const { w, d, eth } = await boot();
    const { contactKeys, sealToMaker } = await import('@xmrswap/sdk');
    const contact = contactKeys(new Uint8Array(32).fill(42), w.sim.makerPda);
    const envelope = sealToMaker({ message: { t: 'inbox', text: 'via Ethereum' }, ownEncSecret: contact.encSecret, maker: w.sim.maker(), transport: 'ethereum' });
    eth.emit('Message', { from: TAKER, to: OWNER, swapId: zero32, payload: hex0x(envelope) }, 95n);
    expect(await d.inbox.pollEthereum()).toBe(0); // block 95 is not final yet
    eth.finalized = 95n;
    expect(await d.inbox.pollEthereum()).toBe(1);
    expect(d.inbox.items()[0]).toMatchObject({ transport: 'ethereum', text: 'via Ethereum', peer: TAKER });
    expect(await d.inbox.pollEthereum()).toBe(0);
    d.store.close();
  });
});

describe('finality on Ethereum', () => {
  /** A direction-A lock against a pool leaf, as the contract would store it. */
  function lock(d: Daemon, eth: FakeEthereum, nonceByte: number, withProof: boolean): { id: string; keys: DerivedKeys; pending: EthSwapStruct; model: ModelSwap } {
    const nonce = new Uint8Array(16).fill(nonceByte);
    const keys = takerSwapKeys(new Uint8Array(32).fill(42), 'ethereum', nonce);
    const twin = twinCommitments(keys.spend);
    const id = hex0x(ethSwapId(Buffer.from(TAKER.slice(2), 'hex'), nonce));
    const leaves = d.offers.poolLeaves(d.store.currentPool<unknown>(`0x${'00'.repeat(20)}`)!.root)!;
    const leaf = leaves[nonceByte % leaves.length]!;
    const tLock = eth.block(eth.latest).timestamp;
    const amount = 102_000_000_000_000_000n;
    const fx = apply('ethereum', NO_SWAP, { name: 'lock', args: { offerMode: 0, approval: false, amount, wA: 120, wN: 1800, dC: 10_800, wC: 5400, wF: 604_800, depth: 2, depBps: 0 } }, 'taker', tLock);
    const leafHash = keyLeaf(leaf.index, Buffer.from(leaf.key.slice(2), 'hex'), Buffer.from(leaf.key2.slice(2), 'hex'), Buffer.from(leaf.spend_pub, 'hex'));
    const makerEncKey = x25519Public(ENC_SECRET_V1);
    const openHash = openHashEthereum({ swapId: Buffer.from(id.slice(2), 'hex'), tLock, direction: 0, token: new Uint8Array(20), xmr: 2n * XMR, amount, deposit: 0n, takerSpendPub: keys.spendPub, takerKey: twin.keyAddr, takerKey2: twin.keyAddr2, takerView: keys.view, takerEncKey: keys.encPub, makerEncKey, keyLeaf: leafHash });
    const pending = structOf(fx.swap, {
      taker: TAKER, maker: OWNER, token: `0x${'00'.repeat(20)}`, sessionKey: '0x00000000000000000000000000000000000000aa', swapNonce: hex0x(nonce), depBps: 0, makerEncVersion: 1, xmr: 2n * XMR, price: 51_000_000_000_000_000n,
      takerKey: hex0x(twin.keyAddr), takerKey2: hex0x(twin.keyAddr2), takerSpendPub: hex0x(keys.spendPub), makerKey: leaf.key, makerKey2: leaf.key2, makerSpendPub: `0x${leaf.spend_pub}`, lockerView: hex0x(keys.view), takerEncKey: hex0x(keys.encPub), makerEncKey: hex0x(makerEncKey),
      noticeCommitment: zero32, noticeCiphertext: `0x${'00'.repeat(104)}`, evidenceTxid: zero32, evidenceView: zero32, keyLeaf: hex0x(leafHash), openHash: hex0x(openHash), revealed: 0n,
    });
    if (withProof) d.store.putBlob(Buffer.from(keys.spendPub).toString('hex'), dleqProve(keys.spend), false);
    return { id: id.toLowerCase(), keys, pending, model: fx.swap };
  }
  function structOf(m: ModelSwap, rest: Record<string, unknown>): EthSwapStruct {
    return { ...rest, state: m.state, direction: m.direction, mode: m.mode, outcome: m.outcome, depositState: m.depositState, depth: m.depth, flags: m.flags, amount: m.amount, deposit: m.deposit, noticeWindow: m.wN, claimDelay: m.dC, claimWindow: m.wC, tLock: m.tLock, tPendingDeadline: m.tPendingDeadline, tActive: m.tActive, tNoteDeadline: m.tNoteDeadline, tNotice: m.tNotice, tCut: m.tCut, tClaimOpen: m.tClaimOpen, tReady: m.tReady, tClaimDeadline: m.tClaimDeadline, tFinal: m.tFinal, tRefund: m.tRefund, tSettled: m.tSettled } as unknown as EthSwapStruct;
  }
  const emitLocked = (eth: FakeEthereum, id: string, block: bigint) => {
    const ev = (IXmrSwapAbi as unknown as { type: string; name?: string; inputs: { name: string; type: string; components?: { name: string; type: string }[] }[] }[]).find((e) => e.type === 'event' && e.name === 'Locked')!;
    const zero = (t: string): unknown => (t === 'address' ? `0x${'00'.repeat(20)}` : t.startsWith('bytes') ? `0x${'00'.repeat(Number(t.slice(5)))}` : t.startsWith('uint') ? 0n : 0);
    const args: Record<string, unknown> = {};
    for (const i of ev.inputs) args[i.name] = i.components ? Object.fromEntries(i.components.map((c) => [c.name, /^uint(8|16|32)$/.test(c.type) ? 0 : zero(c.type)])) : /^uint(8|16|32)$/.test(i.type) ? 0 : zero(i.type);
    eth.emit('Locked', { ...args, swapId: id, maker: OWNER, taker: TAKER }, block);
  };

  it('acts only on finalized state: no approval, no XMR and no claim on a state that is merely mined', async () => {
    const { w, d, eth, swaps } = await boot();
    const a = lock(d, eth, 1, true);
    swaps.set(a.id, { latest: a.pending, final: null });
    emitLocked(eth, a.id, 99n);
    // The lock is mined (block 99) but `finalized` is still block 90: the daemon does not even see it.
    await d.executor.tick();
    expect(d.store.swap(a.id)).toBeUndefined();
    expect(eth.sentRaw).toHaveLength(0);

    // Finality passes the lock: the proof verifies, the rules approve, bound to the lock that was examined.
    eth.finalized = 99n;
    swaps.get(a.id)!.final = a.pending;
    await d.executor.tick();
    let calls = sentCalls(eth);
    expect(calls.map((c) => c.functionName)).toEqual(['approve']);
    expect(calls[0]!.args).toEqual([a.id, a.pending.openHash]);
    expect(d.store.swap(a.id)!.facts).toMatchObject({ takerProofOk: true, approval: { approve: true } });
    expect(d.store.shareByPub(a.pending.makerSpendPub.slice(2))).toMatchObject({ status: 'bound', swap_ref: a.id });

    // The approval is mined in block 101, not final: nothing is re-sent and NO XMR is built or sent.
    eth.latest = 101n;
    const approved = apply('ethereum', a.model, { name: 'approve', openOk: true }, 'operator', eth.block(101n).timestamp).swap;
    const active = { ...a.pending, ...structOfPatch(approved) };
    swaps.get(a.id)!.latest = active;
    landed(eth, calls[0]!.hash, 101n);
    for (let i = 0; i < 3; i++) expect((await d.executor.tick()).get(a.id)).toMatchObject({ kind: 'waiting', on: 'transaction approve' });
    expect(eth.sentRaw).toHaveLength(1);
    expect(w.xmr.txs.size).toBe(0);

    // Final: the swap is re-read at `finalized`, its commitments are the verified ones, the lock is built (not relayed) and the notice posted.
    eth.latest = 170n;
    eth.finalized = 101n;
    swaps.get(a.id)!.final = active;
    await d.executor.tick();
    calls = sentCalls(eth);
    expect(calls.map((c) => c.functionName)).toEqual(['approve', 'postNotice']);
    expect(w.xmr.txs.size).toBe(1);
    expect(w.xmr.relays).toEqual([]);

    // The notice is mined but not final: the XMR stays unrelayed.
    const tNotice = eth.block(171n).timestamp;
    const noticedModel = apply('ethereum', approved, { name: 'post_notice' }, 'operator', tNotice).swap;
    const [, commitment, ciphertext] = calls[1]!.args as [string, string, string];
    const noticed = { ...active, ...structOfPatch(noticedModel), noticeCommitment: commitment, noticeCiphertext: ciphertext };
    eth.latest = 171n;
    swaps.get(a.id)!.latest = noticed;
    landed(eth, calls[1]!.hash, 171n);
    await d.executor.tick();
    await d.executor.tick();
    expect(w.xmr.relays).toEqual([]);
    // Only once NOTICED is final does the XMR leave.
    eth.latest = 240n;
    eth.finalized = 171n;
    swaps.get(a.id)!.final = noticed;
    await d.executor.tick();
    expect(w.xmr.relaysOf('wallet')).toHaveLength(1);
    expect(w.log.filter((l) => l.startsWith('xmr:'))).toEqual(['xmr:relay:wallet']);

    // Ready is mined but not final: no claim. Final: the claim goes out, once.
    w.xmr.mine(2);
    const readyModel = apply('ethereum', noticedModel, { name: 'set_ready' }, 'session', eth.block(241n).timestamp).swap;
    const ready = { ...noticed, ...structOfPatch(readyModel) };
    eth.latest = 241n;
    swaps.get(a.id)!.latest = ready;
    await d.executor.tick();
    expect(sentCalls(eth).map((c) => c.functionName)).toEqual(['approve', 'postNotice']);
    eth.latest = 310n;
    eth.finalized = 241n;
    swaps.get(a.id)!.final = ready;
    await d.executor.tick();
    calls = sentCalls(eth);
    expect(calls.map((c) => c.functionName)).toEqual(['approve', 'postNotice', 'claim']);
    // The revealed integer is this maker's share for that leaf.
    const share = d.shares.forSwap(a.id)!;
    expect(calls[2]!.args![1]).toBe(BigInt(`0x${Buffer.from(share.keys.spend).reverse().toString('hex')}`));
    await d.executor.tick();
    expect(eth.sentRaw).toHaveLength(3);
    d.store.close();

    function structOfPatch(m: ModelSwap): Partial<EthSwapStruct> {
      return structOf(m, {}) as Partial<EthSwapStruct>;
    }
  });

  it('rejects at once with reason 1 when the taker uploaded no valid proof, and with reason 2 when another swap took the leaf', async () => {
    const { d, eth, swaps } = await boot();
    const noProof = lock(d, eth, 2, false);
    swaps.set(noProof.id, { latest: noProof.pending, final: noProof.pending });
    emitLocked(eth, noProof.id, 99n);
    eth.finalized = 99n;
    await d.executor.tick();
    let calls = sentCalls(eth);
    expect(calls.map((c) => [c.functionName, (c.args as unknown[])[2]])).toEqual([['reject', 1]]);
    expect(d.store.swap(noProof.id)!.facts.takerProofOk).toBe(false);
    // Two takers name the same leaf: the first is approved, the second rejected with reason 2 (a no-fault rejection).
    const first = lock(d, eth, 3, true);
    const second = lock(d, eth, 7, true); // 7 % 4 === 3: the same leaf
    expect(second.pending.makerSpendPub).toBe(first.pending.makerSpendPub);
    swaps.set(first.id, { latest: first.pending, final: first.pending });
    emitLocked(eth, first.id, 100n);
    eth.finalized = 100n;
    await d.executor.tick();
    swaps.set(second.id, { latest: second.pending, final: second.pending });
    emitLocked(eth, second.id, 100n);
    (d.eth as unknown as { known: Set<string> }).known.delete(second.id);
    d.store.setMeta('eth_cursor', '100');
    await d.executor.tick();
    calls = sentCalls(eth);
    expect(calls.filter((c) => (c.args as unknown[])[0] === first.id).map((c) => c.functionName)).toEqual(['approve']);
    expect(calls.filter((c) => (c.args as unknown[])[0] === second.id).map((c) => [c.functionName, (c.args as unknown[])[2]])).toEqual([['reject', 2]]);
    d.store.close();
  });
});
