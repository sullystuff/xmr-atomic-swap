#!/usr/bin/env node
// The one browser test of the wasm core (SPEC 9.1): the `web` build, loaded in headless
// Chromium, must give the same results as the `nodejs` build for the same inputs, and each
// must verify the cross-curve proof the other produced.
// Chromium: CHROMIUM=<path>, else the newest build in the Playwright cache. Never downloaded.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import * as core from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, '../pkg/web/swap_core_bg.wasm');
assert.ok(existsSync(wasmPath), 'run `pnpm --filter @xmrswap/core-wasm build` first');

async function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  for (const d of (await readdir(cache).catch(() => [])).filter((d) => d.startsWith('chromium')).sort().reverse())
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell'])
      if (existsSync(path.join(cache, d, rel))) return path.join(cache, d, rel);
  throw new Error('no Chromium found; set CHROMIUM=/path/to/chrome');
}

const bundle = await build({ entryPoints: [path.join(here, 'browser-page.mjs')], bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'error' });
const pageJs = bundle.outputFiles[0].text;
const html = '<!doctype html><meta charset="utf-8"><title>core-wasm browser test</title><p id="status">loading</p><script type="module" src="/page.js"></script>';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  if (url === '/page.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(pageJs);
  if (url === '/swap_core_bg.wasm') return res.writeHead(200, { 'content-type': 'application/wasm' }).end(await readFile(wasmPath));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const hex = (b) => Buffer.from(b).toString('hex');
const seed = new Uint8Array(32).map((_, i) => i * 7 + 1);
const shareId = new Uint8Array(16).map((_, i) => 200 - i);
const ctx = new Uint8Array(32).fill(0x5a);

// The same computation with the nodejs build.
await core.init();
const sol = core.deriveKeys(seed, 1, shareId);
const eth = core.deriveKeys(seed, 2, shareId);
const nodeBlob = core.dleqProve(eth.spend);
const nonce = new Uint8Array(24).fill(5);
const expected = {
  keys: {
    solana: Object.fromEntries(Object.entries(sol).map(([k, v]) => [k, hex(v)])),
    ethereum: Object.fromEntries(Object.entries(eth).map(([k, v]) => [k, hex(v)])),
  },
  pok: hex(core.pokProve(sol.spend, ctx)),
  twin: Object.fromEntries(Object.entries(core.twinCommitments(eth.spend)).map(([k, v]) => [k, hex(v)])),
  envelope: hex(core.envelopeSeal({ fromMaker: false, makerKeyVersion: 1, ownSecret: sol.encSecret, peerPub: eth.encPub, plaintext: new TextEncoder().encode('{"t":"ack"}'), nonce })),
  notice: hex(core.noticeSeal({ ownSecret: sol.encSecret, peerPub: eth.encPub, side: 'taker', swapRef: ctx, txid: ctx, view: sol.view, nonce })),
  pay: core.payAmount(123_456_789_012n, 987_654_321_987n, 'solana').toString(),
  joint: core.jointAddress(sol.spendPub, eth.spendPub, sol.view, eth.view, 'stagenet').address,
};

// A happy-path sequence of the transition vectors, replayed through the model in the tab.
const transitions = JSON.parse(readFileSync(path.join(here, '../../../interfaces/vectors/transitions.json'), 'utf8'));
const happy = transitions.sequences.find((s) => s.name === 'happy/B/window' && s.chain === 'ethereum');
const modelSteps = happy.steps.map(({ call, args, caller, at, env }) => ({ call, args, caller, at, env }));

const browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
let code = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(origin + '/');
  await page.waitForFunction(() => document.getElementById('status').textContent === 'ready');
  const got = await page.evaluate((input) => window.coreTest(input), { seed: hex(seed), shareId: hex(shareId), ctx: hex(ctx), nodeBlob: hex(nodeBlob), modelChain: happy.chain, modelSteps });
  assert.deepEqual(errors, []);

  assert.equal(got.version, core.coreVersion());
  assert.deepEqual(got.keys, expected.keys, 'deriveKeys differs between the web and nodejs builds');
  assert.equal(got.pok, expected.pok);
  assert.equal(got.pokOk, true);
  assert.deepEqual(got.twin, expected.twin);
  assert.equal(got.envelope, expected.envelope);
  assert.equal(got.notice, expected.notice);
  assert.equal(got.pay, expected.pay);
  assert.equal(got.joint, expected.joint);
  // The proof made in the tab is the right size, self-verifies there, and verifies in Node.
  assert.equal(got.dleq.length, 56_679);
  assert.equal(got.dleq.keyAddr, expected.twin.keyAddr);
  assert.equal(got.dleq.keyAddr2, expected.twin.keyAddr2);
  assert.equal(got.dleq.spendPub, expected.keys.ethereum.spendPub);
  const inNode = core.dleqVerify(Uint8Array.from(Buffer.from(got.blob, 'hex')));
  assert.equal(hex(inNode.keyAddr), expected.twin.keyAddr);
  // The proof made in Node verifies in the tab; a flipped bit does not.
  assert.equal(got.nodeBlobKeyAddr, expected.twin.keyAddr);
  assert.match(got.tampered, /^Dleq(Invalid|Malformed)$/);
  // The model in the web build reproduces the vector sequence step by step.
  assert.equal(got.model.length, happy.steps.length);
  got.model.forEach((fx, i) => {
    const { maker: _maker, ...want } = happy.steps[i].expect;
    assert.deepEqual(fx, want, `model step ${i} (${happy.steps[i].call})`);
  });
  assert.equal(got.model.at(-1).state, 'DONE');
  assert.equal(got.modelRefused, 'BadState');
  assert.equal(got.modelEnabled, false);
  assert.equal(got.tier, '10');
  assert.equal(core.tierValue([0n, 1_000_000_000_000n, 50_000_000_000_000n], [2n, 10n, 25n], 1_000_000_000_000n), 10n);
  console.log(`browser ${browser.version()}: web build matches the nodejs build; DLEQ prove ${got.dleq.proveMs} ms, verify ${got.dleq.verifyMs} ms`);
  console.log('CORE-WASM BROWSER TEST OK');
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
