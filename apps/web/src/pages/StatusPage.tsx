/** "Checking it works": what the page can reach, whether the Monero nodes agree, and whether the contracts can still be upgraded. */
import { PROGRAM_HASH, PROGRAM_ID } from '@xmrswap/protocol';
import { useEffect, useState } from 'react';
import { type Check, runStatus } from '../lib/status.js';
import { href, useApp, useEngine, useGuard, useObs } from '../ui/hooks.js';
import { Icon, Notice, SkeletonRows } from '../ui/kit.js';

const STATE_TEXT = { ok: 'OK', warn: 'Attention', fail: 'Problem', off: 'Off' } as const;

/**
 * Which build this is (SPEC 11.5). Two different things are kept apart: what the serving bundle
 * says about its own files (`/release.json`: a claim, with the way to check it), and what this
 * page checked itself (the deployed program's hash against the build it expects).
 */
export function ReleasePanel() {
  const app = useApp();
  const settings = useObs(app.settings);
  const served = useObs(app.release);
  const build = useObs(app.programBuild);
  const r = served.record?.release ?? null;
  const expected = PROGRAM_HASH;
  return (
    <section className="grid gap-4" aria-labelledby="rel-h" data-testid="release">
      <div className="grid gap-1">
        <h2 id="rel-h">This build</h2>
        <p className="muted prose-w">What the server says about the files it sent you, next to what this page expects and what it could check itself. A server describing itself proves nothing; the commands below are how you check.</p>
      </div>
      {!served.loaded ? (
        <SkeletonRows rows={2} />
      ) : served.record === null ? (
        <Notice kind="info" title="No release record" id="release-none">
          The server that sent this page provides no <code>release.json</code>, so it does not say which build these files are. Compare the files with a published release yourself before trusting them with funds.
        </Notice>
      ) : r === null ? (
        <Notice kind="warn" title="These files match no recorded release" id="release-unrecorded">
          The server reports a tree hash of <code className="break-all">{served.record.ui.tree_hash}</code> for the files it serves, and has no release record with that hash. They may be a local or modified build.
        </Notice>
      ) : (
        <>
          {r.status === 'development-snapshot' ? (
            <Notice kind="warn" title="Development snapshot" id="release-dev">
              This is a development snapshot, not a release: it was built from an in-progress commit, nothing is deployed for it, and its hashes are for checking the build only.{r.program_hash_source === 'local' ? ' Its program hash comes from a local build, not from the reproducible Docker build.' : ''}
            </Notice>
          ) : null}
          <dl className="kv kv-wide">
            <dt>Version</dt>
            <dd>
              {r.version} <span className="pill">{r.status === 'release' ? 'release' : 'development snapshot'}</span>
            </dd>
            <dt>Commit</dt>
            <dd>
              <code className="break-all">{r.commit}</code>
              {r.commit_time ? ` (${r.commit_time})` : ''}
            </dd>
            <dt>UI tree hash</dt>
            <dd>
              <code className="break-all">{served.record.ui.tree_hash}</code>
              <span className="block text-sm muted">
                As reported by the server for the {served.record.ui.files} files it serves. {r.web_tree_hash === served.record.ui.tree_hash ? 'It is the hash this release records.' : `The release records ${r.web_tree_hash}: they differ.`} Not checked by this page.
              </span>
            </dd>
            <dt>Program id</dt>
            <dd>
              <code className="break-all">{r.program_id}</code>
              <span className={`block text-sm ${r.program_id === settings.programId ? 'muted' : 'text-danger-text font-semibold'}`}>
                {r.program_id === settings.programId ? 'The same id this page is set to use.' : `This page is set to use ${settings.programId}: they differ. Do not swap until you know why.`}
                {settings.programId === PROGRAM_ID ? ' It is the id pinned in this code.' : ` The id pinned in this code is ${PROGRAM_ID}.`}
              </span>
            </dd>
            <dt>Program executable hash (release)</dt>
            <dd>
              <code className="break-all">{r.program_executable_hash}</code>
              <span className="block text-sm muted">From the {r.program_hash_source === 'docker' ? 'reproducible Docker build' : 'local build (not a reproducibility proof)'}.</span>
            </dd>
          </dl>
        </>
      )}
      <dl className="kv kv-wide">
        <dt>Hash this page expects</dt>
        <dd>{expected ? <code className="break-all">{expected}</code> : 'None: no published build is pinned in this code yet.'}</dd>
        <dt>Hash of the deployed program</dt>
        <dd data-testid="program-build" data-status={build?.status ?? 'none'}>
          {build === null ? (
            'Not read: no Solana RPC is configured.'
          ) : build.status === 'unread' ? (
            <span className="text-danger-text font-semibold">Could not be read from the chain. The page cannot tell whether the deployed program is the published build.</span>
          ) : (
            <>
              <code className="break-all">{build.hash}</code>
              <span className={`block text-sm ${build.status === 'mismatch' ? 'text-danger-text font-semibold' : 'muted'}`}>
                {build.status === 'match'
                  ? 'Computed by this page from the chain: it matches the published build.'
                  : build.status === 'mismatch'
                    ? 'Computed by this page from the chain: it is NOT the build this page expects. The page and the chain disagree, so locking is disabled.'
                    : `Computed by this page from the chain. There is no published build to compare with${r ? `; the release record above lists ${r.program_executable_hash === build.hash ? 'the same hash' : 'a different hash, as expected when nothing is deployed from it'}` : ''}.`}
              </span>
            </>
          )}
        </dd>
      </dl>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">How to check this yourself</summary>
        <div className="mt-2 grid gap-2 text-sm">
          <p>The files of a release, against its record (run in a checkout of the repository):</p>
          <pre className="panel overflow-x-auto p-3"><code>pnpm --filter @xmrswap/deploy run verify {'<release directory>'}</code></pre>
          <p>The deployed program, against the source at the release's commit:</p>
          <pre className="panel overflow-x-auto p-3"><code>{`solana-verify get-program-hash ${settings.programId}
solana-verify verify-from-repo --program-id ${settings.programId} <repository URL> --commit-hash ${r?.commit ?? '<commit>'} --library-name xmr_swap --mount-path solana/program`}</code></pre>
        </div>
      </details>
    </section>
  );
}

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

      <ReleasePanel />

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
