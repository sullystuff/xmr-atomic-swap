#!/usr/bin/env node
/**
 * The self-hosting bundle's command line:
 *   start     serve the built web UI and start the relay, both on loopback (one origin)
 *   status    check the running bundle: UI, relay, Tor proxy, Solana RPC, Monero nodes
 *   settings  print the effective settings (never an RPC URL)
 *   pinned    print the program id and contract address this release pins
 *   docs      rewrite the generated settings reference and the example file (--check: only compare)
 *
 * It never starts, stops or reconfigures Tor. It connects to the SOCKS port it is given.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONTRACT_ADDRESS, CONTRACT_CHAIN_ID, PROGRAM_ID } from '@xmrswap/protocol';
import { probeSocks } from '@xmrswap/relay';
import { formatChecks, runChecks } from './checks.js';
import { torGuidance } from './guidance.js';
import { BundleError, startBundle } from './server.js';
import { type BundleSettings, ConfigError, DEPLOY_DIR, DOCS_BEGIN, DOCS_END, exampleToml, generatedDocs, isLoopback, loadSettingsFromProcess } from './settings.js';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);

function describe(s: BundleSettings): string[] {
  const set = (v: string | null): string => (v ? 'set' : 'NOT SET');
  return [
    `settings file      ${s.file ?? '(none: defaults and environment only)'}`,
    `ui.listen          ${s.ui.listenHost}:${s.ui.listenPort}`,
    `ui.dist            ${s.ui.dist}`,
    `ui.public_origin   ${s.ui.publicOrigin || '(same as listen)'}`,
    `RPC URLs to page   ${s.ui.givePageRpcUrls ? 'yes (anyone who can load the page can read them)' : 'no'}`,
    `Solana RPC URL     ${set(s.relay.solanaRpcUrl)}`,
    `Ethereum RPC URL   ${set(s.ui.ethereumRpcUrl)}`,
    `ethereum chain id  ${s.ui.ethereumChainId}`,
    `contract address   ${s.ui.contractAddress || '(none)'}`,
    `program id         ${s.relay.programId}${s.relay.programId === PROGRAM_ID ? ' (pinned by this release)' : ' (DIFFERS from the pinned id)'}`,
    `monero network     ${s.ui.moneroNetwork}`,
    `monero nodes       ${s.relay.moneroNodes.length ? s.relay.moneroNodes.join(', ') : '(none)'}${s.ui.ownNode ? ' (your own node)' : ''}`,
    `relay.bind         ${s.relay.bindHost}:${s.relay.bindPort}`,
    `relay.tor_socks    ${s.relay.torSocksHost}:${s.relay.torSocksPort}`,
    `allowed origins    ${s.relay.allowedOrigins.length ? s.relay.allowedOrigins.join(', ') : '(none: same origin only)'}`,
    `proxies in front   ${s.relay.trustProxyHops - 1}`,
    `rate limit         ${s.relay.requestsPerMinute} requests and ${s.relay.bytesPerMinute} bytes per minute per client address`,
    `monero max reply   ${s.relay.moneroMaxResponseBytes} bytes`,
    `debug log          ${s.relay.debugLog ? 'ON (client addresses and onion addresses are logged)' : 'off'}`,
  ];
}

async function start(): Promise<number> {
  const s = loadSettingsFromProcess();
  const bundle = await startBundle(s);
  const open = s.ui.publicOrigin || bundle.url;
  out('');
  out('NOTICE: this software is unaudited. The contracts can still be changed by the project owner.');
  out('        Closing the tab at the wrong moment during a swap can lose your funds.');
  out('');
  out(`Web UI and relay are running. Open this address in your browser:`);
  out('');
  out(`    ${open}/`);
  out('');
  out(`Status page:  ${open}/#/status`);
  out(`Status check: pnpm --filter @xmrswap/deploy run status`);
  out('');
  if (!isLoopback(s.ui.listenHost)) out(`WARNING: the UI is listening on ${s.ui.listenHost}, not on localhost. Anyone who can reach it can use your relay. Read docs/self-hosting/exposing-the-relay.md.`);
  const publicHost = s.ui.publicOrigin ? new URL(s.ui.publicOrigin).hostname.replace(/^\[|\]$/g, '') : s.ui.listenHost;
  if (!isLoopback(publicHost) && s.ui.givePageRpcUrls && (s.relay.solanaRpcUrl || s.ui.ethereumRpcUrl))
    out('WARNING: the page is reachable from other machines and is given your RPC URLs. Every visitor can read them, including any API key. Set [ui] give_page_rpc_urls = false.');
  if (!s.relay.solanaRpcUrl) out(`Solana RPC: not set. Export SOLANA_RPC_URL before starting, or type a URL into the Settings page. Until then the relay knows no makers and forwards nothing.`);
  if (s.relay.moneroNodes.length === 0) out('Monero nodes: none set. Add [relay] monero_nodes, or type node URLs into the Settings page. Locking is disabled until then.');
  else if (s.relay.moneroNodes.length === 1 && !s.ui.ownNode) out('Monero nodes: only one is set. Add a second, independently run node, or set [ui] own_node = true if the node is yours.');
  const torAddr = `${s.relay.torSocksHost}:${s.relay.torSocksPort}`;
  if (await probeSocks(s.relay.torSocksHost, s.relay.torSocksPort, 3_000)) out(`Tor: a SOCKS proxy answers at ${torAddr}. (Whether Tor has connected to the network shows on the Status page.)`);
  else for (const line of torGuidance(torAddr)) out(line);
  out('');
  out('Press Ctrl-C to stop. Do not stop it while a swap is in progress: the page reaches your');
  out('Monero nodes through this server and cannot confirm a lock without it.');

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void bundle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return await new Promise<number>(() => undefined);
}

async function status(args: string[]): Promise<number> {
  const s = loadSettingsFromProcess();
  const checks = await runChecks(s);
  out(args.includes('--json') ? JSON.stringify(checks, null, 2) : formatChecks(checks));
  return checks.some((c) => c.state === 'fail') ? 1 : 0;
}

function docs(args: string[]): number {
  const page = path.resolve(DEPLOY_DIR, '../docs/self-hosting/configuration.md');
  const example = path.join(DEPLOY_DIR, 'xmrswap.example.toml');
  const current = readFileSync(page, 'utf8');
  const begin = current.indexOf(DOCS_BEGIN);
  const end = current.indexOf(DOCS_END);
  if (begin < 0 || end < begin) throw new Error(`${page}: the generated-section markers are missing`);
  const next = current.slice(0, begin) + generatedDocs() + current.slice(end + DOCS_END.length);
  let currentExample = '';
  try {
    currentExample = readFileSync(example, 'utf8');
  } catch {
    /* written below */
  }
  const stale = [next !== current ? page : null, exampleToml() !== currentExample ? example : null].filter((f): f is string => f !== null);
  if (args.includes('--check')) {
    for (const f of stale) out(`out of date: ${f}`);
    if (stale.length === 0) out('The settings reference and the example file match the code.');
    return stale.length === 0 ? 0 : 1;
  }
  if (next !== current) writeFileSync(page, next);
  if (exampleToml() !== currentExample) writeFileSync(example, exampleToml());
  out(stale.length === 0 ? 'Nothing to do.' : stale.map((f) => `wrote ${f}`).join('\n'));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'start') return start();
  if (cmd === 'status') return status(rest);
  if (cmd === 'settings') {
    for (const line of describe(loadSettingsFromProcess())) out(line);
    return 0;
  }
  if (cmd === 'pinned') {
    out(`program id (Solana)          ${PROGRAM_ID}`);
    out(`contract address (Ethereum)  ${CONTRACT_ADDRESS ?? '(none: no contract is deployed for this release)'}`);
    out(`contract chain id            ${CONTRACT_CHAIN_ID ?? '(none)'}`);
    return 0;
  }
  if (cmd === 'docs') return docs(rest);
  process.stderr.write('usage: start | status [--json] | settings | pinned | docs [--check]\n');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ConfigError) {
      process.stderr.write(`configuration error: ${e.message}\n`);
      process.exit(2);
    }
    if (e instanceof BundleError) {
      process.stderr.write(`cannot start: ${e.message}\n`);
      process.exit(1);
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      process.stderr.write('cannot start: an address is already in use. Another copy may be running, or another program uses the port; change [ui] listen or [relay] bind.\n');
      process.exit(1);
    }
    process.stderr.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
