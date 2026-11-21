// The generated Solana codecs against (1) the frozen IDL, field by field, (2) the layouts and
// offsets written in SPEC 4.2, and (3) an independent Borsh implementation: the coders of
// @coral-xyz/anchor 0.32.1 built from the same IDL must produce the same bytes.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import anchor from '@coral-xyz/anchor';
import { describe, expect, it } from 'vitest';
import { type Codec, type IdlType, type StructCodec, base58Decode, base58Encode, encode } from '../src/borsh.js';
import * as p from '../src/index.js';
import * as generated from '../src/generated/solana.js';
import { frozenIdl, repoRoot, rng, sample, sampleStruct } from './helpers.js';

const { BN, BorshCoder, web3 } = anchor;
const idl = frozenIdl();
const idlTypes = new Map<string, any>(idl.types.map((t: any) => [t.name, t]));
const structs = new Map<string, StructCodec<unknown>>(
  Object.entries(generated)
    .filter(([name, v]) => name.endsWith('Codec') && typeof v === 'object' && v !== null && 'fields' in v)
    .map(([, v]) => [(v as StructCodec<unknown>).name, v as StructCodec<unknown>]),
);

describe('generated code is current', () => {
  it('scripts/generate.mjs --check passes', () => {
    execFileSync(process.execPath, [path.join(repoRoot, 'packages/protocol/scripts/generate.mjs'), '--check'], { stdio: 'pipe' });
  });
});

describe('codecs against the frozen IDL', () => {
  it('every IDL type has a codec with the same fields, in order, with the same types', () => {
    expect(idl.types.length).toBeGreaterThan(50);
    for (const t of idl.types) {
      const codec = structs.get(t.name);
      expect(codec, t.name).toBeDefined();
      expect(codec!.fields.map(([, idlName, c]) => ({ name: idlName, type: (c as Codec<unknown>).idl }))).toEqual(
        t.type.fields.map((f: any) => ({ name: f.name, type: f.type })),
      );
    }
  });

  it('every account, event and instruction is in the tables with the IDL discriminator', () => {
    expect(Object.keys(p.ACCOUNTS).sort()).toEqual(idl.accounts.map((a: any) => a.name).sort());
    for (const a of idl.accounts) expect([...p.ACCOUNTS[a.name as p.AccountName].discriminator]).toEqual(a.discriminator);
    expect(Object.keys(p.EVENTS).sort()).toEqual(idl.events.map((e: any) => e.name).sort());
    for (const e of idl.events) expect([...p.EVENTS[e.name as p.EventName].discriminator]).toEqual(e.discriminator);
    expect(Object.keys(p.INSTRUCTIONS).length).toBe(idl.instructions.length);
    for (const i of idl.instructions) {
      const ours = Object.values(p.INSTRUCTIONS).find((x) => x.name === i.name)!;
      expect([...ours.discriminator], i.name).toEqual(i.discriminator);
      expect(ours.accounts).toEqual(i.accounts.map((a: any) => ({ name: a.name, writable: !!a.writable, signer: !!a.signer, optional: !!a.optional })));
      expect(ours.args.fields.map(([, n, c]) => ({ name: n, type: (c as Codec<unknown>).idl }))).toEqual(i.args.map((a: any) => ({ name: a.name, type: a.type })));
    }
    expect(p.ERROR_NAMES).toEqual(idl.errors.map((e: any) => e.name));
    expect(p.ERROR_CODE_BASE).toBe(6000);
    expect(p.errorName(6000)).toBe('Unauthorized');
    expect(p.errorName(6009)).toBe('ScalarMismatch');
    expect(p.errorCode('MathOverflow')).toBe(6049);
    expect(p.errorName(5999)).toBeNull();
    expect(p.DEV_PROGRAM_ID).toBe(idl.address);
  });
});

describe('layouts of SPEC 4.1 and 4.2', () => {
  it('fixed account sizes, discriminator included', () => {
    expect(8 + p.ConfigCodec.size!).toBe(256);
    expect(8 + p.TreasuryCodec.size!).toBe(16);
    expect(8 + p.OfferCodec.size!).toBe(768);
    expect(8 + p.QuoteCodec.size!).toBe(192);
    expect(8 + p.SwapCodec.size!).toBe(736);
    // EthBoard uses 1,341 of its 1,408 bytes; a slot is 325.
    expect(p.EthQuoteSlotCodec.size).toBe(1 + 8 + 251 + 65);
    expect(8 + p.EthBoardCodec.size!).toBe(1341);
    expect(p.ACCOUNT_SIZE).toEqual({ Config: 256, Treasury: 16, Maker: 1280, Offer: 768, EthBoard: 1408, Quote: 192, Swap: 736 });
    // Maker: the fixed part ends at 457; a full onion and six full contacts fit in 1,280.
    expect(p.MakerCodec.size).toBeNull();
    expect(8 + p.MakerCodec.offsetOf('onion')).toBe(457);
    expect(457 + 4 + p.MAX_ONION_LEN + 4 + p.MAX_CONTACTS * (1 + 4 + p.MAX_CONTACT_LEN)).toBeLessThanOrEqual(1280);
  });

  it('Swap field offsets', () => {
    const at = (f: string) => 8 + p.SwapCodec.offsetOf(f);
    const expected: Record<string, number> = {
      taker: 8, maker: 40, state: 72, direction: 73, asset: 74, mode: 75, outcome: 76, depositState: 77, depth: 78, flags: 79,
      bump: 80, vaultBump: 81, swapNonce: 82, sessionKey: 98, takerEncKey: 130, makerEncVersion: 162, makerEncKey: 166,
      amount: 198, deposit: 206, xmr: 214, price: 222, depBps: 230, feeBps: 232, wN: 234, dC: 238, wC: 242,
      takerSpendPub: 246, makerSpendPub: 278, lockerView: 310, noticeCommitment: 342, noticeCt: 374,
      evidenceTxid: 478, evidenceView: 510, revealed: 542, tLock: 574, tPendingDeadline: 582, tActive: 590, tNoteDeadline: 598,
      tNotice: 606, tCut: 614, tClaimOpen: 622, tReady: 630, tClaimDeadline: 638, tFinal: 646, tRefund: 654, tSettled: 662,
      owedTaker: 670, owedMaker: 678, owedTreasury: 686, reserved: 694,
    };
    for (const [field, offset] of Object.entries(expected)) expect(at(field), field).toBe(offset);
    expect(Object.keys(expected).length).toBe(p.SwapCodec.fields.length);
  });

  it('memcmp offsets and discriminators clients filter on', () => {
    expect(8 + p.MakerCodec.offsetOf('owner')).toBe(p.OFFSET.maker.owner);
    expect(8 + p.MakerCodec.offsetOf('operator')).toBe(p.OFFSET.maker.operator);
    expect(8 + p.MakerCodec.offsetOf('payout')).toBe(p.OFFSET.maker.payout);
    expect(8 + p.OfferCodec.offsetOf('maker')).toBe(p.OFFSET.offer.maker);
    expect(8 + p.OfferCodec.offsetOf('asset')).toBe(p.OFFSET.offer.asset);
    expect(8 + p.OfferCodec.offsetOf('direction')).toBe(p.OFFSET.offer.direction);
    expect(8 + p.OfferCodec.offsetOf('enabled')).toBe(p.OFFSET.offer.enabled);
    expect(8 + p.OfferCodec.offsetOf('mode')).toBe(p.OFFSET.offer.mode);
    expect(8 + p.QuoteCodec.offsetOf('maker')).toBe(p.OFFSET.quote.maker);
    expect(8 + p.QuoteCodec.offsetOf('taker')).toBe(p.OFFSET.quote.taker);
    expect(8 + p.SwapCodec.offsetOf('taker')).toBe(p.OFFSET.swap.taker);
    expect(8 + p.SwapCodec.offsetOf('maker')).toBe(p.OFFSET.swap.maker);
    expect(8 + p.SwapCodec.offsetOf('state')).toBe(p.OFFSET.swap.state);
    // SPEC 4: `Maker` = base58 `6MSKcZArUDQ`, `Swap` = `9zzgj4NEBqr`.
    expect(base58Encode(p.ACCOUNTS.Maker.discriminator)).toBe('6MSKcZArUDQ');
    expect(base58Encode(p.ACCOUNTS.Swap.discriminator)).toBe('9zzgj4NEBqr');
    expect(p.DISCRIMINATOR_BASE58).toEqual({ Maker: '6MSKcZArUDQ', Swap: '9zzgj4NEBqr' });
  });

  it('argument sizes of SPEC 4.4', () => {
    const r = rng(1);
    const lock = sampleStruct(p.LockArgsCodec as StructCodec<unknown>, structs, r);
    expect(encode(p.LockArgsCodec, { ...lock, approvalIx: null } as p.LockArgs).length).toBe(247);
    expect(encode(p.LockArgsCodec, { ...lock, approvalIx: 1 } as p.LockArgs).length).toBe(248);
    const take = sampleStruct(p.TakeArgsCodec as StructCodec<unknown>, structs, r);
    expect(encode(p.TakeArgsCodec, { ...take, approvalIx: null } as p.TakeArgs).length).toBe(214);
    expect(encode(p.TakeArgsCodec, { ...take, approvalIx: 0 } as p.TakeArgs).length).toBe(215);
    // refill_keys with eight slots: 8 + 1 + 4 + 8 × 97 bytes of data.
    const slots = Array.from({ length: 8 }, (_, i) => ({ index: i, share: r.bytes(32), pok: r.bytes(64) }));
    expect(p.encodeInstructionData('refillKeys', { asset: 0, slots }).length).toBe(8 + 1 + 4 + 8 * 97);
    // post_message with a 900-byte payload.
    expect(p.encodeInstructionData('postMessage', { payload: new Uint8Array(900) }).length).toBe(8 + 4 + 900);
  });
});

// ---------------------------------------------------------------- against @coral-xyz/anchor

const coder = new BorshCoder(idl);

/** Convert one of our values to what anchor's coder takes (snake_case keys, PublicKey, BN, number[]). */
function toAnchor(idlType: IdlType, v: unknown): unknown {
  if (typeof idlType === 'string') {
    if (idlType === 'pubkey') return new web3.PublicKey(base58Decode(v as string));
    if (idlType === 'u64' || idlType === 'i64' || idlType === 'u128') return new BN((v as bigint).toString());
    if (idlType === 'bytes') return Buffer.from(v as Uint8Array);
    return v;
  }
  if ('array' in idlType) {
    if (idlType.array[0] === 'u8') return Array.from(v as Uint8Array);
    return (v as unknown[]).map((x) => toAnchor(idlType.array[0], x));
  }
  if ('vec' in idlType) return (v as unknown[]).map((x) => toAnchor(idlType.vec, x));
  if ('option' in idlType) return v === null ? null : toAnchor(idlType.option, v);
  return structToAnchor(structs.get(idlType.defined.name)!, v as Record<string, unknown>);
}
function structToAnchor(s: StructCodec<unknown>, v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(s.fields.map(([key, idlName, c]) => [idlName, toAnchor((c as Codec<unknown>).idl, v[key])]));
}

describe('byte-for-byte agreement with @coral-xyz/anchor', () => {
  it('accounts', async () => {
    for (const a of idl.accounts) {
      const name = a.name as p.AccountName;
      for (let seed = 1; seed <= 5; seed++) {
        const value = sampleStruct(structs.get(name)!, structs, rng(seed * 31 + name.length));
        const ours = p.encodeAccount(name, value as never);
        const asAnchor = structToAnchor(structs.get(name)!, value);
        if (ours.length <= 1000) {
          const theirs = await coder.accounts.encode(name, asAnchor);
          expect(Buffer.from(ours).toString('hex'), name).toBe(Buffer.from(theirs).toString('hex'));
        } else {
          // anchor's account encoder writes into a fixed 1,000-byte buffer; EthBoard is larger.
          // Its decoder has no such limit: it must read our bytes back to the same fields.
          expect(name).toBe('EthBoard');
        }
        expect(normalize(coder.accounts.decode(name, Buffer.from(ours))), name).toEqual(normalize(asAnchor));
        // Round trip, with the zero padding the program allocates.
        const padded = p.encodeAccount(name, value as never, p.ACCOUNT_SIZE[name]);
        expect(padded.length).toBe(p.ACCOUNT_SIZE[name]);
        expect(p.decodeAccount(name, padded)).toEqual(value);
        expect(p.accountNameOf(padded)).toBe(name);
      }
    }
  });

  it('events, through the log line format', () => {
    for (const e of idl.events) {
      const name = e.name as p.EventName;
      const value = sampleStruct(structs.get(name)!, structs, rng(name.length * 7 + 3));
      const ours = p.encodeEvent(name, value as never);
      // anchor's EventCoder only decodes; check that it decodes our bytes to the same fields.
      const decoded = coder.events.decode(Buffer.from(ours).toString('base64'));
      expect(decoded?.name, name).toBe(name);
      expect(normalize(decoded!.data)).toEqual(normalize(structToAnchor(structs.get(name)!, value)));
      // And our parser reads the log line.
      const logs = ['Program log: Instruction: Claim', `Program data: ${Buffer.from(ours).toString('base64')}`, 'Program data: not-base64!', 'Program data: AAAA'];
      const parsed = p.parseEventLogs(logs);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({ name, data: value });
    }
  });

  it('instruction data', () => {
    for (const i of idl.instructions) {
      const key = Object.keys(p.INSTRUCTIONS).find((k) => p.INSTRUCTIONS[k as p.InstructionName].name === i.name) as p.InstructionName;
      const argsCodec = p.INSTRUCTIONS[key].args as unknown as StructCodec<unknown>;
      for (let seed = 1; seed <= 3; seed++) {
        const value = sampleStruct(argsCodec, structs, rng(seed * 101 + i.name.length));
        const ours = p.encodeInstructionData(key, value as never);
        const theirs = coder.instruction.encode(i.name, structToAnchor(argsCodec, value));
        expect(Buffer.from(ours).toString('hex'), i.name).toBe(Buffer.from(theirs).toString('hex'));
        expect(p.decodeInstructionData(ours)).toEqual({ name: key, args: value });
      }
    }
    expect(p.decodeInstructionData(new Uint8Array(8))).toBeNull();
  });
});

/** Compare anchor-shaped values structurally (BN and PublicKey to strings, Buffers to arrays). */
function normalize(v: unknown): unknown {
  if (v instanceof web3.PublicKey) return v.toBase58();
  if (BN.isBN(v)) return (v as InstanceType<typeof BN>).toString();
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

describe('decoding rejects what it should', () => {
  it('wrong discriminator, truncation, trailing bytes, bad values', () => {
    const value = sampleStruct(structs.get('Quote')!, structs, rng(9)) as never;
    const data = p.encodeAccount('Quote', value, 192);
    expect(() => p.decodeAccount('Swap', data)).toThrow(/not a Swap account/);
    expect(() => p.decodeAccount('Quote', data.subarray(0, 100))).toThrow(/unexpected end/);
    expect(p.accountNameOf(new Uint8Array(736))).toBeNull();
    const ev = p.encodeEvent('SwapClosed', sampleStruct(structs.get('SwapClosed')!, structs, rng(4)) as never);
    const longer = new Uint8Array(ev.length + 1);
    longer.set(ev);
    expect(() => p.decodeEvent(longer)).toThrow(/trailing/);
    expect(p.decodeEvent(new Uint8Array(20))).toBeNull();
    expect(() => p.encodeInstructionData('claim', { secret: new Uint8Array(31) })).toThrow(/expected 32 bytes/);
    expect(() => p.encodeInstructionData('sweepTreasury', { asset: 0, amount: -1n })).toThrow(/out of range/);
    expect(() => p.encodeInstructionData('sweepTreasury', { asset: 256, amount: 1n })).toThrow(/out of range/);
    expect(() => p.encodeInstructionData('setOperator', { operator: 'not base58 0OIl' })).toThrow(/base58/);
    expect(() => p.encodeInstructionData('setOperator', { operator: '1111' })).toThrow(/32 bytes/);
  });

  it('base58 round-trips, leading zeros included', () => {
    for (const hex of ['00', '0000ff', 'ff', '00'.repeat(32), 'ab'.repeat(32)]) {
      const b = p.fromHex(hex);
      expect(p.toHex(base58Decode(base58Encode(b)))).toBe(hex);
    }
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(base58Encode(base58Decode(p.DEV_PROGRAM_ID))).toBe(p.DEV_PROGRAM_ID);
  });
});
