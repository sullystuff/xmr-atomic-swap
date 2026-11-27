// The wasm API must give the native results on every vector (SPEC 9.1). Each suite of
// interfaces/vectors is replayed through the nodejs build behind the typed wrapper.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import * as core from '../src/index.js';

const vectors = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../interfaces/vectors');
const suite = (name: string): any => JSON.parse(readFileSync(path.join(vectors, `${name}.json`), 'utf8'));
const hx = (s: string): Uint8Array => hexToBytes(s.startsWith('0x') ? s.slice(2) : s);
const hex = bytesToHex;
/** The error code thrown by `f`, or null if it returns. */
function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return (e as core.CoreError).code;
  }
}
const valid = (s: any) => s.cases.filter((c: any) => c.valid);
const invalid = (s: any) => s.cases.filter((c: any) => !c.valid);

beforeAll(async () => {
  await core.init();
});

describe('keys.json', () => {
  const s = suite('keys');
  it('derives every key', () => {
    let n = 0;
    for (const c of valid(s)) {
      if (c.input.maker_pda) {
        const id = core.contactShareId(hx(c.input.maker_pda));
        expect(hex(id), c.name).toBe(c.output.share_id);
        const k = core.deriveKeys(hx(c.input.seed), c.output.chain_tag, id);
        expect(hex(k.encSecret)).toBe(c.output.enc_secret);
        expect(hex(k.encPub)).toBe(c.output.enc_pub);
      } else {
        const k = core.deriveKeys(hx(c.input.seed), c.input.chain_tag, hx(c.input.share_id));
        expect({ spend: hex(k.spend), spend_pub: hex(k.spendPub), view: hex(k.view), session_secret: hex(k.sessionSecret), session_pub: hex(k.sessionPub), enc_secret: hex(k.encSecret), enc_pub: hex(k.encPub) }, c.name).toEqual(c.output);
      }
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(8);
    for (const c of invalid(s)) expect(codeOf(() => core.deriveKeys(hx(c.input.seed), c.input.chain_tag, hx(c.input.share_id))), c.name).toBe(c.error);
  });
});

describe('points.json', () => {
  const s = suite('points');
  it('the 18 invalid commitments and 100 valid ones', () => {
    const bad = invalid(s).filter((c: any) => !c.input.scalar);
    expect(bad.length).toBe(18);
    for (const c of bad) expect(core.validatePoint(hx(c.input.point)), c.name).toBe(false);
    expect(valid(s).length).toBe(100);
    for (const c of valid(s)) {
      expect(core.validatePoint(hx(c.input.point)), c.name).toBe(true);
      expect(core.scalarMatches(hx(c.output.scalar), hx(c.input.point)), c.name).toBe(true);
    }
    const wrong = invalid(s).filter((c: any) => c.input.scalar);
    expect(wrong.length).toBeGreaterThanOrEqual(5);
    for (const c of wrong) expect(core.scalarMatches(hx(c.input.scalar), hx(c.input.point)), c.name).toBe(false);
  });
  it("Monero's 272 secret_key_to_public_key rows", () => {
    const rows = s.monero_secret_key_to_public_key;
    expect(rows.length).toBe(272);
    expect(rows.filter((r: any) => r.valid).length).toBe(256);
    const anyPoint = hx(s.basepoint);
    for (const r of rows) {
      if (r.valid) {
        expect(core.scalarMatches(hx(r.secret), hx(r.public)), r.secret).toBe(true);
        expect(core.validatePoint(hx(r.public)), r.public).toBe(true);
      } else {
        // An unreduced secret opens nothing, and is refused as a scalar.
        expect(core.scalarMatches(hx(r.secret), anyPoint), r.secret).toBe(false);
        expect(codeOf(() => core.addScalars(hx(r.secret), new Uint8Array(32))), r.secret).toBe('ScalarNotCanonical');
      }
    }
  });
  it('the low-order X25519 table', () => {
    expect(s.low_order_x25519.length).toBe(14);
    for (const e of s.low_order_x25519) expect(core.isLowOrderX25519(hx(e.key)), e.key).toBe(true);
    for (const k of s.valid_x25519) expect(core.isLowOrderX25519(hx(k)), k).toBe(false);
  });
});

describe('pok.json', () => {
  const s = suite('pok');
  it('valid proofs are reproduced and verify; invalid ones are refused', () => {
    for (const c of valid(s)) {
      expect(hex(core.pokProve(hx(c.input.s), hx(c.input.ctx))), c.name).toBe(c.output.pok);
      expect(core.pokVerify(hx(c.output.S), hx(c.input.ctx), hx(c.output.pok)), c.name).toBe(true);
    }
    expect(invalid(s).length).toBeGreaterThanOrEqual(10);
    for (const c of invalid(s)) expect(core.pokVerify(hx(c.input.S), hx(c.input.ctx), hx(c.input.pok)), c.name).toBe(false);
  });
});

describe('joint_address.json', () => {
  const s = suite('joint_address');
  it('addresses on every network, and degenerate inputs', () => {
    const args = (c: any) => [hx(c.input.spend_pub_a), hx(c.input.spend_pub_b), hx(c.input.view_a), hx(c.input.view_b), c.input.network] as const;
    for (const c of valid(s)) {
      const j = core.jointAddress(...args(c));
      expect({ address: j.address, spend_pub: hex(j.spendPub), view_priv: hex(j.viewPriv), view_pub: hex(j.viewPub) }, c.name).toEqual(c.output);
    }
    expect(valid(s)[0].output.address).toBe('43MXoVqwCynJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXkmBPX');
    for (const c of invalid(s)) expect(codeOf(() => core.jointAddress(...args(c))), c.name).toBe(c.error);
  });
});

describe('twin.json', () => {
  const s = suite('twin');
  it('commitments, out-of-range scalars and mismatches', () => {
    for (const c of valid(s)) {
      const t = core.twinCommitments(hx(c.input.s));
      expect({ key_addr: hex(t.keyAddr), key_addr2: hex(t.keyAddr2), secp_compressed: hex(t.secpCompressed) }, c.name).toEqual(c.output);
      // The uint256 form is the same integer, big-endian.
      expect(c.input.secret_uint256).toBe(hex(hx(c.input.s).reverse()));
    }
    for (const c of invalid(s)) {
      if (c.input.key_addr) {
        // In range, but it does not open both commitments.
        const t = core.twinCommitments(hx(c.input.s));
        expect(hex(t.keyAddr) === c.input.key_addr && hex(t.keyAddr2) === c.input.key_addr2, c.name).toBe(false);
      } else {
        expect(codeOf(() => core.twinCommitments(hx(c.input.s))), c.name).toBe(c.error);
      }
    }
  });
});

describe('dleq.json and dleq/*.bin', () => {
  const s = suite('dleq');
  it('valid blobs verify to the listed statement; tampered ones fail with the listed error', () => {
    expect(valid(s).length).toBe(2);
    for (const c of s.cases) {
      const blob = new Uint8Array(readFileSync(path.join(vectors, c.input.file)));
      expect(blob.length, c.name).toBe(c.input.length);
      if (c.valid) {
        const st = core.dleqVerify(blob);
        expect({ spend_pub: hex(st.spendPub), secp_compressed: hex(st.secpCompressed), key_addr: hex(st.keyAddr), key_addr2: hex(st.keyAddr2) }, c.name).toEqual(c.output);
        // The revealed scalar opens both sides.
        expect(core.scalarMatches(hx(c.input.s), st.spendPub)).toBe(true);
        expect(hex(core.twinCommitments(hx(c.input.s)).keyAddr)).toBe(c.output.key_addr);
      } else {
        expect(codeOf(() => core.dleqVerify(blob)), c.name).toBe(c.error);
      }
    }
  });
});

describe('merkle.json', () => {
  const s = suite('merkle');
  const node = (a: Uint8Array, b: Uint8Array) => (hex(a) <= hex(b) ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a)));
  it('leaves, roots and proofs for pools of 2, 16 and 64', () => {
    const pools = valid(s);
    expect(pools.map((c: any) => c.input.leaves.length)).toEqual([2, 16, 64]);
    for (const c of pools) {
      const leaves = c.input.leaves.map((l: any) => core.keyLeaf(l.index, hx(l.key_addr), hx(l.key_addr2), hx(l.spend_pub)));
      expect(leaves.map(hex), c.name).toEqual(c.output.leaf_hashes);
      expect(hex(core.merkleRoot(leaves)), c.name).toBe(c.output.root);
      leaves.forEach((leaf: Uint8Array, i: number) => {
        const proof = core.merkleProof(leaves, i);
        expect(proof.map(hex)).toEqual(c.output.proofs[i]);
        expect(hex(proof.reduce(node, leaf))).toBe(c.output.root);
      });
    }
    for (const c of invalid(s)) {
      if (c.input.leaf_count !== undefined) {
        expect(codeOf(() => core.merkleRoot(Array.from({ length: c.input.leaf_count }, () => new Uint8Array(32)))), c.name).toBe('MerklePoolSize');
      } else {
        // What MerkleProof.verify computes does not reach the root.
        expect(hex(c.input.proof.map(hx).reduce(node, hx(c.input.leaf))), c.name).not.toBe(c.input.root);
      }
    }
  });
});

describe('notice.json', () => {
  const s = suite('notice');
  const k = s.keys;
  const keysFor = (who: 'taker' | 'maker', swapRef: string) =>
    who === 'maker'
      ? { ownSecret: hx(k.maker_secret), peerPub: hx(k.taker_pub), side: 'maker' as const, swapRef: hx(swapRef) }
      : { ownSecret: hx(k.taker_secret), peerPub: hx(k.maker_pub), side: 'taker' as const, swapRef: hx(swapRef) };
  it('commitment, sealing by either side, and every failure', () => {
    for (const c of valid(s)) {
      const i = c.input;
      expect(hex(core.noticeCommitment(hx(i.swap_ref), hx(i.txid), hx(i.view))), c.name).toBe(c.output.commitment);
      if (!i.sealed_by) continue;
      const ct = core.noticeSeal({ ...keysFor(i.sealed_by, i.swap_ref), txid: hx(i.txid), view: hx(i.view), nonce: hx(i.nonce) });
      expect(hex(ct), c.name).toBe(c.output.ciphertext);
      // The other side opens it.
      const other = i.sealed_by === 'maker' ? 'taker' : 'maker';
      const opened = core.noticeOpen({ ...keysFor(other, i.swap_ref), ciphertext: ct, commitment: hx(c.output.commitment) });
      expect([hex(opened.txid), hex(opened.view)]).toEqual([i.txid, i.view]);
    }
    expect(invalid(s).map((c: any) => c.error)).toContain('NoticeCommitmentMismatch');
    for (const c of invalid(s)) {
      const i = c.input;
      expect(codeOf(() => core.noticeOpen({ ...keysFor(i.opened_by, i.swap_ref), ciphertext: hx(i.ciphertext), commitment: hx(i.commitment) })), c.name).toBe(c.error);
    }
  });
});

describe('envelope.json', () => {
  const s = suite('envelope');
  const k = s.keys;
  it('sealing reproduces the bytes; opening returns the plaintext', () => {
    for (const c of valid(s)) {
      const i = c.input;
      const sealed = core.envelopeSeal({
        fromMaker: i.from_maker,
        makerKeyVersion: i.maker_key_version,
        ownSecret: hx(i.from_maker ? k.maker_secret : k.taker_secret),
        peerPub: hx(i.from_maker ? k.taker_pub : k.maker_pub),
        swapRef: hx(i.swap_ref),
        plaintext: hx(i.plaintext),
        nonce: hx(i.nonce),
      });
      const env = i.from_maker ? core.envelopeSign(sealed, hx(k.operator_seed)) : sealed;
      expect(hex(env), c.name).toBe(c.output.envelope);
      expect(env.length).toBe(c.output.length);
      const opened = i.from_maker
        ? core.envelopeOpen({ envelope: env, ownSecret: hx(k.taker_secret), makerPub: hx(k.maker_pub), operatorPub: hx(k.operator_pub) })
        : core.envelopeOpen({ envelope: env, ownSecret: hx(k.maker_secret) });
      expect(hex(opened.plaintext), c.name).toBe(i.plaintext);
      expect(new TextDecoder().decode(opened.plaintext)).toBe(i.plaintext_utf8);
      expect(opened.header.fromMaker).toBe(i.from_maker);
      expect(hex(opened.header.swapRef)).toBe(i.swap_ref);
      if (i.from_maker) expect(core.envelopeVerifySig(env, hx(k.operator_pub))).toBe(true);
    }
  });
  it('the largest responses fit the 900-byte on-chain cap', () => {
    const largest = valid(s).filter((c: any) => c.name.startsWith('largest-'));
    expect(largest.map((c: any) => c.name).sort()).toEqual(['largest-approval-response-ethereum', 'largest-approval-response-solana', 'largest-quote-response-ethereum', 'largest-quote-response-solana']);
    for (const c of largest) {
      expect(c.output.length, c.name).toBeLessThanOrEqual(900);
      expect(c.output.fits_onchain_cap).toBe(true);
      expect(JSON.parse(c.input.plaintext_utf8).ok).toBe(true);
    }
  });
  it('every tamper and misuse case fails with the listed error', () => {
    expect(invalid(s).length).toBeGreaterThanOrEqual(18);
    for (const c of invalid(s)) {
      const i = c.input;
      if (i.plaintext_len !== undefined) {
        expect(
          codeOf(() => {
            const sealed = core.envelopeSeal({ fromMaker: i.from_maker, makerKeyVersion: 3, ownSecret: hx(i.from_maker ? k.maker_secret : k.taker_secret), peerPub: hx(i.from_maker ? k.taker_pub : k.maker_pub), plaintext: new Uint8Array(i.plaintext_len).fill(97), maxLen: i.max_len });
            return i.from_maker ? core.envelopeSign(sealed, hx(k.operator_seed)) : sealed;
          }),
          c.name,
        ).toBe(c.error);
      } else if (i.opened_by === 'maker') {
        expect(codeOf(() => core.envelopeOpen({ envelope: hx(i.envelope), ownSecret: hx(k.maker_secret) })), c.name).toBe(c.error);
      } else {
        expect(codeOf(() => core.envelopeOpen({ envelope: hx(i.envelope), ownSecret: hx(k.taker_secret), makerPub: hx(k.maker_pub), ...(i.operator_pub ? { operatorPub: hx(i.operator_pub) } : {}) })), c.name).toBe(c.error);
      }
    }
  });
});

describe('sol_signed.json', () => {
  const s = suite('sol_signed');
  const fields = (a: any): core.SolApprovalFields => ({
    clusterTag: hx(a.cluster_tag), programId: hx(a.program_id), maker: hx(a.maker), taker: hx(a.taker), asset: a.asset, direction: a.direction,
    maxXmr: BigInt(a.max_xmr), notBefore: BigInt(a.not_before), expiresAt: BigInt(a.expires_at), epoch: a.epoch, approvalId: BigInt(a.approval_id),
  });
  it('approval bytes and signatures; validity is inclusive', () => {
    const withApproval = s.cases.filter((c: any) => c.input.approval);
    expect(withApproval.length).toBeGreaterThanOrEqual(12);
    for (const c of withApproval) {
      const msg = core.encodeSolApproval(fields(c.input.approval));
      expect(msg.length).toBe(190);
      expect(hex(msg), c.name).toBe(c.output.message);
      // The signature is plain Ed25519 by the fixed operator key (checked with @noble).
      expect(ed25519.verify(hx(c.output.signature), msg, hx(s.operator_pub)), c.name).toBe(true);
      // The precompile instruction data carries key, signature and message at the documented offsets.
      const ix = hx(c.output.ed25519_instruction_data);
      expect(ix.length).toBe(302);
      expect(hex(ix.subarray(16, 48))).toBe(s.operator_pub);
      expect(hex(ix.subarray(48, 112))).toBe(c.output.signature);
      expect(hex(ix.subarray(112))).toBe(c.output.message);
      // `valid` is whether the lock is admitted.
      const a = c.input.approval;
      const l = c.input.lock;
      const admits = a.not_before <= l.now && l.now <= a.expires_at && (a.asset === 255 || a.asset === l.asset) && (a.direction === 255 || a.direction === l.direction) && BigInt(l.xmr) <= BigInt(a.max_xmr) && a.epoch === l.approval_epoch;
      expect(admits, c.name).toBe(c.valid);
    }
    const names = s.cases.map((c: any) => [c.name, c.valid]);
    expect(names).toContainEqual(['at-not-before-minus-1', false]);
    expect(names).toContainEqual(['at-not-before', true]);
    expect(names).toContainEqual(['at-expires-at', true]);
    expect(names).toContainEqual(['at-expires-at-plus-1', false]);
  });
  it('signature and binding failures', () => {
    const raw = s.cases.filter((c: any) => c.input.message);
    expect(raw.length).toBeGreaterThanOrEqual(8);
    const base = hx(s.cases.find((c: any) => c.name === 'at-not-before').output.message);
    for (const c of raw) {
      const ok = ed25519.verify(hx(c.input.signature), hx(c.input.message), hx(c.input.signer_pub));
      if (c.error === 'SignatureInvalid') expect(ok, c.name).toBe(false);
      else {
        // A genuine signature over a message the program must still refuse: wrong signer, or a
        // binding field that differs from the transaction's.
        expect(ok, c.name).toBe(true);
        expect(c.input.signer_pub !== s.operator_pub || hex(base) !== c.input.message, c.name).toBe(true);
      }
    }
  });
  it('open hashes', () => {
    const open = s.cases.filter((c: any) => c.output?.open_hash);
    // Three before Amendment 1, plus a watcher (direction A) and a payout address (direction B).
    expect(open.length).toBe(5);
    expect(new Set(open.map((c: any) => c.output.open_hash)).size).toBe(5);
    for (const c of open) {
      const i = c.input;
      expect(
        hex(core.openHashSolana({ swap: hx(i.swap), tLock: BigInt(i.t_lock), direction: i.direction, asset: i.asset, xmr: BigInt(i.xmr), amount: BigInt(i.amount), deposit: BigInt(i.deposit), takerSpendPub: hx(i.taker_spend_pub), lockerView: hx(i.locker_view), takerEncKey: hx(i.taker_enc_key), makerEncKey: hx(i.maker_enc_key), payout: hx(i.payout), watcher: hx(i.watcher) })),
        c.name,
      ).toBe(c.output.open_hash);
    }
  });
});

describe('eip712.json', () => {
  const s = suite('eip712');
  const domain: core.Eip712Domain = { chainId: BigInt(s.domain.chainId), verifyingContract: hx(s.domain.verifyingContract) };
  const triple = <T>(a: T[]): [T, T, T] => [a[0]!, a[1]!, a[2]!];
  const quoteOf = (m: any): core.EthQuote => ({
    maker: hx(m.maker), taker: hx(m.taker), token: hx(m.token), direction: m.direction, approvalMode: m.approvalMode,
    minXmr: BigInt(m.minXmr), maxXmr: BigInt(m.maxXmr), tierXmr: triple(m.tierXmr.map(BigInt)), tierPrice: triple(m.tierPrice.map(BigInt)),
    depthXmr: triple(m.depthXmr.map(BigInt)), depth: triple(m.depth), depositBps: m.depositBps, approvalWindow: m.approvalWindow,
    noticeWindow: m.noticeWindow, claimDelay: m.claimDelay, claimWindow: m.claimWindow, finalWindow: m.finalWindow,
    validUntil: BigInt(m.validUntil), epoch: m.epoch, keyRoot: hx(m.keyRoot), quoteId: BigInt(m.quoteId), freezeWindow: m.freezeWindow,
  });
  const approvalOf = (m: any): core.EthApproval => ({
    maker: hx(m.maker), taker: hx(m.taker), token: hx(m.token), direction: m.direction, maxXmr: BigInt(m.maxXmr),
    notBefore: BigInt(m.notBefore), validUntil: BigInt(m.validUntil), epoch: m.epoch, approvalId: hx(m.approvalId),
  });
  const domainOf = (d: any): core.Eip712Domain => ({ chainId: BigInt(d.chainId), verifyingContract: hx(d.verifyingContract) });

  it('quote and approval digests, and the compact form', () => {
    let quotes = 0;
    let approvals = 0;
    for (const c of s.cases) {
      const td = c.input.typed_data;
      if (!td) continue;
      const expected = c.output?.digest ?? c.input.digest;
      if (!expected) continue;
      if (td.primaryType === 'Quote') {
        const q = quoteOf(td.message);
        expect('0x' + hex(core.quoteDigest(domainOf(td.domain), q)), c.name).toBe(expected);
        if (c.output?.compact) {
          expect(hex(core.encodeEthQuoteCompact(q)), c.name).toBe(c.output.compact);
          expect(core.encodeEthQuoteCompact(q).length, c.name).toBe(s.compact_len);
          expect(hex(core.encodeEthQuoteCompact(q, hx(c.output.signature))), c.name).toBe(c.output.compact_signed);
          const back = core.decodeEthQuoteCompact(hx(c.output.compact_signed));
          expect('0x' + hex(core.quoteDigest(domain, back.quote))).toBe(c.output.digest);
          expect('0x' + hex(back.sig!)).toBe(c.output.signature);
        }
        quotes++;
      } else {
        expect('0x' + hex(core.approvalDigest(domainOf(td.domain), approvalOf(td.message))), c.name).toBe(expected);
        approvals++;
      }
    }
    expect(s.compact_len).toBe(255);
    expect(s.quote_type.endsWith(',uint64 quoteId,uint32 freezeWindow)')).toBe(true);
    expect(quotes).toBeGreaterThanOrEqual(10);
    expect(approvals).toBeGreaterThanOrEqual(5);
  });
  it('swap id and open hashes', () => {
    const id = s.cases.find((c: any) => c.name === 'swap-id');
    expect('0x' + hex(core.ethSwapId(hx(id.input.taker), hx(id.input.swap_nonce)))).toBe(id.output.swap_id);
    const open = s.cases.filter((c: any) => c.output?.open_hash);
    expect(open.length).toBe(5);
    expect(new Set(open.map((c: any) => c.output.open_hash)).size).toBe(5);
    for (const c of open) {
      const i = c.input;
      expect(
        '0x' + hex(core.openHashEthereum({ swapId: hx(i.swap_id), tLock: BigInt(i.t_lock), direction: i.direction, token: hx(i.token), xmr: BigInt(i.xmr), amount: BigInt(i.amount), deposit: BigInt(i.deposit), takerSpendPub: hx(i.taker_spend_pub), takerKey: hx(i.taker_key), takerKey2: hx(i.taker_key2), takerView: hx(i.taker_view), takerEncKey: hx(i.taker_enc_key), makerEncKey: hx(i.maker_enc_key), keyLeaf: hx(i.key_leaf), payout: hx(i.payout), watcher: hx(i.watcher) })),
        c.name,
      ).toBe(c.output.open_hash);
    }
  });
});

describe('wallet_seed.json (SPEC 11.3)', () => {
  const s = suite('wallet_seed');
  const input = (c: any) => ({ tag: c.input.chain_tag as core.ChainTag, wallet: hx(c.input.wallet), sig: hx(c.input.signature) });

  it('every case: the seed, or the refusal', () => {
    expect(valid(s).length).toBeGreaterThanOrEqual(6);
    expect(invalid(s).length).toBeGreaterThanOrEqual(9);
    for (const c of valid(s)) {
      const { tag, wallet, sig } = input(c);
      const seed = core.walletSeed(tag, wallet, sig);
      expect(hex(seed), c.name).toBe(c.output.seed);
      // From the seed on, SPEC 2.2 unchanged: the spend commitment a returning user compares.
      expect(hex(core.deriveKeys(seed, tag, hx(c.output.swap_nonce)).spendPub), c.name).toBe(c.output.spend_pub);
      if (c.output.normalised_signature) expect('0x' + hex(core.normalizeEthSignature(sig)), c.name).toBe(c.output.normalised_signature);
    }
    for (const c of invalid(s)) {
      const { tag, wallet, sig } = input(c);
      expect(codeOf(() => core.walletSeed(tag, wallet, sig)), c.name).toBe(c.error);
    }
  });

  it('Solana: the message is the exact text, the signature verifies and is deterministic', () => {
    const c = s.cases.find((x: any) => x.name === 'solana');
    const m = c.message;
    const wallet = hx(c.input.wallet);
    const bytes = core.walletKeySolanaMessage(m.site, hx(m.genesis_hash), hx(m.program_id), wallet);
    expect(hex(bytes)).toBe(m.bytes);
    expect(new TextDecoder().decode(bytes)).toBe(m.text);
    expect(m.text).toBe(
      `Sign this only on ${m.site} to unlock your XMR swap keys.\nAnyone who gets this signature can take XMR you have not collected and act on your open swaps.\n\nxmrswap wallet key v1\ncluster: ${m.genesis_hash_base58}\nprogram: ${m.program_id_base58}\nwallet: ${m.wallet_base58}`,
    );
    expect(m.text.endsWith('\n')).toBe(false);
    // An independent Ed25519 signs the same bytes to the same signature, twice.
    const key = hx(m.wallet_private_seed);
    expect(hex(ed25519.getPublicKey(key))).toBe(c.input.wallet);
    expect(hex(ed25519.sign(bytes, key))).toBe(c.input.signature);
    expect(hex(ed25519.sign(bytes, key))).toBe(c.input.signature);
    expect(ed25519.verify(hx(c.input.signature), bytes, wallet)).toBe(true);
    // Another site, cluster, program or wallet: other bytes.
    expect(hex(core.walletKeySolanaMessage('other.example', hx(m.genesis_hash), hx(m.program_id), wallet))).not.toBe(m.bytes);
    expect(hex(core.walletKeySolanaMessage(m.site, hx(m.program_id), hx(m.genesis_hash), wallet))).not.toBe(m.bytes);
  });

  it('Ethereum: the digest is the typed-data digest; every spelling of the signature gives one seed', () => {
    const c = s.cases.find((x: any) => x.name === 'ethereum');
    const td = c.message.typed_data;
    const domain = { chainId: BigInt(td.domain.chainId), verifyingContract: hx(td.domain.verifyingContract) };
    expect('0x' + hex(core.walletKeyDigest(domain, td.message.site, hx(c.input.wallet)))).toBe(c.message.digest);
    expect(td.primaryType).toBe('WalletKey');
    expect(td.types.WalletKey).toEqual([
      { name: 'notice', type: 'string' }, { name: 'site', type: 'string' }, { name: 'keyVersion', type: 'uint32' }, { name: 'wallet', type: 'address' },
    ]);
    expect(td.message.notice).toBe(s.wallet_key_notice);
    expect(td.message.keyVersion).toBe(1);
    // The type hash is the WalletKey type's own.
    expect('0x' + hex(keccak_256(new TextEncoder().encode(s.wallet_key_type)))).toBe(s.wallet_key_type_hash);
    const seeds = new Set(s.cases.filter((x: any) => x.valid && x.name.startsWith('ethereum')).map((x: any) => x.output.seed));
    expect(seeds.size).toBe(1);
    const high = s.cases.find((x: any) => x.name === 'ethereum-high-s-normalised');
    expect(high.input.signature).not.toBe(c.input.signature);
    expect(high.output.normalised_signature).toBe(c.input.signature);
    // The two chains never share a seed.
    expect(s.cases.find((x: any) => x.name === 'solana').output.seed).not.toBe(c.output.seed);
  });
});

describe('watch_request.json and the notices of notice.json (SPEC 11.6)', () => {
  const s = suite('watch_request');
  const byOp = (op: string) => s.cases.filter((c: any) => c.input.op === op);

  it('notice key derivation', () => {
    expect(byOp('notice_key').length).toBe(4);
    for (const c of byOp('notice_key')) {
      const run = () => core.noticeKey(hx(c.input.own_secret), hx(c.input.peer_pub), c.input.side);
      if (c.valid) expect(hex(run()), c.name).toBe(c.output.notice_key);
      else expect(codeOf(run), c.name).toBe(c.error);
    }
  });

  it('the notice key opens every notice of notice.json, with no X25519 secret', () => {
    const n = suite('notice');
    const key = core.noticeKey(hx(n.keys.taker_secret), hx(n.keys.maker_pub), 'taker');
    expect(hex(key)).toBe(s.cases.find((c: any) => c.name === 'notice-key-taker').output.notice_key);
    let opened = 0;
    let refused = 0;
    for (const c of n.cases) {
      const i = c.input;
      if (c.valid && c.output?.ciphertext) {
        const got = core.noticeOpenWithKey({ key, swapRef: hx(i.swap_ref), ciphertext: hx(c.output.ciphertext), commitment: hx(c.output.commitment) });
        expect([hex(got.txid), hex(got.view)], c.name).toEqual([i.txid, i.view]);
        opened++;
      } else if (!c.valid && i.ciphertext && i.commitment && i.swap_ref) {
        // Whatever notice.json refuses for a party, the key alone refuses the same way.
        expect(codeOf(() => core.noticeOpenWithKey({ key, swapRef: hx(i.swap_ref), ciphertext: hx(i.ciphertext), commitment: hx(i.commitment) })), c.name).toBe(c.error);
        refused++;
      }
    }
    expect(opened).toBeGreaterThanOrEqual(3);
    expect(refused).toBeGreaterThanOrEqual(1);
  });

  it('keyed open cases', () => {
    expect(byOp('notice_open_with_key').length).toBe(6);
    for (const c of byOp('notice_open_with_key')) {
      const i = c.input;
      const run = () => core.noticeOpenWithKey({ key: hx(i.notice_key), swapRef: hx(i.swap_ref), ciphertext: hx(i.ciphertext), commitment: hx(i.commitment) });
      if (c.valid) expect([hex(run().txid), hex(run().view)], c.name).toEqual([c.output.txid, c.output.view]);
      else expect(codeOf(run), c.name).toBe(c.error);
    }
  });

  it('seal: the exact 104 bytes and the wire body', () => {
    expect(byOp('seal').length).toBe(2);
    for (const c of byOp('seal')) {
      const i = c.input;
      const sealed = core.watchRequestSeal({
        noticeKey: hx(i.notice_key), lockerEncSecret: hx(i.locker_enc_secret), watcher: hx(i.watcher), chainTag: i.chain_tag, deployment: i.deployment,
        swapRef: hx(i.swap_ref), issuedAt: BigInt(i.issued_at), ephemeralSecret: hx(i.ephemeral_secret), nonce: hx(i.nonce),
      });
      expect(sealed.length).toBe(core.SEALED_NOTICE_KEY_LEN);
      expect(hex(sealed), c.name).toBe(c.output.sealed);
      expect(Buffer.from(sealed).toString('base64'), c.name).toBe(c.output.body.notice_key);
      expect(c.output.body.v).toBe(core.WATCH_FORMAT);
      // Fresh randomness by default: two seals differ and both open.
      const fresh = { noticeKey: hx(i.notice_key), lockerEncSecret: hx(i.locker_enc_secret), watcher: hx(i.watcher), chainTag: i.chain_tag, deployment: i.deployment, swapRef: hx(i.swap_ref), issuedAt: BigInt(i.issued_at) };
      const a = core.watchRequestSeal(fresh);
      expect(hex(a)).not.toBe(hex(core.watchRequestSeal(fresh)));
      expect(hex(core.watchRequestOpen({ sealed: a, watcherSeed: hx(s.watcher.seed), lockerEncPub: hx(i.locker_enc_pub), chainTag: i.chain_tag, deployment: i.deployment, swapRef: hx(i.swap_ref), issuedAt: BigInt(i.issued_at) }))).toBe(i.notice_key);
    }
  });

  it('open: the locker\'s request opens; every other one is refused', () => {
    const opens = byOp('open');
    expect(opens.filter((c: any) => c.valid).length).toBe(2);
    expect(opens.filter((c: any) => !c.valid).length).toBe(13);
    for (const c of opens) {
      const i = c.input;
      const run = () => core.watchRequestOpen({ sealed: hx(i.sealed), watcherSeed: hx(i.watcher_seed), lockerEncPub: hx(i.locker_enc_pub), chainTag: i.chain_tag, deployment: i.deployment, swapRef: hx(i.swap_ref), issuedAt: BigInt(i.issued_at), format: i.format });
      if (c.valid) expect(hex(run()), c.name).toBe(c.output.notice_key);
      else expect(codeOf(run), c.name).toBe(c.error);
    }
    for (const name of ['reject-wrong-locker-key-stranger', 'reject-wrong-locker-key-counterparty', 'reject-wrong-watcher', 'reject-replay-onto-another-swap']) {
      expect(opens.find((c: any) => c.name === name).error, name).toBe('WatchKeyInvalid');
    }
    expect(opens.find((c: any) => c.name === 'reject-format-1').error).toBe('WatchFormatUnsupported');
    expect(opens.find((c: any) => c.name === 'reject-format-1').input.body.v).toBeUndefined();
  });
});

describe('terms.json', () => {
  it('terms hashes', () => {
    const s = suite('terms');
    expect(s.cases.length).toBeGreaterThanOrEqual(10);
    expect(s.cases.some((c: any) => c.input.w_z > 0)).toBe(true);
    for (const c of s.cases) {
      const i = c.input;
      expect(
        hex(core.termsHash({ asset: i.asset, direction: i.direction, mode: i.mode, depBps: i.dep_bps, feeBps: i.fee_bps, wA: i.w_a, wN: i.w_n, dC: i.d_c, wC: i.w_c, wF: i.w_f, depthAbove: i.depth_above.map(BigInt), depths: i.depths, wZ: i.w_z })),
        c.name,
      ).toBe(c.output.terms_hash);
    }
  });
});

describe('amounts.json', () => {
  const windows = {
    solana: { w_a: 60, w_n: 600, d_c: 5400, w_c: 1800, w_f: 604800, depth: 10, dep_bps: 100 },
    ethereum: { w_a: 120, w_n: 1800, d_c: 10800, w_c: 5400, w_f: 604800, depth: 10, dep_bps: 100 },
  };
  it('pay, receive, swap, deposit, fee, split and tiers; overflow per chain', () => {
    const s = suite('amounts');
    const seen = new Set<string>();
    for (const c of s.cases) {
      const i = c.input;
      seen.add(i.op);
      if (i.op === 'pay' || i.op === 'receive') {
        const f = i.op === 'pay' ? core.payAmount : core.receiveAmount;
        if (c.valid) expect(f(BigInt(i.xmr), BigInt(i.price), i.chain).toString(), c.name).toBe(c.output.amount);
        else expect(codeOf(() => f(BigInt(i.xmr), BigInt(i.price), i.chain)), c.name).toBe(c.error);
      } else if (i.op === 'bps') {
        expect(core.depositOf(BigInt(i.amount), i.bps).toString(), c.name).toBe(c.output.result);
        expect(core.feeOf(BigInt(i.amount), i.bps).toString(), c.name).toBe(c.output.result);
      } else if (i.op === 'split') {
        const r = core.splitOf(BigInt(i.deposit));
        expect([r.toTaker.toString(), r.toTreasury.toString()], c.name).toEqual([c.output.to_taker, c.output.to_treasury]);
      }
      else if (i.op === 'tier') {
        const three = (a: string[]): [bigint, bigint, bigint] => [BigInt(a[0]!), BigInt(a[1]!), BigInt(a[2]!)];
        if (c.valid) expect(core.tierValue(three(i.above), three(i.values), BigInt(i.xmr)).toString(), c.name).toBe(c.output.value);
        else expect(codeOf(() => core.tierValue(three(i.above), three(i.values), BigInt(i.xmr))), c.name).toBe(c.error);
      } else if (i.op === 'swap') {
        // The amount of a swap is pay (A) or receive (B); the zero rule is the model's, checked
        // by opening a swap of that size.
        const f = i.direction === 'A' ? core.payAmount : core.receiveAmount;
        const open = (amount: string) =>
          core.modelApply(i.chain, null, { call: i.direction === 'A' ? 'lock' : 'take', args: { direction: i.direction, offer_mode: 1, approval: false, xmr: i.xmr, amount, ...windows[i.chain as 'solana' | 'ethereum'] } }, 'taker', 1_800_000_000);
        if (c.valid) {
          expect(f(BigInt(i.xmr), BigInt(i.price), i.chain).toString(), c.name).toBe(c.output.amount);
          expect(open(c.output.amount).swap.amount, c.name).toBe(c.output.amount);
        } else {
          expect(c.error, c.name).toBe('AmountOutOfRange');
          const amount = i.xmr === '0' ? '0' : f(BigInt(i.xmr), BigInt(i.price), i.chain).toString();
          if (i.xmr !== '0') expect(amount, c.name).toBe('0');
          expect(codeOf(() => open(amount)), c.name).toBe('AmountOutOfRange');
          // A zero xmr is refused even with a nonzero amount.
          if (i.xmr === '0') expect(codeOf(() => open('5')), c.name).toBe('AmountOutOfRange');
        }
      }
      expect(Array.isArray(c.chains) && c.chains.length > 0, c.name).toBe(true);
    }
    expect([...seen].sort()).toEqual(['bps', 'pay', 'receive', 'split', 'swap', 'tier']);
  });
});

describe('deadlines.json', () => {
  it('bound checks and deadline derivation per chain', () => {
    const s = suite('deadlines');
    let bounds = 0;
    let derived = 0;
    for (const c of s.cases) {
      const i = c.input;
      const p = i.params;
      const params: core.DeadlineParams = {
        chain: i.chain, pending: i.pending, wA: p.w_a, wN: p.w_n, dC: p.d_c, wC: p.w_c, wF: p.w_f, depth: p.depth, depBps: p.dep_bps, wZ: p.w_z,
        tLock: BigInt(i.t_lock ?? 0),
        ...(i.t_active != null ? { tActive: BigInt(i.t_active) } : {}),
        ...(i.t_notice != null ? { tNotice: BigInt(i.t_notice) } : {}),
        ...(i.t_freeze != null ? { tFreeze: BigInt(i.t_freeze) } : {}),
        ...(i.t_ready != null ? { tReady: BigInt(i.t_ready) } : {}),
        ...(i.t_refund != null ? { tRefund: BigInt(i.t_refund) } : {}),
      };
      const d = core.deadlines(params);
      if (i.op === 'bounds') {
        bounds++;
        expect(d.boundError, c.name).toBe(c.valid ? null : c.error);
        if (c.valid) {
          expect({ w_p: d.wP, delta_cut: Number(d.deltaCut), min_claim_delay: Number(d.minClaimDelay), min_claim_window: Number(d.minClaimWindow), min_final_window: Number(d.minFinalWindow) }, c.name).toEqual(c.output);
        }
      } else {
        derived++;
        const n = (v: bigint | null) => (v === null ? null : Number(v));
        expect(
          { t_pend: n(d.tPend), t_note: n(d.tNote), t_cut: n(d.tCut), t_co: n(d.tCo), t_ready_min: n(d.tReadyMin), t_ff: n(d.tFf), t_cd: n(d.tCd), t_final: n(d.tFinal), t_nl: n(d.tNl), t_exp: n(d.tExp), t_hold: n(d.tHold), t_split: n(d.tSplit) },
          c.name,
        ).toEqual(c.output);
      }
    }
    expect(bounds).toBeGreaterThanOrEqual(80);
    expect(derived).toBeGreaterThanOrEqual(18);
    // Amendment 1: the freeze-window bounds, and a derived T_ff.
    const byName = (name: string) => s.cases.find((c: any) => c.name === name);
    expect(byName('solana-freeze-window-below-floor').error).toBe('FreezeWindowOutOfRange');
    expect(byName('ethereum-freeze-window-over-cap').error).toBe('FreezeWindowOutOfRange');
    expect(byName('solana-freeze-window-final-window-below-floor-approval').error).toBe('FinalWindowOutOfRange');
    expect(byName('solana-derive-extreme-frozen-depth-10').output.t_ff).toBeGreaterThan(byName('solana-derive-extreme-frozen-depth-10').output.t_co);
    expect(s.bound_check_order).toEqual(['DepositTooHigh', 'ApprovalWindowOutOfRange', 'NoticeWindowOutOfRange', 'DepthInvalid', 'ClaimDelayTooShort', 'ClaimWindowTooShort', 'FreezeWindowOutOfRange', 'FinalWindowOutOfRange']);
  });
});

describe('transitions.json through the wasm model', () => {
  const t = suite('transitions');
  /** Run a vector step; the result in the shape of its `expect`. */
  const run = (chain: core.ChainName, state: core.ModelSwap | null, step: any): any => {
    const call = { call: step.call, args: step.args } as core.ModelCall;
    const enabled = core.modelEnabled(chain, state, call, step.caller, step.at, step.env);
    try {
      const fx = core.modelApply(chain, state, call, step.caller, step.at, step.env);
      expect(enabled).toBe(true);
      return fx;
    } catch (e) {
      expect(enabled).toBe(false);
      return { ok: false, error: (e as core.CoreError).code };
    }
  };

  it('every row: the wasm model gives the native result', () => {
    expect(t.rows.length).toBe(t.summary.solana.rows + t.summary.ethereum.rows);
    expect(t.rows.length).toBeGreaterThanOrEqual(1_150);
    let accepted = 0;
    let rejected = 0;
    for (const row of t.rows) {
      const label = `${row.chain} ${row.id}: ${row.case}`;
      let state: core.ModelSwap | null = null;
      for (const step of [...(row.open ? [row.open] : []), ...row.setup]) state = core.modelApply(row.chain, state, { call: step.call, args: step.args } as core.ModelCall, step.caller, step.at, step.env).swap;
      if (row.from) expect(state, label).toEqual(row.from);
      expect(run(row.chain, state, row.step), label).toEqual(row.step.expect);
      if (row.ok) accepted++;
      else rejected++;
    }
    expect(accepted).toBeGreaterThan(500);
    expect(rejected).toBeGreaterThan(500);
  });

  it('every sequence: states, payouts and counters step by step', () => {
    // 182 per chain before Amendment 1; the amendment's exit, invariant-3, payout and freeze sequences since.
    expect(t.sequences.length).toBe(t.summary.solana.sequences + t.summary.ethereum.sequences);
    expect(t.sequences.length).toBeGreaterThanOrEqual(640);
    for (const seq of t.sequences) {
      let state: core.ModelSwap | null = null;
      let openValue = '0';
      for (const [i, step] of seq.steps.entries()) {
        // The open value is threaded through the env, like the maker record by the caller.
        expect(step.env.caps.open_value, `${seq.chain} ${seq.name} step ${i}`).toBe(openValue);
        const got = run(seq.chain, state, step);
        // The maker record is kept by the caller, not by the model: compare everything else.
        const { maker: _maker, ...want } = step.expect;
        expect(got, `${seq.chain} ${seq.name} step ${i} ${step.call}`).toEqual(want);
        if (got.ok) {
          state = got.swap;
          openValue = got.open_value_after;
        }
      }
      expect(state, `${seq.chain} ${seq.name}`).toEqual(seq.final.swap);
      expect(openValue, `${seq.chain} ${seq.name}`).toBe(seq.final.open_value);
    }
  });

  it('multi-swap sequences: the open value is the sum of the counted values of the open swaps', () => {
    expect(t.multi_sequences.length).toBe(4);
    const open = new Set(['PENDING', 'ACTIVE', 'NOTICED', 'READY', 'FROZEN', 'ABORTED_FREE', 'ABORTED_HOLD']);
    for (const seq of t.multi_sequences) {
      const swaps: (core.ModelSwap | null)[] = Array.from({ length: seq.swaps }, () => null);
      let openValue = 0n;
      for (const [i, step] of seq.steps.entries()) {
        const label = `${seq.chain} ${seq.name} step ${i} ${step.call}`;
        expect(BigInt(step.env.caps.open_value), label).toBe(openValue);
        const got = run(seq.chain, swaps[step.swap]!, step);
        const { maker: _maker, ...want } = step.expect;
        expect(got, label).toEqual(want);
        if (got.ok) {
          swaps[step.swap] = got.swap;
          openValue = BigInt(got.open_value_after);
        } else {
          // A cap refuses only lock and take.
          expect(['lock', 'take'], label).toContain(step.call);
        }
        const sum = swaps.reduce((acc, s) => acc + (s && open.has(s.state) ? BigInt(s.amount) + (s.direction === 'B' ? BigInt(s.deposit) : 0n) : 0n), 0n);
        expect(openValue, label).toBe(sum);
      }
      expect(swaps, seq.name).toEqual(seq.final.swaps);
      expect(openValue.toString()).toBe(seq.final.open_value);
    }
  });

  it('refusals carry the chain error name; malformed input is a BadArgument', () => {
    const open: core.ModelCall = { call: 'lock', args: { direction: 'A', offer_mode: 0, approval: false, xmr: '1000000000000', amount: '1500000000', w_a: 60, w_n: 600, d_c: 5400, w_c: 1800, w_f: 604800, depth: 10, dep_bps: 100 } };
    const s = core.modelApply('solana', null, open, 'taker', 1_800_000_000n).swap;
    expect(s.state).toBe('ACTIVE');
    expect(codeOf(() => core.modelApply('solana', s, { call: 'refund', args: { secret_ok: false } }, 'session', 1_800_000_010))).toBe('ScalarMismatch');
    expect(codeOf(() => core.modelApply('solana', s, { call: 'claim', args: { secret_ok: true } }, 'operator', 1_800_000_010))).toBe('BadState');
    expect(core.modelEnabled('solana', s, { call: 'refund', args: { secret_ok: true } }, 'session', 1_800_000_010)).toBe(true);
    expect(core.modelEnabled('solana', s, { call: 'refund', args: { secret_ok: true } }, 'operator', 1_800_000_010)).toBe(false);
    // Pay or park through env.
    const parked = core.modelApply('solana', s, { call: 'refund', args: { secret_ok: true } }, 'session', 1_800_000_010, { taker_can_receive: false });
    expect(parked.payouts).toEqual([{ to: 'taker', amount: '1485000000', parked: true }]);
    expect(codeOf(() => core.modelApply('solana', s, { call: 'steal' } as never, 'session', 1))).toBe('BadArgument');
    expect(codeOf(() => core.modelApply('bitcoin' as never, s, { call: 'abort' }, 'operator', 1))).toBe('BadArgument');
    expect(codeOf(() => core.modelEnabled('solana', { ...s, state: 'LOST' as never }, { call: 'abort' }, 'operator', 1))).toBe('BadArgument');
  });
});
