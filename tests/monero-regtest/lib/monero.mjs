// Pure-JS Monero primitives needed by the swap: joint-key derivation, address encoding,
// transaction parsing, txid recomputation and view-key output scanning.
// No WASM, no wallet: runs unchanged in Node and in the browser (only @noble deps).
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes };
const Point = ed25519.Point;
export const L = Point.Fn.ORDER; // 2^252 + 27742317777372353535851937790883648493
const G = Point.BASE;
// Second Pedersen generator H = 8 * to_point(keccak(G)) (rctTypes.h), used for amount commitments.
const H = Point.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94');

// ---------- scalars (32-byte little-endian, as Monero prints private keys) ----------
export const leToBig = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
export const bigToLe = (n, len = 32) => { const o = new Uint8Array(len); for (let i = 0; i < len; i++) { o[i] = Number(n & 0xffn); n >>= 8n; } return o; };
const asBytes = (x) => (typeof x === 'string' ? hexToBytes(x) : x);
export const scalarFromHex = (hex) => { const n = leToBig(asBytes(hex)); if (n >= L || n === 0n) throw new Error('scalar not canonical'); return n; };
export const scalarToHex = (n) => bytesToHex(bigToLe(n));
export const randomScalar = () => { for (;;) { const n = leToBig(randomBytes(32)) & ((1n << 253n) - 1n); if (n > 0n && n < L) return n; } }; // rejection sampling, unbiased
export const scalarAdd = (a, b) => (a + b) % L;
export const hashToScalar = (...parts) => leToBig(keccak_256(concatBytes(...parts))) % L; // Hs()
export const pubFromScalar = (n) => G.multiply(n).toBytes();
export const pointAdd = (aHex, bHex) => Point.fromHex(bytesToHex(asBytes(aHex))).add(Point.fromHex(bytesToHex(asBytes(bHex)))).toBytes();
const mulAny = (P, n) => (n === 0n ? Point.ZERO : P.multiplyUnsafe(n));

// ---------- key halves and the joint key ----------
/** One party's contribution: a spend-key half and a view-key half (both plain ed25519 scalars). */
export function generateKeyHalf() {
  const s = randomScalar(), v = randomScalar();
  return { spendPriv: scalarToHex(s), viewPriv: scalarToHex(v), spendPub: bytesToHex(pubFromScalar(s)), viewPub: bytesToHex(pubFromScalar(v)) };
}
/** Joint PUBLIC keys from the two parties' public spend halves and both private view halves. */
export function jointPublic({ spendPubA, spendPubB, viewPrivA, viewPrivB }) {
  const v = scalarAdd(scalarFromHex(viewPrivA), scalarFromHex(viewPrivB));
  if (v === 0n) throw new Error('joint view key is zero');
  // Each half must be a prime-order point (no torsion component), or the sum is not a sound key.
  for (const h of [spendPubA, spendPubB]) { const P = Point.fromHex(h.toLowerCase()); if (P.is0() || !P.isTorsionFree()) throw new Error('spend-key half is not a prime-order point'); }
  const S = pointAdd(spendPubA, spendPubB);
  if (Point.fromHex(bytesToHex(S)).is0()) throw new Error('joint spend key is identity');
  return { spendPub: bytesToHex(S), viewPriv: scalarToHex(v), viewPub: bytesToHex(pubFromScalar(v)) };
}
/** Joint PRIVATE spend key once both halves are known (claim or refund revealed the other one). */
export function jointSpendPriv(spendPrivA, spendPrivB) {
  const s = scalarAdd(scalarFromHex(spendPrivA), scalarFromHex(spendPrivB));
  if (s === 0n) throw new Error('joint spend key is zero');
  return scalarToHex(s);
}
/** Does a revealed private half match the public commitment recorded in the swap account? */
export const halfMatches = (privHex, pubHex) => bytesToHex(pubFromScalar(scalarFromHex(privHex))) === pubHex.toLowerCase();

// ---------- Monero base58 + addresses ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENC_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11]; // chars needed for 0..8 input bytes
export function base58Encode(data) {
  let out = '';
  for (let i = 0; i < data.length; i += 8) {
    const blk = data.subarray(i, i + 8);
    let n = 0n; for (const b of blk) n = (n << 8n) | BigInt(b); // big-endian block
    let s = ''; for (let k = 0; k < ENC_BLOCK[blk.length]; k++) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    out += s;
  }
  return out;
}
export function base58Decode(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 11) {
    const blk = str.slice(i, i + 11); const size = ENC_BLOCK.indexOf(blk.length);
    if (size <= 0) throw new Error('bad base58 length');
    let n = 0n; for (const c of blk) { const d = B58.indexOf(c); if (d < 0) throw new Error('bad base58 char'); n = n * 58n + BigInt(d); }
    if (n >> BigInt(8 * size)) throw new Error('base58 overflow');
    for (let k = size - 1; k >= 0; k--) out.push(Number((n >> BigInt(8 * k)) & 0xffn));
  }
  return Uint8Array.from(out);
}
// Network byte ("prefix") for standard / integrated / subaddress. cryptonote_config.h.
// Regtest ("fakechain") deliberately reuses MAINNET prefixes: a regtest address looks like a mainnet one.
export const ADDRESS_PREFIX = {
  mainnet:  { standard: 18, integrated: 19, subaddress: 42 }, // 4… / 4… / 8…
  testnet:  { standard: 53, integrated: 54, subaddress: 63 }, // 9…/A… / A… / B…
  stagenet: { standard: 24, integrated: 25, subaddress: 36 }, // 5… / 5… / 7…
  regtest:  { standard: 18, integrated: 19, subaddress: 42 },
};
export const encodeVarint = (n) => { n = BigInt(n); const o = []; while (n >= 0x80n) { o.push(Number(n & 0x7fn) | 0x80); n >>= 7n; } o.push(Number(n)); return Uint8Array.from(o); };
/** Standard address = base58( varint(prefix) || spendPub || viewPub || keccak256(previous)[0..4] ). 95 chars. */
export function encodeAddress(spendPubHex, viewPubHex, network = 'mainnet') {
  const body = concatBytes(encodeVarint(ADDRESS_PREFIX[network].standard), asBytes(spendPubHex), asBytes(viewPubHex));
  return base58Encode(concatBytes(body, keccak_256(body).subarray(0, 4)));
}
export function decodeAddress(addr) {
  const raw = base58Decode(addr); const body = raw.subarray(0, raw.length - 4);
  if (bytesToHex(keccak_256(body).subarray(0, 4)) !== bytesToHex(raw.subarray(raw.length - 4))) throw new Error('bad address checksum');
  const r = new Reader(body); const prefix = Number(r.varint());
  const spendPub = bytesToHex(r.bytes(32)), viewPub = bytesToHex(r.bytes(32));
  const networks = Object.entries(ADDRESS_PREFIX).filter(([, p]) => Object.values(p).includes(prefix)).map(([n]) => n);
  const kind = networks.length ? Object.entries(ADDRESS_PREFIX[networks[0]]).find(([, v]) => v === prefix)[0] : 'unknown';
  return { prefix, networks, kind, spendPub, viewPub };
}

// ---------- transaction parsing (consensus serialization) ----------
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  byte() { if (this.o >= this.b.length) throw new Error('tx truncated'); return this.b[this.o++]; }
  bytes(n) { if (this.o + n > this.b.length) throw new Error('tx truncated'); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  varint() { let n = 0n, shift = 0n; for (;;) { const c = this.byte(); n |= BigInt(c & 0x7f) << shift; if (!(c & 0x80)) return n; shift += 7n; if (shift > 63n) throw new Error('varint too long'); } }
}
/**
 * Parse a v2 (RingCT) transaction from its full or pruned blob. Returns the fields the swap needs
 * plus the byte ranges required to recompute the txid.
 */
export function parseTx(blob) {
  const r = new Reader(asBytes(blob));
  const version = Number(r.varint()); const unlockTime = r.varint();
  if (version !== 2) throw new Error(`unsupported tx version ${version}`);
  const inputs = []; const nIn = Number(r.varint());
  for (let i = 0; i < nIn; i++) {
    const tag = r.byte();
    if (tag === 0xff) inputs.push({ type: 'gen', height: r.varint() });
    else if (tag === 0x02) { r.varint(); const n = Number(r.varint()); for (let k = 0; k < n; k++) r.varint(); inputs.push({ type: 'key', keyImage: bytesToHex(r.bytes(32)) }); }
    else throw new Error(`unknown input tag ${tag}`);
  }
  const outputs = []; const nOut = Number(r.varint());
  for (let i = 0; i < nOut; i++) {
    const amount = r.varint(); const tag = r.byte();
    if (tag === 0x02) outputs.push({ amount, key: bytesToHex(r.bytes(32)), viewTag: null });
    else if (tag === 0x03) outputs.push({ amount, key: bytesToHex(r.bytes(32)), viewTag: r.byte() });
    else throw new Error(`unknown output tag ${tag}`);
  }
  const extra = r.bytes(Number(r.varint())); const prefixEnd = r.o;
  const rctType = r.byte(); let fee = 0n;
  if (rctType !== 0) {
    if (rctType < 4) throw new Error(`pre-2019 RingCT type ${rctType} not supported`); // full 64-byte ecdhInfo
    fee = r.varint();
    for (const o of outputs) o.encAmount = r.bytes(8);          // ecdhInfo: 8-byte masked amount
    for (const o of outputs) o.commitment = bytesToHex(r.bytes(32)); // outPk
  }
  const baseEnd = r.o;
  return { version, unlockTime, inputs, outputs, extra: parseExtra(extra), rctType, fee,
    prefixBytes: r.b.subarray(0, prefixEnd), baseBytes: r.b.subarray(prefixEnd, baseEnd), prunableBytes: r.b.subarray(baseEnd) };
}
function parseExtra(extra) {
  const r = new Reader(extra); const out = { txPubKeys: [], additionalPubKeys: [], nonces: [] };
  try {
    while (r.o < extra.length) {
      const tag = r.byte();
      if (tag === 0x00) break;                                            // padding: rest is zeros
      else if (tag === 0x01) out.txPubKeys.push(bytesToHex(r.bytes(32))); // tx public key R
      else if (tag === 0x02) out.nonces.push(bytesToHex(r.bytes(Number(r.varint())))); // payment id etc.
      else if (tag === 0x03) r.bytes(Number(r.varint()));                 // merge-mining tag
      else if (tag === 0x04) { const n = Number(r.varint()); for (let i = 0; i < n; i++) out.additionalPubKeys.push(bytesToHex(r.bytes(32))); }
      else if (tag === 0xde) r.bytes(Number(r.varint()));                 // mysterious minergate
      else break;
    }
  } catch { /* a malformed extra just yields fewer candidate keys, as in wallet2 */ }
  return out;
}
/** txid = keccak( keccak(prefix) || keccak(rct base) || keccak(rct prunable) ). Pass prunableHash when the node pruned it. */
export function computeTxid(tx, prunableHashHex) {
  if (tx.rctType === 0) throw new Error('coinbase/v2-null txid not implemented');
  const ph = prunableHashHex ? hexToBytes(prunableHashHex) : keccak_256(tx.prunableBytes);
  if (!prunableHashHex && tx.prunableBytes.length === 0) throw new Error('need prunable part or its hash');
  return bytesToHex(keccak_256(concatBytes(keccak_256(tx.prefixBytes), keccak_256(tx.baseBytes), ph)));
}

// ---------- view-key scanning ----------
/**
 * Find outputs of `tx` that pay the (main) address with public spend key `spendPub`, using the
 * private view key. For every hit the amount is decrypted AND checked against the Pedersen
 * commitment the network validated (an unverified decrypted amount is attacker-chosen).
 */
export function scanTx(tx, viewPrivHex, spendPubHex) {
  const v = scalarFromHex(viewPrivHex); const S = Point.fromHex(spendPubHex.toLowerCase());
  const found = [];
  tx.outputs.forEach((o, i) => {
    // Candidate tx keys: the main R, or the per-output additional key (used when the sender's
    // tx also pays a subaddress). wallet2 tries both.
    const cands = [...tx.extra.txPubKeys]; if (tx.extra.additionalPubKeys[i]) cands.push(tx.extra.additionalPubKeys[i]);
    for (const Rhex of cands) {
      let R; try { R = Point.fromHex(Rhex); } catch { continue; }
      const D = mulAny(R, v).multiplyUnsafe(8n).toBytes();                 // key derivation 8·v·R
      const idx = encodeVarint(i);
      if (o.viewTag !== null && keccak_256(concatBytes(utf8ToBytes('view_tag'), D, idx))[0] !== o.viewTag) continue;
      const hs = hashToScalar(D, idx);                                      // Hs(D || i)
      const P = mulAny(G, hs).add(S).toBytes();                             // one-time key Hs·G + S
      if (bytesToHex(P) !== o.key) continue;
      const hsBytes = bigToLe(hs);
      const pad = keccak_256(concatBytes(utf8ToBytes('amount'), hsBytes));
      let amount = 0n; for (let k = 7; k >= 0; k--) amount = (amount << 8n) | BigInt(o.encAmount[k] ^ pad[k]);
      const mask = hashToScalar(utf8ToBytes('commitment_mask'), hsBytes);
      const C = mulAny(G, mask).add(mulAny(H, amount)).toBytes();           // mask·G + amount·H
      found.push({ index: i, amount, key: o.key, commitmentOk: bytesToHex(C) === o.commitment, txPubKey: Rhex, mask: scalarToHex(mask) });
      break;
    }
  });
  return found;
}
export const XMR = 1_000_000_000_000n; // piconero per XMR
export const fmtXmr = (a) => { a = BigInt(a); const s = (a % XMR).toString().padStart(12, '0').replace(/0+$/, ''); return `${a / XMR}${s ? '.' + s : ''}`; };
