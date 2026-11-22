// The Solana client against the frozen IDL: instruction builders (account order and flags, data
// decoded back by Anchor's coder), PDAs, the transaction sizes of SPEC 4.10, and the client and
// watchers over an injected SolanaTransport. Nothing here opens a socket.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { init, pokProve } from '@xmrswap/core-wasm';
import { ACCOUNT_SIZE, DEV_PROGRAM_ID, DISCRIMINATOR_BASE58, type LockArgs, type Maker, type Offer, type Swap, type TakeArgs, base58Encode, encodeAccount, encodeEvent, encodeInstructionData, errorCode } from '@xmrswap/protocol';
import { takerSwapKeys } from '../src/flows/keys.js';
import { CLOCK_SYSVAR, ProgramError, SolanaClient, programErrorName, seedSigner } from '../src/solana/client.js';
import { type SettleContext, XmrSwapProgram, buildInstruction } from '../src/solana/instructions.js';
import { TOKEN_PROGRAM_ID, ata, configPda, ethBoardPda, makerPda, offerPda, quotePda, swapPda, treasuryPda, treasuryVaultPda, vaultPda } from '../src/solana/pdas.js';
import { matchesFilters } from '../src/solana/transport.js';
import { APPROVAL_IX_INDEX, MAX_TX_BYTES, approvalEd25519Ix, assertFits, cuLimitFromSimulation, legacyTransaction, packLegs, v0Transaction, wireSize } from '../src/solana/tx.js';
import { FakeSolana } from '../src/testing/solana.js';
import { codeOf, hex, unhex } from '../src/util.js';
import { repoRoot, rng, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const idl = JSON.parse(readFileSync(path.join(repoRoot, 'interfaces/solana/xmr_swap.idl.json'), 'utf8'));
const coder = new BorshInstructionCoder(idl as Idl);
const r = rng(7);
const key = () => new PublicKey(r.bytes(32));
const PROGRAM = new PublicKey(DEV_PROGRAM_ID);
const USDC = key();
const program = new XmrSwapProgram(PROGRAM, USDC);
const BLOCKHASH = base58Encode(r.bytes(32));

const owner = key();
const operator = key();
const payout = key();
const taker = key();
const session = key();
const maker = makerPda(PROGRAM, owner);
const nonce = r.bytes(16);
const swap = swapPda(PROGRAM, taker, nonce);

/** The frozen IDL's account list for an instruction: [name, writable, signer, optional]. */
const idlAccounts = (name: string): [string, boolean, boolean, boolean][] =>
  idl.instructions.find((i: any) => i.name === name).accounts.map((a: any) => [a.name, !!a.writable, !!a.signer, !!a.optional]);

/** Check an instruction against the frozen IDL: program id, account count, flags of every present account, absent optionals as the program id, and data that Anchor decodes to `name`. */
function checkIx(ix: TransactionInstruction, name: string, present: Record<string, PublicKey | null>, remaining = 0): any {
  expect(ix.programId.equals(PROGRAM), name).toBe(true);
  const accounts = idlAccounts(name);
  expect(ix.keys.length, name).toBe(accounts.length + remaining);
  accounts.forEach(([acc, writable, signer, optional], i) => {
    const k = ix.keys[i]!;
    const want = present[acc];
    if (want === undefined) throw new Error(`${name}: the test names no value for account ${acc}`);
    if (want === null) {
      expect(optional, `${name}.${acc} is optional`).toBe(true);
      expect(k.pubkey.equals(PROGRAM), `${name}.${acc} absent = program id`).toBe(true);
      expect([k.isSigner, k.isWritable], `${name}.${acc} absent flags`).toEqual([false, false]);
    } else {
      expect(k.pubkey.toBase58(), `${name}.${acc}`).toBe(want.toBase58());
      expect([k.isWritable, k.isSigner], `${name}.${acc} flags`).toEqual([writable, signer]);
    }
  });
  const decoded = coder.decode(Buffer.from(ix.data));
  expect(decoded?.name, name).toBe(name);
  return decoded!.data;
}

let lockArgs: LockArgs;
let takeArgs: TakeArgs;
beforeAll(() => {
  const k = takerSwapKeys(r.bytes(32), 'solana', nonce);
  const common = {
    swapNonce: nonce,
    sessionLamports: 2_890_880n,
    xmr: 2_000_000_000_000n,
    expectedTermsHash: r.bytes(32),
    minSeq: 9n,
    takerSpendPub: k.spendPub,
    takerPok: pokProve(k.spend, swap.toBytes()),
    takerEncKey: k.encPub,
    makerEncVersion: 3,
    approvalIx: null,
  };
  lockArgs = { ...common, asset: 0, maxPay: 300_000_000n, takerView: k.view, keyHint: 5 };
  takeArgs = { ...common, asset: 0, minReceive: 290_000_000n };
});

describe('PDAs (SPEC 4.1)', () => {
  it('derives every address from its seeds', () => {
    const find = (...seeds: (string | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : s)), PROGRAM)[0].toBase58();
    expect(configPda(PROGRAM).toBase58()).toBe(find('config'));
    expect(treasuryPda(PROGRAM).toBase58()).toBe(find('treasury'));
    expect(treasuryVaultPda(PROGRAM, USDC).toBase58()).toBe(find('treasury_vault', USDC.toBytes()));
    expect(maker.toBase58()).toBe(find('maker', owner.toBytes()));
    expect(offerPda(PROGRAM, maker, 1, 0).toBase58()).toBe(find('offer', maker.toBytes(), Uint8Array.of(1), Uint8Array.of(0)));
    expect(ethBoardPda(PROGRAM, maker).toBase58()).toBe(find('eth_board', maker.toBytes()));
    expect(quotePda(PROGRAM, maker, 0x0102030405060708n).toBase58()).toBe(find('quote', maker.toBytes(), Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1)));
    expect(swap.toBase58()).toBe(find('swap', taker.toBytes(), nonce));
    expect(vaultPda(PROGRAM, swap).toBase58()).toBe(find('vault', swap.toBytes()));
    expect(() => swapPda(PROGRAM, taker, new Uint8Array(15))).toThrow();
    // Different nonce, different swap: a fresh nonce per swap is a fresh swap_ref.
    expect(swapPda(PROGRAM, taker, r.bytes(16)).equals(swap)).toBe(false);
  });
});

describe('instruction builders against the frozen IDL', () => {
  const sys = SystemProgram.programId;
  const config = configPda(PROGRAM);

  it('lock: SOL against an offer, USDC against a quote, with an approval', () => {
    const base = { taker, swap, maker, config, session_key: session, system_program: sys };
    const sol = program.lock({ taker, maker, sessionKey: session, source: { offer: true }, args: lockArgs });
    const data = checkIx(sol, 'lock', { ...base, offer: offerPda(PROGRAM, maker, 0, 0), quote: null, quote_rent_receiver: null, instructions_sysvar: null, mint: null, taker_token: null, vault: null, token_program: null });
    expect(data.args.xmr.toString()).toBe('2000000000000');
    expect(data.args.key_hint).toBe(5);
    expect(sol.data.length).toBe(8 + 247);

    const usdcQuote = program.lock({ taker, maker, sessionKey: session, source: { quoteId: 42n, operator }, args: { ...lockArgs, asset: 1, approvalIx: APPROVAL_IX_INDEX } });
    checkIx(usdcQuote, 'lock', {
      ...base,
      offer: null,
      quote: quotePda(PROGRAM, maker, 42n),
      quote_rent_receiver: operator,
      instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      mint: USDC,
      taker_token: ata(taker, USDC),
      vault: vaultPda(PROGRAM, swap),
      token_program: TOKEN_PROGRAM_ID,
    });
    expect(usdcQuote.data.length).toBe(8 + 248);
    expect(codeOf(() => new XmrSwapProgram(PROGRAM).lock({ taker, maker, sessionKey: session, source: { offer: true }, args: { ...lockArgs, asset: 1 } }))).toBe('NoUsdcMint');
  });

  it('take: only the direction-B offer and no leaf', () => {
    const ix = program.take({ taker, maker, sessionKey: session, source: { offer: true }, args: takeArgs });
    const data = checkIx(ix, 'take', { taker, swap, maker, config, session_key: session, system_program: sys, offer: offerPda(PROGRAM, maker, 0, 1), quote: null, quote_rent_receiver: null, instructions_sysvar: null, mint: null, taker_token: null, vault: null, token_program: null });
    expect(data.args.min_receive.toString()).toBe('290000000');
    expect(ix.data.length).toBe(8 + 214);
  });

  it('approve and fund carry the expected open hash', () => {
    const open = r.bytes(32);
    const share = r.bytes(32);
    const pok = r.bytes(64);
    const a = checkIx(program.approve({ operator, swap, maker, expectedOpen: open, makerSpendPub: share, makerPok: pok }), 'approve', { operator, swap, maker, config });
    expect(hex(Uint8Array.from(a.expected_open))).toBe(hex(open));
    const f = program.fund({ operator, swap, maker, asset: 1, expectedOpen: open, makerSpendPub: share, makerPok: pok, makerView: r.bytes(32) });
    checkIx(f, 'fund', { operator, swap, maker, config, system_program: sys, mint: USDC, operator_token: ata(operator, USDC), vault: vaultPda(PROGRAM, swap), token_program: TOKEN_PROGRAM_ID });
    checkIx(program.fund({ operator, swap, maker, asset: 0, expectedOpen: open, makerSpendPub: share, makerPok: pok, makerView: r.bytes(32) }), 'fund', { operator, swap, maker, config, system_program: sys, mint: null, operator_token: null, vault: null, token_program: null });
  });

  it('the Short list: post_notice, set_ready, withhold, publish_evidence', () => {
    const p = { caller: operator, swap, maker };
    const present = { caller: operator, swap, maker, config };
    const n = checkIx(program.postNotice({ ...p, commitment: r.bytes(32), ciphertext: r.bytes(104) }), 'post_notice', present);
    expect(n.ciphertext.length).toBe(104);
    expect(codeOf(() => program.postNotice({ ...p, commitment: r.bytes(32), ciphertext: r.bytes(103) }))).toBe('BadNotice');
    checkIx(program.setReady(p), 'set_ready', present);
    expect(checkIx(program.withhold({ ...p, evidence: null }), 'withhold', present).evidence).toBe(null);
    const ev = checkIx(program.withhold({ ...p, evidence: { txid: r.bytes(32), view: r.bytes(32) } }), 'withhold', present);
    expect(ev.evidence.txid.length).toBe(32);
    checkIx(program.publishEvidence({ ...p, txid: r.bytes(32), view: r.bytes(32) }), 'publish_evidence', present);
  });

  it('the Settle list: the maker wallet is the payout for a claim in A and the operator otherwise', () => {
    const ctx = (asset: number, direction: number, burn = false): SettleContext => ({ swap, taker, maker, operator, payout, asset, direction, burn });
    const sol = (makerWallet: PublicKey, treasury: PublicKey = treasuryPda(PROGRAM)) => ({ caller: session, swap, maker, config, taker, maker_wallet: makerWallet, treasury, system_program: sys, mint: null, vault: null, taker_token: null, maker_token: null, treasury_vault: null, token_program: null });
    const usdc = (makerWallet: PublicKey) => ({ ...sol(makerWallet), mint: USDC, vault: vaultPda(PROGRAM, swap), taker_token: ata(taker, USDC), maker_token: ata(makerWallet, USDC), treasury_vault: treasuryVaultPda(PROGRAM, USDC), token_program: TOKEN_PROGRAM_ID });
    const secret = r.bytes(32);

    // A: claim pays maker.payout; refund names the operator (the account is unused in A).
    const claimA = checkIx(program.claim(session, ctx(1, 0), secret), 'claim', usdc(payout));
    expect(hex(Uint8Array.from(claimA.secret))).toBe(hex(secret));
    checkIx(program.refund(session, ctx(1, 0), secret), 'refund', usdc(operator));
    // B: the maker's refund returns to its current operator; the taker's claim never pays the payout address.
    checkIx(program.refund(session, ctx(0, 1), secret), 'refund', sol(operator));
    checkIx(program.claim(session, ctx(0, 1), secret), 'claim', sol(operator));
    // Burn mode: the treasury account is the incinerator.
    checkIx(program.settle('splitDeposit', session, ctx(0, 0, true), {}), 'split_deposit', sol(operator, new PublicKey('1nc1nerator11111111111111111111111111111111')));

    for (const [fn, name] of [['cancelPending', 'cancel_pending'], ['expirePending', 'expire_pending'], ['abort', 'abort'], ['refundUnnoticed', 'refund_unnoticed'], ['expireUnnoticed', 'expire_unnoticed'], ['releaseDeposit', 'release_deposit'], ['closeSwap', 'close_swap']] as const) {
      checkIx(program.settle(fn, session, ctx(0, 0), {}), name, sol(operator));
    }
    const rej = checkIx(program.reject(session, ctx(0, 0), r.bytes(32), 2), 'reject', sol(operator));
    expect(rej.reason).toBe(2);

    // withdraw_owed: the destination replaces the taker (who = 0) or the maker wallet (who = 1).
    const dest = key();
    const w0 = program.settle('withdrawOwed', taker, ctx(1, 0), { who: 0 }, dest);
    checkIx(w0, 'withdraw_owed', { ...usdc(operator), caller: taker, taker: dest, taker_token: ata(dest, USDC) });
    const w1 = program.settle('withdrawOwed', owner, ctx(1, 0), { who: 1 }, dest);
    checkIx(w1, 'withdraw_owed', { ...usdc(dest), caller: owner });
  });

  it('registry instructions', () => {
    const enc = r.bytes(32);
    const reg = checkIx(program.registerMaker({ owner, operator, payout, encKey: enc }), 'register_maker', { owner, maker, system_program: sys });
    expect(reg.operator.toBase58()).toBe(operator.toBase58());
    checkIx(program.setOperator(owner, operator), 'set_operator', { owner, maker });
    checkIx(program.setPayout(owner, payout), 'set_payout', { owner, maker });
    expect(checkIx(program.setEthLink(owner, r.bytes(20)), 'set_eth_link', { owner, maker }).eth_address.length).toBe(20);
    expect(codeOf(() => program.setEthLink(owner, r.bytes(32)))).toBe('BadAddress');
    checkIx(program.setPaused(operator, maker, true), 'set_paused', { authority: operator, maker });
    checkIx(program.bumpEpochs(owner, maker, true, false), 'bump_epochs', { authority: owner, maker });
    checkIx(program.rotateEncKey(operator, maker, enc, 1_800_086_400n), 'rotate_enc_key', { operator, maker });
    checkIx(program.setOnion(operator, maker, `${'a'.repeat(56)}.onion`), 'set_onion', { operator, maker });
    checkIx(program.setContacts(operator, maker, [{ kind: 5, value: 'https://blobs.example' }]), 'set_contacts', { operator, maker });
    checkIx(program.setInboxPolicy(operator, maker, 1), 'set_inbox_policy', { operator, maker });
    const terms = { mode: 0, minXmr: 1n, maxXmr: 2n, validSecs: 60, priceAbove: [0n, 0n, 0n], depthAbove: [0n, 0n, 0n], depths: Uint8Array.of(2, 0, 0), depBps: 100, wA: 60, wN: 600, dC: 5400, wC: 1800, wF: 604_800 };
    checkIx(program.setOffer(operator, maker, 1, 0, terms), 'set_offer', { operator, maker, offer: offerPda(PROGRAM, maker, 1, 0), system_program: sys });
    const refresh = program.refreshOffers(operator, maker, [{ asset: 0, direction: 0, enabled: true, prices: [1n, 0n, 0n], capacityXmr: 5n }, { asset: 1, direction: 1, enabled: false, prices: [2n, 0n, 0n], capacityXmr: 6n }], [{ slot: 0, tierPrice: [1n, 2n, 3n], validUntil: 9n, quoteId: 4n, sig: r.bytes(65) }]);
    checkIx(refresh, 'refresh_offers', { operator, maker, eth_board: ethBoardPda(PROGRAM, maker) }, 2);
    // Offers travel as remaining accounts, writable, in the order of `offers`.
    expect(refresh.keys.slice(3).map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner])).toEqual([[offerPda(PROGRAM, maker, 0, 0).toBase58(), true, false], [offerPda(PROGRAM, maker, 1, 1).toBase58(), true, false]]);
    checkIx(program.refreshOffers(operator, maker, []), 'refresh_offers', { operator, maker, eth_board: null });
    const slots = Array.from({ length: 8 }, (_, index) => ({ index, share: r.bytes(32), pok: r.bytes(64) }));
    checkIx(program.refillKeys(operator, maker, 1, slots), 'refill_keys', { operator, maker, offer: offerPda(PROGRAM, maker, 1, 0) });
    expect(codeOf(() => program.refillKeys(operator, maker, 1, [...slots, slots[0]!]))).toBe('TooManySlots');
    checkIx(program.setEthQuote(operator, maker, 2, r.bytes(251), r.bytes(65)), 'set_eth_quote', { operator, maker, eth_board: ethBoardPda(PROGRAM, maker), system_program: sys });
    const qt = { quoteId: 42n, taker: taker.toBase58(), asset: 1, direction: 0, depth: 25, xmr: 1n, amount: 2n, depBps: 0, wN: 600, dC: 6060, wC: 1800, wF: 604_800, makerSpendPub: r.bytes(32), makerPok: r.bytes(64), expiresAt: 1_800_000_120n };
    checkIx(program.postQuote(operator, maker, qt), 'post_quote', { operator, maker, quote: quotePda(PROGRAM, maker, 42n), system_program: sys });
    checkIx(program.cancelQuote(session, maker, 42n, operator), 'cancel_quote', { caller: session, maker, quote: quotePda(PROGRAM, maker, 42n), quote_rent_receiver: operator });
    checkIx(program.initialize({ authority: owner, usdcMint: USDC, clusterTag: r.bytes(32), treasuryAuthority: owner, splitMode: 0 }), 'initialize', {
      authority: owner, config, treasury: treasuryPda(PROGRAM), usdc_mint: USDC, treasury_vault: treasuryVaultPda(PROGRAM, USDC), program: PROGRAM,
      program_data: PublicKey.findProgramAddressSync([PROGRAM.toBytes()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0], token_program: TOKEN_PROGRAM_ID, system_program: sys,
    });
  });

  it('post_message carries the envelope as instruction data and refuses more than 900 bytes', () => {
    const payload = r.bytes(900);
    const data = checkIx(program.postMessage(taker, maker, payload, swap), 'post_message', { sender: taker, recipient: maker, swap });
    expect(data.payload.length).toBe(900);
    checkIx(program.postMessage(taker, maker, r.bytes(10)), 'post_message', { sender: taker, recipient: maker, swap: null });
    expect(codeOf(() => program.postMessage(taker, maker, r.bytes(901)))).toBe('MessageTooLarge');
  });

  it('refuses a missing required account and an account the instruction does not have', () => {
    expect(codeOf(() => buildInstruction(PROGRAM, 'setReady', {}, { caller: operator, swap, maker }))).toBe('MissingAccount');
    expect(codeOf(() => buildInstruction(PROGRAM, 'setReady', {}, { caller: operator, swap, maker, config: configPda(PROGRAM), offer: maker }))).toBe('UnknownAccount');
  });
});

describe('transaction sizes (SPEC 4.10)', () => {
  const approval = () => {
    const c = vector('sol_signed').cases.find((c: any) => c.name === 'at-not-before').output;
    return approvalEd25519Ix(unhex(c.operator_pub), unhex(c.signature), unhex(c.message));
  };
  const size = (payer: PublicKey, ixs: TransactionInstruction[]) => {
    const tx = legacyTransaction({ payer, blockhash: BLOCKHASH, instructions: ixs, cuLimit: 200_000, cuPrice: 1 });
    const keys = tx.compileMessage().accountKeys.length;
    return { bytes: wireSize(tx), keys, tx };
  };
  const lock = (o: { asset: number; quote?: boolean; approval?: boolean; t?: PublicKey; m?: PublicKey; s?: PublicKey }) => {
    const t = o.t ?? taker;
    return program.lock({ taker: t, maker: o.m ?? maker, sessionKey: o.s ?? session, source: o.quote ? { quoteId: 42n, operator } : { offer: true }, args: { ...lockArgs, asset: o.asset, approvalIx: o.approval ? APPROVAL_IX_INDEX : null } });
  };

  it('every single lock is a legacy transaction of the documented size', () => {
    expect(size(taker, [lock({ asset: 0 })])).toMatchObject({ keys: 9, bytes: 683 });
    expect(size(taker, [lock({ asset: 1 })])).toMatchObject({ keys: 13, bytes: 811 });
    // SPEC 4.10 lists 15 keys and 875 bytes here; with "exactly one of offer and quote" present (SPEC 4.4,
    // frozen IDL) the offer key is absent, so the real figure is one key (32 bytes) less. See DEVIATIONS.md.
    expect(size(taker, [lock({ asset: 1, quote: true })])).toMatchObject({ keys: 14, bytes: 843 });
    expect(size(taker, [approval(), lock({ asset: 0, approval: true })])).toMatchObject({ keys: 11, bytes: 1054 });
    // The largest single-swap transaction.
    const largest = size(taker, [approval(), lock({ asset: 1, approval: true })]);
    expect(largest).toMatchObject({ keys: 15, bytes: 1182 });
    expect(assertFits(largest.tx)).toBe(1182);
    // The approval's Ed25519 instruction sits right after the compute-budget pair, where approval_ix points.
    expect(largest.tx.instructions[APPROVAL_IX_INDEX]!.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    expect(largest.tx.instructions.slice(0, 2).every((i) => i.programId.equals(ComputeBudgetProgram.programId))).toBe(true);
    // take is 33 bytes smaller than lock.
    expect(size(taker, [program.take({ taker, maker, sessionKey: session, source: { offer: true }, args: takeArgs })]).bytes).toBe(683 - 33);
  });

  it('batches: two SOL legs fit, two USDC legs do not, and two fit a v0 transaction with the lookup table', () => {
    const m2 = makerPda(PROGRAM, key());
    const s2 = key();
    const args2 = { ...lockArgs, swapNonce: r.bytes(16) };
    const second = (asset: number) => program.lock({ taker, maker: m2, sessionKey: s2, source: { offer: true }, args: { ...args2, asset } });
    expect(size(taker, [lock({ asset: 0 }), second(0)])).toMatchObject({ keys: 13, bytes: 1084 });
    const twoUsdc = legacyTransaction({ payer: taker, blockhash: BLOCKHASH, instructions: [lock({ asset: 1 }), second(1)], cuLimit: 400_000, cuPrice: 1 });
    expect(twoUsdc.compileMessage().accountKeys.length).toBe(18);
    expect(codeOf(() => assertFits(twoUsdc))).toBe('TransactionTooLarge');
    // Three SOL legs never fit.
    const third = program.lock({ taker, maker: makerPda(PROGRAM, key()), sessionKey: key(), source: { offer: true }, args: { ...lockArgs, swapNonce: r.bytes(16) } });
    expect(codeOf(() => assertFits(legacyTransaction({ payer: taker, blockhash: BLOCKHASH, instructions: [lock({ asset: 0 }), second(0), third], cuLimit: 600_000 })))).toBe('TransactionTooLarge');
    // v0 with config, the System program, the USDC mint and the Token program loaded from the protocol lookup table.
    const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [configPda(PROGRAM), SystemProgram.programId, USDC, TOKEN_PROGRAM_ID] } });
    const v0 = v0Transaction({ payer: taker, blockhash: BLOCKHASH, instructions: [lock({ asset: 1 }), second(1)], cuLimit: 400_000, cuPrice: 1 }, [table]);
    expect(v0.message.staticAccountKeys.length).toBe(14);
    expect(wireSize(v0)).toBe(1156);
    expect(assertFits(v0)).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it('the other documented transactions', () => {
    const ctx: SettleContext = { swap, taker, maker, operator, payout, asset: 1, direction: 0 };
    expect(size(operator, [program.claim(operator, ctx, r.bytes(32))])).toMatchObject({ keys: 16, bytes: 691 });
    const offers = [0, 1].flatMap((asset) => [0, 1].map((direction) => ({ asset, direction, enabled: true, prices: [1n, 2n, 3n], capacityXmr: 9n })));
    const eth = [0, 1, 2, 3].map((slot) => ({ slot, tierPrice: [1n, 2n, 3n], validUntil: 5n, quoteId: 6n, sig: r.bytes(65) }));
    expect(size(operator, [program.refreshOffers(operator, maker, offers, eth)])).toMatchObject({ keys: 9, bytes: 1097 });
    const slots = Array.from({ length: 8 }, (_, index) => ({ index, share: r.bytes(32), pok: r.bytes(64) }));
    expect(size(operator, [program.refillKeys(operator, maker, 0, slots)])).toMatchObject({ keys: 5, bytes: 1078 });
    expect(size(taker, [program.postMessage(taker, maker, r.bytes(900), swap)])).toMatchObject({ keys: 5, bytes: 1201 });
  });

  it('packs legs by the batching rule', () => {
    const sol = { asset: 0, approval: false };
    const usdc = { asset: 1, approval: false };
    expect(packLegs([sol, sol, sol, sol, sol])).toEqual([[0, 1], [2, 3], [4]]);
    expect(packLegs([usdc, usdc, usdc])).toEqual([[0], [1], [2]]);
    expect(packLegs([usdc, usdc, usdc], { lookupTable: true })).toEqual([[0, 1], [2]]);
    // A leg that uses an advance approval travels alone.
    expect(packLegs([sol, { asset: 0, approval: true }, sol, sol])).toEqual([[0, 2], [1], [3]]);
    expect(packLegs([])).toEqual([]);
    expect(cuLimitFromSimulation(20_000)).toBe(24_000);
    expect(cuLimitFromSimulation(14_601)).toBe(17_522);
  });
});

// ------------------------------------------------------------------ client over an injected transport

const z = (n: number) => new Uint8Array(n);
function makerAccount(over: Partial<Maker> = {}): Maker {
  return {
    owner: owner.toBase58(), operator: operator.toBase58(), payout: payout.toBase58(), encKey: z(32).fill(1), encKeyVersion: 2, prevEncKey: z(32).fill(2), prevEncKeyExpiresAt: 0n,
    approvalEpoch: 1, quoteEpoch: 1, paused: 0, inboxPolicy: 0, openPending: 0, registeredSlot: 1n, registeredAt: 2n, ethLink: z(20), ethLinkNext: z(20), ethLinkNextAt: 0n,
    counters: new Array(40).fill(0), responseSecsSum: 0n, volume: [0n, 0n], withheldVolume: [0n, 0n], bump: 255, onion: '', contacts: [], ...over,
  };
}
function swapAccount(over: Partial<Swap> = {}): Swap {
  return {
    taker: taker.toBase58(), maker: maker.toBase58(), state: 2, direction: 0, asset: 0, mode: 0, outcome: 255, depositState: 0, depth: 10, flags: 0, bump: 254, vaultBump: 0, swapNonce: nonce, sessionKey: session.toBase58(),
    takerEncKey: z(32), makerEncVersion: 2, makerEncKey: z(32), amount: 1_500_000_000n, deposit: 15_000_000n, xmr: 10n ** 13n, price: 150_000_000n, depBps: 100, feeBps: 5, wN: 600, dC: 5400, wC: 1800,
    takerSpendPub: z(32), makerSpendPub: z(32), lockerView: z(32), noticeCommitment: z(32), noticeCt: z(104), evidenceTxid: z(32), evidenceView: z(32), revealed: z(32),
    tLock: 1_800_000_000n, tPendingDeadline: 0n, tActive: 1_800_000_000n, tNoteDeadline: 1_800_000_600n, tNotice: 0n, tCut: 0n, tClaimOpen: 0n, tReady: 0n, tClaimDeadline: 0n, tFinal: 1_800_604_800n, tRefund: 0n, tSettled: 0n,
    owedTaker: 0n, owedMaker: 0n, owedTreasury: 0n, reserved: z(42), ...over,
  };
}

describe('SolanaClient over a fake transport', () => {
  const P = PROGRAM.toBase58();
  const setup = (subscriptions = true) => {
    const fake = new FakeSolana({ subscriptions });
    const client = new SolanaClient({ transport: fake, programId: PROGRAM, usdcMint: USDC });
    fake.setAccount(maker.toBase58(), P, encodeAccount('Maker', makerAccount(), ACCOUNT_SIZE.Maker));
    fake.setAccount(swap.toBase58(), P, encodeAccount('Swap', swapAccount(), ACCOUNT_SIZE.Swap));
    return { fake, client };
  };

  it('reads chain time from the Clock sysvar and checks the genesis hash', async () => {
    const { fake, client } = setup();
    fake.setClock(1_800_000_123n);
    expect(await client.chainTime()).toBe(1_800_000_123n);
    await client.verifyGenesis(fake.genesis);
    await expect(client.verifyGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).rejects.toMatchObject({ code: 'WrongCluster' });
    fake.accounts.delete(CLOCK_SYSVAR);
    await expect(client.chainTime()).rejects.toMatchObject({ code: 'NoClock' });
  });

  it('reads accounts through the frozen codecs and refuses a foreign owner', async () => {
    const { fake, client } = setup();
    expect((await client.getMaker(maker))?.operator).toBe(operator.toBase58());
    expect((await client.getMakerByOwner(owner))?.payout).toBe(payout.toBase58());
    const view = await client.getSwap(swap);
    expect(view).toMatchObject({ chain: 'solana', state: 2, direction: 0, asset: '0', amount: 1_500_000_000n, tNoteDeadline: 1_800_000_600n, taker: taker.toBase58() });
    expect(hex(view!.swapRef)).toBe(hex(swap.toBytes()));
    // No notice on record: the 104 stored zero bytes are not a ciphertext.
    expect(view!.noticeCt.length).toBe(0);
    expect(await client.getSwap(key())).toBe(null);
    expect(await client.getOffer(maker, 0, 0)).toBe(null);
    fake.setAccount(swap.toBase58(), key().toBase58(), encodeAccount('Swap', swapAccount(), ACCOUNT_SIZE.Swap));
    await expect(client.getSwap(swap)).rejects.toMatchObject({ code: 'WrongOwner' });
    // A Maker account read as a Swap is refused by its discriminator.
    await expect(client.getSwapAccount(maker)).rejects.toThrow(/not a Swap account/);
  });

  it('lists with the memcmp filters of SPEC 4.2 and re-checks what the node returns', async () => {
    const { fake, client } = setup();
    const otherTaker = key();
    const otherMaker = makerPda(PROGRAM, key());
    const add = (over: Partial<Swap>) => {
      const pda = key().toBase58();
      fake.setAccount(pda, P, encodeAccount('Swap', swapAccount(over), ACCOUNT_SIZE.Swap));
      return pda;
    };
    add({ taker: otherTaker.toBase58(), state: 3 });
    add({ maker: otherMaker.toBase58(), state: 4 });
    add({ state: 9 });
    expect((await client.listSwapsByTaker(taker)).length).toBe(3);
    expect((await client.listSwapsByTaker(otherTaker)).map((s) => s.state)).toEqual([3]);
    expect((await client.listSwapsByMaker(maker)).length).toBe(3);
    expect((await client.listSwapsByMaker(maker, 9)).map((s) => s.state)).toEqual([9]);
    expect((await client.listSwapsByMaker(otherMaker, 2)).length).toBe(0);
    expect((await client.listMakers()).map((m) => m.pubkey)).toEqual([maker.toBase58()]);
    const offer = { maker: maker.toBase58(), asset: 1, direction: 0, enabled: 1, mode: 0, bump: 1, seq: 1n, updatedAt: 0n, validSecs: 60, minXmr: 0n, maxXmr: 1n, capacityXmr: 1n, priceAbove: [0n, 0n, 0n], prices: [1n, 0n, 0n], depthAbove: [0n, 0n, 0n], depths: Uint8Array.of(2, 0, 0), depBps: 0, wA: 60, wN: 600, dC: 5400, wC: 1800, wF: 604800, termsHash: z(32), poolFilled: 0, poolUsed: 0, pool: Array.from({ length: 16 }, () => z(32)), reserved: z(34) } as Offer;
    fake.setAccount(offerPda(PROGRAM, maker, 1, 0).toBase58(), P, encodeAccount('Offer', offer, ACCOUNT_SIZE.Offer));
    expect((await client.listOffers(maker)).length).toBe(1);
    expect((await client.listOffers(otherMaker)).length).toBe(0);
    expect((await client.getOffer(maker, 1, 0))?.asset).toBe(1);
    // The frozen discriminators are what clients filter on.
    expect(base58Encode(encodeAccount('Maker', makerAccount()).subarray(0, 8))).toBe(DISCRIMINATOR_BASE58.Maker);
    expect(base58Encode(encodeAccount('Swap', swapAccount()).subarray(0, 8))).toBe(DISCRIMINATOR_BASE58.Swap);
    // A node that ignores the filters cannot smuggle in another account type.
    fake.getProgramAccounts = async () => [...fake.accounts.values()];
    expect((await client.listMakers()).length).toBe(1);
    expect((await client.listSwapsByTaker(otherTaker)).length).toBe(1);
    expect(matchesFilters(z(10), [{ dataSize: 10 }, { memcmp: { offset: 8, bytes: base58Encode(z(4)) } }])).toBe(false);
  });

  it('prepare simulates first and sets the compute limit to simulation × 1.2', async () => {
    const { fake, client } = setup();
    fake.onSimulate = () => ({ err: null, logs: [], unitsConsumed: 23_600 });
    const signer = seedSigner(r.bytes(32));
    const ix = program.setReady({ caller: signer.publicKey, swap, maker });
    const tx = await client.prepare(signer.publicKey, [ix], { cuPrice: 5 });
    expect(fake.simulated.length).toBe(1);
    expect(fake.sent.length).toBe(0);
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 28_320 });
    expect(hex(tx.instructions[0]!.data)).toBe(hex(limit.data));
    expect(hex(tx.instructions[1]!.data)).toBe(hex(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }).data));
    expect(tx.instructions.length).toBe(3);
    const sig = await client.signAndSend(tx, [signer]);
    expect(sig).toBe('sig0');
    // What went on the wire is a fully signed legacy transaction paid by the signer.
    const sent = Transaction.from(fake.sent[0]!);
    expect(sent.verifySignatures()).toBe(true);
    expect(sent.feePayer!.toBase58()).toBe(signer.publicKey);
    expect(seedSigner(unhex(vector('keys').cases[0].output.session_secret)).publicKey).toBe(base58Encode(unhex(vector('keys').cases[0].output.session_pub)));
  });

  it('never broadcasts a transaction whose simulation fails', async () => {
    const { fake, client } = setup();
    fake.onSimulate = () => ({ err: { InstructionError: [2, { Custom: errorCode('TooLate') }] }, logs: ['Program log: AnchorError'], unitsConsumed: 900 });
    const signer = seedSigner(r.bytes(32));
    const secret = r.bytes(32);
    const refund = program.refund(signer.publicKey, { swap, taker, maker, operator, payout, asset: 0, direction: 0 }, secret);
    const err = await client.send([refund], [signer]).catch((e) => e);
    expect(err).toBeInstanceOf(ProgramError);
    expect(err.code).toBe('TooLate');
    expect(err.logs).toEqual(['Program log: AnchorError']);
    // The secret never left the process.
    expect(fake.sent.length).toBe(0);
    expect(fake.calls.send ?? 0).toBe(0);
    expect(programErrorName({ InstructionError: [0, { Custom: errorCode('ScalarMismatch') }] })).toBe('ScalarMismatch');
    expect(programErrorName({ InstructionError: [0, 'InvalidAccountData'] })).toBe(null);
    expect(programErrorName('BlockhashNotFound')).toBe(null);
    // A missing signature is caught before sending.
    fake.onSimulate = () => ({ err: null, logs: [], unitsConsumed: 1000 });
    const tx = await client.prepare(signer.publicKey, [refund]);
    await expect(client.signAndSend(tx, [])).rejects.toMatchObject({ code: 'MissingSignature' });
    await expect(client.send([refund], [])).rejects.toMatchObject({ code: 'MissingSignature' });
    expect(fake.sent.length).toBe(0);
  });

  it('reports confirmation and failure of a signature', async () => {
    const { fake, client } = setup();
    expect(await client.isConfirmed('nope')).toBe(false);
    fake.addTransaction({ signature: 'ok', slot: 5, blockTime: 1, err: null, logs: [], instructions: [] }, [maker.toBase58()]);
    expect(await client.isConfirmed('ok')).toBe(true);
    fake.addTransaction({ signature: 'bad', slot: 6, blockTime: 2, err: { InstructionError: [0, { Custom: errorCode('BadState') }] }, logs: [], instructions: [] }, [maker.toBase58()]);
    await expect(client.isConfirmed('bad')).rejects.toMatchObject({ code: 'BadState' });
  });

  it('decodes the program events of a transaction', async () => {
    const { fake, client } = setup();
    const ev = encodeEvent('Refunded', { swap: swap.toBase58(), maker: maker.toBase58(), counter: 21, at: 1_800_000_400n, secret: z(32).fill(7), depositHeld: true });
    fake.addTransaction({ signature: 'ev', slot: 9, blockTime: 3, err: null, logs: ['Program log: Instruction: Refund', `Program data: ${Buffer.from(ev).toString('base64')}`, 'Program data: not base64!!', `Program data: ${Buffer.from(r.bytes(40)).toString('base64')}`], instructions: [] }, [swap.toBase58()]);
    const events = await client.eventsOf('ev');
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ name: 'Refunded', data: { counter: 21, depositHeld: true, at: 1_800_000_400n } });
    expect(await client.eventsOf('missing')).toEqual([]);
  });

  it('lists post_message envelopes for a recipient, oldest first, from a cursor', async () => {
    const { fake, client } = setup();
    const post = (signature: string, payload: Uint8Array, opts: { err?: unknown; swap?: PublicKey; recipient?: PublicKey } = {}) => {
      const to = opts.recipient ?? maker;
      const ix = program.postMessage(taker, to, payload, opts.swap ?? null);
      fake.addTransaction({ signature, slot: 1, blockTime: 10, err: opts.err ?? null, logs: [], instructions: [{ programId: ComputeBudgetProgram.programId.toBase58(), accounts: [], data: z(5) }, { programId: P, accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: new Uint8Array(ix.data) }] }, [to.toBase58()]);
    };
    post('m1', Uint8Array.of(0x58, 0x53, 1));
    post('m2', Uint8Array.of(0x58, 0x53, 2), { swap });
    post('failed', Uint8Array.of(0x58, 0x53, 9), { err: { InstructionError: [1, { Custom: 6044 }] } });
    // Another instruction of the program that merely mentions the maker is not a message.
    const other = program.setReady({ caller: operator, swap, maker });
    fake.addTransaction({ signature: 'other', slot: 2, blockTime: 11, err: null, logs: [], instructions: [{ programId: P, accounts: other.keys.map((k) => k.pubkey.toBase58()), data: new Uint8Array(other.data) }] }, [maker.toBase58()]);
    post('m3', Uint8Array.of(0x58, 0x53, 3));
    const all = await client.listMessages(maker);
    expect(all.map((m) => [m.signature, m.payload[2], m.swap])).toEqual([['m1', 1, null], ['m2', 2, swap.toBase58()], ['m3', 3, null]]);
    expect(all[0]).toMatchObject({ sender: taker.toBase58(), recipient: maker.toBase58() });
    expect((await client.listMessages(maker, { until: 'm2' })).map((m) => m.signature)).toEqual(['m3']);
    expect(await client.listMessages(taker)).toEqual([]);

    // The watcher delivers each message once and keeps its cursor.
    const seen: string[] = [];
    const w = client.watchMessages(maker, (m) => seen.push(m.signature), 'm1');
    await w.poll();
    expect(seen).toEqual(['m2', 'm3']);
    post('m4', Uint8Array.of(0x58, 0x53, 4));
    await w.poll();
    expect(seen).toEqual(['m2', 'm3', 'm4']);
    expect(w.cursor).toBe('m4');
  });

  it('SwapWatcher: reports new, changed and closed swaps; an unchanged account is silent', async () => {
    const { fake, client } = setup(false);
    expect(client.subscriptions).toBe(false);
    const changes: [string, number | null, number | null][] = [];
    const w = client.watchSwaps({ maker }, (c) => changes.push([c.pubkey, c.swap?.state ?? null, c.previous?.state ?? null]));
    await w.poll();
    expect(changes).toEqual([[swap.toBase58(), 2, null]]);
    await w.poll();
    expect(changes.length).toBe(1);
    fake.setAccount(swap.toBase58(), P, encodeAccount('Swap', swapAccount({ state: 3, tNotice: 1_800_000_090n, flags: 1 }), ACCOUNT_SIZE.Swap));
    // A swap of another maker is not this watcher's business.
    fake.setAccount(key().toBase58(), P, encodeAccount('Swap', swapAccount({ maker: makerPda(PROGRAM, key()).toBase58() }), ACCOUNT_SIZE.Swap));
    await w.poll();
    expect(changes[1]).toEqual([swap.toBase58(), 3, 2]);
    // A "closed" row closes the account: it is reported once, with no swap.
    fake.deleteAccount(swap.toBase58());
    await w.poll();
    await w.poll();
    expect(changes.slice(2)).toEqual([[swap.toBase58(), null, 3]]);
    // The taker's watcher uses the other filter.
    const mine: string[] = [];
    await client.watchSwaps({ taker }, (c) => mine.push(c.pubkey)).poll();
    expect(mine.length).toBe(1);
  });

  it('SwapWatcher: a pushed change triggers a finalized re-read; without subscriptions it only polls', async () => {
    const { fake, client } = setup(true);
    expect(client.subscriptions).toBe(true);
    const states: (number | null)[] = [];
    const w = client.watchSwaps({ maker }, (c) => states.push(c.swap?.state ?? null));
    w.start(3_600_000);
    await new Promise((res) => setTimeout(res, 5));
    expect(states).toEqual([2]);
    const before = fake.calls.getProgramAccounts!;
    fake.setAccount(swap.toBase58(), P, encodeAccount('Swap', swapAccount({ state: 4 }), ACCOUNT_SIZE.Swap));
    await new Promise((res) => setTimeout(res, 5));
    // The push carried no state the watcher trusted: it polled again and reported what it read.
    expect(fake.calls.getProgramAccounts!).toBeGreaterThan(before);
    expect(states).toEqual([2, 4]);
    w.stop();
    fake.setAccount(swap.toBase58(), P, encodeAccount('Swap', swapAccount({ state: 9 }), ACCOUNT_SIZE.Swap));
    await new Promise((res) => setTimeout(res, 5));
    expect(states).toEqual([2, 4]);

    // subscriptions: false on a transport that could subscribe: the client still only polls.
    const polled = new SolanaClient({ transport: fake, programId: PROGRAM, subscriptions: false });
    expect(polled.subscriptions).toBe(false);
    const seen: (number | null)[] = [];
    const pw = polled.watchSwaps({ maker }, (c) => seen.push(c.swap?.state ?? null));
    pw.start(3_600_000);
    await new Promise((res) => setTimeout(res, 5));
    fake.setAccount(swap.toBase58(), P, encodeAccount('Swap', swapAccount({ state: 7 }), ACCOUNT_SIZE.Swap));
    await new Promise((res) => setTimeout(res, 5));
    expect(seen).toEqual([9]);
    await pw.poll();
    expect(seen).toEqual([9, 7]);
    pw.stop();
  });

  it('the encoded instruction data is what the frozen codec produces', () => {
    const ix = program.lock({ taker, maker, sessionKey: session, source: { offer: true }, args: lockArgs });
    expect(hex(ix.data)).toBe(hex(encodeInstructionData('lock', { args: lockArgs })));
    expect(Keypair.fromSeed(z(32).fill(1)).publicKey.toBase58()).toBe(seedSigner(z(32).fill(1)).publicKey);
  });
});
