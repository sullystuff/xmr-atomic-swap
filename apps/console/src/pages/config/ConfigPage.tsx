/**
 * Configuration: the whole of SPEC 7.2 on one page. Edits are checked locally as they are
 * typed and by the daemon before saving, applied without a restart, recorded in the change log,
 * and the whole file imports and exports as one.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConfigIssue, ConfigLogEntry, ConfigResponse, ConfigValidation, FeesResponse, OffersResponse } from '@xmrswap/protocol/daemon-api';
import { ApiFailure, describeError } from '../../api/client.js';
import { useClient, useQuery, useToasts } from '../../api/hooks.js';
import {
  ALLOWLIST,
  ASSETS,
  CROSS_CHAIN,
  GUARDRAILS,
  LIQUIDITY,
  MARKETS,
  OFFERS,
  OPERATION_SECTIONS,
  PRICING,
  REBALANCE,
  ROUTING,
  SOLANA,
  SOURCE_SECTIONS,
  VENUES,
  fieldOf,
  levelSection,
  venueSection,
} from '../../lib/config/schema.js';
import { editToml } from '../../lib/config/edit.js';
import { ConfigSyntaxError, diffConfig, getPath, isTable, parseToml, renderValue, setPath, stringifyToml, type Toml } from '../../lib/config/toml.js';
import { issuesAboutKey, resolveOffers, unknownKeys, validateConfig } from '../../lib/config/validate.js';
import { costBasis, estimateCost } from '../../lib/cost.js';
import type { FeesX, OffersX } from '../../api/extensions.js';
import { MARKET_LABEL, fmtTime } from '../../lib/format.js';
import { CostPanel } from '../../ui/cost-panel.js';
import { Async, Badge, Button, Card, ConfirmButton, Empty, Notice, PageHead, Switch } from '../../ui/kit.js';
import { Field, FormProvider, Messages, NumberInput, SectionFields, useForm, type FormState } from './fields.js';
import { MarketsSection } from './markets.js';

const SECTIONS: { id: string; label: string }[] = [
  { id: 'cfg-markets', label: 'Markets and offers' },
  { id: 'cfg-pricing', label: 'Price sources' },
  { id: 'cfg-updates', label: 'Offer updates and cost' },
  { id: 'cfg-liquidity', label: 'Liquidity' },
  { id: 'cfg-guardrails', label: 'Guardrails' },
  { id: 'cfg-rebalance', label: 'Rebalancing' },
  { id: 'cfg-daemon', label: 'Daemon and connections' },
  { id: 'cfg-other', label: 'Not editable here' },
  { id: 'cfg-file', label: 'Import and export' },
  { id: 'cfg-log', label: 'Change log' },
];

export function ConfigPage() {
  const config = useQuery('configGet');
  const registration = useQuery('registration');
  const fees = useQuery('fees');
  const offers = useQuery('offers');
  const log = useQuery('configLog');
  const [saved, setSaved] = useState<ConfigResponse | null>(null);
  const base = saved ?? config.data;
  return (
    <>
      <PageHead title="Configuration">
        One configuration covers liquidity, offers and pricing for all four markets. Edits are validated before saving, apply without a restart and are recorded in the change log. Price sources, keys, the deviation formula, inventory and guardrails stay on this machine.
      </PageHead>
      {base ? (
        <Editor
          key={base.revision}
          base={base}
          blobEndpoint={registration.data ? registration.data.blob_endpoint : null}
          fees={fees.data}
          offers={offers.data}
          log={log.data?.entries}
          logError={log.error}
          onSaved={(res) => {
            setSaved(res);
            log.reload();
            fees.reload();
            offers.reload();
          }}
          onReload={() => {
            setSaved(null);
            config.reload();
            log.reload();
          }}
        />
      ) : (
        <div className="card">
          <Async query={config} what="the configuration">
            {() => null}
          </Async>
        </div>
      )}
    </>
  );
}

const sameIssue = (a: ConfigIssue, b: ConfigIssue): boolean => a.path === b.path && a.message === b.message;
const merge = (local: readonly ConfigIssue[], remote: readonly ConfigIssue[] | undefined): ConfigIssue[] => [...local, ...(remote ?? []).filter((r) => !local.some((l) => sameIssue(l, r)))];

function Editor({
  base,
  blobEndpoint,
  fees,
  offers,
  log,
  logError,
  onSaved,
  onReload,
}: {
  base: ConfigResponse;
  blobEndpoint: boolean | null;
  fees: FeesX | undefined;
  offers: OffersX | undefined;
  log: ConfigLogEntry[] | undefined;
  logError: unknown;
  onSaved: (res: ConfigResponse) => void;
  onReload: () => void;
}) {
  const client = useClient();
  const { notify } = useToasts();
  const saved = useMemo(() => parseToml(base.toml), [base.toml]);
  const [draft, setDraft] = useState<Toml>(saved);
  const [remote, setRemote] = useState<{ toml: string; validation: ConfigValidation } | null>(null);
  const [remoteError, setRemoteError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [review, setReview] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const [basisFromValidate, setBasisFromValidate] = useState<{ sol_usd?: number | null; compute_units_per_update?: number } | null>(null);
  const { solUsd, cuLimit } = costBasis(basisFromValidate, fees, offers, { update_cost: base.validation.update_cost });
  const expected = base.validation.update_cost?.triggered_per_day.expected;
  const local = useMemo(
    () => validateConfig(draft, { blobEndpoint, solUsd, ...(expected !== undefined ? { expectedTriggeredPerDay: expected } : {}) }),
    [draft, blobEndpoint, solUsd, expected],
  );
  const changes = useMemo(() => diffConfig(saved, draft), [saved, draft]);
  const dirty = changes.length > 0;
  // Only the edited lines change: comments, layout and keys this console does not know are kept as they are.
  const { toml, kept } = useMemo(() => editToml(base.toml, draft), [base.toml, draft]);

  // The daemon checks the draft too, a moment after the last keystroke.
  useEffect(() => {
    if (!dirty) {
      setRemote(null);
      setRemoteError(null);
      return;
    }
    let live = true;
    const id = setTimeout(() => {
      client.call('configValidate', { body: { toml } }).then(
        (validation) => {
          if (!live) return;
          setRemote({ toml, validation });
          setBasisFromValidate(validation);
          setRemoteError(null);
        },
        (e: unknown) => live && setRemoteError(e),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [client, toml, dirty]);

  const remoteNow = remote && remote.toml === toml ? remote.validation : dirty ? undefined : base.validation;
  // The daemon is the judge. Until it has answered for this exact draft, the console's own checks
  // stand in; once it has, an error is an error only if the daemon reports one there, and a local
  // finding the daemon does not share is shown as a warning, never as a reason not to save.
  const { errors, warnings } = useMemo(() => {
    if (!remoteNow) return { errors: local.errors, warnings: local.warnings };
    const related = (a: string, b: string): boolean => a === b || b === '' || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
    const confirmed = local.errors.filter((l) => remoteNow.errors.some((r) => related(l.path, r.path)));
    const unshared = local.errors.filter((l) => !confirmed.includes(l)).map((l) => ({ path: l.path, message: `${l.message} (This console’s own check; the daemon accepts the value.)` }));
    return { errors: merge(confirmed, remoteNow.errors), warnings: [...merge(local.warnings, remoteNow.warnings), ...unshared] };
  }, [local.errors, local.warnings, remoteNow]);
  const unknown = useMemo(() => unknownKeys(draft), [draft]);

  const form: FormState = useMemo(
    () => ({
      draft,
      set: (path, value) => {
        setBlocked(false);
        setDraft((d) => setPath(d, path, value));
      },
      errors,
      warnings,
      unknown,
    }),
    [draft, errors, warnings, unknown],
  );

  const save = async (): Promise<void> => {
    setSaving(true);
    setConflict(false);
    try {
      // Validate first, with the daemon: nothing is saved while it reports an error.
      const validation = await client.call('configValidate', { body: { toml } });
      setRemote({ toml, validation });
      // Its verdict alone decides: a key or value this console has doubts about is saved if the daemon accepts it.
      if (!validation.ok) {
        setBlocked(true);
        queueMicrotask(() => summaryRef.current?.focus());
        return;
      }
      const res = await client.call('configPut', { body: { toml, base_revision: base.revision } });
      notify('ok', 'Saved. The daemon applied the change without a restart and recorded it in the change log.');
      onSaved(res);
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'revision_conflict') setConflict(true);
      else if (e instanceof ApiFailure && e.status === 422) {
        // The daemon refused the file: put each of its errors on its field.
        const issues = e.issues.length > 0 ? e.issues : [{ path: '(file)', message: e.detail ?? 'The daemon refused this configuration.' }];
        setRemote({ toml, validation: { ok: false, errors: issues, warnings: e.warnings, effective: [], update_cost: null } });
        setBlocked(true);
        queueMicrotask(() => summaryRef.current?.focus());
      }
      else notify('bad', `Not saved. ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const jump = (id: string): void => document.getElementById(id)?.scrollIntoView?.({ block: 'start' });

  return (
    <FormProvider value={form}>
      <nav aria-label="Configuration sections" style={{ marginBottom: 12 }}>
        <ul className="toc">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button type="button" className="btn ghost sm" onClick={() => jump(s.id)}>
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="stack">
        <MarketsSection blobEndpoint={blobEndpoint} />
        <PricingSection />
        <UpdatesSection fees={fees} offers={offers} solUsd={solUsd} cuLimit={cuLimit} blobEndpoint={blobEndpoint} daemonCost={remoteNow?.update_cost ?? null} />
        <LiquiditySection />
        <GuardrailsSection />
        <RebalanceSection />
        <OperationSection />
        <UnknownSection />
        <FileSection
          savedToml={base.toml}
          dirty={dirty}
          blobEndpoint={blobEndpoint}
          onLoad={(cfg) => {
            setBlocked(false);
            setDraft(cfg);
          }}
          onImported={onSaved}
        />
        <ChangeLog entries={log} error={logError} />
      </div>

      <div className="savebar" role="region" aria-label="Save configuration">
        <div style={{ flex: 1, minWidth: 220 }}>
          <strong data-testid="change-count">{dirty ? (changes.length === 1 ? '1 unsaved change' : `${changes.length} unsaved changes`) : 'No unsaved changes'}</strong>
          <span className="muted">
            {' '}
            · <span data-testid="error-count">{errors.length === 1 ? '1 error' : `${errors.length} errors`}</span> · {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}
            {dirty && !remoteNow && !remoteError ? ' · checking with the daemon…' : ''}
          </span>
          {remoteError ? <div className="msg warning">The daemon could not check this draft: {describeError(remoteError)}</div> : null}
          {dirty && !kept ? <div className="msg warning">This file is laid out in a way the console cannot edit line by line, so saving rewrites it whole: values are kept, comments are not.</div> : null}
        </div>
        <Button small aria-expanded={review} disabled={!dirty && errors.length === 0 && warnings.length === 0} onClick={() => setReview((r) => !r)}>
          {review ? 'Hide review' : 'Review'}
        </Button>
        <Button small disabled={!dirty || saving} onClick={() => setDraft(saved)}>
          Discard changes
        </Button>
        <Button variant="primary" disabled={!dirty} busy={saving} onClick={() => void save()}>
          Validate and save
        </Button>
        {conflict ? (
          <div style={{ flexBasis: '100%' }}>
            <Notice tone="bad" title="Not saved: the configuration changed underneath you.">
              Someone edited the file or saved from another window since this page loaded it. Reload to see the current file, then make your edit again.{' '}
              <Button small onClick={onReload}>
                Reload the configuration
              </Button>
            </Notice>
          </div>
        ) : null}
        {blocked || review ? (
          <div style={{ flexBasis: '100%', maxHeight: '38vh', overflowY: 'auto' }} tabIndex={-1} ref={summaryRef}>
            {blocked ? (
              <Notice tone="bad" title={`Not saved: ${errors.length === 1 ? '1 error has' : `${errors.length} errors have`} to be fixed first.`}>
                <IssueList issues={errors} />
              </Notice>
            ) : null}
            {review ? (
              <div className="stack" style={{ marginTop: 8 }}>
                {!blocked && errors.length > 0 ? (
                  <Notice tone="bad" title="Errors">
                    <IssueList issues={errors} />
                  </Notice>
                ) : null}
                {warnings.length > 0 ? (
                  <Notice tone="warn" title="Warnings">
                    <IssueList issues={warnings} />
                  </Notice>
                ) : null}
                {dirty ? (
                  <table className="tbl" aria-label="Unsaved changes">
                    <thead>
                      <tr>
                        <th scope="col">Key</th>
                        <th scope="col">Saved</th>
                        <th scope="col">New</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((c) => (
                        <tr key={c.path}>
                          <td className="mono">{c.path}</td>
                          <td className="mono">{c.old ?? <span className="muted">unset</span>}</td>
                          <td className="mono">{c.new ?? <span className="muted">unset</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </FormProvider>
  );
}

function IssueList({ issues }: { issues: readonly ConfigIssue[] }) {
  return (
    <ul>
      {issues.map((i, n) => (
        <li key={n}>
          <code>{i.path}</code>: {i.message}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ sections

function PricingSection() {
  return (
    <Card id="cfg-pricing" title="Price sources" note="Each market picks a primary source and an ordered list of fallbacks in its offer settings. These settings apply to all of them.">
      <SectionFields section={PRICING} />
      <Notice tone="info" title="The wXMR pool may only be a cross-check.">
        A pool that small can be pushed off-market cheaply by someone who then takes your quote. If a market names it as its primary source, the first fallback is promoted and the pool is used as that market's cross-check.
      </Notice>
      {SOURCE_SECTIONS.map((s) => (
        <div key={s.path}>
          <h3 className="subhead">{s.title}</h3>
          <SectionFields section={s} />
        </div>
      ))}
    </Card>
  );
}

function UpdatesSection({ fees, offers, solUsd, cuLimit, blobEndpoint, daemonCost }: { fees: FeesResponse | undefined; offers: OffersResponse | undefined; solUsd: number | null; cuLimit: number; blobEndpoint: boolean | null; daemonCost: ConfigValidation['update_cost'] }) {
  const { draft } = useForm();
  const num = (path: string): number | undefined => {
    const v = getPath(draft, path);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const interval = num('offers.update_interval_seconds') ?? 15;
  const micro = num('solana.priority_fee_microlamports') ?? 0;
  const live = resolveOffers(draft, { blobEndpoint }).filter((o) => o.terms.enabled);
  const valid = live.map((o) => (typeof o.values.offer_valid_seconds === 'number' ? o.values.offer_valid_seconds : 60));
  // Recalculated on every keystroke; the daemon's own figure for this exact draft takes over when it arrives.
  const daemonPer = daemonCost && daemonCost.interval_secs === interval ? BigInt(daemonCost.lamports_per_update) : undefined;
  const cost = estimateCost({
    intervalSecs: interval > 0 ? interval : 0,
    priorityMicroLamports: micro,
    moveTriggerPct: num('offers.price_move_trigger_pct'),
    minRefreshSecs: num('offers.min_refresh_interval_seconds'),
    offerValidSecs: valid.length > 0 ? Math.min(...valid) : undefined,
    // Only the daemon knows how often the price moves; its figure is for this exact draft.
    expectedTriggeredPerDay: daemonCost?.triggered_per_day.expected,
    solUsd,
    perUpdateLamports: daemonPer,
    cuLimit,
  });
  return (
    <Card id="cfg-updates" title="Offer updates and cost" note="How often offers are refreshed on Solana, and what that costs per day, shown before you save.">
      <div className="fields" style={{ marginBottom: 12 }}>
        <Field base={OFFERS.path} def={fieldOf(OFFERS, 'update_interval_seconds')} />
        <Field base={SOLANA.path} def={fieldOf(SOLANA, 'priority_fee_microlamports')} />
        <Field base={OFFERS.path} def={fieldOf(OFFERS, 'price_move_trigger_pct')} />
        <Field base={OFFERS.path} def={fieldOf(OFFERS, 'min_refresh_interval_seconds')} />
        <Field base={OFFERS.path} def={fieldOf(OFFERS, 'key_pool_low_water')} />
      </div>
      <CostPanel cost={cost} intervalSecs={interval} solUsd={solUsd} fees={fees} offers={offers} draft />
    </Card>
  );
}

function LiquiditySection() {
  const { draft, set } = useForm();
  const alloc = getPath(draft, 'liquidity.allocation');
  const perMarket = isTable(alloc);
  const id = useId();
  return (
    <Card id="cfg-liquidity" title="Liquidity" note="XMR inventory, paying balances, targets and exposure limits.">
      <h3 className="subhead">XMR inventory</h3>
      <div className="fields">
        <div className="field">
          <label htmlFor={id}>XMR allocation</label>
          <div className="control">
            <select id={id} value={perMarket ? 'per_market' : 'shared'} onChange={(e) => set('liquidity.allocation', e.target.value === 'shared' ? undefined : Object.fromEntries(MARKETS.map((m) => [m, 0])))}>
              <option value="shared">One shared pool</option>
              <option value="per_market">A fixed allocation per market</option>
            </select>
          </div>
          {perMarket ? (
            <div role="group" aria-label="Allocation per market" className="row" style={{ gap: '6px 14px' }}>
              {MARKETS.map((m) => (
                <label key={m} className="row" style={{ gap: 4 }}>
                  <span className="muted">{MARKET_LABEL[m]}</span>
                  <NumberInput label={`Allocation for ${MARKET_LABEL[m]}`} value={alloc[m]} onChange={(v) => set(`liquidity.allocation.${m}`, v ?? 0)} />
                  <span className="unit">XMR</span>
                </label>
              ))}
            </div>
          ) : null}
          <p className="help">
            One shared pool, or a fixed allocation per market. <span className="path">liquidity.allocation</span>
          </p>
          <Messages path="liquidity.allocation" />
        </div>
        <Field base={LIQUIDITY.path} def={fieldOf(LIQUIDITY, 'xmr_reserve')} />
        <Field base={LIQUIDITY.path} def={fieldOf(LIQUIDITY, 'output_ladder')} />
      </div>
      <h3 className="subhead">Exposure limits</h3>
      <SectionFields section={LIQUIDITY} only={['max_in_flight_xmr', 'max_per_taker_xmr']} />
      <h3 className="subhead">Paying balances and targets</h3>
      <div className="fields">
        <Field base={LIQUIDITY.path} def={fieldOf(LIQUIDITY, 'paying_caps')} wide />
        <Field base={LIQUIDITY.path} def={fieldOf(LIQUIDITY, 'targets')} wide />
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        The thresholds that trigger refill alerts are the low, target and high levels under Rebalancing.
      </p>
    </Card>
  );
}

function GuardrailsSection() {
  const { draft, set } = useForm();
  const reorg = getPath(draft, 'guardrails.reorg_guard');
  const reorgOn = isTable(reorg) && reorg.enabled === true;
  const maxAge = getPath(draft, 'pricing.max_age_seconds') ?? 60;
  const disagreement = getPath(draft, 'pricing.max_disagreement_pct') ?? 1;
  const daemonMode = getPath(draft, 'daemon.mode') ?? 'dry_run';
  const dry = getPath(draft, 'guardrails.dry_run') === true;
  return (
    <Card id="cfg-guardrails" title="Guardrails" note="Each guardrail has its own thresholds and its own switch.">
      <div className="fields">
        <Field base={GUARDRAILS.path} def={fieldOf(GUARDRAILS, 'volatility_pause')} />
        <Field
          base={GUARDRAILS.path}
          def={fieldOf(GUARDRAILS, 'disagreement_pause')}
          extra={<span className="unit">threshold: {String(disagreement)}% (largest disagreement allowed, under Price sources)</span>}
        />
        <Field base={GUARDRAILS.path} def={fieldOf(GUARDRAILS, 'stale_pause')} extra={<span className="unit">threshold: {String(maxAge)} s (maximum price age, under Price sources)</span>} />
        <Field base={GUARDRAILS.path} def={fieldOf(GUARDRAILS, 'price_band_usd')} />
        <div className="field">
          <div className="control">
            <Switch label="Reorg guard" checked={reorgOn} onChange={(v) => set('guardrails.reorg_guard', v ? { enabled: true, raise_depth_to: isTable(reorg) && typeof reorg.raise_depth_to === 'number' ? reorg.raise_depth_to : 30 } : undefined)} />
            {reorgOn ? (
              <label className="row" style={{ gap: 4 }}>
                <span className="muted">raise depth to</span>
                <NumberInput label="Reorg guard: raise depth to" value={isTable(reorg) ? reorg.raise_depth_to : undefined} onChange={(v) => set('guardrails.reorg_guard.raise_depth_to', v ?? '')} />
                <span className="unit">confirmations</span>
              </label>
            ) : null}
          </div>
          <p className="help">
            Raise the confirmation depth while the Monero nodes report reorgs. <span className="path">guardrails.reorg_guard</span>
          </p>
          <Messages path="guardrails.reorg_guard" />
        </div>
        <Field base={GUARDRAILS.path} def={fieldOf(GUARDRAILS, 'dry_run')} />
      </div>
      <div style={{ marginTop: 10 }}>
        {dry || daemonMode !== 'live' ? (
          <Notice tone="info" title="Dry run is on.">
            The engine computes and shows the offers it would post, but sends no transaction and moves no XMR.{' '}
            {daemonMode !== 'live' ? 'The daemon itself is in dry-run mode (Daemon and connections), which is the default; this switch adds nothing until the daemon is live.' : 'Switch it off to publish.'}
          </Notice>
        ) : (
          <Notice tone="ok" title="Dry run is off.">
            The daemon is live: offers are published and swaps are executed.
          </Notice>
        )}
      </div>
    </Card>
  );
}

function RebalanceSection() {
  return (
    <Card id="cfg-rebalance" title="Rebalancing" note="Triggers, mode, venue choice, cost limits and the safety controls. Refills are approved and tracked on the Rebalancing page.">
      <SectionFields section={REBALANCE} />
      <h3 className="subhead">Levels (triggers)</h3>
      <div className="table-wrap">
        <table className="mini" aria-label="Rebalancing levels">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Low</th>
              <th scope="col">Target</th>
              <th scope="col">High</th>
            </tr>
          </thead>
          <tbody>
            {ASSETS.map((a) => (
              <LevelRow key={a} asset={a} />
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="subhead">{ROUTING.title}</h3>
      <SectionFields section={ROUTING} />
      <h3 className="subhead">{ALLOWLIST.title}</h3>
      <p className="muted" style={{ marginBottom: 6 }}>
        Refills pay out only to these addresses. Left empty, the daemon uses the inventory wallet and the operator and payout addresses.
      </p>
      <SectionFields section={ALLOWLIST} />
      <h3 className="subhead">{CROSS_CHAIN.title}</h3>
      <SectionFields section={CROSS_CHAIN} />
      <h3 className="subhead">Venues</h3>
      <p className="muted" style={{ marginBottom: 6 }}>
        Each venue applies its own terms and screening; meeting them is your responsibility. API keys stay on this machine and are named here by environment variable only.
      </p>
      {VENUES.map((v) => {
        const s = venueSection(v);
        return <VenueBlock key={v} title={s.title} path={s.path} venue={v} />;
      })}
    </Card>
  );
}

function LevelRow({ asset }: { asset: (typeof ASSETS)[number] }) {
  const { draft, set } = useForm();
  const s = levelSection(asset);
  return (
    <tr>
      <th scope="row" style={{ fontWeight: 600, color: 'var(--text)', fontSize: 'inherit' }}>
        {asset}
      </th>
      {s.fields.map((f) => (
        <td key={f.key}>
          <NumberInput label={`${asset} ${f.key} level`} value={getPath(draft, `${s.path}.${f.key}`)} onChange={(v) => set(`${s.path}.${f.key}`, v)} />
        </td>
      ))}
      <td>
        <Messages path={s.path} />
      </td>
    </tr>
  );
}

function VenueBlock({ title, path, venue }: { title: string; path: string; venue: (typeof VENUES)[number] }) {
  const { draft, errors, warnings } = useForm();
  const on = getPath(draft, `${path}.enabled`) === true;
  const s = venueSection(venue);
  const nErr = errors.filter((e) => e.path.startsWith(path)).length;
  const nWarn = warnings.filter((e) => e.path.startsWith(path)).length;
  return (
    <details style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }} open={nErr > 0 ? true : undefined}>
      <summary>
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{title}</span> {on ? <Badge tone="ok">Enabled</Badge> : <Badge>Off</Badge>} {nErr > 0 ? <Badge tone="bad">{nErr} to fix</Badge> : nWarn > 0 ? <Badge tone="warn">{nWarn === 1 ? '1 warning' : `${nWarn} warnings`}</Badge> : null}
      </summary>
      <div style={{ paddingTop: 10 }}>
        <SectionFields section={s} />
      </div>
    </details>
  );
}

function OperationSection() {
  return (
    <Card id="cfg-daemon" title="Daemon and connections" note="Secrets never go in this file: a key ending in _env names the environment variable that holds the value.">
      {OPERATION_SECTIONS.map((s) => (
        <div key={s.path}>
          <h3 className="subhead">{s.title}</h3>
          <SectionFields section={s} skip={s.path === 'solana' ? ['priority_fee_microlamports'] : []} />
        </div>
      ))}
      <p className="muted" style={{ marginTop: 8 }}>
        The Solana priority fee is under Offer updates and cost, beside the estimate it changes.
      </p>
    </Card>
  );
}

/**
 * Keys in the file that this console has no control for (the daemon's schema is ahead of the
 * console's copy, or the key is a mistake). They are never dropped or rewritten by a save, and
 * never block one: the daemon's validation says whether each is acceptable.
 */
function UnknownSection() {
  const { draft, set, unknown, errors } = useForm();
  return (
    <Card id="cfg-other" title="Settings not editable here" note="Keys in your file that this console has no control for. They are kept exactly as they are when you save; the daemon decides whether each is valid." flush>
      {unknown.length === 0 ? (
        <Empty title="None">Every key in the file has a control on this page.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="tbl" aria-label="Settings not editable here">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
                <th scope="col">The daemon says</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {unknown.map((key) => {
                const about = issuesAboutKey(errors, key);
                return (
                  <tr key={key} className={about.length > 0 ? 'attention' : undefined}>
                    <th scope="row" className="mono">
                      {key}
                    </th>
                    <td className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {renderValue(getPath(draft, key))}
                    </td>
                    <td>
                      {about.length === 0 ? (
                        <span className="muted">accepted, or not checked yet</span>
                      ) : (
                        about.map((i, n) => (
                          <p key={n} className="msg error">
                            <b>Error:</b> {i.message}
                          </p>
                        ))
                      )}
                    </td>
                    <td className="actions">
                      {/\.\d+(\.|$)/.test(key) ? (
                        <span className="muted">inside a list: edit the file to remove it</span>
                      ) : (
                        <ConfirmButton label="Remove" small variant="danger" onConfirm={() => set(key, undefined)}>
                          Remove {key} from the file. Nothing is saved until you validate and save.
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ import and export

function FileSection({ savedToml, dirty, blobEndpoint, onLoad, onImported }: { savedToml: string; dirty: boolean; blobEndpoint: boolean | null; onLoad: (cfg: Toml) => void; onImported: (res: ConfigResponse) => void }) {
  const client = useClient();
  const { notify } = useToasts();
  const [text, setText] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const id = useId();

  const checked = useMemo(() => {
    if (text.trim() === '') return null;
    try {
      const cfg = parseToml(text);
      return { cfg, validation: validateConfig(cfg, { blobEndpoint, solUsd: null }), syntax: null as string | null };
    } catch (e) {
      const where = e instanceof ConfigSyntaxError && e.line !== null ? `Line ${e.line}: ` : '';
      return { cfg: null, validation: null, syntax: `${where}${e instanceof Error ? e.message : 'not valid TOML'}` };
    }
  }, [text, blobEndpoint]);

  const doExport = async (): Promise<void> => {
    setBusy('export');
    try {
      const res = await client.call('configExport');
      setExported(res.toml);
      const stamp = new Date(res.exported_at * 1000).toISOString().slice(0, 10);
      // A download where the browser supports it; the text is shown below either way.
      if (typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([res.toml], { type: 'application/toml' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `maker-config-${stamp}.toml`;
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      notify('ok', `Exported the whole configuration as one file (${res.toml.split('\n').length} lines).`);
    } catch (e) {
      notify('bad', describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const doImport = async (): Promise<void> => {
    setBusy('import');
    try {
      const res = await client.call('configImport', { body: { toml: text } });
      notify('ok', 'Imported and applied without a restart. The file is kept byte for byte, comments included.');
      setText('');
      setName(null);
      onImported(res);
    } catch (e) {
      notify('bad', `Not imported. ${describeError(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const v = checked?.validation;
  return (
    <Card id="cfg-file" title="Import and export" note="The whole configuration is one TOML file.">
      <div className="cols-2">
        <div className="stack">
          <h3 className="subhead">Export</h3>
          <p>Download the file the daemon is running with, including comments.</p>
          <div>
            <Button busy={busy === 'export'} onClick={() => void doExport()}>
              Export the configuration
            </Button>
          </div>
          {exported !== null ? (
            <>
              <label htmlFor={`${id}-x`} className="muted">
                Exported file
              </label>
              <textarea id={`${id}-x`} rows={10} readOnly value={exported} />
            </>
          ) : null}
          <details>
            <summary>Show the saved file</summary>
            <textarea aria-label="Saved configuration file" rows={14} readOnly value={savedToml} style={{ marginTop: 6 }} />
          </details>
          <p className="muted">Saving from the form above changes only the lines you edited; comments, layout and keys this console does not know stay as they are. An import keeps the file exactly as given.</p>
        </div>
        <div className="stack">
          <h3 className="subhead">Import</h3>
          <div className="row">
            <label htmlFor={`${id}-f`} className="btn">
              Choose a file
            </label>
            <input
              id={`${id}-f`}
              type="file"
              accept=".toml,text/plain"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setName(file.name);
                void file.text().then(setText);
                e.target.value = '';
              }}
            />
            {name ? <span className="muted">{name}</span> : <span className="muted">or paste it below</span>}
          </div>
          <label htmlFor={`${id}-t`} className="sr-only">
            Configuration file to import
          </label>
          <textarea id={`${id}-t`} rows={10} value={text} placeholder={'[pricing]\nrefresh_seconds = 15\n…'} spellCheck={false} onChange={(e) => setText(e.target.value)} aria-invalid={checked?.syntax ? true : undefined} />
          {checked?.syntax ? (
            <Notice tone="bad" title="This is not valid TOML.">
              {checked.syntax}
            </Notice>
          ) : null}
          {v ? (
            <div data-testid="import-check">
              <Notice tone={v.ok ? (v.warnings.length > 0 ? 'warn' : 'ok') : 'bad'} title={v.ok ? 'This file passes the check.' : `This file has ${v.errors.length === 1 ? '1 error' : `${v.errors.length} errors`} and cannot be imported.`}>
                {checked?.cfg && unknownKeys(checked.cfg).length > 0 ? `This console does not know ${unknownKeys(checked.cfg).length === 1 ? 'one key' : `${unknownKeys(checked.cfg).length} keys`} in it (${unknownKeys(checked.cfg).join(', ')}); the daemon decides on import whether they are valid. ` : null}
                {v.ok ? `${v.effective.length === 1 ? '1 offer' : `${v.effective.length} offers`} would run. ${v.warnings.length === 0 ? 'No warnings.' : `${v.warnings.length === 1 ? '1 warning' : `${v.warnings.length} warnings`}:`}` : null}
                <IssueList issues={v.ok ? v.warnings : v.errors} />
              </Notice>
            </div>
          ) : null}
          <div className="row">
            <ConfirmButton label="Import and apply" variant="primary" disabled={!v?.ok} busy={busy === 'import'} onConfirm={() => void doImport()}>
              Replace the whole configuration with this file and apply it now, without a restart.{dirty ? ' Your unsaved changes in the form are dropped.' : ''}
            </ConfirmButton>
            <Button
              disabled={!checked?.cfg}
              onClick={() => {
                if (checked?.cfg) {
                  onLoad(checked.cfg);
                  notify('info', 'Loaded into the form. Nothing is saved until you validate and save.');
                }
              }}
            >
              Load into the form without saving
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ChangeLog({ entries, error }: { entries: ConfigLogEntry[] | undefined; error: unknown }) {
  const source = { file: 'File edited on disk', api: 'This console', import: 'Import' } as const;
  return (
    <Card id="cfg-log" title="Change log" note="Every change to the configuration, newest first." flush>
      {entries === undefined ? (
        error ? (
          <div className="card-body">
            <Notice tone="bad" title="Could not load the change log.">
              {describeError(error)}
            </Notice>
          </div>
        ) : (
          <Empty title="Loading the change log" />
        )
      ) : entries.length === 0 ? (
        <Empty title="No changes recorded yet" />
      ) : (
        <div className="table-wrap">
          <table className="tbl" aria-label="Configuration change log">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Source</th>
                <th scope="col">Revision</th>
                <th scope="col">Changes</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, n) => (
                <tr key={`${e.revision}-${n}`}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.at)}</td>
                  <td>{source[e.source]}</td>
                  <td className="mono">{e.revision.slice(0, 8)}</td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {e.changes.slice(0, 12).map((c) => (
                        <li key={c.path}>
                          <code>{c.path}</code>: <span className="mono">{c.old ?? 'unset'}</span> → <span className="mono">{c.new ?? 'unset'}</span>
                        </li>
                      ))}
                    </ul>
                    {e.changes.length > 12 ? <span className="muted">and {e.changes.length - 12} more keys</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
