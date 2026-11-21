#!/usr/bin/env node
// Edge cases the verifier must catch: (1) a lock with a non-zero unlock_time, (2) a reorg that
// un-confirms the lock. Run after ./start.sh.
import assert from 'node:assert/strict';
import * as m from './lib/monero.mjs';
import { verifyLock } from './lib/verify.mjs';
import { daemonA, wallet, NODES, mine, fund, ensureFunded, waitSynced, XMR } from './lib/harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (r) => ({ state: r.state, ok: r.ok, conf: r.confirmations, reasons: r.reasons, nodes: r.nodes.map((n) => `${n.found ? (n.inPool ? 'pool' : 'h' + n.blockHeight) : 'absent'}@${n.height}`) });
const mk = () => { const a = m.generateKeyHalf(), b = m.generateKeyHalf(); const j = m.jointPublic({ spendPubA: a.spendPub, spendPubB: b.spendPub, viewPrivA: a.viewPriv, viewPrivB: b.viewPriv }); return { ...j, address: m.encodeAddress(j.spendPub, j.viewPub, 'regtest') }; };
await ensureFunded();

// (1) time-locked lock tx
{
  const j = mk(); const h = (await daemonA.info()).height;
  let lock; try { lock = await fund(j.address, XMR, { unlockTime: h + 5000 }); } catch (e) { console.log('wallet refused to build a time-locked tx:', e.message); }
  if (lock) {
    await mine(10);
    const r = await verifyLock({ nodes: NODES, txid: lock.txid, viewPriv: j.viewPriv, spendPub: j.spendPub, minAmount: XMR, minConf: 10 });
    console.log('time-locked lock:', brief(r)); assert.equal(r.state, 'invalid'); assert.match(r.reasons.join(), /unlock_time/);
  }
}
// (1b) lock tx that also pays a subaddress: outputs then use per-output "additional" tx keys.
{
  const j = mk(); await wallet.openOrCreate('miner'); const sub = (await wallet.call('create_address', { account_index: 0 })).address;
  const r0 = await wallet.call('transfer', { destinations: [{ address: j.address, amount: Number(XMR) }, { address: sub, amount: Number(XMR) }], priority: 0, ring_size: 16 });
  await sleep(1500); await mine(2);
  const r = await verifyLock({ nodes: NODES, txid: r0.tx_hash, viewPriv: j.viewPriv, spendPub: j.spendPub, minAmount: XMR, minConf: 2 });
  console.log('lock tx with additional tx keys:', brief(r), 'amount', r.amount); assert.equal(r.ok, true); assert.equal(r.amount, XMR);
}
// (2) reorg: lock gets 2 confirmations, then node A builds a longer chain that does not contain it.
{
  const j = mk(); const lock = await fund(j.address, XMR);
  const args = { nodes: NODES, txid: lock.txid, viewPriv: j.viewPriv, spendPub: j.spendPub, minAmount: XMR, minConf: 2 };
  await sleep(1500); await mine(2);
  let r = await verifyLock(args); console.log('before reorg    :', brief(r)); assert.equal(r.ok, true);
  await daemonA.other('pop_blocks', { nblocks: 2 });          // A forgets the 2 blocks...
  await daemonA.json('flush_txpool', {});                     // ...and the lock tx with them
  r = await verifyLock(args); console.log('A popped 2      :', brief(r)); assert.equal(r.ok, false);
  await mine(3).catch(() => {});                              // A's fork (3 blocks, no lock tx) outgrows B's
  await waitSynced();
  r = await verifyLock(args); console.log('after reorg     :', brief(r)); assert.equal(r.ok, false); assert.notEqual(r.state, 'confirmed');
  // The tx fell back to B's mempool; whether it is re-mined depends on it being relayed again.
  for (let i = 0; i < 20 && !(await daemonA.tx(lock.txid).then((e) => e && e.in_pool !== undefined && !('missed' in e))); i++) await sleep(500);
  await mine(2); r = await verifyLock(args); console.log('2 blocks later  :', brief(r));
}
console.log('EDGE CASES OK');
