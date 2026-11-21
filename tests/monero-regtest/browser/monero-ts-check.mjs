#!/usr/bin/env node
// What monero-ts (wallet2 compiled to WASM) can and cannot do against this harness.
//  - Key handling works: a keys-only wallet built from the summed keys reports the joint address.
//  - Syncing a full wallet against REGTEST fails: wallet2 checks each block's hard-fork version
//    against the mainnet/stagenet/testnet fork-height table, and regtest is at v16 from block 1.
//    monero-wallet-rpc has --allow-mismatched-daemon-version for this; monero-ts exposes no such
//    switch. So sweepJoint() in sweep-monero-ts.mjs is UNTESTED here; it needs a real network.
import assert from 'node:assert/strict';
import moneroTs from 'monero-ts';
import { sweepJoint } from './sweep-monero-ts.mjs';
import { prepareLock } from './prepare-lock.mjs';
import { DAEMON_A } from '../lib/rpc.mjs';
const lock = await prepareLock();
// Note: a "from keys" restore must pass address + view key + spend key. A normal wallet derives its
// view key from the spend key; the joint wallet's view key is independent, so seed/spend-key-only
// restores produce a DIFFERENT address.
const mk = (spendKey) => moneroTs.createWalletKeys({ networkType: moneroTs.MoneroNetworkType.MAINNET, primaryAddress: lock.address, privateSpendKey: spendKey, privateViewKey: lock.viewKey });
const keys = await mk(lock.spendKey);
assert.equal(await keys.getPrimaryAddress(), lock.address); assert.equal(await keys.getPublicSpendKey(), lock.spendPub);
await assert.rejects(mk('01'.padEnd(64, '0')), (e) => { console.log('wrong spend key rejected ->', e.message); return true; });
console.log('monero-ts', moneroTs.getVersion(), 'accepts (joint address, summed spend key, summed view key): OK');
try {
  const r = await sweepJoint(moneroTs, { daemonUrl: DAEMON_A, networkType: 'mainnet', ...lock, proxyToWorker: false, relay: false });
  console.log('full-wallet sweep unexpectedly worked:', r);
} catch (e) { console.log('full-wallet sync on regtest fails as expected ->', e.message); }
process.exit(0);
