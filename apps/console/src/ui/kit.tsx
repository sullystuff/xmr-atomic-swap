/** Small presentational pieces shared by every page. */
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ChainName } from '@xmrswap/protocol';
import { describeError } from '../api/client.js';
import { useChainNow, useNow, type Query } from '../api/hooks.js';
import { fmtDuration, fmtTime, shortId } from '../lib/format.js';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'plain';

export function Badge({ tone = 'plain', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge${tone === 'plain' ? '' : ` ${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function Button({
  variant = 'default',
  small,
  busy,
  children,
  ...rest
}: { variant?: 'default' | 'primary' | 'danger' | 'ghost'; small?: boolean; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['btn', variant === 'default' ? '' : variant, small ? 'sm' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" {...rest} className={cls} disabled={rest.disabled === true || busy === true} aria-busy={busy === true ? true : undefined}>
      {children}
    </button>
  );
}

/** A button that asks once more, in place, before it acts. Escape or Cancel backs out. */
export function ConfirmButton({
  label,
  confirmLabel,
  children,
  onConfirm,
  variant = 'default',
  small,
  busy,
  disabled,
}: {
  label: string;
  /** Defaults to `label`. */
  confirmLabel?: string;
  /** What will happen, in plain words. */
  children: ReactNode;
  onConfirm: () => void;
  variant?: 'default' | 'primary' | 'danger';
  small?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <Button variant={variant} small={small === true} busy={busy === true} disabled={disabled === true} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span
      className="confirm"
      role="alertdialog"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <strong id={`${id}-t`}>{label}?</strong>
      <span id={`${id}-d`}>{children}</span>
      <span className="row">
        <button
          type="button"
          ref={confirmRef}
          className={`btn sm ${variant === 'default' ? 'primary' : variant}`}
          onClick={() => {
            setOpen(false);
            onConfirm();
          }}
        >
          {confirmLabel ?? label}
        </button>
        <Button small onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
    </span>
  );
}

export function Card({ title, note, actions, children, flush, id }: { title: string; note?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; id?: string }) {
  const hid = useId();
  return (
    <section className="card" aria-labelledby={hid} id={id}>
      <div className="card-head">
        <div>
          <h2 id={hid}>{title}</h2>
          {note ? <p>{note}</p> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {children ? <p>{children}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, alert }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; title?: string; children?: ReactNode; alert?: boolean }) {
  return (
    <div className={`notice ${tone}`} role={alert || tone === 'bad' ? 'alert' : 'note'}>
      {title ? <strong>{title} </strong> : null}
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode | undefined; tone?: 'bad' | 'warn' | undefined }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>
        {value}
        {hint ? <span className="hint">{hint}</span> : null}
      </dd>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={`Loading ${what}`}>
      <span />
      <span />
      <span />
    </div>
  );
}

export function ErrorBlock({ what, error, retry }: { what: string; error: unknown; retry?: () => void }) {
  return (
    <div className="card-body">
      <Notice tone="bad" title={`Could not load ${what}.`}>
        {describeError(error)}
        {retry ? (
          <span style={{ marginLeft: 8 }}>
            <Button small onClick={retry}>
              Try again
            </Button>
          </span>
        ) : null}
      </Notice>
    </div>
  );
}

/** Loading, error and data states of one query. Stale data stays visible under a failed refresh. */
export function Async<T>({ query, what, children }: { query: Query<T>; what: string; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) {
    return (
      <>
        {query.error ? (
          <div className="card-body">
            <Notice tone="warn" title="Showing the last data received.">
              {describeError(query.error)}{' '}
              <Button small onClick={query.reload}>
                Try again
              </Button>
            </Notice>
          </div>
        ) : null}
        {children(query.data)}
      </>
    );
  }
  if (query.error) return <ErrorBlock what={what} error={query.error} retry={query.reload} />;
  return <Loading what={what} />;
}

/** An address, key or hash: shortened, with the full value on hover and for screen readers. */
export function Id({ value, head = 6, tail = 4 }: { value: string | null | undefined; head?: number; tail?: number }) {
  if (!value) return <span className="muted">none</span>;
  return (
    <code title={value} aria-label={value}>
      {shortId(value, head, tail)}
    </code>
  );
}

/** Time left until a deadline, on the chain's clock when a chain is given. */
export function Countdown({ to, chain, urgentBelow = 60, soonBelow = 600, passed = 'passed' }: { to: number | null | undefined; chain?: ChainName; urgentBelow?: number; soonBelow?: number; passed?: string }) {
  const local = useNow();
  const chainNow = useChainNow();
  if (to === null || to === undefined) return <span className="muted">n/a</span>;
  const now = chain ? chainNow(chain) : local;
  const left = to - now;
  if (left <= 0) return <span className="countdown muted">{passed}</span>;
  const cls = left <= urgentBelow ? 'countdown urgent' : left <= soonBelow ? 'countdown soon' : 'countdown';
  return (
    <span className={cls} title={fmtTime(to)}>
      {fmtDuration(left)}
    </span>
  );
}

export function Time({ at }: { at: number | null | undefined }) {
  const now = useNow();
  if (at === null || at === undefined) return <span className="muted">n/a</span>;
  const ago = now - at;
  const rel = ago >= 0 ? `${fmtDuration(ago)} ago` : `in ${fmtDuration(-ago)}`;
  return <span title={fmtTime(at)}>{rel}</span>;
}

export function Switch({ label, checked, onChange, disabled, describedBy, hideLabel }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; describedBy?: string; hideLabel?: boolean }) {
  const id = useId();
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-label={hideLabel ? label : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      {hideLabel ? null : <label htmlFor={id}>{label}</label>}
    </span>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`meter${value > max ? ' bad' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
