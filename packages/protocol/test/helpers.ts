import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Codec, type IdlType, type StructCodec, base58Encode } from '../src/borsh.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const readJson = (rel: string): any => JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8'));
export const frozenIdl = (): any => readJson('interfaces/solana/xmr_swap.idl.json');
export const frozenAbi = (): any[] => readJson('interfaces/ethereum/IXmrSwap.abi.json');
export const vector = (name: string): any => readJson(`interfaces/vectors/${name}.json`);

/** Deterministic pseudo-random bytes (xorshift), so failures reproduce. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => next() & 0xff);
  const big = (bits: number) => bytes(bits / 8).reduce((n, b) => (n << 8n) | BigInt(b), 0n);
  return { next, bytes, big };
}

/** A random value for a codec, driven by its IDL descriptor. `structs` resolves `defined` types. */
export function sample(idl: IdlType, structs: Map<string, StructCodec<unknown>>, r: ReturnType<typeof rng>): unknown {
  if (typeof idl === 'string') {
    switch (idl) {
      case 'u8': return r.next() & 0xff;
      case 'u16': return r.next() & 0xffff;
      case 'u32': return r.next() >>> 0;
      case 'u64': return r.big(64);
      case 'i64': return BigInt.asIntN(64, r.big(64));
      case 'u128': return r.big(128);
      case 'bool': return (r.next() & 1) === 1;
      case 'pubkey': return base58Encode(r.bytes(32));
      case 'string': return 'onion-' + (r.next() % 1000) + '-ü';
      case 'bytes': return r.bytes(r.next() % 50);
      default: throw new Error(`sample: ${idl}`);
    }
  }
  if ('array' in idl) {
    const [item, n] = idl.array;
    if (item === 'u8') return r.bytes(n);
    return Array.from({ length: n }, () => sample(item, structs, r));
  }
  if ('vec' in idl) return Array.from({ length: r.next() % 4 }, () => sample(idl.vec, structs, r));
  if ('option' in idl) return r.next() & 1 ? sample(idl.option, structs, r) : null;
  const s = structs.get(idl.defined.name);
  if (!s) throw new Error(`sample: unknown struct ${idl.defined.name}`);
  return sampleStruct(s, structs, r);
}
export function sampleStruct(s: StructCodec<unknown>, structs: Map<string, StructCodec<unknown>>, r: ReturnType<typeof rng>): Record<string, unknown> {
  return Object.fromEntries(s.fields.map(([key, , codec]) => [key, sample((codec as Codec<unknown>).idl, structs, r)]));
}
