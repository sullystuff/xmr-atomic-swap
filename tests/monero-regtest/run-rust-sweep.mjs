#!/usr/bin/env node
// Sweep with the native Rust prototype (monero-oxide `monero-wallet`), no wallet-rpc involved.
// Build first: (cd rust-sweep && cargo build --release)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareLock, destinationReceived } from './browser/prepare-lock.mjs';
import { DAEMON_A } from './lib/rpc.mjs';
const bin = fileURLToPath(new URL('./rust-sweep/target/release/xmr-joint-sweep', import.meta.url));
const run = (lock, ...extra) => execFileSync(bin, [DAEMON_A, 'regtest', lock.spendKey, lock.viewKey, String(lock.lockHeight), lock.destination, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const early = await prepareLock({ conf: 9 });
assert.throws(() => run(early), (e) => { console.log('at 9 conf ->', e.stderr.trim()); return /unlock at 10/.test(e.stderr); });

const lock = await prepareLock({ conf: 10 });
const t0 = Date.now(); const out = JSON.parse(run(lock)); const ms = Date.now() - t0;
console.log({ ...out, txHex: `${out.txHex.length / 2} bytes`, ms });
assert.equal(out.jointAddress, lock.address);
assert.equal(BigInt(out.amount) + BigInt(out.fee), lock.amount);
const got = await destinationReceived([out.txid]);
assert.equal(got, BigInt(out.amount)); console.log('destination received', got, '\nRUST NATIVE SWEEP OK');
