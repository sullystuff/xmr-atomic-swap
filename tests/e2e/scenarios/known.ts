// Known failures: a scenario that reproduces a bug recorded in tests/e2e/BUGS.md. The test body
// states what SHOULD happen, with the assertion at full strength; while the bug exists the body
// throws and the test is reported as an expected failure, separately from the ordinary scenarios
// (see scripts/run.mjs). When the body stops throwing the test FAILS, so the fix is noticed and
// the marker is removed.
import { appendFileSync } from 'node:fs';
import { it } from 'vitest';

export function knownFailure(bug: string, title: string, body: () => Promise<void>): void {
  it(`[known failure ${bug}] ${title}`, async () => {
    let message: string | null = null;
    try {
      await body();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const report = process.env['E2E_KNOWN_FAILURES_REPORT'];
    if (report) appendFileSync(report, `${JSON.stringify({ bug, title, stillFails: message !== null, message: message?.slice(0, 400) ?? null })}\n`);
    if (message === null) throw new Error(`${bug} no longer reproduces: remove the known-failure marker and close the entry in BUGS.md`);
    console.log(`[known failure ${bug}] still fails as recorded: ${message.split('\n')[0]}`);
  });
}
