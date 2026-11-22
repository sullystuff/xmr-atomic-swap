/**
 * The set of onion addresses the relay may forward to: the `onion` field of every maker account
 * currently in the on-chain registry (SPEC 6.5 "Not an open proxy").
 *
 * The lookup sits behind `RegistrySource`, so tests and other deployments can inject their own.
 * The relay holds no key: it only reads accounts.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { ACCOUNTS, RELAY_LIMITS, base58Encode, decodeAccount } from '@xmrswap/protocol';
import { isOnionHost } from './onion.js';

export interface RegistrySnapshot {
  /** Number of maker accounts in the registry, with or without an onion address. */
  makers: number;
  /** The `onion` field of each maker account that has one. */
  onions: string[];
}

export interface RegistrySource {
  fetch(): Promise<RegistrySnapshot>;
}

/** Reads maker accounts with `getProgramAccounts`, filtered by the `Maker` discriminator. */
export class SolanaRegistrySource implements RegistrySource {
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(rpcUrl: string, programId: string) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    this.programId = new PublicKey(programId);
  }

  async fetch(): Promise<RegistrySnapshot> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: base58Encode(ACCOUNTS.Maker.discriminator) } }],
    });
    let makers = 0;
    const onions: string[] = [];
    for (const { account } of accounts) {
      try {
        const maker = decodeAccount('Maker', account.data);
        makers += 1;
        if (maker.onion !== '') onions.push(maker.onion);
      } catch {
        // Not a maker account this version can read: it lists nothing.
      }
    }
    return { makers, onions };
  }
}

/** A registry with nothing in it: every forward is refused. Used when no Solana RPC is configured. */
export const emptyRegistrySource: RegistrySource = { fetch: async () => ({ makers: 0, onions: [] }) };

export interface RegistryCacheOptions {
  /** Refresh period. Default 60 s. */
  refreshMs?: number;
  /** A miss triggers a refresh, but not more often than this. Default 5 s. */
  missRefreshMinMs?: number;
  /** A list older than this is no longer "currently in the registry" and is dropped. Default 10 min. */
  maxAgeMs?: number;
  now?: () => number;
  /** Called when a refresh fails. Never receives request data. */
  onError?: (err: unknown) => void;
}

export class RegistryCache {
  private onions = new Set<string>();
  private makerCount = 0;
  private lastSuccess: number | null = null;
  private lastAttempt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly refreshMs: number;
  private readonly missRefreshMinMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly source: RegistrySource,
    private readonly opts: RegistryCacheOptions = {},
  ) {
    this.refreshMs = opts.refreshMs ?? RELAY_LIMITS.registryRefreshSecs * 1000;
    this.missRefreshMinMs = opts.missRefreshMinMs ?? 5_000;
    this.maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Load once now and then every `refreshMs`. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fetch the registry. Concurrent callers share one fetch. A failure keeps the previous list. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastAttempt = this.now();
    this.inFlight = (async () => {
      try {
        const snap = await this.source.fetch();
        // Only well-formed v3 onion hosts are ever forwardable, whatever the source returns.
        this.onions = new Set(snap.onions.filter(isOnionHost));
        this.makerCount = snap.makers;
        this.lastSuccess = this.now();
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  private expire(): void {
    if (this.lastSuccess !== null && this.now() - this.lastSuccess > this.maxAgeMs) {
      this.onions = new Set();
      this.makerCount = 0;
    }
  }

  /**
   * Is this onion address listed by a maker account right now? Refreshes first when the list is
   * older than the refresh period, and once more on a miss (rate-limited), so an address a maker
   * has just published works without waiting and one just removed stops within a period.
   */
  async isListed(onion: string): Promise<boolean> {
    const now = this.now();
    if (this.lastSuccess === null || now - this.lastSuccess >= this.refreshMs) {
      if (this.lastAttempt === null || now - this.lastAttempt >= this.missRefreshMinMs || this.inFlight) await this.refresh();
    }
    this.expire();
    if (this.onions.has(onion)) return true;
    if (this.lastAttempt === null || this.now() - this.lastAttempt >= this.missRefreshMinMs || this.inFlight) {
      await this.refresh();
      this.expire();
    }
    return this.onions.has(onion);
  }

  /** Seconds since the last successful read; -1 if there has been none. */
  ageSecs(): number {
    return this.lastSuccess === null ? -1 : Math.max(0, Math.floor((this.now() - this.lastSuccess) / 1000));
  }

  /** Maker accounts seen in the last successful read (0 once that read is too old to trust). */
  get makers(): number {
    this.expire();
    return this.makerCount;
  }
}
