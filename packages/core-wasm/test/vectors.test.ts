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
    expect(open.length).toBe(3);
    for (const c of open) {
      const i = c.input;
      expect(
        hex(core.openHashSolana({ swap: hx(i.swap), tLock: BigInt(i.t_lock), direction: i.direction, asset: i.asset, xmr: BigInt(i.xmr), amount: BigInt(i.amount), deposit: BigInt(i.deposit), takerSpendPub: hx(i.taker_spend_pub), lockerView: hx(i.locker_view), takerEncKey: hx(i.taker_enc_key), makerEncKey: hx(i.maker_enc_key) })),
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
    validUntil: BigInt(m.validUntil), epoch: m.epoch, keyRoot: hx(m.keyRoot), quoteId: BigInt(m.quoteId),
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
    expect(quotes).toBeGreaterThanOrEqual(8);
    expect(approvals).toBeGreaterThanOrEqual(5);
  });
  it('swap id and open hashes', () => {
    const id = s.cases.find((c: any) => c.name === 'swap-id');
    expect('0x' + hex(core.ethSwapId(hx(id.input.taker), hx(id.input.swap_nonce)))).toBe(id.output.swap_id);
    const open = s.cases.filter((c: any) => c.output?.open_hash);
    expect(open.length).toBe(3);
    for (const c of open) {
      const i = c.input;
      expect(
        '0x' + hex(core.openHashEthereum({ swapId: hx(i.swap_id), tLock: BigInt(i.t_lock), direction: i.direction, token: hx(i.token), xmr: BigInt(i.xmr), amount: BigInt(i.amount), deposit: BigInt(i.deposit), takerSpendPub: hx(i.taker_spend_pub), takerKey: hx(i.taker_key), takerKey2: hx(i.taker_key2), takerView: hx(i.taker_view), takerEncKey: hx(i.taker_enc_key), makerEncKey: hx(i.maker_enc_key), keyLeaf: hx(i.key_leaf) })),
        c.name,
      ).toBe(c.output.open_hash);
    }
  });
});

describe('terms.json', () => {
  it('terms hashes', () => {
    const s = suite('terms');
    expect(s.cases.length).toBeGreaterThanOrEqual(6);
    for (const c of s.cases) {
      const i = c.input;
      expect(
        hex(core.termsHash({ asset: i.asset, direction: i.direction, mode: i.mode, depBps: i.dep_bps, feeBps: i.fee_bps, wA: i.w_a, wN: i.w_n, dC: i.d_c, wC: i.w_c, wF: i.w_f, depthAbove: i.depth_above.map(BigInt), depths: i.depths })),
        c.name,
      ).toBe(c.output.terms_hash);
    }
  });
});

describe('amounts.json', () => {
  it('pay, receive, deposit, fee and split; overflow per chain', () => {
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
      // `tier` cases have no wasm function: tier selection happens inside the contracts and is
      // replayed there and in the Rust tests.
    }
    expect([...seen].sort()).toEqual(['bps', 'pay', 'receive', 'split', 'tier']);
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
        chain: i.chain, pending: i.pending, wA: p.w_a, wN: p.w_n, dC: p.d_c, wC: p.w_c, wF: p.w_f, depth: p.depth, depBps: p.dep_bps,
        tLock: BigInt(i.t_lock ?? 0),
        ...(i.t_active != null ? { tActive: BigInt(i.t_active) } : {}),
        ...(i.t_notice != null ? { tNotice: BigInt(i.t_notice) } : {}),
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
          { t_pend: n(d.tPend), t_note: n(d.tNote), t_cut: n(d.tCut), t_co: n(d.tCo), t_ready_min: n(d.tReadyMin), t_cd: n(d.tCd), t_final: n(d.tFinal), t_nl: n(d.tNl), t_exp: n(d.tExp), t_hold: n(d.tHold), t_split: n(d.tSplit) },
          c.name,
        ).toEqual(c.output);
      }
    }
    expect(bounds).toBeGreaterThanOrEqual(60);
    expect(derived).toBeGreaterThanOrEqual(12);
  });
});
