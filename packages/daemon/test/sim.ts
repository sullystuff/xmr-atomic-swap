/**
 * Test doubles for the daemon's unit tests.
 *
 * `SimSolana` puts the program's behaviour behind the SDK's `FakeSolana` transport: every wire
 * transaction the daemon simulates or sends is decoded with the frozen codecs and applied to
 * the swap account with the SDK's reference model (`apply`), so the real `SolanaClient`,
 * instruction builders, flows and executor run unchanged against it. A call the model refuses
 * fails in simulation with the program's own error code, exactly as the program would.
 *
 * `FakeMonero` is the inventory wallet, the node-side broadcaster and the node set in one
 * in-memory chain. It records every relay, so a test can prove how many distinct transactions
 * ever left for a swap.
 */
import { randomBytes } from 'node:crypto';
import { PublicKey, Transaction } from '@solana/web3.js';
import { type DerivedKeys, scalarMatches } from '@xmrswap/core-wasm';
import { ACCOUNT_SIZE, COUNTER_NONE, SWAP_FLAG, SWAP_STATE, DEV_PROGRAM_ID, ERROR_NAMES, type Maker, type Offer, type ProgramErrorName, type Swap, base58Encode, decodeAccount, decodeInstructionData, encodeAccount, errorCode, instructionAccounts } from '@xmrswap/protocol';
import type { MoneroNodeStatus } from '@xmrswap/protocol/daemon-api';
import type { AssetCaps, Config as ChainConfig } from '@xmrswap/protocol';
import { type Call, type Env, type LockState, ModelError, type ModelSwap, NO_SWAP, type Role, type SwapView, type VerifyLockResult, WATCH_ROUTES, XmrSwapProgram, apply, buildNotice, evidenceOpens, type HttpFetch, openNoticeWithKey, openWatchRequest, seedSigner, signWatchAck, solanaOpenKeys, watchDeployment, swapJointAddress, takerSwapKeys, viewFromSolana } from '@xmrswap/sdk';
import { FakeSolana } from '@xmrswap/sdk/testing';
import type { SweepOutcome } from '@xmrswap/core-wasm';
import type { MoneroView, SweepRequest } from '../src/monero/nodes.js';
import { type InventoryWallet, type MoneroBroadcaster, type PreparedTx, type RelayResult, type WalletOutput, WalletError } from '../src/monero/wallet.js';

export const XMR = 1_000_000_000_000n;
export const T0 = 1_800_000_000n;
const fill = (n: number, len = 32) => new Uint8Array(len).fill(n);
const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export interface OpenParams {
  direction: 0 | 1;
  asset?: number;
  xmr: bigint;
  price?: bigint;
  /** Offer mode: 0 auto, 1 window. */
  mode?: number;
  depth?: number;
  depBps?: number;
  wA?: number;
  wN?: number;
  dC?: number;
  wC?: number;
  wF?: number;
  /** Direction A, auto mode: the maker share the offer pool assigned. */
  makerSpendPub?: Uint8Array;
  seed?: Uint8Array;
  nonce?: Uint8Array;
  /** The freeze window of the offer the swap was opened against (`W_z`); 0 = no watcher accepted. */
  wZ?: number;
  /** Direction A: the watcher the taker names (base58). */
  watcher?: string;
  /** Direction B: the payout address (default: the taker's own). */
  payout?: string;
}
const DEFAULT_KEY = '11111111111111111111111111111111';
const ENV: Env = { takerCanReceive: true, makerCanReceive: true, treasuryCanReceive: true, openPending: 0 };
export interface OpenedSwap {
  pda: string;
  keys: DerivedKeys;
  nonce: Uint8Array;
}

export class SimSolana {
  readonly fake = new FakeSolana({ subscriptions: false });
  readonly programId = DEV_PROGRAM_ID;
  readonly usdcMint = new PublicKey(fill(9)).toBase58();
  readonly program = new XmrSwapProgram(this.programId, this.usdcMint);
  readonly owner = seedSigner(fill(2)).publicKey;
  readonly makerPda = this.program.makerPda(this.owner).toBase58();
  readonly taker = seedSigner(fill(5)).publicKey;
  now = T0;
  blockHeight = 0;
  /** Every instruction that landed, in order: `name` (snake_case), its arguments and the swap it touched. */
  readonly landed: { name: string; args: Record<string, unknown>; swap: string | null; at: bigint; stateBefore: number | null }[] = [];
  /** Shared event log across the chain and Monero: tests assert ordering on it. */
  readonly log: string[];
  /** Every claim or refund the daemon BROADCAST (landed or not), with the swap state it met: a spend share is public from here on. */
  readonly secretSends: { name: string; state: number; at: bigint }[] = [];
  /** Make the next `n` sends vanish after broadcast (the transaction never lands). */
  dropSends = 0;
  private nonceCounter = 0;

  constructor(operator: string, encKey: Uint8Array, log: string[] = []) {
    this.log = log;
    this.fake.setClock(this.now);
    const maker: Maker = {
      owner: this.owner, operator, payout: seedSigner(fill(4)).publicKey, encKey, encKeyVersion: 1, prevEncKey: new Uint8Array(32), prevEncKeyExpiresAt: 0n, approvalEpoch: 1, quoteEpoch: 1, paused: 0, inboxPolicy: 0, openPending: 0,
      registeredSlot: 1n, registeredAt: T0, ethLink: new Uint8Array(20), ethLinkNext: new Uint8Array(20), ethLinkNextAt: 0n, counters: new Array(40).fill(0), responseSecsSum: 0n, volume: [0n, 0n], withheldVolume: [0n, 0n], bump: 255, onion: '', contacts: [],
    };
    this.putMaker(maker);
    // As the test harnesses deploy it: the caps switched off (a fresh deployment is `setCaps(true, [0n, 0n], [0n, 0n])`).
    this.putConfig({ admin: seedSigner(fill(1)).publicKey, treasuryAuthority: seedSigner(fill(1)).publicKey, clusterTag: fill(7), usdcMint: this.usdcMint, splitMode: 0, bump: 255, treasuryBump: 255, capsOn: 0, maxSwap: [0n, 0n], maxOpen: [0n, 0n], openValue: [0n, 0n], reserved: new Uint8Array(68) });
    this.fake.setAccount(operator, '11111111111111111111111111111111', new Uint8Array(0), 50_000_000_000n);
    this.fake.onSimulate = (wire) => {
      try {
        this.execute(wire, false);
        return { err: null, logs: [], unitsConsumed: 20_100 };
      } catch (e) {
        if (!(e instanceof SimError)) throw e;
        return { err: { InstructionError: [2, { Custom: e.custom }] }, logs: [`Program log: ${e.name}`], unitsConsumed: 5_000 };
      }
    };
    this.fake.onSend = (wire) => {
      const signature = base58Encode(Transaction.from(wire).signature!);
      if (this.dropSends > 0) {
        this.dropSends--;
        return signature;
      }
      let err: unknown = null;
      try {
        this.execute(wire, true);
      } catch (e) {
        if (!(e instanceof SimError)) throw e;
        err = { InstructionError: [2, { Custom: e.custom }] };
      }
      this.fake.addTransaction({ signature, slot: ++this.blockHeight, blockTime: Number(this.now), err, logs: [], instructions: [] }, []);
      this.newBlockhash();
      return signature;
    };
  }

  // ---------------------------------------------------------------- accounts
  config(): ChainConfig {
    return decodeAccount('Config', this.fake.accounts.get(this.program.config.toBase58())!.data);
  }
  putConfig(c: ChainConfig): void {
    this.fake.setAccount(this.program.config.toBase58(), this.programId, encodeAccount('Config', c, ACCOUNT_SIZE.Config));
  }
  /** The admin's `set_caps` (SPEC 11.1): the global switch and the per-asset caps (0 SOL, 1 USDC). The open value is untouched. */
  setCaps(on: boolean, maxSwap: [bigint, bigint], maxOpen: [bigint, bigint]): void {
    this.putConfig({ ...this.config(), capsOn: on ? 1 : 0, maxSwap, maxOpen });
  }
  caps(asset: number): AssetCaps {
    const c = this.config();
    return { on: c.capsOn !== 0, maxSwap: c.maxSwap[asset]!, maxOpen: c.maxOpen[asset]!, openValue: c.openValue[asset]! };
  }
  /** `freeze_config`: the admin key is gone; caps that are on stay as they are. */
  freezeConfig(): void {
    this.putConfig({ ...this.config(), admin: DEFAULT_KEY });
  }
  maker(): Maker {
    return decodeAccount('Maker', this.fake.accounts.get(this.makerPda)!.data);
  }
  putMaker(m: Maker): void {
    this.fake.setAccount(this.makerPda, this.programId, encodeAccount('Maker', m, ACCOUNT_SIZE.Maker));
  }
  swap(pda: string): Swap | null {
    const a = this.fake.accounts.get(pda);
    return a ? decodeAccount('Swap', a.data) : null;
  }
  putSwap(pda: string, s: Swap): void {
    this.fake.setAccount(pda, this.programId, encodeAccount('Swap', s, ACCOUNT_SIZE.Swap));
  }
  offer(asset: number, direction: number): Offer | null {
    const a = this.fake.accounts.get(this.program.offerPda(this.makerPda, asset, direction).toBase58());
    return a ? decodeAccount('Offer', a.data) : null;
  }
  private putOffer(o: Offer): void {
    this.fake.setAccount(this.program.offerPda(this.makerPda, o.asset, o.direction).toBase58(), this.programId, encodeAccount('Offer', o, ACCOUNT_SIZE.Offer));
  }
  setTime(t: bigint): void {
    if (t > this.now) this.now = t;
    this.fake.setClock(this.now);
    this.newBlockhash();
  }
  /** A cluster's blockhash moves with every slot; here it moves whenever a transaction lands or the clock does. */
  private hashCounter = 0;
  newBlockhash(): void {
    const b = new Uint8Array(32);
    new DataView(b.buffer).setUint32(0, ++this.hashCounter);
    b[31] = 1;
    this.fake.blockhash = base58Encode(b);
  }
  warp(secs: number | bigint): void {
    this.setTime(this.now + BigInt(secs));
  }
  /** Names of the instructions that landed, optionally for one swap. */
  names(swap?: string): string[] {
    return this.landed.filter((l) => !swap || l.swap === swap).map((l) => l.name);
  }

  // ---------------------------------------------------------------- the model applied to an account
  /** The account in the model's shape: addresses reduced to what a transition depends on. */
  private toModel(s: Swap): ModelSwap {
    if (s === (NO_SWAP as unknown as Swap)) return NO_SWAP;
    return { ...(s as unknown as ModelSwap), payout: s.direction === 0 || s.payout === DEFAULT_KEY ? 'none' : s.payout === s.taker ? 'taker' : 'other', watcher: s.watcher !== DEFAULT_KEY };
  }
  private model(s: Swap, call: Call, caller: Role, asset: number = s.asset ?? 0, env: Partial<Env> = {}): ReturnType<typeof apply> {
    try {
      return apply('solana', this.toModel(s), call, caller, this.now, { ...ENV, caps: this.caps(asset), ...env });
    } catch (e) {
      if (e instanceof ModelError) throw new SimError(e.chainName("solana"));
      throw e;
    }
  }
  private commit(pda: string, s: Swap, fx: ReturnType<typeof apply>, extra: Partial<Swap>, name: string, args: Record<string, unknown>): void {
    const stateBefore = s.state;
    // The model keeps no addresses: the payout and the watcher stay as the account (or this call) has them.
    if (fx.closed) this.fake.deleteAccount(pda);
    else this.putSwap(pda, { ...s, ...(fx.swap as unknown as Partial<Swap>), payout: s.payout, watcher: s.watcher, ...extra });
    // The open value of the asset (SPEC 11.1): added by the open, subtracted once by the exit.
    const c = this.config();
    c.openValue[s.asset] = fx.openValueAfter;
    this.putConfig(c);
    const m = this.maker();
    if (fx.counter !== null) m.counters[fx.counter] = (m.counters[fx.counter] ?? 0) + 1;
    m.openPending += fx.openPending;
    this.putMaker(m);
    this.landed.push({ name, args, swap: pda, at: this.now, stateBefore });
    this.log.push(`chain:${name}`);
  }

  /** The taker opens a swap (`lock` in A, `take` in B) with real keys derived from a seed and a fresh nonce. */
  open(p: OpenParams): OpenedSwap {
    const nonce = p.nonce ?? Uint8Array.from({ length: 16 }, (_, i) => (i === 0 ? ++this.nonceCounter : 0x40 + i));
    const pdaKey = this.program.swapPda(this.taker, nonce);
    const pda = pdaKey.toBase58();
    const keys = takerSwapKeys(p.seed ?? fill(42), 'solana', nonce);
    const open = solanaOpenKeys(keys, pdaKey.toBytes());
    const price = p.price ?? 150_000_000n;
    const amount = (p.xmr * price) / XMR;
    const depBps = p.depBps ?? 100;
    const payout = p.direction === 1 ? (p.payout ?? this.taker) : DEFAULT_KEY;
    const fx = this.model(
      NO_SWAP as unknown as Swap,
      { name: p.direction === 0 ? 'lock' : 'take', args: { offerMode: p.mode ?? 0, approval: false, amount, xmr: p.xmr, wA: p.wA ?? 60, wN: p.wN ?? 600, dC: p.dC ?? 3600, wC: p.wC ?? 1800, wF: p.wF ?? 604_800, depth: p.depth ?? 2, depBps, wZ: p.wZ ?? 0, ...(p.direction === 0 ? { watcher: p.watcher !== undefined } : { payout: payout === this.taker ? ('taker' as const) : ('other' as const) }) } },
      'taker',
      p.asset ?? 0,
    );
    const m = this.maker();
    const base: Swap = {
      ...(fx.swap as unknown as Swap),
      taker: this.taker, maker: this.makerPda, asset: p.asset ?? 0, bump: 255, vaultBump: 255, swapNonce: nonce, sessionKey: open.sessionKey, takerEncKey: open.takerEncKey, makerEncVersion: m.encKeyVersion, makerEncKey: m.encKey,
      xmr: p.xmr, price, depBps, takerSpendPub: open.takerSpendPub, makerSpendPub: p.direction === 0 && (p.mode ?? 0) === 0 ? (p.makerSpendPub ?? new Uint8Array(32)) : new Uint8Array(32),
      lockerView: p.direction === 0 ? open.takerView : new Uint8Array(32), noticeCommitment: new Uint8Array(32), noticeCt: new Uint8Array(104), evidenceTxid: new Uint8Array(32), evidenceView: new Uint8Array(32), revealed: new Uint8Array(32), reserved: new Uint8Array(30),
      payout, watcher: p.direction === 0 ? (p.watcher ?? DEFAULT_KEY) : DEFAULT_KEY,
    } as Swap;
    this.commit(pda, base, { ...fx, swap: base as unknown as ModelSwap, closed: false }, {}, p.direction === 0 ? 'lock' : 'take', {});
    return { pda, keys, nonce };
  }

  /** A call by the taker side (wallet or session key), applied directly: the tests play the taker. */
  takerCall(pda: string, call: Call, extra: Partial<Swap> = {}, caller: Role = 'session', env: Partial<Env> = {}): void {
    const s = this.swap(pda);
    if (!s) throw new Error('no such swap');
    this.commit(pda, s, this.model(s, call, caller, s.asset, env), extra, call.name, {});
  }
  /** `freeze` by the watcher the swap names (Z1): the watcher holds no share and moves nothing. */
  watcherFreeze(pda: string): void {
    this.takerCall(pda, { name: 'freeze' }, {}, 'watcher');
  }

  // ---------------------------------------------------------------- transactions from the daemon
  private execute(wire: Uint8Array, land: boolean): void {
    const tx = Transaction.from(wire);
    const operator = this.maker().operator;
    for (const ix of tx.instructions) {
      if (ix.programId.toBase58() !== this.programId) continue;
      const decoded = decodeInstructionData(Uint8Array.from(ix.data));
      if (!decoded) throw new Error('undecodable instruction');
      const args = decoded.args as unknown as Record<string, any>;
      const name = snake(decoded.name);
      const metas = instructionAccounts(decoded.name);
      const account = (n: string): string | null => {
        const i = metas.findIndex((m) => m.name === n);
        return i >= 0 && ix.keys[i] ? ix.keys[i]!.pubkey.toBase58() : null;
      };
      const signer = ix.keys.find((k) => k.isSigner)?.pubkey.toBase58();
      const pda = account('swap');
      const s = pda ? this.swap(pda) : null;
      const role: Role = signer === operator ? 'operator' : signer === this.owner ? 'owner' : s && signer === s.watcher ? 'watcher' : 'anyone';
      if (pda && metas.some((m) => m.name === 'swap')) {
        if (!s) throw new SimError('BadState');
        this.swapCall(pda, s, name, args, role, land);
      } else this.makerCall(name, args, role, land);
    }
  }

  private swapCall(pda: string, s: Swap, name: string, args: Record<string, any>, callerRole: Role, land: boolean): void {
    let role = callerRole;
    let call: Call;
    const extra: Partial<Swap> = {};
    const view = () => ({ ...viewFromSolana(pda, s), noticeCt: s.noticeCt });
    switch (name) {
      case 'approve':
        call = { name: 'approve', openOk: true };
        extra.makerSpendPub = args.makerSpendPub;
        break;
      case 'fund':
        // The maker's watcher is named here (SPEC 11.6); the model refuses one against `w_z` = 0 (`WatcherNotAllowed`).
        call = { name: 'fund', openOk: true, watcher: args.watcher !== null && args.watcher !== undefined };
        extra.makerSpendPub = args.makerSpendPub;
        extra.lockerView = args.makerView;
        if (args.watcher) extra.watcher = args.watcher;
        break;
      case 'withdraw_owed':
        // Claim proceeds parked for a payout address sit in the taker's slot and belong to that address (anyone may deliver them).
        call = { name: 'withdraw_owed', who: args.who === 0 ? (s.direction === 1 && s.payout !== s.taker ? 'payout' : 'taker') : args.who === 1 ? 'maker' : 'treasury' };
        if (call.who === 'payout' && role === 'operator') role = 'anyone';
        break;
      case 'reject':
        call = { name: 'reject', openOk: true, reason: args.reason };
        break;
      case 'post_notice':
        call = { name: 'post_notice' };
        extra.noticeCommitment = args.commitment;
        extra.noticeCt = args.ciphertext;
        break;
      case 'claim':
      case 'refund': {
        const lockerIsTaker = s.direction === 0;
        const ofTaker = (name === 'refund') === lockerIsTaker;
        const ok = scalarMatches(args.secret, ofTaker ? s.takerSpendPub : s.makerSpendPub);
        call = { name, secretOk: ok };
        extra.revealed = args.secret;
        if (land) this.secretSends.push({ name, state: s.state, at: this.now });
        break;
      }
      case 'withhold':
        call = { name: 'withhold', evidence: args.evidence === null ? 'absent' : evidenceOpens(view(), args.evidence.txid, args.evidence.view) ? 'opens' : 'mismatch' };
        if (args.evidence) Object.assign(extra, { evidenceTxid: args.evidence.txid, evidenceView: args.evidence.view });
        break;
      case 'publish_evidence':
        call = { name: 'publish_evidence', opens: evidenceOpens(view(), args.txid, args.view) };
        Object.assign(extra, { evidenceTxid: args.txid, evidenceView: args.view });
        break;
      case 'close_swap':
        // The model does not know `close_swap`: allowed once the swap is settled and nothing is owed.
        if (s.state !== SWAP_STATE.DONE || s.owedTaker !== 0n || s.owedMaker !== 0n) throw new SimError('BadState');
        if (land) {
          this.fake.deleteAccount(pda);
          this.landed.push({ name, args, swap: pda, at: this.now, stateBefore: s.state });
          this.log.push(`chain:${name}`);
        }
        return;
      default:
        call = { name } as Call;
    }
    const fx = this.model(s, call, role);
    if (land) this.commit(pda, s, fx, extra, name, args);
  }

  private makerCall(name: string, args: Record<string, any>, role: Role, land: boolean): void {
    if (role !== 'operator' && role !== 'owner') throw new SimError('Unauthorized');
    if (!land) return;
    const m = this.maker();
    switch (name) {
      case 'set_offer': {
        const prev = this.offer(args.asset, args.direction);
        const t = args.terms;
        this.putOffer({
          maker: this.makerPda, asset: args.asset, direction: args.direction, enabled: prev?.enabled ?? 0, mode: t.mode, bump: 255, seq: (prev?.seq ?? 0n) + 1n, updatedAt: prev?.updatedAt ?? 0n, validSecs: t.validSecs, minXmr: t.minXmr, maxXmr: t.maxXmr, capacityXmr: prev?.capacityXmr ?? 0n,
          priceAbove: t.priceAbove, prices: prev?.prices ?? [0n, 0n, 0n], depthAbove: t.depthAbove, depths: t.depths, depBps: t.depBps, wA: t.wA, wN: t.wN, dC: t.dC, wC: t.wC, wF: t.wF, termsHash: new Uint8Array(32),
          poolFilled: prev?.poolFilled ?? 0, poolUsed: prev?.poolUsed ?? 0, pool: prev?.pool ?? Array.from({ length: 16 }, () => new Uint8Array(32)), wZ: t.wZ, reserved: new Uint8Array(30),
        });
        break;
      }
      case 'refill_keys': {
        const o = this.offer(args.asset, 0);
        if (!o) throw new SimError('BadState');
        for (const slot of args.slots) {
          o.pool[slot.index] = slot.share;
          o.poolFilled |= 1 << slot.index;
          o.poolUsed &= ~(1 << slot.index);
        }
        this.putOffer(o);
        break;
      }
      case 'refresh_offers':
        for (const r of args.offers) {
          const o = this.offer(r.asset, r.direction);
          if (!o) throw new SimError('BadState');
          this.putOffer({ ...o, enabled: r.enabled ? 1 : 0, prices: r.prices, capacityXmr: r.capacityXmr, updatedAt: this.now, seq: o.seq + 1n });
        }
        break;
      case 'rotate_enc_key':
        this.putMaker({ ...m, prevEncKey: m.encKey, prevEncKeyExpiresAt: args.prevExpiresAt, encKey: args.newKey, encKeyVersion: m.encKeyVersion + 1 });
        break;
      case 'set_paused':
        this.putMaker({ ...m, paused: args.paused ? m.paused | (role === 'owner' ? 1 : 2) : m.paused & ~(role === 'owner' ? 1 : 2) });
        break;
      case 'bump_epochs':
        this.putMaker({ ...m, approvalEpoch: m.approvalEpoch + (args.approvals ? 1 : 0), quoteEpoch: m.quoteEpoch + (args.quotes ? 1 : 0) });
        break;
      case 'set_onion':
        this.putMaker({ ...m, onion: args.onion });
        break;
      case 'set_contacts':
        this.putMaker({ ...m, contacts: args.contacts });
        break;
      case 'set_inbox_policy':
        this.putMaker({ ...m, inboxPolicy: args.policy });
        break;
      default:
        break;
    }
    this.landed.push({ name, args, swap: null, at: this.now, stateBefore: null });
    this.log.push(`chain:${name}`);
  }

  /** Mark a pool key as taken by a lock (what `lock` does on-chain in auto mode) and return it. */
  takePoolKey(asset: number): Uint8Array {
    const o = this.offer(asset, 0);
    if (!o) throw new Error('no offer');
    const free = Array.from({ length: 16 }, (_, i) => i).find((i) => (o.poolFilled >> i) & 1 && !((o.poolUsed >> i) & 1));
    if (free === undefined) throw new Error('the key pool is empty');
    o.poolUsed |= 1 << free;
    this.putOffer(o);
    return o.pool[free]!;
  }
}

export class SimError extends Error {
  readonly custom: number;
  constructor(readonly code: string) {
    super(code);
    this.name = code;
    this.custom = (ERROR_NAMES as readonly string[]).includes(code) ? errorCode(code as ProgramErrorName) : 6_999;
  }
}

// ---------------------------------------------------------------------------------------------- Monero

interface FakeTxRecord {
  txid: string;
  txHex: string;
  inputs: string[];
  destinations: { address: string; amount: bigint }[];
  relayed: number;
  /** Chain height it was mined at; `null` = not relayed or still in the pool. */
  minedAt: number | null;
  kind: 'wallet' | 'external' | 'sweep';
}

export class FakeMonero implements InventoryWallet, MoneroBroadcaster, MoneroView {
  readonly network = 'regtest' as const;
  readonly walletAddress = '4'.padEnd(95, 'A');
  tip = 200;
  async height(): Promise<number> {
    return this.tip;
  }
  readonly outs: WalletOutput[] = [];
  readonly txs = new Map<string, FakeTxRecord>();
  /** Every accepted relay, in order. */
  readonly relays: string[] = [];
  /** Every sweep that was BUILT (a rebuilt sweep has another txid; only one can ever be relayed). */
  readonly sweepsBuilt: string[] = [];
  /** Fail verification as an unreachable node would. */
  down = false;
  /** As wallet2 may: spend every unfrozen unlocked output it holds, not only what the amount needs. */
  greedy = false;
  /** Called at the start of each build, after the daemon's freeze pass: the instant an output can still slip in. */
  beforePrepare: (() => void) | null = null;
  /** Make the nodes refuse every relay with this reason (not a double spend). */
  refuseRelay: string | null = null;
  /** When set, every `verify` waits for it: a slow node, so a pass over a swap stays in flight. */
  verifyGate: Promise<void> | null = null;
  verifying = 0;
  private spentInputs = new Map<string, string>();
  private counter = 0;

  constructor(readonly log: string[] = []) {}

  /** Give the wallet an output, unlocked by default. */
  addOutput(amount: bigint, opts: { unlocked?: boolean; frozen?: boolean } = {}): string {
    const keyImage = `${(++this.counter).toString(16).padStart(8, '0')}${'ee'.repeat(28)}`;
    this.outs.push({ keyImage, amount, blockHeight: opts.unlocked === false ? this.tip - 1 : this.tip - 20, unlocked: opts.unlocked !== false, frozen: opts.frozen ?? false, spent: false, txid: 'ff'.repeat(32) });
    return keyImage;
  }
  /** Mine `n` blocks: pool transactions are mined into the first one. */
  mine(n: number): void {
    for (const t of this.txs.values()) if (t.relayed > 0 && t.minedAt === null) t.minedAt = this.tip;
    this.tip += n;
    for (const o of this.outs) if (o.blockHeight !== null && this.tip - o.blockHeight >= 10) o.unlocked = true;
  }
  /** A payment from somebody else's wallet (the taker's lock in direction B). */
  external(address: string, amount: bigint): string {
    const txid = randomBytes(32).toString('hex');
    this.txs.set(txid, { txid, txHex: txid, inputs: [], destinations: [{ address, amount }], relayed: 1, minedAt: null, kind: 'external' });
    return txid;
  }
  /** Drop a transaction out of the chain and the pool (a reorg the other node did not re-mine). */
  orphan(txid: string): void {
    const t = this.txs.get(txid);
    if (!t) throw new Error('unknown tx');
    t.relayed = 0;
    t.minedAt = null;
    for (const k of t.inputs) {
      this.spentInputs.delete(k);
      const o = this.outs.find((x) => x.keyImage === k);
      if (o) o.spent = false;
    }
  }
  relaysOf(kind: FakeTxRecord['kind'], address?: string): string[] {
    return [...new Set(this.relays)].filter((id) => this.txs.get(id)?.kind === kind && (!address || this.txs.get(id)!.destinations.some((d) => d.address === address)));
  }

  // ---- InventoryWallet
  async address(): Promise<string> {
    return this.walletAddress;
  }
  async refresh(): Promise<void> {}
  async outputs(): Promise<WalletOutput[]> {
    return this.outs.filter((o) => !o.spent).map((o) => ({ ...o }));
  }
  async freeze(keyImage: string): Promise<void> {
    const o = this.outs.find((x) => x.keyImage === keyImage);
    if (o) o.frozen = true;
  }
  async thaw(keyImage: string): Promise<void> {
    const o = this.outs.find((x) => x.keyImage === keyImage);
    if (o) o.frozen = false;
  }
  async prepare(destinations: { address: string; amount: bigint }[]): Promise<PreparedTx> {
    const hook = this.beforePrepare;
    this.beforePrepare = null;
    hook?.();
    const fee = 100_000_000n;
    const need = destinations.reduce((a, d) => a + d.amount, 0n) + fee;
    const usable = this.outs.filter((o) => !o.frozen && !o.spent && o.unlocked).sort((a, b) => (a.amount < b.amount ? -1 : 1));
    const inputs: WalletOutput[] = [];
    let sum = 0n;
    for (const o of usable) {
      if (sum >= need && !this.greedy) break;
      inputs.push(o);
      sum += o.amount;
    }
    if (sum < need) throw new WalletError('not_enough', 'not enough unlocked money');
    const txid = randomBytes(32).toString('hex');
    const txHex = randomBytes(64).toString('hex');
    this.txs.set(txid, { txid, txHex, inputs: inputs.map((i) => i.keyImage), destinations, relayed: 0, minedAt: null, kind: 'wallet' });
    return { txid, txHex, fee, keyImages: inputs.map((i) => i.keyImage) };
  }

  // ---- MoneroBroadcaster
  async sendRaw(txHex: string): Promise<RelayResult> {
    const t = [...this.txs.values()].find((x) => x.txHex === txHex);
    if (!t) return { ok: false, reason: 'unparseable' };
    if (this.refuseRelay) return { ok: false, reason: this.refuseRelay };
    if (t.relayed > 0) return { ok: false, reason: 'already in the pool or the chain' };
    if (t.inputs.some((k) => this.spentInputs.has(k) && this.spentInputs.get(k) !== t.txid)) return { ok: false, reason: 'double spend', doubleSpend: true };
    t.relayed++;
    this.relays.push(t.txid);
    this.log.push(`xmr:relay:${t.kind}`);
    for (const k of t.inputs) {
      this.spentInputs.set(k, t.txid);
      const o = this.outs.find((x) => x.keyImage === k);
      if (o) o.spent = true;
    }
    // What comes back to the wallet: change, split outputs and sweeps arrive as new, locked outputs.
    for (const d of t.destinations) if (d.address === this.walletAddress) this.outs.push({ keyImage: `${(++this.counter).toString(16).padStart(8, '0')}${'dd'.repeat(28)}`, amount: d.amount, blockHeight: this.tip, unlocked: false, frozen: false, spent: false, txid: t.txid });
    return { ok: true };
  }
  async keyImagesSpent(keyImages: string[]): Promise<boolean[]> {
    return (await this.keyImageStatus(keyImages)).map((x) => x === 1);
  }
  async keyImageStatus(keyImages: string[]): Promise<number[]> {
    if (this.down) throw new Error('connection refused');
    return keyImages.map((k) => {
      const by = this.spentInputs.get(k);
      return by === undefined ? 0 : this.txs.get(by)?.minedAt != null ? 1 : 2;
    });
  }

  // ---- MoneroView
  async verify(a: { txid: string; minAmount: bigint; minConf: number }): Promise<VerifyLockResult> {
    if (this.down) throw new Error('connection refused');
    this.verifying++;
    try {
      if (this.verifyGate) await this.verifyGate;
    } finally {
      this.verifying--;
    }
    const t = this.txs.get(a.txid);
    const base = { reasons: [] as string[], codes: [] as never[], nodes: [] as never[], outputs: [] as never[] };
    if (!t || t.relayed === 0) return { ...base, ok: false, state: 'not-found' as LockState, confirmations: 0 } as unknown as VerifyLockResult;
    const amount = t.destinations[0]!.amount;
    if (amount < a.minAmount) return { ...base, ok: false, state: 'invalid' as LockState, confirmations: 0, amount } as unknown as VerifyLockResult;
    const confirmations = t.minedAt === null ? 0 : this.tip - t.minedAt;
    const state: LockState = t.minedAt === null ? 'pending' : confirmations >= a.minConf ? 'confirmed' : 'confirming';
    return { ...base, ok: state === 'confirmed', state, confirmations, amount, outputIndex: 0, ...(t.minedAt !== null ? { blockHeight: t.minedAt } : {}) } as unknown as VerifyLockResult;
  }
  async buildSweep(p: SweepRequest): Promise<SweepOutcome> {
    const lock = this.txs.get(Buffer.from(p.lockTxid).toString('hex'));
    if (!lock) throw new Error('no such lock');
    const fee = 50_000_000n;
    const txid = randomBytes(32).toString('hex');
    const txHex = randomBytes(64).toString('hex');
    const amount = lock.destinations[0]!.amount - fee;
    this.txs.set(txid, { txid, txHex, inputs: [`lock:${lock.txid}`], destinations: [{ address: p.destination, amount }], relayed: 0, minedAt: null, kind: 'sweep' });
    this.sweepsBuilt.push(txid);
    return { jointAddress: lock.destinations[0]!.address, txid, amount, fee, txHex, published: false, ignored: [] };
  }
  async txKnown(txid: string): Promise<boolean> {
    return (this.txs.get(txid)?.relayed ?? 0) > 0;
  }
  async status(): Promise<{ nodes: MoneroNodeStatus[]; agree: boolean }> {
    return { nodes: [{ label: 'fake-a', ok: !this.down, height: this.tip, top_hash: 'aa' }, { label: 'fake-b', ok: !this.down, height: this.tip, top_hash: 'aa' }], agree: !this.down };
  }
}

// ---------------------------------------------------------------------------------------------- the maker's watcher

/**
 * A watcher service (SPEC 11.6) behind an `HttpFetch`: the three routes, the real sealing and
 * acknowledgement signatures of the SDK, and the one thing a watcher does (`act`): pause a
 * swap whose notice does not open or whose lock is not confirmed at the cutoff. It holds one
 * key and the notice keys it was given; nothing else.
 */
export class FakeWatcher {
  readonly seed: Uint8Array;
  readonly solana: string;
  readonly ethereum = `0x${'c5'.repeat(20)}`;
  /** Refuse connections, as a machine that is down. */
  down = false;
  /** Sign acknowledgements with another key (an impersonated service). */
  wrongKey = false;
  /** What the acknowledgement promises; default: an hour past the request. */
  watchingUntil: ((now: bigint) => bigint) | null = null;
  readonly requests: { method: string; path: string }[] = [];
  /** Notice keys by swap reference (hex). */
  readonly keys = new Map<string, Uint8Array>();
  readonly froze: string[] = [];
  /** Requests that did not verify, by the SDK's error code. */
  readonly refused: string[] = [];

  constructor(private readonly sim: SimSolana, seedByte = 0x77) {
    this.seed = fill(seedByte);
    this.solana = seedSigner(this.seed).publicKey;
  }

  readonly fetch: HttpFetch = async (url, init) => {
    if (this.down) throw new Error('connect ECONNREFUSED');
    const path = new URL(url).pathname;
    this.requests.push({ method: init.method, path });
    const json = (status: number, body: unknown) => ({ status, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
    if (init.method === 'GET' && path === WATCH_ROUTES.info) return json(200, { solana: this.solana, ethereum: this.ethereum, max_swaps: 100, monero_nodes: 2 });
    if (init.method === 'POST' && path === WATCH_ROUTES.swaps) {
      // The service finds the swap the request names first, then verifies the request against it: only the swap's locker can have made it.
      const body = JSON.parse(String(init.body)) as { swap_ref: string };
      const pda = new PublicKey(Buffer.from(body.swap_ref, 'hex')).toBase58();
      const swap = this.sim.swap(pda);
      if (!swap) return json(404, { error: 'no_such_swap' });
      let req;
      try {
        req = openWatchRequest(body, { watcherSeed: this.seed, swap: viewFromSolana(pda, swap), deployment: watchDeployment({ programId: this.sim.programId }), now: this.sim.now });
      } catch (e) {
        this.refused.push((e as { code?: string }).code ?? (e as Error).message);
        return json(403, { error: (e as { code?: string }).code ?? 'refused' });
      }
      // Accepted only if the swap exists, names this watcher and is not settled.
      if (!swap || swap.watcher !== this.solana || swap.state === SWAP_STATE.DONE) return json(409, { error: 'not_watchable' });
      this.keys.set(pda, req.noticeKey);
      const until = this.watchingUntil ? this.watchingUntil(this.sim.now) : this.sim.now + 3_600n + BigInt(swap.dC);
      return json(200, signWatchAck({ chain: 'solana', swapRef: req.swapRef, watchingUntil: until, watcherSeed: this.wrongKey ? fill(0x66) : this.seed }));
    }
    return json(404, { error: 'not_found' });
  };

  /** One pass of the watcher: freeze every watched swap whose notice is false, or whose lock is not confirmed at the cutoff. Never after `T_co − M`. */
  async act(xmr: FakeMonero): Promise<string[]> {
    const out: string[] = [];
    for (const [pda, key] of this.keys) {
      const s = this.sim.swap(pda);
      if (!s || s.state !== SWAP_STATE.NOTICED) continue;
      const view = viewFromSolana(pda, s);
      const now = this.sim.now;
      if (now > s.tClaimOpen - 60n) continue;
      const opened = openNoticeWithKey(view, key);
      let bad = opened === null;
      if (opened && now >= s.tCut) bad = (await xmr.verify({ txid: Buffer.from(opened.txid).toString('hex'), minAmount: s.xmr, minConf: s.depth })).state !== 'confirmed';
      if (!bad) continue;
      this.sim.watcherFreeze(pda);
      this.froze.push(pda);
      out.push(pda);
    }
    return out;
  }
}

/** The swap view of a sim account, for building notices and joint addresses as the taker. */
export function viewOf(sim: SimSolana, pda: string): SwapView {
  return viewFromSolana(pda, sim.swap(pda)!);
}
export { buildNotice, swapJointAddress, COUNTER_NONE };
