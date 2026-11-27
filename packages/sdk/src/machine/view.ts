/**
 * `SwapView`: one chain-neutral snapshot of an on-chain swap. The Solana account and the
 * Ethereum struct both convert to it; the flows, the key derivation and the UI read only this.
 *
 * Byte conventions: every 32-byte value is the same bytes on both chains (points compressed,
 * scalars little-endian). The one exception is Ethereum's `revealed`, a `uint256` holding the
 * share as an integer; it is converted to the 32 little-endian bytes Monero uses.
 */
import { CHAIN_CONSTS, type ChainConsts, type ChainName, SWAP_FLAG, SWAP_STATE, type Swap as SolanaSwap, base58Decode } from '@xmrswap/protocol';
import { type Bytes, bigToLe, unhex } from '../util.js';
import { type ModelSwap, tExp, tFf, tHold, tNl, tReadyMin, tSplit } from './model.js';

const SOLANA_DEFAULT_KEY = '11111111111111111111111111111111';
const ETH_ZERO = '0x0000000000000000000000000000000000000000';

export interface SwapView extends ModelSwap {
  chain: ChainName;
  /** `swap_ref`: the swap PDA (Solana) or `swapId` (Ethereum), 32 bytes. */
  swapRef: Bytes;
  /** Taker wallet: base58 (Solana) or 0x address (Ethereum). */
  taker: string;
  /** Maker PDA (Solana) or the maker's registered address (Ethereum). */
  maker: string;
  /** Solana: `"0"` SOL or `"1"` USDC. Ethereum: the token address (`0x000…0` = ETH). */
  asset: string;
  xmr: bigint;
  price: bigint;
  depBps: number;
  swapNonce: Bytes;
  sessionKey: string;
  takerEncKey: Bytes;
  makerEncVersion: number;
  makerEncKey: Bytes;
  takerSpendPub: Bytes;
  /** Zeros until known. */
  makerSpendPub: Bytes;
  /** The locker's private view share, in clear (A: the taker's; B: the maker's, zeros until funded). */
  lockerView: Bytes;
  noticeCommitment: Bytes;
  /** 104 bytes, or empty when no notice is on record. */
  noticeCt: Bytes;
  evidenceTxid: Bytes;
  evidenceView: Bytes;
  /** The revealed spend share as 32 little-endian bytes; zeros when nothing was revealed. */
  revealed: Bytes;
  /**
   * Amendment 1 (SPEC 11.2). Where a direction-B claim pays: an address in the chain's own
   * spelling (the taker's own by default), `null` in direction A. `payout` says which case.
   */
  payoutAddress: string | null;
  /** Amendment 1 (SPEC 11.6). The key that may freeze, or `null` when the swap names none. `watcher` is `watcherAddress !== null`. */
  watcherAddress: string | null;
  /** Ethereum only. */
  eth?: { takerKey: string; takerKey2: string; makerKey: string; makerKey2: string; keyLeaf: Bytes; openHash: Bytes };
}

export function viewFromSolana(swapPda: string, a: SolanaSwap): SwapView {
  return {
    chain: 'solana',
    swapRef: base58Decode(swapPda),
    taker: a.taker,
    maker: a.maker,
    asset: String(a.asset),
    state: a.state,
    direction: a.direction === 0 ? 0 : 1,
    mode: a.mode,
    outcome: a.outcome,
    depositState: a.depositState,
    depth: a.depth,
    flags: a.flags,
    amount: a.amount,
    deposit: a.deposit,
    xmr: a.xmr,
    price: a.price,
    depBps: a.depBps,
    feeBps: a.feeBps,
    wN: a.wN,
    dC: a.dC,
    wC: a.wC,
    swapNonce: a.swapNonce,
    sessionKey: a.sessionKey,
    takerEncKey: a.takerEncKey,
    makerEncVersion: a.makerEncVersion,
    makerEncKey: a.makerEncKey,
    takerSpendPub: a.takerSpendPub,
    makerSpendPub: a.makerSpendPub,
    lockerView: a.lockerView,
    noticeCommitment: a.noticeCommitment,
    noticeCt: (a.flags & SWAP_FLAG.NOTICE) !== 0 ? a.noticeCt : new Uint8Array(0),
    evidenceTxid: a.evidenceTxid,
    evidenceView: a.evidenceView,
    revealed: a.revealed,
    tLock: a.tLock,
    tPendingDeadline: a.tPendingDeadline,
    tActive: a.tActive,
    tNoteDeadline: a.tNoteDeadline,
    tNotice: a.tNotice,
    tCut: a.tCut,
    tClaimOpen: a.tClaimOpen,
    tReady: a.tReady,
    tClaimDeadline: a.tClaimDeadline,
    tFinal: a.tFinal,
    tRefund: a.tRefund,
    tSettled: a.tSettled,
    owedTaker: a.owedTaker,
    owedMaker: a.owedMaker,
    owedTreasury: a.owedTreasury,
    payout: a.direction === 0 || a.payout === SOLANA_DEFAULT_KEY ? 'none' : a.payout === a.taker ? 'taker' : 'other',
    payoutAddress: a.direction === 0 || a.payout === SOLANA_DEFAULT_KEY ? null : a.payout,
    watcher: a.watcher !== SOLANA_DEFAULT_KEY,
    watcherAddress: a.watcher === SOLANA_DEFAULT_KEY ? null : a.watcher,
    wZ: a.wZ,
    tFreeze: a.tFreeze,
  };
}

/** The `Swap` struct as viem decodes `getSwap`'s result (SPEC 5.2, frozen ABI). */
export interface EthSwapStruct {
  taker: string;
  maker: string;
  token: string;
  sessionKey: string;
  swapNonce: string;
  state: number;
  direction: number;
  mode: number;
  outcome: number;
  depositState: number;
  depth: number;
  flags: number;
  depBps: number;
  makerEncVersion: number;
  xmr: bigint;
  amount: bigint;
  deposit: bigint;
  price: bigint;
  noticeWindow: number;
  claimDelay: number;
  claimWindow: number;
  takerKey: string;
  takerKey2: string;
  takerSpendPub: string;
  makerKey: string;
  makerKey2: string;
  makerSpendPub: string;
  lockerView: string;
  takerEncKey: string;
  makerEncKey: string;
  noticeCommitment: string;
  noticeCiphertext: string;
  evidenceTxid: string;
  evidenceView: string;
  keyLeaf: string;
  openHash: string;
  revealed: bigint;
  tLock: bigint;
  tPendingDeadline: bigint;
  tActive: bigint;
  tNoteDeadline: bigint;
  tNotice: bigint;
  tCut: bigint;
  tClaimOpen: bigint;
  tReady: bigint;
  tClaimDeadline: bigint;
  tFinal: bigint;
  tRefund: bigint;
  tSettled: bigint;
  /** Amendment 1: the address a direction-B claim pays (the taker when none was named); zero in direction A. */
  payout: string;
  /** The watcher named at `lock` or `fund`; zero = none. */
  watcher: string;
  /** `W_z`. */
  freezeSecs: number;
  tFreeze: bigint;
}

/**
 * `owed` is what `owedOf(token, …)` reports for the taker, the maker side and the treasury; the
 * contract keeps parked payouts per account, not per swap, so pass zeros when not read. On a
 * direction-B swap that ended in a claim with another payout address, `owed.taker` is that
 * address's balance (`EthereumClient.getSwap` reads it so).
 */
export function viewFromEthereum(swapId: string, a: EthSwapStruct, owed: { taker?: bigint; maker?: bigint; treasury?: bigint } = {}): SwapView {
  const payout = a.payout.toLowerCase();
  const watcher = a.watcher.toLowerCase();
  const noPayout = a.direction === 0 || payout === ETH_ZERO;
  return {
    chain: 'ethereum',
    swapRef: unhex(swapId),
    taker: a.taker.toLowerCase(),
    maker: a.maker.toLowerCase(),
    asset: a.token.toLowerCase(),
    state: a.state,
    direction: a.direction === 0 ? 0 : 1,
    mode: a.mode,
    outcome: a.outcome,
    depositState: a.depositState,
    depth: a.depth,
    flags: a.flags,
    amount: a.amount,
    deposit: a.deposit,
    xmr: a.xmr,
    price: a.price,
    depBps: a.depBps,
    feeBps: CHAIN_CONSTS.ethereum.feeBps,
    wN: a.noticeWindow,
    dC: a.claimDelay,
    wC: a.claimWindow,
    swapNonce: unhex(a.swapNonce),
    sessionKey: a.sessionKey.toLowerCase(),
    takerEncKey: unhex(a.takerEncKey),
    makerEncVersion: a.makerEncVersion,
    makerEncKey: unhex(a.makerEncKey),
    takerSpendPub: unhex(a.takerSpendPub),
    makerSpendPub: unhex(a.makerSpendPub),
    lockerView: unhex(a.lockerView),
    noticeCommitment: unhex(a.noticeCommitment),
    noticeCt: unhex(a.noticeCiphertext),
    evidenceTxid: unhex(a.evidenceTxid),
    evidenceView: unhex(a.evidenceView),
    revealed: bigToLe(a.revealed, 32),
    tLock: a.tLock,
    tPendingDeadline: a.tPendingDeadline,
    tActive: a.tActive,
    tNoteDeadline: a.tNoteDeadline,
    tNotice: a.tNotice,
    tCut: a.tCut,
    tClaimOpen: a.tClaimOpen,
    tReady: a.tReady,
    tClaimDeadline: a.tClaimDeadline,
    tFinal: a.tFinal,
    tRefund: a.tRefund,
    tSettled: a.tSettled,
    owedTaker: owed.taker ?? 0n,
    owedMaker: owed.maker ?? 0n,
    owedTreasury: owed.treasury ?? 0n,
    payout: noPayout ? 'none' : payout === a.taker.toLowerCase() ? 'taker' : 'other',
    payoutAddress: noPayout ? null : payout,
    watcher: watcher !== ETH_ZERO,
    watcherAddress: watcher === ETH_ZERO ? null : watcher,
    wZ: a.freezeSecs,
    tFreeze: a.tFreeze,
    eth: { takerKey: a.takerKey.toLowerCase(), takerKey2: a.takerKey2.toLowerCase(), makerKey: a.makerKey.toLowerCase(), makerKey2: a.makerKey2.toLowerCase(), keyLeaf: unhex(a.keyLeaf), openHash: unhex(a.openHash) },
  };
}

/** Every deadline of SPEC 3.2 for a swap, as stored or derived. `null` = the event it derives from has not happened. */
export interface SwapDeadlines {
  tPend: bigint | null;
  tNote: bigint | null;
  tCut: bigint | null;
  tCo: bigint | null;
  tReadyMin: bigint | null;
  tCd: bigint | null;
  /** `t_Z`: when the swap was frozen. */
  tFreeze: bigint | null;
  /** `T_ff = max(t_Z + W_z, T_co)`: the frozen-final time. `null` unless the swap was frozen. */
  tFf: bigint | null;
  tFinal: bigint;
  tNl: bigint;
  tExp: bigint;
  tHold: bigint | null;
  tSplit: bigint | null;
  /** `M`: the broadcast margin of rule 2 for this chain. */
  margin: bigint;
}

const orNull = (t: bigint): bigint | null => (t === 0n ? null : t);

/** The deadlines of a swap, read from the fields the contract stored (the chain is the authority, not a recomputation). */
export function deadlinesOf(chain: ChainName, s: ModelSwap, consts: ChainConsts = CHAIN_CONSTS[chain]): SwapDeadlines {
  const refunded = s.tRefund !== 0n;
  return {
    tPend: orNull(s.tPendingDeadline),
    tNote: orNull(s.tNoteDeadline),
    tCut: orNull(s.tCut),
    tCo: orNull(s.tClaimOpen),
    tReadyMin: s.tNotice === 0n ? null : tReadyMin(s, consts),
    tCd: orNull(s.tClaimDeadline),
    tFreeze: orNull(s.tFreeze),
    tFf: tFf(s),
    tFinal: s.tFinal,
    tNl: tNl(s),
    tExp: tExp(s, consts),
    tHold: refunded ? tHold(s, consts) : null,
    tSplit: refunded ? tSplit(s, consts) : null,
    margin: BigInt(consts.marginSecs),
  };
}

export const hasFlag = (s: ModelSwap, flag: number): boolean => (s.flags & flag) !== 0;
/** A spend share was revealed and the revealer was the locker: the swap ended in a refund. */
export const endedInRefund = (s: ModelSwap): boolean => hasFlag(s, SWAP_FLAG.REVEALED) && hasFlag(s, SWAP_FLAG.REVEALER_LOCKER);
/** A spend share was revealed by the claimer: the swap ended in a claim. */
export const endedInClaim = (s: ModelSwap): boolean => hasFlag(s, SWAP_FLAG.REVEALED) && !hasFlag(s, SWAP_FLAG.REVEALER_LOCKER);
/** The swap is counted in its asset's open value (SPEC 11.1). */
export const isCounted = (s: ModelSwap): boolean => hasFlag(s, SWAP_FLAG.COUNTED);
/** The swap was frozen at some point (`t_Z` is kept after an unfreeze). */
export const wasFrozen = (s: ModelSwap): boolean => s.tFreeze !== 0n;
export const isSettled = (s: ModelSwap): boolean => s.state === SWAP_STATE.DONE || s.state === SWAP_STATE.NONE;
