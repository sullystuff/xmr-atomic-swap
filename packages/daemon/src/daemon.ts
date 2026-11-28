/**
 * The maker daemon: one always-on process that wires every module of SPEC 7.1 together, runs
 * restart recovery before quoting anything (SPEC 7.6), and then drives the loops.
 *
 * Every outside dependency (RPC transports, the inventory wallet, Monero nodes, price and venue
 * HTTP, the environment) is injectable, so the same class runs against svm-rpc, anvil and
 * regtest in the integration test and against in-memory fakes in the unit tests.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { coreVersion, init } from '@xmrswap/core-wasm';
import { CLOCK_SKEW_WARN_SECS, type ChainName, type Contact, DEV_PROGRAM_ID, ETH_NATIVE, type Market, PROGRAM_HASH, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import type { ChainConnection, ConfigLogEntry, ProgramBuildStatus, StatusResponse, TxResult } from '@xmrswap/protocol/daemon-api';
import { type HttpClient, fetchHttpClient } from '@xmrswap/rebalancer';
import { ContractError, type EthDeployment, type EthTransport, EthereumClient, type HttpFetch, type MoneroNode, ProgramError, SdkError, SolanaClient, type SolanaTransport, type SwapView, ata, connectionTransport, endedInClaim, solanaInstruction, unhex, watchDeployment } from '@xmrswap/sdk';
import { Alerts } from './alerts/index.js';
import { Approvals } from './approvals/index.js';
import { Caps } from './caps/index.js';
import { EthereumChain } from './chains/ethereum.js';
import { SolanaChain } from './chains/solana.js';
import { failover } from './chains/types.js';
import { type UpgradeStatus, ethereumUpgradeStatus, solanaUpgradeStatus } from './chains/upgrade.js';
import { type Config, type LoadResult, type ResolvedOffer, diffConfigs, loadConfig, poolSourceUsable } from './config/load.js';
import type { SourceName } from './config/schema.js';
import { Inventory } from './inventory/index.js';
import { Inbox } from './inbox/index.js';
import { Keystore, apiToken } from './keystore/index.js';
import { MoneroNodes, type MoneroView } from './monero/nodes.js';
import { type InventoryWallet, type MoneroBroadcaster, WalletRpc, nodeBroadcaster } from './monero/wallet.js';
import { OfferEngine } from './offers/engine.js';
import { PriceEngine } from './pricing/engine.js';
import { type PriceHttp, type PriceSourceClient, coingecko, coinmarketcap, fetchPriceHttp, wxmrPool } from './pricing/sources.js';
import { Rebalance } from './rebalance/index.js';
import { Registration } from './registration/index.js';
import { Risk } from './risk/index.js';
import { EncKeys, Rotation } from './rotation/index.js';
import { Store } from './store/db.js';
import { type CrashHook, Journal } from './store/journal.js';
import { Executor } from './swaps/executor.js';
import { Shares } from './swaps/shares.js';
import { ETH_SWAP_GAS_MAX, swapCosts } from './stats/costs.js';
import { MakerWatcher } from './watcher/index.js';
import { readOnionHostname } from './tor/index.js';
import { Emitter, decimalToUnits, errMsg, picoToXmr } from './util.js';

export const DAEMON_VERSION = '0.1.0';

export interface DaemonOptions {
  /** The configuration file. */
  configPath: string;
  /** Environment reader; defaults to `process.env`. API keys and endpoints are named by variable only. */
  env?: (name: string) => string | undefined;
  /** Injected in tests; otherwise opened (or created) in the data directory with the passphrase from the environment. */
  keystore?: Keystore;
  dataDir?: string;
  solanaTransport?: SolanaTransport;
  /** A raw connection for block height and the bridge adapter's reads. */
  connection?: Connection;
  ethTransport?: EthTransport;
  wallet?: InventoryWallet;
  moneroNodes?: (string | MoneroNode)[];
  monero?: MoneroView;
  broadcaster?: MoneroBroadcaster;
  priceHttp?: PriceHttp;
  priceSources?: Partial<Record<SourceName, PriceSourceClient>>;
  venueHttp?: HttpClient;
  /** The bridge adapter's chain reads (tests); defaults to the Solana connection. */
  bridgeRpc?: import('@xmrswap/rebalancer').SolanaRpc;
  crash?: CrashHook;
  /** Current Solana block height (to tell an expired blockhash from a slow transaction); defaults to the connection's. */
  solanaBlockHeight?: () => Promise<number>;
  /** `false`: nothing runs on a timer; the caller drives `tickOnce` (tests). */
  timers?: boolean;
  /** Loop periods in milliseconds. */
  swapPollMs?: number;
  offerPollMs?: number;
  /** Local clock, Unix seconds (scheduling only; every deadline uses chain time). */
  now?: () => number;
  /** The private key of encryption-key version 1, when the maker was registered with a key generated elsewhere (tests, migration). */
  initialEncSecret?: Uint8Array;
  /** Sweep fee cap override (piconero). */
  sweepMaxFee?: bigint;
  /** HTTP to the maker's watcher (`[watcher] url`); tests inject a fake service. */
  watcherFetch?: HttpFetch;
}

/** A configuration the daemon refused. `issues` places every error on its key. */
export class ConfigRejected extends Error {
  constructor(
    readonly code: 'invalid_toml' | 'invalid_config' | 'revision_conflict',
    readonly result: LoadResult | null,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigRejected';
  }
}

export class Daemon {
  readonly events = new Emitter<{ config: Config; status: null }>();
  readonly startedAt: number;
  load!: LoadResult;
  config!: Config;
  store!: Store;
  keystore!: Keystore;
  journal!: Journal;
  alerts!: Alerts;
  shares!: Shares;
  encKeys!: EncKeys;
  risk!: Risk;
  prices!: PriceEngine;
  inventory!: Inventory;
  approvals!: Approvals;
  executor!: Executor;
  offers!: OfferEngine;
  rotation!: Rotation;
  inbox!: Inbox;
  registration!: Registration;
  rebalance!: Rebalance;
  caps!: Caps;
  watcher!: MakerWatcher;
  monero!: MoneroView;
  wallet!: InventoryWallet;
  sol: SolanaChain | null = null;
  eth: (EthereumChain & { deployment: EthDeployment }) | null = null;
  dataDir!: string;
  token!: string;
  /** Last error per chain connection, for the status page. */
  private chainErrors = new Map<ChainName, string>();
  private solGenesis: string | null = null;
  private ethChainId: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private busy = new Set<string>();
  private priceSources: Partial<Record<SourceName, PriceSourceClient>> = {};
  private moneroStatus: { nodes: StatusResponse['monero']['nodes']; agree: boolean } = { nodes: [], agree: false };
  private walletOk = false;
  private stopped = false;
  /** The Solana connection the bridge adapter reads through (the first configured endpoint). */
  private connection: Connection | null = null;
  /** Upgrade status per chain, read from chain state and refreshed periodically. */
  readonly upgrade = new Map<ChainName, UpgradeStatus>();

  private constructor(private readonly o: DaemonOptions) {
    this.startedAt = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  env = (name: string): string | undefined => (this.o.env ?? ((n: string) => process.env[n]))(name);
  private now(): number {
    return (this.o.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  get live(): boolean {
    return this.config.raw.daemon.mode === 'live';
  }
  get configPath(): string {
    return this.o.configPath;
  }

  // ---------------------------------------------------------------- construction

  static async create(o: DaemonOptions): Promise<Daemon> {
    await init();
    const d = new Daemon(o);
    await d.build();
    return d;
  }

  private async build(): Promise<void> {
    const toml = readFileSync(this.o.configPath, 'utf8');
    const load = loadConfig(toml);
    if (!load.config) throw new ConfigRejected('invalid_config', load, `the configuration has errors: ${load.validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.load = load;
    this.config = load.config;
    const raw = this.config.raw;
    this.dataDir = this.o.dataDir ?? path.resolve(path.dirname(this.o.configPath), raw.daemon.data_dir);
    mkdirSync(this.dataDir, { recursive: true });

    // 1. Keystore and database (SPEC 7.6 step 1).
    if (this.o.keystore) this.keystore = this.o.keystore;
    else {
      const pass = this.env(raw.daemon.keystore_passphrase_env);
      if (!pass) throw new Error(`the keystore passphrase is not set: export ${raw.daemon.keystore_passphrase_env}`);
      this.keystore = Keystore.openOrCreate(this.dataDir, pass);
    }
    this.token = apiToken(this.dataDir);
    this.store = new Store(path.join(this.dataDir, 'daemon.sqlite'));
    if (this.o.now) this.store.now = this.o.now;
    if (this.store.meta('first_start') === null) this.store.setMeta('first_start', String(this.now()));
    this.journal = new Journal(this.store, this.o.crash);
    this.alerts = new Alerts(this.store, { url: () => (this.config.raw.alerts.webhook_url_env ? this.env(this.config.raw.alerts.webhook_url_env) : undefined) });
    this.shares = new Shares(this.store, this.keystore);
    this.encKeys = new EncKeys(this.store, this.keystore);
    this.encKeys.ensure(1, ...(this.o.initialEncSecret ? [this.o.initialEncSecret] : []));
    this.risk = new Risk(this.store, () => this.config);

    // 2. Chains, Monero, wallet.
    await this.connectSolana().catch((e) => this.chainErrors.set('solana', errMsg(e)));
    await this.connectEthereum().catch((e) => this.chainErrors.set('ethereum', errMsg(e)));
    const nodeUrls = raw.monero.node_url_envs.map((n) => this.env(n)).filter((u): u is string => !!u);
    const nodes = this.o.moneroNodes ?? nodeUrls;
    this.monero = this.o.monero ?? new MoneroNodes(nodes, raw.monero.network, { ownNode: raw.monero.own_node, labels: raw.monero.node_url_envs });
    if (this.monero instanceof MoneroNodes) this.monero.onReorg = () => (this.risk.reorgSeenAt = this.now());
    const broadcaster = this.o.broadcaster ?? nodeBroadcaster(nodeUrls);
    const walletUrl = this.env(raw.monero.wallet_rpc_url_env);
    const user = raw.monero.wallet_rpc_user_env ? this.env(raw.monero.wallet_rpc_user_env) : undefined;
    const password = raw.monero.wallet_rpc_password_env ? this.env(raw.monero.wallet_rpc_password_env) : undefined;
    this.wallet = this.o.wallet ?? new WalletRpc(walletUrl ?? 'http://127.0.0.1:1', { ...(user ? { user } : {}), ...(password ? { password } : {}) });
    this.inventory = new Inventory({
      store: this.store, wallet: this.wallet, broadcaster, journal: this.journal, ladder: () => this.config.ladder, headroomPct: () => this.config.raw.liquidity.ladder_headroom_pct, reserveXmr: () => this.config.reserveXmr,
      ...(this.o.sweepMaxFee !== undefined ? { feeReserve: () => this.o.sweepMaxFee! } : {}),
    });

    // The database is bound to the maker and the inventory wallet at first start and refuses others (SPEC 7.3).
    let walletAddress: string | null = null;
    try {
      walletAddress = await this.inventory.address();
      this.walletOk = true;
    } catch (e) {
      if (this.live && this.config.offers.some((x) => x.enabled)) this.alerts.raise('critical', 'wallet_unreachable', `the inventory wallet cannot be reached: ${errMsg(e)}`);
    }
    this.store.bind({ solanaMaker: this.sol?.makerPda ?? null, ethereumMaker: this.eth?.makerAddress ?? null, wallet: walletAddress });

    // 3. Modules.
    this.buildPriceSources();
    this.prices = new PriceEngine(this.priceSources, this.store, () => this.config.raw, () => this.now());
    // The engine reads the sources through this object, so a hot-applied configuration swaps them in place.
    this.approvals = new Approvals({
      store: this.store, keystore: this.keystore, risk: this.risk, shares: this.shares, encKeys: this.encKeys, config: () => this.config,
      xmrAvailable: (xmr, exclude) => this.xmrAvailable(xmr, exclude),
      payingAvailable: (market, exclude) => this.payingAvailable(market, exclude),
      solana: async () => {
        if (!this.sol) return null;
        const [cfg, maker, now] = await Promise.all([this.sol.client.getConfig('finalized'), this.sol.maker(true), this.sol.now()]);
        return cfg ? { clusterTag: cfg.clusterTag, programId: base58Decode(this.sol.client.programId), makerPda: base58Decode(this.sol.makerPda), approvalEpoch: maker.approvalEpoch, now } : null;
      },
      ethereum: async () => {
        if (!this.eth) return null;
        const [maker, usdc, now] = await Promise.all([this.eth.maker(), this.eth.client.usdc(this.eth.tag), this.eth.client.chainTime('latest')]);
        return { deployment: this.eth.deployment, maker: unhex(this.eth.makerAddress), usdc: unhex(usdc), approvalEpoch: maker.approvalEpoch, now };
      },
    });
    this.caps = new Caps({ solana: () => this.sol, ethereum: () => this.eth, ethereumFrozen: () => this.upgrade.get('ethereum')?.status === 'immutable' });
    this.watcher = new MakerWatcher({
      store: this.store, journal: this.journal, alerts: this.alerts, config: () => this.config,
      deployment: (chain) => (chain === 'solana' ? (this.sol ? watchDeployment({ programId: this.sol.client.programId }) : null) : this.eth ? watchDeployment({ chainId: this.eth.deployment.chainId, contract: this.eth.deployment.contract }) : null),
      ...(this.o.watcherFetch ? { fetch: this.o.watcherFetch } : {}) });
    this.executor = new Executor({
      store: this.store, journal: this.journal, alerts: this.alerts, chains: { ...(this.sol ? { solana: this.sol } : {}), ...(this.eth ? { ethereum: this.eth } : {}) }, inventory: this.inventory, monero: this.monero, broadcaster,
      shares: this.shares, encKeys: this.encKeys, approvals: this.approvals, watcher: this.watcher, config: () => this.config, paused: () => this.risk.paused, xmrUsd: () => this.prices.usd('xmr'),
      sweepMaxFee: () => this.o.sweepMaxFee ?? (this.config.raw.monero.sweep_max_fee !== undefined ? BigInt(this.config.raw.monero.sweep_max_fee) : undefined),
    });
    this.offers = new OfferEngine({
      store: this.store, journal: this.journal, alerts: this.alerts, keystore: this.keystore, shares: this.shares, prices: this.prices, risk: this.risk, caps: this.caps, config: () => this.config,
      capacity: () => this.inventory.capacity(), inventoryXmr: () => picoToXmr(this.inventory.capacity().total), payingAvailable: (market) => this.payingAvailable(market), solana: () => this.sol, ethereum: () => this.eth,
    });
    this.rotation = new Rotation({ store: this.store, keys: this.encKeys, journal: this.journal, solana: () => this.sol, intervalHours: () => this.config.raw.rotation.interval_hours, graceHours: () => this.config.raw.rotation.grace_hours, dryRun: () => !this.live });
    this.inbox = new Inbox({
      store: this.store, keystore: this.keystore, encKeys: this.encKeys, journal: this.journal, approvals: this.approvals, offers: this.offers, policy: () => this.config.raw.inbox.policy, solana: () => this.sol, ethereum: () => this.eth, live: () => this.live,
      makerState: async () => {
        if (this.sol) {
          const m = await this.sol.client.getMaker(this.sol.makerPda, 'finalized');
          if (m) return { maker: m, now: await this.sol.now() };
        }
        // Not registered on Solana (yet): the newest key this daemon holds is the only version.
        const cur = this.encKeys.current()!;
        return { maker: { encKey: cur.publicKey, encKeyVersion: cur.version, prevEncKey: new Uint8Array(32), prevEncKeyExpiresAt: 0n }, now: BigInt(this.now()) };
      },
    });
    this.registration = new Registration({
      solana: () => this.sol, ethereum: () => this.eth, solanaOwner: () => this.config.raw.solana.maker_owner ?? null, ethereumOwner: () => this.config.raw.ethereum.maker_owner ?? null, ethereumChainId: () => this.config.raw.ethereum.chain_id ?? null,
      encKeys: this.encKeys, journal: this.journal, live: () => this.live, desired: () => this.desiredPublished(),
    });
    this.rebalance = new Rebalance({
      store: this.store, journal: this.journal, alerts: this.alerts, keystore: this.keystore, inventory: this.inventory, wallet: this.wallet, settings: () => this.config.rebalance, usd: (asset) => this.prices.usd(asset),
      solana: () => this.sol, ethereum: () => this.eth, connection: () => this.connection, ...(this.o.bridgeRpc ? { bridgeRpc: this.o.bridgeRpc } : {}), http: this.o.venueHttp ?? fetchHttpClient(), env: this.env, live: () => this.live,
      payouts: async () => {
        const sol = this.sol ? (await this.sol.maker().catch(() => null))?.payout : undefined;
        const eth: string | undefined = this.eth ? (await this.eth.maker().catch(() => null))?.payout : undefined;
        return { sol: sol ? [sol] : [], eth: eth ? [eth] : [] };
      },
    });
  }

  /**
   * The sources the configuration actually uses, and nothing else: a maker who quotes off the wXMR pool alone never
   * calls CoinGecko or CoinMarketCap.
   */
  private buildPriceSources(): void {
    const raw = this.config.raw;
    const used = new Set<SourceName>();
    for (const o of this.config.offers) {
      if (!o.configured) continue;
      for (const s of [o.source, ...o.fallbacks, ...(o.crossCheck ? [o.crossCheck] : [])]) used.add(s);
    }
    const next: Partial<Record<SourceName, PriceSourceClient>> = {};
    if (this.o.priceSources) Object.assign(next, this.o.priceSources);
    else {
      const http = this.o.priceHttp ?? fetchPriceHttp();
      const keyed = (name: 'coingecko' | 'coinmarketcap') => {
        const c = raw.pricing.sources[name];
        return { http, env: this.env, ...(c.api_key_env ? { apiKeyEnv: c.api_key_env } : {}), ...(c.base_url ? { baseUrl: c.base_url } : {}) };
      };
      if (used.has('coingecko')) next.coingecko = coingecko(keyed('coingecko'));
      if (used.has('coinmarketcap')) next.coinmarketcap = coinmarketcap(keyed('coinmarketcap'));
    }
    // Pools are read from chain state through the daemon's own Solana endpoint, whoever else is injected.
    const sol = this.sol;
    const vol = raw.guardrails.volatility_pause || null;
    for (const name of ['wxmr_pool', 'wxmr_pool_sol'] as const) {
      const pool = raw.pricing.sources[name];
      if (next[name] || !used.has(name) || !pool || !poolSourceUsable(raw, name) || !sol) continue;
      next[name] = wxmrPool({
        name,
        read: async (account) => {
          const a = await sol.client.transport.getAccount(account);
          return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : null;
        },
        baseVault: pool.base_vault!, quoteVault: pool.quote_vault!, quote: pool.quote, minLiquidityUsd: pool.min_liquidity_usd, averageSeconds: pool.average_seconds, maxJumpPct: vol ? vol.move_pct : null, now: () => this.now(),
      });
    }
    // A pool keeps its samples across a configuration change that does not touch it (its averaging window must not restart).
    for (const k of Object.keys(this.priceSources) as SourceName[]) {
      const keep = (k === 'wxmr_pool' || k === 'wxmr_pool_sol') && next[k] && this.poolFingerprint.get(k) === JSON.stringify([raw.pricing.sources[k], vol]);
      if (keep) next[k] = this.priceSources[k]!;
      delete this.priceSources[k];
    }
    for (const k of ['wxmr_pool', 'wxmr_pool_sol'] as const) this.poolFingerprint.set(k, JSON.stringify([raw.pricing.sources[k], vol]));
    Object.assign(this.priceSources, next);
  }
  private poolFingerprint = new Map<string, string>();

  private async connectSolana(): Promise<void> {
    const c = this.config.raw.solana;
    const urls = [c.rpc_url_env, ...c.fallback_rpc_url_envs].map((n) => this.env(n)).filter((u): u is string => !!u);
    if (!this.o.solanaTransport && urls.length === 0) return;
    if (!c.maker_owner) throw new Error('solana.maker_owner is not set: the daemon does not know which maker it is');
    const subscriptions = c.subscriptions && !this.o.solanaTransport;
    const connections = urls.map((u) => new Connection(u, 'finalized'));
    const transports = this.o.solanaTransport ? [this.o.solanaTransport] : connections.map((conn) => connectionTransport(conn, { subscriptions }));
    const isAnswer = (e: unknown) => e instanceof ProgramError || e instanceof SdkError;
    // Verify each endpoint's genesis hash before trusting it; one that fails is dropped.
    const usable: SolanaTransport[] = [];
    for (const t of transports) {
      try {
        const g = await t.getGenesisHash();
        if (c.expected_genesis && g !== c.expected_genesis) throw new Error(`genesis hash ${g} is not the expected ${c.expected_genesis}`);
        this.solGenesis = g;
        usable.push(t);
      } catch (e) {
        this.chainErrors.set('solana', errMsg(e));
      }
    }
    if (usable.length === 0) throw new Error(this.chainErrors.get('solana') ?? 'no usable Solana endpoint');
    const transport = usable.length === 1 ? usable[0]! : failover(usable, isAnswer, (_i, e) => this.alerts.raise('warning', 'rpc_failover', `Solana endpoint failed (${errMsg(e)}); switched to the next one`));
    let client = new SolanaClient({ transport, programId: c.program_id ?? DEV_PROGRAM_ID, subscriptions, priorityFee: c.priority_fee_microlamports, ...(c.max_priority_fee_microlamports !== undefined ? { maxPriorityFee: c.max_priority_fee_microlamports } : {}) });
    const config = await client.getConfig('finalized');
    if (config) client = client.withUsdcMint(config.usdcMint);
    const conn = this.o.connection ?? connections[0];
    this.connection = conn ?? null;
    this.sol = new SolanaChain({ client, operator: this.keystore.solana, makerPda: client.program.makerPda(c.maker_owner).toBase58(), ...(this.o.solanaBlockHeight ? { blockHeight: this.o.solanaBlockHeight } : conn ? { blockHeight: () => conn.getBlockHeight('finalized') } : {}) });
    this.chainErrors.delete('solana');
  }

  private async connectEthereum(): Promise<void> {
    const c = this.config.raw.ethereum;
    const urls = [c.rpc_url_env, ...c.fallback_rpc_url_envs].map((n) => this.env(n)).filter((u): u is string => !!u);
    if (!this.o.ethTransport && urls.length === 0) return;
    if (!c.contract || !c.maker_owner || !c.chain_id) throw new Error('ethereum.contract, chain_id and maker_owner are needed');
    const rpc = (url: string): EthTransport => ({
      request: async ({ method, params }) => {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }), signal: AbortSignal.timeout(30_000) });
        const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        // A JSON-RPC error is the endpoint's answer (a revert, a refusal), not a transport failure.
        if (body.error) throw Object.assign(new SdkError('RpcError', body.error.message), { data: body.error.data, rpcCode: body.error.code });
        return body.result;
      },
    });
    const transports = this.o.ethTransport ? [this.o.ethTransport] : urls.map(rpc);
    const isAnswer = (e: unknown) => e instanceof ContractError || e instanceof SdkError;
    const transport = transports.length === 1 ? transports[0]! : failover(transports, isAnswer, (_i, e) => this.alerts.raise('warning', 'rpc_failover', `Ethereum endpoint failed (${errMsg(e)}); switched to the next one`));
    const privateUrl = c.private_tx_url_env ? this.env(c.private_tx_url_env) : undefined;
    // The chain id is pinned twice over: by the option (the client signs for no other) and by the check against the endpoint below.
    const client = new EthereumClient({ transport, chainId: c.chain_id, contract: c.contract.toLowerCase() as `0x${string}`, ...(privateUrl ? { privateTransport: rpc(privateUrl) } : {}), ...(c.max_fee_gwei ? { maxFeePerGas: BigInt(Math.round(c.max_fee_gwei * 1e9)) } : {}) });
    await client.verifyChainId(c.chain_id);
    this.ethChainId = String(c.chain_id);
    const chain = new EthereumChain({
      client, operator: this.keystore.ethSigner, maker: c.maker_owner.toLowerCase() as `0x${string}`, finality: c.finality,
      cursor: { get: () => BigInt(this.store.meta('eth_cursor') ?? String(c.from_block)), set: (n) => this.store.setMeta('eth_cursor', n.toString()) },
    });
    this.eth = Object.assign(chain, { deployment: { chainId: BigInt(c.chain_id), contract: c.contract.toLowerCase() as `0x${string}` } });
    this.chainErrors.delete('ethereum');
  }

  // ---------------------------------------------------------------- shared helpers

  private offerOfRow(market: string, direction: 0 | 1): ResolvedOffer | undefined {
    return this.config.offers.find((o) => o.market === market && o.directionCode === direction);
  }

  /** The operator's balance of a market's paying asset in base units, or `null` when the chain is not connected. */
  async payingBalance(market: Market): Promise<bigint | null> {
    if (market === 'sol' || market === 'usdc_sol') {
      if (!this.sol) return null;
      if (market === 'sol') return (await this.sol.client.transport.getAccount(this.sol.operator))?.lamports ?? 0n;
      const mint = this.sol.client.program.usdcMint;
      if (!mint) return null;
      const a = await this.sol.client.transport.getAccount(ata(this.sol.operator, mint).toBase58());
      return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
    }
    if (!this.eth) return null;
    const token = market === 'eth' ? ETH_NATIVE : await this.eth.client.usdc(this.eth.tag);
    return this.eth.balanceOf(token as `0x${string}`, this.eth.operator as `0x${string}`);
  }
  /** What open direction-B swaps of a market hold in escrow. */
  escrowed(market: Market, exclude?: string): bigint {
    // Funded swaps, and pending takes already approved (their funding may be in flight): both hold a share of the cap.
    const holds = (s: { state: number }) => ([SWAP_STATE.ACTIVE, SWAP_STATE.NOTICED, SWAP_STATE.READY, SWAP_STATE.FROZEN, SWAP_STATE.ABORTED_FREE, SWAP_STATE.ABORTED_HOLD] as number[]).includes(s.state);
    return this.store.swaps({ open: true }).filter((s) => s.market === market && s.direction === 1 && s.ref !== exclude && (holds(s) || (s.state === SWAP_STATE.PENDING && Risk.approved(s)))).reduce((a, s) => a + BigInt(s.amount), 0n);
  }
  payingCap(market: Market): bigint | null {
    const cap = this.config.raw.liquidity.paying_caps[market];
    const decimals = { sol: 9, usdc_sol: 6, eth: 18, usdc_eth: 6 }[market];
    return cap === undefined ? null : decimalToUnits(cap, decimals);
  }
  /** What can still be committed to buy-XMR swaps of a market: the balance, and the cap less what is already escrowed. */
  async payingAvailable(market: Market, exclude?: string): Promise<bigint | null> {
    const balance = await this.payingBalance(market);
    if (balance === null) return null;
    const cap = this.payingCap(market);
    if (cap === null) return balance;
    const left = cap - this.escrowed(market, exclude);
    return left < balance ? (left > 0n ? left : 0n) : balance;
  }

  /**
   * The largest lock an unlocked output can still fund for a new approval: outputs already spoken for by direction-A
   * swaps that were approved (or are active) but have no lock built yet are set aside first, one each.
   */
  xmrAvailable(xmr: bigint, exclude?: string): bigint {
    const waiting = this.store.swaps({ open: true }).filter((s) => s.direction === 0 && s.ref !== exclude && !this.store.lockTx(s.ref) && (s.state === SWAP_STATE.ACTIVE || (s.state === SWAP_STATE.PENDING && Risk.approved(s))));
    const free = this.inventory.usableAmounts();
    for (const w of waiting.sort((a, b) => (BigInt(a.xmr) > BigInt(b.xmr) ? -1 : 1))) {
      const i = free.findIndex((a) => a >= BigInt(w.xmr));
      if (i >= 0) free.splice(i, 1);
    }
    const fits = free.filter((a) => a >= xmr);
    return fits.length ? fits[fits.length - 1]! : 0n;
  }

  /** What the Solana record should publish: console edits (stored) take precedence over the file. */
  desiredPublished(): { onion: string | null; contacts: Contact[]; inboxPolicy: 'open' | 'swap_only' } {
    const t = this.config.raw.tor;
    const storedContacts = this.store.kv('published:contacts');
    const storedOnion = this.store.kv('published:onion');
    const fromTor = t.enabled && t.publish ? readOnionHostname(t.hostname_file) : null;
    return {
      onion: storedOnion !== undefined ? (JSON.parse(storedOnion) as string | null) : fromTor,
      contacts: storedContacts !== undefined ? (JSON.parse(storedContacts) as Contact[]) : this.config.raw.registration.contacts.map((c) => ({ kind: c.kind, value: c.value })),
      inboxPolicy: this.config.raw.inbox.policy,
    };
  }

  // ---------------------------------------------------------------- configuration: validate, hot apply, change log

  /** Validate and apply a configuration without a restart. Everything reads the configuration through `this.config`. */
  applyConfig(toml: string, source: ConfigLogEntry['source'], baseRevision?: string): LoadResult {
    if (baseRevision !== undefined && baseRevision !== this.load.revision) throw new ConfigRejected('revision_conflict', null, 'the configuration changed since it was loaded; reload, then apply the edit again');
    const next = loadConfig(toml);
    if (!next.config) {
      const first = next.validation.errors[0];
      const syntax = next.validation.errors.length === 1 && first!.path === '' && first!.message.startsWith('not valid TOML');
      throw new ConfigRejected(syntax ? 'invalid_toml' : 'invalid_config', next, first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'the configuration has errors');
    }
    const changes = diffConfigs(this.load.parsed, next.parsed);
    if (source !== 'file' && toml !== this.load.toml) {
      const tmp = `${this.o.configPath}.tmp`;
      writeFileSync(tmp, toml, { mode: 0o600 });
      renameSync(tmp, this.o.configPath);
    }
    this.load = next;
    this.config = next.config;
    if (changes.length > 0) this.store.logConfig(next.revision, source, changes);
    this.buildPriceSources();
    const restart = changes.filter((c) => /^(solana|ethereum|monero|daemon)\./.test(c.path) && !/^(solana\.priority_fee|daemon\.mode|daemon\.cors|ethereum\.finality$)/.test(c.path));
    if (restart.length > 0) this.alerts.raise('warning', 'restart_needed', `endpoint and key settings take effect at the next start: ${restart.map((c) => c.path).join(', ')}`);
    this.events.emit('config', this.config);
    return next;
  }

  private watchConfig(): void {
    watchFile(this.o.configPath, { interval: 2_000 }, () => {
      let toml: string;
      try {
        toml = readFileSync(this.o.configPath, 'utf8');
      } catch {
        return;
      }
      if (toml === this.load.toml) return;
      try {
        this.applyConfig(toml, 'file');
      } catch (e) {
        this.alerts.raise('warning', 'config_rejected', `the edited configuration file was not applied: ${errMsg(e)}`);
      }
    });
  }

  // ---------------------------------------------------------------- start: recovery first, then the loops

  /** Restart recovery (SPEC 7.6), in order, before quoting anything. */
  async recover(): Promise<void> {
    await this.resolveLooseIntents(true);
    if (this.walletOk) await this.inventory.sync().catch((e) => this.alerts.raise('warning', 'inventory_sync_failed', errMsg(e)));
    await this.rotation.reconcile().catch(() => undefined);
    // Every non-terminal swap: the chain wins for state, the database for secrets, raw transactions and intents;
    // deadlines are recomputed from on-chain timestamps by the flow on every step. New swaps are adopted by the scan.
    await this.executor.tick();
  }

  /**
   * Intents that belong to no swap (offer refreshes, rotations, registry updates, messages, splits, venue transfers):
   * each is looked up, never assumed. `afterRestart`: what a crash left unfinished is failed (nothing was signed) or,
   * for a transfer to a third party, parked for the maker and never re-sent.
   */
  async resolveLooseIntents(afterRestart: boolean): Promise<void> {
    for (const i of this.store.intents({ status: ['planned', 'sent'] })) {
      if (i.swap_ref) continue;
      if (i.kind === 'venue_transfer' || i.kind === 'xmr_send') {
        if (!afterRestart) continue; // its own sender is still waiting for the confirmation
        this.journal.resolve(i, 'needs_review', 'interrupted; check the venue and the wallet before acknowledging');
        this.alerts.raise('critical', 'transfer_needs_review', `a ${i.kind} was interrupted by a restart and is parked for review; it is not re-sent`);
        continue;
      }
      if (i.status === 'planned') {
        if (afterRestart) this.journal.resolve(i, 'failed', 'interrupted before completion');
        continue;
      }
      const chain = i.kind === 'sol_tx' ? this.sol : i.kind === 'eth_tx' ? this.eth : null;
      if (!chain || !i.tx) continue;
      const s = await chain.status(i.tx, i.meta).catch(() => null);
      if (s?.state === 'confirmed') this.journal.resolve(i, 'confirmed');
      else if (s?.state === 'failed' || s?.state === 'dead') {
        this.journal.resolve(i, 'failed', s.state === 'failed' ? 'the transaction failed on-chain' : 'did not land');
        this.alerts.raise('warning', 'tx_failed', `${String(i.payload['call'] ?? i.kind)} (${i.tx}) ${s.state === 'failed' ? 'failed on-chain' : 'did not land'}`);
      } else if (afterRestart) {
        this.journal.resolve(i, 'needs_review', 'sent before a restart; neither confirmed nor dead');
        this.alerts.raise('warning', 'tx_needs_review', `transaction ${i.tx} (${String(i.payload['call'] ?? i.kind)}) was sent before a restart and is neither confirmed nor dead; it is not re-sent`);
      }
    }
  }

  async start(): Promise<void> {
    await this.recover();
    // Only now resume quoting. A stopped daemon's offers lapsed by themselves through `valid_secs`.
    await this.offers.tick(true).catch((e) => this.alerts.raise('warning', 'offer_refresh_failed', errMsg(e)));
    if (this.o.timers === false) return;
    this.watchConfig();
    const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => {
        if (this.busy.has(name) || this.stopped) return;
        this.busy.add(name);
        void fn()
          .catch((e) => this.alerts.raise('warning', `${name}_failed`, errMsg(e)))
          .finally(() => this.busy.delete(name));
      }, ms);
      this.timers.push(t);
    };
    every('swaps', this.o.swapPollMs ?? 3_000, () => this.executor.tick());
    every('offers', this.o.offerPollMs ?? 1_000, () => this.offers.tick());
    every('inventory', 30_000, () => this.maintainInventory());
    every('inbox', 5_000, async () => {
      await this.inbox.pollSolana();
      await this.inbox.pollEthereum();
    });
    every('housekeeping', 60_000, () => this.housekeeping());
  }

  /** One pass of every loop, in the order the timers would run them (tests and the integration harness drive this). */
  async tickOnce(): Promise<void> {
    await this.executor.tick();
    await this.offers.tick();
  }

  async maintainInventory(): Promise<void> {
    if (!this.walletOk) {
      await this.inventory.address();
      this.walletOk = true;
    }
    await this.inventory.sync();
    // Re-split change and recovered outputs back to the ladder (never in dry run: it moves XMR).
    if (this.live && this.config.ladder.length > 0) await this.inventory.split();
  }

  async housekeeping(): Promise<void> {
    this.store.beat();
    await this.resolveLooseIntents(false).catch(() => undefined);
    await this.refreshUpgrade().catch(() => undefined);
    this.moneroStatus = await this.monero.status().catch(() => ({ nodes: [], agree: false }));
    await this.rotation.tick().catch((e) => this.alerts.raise('warning', 'rotation_failed', errMsg(e)));
    await this.registration.syncPublished().catch((e) => this.alerts.raise('warning', 'registry_sync_failed', errMsg(e)));
    await this.rebalance.tick().catch((e) => this.alerts.raise('warning', 'rebalance_failed', errMsg(e)));
    await this.watcher.probe().catch(() => undefined);
    // Fee-wallet runway: days of offer updates AND of swaps at the last day's rate the operator balance covers, with the
    // compute units and gas measured after Amendment 1.
    const est = this.load.validation.update_cost;
    if (this.sol && est && this.live) {
      const balance = (await this.sol.client.transport.getAccount(this.sol.operator))?.lamports ?? 0n;
      const days = Number(balance) / Math.max(1, Number(est.daily_lamports) + Number(this.dailySwapLamports()));
      if (days < this.config.raw.alerts.fee_runway_days) this.alerts.raise('warning', 'fee_runway', `the Solana fee wallet covers ${days.toFixed(1)} days of offer updates and swaps, under the ${this.config.raw.alerts.fee_runway_days}-day threshold`, null, 21_600);
    }
    if (this.eth && this.live && this.config.offers.some((o) => o.chain === 'ethereum' && o.enabled)) {
      const swaps = await this.ethRunwaySwaps().catch(() => null);
      if (swaps !== null && swaps < 5) this.alerts.raise('warning', 'fee_runway_eth', `the Ethereum operator balance covers the gas of about ${Math.floor(swaps)} swap${Math.floor(swaps) === 1 ? '' : 's'} at the current gas price`, null, 21_600);
    }
    this.events.emit('status', null);
  }

  /** Lamports per day the operator's swap transactions cost at the last 24 hours' rate of swaps. */
  dailySwapLamports(): bigint {
    const costs = swapCosts(this.config.raw).solana;
    let sum = 0n;
    for (const f of this.store.fills(this.store.now() - 86_400)) {
      if (f.market !== 'sol' && f.market !== 'usdc_sol') continue;
      const c = costs[f.market];
      sum += BigInt(f.direction === 0 ? c.sell_xmr_window.lamports : c.buy_xmr.lamports);
    }
    return sum;
  }
  /** How many ordinary swaps the Ethereum operator's ETH pays the gas of, at the node's current gas price. */
  async ethRunwaySwaps(): Promise<number | null> {
    if (!this.eth) return null;
    const [balance, price] = await Promise.all([this.eth.balanceOf(ETH_NATIVE as `0x${string}`, this.eth.operator as `0x${string}`), this.eth.client.transport.request({ method: 'eth_gasPrice', params: [] }).then((v) => BigInt(v as string))]);
    return price > 0n ? Number(balance) / Number(price * ETH_SWAP_GAS_MAX) : null;
  }

  /**
   * Deliver what is parked for a swap's parties without the key it is owed to (SPEC 11.2). Nothing here can redirect a
   * payout: Ethereum's `pushOwed` pays the account itself, and on Solana the program pins the destination to the swap's
   * payout address. The operator only pays the fee.
   */
  async deliverOwed(view: SwapView, ref: string): Promise<TxResult[]> {
    const txs: TxResult[] = [];
    if (view.chain === 'solana') {
      const sol = this.sol;
      if (!sol) throw new Error('Solana is not configured');
      // Only claim proceeds parked for a payout address can be delivered by a third party; a parked maker payout needs the owner key (`withdraw-owed-tx`).
      if (!(view.direction === 1 && view.payout === 'other' && endedInClaim(view) && view.owedTaker > 0n)) return txs;
      const m = await sol.maker(true);
      const ix = solanaInstruction(sol.client.program, view, { operator: m.operator, payout: m.payout }, sol.operator, { name: 'withdraw_owed', who: 'payout' });
      const { tx } = await this.journal.broadcast('sol_tx', null, { call: 'deliver_owed', swap: ref, account: view.payoutAddress }, (onSigned) => sol.sendInstructions([ix], onSigned));
      txs.push({ chain: 'solana', id: tx!, status: 'sent' });
      return txs;
    }
    const eth = this.eth;
    if (!eth) throw new Error('Ethereum is not configured');
    const token = view.asset as `0x${string}`;
    const owed = await eth.client.owedFor(token, view.taker as `0x${string}`, view.maker as `0x${string}`, eth.tag);
    const accounts = new Set<string>();
    if (owed.accounts) for (const k of ['payout', 'operator', 'owner'] as const) if (owed[k] > 0n) accounts.add(owed.accounts[k].toLowerCase());
    // The taker's side: claim proceeds of a direction-B swap are parked under the PAYOUT address, everything else under the taker's own.
    if (view.owedTaker > 0n) accounts.add((view.direction === 1 && view.payout === 'other' && endedInClaim(view) && view.payoutAddress ? view.payoutAddress : view.taker).toLowerCase());
    for (const account of accounts) {
      const { tx } = await this.journal.broadcast('eth_tx', null, { call: 'push_owed', swap: ref, account }, (onSigned) => eth.sendCall(eth.client.contract.pushOwed(token, account as `0x${string}`), onSigned));
      txs.push({ chain: 'ethereum', id: tx!, status: 'sent' });
    }
    return txs;
  }

  /** The Solana program build this daemon expects and the one deployed (SPEC 11.5). */
  async programBuild(): Promise<ProgramBuildStatus> {
    const programId = this.sol?.client.programId ?? this.config.raw.solana.program_id ?? DEV_PROGRAM_ID;
    // The whole executable is read and hashed: once every ten minutes is enough for a status page (an unreadable one is retried at once).
    if (!this.builtHash || this.builtHash.hash === null || this.now() - this.builtHash.at >= 600) this.builtHash = { at: this.now(), hash: this.sol ? await this.sol.client.programBuild('finalized').then((b) => b.hash, () => null) : null };
    const onChain = this.builtHash.hash;
    return { program_id: programId, expected_hash: PROGRAM_HASH, on_chain_hash: onChain, matches: PROGRAM_HASH === null || onChain === null ? null : PROGRAM_HASH === onChain };
  }
  private builtHash: { at: number; hash: string | null } | null = null;

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    unwatchFile(this.o.configPath);
    await this.offers.halt();
    // Let a running pass finish before the database closes.
    for (let i = 0; i < 100 && this.busy.size > 0; i++) await new Promise((r) => setTimeout(r, 50));
    this.store.close();
  }

  // ---------------------------------------------------------------- status

  /** Read the upgrade status of both deployments from chain state. Called at start, every minute, and when a status is older than that. */
  async refreshUpgrade(): Promise<void> {
    const at = this.now();
    if (this.sol) this.upgrade.set('solana', await solanaUpgradeStatus(this.sol.client.transport, this.sol.client.programId, at));
    if (this.eth) this.upgrade.set('ethereum', await ethereumUpgradeStatus(this.eth.client.transport, this.eth.client.contract.address, this.eth.tag, at));
  }

  async status(): Promise<StatusResponse> {
    const stale = [...this.upgrade.values()].some((u) => this.now() - u.checked_at >= 60);
    if (stale || (this.sol && !this.upgrade.has('solana')) || (this.eth && !this.upgrade.has('ethereum'))) await this.refreshUpgrade();
    const chains: ChainConnection[] = [];
    const local = Math.floor(Date.now() / 1000);
    let ownerPaused = false;
    const perChain: { chain: ChainName; owner: boolean; operator: boolean }[] = [];
    for (const name of ['solana', 'ethereum'] as const) {
      const c = name === 'solana' ? this.sol : this.eth;
      const configured = name === 'solana' ? !!this.config.raw.solana.maker_owner : !!this.config.raw.ethereum.contract;
      if (!c && !configured && !this.chainErrors.has(name)) continue;
      let chainTime: number | null = null;
      let error = this.chainErrors.get(name);
      try {
        if (c) chainTime = Number(await c.now());
        if (name === 'solana' && this.sol) {
          const m = await this.sol.client.getMaker(this.sol.makerPda, 'finalized');
          perChain.push({ chain: name, owner: ((m?.paused ?? 0) & 1) !== 0, operator: ((m?.paused ?? 0) & 2) !== 0 });
        } else if (this.eth) {
          const m = await this.eth.client.getMaker(this.eth.makerAddress, this.eth.tag);
          perChain.push({ chain: name, owner: m?.paused ?? false, operator: false });
        }
      } catch (e) {
        error = errMsg(e);
      }
      const network = name === 'solana' ? (this.solGenesis ?? '') : (this.ethChainId ?? '');
      chains.push({
        chain: name, connected: c !== null && chainTime !== null, endpoint: name === 'solana' ? this.config.raw.solana.rpc_url_env : this.config.raw.ethereum.rpc_url_env, network,
        network_ok: name === 'solana' ? !this.config.raw.solana.expected_genesis || this.config.raw.solana.expected_genesis === network : String(this.config.raw.ethereum.chain_id ?? '') === network,
        chain_time: chainTime, clock_skew_secs: chainTime === null ? null : local - chainTime, ...(name === 'ethereum' ? { finality: this.config.raw.ethereum.finality } : {}),
        contract: name === 'solana' ? (this.sol?.client.programId ?? this.config.raw.solana.program_id ?? DEV_PROGRAM_ID) : (this.config.raw.ethereum.contract ?? ''), ...this.upgradeFields(name, c !== null), ...(error ? { last_error: error } : {}),
      });
      if (chainTime !== null && name === 'solana' && Math.abs(local - chainTime) > CLOCK_SKEW_WARN_SECS) this.alerts.raise('warning', 'clock_skew', `the local clock is ${local - chainTime} s off Solana chain time; deadlines use chain time`, null, 3_600);
    }
    ownerPaused = perChain.some((p) => p.owner);
    const guardrails = [...new Set(this.offers.latest().flatMap((c) => (c.offer.configured ? c.ref.pausedBy : [])))];
    const tor = this.config.raw.tor;
    const onion = this.desiredPublished().onion;
    // Published = the registry's onion address is the one this daemon wants listed.
    const listed = this.sol ? ((await this.sol.client.getMaker(this.sol.makerPda, 'finalized').catch(() => null))?.onion ?? '') : '';
    await this.caps.refresh().catch(() => undefined);
    return {
      version: DAEMON_VERSION, core_version: coreVersion(), mode: this.config.raw.daemon.mode, started_at: this.startedAt, uptime_secs: this.now() - this.startedAt,
      maker: { solana: this.sol?.makerPda ?? null, ethereum: this.eth?.makerAddress ?? null }, chains,
      monero: { nodes: this.moneroStatus.nodes, agree: this.moneroStatus.agree, wallet_rpc_ok: this.walletOk, reorg_guard_active: this.risk.reorgGuardActive },
      tor: { enabled: tor.enabled, onion, published: onion !== null && listed === onion, reachable: null, ...({ registry_onion: listed || null } as object) },
      // `chains` is an addition to the frozen shape: the owner's pause is per chain.
      paused: { owner: ownerPaused, operator: this.risk.paused, guardrails, ...({ chains: perChain } as object) },
      needs_review: this.store.needsReviewCount(), alerts: this.alerts.list(20),
      caps: this.caps.view(this.disconnectedChains()), program_build: await this.programBuild(), watcher: this.watcher.status(this.now()),
      // Additions (Amendment 1): which offers a cap stops, and how many swaps were ever paused.
      ...({ degraded: await this.degraded(chains), cap_reached: this.offers.latest().filter((c) => c.capReached).map((c) => ({ market: c.offer.market, direction: c.offer.direction, code: c.capReached, reason: c.reason })), freezes: this.store.freezes().length } as object),
    };
  }

  /** Chains the file configures that are not connected, with why (their markets are listed in `caps[]` as unreadable). */
  disconnectedChains(): { chain: ChainName; reason: string }[] {
    const out: { chain: ChainName; reason: string }[] = [];
    if (!this.sol && (this.config.raw.solana.maker_owner || this.chainErrors.has('solana'))) out.push({ chain: 'solana', reason: this.chainErrors.get('solana') ?? `not connected: ${this.config.raw.solana.rpc_url_env} is not set` });
    if (!this.eth && (this.config.raw.ethereum.contract || this.chainErrors.has('ethereum'))) out.push({ chain: 'ethereum', reason: this.chainErrors.get('ethereum') ?? `not connected: ${this.config.raw.ethereum.rpc_url_env} is not set` });
    return out;
  }

  /** Seconds a chain's clock may lag the local one before the endpoint counts as behind. */
  static readonly CHAIN_BEHIND_SECS = 120;
  /** Milliseconds one pass over the open swaps may take before it counts as slow. */
  static readonly PASS_SLOW_MS = 30_000;

  /**
   * Whether the daemon can do its whole job right now, and if not, why (`status.degraded`). Every reason is something
   * the maker can act on; none of them stops the daemon, which keeps doing what it still can.
   */
  async degraded(chains: ChainConnection[]): Promise<{ state: boolean; reasons: { code: string; message: string; chain?: ChainName; swap_ref?: string }[] }> {
    const reasons: { code: string; message: string; chain?: ChainName; swap_ref?: string }[] = [];
    for (const c of chains) {
      if (!c.connected) reasons.push({ code: 'chain_unreachable', chain: c.chain, message: `the ${c.chain} endpoint cannot be reached${c.last_error ? `: ${c.last_error}` : ''}` });
      else if (c.clock_skew_secs !== null && c.clock_skew_secs > Daemon.CHAIN_BEHIND_SECS) reasons.push({ code: 'chain_behind', chain: c.chain, message: `the ${c.chain} endpoint is ${c.clock_skew_secs} s behind the local clock: it serves old state` });
      else if (c.connected && this.caps.errorOf(c.chain)) reasons.push({ code: 'caps_unreadable', chain: c.chain, message: `the ${c.chain} caps cannot be read (${this.caps.errorOf(c.chain)}): nothing is published there` });
    }
    if (this.moneroStatus.nodes.length === 0) await this.refreshMonero();
    const m = this.moneroStatus;
    const down = m.nodes.filter((n) => !n.ok).map((n) => n.label);
    if (m.nodes.length === 0 || down.length > 0) reasons.push({ code: 'monero_node_down', message: m.nodes.length === 0 ? 'no Monero node answers' : `Monero node${down.length === 1 ? '' : 's'} not answering: ${down.join(', ')}` });
    else if (!m.agree) reasons.push({ code: 'monero_nodes_disagree', message: 'the Monero nodes report different chain tips: locks are not verified until they agree' });
    if (!this.walletOk) reasons.push({ code: 'wallet_rpc_down', message: 'the inventory wallet RPC cannot be reached: no XMR can be locked or swept' });
    const est = this.load.validation.update_cost;
    if (this.sol && est && this.live) {
      const balance = await this.sol.client.transport.getAccount(this.sol.operator).then((a) => a?.lamports ?? 0n, () => null);
      const days = balance === null ? null : Number(balance) / Math.max(1, Number(est.daily_lamports) + Number(this.dailySwapLamports()));
      if (days !== null && days < this.config.raw.alerts.fee_runway_days) reasons.push({ code: 'fee_runway', chain: 'solana', message: `the Solana fee wallet covers ${days.toFixed(1)} days, under the ${this.config.raw.alerts.fee_runway_days}-day threshold` });
    }
    if (this.eth && this.live && this.config.offers.some((o) => o.chain === 'ethereum' && o.enabled)) {
      const swaps = await this.ethRunwaySwaps().catch(() => null);
      if (swaps !== null && swaps < 5) reasons.push({ code: 'fee_runway', chain: 'ethereum', message: `the Ethereum operator balance covers the gas of about ${Math.floor(swaps)} swap${Math.floor(swaps) === 1 ? '' : 's'}` });
    }
    const pass = this.executor.lastPass;
    if (pass && pass.ms > Daemon.PASS_SLOW_MS) reasons.push({ code: 'executor_slow', message: `the last pass over the open swaps took ${(pass.ms / 1000).toFixed(1)} s (the bound is ${Daemon.PASS_SLOW_MS / 1000} s): deadlines are being met late` });
    // A funded sell-XMR swap that names the watcher but has no acknowledgement: nothing pauses it if this daemon goes down.
    for (const ref of this.watcher.unwatched()) reasons.push({ code: 'watcher_not_watching', swap_ref: ref, message: `the maker watcher has not acknowledged this funded swap${this.watcher.isReachable === false ? ' (it is unreachable' : ' (no acknowledgement yet'}${this.watcher.error ? `: ${this.watcher.error}` : ''}); the daemon must stay up through its claim-open time` });
    return { state: reasons.length > 0, reasons };
  }

  private upgradeFields(chain: ChainName, connected: boolean): Pick<ChainConnection, 'upgradeable' | 'upgrade_authority'> {
    const u = this.upgrade.get(chain) ?? { status: 'unknown' as const, authority: null, pending_authority: null, implementation: null, reason: connected ? 'not read yet' : 'the chain is not connected', checked_at: this.now() };
    return {
      upgradeable: u.status === 'unknown' ? null : u.status === 'upgradable', upgrade_authority: u.authority,
      // Additions to the frozen shape: the three-way status with its reason, and what else the chain says.
      ...({ upgrade_status: u.status, upgrade_reason: u.reason, upgrade_pending_authority: u.pending_authority, upgrade_implementation: u.implementation, upgrade_checked_at: u.checked_at } as object),
    };
  }

  /** Refresh the cached Monero node status now (the status page and tests). */
  async refreshMonero(): Promise<void> {
    this.moneroStatus = await this.monero.status().catch(() => ({ nodes: [], agree: false }));
  }
  /** Whether the built console's static files exist, and where. */
  consoleDir(): string | null {
    const dir = this.config.raw.daemon.console_dir;
    return dir && existsSync(path.join(dir, 'index.html')) ? dir : null;
  }
}
