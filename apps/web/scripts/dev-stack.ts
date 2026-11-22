// `pnpm --filter @xmrswap/web stack`: the UI against the local test stack, for trying it by hand.
// Starts the Monero regtest, svm-rpc with the built program and three makers with live offers,
// serves apps/web/dist, and then behaves like a small world: chain time follows the wall clock,
// a Monero block is mined every 10 seconds and every maker's daemon is stepped every 2 seconds.
// Loopback only; nothing live. Run through the package script: it holds the integration lock.
//
// HEADED=1 opens Chromium with a test wallet already installed (its key stays in this process).
// Otherwise import the printed development key into a wallet extension that supports the
// Wallet Standard. That key holds nothing anywhere but in this in-memory chain.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectWallet } from '../browser/driver.js';
import { SOL, XMR, base58, startStack } from '../browser/stack.js';
import * as xmr from '../browser/xmr.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const regtest = path.join(repo, 'tests/monero-regtest');
const env = { ...process.env, XMR_BIN: process.env.XMR_BIN ?? path.join(process.env.HOME ?? '', 'monero') };
const sh = (script: string, args: string[] = []) => execFileSync('bash', [script, ...args], { cwd: regtest, env, stdio: 'inherit' });

sh('./start.sh', ['--fresh']);
let stopping = false;
const timers: ReturnType<typeof setInterval>[] = [];
const w = await startStack([
  { price: (150n * SOL) / 100n, buys: true },
  { price: (151n * SOL) / 100n, maxXmr: 5n * XMR, mode: 1 },
  { price: (153n * SOL) / 100n, depBps: 300, terms: { depths: Uint8Array.of(10, 0, 0) } },
]);
await xmr.funded();

const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearInterval(t);
  await w.stop().catch(() => undefined);
  sh('./stop.sh');
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

let busy = false;
const guarded = (f: () => Promise<unknown>) => async () => {
  if (busy || stopping) return;
  busy = true;
  try {
    await f();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
};
timers.push(setInterval(() => void w.svm.warp(1).catch(() => undefined), 1000));
timers.push(setInterval(guarded(async () => (await w.stepMakers()).forEach((l) => console.log('maker', l))), 2000));
timers.push(setInterval(guarded(() => xmr.settle(1)), 10_000));
// A daemon refreshes its offers; these lapse after an hour of chain time otherwise.
timers.push(setInterval(guarded(async () => void (await Promise.all(w.makers.map((m) => m.refresh())))), 600_000));

// The taker's test key is 32 bytes of 0x05; wallets import the 64-byte form (seed then public key).
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let n = 0n;
for (const c of w.taker.publicKey) n = n * 58n + BigInt(A.indexOf(c));
const pub = new Uint8Array(32);
for (let i = 31; i >= 0; i--) {
  pub[i] = Number(n & 0xffn);
  n >>= 8n;
}
const secret = new Uint8Array(64);
secret.fill(5, 0, 32);
secret.set(pub, 32);
console.log(`\nUI:            ${w.url}`);
console.log(`Solana RPC:    ${w.svm.url} (svm-rpc: in-memory, not a cluster)`);
console.log(`Monero nodes:  ${xmr.NODE_A}  ${xmr.NODE_B} (regtest)`);
console.log(`XMR address:   ${await xmr.walletAddress()} (the regtest wallet; use it as the destination)`);
console.log(`Taker wallet:  ${w.taker.publicKey}`);
console.log(`Dev key:       ${base58(secret)} (in-memory chain only; import into a Wallet Standard wallet, or run with HEADED=1)`);
console.log('Ctrl-C stops everything.\n');

if (process.env.HEADED) {
  const { chromium } = await import('playwright-core');
  const { findChromium } = await import('../browser/driver.js');
  const browser = await chromium.launch({ executablePath: await findChromium(), headless: false });
  const context = await browser.newContext({ acceptDownloads: true, viewport: null });
  await injectWallet(context, w.taker);
  await (await context.newPage()).goto(w.url);
  browser.on('disconnected', () => void stop());
}

