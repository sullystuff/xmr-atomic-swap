// The recovery file (SPEC 8.4): one file for every swap; resume from the seed and the nonce
// stored on-chain.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { RECOVERY_FORMAT, RecoveryFileError } from '@xmrswap/protocol';
import { createRecoveryFile, encryptRecoveryFile, isEncrypted, matchesDeployment, readRecoveryFile, recoverySeed, resumeSwapKeys, withWallet, writeRecoveryFile } from '../src/recovery/file.js';
import { hex, unhex } from '../src/util.js';
import { vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const PROGRAM = '5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u';
const CONTRACT = '0xe7501885e3c726ef74694299b7cd49d65e8ed897';
const keys = vector('keys');
const seedHex = keys.cases[0].input.seed as string;

describe('recovery file', () => {
  it('creates the format of SPEC 8.4 and round-trips through text', () => {
    const f = createRecoveryFile({ seed: unhex(seedHex), wallets: { solana: ['So1'], ethereum: [] }, programId: PROGRAM, contract: CONTRACT, createdAt: new Date('2026-11-21T12:00:00Z') });
    expect(f).toEqual({ format: 'xmrswap-recovery/1', created_at: '2026-11-21T12:00:00Z', seed: seedHex, wallets: { solana: ['So1'], ethereum: [] }, program_id: PROGRAM, contract: CONTRACT });
    expect(f.format).toBe(RECOVERY_FORMAT);
    const back = readRecoveryFile(writeRecoveryFile(f));
    expect(back).toEqual(f);
    expect(hex(recoverySeed(back))).toBe(seedHex);
    expect(isEncrypted(back)).toBe(false);
    // A fresh file gets fresh randomness.
    const a = createRecoveryFile({ programId: PROGRAM, contract: CONTRACT });
    const b = createRecoveryFile({ programId: PROGRAM, contract: CONTRACT });
    expect(a.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(a.seed).not.toBe(b.seed);
    expect(() => createRecoveryFile({ seed: new Uint8Array(16), programId: PROGRAM, contract: CONTRACT })).toThrow(RecoveryFileError);
  });

  it('re-derives every key of a swap from the seed and the on-chain nonce, on both chains', () => {
    const f = createRecoveryFile({ seed: unhex(seedHex), programId: PROGRAM, contract: CONTRACT });
    const seed = recoverySeed(readRecoveryFile(writeRecoveryFile(f)));
    let n = 0;
    for (const c of keys.cases.filter((c: any) => c.valid && c.input.share_id && c.input.seed === seedHex)) {
      const k = resumeSwapKeys(seed, c.input.chain_tag === 1 ? 'solana' : 'ethereum', unhex(c.input.share_id));
      expect(hex(k.spend), c.name).toBe(c.output.spend);
      expect(hex(k.view), c.name).toBe(c.output.view);
      expect(hex(k.sessionSecret), c.name).toBe(c.output.session_secret);
      expect(hex(k.encSecret), c.name).toBe(c.output.enc_secret);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(2);
    // The chain tag keeps Solana and Ethereum shares disjoint for the same nonce.
    const nonce = unhex(keys.cases[0].input.share_id);
    expect(hex(resumeSwapKeys(seed, 'solana', nonce).spend)).not.toBe(hex(resumeSwapKeys(seed, 'ethereum', nonce).spend));
  });

  it('encrypts the seed under a passphrase and refuses a wrong one', () => {
    const f = createRecoveryFile({ seed: unhex(seedHex), programId: PROGRAM, contract: CONTRACT });
    const enc = encryptRecoveryFile(f, 'correct horse');
    expect(isEncrypted(enc)).toBe(true);
    expect('seed' in enc).toBe(false);
    expect(JSON.stringify(enc)).not.toContain(seedHex);
    const back = readRecoveryFile(writeRecoveryFile(enc));
    expect(hex(recoverySeed(back, 'correct horse'))).toBe(seedHex);
    expect(() => recoverySeed(back, 'wrong horse')).toThrow(/wrong passphrase/);
    expect(() => recoverySeed(back)).toThrow(/passphrase is required/);
    expect(() => encryptRecoveryFile(f, '')).toThrow(RecoveryFileError);
    // A damaged ciphertext is a failure, never a different seed.
    const damaged = { ...enc, seed_enc: `${enc.seed_enc.slice(0, -6)}AAAA==` };
    expect(() => recoverySeed(damaged, 'correct horse')).toThrow(RecoveryFileError);
  });

  it('refuses files that are not recovery files', () => {
    const f = createRecoveryFile({ seed: unhex(seedHex), programId: PROGRAM, contract: CONTRACT });
    const text = (edit: (o: any) => void) => {
      const o = JSON.parse(writeRecoveryFile(f));
      edit(o);
      return JSON.stringify(o);
    };
    for (const bad of [
      'not json',
      '[]',
      text((o) => void (o.format = 'xmrswap-recovery/2')),
      text((o) => void (o.seed = 'abcd')),
      text((o) => void (o.seed = o.seed.toUpperCase())),
      text((o) => void delete o.seed),
      text((o) => void (o.seed_enc = 'AA==')),
      text((o) => void (o.wallets = { solana: [] })),
      text((o) => void (o.created_at = 'yesterday')),
      text((o) => void delete o.program_id),
    ]) expect(() => readRecoveryFile(bad), bad.slice(0, 60)).toThrow(RecoveryFileError);
    expect(() => writeRecoveryFile({ ...f, seed: 'zz' })).toThrow(RecoveryFileError);
  });

  it('records wallets once and knows which deployment it was made for', () => {
    let f = createRecoveryFile({ seed: unhex(seedHex), programId: PROGRAM, contract: CONTRACT });
    f = withWallet(f, 'solana', 'Wallet1');
    f = withWallet(f, 'solana', 'Wallet1');
    f = withWallet(f, 'ethereum', '0xABCDEF0000000000000000000000000000000001');
    f = withWallet(f, 'ethereum', '0xabcdef0000000000000000000000000000000001');
    expect(f.wallets).toEqual({ solana: ['Wallet1'], ethereum: ['0xabcdef0000000000000000000000000000000001'] });
    expect(matchesDeployment(f, PROGRAM, CONTRACT.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(matchesDeployment(f, PROGRAM, '0x0000000000000000000000000000000000000001')).toBe(false);
    expect(matchesDeployment(f, 'OtherProgram1111111111111111111111111111111', CONTRACT)).toBe(false);
  });
});
