/**
 * Durable state: one SQLite file (WAL, `synchronous = FULL`, `secure_delete`). A watch is a
 * row; the decision to freeze and every transaction built for it are written here **before**
 * anything is broadcast, so a restart continues from the journal and never guesses.
 *
 * It stores the minimum (SPEC 11.6): the chain, the swap reference, where the watch stands and
 * the transactions the watcher itself sent. It never stores the swap's amount, its parties, the
 * Monero transaction, the joint address or a view share. The one secret, the notice key (one per
 * swap), is sealed under a key from the keystore and its row is deleted when the watch ends.
 *
 * The file is bound to one pair of watcher keys at first start and refuses to open for another.
 */
import Database from 'better-sqlite3';
import type { ChainName } from '@xmrswap/protocol';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watches (
  chain TEXT NOT NULL, swap_ref TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, phase TEXT NOT NULL,
  watching_until INTEGER NOT NULL, decided_why TEXT, decided_at INTEGER, not_after INTEGER,
  stop_why TEXT, stop_seen INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, checked_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminal_at INTEGER,
  PRIMARY KEY (chain, swap_ref));
CREATE INDEX IF NOT EXISTS watches_open ON watches (terminal_at);
CREATE TABLE IF NOT EXISTS watch_keys (
  chain TEXT NOT NULL, swap_ref TEXT NOT NULL, sealed BLOB NOT NULL, issued_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (chain, swap_ref));
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, swap_ref TEXT NOT NULL, tx_id TEXT NOT NULL, wire BLOB NOT NULL,
  max_fee TEXT NOT NULL, nonce INTEGER, fee_per_gas TEXT, tip_per_gas TEXT, valid_until INTEGER, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_swap ON attempts (chain, swap_ref);
CREATE INDEX IF NOT EXISTS attempts_at ON attempts (chain, created_at);
`;

/**
 * `watching`: following the swap. `freezing`: the decision to freeze is journaled and not yet
 * seen on chain. Terminal: `frozen` (the swap is FROZEN on chain), `not_needed` (ready, ended,
 * or the lock stayed good through the window), `window_missed` (a freeze was due or could not
 * be judged, and did not land before the window closed; `reason` says why).
 */
export type WatchStatus = 'watching' | 'freezing' | 'frozen' | 'not_needed' | 'window_missed';
export const TERMINAL: readonly WatchStatus[] = ['frozen', 'not_needed', 'window_missed'];

export interface WatchRow {
  chain: ChainName;
  swap_ref: string;
  status: WatchStatus;
  reason: string | null;
  /** What the last pass was waiting for: `notice`, `lock-check`, `recheck`, `freeze`, or `new`. */
  phase: string;
  watching_until: number;
  decided_why: string | null;
  decided_at: number | null;
  not_after: number | null;
  stop_why: string | null;
  stop_seen: number;
  errors: number;
  next_at: number;
  last_error: string | null;
  checked_at: number | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

/**
 * `journaled`: written, not known to have been broadcast. `sent`: handed to the endpoint.
 * `landed`: seen on chain, succeeded. `failed`: seen on chain, failed (the fee was paid).
 * `dropped`: gave up on it without it landing (expired blockhash, or replaced at the same nonce).
 */
export type AttemptStatus = 'journaled' | 'sent' | 'landed' | 'failed' | 'dropped';
export interface AttemptRow {
  id: number;
  chain: ChainName;
  swap_ref: string;
  tx_id: string;
  wire: Buffer;
  max_fee: string;
  nonce: number | null;
  fee_per_gas: string | null;
  tip_per_gas: string | null;
  /** Solana: the block height after which the transaction's blockhash is dead. */
  valid_until: number | null;
  status: AttemptStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export class Store {
  readonly db: Database.Database;

  constructor(file: string, bind: { solana: string; ethereum: string }) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('secure_delete = ON');
    this.db.exec(SCHEMA);
    const get = (k: string): string | undefined => (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value;
    const version = get('schema_version');
    if (version === undefined) this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    else if (version !== String(SCHEMA_VERSION)) throw new StoreError(`the database has schema version ${version}; this build reads ${SCHEMA_VERSION}`);
    for (const [k, v] of [['solana', bind.solana], ['ethereum', bind.ethereum]] as const) {
      const have = get(`key_${k}`);
      if (have === undefined) this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`key_${k}`, v);
      else if (have !== v) throw new StoreError('this database belongs to another watcher key; refusing to open it');
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- watches

  getWatch(chain: ChainName, swapRef: string): WatchRow | null {
    return (this.db.prepare('SELECT * FROM watches WHERE chain = ? AND swap_ref = ?').get(chain, swapRef) as WatchRow | undefined) ?? null;
  }
  /** A status lookup by reference alone (the route carries no chain). */
  findWatches(swapRef: string): WatchRow[] {
    return this.db.prepare('SELECT * FROM watches WHERE swap_ref = ?').all(swapRef) as WatchRow[];
  }
  activeWatches(): WatchRow[] {
    return this.db.prepare('SELECT * FROM watches WHERE terminal_at IS NULL ORDER BY created_at, swap_ref').all() as WatchRow[];
  }
  activeCount(chain?: ChainName): number {
    const row = chain ? this.db.prepare('SELECT COUNT(*) AS n FROM watches WHERE terminal_at IS NULL AND chain = ?').get(chain) : this.db.prepare('SELECT COUNT(*) AS n FROM watches WHERE terminal_at IS NULL').get();
    return (row as { n: number }).n;
  }
  countsByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM watches GROUP BY status').all() as { status: string; n: number }[]) out[r.status] = r.n;
    return out;
  }
  keyCount(chain: ChainName, swapRef: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM watch_keys WHERE chain = ? AND swap_ref = ?').get(chain, swapRef) as { n: number }).n;
  }
  /** The one notice key of a watch (sealed), with the `issued_at` of the request that brought it. */
  key(chain: ChainName, swapRef: string): { sealed: Buffer; issued_at: number } | null {
    return (this.db.prepare('SELECT sealed, issued_at FROM watch_keys WHERE chain = ? AND swap_ref = ?').get(chain, swapRef) as { sealed: Buffer; issued_at: number } | undefined) ?? null;
  }

  /**
   * Store a watch and its notice key in a single committed transaction; the cap is re-checked
   * inside it. One key per swap: every accepted request was made by the swap's locker, so a
   * later request (`issued_at` newer) replaces the key, the same request again changes nothing,
   * and an older one is refused. Nothing is acknowledged before this returns.
   */
  admit(a: { chain: ChainName; swapRef: string; sealedKey: Buffer; issuedAt: number; watchingUntil: number; now: number; maxSwaps: number }): 'stored' | 'same' | 'renewed' | 'older' | 'full' | 'ended' {
    return this.db
      .transaction(() => {
        const row = this.getWatch(a.chain, a.swapRef);
        if (row && row.terminal_at !== null) return 'ended' as const;
        const have = this.key(a.chain, a.swapRef);
        if (have && a.issuedAt < have.issued_at) return 'older' as const;
        if (have && a.issuedAt === have.issued_at) return 'same' as const;
        if (!row) {
          if (this.activeCount() >= a.maxSwaps) return 'full' as const;
          this.db.prepare("INSERT INTO watches (chain, swap_ref, status, phase, watching_until, created_at, updated_at) VALUES (?, ?, 'watching', 'new', ?, ?, ?)").run(a.chain, a.swapRef, a.watchingUntil, a.now, a.now);
        }
        this.db.prepare('INSERT INTO watch_keys (chain, swap_ref, sealed, issued_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (chain, swap_ref) DO UPDATE SET sealed = excluded.sealed, issued_at = excluded.issued_at').run(a.chain, a.swapRef, a.sealedKey, a.issuedAt, a.now);
        return have ? ('renewed' as const) : ('stored' as const);
      })
      .immediate();
  }

  updateWatch(chain: ChainName, swapRef: string, set: Partial<Omit<WatchRow, 'chain' | 'swap_ref' | 'created_at'>>, now: number): void {
    const cols = Object.keys(set);
    const sql = `UPDATE watches SET ${[...cols, 'updated_at'].map((c) => `${c} = ?`).join(', ')} WHERE chain = ? AND swap_ref = ?`;
    this.db.prepare(sql).run(...cols.map((c) => (set as Record<string, unknown>)[c] ?? null), now, chain, swapRef);
  }

  /** Journal the decision to freeze. Idempotent: the first decision stands. */
  journalDecision(chain: ChainName, swapRef: string, why: string, notAfter: number, now: number): void {
    this.db.prepare("UPDATE watches SET status = 'freezing', phase = 'freeze', decided_why = ?, decided_at = ?, not_after = ?, updated_at = ? WHERE chain = ? AND swap_ref = ? AND status = 'watching'").run(why, now, notAfter, now, chain, swapRef);
  }

  /** The terminal record, and the end of the watch's secrets, in one committed transaction. */
  finish(chain: ChainName, swapRef: string, status: WatchStatus, reason: string, now: number): void {
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE watches SET status = ?, reason = ?, phase = ?, terminal_at = ?, updated_at = ? WHERE chain = ? AND swap_ref = ? AND terminal_at IS NULL').run(status, reason, 'done', now, now, chain, swapRef);
        this.db.prepare('DELETE FROM watch_keys WHERE chain = ? AND swap_ref = ?').run(chain, swapRef);
      })
      .immediate();
    // Deleted pages must not linger in the write-ahead log.
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Drop terminal watches (and their transactions) that ended before `before`. Returns how many. */
  purge(before: number): number {
    return this.db
      .transaction(() => {
        const old = this.db.prepare('SELECT chain, swap_ref FROM watches WHERE terminal_at IS NOT NULL AND terminal_at < ?').all(before) as { chain: string; swap_ref: string }[];
        for (const w of old) {
          this.db.prepare('DELETE FROM attempts WHERE chain = ? AND swap_ref = ?').run(w.chain, w.swap_ref);
          this.db.prepare('DELETE FROM watch_keys WHERE chain = ? AND swap_ref = ?').run(w.chain, w.swap_ref);
          this.db.prepare('DELETE FROM watches WHERE chain = ? AND swap_ref = ?').run(w.chain, w.swap_ref);
        }
        return old.length;
      })
      .immediate();
  }

  // ---------------------------------------------------------------- transactions the watcher sent

  attempts(chain: ChainName, swapRef: string): AttemptRow[] {
    return this.db.prepare('SELECT * FROM attempts WHERE chain = ? AND swap_ref = ? ORDER BY id').all(chain, swapRef) as AttemptRow[];
  }
  /** Journal a signed transaction before it is broadcast. */
  journalAttempt(a: { chain: ChainName; swapRef: string; txId: string; wire: Uint8Array; maxFee: bigint; nonce: number | null; feePerGas: bigint | null; tipPerGas: bigint | null; validUntil: number | null; now: number }): number {
    const r = this.db.prepare("INSERT INTO attempts (chain, swap_ref, tx_id, wire, max_fee, nonce, fee_per_gas, tip_per_gas, valid_until, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'journaled', ?, ?)").run(a.chain, a.swapRef, a.txId, Buffer.from(a.wire), a.maxFee.toString(), a.nonce, a.feePerGas?.toString() ?? null, a.tipPerGas?.toString() ?? null, a.validUntil, a.now, a.now);
    return Number(r.lastInsertRowid);
  }
  setAttempt(id: number, status: AttemptStatus, now: number, error: string | null = null): void {
    this.db.prepare('UPDATE attempts SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, now, id);
  }
  /** Highest Ethereum nonce held by a transaction that may still land. */
  highestOpenNonce(): number | null {
    return (this.db.prepare("SELECT MAX(nonce) AS n FROM attempts WHERE chain = 'ethereum' AND status IN ('journaled', 'sent')").get() as { n: number | null }).n;
  }

  /**
   * Fees committed on a chain: the sum of the maximum fee of every transaction that landed or
   * may still land. Ethereum transactions that share a nonce count once, at the highest, since
   * at most one of them can ever be mined. `since` limits it to a day; `swapRef` to one swap.
   */
  committed(chain: ChainName, o: { swapRef?: string; since?: number } = {}): bigint {
    const rows = this.db
      .prepare(`SELECT swap_ref, nonce, max_fee FROM attempts WHERE chain = ? AND status <> 'dropped'${o.swapRef ? ' AND swap_ref = ?' : ''}${o.since !== undefined ? ' AND created_at >= ?' : ''}`)
      .all(...([chain, o.swapRef, o.since].filter((v) => v !== undefined) as (string | number)[])) as { swap_ref: string; nonce: number | null; max_fee: string }[];
    let sum = 0n;
    const byNonce = new Map<number, bigint>();
    for (const r of rows) {
      const fee = BigInt(r.max_fee);
      if (r.nonce === null) sum += fee;
      else byNonce.set(r.nonce, fee > (byNonce.get(r.nonce) ?? 0n) ? fee : (byNonce.get(r.nonce) ?? 0n));
    }
    for (const fee of byNonce.values()) sum += fee;
    return sum;
  }
}
