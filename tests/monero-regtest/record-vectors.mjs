#!/usr/bin/env node
// Record `monero_tx.json` (SPEC 2.12): raw regtest transactions and blocks with the scan
// results a verifier must reach. Run once against a fresh regtest (`./start.sh --fresh`,
// `pnpm build`); the output is committed at crates/swap-core/fixtures/monero_tx.json and
// `gen-vectors` copies it verbatim into interfaces/vectors/.
//
// Recorded from the chain:
//   - a lock to the joint address, in full and pruned form;
//   - a lock whose transaction also pays a subaddress (per-output "additional" tx keys);
//   - a block holding a lock plus two dust payments to the same joint address.
// Synthetic (marked `"synthetic": true`): a second transaction carrying the lock's one-time
// output key. Producing one for real needs a transaction built with a chosen tx private key,
// which neither wallet-rpc nor monero-oxide's builder allows; the blob here is the lock
// transaction with one key-image byte changed, so it parses and scans exactly as a real
// duplicate would, but it is not a valid transaction and was never on the chain.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '@xmrswap/core-wasm';
import * as m from './lib/monero.mjs';
import { verifyLock, duplicateOutputs } from './lib/verify.mjs';
import { daemonA, wallet, NODES, mine, fund, ensureFunded, XMR } from './lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
await core.init();

// Fixed key halves, so the fixture names its keys and is self-contained.
const seed = (tag) => Uint8Array.from(Buffer.from(tag.padEnd(32, '.')));
const shareId = Uint8Array.from(Buffer.from('monero-tx-vector'));
const makerKeys = core.deriveKeys(seed('xmrswap regtest fixture maker'), 1, shareId);
const takerKeys = core.deriveKeys(seed('xmrswap regtest fixture taker'), 1, shareId);
const joint = core.jointAddress(makerKeys.spendPub, takerKeys.spendPub, makerKeys.view, takerKeys.view, 'regtest');
const spendPriv = core.addScalars(makerKeys.spend, takerKeys.spend);
const viewPriv = hex(joint.viewPriv), spendPub = hex(joint.spendPub), address = joint.address;
// The pure-JS library agrees with the core on the address.
assert.equal(m.encodeAddress(spendPub, hex(joint.viewPub), 'regtest'), address);

async function txRecord(txid) {
  const full = (await daemonA.other('get_transactions', { txs_hashes: [txid], decode_as_json: false, prune: false })).txs[0];
  const pruned = (await daemonA.other('get_transactions', { txs_hashes: [txid], decode_as_json: false, prune: true })).txs[0];
  assert.ok(full.as_hex && pruned.pruned_as_hex && pruned.prunable_hash, 'node returned the tx in both forms');
  return { txid, tx_hex: full.as_hex, pruned_hex: pruned.pruned_as_hex, prunable_hash: pruned.prunable_hash, block_height: full.block_height, output_indices: full.output_indices };
}
const scanOf = (blobHex, view = viewPriv, spend = spendPub) => {
  const tx = m.parseTx(m.hexToBytes(blobHex));
  return { tx, outs: m.scanTx(tx, view, spend) };
};
const outputsJson = (outs) => outs.map((o) => ({ index: o.index, amount: o.amount.toString(), key: o.key, commitment_ok: o.commitmentOk }));
const lockCase = (name, rec, amount, about) => {
  const { tx, outs } = scanOf(rec.tx_hex);
  assert.equal(m.computeTxid(tx), rec.txid);
  const prunedTx = m.parseTx(m.hexToBytes(rec.pruned_hex));
  assert.equal(m.computeTxid(prunedTx, rec.prunable_hash), rec.txid);
  assert.equal(outs.length, 1); assert.equal(outs[0].amount, amount); assert.equal(outs[0].commitmentOk, true);
  return {
    name, valid: true, about,
    input: { txid: rec.txid, tx_hex: rec.tx_hex, pruned_hex: rec.pruned_hex, prunable_hash: rec.prunable_hash, view_priv: viewPriv, spend_pub: spendPub, min_amount: amount.toString() },
    output: { computed_txid: rec.txid, unlock_time: Number(tx.unlockTime), rct_type: tx.rctType, output_count: tx.outputs.length, outputs: outputsJson(outs), output_index: outs[0].index, amount: outs[0].amount.toString(), fee: tx.fee.toString() },
  };
};

await ensureFunded();
const info = await daemonA.info();
const cases = [];

// 1. A plain lock.
const lock1 = await fund(address, 2n * XMR); await sleep(1500); await mine(1);
const rec1 = await txRecord(lock1.txid);
cases.push(lockCase('lock', rec1, 2n * XMR, 'a 2 XMR lock to the joint address'));

// 2. A lock whose transaction also pays a subaddress: outputs use per-output additional tx keys.
await wallet.openOrCreate('miner');
const sub = (await wallet.call('create_address', { account_index: 0 })).address;
const r2 = await wallet.call('transfer', { destinations: [{ address, amount: Number(XMR) }, { address: sub, amount: Number(XMR) }], priority: 0, ring_size: 16 });
await sleep(1500); await mine(1);
const rec2 = await txRecord(r2.tx_hash);
assert.ok(scanOf(rec2.tx_hex).tx.extra.additionalPubKeys.length > 0, 'the transaction carries additional tx keys');
cases.push(lockCase('lock-with-additional-tx-keys', rec2, XMR, 'the lock transaction also pays a subaddress, so outputs use per-output additional tx keys'));

// Negative scans of the plain lock.
{
  const half = scanOf(rec1.tx_hex, hex(makerKeys.view));
  assert.equal(half.outs.length, 0);
  cases.push({ name: 'one-view-half-is-not-the-view-key', valid: false, about: 'scanning with a single view share finds nothing', input: { txid: rec1.txid, tx_hex: rec1.tx_hex, view_priv: hex(makerKeys.view), spend_pub: spendPub, min_amount: (2n * XMR).toString() }, error: 'no-output' });
  const otherSpend = hex(takerKeys.spendPub);
  assert.equal(scanOf(rec1.tx_hex, viewPriv, otherSpend).outs.length, 0);
  cases.push({ name: 'wrong-spend-key', valid: false, about: 'the joint view key with one spend half as the spend key finds nothing', input: { txid: rec1.txid, tx_hex: rec1.tx_hex, view_priv: viewPriv, spend_pub: otherSpend, min_amount: (2n * XMR).toString() }, error: 'no-output' });
  cases.push({ name: 'amount-one-piconero-short', valid: false, about: 'the lock pays one piconero less than required', input: { txid: rec1.txid, tx_hex: rec1.tx_hex, view_priv: viewPriv, spend_pub: spendPub, min_amount: (2n * XMR + 1n).toString() }, error: 'amount-too-small' });
  // A blob that does not hash to the txid it was returned for.
  const tampered = rec1.tx_hex.slice(0, -2) + (rec1.tx_hex.endsWith('00') ? '01' : '00');
  assert.notEqual(m.computeTxid(m.parseTx(m.hexToBytes(tampered))), rec1.txid);
  cases.push({ name: 'blob-does-not-hash-to-txid', valid: false, about: 'the last byte of the blob was changed', input: { txid: rec1.txid, tx_hex: tampered, view_priv: viewPriv, spend_pub: spendPub, min_amount: (2n * XMR).toString() }, error: 'txid-mismatch' });
}

// 3. A block with a lock and two dust payments to the same joint address.
const lock3 = await fund(address, 3n * XMR);
const dustAmounts = [1_000_000_000n, 2_500_000_000n];
const dustTx = []; for (const d of dustAmounts) dustTx.push((await fund(address, d)).txid);
await sleep(1500); await mine(1);
const rec3 = await txRecord(lock3.txid);
const blk = await daemonA.block(rec3.block_height);
for (const t of dustTx) assert.ok(blk.tx_hashes.includes(t), 'dust landed in the lock block');
const blockTxs = [];
for (const t of blk.tx_hashes) blockTxs.push(await txRecord(t));
const minerTx = (await daemonA.other('get_transactions', { txs_hashes: [blk.miner_tx_hash], decode_as_json: false, prune: true })).txs[0];
const firstRingct = minerTx.output_indices[0];
const toJoint = blockTxs.flatMap((r) => scanOf(r.tx_hex).outs.map((o) => ({ txid: r.txid, index: o.index, amount: o.amount.toString(), key: o.key })));
assert.equal(toJoint.length, 3);
const lockOut = toJoint.find((o) => o.txid === lock3.txid);
const v3 = await verifyLock({ nodes: NODES, txid: lock3.txid, viewPriv, spendPub, minAmount: 3n * XMR, minConf: 1 });
assert.equal(v3.ok, true, JSON.stringify(v3.reasons)); assert.equal(v3.outputIndex, lockOut.index);
const blockInput = {
  block_height: rec3.block_height, block_hash: blk.block_header.hash, block_hex: blk.blob, miner_tx_hash: blk.miner_tx_hash,
  first_ringct_output_index: firstRingct,
  txs: blockTxs.map((r) => ({ txid: r.txid, tx_hex: r.tx_hex, pruned_hex: r.pruned_hex, prunable_hash: r.prunable_hash })),
  view_priv: viewPriv, spend_pub: spendPub,
};
cases.push({
  name: 'dust-in-the-lock-block', valid: true,
  about: 'two dust payments to the joint address share the block with the lock: the lock verifies, and a sweep must spend exactly the lock output and report the rest as ignored',
  input: { ...blockInput, lock_txid: lock3.txid, lock_output_index: lockOut.index, min_amount: (3n * XMR).toString() },
  output: {
    outputs_to_joint: toJoint,
    selected: { txid: lockOut.txid, index: lockOut.index, amount: lockOut.amount },
    ignored: toJoint.filter((o) => o.txid !== lock3.txid).map((o) => ({ output: `${o.txid}:${o.index}`, amount: o.amount })),
    duplicates: [],
  },
});
cases.push({
  name: 'dust-output-named-as-the-lock', valid: false,
  about: 'the same block, naming a dust payment as the lock: it pays far less than required',
  input: { ...blockInput, lock_txid: dustTx[0], lock_output_index: toJoint.find((o) => o.txid === dustTx[0]).index, min_amount: (3n * XMR).toString() },
  error: 'amount-too-small',
});
cases.push({
  name: 'no-such-output-in-the-block', valid: false,
  about: 'the same block, naming an output index of the lock transaction that does not pay the joint address',
  input: { ...blockInput, lock_txid: lock3.txid, lock_output_index: lockOut.index === 0 ? 1 : 0, min_amount: (3n * XMR).toString() },
  error: 'output-not-found',
});

// 4. SYNTHETIC: a second transaction carrying the lock's one-time output key.
{
  const lockRec = blockTxs.find((r) => r.txid === lock3.txid);
  const forge = (blobHex) => {
    const tx = m.parseTx(m.hexToBytes(blobHex));
    const image = tx.inputs.find((i) => i.type === 'key').keyImage;
    const at = blobHex.indexOf(image);
    assert.ok(at > 0 && blobHex.indexOf(image, at + 1) === -1, 'key image located once in the blob');
    const flipped = image.slice(0, -2) + (image.endsWith('00') ? '01' : '00');
    return blobHex.slice(0, at) + flipped + blobHex.slice(at + 64);
  };
  const dupFull = forge(lockRec.tx_hex), dupPruned = forge(lockRec.pruned_hex);
  const dupTx = m.parseTx(m.hexToBytes(dupFull));
  const dupId = m.computeTxid(dupTx);
  assert.equal(m.computeTxid(m.parseTx(m.hexToBytes(dupPruned)), lockRec.prunable_hash), dupId);
  assert.notEqual(dupId, lock3.txid);
  const dupOuts = scanOf(dupFull).outs;
  assert.equal(dupOuts.length, 1); assert.equal(dupOuts[0].key, lockOut.key);
  const blockKeys = dupTx.outputs.map((o, index) => ({ txid: dupId, index, key: o.key }));
  const dups = duplicateOutputs(scanOf(lockRec.tx_hex).tx, lockOut.index, lockOut.key, blockKeys);
  assert.deepEqual(dups, [`${dupId}:${lockOut.index}`]);
  cases.push({
    name: 'duplicate-output-key', valid: false, synthetic: true,
    about: 'SYNTHETIC. The lock block with one more transaction whose output carries the lock\'s one-time key (the lock transaction with one key-image byte changed; it parses and scans like a real duplicate but was never on the chain). Two outputs with one key share a key image, so only one can ever be spent: verification must report the lock invalid and a sweep must refuse.',
    input: {
      ...blockInput,
      txs: [...blockInput.txs, { txid: dupId, tx_hex: dupFull, pruned_hex: dupPruned, prunable_hash: lockRec.prunable_hash, synthetic: true }],
      lock_txid: lock3.txid, lock_output_index: lockOut.index, min_amount: (3n * XMR).toString(),
    },
    error: 'duplicate-output-key',
  });
}

const fixture = {
  format: 'xmrswap-vectors/1',
  suite: 'monero_tx',
  recorded: {
    how: 'tests/monero-regtest/record-vectors.mjs against a private regtest',
    monerod: `${info.version} (${info.nettype})`,
    note: 'Regtest uses mainnet address prefixes. Amounts are piconero as decimal strings. `tx_hex` is the full transaction; `pruned_hex` with `prunable_hash` is what a pruned node returns. Keys below are throwaway regtest keys.',
  },
  keys: {
    network: 'regtest',
    maker: { spend: hex(makerKeys.spend), spend_pub: hex(makerKeys.spendPub), view: hex(makerKeys.view) },
    taker: { spend: hex(takerKeys.spend), spend_pub: hex(takerKeys.spendPub), view: hex(takerKeys.view) },
    joint: { address, spend_pub: spendPub, view_priv: viewPriv, view_pub: hex(joint.viewPub), spend_priv: hex(spendPriv) },
  },
  errors: {
    'no-output': 'no output of the transaction pays the joint address',
    'amount-too-small': 'the output to the joint address pays less than min_amount',
    'txid-mismatch': 'the blob does not hash to the transaction id',
    'output-not-found': 'the named output does not pay the joint address',
    'duplicate-output-key': 'another output in the lock transaction or its block carries the same one-time key',
  },
  cases,
};
const out = fileURLToPath(new URL('../../crates/swap-core/fixtures/monero_tx.json', import.meta.url));
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log(`recorded ${cases.length} cases to ${out}`);
console.log('now run: cargo run -p swap-core --bin gen-vectors -- interfaces/vectors');
