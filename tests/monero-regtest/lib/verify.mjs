// Verify an XMR lock with the joint private view key, without trusting any single node.
// What is checked locally (cryptographically, node cannot lie):
//   - the blob the node returned really hashes to the txid from the lock notice
//   - an output pays the joint address (one-time key derivation with the view key)
//   - the decrypted amount opens the Pedersen commitment in the tx
//   - unlock_time == 0, RingCT type is current
// What still depends on nodes (they can lie by omission or serve a fake fork; a browser cannot
// check RandomX proof-of-work): that the tx is mined, and how deep. So we ask several nodes
// and require them to agree on the block hash at the tx's height; depth = the MINIMUM reported.
import { Daemon } from './rpc.mjs';
import { parseTx, computeTxid, scanTx, hexToBytes } from './monero.mjs';

export async function queryNode(url, txid) {
  const d = new Daemon(url);
  const [info, e] = await Promise.all([d.info(), d.tx(txid)]);
  const out = { url, height: info.height, topHash: info.top_block_hash, nettype: info.nettype, synchronized: info.synchronized, found: !!e };
  if (!e) return out;
  // Full nodes return as_hex; pruned nodes return pruned_as_hex + prunable_hash.
  const blob = e.as_hex || e.pruned_as_hex; const tx = parseTx(hexToBytes(blob));
  out.tx = tx; out.computedTxid = computeTxid(tx, e.as_hex ? undefined : e.prunable_hash);
  out.inPool = !!e.in_pool; out.doubleSpendSeen = !!e.double_spend_seen;
  if (!out.inPool) {
    out.blockHeight = e.block_height;
    const blk = await d.block(e.block_height);
    out.blockHash = blk.block_header.hash;
    out.blockListsTx = (blk.tx_hashes || []).includes(txid);
    out.confirmations = info.height - e.block_height; // tx in the top block = 1 confirmation
  } else out.confirmations = 0;
  return out;
}

/**
 * @param nodes        daemon RPC URLs (>= 2 independent ones in production; own node preferred)
 * @param txid         lock tx id from the lock notice
 * @param viewPriv     joint private view key (v_maker + v_taker), hex
 * @param spendPub     joint public spend key (S_maker + S_taker), hex
 * @param minAmount    piconero the swap requires (bigint)
 * @param minConf      required confirmations (2 / 10 / 25 by swap size)
 * @param minNodes     how many nodes must answer and agree (default: all given)
 * @returns { ok, state, reasons[], amount, confirmations, outputs[], nodes[] }
 *   state: 'not-found' | 'invalid' | 'pending' | 'confirming' | 'confirmed'
 */
export async function verifyLock({ nodes, txid, viewPriv, spendPub, minAmount, minConf, minNodes = nodes.length }) {
  txid = txid.toLowerCase();
  const settled = await Promise.allSettled(nodes.map((u) => queryNode(u, txid)));
  const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { url: nodes[i], error: String(s.reason?.message || s.reason) }));
  const reasons = []; const answered = results.filter((r) => !r.error); const withTx = answered.filter((r) => r.found);
  const done = (state, extra = {}) => ({ ok: state === 'confirmed' && reasons.length === 0, state, reasons, nodes: results.map(({ tx, ...r }) => r), ...extra });
  for (const r of results) if (r.error) reasons.push(`node ${r.url} failed: ${r.error}`);
  if (answered.length < minNodes) { reasons.push(`only ${answered.length}/${minNodes} nodes answered`); }
  if (withTx.length === 0) return done('not-found');

  // 1. Every returned blob must hash to the txid. A node serving anything else is lying.
  for (const r of withTx) if (r.computedTxid !== txid) { reasons.push(`node ${r.url} returned a blob hashing to ${r.computedTxid}`); return done('invalid'); }
  // (All honest blobs are now byte-identical in prefix + rct base, so decode once.)
  const tx = withTx[0].tx;

  // 2. Static policy on the tx itself.
  if (tx.unlockTime !== 0n) reasons.push(`unlock_time is ${tx.unlockTime}, must be 0 (funds would be time-locked)`);
  if (tx.rctType !== 6) reasons.push(`unexpected RingCT type ${tx.rctType} (want 6, Bulletproofs+)`);

  // 3. View-key scan: which outputs pay the joint address, and how much.
  const outputs = scanTx(tx, viewPriv, spendPub);
  const good = outputs.filter((o) => o.commitmentOk);
  if (outputs.length !== good.length) reasons.push('an output to us has an amount that does not open its commitment');
  const amount = good.reduce((a, o) => a + o.amount, 0n);
  if (good.length === 0) reasons.push('no output of this tx pays the joint address');
  else if (amount < minAmount) reasons.push(`pays ${amount} piconero, need ${minAmount}`);
  if (good.length > 1) reasons.push(`${good.length} outputs to the joint address; policy expects exactly 1`);
  const extra = { amount, outputs: good, unlockTime: tx.unlockTime, fee: tx.fee };
  if (reasons.some((r) => !r.startsWith('node ') && !r.startsWith('only '))) return done('invalid', extra);

  // 4. Inclusion and depth: need agreement between nodes.
  if (withTx.some((r) => r.doubleSpendSeen)) reasons.push('a node flags a double spend of this tx');
  const mined = withTx.filter((r) => !r.inPool);
  if (mined.some((r) => !r.blockListsTx)) reasons.push('a node reports a block that does not list the tx');
  if (new Set(mined.map((r) => `${r.blockHeight}:${r.blockHash}`)).size > 1) reasons.push('nodes disagree on the block containing the tx (fork or lying node)');
  if (mined.length && mined.length < Math.max(minNodes, answered.length)) reasons.push(`tx is mined on only ${mined.length}/${answered.length} answering nodes`);
  // Depth is the worst case over every node that answered: absent or mempool counts as 0.
  const confirmations = Math.min(...answered.map((r) => (r.found ? r.confirmations : 0)));
  if (mined.length === 0) return done('pending', { ...extra, confirmations: 0 });
  const blocking = reasons.length > 0;
  return done(!blocking && confirmations >= minConf ? 'confirmed' : 'confirming', { ...extra, confirmations });
}
