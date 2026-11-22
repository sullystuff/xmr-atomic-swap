/** The component vocabulary: one button shape, one notice shape, one way to show an amount or an address. */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { formatClock, shorten } from '../lib/format.js';

type IconName = 'warn' | 'danger' | 'safe' | 'info' | 'copy' | 'check' | 'lock' | 'arrow' | 'external';
const PATHS: Record<IconName, ReactNode> = {
  warn: <path d="M12 3 2.5 20h19L12 3Zm0 6v5m0 3v.5" />,
  danger: <path d="M12 2.5 21.5 12 12 21.5 2.5 12 12 2.5Zm0 5.5v5m0 3v.5" />,
  safe: <path d="M12 2.5 20 5.5v6c0 5-3.4 8.6-8 10-4.600-1.400-8-5-8-10v-6l8-3Zm-3.500 9.500 2.500 2.500 4.500-5" />,
  info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9v.5" />,
  copy: <path d="M9 9h10v11H9V9Zm-4 6V4h10" />,
  check: <path d="m5 12.500 4.500 4.500L19 7.500" />,
  lock: <path d="M6 10.500h12V20H6v-9.500Zm2.500 0V8a3.500 3.500 0 0 1 7 0v2.500" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  external: <path d="M14 5h5v5m0-5-8 8M11 6H5v13h13v-6" />,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

export function Notice({ kind = 'info', title, children, role, id }: { kind?: 'info' | 'warn' | 'danger' | 'safe'; title: ReactNode; children?: ReactNode; role?: 'alert' | 'status'; id?: string }) {
  const cls = kind === 'info' ? 'notice' : `notice notice-${kind}`;
  return (
    <div className={cls} role={role} id={id} data-kind={kind}>
      <Icon name={kind === 'info' ? 'info' : kind} />
      <div className="notice-title">{title}</div>
      {children ? <div className="notice-body">{children}</div> : null}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null | undefined; children: (p: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': boolean }) => ReactNode }) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label className="label mb-1.5" htmlFor={id}>
        {label}
      </label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': !!error })}
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-err`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A long identifier: shortened on screen, full in the title, one click to copy. */
export function Copyable({ value, label, full = false }: { value: string; label: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 align-middle">
      <code className={full ? 'break-all' : 'truncate'} title={value}>
        {full ? value : shorten(value, 8, 6)}
      </code>
      <button
        type="button"
        className="btn btn-quiet btn-sm shrink-0 !min-h-0 !p-1"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
    </span>
  );
}

/** A countdown to a chain second. Announces itself to screen readers at whole minutes, not every second. */
export function Countdown({ to, now, className = 'num' }: { to: bigint; now: bigint | null; className?: string }) {
  if (now === null) return <span className={className}>--:--</span>;
  const left = Math.max(0, Number(to - now));
  return (
    <span className={className} role="timer" aria-live="off" data-seconds-left={left}>
      {formatClock(left)}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 muted" role="status">
      <span className="skeleton inline-block h-3 w-3 !rounded-full" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel px-5 py-8 text-center">
      <h2 className="mb-2">{title}</h2>
      <div className="muted prose-w mx-auto">{children}</div>
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="panel p-4 grid gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_x, i) => (
        <div key={i} className="skeleton h-12" />
      ))}
    </div>
  );
}

/** A modal that fills the viewport (the confirmation before locking). Native `<dialog>`: focus is trapped and Escape closes it. */
export function FullscreenDialog({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="fullscreen" aria-labelledby={labelledBy} onClose={onClose} onCancel={onClose}>
      {open ? children : null}
    </dialog>
  );
}

export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
