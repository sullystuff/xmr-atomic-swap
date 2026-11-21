#!/usr/bin/env node
// Proof that a browser tab can (1) verify the lock with the view key against two nodes and
// (2) sweep the joint address with @xmrswap/core-wasm, with nothing but cross-origin fetch to
// monerod's RPC. The fee cap and exact-output selection are exercised in the tab as well.
// Prereqs: ./start.sh, `pnpm build`, a Chromium (CHROMIUM=/path, else the Playwright cache).
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { prepareLock, destinationReceived } from './prepare-lock.mjs';
import { DAEMON_A, DAEMON_B } from '../lib/rpc.mjs';
import { REGTEST_MAX_FEE } from '../lib/sweep.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.XMR_WEB_PORT || 48087);   // a different origin than the daemons => real CORS
const coreDir = path.dirname(createRequire(import.meta.url).resolve('@xmrswap/core-wasm/package.json'));
const wasmFile = path.join(coreDir, 'pkg/web/swap_core_bg.wasm');
assert.ok(existsSync(wasmFile), 'run `pnpm build` first');
await build({ entryPoints: [path.join(here, 'page.mjs')], bundle: true, format: 'esm', target: 'es2022', outfile: path.join(here, 'dist/page.js'), logLevel: 'error' });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  const p = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  const file = p === 'swap_core_bg.wasm' ? wasmFile : path.join(here, p);
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1');

async function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  for (const d of (await readdir(cache).catch(() => [])).filter((d) => d.startsWith('chromium')).sort().reverse())
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell'])
      if (existsSync(path.join(cache, d, rel))) return path.join(cache, d, rel);
  throw new Error('no Chromium found; set CHROMIUM=/path/to/chrome');
}

// A lock with one dust payment to the same address in the same block.
const dust = [1_500_000_000n];
const lock = await prepareLock({ conf: 10, dust });
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
let code = 0;
try {
  const page = await browser.newPage();
  const calls = new Map();
  page.on('request', (r) => { const u = new URL(r.url()); if (u.port !== String(PORT)) { const k = `${r.method()} ${u.port}${u.pathname}`; calls.set(k, (calls.get(k) || 0) + 1); } });
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'ready');
  console.log('browser:', browser.version(), 'page origin:', `http://127.0.0.1:${PORT}`);

  // The Rust core and the pure-JS library derive the same joint address in the tab.
  const j = await page.evaluate(([a, b]) => window.xmr.deriveJoint(a, b, 'regtest'), [lock.halves.maker, lock.halves.taker]);
  assert.equal(j.address, lock.address); assert.equal(j.core.address, lock.address);
  assert.equal(j.core.viewPriv, lock.viewKey); assert.equal(j.core.spendPub, lock.spendPub);

  const v = await page.evaluate((a) => window.xmr.verify(a), { nodes: [DAEMON_A, DAEMON_B], txid: lock.txid, viewPriv: lock.viewKey, spendPub: lock.spendPub, minAmount: lock.amount.toString(), minConf: 10 });
  console.log('in-browser verify:', { ok: v.ok, state: v.state, confirmations: v.confirmations, amount: v.amount, outputIndex: v.outputIndex, nodes: v.nodes.map((n) => `${n.url} h=${n.height}`) });
  assert.equal(v.ok, true); assert.equal(v.amount, lock.amount.toString()); assert.equal(v.outputIndex, lock.outputIndex);
  const verifyCalls = [...calls.keys()]; calls.clear();

  const base = { daemonUrl: DAEMON_A, network: 'regtest', spendKey: lock.spendKey, viewKey: lock.viewKey, lockHeight: lock.lockHeight, lockTxid: lock.txid, outputIndex: v.outputIndex, destination: lock.destination, maxFee: REGTEST_MAX_FEE.toString() };
  // The fee cap holds in the tab: nothing is published.
  const capped = await page.evaluate((a) => window.xmr.sweep(a), { ...base, maxFee: '1' });
  console.log('in-browser sweep with max_fee = 1 ->', capped.error, capped.message);
  assert.equal(capped.error, 'SweepFeeAboveCap');
  const missing = await page.evaluate((a) => window.xmr.sweep(a), { ...base, lockTxid: 'cd'.repeat(32) });
  assert.equal(missing.error, 'SweepOutputNotFound');
  calls.clear();

  const t0 = Date.now();
  const s = await page.evaluate((a) => window.xmr.sweep(a), base);
  console.log('in-browser sweep:', { ...s, txHex: `${s.txHex.length / 2} bytes`, ms: Date.now() - t0 });
  assert.equal(s.error, undefined, s.message);
  assert.equal(s.jointAddress, lock.address); assert.equal(BigInt(s.amount) + BigInt(s.fee), lock.amount);
  assert.deepEqual(s.ignored.map((i) => i.amount), dust.map(String), 'the dust output is reported, not spent');
  assert.equal(s.ignored[0].output.split(':')[0], lock.dustTxids[0]);
  console.log('daemon endpoints used by verify:', verifyCalls);
  console.log('daemon endpoints used by sweep :', Object.fromEntries(calls));
  const got = await destinationReceived([s.txid]);
  assert.equal(got, BigInt(s.amount)); console.log('destination received', got, '\nBROWSER VERIFY + SWEEP OK');
} catch (e) { console.error(e); code = 1; } finally { await browser.close(); server.close(); }
process.exit(code);
