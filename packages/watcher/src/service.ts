/**
 * The watcher (SPEC 11.6): accept a watch, follow the swap, and freeze when and only when the
 * SDK's pure `watcherStep` says so. "And nothing else."
 *
 * Per pass and per watched swap: read the swap and the chain clock at finality; ask
 * `watcherStep`; when it needs facts, open the notice with the stored notice key and verify the
 * Monero lock view-only under the node policy (`watcherFacts`); then do what it says. The
 * decision to freeze, and every transaction built for it, is written to the journal before
 * anything is broadcast, so a restart at any point continues without guessing: a journaled
 * transaction is looked up and rebroadcast byte for byte, never rebuilt while it may still land.
 *
 * The chain accepts one freeze per swap, so "exactly once" on chain is the chain's guarantee;
 * the journal's job is that the service pays for one.
 */
import type { Network } from '@xmrswap/core-wasm';
import { type ChainName, SWAP_STATE } from '@xmrswap/protocol';
import { type Bytes, type MoneroNode, type SwapView, type WatchAck, type WatcherDecision, type verifyLock, asNode, deadlinesOf, endedInClaim, hex, parseWatchRequest, unhex, watcherFacts, watcherStep } from '@xmrswap/sdk';
import { type ChainPort, FeeAboveLimit, FreezeRefused } from './chains.js';
import type { WatcherKeys } from './keys.js';
import { type Logger, errorClass } from './log.js';
import { type AttemptRow, type Store, type WatchRow } from './store.js';

export interface ServiceSettings {
  maxSwaps: number;
  retentionDays: number;
  stopConfirmations: number;
  minLeadSecs: number;
  attemptTimeoutSecs: number;
  /** Freshness of a watch request: how old its authenticated `issued_at` may be, and how far ahead of the chain clock (or behind the swap's lock) it may lie. */
  requestMaxAgeSecs: number;
  requestClockSkewSecs: number;
  /** Spend limits per chain, in lamports and wei. */
  limits: Partial<Record<ChainName, { perSwap: bigint; perDay: bigint }>>;
}

/** Where a test may stop the process to prove the journal carries it across a restart. Each is reached right after the named write. */
export type FaultPoint = 'after-decision' | 'after-attempt-journal' | 'after-broadcast' | 'before-terminal';

export interface WatcherDeps {
  settings: ServiceSettings;
  store: Store;
  keys: WatcherKeys;
  chains: Partial<Record<ChainName, ChainPort>>;
  /** `verify` replaces the SDK's `verifyLock` in tests that have no Monero chain; the service never sets it. */
  monero: { nodes: (string | MoneroNode)[]; ownNode: boolean; network: Network; verify?: typeof verifyLock };
  logger: Logger;
  /** Wall clock in milliseconds: backoff, retention and the day of a spend only. Deadlines use chain time. */
  nowMs?: () => number;
  fault?: (point: FaultPoint) => void;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** A spend limit stands in the way of a freeze. Nothing was broadcast. */
export class SpendLimit extends Error {
  constructor(readonly code: 'per-swap-limit' | 'per-day-limit') {
    super(`the ${code} would be exceeded`);
    this.name = 'SpendLimit';
  }
}

const refuse = (status: number, error: string, detail?: string): Reply => ({ status, body: detail ? { error, detail } : { error } });
const MAX_BACKOFF_MS = 60_000;
const DAY_MS = 86_400_000;

export class Watcher {
  private readonly s: ServiceSettings;
  private readonly store: Store;
  private readonly keys: WatcherKeys;
  private readonly chains: Partial<Record<ChainName, ChainPort>>;
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly fault: (point: FaultPoint) => void;
  private readonly nodes: MoneroNode[];
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private healthCache: { at: number; value: Record<string, unknown> } | null = null;

  constructor(private readonly deps: WatcherDeps) {
    this.s = deps.settings;
    this.store = deps.store;
    this.keys = deps.keys;
    this.chains = deps.chains;
    this.logger = deps.logger;
    this.nowMs = deps.nowMs ?? Date.now;
    this.fault = deps.fault ?? (() => {});
    this.nodes = deps.monero.nodes.map(asNode);
  }

  // ---------------------------------------------------------------- GET /watch/v1/info

  info(): Record<string, unknown> {
    return { solana: this.keys.solana, ethereum: this.keys.ethereum, max_swaps: this.s.maxSwaps, monero_nodes: this.nodes.length, chains: Object.keys(this.chains) };
  }

  // ---------------------------------------------------------------- POST /watch/v1/swaps

  private names(swap: SwapView, port: ChainPort): boolean {
    if (swap.watcherAddress === null || swap.wZ === 0) return false;
    return swap.chain === 'ethereum' ? swap.watcherAddress.toLowerCase() === port.address.toLowerCase() : swap.watcherAddress === port.address;
  }

  /**
   * Accept a watch. A request is believed for what it proves, never for who delivers it: the
   * swap must exist at finality, name this watcher and still be open, and the request must
   * open under the **locker's encryption key recorded in that swap** (wire format 2), bound to
   * this watcher, chain, deployment, swap and a fresh `issued_at`. So only the swap's locker can
   * register it; a stranger's or the counterparty's request is refused with nothing stored and
   * nothing spent. The signed acknowledgement is returned only after the watch is on disk.
   */
  async register(body: unknown): Promise<Reply> {
    // The public fields first: enough to find the swap, and to refuse garbage before any endpoint is asked.
    let parsed: { chain: ChainName; swapRef: Bytes; deployment: string };
    try {
      parsed = parseWatchRequest(body);
    } catch (e) {
      const code = errorClass(e);
      if (code === 'WatchFormatUnsupported') return refuse(400, 'unsupported_format', 'this watcher accepts watch request format 2 only (authenticated by the locker); update the client');
      return refuse(400, code === 'WatchKeyInvalid' ? 'bad_notice_key' : 'bad_request');
    }
    const port = this.chains[parsed.chain];
    if (!port) return refuse(400, 'chain_not_served', `this watcher does not serve ${parsed.chain}`);
    if (parsed.deployment !== port.deployment) return refuse(400, 'wrong_deployment', 'the request is bound to another program or contract than this watcher serves');
    const refHex = hex(parsed.swapRef);
    let swap: SwapView | null;
    let now: bigint;
    try {
      [swap, now] = await Promise.all([port.readSwap(parsed.swapRef), port.now()]);
    } catch {
      return refuse(503, 'chain_unavailable', `the watcher cannot read ${parsed.chain} right now`);
    }
    // One answer for "no such swap" and "a swap that does not name this watcher": nothing is spent on either.
    if (!swap || swap.chain !== parsed.chain || hex(swap.swapRef) !== refHex || !this.names(swap, port)) return refuse(404, 'not_watchable', 'no swap at finality names this watcher under that reference');

    // Who is asking: the seal opens only with the locker's key from the swap just read.
    let req: { chain: ChainName; swapRef: Bytes; noticeKey: Bytes; issuedAt: bigint };
    try {
      req = this.keys.verifyRequest(body, { swap, deployment: port.deployment, now, maxAgeSecs: this.s.requestMaxAgeSecs, clockSkewSecs: this.s.requestClockSkewSecs });
    } catch (e) {
      const code = errorClass(e);
      if (code === 'WatchRequestStale') return refuse(400, 'stale_request', 'issued_at is older than the swap, too old, or ahead of the chain clock; make a new request');
      if (code === 'WatchWrongDeployment') return refuse(400, 'wrong_deployment', 'the request is bound to another program or contract than this watcher serves');
      return refuse(403, 'not_the_locker', 'the request was not made by this swap\'s locker for this watcher and swap');
    }

    const d = watcherStep({ swap, now, watcher: port.address });
    if (d.do === 'stop') {
      if (d.why === 'too-late') return refuse(409, 'too_late', 'the freeze window of this swap has closed');
      if (d.why === 'no-swap' || d.why === 'not-named') return refuse(404, 'not_watchable', 'no swap at finality names this watcher under that reference');
      return refuse(409, 'swap_ended', `nothing is left to watch (${d.why})`);
    }
    const dl = deadlinesOf(swap.chain, swap);
    if (swap.state === SWAP_STATE.NOTICED && now + BigInt(this.s.minLeadSecs) > dl.tCo! - dl.margin) return refuse(409, 'too_late', 'too little of the freeze window is left to promise anything');

    const existing = this.store.getWatch(req.chain, refHex);
    if (existing && existing.terminal_at !== null) return refuse(409, 'swap_ended', 'this watch has ended');
    if (!existing) {
      if (this.store.activeCount() >= this.s.maxSwaps) return refuse(503, 'full', 'the watcher is at its cap of watched swaps');
      // A watch is a promise to pay for one freeze: refuse it when the fee balance cannot cover every open watch plus this one.
      const reserve = port.freezeReserve();
      const limit = this.s.limits[req.chain];
      if (limit && limit.perSwap < reserve) return refuse(503, 'insufficient_fee_balance', `the operator's per-swap spend limit on ${req.chain} is below the cost of one freeze`);
      let balance: bigint;
      try {
        balance = await port.balance();
      } catch {
        return refuse(503, 'chain_unavailable', `the watcher cannot read ${req.chain} right now`);
      }
      if (balance < reserve * BigInt(this.store.activeCount(req.chain) + 1)) return refuse(503, 'insufficient_fee_balance', `the watcher's ${req.chain} fee balance cannot cover another watch; it must be topped up`);
    }

    // The latest T_co this swap can have: its own once a notice is on record, else a notice at the last second of its window.
    const watchingUntil = swap.tClaimOpen !== 0n ? swap.tClaimOpen : (swap.tNoteDeadline === 0n ? swap.tFinal : swap.tNoteDeadline) + BigInt(swap.dC);
    const outcome = this.store.admit({ chain: req.chain, swapRef: refHex, sealedKey: this.keys.sealForStore(req.chain, req.swapRef, req.noticeKey), issuedAt: Number(req.issuedAt), watchingUntil: Number(watchingUntil), now: this.nowMs(), maxSwaps: this.s.maxSwaps });
    req.noticeKey.fill(0);
    if (outcome === 'full') return refuse(503, 'full', 'the watcher is at its cap of watched swaps');
    if (outcome === 'ended') return refuse(409, 'swap_ended', 'this watch has ended');
    // A request older than the one on file is a replay: the newer one stands.
    if (outcome === 'older') return refuse(409, 'superseded', 'a newer request for this swap is already on file');
    if (outcome === 'stored') {
      this.logger.info(`watch accepted on ${req.chain}`);
      this.logger.debug(`watch accepted: ${req.chain} ${refHex}`);
    }
    const ack: WatchAck = this.keys.signAck(req.chain, req.swapRef, watchingUntil);
    return { status: 200, body: { ...ack } };
  }

  // ---------------------------------------------------------------- GET /watch/v1/swaps/<swap_ref>

  /**
   * What the watcher has seen and done for one swap, or `null`. Only facts anyone can read from
   * the chain plus the watcher's own position: no amount, no party, no Monero transaction, no
   * address, and never a key.
   */
  status(swapRefHex: string): Record<string, unknown> | null {
    if (!/^[0-9a-f]{64}$/.test(swapRefHex)) return null;
    const w = this.store.findWatches(swapRefHex).sort((a, b) => b.created_at - a.created_at)[0];
    if (!w) return null;
    const attempts = this.store.attempts(w.chain, w.swap_ref).filter((a) => a.status !== 'dropped' && a.status !== 'journaled');
    return {
      swap_ref: w.swap_ref,
      chain: w.chain,
      status: w.status,
      reason: w.reason,
      waiting_for: w.terminal_at === null ? w.phase : null,
      watching_until: w.watching_until,
      freeze_decided: w.decided_why ? { why: w.decided_why, not_after: w.not_after } : null,
      freeze_transactions: attempts.map((a) => ({ id: a.tx_id, status: a.status })),
      last_checked_at: w.checked_at === null ? null : Math.floor(w.checked_at / 1000),
      accepted_at: Math.floor(w.created_at / 1000),
      ended_at: w.terminal_at === null ? null : Math.floor(w.terminal_at / 1000),
    };
  }

  // ---------------------------------------------------------------- GET /watch/v1/health

  private dayStart(): number {
    return Math.floor(this.nowMs() / DAY_MS) * DAY_MS;
  }

  /** Chain endpoints reachable, Monero nodes answering and agreeing, fee balances and how many freezes they cover. Cached for five seconds. */
  async health(): Promise<Record<string, unknown>> {
    const now = this.nowMs();
    if (this.healthCache && now - this.healthCache.at < 5_000) return this.healthCache.value;
    const chains: Record<string, unknown> = {};
    let ok = true;
    for (const [name, port] of Object.entries(this.chains) as [ChainName, ChainPort][]) {
      const reserve = port.freezeReserve();
      const limit = this.s.limits[name];
      try {
        const [chainTime, balance] = await Promise.all([port.now(), port.balance()]);
        const open = BigInt(this.store.activeCount(name));
        const runway = reserve === 0n ? null : balance / reserve;
        const covered = runway === null || runway > open;
        if (!covered) ok = false;
        chains[name] = {
          reachable: true,
          address: port.address,
          chain_time: Number(chainTime),
          fee_balance: balance.toString(),
          freeze_reserve: reserve.toString(),
          /** How many freezes the balance pays for at the configured maximum fee. */
          runway_freezes: runway === null ? null : Number(runway > 1_000_000n ? 1_000_000n : runway),
          accepting: covered,
          spent_today: this.store.committed(name, { since: this.dayStart() }).toString(),
          per_day_limit: limit ? limit.perDay.toString() : null,
        };
      } catch {
        ok = false;
        chains[name] = { reachable: false, address: port.address, accepting: false };
      }
    }
    const infos = await Promise.allSettled(this.nodes.map((n) => n.info()));
    const up = infos.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ height: number; top_block_hash: string }>).value);
    const heights = up.map((i) => i.height);
    // Nodes agree when all answer and their tips are the same block, or one is a single block behind.
    const agreeing = up.length === this.nodes.length && up.length > 0 && Math.max(...heights) - Math.min(...heights) <= 1 && new Set(up.filter((i) => i.height === Math.max(...heights)).map((i) => i.top_block_hash)).size === 1;
    if (!agreeing) ok = false;
    const full = this.store.activeCount() >= this.s.maxSwaps;
    const value = { ok, accepting: !full && Object.values(chains).some((c) => (c as { accepting: boolean }).accepting), chains, monero: { nodes: this.nodes.length, reachable: up.length, agreeing }, max_swaps: this.s.maxSwaps };
    this.healthCache = { at: now, value };
    return value;
  }

  // ---------------------------------------------------------------- the loop

  /** Poll now, then every `pollMs`. */
  start(pollMs: number): void {
    if (this.timer) return;
    const run = (): void => {
      void this.tick().finally(() => {
        if (this.timer) this.timer = setTimeout(run, pollMs);
      });
    };
    this.timer = setTimeout(run, 0);
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass over every open watch. A failure on one swap never stops the others; it is retried with backoff. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const w of this.store.activeWatches()) {
        if (w.next_at > this.nowMs()) continue;
        try {
          await this.step(w);
          this.store.updateWatch(w.chain, w.swap_ref, { errors: 0, next_at: 0, checked_at: this.nowMs() }, this.nowMs());
        } catch (e) {
          if ((e as { crash?: boolean }).crash) throw e;
          const errors = w.errors + 1;
          const code = errorClass(e);
          this.store.updateWatch(w.chain, w.swap_ref, { errors, next_at: this.nowMs() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(errors, 16)), last_error: code }, this.nowMs());
          this.logger.info(`a pass failed on ${w.chain} (${code}); retrying with backoff`);
          this.logger.debug(`pass failed: ${w.chain} ${w.swap_ref} ${code}`);
        }
      }
      this.store.purge(this.nowMs() - this.s.retentionDays * DAY_MS);
    } finally {
      this.running = false;
    }
  }

  /** The watch's notice key: the one its locker registered. */
  private noticeKey(w: WatchRow): Bytes {
    const row = this.store.key(w.chain, w.swap_ref);
    if (!row) throw Object.assign(new Error('no notice key is stored for this watch'), { code: 'no_notice_key' });
    return this.keys.openFromStore(w.chain, unhex(w.swap_ref), row.sealed);
  }

  private async step(w: WatchRow): Promise<void> {
    const port = this.chains[w.chain];
    if (!port) throw Object.assign(new Error('chain not configured'), { code: 'chain_not_configured' });
    const [swap, now] = await Promise.all([port.readSwap(unhex(w.swap_ref)), port.now()]);
    // A swap answered under another reference is not this watch's swap, whatever the endpoint says.
    if (swap && (swap.chain !== w.chain || hex(swap.swapRef) !== w.swap_ref)) throw Object.assign(new Error('the endpoint answered with another swap'), { code: 'wrong_swap' });
    const base = { swap, now, watcher: port.address };
    let d: WatcherDecision = watcherStep(base);
    if (d.do === 'need') {
      const facts = await watcherFacts({ swap: swap!, noticeKey: this.noticeKey(w), nodes: this.nodes, ...(this.deps.monero.ownNode ? { ownNode: true } : {}), network: this.deps.monero.network, ...(this.deps.monero.verify ? { verify: this.deps.monero.verify } : {}) });
      d = watcherStep({ ...base, noticeOpens: facts.noticeOpens, ...(facts.lock ? { lock: facts.lock } : {}) });
    }
    switch (d.do) {
      case 'wait': {
        const set: Partial<WatchRow> = { phase: d.on, stop_why: null, stop_seen: 0 };
        // A freeze that was decided but never built is dropped when the step no longer asks for it (the lock confirmed meanwhile).
        if (w.status === 'freezing' && this.store.attempts(w.chain, w.swap_ref).every((a) => a.status === 'dropped')) Object.assign(set, { status: 'watching', decided_why: null, decided_at: null, not_after: null });
        this.store.updateWatch(w.chain, w.swap_ref, set, this.nowMs());
        return;
      }
      case 'stop':
        return this.stopped(w, port, d.why, swap, now);
      case 'call':
        // The only call `watcherStep` can propose; anything else is a bug and is not sent.
        if (d.call.name !== 'freeze' || d.caller !== 'watcher') throw Object.assign(new Error('unexpected call'), { code: 'unexpected_call' });
        return this.freeze(w, port, swap!, d.why, d.notAfter);
      default:
        throw Object.assign(new Error('the step still needs facts'), { code: 'facts_missing' });
    }
  }

  /** Look up every transaction that may still land and record what the chain says. */
  private async reconcile(w: WatchRow, port: ChainPort): Promise<{ landed: boolean; open: AttemptRow[] }> {
    const rows = this.store.attempts(w.chain, w.swap_ref);
    const dead = new Set<number | null>();
    let landed = rows.some((r) => r.status === 'landed');
    for (const r of rows) {
      if (r.status !== 'journaled' && r.status !== 'sent') continue;
      const seen = await port.lookup(r.tx_id);
      if (seen === 'unknown') continue;
      this.store.setAttempt(r.id, seen, this.nowMs());
      r.status = seen;
      if (seen === 'landed') landed = true;
      if (r.nonce !== null) dead.add(r.nonce);
    }
    const open: AttemptRow[] = [];
    for (const r of rows) {
      if (r.status !== 'journaled' && r.status !== 'sent') continue;
      // A transaction whose nonce was used by another can never be mined.
      if (landed || dead.has(r.nonce)) this.store.setAttempt(r.id, 'dropped', this.nowMs());
      else open.push(r);
    }
    return { landed, open };
  }

  private async freeze(w: WatchRow, port: ChainPort, swap: SwapView, why: string, notAfter: bigint): Promise<void> {
    if (w.status === 'watching') {
      // Journal point 1: the decision, before anything is built.
      this.store.journalDecision(w.chain, w.swap_ref, why, Number(notAfter), this.nowMs());
      this.logger.info(`freeze decided on ${w.chain} (${why})`);
      this.logger.debug(`freeze decided: ${w.chain} ${w.swap_ref} ${why}`);
      this.fault('after-decision');
    }
    const { landed, open } = await this.reconcile(w, port);
    if (landed) return; // Wait for finality to show the swap FROZEN.
    let replace: { nonce: number; feePerGas: bigint; tipPerGas: bigint } | undefined;
    const latest = open.at(-1);
    if (latest) {
      if (!port.replaceByNonce && (await port.expired(latest.valid_until))) {
        // Its blockhash is past its last valid block height: it can no longer land, and a fresh one may be built.
        for (const r of open) this.store.setAttempt(r.id, 'dropped', this.nowMs(), 'expired');
      } else if (latest.status === 'journaled') {
        // Journaled and not known to have been sent (a stop between the two): the same bytes go out.
        await port.broadcast(latest.wire);
        this.fault('after-broadcast');
        this.store.setAttempt(latest.id, 'sent', this.nowMs());
        this.logger.info(`freeze sent on ${w.chain}`);
        return;
      } else if (this.nowMs() - latest.updated_at < this.s.attemptTimeoutSecs * 1_000) {
        return;
      } else if (port.replaceByNonce) {
        replace = { nonce: latest.nonce!, feePerGas: BigInt(latest.fee_per_gas!), tipPerGas: BigInt(latest.tip_per_gas ?? '0') };
      } else {
        // Still valid and not seen: the same bytes go out again; never a second transaction beside a live one.
        await port.broadcast(latest.wire);
        this.store.setAttempt(latest.id, 'sent', this.nowMs());
        return;
      }
    }
    let built;
    try {
      built = await port.buildFreeze(swap, { ...(replace ? { replace } : {}), nonceFloor: (this.store.highestOpenNonce() ?? -1) + 1 });
    } catch (e) {
      if (latest && replace && (e instanceof FeeAboveLimit || e instanceof FreezeRefused)) {
        // No dearer replacement is allowed: keep the pending one alive.
        await port.broadcast(latest.wire);
        this.store.setAttempt(latest.id, 'sent', this.nowMs());
      }
      throw e;
    }
    // Spend limits, counted on the maximum each transaction can cost. A replacement adds only the difference.
    const replaced = replace ? open.reduce((m, r) => (BigInt(r.max_fee) > m ? BigInt(r.max_fee) : m), 0n) : 0n;
    const extra = built.maxFee > replaced ? built.maxFee - replaced : 0n;
    const limit = this.s.limits[w.chain];
    if (limit) {
      if (this.store.committed(w.chain, { swapRef: w.swap_ref }) + extra > limit.perSwap) throw new SpendLimit('per-swap-limit');
      if (this.store.committed(w.chain, { since: this.dayStart() }) + extra > limit.perDay) throw new SpendLimit('per-day-limit');
    }
    // Journal point 2: the signed transaction, before it is broadcast.
    const id = this.store.journalAttempt({ chain: w.chain, swapRef: w.swap_ref, txId: built.txId, wire: built.wire, maxFee: built.maxFee, nonce: built.nonce, feePerGas: built.feePerGas, tipPerGas: built.tipPerGas, validUntil: built.validUntil, now: this.nowMs() });
    this.fault('after-attempt-journal');
    await port.broadcast(built.wire);
    this.fault('after-broadcast');
    this.store.setAttempt(id, 'sent', this.nowMs());
    this.logger.info(`freeze sent on ${w.chain}`);
    this.logger.debug(`freeze sent: ${w.chain} ${w.swap_ref} ${built.txId}`);
  }

  private async stopped(w: WatchRow, port: ChainPort, why: string, swap: SwapView | null, now: bigint): Promise<void> {
    // An endpoint that lags or lies must not end a watch (and delete its key) on one answer.
    const seen = w.stop_why === why ? w.stop_seen + 1 : 1;
    if (seen < this.s.stopConfirmations) {
      this.store.updateWatch(w.chain, w.swap_ref, { stop_why: why, stop_seen: seen }, this.nowMs());
      return;
    }
    const { landed, open } = await this.reconcile(w, port);
    const sentAny = this.store.attempts(w.chain, w.swap_ref).some((a) => a.status !== 'dropped' && a.status !== 'journaled');
    const done = (status: 'frozen' | 'not_needed' | 'window_missed', reason: string): void => {
      this.fault('before-terminal');
      this.store.finish(w.chain, w.swap_ref, status, reason, this.nowMs());
      this.logger.info(`watch ended on ${w.chain}: ${status}`);
      this.logger.debug(`watch ended: ${w.chain} ${w.swap_ref} ${status} (${reason})`);
    };
    const decided = w.decided_why;
    switch (why) {
      case 'frozen':
        if (landed) return done('frozen', `frozen by this watcher: ${decided ?? 'decision not on record'}`);
        if (sentAny) return done('frozen', `frozen on chain; this watcher's own transaction was not seen to land (${decided ?? 'no decision on record'})`);
        return done('not_needed', 'frozen by the locker');
      case 'ready':
        return done('not_needed', 'the locker set ready');
      case 'too-late': {
        // A freeze may have landed and not be final yet: keep looking until the claim opens.
        if ((landed || open.length > 0) && swap && now < deadlinesOf(swap.chain, swap).tCo! + deadlinesOf(swap.chain, swap).margin) {
          this.store.updateWatch(w.chain, w.swap_ref, { stop_why: why, stop_seen: seen }, this.nowMs());
          return;
        }
        if (decided) return done('window_missed', `a freeze was due (${decided}) and did not land before T_co − M: ${w.last_error ?? 'not confirmed in time'}`);
        if (w.phase === 'recheck') return done('not_needed', 'the lock stayed confirmed through the freeze window');
        return done('window_missed', `the swap could not be judged before T_co − M: ${w.last_error ?? 'the watcher was not running or was given the swap too late'}`);
      }
      case 'ended':
        if (decided && !landed && swap && swap.tFreeze === 0n && endedInClaim(swap)) return done('window_missed', `a freeze was due (${decided}) and the swap was claimed before it landed: ${w.last_error ?? 'not confirmed in time'}`);
        return done('not_needed', 'the swap ended');
      case 'no-swap':
        return done('not_needed', decided ? `the swap account is gone; a freeze had been decided (${decided})` : 'the swap is gone');
      default:
        return done('not_needed', `the swap does not name this watcher (${why})`);
    }
  }
}
