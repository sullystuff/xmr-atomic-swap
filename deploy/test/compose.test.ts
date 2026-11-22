/**
 * The compose file is checked as a document: parsed as YAML and validated against the bundled
 * schema. Docker is never called (it is not installed on the build machine and is never needed).
 */
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, parseDocument } from 'yaml';
import { SETTINGS } from '../src/settings.js';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const schema = JSON.parse(read('compose.schema.json')) as object;
const validate = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
const source = read('compose.yaml');

interface Compose {
  services: Record<string, { ports?: string[]; environment?: Record<string, string>; networks?: string[]; build?: { context: string; dockerfile?: string }; volumes?: string[]; depends_on?: string[] }>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}
const clone = (): Compose => parseYaml(source) as Compose;

describe('deploy/compose.yaml', () => {
  it('is well-formed YAML with no warnings and no duplicate keys', () => {
    const doc = parseDocument(source, { uniqueKeys: true, strict: true });
    expect(doc.errors).toEqual([]);
    expect(doc.warnings).toEqual([]);
  });

  it('validates against the bundled schema', () => {
    const ok = validate(clone());
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the schema refuses what the bundle must never ship', () => {
    const cases: [string, (c: Compose) => void][] = [
      ['a port published on every interface', (c) => void (c.services['web']!.ports = ['8780:8780'])],
      ['a port published on 0.0.0.0', (c) => void (c.services['web']!.ports = ['0.0.0.0:8780:8780'])],
      ['a privileged container', (c) => void ((c.services['web'] as Record<string, unknown>)['privileged'] = true)],
      ['host networking', (c) => void ((c.services['tor'] as Record<string, unknown>)['network_mode'] = 'host')],
      ['a host directory mounted into a container', (c) => void (c.services['tor']!.volumes = ['/var/run/docker.sock:/var/run/docker.sock'])],
      ['a relative host path mounted', (c) => void (c.services['tor']!.volumes = ['./data:/var/lib/tor'])],
      ['an unknown top-level key', (c) => void ((c as unknown as Record<string, unknown>)['secrets'] = {})],
      ['a service with neither image nor build', (c) => void delete c.services['tor']!.build],
      ['no services', (c) => void (c.services = {})],
    ];
    for (const [what, change] of cases) {
      const c = clone();
      change(c);
      expect(validate(c), what).toBe(false);
    }
  });

  it('publishes only the UI port, on localhost, and gives Tor no port at all', () => {
    const c = clone();
    expect(Object.keys(c.services).sort()).toEqual(['tor', 'web']);
    expect(c.services['web']!.ports).toEqual(['127.0.0.1:8780:8780']);
    expect(c.services['tor']!.ports).toBeUndefined();
    expect(c.services['web']!.depends_on).toEqual(['tor']);
  });

  it('refers only to things that exist: networks, volumes, Dockerfiles and settings', () => {
    const c = clone();
    for (const [name, svc] of Object.entries(c.services)) {
      for (const n of svc.networks ?? []) expect(Object.keys(c.networks ?? {}), `${name}: network ${n}`).toContain(n);
      for (const v of svc.volumes ?? []) expect(Object.keys(c.volumes ?? {}), `${name}: volume ${v}`).toContain(v.split(':')[0]);
      // The build files are part of the bundle.
      const file = new URL(`../${svc.build!.context}/${svc.build!.dockerfile}`, import.meta.url);
      expect(readFileSync(file, 'utf8'), name).toContain('FROM ');
    }
    // Every variable handed to the web service is a real setting or one of the two RPC variables.
    const known = new Set([...SETTINGS.map((s) => s.env), 'SOLANA_RPC_URL', 'ETHEREUM_RPC_URL']);
    const env = c.services['web']!.environment!;
    for (const name of Object.keys(env)) expect(known, name).toContain(name);
    expect(env['XMRSWAP_UI_PUBLIC_ORIGIN']).toBe('http://127.0.0.1:8780');
    expect(env['RELAY_TOR_SOCKS']).toBe('tor:9050');
    // No secret is written into the file: RPC URLs are passed through from the caller's environment.
    expect(env['SOLANA_RPC_URL']).toBe('${SOLANA_RPC_URL:-}');
    expect(env['ETHEREUM_RPC_URL']).toBe('${ETHEREUM_RPC_URL:-}');
    expect(source).not.toMatch(/api[-_]?key\s*[=:]/i);
  });

  it('says in the file that it was not run here', () => {
    expect(source).toContain('NOT RUN on the machine where this was written');
    for (const f of ['docker/Dockerfile', 'docker/tor.Dockerfile']) expect(read(f), f).toContain('NOT BUILT on the machine where this was written');
  });
});

describe('deploy/systemd/xmrswap-selfhost.service', () => {
  const unit = read('systemd/xmrswap-selfhost.service');
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | null = null;
  for (const line of unit.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const section = /^\[([A-Za-z]+)\]$/.exec(line);
    if (section) {
      current = new Map();
      sections.set(section[1]!, current);
      continue;
    }
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!kv || !current) throw new Error(`not a unit-file line: ${line}`);
    current.set(kv[1]!, [...(current.get(kv[1]!) ?? []), kv[2]!]);
  }

  it('is a user unit that runs the start command and nothing privileged', () => {
    expect([...sections.keys()]).toEqual(['Unit', 'Service', 'Install']);
    const service = sections.get('Service')!;
    expect(service.get('ExecStart')).toEqual(['/usr/bin/pnpm --filter @xmrswap/deploy start']);
    expect(service.get('NoNewPrivileges')).toEqual(['true']);
    // A user unit: no User=, and it is wanted by the user's default target.
    expect(service.has('User')).toBe(false);
    expect(sections.get('Install')!.get('WantedBy')).toEqual(['default.target']);
    // Secrets come from a file in the user's home, named with a specifier, never written here.
    expect(service.get('EnvironmentFile')).toEqual(['%h/.config/xmrswap/env']);
    expect(unit).not.toMatch(/\/home\//);
    expect(unit).not.toMatch(/tor\.service/);
  });
});
