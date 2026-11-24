/** Form controls for the configuration page, driven by the schema table. */
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import type { ConfigIssue } from '@xmrswap/protocol/daemon-api';
import type { Column, FieldDef, Option, SectionDef } from '../../lib/config/schema.js';
import { getPath, isTable, type Toml } from '../../lib/config/toml.js';
import { issuesAt } from '../../lib/config/validate.js';
import { Button, Switch } from '../../ui/kit.js';

export interface FormState {
  draft: Toml;
  /** Set a dotted path; `undefined` removes the key, so the default applies again. */
  set(path: string, value: unknown): void;
  errors: readonly ConfigIssue[];
  warnings: readonly ConfigIssue[];
  /** Keys of the file this console has no control for. Kept untouched; the daemon judges them. */
  unknown: readonly string[];
}
const FormContext = createContext<FormState | null>(null);
export const FormProvider = FormContext.Provider;
export function useForm(): FormState {
  const f = useContext(FormContext);
  if (!f) throw new Error('no configuration form in context');
  return f;
}

/** Text typed into a number box: a number when it is one, removed when empty, otherwise kept as text so validation reports it. */
export function parseNumberText(text: string): number | string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t;
}

export function NumberInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  describedBy,
  label,
  wide,
}: {
  id?: string;
  value: unknown;
  onChange: (v: number | string | undefined) => void;
  placeholder?: string | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  label?: string | undefined;
  wide?: boolean | undefined;
}) {
  const shown = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    // Follow outside changes (discard, import) unless the maker is mid-edit on the same number.
    if (!focused || parseNumberText(text) !== value) setText(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      className={wide ? 'w-num' : 'w-num'}
      value={text}
      placeholder={placeholder}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNumberText(e.target.value));
      }}
    />
  );
}

function Select({ id, value, options, onChange, invalid, describedBy, label }: { id?: string; value: string; options: readonly Option[]; onChange: (v: string) => void; invalid?: boolean; describedBy?: string; label?: string }) {
  const known = options.some((o) => o.value === value);
  return (
    <select id={id} value={value} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {known ? null : <option value={value}>{value} (not valid)</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** An ordered list of names: the order matters (fallbacks, venue priority). */
export function ListEditor({ label, value, options, onChange, addLabel }: { label: string; value: string[]; options?: readonly Option[]; onChange: (v: string[] | undefined) => void; addLabel?: string }) {
  const [text, setText] = useState('');
  const id = useId();
  const out = (v: string[]): void => onChange(v.length === 0 ? undefined : v);
  const remaining = options?.filter((o) => !value.includes(o.value)) ?? [];
  const labelOf = (v: string): string => options?.find((o) => o.value === v)?.label ?? v;
  const move = (i: number, d: -1 | 1): void => {
    const next = [...value];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    out(next);
  };
  return (
    <div role="group" aria-label={label}>
      {value.length === 0 ? <p className="muted">None.</p> : null}
      <ol className="chips">
        {value.map((v, i) => (
          <li key={`${v}-${i}`}>
            <span className="chip-n">{i + 1}</span>
            <span className={options ? '' : 'mono'} style={{ overflowWrap: 'anywhere' }}>
              {labelOf(v)}
            </span>
            <Button small variant="ghost" disabled={i === 0} aria-label={`Move ${labelOf(v)} up in ${label}`} onClick={() => move(i, -1)}>
              Up
            </Button>
            <Button small variant="ghost" disabled={i === value.length - 1} aria-label={`Move ${labelOf(v)} down in ${label}`} onClick={() => move(i, 1)}>
              Down
            </Button>
            <Button small variant="ghost" aria-label={`Remove ${labelOf(v)} from ${label}`} onClick={() => out(value.filter((_, k) => k !== i))}>
              Remove
            </Button>
          </li>
        ))}
      </ol>
      {options ? (
        remaining.length > 0 ? (
          <select
            aria-label={addLabel ?? `Add to ${label}`}
            value=""
            style={{ marginTop: 4 }}
            onChange={(e) => {
              if (e.target.value) out([...value, e.target.value]);
            }}
          >
            <option value="">Add…</option>
            {remaining.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : null
      ) : (
        <form
          className="row"
          style={{ marginTop: 4 }}
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (t && !value.includes(t)) out([...value, t]);
            setText('');
          }}
        >
          <label className="sr-only" htmlFor={id}>
            {addLabel ?? `Add to ${label}`}
          </label>
          <input id={id} type="text" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
          <button type="submit" className="btn sm" disabled={text.trim() === ''}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

/** An array of small tables, one row each. */
export function RowsEditor({ label, columns, value, onChange, maxRows, bad }: { label: string; columns: readonly Column[]; value: Toml[]; onChange: (v: Toml[] | undefined) => void; maxRows?: number; bad?: (row: number, key: string) => boolean }) {
  const out = (v: Toml[]): void => onChange(v);
  const blank = (): Toml => Object.fromEntries(columns.map((c) => [c.key, c.type === 'text' ? '' : 0]));
  return (
    <div role="group" aria-label={label}>
      {value.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                  {c.unit ? ` (${c.unit})` : ''}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {value.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const set = (v: unknown): void => out(value.map((r, k) => (k === i ? { ...r, [c.key]: v } : r)));
                  const name = `${label}: ${c.label.toLowerCase()}, row ${i + 1}`;
                  return (
                    <td key={c.key}>
                      {c.type === 'text' ? (
                        <input type="text" aria-label={name} value={typeof row[c.key] === 'string' ? (row[c.key] as string) : ''} aria-invalid={bad?.(i, c.key) ? true : undefined} onChange={(e) => set(e.target.value)} />
                      ) : (
                        <NumberInput label={name} value={row[c.key]} invalid={bad?.(i, c.key) === true} onChange={(v) => set(v ?? '')} />
                      )}
                    </td>
                  );
                })}
                <td>
                  <Button small variant="ghost" aria-label={`Remove row ${i + 1} of ${label}`} onClick={() => out(value.filter((_, k) => k !== i))}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button small disabled={maxRows !== undefined && value.length >= maxRows} aria-label={`Add a row to ${label}`} onClick={() => out([...value, blank()])}>
        Add row
      </Button>
      {maxRows !== undefined ? <span className="muted"> at most {maxRows}</span> : null}
    </div>
  );
}

function RecordEditor({ label, keys, value, onChange, base }: { label: string; keys: readonly Column[]; value: Toml; onChange: (v: Toml | undefined) => void; base: string }) {
  const { errors } = useForm();
  return (
    <div role="group" aria-label={label} className="row" style={{ gap: '6px 14px' }}>
      {keys.map((k) => (
        <label key={k.key} className="row" style={{ gap: 4 }}>
          <span className="muted">{k.label}</span>
          <NumberInput
            value={value[k.key]}
            invalid={issuesAt(errors, `${base}.${k.key}`).length > 0}
            label={`${label}: ${k.label.toLowerCase()}`}
            onChange={(v) => {
              const next = { ...value };
              if (v === undefined) delete next[k.key];
              else next[k.key] = v;
              onChange(Object.keys(next).length === 0 ? undefined : next);
            }}
          />
          {k.unit ? <span className="unit">{k.unit}</span> : null}
        </label>
      ))}
    </div>
  );
}

function MapEditor({ label, value, onChange }: { label: string; value: Toml; onChange: (v: Toml | undefined) => void }) {
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  const entries = Object.entries(value);
  return (
    <div role="group" aria-label={label}>
      {entries.length === 0 ? <p className="muted">None.</p> : null}
      <ul className="chips">
        {entries.map(([key, val]) => (
          <li key={key}>
            <code style={{ overflowWrap: 'anywhere' }}>{key}</code> = <code>{String(val)}</code>
            <Button
              small
              variant="ghost"
              aria-label={`Remove ${key} from ${label}`}
              onClick={() => {
                const next = { ...value };
                delete next[key];
                onChange(Object.keys(next).length === 0 ? undefined : next);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        style={{ marginTop: 4 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (k.trim() && v.trim()) onChange({ ...value, [k.trim()]: v.trim() });
          setK('');
          setV('');
        }}
      >
        <input type="text" aria-label={`${label}: address`} placeholder="payout address" value={k} onChange={(e) => setK(e.target.value)} />
        <input type="text" aria-label={`${label}: key name`} placeholder="key name" value={v} onChange={(e) => setV(e.target.value)} />
        <button type="submit" className="btn sm" disabled={!k.trim() || !v.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

const defaultText = (f: FieldDef): string | undefined => {
  if (f.defText) return f.defText;
  if (f.def === undefined || Array.isArray(f.def) || isTable(f.def)) return undefined;
  return String(f.def);
};

/** Error and warning lines for one key and everything under it. */
export function Messages({ path, id, exact }: { path: string; id?: string; exact?: boolean }) {
  const { errors, warnings } = useForm();
  const pick = (list: readonly ConfigIssue[]): ConfigIssue[] => (exact ? list.filter((i) => i.path === path) : issuesAt(list, path));
  const e = pick(errors);
  const w = pick(warnings);
  if (e.length === 0 && w.length === 0) return null;
  return (
    <div id={id}>
      {e.map((i, n) => (
        <p key={`e${n}`} className="msg error">
          <b>Error:</b> {i.message}
        </p>
      ))}
      {w.map((i, n) => (
        <p key={`w${n}`} className="msg warning">
          <b>Warning:</b> {i.message}
        </p>
      ))}
    </div>
  );
}

/**
 * One key of the file: label, control, unit, help, the dotted path, and its messages.
 * `base` is the table's dotted path.
 */
export function Field({ base, def, extra, label, wide }: { base: string; def: FieldDef; extra?: ReactNode; label?: string; wide?: boolean }) {
  const { draft, set, errors } = useForm();
  const uid = useId();
  const path = `${base}.${def.key}`;
  const value = getPath(draft, path);
  const invalid = issuesAt(errors, path).length > 0;
  const text = label ?? def.label;
  const helpId = `${uid}-help`;
  const msgId = `${uid}-msg`;
  const describedBy = `${helpId} ${msgId}`;
  const dflt = defaultText(def);
  const placeholder = dflt === undefined ? undefined : `default ${dflt}`;
  const t = def.type;
  const group = t.t === 'list' || t.t === 'rows' || t.t === 'record' || t.t === 'map';
  let control: ReactNode;
  switch (t.t) {
    case 'bool':
      control = <Switch label={text} checked={typeof value === 'boolean' ? value : def.def === true} describedBy={describedBy} onChange={(v) => set(path, v)} />;
      break;
    case 'number':
      control = <NumberInput id={uid} value={value} placeholder={placeholder} invalid={invalid} describedBy={describedBy} onChange={(v) => set(path, v)} />;
      break;
    case 'text':
    case 'env':
      control = (
        <input
          id={uid}
          type="text"
          className="w-wide"
          spellCheck={false}
          autoComplete="off"
          value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
          placeholder={t.t === 'env' ? 'NAME_OF_VARIABLE' : placeholder}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => set(path, e.target.value === '' ? undefined : e.target.value)}
        />
      );
      break;
    case 'select': {
      const hasNone = t.options.some((o) => o.value === '');
      const current = typeof value === 'string' ? value : hasNone ? '' : typeof def.def === 'string' ? def.def : (t.options[0]?.value ?? '');
      control = <Select id={uid} value={current} options={t.options} invalid={invalid} describedBy={describedBy} onChange={(v) => set(path, v === '' ? undefined : v)} />;
      break;
    }
    case 'list':
      control = <ListEditor label={text} value={Array.isArray(value) ? (value as string[]) : []} {...(t.options ? { options: t.options } : {})} onChange={(v) => set(path, v)} />;
      break;
    case 'rows': {
      const rows = Array.isArray(value) ? (value as Toml[]) : Array.isArray(def.def) ? (def.def as Toml[]) : [];
      control = (
        <RowsEditor
          label={text}
          columns={t.columns}
          value={rows}
          {...(t.maxRows !== undefined ? { maxRows: t.maxRows } : {})}
          bad={(row, key) => issuesAt(errors, `${path}.${row}.${key}`).length > 0}
          onChange={(v) => set(path, v)}
        />
      );
      break;
    }
    case 'record': {
      const on = isTable(value);
      control = t.required ? (
        <div className="stack" style={{ gap: 6 }}>
          <Switch
            label={`${text}: on`}
            checked={on}
            onChange={(v) => set(path, v ? Object.fromEntries(t.keys.map((k) => [k.key, k.min !== undefined && k.min > 0 ? k.min : 0])) : undefined)}
            describedBy={describedBy}
          />
          {on ? <RecordEditor label={text} keys={t.keys} value={value} base={path} onChange={(v) => set(path, v ?? {})} /> : null}
        </div>
      ) : (
        <RecordEditor label={text} keys={t.keys} value={on ? value : {}} base={path} onChange={(v) => set(path, v)} />
      );
      break;
    }
    case 'auto-number': {
      const auto = value === undefined || value === 'auto';
      control = (
        <>
          <Switch label="Automatic" checked={auto} onChange={(v) => set(path, v ? 'auto' : (t.min ?? 60))} />
          {auto ? null : <NumberInput id={uid} value={value} invalid={invalid} describedBy={describedBy} onChange={(v) => set(path, v ?? '')} />}
        </>
      );
      break;
    }
    case 'map':
      control = <MapEditor label={text} value={isTable(value) ? value : {}} onChange={(v) => set(path, v)} />;
      break;
    case 'custom':
      control = null;
      break;
  }
  const showLabel = t.t !== 'bool';
  return (
    <div className={`field${wide || t.t === 'rows' || t.t === 'map' ? ' wide' : ''}`}>
      {showLabel ? (
        group || t.t === 'custom' ? (
          <span className="label">{text}</span>
        ) : (
          <label htmlFor={uid}>{text}</label>
        )
      ) : null}
      <div className="control">
        {control}
        {extra}
        {def.unit && (t.t === 'number' || t.t === 'auto-number') ? <span className="unit">{def.unit}</span> : null}
      </div>
      <p className="help" id={helpId}>
        {def.help ? `${def.help} ` : ''}
        {t.t !== 'number' && t.t !== 'text' && dflt !== undefined && value === undefined ? <span>Default: {dflt}. </span> : null}
        <span className="path">{path}</span>
      </p>
      <Messages path={path} id={msgId} />
    </div>
  );
}

/** Every field of one table of the schema, in order. */
export function SectionFields({ section, skip = [], only }: { section: SectionDef; skip?: readonly string[]; only?: readonly string[] }) {
  return (
    <div className="fields">
      {section.fields
        .filter((f) => !skip.includes(f.key) && (!only || only.includes(f.key)) && f.type.t !== 'custom')
        .map((f) => (
          <Field key={f.key} base={section.path} def={f} />
        ))}
    </div>
  );
}
