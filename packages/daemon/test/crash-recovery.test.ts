// Crash recovery (SPEC 7.4, 7.6, scenario D-1): the daemon is killed at EVERY point of the
// intent journal (row planned, transaction signed, transaction sent, action done, result
// recorded) of every action of four swaps, restarted on the same database, and driven on.
// Whatever the cut point: one Monero lock transaction per swap, the notice before the XMR, no
// spend share broadcast outside its window, and the claim or refund that was due still lands.
import { beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { COUNTER, CHAIN_CONSTS, SWAP_FLAG, SWAP_STATE } from '@xmrswap/protocol';
import { ata } from '@xmrswap/sdk';
import type { Daemon } from '../src/daemon.js';
import { CrashError } from '../src/store/journal.js';
import { type OpenedSwap, XMR, buildNotice, swapJointAddress, viewOf } from './sim.js';
import { type World, makeWorld } from './world.js';

beforeAll(async () => {
  await init();
});

interface Ctx {
  swap: OpenedSwap | null;
  fakeTxid?: string;
  step: number;
}
interface Scenario {
  name: string;
  /** The world outside the daemon: the taker, the Monero miners and the clock. State-driven, so it resumes after a restart. */
  env(w: World, d: Daemon, c: Ctx): void;
  check(w: World, d: Daemon, c: Ctx): void;
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
      if (offer?.enabled && (offer.poolFilled & ~offer.poolUsed) !== 0) c.swap = sim.open({ direction: 0, xmr: 2n * XMR, makerSpendPub: sim.takePoolKey(0) });
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
  const w = await makeWorld();
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
  const c: Ctx = { swap: null, step: 0 };
  let d = await w.boot({ crash: hook });
  let started = false;
  for (let round = 0; round < 80; round++) {
    try {
      if (!started) {
        await d.start();
        started = true;
      }
      sc.env(w, d, c);
      await d.executor.tick();
      await d.offers.tick(true);
      if (c.swap && d.store.swap(c.swap.pda)?.terminal) break;
    } catch (e) {
      if (!(e instanceof CrashError)) throw e;
      // The process is gone: only the database file, the chain and the Monero network remain.
      d.store.close();
      // Long enough for every blockhash signed before the crash to expire.
      w.sim.blockHeight += 5_000;
      d = await w.boot({ crash: hook });
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

const scenarios = [directionA(false), directionA(true), directionB(false), directionB(true)];

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
    expect([...seen].sort()).toEqual(sc === scenarios[3] ? ['@planned', '@sent', '@signed'] : ['@acted', '@confirmed', '@planned', '@sent', '@signed']);
    console.log(`crash matrix: ${sc.name}: ${total} cut points, all recovered`);
  }, 600_000);
});
