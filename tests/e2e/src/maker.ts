// One maker: the REAL daemon (`packages/daemon/src/cli.ts start <file>`) as its own process, in
// live mode, with a test keystore, its own inventory wallet in its own monero-wallet-rpc, the
// built console served from its API, and its `/xs/v1` endpoint that the relay reaches through
// the fake Tor. Registration goes the way a maker does it: the daemon builds the owner-key
// transaction, the "owner wallet" (a test key here) signs it, the daemon relays it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Transaction } from '@solana/web3.js';
import { Keystore } from '@xmrswap/daemon';
import type { Address } from '@xmrswap/protocol';
import type { StatusResponse } from '@xmrswap/protocol/daemon-api';
import { type SolanaSigner, seedSigner } from '@xmrswap/sdk';
import type { PrivateKeyAccount } from 'viem/accounts';
import { type EthWorld, type SolWorld, ethAccount } from './chains.js';
import { REGTEST_MAX_FEE, Wallet } from './monero.js';
import { type Proc, startProc, tsNode } from './procs.js';
import { fill, freePort, hexOf, repoRoot, sleep, stateRoot, waitFor } from './util.js';

export const PASSPHRASE = 'e2e keystore passphrase: correct horse battery staple';
const CLI = path.join(repoRoot, 'packages/daemon/src/cli.ts');

/** A stand-in for the price API (CoinGecko's `simple/price` shape) on loopback. No live price source is ever called. */
export interface PriceServer {
  url: string;
  prices: { xmr: number; sol: number; eth: number };
  /** Answer 503 (a source outage). */
  down: boolean;
  hits: number;
  close(): Promise<void>;
}
export async function startPriceServer(prices = { xmr: 150, sol: 100, eth: 3000 }): Promise<PriceServer> {
  const s: PriceServer = { url: '', prices, down: false, hits: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    s.hits++;
    if (s.down || !req.url?.startsWith('/simple/price')) return void res.writeHead(s.down ? 503 : 404).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ monero: { usd: s.prices.xmr }, solana: { usd: s.prices.sol }, ethereum: { usd: s.prices.eth } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  return s;
}

export type MarketName = 'sol' | 'usdc_sol' | 'eth' | 'usdc_eth';
export type DirName = 'sell_xmr' | 'buy_xmr';
export interface OfferCfg {
  enabled?: boolean;
  max_xmr?: number;
  min_xmr?: number;
  deposit_pct?: number;
  deviation_pct?: number;
  approval_mode?: 'auto' | 'window' | 'advance';
  approval_window_seconds?: number;
  withhold_policy?: 'never' | 'always' | 'price_moved';
  without_ready?: 'claim' | 'abort';
  depth?: number;
  /** How long a published offer stays valid without a refresh (chain seconds; the daemon's default is 60 on Solana). */
  offer_valid_seconds?: number;
}
export interface MakerOpts {
  /** 1-based; decides keys, ports and directory. */
  n: number;
  walletRpcUrl: string;
  moneroNodes: [string, string];
  priceUrl: string;
  /** The fake onion name the relay maps to this daemon's endpoint. */
  onion: string;
  markets?: Partial<Record<MarketName, Partial<Record<DirName, OfferCfg>>>>;
  /** Extra TOML appended verbatim (top-level tables not written by the harness). */
  extraToml?: string;
  ethereum?: boolean;
  /** `[approvals].auto_max_xmr`: above it a pending lock waits for the maker in the console. */
  autoMaxXmr?: number;
  /** `[approvals].advance`: takers this maker approves in advance when they ask. */
  advance?: { taker: string; max_xmr: number; days: number }[];
}

const DEFAULT_MARKETS: NonNullable<MakerOpts['markets']> = {
  sol: { sell_xmr: {}, buy_xmr: {} },
  usdc_sol: { sell_xmr: {}, buy_xmr: {} },
  eth: { sell_xmr: {}, buy_xmr: {} },
  usdc_eth: { sell_xmr: {}, buy_xmr: {} },
};

export class Maker {
  proc: Proc | null = null;
  readonly dir: string;
  readonly configPath: string;
  readonly solOwner: SolanaSigner;
  readonly solOperator: SolanaSigner;
  readonly solPayout: SolanaSigner;
  readonly ethOwner: PrivateKeyAccount;
  readonly ethOperator: PrivateKeyAccount;
  readonly ethPayout: PrivateKeyAccount;
  readonly keystoreSeed: Uint8Array;
  readonly wallet: Wallet;
  apiUrl = '';
  endpointPort = 0;
  token = '';
  makerPda = '';
  xmrAddress = '';
  starts = 0;
  /** The market table the configuration file currently carries. */
  markets: NonNullable<MakerOpts['markets']>;
  private apiPort = 0;

  constructor(
    readonly o: MakerOpts,
    readonly sol: SolWorld,
    readonly eth: EthWorld | null,
  ) {
    const k = 100 + o.n * 10;
    this.dir = path.join(stateRoot, `maker-${o.n}`);
    this.configPath = path.join(this.dir, 'maker.toml');
    this.solOwner = seedSigner(fill(k + 1));
    this.solOperator = seedSigner(fill(k + 2));
    this.solPayout = seedSigner(fill(k + 3));
    this.ethOwner = ethAccount(k + 4);
    this.ethOperator = ethAccount(k + 5);
    this.ethPayout = ethAccount(k + 6);
    this.keystoreSeed = fill(k + 7);
    this.wallet = new Wallet(o.walletRpcUrl, `e2e-maker-${o.n}-${Date.now()}`);
    this.markets = structuredClone(o.markets ?? DEFAULT_MARKETS);
  }
  get ethMaker(): Address {
    return this.ethOwner.address.toLowerCase() as Address;
  }
  /** Every secret of this maker that must never appear in a log, by name. */
  secrets(): Record<string, string> {
    const k = 100 + this.o.n * 10;
    return { [`maker${this.o.n}.seed`]: hexOf(this.keystoreSeed), [`maker${this.o.n}.solOperator`]: hexOf(fill(k + 2)), [`maker${this.o.n}.ethOperator`]: hexOf(fill(k + 5)), [`maker${this.o.n}.passphrase`]: PASSPHRASE, ...(this.token ? { [`maker${this.o.n}.apiToken`]: this.token } : {}) };
  }

  toml(): string {
    const o = this.o;
    const offer = (m: MarketName, d: DirName): string => {
      const c = this.markets[m]?.[d];
      if (!c || c.enabled === false) return '';
      const lines = [`[markets.${m}.${d}]`, 'enabled = true', `min_xmr = ${c.min_xmr ?? 0.05}`, `max_xmr = ${c.max_xmr ?? 5}`, `deposit_pct = ${c.deposit_pct ?? 1}`, `deviation_pct = ${c.deviation_pct ?? 2.0}`, `confirmation_depth = [{ above_xmr = 0, depth = ${c.depth ?? 2} }]`];
      if (c.approval_mode) lines.push(`approval_mode = "${c.approval_mode}"`);
      if (c.approval_window_seconds) lines.push(`approval_window_seconds = ${c.approval_window_seconds}`);
      if (c.withhold_policy) lines.push(`withhold_policy = "${c.withhold_policy}"`);
      if (c.without_ready) lines.push(`without_ready = "${c.without_ready}"`);
      if (c.offer_valid_seconds) lines.push(`offer_valid_seconds = ${c.offer_valid_seconds}`);
      return `${lines.join('\n')}\n`;
    };
    const eth = this.eth && o.ethereum !== false;
    return `# Written by the end-to-end harness. Endpoints are loopback; secrets are named by environment variable only.
[daemon]
mode = "live"
data_dir = "${path.join(this.dir, 'data')}"
api_bind = "127.0.0.1:${this.apiPort}"
console_dir = "${path.join(repoRoot, 'apps/console/dist')}"

[solana]
rpc_url_env = "E2E_SOL"
program_id = "${this.sol.client.programId}"
expected_genesis = "${this.sol.genesis}"
maker_owner = "${this.solOwner.publicKey}"
subscriptions = false
${
  eth
    ? `
[ethereum]
rpc_url_env = "E2E_ETH"
contract = "${this.eth!.contract}"
chain_id = 31337
maker_owner = "${this.ethMaker}"
`
    : ''
}
[monero]
network = "regtest"
node_url_envs = ["E2E_XMR_A", "E2E_XMR_B"]
wallet_rpc_url_env = "E2E_XMR_WALLET"
sweep_max_fee = ${REGTEST_MAX_FEE}

[tor]
enabled = true
listen = "127.0.0.1:${this.endpointPort}"
hostname_file = "${path.join(this.dir, 'hostname')}"

[offers]
eth_pool_size = 8
update_interval_seconds = 4

[pricing]
refresh_seconds = 5
max_age_seconds = 120

[pricing.sources.coingecko]
base_url = "${o.priceUrl}"
${o.autoMaxXmr !== undefined || o.advance ? `\n[approvals]\n${o.autoMaxXmr !== undefined ? `auto_max_xmr = ${o.autoMaxXmr}\n` : ''}${o.advance ? `advance = [${o.advance.map((a) => `{ taker = "${a.taker}", max_xmr = ${a.max_xmr}, days = ${a.days} }`).join(', ')}]\n` : ''}` : ''}
${(['sol', 'usdc_sol', 'eth', 'usdc_eth'] as const).filter((m) => eth || !m.includes('eth')).flatMap((m) => (['sell_xmr', 'buy_xmr'] as const).map((d) => offer(m, d))).join('\n')}
${o.extraToml ?? ''}`;
  }

  env(): NodeJS.ProcessEnv {
    // A minimal environment: nothing of the developer's shell (wallet paths, RPC URLs, API keys) reaches the daemon.
    return {
      PATH: process.env['PATH'], HOME: path.join(this.dir, 'home'), NODE_ENV: 'production',
      XMRSWAP_KEYSTORE_PASSPHRASE: PASSPHRASE, E2E_SOL: this.sol.url, ...(this.eth ? { E2E_ETH: this.eth.url } : {}),
      E2E_XMR_A: this.o.moneroNodes[0], E2E_XMR_B: this.o.moneroNodes[1], E2E_XMR_WALLET: this.o.walletRpcUrl,
    };
  }

  /** First start: directories, keystore, funded keys, inventory wallet, configuration. Does not start the process. */
  async prepare(inventoryBlocks: number, mineTo: (n: number, address: string) => Promise<unknown>, takerAddress: string): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(path.join(this.dir, 'data'), { recursive: true });
    mkdirSync(path.join(this.dir, 'home'), { recursive: true });
    new Keystore({ seed: this.keystoreSeed, solanaOperator: fill(100 + this.o.n * 10 + 2), ethereumOperator: fill(100 + this.o.n * 10 + 5) }).save(path.join(this.dir, 'data'), PASSPHRASE);
    writeFileSync(path.join(this.dir, 'hostname'), `${this.o.onion}\n`);
    this.apiPort = await freePort();
    this.endpointPort = await freePort();
    this.apiUrl = `http://127.0.0.1:${this.apiPort}`;
    for (const s of [this.solOwner, this.solOperator, this.solPayout]) await this.sol.fund(s.publicKey, 1_000_000_000_000n, s === this.solOwner ? 0n : 1_000_000_000_000n);
    if (this.eth && this.o.ethereum !== false) {
      await this.eth.fund(this.ethOwner.address);
      await this.eth.fund(this.ethOperator.address, 1000n * 10n ** 18n, 1_000_000_000_000n);
      await this.eth.fund(this.ethPayout.address, 0n, 0n);
      await this.eth.usdcApprove(this.ethOperator, 2n ** 200n);
    }
    this.xmrAddress = await this.wallet.open();
    // Coinbase outputs for the inventory, then 60 more blocks so they unlock.
    await mineTo(inventoryBlocks, this.xmrAddress);
    await mineTo(62, takerAddress);
    await this.wallet.refresh();
    writeFileSync(this.configPath, this.toml(), { mode: 0o600 });
  }

  async start(): Promise<void> {
    this.starts++;
    this.proc = startProc(`maker-${this.o.n}-run${this.starts}`, ...tsNode(CLI, 'start', this.configPath), { env: this.env(), cwd: this.dir });
    await this.proc.waitForOutput(/API on (http:\/\/127\.0\.0\.1:\d+)/, 90_000);
    this.token = readFileSync(path.join(this.dir, 'data', 'api-token'), 'utf8').trim();
    await waitFor(`maker ${this.o.n} API`, async () => (await this.api<StatusResponse>('GET', '/api/status')).version, { timeoutMs: 60_000 });
  }
  /** A crash: SIGKILL, no clean-up. */
  async kill(): Promise<void> {
    await this.proc?.kill();
    this.proc = null;
  }
  async stop(): Promise<void> {
    await this.proc?.stop();
    this.proc = null;
  }
  get running(): boolean {
    return !!this.proc?.alive();
  }

  async api<T = any>(method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${route}`, { method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      j = text;
    }
    if (!res.ok) throw Object.assign(new Error(`${method} ${route}: HTTP ${res.status} ${text.slice(0, 400)}`), { status: res.status, body: j });
    return j as T;
  }

  /**
   * An operator instruction through the daemon's API, as the console sends it. While BUG-3 (tests/e2e/BUGS.md) is open, an
   * instruction that lands during one of the daemon's own passes over the swap can come back refused as
   * `not-available-in-state` although the state accepts it; an operator would press the button again, and so does this.
   * Any other refusal is returned as it is.
   */
  async instruct(ref: string, action: 'approve' | 'reject' | 'abort' | 'withhold' | 'release', body: unknown = {}): Promise<{ ok: boolean; outcome?: string; refused?: string; detail?: string }> {
    let last: { ok: boolean; outcome?: string; refused?: string; detail?: string } = { ok: false };
    for (let attempt = 0; attempt < 4; attempt++) {
      last = await this.api('POST', `/api/swaps/${encodeURIComponent(ref)}/${action}`, body);
      const stillOffered = ((await this.swapDetail(ref).catch(() => null))?.actions ?? []).includes(action);
      if (!(last.outcome === 'refused' && last.refused === 'not-available-in-state' && stillOffered)) break;
    }
    return last;
  }

  /** Register on Solana, then Ethereum, then link the two, each signed by the owner key outside the daemon. */
  async register(): Promise<void> {
    const submitSol = async (action: Record<string, unknown>): Promise<void> => {
      const r = await this.api<{ request_id: string; unsigned: { message_b64: string } }>('POST', '/api/registration/tx', { chain: 'solana', ...action });
      const message = Buffer.from(r.unsigned.message_b64, 'base64');
      const tx = Transaction.populate((await import('@solana/web3.js')).Message.from(message), []);
      tx.addSignature(new (await import('@solana/web3.js')).PublicKey(this.solOwner.publicKey), Buffer.from(await this.solOwner.sign(Uint8Array.from(message))));
      await this.api('POST', '/api/registration/submit', { request_id: r.request_id, signed: tx.serialize().toString('base64') });
    };
    const submitEth = async (action: Record<string, unknown>): Promise<void> => {
      const eth = this.eth!;
      const r = await this.api<{ request_id: string; unsigned: { to: Address; data: `0x${string}`; value: string; chain_id: number } }>('POST', '/api/registration/tx', { chain: 'ethereum', ...action });
      const nonce = Number(await eth.rpc<string>('eth_getTransactionCount', [this.ethOwner.address, 'pending']));
      const gas = BigInt(await eth.rpc<string>('eth_estimateGas', [{ from: this.ethOwner.address, to: r.unsigned.to, data: r.unsigned.data, value: `0x${BigInt(r.unsigned.value).toString(16)}` }]));
      const base = BigInt((await eth.rpc<{ baseFeePerGas: string }>('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
      const signed = await this.ethOwner.signTransaction({ chainId: r.unsigned.chain_id, to: r.unsigned.to, data: r.unsigned.data, value: BigInt(r.unsigned.value), nonce, gas: (gas * 13n) / 10n, maxFeePerGas: base * 2n + 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: 'eip1559' });
      const res = await this.api<{ id: `0x${string}` }>('POST', '/api/registration/submit', { request_id: r.request_id, signed });
      await eth.client.waitMined(res.id, { intervalMs: 100 });
    };
    await submitSol({ action: 'register_maker', owner: this.solOwner.publicKey, operator: this.solOperator.publicKey, payout: this.solPayout.publicKey });
    this.makerPda = this.sol.client.program.makerPda(this.solOwner.publicKey).toBase58();
    await waitFor('the Solana registration', () => this.sol.client.getMaker(this.makerPda));
    if (this.eth && this.o.ethereum !== false) {
      await submitEth({ action: 'register_maker', owner: this.ethOwner.address, operator: this.ethOperator.address, payout: this.ethPayout.address, solana_owner: this.solOwner.publicKey });
      await submitSol({ action: 'set_eth_link', eth_address: this.ethMaker });
      await this.eth.finalize();
    }
    // Publish the onion name now instead of waiting for the daemon's minute-long housekeeping round.
    await this.api('PUT', '/api/registration/published', { onion: this.o.onion });
    await waitFor('the onion address in the registry', async () => (await this.sol.client.getMaker(this.makerPda))?.onion === this.o.onion);
  }

  /** Rewrite the market table and apply it through the daemon's own API (as the console does). */
  async setMarkets(patch: Partial<Record<MarketName, Partial<Record<DirName, OfferCfg>>>>): Promise<void> {
    for (const [m, dirs] of Object.entries(patch) as [MarketName, Partial<Record<DirName, OfferCfg>>][]) for (const [d, c] of Object.entries(dirs) as [DirName, OfferCfg][]) this.markets[m] = { ...this.markets[m], [d]: { ...this.markets[m]?.[d], ...c } };
    const cur = await this.api<{ revision: string }>('GET', '/api/config');
    await this.api('PUT', '/api/config', { toml: this.toml(), base_revision: cur.revision });
  }

  status(): Promise<StatusResponse> {
    return this.api<StatusResponse>('GET', '/api/status');
  }
  /** The daemon's public counters on a chain, as the registry shows them. */
  async counters(chain: 'solana' | 'ethereum'): Promise<number[]> {
    if (chain === 'solana') return [...(await this.sol.client.getMaker(this.makerPda))!.counters];
    return this.eth!.client.counters(this.ethMaker, 'latest');
  }
  async swaps(): Promise<any[]> {
    return (await this.api<{ swaps: any[] }>('GET', '/api/swaps')).swaps;
  }
  async swapDetail(ref: string): Promise<any> {
    return this.api('GET', `/api/swaps/${encodeURIComponent(ref)}`);
  }
  /** Everything the daemon printed, over all of its runs. */
  logs(): string {
    return this.allProcs.map((p) => p.output()).join('\n');
  }
  private allProcs: Proc[] = [];
  trackProc(): void {
    if (this.proc && !this.allProcs.includes(this.proc)) this.allProcs.push(this.proc);
  }
}
export { sleep };
