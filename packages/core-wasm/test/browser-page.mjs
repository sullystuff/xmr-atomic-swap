// Browser entry point for test/browser.mjs (bundled by esbuild). Runs the web build of the
// wasm core inside a real tab and hands the results back for comparison with the node build.
import * as core from '../dist/index.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

window.coreTest = async (input) => {
  await core.init({ wasm: '/swap_core_bg.wasm' });
  const seed = unhex(input.seed);
  const shareId = unhex(input.shareId);
  const ctx = unhex(input.ctx);
  const out = { version: core.coreVersion(), keys: {} };
  for (const [name, tag] of [['solana', 1], ['ethereum', 2]]) {
    const k = core.deriveKeys(seed, tag, shareId);
    out.keys[name] = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, hex(v)]));
  }
  const sol = core.deriveKeys(seed, 1, shareId);
  const eth = core.deriveKeys(seed, 2, shareId);
  out.pok = hex(core.pokProve(sol.spend, ctx));
  out.pokOk = core.pokVerify(sol.spendPub, ctx, unhex(out.pok));
  out.twin = Object.fromEntries(Object.entries(core.twinCommitments(eth.spend)).map(([k, v]) => [k, hex(v)]));
  // The cross-curve proof, proved in the tab with crypto.getRandomValues...
  const t0 = performance.now();
  const blob = core.dleqProve(eth.spend);
  const t1 = performance.now();
  const st = core.dleqVerify(blob);
  out.dleq = { length: blob.length, proveMs: Math.round(t1 - t0), verifyMs: Math.round(performance.now() - t1), keyAddr: hex(st.keyAddr), keyAddr2: hex(st.keyAddr2), spendPub: hex(st.spendPub) };
  out.blob = hex(blob);
  // ...and a blob proved in Node, verified in the tab.
  const fromNode = core.dleqVerify(unhex(input.nodeBlob));
  out.nodeBlobKeyAddr = hex(fromNode.keyAddr);
  let tampered = 'accepted';
  try {
    const bad = unhex(input.nodeBlob);
    bad[7000] ^= 1;
    core.dleqVerify(bad);
  } catch (e) {
    tampered = e.code;
  }
  out.tampered = tampered;
  // Deterministic sealing with fixed nonces.
  const nonce = new Uint8Array(24).fill(5);
  out.envelope = hex(core.envelopeSeal({ fromMaker: false, makerKeyVersion: 1, ownSecret: sol.encSecret, peerPub: eth.encPub, plaintext: new TextEncoder().encode('{"t":"ack"}'), nonce }));
  out.notice = hex(core.noticeSeal({ ownSecret: sol.encSecret, peerPub: eth.encPub, side: 'taker', swapRef: ctx, txid: ctx, view: sol.view, nonce }));
  out.pay = core.payAmount(123_456_789_012n, 987_654_321_987n, 'solana').toString();
  out.joint = core.jointAddress(sol.spendPub, eth.spendPub, sol.view, eth.view, 'stagenet').address;
  // The reference model and the tier lookup in the web build.
  out.model = input.modelSteps.reduce(
    (acc, step) => {
      const fx = core.modelApply(input.modelChain, acc.state, { call: step.call, args: step.args }, step.caller, step.at, step.env);
      acc.results.push(fx);
      acc.state = fx.swap;
      return acc;
    },
    { state: null, results: [] },
  ).results;
  let refused = 'accepted';
  try {
    core.modelApply(input.modelChain, null, { call: 'claim', args: { secret_ok: true } }, 'operator', 1);
  } catch (e) {
    refused = e.code;
  }
  out.modelRefused = refused;
  out.modelEnabled = core.modelEnabled(input.modelChain, out.model[0].swap, { call: 'claim', args: { secret_ok: true } }, 'operator', input.modelSteps[0].at + 5);
  out.tier = core.tierValue([0n, 1_000_000_000_000n, 50_000_000_000_000n], [2n, 10n, 25n], 1_000_000_000_000n).toString();
  // The wallet-derived seed (SPEC 11.3): the web build derives the vector seeds, and a high-s
  // spelling of the Ethereum signature gives the same one.
  out.walletSeeds = input.walletSeeds.map((c) => hex(core.walletSeed(c.tag, unhex(c.wallet), unhex(c.signature))));
  out.terms = hex(core.termsHash({ asset: 0, direction: 0, mode: 0, depBps: 100, wA: 60, wN: 600, dC: 5400, wC: 1800, wF: 604800, depthAbove: [0n, 0n, 0n], depths: [10, 0, 0], wZ: 86_400 }));
  return out;
};
document.getElementById('status').textContent = 'ready';
