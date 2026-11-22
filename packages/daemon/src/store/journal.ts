/**
 * The intent journal (SPEC 1.5, 7.4): every external action is a row written BEFORE the action,
 * moved to `sent` with its transaction id BEFORE the bytes leave the process, and resolved
 * afterwards. A row left `planned` by a crash means nothing was broadcast; a row left `sent`
 * is resolved by looking the id up, never by sending again.
 *
 * `crash` is the test seam: it is called at every point where the process could die, and the
 * crash-recovery tests throw from it to cut the run at that exact point.
 */
import type { OnSigned } from '../chains/types.js';
import type { IntentKind, IntentRow, Store } from './db.js';

export class CrashError extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashError';
  }
}
export type CrashHook = (point: string, intent: { id: number; kind: IntentKind; payload: Record<string, unknown> }) => void;

export class Journal {
  constructor(
    readonly store: Store,
    public crash: CrashHook = () => {},
  ) {}

  /**
   * Run one broadcast under an intent row. `send` receives the hook to call with the
   * transaction id after signing and before broadcasting. Resolves once the bytes were handed
   * to the network: the row is then `sent`, and the caller resolves it later through `resolve`.
   * A refusal before signing marks the row `failed` and rethrows.
   */
  async broadcast(kind: IntentKind, swapRef: string | null, payload: Record<string, unknown>, send: (onSigned: OnSigned) => Promise<string | null>): Promise<{ id: number; tx: string | null }> {
    const id = this.store.planIntent(kind, swapRef, payload);
    const ref = { id, kind, payload };
    this.crash('planned', ref);
    let tx: string | null;
    try {
      tx = await send((signedTx, meta) => {
        this.store.setIntent(id, 'sent', { tx: signedTx, meta });
        this.crash('signed', ref);
      });
    } catch (e) {
      if (e instanceof CrashError) throw e;
      const row = this.store.intent(id)!;
      // Still `planned`: nothing was signed, so nothing can have left. `sent`: the outcome is
      // unknown until the id is looked up; leave the row for `resolve`.
      if (row.status === 'planned') this.store.setIntent(id, 'failed', { error: (e as Error).message });
      throw e;
    }
    if (tx === null) {
      this.store.setIntent(id, 'confirmed', { meta: { noop: true } });
      return { id, tx };
    }
    if (this.store.intent(id)!.status === 'planned') this.store.setIntent(id, 'sent', { tx });
    this.crash('sent', ref);
    return { id, tx };
  }

  /** A local (non-chain) action with a result worth keeping: plan, act, record. */
  async act<T>(kind: IntentKind, swapRef: string | null, payload: Record<string, unknown>, action: () => Promise<T>, commit: (result: T, id: number) => { tx?: string | null; meta?: Record<string, unknown> }): Promise<T> {
    const id = this.store.planIntent(kind, swapRef, payload);
    const ref = { id, kind, payload };
    this.crash('planned', ref);
    let result: T;
    try {
      result = await action();
    } catch (e) {
      if (e instanceof CrashError) throw e;
      this.store.setIntent(id, 'failed', { error: (e as Error).message });
      throw e;
    }
    this.crash('acted', ref);
    this.store.tx(() => {
      const patch = commit(result, id);
      this.store.setIntent(id, 'confirmed', patch);
    });
    this.crash('confirmed', ref);
    return result;
  }

  resolve(intent: IntentRow, status: 'confirmed' | 'failed' | 'needs_review', error?: string): void {
    this.store.setIntent(intent.id, status, error ? { error } : {});
  }
  open(swapRef?: string): IntentRow[] {
    return this.store.intents({ ...(swapRef ? { swapRef } : {}), status: ['planned', 'sent'] });
  }
}
