#!/usr/bin/env node
// End-to-end proof on regtest: two key halves -> joint address -> fund -> verify by view key
// across two nodes -> wait out the 10-block lock -> sweep with the summed spend key.
// Run ./start.sh first. Exits non-zero on any failed expectation.
import assert from 'node:assert/strict';
import * as m from './lib/monero.mjs';
import { verifyLock } from './lib/verify.mjs';
import { daemonA, wallet, NODES, mine, fund, ensureFunded, sweepWithWalletRpc, XMR } from './lib/harness.mjs';

const AMOUNT = 3n * XMR + 141592653589n;       // 3.141592653589 XMR
const CONF = Number(process.env.CONF || 10);    // confirmation depth to wait for
const log = (...a) => console.log(...a);
const show = (r) => `${r.state}${r.ok ? ' OK' : ''} conf=${r.confirmations ?? '-'} amount=${r.amount !== undefined ? m.fmtXmr(r.amount) : '-'}${r.reasons.length ? ' reasons=' + JSON.stringify(r.reasons) : ''}`;

// 1. Each side makes its halves. Only the PUBLIC spend halves and the PRIVATE view halves are exchanged.
const maker = m.generateKeyHalf(), taker = m.generateKeyHalf();
const joint = m.jointPublic({ spendPubA: maker.spendPub, spendPubB: taker.spendPub, viewPrivA: maker.viewPriv, viewPrivB: taker.viewPriv });
const address = m.encodeAddress(joint.spendPub, joint.viewPub, 'regtest');
log('maker  S_m =', maker.spendPub, ' v_m =', maker.viewPriv);
log('taker  S_t =', taker.spendPub, ' v_t =', taker.viewPriv);
log('joint  S   =', joint.spendPub, ' v   =', joint.viewPriv);
log('joint address (regtest = mainnet prefix 18):', address);
for (const net of ['mainnet', 'stagenet', 'testnet']) log(`  same keys on ${net.padEnd(8)}:`, m.encodeAddress(joint.spendPub, joint.viewPub, net));
assert.deepEqual(m.decodeAddress(address), { prefix: 18, networks: ['mainnet', 'regtest'], kind: 'standard', spendPub: joint.spendPub, viewPub: joint.viewPub });

// Independent check of our derivation + encoding: monero-wallet-rpc refuses generate_from_keys
// unless the view key matches the address, and reports the same address back.
await ensureFunded();
const h0 = (await daemonA.info()).height;
const vo = await wallet.fromKeys({ name: `viewonly-${Date.now()}`, address, viewKey: joint.viewPriv, restoreHeight: h0 - 1 });
assert.equal(vo.address, address); await wallet.close();
log('wallet-rpc accepts (address, joint view key) as a view-only wallet');

// 2. Maker locks XMR.
await ensureFunded();
const lock = await fund(address, AMOUNT);
log(`\nlock tx ${lock.txid} (fee ${m.fmtXmr(lock.fee)})`);
const base = { nodes: NODES, txid: lock.txid, viewPriv: joint.viewPriv, spendPub: joint.spendPub, minAmount: AMOUNT, minConf: CONF };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 100; i++) { const r = await f(); if (r) return r; await sleep(200); } throw new Error('timeout'); };

// 3. Verify in the mempool (0 conf), then negative cases.
let r = await until(async () => { const x = await verifyLock(base); return x.nodes.every((n) => n.found) && x; });
log('mempool          :', show(r)); assert.equal(r.state, 'pending'); assert.equal(r.amount, AMOUNT); assert.equal(r.ok, false);
r = await verifyLock({ ...base, viewPriv: maker.viewPriv });   // a single half is not the view key
log('wrong view key   :', show(r)); assert.equal(r.state, 'invalid');
r = await verifyLock({ ...base, minAmount: AMOUNT + 1n });
log('amount too small :', show(r)); assert.equal(r.state, 'invalid');
r = await verifyLock({ ...base, txid: 'ab'.repeat(32) });
log('unknown txid     :', show(r)); assert.equal(r.state, 'not-found');
r = await verifyLock({ ...base, nodes: [NODES[0], 'http://127.0.0.1:48099'] }); // one node down => never "ok"
log('one node down    :', show(r)); assert.equal(r.ok, false);

// 4. Confirmations, and the 10-block spend lock.
await mine(1); r = await verifyLock(base);
log('after 1 block    :', show(r)); assert.equal(r.confirmations, 1); assert.equal(r.state, CONF > 1 ? 'confirming' : 'confirmed');
const spendKey = m.jointSpendPriv(maker.spendPriv, taker.spendPriv);   // what a claim (or refund) reveals
assert.ok(m.halfMatches(maker.spendPriv, maker.spendPub));              // the on-chain check of the revealed half
await wallet.openOrCreate('taker-dest'); const destination = await wallet.address();
const sweepArgs = { name: `joint-${Date.now()}`, address, viewKey: joint.viewPriv, spendKey, restoreHeight: h0 - 1, destination };
await assert.rejects(sweepWithWalletRpc(sweepArgs), (e) => { log('sweep at 1 conf  : refused ->', e.message); return e.locked === true; });
await mine(8); r = await verifyLock(base);
log('after 9 blocks   :', show(r)); assert.equal(r.confirmations, 9);
await assert.rejects(sweepWithWalletRpc({ ...sweepArgs, name: sweepArgs.name + 'b' }), (e) => { log('sweep at 9 conf  : refused ->', e.message); return e.locked === true; });
await mine(Math.max(1, CONF - 9)); r = await verifyLock(base);
log(`after ${r.confirmations} blocks  :`, show(r)); assert.equal(r.ok, true); assert.equal(r.state, 'confirmed');

// 5. Sweep with s = s_maker + s_taker.
const sw = await sweepWithWalletRpc({ ...sweepArgs, name: sweepArgs.name + 'c' });
log(`\nsweep tx ${sw.txids.join(',')} amount ${m.fmtXmr(sw.amount)} fee ${m.fmtXmr(sw.fee)}`);
assert.equal(sw.amount + sw.fee, AMOUNT);
await mine(1);
await wallet.openOrCreate('taker-dest'); await wallet.refresh();
const incoming = (await wallet.call('get_transfers', { in: true })).in || []; await wallet.close();
const got = incoming.filter((t) => sw.txids.includes(t.txid)).reduce((a, t) => a + BigInt(t.amount), 0n);
log('destination wallet received', m.fmtXmr(got), 'XMR'); assert.equal(got, AMOUNT - sw.fee);
log('\nE2E OK');
