/**
 * Instruction-encoding tests for the wXMR bridge. The expected bytes and addresses below are
 * pinned to the layout assumed in BRIDGE-ASSUMPTIONS.md (from docs/research/local-assets.md);
 * `bridge-idl.test.ts` compares the same layout with the owner-supplied IDL once it exists.
 */
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, BRIDGE_PROGRAM_ID, TOKEN_PROGRAM_ID, WXMR_MINT, accountDiscriminator, associatedTokenAddress, bridgePdas, cancelWithdrawalIx,
  checkReserve, createAtaIdempotentIx, createDepositAccountIx, decodeAuditRecord, decodeBridgeConfig, decodeDepositRecord, decodeFeeOverride, decodeTokenAmount,
  decodeUpgradeAuthority, decodeWithdrawalRecord, decodeWithdrawalState, eventDiscriminator, heartbeatOnline, instructionDiscriminator, nextWithdrawalNonce,
  parseBridgeEvents, parseReserveReport, readHeartbeat, requestWithdrawalIx, withdrawalNet,
} from '../src/index.js';
import { AUTHORITY, FakeChain, UPGRADE_AUTHORITY, WALLET, enc, reserveReport } from './bridge-helpers.js';
import { XMR_ADDR } from './helpers.js';

const P = bridgePdas();
const flags = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isWritable ? ' w' : ''}${k.isSigner ? ' s' : ''}`);

describe('discriminators', () => {
  it('instructions are sha256("global:<name>")[..8]', () => {
    expect(instructionDiscriminator('request_withdrawal').toString('hex')).toBe('fb5579cd38c90cb1');
    expect(instructionDiscriminator('cancel_withdrawal').toString('hex')).toBe('b768b5fa1c80d246');
    expect(instructionDiscriminator('create_deposit_account').toString('hex')).toBe('19d952cf16967ab5');
    expect(instructionDiscriminator('request_withdrawal')).toEqual(createHash('sha256').update('global:request_withdrawal').digest().subarray(0, 8));
  });
  it('accounts and events use the "account:" and "event:" prefixes', () => {
    expect(accountDiscriminator('WithdrawalRecord').toString('hex')).toBe('583b9acad8d2d3ed');
    expect(accountDiscriminator('Heartbeat').toString('hex')).toBe('6ab4d833b0744331');
    expect(eventDiscriminator('WithdrawCompletedEvent').toString('hex')).toBe('c0a228c5535ec642');
  });
});

describe('PDAs', () => {
  it('derive from the documented seeds under the bridge program', () => {
    expect(BRIDGE_PROGRAM_ID.toBase58()).toBe('EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8');
    expect(P.config().toBase58()).toBe('2yy692W8JX511d63i5BdKHqULJCnQyBYrfnkavnzjZuE');
    expect(P.feeTreasury().toBase58()).toBe('B1Q1KYGKDJLd1QRVsSCM8afWjDGffB4YRVzM4Uiny2V4');
    expect(P.feeOverride(WALLET).toBase58()).toBe('8ySewPy6bt4GqGdZsanag7RTPxJSMSxjdFbqsKPJkAPe');
    expect(P.deposit(WALLET).toBase58()).toBe('HxS93yfTfR4rwRYszRpyKjPWFezSzeTGrKoU3KVtWgJA');
    expect(P.withdrawal(WALLET, 1_800_000_000_000n).toBase58()).toBe('5hMvo38NySrCKeBwSDXUhbEyThRz6fGq9uABhiMqJ55N');
    expect(P.withdrawalState(WALLET).toBase58()).toBe('HdaNtu3kSdrT5KosNk1zRYCeRW6hcn1RcNCrtoBisVYB');
    expect(P.heartbeat().toBase58()).toBe('5aMKuHX4YWVK33BgGLbGhwz53J5b4gh2mmgoVBnK6Xc5');
    expect(P.heartbeatPage(7n, 1).toBase58()).toBe('3YktXYQdnDaDH2uoWNvK2Gqm1nnh3ChWTtWXoJnLydZx');
    expect(P.audit(1_790_000_000_000n).toBase58()).toBe('4jGybBKFxUGseCVe3BNmyrrxgdGqbgzdMpprDKYAseNi');
    expect(associatedTokenAddress(WALLET, WXMR_MINT).toBase58()).toBe('6hrrje6VzJKbcEPGrVKFPhziKx3afBnBbTaSSFfd2fiZ');
  });
  it('the withdrawal PDA depends on the nonce (u64 LE) and the heartbeat page on generation parity and index (u16 LE)', () => {
    expect(P.withdrawal(WALLET, 1n).equals(P.withdrawal(WALLET, 256n))).toBe(false);
    const manual = PublicKey.findProgramAddressSync([Buffer.from('withdrawal'), WALLET.toBuffer(), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0])], BRIDGE_PROGRAM_ID)[0];
    expect(P.withdrawal(WALLET, 256n).equals(manual)).toBe(true);
    expect(P.heartbeatPage(7n, 1).equals(P.heartbeatPage(9n, 1))).toBe(true);
    expect(P.heartbeatPage(7n, 1).equals(P.heartbeatPage(8n, 1))).toBe(false);
    const page = PublicKey.findProgramAddressSync([Buffer.from('heartbeat-page'), Buffer.from([0]), Buffer.from([2, 1])], BRIDGE_PROGRAM_ID)[0];
    expect(P.heartbeatPage(8n, 258).equals(page)).toBe(true);
  });
});

describe('request_withdrawal', () => {
  const ix = requestWithdrawalIx({ user: WALLET, nonce: 1_800_000_000_000n, amount: 996_000_000_000n, xmrAddress: XMR_ADDR, exactOut: false });

  it('encodes discriminator, nonce u64 LE, amount u64 LE, Borsh string, bool', () => {
    expect(ix.programId.equals(BRIDGE_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ix.data).toString('hex')).toBe(
      'fb5579cd38c90cb1' + '00505c18a3010000' + '00e839e6e7000000' + '5f000000' + Buffer.from(XMR_ADDR).toString('hex') + '00');
    const exact = requestWithdrawalIx({ user: WALLET, nonce: 1n, amount: 100_000_000_000n, xmrAddress: XMR_ADDR, exactOut: true });
    expect(Buffer.from(exact.data).at(-1)).toBe(1);
  });

  it('lists the ten accounts in program order with the right signer and writable flags', () => {
    expect(flags(ix)).toEqual([
      P.config().toBase58(),
      P.withdrawal(WALLET, 1_800_000_000_000n).toBase58() + ' w',
      WXMR_MINT.toBase58() + ' w',
      associatedTokenAddress(WALLET, WXMR_MINT).toBase58() + ' w',
      P.feeTreasury().toBase58() + ' w',
      P.feeOverride(WALLET).toBase58(),
      WALLET.toBase58() + ' w s',
      TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
      P.withdrawalState(WALLET).toBase58() + ' w',
    ]);
  });

  it('refuses an amount under 0.1 XMR and a string that is not address-shaped', () => {
    expect(() => requestWithdrawalIx({ user: WALLET, nonce: 1n, amount: 99_999_999_999n, xmrAddress: XMR_ADDR, exactOut: false })).toThrow(/0\.1 XMR/);
    expect(() => requestWithdrawalIx({ user: WALLET, nonce: 1n, amount: 100_000_000_000n, xmrAddress: 'not-an-address', exactOut: false })).toThrow(/Monero address/);
  });

  it('nonce is max(last + 1, now in ms)', () => {
    expect(nextWithdrawalNonce(0n, 1_800_000_000)).toBe(1_800_000_000_000n);
    expect(nextWithdrawalNonce(1_800_000_000_000n, 1_800_000_000)).toBe(1_800_000_000_001n);
    expect(nextWithdrawalNonce(1_900_000_000_000n, 1_800_000_000)).toBe(1_900_000_000_001n);
  });

  it('fee-inclusive net: fee = amount * bps / 10000, rounded down', () => {
    expect(withdrawalNet(996_000_000_000n, 10)).toEqual({ fee: 996_000_000n, net: 995_004_000_000n });
    expect(withdrawalNet(999n, 10)).toEqual({ fee: 0n, net: 999n });
    expect(withdrawalNet(1_000_000_000_000n, 0)).toEqual({ fee: 0n, net: 1_000_000_000_000n });
  });
});

describe('cancel_withdrawal and create_deposit_account', () => {
  it('cancel: no arguments, ten accounts in program order', () => {
    const ix = cancelWithdrawalIx({ user: WALLET, nonce: 1_800_000_000_000n, authority: AUTHORITY });
    expect(Buffer.from(ix.data).toString('hex')).toBe('b768b5fa1c80d246');
    expect(flags(ix)).toEqual([
      P.config().toBase58(),
      P.withdrawal(WALLET, 1_800_000_000_000n).toBase58() + ' w',
      WXMR_MINT.toBase58() + ' w',
      associatedTokenAddress(WALLET, WXMR_MINT).toBase58() + ' w',
      WALLET.toBase58() + ' w s',
      AUTHORITY.toBase58() + ' w',
      P.withdrawalState(WALLET).toBase58() + ' w',
      TOKEN_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
  });

  it('create_deposit_account: no arguments, four accounts', () => {
    const ix = createDepositAccountIx(WALLET);
    expect(Buffer.from(ix.data).toString('hex')).toBe('19d952cf16967ab5');
    expect(flags(ix)).toEqual([P.config().toBase58(), P.deposit(WALLET).toBase58() + ' w', WALLET.toBase58() + ' w s', SystemProgram.programId.toBase58()]);
  });

  it('the token account is created with the ATA program\'s idempotent instruction', () => {
    const ix = createAtaIdempotentIx(WALLET, WALLET, WXMR_MINT);
    expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect([...ix.data]).toEqual([1]);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([WALLET.toBase58(), associatedTokenAddress(WALLET, WXMR_MINT).toBase58(), WALLET.toBase58(), WXMR_MINT.toBase58(), SystemProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58()]);
  });
});

describe('account decoders', () => {
  it('BridgeConfig, including one created before fee_bps existed', () => {
    expect(decodeBridgeConfig(enc.config({ feeBps: 25 }))).toEqual({ authority: AUTHORITY.toBase58(), wxmrMint: WXMR_MINT.toBase58(), totalDeposits: 123n, totalWithdrawals: 45n, feeBps: 25 });
    expect(decodeBridgeConfig(enc.config({ feeBps: null })).feeBps).toBe(0);
  });
  it('FeeOverride, UserWithdrawalState', () => {
    expect(decodeFeeOverride(enc.feeOverride(WALLET, 3))).toEqual({ user: WALLET.toBase58(), feeBps: 3 });
    expect(decodeWithdrawalState(enc.withdrawalState(WALLET, 77n))).toEqual({ user: WALLET.toBase58(), lastNonce: 77n });
  });
  it('DepositRecord and WithdrawalRecord, with their status enums', () => {
    expect(decodeDepositRecord(enc.deposit({ owner: WALLET, address: XMR_ADDR, total: 5n, status: 1 }))).toEqual({ owner: WALLET.toBase58(), xmrDepositAddress: XMR_ADDR, totalDeposited: 5n, status: 'Active', createdAt: 1_790_000_000 });
    expect(decodeDepositRecord(enc.deposit({ owner: WALLET, address: '', total: 0n, status: 0 })).status).toBe('Pending');
    const w = decodeWithdrawalRecord(enc.withdrawal({ user: WALLET, nonce: 9n, amount: 995n, address: XMR_ADDR, status: 1, createdAt: 1_800_000_000, fee: 1n }));
    expect(w).toEqual({ user: WALLET.toBase58(), nonce: 9n, amount: 995n, xmrAddress: XMR_ADDR, exactOut: false, status: 'Sending', createdAt: 1_800_000_000, fee: 1n });
  });
  it('rejects an account of the wrong type, owner or length', () => {
    expect(() => decodeWithdrawalRecord(enc.deposit({ owner: WALLET, address: '', total: 0n, status: 0 }))).toThrow(/discriminator/);
    expect(() => decodeBridgeConfig({ ...enc.config(), owner: TOKEN_PROGRAM_ID.toBase58() })).toThrow(/not owned by the bridge program/);
    const cut = enc.withdrawalState(WALLET, 1n);
    expect(() => decodeWithdrawalState({ ...cut, data: cut.data.slice(0, 20) })).toThrow(/shorter/);
  });
  it('token account amount, and the upgrade authority from ProgramData', () => {
    expect(decodeTokenAmount(enc.token(WXMR_MINT, WALLET, 42n))).toEqual({ mint: WXMR_MINT.toBase58(), owner: WALLET.toBase58(), amount: 42n });
    expect(decodeUpgradeAuthority(enc.programData(UPGRADE_AUTHORITY))).toBe(UPGRADE_AUTHORITY.toBase58());
    expect(decodeUpgradeAuthority(enc.programData(null))).toBeNull();
    expect(() => decodeUpgradeAuthority(enc.config())).toThrow(/ProgramData/);
  });
});

describe('events', () => {
  it('finds completion and reversal events among ordinary log lines', () => {
    const pda = P.withdrawal(WALLET, 5n);
    const logs = [
      'Program EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8 invoke [1]', 'Program log: Instruction: CompleteWithdrawal',
      enc.completedEvent({ pda, user: WALLET, amount: 995n, address: XMR_ADDR, txHash: 'ab'.repeat(32), txKey: 'cd'.repeat(32) }),
      'Program data: AAAA', 'Program data: ' + Buffer.alloc(40, 7).toString('base64'),
      enc.revertedEvent({ pda, user: WALLET, amount: 995n, fee: 1n, reason: 'address rejected' }),
    ];
    expect(parseBridgeEvents(logs)).toEqual([
      { kind: 'completed', withdrawalPda: pda.toBase58(), user: WALLET.toBase58(), amount: 995n, xmrAddress: XMR_ADDR, xmrTxHash: 'ab'.repeat(32), xmrTxKey: 'cd'.repeat(32) },
      { kind: 'reverted', withdrawalPda: pda.toBase58(), user: WALLET.toBase58(), amount: 995n, fee: 1n, reason: 'address rejected' },
    ]);
  });
});

describe('heartbeat', () => {
  const NOW = 1_800_000_000;
  it('reads a multi-page heartbeat: both clocks, payout capacity, reserve pointer', async () => {
    const chain = new FakeChain();
    const reserve = { account: P.audit(1_790_000_000_000n).toBase58(), id: 1_790_000_000_000 };
    chain.setHeartbeat({ updatedAt: NOW - 100, observedAt: NOW - 120, unlocked: 55_000_000_000_000n, latestReserve: reserve, padBytes: 2500 });
    expect([...chain.accounts.keys()].filter((k) => k === P.heartbeatPage(7n, 2).toBase58())).toHaveLength(1);
    const hb = await readHeartbeat(chain);
    expect(hb).toMatchObject({ generation: 7n, updatedAt: NOW - 100, observedAt: NOW - 120, unlockedAtomic: 55_000_000_000_000n, latestReserve: reserve });
    expect(heartbeatOnline(hb!, NOW)).toBe(true);
  });
  it('is offline when either clock is older than 360 s, or implausibly ahead', async () => {
    const hb = { generation: 1n, updatedAt: NOW - 100, observedAt: NOW - 361, moneroHeight: 1, balanceAtomic: 1n, unlockedAtomic: 1n, latestReserve: null };
    expect(heartbeatOnline(hb, NOW)).toBe(false);
    expect(heartbeatOnline({ ...hb, observedAt: NOW - 360 }, NOW)).toBe(true);
    expect(heartbeatOnline({ ...hb, observedAt: NOW - 10, updatedAt: NOW - 361 }, NOW)).toBe(false);
    expect(heartbeatOnline({ ...hb, observedAt: NOW + 31 }, NOW)).toBe(false);
  });
  it('rejects a digest mismatch, a page from another generation, a missing page and a foreign format', async () => {
    const chain = new FakeChain();
    chain.setHeartbeat({ updatedAt: NOW, padBytes: 1500 });
    const page0 = P.heartbeatPage(7n, 0).toBase58();
    const good = chain.accounts.get(page0)!;
    const tampered = Buffer.from(good.data); tampered[40] = tampered[40]! ^ 0xff;
    chain.accounts.set(page0, { ...good, data: new Uint8Array(tampered) });
    await expect(readHeartbeat(chain)).rejects.toThrow(/digest mismatch/);
    chain.accounts.set(page0, enc.heartbeatPage(5n, 0, Buffer.from('old')));
    await expect(readHeartbeat(chain)).rejects.toThrow(/being rewritten/);
    chain.accounts.delete(page0);
    await expect(readHeartbeat(chain)).rejects.toThrow(/page is missing/);
    chain.setHeartbeat({ updatedAt: NOW, format: 'something-else' });
    await expect(readHeartbeat(chain)).rejects.toThrow(/invalid payload/);
    const empty = new FakeChain();
    expect(await readHeartbeat(empty)).toBeNull();
  });
});

describe('reserve proof', () => {
  const NOW = 1_800_000_000;
  const id = 1_790_000_000_000;
  const report = (over: Record<string, unknown> = {}) => reserveReport(id, over);
  const setup = (data = report()) => {
    const chain = new FakeChain();
    const account = P.audit(BigInt(id)).toBase58();
    chain.accounts.set(account, enc.audit(BigInt(id), data));
    chain.setHeartbeat({ updatedAt: NOW, latestReserve: { account, id } });
    return chain;
  };
  const verifier = (good: boolean, total = 900_000_000_000_000n, spent = 0n) => {
    const calls: unknown[] = [];
    return { calls, check: async (p: unknown) => { calls.push(p); return { good, total, spent }; } };
  };

  it('parses the record and decodes the audit account', () => {
    expect(decodeAuditRecord(enc.audit(BigInt(id), 'x')).data).toBe('x');
    expect(parseReserveReport(report())).toMatchObject({ id, address: XMR_ADDR, supplyAtomic: 800_000_000_000_000n, moneroHeight: 3_499_990 });
  });
  it('refuses a record whose signed message does not bind its fields, or that names another program', () => {
    expect(() => parseReserveReport(report({ message: '{}' }))).toThrow(/does not bind/);
    expect(() => parseReserveReport(report({ id: id + 1 }))).toThrow(/does not bind/);
    const other = JSON.parse(report()); other.solana.program = TOKEN_PROGRAM_ID.toBase58();
    expect(() => parseReserveReport(JSON.stringify(other))).toThrow(/another program/);
  });
  it('passes the address, message and proof to the maker\'s node and requires the proven reserve to cover supply and the refill', async () => {
    const chain = setup();
    const hb = (await readHeartbeat(chain))!;
    const v = verifier(true);
    expect(await checkReserve(chain, v, hb, 60_000_000_000_000n)).toMatchObject({ ok: true, unspentAtomic: 900_000_000_000_000n, supplyAtomic: 800_000_000_000_000n });
    expect(v.calls).toEqual([{ address: XMR_ADDR, message: JSON.parse(report()).message, signature: 'ReserveProofV2' + 'A'.repeat(40) }]);
    expect(await checkReserve(chain, verifier(false), hb, 1n)).toMatchObject({ ok: false, reason: expect.stringContaining('does not verify') });
    expect(await checkReserve(chain, verifier(true, 700_000_000_000_000n), hb, 1n)).toMatchObject({ ok: false, reason: expect.stringContaining('smaller than the wXMR supply') });
    expect(await checkReserve(chain, verifier(true, 900_000_000_000_000n, 150_000_000_000_000n), hb, 1n)).toMatchObject({ ok: false });
  });
  it('fails closed without a proof, with a pointer to the wrong address, or with a missing record', async () => {
    const chain = setup();
    const hb = (await readHeartbeat(chain))!;
    const v = verifier(true);
    expect((await checkReserve(chain, v, { ...hb, latestReserve: null }, 1n)).ok).toBe(false);
    expect(await checkReserve(chain, v, { ...hb, latestReserve: { account: WALLET.toBase58(), id } }, 1n)).toMatchObject({ ok: false, reason: expect.stringContaining('unexpected address') });
    chain.accounts.delete(P.audit(BigInt(id)).toBase58());
    expect(await checkReserve(chain, v, hb, 1n)).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
    expect(v.calls).toEqual([]);
  });
});
