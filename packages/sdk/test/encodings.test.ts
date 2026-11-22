// The SDK's own use of the encodings must agree with the frozen vectors: key derivation for a
// swap, the joint address, the notice, the terms hash, the open hashes, tier lookup, deadlines.
import { beforeAll, describe, expect, it } from 'vitest';
import { CHAIN_TAG, init } from '@xmrswap/core-wasm';
import { CHAIN_CONSTS, type Offer, SWAP_FLAG, SWAP_STATE, base58Encode } from '@xmrswap/protocol';
import { buildNotice, checkCounterpartyShare, contactKeys, evidenceOpens, expectedOpen, exportJointWallet, jointSpendKey, makerShareKeys, openNotice, swapJointAddress, takerSwapKeys } from '../src/flows/keys.js';
import { NO_SWAP, apply } from '../src/machine/model.js';
import { type SwapView, deadlinesOf, viewFromEthereum, type EthSwapStruct } from '../src/machine/view.js';
import { priceEthQuote, priceOffer, tierValue } from '../src/registry/pricing.js';
import { offerTermsHash } from '../src/signing/solana.js';
import { quoteFromMessage } from '../src/signing/eip712.js';
import { codeOf, hex, unhex } from '../src/util.js';
import { vector } from './helpers.js';

beforeAll(async () => {
  await init();
});

const z32 = new Uint8Array(32);
function baseView(over: Partial<SwapView>): SwapView {
  return {
    ...NO_SWAP,
    chain: 'solana',
    swapRef: z32,
    taker: '',
    maker: '',
    asset: '0',
    xmr: 0n,
    price: 0n,
    depBps: 0,
    swapNonce: new Uint8Array(16),
    sessionKey: '',
    takerEncKey: z32,
    makerEncVersion: 1,
    makerEncKey: z32,
    takerSpendPub: z32,
    makerSpendPub: z32,
    lockerView: z32,
    noticeCommitment: z32,
    noticeCt: new Uint8Array(0),
    evidenceTxid: z32,
    evidenceView: z32,
    revealed: z32,
    ...over,
  };
}

describe('keys.json', () => {
  const v = vector('keys');
  it('derives a swap\'s keys from the seed and the on-chain nonce', () => {
    let n = 0;
    for (const c of v.cases.filter((c: any) => c.valid && c.input.share_id)) {
      const chain = c.input.chain_tag === CHAIN_TAG.solana ? 'solana' : 'ethereum';
      for (const derive of [takerSwapKeys, makerShareKeys]) {
        const k = derive(unhex(c.input.seed), chain, unhex(c.input.share_id));
        expect(hex(k.spend), c.name).toBe(c.output.spend);
        expect(hex(k.spendPub), c.name).toBe(c.output.spend_pub);
        expect(hex(k.view), c.name).toBe(c.output.view);
        expect(hex(k.sessionSecret), c.name).toBe(c.output.session_secret);
        expect(hex(k.sessionPub), c.name).toBe(c.output.session_pub);
        expect(hex(k.encSecret), c.name).toBe(c.output.enc_secret);
        expect(hex(k.encPub), c.name).toBe(c.output.enc_pub);
      }
      n++;
    }
    expect(n).toBe(6);
  });
  it('derives the per-maker contact key', () => {
    for (const c of v.cases.filter((c: any) => c.input.maker_pda)) {
      for (const pda of [unhex(c.input.maker_pda), base58Encode(unhex(c.input.maker_pda))]) {
        const k = contactKeys(unhex(c.input.seed), pda);
        expect(hex(k.encSecret)).toBe(c.output.enc_secret);
        expect(hex(k.encPub)).toBe(c.output.enc_pub);
      }
    }
  });
  it('refuses a seed or nonce of the wrong length', () => {
    expect(codeOf(() => takerSwapKeys(new Uint8Array(31), 'solana', new Uint8Array(16)))).toBe('BadSeed');
    expect(codeOf(() => takerSwapKeys(new Uint8Array(32), 'solana', new Uint8Array(15)))).toBe('BadNonce');
  });
});

describe('joint_address.json', () => {
  const v = vector('joint_address');
  it('computes the joint address of a swap from its four halves, on every network', () => {
    for (const c of v.cases.filter((c: any) => c.valid)) {
      // Direction A: the taker's view share is in the swap; the maker's comes from the notice.
      const s = baseView({ direction: 0, makerSpendPub: unhex(c.input.spend_pub_a), takerSpendPub: unhex(c.input.spend_pub_b), lockerView: unhex(c.input.view_b) });
      const j = swapJointAddress(s, unhex(c.input.view_a), c.input.network);
      expect(j.address, c.name).toBe(c.output.address);
      expect(hex(j.spendPub), c.name).toBe(c.output.spend_pub);
      expect(hex(j.viewPriv), c.name).toBe(c.output.view_priv);
      expect(hex(j.viewPub), c.name).toBe(c.output.view_pub);
    }
  });
  it('treats a swap with a bad half as unusable', () => {
    for (const c of v.cases.filter((c: any) => !c.valid)) {
      const s = baseView({ makerSpendPub: unhex(c.input.spend_pub_a), takerSpendPub: unhex(c.input.spend_pub_b), lockerView: unhex(c.input.view_b) });
      const code = codeOf(() => swapJointAddress(s, unhex(c.input.view_a), c.input.network));
      // A zero half is "not known yet" to the SDK before it ever reaches the core.
      expect(code === c.error || code === 'NoLockerView' || code === 'NoMakerShare', `${c.name}: ${code}`).toBe(true);
      expect(code).not.toBe(null);
    }
  });
  it('refuses a counterparty commitment equal to our own', () => {
    const c = v.cases[0];
    const own = unhex(c.input.spend_pub_a);
    expect(codeOf(() => checkCounterpartyShare(own, own))).toBe('OwnShareReplayed');
    expect(codeOf(() => swapJointAddress(baseView({ makerSpendPub: own, takerSpendPub: own, lockerView: unhex(c.input.view_b) }), unhex(c.input.view_a), 'mainnet'))).toBe('OwnShareReplayed');
    expect(codeOf(() => checkCounterpartyShare(unhex(vector('points').cases[0].input.point), own))).toBe('InvalidKeyCommitment');
  });
  it('exports the joint wallet once both spend shares are known', () => {
    const m = vector('monero_tx').keys;
    // Direction A, maker claimed: the revealed share is the maker's.
    const s = baseView({ direction: 0, state: SWAP_STATE.DONE, flags: SWAP_FLAG.NOTICE | SWAP_FLAG.REVEALED, makerSpendPub: unhex(m.maker.spend_pub), takerSpendPub: unhex(m.taker.spend_pub), lockerView: unhex(m.taker.view), revealed: unhex(m.maker.spend) });
    const joint = swapJointAddress(s, unhex(m.maker.view), 'regtest');
    expect(joint.address).toBe(m.joint.address);
    const spend = jointSpendKey(s, unhex(m.taker.spend), 'taker');
    expect(hex(spend)).toBe(m.joint.spend_priv);
    expect(exportJointWallet(joint, spend, unhex('40c82938b3cc4731eded08f635d30e708e615eca7e43d7feab37053b6901daa0'), 160)).toEqual({
      address: m.joint.address,
      view_key: m.joint.view_priv,
      spend_key: m.joint.spend_priv,
      lock_txid: '40c82938b3cc4731eded08f635d30e708e615eca7e43d7feab37053b6901daa0',
      lock_height: 160,
    });
    // The revealed scalar must open the commitment of the party that revealed it.
    expect(codeOf(() => jointSpendKey({ ...s, revealed: unhex(m.taker.spend) }, unhex(m.taker.spend), 'taker'))).toBe('ScalarMismatch');
    expect(codeOf(() => jointSpendKey(s, unhex(m.maker.spend), 'taker'))).toBe('ScalarMismatch');
    expect(codeOf(() => jointSpendKey(s, unhex(m.maker.spend), 'maker'))).toBe('OwnShareRevealed');
    expect(codeOf(() => jointSpendKey({ ...s, flags: 0 }, unhex(m.taker.spend), 'taker'))).toBe('NothingRevealed');
    // Direction B, maker refunded: again the maker's share, flagged as the locker's.
    const b = { ...s, direction: 1 as const, flags: SWAP_FLAG.REVEALED | SWAP_FLAG.REVEALER_LOCKER };
    expect(hex(jointSpendKey(b, unhex(m.taker.spend), 'taker'))).toBe(m.joint.spend_priv);
  });
});

describe('notice.json', () => {
  const v = vector('notice');
  const k = v.keys;
  const swapFor = (c: any, direction: 0 | 1, extra: Partial<SwapView> = {}) =>
    baseView({ direction, swapRef: unhex(c.input.swap_ref), takerEncKey: unhex(k.taker_pub), makerEncKey: unhex(k.maker_pub), flags: SWAP_FLAG.NOTICE, ...extra });

  it('builds the notice the claimer posts, and the locker opens it', () => {
    let n = 0;
    for (const c of v.cases.filter((c: any) => c.valid && c.input.sealed_by)) {
      const byMaker = c.input.sealed_by === 'maker';
      const s = swapFor(c, byMaker ? 0 : 1);
      const txid = unhex(c.input.txid);
      const view = unhex(c.input.view);
      // Our own seal (random nonce) has the vector's commitment and opens to the same plaintext.
      const built = buildNotice(s, unhex(byMaker ? k.maker_secret : k.taker_secret), txid, view);
      expect(hex(built.commitment), c.name).toBe(c.output.commitment);
      expect(built.ciphertext.length).toBe(104);
      for (const ct of [built.ciphertext, unhex(c.output.ciphertext)]) {
        const posted = { ...s, noticeCommitment: built.commitment, noticeCt: ct };
        const opened = openNotice(posted, unhex(byMaker ? k.taker_secret : k.maker_secret));
        expect(opened && hex(opened.txid), c.name).toBe(c.input.txid);
        expect(opened && hex(opened.view), c.name).toBe(c.input.view);
        expect(evidenceOpens(posted, txid, view)).toBe(true);
        expect(evidenceOpens(posted, txid, unhex(k.maker_secret))).toBe(false);
      }
      n++;
    }
    expect(n).toBe(3);
  });

  it('treats every tampered or mismatching notice as "no lock"', () => {
    const bad = v.cases.filter((c: any) => !c.valid);
    expect(bad.length).toBe(7);
    for (const c of bad) {
      const byTaker = c.input.opened_by === 'taker';
      const s = swapFor(c, byTaker ? 0 : 1, { noticeCommitment: unhex(c.input.commitment), noticeCt: unhex(c.input.ciphertext) });
      expect(openNotice(s, unhex(byTaker ? k.taker_secret : k.maker_secret)), c.name).toBe(null);
    }
    // No notice on record is also "no lock".
    const c = v.cases[1];
    expect(openNotice(swapFor(c, 0, { flags: 0, noticeCommitment: unhex(c.output.commitment), noticeCt: unhex(c.output.ciphertext) }), unhex(k.taker_secret))).toBe(null);
  });

  it('refuses a low-order counterparty key', () => {
    const c = v.cases[1];
    const low = unhex(vector('points').low_order_x25519[4].key);
    expect(codeOf(() => buildNotice(swapFor(c, 0, { takerEncKey: low }), unhex(k.maker_secret), unhex(c.input.txid), unhex(c.input.view)))).toBe('LowOrderEncryptionKey');
    expect(codeOf(() => buildNotice(swapFor(c, 0), unhex(k.maker_secret), new Uint8Array(31), unhex(c.input.view)))).toBe('BadTxid');
  });
});

describe('terms.json', () => {
  it('recomputes an offer\'s terms hash from its own fields', () => {
    let n = 0;
    for (const c of vector('terms').cases) {
      const i = c.input;
      // An offer has no fee field: the program hashes its own FEE_BPS. The one vector with another fee is the core's.
      if (i.fee_bps !== CHAIN_CONSTS.solana.feeBps) continue;
      n++;
      const offer = { asset: i.asset, direction: i.direction, mode: i.mode, depBps: i.dep_bps, wA: i.w_a, wN: i.w_n, dC: i.d_c, wC: i.w_c, wF: i.w_f, depthAbove: i.depth_above.map(BigInt), depths: Uint8Array.from(i.depths) } as unknown as Offer;
      expect(hex(offerTermsHash(offer)), c.name).toBe(c.output.terms_hash);
    }
    expect(n).toBe(6);
  });
});

describe('open hashes (sol_signed.json, eip712.json)', () => {
  it('computes expected_open for a pending Solana swap', () => {
    const cases = vector('sol_signed').cases.filter((c: any) => c.name.startsWith('open-hash'));
    expect(cases.length).toBe(3);
    const seen = new Set<string>();
    for (const c of cases) {
      const i = c.input;
      const s = baseView({
        chain: 'solana',
        state: SWAP_STATE.PENDING,
        swapRef: unhex(i.swap),
        tLock: BigInt(i.t_lock),
        direction: i.direction,
        asset: String(i.asset),
        xmr: BigInt(i.xmr),
        amount: BigInt(i.amount),
        deposit: BigInt(i.deposit),
        takerSpendPub: unhex(i.taker_spend_pub),
        lockerView: unhex(i.locker_view),
        takerEncKey: unhex(i.taker_enc_key),
        makerEncKey: unhex(i.maker_enc_key),
      });
      expect(hex(expectedOpen(s)), c.name).toBe(c.output.open_hash);
      seen.add(c.output.open_hash);
      expect(codeOf(() => expectedOpen({ ...s, state: SWAP_STATE.ACTIVE }))).toBe('BadState');
    }
    // A re-lock at the same PDA with another size has another open hash (M-4).
    expect(seen.size).toBe(3);
  });

  it('computes expected_open for a pending Ethereum swap and checks it against storage', () => {
    const cases = vector('eip712').cases.filter((c: any) => c.name.startsWith('open-hash'));
    expect(cases.length).toBe(3);
    for (const c of cases) {
      const i = c.input;
      const zero = `0x${'00'.repeat(32)}`;
      const struct: EthSwapStruct = {
        taker: `0x${'11'.repeat(20)}`, maker: `0x${'22'.repeat(20)}`, token: i.token, sessionKey: `0x${'33'.repeat(20)}`, swapNonce: `0x${'44'.repeat(16)}`,
        state: 1, direction: i.direction, mode: 0, outcome: 255, depositState: 0, depth: 2, flags: 0, depBps: 100, makerEncVersion: 1,
        xmr: BigInt(i.xmr), amount: BigInt(i.amount), deposit: BigInt(i.deposit), price: 0n, noticeWindow: 1800, claimDelay: 10800, claimWindow: 5400,
        takerKey: i.taker_key, takerKey2: i.taker_key2, takerSpendPub: i.taker_spend_pub, makerKey: `0x${'00'.repeat(20)}`, makerKey2: `0x${'00'.repeat(20)}`, makerSpendPub: zero,
        lockerView: i.taker_view, takerEncKey: i.taker_enc_key, makerEncKey: i.maker_enc_key, noticeCommitment: zero, noticeCiphertext: '0x', evidenceTxid: zero, evidenceView: zero,
        keyLeaf: i.key_leaf, openHash: c.output.open_hash, revealed: 0n,
        tLock: BigInt(i.t_lock), tPendingDeadline: BigInt(i.t_lock) + 120n, tActive: 0n, tNoteDeadline: 0n, tNotice: 0n, tCut: 0n, tClaimOpen: 0n, tReady: 0n, tClaimDeadline: 0n, tFinal: BigInt(i.t_lock) + 604800n, tRefund: 0n, tSettled: 0n,
      };
      const s = viewFromEthereum(i.swap_id, struct);
      expect(`0x${hex(expectedOpen(s))}`, c.name).toBe(c.output.open_hash);
      // The stored hash of a replaced lock is not the hash of what the daemon examined.
      expect(codeOf(() => expectedOpen(viewFromEthereum(i.swap_id, { ...struct, amount: struct.amount + 1n }))), c.name).toBe('OpenHashMismatch');
    }
  });

  it('reads Ethereum\'s revealed uint256 as the 32 little-endian bytes Monero uses', () => {
    for (const c of vector('twin').cases.filter((c: any) => c.valid)) {
      const s = viewFromEthereum(`0x${'ab'.repeat(32)}`, { revealed: BigInt(`0x${c.input.secret_uint256}`), noticeCiphertext: '0x', swapNonce: `0x${'00'.repeat(16)}`, taker: '0xAA', maker: '0xBB', token: '0xCC', sessionKey: '0xDD', takerKey: '0x', takerKey2: '0x', makerKey: '0x', makerKey2: '0x', takerSpendPub: '0x', makerSpendPub: '0x', lockerView: '0x', takerEncKey: '0x', makerEncKey: '0x', noticeCommitment: '0x', evidenceTxid: '0x', evidenceView: '0x', keyLeaf: '0x', openHash: '0x', direction: 0 } as unknown as EthSwapStruct);
      expect(hex(s.revealed), c.name).toBe(c.input.s);
      expect(s.taker).toBe('0xaa');
    }
  });
});

describe('amounts.json', () => {
  const v = vector('amounts');
  it('looks up price and depth tiers', () => {
    const tiers = v.cases.filter((c: any) => c.input.op === 'tier');
    expect(tiers.length).toBe(14);
    for (const c of tiers) {
      const f = () => tierValue(c.input.above.map(BigInt), c.input.values.map(BigInt), BigInt(c.input.xmr));
      if (c.valid) expect(f().toString(), c.name).toBe(c.output.value);
      else expect(codeOf(f), c.name).toBe(c.error);
    }
  });

  it('prices a size against an offer and a quote with the core\'s rounding', () => {
    const X = 1_000_000_000_000n;
    const offer = { direction: 0, minXmr: X / 10n, maxXmr: 100n * X, capacityXmr: 60n * X, priceAbove: [0n, X, 50n * X], prices: [150_000_000n, 149_000_000n, 148_000_000n], depthAbove: [0n, X, 50n * X], depths: Uint8Array.of(2, 10, 25), depBps: 100 } as unknown as Offer;
    expect(priceOffer(offer, X / 2n)).toEqual({ price: 150_000_000n, depth: 2, amount: 75_000_000n, deposit: 750_000n, fee: 37_500n });
    expect(priceOffer(offer, X)).toMatchObject({ price: 149_000_000n, depth: 10 });
    expect(priceOffer(offer, 50n * X)).toMatchObject({ price: 148_000_000n, depth: 25, amount: 7_400_000_000n });
    // Direction A rounds the payment up, direction B rounds the receipt down.
    expect(priceOffer(offer, X / 3n).amount).toBe(50_000_000n);
    expect(priceOffer({ ...offer, prices: [150_000_001n, 0n, 0n] } as Offer, X / 3n).amount).toBe(50_000_001n);
    expect(priceOffer({ ...offer, direction: 1, prices: [150_000_001n, 0n, 0n] } as Offer, X / 3n).amount).toBe(50_000_000n);
    expect(codeOf(() => priceOffer(offer, X / 10n - 1n))).toBe('AmountOutOfRange');
    expect(codeOf(() => priceOffer(offer, 100n * X + 1n))).toBe('AmountOutOfRange');
    expect(codeOf(() => priceOffer(offer, 61n * X))).toBe('CapacityExceeded');
    expect(codeOf(() => priceOffer({ ...offer, priceAbove: [0n, X, X] } as Offer, X))).toBe('TiersInvalid');

    const q = quoteFromMessage(vector('eip712').cases[0].input.typed_data.message);
    expect(priceEthQuote(q, 2n * X)).toEqual({ price: 60_500_000_000_000_000n, depth: 10, amount: 121_000_000_000_000_000n, deposit: 1_210_000_000_000_000n, fee: 60_500_000_000_000n });
    expect(codeOf(() => priceEthQuote(q, q.maxXmr + 1n))).toBe('AmountOutOfRange');
  });
});

describe('deadlines.json', () => {
  const v = vector('deadlines');
  it('mirrors every protocol constant', () => {
    const names: Record<string, keyof (typeof CHAIN_CONSTS)['solana']> = {
      FEE_BPS: 'feeBps', MAX_DEPOSIT_BPS: 'maxDepositBps', HOLD_SECS: 'holdSecs', SPLIT_SECS: 'splitSecs', EXPIRY_SECS: 'expirySecs', BLOCK_ALLOWANCE_SECS: 'blockAllowanceSecs', CUT_MARGIN_SECS: 'cutMarginSecs',
      MARGIN_SECS: 'marginSecs', FINALITY_SECS: 'finalitySecs', MIN_NOTICE_SECS: 'minNoticeSecs', MAX_NOTICE_SECS: 'maxNoticeSecs', MIN_CLAIM_DELAY_SECS: 'minClaimDelaySecs', MAX_APPROVAL_SECS: 'maxApprovalSecs',
      MAX_FINAL_SECS: 'maxFinalSecs', READY_MIN_SECS_PER_CONF: 'readyMinSecsPerConf', MAX_OPEN_PENDING: 'maxOpenPending', EXPLICIT_APPROVE: 'explicitApprove', OPEN_SECRET_CALLS: 'openSecretCalls', LAPSE_IS_FAULT: 'lapseIsFault',
    };
    for (const chain of ['solana', 'ethereum'] as const) for (const [k, field] of Object.entries(names)) expect(CHAIN_CONSTS[chain][field], `${chain} ${k}`).toBe(v.constants[chain][k]);
  });

  it('a swap driven through the model stores exactly the derived deadlines', () => {
    const derive = v.cases.filter((c: any) => c.valid && c.input.op === 'derive' && c.input.t_ready != null);
    expect(derive.length).toBe(8);
    for (const c of derive) {
      const i = c.input;
      const chain = i.chain as 'solana' | 'ethereum';
      const p = i.params;
      // "funding" = a direction-B take outside window mode. "approval" = a swap that waits for approval:
      // direction A, or (the Ethereum extremes, whose notice lands at T_note) a direction-B take.
      const funding = i.pending === 'funding' || i.t_notice >= c.output.t_note;
      const args = { offerMode: i.pending === 'funding' ? 0 : 1, approval: false, amount: 1_500_000_000n, wA: p.w_a, wN: p.w_n, dC: p.d_c, wC: p.w_c, wF: p.w_f, depth: p.depth, depBps: p.dep_bps };
      let s = apply(chain, NO_SWAP, { name: funding ? 'take' : 'lock', args }, 'taker', BigInt(i.t_lock)).swap;
      expect(deadlinesOf(chain, s).tPend, c.name).toBe(BigInt(c.output.t_pend));
      s = apply(chain, s, { name: funding ? 'fund' : 'approve' }, 'operator', BigInt(i.t_active)).swap;
      s = apply(chain, s, { name: 'post_notice' }, funding ? 'session' : 'operator', BigInt(i.t_notice)).swap;
      s = apply(chain, s, { name: 'set_ready' }, funding ? 'operator' : 'taker', BigInt(i.t_ready)).swap;
      const d = deadlinesOf(chain, s);
      const o = c.output;
      expect({ tNote: d.tNote, tCut: d.tCut, tCo: d.tCo, tReadyMin: d.tReadyMin, tCd: d.tCd, tFinal: d.tFinal, tNl: d.tNl, tExp: d.tExp }, c.name).toEqual({
        tNote: BigInt(o.t_note), tCut: BigInt(o.t_cut), tCo: BigInt(o.t_co), tReadyMin: BigInt(o.t_ready_min), tCd: BigInt(o.t_cd), tFinal: BigInt(o.t_final), tNl: BigInt(o.t_nl), tExp: BigInt(o.t_exp),
      });
      expect(d.margin).toBe(BigInt(CHAIN_CONSTS[chain].marginSecs));
      // The extremes: the latest reachable T_cd still precedes T_final − 86,400.
      expect(d.tCd! < d.tFinal - 86_400n, c.name).toBe(true);
      expect(deadlinesOf(chain, s).tHold).toBe(null);
      if (i.t_refund == null) continue;
      // T_hold and T_split are fixed at the refund.
      const refunded = { ...s, tRefund: BigInt(i.t_refund) };
      expect(deadlinesOf(chain, refunded).tHold).toBe(BigInt(o.t_hold));
      expect(deadlinesOf(chain, refunded).tSplit).toBe(BigInt(o.t_split));
    }
  });

  it('refuses at lock every parameter set the vectors refuse, with the same error', () => {
    let refused = 0;
    for (const c of v.cases.filter((c: any) => c.input.op === 'bounds')) {
      const i = c.input;
      const p = i.params;
      // Reproduce the pending kind through the lock that leads to it.
      const direction = i.pending === 'funding' ? 'take' : 'lock';
      const offerMode = i.pending === 'approval' ? 1 : 0;
      if (i.chain === 'ethereum' && i.pending !== 'approval') continue; // every Ethereum swap starts PENDING for approval
      const args = { offerMode, approval: false, amount: 1_000_000n, wA: p.w_a, wN: p.w_n, dC: p.d_c, wC: p.w_c, wF: p.w_f, depth: p.depth, depBps: p.dep_bps };
      const got = codeOf(() => apply(i.chain, NO_SWAP, { name: direction, args }, 'taker', 1_800_000_000n));
      expect(got, c.name).toBe(c.valid ? null : c.error);
      if (!c.valid) refused++;
    }
    expect(refused).toBeGreaterThan(15);
  });
});
