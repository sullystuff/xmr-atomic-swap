/** The large-swap tool (SPEC 8.6): order entry, the router's plan with editable legs, waves under the in-flight cap, the status board and the final report. */
import { MARKET_DECIMALS, type Market } from '@xmrswap/protocol';
import type { LegState, RoutePlan } from '@xmrswap/sdk';
import { useMemo, useState } from 'react';
import { ASSET_LABEL, bpsPercent, formatAsset, formatDuration, formatPrice, formatTime, formatXmrAmount, looksLikeXmrAddress, parseUnits, parseXmr } from '../lib/format.js';
import { lockBlockers } from '../lib/gates.js';
import { type OfferWarning, offerWarnings, referenceFor, worstCaseClaimOpen } from '../lib/market.js';
import { LEG_LABEL, LEG_ORDER, type Order, orderProgress, planOrder } from '../lib/orders.js';
import { BackupStep } from '../ui/Backup.js';
import { ConfirmLock } from '../ui/ConfirmLock.js';
import { href, navigate, useApp, useChainNow, useEngine, useObs, useVault } from '../ui/hooks.js';
import { Empty, Field, Notice, Segmented, Spinner } from '../ui/kit.js';
import { MODE_LABEL } from './OffersPage.js';

const DROP_TEXT: Readonly<Record<string, string>> = {
  'approval-required': 'needs an advance approval',
  'approval-window': 'approval window longer than your limit',
  'fault-rate': 'too many missed deadlines',
  'withhold-rate': 'withholds deposits too often',
  depth: 'too few confirmations for the total in flight',
  'worse-than-limit': 'worse than your worst acceptable rate',
  'below-minimum': 'what is left is below its minimum size',
};
const MARKETS: readonly { value: Market; label: string }[] = [
  { value: 'sol', label: 'SOL' },
  { value: 'usdc_sol', label: 'USDC · Solana' },
  { value: 'eth', label: 'ETH' },
  { value: 'usdc_eth', label: 'USDC · Ethereum' },
];

function LegPill({ state }: { state: LegState }) {
  const cls = state === 'locked' || state === 'xmr-seen' ? 'pill pill-risk' : state === 'ready' || state === 'claimed' || state === 'swept' ? 'pill pill-safe' : state === 'refunded' ? 'pill pill-warn' : 'pill';
  return <span className={cls}>{LEG_LABEL[state]}</span>;
}

function OrderEntry() {
  const app = useApp();
  const registry = useObs(app.registry);
  const settings = useObs(app.settings);
  const wallets = useObs(app.wallets);
  const upgrade = useObs(app.upgrade);
  const vault = useVault();
  const [market, setMarket] = useState<Market>('sol');
  const chain = market === 'sol' || market === 'usdc_sol' ? 'solana' : 'ethereum';
  const now = useChainNow(chain);
  const [total, setTotal] = useState('');
  const [worst, setWorst] = useState('');
  const [cap, setCap] = useState('');
  const [minutes, setMinutes] = useState('240');
  const [dest, setDest] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dec = MARKET_DECIMALS[market];
  const asset = ASSET_LABEL[market];
  const rows = registry.snapshot?.rows ?? [];
  const ref = referenceFor(market, rows.filter((r) => r.direction === 0), settings);
  const totalPay = parseUnits(total, dec);
  const worstPrice = worst.trim() === '' ? (ref ? (ref.price * 105n) / 100n : null) : parseUnits(worst, dec);
  const maxInFlight = cap.trim() === '' ? totalPay : parseUnits(cap, dec);
  const mins = Number(minutes);
  const inputError =
    total.trim() === ''
      ? 'Type the total amount to spend.'
      : totalPay === null || totalPay === 0n
        ? `Type the total in ${asset}, for example 25.`
        : worstPrice === null || worstPrice === 0n
          ? 'Type the worst rate you accept.'
          : maxInFlight === null || maxInFlight === 0n
            ? 'Type the most you want locked at one time.'
            : !Number.isFinite(mins) || mins < 5
              ? 'Give a deadline of at least 5 minutes.'
              : !looksLikeXmrAddress(dest)
                ? 'Give the XMR address that should receive the XMR.'
                : null;

  const draft = useMemo(() => {
    if (!totalPay || !worstPrice || !maxInFlight || now === null) return null;
    return { market, worstPrice: worstPrice.toString(), deadline: (now + BigInt(Math.max(5, mins || 0) * 60)).toString(), referencePrice: ref ? ref.price.toString() : null, minDepth: settings.minDepth, excluded, caps };
    // `now` moves every second; the plan only needs it to the minute.
  }, [market, totalPay, worstPrice, maxInFlight, now === null ? null : now / 60n, mins, ref?.price, settings.minDepth, excluded, caps]);
  const plan: RoutePlan | null = useMemo(() => (draft && totalPay && maxInFlight ? planOrder(draft, rows, totalPay, maxInFlight) : null), [draft, rows, totalPay, maxInFlight]);
  const first = plan?.waves[0] ?? null;
  const rowOf = (id: string) => rows.find((r) => r.id === id);

  // The confirmation shows every warning that applies to any leg of the first wave, once each.
  const warnings: OfferWarning[] = useMemo(() => {
    if (!first) return [];
    const seen = new Map<string, OfferWarning>();
    for (const l of first.legs) {
      const r = rowOf(l.offerId);
      if (!r) continue;
      for (const w of offerWarnings({ row: r, pricing: { amount: l.pay, deposit: l.deposit, depth: l.depth }, xmr: l.xmr, inFlightXmr: first.xmr, minDepth: settings.minDepth, upgrade: upgrade[r.chain] })) if (!seen.has(w.id)) seen.set(w.id, w);
    }
    return [...seen.values()];
  }, [first, rows, settings.minDepth, upgrade]);

  const blockers = lockBlockers({ backedUp: vault.backedUp, chain, walletConnected: wallets[chain] !== null, settings, inputError, offerProblem: plan && plan.waves.length === 0 ? 'No offer fits this order. Raise the worst rate or lower the amount.' : null });
  const start = async () => {
    if (!draft || !first || !totalPay || !maxInFlight) return;
    setBusy(true);
    setError(null);
    const order: Order = { id: crypto.randomUUID(), market, totalPay: totalPay.toString(), worstPrice: draft.worstPrice, maxInFlight: maxInFlight.toString(), deadline: draft.deadline, destination: dest.trim(), referencePrice: draft.referencePrice, minDepth: draft.minDepth, createdAt: Date.now(), legs: [], excluded, caps, stopped: false };
    try {
      await app.startOrder(order, first, true);
      setConfirming(false);
      navigate('large', order.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const slowest = first ? first.legs.map((l) => rowOf(l.offerId)).filter((r) => r !== undefined).reduce((m, r) => (now === null ? m : worstCaseClaimOpen(r, now) > m ? worstCaseClaimOpen(r, now) : m), now ?? 0n) : 0n;

  return (
    <div className="grid gap-8" data-testid="large-entry">
      <header className="grid gap-2">
        <h1>Large swap</h1>
        <p className="muted prose-w">Split one order across several makers. Each leg is an ordinary swap with its own keys, so a leg that fails never affects another. If the order is larger than your in-flight limit it runs in waves, opening new legs as earlier ones settle.</p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-12">
        <section className="grid content-start gap-5" aria-labelledby="order-h">
          <h2 id="order-h">Order</h2>
          <div>
            <span className="label mb-1.5">Pay with</span>
            <Segmented label="Pay with" value={market} onChange={(m) => (setMarket(m), setExcluded([]), setCaps({}))} options={MARKETS} />
          </div>
          <Field label={`Total to spend (${asset})`}>{(p) => <input {...p} className="input input-num" inputMode="decimal" autoComplete="off" value={total} onChange={(e) => setTotal(e.target.value)} />}</Field>
          <Field label={`Worst acceptable rate (${asset} per XMR)`} hint={ref ? `Left empty: 5% above the reference of ${formatPrice(ref.price, market)} (${ref.source === 'settings' ? 'your figure' : 'median offer'}). No leg is opened at a worse rate.` : 'No leg is opened at a worse rate.'}>
            {(p) => <input {...p} className="input input-num" inputMode="decimal" autoComplete="off" value={worst} placeholder={ref ? formatAsset((ref.price * 105n) / 100n, market, 4) : ''} onChange={(e) => setWorst(e.target.value)} />}
          </Field>
          <Field label={`Most locked at one time (${asset})`} hint="The in-flight limit. Everything locked at once is exposed to the same Monero reorganisation, so the required confirmation depth is set from this total, not from each leg.">
            {(p) => <input {...p} className="input input-num" inputMode="decimal" autoComplete="off" value={cap} placeholder={total} onChange={(e) => setCap(e.target.value)} />}
          </Field>
          <Field label="Stop opening new legs after (minutes)" hint="Legs already open still finish or refund. Whatever is not placed by then is reported as unfilled.">
            {(p) => <input {...p} className="input input-num" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
          </Field>
          <Field label="Your XMR address" hint="Every leg is swept here." error={dest && !looksLikeXmrAddress(dest) ? 'That does not look like a Monero address.' : null}>
            {(p) => <input {...p} className="input mono" spellCheck={false} autoComplete="off" value={dest} onChange={(e) => setDest(e.target.value)} />}
          </Field>
        </section>

        <section className="grid content-start gap-5" aria-labelledby="plan-h">
          <h2 id="plan-h">Plan</h2>
          {!registry.snapshot ? (
            <Spinner label="Reading offers" />
          ) : !plan ? (
            <p className="muted">Fill in the order to see how it would be split.</p>
          ) : plan.waves.length === 0 ? (
            <Notice kind="warn" title="No offer fits this order">
              {plan.dropped.length > 0 ? `Left out: ${plan.dropped.map((d) => `${rowOf(d.offerId)?.maker.pda.slice(0, 6) ?? d.offerId.slice(0, 6)}… (${DROP_TEXT[d.reason] ?? d.reason})`).join('; ')}.` : 'There are no live offers in this market.'} Nothing will be locked.
            </Notice>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <dt className="label">You get about</dt>
                  <dd className="figure m-0">{formatXmrAmount(plan.filledXmr, 4)}</dd>
                  <dd className="m-0 text-sm muted">XMR</dd>
                </div>
                <div>
                  <dt className="label">Blended rate</dt>
                  <dd className="figure m-0">{plan.blendedPrice ? formatAsset(plan.blendedPrice, market, 4) : '—'}</dd>
                  <dd className="m-0 text-sm muted">{plan.vsReferenceBps !== null ? `${Math.abs(plan.vsReferenceBps / 100).toFixed(2)}% ${plan.vsReferenceBps >= 0 ? 'above' : 'below'} reference` : `${asset} per XMR`}</dd>
                </div>
                <div>
                  <dt className="label">Waves</dt>
                  <dd className="figure m-0">{plan.waves.length}</dd>
                  <dd className="m-0 text-sm muted">about {formatDuration(plan.expectedSecs)}</dd>
                </div>
                <div>
                  <dt className="label">Unfilled</dt>
                  <dd className="figure m-0">{formatAsset(plan.unfilledPay, market, 2)}</dd>
                  <dd className="m-0 text-sm muted">{asset} with these offers</dd>
                </div>
              </dl>
              {plan.waves.map((w, wi) => (
                <div key={wi} className="panel overflow-x-auto">
                  <table className="table" aria-label={`Wave ${wi + 1}`}>
                    <caption className="px-3 pt-3 text-left text-sm font-semibold">
                      Wave {wi + 1}: {formatAsset(w.pay, market)} {asset} for {formatXmrAmount(w.xmr, 4)} XMR, {w.requiredDepth} confirmations required{wi > 0 ? ' (re-planned against live offers when it opens)' : ''}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Maker</th>
                        <th scope="col" className="right">
                          XMR
                        </th>
                        <th scope="col" className="right">
                          Pay
                        </th>
                        <th scope="col" className="right">
                          Rate
                        </th>
                        <th scope="col">Terms</th>
                        <th scope="col">
                          <span className="sr-only">Edit</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.legs.map((l) => {
                        const r = rowOf(l.offerId);
                        return (
                          <tr key={l.offerId} data-testid="plan-leg">
                            <td>
                              <a href={href('maker', l.makerId)}>{l.makerId.slice(0, 8)}…</a>
                              <div className="text-sm faint">{r ? `${r.maker.identity.reputation.completed} completed` : ''}</div>
                            </td>
                            <td className="right">
                              {wi === 0 ? (
                                <input
                                  className="input input-num !min-h-9 !w-28 !py-1 text-right !text-base"
                                  aria-label={`XMR from maker ${l.makerId.slice(0, 8)}`}
                                  inputMode="decimal"
                                  defaultValue={formatXmrAmount(l.xmr, 6)}
                                  key={l.xmr.toString()}
                                  onBlur={(e) => {
                                    const v = parseXmr(e.target.value);
                                    if (v !== null && v > 0n && v !== l.xmr) setCaps((c) => ({ ...c, [l.offerId]: v.toString() }));
                                  }}
                                />
                              ) : (
                                <span className="num">{formatXmrAmount(l.xmr, 4)}</span>
                              )}
                            </td>
                            <td className="right num">{formatAsset(l.pay, market)}</td>
                            <td className="right num">{formatAsset(l.price, market, 4)}</td>
                            <td className="text-sm">
                              {r ? MODE_LABEL[r.mode] : ''}
                              {l.pendingSecs > 0 ? `, up to ${formatDuration(l.pendingSecs)}` : ''}; deposit {r ? bpsPercent(r.depBps) : ''}; {l.depth} conf; claim delay {r ? formatDuration(r.claimDelay) : ''}
                            </td>
                            <td className="right">
                              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setExcluded((x) => [...x, l.makerId])} aria-label={`Leave out maker ${l.makerId.slice(0, 8)}`}>
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
              {excluded.length > 0 || Object.keys(caps).length > 0 ? (
                <button type="button" className="btn btn-quiet btn-sm justify-self-start" onClick={() => (setExcluded([]), setCaps({}))}>
                  Undo my edits to the plan
                </button>
              ) : null}
              {plan.dropped.length > 0 ? (
                <p className="text-sm muted">
                  Left out: {plan.dropped.map((d) => `${rowOf(d.offerId)?.maker.pda.slice(0, 6) ?? ''}… (${DROP_TEXT[d.reason] ?? d.reason})`).join('; ')}.
                </p>
              ) : null}
            </>
          )}
          <BackupStep heading="Save your recovery file" />
          <div className="grid gap-2">
            <button type="button" className="btn btn-primary btn-lg justify-self-start" disabled={blockers.length > 0 || !first} aria-describedby="large-why" onClick={() => setConfirming(true)} data-testid="lock-button">
              {first ? `Lock wave 1: ${formatAsset(first.pay, market)} ${asset} in ${first.legs.length} leg${first.legs.length === 1 ? '' : 's'}` : 'Lock'}
            </button>
            <ul id="large-why" className="grid gap-1 text-sm muted" aria-live="polite">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {first && now !== null ? (
        <ConfirmLock
          open={confirming}
          action={`Lock ${formatAsset(first.pay, market)} ${asset}`}
          summary={`${formatAsset(first.pay, market)} ${asset} in ${first.legs.length} leg${first.legs.length === 1 ? '' : 's'}, the first of ${plan!.waves.length} wave${plan!.waves.length === 1 ? '' : 's'}`}
          expectedSecs={plan!.expectedSecs}
          deadline={slowest}
          now={now}
          warnings={warnings}
          large
          busy={busy}
          error={error}
          onConfirm={() => void start()}
          onClose={() => !busy && setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

function Board({ order }: { order: Order }) {
  const app = useApp();
  const engine = useEngine();
  const busy = useObs(app.orderBusy)[order.id] ?? null;
  useObs(app.registry);
  const chain = order.market === 'sol' || order.market === 'usdc_sol' ? 'solana' : 'ethereum';
  const now = useChainNow(chain);
  const [error, setError] = useState<string | null>(null);
  const asset = ASSET_LABEL[order.market];
  const stateOf = (r: string) => engine.swaps.find((t) => t.ref === r)?.leg;
  const next = now === null ? null : app.nextWaveOf(order);
  const p = orderProgress(order, stateOf, now ?? 0n, next);
  const counts = new Map<LegState, number>();
  for (const l of p.legs) counts.set(l.state, (counts.get(l.state) ?? 0) + 1);

  return (
    <div className="grid gap-8" data-testid="large-board" data-finished={p.finished}>
      <header className="grid gap-2">
        <p className="text-sm">
          <a href={href('large')}>Large swap</a> <span className="faint">/</span> order
        </p>
        <h1>
          {formatAsset(BigInt(order.totalPay), order.market)} {asset} for XMR
        </h1>
        <p className="muted">
          Worst rate {formatPrice(BigInt(order.worstPrice), order.market)} per XMR · at most {formatAsset(BigInt(order.maxInFlight), order.market)} {asset} locked at once · no new legs after {formatTime(BigInt(order.deadline), now ?? undefined)}
        </p>
      </header>

      <section aria-label="Totals" className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <div>
          <div className="label">Filled</div>
          <div className="figure" data-testid="filled">
            {formatAsset(p.report.filledPay, order.market)}
          </div>
          <div className="text-sm muted">
            {asset} for {formatXmrAmount(p.report.filledXmr, 4)} XMR
          </div>
        </div>
        <div>
          <div className="label">Locked now</div>
          <div className={`figure ${p.report.inFlightPay > 0n ? 'text-danger-text' : ''}`}>{formatAsset(p.report.inFlightPay, order.market)}</div>
          <div className="text-sm muted">{asset} in flight</div>
        </div>
        <div>
          <div className="label">Refunded</div>
          <div className="figure">{formatAsset(p.report.refundedPay, order.market)}</div>
          <div className="text-sm muted">{asset} returned</div>
        </div>
        <div>
          <div className="label">{p.finished ? 'Unfilled' : 'Still to place'}</div>
          <div className="figure" data-testid="unfilled">
            {formatAsset(p.finished ? p.report.unfilledPay : p.remainder, order.market)}
          </div>
          <div className="text-sm muted">{asset}</div>
        </div>
      </section>

      <section aria-labelledby="board-h" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="board-h">Legs</h2>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Legs by state">
            {LEG_ORDER.filter((s) => counts.has(s)).map((s) => (
              <li key={s}>
                <span className="pill">
                  {LEG_LABEL[s]} <span className="num">{counts.get(s)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Wave</th>
                <th scope="col">Maker</th>
                <th scope="col" className="right">
                  Pay ({asset})
                </th>
                <th scope="col" className="right">
                  XMR
                </th>
                <th scope="col">State</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {p.legs.map((l, i) => {
                const t = l.ref ? engine.swaps.find((x) => x.ref === l.ref) : undefined;
                return (
                  <tr key={`${l.offerId}-${i}`} data-testid="leg" data-leg-state={l.state}>
                    <td className="num">{l.wave}</td>
                    <td>
                      <a href={href('maker', l.makerPda)}>{l.makerPda.slice(0, 8)}…</a>
                    </td>
                    <td className="right num">{formatAsset(BigInt(l.pay), order.market)}</td>
                    <td className="right num">{formatXmrAmount(BigInt(l.xmr), 4)}</td>
                    <td>
                      <LegPill state={l.state} />
                    </td>
                    <td className="text-sm">
                      {l.error ? (
                        <span className="text-warn-text">Did not open: {l.error}</span>
                      ) : t ? (
                        <>
                          {t.busy ? `${t.busy}… ` : ''}
                          {l.state === 'xmr-seen' && t.lock ? `${Math.min(t.lock.confirmations, l.depth)} of ${l.depth} confirmations. ` : ''}
                          {l.state === 'claimed' && t.sweep.phase === 'waiting' ? `Yours, spendable in ${t.sweep.blocksLeft} blocks. ` : ''}
                          {l.state === 'refunded' && t.note.autoRefunded ? 'The maker stalled; the tab refunded and the remainder is re-planned. ' : ''}
                          {t.lost ? <span className="text-danger-text">{t.lost} </span> : null}
                          <a href={href('swap', l.ref!)}>Open</a>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {busy ? <Spinner label={busy} /> : null}
      {!order.stopped && next && !busy ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              app.openWave(order.id, next).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Open next wave: {formatAsset(next.pay, order.market)} {asset} in {next.legs.length} leg{next.legs.length === 1 ? '' : 's'}
          </button>
          <span className="text-sm muted">The page opens it by itself when legs settle; your wallet asks you to sign.</span>
        </div>
      ) : null}
      {error ? (
        <Notice kind="warn" title="The wave did not open. Nothing was locked" role="alert">
          {error}
        </Notice>
      ) : null}

      {p.finished ? (
        <section aria-labelledby="report-h" className="grid gap-3" data-testid="report">
          <h2 id="report-h">Final report</h2>
          <Notice kind={p.report.unfilledPay > 0n ? 'warn' : 'safe'} title={p.report.unfilledPay > 0n ? 'Partly filled' : 'Filled'} role="status">
            Filled {formatAsset(p.report.filledPay, order.market)} {asset} for {formatXmrAmount(p.report.filledXmr, 6)} XMR. Unfilled {formatAsset(p.report.unfilledPay, order.market)} {asset}
            {p.report.refundedPay > 0n ? `, of which ${formatAsset(p.report.refundedPay, order.market)} ${asset} was locked and refunded` : ''}.
            {p.stoppedBecause === 'deadline' ? ' The order deadline passed, so no further wave was opened.' : p.stoppedBecause === 'no-offers' ? ' No remaining offer met your worst rate and limits.' : p.stoppedBecause === 'stopped' ? ' You stopped the order.' : ''}
          </Notice>
        </section>
      ) : !order.stopped ? (
        <button type="button" className="btn btn-danger justify-self-start" onClick={() => void app.stopOrder(order.id)}>
          Stop opening new legs
        </button>
      ) : null}
    </div>
  );
}

export function LargePage({ orderId }: { orderId?: string | undefined }) {
  const app = useApp();
  const orders = useObs(app.orders);
  if (!orderId) return <OrderEntry />;
  const order = orders.find((o) => o.id === orderId);
  if (!order)
    return (
      <Empty title="This order is not stored here">
        <p>The order record lives only on the device that created it, sealed under the recovery seed. Its legs are ordinary swaps: they resume from chain state and appear in <a href={href('activity')}>Activity</a>, and whatever was not placed counts as unfilled.</p>
      </Empty>
    );
  return <Board order={order} />;
}
