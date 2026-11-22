#!/usr/bin/env node
/**
 * `xmrswap-daemon`:
 *   config check <file>     validate a configuration without starting; prints the effective values
 *   tor print-torrc [file]  print the two HiddenService lines for the maker's own Tor
 *   start [file]            run the daemon (default file: ./maker.toml, or $XMRSWAP_CONFIG)
 *
 * Secrets come from the environment by variable name; nothing here prints one.
 */
import { readFileSync } from 'node:fs';
import { init } from '@xmrswap/core-wasm';
import { startApi } from './api/server.js';
import { type LoadResult, loadConfig } from './config/load.js';
import { Daemon } from './daemon.js';
import { daemonEndpoint, serveEndpoint, torrcLines } from './tor/index.js';

/** The report of `config check`: errors, warnings and the effective terms of every enabled offer. */
export function checkReport(r: LoadResult): string {
  const lines: string[] = [];
  for (const e of r.validation.errors) lines.push(`error    ${e.path || '(file)'}: ${e.message}`);
  for (const w of r.validation.warnings) lines.push(`warning  ${w.path || '(file)'}: ${w.message}`);
  for (const t of r.validation.effective) {
    lines.push(`offer    ${t.market} ${t.direction}: mode ${t.approval_mode}, approval window ${t.approval_window_secs} s, notice ${t.notice_secs} s, claim delay ${t.claim_delay_secs / 60} min (bound ${Math.ceil(t.min_claim_delay_secs / 60)} min), claim window ${t.claim_window_secs / 60} min, final ${t.final_secs / 86_400} d, deposit ${t.deposit_bps} bps, depth ${t.depth_tiers.map((d) => `${d.depth} from ${Number(d.above_xmr) / 1e12} XMR`).join(', ')}`);
  }
  const c = r.validation.update_cost;
  if (c) lines.push(`cost     one update every ${c.interval_secs} s: ${c.lamports_per_update} lamports each, ${Number(c.daily_lamports) / 1e9} SOL per day`);
  lines.push(r.validation.ok ? `ok       ${r.validation.warnings.length} warning(s)` : `invalid  ${r.validation.errors.length} error(s)`);
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const [a, b, c] = argv;
  if (a === 'config' && b === 'check' && c) {
    await init();
    const r = loadConfig(readFileSync(c, 'utf8'));
    console.log(checkReport(r));
    return r.validation.ok ? 0 : 1;
  }
  if (a === 'tor' && b === 'print-torrc') {
    const r = loadConfig(c ? readFileSync(c, 'utf8') : '');
    const tor = r.config?.raw.tor;
    process.stdout.write(torrcLines(tor?.listen ?? '127.0.0.1:7072', tor?.hostname_file));
    return 0;
  }
  if (a === 'start') {
    const file = b ?? process.env['XMRSWAP_CONFIG'] ?? './maker.toml';
    const d = await Daemon.create({ configPath: file });
    const api = await startApi(d);
    console.log(`xmrswap-daemon ${d.config.raw.daemon.mode}: API on ${api.url} (token in ${d.dataDir}/api-token)`);
    let endpoint: Awaited<ReturnType<typeof serveEndpoint>> | null = null;
    if (d.config.raw.tor.enabled || d.config.blobEndpoint) {
      const handler = daemonEndpoint(d);
      endpoint = await serveEndpoint(handler, d.config.raw.tor.listen);
      console.log(`maker endpoint on ${d.config.raw.tor.listen} (map an onion service's port 80 to it: xmrswap-daemon tor print-torrc)`);
    }
    await d.start();
    const stop = async () => {
      await endpoint?.close();
      await api.close();
      await d.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    return await new Promise<number>(() => undefined);
  }
  console.error('usage: xmrswap-daemon config check <file> | tor print-torrc [file] | start [file]');
  return 2;
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
