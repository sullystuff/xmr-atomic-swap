// Monero integration (M2): verifyLock and findDeposits against the two regtest daemons of
// tests/monero-regtest (start it with `./start.sh --fresh`; `XMR_BIN` locates the binaries).
import { describe, expect, it } from 'vitest';
import { daemonNode } from '../../src/monero/rpc.js';
import { MONERO_NODES } from './harness.js';

describe('regtest daemons', () => {
  it('both nodes answer and agree on the chain tip', async () => {
    const [a, b] = await Promise.all(MONERO_NODES.map((u) => daemonNode(u, { timeoutMs: 5_000 }).info()));
    expect(a!.nettype).toBe('fakechain');
    expect(Math.abs(a!.height - b!.height)).toBeLessThanOrEqual(1);
  });
});

describe('verification against real nodes', () => {
  it.todo('a lock to a joint address: pending at 0 confirmations, confirming, confirmed at depth on both nodes');
  it.todo('N-1 the nodes disagree, one node down, a 2-block reorg after the lock: never "confirmed"');
  it.todo('N-2 dust outputs in the lock block are ignored; a real duplicate one-time key is reported invalid');
  it.todo('findDeposits finds a payment made from a plain wallet (direction B)');
  it.todo('sweepJoint spends exactly the output verifyLock returned, with sweepMaxFee');
});
