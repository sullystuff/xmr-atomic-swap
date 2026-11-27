// Shared by `test/chains.test.ts` (the acceptance command: real program in svm-rpc, real
// contract on anvil, Monero nodes in memory) and by `test/integration/*.test.ts` (the same with
// real XMR on the Monero regtest). The chain worlds are the SDK's own integration harness
// (packages/sdk/test/integration), reused as it is; the swaps are opened the way the SDK's
// integration tests open them. The watcher under test is the real service, started from a
// configuration file's worth of settings and reached over loopback HTTP.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import type { DerivedKeys, EthQuote } from '@xmrswap/core-wasm';
import { type Address, PROGRAM_ID, base58Decode } from '@xmrswap/protocol';
import { privateKeyToAccount } from 'viem/accounts';
import { ethSessionBudget } from '../../../sdk/src/ethereum/client.js';
import { buildNotice, newSwapNonce, solanaMakerShare, takerSwapKeys } from '../../../sdk/src/flows/keys.js';
import { makerStep } from '../../../sdk/src/flows/maker.js';
import { planEthereumOpen, planSolanaOpen } from '../../../sdk/src/flows/open.js';
import type { SwapView } from '../../../sdk/src/machine/view.js';
import { fetchPool, fetchProof, leafArgument, pickLeaf, uploadOwnProof } from '../../../sdk/src/messages/blobs.js';
import type { MoneroNode } from '../../../sdk/src/monero/rpc.js';
import { priceEthQuote, priceOffer } from '../../../sdk/src/registry/pricing.js';
import { signEthQuote } from '../../../sdk/src/signing/eip712.js';
import { seedSigner } from '../../../sdk/src/solana/client.js';
import { hex, hex0x, unhex } from '../../../sdk/src/util.js';
import { ETH_NATIVE, type EthWorld, fundForGas } from '../../../sdk/test/integration/eth.js';
import { type SolWorld, XMR as X } from '../../../sdk/test/integration/sol.js';
import { loadConfig } from '../../src/config.js';
import { type RunOptions, type Running, startWatcher } from '../../src/run.js';

export { X };
export const PRICE = 150_000_000n;
/** One hour on Solana. A day on Ethereum: its claim delay is two hours, so a shorter window frozen at T_cut would end before T_co. */
export const FREEZE_WINDOW = { solana: 3_600, ethereum: 86_400 } as const;
export const PASSPHRASE = 'integration test passphrase';

// ------------------------------------------------------------------ the service

export interface ServiceOptions extends Partial<RunOptions> {
  sol?: SolWorld;
  eth?: EthWorld;
  /** Monero node URLs for the configuration (the regtest's two daemons), or in-memory nodes. */
  nodeUrls?: string[];
  nodes?: MoneroNode[];
  /** Reuse a data directory: a restart. */
  dataDir?: string;
}

/** Start the real service against the given worlds. Its loop is driven by the test (`pass`), so every step is deterministic. */
export async function startService(o: ServiceOptions): Promise<Running & { dataDir: string; pass(times?: number): Promise<void> }> {
  const dataDir = o.dataDir ?? mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-it-'));
  const env: Record<string, string> = {};
  let toml = `bind = "127.0.0.1:0"\ndata_dir = ${JSON.stringify(dataDir)}\nnetwork = "regtest"\nstop_confirmations = 2\n[monero]\nnodes = ${JSON.stringify(o.nodeUrls ?? ['http://127.0.0.1:1', 'http://127.0.0.1:2'])}\n`;
  if (o.sol) {
    env['SOLANA_RPC_URL'] = o.sol.svm.url;
    toml += `[solana]\nprogram_id = "${PROGRAM_ID}"\ngenesis_hash = "${o.sol.genesis}"\npriority_fee_micro_lamports = 100\n`;
  }
  if (o.eth) {
    env['ETHEREUM_RPC_URL'] = o.eth.url;
    toml += `[ethereum]\ncontract = "${o.eth.contract}"\nchain_id = 31337\n`;
  }
  for (const u of Object.values(env)) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error(`test endpoints are loopback only, not ${u}`);
  const config = loadConfig({ toml, env });
  const { sol, eth, nodeUrls: _u, nodes, dataDir: _d, ...run } = o;
  const running = await startWatcher(config, { passphrase: PASSPHRASE, loop: false, logSink: () => {}, ...(nodes ? { moneroNodes: nodes } : {}), ...run });
  // The watcher's two keys hold a fee balance and nothing else.
  if (sol && (await sol.balance(running.keys.solana)) === 0n) await sol.svm.airdrop(running.keys.solana, 50_000_000n);
  if (eth && (await eth.balance(running.keys.ethereum)) === 0n) await fundForGas(eth, running.keys.ethereum);
  return {
    ...running,
    dataDir,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        // The Ethereum side is read at `finalized`: let the head move past what just happened.
        if (eth) await eth.finalize();
        await running.watcher.tick();
      }
    },
  };
}

// ------------------------------------------------------------------ Solana swaps

export const TAKER_SEED = new Uint8Array(32).fill(61);

/** The live offer of a market, refreshed if the tests warped past its validity. */
export async function liveOffer(w: SolWorld, asset: number, direction: number) {
  let offer = (await w.client.getOffer(w.makerPda, asset, direction))!;
  if ((await w.now()) > offer.updatedAt + BigInt(offer.validSecs) - 30n) {
    await w.send([w.client.program.refreshOffers(w.operator.publicKey, w.makerPda, [{ asset, direction, enabled: true, prices: [offer.prices[0]!, 0n, 0n], capacityXmr: 1000n * X }])], [w.operator]);
    offer = (await w.client.getOffer(w.makerPda, asset, direction))!;
  }
  return offer;
}

/** Open a SOL swap against the live offer; direction A names `watcher` in the lock. */
export async function solOpen(w: SolWorld, direction: 0 | 1, xmrAmount: bigint, watcher?: string) {
  const maker = await w.maker();
  const offer = await liveOffer(w, 0, direction);
  const caps = await w.client.getCaps(0);
  const plan = planSolanaOpen({ program: w.client.program, taker: w.taker.publicKey, makerPda: w.makerPda, maker, seed: TAKER_SEED, xmr: xmrAmount, source: { offer }, rentExemptMinimum: w.rent0, caps, ...(watcher ? { watcher } : {}) });
  await w.send(plan.instructions, [w.taker]);
  const s = (await w.swap(plan.swapPda))!;
  return { plan, s, session: seedSigner(plan.keys.sessionSecret), pricing: priceOffer(offer, xmrAmount), share: direction === 0 ? w.shares.get(hex(s.makerSpendPub))! : null };
}

/** Direction B: the maker funds a pending take with a fresh share, naming its watcher. */
export async function solFund(w: SolWorld, s: SwapView, watcher?: string): Promise<{ s: SwapView; share: DerivedKeys }> {
  const share = w.newShare();
  const d = makerStep({ swap: s, now: await w.now(), approval: { approve: true } });
  if (d.do !== 'call' || d.call.name !== 'fund') throw new Error('the maker flow did not ask to fund');
  await w.exec(s, d, {}, { makerShare: { ...solanaMakerShare(share, base58Decode(w.makerPda)), spendPub: share.spendPub, view: share.view }, ...(watcher ? { watcher } : {}) });
  return { s: (await w.swap(new PublicKey(s.swapRef).toBase58()))!, share };
}

/** Direction A, maker side: post a notice for `txid` (real or not). */
export async function solNotice(w: SolWorld, s: SwapView, share: DerivedKeys, txid: Uint8Array): Promise<SwapView> {
  const d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
  if (d.do !== 'call' || d.call.name !== 'post_notice') throw new Error('the maker flow did not ask to post a notice');
  await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, txid, share.view) });
  return (await w.swap(new PublicKey(s.swapRef).toBase58()))!;
}

// ------------------------------------------------------------------ Ethereum swaps

const zero20 = new Uint8Array(20);
let quoteCounter = 900n;
export const ETH_BUDGET = ethSessionBudget(5_000_000_000n);
export const ETH_TAKER_SEED = new Uint8Array(32).fill(62);
const lower = (a: { address: string }): Address => a.address.toLowerCase() as Address;

/** An ETH quote with a freeze window, signed by the maker's operator key. */
export async function ethQuote(w: EthWorld, direction: 0 | 1): Promise<{ q: EthQuote; sig: Uint8Array }> {
  const m = await w.maker();
  const q: EthQuote = {
    maker: unhex(lower(w.owner)), taker: zero20, token: unhex(ETH_NATIVE), approvalMode: 0, minXmr: X / 100n, maxXmr: 1000n * X, tierXmr: [0n, 0n, 0n], tierPrice: [60_000_000_000_000_000n, 0n, 0n], depthXmr: [0n, 0n, 0n], depth: [2, 0, 0],
    depositBps: 100, approvalWindow: 600, noticeWindow: 1800, claimDelay: 7200, claimWindow: 5400, finalWindow: 604_800, validUntil: (await w.now()) + 170n, epoch: m.quoteEpoch,
    keyRoot: direction === 0 ? w.newPool(2) : new Uint8Array(32), quoteId: ++quoteCounter, freezeWindow: FREEZE_WINDOW.ethereum, direction,
  };
  return { q, sig: await signEthQuote(w.operatorKey, w.deployment, q) };
}

/** A direction-A lock of ETH naming `watcher`, approved by the maker. Returns the active swap. */
export async function ethLock(w: EthWorld, xmrAmount: bigint, watcher: Address) {
  const { q, sig } = await ethQuote(w, 0);
  const pool = await fetchPool(w.http, q.keyRoot);
  const leaf = await pickLeaf(pool, { isKeyUsed: (k) => w.client.isKeyUsed(lower(w.owner), k, 'latest') });
  const swapNonce = newSwapNonce();
  const keys = takerSwapKeys(ETH_TAKER_SEED, 'ethereum', swapNonce);
  await fetchProof(w.http, { spendPub: leaf.spendPub, keyAddr: leaf.key, keyAddr2: leaf.key2 }, [keys.spendPub]);
  await uploadOwnProof(w.http, keys.spend);
  const caps = await w.client.capsOf(ETH_NATIVE, 'latest');
  const plan = planEthereumOpen({ contract: w.client.contract, taker: lower(w.taker), quote: q, sig, maker: { encKeyVersion: 1, encKey: w.makerEnc.encPub }, seed: ETH_TAKER_SEED, swapNonce, xmr: xmrAmount, leaf: leafArgument(pool, leaf), sessionBudget: ETH_BUDGET, caps, watcher });
  await w.send(plan.call, w.taker);
  const pending = (await w.swap(plan.swapId))!;
  const d = makerStep({ swap: pending, now: await w.now(), takerProofOk: true, approval: { approve: true } });
  if (d.do !== 'call' || d.call.name !== 'approve') throw new Error('the maker flow did not ask to approve');
  await w.exec(pending, d, {});
  const s = (await w.swap(plan.swapId))!;
  return { plan, s, session: privateKeyToAccount(hex0x(plan.keys.sessionSecret)), pricing: priceEthQuote(q, xmrAmount), share: w.shares.get(hex(s.makerSpendPub))! };
}

export async function ethNotice(w: EthWorld, s: SwapView, share: DerivedKeys, txid: Uint8Array): Promise<SwapView> {
  const d = makerStep({ swap: s, now: await w.now(), commitmentsOk: true, lockTx: 'prepared' });
  if (d.do !== 'call' || d.call.name !== 'post_notice') throw new Error('the maker flow did not ask to post a notice');
  await w.exec(s, d, {}, { notice: buildNotice(s, w.makerEnc.encSecret, txid, share.view) });
  return (await w.swap(s.swapRef))!;
}

/** The error code of a refused transaction, or `accepted`. */
export async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : `other: ${(e as Error).message}`;
  }
  return 'accepted';
}
