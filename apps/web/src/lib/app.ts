/**
 * The application object: settings, wallets, the recovery vault, the swap engine, the registry
 * snapshot, large-swap orders and the inbox, wired together. React components read it through
 * `useSyncExternalStore`; nothing in here imports React, so the whole thing runs in unit tests
 * with a model-backed chain and scripted Monero nodes.
 */
import { Connection } from '@solana/web3.js';
import type { Address, ChainName, Market } from '@xmrswap/protocol';
import {
  type ApprovalResponseSolana,
  type Message,
} from '@xmrswap/protocol';
import {
  EthereumClient,
  LinkMemory,
  type MakerProfile,
  type PlannedWave,
  type SignedSolApproval,
  SolanaClient,
  type SwapView,
  connectionTransport,
  contactKeys,
  fromBase64,
  hex,
  keyBytes,
  legSettled,
  openFromMaker,
  sealToMaker,
  sendWithFallback,
  solApprovalFromResponse,
  solApprovalProblem,
  solanaMessageTransport,
  toBase64,
  torMessageTransport,
} from '@xmrswap/sdk';
import { Engine, type EngineState, type SwapNote, type Tracked } from './engine.js';
import { Guard, type GuardEnv } from './guard.js';
import { Inbox, type ReplyKey, type Thread } from './inbox.js';
import { type OfferRow, type RegistrySnapshot, type UpgradeStatus, marketOf, readRegistry } from './market.js';
import { OpenRefused, checkFundedShare, ethereumUpgradeStatus, makerHttp, openEthereum, openSolanaWave, solanaUpgradeStatus } from './open.js';
import { type Order, type OrderLeg, nextWave, stalledMakers } from './orders.js';
import { type ChainPort, EthereumPort, type EthereumWallet, type MoneroPort, SolanaPort, type SolanaWallet, httpEthTransport, moneroPort, swapRefOf } from './ports.js';
import { type Safety, safetyOf } from './safety.js';
import { SealedStore } from './sealed.js';
import { type Settings, loadSettings, saveSettings } from './settings.js';
import { type KV, local } from './storage.js';
import { Vault } from './vault.js';

export class Observable<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set(v: T): void {
    this.value = v;
    for (const f of this.listeners) f();
  }
  update(f: (v: T) => T): void {
    this.set(f(this.value));
  }
  subscribe = (f: () => void): (() => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
}

export interface Wallets {
  solana: SolanaWallet | null;
  ethereum: EthereumWallet | null;
}

export interface RegistryState {
  snapshot: RegistrySnapshot | null;
  loading: boolean;
  error: string | null;
  /** Local time of the snapshot, ms. */
  at: number | null;
}

export interface OpenResult {
  opened: (SwapView | null)[];
  errors: (string | null)[];
}

export interface AppDeps {
  kv: KV;
  /** Defaults shipped by the deployment (`config.json`). */
  deployment?: Partial<Settings>;
  guardEnv: GuardEnv;
  /** Test seams: stand-ins for the chain ports, Monero, the registry reader and the opener. */
  ports?: () => Partial<Record<ChainName, ChainPort>>;
  monero?: MoneroPort;
  readRegistry?: () => Promise<RegistrySnapshot>;
  openLegs?: (legs: { row: OfferRow; xmr: bigint }[], groups: number[][]) => Promise<OpenResult>;
  upgrade?: () => Promise<{ solana: UpgradeStatus; ethereum: UpgradeStatus }>;
}

const UNKNOWN: UpgradeStatus = { frozen: null, authority: null };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const ORDER_PREFIX = 'order.';
const approvalKey = (maker: string, taker: string): string => `xmrswap.approval.${maker}.${taker}`;

export class App {
  readonly settings: Observable<Settings>;
  readonly wallets = new Observable<Wallets>({ solana: null, ethereum: null });
  readonly registry = new Observable<RegistryState>({ snapshot: null, loading: false, error: null, at: null });
  readonly upgrade = new Observable<{ solana: UpgradeStatus; ethereum: UpgradeStatus }>({ solana: UNKNOWN, ethereum: UNKNOWN });
  readonly orders = new Observable<Order[]>([]);
  /** A wave is being opened for this order (a wallet prompt is up). */
  readonly orderBusy = new Observable<Record<string, string | null>>({});
  readonly vault: Vault;
  readonly engine: Engine;
  readonly guard: Guard;
  readonly sealed: SealedStore;
  readonly inbox: Inbox;
  readonly linkMemory: LinkMemory;

  private solanaClient: SolanaClient | null = null;
  private solanaClientFor = '';
  private ethereumClient: EthereumClient | null = null;
  private ethereumClientFor = '';
  private solPort: SolanaPort | null = null;
  private ethPort: EthereumPort | null = null;
  private unsub: (() => void)[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AppDeps) {
    this.settings = new Observable(loadSettings(deps.deployment));
    this.vault = new Vault(deps.kv, () => ({ programId: this.settings.get().programId, contract: this.settings.get().contract }));
    this.sealed = new SealedStore(deps.kv, () => (this.vault.hasSeed ? this.vault.requireSeed() : null));
    this.inbox = new Inbox(this.sealed);
    this.linkMemory = LinkMemory.from(local.get<string[]>('xmrswap.links', []));
    this.engine = new Engine({
      ports: () => this.ports(),
      monero: deps.monero ?? moneroPort(() => ({ nodes: this.settings.get().moneroNodes, ownNode: this.settings.get().ownNode, network: this.settings.get().moneroNetwork })),
      seed: () => (this.vault.hasSeed ? this.vault.requireSeed() : null),
      takers: () => this.takers(),
      network: () => this.settings.get().moneroNetwork,
      sweepMaxFee: () => (/^\d+$/.test(this.settings.get().sweepMaxFee) ? BigInt(this.settings.get().sweepMaxFee) : null),
      makerProof: (s) => this.makerProof(s),
    });
    this.guard = new Guard(deps.guardEnv);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Restore what a reload keeps (the tab's seed, orders) and start following the chain at once (SPEC 8.5 item 9). */
  async start(): Promise<void> {
    await this.vault.init();
    await this.loadOrders();
    this.unsub.push(this.engine.subscribe(() => this.onEngine()));
    this.unsub.push(
      this.vault.subscribe(() => {
        void this.loadOrders();
        void this.engine.poll();
      }),
    );
    this.engine.start(this.settings.get().pollMs);
    this.ticker = setInterval(() => this.guard.update(this.engine.getState(), this.safety()), 1000);
    void this.refreshRegistry();
    void this.refreshUpgrade();
  }

  stop(): void {
    this.engine.stop();
    if (this.ticker) clearInterval(this.ticker);
    for (const u of this.unsub) u();
    this.unsub = [];
    this.guard.dispose();
  }

  private onEngine(): void {
    this.guard.update(this.engine.getState(), this.safety());
    void this.runOrders();
  }

  safety(): Safety {
    return safetyOf(this.engine.getState(), this.vault.getState().backedUp);
  }

  // ------------------------------------------------------------------ settings, clients, ports

  setSettings(patch: Partial<Settings>): void {
    const next = { ...this.settings.get(), ...patch };
    saveSettings(next);
    this.settings.set(next);
    this.engine.start(next.pollMs);
    void this.refreshRegistry();
    void this.refreshUpgrade();
  }

  solana(): SolanaClient | null {
    const s = this.settings.get();
    if (!s.solanaRpc || !s.programId) return null;
    const key = `${s.solanaRpc}|${s.programId}`;
    if (this.solanaClientFor !== key) {
      // Polling only: it is also the catch-up path, and it works on endpoints without WebSocket.
      const transport = connectionTransport(new Connection(s.solanaRpc, 'confirmed'), { subscriptions: false });
      this.solanaClient = new SolanaClient({ transport, programId: s.programId, subscriptions: false });
      this.solanaClientFor = key;
      this.solPort = null;
      const made = this.solanaClient;
      // USDC instructions need the mint the program was initialised with.
      void made
        .getConfig()
        .then((c) => {
          if (c && this.solanaClient === made) {
            this.solanaClient = made.withUsdcMint(c.usdcMint);
            this.solPort = null;
          }
        })
        .catch(() => undefined);
    }
    return this.solanaClient;
  }

  ethereum(): EthereumClient | null {
    const s = this.settings.get();
    if (!s.ethereumRpc || !/^0x[0-9a-fA-F]{40}$/.test(s.contract)) return null;
    const key = `${s.ethereumRpc}|${s.contract}`;
    if (this.ethereumClientFor !== key) {
      this.ethereumClient = new EthereumClient({ transport: httpEthTransport(s.ethereumRpc), contract: s.contract as Address });
      this.ethereumClientFor = key;
      this.ethPort = null;
    }
    return this.ethereumClient;
  }

  solanaPort(): SolanaPort | null {
    const c = this.solana();
    if (!c) return null;
    if (!this.solPort || this.solPort.client !== c) this.solPort = new SolanaPort(c, () => this.wallets.get().solana, Math.min(1000, this.settings.get().pollMs));
    return this.solPort;
  }
  ethereumPort(): EthereumPort | null {
    const c = this.ethereum();
    if (!c) return null;
    this.ethPort ??= new EthereumPort(c, () => this.wallets.get().ethereum);
    return this.ethPort;
  }

  private ports(): Partial<Record<ChainName, ChainPort>> {
    if (this.deps.ports) return this.deps.ports();
    const out: Partial<Record<ChainName, ChainPort>> = {};
    const sol = this.solanaPort();
    const eth = this.ethereumPort();
    if (sol) out.solana = sol;
    if (eth) out.ethereum = eth;
    return out;
  }

  /** Addresses whose swaps to follow: the connected wallets and every wallet this recovery file has opened swaps with. */
  private takers(): Partial<Record<ChainName, string[]>> {
    const w = this.wallets.get();
    const known = this.vault.wallets();
    return {
      solana: [...new Set([...(w.solana ? [w.solana.address] : []), ...known.solana])],
      ethereum: [...new Set([...(w.ethereum ? [w.ethereum.address] : []), ...known.ethereum])],
    };
  }

  setWallet(chain: 'solana', w: SolanaWallet | null): void;
  setWallet(chain: 'ethereum', w: EthereumWallet | null): void;
  setWallet(chain: ChainName, w: SolanaWallet | EthereumWallet | null): void {
    const cur = this.wallets.get();
    if ((cur[chain]?.address ?? null) === (w?.address ?? null) && (cur[chain] === null) === (w === null)) {
      // Same account: keep the newest signer object without waking every subscriber.
      (cur as unknown as Record<string, unknown>)[chain] = w;
      return;
    }
    this.wallets.set({ ...cur, [chain]: w });
    void this.engine.poll();
  }

  // ------------------------------------------------------------------ registry and upgrade status

  async refreshRegistry(): Promise<void> {
    const sol = this.solana();
    if (!this.deps.readRegistry && !sol) {
      this.registry.set({ snapshot: null, loading: false, error: null, at: null });
      return;
    }
    this.registry.update((r) => ({ ...r, loading: true }));
    try {
      const snapshot = this.deps.readRegistry ? await this.deps.readRegistry() : await readRegistry(sol!, this.ethereum(), this.settings.get(), this.linkMemory);
      local.set('xmrswap.links', this.linkMemory.toJSON());
      this.registry.set({ snapshot, loading: false, error: null, at: Date.now() });
    } catch (e) {
      this.registry.update((r) => ({ ...r, loading: false, error: message(e) }));
    }
  }

  async refreshUpgrade(): Promise<void> {
    if (this.deps.upgrade) {
      this.upgrade.set(await this.deps.upgrade());
      return;
    }
    const sol = this.solana();
    const eth = this.ethereum();
    this.upgrade.set({ solana: sol ? await solanaUpgradeStatus(sol) : UNKNOWN, ethereum: eth ? await ethereumUpgradeStatus(eth) : UNKNOWN });
  }

  // ------------------------------------------------------------------ opening swaps

  /** The one gate every lock passes: the backup exists and the user ticked the confirmation (SPEC 8.5 items 1 and 2). */
  private assertMayLock(acknowledged: boolean): Uint8Array {
    if (!this.vault.getState().backedUp) throw new OpenRefused('Save your recovery file first. Without it a closed tab or a lost browser means your funds cannot be refunded or collected.');
    if (!acknowledged) throw new OpenRefused('Tick the box to confirm you will keep this tab open. If you close it before it says Safe to close you can lose your funds.');
    return this.vault.requireSeed();
  }

  private async openLegs(legs: { row: OfferRow; xmr: bigint }[], groups: number[][], slippageBps: number): Promise<OpenResult> {
    if (this.deps.openLegs) return this.deps.openLegs(legs, groups);
    const seed = this.vault.requireSeed();
    const w = this.wallets.get();
    if (legs.every((l) => l.row.chain === 'solana')) {
      const port = this.solanaPort();
      if (!port || !w.solana) throw new OpenRefused('Connect your Solana wallet to lock.');
      return openSolanaWave(port, w.solana.address, seed, legs, groups, slippageBps, (maker) => this.approvalFor(maker, w.solana!.address));
    }
    // Ethereum: one transaction per leg.
    const port = this.ethereumPort();
    if (!port || !w.ethereum) throw new OpenRefused('Connect your Ethereum wallet to lock.');
    const opened: (SwapView | null)[] = [];
    const errors: (string | null)[] = [];
    for (const leg of legs) {
      try {
        opened.push(await openEthereum(port, w.ethereum.address, seed, leg.row, leg.xmr, slippageBps, this.settings.get()));
        errors.push(null);
      } catch (e) {
        opened.push(null);
        errors.push(message(e));
      }
    }
    return { opened, errors };
  }

  /** Open one swap. `acknowledged` is the checkbox of the confirmation screen. Returns the swap's reference. */
  async openSwap(a: { row: OfferRow; xmr: bigint; destination: string; acknowledged: boolean; slippageBps?: number }): Promise<string> {
    this.assertMayLock(a.acknowledged);
    const r = await this.openLegs([{ row: a.row, xmr: a.xmr }], [[0]], a.slippageBps ?? 0);
    const view = r.opened[0];
    if (!view) throw new OpenRefused(r.errors[0] ?? 'The swap did not open. Nothing was locked.');
    this.adopt(view, { market: a.row.market, destination: a.destination });
    return swapRefOf(view);
  }

  private adopt(view: SwapView, note: SwapNote): void {
    this.vault.noteWallet(view.chain, view.taker);
    this.engine.adopt(view, note);
  }

  // ------------------------------------------------------------------ advance approvals (SPEC 3.8, 6.1)

  approvalFor(makerPda: string, taker: string): SignedSolApproval | undefined {
    const j = local.get<{ message: string; signature: string; operatorPub: string } | null>(approvalKey(makerPda, taker), null);
    return j ? { message: fromBase64(j.message), signature: fromBase64(j.signature), operatorPub: fromBase64(j.operatorPub) } : undefined;
  }

  /** Whether a stored advance approval would be accepted for this lock right now. */
  async approvalUsable(row: OfferRow, xmr: bigint): Promise<boolean> {
    const sol = this.solana();
    const w = this.wallets.get().solana;
    if (!sol || !w || !('offer' in row.source)) return false;
    const a = this.approvalFor(row.maker.pda, w.address);
    if (!a) return false;
    const cfg = await sol.getConfig();
    if (!cfg) return false;
    const bind = { clusterTag: cfg.clusterTag, programId: keyBytes(sol.programId), maker: keyBytes(row.maker.pda), taker: keyBytes(w.address), operator: keyBytes(row.maker.solana.operator) };
    return solApprovalProblem(a, bind, { asset: row.source.offer.asset, direction: row.direction, xmr, now: await sol.chainTime(), approvalEpoch: row.maker.solana.approvalEpoch }) === null;
  }

  /** Ask a maker for an advance approval. Over Tor the answer is immediate; on-chain it arrives later (`collectApproval`). */
  async requestApproval(maker: MakerProfile, note?: string): Promise<'granted' | 'refused' | 'sent'> {
    const sol = this.solana();
    const port = this.solanaPort();
    const w = this.wallets.get().solana;
    if (!sol || !port || !w) throw new Error('Connect your Solana wallet first: the approval is issued for its address.');
    const own = contactKeys(this.vault.requireSeed(), maker.pda);
    const request: Message = { t: 'approval_request', chain: 'solana', taker: w.address, reply_to: w.address, ...(note ? { note } : {}) };
    const http = makerHttp(maker, this.settings.get());
    const transports = [...(http ? [torMessageTransport(http)] : []), solanaMessageTransport((env) => port.sendWithWallet([sol.program.postMessage(w.address, maker.pda, env, null)]))];
    const sent = await sendWithFallback(transports, (t) => sealToMaker({ message: request, ownEncSecret: own.encSecret, maker: maker.solana, transport: t.kind }));
    if (!sent.reply) return 'sent';
    return (await this.acceptApproval(maker, sent.reply, w.address)) ? 'granted' : 'refused';
  }

  private async acceptApproval(maker: MakerProfile, envelope: Uint8Array, taker: string): Promise<boolean> {
    const sol = this.solana()!;
    const own = contactKeys(this.vault.requireSeed(), maker.pda);
    const now = await sol.chainTime();
    const m = openFromMaker({ envelope, ownEncSecret: own.encSecret, maker: maker.solana, operatorPub: keyBytes(maker.solana.operator), now }).message;
    if (m.t !== 'approval_response' || !('ok' in m) || !m.ok) return false;
    const cfg = await sol.getConfig();
    if (!cfg) return false;
    const a = solApprovalFromResponse(m as ApprovalResponseSolana, { clusterTag: cfg.clusterTag, programId: keyBytes(sol.programId), maker: keyBytes(maker.pda), taker: keyBytes(taker), operator: keyBytes(maker.solana.operator) });
    local.set(approvalKey(maker.pda, taker), { message: toBase64(a.message), signature: toBase64(a.signature), operatorPub: toBase64(a.operatorPub) });
    return true;
  }

  /** Look for an approval response that was posted on-chain to the taker's address. */
  async collectApproval(maker: MakerProfile): Promise<boolean> {
    const sol = this.solana();
    const w = this.wallets.get().solana;
    if (!sol || !w) return false;
    for (const msg of (await sol.listMessages(w.address)).reverse()) {
      try {
        if (await this.acceptApproval(maker, msg.payload, w.address)) return true;
      } catch {
        // Not for this key, or not from this maker.
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ inbox

  private replyKeys(maker: MakerProfile): ReplyKey[] {
    const keys: ReplyKey[] = [];
    if (this.vault.hasSeed) keys.push(contactKeys(this.vault.requireSeed(), maker.pda));
    for (const t of this.engine.getState().swaps) if (t.view && t.keys && t.view.maker === maker.pda) keys.push({ encSecret: t.keys.encSecret, encPub: t.keys.encPub, swapRef: t.view.swapRef, swap: t.ref });
    return keys;
  }

  async sendMessage(maker: MakerProfile, text: string, about?: Tracked, action?: 'release_deposit'): Promise<{ via: string; thread: Thread }> {
    const sol = this.solana();
    const port = this.solanaPort();
    const w = this.wallets.get().solana;
    return this.inbox.send({
      makerPda: maker.pda,
      maker: maker.solana,
      text,
      ...(w ? { replyTo: w.address } : {}),
      ...(action ? { action } : {}),
      ...(about?.view && about.keys ? { swap: { ref: about.ref, swapRef: about.view.swapRef, encSecret: about.keys.encSecret } } : {}),
      http: makerHttp(maker, this.settings.get()),
      postOnChain: sol && port && w ? (env) => port.sendWithWallet([sol.program.postMessage(w.address, maker.pda, env, about?.view && about.chain === 'solana' ? about.ref : null)]) : null,
      seed: this.vault.requireSeed(),
      now: sol ? await sol.chainTime() : 0n,
    });
  }

  async refreshThread(maker: MakerProfile): Promise<Thread> {
    const sol = this.solana();
    return this.inbox.refresh({ makerPda: maker.pda, maker: maker.solana, keys: this.replyKeys(maker), http: makerHttp(maker, this.settings.get()), solana: sol, taker: this.wallets.get().solana?.address ?? null, now: sol ? await sol.chainTime() : 0n });
  }

  private async makerProof(s: SwapView): Promise<boolean | undefined> {
    const maker = this.registry.get().snapshot?.makers.find((m) => m.ethereum?.address.toLowerCase() === s.maker.toLowerCase());
    return maker ? checkFundedShare(s, makerHttp(maker, this.settings.get())) : undefined;
  }

  // ------------------------------------------------------------------ large-swap orders

  private async loadOrders(): Promise<void> {
    if (!this.vault.hasSeed) return;
    const out: Order[] = [];
    for (const name of await this.sealed.names(ORDER_PREFIX)) {
      const o = await this.sealed.get<Order>(name);
      if (o) out.push(o);
    }
    this.orders.set(out.sort((a, b) => b.createdAt - a.createdAt));
  }

  private async saveOrder(o: Order): Promise<void> {
    this.orders.update((list) => [o, ...list.filter((x) => x.id !== o.id)].sort((a, b) => b.createdAt - a.createdAt));
    await this.sealed.put(ORDER_PREFIX + o.id, o);
  }

  order(id: string): Order | undefined {
    return this.orders.get().find((o) => o.id === id);
  }

  private legStateOf = (ref: string) => this.engine.get(ref)?.leg;

  /** Start an order: the user approved the plan and ticked the confirmation. Opens the first wave. */
  async startOrder(o: Order, wave: PlannedWave, acknowledged: boolean): Promise<void> {
    this.assertMayLock(acknowledged);
    await this.saveOrder(o);
    await this.openWave(o.id, wave);
  }

  async stopOrder(id: string): Promise<void> {
    const o = this.order(id);
    if (o) await this.saveOrder({ ...o, stopped: true });
  }

  /** Open one wave of an order: batched lock transactions, one wallet prompt each. */
  async openWave(id: string, wave: PlannedWave): Promise<void> {
    const o = this.order(id);
    const rows = this.registry.get().snapshot?.rows ?? [];
    if (!o || this.orderBusy.get()[id]) return;
    this.orderBusy.update((b) => ({ ...b, [id]: 'Approve the lock in your wallet' }));
    try {
      const legs = wave.legs.map((l) => ({ row: rows.find((r) => r.id === l.offerId)!, xmr: l.xmr }));
      if (legs.some((l) => !l.row)) throw new OpenRefused('An offer in this wave is gone. The plan was refreshed; nothing was locked.');
      const waveNo = o.legs.reduce((m, l) => Math.max(m, l.wave), 0) + 1;
      const r = await this.openLegs(legs, wave.transactions, 0);
      const added: OrderLeg[] = wave.legs.map((l, i) => ({ offerId: l.offerId, makerPda: l.makerId, xmr: l.xmr.toString(), pay: l.pay.toString(), price: l.price.toString(), depth: l.depth, wave: waveNo, ref: r.opened[i] ? swapRefOf(r.opened[i]!) : null, ...(r.errors[i] ? { error: r.errors[i]! } : {}) }));
      r.opened.forEach((v) => v && this.adopt(v, { market: o.market, destination: o.destination, orderId: o.id }));
      await this.saveOrder({ ...this.order(id)!, legs: [...this.order(id)!.legs, ...added] });
      this.orderBusy.update((b) => ({ ...b, [id]: null }));
    } catch (e) {
      this.orderBusy.update((b) => ({ ...b, [id]: null }));
      throw e;
    }
  }

  /** The wave that would open next for an order, against the current registry snapshot. */
  nextWaveOf(o: Order): PlannedWave | null {
    const rows = this.registry.get().snapshot?.rows ?? [];
    const now = this.engine.getState().clock[rows.find((r) => r.market === o.market)?.chain ?? 'solana']?.chain;
    return now === undefined ? null : nextWave(o, rows, this.legStateOf, now);
  }

  private orderPass = false;
  private lastRegistryForOrders = 0;
  /**
   * Keep orders moving: a maker whose leg ended in a refund is left out, and when legs settle the
   * remainder is re-planned and the next wave opened within the in-flight cap.
   */
  async runOrders(): Promise<void> {
    if (this.orderPass || !this.vault.hasSeed) return;
    this.orderPass = true;
    try {
      for (const o0 of this.orders.get()) {
        let o = o0;
        const stalled = stalledMakers(o, this.legStateOf).filter((m) => !o.excluded.includes(m));
        if (stalled.length > 0) {
          o = { ...o, excluded: [...o.excluded, ...stalled] };
          await this.saveOrder(o);
        }
        if (o.stopped || this.orderBusy.get()[o.id]) continue;
        const live = o.legs.filter((l) => l.ref !== null);
        const settledNow = live.filter((l) => legSettled(this.legStateOf(l.ref!) ?? 'locked')).length;
        // Only act on a change: a leg settled since the last wave was opened.
        const mark = `${settledNow}/${o.legs.length}/${o.excluded.length}`;
        if (local.get<string>(`xmrswap.ordermark.${o.id}`, '') === mark || live.length === 0) continue;
        if (Date.now() - this.lastRegistryForOrders > 5000) {
          this.lastRegistryForOrders = Date.now();
          await this.refreshRegistry();
        }
        const wave = this.nextWaveOf(o);
        local.set(`xmrswap.ordermark.${o.id}`, mark);
        if (!wave) continue;
        try {
          await this.openWave(o.id, wave);
        } catch {
          // The wallet refused or the offers moved: the board shows "Open next wave" for a manual retry.
        }
      }
    } finally {
      this.orderPass = false;
    }
  }
}

export type { EngineState, Market };
export { hex };
