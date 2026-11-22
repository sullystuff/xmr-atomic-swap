/**
 * The browser-side protections of SPEC 8.5 that are effects rather than pictures:
 * the leave-page prompt (item 4), the tab title (item 3), the Screen Wake Lock (item 5) and
 * the connection alarm with a sound and a notification (item 6).
 */
import type { EngineState } from './engine.js';
import { formatDuration } from './format.js';
import { BASE_TITLE, type Safety, riskTitle, secondsLeft } from './safety.js';

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface GuardEnv {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'title' | 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } | undefined;
  /** Play the alarm sound. */
  beep(): void;
  /** Show a system notification; resolves false when the user has not allowed them. */
  notify(title: string, body: string): boolean;
}

export interface GuardStatus {
  /** `held`: the screen is kept on. `unsupported`: this browser cannot; the banner then tells the user to keep the screen on by hand. */
  wakeLock: 'idle' | 'held' | 'unsupported' | 'refused';
  /** The connection alarm is sounding. */
  alarm: string | null;
}

export class Guard {
  private armed = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private status: GuardStatus = { wakeLock: 'idle', alarm: null };
  private alarmKey: string | null = null;
  private lastBeep = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly env: GuardEnv) {
    this.env.document.addEventListener('visibilitychange', this.onVisible);
  }

  subscribe = (f: () => void): (() => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
  getStatus = (): GuardStatus => this.status;
  private set(patch: Partial<GuardStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const f of this.listeners) f();
  }

  private readonly onBeforeUnload = (e: BeforeUnloadEvent): string => {
    // The browser shows its own wording; setting returnValue is what triggers the prompt.
    e.preventDefault();
    e.returnValue = 'A swap is at risk. If you leave now you can lose your funds.';
    return e.returnValue;
  };
  private readonly onVisible = (): void => {
    if (this.armed && this.env.document.visibilityState === 'visible') void this.acquire();
  };

  private async acquire(): Promise<void> {
    if (!this.env.wakeLock) {
      this.set({ wakeLock: 'unsupported' });
      return;
    }
    if (this.sentinel && !this.sentinel.released) return;
    try {
      this.sentinel = await this.env.wakeLock.request('screen');
      this.sentinel.addEventListener?.('release', () => {
        if (this.armed) this.set({ wakeLock: 'refused' });
      });
      this.set({ wakeLock: 'held' });
    } catch {
      this.set({ wakeLock: 'refused' });
    }
  }

  /** Bring the protections in line with the current safety picture. Call on every state change and once a second. */
  update(engine: EngineState, safety: Safety, nowMs: number = Date.now()): void {
    const risky = safety.atRisk.length > 0;
    const left = secondsLeft(engine, safety, nowMs);
    if (risky && !this.armed) {
      this.armed = true;
      this.env.window.addEventListener('beforeunload', this.onBeforeUnload);
      void this.acquire();
    } else if (!risky && this.armed) {
      this.armed = false;
      this.env.window.removeEventListener('beforeunload', this.onBeforeUnload);
      void this.sentinel?.release().catch(() => undefined);
      this.sentinel = null;
      this.set({ wakeLock: 'idle' });
    }
    const title = risky ? riskTitle(left) : safety.safeToClose ? `Safe to close · ${BASE_TITLE}` : BASE_TITLE;
    if (this.env.document.title !== title) this.env.document.title = title;

    // Connection alarm: a chain or Monero connection dropped while a leg is at risk.
    const down = risky ? (['solana', 'ethereum', 'monero'] as const).filter((k) => !engine.health[k].ok && (k === 'monero' || safety.atRisk.some((t) => t.chain === k))) : [];
    if (down.length === 0) {
      if (this.alarmKey !== null) {
        this.alarmKey = null;
        this.set({ alarm: null });
      }
      return;
    }
    const names = down.map((k) => (k === 'solana' ? 'Solana' : k === 'ethereum' ? 'Ethereum' : 'Monero')).join(' and ');
    const timeLeft = left === null ? 'an unknown time' : formatDuration(left);
    const text = `The ${names} connection dropped. ${timeLeft} left before the refund deadline. If it does not come back in time you can lose your funds.`;
    const key = down.join('+');
    if (key !== this.alarmKey) {
      this.alarmKey = key;
      this.lastBeep = nowMs;
      this.env.beep();
      this.env.notify('Connection lost during a swap', text);
    } else if (nowMs - this.lastBeep >= 30_000) {
      this.lastBeep = nowMs;
      this.env.beep();
    }
    if (this.status.alarm !== text) this.set({ alarm: text });
  }

  dispose(): void {
    this.env.window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.env.document.removeEventListener('visibilitychange', this.onVisible);
    void this.sentinel?.release().catch(() => undefined);
  }
}

/** Three short tones through Web Audio: no audio file is fetched. */
export function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.35);
      osc.stop(ctx.currentTime + i * 0.35 + 0.2);
    }
    setTimeout(() => void ctx.close().catch(() => undefined), 1500);
  } catch {
    // Audio is blocked until the user has interacted with the page; the notification and the banner remain.
  }
}

export function notify(title: string, body: string): boolean {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    new Notification(title, { body, requireInteraction: true, tag: 'xmrswap-connection' });
    return true;
  } catch {
    return false;
  }
}

/** Ask for notification permission. Called from the confirmation before locking, where the reason is on screen. */
export async function requestNotifications(): Promise<'granted' | 'denied' | 'default' | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function browserGuardEnv(): GuardEnv {
  return { window, document, wakeLock: (navigator as Navigator & { wakeLock?: GuardEnv['wakeLock'] }).wakeLock, beep, notify };
}
