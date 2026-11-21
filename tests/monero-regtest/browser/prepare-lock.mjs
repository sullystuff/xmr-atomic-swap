// Shared by the Node and browser sweep tests: create a joint address, fund it, mine `conf` blocks,
// verify the lock, and return everything a sweeper needs.
import * as m from '../lib/monero.mjs';
import { verifyLock } from '../lib/verify.mjs';
import { daemonA, wallet, NODES, mine, fund, ensureFunded, XMR } from '../lib/harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function prepareLock({ amount = 2n * XMR, conf = 10 } = {}) {
  const maker = m.generateKeyHalf(), taker = m.generateKeyHalf();
  const joint = m.jointPublic({ spendPubA: maker.spendPub, spendPubB: taker.spendPub, viewPrivA: maker.viewPriv, viewPrivB: taker.viewPriv });
  const address = m.encodeAddress(joint.spendPub, joint.viewPub, 'regtest');
  await ensureFunded(); const restoreHeight = (await daemonA.info()).height - 1;
  const lock = await fund(address, amount); await sleep(1500); if (conf) await mine(conf);
  const v = await verifyLock({ nodes: NODES, txid: lock.txid, viewPriv: joint.viewPriv, spendPub: joint.spendPub, minAmount: amount, minConf: conf });
  if (conf && !v.ok) throw new Error('lock did not verify: ' + JSON.stringify(v.reasons));
  await wallet.openOrCreate('taker-dest'); const destination = await wallet.address(); await wallet.close();
  const lockHeight = conf ? (await daemonA.tx(lock.txid)).block_height : null;
  return { lockHeight, address, viewKey: joint.viewPriv, spendPub: joint.spendPub, spendKey: m.jointSpendPriv(maker.spendPriv, taker.spendPriv), restoreHeight, destination, amount, txid: lock.txid };
}
export async function destinationReceived(txids) {
  await mine(1); await wallet.openOrCreate('taker-dest'); await wallet.refresh();
  const r = await wallet.call('get_transfers', { in: true, pool: true }); await wallet.close();
  return [...(r.in || []), ...(r.pool || [])].filter((t) => txids.includes(t.txid)).reduce((a, t) => a + BigInt(t.amount), 0n);
}
