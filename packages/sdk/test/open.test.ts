// Opening a swap: one function turns the seed, a nonce and the reviewed offer or quote into the
// exact lock or take, on both chains.
import { beforeAll, describe, expect, it } from 'vitest';
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ethSwapId, init, pokVerify, twinCommitments } from '@xmrswap/core-wasm';
import { type Address, type AssetCaps, DEV_PROGRAM_ID, type Maker, type Offer, type Quote, base58Encode } from '@xmrswap/protocol';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, type Abi } from 'viem';
import { XmrSwapContract } from '../src/ethereum/client.js';
import { takerSwapKeys } from '../src/flows/keys.js';
import { planEthereumOpen, planSolanaOpen, solanaPayoutInvalid } from '../src/flows/open.js';
import { CapReached, isCapReached } from '../src/registry/caps.js';
import { quoteFromMessage } from '../src/signing/eip712.js';
import { offerTermsHash, signSolApproval } from '../src/signing/solana.js';
import { XmrSwapProgram } from '../src/solana/instructions.js';
import { makerPda, offerPda, quotePda, swapPda } from '../src/solana/pdas.js';
import { APPROVAL_IX_INDEX, legacyTransaction, wireSize } from '../src/solana/tx.js';
import { codeOf, hex, hex0x, unhex } from '../src/util.js';
import { repoRoot, rng, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const r = rng(21);
const X = 10n ** 12n;
const seed = unhex(vector('keys').cases[0].input.seed);

describe('planSolanaOpen', () => {
  const idl = JSON.parse(readFileSync(path.join(repoRoot, 'interfaces/solana/xmr_swap.idl.json'), 'utf8'));
  const coder = new BorshInstructionCoder(idl as Idl);
  const PROGRAM = new PublicKey(DEV_PROGRAM_ID);
  const program = new XmrSwapProgram(PROGRAM, new PublicKey(r.bytes(32)));
  // A wallet address: on the Ed25519 curve (a payout must be; the default payout is the taker itself).
  const taker = Keypair.fromSeed(r.bytes(32)).publicKey.toBase58();
  const operator = base58Encode(r.bytes(32));
  const maker = makerPda(PROGRAM, new PublicKey(r.bytes(32))).toBase58();
  const makerRec = { encKeyVersion: 4, operator } as Maker;
  const nonce = r.bytes(16);
  const offer = (direction: number, over: Partial<Offer> = {}): Offer => {
    const base = { maker, asset: 0, direction, enabled: 1, mode: 0, seq: 17n, minXmr: X / 10n, maxXmr: 100n * X, capacityXmr: 100n * X, priceAbove: [0n, X, 50n * X], prices: [150_000_000n, 149_000_000n, 148_000_000n], depthAbove: [0n, X, 50n * X], depths: Uint8Array.of(2, 10, 25), depBps: 100, wA: 60, wN: 600, dC: 6060, wC: 1800, wF: 604_800, wZ: 0, poolFilled: 0b0000_0000_0011_1100, poolUsed: 0b0000_0000_0000_1100, ...over } as unknown as Offer;
    return { ...base, termsHash: offerTermsHash(base) };
  };
  const input = (over: object = {}) => ({ program, taker, makerPda: maker, maker: makerRec, seed, swapNonce: nonce, xmr: 2n * X, source: { offer: offer(0) }, rentExemptMinimum: 890_880n, ...over });

  it('lock against an offer: keys from the seed and nonce, the proof bound to the swap PDA, the terms the user saw', () => {
    const plan = planSolanaOpen(input());
    const pda = swapPda(PROGRAM, taker, nonce);
    expect(plan).toMatchObject({ direction: 0, swapPda: pda.toBase58(), amount: 298_000_000n, deposit: 2_980_000n, depth: 10, limit: 298_000_000n, sessionLamports: 2_890_880n });
    expect(hex(plan.keys.spend)).toBe(hex(takerSwapKeys(seed, 'solana', nonce).spend));
    expect(plan.instructions.length).toBe(1);
    // One signature: the base fee.
    expect(plan.feeLamports).toBe(5_000n);
    const ix = plan.instructions[0]!;
    const d = coder.decode(Buffer.from(ix.data))!;
    expect(d.name).toBe('lock');
    const a = (d.data as any).args;
    expect(hex(Uint8Array.from(a.swap_nonce))).toBe(hex(nonce));
    expect([a.xmr.toString(), a.max_pay.toString(), a.session_lamports.toString(), a.min_seq.toString()]).toEqual(['2000000000000', '298000000', '2890880', '17']);
    expect(hex(Uint8Array.from(a.expected_terms_hash))).toBe(hex(offer(0).termsHash));
    expect(a.maker_enc_version).toBe(4);
    // The first pool slot that is filled and unused.
    expect(a.key_hint).toBe(4);
    expect(a.approval_ix).toBe(null);
    // The proof verifies for this swap PDA and no other.
    expect(pokVerify(Uint8Array.from(a.taker_spend_pub), pda.toBytes(), Uint8Array.from(a.taker_pok))).toBe(true);
    expect(pokVerify(Uint8Array.from(a.taker_spend_pub), swapPda(PROGRAM, taker, r.bytes(16)).toBytes(), Uint8Array.from(a.taker_pok))).toBe(false);
    expect(hex(Uint8Array.from(a.taker_view))).toBe(hex(plan.keys.view));
    expect(hex(Uint8Array.from(a.taker_enc_key))).toBe(hex(plan.keys.encPub));
    // The session key is the derived one, and the offer account is the direction-A offer of this maker.
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(base58Encode(plan.keys.sessionPub));
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(offerPda(PROGRAM, maker, 0, 0).toBase58());
    expect(wireSize(legacyTransaction({ payer: taker, blockhash: base58Encode(r.bytes(32)), instructions: plan.instructions, cuLimit: 100_000 }))).toBe(684);
    // Amendment 1: no watcher unless asked for; the limit a caller sets without a simulation.
    expect(a.watcher).toBe(null);
    expect(plan).toMatchObject({ watcher: null, payout: null, freezeWindow: 0, computeUnitLimit: 80_000 });
  });

  it('slippage widens the limit the right way in each direction', () => {
    expect(planSolanaOpen(input({ slippageBps: 50 })).limit).toBe(298_000_000n + 1_490_000n);
    const take = planSolanaOpen(input({ source: { offer: offer(1) }, slippageBps: 50 }));
    expect(take).toMatchObject({ direction: 1, amount: 298_000_000n, limit: 298_000_000n - 1_490_000n });
    const d = coder.decode(Buffer.from(take.instructions[0]!.data))!;
    expect(d.name).toBe('take');
    expect((d.data as any).args.min_receive.toString()).toBe('296510000');
    expect(take.instructions[0]!.keys[6]!.pubkey.toBase58()).toBe(offerPda(PROGRAM, maker, 0, 1).toBase58());
    expect(codeOf(() => planSolanaOpen(input({ slippageBps: -1 })))).toBe('BadSlippage');
  });

  it('a sell names a payout address: the taker\'s own by default, never a token account, a program address or the default key', () => {
    const sell = (over: object = {}) => planSolanaOpen(input({ source: { offer: offer(1) }, ...over }));
    const own = sell();
    expect(own.payout).toBe(taker);
    expect((coder.decode(Buffer.from(own.instructions[0]!.data))!.data as any).args.payout.toBase58()).toBe(taker);
    const fresh = Keypair.fromSeed(r.bytes(32)).publicKey.toBase58();
    const plan = sell({ payout: fresh });
    expect(plan.payout).toBe(fresh);
    expect((coder.decode(Buffer.from(plan.instructions[0]!.data))!.data as any).args.payout.toBase58()).toBe(fresh);
    // What the program refuses by the address alone (PayoutInvalid) is refused before anything is built.
    const offCurve = getAssociatedTokenAddressSync(new PublicKey(r.bytes(32)), new PublicKey(fresh), true).toBase58();
    for (const bad of ['11111111111111111111111111111111', PROGRAM.toBase58(), offCurve, maker, 'not-base58-0OIl']) {
      expect(solanaPayoutInvalid(bad, PROGRAM.toBase58()), bad).toBe(true);
      expect(codeOf(() => sell({ payout: bad })), bad).toBe('PayoutInvalid');
    }
    expect(solanaPayoutInvalid(fresh, PROGRAM.toBase58())).toBe(false);
    // Only a sell has a payout address.
    expect(codeOf(() => planSolanaOpen(input({ payout: fresh })))).toBe('PayoutInvalid');
    // USDC to an address without a token account: the rent of creating it is added to the session budget.
    const usdc = sell({ source: { offer: offer(1, { asset: 1 }) }, payout: fresh, payoutTokenRent: 2_039_280n });
    expect(usdc.sessionLamports).toBe(own.sessionLamports + 2_039_280n);
    // SOL needs no token account: the figure is ignored.
    expect(sell({ payout: fresh, payoutTokenRent: 2_039_280n }).sessionLamports).toBe(own.sessionLamports);
  });

  it('a buy may name a watcher, only against an offer or quote with a freeze window', () => {
    const w = Keypair.fromSeed(r.bytes(32)).publicKey.toBase58();
    expect(codeOf(() => planSolanaOpen(input({ watcher: w })))).toBe('WatcherNotAllowed');
    const plan = planSolanaOpen(input({ watcher: w, source: { offer: offer(0, { wZ: 86_400 }) } }));
    expect(plan).toMatchObject({ watcher: w, freezeWindow: 86_400 });
    expect((coder.decode(Buffer.from(plan.instructions[0]!.data))!.data as any).args.watcher.toBase58()).toBe(w);
    expect(wireSize(legacyTransaction({ payer: taker, blockhash: base58Encode(r.bytes(32)), instructions: plan.instructions, cuLimit: 100_000 }))).toBe(684 + 32);
    // The freeze window is a term: the hash the lock carries is the hash of the offer the user saw.
    expect(hex(offer(0, { wZ: 86_400 }).termsHash)).not.toBe(hex(offer(0).termsHash));
    // In the sell direction the maker names the watcher, at fund.
    expect(codeOf(() => planSolanaOpen(input({ watcher: w, source: { offer: offer(1, { wZ: 86_400 }) } })))).toBe('WatcherNotAllowed');
    const quote = { maker, taker, asset: 0, direction: 0, depth: 25, xmr: 2n * X, amount: 300_000_000n, depBps: 50, quoteId: 9n, wZ: 3_600 } as Quote;
    expect(planSolanaOpen(input({ watcher: w, source: { quote } }))).toMatchObject({ watcher: w, freezeWindow: 3_600 });
    expect(codeOf(() => planSolanaOpen(input({ watcher: w, source: { quote: { ...quote, wZ: 0 } } })))).toBe('WatcherNotAllowed');
  });

  it('the beta caps: exactly at a cap is allowed, one unit above is "cap reached", and never a maker limit', () => {
    // 2 XMR at 149 USD: amount 298,000,000, deposit 2,980,000.
    const caps = (over: Partial<AssetCaps> = {}): AssetCaps => ({ on: true, maxSwap: 298_000_000n, maxOpen: 298_000_000n, openValue: 0n, ...over });
    expect(planSolanaOpen(input({ caps: caps() })).amount).toBe(298_000_000n);
    const over = (c: AssetCaps, extra: object = {}): unknown => {
      try {
        planSolanaOpen(input({ caps: c, ...extra }));
      } catch (e) {
        return e;
      }
      return null;
    };
    const perSwap = over(caps({ maxSwap: 297_999_999n, maxOpen: 10n ** 12n }));
    expect(perSwap).toBeInstanceOf(CapReached);
    expect(perSwap).toMatchObject({ code: 'SwapCapExceeded', kind: 'SwapCapExceeded', maxSwap: 297_999_999n });
    const open = over(caps({ maxSwap: 10n ** 12n, maxOpen: 1_000_000_000n, openValue: 702_000_001n }));
    expect(open).toMatchObject({ code: 'OpenCapExceeded', headroom: 297_999_999n });
    expect(over(caps({ maxSwap: 10n ** 12n, maxOpen: 1_000_000_000n, openValue: 702_000_000n }))).toBe(null);
    // A sell counts amount + deposit toward the open value; the per-swap cap bounds the amount alone.
    const sell = { source: { offer: offer(1) } };
    expect(over(caps({ maxOpen: 300_980_000n }), sell)).toBe(null);
    expect(over(caps({ maxOpen: 300_979_999n }), sell)).toMatchObject({ code: 'OpenCapExceeded' });
    // A fresh deployment is fail-closed: switched on with zero caps.
    expect(over({ on: true, maxSwap: 0n, maxOpen: 0n, openValue: 0n })).toMatchObject({ code: 'SwapCapExceeded' });
    // Switched off, nothing is checked.
    expect(over({ on: false, maxSwap: 0n, maxOpen: 0n, openValue: 0n })).toBe(null);
    // The maker's own limit is a different error.
    expect(codeOf(() => planSolanaOpen(input({ caps: caps(), source: { offer: offer(0, { capacityXmr: X }) } })))).toBe('CapacityExceeded');
    expect(isCapReached(perSwap) && !isCapReached(new Error('x'))).toBe(true);
    // A quote is capped like an offer.
    const quote = { maker, taker, asset: 0, direction: 0, depth: 25, xmr: 2n * X, amount: 298_000_001n, depBps: 50, quoteId: 9n, wZ: 0 } as Quote;
    expect(over(caps(), { source: { quote } })).toMatchObject({ code: 'SwapCapExceeded' });
  });

  it('a fresh nonce every time, unless one is given', () => {
    const a = planSolanaOpen(input({ swapNonce: undefined }));
    const b = planSolanaOpen(input({ swapNonce: undefined }));
    expect(hex(a.swapNonce)).not.toBe(hex(b.swapNonce));
    expect(a.swapPda).not.toBe(b.swapPda);
    expect(hex(a.keys.spend)).not.toBe(hex(b.keys.spend));
  });

  it('with an advance approval: the Ed25519 instruction comes first and approval_ix points at it', () => {
    const c = vector('sol_signed');
    const f = c.cases[1].input.approval;
    const approval = signSolApproval(unhex(c.operator_seed), { clusterTag: unhex(f.cluster_tag), programId: unhex(f.program_id), maker: unhex(f.maker), taker: unhex(f.taker), asset: f.asset, direction: f.direction, maxXmr: BigInt(f.max_xmr), notBefore: BigInt(f.not_before), expiresAt: BigInt(f.expires_at), epoch: f.epoch, approvalId: BigInt(f.approval_id) });
    const plan = planSolanaOpen(input({ approval }));
    expect(plan.instructions.length).toBe(2);
    // The Ed25519 precompile's signature is charged too: an approval transaction costs 10,000 lamports.
    expect(plan.feeLamports).toBe(10_000n);
    expect(plan.instructions[0]!.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    const a = (coder.decode(Buffer.from(plan.instructions[1]!.data))!.data as any).args;
    expect(a.approval_ix).toBe(APPROVAL_IX_INDEX);
    const tx = legacyTransaction({ payer: taker, blockhash: base58Encode(r.bytes(32)), instructions: plan.instructions, cuLimit: 100_000 });
    expect(tx.instructions[APPROVAL_IX_INDEX]).toBe(plan.instructions[0]);
    expect(wireSize(tx)).toBe(1055);
    expect(plan.computeUnitLimit).toBe(80_000);
    expect(planSolanaOpen(input({ approval, source: { offer: offer(0, { asset: 1 }) } })).computeUnitLimit).toBe(100_000);
  });

  it('against a taker-bound quote: the exact amount, the quote account, rent back to the operator', () => {
    const quote = { maker, taker, asset: 0, direction: 0, depth: 25, xmr: 300n * X, amount: 44_000_000_000n, depBps: 50, quoteId: 9n, wZ: 0 } as Quote;
    const plan = planSolanaOpen(input({ xmr: 300n * X, source: { quote } }));
    expect(plan).toMatchObject({ direction: 0, amount: 44_000_000_000n, limit: 44_000_000_000n, deposit: 220_000_000n, depth: 25 });
    const ix = plan.instructions[0]!;
    expect(ix.keys[7]!.pubkey.toBase58()).toBe(quotePda(PROGRAM, maker, 9n).toBase58());
    expect(ix.keys[8]!.pubkey.toBase58()).toBe(operator);
    // Absent offer = the program id.
    expect(ix.keys[6]!.pubkey.equals(PROGRAM)).toBe(true);
    expect(codeOf(() => planSolanaOpen(input({ xmr: 299n * X, source: { quote } })))).toBe('QuoteMismatch');
    expect(codeOf(() => planSolanaOpen(input({ xmr: 300n * X, source: { quote: { ...quote, taker: operator } } })))).toBe('QuoteMismatch');
  });

  it('refuses a size the offer does not take, and an offer of another maker', () => {
    expect(codeOf(() => planSolanaOpen(input({ xmr: 101n * X })))).toBe('AmountOutOfRange');
    expect(codeOf(() => planSolanaOpen(input({ source: { offer: offer(0, { capacityXmr: X }) } })))).toBe('CapacityExceeded');
    expect(codeOf(() => planSolanaOpen(input({ makerPda: taker })))).toBe('QuoteMismatch');
  });
});

describe('planEthereumOpen', () => {
  const v = vector('eip712');
  const abi = JSON.parse(readFileSync(path.join(repoRoot, 'interfaces/ethereum/IXmrSwap.abi.json'), 'utf8')) as Abi;
  const contract = new XmrSwapContract(v.domain.verifyingContract);
  const taker = '0x0f8183aefdf068dd8489b6edbf4e07965cf29246' as Address;
  const sig = unhex(v.cases[0].output.signature);
  const maker = { encKeyVersion: 2, encKey: unhex(vector('notice').keys.maker_pub) };
  const nonce = r.bytes(16);
  const leaf = { index: 1, key: hex0x(r.bytes(20)) as Address, key2: hex0x(r.bytes(20)) as Address, spendPub: r.bytes(32), proof: [r.bytes(32)] };
  const q = quoteFromMessage(v.cases[0].input.typed_data.message);

  it('lock: swapId from taker and nonce, twin commitments of the derived share, value = amount + session budget', () => {
    const plan = planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, swapNonce: nonce, xmr: 2n * X, leaf, sessionBudget: 10n ** 15n, slippageBps: 100 });
    expect(hex(plan.swapId)).toBe(hex(ethSwapId(unhex(taker), nonce)));
    expect(plan).toMatchObject({ direction: 0, amount: 121n * 10n ** 15n, deposit: 121n * 10n ** 13n, depth: 10, limit: 121n * 10n ** 15n + 121n * 10n ** 13n });
    expect(plan.call.value).toBe(plan.amount + 10n ** 15n);
    const d = decodeFunctionData({ abi, data: plan.call.data });
    expect(d.functionName).toBe('lock');
    const a = d.args as any[];
    expect([a[2], a[3], a[4], a[6]]).toEqual([2n * X, plan.limit, hex0x(nonce), 10n ** 15n]);
    const twin = twinCommitments(plan.keys.spend);
    expect((a[7].key as string).toLowerCase()).toBe(hex0x(twin.keyAddr));
    expect((a[7].key2 as string).toLowerCase()).toBe(hex0x(twin.keyAddr2));
    expect(a[7].spendPub).toBe(hex0x(plan.keys.spendPub));
    expect(a[7].viewShare).toBe(hex0x(plan.keys.view));
    expect(a[7].makerEncVersion).toBe(2);
    expect(a[7].makerEncKey).toBe(hex0x(maker.encKey));
    // The session key is the address derived for this swap on Ethereum.
    expect((a[5] as string).toLowerCase()).toBe(hex0x(plan.keys.sessionPub));
    expect(plan.keys.sessionPub.length).toBe(20);
    expect(a[8].index).toBe(1);
    // The same seed and nonce on Solana give a disjoint share.
    expect(hex(plan.keys.spend)).not.toBe(hex(takerSwapKeys(seed, 'solana', nonce).spend));
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, xmr: 2n * X, sessionBudget: 0n }))).toBe('NoLeaf');
    // Amendment 1: the last argument is the watcher; zero = none. A watcher needs a quote with a freeze window.
    expect(BigInt(a[11])).toBe(0n);
    expect(plan).toMatchObject({ watcher: null, payout: null, freezeWindow: 0 });
    const w = hex0x(r.bytes(20)) as Address;
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, xmr: 2n * X, leaf, sessionBudget: 0n, watcher: w }))).toBe('WatcherNotAllowed');
    const watched = planEthereumOpen({ contract, taker, quote: { ...q, freezeWindow: 86_400 }, sig, maker, seed, xmr: 2n * X, leaf, sessionBudget: 0n, watcher: w });
    expect(((decodeFunctionData({ abi, data: watched.call.data }).args as any[])[11] as string).toLowerCase()).toBe(w);
    expect(watched).toMatchObject({ watcher: w, freezeWindow: 86_400 });
    // The caps of the token, read at latest: exactly at the cap passes, one wei above is "cap reached".
    const at = { on: true, maxSwap: plan.amount, maxOpen: plan.amount, openValue: 0n };
    expect(planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, xmr: 2n * X, leaf, sessionBudget: 0n, caps: at }).amount).toBe(plan.amount);
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, xmr: 2n * X, leaf, sessionBudget: 0n, caps: { ...at, maxSwap: plan.amount - 1n } }))).toBe('SwapCapExceeded');
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, xmr: 2n * X, leaf, sessionBudget: 0n, caps: { ...at, openValue: 1n } }))).toBe('OpenCapExceeded');
  });

  it('take: only the deposit and the session budget travel; the view share is not posted', () => {
    const qb = quoteFromMessage(v.cases.find((c: any) => c.name === 'quote-public-eth-b').input.typed_data.message);
    const plan = planEthereumOpen({ contract, taker, quote: qb, sig, maker, seed, swapNonce: nonce, xmr: qb.minXmr, sessionBudget: 7n, slippageBps: 100 });
    expect(plan.direction).toBe(1);
    const d = decodeFunctionData({ abi, data: plan.call.data });
    expect(d.functionName).toBe('take');
    const a = d.args as any[];
    expect(a[3]).toBe(plan.amount - plan.amount / 100n);
    expect(BigInt(a[7].viewShare)).toBe(0n);
    expect(plan.call.value).toBe(plan.deposit + 7n);
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: qb, sig, maker, seed, xmr: qb.maxXmr + 1n, sessionBudget: 0n }))).toBe('AmountOutOfRange');
    // The payout address: the taker's own by default (zero is BadValue on chain), or a fresh one.
    expect((a[10] as string).toLowerCase()).toBe(taker.toLowerCase());
    expect(plan.payout).toBe(taker.toLowerCase());
    const fresh = hex0x(r.bytes(20)) as Address;
    const to = planEthereumOpen({ contract, taker, quote: qb, sig, maker, seed, swapNonce: nonce, xmr: qb.minXmr, sessionBudget: 7n, payout: fresh });
    expect(((decodeFunctionData({ abi, data: to.call.data }).args as any[])[10] as string).toLowerCase()).toBe(fresh);
    for (const bad of ['0x0000000000000000000000000000000000000000', contract.address, '0x1234'] as Address[]) expect(codeOf(() => planEthereumOpen({ contract, taker, quote: qb, sig, maker, seed, xmr: qb.minXmr, sessionBudget: 7n, payout: bad })), bad).toBe('PayoutInvalid');
    // Only a sell names one, and the maker (not the taker) names the watcher of a sell.
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: q, sig, maker, seed, xmr: 2n * X, leaf, sessionBudget: 0n, payout: fresh }))).toBe('PayoutInvalid');
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: { ...qb, freezeWindow: 3_600 }, sig, maker, seed, xmr: qb.minXmr, sessionBudget: 7n, watcher: fresh }))).toBe('WatcherNotAllowed');
    // A sell counts amount + deposit toward the open value.
    const room = { on: true, maxSwap: plan.amount, maxOpen: plan.amount + plan.deposit, openValue: 0n };
    expect(planEthereumOpen({ contract, taker, quote: qb, sig, maker, seed, xmr: qb.minXmr, sessionBudget: 7n, caps: room }).deposit).toBe(plan.deposit);
    expect(codeOf(() => planEthereumOpen({ contract, taker, quote: qb, sig, maker, seed, xmr: qb.minXmr, sessionBudget: 7n, caps: { ...room, maxOpen: room.maxOpen - 1n } }))).toBe('OpenCapExceeded');
  });
});
