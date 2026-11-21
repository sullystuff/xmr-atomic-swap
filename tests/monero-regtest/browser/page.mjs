// Browser entry point (bundled by esbuild into dist/page.js). Exposes the two things a taker's
// tab does on the Monero side: verify the lock with the view key (pure JS), and sweep with the
// joint key (@xmrswap/core-wasm, the `web` build of crates/swap-core).
import { verifyLock } from '../lib/verify.mjs';
import * as monero from '../lib/monero.mjs';
import * as core from '@xmrswap/core-wasm';

const big = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ready = core.init({ wasm: '/swap_core_bg.wasm' });

window.xmr = {
  /** Joint address two ways: the pure-JS library and the Rust core. They must agree. */
  async deriveJoint(makerHalf, takerHalf, network) {
    await ready;
    const j = monero.jointPublic({ spendPubA: makerHalf.spendPub, spendPubB: takerHalf.spendPub, viewPrivA: makerHalf.viewPriv, viewPrivB: takerHalf.viewPriv });
    const c = core.jointAddress(unhex(makerHalf.spendPub), unhex(takerHalf.spendPub), unhex(makerHalf.viewPriv), unhex(takerHalf.viewPriv), network);
    return { ...j, address: monero.encodeAddress(j.spendPub, j.viewPub, network), core: { address: c.address, spendPub: hex(c.spendPub), viewPriv: hex(c.viewPriv), viewPub: hex(c.viewPub) } };
  },
  /** Pure JS + fetch to each node's /json_rpc and /get_transactions. */
  async verify(args) { return big(await verifyLock({ ...args, minAmount: BigInt(args.minAmount) })); },
  /** Rust monero-wallet compiled to wasm32; fetches from ONE node. Spends exactly the named output. */
  async sweep({ daemonUrl, network, spendKey, viewKey, lockHeight, lockTxid, outputIndex, destination, maxFee, publish = true }) {
    await ready;
    try {
      return big(await core.sweepJoint({ daemonUrl, network, spendKey: unhex(spendKey), viewKey: unhex(viewKey), lockHeight, lockTxid: unhex(lockTxid), outputIndex: BigInt(outputIndex), destination, maxFee: BigInt(maxFee), publish }));
    } catch (e) {
      return { error: e.code ?? 'Unknown', message: String(e.message ?? e) };
    }
  },
};
document.getElementById('status').textContent = 'ready';
