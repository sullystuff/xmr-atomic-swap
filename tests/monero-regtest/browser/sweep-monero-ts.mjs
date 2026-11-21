// Sweep a joint address with monero-ts (wallet2 compiled to WASM). The same function runs in
// Node and in a browser tab; the wallet lives only in memory and talks to ONE daemon RPC URL.
/**
 * @param moneroTs     the monero-ts module (default export)
 * @param o.daemonUrl  monerod RPC the wallet scans and broadcasts through (must allow CORS in a browser)
 * @param o.networkType 'mainnet' | 'stagenet' | 'testnet' (regtest uses 'mainnet')
 * @param o.address, o.viewKey, o.spendKey   joint address, v_m+v_t, s_m+s_t
 * @param o.restoreHeight  a height at or just below the lock tx's block: the wallet scans only from here
 * @param o.destination    where the XMR goes
 * @param o.relay          false = build + sign only (dry run)
 */
export async function sweepJoint(moneroTs, o) {
  const t0 = Date.now();
  const wallet = await moneroTs.createWalletFull({
    networkType: moneroTs.MoneroNetworkType[(o.networkType || 'mainnet').toUpperCase()],
    primaryAddress: o.address, privateViewKey: o.viewKey, privateSpendKey: o.spendKey,
    restoreHeight: o.restoreHeight, password: 'x',
    server: { uri: o.daemonUrl, ...(o.proxyToWorker !== undefined ? { proxyToWorker: o.proxyToWorker } : {}) },
    ...(o.proxyToWorker !== undefined ? { proxyToWorker: o.proxyToWorker } : {}),
  });
  try {
    if ((await wallet.getPrimaryAddress()) !== o.address) throw new Error('keys do not match the joint address');
    await wallet.sync();
    const balance = await wallet.getBalance(), unlocked = await wallet.getUnlockedBalance();
    const syncMs = Date.now() - t0;
    if (unlocked === 0n) return { swept: false, balance: balance.toString(), unlocked: '0', syncMs };
    const txs = await wallet.sweepUnlocked({ address: o.destination, relay: o.relay !== false });
    return { swept: true, relayed: o.relay !== false, balance: balance.toString(), unlocked: unlocked.toString(), syncMs, totalMs: Date.now() - t0,
      txids: txs.map((t) => t.getHash()), fee: txs.reduce((a, t) => a + t.getFee(), 0n).toString(),
      amount: txs.reduce((a, t) => a + t.getOutgoingAmount(), 0n).toString() };
  } finally { await wallet.close(false); }
}
