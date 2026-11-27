/**
 * The maker's own watcher (SPEC 11.6, "Sell direction"): a second machine that holds only the
 * notice key of each buy-XMR swap and pauses the swap (`freeze`) when the taker's XMR lock does
 * not check out while this daemon is down. It can move nothing and reveals nothing.
 *
 * This module is the daemon's side of it: which key to name at `fund`, handing each funded swap
 * to the watcher through the SDK's `WatcherClient`, and keeping the signed acknowledgement. The
 * notice key is sealed to the watcher key the FILE names, and an acknowledgement counts only if
 * that key signed it: a wrong or impersonated service learns nothing and is never trusted.
 */
import type { ChainName } from '@xmrswap/protocol';
import type { WatcherStatus } from '@xmrswap/protocol/daemon-api';
import { type HttpFetch, type SwapView, type WatchAck, WatcherClient, noticeKey } from '@xmrswap/sdk';
import type { Alerts } from '../alerts/index.js';
import { type Config, watcherConfigured } from '../config/load.js';
import type { Store, WatchAckRow } from '../store/db.js';
import { CrashError, type Journal } from '../store/journal.js';
import { type Bytes, errMsg } from '../util.js';

export interface MakerWatcherOptions {
  store: Store;
  journal: Journal;
  alerts: Alerts;
  config: () => Config;
  /** HTTP to the watcher (tests inject a fake; an onion address needs a fetch routed through Tor). */
  fetch?: HttpFetch;
  /** Milliseconds. */
  clock?: () => number;
}

export class MakerWatcher {
  private nextTry = new Map<string, number>();
  private reachable: boolean | null = null;
  private lastError: string | null = null;
  private seen: { solana: string; ethereum: string } | null = null;

  constructor(private readonly o: MakerWatcherOptions) {}
  private clock(): number {
    return (this.o.clock ?? Date.now)();
  }
  private get settings() {
    return this.o.config().raw.watcher;
  }
  private client(): WatcherClient | null {
    const url = this.settings.url;
    return url && watcherConfigured(this.o.config().raw, 'solana') ? new WatcherClient(url, ...(this.o.fetch ? [this.o.fetch] : [])) : null;
  }

  /** The key to name as watcher when funding a swap on `chain`, or `null`: no watcher is set for it. */
  keyFor(chain: ChainName): string | null {
    if (!watcherConfigured(this.o.config().raw, chain)) return null;
    return chain === 'solana' ? this.settings.solana_key! : this.settings.ethereum_key!.toLowerCase();
  }
  /** The watcher to name at `fund`: only a swap whose terms carry a freeze window may name one (`WatcherNotAllowed` otherwise). */
  nameFor(view: Pick<SwapView, 'chain' | 'direction' | 'wZ'>): string | null {
    return view.direction === 1 && view.wZ > 0 ? this.keyFor(view.chain) : null;
  }
  /** Whether a swap names this maker's watcher. */
  names(view: Pick<SwapView, 'chain' | 'direction' | 'watcherAddress'>): boolean {
    const key = this.keyFor(view.chain);
    return view.direction === 1 && key !== null && view.watcherAddress !== null && view.watcherAddress.toLowerCase() === key.toLowerCase();
  }
  ack(ref: string): WatchAckRow | undefined {
    return this.o.store.watchAck(ref);
  }

  /**
   * Hand a funded swap to the watcher and keep its signed acknowledgement. Called once the
   * swap that names the watcher is final (the service accepts only what it finds there).
   * Never throws: an unreachable or refusing watcher leaves the swap unwatched, says so, and is
   * tried again after `retry_seconds`. The daemon's own handling of the swap never waits on it.
   */
  async register(ref: string, view: SwapView, lockerEncSecret: Bytes): Promise<WatchAckRow | null> {
    const have = this.ack(ref);
    if (have) return have;
    const client = this.client();
    const key = this.keyFor('solana');
    if (!client || !key || !this.names(view)) return null;
    const t = this.clock();
    if ((this.nextTry.get(ref) ?? 0) > t) return null;
    this.nextTry.set(ref, t + this.settings.retry_seconds * 1_000);
    try {
      await this.o.journal.act<WatchAck>(
        'watch_register',
        ref,
        { call: 'watch_register', watcher: key },
        // The notice key decrypts this one swap's notice and nothing else; it leaves sealed to the watcher's key.
        () => client.register({ chain: view.chain, swapRef: view.swapRef, noticeKey: noticeKey(view, lockerEncSecret), watcherSolanaKey: key }),
        (a) => {
          this.o.store.putWatchAck({ swap_ref: ref, chain: view.chain, watcher: key, watching_until: a.watching_until, sig: a.sig });
          return { meta: { watching_until: a.watching_until } };
        },
      );
      this.reachable = true;
      this.lastError = null;
      this.nextTry.delete(ref);
      return this.ack(ref) ?? null;
    } catch (e) {
      if (e instanceof CrashError) throw e;
      this.reachable = (e as { code?: string }).code === 'unavailable' ? false : this.reachable;
      this.lastError = errMsg(e);
      this.o.alerts.raise('warning', 'watcher_not_watching', `the watcher did not acknowledge this swap (${errMsg(e)}); it is NOT watched, and the daemon must stay up through its claim-open time. Trying again.`, ref, 600);
      return null;
    }
  }

  /** `GET /watch/v1/info`: is it there, and is it the watcher the file names? */
  async probe(): Promise<void> {
    const client = this.client();
    if (!client) {
      this.reachable = null;
      this.seen = null;
      return;
    }
    try {
      const info = await client.info();
      this.seen = { solana: info.solana, ethereum: info.ethereum };
      this.reachable = true;
      this.lastError = null;
      const s = this.settings;
      if (info.solana !== s.solana_key || (s.ethereum_key && info.ethereum !== s.ethereum_key.toLowerCase())) {
        this.lastError = 'the service at [watcher] url answers with other keys than the file names; swaps are still sealed to and acknowledged by the keys in the file only';
        this.o.alerts.raise('critical', 'watcher_key_mismatch', this.lastError, null, 3_600);
      }
    } catch (e) {
      this.reachable = false;
      this.lastError = errMsg(e);
    }
  }

  /** Open swaps the watcher acknowledged and whose promise has not run out. */
  watching(now: number): number {
    const open = new Set(this.o.store.swaps({ open: true }).map((s) => s.ref));
    return this.o.store.watchAcks().filter((a) => open.has(a.swap_ref) && a.watching_until > now).length;
  }

  status(now: number): WatcherStatus {
    const s = this.settings;
    const on = this.client() !== null;
    return {
      url: s.url ?? null, reachable: on ? this.reachable : null, solana: on ? s.solana_key! : null, ethereum: on && s.ethereum_key ? s.ethereum_key.toLowerCase() : null, watching: this.watching(now),
      ...(this.lastError ? { last_error: this.lastError } : {}),
      // Additions: what the service itself reports, so a mismatch with the file is visible.
      ...({ reported: this.seen } as object),
    };
  }
}

