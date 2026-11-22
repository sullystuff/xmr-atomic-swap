/**
 * The bridge's on-chain heartbeat and reserve-proof record (docs/research/local-assets.md,
 * section 3). There is no HTTP endpoint: the program accounts are the interface.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';
import { BRIDGE_PROGRAM_ID, HEARTBEAT_MAX_AGE_SECONDS, bridgePdas, decodeAuditRecord, decodeHeartbeatPage, decodeHeartbeatRoot } from './program.js';
import type { SolanaRpc } from './rpc.js';

export interface Heartbeat {
  generation: bigint;
  /** Solana clock, seconds. */
  updatedAt: number;
  /** The relayer's own clock, seconds. */
  observedAt: number;
  moneroHeight: number;
  balanceAtomic: bigint;
  /** XMR the bridge can pay out right now. */
  unlockedAtomic: bigint;
  latestReserve: { account: string; id: number } | null;
}

const amount = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9]\d*)$/.test(x) && BigInt(x) <= 0xffff_ffff_ffff_ffffn;
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isPubkey = (x: unknown): x is string => { try { return typeof x === 'string' && new PublicKey(x).toBase58() === x; } catch { return false; } };

/** Reads and verifies the heartbeat: both page banks, digest, gzip, format `wxmr-heartbeat-v1`. Null when none has been published. */
export async function readHeartbeat(rpc: SolanaRpc, program: PublicKey = BRIDGE_PROGRAM_ID): Promise<Heartbeat | null> {
  const p = bridgePdas(program);
  const rootAccount = await rpc.getAccount(p.heartbeat().toBase58());
  if (!rootAccount) return null;
  const root = decodeHeartbeatRoot(rootAccount, program);
  if (root.generation === 0n) return null;
  if (root.pageCount < 1 || root.pageCount > 128) throw new Error('heartbeat: bad page count');
  const addresses = Array.from({ length: root.pageCount }, (_, i) => p.heartbeatPage(root.generation, i).toBase58());
  const pages = await rpc.getAccounts(addresses);
  const chunks = pages.map((a, i) => {
    if (!a) throw new Error('heartbeat: a page is missing');
    const page = decodeHeartbeatPage(a, program);
    if (page.generation !== root.generation || page.index !== i) throw new Error('heartbeat is being rewritten; retry shortly');
    if (page.data.length < 1 || page.data.length > 700) throw new Error('heartbeat: bad page length');
    return page.data;
  });
  const compressed = Buffer.concat(chunks);
  if (!createHash('sha256').update(compressed).digest().equals(root.digest)) throw new Error('heartbeat: digest mismatch');
  const json = gunzipSync(compressed, { maxOutputLength: 2_000_000 }).toString('utf8');
  const v = JSON.parse(json) as Record<string, unknown>;
  if (v['format'] !== 'wxmr-heartbeat-v1' || !integer(v['observedAt']) || !integer(v['moneroHeight']) || !amount(v['balanceAtomic']) || !amount(v['unlockedAtomic'])
    || BigInt(v['unlockedAtomic']) > BigInt(v['balanceAtomic'])) throw new Error('heartbeat: invalid payload');
  const lr = v['latestReserve'] as { account?: unknown; id?: unknown } | null | undefined;
  if (lr !== null && lr !== undefined && (!isPubkey(lr.account) || !integer(lr.id))) throw new Error('heartbeat: invalid reserve pointer');
  return {
    generation: root.generation, updatedAt: root.updatedAt, observedAt: v['observedAt'], moneroHeight: v['moneroHeight'],
    balanceAtomic: BigInt(v['balanceAtomic']), unlockedAtomic: BigInt(v['unlockedAtomic']),
    latestReserve: lr ? { account: lr.account as string, id: lr.id as number } : null,
  };
}

/** Offline when either clock reading is more than 360 s old (or more than 30 s in the future). */
export function heartbeatOnline(h: Heartbeat, now: number): boolean {
  return h.updatedAt <= now + 30 && h.observedAt <= now + 30 && now - h.updatedAt <= HEARTBEAT_MAX_AGE_SECONDS && now - h.observedAt <= HEARTBEAT_MAX_AGE_SECONDS;
}

// ---------------------------------------------------------------- reserve proof

export interface ReserveReport {
  id: number;
  /** The bridge's Monero wallet address. */
  address: string;
  /** The exact message the proof signs. */
  message: string;
  /** `ReserveProofV2…` */
  proof: string;
  moneroHeight: number;
  supplyAtomic: bigint;
  claimedUnspentAtomic: bigint;
}

/** Structural checks of a `wxmr-reserve-v1` record. This is not verification; `ReserveProofVerifier` is. */
export function parseReserveReport(raw: string, program: PublicKey = BRIDGE_PROGRAM_ID): ReserveReport {
  if (raw.length > 40_000) throw new Error('reserve record: too large');
  const r = JSON.parse(raw) as Record<string, any>;
  if (r['format'] !== 'wxmr-reserve-v1' || !integer(r['id']) || typeof r['address'] !== 'string' || r['address'].length !== 95
    || typeof r['proof'] !== 'string' || !/^ReserveProofV2[1-9A-HJ-NP-Za-km-z]+$/.test(r['proof']) || typeof r['message'] !== 'string'
    || !integer(r['monero']?.height) || !amount(r['solana']?.supplyAtomic) || !amount(r['verified']?.unspentAtomic)) throw new Error('reserve record: invalid');
  if (r['solana'].program !== program.toBase58()) throw new Error('reserve record: names another program');
  // The signed message must be exactly the canonical JSON of the bound fields, so the proof cannot be lifted from another context.
  const { format, id, address, monero, solana, scope } = r;
  if (r['message'] !== JSON.stringify({ format, id, address, monero, solana, scope })) throw new Error('reserve record: message does not bind its fields');
  return { id: r['id'], address: r['address'], message: r['message'], proof: r['proof'], moneroHeight: r['monero'].height, supplyAtomic: BigInt(r['solana'].supplyAtomic), claimedUnspentAtomic: BigInt(r['verified'].unspentAtomic) };
}

/** Checks a Monero reserve proof against the maker's own node (wallet-rpc `check_reserve_proof`). Implemented by the daemon. */
export interface ReserveProofVerifier {
  check(proof: { address: string; message: string; signature: string }): Promise<{ good: boolean; total: bigint; spent: bigint }>;
}

export interface ReserveCheck { ok: boolean; reason?: string; unspentAtomic?: bigint; supplyAtomic?: bigint; id?: number }

/**
 * Reads the audit record the heartbeat names, verifies its proof with the maker's node, and
 * requires the proven unspent balance to cover the wXMR supply the record is bound to plus the
 * refill about to be redeemed.
 */
export async function checkReserve(rpc: SolanaRpc, verifier: ReserveProofVerifier, heartbeat: Heartbeat, needAtomic: bigint, program: PublicKey = BRIDGE_PROGRAM_ID): Promise<ReserveCheck> {
  if (!heartbeat.latestReserve) return { ok: false, reason: 'the bridge has published no reserve proof' };
  const expected = bridgePdas(program).audit(BigInt(heartbeat.latestReserve.id)).toBase58();
  if (heartbeat.latestReserve.account !== expected) return { ok: false, reason: 'the heartbeat names a reserve record at an unexpected address' };
  const account = await rpc.getAccount(expected);
  if (!account) return { ok: false, reason: 'the reserve record named by the heartbeat does not exist' };
  let report: ReserveReport;
  try { report = parseReserveReport(decodeAuditRecord(account, program).data, program); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (report.id !== heartbeat.latestReserve.id) return { ok: false, reason: 'reserve record id does not match the heartbeat' };
  const res = await verifier.check({ address: report.address, message: report.message, signature: report.proof });
  if (!res.good) return { ok: false, reason: 'the reserve proof does not verify against the Monero node', id: report.id };
  const unspent = res.total - res.spent;
  const base = { unspentAtomic: unspent, supplyAtomic: report.supplyAtomic, id: report.id };
  if (unspent < report.supplyAtomic) return { ok: false, reason: 'the proven reserve is smaller than the wXMR supply it is bound to', ...base };
  if (unspent < needAtomic) return { ok: false, reason: 'the proven reserve is smaller than this refill', ...base };
  return { ok: true, ...base };
}
