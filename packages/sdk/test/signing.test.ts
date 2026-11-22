// Quote and advance-approval signing and verification, Solana formats and EIP-712, against
// sol_signed.json and eip712.json. Negative cases: bad signatures, replay across cluster,
// program, chain and contract, stale epochs, validity boundaries.
import { beforeAll, describe, expect, it } from 'vitest';
import { Ed25519Program } from '@solana/web3.js';
import { decodeEthQuoteCompact, init } from '@xmrswap/core-wasm';
import { type Address, EIP712_TYPE_STRINGS, type Hex, type Maker, type Offer, type Quote, base58Encode } from '@xmrswap/protocol';
import { keccak256, toHex } from 'viem';
import {
  type EthDeployment,
  type EthMakerState,
  EMPTY_ETH_APPROVAL,
  approvalFromMessage,
  approvalMessage,
  decodeSignedQuote,
  encodeSignedQuote,
  ethApprovalDigest,
  ethApprovalProblem,
  ethQuoteDigest,
  ethQuoteProblem,
  quoteFromMessage,
  quoteMessage,
  recoverSigner,
  signEthApproval,
  signEthQuote,
  verifyBoardQuote,
  verifyEthApproval,
  verifyEthQuote,
} from '../src/signing/eip712.js';
import { type SolApprovalBinding, offerProblem, offerTermsHash, parseSolApproval, signSolApproval, solApprovalFromResponse, solApprovalProblem, solApprovalResponse, solQuoteProblem, verifyEd25519 } from '../src/signing/solana.js';
import { approvalEd25519Data, approvalEd25519Ix } from '../src/solana/tx.js';
import { codeOf, hex, unhex } from '../src/util.js';
import { vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

describe('sol_signed.json: advance approvals', () => {
  const v = vector('sol_signed');
  const cases = v.cases.filter((c: any) => !c.name.startsWith('open-hash'));
  const fieldsOf = (a: any) => ({
    clusterTag: unhex(a.cluster_tag),
    programId: unhex(a.program_id),
    maker: unhex(a.maker),
    taker: unhex(a.taker),
    asset: a.asset,
    direction: a.direction,
    maxXmr: BigInt(a.max_xmr),
    notBefore: BigInt(a.not_before),
    expiresAt: BigInt(a.expires_at),
    epoch: a.epoch,
    approvalId: BigInt(a.approval_id),
  });
  // What the program holds the approval against: taken from the reference approval, never from the message under test.
  const ref = v.cases[1].input.approval;
  const bind: SolApprovalBinding = { clusterTag: unhex(ref.cluster_tag), programId: unhex(ref.program_id), maker: unhex(ref.maker), taker: unhex(ref.taker), operator: unhex(v.operator_pub) };

  it('signs the exact 190 bytes and reproduces the vector signatures and Ed25519 instruction', () => {
    let n = 0;
    for (const c of cases.filter((c: any) => c.input.approval && c.output)) {
      const signed = signSolApproval(unhex(v.operator_seed), fieldsOf(c.input.approval));
      expect(signed.message.length).toBe(v.message_len);
      expect(hex(signed.message), c.name).toBe(c.output.message);
      expect(hex(signed.signature), c.name).toBe(c.output.signature);
      expect(hex(signed.operatorPub)).toBe(v.operator_pub);
      const data = approvalEd25519Data(signed.operatorPub, signed.signature, signed.message);
      expect(hex(data), c.name).toBe(c.output.ed25519_instruction_data);
      const ix = approvalEd25519Ix(signed.operatorPub, signed.signature, signed.message);
      expect(ix.programId.equals(Ed25519Program.programId)).toBe(true);
      expect(ix.keys.length).toBe(0);
      // Exactly one signature; all three instruction-index fields are 0xFFFF.
      expect(data[0]).toBe(1);
      expect([data[4], data[5], data[8], data[9], data[14], data[15]]).toEqual([255, 255, 255, 255, 255, 255]);
      // The fields read back at the offsets of SPEC 2.9.
      expect(parseSolApproval(signed.message)).toEqual(fieldsOf(c.input.approval));
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(12);
  });

  it('accepts and refuses exactly what the program does, case by case', () => {
    let refused = 0;
    for (const c of cases) {
      const i = c.input;
      const message = unhex(i.message ?? c.output.message);
      const signature = unhex(i.signature ?? c.output.signature);
      // `signer_pub`: the key inside the instruction when it is not maker.operator.
      const operatorPub = unhex(i.signer_pub ?? i.operator_pub ?? c.output.operator_pub);
      const use = { asset: i.lock.asset, direction: i.lock.direction, xmr: BigInt(i.lock.xmr), now: BigInt(i.lock.now), approvalEpoch: i.lock.approval_epoch };
      const got = solApprovalProblem({ message, signature, operatorPub }, bind, use);
      expect(got, `${c.name}${i.note ? ` (${i.note})` : ''}`).toBe(c.valid ? null : c.error);
      if (!c.valid) refused++;
    }
    expect(refused).toBe(15);
  });

  it('refuses a replay for another cluster, program, maker or taker even with a valid signature', () => {
    const good = v.cases.find((c: any) => c.name === 'at-not-before');
    const a = { message: unhex(good.output.message), signature: unhex(good.output.signature), operatorPub: unhex(good.output.operator_pub) };
    const use = { asset: 1, direction: 0, xmr: 1n, now: BigInt(good.input.lock.now), approvalEpoch: 7 };
    expect(solApprovalProblem(a, bind, use)).toBe(null);
    const other = new Uint8Array(32).fill(9);
    for (const k of ['clusterTag', 'programId', 'maker', 'taker'] as const) expect(solApprovalProblem(a, { ...bind, [k]: other }, use), k).toBe('ApprovalInvalid');
    // A valid signature by a key that is not the registered operator.
    expect(solApprovalProblem(a, { ...bind, operator: other }, use)).toBe('ApprovalInvalid');
    // One flipped bit anywhere in the signed bytes.
    const flipped = a.message.slice();
    flipped[160]! ^= 1;
    expect(solApprovalProblem({ ...a, message: flipped }, bind, use)).toBe('SignatureInvalid');
    expect(verifyEd25519(a.signature, a.message, a.operatorPub)).toBe(true);
    expect(verifyEd25519(a.signature.subarray(0, 63), a.message, a.operatorPub)).toBe(false);
  });

  it('round-trips through an approval_response: the client fills in cluster, program, maker and taker', () => {
    const c = v.cases.find((c: any) => c.name === 'wildcards-sol-a');
    const signed = signSolApproval(unhex(v.operator_seed), fieldsOf(c.input.approval));
    const response = solApprovalResponse(signed);
    expect(response).toMatchObject({ t: 'approval_response', ok: true, chain: 'solana', asset: 255, direction: 255 });
    const rebuilt = solApprovalFromResponse(response, bind);
    expect(hex(rebuilt.message)).toBe(hex(signed.message));
    // The same response presented by another taker does not verify.
    expect(codeOf(() => solApprovalFromResponse(response, { ...bind, taker: new Uint8Array(32).fill(7) }))).toBe('SignatureInvalid');
    expect(codeOf(() => solApprovalFromResponse({ ...response, max_xmr: (BigInt(response.max_xmr) + 1n).toString() }, bind))).toBe('SignatureInvalid');
    expect(codeOf(() => parseSolApproval(signed.message.subarray(0, 189)))).toBe('ApprovalInvalid');
    expect(codeOf(() => approvalEd25519Data(signed.operatorPub, signed.signature, signed.message.subarray(0, 189)))).toBe('BadApproval');
  });
});

describe('Solana offers and taker-bound quotes', () => {
  const X = 1_000_000_000_000n;
  const makerPda = base58Encode(new Uint8Array(32).fill(3));
  const taker = base58Encode(new Uint8Array(32).fill(4));
  const maker = { paused: 0, quoteEpoch: 5 } as Maker;
  const offerBase = { asset: 0, direction: 0, mode: 0, enabled: 1, seq: 12n, updatedAt: 1_800_000_000n, validSecs: 60, depBps: 100, wA: 60, wN: 600, dC: 6060, wC: 1800, wF: 604_800, depthAbove: [0n, X, 50n * X], depths: Uint8Array.of(2, 10, 25) } as unknown as Offer;
  let offer: Offer;
  beforeAll(() => {
    offer = { ...offerBase, termsHash: offerTermsHash(offerBase) } as Offer;
  });

  it('an offer is live through updated_at + valid_secs inclusive, with the terms the user saw', () => {
    expect(offerProblem(offer, maker, 1_800_000_060n, { termsHash: offer.termsHash, minSeq: 12n })).toBe(null);
    expect(offerProblem(offer, maker, 1_800_000_061n)).toBe('OfferStale');
    expect(offerProblem({ ...offer, enabled: 0 } as Offer, maker, 1_800_000_000n)).toBe('OfferDisabled');
    expect(offerProblem(offer, { ...maker, paused: 2 } as Maker, 1_800_000_000n)).toBe('Paused');
    expect(offerProblem(offer, maker, 1_800_000_000n, { minSeq: 13n })).toBe('SeqTooOld');
    // The maker changed a term after the user looked: the stored hash moved.
    const changed = { ...offerBase, dC: 6061 } as Offer;
    expect(offerProblem({ ...changed, termsHash: offerTermsHash(changed) } as Offer, maker, 1_800_000_000n, { termsHash: offer.termsHash })).toBe('TermsChanged');
    // A stored hash that is not the hash of the stored terms.
    expect(offerProblem({ ...changed, termsHash: offer.termsHash } as Offer, maker, 1_800_000_000n)).toBe('TermsChanged');
  });

  it('a taker-bound quote account must be the one asked for, unexpired and of the current epoch', () => {
    const q = { maker: makerPda, taker, asset: 1, direction: 0, xmr: 300n * X, amount: 45_000_000_000n, expiresAt: 1_800_000_100n, epoch: 5, quoteId: 77n } as Quote;
    const want = { makerPda, taker, asset: 1, direction: 0, xmr: 300n * X, quoteId: 77n, now: 1_800_000_000n };
    expect(solQuoteProblem(q, maker, want)).toBe(null);
    expect(solQuoteProblem(q, maker, { ...want, now: 1_800_000_100n })).toBe(null);
    expect(solQuoteProblem(q, maker, { ...want, now: 1_800_000_101n })).toBe('QuoteExpired');
    expect(solQuoteProblem(q, { ...maker, quoteEpoch: 6 } as Maker, want)).toBe('StaleEpoch');
    expect(solQuoteProblem(q, { ...maker, paused: 1 } as Maker, want)).toBe('Paused');
    for (const wrong of [{ taker: makerPda }, { makerPda: taker }, { asset: 0 }, { direction: 1 }, { xmr: 299n * X }, { quoteId: 78n }]) expect(solQuoteProblem(q, maker, { ...want, ...wrong }), JSON.stringify(wrong, (_k, x) => (typeof x === 'bigint' ? `${x}` : x))).toBe('QuoteMismatch');
    // Valid for more than 120 s from now: not a quote this program would have accepted.
    expect(solQuoteProblem({ ...q, expiresAt: 1_800_000_121n } as Quote, maker, want)).toBe('QuoteMismatch');
  });
});

describe('eip712.json: quotes and approvals', () => {
  const v = vector('eip712');
  const dOf = (td: any): EthDeployment => ({ chainId: BigInt(td.domain.chainId), contract: td.domain.verifyingContract });
  const real: EthDeployment = { chainId: BigInt(v.domain.chainId), contract: v.domain.verifyingContract };
  const operator = v.operator as Address;
  const key = v.operator_private_key as Hex;
  const quotes = v.cases.filter((c: any) => c.input.typed_data?.primaryType === 'Quote');
  const approvals = v.cases.filter((c: any) => c.input.typed_data?.primaryType === 'Approval');

  it('uses exactly the frozen type strings', () => {
    expect(EIP712_TYPE_STRINGS.Quote).toBe(v.quote_type);
    expect(EIP712_TYPE_STRINGS.Approval).toBe(v.approval_type);
    expect(keccak256(toHex(EIP712_TYPE_STRINGS.Quote))).toBe(v.quote_type_hash);
    expect(keccak256(toHex(EIP712_TYPE_STRINGS.Approval))).toBe(v.approval_type_hash);
  });

  it('computes the digest, signs to the vector signature and recovers the operator', async () => {
    let n = 0;
    for (const c of v.cases.filter((c: any) => c.valid && c.output?.signature && c.input.typed_data)) {
      const td = c.input.typed_data;
      const d = dOf(td);
      if (td.primaryType === 'Quote') {
        const q = quoteFromMessage(td.message);
        expect(ethQuoteDigest(d, q), c.name).toBe(c.output.digest);
        const sig = await signEthQuote(key, d, q);
        expect(`0x${hex(sig)}`, c.name).toBe(c.output.signature);
        expect(await verifyEthQuote(d, q, sig, operator), c.name).toBe(true);
        // The compact board form carries every field and the signature.
        const compact = encodeSignedQuote(q, sig);
        expect(hex(compact), c.name).toBe(c.output.compact_signed);
        expect(hex(compact.subarray(0, v.compact_len)), c.name).toBe(c.output.compact);
        const back = decodeSignedQuote(compact);
        expect(quoteMessage(back.quote), c.name).toEqual(quoteMessage(q));
        expect(hex(back.sig)).toBe(hex(sig));
      } else {
        const a = approvalFromMessage(td.message);
        expect(ethApprovalDigest(d, a), c.name).toBe(c.output.digest);
        const sig = await signEthApproval(key, d, a);
        expect(`0x${hex(sig)}`, c.name).toBe(c.output.signature);
        expect(await verifyEthApproval(d, a, sig, operator), c.name).toBe(true);
        expect(approvalMessage(approvalFromMessage(td.message))).toEqual(approvalMessage(a));
      }
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it('judges every quote case as the contract does', async () => {
    const maker = (epoch: number): EthMakerState => ({ operator, quoteEpoch: epoch, approvalEpoch: 0, paused: false });
    const firstSig = v.cases[0].output.signature;
    let refused = 0;
    for (const c of quotes) {
      const td = c.input.typed_data;
      const q = quoteFromMessage(td.message);
      const sig = unhex(c.input.signature ?? c.output.signature);
      const now = BigInt(c.input.now ?? BigInt(td.message.validUntil) - 100n);
      const sender = (BigInt(td.message.taker) === 0n ? '0x00000000000000000000000000000000000000aa' : td.message.taker) as Address;
      const got = await ethQuoteProblem(dOf(td), q, sig, maker(q.epoch), { now, direction: q.direction, sender, minLeftSecs: 0 });
      expect(got, c.name).toBe(c.valid ? null : c.error);
      if (!c.valid) {
        refused++;
        if (c.input.expected_signer) {
          // The vector's digest is what the contract would recover from; nobody we know signed it.
          expect(ethQuoteDigest(dOf(td), q)).toBe(c.input.digest);
          const signer = await recoverSigner(c.input.digest, sig);
          expect(signer === null || signer !== c.input.expected_signer, c.name).toBe(true);
        }
      }
    }
    expect(refused).toBe(5);
    // The replayed quote is the first vector's signature under another chain id / contract.
    for (const name of ['quote-replayed-on-another-chain', 'quote-replayed-on-another-contract', 'quote-tampered-price']) expect(v.cases.find((c: any) => c.name === name).input.signature, name).toBe(firstSig);
  });

  it('refuses a high-s signature, a bad v and a wrong length, as ECDSA.recoverCalldata does', async () => {
    const c = v.cases.find((c: any) => c.name === 'quote-high-s-signature');
    const q = quoteFromMessage(c.input.typed_data.message);
    const high = unhex(c.input.signature);
    expect(await recoverSigner(c.input.digest, high)).toBe(null);
    expect(await verifyEthQuote(real, q, high, operator)).toBe(false);
    const good = unhex(v.cases[0].output.signature);
    expect(await recoverSigner(v.cases[0].output.digest, good)).toBe(operator);
    const badV = good.slice();
    badV[64] = 1;
    expect(await recoverSigner(v.cases[0].output.digest, badV)).toBe(null);
    expect(await recoverSigner(v.cases[0].output.digest, good.subarray(0, 64))).toBe(null);
    expect(await verifyEthQuote(real, q, good, '0x00000000000000000000000000000000000000aa')).toBe(false);
  });

  it('judges quote state: registration, pause, epoch, cancellation, direction, binding, time left', async () => {
    const bound = v.cases.find((c: any) => c.name === 'quote-bound-usdc-a');
    const q = quoteFromMessage(bound.input.typed_data.message);
    const sig = unhex(bound.output.signature);
    const taker = bound.input.typed_data.message.taker as Address;
    const ok = { now: q.validUntil - 100n, direction: q.direction, sender: taker };
    const m: EthMakerState = { operator, quoteEpoch: q.epoch, approvalEpoch: 0, paused: false };
    expect(await ethQuoteProblem(real, q, sig, m, ok)).toBe(null);
    expect(await ethQuoteProblem(real, q, sig, { ...m, operator: '0x0000000000000000000000000000000000000000' }, ok)).toBe('NotRegistered');
    expect(await ethQuoteProblem(real, q, sig, { ...m, paused: true }, ok)).toBe('Paused');
    expect(await ethQuoteProblem(real, q, sig, { ...m, quoteEpoch: q.epoch + 1 }, ok)).toBe('StaleEpoch');
    expect(await ethQuoteProblem(real, q, sig, m, { ...ok, cancelled: true })).toBe('Cancelled');
    expect(await ethQuoteProblem(real, q, sig, m, { ...ok, direction: 1 })).toBe('WrongDirection');
    // A taker-bound quote in somebody else's hands.
    expect(await ethQuoteProblem(real, q, sig, m, { ...ok, sender: '0x00000000000000000000000000000000000000aa' })).toBe('WrongParty');
    // The UI refuses to submit with under 36 s of validity left.
    expect(await ethQuoteProblem(real, q, sig, m, { ...ok, now: q.validUntil - 36n })).toBe(null);
    expect(await ethQuoteProblem(real, q, sig, m, { ...ok, now: q.validUntil - 35n })).toBe('TooLittleTimeLeft');
  });

  it('judges every approval case as the contract does', async () => {
    let refused = 0;
    for (const c of approvals.filter((c: any) => c.input.lock)) {
      const td = c.input.typed_data;
      const a = approvalFromMessage(td.message);
      const l = c.input.lock;
      const got = await ethApprovalProblem(dOf(td), a, unhex(c.input.signature), { operator, approvalEpoch: l.approval_epoch }, { now: BigInt(l.now), sender: l.sender, token: l.token, direction: l.direction, xmr: BigInt(l.xmr) });
      expect(got, c.name).toBe(c.valid ? null : c.error);
      if (!c.valid) refused++;
    }
    expect(refused).toBe(7);
    const c = approvals.find((c: any) => c.name === 'approval-at-not-before');
    const a = approvalFromMessage(c.input.typed_data.message);
    const l = c.input.lock;
    const use = { now: BigInt(l.now), sender: l.sender, token: l.token, direction: l.direction, xmr: BigInt(l.xmr) };
    expect(await ethApprovalProblem(real, a, unhex(c.input.signature), { operator, approvalEpoch: l.approval_epoch }, { ...use, revoked: true })).toBe('Revoked');
    // Replay on another chain or contract, and a signature by somebody else.
    expect(await ethApprovalProblem({ ...real, chainId: 1n }, a, unhex(c.input.signature), { operator, approvalEpoch: l.approval_epoch }, use)).toBe('BadSigner');
    expect(await ethApprovalProblem({ ...real, contract: '0xe45dc83b9da8924974ea13a8898f58a601ee9481' }, a, unhex(c.input.signature), { operator, approvalEpoch: l.approval_epoch }, use)).toBe('BadSigner');
    expect(await ethApprovalProblem(real, a, unhex(c.input.signature), { operator: '0x00000000000000000000000000000000000000aa', approvalEpoch: l.approval_epoch }, use)).toBe('BadSigner');
    expect(approvalMessage(EMPTY_ETH_APPROVAL).maker).toBe('0x0000000000000000000000000000000000000000');
  });

  it('shows a board quote only when its maker is the mutually linked address and the operator signed it', async () => {
    const c = v.cases[0];
    const q = quoteFromMessage(c.input.typed_data.message);
    const sig = unhex(c.output.signature);
    const slot = { quote: unhex(c.output.compact), sig };
    const maker: EthMakerState = { operator, quoteEpoch: q.epoch, approvalEpoch: 0, paused: false };
    const linked = c.input.typed_data.message.maker as Address;
    const now = q.validUntil - 60n;
    const shown = await verifyBoardQuote(real, slot, { linkedEthMaker: linked, maker, now });
    expect(shown.ok && quoteMessage(shown.quote)).toEqual(quoteMessage(q));
    // One maker posting another's quote: the quote's maker is not the address linked to the board's owner.
    expect(await verifyBoardQuote(real, slot, { linkedEthMaker: '0x00000000000000000000000000000000000000aa', maker, now })).toEqual({ ok: false, reason: 'NotLinked' });
    expect(await verifyBoardQuote(real, slot, { linkedEthMaker: null, maker, now })).toEqual({ ok: false, reason: 'NotLinked' });
    expect(await verifyBoardQuote(real, slot, { linkedEthMaker: linked, maker, now: q.validUntil + 1n })).toEqual({ ok: false, reason: 'Expired' });
    expect(await verifyBoardQuote(real, slot, { linkedEthMaker: linked, maker: { ...maker, quoteEpoch: q.epoch + 1 }, now })).toEqual({ ok: false, reason: 'StaleEpoch' });
    expect(await verifyBoardQuote({ ...real, chainId: 1n }, slot, { linkedEthMaker: linked, maker, now })).toEqual({ ok: false, reason: 'BadSigner' });
    // A refresh that overwrote a dynamic field without a fresh signature.
    const stale = slot.quote.slice();
    stale[110]! ^= 1;
    expect(await verifyBoardQuote(real, { quote: stale, sig }, { linkedEthMaker: linked, maker, now })).toEqual({ ok: false, reason: 'BadSigner' });
    expect(await verifyBoardQuote(real, { quote: slot.quote.subarray(0, 250), sig }, { linkedEthMaker: linked, maker, now })).toEqual({ ok: false, reason: 'Malformed' });
    expect(decodeEthQuoteCompact(slot.quote).sig).toBeUndefined();
    expect(codeOf(() => decodeSignedQuote(slot.quote))).toBe('BadSignature');
  });
});
