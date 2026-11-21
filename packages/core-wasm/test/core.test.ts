// The nodejs wasm build behind the typed wrapper, checked against independent implementations:
// @noble (HKDF, ed25519, x25519, secp256k1, keccak) and viem (EIP-712). These are test oracles
// only; product code never re-implements SPEC section 2 in TypeScript.
import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as core from '../src/index.js';

const L = ed25519.Point.Fn.ORDER;
const N = secp256k1.Point.Fn.ORDER;
const le = (b: Uint8Array): bigint => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const be = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const toLe = (n: bigint, len = 32): Uint8Array => Uint8Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const toBe = (n: bigint, len = 32): Uint8Array => toLe(n, len).reverse();
const ds = (tag: string): Uint8Array => concatBytes(utf8ToBytes('xmrswap/v1/' + tag), Uint8Array.of(0));
const fill = (b: number, n = 32): Uint8Array => new Uint8Array(n).fill(b);
const ethAddress = (priv: Uint8Array): Uint8Array => keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12);
const hex0x = (b: Uint8Array): `0x${string}` => `0x${bytesToHex(b)}`;

beforeAll(async () => {
  await core.init();
});

describe('init', () => {
  it('is idempotent and reports readiness', async () => {
    expect(core.isReady()).toBe(true);
    await core.init();
    expect(core.coreVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('deriveKeys (SPEC 2.2) against @noble', () => {
  const seed = sha256(utf8ToBytes('core-wasm test seed'));
  const shareId = sha256(utf8ToBytes('share')).subarray(0, 16);
  const okm = (label: string, chainTag: number): Uint8Array =>
    hkdf(sha256, seed, ds('kdf'), concatBytes(utf8ToBytes(label), Uint8Array.of(0, chainTag), shareId), 64);

  for (const [name, tag] of [['solana', 1], ['ethereum', 2]] as const) {
    it(`${name}: spend, view, session and enc keys`, () => {
      const k = core.deriveKeys(seed, tag, shareId);
      // spend = clamp252(okm("spend")[0..32])
      const spend = okm('spend', tag).slice(0, 32);
      spend[31]! &= 0x0f;
      expect(bytesToHex(k.spend)).toBe(bytesToHex(spend));
      expect(bytesToHex(k.spendPub)).toBe(bytesToHex(ed25519.Point.BASE.multiply(le(spend)).toBytes()));
      // view = wide(okm("view")) mod l
      const view = le(okm('view', tag)) % L;
      expect(bytesToHex(k.view)).toBe(bytesToHex(toLe(view)));
      // enc = okm("enc")[0..32], an X25519 secret
      const enc = okm('enc', tag).slice(0, 32);
      expect(bytesToHex(k.encSecret)).toBe(bytesToHex(enc));
      expect(bytesToHex(k.encPub)).toBe(bytesToHex(x25519.getPublicKey(enc)));
      expect(bytesToHex(core.x25519Public(k.encSecret))).toBe(bytesToHex(k.encPub));
      const session = okm('session', tag);
      if (tag === 1) {
        // Solana: an Ed25519 seed.
        expect(bytesToHex(k.sessionSecret)).toBe(bytesToHex(session.slice(0, 32)));
        expect(bytesToHex(k.sessionPub)).toBe(bytesToHex(ed25519.getPublicKey(session.slice(0, 32))));
      } else {
        // Ethereum: 1 + (big-endian(okm[0..48]) mod (n − 1)); sessionPub is the address.
        const priv = toBe(1n + (be(session.slice(0, 48)) % (N - 1n)));
        expect(bytesToHex(k.sessionSecret)).toBe(bytesToHex(priv));
        expect(bytesToHex(k.sessionPub)).toBe(bytesToHex(ethAddress(priv)));
        expect(k.sessionPub.length).toBe(20);
      }
    });
  }

  it('contact share id', () => {
    const pda = fill(7);
    expect(bytesToHex(core.contactShareId(pda))).toBe(bytesToHex(sha256(concatBytes(ds('contact'), pda)).subarray(0, 16)));
  });

  it('rejects bad arguments with typed errors', () => {
    expect(() => core.deriveKeys(seed, 3 as never, shareId)).toThrow(core.CoreError);
    expect(() => core.deriveKeys(seed.subarray(1), 1, shareId)).toThrow(/seed must be 32 bytes/);
    try {
      core.deriveKeys(seed, 3 as never, shareId);
    } catch (e) {
      expect((e as core.CoreError).code).toBe('UnknownChainTag');
    }
  });
});

describe('points and proof of knowledge (SPEC 2.3, 2.4) against @noble', () => {
  const s = toLe(le(sha256(utf8ToBytes('spend share'))) & ((1n << 252n) - 1n));
  const S = ed25519.Point.BASE.multiply(le(s)).toBytes();
  const ctx = sha256(utf8ToBytes('swap pda'));

  it('validatePoint and scalarMatches', () => {
    expect(core.validatePoint(S)).toBe(true);
    expect(core.scalarMatches(s, S)).toBe(true);
    expect(core.scalarMatches(toLe(le(s) + L), S)).toBe(false);
    expect(core.scalarMatches(toLe(le(s) + 1n), S)).toBe(false);
    const identity = fill(0);
    identity[0] = 1;
    expect(core.validatePoint(identity)).toBe(false);
    // A torsioned point: S plus the point of order 2, (0, −1).
    const order2 = ed25519.Point.fromBytes(hexToBytes('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'));
    expect(core.validatePoint(ed25519.Point.fromBytes(S).add(order2).toBytes())).toBe(false);
    expect(core.validatePoint(S.subarray(1))).toBe(false);
  });

  it('pokProve matches the definition, recomputed with @noble', () => {
    const pok = core.pokProve(s, ctx);
    expect(pok.length).toBe(64);
    // k = wide(SHA512(DS("pok-nonce") ‖ s ‖ S ‖ ctx)); R = k·G
    const k = le(sha512(concatBytes(ds('pok-nonce'), s, S, ctx))) % L;
    const R = ed25519.Point.BASE.multiply(k).toBytes();
    // c = clamp252(SHA256(DS("pok") ‖ R ‖ S ‖ ctx)); z = k + c·s mod l
    const cBytes = sha256(concatBytes(ds('pok'), R, S, ctx));
    cBytes[31]! &= 0x0f;
    const z = (k + le(cBytes) * le(s)) % L;
    expect(bytesToHex(pok)).toBe(bytesToHex(concatBytes(R, toLe(z))));
    expect(core.pokVerify(S, ctx, pok)).toBe(true);
    // z·G == R + c·S, checked by the independent library.
    const lhs = ed25519.Point.BASE.multiply(z);
    const rhs = ed25519.Point.fromBytes(R).add(ed25519.Point.fromBytes(S).multiply(le(cBytes)));
    expect(lhs.equals(rhs)).toBe(true);
  });

  it('pokVerify rejects another context, another key and tampering', () => {
    const pok = core.pokProve(s, ctx);
    expect(core.pokVerify(S, sha256(utf8ToBytes('maker pda')), pok)).toBe(false);
    const other = ed25519.Point.BASE.multiply(12345n).toBytes();
    expect(core.pokVerify(other, ctx, pok)).toBe(false);
    const bad = pok.slice();
    bad[40]! ^= 1;
    expect(core.pokVerify(S, ctx, bad)).toBe(false);
    expect(core.pokVerify(S, ctx, pok.subarray(0, 63))).toBe(false);
    expect(() => core.pokProve(fill(0), ctx)).toThrow(/ScalarOutOfRange/);
  });

  it('addScalars is addition mod l', () => {
    const a = toLe(L - 1n);
    expect(bytesToHex(core.addScalars(a, toLe(5n)))).toBe(bytesToHex(toLe(4n)));
    expect(() => core.addScalars(fill(0xff), a)).toThrow(/ScalarNotCanonical/);
  });
});

describe('joint address (SPEC 2.5)', () => {
  it('reproduces the vector of docs/research/monero.md', () => {
    const j = core.jointAddress(
      hexToBytes('6f863e268cff9390a698f23843f802584c7bd2e3bc74593e60dd4138da1de31c'),
      hexToBytes('07c805e21c0057430b82a791f66fdc0d185d398e4f8fb73a955b6bada1ac88d9'),
      hexToBytes('c6367a52bf1ab84df6e44d2f4b5a12fa490bf9351654a5b610f568122e5b7002'),
      hexToBytes('2f246ff530c01376f39b9e2e95e9dcd953e6020a2b984bad02203c4e596c5906'),
      'mainnet',
    );
    expect(j.address).toBe('43MXoVqwCynJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXkmBPX');
    expect(bytesToHex(j.viewPriv)).toBe('f55ae947f0dacbc3e980ec5de043efd39df1fb3f41ecf0631315a56087c7c908');
    expect(() => core.jointAddress(j.spendPub, j.spendPub, fill(0), fill(1), 'mainnet')).toThrow(/ScalarZero/);
    expect(() => core.jointAddress(j.spendPub, j.spendPub, fill(1), fill(1), 'devnet' as never)).toThrow(/UnknownNetwork/);
  });
});

describe('twin keys, DLEQ and the Merkle pool (SPEC 2.6, 2.7)', () => {
  const s = toLe(le(sha256(utf8ToBytes('eth share'))) & ((1n << 252n) - 1n));

  it('twinCommitments matches secp256k1 and keccak from @noble', () => {
    const t = core.twinCommitments(s);
    const priv = toBe(le(s));
    expect(bytesToHex(t.secpCompressed)).toBe(bytesToHex(secp256k1.getPublicKey(priv, true)));
    expect(bytesToHex(t.keyAddr)).toBe(bytesToHex(ethAddress(priv)));
    const T2 = be(keccak_256(utf8ToBytes('xmr-atomic-swap/twin-key/2'))) % N;
    expect(bytesToHex(t.keyAddr2)).toBe(bytesToHex(ethAddress(toBe((le(s) * T2) % N))));
    expect(() => core.twinCommitments(toLe(1n << 252n))).toThrow(/ScalarOutOfRange/);
  });

  it('dleqProve and dleqVerify in wasm, with OS randomness', () => {
    const blob = core.dleqProve(s);
    expect(blob.length).toBe(56_679);
    expect(blob[0]).toBe(1);
    const st = core.dleqVerify(blob);
    const t = core.twinCommitments(s);
    expect(bytesToHex(st.keyAddr)).toBe(bytesToHex(t.keyAddr));
    expect(bytesToHex(st.keyAddr2)).toBe(bytesToHex(t.keyAddr2));
    expect(bytesToHex(st.spendPub)).toBe(bytesToHex(ed25519.Point.BASE.multiply(le(s)).toBytes()));
    // Fresh randomness every time.
    expect(bytesToHex(core.dleqProve(s))).not.toBe(bytesToHex(blob));
    const bad = blob.slice();
    bad[5000]! ^= 1;
    expect(() => core.dleqVerify(bad)).toThrow(/Dleq(Invalid|Malformed)/);
    const trailing = new Uint8Array(blob.length + 1);
    trailing.set(blob);
    expect(() => core.dleqVerify(trailing)).toThrow(/DleqMalformed/);
    expect(() => core.dleqVerify(new Uint8Array(60_001))).toThrow(/DleqTooLarge/);
  });

  it('keyLeaf, merkleRoot and merkleProof against a keccak re-computation', () => {
    const leaves = Array.from({ length: 16 }, (_, i) => core.keyLeaf(i, fill(i + 1, 20), fill(i + 2, 20), fill(i + 3)));
    // leaf = keccak(keccak(abi.encode(uint32, address, address, bytes32)))
    const enc = concatBytes(toBe(3n), new Uint8Array(12), fill(4, 20), new Uint8Array(12), fill(5, 20), fill(6));
    expect(bytesToHex(leaves[3]!)).toBe(bytesToHex(keccak_256(keccak_256(enc))));
    const node = (a: Uint8Array, b: Uint8Array) => (bytesToHex(a) <= bytesToHex(b) ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a)));
    let level = leaves;
    while (level.length > 1) level = level.flatMap((_, i) => (i % 2 ? [] : [node(level[i]!, level[i + 1]!)]));
    const root = core.merkleRoot(leaves);
    expect(bytesToHex(root)).toBe(bytesToHex(level[0]!));
    for (const i of [0, 5, 15]) {
      const proof = core.merkleProof(leaves, i);
      expect(proof.length).toBe(4);
      expect(bytesToHex(proof.reduce((h, sib) => node(h, sib), leaves[i]!))).toBe(bytesToHex(root));
    }
    expect(() => core.merkleRoot(leaves.slice(0, 3))).toThrow(/MerklePoolSize/);
    expect(() => core.merkleProof(leaves, 16)).toThrow(/MerkleIndex/);
  });
});

describe('envelopes and the lock notice (SPEC 2.8)', () => {
  const takerSecret = sha256(utf8ToBytes('taker enc'));
  const makerSecret = sha256(utf8ToBytes('maker enc'));
  const operatorSeed = sha256(utf8ToBytes('operator'));
  const operatorPub = ed25519.getPublicKey(operatorSeed);
  const takerPub = x25519.getPublicKey(takerSecret);
  const makerPub = x25519.getPublicKey(makerSecret);
  const text = (s: string) => utf8ToBytes(s);

  it('taker to maker and back', () => {
    const swapRef = fill(9);
    const env = core.envelopeSeal({ fromMaker: false, makerKeyVersion: 4, ownSecret: takerSecret, peerPub: makerPub, swapRef, plaintext: text('{"t":"inbox","text":"hi"}'), maxLen: core.ENVELOPE_MAX_ONCHAIN });
    expect([...env.subarray(0, 4)]).toEqual([0x58, 0x53, 1, 0]);
    const header = core.envelopeHeader(env);
    expect(header.makerKeyVersion).toBe(4);
    expect(bytesToHex(header.takerPub)).toBe(bytesToHex(takerPub));
    const opened = core.envelopeOpen({ envelope: env, ownSecret: makerSecret });
    expect(new TextDecoder().decode(opened.plaintext)).toBe('{"t":"inbox","text":"hi"}');
    expect(bytesToHex(opened.header.swapRef)).toBe(bytesToHex(swapRef));

    const reply = core.envelopeSign(
      core.envelopeSeal({ fromMaker: true, makerKeyVersion: 4, ownSecret: makerSecret, peerPub: takerPub, plaintext: text('{"t":"ack"}') }),
      operatorSeed,
    );
    expect(core.envelopeVerifySig(reply, operatorPub)).toBe(true);
    // The signature is plain Ed25519 over DS("envelope-sig") ‖ body: checked with @noble.
    const body = reply.subarray(0, reply.length - 64);
    expect(ed25519.verify(reply.subarray(reply.length - 64), concatBytes(ds('envelope-sig'), body), operatorPub)).toBe(true);
    const got = core.envelopeOpen({ envelope: reply, ownSecret: takerSecret, makerPub, operatorPub });
    expect(new TextDecoder().decode(got.plaintext)).toBe('{"t":"ack"}');
    expect(got.header.fromMaker).toBe(true);
    expect(() => core.envelopeOpen({ envelope: reply, ownSecret: takerSecret, makerPub })).toThrow(/EnvelopeBadSignature/);
    expect(() => core.envelopeOpen({ envelope: reply, ownSecret: takerSecret, makerPub, operatorPub: ed25519.getPublicKey(fill(3)) })).toThrow(/EnvelopeBadSignature/);
  });

  it('random nonces, size caps and low-order keys', () => {
    const a = core.envelopeSeal({ fromMaker: false, makerKeyVersion: 1, ownSecret: takerSecret, peerPub: makerPub, plaintext: text('x') });
    const b = core.envelopeSeal({ fromMaker: false, makerKeyVersion: 1, ownSecret: takerSecret, peerPub: makerPub, plaintext: text('x') });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(() => core.envelopeSeal({ fromMaker: false, makerKeyVersion: 1, ownSecret: takerSecret, peerPub: makerPub, plaintext: new Uint8Array(789), maxLen: 900 })).toThrow(/EnvelopeTooLarge/);
    expect(core.isLowOrderX25519(fill(0))).toBe(true);
    expect(core.isLowOrderX25519(makerPub)).toBe(false);
    expect(() => core.envelopeSeal({ fromMaker: false, makerKeyVersion: 1, ownSecret: takerSecret, peerPub: fill(0), plaintext: text('x') })).toThrow(/LowOrderEncryptionKey/);
  });

  it('lock notice: seal, open, and the commitment', () => {
    const swapRef = sha256(text('swap'));
    const txid = sha256(text('txid'));
    const view = toLe(le(sha256(text('view'))) % L);
    const commitment = core.noticeCommitment(swapRef, txid, view);
    expect(bytesToHex(commitment)).toBe(bytesToHex(sha256(concatBytes(ds('notice'), swapRef, txid, view))));
    const ct = core.noticeSeal({ ownSecret: makerSecret, peerPub: takerPub, side: 'maker', swapRef, txid, view });
    expect(ct.length).toBe(104);
    const opened = core.noticeOpen({ ownSecret: takerSecret, peerPub: makerPub, side: 'taker', swapRef, ciphertext: ct, commitment });
    expect(bytesToHex(opened.txid)).toBe(bytesToHex(txid));
    expect(bytesToHex(opened.view)).toBe(bytesToHex(view));
    expect(() => core.noticeOpen({ ownSecret: takerSecret, peerPub: makerPub, side: 'taker', swapRef, ciphertext: ct, commitment: fill(1) })).toThrow(/NoticeCommitmentMismatch/);
    const bad = ct.slice();
    bad[60]! ^= 1;
    expect(() => core.noticeOpen({ ownSecret: takerSecret, peerPub: makerPub, side: 'taker', swapRef, ciphertext: bad, commitment })).toThrow(/NoticeDecrypt/);
  });
});

describe('Solana byte formats (SPEC 2.9, 4.2, 3.12)', () => {
  it('encodeSolApproval is 190 bytes with the fields at their offsets', () => {
    const m = core.encodeSolApproval({ clusterTag: fill(1), programId: fill(2), maker: fill(3), taker: fill(4), asset: 1, direction: 0xff, maxXmr: 5_000_000_000_000n, notBefore: 1_800_000_000n, expiresAt: 1_800_086_400n, epoch: 7, approvalId: 99n });
    expect(m.length).toBe(190);
    expect(bytesToHex(m.subarray(0, 24))).toBe(bytesToHex(ds('sol-approval')));
    expect(m[152]).toBe(1);
    expect(m[153]).toBe(0xff);
    const view = new DataView(m.buffer, m.byteOffset);
    expect(view.getBigUint64(154, true)).toBe(5_000_000_000_000n);
    expect(view.getBigInt64(162, true)).toBe(1_800_000_000n);
    expect(view.getBigInt64(170, true)).toBe(1_800_086_400n);
    expect(view.getUint32(178, true)).toBe(7);
    expect(view.getBigUint64(182, true)).toBe(99n);
  });

  it('termsHash and openHashSolana are SHA-256 over the documented bytes', () => {
    const terms = core.termsHash({ asset: 0, direction: 1, mode: 0, depBps: 250, wA: 60, wN: 600, dC: 5400, wC: 1800, wF: 604800, depthAbove: [0n, 10n ** 12n, 50n * 10n ** 12n], depths: [2, 10, 25] });
    const pre = new Uint8Array(54);
    const dv = new DataView(pre.buffer);
    pre.set([0, 1, 0]);
    dv.setUint16(3, 250, true);
    dv.setUint16(5, 5, true);
    [60, 600, 5400, 1800, 604800].forEach((w, i) => dv.setUint32(7 + 4 * i, w, true));
    [[0n, 2], [10n ** 12n, 10], [50n * 10n ** 12n, 25]].forEach(([above, depth], i) => {
      dv.setBigUint64(27 + 9 * i, above as bigint, true);
      pre[35 + 9 * i] = depth as number;
    });
    expect(bytesToHex(terms)).toBe(bytesToHex(sha256(concatBytes(ds('terms'), pre))));

    const open = core.openHashSolana({ swap: fill(1), tLock: 1_800_000_000n, direction: 0, asset: 1, xmr: 2n * 10n ** 12n, amount: 300_000_000n, deposit: 3_000_000n, takerSpendPub: fill(2), lockerView: fill(3), takerEncKey: fill(4), makerEncKey: fill(5) });
    const u64 = (n: bigint) => toLe(n, 8);
    const expected = sha256(concatBytes(ds('open'), fill(1), u64(1_800_000_000n), Uint8Array.of(0, 1), u64(2n * 10n ** 12n), u64(300_000_000n), u64(3_000_000n), fill(2), fill(3), fill(4), fill(5)));
    expect(bytesToHex(open)).toBe(bytesToHex(expected));
  });
});

describe('EIP-712 (SPEC 2.10) against viem', () => {
  const types = {
    Quote: [
      { name: 'maker', type: 'address' }, { name: 'taker', type: 'address' }, { name: 'token', type: 'address' },
      { name: 'direction', type: 'uint8' }, { name: 'approvalMode', type: 'uint8' },
      { name: 'minXmr', type: 'uint64' }, { name: 'maxXmr', type: 'uint64' },
      { name: 'tierXmr', type: 'uint64[3]' }, { name: 'tierPrice', type: 'uint256[3]' },
      { name: 'depthXmr', type: 'uint64[3]' }, { name: 'depth', type: 'uint8[3]' },
      { name: 'depositBps', type: 'uint16' }, { name: 'approvalWindow', type: 'uint32' }, { name: 'noticeWindow', type: 'uint32' },
      { name: 'claimDelay', type: 'uint32' }, { name: 'claimWindow', type: 'uint32' }, { name: 'finalWindow', type: 'uint32' },
      { name: 'validUntil', type: 'uint64' }, { name: 'epoch', type: 'uint32' }, { name: 'keyRoot', type: 'bytes32' }, { name: 'quoteId', type: 'uint64' },
    ],
    Approval: [
      { name: 'maker', type: 'address' }, { name: 'taker', type: 'address' }, { name: 'token', type: 'address' },
      { name: 'direction', type: 'uint8' }, { name: 'maxXmr', type: 'uint64' }, { name: 'notBefore', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' }, { name: 'epoch', type: 'uint32' }, { name: 'approvalId', type: 'bytes32' },
    ],
  } as const;
  const quote: core.EthQuote = {
    maker: fill(0x11, 20), taker: fill(0, 20), token: fill(0, 20), direction: 0, approvalMode: 1,
    minXmr: 10n ** 11n, maxXmr: 10n ** 14n,
    tierXmr: [0n, 10n ** 12n, 50n * 10n ** 12n],
    tierPrice: [61n * 10n ** 15n, 605n * 10n ** 14n, 60n * 10n ** 15n],
    depthXmr: [0n, 10n ** 12n, 50n * 10n ** 12n], depth: [2, 10, 25],
    depositBps: 100, approvalWindow: 120, noticeWindow: 1800, claimDelay: 10800, claimWindow: 5400, finalWindow: 604800,
    validUntil: 1_800_000_150n, epoch: 3, keyRoot: fill(0xab), quoteId: 42n,
  };
  const domain: core.Eip712Domain = { chainId: 31337n, verifyingContract: fill(0xcc, 20) };
  const viemDomain = { name: 'XmrAtomicSwap', version: '1', chainId: 31337n, verifyingContract: hex0x(domain.verifyingContract) } as const;
  const viemQuote = {
    ...quote,
    maker: hex0x(quote.maker), taker: hex0x(quote.taker), token: hex0x(quote.token), keyRoot: hex0x(quote.keyRoot),
  };

  it('quoteDigest equals viem hashTypedData, fixed-size arrays included', () => {
    const digest = core.quoteDigest(domain, quote);
    const viemDigest = hashTypedData({ domain: viemDomain, types, primaryType: 'Quote', message: viemQuote });
    expect(hex0x(digest)).toBe(viemDigest);
    // Changing one array element changes it.
    const other = { ...quote, tierPrice: [quote.tierPrice[0], quote.tierPrice[1], quote.tierPrice[2] + 1n] as [bigint, bigint, bigint] };
    expect(hex0x(core.quoteDigest(domain, other))).not.toBe(viemDigest);
  });

  it('approvalDigest equals viem hashTypedData, and a viem signature recovers the signer', async () => {
    const approval: core.EthApproval = { maker: fill(0x11, 20), taker: fill(0x22, 20), token: fill(0xff, 20), direction: 255, maxXmr: 5n * 10n ** 12n, notBefore: 1_800_000_000n, validUntil: 1_800_086_400n, epoch: 2, approvalId: fill(0x77) };
    const message = { ...approval, maker: hex0x(approval.maker), taker: hex0x(approval.taker), token: hex0x(approval.token), approvalId: hex0x(approval.approvalId) };
    expect(hex0x(core.approvalDigest(domain, approval))).toBe(hashTypedData({ domain: viemDomain, types, primaryType: 'Approval', message }));
    const account = privateKeyToAccount(hex0x(fill(0x42)));
    const signature = await account.signTypedData({ domain: viemDomain, types, primaryType: 'Approval', message });
    expect(await recoverTypedDataAddress({ domain: viemDomain, types, primaryType: 'Approval', message, signature })).toBe(account.address);
  });

  it('compact form round-trips', () => {
    const compact = core.encodeEthQuoteCompact(quote);
    expect(compact.length).toBe(251);
    const signed = core.encodeEthQuoteCompact(quote, fill(7, 65));
    expect(signed.length).toBe(316);
    const back = core.decodeEthQuoteCompact(signed);
    expect(back.quote.tierPrice).toEqual(quote.tierPrice);
    expect(back.quote.validUntil).toBe(quote.validUntil);
    expect(back.quote.depth).toEqual([2, 10, 25]);
    expect(bytesToHex(back.sig!)).toBe(bytesToHex(fill(7, 65)));
    expect(hex0x(core.quoteDigest(domain, back.quote))).toBe(hex0x(core.quoteDigest(domain, quote)));
    expect(core.decodeEthQuoteCompact(compact).sig).toBeUndefined();
    expect(() => core.encodeEthQuoteCompact({ ...quote, tierPrice: [1n << 128n, 0n, 0n] })).toThrow(/FieldOutOfRange/);
  });

  it('ethSwapId and openHashEthereum', () => {
    const nonce = Uint8Array.from({ length: 16 }, (_, i) => i);
    const id = core.ethSwapId(fill(0x22, 20), nonce);
    expect(bytesToHex(id)).toBe(bytesToHex(keccak_256(concatBytes(new Uint8Array(12), fill(0x22, 20), nonce, new Uint8Array(16)))));
    const h = core.openHashEthereum({ swapId: id, tLock: 1_800_000_000n, direction: 1, token: fill(0x33, 20), xmr: 7n, amount: 1n << 100n, deposit: 5n, takerSpendPub: fill(1), takerKey: fill(2, 20), takerKey2: fill(3, 20), takerView: fill(4), takerEncKey: fill(5), makerEncKey: fill(6), keyLeaf: fill(7) });
    const expected = sha256(concatBytes(utf8ToBytes('xmrswap/v1/open'), Uint8Array.of(0), id, toBe(1_800_000_000n, 8), Uint8Array.of(1), fill(0x33, 20), toBe(7n, 8), toBe(1n << 100n), toBe(5n), fill(1), fill(2, 20), fill(3, 20), fill(4), fill(5), fill(6), fill(7)));
    expect(bytesToHex(h)).toBe(bytesToHex(expected));
  });
});

describe('arithmetic and deadlines (SPEC 3.1, 3.2)', () => {
  it('rounding and per-chain limits', () => {
    expect(core.payAmount(1n, 1n)).toBe(1n);
    expect(core.receiveAmount(1n, 1n)).toBe(0n);
    expect(core.payAmount(10n ** 12n, 150_000_000n, 'solana')).toBe(150_000_000n);
    expect(() => core.payAmount((1n << 64n) - 1n, 2n * 10n ** 12n, 'solana')).toThrow(/MathOverflow/);
    expect(core.payAmount((1n << 64n) - 1n, 2n * 10n ** 12n, 'ethereum')).toBe(2n * ((1n << 64n) - 1n));
    expect(core.depositOf(19_999n, 500)).toBe(999n);
    expect(core.feeOf(1_999n, 5)).toBe(0n);
    expect(core.splitOf(7n)).toEqual({ toTaker: 4n, toTreasury: 3n });
  });

  it('deadlines derive from event times and bounds are checked per chain', () => {
    const d = core.deadlines({ chain: 'solana', pending: 'none', wA: 60, wN: 600, dC: 3600, wC: 1800, wF: 604800, depth: 2, depBps: 100, tLock: 1_800_000_000n, tActive: 1_800_000_000n, tNotice: 1_800_000_100n, tReady: 1_800_001_500n, tRefund: 1_800_002_000n });
    expect(d.boundError).toBeNull();
    expect(d.deltaCut).toBe(1275n);
    expect(d.tPend).toBeNull();
    expect(d.tNote).toBe(1_800_000_600n);
    expect(d.tCut).toBe(1_800_001_375n);
    expect(d.tCo).toBe(1_800_003_700n);
    expect(d.tCd).toBe(1_800_003_300n);
    expect(d.tFinal).toBe(1_800_604_800n);
    expect(d.tNl).toBe(1_800_513_000n);
    expect(d.tExp).toBe(1_803_196_800n);
    expect(d.tHold).toBe(1_800_003_800n);
    expect(d.tSplit).toBe(1_805_186_000n);
    // The same parameters are below Ethereum's notice floor.
    expect(core.deadlines({ chain: 'ethereum', pending: 'approval', wA: 120, wN: 600, dC: 3600, wC: 1800, wF: 604800, depth: 2, depBps: 100, tLock: 0n }).boundError).toBe('NoticeWindowOutOfRange');
    expect(core.deadlines({ chain: 'ethereum', pending: 'approval', wA: 120, wN: 1800, dC: 7199, wC: 5400, wF: 604800, depth: 2, depBps: 100, tLock: 0n }).boundError).toBe('ClaimDelayTooShort');
    const ok = core.deadlines({ chain: 'ethereum', pending: 'approval', wA: 120, wN: 1800, dC: 7200, wC: 5400, wF: 604800, depth: 2, depBps: 100, tLock: 10n });
    expect(ok.boundError).toBeNull();
    expect(ok.tPend).toBe(130n);
    expect(ok.wP).toBe(120);
  });
});

describe('passphrase sealing (SPEC 2.12)', () => {
  it('round-trips, has the documented layout and rejects a wrong passphrase', () => {
    const sealed = core.passphraseSeal('correct horse', utf8ToBytes('seed'));
    expect(sealed[0]).toBe(1);
    expect(sealed.length).toBe(1 + 16 + 24 + 4 + 16);
    expect(new TextDecoder().decode(core.passphraseOpen('correct horse', sealed))).toBe('seed');
    expect(() => core.passphraseOpen('wrong horse', sealed)).toThrow(/PassphraseDecrypt/);
    expect(bytesToHex(core.passphraseSeal('correct horse', utf8ToBytes('seed')))).not.toBe(bytesToHex(sealed));
  });
});

describe('sweepJoint', () => {
  it('rejects bad parameters before touching the network', async () => {
    await expect(
      core.sweepJoint({ daemonUrl: 'http://127.0.0.1:1', network: 'regtest', spendKey: fill(0xff), viewKey: fill(1), lockHeight: 1, lockTxid: fill(2), outputIndex: 0n, destination: 'x', maxFee: 1n, publish: false }),
    ).rejects.toThrow(core.CoreError);
  });
});
