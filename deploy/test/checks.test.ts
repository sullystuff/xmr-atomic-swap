/** The status command's Monero rule is the page's rule: the two are compared case by case. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type NodeAnswer, formatChecks, moneroAgreement } from '../src/checks.js';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const node = (i: number, height: number | null, hash = A, synchronized = true): NodeAnswer =>
  height === null ? { name: `node ${i}`, info: null, error: 'HTTP 500' } : { name: `node ${i}`, info: { height, top_block_hash: hash, synchronized }, error: null };

const CASES: { what: string; answers: NodeAnswer[]; own: boolean; state: string }[] = [
  { what: 'no node', answers: [], own: false, state: 'fail' },
  { what: 'one node, not own', answers: [node(0, 100)], own: false, state: 'fail' },
  { what: 'one node, own', answers: [node(0, 100)], own: true, state: 'ok' },
  { what: 'two nodes agree', answers: [node(0, 100), node(1, 100)], own: false, state: 'ok' },
  { what: 'one block apart', answers: [node(0, 100), node(1, 101, B)], own: false, state: 'ok' },
  { what: 'two blocks apart', answers: [node(0, 100), node(1, 102, B)], own: false, state: 'fail' },
  { what: 'far behind', answers: [node(0, 3_300_000), node(1, 3_100_000, B)], own: false, state: 'fail' },
  { what: 'same height, different block', answers: [node(0, 100, A), node(1, 100, B)], own: false, state: 'fail' },
  { what: 'one silent', answers: [node(0, 100), node(1, null)], own: false, state: 'fail' },
  { what: 'own node silent', answers: [node(0, null)], own: true, state: 'fail' },
  { what: 'still synchronising', answers: [node(0, 100), node(1, 100, A, false)], own: false, state: 'warn' },
  { what: 'three nodes, one on a fork', answers: [node(0, 100, A), node(1, 100, A), node(2, 100, B)], own: false, state: 'fail' },
];

describe('Monero nodes in agreement', () => {
  it('gives the expected verdict for each case', () => {
    for (const c of CASES) expect(moneroAgreement(c.answers, c.own).state, c.what).toBe(c.state);
  });

  it("gives the same verdict as the page's own check", async () => {
    const web = (await import(/* @vite-ignore */ fileURLToPath(new URL('../../apps/web/src/lib/status.ts', import.meta.url)))) as {
      moneroAgreement(answers: { url: string; info: unknown; error: string | null }[], ownNode: boolean): { state: string };
    };
    for (const c of CASES) {
      const page = web.moneroAgreement(c.answers.map((a) => ({ url: a.name, info: a.info, error: a.error })), c.own);
      expect(moneroAgreement(c.answers, c.own).state, c.what).toBe(page.state);
    }
  });

  it('formats a report with one line per check and a verdict', () => {
    const text = formatChecks([
      { id: 'ui', label: 'Web UI served', state: 'ok', detail: 'x' },
      { id: 'tor', label: 'Tor proxy not reachable', state: 'fail', detail: 'y' },
      { id: 'ethereum', label: 'Ethereum RPC', state: 'off', detail: 'z' },
    ]);
    expect(text).toBe('ok    Web UI served\n      x\nFAIL  Tor proxy not reachable\n      y\noff   Ethereum RPC\n      z\n\n1 problem to fix before swapping.');
  });
});
