/** Settings (SPEC 8.2): endpoints, Monero nodes, connection mode with what each reveals, pinned ids shown for checking, the recovery file. */
import type { MoneroNetwork } from '@xmrswap/protocol';
import { useState } from 'react';
import { type ConnectionMode, MODE_INFO, type Settings, type ThemeChoice, overriddenKeys, settingsProblems } from '../lib/settings.js';
import { WATCHER_CAN, WATCHER_SEES } from '../lib/watcher.js';
import { BackupStep, LoadFile, VaultSettings } from '../ui/Backup.js';
import { href, useApp, useObs, useVault } from '../ui/hooks.js';
import { Field, Notice, Segmented } from '../ui/kit.js';

const MODES: readonly ConnectionMode[] = ['hosted', 'self-hosted', 'tor-direct', 'onchain'];

export function SettingsPage() {
  const app = useApp();
  const saved = useObs(app.settings);
  const vault = useVault();
  const [draft, setDraft] = useState<Settings>(saved);
  const [nodesText, setNodesText] = useState(saved.moneroNodes.join('\n'));
  const [done, setDone] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const next: Settings = { ...draft, moneroNodes: nodesText.split('\n').map((n) => n.trim()).filter(Boolean) };
  const problems = settingsProblems(next);
  const err = (f: keyof Settings) => problems.find((p) => p.field === f)?.message ?? null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setDone(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  // The site's own values (its config.json over the built-in defaults) and what this browser overrides.
  const site = app.siteSettings();
  const local = overriddenKeys(next, site);
  const show = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === '' ? 'not set' : String(v));
  /** A field's hint, plus a marker when its value is a local override, with the site's value and a way back to it. */
  const hint = (k: keyof Settings, text?: React.ReactNode) =>
    !text && !local.includes(k) ? undefined : (
    <>
      {text}
      {local.includes(k) ? (
        <span className="mt-1 block" data-testid={`override-${k}`}>
          <span className="pill pill-accent">Changed in this browser</span> Site default: <code className="break-all">{show(site[k])}</code>.{' '}
          <button
            type="button"
            className="btn btn-quiet btn-sm !min-h-0 !p-1 underline"
            onClick={() => {
              setDone(false);
              setDraft((d) => ({ ...d, [k]: site[k] }));
              if (k === 'moneroNodes') setNodesText(site.moneroNodes.join('\n'));
            }}
          >
            Use the site's value
          </button>
        </span>
      ) : null}
    </>
    );

  return (
    <div className="grid gap-10">
      <header className="grid gap-2">
        <h1>Settings</h1>
        <p className="muted prose-w">These stay in this browser. The site ships no hidden defaults for the Solana RPC or the Monero nodes, because whoever runs them sees your queries and can lie about what is on-chain.</p>
      </header>

      <form
        className="grid gap-10"
        onSubmit={(e) => {
          e.preventDefault();
          app.setSettings(next);
          setDone(true);
        }}
      >
        <section className="grid max-w-2xl gap-5" aria-labelledby="chains-h">
          <h2 id="chains-h">Chains</h2>
          <Field label="Solana RPC URL" hint={hint('solanaRpc', 'Reads the registry and submits transactions. Your own node, or a provider that then sees your queries and transactions. It must allow listing program accounts.')} error={err('solanaRpc')}>
            {(p) => <input {...p} className="input mono" type="url" inputMode="url" spellCheck={false} value={draft.solanaRpc} onChange={(e) => set('solanaRpc', e.target.value.trim())} />}
          </Field>
          <Field label="Ethereum RPC URL (optional)" hint={hint('ethereumRpc', 'Leave empty to switch the ETH and USDC-on-Ethereum markets off.')} error={err('ethereumRpc')}>
            {(p) => <input {...p} className="input mono" type="url" inputMode="url" spellCheck={false} value={draft.ethereumRpc} onChange={(e) => set('ethereumRpc', e.target.value.trim())} />}
          </Field>
        </section>

        <section className="grid max-w-2xl gap-5" aria-labelledby="xmr-h">
          <div className="grid gap-1">
            <h2 id="xmr-h">Monero nodes</h2>
            <p className="muted">The page checks every XMR lock against all of these and treats any disagreement or silence as "not confirmed". A single dishonest node could fake a lock and cost you your payment, so use two or more run by different people, or one of your own.</p>
          </div>
          <Field label="Node URLs, one per line" hint={hint('moneroNodes', "The first node is the one the final sweep is sent through: put the one you trust most first. An HTTPS page can only call https:// nodes, localhost, or the relay's Monero proxy on this site (a path such as /monero/0).")} error={err('moneroNodes')}>
            {(p) => <textarea {...p} className="textarea mono" rows={3} spellCheck={false} value={nodesText} onChange={(e) => (setDone(false), setNodesText(e.target.value))} />}
          </Field>
          <label className="check">
            <input type="checkbox" checked={draft.ownNode} onChange={(e) => set('ownNode', e.target.checked)} />
            <span>
              <strong>This is my own node</strong>
              <span className="block text-sm muted">Only tick this for a single node that you run yourself. Two proxies run by one operator are one source, not two.</span>
            </span>
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Monero network">
              {(p) => (
                <select {...p} className="select" value={draft.moneroNetwork} onChange={(e) => set('moneroNetwork', e.target.value as MoneroNetwork)}>
                  <option value="mainnet">Mainnet</option>
                  <option value="stagenet">Stagenet</option>
                  <option value="testnet">Testnet</option>
                  <option value="regtest">Regtest (testing only)</option>
                </select>
              )}
            </Field>
            <Field label="My minimum confirmations" hint="0 uses the protocol's tiers: 2 below 1 XMR, 10 below 50, 25 above. Offers below your minimum show a warning.">
              {(p) => <input {...p} className="input input-num" inputMode="numeric" value={String(draft.minDepth)} onChange={(e) => set('minDepth', Math.max(0, Math.min(255, Number(e.target.value.replace(/\D/g, '')) || 0)))} />}
            </Field>
          </div>
        </section>

        <section className="grid gap-5" aria-labelledby="mode-h">
          <div className="grid max-w-2xl gap-1">
            <h2 id="mode-h">Connection mode</h2>
            <p className="muted">How encrypted messages reach makers. In every mode your Solana RPC provider sees your on-chain queries and transactions unless you run your own node. Refunds never depend on the relay: they go from this page straight to the chain.</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2" role="radiogroup" aria-labelledby="mode-h">
            {MODES.map((m) => (
              <label key={m} className="check">
                <input type="radio" name="mode" checked={draft.mode === m} onChange={() => set('mode', m)} />
                <span className="grid gap-1">
                  <strong>{MODE_INFO[m].label}</strong>
                  <span className="text-sm">
                    <span className="faint">Relay run by:</span> {MODE_INFO[m].relay}
                  </span>
                  <span className="text-sm">
                    <span className="faint">Who learns your IP:</span> {MODE_INFO[m].learnsIp}
                  </span>
                  <span className="text-sm muted">{MODE_INFO[m].note}</span>
                </span>
              </label>
            ))}
          </div>
          {local.includes('mode') ? <p className="text-sm muted">{hint('mode')}</p> : null}
          {draft.mode === 'hosted' || draft.mode === 'self-hosted' ? (
            <div className="max-w-2xl">
              <Field
                label="Relay URL"
                hint={
                  <>
                    A URL, or a path on this site such as <code>/</code> when the relay is served from the same origin. A relay on another origin (another port counts) sends no CORS headers by default: start it with <code>RELAY_ALLOWED_ORIGINS</code> set to this page's origin
                    {typeof location !== 'undefined' ? (
                      <>
                        {' '}
                        (<code>{location.origin}</code>)
                      </>
                    ) : null}
                    . Never set it to <code>*</code> on a localhost relay: any page you visit could then use your relay and nodes.
                    {hint('relayUrl')}
                  </>
                }
                error={err('relayUrl')}
              >
                {(p) => <input {...p} className="input mono" spellCheck={false} value={draft.relayUrl} onChange={(e) => set('relayUrl', e.target.value.trim())} />}
              </Field>
            </div>
          ) : null}
        </section>

        <section className="grid max-w-2xl gap-5" aria-labelledby="watch-h">
          <div className="grid gap-1">
            <h2 id="watch-h">Watcher (optional)</h2>
            <p className="muted">
              Off by default: your tab is your watcher. A watcher is a small service that can pause one swap for you if the maker's lock does not check out while your tab is closed. It is offered at the review step, only on offers that allow a pause and only where a pause adds
              time. {WATCHER_SEES} {WATCHER_CAN}
            </p>
          </div>
          {draft.hostedWatcherUrl ? (
            <p className="text-sm">
              This site runs one at <code className="break-all">{draft.hostedWatcherUrl}</code>. Whoever runs it learns what is listed above about each swap you hand it.
            </p>
          ) : (
            <p className="text-sm muted">This site does not run a watcher.</p>
          )}
          <Field label="My own watcher's URL" hint={hint('watcherUrl', 'A watcher you run yourself (the self-hosting bundle documents how). Reached directly over HTTPS, never through the relay.')} error={err('watcherUrl')}>
            {(p) => <input {...p} className="input mono" type="url" inputMode="url" spellCheck={false} value={draft.watcherUrl} onChange={(e) => set('watcherUrl', e.target.value.trim())} />}
          </Field>
          <Field label="Its public key (optional)" hint={hint('watcherKey', 'The Solana key your watcher reports. If you fill this in, a watcher at that URL answering with any other key is refused; left empty, the key it reports is shown to you before you lock.')}>
            {(p) => <input {...p} className="input mono" spellCheck={false} value={draft.watcherKey} onChange={(e) => set('watcherKey', e.target.value.trim())} />}
          </Field>
        </section>

        <section className="grid max-w-2xl gap-5" aria-labelledby="pin-h">
          <div className="grid gap-1">
            <h2 id="pin-h">Program and contract</h2>
            <p className="muted">Pinned by this release. Compare them with the published ones before you swap; a page pointed at another program could take your funds.</p>
          </div>
          <Field label="Solana program id" hint={hint('programId')} error={err('programId')}>
            {(p) => <input {...p} className="input mono" spellCheck={false} value={draft.programId} onChange={(e) => set('programId', e.target.value.trim())} />}
          </Field>
          <div className="grid gap-5 sm:grid-cols-[1fr_10rem]">
            <Field label="Ethereum contract address" hint={hint('contract')} error={err('contract')}>
              {(p) => <input {...p} className="input mono" spellCheck={false} value={draft.contract} onChange={(e) => set('contract', e.target.value.trim())} />}
            </Field>
            <Field label="Chain id">{(p) => <input {...p} className="input input-num" inputMode="numeric" value={String(draft.ethereumChainId)} onChange={(e) => set('ethereumChainId', Number(e.target.value.replace(/\D/g, '')) || 1)} />}</Field>
          </div>
        </section>

        <section className="grid max-w-2xl gap-5" aria-labelledby="ref-h">
          <div className="grid gap-1">
            <h2 id="ref-h">Reference prices</h2>
            <p className="muted">This page fetches no price feed. Type figures from a source you trust to compare rates against; left empty, rates are compared with the median offer.</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="XMR in USD">{(p) => <input {...p} className="input input-num" inputMode="decimal" value={draft.refXmrUsd} onChange={(e) => set('refXmrUsd', e.target.value.trim())} />}</Field>
            <Field label="SOL in USD">{(p) => <input {...p} className="input input-num" inputMode="decimal" value={draft.refSolUsd} onChange={(e) => set('refSolUsd', e.target.value.trim())} />}</Field>
            <Field label="ETH in USD">{(p) => <input {...p} className="input input-num" inputMode="decimal" value={draft.refEthUsd} onChange={(e) => set('refEthUsd', e.target.value.trim())} />}</Field>
          </div>
        </section>

        <section className="grid max-w-2xl gap-5" aria-labelledby="poll-h">
          <h2 id="poll-h">Polling</h2>
          <Field label="Check the chains every (seconds)" hint={hint('pollMs', 'How often this tab re-reads swap state and re-verifies Monero locks. Shorter reacts sooner and sends more requests to your RPC and nodes; a relay with strict rate limits may refuse a very short interval.')}>
            {(p) => <input {...p} className="input input-num" inputMode="numeric" value={String(Math.round(draft.pollMs / 1000))} onChange={(e) => set('pollMs', Math.max(1, Math.min(60, Number(e.target.value.replace(/\D/g, '')) || 1)) * 1000)} />}
          </Field>
        </section>

        <section className="grid gap-3" aria-labelledby="look-h">
          <h2 id="look-h">Appearance</h2>
          <Segmented<ThemeChoice> label="Theme" value={draft.theme} onChange={(t) => (set('theme', t), app.setSettings({ theme: t }))} options={[{ value: 'system', label: 'Match system' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </section>

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg px-4 py-3">
          <button type="submit" className="btn btn-primary" disabled={!dirty}>
            Save settings
          </button>
          <button
            type="button"
            className="btn"
            disabled={app.overridden().length === 0 && local.length === 0}
            onClick={() => {
              app.resetSettings();
              setDraft(app.settings.get());
              setNodesText(app.settings.get().moneroNodes.join('\n'));
              setDone(false);
            }}
          >
            Reset to this site's defaults
          </button>
          <span className="text-sm muted" data-testid="override-count">
            {local.length === 0 ? "Every setting follows this site's defaults." : `${local.length} setting${local.length === 1 ? '' : 's'} changed in this browser; the rest follow this site's defaults.`}
          </span>
          {done ? (
            <span className="text-sm text-safe-text" role="status">
              Saved. <a href={href('status')}>Check the connections on the Status page</a>.
            </span>
          ) : problems.length > 0 ? (
            <span className="text-sm muted">
              {problems.length} thing{problems.length === 1 ? '' : 's'} to fix before swaps can run. You can still save.
            </span>
          ) : null}
        </div>
      </form>

      <hr className="rule" />
      <section className="grid gap-6" aria-label="Recovery file">
        <BackupStep heading="Recovery file" />
        {vault.unlocked ? (
          <>
            <div className="grid gap-2">
              <button type="button" className="btn btn-quiet btn-sm justify-self-start" onClick={() => setShowLoad((s) => !s)} aria-expanded={showLoad}>
                Load a different recovery file
              </button>
              {showLoad ? (
                <div className="grid max-w-md gap-3">
                  <Notice kind="warn" title="This replaces the seed in this browser">
                    Swaps opened with the current seed can then only be resumed with its own file. If you do not have that file, their funds can be lost.
                  </Notice>
                  <LoadFile onDone={() => setShowLoad(false)} />
                </div>
              ) : null}
            </div>
            <VaultSettings />
          </>
        ) : null}
      </section>
    </div>
  );
}
