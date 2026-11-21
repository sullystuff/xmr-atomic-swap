// Find payments to the joint address when no txid was announced (taker-sells-XMR: the taker pays
// from their own wallet, the page just watches). Scans the mempool and blocks >= fromHeight with
// the view key. Output: candidate txids; run verifyLock() on each before believing anything.
import { Daemon } from './rpc.mjs';
import { parseTx, scanTx, hexToBytes } from './monero.mjs';

export async function findDeposits({ node, viewPriv, spendPub, fromHeight }) {
  const d = new Daemon(node); const info = await d.info();
  const hashes = new Set(await d.poolHashes());
  for (let h = Math.max(0, fromHeight); h < info.height; h++) for (const t of (await d.block(h)).tx_hashes || []) hashes.add(t);
  const found = [];
  for (const e of await d.txs([...hashes])) {
    let tx; try { tx = parseTx(hexToBytes(e.as_hex || e.pruned_as_hex)); } catch { continue; } // e.g. v1 txs
    const outs = scanTx(tx, viewPriv, spendPub);
    if (outs.length) found.push({ txid: e.tx_hash, inPool: !!e.in_pool, blockHeight: e.in_pool ? null : e.block_height, amount: outs.reduce((a, o) => a + o.amount, 0n) });
  }
  return { scannedTxs: hashes.size, tipHeight: info.height, found };
}
