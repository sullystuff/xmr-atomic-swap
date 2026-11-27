/**
 * Durable state (SPEC 7.4): one SQLite file in WAL mode. State machines are rows. Every money
 * movement writes an `intents` row before it broadcasts; on ambiguity the row is parked in
 * `needs_review` and never re-sent blindly.
 *
 * The file is bound to one maker and one inventory wallet at first start (`bind`) and refuses
 * to open against others.
 */
import Database from 'better-sqlite3';
import { fromJson, nowSecs, toJson } from '../util.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS key_shares (
  share_id TEXT PRIMARY KEY, chain TEXT NOT NULL, spend_pub TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  purpose TEXT NOT NULL, swap_ref TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS key_shares_swap ON key_shares (swap_ref);
CREATE TABLE IF NOT EXISTS dleq_blobs (spend_pub TEXT PRIMARY KEY, blob BLOB NOT NULL, own INTEGER NOT NULL, swap_ref TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS swaps (
  ref TEXT PRIMARY KEY, chain TEXT NOT NULL, direction INTEGER NOT NULL, market TEXT NOT NULL, state INTEGER NOT NULL,
  phase TEXT NOT NULL, snapshot TEXT, taker TEXT NOT NULL, xmr TEXT NOT NULL, amount TEXT NOT NULL, deposit TEXT NOT NULL,
  depth INTEGER NOT NULL, opened_at INTEGER NOT NULL, enc_version INTEGER NOT NULL, facts TEXT NOT NULL DEFAULT '{}',
  joint_address TEXT, joint_view TEXT, lock_txid TEXT, lock_height INTEGER, lock_output_index INTEGER,
  sweep_txid TEXT, swept INTEGER NOT NULL DEFAULT 0, terminal INTEGER NOT NULL DEFAULT 0, outcome INTEGER,
  needs_review INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS swaps_open ON swaps (terminal);
CREATE TABLE IF NOT EXISTS lock_txs (
  swap_ref TEXT PRIMARY KEY, tx_hex TEXT NOT NULL, txid TEXT NOT NULL, key_images TEXT NOT NULL, amount TEXT NOT NULL,
  created_at INTEGER NOT NULL, relayed_at INTEGER, last_rebroadcast INTEGER);
CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, swap_ref TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  tx TEXT, meta TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS intents_open ON intents (status);
CREATE INDEX IF NOT EXISTS intents_swap ON intents (swap_ref);
CREATE TABLE IF NOT EXISTS xmr_outputs (
  key_image TEXT PRIMARY KEY, amount TEXT NOT NULL, block_height INTEGER, frozen INTEGER NOT NULL DEFAULT 0,
  reserved_for TEXT, spent INTEGER NOT NULL DEFAULT 0, unlocked INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS enc_keys (
  version INTEGER PRIMARY KEY, public_key TEXT NOT NULL, sealed_secret BLOB, created_at INTEGER NOT NULL,
  expires_at INTEGER, deleted_at INTEGER, published INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, chain TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS key_pools (root TEXT PRIMARY KEY, token TEXT NOT NULL, leaves TEXT NOT NULL, created_at INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS approvals_issued (
  id TEXT PRIMARY KEY, chain TEXT NOT NULL, taker TEXT NOT NULL, market TEXT, direction TEXT, max_xmr TEXT NOT NULL,
  not_before INTEGER NOT NULL, expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL, sig TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, direction TEXT NOT NULL, transport TEXT NOT NULL, type TEXT NOT NULL, swap_ref TEXT,
  peer TEXT NOT NULL, text TEXT, action TEXT, read INTEGER NOT NULL DEFAULT 0, in_reply_to TEXT, taker_pub TEXT, key_version INTEGER, reply_to TEXT);
CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, taker_pub TEXT NOT NULL, envelope BLOB NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS replies_key ON replies (taker_pub);
CREATE TABLE IF NOT EXISTS prices (at INTEGER NOT NULL, source TEXT NOT NULL, asset TEXT NOT NULL, usd REAL NOT NULL);
CREATE INDEX IF NOT EXISTS prices_at ON prices (asset, at);
CREATE TABLE IF NOT EXISTS fees_spent (at INTEGER NOT NULL, chain TEXT NOT NULL, kind TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, tx TEXT);
CREATE TABLE IF NOT EXISTS fills (swap_ref TEXT PRIMARY KEY, at INTEGER NOT NULL, market TEXT NOT NULL, direction INTEGER NOT NULL, xmr TEXT NOT NULL, amount TEXT NOT NULL, spread_usd REAL);
CREATE TABLE IF NOT EXISTS config_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, revision TEXT NOT NULL, source TEXT NOT NULL, changes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, swap_ref TEXT, acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS uptime (day INTEGER PRIMARY KEY, beats INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS watch_acks (swap_ref TEXT PRIMARY KEY, chain TEXT NOT NULL, watcher TEXT NOT NULL, watching_until INTEGER NOT NULL, sig TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS freezes (swap_ref TEXT PRIMARY KEY, chain TEXT NOT NULL, direction INTEGER NOT NULL, taker TEXT NOT NULL, watcher TEXT, frozen_by TEXT NOT NULL, t_freeze INTEGER NOT NULL, t_ff INTEGER NOT NULL, at INTEGER NOT NULL);
`;

export type IntentStatus = 'planned' | 'sent' | 'confirmed' | 'failed' | 'needs_review';
export type IntentKind = 'sol_tx' | 'eth_tx' | 'xmr_prepare' | 'xmr_relay' | 'xmr_sweep' | 'xmr_split' | 'xmr_send' | 'venue_transfer' | 'watch_register';
export interface IntentRow {
  id: number;
  swap_ref: string | null;
  kind: IntentKind;
  payload: Record<string, unknown>;
  status: IntentStatus;
  tx: string | null;
  meta: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export type ShareStatus = 'fresh' | 'published' | 'bound' | 'revealed' | 'burned';
export interface ShareRow {
  share_id: string;
  chain: 'solana' | 'ethereum';
  spend_pub: string;
  status: ShareStatus;
  purpose: string;
  swap_ref: string | null;
  created_at: number;
}
/** Facts the executor learned about a swap that the chain does not hold. */
export interface SwapFacts {
  /** Hex of the taker commitments (and enc key) this maker verified before approve/fund or first acting. */
  verified?: string;
  takerProofOk?: boolean;
  approval?: { approve: true } | { approve: false; reason: 0 | 1 | 2 };
  /** A manual decision from the console overrides the rules. */
  manual?: { approve?: boolean; rejectReason?: 0 | 1 | 2; abort?: boolean; withhold?: boolean; release?: boolean; publishEvidence?: boolean };
  /** Reference price (USD per XMR) when the swap was first seen: the withhold rule compares against it. */
  refPriceUsd?: number;
  releaseRequested?: boolean;
  withholdDecided?: boolean;
  lockFailed?: boolean;
  /** The ladder output reserved for this swap. */
  reservedOutput?: string;
  sweep?: { txid: string; txHex: string };
  /** The operator's latest explicit instruction, written BEFORE anything acts on it, and what became of it. */
  instruction?: Instruction;
}
export type InstructionAction = 'approve' | 'reject' | 'abort' | 'withhold' | 'release' | 'publish-evidence';
export interface Instruction {
  action: InstructionAction;
  at: number;
  /** Highest intent id when it was given: only a later transaction can be the one that carries it out. */
  mark: number;
  /** Swap state when it was given: the database's view at first, replaced by the chain's on the first step that reads it. */
  stateAt: number;
  seen?: boolean;
  status: 'pending' | 'carried_out' | 'refused';
  /** Why it could not be honoured (the SDK's `Refusal`, or the daemon's own `not-available-in-state` / `dry-run`). */
  reason?: string;
  tx?: string | null;
}
export interface SwapRow {
  ref: string;
  chain: 'solana' | 'ethereum';
  direction: 0 | 1;
  market: string;
  state: number;
  phase: string;
  snapshot: string | null;
  taker: string;
  xmr: string;
  amount: string;
  deposit: string;
  depth: number;
  opened_at: number;
  enc_version: number;
  facts: SwapFacts;
  joint_address: string | null;
  joint_view: string | null;
  lock_txid: string | null;
  lock_height: number | null;
  lock_output_index: number | null;
  sweep_txid: string | null;
  swept: number;
  terminal: number;
  outcome: number | null;
  needs_review: number;
  last_error: string | null;
  updated_at: number;
}
export interface WatchAckRow {
  swap_ref: string;
  chain: 'solana' | 'ethereum';
  /** The watcher's Solana key that signed the acknowledgement. */
  watcher: string;
  watching_until: number;
  sig: string;
  at: number;
}
/** `taker_side`: the taker, its session key or the watcher it named (direction A). `maker`: this daemon. `maker_watcher`: the maker's watcher (direction B). */
export type FrozenBy = 'taker_side' | 'maker' | 'maker_watcher';
export interface FreezeRow {
  swap_ref: string;
  chain: 'solana' | 'ethereum';
  direction: 0 | 1;
  taker: string;
  /** The key the swap names as watcher, or `null`. */
  watcher: string | null;
  frozen_by: FrozenBy;
  t_freeze: number;
  t_ff: number;
  at: number;
}
export interface LockTxRow {
  swap_ref: string;
  tx_hex: string;
  txid: string;
  key_images: string[];
  amount: string;
  created_at: number;
  relayed_at: number | null;
  last_rebroadcast: number | null;
}
export interface OutputRow {
  key_image: string;
  amount: string;
  block_height: number | null;
  frozen: number;
  reserved_for: string | null;
  spent: number;
  unlocked: number;
  seen_at: number;
}
export interface EncKeyRow {
  version: number;
  public_key: string;
  sealed_secret: Buffer | null;
  created_at: number;
  expires_at: number | null;
  deleted_at: number | null;
  published: number;
}
export interface MessageRow {
  id: string;
  at: number;
  direction: 'in' | 'out';
  transport: 'solana' | 'tor' | 'ethereum';
  type: string;
  swap_ref: string | null;
  peer: string;
  text: string | null;
  action: string | null;
  read: number;
  in_reply_to: string | null;
  taker_pub: string | null;
  key_version: number | null;
  reply_to: string | null;
}
export interface AlertRow {
  id: number;
  at: number;
  level: 'info' | 'warning' | 'critical';
  kind: string;
  message: string;
  swap_ref: string | null;
  acknowledged: number;
}

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

export class Store {
  readonly db: Database.Database;
  /** Injectable clock (Unix seconds) so tests are deterministic. */
  now: () => number = nowSecs;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
    const v = this.meta('schema_version');
    if (v === null) this.setMeta('schema_version', String(SCHEMA_VERSION));
    else if (Number(v) !== SCHEMA_VERSION) throw new Error(`database schema version ${v} is not ${SCHEMA_VERSION}`);
  }
  close(): void {
    this.db.close();
  }
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- meta, kv, binding
  meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  kv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  /**
   * Bind the database to the maker and the inventory wallet (SPEC 7.3). The first call records
   * them; later calls refuse any other value. A `null` component is not checked (not configured).
   */
  bind(b: { solanaMaker?: string | null; ethereumMaker?: string | null; wallet?: string | null }): void {
    for (const [key, value] of [['bound_solana_maker', b.solanaMaker], ['bound_ethereum_maker', b.ethereumMaker], ['bound_wallet', b.wallet]] as const) {
      if (!value) continue;
      const have = this.meta(key);
      if (have === null) this.setMeta(key, value);
      else if (have !== value) throw new BindingError(`this database is bound to ${key.replace('bound_', '').replace('_', ' ')} ${have}, not ${value}; refusing to open`);
    }
  }

  // ---------------------------------------------------------------- key shares
  /** Written BEFORE the share is published, signed into a quote or used (SPEC 2.2). */
  insertShare(r: Omit<ShareRow, 'created_at'>): void {
    this.db.prepare('INSERT INTO key_shares (share_id, chain, spend_pub, status, purpose, swap_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.share_id, r.chain, r.spend_pub, r.status, r.purpose, r.swap_ref, this.now());
  }
  shareByPub(spendPub: string): ShareRow | undefined {
    return this.db.prepare('SELECT * FROM key_shares WHERE spend_pub = ?').get(spendPub) as ShareRow | undefined;
  }
  shareForSwap(swapRef: string): ShareRow | undefined {
    return this.db.prepare('SELECT * FROM key_shares WHERE swap_ref = ? ORDER BY created_at LIMIT 1').get(swapRef) as ShareRow | undefined;
  }
  setShare(shareId: string, status: ShareStatus, swapRef?: string | null): void {
    if (swapRef === undefined) this.db.prepare('UPDATE key_shares SET status = ? WHERE share_id = ?').run(status, shareId);
    else this.db.prepare('UPDATE key_shares SET status = ?, swap_ref = ? WHERE share_id = ?').run(status, swapRef, shareId);
  }
  shares(where: { status?: ShareStatus; purpose?: string } = {}): ShareRow[] {
    return (this.db.prepare('SELECT * FROM key_shares ORDER BY created_at').all() as ShareRow[]).filter((s) => (!where.status || s.status === where.status) && (!where.purpose || s.purpose === where.purpose));
  }

  // ---------------------------------------------------------------- DLEQ blobs
  putBlob(spendPub: string, blob: Uint8Array, own: boolean, swapRef: string | null = null): void {
    this.db.prepare('INSERT INTO dleq_blobs (spend_pub, blob, own, swap_ref, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(spend_pub) DO UPDATE SET blob = excluded.blob').run(spendPub, Buffer.from(blob), own ? 1 : 0, swapRef, this.now());
  }
  blob(spendPub: string): Uint8Array | null {
    const r = this.db.prepare('SELECT blob FROM dleq_blobs WHERE spend_pub = ?').get(spendPub) as { blob: Buffer } | undefined;
    return r ? new Uint8Array(r.blob) : null;
  }
  pinBlob(spendPub: string, swapRef: string): void {
    this.db.prepare('UPDATE dleq_blobs SET swap_ref = ? WHERE spend_pub = ?').run(swapRef, spendPub);
  }
  /** Taker proofs are kept 15 minutes unless a swap references them (SPEC 6.3). */
  pruneBlobs(olderThanSecs: number): number {
    return this.db.prepare('DELETE FROM dleq_blobs WHERE own = 0 AND swap_ref IS NULL AND created_at < ?').run(this.now() - olderThanSecs).changes;
  }

  // ---------------------------------------------------------------- swaps
  private rowToSwap(r: Record<string, unknown>): SwapRow {
    return { ...(r as unknown as SwapRow), facts: fromJson<SwapFacts>(r['facts'] as string) };
  }
  swap(ref: string): SwapRow | undefined {
    const r = this.db.prepare('SELECT * FROM swaps WHERE ref = ?').get(ref) as Record<string, unknown> | undefined;
    return r ? this.rowToSwap(r) : undefined;
  }
  swaps(where: { open?: boolean; chain?: string } = {}): SwapRow[] {
    const rows = this.db.prepare('SELECT * FROM swaps ORDER BY opened_at DESC, ref').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSwap(r)).filter((s) => (where.open === undefined || (s.terminal === 0) === where.open) && (!where.chain || s.chain === where.chain));
  }
  insertSwap(r: Pick<SwapRow, 'ref' | 'chain' | 'direction' | 'market' | 'state' | 'phase' | 'snapshot' | 'taker' | 'xmr' | 'amount' | 'deposit' | 'depth' | 'opened_at' | 'enc_version'> & { facts?: SwapFacts }): void {
    this.db
      .prepare('INSERT OR IGNORE INTO swaps (ref, chain, direction, market, state, phase, snapshot, taker, xmr, amount, deposit, depth, opened_at, enc_version, facts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.ref, r.chain, r.direction, r.market, r.state, r.phase, r.snapshot, r.taker, r.xmr, r.amount, r.deposit, r.depth, r.opened_at, r.enc_version, toJson(r.facts ?? {}), this.now());
  }
  updateSwap(ref: string, patch: Partial<Omit<SwapRow, 'ref' | 'facts'>> & { facts?: SwapFacts }): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([k, v]) => (k === 'facts' ? toJson(v) : v));
    this.db.prepare(`UPDATE swaps SET ${sets}, updated_at = ? WHERE ref = ?`).run(...values, this.now(), ref);
  }
  patchFacts(ref: string, patch: Partial<SwapFacts>): SwapFacts {
    return this.tx(() => {
      const row = this.swap(ref);
      if (!row) throw new Error(`no swap row ${ref}`);
      const facts = { ...row.facts, ...patch };
      this.updateSwap(ref, { facts });
      return facts;
    });
  }

  // ---------------------------------------------------------------- lock transactions
  lockTx(swapRef: string): LockTxRow | undefined {
    const r = this.db.prepare('SELECT * FROM lock_txs WHERE swap_ref = ?').get(swapRef) as (Omit<LockTxRow, 'key_images'> & { key_images: string }) | undefined;
    return r ? { ...r, key_images: JSON.parse(r.key_images) as string[] } : undefined;
  }
  /** One lock transaction per swap, ever: the primary key refuses a second. */
  insertLockTx(r: Pick<LockTxRow, 'swap_ref' | 'tx_hex' | 'txid' | 'key_images' | 'amount'>): void {
    this.db.prepare('INSERT INTO lock_txs (swap_ref, tx_hex, txid, key_images, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.swap_ref, r.tx_hex, r.txid, JSON.stringify(r.key_images), r.amount, this.now());
  }
  markLockRelayed(swapRef: string, rebroadcast = false): void {
    if (rebroadcast) this.db.prepare('UPDATE lock_txs SET last_rebroadcast = ? WHERE swap_ref = ?').run(this.now(), swapRef);
    else this.db.prepare('UPDATE lock_txs SET relayed_at = COALESCE(relayed_at, ?) WHERE swap_ref = ?').run(this.now(), swapRef);
  }
  /** A prepared lock that was never relayed can be dropped (the swap left ACTIVE/NOTICED first). */
  deleteUnrelayedLockTx(swapRef: string): boolean {
    return this.db.prepare('DELETE FROM lock_txs WHERE swap_ref = ? AND relayed_at IS NULL').run(swapRef).changes > 0;
  }

  // ---------------------------------------------------------------- intents
  private rowToIntent(r: Record<string, unknown>): IntentRow {
    return { ...(r as unknown as IntentRow), payload: fromJson(r['payload'] as string), meta: r['meta'] ? fromJson(r['meta'] as string) : null };
  }
  /** Write the intent BEFORE the external action. Returns its id. */
  planIntent(kind: IntentKind, swapRef: string | null, payload: Record<string, unknown>): number {
    const t = this.now();
    return Number(this.db.prepare("INSERT INTO intents (swap_ref, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)").run(swapRef, kind, toJson(payload), t, t).lastInsertRowid);
  }
  setIntent(id: number, status: IntentStatus, patch: { tx?: string | null; meta?: Record<string, unknown>; error?: string } = {}): void {
    const cur = this.intent(id);
    if (!cur) throw new Error(`no intent ${id}`);
    this.db
      .prepare('UPDATE intents SET status = ?, tx = ?, meta = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, patch.tx === undefined ? cur.tx : patch.tx, toJson(patch.meta ? { ...(cur.meta ?? {}), ...patch.meta } : (cur.meta ?? {})), patch.error ?? cur.error, this.now(), id);
  }
  intent(id: number): IntentRow | undefined {
    const r = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToIntent(r) : undefined;
  }
  intents(where: { swapRef?: string; status?: IntentStatus[]; kind?: IntentKind } = {}): IntentRow[] {
    const rows = (where.swapRef ? this.db.prepare('SELECT * FROM intents WHERE swap_ref = ? ORDER BY id').all(where.swapRef) : this.db.prepare('SELECT * FROM intents ORDER BY id').all()) as Record<string, unknown>[];
    return rows.map((r) => this.rowToIntent(r)).filter((i) => (!where.status || where.status.includes(i.status)) && (!where.kind || i.kind === where.kind));
  }
  needsReviewCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE status = 'needs_review'").get() as { n: number }).n;
  }

  // ---------------------------------------------------------------- inventory outputs
  outputs(): OutputRow[] {
    return this.db.prepare('SELECT * FROM xmr_outputs WHERE spent = 0 ORDER BY CAST(amount AS REAL), key_image').all() as OutputRow[];
  }
  output(keyImage: string): OutputRow | undefined {
    return this.db.prepare('SELECT * FROM xmr_outputs WHERE key_image = ?').get(keyImage) as OutputRow | undefined;
  }
  upsertOutput(o: { key_image: string; amount: string; block_height: number | null; unlocked: boolean; frozen: boolean; spent: boolean }): void {
    this.db
      .prepare('INSERT INTO xmr_outputs (key_image, amount, block_height, frozen, spent, unlocked, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key_image) DO UPDATE SET block_height = excluded.block_height, frozen = excluded.frozen, spent = excluded.spent, unlocked = excluded.unlocked')
      .run(o.key_image, o.amount, o.block_height, o.frozen ? 1 : 0, o.spent ? 1 : 0, o.unlocked ? 1 : 0, this.now());
  }
  reserveOutput(keyImage: string, swapRef: string | null): void {
    this.db.prepare('UPDATE xmr_outputs SET reserved_for = ?, frozen = ? WHERE key_image = ?').run(swapRef, swapRef ? 1 : 0, keyImage);
  }
  markOutputsSpent(keep: string[]): void {
    const known = this.db.prepare('SELECT key_image FROM xmr_outputs WHERE spent = 0').all() as { key_image: string }[];
    const set = new Set(keep);
    const stmt = this.db.prepare('UPDATE xmr_outputs SET spent = 1 WHERE key_image = ?');
    for (const k of known) if (!set.has(k.key_image)) stmt.run(k.key_image);
  }

  // ---------------------------------------------------------------- encryption keys
  encKeys(): EncKeyRow[] {
    return this.db.prepare('SELECT * FROM enc_keys ORDER BY version').all() as EncKeyRow[];
  }
  encKey(version: number): EncKeyRow | undefined {
    return this.db.prepare('SELECT * FROM enc_keys WHERE version = ?').get(version) as EncKeyRow | undefined;
  }
  insertEncKey(version: number, publicKey: string, sealed: Uint8Array, published: boolean): void {
    this.db.prepare('INSERT INTO enc_keys (version, public_key, sealed_secret, created_at, published) VALUES (?, ?, ?, ?, ?)').run(version, publicKey, Buffer.from(sealed), this.now(), published ? 1 : 0);
  }
  updateEncKey(version: number, patch: { expires_at?: number | null; published?: boolean; deleted?: boolean }): void {
    if (patch.expires_at !== undefined) this.db.prepare('UPDATE enc_keys SET expires_at = ? WHERE version = ?').run(patch.expires_at, version);
    if (patch.published !== undefined) this.db.prepare('UPDATE enc_keys SET published = ? WHERE version = ?').run(patch.published ? 1 : 0, version);
    if (patch.deleted) this.db.prepare('UPDATE enc_keys SET sealed_secret = NULL, deleted_at = ? WHERE version = ?').run(this.now(), version);
  }
  deleteEncKeyRow(version: number): void {
    this.db.prepare('DELETE FROM enc_keys WHERE version = ?').run(version);
  }

  // ---------------------------------------------------------------- quotes, pools, approvals
  putQuote(id: string, chain: string, kind: string, payload: unknown, expiresAt: number): void {
    this.db.prepare('INSERT OR REPLACE INTO quotes (id, chain, kind, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, chain, kind, toJson(payload), expiresAt, this.now());
  }
  quote<T = unknown>(id: string): { id: string; chain: string; kind: string; payload: T; expires_at: number } | undefined {
    const r = this.db.prepare('SELECT * FROM quotes WHERE id = ?').get(id) as { id: string; chain: string; kind: string; payload: string; expires_at: number } | undefined;
    return r ? { ...r, payload: fromJson<T>(r.payload) } : undefined;
  }
  putPool(root: string, token: string, leaves: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO key_pools (root, token, leaves, created_at) VALUES (?, ?, ?, ?)').run(root, token, JSON.stringify(leaves), this.now());
  }
  pool<T = unknown>(root: string): { root: string; token: string; leaves: T; retired: number } | undefined {
    const r = this.db.prepare('SELECT * FROM key_pools WHERE root = ?').get(root) as { root: string; token: string; leaves: string; retired: number } | undefined;
    return r ? { ...r, leaves: JSON.parse(r.leaves) as T } : undefined;
  }
  currentPool<T = unknown>(token: string): { root: string; token: string; leaves: T } | undefined {
    const r = this.db.prepare('SELECT * FROM key_pools WHERE token = ? AND retired = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1').get(token) as { root: string; token: string; leaves: string } | undefined;
    return r ? { ...r, leaves: JSON.parse(r.leaves) as T } : undefined;
  }
  retirePool(root: string): void {
    this.db.prepare('UPDATE key_pools SET retired = 1 WHERE root = ?').run(root);
  }
  insertApproval(r: { id: string; chain: string; taker: string; market: string | null; direction: string | null; max_xmr: string; not_before: number; expires_at: number; epoch: number; sig: string }): void {
    this.db.prepare('INSERT INTO approvals_issued (id, chain, taker, market, direction, max_xmr, not_before, expires_at, epoch, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, r.chain, r.taker, r.market, r.direction, r.max_xmr, r.not_before, r.expires_at, r.epoch, r.sig);
  }
  approvals(): { id: string; chain: 'solana' | 'ethereum'; taker: string; market: string | null; direction: string | null; max_xmr: string; not_before: number; expires_at: number; epoch: number; sig: string; revoked: number }[] {
    return this.db.prepare('SELECT * FROM approvals_issued ORDER BY not_before DESC').all() as never;
  }
  revokeApproval(id: string): void {
    this.db.prepare('UPDATE approvals_issued SET revoked = 1 WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------- messages
  insertMessage(m: Omit<MessageRow, 'read'> & { read?: number }): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO messages (id, at, direction, transport, type, swap_ref, peer, text, action, read, in_reply_to, taker_pub, key_version, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, m.at, m.direction, m.transport, m.type, m.swap_ref, m.peer, m.text, m.action, m.read ?? 0, m.in_reply_to, m.taker_pub, m.key_version, m.reply_to).changes > 0
    );
  }
  message(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }
  messages(swapRef?: string): MessageRow[] {
    return (swapRef ? this.db.prepare('SELECT * FROM messages WHERE swap_ref = ? ORDER BY at DESC, rowid DESC').all(swapRef) : this.db.prepare('SELECT * FROM messages ORDER BY at DESC, rowid DESC').all()) as MessageRow[];
  }
  markRead(id: string): void {
    this.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(id);
  }
  addReply(takerPub: string, envelope: Uint8Array): void {
    this.db.prepare('INSERT INTO replies (taker_pub, envelope, at) VALUES (?, ?, ?)').run(takerPub, Buffer.from(envelope), this.now());
  }
  /** Newest first; kept 30 days. */
  replies(takerPub: string, retentionSecs: number): Uint8Array[] {
    this.db.prepare('DELETE FROM replies WHERE at < ?').run(this.now() - retentionSecs);
    return (this.db.prepare('SELECT envelope FROM replies WHERE taker_pub = ? ORDER BY id DESC').all(takerPub) as { envelope: Buffer }[]).map((r) => new Uint8Array(r.envelope));
  }

  // ---------------------------------------------------------------- history
  recordPrice(source: string, asset: string, usd: number, at = this.now()): void {
    this.db.prepare('INSERT INTO prices (at, source, asset, usd) VALUES (?, ?, ?, ?)').run(at, source, asset, usd);
  }
  pricesSince(asset: string, since: number): { at: number; source: string; usd: number }[] {
    return this.db.prepare('SELECT at, source, usd FROM prices WHERE asset = ? AND at >= ? ORDER BY at').all(asset, since) as never;
  }
  prunePrices(before: number): void {
    this.db.prepare('DELETE FROM prices WHERE at < ?').run(before);
  }
  recordFee(chain: string, kind: string, asset: string, amount: bigint, tx: string | null): void {
    this.db.prepare('INSERT INTO fees_spent (at, chain, kind, asset, amount, tx) VALUES (?, ?, ?, ?, ?, ?)').run(this.now(), chain, kind, asset, amount.toString(), tx);
  }
  feesSince(since: number): { at: number; chain: string; kind: string; asset: string; amount: string }[] {
    return this.db.prepare('SELECT at, chain, kind, asset, amount FROM fees_spent WHERE at >= ? ORDER BY at').all(since) as never;
  }
  recordFill(f: { swap_ref: string; market: string; direction: number; xmr: bigint; amount: bigint; spread_usd: number | null }): void {
    this.db.prepare('INSERT OR IGNORE INTO fills (swap_ref, at, market, direction, xmr, amount, spread_usd) VALUES (?, ?, ?, ?, ?, ?, ?)').run(f.swap_ref, this.now(), f.market, f.direction, f.xmr.toString(), f.amount.toString(), f.spread_usd);
  }
  fills(since = 0): { swap_ref: string; at: number; market: string; direction: number; xmr: string; amount: string; spread_usd: number | null }[] {
    return this.db.prepare('SELECT * FROM fills WHERE at >= ? ORDER BY at').all(since) as never;
  }
  logConfig(revision: string, source: 'file' | 'api' | 'import', changes: unknown): void {
    this.db.prepare('INSERT INTO config_log (at, revision, source, changes) VALUES (?, ?, ?, ?)').run(this.now(), revision, source, JSON.stringify(changes));
  }
  configLog(): { at: number; revision: string; source: 'file' | 'api' | 'import'; changes: { path: string; old: string | null; new: string | null }[] }[] {
    return (this.db.prepare('SELECT * FROM config_log ORDER BY id DESC').all() as { at: number; revision: string; source: 'file' | 'api' | 'import'; changes: string }[]).map((r) => ({ ...r, changes: JSON.parse(r.changes) }));
  }
  addAlert(level: AlertRow['level'], kind: string, message: string, swapRef: string | null = null): AlertRow {
    const id = Number(this.db.prepare('INSERT INTO alerts (at, level, kind, message, swap_ref) VALUES (?, ?, ?, ?, ?)').run(this.now(), level, kind, message, swapRef).lastInsertRowid);
    return { id, at: this.now(), level, kind, message, swap_ref: swapRef, acknowledged: 0 };
  }
  alerts(limit = 100): AlertRow[] {
    return this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit) as AlertRow[];
  }
  // ---------------------------------------------------------------- Amendment 1: watcher acknowledgements and freezes
  putWatchAck(r: Omit<WatchAckRow, 'at'>): void {
    this.db.prepare('INSERT OR REPLACE INTO watch_acks (swap_ref, chain, watcher, watching_until, sig, at) VALUES (?, ?, ?, ?, ?, ?)').run(r.swap_ref, r.chain, r.watcher, r.watching_until, r.sig, this.now());
  }
  watchAck(swapRef: string): WatchAckRow | undefined {
    return this.db.prepare('SELECT * FROM watch_acks WHERE swap_ref = ?').get(swapRef) as WatchAckRow | undefined;
  }
  watchAcks(): WatchAckRow[] {
    return this.db.prepare('SELECT * FROM watch_acks ORDER BY at DESC').all() as WatchAckRow[];
  }
  /** Recorded once, the first time a swap is seen frozen (or settled after a freeze). */
  recordFreeze(r: Omit<FreezeRow, 'at'>): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO freezes (swap_ref, chain, direction, taker, watcher, frozen_by, t_freeze, t_ff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.swap_ref, r.chain, r.direction, r.taker, r.watcher, r.frozen_by, r.t_freeze, r.t_ff, this.now()).changes > 0;
  }
  freeze(swapRef: string): FreezeRow | undefined {
    return this.db.prepare('SELECT * FROM freezes WHERE swap_ref = ?').get(swapRef) as FreezeRow | undefined;
  }
  freezes(): FreezeRow[] {
    return this.db.prepare('SELECT * FROM freezes ORDER BY t_freeze DESC').all() as FreezeRow[];
  }
  /** How many of a taker's swaps with this maker were frozen by the taker's side (direction A). Keyed on the taker, never on a payout address. */
  takerFreezes(taker: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM freezes WHERE direction = 0 AND LOWER(taker) = LOWER(?)').get(taker) as { n: number }).n;
  }
  beat(): void {
    const day = Math.floor(this.now() / 86_400);
    this.db.prepare('INSERT INTO uptime (day, beats) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET beats = beats + 1').run(day);
  }
  beats(sinceDay: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(beats), 0) AS n FROM uptime WHERE day >= ?').get(sinceDay) as { n: number }).n;
  }
}
