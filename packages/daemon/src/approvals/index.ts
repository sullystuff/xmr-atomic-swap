/**
 * Approvals (DESIGN "Maker tools"; SPEC 7.1 `approvals/`): decides pending locks inside the
 * window by the maker's own rules (allow and deny lists, size limits, exposure, usable input),
 * and issues advance approvals for chosen addresses.
 *
 * A pending lock with unusable input is rejected at once with reason 1, which frees its
 * pending slot; a leaf two takers named is rejected with reason 2. Those do not count against
 * the approval rate.
 */
import { randomBytes } from 'node:crypto';
import { isLowOrderX25519, validatePoint } from '@xmrswap/core-wasm';
import { type ApprovalResponse, type ChainName, ETH_ANY_DIRECTION, ETH_ANY_TOKEN, type Market, REJECT_REASON, SOL_APPROVAL_ANY, base58Decode } from '@xmrswap/protocol';
import type { AdvanceApprovalRecord } from '@xmrswap/protocol/daemon-api';
import { type EthDeployment, type SwapView, bytesEqual, hex0x, signEthApproval, signSolApproval, solApprovalResponse, toBase64 } from '@xmrswap/sdk';
import type { Config, ResolvedOffer } from '../config/load.js';
import type { Keystore } from '../keystore/index.js';
import type { Risk } from '../risk/index.js';
import type { EncKeys } from '../rotation/index.js';
import type { Store, SwapRow } from '../store/db.js';
import type { Shares } from '../swaps/shares.js';
import { type Bytes, unhex } from '../util.js';

export type Verdict = { approve: true } | { approve: false; reason: 0 | 1 | 2 };
export interface Decision {
  /** `undefined` = the rules leave it to the maker (the console decides inside the window). */
  verdict: Verdict | undefined;
  recommendation: 'approve' | 'reject';
  reasons: string[];
}

export interface ApprovalsOptions {
  store: Store;
  keystore: Keystore;
  risk: Risk;
  shares: Shares;
  encKeys: EncKeys;
  config: () => Config;
  /** Direction A: the largest swap an unlocked ladder output can fund right now. */
  xmrAvailable: () => bigint;
  /** Direction B: what the operator can still commit of a market's paying asset (balance and cap, less what open swaps hold), or `null` when unknown. */
  payingAvailable: (market: Market, excludeRef: string) => Promise<bigint | null>;
  /** What an advance approval is bound to on each chain; `null` = that chain is not configured. */
  solana: () => Promise<{ clusterTag: Bytes; programId: Bytes; makerPda: Bytes; approvalEpoch: number; now: bigint } | null>;
  ethereum: () => Promise<{ deployment: EthDeployment; maker: Bytes; usdc: Bytes; approvalEpoch: number; now: bigint } | null>;
}

const same = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

export class Approvals {
  constructor(private readonly o: ApprovalsOptions) {}

  /**
   * Whether the taker's input is usable at all (reason 1 otherwise): a valid, foreign spend
   * commitment; an encryption key that is not a low-order point; and a maker key version this
   * daemon still holds whose public key is the one the swap recorded.
   */
  inputProblem(view: SwapView): string | null {
    try {
      if (!validatePoint(view.takerSpendPub)) return 'the taker spend commitment is not a prime-order point';
    } catch {
      return 'the taker spend commitment is malformed';
    }
    if (this.o.shares.isOwn(view.takerSpendPub)) return "the taker presented one of this maker's own shares";
    if (isLowOrderX25519(view.takerEncKey)) return 'the taker encryption key is a low-order point';
    const pub = this.o.encKeys.publicFor(view.makerEncVersion);
    if (!pub || !this.o.encKeys.secretFor(view.makerEncVersion)) return `maker key version ${view.makerEncVersion} is not held by this daemon`;
    if (!bytesEqual(pub, view.makerEncKey)) return 'the swap names a maker encryption key that is not this maker key of that version';
    return null;
  }

  /** Apply the rules to a pending swap. Pure apart from the balance read. */
  async decide(view: SwapView, row: Pick<SwapRow, 'ref' | 'taker' | 'market'>, offer: ResolvedOffer | undefined): Promise<Decision> {
    const cfg = this.o.config();
    const a = cfg.raw.approvals;
    const reject = (reason: 0 | 1 | 2, why: string): Decision => ({ verdict: { approve: false, reason }, recommendation: 'reject', reasons: [why] });

    const bad = this.inputProblem(view);
    if (bad) return reject(REJECT_REASON.UNUSABLE_INPUT, bad);
    // Ethereum direction A: the lock names a pool leaf. One this maker does not hold, or one another swap already took, cannot be honoured.
    if (view.chain === 'ethereum' && view.direction === 0) {
      const share = this.o.store.shareByPub(Buffer.from(view.makerSpendPub).toString('hex'));
      if (!share) return reject(REJECT_REASON.UNUSABLE_INPUT, 'the lock names a key leaf this maker does not hold');
      if (share.swap_ref && share.swap_ref !== row.ref) return reject(REJECT_REASON.LEAF_CONSUMED, 'another swap already took this key leaf');
    }
    if (a.deny.some((d) => same(d, row.taker))) return reject(REJECT_REASON.MAKER_CHOICE, 'the taker is on the deny list');
    if (!offer || !offer.configured) return reject(REJECT_REASON.MAKER_CHOICE, 'this market and direction is switched off');
    const reasons: string[] = [];
    if (a.allow.length > 0 && !a.allow.some((d) => same(d, row.taker))) reasons.push('the taker is not on the allow list');
    if (view.xmr < offer.minXmr || (offer.maxXmr > 0n && view.xmr > offer.maxXmr)) reasons.push('the size is outside the offer limits');
    reasons.push(...this.o.risk.check({ ref: row.ref, taker: row.taker, xmr: view.xmr }, offer).reasons);
    if (view.direction === 0) {
      if (this.o.xmrAvailable() < view.xmr) reasons.push('no unlocked XMR output can fund this lock');
    } else {
      const available = await this.o.payingAvailable(row.market as Market, row.ref);
      if (available !== null && available < view.amount) reasons.push('the paying balance or its cap does not cover this swap');
    }
    if (reasons.length > 0) return { verdict: { approve: false, reason: REJECT_REASON.MAKER_CHOICE }, recommendation: 'reject', reasons };
    // Above the automatic size limit the maker decides in the console; the rules only recommend.
    if (a.auto_max_xmr !== undefined && view.xmr > BigInt(Math.round(a.auto_max_xmr * 1e6)) * 1_000_000n) return { verdict: undefined, recommendation: 'approve', reasons: ['above auto_max_xmr: waiting for the maker'] };
    return { verdict: { approve: true }, recommendation: 'approve', reasons: [] };
  }

  // ---------------------------------------------------------------- advance approvals

  /** Sign an advance approval for a taker: a per-swap size limit and an expiry, valid for the current approval epoch. */
  async issue(req: { chain: ChainName; taker: string; market?: Market; direction?: 'A' | 'B'; maxXmr: bigint; days: number }): Promise<{ record: AdvanceApprovalRecord; sig: string; response: ApprovalResponse }> {
    if (req.maxXmr <= 0n) throw new Error('max_xmr must be positive');
    if (!(req.days > 0)) throw new Error('days must be positive');
    if (req.market && (req.chain === 'solana') !== (req.market === 'sol' || req.market === 'usdc_sol')) throw new Error(`market ${req.market} is not on ${req.chain}`);
    const direction = req.direction === undefined ? null : req.direction === 'A' ? 0 : 1;
    let record: AdvanceApprovalRecord;
    let sig: string;
    let response: ApprovalResponse;
    if (req.chain === 'solana') {
      const b = await this.o.solana();
      if (!b) throw new Error('Solana is not configured');
      const expiresAt = b.now + BigInt(Math.round(req.days * 86_400));
      const approvalId = randomBytes(8).readBigUInt64LE();
      const signed = signSolApproval(this.o.keystore.solanaOperatorSeed, {
        clusterTag: b.clusterTag, programId: b.programId, maker: b.makerPda, taker: base58Decode(req.taker),
        asset: req.market === undefined ? SOL_APPROVAL_ANY : req.market === 'sol' ? 0 : 1, direction: direction ?? SOL_APPROVAL_ANY,
        maxXmr: req.maxXmr, notBefore: b.now, expiresAt, epoch: b.approvalEpoch, approvalId,
      });
      response = solApprovalResponse(signed);
      sig = toBase64(signed.signature);
      record = { chain: 'solana', id: approvalId.toString(), taker: req.taker, market: req.market ?? null, direction: req.direction ?? null, max_xmr: req.maxXmr.toString(), not_before: Number(b.now), expires_at: Number(expiresAt), epoch: b.approvalEpoch, active: true };
    } else {
      const b = await this.o.ethereum();
      if (!b) throw new Error('Ethereum is not configured');
      const validUntil = b.now + BigInt(Math.round(req.days * 86_400));
      const approvalId = Uint8Array.from(randomBytes(32));
      const token = req.market === undefined ? unhex(ETH_ANY_TOKEN) : req.market === 'eth' ? new Uint8Array(20) : b.usdc;
      const approval = { maker: b.maker, taker: unhex(req.taker), token, direction: direction ?? ETH_ANY_DIRECTION, maxXmr: req.maxXmr, notBefore: b.now, validUntil, epoch: b.approvalEpoch, approvalId };
      const signature = await signEthApproval(this.o.keystore.ethereumOperatorKey, b.deployment, approval);
      sig = toBase64(signature);
      response = { t: 'approval_response', ok: true, chain: 'ethereum', maker: hex0x(b.maker), taker: req.taker.toLowerCase(), token: hex0x(token), direction: approval.direction, max_xmr: req.maxXmr.toString(), not_before: b.now.toString(), valid_until: validUntil.toString(), epoch: b.approvalEpoch, approval_id: hex0x(approvalId), sig };
      record = { chain: 'ethereum', id: hex0x(approvalId), taker: req.taker.toLowerCase(), market: req.market ?? null, direction: req.direction ?? null, max_xmr: req.maxXmr.toString(), not_before: Number(b.now), expires_at: Number(validUntil), epoch: b.approvalEpoch, active: true };
    }
    this.o.store.insertApproval({ id: record.id, chain: record.chain, taker: record.taker, market: record.market, direction: record.direction, max_xmr: record.max_xmr, not_before: record.not_before, expires_at: record.expires_at, epoch: record.epoch, sig });
    return { record, sig, response };
  }

  /** Answer an `approval_request`: only takers the maker listed under `[approvals].advance` get one, within the listed limit. */
  async answerRequest(req: { chain: ChainName; taker: string; market?: Market; direction?: 'A' | 'B'; max_xmr?: string }): Promise<ApprovalResponse> {
    const a = this.o.config().raw.approvals;
    const refuse = (detail: string): ApprovalResponse => ({ t: 'approval_response', ok: false, detail });
    if (a.deny.some((d) => same(d, req.taker))) return refuse('not approved');
    const entry = a.advance.find((e) => same(e.taker, req.taker));
    if (!entry) return refuse('this maker approves in advance only for addresses it has listed');
    const limit = BigInt(Math.round(entry.max_xmr * 1e6)) * 1_000_000n;
    const wanted = req.max_xmr !== undefined && /^\d+$/.test(req.max_xmr) ? BigInt(req.max_xmr) : limit;
    try {
      const issued = await this.issue({ chain: req.chain, taker: req.taker, ...(req.market ? { market: req.market } : {}), ...(req.direction ? { direction: req.direction } : {}), maxXmr: wanted < limit ? wanted : limit, days: entry.days });
      return issued.response;
    } catch (e) {
      return refuse((e as Error).message);
    }
  }

  /** Issued approvals with whether each is still usable (not expired, epoch current, not revoked). */
  records(epochs: Partial<Record<ChainName, number>>, now: Partial<Record<ChainName, number>>): AdvanceApprovalRecord[] {
    return this.o.store.approvals().map((r) => ({
      chain: r.chain, id: r.id, taker: r.taker, market: (r.market as Market | null) ?? null, direction: (r.direction as 'A' | 'B' | null) ?? null, max_xmr: r.max_xmr, not_before: r.not_before, expires_at: r.expires_at, epoch: r.epoch,
      active: r.revoked === 0 && (epochs[r.chain] === undefined || epochs[r.chain] === r.epoch) && (now[r.chain] ?? this.o.store.now()) <= r.expires_at,
    }));
  }
}
