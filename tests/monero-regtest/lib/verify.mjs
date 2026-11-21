// Verify an XMR lock with the joint private view key, without trusting any single node.
// What is checked locally (cryptographically, node cannot lie):
//   - the blob the node returned really hashes to the txid from the lock notice
//   - an output pays the joint address (one-time key derivation with the view key)
//   - the decrypted amount opens the Pedersen commitment in the tx
//   - unlock_time == 0, RingCT type is current
//   - no other output in the lock transaction or in its block carries the same one-time key
//     (two outputs with one key share a key image; only one can ever be spent)
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
    // Every other output key in the lock's block, to detect a duplicate of the lock's one-time key.
    out.blockOutputKeys = await blockOutputKeys(d, blk, txid);
  } else out.confirmations = 0;
  return out;
}

/** One-time output keys of every transaction in `blk` except `txid`: [{ txid, index, key }]. */
export async function blockOutputKeys(d, blk, txid) {
  const keys = [];
  for (const e of await d.txs((blk.tx_hashes || []).filter((h) => h !== txid))) {
    let t; try { t = parseTx(hexToBytes(e.as_hex || e.pruned_as_hex)); } catch { continue; } // e.g. v1 txs
    t.outputs.forEach((o, index) => keys.push({ txid: e.tx_hash, index, key: o.key }));
  }
  try { // the miner transaction's outputs
    JSON.parse(blk.json).miner_tx.vout.forEach((o, index) => { const key = o.target?.tagged_key?.key ?? o.target?.key; if (key) keys.push({ txid: blk.miner_tx_hash, index, key }); });
  } catch { /* a node that withholds the json only weakens its own answer */ }
  return keys;
}

/** Outputs carrying `key` other than `own` (an index in `tx`), in the lock tx and in its block. */
export function duplicateOutputs(tx, own, key, blockKeys = []) {
  return [
    ...tx.outputs.map((o, index) => ({ index, key: o.key })).filter((o) => o.index !== own && o.key === key).map((o) => `same transaction, output ${o.index}`),
    ...blockKeys.filter((o) => o.key === key).map((o) => `${o.txid}:${o.index}`),
  ];
}

/**
 * @param nodes        daemon RPC URLs (>= 2 independent ones in production; own node preferred)
 * @param txid         lock tx id from the lock notice
 * @param viewPriv     joint private view key (v_maker + v_taker), hex
 * @param spendPub     joint public spend key (S_maker + S_taker), hex
 * @param minAmount    piconero the swap requires (bigint)
 * @param minConf      required confirmations (2 / 10 / 25 by swap size)
 * @param minNodes     how many nodes must answer and agree (default: all given)
 * @returns { ok, state, reasons[], amount, confirmations, outputIndex, outputs[], nodes[] }
 *   outputIndex: index of the verified output inside the lock transaction (what the sweep spends)
 *   state: 'not-found' | 'invalid' | 'pending' | 'confirming' | 'confirmed'
 */
export async function verifyLock({ nodes, txid, viewPriv, spendPub, minAmount, minConf, minNodes = nodes.length }) {
  txid = txid.toLowerCase();
  const settled = await Promise.allSettled(nodes.map((u) => queryNode(u, txid)));
  const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { url: nodes[i], error: String(s.reason?.message || s.reason) }));
  const reasons = []; const answered = results.filter((r) => !r.error); const withTx = answered.filter((r) => r.found);
  const done = (state, extra = {}) => ({ ok: state === 'confirmed' && reasons.length === 0, state, reasons, nodes: results.map(({ tx, blockOutputKeys, ...r }) => r), ...extra });
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
  // 3b. The lock's one-time key must be unique in its transaction and in its block.
  if (good.length === 1) {
    const dups = [...new Set(withTx.flatMap((r) => duplicateOutputs(tx, good[0].index, good[0].key, r.blockOutputKeys)))];
    if (dups.length) reasons.push(`duplicate-output-key: the lock's one-time key also appears in ${dups.join(', ')}`);
  }
  const extra = { amount, outputs: good, outputIndex: good.length === 1 ? good[0].index : undefined, unlockTime: tx.unlockTime, fee: tx.fee };
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
