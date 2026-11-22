// The registry reader and the merged cross-chain reputation (SPEC 3.7, 5.6): mutual-pointer link
// rules, delayed changes, history kept after an unlink, the derived figures, and the board
// quotes of an unlinked maker being discarded.
import { beforeAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { init } from '@xmrswap/core-wasm';
import { ACCOUNT_SIZE, type Address, CHAIN_CONSTS, COUNTER, DEV_PROGRAM_ID, type EthBoard, type Maker, type Offer, base58Encode, encodeAccount } from '@xmrswap/protocol';
import { EthereumClient } from '../src/ethereum/client.js';
import { listMakerProfiles, listOffers, verifiedBoardQuotes } from '../src/registry/reader.js';
import { LinkMemory, effectiveEthLink, effectiveSolanaLink, linkStatus, mergeCounters, mergedReputation, reputationOf } from '../src/registry/reputation.js';
import { encodeSignedQuote, quoteFromMessage } from '../src/signing/eip712.js';
import { offerTermsHash } from '../src/signing/solana.js';
import { SolanaClient } from '../src/solana/client.js';
import { ethBoardPda, makerPda, offerPda } from '../src/solana/pdas.js';
import { FakeEthereum } from '../src/testing/ethereum.js';
import { FakeSolana } from '../src/testing/solana.js';
import { unhex } from '../src/util.js';
import { vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const DELAY = BigInt(CHAIN_CONSTS.solana.linkDelaySecs);
const z = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
const OWNER = base58Encode(z(32, 7));
const OWNER_HEX = `0x${'07'.repeat(32)}`;
const ETH = '0x0fbfe9b14731dddd51b145d6b23104e8bf7f676b';
const OTHER_ETH = '0x00000000000000000000000000000000000000aa';
const ZERO32 = `0x${'00'.repeat(32)}`;
const counters = (set: Record<string, number> = {}) => {
  const c = new Array<number>(40).fill(0);
  for (const [k, n] of Object.entries(set)) c[COUNTER[k as keyof typeof COUNTER]] = n;
  return c;
};
const sol = (over: Record<string, unknown> = {}) => ({ owner: OWNER, ethLink: unhex(ETH), ethLinkNext: z(20), ethLinkNextAt: 0n, counters: counters(), responseSecsSum: 0n, ...over });
const eth = (over: Record<string, unknown> = {}) => ({ address: ETH, solanaOwner: OWNER_HEX, solanaOwnerNext: ZERO32, solanaOwnerNextAt: 0n, counters: counters(), responseSecsSum: 0n, ...over });
const T = 1_800_000_000n;

describe('identity link (mutual pointers)', () => {
  it('two records are one identity only when both pointers are in effect and point at each other', () => {
    expect(linkStatus(sol(), eth(), T, T)).toEqual({ status: 'mutual', pendingChange: false });
    // One-sided: Solana points at an Ethereum record that points nowhere, or elsewhere.
    expect(linkStatus(sol(), eth({ solanaOwner: ZERO32 }), T, T).status).toBe('one-sided');
    expect(linkStatus(sol(), eth({ solanaOwner: `0x${'08'.repeat(32)}` }), T, T).status).toBe('one-sided');
    // One-sided the other way: the Ethereum record claims a Solana owner that does not point back.
    expect(linkStatus(sol({ ethLink: z(20) }), eth(), T, T).status).toBe('one-sided');
    expect(linkStatus(sol({ ethLink: unhex(OTHER_ETH) }), eth(), T, T).status).toBe('one-sided');
    // No Ethereum record at the address at all.
    expect(linkStatus(sol(), null, T, T).status).toBe('one-sided');
    expect(linkStatus(sol({ ethLink: z(20) }), null, T, T).status).toBe('none');
    expect(linkStatus(sol({ ethLink: z(20) }), eth({ solanaOwner: ZERO32 }), T, T).status).toBe('none');
  });

  it('a change takes effect only after the delay, on each chain\'s own clock', () => {
    const changing = sol({ ethLinkNext: unhex(OTHER_ETH), ethLinkNextAt: T + DELAY });
    expect(Buffer.from(effectiveEthLink(changing, T + DELAY - 1n)!).toString('hex')).toBe(ETH.slice(2));
    expect(Buffer.from(effectiveEthLink(changing, T + DELAY)!).toString('hex')).toBe(OTHER_ETH.slice(2));
    // Until then the old link is in effect and shown as about to change.
    expect(linkStatus(changing, eth(), T + DELAY - 1n, T)).toEqual({ status: 'mutual', pendingChange: true });
    expect(linkStatus(changing, eth(), T + DELAY, T)).toEqual({ status: 'one-sided', pendingChange: false });
    // An unlink is a pending change to zeros.
    const unlinking = sol({ ethLinkNext: z(20), ethLinkNextAt: T + DELAY });
    expect(effectiveEthLink(unlinking, T + DELAY)).toBe(null);
    expect(linkStatus(unlinking, eth(), T + DELAY, T).status).toBe('one-sided');
    // The Ethereum side has the same rule with its own time.
    const ethChanging = eth({ solanaOwnerNext: `0x${'09'.repeat(32)}`, solanaOwnerNextAt: T + DELAY });
    expect(effectiveSolanaLink(ethChanging, T + DELAY - 1n)![0]).toBe(7);
    expect(effectiveSolanaLink(ethChanging, T + DELAY)![0]).toBe(9);
    expect(linkStatus(sol(), ethChanging, T + DELAY + 5n, T + DELAY - 1n).status).toBe('mutual');
    expect(linkStatus(sol(), ethChanging, T, T + DELAY).status).toBe('one-sided');
    // A new link pending on both sides is not in effect on either.
    const fresh = linkStatus(sol({ ethLink: z(20), ethLinkNext: unhex(ETH), ethLinkNextAt: T + DELAY }), eth({ solanaOwner: ZERO32, solanaOwnerNext: OWNER_HEX, solanaOwnerNextAt: T + DELAY }), T, T);
    expect(fresh).toEqual({ status: 'none', pendingChange: true });
    expect(DELAY).toBe(604_800n);
  });
});

describe('merged reputation', () => {
  const solRecord = sol({ counters: counters({ approvals: 90, rejections: 6, approval_timeouts: 4, rejections_no_fault: 50, completed: 80, missed_notices: 1, withholds: 4, deposits_returned: 12, releases: 1 }), responseSecsSum: 900n });
  const ethRecord = eth({ counters: counters({ approvals: 10, rejections: 0, approval_timeouts: 0, completed: 20, missed_claims: 3, missed_funds: 0, withholds: 6, deposits_returned: 8, releases: 2, splits: 1 }), responseSecsSum: 1100n });

  it('derives the figures of SPEC 3.7 from one record', () => {
    const r = reputationOf(solRecord);
    expect(r.approvalRate).toBeCloseTo(0.9, 10);
    expect(r.meanResponseSecs).toBe(10);
    expect(r.withholdRate).toBe(0.25);
    expect(r.unreleasedRate).toBe(0.75);
    expect(r.faults).toEqual({ missedNotices: 1, missedClaims: 0, missedFunds: 0, total: 1 });
    // Absolute counts and relative to `completed`, the only counter that costs the fee.
    expect(r.unreleased).toBe(3);
    expect(r.completed).toBe(80);
    expect(r.perCompleted).toEqual({ faults: 1 / 80, withholds: 4 / 80, unreleased: 3 / 80 });
    // No-fault rejections are left out of the approval rate and shown beside it.
    expect(r.rejectionsNoFault).toBe(50);
    expect(r.counts.rejections).toBe(6);
  });

  it('a maker with no history has no rates, not perfect ones', () => {
    const r = reputationOf({ counters: counters(), responseSecsSum: 0n });
    expect([r.approvalRate, r.meanResponseSecs, r.withholdRate, r.unreleasedRate]).toEqual([null, null, null, null]);
    expect(r.perCompleted).toEqual({ faults: null, withholds: null, unreleased: null });
    // Self-trading inflates approvals at no fee: the ratio looks perfect, the absolute counts do not move.
    const padded = reputationOf({ counters: counters({ approvals: 10_000, deposits_returned: 10_000, missed_notices: 5, completed: 2 }), responseSecsSum: 0n });
    expect(padded.approvalRate).toBe(1);
    expect(padded.faults.total).toBe(5);
    expect(padded.perCompleted.faults).toBe(2.5);
  });

  it('merges the two records of a mutually linked maker', () => {
    const merged = mergedReputation(solRecord, ethRecord, { solana: T, ethereum: T });
    expect(merged).toMatchObject({ merged: true, historical: false, link: { status: 'mutual' } });
    expect(merged.reputation.counts.completed).toBe(100);
    expect(merged.reputation.faults).toEqual({ missedNotices: 1, missedClaims: 3, missedFunds: 0, total: 4 });
    expect(merged.reputation.approvalRate).toBeCloseTo(100 / 110, 10);
    expect(merged.reputation.meanResponseSecs).toBe(20);
    expect(merged.reputation.withholdRate).toBe(10 / 30);
    expect(merged.reputation.unreleased).toBe(7);
    expect(mergeCounters([solRecord, ethRecord]).counters[COUNTER.splits]).toBe(1);
  });

  it('a one-sided pointer merges nothing: a maker cannot borrow a stranger\'s history', () => {
    // Solana record points at a well-regarded Ethereum maker that does not point back.
    const borrowed = mergedReputation(solRecord, eth({ ...ethRecord, solanaOwner: `0x${'08'.repeat(32)}` }), { solana: T, ethereum: T });
    expect(borrowed).toMatchObject({ merged: false, link: { status: 'one-sided' } });
    expect(borrowed.reputation.counts.completed).toBe(80);
    expect(borrowed.reputation.faults.total).toBe(1);
    expect(mergedReputation(solRecord, null, { solana: T, ethereum: T }).merged).toBe(false);
  });

  it('history stays attached to both keys after an unlink: a bad record cannot be shed', () => {
    const memory = new LinkMemory();
    expect(mergedReputation(solRecord, ethRecord, { solana: T, ethereum: T }, memory).merged).toBe(true);
    expect(memory.has(OWNER, ETH)).toBe(true);
    // The maker unlinks to drop the three missed claims on its Ethereum record. After the delay…
    const unlinked = { ...solRecord, ethLinkNext: z(20), ethLinkNextAt: T + DELAY };
    const later = mergedReputation(unlinked, ethRecord, { solana: T + DELAY, ethereum: T + DELAY }, memory);
    expect(later).toMatchObject({ merged: true, historical: true, link: { status: 'one-sided' } });
    expect(later.reputation.faults.total).toBe(4);
    // …a reader with no memory of the link sees only the Solana record.
    expect(mergedReputation(unlinked, ethRecord, { solana: T + DELAY, ethereum: T + DELAY }).reputation.faults.total).toBe(1);
    // The memory survives a reload and ignores junk.
    const restored = LinkMemory.from([...memory.toJSON(), 'garbage', 'a|b']);
    expect(restored.has(OWNER, ETH.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(restored.ethereumOf(OWNER)).toEqual([ETH]);
    expect(restored.toJSON().length).toBe(1);
    // It never links two keys that were only ever one-sided.
    const m2 = new LinkMemory();
    mergedReputation(solRecord, eth({ solanaOwner: ZERO32 }), { solana: T, ethereum: T }, m2);
    expect(m2.toJSON()).toEqual([]);
  });
});

describe('registry reader over fake chains', () => {
  const v = vector('eip712');
  const PROGRAM = new PublicKey(DEV_PROGRAM_ID);
  const P = PROGRAM.toBase58();
  const CONTRACT = v.domain.verifyingContract as Address;
  const d = { chainId: BigInt(v.domain.chainId), contract: CONTRACT };
  const q = () => quoteFromMessage(v.cases[0].input.typed_data.message);
  const quoteMaker = v.cases[0].input.typed_data.message.maker as Address;

  function makerAccount(owner: PublicKey, over: Partial<Maker> = {}): Maker {
    return {
      owner: owner.toBase58(), operator: owner.toBase58(), payout: owner.toBase58(), encKey: z(32, 1), encKeyVersion: 1, prevEncKey: z(32), prevEncKeyExpiresAt: 0n, approvalEpoch: 0, quoteEpoch: 0, paused: 0, inboxPolicy: 0, openPending: 0,
      registeredSlot: 1n, registeredAt: 2n, ethLink: z(20), ethLinkNext: z(20), ethLinkNextAt: 0n, counters: counters({ completed: 5 }), responseSecsSum: 0n, volume: [0n, 0n], withheldVolume: [0n, 0n], bump: 255, onion: '', contacts: [], ...over,
    };
  }
  const ethMaker = (solanaOwner: PublicKey | null) => ({
    operator: v.operator, payout: v.operator, quoteEpoch: q().epoch, approvalEpoch: 0, paused: false, registeredAt: 1n, solanaOwner: solanaOwner ? `0x${Buffer.from(solanaOwner.toBytes()).toString('hex')}` : ZERO32,
    solanaOwnerNext: ZERO32, solanaOwnerNextAt: 0n, openPending: 0, responseSecsSum: 0n, counters: counters({ completed: 7, missed_claims: 2 }),
  });

  function setup() {
    const fs = new FakeSolana();
    const fe = new FakeEthereum(CONTRACT);
    const solana = new SolanaClient({ transport: fs, programId: PROGRAM });
    const ethereum = new EthereumClient({ transport: fe, contract: CONTRACT });
    const honest = new PublicKey(z(32, 21));
    const thief = new PublicKey(z(32, 22));
    const plain = new PublicKey(z(32, 23));
    // `honest` is mutually linked with the quote's maker; `thief` points at the same address one-sidedly.
    fs.setAccount(makerPda(PROGRAM, honest).toBase58(), P, encodeAccount('Maker', makerAccount(honest, { ethLink: unhex(quoteMaker), onion: `${'h'.repeat(56)}.onion`, contacts: [{ kind: 5, value: 'https://blobs.example' }, { kind: 5, value: 'http://insecure.example' }] }), ACCOUNT_SIZE.Maker));
    fs.setAccount(makerPda(PROGRAM, thief).toBase58(), P, encodeAccount('Maker', makerAccount(thief, { ethLink: unhex(quoteMaker) }), ACCOUNT_SIZE.Maker));
    fs.setAccount(makerPda(PROGRAM, plain).toBase58(), P, encodeAccount('Maker', makerAccount(plain, { paused: 1 }), ACCOUNT_SIZE.Maker));
    fe.views.getMaker = ([m]) => (String(m).toLowerCase() === quoteMaker ? ethMaker(honest) : { ...ethMaker(null), operator: '0x0000000000000000000000000000000000000000' });
    return { fs, fe, solana, ethereum, honest, thief, plain };
  }
  const board = (maker: PublicKey, slots: { quote: Uint8Array; sig: Uint8Array }[]): EthBoard => ({ maker: maker.toBase58(), bump: 1, slots: Array.from({ length: 4 }, (_, i) => (slots[i] ? { used: 1, updatedAt: 1n, quote: slots[i]!.quote, sig: slots[i]!.sig } : { used: 0, updatedAt: 0n, quote: z(251), sig: z(65) })) });

  it('lists makers with their link status, merged history and blob routes', async () => {
    const { solana, ethereum, honest, thief, plain } = setup();
    const profiles = await listMakerProfiles(solana, ethereum, { solana: T, ethereum: T });
    const of = (k: PublicKey) => profiles.find((p) => p.solana.owner === k.toBase58())!;
    expect(profiles.length).toBe(3);
    expect(of(honest).identity).toMatchObject({ merged: true, link: { status: 'mutual' } });
    expect(of(honest).identity.reputation.counts.completed).toBe(12);
    expect(of(honest).identity.reputation.faults.total).toBe(2);
    expect(of(honest).ethereum?.address).toBe(quoteMaker);
    expect(of(honest).onion).toBe(`${'h'.repeat(56)}.onion`);
    // Only an HTTPS blob endpoint counts.
    expect(of(honest).blobEndpoint).toBe('https://blobs.example');
    // The thief's pointer is one-sided: it gets none of the Ethereum record's history.
    expect(of(thief).identity).toMatchObject({ merged: false, link: { status: 'one-sided' } });
    expect(of(thief).identity.reputation.counts.completed).toBe(5);
    expect(of(plain).identity.link.status).toBe('none');
    expect(of(plain).ethereum).toBe(null);
    // Without an Ethereum endpoint nothing is merged and nothing breaks.
    const solOnly = await listMakerProfiles(solana, null, { solana: T, ethereum: T });
    expect(solOnly.every((p) => !p.identity.merged)).toBe(true);
  });

  it('shows a board quote only for the mutually linked maker and discards the rest', async () => {
    const { fs, solana, ethereum, honest, thief } = setup();
    const quote = q();
    const sig = unhex(v.cases[0].output.signature);
    const compact = encodeSignedQuote(quote, sig);
    const slot = { quote: compact.subarray(0, 251), sig };
    const tampered = { quote: compact.slice(0, 251), sig };
    tampered.quote[105]! ^= 1;
    for (const m of [honest, thief]) fs.setAccount(ethBoardPda(PROGRAM, makerPda(PROGRAM, m)).toBase58(), P, encodeAccount('EthBoard', board(makerPda(PROGRAM, m), [slot, tampered]), ACCOUNT_SIZE.EthBoard));
    const profiles = await listMakerProfiles(solana, ethereum, { solana: T, ethereum: T });
    const now = quote.validUntil - 60n;
    const honestQuotes = await verifiedBoardQuotes(solana, profiles.find((p) => p.solana.owner === honest.toBase58())!, d, now);
    expect(honestQuotes.quotes.map((x) => x.slot)).toEqual([0]);
    expect(honestQuotes.quotes[0]!.quote.quoteId).toBe(quote.quoteId);
    expect(honestQuotes.discarded).toEqual([{ slot: 1, reason: 'BadSigner' }]);
    // The same, genuinely signed quote on the thief's board is not shown: one maker cannot post another's quotes.
    const stolen = await verifiedBoardQuotes(solana, profiles.find((p) => p.solana.owner === thief.toBase58())!, d, now);
    expect(stolen.quotes).toEqual([]);
    expect(stolen.discarded).toEqual([{ slot: 0, reason: 'NotLinked' }, { slot: 1, reason: 'NotLinked' }]);
    // Expired by the time it is read.
    const late = await verifiedBoardQuotes(solana, profiles.find((p) => p.solana.owner === honest.toBase58())!, d, quote.validUntil + 1n);
    expect(late.quotes).toEqual([]);
    expect(late.discarded[0]).toEqual({ slot: 0, reason: 'Expired' });
  });

  it('lists a market\'s offers with what would stop a lock right now', async () => {
    const { fs, solana, ethereum, honest, plain } = setup();
    const X = 10n ** 12n;
    const offer = (maker: PublicKey, over: Partial<Offer> = {}): Offer => {
      const base = { maker: makerPda(PROGRAM, maker).toBase58(), asset: 0, direction: 0, enabled: 1, mode: 0, bump: 1, seq: 3n, updatedAt: T, validSecs: 60, minXmr: X / 10n, maxXmr: 10n * X, capacityXmr: 10n * X, priceAbove: [0n, 0n, 0n], prices: [150_000_000n, 0n, 0n], depthAbove: [0n, X, 0n], depths: Uint8Array.of(2, 10, 0), depBps: 100, wA: 60, wN: 600, dC: 5400, wC: 1800, wF: 604_800, termsHash: z(32), poolFilled: 0, poolUsed: 0, pool: Array.from({ length: 16 }, () => z(32)), reserved: z(34), ...over } as Offer;
      return { ...base, termsHash: offerTermsHash(base) };
    };
    const put = (o: Offer) => fs.setAccount(offerPda(PROGRAM, o.maker, o.asset, o.direction).toBase58(), P, encodeAccount('Offer', o, ACCOUNT_SIZE.Offer));
    put(offer(honest));
    put(offer(honest, { direction: 1 }));
    put(offer(plain));
    const profiles = await listMakerProfiles(solana, ethereum, { solana: T, ethereum: T });
    const live = await listOffers(solana, profiles, { asset: 0, direction: 0 }, T + 30n);
    expect(live.map((o) => [o.maker.solana.owner, o.problem]).sort()).toEqual([[honest.toBase58(), null], [plain.toBase58(), 'Paused']].sort());
    const stale = await listOffers(solana, profiles, { asset: 0, direction: 0 }, T + 61n);
    expect(stale.find((o) => o.maker.solana.owner === honest.toBase58())!.problem).toBe('OfferStale');
    expect((await listOffers(solana, profiles, { asset: 1, direction: 0 }, T)).length).toBe(0);
  });
});
