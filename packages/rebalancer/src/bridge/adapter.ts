/**
 * wXMR bridge adapter (DESIGN "wXMR bridge adapter", SPEC 7.7).
 *
 * Refill (USDC or SOL -> XMR): buy wXMR through Jupiter in pieces sized against pool depth,
 * measure what each swap delivered from the transaction's own token balances, and redeem
 * exactly that with `request_withdrawal`. Reverse (XMR -> USDC or SOL): deposit XMR to the
 * wallet's bridge address, wait for the mint, sell the wXMR.
 *
 * The adapter holds no key. Every transaction goes out through `ExecContext`, after the step is
 * journalled and the adapter's own record is saved, so a restart resumes without re-sending:
 * a withdrawal's nonce is persisted before the request (the PDA is seeded by it, so the same
 * nonce cannot create a second withdrawal), and a swap or XMR send whose outcome is unknown
 * parks the refill as `held`.
 */
import { PublicKey } from '@solana/web3.js';
import { type Allowlist, assertAllowed } from '../allowlist.js';
import { costAgainstReference, mulDivCeil, toFloat, unitsForUsd, usdValue } from '../assets.js';
import type { BridgeVenueSettings } from '../settings.js';
import { type AdapterStore, type AssetId, type ExecContext, MemoryStore, type PriceSource, type RefillRequest, type RefillStatus, type VenueAdapter, type VenueQuote, VenueError } from '../types.js';
import { type Heartbeat, type ReserveProofVerifier, checkReserve, heartbeatOnline, readHeartbeat } from './heartbeat.js';
import type { JupiterClient, JupiterQuote } from './jupiter.js';
import {
  BRIDGE_MIN_ATOMIC, BRIDGE_PROGRAM_ID, CANCEL_DELAY_SECONDS, DEFAULT_WITHDRAW_FEE_BPS, DEPOSIT_FEE_BPS, USDC_MINT, WSOL_MINT, WXMR_MINT,
  associatedTokenAddress, bridgePdas, cancelWithdrawalIx, createAtaIdempotentIx, createDepositAccountIx, decodeBridgeConfig, decodeDepositRecord,
  decodeFeeOverride, decodeTokenAmount, decodeUpgradeAuthority, decodeWithdrawalRecord, decodeWithdrawalState, nextWithdrawalNonce, parseBridgeEvents,
  requestWithdrawalIx, withdrawalNet,
} from './program.js';
import { type SolanaRpc, lamportDelta, tokenDelta } from './rpc.js';

/** Total value of the pool the DEX leg trades against, in USD. */
export type PoolDepthReader = () => Promise<{ usd: number }>;

/**
 * Pool depth from the pool's two reserve token accounts. The vault addresses are configuration
 * (read them from the pool account or an explorer); nothing is hard-coded because the pool's
 * layout was not verified here.
 */
export function vaultPoolDepth(rpc: SolanaRpc, prices: PriceSource, vaults: { wxmr: string; quote: string; quoteAsset: 'usdc_sol' | 'sol' }): PoolDepthReader {
  return async () => {
    const [w, q] = await rpc.getAccounts([vaults.wxmr, vaults.quote]);
    if (!w || !q) throw new Error('pool vault account not found');
    const wx = decodeTokenAmount(w), qt = decodeTokenAmount(q);
    if (wx.mint !== WXMR_MINT.toBase58()) throw new Error('the wXMR vault does not hold wXMR');
    return { usd: (await usdValue(prices, 'xmr', wx.amount)) + (await usdValue(prices, vaults.quoteAsset, qt.amount)) };
  };
}

export interface BridgeDeps {
  rpc: SolanaRpc;
  jupiter: JupiterClient;
  prices: PriceSource;
  /** The maker's Solana wallet (public key). It pays, receives the wXMR and owns the bridge records. */
  wallet: string;
  settings: BridgeVenueSettings;
  store?: AdapterStore;
  /** Unix seconds. */
  now?: () => number;
  /** Needed when `reserve_proof_check_above_xmr` is set. */
  reserveVerifier?: ReserveProofVerifier;
  poolDepth?: PoolDepthReader;
  /** Used by `cancel(handle)` when it is called in its frozen one-argument form. */
  execContext?: ExecContext;
  programId?: PublicKey;
  /** Network cost of one piece (swap plus withdrawal request and its rent), in SOL. Default 0.003. */
  networkFeeSolPerPiece?: number;
  /** The maker's own XMR addresses. `redeemHeld` pays out only to these; without a list it refuses. */
  allowlist?: Allowlist;
}

interface WithdrawalRec { nonce: string; amount: string; state: 'intent' | 'requested' | 'completed' | 'reverted' | 'cancelled'; sig?: string; moneroTxid?: string; paid?: string; detail?: string }
interface Rec {
  dir: 'refill' | 'reverse';
  from: AssetId; to: AssetId; payout: string;
  /** Planned piece inputs, in the units of the asset being swapped (refill: `from`; reverse: wXMR, filled in after the mint). */
  pieces: string[];
  next: number;
  swaps: { sig: string; amountIn: string; out: string }[];
  /** A swap that was handed to the wallet and has not been seen to land. */
  swapIntent?: number;
  held?: string;
  stopped?: string;
  // refill
  pendingWxmr: string;
  withdrawals: WithdrawalRec[];
  // reverse
  phase?: 'await_address' | 'xmr_intent' | 'await_mint' | 'selling' | 'done';
  amountIn?: string;
  pieceCount?: number;
  baseline?: string;
  xmrTxid?: string;
  setupSig?: string;
}

const MINT: Partial<Record<AssetId, PublicKey>> = { usdc_sol: USDC_MINT, sol: WSOL_MINT };

export class WxmrBridgeAdapter implements VenueAdapter {
  readonly id = 'wxmr_bridge' as const;
  private readonly d: BridgeDeps;
  private readonly program: PublicKey;
  private readonly wallet: PublicKey;
  private readonly store: AdapterStore;
  private readonly now: () => number;
  private readonly pdas: ReturnType<typeof bridgePdas>;
  private seq = 0;

  constructor(deps: BridgeDeps) {
    this.d = deps;
    this.program = deps.programId ?? BRIDGE_PROGRAM_ID;
    this.wallet = new PublicKey(deps.wallet);
    this.store = deps.store ?? new MemoryStore();
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.pdas = bridgePdas(this.program);
  }

  // ---------------------------------------------------------------- chain reads

  /** The effective withdrawal fee: the per-user override when one exists, else the config's. Also returns the config authority. */
  async config(): Promise<{ feeBps: number; authority: string }> {
    const [cfg, ovr] = await this.d.rpc.getAccounts([this.pdas.config().toBase58(), this.pdas.feeOverride(this.wallet).toBase58()]);
    if (!cfg) throw new VenueError(this.id, 'the bridge config account does not exist');
    const c = decodeBridgeConfig(cfg, this.program);
    if (c.wxmrMint !== WXMR_MINT.toBase58()) throw new VenueError(this.id, 'the bridge config names a different mint');
    let feeBps = c.feeBps;
    if (ovr && ovr.owner === this.program.toBase58()) {
      const o = decodeFeeOverride(ovr, this.program);
      if (o.user === this.wallet.toBase58()) feeBps = o.feeBps;
    }
    if (feeBps >= 10_000) throw new VenueError(this.id, 'the bridge fee is set to 100%');
    return { feeBps, authority: c.authority };
  }

  /**
   * Who can change this venue under the maker: the program's upgrade authority (null when it is
   * immutable) and the config authority, which can change the fee and reverse pending
   * withdrawals. SPEC 7.7: read from chain and shown before first use.
   */
  async authorities(): Promise<{ upgradeAuthority: string | null; configAuthority: string; feeBps: number; defaultFeeBps: number }> {
    const pd = await this.d.rpc.getAccount(this.pdas.programData().toBase58());
    if (!pd) throw new VenueError(this.id, 'the bridge program has no ProgramData account');
    const c = await this.config();
    return { upgradeAuthority: decodeUpgradeAuthority(pd), configAuthority: c.authority, feeBps: c.feeBps, defaultFeeBps: DEFAULT_WITHDRAW_FEE_BPS };
  }

  /** wXMR in the wallet's token account. */
  async heldWxmr(): Promise<bigint> {
    const a = await this.d.rpc.getAccount(associatedTokenAddress(this.wallet, WXMR_MINT).toBase58());
    return a ? decodeTokenAmount(a).amount : 0n;
  }

  private async heartbeat(): Promise<{ hb: Heartbeat | null; problem?: string }> {
    let hb: Heartbeat | null;
    try { hb = await readHeartbeat(this.d.rpc, this.program); } catch (e) { return { hb: null, problem: `heartbeat unreadable: ${(e as Error).message}` }; }
    if (!hb) return { hb: null, problem: 'the bridge has published no heartbeat' };
    if (!heartbeatOnline(hb, this.now())) return { hb, problem: `the bridge heartbeat is stale (last update ${this.now() - Math.min(hb.updatedAt, hb.observedAt)} s ago; offline after 360 s)` };
    return { hb };
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.d.settings.require_heartbeat) return { ok: true };
    const { problem } = await this.heartbeat();
    return problem ? { ok: false, reason: problem } : { ok: true };
  }

  /** Heartbeat, payout capacity and (above the configured size) the reserve proof, before XMR is expected from the bridge. */
  private async preflight(xmrOut: bigint): Promise<string | undefined> {
    const s = this.d.settings;
    const { hb, problem } = await this.heartbeat();
    if (s.require_heartbeat && problem) return problem;
    if (hb && !problem && hb.unlockedAtomic < xmrOut) return `the bridge can pay out ${toFloat('xmr', hb.unlockedAtomic)} XMR right now, less than this refill`;
    if (s.reserve_proof_check_above_xmr !== undefined && toFloat('xmr', xmrOut) > s.reserve_proof_check_above_xmr) {
      if (!this.d.reserveVerifier) return 'a reserve-proof check is required for this size, but no verifier (own Monero node) is configured';
      if (!hb) return 'a reserve-proof check is required for this size, but there is no heartbeat naming a proof';
      const r = await checkReserve(this.d.rpc, this.d.reserveVerifier, hb, xmrOut, this.program);
      if (!r.ok) return `reserve-proof check failed: ${r.reason}`;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- limits and quotes

  private direction(from: AssetId, to: AssetId): 'refill' | 'reverse' {
    if (to === 'xmr' && (from === 'usdc_sol' || from === 'sol')) return 'refill';
    if (from === 'xmr' && (to === 'usdc_sol' || to === 'sol')) return 'reverse';
    throw new VenueError(this.id, `the bridge route does not serve ${from} -> ${to}`);
  }

  async limits(from: AssetId, to: AssetId): Promise<{ min: bigint; max: bigint | null }> {
    if (this.direction(from, to) === 'reverse') return { min: BRIDGE_MIN_ATOMIC, max: null };
    // The 0.1 XMR minimum applies to the wXMR bought; 5% is left for price movement and the pool's spread.
    return { min: await unitsForUsd(this.d.prices, from, (await usdValue(this.d.prices, 'xmr', BRIDGE_MIN_ATOMIC)) * 1.05), max: null };
  }

  /** Splits `total` into pieces no larger than the depth and held-wXMR caps allow. Returns the per-piece cap in USD (Infinity when uncapped). */
  private async pieceCapUsd(): Promise<number> {
    const s = this.d.settings;
    let cap = Infinity;
    if (this.d.poolDepth) cap = Math.min(cap, ((await this.d.poolDepth()).usd * s.max_piece_pct_of_pool) / 100);
    if (s.max_wxmr_held !== undefined) cap = Math.min(cap, s.max_wxmr_held * (await this.d.prices.usd('xmr')));
    return cap;
  }

  private split(total: bigint, pieces: number): bigint[] {
    const each = mulDivCeil(total, 1n, BigInt(pieces));
    const out: bigint[] = [];
    let left = total;
    while (left > 0n) { const p = left < each ? left : each; out.push(p); left -= p; }
    return out;
  }

  private async networkFeesUsd(pieces: number): Promise<number> {
    return pieces * (this.d.networkFeeSolPerPiece ?? 0.003) * (await this.d.prices.usd('sol'));
  }

  async quote(req: RefillRequest): Promise<VenueQuote> {
    const dir = this.direction(req.from, req.to);
    if ((req.amountIn === undefined) === (req.amountOut === undefined)) throw new VenueError(this.id, 'exactly one of amountIn and amountOut must be set');
    const { feeBps } = await this.config();
    const inMint = dir === 'refill' ? MINT[req.from]! : WXMR_MINT, outMint = dir === 'refill' ? WXMR_MINT : MINT[req.to]!;
    // What reaches the swap, and what leaves it, per unit of what the maker asks for.
    const toSwapIn = (amountIn: bigint) => (dir === 'refill' ? amountIn : amountIn - (amountIn * DEPOSIT_FEE_BPS) / 10_000n);
    const fromSwapOut = (out: bigint) => (dir === 'refill' ? withdrawalNet(out, feeBps).net : out);

    let amountIn = req.amountIn;
    if (amountIn === undefined) {
      const probeIn = await unitsForUsd(this.d.prices, req.from, await usdValue(this.d.prices, req.to, req.amountOut!));
      const probeOut = fromSwapOut((await this.d.jupiter.quote(inMint.toBase58(), outMint.toBase58(), toSwapIn(probeIn))).outAmount);
      if (probeOut <= 0n) throw new VenueError(this.id, 'the pool quoted a zero output');
      amountIn = mulDivCeil(probeIn, req.amountOut!, probeOut);
    }
    if (dir === 'reverse' && amountIn < BRIDGE_MIN_ATOMIC) throw new VenueError(this.id, 'below the bridge minimum of 0.1 XMR');

    const inUsd = await usdValue(this.d.prices, req.from, amountIn);
    const capUsd = await this.pieceCapUsd();
    let pieces = Number.isFinite(capUsd) ? Math.max(1, Math.ceil(inUsd / capUsd)) : 1;
    if (!(capUsd > 0)) throw new VenueError(this.id, 'the pool is empty or the held-wXMR cap is zero');
    let jq: JupiterQuote;
    for (let halvings = 0; ; halvings++) {
      if (pieces > 64) throw new VenueError(this.id, 'the pool is too thin for this size: more than 64 pieces would be needed');
      jq = await this.d.jupiter.quote(inMint.toBase58(), outMint.toBase58(), toSwapIn(this.split(amountIn, pieces)[0]!));
      // Without a direct depth read, the quote's own price impact stands in for the share of the pool.
      if (this.d.poolDepth || jq.priceImpactPct <= this.d.settings.max_piece_pct_of_pool || halvings >= 6) break;
      pieces *= 2;
    }
    const pieceIns = this.split(amountIn, pieces);
    if (dir === 'refill' && jq.outAmount < BRIDGE_MIN_ATOMIC) throw new VenueError(this.id, 'a piece would buy less than the bridge minimum of 0.1 XMR');
    // Later pieces are priced as the first one; each is re-quoted and re-checked when it runs.
    const swapOutTotal = (jq.outAmount * toSwapIn(amountIn)) / jq.inAmount;
    const amountOut = fromSwapOut(swapOutTotal);
    if (amountOut <= 0n) throw new VenueError(this.id, 'the pool quoted a zero output');

    if (dir === 'refill') {
      const problem = await this.preflight(amountOut);
      if (problem) throw new VenueError(this.id, problem);
    } else if (this.d.settings.require_heartbeat) {
      const { problem } = await this.heartbeat();
      if (problem) throw new VenueError(this.id, problem);
    }
    const cost = await costAgainstReference(this.d.prices, req.from, amountIn, req.to, amountOut, await this.networkFeesUsd(pieces));
    return {
      venue: this.id, request: req, amountIn, amountOut, feesUsd: cost.feesUsd, costPct: cost.costPct, expiresAt: this.now() + 30, pieces,
      raw: { direction: dir, pieces: pieceIns.map(String), feeBps, priceImpactPct: jq.priceImpactPct, firstPiece: jq.raw },
    };
  }

  // ---------------------------------------------------------------- record plumbing

  private async load(handle: string): Promise<Rec> {
    const s = await this.store.get(handle);
    if (!s) throw new VenueError(this.id, `unknown handle ${handle}`);
    return JSON.parse(s) as Rec;
  }
  private save(handle: string, rec: Rec): Promise<void> { return this.store.put(handle, JSON.stringify(rec)); }

  private async measuredSwap(sig: string, mint: PublicKey, asset: AssetId | 'wxmr'): Promise<bigint | null> {
    const tx = await this.d.rpc.getTransaction(sig);
    if (!tx) return null;
    if (tx.err) throw new VenueError(this.id, `swap ${sig} failed on chain`, true);
    // SOL arrives unwrapped: its change is the wallet's lamport delta, fees included.
    return asset === 'sol' ? lamportDelta(tx, this.wallet.toBase58()) : tokenDelta(tx, this.wallet.toBase58(), mint.toBase58());
  }

  /** One Jupiter swap, journalled and recorded as an intent before it is handed to the wallet. Returns what the wallet received. */
  private async swap(handle: string, rec: Rec, ctx: ExecContext, jq: JupiterQuote, outMint: PublicKey, outAsset: AssetId | 'wxmr'): Promise<bigint> {
    const tx = await this.d.jupiter.swapTransaction(jq, this.wallet.toBase58());
    rec.swapIntent = rec.next;
    await this.save(handle, rec);
    await ctx.journal('wxmr_bridge.swap', { handle, piece: rec.next, inputMint: jq.inputMint, outputMint: jq.outputMint, amountIn: jq.inAmount.toString(), minOut: jq.minOutAmount.toString() });
    let sig: string;
    try {
      sig = await ctx.sendSol({ kind: 'versioned_tx', base64: tx, label: `wxmr_bridge swap piece ${rec.next + 1}/${rec.pieces.length}` });
    } catch (e) {
      rec.held = `swap piece ${rec.next + 1} was handed to the wallet and its outcome is unknown (${(e as Error).message}); it is not re-sent`;
      await this.save(handle, rec);
      throw new VenueError(this.id, rec.held, true);
    }
    const got = await this.measuredSwap(sig, outMint, outAsset);
    if (got === null || got <= 0n) {
      rec.held = `swap ${sig} was sent but what it delivered could not be read from the transaction`;
      await this.save(handle, rec);
      throw new VenueError(this.id, rec.held, true);
    }
    rec.swaps.push({ sig, amountIn: jq.inAmount.toString(), out: got.toString() });
    rec.next += 1;
    delete rec.swapIntent;
    await this.save(handle, rec);
    await ctx.journal('wxmr_bridge.swapped', { handle, signature: sig, received: got.toString() });
    return got;
  }

  // ---------------------------------------------------------------- refill

  private maxCost(): number { return this.d.settings.max_cost_pct ?? Infinity; }

  /** Sends (or re-sends, under the same nonce) the withdrawal request for an intent that is already on record. */
  private async sendWithdrawal(handle: string, rec: Rec, w: WithdrawalRec, ctx: ExecContext): Promise<void> {
    const ix = requestWithdrawalIx({ user: this.wallet, nonce: BigInt(w.nonce), amount: BigInt(w.amount), xmrAddress: rec.payout, exactOut: false }, this.program);
    try {
      w.sig = await ctx.sendSol({ kind: 'instructions', instructions: [ix], label: `wxmr_bridge request_withdrawal nonce ${w.nonce}` });
    } catch (e) {
      // Left as an intent: the next step looks for the record on chain and, if it is not there, sends the same nonce again.
      w.detail = `request not confirmed (${(e as Error).message})`;
      await this.save(handle, rec);
      throw new VenueError(this.id, `request_withdrawal for nonce ${w.nonce} is unconfirmed; it will be re-checked, and re-sent only under the same nonce`, true);
    }
    w.state = 'requested';
    delete w.detail;
    await this.save(handle, rec);
    await ctx.journal('wxmr_bridge.withdrawal_requested', { handle, nonce: w.nonce, signature: w.sig });
  }

  private async redeem(handle: string, rec: Rec, ctx: ExecContext): Promise<void> {
    const amount = BigInt(rec.pendingWxmr);
    if (amount < BRIDGE_MIN_ATOMIC) {
      rec.held = `${toFloat('xmr', amount)} wXMR is in the wallet, below the bridge minimum of 0.1 XMR; it cannot be redeemed on its own`;
      await this.save(handle, rec);
      return;
    }
    const st = await this.d.rpc.getAccount(this.pdas.withdrawalState(this.wallet).toBase58());
    const last = st ? decodeWithdrawalState(st, this.program).lastNonce : 0n;
    const ours = rec.withdrawals.reduce((m, w) => (BigInt(w.nonce) > m ? BigInt(w.nonce) : m), 0n);
    const nonce = nextWithdrawalNonce(last > ours ? last : ours, ctx.now());
    const w: WithdrawalRec = { nonce: nonce.toString(), amount: amount.toString(), state: 'intent' };
    rec.withdrawals.push(w);
    rec.pendingWxmr = '0';
    // The nonce is on record and in the journal before anything is sent.
    await this.save(handle, rec);
    await ctx.journal('wxmr_bridge.request_withdrawal', { handle, nonce: w.nonce, amount: w.amount, xmrAddress: rec.payout, exactOut: false });
    await this.sendWithdrawal(handle, rec, w, ctx);
  }

  /** Settles withdrawal intents left by a failed or interrupted send. */
  private async resumeWithdrawals(handle: string, rec: Rec, ctx: ExecContext): Promise<void> {
    for (const w of rec.withdrawals) {
      if (w.state !== 'intent') continue;
      const nonce = BigInt(w.nonce);
      const [record, state] = await this.d.rpc.getAccounts([this.pdas.withdrawal(this.wallet, nonce).toBase58(), this.pdas.withdrawalState(this.wallet).toBase58()]);
      // The record exists, or the watermark has reached this nonce (so it existed and has been closed): the request landed.
      if (record || (state && decodeWithdrawalState(state, this.program).lastNonce >= nonce)) {
        w.state = 'requested';
        delete w.detail;
        await this.save(handle, rec);
      } else {
        await ctx.journal('wxmr_bridge.request_withdrawal', { handle, nonce: w.nonce, amount: w.amount, xmrAddress: rec.payout, exactOut: false, resend: true });
        await this.sendWithdrawal(handle, rec, w, ctx);
      }
    }
  }

  private remaining(rec: Rec): bigint {
    return rec.pieces.slice(rec.next).reduce((a, p) => a + BigInt(p), 0n);
  }

  /** Buys the next piece if the checks pass, then redeems. `first` turns a failed check into an error (nothing has moved yet). */
  private async stepRefill(handle: string, rec: Rec, ctx: ExecContext, first: boolean): Promise<void> {
    if (rec.held) return;
    if (rec.swapIntent !== undefined) {
      rec.held = `swap piece ${rec.swapIntent + 1} was being sent when the process stopped; check the wallet. It is not re-sent.`;
      await this.save(handle, rec);
      return;
    }
    await this.resumeWithdrawals(handle, rec, ctx);
    const s = this.d.settings;
    const cfg = await this.config();
    let capBlocked = false;

    if (!rec.stopped && rec.next < rec.pieces.length) {
      const pieceIn = BigInt(rec.pieces[rec.next]!);
      const jq = await this.d.jupiter.quote(MINT[rec.from]!.toBase58(), WXMR_MINT.toBase58(), pieceIn);
      const net = withdrawalNet(jq.outAmount, cfg.feeBps).net;
      const stop = async (why: string, wait: boolean): Promise<boolean> => {
        if (first) throw new VenueError(this.id, why);
        if (wait) return true;
        rec.stopped = why;
        await this.save(handle, rec);
        await ctx.journal('wxmr_bridge.stopped', { handle, reason: why, unfilled: this.remaining(rec).toString() });
        return true;
      };
      let skip = false;
      const problem = await this.preflight(net + withdrawalNet(BigInt(rec.pendingWxmr), cfg.feeBps).net);
      // A stale heartbeat or a busy bridge is waited out; a price that no longer fits passes the rest to the next venue.
      if (problem) skip = await stop(problem, true);
      if (!skip && s.max_wxmr_held !== undefined && toFloat('xmr', (await this.heldWxmr()) + jq.outAmount) > s.max_wxmr_held) {
        skip = capBlocked = await stop(`buying this piece would put more than ${s.max_wxmr_held} wXMR in the wallet`, true);
      }
      if (!skip && jq.outAmount < BRIDGE_MIN_ATOMIC && BigInt(rec.pendingWxmr) + jq.outAmount < BRIDGE_MIN_ATOMIC) skip = await stop('the piece would buy less than the bridge minimum of 0.1 XMR', false);
      if (!skip) {
        const cost = await costAgainstReference(this.d.prices, rec.from, pieceIn, 'xmr', net, await this.networkFeesUsd(1));
        if (cost.costPct > this.maxCost()) skip = await stop(`piece ${rec.next + 1} would cost ${cost.costPct.toFixed(2)}% against the reference price, above the ${this.maxCost()}% limit`, false);
      }
      if (!skip) {
        const got = await this.swap(handle, rec, ctx, jq, WXMR_MINT, 'wxmr');
        rec.pendingWxmr = (BigInt(rec.pendingWxmr) + got).toString();
        await this.save(handle, rec);
      }
    }

    const pending = BigInt(rec.pendingWxmr);
    if (pending > 0n) {
      const nothingMoreToBuy = !!rec.stopped || rec.next >= rec.pieces.length;
      // With `redeem_immediately = false` wXMR accumulates up to the held cap and is then redeemed in one request.
      if (s.redeem_immediately || nothingMoreToBuy || capBlocked) await this.redeem(handle, rec, ctx);
    }
  }

  // ---------------------------------------------------------------- reverse

  private async stepReverse(handle: string, rec: Rec, ctx: ExecContext): Promise<void> {
    if (rec.held) return;
    if (rec.phase === 'xmr_intent') {
      rec.held = 'the XMR deposit was being sent when the process stopped; check the Monero wallet. It is not re-sent.';
      await this.save(handle, rec);
      return;
    }
    if (rec.swapIntent !== undefined) {
      rec.held = `swap piece ${rec.swapIntent + 1} was being sent when the process stopped; check the wallet. It is not re-sent.`;
      await this.save(handle, rec);
      return;
    }
    const depositAddress = this.pdas.deposit(this.wallet).toBase58();
    if (rec.phase === 'await_address') {
      const a = await this.d.rpc.getAccount(depositAddress);
      if (!a) return;
      const dep = decodeDepositRecord(a, this.program);
      if (dep.owner !== this.wallet.toBase58()) throw new VenueError(this.id, 'the deposit record belongs to another wallet');
      if (dep.status !== 'Active' || dep.xmrDepositAddress === '') return;
      rec.baseline = dep.totalDeposited.toString();
      rec.phase = 'xmr_intent';
      await this.save(handle, rec);
      await ctx.journal('wxmr_bridge.deposit_xmr', { handle, to: dep.xmrDepositAddress, amount: rec.amountIn, totalDepositedBefore: rec.baseline });
      try {
        rec.xmrTxid = await ctx.sendXmr({ to: dep.xmrDepositAddress, amount: BigInt(rec.amountIn!) });
      } catch (e) {
        rec.held = `the XMR deposit's outcome is unknown (${(e as Error).message}); it is not re-sent`;
        await this.save(handle, rec);
        throw new VenueError(this.id, rec.held, true);
      }
      rec.phase = 'await_mint';
      await this.save(handle, rec);
      await ctx.journal('wxmr_bridge.xmr_deposited', { handle, txid: rec.xmrTxid });
      return;
    }
    if (rec.phase === 'await_mint') {
      const a = await this.d.rpc.getAccount(depositAddress);
      if (!a) return;
      // `total_deposited` counts gross; the mint is the gross less the 0.1% deposit fee.
      if (decodeDepositRecord(a, this.program).totalDeposited < BigInt(rec.baseline!) + BigInt(rec.amountIn!)) return;
      const gross = BigInt(rec.amountIn!);
      const minted = gross - (gross * DEPOSIT_FEE_BPS) / 10_000n;
      rec.pieces = this.split(minted, rec.pieceCount ?? 1).map(String);
      rec.phase = 'selling';
      await this.save(handle, rec);
      await ctx.journal('wxmr_bridge.minted', { handle, wxmr: minted.toString() });
    }
    if (rec.phase === 'selling') {
      const piece = BigInt(rec.pieces[rec.next]!);
      // The mint goes to a pending account when the token account is missing; wait until the wXMR is really there.
      if ((await this.heldWxmr()) < piece) return;
      const outMint = MINT[rec.to]!;
      const jq = await this.d.jupiter.quote(WXMR_MINT.toBase58(), outMint.toBase58(), piece);
      const cost = await costAgainstReference(this.d.prices, 'xmr', piece, rec.to, jq.outAmount, await this.networkFeesUsd(1));
      // The wXMR is already held, so a bad price is waited out rather than passed on.
      if (cost.costPct > this.maxCost()) return;
      await this.swap(handle, rec, ctx, jq, outMint, rec.to);
      if (rec.next >= rec.pieces.length) { rec.phase = 'done'; await this.save(handle, rec); }
    }
  }

  // ---------------------------------------------------------------- VenueAdapter

  async execute(quote: VenueQuote, ctx: ExecContext): Promise<{ handle: string }> {
    if (quote.venue !== this.id) throw new VenueError(this.id, `quote belongs to ${quote.venue}`);
    if (ctx.now() >= quote.expiresAt) throw new VenueError(this.id, 'quote has expired');
    const req = quote.request;
    const dir = this.direction(req.from, req.to);
    const raw = quote.raw as { pieces?: unknown };
    if (!Array.isArray(raw?.pieces) || raw.pieces.length === 0) throw new VenueError(this.id, 'quote carries no piece plan');
    const handle = `wxmr_bridge:${ctx.now()}-${++this.seq}`;
    const rec: Rec = { dir, from: req.from, to: req.to, payout: req.payoutAddress, pieces: raw.pieces.map(String), next: 0, swaps: [], pendingWxmr: '0', withdrawals: [] };

    if (dir === 'refill') {
      await ctx.journal('wxmr_bridge.refill', { handle, from: req.from, amountIn: quote.amountIn.toString(), pieces: rec.pieces, xmrAddress: req.payoutAddress });
      await this.save(handle, rec);
      await this.stepRefill(handle, rec, ctx, true);
      return { handle };
    }

    // The sale's proceeds land in the wallet that owns the deposit record; no other payout is possible.
    if (req.payoutAddress !== this.wallet.toBase58()) throw new VenueError(this.id, 'selling XMR through the bridge pays out to the maker wallet only');
    rec.amountIn = quote.amountIn.toString();
    rec.pieceCount = rec.pieces.length;
    rec.pieces = [];
    rec.phase = 'await_address';
    await ctx.journal('wxmr_bridge.reverse', { handle, to: req.to, amountIn: rec.amountIn });
    const existing = await this.d.rpc.getAccount(this.pdas.deposit(this.wallet).toBase58());
    await this.save(handle, rec);
    if (!existing) {
      await ctx.journal('wxmr_bridge.create_deposit_account', { handle, wallet: this.wallet.toBase58() });
      // The token account is created in the same transaction so mints land directly.
      rec.setupSig = await ctx.sendSol({ kind: 'instructions', instructions: [createAtaIdempotentIx(this.wallet, this.wallet, WXMR_MINT), createDepositAccountIx(this.wallet, this.program)], label: 'wxmr_bridge create_deposit_account' });
      await this.save(handle, rec);
    }
    await this.stepReverse(handle, rec, ctx);
    return { handle };
  }

  async advance(handle: string, ctx: ExecContext): Promise<RefillStatus> {
    const rec = await this.load(handle);
    try {
      if (rec.dir === 'refill') await this.stepRefill(handle, rec, ctx, false);
      else await this.stepReverse(handle, rec, ctx);
    } catch (e) {
      // The record already says what happened; a poll must not throw for a parked refill.
      if (!(e instanceof VenueError && e.fundsMoved)) throw e;
    }
    return this.status(handle);
  }

  /** Looks a closed withdrawal up in its PDA's signature history. */
  private async closedWithdrawal(pda: string): Promise<{ kind: 'completed'; txid: string; amount: bigint } | { kind: 'reverted'; reason: string } | null> {
    for (const s of await this.d.rpc.getSignatures(pda, 20)) {
      if (s.err) continue;
      const tx = await this.d.rpc.getTransaction(s.signature);
      if (!tx) continue;
      for (const ev of parseBridgeEvents(tx.logs)) {
        if (ev.withdrawalPda !== pda) continue;
        if (ev.kind === 'completed') return { kind: 'completed', txid: ev.xmrTxHash, amount: ev.amount };
        return { kind: 'reverted', reason: ev.reason };
      }
    }
    return null;
  }

  async status(handle: string): Promise<RefillStatus> {
    const rec = await this.load(handle);
    const ids = [rec.setupSig, rec.xmrTxid, ...rec.swaps.map((s) => s.sig)].filter((x): x is string => !!x);

    if (rec.dir === 'reverse') {
      const received = rec.swaps.reduce((a, s) => a + BigInt(s.out), 0n);
      if (rec.held) return { state: 'held', detail: rec.held, txids: ids };
      switch (rec.phase) {
        case 'await_address': return { state: 'pending', detail: 'waiting for the bridge to assign a deposit address', txids: ids };
        case 'await_mint': return { state: 'depositing', detail: 'waiting for 10 Monero confirmations and the mint', txids: ids };
        case 'selling': return { state: 'processing', detail: `selling wXMR, piece ${rec.next + 1} of ${rec.pieces.length}`, txids: ids };
        case 'done': return { state: 'done', received, txids: ids };
        default: return { state: 'held', detail: 'unknown phase', txids: ids };
      }
    }

    let sending = false, dirty = false;
    for (const w of rec.withdrawals) {
      if (w.sig) ids.push(w.sig);
      if (w.state === 'requested') {
        const pda = this.pdas.withdrawal(this.wallet, BigInt(w.nonce)).toBase58();
        const a = await this.d.rpc.getAccount(pda);
        if (a) {
          sending ||= decodeWithdrawalRecord(a, this.program).status !== 'Pending';
        } else {
          const closed = await this.closedWithdrawal(pda);
          if (closed?.kind === 'completed') { w.state = 'completed'; w.moneroTxid = closed.txid; w.paid = closed.amount.toString(); dirty = true; }
          else if (closed?.kind === 'reverted') { w.state = 'reverted'; w.detail = closed.reason; dirty = true; }
        }
      }
      if (w.moneroTxid) ids.push(w.moneroTxid);
    }
    if (dirty) await this.save(handle, rec);
    if (rec.held) return { state: 'held', detail: rec.held, txids: ids };

    const open = rec.withdrawals.filter((w) => w.state === 'intent' || w.state === 'requested').length;
    const buying = !rec.stopped && rec.next < rec.pieces.length;
    if (open > 0 || buying || BigInt(rec.pendingWxmr) > 0n) {
      const state = sending ? 'paying_out' : rec.swaps.length === 0 ? 'pending' : 'processing';
      return { state, detail: `piece ${Math.min(rec.next + (buying ? 1 : 0), rec.pieces.length)} of ${rec.pieces.length}; ${open} redemption(s) open`, txids: ids };
    }
    const paid = rec.withdrawals.filter((w) => w.state === 'completed').reduce((a, w) => a + BigInt(w.paid ?? '0'), 0n);
    const returned = rec.withdrawals.filter((w) => w.state === 'cancelled' || w.state === 'reverted');
    const unfilled = this.remaining(rec);
    const notes: string[] = [];
    if (rec.stopped) notes.push(`stopped: ${rec.stopped}`);
    if (returned.length) notes.push(`${returned.length} redemption(s) cancelled or reversed: the wXMR is back in the wallet (the bridge keeps its fee on a cancel)`);
    const out: RefillStatus = { state: paid > 0n ? 'done' : returned.length ? 'refunded' : 'failed', txids: ids };
    if (paid > 0n) out.received = paid;
    if (unfilled > 0n) out.unfilled = unfilled;
    if (notes.length) out.detail = notes.join('; ');
    return out;
  }

  /**
   * Implements `stalled_redeem_minutes`: cancels every redemption that is still `Pending` and at
   * least 300 s old, and stops buying. The net wXMR is re-minted to the wallet; the fee is not
   * returned. A redemption the bridge has marked `Sending` can never be cancelled.
   */
  async cancel(handle: string, ctx: ExecContext | undefined = this.d.execContext): Promise<void> {
    if (!ctx) throw new VenueError(this.id, 'cancelling needs an ExecContext to send the cancel transaction');
    const rec = await this.load(handle);
    if (rec.dir === 'reverse') throw new VenueError(this.id, 'a deposit of XMR to the bridge cannot be cancelled');
    if (rec.withdrawals.some((w) => w.state === 'intent')) throw new VenueError(this.id, 'a redemption request is unconfirmed; advance the refill before cancelling');
    const todo: { w: WithdrawalRec; nonce: bigint }[] = [];
    let sending = 0;
    for (const w of rec.withdrawals) {
      if (w.state !== 'requested') continue;
      const nonce = BigInt(w.nonce);
      const a = await this.d.rpc.getAccount(this.pdas.withdrawal(this.wallet, nonce).toBase58());
      if (!a) continue; // closed: completed or reversed; `status` reads which
      const r = decodeWithdrawalRecord(a, this.program);
      if (r.user !== this.wallet.toBase58()) throw new VenueError(this.id, 'the withdrawal record belongs to another wallet');
      if (r.status !== 'Pending') { sending++; continue; }
      if (ctx.now() - r.createdAt < CANCEL_DELAY_SECONDS) throw new VenueError(this.id, `a redemption can be cancelled only ${CANCEL_DELAY_SECONDS} s after it was requested`);
      todo.push({ w, nonce });
    }
    if (!rec.stopped) rec.stopped = 'cancelled';
    await this.save(handle, rec);
    const { authority } = await this.config();
    for (const { w, nonce } of todo) {
      await ctx.journal('wxmr_bridge.cancel_withdrawal', { handle, nonce: w.nonce, amount: w.amount });
      const sig = await ctx.sendSol({ kind: 'instructions', instructions: [cancelWithdrawalIx({ user: this.wallet, nonce, authority: new PublicKey(authority) }, this.program)], label: `wxmr_bridge cancel_withdrawal nonce ${w.nonce}` });
      w.state = 'cancelled';
      w.detail = `cancelled in ${sig}`;
      await this.save(handle, rec);
    }
    if (sending > 0) throw new VenueError(this.id, `${sending} redemption(s) are already being sent by the bridge and can no longer be cancelled`);
  }

  /** Redeems wXMR sitting in the wallet (after a cancel, or bought with `redeem_immediately = false`) as a refill of its own. */
  async redeemHeld(payoutAddress: string, ctx: ExecContext, amount?: bigint): Promise<{ handle: string }> {
    if (!this.d.allowlist) throw new VenueError(this.id, 'no address allow-list is configured');
    assertAllowed(this.d.allowlist, 'xmr', payoutAddress, 'payout');
    const held = await this.heldWxmr();
    const amt = amount ?? held;
    if (amt > held) throw new VenueError(this.id, 'the wallet holds less wXMR than that');
    if (amt < BRIDGE_MIN_ATOMIC) throw new VenueError(this.id, 'below the bridge minimum of 0.1 XMR');
    const problem = await this.preflight(withdrawalNet(amt, (await this.config()).feeBps).net);
    if (problem) throw new VenueError(this.id, problem);
    const handle = `wxmr_bridge:${ctx.now()}-${++this.seq}`;
    const rec: Rec = { dir: 'refill', from: 'usdc_sol', to: 'xmr', payout: payoutAddress, pieces: [], next: 0, swaps: [], pendingWxmr: amt.toString(), withdrawals: [] };
    await this.save(handle, rec);
    await this.redeem(handle, rec, ctx);
    return { handle };
  }
}
