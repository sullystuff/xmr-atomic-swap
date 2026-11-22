/**
 * IDL conformance for the wXMR bridge encoders and decoders.
 *
 * SPEC 7.7 and 10.1: the project owner supplies the bridge's current IDL at
 * `packages/rebalancer/vendor/wxmr_bridge.json`. While that file is absent this suite is
 * SKIPPED, and the run prints a notice saying so (vitest.config.ts); `bridge-program.test.ts` still pins the encodings to the layout assumed in
 * `BRIDGE-ASSUMPTIONS.md`. When the file is present, every assumed row is compared with it.
 *
 * `WXMR_BRIDGE_IDL=<path>` points the suite at an IDL elsewhere without copying it into the
 * repository.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRIDGE_PROGRAM_ID, LAYOUT, accountDiscriminator, eventDiscriminator, instructionDiscriminator } from '../src/index.js';

const vendorPath = fileURLToPath(new URL('../vendor/wxmr_bridge.json', import.meta.url));
const idlPath = process.env['WXMR_BRIDGE_IDL'] || vendorPath;
const present = existsSync(idlPath);

type IdlType = string | { array?: [IdlType, number]; defined?: { name: string } | string; vec?: IdlType; option?: IdlType };
const typeName = (t: IdlType, enums: Set<string>): string => {
  if (typeof t === 'string') return t === 'publicKey' ? 'pubkey' : t;
  if (t.array && t.array[0] === 'u8' && t.array[1] === 32) return 'bytes32';
  if (t.vec === 'u8') return 'bytes';
  if (t.defined) { const n = typeof t.defined === 'string' ? t.defined : t.defined.name; return enums.has(n) ? 'enum' : `defined:${n}`; }
  return JSON.stringify(t);
};

describe.skipIf(!present)('wXMR bridge IDL conformance (vendor/wxmr_bridge.json)', () => {
  const idl = present ? JSON.parse(readFileSync(idlPath, 'utf8')) : {};
  const types: Record<string, any> = Object.fromEntries((idl.types ?? []).map((t: any) => [t.name, t.type]));
  const enums = new Set(Object.entries(types).filter(([, t]) => t.kind === 'enum').map(([n]) => n));
  const fields = (name: string) => (types[name]?.fields ?? []).map((f: any) => ({ name: f.name, type: typeName(f.type, enums) }));

  it('is the IDL of the bridge program', () => {
    expect(idl.address).toBe(BRIDGE_PROGRAM_ID.toBase58());
  });

  for (const spec of Object.values(LAYOUT.instructions)) {
    it(`instruction ${spec.name}: discriminator, arguments and account order with flags`, () => {
      const ix = (idl.instructions ?? []).find((i: any) => i.name === spec.name);
      expect(ix, `the IDL has no instruction ${spec.name}`).toBeDefined();
      expect(Buffer.from(ix.discriminator).toString('hex')).toBe(instructionDiscriminator(spec.name).toString('hex'));
      expect(ix.args.map((a: any) => ({ name: a.name, type: typeName(a.type, enums) }))).toEqual(spec.args);
      expect(ix.accounts.map((a: any) => ({ name: a.name, writable: !!a.writable, signer: !!a.signer }))).toEqual(spec.accounts);
    });
  }

  for (const [name, layout] of Object.entries(LAYOUT.accounts)) {
    it(`account ${name}: discriminator and field layout`, () => {
      const acc = (idl.accounts ?? []).find((a: any) => a.name === name);
      expect(acc, `the IDL has no account ${name}`).toBeDefined();
      expect(Buffer.from(acc.discriminator).toString('hex')).toBe(accountDiscriminator(name).toString('hex'));
      expect(fields(name)).toEqual(layout);
    });
  }

  for (const [name, layout] of Object.entries(LAYOUT.events)) {
    it(`event ${name}: discriminator and field layout`, () => {
      const ev = (idl.events ?? []).find((e: any) => e.name === name);
      expect(ev, `the IDL has no event ${name}`).toBeDefined();
      expect(Buffer.from(ev.discriminator).toString('hex')).toBe(eventDiscriminator(name).toString('hex'));
      expect(fields(name)).toEqual(layout);
    });
  }

  for (const [name, variants] of Object.entries(LAYOUT.enums)) {
    it(`enum ${name}: variant order`, () => {
      expect((types[name]?.variants ?? []).map((v: any) => v.name)).toEqual(variants);
    });
  }
});

describe('wXMR bridge IDL conformance: availability', () => {
  if (!present) {
    it.skip('NOT RUN - the owner has not supplied vendor/wxmr_bridge.json; bridge encodings are checked only against BRIDGE-ASSUMPTIONS.md', () => {});
  }
  it.skipIf(!present)('the supplied IDL is current: it has cancel_withdrawal and the heartbeat instructions (the stale copy lacks them)', () => {
    const idl = JSON.parse(readFileSync(idlPath, 'utf8'));
    const names = new Set((idl.instructions ?? []).map((i: any) => i.name));
    for (const n of ['cancel_withdrawal', 'publish_heartbeat', 'write_heartbeat_page', 'create_deposit_account', 'request_withdrawal']) expect(names.has(n), n).toBe(true);
  });
});
