// Crash recovery (SPEC 7.4, 7.6, scenario D-1): the daemon is killed at EVERY point of the
// intent journal (row planned, transaction signed, transaction sent, action done, result
// recorded) of every action of four swaps, restarted on the same database, and driven on.
// Whatever the cut point: one Monero lock transaction per swap, the notice before the XMR, no
// spend share broadcast outside its window, and the claim or refund that was due still lands.
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { COUNTER, CHAIN_CONSTS, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import { ata, deadlinesOf, seedSigner } from '@xmrswap/sdk';
import type { Daemon } from '../src/daemon.js';
import { CrashError } from '../src/store/journal.js';
import { FakeWatcher, type OpenedSwap, XMR, buildNotice, swapJointAddress, viewOf } from './sim.js';
import { BASE_TOML, type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});

interface Ctx {
  /** The maker's watcher service, when the scenario has one: it lives outside the daemon and survives its crashes. */
  watcher?: FakeWatcher;
  swap: OpenedSwap | null;
  fakeTxid?: string;
  step: number;
  /** Operator instructions already given. Set BEFORE the call, so a crash inside it is never followed by a second request: the daemon must honour the journaled one. */
  given: Set<string>;
}
interface Scenario {
  name: string;
  /** The world outside the daemon: the taker, the Monero miners and the clock. State-driven, so it resumes after a restart. */
  env(w: World, d: Daemon, c: Ctx): void | Promise<void>;
  /** Configuration of the world (default: the base file). */
  toml?: string | ((w: World, c: Ctx) => string);
  check(w: World, d: Daemon, c: Ctx): void;
  /** The journal points a crash must have been cut at, when not the default five. */
  cuts?: string[];
}

function usdcAccount(w: World, owner: string, amount: bigint): void {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  w.sim.fake.setAccount(ata(owner, w.sim.usdcMint).toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
}
const lockRelayed = (w: World): boolean => w.xmr.relaysOf('wallet').length > 0;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const directionA = (refund: boolean): Scenario => ({
  name: refund ? 'A: taker refunds after the notice; the maker sweeps its XMR back' : 'A: lock, notice, XMR, ready, claim',
  env(w, d, c) {
    const { sim, xmr } = w;
    if (!c.swap) {
      const offer = sim.offer(0, 0);
      if (offer?.enabled && (offer.poolFilled & ~offer.poolUsed) !== 0) {
        // BUG-4's setting: a wallet that spends whatever is unfrozen, and an output the daemon has not frozen yet.
        xmr.greedy = true;
        xmr.addOutput(3n * XMR);
        c.swap = sim.open({ direction: 0, xmr: 2n * XMR, makerSpendPub: sim.takePoolKey(0) });
      }
      return;
    }
    const s = sim.swap(c.swap.pda);
    if (!s) return;
    if (s.state === SWAP_STATE.NOTICED && lockRelayed(w)) {
      xmr.mine(2);
      if (refund) sim.takerCall(c.swap.pda, { name: 'refund', secretOk: true }, { revealed: c.swap.keys.spend });
      else {
        sim.setTime(s.tNotice + BigInt(s.depth * CHAIN_CONSTS.solana.readyMinSecsPerConf));
        sim.takerCall(c.swap.pda, { name: 'set_ready' });
      }
    } else if (s.state === SWAP_STATE.HOLD) {
      xmr.mine(10);
      // Once the maker has its XMR back and published the opening, the hold runs out and a stranger cranks the release.
      if (d.store.swap(c.swap.pda)?.swept && (s.flags & SWAP_FLAG.EVIDENCE) !== 0) {
        sim.setTime(s.tRefund + BigInt(CHAIN_CONSTS.solana.holdSecs));
        sim.takerCall(c.swap.pda, { name: 'release_deposit' }, {}, 'anyone');
      }
    }
  },
  check(w, d, c) {
    const { sim, xmr, log } = w;
    const pda = c.swap!.pda;
    const row = d.store.swap(pda)!;
    expect(row.terminal).toBe(1);
    // One Monero lock transaction per swap, ever, and only after the notice that names it.
    expect(xmr.relaysOf('wallet')).toHaveLength(1);
    expect(log.indexOf('chain:post_notice')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('chain:post_notice')).toBeLessThan(log.indexOf('xmr:relay:wallet'));
    expect(sim.names(pda).filter((n) => n === 'post_notice')).toHaveLength(1);
    expect(d.store.lockTx(pda)!.txid).toBe(xmr.relaysOf('wallet')[0]);
    // Reserve → build → notice → relay, whatever the cut: the lock spends exactly the one output reserved for it, the
    // relay is journaled as it happened, and nothing was announced that the nodes then refused.
    const lock = d.store.lockTx(pda)!;
    expect(lock.key_images).toHaveLength(1);
    expect(xmr.txs.get(lock.txid)!.inputs).toEqual(lock.key_images);
    expect(d.store.intents({ swapRef: pda, kind: 'xmr_relay' }).filter((i) => i.payload['sweep'] !== true && i.status === 'confirmed')).toHaveLength(1);
    expect(d.alerts.list(100).filter((a) => a.kind === 'lock_double_spend' || a.kind === 'lock_rebuilt')).toEqual([]);
    expect(sim.names(pda)).not.toContain('abort');
    if (refund) {
      expect(row.phase).toBe('closed');
      expect(sim.secretSends).toEqual([]);
      expect(xmr.relaysOf('sweep')).toHaveLength(1);
      expect(sim.names(pda).filter((n) => n === 'publish_evidence')).toHaveLength(1);
      expect(sim.names(pda)).toContain('close_swap');
    } else {
      // No missed claim: it landed, exactly once, and the share left only when the swap was READY.
      expect(row.phase).toBe('completed');
      expect(sim.swap(pda)!.outcome).toBe(COUNTER.completed);
      expect(sim.names(pda).filter((n) => n === 'claim')).toHaveLength(1);
      expect(sim.secretSends.length).toBeGreaterThanOrEqual(1);
      for (const s of sim.secretSends) expect(s).toMatchObject({ name: 'claim', state: SWAP_STATE.READY });
      expect(hex(sim.swap(pda)!.revealed)).toBe(d.store.shareForSwap(pda)!.spend_pub === hex(sim.swap(pda)!.makerSpendPub) ? hex(d.shares.forSwap(pda)!.keys.spend) : 'share mismatch');
      expect(d.store.fills()).toHaveLength(1);
    }
    expect(d.store.shares().filter((s) => s.swap_ref === pda)).toHaveLength(1);
  },
});

const directionB = (unconfirmed: boolean): Scenario => ({
  name: unconfirmed ? 'B: the taker posts a notice for XMR that never arrives; the maker refunds at the cutoff' : 'B: take, fund, notice, verify, ready, taker claims, the maker sweeps',
  env(w, d, c) {
    const { sim, xmr } = w;
    if (!c.swap) {
      if (sim.offer(1, 1)?.enabled) c.swap = sim.open({ direction: 1, asset: 1, xmr: 3n * XMR });
      return;
    }
    const pda = c.swap.pda;
    const s = sim.swap(pda);
    if (!s) return;
    const keys = c.swap.keys;
    if (s.state === SWAP_STATE.ACTIVE) {
      const view = viewOf(sim, pda);
      const joint = swapJointAddress(view, keys.view, 'regtest');
      const txid = unconfirmed ? 'ab'.repeat(32) : xmr.external(joint.address, s.xmr);
      const notice = buildNotice(view, keys.encSecret, Uint8Array.from(Buffer.from(txid, 'hex')), keys.view);
      sim.takerCall(pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
    } else if (s.state === SWAP_STATE.NOTICED) {
      if (unconfirmed) {
        // Give the daemon one look before the cutoff, then let the cutoff pass.
        if (++c.step >= 2) sim.setTime(s.tCut);
      } else {
        xmr.mine(2);
        sim.setTime(s.tNotice + BigInt(s.depth * CHAIN_CONSTS.solana.readyMinSecsPerConf));
      }
    } else if (s.state === SWAP_STATE.READY) {
      sim.takerCall(pda, { name: 'claim', secretOk: true }, { revealed: keys.spend });
      xmr.mine(10);
    } else if (s.state === SWAP_STATE.HOLD) {
      sim.setTime(s.tRefund + BigInt(CHAIN_CONSTS.solana.holdSecs));
      sim.takerCall(pda, { name: 'release_deposit' }, {}, 'anyone');
    } else if (s.state === SWAP_STATE.DONE) xmr.mine(1);
  },
  check(w, d, c) {
    const { sim, xmr } = w;
    const pda = c.swap!.pda;
    const row = d.store.swap(pda)!;
    expect(row.terminal).toBe(1);
    expect(sim.names(pda).filter((n) => n === 'fund')).toHaveLength(1);
    // The maker never sends XMR in this direction.
    expect(xmr.relaysOf('wallet')).toHaveLength(0);
    expect(d.store.shares().filter((s) => s.swap_ref === pda)).toHaveLength(1);
    if (unconfirmed) {
      // The refund landed inside [T_cut, T_co − M]: it is the one deadline that loses funds when missed.
      const refunds = sim.landed.filter((l) => l.swap === pda && l.name === 'refund');
      expect(refunds).toHaveLength(1);
      const snap = sim.landed.find((l) => l.swap === pda && l.name === 'post_notice')!;
      expect(snap).toBeDefined();
      for (const s of sim.secretSends) expect(s).toMatchObject({ name: 'refund', state: SWAP_STATE.NOTICED });
      expect(sim.names(pda)).not.toContain('set_ready');
      expect(row.phase).toBe('refunded');
      expect(xmr.sweepsBuilt).toHaveLength(0);
    } else {
      expect(sim.names(pda).filter((n) => n === 'set_ready')).toHaveLength(1);
      expect(sim.secretSends).toEqual([]);
      expect(xmr.relaysOf('sweep')).toHaveLength(1);
      expect(row.swept).toBe(1);
      expect(row.phase).toBe('closed');
    }
  },
});

/** Run a scenario; crash at the `crashAt`-th journal point (never when `null`). Returns how many points the run passed. */
async function run(sc: Scenario, crashAt: number | null): Promise<{ points: number; crashedAt: string | null }> {
  const c: Ctx = { swap: null, step: 0, given: new Set() };
  const w = await makeWorld(typeof sc.toml === 'function' ? undefined : sc.toml);
  if (typeof sc.toml === 'function') writeFileSync(w.configPath, sc.toml(w, c).replaceAll('__OWNER__', w.sim.owner));
  usdcAccount(w, w.keystore.solana.publicKey, 1_000_000_000_000n);
  let points = 0;
  let crashedAt: string | null = null;
  const hook = (point: string, intent: { kind: string; payload: Record<string, unknown> }) => {
    points++;
    if (points === crashAt) {
      crashedAt = `${intent.kind}${intent.payload['call'] ? `:${String(intent.payload['call'])}` : ''}@${point}`;
      throw new CrashError(crashedAt);
    }
  };
  const boot = () => w.boot({ crash: hook, ...(c.watcher ? { watcherFetch: c.watcher.fetch } : {}) });
  let d = await boot();
  let started = false;
  for (let round = 0; round < 80; round++) {
    try {
      if (!started) {
        await d.start();
        started = true;
      }
      await sc.env(w, d, c);
      await d.executor.tick();
      await d.offers.tick(true);
      if (c.swap && d.store.swap(c.swap.pda)?.terminal) break;
    } catch (e) {
      if (!(e instanceof CrashError)) throw e;
      // The process is gone: only the database file, the chain and the Monero network remain.
      d.store.close();
      // Long enough for every blockhash signed before the crash to expire.
      w.sim.blockHeight += 5_000;
      d = await boot();
      started = false;
    }
  }
  expect(c.swap, `the swap was never opened (crash at ${crashedAt})`).not.toBeNull();
  try {
    sc.check(w, d, c);
    // Nothing is left half-done, and nothing was parked.
    expect(d.store.intents({ status: ['planned', 'sent', 'needs_review'] }).filter((i) => i.swap_ref !== null)).toEqual([]);
  } catch (e) {
    (e as Error).message = `[crash at point ${String(crashAt)}: ${String(crashedAt)}] ${(e as Error).message}\nlog: ${w.log.join(' ')}\nrow: ${JSON.stringify(c.swap && d.store.swap(c.swap.pda), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 600)}`;
    throw e;
  } finally {
    d.store.close();
  }
  return { points, crashedAt };
}

/** Give an operator instruction once, ever: the flag is set before the call. */
async function instruct(d: Daemon, c: Ctx, name: string, patch: Parameters<Daemon['executor']['manual']>[1]): Promise<void> {
  if (c.given.has(name)) return;
  c.given.add(name);
  await d.executor.manual(c.swap!.pda, patch);
}
const WINDOW_TOML = `${BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\napproval_mode = "window"')}\n[approvals]\nauto_max_xmr = 1\n`;

/** The operator approves a pending lock, and later backs out after the notice: both instructions are journaled before they act. */
const operatorApprovesThenAborts: Scenario = {
  name: 'A (window): the operator approves, then aborts after the notice',
  toml: WINDOW_TOML,
  async env(w, d, c) {
    const { sim, xmr } = w;
    if (!c.swap) {
      if (sim.offer(0, 0)?.enabled) c.swap = sim.open({ direction: 0, mode: 1, xmr: 2n * XMR });
      return;
    }
    const s = sim.swap(c.swap.pda);
    if (!s) return;
    if (s.state === SWAP_STATE.PENDING && d.store.swap(c.swap.pda)) await instruct(d, c, 'approve', { approve: true });
    else if (s.state === SWAP_STATE.NOTICED && lockRelayed(w)) await instruct(d, c, 'abort', { abort: true });
    else if (s.state === SWAP_STATE.ABORTED_FREE || s.state === SWAP_STATE.ABORTED_HOLD) {
      xmr.mine(2);
      sim.takerCall(c.swap.pda, { name: 'refund', secretOk: true }, { revealed: c.swap.keys.spend });
    } else if (s.state === SWAP_STATE.HOLD) {
      xmr.mine(10);
      if (d.store.swap(c.swap.pda)?.swept && (s.flags & SWAP_FLAG.EVIDENCE) !== 0) {
        sim.setTime(s.tRefund + BigInt(CHAIN_CONSTS.solana.holdSecs));
        sim.takerCall(c.swap.pda, { name: 'release_deposit' }, {}, 'anyone');
      }
    } else if (s.state === SWAP_STATE.DONE) xmr.mine(10);
  },
  check(w, d, c) {
    const { sim, xmr } = w;
    const pda = c.swap!.pda;
    expect([...c.given].sort()).toEqual(['abort', 'approve']);
    // Each instruction was carried out exactly once, whatever the cut point, and no automatic step overtook it.
    expect(sim.names(pda).filter((n) => n === 'approve')).toHaveLength(1);
    expect(sim.names(pda).filter((n) => n === 'abort')).toHaveLength(1);
    expect(sim.names(pda)).not.toContain('reject');
    expect(sim.names(pda)).not.toContain('claim');
    expect(sim.secretSends).toEqual([]);
    expect(d.store.swap(pda)!.facts.instruction).toMatchObject({ action: 'abort', status: 'carried_out', tx: expect.any(String) });
    expect(d.store.swap(pda)!.facts.manual?.abort).toBeUndefined(); // one-shot: nothing is left to fire later
    expect(xmr.relaysOf('wallet')).toHaveLength(1);
    expect(xmr.relaysOf('sweep')).toHaveLength(1);
    expect(d.store.swap(pda)!.terminal).toBe(1);
  },
};

/** After a taker refund the operator withholds the deposit, and later releases it. */
const operatorWithholdsThenReleases: Scenario = {
  name: 'A: after a refund the operator withholds, then releases',
  async env(w, d, c) {
    const { sim, xmr } = w;
    if (!c.swap) {
      const offer = sim.offer(0, 0);
      if (offer?.enabled && (offer.poolFilled & ~offer.poolUsed) !== 0) c.swap = sim.open({ direction: 0, xmr: 2n * XMR, makerSpendPub: sim.takePoolKey(0) });
      return;
    }
    const s = sim.swap(c.swap.pda);
    if (!s) return;
    if (s.state === SWAP_STATE.NOTICED && lockRelayed(w)) {
      xmr.mine(2);
      sim.takerCall(c.swap.pda, { name: 'refund', secretOk: true }, { revealed: c.swap.keys.spend });
    } else if (s.state === SWAP_STATE.HOLD) await instruct(d, c, 'withhold', { withhold: true });
    else if (s.state === SWAP_STATE.WITHHELD) {
      xmr.mine(10);
      if (d.store.swap(c.swap.pda)?.swept) await instruct(d, c, 'release', { release: true, withhold: false });
    }
  },
  check(w, d, c) {
    const { sim, xmr } = w;
    const pda = c.swap!.pda;
    expect([...c.given].sort()).toEqual(['release', 'withhold']);
    expect(sim.names(pda).filter((n) => n === 'withhold')).toHaveLength(1);
    expect(sim.names(pda).filter((n) => n === 'release_deposit')).toHaveLength(1);
    expect(sim.names(pda).indexOf('withhold')).toBeLessThan(sim.names(pda).indexOf('release_deposit'));
    expect(d.store.swap(pda)!.facts.instruction).toMatchObject({ action: 'release', status: 'carried_out' });
    expect(xmr.relaysOf('wallet')).toHaveLength(1);
    expect(xmr.relaysOf('sweep')).toHaveLength(1);
    expect(d.store.swap(pda)!.terminal).toBe(1);
  },
};

// ---------------------------------------------------------------- Amendment 1: FROZEN (SPEC 11.6)

const FROZEN_TOML = BASE_TOML.replace('[markets.sol.sell_xmr]\nenabled = true', '[markets.sol.sell_xmr]\nenabled = true\nfreeze_window_hours = 24\ndeposit_pct = 2\nwithhold_policy = "always"');
const TAKER_WATCHER = seedSigner(new Uint8Array(32).fill(0x55)).publicKey;

/** Direction A on an offer with a freeze window: the taker's watcher pauses the swap after the notice. */
const frozenA = (returns: boolean): Scenario => ({
  name: returns ? 'A frozen: the taker returns and refunds; the maker sweeps its XMR back and withholds by policy' : 'A frozen: the taker never returns; the maker claims at T_ff',
  toml: FROZEN_TOML,
  env(w, d, c) {
    const { sim, xmr } = w;
    if (!c.swap) {
      const offer = sim.offer(0, 0);
      if (offer?.enabled && offer.wZ === 86_400 && (offer.poolFilled & ~offer.poolUsed) !== 0) c.swap = sim.open({ direction: 0, xmr: 2n * XMR, depBps: 200, wZ: offer.wZ, watcher: TAKER_WATCHER, makerSpendPub: sim.takePoolKey(0) });
      return;
    }
    const pda = c.swap.pda;
    const s = sim.swap(pda);
    if (!s) return;
    if (s.state === SWAP_STATE.NOTICED && lockRelayed(w)) {
      xmr.mine(2);
      sim.warp(60);
      sim.watcherFreeze(pda);
    } else if (s.state === SWAP_STATE.FROZEN) {
      const tFf = deadlinesOf('solana', viewOf(sim, pda)).tFf!;
      // The daemon looks at the frozen swap at least once before anything else happens, and once past the old claim-open time.
      c.step++;
      if (c.step === 2) sim.setTime(s.tClaimOpen + 60n);
      else if (c.step >= 3) {
        if (returns) sim.takerCall(pda, { name: 'refund', secretOk: true }, { revealed: c.swap.keys.spend });
        else sim.setTime(tFf);
      }
    } else if (s.state === SWAP_STATE.HOLD || s.state === SWAP_STATE.WITHHELD) {
      xmr.mine(10);
      // Withheld by policy: once the maker has its XMR back, the 60 days run out and a stranger cranks the split.
      if (s.state === SWAP_STATE.WITHHELD && d.store.swap(pda)?.swept) {
        sim.setTime(s.tRefund + BigInt(CHAIN_CONSTS.solana.splitSecs));
        sim.takerCall(pda, { name: 'split_deposit' }, {}, 'anyone');
      }
    } else if (s.state === SWAP_STATE.DONE) xmr.mine(10);
  },
  check(w, d, c) {
    const { sim, xmr, log } = w;
    const pda = c.swap!.pda;
    const row = d.store.swap(pda)!;
    expect(row.terminal).toBe(1);
    expect(xmr.relaysOf('wallet')).toHaveLength(1);
    expect(log.indexOf('chain:post_notice')).toBeLessThan(log.indexOf('xmr:relay:wallet'));
    // The freeze was seen and recorded exactly once, as the taker side's.
    expect(d.store.freezes()).toHaveLength(1);
    const f = d.store.freeze(pda)!;
    expect(f).toMatchObject({ direction: 0, frozen_by: 'taker_side', watcher: TAKER_WATCHER });
    expect(sim.maker().counters[COUNTER.freezes]).toBe(1);
    expect(sim.names(pda)).not.toContain('abort');
    if (returns) {
      // No share of the maker ever left; the XMR came back; the policy withheld the deposit with the notice's opening.
      expect(sim.secretSends).toEqual([]);
      expect(sim.maker().counters[COUNTER.refunds_after_freeze]).toBe(1);
      expect(sim.names(pda).filter((n) => n === 'withhold')).toHaveLength(1);
      expect(xmr.relaysOf('sweep')).toHaveLength(1);
      expect(row.swept).toBe(1);
    } else {
      // The claim landed once, in FROZEN, at or after T_ff; nothing secret was broadcast before it.
      const claims = sim.landed.filter((l) => l.swap === pda && l.name === 'claim');
      expect(claims).toHaveLength(1);
      expect(claims[0]!.stateBefore).toBe(SWAP_STATE.FROZEN);
      expect(Number(claims[0]!.at)).toBeGreaterThanOrEqual(f.t_ff);
      expect(sim.secretSends.length).toBeGreaterThanOrEqual(1);
      for (const s of sim.secretSends) {
        expect(s).toMatchObject({ name: 'claim', state: SWAP_STATE.FROZEN });
        expect(Number(s.at)).toBeGreaterThanOrEqual(f.t_ff);
      }
      expect(sim.maker().counters[COUNTER.claims_after_freeze]).toBe(1);
      expect(row.phase).toBe('completed');
      expect(d.store.fills()).toHaveLength(1);
    }
    expect(d.store.shares().filter((s) => s.swap_ref === pda)).toHaveLength(1);
  },
});

const watcherToml = (w: World, c: Ctx): string => {
  c.watcher = new FakeWatcher(w.sim);
  return `${BASE_TOML.replace('[markets.usdc_sol.buy_xmr]\nenabled = true', '[markets.usdc_sol.buy_xmr]\nenabled = true\nfreeze_window_hours = 24\ndeposit_pct = 1')}\n[watcher]\nurl = "http://watcher.test"\nsolana_key = "${c.watcher.solana}"\nretry_seconds = 0.001\n`;
};

/** Direction B with the maker's watcher: named at fund, handed the swap, and the daemon itself pauses a slow lock. */
const frozenB = (confirms: boolean): Scenario => ({
  name: confirms ? 'B frozen: fund names the watcher, the watcher acknowledges, the daemon pauses a slow lock, it confirms, ready, claim, sweep' : 'B frozen: the daemon pauses a slow lock that never confirms and refunds before T_ff; the deposit is never held',
  toml: watcherToml,
  async env(w, _d, c) {
    const { sim, xmr } = w;
    if (!c.swap) {
      const offer = sim.offer(1, 1);
      if (offer?.enabled && offer.wZ === 86_400) c.swap = sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ: offer.wZ });
      return;
    }
    const pda = c.swap.pda;
    const s = sim.swap(pda);
    if (!s) return;
    const keys = c.swap.keys;
    if (s.state === SWAP_STATE.ACTIVE) {
      // The taker posts its notice only once the watcher holds the swap (the daemon registered it after the fund was final).
      if (!c.watcher!.keys.has(pda)) return;
      const view = viewOf(sim, pda);
      const joint = swapJointAddress(view, keys.view, 'regtest');
      c.fakeTxid = xmr.external(joint.address, s.xmr);
      const notice = buildNotice(view, keys.encSecret, Uint8Array.from(Buffer.from(c.fakeTxid, 'hex')), keys.view);
      sim.takerCall(pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
    } else if (s.state === SWAP_STATE.NOTICED) {
      // The lock sits in the pool: one margin before the cutoff the daemon pauses.
      if (++c.step >= 2) sim.setTime(s.tCut - BigInt(CHAIN_CONSTS.solana.marginSecs));
    } else if (s.state === SWAP_STATE.FROZEN) {
      const tFf = deadlinesOf('solana', viewOf(sim, pda)).tFf!;
      if (confirms) {
        sim.setTime(s.tClaimOpen + 60n);
        xmr.mine(3);
      } else sim.setTime(tFf - 2n * BigInt(CHAIN_CONSTS.solana.marginSecs));
    } else if (s.state === SWAP_STATE.READY) {
      sim.takerCall(pda, { name: 'claim', secretOk: true }, { revealed: keys.spend });
      xmr.mine(10);
    } else if (s.state === SWAP_STATE.DONE) xmr.mine(1);
  },
  check(w, d, c) {
    const { sim, xmr } = w;
    const pda = c.swap!.pda;
    const row = d.store.swap(pda)!;
    expect(row.terminal).toBe(1);
    expect(sim.names(pda).filter((n) => n === 'fund')).toHaveLength(1);
    expect(sim.landed.find((l) => l.swap === pda && l.name === 'fund')!.args['watcher']).toBe(c.watcher!.solana);
    // The acknowledgement the daemon keeps is the watcher's, for this swap.
    expect(d.store.watchAck(pda)).toMatchObject({ watcher: c.watcher!.solana });
    expect(d.store.intents({ swapRef: pda, kind: 'watch_register' }).filter((i) => i.status === 'confirmed')).toHaveLength(1);
    // Exactly one freeze, the daemon's own, and it is recorded as such.
    expect(sim.names(pda).filter((n) => n === 'freeze')).toHaveLength(1);
    expect(d.store.freeze(pda)).toMatchObject({ direction: 1, frozen_by: 'maker' });
    expect(c.watcher!.froze).toEqual([]);
    expect(xmr.relaysOf('wallet')).toHaveLength(0);
    expect(d.store.shares().filter((s) => s.swap_ref === pda)).toHaveLength(1);
    if (confirms) {
      expect(sim.names(pda).filter((n) => n === 'set_ready')).toHaveLength(1);
      expect(sim.landed.find((l) => l.swap === pda && l.name === 'set_ready')!.stateBefore).toBe(SWAP_STATE.FROZEN);
      expect(sim.secretSends).toEqual([]);
      expect(xmr.relaysOf('sweep')).toHaveLength(1);
      expect(row.swept).toBe(1);
    } else {
      const refunds = sim.landed.filter((l) => l.swap === pda && l.name === 'refund');
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.stateBefore).toBe(SWAP_STATE.FROZEN);
      // Before T_ff − M, where the taker's claim without ready would open: the one deadline that loses the escrow.
      expect(Number(refunds[0]!.at)).toBeLessThanOrEqual(d.store.freeze(pda)!.t_ff - CHAIN_CONSTS.solana.marginSecs);
      for (const s of sim.secretSends) expect(s).toMatchObject({ name: 'refund', state: SWAP_STATE.FROZEN });
      expect(sim.maker().counters[COUNTER.backouts_after_freeze]).toBe(1);
      // A maker-side freeze never holds the take deposit: no hold, no withhold.
      expect(sim.names(pda)).not.toContain('withhold');
      expect(sim.landed.some((l) => l.swap === pda && l.stateBefore === SWAP_STATE.HOLD)).toBe(false);
      expect(xmr.sweepsBuilt).toHaveLength(0);
    }
  },
});

const scenarios = [directionA(false), directionA(true), directionB(false), directionB(true), operatorApprovesThenAborts, operatorWithholdsThenReleases, frozenA(true), frozenA(false), frozenB(true), frozenB(false)];


describe.each(scenarios)('crash recovery: $name', (sc) => {
  let total = 0;
  it('completes without a crash', async () => {
    total = (await run(sc, null)).points;
    expect(total).toBeGreaterThan(8);
  });
  it('survives a crash at every intent state of every action', async () => {
    const seen = new Set<string>();
    for (let k = 1; k <= total; k++) {
      const r = await run(sc, k);
      if (r.crashedAt) seen.add(r.crashedAt.replace(/^.*@/, '@'));
    }
    // Every kind of cut was exercised: before the action, between signing and broadcasting, after broadcasting, after acting, after recording.
    // (The last scenario has no off-chain action: the maker neither sends nor sweeps XMR in it.)
    expect([...seen].sort()).toEqual(sc.cuts ?? (sc === scenarios[3] ? ['@planned', '@sent', '@signed'] : scenarios.indexOf(sc) === 4 || scenarios.indexOf(sc) === 5 ? ['@acted', '@confirmed', '@instructed', '@planned', '@sent', '@signed'] : ['@acted', '@confirmed', '@planned', '@sent', '@signed']));
    console.log(`crash matrix: ${sc.name}: ${total} cut points, all recovered`);
  }, 600_000);
});

// ---------------------------------------------------------------- Amendment 1: the watcher covers maker downtime (SPEC 11.6 "Sell direction")

describe('crash recovery: the daemon is down across the taker\'s claim-open time', () => {
  /** A buy-XMR swap, funded, with a notice for XMR that never arrives; then the daemon dies. */
  async function fundedThenDown(withWatcher: boolean) {
    const c: Ctx = { swap: null, step: 0, given: new Set() };
    const w = await makeWorld();
    const toml = withWatcher ? watcherToml(w, c) : BASE_TOML.replace('[markets.usdc_sol.buy_xmr]\nenabled = true', '[markets.usdc_sol.buy_xmr]\nenabled = true\nfreeze_window_hours = 24\ndeposit_pct = 1');
    writeFileSync(w.configPath, toml.replaceAll('__OWNER__', w.sim.owner));
    usdcAccount(w, w.keystore.solana.publicKey, 1_000_000_000_000n);
    const boot = () => w.boot(c.watcher ? { watcherFetch: c.watcher.fetch } : {});
    const d = await boot();
    await d.start();
    const s = w.sim.open({ direction: 1, asset: 1, xmr: 3n * XMR, wZ: 86_400 });
    await d.executor.tick(); // fund
    await d.executor.tick(); // hand the swap to the watcher
    expect(w.sim.swap(s.pda)!.state).toBe(SWAP_STATE.ACTIVE);
    const view = viewOf(w.sim, s.pda);
    const notice = buildNotice(view, s.keys.encSecret, Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex')), s.keys.view);
    w.sim.takerCall(s.pda, { name: 'post_notice' }, { noticeCommitment: notice.commitment, noticeCt: notice.ciphertext });
    // The process is gone. Only the database file, the chain, the Monero network and the watcher remain.
    d.store.close();
    return { w, c, s, boot };
  }

  it('without a watcher the escrow is lost: the taker of a false notice claims at T_co and the restarted daemon can do nothing', async () => {
    const { w, s, boot } = await fundedThenDown(false);
    const sw = w.sim.swap(s.pda)!;
    expect(sw.watcher).toBe('11111111111111111111111111111111');
    w.sim.setTime(sw.tClaimOpen);
    w.sim.takerCall(s.pda, { name: 'claim', secretOk: true }, { revealed: s.keys.spend });
    expect(w.sim.swap(s.pda)?.state ?? SWAP_STATE.DONE).toBe(SWAP_STATE.DONE);
    const d = await boot();
    await d.start();
    await d.executor.tick();
    expect(w.sim.names(s.pda)).not.toContain('refund');
    expect(w.sim.secretSends).toEqual([]);
    d.store.close();
  });

  it('with the watcher: its freeze is what saves the swap, and the daemon refunds after the restart; the take deposit is never held', async () => {
    const { w, c, s, boot } = await fundedThenDown(true);
    const wt = c.watcher!;
    const sw = w.sim.swap(s.pda)!;
    expect(sw.watcher).toBe(wt.solana);
    expect(wt.keys.has(s.pda)).toBe(true);
    // Before the cutoff the watcher waits: the notice opens, the lock may still arrive.
    w.sim.setTime(sw.tCut - 1n);
    expect(await wt.act(w.xmr)).toEqual([]);
    // At the cutoff the lock is not there: the watcher pauses the swap. It reveals nothing and moves nothing.
    w.sim.setTime(sw.tCut);
    expect(await wt.act(w.xmr)).toEqual([s.pda]);
    const frozen = w.sim.swap(s.pda)!;
    expect(frozen.state).toBe(SWAP_STATE.FROZEN);
    expect(frozen.amount).toBe(sw.amount);
    // The daemon is still down when the claim would have opened. The taker's claim is refused: the pause holds.
    w.sim.setTime(sw.tClaimOpen + 3_600n);
    expect(() => w.sim.takerCall(s.pda, { name: 'claim', secretOk: true }, { revealed: s.keys.spend })).toThrow('TooEarly');
    const tFf = deadlinesOf('solana', viewOf(w.sim, s.pda)).tFf!;
    expect(tFf).toBe(frozen.tFreeze + 86_400n);
    // The daemon comes back hours later, well inside the window the freeze bought, and refunds at once (Z3).
    w.sim.blockHeight += 5_000;
    const d = await boot();
    await d.start();
    const refund = w.sim.landed.find((l) => l.swap === s.pda && l.name === 'refund')!;
    expect(refund).toMatchObject({ stateBefore: SWAP_STATE.FROZEN, at: sw.tClaimOpen + 3_600n });
    expect(refund.at <= tFf - BigInt(CHAIN_CONSTS.solana.marginSecs)).toBe(true);
    expect(w.sim.secretSends).toEqual([{ name: 'refund', state: SWAP_STATE.FROZEN, at: refund.at }]);
    await d.executor.tick();
    // Settled as a back-out after a freeze: the escrow is the maker's again, the deposit went back at once (no hold, no withhold).
    expect(w.sim.swap(s.pda)?.state ?? SWAP_STATE.DONE).toBe(SWAP_STATE.DONE);
    expect(w.sim.maker().counters[COUNTER.backouts_after_freeze]).toBe(1);
    expect(w.sim.names(s.pda)).toEqual(expect.arrayContaining(['take', 'fund', 'post_notice', 'freeze', 'refund']));
    expect(w.sim.names(s.pda)).not.toContain('withhold');
    expect(w.sim.names(s.pda)).not.toContain('claim');
    expect(d.store.swap(s.pda)).toMatchObject({ terminal: 1 });
    // Recorded as the watcher's freeze, with the acknowledgement the daemon had kept across the restart.
    expect(d.store.freeze(s.pda)).toMatchObject({ direction: 1, frozen_by: 'maker_watcher', watcher: wt.solana, t_ff: Number(tFf) });
    expect(d.store.watchAck(s.pda)).toMatchObject({ watcher: wt.solana });
    expect(d.alerts.list(50).find((a) => a.kind === 'swap_frozen')).toMatchObject({ level: 'warning', swap_ref: s.pda });
    expect(d.store.intents({ status: ['planned', 'sent', 'needs_review'] })).toEqual([]);
    d.store.close();
  });
});
