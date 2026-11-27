// The beta caps (SPEC 11.1) and the payout address (SPEC 11.2) as a client handles them: read,
// checked before an open, respected by pricing and the router (which reports "cap reached"
// apart from a maker's own limit), and the address checks the Solana program cannot make.
import { beforeAll, describe, expect, it } from 'vitest';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { init } from '@xmrswap/core-wasm';
import { ACCOUNT_SIZE, type Address, type AssetCaps, type Config, DEV_PROGRAM_ID, type Offer, PROGRAM_HASH, capsHeadroom, encodeAccount } from '@xmrswap/protocol';
import { EthereumClient, XmrSwapContract } from '../src/ethereum/client.js';
import { ethereumCall, solanaInstruction } from '../src/flows/execute.js';
import { NO_SWAP } from '../src/machine/model.js';
import type { SwapView } from '../src/machine/view.js';
import { CAPS_OFF, CapReached, assertUnderCaps, capRoom, capsAfterOpen, largestUnderCaps, solanaCaps } from '../src/registry/caps.js';
import { priceEthQuote, priceOffer } from '../src/registry/pricing.js';
import { type RouterOffer, type RouterOrder, planRoute } from '../src/router/plan.js';
import { quoteFromMessage } from '../src/signing/eip712.js';
import { SolanaClient, programHashOf } from '../src/solana/client.js';
import { BPF_LOADER_UPGRADEABLE, XmrSwapProgram } from '../src/solana/instructions.js';
import { ata, configPda } from '../src/solana/pdas.js';
import { FakeEthereum } from '../src/testing/ethereum.js';
import { FakeSolana } from '../src/testing/solana.js';
import { codeOf, hex, hex0x } from '../src/util.js';
import { rng, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const r = rng(31);
const X = 10n ** 12n;
const SOL = 10n ** 9n;
const caps = (over: Partial<AssetCaps> = {}): AssetCaps => ({ on: true, maxSwap: 100n * SOL, maxOpen: 1000n * SOL, openValue: 0n, ...over });
const rawOffer = (over: object = {}): Offer => ({ direction: 0, asset: 0, minXmr: X / 10n, maxXmr: 1000n * X, capacityXmr: 1000n * X, priceAbove: [0n, 0n, 0n], prices: [150n * SOL / 100n, 0n, 0n], depthAbove: [0n, 0n, 0n], depths: Uint8Array.of(25, 0, 0), depBps: 100, ...over }) as unknown as Offer;

describe('caps: the check a client makes before an open', () => {
  it('exactly at a cap is allowed; one unit above is refused with the chain\'s own error', () => {
    const c = caps({ openValue: 900n * SOL });
    expect(() => assertUnderCaps(c, 0, 100n * SOL, SOL)).not.toThrow();
    expect(codeOf(() => assertUnderCaps(c, 0, 100n * SOL + 1n, SOL))).toBe('SwapCapExceeded');
    expect(codeOf(() => assertUnderCaps({ ...c, openValue: 900n * SOL + 1n }, 0, 100n * SOL, SOL))).toBe('OpenCapExceeded');
    // Direction B counts amount + deposit toward the open value; the per-swap cap is on the amount.
    expect(() => assertUnderCaps(c, 1, 99n * SOL, SOL)).not.toThrow();
    expect(codeOf(() => assertUnderCaps(c, 1, 99n * SOL, SOL + 1n))).toBe('OpenCapExceeded');
    expect(() => assertUnderCaps(c, 1, 100n * SOL, 0n)).not.toThrow();
    // The switch off: nothing is checked; the open value is still kept.
    expect(() => assertUnderCaps(CAPS_OFF, 0, 10n ** 30n, 0n)).not.toThrow();
    expect(capRoom(CAPS_OFF)).toBe(null);
    expect(capRoom(c)).toEqual({ maxSwap: 100n * SOL, headroom: 100n * SOL });
    // Caps lowered below the open value: headroom is zero, never negative.
    expect(capRoom(caps({ maxOpen: 5n, openValue: 9n }))).toEqual({ maxSwap: 100n * SOL, headroom: 0n });
    expect(capsAfterOpen(c, 1, 10n, 3n).openValue).toBe(900n * SOL + 13n);
    expect(capsAfterOpen(c, 0, 10n, 3n).openValue).toBe(900n * SOL + 10n);
    const e = new CapReached('OpenCapExceeded', c);
    expect(e).toMatchObject({ code: 'OpenCapExceeded', headroom: 100n * SOL, maxSwap: 100n * SOL });
    expect(e.message).toMatch(/^OpenCapExceeded: cap reached/);
  });

  it('reads the caps of each Solana asset from Config; a fresh deployment is fail-closed', () => {
    const cfg = { capsOn: 1, maxSwap: [5n, 6n], maxOpen: [50n, 60n], openValue: [1n, 2n] };
    expect(solanaCaps(cfg, 0)).toEqual({ on: true, maxSwap: 5n, maxOpen: 50n, openValue: 1n });
    expect(solanaCaps(cfg, 1)).toEqual({ on: true, maxSwap: 6n, maxOpen: 60n, openValue: 2n });
    expect(solanaCaps({ ...cfg, capsOn: 0 }, 1).on).toBe(false);
    expect(codeOf(() => solanaCaps(cfg, 2))).toBe('WrongAsset');
    const fresh = solanaCaps({ capsOn: 1, maxSwap: [0n, 0n], maxOpen: [0n, 0n], openValue: [0n, 0n] }, 0);
    expect(capsHeadroom(fresh)).toBe(0n);
    expect(codeOf(() => assertUnderCaps(fresh, 0, 1n, 0n))).toBe('SwapCapExceeded');
  });
});

describe('caps in pricing', () => {
  it('a quote over a cap is "cap reached"; over the maker\'s limit it is the maker\'s error', () => {
    const o = rawOffer({ capacityXmr: 80n * X });
    // 60 XMR at 1.5 = 90 SOL: under both caps.
    expect(priceOffer(o, 60n * X, caps()).amount).toBe(90n * SOL);
    // 70 XMR = 105 SOL: over the per-swap cap of 100.
    const perSwap = (() => {
      try {
        priceOffer(o, 70n * X, caps());
      } catch (e) {
        return e;
      }
    })();
    expect(perSwap).toBeInstanceOf(CapReached);
    expect(perSwap).toMatchObject({ code: 'SwapCapExceeded' });
    expect(codeOf(() => priceOffer(o, 60n * X, caps({ openValue: 911n * SOL })))).toBe('OpenCapExceeded');
    // The maker's own limits come first and keep their own names.
    expect(codeOf(() => priceOffer(o, 81n * X, caps()))).toBe('CapacityExceeded');
    expect(codeOf(() => priceOffer(o, 1001n * X, caps()))).toBe('AmountOutOfRange');
    // Without caps nothing changes.
    expect(priceOffer(o, 70n * X).amount).toBe(105n * SOL);
    // A sell counts the deposit too: 66 XMR = 99 SOL + 0.99 deposit against 99.98 of headroom.
    const sell = rawOffer({ direction: 1 });
    expect(priceOffer(sell, 66n * X, caps({ maxOpen: 99_990_000_000n })).deposit).toBe(990_000_000n);
    expect(codeOf(() => priceOffer(sell, 66n * X, caps({ maxOpen: 99_989_999_999n })))).toBe('OpenCapExceeded');
    const q = quoteFromMessage(vector('eip712').cases[0].input.typed_data.message);
    const p = priceEthQuote(q, 2n * X);
    expect(priceEthQuote(q, 2n * X, { on: true, maxSwap: p.amount, maxOpen: p.amount, openValue: 0n })).toEqual(p);
    expect(codeOf(() => priceEthQuote(q, 2n * X, { on: true, maxSwap: p.amount - 1n, maxOpen: p.amount, openValue: 0n }))).toBe('SwapCapExceeded');
  });

  it('finds the largest size the caps still accept', () => {
    const o = rawOffer();
    const price = (xmr: bigint) => priceOffer(o, xmr);
    // Per-swap cap 100 SOL at 1.5 SOL per XMR: 66.666666666666 XMR.
    const top = largestUnderCaps(caps(), 0, price, o.minXmr, o.maxXmr)!;
    expect(top.pricing.amount <= 100n * SOL).toBe(true);
    expect(priceOffer(o, top.xmr + 1n).amount > 100n * SOL).toBe(true);
    expect(top.xmr).toBe(66_666_666_666_666n);
    // Headroom binds instead: 30 SOL left.
    const tight = largestUnderCaps(caps({ openValue: 970n * SOL }), 0, price, o.minXmr, o.maxXmr)!;
    expect(tight.xmr).toBe(20n * X);
    expect(tight.pricing.amount).toBe(30n * SOL);
    // Nothing fits: not even the offer's minimum.
    expect(largestUnderCaps(caps({ openValue: 1000n * SOL }), 0, price, o.minXmr, o.maxXmr)).toBe(null);
    // The whole range fits, or the switch is off.
    expect(largestUnderCaps(caps(), 0, price, o.minXmr, 10n * X)!.xmr).toBe(10n * X);
    expect(largestUnderCaps(CAPS_OFF, 0, price, o.minXmr, o.maxXmr)!.xmr).toBe(o.maxXmr);
    expect(largestUnderCaps(caps(), 0, price, 5n, 4n)).toBe(null);
  });
});

describe('caps in the router', () => {
  function offer(id: string, price: bigint, over: Partial<RouterOffer> & { max?: bigint; cap?: bigint } = {}): RouterOffer {
    const raw = rawOffer({ prices: [price, 0n, 0n], maxXmr: over.max ?? 1000n * X, capacityXmr: over.cap ?? 1000n * X });
    return { id, makerId: id, chain: 'solana', asset: 0, minXmr: raw.minXmr, maxXmr: raw.maxXmr, capacityXmr: raw.capacityXmr, mode: 0, approvalWindow: 60, depBps: 100, withholdRate: 0, faultRate: 0, price: (xmr) => priceOffer(raw, xmr), ...over };
  }
  const order = (over: Partial<RouterOrder> = {}): RouterOrder => ({ totalPay: 300n * SOL, worstPrice: 2n * SOL, maxInFlight: 1_000_000n * SOL, deadline: 1_800_100_000n, maxWaves: 1, ...over });

  it('no leg is over the per-swap cap, a wave stays inside the open value left, and the plan says the cap was reached', () => {
    const c = caps({ maxSwap: 100n * SOL, maxOpen: 1000n * SOL, openValue: 820n * SOL });
    const plan = planRoute(order(), [offer('a', 150n * SOL / 100n, { caps: c }), offer('b', 152n * SOL / 100n, { caps: c }), offer('c', 155n * SOL / 100n, { caps: c })]);
    const legs = plan.waves[0]!.legs;
    // 180 SOL of open value are left: 100 (the per-swap cap) to the best maker, 80 to the next.
    expect(legs.map((l) => l.offerId)).toEqual(['a', 'b']);
    expect(legs.every((l) => l.pay <= 100n * SOL)).toBe(true);
    expect(legs[0]!.pay > 99n * SOL).toBe(true);
    expect(plan.waves[0]!.pay <= 180n * SOL).toBe(true);
    expect(plan.waves[0]!.pay > 179n * SOL).toBe(true);
    expect(plan.capReached).toBe(true);
    // The third maker had room of its own but none under the cap.
    expect(plan.dropped).toContainEqual({ offerId: 'c', reason: 'cap-reached' });
    expect(plan.unfilledPay > 119n * SOL).toBe(true);
    // Every leg, opened in order against the same snapshot, passes the on-chain check.
    let state = c;
    for (const l of legs) {
      expect(() => assertUnderCaps(state, 0, l.pay, l.deposit)).not.toThrow();
      state = capsAfterOpen(state, 0, l.pay, l.deposit);
    }
  });

  it('a maker limit is not a cap: nothing is reported when the caps do not bind', () => {
    const roomy = caps({ maxSwap: 10_000n * SOL, maxOpen: 100_000n * SOL });
    const plan = planRoute(order(), [offer('a', 150n * SOL / 100n, { caps: roomy, max: 40n * X, cap: 40n * X }), offer('b', 152n * SOL / 100n, { caps: roomy })]);
    expect(plan.capReached).toBe(false);
    expect(plan.dropped.some((d) => d.reason === 'cap-reached')).toBe(false);
    expect(plan.waves[0]!.legs[0]).toMatchObject({ offerId: 'a', xmr: 40n * X });
    expect(plan.unfilledPay).toBe(0n);
    // No caps given at all behaves as before the amendment.
    expect(planRoute(order(), [offer('a', 150n * SOL / 100n)]).capReached).toBe(false);
    // The switch off: no limit.
    expect(planRoute(order(), [offer('a', 150n * SOL / 100n, { caps: CAPS_OFF })])).toMatchObject({ capReached: false, unfilledPay: 0n });
  });

  it('assets do not share open value; a fresh deployment fills nothing and says why', () => {
    const sol = caps({ maxSwap: 100n * SOL, maxOpen: 100n * SOL });
    const other = caps({ maxSwap: 100n * SOL, maxOpen: 100n * SOL });
    const two = planRoute(order(), [offer('a', 150n * SOL / 100n, { caps: sol }), offer('b', 151n * SOL / 100n, { caps: other, capsKey: 'ethereum:0x00' })]);
    expect(two.waves[0]!.legs.map((l) => l.pay > 99n * SOL)).toEqual([true, true]);
    const closed = planRoute(order(), [offer('a', 150n * SOL / 100n, { caps: { on: true, maxSwap: 0n, maxOpen: 0n, openValue: 0n } })]);
    expect(closed).toMatchObject({ waves: [], capReached: true, filledPay: 0n });
    expect(closed.dropped).toEqual([{ offerId: 'a', reason: 'cap-reached' }]);
  });
});

describe('Solana: caps, payout address and program build through the client', () => {
  const PROGRAM = new PublicKey(DEV_PROGRAM_ID);
  const P = PROGRAM.toBase58();
  const USDC = new PublicKey(r.bytes(32));
  const SYSTEM = '11111111111111111111111111111111';
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const wallet = () => Keypair.fromSeed(r.bytes(32)).publicKey;
  const setup = () => {
    const fake = new FakeSolana();
    const client = new SolanaClient({ transport: fake, programId: PROGRAM, usdcMint: USDC });
    return { fake, client };
  };
  const config = (over: Partial<Config> = {}): Config => ({ admin: wallet().toBase58(), treasuryAuthority: wallet().toBase58(), clusterTag: r.bytes(32), usdcMint: USDC.toBase58(), splitMode: 0, bump: 255, treasuryBump: 254, capsOn: 1, maxSwap: [100n * SOL, 5_000_000_000n], maxOpen: [1000n * SOL, 50_000_000_000n], openValue: [7n * SOL, 0n], reserved: new Uint8Array(68), ...over });

  it('getCaps reads the switch, both caps and the open value of an asset', async () => {
    const { fake, client } = setup();
    await expect(client.getCaps(0)).rejects.toMatchObject({ code: 'NotInitialized' });
    fake.setAccount(configPda(PROGRAM).toBase58(), P, encodeAccount('Config', config(), ACCOUNT_SIZE.Config));
    expect(await client.getCaps(0)).toEqual({ on: true, maxSwap: 100n * SOL, maxOpen: 1000n * SOL, openValue: 7n * SOL });
    expect(await client.getCaps(1)).toEqual({ on: true, maxSwap: 5_000_000_000n, maxOpen: 50_000_000_000n, openValue: 0n });
    fake.setAccount(configPda(PROGRAM).toBase58(), P, encodeAccount('Config', config({ capsOn: 0 }), ACCOUNT_SIZE.Config));
    expect((await client.getCaps(0)).on).toBe(false);
  });

  it('payoutProblem finds what the program cannot: an on-curve token account or program', async () => {
    const { fake, client } = setup();
    // A fresh address nobody has used: fine for SOL.
    const fresh = wallet().toBase58();
    expect(await client.payoutProblem(fresh, 0)).toEqual({ verdict: 'ok', reason: null, tokenAccountMissing: false, tokenAccountRent: 0n });
    // The same for USDC: it has no token account, and creating one costs the rent of 165 bytes.
    const rent = await fake.getMinimumBalanceForRentExemption(165);
    expect(await client.payoutProblem(fresh, 1)).toEqual({ verdict: 'ok', reason: null, tokenAccountMissing: true, tokenAccountRent: rent });
    fake.setAccount(ata(fresh, USDC).toBase58(), TOKEN, new Uint8Array(165));
    expect(await client.payoutProblem(fresh, 1)).toMatchObject({ verdict: 'ok', tokenAccountMissing: false });
    // An ordinary funded wallet.
    const funded = wallet().toBase58();
    fake.setAccount(funded, SYSTEM, new Uint8Array(0));
    expect((await client.payoutProblem(funded, 0)).verdict).toBe('ok');
    // What the program refuses by the address: never needs a read.
    const before = fake.calls.getAccount ?? 0;
    for (const bad of [SYSTEM, P, getAssociatedTokenAddressSync(USDC, wallet(), true).toBase58()]) expect(await client.payoutProblem(bad, 0)).toMatchObject({ verdict: 'refuse', reason: 'invalid-address' });
    expect(fake.calls.getAccount ?? 0).toBe(before);
    // What it accepts but must not be used: a token account created at a keypair address, and a program.
    const tokenAtKeypair = wallet().toBase58();
    fake.setAccount(tokenAtKeypair, TOKEN, new Uint8Array(165));
    expect(await client.payoutProblem(tokenAtKeypair, 1)).toMatchObject({ verdict: 'refuse', reason: 'token-account' });
    const token2022 = wallet().toBase58();
    fake.setAccount(token2022, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', new Uint8Array(165));
    expect(await client.payoutProblem(token2022, 0)).toMatchObject({ verdict: 'refuse', reason: 'token-account' });
    const programAtKeypair = wallet().toBase58();
    fake.setAccount(programAtKeypair, BPF_LOADER_UPGRADEABLE.toBase58(), new Uint8Array(36));
    expect(await client.payoutProblem(programAtKeypair, 0)).toMatchObject({ verdict: 'refuse', reason: 'program' });
    // An account some other program owns: possible, but said.
    const owned = wallet().toBase58();
    fake.setAccount(owned, wallet().toBase58(), new Uint8Array(8));
    expect(await client.payoutProblem(owned, 0)).toMatchObject({ verdict: 'warn', reason: 'program-owned' });
  });

  it('programBuild hashes the executable without the header and trailing zeros', async () => {
    const { fake, client } = setup();
    await expect(client.programBuild()).rejects.toMatchObject({ code: 'NoProgramData' });
    const elf = r.bytes(300);
    elf[299] = 7;
    const data = new Uint8Array(45 + 300 + 4096);
    data.set(r.bytes(45), 0);
    data.set(elf, 45);
    const programData = PublicKey.findProgramAddressSync([PROGRAM.toBytes()], BPF_LOADER_UPGRADEABLE)[0];
    fake.setAccount(programData.toBase58(), BPF_LOADER_UPGRADEABLE.toBase58(), data);
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const build = await client.programBuild();
    expect(build.hash).toBe(hex(sha256(elf)));
    expect(programHashOf(data)).toBe(build.hash);
    // The padding of a larger allocation does not change the hash; another header does not either.
    expect(programHashOf(data.subarray(0, 45 + 300))).toBe(build.hash);
    expect(build).toMatchObject({ published: PROGRAM_HASH, status: PROGRAM_HASH === null ? 'unpublished' : 'mismatch' });
  });
});

describe('Ethereum: caps and payout address through the client', () => {
  const CONTRACT = vector('eip712').domain.verifyingContract as Address;
  const setup = () => {
    const fake = new FakeEthereum(CONTRACT);
    return { fake, client: new EthereumClient({ transport: fake, contract: CONTRACT }) };
  };

  it('capsOf reads the four values at the tag asked for', async () => {
    const { fake, client } = setup();
    const token = hex0x(r.bytes(20)) as Address;
    fake.views.capsOf = ([t], ctx) => (String(t).toLowerCase() === token ? [true, 5n, 50n, ctx.tag === 'latest' ? 9n : 4n] : [true, 0n, 0n, 0n]);
    expect(await client.capsOf(token)).toEqual({ on: true, maxSwap: 5n, maxOpen: 50n, openValue: 4n });
    expect((await client.capsOf(token, 'latest')).openValue).toBe(9n);
    // A token the owner never configured: switched on with zero caps.
    expect(capsHeadroom(await client.capsOf(hex0x(r.bytes(20)) as Address))).toBe(0n);
  });

  it('payoutProblem refuses what the contract reverts on and warns about an address with code', async () => {
    const { fake, client } = setup();
    const eoa = hex0x(r.bytes(20)) as Address;
    expect(await client.payoutProblem(eoa)).toEqual({ verdict: 'ok', reason: null });
    for (const bad of ['0x0000000000000000000000000000000000000000', CONTRACT, CONTRACT.toUpperCase().replace('0X', '0x'), '0x12'] as Address[]) expect(await client.payoutProblem(bad), bad).toEqual({ verdict: 'refuse', reason: 'invalid-address' });
    const wallet = hex0x(r.bytes(20)) as Address;
    fake.code.add(wallet);
    expect(await client.payoutProblem(wallet)).toEqual({ verdict: 'warn', reason: 'contract' });
    expect(await client.hasCode(eoa)).toBe(false);
  });
});

describe('from a decision to a transaction: freeze and the delivery of parked proceeds', () => {
  const z32 = new Uint8Array(32);
  const PROGRAM = new PublicKey(DEV_PROGRAM_ID);
  const USDC = new PublicKey(r.bytes(32));
  const program = new XmrSwapProgram(PROGRAM, USDC);
  const key = () => Keypair.fromSeed(r.bytes(32)).publicKey.toBase58();
  const view = (over: Partial<SwapView>): SwapView => ({ ...NO_SWAP, chain: 'solana', swapRef: r.bytes(32), taker: key(), maker: key(), asset: '1', xmr: X, price: 0n, depBps: 100, swapNonce: new Uint8Array(16), sessionKey: key(), takerEncKey: z32, makerEncVersion: 1, makerEncKey: z32, takerSpendPub: z32, makerSpendPub: z32, lockerView: z32, noticeCommitment: z32, noticeCt: new Uint8Array(0), evidenceTxid: z32, evidenceView: z32, revealed: z32, payoutAddress: null, watcherAddress: null, ...over });
  const wallets = { operator: key(), payout: key() };

  it('Solana: freeze is the Short list; parked claim proceeds go to the payout address whoever sends', () => {
    const watcher = key();
    const s = view({ direction: 0, state: 3, watcher: true, watcherAddress: watcher, wZ: 3600 });
    const fz = solanaInstruction(program, s, wallets, watcher, { name: 'freeze' });
    expect(fz.keys.map((k) => k.pubkey.toBase58())).toEqual([watcher, new PublicKey(s.swapRef).toBase58(), s.maker, configPda(PROGRAM).toBase58()]);
    expect(fz.keys[0]).toMatchObject({ isSigner: true });
    expect(fz.data.length).toBe(8);

    const payout = key();
    const b = view({ direction: 1, state: 9, payout: 'other', payoutAddress: payout, owedTaker: 5n });
    const stranger = key();
    for (const call of [{ name: 'withdraw_owed', who: 'payout' }, { name: 'push_owed', who: 'payout' }] as const) {
      const ix = solanaInstruction(program, b, wallets, stranger, call);
      expect(ix.keys.length).toBe(17);
      // The taker slots stay the taker's; the payout slots are the payout address and its token account; the ATA program lets a missing account be created.
      expect(ix.keys[4]!.pubkey.toBase58()).toBe(b.taker);
      expect(ix.keys.slice(14).map((k) => k.pubkey.toBase58())).toEqual([payout, ata(payout, USDC).toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
      expect(ix.data[8]).toBe(0);
    }
    // The payout address itself may name another destination.
    const dest = key();
    const own = solanaInstruction(program, b, wallets, payout, { name: 'withdraw_owed', who: 'payout' }, { destination: dest });
    expect(own.keys[14]!.pubkey.toBase58()).toBe(dest);
    expect(own.keys[4]!.pubkey.toBase58()).toBe(b.taker);
    // A claim of the same swap pays the payout address; the caller may decline to create its token account.
    expect(codeOf(() => solanaInstruction(program, b, wallets, stranger, { name: 'push_owed', who: 'taker' }))).toBe('NotAvailable');
    // fund names the maker's watcher.
    const pending = view({ direction: 1, state: 1 });
    const fund = solanaInstruction(program, pending, wallets, wallets.operator, { name: 'fund' }, { makerShare: { spendPub: r.bytes(32), pok: r.bytes(64), view: r.bytes(32) }, watcher });
    expect(hex(fund.data.subarray(fund.data.length - 33))).toBe(`01${hex(new PublicKey(watcher).toBytes())}`);
    const plain = solanaInstruction(program, pending, wallets, wallets.operator, { name: 'fund' }, { makerShare: { spendPub: r.bytes(32), pok: r.bytes(64), view: r.bytes(32) } });
    expect(plain.data[plain.data.length - 1]).toBe(0);
  });

  it('Ethereum: freeze(swapId); pushOwed delivers a parked balance to its own account', async () => {
    const { decodeFunctionData } = await import('viem');
    const { IXmrSwapAbi } = await import('@xmrswap/protocol');
    const contract = new XmrSwapContract(hex0x(r.bytes(20)) as Address);
    const dec = (data: `0x${string}`) => decodeFunctionData({ abi: IXmrSwapAbi, data });
    const taker = hex0x(r.bytes(20));
    const payout = hex0x(r.bytes(20));
    const token = hex0x(r.bytes(20));
    const s = view({ chain: 'ethereum', taker, asset: token, direction: 1, state: 9, payout: 'other', payoutAddress: payout, owedTaker: 5n });
    const fz = dec(ethereumCall(contract, { ...s, state: 3 }, { name: 'freeze' })!.data);
    expect([fz.functionName, fz.args]).toEqual(['freeze', [hex0x(s.swapRef)]]);
    const push = dec(ethereumCall(contract, s, { name: 'push_owed', who: 'payout' })!.data);
    expect(push.functionName).toBe('pushOwed');
    expect((push.args as unknown as string[]).map((a) => a.toLowerCase())).toEqual([token, payout]);
    expect((dec(ethereumCall(contract, s, { name: 'push_owed', who: 'taker' })!.data).args as unknown as string[])[1]!.toLowerCase()).toBe(taker);
    expect(codeOf(() => ethereumCall(contract, s, { name: 'push_owed', who: 'maker' }))).toBe('MissingMaterial');
    // The payout address pulls its own with withdrawOwed, to any destination.
    const dest = hex0x(r.bytes(20));
    expect((dec(ethereumCall(contract, s, { name: 'withdraw_owed', who: 'payout' }, { destination: dest })!.data).args as unknown as string[])[1]!.toLowerCase()).toBe(dest);
  });
});
