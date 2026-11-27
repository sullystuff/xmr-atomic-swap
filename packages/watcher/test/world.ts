// A world for the unit tests: the watcher service over the SDK's fakes (`@xmrswap/sdk/testing`).
// The Solana fake holds real `Swap` accounts (the frozen codec) and plays the program's `freeze`
// row; the Ethereum fake plays the contract's. The Monero nodes are in memory and serve the
// recorded lock of `interfaces/vectors/monero_tx.json`, so `verifyLock` runs for real.
// Nothing here opens a socket except the service's own loopback HTTP server.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@solana/web3.js';
import { ACCOUNT_SIZE, type ChainName, IXmrSwapAbi, PROGRAM_ID, SWAP_FLAG, SWAP_STATE, type Swap, base58Encode, decodeInstructionData, encodeAccount, errorCode } from '@xmrswap/protocol';
import { type Bytes, type EthSwapStruct, type EthTransport, type SwapView, buildNotice, hex, hex0x, init, noticeKey, unhex } from '@xmrswap/sdk';
import { FakeEthereum, FakeMoneroNode, FakeRevert, FakeSolana, type FakeTx } from '@xmrswap/sdk/testing';
import { type Abi, decodeFunctionData, keccak256, parseTransaction } from 'viem';
import { type ChainPort, EthereumChain, SolanaChain } from '../src/chains.js';
import { WatcherKeys } from '../src/keys.js';
import { type LogSink, createLogger } from '../src/log.js';
import { type FaultPoint, type ServiceSettings, Watcher } from '../src/service.js';
import { Store } from '../src/store.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const vector = (name: string): any => JSON.parse(readFileSync(path.join(repoRoot, 'interfaces/vectors', `${name}.json`), 'utf8'));

export const ready = init();
const m = vector('monero_tx');
const n = vector('notice');
const dust = m.cases.find((c: any) => c.name === 'dust-in-the-lock-block');
/** Height of the recorded lock's block. */
export const LOCK_HEIGHT = 162;
export const LOCK_TX: FakeTx = { txid: dust.input.txs[0].txid, hex: dust.input.txs[0].tx_hex, prunedHex: dust.input.txs[0].pruned_hex, prunableHash: dust.input.txs[0].prunable_hash, blockHeight: LOCK_HEIGHT };
export const XMR_AMOUNT = BigInt(dust.input.min_amount);
/** The four halves of the recorded lock. The spend **secrets** are here only so tests can prove the watcher never holds them. */
export const HALVES = m.keys as { maker: { spend: string; spend_pub: string; view: string }; taker: { spend: string; spend_pub: string; view: string }; joint: { address: string; spend_priv: string } };
export const ENC = n.keys as { taker_secret: string; taker_pub: string; maker_secret: string; maker_pub: string };

/** A Monero node that has the lock with `conf` confirmations (or other transactions, or none). */
export const node = (name: string, conf: number, txs: FakeTx[] = [LOCK_TX]): FakeMoneroNode => new FakeMoneroNode(name, LOCK_HEIGHT + conf, txs);

export const T0 = 1_800_000_000n;
/** Deadlines of the test swaps, by chain (the margin `M` is 300 s on Solana and 1,800 s on Ethereum). */
export const TIMES = {
  solana: { tNoteDeadline: T0 + 600n, tNotice: T0 + 90n, tCut: T0 + 2_805n, tCo: T0 + 5_490n, tFinal: T0 + 604_800n, dC: 5_400, margin: 300n },
  ethereum: { tNoteDeadline: T0 + 1_820n, tNotice: T0 + 120n, tCut: T0 + 4_020n, tCo: T0 + 10_920n, tFinal: T0 + 604_800n, dC: 10_800, margin: 1_800n },
} as const;

export const SOLANA_SEED = new Uint8Array(32).fill(0x51);
export const ETHEREUM_KEY = new Uint8Array(32).fill(0x52);
export const testKeys = (): WatcherKeys => new WatcherKeys(SOLANA_SEED, ETHEREUM_KEY);
export const CONTRACT = '0x00000000000000000000000000000000000c0de1' as const;
const SYSTEM = '11111111111111111111111111111111';
const z = (len: number): Uint8Array => new Uint8Array(len);
let counter = 0;
export const randomRef = (): Bytes => {
  const b = new Uint8Array(32).fill(0x70);
  new DataView(b.buffer).setUint32(0, ++counter);
  b[31] = 1;
  return b;
};

export type NoticeKind = 'none' | 'good' | 'no-such-tx' | 'garbage';
export interface SwapSpec {
  ref?: Bytes;
  /** Who the swap names: default this watcher. `null` = nobody. */
  watcher?: string | null;
  wZ?: number;
  notice?: NoticeKind;
  state?: number;
  direction?: 0 | 1;
}

export interface SentFreeze {
  swapRef: string;
  /** Function or instruction names in the transaction, in order. */
  calls: string[];
  id: string;
}

export interface World {
  chain: ChainName;
  keys: WatcherKeys;
  port: ChainPort;
  dir: string;
  nodes: FakeMoneroNode[];
  times: (typeof TIMES)[ChainName];
  setTime(t: bigint): void;
  setBalance(v: bigint): void;
  /** Put a swap on the fake chain. Returns its reference and the locker's notice key. */
  addSwap(spec?: SwapSpec): Promise<{ ref: Bytes; noticeKey: Bytes; view: () => Promise<SwapView> }>;
  /** Post (or replace) the notice of a swap already on chain, moving it to NOTICED. */
  postNotice(ref: Bytes, kind: Exclude<NoticeKind, 'none'>): Promise<void>;
  setState(ref: Bytes, state: number): void;
  /** Overwrite fields of the swap as the endpoint reports it (chain-native field names). */
  patch(ref: Bytes, patch: Record<string, unknown>): void;
  removeSwap(ref: Bytes): void;
  chainState(ref: Bytes): Promise<number | null>;
  /** Behaviour of the fake endpoint. */
  net: { broadcastFails: boolean; lands: boolean; readsFail: boolean; baseFee: bigint; simUnits: number; simRefuses: boolean; chainIdAnswer: bigint; gasEstimate: bigint; pendingNonce: number | null };
  /** The exact bytes handed to the endpoint for broadcast. */
  rawBroadcasts: Uint8Array[];
  /** Every transaction the endpoint was handed for broadcast, decoded. */
  broadcasts: SentFreeze[];
  /** Every transaction the endpoint was asked to simulate or broadcast, as raw bytes. */
  signedOrSimulated(): { calls: string[] }[];
  store(): Store;
  /** A service over this world's fakes and (by default) a fresh database in `dir`. */
  service(o?: { store?: Store; settings?: Partial<ServiceSettings>; fault?: (p: FaultPoint) => void; logSink?: LogSink; debug?: boolean; nodes?: FakeMoneroNode[]; ownNode?: boolean }): Watcher;
  clock: { ms: number };
}

export const SETTINGS: ServiceSettings = {
  maxSwaps: 50,
  maxKeysPerSwap: 4,
  retentionDays: 30,
  stopConfirmations: 2,
  minLeadSecs: 120,
  attemptTimeoutSecs: 150,
  limits: { solana: { perSwap: 100_000n, perDay: 5_000_000n }, ethereum: { perSwap: 30_000_000_000_000_000n, perDay: 300_000_000_000_000_000n } },
};

const ABI = IXmrSwapAbi as unknown as Abi;

function decodeSolana(wire: Uint8Array): { calls: string[]; swap: string; payer: string; sig: string } {
  const tx = Transaction.from(wire);
  const calls = tx.instructions.map((ix) => (ix.programId.toBase58() === PROGRAM_ID ? (decodeInstructionData(new Uint8Array(ix.data))?.name ?? 'unknown-program-instruction') : ix.programId.toBase58() === 'ComputeBudget111111111111111111111111111111' ? 'compute-budget' : `other:${ix.programId.toBase58()}`));
  const freeze = tx.instructions.find((ix) => ix.programId.toBase58() === PROGRAM_ID);
  return { calls, swap: freeze?.keys[1]?.pubkey.toBase58() ?? '', payer: tx.feePayer?.toBase58() ?? '', sig: tx.signature ? base58Encode(new Uint8Array(tx.signature)) : '' };
}

export async function makeWorld(chain: ChainName): Promise<World> {
  await ready;
  const keys = testKeys();
  const dir = mkdtempSync(path.join(tmpdir(), 'xmrswap-watcher-test-'));
  const times = TIMES[chain];
  const nodes = [node('a', 12), node('b', 12)];
  const net = { broadcastFails: false, lands: true, readsFail: false, baseFee: 10_000_000_000n, simUnits: 21_000, simRefuses: false, chainIdAnswer: 31337n, gasEstimate: 100_000n, pendingNonce: null as number | null };
  const rawBroadcasts: Uint8Array[] = [];
  const broadcasts: SentFreeze[] = [];
  const clock = { ms: 1_800_000_000_000 };
  let now = T0;
  let port: ChainPort;
  let setTime: (t: bigint) => void;
  let setBalance: (v: bigint) => void;
  let write: (ref: Bytes, patch: Record<string, unknown>) => void;
  let create: (ref: Bytes, spec: SwapSpec) => void;
  let removeSwap: (ref: Bytes) => void;
  let signedOrSimulated: () => { calls: string[] }[];

  if (chain === 'solana') {
    const fake = new FakeSolana({ subscriptions: false });
    const swaps = new Map<string, Swap>();
    const maker = base58Encode(new Uint8Array(32).fill(0x33));
    const put = (pda: string): void => fake.setAccount(pda, PROGRAM_ID, encodeAccount('Swap', swaps.get(pda)!, ACCOUNT_SIZE.Swap));
    const guard = <T>(f: T): T => {
      if (net.readsFail) throw new Error('connect ECONNREFUSED 127.0.0.1');
      return f;
    };
    const getAccount = fake.getAccount.bind(fake);
    fake.getAccount = async (p: string) => guard(await getAccount(p));
    fake.onSimulate = (wire) => {
      const d = decodeSolana(wire);
      const s = swaps.get(d.swap);
      const bad = (name: 'BadState' | 'Unauthorized' | 'TooLate') => ({ err: { InstructionError: [2, { Custom: errorCode(name) }] }, logs: [], unitsConsumed: 0 });
      if (net.simRefuses || !s || s.state !== SWAP_STATE.NOTICED) return bad('BadState');
      if (s.watcher !== d.payer) return bad('Unauthorized');
      if (now >= s.tClaimOpen) return bad('TooLate');
      return { err: null, logs: [], unitsConsumed: net.simUnits };
    };
    fake.onSend = (wire) => {
      if (net.broadcastFails) throw new Error('fetch failed: connect ECONNREFUSED');
      const d = decodeSolana(wire);
      rawBroadcasts.push(wire);
      broadcasts.push({ swapRef: d.swap, calls: d.calls, id: d.sig });
      const s = swaps.get(d.swap);
      if (net.lands && !fake.transactions.has(d.sig)) {
        const ok = !!s && s.state === SWAP_STATE.NOTICED && s.watcher === d.payer && now < s.tClaimOpen;
        if (ok) {
          swaps.set(d.swap, { ...s!, state: SWAP_STATE.FROZEN, tFreeze: now });
          put(d.swap);
        }
        fake.transactions.set(d.sig, { signature: d.sig, slot: 1, blockTime: Number(now), err: ok ? null : { InstructionError: [2, { Custom: errorCode('BadState') }] }, logs: [], instructions: [] });
      }
      return d.sig;
    };
    port = new SolanaChain(fake, { programId: PROGRAM_ID, genesisHash: null, commitment: 'finalized', priorityFeeMicroLamports: 1_000n, maxComputeUnits: 200_000, perSwapLimit: 0n, perDayLimit: 0n }, keys);
    setTime = (t) => {
      now = t;
      fake.setClock(t);
    };
    setBalance = (v) => fake.setAccount(keys.solana, SYSTEM, z(0), v);
    create = (ref, spec) => {
      const pda = base58Encode(ref);
      const watcher = spec.watcher === undefined ? keys.solana : (spec.watcher ?? SYSTEM);
      swaps.set(pda, {
        taker: base58Encode(new Uint8Array(32).fill(0x31)), maker, state: spec.state ?? SWAP_STATE.ACTIVE, direction: spec.direction ?? 0, asset: 0, mode: 0, outcome: 255, depositState: 0, depth: 10, flags: 0, bump: 254, vaultBump: 0,
        swapNonce: z(16), sessionKey: base58Encode(new Uint8Array(32).fill(0x32)), takerEncKey: unhex(ENC.taker_pub), makerEncVersion: 1, makerEncKey: unhex(ENC.maker_pub), amount: 1_500_000_000n, deposit: 15_000_000n, xmr: XMR_AMOUNT,
        price: 150_000_000n, depBps: 100, feeBps: 5, wN: 600, dC: times.dC, wC: 1800, takerSpendPub: unhex(HALVES.taker.spend_pub), makerSpendPub: unhex(HALVES.maker.spend_pub), lockerView: unhex(HALVES.taker.view),
        noticeCommitment: z(32), noticeCt: z(104), evidenceTxid: z(32), evidenceView: z(32), revealed: z(32), tLock: T0, tPendingDeadline: 0n, tActive: T0, tNoteDeadline: times.tNoteDeadline, tNotice: 0n, tCut: 0n, tClaimOpen: 0n, tReady: 0n,
        tClaimDeadline: 0n, tFinal: times.tFinal, tRefund: 0n, tSettled: 0n, owedTaker: 0n, owedMaker: 0n, owedTreasury: 0n, payout: SYSTEM, watcher, wZ: spec.wZ ?? 86_400, tFreeze: 0n, reserved: z(30),
      });
      put(pda);
    };
    write = (ref, patch) => {
      const pda = base58Encode(ref);
      const p = { ...patch } as Record<string, unknown>;
      if ('notice' in p) {
        const nt = p['notice'] as { commitment: Bytes; ciphertext: Bytes };
        delete p['notice'];
        Object.assign(p, { noticeCommitment: nt.commitment, noticeCt: nt.ciphertext, flags: SWAP_FLAG.NOTICE, tNotice: times.tNotice, tCut: times.tCut, tClaimOpen: times.tCo });
      }
      swaps.set(pda, { ...swaps.get(pda)!, ...(p as Partial<Swap>) });
      put(pda);
    };
    removeSwap = (ref) => {
      swaps.delete(base58Encode(ref));
      fake.deleteAccount(base58Encode(ref));
    };
    signedOrSimulated = () => [...fake.simulated, ...fake.sent].map((w) => ({ calls: decodeSolana(w).calls }));
  } else {
    const fake = new FakeEthereum(CONTRACT);
    const structs = new Map<string, EthSwapStruct>();
    const zero32 = `0x${'00'.repeat(32)}`;
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    let balance = 0n;
    const raws: `0x${string}`[] = [];
    fake.views['getSwap'] = ([id]) => structs.get(String(id).toLowerCase()) ?? { ...template(), state: 0 };
    fake.views['freeze'] = ([id], ctx) => {
      const s = structs.get(String(id).toLowerCase());
      if (net.simRefuses || !s || s.state !== SWAP_STATE.NOTICED) throw new FakeRevert('BadState');
      if (s.watcher.toLowerCase() !== ctx.from?.toLowerCase()) throw new FakeRevert('Unauthorized');
      if (now >= s.tClaimOpen) throw new FakeRevert('TooLate');
      return undefined;
    };
    const template = (): EthSwapStruct => ({
      taker: '0x0f8183aefdf068dd8489b6edbf4e07965cf29246', maker: '0x0fbfe9b14731dddd51b145d6b23104e8bf7f676b', token: zeroAddr, sessionKey: '0x00000000000000000000000000000000000000aa', swapNonce: `0x${'12'.repeat(16)}`,
      state: SWAP_STATE.ACTIVE, direction: 0, mode: 0, outcome: 255, depositState: 0, depth: 10, flags: 0, depBps: 100, makerEncVersion: 1, xmr: XMR_AMOUNT, amount: 121n * 10n ** 15n, deposit: 121n * 10n ** 13n, price: 605n * 10n ** 14n,
      noticeWindow: 1800, claimDelay: times.dC, claimWindow: 5400, takerKey: '0x08f5cbc4564871f0ca60c9a36f99baadcbfea448', takerKey2: '0xa19f0f910d085afdfc10f9dd276097a093ddae40', takerSpendPub: hex0x(unhex(HALVES.taker.spend_pub)),
      makerKey: '0x63fd156b26116a5a48ed7a292c96ce424c5f658b', makerKey2: '0x89c9348ff65ef528eac0648f8ed07c332f14cdaa', makerSpendPub: hex0x(unhex(HALVES.maker.spend_pub)), lockerView: hex0x(unhex(HALVES.taker.view)),
      takerEncKey: hex0x(unhex(ENC.taker_pub)), makerEncKey: hex0x(unhex(ENC.maker_pub)), noticeCommitment: zero32, noticeCiphertext: '0x', evidenceTxid: zero32, evidenceView: zero32, keyLeaf: zero32, openHash: zero32, revealed: 0n,
      tLock: T0, tPendingDeadline: 0n, tActive: T0, tNoteDeadline: times.tNoteDeadline, tNotice: 0n, tCut: 0n, tClaimOpen: 0n, tReady: 0n, tClaimDeadline: 0n, tFinal: times.tFinal, tRefund: 0n, tSettled: 0n,
      payout: zeroAddr, watcher: zeroAddr, freezeSecs: 0, tFreeze: 0n,
    });
    const transport: EthTransport = {
      async request(a) {
        if (net.readsFail && a.method !== 'eth_sendRawTransaction') throw new Error('connect ECONNREFUSED 127.0.0.1');
        if (a.method === 'eth_getBalance') return `0x${balance.toString(16)}`;
        if (a.method === 'eth_sendRawTransaction') {
          const raw = a.params![0] as `0x${string}`;
          raws.push(raw);
          if (net.broadcastFails) throw new Error('fetch failed: connect ECONNREFUSED');
          const id = keccak256(raw);
          const tx = parseTransaction(raw);
          const fn = decodeFunctionData({ abi: ABI, data: tx.data! });
          const ref = String(fn.args![0]).toLowerCase();
          rawBroadcasts.push(Uint8Array.from(Buffer.from(raw.slice(2), 'hex')));
          broadcasts.push({ swapRef: ref.slice(2), calls: [fn.functionName], id });
          await fake.request(a);
          const from = keys.ethereum;
          const used = fake.nonces.get(from) ?? 0;
          if (net.lands && !fake.receipts.has(id) && tx.nonce === used) {
            const s = structs.get(ref);
            const ok = !!s && s.state === SWAP_STATE.NOTICED && s.watcher.toLowerCase() === from && now < s.tClaimOpen;
            if (ok) structs.set(ref, { ...s!, state: SWAP_STATE.FROZEN, tFreeze: now });
            fake.receipts.set(id, { blockNumber: '0x1', blockHash: zero32 as `0x${string}`, status: ok ? '0x1' : '0x0' });
            fake.nonces.set(from, used + 1);
          }
          return id;
        }
        fake.baseFeePerGas = net.baseFee;
        fake.chainId = net.chainIdAnswer;
        fake.gasEstimate = net.gasEstimate;
        if (a.method === 'eth_getTransactionCount' && net.pendingNonce !== null) return `0x${net.pendingNonce.toString(16)}`;
        return fake.request(a);
      },
    };
    port = new EthereumChain(transport, { contract: CONTRACT, chainId: 31337, readTag: 'finalized', maxFeePerGas: 100_000_000_000n, priorityFeePerGas: 1_000_000_000n, perSwapLimit: 0n, perDayLimit: 0n }, keys);
    setTime = (t) => {
      now = t;
      for (const h of [fake.finalized, fake.latest]) fake.blocks.set(h, { ...fake.block(h), timestamp: t });
    };
    setBalance = (v) => void (balance = v);
    create = (ref, spec) => {
      const watcher = spec.watcher === undefined ? keys.ethereum : (spec.watcher ?? zeroAddr);
      structs.set(hex0x(ref), { ...template(), state: spec.state ?? SWAP_STATE.ACTIVE, direction: spec.direction ?? 0, watcher, freezeSecs: spec.wZ ?? 86_400 });
    };
    write = (ref, patch) => {
      const p = { ...patch } as Record<string, unknown>;
      if ('notice' in p) {
        const nt = p['notice'] as { commitment: Bytes; ciphertext: Bytes };
        delete p['notice'];
        Object.assign(p, { noticeCommitment: hex0x(nt.commitment), noticeCiphertext: hex0x(nt.ciphertext), flags: SWAP_FLAG.NOTICE, tNotice: times.tNotice, tCut: times.tCut, tClaimOpen: times.tCo });
      }
      structs.set(hex0x(ref), { ...structs.get(hex0x(ref))!, ...(p as Partial<EthSwapStruct>) });
    };
    removeSwap = (ref) => void structs.delete(hex0x(ref));
    signedOrSimulated = () => [
      ...raws.map((r) => ({ calls: [decodeFunctionData({ abi: ABI, data: parseTransaction(r).data! }).functionName] })),
      ...fake.requests.filter((r) => r.method === 'eth_call' && (r.params![0] as { from?: string }).from).map((r) => ({ calls: [decodeFunctionData({ abi: ABI, data: (r.params![0] as { data: `0x${string}` }).data }).functionName] })),
    ];
  }
  setTime(T0 + 10n);
  setBalance(chain === 'solana' ? 1_000_000_000n : 10n ** 18n);

  const view = async (ref: Bytes): Promise<SwapView> => (await port.readSwap(ref))!;
  async function postNotice(ref: Bytes, kind: Exclude<NoticeKind, 'none'>): Promise<void> {
    const s = await view(ref);
    // The claimer (direction A: the maker) seals the notice with its own encryption secret.
    const claimerSecret = unhex(s.direction === 0 ? ENC.maker_secret : ENC.taker_secret);
    const claimerView = unhex(s.direction === 0 ? HALVES.maker.view : HALVES.taker.view);
    const txid = kind === 'no-such-tx' ? new Uint8Array(32).fill(0xfa) : unhex(LOCK_TX.txid);
    const notice = buildNotice(s, claimerSecret, txid, claimerView);
    if (kind === 'garbage') notice.ciphertext = new Uint8Array(104).fill(0xee);
    write(ref, { notice, state: SWAP_STATE.NOTICED });
  }

  const w: World = {
    chain, keys, port, dir, nodes, times, net, broadcasts, rawBroadcasts, clock,
    setTime: (t) => setTime(t),
    setBalance: (v) => setBalance(v),
    async addSwap(spec = {}) {
      const ref = spec.ref ?? randomRef();
      create(ref, spec);
      if (spec.direction === 1) write(ref, chain === 'solana' ? { lockerView: unhex(HALVES.maker.view) } : { lockerView: hex0x(unhex(HALVES.maker.view)) });
      if (spec.notice && spec.notice !== 'none') await postNotice(ref, spec.notice);
      if (spec.state !== undefined) write(ref, { state: spec.state });
      const s = await view(ref);
      // The locker's notice key: computable at lock time, before any notice exists.
      return { ref, noticeKey: noticeKey(s, unhex(s.direction === 0 ? ENC.taker_secret : ENC.maker_secret)), view: () => view(ref) };
    },
    postNotice,
    setState: (ref, state) => write(ref, { state }),
    patch: (ref, patch) => write(ref, patch),
    removeSwap: (ref) => removeSwap(ref),
    chainState: async (ref) => (await port.readSwap(ref))?.state ?? null,
    signedOrSimulated: () => signedOrSimulated(),
    store: () => new Store(path.join(dir, 'watcher.sqlite'), { solana: keys.solana, ethereum: keys.ethereum }),
    service(o = {}) {
      return new Watcher({
        settings: { ...SETTINGS, ...o.settings },
        store: o.store ?? w.store(),
        keys,
        chains: { [chain]: port },
        monero: { nodes: o.nodes ?? nodes, ownNode: o.ownNode ?? false, network: 'regtest' },
        logger: createLogger(o.debug ?? false, o.logSink ?? (() => {})),
        nowMs: () => clock.ms,
        ...(o.fault ? { fault: o.fault } : {}),
      });
    },
  };
  return w;
}

/** A simulated process death: thrown from a fault hook, it leaves the journal exactly as a kill would. */
export class Crash extends Error {
  readonly crash = true;
  constructor(readonly point: FaultPoint) {
    super(`crash at ${point}`);
  }
}
export const crashAt = (point: FaultPoint): ((p: FaultPoint) => void) => {
  let fired = false;
  return (p) => {
    if (p === point && !fired) {
      fired = true;
      throw new Crash(point);
    }
  };
};

/** Run passes until nothing changes on a quiet chain (bounded). */
export async function passes(svc: Watcher, count: number, w: World, stepMs = 61_000): Promise<void> {
  for (let i = 0; i < count; i++) {
    await svc.tick();
    w.clock.ms += stepMs;
  }
}
export { hex, unhex };
