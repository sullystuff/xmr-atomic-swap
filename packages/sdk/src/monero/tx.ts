/**
 * Pure-JS Monero transaction parsing, txid recomputation and view-key output scanning
 * (SPEC 2.11), lifted from `tests/monero-regtest/lib/monero.mjs` into typed TypeScript. Only
 * `@noble/*`: the same file runs in Node and in the browser, with no wasm and no wallet.
 *
 * This is the one piece of cryptography the SDK implements itself (SPEC 2: "except the pure-JS
 * Monero transaction scan"). Key derivation, addresses and everything else stay in the core.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Bytes, bigToLe, concat, hex, leToBig, unhex, utf8 } from '../util.js';

const Point = ed25519.Point;
type EdPoint = InstanceType<typeof Point>;
const L = Point.Fn.ORDER;
const G = Point.BASE;
/** Second Pedersen generator `H` (rctTypes.h), used for amount commitments. */
const H = Point.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94');

const mulAny = (P: EdPoint, n: bigint): EdPoint => (n === 0n ? Point.ZERO : P.multiplyUnsafe(n));
/** `Hs(...)`: keccak256 reduced mod l. */
const hashToScalar = (...parts: Bytes[]): bigint => leToBig(keccak_256(concat(...parts))) % L;

export class MoneroParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneroParseError';
  }
}

export function encodeVarint(value: bigint | number): Bytes {
  let n = BigInt(value);
  const o: number[] = [];
  while (n >= 0x80n) {
    o.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  o.push(Number(n));
  return Uint8Array.from(o);
}

class Reader {
  o = 0;
  constructor(readonly b: Bytes) {}
  byte(): number {
    if (this.o >= this.b.length) throw new MoneroParseError('tx truncated');
    return this.b[this.o++]!;
  }
  bytes(n: number): Bytes {
    if (n < 0 || this.o + n > this.b.length) throw new MoneroParseError('tx truncated');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  varint(): bigint {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      const c = this.byte();
      n |= BigInt(c & 0x7f) << shift;
      if (!(c & 0x80)) return n;
      shift += 7n;
      if (shift > 63n) throw new MoneroParseError('varint too long');
    }
  }
  /** A varint used as a count or length: bounded by what is left in the buffer. */
  count(): number {
    const n = this.varint();
    if (n > BigInt(this.b.length)) throw new MoneroParseError('count exceeds the blob');
    return Number(n);
  }
}

export interface TxInput {
  type: 'gen' | 'key';
  /** Key image, hex (key inputs). */
  keyImage?: string;
  height?: bigint;
}
export interface TxOutput {
  amount: bigint;
  /** One-time output key, hex. */
  key: string;
  viewTag: number | null;
  /** 8-byte masked amount (RingCT). */
  encAmount?: Bytes;
  /** Pedersen commitment `outPk`, hex (RingCT). */
  commitment?: string;
}
export interface TxExtra {
  txPubKeys: string[];
  additionalPubKeys: string[];
  nonces: string[];
}
export interface ParsedTx {
  version: number;
  unlockTime: bigint;
  inputs: TxInput[];
  outputs: TxOutput[];
  extra: TxExtra;
  rctType: number;
  fee: bigint;
  /** The three byte ranges whose hashes make the txid. */
  prefixBytes: Bytes;
  baseBytes: Bytes;
  prunableBytes: Bytes;
}

/** Parse a v2 (RingCT) transaction from its full or pruned blob (consensus serialisation). */
export function parseTx(blob: Bytes | string): ParsedTx {
  const r = new Reader(typeof blob === 'string' ? unhex(blob) : blob);
  const version = Number(r.varint());
  const unlockTime = r.varint();
  if (version !== 2) throw new MoneroParseError(`unsupported tx version ${version}`);
  const inputs: TxInput[] = [];
  const nIn = r.count();
  for (let i = 0; i < nIn; i++) {
    const tag = r.byte();
    if (tag === 0xff) inputs.push({ type: 'gen', height: r.varint() });
    else if (tag === 0x02) {
      r.varint();
      const n = r.count();
      for (let k = 0; k < n; k++) r.varint();
      inputs.push({ type: 'key', keyImage: hex(r.bytes(32)) });
    } else throw new MoneroParseError(`unknown input tag ${tag}`);
  }
  const outputs: TxOutput[] = [];
  const nOut = r.count();
  for (let i = 0; i < nOut; i++) {
    const amount = r.varint();
    const tag = r.byte();
    if (tag === 0x02) outputs.push({ amount, key: hex(r.bytes(32)), viewTag: null });
    else if (tag === 0x03) outputs.push({ amount, key: hex(r.bytes(32)), viewTag: r.byte() });
    else throw new MoneroParseError(`unknown output tag ${tag}`);
  }
  const extra = r.bytes(r.count());
  const prefixEnd = r.o;
  const rctType = r.byte();
  let fee = 0n;
  if (rctType !== 0) {
    if (rctType < 4) throw new MoneroParseError(`pre-2019 RingCT type ${rctType} not supported`); // full 64-byte ecdhInfo
    fee = r.varint();
    for (const o of outputs) o.encAmount = r.bytes(8); // ecdhInfo: 8-byte masked amount
    for (const o of outputs) o.commitment = hex(r.bytes(32)); // outPk
  }
  const baseEnd = r.o;
  return { version, unlockTime, inputs, outputs, extra: parseExtra(extra), rctType, fee, prefixBytes: r.b.subarray(0, prefixEnd), baseBytes: r.b.subarray(prefixEnd, baseEnd), prunableBytes: r.b.subarray(baseEnd) };
}

function parseExtra(extra: Bytes): TxExtra {
  const r = new Reader(extra);
  const out: TxExtra = { txPubKeys: [], additionalPubKeys: [], nonces: [] };
  try {
    while (r.o < extra.length) {
      const tag = r.byte();
      if (tag === 0x00) break; // padding: the rest is zeros
      else if (tag === 0x01) out.txPubKeys.push(hex(r.bytes(32))); // tx public key R
      else if (tag === 0x02) out.nonces.push(hex(r.bytes(r.count()))); // payment id etc.
      else if (tag === 0x03) r.bytes(r.count()); // merge-mining tag
      else if (tag === 0x04) {
        const n = r.count();
        for (let i = 0; i < n; i++) out.additionalPubKeys.push(hex(r.bytes(32)));
      } else if (tag === 0xde) r.bytes(r.count()); // "mysterious minergate"
      else break;
    }
  } catch {
    // A malformed extra just yields fewer candidate keys, as in wallet2.
  }
  return out;
}

/**
 * `txid = keccak( keccak(prefix) ‖ keccak(rct base) ‖ keccak(rct prunable) )`. Pass
 * `prunableHash` when the node pruned the third part (the pruned form is accepted).
 */
export function computeTxid(tx: ParsedTx, prunableHash?: string): string {
  if (tx.rctType === 0) throw new MoneroParseError('coinbase and v2-null txids are not supported');
  if (!prunableHash && tx.prunableBytes.length === 0) throw new MoneroParseError('need the prunable part or its hash');
  const ph = prunableHash ? unhex(prunableHash) : keccak_256(tx.prunableBytes);
  return hex(keccak_256(concat(keccak_256(tx.prefixBytes), keccak_256(tx.baseBytes), ph)));
}

export interface ScannedOutput {
  /** Index of the output inside the transaction. */
  index: number;
  /** Decrypted amount, piconero. */
  amount: bigint;
  /** One-time output key, hex. */
  key: string;
  /** The decrypted amount opens the Pedersen commitment the network validated. An unverified amount is attacker-chosen. */
  commitmentOk: boolean;
  /** The tx public key the output was derived with, hex. */
  txPubKey: string;
}

/**
 * Outputs of `tx` that pay the standard address with public spend key `spendPub`, found with
 * the private view key: `D = 8·v·R`, view tag checked first, `P' = Hs(D ‖ varint(i))·G + S`,
 * additional tx keys handled. For every hit the amount is decrypted and checked against the
 * output's commitment.
 */
export function scanTx(tx: ParsedTx, viewPriv: Bytes | string, spendPub: Bytes | string): ScannedOutput[] {
  const v = leToBig(typeof viewPriv === 'string' ? unhex(viewPriv) : viewPriv);
  if (v === 0n || v >= L) throw new MoneroParseError('view key is not a canonical nonzero scalar');
  const S = Point.fromHex(typeof spendPub === 'string' ? spendPub.toLowerCase() : hex(spendPub));
  const found: ScannedOutput[] = [];
  tx.outputs.forEach((o, i) => {
    // Candidate tx keys: the main R, or the per-output additional key (used when the sender's
    // transaction also pays a subaddress). wallet2 tries both.
    const cands = [...tx.extra.txPubKeys];
    const extraKey = tx.extra.additionalPubKeys[i];
    if (extraKey) cands.push(extraKey);
    for (const Rhex of cands) {
      let R: EdPoint;
      try {
        R = Point.fromHex(Rhex);
      } catch {
        continue;
      }
      const D = mulAny(R, v).multiplyUnsafe(8n).toBytes(); // key derivation 8·v·R
      const idx = encodeVarint(i);
      if (o.viewTag !== null && keccak_256(concat(utf8('view_tag'), D, idx))[0] !== o.viewTag) continue;
      const hs = hashToScalar(D, idx); // Hs(D ‖ i)
      const P = mulAny(G, hs).add(S).toBytes(); // one-time key Hs·G + S
      if (hex(P) !== o.key) continue;
      if (!o.encAmount || !o.commitment) continue; // not a RingCT output
      const hsBytes = bigToLe(hs);
      const pad = keccak_256(concat(utf8('amount'), hsBytes));
      let amount = 0n;
      for (let k = 7; k >= 0; k--) amount = (amount << 8n) | BigInt(o.encAmount[k]! ^ pad[k]!);
      const mask = hashToScalar(utf8('commitment_mask'), hsBytes);
      const C = mulAny(G, mask).add(mulAny(H, amount)).toBytes(); // mask·G + amount·H
      found.push({ index: i, amount, key: o.key, commitmentOk: hex(C) === o.commitment, txPubKey: Rhex });
      break;
    }
  });
  return found;
}

export const PICONERO = 1_000_000_000_000n;
/** Piconero as a decimal XMR string, for display. */
export function formatXmr(piconero: bigint): string {
  const frac = (piconero % PICONERO).toString().padStart(12, '0').replace(/0+$/, '');
  return `${piconero / PICONERO}${frac ? `.${frac}` : ''}`;
}
