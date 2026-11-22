/** "Checking it works": what the page can reach, whether the Monero nodes agree, and whether the contracts can still be upgraded. */
import { useEffect, useState } from 'react';
import { type Check, runStatus } from '../lib/status.js';
import { href, useApp, useEngine, useGuard, useObs } from '../ui/hooks.js';
import { Icon, Notice, SkeletonRows } from '../ui/kit.js';

const STATE_TEXT = { ok: 'OK', warn: 'Attention', fail: 'Problem', off: 'Off' } as const;

export function StatusPage() {
  const app = useApp();
  const settings = useObs(app.settings);
  const registry = useObs(app.registry);
  const engine = useEngine();
  const guard = useGuard();
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    void app
      .refreshUpgrade()
      .then(() => runStatus(app))
      .then(
        (c) => {
          setChecks(c);
          setBusy(false);
        },
        () => setBusy(false),
      );
  };
  useEffect(run, [app, settings, registry.snapshot === null]);
  const failing = checks?.filter((c) => c.state === 'fail') ?? [];
  const notif = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  return (
    <div className="grid gap-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-2">
          <h1>Status</h1>
          <p className="muted prose-w">Everything below is checked from this page, in your browser. Nothing is reported to the site.</p>
        </div>
        <button type="button" className="btn" onClick={run} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </header>

      {checks === null ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          {failing.length === 0 ? <Notice kind="safe" title="Everything needed for a swap is reachable" role="status" /> : <Notice kind="danger" title={`${failing.length} problem${failing.length === 1 ? '' : 's'} to fix before swapping`} role="alert">Locks stay disabled while Solana or the Monero nodes cannot be checked. <a href={href('settings')}>Open Settings</a>.</Notice>}
          <ul className="panel m-0 list-none divide-y divide-line p-0" aria-label="Checks">
            {checks.map((c) => (
              <li key={c.id} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-4" data-testid={`check-${c.id}`} data-state={c.state}>
                <span className={c.state === 'ok' ? 'pill pill-safe' : c.state === 'fail' ? 'pill pill-risk' : c.state === 'warn' ? 'pill pill-warn' : 'pill'}>
                  {c.state === 'ok' ? <Icon name="check" size={14} /> : null}
                  {STATE_TEXT[c.state]}
                </span>
                <span className="font-semibold">{c.label}</span>
                <span className="col-start-2 text-sm muted break-words">{c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <section className="grid gap-3" aria-labelledby="this-h">
        <h2 id="this-h">This browser</h2>
        <dl className="kv">
          <dt>Keep the screen on</dt>
          <dd>{'wakeLock' in navigator ? (guard.wakeLock === 'held' ? 'Held now' : 'Supported; requested while a swap is at risk') : 'Not supported here. Turn off sleep yourself during a swap, or use a desktop browser.'}</dd>
          <dt>Notifications</dt>
          <dd>{notif === 'granted' ? 'Allowed: a dropped connection during a swap raises one' : notif === 'denied' ? 'Blocked. A dropped connection can only sound the alarm in this tab; allow notifications in the browser\'s site settings.' : notif === 'unsupported' ? 'Not supported here' : 'Not asked yet; the page asks when you lock'}</dd>
          <dt>Clock</dt>
          <dd>{engine.skewSecs === null ? 'Chain time not read yet' : Math.abs(engine.skewSecs) <= 30 ? 'Within 30 seconds of the chain' : `${Math.abs(engine.skewSecs)} s ${engine.skewSecs > 0 ? 'ahead of' : 'behind'} the chain. Deadlines here use the chain's clock.`}</dd>
          <dt>Program id</dt>
          <dd>
            <code className="break-all">{settings.programId}</code>
          </dd>
          <dt>Ethereum contract</dt>
          <dd>{settings.contract ? <code className="break-all">{settings.contract}</code> : 'Not set'}</dd>
        </dl>
      </section>

      {registry.snapshot && registry.snapshot.discarded.length > 0 ? (
        <section className="grid gap-2" aria-labelledby="disc-h">
          <h2 id="disc-h">Ethereum quotes not shown</h2>
          <p className="muted text-sm">A quote is listed only if it is signed by the operator registered in the Ethereum contract and its maker is linked both ways.</p>
          <ul className="grid gap-1 text-sm">
            {registry.snapshot.discarded.map((d, i) => (
              <li key={i}>
                Maker <code>{d.maker.slice(0, 8)}…</code>, slot {d.slot}: {d.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
