#!/usr/bin/env node
// Taker-sells-XMR: someone pays the joint address from an ordinary wallet without telling us the
// txid. Find it by view-key scanning (through a RESTRICTED node, like a public one), then verify.
// Also sweeps through the restricted node with the Rust binary to show public-node RPC suffices.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as m from './lib/monero.mjs';
import { findDeposits } from './lib/watch.mjs';
import { verifyLock } from './lib/verify.mjs';
import { DAEMON_A, DAEMON_B_RESTRICTED, Daemon } from './lib/rpc.mjs';
import { daemonA, mine, fund, ensureFunded, wallet, XMR } from './lib/harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = m.generateKeyHalf(), b = m.generateKeyHalf();
const j = m.jointPublic({ spendPubA: a.spendPub, spendPubB: b.spendPub, viewPrivA: a.viewPriv, viewPrivB: b.viewPriv });
const address = m.encodeAddress(j.spendPub, j.viewPub, 'regtest');
console.log('restricted node says:', (await new Daemon(DAEMON_B_RESTRICTED).info()).restricted);
await ensureFunded(); const fromHeight = (await daemonA.info()).height;
console.log(`pay request: monero:${address}?tx_amount=1.5`);
const { txid } = await fund(address, 15n * XMR / 10n);
const args = { node: DAEMON_B_RESTRICTED, viewPriv: j.viewPriv, spendPub: j.spendPub, fromHeight };
// The tx reaches OTHER nodes' mempools only after Dandelion++ relay delays (seconds), so poll.
let r; const t0 = Date.now();
for (;;) { r = await findDeposits(args); if (r.found.length || Date.now() - t0 > 90_000) break; await sleep(500); }
console.log(`mempool scan (seen on node B after ${((Date.now() - t0) / 1000).toFixed(1)}s):`, r); assert.equal(r.found[0]?.txid, txid); assert.equal(r.found[0].inPool, true);
await mine(10); r = await findDeposits(args); console.log('after 10 blk :', r); assert.equal(r.found[0]?.txid, txid); assert.equal(r.found.length, 1);
const v = await verifyLock({ nodes: [DAEMON_A, DAEMON_B_RESTRICTED], txid: r.found[0].txid, viewPriv: j.viewPriv, spendPub: j.spendPub, minAmount: 15n * XMR / 10n, minConf: 10 });
console.log('verify       :', v.state, v.ok, 'conf', v.confirmations); assert.equal(v.ok, true);
const bin = fileURLToPath(new URL('./rust-sweep/target/release/xmr-joint-sweep', import.meta.url));
if (existsSync(bin)) {
  await wallet.openOrCreate('taker-dest'); const dest = await wallet.address(); await wallet.close();
  const out = JSON.parse(execFileSync(bin, [DAEMON_B_RESTRICTED, 'regtest', m.jointSpendPriv(a.spendPriv, b.spendPriv), j.viewPriv, String(r.found[0].blockHeight), dest], { encoding: 'utf8' }));
  console.log('sweep via restricted RPC:', out.txid, 'amount', out.amount); assert.equal(out.published, true);
  await mine(1);
}
console.log('DEPOSIT WATCH OK');
