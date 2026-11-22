/**
 * Blob fetch for Ethereum swaps (SPEC 2.6, 2.7, 6.4): DLEQ proofs and key-pool leaves. They
 * never go on-chain, and nothing about where they came from is trusted: a pool is accepted only
 * if its leaves hash to the quote's signed `keyRoot`, a proof only if it verifies and proves
 * exactly the commitments the chain (or the leaf) names.
 */
import { type DleqStatement, dleqProve, dleqVerify, keyLeaf, merkleProof, merkleRoot } from '@xmrswap/core-wasm';
import { type Address, DLEQ_MAX_BLOB, MERKLE_MAX_LEAVES, MERKLE_MIN_LEAVES, type PoolResponse } from '@xmrswap/protocol';
import type { SwapView } from '../machine/view.js';
import { type Bytes, SdkError, bytesEqual, hex, unhex } from '../util.js';
import type { MakerHttp } from './transports.js';

export interface PoolLeaf {
  index: number;
  /** `keyAddr`, 0x-prefixed lowercase. */
  key: Address;
  key2: Address;
  /** `S`, 32 bytes. */
  spendPub: Bytes;
  /** The leaf hash. */
  hash: Bytes;
}

export interface KeyPool {
  root: Bytes;
  leaves: PoolLeaf[];
  /** The Merkle proof (sibling hashes, bottom-up) for a leaf, built locally. */
  proofFor(index: number): Bytes[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse a pool route response and check it against the quote's `keyRoot`: 2 to 256 leaves, a
 * power of two, in index order, hashing to the root. A pool that does not match is refused
 * whole; the client then builds its own proof for the leaf it picks.
 */
export function parsePool(body: Bytes | string, keyRoot: Bytes): KeyPool {
  if (typeof body !== 'string' && body.length > DLEQ_MAX_BLOB) throw new SdkError('too_large', 'a pool response is under 60,000 bytes');
  let parsed: PoolResponse;
  try {
    parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body)) as PoolResponse;
  } catch {
    throw new SdkError('PoolMalformed', 'the pool response is not JSON');
  }
  const raw = parsed?.leaves;
  if (!Array.isArray(raw)) throw new SdkError('PoolMalformed', 'the pool response has no leaves');
  const n = raw.length;
  if (n < MERKLE_MIN_LEAVES || n > MERKLE_MAX_LEAVES || (n & (n - 1)) !== 0) throw new SdkError('MerklePoolSize', `a pool has 2 to 256 leaves and a power-of-two size, not ${n}`);
  const leaves: PoolLeaf[] = raw.map((l, i) => {
    if (typeof l !== 'object' || l === null || l.index !== i) throw new SdkError('PoolMalformed', `leaf ${i} is out of index order`);
    if (typeof l.key !== 'string' || typeof l.key2 !== 'string' || !ADDRESS.test(l.key) || !ADDRESS.test(l.key2)) throw new SdkError('PoolMalformed', `leaf ${i} has a malformed key address`);
    if (typeof l.spend_pub !== 'string' || !/^[0-9a-f]{64}$/.test(l.spend_pub)) throw new SdkError('PoolMalformed', `leaf ${i} has a malformed spend commitment`);
    const spendPub = unhex(l.spend_pub);
    return { index: i, key: l.key.toLowerCase() as Address, key2: l.key2.toLowerCase() as Address, spendPub, hash: keyLeaf(i, unhex(l.key), unhex(l.key2), spendPub) };
  });
  const hashes = leaves.map((l) => l.hash);
  if (!bytesEqual(merkleRoot(hashes), keyRoot)) throw new SdkError('PoolRootMismatch', 'the leaves do not hash to the quote keyRoot');
  return { root: keyRoot, leaves, proofFor: (index) => merkleProof(hashes, index) };
}

/** `GET /xs/v1/pool/<keyRoot>` and the check against the root. */
export async function fetchPool(http: MakerHttp, keyRoot: Bytes): Promise<KeyPool> {
  const body = await http.getPool(hex(keyRoot));
  if (!body) throw new SdkError('PoolNotFound', 'the maker does not serve a pool for this keyRoot');
  return parsePool(body, keyRoot);
}

/**
 * Pick, at random, a leaf whose `keyAddr` is neither consumed (`isKeyUsed`) nor named by a
 * currently pending lock. `random()` returns a number in [0, 1); pass a seeded one in tests.
 */
export async function pickLeaf(pool: KeyPool, o: { isKeyUsed: (keyAddr: Address) => Promise<boolean>; pending?: ReadonlySet<string>; random?: () => number }): Promise<PoolLeaf> {
  const random = o.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
  const candidates = pool.leaves.filter((l) => !o.pending?.has(l.key));
  // Shuffle, then take the first that is still unused on-chain.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  for (const leaf of candidates) if (!(await o.isKeyUsed(leaf.key))) return leaf;
  throw new SdkError('NoKeyAvailable', 'every leaf of the pool is consumed or named by a pending lock');
}

/** What a proof must prove: the commitments named by a pool leaf or read from contract storage. */
export interface ExpectedStatement {
  spendPub: Bytes;
  keyAddr: Address | Bytes;
  keyAddr2: Address | Bytes;
}
const addrBytes = (a: Address | Bytes): Bytes => (typeof a === 'string' ? unhex(a) : a);

/**
 * Verify a `DleqBlob` and require it to prove exactly `expect`: at most 60,000 bytes, valid
 * (which also rejects an `S` outside the prime-order subgroup), and its `S`, `keyAddr` and
 * `keyAddr2` (computed from the proof's own `P`) equal the expected ones. `notOwn` is the
 * verifier's own commitment(s): a counterparty that presents one of them is replaying our share.
 */
export function verifyProof(blob: Bytes, expect: ExpectedStatement, notOwn: Bytes[] = []): DleqStatement {
  if (blob.length > DLEQ_MAX_BLOB) throw new SdkError('DleqTooLarge', `${blob.length} bytes is over the 60,000-byte limit`);
  const st = dleqVerify(blob); // throws DleqBadVersion, DleqMalformed, DleqInvalid
  if (!bytesEqual(st.spendPub, expect.spendPub)) throw new SdkError('DleqWrongKey', 'the proof is for another spend commitment');
  if (!bytesEqual(st.keyAddr, addrBytes(expect.keyAddr)) || !bytesEqual(st.keyAddr2, addrBytes(expect.keyAddr2))) throw new SdkError('DleqWrongKey', 'the proof does not match the twin commitments on record');
  if (notOwn.some((own) => bytesEqual(own, st.spendPub))) throw new SdkError('OwnShareReplayed', 'the counterparty presented our own share');
  return st;
}

/** `GET /xs/v1/dleq/<S>` and `verifyProof`. A missing proof is `DleqMissing`: the UI refuses to lock without a verified one. */
export async function fetchProof(http: MakerHttp, expect: ExpectedStatement, notOwn: Bytes[] = []): Promise<Bytes> {
  const blob = await http.getDleq(hex(expect.spendPub));
  if (!blob) throw new SdkError('DleqMissing', 'the maker does not serve a proof for this share');
  verifyProof(blob, expect, notOwn);
  return blob;
}

/** Prove our own share and `PUT` it to the maker before `lock` (A) or `take` (B). Returns the blob and what it proves. */
export async function uploadOwnProof(http: MakerHttp, spend: Bytes): Promise<{ blob: Bytes; statement: DleqStatement }> {
  const blob = dleqProve(spend);
  const statement = dleqVerify(blob);
  await http.putDleq(hex(statement.spendPub), blob);
  return { blob, statement };
}

/**
 * Taker, direction B, after `fund`: the proof for the maker's funded share must equal
 * `makerSpendPub`, `makerKey` and `makerKey2` read from contract storage at `finalized`.
 * Without this a maker could fund with `x·G − S_T` and unrelated twins. On failure the page
 * never shows the joint address.
 */
export function verifyFundedShare(blob: Bytes, swap: SwapView): DleqStatement {
  if (swap.chain !== 'ethereum' || !swap.eth) throw new SdkError('WrongChain', 'DLEQ proofs belong to Ethereum swaps');
  return verifyProof(blob, { spendPub: swap.makerSpendPub, keyAddr: swap.eth.makerKey as Address, keyAddr2: swap.eth.makerKey2 as Address }, [swap.takerSpendPub]);
}

/**
 * Maker, before `approve` or `fund`: the taker's proof must verify against the commitments in
 * contract storage, and the taker's commitment must not be any share in the maker's own table.
 * Otherwise the daemon rejects with reason 1.
 */
export function verifyTakerShare(blob: Bytes, swap: SwapView, ownShares: Bytes[]): DleqStatement {
  if (swap.chain !== 'ethereum' || !swap.eth) throw new SdkError('WrongChain', 'DLEQ proofs belong to Ethereum swaps');
  return verifyProof(blob, { spendPub: swap.takerSpendPub, keyAddr: swap.eth.takerKey as Address, keyAddr2: swap.eth.takerKey2 as Address }, ownShares);
}

/** The leaf argument of `lock`, with its locally built proof. */
export function leafArgument(pool: KeyPool, leaf: PoolLeaf): { index: number; key: Address; key2: Address; spendPub: Bytes; proof: Bytes[] } {
  return { index: leaf.index, key: leaf.key, key2: leaf.key2, spendPub: leaf.spendPub, proof: pool.proofFor(leaf.index) };
}

