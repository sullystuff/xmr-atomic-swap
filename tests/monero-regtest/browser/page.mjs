// Browser entry point (bundled by esbuild into dist/page.js). Exposes the two things a taker's
// tab does on the Monero side: verify the lock with the view key, and sweep with the joint key.
import { verifyLock } from '../lib/verify.mjs';
import * as monero from '../lib/monero.mjs';
import initWasm, { sweepJoint } from './pkg/xmr_joint_sweep.js';

const big = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
window.xmr = {
  /** Pure JS (noble): key math, address encoding. */
  deriveJoint(makerHalf, takerHalf, network) {
    const j = monero.jointPublic({ spendPubA: makerHalf.spendPub, spendPubB: takerHalf.spendPub, viewPrivA: makerHalf.viewPriv, viewPrivB: takerHalf.viewPriv });
    return { ...j, address: monero.encodeAddress(j.spendPub, j.viewPub, network) };
  },
  /** Pure JS + fetch to each node's /json_rpc and /get_transactions. */
  async verify(args) { return big(await verifyLock({ ...args, minAmount: BigInt(args.minAmount) })); },
  /** Rust monero-wallet compiled to wasm32; fetches from ONE node. */
  async sweep({ daemonUrl, network, spendKey, viewKey, lockHeight, destination, publish = true }) {
    await initWasm({ module_or_path: new URL('/pkg/xmr_joint_sweep_bg.wasm', location.origin) });
    return JSON.parse(await sweepJoint(daemonUrl, network, spendKey, viewKey, lockHeight, destination, publish));
  },
};
document.getElementById('status').textContent = 'ready';
