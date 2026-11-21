#!/usr/bin/env node
// Why the maker pre-splits: spending ANY part of an output locks the change for 10 blocks, so a
// wallet holding one big output can fund one swap per ~20 minutes. N pre-split outputs fund N
// swaps back to back.
import assert from 'node:assert/strict';
import * as m from './lib/monero.mjs';
import { wallet, mine, fund, ensureFunded, XMR } from './lib/harness.mjs';
const fresh = () => { const h = m.generateKeyHalf(); return m.encodeAddress(h.spendPub, h.viewPub, 'regtest'); };
const name = `maker-${Date.now()}`;
const pay = async (dests) => { await wallet.openOrCreate(name); await wallet.refresh(); return wallet.call('transfer', { destinations: dests, priority: 0, ring_size: 16 }); };
const bal = async () => { await wallet.openOrCreate(name); await wallet.refresh(); const b = await wallet.balance(); return `balance ${m.fmtXmr(b.balance)} unlocked ${m.fmtXmr(b.unlocked_balance)} (unlock in ${b.blocks_to_unlock} blocks)`; };

await wallet.openOrCreate(name); const makerAddr = await wallet.address();
await ensureFunded(); await fund(makerAddr, 10n * XMR); await new Promise((r) => setTimeout(r, 1500)); await mine(10);
console.log('maker holds ONE 10 XMR output :', await bal());
await pay([{ address: fresh(), amount: Number(XMR) }]);
console.log('after locking 1 XMR for swap 1:', await bal());
await assert.rejects(pay([{ address: fresh(), amount: Number(XMR) }]), (e) => { console.log('swap 2 right away             : REFUSED ->', e.message); return true; });
await mine(10); console.log('10 blocks later               :', await bal());

// Pre-split: one tx paying ourselves 4 x 1 XMR (plus change) => 5 independent outputs.
await pay(Array.from({ length: 4 }, () => ({ address: makerAddr, amount: Number(XMR) })));
await mine(10); console.log('after pre-split + 10 blocks   :', await bal());
for (let i = 1; i <= 4; i++) { const r = await pay([{ address: fresh(), amount: Number(XMR) * 9 / 10 }]); console.log(`swap ${i} lock sent back to back   : ${r.tx_hash.slice(0, 16)}…`); }
console.log('after 4 locks in the same block window:', await bal());
await wallet.close(); await mine(1); console.log('PRESPLIT DEMO OK');
