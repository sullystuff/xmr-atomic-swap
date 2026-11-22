/**
 * A small key-value store over IndexedDB (SPEC 8.3: the sealed seed and the large-swap order
 * live in IndexedDB). Falls back to memory where IndexedDB does not exist (unit tests, a
 * private window that refuses it): nothing then survives the tab, and the UI says so.
 */
export interface KV {
  readonly persistent: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export class MemoryKV implements KV {
  readonly persistent = false;
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

const DB = 'xmrswap';
const STORE = 'kv';

class IdbKV implements KV {
  readonly persistent = true;
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB refused to open'));
    });
    return this.db;
  }
  private async run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = f(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  }
  async get(key: string): Promise<string | null> {
    return ((await this.run('readonly', (s) => s.get(key))) as string | undefined) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.run('readwrite', (s) => s.put(value, key));
  }
  async del(key: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(key));
  }
  async keys(prefix: string): Promise<string[]> {
    const all = (await this.run('readonly', (s) => s.getAllKeys())) as IDBValidKey[];
    return all.map(String).filter((k) => k.startsWith(prefix));
  }
}

export function openKV(): KV {
  return typeof indexedDB === 'undefined' ? new MemoryKV() : new IdbKV();
}

/** Non-secret per-tab and per-device notes (which swaps were seen, destinations, theme). */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or refused: the note is a convenience, never a safety input.
    }
  },
  del(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // as above
    }
  },
};
