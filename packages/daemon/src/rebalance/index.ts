/**
 * Rebalancing and refills (DESIGN "Liquidity rebalancing and refills"; SPEC 7.1 `rebalance/`,
 * 7.7). Routing, caps, modes, the allow-list, test transfers and stall handling are enforced
 * inside `@xmrswap/rebalancer`'s `Rebalancer`; this module owns what only the daemon has: the
 * triggers (levels, schedule, manual), the `ExecContext` (every send under the intent
 * journal, resolved only after confirmation, never re-sent on ambiguity), durable state, the
 * reference prices, the maker's own addresses for the allow-list, and the reserve-proof check.
 */
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from '@solana/spl-token';
import { PublicKey, SystemProgram, type TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { type AdapterStore, type Allowlist, type AssetId, DECIMALS, type ExecContext, type HttpClient, type PriceSource, Rebalancer, type RefillRecord, type RefillRequest, type ReserveProofVerifier, type StateStore, type VenueAdapter, type VenueId, VENUE_IDS, connectionRpc, createAdapters, evaluateLevels } from '@xmrswap/rebalancer';
import type { RebalanceSettings } from '@xmrswap/rebalancer';
import { ETH_NATIVE, base58Encode } from '@xmrswap/protocol';
import type { RebalanceManualRequest, RebalanceResponse, RefillView } from '@xmrswap/protocol/daemon-api';
import { ata } from '@xmrswap/sdk';
import type { Connection } from '@solana/web3.js';
import type { Alerts } from '../alerts/index.js';
import type { EthereumChain } from '../chains/ethereum.js';
import type { SolanaChain } from '../chains/solana.js';
import type { Inventory } from '../inventory/index.js';
import type { Keystore } from '../keystore/index.js';
import type { InventoryWallet } from '../monero/wallet.js';
import type { IntentKind, Store } from '../store/db.js';
import { CrashError, type Journal } from '../store/journal.js';
import { errMsg, fromJson, sleep, toJson, unitsToNumber } from '../util.js';

export interface RebalanceOptions {
  store: Store;
  journal: Journal;
  alerts: Alerts;
  keystore: Keystore;
  inventory: Inventory;
  wallet: InventoryWallet;
  settings: () => RebalanceSettings;
  usd: (asset: AssetId) => number | null;
  solana: () => SolanaChain | null;
  ethereum: () => EthereumChain | null;
  /** The raw connection the bridge adapter reads through (absent: the bridge venue stays off). */
  connection?: () => Connection | null;
  /** The bridge adapter's chain reads, when not through `connection` (tests). */
  bridgeRpc?: import('@xmrswap/rebalancer').SolanaRpc;
  /** Venue HTTP: injectable; tests use fixtures and no venue is ever contacted from them. */
  http: HttpClient;
  env: (name: string) => string | undefined;
  live: () => boolean;
  /** The maker's payout addresses, for the default allow-list. */
  payouts: () => Promise<{ sol: string[]; eth: string[] }>;
  /** Confirmation polling, milliseconds, and how long an unconfirmed send is waited for before it is parked. */
  pollMs?: number;
  confirmTimeoutMs?: number;
}

/** An ambiguous send: something may have left the wallet. Parked in `needs_review`; never retried. */
export class AmbiguousSend extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousSend';
  }
}

export class Rebalance {
  private rebalancer: Rebalancer | null = null;
  private adapters: Partial<Record<VenueId, VenueAdapter>> = {};
  private health = new Map<VenueId, { ok: boolean; reason: string | null }>();
  private lastScheduled = 0;
  private settingsUsed: RebalanceSettings | null = null;

  constructor(private readonly o: RebalanceOptions) {}

  // ---------------------------------------------------------------- what the package asks the daemon for

  readonly prices: PriceSource = {
    usd: async (asset) => {
      const p = this.o.usd(asset);
      if (p === null) throw new Error(`no reference price for ${asset}`);
      return p;
    },
  };
  readonly state: StateStore = { load: async () => this.o.store.kv('rebalance:state'), save: async (snapshot) => this.o.store.setKv('rebalance:state', snapshot) };
  readonly adapterStore: AdapterStore = { get: async (key) => this.o.store.kv(`rebalance:adapter:${key}`), put: async (key, value) => this.o.store.setKv(`rebalance:adapter:${key}`, value) };
  readonly reserveVerifier: ReserveProofVerifier = {
    check: async (proof) => {
      if (!this.o.wallet.checkReserveProof) throw new Error('the inventory wallet cannot check reserve proofs');
      return this.o.wallet.checkReserveProof(proof.address, proof.message, proof.signature);
    },
  };

  /** Refills pay out only to the maker's own addresses: the configured list, or the inventory wallet and the operator and payout addresses. */
  async allowlist(): Promise<Allowlist> {
    const cfg = this.o.settings().allowlist;
    const own = await this.o.payouts();
    const sol = this.o.solana();
    const eth = this.o.ethereum();
    return {
      xmr: cfg.xmr.length ? cfg.xmr : [await this.o.inventory.address()],
      sol: cfg.sol.length ? cfg.sol : [...(sol ? [sol.operator] : []), ...own.sol],
      eth: cfg.eth.length ? cfg.eth : [...(eth ? [eth.operator] : []), ...own.eth],
    };
  }

  /** Wait for a broadcast transaction; `confirmed` resolves, `failed`/`dead` throws cleanly, anything else is ambiguous. */
  private async confirm(kind: IntentKind, id: number, tx: string, status: () => Promise<'confirmed' | 'failed' | 'dead' | 'pending'>): Promise<string> {
    const deadline = Date.now() + (this.o.confirmTimeoutMs ?? 180_000);
    for (;;) {
      let s: 'confirmed' | 'failed' | 'dead' | 'pending' = 'pending';
      try {
        s = await status();
      } catch {
        // a lookup failure is not an answer
      }
      if (s === 'confirmed') {
        this.o.store.setIntent(id, 'confirmed');
        return tx;
      }
      if (s === 'failed' || s === 'dead') {
        this.o.store.setIntent(id, 'failed', { error: `the transaction ${s === 'failed' ? 'failed on-chain' : 'can no longer land'}` });
        throw new Error(`${kind} ${tx} ${s === 'failed' ? 'failed on-chain' : 'expired without landing'}`);
      }
      if (Date.now() > deadline) {
        this.o.store.setIntent(id, 'needs_review', { error: 'sent, not confirmed in time' });
        this.o.alerts.raise('critical', 'rebalance_send_ambiguous', `a rebalancing transfer (${tx}) was sent and is not confirmed; it is not re-sent`);
        throw new AmbiguousSend(`${tx} was sent but is not confirmed; parked for review`);
      }
      await sleep(this.o.pollMs ?? 500);
    }
  }

  /** The `ExecContext` adapters move funds through. Each send resolves with the id AFTER confirmation and never re-sends. */
  readonly ctx: ExecContext = {
    journal: async (step, data) => {
      const id = this.o.store.planIntent('venue_transfer', null, { step, data: fromJson(toJson(data)) });
      this.o.store.setIntent(id, 'confirmed');
    },
    now: () => this.o.store.now(),
    sendSol: async (send) => {
      const sol = this.o.solana();
      if (!sol) throw new Error('Solana is not configured');
      if (!this.o.live()) throw new Error('dry run: no transfer is sent');
      if (send.kind === 'versioned_tx') {
        // An aggregator's pre-built transaction: signed by the operator, sent as it is.
        const tx = VersionedTransaction.deserialize(Buffer.from(send.base64, 'base64'));
        const signer = this.o.keystore.solana;
        tx.addSignature(new PublicKey(signer.publicKey), Uint8Array.from(await signer.sign(tx.message.serialize())));
        const signature = base58Encode(tx.signatures[0]!);
        const { id } = await this.o.journal.broadcast('venue_transfer', null, { chain: 'solana', label: send.label }, async (onSigned) => {
          onSigned(signature, { signedAtMs: Date.now() });
          return sol.client.submit(tx.serialize());
        });
        return this.confirm('venue_transfer', id, signature, async () => (await sol.status(signature, this.o.store.intent(id)?.meta ?? null)).state);
      }
      let ixs: TransactionInstruction[];
      let label: string;
      if (send.kind === 'instructions') {
        ixs = send.instructions;
        label = send.label;
      } else {
        label = `transfer ${send.asset}`;
        const from = new PublicKey(sol.operator);
        const to = new PublicKey(send.to);
        if (send.asset === 'sol') ixs = [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: send.amount })];
        else {
          const mint = sol.client.program.usdcMint;
          if (!mint) throw new Error('the USDC mint is not known');
          ixs = [createAssociatedTokenAccountIdempotentInstruction(from, ata(to, mint), to, mint), createTransferInstruction(ata(from, mint), ata(to, mint), from, send.amount)];
        }
      }
      const { id, tx } = await this.o.journal.broadcast('venue_transfer', null, { chain: 'solana', label }, (onSigned) => sol.sendInstructions(ixs, onSigned));
      return this.confirm('venue_transfer', id, tx!, async () => (await sol.status(tx!, this.o.store.intent(id)?.meta ?? null)).state);
    },
    sendEth: async (send) => {
      const eth = this.o.ethereum();
      if (!eth) throw new Error('Ethereum is not configured');
      if (!this.o.live()) throw new Error('dry run: no transfer is sent');
      const token = send.asset === 'eth' ? ETH_NATIVE : await eth.client.usdc(eth.tag);
      const { id, tx } = await this.o.journal.broadcast('venue_transfer', null, { chain: 'ethereum', label: `transfer ${send.asset}` }, (onSigned) => eth.sendCall(eth.transferCall(token as `0x${string}`, send.to as `0x${string}`, send.amount), onSigned));
      return this.confirm('venue_transfer', id, tx!, async () => (await eth.status(tx!, this.o.store.intent(id)?.meta ?? null)).state);
    },
    sendXmr: async (send) => {
      if (!this.o.live()) throw new Error('dry run: no transfer is sent');
      try {
        return await this.o.inventory.send(send.to, send.amount);
      } catch (e) {
        if (e instanceof CrashError) throw e;
        // A refusal before anything was relayed is a clean failure; anything after the build is ambiguous.
        const relayed = this.o.store.intents({ kind: 'xmr_relay', status: ['planned'] }).some((i) => i.payload['send'] === true);
        if (relayed) throw new AmbiguousSend(`XMR payment: ${errMsg(e)}`);
        throw e;
      }
    },
  };

  // ---------------------------------------------------------------- lifecycle

  /** (Re)build the adapters and the rebalancer for the current settings. Called at start and when the settings change. */
  async reload(): Promise<string[]> {
    const settings = this.o.settings();
    const allowlist = await this.allowlist();
    const sol = this.o.solana();
    const conn = this.o.connection?.() ?? null;
    const built = createAdapters({
      settings, allowlist, http: this.o.http, prices: this.prices, env: this.o.env, store: this.adapterStore, now: () => this.o.store.now(), reserveVerifier: this.reserveVerifier, execContext: this.ctx,
      ...(sol && (conn || this.o.bridgeRpc) ? { solanaRpc: this.o.bridgeRpc ?? connectionRpc(conn!), solanaWallet: sol.operator } : {}),
      exchangeWithdrawKeys: (settings.venues.exchange as { withdraw_keys?: Record<string, string> }).withdraw_keys ?? {},
    });
    this.adapters = built.adapters;
    this.rebalancer = new Rebalancer({ settings, adapters: built.adapters, prices: this.prices, allowlist, now: () => this.o.store.now(), state: this.state, onAlert: (a) => this.o.alerts.raise(a.kind === 'held' || a.kind === 'failed' || a.kind === 'stalled' ? 'critical' : 'info', `rebalance_${a.kind}`, a.message) });
    await this.rebalancer.init();
    this.settingsUsed = settings;
    return built.warnings;
  }
  private async rb(): Promise<Rebalancer> {
    if (!this.rebalancer || this.settingsUsed !== this.o.settings()) await this.reload();
    return this.rebalancer!;
  }

  /** Balances in whole units, for the level triggers and the console. */
  async balances(): Promise<Partial<Record<AssetId, bigint>>> {
    const out: Partial<Record<AssetId, bigint>> = { xmr: this.o.inventory.capacity().total };
    const sol = this.o.solana();
    if (sol) {
      out.sol = (await sol.client.transport.getAccount(sol.operator))?.lamports ?? 0n;
      const mint = sol.client.program.usdcMint;
      if (mint) {
        const a = await sol.client.transport.getAccount(ata(sol.operator, mint).toBase58());
        out.usdc_sol = a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
      }
    }
    const eth = this.o.ethereum();
    if (eth) {
      out.eth = await eth.balanceOf(ETH_NATIVE, eth.operator as `0x${string}`);
      out.usdc_eth = await eth.balanceOf(await eth.client.usdc(eth.tag), eth.operator as `0x${string}`);
    }
    return out;
  }

  /** Where a refill of `to` is paid from / a drain of `from` is paid to, and the maker's own address for each side. */
  private async request(from: AssetId, to: AssetId, amount: { amountIn?: bigint; amountOut?: bigint }): Promise<RefillRequest> {
    const allow = await this.allowlist();
    const own = (asset: AssetId): string => {
      const family = asset === 'xmr' ? allow.xmr : asset === 'sol' || asset === 'usdc_sol' ? allow.sol : allow.eth;
      if (!family[0]) throw new Error(`no own address is known for ${asset}`);
      return family[0];
    };
    const s = this.o.settings();
    const venueRate = (s.venues.changenow as { rate?: 'fixed' | 'float' }).rate ?? 'float';
    return { from, to, ...amount, rate: venueRate, payoutAddress: own(to), refundAddress: own(from) };
  }

  /** A refill the maker (or a trigger) asks for. The package applies the caps, the mode and the allow-list. */
  async run(req: { from: AssetId; to: AssetId; amountIn?: bigint; amountOut?: bigint; venue?: VenueId }): Promise<RefillView> {
    const rb = await this.rb();
    const request = await this.request(req.from, req.to, { ...(req.amountIn !== undefined ? { amountIn: req.amountIn } : {}), ...(req.amountOut !== undefined ? { amountOut: req.amountOut } : {}) });
    const r = await rb.run(request, this.ctx, req.venue ? { venue: req.venue } : {});
    if (r.refill) return refillView(r.refill);
    return { id: `none-${this.o.store.now()}`, venue: r.plan.chosen?.venue ?? req.venue ?? 'manual', from: req.from, to: req.to, amount_in: (req.amountIn ?? 0n).toString(), amount_out: null, cost_pct: null, fees_usd: null, state: r.outcome === 'alerted' ? 'awaiting_approval' : 'cancelled', started_at: this.o.store.now(), finished_at: this.o.store.now(), venue_order_id: null, txids: [], detail: r.plan.reason ?? r.outcome };
  }
  async approve(id: string): Promise<RefillView> {
    return refillView(await (await this.rb()).approve(id, this.ctx));
  }
  async cancel(id: string): Promise<RefillView> {
    const rb = await this.rb();
    const rec = rb.refill(id);
    return refillView(rec.state === 'awaiting_approval' ? await rb.reject(id) : await rb.cancel(id, this.ctx));
  }
  /** The maker has checked a failed or held refill: resolve a held order if asked, then stop counting it as in transit. */
  async acknowledge(id: string, choice?: 'continue' | 'refund'): Promise<RefillView> {
    const rb = await this.rb();
    if (choice) await rb.resolveHeld(id, choice, this.ctx);
    else await rb.acknowledge(id);
    return refillView(rb.refill(id));
  }
  /** A refill done outside the console, recorded so inventory and cost tracking stay right. */
  manual(m: RebalanceManualRequest): RefillView {
    const list = this.manualRefills();
    const usd = (asset: AssetId, amount: string) => (this.o.usd(asset) ?? 0) * unitsToNumber(BigInt(amount), DECIMALS[asset]);
    const inUsd = usd(m.from, m.amount_in);
    const outUsd = usd(m.to, m.amount_out);
    const view: RefillView = { id: `manual-${this.o.store.now()}-${list.length}`, venue: 'manual', from: m.from, to: m.to, amount_in: m.amount_in, amount_out: m.amount_out, cost_pct: inUsd > 0 && outUsd > 0 ? ((inUsd - outUsd) / inUsd) * 100 : null, fees_usd: inUsd > 0 && outUsd > 0 ? inUsd - outUsd : null, state: 'done', started_at: this.o.store.now(), finished_at: this.o.store.now(), venue_order_id: null, txids: [], detail: m.note ?? null };
    this.o.store.setKv('rebalance:manual', JSON.stringify([...list, view]));
    return view;
  }
  private manualRefills(): RefillView[] {
    return JSON.parse(this.o.store.kv('rebalance:manual') ?? '[]') as RefillView[];
  }

  /** Measured cost of completed refills into XMR, percent of value: the offer engine can widen its deviation to cover it. */
  measuredCostPct(): number | null {
    const done = [...(this.rebalancer?.refills() ?? []).filter((r) => r.state === 'done' && r.request.to === 'xmr').map((r) => r.quote.costPct), ...this.manualRefills().filter((r) => r.to === 'xmr' && r.cost_pct !== null).map((r) => r.cost_pct!)];
    return done.length ? done.reduce((a, b) => a + b, 0) / done.length : null;
  }

  /**
   * Triggers: advance open refills; act on level breaches; run on the schedule. A breach of a
   * level is always at least an alert; whether a refill executes is the venue's mode. The
   * opposite-side flow venue is internal: when XMR is low and no venue is enabled, the maker is
   * told to tighten its buy-side deviation.
   */
  async tick(): Promise<void> {
    const rb = await this.rb();
    await rb.tick(this.ctx).catch((e) => this.o.alerts.raise('warning', 'rebalance_tick_failed', errMsg(e)));
    const settings = this.o.settings();
    const raw = await this.balances();
    const whole: Partial<Record<AssetId, number>> = {};
    for (const [asset, v] of Object.entries(raw) as [AssetId, bigint][]) whole[asset] = unitsToNumber(v, DECIMALS[asset]);
    const scheduled = this.scheduleDue(settings.routing.schedule);
    for (const action of evaluateLevels(settings, whole)) {
      const asset = action.asset as AssetId;
      const open = rb.refills().some((r) => !['done', 'failed', 'refunded', 'cancelled'].includes(r.state) && (r.request.to === asset || r.request.from === asset));
      if (open) continue;
      this.o.alerts.raise('warning', `level_${action.kind}`, `${asset} is ${action.kind === 'refill' ? 'below its low level' : 'above its high level'}: ${action.amount.toFixed(4)} to move`, null, 3_600);
      if (Object.keys(this.adapters).length === 0) {
        if (asset === 'xmr' && action.kind === 'refill') this.o.alerts.raise('info', 'opposite_side_flow', 'no refill venue is enabled: tighten the buy-XMR deviation to attract takers selling XMR', null, 86_400);
        continue;
      }
      const units = BigInt(Math.floor(action.amount * 1e6)) * 10n ** BigInt(DECIMALS[asset] - 6);
      // XMR is refilled from (and paying assets drained into) the other side of the book: USDC on Solana by default.
      const counter: AssetId = asset === 'xmr' ? this.payingAssetWithMost(whole) : 'xmr';
      try {
        if (action.kind === 'refill') await this.run({ from: counter, to: asset, amountOut: units });
        else await this.run({ from: asset, to: counter, amountIn: units });
      } catch (e) {
        this.o.alerts.raise('warning', 'rebalance_failed', errMsg(e), null, 3_600);
      }
    }
    if (scheduled) this.lastScheduled = this.o.store.now();
  }
  private payingAssetWithMost(whole: Partial<Record<AssetId, number>>): AssetId {
    const candidates: AssetId[] = ['usdc_sol', 'usdc_eth', 'sol', 'eth'];
    return candidates.map((a) => ({ a, usd: (whole[a] ?? 0) * (this.o.usd(a) ?? 0) })).sort((x, y) => y.usd - x.usd)[0]!.a;
  }
  /** `schedule`: `"every 6h"`, `"every 30m"`. Unset = level triggers only. */
  private scheduleDue(schedule: string | undefined): boolean {
    const m = schedule ? /^every\s+(\d+)\s*([hm])$/i.exec(schedule.trim()) : null;
    if (!m) return false;
    const secs = Number(m[1]) * (m[2]!.toLowerCase() === 'h' ? 3600 : 60);
    return this.o.store.now() - this.lastScheduled >= secs;
  }

  async view(): Promise<RebalanceResponse> {
    const rb = await this.rb();
    const settings = this.o.settings();
    const raw = await this.balances().catch(() => ({}) as Partial<Record<AssetId, bigint>>);
    const scale = (asset: AssetId, v: number | undefined): string | null => (v === undefined ? null : (BigInt(Math.round(v * 1e6)) * 10n ** BigInt(DECIMALS[asset] - 6)).toString());
    for (const id of VENUE_IDS) {
      const a = this.adapters[id];
      if (!a) continue;
      try {
        const h = await a.health();
        this.health.set(id, { ok: h.ok, reason: h.reason ?? null });
      } catch (e) {
        this.health.set(id, { ok: false, reason: errMsg(e) });
      }
    }
    return {
      mode: settings.mode,
      levels: (['xmr', 'sol', 'eth', 'usdc_sol', 'usdc_eth'] as AssetId[]).map((asset) => ({ asset, balance: (raw[asset] ?? 0n).toString(), low: scale(asset, settings.levels[asset]?.low), target: scale(asset, settings.levels[asset]?.target), high: scale(asset, settings.levels[asset]?.high) })),
      venues: VENUE_IDS.map((id) => ({ id, enabled: settings.venues[id].enabled && this.adapters[id] !== undefined, mode: rb.mode(id), healthy: this.health.get(id)?.ok ?? false, reason: this.health.get(id)?.reason ?? (this.adapters[id] ? null : 'not enabled'), cooldown_until: rb.cooldownUntil(id) })),
      in_transit_usd: rb.inTransitUsd(), max_in_transit_usd: settings.max_in_transit_usd ?? null,
      refills: [...rb.refills().map(refillView), ...this.manualRefills()].sort((a, b) => b.started_at - a.started_at),
    };
  }
}

export function refillView(r: RefillRecord): RefillView {
  return {
    id: r.id, venue: r.venue, from: r.request.from, to: r.request.to, amount_in: r.quote.amountIn.toString(), amount_out: (r.received ?? r.quote.amountOut).toString(), cost_pct: r.quote.costPct, fees_usd: r.quote.feesUsd,
    state: r.state, started_at: r.startedAt, finished_at: r.finishedAt,
    // A handle can embed a venue's per-order access token: only the venue's own order id is shown.
    venue_order_id: r.handle ? (r.handle.split(':')[1] ?? null) : null, txids: r.txids, detail: r.detail,
    // Additions to the frozen shape. `needs_acknowledgement`: held, or failed with funds possibly still at the venue (it
    // keeps counting against the in-transit cap). `acknowledged`: a failed refill the maker has closed, or one that never needed it.
    ...({ needs_acknowledgement: r.state === 'held' || (r.state === 'failed' && r.unresolved), acknowledged: r.state === 'failed' && !r.unresolved } as object),
  };
}
