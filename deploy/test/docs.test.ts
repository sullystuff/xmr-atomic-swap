/**
 * The self-hosting documentation (DESIGN "What the documentation must cover", SPEC 8.8): every
 * required page and heading exists, the warnings are near the top, links and commands point at
 * things that exist, commands that were not run say so, and nothing machine-specific leaked in.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID } from '@xmrswap/protocol';
import { describe, expect, it } from 'vitest';
import { torGuidance } from '../src/guidance.js';

const docsDir = fileURLToPath(new URL('../../docs/self-hosting/', import.meta.url));
const deployDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(deployDir, '..');
const page = (name: string): string => readFileSync(path.join(docsDir, name), 'utf8');
const headings = (text: string): string[] => [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,4} (.+)$/gm)].map((m) => m[1]!.trim());
const pages = readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();

/** One page per topic the design requires, and the headings each must have. */
const REQUIRED: Record<string, string[]> = {
  'README.md': ['Running the swap interface on your own machine', 'Read this first', 'What you run', 'Pages'],
  'quick-start.md': ['Quick start', 'Prerequisites', 'The one command', 'The local address to open', 'Tor', 'With containers'],
  'configuration.md': ['Configuration reference', 'Where settings come from', 'Settings file', 'Other environment variables', 'Settings in the browser'],
  'safe-defaults.md': ['Safe defaults', 'What is on by default', 'What the defaults do not protect'],
  'exposing-the-relay.md': [
    'Exposing the relay publicly',
    'Requirements',
    '1. Forward only to registered makers',
    '2. Enforce the size cap and per-address rate limits',
    '3. Keep no message logs',
    '4. Let the interface fall back',
  ],
  'who-sees-what.md': ['Who sees what', 'What a relay operator can and cannot do', 'The four ways to connect', 'Each way of running the interface, party by party'],
  'verifying-the-download.md': [
    'Verifying the download',
    'What exists today, stated plainly',
    'What each hash covers',
    'Checking files you downloaded',
    'Rebuilding from source and comparing',
    'How far this is known to reproduce',
    'The program: local build and Docker build',
    'Comparing the program on-chain',
    'What a mismatch means',
    'The bundle says what it serves',
    'Checking the program id and contract address',
    'Making a record',
  ],
  'checking-it-works.md': ['Checking it works', 'The status command', 'The Status page'],
  'troubleshooting.md': ['Troubleshooting', 'Tor unreachable', 'The fallback to on-chain messaging', 'RPC rate limits', 'A Monero node out of sync, or nodes disagreeing'],
  'backups-and-upgrades.md': ['Backups and upgrades', 'Where swap state and recovery files live', 'Upgrades', 'If a swap is in progress and you cannot wait'],
  'makers.md': ['For makers', 'Running the daemon', 'Running the console', 'Keys', 'Backups', 'What a missed deadline costs'],
};

describe('docs/self-hosting', () => {
  it('has exactly the required pages', () => {
    expect(pages).toEqual(Object.keys(REQUIRED).sort());
  });

  it('every required heading exists', () => {
    for (const [name, required] of Object.entries(REQUIRED)) {
      const found = headings(page(name));
      for (const h of required) expect(found, `${name}: "${h}"`).toContain(h);
      // One title per page, and it is the first line.
      expect(page(name).startsWith(`# ${required[0]}\n`), name).toBe(true);
    }
  });

  it('states the three warnings plainly near the top', () => {
    const top = page('README.md').split('\n').slice(0, 14).join('\n');
    expect(top).toMatch(/\*\*The software is unaudited\.\*\*/);
    expect(top).toMatch(/\*\*The contracts can still be changed by the project owner\.\*\*/);
    expect(top).toMatch(/upgradable/);
    expect(top).toMatch(/\*\*Closing the tab at the wrong moment can lose your funds\.\*\*/);
    // The two pages a reader may land on first repeat them in their opening lines.
    for (const name of ['quick-start.md', 'makers.md']) {
      const opening = page(name).split('\n').slice(0, 8).join('\n');
      expect(opening, name).toMatch(/unaudited/);
      expect(opening, name).toMatch(/upgradable/);
    }
    expect(page('quick-start.md').split('\n').slice(0, 8).join('\n')).toMatch(/closing the tab at the wrong moment can lose your funds/);
  });

  it('carries the relay table and the connection-mode table, and says who sees the Solana queries', () => {
    const text = page('who-sees-what.md');
    for (const row of ['| Can see |', '| Cannot see |', '| Can do |', '| Cannot do |']) expect(text, row).toContain(row);
    for (const mode of ['| Hosted |', '| Self-hosted |', '| Tor Browser, direct |', '| On-chain only |']) expect(text, mode).toContain(mode);
    expect(text).toContain('Your Solana RPC provider sees your on-chain queries and transactions in every mode, unless you run your own Solana node.');
    expect(text).toMatch(/untested/);
  });

  it('the public-relay page turns each relay rule into a requirement with a check', () => {
    const text = page('exposing-the-relay.md');
    for (const phrase of ['open proxy', 'onion_not_listed', '16,384 bytes', 'rate_limited', 'trust_proxy_hops', 'debug_log = false', 'falls back to on-chain', 'allowed_origins', 'Never `"*"`', 'public_origin', 'give_page_rpc_urls = false'])
      expect(text, phrase).toContain(phrase);
    // The safe-defaults page sends public operators here instead of covering it in passing.
    expect(page('safe-defaults.md')).toContain('(exposing-the-relay.md)');
  });

  it('names the status checks, the start address and the pinned program id as the code has them', () => {
    const checking = page('checking-it-works.md');
    for (const label of ['Web UI served', 'Relay reachable', 'Tor proxy reachable', 'Solana RPC connected', 'Monero nodes in agreement', 'Maker reachable over Tor', 'Everything needed for a swap is reachable'])
      expect(checking, label).toContain(label);
    expect(page('quick-start.md')).toContain('http://127.0.0.1:8780/');
    expect(page('verifying-the-download.md')).toContain(PROGRAM_ID);
    // The Tor guidance in the quick start is the text the start command prints.
    for (const line of torGuidance('127.0.0.1:9050')) expect(page('quick-start.md'), line).toContain(line);
  });

  it('the verification page states the limits and quotes the recorded snapshot exactly', () => {
    const text = page('verifying-the-download.md');
    for (const phrase of [
      '**Nothing is deployed.**',
      '**There is no release yet.**',
      '**Nobody independent has verified anything.**',
      'It does not prove the source is safe.',
      'unaudited',
      'Never compare a hash of one method with a hash of the other.',
      '| Any of them on a second machine, another operating system or another CPU type | **Not tested** | Unknown |',
      'upgrade authority',
      'there is no on-chain program to verify yet',
      'solana-verify get-program-hash',
      'cargo install solana-verify --version 0.4.11 --locked',
    ])
      expect(text, phrase).toContain(phrase);
    // The hashes printed on the page are the ones in the tracked snapshot, not stale copies.
    const record = JSON.parse(readFileSync(path.join(repoDir, 'releases/dev-snapshot/release.json'), 'utf8')) as { status: string; commit: string; web_tree_hash: string; console_tree_hash: string; web_cid: string; program_builds: { method: string; executable_hash: string }[] };
    expect(record.status).toBe('development-snapshot');
    for (const value of [record.commit, record.web_tree_hash, record.console_tree_hash, record.web_cid, ...record.program_builds.map((b) => b.executable_hash)]) expect(text, value).toContain(value);
    expect(record.program_builds.map((b) => b.method)).toEqual(['local-sbf', 'solana-verify-docker']);
    // The deploy README carries the same limits.
    const readme = readFileSync(path.join(deployDir, 'README.md'), 'utf8');
    for (const phrase of ['It is not a release.', 'Nothing is deployed', 'unaudited', 'never compared with each other']) expect(readme, phrase).toContain(phrase);
  });

  it('every link between pages, and every file a page names, exists', () => {
    for (const name of pages) {
      const text = page(name);
      for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
        const target = m[1]!;
        if (/^[a-z]+:/.test(target)) continue;
        const file = path.resolve(docsDir, target);
        expect(existsSync(file), `${name} links to ${target}`).toBe(true);
        if (m[2] && target.endsWith('.md')) {
          const anchors = headings(readFileSync(file, 'utf8')).map((h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
          expect(anchors, `${name} links to ${target}${m[2]}`).toContain(m[2].slice(1));
        }
      }
      for (const m of text.matchAll(/\]\((#[^)\s]+)\)/g)) {
        const anchors = headings(text).map((h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
        expect(anchors, `${name} links to ${m[1]}`).toContain(m[1]!.slice(1));
      }
      // Repository files named in backticks.
      for (const m of text.matchAll(/`((?:deploy|docs|apps|packages|releases|solana)\/[A-Za-z0-9_./-]+)`/g)) {
        const rel = m[1]!;
        // The user's own settings file and release directory do not exist until they create them.
        if (rel === 'deploy/xmrswap.toml' || rel.startsWith('deploy/release')) continue;
        expect(existsSync(path.join(repoDir, rel)), `${name} names ${rel}`).toBe(true);
      }
    }
  });

  it('every pnpm command names a package script that exists', () => {
    const scriptsOf = (dir: string): Record<string, string> => (JSON.parse(readFileSync(path.join(repoDir, dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const packages: Record<string, Record<string, string>> = {
      '@xmrswap/deploy': scriptsOf('deploy'),
      '@xmrswap/web': scriptsOf('apps/web'),
      '@xmrswap/console': scriptsOf('apps/console'),
      '@xmrswap/daemon': scriptsOf('packages/daemon'),
    };
    let seen = 0;
    for (const name of [...pages.map((p) => path.join(docsDir, p)), path.join(deployDir, 'README.md'), path.join(deployDir, 'xmrswap.example.toml'), path.join(deployDir, 'compose.yaml')]) {
      for (const m of readFileSync(name, 'utf8').matchAll(/pnpm --filter (@xmrswap\/[a-z-]+) (?:run )?([a-z:-]+)/g)) {
        const [, pkg, script] = m;
        if (script === 'exec') continue;
        seen += 1;
        expect(packages[pkg!], `${name}: ${m[0]}`).toBeDefined();
        expect(Object.keys(packages[pkg!]!), `${name}: ${m[0]}`).toContain(script);
      }
    }
    expect(seen).toBeGreaterThan(15);
  });

  it('marks every command that was not run on the build machine', () => {
    let notRun = 0;
    for (const name of pages) {
      const lines = page(name).split('\n');
      lines.forEach((line, i) => {
        const fence = /^\s*```(\S+)?\s*(\S+)?/.exec(line);
        if (!fence || !fence[1]) return;
        const before = lines.slice(Math.max(0, i - 6), i).join('\n');
        if (fence[2] === 'not-run') {
          notRun += 1;
          expect(before, `${name}:${i + 1}`).toMatch(/Not run (in this form |against a real cluster )?on the machine where this was written/);
        }
        // Commands that can only be "not run" here must be marked: Docker, a real Tor, systemd, a real node, git.
        if (fence[1] === 'sh' && fence[2] !== 'not-run') {
          const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
          const body = lines.slice(i + 1, end).join('\n');
          expect(body, `${name}:${i + 1} must be marked not-run`).not.toMatch(/\b(docker compose .* up|docker run|systemctl|monerod|git (pull|fetch|checkout)|rustup|cargo install|--onchain|get-program-hash)\b|^\s*tor /m);
          expect(body, `${name}:${i + 1} must be marked not-run`).not.toMatch(/@xmrswap\/(web|console) build|@xmrswap\/daemon start/);
        }
      });
    }
    expect(notRun).toBeGreaterThanOrEqual(10);
    // The compose path says exactly how far it was exercised.
    expect(page('quick-start.md')).toContain('**This path was built but not fully run.**');
    expect(page('quick-start.md')).toContain('with the port published on localhost and the Tor client running, was **not** run');
  });

  it('contains nothing from the machine it was written on, and no secret', () => {
    const files = [
      ...pages.map((p) => path.join(docsDir, p)),
      ...['README.md', 'DEVIATIONS.md', 'xmrswap.example.toml', 'compose.yaml', 'compose.schema.json', 'docker/Dockerfile', 'docker/tor.Dockerfile', 'systemd/xmrswap-selfhost.service'].map((f) => path.join(deployDir, f)),
    ];
    const home = process.env['HOME'] ?? '/nonexistent-home';
    const user = path.basename(home);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain(home);
      expect(text, file).not.toMatch(/\/home\/[a-z]/);
      expect(text, file).not.toMatch(/\/tmp\//);
      if (user.length > 3) expect(text.toLowerCase(), file).not.toContain(user.toLowerCase());
      // No RPC URL with a key, no key-looking value, no real host names besides the documentation domain.
      expect(text, file).not.toMatch(/api[-_]?key=[A-Za-z0-9]/i);
      expect(text, file).not.toMatch(/https?:\/\/[^\s"'`)]*(helius|alchemy|infura|quicknode|ankr|triton)[^\s"'`)]*/i);
      for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        const host = m[1]!;
        expect(['127.0.0.1', 'localhost', 'swap.example.org', 'json-schema.org'], `${file}: ${m[0]}`).toContain(host);
      }
    }
  });
});
