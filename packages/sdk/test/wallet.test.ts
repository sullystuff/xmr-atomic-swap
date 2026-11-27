// The optional wallet-derived key (SPEC 11.3) against wallet_seed.json: the exact messages,
// the derivation, and the rules a client enforces around it (the signature must be the wallet's
// own over this deployment's message; a signer that is not deterministic is refused; a returning
// user's seed must reproduce the commitments of its swaps).
import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CHAIN_TAG, init, walletSeed } from '@xmrswap/core-wasm';
import { type Address, EIP712_TYPE_STRINGS, WALLET_KEY_NOTICE, WALLET_KEY_SITE, WALLET_KEY_WARNINGS, base58Encode, parseRecoveryFile } from '@xmrswap/protocol';
import { hashTypedData, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { takerSwapKeys } from '../src/flows/keys.js';
import { recoverySeed, resumeSwapKeys, writeRecoveryFile } from '../src/recovery/file.js';
import { type Bytes, codeOf, concat, hex, hex0x, unhex } from '../src/util.js';
import { type KnownSwap, type WalletKeyContext, deriveWalletSeed, unlockWalletSeed, walletKeyRecoveryFile, walletKeySiteProblem, walletKeySolanaRequest, walletKeyTypedData, walletSeedMatchesSwaps, walletSignatureValid } from '../src/wallet/seed.js';
import { rng, vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const v = vector('wallet_seed');
const r = rng(5);
const SITE = v.site as string;
const solCases = v.cases.filter((c: any) => c.valid && c.input.chain_tag === 1 && c.message);
const ethCases = v.cases.filter((c: any) => c.valid && c.input.chain_tag === 2);
const solCtx = (c: any, over: object = {}): Extract<WalletKeyContext, { chain: 'solana' }> => ({ chain: 'solana', wallet: c.message.wallet_base58, genesisHash: c.message.genesis_hash_base58, programId: c.message.program_id_base58, site: c.message.site, ...over });
const eth0 = ethCases.find((c: any) => c.name === 'ethereum');
const ethCtx = (over: object = {}): Extract<WalletKeyContext, { chain: 'ethereum' }> => ({ chain: 'ethereum', wallet: eth0.input.wallet, chainId: v.domain.chainId, contract: v.domain.verifyingContract, site: SITE, ...over });
const strip = (h: string): Bytes => unhex(h);

describe('wallet_seed.json: messages', () => {
  it('Solana: the exact bytes a wallet signs with signMessage, and the wallet\'s own signature over them', () => {
    expect(solCases.length).toBe(1);
    for (const c of solCases) {
      const req = walletKeySolanaRequest(solCtx(c));
      expect(req.text, c.name).toBe(c.message.text);
      expect(hex(req.bytes), c.name).toBe(c.message.bytes);
      // UTF-8, LF line ends, no trailing newline; the three keys in base58.
      expect(req.text.endsWith('\n') || req.text.includes('\r')).toBe(false);
      expect(req.text.split('\n').slice(3)).toEqual(['xmrswap wallet key v1', `cluster: ${c.message.genesis_hash_base58}`, `program: ${c.message.program_id_base58}`, `wallet: ${c.message.wallet_base58}`]);
      // Ed25519 is deterministic: signing the bytes with the wallet's key gives the vector's signature.
      expect(hex(ed25519.sign(req.bytes, unhex(c.message.wallet_private_seed))), c.name).toBe(c.input.signature);
    }
    // The default site is the protocol's constant; the vectors use a stand-in.
    expect(walletKeySolanaRequest(solCtx(solCases[0], { site: undefined })).text).toContain(`Sign this only on ${WALLET_KEY_SITE} `);
    expect(codeOf(() => walletKeySolanaRequest(solCtx(solCases[0], { wallet: 'abc' })))).toBe('BadKey');
  });

  it('Ethereum: the typed data for eth_signTypedData_v4 under the contract\'s own domain, its digest and signature', async () => {
    const td = walletKeyTypedData(ethCtx());
    const want = eth0.message.typed_data;
    expect({ ...td.domain, chainId: Number(td.domain.chainId) }).toEqual(want.domain);
    expect(td.message).toEqual(want.message);
    expect(td.types.WalletKey).toEqual(want.types.WalletKey);
    expect(td.primaryType).toBe('WalletKey');
    expect(td.message.notice).toBe(WALLET_KEY_NOTICE);
    expect(hashTypedData(td)).toBe(eth0.message.digest);
    expect(EIP712_TYPE_STRINGS.WalletKey).toBe(v.wallet_key_type);
    expect(keccak256(toBytes(v.wallet_key_type))).toBe(v.wallet_key_type_hash);
    // RFC 6979: the wallet's key signs the same bytes every time, and they are the vector's.
    const account = privateKeyToAccount(eth0.message.wallet_private_key);
    expect(account.address.toLowerCase()).toBe(eth0.input.wallet);
    expect(await account.signTypedData(td)).toBe(eth0.input.signature);
    expect(await account.signTypedData(td)).toBe(eth0.input.signature);
  });

  it('the three mandatory warnings name the site', () => {
    expect(WALLET_KEY_WARNINGS.length).toBe(3);
    expect(WALLET_KEY_WARNINGS[2]).toContain(WALLET_KEY_SITE);
    expect(walletKeySiteProblem(WALLET_KEY_SITE)).toBe(null);
    for (const loop of ['localhost:5173', '127.0.0.1', '127.0.0.1:8080', '[::1]']) expect(walletKeySiteProblem(loop), loop).toBe(null);
    expect(walletKeySiteProblem('mirror.example')).toContain('mirror.example');
    expect(walletKeySiteProblem(`evil-${WALLET_KEY_SITE}`)).not.toBe(null);
  });
});

describe('wallet_seed.json: derivation', () => {
  it('derives the seed of every valid case, and from it the spend commitment a returning user compares', async () => {
    let n = 0;
    for (const c of v.cases.filter((c: any) => c.valid)) {
      const chain = c.input.chain_tag === 1 ? 'solana' : 'ethereum';
      const sig = strip(c.input.signature);
      const seed = walletSeed(c.input.chain_tag, strip(c.input.wallet), sig);
      expect(hex(seed), c.name).toBe(c.output.seed);
      expect(hex(takerSwapKeys(seed, chain, unhex(c.output.swap_nonce)).spendPub), c.name).toBe(c.output.spend_pub);
      // Through the SDK, which first checks the signature is the wallet's over this message.
      if (chain === 'solana' && !c.message) {
        // The same signature under another wallet's address: the core derives another seed (the
        // address is in the KDF), and the SDK refuses it, because the signature is not that wallet's.
        expect(c.output.seed).not.toBe(solCases[0].output.seed);
        await expect(deriveWalletSeed(solCtx(solCases[0], { wallet: base58Encode(unhex(c.input.wallet)) }), sig)).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });
      } else expect(hex(await deriveWalletSeed(chain === 'solana' ? solCtx(c) : ethCtx(), sig)), c.name).toBe(c.output.seed);
      n++;
    }
    expect(n).toBe(6);
    // Every spelling of one Ethereum signature (high s, v as 0/1) is one seed.
    expect(new Set(ethCases.map((c: any) => c.output.seed)).size).toBe(1);
    expect(new Set(ethCases.map((c: any) => c.input.signature)).size).toBe(4);
    // The seed is per chain and wallet.
    expect(new Set(v.cases.filter((c: any) => c.valid).map((c: any) => c.output.seed)).size).toBe(3);
  });

  it('refuses every invalid case with the core\'s error, and never derives from it', async () => {
    const bad = v.cases.filter((c: any) => !c.valid);
    expect(bad.length).toBe(10);
    for (const c of bad) {
      expect(codeOf(() => walletSeed(c.input.chain_tag, strip(c.input.wallet), strip(c.input.signature))), c.name).toBe(c.error);
      if (c.input.chain_tag === 2 && c.input.wallet.length === 42) await expect(deriveWalletSeed(ethCtx(), strip(c.input.signature)), c.name).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });
      if (c.input.chain_tag === 1 && c.input.wallet.length === 64) await expect(deriveWalletSeed(solCtx(solCases[0]), strip(c.input.signature)), c.name).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });
    }
  });
});

describe('rules around the wallet key', () => {
  const sol = solCases[0];
  const solSeed = unhex(sol.message.wallet_private_seed);
  const signSol = (ctx = solCtx(sol)) => async () => ed25519.sign(walletKeySolanaRequest(ctx).bytes, solSeed);
  const account = privateKeyToAccount(eth0.message.wallet_private_key);
  const signEth = (ctx = ethCtx()) => async () => unhex(await account.signTypedData(walletKeyTypedData(ctx)));

  it('a signature made for another site, cluster, program, chain id, contract or wallet is rejected', async () => {
    const good = await signSol()();
    expect(await walletSignatureValid(solCtx(sol), good)).toBe(true);
    const otherSeed = r.bytes(32);
    const otherWallet = base58Encode(ed25519.getPublicKey(otherSeed));
    for (const wrong of [{ site: 'phish.example' }, { programId: otherWallet }, { genesisHash: otherWallet }]) {
      // Signed under the wrong context, presented to the right one...
      const sig = await signSol(solCtx(sol, wrong))();
      expect(await walletSignatureValid(solCtx(sol), sig), JSON.stringify(wrong)).toBe(false);
      await expect(deriveWalletSeed(solCtx(sol), sig)).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });
      // ...and the right signature presented to the wrong context.
      expect(await walletSignatureValid(solCtx(sol, wrong), good)).toBe(false);
    }
    // Another wallet's signature over this wallet's message.
    expect(await walletSignatureValid(solCtx(sol), ed25519.sign(walletKeySolanaRequest(solCtx(sol)).bytes, otherSeed))).toBe(false);

    const ethGood = await signEth()();
    expect(await walletSignatureValid(ethCtx(), ethGood)).toBe(true);
    for (const wrong of [{ chainId: 1 }, { contract: hex0x(r.bytes(20)) as Address }, { site: 'phish.example' }]) {
      const sig = await signEth(ethCtx(wrong))();
      expect(await walletSignatureValid(ethCtx(), sig), JSON.stringify(wrong)).toBe(false);
      await expect(deriveWalletSeed(ethCtx(), sig)).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });
      expect(await walletSignatureValid(ethCtx(wrong), ethGood)).toBe(false);
    }
    // A signature by another key (or a contract wallet, which has none) does not recover the wallet.
    const stranger = privateKeyToAccount(hex0x(r.bytes(32)));
    expect(await walletSignatureValid(ethCtx(), unhex(await stranger.signTypedData(walletKeyTypedData(ethCtx()))))).toBe(false);
    // A personal_sign of the same text is not the typed-data signature.
    expect(await walletSignatureValid(ethCtx(), unhex(await account.signMessage({ message: WALLET_KEY_NOTICE })))).toBe(false);
  });

  it('first use: asks twice, accepts a deterministic signer and refuses one that is not', async () => {
    let asked = 0;
    const counted = (sign: () => Promise<Bytes>) => async () => {
      asked++;
      return sign();
    };
    const s = await unlockWalletSeed(solCtx(sol), counted(signSol()), []);
    expect(asked).toBe(2);
    expect(s).toMatchObject({ provedBy: 'two-signatures', swapsChecked: 0 });
    expect(hex(s.seed)).toBe(sol.output.seed);
    asked = 0;
    const e = await unlockWalletSeed(ethCtx(), counted(signEth()), []);
    expect(asked).toBe(2);
    expect(hex(e.seed)).toBe(eth0.output.seed);

    // Ethereum with random nonces: every signature is valid and recovers the wallet, but no two are equal.
    const priv = unhex(eth0.message.wallet_private_key);
    const digest = unhex(eth0.message.digest);
    const randomEth = async (): Promise<Bytes> => {
      const sig = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered', extraEntropy: true });
      return concat(sig.subarray(1), Uint8Array.of(27 + sig[0]!));
    };
    const one = await randomEth();
    expect(await walletSignatureValid(ethCtx(), one)).toBe(true);
    expect(hex(one)).not.toBe(hex(await randomEth()));
    await expect(unlockWalletSeed(ethCtx(), randomEth, [])).rejects.toMatchObject({ code: 'NonDeterministicSigner' });

    // Solana: a signer that produces valid Ed25519 signatures with a fresh nonce each time.
    const randomSol = randomizedEd25519(solSeed, walletKeySolanaRequest(solCtx(sol)).bytes);
    const a = await randomSol();
    expect(ed25519.verify(a, walletKeySolanaRequest(solCtx(sol)).bytes, ed25519.getPublicKey(solSeed))).toBe(true);
    expect(await walletSignatureValid(solCtx(sol), a)).toBe(true);
    await expect(unlockWalletSeed(solCtx(sol), randomSol, [])).rejects.toMatchObject({ code: 'NonDeterministicSigner' });

    // One Ethereum signature returned in two spellings is still one signature.
    const spellings = [strip(ethCases[0].input.signature), strip(ethCases.find((c: any) => c.name === 'ethereum-high-s-and-v-zero-or-one').input.signature)];
    let i = 0;
    const same = await unlockWalletSeed(ethCtx(), async () => spellings[i++ % 2]!, []);
    expect(hex(same.seed)).toBe(eth0.output.seed);
    // A signer that returns somebody else's signature is refused before anything is derived.
    await expect(unlockWalletSeed(ethCtx(), async () => r.bytes(65), [])).rejects.toMatchObject({ code: 'WalletSignatureInvalid' });
  });

  it('returning user: one signature, proved against the commitments of the wallet\'s swaps on chain', async () => {
    const known = (c: any, chain: 'solana' | 'ethereum', n: number): KnownSwap[] =>
      Array.from({ length: n }, () => {
        const swapNonce = r.bytes(16);
        return { swapNonce, takerSpendPub: takerSwapKeys(unhex(c.output.seed), chain, swapNonce).spendPub };
      });
    const fromVector: KnownSwap = { swapNonce: unhex(sol.output.swap_nonce), takerSpendPub: unhex(sol.output.spend_pub) };
    let asked = 0;
    const sign = async () => {
      asked++;
      return signSol()();
    };
    const swaps = [fromVector, ...known(sol, 'solana', 3)];
    const s = await unlockWalletSeed(solCtx(sol), sign, swaps);
    expect(asked).toBe(1);
    expect(s).toMatchObject({ provedBy: 'swap-commitments', swapsChecked: 4 });
    expect(walletSeedMatchesSwaps(s.seed, 'solana', swaps)).toEqual({ ok: true, checked: 4, mismatched: 0 });
    // A swap opened with another seed (a recovery file, another device's key): the mode is refused.
    const foreign: KnownSwap = { swapNonce: r.bytes(16), takerSpendPub: takerSwapKeys(r.bytes(32), 'solana', r.bytes(16)).spendPub };
    await expect(unlockWalletSeed(solCtx(sol), sign, [...swaps, foreign])).rejects.toMatchObject({ code: 'WalletSeedMismatch' });
    expect(walletSeedMatchesSwaps(s.seed, 'solana', [...swaps, foreign])).toEqual({ ok: false, checked: 5, mismatched: 1 });
    // The Ethereum seed does not open Solana swaps, and the reverse.
    const e = await unlockWalletSeed(ethCtx(), signEth(), known(eth0, 'ethereum', 2));
    expect(e.swapsChecked).toBe(2);
    expect(walletSeedMatchesSwaps(e.seed, 'ethereum', [{ swapNonce: unhex(eth0.output.swap_nonce), takerSpendPub: unhex(eth0.output.spend_pub) }]).ok).toBe(true);
    expect(walletSeedMatchesSwaps(e.seed, 'solana', swaps).ok).toBe(false);
    expect(walletSeedMatchesSwaps(s.seed, 'solana', [])).toEqual({ ok: true, checked: 0, mismatched: 0 });
  });

  it('exports an ordinary recovery file holding the derived seed, which resumes the same swaps', () => {
    const seed = unhex(sol.output.seed);
    const deployment = { programId: sol.message.program_id_base58, contract: v.domain.verifyingContract };
    const file = walletKeyRecoveryFile(solCtx(sol), seed, deployment, new Date('2026-11-27T10:00:00Z'));
    expect(file).toMatchObject({ format: 'xmrswap-recovery/1', seed: sol.output.seed, wallets: { solana: [sol.message.wallet_base58], ethereum: [] }, program_id: deployment.programId });
    // The same format as before the amendment: an old reader reads it, and old files still read.
    const back = parseRecoveryFile(writeRecoveryFile(file));
    expect(hex(recoverySeed(back))).toBe(sol.output.seed);
    expect(hex(resumeSwapKeys(recoverySeed(back), 'solana', unhex(sol.output.swap_nonce)).spendPub)).toBe(sol.output.spend_pub);
    const ethFile = walletKeyRecoveryFile(ethCtx({ wallet: eth0.input.wallet.toUpperCase().replace('0X', '0x') }), unhex(eth0.output.seed), deployment);
    expect(ethFile.wallets).toEqual({ solana: [], ethereum: [eth0.input.wallet] });
    expect(ethFile.seed).toBe(eth0.output.seed);
  });

  it('walletSeed itself does not verify the signature: the SDK check is what binds the seed to the wallet', () => {
    // Any 64 bytes derive a seed in the core; `deriveWalletSeed` is the gate.
    expect(walletSeed(CHAIN_TAG.solana, unhex(sol.input.wallet), r.bytes(64)).length).toBe(32);
  });
});

/** Ed25519 with a random nonce instead of the deterministic one: valid signatures that differ on every call. */
function randomizedEd25519(seed: Bytes, message: Bytes): () => Promise<Bytes> {
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = (b: Bytes): bigint => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);
  const toLe = (n: bigint): Bytes => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  return async () => {
    const { sha512 } = await import('@noble/hashes/sha2.js');
    const h = sha512(seed).slice(0, 32);
    h[0]! &= 248;
    h[31]! &= 127;
    h[31]! |= 64;
    const a = le(h) % L;
    const A = ed25519.getPublicKey(seed);
    const nonce = (le(crypto.getRandomValues(new Uint8Array(64))) % (L - 1n)) + 1n;
    const R = ed25519.Point.BASE.multiply(nonce).toBytes();
    const kk = le(sha512(concat(R, A, message))) % L;
    return concat(R, toLe((nonce + kk * a) % L));
  };
}
