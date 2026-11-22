// The whole system on loopback: both chains, the Monero regtest (started once by global setup),
// one or more real maker daemons, the real relay behind a fake Tor, and the built web UI.
// A scenario file builds one world, runs its scenarios against it, and tears it down.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { init } from '@xmrswap/core-wasm';
import { type EthWorld, type SolWorld, startEthereum, startSolana } from './chains.js';
import { Maker, type MakerOpts, type PriceServer, startPriceServer } from './maker.js';
import { NODE_A, NODE_B, type NodeProxy, REGTEST_MAX_FEE, WALLET_RPC_MAKER, Wallet, mine, startNodeProxy, startWalletRpc, tip } from './monero.js';
import { type Proc, stopAll } from './procs.js';
import { type FakeTor, type RelayProc, makeRelay, startFakeTor, testOnion } from './relay.js';
import { type UiServer, closeBrowser, serveWeb } from './ui.js';
import { fill, freePort, hexOf, stateRoot, waitFor } from './util.js';

/** The taker's own Monero wallet lives in its own wallet-rpc so it stays open while the makers' wallets are in use. */
export const WALLET_RPC_TAKER_PORT = 48093;
const EXTRA_MAKER_WALLET_PORTS = [48094, 48095];

export interface WorldOpts {
  makers?: Partial<Omit<MakerOpts, 'n' | 'walletRpcUrl' | 'moneroNodes' | 'priceUrl' | 'onion'>>[];
  ethereum?: boolean;
  /** Coinbase outputs mined to each maker's inventory wallet. */
  inventoryBlocks?: number;
  /** UI connection mode; `self-hosted` (through the relay) unless a scenario says otherwise. */
  uiMode?: 'self-hosted' | 'onchain';
}

export interface World {
  sol: SolWorld;
  eth: EthWorld | null;
  makers: Maker[];
  maker: Maker;
  prices: PriceServer;
  tor: FakeTor;
  relay: RelayProc;
  ui: UiServer;
  /** The second Monero node as the UI sees it, and as the daemons see it: each can be made to lie or vanish. */
  uiNodeB: NodeProxy;
  makerNodeB: NodeProxy;
  /** The taker's own Monero wallet: pays in direction B, receives sweeps, and collects the block rewards. */
  takerWallet: Wallet;
  takerXmr: string;
  /** The taker's recovery seed when a scenario drives the taker through the SDK instead of the browser. */
  takerSeed: Uint8Array;
  /** Move both chains' clocks forward. Nothing in the suite sleeps to reach a deadline. */
  advance(secs: number | bigint): Promise<void>;
  /** Mine Monero blocks (to the taker's wallet) and wait until both nodes agree. */
  mine(n: number): Promise<number>;
  /** Secrets that must never appear in any log, by name. Scenarios add their per-swap secrets. */
  secrets: Map<string, string>;
  addSecret(name: string, value: Uint8Array | string): void;
  /** Search every log this run wrote for every registered secret. Returns the hits (empty = clean). */
  leakedSecrets(): string[];
  stop(): Promise<void>;
}

let walletRpcTaker: { url: string; proc: Proc } | null = null;
const extraWalletRpcs: { url: string; proc: Proc }[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(log|out)$/.test(f)) out.push(p);
  }
  return out;
}

export async function startWorld(o: WorldOpts = {}): Promise<World> {
  await init();
  const height = (await tip(NODE_A)).height;
  walletRpcTaker ??= await startWalletRpc('taker', WALLET_RPC_TAKER_PORT);
  const takerWallet = new Wallet(walletRpcTaker.url, 'e2e-taker');
  const takerXmr = await takerWallet.open();
  // Decoy selection fails on a short chain: at least 720 blocks before any sweep.
  if (height < 730) await mine(730 - height, takerXmr);

  const sol = await startSolana();
  const eth = o.ethereum === false ? null : await startEthereum();
  const prices = await startPriceServer();
  const tor = await startFakeTor();
  const uiNodeB = await startNodeProxy(NODE_B);
  const makerNodeB = await startNodeProxy(NODE_B);
  const uiPort = await freePort();
  const uiOrigin = `http://127.0.0.1:${uiPort}`;

  const makers: Maker[] = [];
  const specs = o.makers ?? [{}];
  for (const [i, spec] of specs.entries()) {
    const n = i + 1;
    let walletRpcUrl = WALLET_RPC_MAKER;
    if (i > 0) {
      extraWalletRpcs[i - 1] ??= await startWalletRpc(`maker-${n}`, EXTRA_MAKER_WALLET_PORTS[i - 1]!);
      walletRpcUrl = extraWalletRpcs[i - 1]!.url;
    }
    const m = new Maker({ ...spec, n, walletRpcUrl, moneroNodes: [NODE_A, makerNodeB.url], priceUrl: prices.url, onion: testOnion(n), ...(o.ethereum === false ? { ethereum: false } : {}) }, sol, eth);
    await m.prepare(o.inventoryBlocks ?? 24, mine, takerXmr);
    makers.push(m);
  }
  // Start every daemon, register it the way a maker would, and wait for live offers.
  for (const m of makers) {
    await m.start();
    tor.map.set(m.o.onion, m.endpointPort);
    await m.register();
  }
  // A world is ready when every maker has a live offer on-chain (its inventory is synced and its first refresh has landed).
  for (const m of makers)
    await waitFor(`maker ${m.o.n}'s first live offer`, async () => {
      const now = await sol.now();
      for (const asset of [0, 1]) for (const direction of [0, 1]) {
        const o = await sol.client.getOffer(m.makerPda, asset, direction);
        if (o && o.enabled === 1 && now < o.updatedAt + BigInt(o.validSecs)) return true;
      }
      return false;
    }, { timeoutMs: 300_000, intervalMs: 1000, context: async () => (await m.status()).alerts.map((a) => a.message) });
  const relay = await makeRelay({ solanaRpc: sol.url, programId: sol.client.programId, torPort: tor.port, moneroNodes: [NODE_A, NODE_B], allowedOrigins: [uiOrigin] });
  await relay.start();
  const ui = await serveWeb(uiPort, {
    solanaRpc: sol.url, ...(eth ? { ethereumRpc: eth.url, ethereumChainId: 31337, contract: eth.contract } : {}), moneroNodes: [NODE_A, uiNodeB.url], moneroNetwork: 'regtest',
    programId: sol.client.programId, relayUrl: relay.url, mode: o.uiMode ?? 'self-hosted', pollMs: 700, sweepMaxFee: REGTEST_MAX_FEE.toString(),
  });

  const secrets = new Map<string, string>();
  const takerSeed = fill(44);
  const w: World = {
    sol, eth, makers, maker: makers[0]!, prices, tor, relay, ui, uiNodeB, makerNodeB, takerWallet, takerXmr, takerSeed, secrets,
    async advance(secs) {
      await sol.warp(secs);
      if (eth) await eth.advance(secs);
    },
    mine: (n) => mine(n, takerXmr),
    addSecret(name, value) {
      const v = typeof value === 'string' ? value : hexOf(value);
      if (v.length >= 16) secrets.set(name, v);
    },
    leakedSecrets() {
      for (const m of makers) for (const [k, v] of Object.entries(m.secrets())) secrets.set(k, v);
      const hits: string[] = [];
      for (const file of walk(stateRoot)) {
        const body = readFileSync(file, 'utf8');
        const lower = body.toLowerCase();
        for (const [name, value] of secrets) if (lower.includes(value.toLowerCase())) hits.push(`${name} in ${path.relative(stateRoot, file)}`);
      }
      return hits;
    },
    async stop() {
      await ui.close().catch(() => undefined);
      await relay.stop().catch(() => undefined);
      for (const m of makers) await m.stop().catch(() => undefined);
      for (const m of makers) await m.wallet.call('close_wallet').catch(() => undefined);
      await tor.close().catch(() => undefined);
      await prices.close().catch(() => undefined);
      await uiNodeB.close().catch(() => undefined);
      await makerNodeB.close().catch(() => undefined);
      await sol.stop().catch(() => undefined);
      await eth?.stop().catch(() => undefined);
    },
  };
  w.addSecret('taker.seed', takerSeed);
  w.addSecret('taker.solKey', fill(5));
  w.addSecret('taker.ethKey', fill(14));
  return w;
}

/** Stop everything this process started that outlives a world (wallet-rpcs, the browser). */
export async function stopShared(): Promise<void> {
  await closeBrowser().catch(() => undefined);
  walletRpcTaker = null;
  extraWalletRpcs.length = 0;
  await stopAll();
}
