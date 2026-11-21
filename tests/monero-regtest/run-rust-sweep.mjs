#!/usr/bin/env node
// Sweep with the native binary of crates/swap-core (monero-oxide `monero-wallet`), no
// wallet-rpc involved. Proves the rules of SPEC 2.11:
//   - refused until the lock has 10 confirmations;
//   - the fee cap: the sweep fails rather than pay more than max_fee;
//   - exact-output selection: dust sent to the joint address in the lock's block is reported and
//     never spent; only the output named by (lock_txid, output_index) is.
// Build first: `pnpm build`.
import assert from 'node:assert/strict';
import { prepareLock, destinationReceived } from './browser/prepare-lock.mjs';
import { sweepNative } from './lib/sweep.mjs';
import { DAEMON_A } from './lib/rpc.mjs';

const params = (lock, extra = {}) => ({ daemonUrl: DAEMON_A, spendKey: lock.spendKey, viewKey: lock.viewKey, lockHeight: lock.lockHeight, lockTxid: lock.txid, outputIndex: lock.outputIndex, destination: lock.destination, ...extra });
const refused = async (p, pattern, what) => {
  await assert.rejects(sweepNative(p), (e) => { console.log(`${what} ->`, e.message); return pattern.test(e.message); });
};

// 1. The 10-block lock.
const early = await prepareLock({ conf: 9 });
await refused(params(early), /unlock at 10/, 'at 9 conf');

// 2. A lock with two dust payments to the same address in the same block.
const dust = [1_000_000_000n, 2_000_000_000n];
const lock = await prepareLock({ conf: 10, dust });
assert.equal(typeof lock.outputIndex, 'number');

// 2a. The fee cap. Nothing is signed or published when the fee is above it.
await refused(params(lock, { maxFee: 1n }), /fee \d+ is above the cap 1/, 'max_fee = 1 piconero');
// 2b. The named output must exist: another index, another txid.
await refused(params(lock, { outputIndex: lock.outputIndex === 0 ? 1 : 0 }), /named lock output was not found/, 'wrong output index');
await refused(params(lock, { lockTxid: 'ab'.repeat(32) }), /named lock output was not found/, 'wrong txid');
// 2c. A dry run signs and reports but does not publish.
const dry = await sweepNative(params(lock, { publish: false }));
assert.equal(dry.published, false);
assert.equal(BigInt(dry.amount) + BigInt(dry.fee), lock.amount);

// 2d. The real sweep spends exactly the lock output; the dust is ignored and listed.
const t0 = Date.now(); const out = await sweepNative(params(lock)); const ms = Date.now() - t0;
console.log({ ...out, txHex: `${out.txHex.length / 2} bytes`, ms });
assert.equal(out.jointAddress, lock.address);
assert.equal(out.published, true);
assert.equal(BigInt(out.amount) + BigInt(out.fee), lock.amount, 'the sweep spends the lock output and nothing else');
assert.deepEqual(out.ignored.map((i) => BigInt(i.amount)).sort(), [...dust].sort(), 'both dust outputs are reported as ignored');
assert.deepEqual(out.ignored.map((i) => i.output.split(':')[0]).sort(), [...lock.dustTxids].sort());
const got = await destinationReceived([out.txid]);
assert.equal(got, BigInt(out.amount)); console.log('destination received', got);

// 3. A dust output is spendable only by naming it; here it does not cover its own fee, so the
//    sweep refuses instead of creating a worthless transaction.
const [dustTxid, dustIndex] = out.ignored[0].output.split(':');
await refused(params(lock, { lockTxid: dustTxid, outputIndex: Number(dustIndex) }), /does not cover fee|above the cap/, 'named dust output');
console.log('RUST NATIVE SWEEP OK');
