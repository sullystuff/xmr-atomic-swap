// The Ethereum client against the frozen ABI: calldata builders decoded back by viem, values,
// readers and error decoding over an injected EIP-1193 transport, events, the cursor watcher and
// the finality rule. Nothing here opens a socket.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ethSwapId, init, twinCommitments } from '@xmrswap/core-wasm';
import { type Address, ETH_ERROR_NAMES, ETH_SWAP_EVENT_NAMES, type Hex, IXmrSwapAbi } from '@xmrswap/protocol';
import { type Abi, decodeFunctionData, toFunctionSelector } from 'viem';
import { ContractError, EthereumClient, XmrSwapContract, contractErrorName, ethSessionBudget, secretToUint } from '../src/ethereum/client.js';
import type { EthSwapStruct } from '../src/machine/view.js';
import { quoteFromMessage, quoteMessage } from '../src/signing/eip712.js';
import { priceEthQuote } from '../src/registry/pricing.js';
import { FakeEthereum, FakeRevert } from '../src/testing/ethereum.js';
import { codeOf, hex, hex0x, unhex } from '../src/util.js';
import { repoRoot, rng, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const frozenAbi = JSON.parse(readFileSync(path.join(repoRoot, 'interfaces/ethereum/IXmrSwap.abi.json'), 'utf8')) as Abi;
const v = vector('eip712');
const CONTRACT = v.domain.verifyingContract as Address;
const contract = new XmrSwapContract(CONTRACT);
const r = rng(11);
const b32 = () => r.bytes(32);
const addr = () => hex0x(r.bytes(20)) as Address;
const swapId = b32();
const decode = (data: Hex) => decodeFunctionData({ abi: frozenAbi, data });

describe('calldata builders against the frozen ABI', () => {
  const q = () => quoteFromMessage(v.cases[0].input.typed_data.message);
  const usdcQ = () => quoteFromMessage(v.cases.find((c: any) => c.name === 'quote-bound-usdc-a').input.typed_data.message);
  const sig = unhex(v.cases[0].output.signature);
  const keys = () => {
    const s = unhex(vector('twin').cases[2].input.s);
    const t = twinCommitments(s);
    return { spendPub: b32(), key: hex0x(t.keyAddr) as Address, key2: hex0x(t.keyAddr2) as Address, viewShare: b32(), encKey: b32(), makerEncVersion: 3, makerEncKey: b32() };
  };

  it('every function of the interface has a builder that viem decodes back', () => {
    const calls: Record<string, { data: Hex; value: bigint }> = {
      registerMaker: contract.registerMaker(addr(), addr(), b32()),
      setOperator: contract.setOperator(addr()),
      setPayout: contract.setPayout(addr()),
      setSolanaLink: contract.setSolanaLink(b32()),
      setPaused: contract.setPaused(true),
      bumpEpochs: contract.bumpEpochs(true, false),
      cancelQuote: contract.cancelQuote(42n),
      revokeApproval: contract.revokeApproval(b32()),
      approve: contract.approve(swapId, b32()),
      reject: contract.reject(swapId, b32(), 1),
      cancelPending: contract.cancelPending(swapId),
      expirePending: contract.expirePending(swapId),
      postNotice: contract.postNotice(swapId, b32(), r.bytes(104)),
      setReady: contract.setReady(swapId),
      abort: contract.abort(swapId),
      refundUnnoticed: contract.refundUnnoticed(swapId),
      expireUnnoticed: contract.expireUnnoticed(swapId),
      refund: contract.refund(swapId, unhex(vector('twin').cases[0].input.s)),
      claim: contract.claim(swapId, unhex(vector('twin').cases[1].input.s)),
      releaseDeposit: contract.releaseDeposit(swapId),
      withhold: contract.withhold(swapId, { txid: b32(), view: b32() }),
      splitDeposit: contract.splitDeposit(swapId),
      publishEvidence: contract.publishEvidence(swapId, b32(), b32()),
      withdrawOwed: contract.withdrawOwed(addr(), addr()),
      postMessage: contract.postMessage(addr(), swapId, r.bytes(900)),
      fund: contract.fund({ swapId, expectedOpen: b32(), key: addr(), key2: addr(), spendPub: b32(), viewShare: b32(), amount: 5n, token: '0x0000000000000000000000000000000000000000' }),
      lock: contract.lock({ quote: q(), sig, xmr: 2n * 10n ** 12n, amount: 121n * 10n ** 15n, maxPay: 122n * 10n ** 15n, swapNonce: r.bytes(16), sessionKey: addr(), sessionBudget: 7n, takerKeys: keys(), leaf: { index: 3, key: addr(), key2: addr(), spendPub: b32(), proof: [b32(), b32()] } }),
      take: contract.take({ quote: { ...q(), direction: 1 }, sig, xmr: 10n ** 12n, deposit: 9n, minReceive: 1n, swapNonce: r.bytes(16), sessionKey: addr(), sessionBudget: 7n, takerKeys: keys() }),
    };
    for (const [name, call] of Object.entries(calls)) {
      const d = decode(call.data);
      expect(d.functionName, name).toBe(name);
      expect((call as { to?: string }).to, name).toBe(CONTRACT);
    }
    // Nothing state-changing in the interface is left without a builder (withdrawTreasury is the treasury's own).
    const writes = (frozenAbi as readonly { type: string; name?: string; stateMutability?: string }[]).filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure').map((f) => f.name!);
    expect(writes.filter((n) => !(n in calls)).sort()).toEqual(['withdrawTreasury']);
    expect(contract.encode('withdrawTreasury', [addr(), addr()]).data.slice(0, 10)).toBe(toFunctionSelector('withdrawTreasury(address,address)'));
    // The generated ABI the SDK uses is the frozen file.
    expect(JSON.parse(JSON.stringify(IXmrSwapAbi))).toEqual(frozenAbi);
  });

  it('lock: the quote, taker keys, leaf and value are exactly what was given', () => {
    const quote = q();
    const tk = keys();
    const nonce = r.bytes(16);
    const leaf = { index: 3, key: addr(), key2: addr(), spendPub: b32(), proof: [b32(), b32(), b32()] };
    const p = priceEthQuote(quote, 2n * 10n ** 12n);
    const call = contract.lock({ quote, sig, xmr: 2n * 10n ** 12n, amount: p.amount, maxPay: p.amount, swapNonce: nonce, sessionKey: '0x00000000000000000000000000000000000000aa', sessionBudget: 600n, takerKeys: tk, leaf });
    const a = decode(call.data).args as any[];
    // viem hands addresses back checksummed; compare in the canonical byte form.
    expect(quoteMessage(quoteFromMessage(a[0]))).toEqual(quoteMessage(quote));
    expect(a[1]).toBe(hex0x(sig));
    expect([a[2], a[3], a[4], a[6]]).toEqual([2n * 10n ** 12n, p.amount, hex0x(nonce), 600n]);
    expect(a[7]).toMatchObject({ spendPub: hex0x(tk.spendPub), viewShare: hex0x(tk.viewShare), encKey: hex0x(tk.encKey), makerEncVersion: 3, makerEncKey: hex0x(tk.makerEncKey) });
    expect((a[7].key as string).toLowerCase()).toBe(tk.key);
    expect(a[8]).toMatchObject({ index: 3, spendPub: hex0x(leaf.spendPub), proof: leaf.proof.map(hex0x) });
    // No approval presented: the empty approval and an empty signature.
    expect(BigInt(a[9].maker)).toBe(0n);
    expect(a[10]).toBe('0x');
    // ETH: msg.value == amount + sessionBudget.
    expect(call.value).toBe(p.amount + 600n);
    expect(codeOf(() => contract.lock({ quote, sig, xmr: 1n, amount: 2n, maxPay: 1n, swapNonce: nonce, sessionKey: addr(), sessionBudget: 0n, takerKeys: tk, leaf }))).toBe('PriceMoved');
    expect(codeOf(() => contract.lock({ quote, sig, xmr: 1n, amount: 1n, maxPay: 1n, swapNonce: r.bytes(15), sessionKey: addr(), sessionBudget: 0n, takerKeys: tk, leaf }))).toBe('BadNonce');
  });

  it('USDC: only the session budget travels as value; an approval is passed through', () => {
    const quote = usdcQ();
    const tk = keys();
    const approvalCase = v.cases.find((c: any) => c.name === 'approval-usdc-a');
    const approval = { approval: (await_approval(approvalCase)), sig: unhex(approvalCase.output.signature) };
    const leaf = { index: 0, key: addr(), key2: addr(), spendPub: b32(), proof: [b32()] };
    const call = contract.lock({ quote, sig, xmr: quote.minXmr, amount: 10n ** 9n, maxPay: 10n ** 9n, swapNonce: r.bytes(16), sessionKey: addr(), sessionBudget: 600n, takerKeys: tk, leaf, approval });
    expect(call.value).toBe(600n);
    const a = decode(call.data).args as any[];
    expect(a[9].approvalId).toBe(approvalCase.input.typed_data.message.approvalId);
    expect(a[10]).toBe(approvalCase.output.signature);
    const take = contract.take({ quote: { ...quote, direction: 1 }, sig, xmr: quote.minXmr, deposit: 77n, minReceive: 1n, swapNonce: r.bytes(16), sessionKey: addr(), sessionBudget: 600n, takerKeys: tk });
    expect(take.value).toBe(600n);
    expect(contract.take({ quote: { ...q(), direction: 1 }, sig, xmr: 10n ** 12n, deposit: 77n, minReceive: 1n, swapNonce: r.bytes(16), sessionKey: addr(), sessionBudget: 600n, takerKeys: tk }).value).toBe(677n);
    // fund: ETH carries the amount, USDC carries nothing.
    const f = { swapId, expectedOpen: b32(), key: addr(), key2: addr(), spendPub: b32(), viewShare: b32(), amount: 5n };
    expect(contract.fund({ ...f, token: '0x0000000000000000000000000000000000000000' }).value).toBe(5n);
    expect(contract.fund({ ...f, token: addr() }).value).toBe(0n);
  });

  it('a secret goes on the wire as the uint256 the twin check takes', () => {
    for (const c of vector('twin').cases.filter((c: any) => c.valid)) {
      const call = contract.claim(swapId, unhex(c.input.s));
      const [id, secret] = decode(call.data).args as [Hex, bigint];
      expect(id).toBe(hex0x(swapId));
      expect(secret.toString(16).padStart(64, '0'), c.name).toBe(c.input.secret_uint256);
      expect(secretToUint(unhex(c.input.s))).toBe(secret);
      expect(call.value).toBe(0n);
    }
    expect(codeOf(() => contract.refund(swapId, r.bytes(31)))).toBe('BadLength');
  });

  it('withhold without evidence passes zeros; notices and messages keep their size rules', () => {
    const [, txid, view] = decode(contract.withhold(swapId, null).data).args as Hex[];
    expect(BigInt(txid!)).toBe(0n);
    expect(BigInt(view!)).toBe(0n);
    expect(codeOf(() => contract.postNotice(swapId, b32(), r.bytes(105)))).toBe('BadNotice');
    expect(codeOf(() => contract.postMessage(addr(), null, r.bytes(901)))).toBe('MessageTooLarge');
    expect(BigInt((decode(contract.postMessage(addr(), null, r.bytes(4)).data).args as Hex[])[1]!)).toBe(0n);
    expect(codeOf(() => contract.approve(r.bytes(31), b32()))).toBe('BadLength');
    expect(ethSessionBudget(30_000_000_000n)).toBe(30_000_000_000n * 150_000n * 4n);
  });

  it('swapId = keccak256(abi.encode(taker, bytes16 swapNonce))', () => {
    const c = v.cases.find((c: any) => c.name === 'swap-id');
    expect(hex0x(ethSwapId(unhex(c.input.taker), unhex(c.input.swap_nonce)))).toBe(c.output.swap_id);
  });
});

// The approval of a vector case, in the byte form the builders take.
import { approvalFromMessage } from '../src/signing/eip712.js';
function await_approval(c: any) {
  return approvalFromMessage(c.input.typed_data.message);
}

// ------------------------------------------------------------------ client over a fake transport

const zero32 = `0x${'00'.repeat(32)}` as Hex;
const zeroAddr = '0x0000000000000000000000000000000000000000' as Address;
function swapStruct(over: Partial<EthSwapStruct> = {}): EthSwapStruct {
  return {
    taker: '0x0f8183aefdf068dd8489b6edbf4e07965cf29246', maker: '0x0fbfe9b14731dddd51b145d6b23104e8bf7f676b', token: zeroAddr, sessionKey: '0x00000000000000000000000000000000000000aa', swapNonce: `0x${'12'.repeat(16)}`,
    state: 3, direction: 0, mode: 0, outcome: 255, depositState: 0, depth: 10, flags: 1, depBps: 100, makerEncVersion: 2,
    xmr: 2n * 10n ** 12n, amount: 121n * 10n ** 15n, deposit: 121n * 10n ** 13n, price: 605n * 10n ** 14n, noticeWindow: 1800, claimDelay: 10800, claimWindow: 5400,
    takerKey: '0x08f5cbc4564871f0ca60c9a36f99baadcbfea448', takerKey2: '0xa19f0f910d085afdfc10f9dd276097a093ddae40', takerSpendPub: `0x${'21'.repeat(32)}`,
    makerKey: '0x63fd156b26116a5a48ed7a292c96ce424c5f658b', makerKey2: '0x89c9348ff65ef528eac0648f8ed07c332f14cdaa', makerSpendPub: `0x${'22'.repeat(32)}`,
    lockerView: `0x${'23'.repeat(32)}`, takerEncKey: `0x${'24'.repeat(32)}`, makerEncKey: `0x${'25'.repeat(32)}`, noticeCommitment: `0x${'26'.repeat(32)}`, noticeCiphertext: `0x${'27'.repeat(104)}`,
    evidenceTxid: zero32, evidenceView: zero32, keyLeaf: `0x${'28'.repeat(32)}`, openHash: `0x${'29'.repeat(32)}`, revealed: 0n,
    tLock: 1_800_000_000n, tPendingDeadline: 1_800_000_120n, tActive: 1_800_000_020n, tNoteDeadline: 1_800_001_820n, tNotice: 1_800_000_120n, tCut: 1_800_004_020n, tClaimOpen: 1_800_010_920n, tReady: 0n, tClaimDeadline: 0n, tFinal: 1_800_604_800n, tRefund: 0n, tSettled: 0n,
    ...over,
  };
}
const makerRecord = (over: Record<string, unknown> = {}) => ({
  operator: '0x19e76488e19f8ea6a4d6d87c28ff9080352ea347', payout: '0x00000000000000000000000000000000000000bb', quoteEpoch: 3, approvalEpoch: 2, paused: false, registeredAt: 5n,
  solanaOwner: `0x${'31'.repeat(32)}`, solanaOwnerNext: zero32, solanaOwnerNextAt: 0n, openPending: 1, responseSecsSum: 40n, counters: Array.from({ length: 40 }, (_, i) => i), ...over,
});

describe('EthereumClient over a fake transport', () => {
  const setup = () => {
    const fake = new FakeEthereum(CONTRACT);
    const client = new EthereumClient({ transport: fake, contract: CONTRACT });
    return { fake, client };
  };

  it('checks the chain id and reads chain time from the block at the tag', async () => {
    const { fake, client } = setup();
    await client.verifyChainId(31337);
    await expect(client.verifyChainId(1)).rejects.toMatchObject({ code: 'WrongChain' });
    expect(await client.chainTime('finalized')).toBe(fake.block(90n).timestamp);
    expect(await client.chainTime('latest')).toBe(fake.block(100n).timestamp);
    expect(await client.blockNumber()).toBe(90n);
    await expect(client.chainTime(101n)).rejects.toMatchObject({ code: 'NoBlock' });
  });

  it('reads a swap at the finalized tag as a chain-neutral view; state 0 is "no such swap"', async () => {
    const { fake, client } = setup();
    fake.views.getSwap = ([id]) => (id === hex0x(swapId) ? swapStruct() : swapStruct({ state: 0 }));
    const s = await client.getSwap(swapId);
    expect(s).toMatchObject({ chain: 'ethereum', state: 3, direction: 0, amount: 121n * 10n ** 15n, wN: 1800, dC: 10800, wC: 5400, feeBps: 5, tClaimOpen: 1_800_010_920n, taker: '0x0f8183aefdf068dd8489b6edbf4e07965cf29246', asset: zeroAddr });
    expect(s!.noticeCt.length).toBe(104);
    expect(hex(s!.swapRef)).toBe(hex(swapId));
    expect(s!.eth).toMatchObject({ takerKey: '0x08f5cbc4564871f0ca60c9a36f99baadcbfea448' });
    expect(await client.getSwap(b32())).toBe(null);
    // State is read at `finalized` unless the caller says otherwise.
    const calls = fake.requests.filter((q) => q.method === 'eth_call');
    expect(calls.every((q) => q.params![1] === 'finalized')).toBe(true);
    await client.getSwap(swapId, 'latest');
    expect(fake.requests.at(-1)!.params![1]).toBe('latest');
  });

  it('reads parked payouts when asked', async () => {
    const { fake, client } = setup();
    fake.views.getSwap = () => swapStruct({ state: 9 });
    fake.views.getMaker = () => makerRecord();
    fake.views.owedOf = ([, account]) => (String(account).toLowerCase() === '0x0f8183aefdf068dd8489b6edbf4e07965cf29246' ? 5n : String(account).toLowerCase().endsWith('bb') ? 7n : 11n);
    const s = await client.getSwap(swapId, 'finalized', true);
    expect([s!.owedTaker, s!.owedMaker]).toEqual([5n, 18n]);
  });

  it('reads the registry: maker, counters, key use, cancellations, a taker\'s swaps', async () => {
    const { fake, client } = setup();
    fake.views.getMaker = ([m]) => (String(m).toLowerCase().endsWith('aa') ? makerRecord({ operator: zeroAddr }) : makerRecord());
    const m = await client.getMaker('0x0fbfe9b14731dddd51b145d6b23104e8bf7f676b');
    expect(m).toMatchObject({ operator: '0x19e76488e19f8ea6a4d6d87c28ff9080352ea347', quoteEpoch: 3, approvalEpoch: 2, paused: false, openPending: 1, responseSecsSum: 40n });
    expect(m!.counters[8]).toBe(8);
    expect(await client.getMaker('0x00000000000000000000000000000000000000aa')).toBe(null);
    fake.views.counters = () => Array.from({ length: 40 }, (_, i) => 2 * i);
    expect((await client.counters(addr()))[32]).toBe(64);
    fake.views.isKeyUsed = ([, k]) => String(k).toLowerCase().endsWith('01');
    expect(await client.isKeyUsed(addr(), '0x0000000000000000000000000000000000000001')).toBe(true);
    expect(await client.isKeyUsed(addr(), '0x0000000000000000000000000000000000000002')).toBe(false);
    fake.views.isQuoteCancelled = ([, id]) => id === 42n;
    expect(await client.isQuoteCancelled(addr(), 42n)).toBe(true);
    fake.views.isApprovalRevoked = () => false;
    expect(await client.isApprovalRevoked(addr(), b32())).toBe(false);
    fake.views.volumeOf = () => [9n, 1n];
    expect(await client.volumeOf(addr(), zeroAddr)).toEqual({ volume: 9n, withheldVolume: 1n });
    fake.views.usdc = () => '0xf9ab76450f884b429b2c128ac26fca8c2efdd5f5';
    expect(await client.usdc()).toBe('0xf9ab76450f884b429b2c128ac26fca8c2efdd5f5');
    // swapsOf pages until a short page: the resume path that needs no logs.
    const ids = Array.from({ length: 5 }, () => hex0x(b32()));
    fake.views.swapsOf = ([, from, count]) => ids.slice(Number(from), Number(from) + Number(count));
    expect(await client.swapsOf(addr(), 'finalized', 2n)).toEqual(ids);
  });

  it('decodes custom errors from a simulation; a secret that would revert is known before it is sent', async () => {
    const { fake, client } = setup();
    let refuse: string | null = 'TooLate';
    fake.views.refund = () => {
      if (refuse) throw new FakeRevert(refuse);
      return undefined;
    };
    const call = contract.refund(swapId, unhex(vector('twin').cases[0].input.s));
    const err = await client.simulate(call, addr()).catch((e) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect(err.code).toBe('TooLate');
    refuse = 'BadSecret';
    await expect(client.simulate(call, addr())).rejects.toMatchObject({ code: 'BadSecret' });
    refuse = null;
    await expect(client.simulate(call, addr())).resolves.toBeUndefined();
    // Simulation runs on `latest` (the state it would execute on) and names the sender.
    const last = fake.requests.at(-1)!;
    expect(last.params![1]).toBe('latest');
    expect((last.params![0] as { from: string }).from).toMatch(/^0x/);
    // Every custom error of the interface decodes by name.
    for (const name of ETH_ERROR_NAMES) {
      fake.views.getSwap = () => {
        throw new FakeRevert(name);
      };
      await expect(client.read('getSwap', [zero32])).rejects.toMatchObject({ code: name });
    }
    expect(contractErrorName('0x12345678')).toBe(null);
    expect(contractErrorName(undefined)).toBe(null);
  });

  it('decodes events, filters by swap and maker, and ignores other contracts', async () => {
    const { fake, client } = setup();
    const maker = '0x0fbfe9b14731dddd51b145d6b23104e8bf7f676b' as Address;
    const id = hex0x(swapId);
    fake.emit('Approved', { swapId: id, maker, counter: 2 }, 80n);
    fake.emit('NoticePosted', { swapId: id, maker, counter: 6, commitment: zero32, ciphertext: `0x${'27'.repeat(104)}`, late: false }, 81n);
    fake.emit('Claimed', { swapId: hex0x(b32()), maker: addr(), counter: 8, secret: 7n, paid: 100n, fee: 1n }, 82n);
    fake.emit('Refunded', { swapId: id, maker, counter: 21, secret: 5n, depositHeld: true }, 95n);
    fake.logs.push({ ...fake.logs[0]!, address: addr() });
    const all = await client.getEvents({ fromBlock: 0n, toBlock: 'latest' });
    expect(all.map((e) => e.name)).toEqual(['Approved', 'NoticePosted', 'Claimed', 'Refunded']);
    expect(all[3]).toMatchObject({ name: 'Refunded', args: { counter: 21, secret: 5n, depositHeld: true }, blockNumber: 95n });
    const mine = await client.getEvents({ fromBlock: 0n, toBlock: 'finalized' }, { swapId });
    expect(mine.map((e) => e.name)).toEqual(['Approved', 'NoticePosted']);
    expect((await client.getEvents({ fromBlock: 0n, toBlock: 'latest' }, { maker })).length).toBe(3);
    expect((await client.getEvents({ fromBlock: 82n, toBlock: 82n })).map((e) => e.name)).toEqual(['Claimed']);
    for (const name of ETH_SWAP_EVENT_NAMES) expect((frozenAbi as readonly { type: string; name?: string }[]).some((e) => e.type === 'event' && e.name === name), name).toBe(true);
  });

  it('follows events from a stored cursor up to the finalized block, in bounded ranges', async () => {
    const { fake, client } = setup();
    const maker = addr();
    for (const n of [10n, 40n, 89n, 90n, 91n, 99n]) fake.emit('ReadySet', { swapId: hex0x(b32()), maker, counter: 7 }, n);
    const seen: bigint[] = [];
    const w = client.watchEvents((e) => seen.push(e.blockNumber), { fromBlock: 20n, maxRange: 25n });
    await w.poll();
    // Nothing above `finalized` is reported: it could still be reorged away.
    expect(seen).toEqual([40n, 89n, 90n]);
    expect(w.cursor).toBe(91n);
    const ranges = fake.requests.filter((q) => q.method === 'eth_getLogs').map((q) => [BigInt((q.params![0] as any).fromBlock), BigInt((q.params![0] as any).toBlock)]);
    expect(ranges).toEqual([[20n, 44n], [45n, 69n], [70n, 90n]]);
    await w.poll();
    expect(seen.length).toBe(3);
    fake.finalized = 99n;
    await w.poll();
    expect(seen).toEqual([40n, 89n, 90n, 91n, 99n]);
    expect(w.cursor).toBe(100n);
  });

  it('reads the Message fallback transport', async () => {
    const { fake, client } = setup();
    const to = addr();
    fake.emit('Message', { from: addr(), to, swapId: zero32, payload: '0x585301' }, 50n);
    fake.emit('Message', { from: addr(), to: addr(), swapId: zero32, payload: '0x585302' }, 51n);
    const got = await client.listMessages(to, { fromBlock: 0n, toBlock: 'finalized' });
    expect(got.map((m) => hex(m.payload))).toEqual(['585301']);
  });

  it('"finalized" needs the block at or below the tag and a receipt hash that is still canonical', async () => {
    const { fake, client } = setup();
    const tx = `0x${'cd'.repeat(32)}` as Hex;
    expect(await client.isFinal(tx)).toBe(false);
    const receipt = (n: bigint) => ({ blockNumber: `0x${n.toString(16)}` as Hex, blockHash: fake.block(n).hash, status: '0x1' as Hex });
    fake.receipts.set(tx, receipt(95n));
    // Mined, but above the finalized tag.
    expect(await client.isFinal(tx)).toBe(false);
    fake.finalized = 95n;
    expect(await client.isFinal(tx)).toBe(true);
    // A reorg replaced that block: the receipt's hash is no longer canonical.
    fake.reorg(95n, `0x${'ee'.repeat(32)}`);
    expect(await client.isFinal(tx)).toBe(false);
    fake.receipts.set(tx, { ...receipt(94n), status: '0x0' });
    await expect(client.isFinal(tx)).rejects.toMatchObject({ code: 'TransactionReverted' });
  });
});
