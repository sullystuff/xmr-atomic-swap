// `pnpm --filter @xmrswap/e2e test`: type-check, then every scenario, then a separate report of the
// known failures (tests that reproduce a bug recorded in BUGS.md; they are expected to fail and are
// kept so that the fix is noticed). Exit 0 = every ordinary scenario passed and every known failure
// still fails. The package script holds /tmp/xmrswap-integration.lock around all of it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, args, env = process.env) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env }).status ?? 1;
process.env.XMR_BIN ??= path.join(process.env.HOME ?? '', 'monero');

let code = sh('node_modules/.bin/tsc', ['-p', 'tsconfig.json', '--noEmit']);
if (code !== 0) process.exit(code);
const report = path.join(root, '.known-failures.json');
rmSync(report, { force: true });
const started = Date.now();
code = sh('node_modules/.bin/vitest', ['run', ...process.argv.slice(2)], { ...process.env, E2E_KNOWN_FAILURES_REPORT: report });
const mins = ((Date.now() - started) / 60000).toFixed(1);

console.log('\n================ known failures (bugs in other packages; see tests/e2e/BUGS.md) ================');
if (existsSync(report)) {
  const rows = readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) console.log(`  ${r.stillFails ? 'STILL FAILS (expected)' : 'NOW PASSES: remove the marker and close the bug'}  ${r.bug}  ${r.title}`);
  if (rows.length === 0) console.log('  none');
  if (rows.some((r) => !r.stillFails)) code = code || 1;
  rmSync(report, { force: true });
} else console.log('  none recorded in this run');
console.log(`================ e2e ${code === 0 ? 'PASSED' : 'FAILED'} in ${mins} min ================`);
process.exit(code);
