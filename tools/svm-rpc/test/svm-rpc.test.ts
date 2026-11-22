// Drives the running svm-rpc binary with the real @solana/web3.js and @solana/spl-token
// clients, over HTTP on loopback. Nothing here talks to a cluster or reads `solana config`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SendTransactionError,
  SystemProgram,
  type TokenBalance,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REAL_GENESIS_HASHES, type SvmRpc, SvmRpcClient, SvmRpcError, binaryPath, confirmSignature, sendAndConfirm, startSvmRpc } from '../src-ts/index.mjs';

const MEMO_SO = fileURLToPath(new URL('../tests/fixtures/memo.so', import.meta.url));
const START_TIME = 1_795_000_000;

let svm: SvmRpc;
let connection: Connection;

beforeAll(async () => {
  svm = await startSvmRpc();
  // No wsEndpoint is ever used: the facade has no WebSocket and these tests poll.
  connection = new Connection(svm.url, 'confirmed');
});

afterAll(async () => {
  await svm?.stop();
});

async function funded(sol = 10): Promise<Keypair> {
  const kp = Keypair.generate();
  await svm.airdrop(kp.publicKey, BigInt(sol) * BigInt(LAMPORTS_PER_SOL));
  return kp;
}

/** Builds, signs and sends a legacy transaction, then waits for it by polling. */
async function run(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: signers[0]!.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  return sendAndConfirm(connection, tx);
}

async function sendError(promise: Promise<unknown>): Promise<SendTransactionError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SendTransactionError);
  return err as SendTransactionError;
}

describe('endpoint', () => {
  it('listens on 127.0.0.1 and is not a cluster', async () => {
    expect(svm.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const genesis = await connection.getGenesisHash();
    expect(new PublicKey(genesis).toBytes()).toHaveLength(32);
    expect(Object.values(REAL_GENESIS_HASHES)).not.toContain(genesis);
    expect((await connection.getVersion())['solana-core']).toBe('4.2.2');
  });

  it('refuses any bind address but 127.0.0.1', () => {
    for (const host of ['0.0.0.0', '::', 'localhost']) {
      const res = spawnSync(binaryPath(), ['--host', host, '--port', '0'], { encoding: 'utf8', timeout: 10_000 });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('127.0.0.1 only');
      expect(res.stdout).toBe('');
    }
    expect(() => new SvmRpcClient('http://192.0.2.1:8899')).toThrow(/loopback/);
    expect(() => new SvmRpcClient('https://api.mainnet-beta.solana.com')).toThrow(/loopback/);
  });

  it('answers slot, height, epoch and rent queries', async () => {
    const slot = await connection.getSlot();
    const height = await connection.getBlockHeight();
    expect(slot).toBeGreaterThanOrEqual(300_000_000);
    expect(height).toBeLessThan(slot);
    const epoch = await connection.getEpochInfo();
    expect(epoch.absoluteSlot).toBe(slot);
    expect(epoch.blockHeight).toBe(height);
    expect(epoch.slotIndex).toBe(slot % 432_000);
    // Mainnet's rent today: 5,080 lamports per byte, 128 bytes of account overhead.
    expect(await connection.getMinimumBalanceForRentExemption(0)).toBe(128 * 5080);
    expect(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)).toBe((128 + 165) * 5080);
    expect(await connection.getRecentPrioritizationFees()).toEqual([{ slot, prioritizationFee: 0 }]);
  });

  it('names the method when one is not implemented', async () => {
    await expect(connection.getBlockProduction()).rejects.toThrow(/Method not found: getBlockProduction/);
    await expect(svm.call('svm_noSuchThing')).rejects.toBeInstanceOf(SvmRpcError);
  });
});

describe('SOL transfers', () => {
  it('moves lamports, charges the fee and reports status, transaction and history', async () => {
    const payer = await funded(10);
    const to = Keypair.generate().publicKey;
    expect(await connection.getBalance(payer.publicKey)).toBe(10 * LAMPORTS_PER_SOL);
    expect(await connection.getBalance(to)).toBe(0);
    expect(await connection.getAccountInfo(to)).toBeNull();

    const slotBefore = await connection.getSlot();
    // web3.js's own send path: it fetches the blockhash, signs and posts the transaction.
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: LAMPORTS_PER_SOL }));
    const signature = await connection.sendTransaction(tx, [payer]);
    const status = await confirmSignature(connection, signature);
    expect(status.err).toBeNull();
    expect(status.confirmationStatus).toBe('finalized');
    expect(status.slot).toBe(slotBefore);
    expect(await connection.getSlot()).toBe(slotBefore + 1);

    expect(await connection.getBalance(to)).toBe(LAMPORTS_PER_SOL);
    expect(await connection.getBalance(payer.publicKey)).toBe(9 * LAMPORTS_PER_SOL - 5000);
    const info = await connection.getAccountInfo(to);
    expect(info?.owner.equals(SystemProgram.programId)).toBe(true);
    expect(info?.lamports).toBe(LAMPORTS_PER_SOL);
    expect(info?.data).toHaveLength(0);

    const got = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    expect(got?.slot).toBe(slotBefore);
    expect(got?.blockTime).toBe(await connection.getBlockTime(slotBefore));
    expect(got?.version).toBe('legacy');
    expect(got?.meta?.err).toBeNull();
    expect(got?.meta?.fee).toBe(5000);
    expect(got?.meta?.preBalances.slice(0, 2)).toEqual([10 * LAMPORTS_PER_SOL, 0]);
    expect(got?.meta?.postBalances.slice(0, 2)).toEqual([9 * LAMPORTS_PER_SOL - 5000, LAMPORTS_PER_SOL]);
    expect(got?.meta?.logMessages).toEqual([`Program ${SystemProgram.programId} invoke [1]`, `Program ${SystemProgram.programId} success`]);
    expect(got?.transaction.signatures[0]).toBe(signature);
    expect(got?.transaction.message.staticAccountKeys[0]?.equals(payer.publicKey)).toBe(true);

    const second = await run([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1 })], [payer]);
    const history = await connection.getSignaturesForAddress(to);
    expect(history.map((h) => h.signature)).toEqual([second, signature]);
    expect(history[1]?.slot).toBe(slotBefore);
    expect(history[1]?.err).toBeNull();
    expect(history[1]?.blockTime).toBe(got?.blockTime);
    expect((await connection.getSignaturesForAddress(to, { limit: 1 })).map((h) => h.signature)).toEqual([second]);
    expect((await connection.getSignaturesForAddress(to, { before: second })).map((h) => h.signature)).toEqual([signature]);

    // A transaction naming an unknown blockhash, sent without preflight, is accepted and never
    // lands (as on a node): its status stays null and polling gives up.
    const dropped = new Transaction({ feePayer: payer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 0 });
    dropped.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 5 }));
    dropped.sign(payer);
    const lost = await connection.sendRawTransaction(dropped.serialize(), { skipPreflight: true });
    expect((await connection.getSignatureStatus(lost)).value).toBeNull();
    expect(await connection.getTransaction(lost)).toBeNull();
    await expect(confirmSignature(connection, lost, { timeoutMs: 200 })).rejects.toThrow(/did not land/);

    const many = await connection.getMultipleAccountsInfo([payer.publicKey, Keypair.generate().publicKey, to]);
    expect(many.map((a) => a?.lamports ?? null)).toEqual([9 * LAMPORTS_PER_SOL - 10_000 - 1, null, LAMPORTS_PER_SOL + 1]);
  });

  it('rejects a failing transaction at preflight with logs, and lands it when preflight is skipped', async () => {
    const payer = await funded(1);
    const to = Keypair.generate().publicKey;
    const build = async () => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
      tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 5 * LAMPORTS_PER_SOL }));
      tx.sign(payer);
      return tx;
    };

    const err = await sendError(connection.sendRawTransaction((await build()).serialize()));
    expect(err.message).toContain('custom program error: 0x1');
    expect(err.logs?.some((l) => l.includes('insufficient lamports'))).toBe(true);
    expect(await connection.getBalance(payer.publicKey)).toBe(LAMPORTS_PER_SOL);

    const signature = await connection.sendRawTransaction((await build()).serialize(), { skipPreflight: true });
    const status = await confirmSignature(connection, signature);
    expect(status.err).toEqual({ InstructionError: [0, { Custom: 1 }] });
    expect(await connection.getBalance(payer.publicKey)).toBe(LAMPORTS_PER_SOL - 5000);
    expect((await connection.getTransaction(signature))?.meta?.err).toEqual({ InstructionError: [0, { Custom: 1 }] });
    await expect(sendAndConfirm(connection, await build(), { skipPreflight: true })).rejects.toThrow(/failed: \{"InstructionError"/);
  });

  it('simulates without changing state and quotes the fee that is then charged', async () => {
    const payer = await funded(2);
    const to = Keypair.generate().publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    expect((await connection.isBlockhashValid(blockhash)).value).toBe(true);
    expect(lastValidBlockHeight).toBe((await connection.getBlockHeight()) + 150);

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: LAMPORTS_PER_SOL }),
    ];
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    const fee = (await connection.getFeeForMessage(tx.compileMessage())).value;
    expect(fee).toBe(5000 + 500);

    // Legacy simulate: unsigned, signature verification off.
    const sim = await connection.simulateTransaction(tx);
    expect(sim.value.err).toBeNull();
    expect(sim.value.logs?.at(-1)).toBe(`Program ${SystemProgram.programId} success`);
    expect(sim.value.unitsConsumed).toBeGreaterThan(0);
    expect(await connection.getBalance(to)).toBe(0);

    // Versioned simulate with a replaced blockhash and post-state of chosen accounts.
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
    const vsim = await connection.simulateTransaction(new VersionedTransaction(message), {
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [to.toBase58()] },
    });
    expect(vsim.value.err).toBeNull();
    expect(vsim.value.accounts?.[0]?.lamports).toBe(LAMPORTS_PER_SOL);

    tx.sign(payer);
    await sendAndConfirm(connection, tx);
    expect(await connection.getBalance(payer.publicKey)).toBe(LAMPORTS_PER_SOL - fee!);
  });
});

describe('SPL tokens', () => {
  it('creates a USDC-like mint with control methods and transfers through the token program', async () => {
    const issuer = Keypair.generate();
    const alice = await funded(1);
    const bob = Keypair.generate().publicKey;

    const mint = new PublicKey(await svm.createMint(6, issuer.publicKey));
    const mintInfo = await getMint(connection, mint);
    expect(mintInfo.decimals).toBe(6);
    expect(mintInfo.supply).toBe(0n);
    expect(mintInfo.mintAuthority?.equals(issuer.publicKey)).toBe(true);
    expect(mintInfo.freezeAuthority?.equals(issuer.publicKey)).toBe(true);

    const aliceAta = new PublicKey(await svm.mintTo(mint, alice.publicKey, 1_000_000_000n));
    expect(aliceAta.equals(getAssociatedTokenAddressSync(mint, alice.publicKey))).toBe(true);
    expect((await getMint(connection, mint)).supply).toBe(1_000_000_000n);
    const account = await getAccount(connection, aliceAta);
    expect(account.amount).toBe(1_000_000_000n);
    expect(account.owner.equals(alice.publicKey)).toBe(true);
    expect(account.isFrozen).toBe(false);
    expect((await connection.getTokenAccountBalance(aliceAta)).value).toEqual({ amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' });

    // Alice creates Bob's associated token account and pays him 12.5 tokens.
    const bobAta = getAssociatedTokenAddressSync(mint, bob);
    const signature = await run(
      [
        createAssociatedTokenAccountInstruction(alice.publicKey, bobAta, bob, mint),
        createTransferCheckedInstruction(aliceAta, mint, bobAta, alice.publicKey, 12_500_000n, 6),
      ],
      [alice],
    );
    expect((await getAccount(connection, bobAta)).amount).toBe(12_500_000n);
    expect((await connection.getTokenAccountBalance(bobAta)).value.uiAmountString).toBe('12.5');
    expect((await connection.getAccountInfo(bobAta))?.lamports).toBe((128 + 165) * 5080);

    const meta = (await connection.getTransaction(signature))?.meta;
    const amounts = (list: TokenBalance[] | null | undefined, owner: PublicKey) =>
      (list ?? []).filter((b) => b.owner === owner.toBase58()).map((b) => [b.mint, b.uiTokenAmount.amount]);
    expect(amounts(meta?.preTokenBalances, alice.publicKey)).toEqual([[mint.toBase58(), '1000000000']]);
    expect(amounts(meta?.postTokenBalances, alice.publicKey)).toEqual([[mint.toBase58(), '987500000']]);
    expect(amounts(meta?.preTokenBalances, bob)).toEqual([]);
    expect(amounts(meta?.postTokenBalances, bob)).toEqual([[mint.toBase58(), '12500000']]);
    expect(meta?.innerInstructions?.length).toBeGreaterThan(0);

    const owned = await connection.getTokenAccountsByOwner(alice.publicKey, { mint });
    expect(owned.value.map((v) => v.pubkey.toBase58())).toEqual([aliceAta.toBase58()]);
    expect(AccountLayout.decode(owned.value[0]!.account.data).amount).toBe(987_500_000n);
    const parsed = await connection.getParsedTokenAccountsByOwner(bob, { programId: TOKEN_PROGRAM_ID });
    expect(parsed.value).toHaveLength(1);
    expect(parsed.value[0]?.account.data.parsed.info.tokenAmount.amount).toBe('12500000');
    expect(parsed.value[0]?.account.data.parsed.info.mint).toBe(mint.toBase58());

    // Freezing Bob's account (the pay-or-park case) makes a transfer to it fail with AccountFrozen.
    await svm.setTokenAccountFrozen(bobAta, true);
    expect((await getAccount(connection, bobAta)).isFrozen).toBe(true);
    const pay = createTransferCheckedInstruction(aliceAta, mint, bobAta, alice.publicKey, 1n, 6);
    const frozen = await sendError(run([pay], [alice]));
    expect(frozen.message).toContain('custom program error: 0x11');
    await svm.setTokenAccountFrozen(bobAta, false);
    await run([pay], [alice]);
    expect((await getAccount(connection, bobAta)).amount).toBe(12_500_001n);
  });

  it('runs a mint created and minted by ordinary transactions', async () => {
    const payer = await funded(1);
    const mint = Keypair.generate();
    const holder = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint.publicKey, holder);
    await run(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, holder, mint.publicKey),
        createMintToInstruction(mint.publicKey, ata, payer.publicKey, 42_000_000n),
      ],
      [payer, mint],
    );
    const info = await getMint(connection, mint.publicKey);
    expect([info.decimals, info.supply, info.freezeAuthority]).toEqual([6, 42_000_000n, null]);
    expect((await getAccount(connection, ata)).amount).toBe(42_000_000n);
    // The control method works on a mint it did not create.
    await svm.mintTo(mint.publicKey, holder, 8_000_000n);
    expect((await connection.getTokenAccountBalance(ata)).value.uiAmount).toBe(50);
    expect((await getMint(connection, mint.publicKey)).supply).toBe(50_000_000n);
  });
});

describe('getProgramAccounts', () => {
  it('applies memcmp, dataSize and dataSlice', async () => {
    const issuer = Keypair.generate().publicKey;
    const mintA = new PublicKey(await svm.createMint(6, issuer));
    const mintB = new PublicKey(await svm.createMint(9, issuer));
    const owners = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const atasA: string[] = [];
    for (const [i, owner] of owners.entries()) atasA.push(await svm.mintTo(mintA, owner, BigInt(i + 1) * 1_000_000n));
    const ataB = await svm.mintTo(mintB, owners[0]!, 5n);

    // Token accounts of mint A: 165 bytes with the mint at offset 0.
    const ofMintA = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mintA.toBase58() } }],
    });
    expect(ofMintA.map((a) => a.pubkey.toBase58()).sort()).toEqual([...atasA].sort());
    for (const { account } of ofMintA) {
      expect(account.owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(AccountLayout.decode(account.data).mint.equals(mintA)).toBe(true);
    }

    // Token accounts owned by the first wallet, across mints: owner at offset 32.
    const ofOwner = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 32, bytes: owners[0]!.toBase58() } }, { dataSize: ACCOUNT_SIZE }],
    });
    expect(ofOwner.map((a) => a.pubkey.toBase58()).sort()).toEqual([atasA[0]!, ataB].sort());

    // Both filters must hold.
    const one = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: mintB.toBase58() } }, { memcmp: { offset: 32, bytes: owners[0]!.toBase58() } }],
    });
    expect(one.map((a) => a.pubkey.toBase58())).toEqual([ataB]);

    // dataSize alone separates mints (82 bytes) from token accounts.
    const mints = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, { filters: [{ dataSize: MINT_SIZE }] });
    const mintKeys = mints.map((a) => a.pubkey.toBase58());
    expect(mintKeys).toEqual(expect.arrayContaining([mintA.toBase58(), mintB.toBase58()]));
    expect(mintKeys).not.toContain(ataB);

    // dataSlice returns only the amount field (8 bytes at offset 64).
    const sliced = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      dataSlice: { offset: 64, length: 8 },
      filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mintA.toBase58() } }],
    });
    expect(sliced.map((a) => a.account.data.readBigUInt64LE(0)).sort()).toEqual([1_000_000n, 2_000_000n, 3_000_000n]);
    expect(sliced.every((a) => a.account.data.length === 8)).toBe(true);

    const nothing = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: Keypair.generate().publicKey.toBase58() } }],
    });
    expect(nothing).toEqual([]);
  });
});

describe('programs and lookup tables', () => {
  it('loads a built .so at a chosen program id and runs it', async () => {
    const payer = await funded(1);
    const programId = Keypair.generate().publicKey;
    const loaded = await svm.addProgram(programId, MEMO_SO);
    expect(loaded.programId).toBe(programId.toBase58());

    const info = await connection.getAccountInfo(programId);
    expect(info?.executable).toBe(true);
    expect(info?.owner.toBase58()).toBe('BPFLoaderUpgradeab1e11111111111111111111111');
    const signature = await run(
      [new TransactionInstruction({ programId, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('swap 0001 opened') })],
      [payer],
    );
    const logs = (await connection.getTransaction(signature))?.meta?.logMessages ?? [];
    expect(logs[0]).toBe(`Program ${programId} invoke [1]`);
    expect(logs.some((l) => l.includes('swap 0001 opened'))).toBe(true);
    expect(logs.at(-1)).toBe(`Program ${programId} success`);

    // The upgrade authority lives in the ProgramData account (tag, slot, option, key).
    const authority = Keypair.generate().publicKey;
    await svm.setUpgradeAuthority(programId, authority);
    const programData = await connection.getAccountInfo(new PublicKey(loaded.programData));
    expect(programData?.data.readUInt32LE(0)).toBe(3);
    expect(programData?.data[12]).toBe(1);
    expect(new PublicKey(programData!.data.subarray(13, 45)).equals(authority)).toBe(true);

    await expect(svm.addProgram(Keypair.generate().publicKey, '/nonexistent/program.so')).rejects.toThrow(/nonexistent/);
  });

  it('sends a v0 transaction through an address lookup table', async () => {
    const payer = await funded(5);
    const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const table = new PublicKey(await svm.createLookupTable(recipients));

    // web3.js decodes the table the facade wrote.
    const lookup = (await connection.getAddressLookupTable(table)).value;
    expect(lookup?.state.addresses.map((a) => a.toBase58())).toEqual(recipients.map((a) => a.toBase58()));
    expect(lookup?.isActive()).toBe(true);
    expect((await connection.getAccountInfo(table))?.owner.equals(AddressLookupTableProgram.programId)).toBe(true);

    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: recipients.map((toPubkey) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey, lamports: LAMPORTS_PER_SOL })),
    }).compileToV0Message([lookup!]);
    expect(message.addressTableLookups).toHaveLength(1);
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    const signature = await connection.sendTransaction(tx);
    expect((await confirmSignature(connection, signature)).err).toBeNull();
    for (const r of recipients) expect(await connection.getBalance(r)).toBe(LAMPORTS_PER_SOL);

    // As on a node, the client must say it understands version 0.
    await expect(connection.getTransaction(signature)).rejects.toThrow(/maxSupportedTransactionVersion/);
    const got = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    expect(got?.version).toBe(0);
    expect(got?.meta?.loadedAddresses?.writable.map((a) => a.toBase58())).toEqual(recipients.map((a) => a.toBase58()));
    expect((await connection.getSignaturesForAddress(recipients[1]!)).map((h) => h.signature)).toEqual([signature]);
  });
});

describe('svm_warp', () => {
  const clock = async () => {
    const data = (await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data;
    return { slot: Number(data.readBigUInt64LE(0)), unixTimestamp: Number(data.readBigInt64LE(32)) };
  };

  it('moves chain time and slot together and expires the blockhash', async () => {
    const payer = await funded(1);
    const to = Keypair.generate().publicKey;
    const before = await clock();
    expect(before.slot).toBe(await connection.getSlot());
    expect(before.unixTimestamp).toBe(START_TIME);
    expect(await connection.getBlockTime(before.slot)).toBe(START_TIME);

    // A transaction signed before the warp.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const stale = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
    stale.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1_000_000 }));
    stale.sign(payer);

    // Thirty days: past every deadline short of the 60-day deposit split.
    const seconds = 30 * 86_400;
    const warped = await svm.warp(seconds);
    expect(warped.unixTimestamp).toBe(START_TIME + seconds);
    expect(warped.slot).toBe(before.slot + seconds * 2.5);
    expect(await clock()).toEqual({ slot: warped.slot, unixTimestamp: warped.unixTimestamp });
    expect(await connection.getSlot()).toBe(warped.slot);
    expect(await connection.getBlockHeight()).toBe(warped.blockHeight);
    expect(await connection.getBlockTime(warped.slot)).toBe(START_TIME + seconds);
    expect(await connection.getBlockTime(before.slot)).toBe(START_TIME);
    expect((await connection.getEpochInfo()).epoch).toBe(Math.floor(warped.slot / 432_000));

    // The old blockhash is dead; a fresh one works and the new block carries the new time.
    expect((await connection.isBlockhashValid(blockhash)).value).toBe(false);
    const err = await sendError(connection.sendRawTransaction(stale.serialize()));
    expect(err.message).toContain('Blockhash not found');
    const signature = await run([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1_000_000 })], [payer]);
    const got = await connection.getTransaction(signature);
    expect(got?.blockTime).toBe(START_TIME + seconds);
    expect(got?.slot).toBe(warped.slot);
    expect((await connection.getSignaturesForAddress(to))[0]?.blockTime).toBe(START_TIME + seconds);

    // svm_setClock pins the timestamp exactly.
    const set = await svm.setClock(START_TIME + 100 * 86_400);
    expect((await clock()).unixTimestamp).toBe(START_TIME + 100 * 86_400);
    expect(await connection.getBlockTime(set.slot)).toBe(START_TIME + 100 * 86_400);
  });
});
