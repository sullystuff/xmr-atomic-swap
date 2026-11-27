// The test stack behind the browser tests, the screenshots and `pnpm stack`:
//   - tools/svm-rpc: the built Solana program inside an in-memory LiteSVM behind JSON-RPC on
//     loopback (not a validator, not a cluster), initialised, with makers and live offers;
//   - an in-test maker built from the SDK's maker flows (`makerStep`), stepped by the test;
//   - a static file server for the built UI with a `config.json` pointing at the above and at
//     the Monero regtest's two nodes.
// Nothing here reads `solana config`, a CLI wallet or any live network.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, type TransactionInstruction } from '@solana/web3.js';
import type { DerivedKeys } from '@xmrswap/core-wasm';
import { DEV_PROGRAM_ID, type Maker, type OfferTerms, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import {
  type CallMaterial,
  type Decision,
  SolanaClient,
  type SolanaSigner,
  type SwapView,
  buildNotice,
  deadlinesOf,
  connectionTransport,
  hex,
  init,
  jointSpendKey,
  lockReport,
  makerShareKeys,
  makerStep,
  openWatchRequest,
  signWatchAck,
  watcherFacts,
  watcherStep,
  openNotice,
  seedSigner,
  solanaInstruction,
  solanaMakerShare,
  swapJointAddress,
  verifyLock,
} from '@xmrswap/sdk';
import { sweepJoint } from '@xmrswap/core-wasm';
import { type SvmRpc, startSvmRpc } from '@xmrswap/svm-rpc';
import * as xmr from './xmr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');
const SO = process.env.XMR_SWAP_SO ?? path.join(repoRoot, 'solana/program/target/deploy/xmr_swap.so');
const DIST = path.resolve(here, '../dist');
/** Chain time starts at the wall clock, so the page's clock-skew warning only appears once a test has warped far ahead. */
export const T0 = Math.floor(Date.now() / 1000);
export const XMR = 1_000_000_000_000n;
export const SOL = 1_000_000_000n;
const seed = (n: number) => new Uint8Array(32).fill(n);
const bytes = (txid: string) => Uint8Array.from(Buffer.from(txid, 'hex'));

export interface MakerOpts {
  /** Lamports per XMR. */
  price: bigint;
  maxXmr?: bigint;
  capacityXmr?: bigint;
  mode?: number;
  depBps?: number;
  terms?: Partial<OfferTerms>;
  /** Also publish a buy-XMR (direction B) offer paying USDC. */
  buys?: boolean;
}

/** One maker: its keys, its published offer, and the daemon's side of every swap, driven by `makerStep`. */
export class TestMaker {
  readonly shares = new Map<string, DerivedKeys>();
  /** Lock transactions this maker prepared, by swap: `{ txid, txHex, relayed }`. */
  readonly locks = new Map<string, { txid: string; txHex: string; relayed: boolean }>();
  /** Never post a lock notice (a stalled maker). */
  stall = false;
  /** Post a notice naming a transaction that pays this much less than agreed (a false lock). */
  shortBy = 0n;
  /** Never claim (a maker that goes away after the taker's ready). */
  noClaim = false;
  private shareCounter = 1;
  readonly makerSeed: Uint8Array;
  readonly enc: DerivedKeys;
  pda = '';

  constructor(
    private readonly w: Stack,
    readonly n: number,
    readonly owner: SolanaSigner,
    readonly operator: SolanaSigner,
    readonly payout: SolanaSigner,
    readonly opts: MakerOpts,
  ) {
    this.makerSeed = seed(70 + n);
    this.enc = makerShareKeys(this.makerSeed, 'solana', new Uint8Array(16).fill(1));
  }

  newShare(): DerivedKeys {
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(0, ++this.shareCounter);
    const k = makerShareKeys(this.makerSeed, 'solana', id);
    this.shares.set(hex(k.spendPub), k);
    return k;
  }

  record(): Promise<Maker> {
    return this.w.client.getMaker(this.pda).then((m) => m!);
  }

  async register(): Promise<void> {
    const c = this.w.client;
    await this.w.send([c.program.registerMaker({ owner: this.owner.publicKey, operator: this.operator.publicKey, payout: this.payout.publicKey, encKey: this.enc.encPub })], [this.owner]);
    this.pda = c.program.makerPda(this.owner.publicKey).toBase58();
  }

  /** `set_offer`, pool keys for direction A, then one `refresh_offers` that makes it live. */
  async publish(asset: number, direction: number, price: bigint): Promise<void> {
    const c = this.w.client;
    const o = this.opts;
    const terms: OfferTerms = { mode: o.mode ?? 0, minXmr: XMR / 100n, maxXmr: o.maxXmr ?? 1000n * XMR, validSecs: 3600, priceAbove: [0n, 0n, 0n], depthAbove: [0n, 0n, 0n], depths: Uint8Array.of(2, 0, 0), depBps: o.depBps ?? 100, wA: 60, wN: 600, dC: 3600, wC: 1800, wF: 604_800, wZ: 0, ...o.terms };
    await this.w.send([c.program.setOffer(this.operator.publicKey, this.pda, asset, direction, terms)], [this.operator]);
    await this.refresh(asset, direction, price);
  }

  /** What a running daemon does every few seconds: top the key pool up and refresh the offer. The tests warp hours ahead between steps. */
  async refresh(asset = 0, direction = 0, price = this.opts.price): Promise<void> {
    const c = this.w.client;
    if (direction === 0) {
      const offer = (await c.getOffer(this.pda, asset, 0))!;
      const slots = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !(((offer.poolFilled & ~offer.poolUsed) >> i) & 1)).map((index) => ({ index, ...solanaMakerShare(this.newShare(), base58Decode(this.pda)) }));
      if (slots.length) await this.w.send([c.program.refillKeys(this.operator.publicKey, this.pda, asset, slots)], [this.operator]);
    }
    await this.w.send([c.program.refreshOffers(this.operator.publicKey, this.pda, [{ asset, direction, enabled: true, prices: [price, 0n, 0n], capacityXmr: this.opts.capacityXmr ?? 1000n * XMR }])], [this.operator]);
  }

  private async exec(s: SwapView, d: Decision, m: CallMaterial = {}): Promise<void> {
    if (d.do !== 'call') throw new Error(`not a call: ${d.do}`);
    const mk = await this.record();
    await this.w.send([solanaInstruction(this.w.client.program, s, { operator: mk.operator, payout: mk.payout }, this.operator.publicKey, d.call, m)], [this.operator]);
  }

  private verify(s: SwapView, txid: string, view: Uint8Array) {
    const joint = swapJointAddress(s, view, 'regtest');
    return verifyLock({ nodes: [xmr.NODE_A, xmr.NODE_B], txid, viewPriv: hex(joint.viewPriv), spendPub: hex(joint.spendPub), minAmount: s.xmr, minConf: s.depth });
  }

  /**
   * Do everything this maker's daemon would do right now, for every one of its swaps: one pass of
   * read state, ask `makerStep`, act. Returns what it did, for the test's log.
   */
  async step(): Promise<string[]> {
    const done: string[] = [];
    const c = this.w.client;
    for (const listed of await c.listSwapsByMaker(this.pda)) {
      let s = listed;
      const ref = this.w.refOf(s);
      for (let i = 0; i < 6; i++) {
        const now = await c.chainTime();
        const share = this.shares.get(hex(s.makerSpendPub));
        const lock = this.locks.get(ref);
        if (s.direction === 0) {
          if (s.state === SWAP_STATE.ACTIVE && this.stall) break;
          if (s.state === SWAP_STATE.READY && this.noClaim) break;
          const d = makerStep({ swap: s, now, commitmentsOk: true, lockTx: !lock ? 'none' : lock.relayed ? 'relayed' : 'prepared', withoutReady: 'abort' });
          if (d.do === 'offchain' && d.action === 'prepare-lock-tx') {
            const joint = swapJointAddress(s, share!.view, 'regtest');
            // Built but not relayed: the notice goes on-chain first.
            this.locks.set(ref, { ...(await xmr.prepareTransfer(joint.address, s.xmr - this.shortBy)), relayed: false });
            done.push(`${this.n}: prepared the XMR lock`);
            continue;
          }
          if (d.do === 'call' && d.call.name === 'post_notice') {
            await this.exec(s, d, { notice: buildNotice(s, this.enc.encSecret, bytes(lock!.txid), share!.view) });
            done.push(`${this.n}: posted the notice`);
          } else if (d.do === 'offchain' && d.action === 'relay-xmr') {
            await xmr.relay(lock!.txHex);
            lock!.relayed = true;
            // Let the inventory wallet see its spent outputs before the next maker builds a lock.
            await xmr.settle(1);
            done.push(`${this.n}: relayed the XMR lock`);
            continue;
          } else if (d.do === 'call' && d.call.name === 'claim') {
            await this.exec(s, d, { secret: share!.spend });
            done.push(`${this.n}: claimed`);
          } else if (d.do === 'call') {
            await this.exec(s, d);
            done.push(`${this.n}: ${d.call.name}`);
          } else break;
        } else {
          // Direction B: fund, check the taker's payment on both nodes, set ready, sweep.
          const facts = { swap: s, now, commitmentsOk: true } as Parameters<typeof makerStep>[0];
          if (s.state === SWAP_STATE.PENDING) facts.approval = { approve: true };
          let opened: { txid: Uint8Array; view: Uint8Array } | null = null;
          if (s.state === SWAP_STATE.NOTICED || s.state === SWAP_STATE.READY || s.state === SWAP_STATE.DONE) {
            opened = s.noticeCt.length ? openNotice(s, this.enc.encSecret) : null;
            facts.noticeOpens = opened !== null;
            if (opened && s.state === SWAP_STATE.NOTICED) facts.lock = lockReport(await this.verify(s, hex(opened.txid), opened.view));
          }
          if (this.sweptB.has(ref)) facts.swept = true;
          const d = makerStep(facts);
          if (d.do === 'call' && d.call.name === 'fund') {
            const k = this.newShare();
            await this.exec(s, d, { makerShare: { ...solanaMakerShare(k, base58Decode(this.pda)), spendPub: k.spendPub, view: k.view } });
            done.push(`${this.n}: funded`);
          } else if (d.do === 'call') {
            await this.exec(s, d, share ? { secret: share.spend } : {});
            done.push(`${this.n}: ${d.call.name}`);
          } else if (d.do === 'offchain' && d.action === 'sweep' && opened && share) {
            const txid = hex(opened.txid);
            const v = await this.verify(s, txid, opened.view);
            if (v.blockHeight === undefined || v.outputIndex === undefined || v.confirmations < 10) break;
            const joint = swapJointAddress(s, opened.view, 'regtest');
            await sweepJoint({ daemonUrl: xmr.NODE_A, network: 'regtest', spendKey: jointSpendKey(s, share.spend, 'maker'), viewKey: joint.viewPriv, lockHeight: v.blockHeight, lockTxid: bytes(txid), outputIndex: BigInt(v.outputIndex), destination: await xmr.walletAddress(), maxFee: xmr.REGTEST_MAX_FEE, publish: true });
            this.sweptB.add(ref);
            done.push(`${this.n}: swept the taker's XMR`);
            continue;
          } else break;
        }
        const next = await c.getSwap(ref);
        if (!next) break;
        s = next;
      }
    }
    return done;
  }
  private readonly sweptB = new Set<string>();
}

export interface Stack {
  svm: SvmRpc;
  client: SolanaClient;
  usdc: string;
  admin: SolanaSigner;
  /** The taker's wallet key: the injected test wallet signs with it. */
  taker: SolanaSigner;
  makers: TestMaker[];
  /** Origin of the static server that serves the built UI. */
  url: string;
  now(): Promise<bigint>;
  /** Move chain time forward to `t` (never backwards). */
  warpTo(t: bigint): Promise<void>;
  warp(secs: number): Promise<void>;
  send(ixs: TransactionInstruction[], signers: SolanaSigner[]): Promise<string>;
  refOf(s: SwapView): string;
  balance(pubkey: string): Promise<bigint>;
  /** One pass of every maker's daemon. */
  stepMakers(): Promise<string[]>;
  /** Set the protocol's beta caps (admin), per asset: index 0 SOL, 1 USDC. */
  setCaps(maxSwap: [bigint, bigint], maxOpen: [bigint, bigint], capsOn?: boolean): Promise<void>;
  /** The in-test watcher: an HTTP endpoint plus `watcherStep`, stepped by the test. */
  watcher: TestWatcher;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Serve the built UI and its `config.json` on a free loopback port. */
/**
 * The watcher of SPEC 11.6, in the test: the two HTTP routes a page talks to, and the whole
 * behaviour as the SDK's pure `watcherStep` (the real service in packages/watcher is not used).
 * It holds one key and the notice keys it was handed; it can only freeze.
 */
export class TestWatcher {
  readonly seed = new Uint8Array(32).fill(61);
  readonly key: SolanaSigner = seedSigner(this.seed);
  /** Notice keys by swap PDA. */
  readonly watched = new Map<string, Uint8Array>();
  /** Answer registrations with an acknowledgement (false: refuse, like a watcher that is full). */
  accept = true;
  url = '';
  private server: http.Server | null = null;
  constructor(private readonly w: Stack) {}

  async start(): Promise<void> {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    this.server = http.createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'OPTIONS') return send(204, {});
      if (req.method === 'GET' && req.url === '/watch/v1/info') return send(200, { solana: this.key.publicKey, ethereum: '0x00000000000000000000000000000000000000aa', max_swaps: 100, monero_nodes: 2 });
      if (req.method === 'POST' && req.url === '/watch/v1/swaps') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          void (async () => {
            try {
              if (!this.accept) return send(503, { error: 'full' });
              const r = openWatchRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.seed);
              const ref = base58(r.swapRef);
              // Accepted only if the swap exists, names this watcher and is not settled.
              const s = await this.w.client.getSwap(ref);
              if (!s || s.watcherAddress !== this.key.publicKey) return send(404, { error: 'not_named' });
              this.watched.set(ref, r.noticeKey);
              const d = deadlinesOf('solana', s);
              send(200, signWatchAck({ chain: 'solana', swapRef: r.swapRef, watchingUntil: Number((d.tNote ?? s.tLock + 3600n) + BigInt(s.dC)), watcherSeed: this.seed }));
            } catch (e) {
              send(400, { error: e instanceof Error ? e.message : String(e) });
            }
          })();
        });
        return;
      }
      send(404, { error: 'not_found' });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** One pass over every watched swap: read it, gather the facts with view data only, do what `watcherStep` says. */
  async step(): Promise<string[]> {
    const done: string[] = [];
    for (const [ref, noticeKey] of this.watched) {
      const swap = await this.w.client.getSwap(ref);
      const now = await this.w.client.chainTime();
      let facts: { noticeOpens?: boolean; lock?: NonNullable<Parameters<typeof watcherStep>[0]['lock']> } = {};
      for (let i = 0; i < 4; i++) {
        const d = watcherStep({ swap, now, watcher: this.key.publicKey, ...facts });
        if (d.do === 'need' && swap) {
          const f = await watcherFacts({ swap, noticeKey, nodes: [xmr.NODE_A, xmr.NODE_B], network: 'regtest' });
          facts = { noticeOpens: f.noticeOpens, ...(f.lock ? { lock: f.lock } : {}) };
          continue;
        }
        if (d.do === 'call' && swap) {
          await this.w.send([this.w.client.program.freeze({ caller: this.key.publicKey, swap: ref, maker: swap.maker })], [this.key]);
          done.push(`watcher: froze ${ref.slice(0, 6)} (${d.why})`);
        } else if (d.do === 'stop') {
          this.watched.delete(ref);
          done.push(`watcher: stopped ${ref.slice(0, 6)} (${d.why})`);
        }
        break;
      }
    }
    return done;
  }
}

/** What the bundle would serve at `/release.json` (deploy's E11): the test stack plays a development snapshot. */
export const TEST_RELEASE = {
  format: 'xmrswap-served/1',
  ui: { tree_hash: 'ab'.repeat(32), files: 5, bytes: 2_900_000 },
  recorded: true,
  release: { version: 'dev-snapshot', status: 'development-snapshot', commit: '0123456789abcdef0123456789abcdef01234567', commit_time: '2026-11-27T18:01:38Z', program_id: DEV_PROGRAM_ID, contract: null, chain_id: null, web_tree_hash: 'ab'.repeat(32), program_executable_hash: 'cd'.repeat(32), program_hash_source: 'local', onchain_deployed: false },
};

export async function serveUi(config: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }> {
  if (!existsSync(path.join(DIST, 'index.html'))) throw new Error('apps/web/dist is missing; run `pnpm --filter @xmrswap/web build`');
  const server = http.createServer(async (req, res) => {
    const p = path.normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
    if (p === 'release.json') {
      res.writeHead(200, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' });
      res.end(JSON.stringify(TEST_RELEASE));
      return;
    }
    if (p === 'config.json') {
      res.writeHead(200, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' });
      res.end(JSON.stringify(config));
      return;
    }
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(Number(process.env.XMRSWAP_WEB_PORT ?? 0), '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

export async function startStack(makers: MakerOpts[] = [{ price: (150n * SOL) / 100n }]): Promise<Stack> {
  await init();
  if (!existsSync(SO)) throw new Error(`${SO} is missing; build it with \`cd solana/program && cargo build-sbf\``);
  // svm-rpc binds a free port chosen by the OS. Now and then that is one of the ports `fetch` and
  // Chromium refuse to talk to ("bad port", e.g. 6000 or 6667): start again on another one.
  let svm = await startSvmRpc({ programs: [{ programId: DEV_PROGRAM_ID, soPath: SO }], unixTimestamp: T0 });
  for (let i = 0; i < 5; i++) {
    try {
      await svm.call('getHealth');
      break;
    } catch (e) {
      if (i === 4 || !/bad port/i.test(String((e as { cause?: unknown }).cause ?? e))) throw e;
      await svm.stop();
      svm = await startSvmRpc({ programs: [{ programId: DEV_PROGRAM_ID, soPath: SO }], unixTimestamp: T0 });
    }
  }
  const transport = connectionTransport(new Connection(svm.url, 'confirmed'), { subscriptions: false });
  const admin = seedSigner(seed(1));
  const taker = seedSigner(seed(5));
  for (const s of [admin, taker]) await svm.airdrop(s.publicKey, 100_000_000_000n);
  await svm.setUpgradeAuthority(DEV_PROGRAM_ID, admin.publicKey);
  const usdc = await svm.createMint(6, admin.publicKey);
  await svm.mintTo(usdc, taker.publicKey, 1_000_000_000_000n);
  const client = new SolanaClient({ transport, programId: DEV_PROGRAM_ID, usdcMint: usdc, subscriptions: false });
  const send = (ixs: TransactionInstruction[], signers: SolanaSigner[]) => client.sendAndConfirm(ixs, signers, { intervalMs: 20 });
  await send([client.program.initialize({ authority: admin.publicKey, usdcMint: usdc, clusterTag: base58Decode(await transport.getGenesisHash()), treasuryAuthority: admin.publicKey, splitMode: 0 })], [admin]);

  // A fresh deployment opens nothing: the switch is on and every cap is zero until the admin sets them.
  const setCaps = async (maxSwap: [bigint, bigint], maxOpen: [bigint, bigint], capsOn = true) => void (await send([client.program.setCaps(admin.publicKey, { capsOn, maxSwap, maxOpen })], [admin]));
  await setCaps([100n * SOL, 100_000_000_000n], [10_000n * SOL, 10_000_000_000_000n]);
  const w = { svm, client, usdc, admin, taker, makers: [] as TestMaker[], url: '' } as Stack;
  w.setCaps = setCaps;
  w.now = () => client.chainTime();
  w.warpTo = async (t) => {
    const now = await client.chainTime();
    if (t > now) await svm.warp(t - now);
  };
  w.warp = async (secs) => void (await svm.warp(secs));
  w.send = send;
  w.refOf = (s) => base58(s.swapRef);
  w.balance = async (pubkey) => (await transport.getAccount(pubkey))?.lamports ?? 0n;
  w.stepMakers = async () => {
    const out: string[] = [];
    for (const m of w.makers) out.push(...(await m.step()));
    return out;
  };

  for (const [i, opts] of makers.entries()) {
    const n = i + 1;
    const [owner, operator, payout] = [10 * n + 1, 10 * n + 2, 10 * n + 3].map((k) => seedSigner(seed(k + 16))) as [SolanaSigner, SolanaSigner, SolanaSigner];
    for (const s of [owner, operator, payout]) await svm.airdrop(s.publicKey, 100_000_000_000n);
    for (const s of [operator, payout]) await svm.mintTo(usdc, s.publicKey, 1_000_000_000_000n);
    const m = new TestMaker(w, n, owner, operator, payout, opts);
    await m.register();
    await m.publish(0, 0, opts.price);
    if (opts.buys) await m.publish(1, 1, 150_000_000n);
    w.makers.push(m);
  }

  w.watcher = new TestWatcher(w);
  await svm.airdrop(w.watcher.key.publicKey, 1_000_000_000n);
  await w.watcher.start();

  const ui = await serveUi({
    solanaRpc: svm.url,
    moneroNodes: [xmr.NODE_A, xmr.NODE_B],
    moneroNetwork: 'regtest',
    programId: DEV_PROGRAM_ID,
    mode: 'onchain',
    pollMs: 700,
    sweepMaxFee: xmr.REGTEST_MAX_FEE.toString(),
    // The release's site name for the wallet-derived key: set by the bundle's config, here by the test.
    walletKeySite: 'xmrswap.test',
    hostedWatcherUrl: w.watcher.url,
  });
  w.url = ui.url;
  w.stop = async () => {
    await ui.close();
    await w.watcher.stop();
    await svm.stop();
  };
  return w;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = `1${out}`;
  }
  return out;
}
