// The watcher's keys: sealed at rest under a passphrase, and able to sign exactly one kind of
// transaction. Every other instruction or function is refused before a signature exists.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { INSTRUCTIONS, IXmrSwapAbi, PROGRAM_ID, base58Encode } from '@xmrswap/protocol';
import { XmrSwapContract, XmrSwapProgram, hex, legacyTransaction, sealNoticeKey, toBase64, verifyWatchAck } from '@xmrswap/sdk';
import { type Abi, decodeFunctionData, parseTransaction, recoverTransactionAddress } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { type EthFreezeTx, type EthereumPins, NotAFreeze, type SolanaPins, WatcherKeys, assertEthereumFreeze, assertSolanaFreeze } from '../src/keys.js';
import { CONTRACT, ETHEREUM_KEY, SOLANA_SEED, ready, testKeys } from './world.js';

beforeAll(async () => {
  await ready;
});

const BLOCKHASH = '11111111111111111111111111111111';
const swapRef = new Uint8Array(32).fill(0x41);
const swap = new PublicKey(swapRef);
const maker = new PublicKey(new Uint8Array(32).fill(0x42));
const SOL_PINS: SolanaPins = { programId: PROGRAM_ID, maxComputeUnits: 200_000, maxPriorityFeeMicroLamports: 1_000n };
const ETH_PINS: EthereumPins = { contract: CONTRACT, chainId: 31337, maxGas: 100_000n, maxFeePerGas: 100_000_000_000n };

describe('the only Solana signature: a freeze', () => {
  const keys = testKeys();
  const program = new XmrSwapProgram(PROGRAM_ID, null);
  const freezeIx = (o: { caller?: string; swap?: PublicKey } = {}) => program.freeze({ caller: o.caller ?? keys.solana, swap: o.swap ?? swap, maker });
  const tx = (instructions: TransactionInstruction[], o: { payer?: string; cuLimit?: number; cuPrice?: bigint } = {}) => legacyTransaction({ payer: o.payer ?? keys.solana, blockhash: BLOCKHASH, instructions, cuLimit: o.cuLimit ?? 30_000, cuPrice: o.cuPrice ?? 1_000n });

  it('signs a freeze of the named swap, and the signature verifies', () => {
    const t = tx([freezeIx()]);
    const { wire, signature } = keys.signSolanaFreeze(t, swapRef, SOL_PINS);
    const back = Transaction.from(wire);
    expect(back.verifySignatures()).toBe(true);
    expect(base58Encode(new Uint8Array(back.signature!))).toBe(base58Encode(signature));
    expect(back.feePayer!.toBase58()).toBe(keys.solana);
    expect(back.instructions.length).toBe(3);
  });

  it('refuses every other instruction of the program, alone or next to a freeze', () => {
    const short = { caller: keys.solana, swap, maker };
    const others: [string, TransactionInstruction][] = [
      ['set_ready', program.setReady(short)],
      ['post_notice', program.postNotice({ ...short, commitment: new Uint8Array(32), ciphertext: new Uint8Array(104) })],
      ['withhold', program.withhold({ ...short, evidence: null } as never)],
      ['publish_evidence', program.publishEvidence({ ...short, txid: new Uint8Array(32), view: new Uint8Array(32) } as never)],
    ];
    for (const [name, ix] of others) {
      expect(() => keys.signSolanaFreeze(tx([ix]), swapRef, SOL_PINS), name).toThrow(NotAFreeze);
      expect(() => keys.signSolanaFreeze(tx([freezeIx(), ix]), swapRef, SOL_PINS), `${name} after a freeze`).toThrow(NotAFreeze);
    }
    // Every instruction the program has, by discriminator, in the place of the freeze.
    const names = Object.keys(INSTRUCTION_NAMES);
    expect(names.length).toBeGreaterThan(20);
    let refused = 0;
    for (const name of names) {
      const data = Buffer.from(DISCRIMINATOR(name));
      const ix = new TransactionInstruction({ programId: new PublicKey(PROGRAM_ID), keys: freezeIx().keys, data });
      if (name === 'freeze') {
        expect(() => keys.signSolanaFreeze(tx([ix]), swapRef, SOL_PINS)).not.toThrow();
        continue;
      }
      expect(() => keys.signSolanaFreeze(tx([ix]), swapRef, SOL_PINS), name).toThrow(NotAFreeze);
      refused++;
    }
    expect(refused).toBe(names.length - 1);
  });

  it('refuses a transfer, a foreign program, extra data, another swap, another caller, another payer, a second signer, and fees past the bounds', () => {
    const transfer = SystemProgram.transfer({ fromPubkey: new PublicKey(keys.solana), toPubkey: maker, lamports: 1 });
    const foreign = new TransactionInstruction({ programId: maker, keys: freezeIx().keys, data: freezeIx().data });
    const padded = new TransactionInstruction({ programId: new PublicKey(PROGRAM_ID), keys: freezeIx().keys, data: Buffer.concat([freezeIx().data, Buffer.from([0])]) });
    const otherSwap = freezeIx({ swap: new PublicKey(new Uint8Array(32).fill(0x55)) });
    const stranger = Keypair.generate().publicKey.toBase58();
    const cosigned = freezeIx();
    cosigned.keys[2] = { ...cosigned.keys[2]!, isSigner: true };
    const wrongConfig = freezeIx();
    wrongConfig.keys[3] = { ...wrongConfig.keys[3]!, pubkey: maker };
    const cases: [string, Transaction][] = [
      ['a transfer', tx([transfer])],
      ['a transfer after a freeze', tx([freezeIx(), transfer])],
      ['a foreign program', tx([foreign])],
      ['freeze with trailing data', tx([padded])],
      ['another swap', tx([otherSwap])],
      ['another caller', tx([freezeIx({ caller: stranger })])],
      ['another fee payer', tx([freezeIx()], { payer: stranger })],
      ['a second signer', tx([cosigned])],
      ['another config account', tx([wrongConfig])],
      ['compute units past the bound', tx([freezeIx()], { cuLimit: 200_001 })],
      ['priority fee past the bound', tx([freezeIx()], { cuPrice: 1_001n })],
      ['two freezes', tx([freezeIx(), freezeIx()])],
    ];
    for (const [name, t] of cases) expect(() => keys.signSolanaFreeze(t, swapRef, SOL_PINS), name).toThrow(NotAFreeze);
    // Without the compute-budget pair, or with it reordered.
    const bare = new Transaction({ feePayer: new PublicKey(keys.solana), recentBlockhash: BLOCKHASH }).add(freezeIx());
    expect(() => keys.signSolanaFreeze(bare, swapRef, SOL_PINS)).toThrow(NotAFreeze);
    const reordered = new Transaction({ feePayer: new PublicKey(keys.solana), recentBlockhash: BLOCKHASH }).add(freezeIx(), ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
    expect(() => keys.signSolanaFreeze(reordered, swapRef, SOL_PINS)).toThrow(NotAFreeze);
    expect(() => assertSolanaFreeze(new Uint8Array(40), keys.solana, swapRef, SOL_PINS)).toThrow(NotAFreeze);
    // A refused transaction carries no signature.
    const t = tx([transfer]);
    expect(() => keys.signSolanaFreeze(t, swapRef, SOL_PINS)).toThrow();
    expect(t.signature).toBe(null);
  });
});

// The frozen instruction set, read from the protocol package (the IDL), so a new instruction is covered the day it appears.
const INSTRUCTION_NAMES = INSTRUCTIONS as unknown as Record<string, { discriminator: Uint8Array }>;
const DISCRIMINATOR = (name: string): Uint8Array => INSTRUCTION_NAMES[name]!.discriminator;

describe('the only Ethereum signature: freeze(swapId)', () => {
  const keys = testKeys();
  const contract = new XmrSwapContract(CONTRACT);
  const base = (): EthFreezeTx => ({ chainId: 31337, nonce: 3, to: CONTRACT, data: contract.freeze(swapRef).data, value: 0n, gas: 98_250n, maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });

  it('signs freeze(swapId) for the pinned contract and chain; the signer is the watcher address', async () => {
    const raw = await keys.signEthereumFreeze(base(), swapRef, ETH_PINS);
    const parsed = parseTransaction(raw);
    expect(parsed).toMatchObject({ chainId: 31337, to: CONTRACT, nonce: 3, gas: 98_250n, type: 'eip1559' });
    expect(parsed.value ?? 0n).toBe(0n);
    expect(decodeFunctionData({ abi: IXmrSwapAbi as unknown as Abi, data: parsed.data! }).functionName).toBe('freeze');
    expect((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase()).toBe(keys.ethereum);
  });

  it('refuses every other function of the contract', async () => {
    const abi = (IXmrSwapAbi as unknown as { type: string; name?: string; stateMutability?: string }[]).filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure');
    expect(abi.length).toBeGreaterThan(20);
    const calls: [string, `0x${string}`][] = [
      ['setReady', contract.setReady(swapRef).data],
      ['abort', contract.abort(swapRef).data],
      ['refund', contract.refund(swapRef, new Uint8Array(32).fill(1)).data],
      ['claim', contract.claim(swapRef, new Uint8Array(32).fill(1)).data],
      ['withdrawOwed', contract.withdrawOwed('0x0000000000000000000000000000000000000000', keys.ethereum).data],
      ['pushOwed', contract.pushOwed('0x0000000000000000000000000000000000000000', keys.ethereum).data],
      ['postNotice', contract.postNotice(swapRef, new Uint8Array(32), new Uint8Array(104)).data],
      ['empty calldata (a plain transfer)', '0x'],
      ['freeze of another swap', contract.freeze(new Uint8Array(32).fill(0x55)).data],
      ['freeze with trailing bytes', `${contract.freeze(swapRef).data}00`],
    ];
    for (const [name, data] of calls) await expect(keys.signEthereumFreeze({ ...base(), data }, swapRef, ETH_PINS), name).rejects.toBeInstanceOf(NotAFreeze);
  });

  it('refuses another contract, another chain, any value, gas or a fee past the bounds', async () => {
    const cases: [string, Partial<EthFreezeTx>][] = [
      ['another contract', { to: '0x00000000000000000000000000000000000000ff' }],
      ['another chain', { chainId: 1 }],
      ['one wei of value', { value: 1n }],
      ['gas past the bound', { gas: 100_001n }],
      ['fee past the bound', { maxFeePerGas: 100_000_000_001n }],
      ['tip above the fee', { maxPriorityFeePerGas: 22_000_000_000n }],
      ['a negative nonce', { nonce: -1 }],
    ];
    for (const [name, over] of cases) {
      await expect(keys.signEthereumFreeze({ ...base(), ...over }, swapRef, ETH_PINS), name).rejects.toBeInstanceOf(NotAFreeze);
      expect(() => assertEthereumFreeze({ ...base(), ...over }, swapRef, ETH_PINS), name).toThrow(NotAFreeze);
    }
  });
});

describe('what the key holder offers', () => {
  it('has exactly these operations: no "sign bytes", no export of a secret', () => {
    expect(Object.getOwnPropertyNames(WatcherKeys.prototype).sort()).toEqual(['constructor', 'openFromStore', 'openRequest', 'save', 'sealForStore', 'signAck', 'signEthereumFreeze', 'signSolanaFreeze']);
    const keys = testKeys();
    // Nothing enumerable or JSON-visible but the two public keys.
    expect(Object.keys(keys).sort()).toEqual(['ethereum', 'solana']);
    const dump = JSON.stringify(keys) + String(keys) + Object.values(keys).join();
    for (const secret of [hex(SOLANA_SEED), hex(ETHEREUM_KEY)]) expect(dump).not.toContain(secret);
  });

  it('opens a request sealed to it and signs an acknowledgement the SDK verifies', () => {
    const keys = testKeys();
    const noticeKey = new Uint8Array(32).fill(9);
    const body = { chain: 'ethereum', swap_ref: hex(swapRef), notice_key: toBase64(sealNoticeKey({ noticeKey, watcherSolanaKey: keys.solana, chain: 'ethereum', swapRef })) };
    expect(hex(keys.openRequest(body).noticeKey)).toBe(hex(noticeKey));
    const ack = keys.signAck('ethereum', swapRef, 1_800_005_000n);
    expect(verifyWatchAck(ack, { chain: 'ethereum', swapRef, watcherSolanaKey: keys.solana })).toBe(true);
    expect(verifyWatchAck(ack, { chain: 'solana', swapRef, watcherSolanaKey: keys.solana })).toBe(false);
  });
});

describe('the keystore', () => {
  it('is generated on first start, sealed under the passphrase with mode 0600, and never holds a key in clear', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-keys-'));
    const first = WatcherKeys.openOrCreate(dir, 'correct horse');
    expect(first.created).toBe(true);
    const file = path.join(dir, 'watcher-keystore.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(parsed).sort()).toEqual(['ethereum', 'sealed', 'solana', 'version']);
    expect(parsed['solana']).toBe(first.keys.solana);
    // The public keys can be read without the passphrase; the secrets cannot.
    expect(WatcherKeys.publicKeys(dir)).toEqual({ solana: first.keys.solana, ethereum: first.keys.ethereum });
    const again = WatcherKeys.openOrCreate(dir, 'correct horse');
    expect(again.created).toBe(false);
    expect([again.keys.solana, again.keys.ethereum]).toEqual([first.keys.solana, first.keys.ethereum]);
    expect(() => WatcherKeys.open(dir, 'wrong')).toThrow(/wrong passphrase/);
    expect(() => WatcherKeys.openOrCreate(dir, '')).toThrow(/empty/);
    expect(() => first.keys.save(dir, 'correct horse')).toThrow(/refusing to overwrite/);
    // Two generated keystores differ.
    const other = WatcherKeys.openOrCreate(mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-keys-')), 'x');
    expect(other.keys.solana).not.toBe(first.keys.solana);
  });

  it('a fixed key saved and reopened is the same key, and its seed is not in the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-keys-'));
    testKeys().save(dir, 'pw');
    const text = readFileSync(path.join(dir, 'watcher-keystore.json'), 'utf8');
    for (const secret of [hex(SOLANA_SEED), hex(ETHEREUM_KEY), Buffer.from(SOLANA_SEED).toString('base64')]) expect(text).not.toContain(secret);
    expect(WatcherKeys.open(dir, 'pw').solana).toBe(testKeys().solana);
    // A file whose public part was swapped is refused.
    const tampered = JSON.parse(text) as Record<string, unknown>;
    tampered['solana'] = Keypair.generate().publicKey.toBase58();
    const dir2 = mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-keys-'));
    writeFileSync(path.join(dir2, 'watcher-keystore.json'), JSON.stringify(tampered));
    expect(() => WatcherKeys.open(dir2, 'pw')).toThrow(/does not hold the keys it names/);
  });
});
