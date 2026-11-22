/**
 * The recovery file step (SPEC 8.4, 8.5 item 2). Until the file is downloaded and the user has
 * confirmed it is saved, every lock button on the site stays disabled.
 */
import { useRef, useState } from 'react';
import { downloadText } from '../lib/vault.js';
import { useApp, useVault } from './hooks.js';
import { Field, Icon, Notice } from './kit.js';

export const BACKUP_REASON = 'Save your recovery file first. Without it, a closed tab or a lost browser means the refund and the XMR are both out of reach and your funds are lost.';

function LoadFile({ onDone }: { onDone?: () => void }) {
  const app = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [needsPass, setNeedsPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const open = (content: string, passphrase?: string) => {
    try {
      const r = app.vault.load(content, passphrase);
      setError(null);
      setWarning(r.warning);
      setText(null);
      setNeedsPass(false);
      onDone?.();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/passphrase/i.test(m) && !passphrase) {
        setNeedsPass(true);
        setText(content);
        setError(null);
      } else setError(m);
    }
  };
  return (
    <div className="grid gap-3">
      <Field label="Recovery file" hint="The file named xmrswap-recovery….json that you saved before your first swap." error={error}>
        {(p) => (
          <input
            {...p}
            ref={input}
            className="input"
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then((t) => open(t));
            }}
          />
        )}
      </Field>
      {needsPass && text ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            open(text, pass);
          }}
        >
          <Field label="Passphrase of this file">{(p) => <input {...p} className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />}</Field>
          <button className="btn" type="submit" disabled={!pass}>
            Open the file
          </button>
        </form>
      ) : null}
      {warning ? <Notice kind="warn" title={warning} /> : null}
    </div>
  );
}

function Unlock() {
  const app = useApp();
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        // Let the "Unlocking" state paint before the key derivation (about a second) blocks the thread.
        setTimeout(() => {
          app.vault.unlock(pass).then(
            () => setBusy(false),
            (err: unknown) => {
              setBusy(false);
              setError(err instanceof Error ? err.message : String(err));
            },
          );
        }, 30);
      }}
    >
      <Field label="Passphrase for the seed stored on this device" error={error}>
        {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
      </Field>
      <button className="btn btn-primary" type="submit" disabled={!pass || busy}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  );
}

export function BackupStep({ heading = 'Save your recovery file' }: { heading?: string }) {
  const app = useApp();
  const vault = useVault();
  const [mode, setMode] = useState<'choose' | 'load'>('choose');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = () => {
    setBusy(true);
    setError(null);
    setTimeout(() => {
      try {
        const text = app.vault.fileText(pass || undefined);
        downloadText(`xmrswap-recovery-${vault.tag ?? 'file'}.json`, text);
        app.vault.markDownloaded();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }, 30);
  };

  if (vault.backedUp)
    return (
      <section aria-labelledby="backup-h" className="grid gap-2" data-testid="backup" data-state="saved">
        <h2 id="backup-h">{heading}</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="pill pill-safe">
            <Icon name="check" size={14} /> Saved
          </span>
          <span className="muted">
            One file covers every swap. Fingerprint <code>{vault.tag}</code>.
          </span>
          <button type="button" className="btn btn-quiet btn-sm" onClick={download} disabled={busy}>
            Download again
          </button>
        </p>
      </section>
    );

  return (
    <section aria-labelledby="backup-h" className="grid gap-4" data-testid="backup" data-state={vault.unlocked ? (vault.downloaded ? 'downloaded' : 'created') : 'none'}>
      <div className="grid gap-1">
        <h2 id="backup-h">{heading}</h2>
        <p className="muted prose-w">
          The keys for your swaps are made in this page and exist nowhere else. This one file restores all of them. If you lose both this browser and the file while a swap is open, neither the refund nor the XMR can be reached and your funds are
          lost. Locking stays disabled until the file is saved.
        </p>
      </div>
      {!vault.unlocked ? (
        vault.sealedOnDevice && mode === 'choose' ? (
          <div className="grid gap-4 max-w-md">
            <Unlock />
            <button type="button" className="btn btn-quiet btn-sm justify-self-start" onClick={() => setMode('load')}>
              Load a recovery file instead
            </button>
          </div>
        ) : mode === 'load' ? (
          <div className="grid gap-3 max-w-md">
            <LoadFile />
            <button type="button" className="btn btn-quiet btn-sm justify-self-start" onClick={() => setMode('choose')}>
              Back
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary" onClick={() => app.vault.create()}>
              Create a recovery file
            </button>
            <button type="button" className="btn" onClick={() => setMode('load')}>
              I already have one
            </button>
          </div>
        )
      ) : (
        <div className="grid gap-4 max-w-xl">
          <Field label="Passphrase for the file (optional)" hint="If set, the file is useless without it. If you forget it, the file cannot be opened by anyone and funds in an open swap can be lost." error={error}>
            {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={vault.downloaded ? 'btn' : 'btn btn-primary'} onClick={download} disabled={busy}>
              {busy ? 'Preparing the file…' : vault.downloaded ? 'Download again' : 'Download recovery file'}
            </button>
            {vault.downloaded ? <span className="muted text-sm">Downloaded. Check that it is in your downloads folder, then move it somewhere safe.</span> : null}
          </div>
          <label className="check">
            <input type="checkbox" checked={false} disabled={!vault.downloaded} onChange={(e) => app.vault.confirmSaved(e.target.checked)} />
            <span>
              <strong>I saved the recovery file somewhere I will not lose it.</strong>
              <span className="block muted text-sm">{vault.downloaded ? 'Without it, a closed tab or a lost browser can cost you the funds in an open swap.' : 'Download the file first.'}</span>
            </span>
          </label>
        </div>
      )}
    </section>
  );
}

/** Settings: keep a sealed copy on this device, or remove the seed from this browser. */
export function VaultSettings() {
  const app = useApp();
  const vault = useVault();
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!vault.unlocked) return null;
  return (
    <div className="grid gap-4 max-w-xl">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setTimeout(() => {
            app.vault.remember(pass).then(
              () => {
                setMsg('A sealed copy is stored on this device. After the browser is closed, type the passphrase to resume.');
                setPass('');
              },
              (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
            );
          }, 30);
        }}
      >
        <Field
          label={vault.sealedOnDevice ? 'Change the device passphrase' : 'Remember the seed on this device'}
          hint="The seed is sealed under this passphrase in this browser's storage, so a reopened browser can resume open swaps after you type it. A reload of this tab resumes without it."
          error={error}
        >
          {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
        </Field>
        <button type="submit" className="btn justify-self-start" disabled={pass.length < 8}>
          {vault.sealedOnDevice ? 'Replace the sealed copy' : 'Store a sealed copy'}
        </button>
        {msg ? (
          <p className="text-sm text-safe-text" role="status">
            {msg}
          </p>
        ) : null}
      </form>
      <div>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (window.confirm('Remove the seed from this browser? The recovery file will be the only copy. If a swap is open and you do not have the file, its funds are lost.')) void app.vault.forget();
          }}
        >
          Remove the seed from this browser
        </button>
      </div>
    </div>
  );
}

export { LoadFile };
