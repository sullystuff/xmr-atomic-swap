/**
 * From a flow's decision to the transaction that carries it out: the one place that knows which
 * instruction (Solana) or function (Ethereum) a `FlowCall` is and what must travel with it.
 * Pure: it builds, the caller signs and sends.
 *
 * A `refund` or `claim` is built only if the secret opens the commitment the contract will
 * check (`secretOpens`), and a `withhold` or `publish_evidence` only if the evidence opens the
 * notice commitment: a call that would fail on-chain is refused here, before anything leaves.
 */
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { type Address, OWED } from '@xmrswap/protocol';
import type { EthCall, XmrSwapContract } from '../ethereum/client.js';
import type { SwapView } from '../machine/view.js';
import type { SettleContext, XmrSwapProgram } from '../solana/instructions.js';
import { type Bytes, SdkError } from '../util.js';
import { type NoticeToPost, evidenceOpens, expectedOpen, secretOpens } from './keys.js';
import type { FlowCall } from './types.js';

/** What a call needs beyond the swap itself. Only the fields the call uses are read. */
export interface CallMaterial {
  /** `refund`, `claim`: the caller's own spend share (32 little-endian bytes). */
  secret?: Bytes;
  /** `post_notice`: from `buildNotice`. */
  notice?: NoticeToPost;
  /** `withhold` (direction A with a notice on record), `publish_evidence`: the opening `(txid, v_C)`. */
  evidence?: { txid: Bytes; view: Bytes };
  /**
   * `approve`, `fund`: the maker's share. Solana: the commitment and its proof for the maker PDA
   * (`solanaMakerShare`). Ethereum `fund`: the commitment and its twin addresses. `view` is the
   * maker's view share, posted in clear by `fund`.
   */
  makerShare?: { spendPub: Bytes; pok?: Bytes; key?: Address; key2?: Address; view?: Bytes };
  /**
   * `withdraw_owed`: where the parked payout goes (default: the owed party's own address).
   * `push_owed` of a maker-side balance on Ethereum: the account whose balance is pushed.
   */
  destination?: string;
  /** `fund` (direction B, SPEC 11.6): the maker's watcher key. Refused by the chain against `w_z = 0`. */
  watcher?: string | null;
  /**
   * Solana `claim` / `withdraw_owed` on a USDC swap in direction B: pass the associated-token
   * program so a missing token account of the payout address is created at the caller's cost
   * (default true; the caller needs `rent(165)` more, else the proceeds park).
   */
  createPayoutToken?: boolean;
}

function need<T>(v: T | undefined, call: string, what: string): T {
  if (v === undefined) throw new SdkError('MissingMaterial', `${call} needs ${what}`);
  return v;
}
function checkedSecret(s: SwapView, name: 'refund' | 'claim', m: CallMaterial): Bytes {
  const secret = need(m.secret, name, 'the spend share');
  if (!secretOpens(s, secret, name)) throw new SdkError('ScalarMismatch', `this share does not open the commitment a ${name} is checked against`);
  return secret;
}
function checkedEvidence(s: SwapView, name: string, m: CallMaterial): { txid: Bytes; view: Bytes } {
  const ev = need(m.evidence, name, 'the notice opening');
  if (!evidenceOpens(s, ev.txid, ev.view)) throw new SdkError('EvidenceMismatch', 'the evidence does not open the notice commitment');
  return ev;
}

/** The maker's registry fields a Solana settlement names. */
export interface SolanaMakerWallets {
  operator: string;
  payout: string;
  /** `Config.split_mode == 1`. */
  burn?: boolean;
}

/** The Solana instruction for a flow call on swap `s`, signed by `caller` (base58). */
export function solanaInstruction(program: XmrSwapProgram, s: SwapView, maker: SolanaMakerWallets, caller: string, call: FlowCall, m: CallMaterial = {}): TransactionInstruction {
  if (s.chain !== 'solana') throw new SdkError('WrongChain', 'not a Solana swap');
  const swap = new PublicKey(s.swapRef);
  const ctx: SettleContext = { swap, taker: s.taker, maker: s.maker, operator: maker.operator, payout: maker.payout, asset: Number(s.asset), direction: s.direction, ...(maker.burn ? { burn: true } : {}), swapPayout: s.payoutAddress };
  const slots = m.createPayoutToken === undefined ? {} : { createPayoutToken: m.createPayoutToken };
  const short = { caller, swap, maker: s.maker };
  switch (call.name) {
    case 'lock':
    case 'take':
      throw new SdkError('UseOpenPlan', 'a lock or take is built by planSolanaOpen');
    case 'approve': {
      const share = need(m.makerShare, 'approve', 'the maker share');
      return program.approve({ operator: caller, swap, maker: s.maker, expectedOpen: expectedOpen(s), makerSpendPub: share.spendPub, makerPok: need(share.pok, 'approve', 'the proof of knowledge') });
    }
    case 'fund': {
      const share = need(m.makerShare, 'fund', 'the maker share');
      return program.fund({ operator: caller, swap, maker: s.maker, asset: Number(s.asset), expectedOpen: expectedOpen(s), makerSpendPub: share.spendPub, makerPok: need(share.pok, 'fund', 'the proof of knowledge'), makerView: need(share.view, 'fund', 'the maker view share'), watcher: m.watcher ?? null });
    }
    case 'reject':
      return program.reject(caller, ctx, expectedOpen(s), call.reason);
    case 'post_notice': {
      const n = need(m.notice, 'post_notice', 'the notice');
      return program.postNotice({ ...short, commitment: n.commitment, ciphertext: n.ciphertext });
    }
    case 'set_ready':
      return program.setReady(short);
    case 'freeze':
      return program.freeze(short);
    case 'withhold':
      return program.withhold({ ...short, evidence: call.evidence === 'absent' ? null : checkedEvidence(s, 'withhold', m) });
    case 'publish_evidence': {
      const ev = checkedEvidence(s, 'publish_evidence', m);
      return program.publishEvidence({ ...short, txid: ev.txid, view: ev.view });
    }
    case 'refund':
      return program.refund(caller, ctx, checkedSecret(s, 'refund', m));
    case 'claim':
      return program.claim(caller, ctx, checkedSecret(s, 'claim', m), slots);
    case 'withdraw_owed':
      // `payout`: the claim proceeds of a direction-B swap, parked for the payout address. They
      // sit in the taker's slot (`who = 0`); a destination is honoured only when the payout
      // address itself signs, otherwise the program pays the payout address and no other.
      return program.settle('withdrawOwed', caller, ctx, { who: call.who === 'taker' || call.who === 'payout' ? OWED.TAKER : call.who === 'maker' ? OWED.MAKER : OWED.TREASURY }, m.destination, slots);
    case 'push_owed':
      // Solana has no separate push: anyone delivers parked claim proceeds to the payout address with `withdraw_owed(0)`.
      if (call.who !== 'payout') throw new SdkError('NotAvailable', 'on Solana only parked claim proceeds of a payout address can be delivered by a third party');
      return program.settle('withdrawOwed', caller, ctx, { who: OWED.TAKER }, undefined, slots);
    case 'cancel_pending':
      return program.settle('cancelPending', caller, ctx, {});
    case 'expire_pending':
      return program.settle('expirePending', caller, ctx, {});
    case 'abort':
      return program.settle('abort', caller, ctx, {});
    case 'refund_unnoticed':
      return program.settle('refundUnnoticed', caller, ctx, {});
    case 'expire_unnoticed':
      return program.settle('expireUnnoticed', caller, ctx, {});
    case 'release_deposit':
      return program.settle('releaseDeposit', caller, ctx, {});
    case 'split_deposit':
      return program.settle('splitDeposit', caller, ctx, {});
    case 'close_swap':
      return program.settle('closeSwap', caller, ctx, {});
  }
}

/** The Ethereum call for a flow call on swap `s`. `null` for `close_swap`: swaps are never deleted there. */
export function ethereumCall(contract: XmrSwapContract, s: SwapView, call: FlowCall, m: CallMaterial = {}): EthCall | null {
  if (s.chain !== 'ethereum') throw new SdkError('WrongChain', 'not an Ethereum swap');
  const id = s.swapRef;
  switch (call.name) {
    case 'lock':
    case 'take':
      throw new SdkError('UseOpenPlan', 'a lock or take is built by planEthereumOpen');
    case 'approve':
      return contract.approve(id, expectedOpen(s));
    case 'fund': {
      const share = need(m.makerShare, 'fund', 'the maker share');
      return contract.fund({ swapId: id, expectedOpen: expectedOpen(s), key: need(share.key, 'fund', 'keyAddr'), key2: need(share.key2, 'fund', 'keyAddr2'), spendPub: share.spendPub, viewShare: need(share.view, 'fund', 'the maker view share'), amount: s.amount, token: s.asset as Address, watcher: (m.watcher ?? null) as Address | null });
    }
    case 'reject':
      return contract.reject(id, expectedOpen(s), call.reason);
    case 'post_notice': {
      const n = need(m.notice, 'post_notice', 'the notice');
      return contract.postNotice(id, n.commitment, n.ciphertext);
    }
    case 'set_ready':
      return contract.setReady(id);
    case 'freeze':
      return contract.freeze(id);
    case 'withhold':
      return contract.withhold(id, call.evidence === 'absent' ? null : checkedEvidence(s, 'withhold', m));
    case 'publish_evidence': {
      const ev = checkedEvidence(s, 'publish_evidence', m);
      return contract.publishEvidence(id, ev.txid, ev.view);
    }
    case 'refund':
      return contract.refund(id, checkedSecret(s, 'refund', m));
    case 'claim':
      return contract.claim(id, checkedSecret(s, 'claim', m));
    case 'withdraw_owed':
      // The owed account itself calls; parked payouts are keyed by account, not by swap.
      return contract.withdrawOwed(s.asset as Address, need(m.destination, 'withdraw_owed', 'a destination address') as Address);
    case 'push_owed': {
      // Anyone: the balance goes to the account itself and nowhere else.
      const account = call.who === 'payout' ? s.payoutAddress : call.who === 'taker' ? s.taker : m.destination;
      return contract.pushOwed(s.asset as Address, need(account ?? undefined, 'push_owed', 'the account whose parked balance is pushed') as Address);
    }
    case 'cancel_pending':
      return contract.cancelPending(id);
    case 'expire_pending':
      return contract.expirePending(id);
    case 'abort':
      return contract.abort(id);
    case 'refund_unnoticed':
      return contract.refundUnnoticed(id);
    case 'expire_unnoticed':
      return contract.expireUnnoticed(id);
    case 'release_deposit':
      return contract.releaseDeposit(id);
    case 'split_deposit':
      return contract.splitDeposit(id);
    case 'close_swap':
      return null;
  }
}
